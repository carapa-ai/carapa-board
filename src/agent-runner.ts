import { applyAutoModelPin } from './lib/auto-model-pin.js';
import fs from 'fs';
import { ensureObjectiveFolderInitialised } from './modules/objectives/objective-folder.js';
import { objectiveWorkDir } from './modules/objectives/work-dir.js';
import { admitRun } from './sandbox/run-admission.js';
import { objectiveMovedConversationMessage } from './modules/objectives/db-objectives.js';
import path from 'path';
import { EventEmitter } from 'events';
import { GROUPS_DIR, TIMEZONE } from './config.js';
import { getAgentPermissionsResolved } from './mcp/auth.js';
import {
  claimNormalTaskAdmission,
  releaseTaskAdmission,
  getConversation,
  getObjective,
  setConversationSessionId,
  setConversationAgentCmd,
  getConversationSessionId,
} from './db.js';
import {
  DirectLlmContextError,
  directLlmFallbackOption,
  directLlmPromptCacheKey,
  runDirectLlm,
  type ConversationMessage,
} from './modules/chat/direct-llm.js';
import {
  appendChatTranscriptEntry,
  chatTranscriptPath,
  readChatTranscript,
} from './group-dir.js';
import {
  getLlmHistory,
  getAgentContextGap,
} from './modules/transcripts/transcript-store.js';
import {
  getGroupHomeDir,
  loadAgentRules,
  loadPreferencesCascade,
} from './prompt-loader.js';
import { effectiveContainerGroupDir } from './sandbox/effective-settings.js';
import {
  getChatAgents,
  getDefaultRuntimeSelection,
  isDirectRuntime,
  resolveRuntimeSelection,
  runtimeSessionKey,
  type ChatAgentOption,
} from './lib/chat-agents.js';
import { calculateModelCostUsd } from './lib/model-pricing.js';
import { assertRuntimeAllowed, PrivacyRefusal } from './lib/privacy-policy.js';
import { buildSystemPrompt } from './system-prompt-builder.js';
import { RegisteredGroup } from './types.js';
import type { TriggerSource } from './modules/kanban/types.js';
import { buildSandboxRunTelemetry } from './modules/chat/run-telemetry.js';
import type { TranscriptProfile } from './modules/memory/transcript-profiles.js';
import { runReflectWorkflow } from './modules/memory/reflect-workflow.js';
import {
  admitTranscriptMemory,
  describeIncompleteReflection,
  processAdmittedAutomaticTranscriptMemory,
  processAutomaticTranscriptMemory,
} from './modules/memory/tool-reflector.js';
import {
  automaticTranscriptReflectionQueue,
  isIncompleteAutomaticReflection,
} from './modules/memory/automatic-reflection-queue.js';
import {
  ChunkData,
  runContainerAgent,
  type ContainerInput,
} from './mcp/mcp-runner.js';
import { chatRunAbortControllers, chatAbortKey } from './sandbox/process.js';
import {
  beginBackgroundWork,
  DIRECT_CHAT_WORK_LABEL,
} from './lib/background-work-gate.js';
import { resolveEffectiveSandbox } from './sandbox/effective-settings.js';
import { admitLaunch } from './sandbox/idle-restart.js';
import { logger, scrubSecretText } from './logger.js';
import { broadcast } from './modules/objectives/ws-events.js';
import {
  getGroupByFolder,
  registeredGroups,
  saveSessions,
  sessions,
  sessionAgentCmds,
  compactedSessions,
} from './state-manager.js';
import type { McpServerDeps } from './mcp/auth.js';
import {
  LIVE_ACTIVITY_AGENT_INSTRUCTION,
  LIVE_ACTIVITY_DISABLED_INSTRUCTION,
  PERSONA_LIVE_VOICE_INSTRUCTION,
  stripLiveMarkers,
} from './modules/chat/live-activity.js';
import { stripAiUserControlMetadata } from './modules/ai-users/talking-stick.js';
import { type GeneratedImageArtifact } from './modules/image-generation/artifacts.js';
import { writeArtifactFile } from './modules/chat/artifacts.js';
import { nameConversationInBackground } from './modules/chat/conversation-title.js';
import {
  createPersonaInstructionRevision,
  mainPersonaSessionKey,
} from './modules/ai-users/session-revision.js';

type ContainerAgentRunner = typeof runContainerAgent;
let containerAgentRunner: ContainerAgentRunner = runContainerAgent;

/** Replace only the native launch boundary for behavioral runner tests. */
export function setContainerAgentRunnerForTests(
  runner: ContainerAgentRunner | null,
): void {
  containerAgentRunner = runner ?? runContainerAgent;
}

export interface ChatAgentInspection {
  systemPrompt: string;
  prompt: string;
  history?: ConversationMessage[];
  transcript: string;
  systemPromptInjected?: boolean;
}

function appendCurrentHumanContext(
  prompt: string,
  humanContext: string | null | undefined,
): string {
  return humanContext
    ? `${prompt}\n\n[CURRENT HUMAN CONTEXT]\n${humanContext}`
    : prompt;
}

type ConversationChannel = 'WhatsApp' | 'direct';

interface TurnInstructionState {
  channel: ConversationChannel;
  liveMode: boolean;
  /** Persona Live Mode: this turn's reply is spoken aloud, not marker-driven. */
  personaVoice?: boolean;
  chatMode: string | null;
  humanUserId: string | null;
  /** Revision of the invited-participant roster; null = none, undefined = not managed by this run. */
  rosterRevision?: string | null;
}

interface TurnInstructionDelivery {
  channel: boolean;
  liveMode: boolean;
  chatMode: boolean;
  humanContext: boolean;
  roster: boolean;
  previousHumanContextUserId: string | null;
  previousRosterRevision: string | null;
}

let inspectionToolCallSeq = 0;

/**
 * Inspection transcripts are Run V1 event text. The Direct-LLM runtime has no
 * V1 stream, so its `tool_use` transcript entries are mapped to V1 `tool_call`
 * events here; every other entry is kept as is.
 */
function directLlmInspectionEntry(entry: unknown): unknown {
  const e = entry as {
    type?: unknown;
    part?: {
      id?: unknown;
      tool?: unknown;
      state?: { status?: unknown; input?: unknown; output?: unknown };
    };
  } | null;
  if (e?.type !== 'tool_use' || !e.part) return entry;
  const { id, tool, state } = e.part;
  const status =
    state?.status === 'running'
      ? 'started'
      : state?.status === 'error'
        ? 'failed'
        : 'completed';
  inspectionToolCallSeq++;
  return {
    type: 'tool_call',
    id:
      typeof id === 'string' && id
        ? id
        : `direct-tool-${inspectionToolCallSeq}`,
    status,
    ...(typeof tool === 'string' ? { name: tool } : {}),
    ...(state?.input !== undefined ? { input: state.input } : {}),
    ...(state?.output !== undefined ? { output: state.output } : {}),
    ...(status === 'failed'
      ? {
          error: {
            message:
              typeof state?.output === 'string' && state.output
                ? state.output
                : 'Tool call failed',
          },
        }
      : {}),
  };
}
function conversationChannel(chatJid: string): ConversationChannel {
  return chatJid.endsWith('@g.us') || chatJid.endsWith('@s.whatsapp.net')
    ? 'WhatsApp'
    : 'direct';
}

/** Resolve which stateful turn instructions this runtime has not seen yet. */
export function resolveTurnInstructionDelivery(
  entries: unknown[],
  contextRecipient: string,
  current: TurnInstructionState,
  currentMessageId?: string,
): TurnInstructionDelivery {
  let previous:
    | (Omit<TurnInstructionState, 'rosterRevision'> & {
        humanContextUserId: string | null;
        rosterRevision: string | null;
      })
    | undefined;
  for (const entry of entries) {
    const value = entry as Record<string, unknown>;
    if (
      value?.type === 'compaction_marker' ||
      (value?.type === 'message' &&
        typeof value.content === 'string' &&
        value.content.includes('[CONTEXT_SUMMARY:'))
    ) {
      previous = undefined;
      continue;
    }
    if (
      value?.provider_context === true &&
      value.type === 'turn_instruction_state' &&
      value.contextRecipient === contextRecipient &&
      (!currentMessageId || value.messageId !== currentMessageId) &&
      (value.channel === 'WhatsApp' || value.channel === 'direct')
    ) {
      previous = {
        channel: value.channel,
        liveMode: value.liveMode === true,
        personaVoice: value.personaVoice === true,
        chatMode: typeof value.chatMode === 'string' ? value.chatMode : null,
        humanUserId:
          typeof value.humanUserId === 'string' ? value.humanUserId : null,
        humanContextUserId:
          typeof value.humanContextUserId === 'string'
            ? value.humanContextUserId
            : null,
        rosterRevision:
          typeof value.rosterRevision === 'string'
            ? value.rosterRevision
            : null,
      };
    }
  }

  const channelChanged = !previous || previous.channel !== current.channel;
  const currentPersonaVoice = current.personaVoice === true;
  return {
    channel: channelChanged,
    // Any live-state change (markers, persona voice, or back to off) must be
    // delivered: a session that saw the voice instruction gets the OFF text
    // again once Persona Live Mode is switched off.
    liveMode:
      channelChanged ||
      !previous ||
      previous.liveMode !== current.liveMode ||
      previous.personaVoice !== currentPersonaVoice,
    chatMode:
      channelChanged || !previous || previous.chatMode !== current.chatMode,
    humanContext:
      current.humanUserId !== null &&
      (!previous ||
        previous.humanUserId !== current.humanUserId ||
        previous.humanContextUserId !== current.humanUserId),
    roster:
      current.rosterRevision !== undefined &&
      (previous?.rosterRevision ?? null) !== current.rosterRevision,
    previousHumanContextUserId: previous?.humanContextUserId ?? null,
    previousRosterRevision: previous?.rosterRevision ?? null,
  };
}

function appendTurnInstructionState(
  groupFolder: string,
  conversationId: string | undefined,
  contextRecipient: string,
  current: TurnInstructionState,
  humanContextUserId: string | null,
  messageId?: string,
  rosterRevision?: string | null,
): void {
  if (!conversationId) return;
  appendChatTranscriptEntry(groupFolder, conversationId, {
    type: 'turn_instruction_state',
    provider_context: true,
    contextRecipient,
    channel: current.channel,
    liveMode: current.liveMode,
    personaVoice: current.personaVoice === true,
    chatMode: current.chatMode,
    humanUserId: current.humanUserId,
    humanContextUserId,
    rosterRevision,
    messageId,
    created_at: new Date().toISOString(),
  });
}

