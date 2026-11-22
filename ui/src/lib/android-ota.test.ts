// @ts-nocheck
import { describe, expect, mock, test } from 'bun:test';
import nacl from 'tweetnacl';

// This file is in the isolated Android test group (scripts/test-file-groups.sh),
// so replacing these modules cannot leak into other suites.
const state = { publicKey: '', responseStatus: 404 };
mock.module('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  CapacitorHttp: {
    get: mock(async () => ({ status: state.responseStatus, data: null })),
  },
}));
mock.module('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: mock(async () => ({
      bundle: { id: 'builtin', version: 'builtin' },
    })),
  },
}));
mock.module('./api-config', () => ({
  API_BASE_URL: 'https://board.test',
  getServerConfig: () => ({}),
  getServerConfigEpoch: () => 0,
  isServerConfigured: () => true,
}));
mock.module('./push-bridge', () => ({
  CarapaBridge: {
    getOtaShellInfo: mock(async () => ({
      nativeVersionCode: 3,
      nativeVersionName: '1.0-test',
      builtinBundleVersion: 'b'.repeat(24),
      builtinBundleGeneration: 5,
      publicKey: state.publicKey,
    })),
    consumeEmbeddedBundleActivation: mock(async () => ({ activate: false })),
    getEmbeddedBundlePin: mock(async () => ({ pending: false })),
    setEmbeddedBundlePin: mock(async () => undefined),
  },
}));

const {
  androidOtaSigningPayload,
  androidOtaStatusLabel,
  checkAndDownloadAndroidOta,
  verifyAndroidOtaManifest,
  compareAndroidBundleGenerations,
  readActiveAndroidBundleGeneration,
} = await import('./android-ota');

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

describe('Android OTA manifest verification', () => {
  test('accepts the canonical Ed25519 signature and rejects tampering', () => {
    const keys = nacl.sign.keyPair();
    const unsigned = {
      version: 'a'.repeat(24),
      checksum: 'b'.repeat(64),
      size: 1234,
      requiredNativeVersionCode: 2,
      bundleGeneration: 2,
    };
    const signature = nacl.sign.detached(
      new TextEncoder().encode(androidOtaSigningPayload(unsigned)),
      keys.secretKey,
    );
    const manifest = {
      ...unsigned,
      url: `/android-updates/bundles/${unsigned.version}.zip`,
      signature: base64(signature),
    };

    expect(verifyAndroidOtaManifest(manifest, base64(keys.publicKey))).toBe(
      true,
    );
    expect(
      verifyAndroidOtaManifest(
        { ...manifest, size: 1235 },
        base64(keys.publicKey),
      ),
    ).toBe(false);
  });

  test('accepts a signed legacy generation-0 manifest for compatibility', () => {
    const keys = nacl.sign.keyPair();
    const unsigned = {
      version: 'c'.repeat(24),
      checksum: 'd'.repeat(64),
      size: 1234,
      requiredNativeVersionCode: 2,
    };
    const signature = nacl.sign.detached(
      new TextEncoder().encode(androidOtaSigningPayload(unsigned)),
      keys.secretKey,
    );
    const manifest = {
      ...unsigned,
      url: `/android-updates/bundles/${unsigned.version}.zip`,
      signature: base64(signature),
    };
    expect(verifyAndroidOtaManifest(manifest, base64(keys.publicKey))).toBe(
      true,
    );
  });

  test('orders generations numerically and rejects legacy/invalid ordering', () => {
    expect(compareAndroidBundleGenerations(5, 4)).toBe('older');
    expect(compareAndroidBundleGenerations(5, 5)).toBe('same');
    expect(compareAndroidBundleGenerations(5, 6)).toBe('newer');
    expect(compareAndroidBundleGenerations(5, 0)).toBe('older');
    expect(compareAndroidBundleGenerations(5, Number.NaN)).toBe('unknown');
  });

  test('uses the embedded generation only for the builtin bundle', async () => {
    expect(
      await readActiveAndroidBundleGeneration(
        { id: 'builtin', version: 'builtin' },
        7,
      ),
    ).toBe(7);
  });

  test('reads the generation from the active OTA bundle', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ bundleGeneration: 9 }), { status: 200 });
    try {
      await expect(
        readActiveAndroidBundleGeneration(
          { id: 'downloaded-id', version: 'downloaded-version' },
          7,
        ),
      ).resolves.toBe(9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Android OTA unavailable reasons', () => {
  test('labels every status kind and distinguishes the unavailable reasons', () => {
    expect(androidOtaStatusLabel({ kind: 'checking' })).toBe(
      'Android · Checking update…',
    );
    expect(androidOtaStatusLabel({ kind: 'current', version: 'v' })).toBe(
      'Android · Up to date',
    );
    expect(androidOtaStatusLabel({ kind: 'ready', version: 'v' })).toBe(
      'Android · Update ready',
    );
    expect(
      androidOtaStatusLabel({
        kind: 'incompatible',
        required: 4,
        installed: 3,
      }),
    ).toBe('Android · APK update required');
    expect(androidOtaStatusLabel({ kind: 'error' })).toBe(
      'Android · Check failed',
    );
    expect(
      androidOtaStatusLabel({ kind: 'unavailable', reason: 'no-key' }),
    ).toBe(
      'Android · OTA disabled (APK built without OTA key; reinstall via ui/android/install-apk.sh)',
    );
    for (const reason of ['not-published', 'not-native'] as const) {
      expect(androidOtaStatusLabel({ kind: 'unavailable', reason })).toBe(
        'Android · No update published',
      );
    }
  });

  test('keyless APK reports no-key; a 404 with a key reports not-published', async () => {
    state.publicKey = '';
    expect(await checkAndDownloadAndroidOta()).toEqual({
      kind: 'unavailable',
      reason: 'no-key',
    });

    state.publicKey = base64(nacl.sign.keyPair().publicKey);
    state.responseStatus = 404;
    expect(await checkAndDownloadAndroidOta()).toEqual({
      kind: 'unavailable',
      reason: 'not-published',
    });
  });
});
