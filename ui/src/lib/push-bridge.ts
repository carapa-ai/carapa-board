import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core';
import type { ServerConfig } from '@/lib/api-config';

export interface KeystoreInfo {
  hasKey: boolean;
  isInsideSecureHardware: boolean | null;
  securityLevel:
    | 'SOFTWARE'
    | 'TRUSTED_ENVIRONMENT'
    | 'STRONGBOX'
    | 'UNKNOWN'
    | 'UNKNOWN_SECURE'
    | string
    | null;
}

interface AppPinVerifyResultNative {
  ok: boolean;
  reason?: 'no_pin' | 'wrong' | 'kill_switch' | 'duress';
  failedAttempts?: number;
  attemptsRemaining?: number;
}

interface AppPinStatusNative {
  hasPin: boolean;
  hasDuressPin: boolean;
  failedAttempts: number;
  attemptsRemaining: number;
}

interface CarapaBridgePlugin {
  getOtaShellInfo(): Promise<{
    nativeVersionCode: number;
    nativeVersionName: string;
    builtinBundleVersion: string;
    builtinBundleGeneration: number;
    publicKey: string;
  }>;
  consumeEmbeddedBundleActivation(): Promise<{ activate: boolean }>;
  acknowledgeEmbeddedBundleActivation(): Promise<void>;
  getEmbeddedBundlePin(): Promise<{
    pending: boolean;
    generation?: number;
    builtinVersion?: string;
  }>;
  setEmbeddedBundlePin(args: {
    generation: number;
    builtinVersion: string;
  }): Promise<void>;
  setServerPins(args: {
    pins: { origin: string; certSha256: string }[];
  }): Promise<void>;
  bootstrapDevice(args: {
    apiBase: string;
    remoteApiBase?: string;
  }): Promise<{ deviceId: string; publicKey: string }>;
  clearCredentials(): Promise<void>;
  signPayload(args: {
    payload: string;
  }): Promise<{ signature: string; deviceId: string }>;
  hasCredentials(): Promise<{ hasCredentials: boolean }>;
  getKeystoreInfo(): Promise<KeystoreInfo>;
  canVerifyUser(): Promise<{ canVerify: boolean; code: number }>;
  verifyUser(args: {
    title?: string;
    subtitle?: string;
  }): Promise<{ ok: boolean }>;
  setAppPin(args: { userId: string; pin: string }): Promise<void>;
  verifyAppPin(args: {
    userId: string;
    pin: string;
  }): Promise<AppPinVerifyResultNative>;
  hasAppPin(args: { userId: string }): Promise<{ hasPin: boolean }>;
  appPinStatus(args: { userId: string }): Promise<AppPinStatusNative>;
  resetAppPinAttempts(args: { userId: string }): Promise<void>;
  clearAppPin(args: { userId: string }): Promise<void>;
  setAppDuressPin(args: { userId: string; pin: string }): Promise<void>;
  hasAppDuressPin(args: { userId: string }): Promise<{ hasDuressPin: boolean }>;
  clearAppDuressPin(args: { userId: string }): Promise<void>;
  dismissNotification(args: { payloadId: string }): Promise<void>;
  resetFcmToken(): Promise<void>;
  isPushAvailable(): Promise<{ available: boolean }>;
  cacheSpeech(args: {
    conversationId: string;
    messageId: string;
  }): Promise<{ uri: string }>;
  enqueueSpeech(args: {
    conversationId: string;
    messageId: string;
    sessionId: string;
  }): Promise<void>;
  activateSpeechSession(args: { sessionId: string }): Promise<void>;
  stopSpeech(args: { sessionId: string }): Promise<void>;
  addListener(
    eventName: 'notifTap',
    listenerFunc: (event: { notifId: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechPlayback',
    listenerFunc: (event: {
      messageId: string;
      conversationId: string;
      sessionId: string;
      phase: 'started' | 'completed' | 'failed';
    }) => void,
  ): Promise<PluginListenerHandle>;
}

export type AppPinVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_pin' }
  | {
      ok: false;
      reason: 'wrong';
      failedAttempts: number;
      attemptsRemaining: number;
    }
  | { ok: false; reason: 'kill_switch'; failedAttempts: number }
  | { ok: false; reason: 'duress' }
  | { ok: false; reason: 'error'; message?: string };

export type SetDuressPinResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'no_normal_pin' | 'same_as_normal' | 'length' | 'error';
      message?: string;
    };

/** Native bridge — only meaningful on Android. No-op on web/iOS. */
export const CarapaBridge = registerPlugin<CarapaBridgePlugin>('CarapaBridge');

/**
 * Give native code the certificate pins for the configured addresses (an
 * empty list clears them). The pin is an additional trust anchor for exactly
 * that origin, used by the WebView and native HTTP. Rejects when native could
 * not store them; no-op off Android.
 */
export async function syncServerPins(config: ServerConfig): Promise<void> {
  if (!isBridgeSupported()) return;
  const pins = new Map<string, { origin: string; certSha256: string }>();
  for (const key of ['home', 'remote'] as const) {
    const origin = config[`${key}Url`];
    const certSha256 = config[`${key}CertSha256`];
    if (origin && certSha256) {
      pins.set(`${origin} ${certSha256}`, { origin, certSha256 });
    }
  }
  await CarapaBridge.setServerPins({ pins: [...pins.values()] });
}

export async function cacheNativeSpeech(
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  if (!isBridgeSupported()) return null;
  try {
    const result = await CarapaBridge.cacheSpeech({
      conversationId,
      messageId,
    });
    return result.uri ? Capacitor.convertFileSrc(result.uri) : null;
  } catch (error) {
    console.warn('[speech-bridge] native cache download failed', error);
    return null;
  }
}

// JS-side view of native (ExoPlayer) reply audio, so Live Mode can tell when
// the speakers are playing. Set on accepted enqueue, promoted on the native
// `started` event, cleared by `completed`/`failed` or stopNativeSpeech. Entries
// also expire so a lost event cannot pin the flag on forever.
const NATIVE_SPEECH_PENDING_MAX_MS = 30_000;
const NATIVE_SPEECH_STARTED_MAX_MS = 5 * 60_000;
const nativeSpeechPlayback = new Map<
  string,
  { sessionId: string; at: number; started: boolean }
>();

export function isNativeSpeechPlaying(now = Date.now()): boolean {
  for (const [messageId, entry] of nativeSpeechPlayback) {
    const maxAge = entry.started
      ? NATIVE_SPEECH_STARTED_MAX_MS
      : NATIVE_SPEECH_PENDING_MAX_MS;
    if (now - entry.at > maxAge) nativeSpeechPlayback.delete(messageId);
    else return true;
  }
  return false;
}

// Message ids whose native playback the user deliberately cut off. A later
// live_queue snapshot may still list them as playing/released; refusing to
// enqueue them again keeps the interrupted reply from restarting.
const CUT_NATIVE_SPEECH_MAX = 50;
const cutNativeSpeechMessageIds = new Set<string>();

function rememberCutNativeSpeech(messageId: string): void {
  cutNativeSpeechMessageIds.delete(messageId);
  cutNativeSpeechMessageIds.add(messageId);
  if (cutNativeSpeechMessageIds.size > CUT_NATIVE_SPEECH_MAX) {
    const oldest = cutNativeSpeechMessageIds.values().next().value;
    if (oldest !== undefined) cutNativeSpeechMessageIds.delete(oldest);
  }
}

export async function enqueueNativeSpeech(
  conversationId: string,
  messageId: string,
  sessionId: string,
): Promise<boolean> {
  if (!isBridgeSupported()) return false;
  if (cutNativeSpeechMessageIds.has(messageId)) return false;
  try {
    console.debug('[speech-bridge] enqueue requested', {
      conversationId,
      messageId,
      sessionId,
    });
    await CarapaBridge.enqueueSpeech({ conversationId, messageId, sessionId });
    console.debug('[speech-bridge] enqueue accepted', {
      conversationId,
      messageId,
      sessionId,
    });
    nativeSpeechPlayback.set(messageId, {
      sessionId,
      at: Date.now(),
      started: false,
    });
    return true;
  } catch (error) {
    console.warn('[speech-bridge] enqueue failed', error);
    return false;
  }
}

export async function activateNativeSpeechSession(
  sessionId: string,
): Promise<void> {
  if (!isBridgeSupported()) return;
  await CarapaBridge.activateSpeechSession({ sessionId });
}

export async function stopNativeSpeech(sessionId: string): Promise<void> {
  if (!isBridgeSupported()) return;
  for (const [messageId, entry] of nativeSpeechPlayback) {
    if (entry.sessionId === sessionId) nativeSpeechPlayback.delete(messageId);
  }
  await CarapaBridge.stopSpeech({ sessionId }).catch(() => undefined);
}

/**
 * Stop every native reply the user is interrupting (barge-in) and remember the
 * cut messages so they are not re-enqueued. No-op when nothing is playing.
 */
export async function stopActiveNativeSpeech(): Promise<void> {
  if (!isBridgeSupported()) return;
  const sessionIds = new Set<string>();
  for (const [messageId, entry] of nativeSpeechPlayback) {
    sessionIds.add(entry.sessionId);
    rememberCutNativeSpeech(messageId);
  }
  // Native stop() parks the service in STOPPED_SESSION, which rejects every
  // later enqueue. Re-claim the same session so the next reply still plays.
  await Promise.all(
    [...sessionIds].map(async (id) => {
      await stopNativeSpeech(id);
      await activateNativeSpeechSession(id).catch(() => undefined);
    }),
  );
}

export function isBridgeSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/**
 * Lazily generate a Keystore-bound P-256 device keypair (if needed) and
 * a stable deviceId, persisting the apiBase for the FCM service. Returns
 * `{ deviceId, publicKey }` for server registration. Idempotent.
 *
 * The private key is generated INSIDE the Android Keystore and never
 * leaves the secure element on hardware-backed devices. JS receives only
 * the SPKI base64 public key.
 */
export async function bootstrapDeviceNative(
  apiBase: string,
  remoteApiBase?: string,
): Promise<{ deviceId: string; publicKey: string; error?: string } | null> {
  if (!isBridgeSupported()) return null;
  try {
    const { deviceId, publicKey } = await CarapaBridge.bootstrapDevice({
      apiBase,
      remoteApiBase,
    });
    if (!deviceId || !publicKey) return null;
    return { deviceId, publicKey };
  } catch (err) {
    console.warn('[push-bridge] bootstrapDevice failed', err);
    const message = err instanceof Error ? err.message : String(err);
    return { deviceId: '', publicKey: '', error: message };
  }
}

/**
 * Wipe the Keystore alias and persisted device metadata. Use only for
 * "reset device identity" flows — NOT regular logout (the keypair is
 * per-device, not per-session).
 *
 * Failures are logged and swallowed unless `strict` is set.
 */
export async function clearNativeCredentials(
  options: { strict?: boolean } = {},
): Promise<void> {
  if (!isBridgeSupported()) return;
  try {
    await CarapaBridge.clearCredentials();
  } catch (err) {
    console.warn('[push-bridge] clearCredentials failed', err);
    // Callers that must not proceed with credentials left behind opt in.
    if (options.strict) throw err;
  }
}

/**
 * Sign a request payload using the Keystore-bound device private key.
 * The key never exists in JS memory — JS receives only the signature.
 * Returns null on platforms without the bridge (web/iOS) or when the
 * device has not yet been bootstrapped.
 */
export async function nativeSignPayload(
  payload: string,
): Promise<{ signature: string; deviceId: string } | null> {
  if (!isBridgeSupported()) return null;
  try {
    const { signature, deviceId } = await CarapaBridge.signPayload({ payload });
    if (!signature || !deviceId) return null;
    return { signature, deviceId };
  } catch {
    return null;
  }
}

/**
 * Reports whether the device has a usable Keystore-bound key AND
 * persisted deviceId/apiBase. Used by the login flow to decide whether
 * to bootstrap.
 */
export async function hasNativeCredentials(): Promise<boolean> {
  if (!isBridgeSupported()) return false;
  try {
    const { hasCredentials } = await CarapaBridge.hasCredentials();
    return !!hasCredentials;
  } catch {
    return false;
  }
}

/**
 * Diagnostic — returns where the device key actually lives:
 * SOFTWARE | TRUSTED_ENVIRONMENT | STRONGBOX. Useful for surfacing in
 * settings UI or for an in-app warning when only software-backed
 * Keystore is available.
 */
export async function getKeystoreInfo(): Promise<KeystoreInfo | null> {
  if (!isBridgeSupported()) return null;
  try {
    return await CarapaBridge.getKeystoreInfo();
  } catch {
    return null;
  }
}

/**
 * Reports whether the device has any acceptable unlock method —
 * biometric OR the screen-lock PIN/pattern/password. Used by the lock
 * subsystem to decide whether engaging the lock would trap a user with
 * no way to authenticate.
 */
export async function nativeCanVerifyUser(): Promise<boolean> {
  if (!isBridgeSupported()) return false;
  try {
    const { canVerify } = await CarapaBridge.canVerifyUser();
    return !!canVerify;
  } catch {
    return false;
  }
}

let tapListenerHandle: PluginListenerHandle | null = null;
let speechListenerHandle: PluginListenerHandle | null = null;

export async function attachNativeSpeechPlaybackListener(
  listener: (event: {
    messageId: string;
    conversationId: string;
    sessionId: string;
    phase: 'started' | 'completed' | 'failed';
  }) => void,
): Promise<void> {
  if (!isBridgeSupported() || speechListenerHandle) return;
  try {
    speechListenerHandle = await CarapaBridge.addListener(
      'speechPlayback',
      (event) => {
        if (event.phase === 'started') {
          nativeSpeechPlayback.set(event.messageId, {
            sessionId: event.sessionId,
            at: Date.now(),
            started: true,
          });
        } else {
          nativeSpeechPlayback.delete(event.messageId);
        }
        listener(event);
      },
    );
  } catch (error) {
    console.warn('[speech-bridge] playback listener failed', error);
  }
}

/**
 * Subscribe to taps on rich notifications posted by the native FCM service.
 * On tap, MainActivity forwards the payload id here. Idempotent — multiple
 * init calls only attach one listener. The consumer applies the auth gate and
 * opens the shared in-shell overlay after unlock.
 */
export async function attachNotifTapListener(
  open: (payloadId: string) => void,
): Promise<void> {
  if (!isBridgeSupported() || tapListenerHandle) return;
  try {
    tapListenerHandle = await CarapaBridge.addListener(
      'notifTap',
      ({ notifId }) => {
        if (!notifId) return;
        try {
          open(notifId);
        } catch (err) {
          console.warn(
            '[push-bridge] opening notification overlay from notifTap failed',
            err,
          );
        }
      },
    );
  } catch (err) {
    console.warn('[push-bridge] addListener notifTap failed', err);
  }
}

/**
 * Dismiss the system-tray notification for a payload that was acked
 * elsewhere (e.g. submitted via the in-app bell or another device). No-op
 * on web/iOS since only Android renders rich native notifications.
 */
export async function dismissNativeNotification(
  payloadId: string,
): Promise<void> {
  if (!isBridgeSupported() || !payloadId) return;
  try {
    await CarapaBridge.dismissNotification({ payloadId });
  } catch (err) {
    console.warn('[push-bridge] dismissNotification failed', err);
  }
}

// ──── App PIN ──────────────────────────────────────────────────────
// A second factor that gates app access independently of the device's
// screen-lock PIN/biometric. The PIN is stored as HMAC(pin, K) where K
// is a non-extractable Keystore-bound key — verification requires
// access to this device. After 3 wrong entries the kill-switch fires:
// the Keystore device-handshake key + persisted creds are wiped, the
// user is forced through full re-login, and a fresh device is bootstrapped.
// The PIN itself survives so the legitimate user re-logs in with it.
//
// On platforms without the bridge (web/iOS) all of these report
// "not supported" — callers should fall back to a no-PIN policy
// there, since we can't replicate the secure-storage guarantees.

export async function nativeSetAppPin(
  userId: string,
  pin: string,
): Promise<{ ok: true } | { ok: false; message?: string }> {
  if (!isBridgeSupported())
    return { ok: false, message: 'bridge not supported' };
  if (!userId) return { ok: false, message: 'userId is required' };
  try {
    await CarapaBridge.setAppPin({ userId, pin });
    return { ok: true };
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, message: e?.message };
  }
}

