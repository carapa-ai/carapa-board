/**
 * Tests for the archive_task / restore_task MCP tools (in src/modules/kanban/tools.ts).
 *
 * Mirrors the src/routes/_helpers.test.ts pattern. Cases:
 *   - archive non-existent task → 404-equivalent error
 *   - archive task in another project → 403-equivalent error
 *   - archive already-archived task → success, removeWorktreeForTask NOT called
 *   - archive task with active worktree → success, removeWorktreeForTask runs once
 *   - restore_task flips archived back to false
 *   - list_tasks with include_archived=true surfaces archived tasks
 *
 * The handlers reach into the sandbox client (via removeWorktreeForTask), so
 * `getSandboxClient` is mocked. The state-manager and ws-events modules are
 * also mocked so the test can run hermetically against the in-memory DB.
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
import * as realExecutor from './task-executor.js';
import {
  waitForStageVariantWrites,
  withStageVariantWriteLock,
} from './task/pipeline.js';
import {
  initDatabase,
  createTask,
  getTask,
  updateTask,
  createConversation,
  createUser,
  insertActiveRun,
  completeActiveRun,
  claimNextStageEntryEvent,
  markStageEntryEventRunning,
} from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects } from '../../db/schema.js';
import { taskFixture, truncateTestDb, runFixture } from '../../test-helpers.js';
import {
  acquireConversationExecutionLease,
  releaseConversationExecutionLease,
} from '../chat/conversation-execution-lease.js';

// ─── Module mocks (must be set before importing the tool module) ─────────────

const removeWorktreeCalls: Array<{ taskId: string; branch: string }> = [];
const broadcastEvents: Array<{ type: string; payload: any }> = [];

mock.module('../../index.js', () => ({
  registeredGroups: {},
  updateGroup: mock(() => {}),
  getGroupByFolder: mock(() => undefined),
  getGroupEntryByFolder: mock(() => undefined),
}));

// Strict in-memory group registry. Bun's mock.module is process-global: this
// factory also serves every test file that loads later without re-mocking
// state-manager itself (description-draft.test.ts statically imports
// loadState/registerGroup/unregisterGroup and registers its fixtures through
// this API). A catch-all that fabricates a group for any folder would leak
// 200s into tests that expect 404s for unregistered projects, so lookups
// must miss for unregistered folders.
const _archiveGroups: Record<string, any> = {};
mock.module('../../state-manager.js', () => ({
  registeredGroups: _archiveGroups,
  getGroupByFolder: mock((folder: string) => _archiveGroups[folder]),
  getGroupEntryByFolder: mock((folder: string) =>
    _archiveGroups[folder]
      ? { jid: folder, group: _archiveGroups[folder] }
      : undefined,
  ),
  updateGroup: mock(() => {}),
  // Working in-memory registration so suites that statically import the real
  // API can set up their fixtures under this mock (keyed by both JID and
  // folder, mirroring the real module's folder index).
  loadState: mock(async () => {}),
  registerGroup: mock(async (jid: string, group: any) => {
    _archiveGroups[jid] = group;
    if (group?.folder) _archiveGroups[group.folder] = group;
  }),
  unregisterGroup: mock(async (jid: string) => {
    const group = _archiveGroups[jid];
    delete _archiveGroups[jid];
    if (group?.folder) delete _archiveGroups[group.folder];
  }),
}));

mock.module('../objectives/ws-events.js', () => ({
  broadcast: mock((event: { type: string; payload: any }) => {
    broadcastEvents.push(event);
  }),
}));

mock.module('../../lib/mcp-client.js', () => ({
  getSandboxClient: () => ({
    sandboxWorktree: mock(
      async (_stack: string, action: string, args: { branch: string }) => {
        if (action === 'remove') {
          removeWorktreeCalls.push({
            taskId: args.branch,
            branch: args.branch,
          });
        }
        return { stdout: '', isError: false };
      },
    ),
  }),
}));

// Moving a task into an active stage normally starts the project queue in the
// background. This suite exercises tool persistence/broadcast behavior, not
// task execution; letting that queue escape the test races PGlite shutdown.
//
// Bun's mock.module is process-global: this factory stays active for every
// test file that loads later and rewrites the live bindings of modules that
// were already loaded — including the task/pipeline implementation module
// this barrel re-exports. To keep the leak harmless, the factory spreads the
// real barrel namespace (captured at load time, below) and delegates to the
// real implementations unless this suite is actively running. A boolean flag
// (not group identity) gates the suppression: the suite's update_task test
// moves a card into an active stage, and the real drain would then race
// PGlite/MCP for every group, not just this suite's.
const realExecutorExports: Record<string, any> = { ...realExecutor };
const realDrainProjectQueue = realExecutor.drainProjectQueue;
const realRequestTaskStageHandoff = realExecutor.requestTaskStageHandoff;
let _suppressExecutorForThisSuite = false;

mock.module('./task-executor.js', () => ({
  ...realExecutorExports,
  drainProjectQueue: (project: string, group?: any, opts?: any) =>
    _suppressExecutorForThisSuite
      ? Promise.resolve()
      : realDrainProjectQueue(project, group, opts),
  requestTaskStageHandoff: (
    taskId: string,
    fromStage: string,
    toStage: string,
    details?: any,
  ) =>
    _suppressExecutorForThisSuite
      ? false
      : realRequestTaskStageHandoff(taskId, fromStage, toStage, details),
}));

// ─── Tool import (after mocks) ───────────────────────────────────────────────

const {
  archiveTaskTool,
  restoreTaskTool,
  listTasksTool,
  createTaskTool,
  updateTaskTool,
  _testOnlySetTaskQueueDrainRunner,
} = await import('./tools.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT = 'arch-test-proj';
const OTHER_PROJECT = 'arch-test-other-proj';

function makeContext(
  project: string,
  perms: Record<string, string[]> = {},
  execution: { conversation_id?: string; run_id?: string } = {},
) {
  return {
    group_folder: project,
    permissions: {
      [project]: ['tasks:read', 'tasks:write'],
      ...perms,
    },
    ...execution,
  };
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

let _init = false;
beforeAll(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
});

beforeEach(async () => {
  await truncateTestDb();
  removeWorktreeCalls.length = 0;
  broadcastEvents.length = 0;
  _suppressExecutorForThisSuite = true;
  // Register this suite's projects the way the old catch-all mock used to
  // fabricate them, so the handlers' group lookups behave identically.
  const baseSettings = {
    defaultSandbox: 'carapa-bot',
    defaultSandboxInstance: 'test-instance',
    repositoryLocation: '/host/repo',
  };
  _archiveGroups[PROJECT] = {
    folder: PROJECT,
    settings: { ...baseSettings },
  };
  _archiveGroups[OTHER_PROJECT] = {
    folder: OTHER_PROJECT,
    settings: { ...baseSettings },
  };
  _archiveGroups['arch-testing-proj'] = {
    folder: 'arch-testing-proj',
    settings: {
      ...baseSettings,
      stages: [
        { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
        { id: 'testing', title: 'Testing', type: 'testing', color: '#a3f' },
        { id: 'completed', title: 'Completed', type: 'done', color: '#3f3' },
      ],
    },
  };
  _archiveGroups['arch-entry-testing-proj'] = {
    folder: 'arch-entry-testing-proj',
    settings: {
      ...baseSettings,
      stages: [
        { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
        {
          id: 'testing',
          title: 'Testing',
          type: 'testing',
          color: '#a3f',
          runOnEntry: true,
        },
        {
          id: 'in_progress',
          title: 'In Progress',
          type: 'active',
          color: '#36f',
        },
        { id: 'completed', title: 'Completed', type: 'done', color: '#3f3' },
      ],
    },
  };
});

afterEach(() => {
  _suppressExecutorForThisSuite = false;
});

afterAll(() => {
  mock.restore();
});

// ─── archive_task ────────────────────────────────────────────────────────────

describe('archive_task', () => {
  test("throws Unauthorized when caller lacks tasks:write on the task's project", async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    // Caller is scoped to OTHER_PROJECT with no read/write on PROJECT.
    let caught: Error | null = null;
    try {
      await archiveTaskTool.handler(
        { task_id: task.id },
        {} as any,
        makeContext(OTHER_PROJECT, {
          [OTHER_PROJECT]: ['tasks:read', 'tasks:write'],
        }),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Unauthorized/);
    expect(caught!.message).toContain(PROJECT);
    // Task must not be archived.
    expect((await getTask(task.id))!.archived).toBeFalsy();
  });

  test('archives a task, returns full Task object, and excludes it from list_tasks by default', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, title: 'to archive' }),
    );
    const result = await archiveTaskTool.handler(
      { task_id: task.id },
      {} as any,
      makeContext(PROJECT),
    );
    const parsed = JSON.parse(result);
    expect(parsed.archived).toBe(true);
    expect(parsed.task.id).toBe(task.id);
    expect(parsed.task.archived).toBe(true);

    // list_tasks (default) should no longer surface it.
    const listResult = JSON.parse(
      await listTasksTool.handler(
        { project_id: PROJECT },
        {} as any,
        makeContext(PROJECT),
      ),
    );
    expect(
      listResult.find((t: { id: string }) => t.id === task.id),
    ).toBeUndefined();
  });

  test('idempotent: archiving an already-archived task does NOT re-run removeWorktreeForTask', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, branch_name: 'feature/x' }),
    );
    // First archive → triggers cleanup hook.
    await archiveTaskTool.handler(
      { task_id: task.id },
      {} as any,
      makeContext(PROJECT),
    );
    expect(removeWorktreeCalls.length).toBe(1);

    // Second archive → cleanup hook is gated on `archived && !task.archived`,
    // so it must NOT run again.
    await archiveTaskTool.handler(
      { task_id: task.id },
      {} as any,
      makeContext(PROJECT),
    );
    expect(removeWorktreeCalls.length).toBe(1);
  });

  test('leaves the task unarchived on an active-conversation conflict and retries cleanup', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, branch_name: 'busy-tool-branch' }),
    );
    const conversation = await createConversation(PROJECT, {
      use_worktree: true,
      branch_name: 'busy-tool-branch',
    });
    const ownerId = `busy-tool-${conversation.id}`;
    await acquireConversationExecutionLease(conversation.id, ownerId);

    try {
      await expect(
        archiveTaskTool.handler(
          { task_id: task.id },
          {} as any,
          makeContext(PROJECT),
        ),
      ).rejects.toThrow(
        'Wait for the active conversation runs to finish first',
      );
      expect((await getTask(task.id))?.archived).toBe(false);
      expect(removeWorktreeCalls).toHaveLength(0);

      await releaseConversationExecutionLease(conversation.id, ownerId);
      await archiveTaskTool.handler(
        { task_id: task.id },
        {} as any,
        makeContext(PROJECT),
      );
      expect((await getTask(task.id))?.archived).toBe(true);
      expect(removeWorktreeCalls).toEqual([
        { taskId: 'busy-tool-branch', branch: 'busy-tool-branch' },
      ]);
    } finally {
      await releaseConversationExecutionLease(conversation.id, ownerId);
    }
  });

  test('refuses a running task without removing its worktree, then archives once the run ends', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, branch_name: 'running-tool-branch' }),
    );
    const run = runFixture({ group_folder: PROJECT, task_id: task.id });
    await insertActiveRun(run);

    await expect(
      archiveTaskTool.handler(
        { task_id: task.id },
        {} as any,
        makeContext(PROJECT),
      ),
    ).rejects.toThrow('Task is running; stop it before archiving');
    expect((await getTask(task.id))?.archived).toBe(false);
    expect(removeWorktreeCalls).toHaveLength(0);

    await completeActiveRun(run.id, 'completed');
    await archiveTaskTool.handler(
      { task_id: task.id },
      {} as any,
      makeContext(PROJECT),
    );
    expect((await getTask(task.id))?.archived).toBe(true);
    expect(removeWorktreeCalls).toHaveLength(1);
  });

  test('synthesizes a fallback branch_name when task.branch_name is null', async () => {
    // Mirrors the PATCH route's behavior at src/routes/tasks.ts:409 — if
    // branch_name is missing, the cleanup is keyed on `task-<id>`.
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    await archiveTaskTool.handler(
      { task_id: task.id },
      {} as any,
      makeContext(PROJECT),
    );
    expect(removeWorktreeCalls).toHaveLength(1);
    expect(removeWorktreeCalls[0].branch).toBe(`task-${task.id}`);
    expect((await getTask(task.id))!.archived).toBe(true);
  });
});

describe('update_task', () => {
  test('broadcasts the persisted updated task', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );

    await updateTaskTool.handler(
      { task_id: task.id, status: 'in_progress' },
      {} as any,
      makeContext(PROJECT),
    );

    const event = broadcastEvents.find(
      (candidate) => candidate.type === 'task_updated',
    );
    expect(event).toBeDefined();
    expect(event!.payload).toEqual(
      expect.objectContaining({
        id: task.id,
        status: 'in_progress',
        project_id: PROJECT,
      }),
    );
    expect(event!.payload).not.toBeInstanceOf(Promise);
  });

  test('rejects agent mutations while a task is in a testing stage', async () => {
    const task = await createTask(
      taskFixture({ project_id: 'arch-testing-proj', status: 'testing' }),
    );
    await expect(
      updateTaskTool.handler(
        { task_id: task.id, status: 'completed' },
        {} as any,
        makeContext('arch-testing-proj'),
      ),
    ).rejects.toThrow('Testing-stage tasks are read-only');
    expect((await getTask(task.id))?.status).toBe('testing');
  });
  test('rejects moving a task from backlog into a done stage', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );

    await expect(
      updateTaskTool.handler(
        { task_id: task.id, status: 'completed' },
        {} as any,
        makeContext(PROJECT),
      ),
    ).rejects.toThrow('Agents cannot move tasks into done stage "completed"');

    expect((await getTask(task.id))?.status).toBe('backlog');
    expect(broadcastEvents).toHaveLength(0);
  });
  test('serializes ab_variants edits against the execution claim write chain', async () => {
    const abProject = 'arch-ab-lock-proj';
    _archiveGroups[abProject] = {
      folder: abProject,
      settings: {
        defaultSandbox: 'carapa-bot',
        defaultSandboxInstance: 'test-instance',
        repositoryLocation: '/host/repo',
        taskCheckoutMode: 'worktree',
        stages: [
          { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
          { id: 'coding', title: 'Coding', type: 'active', color: '#36f' },
          { id: 'coding.b', title: 'Coding B', type: 'active', color: '#36f' },
          { id: 'completed', title: 'Completed', type: 'done', color: '#3f3' },
        ],
      },
    };
    const task = await createTask(
      taskFixture({ project_id: abProject, status: 'backlog' }),
    );
    // Hold the chain the way an in-flight write does; executeTask's post-claim
    // re-read awaits the same chain.
    let releaseChain!: () => void;
    const chainHeld = withStageVariantWriteLock(
      task.id,
      () => new Promise<void>((resolve) => (releaseChain = resolve)),
    );
    const heldTail = waitForStageVariantWrites(task.id);

    const edit = updateTaskTool.handler(
      { task_id: task.id, ab_variants: ['a', 'b'] },
      {} as any,
      makeContext(abProject),
    );
    // The edit is queued on the chain once the tail has advanced.
    while (waitForStageVariantWrites(task.id) === heldTail) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect((await getTask(task.id))?.ab_variants ?? null).toBeNull();

    releaseChain();
    await chainHeld;
    await edit;
    expect((await getTask(task.id))?.ab_variants).toEqual(['a', 'b']);
  });
  test('allows an automatic Testing-stage entry agent to hand off its task', async () => {
    await drizzleDbRef.current.insert(projects).values({
      id: 'arch-entry-testing-proj',
      jid: 'arch-entry-testing-proj@board',
      name: 'Testing entry project',
      folder: 'arch-entry-testing-proj',
      trigger: '@test',
      added_at: new Date().toISOString(),
      settings: JSON.stringify(
        _archiveGroups['arch-entry-testing-proj'].settings,
      ),
    });
    const task = await createTask(
      taskFixture({ project_id: 'arch-entry-testing-proj', status: 'backlog' }),
    );
    await updateTask(task.id, { status: 'testing' });
    const event = await claimNextStageEntryEvent(
      'arch-entry-testing-proj',
      '1970-01-01T00:00:00.000Z',
    );
    const run = runFixture({
      id: 'arch-entry-testing-run',
      group_folder: 'arch-entry-testing-proj',
      task_id: task.id,
      stage: 'testing',
    });
    await insertActiveRun(run);
    await markStageEntryEventRunning(event!.id, run.id);

    await updateTaskTool.handler(
      { task_id: task.id, status: 'in_progress' },
      {
        sendMessage: async () => {},
        getRegisteredGroups: () => ({}),
        registerGroup: () => {},
        updateGroup: () => {},
      },
      {
        ...makeContext('arch-entry-testing-proj'),
        task_id: task.id,
        run_id: run.id,
      },
    );

    expect((await getTask(task.id))?.status).toBe('in_progress');
  });
});

describe('create_task', () => {
  test('inherits the exact source run triggerer and lineage for agent-created tasks', async () => {
    const human = await createUser('agent-task-human', 'pw', 'user');
    const source = await createTask(
      taskFixture({ project_id: PROJECT, ownerUserId: human.id }),
    );
    const run = runFixture({ group_folder: PROJECT, task_id: source.id });
    run.triggeredByUserId = human.id;
    run.triggerSource = 'user';
    await insertActiveRun(run);

    const created = JSON.parse(
      await createTaskTool.handler({ title: 'created by agent' }, {} as any, {
        ...makeContext(PROJECT),
        task_id: source.id,
        run_id: run.id,
      }),
    ) as { id: string };
    const task = await getTask(created.id);

    expect(task).toMatchObject({
      ownerUserId: human.id,
      lastTriggeredByUserId: human.id,
      lastTriggerSource: 'agent',
      sourceRunId: run.id,
    });
  });

  test('appends an omitted priority and preserves an explicit priority', async () => {
    await createTask(taskFixture({ project_id: PROJECT, priority: 20 }));

    const appended = JSON.parse(
      await createTaskTool.handler(
        { title: 'appended task' },
        {} as any,
        makeContext(PROJECT),
      ),
    ) as { id: string };
    const explicit = JSON.parse(
      await createTaskTool.handler(
        { title: 'explicit priority task', priority: 0 },
        {} as any,
        makeContext(PROJECT),
      ),
    ) as { id: string };

    expect((await getTask(appended.id))?.priority).toBe(1020);
    expect((await getTask(explicit.id))?.priority).toBe(0);
  });

  test('rejects unknown stages', async () => {
    await expect(
      createTaskTool.handler(
        { title: 'invalid stage task', status: 'does_not_exist' },
        {} as any,
        makeContext(PROJECT),
      ),
    ).rejects.toThrow('Invalid stage');
  });
});

// ─── restore_task ────────────────────────────────────────────────────────────

describe('restore_task', () => {
  test('flips archived back to false', async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    await updateTask(task.id, { archived: true });
    expect((await getTask(task.id))!.archived).toBe(true);

    const result = await restoreTaskTool.handler(
      { task_id: task.id },
      {} as any,
      makeContext(PROJECT),
    );
    const parsed = JSON.parse(result);
    expect(parsed.archived).toBe(false);
    expect((await getTask(task.id))!.archived).toBe(false);
  });

  test('wakes the queue only when the restored task is in an executable stage', async () => {
    const drains: string[] = [];
    _testOnlySetTaskQueueDrainRunner(((projectId: string) => {
      drains.push(projectId);
      return Promise.resolve();
    }) as any);
    try {
      const idle = await createTask(
        taskFixture({ project_id: PROJECT, status: 'backlog' }),
      );
      await updateTask(idle.id, { archived: true });
      await restoreTaskTool.handler(
        { task_id: idle.id },
        {} as any,
        makeContext(PROJECT),
      );
      expect(drains).toEqual([]);

      const active = await createTask(
        taskFixture({ project_id: PROJECT, status: 'in_progress' }),
      );
      await updateTask(active.id, { archived: true });
      await restoreTaskTool.handler(
        { task_id: active.id },
        {} as any,
        makeContext(PROJECT),
      );
      expect(drains).toEqual([PROJECT]);
    } finally {
      _testOnlySetTaskQueueDrainRunner(null);
    }
  });

  test("throws Unauthorized when caller lacks tasks:write on the task's project", async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    await updateTask(task.id, { archived: true });
    let caught: Error | null = null;
    try {
      await restoreTaskTool.handler(
        { task_id: task.id },
        {} as any,
        makeContext(OTHER_PROJECT, {
          [OTHER_PROJECT]: ['tasks:read', 'tasks:write'],
        }),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Unauthorized/);
    // Task must still be archived.
    expect((await getTask(task.id))!.archived).toBe(true);
  });
});

// ─── list_tasks include_archived ─────────────────────────────────────────────

describe('list_tasks include_archived', () => {
  test('include_archived=true surfaces archived tasks', async () => {
    const live = await createTask(
      taskFixture({ project_id: PROJECT, title: 'live' }),
    );
    const dead = await createTask(
      taskFixture({ project_id: PROJECT, title: 'dead' }),
    );
    await updateTask(dead.id, { archived: true });

    const result = JSON.parse(
      await listTasksTool.handler(
        { project_id: PROJECT, include_archived: true },
        {} as any,
        makeContext(PROJECT),
      ),
    );
    const ids = result.map((t: { id: string }) => t.id);
    expect(ids).toContain(live.id);
    expect(ids).toContain(dead.id);
  });
});

describe('list_tasks ordering', () => {
  test('lists non-done stages first and done tasks newest completion first', async () => {
    const active = await createTask(
      taskFixture({
        project_id: PROJECT,
        title: 'active',
        status: 'in_progress',
        priority: 9,
      }),
    );
    // Ascending priority, but completion times run opposite to priority.
    const oldest = await createTask(
      taskFixture({
        project_id: PROJECT,
        title: 'oldest done',
        status: 'completed',
        priority: 1,
        completed_at: '2026-03-01T00:00:00.000Z',
      }),
    );
    const newest = await createTask(
      taskFixture({
        project_id: PROJECT,
        title: 'newest done',
        status: 'completed',
        priority: 3,
        completed_at: '2026-10-01T00:00:00.000Z',
      }),
    );
    const middle = await createTask(
      taskFixture({
        project_id: PROJECT,
        title: 'middle done',
        status: 'completed',
        priority: 2,
        completed_at: '2026-06-01T00:00:00.000Z',
      }),
    );

    const result = JSON.parse(
      await listTasksTool.handler(
        { project_id: PROJECT, limit: 50 },
        {} as any,
        makeContext(PROJECT),
      ),
    );
    expect(result.map((t: { id: string }) => t.id)).toEqual([
      active.id,
      newest.id,
      middle.id,
      oldest.id,
    ]);
  });
});
