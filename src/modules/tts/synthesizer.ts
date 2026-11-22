/**
 * Supertonic TTS client. Calls the native `/v1/tts` endpoint of the
 * `supertonic serve` container and returns audio bytes + duration.
 *
 * `synthesizeStream` provides pseudo-streaming: it sentence-chunks the text and
 * invokes `onChunk` as each chunk finishes synthesizing.
 */

import { logger } from '../../logger.js';
import {
  TTS_API_URL,
  TTS_VOICE,
  TTS_LANG,
  TTS_STEPS,
  TTS_SPEED,
  TTS_FORMAT,
  TTS_TIMEOUT_MS,
  TTS_MAX_CHUNK_CHARS,
  type TtsFormat,
} from './config.js';
import { chunkForTts } from './chunker.js';
import { ensurePersonaVoice } from './voice-styles.js';

export interface SynthOptions {
  voice?: string;
  lang?: string;
  steps?: number;
  speed?: number;
  format?: TtsFormat;
}

export interface SynthResult {
  audio: Buffer;
  format: TtsFormat;
  durationMs: number;
  sampleRate: number;
  usedFallbackVoice?: boolean;
}

const MIME: Record<TtsFormat, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
};

export function formatToMime(fmt: TtsFormat): string {
  return MIME[fmt] ?? 'application/octet-stream';
}

const SPOKEN_SYMBOLS: Record<string, string> = {
  '\u2265': ' >= ',
  '\u2264': ' <= ',
  '\u2260': ' != ',
  '\u2192': ' -> ',
  '\u21D2': ' -> ',
  '\u2190': ' <- ',
  '\u2194': ' <-> ',
  '\u2208': ' in ',
  '\u00D7': ' x ',
  '\u2248': ' ~ ',
};
const SPOKEN_SYMBOLS_RE = new RegExp(
  `[${Object.keys(SPOKEN_SYMBOLS).join('')}]`,
  'g',
);

/**
 * Supertonic accepts ordinary language characters but rejects several common
 * typographic punctuation code points. Normalize them at the provider boundary
 * so every caller (Live replies, play buttons, and streaming TTS) is safe even
 * when the optional LLM preparation pass preserves smart quotes.
 */
export function normalizeTtsPunctuation(text: string): string {
  return text
    .replace(SPOKEN_SYMBOLS_RE, (ch) => SPOKEN_SYMBOLS[ch])
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF\uFE0E\uFE0F]/g, '');
}

async function requestSynthesis(
  text: string,
  opts: SynthOptions,
  voice: string,
): Promise<SynthResult> {
  const format = opts.format ?? TTS_FORMAT;
  const body = {
    text: normalizeTtsPunctuation(text),
    voice,
    lang: opts.lang ?? TTS_LANG,
    steps: opts.steps ?? TTS_STEPS,
    speed: opts.speed ?? TTS_SPEED,
    response_format: format,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${TTS_API_URL}/v1/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text();
      const error = new Error(`TTS ${res.status}: ${detail.slice(0, 300)}`);
      Object.assign(error, { status: res.status, detail });
      throw error;
    }

    const audio = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round(
      parseFloat(res.headers.get('X-Audio-Duration') || '0') * 1000,
    );
    const sampleRate = parseInt(
      res.headers.get('X-Sample-Rate') || '44100',
      10,
    );
    return { audio, format, durationMs, sampleRate };
  } finally {
    clearTimeout(timer);
  }
}

const UNSUPPORTED_CHARS_RE = /unsupported character\(s\):\s*\[([^\]]*)\]/i;

/** Parse the provider's `[U+2265, ...]` list (code points or literal characters). */
function parseUnsupportedChars(error: any): string[] {
  const message = String(error?.detail || error?.message || '');
  const list = UNSUPPORTED_CHARS_RE.exec(message)?.[1];
  if (!list) return [];
  const chars: string[] = [];
  for (const token of list.split(/[\s,]+/).filter(Boolean)) {
    const cp = /^U\+([0-9a-f]{4,6})$/i.exec(token);
    if (!cp) {
      chars.push(...Array.from(token));
    } else if (parseInt(cp[1], 16) <= 0x10ffff) {
      chars.push(String.fromCodePoint(parseInt(cp[1], 16)));
    }
  }
  return chars;
}

/**
 * Request synthesis; when the provider rejects specific characters, strip
 * exactly those characters and retry once instead of failing the whole reply.
 */
async function requestSynthesisStrippingUnsupported(
  text: string,
  opts: SynthOptions,
  voice: string,
): Promise<SynthResult> {
  try {
    return await requestSynthesis(text, opts, voice);
  } catch (error: any) {
    const rejected = parseUnsupportedChars(error);
    const normalized = normalizeTtsPunctuation(text);
    const stripped = rejected
      .reduce((acc, ch) => acc.split(ch).join(' '), normalized)
      .replace(/ {2,}/g, ' ')
      .trim();
    if (!rejected.length || !stripped || stripped === normalized.trim()) {
      throw error;
    }
    logger.warn(
      { rejected },
      'TTS provider rejected characters; retrying without them',
    );
    try {
      return await requestSynthesis(stripped, opts, voice);
    } catch {
      throw error;
    }
  }
}

/** Synthesize a single text via the native `/v1/tts` endpoint. */
export async function synthesize(
  text: string,
  opts: SynthOptions = {},
): Promise<SynthResult> {
  const requestedVoice = opts.voice ?? TTS_VOICE;
  try {
    return await requestSynthesisStrippingUnsupported(
      text,
      opts,
      requestedVoice,
    );
  } catch (error: any) {
    const unknownVoice =
      error?.status === 400 &&
      /unknown_voice|unknown voice/i.test(
        String(error?.detail || error?.message),
      );
    if (!unknownVoice || !requestedVoice.startsWith('ai-user-')) throw error;
    if (await ensurePersonaVoice(requestedVoice, true)) {
      try {
        return await requestSynthesisStrippingUnsupported(
          text,
          opts,
          requestedVoice,
        );
      } catch {
        /* fall back below */
      }
    }
    logger.warn(
      { requestedVoice, fallbackVoice: TTS_VOICE },
      'Persona voice unavailable; using global TTS voice',
    );
    const result = await requestSynthesisStrippingUnsupported(
      text,
      opts,
      TTS_VOICE,
    );
    return { ...result, usedFallbackVoice: true };
  }
}

export interface SynthChunk {
  index: number;
  total: number;
  text: string;
  audioBase64: string;
  format: TtsFormat;
  durationMs: number;
  last: boolean;
}

/**
 * Pseudo-streaming: sentence-chunk the text, synthesize each chunk sequentially,
 * and invoke `onChunk` as each is ready. Returns the number of chunks emitted.
 */
export async function synthesizeStream(
  text: string,
  opts: SynthOptions & { maxChunkChars?: number },
  onChunk: (chunk: SynthChunk) => Promise<void> | void,
): Promise<number> {
  const chunks = chunkForTts(text, opts.maxChunkChars ?? TTS_MAX_CHUNK_CHARS);
  for (let i = 0; i < chunks.length; i++) {
    const r = await synthesize(chunks[i], opts);
    await onChunk({
      index: i,
      total: chunks.length,
      text: chunks[i],
      audioBase64: r.audio.toString('base64'),
      format: r.format,
      durationMs: r.durationMs,
      last: i === chunks.length - 1,
    });
  }
  return chunks.length;
}
