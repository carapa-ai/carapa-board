/**
 * Boot-time recovery for stalled runs, orphaned IPC directories,
 * stuck conversations, and orphaned worktrees.
 * Extracted from index.ts to isolate crash-recovery logic.
 */

import fs from 'fs';
import { webBrowserSessions } from './modules/web/browser-sessions.js';
import { finalizeRunBrowser } from './sandbox/browser-lifecycle.js';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  AGENT_CMD,
  ASSISTANT_NAME,
  DATA_DIR,
  RUN_POLL_INTERVAL,
  STALL_TIMEOUT_MS,
  STALL_GRACE_MS,
} from './config.js';
import {
  getActiveRunsByStatus,
  getActiveRunById,
  getLastActiveRunForTask,
  completeActiveRun as completeActiveRunRow,
  updateRunStats,
  getTask,
  getTaskById,
  getUnfinalizedScheduledRuns,
  hasTaskRunLogForRun,
  logTaskRun,
  saveChatMessage,
  getLastChatConversationId,
  getStuckWorkingConversations,
  getConversationIdsWithPendingForms,
  updateTask,
  updateScheduledTaskAfterRun,
  releaseOrphanedScheduledTaskOccurrenceClaims,
  getTasksWithOrphanedWorktrees,
  setConversationSessionId,
  getConversation,
  releaseUnconsumedQueuedChatMessages,
  incrementDatasetTaskProgress,
  getLastRunSessionForStage,
  getStageEntryEventByRunId,
  getCurrentStageEntryEvent,
  getTerminalStageEntryRunEvents,
  reconcileStageEntryEventRuns,
  releaseTaskAdmission,
  snapshotTaskAdmissionOwners,
  type TaskAdmissionSnapshot,
  getCompletedTaskRunsForStaleAdmissions,
  recordPendingFinalizationRuns,
  settlePendingFinalizationRun,
  recoverStaleTaskAdmissions,
  reserveRestartRecoveryRun,
  markRestartRecoveryRunDispatched,
  updateLastEventAt,
} from './db.js';
import {
  releaseAndClaimDirectFollowups,
  scheduleClaimedDirectFollowup,
} from './modules/chat/direct-followups.js';
import { buildSandboxRunTelemetry } from './modules/chat/run-telemetry.js';
import { stripLiveMarkers } from './modules/chat/live-activity.js';
import { getChatAgents, resolveAgentReference } from './lib/chat-agents.js';
import {
  appendTaskMessage,
  readTaskMessages,
  clearTaskOutputRun,
} from './modules/transcripts/transcript-store.js';
import {
  getRecoveredScheduledRunOutcome,
  resolveOrphanedRunMetadata,
} from './recovery-utils.js';
import {
  ChunkData,
  resolveHostRunDir,
  waitForRun,
  isCurrentProcessRun,
  markCurrentProcessRun,
  unmarkCurrentProcessRun,
} from './mcp/mcp-runner.js';
import {
  killRun,
  buildOutput,
  readRunV1EventsTail,
  runV1ErrorText,
  type ContainerOutput,
  buildStallOpts,
  buildPidAliveProbe,
  chatAbortKey,
  chatRunAbortControllers,
  hostIpcDir,
  persistPerRunTranscript,
  archiveRunV1Transcript,
  hasRunV1Files,
  readRecoveredRunResult,
  removeRunDirPreservingControlResponses,
  TASK_PERSISTENT_RUNTIME_CONTRACT,
  RESTART_RECOVERY_DISPATCH_RECEIPT,
} from './sandbox/process.js';
import { resolveEffectiveSandbox } from './sandbox/effective-settings.js';
import {
  carapaRunV1Paths,
  readCarapaRunV1Pair,
} from './modules/transcripts/carapa-run-v1.js';
import { readRunMetrics } from './stream/run-metrics.js';
import { chatTranscriptPath, outputTranscriptPath } from './group-dir.js';
import {
  getProjectStages,
  getGroupStages,
  getInitialStage,
  getNextActiveStage,
  getDoneStage,
  getDeployStageId,
  getFailedStage,
  findStage,
  isActiveStage,
  isReviewStage,
  isTestingStage,
  getFirstExecutableStage,
  isAbExperimentTask,
} from './modules/kanban/stages.js';
import {
  parsePendingReviewDecision,
  parseReviewDecision,
  parseReviewComparison,
  readReviewHistory,
  isFirstReviewRejection,
  buildFirstRejectionComparison,
} from './modules/kanban/review.js';
import { handleReviewDecision } from './modules/kanban/task/review.js';
import { createVerdictBackgroundTaskStopper } from './modules/kanban/task/verdict-background-stop.js';
import {
  PENDING_REVIEW_REVIEWERS_KEY,
  REVIEW_CHAIN_KEY,
  REVIEW_CHAIN_RUN_KEY,
  aggregateReviewChain,
  formatReviewChainVerdict,
  nextReviewChainStage,
  readReviewChain,
  readReviewChainRun,
  resolveCoReviewStages,
  summarizeReviewerVerdicts,
  type ReviewChain,
  type ReviewChainRunMarker,
  type ReviewChainVerdict,
} from './modules/kanban/task/review-chain.js';
import type { ReviewerVerdictSummary } from './modules/kanban/review.js';
import {
  buildTestingFormatRepairPrompt,
  parseTestingDecision,
} from './modules/kanban/testing.js';
import {
  handleTestingBlocked,
  handleTestingDecision,
  persistTestingAssistantResponse,
  readTestingInspectedIdentity,
  retryTestingAfterGitStateChange,
} from './modules/kanban/task/testing.js';
import {
  isTaskCheckoutClean,
  readTaskGitContentIdentity,
} from './modules/kanban/task/review-preparation.js';
import {
  hasTestingChain,
  testingRunAlreadyApplied,
} from './modules/kanban/task/testing-chain.js';
import {
  GroupFsError,
  appendFileAtSync,
  mkdirAtSync,
  openTrustedDirSync,
  readGroupFileSync,
  removeAtSync,
  type PinnedDir,
} from './lib/group-fs.js';
import {
  existsIpcEntrySync,
  ipcRoot,
  isNumericPid,
  openIpcDirSync,
  readIpcTextSync,
  removeIpcDirSync,
  writeIpcFileSync,
} from './lib/ipc-fs.js';
import { runGitInRepo, TaskStateError } from './lib/git-ops.js';
import { calcNextRun } from './modules/chat/scheduling/task-scheduler.js';
import {
  getGroupByFolder,
  registeredGroups,
  saveSessions,
  sessions,
} from './state-manager.js';
import { sendMessage } from './modules/messaging/send-message.js';
import {
  broadcast,
  getActiveStreamKeyForConv,
} from './modules/objectives/ws-events.js';
import { settleAgentAsksAfterTurn } from './modules/agent-asks/delivery.js';
import { hasPendingChatCallerAsk } from './modules/agent-asks/db-agent-asks.js';
import { chatEventScope } from './modules/chat/conversation-scope.js';
import {
  firePushNotification,
  notifyEntityLifecycle,
  notifyStageEntryLifecycle,
} from './modules/tools/push-tools.js';
import { logger } from './logger.js';
import { getSandboxClient } from './lib/mcp-client.js';
import {
  BROWSER_CLEANUP_TIMEOUT_SECONDS,
  closeBrowserSessionCommand,
  webViewAgentSessionId,
} from './modules/web/browser-agent.js';
import {
  acquireSharedCheckoutLease,
  SharedCheckoutBusyError,
  type SharedCheckoutLease,
} from './concurrency/shared-checkout-lease.js';
import {
  drainProjectQueue,
  executeTask,
  spawnNextDatasetRow,
  recordTaskStreamChunk,
  clearTaskStreamBuffer,
  registerRecoveredTaskAbort,
  unregisterRecoveredTaskAbort,
  claimRestartRecoveryTaskExecution,
  releaseTaskExecutionClaim,
  finishRecoveredTaskExecution,
  retireRecoveredTaskExecutionPresentation,
  scheduleTransientTaskRetry,
  isRetryableTaskError,
  formatTransientTaskError,
  persistAutomaticStageEntrySuccess,
  persistAutomaticStageEntryFailure,
  beginSuccessfulTaskFinalization,
  reconcileTaskSteeringReceipts,
  getPendingTaskStageHandoff,
  finalizeTaskStageHandoff,
  appendTaskStageHandoffDelivery,
  clearRecoveryTransition,
  closeTaskSteeringAdmissionWindow,
  endSuccessfulTaskFinalization,
  parkTaskAfterGitCheckpointFailure,
} from './modules/kanban/task-executor.js';
import { runPostExecutionGitOps } from './modules/kanban/task/git-ops.js';
import {
  DEPLOY_PENDING_DISPATCH_KEY,
  recoveredDeployDispatchValue,
  mergeBranchForDeploy,
  triggerDeploy,
} from './modules/kanban/task/deploy.js';
import {
  RECOVERY_TRANSITION_KEY,
  readRecoveryTransition,
  recoveryTransitionValue,
} from './modules/kanban/pipeline-owned-values.js';
import type {
  StageDefinition,
  StageEntryEventRef,
} from './modules/kanban/types.js';
import type { ActiveRun } from './modules/kanban/execution/types.js';
import type { SuccessfulTaskFinalizationBoundary } from './modules/kanban/task-executor.js';

interface TaskRecoveryDependencies {
  admissionSnapshot?: TaskAdmissionSnapshot;
  drainProjectQueue?: typeof drainProjectQueue;
  executeTask?: typeof executeTask;
  runPostExecutionGitOps?: typeof runPostExecutionGitOps;
}

type RestartRecoveryScheduleResult =
  | 'scheduled'
  | 'pending'
  | 'superseded'
  | 'ineligible';

const RESTART_WARM_RECOVERY_MARKER = '.restart-warm-recovery';
const RESTART_WARM_INTERRUPTED_MARKER = '.restart-warm-interrupted';
const warmTaskRunMonitors = new Map<string, NodeJS.Timeout>();
// Client-side abort for each dead-agent liveness probe (see sweepDeadAgentRuns).
const DEAD_AGENT_PROBE_ABORT_MS = 15_000;
const WARM_TURN_SETTLE_MS = RUN_POLL_INTERVAL * 2;
// Filesystem mtimes can trail the wall-clock timestamp captured for the run by
// a small amount (notably on overlay filesystems used by the test/build image).
// Keep the ownership check strict enough to reject an older turn while allowing
// that normal clock granularity/skew.
const WARM_ACTIVITY_CLOCK_SKEW_MS = 1_000;

interface TaskWarmSession {
  sessionDir: string;
  outputPath: string;
  currentOutput: string;
  completed: boolean;
  failed: boolean;
  /** `agentCmd` of the runtime whose journal this is; names the V1 harness. */
  harness: string;
  runId: string;
  sessionId: string;
  startedAtMs: number;
}

interface TaskWarmSnapshot {
  currentOutput: string;
  completed: boolean;
  failed: boolean;
}

function taskWarmActivityAtMs(warm: TaskWarmSession): number {
  let activityAtMs = -Infinity;
  for (const filePath of [
    warm.outputPath,
    path.join(warm.sessionDir, 'last_used'),
  ]) {
    try {
      activityAtMs = Math.max(activityAtMs, fs.statSync(filePath).mtimeMs);
    } catch {
      // A session can disappear while its process is being probed.
    }
  }
  return activityAtMs;
}

function warmTurnMayStillSettle(warm: TaskWarmSession): boolean {
  const activityAtMs = taskWarmActivityAtMs(warm);
  return (
    warmActivityBelongsToRun(activityAtMs, warm.startedAtMs) &&
    Date.now() - activityAtMs < WARM_TURN_SETTLE_MS
  );
}

function warmActivityBelongsToRun(
  activityAtMs: number,
  startedAtMs: number,
): boolean {
  return activityAtMs >= startedAtMs - WARM_ACTIVITY_CLOCK_SKEW_MS;
}

async function refreshRecoveredWarmActivity(
  run: ActiveRun,
  warm: TaskWarmSession,
): Promise<void> {
  if (!warm.currentOutput) return;
  const activityAtMs = taskWarmActivityAtMs(warm);
  if (
    !Number.isFinite(activityAtMs) ||
    !warmActivityBelongsToRun(activityAtMs, warm.startedAtMs)
  )
    return;
  await updateLastEventAt(run.id, new Date(activityAtMs).toISOString());
}

/**
 * Consolidated telemetry for a chat turn recovered after a restart. Without
 * it the chat footer falls back to the first raw usage chunk of the turn.
 */
/**
 * Context window for a recovered run. The live path reads it from the fully
 * materialized runtime it launched with; recovery only has the stored agent
 * name, which can be a catalog alias rather than an exact generated id. Resolve
 * it the same way the launch did so `Ctx` does not vanish after a restart.
 */
function recoveredContextSize(
  run: Pick<ActiveRun, 'agent_name' | 'session_agent_key'>,
): number | undefined {
  for (const name of [run.agent_name, run.session_agent_key]) {
    if (!name) continue;
    const exact = getChatAgents().find((agent) => agent.id === name);
    if (exact?.context_size) return exact.context_size;
    try {
      const resolved = resolveAgentReference(name);
      if (resolved?.context_size) return resolved.context_size;
    } catch {
      // An unresolvable stored name just means no size is known.
    }
  }
  return undefined;
}

function recoveredRunTelemetry(
  run: ActiveRun,
  output: ContainerOutput,
): Record<string, unknown> {
  return buildSandboxRunTelemetry(output, {
    modelName: run.model,
    contextSize: recoveredContextSize(run),
  });
}

/**
 * Largest warm daemon output (every turn of a session) recovery reads. No
 * daemon-specific cap exists; this is the largest transcript bound in the
 * codebase (`MAX_CONTAINED_BYTES` in carapa-run-v1.ts).
 */
const MAX_DAEMON_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Directory below the IPC root, or null when it is missing or refused (a link). */
function openIpcDirOrNull(dirAbs: string): PinnedDir | null {
  try {
    return openIpcDirSync(dirAbs);
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn({ dirAbs, code: err.code }, 'Refusing unsafe IPC directory');
    return null;
  }
}

/** Run `fn` on the pinned IPC directory `dirAbs`; null when it cannot be opened. */
function withIpcDir<T>(dirAbs: string, fn: (dir: PinnedDir) => T): T | null {
  const dir = openIpcDirOrNull(dirAbs);
  if (!dir) return null;
  try {
    return fn(dir);
  } finally {
    dir.closeSync();
  }
}

/**
 * Text of the agent-writable IPC file `name` in `dirAbs` (at most `maxBytes`),
 * or null when it is missing, refused (link, FIFO, oversized) or unreadable.
 * Never follows a planted link or blocks on a FIFO.
 */
function readIpcFile(
  dirAbs: string,
  name: string,
  maxBytes: number,
): string | null {
  try {
    return withIpcDir(dirAbs, (dir) => readIpcTextSync(dir, name, maxBytes));
  } catch {
    return null;
  }
}

function readLines(dirAbs: string, name: string): string[] {
  return (readIpcFile(dirAbs, name, MAX_DAEMON_OUTPUT_BYTES) ?? '')
    .split('\n')
    .filter(Boolean);
}

/** Largest transcript tail recovery reads (same bound as task transcript parsing). */
const MAX_RECOVERY_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/**
 * Text of a transcript in an agent-writable group tree, or null when it is
 * missing, a link, not a regular file or unreadable. Never follows a planted
 * link or blocks on a FIFO; an oversized file yields its recent tail.
 */
function readGroupTranscriptText(filePath: string): string | null {
  try {
    const read = readGroupFileSync(filePath, {
      maxBytes: MAX_RECOVERY_TRANSCRIPT_BYTES,
      tail: true,
    });
    if (!read) return null;
    const text = read.data.toString('utf8');
    if (read.stat.size <= MAX_RECOVERY_TRANSCRIPT_BYTES) return text;
    // The tail window may start inside a line: keep complete records only.
    return text.slice(text.indexOf('\n') + 1);
  } catch (error) {
    logger.warn(
      { filePath, error: String(error) },
      'Recovery refused to read transcript',
    );
    return null;
  }
}

function readGroupTranscriptLines(filePath: string): string[] {
  return (readGroupTranscriptText(filePath) ?? '').split('\n').filter(Boolean);
}

const TASK_WARM_OUTPUTS = TASK_PERSISTENT_RUNTIME_CONTRACT.map((runtime) => ({
  name: runtime.warmOutputFile,
  harness: runtime.agentCmd,
}));

