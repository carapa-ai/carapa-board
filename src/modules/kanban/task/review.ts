/**
 * Review decision handling — approval/rejection logic applied after a review
 * agent run completes.
 *
 * The structured JSON parsing itself lives in `../review.ts`; this module
 * handles the *actions* triggered by a parsed decision (merge, stage
 * transitions, backlog task creation, etc.).
 */
import { RegisteredGroup } from '../../../types.js';
import { Task, StageDefinition, StageEntryEventRef } from '../types.js';
import { getTask, updateTask, appendTaskReviewFeedback } from '../../../db.js';
import { updateActiveRunReviewScore } from '../../../db/active-runs.js';
import { appendTaskMessage } from '../../transcripts/transcript-store.js';
import { broadcast } from '../../objectives/ws-events.js';
import { logger } from '../../../logger.js';
import { MAX_REVIEW_REJECTIONS_CAP } from '../../../config.js';
import {
  getReviewReworkStage,
  getDeployStageId,
  getFirstExecutableStage,
  getInitialStage,
  getTestingBlockedStage,
  isAbExperimentTask,
} from '../stages.js';
import {
  appendMergeConflictReworkPrompt,
  mergeTaskBranchWithResolution,
  type MergeDependencies,
  type MergeWithResolutionResult,
} from './merge-conflict-resolution.js';
import { approvalRequiredNotice } from './merge-risk-gate.js';
import {
  publishEvent,
  publishEventWithResult,
  resolveBrainUrl,
  resolveBrainContainer,
} from '../../objectives/brain-client.js';
import type { PublishEventResult } from '../../objectives/brain-client.js';
import {
  DEPLOY_PENDING_DISPATCH_KEY,
  recoveredDeployDispatchValue,
  triggerDeploy,
} from './deploy.js';
import { taskEventHeaders } from './objective-events.js';
import { publishEventAndNotify } from './objective-event-holds.js';
import type {
  ReviewDecision,
  RejectionComparison,
  ReviewerVerdictSummary,
  ReviewHistoryEntry,
} from '../review.js';
import {
  PENDING_REVIEW_REVIEWERS_KEY,
  REVIEW_CHAIN_KEY,
  REVIEW_CHAIN_RUN_KEY,
} from './review-chain.js';
import { notifyEntityLifecycle } from '../../tools/push-tools.js';
import {
  formatReviewIssue,
  formatReviewIssues,
  MAX_REVIEW_NO_PROGRESS,
  readStoredReviewHistory,
  rejectionsSinceCapBase,
  reviewIssueId,
} from '../review.js';

/** Context passed to the review handler so it can act on the task. */
export interface ReviewContext {
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  /** The stage the task was running in when the review agent executed. */
  targetStatus: string;
  /** Exact active_runs row for this review execution. */
  runId?: string;
  /** Stage ID the task would advance to on success (deploy or done). */
  completionStageId: string;
  /** The assistant message content from the review agent. */
  assistantContent: string;
  /** Agent name for transcript attribution. */
  agent_name: string | null;
  /** Model name for transcript attribution. */
  model_name: string | null;
  /** New session ID returned by the agent run. */
  newSessionId?: string;
  /** Sandbox instance from the run result (for git merge). */
  sandbox_instance?: string;
  /** Branch HEAD at review time — stored to detect stale re-reviews. */
  review_head_sha?: string;
  /** The enclosing task pipeline already owns the shared-checkout lease. */
  leaseAlreadyHeld?: boolean;
  /** Restart recovery: never wait for another owner's checkout lease. */
  deferToOtherCheckoutOwner?: boolean;
  /** Restart recovery: the run whose result this transition applies. */
  recoveryRunId?: string;
  /**
   * Restart recovery: extra custom values written in the same update as the
   * stage transition (the recovery's proof that it moved the card).
   */
  transitionValues?: (status: string) => Record<string, string>;
  /**
   * Restart recovery: leave the deploy to the `deploy_pending_dispatch`
   * dispatcher instead of awaiting the build.
   */
  deferDeploy?: boolean;
  /** Every reviewer's verdict when several reviewers judged this commit. */
  reviewer_verdicts?: ReviewerVerdictSummary[];
  rejection_comparison?: RejectionComparison;
  rejection_comparison_attempted?: boolean;
  rejection_feedback_persisted?: boolean;
  stageEntryEventRef?: StageEntryEventRef;
  beforeTransition?: (
    changes?: Parameters<typeof updateTask>[1],
  ) => Promise<boolean>;
  runTransition?: (operation: () => Promise<void>) => Promise<boolean>;
}
async function applyReviewTransition(
  ctx: ReviewContext,
  changes: Parameters<typeof updateTask>[1],
): Promise<boolean> {
  if (ctx.beforeTransition) return ctx.beforeTransition(changes);
  const extra = changes?.status
    ? ctx.transitionValues?.(changes.status)
    : undefined;
  const stageEntryEvent = extra
    ? await updateTask(
        ctx.task.id,
        { ...changes, custom_values: { ...changes?.custom_values, ...extra } },
        // Without a full map in `changes`, merge instead of replacing.
        {
          ...(changes?.custom_values ? {} : { mergeCustomValues: true }),
          ...(ctx.recoveryRunId ? { recoveryRunId: ctx.recoveryRunId } : {}),
        },
      )
    : await updateTask(ctx.task.id, changes);
  if (ctx.stageEntryEventRef) {
    ctx.stageEntryEventRef.id = stageEntryEvent?.id;
  }
  return true;
}

