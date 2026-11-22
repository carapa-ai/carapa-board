import { createSecretReader } from '../../lib/env.js';

const readSecret = createSecretReader();

// Whisper transcription endpoint. Override to use Groq:
//   WHISPER_API_URL=https://api.groq.com/openai/v1/audio/transcriptions
export const WHISPER_API_URL =
  process.env.WHISPER_API_URL ||
  'https://api.openai.com/v1/audio/transcriptions';

/** Voice capture is available when an endpoint was explicitly configured, or
 * when credentials make the default hosted endpoint usable. */

// Whisper model name (whisper-1 for OpenAI, whisper-large-v3 for Groq)
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';

// API key for Whisper transcription (OpenAI, Groq, or compatible).
// Not needed for local endpoints. Read from secrets or env.
export const WHISPER_API_KEY = readSecret('WHISPER_API_KEY', 'whisper_api_key');

export const WHISPER_CONFIGURED = Boolean(
  process.env.WHISPER_API_URL?.trim() || WHISPER_API_KEY,
);

// ISO-639-1 language hint (e.g. ro, en). Strongly recommended for meeting
// recordings — without it Whisper may hallucinate the wrong script on short clips.
export const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE?.trim() || '';

// Optional context prompt passed to Whisper (vocabulary/style priming).
export const WHISPER_PROMPT = process.env.WHISPER_PROMPT?.trim() || '';
