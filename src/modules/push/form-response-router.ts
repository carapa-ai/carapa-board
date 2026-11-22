import { randomUUID } from 'crypto';
import { logger } from '../../logger.js';
import { isRecord } from '../../lib/type-guards.js';
import type { NotificationPayloadRow } from '../../db.js';
import { getUserById } from '../../db.js';
import {
  saveChatMessage,
  getConversation,
  updateConversation,
  clearStuckRestartMarker,
} from '../chat/db-chats.js';
import { STUCK_RESTART_MARKER } from '../../recovery.js';
import { getTask } from '../kanban/db-kanban.js';
import { getObjective } from '../objectives/db-objectives.js';
import { appendTaskMessageDurableAsync } from '../transcripts/transcript-store.js';
import { broadcast } from '../objectives/ws-events.js';
import { presentAccountIdentity } from '../account/profile.js';
import { getGroupByFolder } from '../../state-manager.js';
import { runChatAgent } from '../../agent-runner.js';
import { sharedDeps } from '../../mcp/mcp-deps.js';
import {
  chatAbortKey,
  chatRunAbortControllers,
  tryClaimChatRunAbortController,
} from '../../sandbox/process.js';
import {
  acquireConversationExecutionLease,
  getConversationExecutionLease,
  releaseConversationExecutionLease,
  startConversationExecutionLeaseHeartbeat,
} from '../chat/conversation-execution-lease.js';
import {
  LiveMarkerParser,
  stripLiveMarkers,
  upsertLiveActivity,
} from '../chat/live-activity.js';
import { notifyEntityLifecycle } from '../tools/push-tools.js';
import { getResolvedRuntimeConfig } from '../../lib/resolve-agent-config.js';
import { enqueuePersistedDirectFollowup } from '../chat/direct-followups.js';
import { chatEventScope } from '../chat/conversation-scope.js';
import type { ChatMessage } from '../chat/types.js';
import { resolveMainPersonaSession } from '../ai-users/orchestrator.js';
import type { TriggerSource } from '../kanban/types.js';
import { aggregateRunStats } from '../objectives/objective-run-stats.js';
import { getObjectiveDir } from '../objectives/objective-folder.js';

const SENDER_NAME = 'Form response';
const MESSAGE_SOURCE = 'form';

export function formResponseRunAttribution(respondingUserId: string) {
  return {
    senderUserId: respondingUserId,
    triggeredByUserId: respondingUserId,
    triggerSource: 'user' as const,
  };
}

export function classifyFormResponseLifecycle(
  result: { failed?: boolean; pending?: boolean },
  hasContent: boolean,
) {
  return result.failed
    ? ('failed' as const)
    : result.pending
      ? ('needs_input' as const)
      : hasContent
        ? ('completed' as const)
        : ('failed' as const);
}

/**
 * Format submitted form values as a markdown user-message body.
 *
 * For json_form: parse the JSON Schema stored as the payload content and walk
 * its `properties` object in declaration order. Each property is labelled with
 * its `title` (when a non-empty string) or its property name. Unknown keys
 * (extras the user somehow supplied) are appended at the end with their raw key.
 *
 * For html_form: no label info, so use the raw field name keys.
 */