/** Side-effecting collaborators, injectable so review integration tests do not
 * need process-global Bun module mocks. */
export interface ReviewDependencies {
  appendTaskMessage: typeof appendTaskMessage;
  broadcast: typeof broadcast;
  mergeTaskBranchWithResolution: (
    task: Task,
    group: RegisteredGroup,
    source: 'review',
    dependencies?: MergeDependencies,
    options?: { leaseAlreadyHeld?: boolean; deferToOtherOwner?: boolean },
  ) => Promise<MergeWithResolutionResult>;
  /** Fire-and-forget, or resolving to the publish result when it is known. */
  publishEvent: (
    ...args: Parameters<typeof publishEvent>
  ) => Promise<PublishEventResult | void> | void;
  resolveBrainUrl: typeof resolveBrainUrl;
  resolveBrainContainer: typeof resolveBrainContainer;
  triggerDeploy: typeof triggerDeploy;
  notifyEntityLifecycle?: typeof notifyEntityLifecycle;
}

const defaultReviewDependencies: ReviewDependencies = {
  appendTaskMessage,
  broadcast,
  mergeTaskBranchWithResolution,
  publishEvent: publishEventWithResult,
  resolveBrainUrl,
  resolveBrainContainer,
  triggerDeploy,
  notifyEntityLifecycle,
};

const CAP_REACHED_REASON = 'Rejection cap reached — split or re-scope the task';

/**
 * Publish the `review_no_progress` task_question event and send the matching
 * "needs input" notification, holding it while an objective handles the event.
 */
async function publishReviewQuestionAndNotify(
  task: Task,
  group: RegisteredGroup,
  dependencies: ReviewDependencies,
  reason: string,
  notification: Parameters<typeof notifyEntityLifecycle>[0],
): Promise<void> {
  await publishEventAndNotify(
    task,
    'task_question',
    async (timestamp) => {
      if (!task.objective_id) return undefined;
      const result = await dependencies.publishEvent(
        dependencies.resolveBrainUrl(dependencies.resolveBrainContainer(group)),
        {
          type: 'task_question',
          project_id: task.project_id,
          task_id: task.id,
          objective_id: task.objective_id,
          timestamp,
          data: {
            ...taskEventHeaders(task, group),
            status: task.status,
            source: 'review_no_progress',
            reason,
          },
        },
        group,
      );
      return result ?? { outcome: 'skipped' };
    },
    notification,
    { notify: dependencies.notifyEntityLifecycle },
  );
}

/**
 * Handle a parsed review decision: approve (merge + advance) or reject
 * (move back to active stage with issues comment).
 *
 * Callers should `return` after this function resolves — the review path
 * fully handles task state transitions and broadcasts.
 */
