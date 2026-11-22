import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { sha256Hex } from './hash.js';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

export interface AndroidOtaManifest {
  version: string;
  url: string;
  checksum: string;
  signature: string;
  size: number;
  requiredNativeVersionCode: number;
  bundleGeneration: number;
}

interface AndroidOtaCandidate {
  version: string;
  checksum: string;
  size: number;
  requiredNativeVersionCode: number;
  bundleGeneration: number;
}

export const ANDROID_OTA_DIR = path.join(STORE_DIR, 'android-ota', 'published');
const installedWebDir = path.resolve(process.cwd(), 'ui', 'dist');
const CONTENT_RECORD_PREFIX = 'published-content-';
const BUNDLE_GENERATION_FILE = 'android-ota-bundle.json';
const nativeShellVersionPath = path.resolve(
  process.cwd(),
  'ui',
  'android',
  'native-shell-version.json',
);

export function androidOtaSigningPayload(
  value: Omit<AndroidOtaManifest, 'url' | 'signature'>,
): string {
  return [
    value.version,
    value.checksum,
    value.size,
    value.requiredNativeVersionCode,
    value.bundleGeneration,
  ].join('\n');
}

export function signAndroidOtaMetadata(
  value: Omit<AndroidOtaManifest, 'url' | 'signature'>,
  privateKeyPem: string | Buffer,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Android OTA private key must be Ed25519');
  }
  return sign(
    null,
    Buffer.from(androidOtaSigningPayload(value)),
    privateKey,
  ).toString('base64');
}

function validCandidate(value: unknown): value is AndroidOtaCandidate {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.version === 'string' &&
    /^[a-f0-9]{24}$/.test(item.version) &&
    typeof item.checksum === 'string' &&
    /^[a-f0-9]{64}$/.test(item.checksum) &&
    Number.isSafeInteger(item.size) &&
    Number(item.size) > 0 &&
    Number.isSafeInteger(item.requiredNativeVersionCode) &&
    Number(item.requiredNativeVersionCode) > 0 &&
    Number.isSafeInteger(item.bundleGeneration) &&
    Number(item.bundleGeneration) >= 0
  );
}

export function resolveAndroidOtaSigningKeyPath(
  options: {
    dockerSecretPath?: string;
    storeDir?: string;
  } = {},
): string {
  const dockerSecretPath =
    options.dockerSecretPath ?? '/run/secrets/android_ota_private_key';
  if (fs.existsSync(dockerSecretPath)) return dockerSecretPath;

  const persistedPath = path.join(
    options.storeDir ?? STORE_DIR,
    'secrets',
    'android_ota_private_key',
  );
  if (fs.existsSync(persistedPath)) return persistedPath;

  return dockerSecretPath;
}

/**
 * Create the Ed25519 signing key when neither the Docker secret nor the
 * persisted key exists. An existing key at either location is never touched
 * (`wx` also refuses a file that appears between the check and the write).
 */
export function ensureAndroidOtaSigningKey(
  options: { dockerSecretPath?: string; storeDir?: string } = {},
): 'created' | 'existing' {
  if (fs.existsSync(resolveAndroidOtaSigningKeyPath(options))) {
    return 'existing';
  }
  const secretsDir = path.join(options.storeDir ?? STORE_DIR, 'secrets');
  const keyPath = path.join(secretsDir, 'android_ota_private_key');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const pem = generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  });
  try {
    fs.writeFileSync(keyPath, pem, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'existing';
    throw error;
  }
  return 'created';
}

/** Base64 of the raw 32-byte Ed25519 public key; null without a valid key. */
export function readAndroidOtaPublicKey(
  keyPath = resolveAndroidOtaSigningKeyPath(),
): string | null {
  try {
    const privateKey = createPrivateKey(fs.readFileSync(keyPath));
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;
    return createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64');
  } catch {
    return null;
  }
}

type WebFile = readonly [relativePath: string, contents: Uint8Array];

interface PublishedContentRecord {
  version: string;
  contentFingerprint: string;
}

function contentRecordPath(version: string): string {
  return path.join(ANDROID_OTA_DIR, `${CONTENT_RECORD_PREFIX}${version}.json`);
}

