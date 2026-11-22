// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { authenticatedLiveVoiceWebSocketUrl } from './live-voice-socket-core';

// Fixed origin: the build-time default is empty without a gitignored .env.
const homeOrigin = 'https://192.0.2.10:3000';

describe('native WebSocket origins', () => {
  test('live voice keeps its ticket and socket paired during a mode transition', async () => {
    const requests: string[] = [];
    const requestOptions: unknown[] = [];
    let requestCount = 0;
    let activeMode = 'home';
    const url = await authenticatedLiveVoiceWebSocketUrl(
      '/api/live-voice',
      homeOrigin,
      {
        apiFetch: async (requestUrl, _init, options) => {
          requests.push(requestUrl);
          requestOptions.push(options);
          requestCount += 1;
          if (requestCount === 1) {
            // Simulate detection switching to Remote while the first ticket
            // request is in flight. This attempt must retain Home throughout.
            activeMode = 'remote';
            return { status: 401, ok: false } as Response;
          }
          if (requestCount === 2) {
            return {
              ok: true,
              json: async () => ({ token: 'refreshed-token' }),
            } as Response;
          }
          return {
            ok: true,
            json: async () => ({ ticket: 'home-ticket' }),
          } as Response;
        },
        isAndroid: () => true,
        populateVault: () => {},
      },
    );

    expect(requests).toEqual([
      `${homeOrigin}/api/ws-ticket`,
      `${homeOrigin}/api/auth/token`,
      `${homeOrigin}/api/ws-ticket`,
    ]);
    expect(requestOptions).toEqual([
      { allowRemoteRetry: false },
      { allowRemoteRetry: false },
      { allowRemoteRetry: false },
    ]);
    expect(url).toBe(
      `${homeOrigin.replace(/^http/, 'ws')}/api/live-voice?ticket=home-ticket`,
    );
    expect(activeMode).toBe('remote');
  });
});
