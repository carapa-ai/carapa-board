import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../../../config.js';
import { drizzleDbRef } from '../../../db/drizzle-client.js';
import { projects } from '../../../db/schema.js';
import { createTask, getTask, initDatabase } from '../../../db.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import { spawnAbVariantsInDb, updateTask } from '../db-kanban.js';
import type { Task } from '../types.js';
import { AbWinnerError, pickAbWinner } from './ab-winner.js';
import {
  mergeBranchForDeploy,
  type DeployMergeDependencies,
} from './deploy.js';
import { mergeTaskBranchWithResolution } from './merge-conflict-resolution.js';
import { getUnmetDependencies } from '../../../routes/_helpers.js';
import { executeTask } from './pipeline.js';

const PROJECT_ID = 'ab-winner-test-group';

const group: RegisteredGroup = {
  name: 'AB Winner',
  folder: PROJECT_ID,
  trigger: '!abw',
  added_at: new Date().toISOString(),
  settings: {
    enabledModes: ['kanban'],
    taskCheckoutMode: 'worktree',
    repositoryLocation: '/tmp/ab-winner-repo',
    defaultBranch: 'develop',
    stages: [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      { id: 'coding', title: 'Coding', type: 'active', color: '#00f' },
      { id: 'coding.b', title: 'Coding B', type: 'active', color: '#00f' },
      { id: 'completed', title: 'Completed', type: 'done', color: '#0f0' },
    ],
  },
};

const deployGroup: RegisteredGroup = {
  ...group,
  settings: {
    ...group.settings,
    deployService: 'ab-winner-service',
    deployStage: 'deploy',
    // The deploy stage precedes the plain done stage, so only the exclusion
    // keeps the parent out of it.
    stages: [
      ...group.settings!.stages!.filter((st) => st.type !== 'done'),
      { id: 'deploy', title: 'Deploy', type: 'done', color: '#0ff' },
      ...group.settings!.stages!.filter((st) => st.type === 'done'),
    ],
  },
};

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await truncateTestDb();
  await drizzleDbRef.current
    .insert(projects)
    .values({
      id: PROJECT_ID,
      jid: `${PROJECT_ID}@board`,
      name: group.name,
      folder: PROJECT_ID,
      trigger: '@test',
      added_at: new Date().toISOString(),
      settings: JSON.stringify(group.settings),
    })
    .onConflictDoNothing();
});

afterAll(() => {
  fs.rmSync(path.join(GROUPS_DIR, PROJECT_ID), {
    recursive: true,
    force: true,
  });
});

const COMPLETED_AT = '2026-01-02T03:04:05.000Z';

/** An experiment parent forked into two done children. */
async function forkedExperiment() {
  const parent = await createTask(
    taskFixture({
      project_id: PROJECT_ID,
      status: 'coding',
      ab_variants: ['a', 'b'],
      abVariants: ['a', 'b'],
    } as any),
  );
  const children = await spawnAbVariantsInDb(parent, 'coding', 'f'.repeat(40), {
    status: 'coding',
    variants: ['a', 'b'],
  });
  expect(children).toHaveLength(2);
  for (const child of children) {
    await updateTask(child.id, {
      status: 'completed',
      completed_at: COMPLETED_AT,
      branch_name: `branch-${child.id}`,
      worktree_path: `.worktrees/branch-${child.id}`,
    });
  }
  return { parent, children };
}

/**
 * Real merge gate and deploy merge path; only Git itself is stubbed. Records
 * which branches reach `mergeTaskBranchToDefault`.
 */
