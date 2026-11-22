/**
 * TTS module configuration — talks to the `supertonic serve` container
 * (self-hosted). No API key: it's a local service reached over the
 * internal Docker network, mirroring how the whisper module is configured.
 */

import { parseBooleanEnv } from '../../lib/env.js';

export type TtsFormat = 'wav' | 'flac' | 'ogg';

export const TTS_FORMATS: TtsFormat[] = ['wav', 'flac', 'ogg'];

function intEnv(name: string, def: number, min: number, max: number): number {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function floatEnv(name: string, def: number, min: number, max: number): number {
  const n = parseFloat(process.env[name] || '');
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Enabled unless explicitly disabled (set ENABLE_TTS=false / 0 to turn off).
export const ENABLE_TTS = parseBooleanEnv(process.env.ENABLE_TTS, true);

// LLM normalization pass before synthesis (numbers→words, currency estimates,
// abbreviation expansion, sentence segmentation — in the target language).
// On by default; set ENABLE_TTS_NORMALIZE=false to use plain sentence splitting.
export const ENABLE_TTS_NORMALIZE = parseBooleanEnv(
  process.env.ENABLE_TTS_NORMALIZE,
  true,
);

export const ENABLE_TTS_EXPRESSIONS = parseBooleanEnv(
  process.env.ENABLE_TTS_EXPRESSIONS,
  true,
);

// Supertonic 3's complete published inline expression vocabulary. Model
// quality varies by language; upstream reports the most reliable behavior in
// English, Japanese, and Korean.
export const SUPERTONIC_EXPRESSIONS = [
  'laugh',
  'breath',
  'surprise',
  'sigh',
  'scream',
  'throatclear',
  'sad',
  'angry',
  'cough',
  'yawn',
] as const;

// Base URL of the `supertonic serve` container (native /v1/tts + OpenAI alias).
export const TTS_API_URL = (
  process.env.TTS_API_URL || 'http://supertonic:7788'
).replace(/\/+$/, '');

// Must match the model the server loaded (used by the OpenAI-compatible alias;
// the native /v1/tts endpoint ignores it).
export const TTS_MODEL = process.env.TTS_MODEL || 'supertonic-3';

export const TTS_VOICE = process.env.TTS_VOICE || 'M1';
export const TTS_LANG = process.env.TTS_LANG || 'en';

// Languages Jev may detect a text in, so the voice (server or device) speaks
// the text's own language (comma-separated base codes). The persona's language
// and TTS_LANG are always candidates; codes Supertonic cannot speak are
// ignored. Jev rejects a choice with ~25+ labels, so at most 20 are used.
export const TTS_DETECT_LANGUAGES = (
  process.env.TTS_DETECT_LANGUAGES ||
  'en,ro,de,fr,es,it,pt,nl,pl,ru,uk,hu,cs,bg,el,sv,tr'
)
  .split(',')
  .map((code) => code.trim().toLowerCase())
  .filter(Boolean);
export const SUPERTONIC_LANGUAGES = [
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fi',
  'fr',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'na',
  'nl',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'vi',
] as const;
export const TTS_STEPS = intEnv('TTS_STEPS', 10, 1, 100); // denoising steps (quality vs latency)
export const TTS_SPEED = floatEnv('TTS_SPEED', 1.05, 0.7, 2.0);
export const TTS_FORMAT: TtsFormat = (() => {
  const v = (process.env.TTS_FORMAT || 'ogg').toLowerCase();
  return (TTS_FORMATS as string[]).includes(v) ? (v as TtsFormat) : 'ogg';
})();

// Sentence-chunk size for pseudo-streaming. Input is assumed already normalized.
export const TTS_MAX_CHUNK_CHARS = intEnv('TTS_MAX_CHUNK_CHARS', 240, 40, 2000);

// Supertonic can take longer than 30 seconds when a persona clip and Work Live
// narration arrive together. Aborting at 30 seconds discards otherwise valid
// audio and leaves both Live Mode variants silent. Keep the limit bounded but
// allow the local engine to drain its queue.
export const TTS_TIMEOUT_MS = intEnv('TTS_TIMEOUT_MS', 90000, 1000, 600000);

// Bump when an engine deployment changes output without changing TTS_MODEL.
export const TTS_CACHE_REVISION =
  process.env.TTS_CACHE_REVISION || `${TTS_MODEL}:1`;
export const TTS_CACHE_TRANSIENT_TTL_DAYS = intEnv(
  'TTS_CACHE_TRANSIENT_TTL_DAYS',
  7,
  1,
  3650,
);
export const TTS_CACHE_MAX_BYTES = intEnv(
  'TTS_CACHE_MAX_BYTES',
  2 * 1024 * 1024 * 1024,
  16 * 1024 * 1024,
  20 * 1024 * 1024 * 1024,
);
