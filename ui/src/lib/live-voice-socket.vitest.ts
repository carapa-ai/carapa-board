import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  native: false,
  platform: 'web',
  vaultPopulate: vi.fn(),
}));

vi.mock('./api', () => ({ apiFetch: transport.apiFetch }));
vi.mock('./api-config', () => ({
  API_BASE_URL: 'https://api.example',
  HOME_URL: 'https://home.example',
  REMOTE_URL: 'https://remote.example',
  getServerConfigEpoch: () => 0,
}));
vi.mock('./session-vault', () => ({ vaultPopulate: transport.vaultPopulate }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => transport.native,
    getPlatform: () => transport.platform,
  },
}));

import { liveVoiceWebSocketUrl } from './live-voice-socket';

beforeEach(() => {
  vi.clearAllMocks();
  transport.native = false;
  transport.platform = 'web';
});

describe('liveVoiceWebSocketUrl authentication', () => {
  it('fetches a one-use ticket and appends its encoded value', async () => {
    transport.apiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'one use/+ticket=' }),
    });

    await expect(liveVoiceWebSocketUrl('/api/live-voice/ws')).resolves.toBe(
      'wss://api.example/api/live-voice/ws?ticket=one%20use%2F%2Bticket%3D',
    );
    expect(transport.apiFetch).toHaveBeenCalledOnce();
    expect(transport.apiFetch).toHaveBeenCalledWith(
      'https://api.example/api/ws-ticket',
      undefined,
      { allowRemoteRetry: false },
    );
  });

  it('rejects a failed ticket response', async () => {
    transport.apiFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(liveVoiceWebSocketUrl('/api/live-voice/ws')).rejects.toThrow(
      'Voice authentication failed',
    );
  });

  it('refreshes Android authentication before retrying ticket acquisition', async () => {
    transport.native = true;
    transport.platform = 'android';
    transport.apiFetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'refreshed-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ticket: 'android-ticket' }),
      });

    await expect(liveVoiceWebSocketUrl('/api/live-voice/ws')).resolves.toBe(
      'wss://api.example/api/live-voice/ws?ticket=android-ticket',
    );
    expect(transport.vaultPopulate).toHaveBeenCalledWith({
      authToken: 'refreshed-token',
    });
    expect(transport.apiFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.example/api/auth/token',
      { method: 'POST' },
      { allowRemoteRetry: false },
    );
  });
});
