import { Capacitor } from '@capacitor/core';
import {
  PushNotifications,
  type PushNotificationSchema,
  type Token,
} from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { toast } from 'sonner';
import { apiFetch } from './api';
import { API_BASE_URL } from './api-config';
import { useAuth } from './auth';
import { closeNotification, openNotification } from './notification-overlay';
import { router } from './router';
import { isUserActive, isUnlockAvailableCached } from './activity-tracker';
import {
  attachNotifTapListener,
  detachNotifTapListener,
  isNativePushAvailable,
  resetNativeFcmToken,
} from './push-bridge';

// Notification-tap navigations must respect the biometric lock. Notifications
// come from OUTSIDE the app's interaction flow (lock screen, notification
// shade, another app), so every tap is a checkpoint where we re-evaluate
// whether the user is "active" (in-memory DOM-input gate). If they're stale,
// we engage the lock and queue the navigation; the queued path is drained
// only after a successful biometric unlock.
//
// The queue is module-scoped (in-memory) — NOT localStorage. With router-
// based soft navigation, the queue survives lock/unlock without a page
// reload, and an in-memory queue can't be carried forward by a hard reload
// to a fresh WebView. If the WebView is killed while the user is on the
// LockScreen, the native FCM service's tap intent (held in Android Intent
// extras and replayed via CarapaBridgePlugin's pendingNotifId) will deliver
// the notifId again on next launch — no JS-side persistence needed.

type PendingExternalIntent =
  | { kind: 'notification'; id: string }
  | { kind: 'navigation'; path: string };

// A system tap is one external intent. Keeping one latest intent prevents a
// notification and a deeplink from draining independently after unlock.
let pendingExternalIntent: PendingExternalIntent | null = null;
let authSubscriptionAttached = false;

function tryDrainPendingIntent(): void {
  const state = useAuth.getState();
  // Forget the queued path if the user signed out — coming back authenticated
  // shouldn't surprise them with a notification from a past session.
  if (!state.authenticated) {
    pendingExternalIntent = null;
    return;
  }
  if (state.locked) return;
  const intent = pendingExternalIntent;
  pendingExternalIntent = null;
  if (intent?.kind === 'notification') {
    openNotification(intent.id);
  } else if (intent?.kind === 'navigation') {
    navigateNow(intent.path);
  }
}

function navigateNow(path: string): void {
  try {
    router.history.push(path);
  } catch {
    /* ignore */
  }
}

function ensureAuthSubscription(): void {
  if (authSubscriptionAttached) return;
  authSubscriptionAttached = true;
  useAuth.subscribe(() => tryDrainPendingIntent());
}

export function gatedOpenNotification(id: string): void {
  if (!id) return;
  ensureAuthSubscription();
  const state = useAuth.getState();

  // Already locked or not authenticated — queue and wait for the auth
  // subscription to drain after unlock.
  if (!state.authenticated || state.locked) {
    pendingExternalIntent = { kind: 'notification', id };
    return;
  }

  // Authenticated and unlocked. If the user has been actively interacting
  // with the app (DOM input within the threshold), trust the session and
  // navigate directly. Otherwise engage the lock — notifications come from
  // outside the user interaction flow and stale sessions must re-auth.
  // Engaging only makes sense if the device has SOME unlock method
  // (biometric OR PIN); on a device with neither, fall through and
  // navigate, since there's no way to release the lock.
  if (isUserActive() || !isUnlockAvailableCached()) {
    openNotification(id);
    return;
  }

  pendingExternalIntent = { kind: 'notification', id };
  state.setLocked(true);
  // The auth subscription will fire tryDrainPendingIntent when the user
  // unlocks; until then the LockScreen overlays the entire UI and the
  // form route never mounts.
}

// Non-notification deep links (for example an explicit local-notification
// deeplink) retain the existing soft-navigation behavior.
export function gatedNavigate(path: string): void {
  ensureAuthSubscription();
  const state = useAuth.getState();
  if (!state.authenticated || state.locked) {
    pendingExternalIntent = { kind: 'navigation', path };
    return;
  }
  if (isUserActive() || !isUnlockAvailableCached()) {
    navigateNow(path);
    return;
  }
  pendingExternalIntent = { kind: 'navigation', path };
  state.setLocked(true);
}