function parsedJsonLine(line: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function acpPromptOutcome(event: Record<string, any>): {
  terminal: boolean;
  failed: boolean;
  error?: string;
} {
  const stopReason = event.result?.stopReason ?? event.result?.stop_reason;
  if (typeof stopReason === 'string') {
    return {
      terminal: true,
      failed: stopReason !== 'end_turn',
      ...(stopReason !== 'end_turn'
        ? { error: `turn ended: ${stopReason}` }
        : {}),
    };
  }
  // ACP implementations choose their own request-id scheme (some reuse 1 for
  // every prompt). Historical handshake errors are safe turn boundaries too;
  // only a tail written after active_runs.started_at can finalize this run.
  if (event.error) {
    return {
      terminal: true,
      failed: true,
      error:
        typeof event.error.message === 'string'
          ? event.error.message
          : 'ACP turn failed',
    };
  }
  return { terminal: false, failed: false };
}

function acpUpdateText(event: Record<string, any>): string {
  const text = event.params?.update?.content?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Translate one ACP turn's journal frames into Run V1 event lines. Every
 * notification yields its own immutable record, so the output of a growing
 * journal stays a byte prefix of the next render (the warm monitor appends only
 * the new suffix). The terminal events are written only once the turn is
 * complete.
 */
function translateAcpWarmTurn(
  lines: string[],
  sessionId: string,
  runId: string,
  completed: boolean,
  failed: boolean,
  terminalError?: string,
): string {
  const messageId = `warm-${runId}`;
  const output: Record<string, unknown>[] = [
    { type: 'run', status: 'started' },
    { type: 'session', id: sessionId, status: 'resumed' },
  ];
  const baseLength = output.length;
  let result = '';
  const tools = new Map<string, Record<string, any>>();
  const toolName = (...updates: (Record<string, any> | undefined)[]) => {
    for (const update of updates) {
      // The V1 schema accepts only a string name; an argv array is not one.
      const name = [
        update?.rawInput?.command,
        update?.rawInput?.cmd,
        update?.title,
      ].find((candidate) => typeof candidate === 'string');
      if (name) return name;
    }
    return 'tool';
  };

  for (const line of lines) {
    const event = parsedJsonLine(line);
    const update =
      event?.method === 'session/update' ? event.params?.update : null;
    if (!update || typeof update !== 'object') continue;
    const text = acpUpdateText(event!);
    if (update.sessionUpdate === 'agent_message_chunk' && text) {
      result += text;
      output.push({
        type: 'message_delta',
        id: messageId,
        role: 'assistant',
        delta: text,
      });
      continue;
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && text) {
      output.push({
        type: 'thought_delta',
        id: `${messageId}-thought`,
        delta: text,
      });
      continue;
    }
    const toolId =
      typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (update.sessionUpdate === 'tool_call' && toolId) {
      tools.set(toolId, update);
      output.push({
        type: 'tool_call',
        id: toolId,
        status: 'started',
        name: toolName(update),
        ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
      });
      continue;
    }
    if (
      update.sessionUpdate === 'tool_call_update' &&
      toolId &&
      ['completed', 'failed', 'finished', 'cancelled'].includes(update.status)
    ) {
      const started = tools.get(toolId);
      const rawOutput = update.rawOutput;
      const aggregatedOutput =
        typeof rawOutput === 'string'
          ? rawOutput
          : rawOutput && typeof rawOutput === 'object'
            ? (rawOutput.stdout ??
              rawOutput.output ??
              rawOutput.text ??
              rawOutput.result)
            : undefined;
      const toolFailed = update.status === 'failed';
      output.push({
        type: 'tool_call',
        id: toolId,
        status: toolFailed ? 'failed' : 'completed',
        name: toolName(started, update),
        ...(typeof aggregatedOutput === 'string'
          ? { output: aggregatedOutput }
          : {}),
        exitCode: toolFailed ? 1 : 0,
      });
    }
  }

  if (completed) {
    if (result) {
      output.push({
        type: 'message',
        id: messageId,
        role: 'assistant',
        content: result,
        status: 'completed',
      });
    }
    if (terminalError) {
      output.push({ type: 'error', message: terminalError, fatal: true });
    }
    output.push({
      type: 'run',
      status: failed ? 'failed' : 'completed',
      ...(failed
        ? { error: { message: terminalError ?? 'ACP turn failed' } }
        : {}),
    });
  }
  return output.length > baseLength
    ? `${output.map((event) => JSON.stringify(event)).join('\n')}\n`
    : '';
}

function readTaskWarmSnapshot(warm: TaskWarmSession): TaskWarmSnapshot {
  const lines = readLines(warm.sessionDir, path.basename(warm.outputPath));
  const parsed = lines.map(parsedJsonLine);
  const terminalIndexes: number[] = [];
  let latestOutcome: ReturnType<typeof acpPromptOutcome> | undefined;
  for (let index = 0; index < parsed.length; index++) {
    if (!parsed[index]) continue;
    const outcome = acpPromptOutcome(parsed[index]!);
    if (!outcome.terminal) continue;
    terminalIndexes.push(index);
    latestOutcome = outcome;
  }

  let outputMtime = -Infinity;
  try {
    outputMtime = fs.statSync(warm.outputPath).mtimeMs;
  } catch {
    // A disappearing session is handled as an empty snapshot.
  }
  let lastUsedMtime = -Infinity;
  try {
    lastUsedMtime = fs.statSync(
      path.join(warm.sessionDir, 'last_used'),
    ).mtimeMs;
  } catch {
    // A crash can occur after the response but before last_used is touched.
  }
  const activityBelongsToRun = warmActivityBelongsToRun(
    Math.max(outputMtime, lastUsedMtime),
    warm.startedAtMs,
  );
  const lastTerminal = terminalIndexes.at(-1) ?? -1;
  const previousTerminal = terminalIndexes.at(-2) ?? -1;
  let lastProtocolIndex = -1;
  for (let index = parsed.length - 1; index >= 0; index--) {
    if (parsed[index]) {
      lastProtocolIndex = index;
      break;
    }
  }
  // ACP orders every session/update before the session/prompt response. A
  // terminal response therefore owns this active run only when it is the
  // current protocol tail and the cumulative file changed after run start.
  // Updates after an older response are an in-flight newer turn.
  const completed =
    lastTerminal >= 0 &&
    lastTerminal === lastProtocolIndex &&
    activityBelongsToRun;
  const start = completed ? previousTerminal + 1 : lastTerminal + 1;
  const end = completed ? lastTerminal + 1 : lines.length;
  const currentLines = lines.slice(start, end);
  const hasCurrentUpdate = currentLines.some((line) => {
    const event = parsedJsonLine(line);
    return event?.method === 'session/update';
  });
  if (!completed && !hasCurrentUpdate) {
    return { currentOutput: '', completed: false, failed: false };
  }
  return {
    currentOutput: translateAcpWarmTurn(
      currentLines,
      warm.sessionId,
      warm.runId,
      completed,
      completed && (latestOutcome?.failed ?? false),
      completed ? latestOutcome?.error : undefined,
    ),
    completed,
    failed: completed && (latestOutcome?.failed ?? false),
  };
}

function readTaskWarmSessionId(sessionDir: string): string | undefined {
  // ACP daemons persist their native session before accepting a prompt. That
  // file is the only ownership evidence available when a restarted turn has
  // not emitted its first output line yet. The other names cover the warm
  // harnesses that use thread terminology while retaining the same exact-id
  // ownership check against active_runs.
  for (const name of [
    'session_id',
    'last_session_id',
    'thread_id',
    'last_thread_id',
  ]) {
    // An unreadable or refused marker falls through to the next one.
    const sessionId = readIpcFile(sessionDir, name, 256)?.trim();
    if (sessionId) return sessionId;
  }
  return undefined;
}

/** Locate only the task/stage warm directory that emitted this run's session. */
function findTaskWarmSession(run: ActiveRun): TaskWarmSession | undefined {
  const runtimeVariant = run.runtime_variant?.trim();
  if (
    !run.task_id ||
    !run.stage ||
    !run.session_id ||
    !runtimeVariant ||
    !/^[0-9a-f]{8}$/.test(runtimeVariant)
  )
    return undefined;
  const ipcDir = path.join(
    DATA_DIR,
    'ipc',
    `${run.sandbox_stack}-${run.sandbox_instance ?? run.group_folder}`,
  );
  const sessionsDir = path.join(ipcDir, 'sessions');
  const expectedSessionKey = `task-${run.task_id}-${run.stage}-${runtimeVariant}`;
  let candidates: string[];
  try {
    candidates = fs
      .readdirSync(sessionsDir)
      .filter((name) => name === expectedSessionKey);
  } catch {
    return undefined;
  }

  for (const name of candidates) {
    const sessionDir = path.join(sessionsDir, name);
    for (const output of TASK_WARM_OUTPUTS) {
      const outputPath = path.join(sessionDir, output.name);
      const daemonOutput = readIpcFile(
        sessionDir,
        output.name,
        MAX_DAEMON_OUTPUT_BYTES,
      );
      if (daemonOutput === null) continue;
      if (readTaskWarmSessionId(sessionDir) !== run.session_id) continue;
      const warm: TaskWarmSession = {
        sessionDir,
        outputPath,
        currentOutput: '',
        completed: false,
        failed: false,
        harness: output.harness,
        runId: run.id,
        sessionId: run.session_id,
        startedAtMs: new Date(run.started_at).getTime(),
      };
      Object.assign(warm, readTaskWarmSnapshot(warm));
      return warm;
    }
  }
  return undefined;
}

async function taskProcessState(
  run: ActiveRun,
  pidPath: string,
): Promise<'alive' | 'dead' | 'unknown'> {
  const rawPid = readIpcFile(path.dirname(pidPath), path.basename(pidPath), 64);
  if (rawPid === null || !isNumericPid(rawPid)) return 'unknown';
  const pid = rawPid.trim();
  try {
    const result = await getSandboxClient().sandboxExec(
      run.sandbox_stack,
      run.sandbox_service,
      `agent-status.sh ${pid}`,
      { instance: run.sandbox_instance ?? undefined, timeout: 5 },
    );
    const marker = /kill0_exit=(\d+)/.exec(
      `${result.stdout || ''}\n${result.stderr || ''}`,
    );
    if (!marker) return 'unknown';
    return marker[1] === '0' ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

/** Probe the wrapper lock that owns one warm prompt, not the daemon FIFO holder. */
async function taskWarmTurnState(
  run: ActiveRun,
  sessionDir: string,
): Promise<'alive' | 'dead' | 'unknown'> {
  const pidPath = path.join(sessionDir, 'lock', 'pid');
  if (!fs.existsSync(pidPath)) return 'dead';
  return taskProcessState(run, pidPath);
}

async function taskWarmDaemonState(
  run: ActiveRun,
  sessionDir: string,
): Promise<'alive' | 'dead' | 'unknown'> {
  const pidPath = path.join(sessionDir, 'daemon.pid');
  if (!fs.existsSync(pidPath)) return 'dead';
  return taskProcessState(run, pidPath);
}

function recoveredRunDir(run: ActiveRun): string {
  return path.join(
    DATA_DIR,
    'ipc',
    `${run.sandbox_stack}-${run.sandbox_instance ?? run.group_folder}`,
    'runs',
    run.id,
  );
}

/**
 * Create (if needed) and pin the recovered run directory. Null when a link in
 * its path makes it unsafe: the mirror then writes nothing.
 */
function openRecoveredRunDir(run: ActiveRun): PinnedDir | null {
  const root = ipcRoot();
  fs.mkdirSync(root, { recursive: true });
  const anchor = openTrustedDirSync(root);
  if (!anchor) return null;
  try {
    return mkdirAtSync(
      anchor,
      path.relative(root, recoveredRunDir(run)).split(path.sep).join('/'),
    );
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn(
      { runId: run.id, code: err.code },
      'Refusing unsafe recovered run directory',
    );
    return null;
  } finally {
    anchor.closeSync();
  }
}

/** Remove a board marker; a missing one is the normal case. */
function removeRunMarker(runDir: PinnedDir, name: string): void {
  try {
    removeAtSync(runDir, name);
  } catch {
    // The marker is absent or already unreadable to the board.
  }
}

/**
 * Write the reconstructed turn as a Run V1 pair. An empty pair is not valid V1,
 * so nothing is written until the turn has its first event.
 */
function writeWarmV1Pair(
  runDir: PinnedDir,
  warm: TaskWarmSession,
  output: string,
): void {
  writeIpcFileSync(
    runDir,
    'output.v1.meta.json',
    `${JSON.stringify({
      format: 'carapa-run',
      version: 1,
      harness: warm.harness,
      requestedModel: null,
    })}\n`,
  );
  writeIpcFileSync(runDir, 'output.v1.jsonl', output);
  writeWarmArgs(runDir, warm);
}

/**
 * The orphan watcher reads args.json once and consumes V1 only for a harness it
 * names, so it must exist before the watcher attaches, even while the turn has
 * no output yet. An existing file is never overwritten.
 */
function writeWarmArgs(runDir: PinnedDir, warm: TaskWarmSession): void {
  if (!existsIpcEntrySync(runDir, 'args.json')) {
    writeIpcFileSync(
      runDir,
      'args.json',
      JSON.stringify({ agentCmd: warm.harness }),
    );
  }
}

/**
 * Who owns the run dir's `output.v1.jsonl`. A pair carrying the recovery marker
 * was written by this recovery on an earlier boot ('none': resume it). One
 * without it was written by the run's own worker, which survives a board-only
 * restart and carries harness data (usage) the generic reconstruction lacks:
 * a terminal pair is kept as is ('terminal') and a non-terminal one is kept
 * while its per-turn worker may still append to it ('live'). Only a
 * non-terminal pair whose worker is proven dead is reconstructed ('none').
 */
async function workerRunV1State(
  run: ActiveRun,
  warm: TaskWarmSession,
): Promise<'none' | 'terminal' | 'live'> {
  const runDir = recoveredRunDir(run);
  const paths = carapaRunV1Paths(runDir);
  const hasWorkerV1 = withIpcDir(
    runDir,
    (dir) =>
      existsIpcEntrySync(dir, 'output.v1.jsonl') &&
      !existsIpcEntrySync(dir, RESTART_WARM_RECOVERY_MARKER),
  );
  if (!hasWorkerV1) return 'none';
  try {
    if (
      readCarapaRunV1Pair(paths, { requireTerminal: true, containedIn: runDir })
    ) {
      return 'terminal';
    }
  } catch {
    // A non-terminal or unreadable pair is judged by its worker's liveness.
  }
  return (await taskWarmTurnState(run, warm.sessionDir)) === 'dead'
    ? 'none'
    : 'live';
}

/**
 * `keepWorkerV1` leaves the worker's own V1 pair and the ownership marker
 * untouched; only its terminal outcome (`exit_code`) is reconciled.
 */
function mirrorTaskWarmTurn(
  run: ActiveRun,
  warm: TaskWarmSession,
  keepWorkerV1 = false,
): string {
  const runDirPath = recoveredRunDir(run);
  const runDir = openRecoveredRunDir(run);
  if (!runDir) return runDirPath;
  try {
    if (warm.currentOutput && !keepWorkerV1) {
      writeWarmV1Pair(runDir, warm, warm.currentOutput);
    } else if (!keepWorkerV1) {
      writeWarmArgs(runDir, warm);
    }
    writeIpcFileSync(
      runDir,
      'session_dir',
      `/workspace/ipc/sessions/${path.basename(warm.sessionDir)}\n`,
    );
    // A completed daemon may already have removed its pid file; a refused or
    // non-numeric one is not copied.
    const daemonPid = readIpcFile(warm.sessionDir, 'daemon.pid', 64);
    if (daemonPid !== null && isNumericPid(daemonPid)) {
      writeIpcFileSync(runDir, 'pid', daemonPid);
    }
    if (!keepWorkerV1) {
      writeIpcFileSync(runDir, RESTART_WARM_RECOVERY_MARKER, '');
    }
    // The interrupted marker exists only after a previously adopted daemon dies.
    removeRunMarker(runDir, RESTART_WARM_INTERRUPTED_MARKER);
    if (warm.completed) {
      if (
        existsIpcEntrySync(runDir, 'metrics_contract') &&
        !existsIpcEntrySync(runDir, 'metrics_complete')
      ) {
        writeIpcFileSync(runDir, 'metrics_complete', 'error\n');
      }
      writeIpcFileSync(runDir, 'exit_code', warm.failed ? '1\n' : '0\n');
    } else {
      // A wrapper can publish its own interrupted exit while the exact warm turn
      // is still running. The warm terminal response is authoritative for this
      // reconstructed spool, so keep the orphan watcher attached until it lands.
      // A live warm turn normally has no terminal spool yet.
      removeRunMarker(runDir, 'exit_code');
    }
  } finally {
    runDir.closeSync();
  }
  return runDirPath;
}

async function monitorTaskWarmTurn(
  run: ActiveRun,
  warm: TaskWarmSession,
): Promise<void> {
  if (warmTaskRunMonitors.has(run.id) || warm.completed) return;
  const runDir = recoveredRunDir(run);
  let mirroredOutput = warm.currentOutput;
  let checking = false;
  const stop = () => {
    const timer = warmTaskRunMonitors.get(run.id);
    if (timer) clearInterval(timer);
    warmTaskRunMonitors.delete(run.id);
  };
  const check = async () => {
    if (checking) return;
    checking = true;
    const dir = openIpcDirOrNull(runDir);
    try {
      if (!dir) {
        stop();
        return;
      }
      const snapshot = readTaskWarmSnapshot(warm);
      const currentOutput = snapshot.currentOutput;
      if (currentOutput.startsWith(mirroredOutput)) {
        const suffix = currentOutput.slice(mirroredOutput.length);
        if (suffix) {
          if (mirroredOutput) {
            appendFileAtSync(dir, 'output.v1.jsonl', suffix);
          } else {
            writeWarmV1Pair(dir, warm, currentOutput);
          }
          await refreshRecoveredWarmActivity(run, {
            ...warm,
            ...snapshot,
          });
        }
        mirroredOutput = currentOutput;
      }
      if (snapshot.completed) {
        writeIpcFileSync(dir, 'exit_code', snapshot.failed ? '1\n' : '0\n');
        stop();
        return;
      }
      const turnState = await taskWarmTurnState(run, warm.sessionDir);
      const daemonState = await taskWarmDaemonState(run, warm.sessionDir);
      const warmTurnProvenDead =
        daemonState === 'dead' ||
        (turnState === 'dead' && daemonState !== 'unknown');
      if (warmTurnProvenDead && !warmTurnMayStillSettle(warm)) {
        // The daemon may remain healthy while the wrapper that owns this exact
        // prompt has died. Give a just-written protocol tail one short settle
        // window, then interrupt based on the per-turn owner rather than the
        // daemon's process lifetime.
        const finalSnapshot = readTaskWarmSnapshot(warm);
        if (finalSnapshot.completed) {
          writeIpcFileSync(
            dir,
            'exit_code',
            finalSnapshot.failed ? '1\n' : '0\n',
          );
          stop();
          return;
        }
        writeIpcFileSync(dir, RESTART_WARM_INTERRUPTED_MARKER, '');
        writeIpcFileSync(dir, 'exit_code', '1\n');
        stop();
      }
    } catch (err) {
      // A link planted in the run dir refuses the append/write: stop mirroring.
      if (!(err instanceof GroupFsError)) throw err;
      logger.warn(
        { runId: run.id, code: err.code },
        'Refusing unsafe recovered run file',
      );
      stop();
    } finally {
      dir?.closeSync();
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), RUN_POLL_INTERVAL);
  timer.unref?.();
  warmTaskRunMonitors.set(run.id, timer);
  await check();
}

async function failUnclaimedRestartRecovery(
  run: ActiveRun,
  reason: string,
): Promise<void> {
  const currentRun = await getActiveRunById(run.id);
  if (currentRun?.status !== 'running') return;
  await completeActiveRun(run.id, 'error');
  const task = run.task_id ? await getTask(run.task_id) : undefined;
  const group = getGroupByFolder(run.group_folder);
  if (
    !task ||
    !group ||
    task.error === 'Stopped by user' ||
    task.status !== run.stage
  )
    return;
  const failedAt = new Date().toISOString();
  const stageEntryEvent = await updateTask(task.id, {
    status: getFailedStage(getGroupStages(group))?.id ?? 'failed',
    error: reason,
    completed_at: failedAt,
  });
  await appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'assistant',
    content: `Error: ${reason}`,
    created_at: failedAt,
  });
  await notifyRecoveredTaskLifecycle(run, 'failed', stageEntryEvent?.id);
}

/** Claim one internal continuation while the interrupted row still blocks admission. */
async function scheduleRestartRecoveryContinuation(
  run: ActiveRun,
  dependencies: TaskRecoveryDependencies,
  admissionOwnerToken: string | undefined,
): Promise<RestartRecoveryScheduleResult> {
  if (
    !run.task_id ||
    !run.stage ||
    !run.session_id?.trim() ||
    !run.runtime_variant?.trim()
  )
    return 'ineligible';
  const timeoutAt = new Date(run.timeout_at).getTime();
  if (
    !Number.isFinite(timeoutAt) ||
    recoveryDeadlineMs(run, timeoutAt) <= Date.now()
  ) {
    return 'ineligible';
  }
  const task = await getTask(run.task_id);
  const group = getGroupByFolder(run.group_folder);
  if (!task || !group || task.error === 'Stopped by user') return 'ineligible';
  const stage = findStage(getGroupStages(group), run.stage);
  if (stage?.type !== 'active' || stage.inactive || task.status !== run.stage) {
    return 'ineligible';
  }
  if (await getStageEntryEventByRunId(run.id)) return 'ineligible';
  const latestRun = await getLastActiveRunForTask(run.task_id);
  if (latestRun?.id !== run.id) return 'ineligible';
  const sessionAgentKey = run.session_agent_key || run.agent_name;
  if (!sessionAgentKey) return 'ineligible';

  // A dispatched reservation already crossed the harness boundary. Its cold
  // or warm artifacts are authoritative; never consume the session again.
  // An undispatched reservation is the durable outbox left by a Board process
  // that died before launch and must be retried with this exact row identity.
  if (run.restart_recovery_of_run_id) {
    const receiptPath = path.join(
      recoveredRunDir(run),
      RESTART_RECOVERY_DISPATCH_RECEIPT,
    );
    const hasHarnessReceipt = fs.existsSync(receiptPath);
    if (run.restart_recovery_dispatched_at || hasHarnessReceipt) {
      if (!run.restart_recovery_dispatched_at && hasHarnessReceipt) {
        await markRestartRecoveryRunDispatched(
          run.id,
          run.restart_recovery_of_run_id,
        ).catch((error) =>
          logger.warn(
            { run_id: run.id, error: String(error) },
            'Failed to reconcile restart recovery dispatch receipt',
          ),
        );
      }
      return 'pending';
    }
  }

  // Reserve the predecessor while executeTask is still preparing the checkout
  // and has not created the replacement active_runs row. Boot starts the
  // orphan watcher immediately after this sweep; without this ownership mark
  // it can classify the still-running predecessor as missing and fail it out
  // from under the atomic handoff. A repeated sweep observes the same mark and
  // treats the already-scheduled recovery as claimed instead of launching a
  // second promise whose cleanup could release the first claim.
  if (isCurrentProcessRun(run.id)) return 'pending';
  const executionClaim = claimRestartRecoveryTaskExecution(
    task.id,
    task.project_id,
  );
  if (!executionClaim) {
    // A claim that crossed the launch boundary between the ownership check
    // above and this reservation already has a newer durable row. Retire only
    // the interrupted predecessor; the newer run owns normal finalization.
    const competingRun = await getLastActiveRunForTask(task.id);
    if (competingRun?.id !== run.id && competingRun?.status === 'running') {
      await completeActiveRun(run.id, 'error');
      return 'superseded';
    }
    return 'pending';
  }

  let continuationRun: ActiveRun;
  let interruptedRunId: string;
  if (run.restart_recovery_of_run_id) {
    continuationRun = run;
    interruptedRunId = run.restart_recovery_of_run_id;
  } else {
    const startedAt = new Date().toISOString();
    const originalStartedAt = new Date(run.started_at).getTime();
    const originalTimeoutAt = new Date(run.timeout_at).getTime();
    const timeoutDuration = Math.max(
      60_000,
      Number.isFinite(originalStartedAt) && Number.isFinite(originalTimeoutAt)
        ? originalTimeoutAt - originalStartedAt
        : 0,
    );
    const reservation = await reserveRestartRecoveryRun({
      interruptedRunId: run.id,
      replacement: {
        id: `run-restart-${randomUUID()}`,
        group_folder: run.group_folder,
        chat_jid: run.chat_jid,
        session_id: run.session_id,
        conversation_id: run.conversation_id,
        isMain: run.isMain,
        isScheduledTask: run.isScheduledTask,
        scheduled_task_id: run.scheduled_task_id,
        task_id: run.task_id,
        sandbox_stack: run.sandbox_stack,
        sandbox_service: run.sandbox_service,
        sandbox_instance: run.sandbox_instance,
        started_at: startedAt,
        timeout_at: new Date(Date.now() + timeoutDuration).toISOString(),
        last_event_at: null,
        status: 'running',
        model: run.model,
        agent_name: run.agent_name,
        session_agent_key: run.session_agent_key,
        runtime_variant: run.runtime_variant,
        restart_recovery_of_run_id: run.id,
        restart_recovery_dispatched_at: null,
        completed_at: null,
        tok_total: null,
        tok_output: null,
        tok_input: null,
        tok_cache_write: null,
        tok_cache_read: null,
        tok_context_last: null,
        model_name: null,
        tool_usage_count: null,
        result: null,
        reviewScore: null,
        testingDecision: null,
        stage: run.stage,
        triggeredByUserId: run.triggeredByUserId ?? null,
        triggerSource: 'system',
      },
      taskId: task.id,
      stageId: run.stage,
      sessionId: run.session_id,
      sessionAgentKey,
      model: run.model,
      runtimeVariant: run.runtime_variant,
    });
    if (!reservation) {
      releaseTaskExecutionClaim(task.id, executionClaim);
      const competingRun = await getLastActiveRunForTask(task.id);
      if (competingRun?.id !== run.id && competingRun?.status === 'running') {
        await completeActiveRun(run.id, 'error');
        return 'superseded';
      }
      return 'pending';
    }
    if (!reservation.created) {
      releaseTaskExecutionClaim(task.id, executionClaim);
      return 'pending';
    }
    continuationRun = reservation.run;
    interruptedRunId = run.id;
  }
  markCurrentProcessRun(continuationRun.id);

  const executor = dependencies.executeTask ?? executeTask;
  void executor(task, group, {
    admissionOwnerToken,
    restartRecovery: {
      interruptedRunId,
      continuationRunId: continuationRun.id,
      stageId: continuationRun.stage!,
      sessionId: continuationRun.session_id!,
      sessionAgentKey,
      model: continuationRun.model,
      runtimeVariant: continuationRun.runtime_variant!,
      sandboxStack: continuationRun.sandbox_stack,
      sandboxService: continuationRun.sandbox_service,
      sandboxInstance: continuationRun.sandbox_instance,
    },
    executionClaim,
    triggerAttribution: {
      triggeredByUserId: run.triggeredByUserId ?? null,
      triggerSource: 'system',
    },
  })
    .catch(async (error) => {
      logger.error(
        {
          run_id: continuationRun.id,
          interrupted_run_id: interruptedRunId,
          task_id: run.task_id,
          error: String(error),
        },
        'Failed to launch restart continuation',
      );
      await failUnclaimedRestartRecovery(
        continuationRun,
        'Interrupted: server restarted during execution',
      );
    })
    .finally(() => {
      releaseTaskExecutionClaim(task.id, executionClaim);
      unmarkCurrentProcessRun(continuationRun.id);
    });
  return 'scheduled';
}

function restartRecoveryHandled(
  result: RestartRecoveryScheduleResult,
): boolean {
  return result !== 'ineligible';
}

function restartRecoveryScheduled(
  result: RestartRecoveryScheduleResult,
): boolean {
  return result === 'scheduled';
}

/** Recovery may merge only after the recovered transition reaches a done stage. */
export function recoveryReachedDoneStage(
  stages: StageDefinition[],
  status: unknown,
): boolean {
  return (
    typeof status === 'string' && findStage(stages, status)?.type === 'done'
  );
}

async function notifyRecoveredTaskLifecycle(
  run: { id: string; group_folder: string; task_id?: string | null },
  event: 'completed' | 'failed',
  stageEntryEventId?: string,
): Promise<void> {
  if (!run.task_id) return;
  const task = await getTask(run.task_id);
  if (!task) return;
  await notifyEntityLifecycle({
    group_folder: run.group_folder,
    task_id: run.task_id,
    run_id: run.id,
    event,
    title:
      event === 'completed'
        ? `Task completed: ${task.title}`
        : `Task failed: ${task.title}`,
    defer_stage_entry: true,
    stage_entry_event_id: stageEntryEventId,
  });
}

async function recoverAutomaticStageEntryRunOutcome(
  run: Pick<
    ActiveRun,
    | 'id'
    | 'group_folder'
    | 'task_id'
    | 'agent_name'
    | 'model_name'
    | 'session_id'
  >,
  outcome: {
    failed: boolean;
    error?: string;
    output?: string | null;
    sessionId?: string | null;
  },
): Promise<boolean> {
  if (!run.task_id) return false;
  const event = await getStageEntryEventByRunId(run.id);
  if (!event) return false;
  // A crash after this run's own handoff move: finish what that move still
  // owes (the handoff is finalized only while undelivered), then settle it.
  const moved = await getTask(run.task_id);
  if (moved && readRecoveryTransition(moved, run.id)?.stage === moved.status) {
    const owed = await getPendingTaskStageHandoff(moved, event.stageId);
    if (owed?.requestedRunId === run.id && owed.toStage === moved.status) {
      await finalizeTaskStageHandoff(moved, owed, run.id);
    }
    await clearRecoveryTransition(moved.id, run.id);
    return true;
  }
  if (event.state === 'succeeded') {
    const task = await getTask(run.task_id);
    if (task) await notifyStageEntryLifecycle(event, task);
    return true;
  }
  // An explicit move out resolves the barrier and owns the task status. A
  // previously persisted terminal receipt also must not notify twice.
  if (
    event.state !== 'pending' &&
    event.state !== 'claimed' &&
    event.state !== 'running'
  ) {
    return true;
  }
  const task = await getTask(run.task_id);
  if (!task) return true;
  if (outcome.failed) {
    await persistAutomaticStageEntryFailure({
      eventId: event.id,
      task,
      enteredStageId: event.stageId,
      error: outcome.error || 'Interrupted during restart recovery',
      output: outcome.output || '',
      agentName: run.agent_name,
      modelName: run.model_name,
      runId: run.id,
      sessionId: outcome.sessionId || run.session_id || undefined,
    });
  } else {
    // The run's own accepted stage move wins over entry success, as it does
    // live.
    const handoff = await getPendingTaskStageHandoff(task, event.stageId);
    const group = getGroupByFolder(task.project_id);
    if (
      group &&
      handoff?.requestedRunId === run.id &&
      task.status === event.stageId &&
      findStage(getGroupStages(group), handoff.toStage)?.type !== 'done'
    ) {
      const entryEvent = await updateTask(
        task.id,
        {
          status: handoff.toStage,
          output:
            outcome.output?.trim() ||
            task.output?.trim() ||
            'Automatic stage-entry run recovered successfully after restart.',
          session_id: outcome.sessionId || run.session_id || undefined,
          last_agent_name: run.agent_name,
          custom_values: recoveryTransitionValue(
            run.id,
            handoff.toStage,
            false,
          ),
        },
        { recoveryRunId: run.id, mergeCustomValues: true },
      );
      await finalizeTaskStageHandoff(task, handoff, run.id, entryEvent?.id);
      await clearRecoveryTransition(task.id, run.id);
      return true;
    }
    await persistAutomaticStageEntrySuccess({
      eventId: event.id,
      task,
      output:
        outcome.output?.trim() ||
        task.output?.trim() ||
        'Automatic stage-entry run recovered successfully after restart.',
      agentName: run.agent_name,
      modelName: run.model_name,
      runId: run.id,
      sessionId: outcome.sessionId || run.session_id || undefined,
    });
  }
  return true;
}

/** Recover terminal entry receipts before generic queue admission sees them. */
export async function recoverTerminalAutomaticStageEntryRuns(): Promise<void> {
  await reconcileStageEntryEventRuns();
  // A completed admitted run is recovered only by the admitted finalizer,
  // which checks that its project is loaded and still owns the card.
  const admittedRunIds = new Set(
    (await getCompletedTaskRunsForStaleAdmissions()).map((run) => run.id),
  );
  for (const { event, runStatus } of await getTerminalStageEntryRunEvents()) {
    if (!event.runId || admittedRunIds.has(event.runId)) continue;
    const run = await getActiveRunById(event.runId);
    if (!run) continue;
    try {
      await recoverAutomaticStageEntryRunOutcome(run, {
        failed: runStatus !== 'completed',
        error:
          runStatus === 'completed'
            ? undefined
            : `Entry run ended with status "${runStatus}" during restart recovery`,
        output: run.result ?? undefined,
        sessionId: run.session_id ?? undefined,
      });
    } catch (error) {
      // One run must not skip the remaining entries or the admitted-run
      // finalizer; its pending-finalization marker is retried on the next boot.
      logger.error(
        { runId: run.id, task_id: event.taskId, err: error },
        'Failed to recover terminal stage-entry run; continuing recovery',
      );
    }
  }
}

async function notifyRecoveredChatLifecycle(
  run: { id: string; group_folder: string; agent_ask_id?: string | null },
  conversationId: string | null | undefined,
  event: 'completed' | 'failed',
  answer?: string | null,
): Promise<void> {
  if (!conversationId) return;
  const conversation = await getConversation(conversationId);
  // Only this run's ask may be settled or suppress its lifecycle push. A
  // chat-originated ask pushes once from the caller's answer turn instead.
  const suppressPush = run.agent_ask_id
    ? await hasPendingChatCallerAsk(conversationId, run.agent_ask_id)
    : false;
  if (run.agent_ask_id) {
    await settleAgentAsksAfterTurn({
      group_folder: run.group_folder,
      conversation_id: conversationId,
      event,
      ask_id: run.agent_ask_id,
      answer:
        event === 'failed'
          ? ''
          : answer
            ? stripLiveMarkers(answer).content
            : undefined,
    }).catch((err) =>
      logger.warn(
        { conversation_id: conversationId, err: String(err) },
        'Recovered ask settlement failed',
      ),
    );
  }
  await notifyEntityLifecycle({
    group_folder: run.group_folder,
    conversation_id: conversationId,
    run_id: run.id,
    event,
    ...(suppressPush ? { recipient_user_ids: [] } : {}),
    title:
      event === 'completed'
        ? `Conversation completed: ${conversation?.title || 'Conversation'}`
        : `Conversation failed: ${conversation?.title || 'Conversation'}`,
  });
}

type RecoveredTaskRun = {
  id: string;
  group_folder: string;
  task_id: string;
};

type RecoveredTaskReleaseDependencies = {
  getTask?: typeof getTask;
  getGroupByFolder?: typeof getGroupByFolder;
  drainProjectQueue?: typeof drainProjectQueue;
  emit?: Parameters<typeof finishRecoveredTaskExecution>[4];
};

type RecoveredSuccessfulTaskBoundary = {
  group: ReturnType<typeof getGroupByFolder>;
  boundary: SuccessfulTaskFinalizationBoundary;
};

/**
 * Persist the non-transitioning portion of a recovered success, then enter the
 * same steering completion protocol used by live execution. The durable run
 * stage is authoritative even when a stale task row already shows a later
 * stage from an interrupted finalizer.
 */
async function beginRecoveredSuccessfulTaskFinalization(
  run: ActiveRun,
  result: string | null,
  sessionId: string | undefined,
  onBoundary: (boundary: RecoveredSuccessfulTaskBoundary) => void,
  onPresentationRetired: () => void,
): Promise<RecoveredSuccessfulTaskBoundary | undefined> {
  if (!run.task_id) return undefined;
  // Automatic entry runs have their own durable entry receipt and never
  // auto-advance the card; generic task-stage steering does not own them.
  if (await getStageEntryEventByRunId(run.id)) return undefined;
  const task = await getTask(run.task_id);
  if (!task) return undefined;
  const startingStage = run.stage || task.status;
  const boundary = await beginSuccessfulTaskFinalization(
    task,
    startingStage,
    run.id,
    onPresentationRetired,
  );
  const group = getGroupByFolder(run.group_folder);
  const recoveredBoundary = { group, boundary };
  // Publish ownership before any later persistence can throw so the caller's
  // finalizer always closes the admission window with the real outcome.
  onBoundary(recoveredBoundary);
  await updateTask(task.id, {
    session_id: sessionId ?? task.session_id,
    ...(result ? { output: result } : {}),
    ...(run.sandbox_instance ? { sandbox_instance: run.sandbox_instance } : {}),
  });
  if (!boundary.shouldAdvance) {
    const message = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'assistant',
      content:
        result?.trim() ||
        'Run recovered after restart (completed successfully).',
      agent_name: run.agent_name,
      model_name: run.model_name,
      entry_type: 'run_result',
      run_id: run.id,
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
  return recoveredBoundary;
}

/**
 * Recover the terminal payload of a run whose immutable process directory may
 * already have been cleaned up. Completions persist the canonical result on
 * active_runs; a run without one is finalized with the generic fallback message.
 */
function completedTaskRunOutcome(run: ActiveRun): {
  result: string | null;
  sessionId: string | undefined;
} {
  return { result: run.result ?? null, sessionId: run.session_id ?? undefined };
}

/** Append the canonical recovered result once, even across repeated boots. */
function appendCompletedTaskRunResult(
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>,
  run: ActiveRun,
  result: string | null,
): void {
  const content =
    result?.trim() || 'Run recovered after restart (completed successfully).';
  const alreadyPersisted = readTaskMessages(task.project_id, task.id).some(
    (message) =>
      message.role === 'assistant' &&
      message.entry_type === 'run_result' &&
      message.run_id === run.id,
  );
  if (alreadyPersisted) return;
  const message = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'assistant',
    content,
    agent_name: run.agent_name,
    model_name: run.model_name,
    entry_type: 'run_result',
    run_id: run.id,
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

/**
 * Finalize successful task rows that reached active_runs.completed while their
 * durable checkout admission was still owned. This is the crash window after
 * the harness result/steering acknowledgement but before executeTask applies
 * the assistant turn and stage lifecycle.
 */
async function finalizeCompletedAdmittedTaskRuns(
  dependencies: TaskRecoveryDependencies,
  admissionSnapshot: TaskAdmissionSnapshot,
): Promise<void> {
  for (const run of await getCompletedTaskRunsForStaleAdmissions()) {
    // Isolate every run so one failure cannot skip the remaining runs or the
    // recovery steps after this one. An unsettled run keeps its
    // pending-finalization marker (the admission is swept as usual), so the
    // next boot finds and retries it.
    try {
      await finalizeCompletedAdmittedTaskRun(
        run,
        dependencies,
        admissionSnapshot,
      );
    } catch (error) {
      if (error instanceof SharedCheckoutBusyError) {
        logger.warn(
          { runId: run.id, task_id: run.task_id },
          'Deferred completed admitted task run: checkout is held by another owner',
        );
        continue;
      }
      logger.error(
        { runId: run.id, task_id: run.task_id, err: error },
        'Failed to finalize completed admitted task run; continuing recovery',
      );
    }
  }
}

/** Restart-recovery options threaded into recovered Testing/Review verdicts. */
interface RecoveredVerdictOptions {
  deferToOtherCheckoutOwner?: boolean;
  /** The run whose result is applied; its own stage moves are not user moves. */
  recoveryRunId?: string;
  transitionValues?: (status: string) => Record<string, string>;
  /** The deploy is left to the `deploy_pending_dispatch` marker. */
  deferDeploy?: boolean;
  /** The caller already holds the task's shared-checkout lease. */
  leaseAlreadyHeld?: boolean;
}

/** `stage` is the done stage that deploys the project's merged work. */
function isDeployDoneStage(
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  stages: StageDefinition[],
  stage: string,
): boolean {
  return (
    !!group.settings?.deployService &&
    findStage(stages, stage)?.type === 'done' &&
    stage === getDeployStageId(group.settings, stages)
  );
}

/**
 * Restart recovery never awaits a build: the card gets the dispatch receipt in
 * the same update that moves it into the deploy stage, and the boot's
 * `recoverPendingDeployDispatches` step starts the build without blocking.
 */
function deployDispatchValues(
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  stages: StageDefinition[],
  stage: string,
): Record<string, string> {
  return isDeployDoneStage(group, stages, stage)
    ? { [DEPLOY_PENDING_DISPATCH_KEY]: recoveredDeployDispatchValue() }
    : {};
}

async function finalizeCompletedAdmittedTaskRun(
  run: Awaited<
    ReturnType<typeof getCompletedTaskRunsForStaleAdmissions>
  >[number],
  dependencies: TaskRecoveryDependencies,
  admissionSnapshot: TaskAdmissionSnapshot,
): Promise<void> {
  const admissionOwnerToken = admissionSnapshot
    .get(run.group_folder)
    ?.get(run.task_id);
  // Only the admission bound to this exact run is this run's to release; a
  // newer run of the same card owns the task's current admission.
  const admissionHeld =
    run.admitted && !!admissionSnapshot.get(run.group_folder)?.has(run.task_id);
  // The run's own project owns both the admission and the marker, whatever
  // project the task row says now.
  const settleSuperseded = () =>
    settlePendingFinalizationRun(
      run.group_folder,
      run.task_id,
      run.id,
      admissionHeld ? { ownerToken: admissionOwnerToken } : undefined,
    );
  const task = await getTask(run.task_id);
  if (!task) {
    await settleSuperseded();
    return;
  }
  // Apply a run only to the card, project and stage it belongs to. Anything
  // else moved on after the run completed; its result no longer applies.
  const latestRun = await getLastActiveRunForTask(task.id);
  const supersede = async () => {
    logger.warn(
      { runId: run.id, task_id: task.id, project_id: task.project_id },
      'Dropping completed task run recovery: the card moved on since the run',
    );
    await settleSuperseded();
  };
  if (
    task.archived ||
    task.project_id !== run.group_folder ||
    (latestRun && latestRun.id !== run.id)
  ) {
    await supersede();
    return;
  }
  const group = getGroupByFolder(task.project_id);
  if (!group) {
    // Keep the marker for a later boot; one unloaded project must not block
    // the remaining runs or abort startup.
    logger.warn(
      { runId: run.id, task_id: task.id, project_id: task.project_id },
      'Cannot finalize completed admitted task: project is not loaded',
    );
    return;
  }
  // A card that left the run's stage was moved by this recovery only when the
  // move recorded it (same update). Any other move, whoever made it, means the
  // card moved on: the result is not applied.
  if (
    run.stage &&
    task.status !== run.stage &&
    readRecoveryTransition(task, run.id)?.stage !== task.status
  ) {
    await supersede();
    return;
  }
  // Written in the same update as any stage move this recovery makes (here or
  // inside recovered Testing/Review verdicts): the proof of its own move, the
  // completion notice a done stage still owes, and a deploy stage's dispatch
  // receipt so an undispatched build is redispatched.
  const groupStages = getGroupStages(group);
  const ownTransitionValues = (stage: string): Record<string, string> => {
    const isDone = findStage(groupStages, stage)?.type === 'done';
    return {
      ...recoveryTransitionValue(
        run.id,
        stage,
        isDone && !isDeployDoneStage(group, groupStages, stage),
      ),
      ...deployDispatchValues(group, groupStages, stage),
    };
  };
  const recoveryOptions: RecoveredVerdictOptions = {
    deferToOtherCheckoutOwner: true,
    recoveryRunId: run.id,
    transitionValues: ownTransitionValues,
    deferDeploy: true,
  };
  const recordNoticeSent = (stage: string) =>
    updateTask(
      task.id,
      { custom_values: recoveryTransitionValue(run.id, stage, false) },
      { mergeCustomValues: true },
    );

  const { result, sessionId } = completedTaskRunOutcome(run);
  let successfulTaskBoundary: RecoveredSuccessfulTaskBoundary | undefined;
  const automaticStageEntry = await getStageEntryEventByRunId(run.id);
  let steeringHeld = false;
  let finalized = false;
  let gitFinalizationFailed = false;
  const persistRunDirArtifacts = async () => {
    const hostDir = resolveHostRunDir(run);
    if (
      hostDir &&
      persistRecoveredRunArtifacts(
        run,
        hostDir,
        recoveredTranscriptTarget(run, sessionId),
      )
    ) {
      await removeRunDirPreservingControlResponses(hostDir);
    }
  };
  const inGitFinalization = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      // A checkout held by another owner or a failed task-state read/write
      // defers the run; neither is a Git failure to park.
      if (
        !(error instanceof SharedCheckoutBusyError) &&
        !(error instanceof TaskStateError)
      ) {
        gitFinalizationFailed = true;
      }
      throw error;
    }
  };
  try {
    // Inside the try so the finally below closes the steering boundary even
    // when recovering the output throws after the boundary was acquired.
    if (!automaticStageEntry) {
      await beginRecoveredSuccessfulTaskFinalization(
        run,
        result,
        sessionId,
        (value) => {
          successfulTaskBoundary = value;
        },
        () =>
          broadcast({
            type: 'run_finished',
            payload: {
              project_id: task.project_id,
              task_id: task.id,
              run_id: run.id,
            },
          }),
      );
      steeringHeld = successfulTaskBoundary?.boundary.shouldAdvance === false;
    }
    const entryOutcomeRecovered = automaticStageEntry
      ? await recoverAutomaticStageEntryRunOutcome(run, {
          failed: false,
          output: result,
          sessionId,
        })
      : false;

    if (!entryOutcomeRecovered && !steeringHeld) {
      const currentTask = (await getTask(task.id)) ?? task;
      const stages = getGroupStages(group);
      const startingStage = run.stage || task.status;
      const startingStageDefinition = findStage(stages, startingStage);
      const stageEntryEventRef: StageEntryEventRef = {};

      // Only this recovery's own earlier move reaches here (see the guard
      // above): keep that transition, repair the active-stage result bubble
      // it may have missed, and replay what the move still owes. A pending
      // deploy keeps its dispatch receipt and is redispatched by
      // recoverPendingDeployDispatches.
      if (currentTask.status !== startingStage) {
        if (startingStageDefinition?.type === 'active') {
          appendCompletedTaskRunResult(currentTask, run, result);
        }
        const transition = readRecoveryTransition(currentTask, run.id);
        if (transition?.stage === currentTask.status) {
          const owedHandoff = await getPendingTaskStageHandoff(
            currentTask,
            startingStage,
          );
          if (owedHandoff?.toStage === currentTask.status) {
            await finalizeTaskStageHandoff(currentTask, owedHandoff, run.id);
          }
          if (transition.notice) {
            await notifyRecoveredTaskLifecycle(run, 'completed');
            await recordNoticeSent(transition.stage);
          }
        }
      } else {
        const hasRepositoryCheckout = Boolean(
          currentTask.worktree_path ||
          currentTask.branch_name ||
          group.settings?.repositoryLocation ||
          group.settings?.repositoryUrl ||
          group.settings?.repositoryRelativePath,
        );
        if (hasRepositoryCheckout) {
          const recoveryLease = currentTask.worktree_path
            ? undefined
            : await acquireSharedCheckoutLease(
                task.project_id,
                { type: 'task', id: task.id },
                { reattachActiveOwner: true, deferToOtherOwner: true },
              );
          try {
            // Read outside the Git classification: a database error here is a
            // retryable failure, not a checkpoint failure to park.
            const checkpointTask = await getTask(task.id);
            await inGitFinalization(() =>
              (dependencies.runPostExecutionGitOps ?? runPostExecutionGitOps)(
                currentTask,
                group,
                stages,
                {
                  currentTask: checkpointTask ?? null,
                  resumeRestoredCheckpoint: true,
                  propagateStateErrors: true,
                },
              ),
            );
          } finally {
            await recoveryLease?.release();
          }
        }

        const recoveredHandoff = await getPendingTaskStageHandoff(
          currentTask,
          startingStage,
        );
        const testingRecovered = !recoveredHandoff
          ? await recoverTestingRun(
              currentTask,
              group,
              stages,
              result,
              sessionId,
              run.agent_name,
              run.model_name ?? undefined,
              false,
              startingStage,
              run.id,
              stageEntryEventRef,
              runGitInRepo,
              recoveryOptions,
            )
          : false;
        const reviewRecovered =
          !recoveredHandoff && !testingRecovered
            ? await recoverReviewRun(
                currentTask,
                group,
                stages,
                result,
                sessionId,
                run.sandbox_instance,
                run.agent_name,
                run.model_name ?? undefined,
                startingStage,
                run.id,
                stageEntryEventRef,
                recoveryOptions,
              )
            : false;

        if (!testingRecovered && !reviewRecovered) {
          appendCompletedTaskRunResult(currentTask, run, result);
          const targetStage = recoveredHandoff
            ? recoveredHandoff.toStage
            : (getNextActiveStage(
                stages,
                startingStage,
                currentTask.skip_stages ?? undefined,
              )?.id ??
              getDoneStage(stages)?.id ??
              'completed');
          const reachesDone = findStage(stages, targetStage)?.type === 'done';
          // A false merge result has already parked the task with a visible
          // notice; it is a non-fatal outcome, not a boot failure. The merge
          // never waits for another owner's checkout lease: boot could not
          // reach that orphan's recovery while waiting here.
          // Read outside the Git classification: a database error here is a
          // retryable failure, not a merge failure to park.
          const mergeTask = reachesDone
            ? ((await getTask(task.id)) ?? currentTask)
            : currentTask;
          const mergeReady =
            !reachesDone ||
            (await inGitFinalization(async () =>
              mergeBranchForDeploy(
                mergeTask,
                group,
                group.settings?.deployService ? 'deploy' : 'recovery',
                undefined,
                {
                  deferToOtherOwner: true,
                  currentTask: mergeTask,
                  propagateStateErrors: true,
                },
              ),
            ));
          if (!mergeReady) {
            gitFinalizationFailed = true;
            // The park is durable now; settle it before any later cleanup can
            // throw and leave the run to be replayed onto the parked card.
            await settleSuperseded();
            logger.warn(
              { runId: run.id, task_id: task.id },
              'Completed admitted run left parked after Git merge finalization did not complete',
            );
          } else {
            const completedAt = reachesDone ? new Date().toISOString() : null;
            const stageEntryEvent = await updateTask(
              task.id,
              {
                status: targetStage,
                completed_at: completedAt,
                session_id: sessionId ?? currentTask.session_id,
                last_agent_name: run.agent_name ?? currentTask.last_agent_name,
                ...(result ? { output: result } : {}),
                ...(run.sandbox_instance
                  ? { sandbox_instance: run.sandbox_instance }
                  : {}),
                custom_values: ownTransitionValues(targetStage),
              },
              { mergeCustomValues: true, recoveryRunId: run.id },
            );
            if (recoveredHandoff) {
              await finalizeTaskStageHandoff(
                currentTask,
                recoveredHandoff,
                run.id,
                stageEntryEvent?.id,
              );
            }
            // A deploy stage's notice and build belong to the dispatch step.
            if (reachesDone && !isDeployDoneStage(group, stages, targetStage)) {
              await notifyRecoveredTaskLifecycle(
                run,
                'completed',
                stageEntryEvent?.id,
              );
              await recordNoticeSent(targetStage);
            }
          }
        }
      }
    }

    await persistRunDirArtifacts();
    finalized = !gitFinalizationFailed;
  } catch (error) {
    // Git checkpoint/commit/merge failures park the task like the stalled-run
    // path instead of aborting boot; the admission is released below so the
    // next restart does not hit the same failure again.
    if (!gitFinalizationFailed) throw error;
    const parkedTask = (await getTask(task.id)) ?? task;
    await parkTaskAfterGitCheckpointFailure(
      parkedTask,
      getGroupStages(group),
      error,
    );
    // Settle the durable park before any later write or cleanup can throw.
    await settleSuperseded();
    await updateTask(task.id, {
      error: `Recovery checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    logger.warn(
      { runId: run.id, task_id: task.id, error: String(error) },
      'Completed admitted run parked after finalization failure',
    );
    await persistRunDirArtifacts();
  } finally {
    if (successfulTaskBoundary) {
      try {
        const finalTask = await getTask(task.id);
        if (finalTask) {
          steeringHeld =
            (await closeTaskSteeringAdmissionWindow(
              finalTask,
              successfulTaskBoundary.boundary.startingStage,
              finalized,
              successfulTaskBoundary.boundary.release,
            )) || steeringHeld;
        } else {
          successfulTaskBoundary.boundary.release();
        }
      } finally {
        // Unconditional: a failed reload or close must not leave the steering
        // lock held for the next same-process recovery.
        endSuccessfulTaskFinalization(successfulTaskBoundary.boundary);
      }
    }
  }

  // Reached only when the outcome is durable (applied, or parked after a Git
  // failure) and steering has closed; any throw above keeps the marker.
  const settledTask = await getTask(task.id);
  if (settledTask && readRecoveryTransition(settledTask, run.id)) {
    await updateTask(
      task.id,
      {},
      { omitCustomValueKeys: [RECOVERY_TRANSITION_KEY] },
    );
  }
  await settleSuperseded();
  if (steeringHeld) {
    await (dependencies.drainProjectQueue ?? drainProjectQueue)(
      task.project_id,
      group,
    );
  }
  logger.info(
    { runId: run.id, task_id: task.id, stage: run.stage, steeringHeld },
    'Finalized completed admitted task run during restart recovery',
  );
}

/**
 * Release the exact task run adopted by restart recovery before waking the
 * project queue. A stale watcher may still reach this boundary after a newer
 * run has claimed the same task; the claim owner check keeps that newer run
 * intact and suppresses the obsolete run_finished event.
 */
export async function finishRecoveredTaskRun(
  run: RecoveredTaskRun,
  recoveryAbortController: AbortController,
  dependencies: RecoveredTaskReleaseDependencies = {},
): Promise<boolean> {
  const loadTask = dependencies.getTask ?? getTask;
  const resolveGroup = dependencies.getGroupByFolder ?? getGroupByFolder;
  const drain = dependencies.drainProjectQueue ?? drainProjectQueue;
  const recoveredTask = await loadTask(run.task_id);
  const recoveredProjectId = recoveredTask?.project_id ?? run.group_folder;
  const finished = finishRecoveredTaskExecution(
    run.task_id,
    recoveredProjectId,
    recoveryAbortController,
    run.id,
    dependencies.emit,
  );
  unregisterRecoveredTaskAbort(run.task_id, recoveryAbortController);

  const recoveredGroup = resolveGroup(recoveredProjectId);
  if (recoveredGroup) await drain(recoveredProjectId, recoveredGroup);
  return finished;
}

/**
 * Advance schedules whose agent run became terminal before the scheduler could
 * persist its result. This crash window otherwise leaves the occurrence due,
 * while getDueTasks correctly refuses to dispatch it a second time.
 */
export async function recoverUnfinalizedScheduledRuns(): Promise<void> {
  const runs = await getUnfinalizedScheduledRuns();
  if (runs.length === 0) return;

  const recoveredTaskIds = new Set<string>();
  for (const run of runs) {
    const taskId = run.scheduled_task_id;
    if (!taskId || recoveredTaskIds.has(taskId)) continue;
    recoveredTaskIds.add(taskId);

    const task = await getTaskById(taskId);
    if (!task) continue;

    // The scheduler may crash after marking active_runs terminal but before
    // its normal transcript preservation and IPC cleanup. Recover those
    // immutable artifacts before making the occurrence canonical.
    const runHostDir = resolveHostRunDir(run);
    if (runHostDir && fs.existsSync(runHostDir)) {
      const preserved = persistPerRunTranscript(
        run.group_folder,
        run.id,
        runHostDir,
      );
      if (preserved) {
        try {
          removeIpcDirSync(runHostDir);
        } catch (err) {
          logger.warn(
            { runId: run.id, runHostDir, error: String(err) },
            'Failed to remove recovered scheduled run directory',
          );
        }
      } else {
        logger.warn(
          { runId: run.id, runHostDir },
          'Preserving scheduled IPC directory after transcript copy failure',
        );
      }
    }

    const resultSummary =
      run.status === 'completed'
        ? 'Completed (finalized during restart recovery)'
        : `Error: run ${run.status} before schedule finalization`;
    const successful = run.status === 'completed';
    try {
      if (!(await hasTaskRunLogForRun(run.id)))
        await logTaskRun({
          task_id: taskId,
          run_id: run.id,
          run_at: run.started_at,
          duration_ms: Math.max(
            0,
            new Date(run.completed_at ?? new Date().toISOString()).getTime() -
              new Date(run.started_at).getTime(),
          ),
          status: successful ? 'success' : 'error',
          result: successful ? resultSummary : null,
          error: successful ? null : resultSummary.slice('Error: '.length),
        });
    } catch (err) {
      logger.error(
        { runId: run.id, task_id: taskId, error: String(err) },
        'Failed to persist unfinalized scheduled task run log',
      );
    }
    await updateScheduledTaskAfterRun(
      taskId,
      calcNextRun(task),
      resultSummary,
      task,
    );
    logger.info(
      { runId: run.id, task_id: taskId, status: run.status },
      'Recovered unfinalized scheduled task run',
    );
  }
}

/** Retry scheduled occurrences claimed before capacity acquisition when the
 * previous process stopped before it could create an active_runs row. */
export async function recoverOrphanedScheduledTaskClaims(): Promise<void> {
  const taskIds = await releaseOrphanedScheduledTaskOccurrenceClaims();
  if (taskIds.length > 0) {
    logger.info(
      { taskIds, count: taskIds.length },
      'Released orphaned scheduled task occurrence claims',
    );
  }
}

async function finalizeTerminalScheduledRecovery(
  run: NonNullable<Awaited<ReturnType<typeof getActiveRunById>>>,
  hostDir: string | null,
  terminalStatus: 'completed' | 'error' | 'stalled' | 'timeout',
  result: string | null,
  error: string | null,
): Promise<void> {
  const taskId = run.scheduled_task_id;
  if (!taskId) return;
  const task = await getTaskById(taskId);
  const preserved = hostDir
    ? persistPerRunTranscript(run.group_folder, run.id, hostDir)
    : true;
  await completeActiveRun(run.id, terminalStatus);
  if (!(await hasTaskRunLogForRun(run.id))) {
    try {
      await logTaskRun({
        task_id: taskId,
        run_id: run.id,
        run_at: run.started_at,
        duration_ms: Math.max(
          0,
          Date.now() - new Date(run.started_at).getTime(),
        ),
        status: terminalStatus === 'completed' ? 'success' : 'error',
        result,
        error,
      });
    } catch (logError) {
      logger.error(
        { task_id: taskId, runId: run.id, error: String(logError) },
        'Failed to persist terminal scheduled recovery log',
      );
    }
  }
  if (task) {
    const summary = error ? `Error: ${error}` : result || 'Completed';
    await updateScheduledTaskAfterRun(taskId, calcNextRun(task), summary, task);
  }
  if (hostDir && preserved) {
    removeIpcDirSync(hostDir);
  } else if (hostDir) {
    logger.warn(
      { runId: run.id, hostDir },
      'Preserving scheduled IPC directory after recovery transcript copy failure',
    );
  }
}

function readPendingReviewers(
  customValues?: Record<string, string | number>,
): ReviewerVerdictSummary[] | undefined {
  const raw = customValues?.[PENDING_REVIEW_REVIEWERS_KEY];
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Park a recovered review in the initial queue stage and say why. */
async function parkRecoveredReview(
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>,
  stages: ReturnType<typeof getProjectStages>,
  notice: (manualStage: string) => string,
  changes: Parameters<typeof updateTask>[1],
  recoveryRunId?: string,
): Promise<void> {
  const manualStage = getInitialStage(stages)?.id ?? task.status;
  const current = (await getTask(task.id)) || task;
  await updateTask(
    task.id,
    {
      ...changes,
      status: manualStage,
      custom_values: {
        ...(current.custom_values || {}),
        [REVIEW_CHAIN_KEY]: '',
        [REVIEW_CHAIN_RUN_KEY]: '',
      },
    },
    recoveryRunId ? { recoveryRunId } : undefined,
  );
  const message = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content: notice(manualStage),
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: { task_id: task.id, project_id: task.project_id, message },
  });
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
}

function clearRecoveredReviewStream(
  task: { id: string; project_id: string },
  runId: string | undefined,
): void {
  clearTaskStreamBuffer(task.id);
  broadcast({
    type: 'task_output_clear',
    payload: { task_id: task.id, project_id: task.project_id, run_id: runId },
  });
}

/**
 * Recover a review-chain reviewer (task `co_stages`) through the chain
 * accumulator, never as an individual verdict: record it, then either leave
 * the card in review for the next reviewer or decide it from every verdict.
 */
async function recoverReviewChainRun(input: {
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>;
  lifecycleTask: NonNullable<Awaited<ReturnType<typeof getTask>>>;
  group: NonNullable<ReturnType<typeof getGroupByFolder>>;
  stages: ReturnType<typeof getProjectStages>;
  recoveredStage: string;
  marker: ReviewChainRunMarker;
  result: string | null;
  sessionId: string | undefined;
  sandboxInstance: string | null | undefined;
  agentName: string | null | undefined;
  modelName: string | undefined;
  runId: string | undefined;
  stageEntryEventRef?: StageEntryEventRef;
  /** The run ended in a terminal error: it counts as no decision. */
  failure?: string;
  recoveryOptions?: RecoveredVerdictOptions;
}): Promise<boolean> {
  const { task, marker, stages, recoveredStage } = input;
  const stored = readReviewChain(task.custom_values);
  const extraIndex = marker.stages.indexOf(marker.stage_id);
  const continuesStored =
    marker.role === 'extra' &&
    !!stored &&
    stored.started_at === marker.started_at &&
    stored.verdicts.length === extraIndex + 1;
  if (marker.role === 'extra' && !continuesStored) {
    await parkRecoveredReview(
      task,
      stages,
      (manualStage) =>
        `**Recovered review verdict was not applied** — its review chain is no longer consistent. The task was paused in \`${manualStage}\`; re-run the task to start the review again.`,
      { output: input.result ?? undefined },
      input.recoveryOptions?.recoveryRunId,
    );
    clearRecoveredReviewStream(task, input.runId);
    return true;
  }

  const decision = parseReviewDecision(input.result ?? '');
  const verdict: ReviewChainVerdict = {
    stage_id: marker.stage_id,
    reviewer: input.modelName || input.agentName || marker.stage_id,
    decision: decision?.decision ?? null,
    score: decision?.score ?? null,
    issues: decision?.issues ?? [],
    summary: decision?.summary ?? '',
  };
  const chain: ReviewChain = {
    head: marker.head,
    started_at: marker.started_at,
    manual: marker.manual,
    after_run_id: '',
    stages: marker.stages,
    verdicts: [...(continuesStored ? stored!.verdicts : []), verdict],
  };

  const nextStage = nextReviewChainStage(chain);
  if (nextStage) {
    const append = (message: Parameters<typeof appendTaskMessage>[1]) => {
      const saved = appendTaskMessage(task.project_id, message);
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: saved,
        },
      });
    };
    if (input.result?.trim()) {
      append({
        task_id: task.id,
        role: 'assistant',
        content: input.result,
        agent_name: input.agentName ?? null,
        model_name: input.modelName ?? null,
        entry_type: 'run_result',
        run_id: input.runId ?? null,
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
    await updateTask(task.id, {
      custom_values: {
        ...(task.custom_values || {}),
        [REVIEW_CHAIN_KEY]: JSON.stringify({
          ...chain,
          after_run_id: (await getLastActiveRunForTask(task.id))?.id ?? '',
        }),
        [REVIEW_CHAIN_RUN_KEY]: '',
      },
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.agentName ? { last_agent_name: input.agentName } : {}),
      ...(input.sandboxInstance
        ? { sandbox_instance: input.sandboxInstance }
        : {}),
    });
    const updated = await getTask(task.id);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
    clearRecoveredReviewStream(task, input.runId);
    logger.info(
      { task_id: task.id, decision: verdict.decision, nextStage },
      'Recovery: recorded review chain verdict; next reviewer will run',
    );
    return true;
  }

  const outcome = aggregateReviewChain(chain.verdicts);
  if (outcome.kind === 'incomplete' && input.failure) {
    // No reviewer rejected: leave it to the generic failed-run handling.
    await updateTask(task.id, {
      custom_values: {
        ...(task.custom_values || {}),
        [REVIEW_CHAIN_KEY]: '',
        [REVIEW_CHAIN_RUN_KEY]: '',
      },
    });
    return false;
  }
  if (outcome.kind === 'incomplete') {
    await parkRecoveredReview(
      task,
      stages,
      (manualStage) =>
        `**Review incomplete** — ${outcome.failedReviewers.join(', ')} produced no valid decision, so the task was not approved. The task was paused in \`${manualStage}\` for manual inspection. Re-run the task to start the review again.`,
      {
        output: input.result ?? undefined,
        session_id: input.sessionId,
      },
      input.recoveryOptions?.recoveryRunId,
    );
    clearRecoveredReviewStream(task, input.runId);
    return true;
  }

  const compound = outcome.decision;
  const current = (await getTask(task.id)) || task;
  // Same first-rejection handling as a single recovered verdict.
  const firstRejection =
    compound.decision === 'reject' &&
    isFirstReviewRejection(
      current.custom_values,
      readReviewHistory(current.custom_values),
    );
  await handleReviewDecision(compound, {
    ...(firstRejection
      ? {
          rejection_comparison: buildFirstRejectionComparison(compound),
          rejection_comparison_attempted: true,
        }
      : {}),
    task: input.lifecycleTask,
    group: input.group,
    stages,
    targetStatus: recoveredStage,
    runId: input.runId,
    completionStageId:
      getNextActiveStage(stages, recoveredStage, task.skip_stages ?? undefined)
        ?.id ??
      getDoneStage(stages)?.id ??
      'completed',
    assistantContent: input.result ?? '',
    agent_name: input.agentName ?? null,
    model_name: input.modelName ?? null,
    newSessionId: input.sessionId,
    sandbox_instance: input.sandboxInstance ?? undefined,
    review_head_sha: chain.head,
    reviewer_verdicts: summarizeReviewerVerdicts(chain.verdicts),
    ...input.recoveryOptions,
    stageEntryEventRef: input.stageEntryEventRef,
  });
  clearRecoveredReviewStream(task, input.runId);
  logger.info(
    { task_id: task.id, decision: compound.decision },
    'Recovery: decided review chain from all reviewer verdicts',
  );
  return true;
}

/**
 * A review-chain reviewer that ended in a terminal error across a restart
 * counts as a reviewer without a decision: the chain continues and any
 * recorded rejection is applied once. Transient errors and runs that are not
 * part of a chain are left to the generic recovery.
 */
export async function recoverFailedReviewChainRun(
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>,
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  stages: ReturnType<typeof getProjectStages>,
  errorText: string,
  sessionId: string | undefined,
  sandboxInstance: string | null | undefined,
  agentName: string | null | undefined,
  modelName: string | undefined,
  runStage?: string | null,
  runId?: string,
  stageEntryEventRef?: StageEntryEventRef,
  recoveryOptions?: RecoveredVerdictOptions,
): Promise<boolean> {
  const recoveredStage = runStage || task.status;
  if (!isReviewStage(stages, recoveredStage) || isRetryableTaskError(errorText))
    return false;
  const chainTask = (await getTask(task.id)) || task;
  const marker = readReviewChainRun(chainTask.custom_values);
  if (!runId || marker?.run_id !== runId) return false;
  const lifecycleTask =
    recoveredStage === chainTask.status
      ? chainTask
      : { ...chainTask, status: recoveredStage };
  return recoverReviewChainRun({
    task: chainTask,
    lifecycleTask,
    group,
    stages,
    recoveredStage,
    marker,
    result: null,
    sessionId,
    sandboxInstance,
    agentName,
    modelName,
    runId,
    stageEntryEventRef,
    recoveryOptions,
    failure: errorText.slice(0, 500) || 'Agent exited with an error',
  });
}

/**
 * Finish a review run that survived a board restart through the same verdict
 * path as the normal in-process executor. Generic recovery must never treat a
 * successful review process as an implicit approval.
 */
export async function recoverReviewRun(
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>,
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  stages: ReturnType<typeof getProjectStages>,
  result: string | null,
  sessionId: string | undefined,
  sandboxInstance: string | null | undefined,
  agentName: string | null | undefined,
  modelName: string | undefined,
  runStage?: string | null,
  runId?: string,
  stageEntryEventRef?: StageEntryEventRef,
  recoveryOptions: RecoveredVerdictOptions = {},
): Promise<boolean> {
  const recoveredStage = runStage || task.status;
  if (!isReviewStage(stages, recoveredStage)) return false;
  const lifecycleTask =
    recoveredStage === task.status ? task : { ...task, status: recoveredStage };

  // Reviewers of a `co_stages` chain are never applied individually: a run
  // that matches its chain marker joins the chain accumulator, and a verdict
  // that cannot be placed in a chain is parked instead of merging or
  // rejecting on one reviewer's word.
  const chainTask = (await getTask(task.id)) || task;
  const chainMarker = readReviewChainRun(chainTask.custom_values);
  if (runId && chainMarker?.run_id === runId) {
    return recoverReviewChainRun({
      task: chainTask,
      lifecycleTask,
      group,
      stages,
      recoveredStage,
      marker: chainMarker,
      result,
      sessionId,
      sandboxInstance,
      agentName,
      modelName,
      runId,
      stageEntryEventRef,
      recoveryOptions,
    });
  }

  const decision = parseReviewDecision(result ?? '');
  if (
    decision &&
    (readReviewChain(chainTask.custom_values) ||
      resolveCoReviewStages(group, chainTask, recoveredStage).length > 0)
  ) {
    await parkRecoveredReview(
      chainTask,
      stages,
      (manualStage) =>
        `**Recovered review verdict was not applied** — this task has extra reviewers and the recovered run could not be matched to its review chain. The task was paused in \`${manualStage}\`; re-run the task to start the review again.`,
      { output: result ?? undefined, session_id: sessionId },
      recoveryOptions.recoveryRunId,
    );
    clearRecoveredReviewStream(task, runId);
    return true;
  }
  if (decision) {
    const completionStageId =
      getNextActiveStage(stages, recoveredStage, task.skip_stages ?? undefined)
        ?.id ??
      getDoneStage(stages)?.id ??
      'completed';
    // Same first-rejection handling as the in-process executor: with nothing to
    // compare against, an unset comparison would count as "ambiguous" no-progress.
    const currentTask = (await getTask(task.id)) || task;
    const firstRejection =
      decision.decision === 'reject' &&
      isFirstReviewRejection(
        currentTask.custom_values,
        readReviewHistory(currentTask.custom_values),
      );
    await handleReviewDecision(decision, {
      ...(firstRejection
        ? {
            rejection_comparison: buildFirstRejectionComparison(decision),
            rejection_comparison_attempted: true,
          }
        : {}),
      task: lifecycleTask,
      group,
      stages,
      targetStatus: recoveredStage,
      runId,
      completionStageId,
      assistantContent: result ?? '',
      agent_name: agentName ?? null,
      model_name: modelName ?? null,
      newSessionId: sessionId,
      sandbox_instance: sandboxInstance ?? undefined,
      stageEntryEventRef,
      ...recoveryOptions,
    });
    clearTaskStreamBuffer(task.id);
    broadcast({
      type: 'task_output_clear',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        run_id: runId,
      },
    });
    logger.info(
      { task_id: task.id, decision: decision.decision },
      'Recovery: handled structured review verdict',
    );
    return true;
  }

  const comparison = parseReviewComparison(result ?? '');
  const pending = parsePendingReviewDecision(
    typeof task.custom_values?.pending_review_decision === 'string'
      ? task.custom_values.pending_review_decision
      : '',
  );
  if (comparison && pending?.decision === 'reject') {
    const completionStageId =
      getNextActiveStage(stages, recoveredStage, task.skip_stages ?? undefined)
        ?.id ??
      getDoneStage(stages)?.id ??
      'completed';
    const message = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'assistant',
      content: `**Review comparison** — ${comparison.decision}: ${comparison.reason}`,
      agent_name: agentName ?? null,
      model_name: modelName ?? null,
      created_at: new Date().toISOString(),
    });
    broadcast({
      type: 'task_message',
      payload: { task_id: task.id, project_id: task.project_id, message },
    });
    await handleReviewDecision(pending, {
      task: lifecycleTask,
      group,
      stages,
      targetStatus: recoveredStage,
      runId,
      completionStageId,
      assistantContent: result ?? '',
      agent_name: agentName ?? null,
      model_name: modelName ?? null,
      newSessionId: sessionId,
      sandbox_instance: sandboxInstance ?? undefined,
      review_head_sha:
        typeof task.custom_values?.pending_review_head === 'string'
          ? task.custom_values.pending_review_head
          : undefined,
      reviewer_verdicts: readPendingReviewers(task.custom_values),
      rejection_comparison: comparison,
      rejection_comparison_attempted: true,
      rejection_feedback_persisted: true,
      stageEntryEventRef,
      ...recoveryOptions,
    });
    clearTaskStreamBuffer(task.id);
    broadcast({
      type: 'task_output_clear',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        run_id: runId,
      },
    });
    return true;
  }

  // Preserve the raw output for diagnostics, but do not leave the card in the
  // executable review stage: the queue would repeatedly launch the same
  // unparseable review. Park it in the initial queue stage instead.
  const manualStage = getInitialStage(stages)?.id ?? task.status;
  await updateTask(
    task.id,
    {
      status: manualStage,
      output: result ?? undefined,
      session_id: sessionId,
      sandbox_instance: sandboxInstance ?? undefined,
    },
    recoveryOptions.recoveryRunId
      ? { recoveryRunId: recoveryOptions.recoveryRunId }
      : undefined,
  );
  const notice = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content: `**Recovered review output could not be parsed** — the task was paused in \`${manualStage}\` for manual inspection.`,
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: { task_id: task.id, project_id: task.project_id, message: notice },
  });
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
  clearTaskStreamBuffer(task.id);
  broadcast({
    type: 'task_output_clear',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      run_id: runId,
    },
  });
  logger.warn(
    { task_id: task.id },
    'Recovery: unparseable review output; task parked for manual resolution',
  );
  return true;
}

