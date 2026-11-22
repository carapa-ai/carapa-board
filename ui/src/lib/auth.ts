import { clearProjectCache } from './project-cache';
import { create } from 'zustand';
import { toast } from 'sonner';
import { useMailState } from './mail-state';
import { Capacitor } from '@capacitor/core';
import {
  API_BASE_URL,
  REMOTE_URL,
  getServerConfigEpoch,
  trackNativeRequest,
} from './api-config';
import { markUserActive, wasHiddenWithinGrace } from './activity-tracker';
import { webauthnAssertWithPRF } from './webauthn';
import {
  bootstrapDeviceNative,
  clearNativeCredentials,
  hasNativeCredentials,
} from './push-bridge';
import { hasAppPin, resetAppPinAttempts } from './app-pin';
import {
  vaultClearAll,
  vaultDiscardWrapped,
  vaultFlushPinPersist,
  vaultSetPinSession,
  vaultGetAuthToken,
  vaultGetDeviceCreds,
  vaultGetDevicePubKey,
  vaultGetCredentialId,
  vaultIsConfigured,
  vaultOwnedBy,
  vaultPopulate,
  vaultUnwrapFromStorage,
  loadPerUserDeviceCreds,
  savePerUserDeviceCreds,
  clearPerUserDeviceCreds,
} from './session-vault';
import {
  hasPinVault,
  unlockPinVault,
  type DeviceCreds,
  type PinKeyHandle,
} from './pin-vault';
import { shouldLockNativeBoot } from './native-boot-lock';

// On a native cold boot we start locked. The AuthGate effect retracts
// the lock if biometric isn't available on the device (otherwise the user
// would be trapped on an unusable LockScreen). The retraction uses a CACHED
// biometric-availability snapshot taken once at boot — it never re-queries
// at runtime, because some Android OEMs report "unavailable" during a
// post-cancel cooldown, and that signal would incorrectly drop the lock.
//
// Exception: if the app was hidden within the last 60 s, this is normally a
// WebView recreation while the user was briefly away (most commonly the
// Android share-intent flow, which relaunches the Activity and reloads the
// page). OTA activation writes a one-shot override before restarting so that
// restart cannot use this grace period to bypass the app lock.
//
// On web/iOS we lock if biometric unlock is configured, or if the remembered
// user has a PIN vault — a fresh page load should land on the lock screen, not
// flash the post-login UI. In the PIN case the session vault is told which
// user's vault protects the (still empty) in-memory session.
function computeInitialLocked(): boolean {
  if (Capacitor.isNativePlatform()) {
    return shouldLockNativeBoot(wasHiddenWithinGrace());
  }
  if (vaultIsConfigured()) return true;
  const pinUser = loadStoredUser()?.username;
  if (pinUser && hasPinVault(pinUser)) {
    vaultSetPinSession(pinUser);
    return true;
  }
  return false;
}

type AuthRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  username: string;
  role: AuthRole;
  displayName?: string | null;
  avatarUrl?: string | null;
}

interface AuthState {
  /** null = not checked yet, true = auth required, false = no auth needed */
  authRequired: boolean | null;
  authenticated: boolean;
  checking: boolean;
  user: AuthUser | null;
  locked: boolean;
  /** A sign-in attempt is running (set by the login form). */
  signingIn: boolean;
  setSigningIn: (v: boolean) => void;
  /** A setup link is replacing the server; sign-in must not start. */
  serverChanging: boolean;
  setServerChanging: (v: boolean) => void;
  /**
   * Approval state of the device making this session. `null` while unknown
   * (e.g. password-only / cookie-only sessions with no device keypair).
   * `false` means the current device is registered but waiting for an admin
   * to approve it — most UI flows can proceed read-only; signed-request paths
   * are blocked server-side.
   */
  deviceApproved: boolean | null;
  setDeviceApproved: (v: boolean | null) => void;
  /**
   * In-memory duress flag. When the duress PIN is entered, the LockScreen
   * fires the duress alert + kill-switch, then sets this to true. The
   * AuthGate renders an indistinguishable-from-real "connection error"
   * screen while the flag is set. Memory-only by design — a cold restart
   * resets to false, so a legitimate user can recover by killing and
   * reopening the app. (An attacker who restarts is dropped at LoginForm
   * with no valid session anyway.)
   */
  duressMode: boolean;
  /**
   * True when an API call returned 401 while the user was signed in, so the
   * login screen can explain why the app was replaced. Cleared by a successful
   * login (`setAuth(..., true, ...)`) and by an explicit logout; never set on
   * a cold unauthenticated load.
   */
  sessionExpired: boolean;
  setAuth: (
    required: boolean,
    authenticated: boolean,
    user?: AuthUser | null,
  ) => void;
  /** Drop to the login screen after a 401 and record why. */
  expireSession: () => void;
  setChecking: (v: boolean) => void;
  setLocked: (v: boolean) => void;
  setDuressMode: (v: boolean) => void;
}

