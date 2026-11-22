// @ts-nocheck
import { afterAll, describe, expect, mock, test } from 'bun:test';

let nativePlatform = false;
const sent: Array<{ url: string; headers: Record<string, string> }> = [];
const previousRemoteUrl = process.env.VITE_API_URL;
process.env.VITE_API_URL = 'https://remote.board.test';

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => (key === 'auth_token' ? 'board-token' : null),
    setItem: () => {},
    removeItem: () => {},
  },
  window: {
    location: {
      protocol: 'https:',
      host: 'board.test',
      hostname: 'board.test',
      origin: 'https://board.test',
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
      headers,
    }: {
      url: string;
      headers: Record<string, string>;
    }) => {
      sent.push({ url, headers });
      return { status: 200, data: '', headers: {} };
    },
  },
  registerPlugin: () => ({}),
}));

const realPushBridge = await import('./push-bridge');
mock.module('./push-bridge', () => ({
  ...realPushBridge,
  nativeSignPayload: async () => ({
    signature: 'signature',
    deviceId: 'device-1',
  }),
}));

const { HOME_URL } = await import('./api-config');
const { apiFetch } = await import('./api');
nativePlatform = true;

afterAll(() => {
  if (previousRemoteUrl === undefined) delete process.env.VITE_API_URL;
  else process.env.VITE_API_URL = previousRemoteUrl;
  mock.restore();
});

async function headersFor(url: string): Promise<Record<string, string>> {
  sent.length = 0;
  await apiFetch(url);
  expect(sent.map((request) => request.url)).toEqual([url]);
  return Object.fromEntries(
    Object.entries(sent[0].headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

describe('apiFetch credential origin', () => {
  test.each([
    'https://attacker.example/p.png',
    `${new URL(HOME_URL).protocol}//${new URL(HOME_URL).host}.attacker.example/p.png`,
    '//attacker.example/p.png',
    'not a url',
  ])('sends no board credentials to %s', async (url) => {
    const headers = await headersFor(url);
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-carapa-signature']).toBeUndefined();
    expect(headers['x-carapa-device-id']).toBeUndefined();
  });

  test.each([`${HOME_URL}/api/projects`, '/api/projects'])(
    'keeps board credentials for %s',
    async (url) => {
      const headers = await headersFor(url);
      expect(headers.authorization).toBe('Bearer board-token');
      expect(headers['x-carapa-signature']).toBe('signature');
    },
  );
});
