import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CapacitorUpdater, type BundleInfo } from '@capgo/capacitor-updater';
import nacl from 'tweetnacl';
import {
  API_BASE_URL,
  getServerConfig,
  getServerConfigEpoch,
  isServerConfigured,
} from './api-config';
import { base64ToBytes } from './base64';
import { CarapaBridge } from './push-bridge';
import {
  cancelNativeBootLock,
  requestNativeBootLock,
} from './native-boot-lock';

export const ANDROID_OTA_AVAILABLE_EVENT = 'carapa:android-update-ready';
export const ANDROID_OTA_PROMPT_EVENT = 'carapa:android-update-prompt';

type AndroidOtaUnavailableReason =
  | 'no-key'
  | 'no-server'
  | 'not-published'
  | 'not-native';

export type AndroidOtaStatus =
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'incompatible'; required: number; installed: number }
  | { kind: 'unavailable'; reason: AndroidOtaUnavailableReason }
  | { kind: 'error'; message?: string };

// A Restart pressed on this device asks for the newer bundle to be applied
// without the "update ready" prompt. In-memory only: a relaunched app falls
// back to the normal prompt. The window covers the restart plus the boot-time
// publish that follows it.
const ANDROID_OTA_AUTO_APPLY_WINDOW_MS = 3 * 60 * 1000;
let androidOtaAutoApplyUntil = 0;

export function armAndroidOtaAutoApply(): void {
  androidOtaAutoApplyUntil = Date.now() + ANDROID_OTA_AUTO_APPLY_WINDOW_MS;
}

export function isAndroidOtaAutoApplyArmed(): boolean {
  return Date.now() < androidOtaAutoApplyUntil;
}

export function clearAndroidOtaAutoApply(): void {
  androidOtaAutoApplyUntil = 0;
}

export function androidOtaStatusLabel(status: AndroidOtaStatus): string {
  switch (status.kind) {
    case 'current':
      return 'Android · Up to date';
    case 'ready':
      return 'Android · Update ready';
    case 'incompatible':
      return 'Android · APK update required';
    case 'unavailable':
      return status.reason === 'no-key'
        ? 'Android · OTA disabled (APK built without OTA key; reinstall via ui/android/install-apk.sh)'
        : 'Android · No update published';
    case 'error':
      return 'Android · Check failed';
    case 'checking':
      return 'Android · Checking update…';
  }
}

let androidOtaStatus: AndroidOtaStatus = { kind: 'checking' };
const androidOtaStatusListeners = new Set<() => void>();

export function getAndroidOtaStatus(): AndroidOtaStatus {
  return androidOtaStatus;
}

export function subscribeAndroidOtaStatus(listener: () => void): () => void {
  androidOtaStatusListeners.add(listener);
  return () => androidOtaStatusListeners.delete(listener);
}

export function publishAndroidOtaStatus(status: AndroidOtaStatus): void {
  androidOtaStatus = status;
  for (const listener of androidOtaStatusListeners) listener();
}

export interface AndroidOtaManifest {
  version: string;
  url: string;
  checksum: string;
  signature: string;
  size: number;
  requiredNativeVersionCode: number;
  bundleGeneration?: number;
}

export interface AndroidOtaReady {
  manifest: AndroidOtaManifest;
  bundle: BundleInfo;
  /** Paired server key the manifest was verified with (per-server ordering). */
  pairedKey?: string;
  /** Server config epoch the update was checked under; stale ones are refused. */
  configEpoch: number;
}

// Generations are assigned per server, so a paired server's applied generation
// is kept apart from the APK's built-in number and embedded pin. `lastGeneration`
// is a floor that only counts bundles seen serving; `pendingGeneration` is a
// bundle handed to the updater whose boot is not confirmed yet, so a bundle
// that failed to boot is offered again without ever lowering the floor. The
// pending bundle is identified by its updater id: if the updater falls back to
// some other bundle, that one must not promote the pending generation.
const PAIRED_OTA_RECORD_KEY = 'carapa-android-ota-paired';

