import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  createConversation,
  createUser,
  initDatabase,
  upsertConversationMember,
  upsertProjectMember,
} from '../db.js';
import { getGroupDir } from '../group-dir.js';
import { archivedCarapaRunV1Paths } from '../modules/transcripts/carapa-run-v1.js';
import {
  loadState,
  registeredGroups,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import objectivesRouter from './objectives.js';

const suffix = `${process.pid}`;
const projectP = `st-access-p-${suffix}`;
const projectQ = `st-access-q-${suffix}`;
const projectR = `st-access-r-${suffix}`; // owned by another user
const jids = [projectP, projectQ, projectR].map((folder) => `${folder}@web`);
let server: Server;
let baseUrl: string;
const ids = {
  implicit: '',
  viewer: '',
  admin: '',
  other: '',
  otherMain: '',
  adminMain: '',
};
const runIdP = `run-p-${suffix}`;
const taskIdP = `task-p-${suffix}`;
const runIdQ = `run-q-${suffix}`;
const runIdR = `run-r-${suffix}`;
const runIdMain = `run-main-${suffix}`;
const runIdOwnMain = `run-own-main-${suffix}`;
const runIdLinked = `run-linked-${suffix}`;
const SECRET = 'TOP-SECRET-OUTSIDE-CONTENT';
let outsideDir: string;

const mainOf = (userId: string): string | undefined =>
  Object.values(registeredGroups).find((g) => g.is_main && g.user_id === userId)
    ?.folder;

function writeTranscripts(folder: string, runId: string, taskId?: string) {
  const dir = path.join(getGroupDir(folder), 'session-transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const entry = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: 'secret',
  });
  const v1 = archivedCarapaRunV1Paths(dir, runId);
  fs.writeFileSync(
    v1.manifest,
    JSON.stringify({
      format: 'carapa-run',
      version: 1,
      harness: 'opencode',
      requestedModel: null,
    }),
  );
  fs.writeFileSync(
    v1.events,
    [
      { type: 'run', status: 'started' },
      {
        type: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'secret',
        status: 'completed',
      },
      { type: 'run', status: 'completed' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  if (taskId) {
    const taskDir = path.join(getGroupDir(folder), 'transcripts');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, `${taskId}.jsonl`), `${entry}\n`);
    const taskV1 = archivedCarapaRunV1Paths(dir, taskId);
    fs.copyFileSync(v1.manifest, taskV1.manifest);
    fs.copyFileSync(v1.events, taskV1.events);
  }
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  for (const folder of [projectP, projectQ]) {
    await registerGroup(`${folder}@web`, {
      jid: `${folder}@web`,
      name: folder,
      folder,
      trigger: `@${folder}`,
      added_at: new Date().toISOString(),
    });
  }
  ids.implicit = (await createUser(`st-implicit-${suffix}`, 'pw')).id;
  ids.viewer = (await createUser(`st-viewer-${suffix}`, 'pw')).id;
  ids.admin = (await createUser(`st-admin-${suffix}`, 'pw', 'admin')).id;
  ids.other = (await createUser(`st-other-${suffix}`, 'pw')).id;
  await upsertProjectMember(ids.viewer, projectP, 'viewer');
  const conversation = await createConversation(projectP);
  await upsertConversationMember(ids.implicit, conversation.id, 'viewer');

  await registerGroup(`${projectR}@web`, {
    jid: `${projectR}@web`,
    name: projectR,
    folder: projectR,
    trigger: `@${projectR}`,
    added_at: new Date().toISOString(),
    user_id: ids.other,
  });

  ids.otherMain = mainOf(ids.other)!;
  ids.adminMain = mainOf(ids.admin)!;

  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-access-out-'));
  writeTranscripts(projectP, runIdP, taskIdP);
  writeTranscripts(projectP, runIdLinked);
  // Replace the linked run's V1 events with a symlink to a file outside the
  // group whose content would be echoed by a JSON parse error.
  const linked = archivedCarapaRunV1Paths(
    path.join(getGroupDir(projectP), 'session-transcripts'),
    runIdLinked,
  );
  fs.writeFileSync(path.join(outsideDir, 'events.jsonl'), `${SECRET}\n`);
  fs.rmSync(linked.events);
  fs.symlinkSync(path.join(outsideDir, 'events.jsonl'), linked.events);
  writeTranscripts(projectQ, runIdQ);
  writeTranscripts(projectR, runIdR);
  writeTranscripts(ids.otherMain, runIdMain);
  writeTranscripts(ids.adminMain, runIdOwnMain);

  const app = express();
  // Mirror production auth: a logged-in user always carries a tokenScope for
  // their personal main group; an agent token has a scope but no user.
  app.use((req: any, _res, next) => {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string') {
      const [id, role] = user.split(':');
      req.authUser = { id, role: role ?? 'user' };
      req.tokenScope = {
        group_folder: mainOf(id) ?? `main-${id}`,
        permissions: {},
      };
      req.authCredentialKind = 'user';
    }
    const tokenGroup = req.headers['x-test-token-group'];
    if (typeof tokenGroup === 'string') {
      req.tokenScope = { group_folder: tokenGroup };
    }
    next();
  });
  app.use(objectivesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  fs.rmSync(outsideDir, { recursive: true, force: true });
  for (const jid of jids) await unregisterGroup(jid);
  for (const folder of [
    projectP,
    projectQ,
    projectR,
    ids.otherMain,
    ids.adminMain,
  ]) {
    fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
  }
});

const get = async (id: string, headers: Record<string, string>, v1: boolean) =>
  (
    await fetch(`${baseUrl}/session-transcripts/${id}${v1 ? '/v1' : ''}`, {
      headers,
    })
  ).status;

describe.each([
  ['legacy', false],
  ['v1', true],
])('GET /session-transcripts/:id (%s)', (_name, v1) => {
  test('implicit chat-only user cannot read project transcripts', async () => {
    const headers = { 'x-test-user': ids.implicit };
    expect(await get(runIdP, headers, v1)).toBe(404);
    if (!v1) expect(await get(taskIdP, headers, v1)).toBe(404);
  });

  test('explicit viewer can read project transcripts', async () => {
    const headers = { 'x-test-user': ids.viewer };
    expect(await get(runIdP, headers, v1)).toBe(200);
    expect(await get(taskIdP, headers, v1)).toBe(200);
  });

  test('admin reads ownerless projects but not projects owned by another user', async () => {
    const headers = { 'x-test-user': `${ids.admin}:admin` };
    expect(await get(runIdQ, headers, v1)).toBe(200);
    expect(await get(runIdR, headers, v1)).toBe(404);
    expect(await get(runIdOwnMain, headers, v1)).toBe(200);
    expect(await get(runIdMain, headers, v1)).toBe(404);
  });

  test('group-scoped agent token reads its own project', async () => {
    const headers = { 'x-test-token-group': projectP };
    expect(await get(runIdP, headers, v1)).toBe(200);
    expect(await get(runIdQ, headers, v1)).toBe(404);
  });
});

describe.each([
  ['legacy', false],
  ['v1', true],
])('symlinked V1 pair outside the group (%s)', (_name, v1) => {
  test('is refused without leaking file content', async () => {
    const response = await fetch(
      `${baseUrl}/session-transcripts/${runIdLinked}${v1 ? '/v1' : ''}`,
      { headers: { 'x-test-token-group': projectP } },
    );
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(SECRET);
  });
});
