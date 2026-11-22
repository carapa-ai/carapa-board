import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../lib/hash.js';
import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import {
  getConversation,
  getAiUserRow,
  resolveConversationPublicShare,
  insertPublicPromptRequest,
  updatePublicPromptRequest,
  getPublicPromptRequest,
  countPublicPromptRequestsSince,
  countPublicVisitorPromptRequestsSince,
  hasInFlightPublicPromptRequest,
  saveChatMessage,
  updateConversation,
} from '../db.js';
import {
  chatTranscriptStatKey,
  readChatTranscriptAsync,
} from '../group-dir.js';
import { logger } from '../logger.js';
import { formatTranscriptEntries } from '../modules/transcripts/transcript-store.js';
import { getPersonaLiveSession } from '../modules/ai-users/playback-gate.js';
import {
  publishPublicConversationEvent,
  subscribePublicConversation,
} from '../modules/chat/public-conversation-events.js';
import { buildLimiter, publicTokenRateLimitKey } from '../lib/rate-limit.js';
import { getGroupByFolder } from '../state-manager.js';
import { effectiveProjectUploadDir } from '../sandbox/effective-settings.js';
import {
  CARAPA_WA_LINK_TOKEN,
  DATA_DIR,
  ENABLE_WHATSAPP,
  MCP_WHATSAPP_BASE_URL,
  PUBLIC_PROMPT_LINK_DAILY_MAX,
  PUBLIC_PROMPT_LINK_HOURLY_MAX,
  PUBLIC_PROMPT_MAX_CHARS,
  PUBLIC_PROMPT_TIMEOUT_MS,
  PUBLIC_PROMPT_VISITOR_MAX,
  PUBLIC_PROMPT_VISITOR_WINDOW_MS,
} from '../config.js';
import {
  detectMimetypeForFile,
  isActiveContentMimetype,
  MAX_UPLOAD_SERVE_BYTES,
} from '../lib/file-content.js';
import { readContainedFile } from '../lib/read-contained-file.js';
import {
  openArtifactFile,
  sendArtifactFile,
} from '../modules/chat/artifacts.js';
import { ENABLE_TTS } from '../modules/tts/config.js';
import {
  ensurePersonaMessageSpeech,
  getReadyMessageSpeechAsset,
  resolvePersonaSpeechSource,
} from '../modules/tts/message-speech.js';
import { serveTtsAsset } from '../modules/tts/audio-response.js';
import {
  normalizeEmoteName,
  resolveAiUserPath,
} from '../modules/ai-users/storage.js';
import {
  ensureAiUserAvatarThumbnail,
  ensureAiUserEmoteThumbnail,
} from '../modules/ai-users/avatar-thumbnail.js';
import { getPublicPromptingEligibility } from '../modules/chat/public-prompting.js';
import { sanitizePublicAssistantContent } from '../modules/chat/public-assistant-content.js';
import {
  containsPublicCredential,
  judgePublicContent,
  scrubPublicText,
} from '../modules/chat/public-content-safety.js';
import {
  ensurePublicVisitorSession,
  publicVisitorCsrf,
  publicVisitorHash,
  newPublicPromptRequestId,
  ownsPublicPromptRequest,
  validatePublicVisitorRequest,
} from '../modules/chat/public-visitor-session.js';
import { enqueuePersistedDirectFollowup } from '../modules/chat/direct-followups.js';
import { resolveSessionAgentKey } from '../lib/resolve-agent-config.js';

const PUBLIC_SSE_MAX_PER_CONVERSATION = 50;
const PUBLIC_SSE_MAX_PER_IP = 5;
const PUBLIC_SSE_MAX_LIFETIME_MS = 30 * 60_000;
const publicSseConversations = new Map<string, number>();
const publicSseIps = new Map<string, number>();