export async function handleReviewDecision(
  reviewDecision: ReviewDecision,
  ctx: ReviewContext,
  dependencies: ReviewDependencies = defaultReviewDependencies,
): Promise<void> {
  const { task, agent_name, model_name, review_head_sha } = ctx;
  const completed_at = new Date().toISOString();

  if (ctx.runId) {
    await updateActiveRunReviewScore(ctx.runId, reviewDecision.score);
  }

  const freshTask = await getTask(task.id);
  const currentValues: Record<string, string | number> = {
    ...(freshTask?.custom_values || {}),
  };
  const newValues: Record<string, string | number> = {
    ...currentValues,
    quality_score: reviewDecision.score,
    ...(review_head_sha ? { last_review_head: review_head_sha } : {}),
    // The card is decided once; clear a finished multi-reviewer chain. The
    // blank value (not a delete) also overrides stored copies merged later.
    ...(REVIEW_CHAIN_KEY in currentValues ? { [REVIEW_CHAIN_KEY]: '' } : {}),
    ...(REVIEW_CHAIN_RUN_KEY in currentValues
      ? { [REVIEW_CHAIN_RUN_KEY]: '' }
      : {}),
  };

  if (reviewDecision.decision === 'approve') {
    // Preserve the complete reviewer transcript (tool activity, commentary,
    // and final structured verdict) just as the rejection path does. The
    // readable summary below remains the compact decision card, while the
    // transcript keeps the evidence behind that decision visible after reload.
    if (ctx.assistantContent.trim()) {
      const reviewTranscriptMsg = dependencies.appendTaskMessage(
        task.project_id,
        {
          task_id: task.id,
          role: 'assistant',
          content: ctx.assistantContent,
          agent_name: agent_name,
          model_name: model_name,
          entry_type: 'run_result',
          run_id: ctx.runId ?? null,
          created_at: completed_at,
        },
      );
      if (reviewTranscriptMsg) {
        dependencies.broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: reviewTranscriptMsg,
          },
        });
      }
    }

    // Also persist a compact, human-readable verdict so users do not have to
    // inspect the JSON to understand the stage transition.
    const reviewAssistantMsg = dependencies.appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'assistant',
      content: formatApprovalMessage(reviewDecision),
      agent_name: agent_name,
      model_name: model_name,
      created_at: completed_at,
    });
    if (reviewAssistantMsg) {
      dependencies.broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: reviewAssistantMsg,
        },
      });
    }

    // A multi-reviewer round leaves a record of every reviewer's verdict.
    if (ctx.reviewer_verdicts) {
      newValues.review_history = JSON.stringify(
        [
          ...readStoredReviewHistory(currentValues),
          {
            timestamp: completed_at,
            commit: review_head_sha || '',
            issues: reviewDecision.issues.map((issue) => ({
              id: reviewIssueId(issue),
              text: formatReviewIssue(issue),
            })),
            summary: reviewDecision.summary,
            reviewers: ctx.reviewer_verdicts,
            decision: 'approve',
          } satisfies ReviewHistoryEntry,
        ].slice(-20),
      );
    }

    // On approval, the review agent becomes the "last" agent (task is done or deploying).
    await updateTask(task.id, { last_agent_name: agent_name });
    await handleApproval(
      reviewDecision,
      ctx,
      freshTask,
      currentValues,
      newValues,
      completed_at,
      dependencies,
    );
  } else {
    await handleRejection(
      reviewDecision,
      ctx,
      currentValues,
      newValues,
      completed_at,
      dependencies,
    );
  }
}

