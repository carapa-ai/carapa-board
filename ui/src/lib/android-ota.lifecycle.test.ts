// @ts-nocheck
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import nacl from 'tweetnacl';

// This suite replaces globalThis.fetch in beforeEach (see below). Bun test
// files share one process in a full `bun test` run, so the replacement must
// be restored: later suites (e.g. the browser harnesses that poll a real
// Vite port with fetch) would otherwise see a mock that answers 200 for
// everything and proceed before their dev server is up.
const originalGlobalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};
afterAll(() => {
  globalThis.fetch = originalGlobalFetch;
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
});

const state = {
  shell: {
    nativeVersionCode: 3,
    nativeVersionName: '1.0-test',
    builtinBundleVersion: 'b'.repeat(24),
    builtinBundleGeneration: 5,
    publicKey: '',
  },
  manifest: null as Record<string, unknown> | null,
  responseStatus: 200,
  active: { id: 'builtin', version: 'builtin' },
  resetCalls: 0,
  downloadCalls: 0,
  setCalls: 0,
  activate: false,
  activationAcknowledgeCalls: 0,
  resetFailure: false,
  serverConfig: {} as Record<string, string | undefined>,
  events: [] as string[],
};

const updater = {
  notifyAppReady: mock(async () => undefined),
  reset: mock(async () => {
    state.resetCalls += 1;
    state.events.push(`reset:${state.serverConfig.homeUrl ?? ''}`);
    if (state.resetFailure) throw new Error('reset failed');
  }),
  current: mock(async () => ({ bundle: state.active })),
  download: mock(async () => {
    state.downloadCalls += 1;
    return { id: 'downloaded', version: state.manifest?.version };
  }),
  set: mock(async () => {
    state.setCalls += 1;
  }),
  delete: mock(async () => undefined),
};

mock.module('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  CapacitorHttp: {
    get: mock(async () => ({
      status: state.responseStatus,
      data: state.manifest,
    })),
  },
}));
mock.module('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: updater,
}));
mock.module('./api-config', () => ({
  API_BASE_URL: 'https://board.test',
  getServerConfig: () => state.serverConfig,
  getServerConfigEpoch: () => 0,
  isServerConfigured: () => true,
  resolveServerUrls: (config: Record<string, string | undefined>) => ({
    homeUrl: config.homeUrl ?? 'default-home',
    remoteUrl: config.remoteUrl ?? 'default-remote',
  }),
  serverTrustChanged: (
    a: Record<string, string | undefined>,
    b: Record<string, string | undefined>,
  ) =>
    a.homeCertSha256 !== b.homeCertSha256 ||
    a.remoteCertSha256 !== b.remoteCertSha256 ||
    a.otaPublicKey !== b.otaPublicKey,
  setServerConfig: (config: Record<string, string | undefined> | null) => {
    state.serverConfig = config ?? {};
    state.events.push(`save:${state.serverConfig.homeUrl ?? ''}`);
  },
  invalidateServerConfigEpoch: () => undefined,
  clearSessionCookies: async () => undefined,
  drainNativeRequests: async () => undefined,
}));
mock.module('@/lib/native-bridge', () => ({
  NativeBridge: { deleteSecureCredentials: async () => undefined },
}));
mock.module('@/lib/session-vault', () => ({ vaultClearAll: () => undefined }));
mock.module('@/lib/websocket', () => ({
  disconnectWebSocket: () => undefined,
}));
mock.module('./push-bridge', () => ({
  CarapaBridge: {
    getOtaShellInfo: mock(async () => state.shell),
    consumeEmbeddedBundleActivation: mock(async () => ({
      activate: state.activate,
    })),
    acknowledgeEmbeddedBundleActivation: mock(async () => {
      state.activationAcknowledgeCalls += 1;
    }),
    getEmbeddedBundlePin: mock(async () => ({ pending: false })),
    setEmbeddedBundlePin: mock(async () => undefined),
  },
  clearNativeCredentials: async () => undefined,
  syncServerPins: async () => undefined,
}));

