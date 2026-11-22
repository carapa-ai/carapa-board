import path from 'path';
import { readAttachmentFile } from './attachment-file.js';
import type OpenAI from 'openai';
import { convertAudioToWav } from './meeting-audio.js';
import { logger } from '../logger.js';
import type { ChatMessageAttachment } from '../modules/chat/types.js';

const EXT_FROM_MIME: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
};

function baseMimetype(mimetype: string, fallback = ''): string {
  return mimetype.split(';')[0]?.trim().toLowerCase() || fallback;
}

function extensionForBaseMimetype(base: string): string {
  return EXT_FROM_MIME[base] ?? base.split('/').pop() ?? 'bin';
}

export function isValidWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

export function isOllamaBackend(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  const u = baseUrl.toLowerCase();
  return u.includes(':11434') || u.includes('/ollama');
}

/** Strip `/v1` suffix to reach Ollama native `/api/*` routes. */
function ollamaApiOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

export interface PreparedAudioForLlm {
  buffer: Buffer;
  format: string;
  mimetype: string;
}

/**
 * Normalize audio for native LLM input. Always converts to 16 kHz mono WAV
 * (required by Ollama/Gemma4 — RIFF header + correct sample rate).
 */
export async function prepareAudioBufferForLlm(
  input: Buffer,
  mimetype: string,
  filename?: string,
): Promise<PreparedAudioForLlm | null> {
  const baseMime = baseMimetype(mimetype, 'audio/webm');
  const ext =
    filename && path.extname(filename).length > 1
      ? path.extname(filename).slice(1).toLowerCase()
      : extensionForBaseMimetype(baseMime);

  const wav = await convertAudioToWav(input, ext);
  if (!wav || !isValidWavBuffer(wav)) {
    logger.warn(
      { mimetype: baseMime, ext, filename, size: input.length },
      'Failed to convert audio to 16kHz mono WAV for LLM',
    );
    return null;
  }

  return { buffer: wav, format: 'wav', mimetype: 'audio/wav' };
}

/** Read attachments and return base64 WAV strings for Ollama `images[]`. */
export async function readOllamaAudioImages(
  attachments: ChatMessageAttachment[],
): Promise<string[]> {
  const images: string[] = [];
  for (const att of attachments) {
    if (att.type !== 'audio' || !att.path) continue;
    try {
      const raw = await readAttachmentFile(att.path);
      const prepared = await prepareAudioBufferForLlm(
        raw,
        att.mimetype,
        att.filename,
      );
      if (prepared) {
        images.push(prepared.buffer.toString('base64'));
      }
    } catch (err) {
      logger.warn({ err, path: att.path }, 'Failed to read audio for Ollama');
    }
  }
  return images;
}

/**
 * Ollama/Gemma4 user message: string content + WAV base64 in `images[]`.
 * Audio must NOT be sent via image_url / input_audio content parts.
 */
export function buildOllamaAudioUserMessage(
  text: string,
  audioBase64: string[],
): Record<string, unknown> {
  return {
    role: 'user',
    content: text || '[Voice message]',
    images: audioBase64,
  };
}

/**
 * Build an OpenAI-compatible content part for non-Ollama audio backends.
 */
export function buildAudioContentPart(
  prepared: PreparedAudioForLlm,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  return {
    type: 'input_audio' as any,
    input_audio: {
      data: prepared.buffer.toString('base64'),
      format: prepared.format,
    },
  } as any;
}

/** Extra request knobs for stable Ollama/Gemma4 audio inference. */
export function ollamaAudioExtraBody(
  baseUrl: string | undefined,
  extra_body?: Record<string, unknown>,
): Record<string, unknown> {
  if (!isOllamaBackend(baseUrl)) return { ...(extra_body ?? {}) };
  const chatTemplate = {
    ...((extra_body?.chat_template_kwargs as Record<string, unknown>) ?? {}),
    enable_thinking: false,
    think: false,
  };
  return {
    ...(extra_body ?? {}),
    think: false,
    num_ctx: 8192,
    chat_template_kwargs: chatTemplate,
  };
}

export interface OllamaNativeChatOptions {
  baseUrl: string;
  model: string;
  messages: Array<{ role: string; content: string; images?: string[] }>;
  think?: boolean;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Non-streaming call to Ollama `/api/chat` (native audio via `images[]`). */
export async function ollamaNativeChat(
  params: OllamaNativeChatOptions,
): Promise<string> {
  const origin = ollamaApiOrigin(params.baseUrl);
  const res = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: false,
      think: params.think ?? false,
      options: params.options,
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama chat failed: ${res.status} ${errText}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() ?? '';
}