function formatApprovalMessage(reviewDecision: ReviewDecision): string {
  const heading = reviewDecision.issues.length
    ? `**Review accepted with nits** (score: ${reviewDecision.score}/10)`
    : `**Review approved** (score: ${reviewDecision.score}/10)`;
  const parts = [heading];
  if (reviewDecision.summary) parts.push(reviewDecision.summary);
  if (reviewDecision.issues.length) {
    parts.push(
      `**Non-blocking issues:**\n${formatReviewIssues(reviewDecision.issues)}`,
    );
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum polish passes an accepted-with-nits review may reopen a card for. */
const MAX_NIT_POLISH_ROUNDS = 2;

async function handleApproval(
  reviewDecision: ReviewDecision,
  ctx: ReviewContext,
  freshTask: Task | undefined,
  currentValues: Record<string, string | number>,
  newValues: Record<string, string | number>,
  completed_at: string,
  dependencies: ReviewDependencies,
): Promise<void> {
  const { task, group, stages, targetStatus, completionStageId, newSessionId } =
    ctx;
  const approveStageId = completionStageId; // deploy or first done stage

  const priorNitRounds =
    typeof currentValues.nit_round_count === 'number' &&
    Number.isFinite(currentValues.nit_round_count)
      ? currentValues.nit_round_count
      : 0;
  // A re-review of the head the previous nit review already judged means the
  // polish pass added no commit; another round would change nothing.
  const sameHeadAsLastNitReview =
    priorNitRounds > 0 &&
    !!ctx.review_head_sha &&
    currentValues.last_review_head === ctx.review_head_sha;
  const roundCapReached = priorNitRounds >= MAX_NIT_POLISH_ROUNDS;
  const polishCapReached =
    reviewDecision.issues.length > 0 &&
    (roundCapReached || sameHeadAsLastNitReview);

  // An approval with issues is not complete yet: reopen the same card in an
  // executable implementation stage for a polish pass and re-review, up to
  // MAX_NIT_POLISH_ROUNDS. Never create or park a follow-up in backlog for
  // this verdict. Past the cap the nits are recorded as notes and the card
  // takes the normal approval path below.
  if (reviewDecision.issues.length > 0 && !polishCapReached) {
    const reworkStage =
      getReviewReworkStage(stages, targetStatus) ??
      getFirstExecutableStage(stages);
    if (!reworkStage) {
      logger.warn(
        { task_id: task.id, review_stage: targetStatus },
        '[review] Accepted with nits but no executable rework stage exists — keeping task in review',
      );
      return;
    }

    if (ctx.beforeTransition && !(await ctx.beforeTransition())) return;
    await appendTaskReviewFeedback(task.id, {
      reviewer: ctx.agent_name || 'unknown',
      verdict: 'accepted with nits',
      timestamp: completed_at,
      nits: reviewDecision.issues,
    });
    newValues.nit_round_count = priorNitRounds + 1;
    const transitionChanges = {
      status: reworkStage.id,
      custom_values: newValues,
      session_id: task.session_id || '',
      last_agent_name: task.last_agent_name || '',
    };
    if (!(await applyReviewTransition(ctx, transitionChanges))) return;
    const reopened = await getTask(task.id);
    if (reopened) {
      dependencies.broadcast({ type: 'task_updated', payload: reopened });
    }
    logger.info(
      {
        task_id: task.id,
        toStage: reworkStage.id,
        nit_count: reviewDecision.issues.length,
      },
      '[review] Accepted with nits — reopening original task for polish pass',
    );
    return;
  }

  if (ctx.beforeTransition && !(await ctx.beforeTransition())) return;
  if (polishCapReached) {
    await appendTaskReviewFeedback(task.id, {
      reviewer: ctx.agent_name || 'unknown',
      verdict: 'accepted with nits (polish cap reached)',
      timestamp: completed_at,
      nits: reviewDecision.issues,
    });
    logger.info(
      {
        task_id: task.id,
        nit_round_count: priorNitRounds,
        reason: roundCapReached ? 'round cap' : 'unchanged head',
      },
      '[review] Accepted with nits — polish cap reached, merging with nits as notes',
    );
  }
  // Merge task branch into default branch before advancing.
  // The shared merge flow serializes each merge/retry and keeps the existing
  // task worktree intact while its conflict resolver runs.
  const mergeTask = freshTask || task;
  let mergeResult!: MergeWithResolutionResult;
  let mergeAllowed = true;
  if (ctx.runTransition) {
    mergeAllowed = await ctx.runTransition(async () => {
      mergeResult = await dependencies.mergeTaskBranchWithResolution(
        mergeTask,
        group,
        'review',
        undefined,
        {
          leaseAlreadyHeld: !!ctx.leaseAlreadyHeld,
          deferToOtherOwner: ctx.deferToOtherCheckoutOwner,
        },
      );
    });
  } else {
    mergeResult = await dependencies.mergeTaskBranchWithResolution(
      mergeTask,
      group,
      'review',
      undefined,
      {
        leaseAlreadyHeld: !!ctx.leaseAlreadyHeld,
        deferToOtherOwner: ctx.deferToOtherCheckoutOwner,
      },
    );
  }
  if (!mergeAllowed) return;
  const { mergeOk, output: mergeOutput } = mergeResult;
  if (ctx.beforeTransition && !(await ctx.beforeTransition())) return;
  if (!mergeOk) {
    // Environmental/operational failures never launch the resolver. Park the
    // approved task outside executable review so the queue cannot pay for a
    // second verdict on unchanged code. In particular, a dirty default
    // checkout is preserved.
    if (mergeResult.failureKind !== 'conflict') {
      const retryStageId = getInitialStage(stages)?.id ?? targetStatus;
      if (
        !(await applyReviewTransition(ctx, {
          status: retryStageId,
          custom_values: newValues,
          session_id: newSessionId,
        }))
      )
        return;
      const mergeRetryContent =
        mergeResult.failureKind === 'approval_required'
          ? await approvalRequiredNotice(mergeTask, group, mergeResult, {
              parkedStageId: retryStageId,
              resume: true,
            })
          : `**Review approved, merge pending** — the approved branch could not be merged because of an environment/operation error. ` +
            `The task was paused in \`${retryStageId}\` so another reviewer is not started. Retry after correcting the merge environment.\n\n${mergeOutput}`;
      const mergeRetryMsg = dependencies.appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'system',
        entry_type: 'system_notice',
        content: mergeRetryContent,
        created_at: new Date().toISOString(),
      });
      if (mergeRetryMsg) {
        dependencies.broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: mergeRetryMsg,
          },
        });
      }
      const pendingMergeTask = await getTask(task.id);
      if (pendingMergeTask) {
        dependencies.broadcast({
          type: 'task_updated',
          payload: pendingMergeTask,
        });
      }
      logger.warn(
        { task_id: task.id, toStage: retryStageId, output: mergeOutput },
        mergeResult.failureKind === 'approval_required'
          ? '[review] Approved merge needs human approval — parking without re-review'
          : '[review] Approved merge environment error — parking without re-review',
      );
      return;
    }

    const reworkStage = getFirstExecutableStage(stages);
    if (!reworkStage) {
      logger.error(
        { task_id: task.id, output: mergeOutput },
        '[review] Merge conflict found but project has no active rework stage',
      );
      return;
    }
    appendMergeConflictReworkPrompt(
      mergeTask,
      reworkStage.id,
      group.settings?.defaultBranch || 'develop',
      mergeOutput,
      dependencies,
    );
    const latest = await getTask(task.id);
    if (
      !(await applyReviewTransition(ctx, {
        status: reworkStage.id,
        custom_values: {
          ...(latest?.custom_values || {}),
          ...newValues,
        },
        completed_at: null,
        session_id: task.session_id || '',
      }))
    )
      return;

    logger.warn(
      {
        task_id: task.id,
        toStage: reworkStage.id,
        output: mergeOutput,
      },
      '[review] Merge conflict — returning task to implementation',
    );

    const updatedOnConflict = await getTask(task.id);
    if (updatedOnConflict) {
      dependencies.broadcast({
        type: 'task_updated',
        payload: updatedOnConflict,
      });
    }
  } else {
    await completeApprovedMerge(
      {
        task,
        group,
        stages,
        approveStageId,
        completedAt: completed_at,
        newValues,
        newSessionId,
        score: reviewDecision.score,
        runId: ctx.runId,
        stageEntryEventRef: ctx.stageEntryEventRef,
        deferDeploy: ctx.deferDeploy,
        applyTransition: (changes) => applyReviewTransition(ctx, changes),
        mergeResult,
      },
      dependencies,
    );
  }
}

