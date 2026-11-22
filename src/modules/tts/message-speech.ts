import fs from 'node:fs/promises';
import {
  deleteTtsAudioAsset,
  getAiUserRow,
  getConversation,
  getMessageSpeechAsset,
  linkMessageSpeechAsset,
  listMessageSpeechAssets,
  type TtsAudioAssetRow,
} from '../../db.js';
import { InFlightCoalescer } from '../../lib/in-flight-coalescer.js';
import { readChatTranscriptAsync } from '../../group-dir.js';
import { formatTranscriptEntries } from '../transcripts/transcript-store.js';
import { prepareForTts } from './normalizer.js';
import { synthesizeChunksCached, ttsAssetFilePath } from './cache.js';
import {
  SUPERTONIC_EXPRESSIONS,
  TTS_LANG,
  TTS_MAX_CHUNK_CHARS,
  TTS_VOICE,
} from './config.js';
import { chunkForTts } from './chunker.js';
import { detectSpeechLanguage } from './language-detect.js';

const inFlight = new InFlightCoalescer();

export async function validateLinkedTtsAsset(
  asset: TtsAudioAssetRow | undefined,
  accessFile: (filePath: string) => Promise<unknown> = fs.access,
  invalidateAsset: (assetId: string) => Promise<unknown> = deleteTtsAudioAsset,
): Promise<TtsAudioAssetRow | undefined> {
  if (!asset) return undefined;
  try {
    await accessFile(ttsAssetFilePath(asset));
    return asset;
  } catch {
    await invalidateAsset(asset.id).catch(() => undefined);
    return undefined;
  }
}

/** A linked asset is ready only while its immutable file still exists. */
export async function getReadyMessageSpeechAsset(
  conversationId: string,
  messageId: string,
) {
  return validateLinkedTtsAsset(
    await getMessageSpeechAsset(conversationId, messageId),
  );
}

export async function listReadyMessageSpeechAssets(conversationId: string) {
  const linked = await listMessageSpeechAssets(conversationId);
  const validity = new Map<string, Promise<TtsAudioAssetRow | undefined>>();
  return (
    await Promise.all(
      linked.map(async (item) => {
        const pending =
          validity.get(item.asset.id) ?? validateLinkedTtsAsset(item.asset);
        validity.set(item.asset.id, pending);
        const asset = await pending;
        return asset ? { ...item, asset } : null;
      }),
    )
  ).filter(
    (item): item is { messageId: string; asset: TtsAudioAssetRow } =>
      item !== null,
  );
}

/**
 * Speaker id for a main agent that has no persona. It is not an AI user, so
 * `getAiUserRow` returns nothing and speech falls back to TTS_VOICE/TTS_LANG.
 */
export const MAIN_AGENT_SPEAKER_ID = '__main_agent__';

export interface PersonaSpeechInput {
  conversationId: string;
  messageId: string;
  projectId: string;
  text: string;
  speakerId: string;
  voice?: string | null;
  lang?: string | null;
  /** Canonical message fields used by Live queue snapshots for immediate UI rendering. */
  displayContent?: string;
  senderName?: string;
  createdAt?: string;
  emote?: string | null;
  telemetry?: Record<string, unknown> | null;
}

export async function resolvePersonaSpeechSource(
  conversationId: string,
  messageId: string,
  options?: PersonaSpeechSourceOptions,
): Promise<PersonaSpeechInput | null> {
  const sources = await resolvePersonaSpeechSources(
    conversationId,
    [messageId],
    options,
  );
  return sources.get(messageId) ?? null;
}

export interface PersonaSpeechSourceOptions {
  /**
   * Resolve non-persona assistant messages (a main agent without a persona)
   * to MAIN_AGENT_SPEAKER_ID. Only for callers whose message ids come from the
   * Live queue; other callers keep requiring a persona sender.
   */
  includeMainAgent?: boolean;
}

/**
 * Resolve several persona messages from one transcript read.
 *
 * Live queue snapshots contain every completed/hidden/current item for a run.
 * Keeping the transcript load outside the per-message loop is important for
 * continuous conversations: completed items grow monotonically, while queue
 * snapshots are published for every playback transition.
 */
