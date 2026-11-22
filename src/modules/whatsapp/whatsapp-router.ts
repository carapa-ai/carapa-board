/**
 * WhatsApp message polling, routing, and response handling.
 *
 * Shared outbound delivery lives in messaging/send-message.ts; this module
 * owns WhatsApp ingestion and polling.
 */

import { randomUUID } from 'crypto';

import { getMessagingClient, type RemoteMessage } from './messaging-client.js';
import { enrichMessageContent } from '../../lib/media-processor.js';

import { ASSISTANT_NAME, DATA_DIR, POLL_INTERVAL } from '../../config.js';
import {
  saveChatMessage,
  getMostRecentConversation,
  createConversation,
  updateConversation,
  setConversationSessionId,
  getConversationSessionId,
  getChatMessageById,
} from '../../db.js';
import { sendMessage } from '../messaging/send-message.js';
import { broadcast } from '../objectives/ws-events.js';
import { logger } from '../../logger.js';
import {
  registeredGroups,
  getGroupEntryByFolder,
  lastAgentTimestamp,
  getLastTimestamp,
  setLastTimestamp,
  saveState,
  setLastAgentTimestamp,
  rekeyGroupJid,
  sessions,
} from '../../state-manager.js';
import { runChatAgent } from '../../agent-runner.js';
import { sharedDeps } from '../../mcp/mcp-deps.js';
import {
  getResolvedRuntimeConfig,
  resolvedAgentSupportsNativeAudio,
  resolveSessionAgentKey,
} from '../../lib/resolve-agent-config.js';
import { runtimeSessionKey } from '../../lib/chat-agents.js';
import { escapeRegex } from '../../utils.js';
import {
  LiveMarkerParser,
  stripLiveMarkers,
  upsertLiveActivity,
} from '../chat/live-activity.js';
import {
  effectiveContainerUploadDir,
  effectiveProjectUploadDir,
} from '../../sandbox/effective-settings.js';
import { inviteProjectDefaultAiUsers } from '../ai-users/project-default-invitations.js';
import { resolveMainPersonaSession } from '../ai-users/orchestrator.js';
import { mainPersonaSessionKey } from '../ai-users/session-revision.js';
import { notifyEntityLifecycle } from '../tools/push-tools.js';
import {
  acquireConversationExecutionLease,
  releaseConversationExecutionLease,
  startConversationExecutionLeaseHeartbeat,
} from '../chat/conversation-execution-lease.js';
import { enqueuePersistedDirectFollowup } from '../chat/direct-followups.js';
import type { ChatMessage } from '../chat/types.js';

// Track wa-link message IDs already saved to chat DB to prevent duplicates on retry.
// Capped to defend against unbounded growth if a message ID never reaches a
// terminal state (success or MAX_RETRIES); FIFO eviction since Set preserves
// insertion order.
const SAVED_IDS_LIMIT = 5000;
const savedWaMessageIds = new Set<string>();

function recordSavedWaMessageId(id: string): void {
  if (savedWaMessageIds.has(id)) return;
  savedWaMessageIds.add(id);
  if (savedWaMessageIds.size > SAVED_IDS_LIMIT) {
    const oldest = savedWaMessageIds.values().next().value;
    if (oldest !== undefined) savedWaMessageIds.delete(oldest);
  }
}

// Loop cancellation state. Set by stopMessageLoop() during module shutdown;
// observed by startMessageLoop() at each iteration boundary. wakeup interrupts
// the inter-poll sleep so shutdown completes within milliseconds, not POLL_INTERVAL.
let loopStopped = false;
let loopWakeup: (() => void) | null = null;
let loopPromise: Promise<void> | null = null;

function loopSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (loopStopped) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      loopWakeup = null;
      resolve();
    }, ms);
    loopWakeup = () => {
      clearTimeout(t);
      loopWakeup = null;
      resolve();
    };
  });
}

export async function stopMessageLoop(): Promise<void> {
  loopStopped = true;
  if (loopWakeup) loopWakeup();
  if (loopPromise) await loopPromise;
}

