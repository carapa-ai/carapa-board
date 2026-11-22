import {
  WHISPER_LANGUAGE,
  WHISPER_MODEL,
  WHISPER_PROMPT,
} from '../whisper/config.js';

/** Configuration for the authenticated browser -> Board -> local STT stream. */
export const LIVE_STT_PROTOCOL = 'carapa.live-stt.v2';
export const LIVE_STT_API_URL = process.env.LIVE_STT_API_URL?.trim() || '';
export const LIVE_STT_MODEL =
  process.env.LIVE_STT_MODEL?.trim() || WHISPER_MODEL;
export const LIVE_STT_LANGUAGE =
  process.env.LIVE_STT_LANGUAGE?.trim() || WHISPER_LANGUAGE;
export const LIVE_STT_PROMPT =
  process.env.LIVE_STT_PROMPT?.trim() || WHISPER_PROMPT;

export const LIVE_STT_SAMPLE_RATE = 16_000;
export const LIVE_STT_MAX_UTTERANCE_MS = 15_000;
export const LIVE_STT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const LIVE_STT_MAX_PENDING_UTTERANCES = 4;
export const LIVE_STT_FINAL_TIMEOUT_MS = 10_000;
