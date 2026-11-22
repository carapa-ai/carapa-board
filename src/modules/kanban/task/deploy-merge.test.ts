import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTask, getTask, initDatabase, updateTask } from '../../../db.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import { countActiveServiceBuilds } from '../../../sandbox/service-builds.js';
import {
  flushDeploy,
  flushDeployBatch,
  mergeBranchForDeploy,
  queueDeploy,
  triggerDeploy,
  type DeployBatchDependencies,
  type DeployMergeDependencies,
} from './deploy.js';

const project = 'deploy-conflict-test';
const group: RegisteredGroup = {
  name: 'Deploy test',
  folder: project,
  trigger: '!deploy',
  added_at: new Date().toISOString(),
  settings: {
    enabledModes: ['kanban'],
    taskCheckoutMode: 'worktree',
    defaultBranch: 'develop',
    stages: [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      {
        id: 'in_progress',
        title: 'In Progress',
        type: 'active',
        color: '#00f',
      },
      { id: 'deploy', title: 'Deploy', type: 'done', color: '#888' },
    ],
  },
};
let initialized = false;
beforeAll(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
});
beforeEach(async () => {
  await truncateTestDb();
});

async function setup(result: any) {
  const task = await createTask(
    taskFixture({
      project_id: project,
      status: 'deploy',
      branch_name: 'task-branch',
      worktree_path: '/host/.worktrees/task-branch',
    }),
  );
  const messages: any[] = [];
  const broadcasts: any[] = [];
  const sources: string[] = [];
  const gitOperations: string[] = [];
  const dependencies: DeployMergeDependencies = {
    getTask,
    updateTask,
    commitTaskBranch: async () => {
      gitOperations.push('commit');
      return true;
    },
    appendTaskMessage: (_project, message) => {
      const saved = { id: 'message', ...message };
      messages.push(saved);
      return saved;
    },
    broadcast: (event) => broadcasts.push(event),
    mergeTaskBranchWithResolution: async (_task, _group, source) => {
      gitOperations.push('merge');
      sources.push(source);
      if (result.mergeOk)
        await updateTask(task.id, { branch_name: null, worktree_path: null });
      return result;
    },
  };
  return { task, dependencies, messages, broadcasts, sources, gitOperations };
}

