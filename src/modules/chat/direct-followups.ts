import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  ASSISTANT_NAME,
  DEFAULT_SANDBOX_SERVICE,
  DEFAULT_SANDBOX_STACK,
  MCP_AGENT_TIMEOUT,
} from '../../config.js';
import {
  beginDirectFollowupDispatch,
  closeClaimedDirectFollowupRun,
  completeActiveRun,
  getActiveRunById,
  getRunningDirectFollowupRuns,
  insertActiveRunIfAbsent,
  stopClaimedDirectFollowupRuns,
  type RunTokenStats,
} from '../../db/active-runs.js';
import {
  getConversation,
  getChatMessageById,
  getConversationsForHistoryReflection,
  getQueuedChatMessageStates,
  consumeQueuedChatMessageExactlyOnce,
  releaseUnconsumedQueuedChatMessages,
  saveChatMessage,
  withQueuedChatMessageClaim,
} from './db-chats.js';
import { getObjective } from '../objectives/db-objectives.js';
import { aggregateRunStats } from '../objectives/objective-run-stats.js';
import { getObjectiveDir } from '../objectives/objective-folder.js';
import {
  appendChatTranscriptEntryAsync,
  readChatTranscript,
  readLiveChatTranscriptAsync,
} from '../../group-dir.js';
import { runChatAgent } from '../../agent-runner.js';
import {
  beginBackgroundWork,
  DIRECT_CHAT_WORK_LABEL,
} from '../../lib/background-work-gate.js';
import { getResolvedRuntimeConfig } from '../../lib/resolve-agent-config.js';
import { sharedDeps } from '../../mcp/mcp-deps.js';
import {
  getGroupByFolder,
  lastAgentTimestamp,
  registeredGroups,
  saveState,
} from '../../state-manager.js';
import { broadcast } from '../objectives/ws-events.js';
import {
  broadcastConversationEvent,
  chatEventScope,
} from './conversation-scope.js';
import { notifyEntityLifecycle } from '../tools/push-tools.js';
import { logger } from '../../logger.js';
import { stripLiveMarkers } from './live-activity.js';
import {
  acquireConversationExecutionLease,
  releaseConversationExecutionLease,
  releaseDeadConversationExecutionLease,
  startConversationExecutionLeaseHeartbeat,
} from './conversation-execution-lease.js';
import {
  resolveMainPersonaSession,
  runMainAiUserFollowUp,
} from '../ai-users/orchestrator.js';
import {
  closeDirectLlmDeliveryGate,
  deleteDirectLlmDeliveryGate,
  openDirectLlmDeliveryGate,
} from './direct-llm-delivery.js';
import {
  chatAbortKey,
  chatRunAbortControllers,
} from '../../sandbox/process.js';
import type {
  DirectChatFollowupClaim,
  DirectChatFollowupMetadata,
} from './types.js';
import type { ActiveRun } from '../kanban/execution/types.js';
import type { ChatMessage } from './types.js';
import { sendMessage } from '../messaging/send-message.js';
import { runPublicPersonaTurns } from './public-persona-runner.js';
import { updatePublicPromptRequest } from './db-public-shares.js';
import { publishPublicConversationEvent } from './public-conversation-events.js';

const scheduledRuns = new Set<string>();

const CLAIM_RETRY_MS = 250;
/**
 * Longest a claim may wait behind a blocker. A live conversation turn is itself
 * bounded by MCP_AGENT_TIMEOUT, so a blocker still present this long after the
 * claim's last durable event is hung (e.g. a heartbeating lease whose turn never
 * ends), not a turn the claim should keep waiting for.
 */
const CLAIM_MAX_WAIT_MS = MCP_AGENT_TIMEOUT * 1_000 + 15 * 60_000;

function hashField(hash: Hash, value: string): void {
  hash.update(String(Buffer.byteLength(value)));
  hash.update(':');
  hash.update(value);
}