export function formatFormResponseAsMarkdown(
  payload: Pick<NotificationPayloadRow, 'kind' | 'content'>,
  values: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const used = new Set<string>();

  if (payload.kind === 'json_form') {
    let spec: { properties?: Record<string, unknown> } | null = null;
    try {
      spec = JSON.parse(payload.content);
    } catch {
      spec = null;
    }
    const properties = spec?.properties;
    if (isRecord(properties)) {
      for (const [name, raw] of Object.entries(properties)) {
        if (!isRecord(raw)) continue;
        const title = raw.title;
        const label = typeof title === 'string' && title ? title : name;
        lines.push(`**${label}**: ${formatValue(values[name])}`);
        used.add(name);
      }
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (used.has(key)) continue;
    lines.push(`**${key}**: ${formatValue(value)}`);
  }

  return lines.length > 0 ? lines.join('\n') : '*(empty form response)*';
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '_(empty)_';
  if (typeof v === 'string') return v.length > 0 ? v : '_(empty)_';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Persist a form response as a user-message in the configured chat / task /
 * objective. Best-effort: if the referenced context no longer exists, log and
 * return. The blocking caller (if any) still gets the values via the pending
 * registry; the conversation log is just a record.
 */
export async function routeFormResponse(
  payload: NotificationPayloadRow,
  values: Record<string, unknown>,
  options: { awaiterConsumed?: boolean } = {},
): Promise<void> {
  if (!payload.respond_to_kind || !payload.respond_to_id) return;

  const body = formatFormResponseAsMarkdown(payload, values);
  const responder = await getUserById(payload.user_id).catch(() => undefined);
  const responderIdentity = responder
    ? await presentAccountIdentity(responder)
    : null;
  const now = new Date().toISOString();

  try {
    if (payload.respond_to_kind === 'task') {
      const task = await getTask(payload.respond_to_id);
      if (!task) {
        logger.warn(
          { payload_id: payload.id, task_id: payload.respond_to_id },
          '[form-response-router] task not found; dropping routed message',
        );
        return;
      }
      const message = await appendTaskMessageDurableAsync(task.project_id, {
        task_id: task.id,
        role: 'user',
        content: body,
        created_at: now,
      } as any);
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message,
        },
      });
      return;
    }

    if (payload.respond_to_kind === 'chat') {
      const conv = await getConversation(payload.respond_to_id);
      if (!conv) {
        logger.warn(
          { payload_id: payload.id, conversation_id: payload.respond_to_id },
          '[form-response-router] conversation not found; dropping routed message',
        );
        return;
      }
      // If a previous boot marked this conversation as restart-interrupted, the
      // form arriving proves the agent was actually waiting for input — wipe
      // the misleading marker before appending the response.
      await clearStuckRestartMarker(conv.id, STUCK_RESTART_MARKER).catch(
        () => 0,
      );
      const userMsg = await saveChatMessage({
        id: payload.id,
        group_folder: conv.group_folder,
        role: 'user',
        content: body,
        sender_name: responderIdentity?.name ?? SENDER_NAME,
        senderUserId: payload.user_id,
        senderAvatarUrl: responderIdentity?.avatarUrl ?? null,
        created_at: now,
        source: MESSAGE_SOURCE,
        conversation_id: conv.id,
      } as any);
      await updateConversation(conv.id, conv.group_folder, {
        lastTriggeredByUserId: payload.user_id,
        lastTriggerSource: 'user',
        lastTriggeredAt: now,
      });
      broadcast({
        type: 'chat_message',
        payload: {
          ...chatEventScope(conv.group_folder, conv.objective_id),
          message: userMsg,
        },
      });
      // The form-response is semantically a new user message in the chat —
      // trigger the agent so it can react (and so the conversation status
      // doesn't stay stuck on "working" because lastUserAt > lastAssistantAt).
      if (!options.awaiterConsumed)
        await startConversationTurnForMessage({
          group_folder: conv.group_folder,
          conversation_id: conv.id,
          prompt: body,
          userMessage: userMsg,
          leaseOwnerId: `form:${payload.id}`,
          fallbackRunId: payload.id,
          attribution: formResponseRunAttribution(payload.user_id),
        }).catch((err) =>
          logger.error(
            { payload_id: payload.id, err },
            '[form-response-router] failed to admit chat agent run',
          ),
        );
      return;
    }

    if (payload.respond_to_kind === 'objective') {
      if (!payload.respond_to_objective_id) {
        logger.warn(
          { payload_id: payload.id },
          "[form-response-router] respond_to.kind='objective' missing objective_id; dropping",
        );
        return;
      }
      const objective = await getObjective(payload.respond_to_objective_id);
      if (!objective) {
        logger.warn(
          {
            payload_id: payload.id,
            objective_id: payload.respond_to_objective_id,
          },
          '[form-response-router] objective not found; dropping routed message',
        );
        return;
      }
      const conv = await getConversation(payload.respond_to_id);
      if (!conv) {
        logger.warn(
          {
            payload_id: payload.id,
            objective_id: payload.respond_to_objective_id,
            conversation_id: payload.respond_to_id,
          },
          '[form-response-router] objective conversation not found; dropping routed message',
        );
        return;
      }
      // Same self-heal as the chat branch: a deferred form answer means the
      // agent wasn't actually crashed at boot; remove the false marker.
      await clearStuckRestartMarker(conv.id, STUCK_RESTART_MARKER).catch(
        () => 0,
      );
      const userMsg = await saveChatMessage({
        id: payload.id,
        group_folder: conv.group_folder,
        role: 'user',
        content: body,
        sender_name: responderIdentity?.name ?? SENDER_NAME,
        senderUserId: payload.user_id,
        senderAvatarUrl: responderIdentity?.avatarUrl ?? null,
        created_at: now,
        source: MESSAGE_SOURCE,
        conversation_id: conv.id,
        objective_id: objective.id,
      } as any);
      await updateConversation(conv.id, conv.group_folder, {
        lastTriggeredByUserId: payload.user_id,
        lastTriggerSource: 'user',
        lastTriggeredAt: now,
      });
      broadcast({
        type: 'chat_message',
        payload: {
          ...chatEventScope(conv.group_folder, objective.id),
          message: userMsg,
        },
      });
      // Same as the chat case — the form-response is a new user message in
      // the objective conversation; trigger the agent so the conversation
      // doesn't get stuck on "working".
      if (!options.awaiterConsumed)
        await startConversationTurnForMessage({
          group_folder: conv.group_folder,
          conversation_id: conv.id,
          prompt: body,
          userMessage: userMsg,
          leaseOwnerId: `form:${payload.id}`,
          fallbackRunId: payload.id,
          attribution: formResponseRunAttribution(payload.user_id),
        }).catch((err) =>
          logger.error(
            { payload_id: payload.id, err },
            '[form-response-router] failed to admit objective agent run',
          ),
        );
      return;
    }

    logger.warn(
      { payload_id: payload.id, kind: payload.respond_to_kind },
      '[form-response-router] unknown respond_to.kind; dropping',
    );
  } catch (err) {
    logger.error(
      { payload_id: payload.id, err: String(err) },
      '[form-response-router] failed to route form response',
    );
  }
}