describe('deploy merge conflict routing', () => {
  test.each([
    { label: 'success', isError: false, event: 'completed', status: 'deploy' },
    {
      label: 'build failure',
      isError: true,
      event: 'failed',
      status: 'failed',
    },
  ])(
    'emits the authoritative $event lifecycle notification for deploy $label',
    async ({ isError, event, status }) => {
      const task = await createTask(
        taskFixture({ project_id: project, status: 'deploy' }),
      );
      const notifications: any[] = [];
      const deployGroup: RegisteredGroup = {
        ...group,
        settings: {
          ...group.settings,
          deployService: 'carapa-board',
          stages: [
            ...(group.settings?.stages ?? []),
            { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
          ],
        },
      };

      await triggerDeploy(task, deployGroup, {
        lifecycleRunId: 'accepted-deploy-attempt',
        buildService: async () => ({ isError, stdout: 'build output' }),
        notifyLifecycle: async (args) => {
          notifications.push(args);
        },
      });

      expect((await getTask(task.id))?.status).toBe(status);
      expect(notifications).toEqual([
        expect.objectContaining({
          task_id: task.id,
          run_id: 'accepted-deploy-attempt',
          event,
        }),
      ]);
    },
  );

  test('emits failed lifecycle notification when the deploy call throws', async () => {
    const task = await createTask(
      taskFixture({ project_id: project, status: 'deploy' }),
    );
    const notifications: any[] = [];
    const deployGroup: RegisteredGroup = {
      ...group,
      settings: {
        ...group.settings,
        deployService: 'carapa-board',
        stages: [
          ...(group.settings?.stages ?? []),
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
        ],
      },
    };

    await triggerDeploy(task, deployGroup, {
      lifecycleRunId: 'throwing-deploy-attempt',
      buildService: async () => {
        throw new Error('sandbox unavailable');
      },
      notifyLifecycle: async (args) => {
        notifications.push(args);
      },
    });

    expect((await getTask(task.id))?.status).toBe('failed');
    expect(notifications).toEqual([
      expect.objectContaining({
        task_id: task.id,
        run_id: 'throwing-deploy-attempt',
        event: 'failed',
      }),
    ]);
  });

  test('merge conflict returns to implementation with a stage prompt', async () => {
    const h = await setup({
      mergeOk: false,
      failureKind: 'conflict',
      output: 'full merge output',
    });
    expect(
      await mergeBranchForDeploy(h.task, group, 'deploy_batch', h.dependencies),
    ).toBe(false);
    expect((await getTask(h.task.id))?.status).toBe('in_progress');
    expect(h.messages[0].content).toContain('full merge output');
    expect(h.messages[0].entry_type).toBe('stage_prompt');
    expect(h.messages[0].target_stage).toBe('in_progress');
    expect(h.messages[0].content).toContain('Merge `develop`');
    expect(h.broadcasts.some((event) => event.type === 'task_updated')).toBe(
      true,
    );
    expect(h.broadcasts.some((event) => event.type === 'task_message')).toBe(
      true,
    );
  });

  test('[env] failure parks the task and records a checkpoint notice', async () => {
    const h = await setup({
      mergeOk: false,
      failureKind: 'environment',
      output: '[env] dirty checkout',
    });
    expect(
      await mergeBranchForDeploy(h.task, group, 'deploy', h.dependencies),
    ).toBe(false);
    expect((await getTask(h.task.id))?.status).toBe('backlog');
    expect((await getTask(h.task.id))?.completed_at).toBeNull();
    expect(h.messages[0].content).toContain('Task checkpoint pending');
    expect(h.messages[0].content).toContain('[env] dirty checkout');
  });

  test('approval_required parks the task with the approval notice and no conflict rework', async () => {
    const h = await setup({
      mergeOk: false,
      failureKind: 'approval_required',
      output: '- `db-migration` — `drizzle/0001.sql`: Schema change',
      // What the gate attaches when it classifies the branch.
      approval: {
        headSha: 'a'.repeat(40),
        findings: [
          {
            ruleId: 'db-migration',
            file: 'drizzle/0001.sql',
            reason: 'Schema change',
          },
        ],
      },
    });
    expect(
      await mergeBranchForDeploy(h.task, group, 'deploy', h.dependencies),
    ).toBe(false);
    expect((await getTask(h.task.id))?.status).toBe('backlog');
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].entry_type).toBe('system_notice');
    expect(h.messages[0].content).toContain(
      '**Review approved, human approval required**',
    );
    expect(h.messages[0].content).toContain('drizzle/0001.sql');
  });

  test('non-deploy completion ignores unrelated default-checkout changes and retains the task branch', async () => {
    const h = await setup({
      mergeOk: false,
      failureKind: 'environment',
      output: '[env] default checkout is dirty',
      blockers: [
        {
          path: 'unrelated.txt',
          status: ' M',
          source: 'default-checkout-blocker',
          additions: 0,
          deletions: 0,
        },
      ],
    });

    expect(
      await mergeBranchForDeploy(h.task, group, 'completion', h.dependencies),
    ).toBe(true);
    expect((await getTask(h.task.id))?.branch_name).toBe('task-branch');
    expect(h.messages[0].content).toContain(
      'Task completed; integration pending',
    );
  });

  test('deploy remains blocked by unrelated default-checkout changes', async () => {
    const h = await setup({
      mergeOk: false,
      failureKind: 'environment',
      output: '[env] default checkout is dirty',
      blockers: [
        {
          path: 'unrelated.txt',
          status: ' M',
          source: 'default-checkout-blocker',
          additions: 0,
          deletions: 0,
        },
      ],
    });

    expect(
      await mergeBranchForDeploy(h.task, group, 'deploy', h.dependencies),
    ).toBe(false);
    expect((await getTask(h.task.id))?.status).toBe('backlog');
  });

  test('does not merge an older branch tip when the worktree commit fails', async () => {
    const h = await setup({ mergeOk: true, output: 'must not merge' });
    h.dependencies.commitTaskBranch = async () => {
      h.gitOperations.push('commit-failed');
      return false;
    };

    expect(
      await mergeBranchForDeploy(h.task, group, 'deploy', h.dependencies),
    ).toBe(false);
    expect(h.gitOperations).toEqual(['commit-failed']);
    expect((await getTask(h.task.id))?.status).toBe('backlog');
    expect((await getTask(h.task.id))?.completed_at).toBeNull();
    expect(h.messages[0].content).toContain('branch was not merged');
  });

  test('shared-checkout completion checkpoints the default branch without a task-branch commit', async () => {
    const task = await createTask(
      taskFixture({
        project_id: project,
        status: 'deploy',
        branch_name: null,
        worktree_path: null,
      }),
    );
    const operations: string[] = [];
    const dependencies: DeployMergeDependencies = {
      getTask,
      updateTask,
      commitTaskBranch: async () => {
        operations.push('task-branch-commit');
        return true;
      },
      appendTaskMessage: (_project, message) => ({
        id: 'message',
        ...message,
      }),
      broadcast: () => {},
      mergeTaskBranchWithResolution: async () => {
        operations.push('default-checkpoint');
        return { mergeOk: true, output: 'committed on develop' };
      },
    };
    const sharedGroup: RegisteredGroup = {
      ...group,
      settings: {
        ...group.settings,
        taskCheckoutMode: 'shared',
        repositoryLocation: '/host/project',
      },
    };

    expect(
      await mergeBranchForDeploy(task, sharedGroup, 'deploy', dependencies),
    ).toBe(true);
    expect(operations).toEqual(['default-checkpoint']);
  });

  test('a persisted task branch still commits and merges after the project setting is lost', async () => {
    const h = await setup({ mergeOk: true, output: 'merged legacy branch' });
    const settingsLostGroup: RegisteredGroup = {
      ...group,
      settings: {
        ...group.settings,
        taskCheckoutMode: 'shared',
        repositoryLocation: '/host/project',
      },
    };

    expect(
      await mergeBranchForDeploy(
        h.task,
        settingsLostGroup,
        'deploy',
        h.dependencies,
      ),
    ).toBe(true);
    expect(h.gitOperations).toEqual(['commit', 'merge']);
  });

  test('mixed batches still deploy and finalize the successfully merged subset', async () => {
    const failed = await createTask(
      taskFixture({
        project_id: project,
        status: 'deploy',
        branch_name: 'failed-branch',
        worktree_path: '/host/.worktrees/failed-branch',
      }),
    );
    const mergedOne = await createTask(
      taskFixture({
        project_id: project,
        status: 'deploy',
        branch_name: 'merged-one',
        worktree_path: '/host/.worktrees/merged-one',
      }),
    );
    const mergedTwo = await createTask(
      taskFixture({
        project_id: project,
        status: 'deploy',
        branch_name: 'merged-two',
        worktree_path: '/host/.worktrees/merged-two',
      }),
    );
    const deployedBatches: string[][] = [];
    const dependencies: DeployBatchDependencies = {
      getTask,
      mergeBranchForDeploy: async (task) => {
        if (task.id === failed.id) return false;
        await updateTask(task.id, { branch_name: null, worktree_path: null });
        return true;
      },
      triggerDeploy: async (_task, _group, options) => {
        const batch = options?.batchTasks ?? [];
        deployedBatches.push(batch.map((item) => item.id));
        for (const item of batch) {
          await updateTask(item.id, {
            completed_at: new Date().toISOString(),
          });
        }
        return true;
      },
    };

    await flushDeployBatch(
      [failed, mergedOne, mergedTwo],
      {
        ...group,
        settings: { ...group.settings, deployService: 'carapa-board' },
      },
      dependencies,
    );

    expect(deployedBatches).toEqual([[mergedOne.id, mergedTwo.id]]);
    expect((await getTask(mergedOne.id))?.branch_name).toBeNull();
    expect((await getTask(mergedTwo.id))?.branch_name).toBeNull();
    expect((await getTask(mergedOne.id))?.completed_at).not.toBeNull();
    expect((await getTask(mergedTwo.id))?.completed_at).not.toBeNull();
    expect((await getTask(failed.id))?.branch_name).toBe('failed-branch');
    expect((await getTask(failed.id))?.completed_at).toBeNull();
  });
  test('holds the project lease across every queued branch merge', async () => {
    const h = await setup({ mergeOk: true, output: 'merged' });
    const events: string[] = [];
    let held = false;
    await flushDeployBatch([h.task], group, {
      getTask,
      mergeBranchForDeploy: async (_task, _group, _source, _deps, options) => {
        expect(options?.leaseAlreadyHeld).toBe(true);
        expect(held).toBe(true);
        events.push('merge');
        return true;
      },
      triggerDeploy: async () => true,
      acquireSharedCheckoutLease: async () => {
        held = true;
        events.push('acquire');
        return {
          projectId: project,
          owner: { type: 'task' as const, id: 'batch' },
          heartbeat: async () => true,
          release: async () => {
            held = false;
            events.push('release');
          },
        };
      },
    });
    expect(events).toEqual(['acquire', 'merge', 'release']);
    expect(held).toBe(false);
  });
});

