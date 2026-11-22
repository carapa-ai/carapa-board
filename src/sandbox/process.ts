import {
  ensureIpcRunsDir,
  prepareSandboxIpcRunsDir,
  remoteIpcPreparationError,
} from './ipc-directories.js';
import { groupReplica, ipcReplica } from './ipc-replica.js';
import { isNativeBoxInstance } from '../modules/boxes/routing.js';
/**
 * MCP-based Agent Runner for CarapaBoard
 *
 * Sandbox process lifecycle: launching agents, watching for completion,
 * killing processes, and cleaning up run directories.
 *
 * Runs agents inside MCP sandbox containers via the carapa-box.
 * Agents are launched in the background with output redirected to files on
 * a shared mount (data/ipc/{group}/runs/), allowing the host to watch for
 * completion via the local filesystem. This survives process restarts.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

import {
  finalizeRunBrowser,
  finalizeSandboxBrowsers,
} from './browser-lifecycle.js';
import { browserIdle } from './browser-idle.js';
import {
  ensurePersistentBrowser,
  resolveBrowserWorkDir,
  resolveConversationBrowserTarget,
} from './browser-sessions.js';
import { getGroupDir } from '../group-dir.js';
import { generateAgentToken, revokeGroupTokens } from '../mcp/auth-tokens.js';
import {
  DEFAULT_SANDBOX_STACK,
  MCP_AGENT_TIMEOUT,
  AGENT_CMD,
  PERSISTENT_CLAUDE,
  ENABLE_CODEX_PLAN_MODE,
  ENABLE_RUN_SYSTEM_PROMPT_TRANSCRIPTS,
  DATA_DIR,
  PROJECT_ROOT,
  RUN_POLL_INTERVAL,
  STALL_PID_EXTENSION_MS,
  STALL_PID_MAX_EXTENSIONS,
  STALL_SUBAGENT_MAX_PAUSE_MS,
  STALL_TIMEOUT_MS,
  STALL_GRACE_MS,
  STALL_WRITE_DEBOUNCE_MS,
} from '../config.js';
import { getAgentPermissionsResolved } from '../mcp/auth.js';
import { logger } from '../logger.js';
import { admitLaunch, holdInstances } from './idle-restart.js';
import { admitRun } from './run-admission.js';
import { getObjective } from '../modules/objectives/db-objectives.js';
import { outputTranscriptPath, chatTranscriptPath } from '../group-dir.js';
import {
  type PinnedDir,
  lstatGroupPathSync,
  openFileAtSync,
  openGroupDirSync,
  openTrustedDirSync,
  writeFileAtSync,
} from '../lib/group-fs.js';
import {
  isNumericPid,
  openIpcDirOrNullSync,
  openIpcDirSync,
  forEachIpcLineSync,
  readIpcTextSync,
  removeIpcDirSync,
  removeIpcTreeSync,
  writeIpcFileSync,
} from '../lib/ipc-fs.js';
import { getSandboxClient, SandboxClient } from '../lib/mcp-client.js';
import {
  effectiveMaxParallel,
  RegisteredGroup,
  type EffectiveSandboxSettings,
} from '../types.js';
import { ActiveRun } from '../modules/kanban/execution/types.js';
import { buildSandboxEnv } from './sandbox-env.js';
import { isSandboxRunning, runningStackNamesForInstance } from './status.js';
import {
  interruptSandboxChatRuns,
  interruptSandboxTaskRuns,
} from './run-interruption.js';
import { refreshBrainPortCache } from '../modules/objectives/brain-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import { getOnDemandSandboxes } from '../lib/on-demand-sandboxes.js';
import {
  getGroupStages,
  findStage,
  resolveStageForTask,
} from '../modules/kanban/stages.js';
import {
  insertActiveRun,
  getActiveRunForOwnerInstance,
  getActiveChatRunsForGroup,
  getActiveRunForTask,
  getActiveChatRunsForConversation,
  getActiveRunById,
  completeActiveRun,
  updateRunStats,
  getTask,
  updateTask,
  updateConversationWorktreePath,
  type RunTokenStats,
} from '../db.js';
import {
  appendTaskMessage,
  appendRunStartMarker,
} from '../modules/transcripts/transcript-store.js';
import {
  appendCarapaRunV1ToTranscript,
  carapaRunV1Paths,
  lastCarapaRunV1TerminalEvent,
  parseCarapaRunV1EventText,
  type CarapaRunV1Event,
  type CarapaRunV1Summary,
  createCarapaRunV1StreamState,
  emitCarapaRunV1Lines,
  ensureCarapaRunV1Terminal,
  parseCarapaRunV1Manifest,
  createCarapaRunV1SummaryCollector,
  summarizeCarapaRunV1,
} from '../modules/transcripts/carapa-run-v1.js';
import {
  appendTranscriptLines,
  initializeTranscriptSpoolSync,
  moveTranscriptSync,
  withTranscriptLockHeld,
} from '../modules/transcripts/transcript-append-service.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { ReviewDeferredError } from '../modules/kanban/task/testing.js';
import { withTaskWorktreePreparation } from '../modules/kanban/task/worktree-preparation.js';
import { firePushNotification } from '../modules/tools/push-tools.js';
import { processTranscriptMemory } from '../modules/memory/tool-reflector.js';
import { computeWorkspaceRoot } from '../modules/fs/sandbox-fs.js';
import {
  extractGeneratedImageArtifacts,
  type GeneratedImageArtifact,
} from '../modules/image-generation/artifacts.js';
import type { ChatAgentOption } from '../lib/chat-agents.js';
import {
  assertRuntimeAllowed,
  PrivacyRefusal,
  type PrivacyPurpose,
} from '../lib/privacy-policy.js';

import type { ChunkData } from '../stream/parsers.js';
import {
  applyRunMetrics,
  readRunMetrics,
  type RunMetrics,
} from '../stream/run-metrics.js';
import {
  calculateTelemetryCostUsd,
  getModelPricingConfig,
} from '../lib/model-pricing.js';
import {
  acquireGroupSlot,
  sandboxInstanceName,
} from '../concurrency/semaphore.js';
import { withProjectGitLock } from '../lib/git-ops.js';
import {
  acquireSharedCheckoutLease,
  type SharedCheckoutLease,
} from '../concurrency/shared-checkout-lease.js';
import { getGroupByFolder, registeredGroups } from '../state-manager.js';
import {
  updateLastEventAt,
  getActiveRunByInstance,
} from '../db/active-runs.js';
import {
  registerStallControl,
  resumeRunStallWatchdog,
  unregisterStallControl,
} from './stall-registry.js';
import { countSandboxRestartHolds } from './restart-holds.js';
import {
  effectiveContainerGroupDir,
  effectiveGitArgs,
  effectiveRemoteUrl,
  effectiveRunSandboxStack,
  resolveEffectiveSandbox,
} from './effective-settings.js';
import {
  ISOLATED_WORKTREE_REQUIRED_ERROR,
  branchCheckoutStateIsSafe,
  dependencyCommitMissingMessage,
  prepareDirectTaskCheckout,
  recoverExistingWorktreePath,
} from './direct-checkout.js';
import { sleep } from '../lib/async.js';

/** Signals an idle-timeout kill, distinct from the wall-clock hard timeout. */
export class StalledError extends Error {
  readonly stalledForMs: number;
  constructor(message: string, stalledForMs: number) {
    super(message);
    this.name = 'StalledError';
    this.stalledForMs = stalledForMs;
  }
}

/**
 * Open the agent-writable run directory pinned (no link followed). Null when it
 * is missing or was swapped for a link; a swap is logged. Caller closes it.
 */
function openRunDirPinned(hostDir: string): PinnedDir | null {
  return openIpcDirOrNullSync(hostDir);
}

/** Write a board marker into the run directory `hostDir`; throws when it cannot be opened. */
function writeRunMarkerSync(hostDir: string, name: string, data: string): void {
  const dir = openIpcDirSync(hostDir);
  if (!dir) throw new Error(`Run directory missing: ${hostDir}`);
  try {
    writeIpcFileSync(dir, name, data);
  } finally {
    dir.closeSync();
  }
}

export function isStoppedSandboxServiceError(output: string): boolean {
  return /\bservice\s+(?:"[^"]+"|'[^']+'|\S+)\s+is not running\b/i.test(output);
}

/** Wires the idle-based watchdog into a waitForRun() invocation. */
export interface StallOpts {
  runId: string;
  stallMs: number;
  graceMs: number;
  pidExtensionMs?: number;
  maxPidExtensions?: number;
  /**
   * Longest time the watchdog stays paused while the run reports running
   * background tasks/subagents. Unset or 0 disables the pause.
   */
  subagentMaxPauseMs?: number;
  isPidAlive?: (pid: string) => Promise<boolean>;
  /** Called when the agent has been silent for stallMs; UI can show a warning. */
  onWarn: (graceMs: number) => void;
  /** Called when output resumes or the run enters an expected input wait. */
  onClear?: () => void;
  /** Called the instant the grace period expires and the kill is about to fire. */
  onKill: (stalledForMs: number) => void;
  /** Closes a Codex Plan turn and resolves true only once board control succeeds. */
  onUserInputRequest?: () => Promise<boolean> | boolean | void;
}

export function buildPidAliveProbe(
  client: SandboxClient,
  stack: string,
  service: string,
  instance?: string | null,
): (pid: string) => Promise<boolean> {
  return async (pid: string) => {
    if (!/^\d+$/.test(pid)) return false;
    try {
      const res = await client.sandboxExec(
        stack,
        service,
        `agent-status.sh ${pid}`,
        {
          instance: instance ?? undefined,
          timeout: 5,
        },
      );
      if (res.isError) return false;
      const match = /kill0_exit=(\d+)/.exec(res.stdout);
      return match?.[1] === '0';
    } catch (err) {
      logger.debug(
        { stack, service, instance, pid, err },
        'stall watchdog PID liveness probe failed',
      );
      return false;
    }
  };
}

/**
 * Resolve effective stall thresholds for a run. Order:
 *   1. Per-stage override (stages[].stallTimeoutMs / stallGraceMs)
 *   2. Env default (STALL_TIMEOUT_MS / STALL_GRACE_MS)
 *
 * Chat runs (no task_id) skip stage lookup and use env defaults.
 */
async function resolveStallConfig(
  group: RegisteredGroup,
  task_id: string | undefined,
): Promise<{ stallMs: number; graceMs: number }> {
  let stallMs = STALL_TIMEOUT_MS;
  let graceMs = STALL_GRACE_MS;
  if (task_id) {
    try {
      const task = await getTask(task_id);
      if (task) {
        const stage = resolveStageForTask(
          group,
          task.status,
          task.stageVariant,
        );
        if (stage?.inactive) return { stallMs, graceMs };
        if (stage?.stallTimeoutMs && stage.stallTimeoutMs > 0) {
          stallMs = stage.stallTimeoutMs;
        }
        if (stage?.stallGraceMs && stage.stallGraceMs > 0) {
          graceMs = stage.stallGraceMs;
        }
      }
    } catch {
      // best-effort; fall back to env defaults
    }
  }
  return { stallMs, graceMs };
}

/** Build a StallOpts whose onWarn/onKill emit access-controlled WS events. */
export function buildStallOpts(
  runId: string,
  group_folder: string,
  task_id: string | undefined,
  conversation_id: string | undefined,
  stallMs: number,
  graceMs: number,
  pidProbe?: (pid: string) => Promise<boolean>,
): StallOpts {
  return {
    runId,
    stallMs,
    graceMs,
    pidExtensionMs:
      STALL_PID_EXTENSION_MS > 0 ? STALL_PID_EXTENSION_MS : stallMs,
    maxPidExtensions: STALL_PID_MAX_EXTENSIONS,
    subagentMaxPauseMs: STALL_SUBAGENT_MAX_PAUSE_MS,
    isPidAlive: pidProbe,
    onWarn: (g) => {
      broadcast({
        type: 'run_stalled_warning',
        payload: {
          runId,
          taskId: task_id ?? null,
          conversationId: conversation_id ?? null,
          folder: group_folder,
          graceMs: g,
          stalledSince: new Date(Date.now() - stallMs).toISOString(),
        },
      });
    },
    onClear: () => {
      broadcast({
        type: 'run_stall_cleared',
        payload: {
          runId,
          taskId: task_id ?? null,
          conversationId: conversation_id ?? null,
          folder: group_folder,
        },
      });
    },
    onKill: (stalledForMs) => {
      broadcast({
        type: 'run_killed_stalled',
        payload: {
          runId,
          taskId: task_id ?? null,
          conversationId: conversation_id ?? null,
          folder: group_folder,
          stalledForMs,
        },
      });
    },
  };
}

// ─── Re-export types ────────────────────────────────────────────────────────

/** Dependency task (id and title) that required a given commit. */
type DependencyByCommit = Record<string, { id: string; title: string }>;

export interface ContainerInput {
  prompt: string;
  /** Fallback prompt used when retrying without a session (e.g. session expired after restart).
   * Should include full conversation history so the agent has context even without --resume. */
  fallbackPrompt?: string;
  session_id?: string;
  group_folder: string;
  chat_jid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  fallback_model?: string;
  /** Materialized normalized reasoning. Null explicitly suppresses a catalog fallback. */
  reasoning_effort?: string | null;
  fallback_reasoning_effort?: string | null;
  env?: Record<string, string>;
  agent_cmd?: string; // override AGENT_CMD (e.g. 'codex', 'claude-llama.sh')
  /** Fully materialized runtime settings for an explicitly selected binding. */
  runtimeConfig?: ChatAgentOption;
  /** Runtime whose locality governs this run under the project's privacy mode.
   * Takes precedence over `runtimeConfig`; with neither set the run is treated
   * as remote and refused when the mode requires local execution. */
  privacyRuntime?: ChatAgentOption;
  /** Privacy purpose for this run. Defaults to `chat` for chat runs, else `agent`. */
  privacyPurpose?: PrivacyPurpose;
  /** Stable display/transcript identity when it differs from the executable. */
  transcript_agent_name?: string;
  /** Provider-aware owner of a native session (for example codex@relay). */
  session_agent_key?: string;
  agent?: string; // CLI subagent name (e.g. Claude Code --agent <name>)
  bare?: boolean; // Claude Code only: pass --bare (skip CLAUDE.md/auto-memory/skills/hooks context)
  sandbox?: string; // override sandbox stack (worker only; orchestrator always uses global default)
  systemPrompt?: string; // passed via --system-prompt to the agent
  /** Composer mode active for this chat bootstrap (ask/plan/code/debug). */
  chat_mode?: string | null;
  /** Claude prompt-cache lifetime chosen for the conversation ('1h'). */
  prompt_cache_ttl?: string;
  scheduled_task_id?: string;
  task_id?: string;
  stage_id?: string;
  /** Exact stale active run intentionally replaced by boot recovery. */
  restartRecoveryRunId?: string;
  /** Durable restart-continuation row inserted before asynchronous setup. */
  precreatedActiveRunId?: string;
  /** Configured executable stage persisted for restart recovery when stage_id
   * carries a diagnostic sub-run label (for example a format-repair attempt). */
  activeRunStageId?: string;
  maxParallelWorktrees?: number;
  /** Explicit task execution may acquire an isolated lease beyond the automatic cap. */
  manualParallelismOverride?: boolean;
  /** Fail closed instead of falling back to the shared checkout when no
   * isolated worktree could be prepared (A/B experiment cards). */
  requireIsolatedWorktree?: boolean;
  /** Override container timeout in seconds (takes priority over MCP_AGENT_TIMEOUT). */
  timeout?: number;
  /** Called once a sandbox slot has been acquired and execution is about to begin. */
  onSlotAcquired?: (runId: string) => void | Promise<void>;
  /** Called after the sandbox service and requested checkout are ready, but
   * before the active run is recorded or an agent process is launched. The
   * callback may enrich the final prompt/env from the live checkout. */
  onCheckoutReady?: (
    input: ContainerInput,
    target?: SandboxExecutionTarget,
  ) => void | Promise<void>;
  /** Called after each active_runs row is inserted, including a fresh retry
   * that replaces an unresumable native session. */
  onActiveRunCreated?: (runId: string) => void | Promise<void>;
  /** Called after each harness process launches successfully, including a
   * fresh process that replaces an unresumable session attempt. */
  onRunLaunched?: (runId: string) => void | Promise<void>;
  /** Called at the prompt-consuming launch boundary, before terminal output is
   * awaited. A fresh retry receives a new assignment. */
  onPromptRunAssigned?: (runId: string) => void | Promise<void>;
  /** Called only after the assigned process is durably marked completed.
   * Failures are retried by task steering reconciliation from that marker. */
  onPromptRunAccepted?: (runId: string) => void | Promise<void>;
  /** AbortSignal to cancel the run early (e.g. user stop). */
  signal?: AbortSignal;
  /** Original user message before context injection (for transcript). */
  rawMessage?: string;
  /** Leading slash command typed by the user in a chat run. Written to the run
   * dir as `user-command.txt`; the runtime decides whether to forward it. */
  userCommand?: string;
  /** Skip automatic transcript memory for this run (the caller handles it). */
  skipTranscriptMemory?: boolean;
  /** Do not archive prompt/output into chat or per-run transcripts. */
  ephemeral?: boolean;
  /** Return the raw provider JSONL to the caller before ephemeral cleanup. */
  captureTranscript?: boolean;
  /** Conversation ID for web-chat runs — used for stable transcript naming and session isolation. */
  conversation_id?: string;
  /** Ask whose own turn this run executes. */
  agent_ask_id?: string;
  /** Durable main-persona generation selecting a persistent chat session. */
  main_persona_generation?: number;
  /** Instruction revision of a persona-scoped warm session. */
  persona_session_revision?: string;
  /** Conversation owning the checkout, independent of transcript ownership. */
  checkoutConversationId?: string;
  /** Branch to checkout/create in the sandbox before running the agent. */
  branch_name?: string;
  /** Base branch to cut the new branch from (defaults to group defaultBranch). Used for linear task chains. */
  branchBaseName?: string;
  /** Exact commit to use when creating a dependent branch or worktree. */
  branchBaseCommit?: string;
  /** Resolve dependency lineage after the sandbox is running and its default
   * branch has been synchronized. This hook stays inside Board. */
  prepareCheckout?: () => Promise<{
    branchBaseName?: string;
    branchBaseCommit?: string;
    requiredDependencyCommits?: string[];
    dependencyByCommit?: DependencyByCommit;
  }>;
  /** Conversation requested its own worktree, even when project task mode differs. */
  worktreeRequested?: boolean;
  requiredDependencyCommits?: string[];
  /** Dependency task each required commit came from, for launch error text. */
  dependencyByCommit?: DependencyByCommit;
  /** Reuse an existing task worktree without fetching/pulling the default checkout. */
  skipBaseBranchSync?: boolean;
  /** Host-side worktree path for this task (overrides LOCAL_REPO in sandbox env). */
  worktree_path?: string;
  /** Skip the project-wide checkout lease when the caller owns checkout safety
   * or the run is guaranteed to stay inside an isolated worktree. */
  skipSharedCheckoutLease?: boolean;
  /** Host-side LOCAL_REPO path (needed to create worktrees after sandbox starts). */
  localRepo?: string;
  /** Files to symlink from main repo into new worktree (e.g. ['.env']). */
  worktreeFiles?: string[];
  /** When true, passes --fork-session alongside --resume to create a new branched session. */
  forkSession?: boolean;
  /** Override the working directory inside the container (relative to /workspace). */
  work_dir?: string;
  /** Set when `work_dir` was derived from this objective rather than given. */
  objective_work_dir_of?: string;
  /**
   * When false, omit the AGENT_CONTEXT prefix (session continuation).
   * Defaults to true unless `session_id` is set (or `forkSession` forces a fresh branch).
   */
  injectAgentContext?: boolean;
  /** DirectLLM-only exact tool allowlist for constrained internal jobs. */
  allowedToolNames?: string[];
  /** Immutable human attribution copied into the active run row. */
  triggeredByUserId?: string | null;
  triggerSource?: import('../modules/kanban/types.js').TriggerSource;
  /** Internal immutable active-run identity forwarded into agent tool context. */
  run_id?: string;
}

/** Exact CarapaBox target selected for a running sandbox invocation. */
export interface SandboxExecutionTarget {
  stack: string;
  service: string;
  instance: string;
}

/** Harness-side receipt written after a restart continuation is accepted. */
export const RESTART_RECOVERY_DISPATCH_RECEIPT = '.restart-recovery-dispatched';

async function insertActiveRunForLaunch(
  input: ContainerInput,
  run: ActiveRun,
): Promise<void> {
  if (!input.precreatedActiveRunId)
    await insertActiveRun({ ...run, agent_ask_id: input.agent_ask_id });
}

/**
 * Resolve the task concurrency limit at the runner boundary. Callers such as
 * scheduled-task execution do not provide maxParallelWorktrees in their
 * input, so falling back to 1 here would ignore the project's configured
 * worktree capacity.
 */
export function getTaskSlotLimit(group: RegisteredGroup): number {
  return effectiveMaxParallel(group.settings);
}

/** Resolve an agent cwd without changing the legacy standalone layout. */
export function resolveAgentWorkDir(
  effective: Pick<EffectiveSandboxSettings, 'inherited' | 'workspaceRoot'>,
  input: Pick<ContainerInput, 'worktree_path' | 'branch_name' | 'work_dir'>,
): string | undefined {
  if (!effective.inherited) {
    return input.worktree_path
      ? `.worktrees/${input.branch_name}`
      : input.work_dir || undefined;
  }
  if (input.worktree_path) {
    return path.posix.join(
      effective.workspaceRoot,
      '.worktrees',
      input.branch_name || path.posix.basename(input.worktree_path),
    );
  }
  if (!input.work_dir) return effective.workspaceRoot;
  return path.posix.isAbsolute(input.work_dir)
    ? path.posix.normalize(input.work_dir)
    : path.posix.join(effective.workspaceRoot, input.work_dir);
}

/** Identity carried by one agent process, independent of its container owner. */
export async function buildRunTokenScope(
  group: RegisteredGroup,
  input: Pick<ContainerInput, 'task_id' | 'conversation_id' | 'run_id'>,
  allGroups: Record<string, RegisteredGroup> = registeredGroups,
) {
  return {
    group_folder: group.folder,
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.conversation_id
      ? { conversation_id: input.conversation_id }
      : {}),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    permissions: await getAgentPermissionsResolved(group, allGroups),
  };
}

/** Mint a token whose immutable identity matches one concrete active run. */
export async function mintRunScopedAgentToken(
  group: RegisteredGroup,
  input: Pick<ContainerInput, 'task_id' | 'conversation_id' | 'run_id'>,
  runId: string,
): Promise<string> {
  return generateAgentToken(
    await buildRunTokenScope(group, { ...input, run_id: runId }),
  );
}

