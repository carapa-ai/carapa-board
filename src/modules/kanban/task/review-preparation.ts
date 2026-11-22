/**
 * Repository preparation and content identity checks shared by Testing and
 * Review before their agents run.
 */
import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import { logger } from '../../../logger.js';
import {
  commitTaskBranch,
  commitWorkingTree,
  runGitInRepo,
  taskBranchNeedsReviewPreparation,
  taskUsesBranch,
  taskUsesWorktree,
  validatedInstance,
} from '../../../lib/git-ops.js';
import { getSandboxClient } from '../../../lib/mcp-client.js';
import {
  effectiveOperationInstance,
  effectiveRemoteUrl,
  resolveEffectiveSandbox,
} from '../../../sandbox/effective-settings.js';

export interface TaskGitContentIdentity {
  headSha: string;
  treeSha: string;
}

function parseTaskGitContentIdentity(
  output: string,
): TaskGitContentIdentity | undefined {
  const [headSha, treeSha, ...extra] = output.trim().split('\n');
  return headSha && treeSha && extra.length === 0
    ? { headSha, treeSha }
    : undefined;
}

/**
 * Whether the task's checked-out working tree has no tracked or untracked
 * changes. In branch mode the task branch is checked out at the repository
 * root, so the root's status is the task's status.
 */
export async function isTaskCheckoutClean(
  task: Task,
  group: RegisteredGroup,
  runGit: typeof runGitInRepo = runGitInRepo,
): Promise<boolean> {
  const usesWorktree =
    !!task.branch_name && (taskUsesWorktree(group) || !!task.worktree_path);
  const wtPrefix = usesWorktree ? `-C .worktrees/${task.branch_name} ` : '';
  const status = await runGit(
    group,
    `${wtPrefix}status --porcelain=v1 --untracked-files=all`,
    validatedInstance(task, group),
  );
  return status.ok && status.output.length === 0;
}

export async function readTaskGitContentIdentity(
  task: Task,
  group: RegisteredGroup,
  runGit: typeof runGitInRepo = runGitInRepo,
): Promise<TaskGitContentIdentity | undefined> {
  const instance = validatedInstance(task, group);
  const usesWorktree =
    !!task.branch_name && (taskUsesWorktree(group) || !!task.worktree_path);
  if (
    task.branch_name &&
    !usesWorktree &&
    group.settings?.taskCheckoutMode === 'branch'
  ) {
    const result = await runGit(
      group,
      `rev-parse ${task.branch_name}^{commit} ${task.branch_name}^{tree}`,
      instance,
    );
    if (!result.ok) return undefined;
    return parseTaskGitContentIdentity(result.output);
  }
  if (!(await isTaskCheckoutClean(task, group, runGit))) return undefined;
  const wtPrefix = usesWorktree ? `-C .worktrees/${task.branch_name} ` : '';
  const result = await runGit(
    group,
    `${wtPrefix}rev-parse HEAD HEAD^{tree}`,
    instance,
  );
  if (!result.ok) return undefined;
  return parseTaskGitContentIdentity(result.output);
}

interface ReviewPreparationDependencies {
  checkpointTaskBranch: typeof commitTaskBranch;
  checkpointDefaultCheckout: typeof commitWorkingTree;
  needsReviewPreparation: typeof taskBranchNeedsReviewPreparation;
  prepareReview: (
    stack: string,
    options: {
      branch: string;
      base: string;
      instance?: string;
      localRepo?: string;
      repoPath?: string;
      remoteUrl?: string;
      service: string;
      worktree_path?: string;
      commitMessage: string;
    },
  ) => Promise<{ stdout: string; isError: boolean }>;
}

export class TaskReviewPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskReviewPreparationError';
  }
}

export async function prepareTaskBranchForReview(
  task: Task,
  group: RegisteredGroup,
  dependencies: Partial<ReviewPreparationDependencies> = {},
): Promise<void> {
  if (!taskUsesBranch(group) && !task.branch_name) {
    const checkpointDefaultCheckout =
      dependencies.checkpointDefaultCheckout ?? commitWorkingTree;
    const result = await checkpointDefaultCheckout(
      group,
      `feat: ${task.title}`,
      validatedInstance(task, group),
    );
    if (!result.ok && !result.noChanges) {
      throw new TaskReviewPreparationError(
        `Unable to checkpoint shared checkout before review: ${result.output || 'unknown sandbox error'}`,
      );
    }
    return;
  }
  if (!group.settings || !task.branch_name) return;

  const effectiveSandbox = resolveEffectiveSandbox(group);
  const baseBranch = group.settings?.defaultBranch || 'develop';
  const checkpointTaskBranch =
    dependencies.checkpointTaskBranch ?? commitTaskBranch;
  const needsReviewPreparation =
    dependencies.needsReviewPreparation ?? taskBranchNeedsReviewPreparation;
  const prepareReview =
    dependencies.prepareReview ??
    ((stack, options) =>
      getSandboxClient().sandboxBranch(stack, 'prepare_review', options));
  const usesWorktree = taskUsesWorktree(group) || !!task.worktree_path;

  if (!(await checkpointTaskBranch(task, group))) {
    throw new TaskReviewPreparationError(
      'Unable to checkpoint task branch before review',
    );
  }
  if (await needsReviewPreparation(task, group, baseBranch)) {
    const result = await prepareReview(effectiveSandbox.stack, {
      branch: task.branch_name,
      base: baseBranch,
      instance: effectiveOperationInstance(
        effectiveSandbox,
        validatedInstance(task, group),
      ),
      localRepo: group.settings.repositoryLocation,
      repoPath: effectiveSandbox.inherited
        ? effectiveSandbox.workspaceRoot
        : undefined,
      remoteUrl: effectiveRemoteUrl(effectiveSandbox),
      service: effectiveSandbox.service,
      ...(usesWorktree
        ? { worktree_path: `.worktrees/${task.branch_name}` }
        : {}),
      commitMessage: `feat: ${task.title}`,
    });
    if (result.isError) {
      throw new TaskReviewPreparationError(
        `Unable to prepare task branch for review: ${result.stdout || 'unknown sandbox error'}`,
      );
    }
    return;
  }

  logger.info(
    { task_id: task.id, base_branch: baseBranch },
    '[review] Task HEAD already contains the review base; skipping prepare_review',
  );
}