describe('queued deploy build hold', () => {
  const deployGroup = (folder: string): RegisteredGroup => ({
    ...group,
    folder,
    settings: { ...group.settings, deployService: 'carapa-board' },
  });
  const queued = async (folder: string) =>
    createTask(taskFixture({ project_id: folder, status: 'deploy' }));
  const batchDeps = (
    overrides: Partial<DeployBatchDependencies> = {},
  ): DeployBatchDependencies => ({
    getTask,
    mergeBranchForDeploy: async () => true,
    triggerDeploy: async () => true,
    ...overrides,
  });

  test('counts a queued batch as building until the build settles', async () => {
    const folder = 'deploy-hold-batch';
    const first = await queued(folder);
    const second = await queued(folder);
    let finishBuild!: () => void;
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => (buildStarted = resolve));
    const countsDuringBuild: number[] = [];
    const dependencies = batchDeps({
      triggerDeploy: async () => {
        countsDuringBuild.push(countActiveServiceBuilds());
        buildStarted();
        await new Promise<void>((resolve) => (finishBuild = resolve));
        return true;
      },
    });
    const g = deployGroup(folder);
    expect(countActiveServiceBuilds()).toBe(0);
    queueDeploy(first, g, undefined, undefined, dependencies);
    queueDeploy(second, g, undefined, undefined, dependencies);
    // One hold for the whole batch, taken before the debounce fires.
    expect(countActiveServiceBuilds()).toBe(1);
    const flushed = flushDeploy(folder);
    await started;
    expect(countsDuringBuild).toEqual([1]);
    finishBuild();
    await flushed;
    expect(countActiveServiceBuilds()).toBe(0);
  });

  const exitPaths: Array<[string, Partial<DeployBatchDependencies>]> = [
    ['no ready tasks', { mergeBranchForDeploy: async () => false }],
    [
      'merge throws',
      {
        mergeBranchForDeploy: async () => {
          throw new Error('merge boom');
        },
      },
    ],
    [
      'build throws',
      {
        triggerDeploy: async () => {
          throw new Error('build boom');
        },
      },
    ],
    ['build fails', { triggerDeploy: async () => false }],
  ];
  for (const [name, overrides] of exitPaths) {
    test(`releases the hold when ${name}`, async () => {
      const folder = `deploy-hold-${name.replace(/\s+/g, '-')}`;
      // Merging only runs for tasks that need the shared checkout.
      const task = await createTask(
        taskFixture({
          project_id: folder,
          status: 'deploy',
          branch_name: 'task-branch',
        }),
      );
      queueDeploy(
        task,
        deployGroup(folder),
        undefined,
        undefined,
        batchDeps({
          acquireSharedCheckoutLease: async () => undefined as never,
          ...overrides,
        }),
      );
      expect(countActiveServiceBuilds()).toBe(1);
      await flushDeploy(folder);
      expect(countActiveServiceBuilds()).toBe(0);
    });
  }

  test('releases the hold when the batch flush itself throws', async () => {
    const folder = 'deploy-hold-flush-throws';
    const task = await queued(folder);
    queueDeploy(
      task,
      deployGroup(folder),
      undefined,
      undefined,
      batchDeps({
        getTask: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(countActiveServiceBuilds()).toBe(1);
    await expect(flushDeploy(folder)).rejects.toThrow('db down');
    expect(countActiveServiceBuilds()).toBe(0);
  });

  test('does not hold for a group without a deploy service', async () => {
    const folder = 'deploy-hold-no-service';
    const task = await queued(folder);
    queueDeploy(task, { ...group, folder }, undefined, undefined, batchDeps());
    expect(countActiveServiceBuilds()).toBe(0);
    await flushDeploy(folder);
    expect(countActiveServiceBuilds()).toBe(0);
  });

  test('triggerDeploy counts the work before the build and releases after', async () => {
    const folder = 'deploy-hold-trigger';
    const task = await queued(folder);
    let duringBuild = 0;
    const result = await triggerDeploy(task, deployGroup(folder), {
      skipMerge: true,
      buildService: async () => {
        duringBuild = countActiveServiceBuilds();
        return { isError: false, stdout: 'ok' };
      },
      notifyLifecycle: (async () => undefined) as any,
    });
    expect(result).toBe(true);
    expect(duringBuild).toBeGreaterThanOrEqual(1);
    expect(countActiveServiceBuilds()).toBe(0);
  });
});
