import { Capacitor } from '@capacitor/core';
import { apiFetch } from './api';
import { API_BASE_URL } from './api-config';
import { vaultPopulate } from './session-vault';
import {
  authenticatedLiveVoiceWebSocketUrl,
  type LiveVoiceTransport,
} from './live-voice-socket-core';

export { liveVoiceWebSocketBaseUrl } from './websocket-url';
export { authenticatedLiveVoiceWebSocketUrl } from './live-voice-socket-core';

/** Live Voice follows the active API connection mode for its secure WebSocket. */
export async function liveVoiceWebSocketUrl(path: string): Promise<string> {
  // Snapshot before the first await: mode changes create a new socket attempt
  // and must not pair this attempt's socket URL with another board's ticket.
  const httpBase = API_BASE_URL;
  const transport: LiveVoiceTransport = {
    apiFetch,
    isAndroid: () =>
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
    populateVault: vaultPopulate,
  };
  return authenticatedLiveVoiceWebSocketUrl(path, httpBase, transport);
}