/** A warm session binds the roster it was created with; deliver later changes per turn. */
function rosterUpdateInstruction(roster: string | null): string {
  return `[CURRENT PARTICIPANT ROSTER]\n${
    roster
      ? `This replaces any earlier invited-participant roster in your instructions. Use only these participants:\n\n${roster}`
      : 'There are no invited virtual participants now. Disregard any earlier roster; there is no one to hand the talking stick to.'
  }`;
}

export type ChatAgentRunResult = {
  result: string | null;
  telemetry: Record<string, unknown> | undefined;
  isLlm: boolean;
  failed?: boolean;
  pending?: boolean;
  uuid?: string;
  activeRunId?: string;
  generatedArtifacts?: GeneratedImageArtifact[];
  inspection?: ChatAgentInspection;
};

export function extractPlanArtifact(result: string | null | undefined): {
  relPath: string;
  text: string;
} | null {
  if (!result) return null;
  const matches = [
    ...result.matchAll(/```carapaplan\s*\n(\{[^\n]*\})\s*\n```/g),
  ];
  const match = matches.at(-1);
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[1]) as {
      artifactPath?: unknown;
      planText?: unknown;
    };
    if (
      typeof metadata.artifactPath !== 'string' ||
      !metadata.artifactPath.startsWith('artifacts/plans/') ||
      !metadata.artifactPath.endsWith('.md')
    ) {
      return null;
    }
    const fallbackText = result.slice(0, match.index).trim();
    const text =
      typeof metadata.planText === 'string' && metadata.planText.trim()
        ? metadata.planText
        : fallbackText;
    if (!text) return null;
    return {
      relPath: metadata.artifactPath.slice('artifacts/'.length),
      text,
    };
  } catch {
    return null;
  }
}

/**
 * Native Codex plan-mode replies can be emitted only as streamed assistant
 * events, leaving the runner's final result empty. The transcript has already
 * received those events when runContainerAgent resolves, so recover the most
 * recent plan marker from it before deciding that there is no artifact to save.
 */
function extractPlanArtifactFromTranscript(
  groupFolder: string,
  conversationId: string | undefined,
  after?: string,
): { relPath: string; text: string } | null {
  if (!conversationId) return null;
  const entries = readChatTranscript(groupFolder, conversationId);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as Record<string, unknown>;
    if (
      after &&
      (typeof entry.created_at !== 'string' || entry.created_at < after)
    )
      continue;
    const item = entry.item as Record<string, unknown> | undefined;
    const candidates = [entry.content, entry.result, item?.text, item?.content];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const artifact = extractPlanArtifact(candidate);
      if (artifact) return artifact;
    }
  }
  return null;
}

/**
 * Resolves chat execution to a materialized v2 runtime.
 * Priority: explicit runtime ID, project selection, global chat selection.
 */
export function resolveChatAgent(
  group: RegisteredGroup,
  override?: string | null,
): string {
  if (override) return override;
  return resolveRuntimeSelection(
    group.settings?.chatRuntimeSelection || getDefaultRuntimeSelection('chat'),
  ).id;
}

type ChatModeOverride = string;

const CHAT_MODE_TURN_INSTRUCTIONS: Record<string, string> = {
  ask: 'Focus on understanding, clarifying, and explaining. Avoid code changes unless explicitly requested.',
  plan: 'Focus on planning and design before implementation. Do not start coding unless explicitly asked to execute.',
  code: 'Prioritize implementation. Make concrete changes, run relevant checks, and report what changed.',
  debug:
    'Prioritize root-cause analysis and evidence gathering. Reproduce issues when possible and explain the targeted fix.',
};

export function appendLiveInstructionForContinuation(
  prompt: string,
  conversationId: string | undefined,
  injectBootstrap: boolean,
  liveMode: boolean,
  includeInstruction = true,
  personaVoice = false,
): string {
  if (!conversationId || injectBootstrap) return prompt;
  // Every Live turn repeats the instruction: a session bootstrapped with Live
  // off keeps "LIVE MODE IS OFF" in its system prompt, and a one-time switch
  // notice lost to it after a single reply. Off is only sent on a change.
  // Persona voice repeats the same way — every voiced reply must stay short
  // and spoken — while switching it off delivers the OFF notice again.
  if (liveMode) return `${prompt}${LIVE_ACTIVITY_AGENT_INSTRUCTION}`;
  if (personaVoice) return `${prompt}${PERSONA_LIVE_VOICE_INSTRUCTION}`;
  return includeInstruction
    ? `${prompt}${LIVE_ACTIVITY_DISABLED_INSTRUCTION}`
    : prompt;
}

export function appendChannelInstruction(
  prompt: string,
  chatJid: string,
): string {
  const instruction =
    conversationChannel(chatJid) === 'WhatsApp'
      ? '[CHANNEL: WhatsApp]\n[INSTRUCTION: The user is communicating via WhatsApp and cannot see streamed progress. For long tasks (research, multiple steps, or file operations), use mcp__carapa-board__send_message to first acknowledge what you understood and what you will do, send useful intermediate updates while working, and then return the final answer here.]'
      : '[CHANNEL: direct]\n[INSTRUCTION: The user can see this response as it streams. Do not use mcp__carapa-board__send_message for intermediate updates; reply directly in this response.]';
  return `${prompt}\n\n${instruction}`;
}

/**
 * A native session can become genuinely unresumable after a crash or provider
 * failure. Its controlled fresh-session retry must carry the recent canonical
 * transcript; replaying only the latest user message creates agent amnesia.
 */
export function buildSessionRecoveryPrompt(
  currentPrompt: string,
  transcriptContext: string | null,
): string {
  return transcriptContext
    ? `${transcriptContext}\n\n${currentPrompt}`
    : currentPrompt;
}

function isDirectLlmPersonaAgent(agentCmd: string): boolean {
  return /^(?:ai|ai-main):/.test(agentCmd);
}

export function shouldReplayDirectLlmPersonaTail(
  agentCmd: string,
  wireApi: string | undefined,
  ephemeral: boolean | undefined,
  suppressed = false,
): boolean {
  return (
    !suppressed &&
    wireApi === 'responses' &&
    ephemeral === true &&
    isDirectLlmPersonaAgent(agentCmd)
  );
}

/**
 * The built-in reflection workflow exists for tool-less DirectLLM runtimes.
 * CLI harnesses (Codex, Claude, etc.) must receive `/reflect` unchanged so
 * their native skill/command discovery can execute the project's skill.
 */
export function shouldInterceptReflect(
  agent: ChatAgentOption | undefined,
): boolean {
  return !!agent && isDirectRuntime(agent);
}

export function shouldRunDirectLlmInline(
  isDirectRuntime: boolean,
  scheduledTaskId?: string,
): boolean {
  return isDirectRuntime && !scheduledTaskId;
}

/**
 * Unified entry point for chat runs. Routes to either runAgent (sandbox) or
 * runDirectLlm (direct API) based on agent_cmd.
 */
/** Who started this turn: the explicit override, else derived from the run. */
function resolveTurnTriggerSource(
  overrides:
    | { triggerSource?: TriggerSource; isScheduledTask?: boolean }
    | undefined,
  effectiveUserId: string | null,
): TriggerSource {
  return (
    overrides?.triggerSource ??
    (overrides?.isScheduledTask
      ? 'schedule'
      : effectiveUserId
        ? 'user'
        : 'system')
  );
}

/** A user message that opens with a slash command, e.g. `/goal tests pass`. */
const LEADING_SLASH_COMMAND_RE = /^\/[A-Za-z][\w:.-]*(\s|$)/;

/** The user's raw leading slash command text, or undefined if there is none. */
function leadingUserCommand(
  userMessage: string | undefined,
  trigger: string | undefined,
): string | undefined {
  const text = userMessage
    ?.replace(/\[CONTEXT_SUMMARY:[\s\S]*?\]/g, '')
    .trim()
    .replace(trigger || '', '')
    .trim();
  return text && LEADING_SLASH_COMMAND_RE.test(text) ? text : undefined;
}

type RunChatAgentArgs =
  Parameters<typeof runChatAgentTurn> extends [unknown, ...infer Args]
    ? Args
    : never;

/**
 * Counts the turn for a pending board restart from its first instruction: a
 * restart waits for running direct-LLM turns. Sandbox turns are reattached
 * after a restart, so `runChatAgentTurn` drops the count once it knows the
 * turn is not a direct one. Never blocks a turn from starting.
 */
export async function runChatAgent(
  ...args: RunChatAgentArgs
): Promise<ChatAgentRunResult> {
  const releaseDirectChatCount = beginBackgroundWork(DIRECT_CHAT_WORK_LABEL);
  try {
    return await runChatAgentTurn(releaseDirectChatCount, ...args);
  } finally {
    releaseDirectChatCount();
  }
}