const router = Router();
const publicReadLimiter = buildLimiter({
  max: 120,
  message: 'Public share rate limit exceeded',
  keyGenerator: publicTokenRateLimitKey,
});
const publicSpeechPrepareLimiter = buildLimiter({
  max: 20,
  message: 'Public speech rate limit exceeded',
  keyGenerator: publicTokenRateLimitKey,
});
const publicSpeechReadLimiter = buildLimiter({
  max: 120,
  message: 'Public speech playback rate limit exceeded',
  keyGenerator: publicTokenRateLimitKey,
});
const publicPromptLocks = new Set<string>();

function publicSpeechMessageId(messageId: string, text: string): string {
  const digest = sha256Hex(text).slice(0, 16);
  return `${messageId}:public:${digest}`;
}

async function resolvePublicSpeechSource(
  conversationId: string,
  messageId: string,
  group: ReturnType<typeof getGroupByFolder>,
) {
  const source = await resolvePersonaSpeechSource(conversationId, messageId);
  if (!source) return null;
  const text = scrubPublicText(source.text, group);
  return {
    ...source,
    messageId: publicSpeechMessageId(messageId, text),
    text,
    displayContent: scrubPublicText(source.displayContent || '', group),
  };
}

interface PublicAttachment {
  type: 'audio' | 'image' | 'video' | 'document';
  mimetype: string;
  filename?: string;
  caption?: string;
  url: string;
}

interface PublicMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string | null;
  displayName: string | null;
  personaTitle: string | null;
  isPersona: boolean;
  avatarUrl: string | null;
  speechAvailable: boolean;
  speech: {
    state: 'available' | 'ready';
    durationMs: number | null;
    mimeType: string | null;
    url: string;
  } | null;
  attachments: PublicAttachment[];
}

function noStore(res: any): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function resolveShare(token: string) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) return null;
  const share = await resolveConversationPublicShare(token);
  if (!share) return null;
  const conversation = await getConversation(share.conversationId);
  if (!conversation) return null;
  return { share, conversation };
}

async function loadFormattedEntries(conversation: any): Promise<any[]> {
  const raw: any[] = await readChatTranscriptAsync(
    conversation.group_folder,
    conversation.id,
    conversation.created_at ?? null,
  );
  const messageMetadata = new Map<string, any>();
  for (const entry of raw) {
    if (entry?.type === 'message' && entry.id) {
      messageMetadata.set(String(entry.id), {
        sender_name: entry.sender_name,
        senderUserId: entry.senderUserId,
        attachments: entry.attachments,
        speechText: entry.speechText,
        emote: entry.emote,
      });
    }
  }
  return (formatTranscriptEntries(raw) as any[]).map((entry) => ({
    ...entry,
    ...(messageMetadata.get(String(entry?.id ?? '')) ?? {}),
  }));
}

// Media requests commonly arrive in a burst for the same transcript. Keep the
// full projection because formatting can depend on other entries in the turn.
const mediaEntriesCache = new Map<string, { stat: string; entries: any[] }>();

async function loadMediaEntries(conversation: any): Promise<any[]> {
  const key = JSON.stringify([conversation.group_folder, conversation.id]);
  const before = await chatTranscriptStatKey(
    conversation.group_folder,
    conversation.id,
  );
  const cached = mediaEntriesCache.get(key);
  // Missing or empty live transcripts may be restored from an archive.
  if (before !== '-' && !before.startsWith('0:') && cached?.stat === before) {
    return cached.entries;
  }
  const entries = await loadFormattedEntries(conversation);
  const after = await chatTranscriptStatKey(
    conversation.group_folder,
    conversation.id,
  );
  if (before === after && after !== '-' && !after.startsWith('0:')) {
    mediaEntriesCache.delete(key);
    if (mediaEntriesCache.size >= 32)
      mediaEntriesCache.delete(mediaEntriesCache.keys().next().value!);
    mediaEntriesCache.set(key, { stat: after, entries });
  } else {
    mediaEntriesCache.delete(key);
  }
  return entries;
}

export { sanitizePublicAssistantContent } from '../modules/chat/public-assistant-content.js';

function isLlmErrorTurn(entry: any): boolean {
  return (
    entry?.role === 'assistant' &&
    typeof entry.content === 'string' &&
    /^\s*⚠️\s*\*\*LLM Error\*\*\s*:/i.test(entry.content)
  );
}