export function resolveDirectReasoningEffort(
  input: Pick<ContainerInput, 'reasoning_effort'>,
  catalogAgent?: { reasoning_effort?: string },
): string | undefined {
  if (input.reasoning_effort === null) return undefined;
  return input.reasoning_effort ?? catalogAgent?.reasoning_effort;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  stoppedByUser?: boolean;
  newSessionId?: string;
  error?: string;
  transcriptTarget?: string;
  transcriptOffset?: number;
  workspaceRoot?: string;
  sandboxInstance?: string;
  total_tokens?: number;
  tok_output?: number;
  tok_input?: number;
  inputTokenSemantics?: 'fresh' | 'total';
  tok_cache_write?: number;
  tok_cache_read?: number;
  tok_context_last?: number;
  tok_reasoning?: number;
  model_name?: string;
  usageSource?: 'reported' | 'estimated';
  rawUsage?: Record<string, number>;
  cache_ttl_s?: number;
  tool_usage_count?: number;
  cost_usd?: number;
  prompt_dispatched_at_ms?: number;
  first_output_at_ms?: number;
  time_to_first_output_ms?: number;
  sandbox_instance?: string;
  uuid?: string;
  /** Board-owned active_runs identifier; distinct from the provider UUID. */
  activeRunId?: string;
  duration?: number;
  generatedArtifacts?: GeneratedImageArtifact[];
  rawTranscript?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

// ─── Process-level state ────────────────────────────────────────────────────

/**
 * Abort controllers for active chat (non-task) runs, keyed by a
 * conversation-scoped key built by chatAbortKey().
 * Used to immediately cancel waitForRun when the stop endpoint is called.
 */
export const chatRunAbortControllers = new Map<string, AbortController>();

/** Abort reason for a task run that outlived its stage-handoff grace period.
 * The board ends such a run with a clean stop, so it is a successful stage
 * boundary rather than a kill. */
export const STAGE_HANDOFF_TIMEOUT_ABORT_REASON = 'stage_handoff_timeout';

function isStopAbort(signal: AbortSignal | undefined): signal is AbortSignal {
  return (
    !!signal?.aborted && signal.reason !== STAGE_HANDOFF_TIMEOUT_ABORT_REASON
  );
}

/**
 * Chat runs whose user Stop is still ending the agent, keyed like
 * `chatRunAbortControllers`. Resolves to the ids of the runs the stop handler
 * already ended (gracefully, or by its hard-kill fallback), so the run's own
 * abort handler does not kill the agent a second time and defeat the graceful
 * interrupt that keeps the warm session alive.
 */
const userStopsInProgress = new Map<string, Promise<Set<string>>>();

/** Atomically reserve an idle in-process chat slot without replacing its owner. */
export function tryClaimChatRunAbortController(
  key: string,
  controller: AbortController,
): boolean {
  if (chatRunAbortControllers.has(key)) return false;
  chatRunAbortControllers.set(key, controller);
  return true;
}

/** Build a conversation-scoped key for the abort controller map. */
export function chatAbortKey(
  group_folder: string,
  conversation_id?: string,
  chat_jid?: string,
): string {
  if (conversation_id) return `${group_folder}:conv:${conversation_id}`;
  if (chat_jid) return `${group_folder}:jid:${chat_jid}`;
  return group_folder;
}

/** Strip malformed trailing provider suffixes (e.g. `kimi-k2.7-code:cloud/.`). */
function sanitizeAgentModel(model?: string): string {
  if (!model) return '';
  return model.trim().replace(/[/.]+$/, '');
}

/**
 * Stable short tag distinguishing persistent-process variants within one
 * conversation: the agent binary (claude vs codex — they must never share a
 * warm daemon/session dir) plus backend variants that share an `agentCmd` but
 * differ by `model` + `env` (claude / claude-ollama / claude-llama / … and any
 * codex variants). A warm process binds agent+model+env at creation, so this is
 * folded into the conversation key: same variant ⇒ same key ⇒ stays warm;
 * switching agent or backend within a conversation ⇒ different key ⇒ its own
 * correctly-configured daemon. FNV-1a (deterministic, no crypto dep — input
 * space is a few agent configs).
 */
export function persistentVariantTag(
  agentCmd?: string,
  model?: string,
  env?: Record<string, string>,
  worktreePath?: string,
): string {
  const identity: unknown[] = [
    agentCmd || '',
    model || '',
    Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ];
  // Preserve existing non-worktree keys while ensuring a warm process is
  // never reused after its conversation moves to a different working tree.
  if (worktreePath) identity.push(worktreePath);
  const stable = JSON.stringify(identity);
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Task-persistent runtime contract shared with restart recovery.
 *
 * CarapaBox's warm ACP launchers append their raw JSON-RPC stream to the
 * canonical `*-acp.out` file. Keep eligibility and artifact discovery tied to
 * this manifest so adding a task-persistent runtime cannot silently omit its
 * surviving turn from Board recovery.
 */
export const TASK_PERSISTENT_RUNTIME_CONTRACT = [
  {
    agentCmd: 'antigravity-acp',
    warmOutputFile: 'antigravity-acp.out',
  },
  {
    agentCmd: 'cursor-acp',
    warmOutputFile: 'cursor-acp.out',
  },
  {
    agentCmd: 'hermes-acp',
    warmOutputFile: 'hermes-acp.out',
  },
  {
    agentCmd: 'muse-acp',
    warmOutputFile: 'muse-acp.out',
  },
  {
    agentCmd: 'grok-acp',
    warmOutputFile: 'grok-acp.out',
  },
  {
    agentCmd: 'vibe-acp',
    warmOutputFile: 'vibe-acp.out',
  },
  {
    agentCmd: 'omp-acp',
    warmOutputFile: 'omp-acp.out',
  },
  {
    agentCmd: 'prime-agent-acp',
    warmOutputFile: 'prime-agent-acp.out',
  },
] as const;

const ACP_AGENT_COMMANDS = new Set<string>(
  TASK_PERSISTENT_RUNTIME_CONTRACT.map((runtime) => runtime.agentCmd),
);
const WARM_CHAT_AGENT_COMMANDS = new Set([...ACP_AGENT_COMMANDS, 'pi']);

/**
 * Resolve ownership for a warm agent process. Chat owns a session per
 * conversation and runtime variant. Kanban owns an ACP session per task,
 * active stage, and runtime variant so a rejected review can return to the
 * same coding process. Testing/review deliberately remain isolated runs.
 */
export function resolvePersistentSessionScope(input: {
  enabled: boolean;
  agentCmd: string;
  taskId?: string;
  conversationId?: string;
  worktreePath?: string;
  stageId?: string;
  stageType?: string;
  model?: string;
  env?: Record<string, string>;
  mainPersonaGeneration?: number;
  personaSessionRevision?: string;
}): { eligible: boolean; key?: string } {
  if (!input.enabled) return { eligible: false };

  const variant = persistentVariantTag(
    input.agentCmd,
    input.model,
    input.env,
    input.worktreePath,
  );
  if (input.taskId) {
    if (
      input.stageType === 'active' &&
      input.stageId &&
      ACP_AGENT_COMMANDS.has(input.agentCmd)
    ) {
      return {
        eligible: true,
        key: `task-${input.taskId}-${input.stageId}-${variant}`,
      };
    }
    return { eligible: false };
  }

  if (
    input.conversationId &&
    (input.agentCmd === 'claude' ||
      input.agentCmd === 'codex' ||
      input.agentCmd === 'agy-sdk' ||
      WARM_CHAT_AGENT_COMMANDS.has(input.agentCmd))
  ) {
    return {
      eligible: true,
      key: [
        input.conversationId,
        input.mainPersonaGeneration ? `g${input.mainPersonaGeneration}` : '',
        // A warm process binds its instructions at creation. Personas whose
        // instructions change without a main-persona generation (invited
        // participants) get a distinct process per instruction revision.
        input.personaSessionRevision ? `p${input.personaSessionRevision}` : '',
        variant,
      ]
        .filter(Boolean)
        .join('-'),
    };
  }

  return { eligible: false };
}

/**
 * Run IDs created by the current process. Used to distinguish "our" runs from
 * orphaned runs left by a previous process (which are candidates for adoption).
 */
const currentProcessRunIds = new Set<string>();

/** Check if a run ID belongs to the current process (i.e. is actively managed). */
export function isCurrentProcessRun(runId: string): boolean {
  return currentProcessRunIds.has(runId);
}

/** Mark a run as owned by the current process (prevents adoption by other code paths). */
export function markCurrentProcessRun(runId: string): void {
  currentProcessRunIds.add(runId);
}

/** Unmark a run from the current process tracking set. */
export function unmarkCurrentProcessRun(runId: string): void {
  currentProcessRunIds.delete(runId);
}

/**
 * No-op cleanup — MCP sandboxes are managed by the sandbox server.
 */
export function cleanupProcesses(): void {
  // Nothing to clean up — we don't own the sandbox containers
}

// ─── Path helpers ───────────────────────────────────────────────────────────

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Host-side IPC root for a group instance.
 * Must match the IPC mount source: ${IPC_MOUNT}/${COMPOSE_PROJECT_NAME}
 * where COMPOSE_PROJECT_NAME = {stack}-{instance}.
 * When instance is omitted, defaults to group_folder (slot 0).
 * When stack is omitted, defaults to DEFAULT_SANDBOX_STACK (carapa-bot). */
export function hostIpcDir(
  group_folder: string,
  instance?: string,
  stack?: string,
): string {
  return path.join(
    DATA_DIR,
    'ipc',
    `${stack || DEFAULT_SANDBOX_STACK}-${instance ?? group_folder}`,
  );
}

/** Get the host-side path for a run's directory */
function hostRunDir(
  group_folder: string,
  runId: string,
  instance?: string,
  stack?: string,
): string {
  return path.join(hostIpcDir(group_folder, instance, stack), 'runs', runId);
}

/**
 * Resolve the host-side run directory for an active_run record.
 * Uses sandbox_stack + sandbox_instance from the DB row.
 * Falls back to scanning all IPC subdirectories if the direct path doesn't exist.
 */
export function resolveHostRunDir(run: {
  id: string;
  group_folder: string;
  sandbox_stack: string;
  sandbox_instance: string | null;
}): string | null {
  // Primary: use stored stack + instance
  const primary = hostRunDir(
    run.group_folder,
    run.id,
    run.sandbox_instance ?? undefined,
    run.sandbox_stack,
  );
  if (fs.existsSync(primary)) return primary;

  // Fallback: scan all IPC subdirectories for this run ID
  const ipcBase = path.join(DATA_DIR, 'ipc');
  try {
    for (const dir of fs.readdirSync(ipcBase)) {
      const candidate = path.join(ipcBase, dir, 'runs', run.id);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* ipc dir may not exist */
  }

  return null;
}

/** Get the sandbox-side path for a run's directory.
 * group_folder is now encoded in the per-instance IPC mount, so the
 * path inside the container is simply /workspace/ipc/runs/{runId}. */
function sandboxRunDir(runId: string): string {
  return `/workspace/ipc/runs/${runId}`;
}

/** Resolve a project-namespaced upload into a flat, run-local attachment copy. */
export function resolveRunAttachmentCopy(
  hostDir: string,
  ipcDir: string,
  uploadRelativePath: string,
): { srcFile: string; dstFile: string; filename: string } | null {
  const normalized = path.posix.normalize(uploadRelativePath);
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null;
  }
  const filename = path.posix.basename(normalized);
  return {
    srcFile: path.join(ipcDir, 'uploads', normalized),
    dstFile: path.join(hostDir, filename),
    filename,
  };
}

// ─── Sandbox pool reconciliation ────────────────────────────────────────────

/**
 * Reconcile the sandbox instance for a project after parallelism changes.
 * Single container per project — just ensures the default instance is running.
 * Parallelism is achieved via worktrees inside the single container.
 */
export async function reconcileSandboxPool(
  group: RegisteredGroup,
): Promise<void> {
  // Single container per project — just ensure the default instance is running.
  // Parallelism is achieved via worktrees inside the single container, not multiple instances.
  const client = getSandboxClient();
  const effective = resolveEffectiveSandbox(group);
  const { stack, instance, service } = effective;
  if (!effective.managed || effective.inherited) return;
  const authGroup = effective.owner;

  const sbStatus = await client.sandboxStatus(stack, instance, service);
  const isRunning = isSandboxRunning(sbStatus);

  if (!isRunning) {
    const buildEnv = () => buildSandboxEnv(authGroup, stack);
    logger.info({ stack, instance }, 'Reconcile: starting sandbox');

    await revokeGroupTokens(authGroup.folder);
    // Sandbox-level token (no TTL): a per-user main's reachable-project list is
    // re-scoped in place on membership changes (see main-reach-sync).
    const perms = await getAgentPermissionsResolved(
      authGroup,
      registeredGroups,
    );
    const token = await generateAgentToken(
      {
        group_folder: authGroup.folder,
        permissions: perms,
      },
      null,
    );

    const env = { ...buildEnv(), CARAPA_BOARD_API_TOKEN: token };
    const startResult = await client.sandboxStart(
      stack,
      env,
      instance,
      service,
    );
    if (startResult.isError) {
      logger.error(
        { stack, instance, error: startResult.stdout },
        'Reconcile: failed to start sandbox',
      );
    }
  }
}

/**
 * Reconcile a running sandbox after mount-affecting project settings changed
 * (extraMounts, workspace path, host location, ...). Docker/gVisor cannot add
 * or rebind mounts on a running container, so the only way the new layout
 * takes effect is a container recreation with a fresh env.
 *
 * Idle managed sandboxes are restarted in the background (the same sequence
 * as POST /api/sandbox/:stack/restart) while the instance is held against new
 * run admission. Sandboxes with active runs or a
 * restart hold (`restart-hold`) are left alone — killing them would drop the
 * in-flight work — and the UI is told a manual restart is required. Fixed/external instances and inherited
 * children are never touched here.
 */
export async function reconcileSandboxMounts(
  group: RegisteredGroup,
  changedKeys: readonly string[],
): Promise<void> {
  const effective = resolveEffectiveSandbox(group);
  if (!effective.managed || effective.inherited || effective.owner !== group)
    return;
  const { stack, instance, service, owner } = effective;
  const client = getSandboxClient();

  const sbStatus = await client.sandboxStatus(stack, instance, service);
  if (!isSandboxRunning(sbStatus)) {
    // Next start (by anything the board orchestrates) sends the fresh env.
    return;
  }

  const notifyMountRestartRequired = (reason: string): void =>
    broadcast({
      type: 'sandbox_status',
      payload: {
        stack,
        instance,
        group: owner.folder,
        action: 'restart_required',
        error: `${reason} Restart it to apply the updated workspace mounts (${changedKeys.join(', ')}).`,
      },
    });

  // Hold the instance so no chat or task is admitted between the idle check
  // and the stop; a run admitted earlier has its active_runs row by then.
  const restartIfIdle = async (): Promise<void> => {
    const activeRun = await getActiveRunByInstance(instance);
    const holds = activeRun
      ? 0
      : ((await countSandboxRestartHolds(stack, service, instance)) ?? 0);
    if (activeRun || holds > 0) {
      const busy = activeRun ? 'has active runs' : 'has a restart hold';
      notifyMountRestartRequired(
        `Sandbox "${instance}" ${busy} and cannot be restarted automatically.`,
      );
      logger.warn(
        {
          group: group.folder,
          stack,
          instance,
          active_run: activeRun?.id,
          holds,
          changed: [...changedKeys],
        },
        'Mount settings changed while sandbox is busy; restart required',
      );
      return;
    }

    logger.info(
      { stack, instance, changed: [...changedKeys] },
      'Restarting sandbox to apply updated mount settings',
    );
    broadcast({
      type: 'sandbox_status',
      payload: { stack, instance, action: 'restarting' },
    });
    try {
      // sandbox_ps reports the stack that actually owns this instance; it may
      // differ from the configured defaultSandbox.
      let runningStacks: string[] = [];
      const psResult = await client.sandboxPs(instance);
      if (!psResult.isError) {
        runningStacks = runningStackNamesForInstance(psResult.stdout, instance);
      } else {
        logger.warn(
          { stack, instance, stdoutLength: psResult.stdout.length },
          'Could not discover running sandbox stack; using configured stack',
        );
      }
      const stacksToStop = runningStacks.length > 0 ? runningStacks : [stack];
      for (const runningStack of stacksToStop) {
        await finalizeSandboxBrowsers(runningStack, instance);
        const stopResult = await client.sandboxStop(runningStack, instance);
        if (stopResult.isError) {
          throw new Error(
            `Failed to stop sandbox before restart: ${stopResult.stdout}`,
          );
        }
      }
      await interruptSandboxChatRuns(instance).catch((error) =>
        logger.error(
          { stack, instance, error },
          'Failed to finalize chat runs during mount reconcile',
        ),
      );
      await interruptSandboxTaskRuns(instance, 'restart').catch((error) =>
        logger.error(
          { stack, instance, error },
          'Failed to interrupt task runs during mount reconcile',
        ),
      );
      await getTmuxClient().forgetByInstance(instance);
      await getOnDemandSandboxes().forgetByInstance(instance);
      await refreshBrainPortCache();

      // Pre-create the host-side IPC directory BEFORE the sandbox starts.
      const ipcDir = path.join(DATA_DIR, 'ipc', `${stack}-${instance}`);
      await prepareSandboxIpcRunsDir(ipcDir, client, stack, instance);

      await revokeGroupTokens(owner.folder);
      // Sandbox-level token (no TTL): a per-user main's reachable-project list is
      // re-scoped in place on membership changes (see main-reach-sync).
      const perms = await getAgentPermissionsResolved(owner, registeredGroups);
      const token = await generateAgentToken(
        {
          group_folder: owner.folder,
          permissions: perms,
        },
        null,
      );
      const env = {
        ...buildSandboxEnv(owner, stack),
        CARAPA_BOARD_API_TOKEN: token,
      };
      const result = await client.sandboxStart(stack, env, instance, service);
      if (result.isError) {
        throw new Error(
          result.stdout || 'CarapaBox failed to start the sandbox',
        );
      }

      broadcast({
        type: 'sandbox_status',
        payload: { stack, instance, action: 'restarted', result },
      });
      await refreshBrainPortCache();
      logger.info(
        { stack, instance },
        'Sandbox restarted with updated mount settings',
      );
    } catch (err) {
      logger.error(
        { stack, instance, error: String(err) },
        'Failed to restart sandbox after mount settings change',
      );
      broadcast({
        type: 'sandbox_status',
        payload: {
          stack,
          instance,
          action: 'restart_failed',
          error: String(err),
        },
      });
    }
  };
  try {
    await holdInstances([instance], restartIfIdle);
  } catch (err) {
    // The restart reports its own failures; this is the hold timing out on a
    // run that is still starting, or the idle check itself failing.
    notifyMountRestartRequired(
      `Sandbox "${instance}" could not be held for an automatic restart (${String(err)}).`,
    );
    logger.warn(
      { group: group.folder, stack, instance, error: String(err) },
      'Could not hold sandbox for mount reconcile; restart required',
    );
  }
}

// ─── waitForRun ─────────────────────────────────────────────────────────────

/** Largest tail of a run's event or stderr file materialized in the board. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/** Last `maxBytes` of a file as text; '' when it is missing or empty. */
function readFileTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Tail of a run directory's Run V1 event stream; '' when it has none. */
export function readRunV1EventsTail(runDir: string): string {
  return readFileTail(carapaRunV1Paths(runDir).events, MAX_CAPTURE_BYTES);
}

/**
 * Wait for an agent run to complete by watching files on the host filesystem.
 *
 * The agent writes its Run V1 events to {hostDir}/output.v1.jsonl and on
 * completion writes the exit code to {hostDir}/exit_code. We watch for
 * exit_code using fs.watch() with a fallback poll interval.
 */
export async function waitForRun(
  hostDir: string,
  timeoutMs: number,
  onChunk?: (data: ChunkData) => void,
  signal?: AbortSignal,
  stallOpts?: StallOpts,
  onToolUse?: (
    name: string,
    input: Record<string, unknown>,
    toolId?: string,
  ) => void,
): Promise<{
  /** Tail of the run's V1 event stream (`output.v1.jsonl`); '' when absent. */
  events: string;
  stderr?: string;
  isError: boolean;
  userInputRequest: boolean;
  intentionalUserInputInterrupt: boolean;
  metrics?: RunMetrics | null;
}> {
  // A misbehaving agent (or a tool that dumps a large file) can grow
  // output.v1.jsonl without bound.  Never materialize the whole file in the
  // board process: this function is on the hot path for every task run and
  // the file may be many gigabytes by the time the exit marker is noticed.
  // Keep the tail because the final result and usage/session metadata are
  // written at the end of JSONL output.
  const MAX_STREAM_READ_BYTES = 256 * 1024;
  const v1Paths = carapaRunV1Paths(hostDir);
  const stderrPath = path.join(hostDir, 'agent-stderr.log');
  let metricsContract = 0;
  let agentCmd = '';
  const argsDir = openRunDirPinned(hostDir);
  try {
    const rawArgs = argsDir && readIpcTextSync(argsDir, 'args.json', 1 << 20);
    if (rawArgs) {
      const runArgs = JSON.parse(rawArgs) as {
        metricsContract?: number;
        agentCmd?: string;
      };
      metricsContract = runArgs.metricsContract ?? 0;
      agentCmd = runArgs.agentCmd ?? '';
    }
  } catch {
    // Legacy and synthetic runs have no measurement handshake.
  } finally {
    argsDir?.closeSync();
  }
  const runV1Harness = runV1ConsumerHarness(agentCmd);
  const consumeRunV1 = runV1Harness !== undefined;
  let v1BytesRead = 0;
  let v1PendingBytes = Buffer.alloc(0);
  let v1ActivityBytes = 0;
  let stderrBytesRead = 0;
  let v1ManifestValidated = false;
  // Set when the completion pass completed a manifest-only pair for a run that
  // exited nonzero: the repaired terminal event must not hide the exit code.
  let v1RepairedAfterExit = false;
  // Use the durable spool identity for display ownership too. Provider tool
  // IDs are only unique within one run, and replay projects this same prefix.
  const v1StreamState = createCarapaRunV1StreamState(
    consumeRunV1 ? initializeTranscriptSpoolSync(v1Paths.events) : '',
  );

  return new Promise<{
    events: string;
    stderr?: string;
    isError: boolean;
    userInputRequest: boolean;
    intentionalUserInputInterrupt: boolean;
    metrics?: RunMetrics | null;
  }>((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | null = null;
    // The run directory is a replica of the box-owned IPC tree: keep it hot
    // while this wait is active.
    const stopReplicaWatch = ipcReplica.watchPath(hostDir);
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let streamTimer: ReturnType<typeof setInterval> | null = null;
    // Inactivity timeout: reset whenever new output is detected
    let lastActivityAt = Date.now();
    // Hard absolute deadline: fires regardless of output activity (catches hung processes
    // that keep writing output without making progress, e.g. Claude usage-limit waits)
    const started_at = Date.now();
    // Time spent waiting for a Codex requestUserInput answer is excluded from
    // both timeouts. Only tracked when stallOpts is set: the resume path
    // (stall registry) is registered only then, so without it the wait could
    // never end.
    let inputWaitStartedAt: number | null = null;
    let pausedMs = 0;

    // ─── Stall watchdog (idle-based, complements timeoutMs) ─────────────
    // stallTimer fires after stallMs of silence → onStallTrip emits warning
    // and arms graceTimer; graceTimer fires after graceMs → StalledError.
    // Any new agent output or stderr activity resets both via resetActivity().
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDbWriteAt = 0;
    let stallArmedAt = Date.now();
    let pidExtensionsUsed = 0;
    // The watchdog is paused while either reason holds: a Codex user-input
    // wait, or running background tasks/subagents (capped by
    // stallOpts.subagentMaxPauseMs). One reason ending never resumes a pause
    // the other still needs.
    let stallPaused = false;
    let userInputPaused = false;
    let backgroundTasksPaused = false;
    // Set once the cap fired; cleared when the task list empties, so a hung
    // subagent cannot re-pause the watchdog on every later event.
    let backgroundPauseCapped = false;
    let backgroundPauseTimer: ReturnType<typeof setTimeout> | null = null;
    let stallWarningActive = false;
    let userInputRequestHandled = false;
    let userInputInterruptConfirmation: Promise<boolean> | undefined;

    const armStall = () => {
      if (!stallOpts || stallPaused) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallArmedAt = Date.now();
      stallTimer = setTimeout(() => {
        void onStallTrip();
      }, stallOpts.stallMs);
    };

    const readAgentPid = (): string | null => {
      const dir = openRunDirPinned(hostDir);
      if (!dir) return null;
      try {
        const pid = readIpcTextSync(dir, 'pid', 64)?.trim();
        return pid && isNumericPid(pid) ? pid : null;
      } catch {
        return null;
      } finally {
        dir.closeSync();
      }
    };

    const onStallTrip = async () => {
      if (settled || !stallOpts) return;
      const trippedArmedAt = stallArmedAt;
      const pidExtensionMs = Math.max(0, stallOpts.pidExtensionMs ?? 0);
      const maxPidExtensions = Math.max(0, stallOpts.maxPidExtensions ?? 0);
      if (
        stallOpts.isPidAlive &&
        pidExtensionMs > 0 &&
        pidExtensionsUsed < maxPidExtensions
      ) {
        const pid = readAgentPid();
        const alive = pid ? await stallOpts.isPidAlive(pid) : false;
        if (
          settled ||
          !stallOpts ||
          stallPaused ||
          stallArmedAt !== trippedArmedAt
        ) {
          return;
        }
        if (alive) {
          pidExtensionsUsed += 1;
          stallWarningActive = true;
          stallOpts.onWarn(pidExtensionMs);
          if (stallTimer) clearTimeout(stallTimer);
          stallArmedAt = Date.now();
          stallTimer = setTimeout(() => {
            void onStallTrip();
          }, pidExtensionMs);
          return;
        }
      }
      stallWarningActive = true;
      stallOpts.onWarn(stallOpts.graceMs);
      graceTimer = setTimeout(() => {
        if (settled || !stallOpts) return;
        const stalledForMs = Date.now() - stallArmedAt;
        stallOpts.onKill(stalledForMs);
        // Message starts with "Stalled:" so UI can detect this class of error
        // by prefix (task.error is the persisted signal across reloads).
        fail(
          new StalledError(
            `Stalled: agent silent for ${Math.round(stalledForMs / 1000)}s (idle timeout)`,
            stalledForMs,
          ),
        );
      }, stallOpts.graceMs);
    };

    const resetActivity = () => {
      if (!stallOpts) return;
      if (stallWarningActive) {
        stallWarningActive = false;
        stallOpts.onClear?.();
      }
      pidExtensionsUsed = 0;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (!stallPaused) armStall();
      const now = Date.now();
      if (now - lastDbWriteAt > STALL_WRITE_DEBOUNCE_MS) {
        lastDbWriteAt = now;
        // Fire-and-forget — never block output processing on a DB write.
        void updateLastEventAt(
          stallOpts.runId,
          new Date(now).toISOString(),
        ).catch((err) => {
          logger.debug(
            { err, runId: stallOpts.runId },
            'active-run heartbeat persistence failed',
          );
        });
      }
    };

    const suspendStall = () => {
      if (!stallOpts || stallPaused) return;
      stallPaused = true;
      if (stallWarningActive) {
        stallWarningActive = false;
        stallOpts.onClear?.();
      }
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const pauseStall = () => {
      if (!stallOpts || userInputPaused) return;
      userInputPaused = true;
      suspendStall();
    };

    const resumeStall = () => {
      if (!stallOpts || !userInputPaused) return;
      userInputPaused = false;
      if (inputWaitStartedAt !== null) {
        pausedMs += Date.now() - inputWaitStartedAt;
        inputWaitStartedAt = null;
        lastActivityAt = Date.now();
      }
      if (backgroundTasksPaused) return;
      stallPaused = false;
      resetActivity();
    };

    const clearBackgroundPauseTimer = () => {
      if (backgroundPauseTimer) {
        clearTimeout(backgroundPauseTimer);
        backgroundPauseTimer = null;
      }
    };

    // Fed by the run's latest `background_tasks` list (empty = none running).
    const noteBackgroundTasks = (runningCount: number) => {
      if (!stallOpts || settled) return;
      if (runningCount === 0) {
        backgroundPauseCapped = false;
        clearBackgroundPauseTimer();
        if (!backgroundTasksPaused) return;
        backgroundTasksPaused = false;
        if (userInputPaused) return;
        stallPaused = false;
        resetActivity();
        return;
      }
      const maxPauseMs = stallOpts.subagentMaxPauseMs ?? 0;
      if (backgroundTasksPaused || backgroundPauseCapped || maxPauseMs <= 0) {
        return;
      }
      backgroundTasksPaused = true;
      suspendStall();
      backgroundPauseTimer = setTimeout(() => {
        backgroundPauseTimer = null;
        backgroundTasksPaused = false;
        backgroundPauseCapped = true;
        if (settled || userInputPaused) return;
        stallPaused = false;
        armStall();
      }, maxPauseMs);
    };

    const observeChunk = (chunk: ChunkData) => {
      if (chunk.type === 'background_tasks') {
        noteBackgroundTasks(chunk.tasks.length);
      }
      onChunk?.(chunk);
    };

    const handleUserInputRequest = () => {
      pauseStall();
      if (stallOpts && inputWaitStartedAt === null) {
        inputWaitStartedAt = Date.now();
      }
      if (userInputRequestHandled) return;
      userInputRequestHandled = true;
      userInputInterruptConfirmation = Promise.resolve(
        stallOpts?.onUserInputRequest?.(),
      ).then((confirmed) => confirmed === true);
    };

    if (stallOpts) {
      registerStallControl(stallOpts.runId, {
        reset: resetActivity,
        pause: pauseStall,
        resume: resumeStall,
        interrupt: (reason) => fail(new Error(reason)),
      });
      armStall();
    }

    const cleanup = () => {
      stopReplicaWatch();
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      clearBackgroundPauseTimer();
      if (stallOpts) {
        unregisterStallControl(stallOpts.runId);
      }
    };

    const finish = (result: { stderr?: string; isError: boolean }) => {
      if (settled) return;
      settled = true;
      cleanup();
      const events = readFileTail(v1Paths.events, MAX_CAPTURE_BYTES);
      void (async () => {
        const intentionalUserInputInterrupt =
          userInputRequestHandled &&
          lastCarapaRunV1TerminalEvent(parseCarapaRunV1EventText(events))
            ?.status === 'interrupted' &&
          (await userInputInterruptConfirmation?.catch(() => false)) === true;
        resolve({
          ...result,
          events,
          // Only a successfully acknowledged board interrupt turns this into
          // a normal Plan question boundary.
          userInputRequest: userInputRequestHandled,
          intentionalUserInputInterrupt,
          metrics: readRunMetrics(hostDir),
        });
      })();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const checkCompletion = () => {
      // Hard absolute deadline — fires regardless of output activity.
      // Catches processes that keep writing (e.g. Claude stuck on a usage-limit wait)
      // without ever completing.
      // Both timeouts are suspended while waiting for a user-input answer.
      const waitingForUserInput = inputWaitStartedAt !== null;
      if (
        !waitingForUserInput &&
        Date.now() - started_at - pausedMs > timeoutMs
      ) {
        fail(
          new Error(
            'Agent execution timed out (hard deadline exceeded). ' +
              'The process may be hung waiting for an API response — ' +
              'check if a usage limit (e.g. Claude Max) has been reached.',
          ),
        );
        return;
      }

      // Inactivity timeout: fires if no output/stderr activity arrives for the full timeout period
      if (!waitingForUserInput && Date.now() - lastActivityAt > timeoutMs) {
        fail(
          new Error(
            'Agent execution timed out (no output). ' +
              'The process produced no output — check if a usage limit has been reached ' +
              'or if the sandbox is unreachable.',
          ),
        );
        return;
      }

      // Check if run directory still exists (sandbox may have restarted).
      // A run dir swapped for a link is treated the same way.
      const runDir = openRunDirPinned(hostDir);
      if (!runDir) {
        fail(
          new Error('Run directory disappeared (sandbox may have restarted)'),
        );
        return;
      }

      try {
        // Check for exit_code file
        const rawExit = readIpcTextSync(runDir, 'exit_code', 64)?.trim();
        if (rawExit === undefined) return;
        const exitCode = parseInt(rawExit, 10);
        // The file may be observed in a truncate window: writers use
        // `> exit_code` (O_TRUNC then write), and the persistent (warm)
        // path rewrites it up to 3× in quick succession. An empty/partial
        // read parses to NaN; settling here would (NaN !== 0) flip a
        // succeeded run to an error permanently. Treat it as "not done
        // yet" and let the poll/watch re-read the final value.
        if (rawExit === '' || Number.isNaN(exitCode)) {
          return;
        }
        // Contract v1 publishes this marker atomically only after
        // metrics.json has either been atomically committed or explicitly
        // failed. Ignore the early exit_code writes made by persistent
        // runner paths until measurement has definitively completed.
        if (metricsContract >= 1) {
          const measurementStatus = readIpcTextSync(
            runDir,
            'metrics_complete',
            64,
          )?.trim();
          if (measurementStatus === undefined) return;
          if (measurementStatus !== 'ok') {
            logger.warn(
              { hostDir, measurementStatus },
              'Run completed without canonical metrics',
            );
          }
        }
        // Flush any output that completion raced ahead of. A fast run
        // (esp. a warm persistent turn) can write the full V1 transcript
        // and exit_code within a single poll interval, so checkCompletion
        // fires before streamNewOutput ever emitted incrementally — the
        // result would be parsed/persisted but never streamed to the UI
        // (blank until refresh). Emitting here drains the remaining bytes
        // through onChunk first; v1BytesRead makes it idempotent (no dupes).
        streamNewOutput(true, exitCode);
        if (
          consumeRunV1 &&
          fs.existsSync(v1Paths.events) &&
          (!v1StreamState.terminal || v1RepairedAfterExit)
        ) {
          // Stop can kill the provider between its last delta and its
          // terminal event. Preserve those deltas as an interrupted run;
          // otherwise the streamed answer is rejected during cleanup.
          if (signal?.aborted) {
            settleInterruptedV1Terminal();
          } else if (exitCode !== 0) {
            // The process died mid-run (an out-of-memory kill, a container
            // restart, or a Board reaper writing 137), so name the exit code
            // instead of blaming the transcript.
            throw new Error(
              `${runV1Harness} agent process ended with exit code ${exitCode} before finishing the run` +
                (exitCode === 137
                  ? ' (killed: the sandbox may have run out of memory or restarted, or the run was stopped)'
                  : ''),
            );
          } else {
            throw new Error(
              `${runV1Harness} V1 transcript completed without a terminal run event`,
            );
          }
        }
        const stderr = readFileTail(stderrPath, MAX_CAPTURE_BYTES);
        finish({ stderr, isError: exitCode !== 0 });
      } catch (err) {
        fail(
          err instanceof Error
            ? err
            : new Error(`Failed to read run output: ${err}`),
        );
      } finally {
        runDir.closeSync();
      }
    };

    // Growth of output.v1.jsonl is run activity for every run, including ones
    // whose args.json names no V1 harness to stream.
    const noteOutputActivity = () => {
      try {
        const size = fs.statSync(v1Paths.events).size;
        if (size !== v1ActivityBytes) {
          v1ActivityBytes = size;
          lastActivityAt = Date.now();
          resetActivity();
        }
      } catch {
        // output.v1.jsonl not created yet, or removed — nothing to measure.
      }
    };

    // Stream new Run V1 events to onChunk callers and reset the inactivity
    // timer. The completion pass settles a manifest-only pair after an abort or
    // a nonzero exit, rejects an incomplete pair, and drains every remaining V1
    // byte.
    const streamNewOutput = (completionPass = false, exitCode = 0) => {
      noteOutputActivity();
      if (!consumeRunV1) return;
      const hasV1Events = fs.existsSync(v1Paths.events);
      const hasV1Manifest = fs.existsSync(v1Paths.manifest);
      let runDir: PinnedDir | null = null;
      try {
        if (hasV1Events !== hasV1Manifest) {
          // The runtime atomically writes the manifest before creating the
          // event spool. That short live initialization window is valid;
          // an events-only pair is never valid, nor is either half at exit.
          // The one exception is a stop inside that window: settle the
          // manifest-only pair as an interrupted run instead of failing it.
          // So is a run killed there (OOM, container stop, reaper 137): the
          // caller then names its exit code instead of the incomplete pair.
          if (
            !hasV1Events &&
            completionPass &&
            (signal?.aborted || exitCode !== 0)
          ) {
            v1RepairedAfterExit = !signal?.aborted;
            ensureCarapaRunV1Terminal(v1Paths);
            streamNewOutput(completionPass, exitCode);
            return;
          }
          if (hasV1Events || completionPass) {
            throw new Error(
              `Incomplete ${runV1Harness} V1 transcript pair: events=${hasV1Events}, manifest=${hasV1Manifest}`,
            );
          }
          return;
        }
        if (hasV1Events && hasV1Manifest) {
          // The agent writes this directory: read both files through the
          // pinned run dir, so a link or FIFO planted in their place is
          // refused (a stream failure) instead of followed or blocked on.
          runDir = openRunDirPinned(hostDir);
          if (!runDir) {
            throw new Error(
              `${runV1Harness} run directory disappeared or was replaced while reading its V1 transcript`,
            );
          }
          if (!v1ManifestValidated) {
            const manifest = readIpcTextSync(
              runDir,
              path.basename(v1Paths.manifest),
              RUN_SIDECAR_MAX_BYTES,
              { rejectHardLinks: true },
            );
            if (manifest === null) {
              throw new Error(
                `${runV1Harness} V1 manifest is missing or not a regular file`,
              );
            }
            parseCarapaRunV1Manifest(manifest, runV1Harness);
            v1ManifestValidated = true;
          }
          const stat = fs.statSync(v1Paths.events);
          if (stat.size > v1BytesRead) {
            lastActivityAt = Date.now();
            resetActivity();
            const opened = openFileAtSync(
              runDir,
              path.basename(v1Paths.events),
              { rejectHardLinks: true },
            );
            if (!opened) return;
            const fd = opened.fd;
            try {
              do {
                const unreadBytes = stat.size - v1BytesRead;
                if (unreadBytes <= 0) break;
                const readLength = Math.min(unreadBytes, MAX_STREAM_READ_BYTES);
                const buffer = Buffer.allocUnsafe(readLength);
                const bytesReadNow = fs.readSync(
                  fd,
                  buffer,
                  0,
                  readLength,
                  v1BytesRead,
                );
                if (bytesReadNow <= 0) break;
                v1BytesRead += bytesReadNow;
                const bytes = buffer.subarray(0, bytesReadNow);
                v1PendingBytes = v1PendingBytes.length
                  ? Buffer.concat([v1PendingBytes, bytes])
                  : Buffer.from(bytes);

                let lineStart = 0;
                let newline = v1PendingBytes.indexOf(0x0a, lineStart);
                let lastNewline = -1;
                while (newline !== -1) {
                  if (newline - lineStart > MAX_V1_EVENT_BYTES) {
                    throw new Error(
                      `${runV1Harness} V1 event exceeded ${MAX_V1_EVENT_BYTES} bytes`,
                    );
                  }
                  lastNewline = newline;
                  lineStart = newline + 1;
                  newline = v1PendingBytes.indexOf(0x0a, lineStart);
                }
                if (
                  lastNewline === -1 &&
                  v1PendingBytes.length > MAX_V1_EVENT_BYTES
                ) {
                  throw new Error(
                    `${runV1Harness} V1 event exceeded ${MAX_V1_EVENT_BYTES} bytes`,
                  );
                }
                if (lastNewline !== -1) {
                  const fullLines = v1PendingBytes
                    .subarray(0, lastNewline + 1)
                    .toString('utf8');
                  v1PendingBytes = Buffer.from(
                    v1PendingBytes.subarray(lastNewline + 1),
                  );
                  emitCarapaRunV1Lines(
                    fullLines,
                    observeChunk,
                    v1StreamState,
                    onToolUse,
                    handleUserInputRequest,
                  );
                }
                // Ordinary live notifications consume a bounded amount of
                // work. Completion drains all remaining windows before it
                // validates the terminal event.
              } while (completionPass && v1BytesRead < stat.size);
            } finally {
              fs.closeSync(fd);
            }
          }
          return;
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        runDir?.closeSync();
      }
    };

    const checkStderrActivity = () => {
      if (!fs.existsSync(stderrPath)) return;
      try {
        const stat = fs.statSync(stderrPath);
        if (stat.size > stderrBytesRead) {
          stderrBytesRead = stat.size;
          lastActivityAt = Date.now();
          resetActivity();
        } else if (stat.size < stderrBytesRead) {
          stderrBytesRead = stat.size;
        }
      } catch {
        // Ignore diagnostics heartbeat errors — best effort
      }
    };

    const settleInterruptedV1Terminal = () => {
      v1StreamState.terminal = ensureCarapaRunV1Terminal(v1Paths);
    };

    // Handle AbortSignal — resolve immediately with whatever output exists so
    // far. But a late abort (HTTP request / parent-signal teardown firing
    // right as a fast run finishes) must NOT turn an already-completed run
    // into an error: if the agent already wrote exit_code, honor it. Only a
    // genuine mid-run abort (no exit_code yet) resolves as an error.
    const finishMaybeAbort = () => {
      // Contract-v1 cancellation is completed by stop-agent.sh, which
      // publishes exit_code and metrics_complete after the process tree has
      // stopped. Keep the watcher alive until that definitive handshake;
      // resolving directly from AbortSignal would race cleanup and lose the
      // final stage metrics.
      const runDir = openRunDirPinned(hostDir);
      let rawExit: string | undefined;
      let metricsDone = false;
      let readFailed = false;
      try {
        if (runDir) {
          rawExit = readIpcTextSync(runDir, 'exit_code', 64)?.trim();
          metricsDone =
            metricsContract >= 1 &&
            readIpcTextSync(runDir, 'metrics_complete', 64) !== null;
        }
      } catch {
        // Unreadable marker: fall through to abort-as-error.
        readFailed = true;
      } finally {
        runDir?.closeSync();
      }
      if (
        !readFailed &&
        metricsContract >= 1 &&
        (rawExit === undefined || !metricsDone)
      ) {
        return;
      }
      // A stop that landed before the runner emitted its terminal event (e.g.
      // during launch) leaves a V1 transcript that canonicalization rejects.
      if (consumeRunV1 && !v1StreamState.terminal) {
        try {
          settleInterruptedV1Terminal();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      if (rawExit !== undefined) {
        try {
          const exitCode = parseInt(rawExit, 10);
          const stderr = readFileTail(stderrPath, MAX_CAPTURE_BYTES);
          // The exit_code file existing means the agent self-terminated
          // (run-agent.sh only writes it on its own completion path), so
          // this is a late abort racing a finished run, not a mid-run
          // cancel. An empty/partial read (truncate window) parses to NaN —
          // do NOT let that flip the finished run to an error; honor it as
          // success (the genuine-failure case writes a real non-zero digit).
          const isError =
            rawExit !== '' && !Number.isNaN(exitCode) && exitCode !== 0;
          finish({ stderr, isError });
          return;
        } catch {
          // fall through to abort-as-error
        }
      }
      finish({ isError: true });
    };
    if (signal) {
      if (signal.aborted) {
        // The abort may have landed while the stop's contract-v1 handshake is
        // still in flight — e.g. stopTask aborted the signal before the
        // active_run row existed, so killAgentProcess found no run and
        // stop-agent.sh never ran. When finishMaybeAbort cannot settle yet,
        // fall through and keep the watcher/poll timers alive so the
        // handshake (or the hard deadline) can still finalize the run.
        // Returning here without any timers would leave the promise pending
        // forever, leaking the caller's semaphore slot and stranding the
        // project queue.
        finishMaybeAbort();
      } else {
        signal.addEventListener('abort', finishMaybeAbort, { once: true });
      }
    }
    if (settled) return;

    // Try fs.watch() on the run directory
    try {
      watcher = fs.watch(hostDir, (_event, filename) => {
        if (filename === 'exit_code' || filename === 'metrics_complete') {
          checkCompletion();
        } else if (
          filename === 'output.v1.jsonl' ||
          filename === 'output.v1.meta.json'
        ) {
          streamNewOutput();
        } else if (filename === 'agent-stderr.log') {
          checkStderrActivity();
        }
      });
      watcher.on('error', () => {
        // fs.watch failed — rely on fallback polling
        if (watcher) {
          watcher.close();
          watcher = null;
        }
      });
    } catch {
      // fs.watch not available — rely on fallback polling
    }

    // Fallback poll (also serves as timeout checker)
    pollTimer = setInterval(checkCompletion, RUN_POLL_INTERVAL);

    // Stream timer — always active to drive inactivity timeout detection.
    streamTimer = setInterval(() => {
      streamNewOutput();
      checkStderrActivity();
    }, RUN_POLL_INTERVAL);

    // Drain anything already on disk so recovery emits buffered chunks
    // instantly instead of waiting up to RUN_POLL_INTERVAL.
    streamNewOutput();
    checkStderrActivity();

    // Initial check — the run may have already completed
    checkCompletion();
  });
}

// ─── Launch helpers ─────────────────────────────────────────────────────────

const CHAT_MODE_CONTEXT_INSTRUCTIONS: Record<string, string> = {
  ask: 'Focus on understanding, clarifying, and explaining. Avoid code changes unless explicitly requested.',
  plan: 'Focus on planning and design before implementation. Break work into clear steps and do not start coding unless explicitly asked to execute.',
  code: 'Prioritize implementation. Make concrete changes, run relevant checks, and report what changed.',
  debug:
    'Prioritize root-cause analysis and evidence gathering. Reproduce issues when possible and explain the targeted fix.',
};

/**
 * Launch agent in sandbox background, returning immediately.
 *
 * Writes only data files (args.json, prompt.txt, system-prompt.txt) to the
 * shared mount, then calls the static run-agent.sh launcher baked into the container image.
 * No executable code is written to the shared mount.
 */
async function launchBackground(
  client: SandboxClient,
  stack: string,
  service: string,
  hostDir: string,
  runId: string,
  group_folder: string,
  args: {
    prompt: string;
    session_id?: string;
    model?: string;
    fallback_model?: string;
    reasoning_effort?: string | null;
    fallback_reasoning_effort?: string | null;
    env?: Record<string, string>;
    agent_cmd?: string;
    agent?: string;
    bare?: boolean;
    chat_jid?: string;
    systemPrompt?: string;
    chat_mode?: string | null;
    prompt_cache_ttl?: string;
    instance?: string;
    task_id?: string;
    objective_id?: string;
    stages?: string;
    custom_values?: { key: string; label?: string; type?: 'text' | 'number' }[];
    forkSession?: boolean;
    work_dir?: string;
    group_dir?: string;
    group?: RegisteredGroup | { settings?: { isParent?: boolean } };
    // Persistent (warm) Claude process: stable per-conversation key + opt-in
    // flag. When both are set, run-agent.sh reuses a long-lived stream-json
    // `claude` process keyed by `conversationKey` instead of spawning an
    // ephemeral `claude -p`. Empty/false → existing ephemeral path (unchanged).
    conversationKey?: string;
    persistent?: boolean;
    injectAgentContext?: boolean;
    userCommand?: string;
    // Raw conversation id, forwarded to args.json so run-agent.sh can reap
    // sibling warm-variant daemons for this conversation on a variant switch.
    conversation_id?: string;
    /** Original run replaced by this one-time restart continuation. */
    restartRecoveryRunId?: string;
  },
): Promise<void> {
  const sboxDir = sandboxRunDir(runId);

  // First turn (or explicit injectAgentContext): AGENT_CONTEXT + system prompt.
  // Continuation turns send only the user message.
  const injectContext =
    args.injectAgentContext ?? (!args.session_id || !!args.forkSession);

  // Write data files to the shared mount (host-side, visible inside sandbox).
  // Field names must be camelCase: run-agent.sh reads `.sessionId` and `.workDir`
  // via jq, so writing snake_case here silently drops the values.
  const argsJson = {
    agentCmd: args.agent_cmd || AGENT_CMD,
    // Keep the originating group available to boot recovery if the active_runs
    // row is lost before the run directory is swept.
    groupFolder: group_folder,
    taskId: args.task_id || '',
    objectiveId: args.objective_id || '',
    sessionId: args.session_id || '',
    model: sanitizeAgentModel(args.model),
    fallbackModel: sanitizeAgentModel(args.fallback_model),
    reasoningEffort: args.reasoning_effort || '',
    fallbackReasoningEffort: args.fallback_reasoning_effort || '',
    pricing: getModelPricingConfig(),
    // Board waits for the runner's atomic metrics_complete marker before
    // finalizing this run. This prevents exit_code/metrics.json ordering races.
    metricsContract: 1,
    codexControlContract: (args.agent_cmd || AGENT_CMD) === 'codex' ? 1 : 0,
    env: args.env || {},
    agent: args.agent || '',
    // Claude Code minimal mode. '1' → run-agent.sh adds --bare (strips
    // CLAUDE.md/auto-memory/skills/hooks). '' → unchanged ephemeral behavior.
    bare: args.bare ? '1' : '',
    systemPrompt: injectContext ? args.systemPrompt || '' : '',
    // Runtime behavior, not just bootstrap context: Codex app-server uses this
    // on every turn to select its native collaboration mode.
    chatMode: args.chat_mode || '',
    promptCacheTtl: args.prompt_cache_ttl || '',
    forkSession: args.forkSession ? '1' : '',
    workDir: args.work_dir || '',
    // In a shared sandbox the parent subtree is mounted once. Repository cwd
    // and project data therefore need independent per-run routing.
    groupDir: args.group_dir || '/workspace/group',
    // Persistent warm-process routing (run-agent.sh reads these via jq;
    // empty string / '' means "use the ephemeral path", preserving today's
    // behavior for every non-eligible run).
    conversationKey: args.persistent ? args.conversationKey || '' : '',
    persistent: args.persistent && args.conversationKey ? '1' : '',
    // Raw conversation id lets run-agent.sh retire the previous warm variant
    // when a routing generation selects a replacement session directory.
    conversationId: args.conversation_id || '',
  };
  logger.debug(
    {
      runId,
      agent_cmd: args.agent_cmd,
      AGENT_CMD,
      resolved: argsJson.agentCmd,
    },
    'agentCmd resolution for args.json',
  );
  logger.debug(
    {
      runId,
      envKeyCount: Object.keys(argsJson.env).length,
      hasSystemPrompt: argsJson.systemPrompt.length > 0,
      hasWorkDir: argsJson.workDir.length > 0,
    },
    'Writing args.json to run directory',
  );
  fs.writeFileSync(path.join(hostDir, 'args.json'), JSON.stringify(argsJson));

  // Inject agent context on bootstrap turns only (Skip for opencode and .sh
  // agents as they might not support this header).
  let contextBlock = '';
  if (
    injectContext &&
    argsJson.agentCmd !== 'opencode' &&
    !argsJson.agentCmd.endsWith('.sh')
  ) {
    const parts = [
      `group_folder=${group_folder}`,
      `group_dir=${argsJson.groupDir}`,
    ];
    if (args.chat_mode) parts.push(`chat_mode=${args.chat_mode}`);
    if (args.task_id) parts.push(`task_id=${args.task_id}`);
    // A chat agent needs its own conversation id to name it as the reply
    // destination of ask_project_agent; the relay token does not carry it.
    else if (args.conversation_id) {
      parts.push(`conversation_id=${args.conversation_id}`);
    }
    if (args.stages) parts.push(`stages=${args.stages}`);
    if (args.custom_values && args.custom_values.length > 0) {
      const valDefs = args.custom_values
        .map((v) => `${v.key}(${v.type || 'text'})`)
        .join(',');
      parts.push(`custom_values=${valDefs}`);
    }
    contextBlock = `[AGENT_CONTEXT: ${parts.join(' ')}]\n\n`;
    if (args.chat_mode) {
      const modeInstruction =
        CHAT_MODE_CONTEXT_INSTRUCTIONS[args.chat_mode] ||
        'Follow the project-specific instructions for the selected chat mode.';
      contextBlock +=
        `[CHAT_MODE: ${args.chat_mode}]\n` +
        `[INSTRUCTION: ${modeInstruction}]\n\n`;
    }
  }
  // Copy attached files into the run directory so they're accessible regardless of
  // which sandbox slot runs the agent.  Rewrite container paths in the prompt to point
  // to the run-local copies.
  let finalPrompt = args.prompt;
  const attachedRe = /^- .+?: (\/workspace\/ipc\/uploads\/(\S+))$/gm;
  let hasAttachments = false;
  const rewrites: Array<{ from: string; to: string; hostFile: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = attachedRe.exec(args.prompt)) !== null) {
    const containerPath = match[1];
    // Shared uploads include the project namespace (`child/file.ext`). Keep
    // that relative path for the host lookup, but flatten the run-local copy
    // so no uncreated subdirectory makes attachment copying silently fail.
    const uploadRelativePath = match[2];
    const copy = resolveRunAttachmentCopy(
      hostDir,
      hostIpcDir(group_folder, args.instance, stack),
      uploadRelativePath,
    );
    if (!copy) continue;
    const { srcFile, dstFile, filename } = copy;
    if (fs.existsSync(srcFile)) {
      try {
        fs.copyFileSync(srcFile, dstFile);
        const runContainerPath = `${sboxDir}/${filename}`;
        rewrites.push({
          from: containerPath,
          to: runContainerPath,
          hostFile: filename,
        });
        hasAttachments = true;
      } catch {
        /* best-effort */
      }
    }
  }
  for (const rw of rewrites) {
    finalPrompt = finalPrompt.replace(rw.from, rw.to);
  }
  if (hasAttachments) {
    finalPrompt +=
      '\n\nIMPORTANT: The attached files listed above are available at the given paths. If any are images/screenshots, read them with your Read tool to view their contents before proceeding.';
  }
  fs.writeFileSync(
    path.join(hostDir, 'prompt.txt'),
    contextBlock + finalPrompt,
  );
  if (args.userCommand) {
    fs.writeFileSync(path.join(hostDir, 'user-command.txt'), args.userCommand);
  }
  // Persist the exact system prompt args.json carries, so a replay can reuse
  // it byte-for-byte. Nothing else from args.json (env, model, ...) is copied.
  if (
    ENABLE_RUN_SYSTEM_PROMPT_TRANSCRIPTS &&
    argsJson.systemPrompt.length > 0
  ) {
    fs.writeFileSync(
      path.join(hostDir, 'system-prompt.txt'),
      argsJson.systemPrompt,
    );
  }

  // Sync .mcp.json from project root to group dir (always overwrite so updates propagate)
  const groupDir = getGroupDir(group_folder);
  const mcpJsonSrc = path.join(PROJECT_ROOT, '.mcp.json');
  // A native runner registers Board's MCP server for its agents itself, at a
  // relay address only it knows; a container-addressed copy would shadow it.
  if (
    fs.existsSync(mcpJsonSrc) &&
    !isNativeBoxInstance(args.instance ?? group_folder)
  ) {
    // Atomic write on the pinned group root: a planted .mcp.json link is
    // replaced, never written through to a file outside the group.
    const groupRoot = openGroupDirSync(group_folder, undefined, {
      create: true,
    });
    if (groupRoot) {
      try {
        writeFileAtSync(groupRoot, '.mcp.json', fs.readFileSync(mcpJsonSrc));
      } finally {
        groupRoot.closeSync();
      }
    }
  }

  // Launch the static script (mounted read-only in the container)
  // Inject the scoped token via environment variable
  // Keep the accepted-launch receipt in the sandbox command itself. The Board
  // can die after run-agent.sh has detached the prompt consumer but before the
  // following callback reaches the database; this idempotent marker survives
  // that crash and prevents the same resumable session from being consumed a
  // second time on the next boot.
  // The run inputs, uploads and browser descriptors must exist on the box
  // host before the runtime reads them.
  await ipcReplica.flushPath(hostDir, { strict: true });
  const launchIpcDir = hostIpcDir(group_folder, args.instance, stack);
  await ipcReplica.flushPath(path.join(launchIpcDir, 'uploads'));
  await ipcReplica.flushPath(path.join(launchIpcDir, 'browser-sessions'));
  // Projects on a remote box keep their group directory there: push Board's
  // edits (AGENTS.md, .mcp.json, prompts) and keep pulling agent output.
  await groupReplica.flushPath(groupDir, { strict: true });
  groupReplica.touch(group_folder);

  const launchCmd = args.restartRecoveryRunId
    ? `run-agent.sh ${sboxDir} && : > ${sboxDir}/${RESTART_RECOVERY_DISPATCH_RECEIPT}`
    : `run-agent.sh ${sboxDir}`;
  const result = await client.sandboxExec(stack, service, launchCmd, {
    timeout: 30,
    instance: args.instance,
  });

  if (result.isError) {
    if (isStoppedSandboxServiceError(result.stdout)) {
      const err = new Error(`Failed to launch agent: ${result.stdout}`);
      (err as any).stoppedServiceError = true;
      throw err;
    }
    // Detect stale/missing bind mount — sandbox needs restart
    if (/not found|nonexistent/i.test(result.stdout)) {
      const err = new Error(`Failed to launch agent: ${result.stdout}`);
      (err as any).staleMountError = true;
      throw err;
    }
    throw new Error(`Failed to launch agent: ${result.stdout}`);
  }

  logger.debug(
    { runId, pid: result.stdout.trim() },
    'Agent launched in background',
  );
}

// ─── Cleanup helpers ────────────────────────────────────────────────────────

/** Whether a run directory holds any Run V1 file (a pair or half of one). */
export function hasRunV1Files(runDir: string): boolean {
  const { events, manifest } = carapaRunV1Paths(runDir);
  return fs.existsSync(events) || fs.existsSync(manifest);
}

/**
 * Append a run directory's Run V1 pair to a transcript. A pair that stopped
 * before its terminal event is first completed as an interrupted run. Returns
 * true when the pair was archived or the run has no V1 file (nothing to
 * archive); false when it could not be archived and the run dir must be kept.
 * Repeated calls are safe: the append is checkpointed.
 */
export function archiveRunV1Transcript(
  target: string,
  runDir: string,
  metadata?: Record<string, unknown>,
): boolean {
  if (!hasRunV1Files(runDir)) return true;
  const harness = runV1ConsumerHarness(runAgentCommand(runDir));
  if (!harness) {
    logger.warn(
      { runDir },
      'Run V1 files present but args.json names no V1 harness; not archiving',
    );
    return false;
  }
  // A stall watchdog or crash may stop the run before a terminal event is
  // published. Complete the pair so the assistant text already sent survives.
  try {
    ensureCarapaRunV1Terminal(carapaRunV1Paths(runDir));
  } catch (error) {
    logger.warn(
      { error, runDir },
      'Failed to complete canonical V1 transcript before archiving',
    );
  }
  return appendCarapaRunV1ToTranscript(
    target,
    carapaRunV1Paths(runDir),
    harness,
    metadata,
  );
}

/**
 * The result of a run recovered from its run dir, read from its V1 pair. A
 * non-terminal pair is completed as interrupted first. A malformed pair is
 * logged and yields the empty result with only the metrics applied, so one bad
 * run dir cannot abort recovery.
 */
export function readRecoveredRunResult(
  runDir: string,
  metrics: RunMetrics | null | undefined,
): CanonicalAgentResult {
  try {
    ensureCarapaRunV1Terminal(carapaRunV1Paths(runDir));
    return canonicalizeRunResult(metrics, runDir);
  } catch (error) {
    logger.warn({ error, runDir }, 'Failed to read recovered run V1 result');
    return applyRunMetrics(
      { result: null, hasAssistantText: false } as CanonicalAgentResult,
      metrics,
    );
  }
}

/** Remove a run directory after completion.
 * If transcriptTarget is provided, archive the run's V1 transcript there first.
 * Fires the memory observer asynchronously (non-blocking). */
export async function cleanupRunDir(
  dir: string,
  transcriptTarget?: string,
  group_folder?: string,
  transcriptOffset?: number,
  workspaceRoot?: string,
  skipTranscriptMemory?: boolean,
  sandbox_stack?: string,
  sandbox_service?: string,
  agent_name?: string,
  sandbox_instance?: string,
  sandbox_workspace_path?: string,
  deleteRunDir?: boolean,
  preserveScheduledTranscript?: boolean,
): Promise<void> {
  // Scheduled runs are intentionally ephemeral, but their prompt/provider
  // stream is user-visible run history. Preserve only those before deleting
  // the IPC directory; unrelated ephemeral chat runs remain ephemeral.
  const runSidecarPresent = [
    'acp.raw.jsonl',
    'codex.raw.jsonl',
    'omp.raw.jsonl',
    'opencode.raw.jsonl',
    'pi.raw.jsonl',
    'output.v1.jsonl',
    'output.v1.meta.json',
  ].some((name) => fs.existsSync(path.join(dir, name)));
  // Ephemeral runs (no transcript target) never persist run history, so a
  // sidecar must not hold their directory for a copy that is never made.
  const runHistoryRequired =
    preserveScheduledTranscript === true ||
    (runSidecarPresent && !!transcriptTarget);
  let runHistoryPreserved = !runHistoryRequired;
  let rawOutputArchived = true;
  if (group_folder && (transcriptTarget || preserveScheduledTranscript)) {
    runHistoryPreserved = persistPerRunTranscript(
      group_folder,
      path.basename(dir),
      dir,
    );
  }
  if (transcriptTarget) {
    logger.debug(
      { dir, transcriptTarget },
      'cleanupRunDir: appending raw output to transcript',
    );
    // Wait out another process holding the transcript lock (e.g. a native
    // import) so the reply is archived now, not left for recovery.
    try {
      await withTranscriptLockHeld(transcriptTarget, () => {
        rawOutputArchived = archiveRunV1Transcript(
          transcriptTarget,
          dir,
          agent_name ? { agent_name } : undefined,
        );
      });
    } catch (error) {
      rawOutputArchived = false;
      logger.warn(
        { error, dir, transcriptTarget },
        'cleanupRunDir: raw output append failed; leaving it to recovery',
      );
    }
    logger.debug(
      { dir, rawOutputArchived },
      'cleanupRunDir: raw output append completed',
    );
  }

  // Reflect on this run's bounded portion of the transcript.
  if (transcriptTarget && group_folder && !skipTranscriptMemory) {
    try {
      logger.debug(
        { dir, group_folder },
        'cleanupRunDir: reflecting transcript',
      );
      await processTranscriptMemory(group_folder, transcriptTarget, {
        byteOffset: transcriptOffset,
        profile: 'run-agent-conversation',
        workspaceRoot,
        sandboxStack: sandbox_stack,
        sandboxService: sandbox_service,
        sandboxInstance: sandbox_instance,
        sandboxWorkspacePath: sandbox_workspace_path,
      });
      logger.debug(
        { dir, group_folder },
        'cleanupRunDir: transcript reflected',
      );
    } catch (err) {
      logger.warn({ err, group_folder }, 'Reflector failed (non-blocking)');
    }
  }

  try {
    // Serialized with replica syncs: an in-flight pull must not re-create
    // the removed directory before the recursive Box removal is issued.
    await ipcReplica.runExclusiveAt(dir, () => {
      logger.debug({ dir }, 'cleanupRunDir: deleting run directory');
      const retainedControlResponses = hasRetainedRunControlResponses(dir);
      if (
        deleteRunDir &&
        rawOutputArchived &&
        (!runHistoryRequired || runHistoryPreserved) &&
        !retainedControlResponses
      ) {
        removeIpcDirSync(dir);
      } else if (deleteRunDir) {
        if (
          retainedControlResponses &&
          rawOutputArchived &&
          (!runHistoryRequired || runHistoryPreserved)
        ) {
          writeRunMarkerSync(dir, '.cleanup-complete', 'ok\n');
        }
        logger.warn(
          {
            dir,
            rawOutputArchived,
            runHistoryPreserved,
            retainedControlResponses,
          },
          'cleanupRunDir: preserving IPC directory for durable recovery',
        );
      } else {
        logger.info({ dir }, 'cleanupRunDir: run directory PRESERVED');
      }
    });
  } catch {
    // Ignore cleanup errors
  }
  // Mirror the archive/removal to the box-owned IPC tree.
  await ipcReplica.flushPath(dir);
  // Pull the run's final group-directory output (remote boxes only).
  if (group_folder) await groupReplica.flushPath(getGroupDir(group_folder));
}

function hasRetainedRunControlResponses(dir: string): boolean {
  try {
    return fs
      .readdirSync(path.join(dir, 'control-responses'))
      .some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Delete a recovered run only when no durable steering acknowledgement still
 * depends on its generic control response. */
export async function removeRunDirPreservingControlResponses(
  dir: string,
): Promise<boolean> {
  // Serialized with replica syncs: an in-flight pull must not re-create the
  // removed directory before the recursive Box removal is issued.
  const removed = await ipcReplica.runExclusiveAt(dir, () => {
    if (hasRetainedRunControlResponses(dir)) {
      try {
        writeRunMarkerSync(dir, '.cleanup-complete', 'ok\n');
      } catch (error) {
        logger.warn({ dir, error: String(error) }, 'Failed to mark cleanup');
      }
      return false;
    }
    removeIpcDirSync(dir);
    return true;
  });
  void ipcReplica.flushPath(dir);
  return removed;
}

/**
 * Preserve the prompt, system prompt, native provider streams, and the
 * runtime-owned canonical Run V1 pair under the board run ID.
 *
 * Task transcripts aggregate many runs, while the Run History API addresses one
 * immutable copy per run. Copy these artifacts before aggregation so resumed
 * sessions and format-repair turns are inspectable independently.
 */
export function persistPerRunTranscript(
  groupFolder: string,
  runId: string,
  runDir: string,
  groupDir = getGroupDir(groupFolder),
): boolean {
  const targetDir = path.join(groupDir, 'session-transcripts');
  const promptSource = path.join(runDir, 'prompt.txt');
  const systemPromptSource = path.join(runDir, 'system-prompt.txt');
  const v1EventSource = path.join(runDir, 'output.v1.jsonl');
  const v1ManifestSource = path.join(runDir, 'output.v1.meta.json');
  const hasV1Events = fs.existsSync(v1EventSource);
  const hasV1Manifest = fs.existsSync(v1ManifestSource);
  const incompleteV1Pair = hasV1Events !== hasV1Manifest;
  const runSidecarSources = [
    {
      source: path.join(runDir, 'agy-sdk.raw.jsonl'),
      target: path.join(targetDir, `${runId}.agy-sdk.raw.jsonl`),
    },
    {
      source: path.join(runDir, 'acp.raw.jsonl'),
      target: path.join(targetDir, `${runId}.acp.raw.jsonl`),
    },
    {
      source: path.join(runDir, 'codex.raw.jsonl'),
      target: path.join(targetDir, `${runId}.codex.raw.jsonl`),
    },
    {
      source: path.join(runDir, 'omp.raw.jsonl'),
      target: path.join(targetDir, `${runId}.omp.raw.jsonl`),
    },
    {
      source: path.join(runDir, 'opencode.raw.jsonl'),
      target: path.join(targetDir, `${runId}.opencode.raw.jsonl`),
    },
    {
      source: path.join(runDir, 'pi.raw.jsonl'),
      target: path.join(targetDir, `${runId}.pi.raw.jsonl`),
    },
    ...(hasV1Events && hasV1Manifest
      ? [
          {
            source: v1EventSource,
            target: path.join(targetDir, `${runId}.v1.jsonl`),
          },
          {
            source: v1ManifestSource,
            target: path.join(targetDir, `${runId}.v1.meta.json`),
          },
        ]
      : []),
  ];
  // "Nothing to persist" counts as success: a run dir without these artifacts
  // holds no user-visible run history, so callers may safely delete it.
  // Only an actual copy failure (an artifact existed but could not be saved)
  // returns false and makes the caller preserve the directory.
  let copiedPrompt = !fs.existsSync(promptSource);
  // Runs without a system prompt (older runs, injectContext false) have no file.
  let copiedSystemPrompt = !fs.existsSync(systemPromptSource);
  const pendingRunSidecarSources = runSidecarSources.filter(({ source }) =>
    fs.existsSync(source),
  );
  let copiedRunSidecars = pendingRunSidecarSources.length === 0;

  // The target directory is agent-writable: pin it, so a swapped
  // `session-transcripts` link cannot redirect the copies. Callers that name a
  // group directory outside GROUPS_DIR (board-owned) get it pinned as an anchor.
  let pinnedTarget: PinnedDir | null = null;
  const openTarget = (): PinnedDir | null => {
    if (groupDir === getGroupDir(groupFolder)) {
      return openGroupDirSync(groupFolder, 'session-transcripts', {
        create: true,
      });
    }
    fs.mkdirSync(targetDir, { recursive: true });
    return openTrustedDirSync(targetDir);
  };

  const copyDurably = (source: string, target: string) => {
    if (!pinnedTarget) throw new Error('Run transcript directory unavailable');
    const name = path.basename(target);
    // Run sidecars are agent-writable: never follow a planted symlink and
    // copy from the validated descriptor, not the path.
    const sourceDescriptor = fs.openSync(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let data: Buffer;
    try {
      if (!fs.fstatSync(sourceDescriptor).isFile()) {
        throw new Error(
          `Refusing to copy run artifact that is not a regular file: ${source}`,
        );
      }
      data = fs.readFileSync(sourceDescriptor);
    } finally {
      fs.closeSync(sourceDescriptor);
    }
    writeFileAtSync(pinnedTarget, name, data, { mode: 0o600 });
    // Flush the file, then the directory entry, so a crash keeps the copy.
    const written = openFileAtSync(pinnedTarget, name);
    if (written) {
      try {
        fs.fsyncSync(written.fd);
      } finally {
        fs.closeSync(written.fd);
      }
    }
    try {
      fs.fsyncSync(pinnedTarget.fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
    }
  };

  try {
    if (!copiedPrompt || !copiedSystemPrompt || !copiedRunSidecars) {
      // Only create the target when there is actually an artifact to store.
      pinnedTarget = openTarget();
      if (!copiedPrompt) {
        const promptTarget = path.join(targetDir, `${runId}.prompt.txt`);
        copyDurably(promptSource, promptTarget);
        copiedPrompt = true;
      }
      if (!copiedSystemPrompt) {
        const systemPromptTarget = path.join(targetDir, `${runId}.system.txt`);
        copyDurably(systemPromptSource, systemPromptTarget);
        copiedSystemPrompt = true;
      }
      if (!copiedRunSidecars) {
        for (const { source, target } of pendingRunSidecarSources) {
          copyDurably(source, target);
        }
        copiedRunSidecars = true;
      }
    }
  } catch (err) {
    logger.warn(
      { err, groupFolder, runId, runDir },
      'Failed to preserve per-run transcript',
    );
  } finally {
    pinnedTarget?.closeSync();
  }

  if (incompleteV1Pair) {
    logger.warn(
      { groupFolder, runId, runDir, hasV1Events, hasV1Manifest },
      'Refusing to discard run with an incomplete V1 transcript pair',
    );
  }
  return (
    copiedPrompt && copiedSystemPrompt && copiedRunSidecars && !incompleteV1Pair
  );
}

const IGNORED_ERROR_LINE_SUBSTRINGS = [
  'hasTrustDialogAccepted',
  'claude.ai connectors are disabled',
  "Unset it to load your organization's connectors",
  '[run-agent.sh] wait returned',
  '[run-agent.sh] post-wait /proc tree',
  '[run-agent.sh] ephemeral:',
  '/proc/',
];

const isIgnoredErrorLine = (line: string): boolean =>
  IGNORED_ERROR_LINE_SUBSTRINGS.some((needle) => line.includes(needle));

/** Build ContainerOutput from raw result + parsed agent output */
/**
 * Extract a human-readable error snippet from raw JSONL stdout.
 * Strips JSONL lines (type tokens, result events, usage blocks) and
 * returns only plain-text / log lines — at most the last 500 chars.
 */
export function extractErrorSnippet(stdout: string): string {
  return (
    findErrorSnippet(stdout) ??
    // Nothing recognisable: fall back to the raw tail, minus ignored notices.
    stdout
      .slice(-500)
      .split('\n')
      .filter((line) => !isIgnoredErrorLine(line.trim()))
      .join('\n')
      .trim()
  );
}

/**
 * Like extractErrorSnippet, but returns null when the text holds nothing
 * beyond ignored wrapper notices, blanks or truncated protocol lines.
 */
function findErrorSnippet(stdout: string): string | null {
  const lines = stdout.slice(-500).split('\n');
  const plainLines: string[] = [];
  const protocolErrors: string[] = [];
  let sawProtocolEvent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isIgnoredErrorLine(trimmed)) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: unknown;
        message?: unknown;
        error?: unknown;
        item?: { type?: unknown; message?: unknown };
      };
      sawProtocolEvent = true;
      const errorMessage =
        typeof event.error === 'string'
          ? event.error
          : event.error &&
              typeof event.error === 'object' &&
              'message' in event.error &&
              typeof (event.error as { message?: unknown }).message === 'string'
            ? (event.error as { message: string }).message
            : event.type === 'error' && typeof event.message === 'string'
              ? event.message
              : event.item?.type === 'error' &&
                  typeof event.item.message === 'string'
                ? event.item.message
                : null;
      if (errorMessage) protocolErrors.push(errorMessage);
      continue;
    } catch {
      // Preserve non-JSON stderr/log lines below. A truncated protocol line is
      // not useful evidence and is filtered by the existing suffix check.
      if (trimmed.endsWith('}') || trimmed.endsWith(']')) continue;
    }
    plainLines.push(trimmed);
  }

  const snippet = plainLines.join('\n').trim();
  if (snippet) return snippet;
  if (protocolErrors.length > 0) return protocolErrors.at(-1)!;
  if (sawProtocolEvent) {
    return 'Agent run ended before producing a final response.';
  }
  return null;
}

const MAX_RUN_V1_ERROR_TEXT_BYTES = 64 * 1024;

type RunV1Error = { message: string; details?: unknown };

/** The error objects a Run V1 event carries, in stream order. */
function runV1EventErrors(events: readonly CarapaRunV1Event[]): RunV1Error[] {
  const errors: RunV1Error[] = [];
  for (const event of events) {
    if (event.type === 'error') {
      errors.push({ message: event.message, details: event.details });
    } else if (
      (event.type === 'run' || event.type === 'tool_call') &&
      event.error
    ) {
      errors.push(event.error);
    }
  }
  return errors;
}

/**
 * The error text of a run's V1 events (run, error and tool_call errors with
 * their details), capped at 64 KiB. This is what the unresumable-session
 * check matches, so a poisoned session is found wherever the box reported it.
 */
export function runV1ErrorText(events: string): string {
  const text = runV1EventErrors(parseCarapaRunV1EventText(events))
    .map(({ message, details }) =>
      details === undefined
        ? message
        : `${message}\n${JSON.stringify(details)}`,
    )
    .join('\n');
  return text.slice(0, MAX_RUN_V1_ERROR_TEXT_BYTES);
}

/**
 * The run's own error: a failed terminal run event's message, else the last
 * fatal `error` event (else the last one), else the stderr snippet. A run with
 * V1 events but no error text ended without a final response; with none it
 * falls back to the stderr tail.
 */
function extractRunError(events: string, stderr?: string): string {
  const parsed = parseCarapaRunV1EventText(events);
  const terminal = lastCarapaRunV1TerminalEvent(parsed);
  const failure =
    terminal?.status === 'failed' ? terminal.error?.message : undefined;
  if (failure) return failure;
  const errorEvents = parsed.filter(
    (event): event is Extract<CarapaRunV1Event, { type: 'error' }> =>
      event.type === 'error' && event.message !== '',
  );
  const reported =
    errorEvents.filter((event) => event.fatal).at(-1) ?? errorEvents.at(-1);
  if (reported) return reported.message;
  const stderrSnippet = stderr ? findErrorSnippet(stderr) : null;
  if (stderrSnippet) return stderrSnippet;
  if (parsed.length > 0) {
    return 'Agent run ended before producing a final response.';
  }
  return (
    (stderr ? extractErrorSnippet(stderr) : '') || '(No output from agent)'
  );
}

export function isBenignAgentWrapperTermination(stderr: string): boolean {
  return /\[run-agent\.sh\]\s+wait returned:.*\bRC=143\b.*\bpid_file_alive=NO\b/s.test(
    stderr,
  );
}

/**
 * Return true when an agent CLI reports that its persisted native session
 * cannot be resumed safely.
 *
 * Codex Responses API sessions can contain opaque encrypted reasoning items.
 * If those items can no longer be verified/decrypted (for example after an
 * auth or provider change), repeatedly passing --resume can never recover.
 */
export function isUnresumableSessionError(output: string): boolean {
  return /session.{0,20}not found|could not (find|resume|load) session|no such (session|conversation)|invalid session|no conversation found|conversation.{0,20}not found|codex thread\/resume failed|prior OMP process exited before recording tool result|thinking\.signature.{0,20}(required|missing)|no rollout found for thread id|list_turns.{0,40}not supported|invalid_encrypted_content|encrypted content.{0,120}(could not|cannot) be (verified|decrypted|parsed)/i.test(
    output,
  );
}

const PERSISTENT_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;

/**
 * Read the actionable tail of a warm runner's diagnostic log.
 *
 * The Codex app-server bridge can reduce a multiline JSON-RPC error to tiny
 * item errors (notably `error` and `}`) in the run's V1 events. The complete
 * provider error remains in the warm session's codex.appserver.out. Resolve it only via
 * the run-owned session_dir pointer and basename, never an arbitrary path from
 * the pointer file.
 */
export function readPersistentSessionDiagnostic(runDir: string): string {
  const dirs: PinnedDir[] = [];
  try {
    // Both directories are agent-writable: read through pinned descriptors, so
    // a link or FIFO planted in their place reads as no diagnostic.
    const run = openIpcDirSync(runDir);
    if (!run) return '';
    dirs.push(run);
    const pointer = readIpcTextSync(run, 'session_dir', 4096)?.trim();
    if (!pointer) return '';
    const sessionName = path.basename(pointer);
    if (!sessionName || sessionName === '.' || sessionName === '..') return '';

    const ipcRoot = path.dirname(path.dirname(runDir));
    const session = openIpcDirSync(path.join(ipcRoot, 'sessions', sessionName));
    if (!session) return '';
    dirs.push(session);
    const diagnostic = readIpcTextSync(
      session,
      'codex.appserver.out',
      PERSISTENT_DIAGNOSTIC_TAIL_BYTES,
      { tail: true },
    );
    if (!diagnostic) return '';
    const latestTurn = diagnostic.lastIndexOf('"method":"turn/started"');
    return latestTurn >= 0 ? diagnostic.slice(latestTurn) : diagnostic;
  } catch {
    return '';
  } finally {
    for (const dir of dirs) dir.closeSync();
  }
}

/**
 * Decide whether a failed run should be replayed with fresh native context.
 *
 * Warm chat daemons resume by conversationKey inside run-agent.sh, so they do
 * not necessarily have an explicit session_id on the board input. Treat that
 * persistent context as resumable state too; otherwise a poisoned Codex thread
 * (for example invalid_encrypted_content) is reused on every following turn.
 */
export function shouldRetryUnresumableSession(args: {
  agentCmd?: string;
  isError: boolean;
  agentTerminalFailure?: boolean;
  sessionId?: string;
  persistent: boolean;
  aborted: boolean;
  output: string;
}): boolean {
  return (
    // ACP restores native history in its own profile. A missing profile must
    // not turn into a successful-looking reply from an unrelated new session.
    args.agentCmd !== 'antigravity-acp' &&
    (args.isError || args.agentTerminalFailure === true) &&
    (!!args.sessionId || args.persistent) &&
    !args.aborted &&
    isUnresumableSessionError(args.output)
  );
}

export function buildOutput(
  result: {
    /** Run V1 event text of the run; '' when it wrote none. */
    events: string;
    stderr?: string;
    isError: boolean;
    userInputRequest?: boolean;
    intentionalUserInputInterrupt?: boolean;
  },
  agentResult: RunTokenStats & {
    result: string | null;
    hasAssistantText: boolean;
    agentSuccess?: boolean;
    agentTerminalFailure?: boolean;
    session_id?: string;
    uuid?: string;
  },
  groupFolder: string,
  duration?: number,
  stoppedByUser = false,
): ContainerOutput {
  const responseTiming = {
    inputTokenSemantics: agentResult.inputTokenSemantics,
    prompt_dispatched_at_ms: agentResult.prompt_dispatched_at_ms,
    first_output_at_ms: agentResult.first_output_at_ms,
    time_to_first_output_ms: agentResult.time_to_first_output_ms,
  };
  // Trust the agent's own success signal over exit code — Claude Code can
  // exit non-zero even when the JSONL result says success.
  const benignWrapperTermination =
    result.isError &&
    isBenignAgentWrapperTermination(result.stderr || '') &&
    (!!agentResult.result || agentResult.hasAssistantText);
  const explicitAgentFailure = agentResult.agentTerminalFailure === true;
  const effectiveError =
    (explicitAgentFailure ||
      (result.isError &&
        agentResult.agentSuccess !== true &&
        !benignWrapperTermination)) &&
    (!result.intentionalUserInputInterrupt || stoppedByUser);

  if (effectiveError && !agentResult.result) {
    const error = extractRunError(result.events, result.stderr);
    logger.error(
      {
        group_folder: groupFolder,
        duration,
        error,
      },
      'MCP agent execution failed (no usable output)',
    );
    return {
      status: 'error',
      result: null,
      stoppedByUser: stoppedByUser || undefined,
      error,
      newSessionId: agentResult.session_id,
      uuid: agentResult.uuid,
      total_tokens: agentResult.total_tokens,
      tok_output: agentResult.tok_output,
      tok_input: agentResult.tok_input,
      tok_cache_write: agentResult.tok_cache_write,
      tok_cache_read: agentResult.tok_cache_read,
      tok_context_last: agentResult.tok_context_last,
      tok_reasoning: agentResult.tok_reasoning,
      model_name: agentResult.model_name,
      usageSource: agentResult.usageSource,
      rawUsage: agentResult.rawUsage,
      cache_ttl_s: agentResult.cache_ttl_s,
      tool_usage_count: agentResult.tool_usage_count,
      cost_usd: agentResult.cost_usd,
      duration,
      ...responseTiming,
    };
  }

  if (effectiveError) {
    const error = extractRunError(result.events, result.stderr);
    logger.error(
      {
        group_folder: groupFolder,
        duration,
        error,
      },
      'MCP agent reported failure (has output but treating as error)',
    );
    return {
      status: 'error',
      result: agentResult.result, // preserve for display in task chat
      stoppedByUser: stoppedByUser || undefined,
      error,
      newSessionId: agentResult.session_id,
      uuid: agentResult.uuid,
      total_tokens: agentResult.total_tokens,
      tok_output: agentResult.tok_output,
      tok_input: agentResult.tok_input,
      tok_cache_write: agentResult.tok_cache_write,
      tok_cache_read: agentResult.tok_cache_read,
      tok_context_last: agentResult.tok_context_last,
      tok_reasoning: agentResult.tok_reasoning,
      model_name: agentResult.model_name,
      usageSource: agentResult.usageSource,
      rawUsage: agentResult.rawUsage,
      cache_ttl_s: agentResult.cache_ttl_s,
      tool_usage_count: agentResult.tool_usage_count,
      cost_usd: agentResult.cost_usd,
      duration,
      ...responseTiming,
    };
  }

  if (
    result.isError &&
    (agentResult.agentSuccess === true || benignWrapperTermination)
  ) {
    logger.warn(
      { group_folder: groupFolder, duration, benignWrapperTermination },
      'MCP agent exited non-zero but produced a usable result — treating as success',
    );
  }

  if (
    !agentResult.result &&
    !benignWrapperTermination &&
    (!result.intentionalUserInputInterrupt || stoppedByUser)
  ) {
    const stderrSnippet = result.stderr?.slice(-2000) || '';
    logger.warn(
      { group_folder: groupFolder, duration, stderr: stderrSnippet },
      'MCP agent completed with no result output',
    );
    return {
      status: 'error',
      result: null,
      stoppedByUser: stoppedByUser || undefined,
      error: stderrSnippet || '(No output from agent)',
      newSessionId: agentResult.session_id,
      total_tokens: agentResult.total_tokens,
      tok_output: agentResult.tok_output,
      tok_input: agentResult.tok_input,
      tok_cache_write: agentResult.tok_cache_write,
      tok_cache_read: agentResult.tok_cache_read,
      tok_context_last: agentResult.tok_context_last,
      tok_reasoning: agentResult.tok_reasoning,
      model_name: agentResult.model_name,
      usageSource: agentResult.usageSource,
      rawUsage: agentResult.rawUsage,
      cache_ttl_s: agentResult.cache_ttl_s,
      tool_usage_count: agentResult.tool_usage_count,
      cost_usd: agentResult.cost_usd,
      duration,
      ...responseTiming,
    };
  }

  return {
    status: 'success',
    result: agentResult.result,
    stoppedByUser: stoppedByUser || undefined,
    newSessionId: agentResult.session_id,
    uuid: agentResult.uuid,
    total_tokens: agentResult.total_tokens,
    tok_output: agentResult.tok_output,
    tok_input: agentResult.tok_input,
    tok_cache_write: agentResult.tok_cache_write,
    tok_cache_read: agentResult.tok_cache_read,
    tok_context_last: agentResult.tok_context_last,
    tok_reasoning: agentResult.tok_reasoning,
    model_name: agentResult.model_name,
    usageSource: agentResult.usageSource,
    rawUsage: agentResult.rawUsage,
    cache_ttl_s: agentResult.cache_ttl_s,
    tool_usage_count: agentResult.tool_usage_count,
    cost_usd: agentResult.cost_usd,
    duration,
    ...responseTiming,
    generatedArtifacts: extractGeneratedImageArtifacts(result.events),
  };
}

/** Preserve non-zero failures except for a confirmed Plan input boundary. */
export function completionStatusForRun(
  result: { isError: boolean; intentionalUserInputInterrupt?: boolean },
  output: { status: string },
): 'error' | 'completed' {
  if (result.isError && !result.intentionalUserInputInterrupt) return 'error';
  return output.status === 'error' ? 'error' : 'completed';
}

async function persistCanonicalRunCompletion(
  runId: string,
  agentResult: CanonicalAgentResult,
  status: 'completed' | 'error' | 'stalled',
  sessionId?: string,
): Promise<CanonicalAgentResult> {
  await completeActiveRun(runId, status, agentResult, sessionId);
  return agentResult;
}

/**
 * Persist the harness outcome before acknowledging prompt consumption.
 *
 * The acknowledgement normally appends task steering receipts. If that
 * durable append fails, the completed active-run row remains authoritative
 * evidence for the task pipeline to reconcile the assignment later. Receipt
 * persistence must therefore neither roll the run back to error nor replace
 * its successful result.
 */
async function persistRunCompletionBeforePromptAcceptance(
  runId: string,
  status: 'completed' | 'error',
  persist: () => Promise<unknown>,
  onPromptRunAccepted?: (runId: string) => void | Promise<void>,
): Promise<void> {
  await persist();
  if (status !== 'completed' || !onPromptRunAccepted) return;
  try {
    await onPromptRunAccepted(runId);
  } catch (error) {
    logger.warn(
      { runId, error: String(error) },
      'Failed to persist successful prompt acceptance; reconciliation will retry',
    );
  }
}

type CanonicalAgentResult = CarapaRunV1Summary &
  Pick<
    RunTokenStats,
    | 'inputTokenSemantics'
    | 'cost_usd'
    | 'prompt_dispatched_at_ms'
    | 'first_output_at_ms'
    | 'time_to_first_output_ms'
  >;

/**
 * A single canonical event can legitimately exceed one live-read window (for
 * example, a Codex command output delta). Bound individual JSONL rows
 * independently from the amount of file data consumed per event-loop turn.
 */
const MAX_V1_EVENT_BYTES = 16 * 1024 * 1024;

/**
 * Largest run sidecar (`args.json`, V1 manifest or events) read from the shared
 * IPC tree. `args.json` carries the launch pricing catalog, so a small cap
 * would hide the harness of a run with a large catalog.
 */
const RUN_SIDECAR_MAX_BYTES = 64 * 1024 * 1024;

/** `agentCmd` from the pinned run directory's `args.json`; undefined when unreadable. */
function runAgentCommandAt(dir: PinnedDir): string | undefined {
  try {
    const raw = readIpcTextSync(dir, 'args.json', RUN_SIDECAR_MAX_BYTES, {
      rejectHardLinks: true,
    });
    if (!raw) return undefined;
    const args = JSON.parse(raw) as { agentCmd?: unknown };
    return typeof args.agentCmd === 'string' ? args.agentCmd : undefined;
  } catch {
    return undefined;
  }
}

function runAgentCommand(runDir: string): string | undefined {
  let dir: PinnedDir | null = null;
  try {
    dir = openRunDirPinned(runDir);
    return dir ? runAgentCommandAt(dir) : undefined;
  } catch {
    return undefined;
  } finally {
    dir?.closeSync();
  }
}

type RunV1ConsumerHarness =
  | 'pi'
  | 'codex'
  | 'omp-acp'
  | 'opencode'
  | 'hermes-acp'
  | 'prime-agent-acp'
  | 'cursor-acp'
  | 'muse-acp'
  | 'grok-acp'
  | 'vibe-acp'
  | 'claude'
  | 'agy-sdk'
  | 'antigravity-acp';

const RUN_V1_HARNESSES: ReadonlySet<string> = new Set<RunV1ConsumerHarness>([
  'pi',
  'codex',
  'omp-acp',
  'opencode',
  'hermes-acp',
  'prime-agent-acp',
  'cursor-acp',
  'muse-acp',
  'grok-acp',
  'vibe-acp',
  'claude',
  'agy-sdk',
  'antigravity-acp',
]);

function runV1ConsumerHarness(
  agentCmd: string | undefined,
): RunV1ConsumerHarness | undefined {
  return agentCmd && RUN_V1_HARNESSES.has(agentCmd)
    ? (agentCmd as RunV1ConsumerHarness)
    : undefined;
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * The run's V1 pair, or null when this run has none (no V1 harness, or a file
 * is absent or refused). `args.json` and both V1 files are read through one
 * pinned run directory, so a link in the shared IPC tree cannot substitute
 * another run's pair. A runner stopped between writing the manifest and
 * creating the event spool leaves half a pair: a run without V1, not a
 * malformed one.
 */
function readRunV1Document(runDir: string | undefined) {
  if (!runDir) return null;
  let dir: PinnedDir | null = null;
  try {
    dir = openRunDirPinned(runDir);
  } catch {
    return null;
  }
  if (!dir) return null;
  try {
    const expectedHarness = runV1ConsumerHarness(runAgentCommandAt(dir));
    if (!expectedHarness) return null;
    const paths = carapaRunV1Paths(runDir);
    const manifest = readIpcTextSync(
      dir,
      path.basename(paths.manifest),
      RUN_SIDECAR_MAX_BYTES,
      { rejectHardLinks: true },
    );
    if (manifest === null) return null;
    // Stream the spool: a verbose run can exceed any whole-file cap. A sibling
    // run's file hard-linked into this directory is refused, not read.
    const collector = createCarapaRunV1SummaryCollector(manifest, {
      expectedHarness,
      requireTerminal: true,
    });
    const found = forEachIpcLineSync(
      dir,
      path.basename(paths.events),
      { maxLineBytes: MAX_V1_EVENT_BYTES, rejectHardLinks: true },
      collector.push,
    );
    return found ? collector.finish() : null;
  } finally {
    dir.closeSync();
  }
}

export function canonicalizeRunResult(
  metrics: RunMetrics | null | undefined,
  runDir?: string,
): CanonicalAgentResult {
  const base = applyRunMetrics(
    { result: null, hasAssistantText: false } as CanonicalAgentResult,
    metrics,
  );
  const document = readRunV1Document(runDir);
  if (!document) return base;
  const merged = {
    ...base,
    ...definedFields(summarizeCarapaRunV1(document)),
  } as CanonicalAgentResult;
  // Question prompts (Claude AskUserQuestion, Codex Plan input) are V1
  // interactions, not tool_call events. With no other count from V1 tool
  // calls or metrics, count the questions asked.
  if (merged.tool_usage_count === undefined) {
    const questions = new Set(
      document.events.flatMap((event) =>
        event.type === 'interaction' && event.status === 'requested'
          ? [event.id]
          : [],
      ),
    );
    if (questions.size > 0) merged.tool_usage_count = questions.size;
  }
  return {
    ...merged,
    cost_usd:
      metrics?.costUsd ??
      // Price the merged telemetry (V1 totals and model). A cost derived
      // before the merge may belong to a different model, so it is dropped.
      calculateTelemetryCostUsd({
        ...merged,
        cost_usd: undefined,
      } as unknown as Record<string, unknown>) ??
      undefined,
  };
}

/** Terminal failure reported by the run's V1 pair; false when it is absent or unreadable. */
function runV1TerminalFailure(runDir: string): boolean {
  try {
    const document = readRunV1Document(runDir);
    return document
      ? summarizeCarapaRunV1(document).agentTerminalFailure === true
      : false;
  } catch {
    return false;
  }
}

export function prepareCanonicalRunCompletion(
  runId: string,
  metrics: RunMetrics | null | undefined,
  runDir?: string,
): {
  agentResult: CanonicalAgentResult;
  persist: (
    status: 'completed' | 'error' | 'stalled',
    sessionId?: string,
  ) => Promise<CanonicalAgentResult>;
} {
  const agentResult = canonicalizeRunResult(metrics, runDir);
  return {
    agentResult,
    persist: (status, sessionId) =>
      persistCanonicalRunCompletion(runId, agentResult, status, sessionId),
  };
}

// ─── Main runner ────────────────────────────────────────────────────────────

async function applyPreparedCheckout(input: ContainerInput): Promise<void> {
  if (!input.prepareCheckout) return;
  const prepared = await input.prepareCheckout();
  input.branchBaseName = prepared.branchBaseName;
  input.branchBaseCommit = prepared.branchBaseCommit;
  input.requiredDependencyCommits = prepared.requiredDependencyCommits ?? [];
  input.dependencyByCommit = prepared.dependencyByCommit;
}

/**
 * Run an agent inside the MCP sandbox via claude -p.
 * Same interface as the Docker-based container-runner.
 *
 * The agent is launched in the background with output redirected to files
 * on the shared mount. Completion is detected by watching the host filesystem.
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onChunk?: (data: ChunkData) => void,
  deps: {
    resolveEffectiveSandbox: typeof resolveEffectiveSandbox;
    runDirectLlm?: typeof import('../modules/chat/direct-llm.js').runDirectLlm;
  } = { resolveEffectiveSandbox },
): Promise<ContainerOutput> {
  // Admission. A restart that is already executing is stopping this instance
  // (it holds chats; a merely pending one never does), and maintenance that
  // moves what it mounts (a parent change) holds every kind of launch and must
  // see each one either waiting here or recorded in active_runs. Waiting
  // happens before any active_runs row exists, so a waiting chat is not itself
  // an active run, and before any launch input is used: after a wait the
  // project and its objective are read again (see run-admission.ts).
  const admitted = await admitRun(group, input, {
    admit: admitLaunch,
    resolveInstance: (g) => deps.resolveEffectiveSandbox(g).instance,
    getGroup: getGroupByFolder,
    getObjective,
  });
  try {
    return await runAdmittedContainerAgent(
      admitted.group,
      admitted.input,
      onChunk,
      deps,
      { settle: admitted.settle },
    );
  } finally {
    // Ends without a run row (error, abort, direct LLM) as well.
    admitted.settle();
  }
}

interface LaunchAdmission {
  settle(): void;
}

async function runAdmittedContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onChunk: ((data: ChunkData) => void) | undefined,
  deps: {
    resolveEffectiveSandbox: typeof resolveEffectiveSandbox;
    runDirectLlm?: typeof import('../modules/chat/direct-llm.js').runDirectLlm;
  },
  launch: LaunchAdmission,
): Promise<ContainerOutput> {
  // Chat runs (no task_id, no scheduled_task_id) bypass the semaphore entirely.
  // They always use slot 0 (the single container instance) and don't block kanban tasks.
  const isChat = !input.task_id && !input.scheduled_task_id;
  const usesWorktree =
    !!input.branch_name &&
    (group.settings?.taskCheckoutMode === 'worktree' ||
      input.worktreeRequested === true);
  let slotIndex: number;
  let release: () => void;
  const needsSharedCheckoutLease =
    !!input.task_id &&
    !input.skipSharedCheckoutLease &&
    !input.worktree_path &&
    !usesWorktree &&
    group.settings?.taskCheckoutMode !== 'worktree';
  let checkoutLease: SharedCheckoutLease | undefined;
  if (input.signal?.aborted) {
    return { status: 'error', result: null, error: 'Aborted' };
  }
  try {
    assertRuntimeAllowed({
      projectId: input.group_folder,
      purpose: input.privacyPurpose ?? (isChat ? 'chat' : 'agent'),
      runtime: input.privacyRuntime ?? input.runtimeConfig,
    });
  } catch (error) {
    if (error instanceof PrivacyRefusal) {
      return { status: 'error', result: null, error: error.message };
    }
    throw error;
  }
  let leaseHeartbeat: NodeJS.Timeout | undefined;
  if (isChat) {
    slotIndex = 0;
    release = () => {}; // Chat runs don't hold semaphore slots
  } else {
    // Parallel slots only when worktrees isolate each run;
    // otherwise all runs share one checkout + container, so force serial and
    // ignore any explicit manual capacity override.
    const worktreeIsolated = group.settings?.taskCheckoutMode === 'worktree';
    const slot = await acquireGroupSlot(
      input.group_folder,
      worktreeIsolated
        ? (input.maxParallelWorktrees ?? getTaskSlotLimit(group))
        : 1,
      {
        bypassLimit:
          worktreeIsolated && input.manualParallelismOverride === true,
        signal: input.signal,
      },
    );
    slotIndex = slot.slotIndex;
    release = slot.release;
  }
  if (needsSharedCheckoutLease) {
    try {
      checkoutLease = await acquireSharedCheckoutLease(
        input.group_folder,
        { type: 'task', id: input.task_id! },
        { signal: input.signal },
      );
      leaseHeartbeat = setInterval(() => {
        void checkoutLease?.heartbeat();
      }, 10_000);
    } catch (error) {
      release();
      throw error;
    }
  }

  // Everything below can perform fallible DB/MCP setup before the execution
  // try/finally is reached. Keep an outer cleanup boundary around that
  // preflight too: otherwise an exception there leaks the acquired slot and
  // can permanently strand the project's queue.
  try {
    // Redirect the agent's built-in `PushNotification` tool (desktop-only, never
    // reaches a web/Android user) to the user's real devices via the FCM pipeline.
    // Passed to every waitForRun below; dedupe by tool_use id makes the
    // adopt/recovery re-stream of output.v1.jsonl idempotent.
    const onToolUse = (
      name: string,
      toolInput: Record<string, unknown>,
      toolId?: string,
    ) => {
      if (name === 'PushNotification') {
        void firePushNotification(input.group_folder, toolInput, toolId, {
          task_id: input.task_id,
          conversation_id: input.conversation_id,
          triggered_by_user_id: input.triggeredByUserId,
        });
      }
    };

    const task = input.task_id ? await getTask(input.task_id) : null;
    // Recording is opt-in per stage via StageDefinition.record. Resolve from the
    // stage being run (input.stage_id from the pipeline) and fall back to the
    // task's persisted status for non-pipeline callers (scheduler/agent-runner)
    // that pass task_id without stage_id.
    const recordStages = getGroupStages(group);
    const recordEnabled = (id?: string | null) =>
      !!id && !!resolveStageForTask(group, id, task?.stageVariant)?.record;
    const isRecordingStage =
      recordEnabled(input.stage_id) || recordEnabled(task?.status);

    // Resolve run parameters before notifying the caller so that insertActiveRun
    // can be called immediately after onSlotAcquired — before launchBackground —
    // ensuring running:true is visible in the DB from the moment the slot is acquired.
    const client = getSandboxClient();
    const effectiveSandbox = deps.resolveEffectiveSandbox(group);
    const stack = effectiveRunSandboxStack(effectiveSandbox, input.sandbox);
    const service = effectiveSandbox.service;
    const timeout = input.timeout ?? MCP_AGENT_TIMEOUT;
    const sharedRecordingProject =
      effectiveSandbox.owner.settings?.sandboxOwnership === 'shared'
        ? input.group_folder
        : undefined;

    // Resolve the workspace root for observations (group dir; repositoryLocation is
    // a host-side path and is not accessible from inside the container).
    const wsRoot = getGroupDir(input.group_folder);
    const sandboxWorkspaceRoot = computeWorkspaceRoot(group);
    // Worktrees may be created after this run starts. Resolve this lazily at
    // cleanup time, and turn the repo-relative path returned by CarapaBox into
    // the absolute path that the sandbox scrub command must walk.
    const sandboxObservationRoot = (): string => {
      if (!input.worktree_path) return sandboxWorkspaceRoot;
      // Persisted worktree_path may be host-side. The sandbox mount layout is
      // stable and branch-based, so never send that host path back to the agent.
      if (input.branch_name) {
        return path.posix.join(
          sandboxWorkspaceRoot,
          '.worktrees',
          input.branch_name,
        );
      }
      return path.posix.isAbsolute(input.worktree_path)
        ? path.posix.normalize(input.worktree_path)
        : path.posix.join(sandboxWorkspaceRoot, input.worktree_path);
    };

    // Each group gets its own sandbox instance for isolation.
    // When defaultSandboxInstance is set, use that fixed name (externally managed stack).
    // Otherwise derive from group folder + slot index.
    let fixedInstance = effectiveSandbox.fixedInstance
      ? effectiveSandbox.instance
      : undefined;
    // Guard: reject invalid instance names (e.g. agent executable names like "claude"
    // that contain dots or other chars invalid for Docker Compose project names).
    if (fixedInstance && !/^[a-z0-9][a-z0-9_-]*$/.test(fixedInstance)) {
      logger.warn(
        { fixedInstance, group_folder: input.group_folder },
        'Ignoring invalid defaultSandboxInstance — falling back to group folder',
      );
      fixedInstance = undefined;
    }
    const instance =
      fixedInstance ||
      (effectiveSandbox.owner.settings?.sandboxOwnership === 'shared'
        ? effectiveSandbox.instance
        : sandboxInstanceName(input.group_folder, slotIndex));
    // Crash-recovery adoption: if we find a running active_run on this instance that
    // was NOT created by the current process, adopt it (it's a leftover from a
    // previous process that crashed/restarted). Runs created by this process are
    // tracked in currentProcessRunIds and must never be adopted — doing so would
    // steal another concurrent run's output stream.
    // Adoption is an exact execution-owner operation, not an instance-owner
    // operation. Shared instances can contain parallel worktree tasks and
    // runtime variants, so every durable routing field must agree before this
    // request is allowed to consume an orphan's spool.
    const candidateRun = await getActiveRunForOwnerInstance(
      input.group_folder,
      instance,
      {
        task_id: input.task_id,
        conversation_id: input.conversation_id,
        chat_jid: input.chat_jid,
      },
    );
    const intendedStage = input.task_id
      ? (input.activeRunStageId ?? input.stage_id ?? task?.status ?? '')
      : '';
    const intendedSession = input.session_id ?? null;
    const intendedRuntime =
      input.session_agent_key || input.agent_cmd || AGENT_CMD;
    const intendedModel = input.model ?? null;
    const intendedRuntimeVariant = persistentVariantTag(
      input.agent_cmd || AGENT_CMD,
      input.model,
      input.env,
      input.worktree_path,
    );
    const typeMatches = candidateRun ? isChat === !candidateRun.task_id : false;
    const ownerMatches = candidateRun
      ? candidateRun.sandbox_stack === stack &&
        candidateRun.sandbox_service === service &&
        candidateRun.task_id === (input.task_id ?? null) &&
        candidateRun.conversation_id === (input.conversation_id ?? null) &&
        candidateRun.chat_jid === input.chat_jid &&
        candidateRun.scheduled_task_id === (input.scheduled_task_id ?? null) &&
        (candidateRun.stage ?? '') === intendedStage &&
        candidateRun.session_id === intendedSession &&
        (candidateRun.session_agent_key || candidateRun.agent_name) ===
          intendedRuntime &&
        candidateRun.model === intendedModel &&
        candidateRun.runtime_variant === intendedRuntimeVariant
      : false;
    const existingRun =
      candidateRun &&
      candidateRun.id !== input.restartRecoveryRunId &&
      candidateRun.id !== input.precreatedActiveRunId &&
      !currentProcessRunIds.has(candidateRun.id) &&
      typeMatches &&
      ownerMatches
        ? candidateRun
        : undefined;

    // If there's an active run for this instance that belongs to our process,
    // it means a new request came in while the old one was still running (or hung).
    // The candidate lookup matches the request's exact identity, so another
    // conversation's run is never returned: warm daemons are keyed per
    // (conversation, variant) and each has its own session dir, so killing a
    // different conversation's run here would tear down its warm daemon —
    // killRun -> stop-agent.sh -> rm -rf the session dir (run-dir/pid holds the
    // daemon pid). Force kill the old one only when the request names the same
    // conversation (a new message arrived while that conversation's previous
    // turn is still in-flight).
    if (
      candidateRun &&
      currentProcessRunIds.has(candidateRun.id) &&
      candidateRun.id !== input.restartRecoveryRunId &&
      candidateRun.id !== input.precreatedActiveRunId &&
      typeMatches
    ) {
      const oldConvId = candidateRun.conversation_id ?? undefined;
      const sameConversation =
        !!input.conversation_id && input.conversation_id === oldConvId;
      if (isChat) {
        if (sameConversation) {
          logger.info(
            { runId: candidateRun.id, group: group.name },
            'New request for active instance — killing old run (same conversation)',
          );
          // Kill the old run's abort controller using the OLD run's conversation_id,
          // not the new one.  Without this, the old conversation's abort controller
          // leaks in chatRunAbortControllers and blocks all future messages to it
          // (the "Agent already running" guard silently swallows them).
          await killChatAgentProcess(
            input.group_folder,
            candidateRun.chat_jid ?? undefined,
            oldConvId,
          );
        } else {
          // No conversation identity to compare: run in parallel. Only note
          // it; do NOT killRun (that would tear down a warm daemon via
          // stop-agent.sh).
          logger.info(
            { runId: candidateRun.id, group: group.name },
            'Active run on instance has no conversation identity — running in parallel, not killing',
          );
        }
      } else if (input.task_id) {
        await killAgentProcess(input.task_id);
      }
    }

    // Pre-generate the run ID and deadline so the active_runs row can be written
    // before notifying the task pipeline that execution has started.
    const runId = input.precreatedActiveRunId ?? generateRunId();
    input.run_id = runId;
    const recordingEnabled = isRecordingStage && !!input.task_id;
    const timeoutMs = timeout * 1000;
    const timeout_at = Date.now() + timeoutMs;
    // Hoisted so the finally below can release the ownership mark of the run
    // that actually executed: the session-retry path replaces runId in place
    // (effectiveRunId = retryRunId) and the retry must not be left unmarked.
    let effectiveRunId = runId;
    // Chat runs register an abort controller so Stop can cancel the host-side
    // wait. It stays registered across the unresumable-session retry and is
    // released only once the run (retry included) is over.
    let chatAbortController: AbortController | undefined;
    const releaseChatAbortController = () => {
      if (!chatAbortController) return;
      const abortKey = chatAbortKey(
        input.group_folder,
        input.conversation_id,
        input.chat_jid,
      );
      // Only remove the controller if it is still ours. A newer concurrent run
      // may have replaced it (aborting us in the process); that run owns the
      // slot and we must not evict its entry.
      if (chatRunAbortControllers.get(abortKey) === chatAbortController) {
        chatRunAbortControllers.delete(abortKey);
      }
    };
    // A waitForRun that bailed out on an abort leaves the agent process alive;
    // end it, unless a user Stop is already doing so. `force` is for a stop
    // that may have hit the run before its process existed, so its "handled"
    // claim cannot be trusted.
    const killRunAfterAbort = async (
      signal: AbortSignal,
      id: string,
      force = false,
    ) => {
      // A user Stop interrupts the agent gracefully and falls back to a
      // hard kill itself; wait for that instead of racing it.
      const stopHandled =
        signal.reason === 'user_stop' && !force
          ? await userStopsInProgress.get(
              chatAbortKey(
                input.group_folder,
                input.conversation_id,
                input.chat_jid,
              ),
            )
          : undefined;
      const run = stopHandled?.has(id) ? undefined : await getActiveRunById(id);
      if (run) {
        await killRun(run).catch((kerr) => {
          logger.warn(
            { runId: id, error: String(kerr) },
            'Failed to kill agent after abort',
          );
        });
      }
    };

    if (input.precreatedActiveRunId) {
      const reservedRun = await getActiveRunById(runId);
      if (
        !reservedRun ||
        reservedRun.status !== 'running' ||
        reservedRun.task_id !== (input.task_id ?? null) ||
        reservedRun.stage !== intendedStage ||
        reservedRun.session_id !== intendedSession ||
        (reservedRun.session_agent_key || reservedRun.agent_name) !==
          intendedRuntime ||
        reservedRun.model !== intendedModel ||
        reservedRun.runtime_variant !== intendedRuntimeVariant ||
        reservedRun.sandbox_stack !== stack ||
        reservedRun.sandbox_service !== service ||
        reservedRun.sandbox_instance !== instance
      ) {
        throw new Error(
          `Precreated active run ${runId} no longer owns restart recovery`,
        );
      }
    }

    try {
      // Guard: if the run was aborted while waiting for a semaphore slot
      // (e.g. stopTask() was called before a slot became free), bail out without
      // firing onSlotAcquired. Firing it would add the task back to runningTasks,
      // overwrite started_at, and append a duplicate user message — all spurious.
      // The release() in the finally block still runs, freeing the slot properly.
      if (input.signal?.aborted) {
        return { status: 'error', result: null, error: 'Aborted' };
      }

      // Guard: refuse to launch with an empty prompt
      if (!input.prompt.trim()) {
        logger.warn({ group: group.name }, 'Skipping agent run: empty prompt');
        return { status: 'error', result: null, error: 'Empty prompt' };
      }

      // ─── Direct-LLM execution path ────────────────────────────────────────
      // When the resolved agent is an `llm:*` entry, run the task as a direct
      // OpenAI-compatible call from the board process instead of spawning a
      // sandbox container. Slot acquisition, the onSlotAcquired bookkeeping
      // above, and the active_run lifecycle below are all shared with the
      // sandbox path, so concurrency and run-tracking are identical — only the
      // execution mechanism differs. Chat runs never reach here for `llm:*`
      // agents (agent-runner branches to runDirectLlm before calling this), so
      // this covers tasks, cronjob-spawned tasks, and dataset tasks alike.
      const isLlm =
        !!input.agent_cmd &&
        input.agent_cmd.startsWith('llm:') &&
        !input.agent_cmd.endsWith('.sh');
      if (isLlm) {
        // Dependency/fork lineage must select the checkout base before the
        // Direct-LLM preparation creates the branch or worktree from it.
        await applyPreparedCheckout(input);
        await prepareDirectTaskCheckout(
          group,
          input,
          client,
          effectiveSandbox,
          stack,
          service,
          instance,
        );
        // DirectLLM preparation already synchronized and selected the task
        // branch under the checkout lease. The common preflight must not
        // inspect it as though it were still the default branch.
        input.skipBaseBranchSync = true;
      }
      if (isLlm) {
        await input.onCheckoutReady?.(input, { stack, service, instance });
        // Dynamic imports keep the top-level module graph unchanged (avoids any
        // import cycle through the chat/mcp layers from this lifecycle file).
        const [
          { getChatAgents },
          { directLlmFallbackOption, runDirectLlm: productionRunDirectLlm },
          { sharedDeps },
        ] = await Promise.all([
          import('../lib/chat-agents.js'),
          import('../modules/chat/direct-llm.js'),
          import('../mcp/mcp-deps.js'),
        ]);
        const executeDirectLlm = deps.runDirectLlm ?? productionRunDirectLlm;

        const agentCfg =
          input.runtimeConfig ||
          getChatAgents().find((a) => a.id === input.agent_cmd);
        const modelId =
          agentCfg?.model ||
          input.model ||
          input.agent_cmd!.slice('llm:'.length);
        const perms = await getAgentPermissionsResolved(
          group,
          registeredGroups,
        );
        const directTranscriptEntries: unknown[] = [];
        const directRunDir = input.isScheduledTask
          ? hostRunDir(input.group_folder, runId, instance, stack)
          : null;
        const directV1 = directRunDir ? carapaRunV1Paths(directRunDir) : null;
        let directV1Sequence = 0;
        let directV1Terminal = false;
        // Direct tool entries may lack an id: pair a result with its call by
        // tool name, in call order.
        const directPendingToolIds = new Map<string, string[]>();
        const writeDirectV1Event = (event: CarapaRunV1Event) => {
          if (directV1) {
            fs.appendFileSync(directV1.events, `${JSON.stringify(event)}\n`);
          }
        };
        const writeDirectV1Entry = (entry: any) => {
          if (entry?.type === 'thinking' && typeof entry.text === 'string') {
            writeDirectV1Event({
              type: 'thought',
              id: `thought-${++directV1Sequence}`,
              content: entry.text,
              status: 'completed',
            });
          } else if (
            entry?.type === 'message' &&
            (entry.role === 'user' || entry.role === 'assistant')
          ) {
            writeDirectV1Event({
              type: 'message',
              id: `message-${++directV1Sequence}`,
              role: entry.role,
              content: typeof entry.content === 'string' ? entry.content : '',
              status: 'completed',
            });
          } else if (entry?.type === 'tool_use' && entry.part) {
            const { part } = entry;
            const name = typeof part.tool === 'string' ? part.tool : '';
            const state = part.state ?? {};
            const running = state.status === 'running';
            const pending = directPendingToolIds.get(name) ?? [];
            const id =
              (typeof part.id === 'string' && part.id) ||
              (running ? '' : pending.shift()) ||
              `tool-${++directV1Sequence}`;
            if (running && !part.id) {
              directPendingToolIds.set(name, [...pending, id]);
            }
            const output =
              state.output === undefined
                ? undefined
                : typeof state.output === 'string'
                  ? state.output
                  : JSON.stringify(state.output);
            writeDirectV1Event({
              type: 'tool_call',
              id,
              status: running
                ? 'started'
                : state.status === 'error'
                  ? 'failed'
                  : 'completed',
              ...(name ? { name } : {}),
              ...(state.input === undefined ? {} : { input: state.input }),
              ...(output === undefined ? {} : { output }),
              ...(state.status === 'error' && output
                ? { error: { message: output } }
                : {}),
            });
          }
        };
        const appendDirectTranscriptEntry = (entry: unknown) => {
          if (
            directRunDir &&
            (entry as any)?.role === 'user' &&
            (entry as any)?.content === input.prompt &&
            directTranscriptEntries.some(
              (existing: any) =>
                existing?.role === 'user' && existing?.content === input.prompt,
            )
          ) {
            return;
          }
          directTranscriptEntries.push(entry);
          if (directV1) writeDirectV1Entry(entry);
        };
        if (directRunDir && directV1) {
          fs.mkdirSync(directRunDir, { recursive: true });
          fs.writeFileSync(path.join(directRunDir, 'prompt.txt'), input.prompt);
          fs.writeFileSync(
            directV1.manifest,
            JSON.stringify({
              format: 'carapa-run',
              version: 1,
              harness: input.agent_cmd!,
              requestedModel: modelId,
            }),
          );
          fs.writeFileSync(
            directV1.events,
            `${JSON.stringify({ type: 'run', status: 'started' })}\n`,
          );
          appendDirectTranscriptEntry({
            type: 'message',
            role: 'user',
            content: input.prompt,
          });
        }
        const preserveDirectScheduledTranscript = async (error?: string) => {
          if (!directRunDir) return;
          if (!directV1Terminal) {
            directV1Terminal = true;
            if (
              !directTranscriptEntries.some(
                (entry: any) => entry?.role === 'user',
              )
            ) {
              appendDirectTranscriptEntry({
                type: 'message',
                role: 'user',
                content: input.prompt,
              });
            }
            if (error) {
              writeDirectV1Event({
                type: 'error',
                message: error,
                fatal: true,
              });
              writeDirectV1Event({
                type: 'run',
                status: 'failed',
                error: { message: error },
              });
            } else {
              writeDirectV1Event({ type: 'run', status: 'completed' });
            }
          }
          await cleanupRunDir(
            directRunDir,
            undefined,
            input.group_folder,
            undefined,
            undefined,
            true,
            stack,
            service,
            input.agent_cmd,
            instance,
            sandboxObservationRoot(),
            true,
            true,
          );
        };

        // Mirror the sandbox path's active_run lifecycle so the UI running
        // indicator and crash recovery behave identically.
        await insertActiveRunForLaunch(input, {
          id: runId,
          group_folder: input.group_folder,
          chat_jid: input.chat_jid,
          session_id: input.session_id || null,
          conversation_id: input.conversation_id || null,
          isMain: input.isMain ? 1 : 0,
          isScheduledTask: input.isScheduledTask ? 1 : 0,
          scheduled_task_id: input.scheduled_task_id || null,
          task_id: input.task_id || null,
          sandbox_stack: stack,
          sandbox_service: service,
          sandbox_instance: instance,
          started_at: new Date().toISOString(),
          timeout_at: new Date(timeout_at).toISOString(),
          status: 'running',
          model: input.model || null,
          runtime_variant: persistentVariantTag(
            input.agent_cmd || AGENT_CMD,
            input.model,
            input.env,
            input.worktree_path,
          ),
          agent_name: input.transcript_agent_name
            ? input.agent_cmd || AGENT_CMD
            : input.session_agent_key || input.agent_cmd || AGENT_CMD,
          session_agent_key:
            input.session_agent_key || input.agent_cmd || AGENT_CMD,
          tok_total: null,
          tok_output: null,
          tok_input: null,
          tok_cache_write: null,
          tok_cache_read: null,
          tok_context_last: null,
          model_name: null,
          tool_usage_count: null,
          stage: input.activeRunStageId ?? input.stage_id ?? task?.status ?? '',
          triggeredByUserId: input.triggeredByUserId ?? null,
          // This row is being created now. Missing causal context means a new
          // automated/system run, never an unrecoverable historical run.
          triggerSource: input.triggerSource ?? 'system',
        });
        currentProcessRunIds.add(runId);
        launch.settle();
        await input.onActiveRunCreated?.(runId);

        // Notify the task pipeline only after its active_runs row exists. The
        // callback broadcasts task_started and appends the run divider; doing it
        // before this insert lets the UI refetch Runs too early and miss a
        // follow-up run (notably immediately after review rejection).
        await input.onSlotAcquired?.(runId);

        try {
          const res = await executeDirectLlm(
            input.systemPrompt || 'You are a helpful assistant.',
            input.prompt,
            modelId,
            (chunk) => onChunk?.(chunk),
            [],
            [],
            {
              wireApi: agentCfg?.wireApi,
              baseUrl:
                agentCfg?.baseUrl ||
                agentCfg?.env?.OPENAI_BASE_URL ||
                agentCfg?.env?.ANTHROPIC_BASE_URL,
              apiKey: agentCfg?.apiKey,
              temperature: agentCfg?.temperature,
              max_tokens: agentCfg?.max_tokens,
              top_p: agentCfg?.top_p,
              top_k: agentCfg?.top_k,
              frequency_penalty: agentCfg?.frequency_penalty,
              presence_penalty: agentCfg?.presence_penalty,
              extra_body: agentCfg?.extra_body,
              reasoning_effort: resolveDirectReasoningEffort(input, agentCfg),
              maxContextTokens: agentCfg?.context_size,
              signal: input.signal,
              image: agentCfg?.image,
              audio: agentCfg?.audio,
              video: agentCfg?.video,
              agent_id: input.agent_cmd,
              allowedToolNames: input.allowedToolNames,
              run_id: runId,
              fallback: directLlmFallbackOption(agentCfg),
              privacy: { projectId: input.group_folder, purpose: 'agent' },
              onStarted: async () => {
                await input.onRunLaunched?.(runId);
                await input.onPromptRunAssigned?.(runId);
              },
            },
            sharedDeps,
            (entry) => appendDirectTranscriptEntry(entry),
            undefined, // session_id — direct LLM is stateless
            input.group_folder,
            input.task_id,
            perms,
            input.conversation_id,
          );
          const directStats = {
            result: res.result,
            model_name: res.model_name ?? modelId,
            total_tokens: res.total_tokens,
            tok_output: res.tok_output,
            tok_input: res.tok_input,
            tok_cache_write: res.tok_cache_write,
            tok_cache_read: res.tok_cache_read,
            tok_context_last: res.tok_context_last,
          };
          if (
            directRunDir &&
            !directTranscriptEntries.some(
              (entry: any) => entry?.role === 'assistant',
            )
          ) {
            appendDirectTranscriptEntry({
              type: 'message',
              role: 'assistant',
              content: res.result,
            });
          }
          await preserveDirectScheduledTranscript();
          await persistRunCompletionBeforePromptAcceptance(
            runId,
            'completed',
            () => completeActiveRun(runId, 'completed', directStats),
            input.onPromptRunAccepted,
          );
          await updateRunStats(runId, directStats);
          currentProcessRunIds.delete(runId);
          return {
            status: 'success',
            result: res.result,
            model_name: res.model_name ?? modelId,
            total_tokens: res.total_tokens,
            tok_output: res.tok_output,
            tok_input: res.tok_input,
            sandbox_instance: instance,
            activeRunId: runId,
          };
        } catch (err: any) {
          const aborted =
            input.signal?.aborted ||
            err?.name === 'AbortError' ||
            err?.name === 'APIUserAbortError';
          await preserveDirectScheduledTranscript(
            err?.message || (aborted ? 'Aborted' : 'LLM error'),
          );
          await completeActiveRun(runId, 'error');
          currentProcessRunIds.delete(runId);
          if (aborted) {
            return {
              status: 'error',
              result: null,
              error: 'Aborted',
              activeRunId: runId,
            };
          }
          logger.error(
            { err, agent_cmd: input.agent_cmd, task_id: input.task_id },
            'Direct LLM task run failed',
          );
          return {
            status: 'error',
            result: null,
            error: err?.message || 'LLM error',
            activeRunId: runId,
          };
        }
      }
      // ─── end Direct-LLM path ──────────────────────────────────────────────

      if (existingRun) {
        // Mark the adopted run as owned by the current process so that
        // recoverOrphanedRuns() (which runs later) skips it. Without this,
        // both the adoption path and recovery would poll the same directory,
        // and the first to finish + cleanup would cause the other to throw
        // "Run directory disappeared".
        currentProcessRunIds.add(existingRun.id);
        launch.settle();
        logger.info(
          { runId: existingRun.id, group: group.name, instance },
          'Found existing run for instance, adopting it',
        );
        const hostDir = hostRunDir(
          input.group_folder,
          existingRun.id,
          instance,
          stack,
        );
        // Use remaining time until deadline as the inactivity timeout, but at least 60s.
        // Chat runs: disable the hard deadline (see main path for rationale).
        const remainingMs = input.task_id
          ? Math.max(
              new Date(existingRun.timeout_at).getTime() - Date.now(),
              60_000,
            )
          : Infinity;

        let result: {
          events: string;
          stderr?: string;
          isError: boolean;
          userInputRequest: boolean;
          intentionalUserInputInterrupt: boolean;
          metrics?: RunMetrics | null;
        };
        const adoptStallCfg = await resolveStallConfig(group, input.task_id);
        const adoptStallOpts = buildStallOpts(
          existingRun.id,
          input.group_folder,
          input.task_id,
          input.conversation_id,
          adoptStallCfg.stallMs,
          adoptStallCfg.graceMs,
          buildPidAliveProbe(
            client,
            existingRun.sandbox_stack,
            existingRun.sandbox_service,
            existingRun.sandbox_instance ?? instance,
          ),
        );
        try {
          result = await waitForRun(
            hostDir,
            remainingMs,
            onChunk,
            input.signal,
            adoptStallOpts,
            onToolUse,
          );
          const existingTarget = input.ephemeral
            ? undefined
            : input.task_id
              ? outputTranscriptPath(input.group_folder, input.task_id)
              : chatTranscriptPath(
                  input.group_folder,
                  input.session_id,
                  input.conversation_id,
                );
          const canonicalCompletion = prepareCanonicalRunCompletion(
            existingRun.id,
            result.metrics,
            hostDir,
          );
          const { agentResult } = canonicalCompletion;
          let transcriptOffset = 0;
          if (existingTarget) {
            try {
              transcriptOffset = lstatGroupPathSync(existingTarget)?.size ?? 0;
            } catch {
              /* the recovered output may create the transcript */
            }
          }
          await cleanupRunDir(
            hostDir,
            existingTarget,
            input.group_folder,
            transcriptOffset,
            wsRoot,
            input.skipTranscriptMemory,
            stack,
            service,
            input.transcript_agent_name ||
              existingRun.agent_name ||
              input.agent_cmd,
            instance,
            sandboxObservationRoot(),
            input.ephemeral,
            input.isScheduledTask,
          );
          const output = buildOutput(result, agentResult, input.group_folder);
          await canonicalCompletion.persist(
            completionStatusForRun(result, output),
            agentResult.session_id || input.session_id || undefined,
          );
          await updateRunStats(existingRun.id, agentResult).catch((error) => {
            logger.warn(
              { runId: existingRun.id, error: String(error) },
              'Failed to persist adopted run token breakdown',
            );
          });
          currentProcessRunIds.delete(existingRun.id);
          return {
            ...output,
            transcriptTarget: existingTarget,
            transcriptOffset,
            workspaceRoot: wsRoot,
            sandboxInstance: instance,
            sandbox_instance: instance,
          };
        } catch (err) {
          await completeActiveRun(
            existingRun.id,
            err instanceof StalledError ? 'stalled' : 'error',
          );
          currentProcessRunIds.delete(existingRun.id);
          // Stop the still-running agent (as the main path does) so a stalled
          // or timed-out adopted run does not keep working in the checkout.
          // Keep the stalled/error status written above.
          const adoptedRun = await getActiveRunById(existingRun.id);
          if (adoptedRun) {
            await killRun(adoptedRun, { preserveTerminalState: true }).catch(
              (kerr) => {
                logger.warn(
                  { runId: existingRun.id, error: String(kerr) },
                  'Failed to kill adopted agent after timeout',
                );
              },
            );
          }
          const existingTarget = input.ephemeral
            ? undefined
            : input.task_id
              ? outputTranscriptPath(input.group_folder, input.task_id)
              : chatTranscriptPath(
                  input.group_folder,
                  input.session_id,
                  input.conversation_id,
                );
          await cleanupRunDir(
            hostDir,
            existingTarget,
            input.group_folder,
            undefined,
            wsRoot,
            input.skipTranscriptMemory,
            stack,
            service,
            input.transcript_agent_name ||
              existingRun.agent_name ||
              input.agent_cmd,
            instance,
            sandboxObservationRoot(),
            input.ephemeral,
            input.isScheduledTask,
          );
          throw err;
        }
      }

      const startTime = Date.now();

      logger.info(
        {
          group: group.name,
          stack,
          service,
          instance,
          isMain: input.isMain,
          hasSession: !!input.session_id,
        },
        'Running agent via MCP sandbox',
      );

      // Build env for sandbox start/restart.
      //
      // Whenever this path actually (re)starts the stack we must push a *fresh*,
      // sandbox-lifecycle-bound CARAPA_BOARD_API_TOKEN into its env — exactly like
      // the cold-start paths in reconcileSandboxPool and group-bootstrap. The
      // api-relay injects this token as the agent's Authorization header (the agent
      // never holds it itself), so a stack started here with a bare buildSandboxEnv
      // (no token) would boot run-agent.sh against a stale/absent token and the
      // agent's first call back to the board would be rejected.
      //
      // The token is minted lazily the first time buildStartEnv is invoked and then
      // reused: on the common warm path (sandbox already running, no restart) it is
      // never called, so there is no per-spawn token churn. Restarting only happens
      // when the sandbox is down or its mount went stale. Only sandbox-level
      // tokens are revoked: run-scoped tokens (this run's own, minted before a
      // stopped/stale-mount relaunch, and concurrent runs') must stay valid.
      let freshAgentToken: string | undefined;
      const credentialGroup = resolveEffectiveSandbox(group).owner;
      const buildStartEnv = async (): Promise<Record<string, string>> => {
        if (!freshAgentToken && !fixedInstance) {
          await revokeGroupTokens(credentialGroup.folder, {
            sandboxLevelOnly: true,
          });
          const perms = await getAgentPermissionsResolved(
            credentialGroup,
            registeredGroups,
          );
          freshAgentToken = await generateAgentToken(
            { group_folder: credentialGroup.folder, permissions: perms },
            null,
          );
        }
        return freshAgentToken
          ? {
              ...buildSandboxEnv(credentialGroup, stack),
              CARAPA_BOARD_API_TOKEN: freshAgentToken,
            }
          : buildSandboxEnv(credentialGroup, stack);
      };

      const groupIpcBase = hostIpcDir(input.group_folder, instance, stack);

      // Ensure sandbox is running (check the per-group instance)
      // Skip auto-start for fixed instances — they are managed externally.
      if (!fixedInstance) {
        // A Compose project can remain "running" because a sidecar is alive
        // while the configured agent service has exited. Git and agent launch
        // both target that service, so readiness must be scoped to it.
        const sbStatus = await client.sandboxStatus(stack, instance, service);
        const needsStart = !isSandboxRunning(sbStatus);
        if (needsStart) {
          if (effectiveSandbox.inherited) {
            await completeActiveRun(runId, 'error');
            logger.warn(
              {
                group: input.group_folder,
                sandboxOwner: effectiveSandbox.owner.folder,
                stack,
                instance,
                statusError: sbStatus.isError,
                status: sbStatus.stdout.slice(0, 200),
              },
              'Inherited child run cannot start unavailable parent-owned sandbox',
            );
            return {
              status: 'error',
              result: null,
              error: `Parent-owned sandbox is unavailable; start it through project "${effectiveSandbox.owner.folder}"`,
            };
          }

          // Pre-create the bind-mount source before Docker starts the stack. If
          // this stopped instance has a legacy root-owned IPC tree, archive it
          // and recreate a writable directory so on-demand startup can recover.
          ensureIpcRunsDir(groupIpcBase, true);
          const ipcProject = path.basename(groupIpcBase);
          try {
            await ipcReplica.prepareRuns(ipcProject, true);
          } catch (err) {
            if (!ipcReplica.isLocalProject(ipcProject)) {
              const error = remoteIpcPreparationError(ipcProject, err);
              logger.error({ err, stack, instance }, error.message);
              await completeActiveRun(runId, 'error');
              return { status: 'error', result: null, error: error.message };
            }
            logger.warn(
              { err, stack, instance },
              'Box-side IPC preparation failed; starting anyway',
            );
          }
          logger.info(
            { stack, instance, reason: sbStatus.stdout.slice(0, 200) },
            'Sandbox not running, starting...',
          );
          const startResult = await client.sandboxStart(
            stack,
            await buildStartEnv(),
            instance,
            service,
          );
          if (startResult.isError) {
            await completeActiveRun(runId, 'error');
            return {
              status: 'error',
              result: null,
              error: `Failed to start sandbox: ${startResult.stdout}`,
            };
          }
          logger.info({ stack, instance }, 'Sandbox started');
        } else {
          // Never replace IPC storage underneath a running container.
          ensureIpcRunsDir(groupIpcBase, false);
        }
      } else {
        ensureIpcRunsDir(groupIpcBase, false);
      }
      const repositoryBacked = Boolean(
        input.localRepo ||
        group.settings?.repositoryLocation ||
        group.settings?.repositoryUrl ||
        group.settings?.repositoryRelativePath,
      );
      // Conversations deliberately share the checkout as-is and never mutate
      // its branch. A task may therefore own the checkout lease and have its
      // branch checked out while chat agents continue to run independently.
      // Default-branch drift validation only protects non-chat executions that
      // are expected to operate from the project checkout without a task branch.
      if (
        !isChat &&
        repositoryBacked &&
        !input.worktree_path &&
        !input.branch_name
      ) {
        const status = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, 'status --porcelain=v1'),
          instance,
          service,
        );
        const branch = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, 'branch --show-current'),
          instance,
          service,
        );
        const expectedBranch = group.settings?.defaultBranch || 'develop';
        if (
          status.isError ||
          branch.isError ||
          branch.stdout.trim() !== expectedBranch
        ) {
          throw new Error(
            `Shared checkout drift detected before agent launch (branch=${branch.stdout.trim() || 'detached'})`,
          );
        }
      }
      await recoverExistingWorktreePath(
        group,
        input,
        client,
        effectiveSandbox,
        stack,
        service,
        instance,
      );

      // Branch mode mutates the shared checkout and validates it under the
      // project lease. Worktree setup is isolated: CarapaBox creates or reuses
      // it with Git's repository locks and performs remote refresh best-effort.
      // It must not inspect or synchronize the unrelated shared working tree.
      if (
        group.settings?.taskCheckoutMode === 'branch' &&
        !input.worktreeRequested &&
        input.branch_name &&
        !input.worktree_path &&
        !input.skipBaseBranchSync
      ) {
        const expectedMainBranch = group.settings?.defaultBranch || 'develop';
        const status = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, 'status --porcelain=v1'),
          instance,
          service,
        );
        const branch = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, 'branch --show-current'),
          instance,
          service,
        );
        if (
          !branchCheckoutStateIsSafe(
            status,
            branch,
            expectedMainBranch,
            input.branch_name,
          )
        ) {
          throw new Error(
            `Shared checkout drift detected before branch setup (branch=${branch.stdout.trim() || 'detached'})`,
          );
        }
      }

      await applyPreparedCheckout(input);

      // Per-worktree nginx preview port. carapa-box allocates it (the
      // nginx-wt/<branch>.conf registry) and reports `preview_port=<n>` in the
      // sandbox_worktree:add result, for both fresh-create and reuse. Undefined
      // when the stack opts out (no nginx-wt.conf.tmpl) or not worktree mode.
      let previewPort: number | undefined;
      const parsePreviewPort = (stdout: string) => {
        const pm = stdout.match(/^preview_port=(\d+)$/m);
        if (pm) previewPort = parseInt(pm[1], 10);
      };

      if (input.worktree_path && input.branch_name && input.localRepo) {
        const reuseStartedAt = Date.now();
        const reused = await client.sandboxWorktree(stack, 'reuse', {
          branch: input.branch_name,
          instance,
          localRepo: input.localRepo,
          repoPath: effectiveSandbox.inherited
            ? effectiveSandbox.workspaceRoot
            : undefined,
          service,
          remoteUrl: effectiveRemoteUrl(effectiveSandbox),
        });
        if (reused.isError) {
          // In particular, an older Box rejecting this action must not cause
          // a silent fallback to the expensive, mutating add operation.
          throw new Error(`Unable to reuse task worktree: ${reused.stdout}`);
        }
        if (reused.stdout.trim() === 'worktree_missing=1') {
          input.worktree_path = undefined;
        } else {
          const reusedPath = reused.stdout.match(/^worktree_path=(.+)$/m)?.[1];
          if (!reusedPath)
            throw new Error('Worktree reuse returned no worktree_path');
          input.worktree_path = reusedPath;
          parsePreviewPort(reused.stdout);
        }
        logger.info(
          {
            task_id: input.task_id,
            branch: input.branch_name,
            durationMs: Date.now() - reuseStartedAt,
            missing: !input.worktree_path,
          },
          '[git-sandbox] Existing worktree validation finished',
        );
      }

      // Branch setup: worktree mode vs checkout mode.
      // If localRepo is set and branch_name is provided, try to create a worktree now that the
      // sandbox is running. This replaces the pre-creation in task-executor which ran before
      // the container was up and always failed.
      if (
        (group.settings?.taskCheckoutMode === 'worktree' ||
          input.worktreeRequested) &&
        !input.worktree_path &&
        input.branch_name &&
        input.localRepo
      ) {
        try {
          const baseBranch =
            input.branchBaseCommit ||
            input.branchBaseName ||
            group.settings?.defaultBranch ||
            'develop';
          const wtResult = await withTaskWorktreePreparation(
            input.task_id,
            input.group_folder,
            () =>
              client.sandboxWorktree(stack, 'add', {
                branch: input.branch_name!,
                // Chats branch from the repository's current HEAD. Omitting
                // base also prevents CarapaBox's optional remote-base refresh,
                // so dirty shared files are irrelevant and never copied into
                // the worktree.
                base: input.task_id ? baseBranch : undefined,
                instance,
                localRepo: input.localRepo,
                repoPath: effectiveSandbox.inherited
                  ? effectiveSandbox.workspaceRoot
                  : undefined,
                symlinkFiles: input.worktreeFiles,
                service,
                remoteUrl: effectiveRemoteUrl(effectiveSandbox),
              }),
          );
          if (!wtResult.isError) {
            parsePreviewPort(wtResult.stdout);
            const match = wtResult.stdout.match(/^worktree_path=(.+)$/m);
            if (match?.[1]) {
              input.worktree_path = match[1];
              if (input.task_id) {
                await updateTask(input.task_id, { worktree_path: match[1] });
              } else if (
                input.checkoutConversationId ||
                input.conversation_id
              ) {
                await updateConversationWorktreePath(
                  (input.checkoutConversationId || input.conversation_id)!,
                  match[1],
                );
              }
              logger.info(
                {
                  group: group.name,
                  branch: input.branch_name,
                  worktree: match[1],
                },
                '[git-sandbox] Created worktree',
              );
            } else {
              throw new Error('Worktree creation returned no worktree_path');
            }
          } else {
            const wtError =
              wtResult.stdout || 'Unknown worktree creation error';
            if (usesWorktree) {
              // Worktree isolation is mandatory in worktree mode.
              // Falling back to checkout on the main repo would write code on the wrong branch.
              logger.error(
                {
                  group: group.name,
                  branch: input.branch_name,
                  error: wtError,
                },
                '[git-sandbox] Worktree creation failed — aborting task (worktree mode requires isolation)',
              );
              throw new Error(
                `Worktree creation failed for branch "${input.branch_name}": ${wtError}. Check if the branch already exists or if the sandbox is healthy.`,
              );
            }
            logger.warn(
              { group: group.name, branch: input.branch_name, error: wtError },
              '[git-sandbox] Failed to create worktree, falling back to checkout',
            );
          }
        } catch (err) {
          if (usesWorktree) {
            // The mandatory-isolation branch above deliberately throws so the
            // outer lifecycle guard finalizes active_runs. Do not wrap that
            // already-actionable error a second time in this local catch.
            if (
              err instanceof Error &&
              err.message.startsWith('Worktree creation failed for branch')
            ) {
              throw err;
            }
            logger.error(
              {
                group: group.name,
                branch: input.branch_name,
                error: String(err),
              },
              '[git-sandbox] Worktree creation threw — aborting task (worktree mode requires isolation)',
            );
            throw new Error(
              `Worktree creation failed for branch "${input.branch_name}": ${String(err)}. Check if the branch already exists or if the sandbox is healthy.`,
            );
          }
          logger.warn(
            {
              group: group.name,
              branch: input.branch_name,
              error: String(err),
            },
            '[git-sandbox] Worktree creation threw, falling back to checkout',
          );
        }
      }

      // In worktree mode, the sandbox is already mounted to the correct worktree directory —
      // no git checkout needed. In checkout mode (GIT_REPO or no worktree), we switch branches
      // via git commands inside the running container.
      const restoreDefaultCheckout = async (): Promise<void> => {
        const defaultBranch = group.settings?.defaultBranch || 'develop';
        const restored = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, `checkout ${defaultBranch}`),
          instance,
          service,
        );
        if (restored.isError) {
          logger.warn(
            {
              group: group.name,
              branch: defaultBranch,
              error: restored.stdout,
            },
            '[git-sandbox] Could not restore default checkout after setup failure',
          );
        }
      };
      if (input.requireIsolatedWorktree && !input.worktree_path) {
        // Never switch branches on the shared checkout for an experiment card:
        // it would share a workspace with its siblings.
        throw new Error(ISOLATED_WORKTREE_REQUIRED_ERROR);
      }
      if (input.worktree_path) {
        logger.info(
          {
            group: group.name,
            branch: input.branch_name,
            worktree: input.worktree_path,
          },
          '[git-sandbox] Worktree mode — sandbox mounted to worktree, skipping checkout',
        );
      } else if (input.branch_name) {
        // Branch setup can switch the repository root to a dependency base or
        // task branch. Always restore the clean default checkout on failure.
        try {
          await withProjectGitLock(input.group_folder, async () => {
            const baseBranch =
              input.branchBaseCommit ||
              input.branchBaseName ||
              group.settings?.defaultBranch ||
              'develop';
            const expectedMainBranch =
              group.settings?.defaultBranch || 'develop';
            const statusBefore = await client.sandboxGit(
              stack,
              effectiveGitArgs(effectiveSandbox, 'status --porcelain=v1'),
              instance,
              service,
            );
            const branchBefore = await client.sandboxGit(
              stack,
              effectiveGitArgs(effectiveSandbox, 'branch --show-current'),
              instance,
              service,
            );
            const currentBranch = branchBefore.stdout.trim();
            if (
              !branchCheckoutStateIsSafe(
                statusBefore,
                branchBefore,
                expectedMainBranch,
                input.branch_name!,
              )
            ) {
              throw new Error(
                `Shared checkout drift detected before branch checkout (branch=${currentBranch || 'detached'})`,
              );
            }
            if (currentBranch !== input.branch_name) {
              const baseResult = await client.sandboxGit(
                stack,
                effectiveGitArgs(effectiveSandbox, `checkout ${baseBranch}`),
                instance,
                service,
              );
              if (baseResult.isError)
                throw new Error(`Unable to checkout base ${baseBranch}`);
              const checkoutResult = await client.sandboxGit(
                stack,
                effectiveGitArgs(
                  effectiveSandbox,
                  `checkout ${input.branch_name}`,
                ),
                instance,
                service,
              );
              if (checkoutResult.isError) {
                let createResult = await client.sandboxGit(
                  stack,
                  effectiveGitArgs(
                    effectiveSandbox,
                    `checkout -b ${input.branch_name}`,
                  ),
                  instance,
                  service,
                );
                for (
                  let attempt = 1;
                  createResult.isError && attempt < 3;
                  attempt++
                ) {
                  logger.warn(
                    {
                      group: group.name,
                      branch: input.branch_name,
                      attempt,
                      error: createResult.stdout,
                    },
                    '[git-sandbox] Retrying task branch creation',
                  );
                  await sleep(50);
                  createResult = await client.sandboxGit(
                    stack,
                    effectiveGitArgs(
                      effectiveSandbox,
                      `checkout -b ${input.branch_name}`,
                    ),
                    instance,
                    service,
                  );
                }
                if (createResult.isError)
                  throw new Error(
                    `Unable to create task branch ${input.branch_name}`,
                  );
              }
            }
            const branchAfter = await client.sandboxGit(
              stack,
              effectiveGitArgs(effectiveSandbox, 'branch --show-current'),
              instance,
              service,
            );
            const statusAfter = await client.sandboxGit(
              stack,
              effectiveGitArgs(effectiveSandbox, 'status --porcelain=v1'),
              instance,
              service,
            );
            if (
              !branchCheckoutStateIsSafe(
                statusAfter,
                branchAfter,
                expectedMainBranch,
                input.branch_name!,
              )
            ) {
              throw new Error(
                `Shared checkout drift detected after branch checkout (branch=${branchAfter.stdout.trim() || 'detached'})`,
              );
            }
          });
        } catch (error) {
          await restoreDefaultCheckout().catch(() => undefined);
          throw error;
        }
      } else {
        logger.info(
          {
            group: group.name,
            taskCheckoutMode: group.settings?.taskCheckoutMode,
          },
          '[git-sandbox] No branch_name in input — skipping branch checkout',
        );
      }
      try {
        if (input.requiredDependencyCommits?.length) {
          const gitPrefix = input.worktree_path
            ? `-C .worktrees/${input.branch_name} `
            : '';
          for (const commit of input.requiredDependencyCommits) {
            if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
              throw new Error(`Invalid dependency commit ${commit}`);
            }
            const ancestry = await client.sandboxGit(
              stack,
              effectiveGitArgs(
                effectiveSandbox,
                `${gitPrefix}merge-base --is-ancestor ${commit} HEAD`,
              ),
              instance,
              service,
            );
            if (ancestry.isError) {
              throw new Error(
                dependencyCommitMissingMessage(
                  input,
                  commit,
                  'task checkout',
                  group.settings?.defaultBranch || 'develop',
                ),
              );
            }
          }
        }
      } catch (error) {
        if (!input.worktree_path) {
          await restoreDefaultCheckout().catch(() => undefined);
        }
        throw error;
      }
      await input.onCheckoutReady?.(input, { stack, service, instance });
      // Track in database immediately so running:true is visible before launchBackground.
      await insertActiveRunForLaunch(input, {
        id: runId,
        group_folder: input.group_folder,
        chat_jid: input.chat_jid,
        session_id: input.session_id || null,
        conversation_id: input.conversation_id || null,
        isMain: input.isMain ? 1 : 0,
        isScheduledTask: input.isScheduledTask ? 1 : 0,
        scheduled_task_id: input.scheduled_task_id || null,
        task_id: input.task_id || null,
        sandbox_stack: stack,
        sandbox_service: service,
        sandbox_instance: instance,
        started_at: new Date().toISOString(),
        timeout_at: new Date(timeout_at).toISOString(),
        status: 'running',
        model: input.model || null,
        runtime_variant: persistentVariantTag(
          input.agent_cmd || AGENT_CMD,
          input.model,
          input.env,
          input.worktree_path,
        ),
        agent_name: input.transcript_agent_name
          ? input.agent_cmd || AGENT_CMD
          : input.session_agent_key || input.agent_cmd || AGENT_CMD,
        session_agent_key:
          input.session_agent_key || input.agent_cmd || AGENT_CMD,
        tok_total: null,
        tok_output: null,
        tok_input: null,
        tok_cache_write: null,
        tok_cache_read: null,
        tok_context_last: null,
        model_name: null,
        tool_usage_count: null,
        stage: input.task_id
          ? (input.activeRunStageId ?? input.stage_id ?? task?.status ?? '')
          : '',
        triggeredByUserId: input.triggeredByUserId ?? null,
        triggerSource: input.triggerSource ?? 'system',
      });
      currentProcessRunIds.add(runId);
      launch.settle();
      await input.onActiveRunCreated?.(runId);
      // The task callback emits the chat run divider and task_started event.
      // Insert first so the Runs tab's event-driven refetch can see this run.
      await input.onSlotAcquired?.(runId);

      // Launch agent in background
      const hostDir = hostRunDir(input.group_folder, runId, instance, stack);

      // Create host-side run directory
      fs.mkdirSync(hostDir, { recursive: true });

      logger.debug(
        {
          runId,
          hasSession: !!input.session_id,
          model: input.model,
          agent_cmd: input.agent_cmd,
          hasSystemPrompt: !!input.systemPrompt,
          systemPrompt: input.systemPrompt,
        },
        'Launching agent in background',
      );

      // Build stages summary for agent context
      const stagesSummary = input.task_id
        ? getGroupStages(group)
            .filter((s) => !s.inactive)
            .map((s) => `${s.id}(${s.type})`)
            .join(',')
        : undefined;

      // Per-worktree preview URL. carapa-box assigns a dedicated nginx port per
      // worktree (generated server block in nginx-wt/<branch>.conf) and reports
      // it via `preview_port=` from sandbox_worktree:add. The agent reaches its
      // own worktree at http://nginx:<port>/ — nginx and the agent share a Docker
      // network so `nginx` resolves directly (in NO_PROXY, no DNS tricks).
      //
      // Single source of truth, fed to TWO transports (no env var — passing it
      // through the cross-container env chain never worked reliably):
      //  - the `.preview-url` file carapa-box writes into the worktree (read by
      //    the automated login/test scripts), and
      //  - the short note prepended to the agent prompt (below).
      // Per-worktree preview note — only when carapa-box allocated a port (stack
      // has nginx-wt.conf.tmpl). Stacks without preview support get no injection;
      // Browser/login helpers still fall back to http://nginx/ on their own when
      // a shared nginx exists and .preview-url is absent.
      const previewNote =
        previewPort && input.worktree_path
          ? `> **App preview URL for this run:** http://nginx:${previewPort}/\n` +
            `> Use this as the base URL for any browser testing. It is also in \`.preview-url\` at the working-tree root (the login scripts read it automatically).\n\n`
          : '';

      // Chat sessions stay conversation-scoped. ACP task sessions stay warm
      // only for active/coding stages and are keyed by task + stage + runtime
      // variant. Testing and review intentionally use fresh isolated ACP
      // processes; their stage-owned session ids may still be resumed for a
      // format-repair turn within that same stage.
      const persistentAgent = input.agent_cmd || AGENT_CMD;
      const runStageId = input.stage_id || task?.status || undefined;
      const runStage = runStageId
        ? findStage(recordStages, runStageId)
        : undefined;
      const persistentScope = resolvePersistentSessionScope({
        enabled: PERSISTENT_CLAUDE,
        agentCmd: persistentAgent,
        taskId: input.task_id,
        conversationId: input.conversation_id,
        worktreePath: input.worktree_path,
        stageId: runStageId,
        stageType: runStage?.type,
        model: input.model,
        env: input.env,
        mainPersonaGeneration: input.main_persona_generation,
        personaSessionRevision: input.persona_session_revision,
      });
      const persistentEligible = persistentScope.eligible;

      // The container lifecycle token has no immutable run identity. Give every
      // agent process its own originating-project/run token;
      // run-agent.sh exports args.env and .mcp.json forwards this token on the
      // run's MCP connection, for both shared and standalone sandboxes.
      const runAgentTokenPromise = mintRunScopedAgentToken(group, input, runId);
      const runAgentToken = await runAgentTokenPromise;
      const containerGroupDir = effectiveContainerGroupDir(group);
      const sharedSandbox =
        effectiveSandbox.owner.settings?.sandboxOwnership === 'shared';
      const runEnv = {
        ...(input.env || {}),
        CARAPA_BOARD_API_TOKEN: runAgentToken,
        ...(ENABLE_CODEX_PLAN_MODE ? { ENABLE_CODEX_PLAN_MODE: '1' } : {}),
        ...(sharedSandbox
          ? {
              CARAPA_GROUP_DIR: containerGroupDir,
            }
          : {}),
      };

      // Conversation browsers belong to the conversation/workspace, not a turn.
      // Task recording still uses an isolated run-owned browser. The identity
      // ignores `input.work_dir` (the agent's cwd override, e.g. an objective
      // folder): the Browser pane derives it from the conversation record, so
      // honouring the override would give the agent a session the pane cannot
      // show.
      const conversationBrowser =
        !input.task_id && input.conversation_id
          ? ensurePersistentBrowser({
              projectId: input.group_folder,
              conversationId: input.conversation_id,
              stack,
              service,
              instance,
              ...(await resolveConversationBrowserTarget(
                effectiveSandbox,
                { worktree_path: input.worktree_path },
                client,
              )),
              worktree: input.worktree_path || null,
            })
          : undefined;
      const conversationBrowserEnv = conversationBrowser
        ? await browserIdle.use(
            conversationBrowser,
            () => conversationBrowser.env,
          )
        : {};
      // The agent's cwd keeps honouring the override, which the browser
      // identity above no longer carries.
      const agentWorkDir =
        (conversationBrowser && input.work_dir && !input.worktree_path
          ? resolveBrowserWorkDir(effectiveSandbox, input)
          : undefined) ||
        conversationBrowserEnv.CARAPA_BROWSER_WORK_DIR ||
        resolveAgentWorkDir(effectiveSandbox, input);
      const launchArgs = {
        prompt:
          previewNote +
          (conversationBrowser
            ? `[Shared browser: an unviewed preview may expire while this conversation is idle. Run \`browser-open ${conversationBrowser.id} start\` to start or resume the project preview before using playwright-cli. Keep the managed session; do not launch a duplicate server.]\n\n`
            : '') +
          input.prompt,
        session_id: input.session_id,
        conversationKey: persistentScope.key,
        persistent: persistentEligible,
        conversation_id: input.conversation_id,
        model: input.model,
        fallback_model: input.fallback_model,
        reasoning_effort: input.reasoning_effort,
        fallback_reasoning_effort: input.fallback_reasoning_effort,
        // Recording stages arm lazy capture in the playwright-cli shim. The
        // first browser workflow starts video; Board still deterministically
        // stops and persists it in finally. Run-scoped paths isolate parallel
        // tasks and retries in the shared container.
        env: {
          ...runEnv,
          CARAPA_RECORD: recordingEnabled ? '1' : '0',
          CARAPA_BROWSER_RUN_ID: runId,
          CARAPA_BROWSER_SESSION_ID: '',
          CARAPA_BROWSER_WORK_DIR: '',
          CARAPA_BROWSER_CONTEXT_FILE: '',
          ...pwRecordingEnv(
            input.branch_name,
            sharedRecordingProject,
            input.task_id,
            runId,
          ),
          ...conversationBrowserEnv,
          ...remoteBrowserSessionEnv(input.env),
        },
        agent_cmd: input.agent_cmd,
        agent: input.agent,
        bare: input.bare,
        chat_mode: input.chat_mode,
        prompt_cache_ttl: input.prompt_cache_ttl,
        chat_jid: input.chat_jid,
        systemPrompt: input.systemPrompt,
        instance,
        task_id: input.task_id,
        objective_id: task?.objective_id ?? undefined,
        stages: stagesSummary,
        custom_values: group.settings?.custom_values,
        forkSession: input.forkSession,
        work_dir: agentWorkDir,
        group_dir: containerGroupDir,
        group,
        injectAgentContext: input.injectAgentContext,
        userCommand: input.userCommand,
        restartRecoveryRunId: input.restartRecoveryRunId,
      };

      const transcriptTarget = input.ephemeral
        ? undefined
        : input.task_id
          ? outputTranscriptPath(input.group_folder, input.task_id)
          : chatTranscriptPath(
              input.group_folder,
              input.session_id,
              input.conversation_id,
            );

      // A continuation prompt must have durable ownership before the detached
      // process can read it. If assignment persistence fails, the launch is
      // aborted and the prompt remains pending for a later run.
      try {
        await input.onPromptRunAssigned?.(runId);
      } catch (error) {
        await completeActiveRun(runId, 'error').catch(() => undefined);
        await cleanupRunDir(
          hostDir,
          transcriptTarget,
          input.group_folder,
          undefined,
          wsRoot,
          input.skipTranscriptMemory,
          stack,
          service,
          input.transcript_agent_name || input.agent_cmd,
          instance,
          sandboxObservationRoot(),
          input.ephemeral,
          input.isScheduledTask,
        );
        throw error;
      }

      try {
        await launchBackground(
          client,
          stack,
          service,
          hostDir,
          runId,
          input.group_folder,
          launchArgs,
        );
      } catch (err: any) {
        if (
          !fixedInstance &&
          !effectiveSandbox.inherited &&
          err.stoppedServiceError
        ) {
          // The stack can still report running when a sibling service (for
          // example nginx) is healthy but the selected agent service is down.
          // Try the service-aware start first so healthy siblings stay up.
          logger.warn(
            { stack, service, instance, error: err.message },
            'Sandbox agent service is stopped, starting service...',
          );
          const serviceStart = await client.sandboxStart(
            stack,
            await buildStartEnv(),
            instance,
            service,
          );
          let serviceRecovered = false;

          if (!serviceStart.isError) {
            try {
              await launchBackground(
                client,
                stack,
                service,
                hostDir,
                runId,
                input.group_folder,
                launchArgs,
              );
              logger.info(
                { stack, service, instance },
                'Sandbox agent service recovered, launch retried',
              );
              serviceRecovered = true;
            } catch (retryErr: any) {
              if (!retryErr.stoppedServiceError) throw retryErr;
              logger.warn(
                { stack, service, instance, error: retryErr.message },
                'Agent service start did not recover launch, restarting stack...',
              );
            }
          } else {
            logger.warn(
              { stack, service, instance, error: serviceStart.stdout },
              'Agent service start failed, restarting stack...',
            );
          }

          if (!serviceRecovered) {
            await client.sandboxStop(stack, instance);
            const restartResult = await client.sandboxStart(
              stack,
              await buildStartEnv(),
              instance,
              service,
            );
            if (restartResult.isError) {
              throw new Error(
                `Failed to restart sandbox: ${restartResult.stdout}`,
              );
            }
            logger.info(
              { stack, service, instance },
              'Sandbox restarted, retrying launch',
            );
            await launchBackground(
              client,
              stack,
              service,
              hostDir,
              runId,
              input.group_folder,
              launchArgs,
            );
          }
        } else if (
          err.staleMountError &&
          !fixedInstance &&
          !effectiveSandbox.inherited
        ) {
          // Stale bind mount — restart sandbox and retry once
          // Fixed instances are externally managed. Inherited children also
          // cannot restart here: that container may currently serve siblings.
          // The parent owner remains the only project allowed to recreate it.
          logger.warn(
            { stack, instance, error: err.message },
            'Stale sandbox mount detected, restarting sandbox...',
          );
          await client.sandboxStop(stack, instance);
          const restartResult = await client.sandboxStart(
            stack,
            await buildStartEnv(),
            instance,
            service,
          );
          if (restartResult.isError) {
            throw new Error(
              `Failed to restart sandbox: ${restartResult.stdout}`,
            );
          }
          logger.info(
            { stack, instance },
            'Sandbox restarted, retrying launch',
          );
          await launchBackground(
            client,
            stack,
            service,
            hostDir,
            runId,
            input.group_folder,
            launchArgs,
          );
        } else {
          throw err;
        }
      }
      try {
        await input.onRunLaunched?.(runId);
      } catch (error) {
        const launchedRun = await getActiveRunById(runId);
        if (launchedRun?.status === 'running') {
          await killRun(launchedRun).catch((killError) =>
            logger.warn(
              { runId, error: String(killError) },
              'Failed to terminate run after launch acknowledgement failure',
            ),
          );
        }
        await completeActiveRun(runId, 'error').catch(() => undefined);
        await cleanupRunDir(
          hostDir,
          transcriptTarget,
          input.group_folder,
          undefined,
          wsRoot,
          input.skipTranscriptMemory,
          stack,
          service,
          input.transcript_agent_name || input.agent_cmd,
          instance,
          sandboxObservationRoot(),
          input.ephemeral,
          input.isScheduledTask,
        );
        throw error;
      }

      // Watch for completion via host filesystem

      // Record current transcript size so the observer only processes new lines
      let transcriptOffset = 0;
      if (transcriptTarget) {
        try {
          transcriptOffset = lstatGroupPathSync(transcriptTarget)?.size ?? 0;
        } catch {
          /* file may not exist yet */
        }
      }

      // Append the user's raw message to the transcript immediately
      if (input.rawMessage && transcriptTarget) {
        const userEntry = {
          type: 'message',
          role: 'user',
          content: input.rawMessage,
          agent_name: input.agent_cmd,
          created_at: new Date().toISOString(),
        };
        // The append creates the transcripts directory itself, pinned.
        await appendTranscriptLines(transcriptTarget, [userEntry]);
      }

      // For chat runs (no task_id), register an AbortController so killChatAgentProcess
      // can immediately cancel waitForRun when the stop endpoint is hit.
      if (!input.task_id) {
        chatAbortController = new AbortController();
        // Abort any previous chat run's host-side waitForRun listener before
        // registering the new one.  This serialises host-side stream processing so
        // the old run's onChunk callbacks (including setConversationSessionId) stop
        // firing before the new run's waitForRun starts, preventing the old run
        // from writing its session_id into the new conversation's DB record.
        // Note: this aborts only the host-side Promise watcher; the container
        // process for the previous run continues until it exits naturally.
        const abortKey = chatAbortKey(
          input.group_folder,
          input.conversation_id,
          input.chat_jid,
        );
        const prevChatController = chatRunAbortControllers.get(abortKey);
        // A queued follow-up's dispatcher registered its controller under this
        // key and handed us its signal; aborting it would abort this very run.
        if (prevChatController && prevChatController.signal !== input.signal) {
          prevChatController.abort();
        }
        chatRunAbortControllers.set(abortKey, chatAbortController);

        // Chain the caller's signal (e.g. parent chat's abort controller passed
        // down by agent_query) into our own controller. Without this, the parent
        // pressing Stop only aborts the parent's waitForRun — the sub-run's
        // signal is the locally-created one above, which never fires, so the
        // sub-agent keeps running to completion.
        if (input.signal) {
          if (input.signal.aborted) {
            chatAbortController.abort();
          } else {
            input.signal.addEventListener(
              'abort',
              () => chatAbortController?.abort(),
              { once: true },
            );
          }
        }
      }
      const runSignal = chatAbortController?.signal ?? input.signal;

      let result: {
        events: string;
        stderr?: string;
        isError: boolean;
        userInputRequest: boolean;
        intentionalUserInputInterrupt: boolean;
        metrics?: RunMetrics | null;
      };
      const mainStallCfg = await resolveStallConfig(group, input.task_id);
      const mainStallOpts = buildStallOpts(
        runId,
        input.group_folder,
        input.task_id,
        input.conversation_id,
        mainStallCfg.stallMs,
        mainStallCfg.graceMs,
        buildPidAliveProbe(client, stack, service, instance),
      );
      // A Codex requestUserInput RPC is a live turn, not a terminal boundary.
      // waitForRun pauses the stall watchdog while it is pending; the question
      // endpoint answers the same app-server request and then resumes the guard.
      // Chat runs: disable the hard wall-clock deadline and inactivity timeout
      // in waitForRun — they kill agents that are actively producing output but
      // simply take longer than MCP_AGENT_TIMEOUT (10 min default). The stall
      // watchdog (idle-based, with grace period + WS warning) is the proper
      // mechanism for chat: it only fires when the agent goes genuinely silent.
      const chatTimeoutMs = input.task_id ? timeoutMs : Infinity;
      try {
        result = await waitForRun(
          hostDir,
          chatTimeoutMs,
          onChunk,
          runSignal,
          mainStallOpts,
          onToolUse,
        );
        // If waitForRun bailed out because of an abort (e.g. user pressed Stop
        // while a sub-agent invoked via agent_query was running), the agent
        // process inside the sandbox is still alive. Kill it explicitly so it
        // doesn't keep consuming resources or writing to abandoned transcripts.
        if (isStopAbort(runSignal)) await killRunAfterAbort(runSignal, runId);
      } catch (err) {
        await completeActiveRun(
          runId,
          err instanceof StalledError ? 'stalled' : 'error',
        );
        // On timeout/error, attempt to kill the agent process in the sandbox
        // so it doesn't leak or keep writing to the transcript.
        const run = await getActiveRunById(runId);
        if (run) {
          await killRun(run, { preserveTerminalState: true }).catch((kerr) => {
            logger.warn(
              { runId, error: String(kerr) },
              'Failed to kill agent after timeout',
            );
          });
        }
        await cleanupRunDir(
          hostDir,
          transcriptTarget,
          input.group_folder,
          transcriptOffset,
          wsRoot,
          input.skipTranscriptMemory,
          stack,
          service,
          input.transcript_agent_name || input.agent_cmd,
          instance,
          sandboxObservationRoot(),
          input.ephemeral,
          input.isScheduledTask,
        );
        throw err;
      } finally {
        const persisted = await finalizeRunBrowser(
          {
            id: runId,
            group_folder: input.group_folder,
            task_id: input.task_id ?? null,
            sandbox_stack: stack,
            sandbox_service: service,
            sandbox_instance: instance,
          },
          client,
        );
        if (persisted > 0 && task)
          broadcast({
            type: 'task_updated',
            payload: { task_id: task.id, project_id: task.project_id },
          });
      }

      // Retry without --resume if session not found or cannot be resumed.
      // Skip the retry if the run was explicitly aborted (chatAbortController.signal.aborted)
      // to avoid re-launching the agent immediately after a user-initiated stop.
      // IMPORTANT: The regex must be specific enough to avoid false positives.
      // Stream-json output always contains "session_id" in the init line, so a broad
      // /session/i match would trigger on EVERY error when a session_id was provided.
      // Only match actual session-not-found/unresumable error messages from Claude Code / agent CLIs.
      // Also catches thinking.signature errors from the Anthropic API when resuming older sessions
      // that predate the requirement for the thinking.signature field.
      const persistentDiagnostic = persistentEligible
        ? readPersistentSessionDiagnostic(hostDir)
        : '';
      // Some agent wrappers exit zero even when their protocol terminates with
      // an explicit provider error. Include the parsed terminal signal here so
      // poisoned native sessions still take the fresh-session fallback.
      const protocolTerminalFailure = runV1TerminalFailure(hostDir);
      // Only a failed run can retry, so skip parsing the V1 tail otherwise.
      const v1ErrorText =
        result.isError || protocolTerminalFailure
          ? runV1ErrorText(result.events)
          : '';
      const isSessionUnresumable = shouldRetryUnresumableSession({
        agentCmd: persistentAgent,
        isError: result.isError,
        agentTerminalFailure: protocolTerminalFailure,
        sessionId: input.session_id,
        persistent: persistentEligible,
        aborted: chatAbortController?.signal.aborted ?? false,
        output: `${v1ErrorText}\n${result.stderr || ''}\n${persistentDiagnostic}`,
      });
      if (isSessionUnresumable && !input.restartRecoveryRunId) {
        logger.warn(
          {
            group: group.name,
            task_id: input.task_id,
            objective_id: task?.objective_id ?? undefined,
            session_id: input.session_id,
            conversation_key: launchArgs.conversationKey,
            persistent: persistentEligible,
          },
          'Session not resumable, retrying without --resume — starting a new session',
        );

        // A warm run can fail without input.session_id because run-agent.sh owns
        // the app-server thread behind conversationKey. Retire that daemon before
        // retrying; otherwise this turn may succeed ephemerally but the next turn
        // reconnects to the same poisoned thread. stop-agent.sh follows the run's
        // session_dir pointer and removes the warm session directory safely.
        if (persistentEligible) {
          // Persistent state survives ordinary daemon/container crashes. Only
          // this explicit, evidence-backed unresumable-session path may ask
          // stop-agent.sh to discard native provider history.
          try {
            writeRunMarkerSync(
              hostDir,
              'discard_session',
              'unresumable_session\n',
            );
          } catch (error) {
            logger.warn(
              { runId, error: String(error) },
              'Failed to mark poisoned warm session for explicit discard',
            );
          }
          const poisonedRun = await getActiveRunById(runId);
          if (poisonedRun) {
            const retired = await killRun(poisonedRun).catch((error) => {
              logger.warn(
                { runId, error: String(error) },
                'Failed to retire poisoned warm session before fresh retry',
              );
              return false;
            });
            if (!retired) {
              logger.warn(
                { runId, conversation_key: launchArgs.conversationKey },
                'Warm session retirement was not confirmed; fresh retry will remain ephemeral',
              );
            }
          }
        }

        // Surface the silent fallback to the user by writing a visible system message
        // to the task conversation so they know the session was lost and a new one started.
        if (input.task_id) {
          const task = await getTask(input.task_id);
          if (task) {
            const sysMsg = appendTaskMessage(task.project_id, {
              task_id: task.id,
              role: 'system',
              content:
                '⚠️ Session expired — could not resume previous conversation. Starting a new session.',
              created_at: new Date().toISOString(),
            });
            broadcast({
              type: 'task_message',
              payload: {
                task_id: task.id,
                project_id: task.project_id,
                message: sysMsg,
              },
            });
            await updateTask(task.id, { session_id: '' });
          }
        }

        await completeActiveRun(runId, 'error');
        await cleanupRunDir(
          hostDir,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          input.ephemeral,
        ); // No transcript — retry will produce the real output

        const retryRunId = generateRunId();
        effectiveRunId = retryRunId;
        // The retry is owned by this process too: mark it before its
        // active_runs row goes live. Without this, a concurrent run on the
        // same instance (chat runs share slot 0) sees the unmarked retry in
        // getActiveRunForOwnerInstance and adopts it — streaming this run's
        // output into the other conversation and never launching its own.
        currentProcessRunIds.add(retryRunId);
        const scopedCredentialPromise = mintRunScopedAgentToken(
          group,
          input,
          retryRunId,
        );
        let scopedCredential = '';
        await scopedCredentialPromise.then((value) => {
          scopedCredential = value;
        });
        const retryRunEnv = {
          ...runEnv,
          CARAPA_BOARD_API_TOKEN: scopedCredential,
        };

        // The retry is a distinct run — give it its own chat divider so its
        // output isn't lumped under the (errored) original run's marker.
        if (input.task_id) {
          const retryMarker = appendRunStartMarker(
            input.group_folder,
            input.task_id,
            retryRunId,
            {
              agent_name: input.agent_cmd || AGENT_CMD,
              created_at: new Date().toISOString(),
            },
          );
          broadcast({
            type: 'task_message',
            payload: {
              task_id: input.task_id,
              project_id: input.group_folder,
              message: retryMarker,
            },
          });
        }

        const retryHostDir = hostRunDir(
          input.group_folder,
          retryRunId,
          instance,
          stack,
        );
        fs.mkdirSync(retryHostDir, { recursive: true });

        await insertActiveRun({
          agent_ask_id: input.agent_ask_id,
          id: retryRunId,
          group_folder: input.group_folder,
          chat_jid: input.chat_jid,
          session_id: null,
          conversation_id: input.conversation_id || null,
          isMain: input.isMain ? 1 : 0,
          isScheduledTask: input.isScheduledTask ? 1 : 0,
          scheduled_task_id: input.scheduled_task_id || null,
          task_id: input.task_id || null,
          sandbox_stack: stack,
          sandbox_service: service,
          sandbox_instance: instance,
          started_at: new Date().toISOString(),
          timeout_at: new Date(timeout_at).toISOString(),
          status: 'running',
          model: input.model || null,
          runtime_variant: persistentVariantTag(
            input.agent_cmd || AGENT_CMD,
            input.model,
            input.env,
            input.worktree_path,
          ),
          agent_name: input.transcript_agent_name
            ? input.agent_cmd || AGENT_CMD
            : input.session_agent_key || input.agent_cmd || AGENT_CMD,
          session_agent_key:
            input.session_agent_key || input.agent_cmd || AGENT_CMD,
          tok_total: null,
          tok_output: null,
          tok_input: null,
          tok_cache_write: null,
          tok_cache_read: null,
          tok_context_last: null,
          model_name: null,
          tool_usage_count: null,
          stage: input.task_id
            ? (input.activeRunStageId ?? input.stage_id ?? task?.status ?? '')
            : '',
          triggeredByUserId: input.triggeredByUserId ?? null,
          triggerSource: input.triggerSource ?? 'system',
        });
        await input.onActiveRunCreated?.(retryRunId);

        const retryStallCfg = await resolveStallConfig(group, input.task_id);
        const retryStallOpts = buildStallOpts(
          retryRunId,
          input.group_folder,
          input.task_id,
          input.conversation_id,
          retryStallCfg.stallMs,
          retryStallCfg.graceMs,
          buildPidAliveProbe(client, stack, service, instance),
        );
        try {
          // The fresh process receives a distinct assignment. Persist it before
          // launch; a launch failure intentionally leaves it unreceipted.
          await input.onPromptRunAssigned?.(retryRunId);
          // Stop that landed while the retry was being prepared found no live
          // run to kill. Do not launch after it; waitForRun would never settle
          // on a run that has no process.
          if (isStopAbort(runSignal)) {
            await completeActiveRun(retryRunId, 'error');
            await cleanupRunDir(
              retryHostDir,
              transcriptTarget,
              input.group_folder,
              transcriptOffset,
              wsRoot,
              input.skipTranscriptMemory,
              stack,
              service,
              input.transcript_agent_name || input.agent_cmd,
              instance,
              sandboxObservationRoot(),
              input.ephemeral,
              input.isScheduledTask,
            );
            return {
              status: 'error',
              result: null,
              error: 'Aborted',
              stoppedByUser: true,
              activeRunId: retryRunId,
              transcriptTarget,
              transcriptOffset,
              workspaceRoot: wsRoot,
              sandbox_instance: instance,
            };
          }
          await launchBackground(
            client,
            stack,
            service,
            retryHostDir,
            retryRunId,
            input.group_folder,
            {
              prompt: input.fallbackPrompt ?? input.prompt,
              model: input.model,
              fallback_model: input.fallback_model,
              reasoning_effort: input.reasoning_effort,
              fallback_reasoning_effort: input.fallback_reasoning_effort,
              agent_cmd: input.agent_cmd,
              agent: input.agent,
              bare: input.bare,
              chat_mode: input.chat_mode,
              prompt_cache_ttl: input.prompt_cache_ttl,
              chat_jid: input.chat_jid,
              systemPrompt: input.systemPrompt,
              instance,
              task_id: input.task_id,
              objective_id: launchArgs.objective_id,
              conversation_id: input.conversation_id,
              stages: stagesSummary,
              custom_values: group.settings?.custom_values,
              work_dir: agentWorkDir,
              group_dir: launchArgs.group_dir,
              // Preserve the caller's explicit bootstrap-context policy across
              // the no-session retry. Otherwise the retry silently reverts to
              // launchBackground's fresh-session default.
              injectAgentContext: input.injectAgentContext,
              userCommand: input.userCommand,
              // No session_id — that's the point of the retry
              env: {
                ...retryRunEnv,
                CARAPA_RECORD: recordingEnabled ? '1' : '0',
                CARAPA_BROWSER_RUN_ID: retryRunId,
                CARAPA_BROWSER_SESSION_ID: '',
                CARAPA_BROWSER_WORK_DIR: '',
                CARAPA_BROWSER_CONTEXT_FILE: '',
                ...pwRecordingEnv(
                  input.branch_name,
                  sharedRecordingProject,
                  input.task_id,
                  retryRunId,
                ),
                ...conversationBrowserEnv,
                ...remoteBrowserSessionEnv(input.env),
              },
              group,
            },
          );
          // A Stop during the launch call may have "killed" the retry before
          // its process existed; end whatever launchBackground just started.
          if (isStopAbort(runSignal))
            await killRunAfterAbort(runSignal, retryRunId, true);
          await input.onRunLaunched?.(retryRunId);
          result = await waitForRun(
            retryHostDir,
            chatTimeoutMs,
            onChunk,
            runSignal,
            retryStallOpts,
            onToolUse,
          );
          if (isStopAbort(runSignal))
            await killRunAfterAbort(runSignal, retryRunId);

          const duration = Date.now() - startTime;
          const agentResult = canonicalizeRunResult(
            result.metrics,
            retryHostDir,
          );
          const output = buildOutput(
            result,
            agentResult,
            input.group_folder,
            result.metrics?.durationMs ?? duration,
            isStopAbort(runSignal),
          );

          const runStatus = completionStatusForRun(result, output);
          await persistRunCompletionBeforePromptAcceptance(
            retryRunId,
            runStatus,
            () =>
              completeActiveRun(
                retryRunId,
                runStatus,
                agentResult,
                // The retry exists because input.session_id was unresumable;
                // never record it as this run's session.
                agentResult.session_id || undefined,
              ),
            input.onPromptRunAccepted,
          );
          await updateRunStats(retryRunId, agentResult).catch((error) => {
            logger.warn(
              { runId: retryRunId, error: String(error) },
              'Failed to persist retry run token breakdown',
            );
          });

          await cleanupRunDir(
            retryHostDir,
            transcriptTarget,
            input.group_folder,
            transcriptOffset,
            wsRoot,
            input.skipTranscriptMemory,
            stack,
            service,
            input.transcript_agent_name || input.agent_cmd,
            instance,
            sandboxObservationRoot(),
            input.ephemeral,
            input.isScheduledTask,
          );

          return {
            ...output,
            activeRunId: retryRunId,
            transcriptTarget,
            transcriptOffset,
            workspaceRoot: wsRoot,
            sandbox_instance: instance,
            rawTranscript: input.captureTranscript ? result.events : undefined,
          };
        } catch (retryErr) {
          const retryRun = await getActiveRunById(retryRunId);
          if (retryRun?.status === 'running') {
            await killRun(retryRun).catch((error) =>
              logger.warn(
                { runId: retryRunId, error: String(error) },
                'Failed to terminate retry after launch acknowledgement failure',
              ),
            );
          }
          await completeActiveRun(
            retryRunId,
            retryErr instanceof StalledError ? 'stalled' : 'error',
          );
          await cleanupRunDir(
            retryHostDir,
            transcriptTarget,
            input.group_folder,
            transcriptOffset,
            wsRoot,
            input.skipTranscriptMemory,
            stack,
            service,
            input.transcript_agent_name || input.agent_cmd,
            instance,
            sandboxObservationRoot(),
            input.ephemeral,
            input.isScheduledTask,
          );
          throw retryErr;
        } finally {
          const persisted = await finalizeRunBrowser(
            {
              id: retryRunId,
              group_folder: input.group_folder,
              task_id: input.task_id ?? null,
              sandbox_stack: stack,
              sandbox_service: service,
              sandbox_instance: instance,
            },
            client,
          );
          if (persisted > 0 && task)
            broadcast({
              type: 'task_updated',
              payload: { task_id: task.id, project_id: task.project_id },
            });
        }
      } else {
        // No retry follows: the run is over, so Stop has nothing left to abort.
        releaseChatAbortController();
        const duration = Date.now() - startTime;
        const canonicalCompletion = prepareCanonicalRunCompletion(
          runId,
          result.metrics,
          hostDir,
        );
        const { agentResult } = canonicalCompletion;
        const output = buildOutput(
          result,
          agentResult,
          input.group_folder,
          result.metrics?.durationMs ?? duration,
          isStopAbort(runSignal),
        );

        const runStatus = completionStatusForRun(result, output);
        logger.info(
          { runId, status: runStatus, group: group.name },
          'Marking active run complete',
        );
        await persistRunCompletionBeforePromptAcceptance(
          runId,
          runStatus,
          () =>
            canonicalCompletion.persist(
              runStatus,
              agentResult.session_id || input.session_id || undefined,
            ),
          input.onPromptRunAccepted,
        );
        logger.info(
          { runId, hostDir, group: group.name },
          'Starting run cleanup',
        );
        await cleanupRunDir(
          hostDir,
          transcriptTarget,
          input.group_folder,
          transcriptOffset,
          wsRoot,
          input.skipTranscriptMemory,
          stack,
          service,
          input.transcript_agent_name || input.agent_cmd,
          instance,
          sandboxObservationRoot(),
          input.ephemeral,
          input.isScheduledTask,
        );
        logger.info({ runId, group: group.name }, 'Run cleanup finished');

        // Persist token and tool usage stats from this run
        if (
          agentResult.total_tokens !== undefined ||
          agentResult.tok_output !== undefined ||
          agentResult.tool_usage_count !== undefined ||
          agentResult.cost_usd !== undefined
        ) {
          try {
            await updateRunStats(effectiveRunId, {
              total_tokens: agentResult.total_tokens,
              tok_output: agentResult.tok_output,
              tok_input: agentResult.tok_input,
              tok_cache_write: agentResult.tok_cache_write,
              tok_cache_read: agentResult.tok_cache_read,
              tok_context_last: agentResult.tok_context_last,
              model_name: agentResult.model_name,
              tool_usage_count: agentResult.tool_usage_count,
              cost_usd: agentResult.cost_usd,
            });
          } catch (error) {
            logger.warn(
              { runId: effectiveRunId, error: String(error) },
              'Failed to persist run token breakdown',
            );
          }
        }

        // Rename chat transcript to session ID if needed
        if (
          !input.session_id &&
          !input.task_id &&
          !input.conversation_id &&
          transcriptTarget &&
          agentResult.session_id
        ) {
          const newName = path
            .basename(transcriptTarget)
            .replace(
              '-new.output.jsonl',
              `-${agentResult.session_id}.output.jsonl`,
            );
          const sessionTarget = path.join(
            path.dirname(transcriptTarget),
            newName,
          );
          if (sessionTarget !== transcriptTarget) {
            try {
              moveTranscriptSync(transcriptTarget, sessionTarget);
            } catch {
              /* ignore */
            }
          }
        }

        return {
          ...output,
          activeRunId: effectiveRunId,
          transcriptTarget,
          transcriptOffset,
          workspaceRoot: wsRoot,
          sandboxInstance: instance,
          sandbox_instance: instance,
          rawTranscript: input.captureTranscript ? result.events : undefined,
        };
      }
    } catch (err) {
      try {
        await completeActiveRun(runId, 'error');
      } catch {
        /* ignore — may already be completed or never inserted */
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof ReviewDeferredError) {
        logger.info(
          { group: group.name, task_id: input.task_id, error: errorMsg },
          'Review deferred to Testing',
        );
      } else {
        logger.error(
          { group: group.name, error: errorMsg },
          'MCP runner error',
        );
      }
      return {
        status: 'error',
        result: null,
        error: errorMsg,
      };
    } finally {
      releaseChatAbortController();
      clearInterval(leaseHeartbeat);
      await checkoutLease?.release();
      currentProcessRunIds.delete(runId);
      currentProcessRunIds.delete(effectiveRunId);
      release();
    }
  } catch (err) {
    clearInterval(leaseHeartbeat);
    void checkoutLease?.release();
    release();
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { group: group.name, error: errorMsg },
      'MCP runner preflight error',
    );
    return {
      status: 'error',
      result: null,
      error: errorMsg,
    };
  }
}