/** Recover testing through its structured lifecycle; success is never implicit. */
export async function recoverTestingRun(
  task: NonNullable<Awaited<ReturnType<typeof getTask>>>,
  group: NonNullable<ReturnType<typeof getGroupByFolder>>,
  stages: ReturnType<typeof getProjectStages>,
  result: string | null,
  sessionId: string | undefined,
  agentName: string | null | undefined,
  modelName: string | undefined,
  runFailed = false,
  runStage?: string | null,
  runId?: string,
  stageEntryEventRef?: StageEntryEventRef,
  runGit: typeof runGitInRepo = runGitInRepo,
  recoveryOptions: RecoveredVerdictOptions = {},
): Promise<boolean> {
  const recoveredStage = runStage || task.status;
  if (!isTestingStage(stages, recoveredStage)) return false;
  const decision = runFailed ? null : parseTestingDecision(result ?? '');
  // A run whose verdict was applied just before a crash is not applied again.
  if (
    decision &&
    testingRunAlreadyApplied(
      ((await getTask(task.id)) ?? task).custom_values,
      runId,
    )
  ) {
    return true;
  }
  let lifecycleTask =
    recoveredStage === task.status ? task : { ...task, status: recoveredStage };
  if (decision?.decision !== 'pass' && task.last_agent_name) {
    const implementationStage = getFirstExecutableStage(stages);
    const implementationSession = implementationStage
      ? await getLastRunSessionForStage(
          task.id,
          implementationStage.id,
          task.last_agent_name,
        )
      : undefined;
    if (implementationSession)
      lifecycleTask = { ...lifecycleTask, session_id: implementationSession };
  }
  const context = {
    task: lifecycleTask,
    group,
    stages,
    targetStatus: recoveredStage,
    assistantContent: result ?? '',
    agent_name: agentName ?? null,
    model_name: modelName ?? null,
    newSessionId: sessionId,
    stageEntryEventRef,
    runId,
    ...recoveryOptions,
  };
  const nextStage = getNextActiveStage(
    stages,
    recoveredStage,
    task.skip_stages ?? undefined,
  );
  if (decision?.decision === 'pass' && nextStage?.type === 'review') {
    // Same binding as the live executor: the pass becomes Review evidence only
    // when the settled checkout still has the tree inspected at slot time. The
    // call sites have already run post-execution Git checkpointing.
    const latestTask = (await getTask(task.id)) ?? task;
    const inspected = readTestingInspectedIdentity(latestTask, runId);
    const finalIdentity = await readTaskGitContentIdentity(
      latestTask,
      group,
      runGit,
    );
    if (!inspected) {
      persistTestingAssistantResponse({ ...context, decision });
      await retryTestingAfterGitStateChange(
        lifecycleTask,
        recoveredStage,
        '**Testing must run again — the content it validated could not be confirmed after a restart.**',
      );
    } else if (!finalIdentity) {
      await handleTestingBlocked(
        'The final prepared Review state is dirty or its Git commit and content tree could not be resolved, so the passing evidence cannot be recorded.',
        context,
      );
    } else if (inspected.treeSha !== finalIdentity.treeSha) {
      persistTestingAssistantResponse({ ...context, decision });
      await retryTestingAfterGitStateChange(lifecycleTask, recoveredStage);
    } else {
      await handleTestingDecision(decision, {
        ...context,
        testingHeadSha: inspected.headSha,
        testingTreeSha: inspected.treeSha,
      });
    }
  } else if (decision?.decision === 'pass') {
    // Without a following Review there is no inspected identity to recover, but
    // a tester chain still needs the settled commit and tree to compare the
    // testers' content, exactly as the live executor reads them.
    const latestTask = (await getTask(task.id)) ?? task;
    if (hasTestingChain(group, latestTask, recoveredStage)) {
      const identity = (await isTaskCheckoutClean(latestTask, group, runGit))
        ? await readTaskGitContentIdentity(latestTask, group, runGit)
        : undefined;
      if (!identity) {
        await handleTestingBlocked(
          'The current worktree is dirty or its Git commit and content tree could not be resolved, so the passing evidence cannot be recorded.',
          context,
        );
      } else {
        await handleTestingDecision(decision, {
          ...context,
          testingHeadSha: identity.headSha,
          testingTreeSha: identity.treeSha,
        });
      }
    } else await handleTestingDecision(decision, context);
  } else if (decision) await handleTestingDecision(decision, context);
  else if (runFailed) {
    await handleTestingBlocked(
      'Testing agent exited with an error during restart recovery.',
      context,
    );
  } else {
    // A completed tester can be recovered after the process that normally
    // performs format repair has gone away. Persist a stage-addressed prompt
    // so the queue resumes the tester session with the format-only request
    // instead of rebuilding and redelivering the full validation assignment.
    if (result) {
      const raw = appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'assistant',
        content: result,
        agent_name: agentName ?? null,
        model_name: modelName ?? null,
        created_at: new Date().toISOString(),
      });
      if (raw)
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: raw,
          },
        });
    }
    const repairPrompt = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'stage_prompt',
      target_stage: recoveredStage,
      content: buildTestingFormatRepairPrompt(result ?? '', 1),
      created_at: new Date().toISOString(),
    });
    if (repairPrompt)
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: repairPrompt,
        },
      });
    const notice = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'system_notice',
      content:
        '**Recovered testing response did not match the required JSON schema.** Requesting a corrected verdict.',
      created_at: new Date().toISOString(),
    });
    if (notice)
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: notice,
        },
      });
    await updateTask(task.id, {
      status: recoveredStage,
      error: '',
      session_id: sessionId ?? task.session_id,
      last_agent_name: agentName ?? task.last_agent_name,
    });
    const updated = await getTask(task.id);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
    logger.warn(
      { task_id: task.id },
      'Recovery: invalid testing verdict; queueing schema format repair',
    );
  }
  clearTaskStreamBuffer(task.id);
  broadcast({
    type: 'task_output_clear',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      run_id: runId,
    },
  });
  return true;
}