interface PendingItem {
  id: string;
  ref?: string;
  kind?: 'text' | 'json_form' | 'html_form';
  summary?: string;
  content?: string;
}

let initialized = false;
let initPromise: Promise<void> | null = null;
// Bumped by disposePush: an init or token check started under an older value
// belongs to a signed-out session and must not register anything.
let pushGeneration = 0;
let listenersAttached = false;
let lifecycleAttached = false;
let checkInFlight: Promise<void> | null = null;
let checkInFlightGeneration = 0;
let lastCheckAt = 0;
// Once per app start: deleting the Firebase token is heavy-handed.
let fcmTokenResetDone = false;
let tokenWaiters: Array<(token: string | null) => void> = [];

/** Hand a registration result to pending requestToken() calls; false if none. */
function settleTokenWaiters(token: string | null): boolean {
  const waiters = tokenWaiters;
  tokenWaiters = [];
  waiters.forEach((resolve) => resolve(token));
  return waiters.length > 0;
}

/** False once the session this run started under has signed out. */
function isCurrent(generation: number): boolean {
  return generation === pushGeneration && useAuth.getState().authenticated;
}

function isSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

const POST_ATTEMPTS = 3;
const POST_BACKOFF_MS = [1_000, 3_000];
const FOREGROUND_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const TOKEN_WAIT_MS = 20_000;

/** POST the token, retrying with a short bounded backoff. Returns success. */
async function postToken(
  token: string,
  platform: 'android' | 'ios' | 'web',
  generation: number,
): Promise<boolean> {
  let lastStatus: number | string = 'no response';
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    if (!isCurrent(generation)) return false;
    try {
      const res = await apiFetch(API_BASE_URL + '/api/devices/push-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, platform }),
      });
      if (res.ok) return true;
      lastStatus = res.status;
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }
    if (attempt < POST_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POST_BACKOFF_MS[attempt - 1]));
    }
  }
  console.warn(
    `[push] token registration failed after ${POST_ATTEMPTS} attempts, status:`,
    lastStatus,
  );
  return false;
}

/**
 * Ask the server whether it holds this device's current token. `null` means
 * the answer is unknown (network error, non-2xx): that is not a reason to
 * re-register.
 */
async function isServerTokenOk(token: string): Promise<boolean | null> {
  try {
    const res = await apiFetch(
      API_BASE_URL + '/api/devices/push-token/status',
      {
        headers: { 'X-Carapa-Fcm-Token': token },
      },
    );
    if (!res.ok) {
      console.warn('[push] token status check failed', res.status);
      return null;
    }
    const body = await res.json();
    return !(body?.registered === false || body?.token_matches === false);
  } catch (err) {
    console.warn('[push] token status check failed', err);
    return null;
  }
}

async function deleteToken() {
  const res = await apiFetch(API_BASE_URL + '/api/devices/push-token', {
    method: 'DELETE',
  });
  if (!res.ok) {
    console.warn('[push] token deletion failed', res.status);
  }
}

async function fetchPayloads(): Promise<PendingItem[]> {
  const res = await apiFetch(API_BASE_URL + '/api/notifications/payloads');
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({ items: [] }));
  return Array.isArray(data?.items) ? data.items : [];
}

let nextLocalId = 1;
async function renderLocalNotifications(items: PendingItem[]) {
  if (items.length === 0) return;
  const notifications = items.map((it) => {
    const title = it.summary ?? 'CarapaBoard';
    const rawBody = (it.content ?? '').trim();
    const body = rawBody && rawBody !== title ? rawBody : '';
    return {
      id: nextLocalId++,
      title,
      body,
      extra: { payload_id: it.id, ref: it.ref },
    };
  });
  try {
    await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.warn('[push] LocalNotifications.schedule failed', err);
  }
}

/**
 * Foreground handler. The native CarapaMessagingService renders rich
 * notifications when it can fetch the payload; this JS handler is the
 * fallback when native fetch fails (it then calls super.onMessageReceived
 * which dispatches here).
 */