const AUTH_USER_KEY = 'auth_user';

function loadStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.username === 'string'
    ) {
      return parsed as AuthUser;
    }
  } catch {}
  return null;
}

function persistUser(user: AuthUser | null): void {
  try {
    if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(AUTH_USER_KEY);
  } catch {}
}

export const useAuth = create<AuthState>((set) => ({
  authRequired: null,
  authenticated: false,
  checking: true,
  user: loadStoredUser(),
  locked: computeInitialLocked(),
  sessionExpired: false,
  signingIn: false,
  setSigningIn: (signingIn) => set({ signingIn }),
  serverChanging: false,
  setServerChanging: (serverChanging) => set({ serverChanging }),
  setAuth: (required, authenticated, user) => {
    set((prev) => {
      const nextUser = user === undefined ? prev.user : user;
      persistUser(authenticated ? nextUser : null);
      return {
        authRequired: required,
        authenticated,
        checking: false,
        user: authenticated ? nextUser : null,
        locked: authenticated ? prev.locked : false,
        sessionExpired: authenticated ? false : prev.sessionExpired,
      };
    });
  },
  expireSession: () => {
    // Only a signed-in user can have a session expire; late 401s from requests
    // in flight during an explicit logout must not flag it.
    const wasAuthenticated = useAuth.getState().authenticated;
    useAuth.getState().setAuth(true, false, null);
    if (wasAuthenticated) set({ sessionExpired: true });
  },
  setChecking: (checking) => set({ checking }),
  setLocked: (locked) => set({ locked }),
  duressMode: false,
  setDuressMode: (duressMode) => set({ duressMode }),
  deviceApproved: null,
  setDeviceApproved: (deviceApproved) => set({ deviceApproved }),
}));

export async function checkAuth(): Promise<{
  required: boolean;
  authenticated: boolean;
  user?: AuthUser | null;
  device?: { isApproved: boolean } | null;
}> {
  const token = vaultGetAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await trackNativeRequest(
    fetch(API_BASE_URL + '/api/auth/check', {
      headers,
      credentials: 'include',
    }),
  );
  const data = await res.json();
  // Mirror device-approval state into the auth store so it's available
  // everywhere — banner, account tab, etc. — without re-fetching.
  const isApproved =
    typeof data?.device?.isApproved === 'boolean'
      ? data.device.isApproved
      : null;
  useAuth.getState().setDeviceApproved(isApproved);
  return data;
}

export async function refreshAuthUser(): Promise<AuthUser | null> {
  const result = await checkAuth();
  useAuth
    .getState()
    .setAuth(result.required, result.authenticated, result.user ?? null);
  return result.user ?? null;
}

import {
  generateDeviceKeyPair,
  exportPublicKey,
  exportPrivateKey,
} from './crypto';
import { NativeBridge } from './native-bridge';
import { initPush, disposePush } from './push';
import { queryClient } from './query-client';
import { connectWebSocket, disconnectWebSocket } from './websocket';
import { useStore } from '@/store';
import { router } from './router';