function mergeHarness(gitResult: {
  mergeOk: boolean;
  failureKind?: 'conflict' | 'environment';
  output: string;
}) {
  const merged: string[] = [];
  const drained: string[] = [];
  const published: Array<{ url: string | null; event: any }> = [];
  const deployDeps: DeployMergeDependencies = {
    getTask,
    updateTask,
    commitTaskBranch: async () => true,
    appendTaskMessage: (_project, message) => ({ id: 'm', ...message }) as any,
    broadcast: () => {},
    mergeTaskBranchWithResolution: (task, g, source, _deps, options) =>
      mergeTaskBranchWithResolution(
        task,
        g,
        source,
        {
          mergeTaskBranchToDefault: async (t) => {
            merged.push(t.id);
            return gitResult;
          },
          withProjectGitLock: (_project, fn) => fn(),
          // No rules file on the default branch: the merge risk gate is off.
          riskGate: {
            runGit: async () => ({ ok: true, output: '' }),
            isMergeApproved: async () => false,
          },
        },
        { ...options, leaseAlreadyHeld: true },
      ),
  };
  return {
    merged,
    drained,
    published,
    deps: {
      mergeBranchForDeploy: (
        task: Task,
        g: RegisteredGroup,
        source: Parameters<typeof mergeBranchForDeploy>[2],
        _d: unknown,
        options?: Parameters<typeof mergeBranchForDeploy>[4],
      ) => mergeBranchForDeploy(task, g, source, deployDeps, options),
      drainQueue: (projectId: string) => {
        drained.push(projectId);
      },
      broadcast: () => {},
      publishEvent: ((url: string | null, event: unknown) => {
        published.push({ url, event });
      }) as any,
      resolveBrainUrl: () => 'http://brain.test',
      resolveBrainContainer: () => 'brain',
    },
  };
}