const {
  androidOtaSigningPayload,
  androidOtaFirstLoadRequired,
  applyAndroidOta,
  checkAndDownloadAndroidOta,
  notifyAndroidOtaReady,
} = await import('./android-ota');
const {
  ServerChangeIncompleteError,
  applyServerConfig,
  reconcileInterruptedServerChange,
} = await import('./server-config');

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function signedManifest(
  generation: number,
  nativeVersionCode = 3,
  pairing = false,
) {
  const keys = nacl.sign.keyPair();
  if (pairing) state.serverConfig = { otaPublicKey: base64(keys.publicKey) };
  else state.shell.publicKey = base64(keys.publicKey);
  const unsigned = {
    version: generation.toString(16).padStart(24, '0'),
    checksum: 'c'.repeat(64),
    size: 42,
    requiredNativeVersionCode: nativeVersionCode,
    bundleGeneration: generation,
  };
  return {
    ...unsigned,
    url: `/android-updates/bundles/${unsigned.version}.zip`,
    signature: base64(
      nacl.sign.detached(
        new TextEncoder().encode(androidOtaSigningPayload(unsigned)),
        keys.secretKey,
      ),
    ),
  };
}

describe('Android OTA lifecycle decisions', () => {
  beforeEach(() => {
    state.shell = {
      nativeVersionCode: 3,
      nativeVersionName: '1.0-test',
      builtinBundleVersion: 'b'.repeat(24),
      builtinBundleGeneration: 5,
      publicKey: '',
    };
    state.manifest = signedManifest(4);
    state.responseStatus = 200;
    state.active = { id: 'builtin', version: 'builtin' };
    state.resetCalls = 0;
    state.downloadCalls = 0;
    state.setCalls = 0;
    state.activate = false;
    state.activationAcknowledgeCalls = 0;
    state.resetFailure = false;
    state.serverConfig = {};
    state.events = [];
    storage.clear();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ bundleGeneration: 5 }), { status: 200 }),
    );
  });

  // These two leave no restart pending, so they can run before the test below.
  test('a failed switch to the built-in bundle keeps the new config and fails closed', async () => {
    state.serverConfig = { homeUrl: 'https://a.test' };
    state.active = { id: 'ota-2', version: 'ota-version-2' };
    state.resetFailure = true;

    await expect(
      applyServerConfig({ homeUrl: 'https://b.test' }),
    ).rejects.toBeInstanceOf(ServerChangeIncompleteError);
    expect(state.serverConfig.homeUrl).toBe('https://b.test');
    expect(storage.has('carapa-server-change-pending')).toBe(true);
    // Startup recovery keeps failing closed until the reset works.
    await expect(reconcileInterruptedServerChange()).rejects.toThrow();
    expect(storage.has('carapa-server-change-pending')).toBe(true);
  });

  test('a server change with another key forgets the paired record', async () => {
    const keyX = base64(nacl.sign.keyPair().publicKey);
    const keyY = base64(nacl.sign.keyPair().publicKey);
    state.serverConfig = { homeUrl: 'https://a.test', otaPublicKey: keyX };
    storage.set(
      'carapa-android-ota-paired',
      JSON.stringify({ otaPublicKey: keyX, lastGeneration: 5 }),
    );
    await applyServerConfig({ homeUrl: 'https://a.test', otaPublicKey: keyY });
    expect(storage.has('carapa-android-ota-paired')).toBe(false);
  });

  // First on purpose: applyAndroidOta marks a restart as pending for the rest
  // of the process, which makes applyServerConfig refuse a change.
  test('server change clears the paired record and leaves the old bundle', async () => {
    state.active = { id: 'ota-2', version: 'ota-version-2' };
    state.manifest = signedManifest(6, 3, true);
    const otaPublicKey = state.serverConfig.otaPublicKey as string;
    state.serverConfig = { homeUrl: 'https://a.test', otaPublicKey };
    // A downloaded update of server A that was not applied yet.
    expect((await checkAndDownloadAndroidOta()).kind).toBe('ready');
    storage.set(
      'carapa-android-ota-paired',
      JSON.stringify({ otaPublicKey, lastGeneration: 2 }),
    );

    expect(
      await applyServerConfig({ homeUrl: 'https://b.test', otaPublicKey }),
    ).toBe(true);
    // The new config is saved before the reset reloads the WebView.
    expect(state.events).toEqual([
      'save:https://b.test',
      'reset:https://b.test',
    ]);
    expect(updater.delete).toHaveBeenCalledWith({ id: 'downloaded' });
    // Same key: the floor of the shared generation sequence stays.
    expect(storage.has('carapa-android-ota-paired')).toBe(true);
    expect(state.resetCalls).toBe(1);

    // The process ended before the reset took effect: the next start still
    // runs bundle A and finishes the change, keeping the new config.
    await reconcileInterruptedServerChange();
    expect(state.resetCalls).toBe(2);
    expect(state.serverConfig.homeUrl).toBe('https://b.test');

    // Once the built-in bundle is active nothing is reset again; a record of
    // another key (a changed key) is forgotten.
    state.active = { id: 'builtin', version: 'builtin' };
    storage.set(
      'carapa-android-ota-paired',
      JSON.stringify({
        otaPublicKey: base64(nacl.sign.keyPair().publicKey),
        lastGeneration: 5,
      }),
    );
    await reconcileInterruptedServerChange();
    expect(state.resetCalls).toBe(2);
    expect(storage.has('carapa-android-ota-paired')).toBe(false);
  });

  test('does not offer a signed older OTA over a newer embedded bundle', async () => {
    const result = await checkAndDownloadAndroidOta();
    expect(result).toEqual({
      kind: 'current',
      version: state.manifest.version,
    });
    expect(state.downloadCalls).toBe(0);
  });

  test('does not offer an older OTA over a newer active OTA', async () => {
    state.active = { id: 'ota-6', version: 'ota-version-6' };
    state.manifest = signedManifest(5);
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ bundleGeneration: 6 }), { status: 200 }),
    );
    const result = await checkAndDownloadAndroidOta();
    expect(result).toEqual({
      kind: 'current',
      version: state.manifest.version,
    });
    expect(state.downloadCalls).toBe(0);
  });

  test('migrates a legacy active bundle to a newer signed OTA', async () => {
    state.active = { id: 'legacy-ota', version: 'legacy-version' };
    state.manifest = signedManifest(6);
    globalThis.fetch = mock(async () => new Response('', { status: 404 }));
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('ready');
    expect(state.downloadCalls).toBe(1);
  });

  test('downloads and applies a genuinely newer compatible OTA', async () => {
    state.active = { id: 'ota-5', version: 'ota-version-5' };
    state.manifest = signedManifest(6);
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('ready');
    expect(state.downloadCalls).toBe(1);
    await applyAndroidOta(result.update);
    expect(state.setCalls).toBe(1);
  });

  test('accepts a newer-generation OTA that requires an older native shell', async () => {
    state.active = { id: 'ota-5', version: 'ota-version-5' };
    state.manifest = signedManifest(6, 2);
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('ready');
    expect(state.downloadCalls).toBe(1);
  });

  test('rejects an OTA requiring a newer native shell', async () => {
    state.manifest = signedManifest(6, 4);
    const result = await checkAndDownloadAndroidOta();
    expect(result).toEqual({
      kind: 'incompatible',
      requiredNativeVersionCode: 4,
      nativeVersionCode: 3,
    });
    expect(state.downloadCalls).toBe(0);
  });

  test('reports native incompatibility even when active metadata is malformed', async () => {
    state.active = { id: 'ota-malformed', version: 'ota-version' };
    state.manifest = signedManifest(6, 4);
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ bundleGeneration: 'not-a-number' }), {
          status: 200,
        }),
    );
    const result = await checkAndDownloadAndroidOta();
    expect(result).toEqual({
      kind: 'incompatible',
      requiredNativeVersionCode: 4,
      nativeVersionCode: 3,
    });
    expect(state.downloadCalls).toBe(0);
  });

  test('activation marker resets to the embedded bundle', async () => {
    state.activate = true;
    state.active = { id: 'ota-4', version: 'ota-version-4' };
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('current');
    expect(state.resetCalls).toBe(1);
    expect(state.activationAcknowledgeCalls).toBe(1);
    expect(state.downloadCalls).toBe(0);
  });

  test('preserves activation marker when the fallback reset fails', async () => {
    state.activate = true;
    state.active = { id: 'ota-4', version: 'ota-version-4' };
    state.resetFailure = true;
    await expect(checkAndDownloadAndroidOta()).rejects.toThrow('reset failed');
    expect(state.activationAcknowledgeCalls).toBe(0);
  });

  test('activation marker only acknowledges once the embedded bundle is active', async () => {
    // The reload from reset() ended the context that would have acknowledged.
    state.activate = true;
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('current');
    expect(state.resetCalls).toBe(0);
    expect(state.activationAcknowledgeCalls).toBe(1);
  });

  test('does not replay activation after a newer OTA becomes active', async () => {
    state.activate = true;
    state.active = { id: 'ota-4', version: 'ota-version-4' };
    await checkAndDownloadAndroidOta();
    expect(state.resetCalls).toBe(1);

    state.activate = false;
    state.active = { id: 'ota-5', version: 'ota-version-5' };
    state.manifest = signedManifest(6);
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('ready');
    expect(state.resetCalls).toBe(1);
    expect(state.downloadCalls).toBe(1);
  });

  test('paired key accepts a below-built-in generation on first pairing', async () => {
    state.shell.publicKey = '';
    state.manifest = signedManifest(2, 3, true);
    const result = await checkAndDownloadAndroidOta();
    expect(result.kind).toBe('ready');
    expect(state.downloadCalls).toBe(1);
    await applyAndroidOta(result.update);
    expect(state.setCalls).toBe(1);

    // Booting the bundle confirms its generation without consulting the
    // manifest endpoint; falling back to the built-in bundle keeps the floor.
    state.active = { id: 'downloaded', version: 'ota-version-2' };
    await notifyAndroidOtaReady();
    state.active = { id: 'builtin', version: 'builtin' };
    state.responseStatus = 200;
    expect((await checkAndDownloadAndroidOta()).kind).toBe('current');
    expect(state.downloadCalls).toBe(1);
  });

  test('first pairing requires the first-load gate, an unpaired app does not', async () => {
    expect(androidOtaFirstLoadRequired()).toBe(false);
    state.manifest = signedManifest(2, 3, true);
    expect(androidOtaFirstLoadRequired()).toBe(true);
    await applyAndroidOta((await checkAndDownloadAndroidOta()).update);
    // Applied but not yet serving: still the first load.
    expect(androidOtaFirstLoadRequired()).toBe(true);
  });

  test('no first-load gate once a bundle of the paired server was confirmed', async () => {
    state.manifest = signedManifest(2, 3, true);
    await applyAndroidOta((await checkAndDownloadAndroidOta()).update);
    state.active = { id: 'downloaded', version: state.manifest.version };
    await notifyAndroidOtaReady();
    state.active = { id: 'builtin', version: 'builtin' };
    expect(androidOtaFirstLoadRequired()).toBe(false);
  });

  test('no first-load gate once a generation-0 bundle of the paired server was confirmed', async () => {
    state.manifest = signedManifest(0, 3, true);
    await applyAndroidOta((await checkAndDownloadAndroidOta()).update);
    expect(androidOtaFirstLoadRequired()).toBe(true);
    state.active = { id: 'downloaded', version: state.manifest.version };
    await notifyAndroidOtaReady();
    state.active = { id: 'builtin', version: 'builtin' };
    expect(androidOtaFirstLoadRequired()).toBe(false);
  });

  test('first load downloads the server bundle even when the built-in one has its version', async () => {
    state.manifest = signedManifest(0, 3, true);
    state.shell.builtinBundleVersion = String(state.manifest.version);
    expect((await checkAndDownloadAndroidOta()).kind).toBe('ready');
    expect(state.downloadCalls).toBe(1);
  });

  test('paired mode offers a bundle again when it never booted', async () => {
    state.manifest = signedManifest(2, 3, true);
    await applyAndroidOta((await checkAndDownloadAndroidOta()).update);
    expect((await checkAndDownloadAndroidOta()).kind).toBe('ready');
    expect(state.downloadCalls).toBe(2);
  });

  test('paired mode does not raise the floor while the boot is unconfirmed', async () => {
    state.manifest = signedManifest(7, 3, true);
    await applyAndroidOta((await checkAndDownloadAndroidOta()).update);
    // The candidate is serving, but notifyAppReady has not succeeded.
    state.active = { id: 'downloaded', version: state.manifest.version };
    updater.notifyAppReady.mockImplementationOnce(async () => {
      throw new Error('not ready');
    });
    await notifyAndroidOtaReady().catch(() => undefined);
    expect((await checkAndDownloadAndroidOta()).kind).toBe('current');
    // The updater falls back: the failed candidate is offered again.
    state.active = { id: 'builtin', version: 'builtin' };
    expect((await checkAndDownloadAndroidOta()).kind).toBe('ready');
  });

  test('paired mode rejects a manifest signed with another key', async () => {
    state.manifest = signedManifest(9);
    state.serverConfig = {
      otaPublicKey: base64(nacl.sign.keyPair().publicKey),
    };
    await expect(checkAndDownloadAndroidOta()).rejects.toThrow(
      'signature verification failed',
    );
    expect(state.downloadCalls).toBe(0);
  });

  test('paired mode offers a failed update again after a rollback to another bundle', async () => {
    state.manifest = signedManifest(5, 3, true);
    await applyAndroidOta((await checkAndDownloadAndroidOta()).update);
    // The updater fell back to an older legacy bundle that has a higher
    // generation than the candidate; it must not confirm the candidate.
    state.active = { id: 'legacy-ota', version: 'legacy-version' };
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ bundleGeneration: 100 }), {
          status: 200,
        }),
    );
    await notifyAndroidOtaReady();
    expect((await checkAndDownloadAndroidOta()).kind).toBe('ready');
    expect(state.downloadCalls).toBe(2);
  });
});