/** `custom_values` keys the merge itself writes (see `mergeTaskBranch`). */
const MERGE_OWNED_VALUE_KEYS = [
  'task_diff_base_sha',
  'linked_repository_merges',
] as const;

/** Collaborators used after an approved branch has been merged. */
export type ApprovedMergeCompletionDependencies = Pick<
  ReviewDependencies,
  | 'broadcast'
  | 'triggerDeploy'
  | 'publishEvent'
  | 'resolveBrainUrl'
  | 'resolveBrainContainer'
  | 'notifyEntityLifecycle'
>;

export interface ApprovedMergeCompletion {
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  /** Deploy or first done stage the merged task advances to. */
  approveStageId: string;
  completedAt: string;
  newValues: Record<string, string | number>;
  newSessionId?: string;
  score?: number;
  runId?: string;
  stageEntryEventRef?: StageEntryEventRef;
  /** Restart recovery: the approval writes the pending-dispatch marker and the deploy is left to its dispatcher. */
  deferDeploy?: boolean;
  /** Applies the stage change; resolves false when the caller refused it. */
  applyTransition: (
    changes: Parameters<typeof updateTask>[1],
  ) => Promise<boolean>;
  mergeResult?: MergeWithResolutionResult;
}

/**
 * Post-merge tail of an approved task: advance to the completion stage,
 * broadcast the update and emit deploy/completion events. Shared by the review
 * handler and the parked-merge retry sweep. Resolves false when the transition
 * was refused.
 */