describe('pickAbWinner', () => {
  test.each([
    ['without deployService', group],
    ['with deployService', deployGroup],
  ] as const)(
    'merges only the winner, completes the parent and releases dependents (%s)',
    async (_label, g) => {
      const { parent, children } = await forkedExperiment();
      const [winner, loser] = children;
      const dependent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          status: 'backlog',
          depends_on_ids: [parent.id],
          branch_name: 'task/after-experiment',
        }),
      );
      expect(await getUnmetDependencies(dependent)).toEqual([parent.id]);
      // The winner's durable content identity, as recorded when it completed.
      const winnerCommit = 'c'.repeat(40);
      const defaultCommit = 'd'.repeat(40);
      await updateTask(winner.id, {
        branch_name: null,
        custom_values: {
          testing_head_sha: winnerCommit,
          completed_commit_sha: winnerCommit,
        },
      });
      const h = mergeHarness({ mergeOk: true, output: 'ok' });

      const result = await pickAbWinner(g, parent.id, winner.id, h.deps);

      expect(h.merged).toEqual([winner.id]);
      expect(result.status).toBe('completed');
      const stored = await getTask(parent.id);
      expect(stored?.ab_winner_task_id).toBe(winner.id);
      expect(stored?.status).toBe('completed');
      // Picking only merges: no deploy is started, so the winner keeps its done
      // stage and the parent never lands in the deploy stage.
      expect((await getTask(winner.id))?.status).toBe('completed');
      expect((await getTask(loser.id))?.status).toBe('completed');
      expect(await getUnmetDependencies(dependent)).toEqual([]);
      expect(h.drained).toEqual([PROJECT_ID]);
      // One Brain event, for the winner only, whether or not a deployService exists.
      expect(h.published).toHaveLength(1);
      expect(h.published[0].url).toBe('http://brain.test');
      expect(h.published[0].event).toMatchObject({
        type: 'task_completed',
        project_id: PROJECT_ID,
        task_id: winner.id,
        objective_id: winner.objective_id ?? null,
        data: {
          status: 'completed',
          ab_winner: true,
          ab_parent_task_id: parent.id,
        },
      });

      // The parent has no branch or commit of its own: the dependent's checkout
      // is prepared from the merged winner's content.
      let prepared: { requiredDependencyCommits?: string[] } | undefined;
      await executeTask(dependent, g, {
        testDependencies: {
          runGitInRepo: async (_group, command) => {
            if (command === 'rev-parse --verify develop^{commit}')
              return { ok: true, output: defaultCommit };
            if (command === 'rev-parse --verify task/after-experiment^{commit}')
              return { ok: false, output: 'missing task branch' };
            if (command === `rev-parse --verify ${winnerCommit}^{commit}`)
              return { ok: true, output: winnerCommit };
            if (
              command ===
                `merge-base --is-ancestor ${winnerCommit} ${defaultCommit}` ||
              command ===
                `merge-base --is-ancestor ${defaultCommit} ${defaultCommit}`
            )
              return { ok: true, output: '' };
            return { ok: false, output: `unexpected command: ${command}` };
          },
          runContainerAgent: async (_group, input) => {
            prepared = await input.prepareCheckout?.();
            return {
              status: 'error',
              result: null,
              error: 'stop after checkout',
            };
          },
          drainProjectQueue: async () => {},
        },
      });
      expect(prepared?.requiredDependencyCommits).toEqual([winnerCommit]);
    },
  );

  test('two concurrent picks produce exactly one winner', async () => {
    const { parent, children } = await forkedExperiment();
    const h = mergeHarness({ mergeOk: true, output: 'ok' });

    const results = await Promise.allSettled(
      children.map((child) => pickAbWinner(group, parent.id, child.id, h.deps)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AbWinnerError);
    expect((rejected[0].reason as AbWinnerError).statusCode).toBe(409);
    expect(h.merged).toHaveLength(1);
    expect((await getTask(parent.id))?.ab_winner_task_id).toBe(h.merged[0]);
  });

  test('rejects a variant that is not done and a task from another experiment', async () => {
    const { parent, children } = await forkedExperiment();
    const other = await forkedExperiment();
    await updateTask(children[0].id, { status: 'coding' });
    const h = mergeHarness({ mergeOk: true, output: 'ok' });

    for (const taskId of [children[0].id, other.children[0].id]) {
      const error = await pickAbWinner(group, parent.id, taskId, h.deps).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(AbWinnerError);
      expect((error as AbWinnerError).statusCode).toBe(400);
    }
    expect(h.merged).toEqual([]);
    expect((await getTask(parent.id))?.ab_winner_task_id).toBeFalsy();
  });

  test.each([
    {
      label: 'environment failure',
      git: { mergeOk: false, failureKind: 'environment', output: 'dirty' },
    },
    {
      label: 'merge conflict',
      git: { mergeOk: false, failureKind: 'conflict', output: 'CONFLICT' },
    },
  ] as const)(
    'clears the winner and leaves the parent open on $label',
    async ({ git }) => {
      const { parent, children } = await forkedExperiment();
      const h = mergeHarness({ ...git });

      const error = await pickAbWinner(
        group,
        parent.id,
        children[0].id,
        h.deps,
      ).catch((e) => e);

      expect(error).toBeInstanceOf(AbWinnerError);
      expect((error as AbWinnerError).statusCode).toBe(409);
      expect(h.published).toEqual([]);
      const stored = await getTask(parent.id);
      expect(stored?.ab_winner_task_id).toBeFalsy();
      expect(stored?.status).toBe('coding');
      const variant = await getTask(children[0].id);
      if (git.failureKind === 'conflict') {
        // The conflict path reuses the ordinary rework routing for the variant.
        expect(variant?.status).toBe('coding');
        // A retry is admitted once the variant is done again.
        await updateTask(children[0].id, { status: 'completed' });
      } else {
        // An environment failure leaves the variant done and selectable.
        expect(variant?.status).toBe('completed');
        expect(variant?.completed_at).toBe(COMPLETED_AT);
      }
      const retry = mergeHarness({ mergeOk: true, output: 'ok' });
      await pickAbWinner(group, parent.id, children[0].id, retry.deps);
      expect((await getTask(parent.id))?.ab_winner_task_id).toBe(
        children[0].id,
      );
    },
  );
});
