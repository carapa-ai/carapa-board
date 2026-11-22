import {
  personaSenderId,
  startsNewPersonaBubble,
} from '@/lib/chat-transcript-speakers';
import { deduplicateCanonicalAssistantEntries } from '@/lib/chat-transcript-rendering';
import { stripChatControlMetadata as stripTalkingStickControl } from '@/lib/chat-control-metadata';
import type {
  ChatDeepLink,
  ChatMessageAttachment,
  TranscriptEntry,
} from '@/types';

export interface RenderItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isError?: boolean;
  taskId?: string;
  taskTitle?: string | null;
  thinking?: string;
  source?: string;
  sender_name?: string | null;
  senderUserId?: string | null;
  senderAvatarUrl?: string | null;
  emote?: string | null;
  speechText?: string | null;
  agent_name?: string | null;
  attachments?: ChatMessageAttachment[] | null;
  created_at?: string;
  /** Timestamp of the last transcript entry merged into an assistant item (assistant items carry no `created_at`). */
  entryCreatedAt?: string;
  dataSource?: 'transcript' | 'db';
  telemetry?: Record<string, unknown> | null;
  deepLinks?: ChatDeepLink[] | null;
  streaming?: boolean;
  steeringDelivery?: 'pending' | 'steered' | 'queued' | 'unconfirmed';
}

/** Non-cryptographic hash for stable ID generation from content. */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function getEntryContent(e: any): string {
  if (typeof e.content === 'string') return e.content;
  if (e.message && Array.isArray(e.message.content)) {
    return e.message.content.map((p: any) => p.text || '').join('');
  }
  if (e.result && typeof e.result === 'string') return e.result;
  if (e.type === 'tool_use' && e.part?.tool) return `[tool:${e.part.tool}]`;
  return '';
}

/**
 * Error responses can contain provider details before the standard sandbox
 * error marker (for example, model-capacity errors). Stream chunks
 * concatenate without a separator, so a direct-LLM capacity diagnostic can
 * sit mid-line after the assistant output; keep detection aligned for both
 * streamed and persisted transcript messages.
 */
export function isErrorMessageContent(content: string): boolean {
  const normalized = content.trimStart();
  if (/^⚠️\s*Run stopped by user\.?$/i.test(normalized)) return false;
  return (
    normalized.startsWith('⚠️') ||
    /(?:^|\n)\s*⚠️.*Sandbox Error/i.test(normalized) ||
    /(?:^|\n)\s*(?:Error:?\s*)?Selected model is at capacity/i.test(
      normalized,
    ) ||
    /⚠️\s*\*{0,2}LLM Error.*Selected model is at capacity/i.test(normalized)
  );
}

/** Convert transcript entries into renderable items for the chat UI.
 *  The backend pre-formats all entries into flat {type: "message", role, content}
 *  with markdown content identical to streaming output. We just group consecutive
 *  assistant messages into a single bubble (matching the streaming path). */
