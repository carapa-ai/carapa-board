// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
  HOME_URL,
  REMOTE_URL,
  apiBaseUrlForMode,
  buildServerLink,
  parseServerLink,
  parseServerUrl,
  remoteRetryUrl,
  remoteRetryUrlForEndpoints,
  resolveApiUrl,
} from './api-config';

describe('media API URL resolution', () => {
  test('adds the selected endpoint for a native connection', () => {
    expect(resolveApiUrl('/artifacts/project/images/result.png', 'home')).toBe(
      `${HOME_URL}/artifacts/project/images/result.png`,
    );
    expect(apiBaseUrlForMode('home')).toBe(HOME_URL);
  });

  test('retries only local requests against the remote endpoint', () => {
    const remoteUrl = 'https://board.example.test';
    expect(
      remoteRetryUrlForEndpoints(
        `${HOME_URL}/api/projects?limit=10`,
        HOME_URL,
        remoteUrl,
      ),
    ).toBe(`${remoteUrl}/api/projects?limit=10`);
    expect(
      remoteRetryUrlForEndpoints(remoteUrl, HOME_URL, remoteUrl),
    ).toBeNull();
    expect(
      remoteRetryUrlForEndpoints(
        'https://example.com/image.png',
        HOME_URL,
        remoteUrl,
      ),
    ).toBeNull();
  });

  test('does not retry when home is the only configured endpoint', () => {
    expect(
      remoteRetryUrlForEndpoints(
        `${HOME_URL}/api/projects`,
        HOME_URL,
        HOME_URL,
      ),
    ).toBeNull();
    expect(remoteRetryUrl(`${REMOTE_URL}/api/projects`)).toBeNull();
  });
});

describe('server URL validation', () => {
  test('normalises https origins', () => {
    expect(parseServerUrl(' https://Board.Example.com/ ')).toEqual({
      url: 'https://board.example.com',
    });
    expect(parseServerUrl('https://192.168.1.10:3000')).toEqual({
      url: 'https://192.168.1.10:3000',
    });
  });

  test.each([
    'http://board.example.com',
    'board.example.com',
    'https://user:pass@board.example.com',
    'https://board.example.com@evil.example',
    'https://board.example.com/api',
    'https://board.example.com?x=1',
    'https://board.example.com/#frag',
    'https://board.example.com\\evil',
    'https://',
    'https://board.example.com:99999',
  ])('rejects %s', (input) => {
    expect(parseServerUrl(input)).toHaveProperty('error');
  });
});

describe('server setup link', () => {
  const enc = encodeURIComponent;

  test('round-trips a built link and ignores unknown parameters', () => {
    const config = {
      homeUrl: 'https://192.168.1.10:3000',
      remoteUrl: 'https://board.example.com',
    };
    expect(parseServerLink(buildServerLink(config))).toEqual({ config });
    expect(
      parseServerLink(
        `carapaboard://server?v=1&x=1&remote=${enc('https://a.example')}`,
      ),
    ).toEqual({ config: { remoteUrl: 'https://a.example' } });
  });

  test.each([
    'carapaboard://server?home=' + enc('https://a.example'),
    'carapaboard://server?v=2&home=' + enc('https://a.example'),
    'carapaboard://server?v=1',
    'carapaboard://server?v=1&home=' + enc('http://a.example'),
    'carapaboard://server?v=1&home=' + enc('https://user:pw@a.example'),
    'carapaboard://server?v=1&remote=' + enc('https://a.example/path'),
    'carapaboard://other?v=1&home=' + enc('https://a.example'),
    'https://server?v=1&home=' + enc('https://a.example'),
  ])('rejects %s', (link) => {
    expect(parseServerLink(link)).toHaveProperty('error');
  });
});

describe('server link trust parameters', () => {
  const enc = encodeURIComponent;
  const cert = 'ab'.repeat(32);
  const key = Buffer.alloc(32, 7).toString('base64');
  const base = `carapaboard://server?v=1&home=${enc('https://a.example')}`;

  test('round-trips pins and the OTA key, normalising hex case', () => {
    const config = {
      homeUrl: 'https://a.example',
      remoteUrl: 'https://b.example',
      homeCertSha256: cert,
      remoteCertSha256: 'cd'.repeat(32),
      otaPublicKey: key,
    };
    expect(parseServerLink(buildServerLink(config))).toEqual({ config });
    expect(parseServerLink(`${base}&homeCert=${cert.toUpperCase()}`)).toEqual({
      config: { homeUrl: 'https://a.example', homeCertSha256: cert },
    });
  });

  test.each([
    ['short fingerprint', `&homeCert=${'ab'.repeat(31)}`],
    ['non-hex fingerprint', `&homeCert=${'zz'.repeat(32)}`],
    ['cert without its URL', `&remoteCert=${cert}`],
    ['short key', `&otaKey=${enc(Buffer.alloc(31).toString('base64'))}`],
    ['long key', `&otaKey=${enc(Buffer.alloc(33).toString('base64'))}`],
    ['bad base64', `&otaKey=${enc('!'.repeat(44))}`],
  ])('rejects %s', (_name, suffix) => {
    expect(parseServerLink(base + suffix)).toHaveProperty('error');
  });
});

