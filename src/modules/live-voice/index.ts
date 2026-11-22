/** Continuous Live Mode voice input. The browser streams PCM to Board over an
 * authenticated WebSocket; browser-detected phrases go directly to the warm
 * GPU transcription endpoint and return as stable finals. */
import type { CarapaModule } from '../types.js';
import { WHISPER_CONFIGURED, WHISPER_MODEL } from '../whisper/config.js';
import { getLiveVoiceRouter } from './routes.js';
import { LIVE_STT_API_URL, LIVE_STT_MODEL } from './config.js';
import { closeLiveVoiceWebSocketServer } from './streaming.js';

const liveVoiceModule: CarapaModule = {
  name: 'live-voice',
  // The route also provides the calm text-only fallback, so it must exist even
  // when transcription itself is not configured.
  isEnabled: () => true,
  getRouter: () => getLiveVoiceRouter(),
  shutdown: async () => closeLiveVoiceWebSocketServer(),
  getConfigFlags: () => ({
    liveVoiceEnabled: true,
    liveVoiceTranscriptionConfigured: WHISPER_CONFIGURED,
    liveVoiceStreamingConfigured: Boolean(LIVE_STT_API_URL),
    liveVoiceModel: LIVE_STT_API_URL ? LIVE_STT_MODEL : WHISPER_MODEL,
  }),
};

export default liveVoiceModule;