async function runChatAgentTurn(
  releaseDirectChatCount: () => void,
  group: RegisteredGroup,
  prompt: string,
  chat_jid: string,
  onChunk?: (data: ChunkData) => void,
  sessionIdOverride?: string | null,
  forkSession?: boolean,
  conversation_id?: string,
  work_dir?: string,
  overrides?: {
    agent_cmd?: string | null;
    agentConfig?: ChatAgentOption;
    model?: string | null;
    reasoning_effort?: string;
    attachments?: any[];
    skipInitialLog?: boolean;
    /** Ask whose sandbox run must be settled after recovery. */
    agentAskId?: string;
    senderUserId?: string | null;
    triggeredByUserId?: string | null;
    triggerSource?: TriggerSource;
    skipUserPreferences?: boolean;
    chat_mode?: ChatModeOverride | null;
    excludeTrailingUserHistory?: boolean;
    /** Canonical visible user row whose exact DirectLLM input must be replayed. */
    canonicalUserMessageId?: string;
    /** Immutable history captured by an orchestrator at its causal boundary. */
    historyOverride?: ConversationMessage[];
    liveMode?: boolean;
    /** Persona Live Mode: this persona turn's reply is read aloud. */
    personaVoice?: boolean;
    systemPromptSuffix?: string;
    /** Durable conversation generation used for persistent session routing. */
    mainPersonaGeneration?: number;
    /** Instruction revision selecting an invited persona's warm session. */
    personaSessionRevision?: string;
    /** Current invited-participant roster (null = none); see the inner runner. */
    participantRoster?: string | null;
    ephemeral?: boolean;
    disableSteering?: boolean;
    beforeSteeringComplete?: () => void | Promise<void>;
    onSteeringAbsorbed?: (
      messages: import('./modules/chat/types.js').ChatMessage[],
    ) => void | Promise<void>;
    captureInspection?: boolean;
    signal?: AbortSignal;
    /** Public persona turns must not persist their raw provider replay tail. */
    suppressPersonaProviderContext?: boolean;
    /** Preserve scheduled-run tracking and duplicate prevention across runtimes. */
    scheduledTaskId?: string;
    isScheduledTask?: boolean;
    onSlotAcquired?: (runId: string) => void | Promise<void>;
    /** Isolated execution that must not contend for the shared checkout. */
    skipSharedCheckoutLease?: boolean;
    /** Reuse the task/worktree branch without synchronizing the default checkout. */
    skipBaseBranchSync?: boolean;
    /** Durable ownership row for request-independent Direct turns. */
    activeRunId?: string;
    /** The person's original message, before memory/file/handoff enrichment of `prompt`. */
    userMessage?: string;
  },
  deps?: McpServerDeps,
): Promise<ChatAgentRunResult> {
  let targetAgent = overrides?.agent_cmd;
  let resolvedImplicitAgent: ChatAgentOption | undefined;
  const conversation = conversation_id
    ? await getConversation(conversation_id)
    : undefined;
  let workDirObjectiveId: string | undefined;
  if (conversation?.objective_id) {
    const objective = await getObjective(conversation.objective_id);
    if (
      objective &&
      objective.project_id !== group.folder &&
      conversation.group_folder === group.folder
    )
      throw new Error(objectiveMovedConversationMessage(objective));
    if (
      !objective ||
      objective.project_id !== group.folder ||
      conversation.group_folder !== group.folder
    )
      throw new Error('Objective conversation does not belong to this project');
    try {
      await ensureObjectiveFolderInitialised(group.folder, objective, group);
    } catch (err) {
      // Return it as a failed turn so the chat shows the reason instead of the
      // route's generic "agent failed to respond" message. No agent ran to
      // write it to the transcript, and callers save with skipTranscript, so
      // persist it here (as /reflect does) or it vanishes on reload.
      const message = `⚠️ **Objective Setup Error**: ${err instanceof Error ? err.message : String(err)}`;
      if (onChunk) onChunk({ type: 'text', content: message });
      if (conversation_id) {
        appendChatTranscriptEntry(group.folder, conversation_id, {
          type: 'message',
          role: 'assistant',
          content: message,
          agent_name: 'objective-setup',
          created_at: new Date().toISOString(),
        });
      }
      return {
        result: message,
        telemetry: undefined,
        isLlm: false,
        failed: true,
      };
    }
    if (!work_dir) {
      // Derived here, so it is derived again if the launch has to wait for a
      // parent change (see sandbox/run-admission.ts).
      workDirObjectiveId = objective.id;
      work_dir = objectiveWorkDir(group, objective);
    }
  }
  if (!targetAgent && conversation?.runtimeSelection) {
    // Keep the materialized selection. Looking it up again by its generated
    // binding id reapplies the binding default and loses an explicit
    // selection such as reasoning: "off".
    resolvedImplicitAgent = resolveRuntimeSelection(
      applyAutoModelPin(
        conversation.runtimeSelection,
        conversation.routedModel,
      ) ?? conversation.runtimeSelection,
    );
    targetAgent = resolvedImplicitAgent.id;
  }
  if (!targetAgent) {
    resolvedImplicitAgent = resolveRuntimeSelection(
      group.settings?.chatRuntimeSelection ||
        getDefaultRuntimeSelection('chat'),
    );
    targetAgent = resolvedImplicitAgent.id;
  }
  // `targetAgent` is the generated ID of a selection we have already
  // materialized above. Do not resolve it again: that would turn a selected
  // reasoning value back into the binding default.
  const requestedAgentCmd = targetAgent || resolveChatAgent(group);
  // A structured selection may intentionally map reasoning to null (for
  // example `off`). Preserve the route's fully materialized config instead of
  // resolving its generated id again and reapplying the binding default.
  const configuredAgent =
    overrides?.agentConfig ||
    resolvedImplicitAgent ||
    getChatAgents().find((agent) => agent.id === requestedAgentCmd);
  if (!configuredAgent) {
    throw new Error(`Unknown runtime binding "${requestedAgentCmd}"`);
  }
  const agent_cmd = configuredAgent?.id || requestedAgentCmd;
  logger.info(
    {
      agent_cmd,
      folder: group.folder,
      conversation_id,
      promptLength: prompt.length,
    },
    'runChatAgent: unified entry',
  );

  // Strip system context blocks (like [CONTEXT_SUMMARY: ...]) before checking for slash commands
  const userContentOnly = prompt
    .replace(/\[CONTEXT_SUMMARY:[\s\S]*?\]/g, '')
    .trim();
  const cleanPrompt = userContentOnly
    .replace(group.trigger || '', '')
    .trim()
    .toLowerCase();

  // Handle manual /reflect command for DirectLLM only. CLI harnesses receive
  // the command unchanged and execute the repository's reflect skill.
  //
  // Intercepts before the normal DirectLLM run so
  // the reflector LLM prompts and raw outputs never leak into the
  // conversation transcript. /reflect alone returns a dry-run preview;
  // /reflect apply enables validated memory writes. Only the exact token
  // `/reflect apply` or `/reflect apply <args>` is treated as apply — a typo
  // like `/reflect applyfoo` falls through to preview mode so we never
  // silently mutate the memory/rule store on a malformed command.
  if (
    shouldInterceptReflect(configuredAgent) &&
    (cleanPrompt === '/reflect' ||
      cleanPrompt === '/reflect apply' ||
      cleanPrompt.startsWith('/reflect '))
  ) {
    const wantApply =
      cleanPrompt === '/reflect apply' ||
      cleanPrompt.startsWith('/reflect apply ');
    logger.debug(
      { command: '/reflect', conversation_id, wantApply },
      'runChatAgent: intercepted /reflect command',
    );
    if (!conversation_id) {
      return {
        result: '⚠️ Manual reflection requires an active conversation context.',
        telemetry: undefined,
        isLlm: false,
      };
    }
    const transcriptTarget = chatTranscriptPath(
      group.folder,
      undefined,
      conversation_id,
    );
    if (!fs.existsSync(transcriptTarget)) {
      return {
        result: '⚠️ No transcript found to reflect on.',
        telemetry: undefined,
        isLlm: false,
      };
    }

    if (onChunk) {
      onChunk({
        type: 'text',
        content: wantApply
          ? '🪞 *Applying reflection...*'
          : '🪞 *Reflecting (preview only)...*',
      });
    }

    try {
      const reflectResult = await runReflectWorkflow({
        group_folder: group.folder,
        transcriptPath: transcriptTarget,
        apply: wantApply,
        objectiveId: conversation?.objective_id ?? null,
        conversationId: conversation_id,
      });
      // The workflow returns a concise, user-facing message. Internal
      // observer/reflector prompts and raw LLM outputs are kept in logs
      // only. We persist just the final concise message to the chat
      // transcript so reloading the conversation shows both the user's
      // `/reflect` line and the assistant's response — matching the
      // "preserve only the user's command and concise result" contract
      // from the task spec.
      if (onChunk) onChunk({ type: 'text', content: reflectResult.message });
      appendChatTranscriptEntry(group.folder, conversation_id!, {
        type: 'message',
        role: 'assistant',
        content: reflectResult.message,
        agent_name: 'reflect',
        created_at: new Date().toISOString(),
      });
      return {
        result: reflectResult.message,
        telemetry: undefined,
        isLlm: false,
      };
    } catch (err: any) {
      logger.error(
        { err, folder: group.folder, conversation_id, wantApply },
        'Manual reflector failed',
      );
      const message = `❌ **Reflector failed**: ${err.message}`;
      if (onChunk) onChunk({ type: 'text', content: message });
      appendChatTranscriptEntry(group.folder, conversation_id!, {
        type: 'message',
        role: 'assistant',
        content: message,
        agent_name: 'reflect',
        created_at: new Date().toISOString(),
      });
      return {
        result: message,
        telemetry: undefined,
        isLlm: false,
        failed: true,
      };
    }
  }

  // Throttled onChunk to prevent UI re-rendering bottleneck
  let chunkBuffer = '';
  let lastChunkAt = 0;
  let chunkTimer: any = null;

  const flushChunks = () => {
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
    if (chunkBuffer && onChunk) {
      onChunk({ type: 'text', content: chunkBuffer });
      chunkBuffer = '';
      lastChunkAt = Date.now();
    }
  };

  const throttledOnChunk = (chunk: ChunkData) => {
    if (chunk.type !== 'text') {
      flushChunks();
      if (onChunk) onChunk(chunk);
      return;
    }
    chunkBuffer += chunk.content;
    const now = Date.now();
    if (now - lastChunkAt >= 100) {
      flushChunks();
    } else if (!chunkTimer) {
      chunkTimer = setTimeout(flushChunks, 100);
    }
  };

  // Direct LLM path (API based)
  const isLlm = isDirectRuntime(configuredAgent);

  // Track the most recent user-facing agent for UI continuity. Per-agent session
  // state is stored separately in conversation_agent_sessions, so an agent switch
  // no longer needs to wipe anything — switching back resumes the prior session.
  if (conversation_id) {
    await setConversationAgentCmd(conversation_id, agent_cmd);
  }

  logger.info({ agent_cmd, isLlm }, 'runChatAgent: path resolution');

  // Look up agent config for shared settings (baseUrl, apiKey, context_size, etc.)
  const agentConfig =
    configuredAgent &&
    overrides?.reasoning_effort &&
    configuredAgent.reasoningEnvVar
      ? {
          ...configuredAgent,
          env: {
            ...configuredAgent.env,
            [configuredAgent.reasoningEnvVar]: overrides.reasoning_effort,
          },
        }
      : configuredAgent;
  logger.debug(
    {
      agent_cmd,
      isLlm,
      hasReasoningOverride: overrides?.reasoning_effort !== undefined,
      hasFallback: !!agentConfig?.fallback,
    },
    'runChatAgent: resolved agent runtime metadata',
  );

  // Session identity is explicit in v2 and falls back to the underlying
  // binary for v1. Model/reasoning variants in one family share a resumable
  // session without making generated runtime IDs part of session identity.
  const baseSessionKey = agentConfig
    ? runtimeSessionKey(agentConfig)
    : agent_cmd;
  const sessionKey = overrides?.mainPersonaGeneration
    ? mainPersonaSessionKey(baseSessionKey, overrides.mainPersonaGeneration)
    : baseSessionKey;
  if (shouldRunDirectLlmInline(isLlm, overrides?.scheduledTaskId)) {
    // Privacy mode: refuse a remote DirectLLM runtime before any admission or
    // transcript work (sandbox chats are gated in runContainerAgent).
    try {
      assertRuntimeAllowed({
        projectId: group.folder,
        purpose: 'chat',
        runtime: agentConfig,
      });
    } catch (error) {
      if (!(error instanceof PrivacyRefusal)) throw error;
      return {
        result: error.message,
        telemetry: undefined,
        isLlm: true,
        failed: true,
        activeRunId: overrides?.activeRunId,
      };
    }
    logger.info({ agent_cmd }, 'runChatAgent: entering Direct LLM path');
    // Maintenance that moves what this project's sandbox mounts (a parent
    // change) holds every launch and looks for running conversations: this
    // inline turn has no sandbox run, so it is admitted here like any launch
    // (see sandbox/run-admission.ts, which also reads the project and the
    // objective's working directory again after a wait and settles its ticket
    // on every failure). It counts as running once admitted in the project row
    // below.
    const admitted = await admitRun(
      group,
      {
        group_folder: group.folder,
        conversation_id,
        work_dir,
        objective_work_dir_of: workDirObjectiveId,
      },
      {
        admit: admitLaunch,
        resolveInstance: (g) => resolveEffectiveSandbox(g).instance,
        getGroup: getGroupByFolder,
        getObjective,
      },
    );
    const inlineLaunch = { settle: admitted.settle };
    group = admitted.group;
    work_dir = admitted.input.work_dir;
    const inlineAdmissionId = conversation_id
      ? `conversation:${conversation_id}`
      : `conversation:${group.folder}:${chat_jid}`;
    // From here the turn is recorded as admitted in the project row, which is
    // what maintenance looks for, so the launch ticket has done its job.
    let inlineAdmission;
    try {
      inlineAdmission = await claimNormalTaskAdmission(
        group.folder,
        () => 'conversation',
        true,
        inlineAdmissionId,
        group.settings?.taskCheckoutMode ?? 'shared',
      );
    } finally {
      inlineLaunch.settle();
    }
    if (inlineAdmission.blockedByEntry || !inlineAdmission.claim) {
      inlineLaunch.settle();
      return {
        result: 'Conversation queued while project settings are changing.',
        telemetry: undefined,
        isLlm: true,
        pending: true,
      };
    }
    const inlineAdmissionRelease = () => {
      inlineLaunch.settle();
      return releaseTaskAdmission(
        group.folder,
        inlineAdmissionId,
        inlineAdmission.ownerToken,
      );
    };
    try {
      const modelId = agent_cmd.includes(':')
        ? agent_cmd.split(':')[1]
        : agent_cmd;
      // Resolve the system prompt through the shared builder so the
      // on-the-wire order, the `CACHE_BREAKPOINT_MARKER` placement, and
      // the cacheable layout are identical to the sandbox path. The
      // builder also caches the full assembled string per
      // (group, conversation, mode, ...) tuple so a single chat turn —
      // which can call this helper more than once — never re-reads
      // files or re-queries the DB.
      //
      // `forDirectLlm: true` makes the builder inject:
      //   - base system prompt         (from group folder)
      //   - project rules              (from group folder)
      //   - toolset list               (the LLM doesn't auto-discover)
      //   - shared knowledge-base list
      //   - objective rules            (when in an objective chat)
      // The CLI sandbox path passes `false` and lets the agent discover
      // rules + tools from its CWD on its own.
      const baseDir =
        work_dir ||
        group.settings?.repositoryLocation ||
        path.join(GROUPS_DIR, group.folder);
      const effectiveUserId = overrides?.skipUserPreferences
        ? null
        : (overrides?.senderUserId ?? null);
      const currentInstructionState: TurnInstructionState = {
        channel: conversationChannel(chat_jid),
        liveMode: overrides?.liveMode === true,
        personaVoice: overrides?.personaVoice === true,
        chatMode: overrides?.chat_mode ?? null,
        humanUserId: effectiveUserId,
      };
      const instructionDelivery = resolveTurnInstructionDelivery(
        conversation_id
          ? readChatTranscript(group.folder, conversation_id)
          : [],
        sessionKey,
        currentInstructionState,
        overrides?.canonicalUserMessageId,
      );
      const humanContext = instructionDelivery.humanContext
        ? await loadPreferencesCascade(effectiveUserId, group.folder)
        : '';
      let channelPrompt = prompt;
      if (instructionDelivery.channel) {
        // Deliver the clock with initial context (and again after a context reset).
        // The decorated user message is replayed from history unchanged; the shared
        // system prefix remains independent of the chat's start time.
        const localDateTime = new Date().toLocaleString('sv-SE', {
          timeZone: TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
          timeZoneName: 'longOffset',
        });
        channelPrompt = `${appendChannelInstruction(prompt, chat_jid)}\n\nCurrent date and time: ${localDateTime} (${TIMEZONE})`;
      }
      const directPrompt = appendCurrentHumanContext(
        channelPrompt,
        humanContext,
      );
      let systemPrompt = await buildSystemPrompt({
        group_folder: group.folder,
        parentId: group.parentId,
        conversation_id,
        baseDir,
        chat_mode: overrides?.chat_mode ?? null,
        forDirectLlm: true,
        liveMode: overrides?.liveMode,
        personaVoice: overrides?.personaVoice === true,
      });
      const directBaseUrl =
        agentConfig?.baseUrl ||
        agentConfig?.env?.OPENAI_BASE_URL ||
        agentConfig?.env?.ANTHROPIC_BASE_URL;
      const isLlamaPersonaRuntime =
        /llama(?:\.cpp|-proxy)?/i.test(directBaseUrl ?? '') &&
        overrides?.ephemeral === true &&
        isDirectLlmPersonaAgent(agent_cmd) &&
        !overrides?.suppressPersonaProviderContext;
      // Ephemeral persona orchestration replays its developer/user tail in the
      // transcript, so appending the next persona after the shared history keeps
      // one cacheable provider prefix. Ordinary main-persona chat has no such
      // replay tail: keep its stable identity in top-level instructions instead,
      // otherwise every new canonical turn moves the developer message and the
      // provider can only reuse the fixed prefix before it.
      const responsesDeveloperInstructions = shouldReplayDirectLlmPersonaTail(
        agent_cmd,
        agentConfig?.wireApi,
        overrides?.ephemeral,
        overrides?.suppressPersonaProviderContext,
      )
        ? overrides?.systemPromptSuffix
        : undefined;
      const personaProviderInstructions =
        responsesDeveloperInstructions ||
        (isLlamaPersonaRuntime ? overrides?.systemPromptSuffix : undefined);
      if (overrides?.systemPromptSuffix && !personaProviderInstructions) {
        systemPrompt += `\n\n${overrides.systemPromptSuffix}`;
      }

      logger.info(
        { folder: group.folder, systemPromptLength: systemPrompt.length },
        'Direct LLM path: system prompt assembled via buildSystemPrompt',
      );

      // Load conversation history for multi-turn context
      let history: ConversationMessage[] = [];
      if (overrides?.historyOverride) {
        history = overrides.historyOverride.map((message) => ({ ...message }));
      } else if (conversation_id) {
        history = await getLlmHistory(
          group.folder,
          conversation_id,
          overrides?.excludeTrailingUserHistory,
          agent_cmd,
        );
      }

      appendTurnInstructionState(
        group.folder,
        conversation_id,
        sessionKey,
        currentInstructionState,
        humanContext
          ? effectiveUserId
          : instructionDelivery.previousHumanContextUserId === effectiveUserId
            ? effectiveUserId
            : null,
        overrides?.canonicalUserMessageId,
      );

      // The canonical transcript intentionally stores only what the human
      // typed. DirectLLM receives a decorated prompt (channel instruction and
      // current human context), and replaying the clean canonical row on the
      // next turn changes the provider prefix. Persist a hidden replacement
      // sidecar before any assistant events so later history reconstruction can
      // replay the exact input without leaking internal scaffolding into the UI.
      if (
        conversation_id &&
        !overrides?.ephemeral &&
        overrides?.canonicalUserMessageId
      ) {
        appendChatTranscriptEntry(group.folder, conversation_id, {
          type: 'message',
          role: 'user',
          content: directPrompt,
          attachments: overrides.attachments || undefined,
          agent_name: agent_cmd,
          provider_context: true,
          replacesMessageId: overrides.canonicalUserMessageId,
          created_at: new Date().toISOString(),
        } as any);
      }

      const permissions = await getAgentPermissionsResolved(
        group,
        registeredGroups,
      );
      const capturedTranscript: unknown[] = [];
      const inspection = (): ChatAgentInspection | undefined =>
        overrides?.captureInspection
          ? {
              systemPrompt: personaProviderInstructions
                ? `${systemPrompt}\n\n${personaProviderInstructions}`
                : systemPrompt,
              prompt: directPrompt,
              history,
              transcript: capturedTranscript
                .map((entry) => JSON.stringify(entry))
                .join('\n'),
            }
          : undefined;

      // Register AbortController so the stop button works
      const abortKey = chatAbortKey(group.folder, conversation_id, chat_jid);
      const abortCtrl = new AbortController();
      const abortFromParent = () => abortCtrl.abort();
      if (overrides?.signal?.aborted) abortCtrl.abort();
      else
        overrides?.signal?.addEventListener('abort', abortFromParent, {
          once: true,
        });
      chatRunAbortControllers.set(abortKey, abortCtrl);
      inlineLaunch.settle();

      const directTranscriptTarget =
        conversation_id && !overrides?.ephemeral
          ? chatTranscriptPath(group.folder, undefined, conversation_id)
          : undefined;
      let directTranscriptOffset = 0;
      if (directTranscriptTarget) {
        try {
          directTranscriptOffset = fs.statSync(directTranscriptTarget).size;
        } catch {
          /* the first canonical entry creates the transcript */
        }
      }

      try {
        const resResult = await runDirectLlm(
          systemPrompt,
          directPrompt,
          agentConfig?.model || modelId,
          throttledOnChunk,
          overrides?.attachments || [],
          history,
          {
            wireApi: agentConfig?.wireApi,
            baseUrl: directBaseUrl,
            apiKey:
              agentConfig?.apiKey ||
              agentConfig?.env?.OPENAI_API_KEY ||
              agentConfig?.env?.ANTHROPIC_API_KEY,
            temperature: agentConfig?.temperature,
            max_tokens: agentConfig?.max_tokens,
            top_p: agentConfig?.top_p,
            top_k: agentConfig?.top_k,
            frequency_penalty: agentConfig?.frequency_penalty,
            presence_penalty: agentConfig?.presence_penalty,
            extra_body: agentConfig?.extra_body,
            reasoning_effort:
              overrides?.reasoning_effort ?? agentConfig?.reasoning_effort,
            // context_size is the authoritative input+output ceiling; max_tokens
            // is passed alongside it so DirectLLM can reserve generation space.
            maxContextTokens: agentConfig?.context_size ?? undefined,
            signal: abortCtrl.signal,
            skipInitialLog: overrides?.skipInitialLog ?? false,
            disableSteering: overrides?.disableSteering ?? false,
            beforeSteeringComplete: overrides?.beforeSteeringComplete,
            onSteeringAbsorbed: overrides?.onSteeringAbsorbed,
            image: agentConfig?.image,
            audio: agentConfig?.audio,
            video: agentConfig?.video,
            apiFormat: agentConfig?.apiFormat,
            agent_id: agent_cmd,
            allowedToolNames: (agentConfig as any)?.allowedToolNames,
            run_id: overrides?.activeRunId,
            trigger_source: resolveTurnTriggerSource(
              overrides,
              effectiveUserId,
            ),
            developerInstructions: personaProviderInstructions,
            promptCacheKey:
              agentConfig?.wireApi === 'responses' && conversation_id
                ? directLlmPromptCacheKey(
                    group.folder,
                    conversation_id,
                    agentConfig?.model || modelId,
                  )
                : undefined,
            fallback: directLlmFallbackOption(agentConfig),
            privacy: { projectId: group.folder, purpose: 'chat' },
          },
          deps,
          (entry) => {
            if (overrides?.captureInspection)
              capturedTranscript.push(directLlmInspectionEntry(entry));
            if (conversation_id && !overrides?.ephemeral) {
              const cleanEntry =
                typeof (entry as any).content === 'string'
                  ? {
                      ...entry,
                      content: stripAiUserControlMetadata(
                        stripLiveMarkers((entry as any).content).content,
                      ),
                    }
                  : entry;
              appendChatTranscriptEntry(group.folder, conversation_id, {
                ...cleanEntry,
                agent_name: agent_cmd,
                created_at: new Date().toISOString(),
              });
            }
          },
          undefined, // Don't pass conversation_id as session_id to Direct LLM
          group.folder,
          undefined,
          permissions,
          conversation_id,
        );
        flushChunks();

        const directModel = resResult.model_name || agentConfig?.model;
        const cachedInput = resResult.tok_cache_read ?? 0;
        const directCostUsd = calculateModelCostUsd(directModel, {
          inputTokens: Math.max(0, (resResult.tok_input ?? 0) - cachedInput),
          cachedInputTokens: cachedInput,
          cacheWriteTokens: resResult.tok_cache_write,
          outputTokens: resResult.tok_output,
        });
        const telemetry: Record<string, unknown> = {
          tok_input: resResult.tok_input || 0,
          inputTokenSemantics: 'total',
          tok_output: resResult.tok_output || 0,
          total_tokens: resResult.total_tokens || 0,
          tok_context_last: resResult.tok_context_last,
          tok_cache_read: resResult.tok_cache_read,
          tok_cache_write: resResult.tok_cache_write,
          tok_reasoning: resResult.tok_reasoning,
          duration_ms: resResult.duration_ms,
          model_name: directModel,
          cost_usd: directCostUsd,
          context_size: agentConfig?.context_size || undefined,
          session_id: resResult.session_id,
        };

        // Only update session ID if it was actually provided by the provider and is not just the conversation_id
        if (
          conversation_id &&
          resResult.session_id &&
          resResult.session_id !== conversation_id
        ) {
          await setConversationSessionId(
            conversation_id,
            sessionKey,
            resResult.session_id,
            overrides?.chat_mode ?? null,
          );
        }

        // DirectLLM virtual participants are stateless at the SDK layer.
        // Preserve their invisible provider tail so the next request replays
        // the exact previous input before appending canonical conversation
        // content. This includes the main participant: omitting its tail breaks
        // cache continuity for the first invited participant after main.
        // The transcript formatter hides these entries from the chat UI.
        if (
          conversation_id &&
          overrides?.ephemeral &&
          isDirectLlmPersonaAgent(agent_cmd) &&
          personaProviderInstructions?.trim()
        ) {
          const providerContextBase = {
            type: 'message',
            agent_name: agent_cmd,
            provider_context: true,
            created_at: new Date().toISOString(),
          } as const;
          appendChatTranscriptEntry(group.folder, conversation_id, {
            ...providerContextBase,
            role: 'developer',
            content: personaProviderInstructions.trim(),
          } as any);
          appendChatTranscriptEntry(group.folder, conversation_id, {
            ...providerContextBase,
            role: 'user',
            content: directPrompt,
            attachments: overrides?.attachments || undefined,
          } as any);
        }

        if (conversation_id && !overrides?.ephemeral) {
          nameConversationInBackground(group.folder, conversation_id);
        }

        return {
          result: resResult.result,
          telemetry,
          isLlm: true,
          pending:
            overrides?.chat_mode === 'plan' &&
            extractPlanArtifact(resResult.result) !== null,
          generatedArtifacts: resResult.generatedArtifacts,
          activeRunId: overrides?.activeRunId,
          inspection: inspection(),
        };
      } catch (err: any) {
        // Detect user-initiated abort across SDKs:
        //   - Node fetch / standard AbortController throws { name: 'AbortError' }
        //   - OpenAI SDK throws APIUserAbortError
        //   - We also trust the controller's own state — if it's been aborted,
        //     any error coming out of the run is a consequence of that.
        const isUserAbort =
          abortCtrl.signal.aborted ||
          err?.name === 'AbortError' ||
          err?.name === 'APIUserAbortError';
        if (isUserAbort) {
          logger.info(
            { folder: group.folder, conversation_id },
            'Direct LLM run aborted',
          );
          return {
            result: '⚠️ Run stopped by user.',
            telemetry: undefined,
            isLlm: true,
            activeRunId: overrides?.activeRunId,
            inspection: inspection(),
          };
        }
        logger.error({ err, agent_cmd }, 'Direct LLM run failed');
        const errorMsg =
          err instanceof DirectLlmContextError
            ? `⚠️ **LLM context cannot fit safely**: ${err.message}`
            : `⚠️ **LLM Error**: ${err.message || 'Unknown error'}`;
        if (conversation_id && !overrides?.ephemeral) {
          appendChatTranscriptEntry(group.folder, conversation_id, {
            type: 'message',
            role: 'assistant',
            content: errorMsg,
            agent_name: agent_cmd,
            created_at: new Date().toISOString(),
          });
        }
        throttledOnChunk({ type: 'text', content: errorMsg });
        flushChunks();
        return {
          result: errorMsg,
          telemetry: undefined,
          isLlm: true,
          failed: true,
          activeRunId: overrides?.activeRunId,
          inspection: inspection(),
        };
      } finally {
        if (directTranscriptTarget) {
          let byteEndOffset = directTranscriptOffset;
          try {
            byteEndOffset = fs.statSync(directTranscriptTarget).size;
          } catch {
            /* no authoritative transcript entries were written */
          }
          if (byteEndOffset > directTranscriptOffset) {
            await bestEffort(
              'Direct LLM chat reflection scheduling',
              async () => {
                const effectiveSandbox = resolveEffectiveSandbox(group);
                await chatReflectionScheduler({
                  groupFolder: group.folder,
                  transcriptTarget: directTranscriptTarget,
                  byteOffset: directTranscriptOffset,
                  byteEndOffset,
                  profile: 'direct-llm-conversation',
                  objectiveId: conversation?.objective_id ?? null,
                  conversationId: conversation_id,
                  sandboxStack: effectiveSandbox.stack,
                  sandboxService: effectiveSandbox.service,
                  sandboxInstance: effectiveSandbox.instance,
                  sandboxWorkspacePath:
                    conversation?.use_worktree && conversation.branch_name
                      ? path.posix.join(
                          effectiveSandbox.workspaceRoot,
                          '.worktrees',
                          conversation.branch_name,
                        )
                      : effectiveSandbox.workspaceRoot,
                });
              },
            );
          }
        }
        overrides?.signal?.removeEventListener('abort', abortFromParent);
        chatRunAbortControllers.delete(abortKey);
      }
    } finally {
      await inlineAdmissionRelease();
    }
  }

  // Sandbox turns are not part of the restart wait (they are reattached).
  releaseDirectChatCount();

  // Regular Agent (Sandbox) path
  let sandboxPrompt = prompt;
  // Variants in the same session family find the existing native session and
  // skip the handoff summary. A different family receives the existing gap.
  if (
    conversation_id &&
    !prompt.includes('[CONTEXT_SUMMARY:') &&
    !(await getConversationSessionId(conversation_id, sessionKey))
  ) {
    const history = await getLlmHistory(group.folder, conversation_id);
    let summaryEntry = history.find(
      (m) => m.role === 'user' && m.content.startsWith('[CONTEXT_SUMMARY: '),
    );

    // If no summary entry exists yet, generate one from the gap
    if (!summaryEntry) {
      const gap = getAgentContextGap(
        group.folder,
        conversation_id,
        sessionKey,
        sessionIdOverride,
      );
      if (gap) {
        summaryEntry = { role: 'user', content: gap } as any;
      }
    }

    if (summaryEntry) {
      // Use a consistent format that agents are known to understand
      sandboxPrompt = `${summaryEntry.content}\n\n${prompt}`;
    }
  }
  const runResult = await runSandboxAgent(
    group,
    sandboxPrompt,
    chat_jid,
    throttledOnChunk,
    sessionIdOverride,
    forkSession,
    conversation_id,
    work_dir,
    {
      ...overrides,
      agent_cmd,
      agentConfig,
      objectiveWorkDirOf: workDirObjectiveId,
      // Taken from the original message, not the enriched `prompt`. Only a
      // person's chat message can carry a command: scheduled and objective
      // runs are board-authored.
      userCommand:
        overrides?.isScheduledTask || conversation?.objective_id
          ? undefined
          : leadingUserCommand(overrides?.userMessage, group.trigger),
    },
  );
  flushChunks();
  return { ...runResult, isLlm: false };
}