export interface ConversationTurnAttribution {
  senderUserId: string | null;
  triggeredByUserId: string | null;
  triggerSource: TriggerSource;
}

export interface StartConversationTurnInput {
  group_folder: string;
  conversation_id: string;
  prompt: string;
  userMessage: ChatMessage;
  /**
   * `userMessage` is not saved yet. It is saved and broadcast when the turn is
   * admitted, or when the queued turn is claimed, so it sorts after the turn
   * that was running when it arrived.
   */
  deferUserMessage?: boolean;
  leaseOwnerId: string;
  /** Refuse a busy conversation instead of queuing the message. */
  refuseIfBusy?: boolean;
  /** Ask whose own turn is being started, for lifecycle settlement. */
  agentAskId?: string;
  /** Run id for lifecycle notifications when the run reports none. Defaults to `leaseOwnerId`. */
  fallbackRunId?: string;
  attribution: ConversationTurnAttribution;
  /** Restricts the lifecycle push; an empty list sends none. Omit for the default recipients. */
  lifecycleRecipientUserIds?: readonly string[];
}

/** A chat run is in flight, or the conversation's execution lease is held. */
export async function isConversationBusy(
  group_folder: string,
  conversation_id: string,
): Promise<boolean> {
  return (
    chatRunAbortControllers.has(
      chatAbortKey(group_folder, conversation_id, `${group_folder}@web`),
    ) || (await getConversationExecutionLease(conversation_id)) !== null
  );
}

/**
 * Start a chat agent turn on a conversation whose triggering message has
 * already been saved, without an HTTP request. Mirrors the minimum that
 * `POST /api/projects/:pid/messages` does to start a chat run — minus the
 * initial saveChatMessage and the auto-compaction logic. Resolves once the run
 * is admitted (`started`) or durably queued behind a busy conversation
 * (`queued`); the run itself is fire-and-forget. Run errors are logged and a
 * chat_completed event is always broadcast so the UI doesn't get stuck.
 */
