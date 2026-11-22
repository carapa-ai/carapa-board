/**
 * TTS module — text-to-speech via the Supertonic 3 service (self-hosted).
 *
 * Exposes /api/tts/synthesize (one-shot audio) and /api/tts/stream (pseudo-
 * streaming NDJSON) for the board UI / Android app. Enabled by default; set
 * ENABLE_TTS=false to disable.
 */

import type { CarapaModule } from '../types.js';
import {
  ENABLE_TTS,
  TTS_MODEL,
  TTS_VOICE,
  TTS_LANG,
  TTS_FORMAT,
  ENABLE_TTS_EXPRESSIONS,
} from './config.js';
import { getTtsRouter } from './routes.js';
import { syncPersonaVoiceStyles } from './voice-styles.js';
import { sweepTtsCache } from './cache.js';

const ttsModule: CarapaModule = {
  name: 'tts',

  isEnabled() {
    return ENABLE_TTS;
  },

  async init() {
    await syncPersonaVoiceStyles().catch(() => undefined);
    await sweepTtsCache().catch(() => undefined);
    const timer = setInterval(
      () => void sweepTtsCache().catch(() => undefined),
      24 * 60 * 60 * 1000,
    );
    timer.unref?.();
  },

  getRouter() {
    return getTtsRouter();
  },

  // Surfaced via GET /api/config so the UI/app knows TTS is available + defaults.
  getConfigFlags() {
    return {
      ttsEnabled: ENABLE_TTS,
      ttsModel: TTS_MODEL,
      ttsVoice: TTS_VOICE,
      ttsLang: TTS_LANG,
      ttsFormat: TTS_FORMAT,
      ttsExpressionsEnabled: ENABLE_TTS_EXPRESSIONS,
    };
  },
};

export default ttsModule;