describe('stored server config validation', () => {
  const cert = 'ab'.repeat(32);
  const key = Buffer.alloc(32, 7).toString('base64');

  async function readStored(stored: unknown) {
    // Fresh module instance: the config is read once at import time.
    globalThis.window = {} as any;
    globalThis.localStorage = {
      getItem: () => JSON.stringify(stored),
      setItem: () => undefined,
      removeItem: () => undefined,
    } as any;
    const { Capacitor } = await import('@capacitor/core');
    const original = Capacitor.isNativePlatform;
    Capacitor.isNativePlatform = () => true;
    try {
      const mod = await import(`./api-config?stored=${Math.random()}`);
      return mod.getServerConfig();
    } finally {
      Capacitor.isNativePlatform = original;
      delete (globalThis as any).window;
      delete (globalThis as any).localStorage;
    }
  }

  test('keeps valid values and drops malformed ones', async () => {
    expect(
      await readStored({
        homeUrl: 'https://a.example',
        homeCertSha256: cert,
        remoteCertSha256: 'abc',
        otaPublicKey: key,
      }),
    ).toEqual({
      homeUrl: 'https://a.example',
      homeCertSha256: cert,
      otaPublicKey: key,
    });
    expect(
      await readStored({
        homeUrl: 'https://a.example',
        remoteCertSha256: cert,
        otaPublicKey: 'not-base64',
      }),
    ).toEqual({ homeUrl: 'https://a.example' });
  });
});

const realCapacitor = await import('@capacitor/core');

describe('server configured on native', () => {
  const saved = {
    localIp: process.env.VITE_LOCAL_IP,
    apiUrl: process.env.VITE_API_URL,
  };
  let cases = 0;

  mock.module('@capacitor/core', () => ({
    ...realCapacitor,
    Capacitor: {
      ...realCapacitor.Capacitor,
      isNativePlatform: () => true,
    },
  }));

  // A fresh module instance reads the build-time variables and storage anew.
  async function load(
    env: { localIp?: string; apiUrl?: string },
    stored?: object,
  ) {
    for (const [key, value] of [
      ['VITE_LOCAL_IP', env.localIp],
      ['VITE_API_URL', env.apiUrl],
    ] as const) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
    Object.assign(globalThis, {
      window: {},
      localStorage: {
        getItem: (key: string) =>
          key === 'carapa-server-config' && stored
            ? JSON.stringify(stored)
            : null,
        setItem: () => {},
        removeItem: () => {},
      },
    });
    return import(`./api-config?configured-${cases++}`);
  }

  afterAll(() => {
    for (const [key, value] of [
      ['VITE_LOCAL_IP', saved.localIp],
      ['VITE_API_URL', saved.apiUrl],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete globalThis.window;
    delete globalThis.localStorage;
    mock.restore();
  });

  test('is false without defaults or a stored address, and builds no URL', async () => {
    const config = await load({});
    expect(config.isServerConfigured()).toBe(false);
    expect(config.LOCAL_IP).toBe('');
    expect(config.resolveServerUrls({})).toEqual({
      homeUrl: '',
      remoteUrl: '',
    });
    expect(config.HOME_URL).toBe('');
    expect(config.REMOTE_URL).toBe('');
  });

  test('is true with a stored home URL', async () => {
    const config = await load({}, { homeUrl: 'https://a.example' });
    expect(config.isServerConfigured()).toBe(true);
    expect(config.REMOTE_URL).toBe('https://a.example');
  });

  test('is true with a build-time remote default', async () => {
    const config = await load({ apiUrl: 'https://board.example' });
    expect(config.isServerConfigured()).toBe(true);
    expect(config.HOME_URL).toBe('https://board.example');
  });

  test('is true with a build-time LAN default', async () => {
    const config = await load({ localIp: '10.0.0.5' });
    expect(config.isServerConfigured()).toBe(true);
    expect(config.resolveServerUrls({}).remoteUrl).toBe(
      'https://10.0.0.5:3000',
    );
  });
});