export type LoginFailureReason =
  | 'invalid_credentials'
  | 'pin_required'
  | 'pin_wrong'
  | 'pin_kill_switch'
  | 'other';

interface LoginSession {
  user?: AuthUser | null;
  device?: { isApproved: boolean } | null;
}

async function finishLogin(
  data: LoginSession,
  biometricVerified = false,
): Promise<void> {
  // Drop state from a prior session, including expiry paths that never logged out.
  queryClient.clear();
  useStore.getState().resetForLogout();
  useMailState.setState({ accounts: {}, navigation: {} });
  markUserActive();

  const userId = data.user?.id ?? null;
  // Only a password login resets the PIN failure quota. Repeated biometric
  // recovery must not grant unlimited guesses at a separately configured PIN.
  if (!biometricVerified) await resetAppPinAttempts(userId);
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    if (biometricVerified) {
      useAuth.getState().setLocked(await hasAppPin(userId));
    } else if (userId && (await hasAppPin(userId))) {
      useAuth.getState().setLocked(true);
    }
  }

  useAuth
    .getState()
    .setDeviceApproved(
      typeof data.device?.isApproved === 'boolean'
        ? data.device.isApproved
        : null,
    );
  // Recovery returns to AuthGate, which owns post-unlock push/socket startup.
  if (!biometricVerified) {
    void initPush();
    connectWebSocket(queryClient, { force: true });
  }
}

const SERVER_CHANGED_ERROR =
  'The server settings changed during sign-in. Please sign in again.';

/** Restore an approved Android device's session after a fresh biometric check. */
export async function loginWithDeviceBiometrics(): Promise<{
  ok: boolean;
  user?: AuthUser | null;
  error?: string;
}> {
  if (
    !Capacitor.isNativePlatform() ||
    Capacitor.getPlatform() !== 'android' ||
    !(await hasNativeCredentials())
  ) {
    return {
      ok: false,
      error:
        'Please log in with your username and password to register this device.',
    };
  }

  const epoch = getServerConfigEpoch();
  await NativeBridge.biometricLogin();
  // Keep the signed exchange and user lookup on the same selected server.
  // Never bootstrap a replacement key or replay a saved password on rejection.
  try {
    const apiBase = API_BASE_URL;
    const { apiFetch } = await import('./api');
    const refreshed = await apiFetch(
      apiBase + '/api/auth/token',
      { method: 'POST' },
      { allowRemoteRetry: false },
    );
    if (!refreshed.ok) {
      return {
        ok: false,
        error:
          refreshed.status === 401 || refreshed.status === 403
            ? 'This device could not restore your session. Please log in with your username and password.'
            : 'Could not restore your session. Please try again.',
      };
    }
    const { token } = await refreshed.json();
    if (typeof token !== 'string' || !token) {
      return {
        ok: false,
        error: 'Could not restore your session. Please try again.',
      };
    }
    const checked = await apiFetch(
      apiBase + '/api/auth/check',
      { headers: { Authorization: `Bearer ${token}` } },
      { allowRemoteRetry: false },
    );
    if (!checked.ok) {
      return {
        ok: false,
        error: 'Could not restore your session. Please try again.',
      };
    }
    const data = await checked.json();
    if (
      !data.authenticated ||
      !data.user?.id ||
      data.device?.isApproved !== true
    ) {
      return {
        ok: false,
        error:
          'This device is no longer approved. Please log in with your username and password.',
      };
    }

    if (getServerConfigEpoch() !== epoch) {
      return { ok: false, error: SERVER_CHANGED_ERROR };
    }
    vaultPopulate({ authToken: token });
    await finishLogin(data, true);
    return { ok: true, user: data.user };
  } catch {
    return {
      ok: false,
      error:
        'Could not restore your session. Check your connection and try again.',
    };
  }
}

