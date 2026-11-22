/**
 * HTTP integration tests for src/routes/tasks.ts.
 *
 * Uses real in-memory PGLite (initDatabase(':memory:')) for persistence.
 * Only two modules are mocked:
 *   - ./index.js        — has process.on signal handlers at module scope
 *   - ./transcript-store.js — avoids filesystem writes to groups/ during tests
 *
 * All other imports (task-executor, ws-events, db, stages, etc.) use their
 * real implementations. Because `registeredGroups` is empty, code paths that
 * require a registered project (drainProjectQueue, git branch ops) are never
 * reached.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { resolveTranscriptFile } from './group-dir.js';
import { waitForFileState } from './test-file-events.js';
import { getDefaultRuntimeSelection } from './lib/chat-agents.js';

// Register before the HTTP request; the real IPC file is the agent's boundary.
function nextControlRequest(runDir: string): Promise<string> {
  const dir = path.join(runDir, 'control-requests');
  fs.mkdirSync(dir, { recursive: true });
  return waitForFileState(dir, () =>
    fs.readdirSync(dir).find((entry) => entry.endsWith('.json')),
  );
}

import {
  initDatabase,
  createTask,
  updateTask,
  getTask,
  getTasksByProject,
  getActiveRunForTask,
  getActiveRunById,
  insertActiveRun,
  getRunsForTask,
  completeActiveRun,
  getTaskStageComment,
  setTaskStageComment,
  createUser,
  createConversation,
  getConversation,
  getUnreadPayloads,
  upsertProjectMember,
  upsertConversationMember,
  getUnresolvedStageEntryEvents,
} from './db.js';
import { createObjective } from './modules/objectives/db-objectives.js';
import {
  acquireConversationExecutionLease,
  releaseConversationExecutionLease,
} from './modules/chat/conversation-execution-lease.js';
import {
  appendTaskMessageAsync,
  flushTaskOutputChunks,
  queueTaskOutputChunk,
  readTaskMessages,
} from './modules/transcripts/transcript-store.js';
import {
  TESTING_HEAD_SHA_KEY,
  TESTING_TREE_SHA_KEY,
} from './modules/kanban/task/testing.js';
import { runFixture, taskFixture, truncateTestDb } from './test-helpers.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { groupFsTestHooks } from './lib/group-fs.js';
import { flushDeploy } from './modules/kanban/task/deploy.js';
import { countActiveServiceBuilds } from './sandbox/service-builds.js';
import {
  claimTaskExecution,
  executeTask as executeTaskPipeline,
  isTaskRunning,
  releaseTaskExecutionClaim,
} from './modules/kanban/task-executor.js';
import { _testOnlyTryClaimTaskExecution } from './modules/kanban/task/pipeline.js';
import type { ActiveRun } from './modules/kanban/execution/types.js';
import {
  removeRunDirPreservingControlResponses,
  runContainerAgent,
  type ContainerInput,
} from './sandbox/process.js';
import { resolveEffectiveSandbox } from './sandbox/effective-settings.js';
import { withProjectGitLock } from './lib/git-ops.js';
import { acquireSharedCheckoutLease } from './concurrency/shared-checkout-lease.js';
import { _testOnlySetManualCompletionMaxWaitMs } from './modules/kanban/task/manual-completion.js';
import { acquireGroupSlot } from './concurrency/semaphore.js';
import {
  appendTaskSteeringMessage,
  beginSuccessfulTaskFinalization,
  drainProjectQueue,
  endSuccessfulTaskFinalization,
  holdTaskForPendingSteering,
  getPendingTaskDeliveryPrompts,
  requestTaskStageHandoff,
  setGroupResolver,
} from './modules/kanban/task/pipeline.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
  updateGroup,
} from './state-manager.js';

function appendChunk(
  projectId: string,
  taskId: string,
  runId: string | null,
  content: string,
  entryId?: string,
  entryComplete?: boolean,
  canonicalEntry?: boolean,
): void {
  queueTaskOutputChunk(
    projectId,
    taskId,
    runId,
    content,
    entryId,
    entryComplete,
    canonicalEntry,
  );
  flushTaskOutputChunks(taskId);
}

// ─── Module mocks ─────────────────────────────────────────────────────────────

type SandboxResult = { stdout: string; isError: boolean };
let sandboxGitHandler: (command: string) => Promise<SandboxResult> = async (
  command,
) => ({
  stdout: command.includes('branch --show-current')
    ? 'develop'
    : command.includes('status --porcelain') || command.includes('ls-tree')
      ? ''
      : '0123456789abcdef0123456789abcdef01234567',
  isError: false,
});
let sandboxBranchHandler = async (_action: string): Promise<SandboxResult> => ({
  stdout: JSON.stringify({ merged: true, pushed: false }),
  isError: false,
});
const sandboxWorktreeCalls: Array<{
  action: string;
  branch: string | undefined;
}> = [];
let sandboxWorktreeRemoveError: string | null = null;
let exposeRegisteredRouteGroup = false;

// index.js has top-level process.on signal handlers and WhatsApp init; mock it
// to expose only the exports that routes/tasks.ts needs.
mock.module('./index.js', () => ({
  registeredGroups: {},
  updateGroup: mock(() => {}),
  getGroupByFolder: mock((folder: string) =>
    exposeRegisteredRouteGroup ? getGroupByFolder(folder) : undefined,
  ),
  getGroupEntryByFolder: mock(() => undefined),
}));

// Stub the CarapaBox sandbox client so no test dials a real MCP transport.
mock.module('./lib/mcp-client.js', () => ({
  getSandboxClient: () => ({
    sandboxStop: async (_stack: string, _instance: string) => ({
      stdout: 'ok',
      isError: false,
    }),
    sandboxStart: async (
      _stack: string,
      _env: unknown,
      _instance: string,
      _service?: string,
    ) => ({
      stdout: 'ok',
      isError: false,
    }),
    sandboxWorktree: async (
      _stack: string,
      action: string,
      options?: { branch?: string },
    ) => {
      sandboxWorktreeCalls.push({ action, branch: options?.branch });
      if (action === 'remove' && sandboxWorktreeRemoveError) {
        return { stdout: sandboxWorktreeRemoveError, isError: true };
      }
      return {
        stdout:
          action === 'add' && options?.branch
            ? `worktree_path=/host/repo/.worktrees/${options.branch}\n`
            : '',
        isError: false,
      };
    },
    sandboxBranch: async (_stack: string, action: string) =>
      sandboxBranchHandler(action),
    sandboxGit: async (_stack: string, command: string) =>
      sandboxGitHandler(command),
  }),
}));

// ─── Dynamic router import (after mocks are registered) ──────────────────────

const {
  default: tasksRouter,
  _testOnlySetExplicitExecuteTaskRunner,
  _testOnlySetTaskQueueDrainRunner,
  _testOnlySetTaskMessageRunningCheckHook,
} = await import('./routes/tasks.js');

// ─── Test server ──────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;
const PROJ = 'test-proj-routes';
const PROJ_JID = `${PROJ}@kanban`;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(PROJ_JID, {
    id: PROJ,
    folder: PROJ,
    name: 'Task route test project',
    jid: PROJ_JID,
    trigger: '!',
    added_at: new Date().toISOString(),
    settings: {
      stages: [
        { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
        { id: 'question', title: 'Question', type: 'queue', color: '#f80' },
        {
          id: 'in_progress',
          title: 'In Progress',
          type: 'active',
          color: '#00f',
        },
        { id: 'testing', title: 'Testing', type: 'testing', color: '#80f' },
        { id: 'review', title: 'Review', type: 'review', color: '#a0f' },
        { id: 'completed', title: 'Completed', type: 'done', color: '#0a0' },
        { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
      ],
    },
  } as any);
  const app = express();
  app.use(express.json());
  // Bypass auth: the routes that need `userCanAccessGroup` check
  // `req.authUser?.role === 'admin'`. Inject an admin user so the
  // auth check passes and we can reach the route's business logic.
  app.use((req: express.Request, res, next) => {
    // Synchronous Git fixtures can outlast keep-alive expiry under CI load.
    // Use fresh connections so Bun cannot reuse a socket pending closure.
    res.setHeader('Connection', 'close');
    const requestedUserId = req.headers['x-test-user-id'];
    const runTaskId = req.headers['x-test-run-task-id'];
    if (typeof runTaskId === 'string') {
      Object.assign(req, {
        tokenScope: { group_folder: 'routes-test', task_id: runTaskId },
      });
    }
    if (req.headers['x-test-agent-credential']) {
      // The sandbox env token: agent kind, group-scoped, no task_id.
      Object.assign(req, {
        authCredentialKind: 'agent',
        tokenScope: { group_folder: 'routes-test' },
      });
    }
    if (req.headers['x-test-human-credential']) {
      Object.assign(req, { authCredentialKind: 'user' });
    }
    const requestedRole = req.headers['x-test-user-role'];
    const tokenFolder = req.headers['x-test-token-folder'];
    if (typeof tokenFolder === 'string') {
      Object.assign(req, { tokenScope: { group_folder: tokenFolder } });
    }
    // A folder-scoped agent token carries no authUser (human access never
    // comes from tokenScope), so model it without one.
    if (typeof tokenFolder !== 'string') {
      Object.assign(req, {
        authUser: {
          id:
            typeof requestedUserId === 'string'
              ? requestedUserId
              : 'test-admin',
          role: typeof requestedRole === 'string' ? requestedRole : 'admin',
        },
      });
    }
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
  await unregisterGroup(PROJ_JID);
  try {
    fs.rmSync(path.join(GROUPS_DIR, PROJ), { recursive: true, force: true });
  } catch {}
});

beforeEach(async () => {
  await truncateTestDb();
  sandboxWorktreeCalls.length = 0;
  sandboxWorktreeRemoveError = null;
  _testOnlySetExplicitExecuteTaskRunner(null);
  _testOnlySetTaskQueueDrainRunner(null);
  _testOnlySetTaskMessageRunningCheckHook(null);
  exposeRegisteredRouteGroup = false;
  sandboxGitHandler = async (command) => ({
    stdout: command.includes('branch --show-current')
      ? 'develop'
      : command.includes('status --porcelain') || command.includes('ls-tree')
        ? ''
        : '0123456789abcdef0123456789abcdef01234567',
    isError: false,
  });
  sandboxBranchHandler = async (action) => ({
    stdout:
      action === 'merge'
        ? JSON.stringify({ merged: true, pushed: false })
        : JSON.stringify({ repositories: [] }),
    isError: false,
  });
});

describe('GET /api/projects/:pid/tasks/:fid/runs', () => {
  test('returns stage durations for only the requested project task', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await insertActiveRun(
      runFixture({
        id: 'route-active',
        task_id: task.id,
        group_folder: PROJ,
        stage: 'in_progress',
        status: 'completed',
        started_at: '2026-08-01T00:00:00.000Z',
        completed_at: '2026-08-01T00:01:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'other-task-run',
        task_id: 'other-task',
        group_folder: PROJ,
        stage: 'testing',
        status: 'completed',
        started_at: '2026-08-01T00:00:00.000Z',
        completed_at: '2026-08-01T00:10:00.000Z',
      }),
    );

    const response = await apiGet(`/projects/${PROJ}/tasks/${task.id}/runs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stageDurations: Array<{
        stageId: string | null;
        completedDurationMs: number;
        runningStartedAt: string[];
        runningDurationMs: number;
      }>;
    };
    expect(body.stageDurations).toContainEqual(
      expect.objectContaining({
        stageId: 'in_progress',
        completedDurationMs: 60_000,
        runningStartedAt: [],
        runningDurationMs: 0,
      }),
    );
    expect(body.stageDurations).not.toContainEqual(
      expect.objectContaining({ stageId: 'testing' }),
    );
  });

  test('keeps a persisted score from a removed review stage eligible', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await insertActiveRun(
      runFixture({
        id: 'removed-review-stage',
        task_id: task.id,
        group_folder: PROJ,
        stage: 'legacy_review',
        reviewScore: 6,
        started_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'newer-implementation-score',
        task_id: task.id,
        group_folder: PROJ,
        stage: 'in_progress',
        reviewScore: 10,
        started_at: '2026-01-02T00:00:00.000Z',
      }),
    );

    const response = await apiGet(`/projects/${PROJ}/tasks/${task.id}/runs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      latest_scored_review_run: { id: string; reviewScore: number } | null;
    };
    expect(body.latest_scored_review_run).toMatchObject({
      id: 'newer-implementation-score',
      reviewScore: 10,
    });
  });

  test('returns an out-of-page persisted score for a divider-less legacy review', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await insertActiveRun(
      runFixture({
        id: 'review-legacy-persisted',
        task_id: task.id,
        group_folder: PROJ,
        stage: 'review',
        reviewScore: 4,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:01:00.000Z',
      }),
    );
    await appendTaskMessageAsync(PROJ, {
      task_id: task.id,
      role: 'assistant',
      content: 'Legacy review transcript without a run divider.',
      created_at: '2026-01-01T00:02:00.000Z',
    });
    for (let i = 0; i < 51; i++) {
      await insertActiveRun(
        runFixture({
          id: `implementation-persisted-${i}`,
          task_id: task.id,
          group_folder: PROJ,
          stage: 'in_progress',
          started_at: `2026-01-02T00:${String(i).padStart(2, '0')}:00.000Z`,
        }),
      );
    }

    const response = await apiGet(`/projects/${PROJ}/tasks/${task.id}/runs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runs: Array<{ id: string }>;
      latest_scored_review_run: {
        id: string;
        reviewScore: number | null;
      } | null;
    };
    expect(body.runs.some((run) => run.id === 'review-legacy-persisted')).toBe(
      false,
    );
    expect(body.latest_scored_review_run).toMatchObject({
      id: 'review-legacy-persisted',
      reviewScore: 4,
    });
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function apiGet(path: string) {
  return fetch(`${baseUrl}${path}`);
}

async function apiPost(path: string, body: unknown, runTaskId?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(runTaskId ? { 'x-test-run-task-id': runTaskId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function apiPatch(
  path: string,
  body: unknown,
  userId?: string,
  runTaskId?: string,
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { 'x-test-user-id': userId } : {}),
      ...(runTaskId ? { 'x-test-run-task-id': runTaskId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function apiAgentPatch(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-test-agent-credential': '1',
    },
    body: JSON.stringify(body),
  });
}

async function apiPut(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiDelete(path: string) {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

describe('GET /api/projects/:pid/tasks/:fid/output', () => {
  test('returns complete semantic pages for a durable run beyond one megabyte', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const first = 'a'.repeat(600_000);
    const second = 'b'.repeat(500_000);
    appendChunk(PROJ, task.id, 'run-old', 'OOOO');
    appendChunk(PROJ, task.id, 'run-new', first, 'tool:first');
    appendChunk(PROJ, task.id, 'run-new', second, 'tool:second');

    const newestResponse = await apiGet(
      `/projects/${PROJ}/tasks/${task.id}/output?runId=run-new&limit=32768`,
    );
    expect(newestResponse.status).toBe(200);
    const newest = (await newestResponse.json()) as {
      content: string;
      total: number;
      hasMore: boolean;
      nextCursor: number;
      entries: Array<{
        id: string;
        startOffset: number;
        endOffset: number;
        runId: string | null;
      }>;
    };
    expect(newest.content).toBe(second);
    expect(newest.entries).toMatchObject([
      {
        id: 'tool:second',
        startOffset: first.length,
        endOffset: first.length + second.length,
        runId: 'run-new',
      },
    ]);
    expect(newest.total).toBe(first.length + second.length);
    expect(newest.hasMore).toBe(true);

    const olderResponse = await apiGet(
      `/projects/${PROJ}/tasks/${task.id}/output?runId=run-new&limit=32768&beforeOffset=${newest.nextCursor}`,
    );
    const older = (await olderResponse.json()) as {
      content: string;
      entries: Array<{ id: string }>;
    };
    expect(older.content).toBe(first);
    expect(older.entries.map((entry) => entry.id)).toEqual(['tool:first']);
  });

  test('reconciles an extended V1 message identity while keeping overlapping tool output', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const toolOutput = 'tool output: final answer';
    appendChunk(PROJ, task.id, 'run-overlap', toolOutput, 'tool:one');
    appendChunk(
      PROJ,
      task.id,
      'run-overlap',
      'final ',
      'message:event-final',
      false,
    );
    appendChunk(
      PROJ,
      task.id,
      'run-overlap',
      'answer',
      'message:event-final',
      true,
      true,
    );
    const canonical = await appendTaskMessageAsync(PROJ, {
      task_id: task.id,
      role: 'assistant',
      content: 'final answer',
      entry_type: 'run_result',
      run_id: 'run-overlap',
      created_at: new Date().toISOString(),
    });

    const response = await apiGet(
      `/projects/${PROJ}/tasks/${task.id}/output?runId=run-overlap&limit=32768`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      content: string;
      entries: Array<{ id: string; messageId?: string }>;
    };
    expect(page.content).toBe(`${toolOutput}final answer`);
    expect(page.entries).toMatchObject([
      { id: 'tool:one' },
      { id: `message:${canonical.id}`, messageId: canonical.id },
    ]);
  });
});
// ─── GET /api/projects/:pid/tasks ─────────────────────────────────────────────

describe('GET /api/projects/:pid/tasks', () => {
  test('does not present a DB-running row after successful finalization closes steering admission', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    const run = runFixture({
      group_folder: PROJ,
      task_id: task.id,
      stage: 'testing',
    });
    await insertActiveRun(run);
    const boundary = await beginSuccessfulTaskFinalization(task, 'testing');
    try {
      expect(boundary.shouldAdvance).toBe(true);
      const res = await apiGet(`/projects/${PROJ}/tasks`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        running: boolean;
      }>;
      expect(body.find((candidate) => candidate.id === task.id)?.running).toBe(
        false,
      );
    } finally {
      endSuccessfulTaskFinalization(boundary);
      await completeActiveRun(run.id, 'completed');
    }
  });

  test('returns the latest completed run timestamp for each task', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const run = runFixture({ group_folder: PROJ, task_id: task.id });
    await insertActiveRun(run);
    const earliestCompletion = Date.now();
    await completeActiveRun(run.id, 'completed');

    const res = await apiGet(`/projects/${PROJ}/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      latestRunCompletedAt: string | null;
    }>;
    const summary = body.find((item) => item.id === task.id);

    expect(summary?.latestRunCompletedAt).toBeString();
    expect(
      new Date(summary!.latestRunCompletedAt!).getTime(),
    ).toBeGreaterThanOrEqual(earliestCompletion);
  });

  test('combines owner and triggerer filters with AND semantics', async () => {
    const owner = await createUser('filter-owner', 'pw', 'user');
    const triggerer = await createUser('filter-triggerer', 'pw', 'user');
    const matching = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'matching attribution',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'owner only',
        ownerUserId: owner.id,
        lastTriggeredByUserId: owner.id,
        lastTriggerSource: 'user',
      }),
    );

    const res = await apiGet(
      `/projects/${PROJ}/tasks?ownerUserId=${owner.id}&triggeredByUserId=${triggerer.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((task: any) => task.id)).toEqual([matching.id]);
    expect(body[0].owner).toEqual({ id: owner.id, username: 'filter-owner' });
    expect(body[0].latestTrigger.user).toEqual({
      id: triggerer.id,
      username: 'filter-triggerer',
    });
  });

  test('resolves the source conversation project for cross-project lineage', async () => {
    const sourceProject = 'task-lineage-source';
    const sourceJid = `${sourceProject}@chat`;
    await registerGroup(sourceJid, {
      id: sourceProject,
      folder: sourceProject,
      name: 'Task lineage source',
      jid: sourceJid,
      trigger: '!',
      added_at: new Date().toISOString(),
    } as any);
    try {
      const conversation = await createConversation(sourceProject);
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          sourceConversationId: conversation.id,
        }),
      );

      expect(await getTask(task.id)).toMatchObject({
        sourceConversationId: conversation.id,
        sourceConversationProjectId: sourceProject,
      });
    } finally {
      await unregisterGroup(sourceJid);
    }
  });

  test('returns total duration across every completed run', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await insertActiveRun(
      runFixture({
        group_folder: PROJ,
        task_id: task.id,
        status: 'completed',
        started_at: '2026-01-01T10:00:00.000Z',
        completed_at: '2026-01-01T10:01:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        group_folder: PROJ,
        task_id: task.id,
        status: 'completed',
        started_at: '2026-01-01T11:00:00.000Z',
        completed_at: '2026-01-01T11:02:00.000Z',
      }),
    );

    const res = await apiGet(`/projects/${PROJ}/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      totalRunDurationMs: number | null;
    }>;

    expect(body.find((item) => item.id === task.id)?.totalRunDurationMs).toBe(
      180_000,
    );
  });

  test('does not leak tasks from other projects', async () => {
    await createTask(taskFixture({ project_id: PROJ, title: 'Mine' }));
    await createTask(
      taskFixture({ project_id: 'other-proj', title: 'Not mine' }),
    );
    const res = await apiGet(`/projects/${PROJ}/tasks`);
    const body = (await res.json()) as Array<{ title: string }>;
    expect(body.every((t) => t.title !== 'Not mine')).toBe(true);
  });
});

describe('DELETE /api/projects/:pid/tasks/:fid/recordings', () => {
  test('deletes every recording for the task and reports freed space', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const recordingsDir = path.join(
      GROUPS_DIR,
      PROJ,
      'recordings',
      `task-${task.id}`,
    );
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(path.join(recordingsDir, 'one.webm'), '1234');
    fs.writeFileSync(path.join(recordingsDir, 'two.webm'), '56789');

    const res = await apiDelete(
      `/projects/${PROJ}/tasks/${task.id}/recordings`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      deletedCount: 2,
      freedBytes: 9,
    });
    expect(fs.existsSync(recordingsDir)).toBe(false);
    expect(await getTask(task.id)).toBeTruthy();
  });

  test('deletes one recording without touching the others', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const recordingsDir = path.join(
      GROUPS_DIR,
      PROJ,
      'recordings',
      `task-${task.id}`,
    );
    const deletedPath = path.join(recordingsDir, 'delete-me.webm');
    const keptPath = path.join(recordingsDir, 'keep-me.webm');
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(deletedPath, '1234');
    fs.writeFileSync(keptPath, '56789');

    const res = await apiDelete(
      `/projects/${PROJ}/tasks/${task.id}/recordings/delete-me.webm`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      deletedCount: 1,
      freedBytes: 4,
    });
    expect(fs.existsSync(deletedPath)).toBe(false);
    expect(fs.existsSync(keptPath)).toBe(true);
  });

  test('rejects an invalid individual recording filename', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));

    const res = await apiDelete(
      `/projects/${PROJ}/tasks/${task.id}/recordings/not-a-video.txt`,
    );

    expect(res.status).toBe(400);
  });

  test('returns 404 without touching recordings for another project', async () => {
    const task = await createTask(taskFixture({ project_id: 'other-proj' }));
    const recordingsDir = path.join(
      GROUPS_DIR,
      PROJ,
      'recordings',
      `task-${task.id}`,
    );
    const recordingPath = path.join(recordingsDir, 'keep.webm');
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(recordingPath, 'keep');

    const res = await apiDelete(
      `/projects/${PROJ}/tasks/${task.id}/recordings`,
    );

    expect(res.status).toBe(404);
    expect(fs.existsSync(recordingPath)).toBe(true);
  });
});

describe('task recordings are race-free inside the group folder', () => {
  const recordingsDirOf = (folder: string, taskId: string) =>
    path.join(GROUPS_DIR, folder, 'recordings', `task-${taskId}`);

  test('a recording that is a symlink out of the group is never served or listed', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const dir = recordingsDirOf(PROJ, task.id);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-outside-'));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret-bytes');
      fs.symlinkSync(
        path.join(outside, 'secret.txt'),
        path.join(dir, 'x.webm'),
      );

      const res = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/recordings/x.webm`,
      );
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('top-secret-bytes');

      const list = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/recordings`,
      );
      expect(await list.json()).toEqual({ recordings: [] });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a recordings dir swapped for another group during DELETE leaves that group intact', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const dir = recordingsDirOf(PROJ, task.id);
    const otherDir = recordingsDirOf('other-proj', task.id);
    const victim = path.join(otherDir, 'victim.webm');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'victim.webm'), 'mine');
      fs.writeFileSync(victim, 'not-yours');
      let swapped = false;
      groupFsTestHooks.beforeOpen = (_label, segment) => {
        if (segment !== `task-${task.id}`) return;
        groupFsTestHooks.beforeOpen = undefined;
        swapped = true;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.symlinkSync(otherDir, dir);
      };

      const all = await apiDelete(
        `/projects/${PROJ}/tasks/${task.id}/recordings`,
      );
      expect(all.status).toBe(200);
      expect(swapped).toBe(true);
      expect(fs.readFileSync(victim, 'utf8')).toBe('not-yours');

      const one = await apiDelete(
        `/projects/${PROJ}/tasks/${task.id}/recordings/victim.webm`,
      );
      expect(one.status).toBe(404);
      expect(fs.readFileSync(victim, 'utf8')).toBe('not-yours');
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('serves a recording with its pinned size and video/webm', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const dir = recordingsDirOf(PROJ, task.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ok.webm'), '0123456789');

      const res = await fetch(
        `${baseUrl}/projects/${PROJ}/tasks/${task.id}/recordings/ok.webm`,
        { headers: { Range: 'bytes=2-5' } },
      );
      expect(res.status).toBe(206);
      expect(res.headers.get('content-type')).toBe('video/webm');
      expect(await res.text()).toBe('2345');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pipeline-owned custom values over HTTP', () => {
  test('task-run credentials cannot write them via POST or PATCH; others can', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        custom_values: { rejection_count: 2, owner: 'alice' },
      }),
    );

    const createDenied = await apiPost(
      `/projects/${PROJ}/tasks`,
      { title: 'Denied', custom_values: { cost_limit_usd: 9999 } },
      task.id,
    );
    expect(createDenied.status).toBe(403);
    expect(((await createDenied.json()) as { error: string }).error).toContain(
      'cost_limit_usd',
    );
    expect((await getTasksByProject(PROJ)).map((t) => t.title)).not.toContain(
      'Denied',
    );

    const createAllowed = await apiPost(
      `/projects/${PROJ}/tasks`,
      { title: 'Allowed', custom_values: { summary: 'ok' } },
      task.id,
    );
    expect(createAllowed.status).toBe(201);

    const patchDenied = await apiPatch(
      `/projects/${PROJ}/tasks/${task.id}`,
      { title: 'Renamed', custom_values: { rejection_count: 0, owner: 'bob' } },
      undefined,
      task.id,
    );
    expect(patchDenied.status).toBe(403);
    const untouched = await getTask(task.id);
    expect(untouched?.title).not.toBe('Renamed');
    expect(untouched?.custom_values).toEqual({
      rejection_count: 2,
      owner: 'alice',
    });

    // A declared-key replacement keeps the stored pipeline-owned keys.
    const patchKeeps = await apiPatch(
      `/projects/${PROJ}/tasks/${task.id}`,
      { custom_values: { owner: 'dave' } },
      undefined,
      task.id,
    );
    expect(patchKeeps.status).toBe(200);
    expect((await getTask(task.id))?.custom_values).toEqual({
      rejection_count: 2,
      owner: 'dave',
    });

    const patchAllowed = await apiPatch(
      `/projects/${PROJ}/tasks/${task.id}`,
      { custom_values: { rejection_count: 2, owner: 'bob' } },
      undefined,
      undefined,
    );
    expect(patchAllowed.status).toBe(200);
    expect((await getTask(task.id))?.custom_values?.owner).toBe('bob');

    const plain = await createTask(
      taskFixture({ project_id: PROJ, custom_values: { owner: 'alice' } }),
    );
    const patchDeclared = await apiPatch(
      `/projects/${PROJ}/tasks/${plain.id}`,
      { custom_values: { owner: 'carol' } },
      undefined,
      plain.id,
    );
    expect(patchDeclared.status).toBe(200);
    expect((await getTask(plain.id))?.custom_values).toEqual({
      owner: 'carol',
    });
  });
});

describe('PATCH /api/projects/:pid/tasks/:fid', () => {
  test('does not push the owner when a task is manually moved into the question stage', async () => {
    const owner = await createUser('test-admin', 'pw', 'admin');
    await upsertProjectMember(owner.id, PROJ, 'owner');
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'backlog',
        ownerUserId: owner.id,
        lastTriggeredByUserId: owner.id,
        lastTriggerSource: 'user',
      }),
    );

    expect(
      (
        await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
          status: 'question',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
          status: 'backlog',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
          status: 'question',
        })
      ).status,
    ).toBe(200);

    expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
  });

  test('retains owner and triggerer notifications for a manual failed transition', async () => {
    const owner = await createUser('manual-failed-owner', 'pw', 'user');
    const triggerer = await createUser('manual-failed-triggerer', 'pw', 'user');
    await upsertProjectMember(owner.id, PROJ, 'owner');
    await upsertProjectMember(triggerer.id, PROJ, 'editor');
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Manual failed task',
        status: 'backlog',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      status: 'failed',
    });

    expect(res.status).toBe(200);
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({ summary: 'Task failed: Manual failed task' }),
    ]);
    expect(await getUnreadPayloads(triggerer.id)).toEqual([
      expect.objectContaining({ summary: 'Task failed: Manual failed task' }),
    ]);
  });

  test('stops the in_progress run and starts testing when a running card is moved there', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );
    const run = runFixture({
      group_folder: PROJ,
      task_id: task.id,
      stage: 'in_progress',
    });
    await insertActiveRun(run);
    const claim = claimTaskExecution(task.id, PROJ);
    expect(claim).toBeInstanceOf(AbortController);
    const drainsWhileRunning: boolean[] = [];
    exposeRegisteredRouteGroup = true;
    _testOnlySetTaskQueueDrainRunner(async () => {
      drainsWhileRunning.push(await isTaskRunning(task.id));
    });
    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'testing',
      });

      expect(res.status).toBe(200);
      const moved = await getTask(task.id);
      expect(moved?.status).toBe('testing');
      expect(moved?.error).not.toBe('Stopped by user');
      expect(claim!.signal.aborted).toBe(true);
      expect((await getActiveRunById(run.id))?.status).toBe('error');
      // The drain runs only after the old claim is released.
      expect(drainsWhileRunning).toEqual([false]);
    } finally {
      releaseTaskExecutionClaim(task.id, claim!);
      _testOnlySetTaskQueueDrainRunner(null);
      exposeRegisteredRouteGroup = false;
    }
  });
});

// ─── POST /api/projects/:pid/tasks ────────────────────────────────────────────

describe('POST /api/projects/:pid/tasks', () => {
  test('rejects an unknown dependency id without creating the task', async () => {
    const before = await getTasksByProject(PROJ);

    const res = await apiPost(`/projects/${PROJ}/tasks`, {
      title: 'Task with dangling dependency',
      depends_on_ids: ['task-does-not-exist'],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown dependency/i);
    expect(body.error).toContain('task-does-not-exist');
    expect(await getTasksByProject(PROJ)).toHaveLength(before.length);
  });

  test('returns 404 without creating an orphan task for an unknown project', async () => {
    const res = await apiPost('/projects/missing-project/tasks', {
      title: 'Orphan task',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/project not found/i);
    expect(await getTasksByProject('missing-project')).toHaveLength(0);
  });

  test('persists only structured task runtime configuration', async () => {
    const initialRuntime = getDefaultRuntimeSelection('kanban');
    const createRes = await apiPost(`/projects/${PROJ}/tasks`, {
      title: 'Structured runtime task',
      model: 'legacy-model',
      agent_name: 'legacy-agent',
      runtimeSelection: initialRuntime,
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.runtimeSelection).toEqual(initialRuntime);
    expect('model' in created).toBe(false);
    expect('agent_name' in created).toBe(false);

    const patchRes = await apiPatch(`/projects/${PROJ}/tasks/${created.id}`, {
      model: 'ignored-model',
      agent_name: 'ignored-agent',
      runtimeSelection: null,
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as Record<string, unknown>;
    expect(updated.runtimeSelection).toBeNull();
    expect('model' in updated).toBe(false);
    expect('agent_name' in updated).toBe(false);
  });

  test('appends an omitted priority and preserves an explicit zero priority', async () => {
    await createTask(taskFixture({ project_id: PROJ, priority: 50 }));

    const appended = await apiPost(`/projects/${PROJ}/tasks`, {
      title: 'Appended task',
    });
    const explicitZero = await apiPost(`/projects/${PROJ}/tasks`, {
      title: 'Explicit zero task',
      priority: 0,
    });

    expect(((await appended.json()) as { priority: number }).priority).toBe(
      1050,
    );
    expect(((await explicitZero.json()) as { priority: number }).priority).toBe(
      0,
    );
  });
});

describe('task objective_id ownership over HTTP', () => {
  const OTHER = 'objective-owner-proj';
  const post = (
    body: unknown,
    headers: Record<string, string> = {},
    pid = PROJ,
  ) =>
    fetch(`${baseUrl}/projects/${pid}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const newObjective = (project_id: string) =>
    createObjective({
      project_id,
      title: 'Objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });

  test('requires access to a foreign objective project and rejects unknown objectives', async () => {
    const own = await newObjective(PROJ);
    const foreign = await newObjective(OTHER);
    const editor = { 'x-test-user-role': 'user', 'x-test-user-id': 'editor-a' };

    expect(
      (await post({ title: 'own', objective_id: own.id }, editor)).status,
    ).toBe(201);
    expect(
      (await post({ title: 'foreign', objective_id: foreign.id }, editor))
        .status,
    ).toBe(403);
    expect(
      (await post({ title: 'unknown', objective_id: 'missing' }, editor))
        .status,
    ).toBe(400);

    const task = await createTask(taskFixture({ project_id: PROJ }));
    const patch = await fetch(`${baseUrl}/projects/${PROJ}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...editor },
      body: JSON.stringify({ objective_id: foreign.id }),
    });
    expect(patch.status).toBe(403);
    expect((await getTask(task.id))?.objective_id ?? null).toBeNull();
  });

  test('viewer and shared-chat-only users cannot tag with a foreign objective, editors can', async () => {
    const foreign = await newObjective(OTHER);
    const viewer = await createUser('objtag-viewer', 'pw', 'user');
    const chatOnly = await createUser('objtag-chat-only', 'pw', 'user');
    const editor = await createUser('objtag-editor', 'pw', 'user');
    for (const u of [viewer, chatOnly, editor]) {
      await upsertProjectMember(u.id, PROJ, 'editor');
    }
    await upsertProjectMember(viewer.id, OTHER, 'viewer');
    await upsertProjectMember(editor.id, OTHER, 'editor');
    const conversation = await createConversation(OTHER);
    await upsertConversationMember(chatOnly.id, conversation.id, 'viewer');

    const task = await createTask(taskFixture({ project_id: PROJ }));
    for (const user of [viewer, chatOnly]) {
      const headers = {
        'x-test-user-role': 'user',
        'x-test-user-id': user.id,
      };
      expect(
        (await post({ title: 'foreign', objective_id: foreign.id }, headers))
          .status,
      ).toBe(403);
      const patch = await fetch(
        `${baseUrl}/projects/${PROJ}/tasks/${task.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ objective_id: foreign.id }),
        },
      );
      expect(patch.status).toBe(403);
    }
    expect((await getTask(task.id))?.objective_id ?? null).toBeNull();

    expect(
      (
        await post(
          { title: 'foreign', objective_id: foreign.id },
          { 'x-test-user-role': 'user', 'x-test-user-id': editor.id },
        )
      ).status,
    ).toBe(201);
  });

  test('a parent-scoped agent token may tag a child-project task with its own objective', async () => {
    const parentObjective = await newObjective(OTHER);
    const res = await post(
      { title: 'child card', objective_id: parentObjective.id },
      { 'x-test-token-folder': OTHER },
    );
    expect(res.status).toBe(201);
  });
});

describe('GET /api/projects/:pid/tasks/:fid', () => {
  test('returns 404 when task belongs to a different project', async () => {
    const task = await createTask(
      taskFixture({ project_id: 'other-proj', title: 'Cross-proj' }),
    );
    const res = await apiGet(`/projects/${PROJ}/tasks/${task.id}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:pid/tasks/:fid/fork', () => {
  test('copies only the source structured runtime selection', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    const runtimeSelection = {
      harnessId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoning: 'high',
    };
    const source = await createTask(
      taskFixture({ project_id: PROJ, runtimeSelection }),
    );
    const message = await appendTaskMessageAsync(PROJ, {
      task_id: source.id,
      role: 'assistant',
      content: 'Fork from here',
      created_at: new Date().toISOString(),
    });

    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        status: 'paused',
        stages: originalSettings?.stages?.map((stage) =>
          stage.id === 'backlog' ? { ...stage, runOnEntry: true } : stage,
        ),
      },
    });

    try {
      const response = await apiPost(
        `/projects/${PROJ}/tasks/${source.id}/fork`,
        { messageId: message.id, prompt: 'Continue differently' },
      );
      expect(response.status).toBe(201);
      const fork = (await response.json()) as Record<string, unknown>;
      expect(fork.runtimeSelection).toEqual(runtimeSelection);
      expect('model' in fork).toBe(false);
      expect('agent_name' in fork).toBe(false);
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
});

// ─── PATCH /api/projects/:pid/tasks/:fid ─────────────────────────────────────

describe('PATCH /api/projects/:pid/tasks/:fid', () => {
  test('rejects an unknown dependency id and leaves stored dependencies unchanged', async () => {
    const dependency = await createTask(taskFixture({ project_id: PROJ }));
    const task = await createTask(
      taskFixture({ project_id: PROJ, depends_on_ids: [dependency.id] }),
    );

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: ['task-does-not-exist'],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown dependency/i);
    expect(body.error).toContain('task-does-not-exist');
    expect((await getTask(task.id))?.depends_on_ids).toEqual([dependency.id]);
  });

  test('moving a dependency into a done stage drains the queue so its dependent starts', async () => {
    const dependency = await createTask(
      taskFixture({ project_id: PROJ, status: 'review' }),
    );
    const dependent = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'in_progress',
        depends_on_ids: [dependency.id],
      }),
    );
    const drains: string[] = [];
    const started: string[] = [];
    let markStarted!: () => void;
    const dependentStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    exposeRegisteredRouteGroup = true;
    const registered = getGroupByFolder(PROJ);
    setGroupResolver((projectId) =>
      projectId === PROJ ? registered : undefined,
    );
    _testOnlySetTaskQueueDrainRunner((projectId, routeGroup) => {
      drains.push(projectId);
      return drainProjectQueue(projectId, routeGroup, {
        testDependencies: {
          executeTask: async (claimedTask) => {
            started.push(claimedTask.id);
            markStarted();
          },
        },
      });
    });
    try {
      // A non-done, non-active move does not newly drain.
      expect(
        (
          await apiPatch(`/projects/${PROJ}/tasks/${dependency.id}`, {
            status: 'backlog',
          })
        ).status,
      ).toBe(200);
      expect(drains).toEqual([]);

      const res = await apiPatch(`/projects/${PROJ}/tasks/${dependency.id}`, {
        status: 'completed',
      });
      expect(res.status).toBe(200);
      await dependentStarted;
      expect(drains).toEqual([PROJ]);
      expect(started).toEqual([dependent.id]);
    } finally {
      _testOnlySetTaskQueueDrainRunner(null);
      exposeRegisteredRouteGroup = false;
      setGroupResolver(() => undefined);
    }
  });

  test('restoring an archived active-stage card without a stage move drains once', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );
    await updateTask(task.id, { archived: true });
    const drains: string[] = [];
    _testOnlySetTaskQueueDrainRunner(async (projectId) => {
      drains.push(projectId);
    });
    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        archived: false,
      });
      expect(res.status).toBe(200);
      expect(drains).toEqual([PROJ]);
    } finally {
      _testOnlySetTaskQueueDrainRunner(null);
    }
  });

  test('moving a card into the deploy stage still queues the deploy and drains once', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        deployService: 'test-service',
        deployStage: 'deploy',
        stages: [
          ...(originalSettings?.stages ?? []),
          { id: 'deploy', title: 'Deploy', type: 'done', color: '#0aa' },
        ],
      },
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'completed' }),
    );
    const drains: string[] = [];
    _testOnlySetTaskQueueDrainRunner(async (projectId) => {
      drains.push(projectId);
    });
    const buildsBefore = countActiveServiceBuilds();
    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'deploy',
      });
      expect(res.status).toBe(200);
      // queueDeploy holds the service build until the debounced batch flushes.
      expect(countActiveServiceBuilds()).toBe(buildsBefore + 1);
      expect(drains).toEqual([PROJ]);
    } finally {
      await flushDeploy(PROJ);
      _testOnlySetTaskQueueDrainRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
    expect(countActiveServiceBuilds()).toBe(buildsBefore);
  });

  test('resets testing failures when manually moving question to an executable stage', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'question',
        custom_values: { testing_failure_count: 6, owner: 'alice' },
      }),
    );
    await insertActiveRun(runFixture({ group_folder: PROJ, task_id: task.id }));

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      status: 'in_progress',
    });

    expect(res.status).toBe(200);
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.custom_values).toEqual({
      testing_failure_count: 0,
      owner: 'alice',
    });
  });

  test('restarts the review rejection cap only for human question retries', async () => {
    const parked = () =>
      createTask(
        taskFixture({
          project_id: PROJ,
          status: 'question',
          custom_values: { rejection_count: 8, no_progress_count: 1 },
        }),
      );
    const [human, bulk, agent] = [
      await parked(),
      await parked(),
      await parked(),
    ];
    const humanHeaders = {
      'Content-Type': 'application/json',
      'x-test-human-credential': '1',
    };

    const single = await fetch(
      `${baseUrl}/projects/${PROJ}/tasks/${human.id}`,
      {
        method: 'PATCH',
        headers: humanHeaders,
        body: JSON.stringify({ status: 'in_progress' }),
      },
    );
    const bulkRes = await fetch(`${baseUrl}/projects/${PROJ}/tasks/bulk`, {
      method: 'PATCH',
      headers: humanHeaders,
      body: JSON.stringify({ ids: [bulk.id], status: 'in_progress' }),
    });
    const agentRes = await apiAgentPatch(
      `/projects/${PROJ}/tasks/${agent.id}`,
      { status: 'in_progress' },
    );

    expect([single.status, bulkRes.status, agentRes.status]).toEqual([
      200, 200, 200,
    ]);
    for (const id of [human.id, bulk.id]) {
      expect((await getTask(id))?.custom_values).toMatchObject({
        rejection_count: 8,
        rejection_cap_base: 8,
        no_progress_count: 0,
      });
    }
    const agentValues = (await getTask(agent.id))?.custom_values;
    expect(agentValues).toMatchObject({
      rejection_count: 8,
      no_progress_count: 1,
    });
    expect(agentValues).not.toHaveProperty('rejection_cap_base');
  });

  test('stamps completion time when manually moved into a done stage and clears it when reopened', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'backlog', completed_at: null }),
    );
    const beforeCompletion = Date.now();

    const completedRes = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      status: 'completed',
    });

    expect(completedRes.status).toBe(200);
    const completed = await getTask(task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.completed_at).toBeString();
    expect(new Date(completed!.completed_at!).getTime()).toBeGreaterThanOrEqual(
      beforeCompletion,
    );

    const reopenedRes = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      status: 'backlog',
    });

    expect(reopenedRes.status).toBe(200);
    expect((await getTask(task.id))?.completed_at).toBeNull();
  });

  test('notifies only the other explicit owner after a single manual completion', async () => {
    const mover = await createUser('single-other-mover', 'pw', 'user');
    const owner = await createUser('single-other-owner', 'pw', 'user');
    await upsertProjectMember(mover.id, PROJ, 'editor');
    await upsertProjectMember(owner.id, PROJ, 'owner');
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Other owner manual completion',
        status: 'backlog',
        ownerUserId: owner.id,
        lastTriggeredByUserId: mover.id,
        lastTriggerSource: 'user',
      }),
    );

    const res = await apiPatch(
      `/projects/${PROJ}/tasks/${task.id}`,
      { status: 'completed' },
      mover.id,
    );

    expect(res.status).toBe(200);
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({
        summary: 'Task completed: Other owner manual completion',
      }),
    ]);
    expect(await getUnreadPayloads(mover.id)).toHaveLength(0);
  });

  test('merges a branched task synchronously when Completed has no deploy service', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'backlog',
        branch_name: 'task/manual-completion',
        worktree_path: '/host/repo/.worktrees/task/manual-completion',
      }),
    );

    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'completed',
      });

      if (res.status !== 200) throw new Error(await res.text());
      expect((await getTask(task.id))?.status).toBe('completed');
      expect((await getTask(task.id))?.branch_name).toBeNull();
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('manual completion accepts a clean shared default checkout as a durable no-change result', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'shared',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'backlog',
        branch_name: null,
        worktree_path: null,
      }),
    );

    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'completed',
      });

      expect(res.status).toBe(200);
      expect((await getTask(task.id))?.status).toBe('completed');
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('shows live branch-owned edits and preserves the first done-stage merge', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-task-route-branch-diff-'),
    );
    const gitEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? os.tmpdir(),
      LANG: 'C',
    };
    const git = (args: string[]) => {
      const result = spawnSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: gitEnv,
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };

    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Carapa Test']);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
      git(['add', 'tracked.txt']);
      git(['commit', '-qm', 'base']);
      git(['checkout', '-qb', 'branch-live-task']);
      fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed\n');
      git(['add', 'committed.txt']);
      git(['commit', '-qm', 'committed task edit']);
      fs.appendFileSync(path.join(repo, 'tracked.txt'), 'uncommitted\n');
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');

      sandboxGitHandler = async (command) => {
        const result = spawnSync('sh', ['-c', `git ${command}`], {
          cwd: repo,
          encoding: 'utf8',
          env: gitEnv,
        });
        return { stdout: result.stdout || '', isError: result.status !== 0 };
      };
      sandboxBranchHandler = async (action) => {
        if (action === 'commit') {
          return { stdout: 'nothing to commit', isError: false };
        }
        if (action === 'merge') {
          git(['checkout', '-q', 'master']);
          git([
            'merge',
            '--no-ff',
            '-qm',
            'merge branch task',
            'branch-live-task',
          ]);
          return {
            stdout: JSON.stringify({ merged: true, pushed: false }),
            isError: false,
          };
        }
        return {
          stdout: JSON.stringify({ repositories: [] }),
          isError: false,
        };
      };
      await updateGroup(PROJ_JID, {
        settings: {
          ...originalSettings,
          taskCheckoutMode: 'branch',
          repositoryLocation: repo,
          defaultBranch: 'master',
        },
      });
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          status: 'in_progress',
          branch_name: 'branch-live-task',
          sandbox_instance: PROJ,
        }),
      );

      const diffResponse = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/diff`,
      );
      expect(diffResponse.status).toBe(200);
      const diff = (await diffResponse.json()) as {
        available: boolean;
        scope: string;
        uncommitted?: boolean;
        files: Array<{ path: string; source?: string }>;
        patch: string;
        blockers?: Array<{ path: string; source?: string }>;
      };
      expect(diff).toMatchObject({
        available: true,
        scope: 'branch',
        uncommitted: true,
        blockers: [],
      });
      expect(diff.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'committed.txt', source: 'task' }),
          expect.objectContaining({ path: 'tracked.txt', source: 'task' }),
          expect.objectContaining({ path: 'untracked.txt', source: 'task' }),
        ]),
      );
      expect(diff.patch).toContain('committed.txt');
      expect(diff.patch).toContain('tracked.txt');
      expect(diff.patch).toContain('untracked.txt');

      git(['add', '-A']);
      git(['commit', '-qm', 'checkpoint active task']);
      git(['checkout', '-q', 'master']);
      fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'default dirt\n');
      const defaultCheckoutResponse = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/diff`,
      );
      expect(defaultCheckoutResponse.status).toBe(200);
      const defaultCheckoutDiff = (await defaultCheckoutResponse.json()) as {
        files: Array<{ path: string; source?: string }>;
        blockers: Array<{ path: string; source?: string }>;
      };
      expect(defaultCheckoutDiff.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'committed.txt', source: 'task' }),
          expect.objectContaining({ path: 'tracked.txt', source: 'task' }),
          expect.objectContaining({ path: 'untracked.txt', source: 'task' }),
        ]),
      );
      expect(defaultCheckoutDiff.blockers).toEqual([
        expect.objectContaining({
          path: 'unrelated.txt',
          source: 'default-checkout-blocker',
        }),
      ]);

      fs.rmSync(path.join(repo, 'unrelated.txt'));
      git(['checkout', '-q', 'branch-live-task']);
      const completionResponse = await apiPatch(
        `/projects/${PROJ}/tasks/${task.id}`,
        { status: 'completed' },
      );
      expect(completionResponse.status).toBe(200);
      const completedTask = await getTask(task.id);
      expect(completedTask?.status).toBe('completed');
      expect(completedTask?.branch_name).toBeNull();
      expect(completedTask?.merge_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(git(['show', 'master:untracked.txt'])).toBe('untracked\n');
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('shows isolated symlinks and allows completion with shared-checkout integration pending', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-task-route-links-'),
    );
    const gitEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? os.tmpdir(),
      LANG: 'C',
    };
    const sandboxCommands: string[] = [];
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: gitEnv,
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };

    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Carapa Test']);
      fs.mkdirSync(path.join(repo, 'tracked-dir'));
      fs.writeFileSync(path.join(repo, 'tracked-dir', 'file.txt'), 'tracked\n');
      git(['add', 'tracked-dir/file.txt']);
      git(['commit', '-qm', 'base']);
      fs.mkdirSync(path.join(repo, '.worktrees'));
      git([
        'worktree',
        'add',
        '-qb',
        'task-link',
        '.worktrees/task-link',
        'HEAD',
      ]);
      fs.mkdirSync(path.join(repo, '.worktrees', 'task-link', '.agents'));
      fs.symlinkSync(
        '../tracked-dir',
        path.join(repo, '.worktrees', 'task-link', '.agents', 'skills'),
      );
      fs.symlinkSync('tracked-dir', path.join(repo, 'external-blocker'));

      sandboxGitHandler = async (command) => {
        sandboxCommands.push(command);
        const result = spawnSync('sh', ['-c', `git ${command}`], {
          cwd: repo,
          encoding: 'utf8',
          env: gitEnv,
        });
        return { stdout: result.stdout || '', isError: result.status !== 0 };
      };
      sandboxBranchHandler = async (action) => {
        if (action === 'commit') {
          const worktree = path.join(repo, '.worktrees', 'task-link');
          git(['add', '-A'], worktree);
          git(['commit', '-qm', 'feat: committed task symlink'], worktree);
          return {
            stdout: JSON.stringify({ committed: true }),
            isError: false,
          };
        }
        if (action === 'merge') {
          return { stdout: '[env] default checkout is dirty', isError: true };
        }
        return {
          stdout: JSON.stringify({ repositories: [] }),
          isError: false,
        };
      };
      await updateGroup(PROJ_JID, {
        settings: {
          ...originalSettings,
          taskCheckoutMode: 'worktree',
          repositoryLocation: repo,
          defaultBranch: 'master',
        },
      });
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          status: 'backlog',
          branch_name: 'task-link',
          worktree_path: path.join(repo, '.worktrees', 'task-link'),
        }),
      );
      await updateTask(task.id, {
        worktree_path: path.join(repo, '.worktrees', 'task-link'),
      });

      const diffResponse = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/diff`,
      );
      expect(diffResponse.status).toBe(200);
      const diff = (await diffResponse.json()) as {
        files: Array<{ path: string; kind?: string; linkTarget?: string }>;
        blockers: Array<{ path: string; source?: string }>;
      };
      expect(
        diff.files,
        JSON.stringify({ diff, sandboxCommands }, null, 2),
      ).toContainEqual(
        expect.objectContaining({
          path: '.agents/skills',
          kind: 'symlink',
          linkTarget: '../tracked-dir',
        }),
      );
      expect(diff.blockers).toContainEqual(
        expect.objectContaining({
          path: 'external-blocker',
          source: 'default-checkout-blocker',
        }),
      );

      const completionResponse = await apiPatch(
        `/projects/${PROJ}/tasks/${task.id}`,
        {
          status: 'completed',
        },
      );
      expect(completionResponse.status).toBe(200);
      expect((await getTask(task.id))?.status).toBe('completed');
      expect((await getTask(task.id))?.branch_name).toBe('task-link');
      expect((await getTask(task.id))?.worktree_path).toBe(
        path.join(repo, '.worktrees', 'task-link'),
      );
      expect(
        git(
          ['show', '--format=', '--name-only', 'HEAD'],
          path.join(repo, '.worktrees', 'task-link'),
        ),
      ).toContain('.agents/skills');
      const refreshedDiffResponse = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/diff`,
      );
      expect(refreshedDiffResponse.status).toBe(200);
      const refreshedDiff = (await refreshedDiffResponse.json()) as {
        files: Array<{ path: string; kind?: string; linkTarget?: string }>;
      };
      expect(refreshedDiff.files).toContainEqual(
        expect.objectContaining({
          path: '.agents/skills',
          kind: 'symlink',
          linkTarget: '../tracked-dir',
        }),
      );
      await updateTask(task.id, { worktree_path: null });
      const sharedBranchResponse = await apiGet(
        `/projects/${PROJ}/tasks/${task.id}/diff`,
      );
      expect(sharedBranchResponse.status).toBe(200);
      const sharedBranchDiff = (await sharedBranchResponse.json()) as {
        blockers: Array<{ path: string; source?: string }>;
      };
      expect(sharedBranchDiff.blockers).toContainEqual(
        expect.objectContaining({
          path: 'external-blocker',
          source: 'default-checkout-blocker',
        }),
      );
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('diff is unavailable for a done task with neither branch nor merge commit', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: { ...originalSettings, repositoryLocation: '/host/repo' },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          status: 'completed',
          branch_name: null,
          merge_commit: null,
        }),
      );
      const res = await apiGet(`/projects/${PROJ}/tasks/${task.id}/diff`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: false });
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('returns 400 when a task depends on itself', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [task.id],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/itself/i);
  });
});

describe('PATCH depends_on_ids on a started task', () => {
  const DEP_COMMIT = 'd'.repeat(40);
  const HEAD_COMMIT = 'a'.repeat(40);
  const BRANCH = 'task/started-work';
  let originalSettings: NonNullable<
    ReturnType<typeof getGroupByFolder>
  >['settings'];

  // The launch guard only applies to projects that use task branches.
  beforeAll(async () => {
    originalSettings = { ...getGroupByFolder(PROJ)!.settings };
    await updateGroup(PROJ_JID, {
      settings: { ...originalSettings, taskCheckoutMode: 'worktree' },
    });
  });
  afterAll(async () => {
    await updateGroup(PROJ_JID, { settings: originalSettings });
  });

  // Git view of a task branch: `contained` decides whether the dependency
  // commit is reachable from the branch head; `broken` fails every command and
  // `countFails` fails only the ancestry count.
  function stubTaskBranchGit(options: {
    contained: boolean;
    broken?: boolean;
    countFails?: boolean;
  }): void {
    sandboxGitHandler = async (command) => {
      if (options.broken) return { stdout: 'git failed', isError: true };
      if (command === `rev-parse --verify ${DEP_COMMIT}^{commit}`)
        return { stdout: DEP_COMMIT, isError: false };
      if (command === `rev-parse --verify ${BRANCH}^{commit}`)
        return { stdout: HEAD_COMMIT, isError: false };
      if (command === `rev-list --count ${HEAD_COMMIT}..${DEP_COMMIT}`)
        return options.countFails
          ? { stdout: 'fatal: bad object', isError: true }
          : { stdout: options.contained ? '0\n' : '2\n', isError: false };
      return { stdout: '', isError: true };
    };
  }

  async function startedTaskWithDoneDependency(
    taskOverrides: Record<string, unknown> = { branch_name: BRANCH },
    dependencyCommit: string | null = DEP_COMMIT,
    dependencyStatus = 'completed',
  ) {
    const dependency = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Paged KV base',
        status: dependencyStatus,
        custom_values: dependencyCommit
          ? { completed_commit_sha: dependencyCommit }
          : undefined,
      }),
    );
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'backlog',
        ...taskOverrides,
      }),
    );
    return { dependency, task };
  }

  test('warns and posts a notice when the dependency is not in the task branch', async () => {
    stubTaskBranchGit({ contained: false });
    const { dependency, task } = await startedTaskWithDoneDependency();

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      depends_on_ids: string[];
      warnings?: string[];
    };
    expect(body.depends_on_ids).toEqual([dependency.id]);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings![0]).toContain(`Dependency ${dependency.id}`);
    expect(body.warnings![0]).toContain('"Paged KV base"');
    expect(body.warnings![0]).toContain('Start over');
    const notices = readTaskMessages(PROJ, task.id).filter(
      (message) => message.entry_type === 'system_notice',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain(body.warnings![0]!);
  });

  test('does not warn when the dependency commit is already in the branch', async () => {
    stubTaskBranchGit({ contained: true });
    const { dependency, task } = await startedTaskWithDoneDependency();

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
      undefined,
    );
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
  });

  test('does not warn when the dependency is removed or already declared', async () => {
    stubTaskBranchGit({ contained: false });
    const { dependency, task } = await startedTaskWithDoneDependency({
      branch_name: BRANCH,
    });
    await updateTask(task.id, { depends_on_ids: [dependency.id] });

    const resent = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });
    const removed = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [],
    });

    for (const res of [resent, removed]) {
      expect(res.status).toBe(200);
      expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
        undefined,
      );
    }
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
  });

  test('does not warn for a task that has not started', async () => {
    stubTaskBranchGit({ contained: false });
    const { dependency, task } = await startedTaskWithDoneDependency({});

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
      undefined,
    );
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
  });

  test('does not warn when the dependency has no recorded commit yet', async () => {
    stubTaskBranchGit({ contained: false });
    const { dependency, task } = await startedTaskWithDoneDependency(
      { branch_name: BRANCH },
      null,
    );

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
      undefined,
    );
  });

  test('warns for a dependency that is not done yet when the task branch already exists', async () => {
    stubTaskBranchGit({ contained: false });
    const { dependency, task } = await startedTaskWithDoneDependency(
      { branch_name: BRANCH },
      DEP_COMMIT,
      'review',
    );

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: string[] };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings![0]).toContain(`Dependency ${dependency.id}`);
    expect(body.warnings![0]).toContain('"Paged KV base"');
    expect(body.warnings![0]).toContain('not finished');
    expect(body.warnings![0]).toContain('Start over');
    const notices = readTaskMessages(PROJ, task.id).filter(
      (message) => message.entry_type === 'system_notice',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain(body.warnings![0]!);
  });

  test('does not warn for an unfinished dependency when the branch lookup fails', async () => {
    stubTaskBranchGit({ contained: false, broken: true });
    const { dependency, task } = await startedTaskWithDoneDependency(
      { branch_name: BRANCH },
      DEP_COMMIT,
      'review',
    );

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
      undefined,
    );
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
  });

  test('does not warn for an A/B task, whether the dependency is done or unfinished', async () => {
    stubTaskBranchGit({ contained: false });
    for (const dependencyStatus of ['completed', 'review']) {
      const { dependency, task } = await startedTaskWithDoneDependency(
        { branch_name: BRANCH, ab_fork_commit: HEAD_COMMIT },
        DEP_COMMIT,
        dependencyStatus,
      );

      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        depends_on_ids: [dependency.id],
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
        undefined,
      );
      expect(readTaskMessages(PROJ, task.id)).toEqual([]);
    }
  });

  test('does not warn when the ancestry check itself fails', async () => {
    stubTaskBranchGit({ contained: false, countFails: true });
    const { dependency, task } = await startedTaskWithDoneDependency();

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
      undefined,
    );
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
  });

  test('still succeeds without a warning when the git check fails', async () => {
    stubTaskBranchGit({ contained: false, broken: true });
    const { dependency, task } = await startedTaskWithDoneDependency();

    const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      depends_on_ids: [dependency.id],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      depends_on_ids: string[];
      warnings?: string[];
    };
    expect(body.depends_on_ids).toEqual([dependency.id]);
    expect(body.warnings).toBe(undefined);
    expect(readTaskMessages(PROJ, task.id)).toEqual([]);
  });
});

describe('POST /api/projects/:pid/tasks/:fid/execute', () => {
  describe('Start over (reset=true)', () => {
    const BRANCH = 'start-over-task';
    let originalSettings: NonNullable<
      ReturnType<typeof getGroupByFolder>
    >['settings'];
    let gitCommands: string[];
    let drains: string[];

    async function seedStartOverTask(checkoutMode: 'worktree' | 'branch') {
      originalSettings = { ...getGroupByFolder(PROJ)!.settings };
      await updateGroup(PROJ_JID, {
        settings: {
          ...originalSettings,
          taskCheckoutMode: checkoutMode,
          repositoryLocation: '/host/repo',
        },
      });
      gitCommands = [];
      sandboxGitHandler = async (command) => {
        gitCommands.push(command);
        return {
          stdout: command.includes('branch --show-current')
            ? 'develop'
            : command.includes('status --porcelain')
              ? ''
              : '0123456789abcdef0123456789abcdef01234567',
          isError: false,
        };
      };
      drains = [];
      _testOnlySetTaskQueueDrainRunner(async (projectId) => {
        drains.push(projectId);
      });
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          status: 'in_progress',
          branch_name: BRANCH,
          worktree_path: `/host/repo/.worktrees/${BRANCH}`,
          output: 'old output',
          error: 'old error',
        }),
      );
      await appendTaskMessageAsync(PROJ, {
        task_id: task.id,
        role: 'assistant',
        content: 'old transcript',
        created_at: '2026-01-01T00:00:00.000Z',
      });
      return task;
    }

    afterEach(async () => {
      _testOnlySetTaskQueueDrainRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    });

    test('worktree mode removes the old worktree and branch instead of resetting it', async () => {
      const task = await seedStartOverTask('worktree');

      const res = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute?reset=true`,
        {},
      );

      expect(res.status).toBe(202);
      expect(sandboxWorktreeCalls).toEqual([
        { action: 'remove', branch: BRANCH },
      ]);
      expect(gitCommands).toContain(`branch -D ${BRANCH}`);
      const after = await getTask(task.id);
      expect(after?.worktree_path).toBeNull();
      expect(after?.branch_name).toBe(BRANCH);
      expect(after?.output).toBe('');
      expect(readTaskMessages(PROJ, task.id)).toEqual([]);
      expect(drains).toEqual([PROJ]);
    });

    test('worktree mode leaves everything unchanged and answers 502 when CarapaBox cannot remove the worktree', async () => {
      const task = await seedStartOverTask('worktree');
      sandboxWorktreeRemoveError = 'worktree is locked';

      const res = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute?reset=true`,
        {},
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'worktree is locked' });
      const after = await getTask(task.id);
      expect(after?.worktree_path).toBe(`/host/repo/.worktrees/${BRANCH}`);
      expect(after?.branch_name).toBe(BRANCH);
      expect(after?.status).toBe('in_progress');
      expect(after?.output).toBe('old output');
      expect(after?.error).toBe('old error');
      expect(readTaskMessages(PROJ, task.id)).toHaveLength(1);
      expect(gitCommands.some((c) => c.startsWith('branch -D'))).toBe(false);
      expect(drains).toEqual([]);
    });

    test('worktree mode answers 409 with conversationIds while a conversation uses the worktree', async () => {
      const task = await seedStartOverTask('worktree');
      const conversation = await createConversation(PROJ, {
        use_worktree: true,
        branch_name: BRANCH,
      });
      const ownerId = `start-over-${conversation.id}`;
      await acquireConversationExecutionLease(conversation.id, ownerId);

      try {
        const res = await apiPost(
          `/projects/${PROJ}/tasks/${task.id}/execute?reset=true`,
          {},
        );

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
          error: 'Wait for the active conversation runs to finish first',
          conversationIds: [conversation.id],
        });
        const after = await getTask(task.id);
        expect(after?.worktree_path).toBe(`/host/repo/.worktrees/${BRANCH}`);
        expect(after?.output).toBe('old output');
        expect(readTaskMessages(PROJ, task.id)).toHaveLength(1);
        expect(sandboxWorktreeCalls).toHaveLength(0);
        expect(gitCommands.some((c) => c.startsWith('branch -D'))).toBe(false);
        expect(drains).toEqual([]);
      } finally {
        await releaseConversationExecutionLease(conversation.id, ownerId);
      }
    });

    test("worktree mode without a worktree still deletes the branch, tolerating only git's missing-branch error", async () => {
      const task = await seedStartOverTask('worktree');
      await updateTask(task.id, { worktree_path: null });
      const defaultGit = sandboxGitHandler;
      sandboxGitHandler = async (command) =>
        command.startsWith('branch -D')
          ? (gitCommands.push(command),
            { stdout: `error: branch '${BRANCH}' not found.`, isError: true })
          : defaultGit(command);

      const ok = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute?reset=true`,
        {},
      );
      expect(ok.status).toBe(202);
      expect(gitCommands).toContain(`branch -D ${BRANCH}`);
      expect(sandboxWorktreeCalls).toHaveLength(0);

      await appendTaskMessageAsync(PROJ, {
        task_id: task.id,
        role: 'assistant',
        content: 'second transcript',
        created_at: '2026-01-01T00:00:00.000Z',
      });
      sandboxGitHandler = async (command) =>
        command.startsWith('branch -D')
          ? { stdout: 'stack carapa-box not found', isError: true }
          : defaultGit(command);
      drains.length = 0;

      const failed = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute?reset=true`,
        {},
      );
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({
        error: 'stack carapa-box not found',
      });
      expect(readTaskMessages(PROJ, task.id)).toHaveLength(1);
      expect(drains).toEqual([]);
    });

    test('branch mode still resets the task branch on the shared checkout', async () => {
      const task = await seedStartOverTask('branch');

      const res = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute?reset=true`,
        {},
      );

      expect(res.status).toBe(202);
      expect(sandboxWorktreeCalls).toHaveLength(0);
      expect(gitCommands).toContain(`checkout ${BRANCH}`);
      expect(gitCommands).toContain('reset --hard develop');
      expect(gitCommands.some((c) => c.startsWith('branch -D'))).toBe(false);
      expect(readTaskMessages(PROJ, task.id)).toEqual([]);
      expect(drains).toEqual([PROJ]);
    });
  });

  test('rejects a forked A/B experiment parent with 409 without starting a run', async () => {
    let started = false;
    _testOnlySetExplicitExecuteTaskRunner(async () => {
      started = true;
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'in_progress',
        ab_fork_commit: 'abc123',
      }),
    );

    try {
      const response = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /Forked A\/B experiment parent/,
      );
      expect(started).toBe(false);
    } finally {
      _testOnlySetExplicitExecuteTaskRunner(null);
    }
  });

  test('does not create an entry event for its internal stage relocation', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#3b82f6',
            runOnEntry: true,
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done',
            color: '#16a34a',
          },
        ],
      },
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'completed' }),
    );
    _testOnlySetExplicitExecuteTaskRunner(
      async (startedTask, _group, options) => {
        if (options?.executionClaim) {
          releaseTaskExecutionClaim(startedTask.id, options.executionClaim);
        }
      },
    );

    try {
      const response = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );

      expect(response.status).toBe(202);
      expect((await getTask(task.id))?.status).toBe('in_progress');
      expect(await getUnresolvedStageEntryEvents(PROJ)).toEqual([]);
    } finally {
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('starts an isolated explicit run while the automatic slot is occupied', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    const occupiedAutomaticSlot = await acquireGroupSlot(PROJ, 1);
    let releaseWorker!: () => void;
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let markWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    let routeExecution: Promise<void> | undefined;

    _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
      routeExecution = executeTaskPipeline(task, group, {
        ...(options ?? {}),
        testDependencies: {
          runContainerAgent: (runGroup, input, onChunk) =>
            runContainerAgent(runGroup, input, onChunk, {
              resolveEffectiveSandbox,
              runDirectLlm: async () => {
                markWorkerStarted();
                await workerReleased;
                throw new Error('explicit worker fixture finished');
              },
            }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
        },
      });
      return routeExecution;
    });

    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        status: 'running',
        taskCheckoutMode: 'worktree',
        maxParallelWorktrees: 1,
      },
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );

    try {
      const response = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );

      expect(response.status).toBe(202);
      await workerStarted;
      expect(await getActiveRunForTask(task.id)).toMatchObject({
        task_id: task.id,
        status: 'running',
        triggerSource: 'user',
        triggeredByUserId: 'test-admin',
      });
    } finally {
      releaseWorker();
      occupiedAutomaticSlot.release();
      await routeExecution;
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('queues unsupported steering before Testing format repair', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    let releaseWorker!: () => void;
    let markWorkerStarted!: () => void;
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    let releasePostProcessing!: () => void;
    let markPostProcessingStarted!: () => void;
    const postProcessingReleased = new Promise<void>((resolve) => {
      releasePostProcessing = resolve;
    });
    const postProcessingStarted = new Promise<void>((resolve) => {
      markPostProcessingStarted = resolve;
    });
    let routeExecution: Promise<void> | undefined;
    let agentCalls = 0;
    _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
      routeExecution = executeTaskPipeline(task, group, {
        ...(options ?? {}),
        testDependencies: {
          runContainerAgent: (runGroup, input, onChunk) =>
            runContainerAgent(runGroup, input, onChunk, {
              resolveEffectiveSandbox,
              runDirectLlm: async () => {
                agentCalls += 1;
                markWorkerStarted();
                await workerReleased;
                return {
                  result: 'testing verdict missing its JSON envelope',
                  model_name: 'test-model',
                };
              },
            }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
          afterSuccessfulAgentRun: async () => {
            markPostProcessingStarted();
            await postProcessingReleased;
          },
        },
      });
      return routeExecution;
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    try {
      const executeResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );
      expect(executeResponse.status).toBe(202);
      await workerStarted;
      releaseWorker();
      await postProcessingStarted;
      const messageResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'queue during completion' },
      );
      expect(messageResponse.status).toBe(200);
      const messageBody = (await messageResponse.json()) as {
        delivery: string;
      };
      expect(messageBody.delivery).toBe('queued');
      releasePostProcessing();
      await routeExecution;
      const messages = readTaskMessages(PROJ, task.id);
      expect(
        messages.filter(
          (message) => message.content === 'queue during completion',
        ),
      ).toHaveLength(1);
      expect(messages.filter((message) => message.steering)).toHaveLength(1);
      expect(
        messages.some((message) => message.entry_type === 'steering_delivery'),
      ).toBe(false);
      expect(agentCalls).toBe(1);
      expect((await getTask(task.id))?.status).toBe('testing');
    } finally {
      releaseWorker();
      releasePostProcessing();
      await routeExecution?.catch(() => undefined);
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
  test('steers a concurrently executing task through the production message route', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    let releaseWorker!: () => void;
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let markWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    let routeExecution: Promise<void> | undefined;
    let runDir: string | undefined;
    _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
      routeExecution = executeTaskPipeline(task, group, {
        ...(options ?? {}),
        testDependencies: {
          runContainerAgent: (runGroup, input, onChunk) =>
            runContainerAgent(runGroup, input, onChunk, {
              resolveEffectiveSandbox,
              runDirectLlm: async () => {
                const activeRun = await getActiveRunForTask(task.id);
                expect(activeRun).toBeTruthy();
                runDir = path.join(
                  DATA_DIR,
                  'ipc',
                  `carapa-bot-${activeRun!.sandbox_instance}`,
                  'runs',
                  activeRun!.id,
                );
                fs.mkdirSync(runDir, { recursive: true });
                fs.writeFileSync(
                  path.join(runDir, 'agent-control.json'),
                  JSON.stringify({ version: 1, harness: 'codex' }),
                );
                markWorkerStarted();
                await workerReleased;
                return {
                  result: 'finished after steering',
                  model_name: 'test',
                };
              },
            }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
        },
      });
      return routeExecution;
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );

    try {
      const executeResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );
      expect(executeResponse.status).toBe(202);
      await workerStarted;

      const controlRequest = nextControlRequest(runDir!);
      const messageResponsePromise = apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'apply this to the current run' },
      );
      const requestFile = await controlRequest;
      const responseDir = path.join(runDir!, 'control-responses');
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(
        path.join(responseDir, requestFile!),
        JSON.stringify({ ok: true }),
      );

      const messageResponse = await messageResponsePromise;
      expect(messageResponse.status).toBe(200);
      const delivered = (await messageResponse.json()) as {
        id: string;
        delivery: string;
        run_id: string | null;
      };
      expect(delivered.delivery).toBe('steered');
      expect(delivered.run_id).toBe((await getActiveRunForTask(task.id))!.id);
      releaseWorker();
      await routeExecution;

      const messages = readTaskMessages(PROJ, task.id);
      expect(
        messages.filter(
          (message) => message.content === 'apply this to the current run',
        ),
      ).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === delivered.id &&
            message.run_id === delivered.run_id,
        ),
      ).toHaveLength(1);
      expect((await getTask(task.id))?.status).toBe('testing');
    } finally {
      releaseWorker();
      await routeExecution?.catch(() => undefined);
      if (runDir) {
        fs.rmSync(path.dirname(path.dirname(runDir)), {
          recursive: true,
          force: true,
        });
      }
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
  test('queues a message submitted during Testing format repair before verdict effects', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    let releaseRepair!: () => void;
    const repairReleased = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    let markRepairStarted!: () => void;
    const repairStarted = new Promise<void>((resolve) => {
      markRepairStarted = resolve;
    });
    let routeExecution: Promise<void> | undefined;
    let agentCalls = 0;
    const identity = '1234567890abcdef1234567890abcdef12345678';
    _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
      routeExecution = executeTaskPipeline(task, group, {
        ...(options ?? {}),
        testDependencies: {
          runContainerAgent: (runGroup, input, onChunk) =>
            runContainerAgent(runGroup, input, onChunk, {
              resolveEffectiveSandbox,
              runDirectLlm: async () => {
                agentCalls += 1;
                if (agentCalls === 1) {
                  return {
                    result: 'testing verdict missing its JSON envelope',
                    model_name: 'test-model',
                  };
                }
                markRepairStarted();
                await repairReleased;
                return {
                  result: '{"decision":"pass","issues":[],"summary":"green"}',
                  model_name: 'test-model',
                };
              },
            }),
          prepareTaskBranchForReview: async () => {},
          readTaskGitContentIdentity: async () => ({
            headSha: identity,
            treeSha: identity,
          }),
          runGitInRepo: async () => ({ ok: true, output: identity }),
          inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
        },
      });
      return routeExecution;
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );

    try {
      const executeResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );
      expect(executeResponse.status).toBe(202);
      await repairStarted;

      const taskListResponse = await apiGet(`/projects/${PROJ}/tasks`);
      const taskList = (await taskListResponse.json()) as Array<{
        id: string;
        running: boolean;
      }>;
      expect(
        taskList.find((candidate) => candidate.id === task.id)?.running,
      ).toBe(true);

      const messageResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'inspect this before accepting the repaired verdict' },
      );
      expect(messageResponse.status).toBe(200);
      expect(await messageResponse.json()).toMatchObject({
        content: 'inspect this before accepting the repaired verdict',
        steering: true,
        delivery: 'queued',
      });

      releaseRepair();
      await routeExecution;

      expect(agentCalls).toBe(2);
      expect(await getRunsForTask(task.id)).toHaveLength(2);
      expect((await getTask(task.id))?.status).toBe('testing');
      const messages = readTaskMessages(PROJ, task.id);
      expect(
        messages.filter(
          (message) =>
            message.content ===
            'inspect this before accepting the repaired verdict',
        ),
      ).toHaveLength(1);
      expect(
        messages.some(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id ===
              messages.find(
                (candidate) =>
                  candidate.content ===
                  'inspect this before accepting the repaired verdict',
              )?.id,
        ),
      ).toBe(false);
    } finally {
      releaseRepair();
      await routeExecution?.catch(() => undefined);
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
  for (const scenario of [
    {
      name: 'Testing verdict',
      stage: 'testing',
      output: '{"decision":"pass","issues":[],"summary":"green"}',
    },
    {
      name: 'Review verdict',
      stage: 'review',
      output:
        '{"decision":"approve","score":10,"issues":[],"summary":"approved"}',
    },
    {
      name: 'done-stage handoff',
      stage: 'in_progress',
      output: 'handoff finished',
      handoff: true,
    },
    {
      name: 'automatic deploy transition',
      stage: 'in_progress',
      output: 'ready to deploy',
      deploy: true,
    },
  ] as const) {
    test(`holds the starting stage when a concurrent POST reaches ${scenario.name}`, async () => {
      const originalSettings = getGroupByFolder(PROJ)?.settings;
      if (scenario.deploy) {
        await updateGroup(PROJ_JID, {
          settings: {
            ...originalSettings,
            status: 'running',
            deployService: 'test-service',
            deployStage: 'completed',
          },
        });
      }
      const identity = '1234567890abcdef1234567890abcdef12345678';
      let markFinalizing!: () => void;
      const finalizing = new Promise<void>((resolve) => {
        markFinalizing = resolve;
      });
      let releaseFinalizing!: () => void;
      const finalizingReleased = new Promise<void>((resolve) => {
        releaseFinalizing = resolve;
      });
      let routeExecution: Promise<void> | undefined;
      _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
        routeExecution = executeTaskPipeline(task, group, {
          ...(options ?? {}),
          testDependencies: {
            runContainerAgent: (runGroup, input, onChunk) =>
              runContainerAgent(runGroup, input, onChunk, {
                resolveEffectiveSandbox,
                runDirectLlm: async () => {
                  if (scenario.handoff) {
                    await updateTask(task.id, { status: 'completed' });
                    expect(
                      requestTaskStageHandoff(
                        task.id,
                        'in_progress',
                        'completed',
                      ),
                    ).toBe(true);
                  }
                  return { result: scenario.output, model_name: 'test-model' };
                },
              }),
            prepareTaskBranchForReview: async () => {},
            readTaskGitContentIdentity: async () => ({
              headSha: identity,
              treeSha: identity,
            }),
            runGitInRepo: async (_group, command) => ({
              ok: true,
              output: command.includes('rev-parse HEAD HEAD^{tree}')
                ? `${identity}\n${identity}`
                : command.includes('rev-parse') ||
                    command.includes('merge-base')
                  ? identity
                  : '',
            }),
            inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
            mergeBranchForDeploy: async () => true,
            runPostExecutionGitOps: async () => {},
            drainProjectQueue: async () => {},
            afterSuccessfulAgentRun: async () => {
              markFinalizing();
              await finalizingReleased;
            },
          },
        });
        return routeExecution;
      });
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          status: scenario.stage,
          custom_values:
            scenario.stage === 'review'
              ? {
                  [TESTING_HEAD_SHA_KEY]: identity,
                  [TESTING_TREE_SHA_KEY]: identity,
                }
              : undefined,
          skip_stages: scenario.deploy ? ['testing', 'review'] : undefined,
        }),
      );

      try {
        const executeResponse = await apiPost(
          `/projects/${PROJ}/tasks/${task.id}/execute`,
          {},
        );
        expect(executeResponse.status).toBe(202);
        await finalizing;

        const messageResponse = await apiPost(
          `/projects/${PROJ}/tasks/${task.id}/messages`,
          { content: `hold ${scenario.name}` },
        );
        expect(messageResponse.status).toBe(200);
        expect(await messageResponse.json()).toMatchObject({
          content: `hold ${scenario.name}`,
          delivery: 'queued',
        });
        releaseFinalizing();
        await routeExecution;

        expect((await getTask(task.id))?.status).toBe(scenario.stage);
        expect(await getRunsForTask(task.id)).toHaveLength(1);
        expect(
          readTaskMessages(PROJ, task.id).filter(
            (message) => message.content === `hold ${scenario.name}`,
          ),
        ).toHaveLength(1);
      } finally {
        releaseFinalizing();
        await routeExecution?.catch(() => undefined);
        _testOnlySetExplicitExecuteTaskRunner(null);
        await updateGroup(PROJ_JID, { settings: originalSettings });
      }
    });
  }
  test('does not rewind after the completion cutoff closes claim presentation', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let routeExecution: Promise<void> | undefined;
    _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
      routeExecution = executeTaskPipeline(task, group, {
        ...(options ?? {}),
        testDependencies: {
          runContainerAgent: async (_runGroup, input) => {
            await input.onSlotAcquired?.(`post-cutoff-${task.id}`);
            return {
              status: 'success',
              result: 'implementation completed',
              newSessionId: `post-cutoff-session-${task.id}`,
            };
          },
          runPostExecutionGitOps: async () => {
            markCleanupStarted();
            await cleanupReleased;
          },
          drainProjectQueue: async () => {},
        },
      });
      return routeExecution;
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );

    try {
      const executeResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );
      expect(executeResponse.status).toBe(202);
      await cleanupStarted;
      expect((await getTask(task.id))?.status).toBe('testing');
      const taskListResponse = await apiGet(`/projects/${PROJ}/tasks`);
      const taskList = (await taskListResponse.json()) as Array<{
        id: string;
        running: boolean;
      }>;
      expect(
        taskList.find((candidate) => candidate.id === task.id)?.running,
      ).toBe(false);

      const messageResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'follow up after the completion cutoff' },
      );
      expect(messageResponse.status).toBe(200);
      const messageBody = (await messageResponse.json()) as Record<
        string,
        unknown
      >;
      expect(messageBody).toEqual(
        expect.objectContaining({
          role: 'user',
          content: 'follow up after the completion cutoff',
        }),
      );
      expect(messageBody.steering).toBeUndefined();
      expect(messageBody.delivery).toBeUndefined();
      releaseCleanup();
      await routeExecution;
      expect((await getTask(task.id))?.status).toBe('testing');
      const followUps = readTaskMessages(PROJ, task.id).filter(
        (message) =>
          message.content === 'follow up after the completion cutoff',
      );
      expect(followUps).toHaveLength(1);
      expect(followUps[0]?.steering).toBeUndefined();
    } finally {
      releaseCleanup();
      await routeExecution?.catch(() => undefined);
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
  test('starts the current Review stage explicitly while the project is paused', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    const testedHead = '0123456789abcdef0123456789abcdef01234567';
    const testedTree = '89abcdef0123456789abcdef0123456789abcdef';
    let releaseReviewWorker!: () => void;
    const reviewWorkerReleased = new Promise<void>((resolve) => {
      releaseReviewWorker = resolve;
    });
    let markReviewWorkerStarted!: (stageId: string | undefined) => void;
    const reviewWorkerStarted = new Promise<string | undefined>((resolve) => {
      markReviewWorkerStarted = resolve;
    });
    let routeExecution: Promise<void> | undefined;
    _testOnlySetExplicitExecuteTaskRunner((task, group, options) => {
      routeExecution = executeTaskPipeline(task, group, {
        ...(options ?? {}),
        testDependencies: {
          runContainerAgent: (runGroup, input, onChunk) =>
            runContainerAgent(runGroup, input, onChunk, {
              resolveEffectiveSandbox,
              runDirectLlm: async () => {
                markReviewWorkerStarted(input.stage_id);
                await reviewWorkerReleased;
                throw new Error('route Review worker fixture finished');
              },
            }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
        },
      });
      return routeExecution;
    });
    sandboxGitHandler = async (command) => {
      if (command.includes('branch --show-current')) {
        return { stdout: 'develop', isError: false };
      }
      if (command.includes('status --porcelain')) {
        return { stdout: '', isError: false };
      }
      if (command.includes('rev-parse HEAD HEAD^{tree}')) {
        return { stdout: `${testedHead}\n${testedTree}`, isError: false };
      }
      return {
        stdout: command.includes('rev-list --count') ? '0' : testedHead,
        isError: false,
      };
    };

    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        status: 'paused',
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
        defaultBranch: 'develop',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'review',
        branch_name: 'paused-explicit-review',
        worktree_path: '/host/repo/.worktrees/paused-explicit-review',
        custom_values: { [TESTING_HEAD_SHA_KEY]: testedHead },
      }),
    );

    try {
      const response = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        message: 'Execution started',
        task_id: task.id,
      });

      expect(
        await Promise.race([
          reviewWorkerStarted,
          routeExecution!.then(async () => {
            const finishedTask = await getTask(task.id);
            throw new Error(
              `Review execution ended before its worker started: ${finishedTask?.error || finishedTask?.status}`,
            );
          }),
        ]),
      ).toBe('review');
      const reviewRun = await getActiveRunForTask(task.id);

      expect(reviewRun).toMatchObject({
        task_id: task.id,
        stage: 'review',
        status: 'running',
        triggerSource: 'user',
        triggeredByUserId: 'test-admin',
      });
      expect((await getTask(task.id))?.status).toBe('review');
      expect(getGroupByFolder(PROJ)?.settings?.status).toBe('paused');
      expect((await getRunsForTask(task.id))[0]?.stage).toBe('review');
    } finally {
      releaseReviewWorker();
      await routeExecution;
      _testOnlySetExplicitExecuteTaskRunner(null);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
});

// ─── DELETE /api/projects/:pid/tasks/:fid ─────────────────────────────────────

describe('DELETE /api/projects/:pid/tasks/:fid', () => {
  test('deletes the task and returns 200', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const res = await apiDelete(`/projects/${PROJ}/tasks/${task.id}`);
    expect(res.status).toBe(200);
    // task is gone
    const getRes = await apiGet(`/projects/${PROJ}/tasks/${task.id}`);
    expect(getRes.status).toBe(404);
  });

  test('drains only when deleting a task that a sibling depends on', async () => {
    const dependency = await createTask(taskFixture({ project_id: PROJ }));
    const dependent = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'backlog',
        depends_on_ids: [dependency.id],
      }),
    );
    const standalone = await createTask(taskFixture({ project_id: PROJ }));
    const drains: string[] = [];
    _testOnlySetTaskQueueDrainRunner(async (projectId) => {
      drains.push(projectId);
    });
    try {
      expect(
        (await apiDelete(`/projects/${PROJ}/tasks/${standalone.id}`)).status,
      ).toBe(200);
      expect(drains).toEqual([]);

      expect(
        (await apiDelete(`/projects/${PROJ}/tasks/${dependency.id}`)).status,
      ).toBe(200);
      expect(drains).toEqual([PROJ]);
      expect((await getTask(dependent.id))?.depends_on_ids).toEqual([]);
    } finally {
      _testOnlySetTaskQueueDrainRunner(null);
    }
  });

  test('leaves a task unarchived after a worktree conflict so archive retry removes it', async () => {
    const originalSettings = { ...getGroupByFolder(PROJ)!.settings };
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, branch_name: 'busy-task-worktree' }),
    );
    const conversation = await createConversation(PROJ, {
      use_worktree: true,
      branch_name: 'busy-task-worktree',
    });
    const ownerId = `busy-delete-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);

    try {
      const res = await apiDelete(`/projects/${PROJ}/tasks/${task.id}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Wait for the active conversation runs to finish first',
        conversationIds: [conversation.id],
      });
      expect(await getTask(task.id)).toBeDefined();
      expect(await getConversation(conversation.id)).toMatchObject({
        use_worktree: 1,
        branch_name: 'busy-task-worktree',
      });

      const archiveRes = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        archived: true,
      });
      expect(archiveRes.status).toBe(409);
      expect(await archiveRes.json()).toEqual({
        error: 'Wait for the active conversation runs to finish first',
        conversationIds: [conversation.id],
      });
      expect((await getTask(task.id))?.archived).toBe(false);
      expect(sandboxWorktreeCalls).toHaveLength(0);

      await releaseConversationExecutionLease(conversation.id, ownerId);
      const retryRes = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        archived: true,
      });
      expect(retryRes.status).toBe(200);
      expect((await getTask(task.id))?.archived).toBe(true);
      expect(sandboxWorktreeCalls).toEqual([
        { action: 'remove', branch: 'busy-task-worktree' },
      ]);
    } finally {
      await releaseConversationExecutionLease(conversation.id, ownerId);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
});

describe('agent-credential task transitions', () => {
  const TESTING_READ_ONLY = /Testing-stage tasks are read-only for agents/;

  test('PATCH by agent credential cannot move a review task into done (403, no merge)', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'review',
        branch_name: 'task/agent-bypass',
        worktree_path: '/host/repo/.worktrees/task/agent-bypass',
      }),
    );
    const mergeCalls: string[] = [];
    sandboxBranchHandler = async (action) => {
      if (action === 'merge') mergeCalls.push(action);
      return {
        stdout: JSON.stringify({ merged: true, pushed: false }),
        isError: false,
      };
    };

    try {
      const res = await apiAgentPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'completed',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain(
        'Agents cannot move tasks into done stage "completed"',
      );
      expect(mergeCalls).toEqual([]);
      const after = await getTask(task.id);
      expect(after?.status).toBe('review');
      expect(after?.branch_name).toBe('task/agent-bypass');
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('PATCH by agent credential may move completed -> deploy', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        stages: [
          ...(originalSettings?.stages ?? []),
          { id: 'deploy', title: 'Deploy', type: 'done', color: '#0aa' },
        ],
      },
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'completed' }),
    );
    try {
      const res = await apiAgentPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'deploy',
      });
      expect(res.status).toBe(200);
      expect((await getTask(task.id))?.status).toBe('deploy');
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('PATCH by agent credential into review without stored Testing evidence returns 403', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );
    const path = `/projects/${PROJ}/tasks/${task.id}`;
    const res = await apiAgentPatch(path, { status: 'review' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(
      'Agents cannot move this task into review stage "review"',
    );
    expect((await getTask(task.id))?.status).toBe('in_progress');

    const bulk = await apiAgentPatch(`/projects/${PROJ}/tasks/bulk`, {
      ids: [task.id],
      status: 'review',
    });
    expect(bulk.status).toBe(403);
    expect(((await bulk.json()) as { error: string }).error).toContain(
      'Agents cannot move this task into review stage "review"',
    );
    expect((await getTask(task.id))?.status).toBe('in_progress');
  });

  test('agent credential cannot add review/testing to skip_stages on PATCH or POST; users can', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );
    const path = `/projects/${PROJ}/tasks/${task.id}`;
    const denied = await apiAgentPatch(path, {
      skip_stages: ['testing', 'review'],
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain(
      'Agents cannot skip review or testing stages (testing, review)',
    );
    expect((await getTask(task.id))?.skip_stages ?? null).toBeNull();

    const createDenied = await fetch(`${baseUrl}/projects/${PROJ}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-agent-credential': '1',
      },
      body: JSON.stringify({ title: 'Sneaky', skip_stages: ['testing'] }),
    });
    expect(createDenied.status).toBe(403);

    // Non-gated additions, unchanged lists, and clearing stay allowed.
    expect(
      (await apiAgentPatch(path, { skip_stages: ['in_progress'] })).status,
    ).toBe(200);

    const userPatch = await apiPatch(path, {
      skip_stages: ['testing', 'review'],
    });
    expect(userPatch.status).toBe(200);
    expect((await getTask(task.id))?.skip_stages).toEqual([
      'testing',
      'review',
    ]);
    expect(
      (await apiAgentPatch(path, { skip_stages: ['testing', 'review'] }))
        .status,
    ).toBe(200);
    expect((await apiAgentPatch(path, { skip_stages: null })).status).toBe(200);

    const userCreate = await apiPost(`/projects/${PROJ}/tasks`, {
      title: 'Deploy card',
      skip_stages: ['testing', 'review'],
    });
    expect(userCreate.status).toBe(201);
  });

  test('PATCH by agent credential on a testing-stage task is rejected', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing', title: 'Original' }),
    );
    const res = await apiAgentPatch(`/projects/${PROJ}/tasks/${task.id}`, {
      title: 'Renamed',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      TESTING_READ_ONLY,
    );
    expect((await getTask(task.id))?.title).toBe('Original');
  });

  test('bulk PATCH by agent credential skips done-entry and testing tasks', async () => {
    const reviewTask = await createTask(
      taskFixture({ project_id: PROJ, status: 'review' }),
    );
    const testingTask = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    const doneTask = await createTask(
      taskFixture({ project_id: PROJ, status: 'completed' }),
    );

    const res = await apiAgentPatch(`/projects/${PROJ}/tasks/bulk`, {
      ids: [reviewTask.id, testingTask.id, doneTask.id],
      status: 'completed',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mergeFailures: Array<{ task_id: string; error: string }>;
    };
    expect(body.mergeFailures.map((f) => f.task_id).sort()).toEqual(
      [reviewTask.id, testingTask.id].sort(),
    );
    expect((await getTask(reviewTask.id))?.status).toBe('review');
    expect((await getTask(testingTask.id))?.status).toBe('testing');
    expect((await getTask(doneTask.id))?.status).toBe('completed');
  });

  test('agent credential cannot delete, stop or execute testing tasks over HTTP', async () => {
    const agentPost = (path: string, body: unknown = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-agent-credential': '1',
        },
        body: JSON.stringify(body),
      });
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    await appendTaskMessageAsync(PROJ, {
      task_id: task.id,
      role: 'system',
      content: 'keep me',
      entry_type: 'system_notice',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const statusBefore = getGroupByFolder(PROJ)?.settings?.status;

    const base = `/projects/${PROJ}`;
    const denied = [
      await fetch(`${baseUrl}${base}/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { 'x-test-agent-credential': '1' },
      }),
      await agentPost(`${base}/tasks/bulk-stop`, { ids: [task.id] }),
      await agentPost(`${base}/tasks/${task.id}/stop`),
      await agentPost(`${base}/stop`),
    ];
    for (const res of denied) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        'Agents cannot delete or stop tasks via HTTP',
      );
    }
    expect((await getTask(task.id))?.status).toBe('testing');
    expect(readTaskMessages(PROJ, task.id).length).toBeGreaterThan(0);
    expect(getGroupByFolder(PROJ)?.settings?.status).toBe(statusBefore);

    exposeRegisteredRouteGroup = true;
    try {
      const single = await agentPost(`${base}/tasks/${task.id}/execute`);
      expect(single.status).toBe(403);
      expect(((await single.json()) as { error: string }).error).toMatch(
        TESTING_READ_ONLY,
      );
      const bulk = await agentPost(`${base}/tasks/bulk-execute`, {
        ids: [task.id],
      });
      expect(bulk.status).toBe(200);
      expect(await bulk.json()).toMatchObject({
        startedCount: 0,
        denied: [{ task_id: task.id }],
      });
    } finally {
      exposeRegisteredRouteGroup = false;
    }
  });

  test('PATCH into done answers 409 when the checkout lease stays held, and never merges afterwards', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'review',
        branch_name: 'task/busy-lease',
        worktree_path: '/host/repo/.worktrees/task/busy-lease',
      }),
    );
    const mergeCalls: string[] = [];
    sandboxBranchHandler = async (action) => {
      if (action === 'merge') mergeCalls.push(action);
      return {
        stdout: JSON.stringify({ merged: true, pushed: false }),
        isError: false,
      };
    };
    _testOnlySetManualCompletionMaxWaitMs(200);
    // The incident's shape: the card's own task holds the lease.
    const held = await acquireSharedCheckoutLease(PROJ, {
      type: 'task',
      id: task.id,
    });
    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'completed',
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        `Checkout is busy: shared-checkout lease is held by task ${task.id}. Try again later.`,
      );
      expect((await getTask(task.id))?.status).toBe('review');
      await held.release();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(mergeCalls).toEqual([]);
      expect((await getTask(task.id))?.status).toBe('review');
    } finally {
      await held.release();
      _testOnlySetManualCompletionMaxWaitMs();
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('PATCH into done reserves the card while it waits for the checkout lease', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'review',
        branch_name: 'task/reserved-wait',
        worktree_path: '/host/repo/.worktrees/task/reserved-wait',
      }),
    );
    sandboxBranchHandler = async () => ({
      stdout: JSON.stringify({ merged: true, pushed: false }),
      isError: false,
    });
    _testOnlySetManualCompletionMaxWaitMs(5000);
    const held = await acquireSharedCheckoutLease(PROJ, {
      type: 'task',
      id: task.id,
    });
    try {
      const pending = apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'completed',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(_testOnlyTryClaimTaskExecution(task.id, PROJ)).toBeNull();
      await held.release();
      const res = await pending;
      if (res.status !== 200) throw new Error(await res.text());
      expect((await getTask(task.id))?.status).toBe('completed');
      const claim = _testOnlyTryClaimTaskExecution(task.id, PROJ);
      expect(claim).not.toBeNull();
      if (claim) releaseTaskExecutionClaim(task.id, claim);
    } finally {
      await held.release();
      _testOnlySetManualCompletionMaxWaitMs();
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('user session PATCH into done still merges', async () => {
    const originalSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'review',
        branch_name: 'task/user-merge',
        worktree_path: '/host/repo/.worktrees/task/user-merge',
      }),
    );
    const mergeCalls: string[] = [];
    sandboxBranchHandler = async (action) => {
      if (action === 'merge') mergeCalls.push(action);
      return {
        stdout: JSON.stringify({ merged: true, pushed: false }),
        isError: false,
      };
    };
    try {
      const res = await apiPatch(`/projects/${PROJ}/tasks/${task.id}`, {
        status: 'completed',
      });
      if (res.status !== 200) throw new Error(await res.text());
      expect((await getTask(task.id))?.status).toBe('completed');
      expect(mergeCalls.length).toBeGreaterThan(0);
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });
});

describe('PATCH /api/projects/:pid/tasks/bulk', () => {
  test('drains the queue once when a bulk move enters a done stage', async () => {
    const first = await createTask(
      taskFixture({ project_id: PROJ, status: 'review' }),
    );
    const second = await createTask(
      taskFixture({ project_id: PROJ, status: 'review' }),
    );
    const drains: string[] = [];
    _testOnlySetTaskQueueDrainRunner(async (projectId) => {
      drains.push(projectId);
    });
    try {
      expect(
        (
          await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
            ids: [first.id, second.id],
            status: 'backlog',
          })
        ).status,
      ).toBe(200);
      expect(drains).toEqual([]);

      const res = await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
        ids: [first.id, second.id],
        status: 'completed',
      });
      expect(res.status).toBe(200);
      expect(drains).toEqual([PROJ]);
    } finally {
      _testOnlySetTaskQueueDrainRunner(null);
    }
  });

  test('does not push the owner when a bulk update moves a task into the question stage', async () => {
    const owner = await createUser('test-admin', 'pw', 'admin');
    await upsertProjectMember(owner.id, PROJ, 'owner');
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'backlog',
        ownerUserId: owner.id,
        lastTriggeredByUserId: owner.id,
        lastTriggerSource: 'user',
      }),
    );
    const update = (status: string) =>
      apiPatch(`/projects/${PROJ}/tasks/bulk`, {
        ids: [task.id],
        status,
      });

    expect((await update('question')).status).toBe(200);
    expect((await update('backlog')).status).toBe(200);
    expect((await update('question')).status).toBe(200);

    expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
  });

  test('resets testing failures when dragging a question card to in progress', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'question',
        custom_values: { testing_failure_count: 6, owner: 'alice' },
      }),
    );
    await insertActiveRun(runFixture({ group_folder: PROJ, task_id: task.id }));

    const res = await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
      ids: [task.id],
      status: 'in_progress',
    });

    expect(res.status).toBe(200);
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.custom_values).toEqual({
      testing_failure_count: 0,
      owner: 'alice',
    });
  });

  test('notifies only other owners for each task in a mixed bulk completion', async () => {
    const mover = await createUser('bulk-mixed-mover', 'pw', 'user');
    const firstOwner = await createUser('bulk-mixed-owner-one', 'pw', 'user');
    const secondOwner = await createUser('bulk-mixed-owner-two', 'pw', 'user');
    for (const member of [mover, firstOwner, secondOwner]) {
      await upsertProjectMember(member.id, PROJ, 'editor');
    }
    const ownTask = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Bulk own task',
        status: 'backlog',
        ownerUserId: mover.id,
        lastTriggeredByUserId: firstOwner.id,
        lastTriggerSource: 'user',
      }),
    );
    const firstOtherTask = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Bulk first other task',
        status: 'backlog',
        ownerUserId: firstOwner.id,
        lastTriggeredByUserId: mover.id,
        lastTriggerSource: 'user',
      }),
    );
    const secondOtherTask = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Bulk second other task',
        status: 'backlog',
        ownerUserId: secondOwner.id,
        lastTriggeredByUserId: mover.id,
        lastTriggerSource: 'user',
      }),
    );
    const unownedTask = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Bulk unowned task',
        status: 'backlog',
        ownerUserId: null,
        lastTriggeredByUserId: firstOwner.id,
        lastTriggerSource: 'user',
      }),
    );
    const tasks = [ownTask, firstOtherTask, secondOtherTask, unownedTask];

    const res = await apiPatch(
      `/projects/${PROJ}/tasks/bulk`,
      { ids: tasks.map((task) => task.id), status: 'completed' },
      mover.id,
    );

    expect(res.status).toBe(200);
    for (const task of tasks) {
      expect(await getTask(task.id)).toMatchObject({
        status: 'completed',
        completed_at: expect.any(String),
      });
    }
    expect(await getUnreadPayloads(mover.id)).toHaveLength(0);
    expect(await getUnreadPayloads(firstOwner.id)).toEqual([
      expect.objectContaining({
        summary: 'Task completed: Bulk first other task',
      }),
    ]);
    expect(await getUnreadPayloads(secondOwner.id)).toEqual([
      expect.objectContaining({
        summary: 'Task completed: Bulk second other task',
      }),
    ]);
  });

  test('archives and restores multiple tasks in one bulk action', async () => {
    const first = await createTask(taskFixture({ project_id: PROJ }));
    const second = await createTask(taskFixture({ project_id: PROJ }));
    const otherProject = await createTask(
      taskFixture({ project_id: 'other-project' }),
    );

    const archiveRes = await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
      ids: [first.id, second.id, otherProject.id],
      archived: true,
    });

    expect(archiveRes.status).toBe(200);
    expect((await getTask(first.id))?.archived).toBe(true);
    expect((await getTask(second.id))?.archived).toBe(true);
    expect((await getTask(otherProject.id))?.archived).toBe(false);

    const restoreRes = await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
      ids: [first.id, second.id],
      archived: false,
    });

    expect(restoreRes.status).toBe(200);
    expect((await getTask(first.id))?.archived).toBe(false);
    expect((await getTask(second.id))?.archived).toBe(false);
  });

  test('refuses to archive a running task and archives the others', async () => {
    const originalSettings = { ...getGroupByFolder(PROJ)!.settings };
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    try {
      const running = await createTask(
        taskFixture({ project_id: PROJ, branch_name: 'running-worktree' }),
      );
      const idle = await createTask(
        taskFixture({ project_id: PROJ, branch_name: 'idle-worktree' }),
      );
      await insertActiveRun(
        runFixture({ group_folder: PROJ, task_id: running.id }),
      );
      const error = 'Task is running; stop it before archiving';

      const single = await apiPatch(`/projects/${PROJ}/tasks/${running.id}`, {
        archived: true,
      });
      expect(single.status).toBe(409);
      expect(await single.json()).toEqual({ error });
      expect((await getTask(running.id))?.archived).toBe(false);
      expect(sandboxWorktreeCalls).toHaveLength(0);

      const bulk = await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
        ids: [running.id, idle.id],
        archived: true,
      });
      expect(bulk.status).toBe(200);
      expect(await bulk.json()).toEqual({
        ok: true,
        mergeFailures: [{ task_id: running.id, error }],
      });
      expect((await getTask(running.id))?.archived).toBe(false);
      expect((await getTask(idle.id))?.archived).toBe(true);
      expect(sandboxWorktreeCalls).toEqual([
        { action: 'remove', branch: 'idle-worktree' },
      ]);
    } finally {
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('leaves a conflicted bulk archive task unarchived and retries cleanup', async () => {
    const originalSettings = { ...getGroupByFolder(PROJ)!.settings };
    await updateGroup(PROJ_JID, {
      settings: {
        ...originalSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/repo',
      },
    });
    const task = await createTask(
      taskFixture({ project_id: PROJ, branch_name: 'busy-bulk-worktree' }),
    );
    const conversation = await createConversation(PROJ, {
      use_worktree: true,
      branch_name: 'busy-bulk-worktree',
    });
    const ownerId = `busy-bulk-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);

    try {
      const archive = () =>
        apiPatch(`/projects/${PROJ}/tasks/bulk`, {
          ids: [task.id],
          archived: true,
        });
      const conflictRes = await archive();
      expect(conflictRes.status).toBe(409);
      expect(await conflictRes.json()).toEqual({
        error: 'Wait for the active conversation runs to finish first',
        conversationIds: [conversation.id],
      });
      expect((await getTask(task.id))?.archived).toBe(false);
      expect(sandboxWorktreeCalls).toHaveLength(0);

      await releaseConversationExecutionLease(conversation.id, ownerId);
      const retryRes = await archive();
      expect(retryRes.status).toBe(200);
      expect((await getTask(task.id))?.archived).toBe(true);
      expect(sandboxWorktreeCalls).toEqual([
        { action: 'remove', branch: 'busy-bulk-worktree' },
      ]);
    } finally {
      await releaseConversationExecutionLease(conversation.id, ownerId);
      await updateGroup(PROJ_JID, { settings: originalSettings });
    }
  });

  test('stops a running task but keeps review when advancing it to review', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );
    await insertActiveRun(
      runFixture({
        group_folder: PROJ,
        task_id: task.id,
        stage: 'in_progress',
      }),
    );

    const res = await apiPatch(`/projects/${PROJ}/tasks/bulk`, {
      ids: [task.id],
      status: 'review',
    });

    expect(res.status).toBe(200);
    expect((await getTask(task.id))?.status).toBe('review');
    expect(await getActiveRunForTask(task.id)).toBeUndefined();
  });
});

// ─── PUT /api/projects/:pid/tasks/:fid/stage-comments/:stageId ────────────────

describe('PUT /api/projects/:pid/tasks/:fid/stage-comments/:stageId', () => {
  test('edits an existing persistent stage note', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await setTaskStageComment(task.id, 'in_progress', 'Original note', 'run-1');

    const res = await apiPut(
      `/projects/${PROJ}/tasks/${task.id}/stage-comments/in_progress`,
      { content: '  Updated note  ' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stageId: 'in_progress',
      content: 'Updated note',
      runId: null,
    });
    expect((await getTaskStageComment(task.id, 'in_progress'))?.content).toBe(
      'Updated note',
    );
  });

  test('clears an existing persistent stage note when content is empty', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await setTaskStageComment(task.id, 'in_progress', 'Remove me', null);

    const res = await apiPut(
      `/projects/${PROJ}/tasks/${task.id}/stage-comments/in_progress`,
      { content: '   ' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(await getTaskStageComment(task.id, 'in_progress')).toBeUndefined();
  });

  test('rejects a non-executable stage when creating a note', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));

    const res = await apiPut(
      `/projects/${PROJ}/tasks/${task.id}/stage-comments/backlog`,
      { content: 'Not allowed' },
    );

    expect(res.status).toBe(400);
    expect(await getTaskStageComment(task.id, 'backlog')).toBeUndefined();
  });

  test('creates notes for configured testing and review stages', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));

    for (const stage of ['testing', 'review']) {
      const res = await apiPut(
        `/projects/${PROJ}/tasks/${task.id}/stage-comments/${stage}`,
        { content: `${stage} note` },
      );
      expect(res.status).toBe(200);
      expect((await getTaskStageComment(task.id, stage))?.content).toBe(
        `${stage} note`,
      );
    }
  });

  test('rejects a missing task and a task belonging to another project', async () => {
    const missing = await apiPut(
      `/projects/${PROJ}/tasks/missing-task/stage-comments/in_progress`,
      { content: 'note' },
    );
    expect(missing.status).toBe(404);

    const otherTask = await createTask(
      taskFixture({ project_id: 'other-project' }),
    );
    const mismatch = await apiPut(
      `/projects/${PROJ}/tasks/${otherTask.id}/stage-comments/in_progress`,
      { content: 'note' },
    );
    expect(mismatch.status).toBe(404);
  });

  test('preserves edit and clear for a legacy note on a removed stage', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await setTaskStageComment(
      task.id,
      'legacy-stage',
      'Old note',
      'run-legacy',
    );

    const edit = await apiPut(
      `/projects/${PROJ}/tasks/${task.id}/stage-comments/legacy-stage`,
      { content: 'Updated legacy note' },
    );
    expect(edit.status).toBe(200);
    expect((await getTaskStageComment(task.id, 'legacy-stage'))?.content).toBe(
      'Updated legacy note',
    );

    const clear = await apiPut(
      `/projects/${PROJ}/tasks/${task.id}/stage-comments/legacy-stage`,
      { content: ' ' },
    );
    expect(clear.status).toBe(200);
    expect(await getTaskStageComment(task.id, 'legacy-stage')).toBeUndefined();
  });
});

// ─── POST /api/projects/:pid/tasks/:fid/messages ──────────────────────────────

describe('POST /api/projects/:pid/tasks/:fid/messages', () => {
  test('resumes the stopped run after an idle message and active-stage drag', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Resume the interrupted route run',
        description: 'Original task prompt',
        status: 'in_progress',
      }),
    );
    const group = getGroupByFolder(PROJ)!;
    setGroupResolver((projectId) => (projectId === PROJ ? group : undefined));
    const stoppedRunId = `stopped-route-run-${task.id}`;
    let markSessionEmitted!: () => void;
    const sessionEmitted = new Promise<void>((resolve) => {
      markSessionEmitted = resolve;
    });
    const interruptedExecution = executeTaskPipeline(task, group, {
      testDependencies: {
        runContainerAgent: async (_group, input, onChunk) => {
          await insertActiveRun(
            runFixture({
              id: `older-route-run-${task.id}`,
              group_folder: PROJ,
              task_id: task.id,
              stage: 'in_progress',
              status: 'completed',
              session_id: 'older-same-stage-session',
              agent_name: input.session_agent_key ?? 'claude',
              session_agent_key: input.session_agent_key ?? 'claude',
              started_at: '2026-01-01T00:00:00.000Z',
            }),
          );
          await insertActiveRun(
            runFixture({
              id: stoppedRunId,
              group_folder: PROJ,
              task_id: task.id,
              stage: 'in_progress',
              agent_name: input.session_agent_key ?? 'claude',
              session_agent_key: input.session_agent_key ?? 'claude',
              started_at: '2026-01-02T00:00:00.000Z',
            }),
          );
          await input.onSlotAcquired?.(stoppedRunId);
          onChunk?.({
            type: 'session',
            session_id: 'interrupted-route-session',
          });
          onChunk?.({ type: 'text', content: 'Partial interrupted output.' });
          markSessionEmitted();
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            status: 'error',
            result: null,
            error: 'aborted by route stop',
          };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    let releaseNextRun!: () => void;
    const nextRunReleased = new Promise<void>((resolve) => {
      releaseNextRun = resolve;
    });
    let markNextRunStarted!: () => void;
    const nextRunStarted = new Promise<void>((resolve) => {
      markNextRunStarted = resolve;
    });
    let resumedInput: ContainerInput | undefined;
    let resumedExecution: Promise<void> | undefined;

    try {
      await sessionEmitted;
      const stopResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/stop`,
        {},
      );
      expect(stopResponse.status).toBe(200);
      await interruptedExecution;
      expect(await getActiveRunById(stoppedRunId)).toMatchObject({
        status: 'error',
        session_id: 'interrupted-route-session',
      });

      const messageResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'Only this follow-up should be sent.' },
      );
      expect(messageResponse.status).toBe(200);

      exposeRegisteredRouteGroup = true;
      _testOnlySetTaskQueueDrainRunner((projectId, routeGroup) =>
        drainProjectQueue(projectId, routeGroup, {
          testDependencies: {
            executeTask: (claimedTask, claimedGroup, executionClaim) => {
              resumedExecution = executeTaskPipeline(
                claimedTask,
                claimedGroup,
                {
                  executionClaim,
                  testDependencies: {
                    runContainerAgent: async (_group, input) => {
                      resumedInput = input;
                      const nextRunId = `resumed-route-run-${task.id}`;
                      await insertActiveRun(
                        runFixture({
                          id: nextRunId,
                          group_folder: PROJ,
                          task_id: task.id,
                          stage: 'in_progress',
                          session_id: input.session_id ?? null,
                          agent_name: input.session_agent_key ?? 'claude',
                          session_agent_key:
                            input.session_agent_key ?? 'claude',
                        }),
                      );
                      await input.onSlotAcquired?.(nextRunId);
                      markNextRunStarted();
                      await nextRunReleased;
                      await completeActiveRun(
                        nextRunId,
                        'completed',
                        undefined,
                        input.session_id,
                      );
                      return {
                        status: 'success',
                        result: 'Follow-up completed.',
                        newSessionId: input.session_id,
                      };
                    },
                    runPostExecutionGitOps: async () => {},
                    drainProjectQueue: async () => {},
                  },
                },
              );
              return resumedExecution;
            },
          },
        }),
      );

      const moveResponse = await apiPatch(
        `/projects/${PROJ}/tasks/${task.id}`,
        { status: 'in_progress' },
      );
      expect(moveResponse.status).toBe(200);
      await nextRunStarted;
      expect(resumedInput?.session_id).toBe('interrupted-route-session');
      expect(resumedInput?.prompt).toBe('Only this follow-up should be sent.');
    } finally {
      releaseNextRun();
      await resumedExecution?.catch(() => undefined);
      await interruptedExecution.catch(() => undefined);
      _testOnlySetTaskQueueDrainRunner(null);
      exposeRegisteredRouteGroup = false;
      setGroupResolver(() => undefined);
    }
  });

  test('appends a user message and returns it', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'testing',
        custom_values: { testing_failure_count: 2, owner: 'alice' },
      }),
    );
    const res = await apiPost(`/projects/${PROJ}/tasks/${task.id}/messages`, {
      content: 'Hello task!',
      steer: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      role: string;
      content: string;
      steering?: boolean;
      delivery?: string;
    };
    expect(body.role).toBe('user');
    expect(body.content).toBe('Hello task!');
    expect(body.steering).toBeUndefined();
    expect(body.delivery).toBeUndefined();
    const transcript = readTaskMessages(PROJ, task.id);
    expect(
      transcript.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(transcript[0]?.steering).toBeUndefined();
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('testing');
    expect(updated?.custom_values).toEqual({
      testing_failure_count: 0,
      owner: 'alice',
    });
  });

  test('delivers an idle-classified message when a new execution claims before append', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'in_progress' }),
    );
    let markIdleClassification!: () => void;
    const idleClassification = new Promise<void>((resolve) => {
      markIdleClassification = resolve;
    });
    let releaseMessageAppend!: () => void;
    const messageAppendReleased = new Promise<void>((resolve) => {
      releaseMessageAppend = resolve;
    });
    let routeExecution: Promise<void> | undefined;
    let capturedPrompt = '';
    let messageAdmissionsSynchronized = false;

    _testOnlySetTaskMessageRunningCheckHook(async (taskId, running) => {
      if (taskId !== task.id) return;
      expect(running).toBe(false);
      markIdleClassification();
      await messageAppendReleased;
    });
    _testOnlySetExplicitExecuteTaskRunner((claimedTask, group, options) => {
      routeExecution = executeTaskPipeline(claimedTask, group, {
        ...(options ?? {}),
        testDependencies: {
          afterMessageAdmissionsSynchronized: () => {
            messageAdmissionsSynchronized = true;
          },
          runContainerAgent: async (_runGroup, input) => {
            capturedPrompt = input.prompt;
            await input.onSlotAcquired?.(`claim-message-${task.id}`);
            return {
              status: 'success',
              result: 'completed after receiving the admitted message',
            };
          },
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
        },
      });
      return routeExecution;
    });

    const messageResponsePromise = apiPost(
      `/projects/${PROJ}/tasks/${task.id}/messages`,
      { content: 'include this in the newly claimed run' },
    );
    try {
      await idleClassification;
      const executeResponse = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/execute`,
        {},
      );
      expect(executeResponse.status).toBe(202);
      expect(messageAdmissionsSynchronized).toBe(false);

      // The route has already classified the message as idle, while the 202
      // proves the competing request owns the execution claim. Releasing this
      // gate creates the exact claim-before-canonical-append interleaving.
      releaseMessageAppend();
      const messageResponse = await messageResponsePromise;
      expect(messageResponse.status).toBe(200);
      expect(await messageResponse.json()).toMatchObject({
        content: 'include this in the newly claimed run',
        role: 'user',
      });
      await routeExecution;

      expect(messageAdmissionsSynchronized).toBe(true);
      expect(capturedPrompt).toContain('include this in the newly claimed run');
      const canonicalMessages = readTaskMessages(PROJ, task.id).filter(
        (message) =>
          message.role === 'user' &&
          message.content === 'include this in the newly claimed run',
      );
      expect(canonicalMessages).toHaveLength(1);
      expect(canonicalMessages[0]?.steering).toBeUndefined();
    } finally {
      releaseMessageAppend();
      await messageResponsePromise.catch(() => undefined);
      await routeExecution?.catch(() => undefined);
      _testOnlySetTaskMessageRunningCheckHook(null);
      _testOnlySetExplicitExecuteTaskRunner(null);
    }
  });

  test('steers an active harness and records one run receipt', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    const runId = `accepted-steer-${task.id}`;
    const instance = `accepted-instance-${task.id}`;
    const runDir = path.join(
      DATA_DIR,
      'ipc',
      `carapa-bot-${instance}`,
      'runs',
      runId,
    );
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'agent-control.json'),
      JSON.stringify({ version: 1, harness: 'codex' }),
    );
    await insertActiveRun({
      id: runId,
      group_folder: PROJ,
      chat_jid: `${task.id}@kanban`,
      session_id: null,
      conversation_id: null,
      isMain: 0,
      isScheduledTask: 0,
      scheduled_task_id: null,
      task_id: task.id,
      sandbox_stack: 'stack',
      sandbox_service: 'agent',
      sandbox_instance: instance,
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'running',
      model: null,
      agent_name: 'codex',
      tok_total: null,
      tok_output: null,
      tok_input: null,
      tok_cache_write: null,
      tok_cache_read: null,
      tok_context_last: null,
      model_name: null,
      tool_usage_count: null,
      stage: 'testing',
    } satisfies ActiveRun);
    try {
      const controlRequest = nextControlRequest(runDir!);
      const responsePromise = apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'steer this run' },
      );
      const requestFile = await controlRequest;
      const responseDir = path.join(runDir, 'control-responses');
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(
        path.join(responseDir, requestFile!),
        JSON.stringify({ ok: true }),
      );
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as { delivery: string };
      expect(responseBody.delivery).toBe('steered');
      const transcript = readTaskMessages(PROJ, task.id);
      expect(
        transcript.filter((message) => message.role === 'user'),
      ).toHaveLength(1);
      expect(
        transcript.filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === transcript[0]?.id,
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });
  test('does not steer when the canonical message cannot be persisted', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    const runId = `failed-canonical-steer-${task.id}`;
    const instance = `failed-canonical-instance-${task.id}`;
    const runDir = path.join(
      DATA_DIR,
      'ipc',
      `carapa-bot-${instance}`,
      'runs',
      runId,
    );
    const transcriptFile = resolveTranscriptFile(
      path.join(GROUPS_DIR, PROJ, 'transcripts'),
      `${task.id}.jsonl`,
      task.id,
    );
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'agent-control.json'),
      JSON.stringify({ version: 1, harness: 'codex' }),
    );
    fs.mkdirSync(transcriptFile, { recursive: true });
    await insertActiveRun({
      ...runFixture({
        id: runId,
        group_folder: PROJ,
        task_id: task.id,
        stage: 'testing',
        status: 'running',
      }),
      sandbox_instance: instance,
    });
    try {
      const response = await apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'must be durable before steering' },
      );
      expect(response.status).toBe(500);
      expect(fs.existsSync(path.join(runDir, 'control-requests'))).toBe(false);
    } finally {
      fs.rmSync(transcriptFile, { recursive: true, force: true });
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });
  test('does not acknowledge steering when its durable receipt fails', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    const runId = `failed-receipt-steer-${task.id}`;
    const instance = `failed-receipt-instance-${task.id}`;
    const runDir = path.join(
      DATA_DIR,
      'ipc',
      `carapa-bot-${instance}`,
      'runs',
      runId,
    );
    const transcriptDir = path.join(GROUPS_DIR, PROJ, 'transcripts');
    let transcriptFile = '';
    let transcriptBackup = '';
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'agent-control.json'),
      JSON.stringify({ version: 1, harness: 'codex' }),
    );
    await insertActiveRun({
      ...runFixture({
        id: runId,
        group_folder: PROJ,
        task_id: task.id,
        stage: 'testing',
        status: 'running',
      }),
      sandbox_instance: instance,
    });
    try {
      const controlRequest = nextControlRequest(runDir!);
      const responsePromise = apiPost(
        `/projects/${PROJ}/tasks/${task.id}/messages`,
        { content: 'fail only the receipt append' },
      );
      const requestFile = await controlRequest;
      transcriptFile = path.join(
        transcriptDir,
        fs
          .readdirSync(transcriptDir)
          .find((entry) => entry.endsWith(`${task.id}.jsonl`))!,
      );
      transcriptBackup = `${transcriptFile}.receipt-test`;
      fs.renameSync(transcriptFile, transcriptBackup);
      fs.mkdirSync(transcriptFile);
      const responseDir = path.join(runDir, 'control-responses');
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(
        path.join(responseDir, requestFile!),
        JSON.stringify({ ok: true }),
      );

      const response = await responsePromise;
      expect(response.status).toBe(500);
      fs.rmSync(transcriptFile, { recursive: true, force: true });
      fs.renameSync(transcriptBackup, transcriptFile);
      const transcript = readTaskMessages(PROJ, task.id);
      expect(
        transcript.filter(
          (message) => message.content === 'fail only the receipt append',
        ),
      ).toHaveLength(1);
      expect(
        transcript.some(
          (message) => message.entry_type === 'steering_delivery',
        ),
      ).toBe(false);

      await completeActiveRun(runId, 'completed');
      expect(await removeRunDirPreservingControlResponses(runDir)).toBe(false);
      expect(fs.existsSync(runDir)).toBe(true);
      const boundary = await beginSuccessfulTaskFinalization(task, 'testing');
      expect(boundary.shouldAdvance).toBe(true);
      endSuccessfulTaskFinalization(boundary);
      const reconciled = readTaskMessages(PROJ, task.id);
      expect(
        reconciled.filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.run_id === runId,
        ),
      ).toHaveLength(1);
      expect(fs.existsSync(runDir)).toBe(false);
    } finally {
      if (transcriptFile)
        fs.rmSync(transcriptFile, { recursive: true, force: true });
      if (transcriptBackup && fs.existsSync(transcriptBackup))
        fs.renameSync(transcriptBackup, transcriptFile);
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });
  test('completion barrier waits for an in-flight canonical submission', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'testing' }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submission = appendTaskSteeringMessage(
      PROJ,
      task.id,
      'race prompt',
      async () => gate,
    );
    const barrier = holdTaskForPendingSteering(task, 'testing');
    release();
    await submission;
    expect(await barrier).toBe(true);
    expect((await getTask(task.id))?.status).toBe('testing');
    expect(readTaskMessages(PROJ, task.id)).toHaveLength(1);
  });
  test('restores the starting stage when steering loses the finalization race', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'completed' }),
    );
    const runId = `race-run-${task.id}`;
    await insertActiveRun({
      id: runId,
      group_folder: PROJ,
      chat_jid: `${task.id}@kanban`,
      session_id: null,
      conversation_id: null,
      isMain: 0,
      isScheduledTask: 0,
      scheduled_task_id: null,
      task_id: task.id,
      sandbox_stack: 'stack',
      sandbox_service: 'agent',
      sandbox_instance: 'instance',
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'running',
      model: null,
      agent_name: 'codex',
      tok_total: null,
      tok_output: null,
      tok_input: null,
      tok_cache_write: null,
      tok_cache_read: null,
      tok_context_last: null,
      model_name: null,
      tool_usage_count: null,
      stage: 'testing',
    } satisfies ActiveRun);
    const res = await apiPost(`/projects/${PROJ}/tasks/${task.id}/messages`, {
      content: 'recover this prompt',
    });
    const responseBody = (await res.json()) as { delivery: string };
    expect(responseBody.delivery).toBe('queued');
    expect((await getActiveRunForTask(task.id))?.stage).toBe('testing');
    expect((await getTask(task.id))?.status).toBe('testing');
  });
  test('does not rewind a failed run when a prompt races completion', async () => {
    const terminalStatus = 'failed';
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: terminalStatus }),
    );
    await insertActiveRun({
      ...runFixture({
        id: `${terminalStatus}-race-${task.id}`,
        group_folder: PROJ,
        task_id: task.id,
        stage: 'testing',
        status: 'running',
      }),
      sandbox_instance: `instance-${task.id}`,
    });

    const response = await apiPost(
      `/projects/${PROJ}/tasks/${task.id}/messages`,
      { content: `prompt after ${terminalStatus}` },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { delivery: string };
    expect(body.delivery).toBe('queued');
    expect((await getTask(task.id))?.status).toBe(terminalStatus);
    expect(
      readTaskMessages(PROJ, task.id).filter(
        (message) => message.content === `prompt after ${terminalStatus}`,
      ),
    ).toHaveLength(1);
  });
});

describe('local default branch integration', () => {
  let fixtureRoot: string;
  let fixtureIndex = 0;
  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-default-integration-'),
    );
  });
  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  async function fixture(conflict = false) {
    const repo = path.join(fixtureRoot, String(++fixtureIndex));
    fs.mkdirSync(repo);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: repo,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-qb', 'develop']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Integration Test']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    const branch = 'task/integration';
    const worktree = path.join(repo, '.worktrees', branch);
    git(['worktree', 'add', '-qb', branch, worktree]);
    fs.writeFileSync(
      path.join(worktree, conflict ? 'tracked.txt' : 'task.txt'),
      'task\n',
    );
    git(['add', '.'], worktree);
    git(['commit', '-qm', 'task edit'], worktree);
    fs.writeFileSync(
      path.join(repo, conflict ? 'tracked.txt' : 'default.txt'),
      'default\n',
    );
    git(['add', '.']);
    git(['commit', '-qm', 'default edit']);
    const expected = {
      sourceCommit: git(['rev-parse', 'develop']),
      taskHead: git(['rev-parse', 'HEAD'], worktree),
    };
    // The default checkout may itself be dirty; it is never the merge target.
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'leave default alone\n');
    const defaultStatus = git(['status', '--porcelain']);
    const previousSettings = getGroupByFolder(PROJ)?.settings;
    await updateGroup(PROJ_JID, {
      settings: {
        ...previousSettings,
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host-only/repo',
        defaultBranch: 'develop',
      },
    });
    sandboxGitHandler = async (command) => {
      const child = Bun.spawn(['sh', '-c', `git ${command}`], {
        cwd: repo,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: stdout + (code ? stderr : ''), isError: code !== 0 };
    };
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        status: 'in_progress',
        branch_name: branch,
        worktree_path: `/host-only/repo/.worktrees/${branch}`,
      }),
    );
    await updateTask(task.id, {
      worktree_path: `/host-only/repo/.worktrees/${branch}`,
    });
    const endpoint = `/projects/${PROJ}/tasks/${task.id}/default-branch`;
    return {
      repo,
      git,
      task,
      worktree,
      expected,
      endpoint,
      status: async () => (await apiGet(endpoint)).json() as Promise<any>,
      merge: (body = expected) => apiPost(`${endpoint}/merge`, body),
      unchangedDefault: () => {
        expect(git(['symbolic-ref', '--short', 'HEAD'])).toBe('develop');
        expect(git(['rev-parse', 'develop'])).toBe(expected.sourceCommit);
        expect(git(['status', '--porcelain'])).toBe(defaultStatus);
      },
      restore: () => updateGroup(PROJ_JID, { settings: previousSettings }),
    };
  }

  function saveConflictResolution(f: Awaited<ReturnType<typeof fixture>>) {
    f.git(['config', 'rerere.enabled', 'true']);
    f.git(['config', 'rerere.autoupdate', 'true']);
    expect(() =>
      f.git(['merge', '--no-edit', 'develop'], f.worktree),
    ).toThrow();
    fs.writeFileSync(
      path.join(f.worktree, 'tracked.txt'),
      'resolved task and default\n',
    );
    f.git(['rerere'], f.worktree);
    f.git(['merge', '--abort'], f.worktree);
  }

  test('hands off merges awaiting a commit after rerere or no-commit, including a lost response', async () => {
    for (const mode of ['rerere', 'lost-response', 'no-commit']) {
      const f = await fixture(mode !== 'no-commit');
      if (mode === 'no-commit')
        f.git([
          'config',
          'branch.task/integration.mergeOptions',
          '--no-commit',
        ]);
      else saveConflictResolution(f);
      const stagedPath = mode === 'no-commit' ? 'default.txt' : 'tracked.txt';
      const realGit = sandboxGitHandler;
      sandboxGitHandler = async (command) => {
        const result = await realGit(command);
        if (
          mode === 'lost-response' &&
          command.includes('merge.autoStash=false merge')
        ) {
          throw new Error(
            'sandbox_git HTTP 502 after rerere resolved the merge',
          );
        }
        return result;
      };
      try {
        const response = await f.merge();
        expect(response.status).toBe(200);
        const result = (await response.json()) as any;
        expect(result).toMatchObject({
          outcome: 'uncommitted',
          delivery: 'queued',
          conflictedPaths: [],
        });
        expect(f.git(['rev-parse', 'HEAD'], f.worktree)).toBe(
          f.expected.taskHead,
        );
        expect(f.git(['rev-parse', 'MERGE_HEAD'], f.worktree)).toBe(
          f.expected.sourceCommit,
        );
        expect(f.git(['ls-files', '-u'], f.worktree)).toBe('');
        expect(f.git(['show', `:${stagedPath}`], f.worktree)).toBe(
          mode === 'no-commit' ? 'default' : 'resolved task and default',
        );
        expect(f.git(['diff', '--cached', '--name-only'], f.worktree)).toBe(
          stagedPath,
        );
        expect(await f.status()).toMatchObject({
          state: 'unresolved',
          conflictedPaths: [],
        });
        expect((await f.merge()).status).toBe(409);
        const pending = getPendingTaskDeliveryPrompts(
          readTaskMessages(PROJ, f.task.id),
          'in_progress',
        );
        expect(pending).toHaveLength(1);
        expect(pending[0].content).toContain(f.expected.sourceCommit);
        f.git(['commit', '-qm', 'finish reviewed resolution'], f.worktree);
        expect(await f.status()).toMatchObject({
          commitsBehind: 0,
          state: 'ready',
        });
        f.unchangedDefault();
      } finally {
        sandboxGitHandler = realGit;
        await f.restore();
      }
    }
  });

  test('recovers a completed or conflicted merge after the producer exits', async () => {
    for (const outcome of ['merged', 'conflicted']) {
      const f = await fixture(outcome === 'conflicted');
      const realGit = sandboxGitHandler;
      const bin = path.join(f.repo, '.git/test-bin');
      const stoppedAt = path.join(f.repo, '.git/stopped-at');
      fs.mkdirSync(bin);
      const gitPath = Bun.which('git')!;
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh
if [ "$1" = -c ] && [ "$2" = merge.autoStash=false ]; then
  "${gitPath}" "$@"
  touch '${stoppedAt}'
  while :; do sleep 0.02; done
fi
exec '${gitPath}' "$@"
`,
        { mode: 0o755 },
      );
      sandboxGitHandler = async (command) => {
        if (!command.includes('merge.autoStash=false merge'))
          return realGit(command);
        const child = spawn('sh', ['-c', `git ${command}`], {
          cwd: f.repo,
          detached: true,
          env: {
            GIT_EXEC_PATH: bin,
            PATH: `${bin}:${process.env.PATH}`,
            HOME: f.repo,
            LANG: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          stdio: 'pipe',
        });
        let stdout = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stdout += data;
        });
        await waitForFileState(
          path.dirname(stoppedAt),
          () => fs.existsSync(stoppedAt) || undefined,
        );
        process.kill(-child.pid!, 'SIGKILL');
        await new Promise<void>((resolve) =>
          child.on('close', () => resolve()),
        );
        return { stdout, isError: true };
      };
      try {
        const merging = f.merge();
        await waitForFileState(
          path.dirname(stoppedAt),
          () => fs.existsSync(stoppedAt) || undefined,
        );
        const completion = withProjectGitLock(PROJ, async () => {
          expect(
            getPendingTaskDeliveryPrompts(
              readTaskMessages(PROJ, f.task.id),
              'in_progress',
            ),
          ).toHaveLength(1);
        });
        const response = await merging;
        expect(response.status).toBe(200);
        const result = (await response.json()) as any;
        expect(result).toMatchObject({
          outcome,
          delivery: 'queued',
          sourceCommit: f.expected.sourceCommit,
        });
        expect(result.notification).toContain('finish/commit the merge');
        if (outcome === 'merged') {
          expect(f.git(['show', 'HEAD:default.txt'], f.worktree)).toBe(
            'default',
          );
        } else {
          expect(result.conflictedPaths).toEqual(['tracked.txt']);
          expect(f.git(['rev-parse', 'MERGE_HEAD'], f.worktree)).toBe(
            f.expected.sourceCommit,
          );
          expect(f.git(['ls-files', '-u'], f.worktree)).toContain(
            'tracked.txt',
          );
        }
        await completion;
        sandboxGitHandler = realGit;
        expect(
          (
            await apiPost(`/projects/${PROJ}/tasks/${f.task.id}/messages`, {
              content: 'Continue after inspection.',
            })
          ).status,
        ).toBe(200);
        f.unchangedDefault();
      } finally {
        sandboxGitHandler = realGit;
        await f.restore();
      }
    }
  }, 15_000);

  test('keeps a delayed or response-lost merge coordinated through its durable handoff', async () => {
    for (const scenario of [
      { conflict: false, loseResponse: false },
      { conflict: true, loseResponse: true },
      { conflict: false, loseResponse: true, duringGit: true },
    ]) {
      const { conflict, loseResponse } = scenario;
      const duringGit = 'duringGit' in scenario;
      const f = await fixture(conflict);
      const realGit = sandboxGitHandler;
      const hookStarted = path.join(f.repo, '.git/hook-started');
      const hookRelease = path.join(f.repo, '.git/hook-release');
      if (duringGit) {
        fs.writeFileSync(
          path.join(f.repo, '.git/hooks/pre-merge-commit'),
          `#!/bin/sh\ntouch '${hookStarted}'\nwhile [ ! -f '${hookRelease}' ]; do sleep 0.02; done\n`,
          { mode: 0o755 },
        );
      }
      let recoveryStarted!: () => void;
      const recovering = new Promise<void>((resolve) => {
        recoveryStarted = resolve;
      });
      let gitExecution: Promise<SandboxResult> | undefined;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      sandboxGitHandler = async (command) => {
        if (!command.includes('merge.autoStash=false merge')) {
          recoveryStarted();
          return realGit(command);
        }
        started();
        await released;
        gitExecution = realGit(command);
        if (duringGit) {
          await waitForFileState(
            path.dirname(hookStarted),
            () => fs.existsSync(hookStarted) || undefined,
          );
          throw new Error('sandbox_git HTTP 502 while Git is still running');
        }
        const result = await gitExecution;
        if (loseResponse)
          throw new Error('sandbox_git HTTP 502: response lost');
        return result;
      };
      let returned = false;
      const merging = f.merge().then((response) => {
        returned = true;
        return response;
      });
      let completion: Promise<void> | undefined;
      let finalizing:
        | ReturnType<typeof beginSuccessfulTaskFinalization>
        | undefined;
      try {
        await entered;
        let completionEntered = false;
        completion = withProjectGitLock(PROJ, async () => {
          completionEntered = true;
          expect(
            readTaskMessages(PROJ, f.task.id).filter(
              (message) => message.steering,
            ),
          ).toHaveLength(1);
        });
        finalizing = beginSuccessfulTaskFinalization(f.task, 'in_progress');
        expect(returned).toBe(false);
        expect(completionEntered).toBe(false);
        expect(f.git(['rev-parse', 'HEAD'], f.worktree)).toBe(
          f.expected.taskHead,
        );
        release();
        if (duringGit) {
          await recovering;
          expect(returned).toBe(false);
          expect(completionEntered).toBe(false);
          fs.writeFileSync(hookRelease, '');
        }
        expect(await (await merging).json()).toMatchObject({
          outcome: conflict ? 'conflicted' : 'merged',
          delivery: 'queued',
        });
        await completion;
        const boundary = await finalizing;
        expect(boundary.shouldAdvance).toBe(false);
        endSuccessfulTaskFinalization(boundary);
        finalizing = undefined;
        const messages = readTaskMessages(PROJ, f.task.id).filter(
          (message) => message.steering,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toContain(f.expected.sourceCommit);
        if (conflict) {
          expect(f.git(['rev-parse', 'MERGE_HEAD'], f.worktree)).toBe(
            f.expected.sourceCommit,
          );
          expect(messages[0].content).toContain('tracked.txt');
        } else {
          expect(f.git(['show', 'HEAD:default.txt'], f.worktree)).toBe(
            'default',
          );
          sandboxGitHandler = realGit;
          expect(await (await f.merge()).json()).toMatchObject({
            outcome: 'up-to-date',
          });
          expect(
            readTaskMessages(PROJ, f.task.id).filter(
              (message) => message.steering,
            ),
          ).toHaveLength(1);
        }
        f.unchangedDefault();
      } finally {
        release();
        if (duringGit) fs.writeFileSync(hookRelease, '');
        await gitExecution;
        await merging;
        await completion?.catch(() => undefined);
        if (finalizing) endSuccessfulTaskFinalization(await finalizing);
        await f.restore();
      }
    }
  }, 15_000);

  test('counts divergent history, merges once, and consumes the queued instruction on the next execution', async () => {
    const f = await fixture();
    try {
      expect(await f.status()).toMatchObject({
        available: true,
        defaultBranch: 'develop',
        commitsBehind: 1,
        state: 'ready',
        ...f.expected,
      });
      const responses = await Promise.all([f.merge(), f.merge()]);
      const results = (await Promise.all(
        responses.map((response) => response.json()),
      )) as any[];
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'merged',
        'up-to-date',
      ]);
      expect(
        results.find((result) => result.outcome === 'merged').delivery,
      ).toBe('queued');
      expect(await f.status()).toMatchObject({ commitsBehind: 0 });
      expect(
        f
          .git(['rev-list', '--parents', '-n', '1', 'HEAD'], f.worktree)
          .split(' '),
      ).toHaveLength(3);
      expect(f.git(['show', 'HEAD:default.txt'], f.worktree)).toBe('default');
      expect(f.git(['show', 'HEAD:task.txt'], f.worktree)).toBe('task');
      f.unchangedDefault();
      const messages = readTaskMessages(PROJ, f.task.id);
      const queued = messages.filter((message) => message.steering);
      expect(queued).toHaveLength(1);
      expect(queued[0].content).toContain(f.expected.sourceCommit);
      expect(queued[0].target_stage).toBeUndefined();
      expect((await getTask(f.task.id))?.status).toBe('in_progress');
      // An intervening assistant turn must not turn the handoff into history.
      await appendTaskMessageAsync(PROJ, {
        task_id: f.task.id,
        role: 'assistant',
        content: 'Old run finished.',
        created_at: new Date().toISOString(),
      });
      let prompt = '';
      await executeTaskPipeline(
        (await getTask(f.task.id))!,
        getGroupByFolder(PROJ)!,
        {
          testDependencies: {
            runContainerAgent: (group, input, onChunk) =>
              runContainerAgent(group, input, onChunk, {
                resolveEffectiveSandbox,
                runDirectLlm: async () => {
                  prompt = input.prompt;
                  return { result: 'handled integration', model_name: 'test' };
                },
              }),
            runPostExecutionGitOps: async () => {},
            drainProjectQueue: async () => {},
          },
        },
      );
      expect(prompt).toContain(queued[0].content);
      expect(
        getPendingTaskDeliveryPrompts(
          readTaskMessages(PROJ, f.task.id),
          'in_progress',
        ),
      ).toHaveLength(0);
    } finally {
      await f.restore();
    }
  });

  test('retains content conflicts, queues their paths, and rejects unresolved merge and rebase states', async () => {
    const f = await fixture(true);
    try {
      const response = await f.merge();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        outcome: 'conflicted',
        delivery: 'queued',
        conflictedPaths: ['tracked.txt'],
      });
      expect(f.git(['rev-parse', 'MERGE_HEAD'], f.worktree)).toBe(
        f.expected.sourceCommit,
      );
      expect(f.git(['ls-files', '-u'], f.worktree)).toContain('tracked.txt');
      expect(
        fs.readFileSync(path.join(f.worktree, 'tracked.txt'), 'utf8'),
      ).toContain('<<<<<<<');
      expect(await f.status()).toMatchObject({
        state: 'unresolved',
        conflictedPaths: ['tracked.txt'],
      });
      expect((await f.merge()).status).toBe(409);
      const notice = readTaskMessages(PROJ, f.task.id).find(
        (message) => message.steering,
      )!;
      expect(notice.content).toContain('tracked.txt');
      expect(notice.content).toContain(f.expected.sourceCommit);
      expect(notice.content).toContain('finish/commit the merge');
      f.unchangedDefault();
      f.git(['merge', '--abort'], f.worktree);
      const rebased = spawnSync('git', ['rebase', 'develop'], {
        cwd: f.worktree,
      });
      expect(rebased.status).not.toBe(0);
      expect(await f.status()).toMatchObject({
        available: true,
        state: 'unresolved',
      });
      expect((await f.merge()).status).toBe(409);
    } finally {
      await f.restore();
    }
  });

  test('rejects dirty, stale, missing, wrong-checkout, unsupported and cross-project requests without changing Git', async () => {
    const f = await fixture();
    try {
      // Recovery must fence a transport-failed request that arrives late.
      const realGit = sandboxGitHandler;
      let delayedCommand = '';
      sandboxGitHandler = async (command) => {
        if (command.includes('merge.autoStash=false merge')) {
          delayedCommand = command;
          throw new Error('sandbox_git HTTP 502 before command dispatch');
        }
        return realGit(command);
      };
      const cancelled = await f.merge();
      expect(cancelled.status).toBe(409);
      expect(((await cancelled.json()) as any).error).toContain('not started');
      sandboxGitHandler = realGit;
      expect((await realGit(delayedCommand)).isError).toBe(true);
      expect(f.git(['rev-parse', 'HEAD'], f.worktree)).toBe(
        f.expected.taskHead,
      );
      expect(readTaskMessages(PROJ, f.task.id)).toHaveLength(0);
      f.git(['config', 'merge.autoStash', 'true']);
      for (const kind of ['tracked', 'staged', 'untracked']) {
        const file = path.join(
          f.worktree,
          kind === 'untracked' ? 'new.txt' : 'tracked.txt',
        );
        fs.writeFileSync(file, 'pre-existing edit\n');
        if (kind === 'staged') f.git(['add', 'tracked.txt'], f.worktree);
        expect(await f.status()).toMatchObject({ state: 'dirty' });
        const response = await f.merge();
        expect(response.status).toBe(409);
        expect(((await response.json()) as any).error).toContain(
          'tracked, staged, and untracked',
        );
        expect(fs.readFileSync(file, 'utf8')).toBe('pre-existing edit\n');
        if (kind === 'untracked') fs.rmSync(file);
        else
          f.git(
            [
              'restore',
              '--source=HEAD',
              '--staged',
              '--worktree',
              'tracked.txt',
            ],
            f.worktree,
          );
      }
      expect(
        (await f.merge({ ...f.expected, taskHead: '0'.repeat(40) })).status,
      ).toBe(409);
      expect(
        (
          await apiPost(
            `/projects/another-project/tasks/${f.task.id}/default-branch/merge`,
            f.expected,
          )
        ).status,
      ).toBe(404);
      for (const mode of ['shared', 'branch'] as const) {
        await updateGroup(PROJ_JID, {
          settings: {
            ...getGroupByFolder(PROJ)?.settings,
            taskCheckoutMode: mode,
          },
        });
        expect((await f.merge()).status).toBe(409);
      }
      await updateGroup(PROJ_JID, {
        settings: {
          ...getGroupByFolder(PROJ)?.settings,
          taskCheckoutMode: 'worktree',
        },
      });
      await updateTask(f.task.id, { branch_name: '../escape' });
      expect(await f.status()).toMatchObject({ available: false });
      expect((await f.merge()).status).toBe(409);
      await updateTask(f.task.id, { branch_name: 'task/integration' });
      f.git(['checkout', '--detach'], f.worktree);
      expect(await f.status()).toMatchObject({ available: false });
      expect((await f.merge()).status).toBe(409);
      f.git(['checkout', 'task/integration'], f.worktree);
      expect(f.git(['rev-parse', 'HEAD'], f.worktree)).toBe(
        f.expected.taskHead,
      );
      f.git(['worktree', 'remove', f.worktree]);
      expect(await f.status()).toMatchObject({ available: false });
      expect((await f.merge()).status).toBe(409);
      expect(
        readTaskMessages(PROJ, f.task.id).filter((message) => message.steering),
      ).toHaveLength(0);
      f.unchangedDefault();
    } finally {
      await f.restore();
    }
  });

  test('reports operational Git errors separately and reports a failed durable handoff after Git succeeds', async () => {
    const f = await fixture();
    let transcriptFile = '';
    try {
      f.git(['config', 'merge.ff', 'only']);
      const realGit = sandboxGitHandler;
      sandboxGitHandler = async (command) => {
        const result = await realGit(command);
        if (command.includes('merge.autoStash=false merge')) {
          throw new Error('sandbox_git HTTP 502 after rejected merge');
        }
        return result;
      };
      const failed = (await (await f.merge()).json()) as any;
      expect(failed).toMatchObject({ outcome: 'failed' });
      expect(failed.error).toContain('fast-forward');
      expect(failed.delivery).toBeUndefined();
      sandboxGitHandler = realGit;
      expect(f.git(['rev-parse', 'HEAD'], f.worktree)).toBe(
        f.expected.taskHead,
      );
      expect(
        readTaskMessages(PROJ, f.task.id).filter((message) => message.steering),
      ).toHaveLength(0);
      f.git(['config', '--unset', 'merge.ff']);
      transcriptFile = resolveTranscriptFile(
        path.join(GROUPS_DIR, PROJ, 'transcripts'),
        `${f.task.id}.jsonl`,
        f.task.id,
      );
      fs.mkdirSync(transcriptFile, { recursive: true });
      const partial = (await (await f.merge()).json()) as any;
      expect(partial).toMatchObject({ outcome: 'merged', delivery: 'failed' });
      expect(partial.error).toContain('Do not repeat the merge');
      expect(partial.notification).toContain(f.expected.sourceCommit);
      expect(await f.status()).toMatchObject({ commitsBehind: 0 });
      expect(await (await f.merge()).json()).toMatchObject({
        outcome: 'up-to-date',
      });
      f.unchangedDefault();
    } finally {
      if (transcriptFile)
        fs.rmSync(transcriptFile, { recursive: true, force: true });
      await f.restore();
    }
  });

  test('steers only running in_progress and keeps finishing or other-stage handoffs queued', async () => {
    for (const stage of ['in_progress', 'testing', 'backlog']) {
      const f = await fixture();
      const instance = `integration-${f.task.id}`;
      const runId = `run-${f.task.id}`;
      const runDir = path.join(
        DATA_DIR,
        'ipc',
        `carapa-bot-${instance}`,
        'runs',
        runId,
      );
      try {
        await updateTask(f.task.id, { status: stage });
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, 'agent-control.json'),
          JSON.stringify({ version: 1, harness: 'codex' }),
        );
        if (stage !== 'backlog')
          await insertActiveRun({
            ...runFixture({
              id: runId,
              task_id: f.task.id,
              group_folder: PROJ,
              status: 'running',
              stage,
            }),
            sandbox_instance: instance,
          });
        let response: Response;
        if (stage === 'in_progress') {
          const request = nextControlRequest(runDir);
          const merging = f.merge();
          const file = await request;
          const completion = withProjectGitLock(PROJ, async () => {
            // The merge holds the project git lock until the control exchange
            // ends, so the delivery receipt must already be recorded here.
            expect(
              readTaskMessages(PROJ, f.task.id).some(
                (message) => message.entry_type === 'steering_delivery',
              ),
            ).toBe(true);
          });
          const responseDir = path.join(runDir, 'control-responses');
          fs.mkdirSync(responseDir, { recursive: true });
          fs.writeFileSync(
            path.join(responseDir, file),
            JSON.stringify({ ok: true }),
          );
          response = await merging;
          await completion;
        } else {
          response = await f.merge();
          expect(fs.existsSync(path.join(runDir, 'control-requests'))).toBe(
            false,
          );
        }
        expect(await response.json()).toMatchObject({
          outcome: 'merged',
          delivery: stage === 'in_progress' ? 'steered' : 'queued',
        });
        expect((await getTask(f.task.id))?.status).toBe(stage);
        const pending = getPendingTaskDeliveryPrompts(
          readTaskMessages(PROJ, f.task.id),
          'review',
        );
        expect(pending).toHaveLength(stage === 'in_progress' ? 0 : 1);
        f.unchangedDefault();
      } finally {
        await completeActiveRun(runId, 'completed');
        fs.rmSync(path.dirname(path.dirname(runDir)), {
          recursive: true,
          force: true,
        });
        await f.restore();
      }
    }
  });

  test('holds successful finalization until the merge notification is persisted and queues a finishing-run fallback', async () => {
    const f = await fixture();
    const runId = `finishing-${f.task.id}`;
    let boundary:
      | Awaited<ReturnType<typeof beginSuccessfulTaskFinalization>>
      | undefined;
    try {
      await insertActiveRun(
        runFixture({
          id: runId,
          task_id: f.task.id,
          group_folder: PROJ,
          status: 'running',
          stage: 'in_progress',
        }),
      );
      const realGit = sandboxGitHandler;
      let finalizing:
        | Promise<Awaited<ReturnType<typeof beginSuccessfulTaskFinalization>>>
        | undefined;
      sandboxGitHandler = async (command) => {
        const result = await realGit(command);
        if (command.includes('merge.autoStash=false merge')) {
          await completeActiveRun(runId, 'completed');
          finalizing = beginSuccessfulTaskFinalization(
            f.task,
            'in_progress',
            runId,
          );
        }
        return result;
      };
      expect(await (await f.merge()).json()).toMatchObject({
        outcome: 'merged',
        delivery: 'queued',
      });
      boundary = await finalizing!;
      // Finalization waits on the project git lock held by the merge route, so
      // it must observe the handoff prompt the route queued.
      expect(boundary.shouldAdvance).toBe(false);
      expect(
        getPendingTaskDeliveryPrompts(
          readTaskMessages(PROJ, f.task.id),
          'in_progress',
        ),
      ).toHaveLength(1);
      f.unchangedDefault();
    } finally {
      if (boundary) endSuccessfulTaskFinalization(boundary);
      await f.restore();
    }
  });
});