interface PairedOtaRecord {
  lastGeneration: number;
  /** A bundle of this server has served; independent of the generation number (0 is valid). */
  confirmed?: boolean;
  pendingGeneration?: number;
  pendingBundleId?: string;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function readPairedRecord(otaPublicKey: string): PairedOtaRecord {
  try {
    const record = JSON.parse(
      localStorage.getItem(PAIRED_OTA_RECORD_KEY) ?? 'null',
    ) as {
      otaPublicKey?: unknown;
      lastGeneration?: unknown;
      confirmed?: unknown;
      pendingGeneration?: unknown;
      pendingBundleId?: unknown;
    } | null;
    if (record?.otaPublicKey !== otaPublicKey) return { lastGeneration: 0 };
    const hasPending =
      isGeneration(record.pendingGeneration) &&
      typeof record.pendingBundleId === 'string';
    return {
      lastGeneration: isGeneration(record.lastGeneration)
        ? record.lastGeneration
        : 0,
      confirmed: record.confirmed === true,
      pendingGeneration: hasPending
        ? (record.pendingGeneration as number)
        : undefined,
      pendingBundleId: hasPending
        ? (record.pendingBundleId as string)
        : undefined,
    };
  } catch {
    return { lastGeneration: 0 };
  }
}

function writePairedRecord(
  otaPublicKey: string,
  record: PairedOtaRecord,
): void {
  try {
    localStorage.setItem(
      PAIRED_OTA_RECORD_KEY,
      JSON.stringify({ otaPublicKey, ...record }),
    );
  } catch (e) {
    console.warn('[android-ota] Failed to persist paired generation:', e);
  }
}

function pairedRecordHolds(otaPublicKey: string): boolean {
  try {
    const record = JSON.parse(
      localStorage.getItem(PAIRED_OTA_RECORD_KEY) ?? 'null',
    ) as { otaPublicKey?: unknown } | null;
    return record?.otaPublicKey === otaPublicKey;
  } catch {
    return false;
  }
}

/**
 * Paired server and no bundle of it confirmed yet: the built-in UI must not
 * show its login until the first check (and apply) has run. Once a bundle of
 * this server has served, later launches never wait for the network.
 */
export function androidOtaFirstLoadRequired(): boolean {
  const otaPublicKey = getServerConfig().otaPublicKey;
  if (!isAndroidNative() || !otaPublicKey) return false;
  const record = readPairedRecord(otaPublicKey);
  // Records written before `confirmed` existed prove it by a non-zero floor.
  return !record.confirmed && record.lastGeneration === 0;
}

/** The stored per-server record as written, for undoing a server change. */
export function readPairedOtaRecordRaw(): string | null {
  try {
    return localStorage.getItem(PAIRED_OTA_RECORD_KEY);
  } catch {
    return null;
  }
}

export function writePairedOtaRecordRaw(raw: string | null): void {
  try {
    if (raw === null) localStorage.removeItem(PAIRED_OTA_RECORD_KEY);
    else localStorage.setItem(PAIRED_OTA_RECORD_KEY, raw);
  } catch (e) {
    console.warn('[android-ota] Failed to persist paired generation:', e);
  }
}

/**
 * A bundle handed to the updater joins the floor once that very bundle
 * (`servingBundleId`) is serving, independently of what the server answers
 * afterwards. A different bundle the updater fell back to never confirms it.
 */
function confirmPairedGeneration(
  otaPublicKey: string,
  servingBundleId: string,
): void {
  const record = readPairedRecord(otaPublicKey);
  if (
    record.pendingGeneration === undefined ||
    record.pendingBundleId !== servingBundleId
  ) {
    return;
  }
  writePairedRecord(otaPublicKey, {
    lastGeneration: Math.max(record.lastGeneration, record.pendingGeneration),
    confirmed: true,
  });
}

async function confirmServingPairedGeneration(): Promise<void> {
  const otaPublicKey = getServerConfig().otaPublicKey;
  if (!otaPublicKey) return;
  const { bundle } = await CapacitorUpdater.current();
  if (isBuiltinAndroidBundle(bundle)) return;
  confirmPairedGeneration(otaPublicKey, bundle.id);
}

// Bundle activation and a server change must not interleave: a change that
// looks at the active bundle while a `set` is still in flight would miss it.
let otaActivationQueue: Promise<void> = Promise.resolve();

export function runExclusiveAndroidOtaActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  const run = otaActivationQueue.then(task);
  otaActivationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// `CapacitorUpdater.set` resolves only after the WebView reload has started,
// so this context is about to be replaced by the new bundle's code.
let otaRestartPending = false;

export function androidOtaRestartPending(): boolean {
  return otaRestartPending;
}

// An apply counts from the call until it settles, including the time it waits
// for the activation queue, so a server change can be refused instead of
// queued behind an apply that may still fail or restart the WebView.
let otaApplyInFlight = 0;

export function androidOtaApplyInFlight(): boolean {
  return otaApplyInFlight > 0;
}

function isBuiltinAndroidBundle(bundle: BundleInfo): boolean {
  return bundle.id === 'builtin' || bundle.version === 'builtin';
}

/** Id of the active OTA bundle; null on the built-in bundle or off Android. */
export async function activeAndroidOtaBundleId(): Promise<string | null> {
  if (!isAndroidNative()) return null;
  const { bundle } = await CapacitorUpdater.current();
  return isBuiltinAndroidBundle(bundle) ? null : bundle.id;
}

// Id of the last bundle downloaded for an update that was not applied yet.
let downloadedBundleId: string | null = null;

/** Delete a downloaded-but-not-applied bundle of the previous server. */
async function discardDownloadedAndroidBundle(): Promise<void> {
  const id = downloadedBundleId;
  if (id === null) return;
  downloadedBundleId = null;
  try {
    await CapacitorUpdater.delete({ id });
  } catch (e) {
    // Unreachable once this context ends: only the in-memory handle could
    // apply it, and that is epoch-checked.
    console.warn('[android-ota] Failed to delete the pending download:', e);
  }
}

/**
 * After a server change: forget the per-server generation when it belongs to
 * another key (a server with the same key continues the same sequence, so its
 * floor stays) and leave the
 * previous server's bundle by selecting the APK's built-in one. The new server
 * config must already be saved because the reset reloads the WebView, which
 * ends this JavaScript context. Resolves true when a reset was issued, so the
 * caller must leave its marker for the next start to reconcile. Call it
 * inside `runExclusiveAndroidOtaActivation`.
 *
 * Safe to repeat under any saved config, which is why an interrupted change
 * is finished at the next start instead of being undone.
 */
export async function resetAndroidOtaForServerChange(): Promise<boolean> {
  await discardDownloadedAndroidBundle();
  const otaPublicKey = getServerConfig().otaPublicKey;
  if (!otaPublicKey || !pairedRecordHolds(otaPublicKey)) {
    writePairedOtaRecordRaw(null);
  }
  if ((await activeAndroidOtaBundleId()) === null) return false;
  await CapacitorUpdater.reset({ toLastSuccessful: false });
  otaRestartPending = true;
  return true;
}

function assertServerConfigCurrent(epoch: number): void {
  if (getServerConfigEpoch() !== epoch) {
    throw new Error(
      'Server configuration changed during the Android OTA update',
    );
  }
}

export type AndroidOtaCheckResult =
  | { kind: 'unavailable'; reason: AndroidOtaUnavailableReason }
  | { kind: 'current'; version: string }
  | {
      kind: 'incompatible';
      requiredNativeVersionCode: number;
      nativeVersionCode: number;
    }
  | { kind: 'ready'; update: AndroidOtaReady };

export function androidOtaSigningPayload(
  value: Pick<
    AndroidOtaManifest,
    | 'version'
    | 'checksum'
    | 'size'
    | 'requiredNativeVersionCode'
    | 'bundleGeneration'
  >,
): string {
  return [
    value.version,
    value.checksum,
    value.size,
    value.requiredNativeVersionCode,
    ...(value.bundleGeneration === undefined ? [] : [value.bundleGeneration]),
  ].join('\n');
}

function isManifest(value: unknown): value is AndroidOtaManifest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.version === 'string' &&
    /^[a-f0-9]{24}$/.test(item.version) &&
    typeof item.url === 'string' &&
    item.url.startsWith('/android-updates/bundles/') &&
    typeof item.checksum === 'string' &&
    /^[a-f0-9]{64}$/.test(item.checksum) &&
    typeof item.signature === 'string' &&
    item.signature.length > 0 &&
    Number.isSafeInteger(item.size) &&
    Number(item.size) > 0 &&
    Number.isSafeInteger(item.requiredNativeVersionCode) &&
    Number(item.requiredNativeVersionCode) > 0 &&
    (item.bundleGeneration === undefined ||
      (Number.isSafeInteger(item.bundleGeneration) &&
        Number(item.bundleGeneration) >= 0))
  );
}