async function handlePing(notif: PushNotificationSchema) {
  const data = (notif.data || {}) as Record<string, string>;
  const ref = data.ref;
  const looksLikePayloadId = ref && /^[0-9a-f-]{8,}$/i.test(ref);
  if (!looksLikePayloadId) return; // ping_user removed; nothing to fetch.

  const payloads = await fetchPayloads();
  await renderLocalNotifications(payloads);
}

/**
 * Request permission, register with FCM, and POST the token to the board.
 * Idempotent — safe to call on every login. No-op on non-native or non-Android.
 */
export function initPush(): Promise<void> {
  if (!isSupported()) return Promise.resolve();
  if (initPromise) return initPromise;
  if (initialized) return Promise.resolve();
  initialized = true;
  const generation = pushGeneration;
  const run = runInitPush(generation)
    .catch((err) => {
      // Let a later AuthGate run retry; a disposed run leaves the flag alone.
      resetInitialized(generation);
      throw err;
    })
    .finally(() => {
      if (initPromise === run) initPromise = null;
    });
  initPromise = run;
  return run;
}

/** Allow a later initPush to retry, unless disposePush already reset it. */
function resetInitialized(generation: number): void {
  if (generation === pushGeneration) initialized = false;
}

async function runInitPush(generation: number): Promise<void> {
  // Tap on a rich notification posted natively by CarapaMessagingService.
  // Routed through the notification gate so the form/message doesn't render before
  // the biometric unlock completes.
  await attachNotifTapListener((id) => gatedOpenNotification(id));
  if (!isCurrent(generation)) return resetInitialized(generation);

  // Attach the auth subscription up-front and drain any queued path. The
  // queue is in-memory and only matters within the lifetime of this WebView;
  // a fresh process boot has nothing to drain.
  ensureAuthSubscription();
  tryDrainPendingIntent();

  // Without Firebase the push plugin's register() throws on its native thread
  // and takes the whole app down.
  const nativePushAvailable = await isNativePushAvailable();
  if (!isCurrent(generation)) return resetInitialized(generation);
  if (!nativePushAvailable) {
    console.warn(
      '[push] Firebase is not configured in this build; push is off',
    );
    toast.error(
      'Push notifications are not included in this app build. Reinstall a build that contains Firebase.',
      { id: 'push-not-in-build', duration: Infinity },
    );
    return;
  }

  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') {
      console.warn('[push] permission not granted:', perm.receive);
      return resetInitialized(generation);
    }
    const localPerm = await LocalNotifications.requestPermissions();
    if (localPerm.display !== 'granted') {
      console.warn('[push] local notification permission not granted');
    }
  } catch (err) {
    console.warn('[push] permission request failed', err);
    return resetInitialized(generation);
  }
  if (!isCurrent(generation)) return resetInitialized(generation);

  if (!listenersAttached) {
    listenersAttached = true;
    await PushNotifications.addListener('registration', (token: Token) => {
      // A requested token feeds the running check. An unsolicited one is FCM's
      // onNewToken rotation: verify it against the server like any other.
      if (!settleTokenWaiters(token.value)) void runCheck(token.value);
    });
    await PushNotifications.addListener('registrationError', (err) => {
      console.warn('[push] FCM registration error', err);
      settleTokenWaiters(null);
    });
    await PushNotifications.addListener('pushNotificationReceived', (notif) => {
      void handlePing(notif);
    });
    await PushNotifications.addListener(
      'pushNotificationActionPerformed',
      async (action) => {
        // User tapped a notification surfaced via Capacitor's bridge — only
        // fires for the JS-fallback render. The native render's tap path
        // goes through MainActivity → CarapaBridgePlugin → notifTap listener.
        const extra = (action.notification.data || {}) as Record<
          string,
          string
        >;
        const ref = extra.ref;
        const looksLikePayloadId = ref && /^[0-9a-f-]{8,}$/i.test(ref);

        try {
          if (looksLikePayloadId) {
            gatedOpenNotification(ref);
          }
        } catch {
          /* ignore — falling through means the app simply opened to the home screen */
        }
      },
    );
    await LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action) => {
        const extra = (action.notification.extra || {}) as Record<
          string,
          string
        >;
        const deeplink = extra.deeplink;
        const payloadId = extra.payload_id;
        try {
          if (payloadId) {
            gatedOpenNotification(payloadId);
          } else if (deeplink) {
            gatedNavigate(deeplink);
          }
        } catch {
          /* ignore */
        }
      },
    );
  }

  attachForegroundCheck();
  if (!isCurrent(generation)) return resetInitialized(generation);
  await runCheck();
}