// ─── Kill helpers ───────────────────────────────────────────────────────────

/**
 * Kill the agent process running inside the sandbox for a given task.
 *
 * Looks up the active run in the DB, finds the PID file on the host filesystem,
 * sends `kill` via sandbox_exec, and writes an exit_code so waitForRun() resolves.
 *
 * If PID-based kill fails or PID is unavailable, falls back to killing all
 * claude processes in the sandbox. As a last resort, restarts the sandbox
 * instance to guarantee process termination.
 */
export async function killAgentProcess(
  task_id: string,
  options: { cleanStop?: boolean } = {},
): Promise<boolean> {
  const run = await getActiveRunForTask(task_id);
  if (!run) {
    logger.debug({ task_id }, 'killAgentProcess: no active run found');
    return false;
  }
  if (!options.cleanStop && (await gracefullyInterruptRun(run))) {
    await completeActiveRun(run.id, 'error');
    return true;
  }
  return killRun(run, options);
}

export function parseCodexRunControlResponse(raw: string): boolean | undefined {
  try {
    const response = JSON.parse(raw);
    return typeof response?.ok === 'boolean' ? response.ok : undefined;
  } catch {
    return undefined;
  }
}

async function sendAgentRunControl(
  run: ActiveRun,
  action: 'steer' | 'interrupt' | 'answerUserInput' | 'stopTask',
  payload: {
    text?: string;
    taskId?: string;
    requestId?: string;
    answers?: Record<string, { answers: string[] }>;
  } = {},
  options: { requestId?: string; retainResponse?: boolean } = {},
): Promise<boolean> {
  const hostDir = resolveHostRunDir(run);
  if (hostDir) await ipcReplica.pollPath(hostDir);
  if (!hostDir || !fs.existsSync(path.join(hostDir, 'agent-control.json'))) {
    return false;
  }
  const id = options.requestId ?? crypto.randomUUID();
  const requestsDir = path.join(hostDir, 'control-requests');
  const responsesDir = path.join(hostDir, 'control-responses');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });
  const target = path.join(requestsDir, `${id}.json`);
  const tmp = `${target}.tmp`;
  if (!fs.existsSync(target)) {
    fs.writeFileSync(tmp, JSON.stringify({ id, action, ...payload }));
    fs.renameSync(tmp, target);
  }
  await ipcReplica.flushPath(target);
  const responsePath = path.join(responsesDir, `${id}.json`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await ipcReplica.pollPath(hostDir);
    if (fs.existsSync(responsePath)) {
      try {
        const accepted = parseCodexRunControlResponse(
          fs.readFileSync(responsePath, 'utf8'),
        );
        if (accepted === undefined) {
          await sleep(50);
          continue;
        }
        if (!options.retainResponse || accepted === false) {
          fs.unlinkSync(responsePath);
          void ipcReplica.flushPath(hostDir);
        }
        return accepted;
      } catch {
        // The sandbox writes responses directly, so existsSync() can observe
        // the file before writeFile() has finished populating it. Treat an
        // unreadable/partial response as pending instead of reporting a
        // rejected steer that the agent actually accepted.
      }
    }
    await sleep(50);
  }
  return false;
}

