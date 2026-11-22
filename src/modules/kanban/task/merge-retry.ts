/**
 * Retry sweep for review-approved cards parked because the merge was refused
 * (e.g. dirty default checkout). The review stage parks such a card in the
 * initial stage with a "Review approved, merge pending" notice and nothing else
 * ever retries; this sweep merges it once the environment is clean again,
 * without paying for a second review.
 *
 * Fail-closed throughout: the sweep never stashes, cleans or resets anything,
 * merges only when the default checkout is already safe, and refuses to merge
 * an approval made stale by overlapping changes on the default branch.
 */
// Load the tool registry first: kanban/tools.js and the registry import each
// other, and evaluating kanban/tools.js first leaves its exports uninitialized.
import '../../tools/registry.js';
import type { RegisteredGroup } from '../../../types.js';
import type { TaskBranchMergeResult } from '../../../lib/git-ops.js';
import { COMMIT_SHA_PATTERN } from '../../../lib/git-commit.js';
import type { StageEntryEventRef, Task, TaskMessage } from '../types.js';
import type { ActiveRun } from '../execution/types.js';
import { getAllTasks, getTask, updateTask } from '../../../db.js';
import {
  getActiveRunForTask,
  getRunsForTask,
} from '../../../db/active-runs.js';
import { getGroupByFolder } from '../../../state-manager.js';
import {
  appendTaskMessage,
  readTaskMessages,
} from '../../transcripts/transcript-store.js';
import { broadcast } from '../../objectives/ws-events.js';
import {
  parseGitPathList,
  runGitInRepo,
  sharedCheckoutIsSafe,
  validatedInstance,
} from '../../../lib/git-ops.js';
import { logger } from '../../../logger.js';
import {
  getDoneStage,
  getGroupStages,
  getInitialStage,
  getNextActiveStage,
  isReviewStage,
} from '../stages.js';
import {
  REVIEW_APPROVED_MERGE_PENDING_PREFIX,
  findMergePending,
} from '../tools.js';
import { mergeTaskBranchWithResolution } from './merge-conflict-resolution.js';
import { approvalRequiredNotice } from './merge-risk-gate.js';
import { drainProjectQueue } from './pipeline.js';
import { completeApprovedMerge } from './review.js';

const MAX_MERGE_RETRIES_PER_CARD = 3;
const MAX_MERGE_RETRIES_PER_PASS = 5;
export const MERGE_RETRY_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Notices appended by the sweep. Both count toward the per-card limit. */
const MERGE_RETRY_NOTICE_PREFIX = '**Merge retry';
const MERGE_RETRY_FAILED_PREFIX = '**Merge retry failed**';
/** Terminal for the sweep: a human must move the card to review. */
const MERGE_RETRY_BLOCKED_PREFIX = '**Merge retry blocked**';
const MAX_NOTICE_OUTPUT_CHARS = 2_000;
const MAX_NOTICE_BLOCKERS = 30;
const BLOCKERS_HEADING = 'Blocking default checkout entries:';

/** Default-on kill switch: `TASK_MERGE_RETRY_SWEEP=0` disables the sweep. */
export function isMergeRetrySweepEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.TASK_MERGE_RETRY_SWEEP?.trim() !== '0';
}

export type ApprovalDrift =
  | { ok: true; developFiles: string[]; taskFiles: string[] }
  | { ok: false; error: string };

export interface MergeRetryDependencies {
  isEnabled: () => boolean;
  listTasks: () => Promise<Task[]>;
  getGroup: (folder: string) => RegisteredGroup | undefined;
  readMessages: (projectId: string, taskId: string) => TaskMessage[];
  getRuns: (taskId: string) => Promise<ActiveRun[]>;
  branchExists: (task: Task, group: RegisteredGroup) => Promise<boolean>;
  /** Fresh re-read: the card is still parked unmerged in the initial stage
   * with no active run (a user may have moved it while git calls ran). */
  stillParked: (task: Task, group: RegisteredGroup) => Promise<boolean>;
  sharedCheckoutIsSafe: typeof sharedCheckoutIsSafe;
  /** Files changed on the default branch since the task branch diverged,
   * and files changed by the task branch itself. */
  inspectDrift: (
    task: Task,
    group: RegisteredGroup,
    defaultBranch: string,
  ) => Promise<ApprovalDrift>;
  mergeTaskBranchWithResolution: typeof mergeTaskBranchWithResolution;
  completeApprovedMerge: (
    task: Task,
    group: RegisteredGroup,
    approveStageId: string,
  ) => Promise<boolean>;
  /** Starts work released by a completed merge (dependents, the next stage). */
  drainProjectQueue: typeof drainProjectQueue;
  appendNotice: (task: Task, content: string) => void;
  logger: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
}