export async function completeApprovedMerge(
  input: ApprovedMergeCompletion,
  dependencies: ApprovedMergeCompletionDependencies = defaultReviewDependencies,
): Promise<boolean> {
  const { task, group, approveStageId, stageEntryEventRef } = input;
  const latestAfterMerge = await getTask(task.id);
  // The merge just wrote these; `newValues` carries the pre-merge copies and
  // must not restore them.
  const reviewValues = { ...input.newValues };
  for (const key of MERGE_OWNED_VALUE_KEYS) delete reviewValues[key];
  const retainCheckoutReferences =
    input.mergeResult?.skipped === 'ab_variant' || isAbExperimentTask(task);
  const entersDeploy =
    approveStageId === getDeployStageId(group.settings, input.stages) &&
    !!group.settings?.deployService;
  const transitionChanges = {
    status: approveStageId,
    custom_values: {
      ...(latestAfterMerge?.custom_values || {}),
      ...reviewValues,
      // Written with the approval itself, so only an approved merge is
      // dispatched. A live run's marker is a plain timestamp, recovery's is
      // tagged as its own.
      ...(entersDeploy
        ? {
            [DEPLOY_PENDING_DISPATCH_KEY]: input.deferDeploy
              ? recoveredDeployDispatchValue(input.completedAt)
              : input.completedAt,
          }
        : {}),
    },
    completed_at: input.completedAt,
    session_id: input.newSessionId,
    ...(retainCheckoutReferences
      ? {}
      : {
          branch_name: null,
          worktree_path: null,
        }),
  };
  if (!(await input.applyTransition(transitionChanges))) return false;
  logger.info(
    { task_id: task.id, score: input.score, toStage: approveStageId },
    '[review] Approved — advancing task',
  );

  // Broadcast updated task so the UI immediately gets custom_values (including quality_score)
  const updatedOnApprove = await getTask(task.id);
  if (updatedOnApprove) {
    dependencies.broadcast({
      type: 'task_updated',
      payload: updatedOnApprove,
    });
  }

  if (entersDeploy) {
    if (!input.deferDeploy) {
      await dependencies.triggerDeploy(updatedOnApprove ?? task, group, {
        skipMerge: true,
        lifecycleRunId: input.runId ?? task.id,
        stageEntryEventId: stageEntryEventRef?.id,
      });
    }
  } else {
    dependencies.broadcast({
      type: 'task_completed',
      payload: { task_id: task.id, project_id: task.project_id },
    });
    dependencies.publishEvent(
      dependencies.resolveBrainUrl(dependencies.resolveBrainContainer(group)),
      {
        type: 'task_completed',
        project_id: task.project_id,
        task_id: task.id,
        objective_id: task.objective_id ?? null,
        timestamp: new Date().toISOString(),
        data: {
          ...taskEventHeaders(updatedOnApprove ?? task, group),
          status: approveStageId,
          review: true,
        },
      },
      group,
    );
    await (dependencies.notifyEntityLifecycle ?? notifyEntityLifecycle)({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: input.runId ?? task.id,
      event: 'completed',
      title: `Task completed: ${task.title}`,
      defer_stage_entry: true,
      stage_entry_event_id: stageEntryEventRef?.id,
    });
  }
  return true;
}

