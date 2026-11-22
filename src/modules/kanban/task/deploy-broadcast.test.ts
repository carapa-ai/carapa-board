/**
 * Tests for the deploy-stage task_updated broadcast in
 * src/modules/kanban/task/deploy.ts (triggerDeploy).
 *
 * After moving each deploy task to the deploy stage, triggerDeploy must
 * broadcast the persisted task row. The UI invalidates task queries from
 * payload.project_id, so a partial payload (e.g. spreading an un-awaited
 * getTask() Promise) degrades every client to a global task-list refetch
 * on each deploy.
 *
 * Top-level module mocks (process-global; this file is listed in
 * scripts/test-ci.sh's isolated_test_files for that reason). The ws-events
 * mock must be registered before the deploy module is first loaded, so
 * deploy is imported dynamically in beforeAll. Only the names the deploy
 * import graph binds from ws-events are provided.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { initDatabase, createTask, getTask } from '../../../db.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';

const broadcastEvents: Array<{ type: string; payload: any }> = [];

mock.module('../../objectives/ws-events.js', () => ({
  broadcast: mock((event: { type: string; payload: any }) => {
    broadcastEvents.push(event);
  }),
  getViewingDeviceIds: mock(async () => []),
  isConversationViewedByUser: mock(() => false),
}));

const project = 'deploy-broadcast-test';

const group: RegisteredGroup = {
  name: 'Deploy broadcast test',
  folder: project,
  trigger: '!deploy',
  added_at: new Date().toISOString(),
  settings: {
    enabledModes: ['kanban'],
    deployService: 'carapa-board',
    stages: [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      {
        id: 'in_progress',
        title: 'In Progress',
        type: 'active',
        color: '#00f',
      },
      { id: 'deploy', title: 'Deploy', type: 'done', color: '#888' },
      { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
    ],
  },
};

type TriggerDeploy = typeof import('./deploy.js').triggerDeploy;

let triggerDeploy: TriggerDeploy;
let initialized = false;

beforeAll(async () => {
  // Imported after the ws-events mock is registered so deploy.ts binds
  // the mocked broadcast.
  const deploy = await import('./deploy.js');
  triggerDeploy = deploy.triggerDeploy;
  await initDatabase(':memory:');
  initialized = true;
});

beforeEach(async () => {
  if (!initialized) throw new Error('test database was not initialized');
  await truncateTestDb();
  broadcastEvents.length = 0;
});

describe('deploy-stage task_updated broadcast', () => {
  test('broadcasts the persisted task row for a single auto-deploy', async () => {
    const task = await createTask(
      taskFixture({ project_id: project, status: 'in_progress' }),
    );

    await triggerDeploy(task, group, {
      skipMerge: true,
      lifecycleRunId: 'deploy-broadcast-test-run',
      buildService: async () => ({ isError: false, stdout: 'build ok' }),
      notifyLifecycle: async () => {},
    });

    expect((await getTask(task.id))?.status).toBe('deploy');

    const events = broadcastEvents.filter((e) => e.type === 'task_updated');
    expect(events).toHaveLength(1);
    // The payload must be the plain persisted row, not a Promise or a
    // partial object: the UI keys scoped invalidation off payload.project_id.
    const payload = events[0]!.payload;
    expect(payload).not.toBeInstanceOf(Promise);
    expect(payload).toMatchObject({
      id: task.id,
      project_id: project,
      status: 'deploy',
    });
  });

  test('broadcasts the persisted task row for every batched deploy task', async () => {
    const first = await createTask(
      taskFixture({ project_id: project, status: 'in_progress' }),
    );
    const second = await createTask(
      taskFixture({ project_id: project, status: 'in_progress' }),
    );

    await triggerDeploy(first, group, {
      skipMerge: true,
      batchTasks: [first, second],
      lifecycleRunIds: new Map([
        [first.id, 'run-1'],
        [second.id, 'run-2'],
      ]),
      buildService: async () => ({ isError: false, stdout: 'build ok' }),
      notifyLifecycle: async () => {},
    });

    const events = broadcastEvents.filter((e) => e.type === 'task_updated');
    expect(events).toHaveLength(2);
    const byId = new Map(events.map((e) => [e.payload.id, e.payload]));
    expect(byId.get(first.id)).toMatchObject({
      id: first.id,
      project_id: project,
      status: 'deploy',
    });
    expect(byId.get(second.id)).toMatchObject({
      id: second.id,
      project_id: project,
      status: 'deploy',
    });
  });
});

describe('deployFailureExcerpt', () => {
  test('keeps the tail of a long failed build log, where the error is', async () => {
    const { deployFailureExcerpt } = await import('./deploy.js');
    const log = `${'step output\n'.repeat(1_000)}ERROR: failed to solve: exit code 1`;
    const excerpt = deployFailureExcerpt(log);
    expect(excerpt).toContain('ERROR: failed to solve: exit code 1');
    expect(excerpt.length).toBeLessThan(1_600);
    expect(excerpt).toStartWith('... [truncated ');
    expect(deployFailureExcerpt('short log')).toBe('short log');
  });
});

describe('formatDeployLog', () => {
  test('caps successful logs to the tail but keeps failed logs whole', async () => {
    const { formatDeployLog } = await import('./deploy.js');
    const big = 'a'.repeat(100_000);
    const ok = formatDeployLog('svc', big, false);
    expect(ok.length).toBeLessThan(5_000);
    expect(ok).toContain('**Deploy svc:** SUCCESS');
    expect(ok).toContain('... [truncated 96000 chars]');
    const failed = formatDeployLog('svc', big, true);
    expect(failed).toContain('**Deploy svc:** FAILED');
    expect(failed.length).toBeGreaterThan(100_000);
  });
});