async function branchExists(
  task: Task,
  group: RegisteredGroup,
): Promise<boolean> {
  if (!task.branch_name || !/^[\w./-]+$/.test(task.branch_name)) return false;
  const result = await runGitInRepo(
    group,
    `rev-parse --verify --quiet refs/heads/${task.branch_name}`,
    validatedInstance(task, group),
  );
  return result.ok;
}

/** The card as stored now, if it is still idle in the initial stage. */
async function currentIdleParkedTask(
  task: Task,
  group: RegisteredGroup,
): Promise<Task | undefined> {
  const [fresh, activeRun] = await Promise.all([
    getTask(task.id),
    getActiveRunForTask(task.id),
  ]);
  if (!fresh || fresh.archived || activeRun) return undefined;
  return fresh.status === getInitialStage(getGroupStages(group))?.id
    ? fresh
    : undefined;
}

async function stillParked(
  task: Task,
  group: RegisteredGroup,
): Promise<boolean> {
  const fresh = await currentIdleParkedTask(task, group);
  return !!fresh && !fresh.merge_commit && !!fresh.branch_name;
}

async function inspectDrift(
  task: Task,
  group: RegisteredGroup,
  defaultBranch: string,
): Promise<ApprovalDrift> {
  const branch = task.branch_name ?? '';
  const refPattern = /^[\w./-]+$/;
  if (!refPattern.test(branch) || !refPattern.test(defaultBranch)) {
    return { ok: false, error: 'invalid ref name' };
  }
  const instance = validatedInstance(task, group);
  try {
    const baseResult = await runGitInRepo(
      group,
      `merge-base ${defaultBranch} ${branch}`,
      instance,
    );
    const base = baseResult.output.trim();
    if (!baseResult.ok || !COMMIT_SHA_PATTERN.test(base)) {
      return { ok: false, error: 'merge-base failed' };
    }
    const [develop, own] = await Promise.all([
      runGitInRepo(
        group,
        `diff --name-only --no-renames ${base} ${defaultBranch}`,
        instance,
      ),
      runGitInRepo(
        group,
        `diff --name-only --no-renames ${base} ${branch}`,
        instance,
      ),
    ]);
    if (!develop.ok || !own.ok) return { ok: false, error: 'diff failed' };
    return {
      ok: true,
      developFiles: parseGitPathList(develop.output),
      taskFiles: parseGitPathList(own.output),
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const defaultMergeRetryDependencies: MergeRetryDependencies = {
  isEnabled: () => isMergeRetrySweepEnabled(),
  listTasks: getAllTasks,
  getGroup: getGroupByFolder,
  readMessages: readTaskMessages,
  getRuns: (taskId) => getRunsForTask(taskId, 50),
  branchExists,
  stillParked,
  sharedCheckoutIsSafe,
  inspectDrift,
  mergeTaskBranchWithResolution,
  completeApprovedMerge: async (task, group, approveStageId) => {
    const stageEntryEventRef: StageEntryEventRef = {};
    return completeApprovedMerge({
      task,
      group,
      stages: getGroupStages(group),
      approveStageId,
      completedAt: new Date().toISOString(),
      newValues: {},
      stageEntryEventRef,
      applyTransition: async (changes) => {
        if (!(await currentIdleParkedTask(task, group))) return false;
        const event = await updateTask(task.id, changes);
        stageEntryEventRef.id = event?.id;
        return true;
      },
    });
  },
  drainProjectQueue,
  appendNotice: (task, content) => {
    const message = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'system_notice',
      content,
      created_at: new Date().toISOString(),
    });
    broadcast({
      type: 'task_message',
      payload: { task_id: task.id, project_id: task.project_id, message },
    });
  },
  logger,
};

export interface MergeRetrySweepResult {
  attempted: number;
  merged: number;
}

/** Stage whose approval the card carries: its latest review-stage run. */
function approvalCompletionStageId(
  task: Task,
  group: RegisteredGroup,
  runs: ActiveRun[],
): string {
  const stages = getGroupStages(group);
  const reviewStageId =
    runs.find((run) => run.stage && isReviewStage(stages, run.stage))?.stage ??
    stages.find((stage) => stage.type === 'review' && !stage.inactive)?.id;
  const next = reviewStageId
    ? getNextActiveStage(stages, reviewStageId, task.skip_stages ?? undefined)
    : undefined;
  return next?.id ?? getDoneStage(stages)?.id ?? 'completed';
}

/**
 * Environment-failure body: the truncated raw output plus the blocking
 * checkout entries listed separately, so the paths survive truncation
 * (git-ops appends its own copy of the list to the END of the output).
 */
function formatEnvironmentFailure(merge: TaskBranchMergeResult): string {
  const blockers = merge.blockers ?? [];
  if (blockers.length === 0) return truncate(merge.output);
  const headingAt = merge.output.indexOf(`\n\n${BLOCKERS_HEADING}`);
  const output =
    headingAt >= 0 ? merge.output.slice(0, headingAt) : merge.output;
  const listed = blockers
    .slice(0, MAX_NOTICE_BLOCKERS)
    .map((entry) => `${entry.status} ${JSON.stringify(entry.path)}`);
  if (blockers.length > MAX_NOTICE_BLOCKERS) {
    listed.push(`… (+${blockers.length - MAX_NOTICE_BLOCKERS} more)`);
  }
  return `${truncate(output)}\n\n${BLOCKERS_HEADING}\n${listed.join('\n')}`;
}

function truncate(output: string): string {
  const text = output.trim();
  return text.length > MAX_NOTICE_OUTPUT_CHARS
    ? `${text.slice(0, MAX_NOTICE_OUTPUT_CHARS)}…`
    : text;
}

export type ParkedMergeOutcome =
  | 'merged'
  | 'transition_refused'
  | 'approval_required'
  | 'conflict'
  | 'environment'
  | 'error';

/**
 * One merge attempt for a review-approved parked card: merge, then complete it
 * into the stage after review. Every failure leaves the matching notice on the
 * card (a person's approval, a conflict, an environment error) and never
 * throws. Shared by the retry sweep and the merge approval decision.
 */
export async function attemptParkedMerge(
  task: Task,
  group: RegisteredGroup,
  runs: ActiveRun[],
  deps: MergeRetryDependencies = defaultMergeRetryDependencies,
  options: { afterHumanApproval?: boolean } = {},
): Promise<ParkedMergeOutcome> {
  // The card's latest merge notice was the approval-required one, which no
  // retry matches. After a person approved, an environment failure must put it
  // back in the ordinary review-approved merge-pending state so the sweep
  // retries once the environment is repaired (the approval stays applied).
  const restorePending = () => {
    if (!options.afterHumanApproval) return;
    deps.appendNotice(
      task,
      `${REVIEW_APPROVED_MERGE_PENDING_PREFIX} — a person approved this commit, but the branch could not be merged because of an environment/operation error. The approval stays valid; the merge is retried automatically once the environment is fixed.`,
    );
  };
  const context = { task_id: task.id, project_id: task.project_id };
  const skip = (reason: string) =>
    deps.logger.debug({ ...context, reason }, 'merge_retry_skipped');
  try {
    const merge = await deps.mergeTaskBranchWithResolution(
      task,
      group,
      'recovery',
    );
    if (merge.mergeOk) {
      const completed = await deps.completeApprovedMerge(
        task,
        group,
        approvalCompletionStageId(task, group, runs),
      );
      deps.logger.info(
        { ...context, reason: completed ? 'merged' : 'transition_refused' },
        'merge_retry_merged',
      );
      // No run is active and done stages have no entry event, so nothing else
      // would start the dependents this merge released.
      if (completed) {
        void (async () =>
          deps.drainProjectQueue(task.project_id, group))().catch((err) =>
          deps.logger.warn(
            { ...context, error: String(err) },
            'merge_retry_drain_failed',
          ),
        );
      }
      return completed ? 'merged' : 'transition_refused';
    }
    if (merge.failureKind === 'approval_required') {
      // Waiting for a person is neither a retry failure nor a block; the
      // notice also stops findMergePending from matching this card again.
      skip('approval_required');
      deps.appendNotice(
        task,
        await approvalRequiredNotice(task, group, merge, { resume: true }),
      );
      return 'approval_required';
    }
    if (merge.failureKind === 'conflict') {
      skip('merge_conflict');
      deps.appendNotice(
        task,
        `${MERGE_RETRY_BLOCKED_PREFIX} — merging the approved branch conflicts; move to review.\n\n${truncate(merge.output)}`,
      );
      return 'conflict';
    }
    skip('merge_environment_error');
    deps.appendNotice(
      task,
      `${MERGE_RETRY_FAILED_PREFIX} — the approved branch still could not be merged; the card stays parked.\n\n${formatEnvironmentFailure(merge)}`,
    );
    restorePending();
    return 'environment';
  } catch (err) {
    deps.logger.warn({ ...context, error: String(err) }, 'merge_retry_failed');
    deps.appendNotice(
      task,
      `${MERGE_RETRY_FAILED_PREFIX} — ${truncate(String(err))}`,
    );
    restorePending();
    return 'error';
  }
}

/**
 * One pass over every project: merge review-approved cards that were parked by
 * an environment merge failure, at most one attempt per project and
 * {@link MAX_MERGE_RETRIES_PER_PASS} per pass.
 */
export async function sweepParkedApprovedMerges(
  deps: MergeRetryDependencies = defaultMergeRetryDependencies,
): Promise<MergeRetrySweepResult> {
  const result: MergeRetrySweepResult = { attempted: 0, merged: 0 };
  if (!deps.isEnabled()) return result;

  const tasks = await deps.listTasks();
  const doneProjects = new Set<string>();

  for (const task of tasks) {
    if (result.attempted >= MAX_MERGE_RETRIES_PER_PASS) break;
    if (doneProjects.has(task.project_id)) continue;
    if (task.archived || task.merge_commit || !task.branch_name) continue;
    const group = deps.getGroup(task.project_id);
    if (!group) continue;
    const stages = getGroupStages(group);
    if (getInitialStage(stages)?.id !== task.status) continue;

    const messages = deps.readMessages(task.project_id, task.id);
    const runs = await deps.getRuns(task.id);
    const pending = findMergePending(task, messages, runs);
    if (!pending?.reason.startsWith(REVIEW_APPROVED_MERGE_PENDING_PREFIX))
      continue;
    const afterPending = messages.filter(
      (message) =>
        message.entry_type === 'system_notice' &&
        message.created_at > pending.at &&
        message.content.startsWith(MERGE_RETRY_NOTICE_PREFIX),
    );
    if (
      afterPending.length >= MAX_MERGE_RETRIES_PER_CARD ||
      afterPending.some((m) => m.content.startsWith(MERGE_RETRY_BLOCKED_PREFIX))
    )
      continue;

    const context = { task_id: task.id, project_id: task.project_id };
    const skip = (reason: string) =>
      deps.logger.debug({ ...context, reason }, 'merge_retry_skipped');
    const defaultBranch = group.settings?.defaultBranch || 'develop';

    if (!(await deps.branchExists(task, group))) {
      skip('branch_missing');
      continue;
    }
    if (
      !(await deps.sharedCheckoutIsSafe(task, group, true, [defaultBranch]))
    ) {
      skip('checkout_not_safe');
      doneProjects.add(task.project_id);
      continue;
    }

    const drift = await deps.inspectDrift(task, group, defaultBranch);
    if (!drift.ok) {
      skip(`drift_check_failed: ${drift.error}`);
      continue;
    }
    const developFiles = new Set(drift.developFiles);
    const overlap = drift.taskFiles.filter((file) => developFiles.has(file));
    if (overlap.length > 0) {
      skip('stale_approval_overlap');
      deps.appendNotice(
        task,
        `${MERGE_RETRY_BLOCKED_PREFIX} — develop changed overlapping files; move to review. ` +
          `The approval predates changes to: ${overlap.slice(0, 10).join(', ')}` +
          (overlap.length > 10 ? `, … (+${overlap.length - 10} more)` : ''),
      );
      continue;
    }

    if (!(await deps.stillParked(task, group))) {
      skip('state_changed');
      continue;
    }

    result.attempted += 1;
    doneProjects.add(task.project_id);
    deps.logger.info({ ...context, reason: 'parked' }, 'merge_retry_attempted');
    const outcome = await attemptParkedMerge(task, group, runs, deps);
    if (outcome === 'merged' || outcome === 'transition_refused') {
      result.merged += 1;
    }
  }
  return result;
}