export async function steerAgentProcess(
  task_id: string,
  text: string,
  requestId?: string,
  expectedRunId?: string,
): Promise<boolean> {
  const run = await getActiveRunForTask(task_id);
  if (expectedRunId && run?.id !== expectedRunId) return false;
  return run
    ? sendAgentRunControl(
        run,
        'steer',
        { text },
        requestId ? { requestId, retainResponse: true } : {},
      )
    : false;
}

/** Read a retained generic run-control acknowledgement for durable recovery. */
export async function readAgentRunControlResponse(
  runId: string,
  requestId: string,
): Promise<boolean | undefined> {
  const run = await getActiveRunById(runId);
  if (!run) return undefined;
  const hostDir = resolveHostRunDir(run);
  if (!hostDir) return undefined;
  await ipcReplica.pollPath(hostDir);
  const responsePath = path.join(
    hostDir,
    'control-responses',
    `${requestId}.json`,
  );
  try {
    return parseCodexRunControlResponse(
      await fs.promises.readFile(responsePath, 'utf8'),
    );
  } catch {
    return undefined;
  }
}

/** Remove a retained response only after its transcript receipt is durable. */
export async function clearAgentRunControlResponse(
  runId: string,
  requestId: string,
): Promise<void> {
  const run = await getActiveRunById(runId);
  if (!run) return;
  const hostDir = resolveHostRunDir(run);
  if (!hostDir) return;
  // Serialized with replica syncs so an in-flight pull cannot restore the
  // removed response or run directory before the Box removal is issued.
  await ipcReplica.runExclusiveAt(hostDir, () => {
    removeIpcTreeSync(
      path.join(hostDir, 'control-responses'),
      `${requestId}.json`,
    );
    if (
      run.status !== 'running' &&
      fs.existsSync(path.join(hostDir, '.cleanup-complete')) &&
      !hasRetainedRunControlResponses(hostDir)
    ) {
      removeIpcDirSync(hostDir);
    }
  });
  await ipcReplica.flushPath(hostDir);
}

