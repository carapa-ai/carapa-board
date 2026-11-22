/**
 * Task execution pipeline — executeTask, queue draining, task stopping.
 *
 * This is the main orchestration module for task execution. It manages:
 * - The executeTask() function that runs a worker agent for a task
 * - Queue draining (drainProjectQueue) to auto-start pending tasks
 * - Task stopping (stopTask, stopAllProjectTasks)
 * - In-flight task tracking (claimed/running state)
 * - Dataset task row spawning
 */
import { randomUUID } from 'crypto';
import {
  notifyEntityLifecycle,
  notifyStageEntryLifecycle,
  notifyUserSystem,
} from '../../tools/push-tools.js';
import { RegisteredGroup, effectiveMaxParallel } from '../../../types.js';
import { escapeRegex } from '../../../utils.js';
import { getGroupDir } from '../../../group-dir.js';
import {
  Task,
  StageDefinition,
  DatasetTask,
  StageEntryEventRef,
  TriggerSource,
  TaskMessage,
} from '../types.js';
import {
  runContainerAgent,
  ContainerInput,
  killAgentProcess,
  persistentVariantTag,
  steerAgentProcess,
  readAgentRunControlResponse,
  clearAgentRunControlResponse,
  interruptAgentTurn,
  STAGE_HANDOFF_TIMEOUT_ABORT_REASON,
} from '../../../mcp/mcp-runner.js';
import {
  loadSystemPrompt,
  loadAgentRules,
  loadReviewPrompt,
  loadTestingPrompt,
  loadStagePrompt,
  loadGroupWorkerPrompt,
  composeWorkerPrompts,
} from '../../../prompt-loader.js';
import {
  getTask,
  updateTask,
  getActiveRunsByStatus,
  getRunningTaskIdsForGroup,
  getActiveRunForTask,
  getActiveRunById,
  completeActiveRun,
  createDatasetRowTask,
  getTasksByProjectForQueue,
  getCurrentDatasetRowTask,
  updateDatasetTask,
  incrementDatasetTaskProgress,
  getLastActiveRunForTask,
  getLastRunForStages,
  getLastRunSessionForStage,
  getLastStageSessionOwner,
  markRestartRecoveryRunDispatched,
  persistTaskSessionForActiveRun,
  getIncompleteActiveDatasetTasks,
  getObjective,
  getObjectiveStatusesByIds,
  getTaskStageComment,
} from '../../../db.js';
import {
  getRunsForTask,
  updateActiveRunReviewScore,
} from '../../../db/active-runs.js';
import {
  claimNextStageEntryEvent,
  claimNormalTaskAdmission,
  bindTaskAdmissionRun,
  type NormalTaskAdmission,
  prepareStageEntryEventIfOwned,
  completeStageEntryEventIfOwned,
  getBlockingStageEntryEvents,
  getUnresolvedStageEntryEvents,
  getProjectsWithUnresolvedStageEntryEvents,
  markStageEntryEventFailed,
  markStageEntryEventRunning,
  resolveStageEntryEvent,
  reconcileStageEntryEventRuns,
  resolveStaleStageEntryEvents,
  releaseStageEntryEventClaim,
  setStageEntryEventCommittedHandler,
  setRecoveryBudgetExhaustedHandler,
  releaseTaskAdmission,
  spawnAbVariantsInDb,
  getAbChildTasks,
} from '../db-kanban.js';
import {
  appendTaskMessage,
  appendRunStartMarker,
  appendRunStartMarkerAsync,
  readTaskMessages,
  readTaskMessagesAsync,
  appendTaskMessageAsync,
  appendTaskMessageDurableAsync,
  flushTaskOutputChunks,
  queueTaskOutputChunk,
} from '../../transcripts/transcript-store.js';
import { broadcast } from '../../objectives/ws-events.js';
import { enforceTaskCostLimit } from './task-cost-limit.js';
import { parkTaskForPrivacyRefusal } from './task-privacy-gate.js';
import {
  assertRuntimeAllowed,
  PrivacyRefusal,
} from '../../../lib/privacy-policy.js';
import { logger } from '../../../logger.js';
import {
  RECOVERY_TRANSITION_KEY,
  readRecoveryTransition,
  recoveryTransitionValue,
} from '../pipeline-owned-values.js';
import {
  getGroupStages,
  getInitialStage,
  getFirstExecutableStage,
  findStage,
  getDoneStage,
  getFailedStage,
  getNextActiveStage,
  getDeployStageId,
  isActiveStage,
  isReviewStage,
  isTestingStage,
  isQuestionStage,
  isFallbackQuestionMove,
  isFailedStage,
  resolveStageForTask,
  hasStageAlternative,
  computeAbForkStage,
  isAbExperimentParent,
  isAbExperimentChild,
  isAbExperimentTask,
} from '../stages.js';
import {
  AGENT_CMD,
  GROUPS_DIR,
  MODEL_ROUTING_ENGINE,
  type ModelRoutingEngine,
} from '../../../config.js';
import path from 'path';
import {
  publishEvent,
  publishEventWithResult,
  resolveBrainUrl,
  resolveBrainContainer,
} from '../../objectives/brain-client.js';
import { taskEventHeaders } from './objective-events.js';
import {
  getBranchNameForTask,
  isLocalRepoMode,
  checkoutTaskBranch,
  validatedInstance,
  runGitInRepo,
  taskUsesBranch,
  taskUsesWorktree,
  removeWorktreeForTask,
  inspectTaskLinkedRepositories,
  commitTaskBranch,
} from '../../../lib/git-ops.js';
import { COMMIT_SHA_PATTERN } from '../../../lib/git-commit.js';
import type { ReReviewContext } from '../review.js';
import {
  appendReviewVerdictFormatBlock,
  parseReviewDecisionWithRepair,
  buildReviewGitContextBlock,
  buildReviewReworkPrompt,
  readReviewHistory,
  shouldStartFreshReviewSession,
  MAX_REVIEW_FORMAT_RETRIES,
} from '../review.js';
import {
  DEPLOY_PENDING_DISPATCH_KEY,
  clearPendingDeployDispatch,
  isHeldByBootDeployDispatch,
  mergeBranchForDeploy,
  triggerDeploy,
} from './deploy.js';
import { handleReviewDecision } from './review.js';
import {
  createReviewRejectionPreparer,
  type AuxiliaryWorkerInput,
  type PrepareReviewRejection,
} from './review-rejection.js';
import {
  REVIEW_CHAIN_KEY,
  REVIEW_CHAIN_RUN_KEY,
  aggregateReviewChain,
  formatReviewChainVerdict,
  isVisibleToExtraReviewer,
  nextReviewChainStage,
  partitionCoReviewStagesByRuntime,
  planReviewChain,
  readReviewChain,
  resolveCoReviewStages,
  summarizeReviewerVerdicts,
  type ReviewChain,
  type ReviewChainOutcome,
  type ReviewChainRunMarker,
  type ReviewChainPlan,
  type ReviewChainVerdict,
} from './review-chain.js';
import {
  TESTING_CHAIN_KEY,
  planTestingChain,
  readTestingChain,
  resolveCoTestingStages,
  type TestingChainPlan,
} from './testing-chain.js';
import {
  ensureReviewHasCurrentTestingEvidence,
  ReviewDeferredError,
  handleTestingBlocked,
  handleTestingDecision,
  persistTestingAssistantResponse,
  recordTestingInspectedIdentity,
  retryTestingAfterGitStateChange,
} from './testing.js';
import {
  buildTestingTransportRecoveryOutput,
  MAX_TESTING_FORMAT_RETRIES,
  parseTestingDecisionWithRepair,
  shouldStartFreshTestingSession,
  stripAllTestingDecisions,
  TestingOutputStreamFilter,
} from '../testing.js';
import {
  isAutoSelection,
  resolveAutoPinnedSelection,
  resolveAutoSelection,
  resolveKanbanRuntimeSelection,
  resolveRuntimeSelection,
  runtimeSessionKey,
} from '../../../lib/chat-agents.js';
import { routeText } from '../../../lib/model-router.js';
import {
  HARNESS_PROVIDER,
  loadProviderUsageAccounts,
} from '../../provider-usage/capacity.js';
import {
  claimOutageNotification,
  getProviderLoginHolds,
  holdProviderForCredentialError,
  releaseOutageNotification,
} from '../../../lib/provider-login-state.js';
import {
  decideStageRouting,
  persistStageRouting,
  readStageRouting,
} from './auto-routing.js';
import {
  acquireSharedCheckoutLease,
  type SharedCheckoutLease,
} from '../../../concurrency/shared-checkout-lease.js';
import { runPostExecutionGitOps } from './git-ops.js';
import {
  effectiveRunSandboxStack,
  effectiveOperationInstance,
  lifecycleSandboxInstance,
  resolveEffectiveSandbox,
} from '../../../sandbox/effective-settings.js';
import { ensureSandboxRunning } from '../../fs/sandbox-fs.js';
import { isTaskLaunchHeld } from '../../../sandbox/idle-restart.js';
import type { stopTaskBackgroundTask } from '../../../sandbox/process.js';
import { createVerdictBackgroundTaskStopper } from './verdict-background-stop.js';
import { isDependencyCommitMissingError } from '../../../sandbox/direct-checkout.js';
import { buildFreshSessionContinuationPrompt } from './fresh-session.js';
import {
  publishEventAndNotify,
  publishTaskEventAndNotify,
} from './objective-event-holds.js';
import {
  appendPersistentStageNote,
  buildAutomaticStageEntryPrompt,
  buildFreshStageHistoryPrompt,
  buildTaskManagementPrompt,
  buildTestingRecordingHandoff,
  buildTestingValidationPrompt,
  composeStageRunPrompts,
  composeStageSpecificPrompt,
  findRunRecording,
  resolveStagePersonaPrompt,
} from './run-prompts.js';
import {
  isTaskCheckoutClean,
  prepareTaskBranchForReview,
  readTaskGitContentIdentity,
  TaskReviewPreparationError,
  type TaskGitContentIdentity,
} from './review-preparation.js';

export {
  appendPersistentStageNote,
  buildAutomaticStageEntryPrompt,
  buildFreshStageHistoryPrompt,
  buildTaskManagementPrompt,
  buildTestingRecordingHandoff,
  buildTestingValidationPrompt,
  composeStageRunPrompts,
  composeStageSpecificPrompt,
  findRunRecording,
  prepareTaskBranchForReview,
  readTaskGitContentIdentity,
  resolveStagePersonaPrompt,
  TaskReviewPreparationError,
};
export type { TaskGitContentIdentity };

export const RESTART_RECOVERY_PROMPT =
  'Continue the task from where you were interrupted. Inspect the current checkout and unfinished work, then complete the remaining requirements.';

/** Internal boot-only intent for one exact interrupted active-stage run. */
export interface RestartRecoveryExecutionIntent {
  interruptedRunId: string;
  /** Durable active_runs outbox row reserved before asynchronous setup. */
  continuationRunId: string;
  stageId: string;
  sessionId: string;
  sessionAgentKey: string;
  model: string | null;
  runtimeVariant: string;
  sandboxStack: string;
  sandboxService: string;
  sandboxInstance: string | null;
}

/**
 * A successful run is complete only when its resulting stage is a done stage.
 * Agent-driven moves keep the persisted status, so infer completion from that
 * stage rather than treating every move (including question/active) as done.
 */
export function shouldStampTaskCompleted(
  agentMovedTask: boolean,
  currentStage: StageDefinition | undefined,
  nextActiveStage: StageDefinition | undefined,
): boolean {
  return agentMovedTask ? currentStage?.type === 'done' : !nextActiveStage;
}

/** Dataset rows advance only when their kanban task has actually finished. */
export function shouldAdvanceDatasetProgress(
  executionFailed: boolean,
  currentStage: StageDefinition | undefined,
): boolean {
  return executionFailed || currentStage?.type === 'done';
}

/**
 * A human action performed after the previous run is an explicit Review
 * override. Automatic Testing -> Review advancement retains the older trigger
 * timestamp from before the Testing run, so it must still satisfy the evidence
 * guard. The persisted timestamps keep this distinction across board restarts.
 */
function isManualReviewRun(
  task: Pick<Task, 'lastTriggerSource' | 'lastTriggeredAt'>,
  lastRun: { started_at: string } | undefined,
): boolean {
  if (task.lastTriggerSource !== 'user' || !task.lastTriggeredAt) return false;
  if (!lastRun) return true;
  const triggeredAt = Date.parse(task.lastTriggeredAt);
  const lastRunStartedAt = Date.parse(lastRun.started_at);
  return (
    Number.isFinite(triggeredAt) &&
    Number.isFinite(lastRunStartedAt) &&
    triggeredAt > lastRunStartedAt
  );
}

// ---------------------------------------------------------------------------
// Group resolver — set from index.ts to avoid circular imports
// ---------------------------------------------------------------------------

let groupResolver:
  | ((project_id: string) => RegisteredGroup | undefined)
  | null = null;

export function setGroupResolver(
  resolver: (project_id: string) => RegisteredGroup | undefined,
): void {
  groupResolver = resolver;
  setStageEntryEventCommittedHandler((event) => {
    const group = groupResolver?.(event.projectId);
    if (!group) return;
    void drainProjectQueue(event.projectId, group).catch((error) => {
      logger.error(
        { project: event.projectId, stageEntryEventId: event.id, error },
        'Failed to admit committed automatic stage-entry event',
      );
    });
  });
  setRecoveryBudgetExhaustedHandler(reportRecoveryBudgetExhausted);
}

async function reportRecoveryBudgetExhausted(exhaustion: {
  taskId: string;
  projectId: string;
  stageId: string;
  runs: number;
}): Promise<void> {
  const task = await getTask(exhaustion.taskId);
  if (!task) return;
  const message = await appendTaskMessageDurableAsync(exhaustion.projectId, {
    task_id: exhaustion.taskId,
    role: 'system',
    content: `Automatic recovery exhausted after ${exhaustion.runs} runs — human decision required`,
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: {
      task_id: exhaustion.taskId,
      project_id: exhaustion.projectId,
      message,
    },
  });
  await notifyEntityLifecycle({
    group_folder: exhaustion.projectId,
    task_id: exhaustion.taskId,
    run_id: `recovery-exhausted:${exhaustion.stageId}:${message.id}`,
    event: 'needs_input',
    title: `Task needs input: ${task.title}`,
  });
}

/** Recover durable entry work and wake failed-only projects for normal drain. */
export async function recoverStageEntryEvents(): Promise<void> {
  await reconcileStageEntryEventRuns();
  await resolveStaleStageEntryEvents();
  const projectIds = await getProjectsWithUnresolvedStageEntryEvents();
  await Promise.all(
    projectIds.map(async (projectId) => {
      const group = groupResolver?.(projectId);
      if (!group) return;
      await drainProjectQueue(projectId, group, {
        recoverStageEntryClaims: true,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// In-flight task tracking
// ---------------------------------------------------------------------------

// Tasks that have been claimed by executeTask (may be waiting for a sandbox slot).
// Automatic drains count only claims that occupy configured automatic capacity.
const claimedTasks = new Map<
  string,
  {
    abort: AbortController;
    project_id: string;
    bypassesAutomaticCapacity?: boolean;
    /** A reset owns its reservation until its destructive operations settle. */
    resetting?: boolean;
    /** A Git fork must settle before its reservation can be released. */
    forking?: boolean;
    /** Admissions already in flight when this claim was created. They must
     * settle before this run snapshots its transcript. */
    messageAdmissionBarrier?: Promise<void>;
    /** This claim is the re-run of a transient-error retry. */
    transientRetry?: boolean;
  }
>();

// Tasks that have acquired a sandbox slot and are actively running.
// Used by the GET /tasks endpoint (via getRunningTaskIds) to set `running: true`.
// Also used for abort support via stopTask.
const runningTasks = new Map<
  string,
  { abort: AbortController; project_id: string; run_id?: string }
>();

interface TaskRunSessionPersistence {
  taskId: string;
  pending: Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
  rejectSettled: (error: unknown) => void;
  closed: boolean;
}

// Session chunks arrive through a synchronous stream callback, while their DB
// writes are asynchronous. Keep the exact run generation reserved until every
// observed session write settles so Stop and queue re-entry cannot pass it.
const taskRunSessionPersistence = new Map<string, TaskRunSessionPersistence>();
const taskSessionPersistenceTails = new Map<string, Promise<void>>();

function beginTaskRunSessionPersistence(
  runId: string,
  taskId: string,
): TaskRunSessionPersistence {
  const existing = taskRunSessionPersistence.get(runId);
  if (existing) return existing;
  let resolveSettled!: () => void;
  let rejectSettled!: (error: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  // Stop is not necessarily waiting on this promise, so mark a future
  // rejection handled while preserving it for explicit awaiters.
  void settled.catch(() => undefined);
  const state = {
    taskId,
    pending: Promise.resolve(),
    settled,
    resolveSettled,
    rejectSettled,
    closed: false,
  };
  taskRunSessionPersistence.set(runId, state);
  return state;
}

function queueTaskRunSessionPersistence(
  runId: string,
  task: Task,
  sessionId: string,
  persist: typeof persistTaskSessionForActiveRun,
): void {
  const state = taskRunSessionPersistence.get(runId);
  if (!state || state.taskId !== task.id || state.closed) return;
  const previous =
    taskSessionPersistenceTails.get(task.id) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      const persisted = await persist(runId, task.id, sessionId);
      if (!persisted) {
        throw new Error(`Active run ${runId} no longer owns task ${task.id}`);
      }
      broadcast({
        type: 'task_updated',
        payload: { task_id: task.id, project_id: task.project_id },
      });
    });
  state.pending = pending;
  taskSessionPersistenceTails.set(task.id, pending);
  void pending
    .catch(() => undefined)
    .finally(() => {
      if (taskSessionPersistenceTails.get(task.id) === pending) {
        taskSessionPersistenceTails.delete(task.id);
      }
    });
}

async function finishTaskRunSessionPersistence(runId: string): Promise<void> {
  const state = taskRunSessionPersistence.get(runId);
  if (!state) return;
  state.closed = true;
  try {
    await state.pending;
    state.resolveSettled();
  } catch (error) {
    state.rejectSettled(error);
    throw error;
  } finally {
    if (taskRunSessionPersistence.get(runId) === state) {
      taskRunSessionPersistence.delete(runId);
    }
  }
}

async function waitForTaskRunSessionPersistence(runId?: string): Promise<void> {
  if (!runId) return;
  await taskRunSessionPersistence.get(runId)?.settled;
}

async function finishTaskRunSessionPersistences(
  runIds: Iterable<string>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...runIds].map((runId) => finishTaskRunSessionPersistence(runId)),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

// Tasks whose Stop lifecycle is still in progress. A stopped execution can
// reach its finally block while stopTask() is waiting for the sandbox process
// to exit. Keep a separate reservation across that gap so the old finally
// cannot drain the still-active card into a new run before backlog is
// persisted and the original active_run is finalized.
const stoppingTasks = new Map<
  string,
  { project_id: string; bypassesAutomaticCapacity?: boolean }
>();

// Claims aborted by stopTask(). Unlike a stage-handoff timeout abort, the stop
// owns the card's status, so the stopped execution must not hold the card in
// its stage for steering or apply a pending stage handoff.
const stoppedTaskClaims = new WeakSet<AbortController>();

/** True when the claim was aborted for any reason except the stage-handoff
 * timeout: that abort only ends a turn whose handoff is already accepted, so
 * it is neither a stop nor a failure. A stop landing after it still counts. */
function isAbortedExecution(abort: AbortController): boolean {
  return (
    abort.signal.aborted &&
    (abort.signal.reason !== STAGE_HANDOFF_TIMEOUT_ABORT_REASON ||
      stoppedTaskClaims.has(abort))
  );
}

// Agent-driven stage moves are execution handoffs: the current stage run must
// finish before the queue can start the newly selected stage. Keep this
// separate from a user stop so the task status is preserved and the run is
// recorded as successful rather than stopped/failed.
const stageHandoffs = new Map<
  string,
  {
    fromStage: string;
    toStage: string;
    requestId?: string;
    requestedRunId?: string;
    ownRunFallbackQuestion?: boolean;
    finalizeEffects?: () => Promise<void>;
  }
>();
const taskExecutionStartingStages = new Map<string, string>();
const taskExecutionFinalizingStages = new Map<string, string>();
const taskSteeringAdmissions = new Map<string, number>();
const taskSteeringLocks = new Map<string, Promise<void>>();
// A claim remains capacity-owning while successful effects and final cleanup
// settle, but stops being presented as running/queued at the same synchronous
// point that admissions close. Requests admitted before this point are awaited
// by finalization; later requests cannot observe an open claim from the API.
const closedTaskSteeringClaims = new Set<string>();
// Linearization point between a finishing claim and new task-chat submissions.
// It is set synchronously with closedTaskSteeringClaims before successful
// transition effects. Every request admitted while the claim was presented is
// already represented in the per-task lock chain and must settle first.
const taskSteeringCompletionCutoffs = new Map<string, string>();
const taskSteeringCompletionRunIds = new Map<string, string>();
const retiredTaskRunPresentations = new Set<string>();

export interface TaskSteeringAdmission {
  startingStage?: string;
  /** True when this submission entered the run's serialized delivery window
   * before completion acquired its cutoff. */
  holdsCompletionBarrier: boolean;
  ready: Promise<void>;
  release: () => void;
}

export interface TaskSteeringAdmissionTarget {
  targetStage: string;
  originatingRunId?: string;
}

export function beginTaskSteeringAdmission(
  taskId: string,
  target?: TaskSteeringAdmissionTarget,
): TaskSteeringAdmission {
  const completionCutoff = taskSteeringCompletionCutoffs.get(taskId);
  const presentedRun = runningTasks.get(taskId);
  const startingStage = taskExecutionStartingStages.get(taskId) ?? undefined;
  const activeRunId = presentedRun?.run_id;
  const targetsPresentedStage =
    !target || (!!startingStage && target.targetStage === startingStage);
  const originatesOutsidePresentedRun =
    !target?.originatingRunId || target.originatingRunId !== activeRunId;
  const holdsCompletionBarrier =
    !completionCutoff && targetsPresentedStage && originatesOutsidePresentedRun;
  if (holdsCompletionBarrier) {
    taskSteeringAdmissions.set(
      taskId,
      (taskSteeringAdmissions.get(taskId) ?? 0) + 1,
    );
  }
  const previous = taskSteeringLocks.get(taskId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => (releaseCurrent = resolve));
  taskSteeringLocks.set(taskId, current);
  const ready = previous.then(() => undefined);
  let released = false;
  return {
    startingStage: holdsCompletionBarrier ? startingStage : undefined,
    holdsCompletionBarrier,
    ready,
    release: () => {
      if (released) return;
      released = true;
      if (holdsCompletionBarrier) {
        const admissions = taskSteeringAdmissions.get(taskId) ?? 0;
        if (admissions <= 1) taskSteeringAdmissions.delete(taskId);
        else taskSteeringAdmissions.set(taskId, admissions - 1);
      }
      void ready.then(() => {
        releaseCurrent();
        if (taskSteeringLocks.get(taskId) === current)
          taskSteeringLocks.delete(taskId);
      });
    },
  };
}

/** Stage the task's claimed execution starts in, while a claim is installed. */
export function getTaskExecutionStartingStage(
  taskId: string,
): string | undefined {
  return taskExecutionStartingStages.get(taskId);
}

/** Whether task-list and websocket consumers should still present this claim. */
export function isTaskExecutionPresented(taskId: string): boolean {
  return !closedTaskSteeringClaims.has(taskId);
}

export function endTaskSteeringAdmission(
  admission: TaskSteeringAdmission,
): void {
  admission.release();
}

const taskCompletionLockReleases = new Map<string, () => void>();
// Claim that installed the task's finalization state (finalizing stage,
// cutoff, closed-claim marker, completion lock). A stop releases the claim
// before its finally block runs, so a newer run can hold the claim while the
// older finally still has to release the state it installed itself.
const taskFinalizationOwners = new Map<string, AbortController>();

function markTaskFinalizing(taskId: string, stage: string): void {
  taskExecutionFinalizingStages.set(taskId, stage);
  markTaskFinalizationOwner(taskId);
}

function markTaskFinalizationOwner(taskId: string): void {
  const owner = claimedTasks.get(taskId)?.abort;
  if (owner) taskFinalizationOwners.set(taskId, owner);
  else taskFinalizationOwners.delete(taskId);
}

/** True when the finalization state was installed by a run other than `abort`
 * that currently holds the task's claim, so `abort`'s run must leave it alone. */
function isFinalizationStateOfNewerRun(
  taskId: string,
  abort: AbortController,
): boolean {
  const claim = claimedTasks.get(taskId);
  return (
    !!claim &&
    claim.abort !== abort &&
    taskFinalizationOwners.get(taskId) === claim.abort
  );
}

export interface SuccessfulTaskFinalizationBoundary {
  taskId: string;
  startingStage: string;
  shouldAdvance: boolean;
  release: () => void;
}

async function acquireTaskSteeringLock(taskId: string): Promise<() => void> {
  const previous = taskSteeringLocks.get(taskId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => (releaseCurrent = resolve));
  taskSteeringLocks.set(taskId, current);
  await previous;
  await Promise.resolve();
  return () => {
    releaseCurrent();
    if (taskSteeringLocks.get(taskId) === current)
      taskSteeringLocks.delete(taskId);
  };
}

async function withTaskSteeringLock<T>(
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireTaskSteeringLock(taskId);
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Linearize one successful task run before any transition-dependent effects.
 *
 * Live execution keeps an allowed boundary open through its finally block;
 * restart recovery opens the same boundary around its complete recovered
 * finalizer. Result/session preservation may follow the decision, but Git,
 * verdicts, stage transitions, completion events, and notifications must stay
 * behind it.
 */
export async function beginSuccessfulTaskFinalization(
  task: Task,
  startingStage: string,
  successfulRunId?: string,
  onPresentationRetired?: () => void,
): Promise<SuccessfulTaskFinalizationBoundary> {
  taskExecutionFinalizingStages.set(task.id, startingStage);
  if (successfulRunId) {
    taskSteeringCompletionRunIds.set(task.id, successfulRunId);
  }
  const releaseLock = await acquireTaskSteeringLock(task.id);
  // Record ownership only once the lock is held: a run still queued behind an
  // older run's lock must not be mistaken for that lock's owner.
  markTaskFinalizationOwner(task.id);
  // This is the single completion/admission linearization point. Admissions
  // already queued on the lock have settled; later requests cannot observe the
  // claim as running and therefore cannot overlap transition-dependent effects.
  taskSteeringCompletionCutoffs.set(task.id, startingStage);
  closedTaskSteeringClaims.add(task.id);
  const presentedRun = runningTasks.get(task.id);
  if (presentedRun?.run_id) {
    retireOwnedTaskExecutionPresentation(
      task.id,
      presentedRun.project_id,
      presentedRun.abort,
      presentedRun.run_id,
    );
  }
  onPresentationRetired?.();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLock();
  };
  try {
    await reconcileTaskSteeringReceipts(task, successfulRunId);
    const pending = hasPendingTaskSteering(
      task,
      startingStage,
      successfulRunId,
    );
    if (pending) {
      await updateTask(task.id, { status: startingStage, completed_at: null });
      release();
      return {
        taskId: task.id,
        startingStage,
        shouldAdvance: false,
        release,
      };
    }
    return {
      taskId: task.id,
      startingStage,
      shouldAdvance: true,
      release,
    };
  } catch (error) {
    taskSteeringCompletionCutoffs.delete(task.id);
    taskSteeringCompletionRunIds.delete(task.id);
    taskExecutionFinalizingStages.delete(task.id);
    taskFinalizationOwners.delete(task.id);
    closedTaskSteeringClaims.delete(task.id);
    release();
    throw error;
  }
}

/** Close a successful finalization boundary after every owned effect settles. */
export function endSuccessfulTaskFinalization(
  boundary: SuccessfulTaskFinalizationBoundary,
): void {
  if (
    taskSteeringCompletionCutoffs.get(boundary.taskId) ===
    boundary.startingStage
  ) {
    taskSteeringCompletionCutoffs.delete(boundary.taskId);
  }
  if (
    taskExecutionFinalizingStages.get(boundary.taskId) ===
    boundary.startingStage
  ) {
    taskExecutionFinalizingStages.delete(boundary.taskId);
    taskFinalizationOwners.delete(boundary.taskId);
  }
  closedTaskSteeringClaims.delete(boundary.taskId);
  taskSteeringCompletionRunIds.delete(boundary.taskId);
  boundary.release();
}

/**
 * Close claim presentation and wait for every request admitted while it was
 * visible. Successful runs are then held in their durable starting stage when
 * any prompt remains; failed/stopped runs only wait for persistence and retain
 * their terminal/manual-recovery status.
 */
export async function closeTaskSteeringAdmissionWindow(
  task: Task,
  startingStage: string,
  successful: boolean,
  boundaryRelease?: () => void,
  completingRunId?: string,
): Promise<boolean> {
  taskSteeringCompletionCutoffs.set(task.id, startingStage);
  closedTaskSteeringClaims.add(task.id);
  markTaskFinalizationOwner(task.id);

  const heldRelease = taskCompletionLockReleases.get(task.id);
  if (heldRelease) {
    taskCompletionLockReleases.delete(task.id);
    heldRelease();
  } else {
    boundaryRelease?.();
  }

  return withTaskSteeringLock(task.id, async () => {
    await reconcileTaskSteeringReceipts(task);
    const pending = hasPendingTaskSteering(
      task,
      startingStage,
      completingRunId,
    );
    if (successful && pending) {
      await updateTask(task.id, { status: startingStage, completed_at: null });
    }
    return pending;
  });
}

export interface TaskSteeringResult {
  message: TaskMessage;
  accepted: boolean;
  receipt?: TaskMessage;
  /** The request arrived while the prior claim was still visible, but that
   * claim finished before the serialized append ran. The route must wake the
   * queue after restoring the originating stage. */
  continuationDrainRequired?: boolean;
}

interface TaskPromptDeliveryOptions {
  targetStage?: string;
  originatingRunId?: string;
  worktreeIntegration?: boolean;
}

/** Append one canonical prompt and reconcile its delivery with the active run. */
async function appendTaskPromptForDelivery(
  projectId: string,
  taskId: string,
  content: string,
  beforeAppend?: () => Promise<void>,
  ownedAdmission?: TaskSteeringAdmission,
  options: TaskPromptDeliveryOptions = {},
): Promise<TaskSteeringResult> {
  const admission =
    ownedAdmission ??
    beginTaskSteeringAdmission(
      taskId,
      options.targetStage
        ? {
            targetStage: options.targetStage,
            originatingRunId: options.originatingRunId,
          }
        : undefined,
    );
  const submittedDuringClaim =
    admission.holdsCompletionBarrier && claimedTasks.has(taskId);
  try {
    await admission.ready;
    await beforeAppend?.();
    const activeRunBefore = await getActiveRunForTask(taskId);
    const latestRunBefore = await getLastActiveRunForTask(taskId);
    const currentTaskBefore = await getTask(taskId);
    const promptStage =
      admission.startingStage ??
      taskExecutionStartingStages.get(taskId) ??
      activeRunBefore?.stage ??
      latestRunBefore?.stage ??
      currentTaskBefore?.status;
    const message = await appendTaskMessageDurableAsync(
      projectId,
      options.targetStage
        ? {
            task_id: taskId,
            role: 'system',
            content,
            entry_type: 'stage_prompt',
            target_stage: options.targetStage,
            ...(options.originatingRunId
              ? { run_id: options.originatingRunId }
              : {}),
            created_at: new Date().toISOString(),
          }
        : {
            task_id: taskId,
            role: 'user',
            content,
            steering: true,
            ...(promptStage && !options.worktreeIntegration
              ? { target_stage: promptStage }
              : {}),
            created_at: new Date().toISOString(),
          },
    );
    const activeRun = await getActiveRunForTask(taskId);
    const currentTask = await getTask(taskId);
    const startingStage =
      admission.startingStage ??
      taskExecutionStartingStages.get(taskId) ??
      activeRun?.stage ??
      latestRunBefore?.stage ??
      message.target_stage ??
      undefined;
    const runStillOwnsStage =
      !startingStage || currentTask?.status === startingStage;
    const targetsActiveRun =
      !options.targetStage || options.targetStage === activeRun?.stage;
    const originatesOutsideActiveRun =
      !options.originatingRunId || options.originatingRunId !== activeRun?.id;
    const maySteer =
      activeRun?.status === 'running' &&
      (!options.worktreeIntegration ||
        (currentTask?.status === 'in_progress' &&
          activeRun.stage === 'in_progress')) &&
      !taskExecutionFinalizingStages.has(taskId) &&
      runStillOwnsStage &&
      targetsActiveRun &&
      originatesOutsideActiveRun;
    if (maySteer) {
      await appendSteeringRequest(projectId, taskId, message.id, activeRun.id);
    }
    const accepted = maySteer
      ? await steerAgentProcess(taskId, content, message.id, activeRun.id)
      : false;
    if (!accepted || !activeRun) {
      const stages = getGroupStages(groupResolver?.(projectId));
      const statusCanBeSuccessfulFinalization =
        !!currentTask &&
        currentTask.status !== getInitialStage(stages)?.id &&
        !isFailedStage(stages, currentTask.status);
      if (
        !options.worktreeIntegration &&
        admission.holdsCompletionBarrier &&
        (taskExecutionFinalizingStages.has(taskId) ||
          stageHandoffs.has(taskId) ||
          (activeRun?.status === 'running' &&
            statusCanBeSuccessfulFinalization)) &&
        !claimedTasks.get(taskId)?.abort.signal.aborted &&
        startingStage &&
        currentTask &&
        currentTask.status !== startingStage
      ) {
        await updateTask(taskId, {
          status: startingStage,
          completed_at: null,
        });
      }
      return {
        message,
        accepted: false,
        ...(submittedDuringClaim && !claimedTasks.has(taskId)
          ? { continuationDrainRequired: true }
          : {}),
      };
    }
    const receipt = await appendSteeringReceipt(
      projectId,
      taskId,
      message.id,
      activeRun.id,
    );
    await clearAgentRunControlResponse(activeRun.id, message.id).catch(
      (error) =>
        logger.warn(
          {
            task_id: taskId,
            run_id: activeRun.id,
            prompt_id: message.id,
            error: String(error),
          },
          'Failed to clear acknowledged task steering response',
        ),
    );
    return { message, accepted: true, receipt };
  } finally {
    if (!ownedAdmission) endTaskSteeringAdmission(admission);
  }
}

/** Append a canonical user follow-up and attempt delivery to its active run. */
export async function appendTaskSteeringMessage(
  projectId: string,
  taskId: string,
  content: string,
  beforeAppend?: () => Promise<void>,
  ownedAdmission?: TaskSteeringAdmission,
): Promise<TaskSteeringResult> {
  return appendTaskPromptForDelivery(
    projectId,
    taskId,
    content,
    beforeAppend,
    ownedAdmission,
  );
}

/** Integration handoffs remain actionable in whichever stage executes next. */
export async function appendTaskIntegrationMessage(
  projectId: string,
  taskId: string,
  content: string,
  admission: TaskSteeringAdmission,
): Promise<TaskSteeringResult> {
  return appendTaskPromptForDelivery(
    projectId,
    taskId,
    content,
    undefined,
    admission,
    { worktreeIntegration: true },
  );
}

/** Append one stage-addressed tool prompt through the shared delivery stream. */
export async function appendTaskStagePrompt(
  projectId: string,
  taskId: string,
  content: string,
  targetStage: string,
  originatingRunId?: string,
  ownedAdmission?: TaskSteeringAdmission,
): Promise<TaskSteeringResult> {
  return appendTaskPromptForDelivery(
    projectId,
    taskId,
    content,
    undefined,
    ownedAdmission,
    { targetStage, originatingRunId },
  );
}

/** Completion barrier: hold the starting stage when unconsumed steering exists. */
function hasPendingTaskSteering(
  task: Task,
  startingStage: string,
  completingRunId?: string,
): boolean {
  if ((taskSteeringAdmissions.get(task.id) ?? 0) > 0) return true;
  const messages = readTaskMessages(task.project_id, task.id);
  return (
    getPendingTaskDeliveryPrompts(
      messages,
      startingStage,
      completingRunId ??
        taskSteeringCompletionRunIds.get(task.id) ??
        runningTasks.get(task.id)?.run_id,
    ).length > 0
  );
}

type SteeringMarkerEntryType = 'steering_request' | 'steering_assignment';

async function appendSteeringMarker(
  projectId: string,
  taskId: string,
  promptId: string,
  runId: string,
  entryType: SteeringMarkerEntryType,
): Promise<TaskMessage> {
  const existing = readTaskMessages(projectId, taskId).find(
    (message) =>
      message.entry_type === entryType &&
      message.prompt_id === promptId &&
      message.run_id === runId,
  );
  if (existing) return existing;
  return appendTaskMessageDurableAsync(projectId, {
    task_id: taskId,
    role: 'system',
    entry_type: entryType,
    prompt_id: promptId,
    run_id: runId,
    content: '',
    created_at: new Date().toISOString(),
  });
}

async function appendSteeringRequest(
  projectId: string,
  taskId: string,
  promptId: string,
  runId: string,
): Promise<TaskMessage> {
  return appendSteeringMarker(
    projectId,
    taskId,
    promptId,
    runId,
    'steering_request',
  );
}

async function appendSteeringAssignment(
  projectId: string,
  taskId: string,
  promptId: string,
  runId: string,
): Promise<TaskMessage> {
  return appendSteeringMarker(
    projectId,
    taskId,
    promptId,
    runId,
    'steering_assignment',
  );
}

async function appendSteeringReceipt(
  projectId: string,
  taskId: string,
  promptId: string,
  runId: string,
): Promise<TaskMessage> {
  const data = {
    task_id: taskId,
    role: 'system' as const,
    entry_type: 'steering_delivery' as const,
    prompt_id: promptId,
    run_id: runId,
    content: '',
    created_at: new Date().toISOString(),
  };
  try {
    return await appendTaskMessageDurableAsync(projectId, data);
  } catch (error) {
    const existing = readTaskMessages(projectId, taskId).find(
      (message) =>
        message.entry_type === 'steering_delivery' &&
        message.prompt_id === promptId &&
        message.run_id === runId,
    );
    if (existing) return existing;
    throw error;
  }
}

/**
 * Convert retained positive generic-control responses and successfully
 * completed launch assignments into transcript receipts. Control responses
 * remain on disk until their receipt append succeeds; recovery supplies the
 * successful run ID while its active_runs row still says running.
 */
export async function reconcileTaskSteeringReceipts(
  task: Task,
  successfulRunId?: string,
): Promise<void> {
  const messages = readTaskMessages(task.project_id, task.id);
  const delivered = new Set(
    messages
      .filter((message) => message.entry_type === 'steering_delivery')
      .map((message) => message.prompt_id)
      .filter((id): id is string => !!id),
  );
  const requests = messages.filter(
    (message) =>
      (message.entry_type === 'steering_request' ||
        message.entry_type === 'steering_assignment') &&
      !!message.prompt_id &&
      !!message.run_id &&
      !delivered.has(message.prompt_id),
  );
  for (const request of requests) {
    if (delivered.has(request.prompt_id!)) continue;
    const assignedRun =
      request.entry_type === 'steering_assignment'
        ? await getActiveRunById(request.run_id!)
        : undefined;
    const accepted =
      request.entry_type === 'steering_assignment'
        ? request.run_id === successfulRunId ||
          assignedRun?.status === 'completed'
        : await readAgentRunControlResponse(
            request.run_id!,
            request.prompt_id!,
          );
    if (accepted !== true) continue;
    const receipt = await appendSteeringReceipt(
      task.project_id,
      task.id,
      request.prompt_id!,
      request.run_id!,
    );
    delivered.add(request.prompt_id!);
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: receipt,
      },
    });
    if (request.entry_type === 'steering_request') {
      await clearAgentRunControlResponse(
        request.run_id!,
        request.prompt_id!,
      ).catch((error) =>
        logger.warn(
          {
            task_id: task.id,
            run_id: request.run_id,
            prompt_id: request.prompt_id,
            error: String(error),
          },
          'Failed to clear reconciled task steering response',
        ),
      );
    }
  }
}

async function runCompletionOperation(
  task: Task,
  startingStage: string,
  operation: () => Promise<void>,
): Promise<boolean> {
  const heldRelease = taskCompletionLockReleases.get(task.id);
  if (heldRelease) {
    if (hasPendingTaskSteering(task, startingStage)) {
      await updateTask(task.id, { status: startingStage, completed_at: null });
      return false;
    }
    await operation();
    return true;
  }
  const boundary = await beginSuccessfulTaskFinalization(task, startingStage);
  if (!boundary.shouldAdvance) return false;
  taskCompletionLockReleases.set(task.id, boundary.release);
  try {
    await operation();
    return true;
  } catch (error) {
    taskCompletionLockReleases.delete(task.id);
    boundary.release();
    throw error;
  }
}

export async function holdTaskForPendingSteering(
  task: Task,
  startingStage: string,
  completingRunId?: string,
): Promise<boolean> {
  return withTaskSteeringLock(task.id, async () => {
    await reconcileTaskSteeringReceipts(task);
    if (!hasPendingTaskSteering(task, startingStage, completingRunId))
      return false;
    await updateTask(task.id, { status: startingStage, completed_at: null });
    return true;
  });
}

/** Remove this run's recovery_transition marker; another run's is left alone. */
export async function clearRecoveryTransition(
  taskId: string,
  runId: string,
): Promise<void> {
  const stored = await getTask(taskId);
  if (!stored || !readRecoveryTransition(stored, runId)) return;
  await updateTask(
    taskId,
    {},
    { omitCustomValueKeys: [RECOVERY_TRANSITION_KEY] },
  );
}

export async function updateTaskWithSteeringBarrier(
  task: Task,
  startingStage: string,
  changes: Parameters<typeof updateTask>[1],
  stageEntryEventRef?: StageEntryEventRef,
  updateOptions?: Parameters<typeof updateTask>[2],
): Promise<boolean> {
  return runCompletionOperation(task, startingStage, async () => {
    const entryEvent = await updateTask(task.id, changes, updateOptions);
    if (stageEntryEventRef) stageEntryEventRef.id = entryEvent?.id;
  });
}

export async function runWithTaskSteeringBarrier(
  task: Task,
  startingStage: string,
  operation: () => Promise<void>,
): Promise<boolean> {
  return runCompletionOperation(task, startingStage, operation);
}

export interface DurableTaskStageHandoff {
  requestId: string;
  fromStage: string;
  toStage: string;
  requestedRunId?: string;
  /** The card's own run requested a move into the needs-input fallback stage
   * of a project without a Question stage; finalization publishes task_question. */
  ownRunFallbackQuestion?: boolean;
  finalizeEffects?: () => Promise<void>;
}

/** Resolve the newest unconsumed handoff from a successful run in this
 * executable stage. Multiple requests from one turn retain append-only
 * history; the newest successful request is authoritative. */
export async function getPendingTaskStageHandoff(
  task: Pick<Task, 'id' | 'project_id'>,
  startingStage: string,
): Promise<DurableTaskStageHandoff | undefined> {
  const messages = readTaskMessages(task.project_id, task.id);
  const delivered = new Set(
    messages
      .filter((message) => message.entry_type === 'stage_handoff_delivery')
      .map((message) => message.prompt_id)
      .filter((id): id is string => !!id),
  );
  const requests = messages
    .filter(
      (message) =>
        message.entry_type === 'stage_handoff_request' &&
        message.source_stage === startingStage &&
        !!message.run_id &&
        !!message.target_stage &&
        !delivered.has(message.id),
    )
    .reverse();
  let request: TaskMessage | undefined;
  for (const candidate of requests) {
    const originatingRun = await getActiveRunById(candidate.run_id!);
    if (originatingRun?.status === 'completed') {
      request = candidate;
      break;
    }
  }
  return request?.target_stage
    ? {
        requestId: request.id,
        fromStage: startingStage,
        toStage: request.target_stage,
        requestedRunId: request.run_id ?? undefined,
        ownRunFallbackQuestion: request.own_run_fallback_question,
      }
    : undefined;
}

async function appendTaskStageHandoffRequest(
  task: Pick<Task, 'id' | 'project_id'>,
  fromStage: string,
  toStage: string,
  runId: string,
  ownRunFallbackQuestion?: boolean,
): Promise<TaskMessage> {
  // Reuse only the newest request of this run and stage: the newest persisted
  // request is authoritative at finalization, so an earlier identical request
  // behind an intervening destination must not absorb a later one.
  const newest = readTaskMessages(task.project_id, task.id)
    .filter(
      (message) =>
        message.entry_type === 'stage_handoff_request' &&
        message.run_id === runId &&
        message.source_stage === fromStage,
    )
    .at(-1);
  if (
    newest?.target_stage === toStage &&
    !!newest.own_run_fallback_question === !!ownRunFallbackQuestion
  )
    return newest;
  return appendTaskMessageDurableAsync(task.project_id, {
    task_id: task.id,
    role: 'system',
    content: '',
    entry_type: 'stage_handoff_request',
    source_stage: fromStage,
    target_stage: toStage,
    run_id: runId,
    ...(ownRunFallbackQuestion ? { own_run_fallback_question: true } : {}),
    created_at: new Date().toISOString(),
  });
}

export async function appendTaskStageHandoffDelivery(
  task: Pick<Task, 'id' | 'project_id'>,
  handoff: DurableTaskStageHandoff,
  runId: string,
): Promise<void> {
  const messages = readTaskMessages(task.project_id, task.id);
  const delivered = new Set(
    messages
      .filter((message) => message.entry_type === 'stage_handoff_delivery')
      .map((message) => message.prompt_id)
      .filter((id): id is string => !!id),
  );
  const pendingRequestIds = messages
    .filter(
      (message) =>
        message.entry_type === 'stage_handoff_request' &&
        message.source_stage === handoff.fromStage &&
        !delivered.has(message.id),
    )
    .map((message) => message.id);
  for (const requestId of pendingRequestIds) {
    await appendTaskMessageDurableAsync(task.project_id, {
      task_id: task.id,
      role: 'system',
      content: '',
      entry_type: 'stage_handoff_delivery',
      prompt_id: requestId,
      source_stage: handoff.fromStage,
      target_stage: handoff.toStage,
      run_id: runId,
      created_at: new Date().toISOString(),
    });
  }
}

/**
 * Per-attempt run id for pre-launch failures that occurred before an active run
 * started, so each failure gets its own notification deduplication key.
 */
function nextPreflightFailureRunId(taskId: string): string {
  return `preflight:${taskId}:${Date.now()}:${randomUUID()}`;
}

/** Publish a failed execution's brain event and notify, holding while an objective handles it. */
function publishExecutionFailure(
  failedTask: Task,
  group: RegisteredGroup,
  error: string,
  runId: string,
  stageEntryEventId: string | undefined,
): Promise<unknown> {
  return publishEventAndNotify(
    failedTask,
    'task_failed',
    (timestamp) =>
      publishEventWithResult(
        resolveBrainUrl(resolveBrainContainer(group)),
        {
          type: 'task_failed',
          project_id: failedTask.project_id,
          task_id: failedTask.id,
          objective_id: failedTask.objective_id ?? null,
          timestamp,
          data: { ...taskEventHeaders(failedTask, group), error },
        },
        group,
      ),
    {
      group_folder: failedTask.project_id,
      task_id: failedTask.id,
      run_id: runId,
      event: 'failed',
      title: `Task failed: ${failedTask.title}`,
      defer_stage_entry: true,
      stage_entry_event_id: stageEntryEventId,
    },
  );
}

/** Apply the externally visible effects of an agent-requested stage move. */
export async function finalizeTaskStageHandoff(
  task: Pick<Task, 'id' | 'project_id'>,
  handoff: DurableTaskStageHandoff,
  runId: string,
  stageEntryEventId?: string,
): Promise<void> {
  const updated = await getTask(task.id);
  if (!updated) return;
  broadcast({ type: 'task_updated', payload: updated });
  const group = groupResolver?.(updated.project_id);
  const stages = group ? getGroupStages(group) : [];
  if (
    group &&
    (isQuestionStage(stages, handoff.toStage) ||
      (handoff.ownRunFallbackQuestion &&
        isFallbackQuestionMove(stages, handoff.fromStage, handoff.toStage)))
  ) {
    await publishTaskEventAndNotify(
      updated,
      group,
      { type: 'task_question', source: 'agent_update' },
      {
        group_folder: updated.project_id,
        task_id: updated.id,
        run_id: handoff.requestedRunId ?? runId,
        event: 'needs_input',
        title: `Task needs input: ${updated.title}`,
        defer_stage_entry: true,
        stage_entry_event_id: stageEntryEventId,
      },
    );
  }
  if (group && isFailedStage(getGroupStages(group), handoff.toStage)) {
    await publishTaskEventAndNotify(
      updated,
      group,
      { type: 'task_failed', source: 'agent_update' },
      {
        group_folder: updated.project_id,
        task_id: updated.id,
        run_id: handoff.requestedRunId ?? runId,
        event: 'failed',
        title: `Task failed: ${updated.title}`,
        defer_stage_entry: true,
        stage_entry_event_id: stageEntryEventId,
      },
    );
  }
  await appendTaskStageHandoffDelivery(updated, handoff, runId);
}

export interface StageHandoffDependencies {
  steerAgentProcess: typeof steerAgentProcess;
  interruptAgentTurn: typeof interruptAgentTurn;
  killAgentProcess: typeof killAgentProcess;
  schedule: typeof setTimeout;
  isCurrentClaim?: (task_id: string, abort: AbortController) => boolean;
  isHandoffActive?: (task_id: string) => boolean;
}

const defaultStageHandoffDependencies: StageHandoffDependencies = {
  steerAgentProcess,
  interruptAgentTurn,
  killAgentProcess,
  schedule: setTimeout,
};

export async function steerStageHandoff(
  task_id: string,
  steer: typeof steerAgentProcess,
  message = 'Stage transition accepted. Finish the current turn now. Do not perform additional work or call more tools. Provide only a concise handoff summary for the next stage.',
): Promise<boolean> {
  return steer(task_id, message);
}

/**
 * Gracefully end the currently claimed execution after its update_task call
 * has returned to the agent. The executor's finally block releases the claim
 * and drains the queue, which starts another run when `toStage` is executable.
 */
export function requestTaskStageHandoff(
  task_id: string,
  fromStage: string,
  toStage: string,
  dependencies: StageHandoffDependencies = defaultStageHandoffDependencies,
  finalizeEffects?: () => Promise<void>,
): boolean {
  const claimed = claimedTasks.get(task_id);
  if (!claimed || fromStage === toStage) return false;

  stageHandoffs.set(task_id, { fromStage, toStage, finalizeEffects });
  scheduleStageHandoffControl(task_id, claimed.abort, dependencies);
  return true;
}

/** Persist an agent handoff before returning from update_task, then activate
 * the existing graceful turn-stop path. */
export async function requestDurableTaskStageHandoff(
  task: Pick<Task, 'id' | 'project_id'>,
  fromStage: string,
  toStage: string,
  runId: string,
  dependencies: StageHandoffDependencies = defaultStageHandoffDependencies,
  steerMessage?: string,
  ownRunFallbackQuestion?: boolean,
): Promise<boolean> {
  const claimed = claimedTasks.get(task.id);
  if (!claimed || fromStage === toStage) return false;
  const request = await appendTaskStageHandoffRequest(
    task,
    fromStage,
    toStage,
    runId,
    ownRunFallbackQuestion,
  );
  if (claimedTasks.get(task.id)?.abort !== claimed.abort) {
    await appendTaskStageHandoffDelivery(
      task,
      {
        requestId: request.id,
        fromStage,
        toStage,
        requestedRunId: runId,
      },
      runId,
    );
    return false;
  }
  stageHandoffs.set(task.id, {
    fromStage,
    toStage,
    requestId: request.id,
    requestedRunId: runId,
    ownRunFallbackQuestion,
  });
  scheduleStageHandoffControl(
    task.id,
    claimed.abort,
    dependencies,
    steerMessage,
  );
  return true;
}

export function scheduleStageHandoffControl(
  task_id: string,
  abort: AbortController,
  dependencies: StageHandoffDependencies,
  steerMessage?: string,
): void {
  dependencies.schedule(async () => {
    try {
      if (
        !(
          dependencies.isCurrentClaim?.(task_id, abort) ??
          claimedTasks.get(task_id)?.abort === abort
        )
      )
        return;
      const steered = await steerStageHandoff(
        task_id,
        dependencies.steerAgentProcess,
        steerMessage,
      );
      if (!steered) {
        logger.info(
          { task_id },
          'Stage handoff steer was not accepted; waiting for turn completion',
        );
      }
      dependencies.schedule(async () => {
        if (
          (dependencies.isHandoffActive?.(task_id) ??
            stageHandoffs.has(task_id)) &&
          (dependencies.isCurrentClaim?.(task_id, abort) ??
            claimedTasks.get(task_id)?.abort === abort)
        ) {
          const interrupted = await dependencies.interruptAgentTurn(task_id);
          if (!interrupted) {
            abort.abort(STAGE_HANDOFF_TIMEOUT_ABORT_REASON);
            await dependencies.killAgentProcess(task_id, { cleanStop: true });
          }
        }
      }, 30_000);
    } catch (err) {
      logger.warn(
        { task_id, error: String(err) },
        'Failed to steer agent after stage handoff',
      );
    }
  }, 0);
}

export async function clearSessionBeforeFreshRun(
  task_id: string,
  shouldClear: boolean,
  persistSession: typeof updateTask = updateTask,
): Promise<void> {
  if (shouldClear) await persistSession(task_id, { session_id: '' });
}

export async function interceptAutoDeployExecution(
  task: Task,
  group: RegisteredGroup,
  targetStatus: string,
  stages: StageDefinition[],
  deploy: typeof triggerDeploy = triggerDeploy,
): Promise<boolean> {
  if (
    targetStatus !== getDeployStageId(group.settings, stages) ||
    !group.settings?.deployService
  ) {
    return false;
  }

  const executableStageIds = stages
    .filter(
      (stage) =>
        !stage.inactive &&
        (stage.type === 'active' ||
          stage.type === 'testing' ||
          stage.type === 'review'),
    )
    .map((stage) => stage.id);
  const previousRun = await getLastRunForStages(task.id, executableStageIds);
  const continuationStage =
    taskExecutionStartingStages.get(task.id) ??
    previousRun?.stage ??
    task.status;
  await runWithTaskSteeringBarrier(task, continuationStage, async () => {
    await deploy(task, group);
  });
  return true;
}

// Track consecutive failures per project for queue resilience
const projectConsecutiveFailures = new Map<
  string,
  { count: number; blockedAt?: number }
>();
// One pending wake-up per blocked project: drains are event-driven, so without
// this the queue would stay idle after the cooldown until an unrelated event.
const failureCooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 10 * 60_000; // 10 minutes — auto-reset after this period
const RETRYABLE_DELAY_MS = 2 * 60_000; // 2 minutes — delay before retrying a transient error
const RETRYABLE_MAX_DELAY_MS = 16 * 60_000; // backoff ceiling (2, 4, 8, 16 min)
/** Total runs (first run + retries) a task gets before a transient error fails it. */
export const MAX_TRANSIENT_ATTEMPTS = 5;
/** Task `custom_values` key counting consecutive transient-error runs. */
export const TRANSIENT_RETRIES_KEY = 'transient_retries';

// Tasks waiting for a transient-error retry — prevents drainProjectQueue from
// re-picking them before the delay elapses.
const retryPendingTasks = new Set<string>();

// A transient retry keeps one project slot reserved during its backoff. Without
// this, the execution's finally block would immediately drain another task into
// the released slot, making the retry wait behind unrelated work. The task is
// also prioritized once its delay elapses.
const retryReservedTasks = new Map<string, string>();
const retryPriorityTasks = new Set<string>();
const retryTimers = new Map<
  string,
  { timer?: ReturnType<typeof setTimeout>; generation: number }
>();
let nextRetryTimerGeneration = 0;

function clearTransientRetryTimer(task_id: string): void {
  const scheduled = retryTimers.get(task_id);
  if (!scheduled) return;
  retryTimers.delete(task_id);
  if (scheduled.timer !== undefined) {
    clearTimeout(scheduled.timer);
  }
}

export function scheduleTransientTaskRetry(
  task_id: string,
  project_id: string,
  group: RegisteredGroup,
  queueDrain: typeof drainProjectQueue = drainProjectQueue,
  retryDelayMs: number | null = RETRYABLE_DELAY_MS,
): void {
  clearTransientRetryTimer(task_id);
  retryPendingTasks.add(task_id);
  if (retryDelayMs === null) {
    retryReservedTasks.delete(task_id);
    return;
  }

  const generation = ++nextRetryTimerGeneration;
  const entry: { timer?: ReturnType<typeof setTimeout>; generation: number } = {
    generation,
  };
  retryTimers.set(task_id, entry);
  retryReservedTasks.set(task_id, project_id);

  let retryTimer: ReturnType<typeof setTimeout>;
  try {
    retryTimer = setTimeout(() => {
      if (retryTimers.get(task_id)?.generation !== generation) return;
      retryTimers.delete(task_id);
      retryPendingTasks.delete(task_id);
      retryReservedTasks.delete(task_id);
      retryPriorityTasks.add(task_id);
      queueDrain(project_id, group).catch((drainErr) => {
        logger.error(
          { task_id, error: String(drainErr) },
          'Unhandled queue drain after transient retry delay',
        );
      });
    }, retryDelayMs);
  } catch (err) {
    if (retryTimers.get(task_id)?.generation === generation) {
      retryTimers.delete(task_id);
      retryPendingTasks.delete(task_id);
      retryReservedTasks.delete(task_id);
    }
    throw err;
  }
  entry.timer = retryTimer;
  retryTimer.unref?.();
}

/**
 * Drop the backoff state of reserved retries whose card can no longer run:
 * deleted, archived or moved out of an executable stage. A reservation
 * otherwise keeps holding a project slot until its timer fires (up to 16 min).
 */
async function releaseIneligibleRetryReservations(
  project_id: string,
  stages: StageDefinition[],
): Promise<void> {
  for (const [taskId, reservedProjectId] of [...retryReservedTasks]) {
    if (reservedProjectId !== project_id) continue;
    const scheduledGeneration = retryTimers.get(taskId)?.generation;
    const task = await getTask(taskId);
    if (
      task &&
      task.project_id === project_id &&
      !task.archived &&
      isActiveStage(stages, task.status)
    ) {
      continue;
    }
    // A live timer with a different generation means a newer retry replaced
    // this one while awaiting; an absent entry means it expired or was claimed,
    // so only the leftover priority/pending state needs cleaning.
    const currentGeneration = retryTimers.get(taskId)?.generation;
    if (
      currentGeneration !== undefined &&
      currentGeneration !== scheduledGeneration
    ) {
      continue;
    }
    clearTransientRetryTimer(taskId);
    retryPendingTasks.delete(taskId);
    retryReservedTasks.delete(taskId);
    retryPriorityTasks.delete(taskId);
  }
}

export interface TransientRetryPlan {
  attempts: number;
  exhausted: boolean;
  delayMs: number;
  /** `custom_values` to persist: counter incremented, or removed once exhausted. */
  customValues: Record<string, string | number>;
}

/**
 * Count one more transient-error run for the task (persisted in
 * `custom_values` so it survives restarts) and decide whether to retry.
 */
export async function planTransientRetry(
  task: Task,
): Promise<TransientRetryPlan> {
  const latest = (await getTask(task.id)) ?? task;
  const customValues: Record<string, string | number> = {
    ...(latest.custom_values ?? {}),
  };
  const previous = Number(customValues[TRANSIENT_RETRIES_KEY]);
  const attempts =
    (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
  const exhausted = attempts >= MAX_TRANSIENT_ATTEMPTS;
  if (exhausted) {
    // A manual re-run after the failure starts with a fresh budget.
    delete customValues[TRANSIENT_RETRIES_KEY];
  } else {
    customValues[TRANSIENT_RETRIES_KEY] = attempts;
  }
  return {
    attempts,
    exhausted,
    delayMs: Math.min(
      RETRYABLE_DELAY_MS * 2 ** (attempts - 1),
      RETRYABLE_MAX_DELAY_MS,
    ),
    customValues,
  };
}

/** Drop the persisted transient retry counter, if the task has one. */
async function resetTransientRetries(task_id: string): Promise<void> {
  const current = await getTask(task_id);
  if (current?.custom_values?.[TRANSIENT_RETRIES_KEY] === undefined) return;
  const { [TRANSIENT_RETRIES_KEY]: _cleared, ...remaining } =
    current.custom_values;
  await updateTask(task_id, { custom_values: remaining });
}

export function _testOnlyCanAutoStartTaskForObjectives(
  task: Pick<Task, 'id' | 'objective_id'>,
  objectiveStatuses: Map<string, string>,
  allowInactiveObjectiveTaskId?: string,
): boolean {
  if (!task.objective_id) return true;
  if (task.id === allowInactiveObjectiveTaskId) return true;
  return objectiveStatuses.get(task.objective_id) === 'active';
}

// Per-project lock to prevent concurrent drainProjectQueue from double-launching tasks.
const drainingProjects = new Set<string>();
// A drain requested while the project lock is held must trigger another pass.
// Otherwise a task that becomes runnable after the active pass took its DB
// snapshot can be stranded until some unrelated event drains the queue again.
const pendingProjectDrains = new Set<string>();

// Per-task lock to prevent concurrent appendTaskMessageDedup from writing duplicates.
const appendingTasks = new Set<string>();

/**
 * Detect transient API errors that should trigger an automatic retry
 * instead of moving the task to the failed stage.
 * Covers Anthropic 529 (overloaded), generic rate-limit / capacity errors.
 */
export function isRetryableTaskError(error: string): boolean {
  // The dependency-guard message embeds a user-written task title, which must
  // not be able to trip a transient-provider pattern.
  if (isDependencyCommitMissingError(error)) return false;
  return matchesTransientPattern(providerErrorText(error));
}

/**
 * Provider named by a "No credentials configured for <provider>" run error:
 * the relay has no usable login for it, which no retry can fix. The Claude CLI
 * wraps that 503 as "usually temporary", so it is told apart by its text.
 */
export function missingCredentialProvider(error: string): string | null {
  const match = /No credentials configured for ([\w-]+)/i.exec(
    providerErrorText(error),
  );
  return match ? match[1].toLowerCase() : null;
}

/**
 * Narrow raw runner output (the free tail of agent stderr) to the lines that
 * carry the provider error: the final lines plus any line with a known
 * provider error prefix. Earlier agent output that merely mentions "rate
 * limit" or "capacity" must not count as a transient provider failure.
 */
function providerErrorText(error: string): string {
  const lines = error
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tailStart = Math.max(0, lines.length - 2);
  return lines
    .filter(
      (line, i) =>
        i >= tailStart || /^API Error\b|^\{\s*"type"\s*:\s*"error"/i.test(line),
    )
    .map((line) => line.slice(0, 1000))
    .join('\n');
}

function matchesTransientPattern(error: string): boolean {
  const patterns = [
    /529\b.*overloaded/i,
    /overloaded/i,
    /rate.?limit/i,
    /too many requests/i,
    /capacity/i,
    /temporarily unavailable/i,
    /service unavailable/i,
    /service ["'][^"']+["'] is not running/i,
    /sandbox unavailable/i,
  ];
  return patterns.some((re) => re.test(error));
}

/** Reduce structured provider output to the human-readable error message. */
export function formatTransientTaskError(error: string): string {
  const capacityMessage = error.match(
    /Selected model is at capacity\. Please try a different model\.?/i,
  );
  if (capacityMessage) return capacityMessage[0];

  const messageMatch = error.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (messageMatch) {
    try {
      return JSON.parse(`"${messageMatch[1]}"`);
    } catch {
      return messageMatch[1];
    }
  }
  return error.trim();
}

/** Longest run error kept verbatim; longer text is cut to head + tail. */
const ERROR_TEXT_MAX_CHARS = 4000;
const ERROR_TEXT_HEAD_CHARS = 2000;
const ERROR_TEXT_TAIL_CHARS = 2000;

/**
 * Bound a run error before it is stored as a task error or transcript row.
 * Keeps the start and end of an oversized dump and omits the middle.
 */
function capErrorText(text: string): string {
  if (text.length <= ERROR_TEXT_MAX_CHARS) return text;
  let headEnd = ERROR_TEXT_HEAD_CHARS;
  let tailStart = text.length - ERROR_TEXT_TAIL_CHARS;
  // Never split a surrogate pair at either cut point.
  if (/[\uD800-\uDBFF]/.test(text.charAt(headEnd - 1))) headEnd -= 1;
  if (/[\uDC00-\uDFFF]/.test(text.charAt(tailStart))) tailStart += 1;
  return `${text.slice(0, headEnd)}\n…[${tailStart - headEnd} chars omitted]…\n${text.slice(tailStart)}`;
}

/**
 * True for an oversized error or a raw harness protocol event (a JSON object
 * with a `type`, such as pi's `agent_end` dump). Quoted transcript text inside
 * these must not be read as a configuration failure. A `type: "error"` body is
 * a provider error envelope and stays eligible for config matching.
 */
function isOversizedOrHarnessEvent(text: string): boolean {
  if (text.length > ERROR_TEXT_MAX_CHARS) return true;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === 'string' && type !== 'error';
  } catch {
    return false;
  }
}

/**
 * Detect fatal configuration errors that should never be retried.
 * These indicate the agent_cmd, model, or API key is wrong — retrying
 * will just burn cycles indefinitely.
 *
 * @param agent_cmd - The configured agent command (e.g. "claude", "codex").
 *   Used to anchor the "command not found" check so that agent output
 *   mentioning a missing tool inside the sandbox doesn't false-positive.
 */
function isFatalConfigError(error: string, agent_cmd?: string): boolean {
  if (isOversizedOrHarnessEvent(error)) return false;

  const patterns: RegExp[] = [
    /ProviderModelNotFoundError/i,
    /model[\s_-]?not[\s_-]?found/i,
    // Also matches Anthropic's "invalid x-api-key" wording.
    /invalid[\s_-]?(?:x[\s_-]?)?api[\s_-]?key/i,
    /authentication[\s_-]?failed/i,
    /not[\s_-]?a[\s_-]?valid[\s_-]?model/i,
    /unknown[\s_-]?model/i,
  ];

  // "command not found" is only fatal when the *agent command itself* wasn't
  // found by the shell (e.g. "claude: command not found" or "bash: claude:
  // command not found").  Without anchoring to agent_cmd, this pattern would
  // false-positive on agent output that legitimately reports a missing tool
  // inside the sandbox (e.g. "ffmpeg: command not found" in a shell task).
  if (agent_cmd) {
    const escaped = escapeRegex(agent_cmd);
    patterns.push(new RegExp(`(^|\\b)${escaped}:.*command not found`, 'im'));
  } else {
    // Fallback when agent_cmd is unknown: match only the typical shell format
    // "<word>: command not found" at end-of-line to reduce false positives.
    patterns.push(/\S+:\s*command not found\s*$/im);
  }

  return patterns.some((re) => re.test(error));
}

export function _testOnlySetProjectFailureState(
  project_id: string,
  state: { count: number; blockedAt?: number } | null,
): void {
  if (state) projectConsecutiveFailures.set(project_id, state);
  else projectConsecutiveFailures.delete(project_id);
}

/** Reset consecutive failure counter for a project (e.g. on manual retry). */
export function resetProjectFailures(project_id: string): void {
  clearProjectFailureState(project_id);
}

function clearProjectFailureState(project_id: string): void {
  projectConsecutiveFailures.delete(project_id);
  const timer = failureCooldownTimers.get(project_id);
  if (timer) {
    clearTimeout(timer);
    failureCooldownTimers.delete(project_id);
  }
}

function scheduleFailureCooldownDrain(
  project_id: string,
  group: RegisteredGroup,
  drain: (project_id: string, group: RegisteredGroup) => unknown,
): void {
  if (failureCooldownTimers.has(project_id)) return;
  const timer = setTimeout(() => {
    // A fired timer is the cooldown's end; reset the block here so the drain's
    // wall-clock recheck (early timer, clock step) cannot leave the queue idle.
    clearProjectFailureState(project_id);
    Promise.resolve()
      .then(() => drain(project_id, group))
      .catch((err) => {
        logger.warn(
          { err, project: project_id },
          'Failed to drain project queue after failure cooldown',
        );
      });
  }, FAILURE_COOLDOWN_MS);
  timer.unref?.();
  failureCooldownTimers.set(project_id, timer);
}

export async function isTaskRunning(
  task_id: string,
  dbRunningIds?: Set<string>,
): Promise<boolean> {
  if (closedTaskSteeringClaims.has(task_id)) return false;
  // A task is "running" if it has been claimed (waiting for slot) or actively executing.
  if (claimedTasks.has(task_id) || stoppingTasks.has(task_id)) return true;
  // Check DB for runs surviving a restart; use pre-fetched set when available to avoid N+1 queries.
  if (dbRunningIds) return dbRunningIds.has(task_id);
  const runs = await getActiveRunsByStatus('running');
  return runs.some((r) => r.task_id === task_id);
}

/** Returns IDs of tasks that have acquired a sandbox slot and are actively executing.
 * Used by the GET /tasks endpoint to set the `running` field for the UI indicator. */
export function getRunningTaskIds(): string[] {
  return Array.from(runningTasks.keys()).filter(
    (id) => !closedTaskSteeringClaims.has(id),
  );
}

/** Returns IDs of tasks that have been claimed but are still waiting for a sandbox slot.
 * Used by the GET /tasks endpoint to set the `queued` field for the UI indicator. */
export function getQueuedTaskIds(): string[] {
  return Array.from(claimedTasks.keys()).filter(
    (id) => !runningTasks.has(id) && !closedTaskSteeringClaims.has(id),
  );
}

/**
 * Return executable-stage tasks the queue may start next, excluding claims,
 * active runs, stops, and retry backoffs. The queue drain uses this as its
 * candidate projection. Display consumers must additionally exclude tasks
 * that still carry an error marker: transient-retry tasks keep their
 * "Retry scheduled:" marker while sitting in an executable stage and must
 * stay drain-eligible until the delayed retry's pre-flight clears it.
 */
interface WaitingTaskData {
  allTasks?: Task[];
  dbRunningTaskIds?: ReadonlySet<string>;
  /** The queue drain notifies the user about provider logins it is holding for. */
  announceLoginHolds?: boolean;
}

interface QueueHoldContext {
  allowInactiveObjectiveTaskId?: string;
  dbRunningTaskIds: ReadonlySet<string>;
  failedStageEntryTasks: ReadonlySet<string>;
  objectiveStatuses: Map<string, string>;
  taskMap: Map<string, Task>;
  doneStageIds: ReadonlySet<string>;
  allTasks: Task[];
  /** Providers whose accounts all need a new login; read once per drain. */
  providerLoginHolds?: ReadonlySet<string>;
  /** Provider that serves the card's harness, when that is known up front. */
  providerOf?: (task: Task) => string | undefined;
}

/**
 * Provider account behind the harness a card will run on. Unknown for
 * harnesses without a provider account and when the selection does not
 * resolve.
 */
function queueProviderForTask(
  task: Task,
  group: RegisteredGroup,
): string | undefined {
  try {
    const stage = resolveStageForTask(
      group,
      task.status,
      isAbExperimentParent(task)
        ? 'a'
        : (task.stageVariant ?? task.stage_variant),
    );
    const { selection } = resolveKanbanRuntimeSelection(
      [
        task.runtimeSelectionStage && task.runtimeSelectionStage !== task.status
          ? undefined
          : (task.runtimeSelection ?? undefined),
        stage?.runtimeSelection,
        group.settings?.kanbanRuntimeSelection ?? undefined,
      ],
      task.status,
      stage?.type,
    );
    // An Auto selection picks its harness when a fresh session starts: the
    // stage's recorded routing names it, else the balanced default does.
    const harnessId = isAutoSelection(selection)
      ? (readStageRouting(task.custom_values, task.status)?.harnessId ??
        resolveAutoSelection(selection, null).harnessId)
      : selection.harnessId;
    return harnessId ? HARNESS_PROVIDER[harnessId] : undefined;
  } catch {
    return undefined;
  }
}

function executableStageIds(stages: StageDefinition[]): string[] {
  return stages
    .filter(
      (stage) =>
        (stage.type === 'active' ||
          stage.type === 'testing' ||
          stage.type === 'review') &&
        !stage.inactive,
    )
    .map((stage) => stage.id);
}

async function loadQueueHoldContext(
  project_id: string,
  stages: StageDefinition[],
  activeStageIds: string[],
  allowInactiveObjectiveTaskId?: string,
  waitingTaskData?: WaitingTaskData,
): Promise<QueueHoldContext> {
  const dbRunningTaskIds =
    waitingTaskData?.dbRunningTaskIds ??
    new Set(await getRunningTaskIdsForGroup(project_id));
  // Terminal entry failure releases the project-wide barrier but parks the
  // receipt's own card until an explicit resolution or stage transition.
  const failedStageEntryTasks = new Set(
    (await getUnresolvedStageEntryEvents(project_id))
      .filter((event) => event.state === 'failed')
      .map((event) => `${event.taskId}\0${event.stageId}`),
  );
  const allTasks =
    waitingTaskData?.allTasks ?? (await getTasksByProjectForQueue(project_id));
  // Resolve by id: a task may be tagged with an objective owned by another
  // project (e.g. a parent project's objective).
  const objectiveStatuses = await getObjectiveStatusesByIds(
    allTasks
      .filter((task) => activeStageIds.includes(task.status))
      .map((task) => task.objective_id)
      .filter((id): id is string => !!id),
  );
  const group = groupResolver?.(project_id);
  const providerLoginHolds = await getProviderLoginHolds();
  return {
    allowInactiveObjectiveTaskId,
    dbRunningTaskIds,
    failedStageEntryTasks,
    objectiveStatuses,
    providerLoginHolds,
    providerOf: group ? (task) => queueProviderForTask(task, group) : undefined,
    taskMap: new Map(allTasks.map((task) => [task.id, task])),
    doneStageIds: new Set(
      stages
        .filter((stage) => stage.type === 'done' && !stage.inactive)
        .map((stage) => stage.id),
    ),
    allTasks,
  };
}

/** First per-task reason the queue will not start an executable-stage card. */
export function taskQueueHoldReason(
  task: Task,
  ctx: QueueHoldContext,
): string | null {
  if (
    claimedTasks.has(task.id) ||
    runningTasks.has(task.id) ||
    ctx.dbRunningTaskIds.has(task.id)
  ) {
    return 'running';
  }
  if (stoppingTasks.has(task.id)) return 'stopping';
  if (retryPendingTasks.has(task.id)) return 'retry_pending';
  if (ctx.failedStageEntryTasks.has(`${task.id}\0${task.status}`)) {
    return 'stage_entry_failed';
  }
  if (task.archived) return 'archived';
  if (isHeldByBootDeployDispatch(task)) return 'deploy_dispatched';
  if (
    (task.ab_fork_commit || (task as any).abForkCommit) &&
    !ctx.doneStageIds.has(task.status)
  ) {
    return 'ab_parent_forked';
  }
  if (
    !_testOnlyCanAutoStartTaskForObjectives(
      task,
      ctx.objectiveStatuses,
      ctx.allowInactiveObjectiveTaskId,
    )
  ) {
    return `objective_inactive:${ctx.objectiveStatuses.get(task.objective_id!) ?? 'missing'}`;
  }
  if (task.execute_in_stage && task.status !== task.execute_in_stage) {
    return `execute_in_stage_mismatch:${task.execute_in_stage}`;
  }
  const pending = (task.depends_on_ids ?? []).filter((depId: string) => {
    const dependency = ctx.taskMap.get(depId);
    return dependency && !ctx.doneStageIds.has(dependency.status);
  });
  if (pending.length > 0) return `dependencies_pending:${pending.join(',')}`;
  if (ctx.providerLoginHolds?.size) {
    const provider = ctx.providerOf?.(task);
    if (provider && ctx.providerLoginHolds.has(provider))
      return `provider_login_required:${provider}`;
  }
  return null;
}

/**
 * A run ended on "No credentials configured for <provider>". Keep the card in
 * its stage with a visible marker; the queue holds it while the provider's
 * account needs a login and starts it again once it is connected.
 */
async function holdTaskForProviderLogin(
  task: Task,
  group: RegisteredGroup,
  provider: string,
  run: {
    sessionId?: string | null;
    agentName: string | null;
    modelName: string | null;
  },
): Promise<void> {
  const notice = `Waiting for the ${provider} account to be logged in again. Reconnect it in Managed accounts; this card starts again automatically.`;
  await updateTask(task.id, {
    error: `Login required: ${notice}`,
    output: '',
    ...(run.sessionId ? { session_id: run.sessionId } : {}),
  });
  broadcast({
    type: 'task_updated',
    payload: { task_id: task.id, project_id: task.project_id },
  });
  const message = appendTaskMessageDedup(task.project_id, {
    task_id: task.id,
    role: 'assistant',
    content: `⏸ ${notice}`,
    agent_name: run.agentName,
    model_name: run.modelName,
    created_at: new Date().toISOString(),
  });
  if (message) {
    broadcast({
      type: 'task_message',
      payload: { task_id: task.id, project_id: task.project_id, message },
    });
  }
  logger.warn(
    { task_id: task.id, provider },
    'Run ended without provider credentials — holding card until the account is logged in',
  );
  void announceProviderLoginOutage(provider, group);
}

/** One notification per provider outage, however many cards it holds. */
async function announceProviderLoginOutage(
  provider: string,
  group: RegisteredGroup,
): Promise<void> {
  if (!group.user_id) return;
  const outageStartedAt = claimOutageNotification(provider);
  if (outageStartedAt === null) return;
  const delivered = await notifyUserSystem(group.user_id, group.folder, {
    summary: `Reconnect the ${provider} account`,
    content: `The ${provider} account needs a new login, so cards that run on it are waiting. Reconnect it in Managed accounts; they start again on their own.`,
    source_id: `provider-login:${provider}:${outageStartedAt}`,
    action_url: '/admin/provider-accounts',
  });
  if (!delivered) releaseOutageNotification(provider);
}

export async function getWaitingTaskIds(
  project_id: string,
  allowInactiveObjectiveTaskId?: string,
  waitingTaskData?: WaitingTaskData,
): Promise<string[]> {
  const group = groupResolver?.(project_id);
  if (!group) return [];
  const projectStatus = group.settings?.status ?? 'running';
  if (projectStatus === 'stopped' || projectStatus === 'paused') return [];

  const stages = getGroupStages(group);
  const activeStageIds = executableStageIds(stages);
  if (activeStageIds.length === 0) return [];

  const ctx = await loadQueueHoldContext(
    project_id,
    stages,
    activeStageIds,
    allowInactiveObjectiveTaskId,
    waitingTaskData,
  );

  const heldByObjective: string[] = [];
  const heldByLogin = new Set<string>();
  const waitingIds = ctx.allTasks
    .filter((task) => activeStageIds.includes(task.status))
    .filter((task) => {
      const reason = taskQueueHoldReason(task, ctx);
      if (reason?.startsWith('provider_login_required:')) {
        heldByLogin.add(reason.slice('provider_login_required:'.length));
      }
      if (reason?.startsWith('objective_inactive:')) {
        heldByObjective.push(
          `${task.id}:${task.objective_id}=${reason.slice('objective_inactive:'.length)}`,
        );
      }
      return reason === null;
    })
    .map((task) => task.id);
  if (heldByObjective.length > 0) {
    logger.debug(
      { project_id, held: heldByObjective },
      'Queue holding tasks whose objective is not active',
    );
  }
  if (heldByLogin.size > 0) {
    logger.info(
      { project_id, providers: [...heldByLogin] },
      'Queue holding tasks until their provider account is logged in again',
    );
    if (waitingTaskData?.announceLoginHolds)
      for (const provider of heldByLogin)
        void announceProviderLoginOutage(provider, group);
  }
  return waitingIds;
}

/**
 * Explain why the queue is not starting a card, computed on read. Returns null
 * for cards outside an enabled executable stage; `waiting_for_slot` when
 * nothing holds the card and it is only waiting for capacity.
 */
export async function getTaskQueueHoldReason(
  task: Task,
): Promise<string | null> {
  const group = groupResolver?.(task.project_id);
  if (!group) return null;
  const stages = getGroupStages(group);
  const activeStageIds = executableStageIds(stages);
  if (!activeStageIds.includes(task.status)) return null;

  const projectStatus = group.settings?.status ?? 'running';
  if (projectStatus === 'stopped') return 'project_stopped';
  if (projectStatus === 'paused') return 'project_paused';

  const ctx = await loadQueueHoldContext(
    task.project_id,
    stages,
    activeStageIds,
  );
  const reason = taskQueueHoldReason(task, ctx);
  if (reason) return reason;

  // Mirrors drainProjectQueueInner: entry barriers take precedence, and the
  // failure block only applies while no barrier exists.
  if ((await getBlockingStageEntryEvents(task.project_id)).length > 0) {
    return 'stage_entry_barrier';
  }
  const failState = projectConsecutiveFailures.get(task.project_id);
  if (
    failState &&
    failState.count >= MAX_CONSECUTIVE_FAILURES &&
    !(
      failState.blockedAt &&
      Date.now() - failState.blockedAt >= FAILURE_COOLDOWN_MS
    )
  ) {
    return 'failure_cooldown';
  }
  return 'waiting_for_slot';
}

/**
 * True while an in-process execution claim (queued-for-start or stopping)
 * exists for the task. Synchronous on purpose: variant-edit guards call it in
 * the same tick as their write so a claim installed afterwards either sees
 * the committed variant on its post-claim re-read or blocks the edit.
 */
export function isTaskExecutionClaimed(task_id: string): boolean {
  return claimedTasks.has(task_id) || stoppingTasks.has(task_id);
}

/** Like isTaskExecutionClaimed, but ignores the claim held by `abort`. */
export function isTaskExecutionClaimedByOther(
  task_id: string,
  abort: AbortController,
): boolean {
  const claim = claimedTasks.get(task_id);
  return (
    stoppingTasks.has(task_id) || (claim !== undefined && claim.abort !== abort)
  );
}

// Per-task chain that serializes stage_variant writes against the execution
// claim's post-claim variant re-read. A variant write holds the chain from its
// synchronous guard check through its commit; executeTask waits on the chain
// before re-reading. Either the write commits first (the run reads it) or the
// claim is installed first (the write's guard rejects), so a delayed variant
// commit can never land under an execution that already resolved its stage.
const stageVariantWriteChains = new Map<string, Promise<void>>();

export function withStageVariantWriteLock<T>(
  task_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = stageVariantWriteChains.get(task_id) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const settle = result.then(
    () => {},
    () => {},
  );
  stageVariantWriteChains.set(task_id, settle);
  void settle.then(() => {
    if (stageVariantWriteChains.get(task_id) === settle)
      stageVariantWriteChains.delete(task_id);
  });
  return result;
}

/** Resolves once every stage_variant write started before this call settles. */
export function waitForStageVariantWrites(task_id: string): Promise<void> {
  return stageVariantWriteChains.get(task_id) ?? Promise.resolve();
}

/** Atomically claim a task before executeTask reaches its first await. */
export function claimTaskExecution(
  task_id: string,
  project_id: string,
  bypassesAutomaticCapacity = false,
): AbortController | null {
  if (claimedTasks.has(task_id) || stoppingTasks.has(task_id)) return null;

  // A manual run while a retry is waiting supersedes the scheduled retry,
  // clears its timer, and releases its reservation. Any superseded callback
  // checks its generation and becomes a no-op, so it never clears a newer
  // retry, grants priority, or drains early.
  const transientRetry =
    retryPendingTasks.has(task_id) || retryPriorityTasks.has(task_id);
  clearTransientRetryTimer(task_id);
  retryPendingTasks.delete(task_id);
  retryReservedTasks.delete(task_id);
  retryPriorityTasks.delete(task_id);

  const abort = new AbortController();
  claimedTasks.set(task_id, {
    abort,
    project_id,
    bypassesAutomaticCapacity,
    transientRetry,
    messageAdmissionBarrier:
      taskSteeringLocks.get(task_id) ?? Promise.resolve(),
  });
  return abort;
}

/** Reserve a reset without allowing Stop or project pause to evict it. */
export function claimTaskReset(
  task_id: string,
  project_id: string,
): AbortController | null {
  const abort = claimTaskExecution(task_id, project_id, true);
  if (abort) claimedTasks.get(task_id)!.resetting = true;
  return abort;
}

/**
 * Reserve restart recovery ahead of an ordinary claim that has not launched.
 *
 * The interrupted active_runs row is the durable execution owner. An ordinary
 * queue/manual request can pass its read-side idle check immediately before
 * boot recovery observes that row, then reserve only the in-process claim. In
 * that narrow window recovery must win: once the ordinary claim has crossed
 * the launch boundary, its running marker and newer active_runs row instead
 * become the authoritative execution and recovery leaves it alone.
 */
export function claimRestartRecoveryTaskExecution(
  task_id: string,
  project_id: string,
): AbortController | null {
  const existing = claimedTasks.get(task_id);
  if (existing) {
    if (
      existing.resetting ||
      existing.forking ||
      runningTasks.get(task_id)?.abort === existing.abort
    )
      return null;
    existing.abort.abort();
    claimedTasks.delete(task_id);
  }
  return claimTaskExecution(task_id, project_id);
}

/** Release only state owned by this execution, preserving any newer re-run. */
export function releaseTaskExecutionClaim(
  task_id: string,
  abort: AbortController,
): void {
  const ownsClaim = claimedTasks.get(task_id)?.abort === abort;
  const ownsRunning = runningTasks.get(task_id)?.abort === abort;

  if (ownsClaim) claimedTasks.delete(task_id);
  if (ownsRunning) runningTasks.delete(task_id);
}

/** Release one execution and announce only when it still owns the running slot. */
export function finishOwnedTaskExecution(
  task_id: string,
  project_id: string,
  abort: AbortController,
  run_id: string | null,
  emit: (event: {
    type: 'run_finished';
    payload: { project_id: string; task_id: string; run_id: string };
  }) => void = broadcast,
): boolean {
  const ownsRunningClaim = runningTasks.get(task_id)?.abort === abort;
  releaseTaskExecutionClaim(task_id, abort);
  const presentationAlreadyRetired = run_id
    ? retiredTaskRunPresentations.delete(run_id)
    : false;
  if (ownsRunningClaim && run_id && !presentationAlreadyRetired) {
    emit({
      type: 'run_finished',
      payload: { project_id, task_id, run_id },
    });
  }
  return ownsRunningClaim;
}

/** Retire the client-visible run before successful transition effects begin. */
export function retireOwnedTaskExecutionPresentation(
  task_id: string,
  project_id: string,
  abort: AbortController,
  run_id: string | null,
  emit: (event: {
    type: 'run_finished';
    payload: { project_id: string; task_id: string; run_id: string };
  }) => void = broadcast,
): boolean {
  if (!run_id || runningTasks.get(task_id)?.abort !== abort) return false;
  if (retiredTaskRunPresentations.has(run_id)) return true;
  retiredTaskRunPresentations.add(run_id);
  emit({
    type: 'run_finished',
    payload: { project_id, task_id, run_id },
  });
  return true;
}

/**
 * Finish a restart-recovered execution. Recovery keeps its reservation in the
 * claimed map (rather than the in-process running map), but it still emits
 * task_started and owns the run-level lifecycle until its watcher exits.
 */
export function finishRecoveredTaskExecution(
  task_id: string,
  project_id: string,
  abort: AbortController,
  run_id: string,
  emit: (event: {
    type: 'run_finished';
    payload: { project_id: string; task_id: string; run_id: string };
  }) => void = broadcast,
): boolean {
  if (claimedTasks.get(task_id)?.abort !== abort) return false;

  claimedTasks.delete(task_id);
  if (runningTasks.get(task_id)?.abort === abort) runningTasks.delete(task_id);
  if (!retiredTaskRunPresentations.delete(run_id)) {
    emit({
      type: 'run_finished',
      payload: { project_id, task_id, run_id },
    });
  }
  return true;
}

/** Recovery counterpart to retireOwnedTaskExecutionPresentation. */
export function retireRecoveredTaskExecutionPresentation(
  task_id: string,
  project_id: string,
  abort: AbortController,
  run_id: string,
  emit: (event: {
    type: 'run_finished';
    payload: { project_id: string; task_id: string; run_id: string };
  }) => void = broadcast,
): boolean {
  if (claimedTasks.get(task_id)?.abort !== abort) return false;
  if (retiredTaskRunPresentations.has(run_id)) return true;
  retiredTaskRunPresentations.add(run_id);
  emit({
    type: 'run_finished',
    payload: { project_id, task_id, run_id },
  });
  return true;
}

/**
 * Worktree-isolated runs can free their queue slot before slow branch and
 * observation cleanup. Shared-checkout projects must keep the slot until that
 * cleanup finishes so another task cannot mutate the same working tree.
 */
async function runPostExecutionCleanup(
  releaseBeforeCleanup: boolean,
  release: () => void,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (releaseBeforeCleanup) release();
  try {
    await cleanup();
  } finally {
    if (!releaseBeforeCleanup) release();
  }
}

export async function parkTaskAfterGitCheckpointFailure(
  task: Task,
  stages: StageDefinition[],
  err: unknown,
): Promise<void> {
  const retryStageId = getInitialStage(stages)?.id ?? task.status;
  await updateTask(task.id, {
    status: retryStageId,
    completed_at: null,
  });
  const checkpointNotice = appendTaskMessageDedup(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content:
      `**Task checkpoint failed** — CarapaBoard could not persist this run's changes in Git. ` +
      `The task was paused in \`${retryStageId}\`; no later stage will start until the Git environment is corrected and the task is retried.\n\n${String(err)}`,
    created_at: new Date().toISOString(),
  });
  if (checkpointNotice) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: checkpointNotice,
      },
    });
  }
  const checkpointPending = await getTask(task.id);
  if (checkpointPending) {
    broadcast({
      type: 'task_updated',
      payload: checkpointPending,
    });
  }
  logger.warn(
    { err, task_id: task.id },
    'Git checkpoint failed — task parked and queue cleanup preserved',
  );
}

/** @internal Test-only hook for queue-slot cleanup ordering. */
export const _testOnlyRunPostExecutionCleanup = runPostExecutionCleanup;

/** Finalize only the DB row belonging to the execution that still owns the task. */
async function finalizeOwnedActiveRun(
  task_id: string,
  abort: AbortController,
  run_id: string | null,
  status: 'error' | 'completed',
): Promise<string | null> {
  if (claimedTasks.get(task_id)?.abort !== abort || !run_id) return null;

  const danglingRun = await getActiveRunById(run_id);
  // Ownership can change while the DB lookup is in flight.
  if (claimedTasks.get(task_id)?.abort !== abort) return null;
  if (!danglingRun || danglingRun.status !== 'running') return null;

  await completeActiveRun(danglingRun.id, status);
  return danglingRun.id;
}

// ---------------------------------------------------------------------------
// Test-only state helpers
// ---------------------------------------------------------------------------

/**
 * Registers a task id directly into the in-memory runningTasks map.
 * FOR TESTING ONLY — do not call from production code.
 */
export function _testOnlyRegisterRunning(
  task_id: string,
  project_id: string,
  run_id?: string,
): AbortController {
  const abort = new AbortController();
  runningTasks.set(task_id, { abort, project_id, run_id });
  return abort;
}

/**
 * Registers a task id directly into the in-memory claimedTasks map.
 * FOR TESTING ONLY — do not call from production code.
 */
export function _testOnlyRegisterQueued(
  task_id: string,
  project_id: string,
): void {
  claimedTasks.set(task_id, { abort: new AbortController(), project_id });
}

/** @internal Test-only hooks for execution claim race coverage. */
export const _testOnlyTryClaimTaskExecution = claimTaskExecution;
export const _testOnlyReleaseTaskExecutionClaim = releaseTaskExecutionClaim;
export const _testOnlyFinalizeOwnedActiveRun = finalizeOwnedActiveRun;

// ---------------------------------------------------------------------------
// Output streaming helpers
// ---------------------------------------------------------------------------

/** Mirrors what was broadcast via task_output — used to persist partial work on stop. */
const taskStreamBuffers = new Map<string, string[]>();
const testingVerdictRuns = new Set<string>();
const testingRawBuffers = new Map<string, string[]>();

function recordTestingRawChunk(task_id: string, content: string): void {
  const chunks = testingRawBuffers.get(task_id) ?? [];
  chunks.push(content);
  testingRawBuffers.set(task_id, chunks);
}

function takeTestingRawBuffer(task_id: string): string {
  const content = (testingRawBuffers.get(task_id) ?? []).join('');
  testingRawBuffers.delete(task_id);
  return content;
}

/**
 * Prefer the parser's canonical final answer over the live display stream.
 * The complete live stream is retained separately for paginated retrieval.
 */
export function selectTaskAssistantContent(
  streamed: string,
  canonical: string | null | undefined,
): string {
  return canonical?.trim() ? canonical : streamed;
}

function reconcileTaskTranscriptContent(
  streamed: string,
  canonical: string | null | undefined,
): string {
  if (!streamed) return canonical ?? '';
  if (!canonical) return streamed;
  if (canonical.includes(streamed)) return canonical;
  if (streamed.includes(canonical)) return streamed;
  return `${streamed}\n\n${canonical}`;
}

/** Record streamed task output in memory for stop handling and on disk for reload. */
export function recordTaskStreamChunk(
  task_id: string,
  content: string,
  project_id?: string,
  run_id?: string | null,
  entry_id?: string,
  entry_complete?: boolean,
  canonical_entry?: boolean,
): void {
  if (!content && !entry_id) return;
  if (content) {
    const chunks = taskStreamBuffers.get(task_id) ?? [];
    chunks.push(content);
    taskStreamBuffers.set(task_id, chunks);
  }
  if (project_id)
    queueTaskOutputChunk(
      project_id,
      task_id,
      run_id ?? null,
      content,
      entry_id,
      entry_complete,
      canonical_entry,
    );
}

export function clearTaskStreamBuffer(task_id: string): void {
  flushTaskOutputChunks(task_id);
  taskStreamBuffers.delete(task_id);
}

/** End a task stream whose final display is represented by saved messages. */
function clearTaskStream(
  task_id: string,
  project_id: string,
  preserveTestingState = false,
  forceLiveClear = false,
  run_id: string | null = null,
): void {
  clearTaskStreamBuffer(task_id);
  if (!preserveTestingState) {
    testingRawBuffers.delete(task_id);
    testingVerdictRuns.delete(task_id);
  }
  broadcast({
    type: 'task_output_clear',
    payload: {
      task_id,
      project_id,
      ...(forceLiveClear ? { force: true } : {}),
      ...(run_id ? { run_id } : {}),
    },
  });
}

function takeTaskStreamBuffer(task_id: string): string {
  flushTaskOutputChunks(task_id);
  const buf = (taskStreamBuffers.get(task_id) ?? []).join('');
  taskStreamBuffers.delete(task_id);
  return buf;
}

/**
 * Re-register an abort controller for a task run recovered after restart so
 * stopTask() can abort waitForRun() the same way as an in-process executeTask.
 */
export function registerRecoveredTaskAbort(
  task_id: string,
  project_id: string,
  abort: AbortController,
): void {
  claimedTasks.set(task_id, { abort, project_id });
}

/**
 * Release a recovered task claim once its background recovery watcher exits.
 * Only delete the claim when it still belongs to this watcher: a newer run may
 * have claimed the same task between recovery completion and final cleanup.
 */
export function unregisterRecoveredTaskAbort(
  task_id: string,
  abort: AbortController,
): void {
  if (claimedTasks.get(task_id)?.abort === abort) {
    claimedTasks.delete(task_id);
    runningTasks.delete(task_id);
  }
}

/**
 * Release a claim that failed before executeTask entered its main try/finally
 * and wake the project's queue. Kept separate so this failure boundary can be
 * tested without starting a sandbox process.
 */
function handlePreflightFailure(
  task_id: string,
  abort: AbortController,
  project_id: string,
  group: RegisteredGroup,
  queueDrain: typeof drainProjectQueue = drainProjectQueue,
  retryDelayMs: number | null = RETRYABLE_DELAY_MS,
): void {
  if (claimedTasks.get(task_id)?.abort === abort) {
    claimedTasks.delete(task_id);
  }
  // The failed pre-flight update may leave the task in an active stage. Keep
  // its slot reserved until the transient retry delay expires.
  scheduleTransientTaskRetry(
    task_id,
    project_id,
    group,
    queueDrain,
    retryDelayMs,
  );
  // A retry reservation deliberately holds this task's slot until its delay
  // expires. With no delayed retry (the test-only path), retain the former
  // behavior and wake the queue immediately.
  if (retryDelayMs === null) {
    queueDrain(project_id, group).catch((drainErr) => {
      logger.error(
        { task_id, error: String(drainErr) },
        'Unhandled queue drain error after pre-flight task failure',
      );
    });
  }
}

/**
 * An A/B parent's pre-flight (fork) threw without a stage-entry receipt. Retry
 * transient errors within the shared budget and fail the card otherwise, so a
 * persistent fork failure cannot loop every backoff period without a trace on
 * the card. A card that was archived or moved meanwhile is left alone;
 * `claimedStatus` is the status it had when this run claimed it (a manual Run
 * of a queued parent claims it before moving it to the fork stage).
 */
async function settleAbPreflightFailure(
  task: Task,
  abort: AbortController,
  group: RegisteredGroup,
  claimedStatus: string,
  err: unknown,
): Promise<void> {
  const message = capErrorText(
    err instanceof Error ? err.message : String(err),
  );
  try {
    const current = await getTask(task.id);
    if (!current || current.archived || current.status !== claimedStatus) {
      releaseTaskExecutionClaim(task.id, abort);
      return;
    }
    // The delayed retry only drains executable stages; a card claimed from a
    // queue stage (manual Run) has nothing to retry, so record the failure.
    const plan =
      isRetryableTaskError(message) &&
      isActiveStage(getGroupStages(group), claimedStatus)
        ? await planTransientRetry(current)
        : null;
    if (plan && !plan.exhausted) {
      await updateTask(task.id, {
        error: `Retry scheduled: ${formatTransientTaskError(message)}`,
        custom_values: plan.customValues,
      });
      broadcast({
        type: 'task_updated',
        payload: { task_id: task.id, project_id: task.project_id },
      });
      handlePreflightFailure(
        task.id,
        abort,
        task.project_id,
        group,
        drainProjectQueue,
        plan.delayMs,
      );
      return;
    }
    const error = plan
      ? `Transient error retries exhausted after ${plan.attempts} attempts: ${formatTransientTaskError(message)}`
      : message;
    releaseTaskExecutionClaim(task.id, abort);
    const failedStatus = getFailedStage(getGroupStages(group))?.id ?? 'failed';
    const failedStageEntryEvent = await updateTask(task.id, {
      status: failedStatus,
      error,
      ...(plan ? { custom_values: plan.customValues } : {}),
    });
    const failedTask = (await getTask(task.id)) ?? {
      ...current,
      status: failedStatus,
    };
    broadcast({ type: 'task_updated', payload: failedTask });
    await publishExecutionFailure(
      failedTask,
      group,
      error,
      nextPreflightFailureRunId(task.id),
      failedStageEntryEvent?.id,
    );
  } catch (settleError) {
    // Bookkeeping failed (e.g. a DB outage): keep the former delayed retry
    // rather than leaving the card unclaimed in an active stage.
    logger.error(
      { error: String(settleError), task_id: task.id },
      'Failed to settle A/B fork failure',
    );
    handlePreflightFailure(task.id, abort, task.project_id, group);
  }
}

/** @internal Test-only hook for the pre-flight queue recovery path. */
export const _testOnlyHandlePreflightFailure = handlePreflightFailure;
export const _testOnlyIsRetryPending = (task_id: string): boolean =>
  retryPendingTasks.has(task_id);
export const _testOnlyGetRetryReservedCount = (project_id: string): number =>
  Array.from(retryReservedTasks.values()).filter(
    (reservedProjectId) => reservedProjectId === project_id,
  ).length;

// Bounds on how much prior conversation is folded into a fresh agent's prompt on
// a stage/agent handoff. Assistant turns embed the full tool-call/result
// rendering, so a long task can produce >100 KB of mostly-tool noise. We keep
// only the most-recent *conversational* messages (tool-call-only turns dropped),
// limited by both a message count and a character budget.
const MAX_FOLDED_HISTORY_CHARS = 8_000;
const MAX_FOLDED_HISTORY_MESSAGES = 10;

/** Remove rendered tool-call/result details before a fresh stage sees history. */
export function stripFoldedAssistantToolRendering(content: string): string {
  return content
    .split('\n')
    .filter((l) => !/^\s*>/.test(l)) // drop tool-call/result/thinking blockquotes
    .join('\n')
    .replace(/```[\s\S]*?```/g, '') // drop fenced tool/code blocks
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether an assistant turn has no conversational prose after sanitizing. */
function isToolCallOnly(content: string): boolean {
  return stripFoldedAssistantToolRendering(content).length === 0;
}

/**
 * Split a task transcript into:
 *  - `lastAssistantIdx`: index of the most recent assistant message (-1 if none)
 *  - `newUserMessages`: user/system messages *after* that index — un-addressed follow-ups
 *  - `historyForFold`: everything up to and including the last assistant turn (safe to fold
 *    into the prompt without duplicating the follow-up)
 *
 * Shared by the resume and fresh-stage branches so both surface the same
 * follow-up as the new message and keep the folded history consistent.
 *
 * Exported for unit testing.
 */
export function splitFollowUpsFromHistory<
  T extends {
    role: string;
    content: string;
    entry_type?: string;
    id?: string;
    steering?: boolean;
    prompt_id?: string;
  },
>(
  messages: T[],
): { lastAssistantIdx: number; newUserMessages: T[]; historyForFold: T[] } {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  const deliveredSteering = new Set(
    messages
      .filter((m) => m.entry_type === 'steering_delivery' && m.prompt_id)
      .map((m) => m.prompt_id),
  );
  const newUserMessages = messages.filter((m, index) => {
    const pendingSteering =
      !!m.steering && !!m.id && !deliveredSteering.has(m.id);
    if (!pendingSteering && index <= lastAssistantIdx) return false;
    return (
      (m.role === 'user' || m.role === 'system') &&
      m.content.trim().length > 0 &&
      (!m.steering || !m.id || !deliveredSteering.has(m.id)) &&
      m.entry_type !== 'stage_prompt' &&
      m.entry_type !== 'stage_prompt_delivery' &&
      m.entry_type !== 'steering_delivery' &&
      (m.entry_type === 'testing_feedback' ||
        m.entry_type !== 'system_notice' ||
        /^\*\*Review loop limit reached\*\*/.test(m.content))
    );
  });
  const pendingSteeringIds = new Set(
    newUserMessages
      .filter((message) => message.steering && message.id)
      .map((message) => message.id),
  );
  const historyForFold = messages
    .slice(0, lastAssistantIdx + 1)
    .filter((message) => !pendingSteeringIds.has(message.id));
  return { lastAssistantIdx, newUserMessages, historyForFold };
}

type VerdictCandidate = {
  role: string;
  entry_type?: string;
  run_id?: string | null;
  content?: string;
};

/** Heading of the verdict summaries the board writes after a Testing run. */
const TESTING_VERDICT_SUMMARY = /^\*\*Testing (passed|failed|blocked)\*\*/;

/**
 * Drop earlier Testing verdicts: the `testing_feedback` entries, the
 * unattributed pass/chain summaries, and the assistant output of Testing runs.
 * Stage prompts and comments stay.
 */
export function omitTestingVerdicts<T extends VerdictCandidate>(
  messages: T[],
  testingRunIds: ReadonlySet<string>,
): T[] {
  return messages.filter(
    (message) =>
      message.entry_type !== 'testing_feedback' &&
      !(
        message.role === 'system' &&
        TESTING_VERDICT_SUMMARY.test(message.content ?? '')
      ) &&
      !(
        message.role === 'assistant' &&
        message.run_id &&
        testingRunIds.has(message.run_id)
      ),
  );
}

/** Return stage-addressed prompts that have not yet been assigned to a run. */
export function getPendingStagePrompts<
  T extends {
    id: string;
    role?: string;
    entry_type?: string;
    target_stage?: string;
    prompt_id?: string;
    steering?: boolean;
    run_id?: string | null;
  },
>(messages: T[], targetStage: string): T[] {
  return getPendingTaskDeliveryPrompts(messages, targetStage).filter(
    (message) => message.entry_type === 'stage_prompt',
  );
}

/** Return the ordered canonical prompts awaiting one exact stage run. */
export function getPendingTaskDeliveryPrompts<
  T extends {
    id: string;
    role?: string;
    entry_type?: string;
    target_stage?: string;
    prompt_id?: string;
    steering?: boolean;
    run_id?: string | null;
  },
>(messages: T[], targetStage: string, excludingRunId?: string): T[] {
  const delivered = new Set(
    messages
      .filter(
        (message) =>
          (message.entry_type === 'steering_delivery' ||
            message.entry_type === 'stage_prompt_delivery') &&
          typeof message.prompt_id === 'string',
      )
      .map((message) => message.prompt_id as string),
  );
  return messages.filter((message) => {
    if (delivered.has(message.id)) return false;
    if (message.role === 'user' && message.steering) {
      return !message.target_stage || message.target_stage === targetStage;
    }
    return (
      message.entry_type === 'stage_prompt' &&
      message.target_stage === targetStage &&
      (!excludingRunId || message.run_id !== excludingRunId)
    );
  });
}

/**
 * Render task messages as `[role (agent)]: content` for folding into a prompt.
 * Keeps only the last `maxMessages` non-tool-call messages, further bounded to
 * `maxChars` (newest-first; the newest is always kept, tail-truncated if it
 * alone exceeds the budget). Prepends a notice when anything is trimmed.
 */
export function formatFoldedHistory(
  messages: {
    role: string;
    agent_name?: string | null;
    content: string;
    entry_type?: string;
  }[],
  maxChars = MAX_FOLDED_HISTORY_CHARS,
  maxMessages = MAX_FOLDED_HISTORY_MESSAGES,
): string {
  const fmt = (m: {
    role: string;
    agent_name?: string | null;
    content: string;
    entry_type?: string;
  }) => {
    const content =
      m.role === 'assistant'
        ? stripFoldedAssistantToolRendering(m.content)
        : m.content;
    return `[${m.role}${m.agent_name ? ` (${m.agent_name})` : ''}]: ${content}`;
  };

  // Drop tool-call-only turns, then keep at most the last `maxMessages`.
  // Mixed assistant turns retain their conclusions but not rendered commands
  // or results. Those can contain run-scoped ports, browser sessions, IPC
  // paths, and other ephemeral values that are invalid in the next stage.
  const real = messages.filter(
    (m) =>
      m.entry_type !== 'stage_prompt' &&
      m.entry_type !== 'stage_prompt_delivery' &&
      (m.role !== 'assistant' || !isToolCallOnly(m.content)),
  );
  const recent = real.slice(-maxMessages);

  const kept: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    let piece = fmt(recent[i]);
    const cost = piece.length + 2; // +2 for the "\n\n" join
    if (kept.length === 0 && cost > maxChars) {
      // Newest message alone exceeds the budget — keep its tail (latest content).
      piece = `[…older content truncated…]\n${piece.slice(piece.length - maxChars)}`;
    } else if (kept.length > 0 && used + cost > maxChars) {
      break;
    }
    kept.unshift(piece);
    used += piece.length + 2;
  }
  const trimmed = kept.length < real.length || real.length < messages.length;
  const notice = trimmed
    ? `_[Earlier conversation trimmed — showing the last ${kept.length} message(s).]_\n\n`
    : '';
  return notice + kept.join('\n\n');
}

const TASK_OUTPUT_EVENT_BYTES = 32 * 1024;

function streamChunk(
  task_id: string,
  content: string,
  project_id?: string,
  run_id?: string | null,
  onChunk?: (c: string) => void,
  entryId?: string,
  entryComplete?: boolean,
  canonicalEntry?: boolean,
) {
  if (!content && !entryId) return;
  recordTaskStreamChunk(
    task_id,
    content,
    project_id,
    run_id,
    entryId,
    entryComplete,
    canonicalEntry,
  );
  let chunkStart = 0;
  let codeUnitOffset = 0;
  let chunkBytes = 0;
  for (const point of content) {
    const nextOffset = codeUnitOffset + point.length;
    const pointBytes = Buffer.byteLength(point, 'utf8');
    if (chunkBytes + pointBytes > TASK_OUTPUT_EVENT_BYTES) {
      const chunk = content.slice(chunkStart, codeUnitOffset);
      if (chunk)
        broadcast({
          type: 'task_output',
          payload: {
            task_id,
            run_id: run_id ?? undefined,
            content: chunk,
            ...(entryId ? { entry_id: entryId } : {}),
            ...(entryComplete !== undefined ? { entry_complete: false } : {}),
          },
        });
      chunkStart = codeUnitOffset;
      chunkBytes = 0;
    }
    chunkBytes += pointBytes;
    codeUnitOffset = nextOffset;
  }
  const tail = content.slice(chunkStart);
  if (tail || (entryId && entryComplete !== undefined))
    broadcast({
      type: 'task_output',
      payload: {
        task_id,
        run_id: run_id ?? undefined,
        content: tail,
        ...(entryId ? { entry_id: entryId } : {}),
        ...(entryComplete !== undefined
          ? { entry_complete: entryComplete }
          : {}),
        ...(canonicalEntry ? { canonical_entry: true } : {}),
      },
    });
  onChunk?.(content);
}

function isSameTaskMessage(
  last: TaskMessage | undefined,
  data: {
    role: TaskMessage['role'];
    content: string;
    agent_name?: string | null;
  },
): boolean {
  return (
    !!last &&
    last.role === data.role &&
    last.content === data.content &&
    (last.agent_name || '') === (data.agent_name || '')
  );
}

/**
 * Append a task message unless it is identical to the most recent message.
 * This prevents duplicate user/assistant turns caused by overlapping write paths.
 * Uses a per-task lock to avoid TOCTOU races where two concurrent callers both
 * read the same last message, both pass the dedup check, and both append.
 */
function appendTaskMessageDedup(
  project_id: string,
  data: {
    task_id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    agent_name?: string | null;
    model_name?: string | null;
    entry_type?: TaskMessage['entry_type'];
    run_id?: string | null;
    created_at: string;
  },
) {
  const lockKey = `${project_id}:${data.task_id}`;
  if (appendingTasks.has(lockKey)) {
    // Another call is mid-append for this task — skip to avoid duplicate
    return null;
  }
  appendingTasks.add(lockKey);
  try {
    const messages = readTaskMessages(project_id, data.task_id);
    const last = messages[messages.length - 1];
    if (isSameTaskMessage(last, data)) return null;
    return appendTaskMessage(project_id, data);
  } finally {
    appendingTasks.delete(lockKey);
  }
}

/** Non-blocking deduplicated append used while a sandbox run is starting. */
async function appendTaskMessageDedupAsync(
  project_id: string,
  data: {
    task_id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    agent_name?: string | null;
    model_name?: string | null;
    created_at: string;
  },
) {
  const lockKey = `${project_id}:${data.task_id}`;
  if (appendingTasks.has(lockKey)) return null;
  appendingTasks.add(lockKey);
  try {
    const messages = await readTaskMessagesAsync(project_id, data.task_id);
    const last = messages[messages.length - 1];
    if (isSameTaskMessage(last, data)) return null;
    return await appendTaskMessageAsync(project_id, data);
  } finally {
    appendingTasks.delete(lockKey);
  }
}

export async function persistAutomaticStageEntrySuccess(input: {
  eventId: string;
  task: Task;
  output: string;
  agentName: string | null;
  modelName: string | null;
  runId: string | null;
  sessionId?: string;
}): Promise<boolean> {
  const completion = await completeStageEntryEventIfOwned({
    eventId: input.eventId,
    state: 'succeeded',
    output: input.output,
    error: null,
    lastAgentName: input.agentName,
    sessionId: input.sessionId,
  });
  if (!completion) return false;
  const task = completion.task;
  const assistantMessage = appendTaskMessageDedup(task.project_id, {
    task_id: task.id,
    role: 'assistant',
    content: input.output,
    agent_name: input.agentName,
    model_name: input.modelName,
    entry_type: 'run_result',
    run_id: input.runId,
    created_at: new Date().toISOString(),
  });
  if (assistantMessage) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: assistantMessage,
      },
    });
  }
  broadcast({ type: 'task_updated', payload: task });
  await notifyStageEntryLifecycle(completion.event, task);
  return true;
}

export async function persistAutomaticStageEntryFailure(input: {
  eventId: string;
  task: Task;
  enteredStageId: string;
  error: string;
  output: string;
  agentName: string | null;
  modelName: string | null;
  runId: string | null;
  sessionId?: string;
}): Promise<boolean> {
  const failureOutput = input.output.trim();
  const completion = await completeStageEntryEventIfOwned({
    eventId: input.eventId,
    state: 'failed',
    output: failureOutput || input.error,
    error: input.error,
    lastAgentName: input.agentName,
    sessionId: input.sessionId,
  });
  if (!completion) return false;
  const task = completion.task;
  if (failureOutput) {
    appendTaskMessageDedup(task.project_id, {
      task_id: task.id,
      role: 'assistant',
      content: failureOutput,
      agent_name: input.agentName,
      model_name: input.modelName,
      created_at: new Date().toISOString(),
    });
  }
  const errorMessage = appendTaskMessageDedup(task.project_id, {
    task_id: task.id,
    role: 'assistant',
    content: `Automatic stage-entry agent failed in \`${input.enteredStageId}\`: ${input.error}`,
    agent_name: input.agentName,
    model_name: input.modelName,
    created_at: new Date().toISOString(),
  });
  if (errorMessage) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: errorMessage,
      },
    });
  }
  await notifyEntityLifecycle({
    group_folder: task.project_id,
    task_id: task.id,
    run_id: input.runId ?? `stage-entry:${input.eventId}`,
    event: 'failed',
    title: `Stage-entry agent failed: ${task.title}`,
  });
  broadcast({
    type: 'task_error',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      error: input.error,
    },
  });
  return true;
}

/**
 * Save any accumulated turnOutput + "Stopped by user." stop notice.
 * Called from each abort-check point in executeTask so the transcript
 * shows the agent's work before the stop message.
 */
export function flushStoppedTranscript(
  project_id: string,
  task_id: string,
  turnOutput: string,
  agent_name: string | null,
  model_name: string | null,
  run_id: string | null,
) {
  if (turnOutput.trim()) {
    const outputMsg = appendTaskMessageDedup(project_id, {
      task_id: task_id,
      role: 'assistant',
      content: turnOutput,
      agent_name: agent_name,
      model_name: model_name,
      entry_type: 'run_result',
      run_id,
      created_at: new Date().toISOString(),
    });
    if (outputMsg) {
      broadcast({
        type: 'task_message',
        payload: { task_id, project_id, message: outputMsg },
      });
    }
  }
  // Append the stop notice *after* the agent output
  const stopMsg = appendTaskMessage(project_id, {
    task_id: task_id,
    role: 'assistant',
    content: 'Stopped by user.',
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: { task_id, project_id, message: stopMsg },
  });
}

// ---------------------------------------------------------------------------
// Main task execution
// ---------------------------------------------------------------------------

type QueueDrainTestDependencies = {
  runContainerAgent?: typeof runContainerAgent;
  prepareStageEntryEventIfOwned?: typeof prepareStageEntryEventIfOwned;
  executeTask?: (
    task: Task,
    group: RegisteredGroup,
    executionClaim: AbortController,
  ) => Promise<void>;
  executeStageEntryTask?: (
    task: Task,
    group: RegisteredGroup,
    eventId: string,
    executionClaim: AbortController,
  ) => Promise<void>;
  beforeNormalAdmission?: () => Promise<void>;
  runGitInRepo?: typeof runGitInRepo;
  ensureSandboxRunning?: () => Promise<void>;
  commitTaskBranch?: typeof commitTaskBranch;
};

/**
 * Execute a task by running the worker agent directly.
 *
 * The worker receives: shared worker prompt + stage prompt + task description.
 * System prompt is loaded from prompts/{group_folder}.md or prompts/default.md.

 */
export interface DependencyLineage {
  branch: string;
  commit: string;
}

export function taskSandboxGitRunner(
  task: Task,
  runGit: typeof runGitInRepo = runGitInRepo,
): typeof runGitInRepo {
  return (group, gitArgs) => {
    const effective = resolveEffectiveSandbox(group);
    return runGit(
      group,
      gitArgs,
      effectiveOperationInstance(
        effective,
        validatedInstance(task, group) ?? effective.instance,
      ),
    );
  };
}

export async function resolveGitCommitWithRetry(
  group: RegisteredGroup,
  ref: string,
  runGit: typeof runGitInRepo = runGitInRepo,
  wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<string> {
  let lastOutput = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runGit(group, `rev-parse --verify ${ref}^{commit}`);
    const commit = result.output.trim();
    if (result.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
      return commit;
    }
    lastOutput = result.output.trim();
    if (attempt < 2) await wait(100);
  }
  const detail = lastOutput ? `: ${lastOutput.slice(0, 500)}` : '';
  throw new Error(
    `Git ref ${ref} could not be resolved after 3 attempts${detail}`,
  );
}

/**
 * Resolve a completed dependency onto a target lineage. Ordinary merges retain
 * the recorded commit as an ancestor. A user may later rebase the default
 * branch, replacing those commit IDs while preserving every patch; `git
 * cherry` is the local, content-based proof for that case. Any missing patch
 * keeps the dependency unresolved.
 */
export async function resolveIntegratedDependencyCommit(
  group: RegisteredGroup,
  recordedCommit: string,
  targetCommit: string,
  runGit: typeof runGitInRepo = runGitInRepo,
  ownBaseCommit?: string,
): Promise<string | undefined> {
  const contained = await runGit(
    group,
    `merge-base --is-ancestor ${recordedCommit} ${targetCommit}`,
  );
  if (contained.ok) return recordedCommit;

  const allPatchesIntegrated = async (range: string): Promise<boolean> => {
    const cherry = await runGit(group, `cherry ${targetCommit} ${range}`);
    if (!cherry.ok) return false;
    const patches = cherry.output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      patches.length > 0 &&
      patches.every((line) => /^-\s+[0-9a-f]{40,64}$/i.test(line))
    );
  };

  if (await allPatchesIntegrated(recordedCommit)) return targetCommit;

  // A rebased default branch leaves the dependency's older pre-rebase history,
  // including other cards' commits, in the full-history range. Limit the proof
  // to the dependency's own commits when its merge-time base is known.
  if (!ownBaseCommit) return undefined;
  const baseIsAncestor = await runGit(
    group,
    `merge-base --is-ancestor ${ownBaseCommit} ${recordedCommit}`,
  );
  if (!baseIsAncestor.ok) return undefined;
  return (await allPatchesIntegrated(`${recordedCommit} ${ownBaseCommit}`))
    ? targetCommit
    : undefined;
}

export async function selectDependencyLineageBase(
  group: RegisteredGroup,
  defaultCommit: string,
  requiredDependencyCommits: readonly string[],
  lineages: readonly DependencyLineage[],
  runGit: typeof runGitInRepo = runGitInRepo,
  existingBranch?: DependencyLineage,
): Promise<{ branchBaseName?: string; branchBaseCommit: string }> {
  if (existingBranch) {
    const existingChecks = await Promise.all(
      requiredDependencyCommits.map(
        async (commit) =>
          (
            await runGit(
              group,
              `merge-base --is-ancestor ${commit} ${existingBranch.commit}`,
            )
          ).ok,
      ),
    );
    if (existingChecks.every(Boolean))
      return {
        branchBaseName: existingBranch.branch,
        branchBaseCommit: existingBranch.commit,
      };
  }
  const defaultChecks = await Promise.all(
    requiredDependencyCommits.map(
      async (commit) =>
        (
          await runGit(
            group,
            `merge-base --is-ancestor ${commit} ${defaultCommit}`,
          )
        ).ok,
    ),
  );
  if (defaultChecks.every(Boolean)) return { branchBaseCommit: defaultCommit };
  const matching: DependencyLineage[] = [];
  for (const candidate of lineages) {
    const checks = await Promise.all(
      requiredDependencyCommits.map(
        async (commit) =>
          (
            await runGit(
              group,
              `merge-base --is-ancestor ${commit} ${candidate.commit}`,
            )
          ).ok,
      ),
    );
    if (checks.every(Boolean)) matching.push(candidate);
  }
  let newest = matching[0];
  for (const candidate of matching.slice(1)) {
    if (!newest) {
      newest = candidate;
      continue;
    }
    const candidateContainsCurrent = (
      await runGit(
        group,
        `merge-base --is-ancestor ${newest.commit} ${candidate.commit}`,
      )
    ).ok;
    if (candidateContainsCurrent) {
      newest = candidate;
      continue;
    }
    const currentContainsCandidate = (
      await runGit(
        group,
        `merge-base --is-ancestor ${candidate.commit} ${newest.commit}`,
      )
    ).ok;
    if (!currentContainsCandidate) {
      throw new Error(
        'Dependencies have no single verified lineage; resolve the fan-in before starting this task',
      );
    }
  }
  if (newest) {
    return {
      branchBaseName: newest.branch,
      branchBaseCommit: newest.commit,
    };
  }
  throw new Error(
    'Dependencies have no single verified lineage; resolve the fan-in before starting this task',
  );
}

async function checkAbChildClash(
  task: Task,
  group: RegisteredGroup,
): Promise<{ source: string; detail: string } | null> {
  const parentId = task.ab_parent_task_id || (task as any).abParentTaskId;
  if (!parentId) return null;
  const parent = await getTask(parentId);
  const siblings = await getAbChildTasks(parentId);

  const childBranch =
    task.branch_name ||
    (taskUsesBranch(group) ? getBranchNameForTask(task) : undefined);
  const childWorktree =
    task.worktree_path ||
    (childBranch ? `.worktrees/${childBranch}` : undefined);

  if (parent) {
    if (
      childBranch &&
      parent.branch_name &&
      childBranch === parent.branch_name
    ) {
      return { source: 'parent', detail: `branch collision (${childBranch})` };
    }
    if (
      childWorktree &&
      parent.worktree_path &&
      (childWorktree === parent.worktree_path ||
        childWorktree.endsWith(parent.worktree_path) ||
        parent.worktree_path.endsWith(childWorktree))
    ) {
      return {
        source: 'parent',
        detail: `worktree collision (${childWorktree})`,
      };
    }
  }

  for (const sibling of siblings) {
    if (sibling.id === task.id) continue;
    const sibBranch =
      sibling.branch_name ||
      (taskUsesBranch(group) ? getBranchNameForTask(sibling) : undefined);
    const sibWorktree =
      sibling.worktree_path ||
      (sibBranch ? `.worktrees/${sibBranch}` : undefined);

    if (childBranch && sibBranch && childBranch === sibBranch) {
      return {
        source: `sibling ${sibling.id}`,
        detail: `branch collision (${childBranch})`,
      };
    }
    if (
      childWorktree &&
      sibWorktree &&
      (childWorktree === sibWorktree ||
        childWorktree.endsWith(sibWorktree) ||
        sibWorktree.endsWith(childWorktree))
    ) {
      return {
        source: `sibling ${sibling.id}`,
        detail: `worktree collision (${childWorktree})`,
      };
    }
  }

  return null;
}

const AB_WORKTREE_MODE_REQUIRED_MESSAGE =
  'A/B experiments require worktree task checkout mode with a configured local repository; the project no longer provides isolated worktrees.';

/** Experiment cards need real per-card worktrees, which require a local repo. */
function projectSupportsAbWorktrees(group: RegisteredGroup): boolean {
  return taskUsesWorktree(group) && isLocalRepoMode(group);
}

/** Fail-closed parking for experiment cards that must not run: move to Question. */
async function parkAbExperimentTask(
  task: Task,
  group: RegisteredGroup,
  content: string,
): Promise<void> {
  const stages = getGroupStages(group);
  const questionStage =
    stages.find((s) => isQuestionStage(stages, s.id))?.id || 'question';
  await updateTask(task.id, { status: questionStage });
  appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    content,
    created_at: new Date().toISOString(),
  });
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
}

export async function spawnAbVariants(
  parent: Task,
  forkStage: string,
  group: RegisteredGroup,
  runGit: typeof runGitInRepo = runGitInRepo,
  ensureSandbox?: () => Promise<void>,
  commitBranch: typeof commitTaskBranch = commitTaskBranch,
): Promise<Task[]> {
  if (parent.ab_fork_commit || (parent as any).abForkCommit) {
    return await getAbChildTasks(parent.id);
  }
  if (!projectSupportsAbWorktrees(group)) {
    await parkAbExperimentTask(
      parent,
      group,
      AB_WORKTREE_MODE_REQUIRED_MESSAGE,
    );
    return [];
  }

  const stages = getGroupStages(group);
  const firstExecStage = stages.find(
    (s) =>
      (s.type === 'active' || s.type === 'testing' || s.type === 'review') &&
      !s.inactive,
  )?.id;

  // Checkpointing and commit resolution both run Git inside the sandbox. A
  // later-stage fork can be claimed while the parent's sandbox is stopped (for
  // example after processing was paused at a review stage), so ensure it is up
  // before either fork path touches Git.
  if (ensureSandbox) {
    await ensureSandbox();
  } else if (runGit === runGitInRepo) {
    const effective = resolveEffectiveSandbox(group);
    await ensureSandboxRunning({
      group,
      stack: effective.stack,
      service: effective.service,
      instance: effective.instance,
      fixedInstance: effective.fixedInstance,
      inherited: effective.inherited,
      workspaceRoot: effective.workspaceRoot,
      extraRoots: effective.extraRoots,
    });
  }

  let forkCommit: string;
  if (forkStage === firstExecStage) {
    const defaultBranch = group.settings?.defaultBranch || 'develop';
    forkCommit = await resolveGitCommitWithRetry(group, defaultBranch, runGit);
  } else {
    if (parent.worktree_path) {
      const checkpointSuccess = await commitBranch(parent, group);
      if (!checkpointSuccess) {
        logger.error(
          { task_id: parent.id },
          'Failed to checkpoint parent worktree before A/B fork; aborting spawn',
        );
        throw new Error(
          'Failed to checkpoint parent task branch before spawning A/B variants',
        );
      }
    }
    forkCommit = await resolveGitCommitWithRetry(
      group,
      parent.branch_name || group.settings?.defaultBranch || 'develop',
      runGit,
    );
  }

  // The sandbox/Git work above awaited; re-check the mode before admitting.
  if (!projectSupportsAbWorktrees(group)) {
    await parkAbExperimentTask(
      parent,
      group,
      AB_WORKTREE_MODE_REQUIRED_MESSAGE,
    );
    return [];
  }
  // Compare-and-set against what this fork was planned from: a concurrent edit
  // (variants cleared, parent moved to a queue stage) must abort the fork.
  const children = await spawnAbVariantsInDb(parent, forkStage, forkCommit, {
    status: parent.status,
    variants: parent.ab_variants ?? (parent as any).abVariants ?? [],
  });
  if (children.length === 0) {
    logger.info(
      { task_id: parent.id, forkStage },
      'A/B fork skipped: parent changed or is no longer an eligible experiment',
    );
    return [];
  }

  const updatedParent = await getTask(parent.id);
  if (updatedParent) {
    broadcast({ type: 'task_updated', payload: updatedParent });
  }
  for (const child of children) {
    broadcast({ type: 'task_created', payload: child });
  }

  void drainProjectQueue(parent.project_id, group);
  return children;
}

/**
 * Park a review that ended without an approval or a rejection in the initial
 * queue stage. Review is executable, so leaving the task there would relaunch
 * the reviewer without limit.
 */
async function parkReviewWithoutDecision(input: {
  task: Task;
  stages: StageDefinition[];
  targetStatus: string;
  runId: string | null;
  notice: (manualStage: string) => string;
  changes?: Parameters<typeof updateTask>[1];
}): Promise<void> {
  const { task } = input;
  const manualStage = getInitialStage(input.stages)?.id ?? task.status;
  const transitioned = await updateTaskWithSteeringBarrier(
    task,
    input.targetStatus,
    { ...input.changes, status: manualStage },
  );
  if (transitioned) {
    const commentMsg = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'system_notice',
      content: input.notice(manualStage),
      created_at: new Date().toISOString(),
    });
    if (commentMsg) {
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: commentMsg,
        },
      });
    }
    const updated = await getTask(task.id);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
  }
  clearTaskStream(task.id, task.project_id, false, false, input.runId);
}

/** Describe reviewers that produced no valid decision, for the park notice. */
function reviewChainIncompleteNotice(
  failedReviewers: string[],
  manualStage: string,
): string {
  return `**Review incomplete** — ${failedReviewers.join(', ')} produced no valid decision, so the task was not approved. The task was paused in \`${manualStage}\` for manual inspection. Re-run the task to start the review again.`;
}

/**
 * Record one reviewer's verdict while more reviewers remain. The card stays in
 * the review stage and the queue launches the next reviewer; nothing is
 * merged or advanced until the last reviewer finished.
 */
async function continueReviewChain(input: {
  task: Task;
  targetStatus: string;
  chain: ReviewChain;
  verdict: ReviewChainVerdict;
  assistantContent: string;
  agent_name: string | null;
  model_name: string | null;
  sessionId?: string;
  runId: string | null;
  /** Terminal error of the reviewer run, when it produced no verdict. */
  failure?: string;
}): Promise<void> {
  const { task, targetStatus, chain, verdict } = input;
  const nextStage = nextReviewChainStage(chain);
  const append = (message: Parameters<typeof appendTaskMessage>[1]) => {
    const saved = appendTaskMessage(task.project_id, message);
    if (saved) {
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: saved,
        },
      });
    }
  };
  if (input.assistantContent.trim()) {
    append({
      task_id: task.id,
      role: 'assistant',
      content: input.assistantContent,
      agent_name: input.agent_name,
      model_name: input.model_name,
      entry_type: 'run_result',
      run_id: input.runId,
      created_at: new Date().toISOString(),
    });
  }
  append({
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content: `${formatReviewChainVerdict(verdict)}${input.failure ? `\n\nThe run failed: ${input.failure}` : ''}\n\nNext reviewer: \`${nextStage}\`. The task is decided after the last reviewer.`,
    created_at: new Date().toISOString(),
  });
  if (input.runId && verdict.score !== null) {
    await updateActiveRunReviewScore(input.runId, verdict.score);
  }
  markTaskFinalizing(task.id, targetStatus);
  const afterRunId = (await getLastActiveRunForTask(task.id))?.id ?? '';
  if (
    await runWithTaskSteeringBarrier(task, targetStatus, async () => {
      // Read inside the barrier so values written while it waited survive.
      const current = (await getTask(task.id)) ?? task;
      await updateTask(task.id, {
        custom_values: {
          ...(current.custom_values || {}),
          [REVIEW_CHAIN_KEY]: JSON.stringify({
            ...chain,
            after_run_id: afterRunId,
          }),
        },
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.agent_name ? { last_agent_name: input.agent_name } : {}),
      });
    })
  ) {
    logger.info(
      { task_id: task.id, decision: verdict.decision, nextStage },
      '[review] Reviewer verdict recorded — next reviewer will run',
    );
  }
  clearTaskStream(task.id, task.project_id, false, false, input.runId);
}

/**
 * Ends a review chain whose next extra reviewer could not start because the
 * checkout no longer matches the chain's commit. That reviewer and every one
 * after it count as having produced no decision (the same checkout would fail
 * them all); the card is then decided from the verdicts already recorded.
 */
async function finishReviewChainAfterGuardFailure(input: {
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  targetStatus: string;
  plan: Extract<ReviewChainPlan, { role: 'extra' }>;
  reason: string;
  runId: string | null;
  prepareRejection?: PrepareReviewRejection;
}): Promise<void> {
  const { task, group, stages, targetStatus, plan } = input;
  const { chain } = plan;
  const skipped = plan.stages.slice(chain.verdicts.length - 1);
  const verdicts: ReviewChainVerdict[] = [
    ...chain.verdicts,
    ...skipped.map((stageId) => ({
      stage_id: stageId,
      reviewer: stageId,
      decision: null,
      score: null,
      issues: [],
      summary: '',
    })),
  ];
  logger.warn(
    { task_id: task.id, reason: input.reason, skipped },
    '[review] Extra reviewer could not start — finishing the review chain without it',
  );
  const notice = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content: `**Extra reviewer not started** — ${input.reason}. Reviewer(s) ${skipped.join(', ')} were skipped and count as having given no decision.`,
    created_at: new Date().toISOString(),
  });
  if (notice) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: notice,
      },
    });
  }
  const outcome = await settleReviewChain({
    task,
    group,
    stages,
    targetStatus,
    chain: { ...chain, verdicts },
    runId: input.runId,
    prepareRejection: input.prepareRejection,
  });
  if (outcome.kind === 'incomplete') {
    await parkReviewWithoutDecision({
      task,
      stages,
      targetStatus,
      runId: input.runId,
      notice: (manualStage) =>
        reviewChainIncompleteNotice(outcome.failedReviewers, manualStage),
      changes: { custom_values: withoutReviewChain(await getTask(task.id)) },
    });
  }
}

/**
 * Decide the card from a finished chain's verdicts when a reviewer run ended
 * without a final verdict of its own (a failed or skipped reviewer). A
 * rejection by any reviewer is applied here; an outcome with no rejection and
 * a reviewer without a decision is returned for the caller to handle.
 */
async function settleReviewChain(input: {
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  targetStatus: string;
  chain: ReviewChain;
  runId: string | null;
  prepareRejection?: PrepareReviewRejection;
}): Promise<ReviewChainOutcome> {
  const { task, group, stages, targetStatus, chain } = input;
  const outcome = aggregateReviewChain(chain.verdicts);
  if (outcome.kind === 'incomplete') return outcome;
  // A rejection goes through the same first-rejection / progress comparison as
  // a reviewer's own verdict, so a missing reviewer decision never reads as
  // "no progress".
  const prepared =
    outcome.decision.decision === 'reject' && input.prepareRejection
      ? await input.prepareRejection({
          reviewDecision: outcome.decision,
          assistantContent: '',
          head: chain.head,
          reviewers: summarizeReviewerVerdicts(chain.verdicts),
        })
      : undefined;
  markTaskFinalizing(task.id, targetStatus);
  const nextActiveStage = getNextActiveStage(
    stages,
    targetStatus,
    task.skip_stages ?? undefined,
  );
  await handleReviewDecision(outcome.decision, {
    task,
    group,
    stages,
    targetStatus,
    completionStageId:
      nextActiveStage?.id ?? getDoneStage(stages)?.id ?? 'completed',
    assistantContent: '',
    agent_name: null,
    model_name: null,
    review_head_sha: chain.head,
    reviewer_verdicts: summarizeReviewerVerdicts(chain.verdicts),
    ...(prepared
      ? {
          rejection_comparison: prepared.rejectionComparison,
          rejection_comparison_attempted: true,
          rejection_feedback_persisted: true,
        }
      : {}),
    beforeTransition: (changes?: Parameters<typeof updateTask>[1]) =>
      updateTaskWithSteeringBarrier(task, targetStatus, changes ?? {}),
    runTransition: (operation) =>
      runWithTaskSteeringBarrier(task, targetStatus, operation),
  });
  await updateTaskWithSteeringBarrier(task, targetStatus, {});
  clearTaskStream(task.id, task.project_id, false, false, input.runId);
  return outcome;
}

/**
 * A reviewer run of a chain ended in a terminal error (its retries are
 * spent). Record it as a reviewer without a decision and keep the chain going:
 * later reviewers still run and the card is decided from what was recorded.
 * Resolves true when the chain took over; false when no reviewer rejected and
 * the caller should fail the task like any failed review run.
 */
async function recordReviewChainRunFailure(input: {
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  targetStatus: string;
  plan: ReviewChainPlan;
  startedAt: string;
  manual: boolean;
  head: string | undefined;
  reviewer: string;
  error: string;
  sessionId?: string;
  runId: string | null;
  prepareRejection?: PrepareReviewRejection;
}): Promise<boolean> {
  const { task, plan } = input;
  const verdict: ReviewChainVerdict = {
    stage_id: plan.role === 'extra' ? plan.stageId : input.targetStatus,
    reviewer: input.reviewer,
    decision: null,
    score: null,
    issues: [],
    summary: '',
  };
  const chain: ReviewChain = {
    head: plan.role === 'extra' ? plan.chain.head : (input.head ?? ''),
    started_at: input.startedAt,
    manual: plan.role === 'extra' ? plan.chain.manual : input.manual,
    after_run_id: '',
    stages: plan.stages,
    verdicts: [...(plan.role === 'extra' ? plan.chain.verdicts : []), verdict],
  };
  if (nextReviewChainStage(chain)) {
    await continueReviewChain({
      task,
      targetStatus: input.targetStatus,
      chain,
      verdict,
      assistantContent: '',
      agent_name: null,
      model_name: null,
      sessionId: input.sessionId,
      runId: input.runId,
      failure: input.error,
    });
    return true;
  }
  const outcome = await settleReviewChain({ ...input, chain });
  if (outcome.kind === 'decided') return true;
  await updateTask(task.id, {
    custom_values: withoutReviewChain(await getTask(task.id)),
  });
  return false;
}

/** The task's custom values without a finished or abandoned review chain. */
function withoutReviewChain(
  task: Task | undefined,
): Record<string, string | number> {
  return { ...(task?.custom_values || {}), [REVIEW_CHAIN_KEY]: '' };
}

/** Format one `git diff --numstat` line as ` path | +additions -deletions`. */
function formatNumstatLine(line: string): string {
  const [additions, deletions, ...filePath] = line.split('\t');
  return ` ${filePath.join('\t')} | +${additions === '-' ? 0 : additions} -${deletions === '-' ? 0 : deletions}`;
}

/**
 * Content-only numstat delta between the last rejected review round and the
 * current head, for the re-review prompt. Returns null when the delta cannot
 * be computed meaningfully — invalid or missing recorded commit, a rebase or
 * force-push since that round, the base branch merged in between, or any git
 * failure — so the review always proceeds, just without the delta.
 */
async function computeReReviewDelta(
  group: RegisteredGroup,
  runGit: typeof runGitInRepo,
  instance: string | undefined,
  wtPrefix: string,
  headRef: string,
  lastCommit: string,
  taskId: string,
): Promise<string | null> {
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(lastCommit)) return null;
    const ancestor = await runGit(
      group,
      `${wtPrefix}merge-base --is-ancestor ${lastCommit} ${headRef}`,
      instance,
    );
    if (!ancestor.ok) return null;
    const merges = await runGit(
      group,
      `${wtPrefix}rev-list --merges ${lastCommit}..${headRef}`,
      instance,
    );
    if (!merges.ok || merges.output.trim() !== '') return null;
    const numstat = await runGit(
      group,
      `${wtPrefix}diff --numstat ${lastCommit} ${headRef}`,
      instance,
    );
    if (!numstat.ok) return null;
    return numstat.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(formatNumstatLine)
      .join('\n');
  } catch (error) {
    logger.warn(
      {
        task_id: taskId,
        err: error instanceof Error ? error.message : String(error),
      },
      '[review] Re-review delta unavailable; continuing without it',
    );
    return null;
  }
}

export async function executeTask(
  task: Task,
  group: RegisteredGroup,
  options?: {
    freshSession?: boolean;
    freshSessionLatestPrompt?: string;
    executionClaim?: AbortController;
    admissionOwnerToken?: string;
    /** Explicit user execution may bypass isolated-task automatic capacity. */
    manualParallelismOverride?: boolean;
    /** Durable event identity for an automatic one-shot stage-entry run. */
    automaticStageEntryEventId?: string;
    restartRecovery?: RestartRecoveryExecutionIntent;
    triggerAttribution?: {
      triggeredByUserId: string | null;
      triggerSource: TriggerSource;
    };
    testDependencies?: {
      modelRoutingEngine?: ModelRoutingEngine;
      routeText?: typeof routeText;
      loadProviderUsage?: typeof loadProviderUsageAccounts;
      clearSessionBeforeFreshRun?: typeof clearSessionBeforeFreshRun;
      interceptAutoDeployExecution?: typeof interceptAutoDeployExecution;
      mergeBranchForDeploy?: typeof mergeBranchForDeploy;
      runContainerAgent?: typeof runContainerAgent;
      stopTaskBackgroundTask?: typeof stopTaskBackgroundTask;
      prepareStageEntryEventIfOwned?: typeof prepareStageEntryEventIfOwned;
      prepareTaskBranchForReview?: typeof prepareTaskBranchForReview;
      readTaskGitContentIdentity?: typeof readTaskGitContentIdentity;
      runGitInRepo?: typeof runGitInRepo;
      inspectTaskLinkedRepositories?: typeof inspectTaskLinkedRepositories;
      runPostExecutionGitOps?: typeof runPostExecutionGitOps;
      persistTaskSessionForActiveRun?: typeof persistTaskSessionForActiveRun;
      afterSuccessfulAgentRun?: () => Promise<void>;
      afterMessageAdmissionsSynchronized?: () => void;
      ensureSandboxRunning?: () => Promise<void>;
      commitTaskBranch?: typeof commitTaskBranch;
      drainProjectQueue?: (
        project_id: string,
        group: RegisteredGroup,
      ) => Promise<void>;
    };
  },
): Promise<void> {
  const automaticStageEntryEventId = options?.automaticStageEntryEventId;
  const automaticStageEntry = !!automaticStageEntryEventId;
  const restartRecovery = options?.restartRecovery;
  // Claim synchronously before the first await. Route-level isTaskRunning()
  // checks are asynchronous, so concurrent execute requests can both pass
  // them before either request reaches this shared execution boundary.
  const bypassesAutomaticCapacity =
    options?.manualParallelismOverride === true && taskUsesWorktree(group);
  const abort =
    options?.executionClaim ??
    claimTaskExecution(task.id, task.project_id, bypassesAutomaticCapacity);
  if (!abort) {
    logger.info(
      { task_id: task.id, project: task.project_id },
      'Ignoring duplicate task execution request',
    );
    return;
  }
  // A route may establish the duplicate-protection claim before executeTask is
  // invoked. Synchronize its capacity class at this shared execution boundary.
  const ownedClaim = claimedTasks.get(task.id);
  if (ownedClaim?.abort === abort) {
    ownedClaim.bypassesAutomaticCapacity = bypassesAutomaticCapacity;
  }
  // The execution claim closes the stage_variant update window (update_task
  // rejects variant edits while a claim exists). Re-read so a variant committed
  // between the caller's snapshot and this claim is honored by this run. The
  // task object is mutated in place: post-run consumers write back onto the
  // instance executeTask was handed.
  // A failed read must not strand the claim or a durable checkout admission:
  // this runs before preflight and the main finally, so release both
  // explicitly and surface the error to the caller (queue drain / manual run)
  // instead of blocking retries forever.
  let claimedTaskState: Awaited<ReturnType<typeof getTask>> = undefined;
  try {
    // A variant write that started before the claim may still be committing;
    // wait for it so the run reads the variant that actually persists. Writes
    // starting afterwards observe the claim and are rejected by their guard.
    await waitForStageVariantWrites(task.id);
    claimedTaskState = await getTask(task.id);
  } catch (err) {
    releaseTaskExecutionClaim(task.id, abort);
    await releaseTaskAdmission(
      task.project_id,
      task.id,
      options?.admissionOwnerToken,
    ).catch(() => {});
    throw err;
  }
  if (claimedTaskState) {
    // A queue snapshot may predate a completed start-over. Use the persisted
    // checkout, session and reset metadata after acquiring the claim.
    task.branch_name = claimedTaskState.branch_name;
    task.worktree_path = claimedTaskState.worktree_path;
    task.session_id = claimedTaskState.session_id;
    task.output = claimedTaskState.output;
    task.error = claimedTaskState.error;
    task.custom_values = claimedTaskState.custom_values;
    task.description = claimedTaskState.description;
    task.lastTriggeredByUserId = claimedTaskState.lastTriggeredByUserId;
    task.lastTriggerSource = claimedTaskState.lastTriggerSource;
    task.lastTriggeredAt = claimedTaskState.lastTriggeredAt;
    if (claimedTaskState.stageVariant !== task.stageVariant) {
      task.stageVariant = claimedTaskState.stageVariant;
    }
    // Same for the extra-reviewer list: a run uses the list persisted at claim.
    task.coStages = task.co_stages = claimedTaskState.coStages ?? null;
    // Experiment fields decide the fork, hub-skip and isolation guards below.
    // They can change between the caller's snapshot and this claim (the card
    // was moved to backlog and re-configured), so adopt the persisted values.
    task.ab_variants = task.abVariants = claimedTaskState.abVariants ?? null;
    task.ab_parent_task_id = task.abParentTaskId =
      claimedTaskState.abParentTaskId ?? null;
    task.ab_fork_commit = task.abForkCommit =
      claimedTaskState.abForkCommit ?? null;
  }

  let reviewHeadSha: string | undefined;
  let reviewTreeSha: string | undefined;
  // Set when an extra reviewer found the checkout no longer matching the
  // commit its chain started on; the run is then not launched.
  let reviewChainGuardFailure: string | undefined;
  let reviewChainPlan: ReviewChainPlan | undefined;
  // Conversation older than this is the review chain's shared input.
  let reviewChainStartedAt = new Date().toISOString();
  // Consumed once so a failing finish falls through to the generic failure path.
  const finishGuardedReviewChain = async (): Promise<boolean> => {
    const reason = reviewChainGuardFailure;
    reviewChainGuardFailure = undefined;
    if (!reason || reviewChainPlan?.role !== 'extra') return false;
    await finishReviewChainAfterGuardFailure({
      task,
      group,
      stages,
      targetStatus,
      plan: reviewChainPlan,
      reason,
      runId: executionRunId,
      prepareRejection: prepareReviewRejection,
    });
    return true;
  };
  // Extra testers (`co_stages`): the run's role, and the reason an extra tester
  // found the checkout no longer matching the content its chain started on.
  let testingChainPlan: TestingChainPlan | undefined;
  let testingChainGuardFailure: string | undefined;
  // Consumed once. Not testing this content counts as one failed test round.
  const finishGuardedTestingChain = async (): Promise<boolean> => {
    const reason = testingChainGuardFailure;
    testingChainGuardFailure = undefined;
    if (!reason || testingChainPlan?.role !== 'extra') return false;
    const stageEntryEventRef: StageEntryEventRef = {};
    await handleTestingDecision(
      {
        decision: 'fail',
        issues: [reason],
        summary: `Extra tester ${testingChainPlan.stageId} was not started.`,
      },
      {
        task,
        group,
        stages,
        targetStatus,
        assistantContent: '',
        agent_name,
        model_name,
        runId: executionRunId ?? undefined,
        stageEntryEventRef,
        beforeTransition: (changes?: Parameters<typeof updateTask>[1]) =>
          updateTaskWithSteeringBarrier(
            task,
            targetStatus,
            changes ?? {},
            stageEntryEventRef,
          ),
      },
    );
    clearTaskStream(task.id, task.project_id, false, false, executionRunId);
    return true;
  };
  // Set once the run's auxiliary-run helpers exist (inside the main try).
  let prepareReviewRejection: PrepareReviewRejection | undefined;
  // The round's manual-admission policy, kept for its extra reviewers.
  let reviewChainManual = false;
  // Terminal failure of a chain reviewer: keep the chain going (see helper).
  const continueReviewChainAfterFailure = (
    error: string,
    sessionId?: string,
  ): Promise<boolean> =>
    reviewChainPlan
      ? recordReviewChainRunFailure({
          task,
          group,
          stages,
          targetStatus,
          plan: reviewChainPlan,
          startedAt: reviewChainStartedAt,
          manual: reviewChainManual,
          prepareRejection: prepareReviewRejection,
          head: reviewHeadSha,
          reviewer: model_name || agent_name || targetStatus,
          error,
          sessionId,
          runId: executionRunId,
        })
      : Promise.resolve(false);
  let testingVerifyBaseSha: string | undefined;
  let postExecutionGitOpsHandled = false;
  let testingInspectedIdentity: TaskGitContentIdentity | undefined;
  let reviewDeferredAtSlot = false;
  // Task view that includes the checkout the runner prepared for this run.
  let checkoutTask: Task = task;

  // Resolve stages for this project
  const stages = getGroupStages(group);

  // Find the first active stage to move into
  const activeStage = getFirstExecutableStage(stages);

  // If the task is already in an executable stage, don't override it.
  // This prevents tasks from being moved back to another active stage
  // when manually dragged from backlog to an active stage
  const currentStage = findStage(stages, task.status);
  const targetStatus = automaticStageEntry
    ? task.status
    : currentStage?.type === 'active' ||
        currentStage?.type === 'testing' ||
        currentStage?.type === 'review'
      ? task.status
      : (activeStage?.id ?? task.status);
  const claimedStatus = task.status;
  const deferTaskActivation =
    !automaticStageEntry &&
    taskUsesBranch(group) &&
    (task.depends_on_ids?.length ?? 0) > 0;
  taskExecutionStartingStages.set(task.id, targetStatus);
  // Testing output from an earlier run (transient retry, stop, or early
  // return) must not leak into this run's saved or partial output.
  testingRawBuffers.delete(task.id);
  testingVerdictRuns.delete(task.id);

  // A/B preflight (forked-parent skip, isolation guard, fork). Every awaited
  // step here runs after the claim and starting-stage marker were installed but
  // before the main try/finally, so any exit path, including a throw from the
  // clash check, the Question parking or the stage-entry receipt resolution,
  // must release them or the project's slot stays blocked until restart.
  let abPreflightReleased = false;
  const releaseAbPreflight = async (): Promise<void> => {
    abPreflightReleased = true;
    try {
      if (automaticStageEntryEventId) {
        await resolveStageEntryEvent(automaticStageEntryEventId);
      }
    } finally {
      releaseTaskExecutionClaim(task.id, abort);
      taskExecutionStartingStages.delete(task.id);
      await releaseTaskAdmission(
        task.project_id,
        task.id,
        options?.admissionOwnerToken,
      ).catch(() => {});
    }
  };
  const drainAfterAbPreflight = (): void => {
    const drain =
      options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
    void drain(task.project_id, group);
  };
  let abForkInProgress = false;
  try {
    if (task.ab_fork_commit || (task as any).abForkCommit) {
      logger.info(
        { task_id: task.id, project: task.project_id },
        'Ignoring execution request for forked A/B experiment parent',
      );
      await releaseAbPreflight();
      drainAfterAbPreflight();
      return;
    }

    const abViolation = !isAbExperimentTask(task)
      ? null
      : !projectSupportsAbWorktrees(group)
        ? AB_WORKTREE_MODE_REQUIRED_MESSAGE
        : isAbExperimentChild(task)
          ? await checkAbChildClash(task, group).then((clash) =>
              clash
                ? `Execution aborted: worktree or branch clashes with ${clash.source}: ${clash.detail}`
                : null,
            )
          : null;
    if (abViolation) {
      logger.error(
        { task_id: task.id, violation: abViolation },
        'A/B experiment execution blocked; moving to question',
      );
      await parkAbExperimentTask(task, group, abViolation);
      await releaseAbPreflight();
      drainAfterAbPreflight();
      return;
    }

    if (isAbExperimentParent(task)) {
      const forkStage = computeAbForkStage(
        group,
        task.ab_variants ?? (task as any).abVariants,
      );
      if (forkStage && targetStatus === forkStage) {
        logger.info(
          { task_id: task.id, forkStage },
          'Forking A/B experiment parent at divergence stage',
        );
        // Resolve the stage-entry receipt only once the fork succeeded. A
        // throw falls through to the catch below, which persists the failure
        // (or schedules the retry) and releases the claim, starting stage and
        // admission exactly once.
        // Pause, Stop or recovery may have cancelled this execution while it
        // awaited preflight reads. Never fork under a superseded claim. Once
        // started, Git cannot be cancelled safely, so retain the reservation
        // until the whole fork and its cleanup settle.
        const forkClaim = claimedTasks.get(task.id);
        if (
          forkClaim?.abort !== abort ||
          abort.signal.aborted ||
          stoppingTasks.has(task.id)
        ) {
          await releaseAbPreflight();
          return;
        }
        forkClaim.forking = true;
        abForkInProgress = true;
        await spawnAbVariants(
          task,
          forkStage,
          group,
          options?.testDependencies?.runGitInRepo ?? runGitInRepo,
          options?.testDependencies?.ensureSandboxRunning,
          options?.testDependencies?.commitTaskBranch ?? commitTaskBranch,
        );
        await releaseAbPreflight();
        drainAfterAbPreflight();
        return;
      }
    }
  } catch (err) {
    if (!abPreflightReleased) {
      abPreflightReleased = true;
      try {
        if (automaticStageEntryEventId) {
          releaseTaskExecutionClaim(task.id, abort);
          await persistAutomaticStageEntryFailure({
            eventId: automaticStageEntryEventId,
            task,
            enteredStageId: targetStatus,
            error: err instanceof Error ? err.message : String(err),
            output: '',
            agentName: null,
            modelName: null,
            runId: null,
          });
        } else {
          await settleAbPreflightFailure(
            task,
            abort,
            group,
            claimedStatus,
            err,
          );
        }
      } finally {
        taskExecutionStartingStages.delete(task.id);
        await releaseTaskAdmission(
          task.project_id,
          task.id,
          options?.admissionOwnerToken,
        ).catch(() => {});
      }
    }
    // The claim is released: let the queue move past the failed fork.
    if (abForkInProgress) drainAfterAbPreflight();
    throw err;
  }

  // A task-message request can have observed this task as idle immediately
  // before the claim above was installed. Wait for every admission that was
  // already open at claim time so its canonical ordinary message is durable
  // before this run reads the transcript. Admissions opened after the claim
  // observe the claim and use the existing steering/pending path instead.
  if (ownedClaim?.abort === abort) {
    await ownedClaim.messageAdmissionBarrier;
  }
  options?.testDependencies?.afterMessageAdmissionsSynchronized?.();

  try {
    // Human-triggered runs and the continuation of an already admitted run
    // bypass the per-task cost limit; everything else is automatic. A human
    // moving the card into an executable stage is dispatched by the queue or
    // stage-entry path without attribution, so also honor the persisted
    // trigger metadata when it postdates the card's last run.
    const automaticRun =
      options?.triggerAttribution?.triggerSource !== 'user' &&
      options?.manualParallelismOverride !== true &&
      !restartRecovery &&
      !(
        task.lastTriggerSource === 'user' &&
        isManualReviewRun(task, await getLastActiveRunForTask(task.id))
      );
    if (await enforceTaskCostLimit(task, group, { automatic: automaticRun })) {
      if (automaticStageEntryEventId) {
        await resolveStageEntryEvent(automaticStageEntryEventId);
      }
      releaseTaskExecutionClaim(task.id, abort);
      taskExecutionStartingStages.delete(task.id);
      await releaseTaskAdmission(
        task.project_id,
        task.id,
        options?.admissionOwnerToken,
      );
      const drain =
        options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
      void drain(task.project_id, group);
      return;
    }
    if (automaticStageEntryEventId) {
      const prepared = await (
        options?.testDependencies?.prepareStageEntryEventIfOwned ??
        prepareStageEntryEventIfOwned
      )(automaticStageEntryEventId);
      if (!prepared) {
        releaseTaskExecutionClaim(task.id, abort);
        taskExecutionStartingStages.delete(task.id);
        const drain =
          options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
        void drain(task.project_id, group);
        return;
      }
    } else if (!deferTaskActivation) {
      // Move ordinary manual execution into its active target and clear stale
      // output. Entry execution never relocates the task during preflight.
      await updateTask(
        task.id,
        {
          status: targetStatus,
          error: '',
          output: '',
        },
        { suppressStageEntryEvent: true },
      );
    }
    broadcast({
      type: 'task_updated',
      payload: { task_id: task.id, project_id: task.project_id },
    });
  } catch (err) {
    // The claim is created before this pre-flight DB write so concurrent queue
    // drains cannot double-start the task. This invocation never reaches the
    // main finally block, so explicitly release its claim.
    if (automaticStageEntryEventId) {
      releaseTaskExecutionClaim(task.id, abort);
      const error = err instanceof Error ? err.message : String(err);
      await persistAutomaticStageEntryFailure({
        eventId: automaticStageEntryEventId,
        task,
        enteredStageId: targetStatus,
        error,
        output: '',
        agentName: null,
        modelName: null,
        runId: null,
      });
    } else {
      handlePreflightFailure(task.id, abort, task.project_id, group);
    }
    await releaseTaskAdmission(
      task.project_id,
      task.id,
      options?.admissionOwnerToken,
    );
    taskExecutionStartingStages.delete(task.id);
    throw err;
  }

  // Accumulate output for this turn so we can store it as an assistant message
  let turnOutput = '';
  let executionRunId: string | null = null;
  let taskStartedRunId: string | null = null;

  // Agent name shown in chat: resolved before try/catch so catch block can access it
  let agent_name: string | null = null;
  // Model name for chat attribution: set after agent run returns
  let model_name: string | null = null;

  let execFailed = false;
  // A transient retry or provider-login hold was scheduled: the run is
  // neither a success nor a failure for the project failure breaker.
  let transientRetryScheduled = false;
  // A manual run that never launched: neither counts as a failure nor proves
  // the project healthy, so the failure breaker stays as it is.
  let uncountedPreLaunchFailure = false;
  let deployIntercepted = false;
  let restartHandoffCompleted = false;
  let taskCheckoutLease: SharedCheckoutLease | undefined;
  let taskLeaseHeartbeat: NodeJS.Timeout | undefined;
  let mergeParked = false;
  let mergeConflict = false;
  try {
    if (!taskUsesWorktree(group)) {
      taskCheckoutLease = await acquireSharedCheckoutLease(
        task.project_id,
        {
          type: 'task',
          id: task.id,
        },
        { signal: abort.signal },
      );
      // Git inspection must happen after runContainerAgent has confirmed that
      // the sandbox service is running. A cold branch/shared sandbox cannot
      // answer sandbox_git yet; treating that transport error as checkout
      // drift prevents the runner from ever reaching its auto-start path.
      if (!taskUsesBranch(group) && task.branch_name) {
        const reconciled = await (
          options?.testDependencies?.mergeBranchForDeploy ??
          mergeBranchForDeploy
        )(task, group, 'completion', undefined, { leaseAlreadyHeld: true });
        if (!reconciled) {
          const current = (await getTask(task.id)) ?? task;
          if (isActiveStage(stages, current.status)) {
            mergeConflict = true;
            throw new Error(
              `Conflict between retained branch ${current.branch_name ?? task.branch_name} and the default branch must be resolved manually`,
            );
          }
          mergeParked = true;
          throw new Error('Prior task branch reconciliation parked the task');
        }
        task = (await getTask(task.id)) ?? task;
      } else if (task.worktree_path) {
        await removeWorktreeForTask(task, group, {
          force: true,
          leaseAlreadyHeld: true,
          throwOnError: true,
        });
        await updateTask(task.id, { worktree_path: null });
        task = { ...task, worktree_path: null };
      }
      taskLeaseHeartbeat = setInterval(() => {
        void taskCheckoutLease?.heartbeat();
      }, 10_000);
    }
  } catch (error) {
    releaseTaskExecutionClaim(task.id, abort);
    await releaseTaskAdmission(
      task.project_id,
      task.id,
      options?.admissionOwnerToken,
    );
    clearInterval(taskLeaseHeartbeat);
    await taskCheckoutLease
      ?.release()
      .catch((releaseError) =>
        logger.warn(
          { error: String(releaseError), task_id: task.id },
          'Failed to release task checkout lease after preflight failure',
        ),
      );
    taskExecutionStartingStages.delete(task.id);
    if (mergeParked) {
      // No entry agent ran; the merge handler's non-executable parking
      // decision owns this attempt.
      if (automaticStageEntryEventId) {
        await resolveStageEntryEvent(automaticStageEntryEventId);
      }
      void (options?.testDependencies?.drainProjectQueue ?? drainProjectQueue)(
        task.project_id,
        group,
      ).catch((drainError) =>
        logger.error(
          { error: String(drainError), task_id: task.id },
          'Failed to drain project queue after parked merge',
        ),
      );
      return;
    }
    // Without a visible failure the task would stay unclaimed in its active
    // stage and every later drain would re-pick it and fail the same way.
    // The stage-entry caller fails the receipt, not the card. Conflicts must
    // fail the card too, before that caller drains the queue again. Other
    // stage-entry errors, restart recovery and user aborts own their state.
    if (
      (!automaticStageEntryEventId || mergeConflict) &&
      !restartRecovery &&
      !abort.signal.aborted
    ) {
      const message = error instanceof Error ? error.message : String(error);
      const failedStatus = getFailedStage(stages)?.id ?? 'failed';
      const recordFailureError = (markError: unknown) =>
        logger.error(
          { error: String(markError), task_id: task.id },
          'Failed to record shared-checkout preflight failure',
        );
      let failedTask: Task | undefined;
      let failedStageEntryEventId: string | undefined;
      try {
        const failedStageEntryEvent = await updateTask(task.id, {
          status: failedStatus,
          error: message,
        });
        failedStageEntryEventId = failedStageEntryEvent?.id;
        failedTask = { ...task, status: failedStatus };
      } catch (markError) {
        recordFailureError(markError);
      }
      if (failedTask) {
        // The card is already in Failed; a read or broadcast failure must not
        // skip the publication below.
        try {
          const updated = await getTask(task.id);
          if (updated) {
            failedTask = updated;
            broadcast({ type: 'task_updated', payload: updated });
          }
        } catch (markError) {
          recordFailureError(markError);
        }
      }
      if (failedTask) {
        try {
          await publishExecutionFailure(
            failedTask,
            group,
            message,
            nextPreflightFailureRunId(task.id),
            failedStageEntryEventId,
          );
        } catch (publishError) {
          logger.error(
            { error: String(publishError), task_id: task.id },
            'Failed to publish shared-checkout preflight failure',
          );
        }
      }
    }
    if (!automaticStageEntryEventId) {
      void (options?.testDependencies?.drainProjectQueue ?? drainProjectQueue)(
        task.project_id,
        group,
      ).catch((drainError) =>
        logger.error(
          { error: String(drainError), task_id: task.id },
          'Failed to drain project queue after preflight failure',
        ),
      );
    }
    throw error;
  }
  try {
    const settings = group.settings;
    const maxParallel = effectiveMaxParallel(settings);
    // Ordinary execution in the deploy stage is intercepted by the deploy
    // pipeline. An automatic stage-entry run must instead execute that stage's
    // configured one-shot agent before any later handoff can deploy.
    if (
      !automaticStageEntry &&
      (await (
        options?.testDependencies?.interceptAutoDeployExecution ??
        interceptAutoDeployExecution
      )(task, group, targetStatus, stages))
    ) {
      // Deploy handling already left the task in its authoritative stage, so
      // never continue with the stale deploy target.
      deployIntercepted = true;
      return;
    }

    const enteringReview =
      !automaticStageEntry && isReviewStage(stages, targetStatus);
    const enteringTesting =
      !automaticStageEntry && isTestingStage(stages, targetStatus);
    const testingVerdictRun = enteringTesting;
    const lastRun = await getLastActiveRunForTask(task.id);
    const manualReviewTrigger =
      enteringReview && isManualReviewRun(task, lastRun);
    // A review stage with extra reviewers (`co_stages`) runs them one after the
    // other on the same commit. This run is either the stage's own runtime
    // (primary) or the next extra reviewer of a chain already in progress,
    // which continues only directly after a review-stage run of this task.
    if (enteringReview && !isAbExperimentParent(task)) {
      const storedChain = readReviewChain(
        ((await getTask(task.id)) ?? task).custom_values,
      );
      reviewChainPlan = planReviewChain(
        resolveCoReviewStages(group, task, targetStatus),
        storedChain,
        // A manual click continues a chain still in progress (nothing ran
        // since its last reviewer); it starts over only when none is.
        storedChain?.after_run_id !== (lastRun?.id ?? ''),
      );
    }
    // A testing stage with extra testers (`co_stages`) runs them one after the
    // other on the same content, each only after the previous one passed. This
    // run is either the stage's own runtime (primary) or the next extra tester
    // of a chain that continues only directly after its own last run.
    if (enteringTesting && !isAbExperimentParent(task)) {
      const storedChain = readTestingChain(
        ((await getTask(task.id)) ?? task).custom_values,
      );
      testingChainPlan = planTestingChain(
        resolveCoTestingStages(group, task, targetStatus),
        storedChain,
        storedChain?.after_run_id !== (lastRun?.id ?? ''),
      );
    }
    // An extra reviewer inherits the manual admission of the round's primary
    // run: its own trigger timestamp is older than that run's start.
    const manualReviewRun =
      manualReviewTrigger ||
      (reviewChainPlan?.role === 'extra' && reviewChainPlan.chain.manual);
    reviewChainManual = manualReviewRun;
    // An extra reviewer or tester judges independently of the stage's own run.
    const extraChainStageId =
      reviewChainPlan?.role === 'extra'
        ? reviewChainPlan.stageId
        : testingChainPlan?.role === 'extra'
          ? testingChainPlan.stageId
          : undefined;
    const extraChainRun = extraChainStageId !== undefined;
    if (reviewChainPlan?.role === 'extra') {
      reviewChainStartedAt = reviewChainPlan.chain.started_at;
    }
    const extraChainStartedAt =
      testingChainPlan?.role === 'extra'
        ? testingChainPlan.chain.started_at
        : reviewChainStartedAt;

    // Resolve the materialized worker runtime from structured selections only.
    // The task's stage variant (A when unset) overrides the base stage's run config.
    // Experiment-parent prefixes run against the base variant regardless of an existing selection.
    // An extra reviewer runs as its stage alternative.
    const effectiveVariant = isAbExperimentParent(task)
      ? 'a'
      : extraChainStageId
        ? extraChainStageId.slice(extraChainStageId.indexOf('.') + 1)
        : (task.stageVariant ?? task.stage_variant);
    const runStage = resolveStageForTask(group, targetStatus, effectiveVariant);
    const stageOwner =
      !group.settings?.stages?.length && group.parentId
        ? (groupResolver?.(group.parentId) ?? group)
        : group;
    const stageSpecificPrompt = runStage?.id
      ? loadStagePrompt(
          stageOwner.folder,
          stageOwner.parentId,
          runStage.id,
          // An alternative prompt applies only while that alternative is still
          // configured. A removed `coding.b` leaves `stage-coding.b.md` behind,
          // and a B task on base coding must not pick up the obsolete prompt.
          hasStageAlternative(group, runStage.id, effectiveVariant)
            ? effectiveVariant
            : undefined,
        )
      : undefined;
    const personaPrompt = await resolveStagePersonaPrompt(
      runStage?.mainAiUserId,
      { taskId: task.id, stageId: runStage?.id },
    );
    const effectiveStageSpecificPrompt = composeStageSpecificPrompt(
      stageSpecificPrompt,
      personaPrompt,
    );
    const projectWorkerPrompt = loadGroupWorkerPrompt(
      group.folder,
      group.parentId,
    );
    const stageWorkerPrompt = composeWorkerPrompts(
      projectWorkerPrompt,
      effectiveStageSpecificPrompt,
    );
    const resolvedRuntime = resolveKanbanRuntimeSelection(
      [
        // The task's own override would make an extra reviewer repeat the
        // stage's primary runtime instead of its alternative's. A stage-scoped
        // override applies only to its one base stage.
        extraChainRun ||
        (task.runtimeSelectionStage &&
          task.runtimeSelectionStage !== targetStatus)
          ? undefined
          : (task.runtimeSelection ?? undefined),
        runStage?.runtimeSelection,
        settings?.kanbanRuntimeSelection ?? undefined,
      ],
      targetStatus,
      runStage?.type,
    );
    // A review chain starting with this primary run drops every extra
    // reviewer whose effective runtime is identical to this run's: the same
    // model on the same commit twice is cost, not a second opinion. Decided
    // only here, at chain start; a chain already in progress keeps the stage
    // list frozen into it.
    if (reviewChainPlan?.role === 'primary') {
      const { kept, skipped } = partitionCoReviewStagesByRuntime(
        reviewChainPlan.stages,
        resolvedRuntime.selection,
        (stageId) => {
          // An extra reviewer runs as its stage alternative and, like the
          // extra-run runtime rule above, without the task's own override.
          const extraStage = resolveStageForTask(
            group,
            targetStatus,
            stageId.slice(stageId.indexOf('.') + 1),
          );
          return resolveKanbanRuntimeSelection(
            [
              undefined,
              extraStage?.runtimeSelection,
              settings?.kanbanRuntimeSelection ?? undefined,
            ],
            targetStatus,
            extraStage?.type,
          ).selection;
        },
      );
      if (skipped.length > 0) {
        reviewChainPlan =
          kept.length > 0 ? { role: 'primary', stages: kept } : undefined;
        const notice = appendTaskMessage(task.project_id, {
          task_id: task.id,
          role: 'system',
          entry_type: 'system_notice',
          content: skipped
            .map(
              ({ stageId, runtime }) =>
                `Skipped extra reviewer ${stageId}: same runtime as the primary reviewer (${runtime}).`,
            )
            .join('\n'),
          created_at: new Date().toISOString(),
        });
        if (notice) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: notice,
            },
          });
        }
      }
    }
    // An Auto selection is routed only when this run starts a fresh session
    // (decided below). Until then it runs as the model recorded for this stage
    // (what a continuing session or restart recovery must keep), else balanced.
    const autoSelection = isAutoSelection(resolvedRuntime.selection)
      ? resolvedRuntime.selection
      : undefined;
    const routingTask = autoSelection
      ? ((await getTask(task.id)) ?? task)
      : task;
    // An extra reviewer never inherits the routing pinned for the stage's own runtime.
    const storedRouting =
      autoSelection && !extraChainRun
        ? readStageRouting(routingTask.custom_values, targetStatus)
        : undefined;
    // The stored routing names the runtime a resumed session ran on. It can stop
    // resolving once that candidate is disabled, which is fatal only when this
    // run resumes the session (decided below); a fresh run routes again.
    let storedRuntimeError: { error: unknown } | undefined;
    let agentConfig = resolvedRuntime.agent;
    if (autoSelection && storedRouting) {
      try {
        agentConfig = resolveRuntimeSelection(
          resolveAutoPinnedSelection(autoSelection, {
            ...storedRouting,
            // Records written before routing recorded a harness ran on the selection's.
            harnessId: storedRouting.harnessId ?? autoSelection.harnessId,
          }),
        );
      } catch (error) {
        storedRuntimeError = { error };
      }
    }
    let workerAgentCmd = agentConfig.agentCmd || agentConfig.id;

    const workerSandbox =
      runStage?.workerSandbox || settings?.defaultSandbox || undefined;
    const effectiveSandbox = resolveEffectiveSandbox(group);
    const effectiveWorkerStack = effectiveRunSandboxStack(
      effectiveSandbox,
      workerSandbox,
    );

    // Detect agent change: if the resolved agent differs from the last one that ran,
    // we need to clear the session (can't --resume across different agents) and
    // include the full chat history in the prompt so the new agent has context.
    let resolvedAgentName = runtimeSessionKey(agentConfig);
    let agentChanged =
      !!task.last_agent_name && task.last_agent_name !== resolvedAgentName;

    // Per-stage session continuity.
    // `task.session_id` is the "live cursor": the session of the most recent run,
    // persisted the instant it is observed (so it survives stops/interrupts).
    // Start over (reset=true) clears it to force a fresh start.
    //   - Same stage as the live session  → resume `task.session_id` (interrupt-safe;
    //     the current stage's session is the live cursor even if the run was stopped).
    //   - A different stage (e.g. moving into review) → resume that stage's OWN last
    //     session from Run History; if none, start fresh. This prevents replaying
    //     another stage's transcript, which fails Anthropic `thinking` signature
    //     validation on --resume.
    const enteringImplementation =
      !automaticStageEntry && runStage?.type === 'active' && !runStage.inactive;
    const liveSessionStage = lastRun?.stage ?? null;
    const forceFreshSession = options?.freshSession === true;
    const transientRetry =
      claimedTasks.get(task.id)?.transientRetry === true && !!storedRouting;
    // Resuming needs the runtime the session ran on; a fresh run routes again.
    const resumesStoredSession =
      !forceFreshSession &&
      !extraChainRun &&
      !automaticStageEntry &&
      !!task.session_id &&
      (enteringImplementation || liveSessionStage === targetStatus);
    // A stored runtime that no longer resolves is fatal only when this run would
    // really resume that runtime's session. That mirrors agentChanged: the task's
    // last agent is the stored session agent, and the newest session in this
    // stage belongs to it. Any other run is a new session and reroutes below. A
    // record without a session agent key cannot prove ownership, so its resumed
    // session fails closed.
    if (storedRuntimeError) {
      const storedKey = storedRouting?.sessionAgentKey;
      const resumesOwnedSession =
        resumesStoredSession &&
        (!storedKey ||
          ((!task.last_agent_name || task.last_agent_name === storedKey) &&
            (await getLastStageSessionOwner(task.id, targetStatus)) ===
              storedKey));
      if (restartRecovery || transientRetry || resumesOwnedSession)
        throw storedRuntimeError.error;
    }
    const restartSessionOwnerCompatible = restartRecovery
      ? restartRecovery.sessionAgentKey === resolvedAgentName
      : false;
    if (
      restartRecovery &&
      (automaticStageEntry ||
        forceFreshSession ||
        runStage?.type !== 'active' ||
        targetStatus !== restartRecovery.stageId ||
        !restartRecovery.sessionId.trim() ||
        !restartSessionOwnerCompatible ||
        restartRecovery.sandboxStack !== effectiveWorkerStack ||
        restartRecovery.sandboxService !== effectiveSandbox.service ||
        (!!restartRecovery.sandboxInstance &&
          restartRecovery.sandboxInstance !== effectiveSandbox.instance) ||
        lastRun?.id !== restartRecovery.continuationRunId)
    ) {
      throw new Error(
        `Restart recovery no longer owns task ${task.id} stage/runtime`,
      );
    }
    let effectiveSessionId: string | undefined;
    if (restartRecovery) {
      effectiveSessionId = restartRecovery.sessionId;
    } else if (
      automaticStageEntry ||
      forceFreshSession ||
      extraChainRun ||
      agentChanged ||
      storedRuntimeError
    ) {
      // An extra reviewer judges independently: never the stage's own session.
      effectiveSessionId = undefined;
    } else if (enteringImplementation) {
      // Every concrete active stage owns its own native session. Run History is
      // authoritative here, including when a temporary queue stage (Question)
      // or a Testing/Review run is the task's most recent run. The live cursor
      // remains an explicit reset gate, but never supplies the session itself.
      if (task.session_id) {
        effectiveSessionId = await getLastRunSessionForStage(
          task.id,
          targetStatus,
          [resolvedAgentName],
        );
      }
    } else if (!task.session_id) {
      effectiveSessionId = undefined;
    } else if (liveSessionStage === targetStatus) {
      effectiveSessionId = task.session_id;
    } else if (
      shouldStartFreshTestingSession(
        enteringTesting,
        liveSessionStage,
        targetStatus,
      )
    ) {
      // Re-entering testing after implementation changed the worktree must
      // never reuse a prior pass/fail context. Start a new tester that has to
      // inspect and execute validation against the current revision.
      effectiveSessionId = undefined;
    } else if (
      shouldStartFreshReviewSession(
        enteringReview,
        liveSessionStage,
        targetStatus,
      )
    ) {
      // Re-entering review after active/fix — prior review session is stale.
      effectiveSessionId = undefined;
    } else {
      effectiveSessionId = await getLastRunSessionForStage(
        task.id,
        targetStatus,
        [resolvedAgentName],
      );
    }

    // The provider cache is cold on a fresh session, so this is the only point
    // where an Auto selection is routed (or reset to balanced when routing is
    // off). A continuing or recovered session keeps the model it started with.
    // A transient-error retry never changes the model.
    if (
      autoSelection &&
      !restartRecovery &&
      !effectiveSessionId &&
      !transientRetry
    ) {
      const routingEngine =
        options?.testDependencies?.modelRoutingEngine ?? MODEL_ROUTING_ENGINE;
      // Routing off records a decision only when the stage's minTier raises it.
      const routing = await decideStageRouting({
        task: routingTask,
        stageId: targetStatus,
        selection: autoSelection,
        minTier: runStage?.minTier,
        providerUsage: await (
          options?.testDependencies?.loadProviderUsage ??
          loadProviderUsageAccounts
        )(),
        route:
          routingEngine === 'jev'
            ? (text) =>
                (options?.testDependencies?.routeText ?? routeText)(text, {
                  projectId: task.project_id,
                })
            : null,
      });
      // The record holds the candidate chosen within the tier, which may not
      // be the tier's first.
      agentConfig = resolveRuntimeSelection(
        routing
          ? resolveAutoPinnedSelection(autoSelection, {
              ...routing,
              harnessId: routing.harnessId ?? autoSelection.harnessId,
            })
          : resolveAutoSelection(autoSelection, null),
      );
      workerAgentCmd = agentConfig.agentCmd || agentConfig.id;
      resolvedAgentName = runtimeSessionKey(agentConfig);
      agentChanged =
        !!task.last_agent_name && task.last_agent_name !== resolvedAgentName;
      // The record names the session agent this run starts. An unrouted fresh
      // run drops any earlier pin recorded for this stage.
      if (routing || storedRouting)
        await persistStageRouting(
          routingTask,
          targetStatus,
          routing && { ...routing, sessionAgentKey: resolvedAgentName },
        );
    }

    // Privacy mode: park instead of launching a run on a remote runtime. A
    // restart-recovery continuation is judged by the runContainerAgent backstop.
    if (!restartRecovery) {
      try {
        assertRuntimeAllowed({
          projectId: task.project_id,
          purpose: 'agent',
          runtime: agentConfig,
        });
      } catch (error) {
        if (!(error instanceof PrivacyRefusal)) throw error;
        await parkTaskForPrivacyRefusal(task, group, error);
        if (automaticStageEntryEventId) {
          await resolveStageEntryEvent(automaticStageEntryEventId);
        }
        return;
      }
    }

    // We have prior context but are deliberately NOT resuming (stage transition).
    // Fold the full chat history into the prompt so the fresh session has context.
    const stageChangedFresh =
      !automaticStageEntry &&
      !forceFreshSession &&
      !agentChanged &&
      !effectiveSessionId &&
      !!task.session_id;

    logger.info(
      {
        task_id: task.id,
        session_id: task.session_id || null,
        last_agent_name: task.last_agent_name || null,
        resolvedAgentName,
        targetStatus,
        liveSessionStage,
        agentChanged,
        stageChangedFresh,
        willResume: !!effectiveSessionId,
        forceFreshSession,
      },
      forceFreshSession
        ? 'Fresh task session requested — starting without session continuation'
        : agentChanged
          ? 'Agent changed — session continuation skipped'
          : stageChangedFresh
            ? 'Stage changed — starting a fresh session for the new stage'
            : effectiveSessionId
              ? 'Session found — will attempt to resume'
              : 'No session — starting fresh',
    );

    if (forceFreshSession || agentChanged || stageChangedFresh) {
      // Clear the live cursor so a crash before the new session is observed
      // doesn't fall back to resuming the previous stage's session. The previous
      // stage's session is still recoverable from its own Run History record.
      await (
        options?.testDependencies?.clearSessionBeforeFreshRun ??
        clearSessionBeforeFreshRun
      )(task.id, true);
      logger.info(
        {
          task_id: task.id,
          reason: forceFreshSession
            ? 'fresh_session_requested'
            : agentChanged
              ? 'agent_changed'
              : 'stage_changed',
          from: task.last_agent_name,
          to: resolvedAgentName,
        },
        forceFreshSession
          ? 'Cleared session_id — will start fresh with continuation context'
          : 'Cleared session_id — will start fresh and include full chat history',
      );
    }

    let workerPrompt = task.description?.trim() || task.title;
    // A rejection is persisted in review_history, but the next active run may
    // resume the coding session with no new user message. Inject the latest
    // issues and comparison reason into that run's prompt.
    if (findStage(stages, targetStatus)?.type === 'active') {
      const reviewFeedback = buildReviewReworkPrompt(
        readReviewHistory(task.custom_values),
      );
      if (reviewFeedback) workerPrompt = `${workerPrompt}\n\n${reviewFeedback}`;

      // Hand off only the most recent Testing run's evidence. Run-prefixed
      // filenames make this independent of older recordings retained for UI
      // history, and a missing/deleted recording produces no prompt text.
      const testingStageIds = stages
        .filter((stage) => stage.type === 'testing' && !stage.inactive)
        .map((stage) => stage.id);
      const previousTestingRun = await getLastRunForStages(
        task.id,
        testingStageIds,
      );
      if (previousTestingRun) {
        const recordingDir = path.join(
          getGroupDir(task.project_id),
          'recordings',
          `task-${task.id}`,
        );
        const recording = findRunRecording(recordingDir, previousTestingRun.id);
        if (recording) {
          const handoff = buildTestingRecordingHandoff(
            `/workspace/group/recordings/task-${task.id}/${recording}`,
          );
          workerPrompt = `${workerPrompt}\n\n${handoff}`;
        }
      }
    }
    // Keep the generated review handoff out of the user bubble. It is an
    // execution instruction, while the persisted review summary remains the
    // readable source of truth in the transcript.
    let userPromptForTranscript = task.description?.trim() || task.title;
    // When true, skip appending a user message to the transcript. This applies
    // both to pure session continuations and to prompts assembled from messages
    // that are already persisted in the transcript.
    let skipUserTranscript = false;
    // Fallback prompt for session-not-found retry: includes full history so the agent has context
    let workerFallbackBase: string | undefined;

    // Read the task transcript once and split off any un-addressed follow-up
    // messages (user/system entries after the last assistant turn). The resume
    // and fresh-stage paths use the same split so the follow-up is the new
    // message and Previous Conversation never includes it twice.
    // An extra reviewer gets the same input the primary had (including the
    // Testing run's conversation) but none of the chain's own review output.
    const allMessages = readTaskMessages(task.project_id, task.id).filter(
      (message) =>
        !extraChainRun ||
        isVisibleToExtraReviewer(message, extraChainStartedAt),
    );
    const split = splitFollowUpsFromHistory(allMessages);
    // A Testing run rechecks the current checkout. Earlier verdicts, which
    // coding runs still need, would only become precedent for it. Split on
    // the full transcript first so prompts a verdict already answered are not
    // presented again as new input.
    const testingRunIds = isTestingStage(stages, targetStatus)
      ? new Set(
          (await getRunsForTask(task.id, 500))
            .filter((run) => isTestingStage(stages, run.stage ?? ''))
            .map((run) => run.id),
        )
      : undefined;
    const omitPriorVerdicts = <T extends VerdictCandidate>(items: T[]) =>
      testingRunIds ? omitTestingVerdicts(items, testingRunIds) : items;
    const newUserMessages = omitPriorVerdicts(split.newUserMessages);
    const historyForFold = omitPriorVerdicts(split.historyForFold);
    const pendingStagePrompts = getPendingStagePrompts(
      allMessages,
      targetStatus,
    );
    const pendingSteeringMessages = getPendingTaskDeliveryPrompts(
      allMessages,
      targetStatus,
    );
    const persistentStageComment = await getTaskStageComment(
      task.id,
      targetStatus,
    );
    const newInputIds = new Set([
      ...newUserMessages.map((message) => message.id),
      ...pendingStagePrompts.map((message) => message.id),
    ]);
    // Preserve canonical transcript order when ordinary follow-ups and
    // stage-addressed prompts are both pending.
    const newInputMessages = allMessages.filter((message) =>
      newInputIds.has(message.id),
    );
    // A steering prompt can be appended after the task is claimed but before
    // its first process has acquired a slot. In that case there is no native
    // session or folded transcript carrying the original task yet. Keep the
    // task bootstrap in this first prompt and append the canonical steering
    // messages; later continuations still send only their new input because
    // their session or folded history already owns the task context.
    const needsTaskBootstrap =
      !effectiveSessionId &&
      historyForFold.length === 0 &&
      newInputMessages.some((message) => message.steering === true);
    const taskBootstrap = needsTaskBootstrap
      ? [task.title, task.description?.trim()].filter(Boolean).join('\n\n')
      : '';
    const newContent = [
      taskBootstrap,
      ...newInputMessages.map((message) => message.content),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (newInputMessages.length > 0) {
      skipUserTranscript = true;
    }

    // When resuming a session, use new user messages (added after the last run) as the prompt
    // instead of repeating the original description.
    if (effectiveSessionId) {
      if (newInputMessages.length > 0) {
        workerPrompt = newContent;
        userPromptForTranscript = newContent;
        logger.info(
          {
            task_id: task.id,
            newMessageCount: newInputMessages.length,
            stagePromptCount: pendingStagePrompts.length,
          },
          'Resuming session with new user messages as prompt',
        );

        // Build a fallback prompt that includes the full conversation history so the agent
        // has context if the session is not found (e.g. after a board app restart).
        if (historyForFold.length > 0) {
          const historyText = formatFoldedHistory(historyForFold);
          workerFallbackBase = `## Previous Conversation\n\n${historyText}\n\n## New Message\n\n${newContent}`;
        } else {
          workerFallbackBase = newContent;
        }
      } else {
        // Pure continuation: no new user input — don't add a duplicate description bubble
        skipUserTranscript = true;
      }
    }

    // A resumed session already received its stage instructions when it was
    // created. Send only the new handoff on resume; keep stage instructions
    // for genuinely fresh runs and the session-not-found fallback below.
    let { workerPrompt: fullWorkerPrompt, fallbackPrompt: fullFallbackPrompt } =
      composeStageRunPrompts(
        stageWorkerPrompt,
        workerPrompt,
        workerFallbackBase,
        !!effectiveSessionId,
      );
    // When starting fresh despite prior context (agent change or stage transition),
    // prepend the conversation history so the fresh session has context.
    // If un-addressed follow-ups exist, they become the "New Message" (and the
    // original description is NOT repeated); otherwise we fall back to the
    // description as the New Message with the full transcript as history.
    if (
      extraChainRun ||
      agentChanged ||
      stageChangedFresh ||
      // A fresh run can have no resumable session (expired/reset/legacy task)
      // while still having an unaddressed handoff. In that case the handoff,
      // not the original task description, is the new message.
      (!effectiveSessionId && newInputMessages.length > 0)
    ) {
      if (newInputMessages.length > 0) {
        const historyText = formatFoldedHistory(historyForFold);
        // The stage worker prompt carries stage-specific instructions for the
        // NEW stage. Mirror the no-follow-up path (and the resume path) by
        // embedding it in the New Message section so the new agent starts
        // with its stage prompt — never the previous stage's transcript.
        fullWorkerPrompt = buildFreshStageHistoryPrompt(
          historyText,
          stageWorkerPrompt,
          newContent,
        );
        userPromptForTranscript = newContent;
        logger.info(
          {
            task_id: task.id,
            newMessageCount: newInputMessages.length,
            stagePromptCount: pendingStagePrompts.length,
          },
          'Fresh-stage run surfacing follow-up as new message',
        );
      } else if (allMessages.length > 0) {
        const historyText = formatFoldedHistory(omitPriorVerdicts(allMessages));
        fullWorkerPrompt = `## Previous Conversation\n\n${historyText}\n\n## New Message\n\n${fullWorkerPrompt}`;
      }
    }

    if (forceFreshSession) {
      const continuationPrompt = buildFreshSessionContinuationPrompt(
        workerPrompt,
        options?.freshSessionLatestPrompt,
      );
      fullWorkerPrompt = stageWorkerPrompt
        ? `${stageWorkerPrompt}\n\n${continuationPrompt}`
        : continuationPrompt;
      fullFallbackPrompt = undefined;
      // The latest user prompt is already persisted. Keep the synthesized
      // bootstrap payload out of the visible task conversation.
      skipUserTranscript = true;
    }

    if (restartRecovery) {
      fullWorkerPrompt = RESTART_RECOVERY_PROMPT;
      fullFallbackPrompt = undefined;
      // This is Board-generated execution control, not a user-authored task
      // message. The run marker and eventual assistant result stay visible.
      skipUserTranscript = true;
    }

    if (enteringTesting) {
      fullWorkerPrompt = buildTestingValidationPrompt(fullWorkerPrompt);
      if (fullFallbackPrompt) {
        fullFallbackPrompt = buildTestingValidationPrompt(fullFallbackPrompt);
      }
    }
    fullWorkerPrompt = appendPersistentStageNote(
      fullWorkerPrompt,
      persistentStageComment?.content,
    );
    if (fullFallbackPrompt) {
      fullFallbackPrompt = appendPersistentStageNote(
        fullFallbackPrompt,
        persistentStageComment?.content,
      );
    }
    if (enteringReview) {
      fullWorkerPrompt = appendReviewVerdictFormatBlock(fullWorkerPrompt);
      if (fullFallbackPrompt) {
        fullFallbackPrompt = appendReviewVerdictFormatBlock(fullFallbackPrompt);
      }
    }

    // `modelId` identifies the logical catalog entry. The provider-facing
    // model comes from that same binding and may intentionally be omitted.
    const workerModel = agentConfig.model;
    const workerRuntimeVariant = persistentVariantTag(
      workerAgentCmd,
      workerModel,
      agentConfig.env,
      task.worktree_path || undefined,
    );

    if (
      restartRecovery &&
      (restartRecovery.model !== (workerModel ?? null) ||
        restartRecovery.runtimeVariant !== workerRuntimeVariant)
    ) {
      throw new Error(
        `Restart recovery no longer owns task ${task.id} model/runtime variant`,
      );
    }

    // --- Worker Phase ---
    // Persist the provider-aware runtime identity that owns the native session;
    // the launcher still receives workerAgentCmd as the executable.
    agent_name = resolvedAgentName;

    let workerSystemPrompt = loadSystemPrompt(group.folder, group.parentId);
    // Append dynamic task management instructions based on project stages.
    // Entry agents also receive an explicit one-shot resolution/handoff contract.
    const taskMgmtPrompt =
      buildTaskManagementPrompt(
        stages,
        group.settings?.custom_values,
        targetStatus,
      ) +
      (automaticStageEntry
        ? buildAutomaticStageEntryPrompt(stages, targetStatus)
        : '');
    // A passing Testing run performs post-run Git cleanup and one final
    // preparation before binding its evidence, while Review repeats preflight
    // to catch later changes. Initial preparation is deferred until the runner
    // has started the sandbox and restored the requested checkout.
    const nextStageAfterTesting = enteringTesting
      ? getNextActiveStage(stages, targetStatus, task.skip_stages ?? undefined)
      : undefined;

    if (enteringReview) {
      // The review lifecycle and JSON response schema are board-owned. Project
      // review criteria remain in the separately composed stage worker prompt.
      workerSystemPrompt =
        loadReviewPrompt({
          testingStagePresent: stages.some(
            (stage) => stage.type === 'testing' && !stage.inactive,
          ),
        }) + taskMgmtPrompt;
    } else if (enteringTesting) {
      // Testing owns no task lifecycle tools. Its only contract is a structured
      // verdict consumed below, so deliberately omit taskMgmtPrompt.
      workerSystemPrompt = loadTestingPrompt();
    } else {
      workerSystemPrompt = (workerSystemPrompt || '') + taskMgmtPrompt;
    }

    // An extra reviewer judges the exact commit its chain started on. A moved
    // HEAD, or a dirty tree (no identity), fails the run before the agent
    // launches; it never counts as a verdict.
    const assertExtraReviewerCheckout = (headSha: string | undefined): void => {
      if (reviewChainPlan?.role !== 'extra') return;
      const expected = reviewChainPlan.chain.head;
      if (headSha && headSha === expected) return;
      reviewChainGuardFailure = !headSha
        ? 'the task worktree has uncommitted changes or its HEAD could not be read'
        : expected
          ? `the task branch HEAD moved from ${expected.slice(0, 7)} to ${headSha.slice(0, 7)}`
          : 'the first reviewer recorded no commit to compare against';
      throw new Error(`Extra reviewer not started: ${reviewChainGuardFailure}`);
    };

    // An extra tester tests the exact commit and tree its chain started on. A
    // moved HEAD, changed tree or dirty tree (no identity) fails the run before
    // the agent launches; it never counts as a pass.
    const assertExtraTesterCheckout = (
      identity: TaskGitContentIdentity | undefined,
      clean: boolean,
    ): void => {
      if (testingChainPlan?.role !== 'extra') return;
      const { head, tree } = testingChainPlan.chain;
      if (
        clean &&
        identity &&
        identity.headSha === head &&
        identity.treeSha === tree
      ) {
        return;
      }
      testingChainGuardFailure =
        !identity || !clean
          ? 'the task worktree has uncommitted changes or its HEAD could not be read'
          : identity.headSha !== head
            ? `the task branch HEAD moved from ${head.slice(0, 7)} to ${identity.headSha.slice(0, 7)}`
            : 'the task content changed since the previous tester';
      throw new Error(`Extra tester not started: ${testingChainGuardFailure}`);
    };

    // Build testing/review Git context only after the runner confirms the
    // sandbox service and task checkout are available. This callback executes
    // before the active run is recorded or the agent is launched.
    const prepareStageCheckout = async (
      readyInput: ContainerInput,
    ): Promise<void> => {
      // A freshly forked A/B child has no persisted branch/worktree until the
      // runner creates them, so inspect the prepared checkout, not the stale
      // task row (which would resolve to the default checkout).
      checkoutTask = {
        ...task,
        branch_name: task.branch_name || readyInput.branch_name || null,
        worktree_path: task.worktree_path || readyInput.worktree_path || null,
      };
      // An extra reviewer or tester must find the checkout exactly as its chain
      // started: checkpointing here would commit whatever a previous one left.
      if (
        !extraChainRun &&
        (enteringReview || nextStageAfterTesting?.type === 'review')
      ) {
        await (
          options?.testDependencies?.prepareTaskBranchForReview ??
          prepareTaskBranchForReview
        )(checkoutTask, group);
      }

      // Give testing and review the complete cross-repository file inventory.
      if (enteringTesting || enteringReview) {
        const runGit = options?.testDependencies?.runGitInRepo ?? runGitInRepo;
        const baseBranch = group.settings?.defaultBranch || 'develop';
        const instance = validatedInstance(checkoutTask, group);
        const branchMode = group.settings?.taskCheckoutMode === 'branch';
        const usesWorktree =
          !!checkoutTask.branch_name &&
          (taskUsesWorktree(group) || !!checkoutTask.worktree_path);
        const wtPrefix = usesWorktree
          ? `-C .worktrees/${checkoutTask.branch_name} `
          : '';
        const headRef =
          usesWorktree || !branchMode
            ? 'HEAD'
            : checkoutTask.branch_name || 'HEAD';
        const [mergeBaseRes, untrackedRes] = await Promise.all([
          runGit(
            group,
            `${wtPrefix}merge-base ${baseBranch} ${headRef}`,
            instance,
          ),
          usesWorktree
            ? runGit(
                group,
                `${wtPrefix}ls-files --others --exclude-standard`,
                instance,
              )
            : Promise.resolve({ ok: true, output: '' }),
        ]);
        const mergeBase = mergeBaseRes.ok
          ? mergeBaseRes.output.trim().split('\n')[0]
          : '';
        if (
          enteringTesting &&
          /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeBase)
        ) {
          testingVerifyBaseSha = mergeBase;
        }
        const baseRef = COMMIT_SHA_PATTERN.test(mergeBase)
          ? mergeBase
          : baseBranch;
        const statRes = await runGit(
          group,
          `${wtPrefix}diff --numstat ${baseRef} ${headRef}`,
          instance,
        );
        const linked = await (
          options?.testDependencies?.inspectTaskLinkedRepositories ??
          inspectTaskLinkedRepositories
        )(checkoutTask, group);
        const mainFiles = (statRes.ok ? statRes.output : '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map(formatNumstatLine);
        const trackedPaths = new Set(
          mainFiles.map((line) => line.trim().split(' | ')[0]),
        );
        const untrackedFiles = (untrackedRes.ok ? untrackedRes.output : '')
          .split('\n')
          .map((path) => path.trim())
          .filter((path) => path && !trackedPaths.has(path))
          .map((path) => ` ${path} | untracked`);
        const linkedFiles = linked.repositories
          .map((repo) => {
            const lines = repo.files.map(
              (file) => ` ${file.path} | +${file.additions} -${file.deletions}`,
            );
            return [
              `linked repository ${repo.name} (${repo.branch} vs ${repo.base})`,
              ...lines,
            ].join('\n');
          })
          .join('\n\n');
        const inventory = [
          'main repository',
          ...mainFiles,
          ...untrackedFiles,
          linkedFiles,
        ]
          .filter(Boolean)
          .join('\n');
        // On a re-review, give the reviewer the earlier rejected rounds plus
        // the main-repo delta since the last rejected round. Any failure to
        // compute the delta just omits it; the review always starts.
        let reReview: ReReviewContext | undefined;
        if (enteringReview) {
          const reviewHistory = readReviewHistory(checkoutTask.custom_values);
          if (reviewHistory.length > 0) {
            reReview = {
              history: reviewHistory,
              delta: await computeReReviewDelta(
                group,
                runGit,
                instance,
                wtPrefix,
                headRef,
                reviewHistory[reviewHistory.length - 1]?.commit ?? '',
                task.id,
              ),
              stageId:
                reviewChainPlan?.role === 'extra'
                  ? reviewChainPlan.stageId
                  : targetStatus,
              hasExtraReviewers: reviewChainPlan !== undefined,
            };
          }
        }
        const gitContext = enteringReview
          ? buildReviewGitContextBlock(baseBranch, inventory, reReview)
          : [
              '## Task change inventory',
              '',
              'This snapshot lists changes across the main repository and linked repositories.',
              'Use it to scope testing, but inspect the live files and run the relevant tests yourself.',
              '',
              '```',
              inventory.trim() || '(no changes vs base)',
              '```',
            ].join('\n');
        fullWorkerPrompt = `${gitContext}\n\n${fullWorkerPrompt}`;
        if (fullFallbackPrompt) {
          fullFallbackPrompt = `${gitContext}\n\n${fullFallbackPrompt}`;
        }
      }
      if (enteringReview) {
        const reviewIdentity = await (
          options?.testDependencies?.readTaskGitContentIdentity ??
          readTaskGitContentIdentity
        )(
          checkoutTask,
          group,
          options?.testDependencies?.runGitInRepo ?? runGitInRepo,
        );
        reviewHeadSha = reviewIdentity?.headSha;
        reviewTreeSha = reviewIdentity?.treeSha;
        assertExtraReviewerCheckout(reviewIdentity?.headSha);
      }

      if (
        enteringReview &&
        !manualReviewRun &&
        !(await ensureReviewHasCurrentTestingEvidence(
          checkoutTask,
          group,
          stages,
          targetStatus,
          reviewHeadSha,
          reviewTreeSha,
          options?.testDependencies?.runGitInRepo ?? runGitInRepo,
        ))
      ) {
        reviewDeferredAtSlot = true;
        logger.info(
          {
            task_id: task.id,
            review_head_sha: reviewHeadSha,
            review_tree_sha: reviewTreeSha,
          },
          '[review] Current tracked content lacks matching Testing evidence; returning task to Testing',
        );
        throw new ReviewDeferredError(
          'Review deferred because Testing evidence does not match the prepared checkout',
        );
      }

      readyInput.prompt = fullWorkerPrompt;
      readyInput.fallbackPrompt = fullFallbackPrompt;
      if (testingVerifyBaseSha) {
        readyInput.env = {
          ...readyInput.env,
          CARAPA_VERIFY_BASE_SHA: testingVerifyBaseSha,
        };
      }
    };

    // Load agent rules (priority: worktree -> repo -> group folder)
    const baseDir =
      task.worktree_path ||
      group.settings?.repositoryLocation ||
      path.join(GROUPS_DIR, group.folder);
    const rules = loadAgentRules(baseDir);
    if (rules) {
      workerSystemPrompt = (workerSystemPrompt || '') + rules;
    }

    // Resolve branch name and base for the selected checkout mode
    const branch_name = taskUsesBranch(group)
      ? getBranchNameForTask(task)
      : undefined;

    // When running in a worktree, append a hint so models use relative paths
    // (which resolve from the worktree CWD) instead of constructing absolute
    // paths to the main repo root — which would edit develop, not the branch.
    if (branch_name && task.worktree_path && workerSystemPrompt) {
      workerSystemPrompt +=
        '\n\n## CRITICAL: Working directory\n\n' +
        'You are working in a **git worktree** on a dedicated branch.\n' +
        'Your CWD is already the project root — all source files are here.\n' +
        '**You MUST use relative paths** (e.g. `src/foo.ts`, not `/workspace/.../src/foo.ts`) ' +
        'for ALL file operations (Read, Edit, Write, Glob, Grep).\n' +
        'Using absolute paths will edit the WRONG copy of the code and your changes will be lost.\n';
    }
    // If this task depends on another, try to branch from the dependency's
    // branch so it includes the dependency's changes. But only if that branch
    // still exists — it may have been merged+deleted already, in which case
    // its changes are on develop and we should branch from there instead.
    const resolveDependencyCheckout = async () => {
      const forkCommit =
        task.ab_fork_commit ??
        (task.ab_parent_task_id
          ? (await getTask(task.ab_parent_task_id))?.ab_fork_commit
          : undefined);
      if (forkCommit) {
        return {
          branchBaseName: undefined,
          branchBaseCommit: forkCommit,
          requiredDependencyCommits: [] as string[],
        };
      }
      if (!taskUsesBranch(group) || !task.depends_on_ids?.length) {
        return {
          branchBaseName: undefined,
          branchBaseCommit: undefined,
          requiredDependencyCommits: [] as string[],
        };
      }
      const defaultBranch = group.settings?.defaultBranch || 'develop';
      // Every dependency/ref lookup belongs to this task's sandbox instance.
      // Omitting the instance makes CarapaBox target the stack template, whose
      // agent service may legitimately be stopped even while the task's
      // project instance is healthy.
      const dependencyGit = taskSandboxGitRunner(
        task,
        options?.testDependencies?.runGitInRepo ?? runGitInRepo,
      );
      const defaultCommit = await resolveGitCommitWithRetry(
        group,
        defaultBranch,
        dependencyGit,
      );
      const existingBranchHead = task.branch_name
        ? await dependencyGit(
            group,
            `rev-parse --verify ${task.branch_name}^{commit}`,
          )
        : undefined;
      const requiredDependencyCommits: string[] = [];
      const dependencyByCommit: Record<string, { id: string; title: string }> =
        {};
      const lineages: Array<{ branch: string; commit: string }> = [];
      for (const depId of task.depends_on_ids) {
        const declaredDepTask = await getTask(depId);
        if (!declaredDepTask)
          throw new Error(`Dependency ${depId} no longer exists`);
        // Remember which dependency each required commit came from so a
        // missing-commit launch error can name it.
        const requireCommit = (commit: string) => {
          requiredDependencyCommits.push(commit);
          dependencyByCommit[commit] ??= {
            id: depId,
            title: declaredDepTask.title,
          };
        };
        // An A/B experiment parent has no branch or commit of its own; its
        // content is the picked winner's, which was merged to the default
        // branch. Resolve the checkout lineage through that winner.
        const depTask = declaredDepTask.ab_winner_task_id
          ? ((await getTask(declaredDepTask.ab_winner_task_id)) ??
            declaredDepTask)
          : declaredDepTask;
        const currentValues = depTask.custom_values ?? {};
        const currentDependencyCommit =
          typeof currentValues.testing_head_sha === 'string'
            ? currentValues.testing_head_sha
            : typeof currentValues.completed_commit_sha === 'string'
              ? currentValues.completed_commit_sha
              : undefined;
        // The tested/completed task commit is the durable content identity.
        // A later merge can legitimately reconstruct the default branch and
        // omit an older merge-wrapper commit while retaining that content
        // commit. Prefer the content identity regardless of whether cleanup
        // has already cleared branch_name; merge_commit is a legacy fallback.
        const recordedDependencyCommit =
          currentDependencyCommit ?? depTask.merge_commit;
        const recordedOwnBase = currentValues.task_diff_base_sha;
        const dependencyOwnBase =
          typeof recordedOwnBase === 'string' &&
          COMMIT_SHA_PATTERN.test(recordedOwnBase)
            ? recordedOwnBase
            : undefined;
        if (depTask.branch_name) {
          const resolved = await dependencyGit(
            group,
            `rev-parse --verify ${depTask.branch_name}^{commit}`,
          );
          if (resolved.ok) {
            const branchHead = resolved.output.trim();
            let requiredCommit = branchHead;
            if (recordedDependencyCommit) {
              const recordedResolved = await dependencyGit(
                group,
                `rev-parse --verify ${recordedDependencyCommit}^{commit}`,
              );
              if (!recordedResolved.ok)
                throw new Error(
                  `Dependency ${depId} recorded completion commit is unresolved`,
                );
              const integratedCommit = await resolveIntegratedDependencyCommit(
                group,
                recordedResolved.output.trim(),
                branchHead,
                dependencyGit,
                dependencyOwnBase,
              );
              if (!integratedCommit)
                throw new Error(
                  `Dependency ${depId} branch no longer contains its recorded completion commit`,
                );
              requiredCommit = integratedCommit;
            }
            requireCommit(requiredCommit);
            lineages.push({ branch: depTask.branch_name, commit: branchHead });
            continue;
          }
          if (!recordedDependencyCommit)
            throw new Error(
              `Dependency ${depId} branch is unresolved and has no recorded merge commit`,
            );
          const mergeResolved = await dependencyGit(
            group,
            `rev-parse --verify ${recordedDependencyCommit}^{commit}`,
          );
          if (!mergeResolved.ok)
            throw new Error(`Dependency ${depId} merge commit is unresolved`);
          const mergeCommit = mergeResolved.output.trim();
          const integratedCommit = await resolveIntegratedDependencyCommit(
            group,
            mergeCommit,
            defaultCommit,
            dependencyGit,
            dependencyOwnBase,
          );
          if (!integratedCommit)
            throw new Error(
              `Dependency ${depId} merge commit is not contained in ${defaultBranch}`,
            );
          requireCommit(integratedCommit);
          continue;
        }
        if (!recordedDependencyCommit)
          throw new Error(`Dependency ${depId} has no resolved commit`);
        const resolved = await dependencyGit(
          group,
          `rev-parse --verify ${recordedDependencyCommit}^{commit}`,
        );
        if (!resolved.ok)
          throw new Error(`Dependency ${depId} merge commit is unresolved`);
        const commit = resolved.output.trim();
        const integratedCommit = await resolveIntegratedDependencyCommit(
          group,
          commit,
          defaultCommit,
          dependencyGit,
          dependencyOwnBase,
        );
        if (!integratedCommit)
          throw new Error(
            `Dependency ${depId} commit is not contained in ${defaultBranch}`,
          );
        requireCommit(integratedCommit);
      }
      const selectedBase = await selectDependencyLineageBase(
        group,
        defaultCommit,
        requiredDependencyCommits,
        lineages,
        dependencyGit,
        existingBranchHead?.ok && task.branch_name
          ? {
              branch: task.branch_name,
              commit: existingBranchHead.output.trim(),
            }
          : undefined,
      );
      return {
        ...selectedBase,
        requiredDependencyCommits,
        dependencyByCommit,
      };
    };
    // Worktree creation happens inside mcp-runner after the sandbox is confirmed running.
    const localRepo = isLocalRepoMode(group)
      ? (group.settings?.repositoryLocation ??
        effectiveSandbox.hostWorkspaceLocation)
      : undefined;
    const worktreeFiles = isLocalRepoMode(group)
      ? group.settings?.worktreeFiles
      : undefined;

    type WorkerInputBase = Omit<
      ContainerInput,
      | 'prompt'
      | 'fallbackPrompt'
      | 'onCheckoutReady'
      | 'onSlotAcquired'
      | 'onActiveRunCreated'
      | 'onRunLaunched'
      | 'onPromptRunAssigned'
      | 'onPromptRunAccepted'
    >;
    const workerInputBase: WorkerInputBase = {
      session_id: effectiveSessionId,
      group_folder: group.folder,
      chat_jid: `task-${task.id}@kanban`,
      isMain: false,
      model: workerModel,
      privacyRuntime: agentConfig,
      fallback_model: agentConfig.fallback?.model,
      reasoning_effort: agentConfig.reasoning_effort ?? null,
      fallback_reasoning_effort: agentConfig.fallback
        ? (agentConfig.reasoning_effort ?? null)
        : null,
      agent_cmd: workerAgentCmd,
      session_agent_key: resolvedAgentName,
      agent: agentConfig.agent,
      bare: agentConfig.bare,
      env: testingVerifyBaseSha
        ? {
            ...agentConfig.env,
            CARAPA_VERIFY_BASE_SHA: testingVerifyBaseSha,
          }
        : agentConfig.env,
      sandbox: workerSandbox,
      systemPrompt: workerSystemPrompt,
      task_id: task.id,
      stage_id: targetStatus,
      restartRecoveryRunId: restartRecovery?.interruptedRunId,
      precreatedActiveRunId: restartRecovery?.continuationRunId,
      triggeredByUserId: options?.triggerAttribution
        ? options.triggerAttribution.triggeredByUserId
        : (task.lastTriggeredByUserId ?? null),
      triggerSource: options?.triggerAttribution
        ? options.triggerAttribution.triggerSource
        : (task.lastTriggerSource ?? 'system'),
      requiredDependencyCommits: [],
      maxParallelWorktrees: maxParallel,
      manualParallelismOverride: options?.manualParallelismOverride,
      signal: abort.signal,
      skipTranscriptMemory: true,
      captureTranscript: enteringTesting,
      branch_name,
      // Keep all branch preparation behind sandbox startup. Dependency-free
      // tasks return immediately without issuing lineage Git commands and use
      // the configured default branch as their checkout base.
      prepareCheckout: taskUsesBranch(group)
        ? resolveDependencyCheckout
        : undefined,
      skipSharedCheckoutLease: !!taskCheckoutLease,
      requireIsolatedWorktree: isAbExperimentTask(task) || undefined,
      localRepo,
      worktreeFiles,
      worktree_path: branch_name ? task.worktree_path || undefined : undefined,
    };
    const buildAuxiliaryWorkerInput = (
      input: AuxiliaryWorkerInput,
    ): ContainerInput => ({
      ...workerInputBase,
      env: testingVerifyBaseSha
        ? {
            ...workerInputBase.env,
            CARAPA_VERIFY_BASE_SHA: testingVerifyBaseSha,
          }
        : workerInputBase.env,
      prompt: input.prompt,
      fallbackPrompt: input.fallbackPrompt,
      session_id: input.session_id,
      stage_id: input.stage_id,
      activeRunStageId: input.activeRunStageId,
      injectAgentContext: input.injectAgentContext,
      onSlotAcquired: input.onSlotAcquired,
      onActiveRunCreated: input.onActiveRunCreated,
    });
    // Record that `runId` is this chain reviewer's run (the main run or its
    // format repair), so restart recovery can place it and a retry of the same
    // reviewer continues the stored chain instead of restarting the round.
    const claimReviewChainRun = async (runId: string): Promise<void> => {
      if (!reviewChainPlan) return;
      const marker: ReviewChainRunMarker = {
        run_id: runId,
        role: reviewChainPlan.role,
        stage_id:
          reviewChainPlan.role === 'extra'
            ? reviewChainPlan.stageId
            : targetStatus,
        stages: reviewChainPlan.stages,
        head:
          reviewChainPlan.role === 'extra'
            ? reviewChainPlan.chain.head
            : (reviewHeadSha ?? ''),
        started_at: reviewChainStartedAt,
        manual: reviewChainManual,
      };
      const values: Record<string, string | number> = {
        ...(((await getTask(task.id)) ?? task).custom_values || {}),
        [REVIEW_CHAIN_RUN_KEY]: JSON.stringify(marker),
      };
      const stored =
        reviewChainPlan.role === 'extra' ? readReviewChain(values) : null;
      if (stored) {
        values[REVIEW_CHAIN_KEY] = JSON.stringify({
          ...stored,
          after_run_id: runId,
        });
      }
      await updateTask(task.id, { custom_values: values });
    };
    // Record that `runId` is the chain's current tester run, so a retry of the
    // same extra tester continues the stored chain; a primary run (or a run of
    // a task without extra testers) drops any stale chain.
    const claimTestingChainRun = async (runId: string): Promise<void> => {
      if (!enteringTesting) return;
      const values = {
        ...(((await getTask(task.id)) ?? task).custom_values || {}),
      };
      if (testingChainPlan?.role === 'extra') {
        values[TESTING_CHAIN_KEY] = JSON.stringify({
          ...testingChainPlan.chain,
          after_run_id: runId,
        });
      } else if (readTestingChain(values)) {
        values[TESTING_CHAIN_KEY] = '';
      } else {
        return;
      }
      await updateTask(task.id, { custom_values: values });
    };
    const workerInput: ContainerInput = {
      ...workerInputBase,
      prompt: fullWorkerPrompt,
      fallbackPrompt: fullFallbackPrompt,
      onCheckoutReady: prepareStageCheckout,
      onActiveRunCreated: async (runId: string) => {
        executionRunId = runId;
        if (restartRecovery && runId !== restartRecovery.continuationRunId) {
          throw new Error(
            `Restart recovery claim for task ${task.id} changed run identity`,
          );
        }
        if (restartRecovery) restartHandoffCompleted = true;
      },
      onRunLaunched: restartRecovery
        ? async (runId: string) => {
            const marked = await markRestartRecoveryRunDispatched(
              runId,
              restartRecovery.interruptedRunId,
            );
            if (!marked) {
              throw new Error(
                `Restart recovery claim for task ${task.id} lost dispatch ownership`,
              );
            }
          }
        : undefined,
      onSlotAcquired: async (runId: string) => {
        executionRunId = runId;
        await bindTaskAdmissionRun(
          task.project_id,
          task.id,
          runId,
          options?.admissionOwnerToken,
        );
        if (automaticStageEntryEventId) {
          const runningEvent = await markStageEntryEventRunning(
            automaticStageEntryEventId,
            runId,
          );
          if (!runningEvent) {
            throw new Error(
              'Automatic stage-entry event was resolved before launch',
            );
          }
        }
        if (deferTaskActivation) {
          await updateTask(
            task.id,
            {
              status: targetStatus,
              error: '',
              output: '',
            },
            { suppressStageEntryEvent: true },
          );
          broadcast({
            type: 'task_updated',
            payload: { task_id: task.id, project_id: task.project_id },
          });
        }
        // Checkout branch if enabled
        await checkoutTaskBranch(task, group);
        if (
          enteringTesting &&
          (nextStageAfterTesting?.type === 'review' ||
            testingChainPlan?.role === 'extra')
        ) {
          testingInspectedIdentity = await (
            options?.testDependencies?.readTaskGitContentIdentity ??
            readTaskGitContentIdentity
          )(
            checkoutTask,
            group,
            options?.testDependencies?.runGitInRepo ?? runGitInRepo,
          );
          // Branch-mode identity comes from refs only, so check the working
          // tree explicitly: uncommitted edits left by a tester never pass.
          assertExtraTesterCheckout(
            testingInspectedIdentity,
            await isTaskCheckoutClean(
              checkoutTask,
              group,
              options?.testDependencies?.runGitInRepo ?? runGitInRepo,
            ),
          );
          await recordTestingInspectedIdentity(
            task,
            runId,
            testingInspectedIdentity,
          );
        }
        if (enteringReview && !manualReviewRun) {
          const reviewIdentity = await (
            options?.testDependencies?.readTaskGitContentIdentity ??
            readTaskGitContentIdentity
          )(
            checkoutTask,
            group,
            options?.testDependencies?.runGitInRepo ?? runGitInRepo,
          );
          reviewHeadSha = reviewIdentity?.headSha;
          reviewTreeSha = reviewIdentity?.treeSha;
          assertExtraReviewerCheckout(reviewIdentity?.headSha);
          if (
            !(await ensureReviewHasCurrentTestingEvidence(
              checkoutTask,
              group,
              stages,
              targetStatus,
              reviewHeadSha,
              reviewTreeSha,
              options?.testDependencies?.runGitInRepo ?? runGitInRepo,
            ))
          ) {
            reviewDeferredAtSlot = true;
            throw new ReviewDeferredError(
              'Review deferred because Testing evidence no longer matches the slot-time tracked content',
            );
          }
        }

        // A sandbox slot is now available and execution is about to begin.
        // Move to runningTasks so the UI `running` indicator activates,
        // and set started_at so the elapsed timer starts from the right moment.
        runningTasks.set(task.id, {
          abort,
          project_id: task.project_id,
          run_id: runId,
        });
        await claimReviewChainRun(runId);
        await claimTestingChainRun(runId);
        const started_at = new Date().toISOString();
        await updateTask(task.id, {
          started_at: started_at,
          last_agent_name: agent_name || AGENT_CMD,
          // `execute_in_stage` is an initial-pickup gate, not a permanent
          // lifecycle restriction. Consume it only once the matching run has
          // actually acquired a slot; setup failures and queued work retain
          // the gate, while later testing/review recovery can run normally.
          ...(shouldConsumeExecuteInStage(task.execute_in_stage, targetStatus)
            ? { execute_in_stage: null }
            : {}),
        });

        // Store user message for this execution turn (use resolved prompt, not always description).
        // Skip when continuing a session with no new user input — avoids repeating the description.
        const userMsg = skipUserTranscript
          ? null
          : await appendTaskMessageDedupAsync(task.project_id, {
              task_id: task.id,
              role: 'user',
              content: userPromptForTranscript,
              created_at: started_at,
            });
        if (userMsg) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: userMsg,
            },
          });
        }

        // Write a run-separator marker so each run gets its own chat bubble
        // group with a visual divider (and the Runs tab can jump to it). The
        // marker is written before the agent produces output, so it lands
        // between the triggering user message and the assistant response.
        const runMarker = await appendRunStartMarkerAsync(
          task.project_id,
          task.id,
          runId,
          {
            agent_name: agent_name || AGENT_CMD,
            created_at: started_at,
          },
        );
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: runMarker,
          },
        });

        broadcast({
          type: 'task_started',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            run_id: runId,
          },
        });
        taskStartedRunId = runId;
        clearTaskStreamBuffer(task.id);

        logger.info(
          {
            task_id: task.id,
            project: task.project_id,
            title: task.title,
          },
          'Worker phase started',
        );
      },
      onPromptRunAssigned: async (runId: string) => {
        for (const prompt of pendingSteeringMessages) {
          await appendSteeringAssignment(
            task.project_id,
            task.id,
            prompt.id,
            runId,
          );
        }
      },
      onPromptRunAccepted: async (runId: string) => {
        for (const prompt of pendingSteeringMessages) {
          const receipt = await appendSteeringReceipt(
            task.project_id,
            task.id,
            prompt.id,
            runId,
          );
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: receipt,
            },
          });
        }
      },
    };

    const executeContainerAgent =
      options?.testDependencies?.runContainerAgent ?? runContainerAgent;
    const executeTrackedContainerAgent = async (
      input: ContainerInput,
      onChunk: Parameters<typeof executeContainerAgent>[2],
    ) => {
      const invocationRunIds = new Set<string>();
      let currentRunId: string | undefined;
      const registerRun = (runId: string) => {
        currentRunId = runId;
        invocationRunIds.add(runId);
        beginTaskRunSessionPersistence(runId, task.id);
      };
      const onActiveRunCreated = input.onActiveRunCreated;
      const onSlotAcquired = input.onSlotAcquired;
      try {
        return await executeContainerAgent(
          group,
          {
            ...input,
            onActiveRunCreated: async (runId: string) => {
              registerRun(runId);
              await onActiveRunCreated?.(runId);
            },
            onSlotAcquired: async (runId: string) => {
              registerRun(runId);
              await onSlotAcquired?.(runId);
            },
          },
          (chunk) => {
            if (chunk.type === 'session' && chunk.session_id.trim()) {
              if (currentRunId) {
                queueTaskRunSessionPersistence(
                  currentRunId,
                  task,
                  chunk.session_id,
                  options?.testDependencies?.persistTaskSessionForActiveRun ??
                    persistTaskSessionForActiveRun,
                );
              }
            }
            if (chunk.type === 'background_tasks') {
              broadcast({
                type: 'task_background_tasks',
                payload: {
                  task_id: task.id,
                  project_id: task.project_id,
                  run_id: currentRunId ?? undefined,
                  tasks: chunk.tasks,
                },
              });
            }
            onChunk?.(chunk);
          },
        );
      } finally {
        await finishTaskRunSessionPersistences(invocationRunIds);
      }
    };
    if (testingVerdictRun) testingVerdictRuns.add(task.id);

    // Persist a rejection's feedback and run the normal first-rejection /
    // progress comparison. Shared by a reviewer's own verdict and by a chain
    // settled after a reviewer failed.
    prepareReviewRejection = createReviewRejectionPreparer({
      task,
      targetStatus,
      getAgentName: () => agent_name,
      getModelName: () => model_name,
      getRunId: () => executionRunId,
      getReviewHead: () => reviewHeadSha,
      clearTaskStream: (runId) =>
        clearTaskStream(task.id, task.project_id, false, false, runId),
      runAuxiliary: (input, onChunk) =>
        executeTrackedContainerAgent(buildAuxiliaryWorkerInput(input), onChunk),
    });

    const testingOutputFilter = testingVerdictRun
      ? new TestingOutputStreamFilter()
      : undefined;
    let testingFilterEntryId: string | undefined;
    const stopBackgroundTasksAfterVerdict =
      enteringTesting || enteringReview
        ? createVerdictBackgroundTaskStopper({
            kind: enteringTesting ? 'testing' : 'review',
            taskId: task.id,
            stageId: targetStatus,
            getRunId: () => executionRunId,
            getOutput: () => turnOutput,
            stopBackgroundTask:
              options?.testDependencies?.stopTaskBackgroundTask,
          })
        : undefined;
    const result = await executeTrackedContainerAgent(workerInput, (chunk) => {
      if (chunk.type === 'background_tasks') {
        stopBackgroundTasksAfterVerdict?.(chunk.tasks);
      }
      if (chunk.type === 'text') {
        if (testingVerdictRun) {
          turnOutput += chunk.content;
          recordTestingRawChunk(task.id, chunk.content);
          // Tool request/result entries never carry the machine verdict;
          // filtering them lets an unbalanced `{` in a diff or log withhold
          // every later chunk until the run ends.
          const isToolChunk = chunk.entryId?.startsWith('tool_call:') ?? false;
          if (!isToolChunk && chunk.entryId)
            testingFilterEntryId = chunk.entryId;
          const visibleChunk = isToolChunk
            ? chunk.content
            : testingOutputFilter!.push(chunk.content);
          if (
            visibleChunk ||
            (chunk.entryId && chunk.entryComplete !== undefined)
          )
            streamChunk(
              task.id,
              visibleChunk,
              task.project_id,
              executionRunId,
              undefined,
              chunk.entryId,
              chunk.entryComplete,
              chunk.canonicalEntry,
            );
        } else {
          streamChunk(
            task.id,
            chunk.content,
            task.project_id,
            executionRunId,
            (c) => {
              turnOutput += c;
            },
            chunk.entryId,
            chunk.entryComplete,
            chunk.canonicalEntry,
          );
        }
      }
    });
    const finalTestingOutput = testingOutputFilter?.finish();
    if (finalTestingOutput)
      streamChunk(
        task.id,
        finalTestingOutput,
        task.project_id,
        executionRunId,
        undefined,
        testingFilterEntryId,
      );
    if (restartRecovery && !restartHandoffCompleted) {
      throw new Error(
        result.error ||
          `Restart recovery did not claim a replacement run for task ${task.id}`,
      );
    }
    // onSlotAcquired deliberately stops launch when the checked-out Review
    // content changed while waiting for a sandbox slot. The runner converts
    // that callback exception into an error result after finalizing its active
    // run, but the evidence guard already returned the task to Testing.
    if (reviewDeferredAtSlot) return;
    if (await finishGuardedReviewChain()) return;
    if (await finishGuardedTestingChain()) return;

    // A run that ends without a transient provider error resets the retry
    // budget, whatever stage handoff or non-transient outcome follows.
    if (
      !isAbortedExecution(abort) &&
      (result.status === 'success' || !isRetryableTaskError(result.error ?? ''))
    ) {
      await resetTransientRetries(task.id);
    }

    // Persist the sandbox instance so follow-up git ops target the same
    // container. Awaited: post-run git boundaries (testing-stage HEAD read,
    // deploy merge, post-execution checkpoint) must observe this row, and a
    // failure belongs to the same post-processing catch as the other
    // persistence calls here — not an unhandled rejection. Also sync the
    // in-memory row: the testing-stage HEAD read consumes this `task` object
    // directly, so without the sync it would keep targeting the pre-run
    // instance (e.g. the group folder) instead of the run's real instance.
    if (result.sandbox_instance) {
      // Diagnostic: detect if sandbox_instance looks like an agent executable instead of a group folder
      if (
        result.sandbox_instance.includes('.') ||
        result.sandbox_instance === 'agent'
      ) {
        logger.error(
          {
            task_id: task.id,
            sandbox_instance: result.sandbox_instance,
            group_folder: group.folder,
          },
          'BUG: sandbox_instance looks like an agent name, not a group folder — skipping write',
        );
      } else {
        await updateTask(task.id, {
          sandbox_instance: result.sandbox_instance,
        });
        task.sandbox_instance = result.sandbox_instance;
      }
    }

    // Capture the actual model used (from agent stream) or fall back to configured model
    model_name = result.model_name || workerModel || null;

    logger.info(
      {
        task_id: task.id,
        status: result.status,
        hasResult: !!result.result,
        sandbox_instance: result.sandbox_instance,
        model_name,
      },
      'Agent run returned',
    );
    // stopTask() already settled the card's stage. A turn that still finished
    // successfully must not hold it for steering or apply a stage handoff.
    if (stoppedTaskClaims.has(abort)) return;
    const testingTransportRecovery =
      result.status === 'error' && isTestingStage(stages, targetStatus)
        ? buildTestingTransportRecoveryOutput(
            result.rawTranscript,
            turnOutput,
            result.error ?? 'Agent transport failed',
          )
        : '';

    if (result.status === 'success' || testingTransportRecovery) {
      await options?.testDependencies?.afterSuccessfulAgentRun?.();
      if (automaticStageEntryEventId) {
        markTaskFinalizing(task.id, targetStatus);
      } else if (
        await holdTaskForPendingSteering(
          task,
          targetStatus,
          executionRunId ?? undefined,
        )
      ) {
        // A prompt already queued against the completed worker turn belongs in
        // a same-stage continuation before verdict repair or other successful
        // processing begins. This checkpoint deliberately leaves admission
        // open when no prompt is pending so auxiliary runs remain steerable.
        const preservedContent = testingTransportRecovery
          ? testingTransportRecovery
          : selectTaskAssistantContent(turnOutput, result.result);
        await updateTask(task.id, {
          status: targetStatus,
          completed_at: null,
          session_id: result.newSessionId,
          last_agent_name: agent_name,
          ...(preservedContent.trim() ? { output: preservedContent } : {}),
        });
        if (preservedContent.trim()) {
          const message = appendTaskMessageDedup(task.project_id, {
            task_id: task.id,
            role: 'assistant',
            content: testingVerdictRuns.has(task.id)
              ? stripAllTestingDecisions(preservedContent)
              : preservedContent,
            agent_name,
            model_name,
            entry_type: 'run_result',
            run_id: executionRunId ?? null,
            created_at: new Date().toISOString(),
          });
          if (message) {
            broadcast({
              type: 'task_message',
              payload: {
                task_id: task.id,
                project_id: task.project_id,
                message,
              },
            });
          }
        }
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }
    }

    const stageHandoff =
      (await getPendingTaskStageHandoff(task, targetStatus)) ??
      stageHandoffs.get(task.id);
    // A handoff-timeout abort ends a turn whose stage move the agent already
    // had acknowledged, so it applies the handoff even if the interrupted run
    // did not report success. A stop (handled above) never reaches here.
    const handoffTimedOut =
      abort.signal.reason === STAGE_HANDOFF_TIMEOUT_ABORT_REASON;
    if (
      stageHandoff &&
      (result.status === 'success' ||
        testingTransportRecovery ||
        handoffTimedOut)
    ) {
      // Preserve output produced before update_task initiated the handoff.
      // The tool handler records only the intent; the destination is applied
      // below after successful finalization admits transition effects.
      const assistantContent = selectTaskAssistantContent(
        turnOutput,
        result.result,
      );
      if (assistantContent.trim()) {
        const assistantMsg = appendTaskMessageDedup(task.project_id, {
          task_id: task.id,
          role: 'assistant',
          content: testingVerdictRuns.has(task.id)
            ? stripAllTestingDecisions(assistantContent)
            : assistantContent,
          agent_name,
          model_name,
          entry_type: 'run_result',
          run_id: executionRunId ?? null,
          created_at: new Date().toISOString(),
        });
        if (assistantMsg) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: assistantMsg,
            },
          });
        }
      }
      await updateTask(task.id, {
        session_id: result.newSessionId,
        last_agent_name: agent_name,
      });
      const handoffTarget = findStage(stages, stageHandoff.toStage);
      const handoffReachesDone = handoffTarget?.type === 'done';
      const stageEntryEventRef: StageEntryEventRef = {};
      if (handoffReachesDone) {
        const checkpointTask = (await getTask(task.id)) ?? task;
        let mergeReady = false;
        const mergeAllowed = await runWithTaskSteeringBarrier(
          task,
          targetStatus,
          async () => {
            mergeReady = await (
              options?.testDependencies?.mergeBranchForDeploy ??
              mergeBranchForDeploy
            )(
              checkpointTask,
              group,
              group.settings?.deployService ? 'deploy' : 'completion',
              undefined,
              { leaseAlreadyHeld: !!taskCheckoutLease },
            );
          },
        );
        if (!mergeAllowed || !mergeReady) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
        await updateTask(task.id, {
          session_id: result.newSessionId,
          last_agent_name: agent_name,
          ...(automaticStageEntryEventId ? { output: assistantContent } : {}),
        });
        if (
          stageHandoff.toStage === getDeployStageId(group.settings, stages) &&
          group.settings?.deployService
        ) {
          const deployed = await runWithTaskSteeringBarrier(
            task,
            targetStatus,
            async () => {
              await triggerDeploy(checkpointTask, group, {
                skipMerge: true,
                lifecycleRunId: executionRunId ?? task.id,
                stageEntryEventId: stageEntryEventRef.id,
              });
            },
          );
          if (!deployed) {
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
        } else {
          const completedAt = new Date().toISOString();
          const transitioned = await updateTaskWithSteeringBarrier(
            task,
            targetStatus,
            {
              status: stageHandoff.toStage,
              completed_at: completedAt,
            },
            stageEntryEventRef,
          );
          if (!transitioned) {
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
          const effectsAllowed = await runWithTaskSteeringBarrier(
            task,
            targetStatus,
            async () => {
              const completedTask = await getTask(task.id);
              if (completedTask)
                broadcast({ type: 'task_updated', payload: completedTask });
              broadcast({
                type: 'task_completed',
                payload: { task_id: task.id, project_id: task.project_id },
              });
              publishEvent(
                resolveBrainUrl(resolveBrainContainer(group)),
                {
                  type: 'task_completed',
                  project_id: task.project_id,
                  task_id: task.id,
                  objective_id: task.objective_id ?? null,
                  timestamp: completedAt,
                  data: {
                    ...taskEventHeaders(task, group),
                    status: stageHandoff.toStage,
                    stageHandoff: true,
                  },
                },
                group,
              );
            },
          );
          if (!effectsAllowed) {
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
        }
      } else {
        // A durable handoff carries the proof of its own move in the same
        // write, so a crash before finalization is replayed by recovery.
        const handoffMarker =
          stageHandoff.requestId && executionRunId
            ? recoveryTransitionValue(
                executionRunId,
                stageHandoff.toStage,
                false,
              )
            : undefined;
        const transitioned = await updateTaskWithSteeringBarrier(
          task,
          targetStatus,
          {
            status: stageHandoff.toStage,
            session_id: result.newSessionId,
            last_agent_name: agent_name,
            ...(automaticStageEntryEventId ? { output: assistantContent } : {}),
            ...(handoffMarker ? { custom_values: handoffMarker } : {}),
          },
          stageEntryEventRef,
          handoffMarker ? { mergeCustomValues: true } : undefined,
        );
        if (!transitioned) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
      }
      if (stageHandoff.requestId) {
        const effectsAllowed = await runWithTaskSteeringBarrier(
          task,
          targetStatus,
          async () => {
            await finalizeTaskStageHandoff(
              task,
              stageHandoff as DurableTaskStageHandoff,
              executionRunId ?? stageHandoff.requestedRunId ?? task.id,
              stageEntryEventRef.id,
            );
          },
        );
        if (!effectsAllowed) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
        if (executionRunId) {
          try {
            await clearRecoveryTransition(task.id, executionRunId);
          } catch (error) {
            logger.warn(
              { err: error, task_id: task.id, runId: executionRunId },
              'Failed to clear the stage handoff recovery marker',
            );
          }
        }
      } else if (stageHandoff.finalizeEffects) {
        const effectsAllowed = await runWithTaskSteeringBarrier(
          task,
          targetStatus,
          stageHandoff.finalizeEffects,
        );
        if (!effectsAllowed) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
      }
      clearTaskStream(task.id, task.project_id, false, false, executionRunId);
      logger.info(
        { task_id: task.id, ...stageHandoff },
        'Stage handoff completed; releasing run for next stage',
      );
      return;
    }

    if (result.status === 'success' || testingTransportRecovery) {
      // If the task was stopped by the user while the agent was running,
      // stopTask() already set the correct status (backlog) and appended
      // the "Stopped by user." message. Don't overwrite that with a
      // success status or save the (potentially raw JSON) agent output.
      // But DO save any streamed output so the transcript is visible.
      if (abort.signal.aborted) {
        // stopTask() persists partial output + the stop notice before task_error.
        return;
      }

      const current = await getTask(task.id);

      // If the agent already moved the task to a different stage (e.g. "question" or
      // back to active after a review rejection), respect that — don't overwrite.
      const currentStageDef = findStage(stages, current?.status ?? '');
      const agentMovedTask = current?.status !== targetStatus;
      const movedToQueueStage = currentStageDef?.type === 'queue';

      // Check if there's a next active stage to advance to.
      // `skip_stages` is a per-task override that drops matching stage IDs
      // from the forward scan during auto-advance. null / undefined = no
      // skipping. Manual moves (when `agentMovedTask` is true) bypass this
      // helper entirely so the user/agent can still place the task into a
      // skipped stage on purpose.
      const nextActiveStage = !agentMovedTask
        ? getNextActiveStage(
            stages,
            targetStatus,
            task.skip_stages ?? undefined,
          )
        : undefined;
      const doneStage = getDoneStage(stages);
      const completed_at = new Date().toISOString();
      const completionStageId =
        nextActiveStage?.id ?? doneStage?.id ?? 'completed';
      const reachedDoneStage = shouldStampTaskCompleted(
        agentMovedTask,
        currentStageDef,
        nextActiveStage,
      );

      const rawResult = result.result ?? '';
      if (!turnOutput) {
        streamChunk(
          task.id,
          rawResult,
          task.project_id,
          executionRunId,
          (c) => {
            turnOutput += c;
          },
        );
      }

      // Compute assistant content once — used by both review and normal paths
      let assistantContent = selectTaskAssistantContent(
        turnOutput,
        result.result,
      );
      if (testingTransportRecovery) assistantContent = testingTransportRecovery;
      const testingTranscriptContent = testingTransportRecovery
        ? testingTransportRecovery
        : reconcileTaskTranscriptContent(turnOutput, result.result);

      // --- Testing stage: parse a read-only verdict and transition in code ---

      if (automaticStageEntryEventId) {
        await persistAutomaticStageEntrySuccess({
          eventId: automaticStageEntryEventId,
          task,
          output: assistantContent,
          agentName: agent_name,
          modelName: model_name,
          runId: executionRunId,
          sessionId: result.newSessionId,
        });
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        logger.info(
          {
            task_id: task.id,
            stage: targetStatus,
            stageEntryEventId: automaticStageEntryEventId,
          },
          'Automatic stage-entry run completed without auto-advance',
        );
        return;
      }
      if (isTestingStage(stages, targetStatus) && !agentMovedTask) {
        let testingSessionId = result.newSessionId;
        let testingAssistantResponsePersisted = false;
        const testingTransportFailed = Boolean(testingTransportRecovery);
        const parsedTesting = await parseTestingDecisionWithRepair(
          assistantContent,
          fullWorkerPrompt,
          async (repairPrompt, fallbackRepairPrompt, attempt) => {
            // A stopped run must not append more repair prompts or notices.
            if (abort.signal.aborted) return '';
            logger.warn(
              {
                task_id: task.id,
                attempt,
                maxAttempts: MAX_TESTING_FORMAT_RETRIES,
              },
              '[testing] Structured verdict missing — requesting format repair',
            );
            if (!testingAssistantResponsePersisted) {
              persistTestingAssistantResponse({
                task,
                assistantContent: testingTranscriptContent,
                agent_name,
                model_name,
                runId: executionRunId ?? undefined,
              });
              testingAssistantResponsePersisted = true;
            }
            clearTaskStream(
              task.id,
              task.project_id,
              true,
              true,
              executionRunId,
            );
            let repairOutput = '';
            let repairRunId: string | undefined;
            const repairResult = await executeTrackedContainerAgent(
              buildAuxiliaryWorkerInput({
                prompt: repairPrompt,
                fallbackPrompt: fallbackRepairPrompt,
                session_id: testingTransportFailed
                  ? undefined
                  : testingSessionId,
                stage_id: `${targetStatus}:format-repair-${attempt}`,
                activeRunStageId: targetStatus,
                injectAgentContext: testingTransportFailed,
                onActiveRunCreated: async (runId: string) => {
                  repairRunId = runId;
                },
                onSlotAcquired: async (runId: string) => {
                  repairRunId = runId;
                  const marker = await appendRunStartMarkerAsync(
                    task.project_id,
                    task.id,
                    runId,
                    {
                      agent_name: agent_name || AGENT_CMD,
                      created_at: new Date().toISOString(),
                    },
                  );
                  broadcast({
                    type: 'task_message',
                    payload: {
                      task_id: task.id,
                      project_id: task.project_id,
                      message: marker,
                    },
                  });
                },
              }),
              (chunk) => {
                if (chunk.type === 'text') repairOutput += chunk.content;
                if (chunk.type === 'session')
                  testingSessionId = chunk.session_id;
              },
            );
            testingSessionId = repairResult.newSessionId || testingSessionId;
            const repairCanonicalOutput =
              repairResult.result || repairOutput || '';
            const repairTranscriptContent = reconcileTaskTranscriptContent(
              repairOutput,
              repairResult.result,
            );
            persistTestingAssistantResponse({
              task,
              assistantContent: repairTranscriptContent,
              agent_name,
              model_name,
              runId: repairRunId,
            });
            return repairCanonicalOutput;
          },
        );
        // stopTask() owns the card's status; an aborted repair run must not
        // fall through to a Question/blocked transition.
        if (abort.signal.aborted) return;
        // A passing Testing verdict is not evidence until every post-run Git
        // mutation has settled. Capture the prepared content before the worker,
        // then require cleanup and final preparation to leave that exact tree
        // unchanged before binding the verdict to it. Commit metadata may differ.
        let finalTestingIdentity: TaskGitContentIdentity | undefined;
        if (
          parsedTesting.decision?.decision === 'pass' &&
          nextStageAfterTesting?.type === 'review'
        ) {
          postExecutionGitOpsHandled = true;
          let preparationError: unknown;
          const preparationAllowed = await runWithTaskSteeringBarrier(
            task,
            targetStatus,
            async () => {
              try {
                await (
                  options?.testDependencies?.runPostExecutionGitOps ??
                  runPostExecutionGitOps
                )(checkoutTask, group, stages);
                await (
                  options?.testDependencies?.prepareTaskBranchForReview ??
                  prepareTaskBranchForReview
                )(checkoutTask, group);
              } catch (error) {
                preparationError = error;
              }
            },
          );
          if (!preparationAllowed) {
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
          if (preparationError) {
            execFailed = true;
            await parkTaskAfterGitCheckpointFailure(
              task,
              stages,
              preparationError,
            );
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
          finalTestingIdentity = await (
            options?.testDependencies?.readTaskGitContentIdentity ??
            readTaskGitContentIdentity
          )(
            checkoutTask,
            group,
            options?.testDependencies?.runGitInRepo ?? runGitInRepo,
          );
        }
        const stageEntryEventRef: StageEntryEventRef = {};
        if (parsedTesting.decision) {
          const testingIdentity =
            parsedTesting.decision.decision === 'pass'
              ? nextStageAfterTesting?.type === 'review'
                ? testingInspectedIdentity
                : // Branch-mode identity reads only refs: with testers chained, a
                  // pass is evidence only for a clean checkout, otherwise the
                  // completing merge would commit edits no tester judged.
                  testingChainPlan &&
                    !(await isTaskCheckoutClean(
                      checkoutTask,
                      group,
                      options?.testDependencies?.runGitInRepo ?? runGitInRepo,
                    ))
                  ? undefined
                  : await (
                      options?.testDependencies?.readTaskGitContentIdentity ??
                      readTaskGitContentIdentity
                    )(
                      checkoutTask,
                      group,
                      options?.testDependencies?.runGitInRepo ?? runGitInRepo,
                    )
              : undefined;
          const testingContext = {
            task,
            group,
            stages,
            targetStatus,
            assistantContent,
            agent_name,
            model_name,
            newSessionId: testingSessionId,
            runId: executionRunId ?? undefined,
            leaseAlreadyHeld: !!taskCheckoutLease,
            assistantResponsePersisted: testingAssistantResponsePersisted,
            stageEntryEventRef,
            testingHeadSha: testingIdentity?.headSha,
            testingTreeSha: testingIdentity?.treeSha,
            beforeTransition: (changes?: Parameters<typeof updateTask>[1]) =>
              updateTaskWithSteeringBarrier(
                task,
                targetStatus,
                changes ?? {},
                stageEntryEventRef,
              ),
            runTransition: (operation: () => Promise<void>) =>
              runWithTaskSteeringBarrier(task, targetStatus, operation),
          };
          await updateTask(task.id, {
            session_id: testingSessionId,
            last_agent_name: agent_name,
          });
          markTaskFinalizing(task.id, targetStatus);
          if (
            parsedTesting.decision.decision === 'pass' &&
            nextStageAfterTesting?.type === 'review' &&
            !testingInspectedIdentity
          ) {
            await handleTestingBlocked(
              'The clean Git commit and content tree inspected by Testing could not be resolved, so the passing evidence cannot be verified against the final prepared Review state.',
              testingContext,
            );
          } else if (
            parsedTesting.decision.decision === 'pass' &&
            nextStageAfterTesting?.type === 'review' &&
            !finalTestingIdentity
          ) {
            await handleTestingBlocked(
              'The final prepared Review state is dirty or its Git commit and content tree could not be resolved, so the passing evidence cannot be recorded.',
              testingContext,
            );
          } else if (
            parsedTesting.decision.decision === 'pass' &&
            !testingIdentity
          ) {
            await handleTestingBlocked(
              'The current worktree is dirty or its Git commit and content tree could not be resolved, so the passing evidence cannot be recorded.',
              testingContext,
            );
          } else if (
            parsedTesting.decision.decision === 'pass' &&
            testingInspectedIdentity &&
            finalTestingIdentity &&
            testingInspectedIdentity.treeSha !== finalTestingIdentity.treeSha
          ) {
            await retryTestingAfterGitStateChange(task, targetStatus);
          } else {
            await handleTestingDecision(parsedTesting.decision, testingContext);
          }
        } else {
          await handleTestingBlocked(
            'Testing output remained unparseable after format repair.',
            {
              task,
              group,
              stages,
              targetStatus,
              assistantContent,
              agent_name,
              model_name,
              newSessionId: testingSessionId,
              runId: executionRunId ?? undefined,
              assistantResponsePersisted: testingAssistantResponsePersisted,
              stageEntryEventRef,
              beforeTransition: (changes?: Parameters<typeof updateTask>[1]) =>
                updateTaskWithSteeringBarrier(
                  task,
                  targetStatus,
                  changes ?? {},
                  stageEntryEventRef,
                ),
            },
          );
        }
        if (!(await updateTaskWithSteeringBarrier(task, targetStatus, {}))) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      // --- Review stage: parse structured decision and act automatically ---
      if (isReviewStage(stages, targetStatus) && !agentMovedTask) {
        let reviewSessionId = result.newSessionId;
        const parsedReview = await parseReviewDecisionWithRepair(
          assistantContent,
          fullWorkerPrompt,
          async (repairPrompt, attempt) => {
            // A stopped run must not append more repair prompts or notices.
            if (abort.signal.aborted) return { output: '', runId: '' };
            logger.warn(
              {
                task_id: task.id,
                attempt,
                maxAttempts: MAX_REVIEW_FORMAT_RETRIES,
              },
              '[review] Structured decision missing — requesting format repair',
            );
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );

            const notice = appendTaskMessage(task.project_id, {
              task_id: task.id,
              role: 'system',
              entry_type: 'system_notice',
              content: `Review response format was invalid. Requesting corrected JSON (${attempt}/${MAX_REVIEW_FORMAT_RETRIES})…`,
              created_at: new Date().toISOString(),
            });
            broadcast({
              type: 'task_message',
              payload: {
                task_id: task.id,
                project_id: task.project_id,
                message: notice,
              },
            });

            let repairOutput = '';
            let repairRunId: string | undefined;
            const repairResult = await executeTrackedContainerAgent(
              buildAuxiliaryWorkerInput({
                prompt: repairPrompt,
                fallbackPrompt: repairPrompt,
                session_id: reviewSessionId,
                stage_id: targetStatus,
                // A native review session already carries the review system
                // prompt. If no session was captured, bootstrap a fresh
                // reviewer with that prompt instead of sending schema-only
                // instructions to a generic coding agent.
                injectAgentContext: !reviewSessionId,
                onActiveRunCreated: async (runId: string) => {
                  repairRunId = runId;
                },
                onSlotAcquired: async (runId: string) => {
                  repairRunId = runId;
                  await claimReviewChainRun(runId);
                  const marker = appendRunStartMarker(
                    task.project_id,
                    task.id,
                    runId,
                    {
                      agent_name: agent_name || AGENT_CMD,
                      created_at: new Date().toISOString(),
                    },
                  );
                  broadcast({
                    type: 'task_message',
                    payload: {
                      task_id: task.id,
                      project_id: task.project_id,
                      message: marker,
                    },
                  });
                },
              }),
              (chunk) => {
                if (chunk.type === 'text') repairOutput += chunk.content;
                if (chunk.type === 'session') {
                  reviewSessionId = chunk.session_id;
                }
              },
            );
            if (repairResult.newSessionId) {
              reviewSessionId = repairResult.newSessionId;
            }
            return {
              output: repairOutput || repairResult.result || '',
              runId: repairRunId!,
            };
          },
          MAX_REVIEW_FORMAT_RETRIES,
          executionRunId ?? undefined,
        );
        // stopTask() owns the card's status; an aborted repair run must not
        // fall through to a rejection or manual-resolution transition.
        if (abort.signal.aborted) return;
        assistantContent = parsedReview.output;
        let reviewDecision = parsedReview.decision;
        // With extra reviewers this run only contributes a verdict; the card is
        // decided once, after the last reviewer.
        let reviewChainVerdicts: ReviewChainVerdict[] | undefined;
        let incompleteReviewers: string[] | undefined;
        if (reviewChainPlan) {
          const verdict: ReviewChainVerdict = {
            stage_id:
              reviewChainPlan.role === 'extra'
                ? reviewChainPlan.stageId
                : targetStatus,
            reviewer: model_name || agent_name || targetStatus,
            decision: parsedReview.decision?.decision ?? null,
            score: parsedReview.decision?.score ?? null,
            issues: parsedReview.decision?.issues ?? [],
            summary: parsedReview.decision?.summary ?? '',
          };
          const chain: ReviewChain = {
            head:
              reviewChainPlan.role === 'extra'
                ? reviewChainPlan.chain.head
                : (reviewHeadSha ?? ''),
            started_at: reviewChainStartedAt,
            manual: reviewChainManual,
            after_run_id: '',
            stages: reviewChainPlan.stages,
            verdicts: [
              ...(reviewChainPlan.role === 'extra'
                ? reviewChainPlan.chain.verdicts
                : []),
              verdict,
            ],
          };
          if (nextReviewChainStage(chain)) {
            await continueReviewChain({
              task,
              targetStatus,
              chain,
              verdict,
              assistantContent,
              agent_name,
              model_name,
              sessionId: reviewSessionId,
              runId: parsedReview.runId ?? executionRunId,
            });
            return;
          }
          reviewChainVerdicts = chain.verdicts;
          const outcome = aggregateReviewChain(chain.verdicts);
          if (outcome.kind === 'decided') reviewDecision = outcome.decision;
          else {
            reviewDecision = null;
            incompleteReviewers = outcome.failedReviewers;
          }
        }
        const stageEntryEventRef: StageEntryEventRef = {};
        if (reviewDecision) {
          let rejectionComparison;
          let rejectionFeedbackPersisted = false;
          if (reviewDecision.decision === 'reject') {
            const prepared = await prepareReviewRejection!({
              reviewDecision,
              assistantContent,
              sessionId: reviewSessionId,
              reviewers: reviewChainVerdicts
                ? summarizeReviewerVerdicts(reviewChainVerdicts)
                : undefined,
            });
            if (abort.signal.aborted) return;
            rejectionComparison = prepared.rejectionComparison;
            reviewSessionId = prepared.sessionId;
            rejectionFeedbackPersisted = true;
          }
          await updateTask(task.id, {
            session_id: reviewSessionId,
            last_agent_name: agent_name,
          });
          markTaskFinalizing(task.id, targetStatus);
          await handleReviewDecision(reviewDecision, {
            task,
            group,
            stages,
            targetStatus,
            runId: parsedReview.runId!,
            completionStageId,
            assistantContent,
            agent_name,
            model_name,
            newSessionId: reviewSessionId,
            sandbox_instance: result.sandbox_instance,
            review_head_sha: reviewHeadSha,
            reviewer_verdicts: reviewChainVerdicts
              ? summarizeReviewerVerdicts(reviewChainVerdicts)
              : undefined,
            leaseAlreadyHeld: !!taskCheckoutLease,
            rejection_comparison: rejectionComparison,
            rejection_comparison_attempted:
              reviewDecision.decision === 'reject',
            rejection_feedback_persisted: rejectionFeedbackPersisted,
            stageEntryEventRef,
            beforeTransition: (changes?: Parameters<typeof updateTask>[1]) =>
              updateTaskWithSteeringBarrier(
                task,
                targetStatus,
                changes ?? {},
                stageEntryEventRef,
              ),
            runTransition: (operation) =>
              runWithTaskSteeringBarrier(task, targetStatus, operation),
          });
          if (!(await updateTaskWithSteeringBarrier(task, targetStatus, {}))) {
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return; // Review decision handled — skip normal auto-advance logic
        }

        // No parseable decision — do NOT leave the task in the executable
        // review stage, or the queue will launch the same review repeatedly.
        // Park it in the initial queue stage for manual inspection/re-run.
        logger.warn(
          { task_id: task.id },
          '[review] No structured JSON decision found — parking task for manual resolution',
        );

        await parkReviewWithoutDecision({
          task,
          stages,
          targetStatus,
          runId: executionRunId,
          notice: (manualStage) =>
            incompleteReviewers
              ? reviewChainIncompleteNotice(incompleteReviewers, manualStage)
              : `**Review output could not be parsed** — no structured decision (\`approve\`/\`reject\`) was found. The task was paused in \`${manualStage}\` for manual inspection. Re-run the task after fixing or reviewing the agent output.`,
          changes: {
            session_id: reviewSessionId,
            last_agent_name: agent_name,
            output: assistantContent,
            ...(incompleteReviewers
              ? { custom_values: withoutReviewChain(await getTask(task.id)) }
              : {}),
          },
        });
        return; // Unparseable review handled — skip normal auto-advance logic
      }

      logger.info(
        {
          task_id: task.id,
          completionStageId,
          agentMovedTask,
          nextActiveStage: nextActiveStage?.id,
        },
        'Moving task to completion stage',
      );
      // Store assistant message for this turn
      const assistantMsg = appendTaskMessageDedup(task.project_id, {
        task_id: task.id,
        role: 'assistant',
        content: testingVerdictRuns.has(task.id)
          ? stripAllTestingDecisions(assistantContent)
          : assistantContent,
        agent_name: agent_name,
        model_name: model_name,
        entry_type: 'run_result',
        run_id: executionRunId ?? null,
        created_at: new Date().toISOString(),
      });
      if (assistantMsg) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: assistantMsg,
          },
        });
      }

      await updateTask(task.id, {
        session_id: result.newSessionId,
        last_agent_name: agent_name,
      });
      // Every transition into a done stage must first produce a durable Git
      // result. Worktree projects merge their task branch; shared-checkout
      // projects commit directly on the configured default branch.
      const stageEntryEventRef: StageEntryEventRef = {};
      let transitioned = false;
      const willDispatchDeploy =
        reachedDoneStage &&
        !agentMovedTask &&
        completionStageId === getDeployStageId(group.settings, stages) &&
        !!group.settings?.deployService;
      if (reachedDoneStage) {
        const freshTask = await getTask(task.id);
        let mergeReady = false;
        const mergeAllowed = freshTask
          ? await runWithTaskSteeringBarrier(task, targetStatus, async () => {
              mergeReady = await (
                options?.testDependencies?.mergeBranchForDeploy ??
                mergeBranchForDeploy
              )(
                freshTask,
                group,
                group.settings?.deployService ? 'deploy' : 'completion',
                undefined,
                { leaseAlreadyHeld: !!taskCheckoutLease },
              );
              if (mergeReady) {
                const entryEvent = await updateTask(
                  task.id,
                  {
                    ...(!agentMovedTask ? { status: completionStageId } : {}),
                    ...(reachedDoneStage ? { completed_at: completed_at } : {}),
                    session_id: result.newSessionId,
                    ...(willDispatchDeploy
                      ? {
                          custom_values: {
                            [DEPLOY_PENDING_DISPATCH_KEY]: completed_at,
                          },
                        }
                      : {}),
                  },
                  willDispatchDeploy ? { mergeCustomValues: true } : undefined,
                );
                stageEntryEventRef.id = entryEvent?.id;
                transitioned = true;
              }
            })
          : false;
        if (!mergeAllowed || !mergeReady) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
      }

      // A done status is a Git transaction boundary: never expose it until
      // the worktree has been committed and merged successfully.
      if (!transitioned) {
        transitioned = await updateTaskWithSteeringBarrier(
          task,
          targetStatus,
          {
            ...(!agentMovedTask ? { status: completionStageId } : {}),
            ...(reachedDoneStage ? { completed_at: completed_at } : {}),
            session_id: result.newSessionId,
          },
          stageEntryEventRef,
        );
      }
      if (!transitioned) {
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      if (reachedDoneStage) {
        // Trigger build+deploy only if deployService is configured
        if (
          !agentMovedTask &&
          completionStageId === getDeployStageId(group.settings, stages) &&
          group.settings?.deployService
        ) {
          const deployed = await runWithTaskSteeringBarrier(
            task,
            targetStatus,
            async () => {
              await triggerDeploy(task, group, {
                skipMerge: true,
                lifecycleRunId: executionRunId ?? task.id,
                stageEntryEventId: stageEntryEventRef.id,
              });
            },
          );
          if (!deployed) {
            await clearPendingDeployDispatch([task], { bestEffort: true });
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
          // Deploy owns the authoritative success/failure transition,
          // lifecycle notification, task event, and completion broadcast.
          // Returning here prevents this caller from assuming success.
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
        const notified = await runWithTaskSteeringBarrier(
          task,
          targetStatus,
          async () => {
            if (
              completionStageId !== getDeployStageId(group.settings, stages) ||
              !group.settings?.deployService
            ) {
              await notifyEntityLifecycle({
                group_folder: task.project_id,
                task_id: task.id,
                run_id: executionRunId ?? task.id,
                event: 'completed',
                title: `Task completed: ${task.title}`,
                defer_stage_entry: true,
                stage_entry_event_id: stageEntryEventRef.id,
              });
            }
            broadcast({
              type: 'task_completed',
              payload: { task_id: task.id, project_id: task.project_id },
            });
            publishEvent(
              resolveBrainUrl(resolveBrainContainer(group)),
              {
                type: 'task_completed',
                project_id: task.project_id,
                task_id: task.id,
                objective_id: task.objective_id ?? null,
                timestamp: new Date().toISOString(),
                data: {
                  ...taskEventHeaders(task, group),
                  status: completionStageId,
                },
              },
              group,
            );
            logger.info({ task_id: task.id }, 'Task execution completed');
          },
        );
        if (!notified) {
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
      } else if (movedToQueueStage) {
        const updated = await getTask(task.id);
        if (updated) {
          broadcast({ type: 'task_updated', payload: updated });
          if (isQuestionStage(stages, updated.status)) {
            await notifyEntityLifecycle({
              group_folder: updated.project_id,
              task_id: updated.id,
              run_id: executionRunId ?? updated.id,
              event: 'needs_input',
              title: `Task needs input: ${updated.title}`,
              defer_stage_entry: true,
              stage_entry_event_id: stageEntryEventRef.id,
            });
          }
        }
        logger.info(
          { task_id: task.id, stage: currentStageDef?.id },
          'Task execution ended in queue stage',
        );
      } else if (nextActiveStage) {
        // Advancing to the next active stage — emit update, not completion
        const updated = await getTask(task.id);
        if (updated) {
          broadcast({ type: 'task_updated', payload: updated });
        }
        logger.info(
          {
            task_id: task.id,
            fromStage: targetStatus,
            toStage: nextActiveStage.id,
          },
          'Task advancing to next active stage',
        );
      } else if (agentMovedTask) {
        // Agent moved the task to a different active stage — emit update, not completion
        const updated = await getTask(task.id);
        if (updated) {
          broadcast({ type: 'task_updated', payload: updated });
        }
        logger.info(
          { task_id: task.id, newStatus: current?.status },
          'Agent moved task to a different stage',
        );
      }
    } else {
      // If the task was stopped by the user, stopTask() already set the correct
      // status (backlog) and appended the "Stopped by user." message.
      // Don't overwrite that with a failure status or increment the failure counter.
      // But DO save any streamed output so the transcript is visible.
      if (abort.signal.aborted) {
        return;
      }

      // Classify the raw text (its length and shape matter); store the capped one.
      const rawError = result.error || 'Agent produced no output';
      let error = capErrorText(rawError);
      let transientRetriesExhausted: Record<string, string | number> | null =
        null;
      const failedAt = new Date().toISOString();

      if (automaticStageEntryEventId) {
        execFailed = true;
        await persistAutomaticStageEntryFailure({
          eventId: automaticStageEntryEventId,
          task,
          enteredStageId: targetStatus,
          error,
          output: turnOutput,
          agentName: agent_name,
          modelName: model_name,
          runId: executionRunId,
          sessionId: result.newSessionId,
        });
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      // The provider account has lost its login: every retry would fail the
      // same way until a human reconnects it. Park the card in its queue stage
      // held for that login, without a failure or a counted transient retry.
      const credentialProvider = missingCredentialProvider(rawError);
      // The queue can only hold a card whose provider it resolves, and only
      // while Box does not list that provider as usable. A card that is not
      // held would restart at once and fail the same way without limit, so
      // any other card takes the normal failure path.
      if (
        credentialProvider &&
        queueProviderForTask((await getTask(task.id)) ?? task, group) ===
          credentialProvider &&
        (await holdProviderForCredentialError(credentialProvider))
      ) {
        await holdTaskForProviderLogin(task, group, credentialProvider, {
          sessionId: result.newSessionId,
          agentName: agent_name,
          modelName: model_name,
        });
        // Neither a success nor a failure for the project failure breaker.
        transientRetryScheduled = true;
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      // A tester run that died on a transient provider error (e.g. 529
      // overloaded) is not a Testing verdict. Unless the transport-recovery
      // path above already preserved tester evidence, retry in place with
      // backoff (shared with the active-stage path below); an exhausted
      // budget or non-retryable error still blocks the task.
      const isTesting = isTestingStage(stages, targetStatus);
      const testingTransientPlan =
        isTesting &&
        !testingTransportRecovery &&
        !isFatalConfigError(rawError, agent_name || undefined) &&
        isRetryableTaskError(error)
          ? await planTransientRetry(task)
          : null;

      if (
        isTesting &&
        !(testingTransientPlan && !testingTransientPlan.exhausted)
      ) {
        if (testingTransientPlan) {
          // Budget exhausted: reset the counter so a manual re-run starts fresh.
          await updateTask(task.id, {
            custom_values: testingTransientPlan.customValues,
          });
        }
        const stageEntryEventRef: StageEntryEventRef = {};
        await handleTestingBlocked(error, {
          task,
          group,
          stages,
          targetStatus,
          assistantContent: turnOutput,
          agent_name,
          model_name,
          newSessionId: result.newSessionId,
          runId: executionRunId ?? undefined,
          stageEntryEventRef,
        });
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      // --- Fatal configuration errors (wrong model, bad API key, missing agent) ---
      // Rewrite the error message and skip the retryable check below.
      // The normal failure path handles everything else (task update, messages,
      // events, brain notification, logging).
      const isFatalConfig = isFatalConfigError(
        rawError,
        agent_name || undefined,
      );
      if (isFatalConfig) {
        error = `⚠️ Configuration error: ${error}\nCheck the agent_cmd and model settings.`;
        logger.error(
          { task_id: task.id, error },
          'Fatal configuration error — will not retry',
        );
      }

      // --- Retryable transient errors (e.g. Anthropic 529 Overloaded) ---
      // Instead of moving to the failed stage, keep the task in its current
      // active stage and schedule a delayed retry via drainProjectQueue.
      const transientPlan =
        testingTransientPlan ??
        (!isFatalConfig && isRetryableTaskError(error)
          ? await planTransientRetry(task)
          : null);
      if (transientPlan && transientPlan.exhausted) {
        error = `Transient error retries exhausted after ${transientPlan.attempts} attempts: ${formatTransientTaskError(error)}`;
        transientRetriesExhausted = transientPlan.customValues;
        logger.error(
          { task_id: task.id, error },
          'Transient error retry budget exhausted — failing task',
        );
      } else if (transientPlan) {
        logger.info(
          {
            task_id: task.id,
            error,
            delayMs: transientPlan.delayMs,
            attempt: transientPlan.attempts,
          },
          'Transient API error detected — will retry after delay',
        );

        // Keep task in its current stage (don't move to failed), but retain a
        // concise retry marker so the board does not present the task as still
        // running while it waits for the delayed retry. The next execution's
        // pre-flight update clears this marker.
        const transientError = formatTransientTaskError(error);
        await updateTask(task.id, {
          error: `Retry scheduled: ${transientError}`,
          output: '',
          custom_values: transientPlan.customValues,
          ...(result.newSessionId ? { session_id: result.newSessionId } : {}),
        });
        broadcast({
          type: 'task_updated',
          payload: { task_id: task.id, project_id: task.project_id },
        });

        // Notify UI about the transient error
        const retryMsg = appendTaskMessageDedup(task.project_id, {
          task_id: task.id,
          role: 'assistant',
          content: `⏳ ${transientError}\nWill retry automatically in ${Math.round(transientPlan.delayMs / 60_000)} minutes (attempt ${transientPlan.attempts} of ${MAX_TRANSIENT_ATTEMPTS}).`,
          agent_name: agent_name,
          model_name: model_name,
          // Capture immediately before the append: `failedAt` was set before
          // the `updateTask` above, so a follow-up posted in this gap would
          // have a strictly later `created_at`. The read-side sort still
          // handles any remaining out-of-order writers.
          created_at: new Date().toISOString(),
        });
        if (retryMsg) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: retryMsg,
            },
          });
        }

        // Reserve this task's slot during the backoff, then retry it before
        // unrelated queued work. execFailed stays false, and
        // transientRetryScheduled keeps the project failure breaker as-is.
        transientRetryScheduled = true;
        scheduleTransientTaskRetry(
          task.id,
          task.project_id,
          group,
          drainProjectQueue,
          transientPlan.delayMs,
        );

        return; // Skip normal failure handling
      }

      if (await continueReviewChainAfterFailure(error, result.newSessionId)) {
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }
      execFailed = true;
      // On failure: move to failed stage so drainProjectQueue won't re-pick this task
      const failedStage = getFailedStage(stages);
      const failedStageEntryEvent = await updateTask(task.id, {
        status: failedStage?.id ?? 'failed',
        error,
        completed_at: failedAt,
        ...(transientRetriesExhausted
          ? { custom_values: transientRetriesExhausted }
          : {}),
        // Preserve session_id so Continue can resume even after a failed run
        ...(result.newSessionId ? { session_id: result.newSessionId } : {}),
      });

      // Preserve any streamed output as an assistant message so it's visible in the UI
      if (turnOutput.trim()) {
        const outputMsg = appendTaskMessageDedup(task.project_id, {
          task_id: task.id,
          role: 'assistant',
          content: turnOutput,
          agent_name: agent_name,
          model_name: model_name,
          entry_type: 'run_result',
          run_id: executionRunId,
          // Capture immediately before the append: `failedAt` was set before
          // the `updateTask` above, so a follow-up posted in this gap would
          // have a strictly later `created_at`.
          created_at: new Date().toISOString(),
        });
        if (outputMsg) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: outputMsg,
            },
          });
        }
      }

      // Store error as assistant message
      const errMsg = appendTaskMessageDedup(task.project_id, {
        task_id: task.id,
        role: 'assistant',
        content: `Error: ${error}`,
        agent_name: agent_name,
        model_name: model_name,
        // Capture immediately before the append: see `outputMsg` above.
        created_at: new Date().toISOString(),
      });
      if (errMsg) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: errMsg,
          },
        });
      }

      await publishExecutionFailure(
        { ...task, status: failedStage?.id ?? 'failed' },
        group,
        error,
        executionRunId ?? nextPreflightFailureRunId(task.id),
        failedStageEntryEvent?.id,
      );
      broadcast({
        type: 'task_error',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          error,
        },
      });
      logger.warn({ task_id: task.id, error }, 'Task execution failed');
    }
  } catch (err) {
    // Test seams may propagate the slot callback exception directly instead of
    // converting it to a ContainerOutput. The evidence guard already handled
    // the stage transition and notice, so do not overwrite it as a run failure.
    if (reviewDeferredAtSlot) return;
    if (await finishGuardedReviewChain()) return;
    if (await finishGuardedTestingChain()) return;
    // If the task was stopped by the user, stopTask already handled status/cleanup.
    // Don't overwrite its backlog status with failed/completed.
    // But DO save any streamed output so the transcript is visible.
    if (abort.signal.aborted) {
      return;
    }

    // The recovery coordinator owns setup failures until the runner confirms
    // it has attached to the precreated continuation row. Let that coordinator
    // apply one interruption failure instead of emitting a second artifact.
    if (restartRecovery && !restartHandoffCompleted) {
      execFailed = true;
      throw err;
    }

    let error = capErrorText(err instanceof Error ? err.message : String(err));
    if (
      !executionRunId &&
      deferTaskActivation &&
      task.status !== targetStatus
    ) {
      const dependencyBlocked = isDependencyCommitMissingError(error);
      await updateTask(
        task.id,
        {
          status: task.status,
          error: dependencyBlocked
            ? `Dependency checkout blocked: ${error}`
            : `Run failed before launch: ${error}`,
          output: '',
          completed_at: null,
        },
        { suppressStageEntryEvent: true },
      );
      broadcast({
        type: 'task_error',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          error,
        },
      });
      // A manual run that never launched (sandbox or MCP outage) is not a
      // task failure: it must not count toward the project failure breaker.
      if (dependencyBlocked) execFailed = true;
      else uncountedPreLaunchFailure = true;
      return;
    }
    const errorAt = new Date().toISOString();

    if (automaticStageEntryEventId) {
      execFailed = true;
      await persistAutomaticStageEntryFailure({
        eventId: automaticStageEntryEventId,
        task,
        enteredStageId: targetStatus,
        error,
        output: turnOutput,
        agentName: agent_name,
        modelName: model_name,
        runId: executionRunId,
      });
      clearTaskStream(task.id, task.project_id, false, false, executionRunId);
      return;
    }

    // Review preparation runs before the Testing worker exists. A checkpoint
    // failure here is infrastructure state, not a tester verdict. Park the
    // task once for an explicit retry instead of emitting `testing_feedback`;
    // the latter moves the card to a queue stage and can provoke recovery
    // coordinators into an immediate Testing -> blocked loop.
    if (
      !executionRunId &&
      isTestingStage(stages, targetStatus) &&
      err instanceof TaskReviewPreparationError
    ) {
      execFailed = true;
      await parkTaskAfterGitCheckpointFailure(task, stages, err);
      clearTaskStream(task.id, task.project_id, false, false, executionRunId);
      return;
    }

    // A sandbox/git outage before the tester launches is not a Testing
    // verdict. Keep the task in Testing and retry with backoff instead of
    // manufacturing a blocked verdict and moving it to Question/Backlog.
    const preLaunchRetry =
      !executionRunId && isRetryableTaskError(error)
        ? await planTransientRetry(task)
        : null;
    if (preLaunchRetry && !preLaunchRetry.exhausted) {
      const transientError = formatTransientTaskError(error);
      await updateTask(task.id, {
        status: targetStatus,
        error: `Retry scheduled: ${transientError}`,
        output: '',
        completed_at: null,
        custom_values: preLaunchRetry.customValues,
      });
      broadcast({
        type: 'task_updated',
        payload: { task_id: task.id, project_id: task.project_id },
      });
      transientRetryScheduled = true;
      scheduleTransientTaskRetry(
        task.id,
        task.project_id,
        group,
        drainProjectQueue,
        preLaunchRetry.delayMs,
      );
      clearTaskStream(task.id, task.project_id, false, false, executionRunId);
      return;
    }
    if (preLaunchRetry) {
      // Budget exhausted: fail the task (below) with an explicit message and
      // a cleared counter.
      error = `Transient error retries exhausted after ${preLaunchRetry.attempts} attempts: ${formatTransientTaskError(error)}`;
    }

    // Only a launched tester run can produce a blocked verdict; an error
    // thrown before launch (no run id) takes the normal failure path below.
    if (executionRunId && isTestingStage(stages, targetStatus)) {
      const stageEntryEventRef: StageEntryEventRef = {};
      await handleTestingBlocked(error, {
        task,
        group,
        stages,
        targetStatus,
        assistantContent: turnOutput,
        agent_name,
        model_name,
        runId: executionRunId ?? undefined,
        stageEntryEventRef,
        beforeTransition: (changes?: Parameters<typeof updateTask>[1]) =>
          updateTaskWithSteeringBarrier(
            task,
            targetStatus,
            changes ?? {},
            stageEntryEventRef,
          ),
      });
      clearTaskStream(task.id, task.project_id, false, false, executionRunId);
      return;
    }

    // Check if the agent run itself completed successfully before this error.
    // If so, the error is only in post-processing (cleanup, transcript, git) —
    // don't mark the task as failed since the agent did finish its work.
    const last_run = await getLastActiveRunForTask(task.id);
    // Only this execution's own run counts: a pre-launch throw
    // (executionRunId null) must not inherit a previous stage's completed run.
    const runCompletedOk =
      !preLaunchRetry &&
      !!executionRunId &&
      last_run?.id === executionRunId &&
      last_run.status === 'completed';

    if (runCompletedOk) {
      const failedDuringReview = isReviewStage(stages, targetStatus);
      logger.warn(
        { task_id: task.id, runId: last_run.id, error, failedDuringReview },
        failedDuringReview
          ? 'Post-processing error after review run — parking task in the initial stage'
          : 'Post-processing error after successful agent run — task will still advance through the pipeline',
      );
      // Mirror the normal in-process success path at line ~1088: advance to
      // the next active/review stage (e.g. `review`) instead of jumping
      // straight to the done stage. Without this, a post-success throw in
      // the try block (e.g. DB blip on `getTask`, appendTaskMessage failure)
      // silently bypasses every `review` stage in the pipeline. The in-process
      // success path would have called this same lookup if it had the chance
      // — we are doing its job because the crash happened before it could.
      const nextActiveStage = getNextActiveStage(
        stages,
        targetStatus,
        task.skip_stages ?? undefined,
      );
      const completionStageId =
        nextActiveStage?.id ?? getDoneStage(stages)?.id ?? 'completed';
      const recoveryReachesDone =
        findStage(stages, completionStageId)?.type === 'done';
      if (!failedDuringReview && recoveryReachesDone) {
        try {
          const checkpointTask = (await getTask(task.id)) ?? task;
          let mergeReady = false;
          const mergeAllowed = await runWithTaskSteeringBarrier(
            task,
            targetStatus,
            async () => {
              mergeReady = await (
                options?.testDependencies?.mergeBranchForDeploy ??
                mergeBranchForDeploy
              )(
                checkpointTask,
                group,
                group.settings?.deployService ? 'recovery' : 'completion',
                undefined,
                { leaseAlreadyHeld: !!taskCheckoutLease },
              );
            },
          );
          if (!mergeAllowed || !mergeReady) {
            clearTaskStream(
              task.id,
              task.project_id,
              false,
              false,
              executionRunId,
            );
            return;
          }
        } catch (checkpointError) {
          execFailed = true;
          const retryStageId = getInitialStage(stages)?.id ?? task.status;
          await updateTask(task.id, {
            status: retryStageId,
            completed_at: null,
          });
          const checkpointNotice = appendTaskMessage(task.project_id, {
            task_id: task.id,
            role: 'system',
            entry_type: 'system_notice',
            content:
              `**Task checkpoint failed** — post-processing could not finalize this run in Git. ` +
              `The task was paused in \`${retryStageId}\` and was not completed.\n\n${String(checkpointError)}`,
            created_at: new Date().toISOString(),
          });
          if (checkpointNotice) {
            broadcast({
              type: 'task_message',
              payload: {
                task_id: task.id,
                project_id: task.project_id,
                message: checkpointNotice,
              },
            });
          }
          clearTaskStream(
            task.id,
            task.project_id,
            false,
            false,
            executionRunId,
          );
          return;
        }
      }
      // Review is executable: leaving the task there would relaunch the
      // reviewer without limit. Park it like a checkpoint failure instead.
      const reviewParkStageId = getInitialStage(stages)?.id ?? task.status;
      if (failedDuringReview) execFailed = true;
      const willDispatchDeploy =
        !failedDuringReview &&
        recoveryReachesDone &&
        !!group.settings?.deployService &&
        completionStageId === getDeployStageId(group.settings, stages);
      const stageEntryEventRef: StageEntryEventRef = {};
      const recovered = await updateTaskWithSteeringBarrier(
        task,
        targetStatus,
        failedDuringReview
          ? { status: reviewParkStageId, completed_at: null }
          : {
              status: completionStageId,
              completed_at: recoveryReachesDone ? errorAt : null,
              ...(willDispatchDeploy
                ? {
                    custom_values: {
                      [DEPLOY_PENDING_DISPATCH_KEY]: errorAt,
                    },
                  }
                : {}),
            },
        stageEntryEventRef,
        willDispatchDeploy ? { mergeCustomValues: true } : undefined,
      );
      if (!recovered) {
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      // Review verdicts remain available in the raw run log. If verdict
      // post-processing failed, do not leak their JSON into a chat bubble.
      if (failedDuringReview) {
        const notice = appendTaskMessage(task.project_id, {
          task_id: task.id,
          role: 'system',
          entry_type: 'system_notice',
          content:
            `**Review post-processing failed** — the task was paused in \`${reviewParkStageId}\`. ` +
            `The approved branch may already be merged into the default branch; check before re-queuing.\n\n${error}`,
          created_at: new Date().toISOString(),
        });
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: notice,
          },
        });
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
      } else if (turnOutput.trim()) {
        const outputMsg = appendTaskMessageDedup(task.project_id, {
          task_id: task.id,
          role: 'assistant',
          content: turnOutput,
          agent_name: agent_name,
          model_name: model_name,
          entry_type: 'run_result',
          run_id: executionRunId,
          // Capture immediately before the append: `errorAt` was set before
          // the `updateTask` above, so a follow-up posted in this gap would
          // have a strictly later `created_at`.
          created_at: new Date().toISOString(),
        });
        if (outputMsg) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: outputMsg,
            },
          });
        }
      }

      const effectsAllowed = await runWithTaskSteeringBarrier(
        task,
        targetStatus,
        async () => {
          if (!failedDuringReview && recoveryReachesDone) {
            if (
              group.settings?.deployService &&
              completionStageId === getDeployStageId(group.settings, stages)
            ) {
              await triggerDeploy(task, group, {
                skipMerge: true,
                lifecycleRunId: executionRunId ?? task.id,
                stageEntryEventId: stageEntryEventRef.id,
              });
              return;
            }
            await notifyEntityLifecycle({
              group_folder: task.project_id,
              task_id: task.id,
              run_id: executionRunId ?? task.id,
              event: 'completed',
              title: `Task completed: ${task.title}`,
              defer_stage_entry: true,
              stage_entry_event_id: stageEntryEventRef.id,
            });
            broadcast({
              type: 'task_completed',
              payload: { task_id: task.id, project_id: task.project_id },
            });
            publishEvent(
              resolveBrainUrl(resolveBrainContainer(group)),
              {
                type: 'task_completed',
                project_id: task.project_id,
                task_id: task.id,
                objective_id: task.objective_id ?? null,
                timestamp: errorAt,
                data: {
                  ...taskEventHeaders(task, group),
                  postProcessingError: error,
                },
              },
              group,
            );
          } else if (!failedDuringReview) {
            const advanced = await getTask(task.id);
            if (advanced)
              broadcast({ type: 'task_updated', payload: advanced });
          }
        },
      );
      if (!effectsAllowed) {
        if (willDispatchDeploy) {
          await clearPendingDeployDispatch([task], { bestEffort: true });
        }
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }
    } else {
      execFailed = true;

      // Kill the agent process if it's still running (e.g. inactivity timeout)
      killAgentProcess(task.id).catch((killErr) => {
        logger.warn(
          { task_id: task.id, error: String(killErr) },
          'Failed to kill agent on error',
        );
      });

      if (await continueReviewChainAfterFailure(error)) {
        // The chain took over: this is not a failed task.
        execFailed = false;
        clearTaskStream(task.id, task.project_id, false, false, executionRunId);
        return;
      }

      // On error: move to failed stage so drainProjectQueue won't re-pick this task
      const failedStage = getFailedStage(stages);
      const failedStageEntryEvent = await updateTask(task.id, {
        status: failedStage?.id ?? 'failed',
        error,
        completed_at: errorAt,
        ...(preLaunchRetry
          ? { custom_values: preLaunchRetry.customValues }
          : {}),
      });

      // Preserve any streamed output as an assistant message so it's visible in the UI
      if (turnOutput.trim()) {
        const outputMsg = appendTaskMessageDedup(task.project_id, {
          task_id: task.id,
          role: 'assistant',
          content: turnOutput,
          agent_name: agent_name,
          model_name: model_name,
          entry_type: 'run_result',
          run_id: executionRunId,
          // Capture immediately before the append: `errorAt` was set before
          // the `updateTask` above, so a follow-up posted in this gap would
          // have a strictly later `created_at`.
          created_at: new Date().toISOString(),
        });
        if (outputMsg) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: task.project_id,
              message: outputMsg,
            },
          });
        }
      }

      // Store error as assistant message
      const errMsg = appendTaskMessageDedup(task.project_id, {
        task_id: task.id,
        role: 'assistant',
        content: `Error: ${error}`,
        agent_name: agent_name,
        model_name: model_name,
        // Capture immediately before the append: see `outputMsg` above.
        created_at: new Date().toISOString(),
      });
      if (errMsg) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: errMsg,
          },
        });
      }

      broadcast({
        type: 'task_error',
        payload: { task_id: task.id, project_id: task.project_id, error },
      });
      await publishExecutionFailure(
        { ...task, status: failedStage?.id ?? 'failed' },
        group,
        error,
        executionRunId ?? nextPreflightFailureRunId(task.id),
        failedStageEntryEvent?.id,
      );
      logger.error({ task_id: task.id, error }, 'Task execution error');
    }
  } finally {
    logger.info(
      { task_id: task.id, execFailed },
      'Task execution finally block',
    );
    stageHandoffs.delete(task.id);

    // runContainerAgent owns the active_run lifecycle, but task cleanup must
    // never release its queue slot while a DB row still says it is running.
    // Early setup failures (notably mandatory worktree creation) historically
    // returned before finalizing that row, leaving the UI pulsing and every
    // subsequent drain blocked until a board restart recovered it.
    try {
      const finalizedRunId = await finalizeOwnedActiveRun(
        task.id,
        abort,
        executionRunId,
        execFailed || isAbortedExecution(abort) ? 'error' : 'completed',
      );
      if (finalizedRunId) {
        logger.warn(
          { task_id: task.id, runId: finalizedRunId, execFailed },
          'Finalized dangling active run during task cleanup',
        );
      }
    } catch (err) {
      logger.warn(
        { err, task_id: task.id },
        'Failed to finalize dangling active run during task cleanup',
      );
    }
    const releaseClaimAndDrain = () => {
      // stopTask() releases the old claim before its aborted execution finishes,
      // allowing an immediate re-run. Do not let this older finally block erase
      // the newer run's claim, running marker, or output accounting.
      finishOwnedTaskExecution(
        task.id,
        task.project_id,
        abort,
        taskStartedRunId,
      );
      if (automaticStageEntryEventId) {
        const drain =
          options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
        drain(task.project_id, group);
      } else if (execFailed) {
        const prev = projectConsecutiveFailures.get(task.project_id);
        const count = (prev?.count ?? 0) + 1;
        if (count < MAX_CONSECUTIVE_FAILURES) {
          projectConsecutiveFailures.set(task.project_id, { count });
          const drain =
            options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
          drain(task.project_id, group);
        } else {
          projectConsecutiveFailures.set(task.project_id, {
            count,
            blockedAt: prev?.blockedAt ?? Date.now(),
          });
          scheduleFailureCooldownDrain(
            task.project_id,
            group,
            options?.testDependencies?.drainProjectQueue ?? drainProjectQueue,
          );
          logger.warn(
            { project: task.project_id, consecutiveFailures: count },
            'Queue drain blocked due to consecutive failures (auto-resets after cooldown)',
          );
        }
      } else if (transientRetryScheduled || uncountedPreLaunchFailure) {
        // Transient retry or uncounted pre-launch failure: leave the failure
        // breaker untouched.
        const drain =
          options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
        drain(task.project_id, group);
      } else {
        clearProjectFailureState(task.project_id);
        const drain =
          options?.testDependencies?.drainProjectQueue ?? drainProjectQueue;
        drain(task.project_id, group);
      }
    };

    await (async () => {
      // onSlotAcquired records the first point at which an agent run exists.
      // Pre-launch validation failures cannot have produced changes to
      // checkpoint, and attempting Git cleanup for them can mask the real
      // error and incorrectly park the task in backlog.
      if (deployIntercepted || postExecutionGitOpsHandled || !executionRunId)
        return;
      try {
        await (
          options?.testDependencies?.runPostExecutionGitOps ??
          runPostExecutionGitOps
        )(checkoutTask, group, stages);
      } catch (err) {
        execFailed = true;
        await parkTaskAfterGitCheckpointFailure(task, stages, err);
      }
    })();

    // Atomically stop presenting this claim, release the successful-completion
    // lock, and wait for every message request that entered while the claim was
    // visible. Only a genuinely successful run may be restored for a same-stage
    // continuation; errors and user stops retain their terminal/manual status.
    // A newer run that claimed the task after a stop owns that state: closing
    // the window would mark its claim as finishing and release its lock.
    const currentClaim = claimedTasks.get(task.id);
    const supersededByNewerRun = !!currentClaim && currentClaim.abort !== abort;
    try {
      if (!supersededByNewerRun)
        await closeTaskSteeringAdmissionWindow(
          task,
          targetStatus,
          taskExecutionFinalizingStages.has(task.id) &&
            !execFailed &&
            !isAbortedExecution(abort),
          undefined,
          executionRunId ?? undefined,
        );
    } catch (error) {
      logger.error(
        { task_id: task.id, error: String(error) },
        'Failed to close task steering admission window',
      );
      if (
        taskExecutionFinalizingStages.has(task.id) &&
        !execFailed &&
        !isAbortedExecution(abort)
      ) {
        await updateTask(task.id, {
          status: targetStatus,
          completed_at: null,
        }).catch((restoreError) =>
          logger.error(
            { task_id: task.id, error: String(restoreError) },
            'Failed to restore task after steering synchronization error',
          ),
        );
      }
    }

    releaseClaimAndDrain();

    // If this task was spawned by a dataset task, advance only after its full
    // lifecycle is terminal. A successful implementation turn may merely move
    // into review (or another active stage), and advancing here used to spawn
    // the next dataset row while the current row was still unfinished.
    // Genuine failures remain terminal for dataset purposes so one bad row
    // cannot leave the dataset stuck indefinitely.
    if (task.dataset_task_id) {
      try {
        const finalTask = await getTask(task.id);
        const finalStage = findStage(stages, finalTask?.status ?? task.status);
        if (shouldAdvanceDatasetProgress(execFailed, finalStage)) {
          await onDatasetTaskCompleted(task);
        }
      } catch (err) {
        logger.error(
          { err, task_id: task.id, dataset_task_id: task.dataset_task_id },
          'Failed to advance dataset task progress',
        );
      }
    }
    await releaseTaskAdmission(
      task.project_id,
      task.id,
      options?.admissionOwnerToken,
    ).catch((error) =>
      logger.warn(
        { error: String(error), task_id: task.id },
        'Failed to release durable task admission marker',
      ),
    );
    // This run's own claim is already released, so any claim present now
    // belongs to a newer run (a stop followed by an immediate re-run). Release
    // the finalization state and completion lock this run installed, but keep
    // whatever the newer run installed, as well as its starting stage.
    if (!isFinalizationStateOfNewerRun(task.id, abort)) {
      taskExecutionFinalizingStages.delete(task.id);
      taskFinalizationOwners.delete(task.id);
      taskSteeringCompletionCutoffs.delete(task.id);
      taskSteeringCompletionRunIds.delete(task.id);
      closedTaskSteeringClaims.delete(task.id);
      const releaseCompletion = taskCompletionLockReleases.get(task.id);
      if (releaseCompletion) {
        taskCompletionLockReleases.delete(task.id);
        releaseCompletion();
      }
    }
    clearInterval(taskLeaseHeartbeat);
    await taskCheckoutLease?.release();
    if (!claimedTasks.has(task.id)) {
      taskExecutionStartingStages.delete(task.id);
    }
  }
}

export function shouldConsumeExecuteInStage(
  executeInStage: string | null | undefined,
  startingStage: string,
): boolean {
  return !!executeInStage && executeInStage === startingStage;
}

// ---------------------------------------------------------------------------
// Dataset task helpers
// ---------------------------------------------------------------------------

/**
 * Replace {{placeholders}} in a template string with values from a dataset row.
 */
function fillPlaceholders(
  template: string,
  row: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in row ? String(row[key]) : match;
  });
}

/**
 * Spawn a task for the next unprocessed row in a dataset task.
 * Returns the created task, or null if no rows remain or task is paused/completed.
 */
export async function spawnNextDatasetRow(
  dt: DatasetTask,
  group: RegisteredGroup,
  options: {
    manual?: boolean;
    ownerUserId?: string | null;
    triggeredByUserId?: string | null;
    triggerSource?: TriggerSource;
  } = {},
): Promise<Task | null> {
  if (dt.status !== 'active') return null;
  if (dt.archived) return null;
  if (dt.objective_id && !options.manual) {
    const objective = await getObjective(dt.objective_id);
    if (!objective || objective.status !== 'active') {
      logger.info(
        {
          dataset_task_id: dt.id,
          objective_id: dt.objective_id,
          objective_status: objective?.status ?? 'missing',
        },
        'Dataset task waiting for active objective',
      );
      return null;
    }
  }
  if (dt.current_row_index >= dt.total_rows) {
    // Await the update (it re-reads the row) so the broadcast payload is the
    // persisted completed dataset task, not a pending write.
    const completedDt = await updateDatasetTask(dt.id, {
      status: 'completed',
    });
    if (completedDt)
      broadcast({ type: 'dataset_task_updated', payload: completedDt });
    return null;
  }

  const row = dt.dataset[dt.current_row_index];
  if (!row) return null;

  const stages = getGroupStages(group);
  const activeStage = getFirstExecutableStage(stages);
  const initialStage = getInitialStage(stages);
  const targetStage = activeStage ?? initialStage;

  if (!targetStage) {
    logger.error(
      { dataset_task_id: dt.id },
      'No valid stage found for dataset task; skipping row',
    );
    return null;
  }

  const description = fillPlaceholders(dt.description, row);
  const title = fillPlaceholders(dt.title, row);

  const task = await createDatasetRowTask({
    project_id: dt.project_id,
    title: `${title} [${dt.current_row_index + 1}/${dt.total_rows}]`,
    description,
    status: targetStage.id,
    priority: 0,
    runtimeSelection: dt.runtimeSelection ?? undefined,
    runtimeSelectionStage: dt.runtimeSelectionStage ?? undefined,
    objective_id: dt.objective_id ?? undefined,
    dataset_task_id: dt.id,
    dataset_row_index: dt.current_row_index,
    author: 'dataset_task',
    ownerUserId: options.ownerUserId,
    lastTriggeredByUserId: options.triggeredByUserId,
    lastTriggerSource: options.triggerSource,
    lastTriggeredAt: new Date().toISOString(),
  });
  if (!task) return null;

  broadcast({ type: 'task_created', payload: task });
  logger.info(
    {
      dataset_task_id: dt.id,
      task_id: task.id,
      rowIndex: dt.current_row_index,
      total_rows: dt.total_rows,
    },
    'Dataset task spawned task for row',
  );

  // Trigger queue drain so the task starts executing
  drainProjectQueue(dt.project_id, group, {
    allowInactiveObjectiveTaskId: options.manual ? task.id : undefined,
  });

  return task;
}

/**
 * Called when a task spawned by a dataset task completes.
 * Advances the dataset task and spawns the next row if available.
 */
export async function onDatasetTaskCompleted(task: Task): Promise<void> {
  if (task.dataset_task_id == null || task.dataset_row_index == null) return;

  // Claim this exact row atomically. Duplicate completions and stale finally
  // blocks become no-ops once the dataset has moved to another row.
  const updated = await incrementDatasetTaskProgress(task.id);
  if (!updated) return;

  broadcast({ type: 'dataset_task_updated', payload: updated });

  if (
    updated.status === 'active' &&
    updated.current_row_index < updated.total_rows
  ) {
    const group = groupResolver ? groupResolver(updated.project_id) : undefined;
    if (group) {
      await spawnNextDatasetRow(updated, group);
    }
  }
}

/**
 * Resume active dataset tasks after a board restart.
 * For each incomplete dataset task, check whether the current row's kanban task
 * still exists and is being processed. If not, spawn the next row.
 */
export async function resumeActiveDatasetTasks(): Promise<void> {
  const activeDts = await getIncompleteActiveDatasetTasks();
  if (activeDts.length === 0) return;

  logger.info(
    { count: activeDts.length },
    'Resuming active dataset tasks after restart',
  );

  for (const dt of activeDts) {
    const group = groupResolver ? groupResolver(dt.project_id) : undefined;
    if (!group) {
      logger.warn(
        { dataset_task_id: dt.id, project_id: dt.project_id },
        'No registered group for dataset task project, skipping resume',
      );
      continue;
    }

    // Check if there's already a pending/running task for the current row
    const stages = getGroupStages(group);
    const rowTask = await getCurrentDatasetRowTask(dt.id, dt.current_row_index);

    if (rowTask) {
      const stageDef = findStage(stages, rowTask.status);
      // Failure parking uses getFailedStage, which falls back to the first
      // queue stage when the project defines no explicit 'failed' stage.
      // Queue-stage tasks are never picked up by the drain, so a failed row
      // parked there is terminal too. The failure markers (always set by the
      // parking sites) keep never-run rows — e.g. in configs with no active
      // stage, where rows spawn straight into that stage — from being
      // counted as completed.
      const failedStageId = getFailedStage(stages)?.id;
      const failedRowInFallbackStage =
        failedStageId !== undefined &&
        rowTask.status === failedStageId &&
        (rowTask.error != null || rowTask.completed_at != null);
      // If the row task is already in a done/failed stage but the dataset wasn't
      // advanced, manually advance and spawn next.
      if (
        stageDef?.type === 'done' ||
        isFailedStage(stages, rowTask.status) ||
        failedRowInFallbackStage
      ) {
        await onDatasetTaskCompleted(rowTask);
        continue;
      }
      // Task is still in an active/pending stage — drainProjectQueue will handle it
      continue;
    }

    // No task exists for the current row — spawn it
    await spawnNextDatasetRow(dt, group);
  }
}

// ---------------------------------------------------------------------------
// Queue draining
// ---------------------------------------------------------------------------

/** Projects whose drain was requested while boot held the queue. */
let heldQueueDrains: Map<string, RegisteredGroup> | null = null;

/**
 * Boot only: defer every project queue drain (a committed stage-entry hook
 * included) until `releaseQueueDrains`, so the deploy dispatch step can submit
 * recovered builds before anything moves those cards. Held calls return at
 * once and run on release.
 */
export function holdQueueDrains(): void {
  heldQueueDrains ??= new Map();
}

export function releaseQueueDrains(): void {
  const held = heldQueueDrains;
  heldQueueDrains = null;
  for (const [project_id, group] of held ?? []) {
    void drainProjectQueue(project_id, group).catch((error) =>
      logger.error(
        { project: project_id, error },
        'Failed to run a project queue drain held during boot',
      ),
    );
  }
}

/**
 * Drain the project queue: start pending active-stage tasks up to maxParallelWorktrees.
 * Called after a task completes, errors, or is stopped, and on startup.
 */
export async function drainProjectQueue(
  project_id: string,
  group: RegisteredGroup,
  options: {
    allowInactiveObjectiveTaskId?: string;
    recoverStageEntryClaims?: boolean;
    testDependencies?: QueueDrainTestDependencies;
  } = {},
): Promise<void> {
  if (heldQueueDrains) {
    heldQueueDrains.set(project_id, group);
    return;
  }
  await runSerializedProjectDrain(project_id, () =>
    drainProjectQueueInner(project_id, group, options),
  );
}

async function runSerializedProjectDrain(
  project_id: string,
  drain: () => Promise<void>,
): Promise<void> {
  // Per-project reentrance guard — prevents two concurrent drain calls from
  // both observing the same free slot and double-launching a task. Record a
  // concurrent request so the lock owner rechecks the queue after its current
  // snapshot instead of losing that wakeup.
  if (drainingProjects.has(project_id)) {
    pendingProjectDrains.add(project_id);
    return;
  }
  drainingProjects.add(project_id);
  let firstError: unknown;
  let hasError = false;
  try {
    while (true) {
      pendingProjectDrains.delete(project_id);
      try {
        await drain();
      } catch (err) {
        if (!hasError) {
          firstError = err;
          hasError = true;
        }
      }

      // A concurrent caller already returned after recording this request, so
      // honor it even when the preceding pass failed. Once the queue is quiet,
      // preserve the active caller's original failure contract.
      if (!pendingProjectDrains.delete(project_id)) {
        if (hasError) throw firstError;
        return;
      }
    }
  } finally {
    drainingProjects.delete(project_id);
  }
}

export const _testOnlyRunSerializedProjectDrain = runSerializedProjectDrain;

async function drainProjectQueueInner(
  project_id: string,
  group: RegisteredGroup,
  options: {
    allowInactiveObjectiveTaskId?: string;
    recoverStageEntryClaims?: boolean;
    testDependencies?: QueueDrainTestDependencies;
  } = {},
): Promise<void> {
  // Restart-when-idle drain mode: start nothing new on a sandbox that is
  // waiting to restart. The drain is re-run when the restart ends or is cancelled.
  const heldInstance = lifecycleSandboxInstance(resolveEffectiveSandbox(group));
  if (isTaskLaunchHeld(heldInstance)) {
    logger.debug(
      { project_id, sandboxInstance: heldInstance },
      'drainProjectQueue: held for pending sandbox restart',
    );
    return;
  }
  await reconcileStageEntryEventRuns();
  await resolveStaleStageEntryEvents(project_id);
  const stageEntryBarriers = await getBlockingStageEntryEvents(project_id);
  // Check consecutive failure block — auto-reset after cooldown period
  const failState = projectConsecutiveFailures.get(project_id);
  if (
    stageEntryBarriers.length === 0 &&
    failState &&
    failState.count >= MAX_CONSECUTIVE_FAILURES
  ) {
    if (
      failState.blockedAt &&
      Date.now() - failState.blockedAt >= FAILURE_COOLDOWN_MS
    ) {
      logger.info(
        { project: project_id },
        'Consecutive failure cooldown expired, resetting queue',
      );
      clearProjectFailureState(project_id);
    } else {
      logger.info(
        { project: project_id, failCount: failState.count },
        'drainProjectQueue: blocked by consecutive failures',
      );
      return; // Still in cooldown
    }
  }

  const settings = group.settings;
  const maxParallel = effectiveMaxParallel(settings);
  const stages = getGroupStages(group);

  // Manual worktree-isolated claims run outside configured automatic capacity.
  // Shared-checkout manual runs remain ordinary serialized claims.
  const inMemoryRunning = Array.from(claimedTasks.values()).filter(
    (run) => run.project_id === project_id && !run.bypassesAutomaticCapacity,
  ).length;

  // Also count DB-level running tasks not tracked in memory (e.g. after a restart,
  // orphaned runs still executing in their containers aren't in claimedTasks).
  // Use the project-scoped query: getActiveRunsByStatus has a global 500-row cap,
  // so unrelated busy projects could otherwise hide this project's active runs.
  const dbRunningTaskIdsForProject = new Set(
    (await getRunningTaskIdsForGroup(project_id)).filter(
      (id) => !claimedTasks.has(id),
    ),
  );
  const dbRunningForProject = dbRunningTaskIdsForProject.size;

  // A stop reservation can briefly outlive both the in-memory execution claim
  // and its DB row. Count only reservations not already represented by either
  // source so an old executeTask finally block cannot open a transient slot.
  const stoppingForProject = Array.from(stoppingTasks.entries()).filter(
    ([taskId, stopping]) =>
      stopping.project_id === project_id &&
      !stopping.bypassesAutomaticCapacity &&
      !claimedTasks.has(taskId) &&
      !dbRunningTaskIdsForProject.has(taskId),
  ).length;

  const currentlyRunning =
    inMemoryRunning + dbRunningForProject + stoppingForProject;
  await releaseIneligibleRetryReservations(project_id, stages);
  const reservedRetrySlots = Array.from(retryReservedTasks.values()).filter(
    (reservedProjectId) => reservedProjectId === project_id,
  ).length;
  const freeSlots = maxParallel - currentlyRunning - reservedRetrySlots;
  if (freeSlots <= 0) {
    logger.info(
      {
        project: project_id,
        maxParallel,
        inMemoryRunning,
        dbRunningForProject,
        stoppingForProject,
        reservedRetrySlots,
        claimedTaskIds: Array.from(claimedTasks.entries())
          .filter(([, r]) => r.project_id === project_id)
          .map(([id]) => id),
      },
      'drainProjectQueue: no free slots',
    );
    return;
  }

  // Block execution when project is paused or stopped
  const projectStatus = settings?.status ?? 'running';
  if (projectStatus === 'stopped' || projectStatus === 'paused') {
    logger.info(
      { project: project_id, projectStatus },
      'drainProjectQueue: project not running',
    );
    return;
  }

  if (stageEntryBarriers.length > 0) {
    let availableEntrySlots = freeSlots;
    const recoverClaimedBefore = options.recoverStageEntryClaims
      ? new Date().toISOString()
      : '1970-01-01T00:00:00.000Z';
    while (availableEntrySlots > 0) {
      const event = await claimNextStageEntryEvent(
        project_id,
        recoverClaimedBefore,
      );
      if (!event) break;
      const entryTask = await getTask(event.taskId);
      if (
        !entryTask ||
        entryTask.archived ||
        entryTask.status !== event.stageId
      ) {
        await resolveStaleStageEntryEvents(project_id);
        continue;
      }
      if (
        claimedTasks.has(entryTask.id) ||
        dbRunningTaskIdsForProject.has(entryTask.id)
      ) {
        await releaseStageEntryEventClaim(event.id);
        break;
      }
      let provisionalEntryClaim: AbortController | null = null;
      let admission: NormalTaskAdmission<AbortController>;
      try {
        admission = await claimNormalTaskAdmission(
          project_id,
          (taskCheckoutMode) => {
            provisionalEntryClaim = claimTaskExecution(
              entryTask.id,
              entryTask.project_id,
              taskCheckoutMode === 'worktree',
            );
            return provisionalEntryClaim;
          },
          true,
          entryTask.id,
          group.settings?.taskCheckoutMode ?? 'shared',
          (claim) => releaseTaskExecutionClaim(entryTask.id, claim),
        );
      } catch (error) {
        if (provisionalEntryClaim)
          releaseTaskExecutionClaim(entryTask.id, provisionalEntryClaim);
        await releaseStageEntryEventClaim(event.id);
        throw error;
      }
      const executionClaim = admission.claim;
      if (admission.taskCheckoutMode) {
        group.settings = {
          ...(group.settings ?? {}),
          taskCheckoutMode: admission.taskCheckoutMode,
        };
      }
      if (!executionClaim) {
        await releaseStageEntryEventClaim(event.id);
        break;
      }
      // The card can be archived or moved while admission is awaited. Do not
      // launch the entry from the snapshot read before it.
      let admittedTask: Task | undefined;
      try {
        admittedTask = await getTask(entryTask.id);
      } catch (error) {
        releaseTaskExecutionClaim(entryTask.id, executionClaim);
        await releaseTaskAdmission(
          project_id,
          entryTask.id,
          admission.ownerToken,
        );
        await releaseStageEntryEventClaim(event.id);
        throw error;
      }
      if (
        !admittedTask ||
        admittedTask.archived ||
        admittedTask.status !== event.stageId
      ) {
        releaseTaskExecutionClaim(entryTask.id, executionClaim);
        await releaseTaskAdmission(
          project_id,
          entryTask.id,
          admission.ownerToken,
        );
        await resolveStaleStageEntryEvents(project_id);
        continue;
      }
      const startEntry = options.testDependencies?.executeStageEntryTask;
      const execution = (
        startEntry
          ? startEntry(entryTask, group, event.id, executionClaim)
          : executeTask(entryTask, group, {
              executionClaim,
              admissionOwnerToken: admission.ownerToken,
              automaticStageEntryEventId: event.id,
              triggerAttribution: {
                triggeredByUserId: entryTask.lastTriggeredByUserId ?? null,
                triggerSource: 'system',
              },
              ...(options.testDependencies
                ? { testDependencies: options.testDependencies }
                : {}),
            })
      ).finally(() =>
        releaseTaskAdmission(project_id, entryTask.id, admission.ownerToken),
      );
      execution.catch(async (error) => {
        releaseTaskExecutionClaim(entryTask.id, executionClaim);
        await markStageEntryEventFailed(event.id, String(error));
        logger.error(
          {
            task_id: entryTask.id,
            stageEntryEventId: event.id,
            error: String(error),
          },
          'Unhandled automatic stage-entry execute error',
        );
        void drainProjectQueue(project_id, group, options).catch(
          (drainError) => {
            logger.error(
              {
                project: project_id,
                stageEntryEventId: event.id,
                error: String(drainError),
              },
              'Unhandled queue drain after automatic stage-entry rejection',
            );
          },
        );
      });
      availableEntrySlots -= 1;
    }
    // Any pending, claimed, or running entry event is a durable project
    // admission barrier. Existing work continues, but no ordinary candidate
    // starts until all nonterminal entry work has cleared.
    return;
  }

  // Find tasks sitting in executable stages that aren't currently running.
  const activeStageIds = stages
    .filter(
      (s) =>
        (s.type === 'active' || s.type === 'testing' || s.type === 'review') &&
        !s.inactive,
    )
    .map((s) => s.id);
  if (activeStageIds.length === 0) {
    logger.debug(
      { project: project_id },
      'drainProjectQueue: no active stage IDs',
    );
    return;
  }

  // Queue selection does not need the persisted output column. That field can
  // contain a very large transcript, and loading it for every task here can
  // exhaust the board process before the selected task even starts.
  const allTasks = await getTasksByProjectForQueue(project_id);
  const dbRunningTaskIds = dbRunningTaskIdsForProject;
  const candidateIds = new Set(
    await getWaitingTaskIds(project_id, options.allowInactiveObjectiveTaskId, {
      allTasks,
      dbRunningTaskIds,
      announceLoginHolds: true,
    }),
  );
  const candidates = allTasks.filter((task: Task) => candidateIds.has(task.id));

  // Sort by pipeline position descending so tasks in later stages (e.g. review)
  // are picked up before tasks in earlier stages (e.g. in_progress).
  // Within the same stage, preserve original priority ordering.
  const stageIndex = new Map(stages.map((s, i) => [s.id, i]));
  const sorted = candidates
    .slice()
    .sort(
      (a, b) =>
        Number(retryPriorityTasks.has(b.id)) -
          Number(retryPriorityTasks.has(a.id)) ||
        (stageIndex.get(b.status) ?? 0) - (stageIndex.get(a.status) ?? 0),
    );

  const toStart = sorted.slice(0, freeSlots);

  if (toStart.length === 0) {
    // Keep idle queue diagnostics available without flooding normal startup logs.
    const inActiveStage = allTasks.filter((f: Task) =>
      activeStageIds.includes(f.status),
    );
    const notRunning = inActiveStage.filter(
      (f: Task) => !claimedTasks.has(f.id) && !dbRunningTaskIds.has(f.id),
    );
    const passesExecStage = notRunning.filter((f: Task) => {
      if (f.execute_in_stage) return f.status === f.execute_in_stage;
      return true;
    });
    logger.debug(
      {
        project: project_id,
        freeSlots,
        activeStageIds,
        tasksInActiveStage: inActiveStage.map((f: Task) => ({
          id: f.id,
          status: f.status,
          execute_in_stage: f.execute_in_stage,
          depends_on_ids: f.depends_on_ids,
        })),
        notRunning: notRunning.length,
        passesExecStage: passesExecStage.length,
        waitingCandidateCount: candidates.length,
        candidateCount: candidates.length,
        claimedTaskIds: Array.from(claimedTasks.keys()),
        dbRunningTaskIds: Array.from(dbRunningTaskIds),
      },
      'drainProjectQueue: no candidates to start',
    );
  }

  for (const task of toStart) {
    // A/B parents use the same admission and claimed preflight as ordinary
    // runs, so their Git fork cannot overlap a start-over reset.
    await options.testDependencies?.beforeNormalAdmission?.();
    let provisionalClaim: AbortController | null = null;
    let admission: NormalTaskAdmission<AbortController>;
    try {
      admission = await claimNormalTaskAdmission(
        project_id,
        (taskCheckoutMode) => {
          provisionalClaim = claimTaskExecution(
            task.id,
            task.project_id,
            taskCheckoutMode === 'worktree',
          );
          return provisionalClaim;
        },
        false,
        task.id,
        group.settings?.taskCheckoutMode ?? 'shared',
        (claim) => releaseTaskExecutionClaim(task.id, claim),
        { taskId: task.id, stageId: task.status },
      );
    } catch (error) {
      if (provisionalClaim) {
        releaseTaskExecutionClaim(task.id, provisionalClaim);
      }
      throw error;
    }
    if (admission.blockedByEntry) {
      // Entry creation and this normal claim share the project row lock. The
      // committed-event wakeup requests the pass that will admit entry work.
      pendingProjectDrains.add(project_id);
      return;
    }
    const executionClaim = admission.claim;
    if (admission.taskCheckoutMode) {
      group.settings = {
        ...(group.settings ?? {}),
        taskCheckoutMode: admission.taskCheckoutMode,
      };
    }
    if (!executionClaim) continue;

    // A start-over can move the task, or an archive can remove it, while this
    // drain is waiting for admission. Do not launch the stage selected from
    // the old snapshot.
    let currentTask: Task | undefined;
    try {
      currentTask = await getTask(task.id);
    } catch (error) {
      releaseTaskExecutionClaim(task.id, executionClaim);
      await releaseTaskAdmission(project_id, task.id, admission.ownerToken);
      throw error;
    }
    if (
      !currentTask ||
      currentTask.archived ||
      currentTask.status !== task.status
    ) {
      releaseTaskExecutionClaim(task.id, executionClaim);
      await releaseTaskAdmission(project_id, task.id, admission.ownerToken);
      pendingProjectDrains.add(project_id);
      continue;
    }

    logger.info(
      { task_id: task.id, project: project_id, title: task.title },
      'Auto-starting queued task',
    );
    const testRunner = options.testDependencies?.executeTask;
    const execution = (
      testRunner
        ? testRunner(task, group, executionClaim).finally(() =>
            releaseTaskExecutionClaim(task.id, executionClaim),
          )
        : executeTask(task, group, {
            executionClaim,
            admissionOwnerToken: admission.ownerToken,
            ...(options.testDependencies
              ? { testDependencies: options.testDependencies }
              : {}),
          })
    ).finally(() =>
      releaseTaskAdmission(project_id, task.id, admission.ownerToken),
    );
    execution.catch((err) => {
      logger.error(
        { task_id: task.id, error: String(err) },
        'Unhandled execute error (drain)',
      );
    });
    if (admission.taskCheckoutMode !== 'worktree') return;
  }
}

// ---------------------------------------------------------------------------
// Task stopping
// ---------------------------------------------------------------------------

/**
 * Stop all running tasks for a given project.
 * Returns the number of tasks stopped.
 */
export async function stopAllProjectTasks(project_id: string): Promise<number> {
  const taskIds = new Set<string>();
  // In-process claims include tasks waiting for a semaphore slot as well as
  // tasks whose agents have started.
  for (const [id, claimed] of Array.from(claimedTasks.entries())) {
    if (claimed.project_id === project_id) taskIds.add(id);
  }

  // Also include DB-only runs. These are exactly the runs that an interrupted
  // setup path or a process-local bookkeeping loss can leave behind. Query by
  // project directly: getActiveRunsByStatus has a global 500-row cap, so a
  // busy unrelated project must not hide runs that the Stop action owns.
  for (const id of await getRunningTaskIdsForGroup(project_id)) {
    taskIds.add(id);
  }

  let count = 0;
  for (const id of taskIds) {
    if (await stopTask(id)) count++;
  }
  return count;
}

/** Cancel claimed tasks that are still waiting for a sandbox slot.
 * Their stage is preserved so a resume-time drain can claim them again. */
export async function cancelQueuedProjectTasks(
  project_id: string,
): Promise<number> {
  const cancelledTaskIds = new Set<string>();
  for (const [id, claimed] of Array.from(claimedTasks.entries())) {
    if (
      claimed.project_id !== project_id ||
      claimed.resetting ||
      claimed.forking ||
      runningTasks.has(id)
    )
      continue;
    claimed.abort.abort();
    claimedTasks.delete(id);
    cancelledTaskIds.add(id);
  }
  if (cancelledTaskIds.size > 0) {
    const barriers = await getUnresolvedStageEntryEvents(project_id);
    await Promise.all(
      barriers
        .filter(
          (event) =>
            event.state === 'claimed' && cancelledTaskIds.has(event.taskId),
        )
        .map((event) => releaseStageEntryEventClaim(event.id)),
    );
  }
  return cancelledTaskIds.size;
}

/**
 * Whether moving a card from `previousStatus` to `targetStatus` leaves the
 * stage of its running run. The run row records that stage, because the
 * card's status may already hold the new one. A claim without a run row has
 * no running stage yet.
 */
export async function isMoveAwayFromRunStage(
  task_id: string,
  previousStatus: string,
  targetStatus: string,
): Promise<boolean> {
  if (previousStatus === targetStatus) return false;
  const run = await getActiveRunForTask(task_id);
  return !!run && run.stage !== targetStatus;
}

/**
 * Stop a running task execution.
 * Returns true if the task was running (or claimed) and stop was initiated.
 * `keepStatus` is for callers that already persisted the card's new stage
 * (e.g. a move to another execution stage): the stop then leaves the status
 * and error untouched instead of returning the card to backlog.
 */
export async function stopTask(
  task_id: string,
  options: { keepStatus?: boolean } = {},
): Promise<boolean> {
  const claimed = claimedTasks.get(task_id);
  // Reset and Git fork have no agent to stop; their reservations must remain
  // until the in-flight operations settle.
  if (claimed?.resetting || claimed?.forking) return false;

  // Acknowledge duplicate Stop requests without racing the already-initiated
  // backlog write and queue wake-up.
  if (stoppingTasks.has(task_id)) return true;

  let activeRun: Awaited<ReturnType<typeof getActiveRunForTask>>;

  // After a restart, claimedTasks is empty but the DB may still have an
  // active_runs row with status='running' from the previous session.
  // Fall back to the DB so the stop button works for orphaned runs too.
  if (!claimed) {
    activeRun = await getActiveRunForTask(task_id);
    if (!activeRun || activeRun.status !== 'running') return false;

    stoppingTasks.set(task_id, { project_id: activeRun.group_folder });

    logger.info(
      { task_id, runId: activeRun.id },
      'Stopping orphaned task (not in claimedTasks, found in DB)',
    );
  } else {
    // Install the reservation before the first await. The aborted execution can
    // finish immediately and invoke drainProjectQueue from its finally block.
    stoppingTasks.set(task_id, {
      project_id: claimed.project_id,
      bypassesAutomaticCapacity: claimed.bypassesAutomaticCapacity,
    });
    // Capture the run that this Stop owns. Re-querying by task after shutdown
    // could otherwise select a newer run if a claim race regresses later.
    try {
      activeRun = await getActiveRunForTask(task_id);
    } catch (err) {
      stoppingTasks.delete(task_id);
      throw err;
    }
    stoppedTaskClaims.add(claimed.abort);
    claimed.abort.abort();
  }

  let task: Task | undefined;
  let group: RegisteredGroup | undefined;
  let stopPersisted = false;
  try {
    // Kill the sandbox agent and wait so output.v1.jsonl is flushed before we read
    // the in-memory stream buffer (covers orphaned recovery runs too).
    await killAgentProcess(task_id).catch((err) => {
      logger.warn(
        { task_id, error: String(err) },
        'Error killing agent process during stop',
      );
    });
    // The final process flush can emit a session chunk while shutdown is in
    // flight. Do not release the stop reservation or finalize its history row
    // until the exact execution generation has durably recorded that chunk.
    await waitForTaskRunSessionPersistence(activeRun?.id);

    task = await getTask(task_id);
    // Persist whatever was streamed to the UI (executeTask turnOutput or recovery
    // re-stream) before broadcasting task_error so the bubble → transcript
    // handoff does not lose partial work.
    if (task) {
      const isTestingVerdictRun = testingVerdictRuns.has(task_id);
      const streamedOutput = takeTaskStreamBuffer(task_id);
      const partialOutput = isTestingVerdictRun
        ? stripAllTestingDecisions(takeTestingRawBuffer(task_id))
        : streamedOutput;
      testingVerdictRuns.delete(task_id);
      flushStoppedTranscript(
        task.project_id,
        task_id,
        partialOutput,
        task.last_agent_name ?? null,
        activeRun?.model_name ?? activeRun?.model ?? null,
        activeRun?.id ?? null,
      );
    }

    // Move back to backlog while the stop reservation still prevents a drain
    // from reclaiming this task.
    group = task && groupResolver ? groupResolver(task.project_id) : undefined;
    const stages = getGroupStages(group);
    const backlogStage = getInitialStage(stages);

    // If the caller already moved the card to a non-executable (queue/done)
    // stage, that user-chosen stage is authoritative: do not overwrite it.
    const currentStage = task ? findStage(stages, task.status) : undefined;
    const alreadyMovedToNonExecutionStage =
      !!currentStage &&
      currentStage.type !== 'active' &&
      currentStage.type !== 'testing' &&
      currentStage.type !== 'review';

    if (!options.keepStatus && !alreadyMovedToNonExecutionStage) {
      await updateTask(task_id, {
        status: backlogStage?.id ?? 'backlog',
        error: 'Stopped by user',
        // A stopped task is retryable work, not a completed task. Clear any
        // stale terminal timestamp when returning it to backlog.
        completed_at: null,
      });
    }
    stopPersisted = true;

    // Finalize only the run captured by this Stop. A run can finish naturally
    // while shutdown is in flight, so avoid overwriting an already-terminal
    // result. If the claimed execution inserted its row just after our initial
    // lookup, the stop reservation makes this fallback unambiguous.
    const ownedRun = activeRun ?? (await getActiveRunForTask(task_id));
    if (ownedRun) {
      const currentRun = await getActiveRunById(ownedRun.id);
      if (currentRun?.status === 'running') {
        await completeActiveRun(ownedRun.id, 'error');
      }
    }

    broadcast({
      type: 'task_error',
      payload: {
        task_id,
        project_id: task?.project_id,
        error: 'Stopped by user',
      },
    });

    logger.info({ task_id }, 'Task execution stopped by user');
    return true;
  } finally {
    // Release only the generation that was stopped; an explicitly requested
    // later run must retain its own claim and running marker.
    if (claimed) releaseTaskExecutionClaim(task_id, claimed.abort);
    try {
      if (claimed && !activeRun) {
        const barriers = await getUnresolvedStageEntryEvents(
          claimed.project_id,
        );
        await Promise.all(
          barriers
            .filter(
              (event) => event.taskId === task_id && event.state === 'claimed',
            )
            .map((event) => releaseStageEntryEventClaim(event.id)),
        );
      }
    } catch (err) {
      logger.warn(
        { err, task_id },
        'Failed to release stage-entry claim while stopping task',
      );
    } finally {
      stoppingTasks.delete(task_id);
    }

    // Wake the queue only after backlog and active_run state are consistent.
    // If persistence failed, avoid immediately relaunching an active-stage card.
    if (stopPersisted && task && group) {
      drainProjectQueue(task.project_id, group);
    }
  }
}