async function handleRejection(
  reviewDecision: ReviewDecision,
  ctx: ReviewContext,
  currentValues: Record<string, string | number>,
  newValues: Record<string, string | number>,
  completed_at: string,
  dependencies: ReviewDependencies,
): Promise<void> {
  const {
    task,
    group,
    stages,
    targetStatus,
    rejection_comparison,
    rejection_comparison_attempted,
  } = ctx;

  // Restart at the implementation stage so fixes flow through every later
  // executable stage (for example testing) before review runs again.
  const reworkStage = getReviewReworkStage(stages, targetStatus);
  const rejectStageId =
    reworkStage?.id ?? getFirstExecutableStage(stages)?.id ?? targetStatus;
  const currentCount =
    typeof currentValues.rejection_count === 'number'
      ? currentValues.rejection_count
      : 0;
  newValues.rejection_count = currentCount + 1;
  const noProgress =
    typeof currentValues.no_progress_count === 'number'
      ? currentValues.no_progress_count
      : 0;
  const progress = rejection_comparison?.progress ?? 'ambiguous';
  const nextNoProgress =
    progress === 'new_issue' || progress === 'resolved_issue'
      ? 0
      : noProgress + 1;
  newValues.no_progress_count = nextNoProgress;
  const history = readStoredReviewHistory(currentValues);
  const entry: ReviewHistoryEntry = {
    timestamp: completed_at,
    commit: ctx.review_head_sha || '',
    issues: reviewDecision.issues.map((issue) => ({
      id: reviewIssueId(issue),
      text: formatReviewIssue(issue),
    })),
    summary: reviewDecision.summary,
    ...(reviewDecision.advisory_issues?.length
      ? {
          advisory_issues: reviewDecision.advisory_issues.map((issue) => ({
            id: reviewIssueId(issue),
            text: formatReviewIssue(issue),
          })),
        }
      : {}),
    ...(reviewDecision.advisory_summary
      ? { advisory_summary: reviewDecision.advisory_summary }
      : {}),
    // Per-stage attribution for re-review prompts: a chain round records it in
    // the reviewers' summaries, a single-reviewer round on the entry itself.
    ...(ctx.reviewer_verdicts
      ? { reviewers: ctx.reviewer_verdicts }
      : { stage_id: targetStatus }),
    ...(rejection_comparison
      ? {
          comparison: {
            decision: rejection_comparison.decision,
            progress: rejection_comparison.progress,
            reason: rejection_comparison.reason,
          },
        }
      : {}),
  };
  newValues.review_history = JSON.stringify([...history, entry].slice(-20));
  newValues.pending_review_decision = '';
  newValues.pending_review_head = '';
  if (PENDING_REVIEW_REVIEWERS_KEY in newValues) {
    newValues[PENDING_REVIEW_REVIEWERS_KEY] = '';
  }

  const { base: capBase, since: rejectionsSinceBase } = rejectionsSinceCapBase(
    currentValues,
    currentCount + 1,
  );
  const capReached = rejectionsSinceBase >= MAX_REVIEW_REJECTIONS_CAP;
  if (
    capReached ||
    rejection_comparison?.decision === 'pause' ||
    (rejection_comparison_attempted && !rejection_comparison) ||
    nextNoProgress >= MAX_REVIEW_NO_PROGRESS
  ) {
    // Same parking order as Testing: Question (automatic recovery attempt when
    // it runs on entry), then explicit Backlog, then the first queue stage.
    const questionStageId = getTestingBlockedStage(stages)?.id ?? rejectStageId;
    if (
      !(await applyReviewTransition(ctx, {
        status: questionStageId,
        custom_values: newValues,
        session_id: task.session_id || '',
        last_agent_name: task.last_agent_name || '',
      }))
    )
      return;

    const issueLines = formatReviewIssues(reviewDecision.issues);
    if (!ctx.rejection_feedback_persisted) {
      const commentText = `**Review paused** (${currentCount + 1} total rejections${capBase > 0 ? `, ${rejectionsSinceBase} since the last human retry` : ''}, ${nextNoProgress} consecutive no-progress rounds) — parked for recovery or manual resolution.\n\n${capReached ? `${CAP_REACHED_REASON}\n\n` : ''}${rejection_comparison?.reason || 'No meaningful progress was established.'}\n\n${reviewDecision.summary}\n\n**Last issues:**\n${issueLines}`;
      const commentMsg = dependencies.appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'system',
        entry_type: 'review_feedback',
        content: commentText,
        created_at: new Date().toISOString(),
      });
      dependencies.broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: commentMsg,
        },
      });
    }
    logger.warn(
      {
        task_id: task.id,
        rejectionCount: currentCount + 1,
        toStage: questionStageId,
        cause: capReached ? 'rejection_cap' : 'no_progress',
      },
      capReached
        ? '[review] Rejection cap reached — parking in question stage'
        : '[review] No-progress threshold reached — parking in question stage',
    );
    const updatedOnLimit = await getTask(task.id);
    if (updatedOnLimit) {
      dependencies.broadcast({ type: 'task_updated', payload: updatedOnLimit });
      await publishReviewQuestionAndNotify(
        updatedOnLimit,
        group,
        dependencies,
        capReached
          ? CAP_REACHED_REASON
          : rejection_comparison?.reason ||
              'Review made no meaningful progress and requires manual attention.',
        {
          group_folder: updatedOnLimit.project_id,
          task_id: updatedOnLimit.id,
          run_id: ctx.runId ?? updatedOnLimit.id,
          event: 'needs_input',
          title: `Task needs input: ${updatedOnLimit.title}`,
          defer_stage_entry: true,
          stage_entry_event_id: ctx.stageEntryEventRef?.id,
        },
      );
    }
    return;
  }
  if (
    !(await applyReviewTransition(ctx, {
      status: rejectStageId,
      custom_values: newValues,
      session_id: task.session_id || '',
      last_agent_name: task.last_agent_name || '',
    }))
  )
    return;

  // Add comment with issues
  if (ctx.rejection_feedback_persisted) {
    logger.info(
      { task_id: task.id },
      '[review] Rejection feedback already persisted before comparison',
    );
    const updatedOnReject = await getTask(task.id);
    if (updatedOnReject)
      dependencies.broadcast({
        type: 'task_updated',
        payload: updatedOnReject,
      });
    return;
  }

  const issueLines = formatReviewIssues(reviewDecision.issues);
  const commentText = `**Review rejected** (score: ${reviewDecision.score}/10, rejection ${currentCount + 1})\n\n${reviewDecision.summary}\n\n**Issues:**\n${issueLines}`;
  const commentMsg = dependencies.appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    content: commentText,
    created_at: new Date().toISOString(),
  });
  dependencies.broadcast({
    type: 'task_message',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      message: commentMsg,
    },
  });

  logger.info(
    {
      task_id: task.id,
      score: reviewDecision.score,
      toStage: rejectStageId,
      issueCount: reviewDecision.issues.length,
    },
    '[review] Rejected — returning task to active stage',
  );
  const updatedOnReject = await getTask(task.id);
  if (updatedOnReject) {
    dependencies.broadcast({ type: 'task_updated', payload: updatedOnReject });
  }
}
