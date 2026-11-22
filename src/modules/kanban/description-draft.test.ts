/**
 * Tests for the one-shot LLM task-description draft endpoint
 * (POST /api/projects/:pid/tasks/:fid/description/draft) and the
 * src/modules/kanban/description-draft.ts module behind it.
 *
 * The module exposes the LLM invoker as a parameter (dependency seam), so
 * the route is exercised end-to-end over HTTP with a stub invoker: no
 * mock.module, no real LLM calls. Persistence is the real in-memory PGLite
 * database. The test projects are registered groups (the route 404s for
 * unregistered projects, mirroring production), so the no-persistence
 * assertions compare the task row, transcript entries, and the file tree
 * under the project's group directory before and after the calls.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';

import { initDatabase, createTask, getTask } from '../../db.js';
import { taskFixture, truncateTestDb } from '../../test-helpers.js';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { reloadChatAgents } from '../../lib/chat-agents.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import { readTaskMessages } from '../../modules/transcripts/transcript-store.js';
import { MAX_LEN } from '../../routes/_helpers.js';
import {
  assertEgressAllowed,
  PrivacyRefusal,
} from '../../lib/privacy-policy.js';
import tasksRouter from '../../routes/tasks.js';
import {
  llmDescriptionDraftInvoker,
  normalizeDraft,
  setDescriptionDraftInvoker,
  type DescriptionDraftInvoker,
} from './description-draft.js';

const PROJ = 'test-proj-desc-draft';
const OTHER_PROJ = 'test-proj-desc-draft-other';
const PROJ_JID = `${PROJ}@kanban`;
const OTHER_PROJ_JID = `${OTHER_PROJ}@kanban`;
/** A folder that holds a retained task row but is NOT a registered group. */
const UNREGISTERED_PROJ = 'test-proj-desc-draft-unreg';

let server: Server;
let baseUrl: string;

interface CapturedPrompt {
  system: string;
  user: string;
}
let capturedPrompts: CapturedPrompt[] = [];
let capturedProjectIds: Array<string | undefined> = [];

type StubMode = 'ok' | 'throw' | 'empty';
interface StubBehavior {
  mode: StubMode;
  text: string;
  error?: string;
}
let stubBehavior: StubBehavior = { mode: 'ok', text: 'Stubbed draft' };

const stubInvoker: DescriptionDraftInvoker = async (system, user, context) => {
  capturedPrompts.push({ system, user });
  capturedProjectIds.push(context?.projectId);
  if (stubBehavior.mode === 'throw') {
    throw new Error(stubBehavior.error ?? 'stub LLM failure');
  }
  if (stubBehavior.mode === 'empty') return '   ';
  return stubBehavior.text;
};

async function api(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  const stages = [
    { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
    {
      id: 'in_progress',
      title: 'In Progress',
      type: 'active',
      color: '#00f',
    },
    { id: 'done', title: 'Done', type: 'done', color: '#0a0' },
  ];
  await registerGroup(PROJ_JID, {
    id: PROJ,
    folder: PROJ,
    name: 'Description draft test project',
    jid: PROJ_JID,
    trigger: '!',
    added_at: new Date().toISOString(),
    settings: { stages },
  } as any);
  await registerGroup(OTHER_PROJ_JID, {
    id: OTHER_PROJ,
    folder: OTHER_PROJ,
    name: 'Description draft other project',
    jid: OTHER_PROJ_JID,
    trigger: '!',
    added_at: new Date().toISOString(),
    settings: { stages },
  } as any);
  setDescriptionDraftInvoker(stubInvoker);
  const app = express();
  // Mirror the production JSON body limit (src/http-service.ts) so the
  // route's own size validation — not express's 100kb default — is what
  // oversized payloads hit.
  app.use(express.json({ limit: '50mb' }));
  // Bypass auth like the other route tests: inject an admin user so any
  // auth check passes and we reach the route's business logic.
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'test-admin', role: 'admin' };
    next();
  });
  app.use('/api', tasksRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  server?.close();
  setDescriptionDraftInvoker(null);
  await unregisterGroup(PROJ_JID);
  await unregisterGroup(OTHER_PROJ_JID);
  fs.rmSync(path.join(GROUPS_DIR, PROJ), { recursive: true, force: true });
  fs.rmSync(path.join(GROUPS_DIR, OTHER_PROJ), {
    recursive: true,
    force: true,
  });
});

describe('normalizeDraft', () => {
  test('keeps inner fences intact', () => {
    const inner = 'Use ```bash\nnpm test\n``` to verify';
    expect(normalizeDraft(`Wrap\n${inner}`)).toBe(`Wrap\n${inner}`);
  });
});