/** Prefer the run's conversation_id — getLastChatConversationId is wrong for multi-conv projects. */
async function resolveWebChatConversationId(run: {
  conversation_id?: string | null;
  group_folder: string;
}): Promise<string | null> {
  if (run.conversation_id) return run.conversation_id;
  return getLastChatConversationId(run.group_folder);
}

/** Best-effort archive + chat_completed when an orphaned chat run cannot finish. */
/**
 * Raw events of the chat turn that is still open at the end of the transcript
 * (everything after the last user message), or null when the turn already
 * carries its own result, telemetry or outcome.
 */
function openChatTurnOutput(transcriptLines: string[]): string | null {
  let start = 0;
  for (let i = transcriptLines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(transcriptLines[i]);
      if (row.type === 'message' && row.role === 'user') {
        start = i + 1;
        break;
      }
    } catch {
      // skip malformed lines
    }
  }
  const turn = transcriptLines.slice(start);
  const settled = turn.some((line) => {
    try {
      const row = JSON.parse(line);
      return (
        row.type === 'result' ||
        row.type === 'telemetry' ||
        row.type === 'turn_outcome' ||
        (row.type === 'message' && row.role === 'assistant')
      );
    } catch {
      return false;
    }
  });
  return settled || turn.length === 0 ? null : turn.join('\n');
}

/** Metadata that keeps a recovered run's agent label on its transcript lines. */
function archiveAgentMetadata(
  run: { agent_name?: string | null } | null | undefined,
): { agent_name: string } | undefined {
  return run?.agent_name ? { agent_name: run.agent_name } : undefined;
}

async function finalizeFailedChatRecovery(
  run: ActiveRun,
  runHostDir: string,
  failureMessage: string,
  objectiveId?: string,
): Promise<void> {
  const convId = await resolveWebChatConversationId(run);
  const target = chatTranscriptPath(
    run.group_folder,
    run.session_id || undefined,
    run.conversation_id || undefined,
  );
  try {
    archiveRunV1Transcript(target, runHostDir, archiveAgentMetadata(run));
  } catch (err) {
    logger.warn(
      { err, runId: run.id, runHostDir, target },
      'Failed to archive output during failed chat recovery',
    );
  }
  if (convId) {
    // The turn never produced a result, so nothing wrote a terminal assistant
    // row: the conversation would keep showing "working" until the next boot
    // sweep, and the partial turn would have no telemetry footer. Persist the
    // failure with the usage of the events that did arrive.
    const partialTurn = openChatTurnOutput(readGroupTranscriptLines(target));
    if (partialTurn) {
      const parsed = readRecoveredRunResult(runHostDir, null);
      const output = buildOutput(
        { events: readRunV1EventsTail(runHostDir), isError: true },
        parsed,
        run.group_folder,
        Date.now() - new Date(run.started_at).getTime(),
      );
      const savedMsg = await saveChatMessage({
        group_folder: run.group_folder,
        role: 'assistant',
        content: failureMessage,
        sender_name: ASSISTANT_NAME,
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: convId,
        telemetry: recoveredRunTelemetry(run, output),
        failed: true,
        skipTranscript: false,
      });
      broadcast({
        type: 'chat_message',
        payload: { folder: run.group_folder, message: savedMsg },
      });
    }
    const streamKey = getActiveStreamKeyForConv(convId);
    const handoff = await releaseAndClaimDirectFollowups(
      run.group_folder,
      convId,
    );
    broadcast({
      type: 'chat_completed',
      payload: {
        ...chatEventScope(run.group_folder, objectiveId),
        conversation_id: convId,
        ...(streamKey ? { streamKey } : {}),
        releasedQueuedMessageIds: handoff.releasedMessageIds,
      },
    });
    await notifyRecoveredChatLifecycle(run, convId, 'failed');
    for (const next of handoff.claimed)
      scheduleClaimedDirectFollowup(next.runId);
  }
}

/**
 * Wall-clock deadline used by restart recovery for a run.
 *
 * Chat and scheduled-direct runs (no task_id) have no hard wall-clock deadline
 * on the live path. runContainerAgent encodes the
 * `task_id ? finite : Infinity` discriminator at three sites — the initial
 * run (`chatTimeoutMs`), the in-process adoption of an existing run
 * (`remainingMs`), and the retry (which reuses `chatTimeoutMs`). Such runs are
 * bounded by the idle stall watchdog and the dead-agent reaper instead. Honor
 * the same intent in recovery so a legitimately long run is not killed merely
 * for crossing MCP_AGENT_TIMEOUT across a restart. Task runs keep their
 * finite `timeout_at` deadline unchanged.
 */
function recoveryDeadlineMs(run: ActiveRun, timeoutAt: number): number {
  return run.task_id ? timeoutAt : Infinity;
}

async function retireOrphanedWebViewAgent(
  run: ActiveRun,
  hostDir: string | null,
): Promise<boolean> {
  const browserSessionId = !run.task_id
    ? webViewAgentSessionId(run.chat_jid)
    : undefined;
  if (!browserSessionId) return false;

  logger.info(
    { runId: run.id, group: run.group_folder, browserSessionId },
    'Retiring orphaned web_view browser agent after restart',
  );
  await killRun(run).catch((err) =>
    logger.warn(
      { runId: run.id, err },
      'Failed to kill orphaned web_view browser agent',
    ),
  );
  await completeActiveRun(run.id, 'error');

  try {
    const closed = await getSandboxClient().sandboxExec(
      run.sandbox_stack,
      run.sandbox_service,
      closeBrowserSessionCommand(browserSessionId),
      {
        env: {
          CARAPA_BROWSER_RUN_ID: run.id,
          PLAYWRIGHT_DAEMON_SESSION_DIR: `/tmp/pwcli-${browserSessionId}`,
          PLAYWRIGHT_DAEMON_SOCKETS_DIR: `/tmp/pwcli-${browserSessionId}/sockets`,
          PLAYWRIGHT_CLI_SESSION: browserSessionId,
        },
        instance: run.sandbox_instance ?? undefined,
        timeout: BROWSER_CLEANUP_TIMEOUT_SECONDS,
      },
    );
    if (closed.isError) {
      logger.warn(
        { runId: run.id, browserSessionId, output: closed.stdout },
        'Recovered web_view browser session cleanup failed',
      );
    }
  } catch (err) {
    logger.warn(
      { runId: run.id, browserSessionId, err },
      'Recovered web_view browser session cleanup failed',
    );
  }

  await webBrowserSessions.close(browserSessionId).catch(() => {
    logger.warn(
      { browserSessionId },
      'Recovered sidecar cleanup failed; expiry remains active',
    );
  });

  if (hostDir) {
    try {
      removeIpcDirSync(hostDir);
    } catch {
      /* best effort */
    }
  }
  return true;
}

type RecoverableRunArtifacts = Pick<
  ActiveRun,
  | 'id'
  | 'group_folder'
  | 'task_id'
  | 'chat_jid'
  | 'session_id'
  | 'conversation_id'
  | 'agent_name'
>;

function recoveredTranscriptTarget(
  run: RecoverableRunArtifacts,
  recoveredSessionId?: string | null,
): string | undefined {
  if (run.task_id) {
    return outputTranscriptPath(run.group_folder, run.task_id);
  }
  if (run.chat_jid.includes('@web')) {
    return chatTranscriptPath(
      run.group_folder,
      recoveredSessionId || run.session_id || undefined,
      run.conversation_id || undefined,
    );
  }
  return undefined;
}

/**
 * Commit every user-visible recovery artifact before an IPC directory can be
 * removed. The immutable run-history copy and aggregate transcript use
 * independent append-service checkpoints over the same spool, so either can
 * be retried after a crash without duplicating the other.
 */
function persistRecoveredRunArtifacts(
  run: RecoverableRunArtifacts,
  runDir: string,
  transcriptTarget = recoveredTranscriptTarget(run),
): boolean {
  const runHistoryPersisted = persistPerRunTranscript(
    run.group_folder,
    run.id,
    runDir,
  );
  // The V1 append is checkpointed, so a repeated recovery appends nothing twice.
  const aggregatePersisted = transcriptTarget
    ? archiveRunV1Transcript(
        transcriptTarget,
        runDir,
        archiveAgentMetadata(run),
      )
    : true;

  if (!runHistoryPersisted || !aggregatePersisted) {
    logger.warn(
      {
        runId: run.id,
        runDir,
        runHistoryPersisted,
        aggregatePersisted,
        hasTranscriptTarget: !!transcriptTarget,
      },
      'Preserving recovered IPC run directory after transcript persistence failure',
    );
  }
  return runHistoryPersisted && aggregatePersisted;
}

function recoveryFailure(error: unknown): {
  taskError: string;
  message: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|deadline exceeded/i.test(detail)) {
    return {
      taskError: 'Timed out during restart recovery',
      message: 'Error: Agent timed out during restart recovery.',
    };
  }
  if (/stalled/i.test(detail)) {
    return {
      taskError: 'Stalled during restart recovery',
      message: 'Error: Agent stalled during restart recovery.',
    };
  }
  if (/run directory|ENOENT/i.test(detail)) {
    return {
      taskError: 'Interrupted: run directory missing during recovery',
      message: 'Error: Interrupted — run directory missing during recovery.',
    };
  }
  return {
    taskError: 'Failed to recover run after restart',
    message: 'Error: Failed to recover run after restart.',
  };
}

/**
 * Reconcile task prompt acknowledgements before stale admissions are released.
 * Launch assignments are bounded by their still-durable task admission and
 * need no IPC directory; live steering acknowledgements are discovered from
 * their retained control response.
 */
