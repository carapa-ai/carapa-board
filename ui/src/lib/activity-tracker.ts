import { Capacitor } from '@capacitor/core';
import { NativeBiometric } from 'capacitor-native-biometric';
import { nativeCanVerifyUser } from './push-bridge';

// Two timestamps with deliberately different lifecycles.
//
// `lastUserInputAt` — module-scoped only. Set ONLY by genuine DOM input
// events (never by network traffic, polling, WS invalidations, or
// localStorage). localStorage was the previous design and it leaked: any
// background apiFetch could refresh it, making `isUserActive()` return
// true even when the user wasn't present. A hard page reload also carried
// a stale timestamp forward, so a fresh WebView looked "active" without
// anyone touching it. Used for notification-tap navigation, where the
// guarantee is "the human is currently here, looking at the screen."
//
// `lastHiddenAt` — module scope AND mirrored to localStorage. Set ONLY by
// `visibilitychange → hidden`, so the network-leak failure mode does not
// apply: nothing else writes to it. Persistence is REQUIRED on Android,
// because tapping share→Carapa from another app may relaunch the Activity
// with a new intent, which reloads the WebView and resets module state.
// Without persistence, the share-sheet flow would always cold-boot into
// the lock screen — which is exactly the bug the user kept reporting.
// Persistence is safe here because the threat ("attacker forges a recent
// hide timestamp") requires write access to app-private localStorage,
// which already implies app-level compromise.

const ACTIVITY_THRESHOLD_MS = 60_000;
const HIDDEN_AT_KEY = 'last_hidden_at_v1';

const INPUT_EVENTS: ReadonlyArray<keyof DocumentEventMap> = [
  'pointerdown',
  'keydown',
  'touchstart',
];

function loadPersistedHiddenAt(): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const raw = localStorage.getItem(HIDDEN_AT_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function persistHiddenAt(ts: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (ts > 0) localStorage.setItem(HIDDEN_AT_KEY, String(ts));
    else localStorage.removeItem(HIDDEN_AT_KEY);
  } catch {
    /* ignore */
  }
}

let lastUserInputAt = 0;
let lastHiddenAt = loadPersistedHiddenAt();
let installed = false;

function onInput() {
  lastUserInputAt = Date.now();
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    lastHiddenAt = Date.now();
    persistHiddenAt(lastHiddenAt);
  }
}

export function installActivityTracker(): void {
  if (installed) return;
  installed = true;
  for (const evt of INPUT_EVENTS) {
    document.addEventListener(evt, onInput, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);
}

export function markUserActive(): void {
  lastUserInputAt = Date.now();
}

export function isUserActive(
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  if (lastUserInputAt === 0) return false;
  return Date.now() - lastUserInputAt < thresholdMs;
}

// True iff the app was hidden recently enough to skip re-locking on
// refocus. Returns false when we have no record of a hide (fresh WebView,
// or first focus after process start) — that case must engage the lock to
// match the "fresh process must re-authenticate" invariant.
export function wasHiddenWithinGrace(
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  if (lastHiddenAt === 0) return false;
  return Date.now() - lastHiddenAt < thresholdMs;
}

// Two cached flags, both set ONCE at boot and never re-queried:
//
// - `biometricAvailable`: true iff the device has biometric enrolled.
//   Used by the LoginForm to decide whether to render the "Login with
//   Biometrics" shortcut (Android restores a device-bound session;
//   other native platforms use saved account credentials).
//
// - `unlockAvailable`: true iff the device can prompt the user for
//   biometric OR screen-lock credential (PIN/pattern/password). Used
//   by lock-engagement decisions — engaging the lock is only safe if
//   we know a way to release it.
//
// Re-querying after a failed attempt is unsafe: some Android OEMs report
// false during a post-cancel cooldown, which would silently retract the
// lock and let an unauthenticated user past the gate. The underlying
// hardware/credential state doesn't change at runtime, so the boot-time
// snapshot is the only safe source of truth.
let biometricAvailable: boolean | null = null;
let unlockAvailable: boolean | null = null;
let initPromise: Promise<void> | null = null;

async function initAvailability(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    biometricAvailable = false;
    unlockAvailable = false;
    return;
  }
  try {
    const result = await NativeBiometric.isAvailable();
    biometricAvailable = !!result.isAvailable;
  } catch {
    biometricAvailable = false;
  }
  // On Android, the bridge asks BiometricManager.canAuthenticate with
  // BIOMETRIC_WEAK | DEVICE_CREDENTIAL — true if EITHER biometric or a
  // screen-lock PIN is set up. On platforms without the bridge, fall
  // back to "biometric only" — iOS / web don't have a comparable
  // device-credential prompt for this flow.
  if (Capacitor.getPlatform() === 'android') {
    unlockAvailable = await nativeCanVerifyUser();
  } else {
    unlockAvailable = biometricAvailable;
  }
}

export async function initBiometricAvailability(): Promise<boolean> {
  if (biometricAvailable !== null && unlockAvailable !== null) {
    return biometricAvailable;
  }
  if (!initPromise) initPromise = initAvailability();
  await initPromise;
  return biometricAvailable === true;
}

export function isBiometricAvailableCached(): boolean {
  return biometricAvailable === true;
}

/**
 * True iff the device has at least one acceptable unlock method —
 * biometric OR screen-lock credential. Use this for any decision about
 * whether to ENGAGE the lock; engaging it on a device with no auth
 * method would just trap the user.
 */
export function isUnlockAvailableCached(): boolean {
  return unlockAvailable === true;
}