export function projectPublicMessages(
  entries: any[],
  token: string,
  group = undefined as ReturnType<typeof getGroupByFolder>,
): PublicMessage[] {
  const avatarUrlsByVariant = new Map<string, string>();
  return entries
    .filter(
      (entry) =>
        entry &&
        !isLlmErrorTurn(entry) &&
        (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.content === 'string' &&
        entry.content.trim().length > 0,
    )
    .map((entry, messageIndex) => {
      const id = String(entry.id ?? `message-${messageIndex}`);
      const personaId = personaIdForEntry(entry);
      const isPersona = personaId !== null;
      let avatarUrl: string | null = null;
      if (personaId) {
        const variantKey = `${personaId}:${emoteNameForEntry(entry) ?? 'avatar'}`;
        avatarUrl =
          avatarUrlsByVariant.get(variantKey) ??
          `/api/public/conversations/${encodeURIComponent(token)}/messages/${encodeURIComponent(id)}/avatar`;
        avatarUrlsByVariant.set(variantKey, avatarUrl);
      }
      const attachments = Array.isArray(entry.attachments)
        ? entry.attachments.map((attachment: any, index: number) => ({
            type: ['audio', 'image', 'video', 'document'].includes(
              attachment?.type,
            )
              ? attachment.type
              : 'document',
            mimetype:
              typeof attachment?.mimetype === 'string'
                ? attachment.mimetype
                : 'application/octet-stream',
            filename:
              typeof attachment?.filename === 'string'
                ? scrubPublicText(attachment.filename, group)
                : undefined,
            caption:
              typeof attachment?.caption === 'string'
                ? scrubPublicText(attachment.caption, group)
                : undefined,
            url: `/api/public/conversations/${encodeURIComponent(token)}/attachments/${encodeURIComponent(id)}/${index}`,
          }))
        : [];
      const content =
        entry.role === 'assistant'
          ? scrubPublicText(
              sanitizePublicAssistantContent(entry.content),
              group,
            )
          : scrubPublicText(entry.content, group);
      return {
        id,
        role: entry.role,
        content,
        createdAt:
          typeof entry.created_at === 'string' ? entry.created_at : null,
        displayName:
          typeof entry.sender_name === 'string'
            ? entry.sender_name
            : typeof entry.agent_name === 'string'
              ? entry.agent_name.replace(/^ai(?:-main)?:/, '') || null
              : null,
        personaTitle: null,
        isPersona,
        avatarUrl,
        speechAvailable: isPersona && entry.role === 'assistant',
        speech:
          isPersona && entry.role === 'assistant'
            ? {
                state: 'available',
                durationMs: null,
                mimeType: null,
                url: `/api/public/conversations/${encodeURIComponent(token)}/messages/${encodeURIComponent(id)}/speech`,
              }
            : null,
        attachments,
      } satisfies PublicMessage;
    })
    .filter(
      (message) => message.content.length > 0 || message.attachments.length > 0,
    );
}

async function enrichPublicPersonaIdentities(
  messages: PublicMessage[],
  entries: any[],
): Promise<PublicMessage[]> {
  const entryById = new Map(
    entries.map((entry) => [String(entry?.id ?? ''), entry]),
  );
  const personaIds = [
    ...new Set(
      messages.flatMap((message) => {
        const personaId = personaIdForEntry(entryById.get(message.id));
        return personaId ? [personaId] : [];
      }),
    ),
  ];
  const rows = await Promise.all(personaIds.map((id) => getAiUserRow(id)));
  const rowById = new Map(rows.filter(Boolean).map((row) => [row!.id, row!]));
  return messages.map((message) => {
    const personaId = personaIdForEntry(entryById.get(message.id));
    const persona = personaId ? rowById.get(personaId) : undefined;
    if (!persona) return message;
    const name = persona.name.trim() || message.displayName;
    const title = persona.identity.trim();
    return {
      ...message,
      displayName: name,
      personaTitle: title && title !== name ? title : null,
    };
  });
}

function personaIdForEntry(entry: any): string | null {
  const senderUserId =
    typeof entry?.senderUserId === 'string' ? entry.senderUserId : '';
  if (senderUserId.startsWith('ai:')) return senderUserId.slice(3) || null;
  const agentName =
    typeof entry?.agent_name === 'string' ? entry.agent_name : '';
  if (agentName.startsWith('ai-main:'))
    return agentName.slice('ai-main:'.length) || null;
  if (agentName.startsWith('ai:')) return agentName.slice(3) || null;
  return null;
}

function emoteNameForEntry(entry: any): string | null {
  if (typeof entry?.emote !== 'string' || !entry.emote.trim()) return null;
  try {
    return normalizeEmoteName(entry.emote);
  } catch {
    return null;
  }
}

async function findMessageAndAttachment(
  conversation: any,
  token: string,
  messageId: string,
  index: number,
) {
  const entries = await loadMediaEntries(conversation);
  const entry = entries.find((item) => String(item?.id ?? '') === messageId);
  const attachment = Array.isArray(entry?.attachments)
    ? entry.attachments[index]
    : undefined;
  return {
    entry,
    attachment,
    publicMessage: projectPublicMessages(entry ? [entry] : [], token)[0],
  };
}

router.get('/conversations/:token', publicReadLimiter, async (req, res) => {
  noStore(res);
  const token = String(req.params.token);
  const resolved = await resolveShare(token);
  if (!resolved)
    return res.status(404).json({ error: 'Shared conversation not found' });
  const entries = await loadFormattedEntries(resolved.conversation);
  const group = getGroupByFolder(resolved.conversation.group_folder);
  const eligibility = await getPublicPromptingEligibility(
    resolved.conversation.id,
  );
  let messages = await enrichPublicPersonaIdentities(
    projectPublicMessages(entries, token, group),
    entries,
  );
  const parsedLimit = Number.parseInt(String(req.query.limit ?? '40'), 10);
  const parsedOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 40;
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;
  const end = Math.max(0, messages.length - offset);
  const start = Math.max(0, end - limit);
  return res.json({
    conversation: {
      title:
        resolved.conversation.title ||
        resolved.conversation.preview ||
        'Shared conversation',
      liveMode: Boolean(getPersonaLiveSession(resolved.conversation.id)),
      ttsEnabled: ENABLE_TTS,
      visitorPromptingEnabled:
        resolved.share.allowVisitorPrompts === 1 && eligibility.available,
      promptMaxChars: PUBLIC_PROMPT_MAX_CHARS,
    },
    messages: messages.slice(start, end),
    total: messages.length,
    hasMore: start > 0,
    nextOffset: start > 0 ? offset + limit : messages.length,
  });
});

router.get(
  '/conversations/:token/visitor-session',
  publicReadLimiter,
  async (req, res) => {
    noStore(res);
    const token = String(req.params.token);
    const resolved = await resolveShare(token);
    if (!resolved)
      return res.status(404).json({ error: 'Shared conversation not found' });
    const eligibility = await getPublicPromptingEligibility(
      resolved.conversation.id,
    );
    if (resolved.share.allowVisitorPrompts !== 1 || !eligibility.available)
      return res
        .status(409)
        .json({ error: 'Visitor prompting is unavailable' });
    const session = ensurePublicVisitorSession(req, res);
    return res.json({
      csrfToken: publicVisitorCsrf(session, token),
      displayName: session.pseudonym,
    });
  },
);

router.post('/conversations/:token/prompts', async (req, res) => {
  noStore(res);
  const token = String(req.params.token);
  const resolved = await resolveShare(token);
  if (!resolved)
    return res.status(404).json({ error: 'Shared conversation not found' });
  const session = validatePublicVisitorRequest(req, token);
  if (!session)
    return res.status(403).json({ error: 'Invalid visitor session' });
  const prompt =
    typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length > PUBLIC_PROMPT_MAX_CHARS)
    return res.status(400).json({
      error: `Prompt must be 1-${PUBLIC_PROMPT_MAX_CHARS} characters`,
    });
  if (req.body && Object.keys(req.body).some((key) => key !== 'prompt'))
    return res.status(400).json({ error: 'Only text prompts are supported' });
  const eligibility = await getPublicPromptingEligibility(
    resolved.conversation.id,
  );
  if (resolved.share.allowVisitorPrompts !== 1 || !eligibility.available)
    return res.status(409).json({ error: 'Visitor prompting is unavailable' });

  const conversationId = resolved.conversation.id;
  const staleCutoff = new Date(
    Date.now() - PUBLIC_PROMPT_TIMEOUT_MS * 2,
  ).toISOString();
  if (publicPromptLocks.has(conversationId))
    return res
      .status(409)
      .json({ error: 'Another visitor prompt is already running' });
  publicPromptLocks.add(conversationId);
  try {
    if (await hasInFlightPublicPromptRequest(conversationId, staleCutoff)) {
      return res
        .status(409)
        .json({ error: 'Another visitor prompt is already running' });
    }
    const visitorHash = publicVisitorHash(session, req.ip);
    const now = Date.now();
    const [visitorCount, hourlyCount, dailyCount] = await Promise.all([
      countPublicVisitorPromptRequestsSince(
        conversationId,
        visitorHash,
        new Date(now - PUBLIC_PROMPT_VISITOR_WINDOW_MS).toISOString(),
      ),
      countPublicPromptRequestsSince(
        conversationId,
        new Date(now - 60 * 60 * 1000).toISOString(),
      ),
      countPublicPromptRequestsSince(
        conversationId,
        new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      ),
    ]);
    if (
      visitorCount >= PUBLIC_PROMPT_VISITOR_MAX ||
      hourlyCount >= PUBLIC_PROMPT_LINK_HOURLY_MAX ||
      dailyCount >= PUBLIC_PROMPT_LINK_DAILY_MAX
    ) {
      return res.status(429).json({ error: 'Visitor prompt limit reached' });
    }

    const requestId = newPublicPromptRequestId(session);
    const createdAt = new Date().toISOString();
    try {
      await insertPublicPromptRequest({
        id: requestId,
        conversationId,
        visitorHash,
        status: 'judging',
        createdAt,
      });
    } catch {
      return res
        .status(503)
        .json({ error: 'Visitor prompting is unavailable' });
    }
    try {
      const group = getGroupByFolder(resolved.conversation.group_folder);
      if (!group) {
        await updatePublicPromptRequest(requestId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        return res
          .status(503)
          .json({ error: 'Visitor prompting is unavailable' });
      }
      if (containsPublicCredential(prompt, group)) {
        await updatePublicPromptRequest(requestId, {
          status: 'rejected',
          safetyCategory: 'credential-content',
          completedAt: new Date().toISOString(),
        });
        return res
          .status(422)
          .json({ error: 'This prompt cannot be submitted safely' });
      }
      const decision = await judgePublicContent('input', prompt, group);
      if (!decision.allowed) {
        await updatePublicPromptRequest(requestId, {
          status:
            decision.category === 'judge-unavailable' ? 'failed' : 'rejected',
          safetyCategory: decision.category,
          completedAt: new Date().toISOString(),
        });
        return res
          .status(decision.category === 'judge-unavailable' ? 503 : 422)
          .json({
            error:
              decision.category === 'judge-unavailable'
                ? 'Safety review is unavailable'
                : 'This prompt cannot be submitted safely',
          });
      }
      const userMessage = await saveChatMessage({
        id: requestId,
        group_folder: group.folder,
        role: 'user',
        content: scrubPublicText(prompt, group),
        sender_name: session.pseudonym,
        source: 'public',
        publicInteractionId: requestId,
        created_at: createdAt,
        conversation_id: conversationId,
      });
      await updateConversation(conversationId, group.folder, {
        lastTriggeredByUserId: null,
        lastTriggerSource: 'public',
        lastTriggeredAt: createdAt,
      });
      await updatePublicPromptRequest(requestId, { status: 'running' });
      try {
        await enqueuePersistedDirectFollowup({
          message: userMessage,
          metadata: {
            conversationId,
            executionContent: prompt,
            agentCmd: resolveSessionAgentKey(
              group,
              resolved.conversation.last_agent_cmd,
              resolved.conversation.runtimeSelection,
            ),
            runtimeSelection:
              resolved.conversation.runtimeSelection ?? undefined,
            triggeredByUserId: null,
            triggerSource: 'public',
            delivery: {
              kind: 'public-persona',
              interactionId: requestId,
              visitorName: session.pseudonym,
            },
          },
        });
      } catch {
        await updatePublicPromptRequest(requestId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        return res
          .status(503)
          .json({ error: 'Visitor prompting is unavailable' });
      }
    } catch (err) {
      // Don't leave the durable row in-flight (blocking the share until the
      // stale cutoff) when admission fails unexpectedly.
      await updatePublicPromptRequest(requestId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      }).catch(() => {});
      throw err;
    }
    publishPublicConversationEvent(conversationId, {
      type: 'changed',
      messageId: requestId,
    });
    // Durable request state now owns serialization/recovery; the process-local
    // lock (released in `finally`) only protects the admission transaction itself.
    return res.status(202).json({ requestId, status: 'running' });
  } finally {
    publicPromptLocks.delete(conversationId);
  }
});

router.get(
  '/conversations/:token/prompts/:requestId',
  publicReadLimiter,
  async (req, res) => {
    noStore(res);
    const token = String(req.params.token);
    const resolved = await resolveShare(token);
    if (!resolved)
      return res.status(404).json({ error: 'Shared conversation not found' });
    const session = ensurePublicVisitorSession(req, res);
    const row = await getPublicPromptRequest(String(req.params.requestId));
    if (
      !row ||
      row.conversationId !== resolved.conversation.id ||
      !ownsPublicPromptRequest(session, row.id)
    )
      return res.status(404).json({ error: 'Prompt request not found' });
    return res.json({
      requestId: row.id,
      status: row.status,
      responderCount: row.responderCount,
    });
  },
);

router.get(
  '/conversations/:token/events',
  publicReadLimiter,
  async (req, res) => {
    noStore(res);
    const resolved = await resolveShare(String(req.params.token));
    if (!resolved)
      return res.status(404).json({ error: 'Shared conversation not found' });
    const conversationId = resolved.conversation.id;
    const ip = req.ip ? ipKeyGenerator(req.ip) : 'unknown';
    if (
      (publicSseConversations.get(conversationId) ?? 0) >=
        PUBLIC_SSE_MAX_PER_CONVERSATION ||
      (publicSseIps.get(ip) ?? 0) >= PUBLIC_SSE_MAX_PER_IP
    )
      return res.status(429).json({ error: 'Too many public event streams' });
    if (res.destroyed) return;
    publicSseConversations.set(
      conversationId,
      (publicSseConversations.get(conversationId) ?? 0) + 1,
    );
    publicSseIps.set(ip, (publicSseIps.get(ip) ?? 0) + 1);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(
      `event: connected\ndata: ${JSON.stringify({
        type: 'connected',
        liveMode: Boolean(getPersonaLiveSession(resolved.conversation.id)),
      })}\n\n`,
    );
    const unsubscribe = subscribePublicConversation(
      resolved.conversation.id,
      res,
    );
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    const lifetime = setTimeout(() => res.end(), PUBLIC_SSE_MAX_LIFETIME_MS);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe();
      for (const [map, key] of [
        [publicSseConversations, conversationId],
        [publicSseIps, ip],
      ] as const) {
        const count = (map.get(key) ?? 1) - 1;
        if (count) map.set(key, count);
        else map.delete(key);
      }
    };
    res.once('close', cleanup);
    res.once('finish', cleanup);
  },
);