export function transcriptToRenderItems(
  entries: TranscriptEntry[],
  options: { preserveEmptyStreaming?: boolean } = {},
): RenderItem[] {
  const items: RenderItem[] = [];
  const usedIds = new Set<string>();

  const uniqueId = (base: string): string => {
    let id = base;
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `${base}-${suffix++}`;
    }
    usedIds.add(id);
    return id;
  };

  // Accumulate assistant content between user messages, then flush as one bubble
  let assistantParts: string[] = [];
  // Last non-empty part, used to keep separate events from running together.
  let assistantLastPart = '';
  let assistantLastCreatedAt: string | undefined;
  let assistantLastId: string | undefined;
  let assistantTelemetry: Record<string, unknown> | undefined;
  let assistantAttachments: ChatMessageAttachment[] = [];
  let assistantAgentName: string | null = null;
  let assistantSenderName: string | null = null;
  let assistantSenderUserId: string | null = null;
  let assistantEmote: string | null = null;
  let assistantSpeechText: string | null = null;
  let assistantStreaming = false;
  type AssistantIdentity = {
    agentName: string | null;
    senderName: string | null;
    senderUserId: string | null;
    emote: string | null;
    speechText: string | null;
  };
  let steeredContinuationIdentity: AssistantIdentity | null = null;
  const seenGeneratedAttachmentUrls = new Set<string>();

  const flushAssistant = () => {
    const text = stripTalkingStickControl(assistantParts.join(''));
    // Voice-delayed persona turns deliberately keep their cached transcript
    // content empty until playback starts. Preserve that ephemeral row so the
    // bubble can render its Preparing/Waiting state from live-persona-reveal.
    if (
      text.trim() ||
      (options.preserveEmptyStreaming && assistantStreaming && assistantLastId)
    ) {
      const hashTarget = text.slice(0, 200);
      const hash = simpleHash(hashTarget);
      let baseId = '';

      if (assistantLastId) {
        baseId = assistantLastId;
      } else if (assistantLastCreatedAt) {
        baseId = `a-${assistantLastCreatedAt}`;
      } else {
        baseId = `a-${hash}`;
      }

      items.push({
        id: uniqueId(baseId),
        role: 'assistant',
        content: text,
        isError: isErrorMessageContent(text),
        source: 'web',
        telemetry: assistantTelemetry ?? null,
        attachments:
          assistantAttachments.length > 0 ? assistantAttachments : undefined,
        agent_name: assistantAgentName,
        sender_name: assistantSenderName,
        senderUserId: assistantSenderUserId,
        emote: assistantEmote,
        speechText: assistantSpeechText,
        streaming: assistantStreaming,
        entryCreatedAt: assistantLastCreatedAt,
      });
    }
    assistantParts = [];
    assistantLastPart = '';
    assistantLastCreatedAt = undefined;
    assistantLastId = undefined;
    assistantTelemetry = undefined;
    assistantAttachments = [];
    assistantAgentName = null;
    assistantSenderName = null;
    assistantSenderUserId = null;
    assistantEmote = null;
    assistantSpeechText = null;
    assistantStreaming = false;
  };

  for (const entry of deduplicateCanonicalAssistantEntries(entries as any[])) {
    const entryRecord = entry as unknown as {
      type?: unknown;
      id?: unknown;
      content?: unknown;
      taskId?: unknown;
      taskTitle?: unknown;
      created_at?: unknown;
    };
    if (entryRecord.type === 'system_milestone') {
      flushAssistant();
      items.push({
        id: uniqueId(String(entryRecord.id || 'task-milestone')),
        role: 'system',
        content: String(entryRecord.content || ''),
        taskId:
          typeof entryRecord.taskId === 'string'
            ? entryRecord.taskId
            : undefined,
        taskTitle:
          typeof entryRecord.taskTitle === 'string'
            ? entryRecord.taskTitle
            : null,
        created_at:
          typeof entryRecord.created_at === 'string'
            ? entryRecord.created_at
            : undefined,
      });
      continue;
    }
    // Native Codex answers are transcript metadata. They are associated with
    // their AskUserQuestion card below, not rendered as a misplaced user turn:
    // the running agent's raw output is archived only after the turn ends.
    if (
      (entry as any).type === 'codex_user_input' ||
      (entry as any).type === 'turn_outcome'
    )
      continue;
    if ((entry as any).type === 'live_status') {
      const status = getEntryContent(entry).replace(/\s+/g, ' ').trim();
      if (status) {
        const entryAgentName =
          typeof (entry as any).agent_name === 'string'
            ? ((entry as any).agent_name as string)
            : null;
        const currentPersonaSenderId = personaSenderId({
          senderUserId: assistantSenderUserId,
          agent_name: assistantAgentName,
        });
        const incomingPersonaSenderId = personaSenderId(entry as any);
        if (
          assistantParts.length > 0 &&
          (startsNewPersonaBubble(
            currentPersonaSenderId,
            incomingPersonaSenderId,
            true,
          ) ||
            (entryAgentName &&
              assistantAgentName &&
              entryAgentName !== assistantAgentName))
        ) {
          flushAssistant();
        }
        if (entryAgentName) assistantAgentName = entryAgentName;
        if (typeof (entry as any).sender_name === 'string')
          assistantSenderName = (entry as any).sender_name;
        if (typeof (entry as any).senderUserId === 'string')
          assistantSenderUserId = (entry as any).senderUserId;
        assistantLastPart = `${assistantParts.length ? '\n\n' : ''}[[live: ${status}]]\n\n`;
        assistantParts.push(assistantLastPart);
        assistantLastId = String(
          (entry as any).id ||
            `live-status-${(entry as any).created_at || simpleHash(status)}`,
        );
        assistantLastCreatedAt = (entry as any).created_at;
      }
      continue;
    }
    const content = getEntryContent(entry);
    const role =
      entry.type === 'message' && (entry as any).role === 'user'
        ? 'user'
        : 'assistant';
    if (!role) continue;

    if (
      role === 'user' &&
      /^(?:ai|ai-main):/.test(String((entry as any).agent_name || ''))
    ) {
      continue;
    }

    // Cursor (and similar agents) echo the injected prompt as `type:"user"`.
    // `transcriptToRenderItems` treats non-message entries as assistant, so
    // skip by stream event type — not by the derived role.
    if (
      (entry as any).type === 'user' &&
      'agent_name' in entry &&
      Boolean((entry as any).agent_name)
    ) {
      continue;
    }

    if (role === 'user') {
      const isSteeredBoundary = (entry as any).steeringDelivery === 'steered';
      const continuationIdentity: AssistantIdentity | null = isSteeredBoundary
        ? {
            agentName: assistantAgentName,
            senderName: assistantSenderName,
            senderUserId: assistantSenderUserId,
            emote: assistantEmote,
            speechText: assistantSpeechText,
          }
        : null;
      flushAssistant();
      steeredContinuationIdentity = continuationIdentity;
      const created_at = (entry as any).created_at;
      const baseId =
        (entry as any).id ||
        (created_at
          ? `u-${created_at}`
          : `u-${simpleHash(content.slice(0, 100))}`);
      // Extract attachments from transcript entry (DB fallback includes them)
      const entryAttachments =
        'attachments' in entry && Array.isArray(entry.attachments)
          ? (entry.attachments as ChatMessageAttachment[])
          : undefined;
      // Strip the "[Attached files]" block from content when we have real attachment metadata
      const displayContent =
        entryAttachments && entryAttachments.length > 0
          ? content
              .replace(/\n?\n?\[Attached files\]\n(?:- .+\n?)+/g, '')
              .trim()
          : content;
      items.push({
        id: uniqueId(baseId),
        role: 'user',
        content: displayContent,
        isError: false,
        source:
          'source' in entry && entry.source
            ? (entry.source as string)
            : 'senderUserId' in entry && entry.senderUserId
              ? 'web'
              : 'sender_name' in entry && entry.sender_name
                ? 'whatsapp'
                : 'web',
        created_at,
        sender_name:
          'sender_name' in entry
            ? (entry.sender_name as string | undefined)
            : undefined,
        senderUserId:
          'senderUserId' in entry
            ? (entry.senderUserId as string | undefined)
            : undefined,
        senderAvatarUrl:
          'senderAvatarUrl' in entry
            ? (entry.senderAvatarUrl as string | null | undefined)
            : undefined,
        attachments: entryAttachments,
        deepLinks:
          'deepLinks' in entry && Array.isArray(entry.deepLinks)
            ? (entry.deepLinks as ChatDeepLink[])
            : undefined,
        steeringDelivery: [
          'pending',
          'steered',
          'queued',
          'unconfirmed',
        ].includes((entry as any).steeringDelivery)
          ? (entry as any).steeringDelivery
          : undefined,
      });
    } else {
      const entryAgentName =
        typeof (entry as any).agent_name === 'string'
          ? ((entry as any).agent_name as string)
          : null;
      if (assistantParts.length === 0 && steeredContinuationIdentity) {
        assistantAgentName =
          entryAgentName ?? steeredContinuationIdentity.agentName;
        assistantSenderName =
          typeof (entry as any).sender_name === 'string'
            ? (entry as any).sender_name
            : steeredContinuationIdentity.senderName;
        assistantSenderUserId =
          typeof (entry as any).senderUserId === 'string'
            ? (entry as any).senderUserId
            : steeredContinuationIdentity.senderUserId;
        assistantEmote = steeredContinuationIdentity.emote;
        assistantSpeechText = steeredContinuationIdentity.speechText;
        steeredContinuationIdentity = null;
      }
      const currentPersonaSenderId = personaSenderId({
        senderUserId: assistantSenderUserId,
        agent_name: assistantAgentName,
      });
      const incomingPersonaSenderId = personaSenderId(entry as any);
      if (
        assistantParts.length > 0 &&
        (startsNewPersonaBubble(
          currentPersonaSenderId,
          incomingPersonaSenderId,
          Boolean(content),
          (entry as any).streaming === true,
        ) ||
          (entryAgentName &&
            assistantAgentName &&
            entryAgentName !== assistantAgentName))
      ) {
        flushAssistant();
      }
      if (entryAgentName) assistantAgentName = entryAgentName;
      if (typeof (entry as any).sender_name === 'string')
        assistantSenderName = (entry as any).sender_name;
      if (typeof (entry as any).senderUserId === 'string')
        assistantSenderUserId = (entry as any).senderUserId;
      if (typeof (entry as any).emote === 'string')
        assistantEmote = (entry as any).emote;
      if (typeof (entry as any).speechText === 'string')
        assistantSpeechText = (entry as any).speechText;
      if ((entry as any).streaming === true) assistantStreaming = true;
      // Deep-search for ANY stable ID or timestamp in the entry
      const findValue = (obj: any, keys: string[]): any => {
        if (!obj || typeof obj !== 'object') return undefined;
        for (const k of keys) {
          if (obj[k]) return obj[k];
        }
        for (const k in obj) {
          const res = findValue(obj[k], keys);
          if (res) return res;
        }
        return undefined;
      };

      const entryId = findValue(entry, ['id', 'uuid', 'message_id', 'part_id']);
      const entryTs = findValue(entry, ['created_at', 'timestamp', 'time']);

      if (entryId) assistantLastId = entryId;
      if (entryTs) assistantLastCreatedAt = entryTs;

      // The first entry's usage chunk is the bubble's telemetry, unless the
      // server marked a later entry as carrying the turn's consolidated totals:
      // those override it, model included.
      if ('telemetry' in entry && entry.telemetry) {
        if (!assistantTelemetry) {
          assistantTelemetry = entry.telemetry as Record<string, unknown>;
        } else if ((entry as any).telemetryIsTurnTotal === true) {
          assistantTelemetry = {
            ...assistantTelemetry,
            ...(entry.telemetry as Record<string, unknown>),
          };
        }
      }
      if ('attachments' in entry && Array.isArray(entry.attachments)) {
        const attachments = entry.attachments as ChatMessageAttachment[];
        if ((entry as any).type === 'attachments') {
          assistantAttachments.push(
            ...attachments.filter((attachment) => {
              if (!attachment.url) return true;
              if (seenGeneratedAttachmentUrls.has(attachment.url)) return false;
              seenGeneratedAttachmentUrls.add(attachment.url);
              return true;
            }),
          );
        } else {
          assistantAttachments.push(...attachments);
        }
      }
      // Each part is a separate transcript event (the server already merged
      // adjacent assistant text). Gluing two prose events, such as a system
      // notice and the following reply, would run them into one paragraph.
      if (/\S$/.test(assistantLastPart) && /^\S/.test(content)) {
        assistantParts.push('\n\n');
      }
      assistantParts.push(content);
      if (content) assistantLastPart = content;
      // Every persona attribution closes one autonomous turn. This keeps
      // repeated turns by the same persona as distinct chat bubbles instead
      // of merging an unbounded conversation into one message.
      if ((entry as any).type === 'ai_user_attribution') {
        flushAssistant();
      }
    }
  }
  flushAssistant();
  return items;
}

/**
 * Merge a saved or live run transcript the way chat does: consecutive assistant
 * entries become one item per turn, and blank items are dropped. For read-only
 * transcript surfaces that receive the server-formatted entries.
 */
export function transcriptToBubbleItems(
  entries: readonly object[] | undefined,
): RenderItem[] {
  return transcriptToRenderItems((entries ?? []) as TranscriptEntry[]).filter(
    (item) => item.content.trim(),
  );
}