/**
 * Core agent execution — runAgent, ipcRelay, and observation scheduling.
 *
 * Extracted from whatsapp-router.ts because runAgent is used by multiple
 * entry points (WhatsApp, HTTP chat, objectives) and is not WhatsApp-specific.
 */

// Relay for intermediate messages (Long Tasks)
export const ipcRelay = new EventEmitter();
ipcRelay.on('error', (err) => {
  logger.warn({ err: String(err) }, 'ipcRelay error event');
});

export interface ChatReflectionRange {
  groupFolder: string;
  transcriptTarget: string;
  byteOffset: number;
  byteEndOffset: number;
  profile: TranscriptProfile;
  workspaceRoot?: string;
  objectiveId?: string | null;
  conversationId?: string;
  sandboxStack?: string;
  sandboxService?: string;
  sandboxInstance?: string;
  sandboxWorkspacePath?: string;
  admittedRunId?: string;
}

type ChatReflectionScheduler = (
  range: ChatReflectionRange,
) => void | Promise<void>;
type PendingChatReflections = {
  timer: ReturnType<typeof setTimeout>;
  ranges: ChatReflectionRange[];
};

// Per-group idle queues for bounded, source-profiled transcript reflection.
const pendingChatReflections = new Map<string, PendingChatReflections>();
const CHAT_IDLE_OBSERVATIONS_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/** Keep debounce coalescing aligned with the durable admission boundary. */
export function appendPendingChatReflectionRange(
  ranges: ChatReflectionRange[],
  range: ChatReflectionRange,
): void {
  const previous = ranges.at(-1);
  if (
    previous &&
    previous.groupFolder === range.groupFolder &&
    previous.transcriptTarget === range.transcriptTarget &&
    previous.profile === range.profile &&
    previous.workspaceRoot === range.workspaceRoot &&
    previous.objectiveId === range.objectiveId &&
    previous.conversationId === range.conversationId &&
    previous.sandboxStack === range.sandboxStack &&
    previous.sandboxService === range.sandboxService &&
    previous.sandboxInstance === range.sandboxInstance &&
    previous.sandboxWorkspacePath === range.sandboxWorkspacePath &&
    previous.admittedRunId === range.admittedRunId &&
    range.byteOffset <= previous.byteEndOffset
  ) {
    previous.byteOffset = Math.min(previous.byteOffset, range.byteOffset);
    previous.byteEndOffset = Math.max(
      previous.byteEndOffset,
      range.byteEndOffset,
    );
    return;
  }
  ranges.push(range);
}