describe('llmDescriptionDraftInvoker privacy attribution', () => {
  const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
  const originalAgents = fs.existsSync(agentsFile)
    ? fs.readFileSync(agentsFile, 'utf8')
    : null;
  const jids = {
    strict: `${PROJ}-inv-strict@kanban`,
    local_memory: `${PROJ}-inv-local-memory@kanban`,
  } as const;
  let remoteServer: ReturnType<typeof Bun.serve>;
  let remoteHits = 0;

  beforeAll(async () => {
    // No local endpoint prefixes are configured, so this runtime is remote.
    remoteServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        remoteHits++;
        return Response.json({ choices: [{ message: { content: 'Draft' } }] });
      },
    });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        version: 2,
        connections: {
          remote: { baseUrl: `http://127.0.0.1:${remoteServer.port}/v1` },
        },
        harnesses: { direct: { label: 'Direct', kind: 'direct' } },
        models: {
          remote: {
            label: 'Remote',
            bindings: { direct: { connection: 'remote' } },
          },
        },
        defaults: {
          chat: { harnessId: 'direct', modelId: 'remote' },
          kanban: {
            fallback: { harnessId: 'direct', modelId: 'remote' },
            stages: {},
          },
        },
      }),
    );
    reloadChatAgents();
    for (const [mode, jid] of Object.entries(jids)) {
      const folder = jid.replace('@kanban', '');
      await registerGroup(jid, {
        id: folder,
        folder,
        name: folder,
        jid,
        trigger: '!',
        added_at: new Date().toISOString(),
        settings: { privacyMode: mode },
      } as any);
    }
  });

  afterAll(async () => {
    remoteServer.stop(true);
    if (originalAgents === null) fs.rmSync(agentsFile, { force: true });
    else fs.writeFileSync(agentsFile, originalAgents);
    reloadChatAgents();
    for (const jid of Object.values(jids)) await unregisterGroup(jid);
  });

  test('forwards the project and helper purpose: strict refuses, local_memory drafts', async () => {
    remoteHits = 0;
    await expect(
      llmDescriptionDraftInvoker('system', 'user', {
        projectId: jids.strict.replace('@kanban', ''),
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(remoteHits).toBe(0);

    expect(
      await llmDescriptionDraftInvoker('system', 'user', {
        projectId: jids.local_memory.replace('@kanban', ''),
      }),
    ).toBe('Draft');
    expect(remoteHits).toBe(1);
  });
});

describe('POST /api/projects/:pid/tasks/:fid/description/draft', () => {
  beforeEach(async () => {
    await truncateTestDb();
    capturedPrompts = [];
    capturedProjectIds = [];
    stubBehavior = { mode: 'ok', text: 'Stubbed draft' };
  });

  test('returns 200 with the draft and a prompt containing title, description, and instruction', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Ship the dashboard',
        description: 'Current description body',
      }),
    );
    stubBehavior = { mode: 'ok', text: '  Rewritten body  ' };
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'Add acceptance criteria' },
    );
    expect(status).toBe(200);
    expect(json).toEqual({ draft: 'Rewritten body' });
    expect(capturedPrompts).toHaveLength(1);
    const { user } = capturedPrompts[0];
    expect(user).toContain('Ship the dashboard');
    expect(user).toContain('Current description body');
    expect(user).toContain('Add acceptance criteria');
    expect(capturedProjectIds).toEqual([PROJ]);
  });

  test('the attributed project mode decides remote helper egress: strict -> 502, local_memory -> draft', async () => {
    // Gate on the project id the route forwards, as llmComplete does.
    setDescriptionDraftInvoker(async (_system, _user, context) => {
      assertEgressAllowed({
        projectId: context?.projectId,
        purpose: 'helper',
        locality: 'remote',
        target: 'remote-chat',
      });
      return 'Gated draft';
    });
    const modes = [
      ['strict', 502],
      ['local_memory', 200],
    ] as const;
    try {
      for (const [mode, expected] of modes) {
        const folder = `${PROJ}-${mode}`;
        const jid = `${folder}@kanban`;
        await registerGroup(jid, {
          id: folder,
          folder,
          name: `Description draft ${mode} project`,
          jid,
          trigger: '!',
          added_at: new Date().toISOString(),
          settings: { privacyMode: mode },
        } as any);
        try {
          const task = await createTask(taskFixture({ project_id: folder }));
          const { status, json } = await api(
            'POST',
            `/projects/${folder}/tasks/${task.id}/description/draft`,
            { instruction: 'tighten' },
          );
          expect(status).toBe(expected);
          if (expected === 502) {
            expect(json.error).toContain('refuses helper egress');
          } else {
            expect(json).toEqual({ draft: 'Gated draft' });
          }
        } finally {
          await unregisterGroup(jid);
          fs.rmSync(path.join(GROUPS_DIR, folder), {
            recursive: true,
            force: true,
          });
        }
      }
    } finally {
      setDescriptionDraftInvoker(stubInvoker);
    }
  });

  test('refine turns include prior instruction/draft pairs in order', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    stubBehavior = { mode: 'ok', text: 'Final draft' };
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      {
        instruction: 'make it shorter',
        history: [
          { instruction: 'add acceptance criteria', draft: 'Draft one' },
          { instruction: 'tighten the scope', draft: 'Draft two' },
        ],
      },
    );
    expect(status).toBe(200);
    expect(json).toEqual({ draft: 'Final draft' });
    const user = capturedPrompts[0].user;
    expect(user.indexOf('Turn 1 instruction:')).toBeLessThan(
      user.indexOf('Turn 2 instruction:'),
    );
    expect(user.indexOf('add acceptance criteria')).toBeLessThan(
      user.indexOf('tighten the scope'),
    );
    expect(user.indexOf('Draft one')).toBeLessThan(user.indexOf('Draft two'));
  });

  test('strips an outer code fence from the model response', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    stubBehavior = { mode: 'ok', text: '```markdown\n# Title\nBody\n```' };
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'reformat' },
    );
    expect(status).toBe(200);
    expect(json).toEqual({ draft: '# Title\nBody' });
  });

  test('404 for unknown task id without calling the LLM', async () => {
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/task-nonexistent-000/description/draft`,
      { instruction: 'x' },
    );
    expect(status).toBe(404);
    expect(json?.error).toBeDefined();
    expect(capturedPrompts).toHaveLength(0);
  });

  test('404 when the task belongs to a different project', async () => {
    const task = await createTask(taskFixture({ project_id: OTHER_PROJ }));
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'x' },
    );
    expect(status).toBe(404);
    expect(json?.error).toBeDefined();
    expect(capturedPrompts).toHaveLength(0);
  });

  test('404 for an unregistered project even when a task row is retained', async () => {
    // Task rows can outlive project unregistration (stale data). The
    // project lookup must 404 before the task lookup or LLM call, even for
    // an admin — the project-access middleware does not check existence.
    const task = await createTask(
      taskFixture({ project_id: UNREGISTERED_PROJ }),
    );
    const { status, json } = await api(
      'POST',
      `/projects/${UNREGISTERED_PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'x' },
    );
    expect(status).toBe(404);
    expect(json?.error).toBe('Project not found');
    expect(capturedPrompts).toHaveLength(0);
  });

  test('400 for missing, blank, non-string, or oversized instruction', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const cases: unknown[] = [
      {},
      { instruction: '' },
      { instruction: '   ' },
      { instruction: 42 },
      { instruction: 'x'.repeat(MAX_LEN.description + 1) },
    ];
    for (const body of cases) {
      const { status, json } = await api(
        'POST',
        `/projects/${PROJ}/tasks/${task.id}/description/draft`,
        body,
      );
      expect(status, `body=${JSON.stringify(body).slice(0, 40)}`).toBe(400);
      expect(json?.error).toBeDefined();
    }
    expect(capturedPrompts).toHaveLength(0);
  });

  test('400 for malformed history', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      instruction: `instruction ${i}`,
      draft: 'draft',
    }));
    const tooLong = Array.from({ length: 20 }, () => ({
      instruction: 'i'.repeat(5_000),
      draft: 'd'.repeat(5_000),
    }));
    const cases: unknown[] = [
      { instruction: 'i', history: 'not-an-array' },
      { instruction: 'i', history: tooMany },
      { instruction: 'i', history: tooLong },
    ];
    for (const body of cases) {
      const { status, json } = await api(
        'POST',
        `/projects/${PROJ}/tasks/${task.id}/description/draft`,
        body,
      );
      expect(status, `body=${JSON.stringify(body).slice(0, 60)}`).toBe(400);
      expect(json?.error).toBeDefined();
    }
    expect(capturedPrompts).toHaveLength(0);
  });

  test('502 with a human-readable error when the LLM fails', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    stubBehavior = { mode: 'throw', text: '', error: 'upstream 500' };
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'i' },
    );
    expect(status).toBe(502);
    expect(json?.error).toContain('Could not generate a description draft');
    expect(json?.error).toContain('upstream 500');
  });

  test('502 when the model returns an empty draft', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    stubBehavior = { mode: 'empty', text: '' };
    const { status, json } = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'i' },
    );
    expect(status).toBe(502);
    expect(json?.error).toMatch(/empty draft/i);
  });

  test('performs no database, transcript, or file writes on success or failure', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Immutable title',
        description: 'Immutable description',
      }),
    );
    const before = await getTask(task.id);
    // Snapshot the project's group directory tree (created by group
    // registration, before any endpoint call) so we can prove the draft
    // endpoint adds no files — no transcript entries, no artifacts.
    const groupDir = path.join(GROUPS_DIR, PROJ);
    const listFiles = (dir: string): string[] =>
      fs.existsSync(dir)
        ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const entryPath = path.join(dir, entry.name);
            return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
          })
        : [];
    const filesBefore = listFiles(groupDir);

    stubBehavior = { mode: 'ok', text: 'New draft' };
    const ok = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'i' },
    );
    expect(ok.status).toBe(200);

    stubBehavior = { mode: 'throw', text: '', error: 'boom' };
    const fail = await api(
      'POST',
      `/projects/${PROJ}/tasks/${task.id}/description/draft`,
      { instruction: 'i' },
    );
    expect(fail.status).toBe(502);

    // No new files anywhere under the project's group directory.
    expect(listFiles(groupDir)).toEqual(filesBefore);
    // No transcript entries for the task.
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
    // Task row unchanged in the DB.
    expect(await getTask(task.id)).toEqual(before);
  });
});