/** Write via a temporary file so a failed write never leaves a partial target. */
function writeFileAtomic(target: string, data: string | Uint8Array): void {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Server-only sidecar tying a bundle version to a fingerprint of its web
 * files. It is keyed by version, so writing it before the manifest commit
 * cannot disturb the record of the release that is still published, and it
 * stays outside the signed manifest that installed APKs verify.
 */
function readPublishedContentFingerprint(version: string): string | null {
  try {
    const record = JSON.parse(
      fs.readFileSync(contentRecordPath(version), 'utf8'),
    ) as Partial<PublishedContentRecord>;
    return record.version === version &&
      typeof record.contentFingerprint === 'string'
      ? record.contentFingerprint
      : null;
  } catch {
    return null;
  }
}

/** SHA-256 over sorted paths and bytes, ignoring the per-release generation file. */
function androidOtaContentFingerprint(files: Iterable<WebFile>): string {
  const hash = createHash('sha256');
  const entries = [...files]
    .filter(([name]) => name !== BUNDLE_GENERATION_FILE)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, contents] of entries) {
    const header = Buffer.from(`${name}\0${contents.byteLength}\0`);
    hash.update(header).update(contents);
  }
  return hash.digest('hex');
}

function publishCandidate(
  candidate: AndroidOtaCandidate,
  zip: Buffer | Uint8Array,
  signingKeyPath?: string,
  contentFingerprint?: string,
): AndroidOtaManifest {
  const keyPath = signingKeyPath ?? resolveAndroidOtaSigningKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Android OTA signing key is missing: ${keyPath}`);
  }
  if (!validCandidate(candidate)) {
    throw new Error('Invalid Android OTA candidate metadata');
  }

  const published = readPublishedAndroidOtaManifest();
  if (published) {
    const publishedGeneration = published.bundleGeneration ?? 0;
    if (candidate.bundleGeneration < publishedGeneration) {
      throw new Error(
        `Android OTA generation ${candidate.bundleGeneration} is older than published generation ${publishedGeneration}`,
      );
    }
    if (
      candidate.bundleGeneration === publishedGeneration &&
      (candidate.version !== published.version ||
        candidate.checksum !== published.checksum ||
        candidate.requiredNativeVersionCode !==
          published.requiredNativeVersionCode)
    ) {
      throw new Error(
        `Android OTA generation ${candidate.bundleGeneration} conflicts with the published bundle`,
      );
    }
  }

  const bytes = Buffer.from(zip);
  const actualChecksum = sha256Hex(bytes);
  if (
    actualChecksum !== candidate.checksum ||
    bytes.byteLength !== candidate.size
  ) {
    throw new Error('Android OTA candidate checksum or size mismatch');
  }

  const unsigned = {
    version: candidate.version,
    checksum: candidate.checksum,
    size: candidate.size,
    requiredNativeVersionCode: candidate.requiredNativeVersionCode,
    bundleGeneration: candidate.bundleGeneration,
  };
  const signature = signAndroidOtaMetadata(unsigned, fs.readFileSync(keyPath));
  const bundleName = `${candidate.version}.zip`;
  const manifest: AndroidOtaManifest = {
    ...unsigned,
    url: `/android-updates/bundles/${bundleName}`,
    signature,
  };

  fs.mkdirSync(path.join(ANDROID_OTA_DIR, 'bundles'), { recursive: true });
  const bundleTarget = path.join(ANDROID_OTA_DIR, 'bundles', bundleName);
  const createdBundle = !fs.existsSync(bundleTarget);
  try {
    // Stage everything first; the latest.json rename is the single commit point.
    if (createdBundle) writeFileAtomic(bundleTarget, bytes);
    if (contentFingerprint) {
      writeFileAtomic(
        contentRecordPath(manifest.version),
        `${JSON.stringify({ version: manifest.version, contentFingerprint } satisfies PublishedContentRecord)}\n`,
      );
    }
    writeFileAtomic(
      path.join(ANDROID_OTA_DIR, 'latest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } catch (error) {
    // The previous release stays published; drop only what this attempt added.
    if (createdBundle) fs.rmSync(bundleTarget, { force: true });
    throw error;
  }

  // The new release is live; failing to prune older ones must not report failure.
  try {
    for (const file of fs.readdirSync(path.join(ANDROID_OTA_DIR, 'bundles'))) {
      if (file !== bundleName && file.endsWith('.zip')) {
        fs.rmSync(path.join(ANDROID_OTA_DIR, 'bundles', file), { force: true });
      }
    }
    for (const file of fs.readdirSync(ANDROID_OTA_DIR)) {
      if (
        file.startsWith(CONTENT_RECORD_PREFIX) &&
        file !== path.basename(contentRecordPath(manifest.version))
      ) {
        fs.rmSync(path.join(ANDROID_OTA_DIR, file), { force: true });
      }
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Android OTA cleanup failed');
  }
  logger.info(
    { version: manifest.version, size: manifest.size },
    'Published signed Android OTA bundle',
  );
  return manifest;
}

function readPublishedAndroidOtaManifest(): AndroidOtaManifest | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(ANDROID_OTA_DIR, 'latest.json'), 'utf8'),
    ) as AndroidOtaManifest;
    return typeof value.version === 'string' ? value : null;
  } catch {
    return null;
  }
}

function collectWebFiles(directory: string, prefix = ''): WebFile[] {
  const files: WebFile[] = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectWebFiles(absolute, relative));
    else if (entry.isFile()) {
      files.push([relative, new Uint8Array(fs.readFileSync(absolute))]);
    }
  }
  return files;
}

export type InstalledWebPublication =
  | { status: 'current'; manifest: AndroidOtaManifest }
  | { status: 'published'; manifest: AndroidOtaManifest };

/**
 * Publish the web assets of the running release unless their content (and the
 * required native version) already matches the published bundle.
 */
export function publishInstalledWebAsAndroidOta(
  webDir = installedWebDir,
  shellVersionFile = nativeShellVersionPath,
  signingKeyPath?: string,
): InstalledWebPublication {
  if (!fs.existsSync(path.join(webDir, 'index.html'))) {
    throw new Error(`Installed web build has no index.html: ${webDir}`);
  }
  const shellVersion = JSON.parse(
    fs.readFileSync(shellVersionFile, 'utf8'),
  ) as {
    versionCode?: unknown;
    bundleGeneration?: unknown;
  };
  const versionCode = Number(shellVersion.versionCode);
  const builtinGeneration = Number(shellVersion.bundleGeneration);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error(`${shellVersionFile} must contain a positive versionCode`);
  }
  if (!Number.isSafeInteger(builtinGeneration) || builtinGeneration < 1) {
    throw new Error(
      `${shellVersionFile} must contain a positive bundleGeneration`,
    );
  }

  const files = collectWebFiles(webDir);
  const contentFingerprint = androidOtaContentFingerprint(files);
  const published = readPublishedAndroidOtaManifest();
  if (
    published &&
    published.requiredNativeVersionCode === versionCode &&
    readPublishedContentFingerprint(published.version) === contentFingerprint
  ) {
    return { status: 'current', manifest: published };
  }

  const bundleGeneration =
    Math.max(builtinGeneration, published?.bundleGeneration ?? 0) + 1;
  if (!Number.isSafeInteger(bundleGeneration)) {
    throw new Error('Android OTA bundle generation is exhausted');
  }

  // Assembled in memory: the installed web directory is read-only.
  const archive: Zippable = {};
  for (const [name, contents] of files) {
    if (name === BUNDLE_GENERATION_FILE) continue;
    archive[name] = [contents, { mtime: new Date('1980-01-01T00:00:00.000Z') }];
  }
  archive[BUNDLE_GENERATION_FILE] = [
    new TextEncoder().encode(`${JSON.stringify({ bundleGeneration })}\n`),
    { mtime: new Date('1980-01-01T00:00:00.000Z') },
  ];
  const zip = zipSync(archive, { level: 9 });
  const checksum = sha256Hex(zip);
  const manifest = publishCandidate(
    {
      version: checksum.slice(0, 24),
      checksum,
      size: zip.byteLength,
      requiredNativeVersionCode: versionCode,
      bundleGeneration,
    },
    zip,
    signingKeyPath,
    contentFingerprint,
  );
  return { status: 'published', manifest };
}