export async function answerTaskAgentUserInput(
  task_id: string,
  requestId: string,
  answers: Record<string, { answers: string[] }>,
): Promise<boolean> {
  const run = await getActiveRunForTask(task_id);
  if (!run) return false;
  const accepted = await sendAgentRunControl(run, 'answerUserInput', {
    requestId,
    answers,
  });
  if (accepted) resumeRunStallWatchdog(run.id);
  return accepted;
}

/** Stop one background task the task run's agent is waiting on. */
export async function stopTaskBackgroundTask(
  task_id: string,
  backgroundTaskId: string,
): Promise<boolean> {
  const run = await getActiveRunForTask(task_id);
  return run
    ? sendAgentRunControl(run, 'stopTask', { taskId: backgroundTaskId })
    : false;
}

export async function interruptAgentTurn(task_id: string): Promise<boolean> {
  const run = await getActiveRunForTask(task_id);
  return run ? sendAgentRunControl(run, 'interrupt') : false;
}

export async function steerChatAgentProcess(
  group_folder: string,
  conversation_id: string,
  text: string,
): Promise<boolean> {
  const runs = await getActiveChatRunsForConversation(
    group_folder,
    conversation_id,
  );
  const run = runs.find((candidate) => candidate.status === 'running');
  return run ? sendAgentRunControl(run, 'steer', { text }) : false;
}