export function verifyAndroidOtaManifest(
  manifest: AndroidOtaManifest,
  publicKey: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(androidOtaSigningPayload(manifest)),
      base64ToBytes(manifest.signature),
      base64ToBytes(publicKey),
    );
  } catch {
    return false;
  }
}

export function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function notifyAndroidOtaReady(): Promise<void> {
  if (!isAndroidNative()) return;
  await CapacitorUpdater.notifyAppReady();
  // Best effort: an unconfirmed bundle is simply confirmed at a later start.
  await confirmServingPairedGeneration().catch((error) =>
    console.warn(
      '[android-ota] Could not confirm the paired generation',
      error,
    ),
  );
}

export function compareAndroidBundleGenerations(
  current: number,
  candidate: number,
): 'newer' | 'same' | 'older' | 'unknown' {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(candidate))
    return 'unknown';
  if (candidate > current) return 'newer';
  if (candidate < current) return 'older';
  return 'same';
}

/**
 * Resolve the generation of the bundle that CapacitorUpdater is actually
 * serving. The local Capacitor asset server serves this file from the active
 * bundle, so this must not be replaced with the APK's embedded generation.
 * Unknown active OTA metadata is fail-closed by the caller.
 */
export async function readActiveAndroidBundleGeneration(
  current: BundleInfo,
  builtinGeneration: number,
): Promise<number | null> {
  const isBuiltin = isBuiltinAndroidBundle(current);
  if (isBuiltin) return builtinGeneration;
  try {
    const response = await fetch('/android-ota-bundle.json', {
      cache: 'no-store',
    });
    // Bundles published before generation metadata was introduced do not
    // contain this file. They are the authenticated legacy generation-0
    // floor, so a newer signed generation can migrate them in place.
    if (response.status === 404) return 0;
    if (!response.ok) return null;
    const metadata = (await response.json()) as {
      bundleGeneration?: unknown;
    };
    return Number.isSafeInteger(metadata.bundleGeneration) &&
      Number(metadata.bundleGeneration) >= 0
      ? Number(metadata.bundleGeneration)
      : null;
  } catch {
    return null;
  }
}