/** A stable, bounded PK that never embeds untrusted conversation/message IDs. */
export function directFollowupRunId(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): string {
  const hash = createHash('sha256');
  hashField(hash, groupFolder);
  hashField(hash, conversationId);
  hashField(hash, messageId);
  return `direct-followup:${hash.digest('hex')}`;
}
function parseMetadata(
  value: Record<string, unknown>,
): DirectChatFollowupMetadata | undefined {
  if (
    typeof value.conversation_id !== 'string' ||
    typeof value.executionContent !== 'string' ||
    typeof value.agentCmd !== 'string'
  ) {
    return undefined;
  }
  const runtime = value.runtimeSelection;
  const runtimeSelection =
    runtime &&
    typeof runtime === 'object' &&
    'harnessId' in runtime &&
    typeof runtime.harnessId === 'string' &&
    'modelId' in runtime &&
    typeof runtime.modelId === 'string'
      ? {
          harnessId: runtime.harnessId,
          modelId: runtime.modelId,
          ...('reasoning' in runtime && typeof runtime.reasoning === 'string'
            ? { reasoning: runtime.reasoning }
            : {}),
        }
      : undefined;
  const source = value.triggerSource;
  const triggerSource =
    source === 'user' ||
    source === 'agent' ||
    source === 'schedule' ||
    source === 'public' ||
    source === 'system'
      ? source
      : undefined;
  const rawDelivery = value.delivery;
  const delivery =
    rawDelivery &&
    typeof rawDelivery === 'object' &&
    'kind' in rawDelivery &&
    rawDelivery.kind === 'whatsapp' &&
    'chatJid' in rawDelivery &&
    typeof rawDelivery.chatJid === 'string' &&
    'triggerTimestamp' in rawDelivery &&
    typeof rawDelivery.triggerTimestamp === 'string'
      ? {
          kind: 'whatsapp' as const,
          chatJid: rawDelivery.chatJid,
          triggerTimestamp: rawDelivery.triggerTimestamp,
        }
      : rawDelivery &&
          typeof rawDelivery === 'object' &&
          'kind' in rawDelivery &&
          rawDelivery.kind === 'public-persona' &&
          'interactionId' in rawDelivery &&
          typeof rawDelivery.interactionId === 'string' &&
          'visitorName' in rawDelivery &&
          typeof rawDelivery.visitorName === 'string'
        ? {
            kind: 'public-persona' as const,
            interactionId: rawDelivery.interactionId,
            visitorName: rawDelivery.visitorName,
          }
        : undefined;
  return {
    conversationId: value.conversation_id,
    ...(typeof value.objectiveId === 'string'
      ? { objectiveId: value.objectiveId }
      : {}),
    executionContent: value.executionContent,
    agentCmd: value.agentCmd,
    ...(runtimeSelection ? { runtimeSelection } : {}),
    ...(typeof value.chatMode === 'string' || value.chatMode === null
      ? { chatMode: value.chatMode }
      : {}),
    ...(typeof value.senderUserId === 'string' || value.senderUserId === null
      ? { senderUserId: value.senderUserId }
      : {}),
    ...(Array.isArray(value.lifecycleRecipientUserIds) &&
    value.lifecycleRecipientUserIds.every((id) => typeof id === 'string')
      ? { lifecycleRecipientUserIds: value.lifecycleRecipientUserIds }
      : {}),
    ...(typeof value.triggeredByUserId === 'string' ||
    value.triggeredByUserId === null
      ? { triggeredByUserId: value.triggeredByUserId }
      : {}),
    ...(triggerSource ? { triggerSource } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

/**
 * Durably admit an already-persisted human message to the serialized Direct
 * follow-up boundary. The transcript receipts survive process restarts while
 * the deterministic active-run ID makes repeated producer admission harmless.
 */
export async function enqueuePersistedDirectFollowup(input: {
  message: ChatMessage;
  metadata: DirectChatFollowupMetadata;
  /** The message is not saved yet: it becomes a canonical message, with a fresh `created_at`, when its turn is claimed. */
  deferMessage?: boolean;
}): Promise<string> {
  const { message, metadata } = input;
  if (input.deferMessage)
    await appendChatTranscriptEntryAsync(
      message.group_folder,
      metadata.conversationId,
      {
        ...message,
        type: 'queued_user_message',
        // Only the Direct follow-up owns this entry. Steering and the persona
        // boundary must not inject the raw message ahead of its prompt.
        directOwned: true,
        queuedExecutionContent: metadata.executionContent,
        queuedAgentCmd: metadata.agentCmd,
        queuedRuntimeSelection: metadata.runtimeSelection,
        queuedChatMode: metadata.chatMode ?? null,
        conversation_id: metadata.conversationId,
      },
    );
  await appendChatTranscriptEntryAsync(
    message.group_folder,
    metadata.conversationId,
    {
      type: 'direct_user_pending',
      messageId: message.id,
      conversation_id: metadata.conversationId,
      ...(metadata.objectiveId ? { objectiveId: metadata.objectiveId } : {}),
      agentCmd: metadata.agentCmd,
      ...(metadata.runtimeSelection
        ? { runtimeSelection: metadata.runtimeSelection }
        : {}),
      chatMode: metadata.chatMode ?? null,
      executionContent: metadata.executionContent,
      ...(metadata.senderUserId !== undefined
        ? { senderUserId: metadata.senderUserId }
        : {}),
      ...(metadata.lifecycleRecipientUserIds
        ? { lifecycleRecipientUserIds: metadata.lifecycleRecipientUserIds }
        : {}),
      triggeredByUserId: metadata.triggeredByUserId ?? null,
      triggerSource: metadata.triggerSource ?? 'system',
      ...(metadata.delivery ? { delivery: metadata.delivery } : {}),
      created_at: message.created_at,
    },
  );
  const handoff = await releaseAndClaimDirectFollowups(
    message.group_folder,
    metadata.conversationId,
  );
  for (const claim of handoff.claimed)
    scheduleClaimedDirectFollowup(claim.runId);
  return directFollowupRunId(
    message.group_folder,
    metadata.conversationId,
    message.id,
  );
}

function reconstructClaim(
  groupFolder: string,
  conversationId: string,
  requestedMessageId?: string,
  requestedRunId?: string,
):
  | {
      claim: DirectChatFollowupClaim;
      consumed: boolean;
      finished: boolean;
      steered: boolean;
      eligible: boolean;
    }
  | undefined {
  const entries = readChatTranscript(groupFolder, conversationId);
  const pending = new Map<string, DirectChatFollowupMetadata>();
  const queuedMessages = new Map<string, DirectChatFollowupClaim['message']>();
  const released = new Set<string>();
  const steered = new Set<string>();
  const consumed = new Set<string>();
  const withdrawn = new Set<string>();
  const finished = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const messageId =
      typeof value.messageId === 'string' ? value.messageId : undefined;
    if (value.type === 'direct_user_pending' && messageId) {
      const metadata = parseMetadata(value);
      if (metadata) pending.set(messageId, metadata);
    } else if (
      value.type === 'queued_user_message' &&
      typeof value.id === 'string' &&
      typeof value.content === 'string' &&
      typeof value.created_at === 'string' &&
      typeof value.queuedExecutionContent === 'string' &&
      typeof value.queuedAgentCmd === 'string'
    ) {
      const queuedId = value.id;
      const metadata = parseMetadata({
        conversation_id: conversationId,
        executionContent: value.queuedExecutionContent,
        agentCmd: value.queuedAgentCmd,
        runtimeSelection: value.queuedRuntimeSelection,
        chatMode: value.queuedChatMode,
        triggeredByUserId:
          typeof value.senderUserId === 'string' ? value.senderUserId : null,
        triggerSource: value.triggerSource,
      });
      if (metadata) pending.set(queuedId, metadata);
      queuedMessages.set(queuedId, {
        ...(value as any),
        id: queuedId,
        group_folder: groupFolder,
        role: 'user',
        content: value.content,
        source: typeof value.source === 'string' ? value.source : 'web',
        created_at: value.created_at,
        conversation_id: conversationId,
      });
    } else if (value.type === 'queued_user_released' && messageId) {
      released.add(messageId);
    } else if (
      value.type === 'steering_delivery' &&
      value.delivery === 'steered' &&
      messageId
    ) {
      steered.add(messageId);
    } else if (value.type === 'queued_user_consumed' && messageId) {
      consumed.add(messageId);
    } else if (value.type === 'queued_user_withdrawn' && messageId) {
      withdrawn.add(messageId);
    } else if (value.type === 'direct_followup_finished' && messageId) {
      finished.add(messageId);
    }
  }
  for (const [messageId, metadata] of pending) {
    if (requestedMessageId && messageId !== requestedMessageId) continue;
    if (withdrawn.has(messageId)) continue;
    const runId = directFollowupRunId(groupFolder, conversationId, messageId);
    if (requestedRunId && runId !== requestedRunId) continue;
    const message =
      getChatMessageById(groupFolder, conversationId, messageId) ??
      queuedMessages.get(messageId);
    if (!message) continue;
    return {
      claim: { runId, groupFolder, conversationId, message, metadata },
      consumed: consumed.has(messageId),
      finished: finished.has(messageId),
      steered: steered.has(messageId),
      eligible:
        released.has(messageId) &&
        !steered.has(messageId) &&
        !consumed.has(messageId) &&
        !finished.has(messageId),
    };
  }
  return undefined;
}

/** The run sender: an explicit queued attribution (even `null`) wins over the message sender. */
function claimSenderUserId(claim: DirectChatFollowupClaim): string | null {
  return claim.metadata.senderUserId !== undefined
    ? claim.metadata.senderUserId
    : (claim.message.senderUserId ?? null);
}

function activeRunForClaim(claim: DirectChatFollowupClaim): ActiveRun {
  const now = new Date();
  return {
    id: claim.runId,
    group_folder: claim.groupFolder,
    chat_jid: `${claim.groupFolder}@web`,
    session_id: null,
    conversation_id: claim.conversationId,
    isMain: 0,
    isScheduledTask: 0,
    scheduled_task_id: null,
    task_id: null,
    sandbox_stack: DEFAULT_SANDBOX_STACK,
    sandbox_service: DEFAULT_SANDBOX_SERVICE,
    sandbox_instance: null,
    started_at: claim.message.created_at,
    timeout_at: new Date(
      now.getTime() + MCP_AGENT_TIMEOUT * 1_000,
    ).toISOString(),
    last_event_at: now.toISOString(),
    status: 'running',
    model: claim.metadata.runtimeSelection?.modelId ?? null,
    agent_name: claim.metadata.agentCmd,
    completed_at: null,
    tok_total: null,
    tok_output: null,
    tok_input: null,
    tok_cache_write: null,
    tok_cache_read: null,
    tok_context_last: null,
    model_name: null,
    tool_usage_count: null,
    stage: 'direct-followup:claimed',
    triggeredByUserId: claim.metadata.triggeredByUserId ?? null,
    triggerSource: claim.metadata.triggerSource ?? 'system',
  };
}

async function claimReleasedDirectFollowupWithoutLock(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): Promise<{ claim: DirectChatFollowupClaim; won: boolean } | undefined> {
  const reconstructed = reconstructClaim(
    groupFolder,
    conversationId,
    messageId,
  );
  if (!reconstructed) return undefined;
  const won = reconstructed.eligible
    ? await insertActiveRunIfAbsent(activeRunForClaim(reconstructed.claim))
    : false;
  const active = await getActiveRunById(reconstructed.claim.runId);
  if (!won && !active && !reconstructed.finished) return undefined;
  return { claim: reconstructed.claim, won };
}

/** Claim one released Direct prompt through the same ownership boundary used
 * by browser withdrawal. The deterministic active-run insert owns cross-process
 * retries; this lock orders transcript ownership within the Board process. */
export async function claimReleasedDirectFollowup(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): Promise<{ claim: DirectChatFollowupClaim; won: boolean } | undefined> {
  return withQueuedChatMessageClaim(
    groupFolder,
    conversationId,
    messageId,
    async () => {
      const result = await claimReleasedDirectFollowupWithoutLock(
        groupFolder,
        conversationId,
        messageId,
      );
      if (!result) return undefined;
      const alreadyClaimed = readChatTranscript(
        groupFolder,
        conversationId,
      ).some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as Record<string, unknown>).type === 'queued_user_claimed' &&
          (entry as Record<string, unknown>).messageId === messageId,
      );
      if (!alreadyClaimed) {
        await appendChatTranscriptEntryAsync(groupFolder, conversationId, {
          type: 'queued_user_claimed',
          messageId,
          runId: result.claim.runId,
          created_at: new Date().toISOString(),
          conversation_id: conversationId,
        });
      }
      return result;
    },
  );
}

