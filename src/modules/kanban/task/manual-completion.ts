import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import {
  commitTaskBranch,
  mergeTaskBranchToDefault,
  sharedCheckoutIsSafe,
  taskCheckoutMode,
  withProjectGitLock,
  type TaskBranchMergeResult,
} from '../../../lib/git-ops.js';
import { isAbExperimentTask } from '../stages.js';
import { acquireSharedCheckoutLease } from '../../../concurrency/shared-checkout-lease.js';
import {
  ensureBranchAtPinnedHead,
  evaluateMergeRisk,
  type MergeRiskDependencies,
} from './merge-risk-gate.js';

export interface ManualCompletionDependencies {
  commitTaskBranch: typeof commitTaskBranch;
  mergeTaskBranchToDefault: typeof mergeTaskBranchToDefault;
  withProjectGitLock: typeof withProjectGitLock;
  sharedCheckoutIsSafe?: typeof sharedCheckoutIsSafe;
  acquireSharedCheckoutLease?: typeof acquireSharedCheckoutLease;
  riskGate?: MergeRiskDependencies;
}

/** A manual move waits at most this long for each of the lease and the git lock. */
const MANUAL_COMPLETION_MAX_WAIT_MS = 30_000;
let maxWaitMs = MANUAL_COMPLETION_MAX_WAIT_MS;

/** Test hook: shorten the wait bound; call without an argument to restore it. */
export function _testOnlySetManualCompletionMaxWaitMs(
  milliseconds = MANUAL_COMPLETION_MAX_WAIT_MS,
): void {
  maxWaitMs = milliseconds;
}

const defaultDependencies: ManualCompletionDependencies = {
  commitTaskBranch,
  mergeTaskBranchToDefault,
  withProjectGitLock,
  sharedCheckoutIsSafe,
  acquireSharedCheckoutLease,
};

/** A task with its own branch, or a project on its default checkout, merges before completion. */
function manualCompletionNeedsMerge(
  task: Task,
  group: RegisteredGroup,
): boolean {
  return (
    !!task.branch_name ||
    !!(
      group.settings?.repositoryLocation ||
      group.settings?.repositoryUrl ||
      group.settings?.repositoryRelativePath
    )
  );
}

/**
 * Wait, within the same bounds as the merge, until the checkout is free, then
 * give it back. A bulk move calls this before saving any card, so a stuck
 * holder answers CheckoutBusyError up front rather than after earlier cards
 * were saved. A holder that appears later fails only the card it blocks.
 */
export async function waitForManualCompletionCheckout(
  tasks: Task[],
  group: RegisteredGroup,
  dependencies: ManualCompletionDependencies = defaultDependencies,
): Promise<void> {
  const first = tasks.find((task) => manualCompletionNeedsMerge(task, group));
  if (!first) return;
  const lease = await (
    dependencies.acquireSharedCheckoutLease ?? acquireSharedCheckoutLease
  )(first.project_id, { type: 'task', id: first.id }, { maxWaitMs });
  try {
    await dependencies.withProjectGitLock(first.project_id, async () => {}, {
      holder: `task ${first.id}`,
      maxWaitMs,
    });
  } finally {
    await lease.release();
  }
}

/**
 * Commit and merge a task branch before a user manually marks the task done.
 * Non-branch projects are already operating on their default checkout, so
 * they need no merge step.
 */
export async function mergeTaskForManualCompletion(
  task: Task,
  group: RegisteredGroup,
  dependencies: ManualCompletionDependencies = defaultDependencies,
): Promise<TaskBranchMergeResult> {
  const usesTaskBranch = !!task.branch_name;
  // Settings of a freshly registered project may lack an explicit mode.
  const checkoutMode = taskCheckoutMode(group);
  const usesBranchCheckout = checkoutMode === 'branch' && !task.worktree_path;
  if (!manualCompletionNeedsMerge(task, group)) {
    return { mergeOk: true, output: '' };
  }

  const acquireLease =
    dependencies.acquireSharedCheckoutLease ?? acquireSharedCheckoutLease;
  const lease = await acquireLease(
    task.project_id,
    { type: 'task', id: task.id },
    { maxWaitMs },
  );
  try {
    return await dependencies.withProjectGitLock(
      task.project_id,
      async () => {
        if (
          (checkoutMode === 'shared' || checkoutMode === 'branch') &&
          !(await (dependencies.sharedCheckoutIsSafe ?? sharedCheckoutIsSafe)(
            usesBranchCheckout ? task : { ...task, branch_name: null },
            group,
            true,
            checkoutMode === 'branch' && task.branch_name
              ? [
                  usesBranchCheckout
                    ? group.settings?.defaultBranch || 'develop'
                    : task.branch_name,
                ]
              : [],
          ))
        ) {
          return {
            mergeOk: false,
            output: 'Shared checkout is dirty or on an unexpected branch',
          };
        }
        // Branch mode just proved the shared checkout clean. Merge the persisted
        // ref directly, including when an agent already merged it into default;
        // another checkpoint needlessly checks out the old task branch. Isolated
        // worktrees still need a checkpoint because the shared check says nothing
        // about their uncommitted changes.
        if (usesTaskBranch && !usesBranchCheckout) {
          const committed = await dependencies.commitTaskBranch(task, group);
          if (!committed) {
            return {
              mergeOk: false,
              output: 'Task worktree changes could not be committed',
            };
          }
        }
        if (isAbExperimentTask(task)) {
          return {
            mergeOk: true,
            output: 'A/B experiment task: merge skipped',
            skipped: 'ab_variant',
          };
        }
        // This path merges without mergeTaskBranchWithResolution, so it needs
        // its own gate. Classify after the checkpoint commit so the head sha
        // covers everything about to merge; the merge re-checks right before
        // the sandbox call.
        const verdict = await evaluateMergeRisk(
          task,
          group,
          'manual_completion',
          dependencies.riskGate,
        );
        if (verdict.blocked) return verdict.blocked;
        const result = await dependencies.mergeTaskBranchToDefault(
          task,
          group,
          {
            beforeMerge: () =>
              ensureBranchAtPinnedHead(
                task,
                group,
                verdict.pinnedHead,
                dependencies.riskGate,
              ),
          },
        );
        if (
          usesTaskBranch &&
          !result.mergeOk &&
          result.failureKind === 'environment' &&
          (result.blockers?.length ?? 0) > 0
        ) {
          return {
            ...result,
            mergeOk: true,
            integrationPending: true,
          };
        }
        return result;
      },
      { holder: `task ${task.id}`, maxWaitMs },
    );
  } finally {
    await lease.release();
  }
}