/** Stop one background task the chat's agent is waiting on. */
export async function stopChatBackgroundTask(
  group_folder: string,
  conversation_id: string,
  taskId: string,
): Promise<boolean> {
  const runs = await getActiveChatRunsForConversation(
    group_folder,
    conversation_id,
  );
  const run = runs.find((candidate) => candidate.status === 'running');
  return run ? sendAgentRunControl(run, 'stopTask', { taskId }) : false;
}

export async function answerChatAgentUserInput(
  group_folder: string,
  conversation_id: string,
  requestId: string,
  answers: Record<string, { answers: string[] }>,
): Promise<boolean> {
  const runs = await getActiveChatRunsForConversation(
    group_folder,
    conversation_id,
  );
  const run = runs.find((candidate) => candidate.status === 'running');
  if (!run) return false;
  const accepted = await sendAgentRunControl(run, 'answerUserInput', {
    requestId,
    answers,
  });
  if (accepted) resumeRunStallWatchdog(run.id);
  return accepted;
}

const GRACEFUL_INTERRUPT_TIMEOUT_MS = 30_000;

/**
 * Ask a warm harness to end only its active turn, then wait for the runner's
 * durable completion handshake. The daemon and native session remain alive.
 * Returning false deliberately delegates to stop-agent.sh as the hard-stop
 * fallback; a missing/buggy control implementation must never strand Stop.
 */