interface AndroidOtaRuntimeInfo {
  current: Awaited<ReturnType<typeof CapacitorUpdater.current>>;
  currentVersion: string;
  currentGeneration: number | null;
}

/** Query and log updater state without depending on the OTA server. */
async function readAndroidOtaRuntimeInfo(
  shell: Awaited<ReturnType<typeof CarapaBridge.getOtaShellInfo>>,
): Promise<AndroidOtaRuntimeInfo> {
  const current = await CapacitorUpdater.current();
  const currentVersion = isBuiltinAndroidBundle(current.bundle)
    ? shell.builtinBundleVersion
    : current.bundle.version;
  const currentGeneration = await readActiveAndroidBundleGeneration(
    current.bundle,
    shell.builtinBundleGeneration,
  );
  // Also logged before sign-in (the sidebar line needs a signed-in UI).
  console.info(
    `[carapa-build] web build ${import.meta.env.VITE_BUILD_COMMIT || 'development'}`,
  );
  console.info(
    '[carapa-ota-runtime]',
    JSON.stringify({
      activeBundleId: current.bundle.id,
      activeBundleVersion: currentVersion,
      activeGeneration: currentGeneration,
      builtinBundleVersion: shell.builtinBundleVersion,
      builtinGeneration: shell.builtinBundleGeneration,
      nativeVersionCode: shell.nativeVersionCode,
      nativeVersionName: shell.nativeVersionName,
      webBuild: import.meta.env.VITE_BUILD_COMMIT || 'development',
    }),
  );
  return { current, currentVersion, currentGeneration };
}

