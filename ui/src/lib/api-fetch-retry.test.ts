// @ts-nocheck
import { afterAll, describe, expect, mock, test } from 'bun:test';

const requests: string[] = [];
const nativeOptions: Array<{
  url: string;
  method?: string;
  responseType?: string;
}> = [];
let nativePlatform = false;
const previousRemoteUrl = process.env.VITE_API_URL;
const previousLocalIp = process.env.VITE_LOCAL_IP;
// Home must differ from Remote regardless of the checkout's gitignored ui/.env
// (absent in the Docker CI build); equal endpoints disable the failover.
process.env.VITE_API_URL = 'https://remote.board.test';
process.env.VITE_LOCAL_IP = '192.0.2.10';

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  window: {
    location: {
      protocol: 'https:',
      host: 'board.test',
      hostname: 'board.test',
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

mock.module('@capacitor/core', () => ({
  WebPlugin: class {},
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => 'android',
    isPluginAvailable: () => false,
  },
  CapacitorHttp: {
    request: async ({
      url,
      method,
      responseType,
    }: {
      url: string;
      method?: string;
      responseType?: string;
    }) => {
      requests.push(url);
      nativeOptions.push({ url, method, responseType });
      if (url.includes('/api/users/user-json'))
        return { status: 200, data: { ok: true }, headers: {} };
      if (url.includes('/api/users/user-avatar/avatar'))
        return {
          status: 200,
          data: 'iVBORw==',
          headers: { 'content-type': 'image/png' },
        };
      return { status: 503, data: '', headers: {} };
    },
  },
  registerPlugin: () => ({}),
}));

const { HOME_URL, REMOTE_URL } = await import('./api-config');
const { updateUserAccount, apiFetch } = await import('./api');
nativePlatform = true;

afterAll(() => {
  if (previousRemoteUrl === undefined) delete process.env.VITE_API_URL;
  else process.env.VITE_API_URL = previousRemoteUrl;
  if (previousLocalIp === undefined) delete process.env.VITE_LOCAL_IP;
  else process.env.VITE_LOCAL_IP = previousLocalIp;
  mock.restore();
});

describe('apiFetch remote retry', () => {
  test('does not fail over a pinned WebSocket authentication request', async () => {
    requests.length = 0;
    const response = await apiFetch(`${HOME_URL}/api/ws-ticket`, undefined, {
      allowRemoteRetry: false,
    });

    expect(response.status).toBe(503);
    expect(requests).toEqual([`${HOME_URL}/api/ws-ticket`]);
  });

  test('retains normal Home-to-Remote failover for ordinary requests', async () => {
    requests.length = 0;
    const response = await apiFetch(`${HOME_URL}/api/projects`);

    expect(response.status).toBe(503);
    expect(requests).toEqual([
      `${HOME_URL}/api/projects`,
      `${REMOTE_URL}/api/projects`,
    ]);
  });

  test('keeps user JSON mutations textual while avatar reads stay binary', async () => {
    nativeOptions.length = 0;
    await expect(
      updateUserAccount('user-json', { disabled: true }),
    ).resolves.toEqual({ ok: true });
    await apiFetch(`${HOME_URL}/api/users/user-avatar/avatar?v=1`);
    await apiFetch(`${HOME_URL}/api/ai-users/persona/avatar?thumbnail=1`);
    await apiFetch(`${HOME_URL}/api/account/avatar/candidate?v=1`);
    await apiFetch(`${HOME_URL}/api/account/avatar/candidate`, {
      method: 'POST',
      body: JSON.stringify({ choice: 'candidate' }),
    });
    expect(
      nativeOptions.find((option) =>
        option.url.includes('/api/users/user-json'),
      ),
    ).toMatchObject({ method: 'PATCH', responseType: 'text' });
    expect(
      nativeOptions.find((option) =>
        option.url.includes('/api/users/user-avatar/avatar'),
      ),
    ).toMatchObject({ method: 'GET', responseType: 'arraybuffer' });
    expect(
      nativeOptions.find((option) =>
        option.url.includes('/api/ai-users/persona/avatar'),
      ),
    ).toMatchObject({ method: 'GET', responseType: 'arraybuffer' });
    expect(
      nativeOptions.find((option) =>
        option.url.includes('/api/account/avatar/candidate'),
      ),
    ).toMatchObject({ method: 'GET', responseType: 'arraybuffer' });
    expect(
      nativeOptions.find(
        (option) =>
          option.url.includes('/api/account/avatar/candidate') &&
          option.method === 'POST',
      ),
    ).toMatchObject({ method: 'POST', responseType: 'text' });
  });
});
