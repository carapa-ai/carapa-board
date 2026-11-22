/**
 * Whisper module — optional audio transcription for incoming messages.
 *
 * When enabled, enrichMessageContent() in media-processor.ts uses the
 * transcriber to convert voice messages to text. When disabled, audio
 * attachments get a placeholder instead.
 */

import type { CarapaModule } from '../types.js';
import { transcribeAudio } from './transcriber.js';
import { WHISPER_CONFIGURED } from './config.js';

export type TranscribeOptions = {
  /** null explicitly suppresses the configured Whisper default. */
  language?: string | null;
  prompt?: string;
};

export type Transcriber = (
  buffer: Buffer,
  mimetype: string,
  filename?: string,
  options?: TranscribeOptions,
) => Promise<string>;

let transcriber: Transcriber | null = null;

/** Get the active transcriber, or null when whisper module is disabled. */
export function getTranscriber(): Transcriber | null {
  return transcriber;
}

const whisperModule: CarapaModule = {
  name: 'whisper',

  isEnabled() {
    return WHISPER_CONFIGURED;
  },

  async init() {
    transcriber = WHISPER_CONFIGURED ? transcribeAudio : null;
  },

  async shutdown() {
    transcriber = null;
  },
};

export default whisperModule;
