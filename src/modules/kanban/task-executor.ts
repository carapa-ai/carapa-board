/**
 * Task executor — barrel re-export module.
 *
 * The actual implementation is split across:
 * - `task/pipeline.ts`  — executeTask, queue draining, task stopping
 * - `task/run-prompts.ts` — task-run prompt and persona context assembly
 * - `task/review-preparation.ts` — Testing/Review Git preparation and identity
 * - `task/deploy.ts`    — deploy triggering & validation
 * - `task/review.ts`    — review decision handling (approve/reject logic)
 * - `task/git-ops.ts`   — post-execution git cleanup & observations
 * - `lib/git-ops.ts`    — low-level git primitives (branch, merge, worktree)
 * - `review.ts`         — review decision parsing and format repair
 *
 * This file preserves the original public API so existing consumers
 * (`routes/`, `index.ts`, `recovery.ts`, etc.) continue to work unchanged.
 */

// --- Pipeline: executeTask, queue drain, stop, state queries ---
export {
  executeTask,
  claimTaskExecution,
  claimTaskReset,
  claimRestartRecoveryTaskExecution,
  releaseTaskExecutionClaim,
  drainProjectQueue,
  holdQueueDrains,
  releaseQueueDrains,
  recoverStageEntryEvents,
  persistAutomaticStageEntrySuccess,
  persistAutomaticStageEntryFailure,
  stopTask,
  isMoveAwayFromRunStage,
  stopAllProjectTasks,
  cancelQueuedProjectTasks,
  setGroupResolver,
  isTaskRunning,
  isTaskExecutionClaimed,
  isTaskExecutionClaimedByOther,
  withStageVariantWriteLock,
  isTaskExecutionPresented,
  getRunningTaskIds,
  getQueuedTaskIds,
  getWaitingTaskIds,
  finishOwnedTaskExecution,
  finishRecoveredTaskExecution,
  retireOwnedTaskExecutionPresentation,
  retireRecoveredTaskExecutionPresentation,
  resetProjectFailures,
  spawnNextDatasetRow,
  resumeActiveDatasetTasks,
  recordTaskStreamChunk,
  clearTaskStreamBuffer,
  requestTaskStageHandoff,
  requestDurableTaskStageHandoff,
  getPendingTaskStageHandoff,
  finalizeTaskStageHandoff,
  appendTaskStageHandoffDelivery,
  clearRecoveryTransition,
  holdTaskForPendingSteering,
  updateTaskWithSteeringBarrier,
  appendTaskSteeringMessage,
  appendTaskStagePrompt,
  beginTaskSteeringAdmission,
  getTaskExecutionStartingStage,
  endTaskSteeringAdmission,
  beginSuccessfulTaskFinalization,
  reconcileTaskSteeringReceipts,
  closeTaskSteeringAdmissionWindow,
  endSuccessfulTaskFinalization,
  registerRecoveredTaskAbort,
  unregisterRecoveredTaskAbort,
  flushStoppedTranscript,
  scheduleTransientTaskRetry,
  isRetryableTaskError,
  formatTransientTaskError,
  getTaskQueueHoldReason,
  parkTaskAfterGitCheckpointFailure,
} from './task/pipeline.js';
export type {
  RestartRecoveryExecutionIntent,
  SuccessfulTaskFinalizationBoundary,
} from './task/pipeline.js';
export type { DurableTaskStageHandoff } from './task/pipeline.js';
export {
  loadSystemPrompt,
  loadAgentRules,
  loadReviewPrompt,
} from '../../prompt-loader.js';

// --- Deploy ---
export { triggerDeploy, queueDeploy } from './task/deploy.js';

// --- Review (decision handling + parsing + types) ---
export type { ReviewDecision, ReviewIssue } from './review.js';
export { parseReviewDecision } from './review.js';