/** Ask FCM for the current token; null on registration error or timeout. */
function requestToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), TOKEN_WAIT_MS);
    function settle(token: string | null) {
      clearTimeout(timer);
      tokenWaiters = tokenWaiters.filter((w) => w !== settle);
      resolve(token);
    }
    tokenWaiters.push(settle);
    PushNotifications.register().catch((err) => {
      console.warn('[push] register failed', err);
      settle(null);
    });
  });
}

/**
 * Re-register only when the FCM token is not OK: the server has no row for
 * this device, it holds a different token, or FCM gives us no token. At most
 * one re-register per cycle; a mismatch that survives it is only logged.
 */
async function checkToken(
  generation: number,
  knownToken?: string,
): Promise<void> {
  if (!isCurrent(generation)) return;
  let token = knownToken ?? (await requestToken());
  if (!isCurrent(generation)) return;
  if (!token && !fcmTokenResetDone) {
    fcmTokenResetDone = true;
    console.warn('[push] no FCM token, deleting the instance token');
    if (await resetNativeFcmToken()) {
      if (!isCurrent(generation)) return;
      token = await requestToken();
      if (!isCurrent(generation)) return;
    }
  }
  if (!token) {
    console.warn('[push] could not obtain an FCM token');
    return;
  }
  const serverTokenOk = await isServerTokenOk(token);
  if (serverTokenOk !== false || !isCurrent(generation)) return;

  console.warn('[push] server token missing or stale, re-registering');
  if (!(await postToken(token, 'android', generation))) return;
  if ((await isServerTokenOk(token)) === false) {
    console.warn(
      '[push] server still reports a token mismatch after re-register',
    );
  }
}

/** One check at a time; concurrent triggers share the running cycle. */
function runCheck(knownToken?: string): Promise<void> {
  // A cycle from before a logout must not absorb the next session's check.
  if (!checkInFlight || checkInFlightGeneration !== pushGeneration) {
    lastCheckAt = Date.now();
    checkInFlightGeneration = pushGeneration;
    const check = checkToken(pushGeneration, knownToken)
      .catch((err) => console.warn('[push] token check failed', err))
      .finally(() => {
        if (checkInFlight === check) checkInFlight = null;
      });
    checkInFlight = check;
  }
  return checkInFlight;
}

function attachForegroundCheck(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!initialized || !useAuth.getState().authenticated) return;
    if (Date.now() - lastCheckAt < FOREGROUND_CHECK_INTERVAL_MS) return;
    void runCheck();
  });
}

/**
 * Detach the device from server-side push routing. Called from logout.
 *
 * We deliberately do NOT clear native EncryptedSharedPreferences credentials
 * here. The device keypair is per-device, not per-session — wiping it on
 * logout would leave the next login with no signing key and force a full
 * keypair regeneration (and a new device_id on the server). Logout already
 * unregisters the FCM token and clears the auth cookie, which is enough to
 * stop server-side push routing to this device.
 */
export async function disposePush(): Promise<void> {
  // Invalidate in-flight init and token checks before the DELETE goes out, and
  // end a pending token wait now rather than after its 20s timeout.
  pushGeneration++;
  initPromise = null;
  settleTokenWaiters(null);
  pendingExternalIntent = null;
  closeNotification();
  if (!isSupported()) return;
  try {
    await deleteToken();
  } catch (err) {
    console.warn('[push] disposePush failed', err);
  }
  await detachNotifTapListener().catch(() => undefined);
  initialized = false;
}
