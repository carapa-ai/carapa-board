/**
 * Task-level git operations — post-execution cleanup (commit and branch switch)
 * that runs in the finally block of executeTask.
 *
 * Low-level git primitives (runGitInRepo, mergeTaskBranchToDefault, etc.)
 * live in `../lib/git-ops.js`. This module composes those primitives into
 * the higher-level sequences required by the task execution lifecycle.
 */
import { RegisteredGroup } from '../../../types.js';
import { Task, StageDefinition } from '../types.js';
import { getTask } from '../../../db.js';
import { logger } from '../../../logger.js';
import { findStage } from '../stages.js';
import {
  validatedInstance,
  isLocalRepoMode,
  withProjectGitLock,
  commitTaskBranch,
  checkpointTaskDefaultBranch,
  sharedCheckoutIsSafe,
  runGitInRepo,
  taskUsesWorktree,
} from '../../../lib/git-ops.js';

/**
 * Run post-execution git cleanup for a completed task.
 *
 * This handles:
 * - Committing changes on the task branch
 * - Switching back to the develop/default branch (legacy mode)
 *
 * Skipped when the task is still in an active stage (will be picked up
 * by the next execution cycle).
 */
export async function runPostExecutionGitOps(
  task: Task,
  group: RegisteredGroup,
  stages: StageDefinition[],
  options: {
    /** The caller's fresh read of the task (null: deleted), so a failure of
     * that read is not reported as a Git failure. */
    currentTask?: Task | null;
    /**
     * Restart recovery retrying a checkpoint: in branch checkout mode a
     * completed checkpoint already restored the default branch, so a clean
     * default checkout means there is nothing left to checkpoint.
     */
    resumeRestoredCheckpoint?: boolean;
    /** Restart recovery: a failed task-state write is not a Git failure. */
    propagateStateErrors?: boolean;
  } = {},
): Promise<void> {
  const updatedTask =
    options.currentTask !== undefined
      ? (options.currentTask ?? undefined)
      : await getTask(task.id);
  // A task deleted while it ran has no worktree left to commit; falling through
  // to the shared-checkout path would fail on its stale branch.
  if (!updatedTask && taskUsesWorktree(group)) {
    logger.debug(
      { task_id: task.id },
      'finally: task deleted — skipping git ops',
    );
    return;
  }
  const updatedStageDef = updatedTask
    ? findStage(stages, updatedTask.status)
    : undefined;
  const usesTaskBranch = !!(updatedTask
    ? updatedTask.branch_name
    : task.branch_name);

  // Isolated branches defer checkpoints while implementation is still active.
  // Once implementation advances to Testing, commit first so the tester can
  // bind its evidence to the exact HEAD later presented to Review.
  // Shared/default checkouts cannot defer: the next serialized task must see a
  // clean, durable HEAD rather than another task's uncommitted changes.
  if (
    usesTaskBranch &&
    updatedStageDef?.type === 'active' &&
    group.settings?.taskCheckoutMode === 'worktree'
  )
    return;

  // Only a durable commit marker proves that a missing task branch was already
  // finalized. A missing branch alone may instead mean the task deliberately
  // reused the default checkout and still requires a checkpoint.
  if (updatedTask && !updatedTask.branch_name && updatedTask.merge_commit) {
    logger.debug(
      { task_id: task.id },
      'finally: branch already merged — skipping git ops',
    );
    return;
  }

  const taskInstance = updatedTask
    ? validatedInstance(updatedTask, group)
    : undefined;

  const usesWorktree = !!(
    updatedTask?.branch_name &&
    (taskUsesWorktree(group) || updatedTask.worktree_path)
  );

  if (updatedTask && usesWorktree) {
    // Worktree mode: each task has its own isolated directory.
    // Commit in the worktree (no branch switch needed).
    logger.debug(
      { task_id: task.id },
      'finally: worktree mode — commitTaskBranch',
    );
    await commitTaskBranch(updatedTask, group, {
      propagateStateErrors: options.propagateStateErrors,
    });
    // Worktree persists across stages (review, retry, deploy). It's cleaned up
    // after merge (mergeTaskBranchToDefault) or on task delete/archive.
  } else {
    // Legacy checkout mode (GIT_REPO or non-worktree checkout)
    const runGitCheckpoint = async () => {
      const checkpointTask = updatedTask || task;
      const baseBranch = group.settings?.defaultBranch || 'develop';
      const branchMode =
        !!checkpointTask.branch_name &&
        group.settings?.taskCheckoutMode === 'branch';
      if (options.resumeRestoredCheckpoint && branchMode) {
        const [branch, status] = await Promise.all([
          runGitInRepo(group, 'branch --show-current', taskInstance),
          runGitInRepo(group, 'status --porcelain=v1', taskInstance),
        ]);
        if (
          branch.ok &&
          status.ok &&
          branch.output.trim() === baseBranch &&
          status.output.trim() === ''
        ) {
          logger.info(
            { task_id: task.id },
            'finally: checkpoint already completed and default checkout restored',
          );
          return;
        }
      }
      if (!(await sharedCheckoutIsSafe(checkpointTask, group, false))) {
        throw new Error('Unexpected shared checkout state; checkpoint aborted');
      }
      logger.debug({ task_id: task.id }, 'finally: checkpoint task changes');
      const checkpointOk = checkpointTask.branch_name
        ? await commitTaskBranch(checkpointTask, group, {
            propagateStateErrors: options.propagateStateErrors,
          })
        : (await checkpointTaskDefaultBranch(checkpointTask, group)).mergeOk;
      if (checkpointOk && branchMode) {
        const restored = await runGitInRepo(
          group,
          `checkout ${baseBranch}`,
          taskInstance,
        );
        if (!restored.ok) throw new Error('Unable to restore default checkout');
      }
      if (!checkpointOk) {
        throw new Error('Unable to checkpoint task changes');
      }
    };

    // In LOCAL_REPO mode the git operations run on the host working tree, so
    // concurrent task completions must be serialised to avoid conflicts.
    if (isLocalRepoMode(group) || !usesTaskBranch) {
      await withProjectGitLock(task.project_id, runGitCheckpoint);
    } else {
      await runGitCheckpoint();
    }
  }
}