router.get(
  '/conversations/:token/attachments/:messageId/:index',
  publicReadLimiter,
  async (req, res) => {
    noStore(res);
    const token = String(req.params.token);
    const resolved = await resolveShare(token);
    if (!resolved)
      return res.status(404).json({ error: 'Shared conversation not found' });
    const index = Number.parseInt(String(req.params.index), 10);
    if (!Number.isInteger(index) || index < 0 || index > 100) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const { attachment } = await findMessageAndAttachment(
      resolved.conversation,
      token,
      String(req.params.messageId),
      index,
    );
    const rawUrl = typeof attachment?.url === 'string' ? attachment.url : '';
    if (!rawUrl) return res.status(404).json({ error: 'Attachment not found' });

    const uploadMatch = rawUrl.match(/^\/uploads\/([^/]+)\/([^/?#]+)$/);
    if (uploadMatch && uploadMatch[1] === resolved.conversation.group_folder) {
      const group = getGroupByFolder(resolved.conversation.group_folder);
      if (!group)
        return res.status(404).json({ error: 'Attachment not found' });
      const filename = path.basename(uploadMatch[2]);
      const uploadRoot = effectiveProjectUploadDir(group, DATA_DIR);
      const filePath = path.join(uploadRoot, filename);
      // The upload dir is writable by the agent sandbox: refuse symlinks and
      // read through the contained reader (mirrors the authenticated route).
      let data: Buffer;
      try {
        if ((await fsp.lstat(filePath)).isSymbolicLink()) {
          return res.status(404).json({ error: 'Attachment not found' });
        }
        data = await readContainedFile(
          uploadRoot,
          filePath,
          MAX_UPLOAD_SERVE_BYTES,
        );
      } catch {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const mimetype = await detectMimetypeForFile(filePath);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (isActiveContentMimetype(mimetype)) {
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.attachment(filename);
      }
      return res.type(mimetype).send(data);
    }

    const artifactMatch = rawUrl.match(
      /^\/artifacts\/([^/]+)\/(.+?)(?:\?.*)?$/,
    );
    if (
      artifactMatch &&
      artifactMatch[1] === resolved.conversation.group_folder
    ) {
      const segments: string[] = artifactMatch[2].split('/');
      if (
        segments.length === 0 ||
        segments.some(
          (segment) =>
            !segment ||
            segment === '.' ||
            segment === '..' ||
            segment.includes('\\') ||
            segment.includes('\0'),
        )
      ) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      try {
        const opened = await openArtifactFile(
          resolved.conversation.group_folder,
          segments,
        );
        if (!opened) {
          return res.status(404).json({ error: 'Attachment not found' });
        }
        return await sendArtifactFile(res, opened);
      } catch (err) {
        logger.warn({ err }, 'Shared artifact could not be served');
        if (!res.headersSent) {
          res.status(404).json({ error: 'Attachment not found' });
        }
        return;
      }
    }

    const waMatch = rawUrl.match(/^\/api\/wa-media\/([^/?#]+)$/);
    if (waMatch && ENABLE_WHATSAPP) {
      const headers: Record<string, string> = {};
      if (CARAPA_WA_LINK_TOKEN)
        headers.Authorization = `Bearer ${CARAPA_WA_LINK_TOKEN}`;
      try {
        const upstream = await fetch(
          `${MCP_WHATSAPP_BASE_URL}/api/media/${encodeURIComponent(waMatch[1])}`,
          {
            headers,
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!upstream.ok)
          return res.status(404).json({ error: 'Attachment not found' });
        res.setHeader(
          'Content-Type',
          upstream.headers.get('content-type') || 'application/octet-stream',
        );
        return res.send(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        return res.status(502).json({ error: 'Attachment unavailable' });
      }
    }
    return res.status(404).json({ error: 'Attachment not found' });
  },
);

router.get(
  '/conversations/:token/messages/:messageId/avatar',
  publicReadLimiter,
  async (req, res) => {
    noStore(res);
    const resolved = await resolveShare(String(req.params.token));
    if (!resolved) return res.status(404).json({ error: 'Avatar not found' });
    const entries = await loadMediaEntries(resolved.conversation);
    const entry = entries.find(
      (item) => String(item?.id ?? '') === String(req.params.messageId),
    );
    const personaId = personaIdForEntry(entry);
    if (!personaId || entry?.role !== 'assistant') {
      return res.status(404).json({ error: 'Avatar not found' });
    }
    const aiUser = await getAiUserRow(personaId);
    if (!aiUser) return res.status(404).json({ error: 'Avatar not found' });

    let thumbnailPath: string | null = null;
    const emoteName = emoteNameForEntry(entry);
    if (emoteName) {
      const emote = (aiUser.publishedEmotes ?? []).find(
        (item) => item.name === emoteName,
      );
      if (emote) {
        try {
          thumbnailPath = await ensureAiUserEmoteThumbnail(
            resolveAiUserPath(emote.path),
          );
        } catch {
          thumbnailPath = null;
        }
      }
    }
    if (!thumbnailPath && aiUser.avatarPath) {
      try {
        thumbnailPath = await ensureAiUserAvatarThumbnail(
          resolveAiUserPath(aiUser.avatarPath),
        );
      } catch {
        thumbnailPath = null;
      }
    }
    if (!thumbnailPath)
      return res.status(404).json({ error: 'Avatar not found' });
    const data = await fsp.readFile(thumbnailPath).catch(() => null);
    if (!data) return res.status(404).json({ error: 'Avatar not found' });
    return res
      .type('image/jpeg')
      .set('Cache-Control', 'private, max-age=300')
      .send(data);
  },
);

router.post(
  '/conversations/:token/messages/:messageId/speech',
  publicSpeechPrepareLimiter,
  async (req, res) => {
    noStore(res);
    const resolved = await resolveShare(String(req.params.token));
    if (!resolved || !ENABLE_TTS)
      return res.status(404).json({ error: 'Speech not found' });
    const entries = await loadMediaEntries(resolved.conversation);
    const messageId = String(req.params.messageId);
    const entry = entries.find((item) => String(item?.id ?? '') === messageId);
    const personaId = personaIdForEntry(entry);
    if (entry?.role !== 'assistant' || !personaId) {
      return res.status(404).json({ error: 'Speech not found' });
    }
    try {
      const group = getGroupByFolder(resolved.conversation.group_folder);
      const source = await resolvePublicSpeechSource(
        resolved.conversation.id,
        messageId,
        group,
      );
      if (!source) return res.status(404).json({ error: 'Speech not found' });
      let asset = await getReadyMessageSpeechAsset(
        resolved.conversation.id,
        source.messageId,
      );
      if (!asset) {
        asset = await ensurePersonaMessageSpeech(source);
      }
      if (!asset)
        return res.status(502).json({ error: 'Speech synthesis failed' });
      if (req.query.prepare === '1') {
        return res.json({
          state: 'ready',
          durationMs: asset.durationMs,
          mimeType: asset.mimeType,
        });
      }
      await serveTtsAsset(req, res, asset);
      return;
    } catch {
      return res.status(502).json({ error: 'Speech synthesis failed' });
    }
  },
);

router.get(
  '/conversations/:token/messages/:messageId/speech',
  publicSpeechReadLimiter,
  async (req, res) => {
    noStore(res);
    const resolved = await resolveShare(String(req.params.token));
    if (!resolved || !ENABLE_TTS)
      return res.status(404).json({ error: 'Speech not found' });
    const messageId = String(req.params.messageId);
    const entries = await loadMediaEntries(resolved.conversation);
    const entry = entries.find((item) => String(item?.id ?? '') === messageId);
    if (entry?.role !== 'assistant' || !personaIdForEntry(entry)) {
      return res.status(404).json({ error: 'Speech not found' });
    }
    const source = await resolvePublicSpeechSource(
      resolved.conversation.id,
      messageId,
      getGroupByFolder(resolved.conversation.group_folder),
    );
    if (!source) return res.status(404).json({ error: 'Speech not found' });
    const asset = await getReadyMessageSpeechAsset(
      resolved.conversation.id,
      source.messageId,
    );
    if (!asset) return res.status(404).json({ error: 'Speech not ready' });
    await serveTtsAsset(req, res, asset);
  },
);

export default router;