export async function checkAndDownloadAndroidOta(): Promise<AndroidOtaCheckResult> {
  if (!isAndroidNative()) return { kind: 'unavailable', reason: 'not-native' };

  const configEpoch = getServerConfigEpoch();
  const pairedKey = getServerConfig().otaPublicKey;
  const shell = await CarapaBridge.getOtaShellInfo();
  const activation = await CarapaBridge.consumeEmbeddedBundleActivation();
  // A paired server's first load needs its own bundle, not the built-in one.
  const firstLoad = androidOtaFirstLoadRequired();
  if (activation.activate) {
    // reset() reloads the WebView, which ends this JS context before the
    // acknowledgement below. The reloaded page finds the marker again with
    // the built-in bundle already active, so it only acknowledges it and
    // goes on to log the runtime evidence install-apk.sh inspects.
    const active = await CapacitorUpdater.current();
    if (!isBuiltinAndroidBundle(active.bundle)) {
      await CapacitorUpdater.reset({ toLastSuccessful: false });
    }
    await CarapaBridge.acknowledgeEmbeddedBundleActivation();
    if (!firstLoad) {
      await readAndroidOtaRuntimeInfo(shell);
      return { kind: 'current', version: shell.builtinBundleVersion };
    }
  }
  const runtime = await readAndroidOtaRuntimeInfo(shell);
  const verificationKey = pairedKey || shell.publicKey;
  if (!verificationKey) {
    console.warn(
      '[android-ota] APK has no embedded OTA public key; updates are disabled',
    );
    return { kind: 'unavailable', reason: 'no-key' };
  }

  // A fresh install without a server has no address to ask.
  if (!isServerConfigured())
    return { kind: 'unavailable', reason: 'no-server' };

  const response = await CapacitorHttp.get({
    url: `${API_BASE_URL}/android-updates/latest.json`,
    responseType: 'json',
  });
  assertServerConfigCurrent(configEpoch);
  // Older native shells receiving this bundle by OTA lack the pin methods.
  const pin = await CarapaBridge.getEmbeddedBundlePin().catch(() => ({
    pending: false as const,
    generation: undefined,
    builtinVersion: undefined,
  }));
  if (response.status === 404) {
    if (pin.pending && !pairedKey) {
      await CarapaBridge.setEmbeddedBundlePin({
        generation: 0,
        builtinVersion: shell.builtinBundleVersion,
      });
    }
    return { kind: 'unavailable', reason: 'not-published' };
  }
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !isManifest(response.data)
  ) {
    throw new Error(
      `Invalid Android OTA manifest response (${response.status})`,
    );
  }
  const rawManifest = response.data as AndroidOtaManifest;
  if (!verifyAndroidOtaManifest(rawManifest, verificationKey)) {
    throw new Error('Android OTA manifest signature verification failed');
  }
  const manifest = {
    ...rawManifest,
    bundleGeneration: Number(rawManifest.bundleGeneration ?? 0),
  };
  // An APK installed by install-apk.sh was chosen over whatever the server
  // had already published; only a later publish is an update for it.
  let pinnedGeneration =
    pin.builtinVersion === shell.builtinBundleVersion &&
    Number.isSafeInteger(pin.generation)
      ? Number(pin.generation)
      : 0;
  if (pin.pending && !pairedKey) {
    await CarapaBridge.setEmbeddedBundlePin({
      generation: manifest.bundleGeneration,
      builtinVersion: shell.builtinBundleVersion,
    });
    pinnedGeneration = manifest.bundleGeneration;
  }
  // A shell newer than the bundle's required version stays compatible: the
  // generation ordering below decides whether the bundle is an update.
  if (manifest.requiredNativeVersionCode > shell.nativeVersionCode) {
    return {
      kind: 'incompatible',
      requiredNativeVersionCode: manifest.requiredNativeVersionCode,
      nativeVersionCode: shell.nativeVersionCode,
    };
  }
  // An active OTA without authenticated generation metadata cannot safely be
  // ordered against the server manifest. Keep it active rather than risking a
  // downgrade; the next APK install's embedded-bundle activation can recover.
  if (runtime.currentGeneration === null) {
    return { kind: 'current', version: runtime.currentVersion };
  }
  const builtinActive = isBuiltinAndroidBundle(runtime.current.bundle);
  const ordering = compareAndroidBundleGenerations(
    pairedKey
      ? readPairedRecord(pairedKey).lastGeneration
      : builtinActive
        ? Math.max(runtime.currentGeneration, pinnedGeneration)
        : runtime.currentGeneration,
    manifest.bundleGeneration,
  );
  // On a paired first load the built-in bundle is never "current", even when
  // its version equals the manifest's: only the server's own bundle is.
  if (
    !(firstLoad && builtinActive) &&
    (runtime.currentVersion === manifest.version || ordering !== 'newer')
  ) {
    return { kind: 'current', version: manifest.version };
  }

  const bundle = await CapacitorUpdater.download({
    version: manifest.version,
    url: new URL(manifest.url, `${API_BASE_URL}/`).toString(),
    checksum: manifest.checksum,
  });
  downloadedBundleId = bundle.id;
  assertServerConfigCurrent(configEpoch);
  return {
    kind: 'ready',
    update: { manifest, bundle, pairedKey, configEpoch },
  };
}

export function applyAndroidOta(update: AndroidOtaReady): Promise<void> {
  otaApplyInFlight += 1;
  return runExclusiveAndroidOtaActivation(async () => {
    assertServerConfigCurrent(update.configEpoch);
    requestNativeBootLock();
    if (downloadedBundleId === update.bundle.id) downloadedBundleId = null;
    const { pairedKey } = update;
    const previousRecord = readPairedOtaRecordRaw();
    try {
      if (pairedKey) {
        writePairedRecord(pairedKey, {
          ...readPairedRecord(pairedKey),
          pendingGeneration: Number(update.manifest.bundleGeneration ?? 0),
          pendingBundleId: update.bundle.id,
        });
      }
      await CapacitorUpdater.set(update.bundle);
      otaRestartPending = true;
    } catch (error) {
      if (pairedKey) writePairedOtaRecordRaw(previousRecord);
      cancelNativeBootLock();
      throw error;
    }
  }).finally(() => {
    otaApplyInFlight -= 1;
  });
}