async function reconcileTerminalTaskSteeringAcknowledgements(): Promise<void> {
  const reconciledTasks = new Set<string>();
  for (const run of await getCompletedTaskRunsForStaleAdmissions()) {
    if (reconciledTasks.has(run.task_id)) continue;
    try {
      const task = await getTask(run.task_id);
      if (!task) continue;
      await reconcileTaskSteeringReceipts(task);
      reconciledTasks.add(run.task_id);
    } catch (error) {
      // The run keeps its pending-finalization marker for the next boot.
      logger.error(
        { runId: run.id, task_id: run.task_id, err: error },
        'Failed to reconcile steering receipts of completed run; continuing recovery',
      );
    }
  }

  const ipcBase = ipcRoot();
  if (!fs.existsSync(ipcBase)) return;
  for (const ipcDir of fs.readdirSync(ipcBase)) {
    const runsDir = path.join(ipcBase, ipcDir, 'runs');
    if (!fs.existsSync(runsDir)) continue;
    for (const runId of fs.readdirSync(runsDir)) {
      if (!runId.startsWith('run-')) continue;
      const responsesDir = path.join(runsDir, runId, 'control-responses');
      let hasResponse = false;
      try {
        hasResponse = fs
          .readdirSync(responsesDir)
          .some((name) => name.endsWith('.json'));
      } catch {
        continue;
      }
      if (!hasResponse) continue;
      try {
        const run = await getActiveRunById(runId);
        if (
          !run?.task_id ||
          run.status === 'running' ||
          reconciledTasks.has(run.task_id)
        ) {
          continue;
        }
        const task = await getTask(run.task_id);
        if (!task) continue;
        await reconcileTaskSteeringReceipts(task);
        reconciledTasks.add(run.task_id);
      } catch (error) {
        logger.error(
          { runId, err: error },
          'Failed to reconcile steering receipts of terminal run; continuing recovery',
        );
      }
    }
  }
}

/**
 * Synchronous recovery at boot: check each stalled run's IPC directory.
 * - If the run already finished (has exit_code), harvest the output immediately.
 * - If the run directory still exists but has no exit_code and is within timeout,
 *   leave it as 'running' so recoverOrphanedRuns() can reconnect asynchronously.
 * - If the directory is gone or the run timed out, mark it as failed.
 */