async function scheduleChatObservations(
  range: ChatReflectionRange,
): Promise<void> {
  const admitted = await admitTranscriptMemory(
    range.groupFolder,
    range.transcriptTarget,
    range,
  );
  if (admitted) {
    range.byteOffset = admitted.byteOffset;
    range.byteEndOffset = admitted.byteEndOffset;
    range.admittedRunId = admitted.runId;
  }
  const existing = pendingChatReflections.get(range.groupFolder);
  if (existing) {
    clearTimeout(existing.timer);
    logger.debug(
      { group_folder: range.groupFolder },
      'Chat observation timer reset (new message)',
    );
  }
  const ranges = existing?.ranges ?? [];
  appendPendingChatReflectionRange(ranges, range);
  const timer = setTimeout(async () => {
    pendingChatReflections.delete(range.groupFolder);
    logger.debug(
      { group_folder: range.groupFolder, ranges: ranges.length },
      'Chat idle timer fired — extracting observations',
    );
    for (const pending of ranges) {
      automaticTranscriptReflectionQueue.enqueue({
        sourceKey: `${pending.groupFolder}\0${pending.transcriptTarget}`,
        jobKey: pending.admittedRunId,
        process: async () => {
          const result = pending.admittedRunId
            ? await processAdmittedAutomaticTranscriptMemory(
                pending.groupFolder,
                pending.transcriptTarget,
                pending.admittedRunId,
              )
            : await processAutomaticTranscriptMemory(
                pending.groupFolder,
                pending.transcriptTarget,
                {
                  byteOffset: pending.byteOffset,
                  byteEndOffset: pending.byteEndOffset,
                  profile: pending.profile,
                  workspaceRoot: pending.workspaceRoot,
                  objectiveId: pending.objectiveId,
                  conversationId: pending.conversationId,
                  sandboxStack: pending.sandboxStack,
                  sandboxService: pending.sandboxService,
                  sandboxInstance: pending.sandboxInstance,
                  sandboxWorkspacePath: pending.sandboxWorkspacePath,
                },
              );
          if (!isIncompleteAutomaticReflection(result)) {
            logger.debug(
              { group_folder: pending.groupFolder },
              'Chat observations extracted successfully',
            );
          }
          return result;
        },
        onIncomplete: (err) =>
          logger.warn(
            {
              err,
              ...describeIncompleteReflection(err),
              group_folder: pending.groupFolder,
            },
            'Deferred chat reflector incomplete; retry scheduled',
          ),
      });
    }
  }, CHAT_IDLE_OBSERVATIONS_DELAY_MS);
  timer.unref?.();
  pendingChatReflections.set(range.groupFolder, { timer, ranges });
  logger.debug(
    {
      group_folder: range.groupFolder,
      delayMs: CHAT_IDLE_OBSERVATIONS_DELAY_MS,
    },
    'Chat observation timer scheduled',
  );
}