export async function resolvePersonaSpeechSources(
  conversationId: string,
  messageIds: readonly string[],
  options?: PersonaSpeechSourceOptions,
): Promise<Map<string, PersonaSpeechInput>> {
  const wanted = new Set(messageIds);
  const sources = new Map<string, PersonaSpeechInput>();
  if (wanted.size === 0) return sources;
  const conversation = await getConversation(conversationId);
  if (!conversation) return sources;
  const raw: any[] = await readChatTranscriptAsync(
    conversation.group_folder,
    conversation.id,
    conversation.created_at ?? null,
  );
  const entries = formatTranscriptEntries(raw) as any[];
  for (const entry of entries) {
    // Live items use the provider message id; a run-archived (v1) message row
    // keeps its archive id and carries that id as canonicalMessageId.
    const id = [entry?.id, entry?.canonicalMessageId]
      .map((value) => String(value ?? ''))
      .find((value) => wanted.has(value));
    if (!id) continue;
    const sender = String(entry?.senderUserId || entry?.agent_name || '');
    const match = sender.match(/^ai(?::|-(?:main)?:)(.+)$/);
    const speakerId =
      match?.[1] || (options?.includeMainAgent ? MAIN_AGENT_SPEAKER_ID : '');
    // Attribution companions intentionally share the canonical message ID.
    // Resolve from the actual message row only; otherwise their empty content
    // replaces Markdown with the flattened speechText on Live queue release.
    if (entry?.type !== 'message' || entry?.role !== 'assistant' || !speakerId)
      continue;
    const text = String(entry.speechText || entry.content || '').trim();
    if (!text || text.length > 20_000) continue;
    sources.set(id, {
      conversationId,
      messageId: id,
      projectId: conversation.group_folder,
      text,
      speakerId,
      displayContent: String(entry.content ?? ''),
      senderName: String(entry.sender_name ?? ''),
      createdAt: String(entry.created_at ?? ''),
      emote: entry.emote ?? null,
      telemetry: entry.telemetry ?? null,
    });
  }
  return sources;
}

/**
 * Voice, language and normalized text for a message, shared by the server
 * voice and device voices. The language is the one the reply is written in
 * (Jev), falling back to the persona's, so neither reads an English reply
 * with a Romanian voice.
 */
export async function preparePersonaSpeechText(input: PersonaSpeechInput) {
  const aiUser = await getAiUserRow(input.speakerId);
  const voice = input.voice || aiUser?.voiceId || TTS_VOICE;
  const configured = input.lang || aiUser?.voiceLang || TTS_LANG;
  const lang =
    (await detectSpeechLanguage(
      input.text,
      [configured, TTS_LANG],
      input.projectId,
    )) ?? configured;
  const prepared = await prepareForTts(input.text, lang, input.projectId);
  const text = prepared.sentences.join(' ').trim() || input.text.trim();
  return { voice, lang, text };
}

const expressionTag = new RegExp(
  `\\s*<(?:${SUPERTONIC_EXPRESSIONS.join('|')})>\\s*`,
  'gi',
);

/**
 * Speech-ready text for a device's own TTS engine: the same normalized text
 * and language the server synthesizes, without Supertonic expression tags.
 */
export async function preparePersonaDeviceSpeechText(
  input: PersonaSpeechInput,
): Promise<{ text: string; language: string }> {
  const { lang, text } = await preparePersonaSpeechText(input);
  return {
    text: text
      .replace(expressionTag, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
    language: lang,
  };
}

export async function ensurePersonaMessageSpeech(input: PersonaSpeechInput) {
  const existing = await getReadyMessageSpeechAsset(
    input.conversationId,
    input.messageId,
  );
  if (existing) return existing;
  const key = `${input.conversationId}\u0000${input.messageId}`;
  return inFlight.run(key, async () => {
    const {
      voice,
      lang,
      text: preparedText,
    } = await preparePersonaSpeechText(input);
    const chunks = chunkForTts(preparedText, TTS_MAX_CHUNK_CHARS);
    const cached = await synthesizeChunksCached(chunks, {
      voice,
      lang,
      format: 'ogg',
    });
    if (!cached.assetId) return undefined;
    await linkMessageSpeechAsset({
      conversationId: input.conversationId,
      messageId: input.messageId,
      assetId: cached.assetId,
      speakerId: input.speakerId,
    });
    return getMessageSpeechAsset(input.conversationId, input.messageId);
  });
}