export async function releaseAndClaimDirectFollowups(
  groupFolder: string,
  conversationId: string,
): Promise<{
  claimed: DirectChatFollowupClaim[];
  releasedMessageIds: string[];
}> {
  const released = await releaseUnconsumedQueuedChatMessages(
    groupFolder,
    conversationId,
    async (messageId) =>
      (
        await claimReleasedDirectFollowupWithoutLock(
          groupFolder,
          conversationId,
          messageId,
        )
      )?.claim.runId,
  );
  const conversationRuns = (await getRunningDirectFollowupRuns(conversationId))
    .filter((run) => run.group_folder === groupFolder)
    .sort(
      (left, right) =>
        left.started_at.localeCompare(right.started_at) ||
        left.id.localeCompare(right.id),
    );
  const hasDispatched = conversationRuns.some(
    (run) => run.stage === 'direct-followup:dispatched',
  );
  const nextRun = hasDispatched
    ? undefined
    : conversationRuns.find((run) => run.stage === 'direct-followup:claimed');
  const next = nextRun?.conversation_id
    ? reconstructClaim(
        nextRun.group_folder,
        nextRun.conversation_id,
        undefined,
        nextRun.id,
      )?.claim
    : undefined;
  return {
    claimed: next ? [next] : [],
    releasedMessageIds: released,
  };
}