export async function recoverStalledRuns(
  dependencies: TaskRecoveryDependencies = {},
): Promise<void> {
  const admissionSnapshot =
    dependencies.admissionSnapshot ?? (await snapshotTaskAdmissionOwners());
  // First, so that a failure in any later pass still leaves a retry key for
  // every completed admitted run before the sweeps release its admission.
  try {
    await recordPendingFinalizationRuns(admissionSnapshot);
  } catch (error) {
    logger.error(
      { err: error },
      'Failed to record pending task finalizations; continuing recovery',
    );
  }
  await recoverTerminalAutomaticStageEntryRuns();
  await reconcileTerminalTaskSteeringAcknowledgements();
  await finalizeCompletedAdmittedTaskRuns(dependencies, admissionSnapshot);
  await recoverStaleTaskAdmissions(admissionSnapshot);
  const stalledRuns = await getActiveRunsByStatus('running');
  if (!stalledRuns || stalledRuns.length === 0) {
    await recoverStaleTaskAdmissions(admissionSnapshot);
    return;
  }

  logger.info(
    { count: stalledRuns.length },
    'Checking stalled runs from previous session',
  );

  for (const run of stalledRuns) {
    const admissionOwners = admissionSnapshot.get(run.group_folder);
    // Continuations pass this token to the executor, which also releases the
    // admission. An uncaptured owner must not match a legacy tokenless record.
    const admissionOwnerToken =
      run.task_id && admissionOwners?.has(run.task_id)
        ? admissionOwners.get(run.task_id)
        : `uncaptured:${randomUUID()}`;
    if (run.stage?.startsWith('direct-followup:')) continue;
    if (run.task_id) {
      const latestTaskRun = await getLastActiveRunForTask(run.task_id);
      if (latestTaskRun && latestTaskRun.id !== run.id) {
        // A restart can land after the continuation row is inserted but before
        // its atomic handoff retires this predecessor. The newer row owns the
        // next recovery decision; this stale blocker must not fail the task or
        // launch another turn.
        await completeActiveRun(run.id, 'error');
        continue;
      }
    }
    let hostDir = resolveHostRunDir(run);
    if (await retireOrphanedWebViewAgent(run, hostDir)) continue;
    const now = Date.now();
    const timeout_at = new Date(run.timeout_at).getTime();
    const deadlineAt = recoveryDeadlineMs(run, timeout_at);
    const recoveryCanContinue = deadlineAt > now;

    // A task-owned warm turn can outlive the cold wrapper regardless of
    // whether the wrapper left its run directory behind. Rebuild only that
    // exact run's spool so the ordinary orphan watcher retains streaming,
    // Stop, transcript, and finalization behavior.
    const hasTerminalSpool =
      !!hostDir && fs.existsSync(path.join(hostDir, 'exit_code'));
    if (run.task_id) {
      const warm = findTaskWarmSession(run);
      const workerV1 = warm ? await workerRunV1State(run, warm) : 'none';
      if (
        workerV1 === 'live' ||
        (workerV1 === 'terminal' && !warm?.completed)
      ) {
        // The run's own worker owns its V1 pair; the ordinary orphan watcher
        // attaches to it unchanged. Rewriting it would corrupt it.
      } else if (warm?.completed) {
        hostDir = mirrorTaskWarmTurn(run, warm, workerV1 === 'terminal');
      } else if (warm) {
        const reconstructedWarm =
          !!hostDir &&
          fs.existsSync(path.join(hostDir, RESTART_WARM_RECOVERY_MARKER));
        const warmBackedSpool =
          reconstructedWarm ||
          (!!hostDir && fs.existsSync(path.join(hostDir, 'session_dir')));
        const coldState =
          hostDir && !hasTerminalSpool && !warmBackedSpool
            ? await taskProcessState(run, path.join(hostDir, 'pid'))
            : 'dead';
        const daemonState = await taskWarmDaemonState(run, warm.sessionDir);
        const warmTurnState = await taskWarmTurnState(run, warm.sessionDir);
        // The liveness probes are asynchronous, so refresh the protocol tail
        // before deciding that the turn is gone. A warm completion always
        // supersedes an interrupted wrapper outcome.
        const refreshedWarm = findTaskWarmSession(run) ?? warm;
        await refreshRecoveredWarmActivity(run, refreshedWarm);
        if (refreshedWarm.completed) {
          hostDir = mirrorTaskWarmTurn(run, refreshedWarm);
        } else if (warmTurnState === 'alive' && daemonState !== 'dead') {
          // The live per-turn wrapper lock proves this prompt still owns the
          // daemon. holder.pid is deliberately excluded: it keeps the FIFO
          // open for the daemon's entire lifetime, including while idle.
          hostDir = mirrorTaskWarmTurn(run, refreshedWarm);
          await monitorTaskWarmTurn(run, refreshedWarm);
        } else if (
          coldState === 'dead' &&
          (daemonState === 'unknown' ||
            warmTurnState === 'unknown' ||
            warmTurnMayStillSettle(refreshedWarm))
        ) {
          // An unreachable sandbox cannot prove that the task-owned warm turn
          // has stopped. Reconstruct its spool and keep probing; a later dead
          // result produces the interrupted marker consumed by orphan recovery.
          hostDir = mirrorTaskWarmTurn(run, refreshedWarm);
          await monitorTaskWarmTurn(run, refreshedWarm);
        } else if (
          coldState === 'dead' &&
          daemonState !== 'unknown' &&
          recoveryCanContinue
        ) {
          const scheduleResult = await scheduleRestartRecoveryContinuation(
            run,
            dependencies,
            admissionOwnerToken,
          );
          if (restartRecoveryHandled(scheduleResult)) {
            if (restartRecoveryScheduled(scheduleResult)) {
              const interruptedDir = mirrorTaskWarmTurn(run, refreshedWarm);
              if (persistRecoveredRunArtifacts(run, interruptedDir)) {
                await removeRunDirPreservingControlResponses(interruptedDir);
              }
            }
            continue;
          }
        }
      } else if (!hostDir) {
        const scheduleResult = recoveryCanContinue
          ? await scheduleRestartRecoveryContinuation(
              run,
              dependencies,
              admissionOwnerToken,
            )
          : 'ineligible';
        if (restartRecoveryHandled(scheduleResult)) {
          continue;
        }
      } else {
        const reconstructedWarm = fs.existsSync(
          path.join(hostDir, RESTART_WARM_RECOVERY_MARKER),
        );
        const processState = await taskProcessState(
          run,
          path.join(hostDir, 'pid'),
        );
        // The process can publish exit_code between the liveness probe and the
        // recovery claim. Terminal output always wins that race.
        if (
          (reconstructedWarm || processState === 'dead') &&
          recoveryCanContinue &&
          !fs.existsSync(path.join(hostDir, 'exit_code'))
        ) {
          const scheduleResult = await scheduleRestartRecoveryContinuation(
            run,
            dependencies,
            admissionOwnerToken,
          );
          if (restartRecoveryHandled(scheduleResult)) {
            if (
              restartRecoveryScheduled(scheduleResult) &&
              persistRecoveredRunArtifacts(run, hostDir)
            ) {
              await removeRunDirPreservingControlResponses(hostDir);
            }
            continue;
          }
        }
      }
    }

    // Case C: Run directory missing
    if (!hostDir) {
      logger.warn(
        { runId: run.id, group: run.group_folder, task_id: run.task_id },
        'Stalled run directory missing, marking as error',
      );
      await completeActiveRun(run.id, 'error');

      if (run.task_id) {
        if (
          await recoverAutomaticStageEntryRunOutcome(run, {
            failed: true,
            error: 'Interrupted: server restarted during execution',
          })
        ) {
          continue;
        }
        // Stop owns the task's parked status and visible message even if the
        // process died before its old active_runs row was retired.
        const task = await getTask(run.task_id);
        if (task?.error === 'Stopped by user') continue;
        // Check if the agent already moved the task to a done stage before the crash
        const group = getGroupByFolder(run.group_folder);
        const stages = getGroupStages(group);
        const currentStageDef = task
          ? findStage(stages, task.status)
          : undefined;
        const alreadyDone = currentStageDef?.type === 'done';
        let stageEntryEventId: string | undefined;
        if (alreadyDone) {
          stageEntryEventId = (
            await getCurrentStageEntryEvent(
              task!.id,
              task!.project_id,
              task!.status,
            )
          )?.id;
          logger.info(
            {
              runId: run.id,
              task_id: run.task_id,
              currentStatus: task!.status,
            },
            'Task already in done stage (agent moved it) — skipping status overwrite',
          );
        } else {
          const stalledAt = new Date().toISOString();
          const failedStage = getFailedStage(stages);
          stageEntryEventId = (
            await updateTask(run.task_id, {
              status: failedStage?.id ?? 'failed',
              error: 'Interrupted: server restarted during execution',
              completed_at: stalledAt,
            })
          )?.id;
          if (task) {
            await appendTaskMessage(task.project_id, {
              task_id: run.task_id,
              role: 'assistant',
              content:
                'Error: Interrupted — server restarted during execution.',
              created_at: stalledAt,
            });
          }
        }
        await notifyRecoveredTaskLifecycle(
          run,
          alreadyDone ? 'completed' : 'failed',
          stageEntryEventId,
        );
      } else if (run.isScheduledTask && run.scheduled_task_id) {
        // Scheduled tasks created from the web UI also use an @web JID. Handle
        // them before generic web chat recovery so a missing run directory
        // does not inject a spurious "response was lost" message into chat.
        const recoveryError = 'Interrupted: server restarted during execution';
        const scheduledTask = await getTaskById(run.scheduled_task_id);
        try {
          await logTaskRun({
            task_id: run.scheduled_task_id,
            run_id: run.id,
            run_at: run.started_at,
            duration_ms: now - new Date(run.started_at).getTime(),
            status: 'error',
            result: null,
            error: recoveryError,
          });
        } catch (err) {
          logger.error(
            { task_id: run.scheduled_task_id, error: String(err) },
            'Failed to persist recovered scheduled task run log',
          );
        }
        if (scheduledTask) {
          await updateScheduledTaskAfterRun(
            run.scheduled_task_id,
            calcNextRun(scheduledTask),
            `Error: ${recoveryError}`,
            scheduledTask,
          );
        }
      } else if (run.chat_jid.includes('@web')) {
        // Web chat run — save error message so user sees it
        const conversation_id = await resolveWebChatConversationId(run);
        await saveChatMessage({
          group_folder: run.group_folder,
          role: 'assistant',
          content:
            '⚠️ Agent response was lost during a restart. Please resend your message.',
          sender_name: ASSISTANT_NAME,
          source: 'web',
          created_at: new Date().toISOString(),
          conversation_id: conversation_id,
          failed: true,
        });
        const releasedQueuedMessageIds = conversation_id
          ? await releaseUnconsumedQueuedChatMessages(
              run.group_folder,
              conversation_id,
            )
          : [];
        broadcast({
          type: 'chat_completed',
          payload: {
            folder: run.group_folder,
            conversation_id,
            failed: true,
            releasedQueuedMessageIds,
          },
        });
        await notifyRecoveredChatLifecycle(run, conversation_id, 'failed');
      }
      continue;
    }

    const exitCodePath = path.join(hostDir, 'exit_code');

    // Case A: Run already finished (exit_code file exists)
    if (fs.existsSync(exitCodePath)) {
      let exitCode = 1;
      try {
        exitCode = parseInt(fs.readFileSync(exitCodePath, 'utf-8').trim(), 10);
      } catch (err) {
        logger.warn(
          { runId: run.id, err: String(err) },
          'Failed to read exit_code, defaulting to error',
        );
      }
      const runMetrics = readRunMetrics(hostDir);
      const parsed = readRecoveredRunResult(hostDir, runMetrics);
      // Read after the result: completing a non-terminal pair appends its
      // interrupted terminal event.
      const rawEvents = readRunV1EventsTail(hostDir);
      let rawStderr = '';
      try {
        rawStderr = fs.readFileSync(
          path.join(hostDir, 'agent-stderr.log'),
          'utf-8',
        );
      } catch {
        // stderr is optional
      }
      const recoveredOutput = buildOutput(
        {
          events: rawEvents,
          stderr: rawStderr,
          isError: exitCode !== 0,
        },
        parsed,
        run.group_folder,
        runMetrics?.durationMs ?? undefined,
      );
      let isError = recoveredOutput.status === 'error';
      const status = isError ? ('error' as const) : ('completed' as const);
      const recoveredTask = run.task_id
        ? await getTask(run.task_id)
        : undefined;
      const recoveredGroup = getGroupByFolder(run.group_folder);
      let successfulTaskBoundary: RecoveredSuccessfulTaskBoundary | undefined;
      if (!isError && run.task_id) {
        await beginRecoveredSuccessfulTaskFinalization(
          run,
          parsed.result,
          parsed.session_id,
          (value) => {
            successfulTaskBoundary = value;
          },
          () =>
            broadcast({
              type: 'run_finished',
              payload: {
                project_id: recoveredTask?.project_id ?? run.group_folder,
                task_id: run.task_id!,
                run_id: run.id,
              },
            }),
        );
      }
      let steeringHeld =
        successfulTaskBoundary?.boundary.shouldAdvance === false;
      let recoveredRunFinalized = false;
      let recoveryFinalizationSuccessful = false;
      let checkpointParked = false;
      try {
        const needsTaskCheckoutCheckpoint = Boolean(
          recoveredTask &&
          recoveredGroup &&
          !recoveredTask.worktree_path &&
          (recoveredTask.branch_name ||
            recoveredGroup.settings?.repositoryLocation ||
            recoveredGroup.settings?.repositoryUrl ||
            recoveredGroup.settings?.repositoryRelativePath),
        );
        const recoveryLease = needsTaskCheckoutCheckpoint
          ? await acquireSharedCheckoutLease(
              run.group_folder,
              { type: 'task', id: run.task_id! },
              { reattachActiveOwner: true },
            )
          : undefined;
        try {
          if (needsTaskCheckoutCheckpoint) {
            await (
              dependencies.runPostExecutionGitOps ?? runPostExecutionGitOps
            )(recoveredTask!, recoveredGroup!, getGroupStages(recoveredGroup!));
          }
          await completeActiveRun(run.id, status, parsed, parsed.session_id);
        } catch (error) {
          isError = true;
          if (recoveredTask && recoveredGroup) {
            // Same parking as the live executor; nothing later in recovery may
            // route this task to the failed stage or rewrite its outcome.
            checkpointParked = true;
            await parkTaskAfterGitCheckpointFailure(
              recoveredTask,
              getGroupStages(recoveredGroup),
              error,
            );
            await updateTask(recoveredTask.id, {
              error: `Recovery checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          await completeActiveRun(run.id, 'error', parsed, parsed.session_id);
          logger.warn(
            { run_id: run.id, task_id: run.task_id, error: String(error) },
            'Recovered shared checkout run parked after Git checkpoint failure',
          );
        } finally {
          await recoveryLease?.release();
        }
        recoveredRunFinalized = true;
        logger.info(
          {
            runId: run.id,
            group: run.group_folder,
            exitCode,
            hasResult: !!parsed.result,
          },
          'Recovered finished stalled run',
        );
        // A parked checkpoint failure owns the task outcome: skip entry-outcome
        // recovery and the status/error/output writes of the task branch below.
        const entryOutcomeRecovered = checkpointParked
          ? true
          : run.task_id
            ? await recoverAutomaticStageEntryRunOutcome(run, {
                failed: isError,
                error: isError
                  ? 'Agent exited with error during restart recovery'
                  : undefined,
                output: parsed.result,
                sessionId: parsed.session_id,
              })
            : false;

        // Update session only for chat runs — task sessions belong to the task record,
        // not the group-level sessions map. Leaking a task session here would cause the
        // next chat conversation to resume in the wrong (task) session context.
        if (parsed.session_id && !run.task_id) {
          if (run.conversation_id) {
            // Web-chat run: persist session per (conversation, agent).
            await setConversationSessionId(
              run.conversation_id,
              run.session_agent_key || run.agent_name || AGENT_CMD,
              parsed.session_id,
            );
          } else {
            // WhatsApp/legacy: update the per-group session store.
            sessions[run.group_folder] = parsed.session_id;
            saveSessions();
          }
        }

        if (run.task_id && !entryOutcomeRecovered) {
          // Task run recovery — check if the agent already moved to a done stage
          const task = await getTask(run.task_id);
          const group = getGroupByFolder(run.group_folder);
          const stages = getGroupStages(group);
          const currentStageDef = task
            ? findStage(stages, task.status)
            : undefined;
          const alreadyDone = currentStageDef?.type === 'done';
          let stageEntryEventId =
            alreadyDone && task
              ? (
                  await getCurrentStageEntryEvent(
                    task.id,
                    task.project_id,
                    task.status,
                  )
                )?.id
              : undefined;
          const recoveredHandoff =
            !steeringHeld && !isError && task
              ? await getPendingTaskStageHandoff(task, run.stage || task.status)
              : undefined;
          const stageEntryEventRef: StageEntryEventRef = {};
          // A verdict that lands on the deploy stage hands the build to the
          // boot's non-blocking dispatch step through the marker.
          const testingOptions: RecoveredVerdictOptions = {
            deferDeploy: true,
            transitionValues: (stage) =>
              group ? deployDispatchValues(group, stages, stage) : {},
          };
          // An approved Review writes the marker in its own approval transition.
          const reviewOptions: RecoveredVerdictOptions = { deferDeploy: true };
          const testingRecovered =
            !steeringHeld && !recoveredHandoff && !alreadyDone && task && group
              ? await recoverTestingRun(
                  task,
                  group,
                  stages,
                  parsed.result,
                  parsed.session_id,
                  run.agent_name,
                  parsed.model_name,
                  isError,
                  run.stage,
                  run.id,
                  stageEntryEventRef,
                  undefined,
                  testingOptions,
                )
              : false;
          const reviewRecovered =
            !steeringHeld &&
            !recoveredHandoff &&
            !alreadyDone &&
            !testingRecovered &&
            !isError &&
            task &&
            group
              ? await recoverReviewRun(
                  task,
                  group,
                  stages,
                  parsed.result,
                  parsed.session_id,
                  run.sandbox_instance,
                  run.agent_name,
                  parsed.model_name,
                  run.stage,
                  run.id,
                  stageEntryEventRef,
                  reviewOptions,
                )
              : false;
          const retryError = [
            parsed.result,
            rawStderr,
            runV1ErrorText(rawEvents),
          ]
            .filter((value): value is string => !!value)
            .join('\n');
          const failedChainRecovered =
            !steeringHeld &&
            !recoveredHandoff &&
            !alreadyDone &&
            !testingRecovered &&
            isError &&
            task &&
            group
              ? await recoverFailedReviewChainRun(
                  task,
                  group,
                  stages,
                  retryError,
                  parsed.session_id,
                  run.sandbox_instance,
                  run.agent_name,
                  parsed.model_name,
                  run.stage,
                  run.id,
                  stageEntryEventRef,
                  reviewOptions,
                )
              : false;
          const lifecycleRecovered =
            testingRecovered || reviewRecovered || failedChainRecovered;

          const recoveredAt = new Date().toISOString();
          const taskUpdate: Record<string, unknown> = {
            completed_at: recoveredAt,
            session_id: parsed.session_id,
          };
          // Propagate sandbox_instance from the active_run so follow-up git ops target the right container
          if (run.sandbox_instance) {
            taskUpdate.sandbox_instance = run.sandbox_instance;
          }
          if (parsed.result) {
            taskUpdate.output = parsed.result;
          }
          const retryableTaskError =
            isError && !!task && isRetryableTaskError(retryError);

          if (steeringHeld) {
            // Result/session/run attribution was persisted before the shared
            // boundary. Leave the card in active_runs.stage for one continuation.
          } else if (alreadyDone) {
            // Agent already moved this to a done stage — don't overwrite status
            logger.info(
              {
                runId: run.id,
                task_id: run.task_id,
                currentStatus: task!.status,
                exitCode,
              },
              'Task already in done stage (agent moved it) — preserving status',
            );
          } else if (lifecycleRecovered) {
            // Structured testing/review recovery owns the transition.
          } else if (recoveredHandoff) {
            taskUpdate.status = recoveredHandoff.toStage;
          } else if (retryableTaskError) {
            // Preserve the executable stage and reserve its slot just as the
            // live executor does for provider capacity/rate-limit failures.
            delete taskUpdate.completed_at;
            taskUpdate.error = `Retry scheduled: ${formatTransientTaskError(retryError)}`;
            taskUpdate.output = '';
          } else if (isError) {
            taskUpdate.error = 'Agent exited with error during restart';
            taskUpdate.status = getFailedStage(stages)?.id ?? 'failed';
          } else {
            // Agent completed successfully — advance to the next active/review
            // stage in the pipeline (e.g. `review`), not straight to `done`.
            // `recoverStalledRuns` runs at boot when the in-process completion
            // handler was killed mid-flight, so the normal `executeTask` success
            // path that calls `getNextActiveStage` never got a chance to run.
            // Skipping straight to the done stage would silently bypass any
            // `review` stage configured between the agent's stage and completion.
            // Falls back to the done stage only when there is no next active/
            // review stage (true last active stage in the pipeline).
            const nextActiveStage = getNextActiveStage(
              stages,
              run.stage || task?.status || 'in_progress',
              task?.skip_stages ?? undefined,
            );
            const completionStageId =
              nextActiveStage?.id ?? getDoneStage(stages)?.id ?? 'completed';
            taskUpdate.status = completionStageId;
            logger.info(
              {
                runId: run.id,
                task_id: run.task_id,
                fromStage: run.stage || task?.status,
                toStage: completionStageId,
                hasResult: !!parsed.result,
              },
              'Recovery: agent completed successfully, advancing task to next stage',
            );
          }
          // Merge only when recovery actually completed the whole pipeline.
          // A successful implementation run may merely advance to testing/review;
          // merging there removes its worktree underneath the newly-started stage.
          const recoveryReachedDone = recoveryReachedDoneStage(
            stages,
            taskUpdate.status,
          );
          let recoveryGitReady = true;
          if (
            !alreadyDone &&
            !steeringHeld &&
            !lifecycleRecovered &&
            !isError &&
            recoveryReachedDone &&
            task &&
            group
          ) {
            const freshTask = await getTask(run.task_id);
            if (freshTask) {
              recoveryGitReady = await mergeBranchForDeploy(
                freshTask,
                group,
                'recovery',
              );
            } else {
              recoveryGitReady = false;
            }
          }
          if (!steeringHeld && !lifecycleRecovered && recoveryGitReady) {
            const willDispatchDeploy =
              !alreadyDone &&
              !isError &&
              recoveryReachedDone &&
              !!task &&
              !!group?.settings?.deployService &&
              taskUpdate.status === getDeployStageId(group.settings, stages);
            if (willDispatchDeploy) {
              taskUpdate.custom_values = {
                [DEPLOY_PENDING_DISPATCH_KEY]:
                  recoveredDeployDispatchValue(recoveredAt),
              };
            }
            const entryEvent = await updateTask(
              run.task_id,
              taskUpdate,
              willDispatchDeploy ? { mergeCustomValues: true } : undefined,
            );
            if (entryEvent) stageEntryEventId = entryEvent.id;
            if (task && recoveredHandoff) {
              await finalizeTaskStageHandoff(
                task,
                recoveredHandoff,
                run.id,
                stageEntryEventId,
              );
            }
          }
          if (retryableTaskError && group) {
            scheduleTransientTaskRetry(run.task_id, task.project_id, group);
          }

          if (task && !steeringHeld && !alreadyDone && !lifecycleRecovered) {
            const content = retryableTaskError
              ? `⏳ ${formatTransientTaskError(retryError)}\nWill retry automatically in 2 minutes.`
              : parsed.result ||
                (isError
                  ? 'Error: Agent exited with error during restart.'
                  : 'Run recovered after restart (completed successfully).');
            const msg = await appendTaskMessage(task.project_id, {
              task_id: run.task_id,
              role: 'assistant',
              content,
              entry_type: 'run_result',
              run_id: run.id,
              created_at: recoveredAt,
            });
            broadcast({
              type: 'task_message',
              payload: {
                task_id: run.task_id,
                project_id: task.project_id,
                message: msg,
              },
            });
          }

          // Move output to transcripts
          const target = outputTranscriptPath(run.group_folder, run.task_id);
          archiveRunV1Transcript(target, hostDir, archiveAgentMetadata(run));
          if (!steeringHeld && !lifecycleRecovered && !retryableTaskError) {
            const finalTask = await getTask(run.task_id);
            const finalStage = finalTask
              ? findStage(stages, finalTask.status)
              : undefined;
            if (
              !alreadyDone &&
              !isError &&
              recoveryReachedDone &&
              recoveryGitReady &&
              finalTask &&
              group?.settings?.deployService &&
              finalTask.status === getDeployStageId(group.settings, stages)
            ) {
              // Not awaited: `deploy_pending_dispatch` (written with the move)
              // hands the build to the boot's non-blocking dispatch step.
              logger.info(
                { runId: run.id, task_id: run.task_id },
                'Recovered run reached the deploy stage; deploy left to the pending-dispatch step',
              );
            } else if (finalStage?.type === 'done') {
              await notifyRecoveredTaskLifecycle(
                run,
                'completed',
                stageEntryEventId,
              );
            } else if (isError) {
              await notifyRecoveredTaskLifecycle(
                run,
                'failed',
                stageEntryEventId,
              );
            }
          }
        } else if (run.isScheduledTask && run.scheduled_task_id) {
          // Scheduled task recovery
          persistPerRunTranscript(run.group_folder, run.id, hostDir);
          const outcome = getRecoveredScheduledRunOutcome(
            parsed.result,
            isError,
          );
          const task = await getTaskById(run.scheduled_task_id);
          try {
            await logTaskRun({
              task_id: run.scheduled_task_id,
              run_id: run.id,
              run_at: run.started_at,
              duration_ms: now - new Date(run.started_at).getTime(),
              status: outcome.status,
              result: parsed.result,
              error: outcome.error,
            });
          } catch (err) {
            // Match live scheduler behavior: a history write is best-effort and
            // must not leave the occurrence due for duplicate execution.
            logger.error(
              { task_id: run.scheduled_task_id, error: String(err) },
              'Failed to persist recovered scheduled task run log',
            );
          }
          if (task) {
            await updateScheduledTaskAfterRun(
              run.scheduled_task_id,
              calcNextRun(task),
              outcome.resultSummary,
              task,
            );
          }
        } else if (run.chat_jid.includes('@web')) {
          // Web chat run recovery
          const conversation_id = await resolveWebChatConversationId(run);
          const content =
            parsed.result || '⚠️ Agent response was lost during a restart.';

          // Archive the native event stream before announcing completion. The
          // transcript endpoint refetches immediately on chat_completed, so
          // broadcasting first exposed a temporary flat fallback and then a
          // different native replay. Keep this save as aggregate metadata only;
          // writing its full prose into JSONL as well would duplicate the same
          // recovered turn once the V1 pair is archived below.
          const target = chatTranscriptPath(
            run.group_folder,
            parsed.session_id || run.session_id || undefined,
            run.conversation_id || undefined,
          );
          archiveRunV1Transcript(target, hostDir, archiveAgentMetadata(run));
          const savedMsg = await saveChatMessage({
            group_folder: run.group_folder,
            role: 'assistant',
            content,
            sender_name: ASSISTANT_NAME,
            source: 'web',
            created_at: new Date().toISOString(),
            conversation_id: conversation_id,
            telemetry: recoveredRunTelemetry(run, recoveredOutput),
            failed: isError,
            skipTranscript: true,
          });
          broadcast({
            type: 'chat_message',
            payload: { folder: run.group_folder, message: savedMsg },
          });
          await notifyRecoveredChatLifecycle(
            run,
            conversation_id,
            isError ? 'failed' : 'completed',
            parsed.result,
          );
          const releasedQueuedMessageIds = conversation_id
            ? await releaseUnconsumedQueuedChatMessages(
                run.group_folder,
                conversation_id,
              )
            : [];
          broadcast({
            type: 'chat_completed',
            payload: {
              folder: run.group_folder,
              conversation_id,
              failed: isError,
              releasedQueuedMessageIds,
            },
          });

          // Warm-daemon fallback: recover any turns that completed in the
          // session directory after the run dir's output was captured.
        }

        // Clean up run directory
        try {
          if (
            persistRecoveredRunArtifacts(
              run,
              hostDir,
              recoveredTranscriptTarget(run, parsed.session_id),
            )
          ) {
            await removeRunDirPreservingControlResponses(hostDir);
          }
        } catch (err) {
          logger.warn(
            { runId: run.id, hostDir, err: String(err) },
            'Failed to clean up recovered run directory',
          );
        }
        recoveryFinalizationSuccessful = !isError;
      } finally {
        if (successfulTaskBoundary) {
          const successfulBoundary = successfulTaskBoundary;
          // A DB error here must not skip the boundary release and cleanup
          // below, nor abort recovery of the remaining stalled runs.
          const finalTask = run.task_id
            ? await getTask(run.task_id).catch((error) => {
                logger.error(
                  { run_id: run.id, error: String(error) },
                  'Failed to read recovered task before closing steering window',
                );
                return undefined;
              })
            : undefined;
          if (finalTask) {
            steeringHeld =
              (await closeTaskSteeringAdmissionWindow(
                finalTask,
                successfulBoundary.boundary.startingStage,
                recoveryFinalizationSuccessful,
                successfulBoundary.boundary.release,
              ).catch(async (error) => {
                logger.error(
                  { run_id: run.id, error: String(error) },
                  'Failed to close terminal recovered task steering window',
                );
                if (recoveryFinalizationSuccessful) {
                  await updateTask(finalTask.id, {
                    status: successfulBoundary.boundary.startingStage,
                    completed_at: null,
                  }).catch(() => undefined);
                }
                return true;
              })) || steeringHeld;
          } else {
            successfulBoundary.boundary.release();
          }
          endSuccessfulTaskFinalization(successfulBoundary.boundary);
          if (
            steeringHeld &&
            recoveryFinalizationSuccessful &&
            recoveredRunFinalized &&
            successfulBoundary.group &&
            run.task_id
          ) {
            if (admissionSnapshot.get(run.group_folder)?.has(run.task_id)) {
              await releaseTaskAdmission(
                run.group_folder,
                run.task_id,
                admissionOwnerToken,
              ).catch((error) =>
                logger.warn(
                  { error: String(error), run_id: run.id },
                  'Failed to release terminal recovered run admission',
                ),
              );
            }
            await (dependencies.drainProjectQueue ?? drainProjectQueue)(
              run.group_folder,
              successfulBoundary.group,
            ).catch((error) =>
              logger.warn(
                { error: String(error), run_id: run.id },
                'Failed to drain held terminal recovered task',
              ),
            );
          }
        }
      }
      continue;
    }

    // Case B: Run directory exists but no exit_code yet.
    // Since agents run in separate containers, the agent may still be running.
    // If still within timeout, leave as 'running' so recoverOrphanedRuns() can
    // reconnect and wait for the agent to finish.
    if (deadlineAt > now) {
      logger.info(
        {
          runId: run.id,
          group: run.group_folder,
          task_id: run.task_id,
          remainingMs: deadlineAt - now,
        },
        'Stalled run has no exit_code but still within timeout — deferring to async recovery',
      );
      continue;
    }

    // Timed out — mark as error (but respect agent's own status changes)
    logger.warn(
      { runId: run.id, group: run.group_folder, task_id: run.task_id },
      'Stalled run has no exit_code and timed out, marking as error',
    );

    const partialParsed = readRecoveredRunResult(hostDir, null);

    if (run.isScheduledTask && run.scheduled_task_id) {
      await finalizeTerminalScheduledRecovery(
        run,
        hostDir,
        'timeout',
        partialParsed.result || null,
        'Timed out: agent did not finish before deadline',
      );
      continue;
    }

    await completeActiveRun(run.id, 'error');
    const entryTimeoutRecovered = run.task_id
      ? await recoverAutomaticStageEntryRunOutcome(run, {
          failed: true,
          error: 'Timed out: agent did not finish before deadline',
          output: partialParsed.result,
          sessionId: partialParsed.session_id,
        })
      : false;

    if (run.task_id && !entryTimeoutRecovered) {
      const errorAt = new Date().toISOString();
      // Check if the agent already moved the task to a done stage before the crash
      const task = await getTask(run.task_id);
      const group = getGroupByFolder(run.group_folder);
      const stages = getGroupStages(group);
      const currentStageDef = task ? findStage(stages, task.status) : undefined;
      const alreadyDone = currentStageDef?.type === 'done';
      let stageEntryEventId: string | undefined;

      if (alreadyDone) {
        stageEntryEventId = (
          await getCurrentStageEntryEvent(
            task!.id,
            task!.project_id,
            task!.status,
          )
        )?.id;
        logger.info(
          { runId: run.id, task_id: run.task_id, currentStatus: task!.status },
          'Task already in done stage (agent moved it) — skipping status overwrite',
        );
      } else {
        stageEntryEventId = (
          await updateTask(run.task_id, {
            status: getFailedStage(stages)?.id ?? 'failed',
            error: 'Timed out: agent did not finish before deadline',
            completed_at: errorAt,
          })
        )?.id;
        if (task) {
          await appendTaskMessage(task.project_id, {
            task_id: run.task_id,
            role: 'assistant',
            content: 'Error: Agent timed out — did not finish before deadline.',
            created_at: errorAt,
          });
        }
      }
      const target = outputTranscriptPath(run.group_folder, run.task_id);
      archiveRunV1Transcript(target, hostDir, archiveAgentMetadata(run));
      await notifyRecoveredTaskLifecycle(
        run,
        alreadyDone ? 'completed' : 'failed',
        stageEntryEventId,
      );
    }
    if (run.task_id && entryTimeoutRecovered) {
      const target = outputTranscriptPath(run.group_folder, run.task_id);
      archiveRunV1Transcript(target, hostDir, archiveAgentMetadata(run));
    }

    try {
      if (
        persistRecoveredRunArtifacts(
          run,
          hostDir,
          recoveredTranscriptTarget(run, partialParsed.session_id),
        )
      ) {
        await removeRunDirPreservingControlResponses(hostDir);
      }
    } catch (err) {
      logger.warn(
        { runId: run.id, hostDir, err: String(err) },
        'Failed to clean up timed-out run directory',
      );
    }
  }
  await recoverStaleTaskAdmissions(admissionSnapshot);
}

/**
 * Registered groups whose sandbox IPC directory is `ipcDirName`. Run
 * directories are agent-writable, so only these groups may be named by a
 * run's args.json or inferred from the directory name.
 */
function groupFoldersOwningIpcDir(ipcDirName: string): string[] {
  const owners: string[] = [];
  for (const group of Object.values(registeredGroups)) {
    try {
      const sandbox = resolveEffectiveSandbox(group);
      if (
        path.basename(
          hostIpcDir(group.folder, sandbox.instance, sandbox.stack),
        ) === ipcDirName
      ) {
        owners.push(group.folder);
      }
    } catch {
      // A group whose sandbox cannot be resolved owns no IPC directory.
    }
  }
  return owners;
}

/** The untrusted args.json groupFolder (truncated) for rejection logging. */
function readRejectedArgsGroupFolder(runPath: string): string | undefined {
  try {
    const args = JSON.parse(
      fs.readFileSync(path.join(runPath, 'args.json'), 'utf-8'),
    ) as Record<string, unknown>;
    return typeof args.groupFolder === 'string'
      ? args.groupFolder.slice(0, 80)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sweep orphaned IPC run directories left on disk.
 * These are run directories where the DB row is already completed/error/missing
 * but the directory was never cleaned up (e.g., process crashed mid-cleanup).
 * For each: archive the run's V1 pair to the appropriate transcript, then delete the dir.
 */
export async function sweepOrphanedIpcDirs(): Promise<void> {
  const ipcBase = ipcRoot();
  if (!fs.existsSync(ipcBase)) return;

  let swept = 0;
  for (const ipcDir of fs.readdirSync(ipcBase)) {
    const runsDir = path.join(ipcBase, ipcDir, 'runs');
    try {
      if (!fs.statSync(runsDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const allowedGroupFolders = groupFoldersOwningIpcDir(ipcDir);

    for (const runId of fs.readdirSync(runsDir)) {
      if (!runId.startsWith('run-')) continue;
      const runPath = path.join(runsDir, runId);

      // Skip if the run is still active in the DB
      const dbRun = await getActiveRunById(runId);
      if (dbRun && dbRun.status === 'running') continue;

      // The V1 append is checkpointed, so a dir whose pair was already
      // archived (only the final deletion was missed) appends nothing twice.
      const hasOutput = hasRunV1Files(runPath);
      const orphanMetadata = !dbRun
        ? resolveOrphanedRunMetadata(runPath, ipcDir, allowedGroupFolders)
        : undefined;

      // Scheduled cleanup deliberately retains the entire IPC directory when
      // its immutable per-run copy fails. Retry that exact copy before generic
      // task/chat archival so prompt.txt is not discarded on the next boot.
      if (dbRun?.isScheduledTask) {
        const preserved = persistPerRunTranscript(
          dbRun.group_folder,
          runId,
          runPath,
        );
        if (!preserved) {
          logger.warn(
            { runId, runPath },
            'Preserving scheduled IPC run directory because transcript retry failed',
          );
          continue;
        }
        try {
          removeIpcDirSync(runPath);
          swept++;
        } catch (err) {
          logger.warn(
            { runPath, err: String(err) },
            'Failed to sweep preserved scheduled IPC run directory',
          );
        }
        continue;
      }

      // Determine transcript target from DB row or args.json
      let transcriptTarget: string | undefined;
      if (dbRun && hasOutput) {
        if (dbRun.task_id) {
          transcriptTarget = outputTranscriptPath(
            dbRun.group_folder,
            dbRun.task_id,
          );
        } else {
          transcriptTarget = chatTranscriptPath(
            dbRun.group_folder,
            dbRun.session_id || undefined,
            dbRun.conversation_id || undefined,
          );
        }
      } else if (hasOutput) {
        // No DB row — recover the launch identity from args.json so task and
        // conversation output does not get collapsed into chat-undefined.
        if (orphanMetadata?.groupFolder) {
          transcriptTarget = orphanMetadata.taskId
            ? outputTranscriptPath(
                orphanMetadata.groupFolder,
                orphanMetadata.taskId,
              )
            : chatTranscriptPath(
                orphanMetadata.groupFolder,
                orphanMetadata.sessionId,
                orphanMetadata.conversationId,
              );
        }
      }

      // Move output to the transcript before deleting the run directory.
      // - No output at all: the run died before the agent wrote anything —
      //   nothing exists to archive (warm session output is recovered
      //   separately from sessions/), so the dir is safe to delete.
      // - Output present but not archivable (unresolved identity or a failed
      //   append): this dir is the only remaining copy — preserve it.
      let archived = false;
      if (hasOutput && transcriptTarget) {
        archived = archiveRunV1Transcript(
          transcriptTarget,
          runPath,
          archiveAgentMetadata(dbRun),
        );
      }
      if (hasOutput && !archived) {
        logger.warn(
          {
            runId,
            runPath,
            hasTranscriptTarget: !!transcriptTarget,
            ...(!dbRun && !orphanMetadata?.groupFolder
              ? { rejectedGroupFolder: readRejectedArgsGroupFolder(runPath) }
              : {}),
          },
          'Preserving orphaned IPC run directory because output was not archived',
        );
        continue;
      }

      const groupFolder = dbRun?.group_folder ?? orphanMetadata?.groupFolder;
      if (groupFolder) {
        const runHistoryPersisted = persistPerRunTranscript(
          groupFolder,
          runId,
          runPath,
        );
        if (!runHistoryPersisted) {
          logger.warn(
            { runId, runPath, groupFolder },
            'Preserving orphaned IPC run directory because run history was not persisted',
          );
          continue;
        }
      } else if (hasOutput || fs.existsSync(path.join(runPath, 'prompt.txt'))) {
        logger.warn(
          {
            runId,
            runPath,
            rejectedGroupFolder: readRejectedArgsGroupFolder(runPath),
          },
          'Preserving orphaned IPC run directory because its group could not be resolved',
        );
        continue;
      }

      // Delete the run directory unless a retained generic-control response
      // is still the only durable evidence of an accepted task steer. The
      // task completion boundary will reconcile that response into a receipt
      // and clear it before this directory becomes removable.
      try {
        if (await removeRunDirPreservingControlResponses(runPath)) swept++;
      } catch (err) {
        logger.warn(
          { runPath, err: String(err) },
          'Failed to sweep orphaned IPC run directory',
        );
      }
    }
  }

  if (swept > 0) {
    logger.info({ count: swept }, 'Swept orphaned IPC run directories');
  }
}

/**
 * Fix conversations stuck in "working" status.
 * A conversation shows "working" when the last message is from a user but there's
 * no active chat run processing it. This can happen when a run was interrupted
 * without saving an assistant error message (e.g., old recovery code, crashes).
 */
export async function sweepStuckConversations(): Promise<void> {
  const stuck = await getStuckWorkingConversations();
  if (!stuck || stuck.length === 0) return;

  // A conversation with a still-pending form payload isn't actually
  // restart-interrupted — the agent was waiting for the user's response
  // when the process died. The user can still submit; routeFormResponse
  // will resume the flow. Marking it as "interrupted" would be a lie that
  // also confuses the user when they later answer the form.
  const pendingFormConvIds = await getConversationIdsWithPendingForms().catch(
    () => new Set<string>(),
  );
  const trulyStuck = stuck.filter((c) => !pendingFormConvIds.has(c.id));
  if (trulyStuck.length === 0) {
    logger.info(
      { skipped: stuck.length },
      'sweepStuckConversations: all stuck convs are waiting on a form; nothing to mark',
    );
    return;
  }

  for (const conv of trulyStuck) {
    const message = await saveChatMessage({
      group_folder: conv.group_folder,
      role: 'assistant',
      content: STUCK_RESTART_MARKER,
      sender_name: ASSISTANT_NAME,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conv.id,
      failed: true,
      // The JSONL transcript is the canonical chat store. Persist the visible
      // failure message so a genuinely abandoned turn does not remain an
      // unexplained "Thinking" bubble. Deferred form handling can remove this
      // exact marker through clearStuckRestartMarker().
      skipTranscript: false,
    });
    broadcast({
      type: 'chat_message',
      payload: { folder: conv.group_folder, message },
    });
    broadcast({
      type: 'chat_completed',
      payload: {
        folder: conv.group_folder,
        conversation_id: conv.id,
        failed: true,
        pending: false,
      },
    });
    // An ask to this conversation has no run record to recover; settle it here.
    await settleAgentAsksAfterTurn({
      group_folder: conv.group_folder,
      conversation_id: conv.id,
      event: 'failed',
      answer: '',
    }).catch((err) =>
      logger.warn(
        { conversation_id: conv.id, err: String(err) },
        'sweepStuckConversations: ask settlement failed',
      ),
    );
  }

  logger.info(
    {
      marked: trulyStuck.length,
      skipped_pending_form: stuck.length - trulyStuck.length,
    },
    'Fixed stuck "working" conversations',
  );
}

/**
 * Marker the boot-time stuck-conversation sweep writes when it can't tell
 * what happened to a chat run. Exported so other modules (e.g. the form-
 * response router) can recognise and remove it when a deferred answer
 * proves the agent wasn't actually crashed — it was waiting for input.
 */
export const STUCK_RESTART_MARKER =
  '⚠️ This message was not processed — the agent was interrupted by a server restart.';

/** Recover durable Direct claims after the HTTP/WebSocket bridge is live. */
export { recoverDirectFollowups } from './modules/chat/direct-followups.js';

/**
 * Clear worktree_path on tasks that finished while the server was down.
 * The actual `.worktrees/` directories are cleaned up lazily by `git worktree prune`
 * inside the sandbox on the next run.
 *
 * Tasks in active or review stages are skipped — they are pending re-execution
 * (e.g. after a review rejection) and still need their worktree intact.
 * Only tasks in a done-type stage lose the binding: cards parked in a queue
 * stage (Question, Backlog, ...) keep their unmerged branch and folder.
 */
export async function sweepOrphanedWorktrees(): Promise<void> {
  // Clear orphaned task worktree paths and remove worktree directories
  const orphanedTasks = await getTasksWithOrphanedWorktrees();
  let cleared = 0;
  if (orphanedTasks && orphanedTasks.length > 0) {
    for (const task of orphanedTasks) {
      // Skip tasks that are pending re-execution in an active or review stage.
      // Their worktree is still needed — drainProjectQueue will pick them up.
      const group = getGroupByFolder(task.project_id);
      if (group) {
        const stages = getGroupStages(group);
        if (isActiveStage(stages, task.status)) {
          logger.info(
            { task_id: task.id, status: task.status },
            'Skipping worktree cleanup — task is in an active/review stage and will be re-executed',
          );
          continue;
        }
        // Queue stages (Question, Backlog, Failed) keep the binding: the task
        // branch is unmerged and the folder is retained on purpose.
        if (findStage(stages, task.status)?.type === 'queue') {
          logger.info(
            { task_id: task.id, status: task.status },
            'Skipping worktree cleanup — task is parked in a queue stage and keeps its checkout',
          );
          continue;
        }
      }

      // A/B experiment children (and parents) are never auto-merged, so a
      // finished variant keeps its branch and worktree for comparison until
      // AB-3 resolves the experiment. Keep the binding so task chat and
      // "Continue" still open the variant's checkout after a restart.
      if (isAbExperimentTask(task)) {
        logger.info(
          { task_id: task.id, status: task.status },
          'Skipping worktree cleanup — A/B experiment variants retain their checkout',
        );
        continue;
      }

      // Only clear the DB field — do NOT remove the worktree directory.
      // The user may want to "Continue" the task later, and sandbox_worktree
      // add is idempotent (reuses existing directories). Truly abandoned
      // worktrees are cleaned by `git worktree prune` on next sandbox run.
      await updateTask(task.id, { worktree_path: null });
      cleared++;
    }
    if (cleared > 0) {
      logger.info(
        { count: cleared },
        'Cleared orphaned task worktree_path entries',
      );
    }
  }

  // Conversation worktrees and their browsers persist between turns and
  // restarts. Only explicit worktree removal/merge clears that binding; an
  // idle conversation is not evidence that its checkout disappeared.
}

/**
 * Recover agent runs that were in-flight when the process last exited.
 * Watches their output files on the host filesystem and delivers results.
 * Called after messaging is initialized so WhatsApp delivery works.
 */
export async function recoverOrphanedRuns(
  dependencies: TaskRecoveryDependencies = {},
): Promise<void> {
  const recovery = await reattachOrphanedRuns(dependencies);
  await recovery.settled;
}

/** Re-establish run ownership before admitting new work, without making boot
 * wait for the agents themselves to finish. Completion still uses the same
 * recovery pipeline; callers that need final results can await `settled`.
 */
export async function reattachOrphanedRuns(
  dependencies: TaskRecoveryDependencies = {},
): Promise<{ settled: Promise<void> }> {
  const admissionSnapshot =
    dependencies.admissionSnapshot ?? (await snapshotTaskAdmissionOwners());
  await recoverStaleTaskAdmissions(admissionSnapshot);
  // Filter out runs that are actively managed by the current process.
  // Between boot and this async call, tasks may have started via drainProjectQueue
  // or user interaction — those are NOT orphans and must not be double-processed.
  const allRunning = await getActiveRunsByStatus('running');
  const orphanedRuns = (allRunning || []).filter(
    (run) =>
      !run.stage?.startsWith('direct-followup:') &&
      !isCurrentProcessRun(run.id),
  );
  if (!orphanedRuns || orphanedRuns.length === 0) {
    return { settled: Promise.resolve() };
  }

  logger.info(
    { count: orphanedRuns.length },
    'Recovering orphaned runs (async)',
  );

  const recoveries: Promise<void>[] = [];
  const adoptions: Promise<void>[] = [];

  for (const run of orphanedRuns) {
    const admissionId =
      run.task_id ??
      (run.conversation_id
        ? `conversation:${run.conversation_id}`
        : `conversation:${run.group_folder}:${run.chat_jid}`);
    const admissionOwners = admissionSnapshot.get(run.group_folder);
    // A continuation inherits this token; never release an uncaptured owner.
    const admissionOwnerToken = admissionOwners?.has(admissionId)
      ? admissionOwners.get(admissionId)
      : `uncaptured:${randomUUID()}`;
    // An early reap ends the run here, so its boot-snapshot admission would
    // otherwise stay until the next restart and block checkout-mode changes.
    const releaseReapedRunAdmission = async () => {
      if (!admissionSnapshot.get(run.group_folder)?.has(admissionId)) return;
      await releaseTaskAdmission(
        run.group_folder,
        admissionId,
        admissionOwnerToken,
      ).catch((error) =>
        logger.warn(
          { error: String(error), run_id: run.id },
          'Failed to release reaped run admission',
        ),
      );
    };
    const now = Date.now();
    const timeout_at = new Date(run.timeout_at).getTime();
    const deadlineAt = recoveryDeadlineMs(run, timeout_at);
    const hostDir = resolveHostRunDir(run);

    if (await retireOrphanedWebViewAgent(run, hostDir)) continue;

    // Sub-runs spawned by the agent_query tool have no rejoinable parent after
    // a restart: the parent direct-LLM call lived only in the prior process's
    // memory, so there is nowhere to deliver this run's output. Recovering it
    // would let the sandbox agent finish, dump the result into a void, and
    // attempt a bogus WhatsApp send (chat_jid='agent-tool' falls through to
    // the WA fallback below). Kill it instead — the user can re-issue the
    // query if they want it.
    if (run.chat_jid === 'agent-tool' && !run.task_id) {
      logger.info(
        { runId: run.id, group: run.group_folder },
        'Killing orphaned agent_query sub-run (no parent to attach to after restart)',
      );
      await killRun(run).catch((err) =>
        logger.warn(
          { runId: run.id, err },
          'Failed to kill orphaned agent_query sub-run',
        ),
      );
      if (hostDir) {
        try {
          removeIpcDirSync(hostDir);
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    // Stalled? (idle threshold exceeded, but hard deadline not yet)
    // Safety net for the case where the board crashed while the in-process
    // watchdog was the only thing tracking silence — last_event_at is the
    // signal we can rely on here.
    const lastEventMs = run.last_event_at
      ? new Date(run.last_event_at).getTime()
      : NaN;
    if (
      run.last_event_at &&
      !Number.isNaN(lastEventMs) &&
      now - lastEventMs > STALL_TIMEOUT_MS &&
      deadlineAt >= now
    ) {
      logger.warn(
        {
          runId: run.id,
          group: run.group_folder,
          stalledForMs: now - lastEventMs,
        },
        'Orphaned run stalled (idle threshold exceeded during board downtime)',
      );
      await killRun(run, { preserveTerminalState: true }).catch(() => {});
      if (run.isScheduledTask && run.scheduled_task_id) {
        await finalizeTerminalScheduledRecovery(
          run,
          hostDir,
          'stalled',
          null,
          'Stalled during restart recovery',
        );
      } else {
        await completeActiveRun(run.id, 'stalled');
      }
      await releaseReapedRunAdmission();
      if (run.task_id) {
        await recoverAutomaticStageEntryRunOutcome(run, {
          failed: true,
          error: 'Stalled during restart recovery',
        });
      }
      if (hostDir && !run.isScheduledTask) {
        try {
          if (persistRecoveredRunArtifacts(run, hostDir)) {
            await removeRunDirPreservingControlResponses(hostDir);
          }
        } catch {
          /* ignore */
        }
      }
      // The reaped run freed a project slot. The task it was running may still
      // be in an active stage (stalled reap does not move it), and recovery may
      // have advanced sibling tasks into active stages (e.g. `review`) that are
      // waiting for a free slot. Drain so the queue restarts instead of leaving
      // those tasks stranded — mirroring executeTask's finally-block drain.
      const stalledGroup = getGroupByFolder(run.group_folder);
      if (stalledGroup) {
        drainProjectQueue(run.group_folder, stalledGroup);
      }
      if (
        !run.task_id &&
        !run.isScheduledTask &&
        run.chat_jid.includes('@web')
      ) {
        // Chat runs have no wall-clock deadline, so an idle chat lands here.
        // Hand off its queued follow-ups like the other terminal chat paths
        // instead of leaving them until the page is reloaded.
        const stalledConvId = await resolveWebChatConversationId(run);
        if (stalledConvId) {
          const stalledStreamKey = getActiveStreamKeyForConv(stalledConvId);
          const stalledConv = await getConversation(stalledConvId);
          const handoff = await releaseAndClaimDirectFollowups(
            run.group_folder,
            stalledConvId,
          );
          broadcast({
            type: 'chat_completed',
            payload: {
              ...chatEventScope(
                run.group_folder,
                stalledConv?.objective_id ?? undefined,
              ),
              conversation_id: stalledConvId,
              ...(stalledStreamKey ? { streamKey: stalledStreamKey } : {}),
              failed: true,
              releasedQueuedMessageIds: handoff.releasedMessageIds,
            },
          });
          await notifyRecoveredChatLifecycle(run, stalledConvId, 'failed');
          for (const next of handoff.claimed)
            scheduleClaimedDirectFollowup(next.runId);
        }
      }
      continue;
    }

    // Timed out?
    if (deadlineAt < now) {
      logger.warn(
        { runId: run.id, group: run.group_folder },
        'Orphaned run timed out',
      );
      if (run.isScheduledTask && run.scheduled_task_id) {
        await finalizeTerminalScheduledRecovery(
          run,
          hostDir,
          'timeout',
          null,
          'Timed out during restart recovery',
        );
      } else {
        await completeActiveRun(run.id, 'timeout');
      }
      await releaseReapedRunAdmission();
      const entryOrphanTimeoutRecovered = run.task_id
        ? await recoverAutomaticStageEntryRunOutcome(run, {
            failed: true,
            error: 'Timed out during process restart',
          })
        : false;

      // Notify user (skip bridge JIDs -- HTTP client already disconnected)
      if (run.isScheduledTask && run.scheduled_task_id) {
        // Scheduled recovery is finalized above and must not emit chat errors.
      } else if (run.chat_jid.includes('@web')) {
        const conversation_id = await resolveWebChatConversationId(run);
        await saveChatMessage({
          group_folder: run.group_folder,
          role: 'assistant',
          content:
            '⚠️ Agent timed out during a restart. Please resend your message.',
          sender_name: ASSISTANT_NAME,
          source: 'web',
          created_at: new Date().toISOString(),
          conversation_id: conversation_id,
          failed: true,
        });
        broadcast({
          type: 'chat_completed',
          payload: { folder: run.group_folder, conversation_id, failed: true },
        });
      } else if (
        !run.chat_jid.includes('@bridge') &&
        !run.chat_jid.includes('@kanban')
      ) {
        sendMessage(
          run.chat_jid,
          `${ASSISTANT_NAME}: Sorry, my previous response was lost during a restart and has now timed out. Please resend your message.`,
        ).catch(() => {});
      }

      // Handle task recovery — respect agent's own status changes
      if (run.task_id && !entryOrphanTimeoutRecovered) {
        const task = await getTask(run.task_id);
        const group = getGroupByFolder(run.group_folder);
        const stages = getGroupStages(group);
        const currentStageDef = task
          ? findStage(stages, task.status)
          : undefined;
        const alreadyDone = currentStageDef?.type === 'done';

        if (alreadyDone) {
          logger.info(
            {
              runId: run.id,
              task_id: run.task_id,
              currentStatus: task!.status,
            },
            'Orphan timeout: task already in done stage — preserving status',
          );
        } else {
          const timedOutAt = new Date().toISOString();
          await updateTask(run.task_id, {
            status: getFailedStage(stages)?.id ?? 'failed',
            error: 'Timed out during process restart',
            completed_at: timedOutAt,
          });
          if (task) {
            const timeoutMsg = await appendTaskMessage(task.project_id, {
              task_id: run.task_id,
              role: 'assistant',
              content: 'Error: Timed out during process restart.',
              created_at: timedOutAt,
            });
            broadcast({
              type: 'task_message',
              payload: {
                task_id: run.task_id,
                project_id: task.project_id,
                message: timeoutMsg,
              },
            });
          }
        }
      }

      // Archive the V1 pair to transcripts before deleting run dir
      if (hostDir && !run.isScheduledTask) {
        try {
          if (persistRecoveredRunArtifacts(run, hostDir)) {
            await removeRunDirPreservingControlResponses(hostDir);
          }
        } catch {
          /* ignore */
        }
      }
      // The timed-out run freed a project slot. Sibling tasks that recovery
      // advanced into active stages (e.g. `review`) may be waiting for a slot
      // — drain so they are picked up. (This task itself moved to `failed`,
      // so it won't be re-picked; the drain is for the rest of the queue.)
      const timedOutGroup = getGroupByFolder(run.group_folder);
      if (timedOutGroup) {
        drainProjectQueue(run.group_folder, timedOutGroup);
      }
      continue;
    }

    // Still within timeout -- check if run directory exists
    if (!hostDir) {
      logger.warn(
        { runId: run.id },
        'Orphaned run directory missing, marking as error',
      );
      await completeActiveRun(run.id, 'error');
      await releaseReapedRunAdmission();
      const entryMissingRecovered = run.task_id
        ? await recoverAutomaticStageEntryRunOutcome(run, {
            failed: true,
            error: 'Interrupted: run directory missing during recovery',
          })
        : false;

      // The run dir is gone: the active run row holds the canonical result.
      if (run.task_id && !entryMissingRecovered) {
        const task = await getTask(run.task_id);
        if (task) {
          const group = getGroupByFolder(run.group_folder);
          const stages = getGroupStages(group);
          const currentStageDef = findStage(stages, task.status);
          const alreadyDone = currentStageDef?.type === 'done';

          if (!alreadyDone) {
            const errorAt = new Date().toISOString();
            await updateTask(run.task_id, {
              status: getFailedStage(stages)?.id ?? 'failed',
              error: 'Interrupted: run directory missing during recovery',
              completed_at: errorAt,
            });

            const recoveredResult = run.result;
            const needsFallback = !recoveredResult;

            if (!needsFallback) {
              const recoveredAt = new Date().toISOString();
              const msg = await appendTaskMessage(task.project_id, {
                task_id: run.task_id,
                role: 'assistant',
                content: recoveredResult,
                created_at: recoveredAt,
              });
              broadcast({
                type: 'task_message',
                payload: {
                  task_id: run.task_id,
                  project_id: task.project_id,
                  message: msg,
                },
              });
              logger.info(
                { runId: run.id, task_id: run.task_id },
                'Recovered result from the active run row',
              );
            } else {
              const errorAt2 = new Date().toISOString();
              const msg = await appendTaskMessage(task.project_id, {
                task_id: run.task_id,
                role: 'assistant',
                content:
                  'Error: Interrupted — run directory missing during recovery.',
                created_at: errorAt2,
              });
              broadcast({
                type: 'task_message',
                payload: {
                  task_id: run.task_id,
                  project_id: task.project_id,
                  message: msg,
                },
              });
            }
          }
        }
      } else if (run.chat_jid.includes('@web')) {
        const conversation_id = await resolveWebChatConversationId(run);
        await saveChatMessage({
          group_folder: run.group_folder,
          role: 'assistant',
          content: '⚠️ Agent response was lost during a restart.',
          sender_name: ASSISTANT_NAME,
          source: 'web',
          created_at: new Date().toISOString(),
          conversation_id: conversation_id,
          failed: true,
        });
        broadcast({
          type: 'chat_completed',
          payload: { folder: run.group_folder, conversation_id, failed: true },
        });
      }
      continue;
    }

    // Poll for completion in the background (non-blocking)
    const runHostDir = hostDir; // capture for closure
    // Claim this run so the adoption path in runContainerAgent skips it.
    markCurrentProcessRun(run.id);
    let markAdopted!: () => void;
    const adopted = new Promise<void>((resolve) => {
      markAdopted = resolve;
    });
    recoveries.push(
      (async () => {
        let recoveryAbortController: AbortController | undefined;
        // Dedicated worktree runs do not touch the main checkout during
        // recovery. Their post-execution merge path acquires its own short
        // critical-section lease when needed.
        const recoveredTask = run.task_id
          ? await getTask(run.task_id)
          : undefined;
        const recoveredConversation = run.conversation_id
          ? await getConversation(run.conversation_id)
          : undefined;
        const usesDedicatedWorktree = Boolean(
          recoveredTask?.worktree_path ||
          recoveredConversation?.use_worktree ||
          recoveredConversation?.worktree_path,
        );
        let recoveryLease: SharedCheckoutLease | undefined;
        let recoveryHeartbeat: NodeJS.Timeout | undefined;
        let successfulTaskBoundary: RecoveredSuccessfulTaskBoundary | undefined;
        let recoveryFinalizationSuccessful = false;
        // The continuation (or the newer run it lost to) owns the admission.
        let admissionHandedOff = false;
        if (run.task_id && !usesDedicatedWorktree) {
          recoveryLease = await acquireSharedCheckoutLease(
            run.group_folder,
            { type: 'task', id: run.task_id },
            { reattachActiveOwner: true },
          );
          recoveryHeartbeat = setInterval(() => {
            void recoveryLease?.heartbeat();
          }, 10_000);
        }
        try {
          // Resolve conversation details for streaming recovery
          const convId = run.conversation_id ?? undefined;
          const conv = convId ? await getConversation(convId) : undefined;
          const chatScope = chatEventScope(
            run.group_folder,
            conv?.objective_id,
          );
          const streamKey = randomUUID();

          // Emit task_started so the UI sets running:true on the task card and shows the streaming bubble
          if (run.task_id) {
            const recoveringTask = await getTask(run.task_id);
            if (recoveringTask) {
              broadcast({
                type: 'task_started',
                payload: {
                  task_id: run.task_id,
                  project_id: recoveringTask.project_id,
                  run_id: run.id,
                },
              });
            }
          }

          // Emit chat_started so the UI initializes streaming state for this conversation
          if (!run.task_id && run.chat_jid.includes('@web') && streamKey) {
            broadcast({
              type: 'chat_started',
              payload: {
                ...chatScope,
                conversation_id: convId,
                streamKey,
              },
            });
          }

          // Re-register an abort controller for recovered runs so the Stop button
          // works after a restart (chat via chatRunAbortControllers, tasks via
          // claimedTasks — see registerRecoveredTaskAbort).
          if (run.task_id) {
            const recoveringTask = await getTask(run.task_id);
            if (recoveringTask) {
              recoveryAbortController = new AbortController();
              registerRecoveredTaskAbort(
                run.task_id,
                recoveringTask.project_id,
                recoveryAbortController,
              );
            }
          } else if (run.chat_jid.includes('@web')) {
            recoveryAbortController = new AbortController();
            const recoveryAbortKey = chatAbortKey(
              run.group_folder,
              run.conversation_id ?? undefined,
              run.chat_jid,
            );
            const prev = chatRunAbortControllers.get(recoveryAbortKey);
            if (prev) prev.abort();
            chatRunAbortControllers.set(
              recoveryAbortKey,
              recoveryAbortController,
            );
          }

          if (run.task_id) {
            const recoveringTask = await getTask(run.task_id);
            if (recoveringTask)
              clearTaskOutputRun(
                recoveringTask.project_id,
                run.task_id,
                run.id,
              );
          }
          let recoveryOutputOffset = 0;
          // A reattached testing or review run that already wrote its verdict
          // gets the same background task stop as a live one. The re-stream
          // from byte 0 rebuilds the text the verdict check reads. A run
          // started by an automatic stage entry gives no verdict.
          const recoveredStages =
            run.task_id && run.stage
              ? getGroupStages(getGroupByFolder(run.group_folder))
              : undefined;
          const recoveredStageKind =
            recoveredStages && run.stage
              ? isTestingStage(recoveredStages, run.stage)
                ? 'testing'
                : isReviewStage(recoveredStages, run.stage)
                  ? 'review'
                  : undefined
              : undefined;
          let recoveredText = '';
          const stopBackgroundTasksAfterVerdict =
            run.task_id &&
            run.stage &&
            recoveredStageKind &&
            !(await getStageEntryEventByRunId(run.id))
              ? createVerdictBackgroundTaskStopper({
                  kind: recoveredStageKind,
                  taskId: run.task_id,
                  stageId: run.stage,
                  getRunId: () => run.id,
                  getOutput: () => recoveredText,
                })
              : undefined;
          const onChunk = (data: ChunkData) => {
            if (stopBackgroundTasksAfterVerdict && data.type === 'text')
              recoveredText += data.content;
            if (data.type === 'background_tasks') {
              stopBackgroundTasksAfterVerdict?.(data.tasks);
              // The from-byte-0 re-stream replays every subagent list in
              // order, so the last one wins and an empty list clears.
              if (!run.task_id && run.chat_jid.includes('@web')) {
                broadcast({
                  type: 'chat_background_tasks',
                  payload: {
                    ...chatScope,
                    conversation_id: convId,
                    streamKey,
                    tasks: data.tasks,
                  },
                });
              }
              return;
            }
            if (data.type !== 'text') return;
            if (run.task_id) {
              const contentOffset = recoveryOutputOffset;
              recoveryOutputOffset += Buffer.byteLength(data.content, 'utf8');
              recordTaskStreamChunk(
                run.task_id,
                data.content,
                run.group_folder,
                run.id,
                data.entryId,
                data.entryComplete,
                data.canonicalEntry,
              );
              broadcast({
                type: 'task_output',
                payload: {
                  task_id: run.task_id,
                  content_offset: contentOffset,
                  run_id: run.id,
                  content: data.content,
                  ...(data.entryId ? { entry_id: data.entryId } : {}),
                  ...(data.entryComplete !== undefined
                    ? { entry_complete: data.entryComplete }
                    : {}),
                  ...(data.canonicalEntry ? { canonical_entry: true } : {}),
                },
              });
            } else if (run.chat_jid.includes('@web')) {
              broadcast({
                type: 'chat_output',
                payload: {
                  ...chatScope,
                  content: data.content,
                  conversation_id: convId,
                  streamKey,
                },
              });
            }
          };
          // Redirect the agent's built-in PushNotification tool to the user's
          // devices for pushes emitted during a recovered run. Dedupe by tool_use
          // id makes the from-byte-0 re-stream idempotent (no double-sends).
          const onToolUse = (
            name: string,
            toolInput: Record<string, unknown>,
            toolId?: string,
          ) => {
            if (name === 'PushNotification') {
              void firePushNotification(run.group_folder, toolInput, toolId, {
                task_id: run.task_id ?? undefined,
                conversation_id: run.conversation_id ?? undefined,
                triggered_by_user_id: run.triggeredByUserId,
              });
            }
          };
          // Claims, checkout ownership, Stop controls and streaming state are
          // installed. Boot may now admit other work while this watcher waits.
          markAdopted();
          // A warm turn proven dead leaves a non-terminal V1 pair and exit 1,
          // which waitForRun rejects. The interrupted marker below still owns
          // that outcome, so hold the error until the marker is checked.
          let waitError: unknown;
          const waited = await waitForRun(
            runHostDir,
            Math.max(1000, deadlineAt - now),
            onChunk,
            recoveryAbortController?.signal,
            buildStallOpts(
              run.id,
              run.group_folder,
              run.task_id ?? undefined,
              run.conversation_id ?? undefined,
              STALL_TIMEOUT_MS,
              STALL_GRACE_MS,
              buildPidAliveProbe(
                getSandboxClient(),
                run.sandbox_stack,
                run.sandbox_service,
                run.sandbox_instance,
              ),
            ),
            onToolUse,
          ).catch((err) => {
            if (
              !run.task_id ||
              !fs.existsSync(
                path.join(runHostDir, RESTART_WARM_INTERRUPTED_MARKER),
              )
            ) {
              throw err;
            }
            waitError = err;
            return undefined;
          });

          // stopTask() may have finished while waitForRun was unwinding — bail out
          // before completeActiveRun / status overwrite.
          if (run.task_id) {
            const stoppedTask = await getTask(run.task_id);
            if (stoppedTask?.error === 'Stopped by user') {
              if (recoveryAbortController?.signal.aborted) {
                await killRun(run).catch((kerr) =>
                  logger.warn(
                    { runId: run.id, error: String(kerr) },
                    'Failed to kill agent after recovery abort',
                  ),
                );
              }
              unmarkCurrentProcessRun(run.id);
              return;
            }
          }

          // If the user pressed Stop during recovery, kill the sandbox process so
          // it doesn't keep running after waitForRun bails out.
          if (recoveryAbortController?.signal.aborted) {
            await killRun(run).catch((kerr) =>
              logger.warn(
                { runId: run.id, error: String(kerr) },
                'Failed to kill agent after recovery abort',
              ),
            );
          }
          if (recoveryAbortController && !run.task_id) {
            const recoveryAbortKey = chatAbortKey(
              run.group_folder,
              run.conversation_id ?? undefined,
              run.chat_jid,
            );
            if (
              chatRunAbortControllers.get(recoveryAbortKey) ===
              recoveryAbortController
            ) {
              chatRunAbortControllers.delete(recoveryAbortKey);
            }
          }
          if (
            run.task_id &&
            fs.existsSync(
              path.join(runHostDir, RESTART_WARM_INTERRUPTED_MARKER),
            )
          ) {
            if (recoveryAbortController) {
              unregisterRecoveredTaskAbort(
                run.task_id,
                recoveryAbortController,
              );
            }
            unmarkCurrentProcessRun(run.id);
            if (persistRecoveredRunArtifacts(run, runHostDir)) {
              const scheduleResult = await scheduleRestartRecoveryContinuation(
                run,
                dependencies,
                admissionOwnerToken,
              );
              if (restartRecoveryHandled(scheduleResult)) {
                admissionHandedOff = true;
                if (restartRecoveryScheduled(scheduleResult)) {
                  await removeRunDirPreservingControlResponses(runHostDir);
                }
                return;
              }
            }
          }
          if (!waited) throw waitError;
          const result = waited;
          const parsed = readRecoveredRunResult(runHostDir, result.metrics);
          const recoveredOutput = buildOutput(
            result,
            parsed,
            run.group_folder,
            result.metrics?.durationMs ?? undefined,
          );
          const effectiveIsError = recoveredOutput.status === 'error';
          if (!effectiveIsError && run.task_id) {
            await beginRecoveredSuccessfulTaskFinalization(
              run,
              parsed.result,
              parsed.session_id,
              (value) => {
                successfulTaskBoundary = value;
              },
              () => {
                if (!recoveryAbortController) return;
                retireRecoveredTaskExecutionPresentation(
                  run.task_id!,
                  recoveredTask?.project_id ?? run.group_folder,
                  recoveryAbortController,
                  run.id,
                );
              },
            );
          }
          const steeringHeld =
            successfulTaskBoundary?.boundary.shouldAdvance === false;
          // Release the durable active-run blocker before post-execution Git
          // operations acquire the shared-checkout lease. Otherwise an
          // expired lease remains unreclaimable while this recovery watcher is
          // waiting on that same active run to become terminal.
          await completeActiveRun(
            run.id,
            effectiveIsError ? 'error' : 'completed',
            parsed,
            parsed.session_id,
          );
          if (run.task_id) {
            let recoveredTask = await getTask(run.task_id);
            const recoveredGroup = getGroupByFolder(run.group_folder);
            if (recoveredTask && recoveredGroup) {
              // The active run is the authoritative instance for the process
              // being recovered. Persist it before post-run Git helpers
              // re-read the task row; otherwise legacy tasks with a null
              // sandbox_instance route Git to the stack default and can turn
              // a successful recovered run into a generic failure.
              if (
                run.sandbox_instance &&
                recoveredTask.sandbox_instance !== run.sandbox_instance
              ) {
                await updateTask(run.task_id, {
                  sandbox_instance: run.sandbox_instance,
                });
                recoveredTask = {
                  ...recoveredTask,
                  sandbox_instance: run.sandbox_instance,
                };
              }
              await (
                dependencies.runPostExecutionGitOps ?? runPostExecutionGitOps
              )(recoveredTask, recoveredGroup, getGroupStages(recoveredGroup));
            }
          }
          await updateRunStats(run.id, parsed);
          const entryOutcomeRecovered = run.task_id
            ? await recoverAutomaticStageEntryRunOutcome(run, {
                failed: effectiveIsError,
                error: effectiveIsError
                  ? 'Agent exited with error after restart recovery'
                  : undefined,
                output: parsed.result,
                sessionId: parsed.session_id,
              })
            : false;

          // Update session only for chat runs (see comment in recoverStalledRuns above).
          if (parsed.session_id && !run.task_id) {
            if (run.conversation_id) {
              await setConversationSessionId(
                run.conversation_id,
                run.session_agent_key || run.agent_name || AGENT_CMD,
                parsed.session_id,
              );
            } else {
              sessions[run.group_folder] = parsed.session_id;
              saveSessions();
            }
          }

          // Deliver result based on run type
          if (run.task_id && !entryOutcomeRecovered) {
            const task = await getTask(run.task_id);
            const group = getGroupByFolder(run.group_folder);
            const stages = getGroupStages(group);
            const currentStageDef = task
              ? findStage(stages, task.status)
              : undefined;
            const alreadyDone = currentStageDef?.type === 'done';
            let stageEntryEventId =
              alreadyDone && task
                ? (
                    await getCurrentStageEntryEvent(
                      task.id,
                      task.project_id,
                      task.status,
                    )
                  )?.id
                : undefined;
            const recoveredHandoff =
              !steeringHeld && !effectiveIsError && task
                ? await getPendingTaskStageHandoff(
                    task,
                    run.stage || task.status,
                  )
                : undefined;
            const stageEntryEventRef: StageEntryEventRef = {};
            const testingRecovered =
              !steeringHeld &&
              !recoveredHandoff &&
              !alreadyDone &&
              task &&
              group
                ? await recoverTestingRun(
                    task,
                    group,
                    stages,
                    parsed.result,
                    parsed.session_id,
                    run.agent_name,
                    parsed.model_name,
                    effectiveIsError,
                    run.stage,
                    run.id,
                    stageEntryEventRef,
                    undefined,
                    { leaseAlreadyHeld: !!recoveryLease },
                  )
                : false;
            const reviewRecovered =
              !steeringHeld &&
              !recoveredHandoff &&
              !alreadyDone &&
              !testingRecovered &&
              !effectiveIsError &&
              task &&
              group
                ? await recoverReviewRun(
                    task,
                    group,
                    stages,
                    parsed.result,
                    parsed.session_id,
                    run.sandbox_instance,
                    run.agent_name,
                    parsed.model_name,
                    run.stage,
                    run.id,
                    stageEntryEventRef,
                    { leaseAlreadyHeld: !!recoveryLease },
                  )
                : false;
            const retryError = [
              parsed.result,
              result.stderr,
              runV1ErrorText(result.events),
            ]
              .filter((value): value is string => !!value)
              .join('\n');
            const failedChainRecovered =
              !steeringHeld &&
              !recoveredHandoff &&
              !alreadyDone &&
              !testingRecovered &&
              effectiveIsError &&
              task &&
              group
                ? await recoverFailedReviewChainRun(
                    task,
                    group,
                    stages,
                    retryError,
                    parsed.session_id,
                    run.sandbox_instance,
                    run.agent_name,
                    parsed.model_name,
                    run.stage,
                    run.id,
                    stageEntryEventRef,
                  )
                : false;
            const lifecycleRecovered =
              testingRecovered || reviewRecovered || failedChainRecovered;

            const recoveredAt = new Date().toISOString();
            const taskUpdate: Record<string, unknown> = {
              completed_at: recoveredAt,
              session_id: parsed.session_id,
            };
            // Propagate sandbox_instance from the active_run so follow-up git ops target the right container
            if (run.sandbox_instance) {
              taskUpdate.sandbox_instance = run.sandbox_instance;
            }
            if (parsed.result) {
              taskUpdate.output = parsed.result;
            }
            const retryableTaskError =
              effectiveIsError && !!task && isRetryableTaskError(retryError);

            if (steeringHeld) {
              // The shared boundary already restored active_runs.stage and
              // persisted the recovered result/session for its continuation.
            } else if (alreadyDone) {
              logger.info(
                {
                  runId: run.id,
                  task_id: run.task_id,
                  currentStatus: task!.status,
                },
                'Orphan recovery: task already in done stage — preserving status',
              );
            } else if (lifecycleRecovered) {
              // Structured testing/review recovery owns the transition.
            } else if (recoveredHandoff) {
              taskUpdate.status = recoveredHandoff.toStage;
            } else if (retryableTaskError) {
              // Capacity and rate-limit failures are transient. Keep the task
              // in its active stage and reserve its slot for the retry rather
              // than misclassifying a restart-recovered result as Failed.
              delete taskUpdate.completed_at;
              taskUpdate.error = `Retry scheduled: ${formatTransientTaskError(retryError)}`;
              taskUpdate.output = '';
            } else if (effectiveIsError) {
              // Match normal execution and synchronous boot recovery: process
              // failure is based on buildOutput's effective agent outcome, not
              // the wrapper exit alone. Preserve parsed output for diagnostics.
              taskUpdate.error =
                'Agent exited with error after restart recovery';
              taskUpdate.status = getFailedStage(stages)?.id ?? 'failed';
            } else {
              // Agent completed successfully — advance to the next active/review
              // stage in the pipeline (e.g. `review`), not straight to `done`.
              // `recoverOrphanedRuns` re-attaches to runs that survived a board
              // restart; the in-process `executeTask` success path that calls
              // `getNextActiveStage` was killed before it could run, so we have
              // to do the same lookup here. Without this, every `review` stage
              // in the pipeline is silently bypassed on restart.
              // Falls back to the done stage only when there is no next active/
              // review stage.
              const nextActiveStage = getNextActiveStage(
                stages,
                run.stage || task!.status,
                task!.skip_stages ?? undefined,
              );
              const completionStageId =
                nextActiveStage?.id ?? getDoneStage(stages)?.id ?? 'completed';
              taskUpdate.status = completionStageId;
              logger.info(
                {
                  runId: run.id,
                  task_id: run.task_id,
                  fromStage: run.stage || task!.status,
                  toStage: completionStageId,
                  hasResult: !!parsed.result,
                  isError: result.isError,
                },
                'Orphan recovery: agent completed successfully, advancing task to next stage',
              );
            }
            // Merge only after the recovered run reaches a done stage. If it
            // advances to testing/review, that next worker still owns and needs
            // the task worktree.
            const recoveryReachedDone = recoveryReachedDoneStage(
              stages,
              taskUpdate.status,
            );
            let recoveryGitReady = true;
            if (
              !alreadyDone &&
              !steeringHeld &&
              !lifecycleRecovered &&
              !effectiveIsError &&
              recoveryReachedDone &&
              task &&
              group
            ) {
              const freshTask = await getTask(run.task_id);
              if (freshTask) {
                recoveryGitReady = await mergeBranchForDeploy(
                  freshTask,
                  group,
                  'recovery',
                  undefined,
                  { leaseAlreadyHeld: !!recoveryLease },
                );
              } else {
                recoveryGitReady = false;
              }
            }
            if (!steeringHeld && !lifecycleRecovered && recoveryGitReady) {
              const willDispatchDeploy =
                !alreadyDone &&
                !effectiveIsError &&
                recoveryReachedDone &&
                !!task &&
                !!group?.settings?.deployService &&
                taskUpdate.status === getDeployStageId(group.settings, stages);
              if (willDispatchDeploy) {
                taskUpdate.custom_values = {
                  [DEPLOY_PENDING_DISPATCH_KEY]: recoveredAt,
                };
              }
              // A human or another writer may have moved the card while the
              // run result was processed; a recovered handoff is only applied
              // while the card is still in the run's stage.
              const handoffRunStage = run.stage || task?.status;
              const handoffCurrentStatus = recoveredHandoff
                ? (await getTask(run.task_id))?.status
                : undefined;
              const handoffSuperseded =
                !!task &&
                !!recoveredHandoff &&
                handoffCurrentStatus !== undefined &&
                handoffCurrentStatus !== handoffRunStage;
              if (handoffSuperseded && task && recoveredHandoff) {
                logger.info(
                  {
                    runId: run.id,
                    task_id: run.task_id,
                    runStage: handoffRunStage,
                    currentStatus: handoffCurrentStatus,
                  },
                  'Orphan recovery: card left the run stage — skipping recovered handoff',
                );
                await appendTaskStageHandoffDelivery(
                  task,
                  recoveredHandoff,
                  run.id,
                );
              } else {
                const entryEvent = await updateTask(
                  run.task_id,
                  taskUpdate,
                  willDispatchDeploy ? { mergeCustomValues: true } : undefined,
                );
                if (entryEvent) stageEntryEventId = entryEvent.id;
              }
              if (!handoffSuperseded && task && recoveredHandoff) {
                await finalizeTaskStageHandoff(
                  task,
                  recoveredHandoff,
                  run.id,
                  stageEntryEventId,
                );
              }
            }
            if (retryableTaskError && group) {
              scheduleTransientTaskRetry(run.task_id, task.project_id, group);
            }

            if (task && !steeringHeld && !alreadyDone && !lifecycleRecovered) {
              const content = retryableTaskError
                ? `⏳ ${formatTransientTaskError(retryError)}\nWill retry automatically in 2 minutes.`
                : parsed.result ||
                  (effectiveIsError
                    ? 'Error: Agent exited with error after restart recovery.'
                    : 'Run recovered after restart (completed successfully).');
              const msg = await appendTaskMessage(task.project_id, {
                task_id: run.task_id,
                role: 'assistant',
                content,
                entry_type: 'run_result',
                run_id: run.id,
                created_at: recoveredAt,
              });
              broadcast({
                type: 'task_message',
                payload: {
                  task_id: run.task_id,
                  project_id: task.project_id,
                  message: msg,
                },
              });
            }

            const deployCandidate = task ? await getTask(task.id) : undefined;
            const recoveredDeploy =
              !alreadyDone &&
              !steeringHeld &&
              !lifecycleRecovered &&
              !effectiveIsError &&
              recoveryReachedDone &&
              recoveryGitReady &&
              deployCandidate &&
              group?.settings?.deployService &&
              deployCandidate.status ===
                getDeployStageId(group.settings, stages);
            if (recoveredDeploy && deployCandidate && group) {
              await triggerDeploy(deployCandidate, group, {
                skipMerge: true,
                lifecycleRunId: run.id,
                stageEntryEventId,
              });
            }

            // Advance the dataset only when this row's full task lifecycle is
            // terminal. The row-index compare in the DB mutation makes this
            // idempotent with live execution and repeated recovery sweeps.
            const freshTask = await getTask(run.task_id);
            const freshStage = freshTask
              ? findStage(stages, freshTask.status)
              : undefined;
            if (
              freshTask?.dataset_task_id &&
              freshTask.dataset_row_index != null &&
              group &&
              !steeringHeld &&
              (effectiveIsError || freshStage?.type === 'done')
            ) {
              const updated = await incrementDatasetTaskProgress(freshTask.id);
              if (updated) {
                broadcast({ type: 'dataset_task_updated', payload: updated });
                if (
                  updated.status === 'active' &&
                  updated.current_row_index < updated.total_rows
                ) {
                  spawnNextDatasetRow(updated, group);
                }
              }
            }
            if (
              !steeringHeld &&
              !lifecycleRecovered &&
              !retryableTaskError &&
              !recoveredDeploy
            ) {
              if (freshStage?.type === 'done') {
                await notifyRecoveredTaskLifecycle(
                  run,
                  'completed',
                  stageEntryEventId,
                );
              } else if (effectiveIsError) {
                await notifyRecoveredTaskLifecycle(
                  run,
                  'failed',
                  stageEntryEventId,
                );
              }
            }
          } else if (run.isScheduledTask && run.scheduled_task_id) {
            persistPerRunTranscript(run.group_folder, run.id, runHostDir);
            const outcome = getRecoveredScheduledRunOutcome(
              parsed.result,
              effectiveIsError,
            );
            const task = await getTaskById(run.scheduled_task_id);
            try {
              await logTaskRun({
                task_id: run.scheduled_task_id,
                run_id: run.id,
                run_at: run.started_at,
                duration_ms: Date.now() - new Date(run.started_at).getTime(),
                status: outcome.status,
                result: parsed.result,
                error: outcome.error,
              });
            } catch (err) {
              // Match live scheduling and synchronous boot recovery: history
              // is best-effort, but advancing the occurrence is mandatory.
              logger.error(
                { task_id: run.scheduled_task_id, error: String(err) },
                'Failed to persist recovered scheduled task run log',
              );
            }
            if (task) {
              await updateScheduledTaskAfterRun(
                run.scheduled_task_id,
                calcNextRun(task),
                outcome.resultSummary,
                task,
              );
            }
          } else if (run.chat_jid.includes('@web')) {
            // Web chat recovery
            const recoveryConvId =
              convId ?? (await resolveWebChatConversationId(run));
            const content =
              parsed.result || '⚠️ Agent response was lost during a restart.';
            // Archive the native event stream first, as the boot-time web
            // recovery path does: the archived events already contain the
            // final reply, so writing it to JSONL as well would render it
            // above the turn's tool calls and again at the end.
            // Task runs archive to their task transcript below instead.
            const archived =
              !run.task_id &&
              hasRunV1Files(runHostDir) &&
              archiveRunV1Transcript(
                chatTranscriptPath(
                  run.group_folder,
                  parsed.session_id || run.session_id || undefined,
                  run.conversation_id || undefined,
                ),
                runHostDir,
                archiveAgentMetadata(run),
              );
            const savedMsg = await saveChatMessage({
              group_folder: run.group_folder,
              role: 'assistant',
              content,
              sender_name: ASSISTANT_NAME,
              source: 'web',
              created_at: new Date().toISOString(),
              conversation_id: recoveryConvId,
              telemetry: recoveredRunTelemetry(run, recoveredOutput),
              failed: effectiveIsError,
              skipTranscript: archived,
            });
            broadcast({
              type: 'chat_message',
              payload: { folder: run.group_folder, message: savedMsg },
            });
            // Same terminal handoff as a live chat turn: a follow-up admitted
            // while this run was recovering (a form answer, a queued prompt)
            // holds a claimed run row that only this handoff releases.
            const handoff = recoveryConvId
              ? await releaseAndClaimDirectFollowups(
                  run.group_folder,
                  recoveryConvId,
                )
              : undefined;
            broadcast({
              type: 'chat_completed',
              payload: {
                ...chatScope,
                conversation_id: recoveryConvId,
                streamKey,
                failed: effectiveIsError,
                releasedQueuedMessageIds: handoff?.releasedMessageIds ?? [],
              },
            });
            await notifyRecoveredChatLifecycle(
              run,
              recoveryConvId,
              effectiveIsError ? 'failed' : 'completed',
              parsed.result,
            );
            for (const next of handoff?.claimed ?? [])
              scheduleClaimedDirectFollowup(next.runId);
          } else if (
            !run.chat_jid.includes('@bridge') &&
            !run.chat_jid.includes('@kanban')
          ) {
            // WhatsApp message recovery
            if (parsed.result) {
              await sendMessage(
                run.chat_jid,
                `${ASSISTANT_NAME}: ${parsed.result}`,
              );
            }
          }

          // Archive the V1 pair to transcripts before deleting run dir. Web
          // chat output was archived above, before its reply was saved.
          if (run.task_id) {
            const target = outputTranscriptPath(run.group_folder, run.task_id);
            archiveRunV1Transcript(
              target,
              runHostDir,
              archiveAgentMetadata(run),
            );
          }
          try {
            if (
              persistRecoveredRunArtifacts(
                run,
                runHostDir,
                recoveredTranscriptTarget(run, parsed.session_id),
              )
            ) {
              await removeRunDirPreservingControlResponses(runHostDir);
            }
          } catch {
            /* ignore */
          }

          // Emit task_completed/task_error AFTER the saved task_message has been
          // broadcast so that messages refetch happens before tasks refetch.
          // This both clears the in-memory replay buffer (preventing late
          // joiners from seeing a phantom running task) and gives the UI a
          // clean completion signal that mirrors normal task execution.
          if (run.task_id) {
            const finalTask = await getTask(run.task_id);
            broadcast({
              type:
                finalTask?.completed_at == null
                  ? 'task_updated'
                  : effectiveIsError
                    ? 'task_error'
                    : 'task_completed',
              payload: {
                task_id: run.task_id,
                project_id: finalTask?.project_id,
              },
            });
          }

          unmarkCurrentProcessRun(run.id);
          logger.info(
            {
              runId: run.id,
              group: run.group_folder,
              hasResult: !!parsed.result,
            },
            'Orphaned run recovered',
          );
          recoveryFinalizationSuccessful = !effectiveIsError;
        } catch (err) {
          const failure = recoveryFailure(err);
          logger.error(
            { runId: run.id, err },
            'Failed to recover orphaned run',
          );
          await completeActiveRun(run.id, 'error');
          const entryCatchRecovered = run.task_id
            ? await recoverAutomaticStageEntryRunOutcome(run, {
                failed: true,
                error: failure.taskError,
              })
            : false;
          if (entryCatchRecovered && run.task_id) {
            const target = outputTranscriptPath(run.group_folder, run.task_id);
            archiveRunV1Transcript(
              target,
              runHostDir,
              archiveAgentMetadata(run),
            );
          }
          if (run.isScheduledTask && run.scheduled_task_id) {
            persistPerRunTranscript(run.group_folder, run.id, runHostDir);
          }
          if (run.isScheduledTask && run.scheduled_task_id) {
            const recoveryError = 'Failed to recover run after restart';
            const scheduledTask = await getTaskById(run.scheduled_task_id);
            try {
              await logTaskRun({
                task_id: run.scheduled_task_id,
                run_id: run.id,
                run_at: run.started_at,
                duration_ms: Date.now() - new Date(run.started_at).getTime(),
                status: 'error',
                result: null,
                error: recoveryError,
              });
            } catch (logErr) {
              logger.error(
                {
                  task_id: run.scheduled_task_id,
                  error: String(logErr),
                },
                'Failed to persist recovered scheduled task run log',
              );
            }
            if (scheduledTask) {
              await updateScheduledTaskAfterRun(
                run.scheduled_task_id,
                calcNextRun(scheduledTask),
                `Error: ${recoveryError}`,
                scheduledTask,
              );
            }
          } else if (run.task_id && !entryCatchRecovered) {
            const task = await getTask(run.task_id);
            if (task) {
              const group = getGroupByFolder(run.group_folder);
              const stages = getGroupStages(group);
              const currentStageDef = findStage(stages, task.status);
              let stageEntryEventId: string | undefined;
              if (currentStageDef?.type !== 'done') {
                const errorAt = new Date().toISOString();
                stageEntryEventId = (
                  await updateTask(run.task_id, {
                    status: getFailedStage(stages)?.id ?? 'failed',
                    error: failure.taskError,
                    completed_at: errorAt,
                  })
                )?.id;
                const msg = await appendTaskMessage(task.project_id, {
                  task_id: run.task_id,
                  role: 'assistant',
                  content: failure.message,
                  created_at: errorAt,
                });
                broadcast({
                  type: 'task_message',
                  payload: {
                    task_id: run.task_id,
                    project_id: task.project_id,
                    message: msg,
                  },
                });
              } else {
                stageEntryEventId = (
                  await getCurrentStageEntryEvent(
                    task.id,
                    task.project_id,
                    task.status,
                  )
                )?.id;
              }
              broadcast({
                type: 'task_error',
                payload: {
                  task_id: run.task_id,
                  project_id: task.project_id,
                },
              });
              await notifyRecoveredTaskLifecycle(
                run,
                'failed',
                stageEntryEventId,
              );
            }
            const target = outputTranscriptPath(run.group_folder, run.task_id);
            archiveRunV1Transcript(
              target,
              runHostDir,
              archiveAgentMetadata(run),
            );
          } else if (run.chat_jid.includes('@web')) {
            const failConvId = run.conversation_id ?? undefined;
            const failConv = failConvId
              ? await getConversation(failConvId)
              : undefined;
            await finalizeFailedChatRecovery(
              run,
              runHostDir,
              failure.message,
              failConv?.objective_id ?? undefined,
            );
          }
          try {
            if (
              fs.existsSync(runHostDir) &&
              persistRecoveredRunArtifacts(run, runHostDir)
            ) {
              await removeRunDirPreservingControlResponses(runHostDir);
            }
          } catch {
            /* ignore */
          }
          unmarkCurrentProcessRun(run.id);
        } finally {
          if (successfulTaskBoundary) {
            const successfulBoundary = successfulTaskBoundary;
            // A DB error here must not skip the lease/heartbeat/admission
            // cleanup below; without it the live heartbeat keeps the shared
            // checkout lease until the next restart.
            const finalTask = run.task_id
              ? await getTask(run.task_id).catch((error) => {
                  logger.error(
                    { run_id: run.id, error: String(error) },
                    'Failed to read recovered task before closing steering window',
                  );
                  return undefined;
                })
              : undefined;
            if (finalTask) {
              await closeTaskSteeringAdmissionWindow(
                finalTask,
                successfulBoundary.boundary.startingStage,
                recoveryFinalizationSuccessful,
                successfulBoundary.boundary.release,
              ).catch(async (error) => {
                logger.error(
                  { run_id: run.id, error: String(error) },
                  'Failed to close recovered task steering window',
                );
                if (recoveryFinalizationSuccessful) {
                  await updateTask(finalTask.id, {
                    status: successfulBoundary.boundary.startingStage,
                    completed_at: null,
                  }).catch(() => undefined);
                }
              });
            } else {
              successfulBoundary.boundary.release();
            }
          }
          if (
            !admissionHandedOff &&
            (run.task_id || run.conversation_id || run.chat_jid) &&
            admissionSnapshot.get(run.group_folder)?.has(admissionId)
          ) {
            await releaseTaskAdmission(
              run.group_folder,
              admissionId,
              admissionOwnerToken,
            ).catch((error) =>
              logger.warn(
                { error: String(error), run_id: run.id },
                'Failed to release recovered run admission',
              ),
            );
          }
          if (recoveryHeartbeat) clearInterval(recoveryHeartbeat);
          await recoveryLease?.release();
          // StalledError (or any throw from waitForRun) leaves the controller
          // in chatRunAbortControllers, causing all subsequent messages to be
          // silently swallowed by the "Agent already running" guard.
          if (recoveryAbortController && !run.task_id) {
            const recoveryAbortKey = chatAbortKey(
              run.group_folder,
              run.conversation_id ?? undefined,
              run.chat_jid,
            );
            if (
              chatRunAbortControllers.get(recoveryAbortKey) ===
              recoveryAbortController
            ) {
              chatRunAbortControllers.delete(recoveryAbortKey);
            }
          }
          if (recoveryAbortController && run.task_id) {
            // Recovery emitted task_started when it adopted this active run.
            // Release that exact ownership before draining so the client can
            // retire the stale pulse and the replay registry cannot resurrect
            // the old run. The ownership check preserves a newer run claimed
            // for the same task while this watcher was unwinding.
            // Recovery registered this task as claimed so Stop could abort
            // its watcher. Wake the queue only after releasing that claim;
            // draining earlier sees the recovered task occupying the sole
            // project slot and leaves its next active/review stage stranded.
            await finishRecoveredTaskRun(
              {
                id: run.id,
                group_folder: run.group_folder,
                task_id: run.task_id,
              },
              recoveryAbortController,
              { drainProjectQueue: dependencies.drainProjectQueue },
            );
          }
          if (successfulTaskBoundary) {
            endSuccessfulTaskFinalization(successfulTaskBoundary.boundary);
            successfulTaskBoundary = undefined;
          }
        }
      })(),
    );
    // A watcher that fails during setup must also release the boot barrier.
    // Its original promise remains in `recoveries` for completion reporting.
    const recovery = recoveries[recoveries.length - 1];
    adoptions.push(
      Promise.race([
        adopted,
        recovery.then(
          () => undefined,
          () => undefined,
        ),
      ]),
    );
  }

  const settled = Promise.allSettled(recoveries).then(async (results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error({ err: result.reason }, 'Orphaned run watcher failed');
      }
    }
    if (recoveries.length > 0) {
      // Runs that failed recovery may leave conversations stuck "working" because
      // sweepStuckConversations() ran at boot while those runs were still active.
      await sweepStuckConversations();
    }
  });
  // Boot deliberately does not await completion; retain error reporting for
  // the eventual cleanup even when no caller is waiting on `settled`.
  void settled.catch((err) =>
    logger.error({ err }, 'Orphaned run recovery cleanup failed'),
  );
  await Promise.all(adoptions);
  logger.info(
    { count: adoptions.length },
    'Orphaned run watchers attached; startup may continue',
  );
  return { settled };
}

/**
 * Periodic reaper: for each active run whose `pid` is dead and which has
 * no `exit_code` yet, finalize the run as errored.
 *
 * Why: when the agent executable inside the sandbox is killed or crashes
 * hard (SIGKILL / OOM) mid-turn, it never writes `exit_code`. The host-side
 * `waitForRun` polls for that file, and the in-process stall watchdog only
 * fires after STALL_TIMEOUT_MS (default 10 min) of silence. This sweep bounds
 * the wait to the service-watcher interval (default 15s) by probing
 * the trusted `agent-status.sh` wrapper inside the sandbox and reaping dead
 * agents immediately.
 *
 * Safe against PID reuse: a reused PID reports alive → we skip. The stall
 * watchdog still backstops cases where `pid` is missing/non-numeric.
 */
export async function sweepDeadAgentRuns(): Promise<void> {
  let client: ReturnType<typeof getSandboxClient>;
  try {
    client = getSandboxClient();
  } catch (err) {
    logger.debug({ err }, 'sweepDeadAgentRuns: sandbox client unavailable');
    return;
  }

  let runs: Awaited<ReturnType<typeof getActiveRunsByStatus>>;
  try {
    runs = await getActiveRunsByStatus('running');
  } catch (err) {
    logger.warn({ err }, 'sweepDeadAgentRuns: getActiveRunsByStatus failed');
    return;
  }
  if (!runs || runs.length === 0) return;

  for (const run of runs) {
    // NOTE: do NOT filter by isCurrentProcessRun — the runs we want to reap
    // are the ones this process is currently waiting on (waitForRun is
    // awaiting in the same process). The reaper's job is to unblock those
    // live listeners when the agent died.
    try {
      const hostDir = resolveHostRunDir(run);
      if (!hostDir) continue;

      // Already finishing — waitForRun will pick it up.
      if (fs.existsSync(path.join(hostDir, 'exit_code'))) continue;

      // Read PID written by run-agent.sh. If absent or non-numeric, we
      // can't probe — skip; stall watchdog backstops.
      const pidRaw = readIpcFile(hostDir, 'pid', 64);
      if (pidRaw === null || !isNumericPid(pidRaw)) continue;
      const pid = pidRaw.trim();

      // Probe liveness: agent-status.sh exits 0 when alive, non-zero when dead.
      // We reap ONLY when isError is true (process is dead/gone). A reused
      // PID reports alive → we skip; the stall watchdog still backstops.
      // Also capture the raw output and stderr so we can tell apart:
      //   - the wrapper exited 1 (process actually dead) — safe to reap
      //   - "docker compose exec" itself failed (container/MCP hiccup) —
      //     we MUST NOT reap; otherwise we'd kill live agents on transient
      //     infra errors.
      let res: { stdout: string; stderr?: string; isError: boolean };
      try {
        res = await client.sandboxExec(
          run.sandbox_stack,
          run.sandbox_service,
          `agent-status.sh ${pid}`,
          {
            instance: run.sandbox_instance ?? undefined,
            timeout: 5,
            // Client-side bound: `timeout` is box-side only, so a hung box
            // would otherwise hold this probe on the transport for minutes.
            signal: AbortSignal.timeout(DEAD_AGENT_PROBE_ABORT_MS),
          },
        );
      } catch (err) {
        // Transient sandbox probe failure (incl. client-side abort) — skip
        // this run; try again next sweep.
        logger.debug(
          { runId: run.id, pid, err },
          'sweepDeadAgentRuns: sandboxExec failed, will retry next sweep',
        );
        continue;
      }

      if (!res.isError) {
        // PID is alive — nothing to do. This is the common, fast path.
        continue;
      }

      // isError=true from sandboxExec means the wrapper or compose exec exited
      // non-zero. The call can fail in
      // two ways:
      //   (a) agent-status.sh returned non-zero (process dead).
      //   (b) The whole `docker compose exec` itself failed before the inner
      //       shell could run — e.g. container not responding, MCP hiccup,
      //       timeout, OOM. In that case the captured stdout is empty AND
      //       stderr is the docker error.
      // Distinguishing them: look for the `kill0_exit=N` marker in the
      // captured output. If it's there, the inner script ran and (a) applies.
      // If not, the docker call itself failed and we must NOT reap.
      const marker = res.stdout?.match(/kill0_exit=(\d+)/);
      // Exception: Docker reports a deterministic `... in state stopped` error
      // when the container exists but is stopped. It has no live processes, so
      // the agent is certainly dead; waiting for the idle timeout only stalls
      // the lane. Every other marker-less failure stays a non-reaping hiccup.
      const containerStopped =
        !marker && /in state stopped/i.test(`${res.stdout}\n${res.stderr}`);
      if (!marker && !containerStopped) {
        logger.warn(
          {
            runId: run.id,
            group: run.group_folder,
            pid,
            stdout: (res.stdout || '').slice(0, 200),
            stderr: (res.stderr || '').slice(0, 200),
          },
          'sweepDeadAgentRuns: probe failed (no kill0_exit marker) — sandbox/MCP hiccup, NOT reaping',
        );
        continue;
      }
      if (marker && parseInt(marker[1], 10) === 0) {
        // Process is alive — somehow isError is true but the marker says alive.
        // (Shouldn't happen, but be defensive.)
        continue;
      }

      // PID looks dead, but the wrapper may have raced us: ephemeral runs
      // write the wrapper PID first, then overwrite with the agent PID
      // ([run-agent.sh:1452] → [run-agent.sh:1376]); persistent runs write
      // the wrapper's $$ and never overwrite. Either path can leave a
      // `pid` that was alive when the run started and exited cleanly
      // before our probe. Re-check for an exit_code the wrapper wrote on
      // its way out — if it exists, killRun() would write a spurious 137
      // over a real (often 0) exit code, so let waitForRun() pick it up.
      if (fs.existsSync(path.join(hostDir, 'exit_code'))) continue;

      // Also bail if the session dir is missing — the run dir was already
      // cleaned up. Re-running killRun would either fail or write to a
      // nonexistent path; completeActiveRun below is enough.
      const warmSessionDir = recordedWarmSessionDir(hostDir);
      if (
        warmSessionDir &&
        !withIpcDir(warmSessionDir, (dir) =>
          existsIpcEntrySync(dir, 'daemon.pid'),
        )
      ) {
        // session_dir points to a warm-session dir that no longer has a
        // daemon.pid — the daemon exited (idle reap, crash, or manual stop).
        // Don't killRun here: the daemon is already gone, and the wrapper
        // subshell for this turn may still be alive briefly. waitForRun
        // will resolve from its own exit_code write.
        continue;
      }

      logger.warn(
        { runId: run.id, group: run.group_folder, pid },
        containerStopped
          ? 'sweepDeadAgentRuns: agent container is stopped, reaping run'
          : 'sweepDeadAgentRuns: agent pid is dead, reaping run',
      );
      await killRun(run).catch((err) =>
        logger.warn(
          { runId: run.id, err },
          'sweepDeadAgentRuns: killRun failed',
        ),
      );
      // killRun already calls completeActiveRun(runId, 'error'). That stat-less
      // write only finalizes a row that is still running; if the concurrent
      // waitForRun resolved first, the row keeps its terminal status, cost and
      // tokens.
    } catch (err) {
      // Never let one run's failure abort the whole sweep.
      logger.warn(
        { runId: run.id, err },
        'sweepDeadAgentRuns: per-run probe failed',
      );
    }
  }
}

/**
 * Host session dir named by the run's `session_dir` pointer. Only the form
 * `mirrorTaskWarmTurn` and run-agent.sh write is accepted
 * (`/workspace/ipc/sessions/<one segment>`); it maps to the `sessions/` dir of
 * the same IPC project as the run. Anything else counts as no session dir.
 */
function recordedWarmSessionDir(runHostDir: string): string | null {
  const recorded = readIpcFile(runHostDir, 'session_dir', 4096)?.trim();
  const key = /^\/workspace\/ipc\/sessions\/([^/]+)$/.exec(recorded ?? '')?.[1];
  if (!key || key === '.' || key === '..') return null;
  return path.join(path.dirname(path.dirname(runHostDir)), 'sessions', key);
}

async function completeActiveRun(
  ...args: Parameters<typeof completeActiveRunRow>
): Promise<void> {
  const run = await getActiveRunById(args[0]);
  if (run) await finalizeRunBrowser(run);
  await completeActiveRunRow(...args);
}