export async function nativeVerifyAppPin(
  userId: string,
  pin: string,
): Promise<AppPinVerifyResult> {
  if (!isBridgeSupported()) {
    return { ok: false, reason: 'error', message: 'bridge not supported' };
  }
  if (!userId) {
    return { ok: false, reason: 'error', message: 'userId is required' };
  }
  try {
    const r = await CarapaBridge.verifyAppPin({ userId, pin });
    if (r.ok) return { ok: true };
    if (r.reason === 'no_pin') return { ok: false, reason: 'no_pin' };
    if (r.reason === 'wrong') {
      return {
        ok: false,
        reason: 'wrong',
        failedAttempts: r.failedAttempts ?? 0,
        attemptsRemaining: r.attemptsRemaining ?? 0,
      };
    }
    if (r.reason === 'kill_switch') {
      return {
        ok: false,
        reason: 'kill_switch',
        failedAttempts: r.failedAttempts ?? 0,
      };
    }
    if (r.reason === 'duress') {
      return { ok: false, reason: 'duress' };
    }
    return { ok: false, reason: 'error' };
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, reason: 'error', message: e?.message };
  }
}

export async function nativeHasAppPin(userId: string): Promise<boolean> {
  if (!isBridgeSupported() || !userId) return false;
  try {
    const { hasPin } = await CarapaBridge.hasAppPin({ userId });
    return !!hasPin;
  } catch {
    return false;
  }
}