/** Submit the token or credentials to get a session cookie and register device keys. */
export async function login(
  token?: string,
  username?: string,
  password?: string,
  pin?: string,
): Promise<{
  ok: boolean;
  user?: AuthUser | null;
  error?: string;
  reason?: LoginFailureReason;
  attemptsLeft?: number;
}> {
  const isAndroid =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

  let loginEndpoint = API_BASE_URL;
  const epoch = getServerConfigEpoch();

  // Mint or recover a device identity. On Android, the keypair is generated
  // INSIDE the Android Keystore — the private key never enters this JS
  // process. On web/iOS, fall back to WebCrypto with a localStorage-stored
  // PKCS8. If neither path produces a usable identity, refuse to log in
  // (the server can't bind a session without a verifiable device key).
  let device_id: string;
  let publicKeyBase64: string;
  // True when this login generated a new web/iOS keypair (no reusable device).
  let mintedDevice = false;

  if (isAndroid) {
    const native = await bootstrapDeviceNative(loginEndpoint, REMOTE_URL);
    if (getServerConfigEpoch() !== epoch) {
      // The bootstrap persisted device material for the previous server.
      await clearNativeCredentials();
      return { ok: false, error: SERVER_CHANGED_ERROR };
    }
    if (!native) {
      console.error('login: native device bootstrap failed');
      return {
        ok: false,
        error: `Could not initialize this Android device for ${new URL(loginEndpoint).hostname}`,
      };
    }
    if (!native.deviceId || !native.publicKey) {
      console.error('login: native device bootstrap failed', native.error);
      return {
        ok: false,
        error: `Android device initialization failed: ${native.error ?? 'unknown native error'}`,
      };
    }
    device_id = native.deviceId;
    publicKeyBase64 = native.publicKey;
  } else {
    // Optional PIN-vault path (Case 1: desktop without biometric, user
    // explicitly enrolled a PIN). When present, the keypair lives ONLY in
    // an Argon2id-wrapped blob — we must unlock it with the PIN before the
    // login request can be signed. PIN failures here never hit the server,
    // so they don't burn account-level login attempts.
    let pinUnlockedCreds: DeviceCreds | null = null;
    let pinHandle: PinKeyHandle | null = null;
    if (username && hasPinVault(username)) {
      if (!pin) {
        return { ok: false, reason: 'pin_required' };
      }
      const result = await unlockPinVault(username, pin);
      if (!result.ok) {
        if (result.reason === 'wrong_pin') {
          return {
            ok: false,
            reason: 'pin_wrong',
            attemptsLeft: result.attemptsLeft,
          };
        }
        if (result.reason === 'kill_switch') {
          return { ok: false, reason: 'pin_kill_switch' };
        }
        return { ok: false, reason: 'other', error: 'PIN unlock failed' };
      }
      pinUnlockedCreds = result.creds;
      pinHandle = result.handle;
    }

    // Prefer the per-user keypair the user previously enrolled on this
    // browser. This is what makes logout/login round-trips survive without
    // losing the device's approved status, and what lets two users share a
    // browser while each keeping their own approved row server-side.
    //
    // Skipped when the biometric vault is configured — that vault already
    // holds an encrypted copy of this keypair, and reading a plaintext
    // fallback would silently downgrade the biometric protection.
    const perUser =
      !pinUnlockedCreds && username && !vaultIsConfigured()
        ? loadPerUserDeviceCreds(username)
        : null;

    // Biometric vault configured but locked (reload, session expiry): its
    // device keypair is in the encrypted blob. Ask for the biometric prompt
    // so the password login reuses the approved device instead of registering
    // a new pending one. If the user cancels or the unlock fails, the login
    // continues with a new device and the stale blob is dropped below.
    const credentialId = vaultGetCredentialId();
    if (
      !pinUnlockedCreds &&
      credentialId &&
      vaultIsConfigured() &&
      !vaultGetDeviceCreds().deviceId
    ) {
      try {
        await vaultUnwrapFromStorage(await webauthnAssertWithPRF(credentialId));
      } catch {
        /* cancelled or unavailable: handled by the new-device fallback */
      }
    }

    // Fall back to whatever the active session vault has — covers legacy
    // installs (single-user-per-browser, no per-user storage yet) and the
    // biometric-wrapped path where the vault was just unwrapped.
    // A configured vault holds one account's device: another account signing
    // in on the same browser must not take it over (the server would
    // reassign the approved device to the new user as pending).
    const vaultReusable = !vaultIsConfigured() || vaultOwnedBy(username);
    const existing = vaultReusable
      ? vaultGetDeviceCreds()
      : { deviceId: null, privKeyB64: null };
    let storedDeviceId =
      pinUnlockedCreds?.deviceId ?? perUser?.deviceId ?? existing.deviceId;
    let storedPriv =
      pinUnlockedCreds?.privKeyB64 ??
      perUser?.privKeyB64 ??
      existing.privKeyB64;
    let storedPub: string | null =
      pinUnlockedCreds?.pubKeyB64 ??
      perUser?.pubKeyB64 ??
      (vaultReusable ? vaultGetDevicePubKey() : null);

    if (!storedDeviceId || !storedPub || !storedPriv) {
      mintedDevice = true;
      const keyPair = await generateDeviceKeyPair();
      storedPub = await exportPublicKey(keyPair.publicKey);
      storedPriv = await exportPrivateKey(keyPair.privateKey);
      storedDeviceId = `dev-${Math.random().toString(36).substring(2, 15)}`;
    }

    device_id = storedDeviceId;
    publicKeyBase64 = storedPub;
    // Select the protection mode before any secret is stored: a PIN-vault
    // login keeps everything in memory (re-wrapped into the PIN vault, never
    // plaintext on disk); any other login clears a stale PIN session.
    // Then persist the priv up-front so a failed login still leaves a usable
    // keypair for retry. `vaultPopulate` writes plain localStorage when
    // neither biometric nor a PIN vault protects the session, and writes
    // memory only otherwise.
    vaultSetPinSession(pinHandle && username ? username : null, pinHandle);
    vaultPopulate({ devicePrivKeyB64: storedPriv });
    // New keypair: drop the previous owner's id/key/owner from memory so a
    // failed attempt cannot leave another account's device paired with it.
    if (mintedDevice) {
      vaultPopulate({
        deviceId: storedDeviceId,
        devicePubKeyB64: storedPub,
        username: null,
      });
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // The server changed while the device identity was prepared: do not send it.
  if (getServerConfigEpoch() !== epoch) {
    return { ok: false, error: SERVER_CHANGED_ERROR };
  }
  const res = await trackNativeRequest(
    fetch(loginEndpoint + '/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token,
        username,
        password,
        device_id,
        public_key: publicKeyBase64,
      }),
      credentials: 'include',
    }),
  );

  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    if (getServerConfigEpoch() !== epoch) {
      return { ok: false, error: SERVER_CHANGED_ERROR };
    }
    const savedToken = data.token || token;
    if (savedToken) {
      vaultPopulate({ authToken: savedToken });
    }

    if (!isAndroid) {
      // `vaultPopulate` routes to plain localStorage when biometric is
      // unconfigured, or memory only when configured. Either way the
      // signing key path in `apiFetch` reads through `vaultGetDeviceCreds`.
      vaultPopulate({
        deviceId: device_id,
        devicePubKeyB64: publicKeyBase64,
        username: (data.user as AuthUser | null)?.username ?? username ?? null,
      });
      // The biometric unlock above failed or the blob held no usable keypair,
      // and a vault cannot be re-wrapped without a PRF output. New credentials
      // must not leave the old blob behind: it would unlock to a different
      // device. Drop it; the session falls back to plain storage like an
      // unconfigured browser.
      if (mintedDevice) vaultDiscardWrapped();
      // Persist a per-user copy of the keypair on disk so the same user can
      // log back in after logout (or share the browser with another account)
      // and reuse their already-approved device row. Each user effectively
      // has their own logical device on this browser.
      //
      // Important: skip when the biometric vault is configured. That vault
      // already wraps the same keypair at rest with a WebAuthn-PRF-derived
      // key; writing a plaintext copy here would defeat the biometric gate
      // and downgrade laptops with Windows Hello / TouchID back to the
      // unprotected localStorage posture. Any stale per-user blob from a
      // prior bug is cleared so it can't be used as a backdoor.
      const responseUsername =
        (data.user as AuthUser | null)?.username ?? username;
      if (responseUsername) {
        if (vaultIsConfigured() || hasPinVault(responseUsername)) {
          // Wrapped storage (biometric vault or PIN vault) is the authoritative
          // copy. Nuke any plaintext fallback so it can't be used to bypass
          // the unlock gate.
          clearPerUserDeviceCreds(responseUsername);
          // PIN vault: the final populate above queued the re-wrap that
          // stores the fresh token; wait so a reload right away resumes it.
          await vaultFlushPinPersist();
        } else {
          const creds = vaultGetDeviceCreds();
          if (creds.deviceId && creds.privKeyB64) {
            savePerUserDeviceCreds(responseUsername, {
              deviceId: creds.deviceId,
              pubKeyB64: publicKeyBase64,
              privKeyB64: creds.privKeyB64,
            });
          }
        }
      }
    }

    await finishLogin(data);
    return { ok: true, user: (data.user as AuthUser | null) ?? null };
  }
  // Surface server error messages (e.g. device-conflict 403) so the login
  // form can show something more useful than a generic "failed".
  let error: string | undefined;
  try {
    const body = await res.json();
    if (typeof body?.error === 'string') error = body.error;
  } catch {}
  return { ok: false, error };
}

