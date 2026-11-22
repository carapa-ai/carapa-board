import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  ANDROID_OTA_DIR,
  androidOtaSigningPayload,
  ensureAndroidOtaSigningKey,
  publishInstalledWebAsAndroidOta,
  readAndroidOtaPublicKey,
  resolveAndroidOtaSigningKeyPath,
  signAndroidOtaMetadata,
} from './lib/android-ota.js';

describe('Android OTA release signing', () => {
  beforeEach(() => {
    fs.rmSync(ANDROID_OTA_DIR, { recursive: true, force: true });
  });

  test('signs the exact canonical metadata and rejects mutations', () => {
    const keys = generateKeyPairSync('ed25519');
    const metadata = {
      version: 'a'.repeat(24),
      checksum: 'b'.repeat(64),
      size: 42,
      requiredNativeVersionCode: 2,
      bundleGeneration: 1,
    };
    const signature = Buffer.from(
      signAndroidOtaMetadata(
        metadata,
        keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      ),
      'base64',
    );

    expect(
      verify(
        null,
        Buffer.from(androidOtaSigningPayload(metadata)),
        keys.publicKey,
        signature,
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(androidOtaSigningPayload({ ...metadata, size: 43 })),
        keys.publicKey,
        signature,
      ),
    ).toBe(false);
  });

  test('publishes the installed web build only when its content changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-ota-web-'));
    const web = path.join(root, 'dist');
    const shellVersion = path.join(root, 'native-shell-version.json');
    const keyFilePath = path.join(root, 'private.pem');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<main>installed</main>');
    fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log("ota")');
    fs.writeFileSync(shellVersion, '{"versionCode":2,"bundleGeneration":3}\n');
    const keys = generateKeyPairSync('ed25519');
    fs.writeFileSync(
      keyFilePath,
      keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    const publish = () =>
      publishInstalledWebAsAndroidOta(web, shellVersion, keyFilePath);
    const bundleFiles = (version: string) =>
      unzipSync(
        new Uint8Array(
          fs.readFileSync(
            path.join(ANDROID_OTA_DIR, 'bundles', `${version}.zip`),
          ),
        ),
      );
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    try {
      // First publication: builtin generation + 1, generation embedded in the zip.
      const first = publish();
      expect(first.status).toBe('published');
      expect(first.manifest.bundleGeneration).toBe(4);
      expect(first.manifest.requiredNativeVersionCode).toBe(2);
      const firstFiles = bundleFiles(first.manifest.version);
      expect(text(firstFiles['index.html'])).toBe('<main>installed</main>');
      expect(text(firstFiles['assets/app.js'])).toBe('console.log("ota")');
      expect(JSON.parse(text(firstFiles['android-ota-bundle.json']))).toEqual({
        bundleGeneration: 4,
      });
      expect(fs.existsSync(path.join(web, 'android-ota-bundle.json'))).toBe(
        false,
      );

      // Unchanged content: nothing is republished.
      const latestBefore = fs.readFileSync(
        path.join(ANDROID_OTA_DIR, 'latest.json'),
        'utf8',
      );
      expect(publish().status).toBe('current');
      expect(
        fs.readFileSync(path.join(ANDROID_OTA_DIR, 'latest.json'), 'utf8'),
      ).toBe(latestBefore);

      // Changed content: generation increases by one.
      fs.writeFileSync(path.join(web, 'index.html'), '<main>changed</main>');
      const second = publish();
      expect(second.status).toBe('published');
      expect(second.manifest.bundleGeneration).toBe(5);
      expect(
        JSON.parse(
          text(bundleFiles(second.manifest.version)['android-ota-bundle.json']),
        ),
      ).toEqual({ bundleGeneration: 5 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to the persisted generated key when the Docker secret mount is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-ota-key-'));
    const persistedKey = path.join(root, 'secrets', 'android_ota_private_key');
    fs.mkdirSync(path.dirname(persistedKey), { recursive: true });
    fs.writeFileSync(persistedKey, 'persisted key');

    try {
      expect(
        resolveAndroidOtaSigningKeyPath({
          dockerSecretPath: path.join(root, 'missing-docker-secret'),
          storeDir: root,
        }),
      ).toBe(persistedKey);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates a usable signing key once and reports its public key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-ota-key-'));
    const dockerSecretPath = path.join(root, 'missing-docker-secret');
    const options = { dockerSecretPath, storeDir: root };
    try {
      expect(ensureAndroidOtaSigningKey(options)).toBe('created');
      const keyPath = resolveAndroidOtaSigningKeyPath(options);
      expect(keyPath).toBe(
        path.join(root, 'secrets', 'android_ota_private_key'),
      );
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
      const pem = fs.readFileSync(keyPath);
      const metadata = {
        version: 'a'.repeat(24),
        checksum: 'b'.repeat(64),
        size: 1,
        requiredNativeVersionCode: 1,
        bundleGeneration: 1,
      };
      expect(() => signAndroidOtaMetadata(metadata, pem)).not.toThrow();

      const published = readAndroidOtaPublicKey(keyPath);
      const derived = createPublicKey(createPrivateKey(pem))
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64');
      expect(published).toBe(derived);
      expect(Buffer.from(published ?? '', 'base64')).toHaveLength(32);

      // A second boot keeps exactly that key.
      expect(ensureAndroidOtaSigningKey(options)).toBe('existing');
      expect(fs.readFileSync(keyPath).equals(pem)).toBe(true);

      // A Docker secret also counts as an existing key.
      const secretRoot = fs.mkdtempSync(path.join(root, 'secret-'));
      const secretPath = path.join(secretRoot, 'key');
      fs.writeFileSync(secretPath, 'external');
      expect(
        ensureAndroidOtaSigningKey({
          dockerSecretPath: secretPath,
          storeDir: path.join(root, 'other'),
        }),
      ).toBe('existing');
      expect(fs.existsSync(path.join(root, 'other'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