let chatReflectionScheduler: ChatReflectionScheduler = scheduleChatObservations;

/** Run post-run bookkeeping that must not change the outcome of the turn. */
async function bestEffort(
  what: string,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    logger.warn({ err }, `${what} failed; the run result is unaffected`);
  }
}

/** Replace only the deferred scheduling boundary for behavioral runner tests. */
export function setChatReflectionSchedulerForTests(
  scheduler: ChatReflectionScheduler | null,
): void {
  chatReflectionScheduler = scheduler ?? scheduleChatObservations;
}

/** Resolve checkout ownership independently of the child transcript/session. */
export function resolveConversationCheckout(
  group: RegisteredGroup,
  conversation: Awaited<ReturnType<typeof getConversation>>,
  checkoutConversationId?: string,
) {
  if (!checkoutConversationId) return {};
  if (!conversation || conversation.group_folder !== group.folder) {
    throw new Error('Checkout conversation does not belong to this project');
  }
  if (!conversation.use_worktree) return {};
  if (conversation.worktreeMissing) {
    throw new Error('Conversation worktree was removed');
  }
  if (!group.settings?.repositoryLocation) {
    throw new Error('Conversation worktree requires a configured repository');
  }
  return {
    branch_name: conversation.branch_name || `chat-${checkoutConversationId}`,
    localRepo: group.settings.repositoryLocation,
    worktreeFiles: group.settings.worktreeFiles,
    worktree_path: conversation.worktree_path || undefined,
    worktreeRequested: true,
    checkoutConversationId,
  };
}

const PRE_SESSION_FAILURE_MAX_CHARS = 500;

/**
 * Failure text for a run that errored before the agent produced any output
 * (launch error, missing cwd, stopped service, stale mount). Streamed live and
 * persisted to the transcript, which callers' `skipTranscript` saves and an
 * ask settlement read, so the reason is neither lost on reload nor reported as
 * "(no answer text)". Credentials are scrubbed and the length is capped.
 */