/**
 * Clear the session cookie. The Android app PIN is bound to the user
 * account, not the device, so logout NEVER touches it — the same user
 * logs back in and uses the same PIN. A different user logging in next
 * is gated by their own (possibly absent) PIN, never inherits this one.
 */
export async function logout(): Promise<void> {
  const token = vaultGetAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Server-side session teardown. Cleanup below must still run if this fails
  // (e.g. offline) — otherwise the next signed-in user can see the previous
  // account's cached chats / drafts on first paint.
  let serverSessionEnded = false;
  try {
    const res = await trackNativeRequest(
      fetch(API_BASE_URL + '/api/auth/logout', {
        method: 'POST',
        headers,
        credentials: 'include',
      }),
    );
    serverSessionEnded = res.ok;
  } catch {
    // network error — still wipe local state; the user is warned below
  }

  // Stop accepting events for the old session before clearing caches, so a late
  // WS message can't repopulate them.
  disconnectWebSocket();
  await disposePush().catch(() => undefined);

  // Drop every per-user UI artifact:
  //   - TanStack Query cache (conversation messages, project lists, etc.)
  //   - Zustand store (active conversation, drafts, queued prompts, streams…)
  clearProjectCache();
  queryClient.clear();
  useStore.getState().resetForLogout();
  useMailState.setState({ accounts: {}, navigation: {} });

  // Strand the URL too. AuthGate keeps the routed tree mounted under the login
  // overlay, so without this the next user lands on the previous user's URL
  // (e.g. /chat/main-alice/<conv>) the moment they authenticate. Routing to
  // `/` lets the index route pick the new user's first available project.
  router.navigate({ to: '/' }).catch(() => undefined);

  // Drop the token from the PIN vault blob (kept: it holds the device keypair)
  // while the key handle is still in memory.
  vaultPopulate({ authToken: null });
  await vaultFlushPinPersist();

  // Clear the in-memory cache and the wrapped vault blob (web/iOS) plus
  // the legacy plaintext keys (web/iOS unconfigured path). On Android the
  // device key + creds live in EncryptedSharedPreferences and aren't
  // touched here; the kill-switch path is the one that wipes them.
  vaultClearAll();
  await NativeBridge.deleteSecureCredentials();
  useAuth.getState().setAuth(true, false, null);
  useAuth.setState({ sessionExpired: false });

  if (!serverSessionEnded) {
    toast.error(
      'Signed out on this device, but the server could not end your session. Sign in again and log out once the connection works.',
    );
  }
}
