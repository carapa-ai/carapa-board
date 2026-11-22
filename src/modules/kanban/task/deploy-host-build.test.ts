import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import fs from 'fs';
import { createTask, getTask, initDatabase } from '../../../db.js';
import { getGroupDir } from '../../../group-dir.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import { readTaskMessages } from '../../transcripts/transcript-store.js';
import { countActiveServiceBuilds } from '../../../sandbox/service-builds.js';
import { isPipelineOwnedValueKey } from '../pipeline-owned-values.js';
import {
  buildManagedService,
  DEPLOY_HOST_BUILD_KEY,
  isHeldByBootDeployDispatch,
  recoverPendingHostBuilds,
  triggerDeploy,
} from './deploy.js';

const project = 'deploy-host-build-test';
const group: RegisteredGroup = {
  name: 'Deploy host build test',
  folder: project,
  trigger: '!deploy',
  added_at: new Date().toISOString(),
  settings: {
    enabledModes: ['kanban'],
    deployService: 'carapa-board',
    stages: [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      { id: 'deploy', title: 'Deploy', type: 'done', color: '#888' },
      { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
    ],
  },
};

const HOUR = 60 * 60_000;
const request = { service: 'carapa-board', requestedAt: 'req-1' };
const succeeded = JSON.stringify({ state: 'succeeded', exitCode: 0 });

beforeAll(async () => {
  await initDatabase(':memory:');
});
beforeEach(async () => {
  await truncateTestDb();
});
afterAll(() => {
  fs.rmSync(getGroupDir(project), { recursive: true, force: true });
});

function queuedCall(
  statusReply: () => Promise<{ isError: boolean; stdout: string }>,
) {
  return async (name: string) =>
    name === 'build_service'
      ? {
          isError: false,
          stdout: JSON.stringify({ status: 'queued', requestedAt: 'req-1' }),
        }
      : statusReply();
}

async function pendingTask(queuedAt: number) {
  return createTask(
    taskFixture({
      project_id: project,
      status: 'deploy',
      custom_values: {
        [DEPLOY_HOST_BUILD_KEY]: JSON.stringify({ ...request, queuedAt }),
      },
    }),
  );
}

describe('host build polling', () => {
  test('a status call that never resolves cannot block the pickup timeout', async () => {
    let clock = 0;
    const result = await buildManagedService(
      'carapa-board',
      queuedCall(() => new Promise(() => {})),
      undefined,
      async (ms) => {
        clock += ms + 1;
      },
      () => clock,
      1,
    );
    expect(result.isError).toBe(true);
    expect(result.stdout).toContain('did not pick up the request');
  });

  test('queuing stores deploy_host_build on every batch task and the outcome clears it', async () => {
    const tasks = [
      await createTask(taskFixture({ project_id: project, status: 'deploy' })),
      await createTask(taskFixture({ project_id: project, status: 'deploy' })),
    ];
    let whileWaiting: unknown[] = [];
    await triggerDeploy(tasks[0]!, group, {
      skipMerge: true,
      batchTasks: tasks,
      notifyLifecycle: async () => {},
      hostBuild: {
        sleep: async () => {},
        callTool: queuedCall(async () => {
          whileWaiting = await Promise.all(
            tasks.map(
              async (t) =>
                (await getTask(t.id))?.custom_values?.[DEPLOY_HOST_BUILD_KEY],
            ),
          );
          return { isError: false, stdout: succeeded };
        }),
      },
    });
    for (const stored of whileWaiting) {
      expect(JSON.parse(stored as string)).toMatchObject(request);
    }
    expect(whileWaiting).toHaveLength(2);
    for (const t of tasks) {
      expect(
        (await getTask(t.id))?.custom_values?.[DEPLOY_HOST_BUILD_KEY],
      ).toBe(undefined);
    }
  });
});

describe('host build recovery after restart', () => {
  test('a succeeded build writes the live SUCCESS outcome once per task and clears the key', async () => {
    const task = await pendingTask(1_000);
    const notifications: any[] = [];
    const resumed = await recoverPendingHostBuilds({
      groups: () => [group],
      now: () => 2_000,
      sleep: async () => {},
      callTool: async () => ({ isError: false, stdout: succeeded }),
      notifyLifecycle: async (args) => {
        notifications.push(args);
      },
    });
    expect(countActiveServiceBuilds()).toBe(1);
    await Promise.all(resumed);

    const saved = await getTask(task.id);
    expect(saved?.completed_at).toBeTruthy();
    expect(saved?.custom_values?.[DEPLOY_HOST_BUILD_KEY]).toBeUndefined();
    expect(notifications).toEqual([
      expect.objectContaining({ task_id: task.id, event: 'completed' }),
    ]);
    expect(
      readTaskMessages(project, task.id).some((m) =>
        m.content.startsWith('**Deploy carapa-board:** SUCCESS'),
      ),
    ).toBe(true);
    expect(countActiveServiceBuilds()).toBe(0);
  });

  test('a resumed build holds a card in an active deploy stage from the queue, also after the build', async () => {
    const activeGroup: RegisteredGroup = {
      ...group,
      settings: {
        ...group.settings!,
        deployStage: 'deploy',
        stages: [
          ...group.settings!.stages!.map((stage) =>
            stage.id === 'deploy'
              ? { ...stage, type: 'active' as const }
              : stage,
          ),
          { id: 'done', title: 'Done', type: 'done', color: '#0f0' },
        ],
      },
    };
    const task = await pendingTask(1_000);
    const resumed = await recoverPendingHostBuilds({
      groups: () => [activeGroup],
      now: () => 2_000,
      sleep: async () => {},
      callTool: async () => ({ isError: false, stdout: succeeded }),
      notifyLifecycle: async () => {},
    });
    expect(isHeldByBootDeployDispatch(task)).toBe(true);
    await Promise.all(resumed);
    const saved = (await getTask(task.id))!;
    expect(saved.status).toBe('deploy');
    expect(isHeldByBootDeployDispatch(saved)).toBe(true);
  });

  test('a failed build writes the failure outcome', async () => {
    const task = await pendingTask(1_000);
    await Promise.all(
      await recoverPendingHostBuilds({
        groups: () => [group],
        now: () => 2_000,
        sleep: async () => {},
        callTool: async () => ({
          isError: false,
          stdout: JSON.stringify({ state: 'failed', exitCode: 2 }),
        }),
        notifyLifecycle: async () => {},
      }),
    );
    expect((await getTask(task.id))?.status).toBe('failed');
    expect(
      readTaskMessages(project, task.id).some((m) =>
        m.content.startsWith('**Deploy carapa-board:** FAILED'),
      ),
    ).toBe(true);
  });

  test('a request older than 3 hours times out without polling', async () => {
    const task = await pendingTask(0);
    let polled = false;
    await Promise.all(
      await recoverPendingHostBuilds({
        groups: () => [group],
        now: () => 4 * HOUR,
        sleep: async () => {},
        callTool: async () => {
          polled = true;
          return { isError: false, stdout: succeeded };
        },
        notifyLifecycle: async () => {},
      }),
    );
    expect(polled).toBe(false);
    const saved = await getTask(task.id);
    expect(saved?.status).toBe('failed');
    expect(saved?.error).toContain('3 hours');
    expect(saved?.custom_values?.[DEPLOY_HOST_BUILD_KEY]).toBeUndefined();
  });
});

test('deploy_host_build is pipeline-owned', () => {
  expect(isPipelineOwnedValueKey(DEPLOY_HOST_BUILD_KEY)).toBe(true);
});