export async function startConversationTurnForMessage(
  input: StartConversationTurnInput,
): Promise<'started' | 'queued'> {
  const {
    group_folder,
    conversation_id,
    prompt,
    userMessage,
    deferUserMessage,
    leaseOwnerId,
    attribution,
    lifecycleRecipientUserIds,
  } = input;
  const runId = input.fallbackRunId ?? leaseOwnerId;
  const group = getGroupByFolder(group_folder);
  if (!group) {
    throw new Error(
      `Group ${group_folder} not found; cannot start conversation turn`,
    );
  }

  const chat_jid = `${group_folder}@web`;
  const conversation = await getConversation(conversation_id);
  const { mainAiUserContext, mainPersonaGeneration } =
    await resolveMainPersonaSession(conversation_id, group);
  const formRuntimeConfig =
    getResolvedRuntimeConfig(
      group,
      conversation?.runtimeSelection,
      conversation?.last_agent_cmd,
    ) ?? getResolvedRuntimeConfig(group, conversation?.runtimeSelection);
  if (!formRuntimeConfig) {
    throw new Error('No runtime binding is configured for the conversation');
  }
  const formRuntimeSelection =
    conversation?.runtimeSelection ??
    (formRuntimeConfig.harnessId && formRuntimeConfig.modelId
      ? {
          harnessId: formRuntimeConfig.harnessId,
          modelId: formRuntimeConfig.modelId,
          ...(formRuntimeConfig.reasoningDefault
            ? { reasoning: formRuntimeConfig.reasoningDefault }
            : {}),
        }
      : undefined);
  const enqueue = () =>
    input.refuseIfBusy
      ? Promise.resolve()
      : enqueuePersistedDirectFollowup({
          message: userMessage,
          deferMessage: deferUserMessage,
          metadata: {
            conversationId: conversation_id,
            ...(conversation?.objective_id
              ? { objectiveId: conversation.objective_id }
              : {}),
            executionContent: prompt,
            // Keep the executable catalog binding separate from the native-session
            // family so persona removal before dequeue cannot make this unresolvable.
            agentCmd: formRuntimeConfig.id,
            runtimeSelection: formRuntimeSelection,
            senderUserId: attribution.senderUserId,
            ...(lifecycleRecipientUserIds
              ? { lifecycleRecipientUserIds: [...lifecycleRecipientUserIds] }
              : {}),
            triggeredByUserId: attribution.triggeredByUserId,
            triggerSource: attribution.triggerSource,
          },
        });
  const abortKey = chatAbortKey(group_folder, conversation_id, chat_jid);
  if (chatRunAbortControllers.has(abortKey)) {
    // An agent run is already in flight for this conversation (typical when
    // the agent that fired notify_user used wait=true and is still mid-turn).
    // Don't start a parallel run — the running agent has already received the
    // form values directly via the awaiter.
    await enqueue();
    logger.info(
      { run_id: runId, group_folder, conversation_id },
      input.refuseIfBusy
        ? '[form-response-router] chat agent already running; refused trigger'
        : '[form-response-router] chat agent already running; queued durable trigger',
    );
    return 'queued';
  }

  const executionLease = await acquireConversationExecutionLease(
    conversation_id,
    leaseOwnerId,
  );
  if (!executionLease) {
    await enqueue();
    logger.info(
      { run_id: runId, group_folder, conversation_id },
      input.refuseIfBusy
        ? '[form-response-router] conversation execution lease is busy; refused trigger'
        : '[form-response-router] conversation execution lease is busy; queued durable trigger',
    );
    return 'queued';
  }
  const stopLeaseHeartbeat = startConversationExecutionLeaseHeartbeat(
    conversation_id,
    leaseOwnerId,
  );
  const reservation = new AbortController();
  if (!tryClaimChatRunAbortController(abortKey, reservation)) {
    stopLeaseHeartbeat();
    await releaseConversationExecutionLease(conversation_id, leaseOwnerId);
    await enqueue();
    logger.info(
      { run_id: runId, group_folder, conversation_id },
      input.refuseIfBusy
        ? '[form-response-router] chat agent claimed during admission; refused trigger'
        : '[form-response-router] chat agent claimed during durable admission; queued durable trigger',
    );
    return 'queued';
  }

  if (deferUserMessage) {
    try {
      // The draft was stamped before the busy check; the answer takes its
      // position now, after anything that finished in between.
      const message = await saveChatMessage({
        ...userMessage,
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'chat_message',
        payload: {
          ...chatEventScope(group_folder, conversation?.objective_id),
          message,
        },
      });
    } catch (err) {
      chatRunAbortControllers.delete(abortKey);
      stopLeaseHeartbeat();
      await releaseConversationExecutionLease(conversation_id, leaseOwnerId);
      throw err;
    }
  }

  const streamKey = randomUUID();
  broadcast({
    type: 'chat_started',
    payload: {
      ...chatEventScope(group_folder, conversation?.objective_id),
      conversation_id,
      streamKey,
    },
  });
  const liveMarkers = new LiveMarkerParser();
  const publishLiveStatuses = (statuses: string[]) => {
    for (const status of statuses) {
      const activity = upsertLiveActivity({
        folder: group_folder,
        conversation_id,
        state: 'working',
        status,
      });
      broadcast({ type: 'live_activity', payload: activity });
    }
  };
  let markerTailFlushed = false;
  const flushMarkerTail = () => {
    if (markerTailFlushed) return;
    markerTailFlushed = true;
    const markerTail = liveMarkers.finish();
    publishLiveStatuses(markerTail.statuses);
    if (markerTail.visible)
      broadcast({
        type: 'chat_output',
        payload: {
          ...chatEventScope(group_folder, conversation?.objective_id),
          content: markerTail.visible,
          conversation_id,
          streamKey,
        },
      });
  };
  runChatAgent(
    group,
    prompt,
    chat_jid,
    (chunk) => {
      if (chunk.type === 'text') {
        const parsed = liveMarkers.push(chunk.content);
        publishLiveStatuses(parsed.statuses);
        if (parsed.visible)
          broadcast({
            type: 'chat_output',
            payload: {
              ...chatEventScope(group_folder, conversation?.objective_id),
              content: parsed.visible,
              conversation_id,
              streamKey,
            },
          });
      }
    },
    undefined,
    false,
    conversation_id,
    undefined,
    {
      skipInitialLog: true,
      agentAskId: input.agentAskId,
      ...(mainAiUserContext
        ? {
            agentConfig: mainAiUserContext.agentConfig,
            agent_cmd: mainAiUserContext.agentConfig.id,
            model: mainAiUserContext.agentConfig.model,
            reasoning_effort: mainAiUserContext.agentConfig.reasoning_effort,
            systemPromptSuffix: mainAiUserContext.systemPromptSuffix,
          }
        : {}),
      mainPersonaGeneration,
      ...attribution,
    },
    sharedDeps,
  )
    .then(async (runResult) => {
      flushMarkerTail();
      const cleanResult = runResult.result
        ? stripLiveMarkers(runResult.result)
        : null;
      publishLiveStatuses(cleanResult?.statuses ?? []);
      if (cleanResult?.content) {
        const assistantMsg = await saveChatMessage({
          id: runResult.uuid,
          group_folder,
          role: 'assistant',
          content: cleanResult.content,
          sender_name: null,
          source: 'web',
          created_at: new Date().toISOString(),
          conversation_id,
          telemetry: runResult.telemetry,
          skipTranscript: true,
        } as any);
        broadcast({
          type: 'chat_message',
          payload: {
            ...chatEventScope(group_folder, conversation?.objective_id),
            message: assistantMsg,
          },
        });
      }
      broadcast({
        type: 'chat_completed',
        payload: {
          ...chatEventScope(group_folder, conversation?.objective_id),
          conversation_id,
          streamKey,
          telemetry: runResult.telemetry,
          liveState: cleanResult?.content ? undefined : 'failed',
        },
      });
      const event = classifyFormResponseLifecycle(
        runResult,
        Boolean(cleanResult?.content),
      );
      await notifyEntityLifecycle({
        group_folder,
        conversation_id,
        run_id: runResult.activeRunId ?? runId,
        agent_ask_id: input.agentAskId,
        agent_ask_answer: cleanResult?.content ?? '',
        event,
        title:
          event === 'failed'
            ? 'Conversation failed'
            : event === 'needs_input'
              ? 'Conversation needs input'
              : 'Conversation completed',
        recipient_user_ids: lifecycleRecipientUserIds,
      });
    })
    .catch(async (err) => {
      flushMarkerTail();
      logger.error(
        { run_id: runId, group_folder, conversation_id, err: String(err) },
        '[form-response-router] chat agent run failed',
      );
      broadcast({
        type: 'chat_completed',
        payload: {
          ...chatEventScope(group_folder, conversation?.objective_id),
          conversation_id,
          streamKey,
          liveState: 'failed',
        },
      });
      await notifyEntityLifecycle({
        group_folder,
        conversation_id,
        run_id: runId,
        agent_ask_id: input.agentAskId,
        agent_ask_answer: '',
        event: 'failed',
        title: 'Conversation failed',
        recipient_user_ids: lifecycleRecipientUserIds,
      });
    })
    .finally(async () => {
      if (chatRunAbortControllers.get(abortKey) === reservation)
        chatRunAbortControllers.delete(abortKey);
      stopLeaseHeartbeat();
      await releaseConversationExecutionLease(conversation_id, leaseOwnerId);
      // Like the HTTP chat route: refresh objective cost and run statistics.
      if (conversation?.objective_id)
        await aggregateRunStats(
          getObjectiveDir(group_folder, conversation.objective_id),
          group_folder,
          conversation.objective_id,
        ).catch((err) =>
          logger.error(
            {
              group_folder,
              conversation_id,
              objective_id: conversation.objective_id,
              err: String(err),
            },
            '[form-response-router] failed to update objective run stats',
          ),
        );
    });
  return 'started';
}