export async function processMessage(
  msg: RemoteMessage,
  testDependencies?: {
    beforeConversationExecutionLease?: () => void | Promise<void>;
  },
): Promise<boolean> {
  const group = registeredGroups[msg.chat_id];
  if (!group) return true; // skip, not a failure

  // Skip messages older than the per-JID cursor (prevents replaying history when a new JID is linked)
  const jidCursor = lastAgentTimestamp[msg.chat_id];
  if (jidCursor && msg.timestamp <= jidCursor) return true;

  // Compute IPC uploads dir so downloaded media files are accessible from the agent container
  const ipcUploadDir = effectiveProjectUploadDir(group, DATA_DIR);

  const activeConv = await getMostRecentConversation(group.folder);
  // Match runChatAgent's v2 precedence so attachment preprocessing and the
  // native session identity use the same selected binding as execution.
  const conversationSelection = activeConv?.runtimeSelection;
  const nativeAudio = resolvedAgentSupportsNativeAudio(
    group,
    undefined,
    conversationSelection,
  );
  const enrichOpts = {
    saveDir: ipcUploadDir,
    containerPrefix: effectiveContainerUploadDir(group),
    browserUrlPrefix: `/uploads/${group.folder}`,
    nativeAudio,
  };

  // Enrich content with any media attachments (voice → Whisper or native audio)
  const enrichedMsg = await enrichMessageContent(msg, enrichOpts);

  // We use forAgent for trigger matching to ensure agent logic is consistent
  const content = enrichedMsg.forAgent.trim();
  const dbContent = enrichedMsg.forDb.trim();

  logger.debug(
    {
      jid: msg.chat_id,
      hasContent: !!content,
      hasDbContent: !!dbContent,
      attachmentCount: msg.attachments?.length || 0,
    },
    'Processing incoming WhatsApp message',
  );

  // Actually wait, msg.content might be empty, but if there's attachments we don't want to skip.
  // The original check `!content` will skip if no text and no agent text.
  if (!content && !dbContent) {
    logger.debug({ jid: msg.chat_id, msgId: msg.id }, 'Skipping empty message');
    return true;
  }

  const isMainGroup = !!group.is_main;

  // Main group responds to all messages; other groups require trigger prefix (per-group)
  const trigger = group.trigger || `@${ASSISTANT_NAME}`;
  const triggerRegex = new RegExp(`^${escapeRegex(trigger)}\\b`, 'i');
  const cleanContent = content.replace(triggerRegex, '').trim();

  // Check for reset/clear command BEFORE saving the message, so the old conversation
  // doesn't get a dangling user message that makes it show "working" status
  if (
    (isMainGroup || triggerRegex.test(content)) &&
    cleanContent.match(/^\/(reset|clear)\s*$/i)
  ) {
    logger.info({ jid: msg.chat_id }, 'Session reset requested');
    delete sessions[group.folder];
    // Set timestamp to NOW so the next getMessagesSince only picks up messages after the reset
    lastAgentTimestamp[msg.chat_id] = new Date().toISOString();
    saveState();
    // Start a fresh conversation so new messages are grouped separately in the UI
    const freshConv = await createConversation(group.folder, {
      ownerUserId: group.user_id ?? null,
      triggerSource: 'system',
    });
    await inviteProjectDefaultAiUsers(freshConv.id, group, null);
    broadcast({
      type: 'conversations_changed',
      payload: { folder: group.folder },
    });
    logger.info(
      { jid: msg.chat_id, conversation_id: freshConv.id },
      'New conversation created after reset',
    );
    await sendMessage(
      msg.chat_id,
      '🔄 Session reset! I have forgotten our previous context. Ready for a fresh start.',
    );
    return true;
  }

  // Non-main groups require trigger prefix; skip untriggered messages
  if (!isMainGroup && !triggerRegex.test(content)) return true;

  logger.debug(
    {
      jid: msg.chat_id,
      contentLength: content.length,
      cleanContentLength: cleanContent.length,
    },
    'Checking message content',
  );

  // A retry may see messages already saved while building an earlier prompt.
  const saveIncoming = async (
    incoming: RemoteMessage,
    enriched: typeof enrichedMsg,
  ): Promise<ChatMessage | undefined> => {
    if (savedWaMessageIds.has(incoming.id)) {
      return activeConv
        ? getChatMessageById(group.folder, activeConv.id, incoming.id)
        : undefined;
    }
    const saved = await saveChatMessage({
      id: incoming.id,
      group_folder: group.folder,
      role: 'user',
      content: enriched.forDb.trim(),
      sender_name: incoming.sender_name,
      source: 'whatsapp',
      created_at: incoming.timestamp,
      conversation_id: activeConv?.id ?? null,
      attachments: enriched.attachments || null,
    });
    recordSavedWaMessageId(incoming.id);
    broadcast({
      type: 'chat_message',
      payload: { folder: group.folder, message: saved },
    });
    return saved;
  };
  const savedIncoming = await saveIncoming(msg, enrichedMsg);

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_id] || '';
  const messagingClient = getMessagingClient();
  const missedMessages = await messagingClient.getMessagesSince(
    msg.chat_id,
    sinceTimestamp,
    ASSISTANT_NAME,
  );
  const promptThroughTimestamp = missedMessages.reduce(
    (latest, missed) => (missed.timestamp > latest ? missed.timestamp : latest),
    msg.timestamp,
  );

  // Escape XML special characters in content
  const escapeXml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // Enrich each message with media attachment descriptions before building prompt
  const lines: string[] = [];
  const allAttachments: import('../chat/types.js').ChatMessageAttachment[] = [];
  let triggerIncluded = false;

  // Seed with current message attachments
  if (enrichedMsg.attachments) {
    allAttachments.push(...enrichedMsg.attachments);
  }

  for (const m of missedMessages) {
    if (m.id === msg.id) {
      triggerIncluded = true;
      lines.push(
        `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">\n${escapeXml(enrichedMsg.forAgent)}\n</message>`,
      );
      continue;
    }

    const enriched = await enrichMessageContent(m, enrichOpts);
    await saveIncoming(m, enriched);
    lines.push(
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">\n${escapeXml(enriched.forAgent)}\n</message>`,
    );
    if (enriched.attachments) {
      for (const att of enriched.attachments) {
        if (!allAttachments.some((a) => a.path === att.path)) {
          allAttachments.push(att);
        }
      }
    }
  }

  // If for some reason the trigger message wasn't in history (timestamp edge case), add it
  if (!triggerIncluded) {
    lines.push(
      `<message sender="${escapeXml(msg.sender_name)}" time="${msg.timestamp}">\n${escapeXml(enrichedMsg.forAgent)}\n</message>`,
    );
  }

  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return true;

  logger.debug(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  const conversation_id = activeConv?.id ?? undefined;
  const personaSession = conversation_id
    ? await resolveMainPersonaSession(conversation_id, group)
    : undefined;
  const mainAiUserContext = personaSession?.mainAiUserContext;
  const mainPersonaGeneration = personaSession?.mainPersonaGeneration;
  // No explicit agent override on inbound WhatsApp. Resolve the structured
  // conversation selection before the project and global chat defaults.
  const waRuntimeConfig = getResolvedRuntimeConfig(
    group,
    conversationSelection,
  );
  const waRuntimeSelection =
    conversationSelection ??
    (waRuntimeConfig?.harnessId && waRuntimeConfig.modelId
      ? {
          harnessId: waRuntimeConfig.harnessId,
          modelId: waRuntimeConfig.modelId,
          ...(waRuntimeConfig.reasoningDefault
            ? { reasoning: waRuntimeConfig.reasoningDefault }
            : {}),
        }
      : undefined);
  const waRuntimeBinding =
    waRuntimeConfig?.id ??
    resolveSessionAgentKey(group, undefined, conversationSelection);
  const waSessionRuntimeKey = mainAiUserContext
    ? runtimeSessionKey(mainAiUserContext.agentConfig)
    : waRuntimeConfig
      ? runtimeSessionKey(waRuntimeConfig)
      : waRuntimeBinding;
  const waSessionKey = mainPersonaGeneration
    ? mainPersonaSessionKey(waSessionRuntimeKey, mainPersonaGeneration)
    : waSessionRuntimeKey;
  const streamKey = randomUUID();
  const leaseOwnerId = `whatsapp:${streamKey}`;
  await testDependencies?.beforeConversationExecutionLease?.();
  const executionLease = conversation_id
    ? await acquireConversationExecutionLease(conversation_id, leaseOwnerId)
    : null;
  if (conversation_id && !executionLease) {
    if (!savedIncoming) {
      throw new Error('Persisted WhatsApp message is unavailable for retry');
    }
    await enqueuePersistedDirectFollowup({
      message: savedIncoming,
      metadata: {
        conversationId: conversation_id,
        executionContent: prompt,
        // The executable binding must remain resolvable if the main persona is
        // removed before dequeue. Its generation-scoped native session key is
        // intentionally stored only in conversation_agent_sessions.
        agentCmd: waRuntimeBinding,
        runtimeSelection: waRuntimeSelection,
        triggeredByUserId: null,
        triggerSource: 'system',
        delivery: {
          kind: 'whatsapp',
          chatJid: msg.chat_id,
          triggerTimestamp: promptThroughTimestamp,
        },
      },
    });
    if (
      !lastAgentTimestamp[msg.chat_id] ||
      lastAgentTimestamp[msg.chat_id] < promptThroughTimestamp
    ) {
      lastAgentTimestamp[msg.chat_id] = promptThroughTimestamp;
      saveState();
    }
    logger.info(
      { conversation_id, message_id: msg.id },
      'Conversation is busy; queued durable WhatsApp turn',
    );
    return true;
  }
  // Worktree removal and native-session invalidation use the same admission
  // boundary as this lease. Read only after ownership is acquired so a turn
  // cannot resume a session captured before a successful removal.
  let sessionOverride:
    | Awaited<ReturnType<typeof getConversationSessionId>>
    | undefined;
  let stopLeaseHeartbeat: (() => void) | undefined;
  try {
    sessionOverride = conversation_id
      ? await getConversationSessionId(conversation_id, waSessionKey)
      : undefined;
    stopLeaseHeartbeat = executionLease
      ? startConversationExecutionLeaseHeartbeat(conversation_id!, leaseOwnerId)
      : undefined;
  } catch (err) {
    if (executionLease)
      await releaseConversationExecutionLease(conversation_id!, leaseOwnerId);
    throw err;
  }
  if (conversation_id) {
    broadcast({
      type: 'chat_started',
      payload: { folder: group.folder, conversation_id, streamKey },
    });
  }
  const liveMarkers = new LiveMarkerParser();
  const publishLiveStatuses = (statuses: string[]) => {
    if (!conversation_id) return;
    for (const status of statuses) {
      const activity = upsertLiveActivity({
        folder: group.folder,
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
    if (markerTail.visible && conversation_id)
      broadcast({
        type: 'chat_output',
        payload: {
          folder: group.folder,
          content: markerTail.visible,
          conversation_id,
          streamKey,
        },
      });
  };
  try {
    await messagingClient.setTyping(msg.chat_id, true);
    if (conversation_id) {
      await updateConversation(conversation_id, group.folder, {
        lastTriggeredByUserId: null,
        lastTriggerSource: 'system',
        lastTriggeredAt: new Date().toISOString(),
      });
    }
    const runResult = await runChatAgent(
      group,
      prompt,
      msg.chat_id,
      (chunk) => {
        if (chunk.type === 'text' && conversation_id) {
          const parsed = liveMarkers.push(chunk.content);
          publishLiveStatuses(parsed.statuses);
          if (parsed.visible)
            broadcast({
              type: 'chat_output',
              payload: {
                folder: group.folder,
                content: parsed.visible,
                conversation_id,
                streamKey,
              },
            });
        } else if (chunk.type === 'session' && conversation_id) {
          if (!sessionOverride) {
            setConversationSessionId(
              conversation_id,
              waSessionKey,
              chunk.session_id,
            );
          }
          broadcast({
            type: 'conversations_changed',
            payload: { folder: group.folder },
          });
        }
      },
      sessionOverride ?? undefined,
      false,
      conversation_id,
      undefined,
      {
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
        attachments: allAttachments.length > 0 ? allAttachments : undefined,
        // WhatsApp senders are not mapped to Board users. Keep the project
        // owner as the conversation owner/notification fallback, but record
        // the causal trigger as system rather than impersonating that owner.
        senderUserId: null,
        triggeredByUserId: null,
        triggerSource: 'system',
      },
      sharedDeps,
    );
    flushMarkerTail();
    const finalMarkerData = runResult.result
      ? stripLiveMarkers(runResult.result)
      : null;
    publishLiveStatuses(finalMarkerData?.statuses ?? []);
    const response = finalMarkerData?.content ?? runResult.result;
    await messagingClient.setTyping(msg.chat_id, false);

    if (conversation_id) {
      broadcast({
        type: 'chat_completed',
        payload: {
          folder: group.folder,
          conversation_id,
          streamKey,
          liveState: response ? undefined : 'failed',
        },
      });
    }

    if (response) {
      lastAgentTimestamp[msg.chat_id] = promptThroughTimestamp;
      await sendMessage(msg.chat_id, `${ASSISTANT_NAME}: ${response}`);

      // Save agent response to chat feed
      const savedReply = await saveChatMessage({
        group_folder: group.folder,
        role: 'assistant',
        content: response,
        sender_name: null,
        source: 'whatsapp',
        created_at: new Date().toISOString(),
        conversation_id: conversation_id ?? null,
        skipTranscript: true,
      });
      broadcast({
        type: 'chat_message',
        payload: { folder: group.folder, message: savedReply },
      });

      if (conversation_id) {
        const lifecycleEvent = runResult.failed
          ? 'failed'
          : runResult.pending
            ? 'needs_input'
            : 'completed';
        await notifyEntityLifecycle({
          group_folder: group.folder,
          conversation_id,
          run_id: runResult.activeRunId ?? streamKey,
          event: lifecycleEvent,
          title:
            lifecycleEvent === 'failed'
              ? 'Conversation failed'
              : lifecycleEvent === 'needs_input'
                ? 'Conversation needs input'
                : 'Conversation completed',
        });
      }

      return true;
    } else {
      if (conversation_id) {
        await notifyEntityLifecycle({
          group_folder: group.folder,
          conversation_id,
          run_id: runResult.activeRunId ?? streamKey,
          event: 'failed',
          title: 'Conversation failed',
        });
      }
      return false;
    }
  } catch (err) {
    flushMarkerTail();
    if (conversation_id) {
      broadcast({
        type: 'chat_completed',
        payload: {
          folder: group.folder,
          conversation_id,
          streamKey,
          liveState: 'failed',
        },
      });
      await notifyEntityLifecycle({
        group_folder: group.folder,
        conversation_id,
        run_id: streamKey,
        event: 'failed',
        title: 'Conversation failed',
      });
    }
    throw err;
  } finally {
    stopLeaseHeartbeat?.();
    if (executionLease)
      await releaseConversationExecutionLease(conversation_id!, leaseOwnerId);
  }
}

export async function startMessageLoop(): Promise<void> {
  if (loopPromise) return loopPromise;
  loopStopped = false;
  loopPromise = runMessageLoop().finally(() => {
    loopPromise = null;
  });
  return loopPromise;
}

async function runMessageLoop(): Promise<void> {
  logger.info({ assistantName: ASSISTANT_NAME }, 'CarapaBoard running');

  // On fresh start (no saved timestamp), skip all existing messages — only process future ones
  let lastTimestamp = getLastTimestamp();
  if (!lastTimestamp) {
    lastTimestamp = new Date().toISOString();
    setLastTimestamp(lastTimestamp);
    saveState();
    logger.info(
      'Fresh start — message cursor set to now, skipping old messages',
    );
  }

  const RETRY_LIMIT = 5000;
  const retryCount = new Map<string, number>();
  const recordRetry = (id: string, n: number): void => {
    retryCount.set(id, n);
    if (retryCount.size > RETRY_LIMIT) {
      const oldest = retryCount.keys().next().value;
      if (oldest !== undefined) retryCount.delete(oldest);
    }
  };
  const MAX_RETRIES = 3;
  let lastAutoLinkCheck = 0;
  let missingAutoLinkMainLogged = false;
  const AUTO_LINK_INTERVAL_MS = 60_000; // check auto-link at most once per minute

  while (!loopStopped) {
    try {
      const messagingClient = getMessagingClient();

      // Auto-link main group to the connected phone's self-chat (throttled)
      const now = Date.now();
      if (now - lastAutoLinkCheck >= AUTO_LINK_INTERVAL_MS) {
        lastAutoLinkCheck = now;
        try {
          const waStatus = await messagingClient.getStatus();
          if (waStatus.status === 'connected' && waStatus.jid) {
            // The shared WhatsApp service does not identify a Board user. An
            // explicit folder is therefore required rather than guessing an owner.
            const folder = process.env.WHATSAPP_SELF_CHAT_MAIN?.trim();
            const main = folder ? getGroupEntryByFolder(folder) : undefined;
            if (!main?.group.is_main) {
              if (!missingAutoLinkMainLogged) {
                logger.warn(
                  { folder },
                  'WhatsApp self-chat auto-link has no configured main',
                );
                missingAutoLinkMainLogged = true;
              }
            } else if (
              !main.group.settings?.whatsappSelfChatAutoLinkDisabled &&
              (main.jid === main.group.folder || main.jid === 'local@web') &&
              !registeredGroups[waStatus.jid]
            ) {
              await rekeyGroupJid(main.jid, waStatus.jid);
              setLastAgentTimestamp(waStatus.jid);
              logger.info(
                { oldJid: main.jid, newJid: waStatus.jid },
                'Main group auto-linked to WhatsApp self-chat',
              );
            }
          }
        } catch (err) {
          logger.debug({ err }, 'Auto-link status check failed');
        }
      }

      const jids = Object.keys(registeredGroups);
      lastTimestamp = getLastTimestamp();
      const { messages } = await messagingClient.getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0)
        logger.debug({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          const success = await processMessage(msg);
          if (success) {
            retryCount.delete(msg.id);
            savedWaMessageIds.delete(msg.id);
            setLastTimestamp(msg.timestamp);
            saveState();
          } else {
            // Agent returned no response — retry up to MAX_RETRIES
            const attempts = (retryCount.get(msg.id) || 0) + 1;
            recordRetry(msg.id, attempts);
            if (attempts >= MAX_RETRIES) {
              logger.warn(
                { msg: msg.id, attempts },
                'Message failed after max retries, skipping',
              );
              retryCount.delete(msg.id);
              savedWaMessageIds.delete(msg.id);
              setLastTimestamp(msg.timestamp);
              saveState();
            } else {
              logger.warn(
                { msg: msg.id, attempts, maxRetries: MAX_RETRIES },
                'Agent produced no response, will retry',
              );
              // Stop batch — retry this message next loop iteration
              break;
            }
          }
        } catch (err) {
          const attempts = (retryCount.get(msg.id) || 0) + 1;
          recordRetry(msg.id, attempts);

          if (attempts >= MAX_RETRIES) {
            logger.error(
              { err, msg: msg.id, attempts },
              'Error processing message, max retries reached. Skipping.',
            );
            retryCount.delete(msg.id);
            savedWaMessageIds.delete(msg.id);
            setLastTimestamp(msg.timestamp);
            saveState();
          } else {
            logger.error(
              { err, msg: msg.id, attempts, maxRetries: MAX_RETRIES },
              'Error processing message, will retry',
            );
            // Stop processing this batch - failed message will be retried next loop
            break;
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await loopSleep(POLL_INTERVAL);
  }
  logger.info('WhatsApp message loop stopped');
}