export async function gracefullyInterruptRun(
  run: ActiveRun,
  timeoutMs = GRACEFUL_INTERRUPT_TIMEOUT_MS,
): Promise<boolean> {
  const hostDir = resolveHostRunDir(run);
  if (!hostDir || !(await sendAgentRunControl(run, 'interrupt'))) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ipcReplica.pollPath(hostDir);
    if (
      fs.existsSync(path.join(hostDir, 'exit_code')) &&
      fs.existsSync(path.join(hostDir, 'metrics_complete'))
    ) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

/**
 * Kill an active agent run by sending stop-agent.sh to the sandbox.
 * Handles PID lookup, process tree termination, and exit_code writing.
 */
export async function killRun(
  run: ActiveRun,
  options: { cleanStop?: boolean; preserveTerminalState?: boolean } = {},
): Promise<boolean> {
  const stack = run.sandbox_stack;
  const runId = run.id;

  // Determine the sandbox instance: prefer stored value, fall back to IPC dir scan
  let instance: string | null = run.sandbox_instance || null;

  // Find the host-side run dir by scanning IPC directories (runId is unique across slots)
  const ipcBase = path.join(DATA_DIR, 'ipc');
  let hostDir: string | null = null;
  try {
    const ipcDirs = fs.readdirSync(ipcBase);
    for (const dir of ipcDirs) {
      const candidate = path.join(ipcBase, dir, 'runs', runId);
      if (fs.existsSync(candidate)) {
        hostDir = candidate;
        // Derive instance from IPC dir name if not stored in DB
        if (!instance) {
          instance = dir.startsWith(`${stack}-`)
            ? dir.slice(`${stack}-`.length)
            : dir;
        }
        break;
      }
    }
  } catch {
    // IPC dir may not exist
  }

  if (!instance) {
    logger.warn({ runId }, 'killRun: could not determine sandbox instance');
    await completeActiveRun(runId, 'error');
    return false;
  }

  // Read PID from the run directory replica (pulled fresh from the box).
  let pid: string | null = null;
  if (hostDir) {
    await ipcReplica.pollPath(hostDir, 0);
    // A swapped run dir is refused: no marker is written and stop-agent.sh
    // still runs without a pid.
    const runDir = openRunDirPinned(hostDir);
    try {
      if (options.cleanStop && runDir) {
        // The wrapper interprets this as a successful stage boundary, flushes
        // final output, runs canonical measurement, and publishes the handshake.
        writeIpcFileSync(runDir, 'clean_stop', '');
      }
      // Board-written run files (clean_stop, recovery pointers) must reach the
      // box before stop-agent.sh reads them.
      await ipcReplica.flushPath(hostDir);
      let rawPid: string | undefined;
      try {
        rawPid = runDir
          ? readIpcTextSync(runDir, 'pid', 64)?.trim()
          : undefined;
      } catch (err) {
        logger.warn({ runId, err }, 'killRun: could not read PID file');
      }
      if (rawPid && isNumericPid(rawPid)) {
        pid = rawPid;
      } else {
        // The pid is interpolated into a shell command: anything but digits
        // is dropped, as is a missing file.
        logger.warn(
          { runId, invalidPid: rawPid || undefined },
          'killRun: no usable PID in run directory',
        );
      }
    } finally {
      runDir?.closeSync();
    }
  }

  const sboxRunDir = sandboxRunDir(runId);
  const client = getSandboxClient();

  logger.info(
    {
      runId,
      agentPid: pid,
      instance,
      agent_name: run.agent_name,
      cleanStop: options.cleanStop ?? false,
    },
    'killRun: attempting kill via stop-agent.sh',
  );

  // Use stop-agent.sh inside the sandbox — it runs with full privileges and handles
  // process tree kill, SIGTERM→SIGKILL escalation, and exit_code writing.
  let killed = false;
  let stopStatus: string | undefined;
  try {
    const result = await client.sandboxExec(
      stack,
      run.sandbox_service,
      `stop-agent.sh ${sboxRunDir}${pid ? ` ${pid}` : ''}`,
      { instance, timeout: 15 },
    );
    const output = result.stdout.trim();
    logger.info(
      { runId, instance, output, isError: result.isError },
      'killRun: stop-agent.sh result',
    );

    // Parse JSON status regardless of isError — the kill may have succeeded even if
    // the script exited non-zero (e.g. exit_code write failed due to mount issues)
    try {
      const status = JSON.parse(output);
      stopStatus = status.status;
      killed = status.status === 'killed' || status.status === 'already_dead';
    } catch {
      // Non-JSON output — only treat as success if sandbox reported no error
      if (!result.isError) killed = true;
    }
  } catch (err) {
    logger.warn({ runId, error: String(err) }, 'killRun: stop-agent.sh failed');
  }

  // Older managed-run wrappers could publish their short-lived wrapper PID in
  // the run directory while the real warm daemon lived in session_dir. A
  // targeted stop then truthfully returned `already_dead` for the wrapper but
  // left the daemon and its active turn running. The no-PID form retires that
  // run-scoped warm session without affecting another task's session.
  if (pid && stopStatus === 'already_dead') {
    try {
      const fallback = await client.sandboxExec(
        stack,
        run.sandbox_service,
        `stop-agent.sh ${sboxRunDir}`,
        { instance, timeout: 15 },
      );
      const output = fallback.stdout.trim();
      let fallbackStatus: string | undefined;
      try {
        fallbackStatus = JSON.parse(output).status;
        killed =
          fallbackStatus === 'killed' ||
          fallbackStatus === 'already_dead' ||
          fallbackStatus === 'stale_container_generation';
      } catch {
        killed = !fallback.isError;
      }
      logger.info(
        {
          runId,
          instance,
          output,
          isError: fallback.isError,
          fallbackStatus,
        },
        'killRun: retired warm session after dead wrapper PID',
      );
    } catch (err) {
      killed = false;
      logger.warn(
        { runId, error: String(err) },
        'killRun: warm-session fallback failed',
      );
    }
  }

  if (!killed) {
    logger.warn(
      { runId, instance },
      'killRun: stop-agent.sh could not confirm kill',
    );
  }

  // Write the completion markers from the host side as well (belt and
  // suspenders — stop-agent.sh writes them only for some outcomes). A
  // Contract-v1 watcher waits for metrics_complete after exit_code, so
  // without it a run whose stop was not confirmed stays unsettled until the
  // stall watchdog fires and keeps its queue slot.
  if (hostDir && !options.cleanStop) {
    await ipcReplica.pollPath(hostDir, 0);
    const runDir = openRunDirPinned(hostDir);
    try {
      // A planted link or FIFO reads as null and is replaced by a regular
      // file; the write never goes through a link to its target.
      let wrote = false;
      if (runDir && readIpcTextSync(runDir, 'exit_code', 64) === null) {
        writeIpcFileSync(runDir, 'exit_code', '137');
        wrote = true;
      }
      if (runDir && readIpcTextSync(runDir, 'metrics_complete', 64) === null) {
        writeIpcFileSync(runDir, 'metrics_complete', 'stopped\n');
        wrote = true;
      }
      if (wrote) await ipcReplica.flushPath(hostDir);
    } catch {
      // Best effort
    } finally {
      runDir?.closeSync();
    }
  }

  if (!options.cleanStop && !options.preserveTerminalState) {
    await completeActiveRun(runId, 'error');
  }
  return killed;
}

/**
 * Kill the currently running non-task (chat) agent process for a project.
 * - With conversation_id, only that conversation's runs are stopped.
 * - With chat_jid alone, every running chat run for that chat_jid is stopped.
 * - With neither (e.g. project deletion), ALL chat runs for this group are stopped.
 */
export async function killChatAgentProcess(
  group_folder: string,
  chat_jid?: string,
  conversation_id?: string,
): Promise<boolean> {
  // Abort any in-progress waitForRun FIRST — before any DB/filesystem lookups.
  // This immediately unblocks the HTTP handler even if the active_runs row isn't
  // inserted yet (race) or if any subsequent lookup fails.
  let aborted = false;
  let stopKey: string | undefined;
  let settleUserStop: ((handled: Set<string>) => void) | undefined;
  let userStop: Promise<Set<string>> | undefined;
  if (conversation_id || chat_jid) {
    // Abort only the specific conversation's run.
    const key = chatAbortKey(group_folder, conversation_id, chat_jid);
    const abortCtrl = chatRunAbortControllers.get(key);
    if (abortCtrl) {
      // Register before aborting so the run's abort handler finds it.
      stopKey = key;
      userStop = new Promise<Set<string>>((resolve) => {
        settleUserStop = resolve;
      });
      userStopsInProgress.set(key, userStop);
      abortCtrl.abort('user_stop');
      chatRunAbortControllers.delete(key);
      aborted = true;
    }
  } else {
    // Abort ALL chat runs for this group (used by project deletion).
    const prefix = `${group_folder}:`;
    for (const [key, ctrl] of chatRunAbortControllers) {
      if (key === group_folder || key.startsWith(prefix)) {
        ctrl.abort();
        chatRunAbortControllers.delete(key);
        aborted = true;
      }
    }
  }

  const handled = new Set<string>();
  let totalKilled = 0;
  try {
    const runs = conversation_id
      ? await getActiveChatRunsForConversation(group_folder, conversation_id)
      : await getActiveChatRunsForGroup(group_folder, chat_jid);

    for (const run of runs) {
      if (await gracefullyInterruptRun(run)) {
        await completeActiveRun(run.id, 'error');
        handled.add(run.id);
        totalKilled++;
      } else if (await killRun(run)) {
        handled.add(run.id);
        totalKilled++;
      }
    }
  } finally {
    settleUserStop?.(handled);
    if (stopKey && userStopsInProgress.get(stopKey) === userStop) {
      userStopsInProgress.delete(stopKey);
    }
  }

  return totalKilled > 0 || aborted;
}

/**
 * Release the board-side waiter for a chat run whose sandbox is being stopped.
 * Container lifecycle code owns the actual process termination in this case.
 */
export function abortChatAgentWatcher(
  group_folder: string,
  chat_jid?: string,
  conversation_id?: string,
): boolean {
  const key = chatAbortKey(group_folder, conversation_id, chat_jid);
  const abortCtrl = chatRunAbortControllers.get(key);
  if (!abortCtrl) return false;
  abortCtrl.abort('sandbox_stopped');
  chatRunAbortControllers.delete(key);
  return true;
}

/**
 * Per-run recording paths. All parallel runs of a project share ONE sandbox
 * container (sandboxInstanceName ignores the slot), hence one default Playwright
 * daemon/session. A run ID isolates the browser, marker, and output directory so
 * a late cleanup or immediate retry cannot close or overwrite another run.
 * Callers without a run ID retain the legacy branch/task-derived layout.
 */
export function pwRecordingPaths(
  branchName?: string,
  projectNamespace?: string,
  taskId?: string,
  runId?: string,
) {
  const branch = (runId || branchName || taskId || 'default').replace(
    /[^a-zA-Z0-9._-]/g,
    '-',
  );
  // Standalone layout stays byte-for-byte compatible. Only a shared instance
  // adds the project namespace, preventing equal branch names in siblings from
  // sharing a daemon socket or recording directory.
  const recBranch = projectNamespace
    ? `${projectNamespace}--${branch}`
    : branch;
  const daemonDir = `/tmp/pwcli-${recBranch}`;
  return {
    recBranch,
    recDir: `/workspace/ipc/recordings/${recBranch}`,
    daemonDir,
    // Isolate daemon Unix sockets per task — PLAYWRIGHT_DAEMON_SESSION_DIR alone
    // only scopes session files; default sockets live in shared $TMPDIR/playwright-cli
    // and stale daemons make exec'd `open` report "browser default is not open".
    socketsDir: `${daemonDir}/sockets`,
  };
}

/** Env vars every recording-stage playwright-cli call needs (board + agent). */
function pwRecordingEnv(
  branchName?: string,
  projectNamespace?: string,
  taskId?: string,
  runId?: string,
): Record<string, string> {
  const { daemonDir, socketsDir, recBranch, recDir } = pwRecordingPaths(
    branchName,
    projectNamespace,
    taskId,
    runId,
  );
  return {
    PLAYWRIGHT_DAEMON_SESSION_DIR: daemonDir,
    PLAYWRIGHT_DAEMON_SOCKETS_DIR: socketsDir,
    PLAYWRIGHT_CLI_SESSION: recBranch,
    CARAPA_RECORD_DAEMON_DIR: daemonDir,
    CARAPA_RECORD_SOCKETS_DIR: socketsDir,
    CARAPA_RECORD_SESSION: recBranch,
    CARAPA_RECORD_DIR: recDir,
  };
}

/** A web_view remote session owns its CLI daemon independently of recording. */
function remoteBrowserSessionEnv(
  env?: Record<string, string>,
): Record<string, string> {
  if (!env?.PLAYWRIGHT_MCP_CDP_ENDPOINT) return {};
  return Object.fromEntries(
    [
      'PLAYWRIGHT_DAEMON_SESSION_DIR',
      'PLAYWRIGHT_DAEMON_SOCKETS_DIR',
      'PLAYWRIGHT_CLI_SESSION',
    ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}