export function scheduleClaimedDirectFollowup(runId: string): void {
  if (scheduledRuns.has(runId)) return;
  scheduledRuns.add(runId);
  queueMicrotask(() => {
    void dispatchClaimedDirectFollowup(runId)
      .catch(async (err) => {
        // A thrown dispatch used to be an unhandled rejection that left the
        // row claimed; close it visibly instead.
        logger.error({ err, runId }, 'Direct follow-up dispatch threw');
        await closeStuckClaim(runId, String(err)).catch((closeErr) =>
          logger.error({ err: closeErr, runId }, 'Closing claim failed'),
        );
      })
      .finally(() => {
        scheduledRuns.delete(runId);
      });
  });
}

/** Terminalize a claim that can no longer be dispatched: completed when its
 * message was already answered, otherwise error + the visible "not processed"
 * message. Another turn may still own the conversation, so this publishes
 * neither `chat_completed` nor a lifecycle push and hands nothing off: that
 * turn's own end does. The row is finished
 * atomically before any side effect, so a concurrent dispatch cannot start it. */
async function closeStuckClaim(runId: string, reason: string): Promise<void> {
  const run = await getActiveRunById(runId);
  if (
    !run ||
    run.status !== 'running' ||
    run.stage !== 'direct-followup:claimed' ||
    !run.conversation_id
  )
    return;
  const reconstructed = reconstructClaim(
    run.group_folder,
    run.conversation_id,
    undefined,
    runId,
  );
  const answered =
    !!reconstructed && (reconstructed.finished || reconstructed.steered);
  if (
    !(await closeClaimedDirectFollowupRun(
      runId,
      answered ? 'completed' : 'error',
    ))
  )
    return;
  if (!reconstructed || answered) return;
  await terminalizeStoppedDirectFollowup(
    reconstructed.claim,
    reconstructed.consumed,
    `⚠️ The queued message could not be processed: ${reason}`,
  );
}

/**
 * Re-schedule a claim that could not start yet. Every blocker here is live (a
 * heartbeating lease, a turn in this process, a dispatched sibling; dead leases
 * are reclaimed before), so the claim waits for that turn to end, but only for
 * CLAIM_MAX_WAIT_MS since its last durable event: beyond any turn's own timeout
 * the blocker is hung, and the claim is closed visibly instead of pinning the
 * conversation in Running. Awaited by the dispatcher, so the claim stays
 * scheduled until the closure settles.
 */
async function retryClaim(run: ActiveRun, reason: string): Promise<void> {
  const waitedMs = Date.now() - Date.parse(run.last_event_at ?? run.started_at);
  if (waitedMs <= CLAIM_MAX_WAIT_MS) {
    setTimeout(
      () => scheduleClaimedDirectFollowup(run.id),
      CLAIM_RETRY_MS,
    ).unref?.();
    return;
  }
  logger.warn(
    { runId: run.id, conversationId: run.conversation_id, reason, waitedMs },
    'Giving up on a queued direct follow-up that never became dispatchable',
  );
  await closeStuckClaim(
    run.id,
    `${reason} for over ${Math.round(CLAIM_MAX_WAIT_MS / 60_000)} minutes`,
  );
}

function numericTelemetry(
  telemetry: Record<string, unknown> | undefined,
): RunTokenStats | undefined {
  if (!telemetry) return undefined;
  const number = (key: string) =>
    typeof telemetry[key] === 'number' ? (telemetry[key] as number) : undefined;
  return {
    total_tokens: number('total_tokens'),
    tok_output: number('tok_output'),
    tok_input: number('tok_input'),
    tok_cache_write: number('tok_cache_write'),
    tok_cache_read: number('tok_cache_read'),
    tok_context_last: number('tok_context_last'),
    tok_reasoning: number('tok_reasoning'),
    cost_usd: number('cost_usd'),
    model_name:
      typeof telemetry.model_name === 'string'
        ? telemetry.model_name
        : undefined,
  };
}

async function finishClaim(
  claim: DirectChatFollowupClaim,
  outcome: 'completed' | 'failed',
  assistantMessageId: string,
  telemetry?: Record<string, unknown>,
): Promise<void> {
  await appendChatTranscriptEntryAsync(
    claim.groupFolder,
    claim.conversationId,
    {
      type: 'direct_followup_finished',
      messageId: claim.message.id,
      runId: claim.runId,
      assistantMessageId,
      outcome,
      created_at: new Date().toISOString(),
      conversation_id: claim.conversationId,
      ...(claim.metadata.objectiveId
        ? { objectiveId: claim.metadata.objectiveId }
        : {}),
    },
  );
  await completeActiveRun(
    claim.runId,
    outcome === 'completed' ? 'completed' : 'error',
    numericTelemetry(telemetry),
  );
}

