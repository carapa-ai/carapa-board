/**
 * Audio transcription via OpenAI Whisper (or compatible endpoint like Groq).
 */

import {
  WHISPER_API_URL,
  WHISPER_MODEL,
  WHISPER_API_KEY,
  WHISPER_LANGUAGE,
  WHISPER_PROMPT,
} from './config.js';

/** Derive a reasonable file extension from a mimetype. */
function extFromMimetype(mimetype: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  };
  return map[mimetype] ?? mimetype.split('/').pop() ?? 'bin';
}

/**
 * Transcribe an audio buffer using the Whisper API.
 * Compatible with OpenAI and Groq endpoints.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimetype: string,
  filename?: string,
  options?: { language?: string | null; prompt?: string },
): Promise<string> {
  const ext = extFromMimetype(mimetype);
  const effectiveFilename = filename || `audio.${ext}`;

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(buffer)], { type: mimetype }),
    effectiveFilename,
  );
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'text');
  const language =
    options?.language === undefined ? WHISPER_LANGUAGE : options.language;
  const prompt = options?.prompt || WHISPER_PROMPT;
  if (language) {
    form.append('language', language);
  }
  if (prompt) {
    form.append('prompt', prompt);
  }

  const headers: Record<string, string> = {};
  if (WHISPER_API_KEY) {
    headers['Authorization'] = `Bearer ${WHISPER_API_KEY}`;
  }

  const res = await fetch(WHISPER_API_URL, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Whisper API error ${res.status}: ${body}`);
  }

  return (await res.text()).trim();
}