/**
 * Reset the failed-attempt counter to 0 for [userId]. Call after a
 * successful login so the user gets a fresh quota of
 * [KILL_SWITCH_THRESHOLD] attempts — in particular, the kill-switch
 * deliberately leaves the counter at 3 to prevent repeated 3-attempt
 * brute-force batches; only login resets it.
 */
export async function nativeResetAppPinAttempts(userId: string): Promise<void> {
  if (!isBridgeSupported() || !userId) return;
  try {
    await CarapaBridge.resetAppPinAttempts({ userId });
  } catch {
    /* best-effort */
  }
}

// ──── Duress PIN ───────────────────────────────────────────────────
// A second PIN that, when entered on the lock screen, triggers a duress
// alert to the user's main agent and atomically wipes the device's
// session (kill-switch). To the attacker watching the screen this looks
// indistinguishable from a real network outage. To the agent, it's a
// signal to act on per-user instructions configured separately.

export async function nativeSetDuressPin(
  userId: string | null | undefined,
  pin: string,
): Promise<SetDuressPinResult> {
  if (!isBridgeSupported())
    return { ok: false, reason: 'error', message: 'bridge not supported' };
  if (!userId)
    return { ok: false, reason: 'error', message: 'userId is required' };
  try {
    await CarapaBridge.setAppDuressPin({ userId, pin });
    return { ok: true };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    const msg = (e?.message ?? '').toLowerCase();
    if (msg.includes('normal pin must be set')) {
      return { ok: false, reason: 'no_normal_pin', message: e.message };
    }
    if (msg.includes('must differ from the normal pin')) {
      return { ok: false, reason: 'same_as_normal', message: e.message };
    }
    if (e?.code === 'PIN_LENGTH') {
      return { ok: false, reason: 'length', message: e.message };
    }
    return { ok: false, reason: 'error', message: e?.message };
  }
}

