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
import { initDatabase } from '../../../db.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import {
  createTask,
  getAbChildTasks,
  getTask,
  spawnAbVariantsInDb,
  updateTask,
} from '../db-kanban.js';
import {
  computeAbForkStage,
  getGroupStages,
  hasStageAlternative,
  isAbExperimentChild,
  isAbExperimentParent,
  isAbExperimentTask,
  resolveStageForTask,
  validateAbVariants,
} from '../stages.js';
import type { Task } from '../types.js';
import { flushDeployBatch, triggerDeploy } from './deploy.js';
import { completeApprovedMerge } from './review.js';
import { mergeTaskForManualCompletion } from './manual-completion.js';
import { mergeTaskBranchWithResolution } from './merge-conflict-resolution.js';
import { getBranchNameForTask } from '../../../lib/git-ops.js';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../../db/drizzle-client.js';
import { projects, stageEntryEvents } from '../../../db/schema.js';
import {
  executeTask,
  isTaskExecutionClaimed,
  spawnAbVariants,
  taskQueueHoldReason,
} from './pipeline.js';

const PROJECT_ID = 'ab-experiments-test-group';

const groupWithVariants: RegisteredGroup = {
  name: 'AB Test Group',
  folder: PROJECT_ID,
  trigger: '!ab',
  added_at: new Date().toISOString(),
  settings: {
    enabledModes: ['kanban'],
    taskCheckoutMode: 'worktree',
    repositoryLocation: '/tmp/ab-experiments-repo',
    defaultBranch: 'develop',
    stages: [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      { id: 'coding', title: 'Coding', type: 'active', color: '#00f' },
      {
        id: 'coding.b',
        title: 'Coding B',
        type: 'active',
        color: '#00f',
        runtimeSelection: {
          harnessId: 'test',
          modelId: 'variant-b-model',
        },
      },
      { id: 'coding.d', title: 'Coding D', type: 'active', color: '#00f' },
      { id: 'testing', title: 'Testing', type: 'testing', color: '#a0f' },
      { id: 'review', title: 'Review', type: 'review', color: '#f80' },
      { id: 'review.x', title: 'Review X', type: 'review', color: '#f80' },
      { id: 'completed', title: 'Completed', type: 'done', color: '#0f0' },
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
  await drizzleDbRef.current
    .insert(projects)
    .values({
      id: PROJECT_ID,
      jid: `${PROJECT_ID}@board`,
      name: 'AB Test Group',
      folder: PROJECT_ID,
      trigger: '@test',
      added_at: new Date().toISOString(),
      settings: JSON.stringify(groupWithVariants.settings || {}),
    })
    .onConflictDoNothing();
});

afterAll(() => {
  fs.rmSync(path.join(GROUPS_DIR, PROJECT_ID), {
    recursive: true,
    force: true,
  });
});

describe('A/B Testing Experiments', () => {
  describe('1. Fork-stage table and divergence calculation', () => {
    test('computes fork stage correctly for variant combinations', () => {
      // A+B+C: alternative coding.b exists for coding -> divergence at coding
      expect(computeAbForkStage(groupWithVariants, ['A', 'B', 'C'])).toBe(
        'coding',
      );

      // A+X: review.x is a review alternative (a co-stage), not a variant -> no fork stage
      expect(computeAbForkStage(groupWithVariants, ['A', 'X'])).toBeUndefined();
      const rejected = validateAbVariants(groupWithVariants, ['A', 'X']);
      expect(rejected.valid).toBe(false);
      if (!rejected.valid) {
        expect(rejected.error).toBe(
          'Variant "x" has no coding stage alternative; use co_stages for review/testing alternatives',
        );
      }
      // A+B+X: the review-only variant does not change the fork stage
      expect(computeAbForkStage(groupWithVariants, ['A', 'B', 'X'])).toBe(
        'coding',
      );

      // A+D: coding.d exists for coding -> divergence at coding
      expect(computeAbForkStage(groupWithVariants, ['A', 'D'])).toBe('coding');

      // Empty or single variant -> no fork stage
      expect(computeAbForkStage(groupWithVariants, ['A'])).toBeUndefined();
      expect(computeAbForkStage(groupWithVariants, [])).toBeUndefined();
      expect(computeAbForkStage(groupWithVariants, null)).toBeUndefined();
    });
  });

  describe('2. Worktree-mode requirement and ab_variants validation', () => {
    test('enforces taskCheckoutMode to be worktree', () => {
      const sharedGroup: RegisteredGroup = {
        ...groupWithVariants,
        settings: {
          ...groupWithVariants.settings,
          taskCheckoutMode: 'shared',
        },
      };

      const resShared = validateAbVariants(sharedGroup, ['A', 'B']);
      expect(resShared.valid).toBe(false);
      if (!resShared.valid) {
        expect(resShared.error).toContain(
          'A/B testing experiments require taskCheckoutMode to be "worktree"',
        );
      }

      // Worktree mode with only a remote URL cannot create per-variant worktrees.
      const urlOnlyGroup: RegisteredGroup = {
        ...groupWithVariants,
        settings: {
          ...groupWithVariants.settings,
          repositoryLocation: undefined,
          repositoryUrl: 'https://example.invalid/repo.git',
        },
      };
      const resUrlOnly = validateAbVariants(urlOnlyGroup, ['A', 'B']);
      expect(resUrlOnly.valid).toBe(false);
      if (!resUrlOnly.valid) {
        expect(resUrlOnly.error).toContain('local repository');
      }

      const resWorktree = validateAbVariants(groupWithVariants, ['A', 'B']);
      expect(resWorktree.valid).toBe(true);
      if (resWorktree.valid) {
        expect(resWorktree.variants).toEqual(['a', 'b']);
      }
    });

    test('rejects invalid variant inputs', () => {
      // Unconfigured variant
      expect(
        validateAbVariants(groupWithVariants, ['A', 'nonexistent']).valid,
      ).toBe(false);
      // Single variant
      expect(validateAbVariants(groupWithVariants, ['A']).valid).toBe(false);
      // Empty array
      expect(validateAbVariants(groupWithVariants, []).valid).toBe(false);
      // Duplicate variants
      expect(validateAbVariants(groupWithVariants, ['A', 'A']).valid).toBe(
        false,
      );
      // Non-array
      expect(validateAbVariants(groupWithVariants, 'A,B').valid).toBe(false);
      // Invalid characters
      expect(validateAbVariants(groupWithVariants, ['a', 'b$c']).valid).toBe(
        false,
      );
    });

    test('rejects editing ab_variants after fork or outside queue stage', () => {
      // Already forked
      const resForked = validateAbVariants(groupWithVariants, ['A', 'B'], {
        status: 'backlog',
        ab_fork_commit: 'abc1234',
      });
      expect(resForked.valid).toBe(false);
      if (!resForked.valid) {
        expect(resForked.error).toContain('already forked');
      }

      // Active stage
      const resActive = validateAbVariants(groupWithVariants, ['A', 'B'], {
        status: 'coding',
      });
      expect(resActive.valid).toBe(false);
      if (!resActive.valid) {
        expect(resActive.error).toContain('queue stage');
      }
    });
  });

  describe('3. Idempotent fork under retry/restart', () => {
    test('creates children once and re-uses them on subsequent calls', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Experiment Parent',
          status: 'backlog',
          ab_variants: ['A', 'B'],
        }),
      );

      const mockGit = async (_group: any, cmd: string) => {
        if (cmd.startsWith('rev-parse')) {
          return {
            ok: true,
            output: '1111222233334444555566667777888899990000\n',
          };
        }
        return { ok: true, output: '' };
      };

      // First spawn call
      const children1 = await spawnAbVariants(
        parent,
        'coding',
        groupWithVariants,
        mockGit,
      );
      expect(children1).toHaveLength(2);
      expect(children1[0].stage_variant).toBe('a');
      expect(children1[1].stage_variant).toBe('b');
      expect(children1[0].title).toBe('Experiment Parent [A]');
      expect(children1[1].title).toBe('Experiment Parent [B]');
      expect(children1[0].ab_parent_task_id).toBe(parent.id);
      expect(children1[1].ab_parent_task_id).toBe(parent.id);
      expect(children1[0].status).toBe('coding');
      expect(children1[1].status).toBe('coding');

      // Parent was updated
      const updatedParent = await getTask(parent.id);
      expect(updatedParent?.status).toBe('coding');
      expect(updatedParent?.ab_fork_stage).toBe('coding');
      expect(updatedParent?.ab_fork_commit).toBe(
        '1111222233334444555566667777888899990000',
      );

      // Second spawn call (retry) returns identical children without creating duplicates
      const children2 = await spawnAbVariants(
        updatedParent!,
        'coding',
        groupWithVariants,
        mockGit,
      );
      expect(children2).toHaveLength(2);
      expect(children2.map((c) => c.id).sort()).toEqual(
        children1.map((c) => c.id).sort(),
      );

      // Direct DB call with onConflictDoNothing also returns existing children
      const childrenDb = await spawnAbVariantsInDb(
        updatedParent!,
        'coding',
        '1111222233334444555566667777888899990000',
        { status: updatedParent!.status, variants: ['A', 'B'] },
      );
      expect(childrenDb).toHaveLength(2);
      expect(childrenDb.map((c) => c.id).sort()).toEqual(
        children1.map((c) => c.id).sort(),
      );

      const allDbChildren = await getAbChildTasks(parent.id);
      expect(allDbChildren).toHaveLength(2);
    });

    test('children inherit the parent co_stages; null stays null', async () => {
      const git = async (_group: any, cmd: string) =>
        cmd.startsWith('rev-parse')
          ? { ok: true, output: '1111222233334444555566667777888899990000\n' }
          : { ok: true, output: '' };
      const coStages = ['review.o', 'testing.u'];
      const withCo = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Co Parent',
          status: 'backlog',
          ab_variants: ['A', 'B'],
          co_stages: coStages,
        }),
      );
      const withoutCo = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Plain Parent',
          status: 'backlog',
          ab_variants: ['A', 'B'],
        }),
      );

      const coChildren = await spawnAbVariants(
        withCo,
        'coding',
        groupWithVariants,
        git,
      );
      const plainChildren = await spawnAbVariants(
        withoutCo,
        'coding',
        groupWithVariants,
        git,
      );

      expect(coChildren).toHaveLength(2);
      for (const child of await getAbChildTasks(withCo.id)) {
        expect(child.coStages).toEqual(coStages);
      }
      expect(plainChildren).toHaveLength(2);
      for (const child of await getAbChildTasks(withoutCo.id)) {
        expect(child.coStages).toBeNull();
      }
    });
  });

  describe('5. Distinct branch_name and worktree_path per child', () => {
    test('generates unique branches and worktree paths for parent and variant children', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Unique Branch Feature',
          status: 'backlog',
          ab_variants: ['A', 'B'],
        }),
      );

      const mockGit = async () => ({
        ok: true,
        output: '4444444444444444444444444444444444444444\n',
      });
      const [childA, childB] = await spawnAbVariants(
        parent,
        'coding',
        groupWithVariants,
        mockGit,
      );

      const parentBranch = getBranchNameForTask(parent);
      const branchA = getBranchNameForTask(childA);
      const branchB = getBranchNameForTask(childB);

      expect(branchA).not.toBe(parentBranch);
      expect(branchB).not.toBe(parentBranch);
      expect(branchA).not.toBe(branchB);

      expect(childA.id).not.toBe(childB.id);
      expect(branchA).toContain(childA.id.slice(-6));
      expect(branchB).toContain(childB.id.slice(-6));

      // Children start without a prepared checkout (the runner creates one
      // worktree each from the shared fork commit) and never inherit one.
      const forkedParent = await getTask(parent.id);
      expect(forkedParent?.ab_fork_commit).toBe(
        '4444444444444444444444444444444444444444',
      );
      for (const child of [childA, childB]) {
        expect(child.ab_parent_task_id).toBe(parent.id);
        expect(child.branch_name).toBeNull();
        expect(child.worktree_path).toBeNull();
      }
    });
  });

  describe('6. Clash guard moves child to Question stage', () => {
    test('moves child to question stage if branch clashes with parent', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Clash Test Feature',
          status: 'coding',
          branch_name: 'clashing-branch-name',
          worktree_path: '.worktrees/clashing-branch-name',
          ab_variants: ['A', 'B'],
          ab_fork_commit: 'abc123commit',
          ab_fork_stage: 'coding',
        }),
      );

      // Create a child task manually with colliding branch_name
      const child = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Clash Test Feature [A]',
          status: 'coding',
          branch_name: 'clashing-branch-name', // deliberate collision!
          worktree_path: '.worktrees/different-worktree',
          stage_variant: 'A',
          ab_parent_task_id: parent.id,
        }),
      );

      expect(isAbExperimentChild(child)).toBe(true);

      // Execute child task
      await executeTask(child, groupWithVariants);

      // Check that child was moved to question
      const updatedChild = await getTask(child.id);
      expect(updatedChild?.status).toBe('question');
    });

    test('moves child to question stage if worktree clashes with sibling', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Sibling Clash Feature',
          status: 'coding',
          branch_name: 'parent-branch-ok',
          worktree_path: '.worktrees/parent-branch-ok',
          ab_variants: ['A', 'B'],
          ab_fork_commit: 'abc123commit',
          ab_fork_stage: 'coding',
        }),
      );

      const siblingA = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Sibling Clash Feature [A]',
          status: 'coding',
          branch_name: 'branch-a',
          worktree_path: '.worktrees/shared-worktree-collision',
          stage_variant: 'A',
          ab_parent_task_id: parent.id,
        }),
      );

      const siblingB = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Sibling Clash Feature [B]',
          status: 'coding',
          branch_name: 'branch-b',
          worktree_path: '.worktrees/shared-worktree-collision', // collision with sibling A!
          stage_variant: 'B',
          ab_parent_task_id: parent.id,
        }),
      );

      await executeTask(siblingB, groupWithVariants);

      const updatedSiblingB = await getTask(siblingB.id);
      expect(updatedSiblingB?.status).toBe('question');
    });
  });

  describe('6b. Done variants keep their checkout across restarts', () => {
    test('sweepOrphanedWorktrees preserves experiment bindings but clears ordinary tasks', async () => {
      const { sweepOrphanedWorktrees } = await import('../../../recovery.js');
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Retention Feature',
          status: 'coding',
          ab_variants: ['A', 'B'],
          ab_fork_commit: 'abc123commit',
          ab_fork_stage: 'coding',
        }),
      );
      const child = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Retention Feature [A]',
          status: 'completed',
          branch_name: 'retention-a',
          worktree_path: '.worktrees/retention-a',
          stage_variant: 'A',
          ab_parent_task_id: parent.id,
        }),
      );
      const ordinary = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Ordinary done task',
          status: 'completed',
          branch_name: 'ordinary-done',
          worktree_path: '.worktrees/ordinary-done',
        }),
      );

      await sweepOrphanedWorktrees();

      expect((await getTask(child.id))?.worktree_path).toBe(
        '.worktrees/retention-a',
      );
      expect((await getTask(ordinary.id))?.worktree_path).toBeNull();
    });
  });

  describe('7. Parent never claimed after the fork', () => {
    test('taskQueueHoldReason holds forked parent card', async () => {
      const forkedParent: Task = taskFixture({
        id: 'parent-task-forked',
        project_id: PROJECT_ID,
        title: 'Forked Parent',
        status: 'coding',
        priority: 0,
        ab_variants: ['A', 'B'],
        ab_fork_stage: 'coding',
        ab_fork_commit: '1234567890abcdef',
      }) as Task;

      const ctx: any = {
        dbRunningTaskIds: new Set<string>(),
        failedStageEntryTasks: new Set<string>(),
        objectiveStatuses: new Map(),
        taskMap: new Map(),
        doneStageIds: new Set(['completed']),
        allTasks: [],
      };

      const reason = taskQueueHoldReason(forkedParent, ctx);
      expect(reason).toBe('ab_parent_forked');
    });

    test('executeTask ignores execution request for forked parent', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Forked Parent Exec Guard',
          status: 'coding',
          ab_variants: ['A', 'B'],
          ab_fork_stage: 'coding',
          ab_fork_commit: '1234567890abcdef',
        }),
      );

      // Should return without error and leave status unchanged
      await executeTask(parent, groupWithVariants);
      const after = await getTask(parent.id);
      expect(after?.status).toBe('coding');
    });
  });

  describe('8. Merge paths skipped for parent and children', () => {
    test('mergeTaskBranchWithResolution skips merge for experiment parent and child', async () => {
      const parent: Task = taskFixture({
        id: 'parent-merge-test',
        project_id: PROJECT_ID,
        title: 'Parent Task',
        status: 'review',
        priority: 0,
        ab_variants: ['A', 'B'],
      }) as Task;

      const child: Task = taskFixture({
        id: 'child-merge-test',
        project_id: PROJECT_ID,
        title: 'Child Task',
        status: 'review',
        priority: 0,
        ab_parent_task_id: parent.id,
        stage_variant: 'A',
      }) as Task;

      const parentRes = await mergeTaskBranchWithResolution(
        parent,
        groupWithVariants,
        'completion',
      );
      expect(parentRes).toEqual({
        mergeOk: true,
        output: 'A/B experiment task: merge skipped',
        skipped: 'ab_variant',
      });

      const childRes = await mergeTaskBranchWithResolution(
        child,
        groupWithVariants,
        'completion',
      );
      expect(childRes).toEqual({
        mergeOk: true,
        output: 'A/B experiment task: merge skipped',
        skipped: 'ab_variant',
      });
    });

    test('mergeTaskForManualCompletion commits worktree without merging to default branch', async () => {
      const parent: Task = taskFixture({
        id: 'parent-manual-test',
        project_id: PROJECT_ID,
        title: 'Parent Manual Completion',
        status: 'review',
        priority: 0,
        ab_variants: ['A', 'B'],
        branch_name: 'parent-branch',
      }) as Task;

      const child: Task = taskFixture({
        id: 'child-manual-test',
        project_id: PROJECT_ID,
        title: 'Child Manual Completion',
        status: 'review',
        priority: 0,
        ab_parent_task_id: parent.id,
        stage_variant: 'A',
        branch_name: 'child-branch',
      }) as Task;

      let mergeCalled = false;
      const deps = {
        commitTaskBranch: async () => true,
        mergeTaskBranchToDefault: async () => {
          mergeCalled = true;
          return { mergeOk: true, output: '' };
        },
        withProjectGitLock: async (_pid: any, fn: any) => fn(),
      };

      const parentRes = await mergeTaskForManualCompletion(
        parent,
        groupWithVariants,
        deps,
      );
      expect(parentRes).toEqual({
        mergeOk: true,
        output: 'A/B experiment task: merge skipped',
        skipped: 'ab_variant',
      });
      expect(mergeCalled).toBe(false);

      const childRes = await mergeTaskForManualCompletion(
        child,
        groupWithVariants,
        deps,
      );
      expect(childRes).toEqual({
        mergeOk: true,
        output: 'A/B experiment task: merge skipped',
        skipped: 'ab_variant',
      });
      expect(mergeCalled).toBe(false);
    });

    test('triggerDeploy completes experiment cards without merging or building', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Parent Deploy Test',
          status: 'review',
          ab_variants: ['A', 'B'],
        }),
      );
      const child = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Child Deploy Test',
          status: 'review',
          ab_parent_task_id: parent.id,
          stage_variant: 'A',
          branch_name: 'task/child-deploy-test',
        }),
      );

      let buildCalls = 0;
      const notified: Array<{
        task_id: string;
        event: string;
        entry?: string;
      }> = [];
      const deployed = await triggerDeploy(
        child,
        {
          ...groupWithVariants,
          settings: { ...groupWithVariants.settings, deployService: 'web' },
        },
        {
          skipMerge: true,
          stageEntryEventId: 'entry-1',
          buildService: async () => {
            buildCalls++;
            return { isError: false, stdout: 'built' };
          },
          notifyLifecycle: (async (input: any) => {
            notified.push({
              task_id: input.task_id,
              event: input.event,
              entry: input.stage_entry_event_id,
            });
          }) as any,
        },
      );

      expect(deployed).toBe(true);
      expect(buildCalls).toBe(0);
      const after = await getTask(child.id);
      expect(after?.status).toBe('completed');
      expect(after?.completed_at).toBeTruthy();
      expect(after?.branch_name).toBe('task/child-deploy-test');
      expect(notified).toEqual([
        { task_id: child.id, event: 'completed', entry: expect.any(String) },
      ]);
    });
  });

  describe('9. Review skipped checkout reference preservation', () => {
    test('completeApprovedMerge retains checkout references when review merge is skipped for ab_variant', async () => {
      const task = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'AB Review Retain Checkout',
          status: 'review',
          ab_variants: ['A', 'B'],
          branch_name: 'test-branch-name',
          worktree_path: '.worktrees/test-worktree',
        }),
      );

      let transitionChanges: any = null;
      await completeApprovedMerge(
        {
          task,
          group: groupWithVariants,
          stages: groupWithVariants.settings?.stages || [],
          approveStageId: 'completed',
          completedAt: new Date().toISOString(),
          newValues: {},
          mergeResult: {
            mergeOk: true,
            output: 'merge skipped',
            skipped: 'ab_variant',
          },
          applyTransition: async (changes) => {
            transitionChanges = changes;
            return true;
          },
        },
        {
          broadcast: () => {},
          triggerDeploy: async () => false,
          publishEvent: () => {},
          resolveBrainUrl: () => null,
          resolveBrainContainer: () => undefined,
          notifyEntityLifecycle: async () => {},
        },
      );

      expect(transitionChanges.status).toBe('completed');
      expect(transitionChanges.branch_name).toBeUndefined();
      expect(transitionChanges.worktree_path).toBeUndefined();
    });

    test('completeApprovedMerge clears checkout references for non-experiment tasks', async () => {
      const task = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Standard Review Clear Checkout',
          status: 'review',
          branch_name: 'standard-branch-name',
          worktree_path: '.worktrees/standard-worktree',
        }),
      );

      let transitionChanges: any = null;
      await completeApprovedMerge(
        {
          task,
          group: groupWithVariants,
          stages: groupWithVariants.settings?.stages || [],
          approveStageId: 'completed',
          completedAt: new Date().toISOString(),
          newValues: {},
          mergeResult: {
            mergeOk: true,
            output: 'merge succeeded',
          },
          applyTransition: async (changes) => {
            transitionChanges = changes;
            return true;
          },
        },
        {
          broadcast: () => {},
          triggerDeploy: async () => false,
          publishEvent: () => {},
          resolveBrainUrl: () => null,
          resolveBrainContainer: () => undefined,
          notifyEntityLifecycle: async () => {},
        },
      );

      expect(transitionChanges.status).toBe('completed');
      expect(transitionChanges.branch_name).toBeNull();
      expect(transitionChanges.worktree_path).toBeNull();
    });
  });

  describe('10. Resolve stage-entry receipts and queue drain when holding or forking parents', () => {
    test('executeTask resolves stage-entry receipt and triggers queue drain when parent forks', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Receipt and Drain Test',
          status: 'coding',
          ab_variants: ['A', 'B'],
        }),
      );

      const [entryEvent] = await drizzleDbRef.current
        .insert(stageEntryEvents)
        .values({
          id: 'test-stage-entry-receipt-1',
          project_id: PROJECT_ID,
          task_id: parent.id,
          stage_id: 'coding',
          state: 'pending',
          created_at: new Date().toISOString(),
        })
        .returning();

      let drainCalled = false;
      const mockGit = async () => ({
        ok: true,
        output: '1111222233334444555566667777888899990000\n',
      });

      await executeTask(parent, groupWithVariants, {
        automaticStageEntryEventId: entryEvent.id,
        testDependencies: {
          runGitInRepo: mockGit as any,
          drainProjectQueue: async () => {
            drainCalled = true;
          },
        },
      });

      const [resolvedEvent] = await drizzleDbRef.current
        .select()
        .from(stageEntryEvents)
        .where(eq(stageEntryEvents.id, entryEvent.id));
      expect(resolvedEvent.state).toBe('resolved');
      expect(drainCalled).toBe(true);
    });

    test('executeTask fails the stage-entry receipt, releases the claim and drains when the fork throws', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Failed Fork Receipt Test',
          status: 'coding',
          ab_variants: ['A', 'B'],
          worktree_path: '.worktrees/failed-fork-receipt',
        }),
      );

      const [entryEvent] = await drizzleDbRef.current
        .insert(stageEntryEvents)
        .values({
          id: 'test-stage-entry-receipt-fail',
          project_id: PROJECT_ID,
          task_id: parent.id,
          stage_id: 'coding',
          state: 'claimed',
          created_at: new Date().toISOString(),
        })
        .returning();

      let drainCalled = false;
      await expect(
        executeTask(parent, groupWithVariants, {
          automaticStageEntryEventId: entryEvent.id,
          testDependencies: {
            runGitInRepo: (async () => ({
              ok: true,
              output: 'dummy-commit',
            })) as any,
            commitTaskBranch: async () => false,
            drainProjectQueue: async () => {
              drainCalled = true;
            },
          },
        }),
      ).rejects.toThrow('Git ref develop could not be resolved');

      const [failedEvent] = await drizzleDbRef.current
        .select()
        .from(stageEntryEvents)
        .where(eq(stageEntryEvents.id, entryEvent.id));
      expect(failedEvent.state).toBe('failed');
      expect(isTaskExecutionClaimed(parent.id)).toBe(false);
      expect(drainCalled).toBe(true);
      expect(await getAbChildTasks(parent.id)).toHaveLength(0);
    });

    test('executeTask resolves stage-entry receipt and triggers queue drain for already-forked parent', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Already Forked Receipt and Drain Test',
          status: 'coding',
          ab_variants: ['A', 'B'],
          ab_fork_stage: 'coding',
          ab_fork_commit: '1111222233334444555566667777888899990000',
        }),
      );

      const [entryEvent] = await drizzleDbRef.current
        .insert(stageEntryEvents)
        .values({
          id: 'test-stage-entry-receipt-2',
          project_id: PROJECT_ID,
          task_id: parent.id,
          stage_id: 'coding',
          state: 'pending',
          created_at: new Date().toISOString(),
        })
        .returning();

      let drainCalled = false;
      await executeTask(parent, groupWithVariants, {
        automaticStageEntryEventId: entryEvent.id,
        testDependencies: {
          drainProjectQueue: async () => {
            drainCalled = true;
          },
        },
      });

      const [resolvedEvent] = await drizzleDbRef.current
        .select()
        .from(stageEntryEvents)
        .where(eq(stageEntryEvents.id, entryEvent.id));
      expect(resolvedEvent.state).toBe('resolved');
      expect(drainCalled).toBe(true);
    });
  });

  describe('11. Start the sandbox before resolving a first-stage fork', () => {
    test('spawnAbVariants invokes ensureSandbox on first-stage fork', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Ensure Sandbox Test',
          status: 'coding',
          ab_variants: ['A', 'B'],
        }),
      );

      let ensureSandboxCalled = false;
      const mockGit = async () => ({
        ok: true,
        output: '1111222233334444555566667777888899990000\n',
      });

      await spawnAbVariants(
        parent,
        'coding',
        groupWithVariants,
        mockGit as any,
        async () => {
          ensureSandboxCalled = true;
        },
      );

      expect(ensureSandboxCalled).toBe(true);
    });
  });

  describe('11b. Start the sandbox before a later-stage fork checkpoints', () => {
    test('spawnAbVariants ensures the sandbox before checkpointing the parent', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Later Fork Sandbox Test',
          status: 'review',
          ab_variants: ['A', 'X'],
          worktree_path: '.worktrees/later-fork-sandbox',
        }),
      );

      const events: string[] = [];
      const mockGit = async () => ({
        ok: true,
        output: '5555666677778888999900001111222233334444\n',
      });

      const children = await spawnAbVariants(
        parent,
        'review',
        groupWithVariants,
        mockGit as any,
        async () => {
          events.push('sandbox');
        },
        async () => {
          events.push('checkpoint');
          return true;
        },
      );

      expect(events).toEqual(['sandbox', 'checkpoint']);
      expect(children).toHaveLength(2);
      expect((await getTask(parent.id))?.ab_fork_commit).toBe(
        '5555666677778888999900001111222233334444',
      );
    });
  });

  describe('12. Concurrency immutability of fork snapshot in DB', () => {
    test('spawnAbVariantsInDb does not overwrite established fork snapshot', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Immutable Fork Parent',
          status: 'coding',
          ab_variants: ['A', 'B'],
        }),
      );

      const children1 = await spawnAbVariantsInDb(
        parent,
        'coding',
        'initial-fork-commit-1111',
        { status: 'coding', variants: ['A', 'B'] },
      );
      expect(children1).toHaveLength(2);

      const afterFirst = await getTask(parent.id);
      expect(afterFirst?.ab_fork_stage).toBe('coding');
      expect(afterFirst?.ab_fork_commit).toBe('initial-fork-commit-1111');

      const children2 = await spawnAbVariantsInDb(
        afterFirst!,
        'review',
        'different-fork-commit-2222',
        { status: 'coding', variants: ['A', 'B'] },
      );
      expect(children2).toHaveLength(2);
      expect(children2.map((c) => c.id).sort()).toEqual(
        children1.map((c) => c.id).sort(),
      );

      const afterSecond = await getTask(parent.id);
      expect(afterSecond?.ab_fork_stage).toBe('coding');
      expect(afterSecond?.ab_fork_commit).toBe('initial-fork-commit-1111');
    });
  });

  describe('12b. Fork admission fails closed', () => {
    test('stale snapshot cannot fork a parent whose variants were cleared or stage changed', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Edited During Fork',
          status: 'coding',
          ab_variants: ['A', 'B'],
        }),
      );
      const expected = { status: 'coding', variants: ['A', 'B'] };

      await updateTask(parent.id, { status: 'backlog', ab_variants: [] });
      const children = await spawnAbVariantsInDb(
        parent,
        'coding',
        'stale-fork-commit',
        expected,
      );
      expect(children).toHaveLength(0);
      const after = await getTask(parent.id);
      expect(after?.status).toBe('backlog');
      expect(after?.ab_fork_commit).toBeNull();
      expect(await getAbChildTasks(parent.id)).toHaveLength(0);
    });

    test('spawnAbVariants refuses and parks the parent outside worktree mode', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Mode Switched Parent',
          status: 'coding',
          ab_variants: ['A', 'B'],
        }),
      );
      const sharedGroup: RegisteredGroup = {
        ...groupWithVariants,
        settings: { ...groupWithVariants.settings, taskCheckoutMode: 'shared' },
      };
      const children = await spawnAbVariants(
        parent,
        'coding',
        sharedGroup,
        (async () => ({ ok: true, output: 'dummy-commit' })) as any,
        async () => {},
        async () => true,
      );
      expect(children).toHaveLength(0);
      expect(await getAbChildTasks(parent.id)).toHaveLength(0);
      const after = await getTask(parent.id);
      expect(after?.status).not.toBe('coding');
      expect(after?.ab_fork_commit).toBeNull();
    });
  });

  describe('12c. Worktree-mode projects without a local repository', () => {
    test('spawnAbVariants parks the parent instead of forking unisolated children', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'URL Only Parent',
          status: 'coding',
          ab_variants: ['A', 'B'],
        }),
      );
      const urlOnlyGroup: RegisteredGroup = {
        ...groupWithVariants,
        settings: {
          ...groupWithVariants.settings,
          repositoryLocation: undefined,
          repositoryUrl: 'https://example.invalid/repo.git',
        },
      };
      const children = await spawnAbVariants(
        parent,
        'coding',
        urlOnlyGroup,
        (async () => ({ ok: true, output: 'dummy-commit' })) as any,
        async () => {},
        async () => true,
      );
      expect(children).toHaveLength(0);
      expect(await getAbChildTasks(parent.id)).toHaveLength(0);
      const after = await getTask(parent.id);
      expect(after?.status).toBe('question');
      expect(after?.ab_fork_commit).toBeNull();
    });
  });

  describe('13. Abort spawning when parent checkpoint fails', () => {
    test('spawnAbVariants aborts child creation when parent checkpoint fails', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Failed Checkpoint Parent',
          status: 'testing',
          ab_variants: ['A', 'X'],
          worktree_path: '.worktrees/failing-checkpoint',
        }),
      );

      const mockGit = async () => ({ ok: true, output: 'dummy-commit' });

      await expect(
        spawnAbVariants(
          parent,
          'review',
          groupWithVariants,
          mockGit as any,
          undefined,
          async () => false,
        ),
      ).rejects.toThrow(
        'Failed to checkpoint parent task branch before spawning A/B variants',
      );

      const children = await getAbChildTasks(parent.id);
      expect(children).toHaveLength(0);

      const updatedParent = await getTask(parent.id);
      expect(updatedParent?.ab_fork_commit).toBeNull();
    });
  });

  describe('14. Experiment cards in deploy batches', () => {
    test('flushDeployBatch passes the whole batch so experiment cards finish without a build', async () => {
      const parent = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Parent in Deploy',
          status: 'completed',
          ab_variants: ['A', 'B'],
        }),
      );
      const normalTask = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Normal Deployable Task',
          status: 'completed',
        }),
      );

      let triggeredBatchTasks: Task[] = [];
      const mockTriggerDeploy = async (_t: Task, _g: any, opts: any) => {
        triggeredBatchTasks = opts.batchTasks ?? [];
        return true;
      };

      await flushDeployBatch(
        [parent, normalTask],
        {
          ...groupWithVariants,
          settings: { ...groupWithVariants.settings, deployService: 'web' },
        },
        {
          triggerDeploy: mockTriggerDeploy,
          getTask,
          mergeBranchForDeploy: async () => true,
        } as any,
      );

      expect(triggeredBatchTasks.map((t) => t.id)).toEqual([
        parent.id,
        normalTask.id,
      ]);
    });
  });

  describe('15. Enforce experiment edit preconditions atomically', () => {
    test('updateTask enforces queue stage, claimed state, and unforked state atomically', async () => {
      const task = await createTask(
        taskFixture({
          project_id: PROJECT_ID,
          title: 'Atomic Preconditions Task',
          status: 'backlog',
          ab_variants: ['A', 'B'],
        }),
      );

      await expect(
        updateTask(
          task.id,
          { ab_variants: ['A', 'C'] },
          {
            failureSource: 'user',
            isExecutionClaimed: () => true,
          },
        ),
      ).rejects.toThrow('is claimed for execution');

      await expect(
        updateTask(
          task.id,
          { ab_variants: ['A', 'C'] },
          {
            failureSource: 'user',
            requireStageVariantStatuses: ['queue_stage_other'],
          },
        ),
      ).rejects.toThrow('is no longer in a queue stage');

      await updateTask(task.id, {
        ab_fork_commit: 'already-forked-commit',
        ab_fork_stage: 'coding',
      });

      await expect(
        updateTask(
          task.id,
          { ab_variants: ['A', 'C'] },
          {
            failureSource: 'user',
          },
        ),
      ).rejects.toThrow(
        'Cannot change ab_variants: experiment has already forked',
      );
    });
  });

  describe('16. Run experiment shared prefixes with base stage configurations', () => {
    test('experiment parent resolves base variant a regardless of stageVariant field', () => {
      const parentTask: Task = taskFixture({
        id: 'parent-stage-config',
        project_id: PROJECT_ID,
        title: 'Experiment Parent',
        status: 'coding',
        stageVariant: 'b',
        stage_variant: 'b',
        ab_variants: ['A', 'B'],
      }) as Task;

      const nonExperimentTask: Task = taskFixture({
        id: 'non-experiment-task',
        project_id: PROJECT_ID,
        title: 'Normal Task',
        status: 'coding',
        stageVariant: 'b',
        stage_variant: 'b',
      }) as Task;

      const nonExpStage = resolveStageForTask(
        groupWithVariants,
        'coding',
        nonExperimentTask.stageVariant ?? nonExperimentTask.stage_variant,
      );
      expect(nonExpStage?.id).toBe('coding');
      expect(nonExpStage?.runtimeSelection?.modelId).toBe('variant-b-model');
      expect(
        hasStageAlternative(
          groupWithVariants,
          'coding',
          nonExperimentTask.stageVariant,
        ),
      ).toBe(true);

      const effectiveVariant = isAbExperimentParent(parentTask)
        ? 'a'
        : (parentTask.stageVariant ?? parentTask.stage_variant);
      expect(effectiveVariant).toBe('a');

      const parentStage = resolveStageForTask(
        groupWithVariants,
        'coding',
        effectiveVariant,
      );
      expect(parentStage?.id).toBe('coding');
      expect(parentStage?.runtimeSelection).toBeUndefined();
      expect(
        hasStageAlternative(groupWithVariants, 'coding', effectiveVariant),
      ).toBe(false);
    });
  });
});