function preSessionFailureMessage(reason: string | null | undefined): string {
  const scrubbed = scrubSecretText(
    (reason || 'Unknown error').replace(/^Failed to launch agent:\s*/i, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  const capped =
    scrubbed.length > PRE_SESSION_FAILURE_MAX_CHARS
      ? `${scrubbed.slice(0, PRE_SESSION_FAILURE_MAX_CHARS)}…`
      : scrubbed;
  return `⚠️ **Sandbox Error**: The agent could not start: ${capped}`;
}

export async function runSandboxAgent(
  group: RegisteredGroup,
  prompt: string,
  chat_jid: string,
  onChunk?: (data: ChunkData) => void,
  sessionIdOverride?: string | null,
  forkSession?: boolean,
  conversation_id?: string,
  work_dir?: string,
  overrides?: {
    agent_cmd?: string | null;
    model?: string | null;
    agentConfig?: any;
    env?: Record<string, string>;
    senderUserId?: string | null;
    triggeredByUserId?: string | null;
    triggerSource?: TriggerSource;
    signal?: AbortSignal;
    skipUserPreferences?: boolean;
    reasoning_effort?: string;
    chat_mode?: ChatModeOverride | null;
    liveMode?: boolean;
    /** Persona Live Mode: this persona turn's reply is read aloud. */
    personaVoice?: boolean;
    systemPromptSuffix?: string;
    /** Canonical visible user row used to detect human-speaker changes. */
    canonicalUserMessageId?: string;
    mainPersonaGeneration?: number;
    /** Instruction revision selecting an invited persona's warm session. */
    personaSessionRevision?: string;
    /**
     * Current invited-participant roster instructions (null when there are
     * none). Delivered to a continuing session when it differs from the
     * roster that session last saw; omit when the caller does not manage it.
     */
    participantRoster?: string | null;
    ephemeral?: boolean;
    captureInspection?: boolean;
    suppressPersonaProviderContext?: boolean;
    scheduledTaskId?: string;
    isScheduledTask?: boolean;
    agentAskId?: string;
    onSlotAcquired?: (runId: string) => void | Promise<void>;
    skipSharedCheckoutLease?: boolean;
    skipBaseBranchSync?: boolean;
    /** Parent checkout only; never used for transcript or session ownership. */
    checkoutConversationId?: string;
    /** Override the sandbox run's ordinary wall-clock timeout in seconds. */
    timeout?: number;
    /** Run after CarapaBox starts the selected sandbox, before agent launch. */
    onCheckoutReady?: ContainerInput['onCheckoutReady'];
    /** Raw leading slash command from the user's message (see runChatAgent). */
    userCommand?: string;
    /** Objective whose derived working directory `work_dir` is. */
    objectiveWorkDirOf?: string;
  },
): Promise<ChatAgentRunResult> {
  const isMain = !!group.is_main;
  let targetAgent = overrides?.agent_cmd;
  const conversation = conversation_id
    ? await getConversation(conversation_id)
    : undefined;
  if (!targetAgent) {
    if (conversation?.runtimeSelection) {
      targetAgent = resolveRuntimeSelection(
        applyAutoModelPin(
          conversation.runtimeSelection,
          conversation.routedModel,
        ) ?? conversation.runtimeSelection,
      ).id;
    }
  }
  const rawAgentCmd = targetAgent || resolveChatAgent(group);

  // Chat execution accepts only materialized v2 binding IDs. The route and
  // implicit resolver supply those IDs from structured runtime selections.
  const agents = getChatAgents();
  const agentConfig =
    overrides?.agentConfig || agents.find((agent) => agent.id === rawAgentCmd);
  const agent_cmd = agentConfig?.agentCmd || rawAgentCmd;
  const isLlm = isDirectRuntime(agentConfig);
  const baseSessionKey = agentConfig
    ? runtimeSessionKey(agentConfig)
    : agent_cmd;
  const sessionKey = overrides?.mainPersonaGeneration
    ? mainPersonaSessionKey(baseSessionKey, overrides.mainPersonaGeneration)
    : baseSessionKey;

  // Reject agents that aren't registered in board_agents.jsonc. Without this
  // check, an unknown agent_cmd is forwarded to run-agent.sh, which has no case
  // branch for it, and the launcher's positional args ("--exec <run-dir>") leak
  // through as flags to the unrecognised binary — surfacing as a cryptic
  // "unknown option '--exec'" sandbox error.
  if (rawAgentCmd && !overrides?.agentConfig && !agentConfig) {
    const knownIds = agents.map((a) => a.id).join(', ') || '(none configured)';
    const errorMessage = `⚠️ Agent *${rawAgentCmd}* is not registered. Available agents: ${knownIds}. Add it to \`data/board_agents.jsonc\` to enable.`;
    logger.warn(
      { group: group.folder, conversation_id, rawAgentCmd, knownIds },
      'Rejecting unregistered agent command',
    );
    if (conversation_id) {
      appendChatTranscriptEntry(group.folder, conversation_id, {
        type: 'message',
        role: 'assistant',
        content: errorMessage,
        created_at: new Date().toISOString(),
      });
    }
    return {
      result: errorMessage,
      telemetry: undefined,
      isLlm: false,
      failed: true,
    };
  }

  // null = explicitly start fresh (web chat new conversation, no global fallback)
  // undefined = look up the per-(conversation, agent) session, falling back to
  //             sessions[folder] (WhatsApp/legacy) when there is no conversation.
  // string = use this exact session
  //
  // Session rows use the provider-aware runtime session key. This prevents a
  // native Codex thread from being resumed against another provider.
  let session_id: string | undefined;
  if (sessionIdOverride !== undefined) {
    session_id = sessionIdOverride ?? undefined;
  } else if (conversation_id && sessionKey) {
    session_id =
      (await getConversationSessionId(conversation_id, sessionKey)) ??
      undefined;
  } else {
    session_id = sessions[group.folder];
  }

  // Drop session if the agent command changed at the group level (WhatsApp/legacy, no conversation_id)
  if (session_id && rawAgentCmd && !conversation_id) {
    const lastCmd = sessionAgentCmds[group.folder];
    if (lastCmd && lastCmd !== rawAgentCmd) {
      logger.info(
        {
          group: group.folder,
          lastAgent: lastCmd,
          newAgent: rawAgentCmd,
        },
        'Chat session reset — agent command changed',
      );
      session_id = undefined;
    }
  }

  // Don't inject kanban/task/run state into every prompt — it bloats context and
  // confuses agents into acting on stale tasks. Agents can query state on demand
  // via MCP tools (list_scheduled_tasks, etc.) when they actually need it.
  // First turn (or post-compaction refresh): inject AGENT_CONTEXT, system prompt,
  // and the direct-chat INSTRUCTION. Continuation turns send only the user text.
  let injectBootstrap = !session_id;
  // The flag stays set until the agent streams output (it has then consumed the
  // bootstrap), so a turn that ends earlier re-injects it on the next turn.
  let pendingCompactedSession: string | undefined;
  if (session_id && compactedSessions.has(session_id)) {
    injectBootstrap = true;
    pendingCompactedSession = session_id;
  }

  const effectiveUserId = overrides?.skipUserPreferences
    ? null
    : (overrides?.senderUserId ?? null);
  const currentInstructionState: TurnInstructionState = {
    channel: conversationChannel(chat_jid),
    liveMode: overrides?.liveMode === true,
    personaVoice: overrides?.personaVoice === true,
    chatMode: overrides?.chat_mode ?? null,
    humanUserId: effectiveUserId,
    rosterRevision:
      overrides?.participantRoster === undefined
        ? undefined
        : overrides.participantRoster === null
          ? null
          : createPersonaInstructionRevision([overrides.participantRoster]),
  };
  const instructionDelivery = resolveTurnInstructionDelivery(
    conversation_id ? readChatTranscript(group.folder, conversation_id) : [],
    sessionKey,
    currentInstructionState,
    overrides?.canonicalUserMessageId,
  );
  let finalPrompt =
    injectBootstrap || instructionDelivery.channel
      ? appendChannelInstruction(prompt, chat_jid)
      : prompt;

  // Persistent CLI sessions receive state changes as turn instructions. A
  // bootstrap carries Live/chat mode through its system prompt instead.
  finalPrompt = appendLiveInstructionForContinuation(
    finalPrompt,
    conversation_id,
    injectBootstrap,
    overrides?.liveMode === true,
    instructionDelivery.liveMode,
    overrides?.personaVoice === true,
  );
  const humanContext =
    injectBootstrap || instructionDelivery.humanContext
      ? await loadPreferencesCascade(effectiveUserId, group.folder)
      : '';
  finalPrompt = appendCurrentHumanContext(finalPrompt, humanContext);
  // Keep the native session intact when the composer mode changes. The
  // session's original system prompt cannot be replaced mid-session, so send
  // the current mode as a per-turn instruction instead of resetting the session.
  if (session_id && !injectBootstrap && instructionDelivery.chatMode) {
    const mode = overrides?.chat_mode ?? null;
    const instruction = mode
      ? CHAT_MODE_TURN_INSTRUCTIONS[mode] ||
        'Follow the project-specific instructions for the selected chat mode.'
      : 'Use the normal/default behavior; no special chat mode is active.';
    finalPrompt = `${finalPrompt}\n\n[CHAT_MODE: ${mode ?? 'default'}]\n[INSTRUCTION: ${instruction}]`;
  }

  if (session_id && !injectBootstrap && instructionDelivery.roster) {
    finalPrompt = `${finalPrompt}\n\n${rosterUpdateInstruction(overrides?.participantRoster ?? null)}`;
  }

  let fallbackPrompt =
    conversation_id && session_id
      ? buildSessionRecoveryPrompt(
          finalPrompt,
          // No session boundary: a fresh native thread needs the recent
          // canonical conversation, including the interrupted agent's intent.
          getAgentContextGap(
            group.folder,
            conversation_id,
            sessionKey || agent_cmd,
            null,
          ),
        )
      : undefined;

  let releaseConversationAdmission: (() => Promise<void>) | undefined;
  // Set once the agent session streams anything; a failure before that point
  // leaves no trace in the transcript unless the runner records it. Ephemeral
  // (transcript-silent) runs leave that to their caller.
  let agentOutputStarted = false;
  const reportPreSessionFailure = (reason: string | null | undefined) => {
    const message = preSessionFailureMessage(reason);
    if (onChunk) onChunk({ type: 'text', content: `\n\n${message}` });
    if (conversation_id && !overrides?.ephemeral) {
      appendChatTranscriptEntry(group.folder, conversation_id, {
        type: 'message',
        role: 'assistant',
        content: message,
        agent_name: 'sandbox-launch',
        created_at: new Date().toISOString(),
      });
    }
    return message;
  };
  try {
    const conversationAdmissionId = conversation_id
      ? `conversation:${conversation_id}`
      : `conversation:${group.folder}:${chat_jid}`;
    const conversationAdmission = await claimNormalTaskAdmission(
      group.folder,
      () => 'conversation',
      true,
      conversationAdmissionId,
      group.settings?.taskCheckoutMode ?? 'shared',
    );
    if (conversationAdmission.blockedByEntry || !conversationAdmission.claim) {
      return {
        result: 'Conversation queued while project settings are changing.',
        telemetry: undefined,
        isLlm: false,
        pending: true,
      };
    }
    releaseConversationAdmission = () =>
      releaseTaskAdmission(
        group.folder,
        conversationAdmissionId,
        conversationAdmission.ownerToken,
      );
    const checkoutConversationId =
      overrides?.checkoutConversationId || conversation_id;
    const conv = checkoutConversationId
      ? await getConversation(checkoutConversationId)
      : undefined;
    const chatCheckout = resolveConversationCheckout(
      group,
      conv,
      checkoutConversationId,
    );

    // Objective chats keep their objective CWD and native local instructions.
    // Inherit the owning group's rules through the prompt shared by every
    // harness, only at bootstrap/compaction (or a fresh-session recovery).
    // Direct runtimes already receive these rules in buildSystemPrompt.
    const contextConversation =
      conversation_id === checkoutConversationId
        ? conv
        : conversation_id
          ? await getConversation(conversation_id)
          : undefined;
    if (
      !isLlm &&
      contextConversation?.objective_id &&
      contextConversation.group_folder === group.folder
    ) {
      const groupHome = getGroupHomeDir(group.folder, group.parentId);
      const sandboxGroupDir = effectiveContainerGroupDir(group);
      const rules = loadAgentRules(groupHome, sandboxGroupDir);
      if (rules) {
        const inherited = `[INHERITED GROUP RULES]\nSource directory: ${sandboxGroupDir}\nRelative paths in these inherited rules are relative to that source directory.${rules}\n[END INHERITED GROUP RULES]\n\n`;
        if (injectBootstrap) finalPrompt = inherited + finalPrompt;
        if (fallbackPrompt) fallbackPrompt = inherited + fallbackPrompt;
      }
    }

    // CLI agents discover repository rules and tools in their CWD. Scheduled
    // Direct runs intentionally share this tracked execution path, but still
    // need the Direct system prompt with its explicit rules and tool list.
    let systemPrompt = await buildSystemPrompt({
      group_folder: group.folder,
      parentId: group.parentId,
      conversation_id,
      baseDir:
        work_dir ||
        group.settings?.repositoryLocation ||
        path.join(GROUPS_DIR, group.folder),
      chat_mode: overrides?.chat_mode ?? null,
      forDirectLlm: isLlm,
      liveMode: overrides?.liveMode,
      personaVoice: overrides?.personaVoice === true,
    });
    if (overrides?.systemPromptSuffix)
      systemPrompt += `\n\n${overrides.systemPromptSuffix}`;

    appendTurnInstructionState(
      group.folder,
      conversation_id,
      sessionKey,
      currentInstructionState,
      humanContext
        ? effectiveUserId
        : instructionDelivery.previousHumanContextUserId === effectiveUserId
          ? effectiveUserId
          : null,
      overrides?.canonicalUserMessageId,
      currentInstructionState.rosterRevision !== undefined
        ? currentInstructionState.rosterRevision
        : instructionDelivery.previousRosterRevision,
    );

    const runStartedAt = new Date().toISOString();
    const output = await containerAgentRunner(
      group,
      {
        prompt: finalPrompt,
        fallbackPrompt,
        rawMessage: conversation_id ? undefined : prompt,
        session_id,
        group_folder: group.folder,
        chat_jid,
        isMain,
        model: overrides?.model || agentConfig?.model,
        fallback_model: agentConfig?.fallback?.model,
        fallback_reasoning_effort: agentConfig?.fallback
          ? agentConfig?.reasoning_effort
          : undefined,
        agent_cmd,
        runtimeConfig: agentConfig,
        privacyRuntime: agentConfig,
        transcript_agent_name: rawAgentCmd,
        session_agent_key: sessionKey,
        reasoning_effort:
          overrides?.reasoning_effort ?? agentConfig?.reasoning_effort,
        agent: agentConfig?.agent,
        bare: agentConfig?.bare,
        chat_mode: overrides?.chat_mode ?? null,
        prompt_cache_ttl: conversation?.promptCache1h ? '1h' : undefined,
        env: agentConfig?.env,
        systemPrompt: injectBootstrap || isLlm ? systemPrompt : undefined,
        // A fork's copied session carries the source chat's AGENT_CONTEXT, so
        // its first turn must receive its own.
        injectAgentContext: injectBootstrap || isLlm || !!forkSession,
        userCommand: overrides?.userCommand,
        skipTranscriptMemory: true,
        ephemeral: overrides?.ephemeral,
        captureTranscript: overrides?.captureInspection,
        forkSession,
        conversation_id,
        main_persona_generation: overrides?.mainPersonaGeneration,
        persona_session_revision: overrides?.personaSessionRevision,
        isScheduledTask: overrides?.isScheduledTask,
        triggeredByUserId:
          overrides?.triggeredByUserId !== undefined
            ? overrides.triggeredByUserId
            : (effectiveUserId ?? null),
        triggerSource: resolveTurnTriggerSource(overrides, effectiveUserId),
        scheduled_task_id: overrides?.scheduledTaskId,
        agent_ask_id: overrides?.agentAskId,
        onSlotAcquired: overrides?.onSlotAcquired,
        skipSharedCheckoutLease: overrides?.skipSharedCheckoutLease,
        skipBaseBranchSync: overrides?.skipBaseBranchSync,
        // Forward parent's abort signal so the sandbox sub-run can be cancelled
        // when the parent's stop button is pressed (used by agent_query tool).
        signal: overrides?.signal,
        timeout: overrides?.timeout,
        onCheckoutReady: overrides?.onCheckoutReady,
        // Override working directory (e.g. objective folder)
        ...(work_dir ? { work_dir } : {}),
        ...(work_dir && overrides?.objectiveWorkDirOf
          ? { objective_work_dir_of: overrides.objectiveWorkDirOf }
          : {}),
        ...chatCheckout,
      },
      // Reuse the same throttled chunk mechanism for sandbox agents
      (chunk) => {
        if (chunk.type === 'text' || chunk.type === 'session')
          agentOutputStarted = true;
        if (agentOutputStarted && pendingCompactedSession) {
          compactedSessions.delete(pendingCompactedSession);
          pendingCompactedSession = undefined;
        }
        if (onChunk) onChunk(chunk);
        if (chunk.type === 'compaction') {
          // A newer compaction supersedes the one this turn was waiting on.
          pendingCompactedSession = undefined;
          const sid = session_id || chunk.session_id;
          if (sid) compactedSessions.add(sid);
        }
      },
    );

    // The run has succeeded; bookkeeping failures below are logged and must not
    // turn its output into an error reply.
    // Ephemeral workers may share a project and checkout with an owning chat,
    // but their provider session remains detached from durable chat ownership.
    if (!overrides?.ephemeral && output.newSessionId) {
      const newSessionId = output.newSessionId;
      await bestEffort('Persisting the chat session id', async () => {
        if (conversation_id && sessionKey) {
          // Web-chat run: persist per (conversation, session family).
          await setConversationSessionId(
            conversation_id,
            sessionKey,
            newSessionId,
            overrides?.chat_mode ?? null,
          );
        } else {
          // WhatsApp/legacy run: update the per-group session store.
          sessions[group.folder] = newSessionId;
          saveSessions();
        }
      });
    }

    // Track which agent command was used so we can detect switches and drop stale sessions
    if (!overrides?.ephemeral && rawAgentCmd) {
      await bestEffort('Persisting the chat agent command', async () => {
        if (conversation_id) {
          await setConversationAgentCmd(conversation_id, rawAgentCmd);
        } else {
          sessionAgentCmds[group.folder] = rawAgentCmd;
        }
      });
    }

    // Schedule observation extraction to run after the conversation goes idle.
    // If a new message arrives within the delay, the timer is cancelled and reset.
    const transcriptTarget = output.transcriptTarget;
    if (transcriptTarget) {
      await bestEffort('Chat reflection scheduling', async () => {
        let byteEndOffset = output.transcriptOffset ?? 0;
        try {
          byteEndOffset = fs.statSync(transcriptTarget).size;
        } catch {
          /* cleanup may have intentionally omitted an ephemeral transcript */
        }
        if (
          output.transcriptOffset !== undefined &&
          byteEndOffset > output.transcriptOffset
        ) {
          const effectiveSandbox = resolveEffectiveSandbox(group);
          await chatReflectionScheduler({
            groupFolder: group.folder,
            transcriptTarget,
            byteOffset: output.transcriptOffset,
            byteEndOffset,
            profile: isLlm
              ? 'direct-llm-conversation'
              : 'run-agent-conversation',
            workspaceRoot: output.workspaceRoot,
            objectiveId: contextConversation?.objective_id ?? null,
            conversationId: conversation_id,
            sandboxStack: effectiveSandbox.stack,
            sandboxService: effectiveSandbox.service,
            sandboxInstance:
              output.sandboxInstance ?? effectiveSandbox.instance,
            sandboxWorkspacePath: chatCheckout.branch_name
              ? path.posix.join(
                  effectiveSandbox.workspaceRoot,
                  '.worktrees',
                  chatCheckout.branch_name,
                )
              : effectiveSandbox.workspaceRoot,
          });
        }
      });
    }

    // The host artifact tree is authoritative. Persist native Codex plans here
    // instead of trusting a sandbox bind mount to point at the same host path
    // CarapaBoard scans for the UI and Group folder.
    let planArtifact: ReturnType<typeof extractPlanArtifact> = null;
    await bestEffort('Persisting the plan artifact', async () => {
      planArtifact =
        extractPlanArtifact(output.result) ??
        extractPlanArtifactFromTranscript(
          group.folder,
          conversation_id,
          runStartedAt,
        );
      if (planArtifact) {
        await writeArtifactFile(
          group.folder,
          planArtifact.relPath,
          Buffer.from(
            planArtifact.text.endsWith('\n')
              ? planArtifact.text
              : `${planArtifact.text}\n`,
          ),
          { mimetype: 'text/markdown', source: 'agent' },
        );
        broadcast({
          type: 'artifacts_changed',
          payload: { folder: group.folder },
        });
      }
    });

    const telemetry = buildSandboxRunTelemetry(output, {
      modelName: overrides?.model || agentConfig?.model,
      contextSize: agentConfig?.context_size,
    });

    if (output.stoppedByUser) {
      await releaseConversationAdmission?.();
      return {
        result: output.result,
        telemetry,
        isLlm: false,
        uuid: output.uuid,
        activeRunId: output.activeRunId,
        generatedArtifacts: output.generatedArtifacts,
        inspection: overrides?.captureInspection
          ? {
              systemPrompt,
              prompt: finalPrompt,
              transcript: output.rawTranscript || '',
              systemPromptInjected: injectBootstrap,
            }
          : undefined,
      };
    }

    if (output.status === 'error') {
      const beforeAgentOutput = !output.result && !agentOutputStarted;
      const errorMsg = beforeAgentOutput
        ? reportPreSessionFailure(output.error)
        : `⚠️ **Sandbox Error**: ${output.error || 'Agent failed to produce output'}`;
      if (!beforeAgentOutput && onChunk)
        onChunk({ type: 'text', content: `\n\n${errorMsg}` });
      const finalResult = output.result
        ? `${output.result}\n\n${errorMsg}`
        : errorMsg;
      await releaseConversationAdmission?.();
      return {
        result: finalResult,
        telemetry,
        isLlm: false,
        failed: true,
        uuid: output.uuid,
        activeRunId: output.activeRunId,
        inspection: overrides?.captureInspection
          ? {
              systemPrompt,
              prompt: finalPrompt,
              transcript: output.rawTranscript || '',
              systemPromptInjected: injectBootstrap,
            }
          : undefined,
      };
    }
    await releaseConversationAdmission?.();
    if (conversation_id && !overrides?.ephemeral) {
      nameConversationInBackground(group.folder, conversation_id);
    }
    return {
      result: output.result,
      telemetry,
      isLlm: false,
      pending: overrides?.chat_mode === 'plan' && planArtifact !== null,
      uuid: output.uuid,
      activeRunId: output.activeRunId,
      generatedArtifacts: output.generatedArtifacts,
      inspection: overrides?.captureInspection
        ? {
            systemPrompt,
            prompt: finalPrompt,
            transcript: output.rawTranscript || '',
            systemPromptInjected: injectBootstrap,
          }
        : undefined,
    };
  } catch (err: any) {
    logger.error({ err }, 'Sandbox agent run failed');
    const errorMsg = agentOutputStarted
      ? `⚠️ **Sandbox Run Error**: ${err.message || 'Unknown error'}`
      : reportPreSessionFailure(err.message);
    await releaseConversationAdmission?.();
    return {
      result: errorMsg,
      telemetry: undefined,
      isLlm: false,
      failed: true,
    };
  }
}