export async function nativeHasDuressPin(
  userId: string | null | undefined,
): Promise<boolean> {
  if (!isBridgeSupported() || !userId) return false;
  try {
    const { hasDuressPin } = await CarapaBridge.hasAppDuressPin({ userId });
    return !!hasDuressPin;
  } catch {
    return false;
  }
}

export async function nativeClearDuressPin(
  userId: string | null | undefined,
): Promise<void> {
  if (!isBridgeSupported() || !userId) return;
  try {
    await CarapaBridge.clearAppDuressPin({ userId });
  } catch {
    /* best-effort */
  }
}

export async function nativeClearAppPin(
  userId: string | null | undefined,
): Promise<void> {
  if (!isBridgeSupported() || !userId) return;
  try {
    await CarapaBridge.clearAppPin({ userId });
  } catch {
    /* ignore — best-effort wipe */
  }
}

/** Delete the Firebase instance token natively (Android only). */
export async function resetNativeFcmToken(): Promise<boolean> {
  if (!isBridgeSupported()) return false;
  try {
    await CarapaBridge.resetFcmToken();
    return true;
  } catch (err) {
    console.warn('[push-bridge] resetFcmToken failed', err);
    return false;
  }
}

/**
 * False only when the native shell reports that Firebase is not configured
 * (APK built without google-services.json). A shell that predates the check
 * counts as available, as before.
 */
export async function isNativePushAvailable(): Promise<boolean> {
  if (!isBridgeSupported()) return true;
  try {
    return (await CarapaBridge.isPushAvailable()).available;
  } catch {
    return true;
  }
}

export async function detachNotifTapListener(): Promise<void> {
  const h = tapListenerHandle;
  tapListenerHandle = null;
  if (h) {
    try {
      await h.remove();
    } catch {
      /* ignore */
    }
  }
}