/** Request-independent Direct turn used by server-owned released messages. */
async function runDirectConversationTurn(
  claim: DirectChatFollowupClaim,
  signal?: AbortSignal,
): Promise<void> {
  const group = getGroupByFolder(claim.groupFolder);
  const conversation = await getConversation(claim.conversationId);
  if (
    !group ||
    !conversation ||
    conversation.group_folder !== claim.groupFolder
  ) {
    throw new Error('Direct follow-up conversation is unavailable');
  }
  const objective = conversation.objective_id
    ? await getObjective(conversation.objective_id)
    : undefined;
  if (
    conversation.objective_id &&
    (!objective || objective.project_id !== claim.groupFolder)
  ) {
    throw new Error('Direct follow-up objective is unavailable');
  }
  if (claim.metadata.delivery?.kind === 'public-persona') {
    const delivery = claim.metadata.delivery;
    try {
      const responderCount = await runPublicPersonaTurns({
        conversationId: claim.conversationId,
        interactionId: delivery.interactionId,
        prompt: claim.metadata.executionContent,
        visitorName: delivery.visitorName,
      });
      await updatePublicPromptRequest(delivery.interactionId, {
        status: 'completed',
        responderCount,
        completedAt: new Date().toISOString(),
      });
      publishPublicConversationEvent(claim.conversationId, {
        type: 'changed',
      });
      await finishClaim(
        claim,
        'completed',
        `${delivery.interactionId}:public-personas`,
      );
      await notifyEntityLifecycle({
        group_folder: claim.groupFolder,
        conversation_id: claim.conversationId,
        run_id: claim.runId,
        event: 'completed',
        title: 'Conversation completed',
        recipient_user_ids: claim.metadata.lifecycleRecipientUserIds,
      });
    } catch (err) {
      logger.error(
        { err, runId: claim.runId },
        'Queued public persona turn failed',
      );
      await updatePublicPromptRequest(delivery.interactionId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      publishPublicConversationEvent(claim.conversationId, {
        type: 'changed',
      });
      await finishClaim(
        claim,
        'failed',
        `${delivery.interactionId}:public-personas`,
      );
      await notifyEntityLifecycle({
        group_folder: claim.groupFolder,
        conversation_id: claim.conversationId,
        run_id: claim.runId,
        event: 'failed',
        title: 'Conversation failed',
        recipient_user_ids: claim.metadata.lifecycleRecipientUserIds,
      });
    }
    const handoff = await releaseAndClaimDirectFollowups(
      claim.groupFolder,
      claim.conversationId,
    );
    for (const next of handoff.claimed)
      scheduleClaimedDirectFollowup(next.runId);
    return;
  }
  const { mainAiUserContext: mainPersona, mainPersonaGeneration } =
    await resolveMainPersonaSession(claim.conversationId, group);
  const agentConfig = getResolvedRuntimeConfig(
    group,
    claim.metadata.runtimeSelection,
    claim.metadata.agentCmd,
  );
  if (mainPersona) {
    const streamKey = randomUUID();
    broadcast({
      type: 'chat_started',
      payload: {
        folder: claim.groupFolder,
        conversation_id: claim.conversationId,
        streamKey,
        personaDriven: true,
      },
    });
    let telemetry: Record<string, unknown> | undefined;
    const response = await runMainAiUserFollowUp({
      group,
      conversationId: claim.conversationId,
      runId: claim.runId,
      humanPrompt: claim.metadata.executionContent,
      humanName: claim.message.sender_name ?? 'Human',
      senderUserId: claimSenderUserId(claim),
      triggeredByUserId: claim.metadata.triggeredByUserId ?? null,
      triggerSource: claim.metadata.triggerSource ?? 'system',
      participantContext:
        'This durable human message arrived while another conversation turn was finishing. Answer it before continuing.',
      deps: sharedDeps,
      onTurnChunk: (messageId, content) =>
        broadcast({
          type: 'chat_persona_output',
          payload: {
            folder: claim.groupFolder,
            conversation_id: claim.conversationId,
            streamKey,
            messageId,
            content,
          },
        }),
      onMessage: (message) => {
        telemetry = (message.telemetry ?? undefined) as
          | Record<string, unknown>
          | undefined;
        broadcast({
          type: 'chat_message',
          payload: { folder: claim.groupFolder, message },
        });
      },
    });
    if (!response)
      throw new Error('Queued human persona turn produced no response');
    await finishClaim(claim, 'completed', response.id, telemetry);
    const handoff = await releaseAndClaimDirectFollowups(
      claim.groupFolder,
      claim.conversationId,
    );
    broadcast({
      type: 'chat_completed',
      payload: {
        folder: claim.groupFolder,
        conversation_id: claim.conversationId,
        streamKey,
        telemetry,
        releasedQueuedMessageIds: handoff.releasedMessageIds,
        consumedQueuedMessageIds: getQueuedChatMessageStates(
          claim.groupFolder,
          claim.conversationId,
        ).consumed,
      },
    });
    await notifyEntityLifecycle({
      group_folder: claim.groupFolder,
      conversation_id: claim.conversationId,
      run_id: claim.runId,
      event: 'completed',
      title: 'Conversation completed',
      recipient_user_ids: claim.metadata.lifecycleRecipientUserIds,
    });
    for (const next of handoff.claimed)
      scheduleClaimedDirectFollowup(next.runId);
    return;
  }
  const deliveryGate = openDirectLlmDeliveryGate(claim.conversationId);

  const streamKey = randomUUID();
  const scope = chatEventScope(claim.groupFolder, objective?.id);
  broadcast({
    type: 'chat_started',
    payload: {
      ...scope,
      conversation_id: claim.conversationId,
      streamKey,
    },
  });

  let telemetry: Record<string, unknown> | undefined;
  let failed = false;
  let response = '';
  try {
    try {
      const result = await runChatAgent(
        group,
        claim.metadata.executionContent,
        `${claim.groupFolder}@web`,
        (chunk) => {
          if (chunk.type !== 'text') return;
          broadcast({
            type: 'chat_output',
            payload: {
              ...scope,
              conversation_id: claim.conversationId,
              streamKey,
              content: chunk.content,
            },
          });
        },
        undefined,
        false,
        claim.conversationId,
        undefined, // Working directory follows conversation scope in the shared runner.
        {
          ...(agentConfig
            ? {
                agentConfig,
                agent_cmd: agentConfig.id,
                model: agentConfig.model,
                reasoning_effort: agentConfig.reasoning_effort,
              }
            : { agent_cmd: claim.metadata.agentCmd }),
          attachments: claim.message.attachments ?? undefined,
          skipInitialLog: true,
          senderUserId: claimSenderUserId(claim),
          triggeredByUserId: claim.metadata.triggeredByUserId ?? null,
          triggerSource: claim.metadata.triggerSource ?? 'system',
          chat_mode: claim.metadata.chatMode,
          excludeTrailingUserHistory: true,
          canonicalUserMessageId: claim.message.id,
          mainPersonaGeneration,
          activeRunId: claim.runId,
          signal,
          beforeSteeringComplete: () =>
            closeDirectLlmDeliveryGate(claim.conversationId, deliveryGate),
          onSteeringAbsorbed: async (messages) => {
            for (const message of messages) {
              broadcastConversationEvent(
                {
                  type: 'chat_message',
                  payload: {
                    folder: claim.groupFolder,
                    message: { ...message, steeringDelivery: 'steered' },
                  },
                },
                claim.groupFolder,
                objective?.id,
              );
            }
          },
        },
        sharedDeps,
      );
      telemetry = result.telemetry;
      failed = result.failed === true || !result.result;
      response = result.result || '⚠️ The agent failed to respond.';
    } catch (err) {
      failed = true;
      response = `⚠️ The agent failed to respond: ${err instanceof Error ? err.message : String(err)}`;
      logger.error({ err, runId: claim.runId }, 'Direct follow-up failed');
    }
  } finally {
    await closeDirectLlmDeliveryGate(claim.conversationId, deliveryGate);
    deleteDirectLlmDeliveryGate(claim.conversationId, deliveryGate);
  }
  response = stripLiveMarkers(response).content;
  const streamedAssistant = recoveredAssistant(claim);
  const assistant = await saveChatMessage({
    group_folder: claim.groupFolder,
    role: 'assistant',
    content: response,
    sender_name: null,
    source: claim.metadata.delivery?.kind === 'whatsapp' ? 'whatsapp' : 'web',
    created_at: new Date().toISOString(),
    conversation_id: claim.conversationId,
    objective_id: objective?.id ?? null,
    telemetry,
    failed,
    skipTranscript: streamedAssistant !== undefined,
  });
  broadcastConversationEvent(
    {
      type: 'chat_message',
      payload: { folder: claim.groupFolder, message: assistant },
    },
    claim.groupFolder,
    objective?.id,
  );
  if (claim.metadata.delivery?.kind === 'whatsapp') {
    const delivery = claim.metadata.delivery;
    await sendMessage(delivery.chatJid, `${ASSISTANT_NAME}: ${response}`);
    if (
      !lastAgentTimestamp[delivery.chatJid] ||
      lastAgentTimestamp[delivery.chatJid] < delivery.triggerTimestamp
    ) {
      lastAgentTimestamp[delivery.chatJid] = delivery.triggerTimestamp;
      saveState();
    }
  }
  await finishClaim(
    claim,
    failed ? 'failed' : 'completed',
    assistant.id,
    telemetry,
  );

  const handoff = await releaseAndClaimDirectFollowups(
    claim.groupFolder,
    claim.conversationId,
  );
  broadcast({
    type: 'chat_completed',
    payload: {
      ...scope,
      conversation_id: claim.conversationId,
      streamKey,
      telemetry,
      failed,
      releasedQueuedMessageIds: handoff.releasedMessageIds,
      consumedQueuedMessageIds: getQueuedChatMessageStates(
        claim.groupFolder,
        claim.conversationId,
      ).consumed,
    },
  });
  await notifyEntityLifecycle({
    group_folder: claim.groupFolder,
    conversation_id: claim.conversationId,
    run_id: claim.runId,
    event: failed ? 'failed' : 'completed',
    title: failed ? 'Conversation failed' : 'Conversation completed',
    recipient_user_ids: claim.metadata.lifecycleRecipientUserIds,
  });
  for (const next of handoff.claimed) scheduleClaimedDirectFollowup(next.runId);
}

interface RecoveredAssistant {
  id?: string;
  content: string;
  createdAt?: string;
}

function recoveredAssistant(
  claim: DirectChatFollowupClaim,
): RecoveredAssistant | undefined {
  const entries = readChatTranscript(claim.groupFolder, claim.conversationId);
  const consumedIndex = entries.findIndex(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      'type' in entry &&
      entry.type === 'queued_user_consumed' &&
      'messageId' in entry &&
      entry.messageId === claim.message.id &&
      'runId' in entry &&
      entry.runId === claim.runId,
  );
  if (consumedIndex < 0) return undefined;
  const trailingEntries = entries.slice(consumedIndex + 1);
  let outcome: { messageId: string } | undefined;
  for (let index = trailingEntries.length - 1; index >= 0; index--) {
    const entry = trailingEntries[index];
    if (
      entry &&
      typeof entry === 'object' &&
      'type' in entry &&
      entry.type === 'turn_outcome' &&
      'messageId' in entry &&
      typeof entry.messageId === 'string'
    ) {
      outcome = { messageId: entry.messageId };
      break;
    }
  }
  for (let index = trailingEntries.length - 1; index >= 0; index--) {
    const entry = trailingEntries[index];
    if (
      entry &&
      typeof entry === 'object' &&
      'type' in entry &&
      entry.type === 'message' &&
      'role' in entry &&
      entry.role === 'assistant' &&
      'content' in entry &&
      typeof entry.content === 'string' &&
      entry.content.trim()
    ) {
      return {
        content: entry.content,
        id:
          outcome?.messageId ??
          ('id' in entry && typeof entry.id === 'string'
            ? entry.id
            : undefined),
        createdAt:
          'created_at' in entry && typeof entry.created_at === 'string'
            ? entry.created_at
            : undefined,
      };
    }
  }
  return undefined;
}

async function terminalizeDirectFollowupFailure(
  claim: DirectChatFollowupClaim,
  failureContent: string,
  scheduleNext = true,
): Promise<void> {
  if (claim.metadata.delivery?.kind === 'public-persona') {
    await updatePublicPromptRequest(claim.metadata.delivery.interactionId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
    publishPublicConversationEvent(claim.conversationId, { type: 'changed' });
    await finishClaim(
      claim,
      'failed',
      `${claim.metadata.delivery.interactionId}:public-personas`,
    );
    await notifyEntityLifecycle({
      group_folder: claim.groupFolder,
      conversation_id: claim.conversationId,
      run_id: claim.runId,
      event: 'failed',
      title: 'Conversation failed',
      recipient_user_ids: claim.metadata.lifecycleRecipientUserIds,
    });
    if (!scheduleNext) return;
    const handoff = await releaseAndClaimDirectFollowups(
      claim.groupFolder,
      claim.conversationId,
    );
    for (const next of handoff.claimed)
      scheduleClaimedDirectFollowup(next.runId);
    return;
  }
  const conversation = await getConversation(claim.conversationId);
  const objective = conversation?.objective_id
    ? await getObjective(conversation.objective_id)
    : undefined;
  const recovered = recoveredAssistant(claim);
  const createdAt = recovered?.createdAt ?? new Date().toISOString();
  const assistant = recovered
    ? {
        id: recovered.id ?? `${claim.runId}:recovered`,
        group_folder: claim.groupFolder,
        role: 'assistant' as const,
        content: recovered.content,
        sender_name: null,
        source: 'web' as const,
        created_at: createdAt,
        conversation_id: claim.conversationId,
        objective_id: objective?.id ?? null,
        failed: true,
      }
    : await saveChatMessage({
        id: `${claim.runId}:failure`,
        group_folder: claim.groupFolder,
        role: 'assistant',
        content: failureContent,
        sender_name: null,
        source: 'web',
        created_at: createdAt,
        conversation_id: claim.conversationId,
        objective_id: objective?.id ?? null,
        failed: true,
      });
  if (!recovered)
    broadcastConversationEvent(
      {
        type: 'chat_message',
        payload: { folder: claim.groupFolder, message: assistant },
      },
      claim.groupFolder,
      objective?.id,
    );
  await finishClaim(claim, 'failed', assistant.id);
  if (!scheduleNext) return;
  const handoff = await releaseAndClaimDirectFollowups(
    claim.groupFolder,
    claim.conversationId,
  );
  const scope = chatEventScope(claim.groupFolder, objective?.id);
  broadcast({
    type: 'chat_completed',
    payload: {
      ...scope,
      conversation_id: claim.conversationId,
      failed: true,
      releasedQueuedMessageIds: handoff.releasedMessageIds,
      consumedQueuedMessageIds: getQueuedChatMessageStates(
        claim.groupFolder,
        claim.conversationId,
      ).consumed,
    },
  });
  await notifyEntityLifecycle({
    group_folder: claim.groupFolder,
    conversation_id: claim.conversationId,
    run_id: claim.runId,
    event: 'failed',
    title: 'Conversation failed',
    recipient_user_ids: claim.metadata.lifecycleRecipientUserIds,
  });
  for (const next of handoff.claimed) scheduleClaimedDirectFollowup(next.runId);
}

async function terminalizeStoppedDirectFollowup(
  claim: DirectChatFollowupClaim,
  consumed: boolean,
  failureContent = '⚠️ Run stopped by user.',
): Promise<void> {
  if (!consumed) {
    // Materializes a deferred message too, so a stopped follow-up still shows it.
    const consumption = await consumeQueuedChatMessageExactlyOnce(
      claim.message,
      { consumer: 'direct-followup', runId: claim.runId },
    );
    if (consumption.message)
      broadcast({
        type: 'chat_message',
        payload: { folder: claim.groupFolder, message: consumption.message },
      });
  }
  await terminalizeDirectFollowupFailure(claim, failureContent, false);
}

/** Stop only claims that have not crossed the provider-dispatch boundary. */
export async function stopClaimedDirectFollowups(
  groupFolder: string,
  conversationId: string,
): Promise<boolean> {
  const stoppedRuns = await stopClaimedDirectFollowupRuns(
    groupFolder,
    conversationId,
  );
  for (const run of stoppedRuns) {
    const reconstructed = reconstructClaim(
      groupFolder,
      conversationId,
      undefined,
      run.id,
    );
    if (!reconstructed || reconstructed.finished) continue;
    await terminalizeStoppedDirectFollowup(
      reconstructed.claim,
      reconstructed.consumed,
    );
  }
  return stoppedRuns.length > 0;
}

export async function dispatchClaimedDirectFollowup(
  runId: string,
): Promise<boolean> {
  const run = await getActiveRunById(runId);
  if (
    !run ||
    run.status !== 'running' ||
    run.stage !== 'direct-followup:claimed' ||
    !run.conversation_id
  ) {
    return false;
  }
  let executionLease = await acquireConversationExecutionLease(
    run.conversation_id,
    runId,
  );
  // A lease left behind by a run that died with the previous process (its TTL
  // is MCP_AGENT_TIMEOUT + 60 s, i.e. days) would otherwise block this claim.
  if (
    !executionLease &&
    (await releaseDeadConversationExecutionLease(run.conversation_id))
  ) {
    logger.warn(
      { runId, conversationId: run.conversation_id },
      'Reclaimed a conversation lease whose owner stopped heartbeating',
    );
    executionLease = await acquireConversationExecutionLease(
      run.conversation_id,
      runId,
    );
  }
  if (!executionLease) {
    await retryClaim(run, 'the conversation is still busy');
    return false;
  }
  const stopLeaseHeartbeat = startConversationExecutionLeaseHeartbeat(
    run.conversation_id,
    runId,
  );
  let reconstructed: ReturnType<typeof reconstructClaim>;
  try {
    reconstructed = reconstructClaim(
      run.group_folder,
      run.conversation_id,
      undefined,
      runId,
    );
  } catch (err) {
    stopLeaseHeartbeat();
    await releaseConversationExecutionLease(run.conversation_id, runId);
    throw err;
  }
  if (!reconstructed || reconstructed.finished || reconstructed.steered) {
    // A claim whose message or receipts are gone can never dispatch; leaving
    // it running would pin the conversation in the Now list forever. A steered
    // message was already answered by the live turn that took it.
    await completeActiveRun(runId, !reconstructed ? 'error' : 'completed');
    stopLeaseHeartbeat();
    await releaseConversationExecutionLease(run.conversation_id, runId);
    return false;
  }

  // Reserve the conversation abort boundary before the durable dispatch
  // transition. Stop can therefore cancel both sides of the chat_started /
  // provider-controller installation window.
  const abortKey = chatAbortKey(
    run.group_folder,
    run.conversation_id,
    `${run.group_folder}@web`,
  );
  if (chatRunAbortControllers.has(abortKey)) {
    stopLeaseHeartbeat();
    await releaseConversationExecutionLease(run.conversation_id, runId);
    await retryClaim(run, 'a conversation turn is still running');
    return false;
  }
  const dispatchController = new AbortController();
  chatRunAbortControllers.set(abortKey, dispatchController);
  // A pending board restart waits for this turn from here on: once dispatched,
  // recovery terminalises it instead of replaying it.
  const releaseDirectChatCount = beginBackgroundWork(DIRECT_CHAT_WORK_LABEL);
  try {
    // Materialize a deferred message before the irreversible dispatch
    // boundary: recovery resumes a `claimed` run but never replays a
    // `dispatched` one, so the message must already be visible by then.
    if (!reconstructed.consumed) {
      const consumption = await consumeQueuedChatMessageExactlyOnce(
        reconstructed.claim.message,
        { consumer: 'direct-followup', runId },
      );
      if (consumption.message) {
        reconstructed.claim.message = consumption.message;
        broadcast({
          type: 'chat_message',
          payload: {
            folder: run.group_folder,
            message: consumption.message,
          },
        });
      }
    }
    if (!(await beginDirectFollowupDispatch(runId, run.conversation_id))) {
      // Not claimable now (e.g. another follow-up of this conversation is
      // dispatched); the row stays claimed, so retry within the same bound.
      await retryClaim(run, 'another follow-up is still running');
      return false;
    }
    if (dispatchController.signal.aborted) {
      await terminalizeDirectFollowupFailure(
        reconstructed.claim,
        '⚠️ Run stopped by user.',
        false,
      );
      return true;
    }
    try {
      await runDirectConversationTurn(
        reconstructed.claim,
        dispatchController.signal,
      );
    } catch (err) {
      logger.error({ err, runId }, 'Direct follow-up preparation failed');
      await terminalizeDirectFollowupFailure(
        reconstructed.claim,
        `⚠️ The queued message could not be processed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Like the HTTP chat route: a deferred objective turn refreshes the
    // objective cost and run statistics once it settles, failure included.
    if (reconstructed.claim.metadata.objectiveId)
      await aggregateRunStats(
        getObjectiveDir(
          run.group_folder,
          reconstructed.claim.metadata.objectiveId,
        ),
        run.group_folder,
        reconstructed.claim.metadata.objectiveId,
      ).catch((err) =>
        logger.error(
          { err: String(err), runId },
          'Failed to update objective run stats after direct follow-up',
        ),
      );
    return true;
  } finally {
    releaseDirectChatCount();
    if (chatRunAbortControllers.get(abortKey) === dispatchController) {
      chatRunAbortControllers.delete(abortKey);
    }
    stopLeaseHeartbeat();
    await releaseConversationExecutionLease(run.conversation_id, runId);
  }
}

/** Boot recovery: resume only claimed rows; dispatched rows are ambiguous and never replayed. */
export async function recoverDirectFollowups(): Promise<void> {
  const rows = await getRunningDirectFollowupRuns();
  for (const run of rows) {
    const conversationId = run.conversation_id;
    const reconstructed = conversationId
      ? reconstructClaim(run.group_folder, conversationId, undefined, run.id)
      : undefined;
    const answered =
      !!reconstructed &&
      (reconstructed.finished ||
        (reconstructed.steered && run.stage === 'direct-followup:claimed'));
    const decision = !conversationId
      ? 'close-error-no-conversation'
      : answered
        ? run.stage === 'direct-followup:stopping'
          ? 'close-error-stopped'
          : 'close-completed-already-answered'
        : run.stage === 'direct-followup:claimed'
          ? 'dispatch'
          : run.stage === 'direct-followup:stopping' && reconstructed
            ? 'terminalize-stopped'
            : reconstructed
              ? 'terminalize-interrupted'
              : 'close-error-message-missing';
    logger.info(
      { runId: run.id, stage: run.stage, conversationId, decision },
      'Recovering direct follow-up run',
    );
    if (!conversationId || !reconstructed) {
      await completeActiveRun(run.id, 'error');
    } else if (answered) {
      await completeActiveRun(
        run.id,
        run.stage === 'direct-followup:stopping' ? 'error' : 'completed',
      );
    } else if (run.stage === 'direct-followup:claimed') {
      scheduleClaimedDirectFollowup(run.id);
    } else if (run.stage === 'direct-followup:stopping') {
      await terminalizeStoppedDirectFollowup(
        reconstructed.claim,
        reconstructed.consumed,
      );
    } else {
      await terminalizeDirectFollowupFailure(
        reconstructed.claim,
        '⚠️ The queued message was interrupted after provider dispatch and was not replayed to avoid a duplicate response.',
      );
    }
  }

  for (const group of Object.values(registeredGroups)) {
    for (const conversation of await getConversationsForHistoryReflection(
      group.folder,
    )) {
      // Released follow-ups are recent, actionable state and therefore live.
      // Using the restoring reader here rehydrates every archived conversation
      // at boot merely to prove it has no pending release marker. With a large
      // history that launches thousands of tar processes before startup can
      // finish and starves the HTTP server. Archived conversations cannot
      // contain actionable follow-ups, so leave them archived during recovery.
      const entries = await readLiveChatTranscriptAsync(
        group.folder,
        conversation.id,
      );
      const pendingIds = new Set<string>();
      const releasedIds = new Set<string>();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Record<string, unknown>;
        if (typeof value.messageId !== 'string') continue;
        if (value.type === 'direct_user_pending')
          pendingIds.add(value.messageId);
        else if (value.type === 'queued_user_released')
          releasedIds.add(value.messageId);
      }
      // Immediate public/form/WhatsApp admission first persists the complete
      // pending receipt. If the process exits before its release marker, no
      // prior provider dispatch exists and boot may safely finish admission.
      // Use the normal handoff so release and server claim remain one
      // transition with respect to browser withdrawal.
      if ([...pendingIds].some((messageId) => !releasedIds.has(messageId))) {
        const handoff = await releaseAndClaimDirectFollowups(
          group.folder,
          conversation.id,
        );
        for (const claim of handoff.claimed) {
          scheduleClaimedDirectFollowup(claim.runId);
        }
      }
      for (const messageId of releasedIds) {
        const result = await claimReleasedDirectFollowup(
          group.folder,
          conversation.id,
          messageId,
        );
        if (result) scheduleClaimedDirectFollowup(result.claim.runId);
      }
    }
  }
}
