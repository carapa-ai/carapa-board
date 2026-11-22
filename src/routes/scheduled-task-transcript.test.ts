import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createScheduledTask, initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { activeRuns } from '../db/schema.js';
import { getGroupDir } from '../group-dir.js';
import { archivedCarapaRunV1Paths } from '../modules/transcripts/carapa-run-v1.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import conversationsRouter from './conversations.js';

const suffix = `${process.pid}`;
const projectId = `st-transcript-${suffix}`;
const taskId = `st-transcript-task-${suffix}`;
const SECRET = 'TOP-SECRET-OUTSIDE-CONTENT';
let server: Server;
let baseUrl: string;
let outsideDir: string;
let transcriptDir: string;

const v1Manifest = JSON.stringify({
  format: 'carapa-run',
  version: 1,
  harness: 'opencode',
  requestedModel: null,
});
const v1Events =
  [
    { type: 'run', status: 'started' },
    {
      type: 'message',
      id: 'a1',
      role: 'assistant',
      content: 'answer',
      status: 'completed',
    },
    { type: 'run', status: 'completed' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n';
const legacyLine = `${JSON.stringify({ type: 'message', role: 'assistant', content: 'legacy answer' })}\n`;

function writeV1Pair(runId: string): void {
  const paths = archivedCarapaRunV1Paths(transcriptDir, runId);
  fs.writeFileSync(paths.manifest, v1Manifest);
  fs.writeFileSync(paths.events, v1Events);
}

let runCounter = 0;
async function newRun(): Promise<string> {
  const runId = `st-transcript-run-${suffix}-${runCounter++}`;
  await drizzleDbRef.current.insert(activeRuns).values({
    id: runId,
    group_folder: projectId,
    chat_jid: `${projectId}@web`,
    isScheduledTask: 1,
    scheduled_task_id: taskId,
    sandbox_stack: 'test',
    sandbox_service: 'test',
    started_at: new Date().toISOString(),
    timeout_at: new Date(Date.now() + 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    status: 'completed',
  });
  return runId;
}

const outside = (name: string, content: string): string => {
  const file = path.join(outsideDir, name);
  fs.writeFileSync(file, content);
  return file;
};

const fetchTranscript = (runId: string, v1 = false) =>
  fetch(
    `${baseUrl}/projects/${projectId}/scheduled-tasks/${taskId}/runs/${runId}/transcript${v1 ? '/v1' : ''}`,
  );

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(`${projectId}@web`, {
    jid: `${projectId}@web`,
    name: projectId,
    folder: projectId,
    trigger: `@${projectId}`,
    added_at: new Date().toISOString(),
  });
  await createScheduledTask({
    id: taskId,
    group_folder: projectId,
    chat_jid: `${projectId}@web`,
    prompt: 'prompt',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-transcript-out-'));
  transcriptDir = path.join(getGroupDir(projectId), 'session-transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const app = express();
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'route-admin-user', username: 'admin', role: 'admin' };
    next();
  });
  app.use(conversationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await unregisterGroup(`${projectId}@web`);
  fs.rmSync(getGroupDir(projectId), { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('scheduled-task run transcript routes contain symlinks', () => {
  test('a .prompt.txt symlink outside the group reads as no prompt', async () => {
    const runId = await newRun();
    writeV1Pair(runId);
    fs.symlinkSync(
      outside('prompt-secret.txt', SECRET),
      path.join(transcriptDir, `${runId}.prompt.txt`),
    );
    const response = await fetchTranscript(runId);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body).prompt).toBeNull();
    expect(body).not.toContain(SECRET);
  });

  test('a run with only a legacy .jsonl is unavailable', async () => {
    const runId = await newRun();
    fs.writeFileSync(path.join(transcriptDir, `${runId}.jsonl`), legacyLine);
    const response = await fetchTranscript(runId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Transcript unavailable' });
  });

  test('a relative prompt symlink that stays inside the group is served', async () => {
    const runId = await newRun();
    writeV1Pair(runId);
    const realDir = path.join(getGroupDir(projectId), 'real-transcripts');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'run.prompt.txt'), 'inside prompt');
    fs.symlinkSync(
      path.join('..', 'real-transcripts', 'run.prompt.txt'),
      path.join(transcriptDir, `${runId}.prompt.txt`),
    );
    const response = await fetchTranscript(runId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      prompt: 'inside prompt',
      entries: [{ content: 'answer' }],
    });
  });

  test('a FIFO at the prompt path reads as no prompt without blocking', async () => {
    const runId = await newRun();
    writeV1Pair(runId);
    try {
      execFileSync('mkfifo', [path.join(transcriptDir, `${runId}.prompt.txt`)]);
    } catch {
      return; // mkfifo unavailable
    }
    const response = await fetchTranscript(runId);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { prompt: unknown }).prompt).toBeNull();
  });

  test.each([false, true])(
    'a malformed V1 pair returns 422 without file content (v1 route: %p)',
    async (v1) => {
      const runId = await newRun();
      const paths = archivedCarapaRunV1Paths(transcriptDir, runId);
      fs.writeFileSync(paths.manifest, v1Manifest);
      fs.writeFileSync(paths.events, `${SECRET}\n`);
      const response = await fetchTranscript(runId, v1);
      expect(response.status).toBe(422);
      const body = await response.text();
      expect(body).not.toContain(SECRET);
      expect(JSON.parse(body).detail).toBe('Transcript could not be read');
    },
  );

  test.each([false, true])(
    'a V1 pair symlinked outside the group returns 422 without file content (v1 route: %p)',
    async (v1) => {
      const runId = await newRun();
      const paths = archivedCarapaRunV1Paths(transcriptDir, runId);
      fs.writeFileSync(paths.manifest, v1Manifest);
      fs.symlinkSync(outside(`events-${v1}.jsonl`, v1Events), paths.events);
      const response = await fetchTranscript(runId, v1);
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain(SECRET);
    },
  );
});
