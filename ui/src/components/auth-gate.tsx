import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Capacitor } from '@capacitor/core';
import {
  useAuth,
  checkAuth,
  login,
  loginWithDeviceBiometrics,
  logout,
} from '@/lib/auth';
import { router } from '@/lib/router';
import { initPush } from '@/lib/push';
import { runDuressSequence } from '@/lib/duress';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { NativeBridge, isNative } from '@/lib/native-bridge';
import { hasNativeCredentials } from '@/lib/push-bridge';
import {
  hasAppPin as appHasAppPin,
  verifyAppPin as appVerifyAppPin,
  type AppPinVerifyResult,
} from '@/lib/app-pin';
import {
  initBiometricAvailability,
  isBiometricAvailableCached,
  isUnlockAvailableCached,
  markUserActive,
  wasHiddenWithinGrace,
} from '@/lib/activity-tracker';
import {
  vaultAdoptOwner,
  vaultApplyPinUnlock,
  vaultClearMemory,
  vaultGetCredentialId,
  vaultIsConfigured,
  vaultIsPinProtected,
  vaultPinUsername,
  vaultUnwrapFromStorage,
} from '@/lib/session-vault';
import { unlockPinVault } from '@/lib/pin-vault';
import { webauthnAssertWithPRF } from '@/lib/webauthn';
import { Fingerprint, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { useStore } from '@/store';
import {
  API_BASE_URL,
  type ServerConfig,
  describeCertPin,
  describeOtaKey,
  getServerConfig,
  isServerConfigured,
  parseServerUrl,
  subscribeServerConfig,
  updateApiBaseUrl,
} from '@/lib/api-config';
import {
  ANDROID_OTA_AVAILABLE_EVENT,
  androidOtaFirstLoadRequired,
  getAndroidOtaStatus,
  subscribeAndroidOtaStatus,
  type AndroidOtaStatus,
} from '@/lib/android-ota';
import {
  ServerChangeIncompleteError,
  applyServerConfig,
} from '@/lib/server-config';
import { useServerUrls } from '@/hooks/use-server-urls';
import { confirmAction } from '@/components/confirm-dialog';
import { KeyboardSafeScreen } from '@/components/keyboard-safe-screen';
import {
  diagnoseUntrustedServer,
  untrustedServerMessage,
} from '@/lib/connection-error';

const APP_PIN_MIN = 4;
const APP_PIN_MAX = 16;

type LockMethod = 'pin' | 'biometric' | 'web-pin' | null;

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function isCancelError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const code =
    typeof e.code === 'string' || typeof e.code === 'number'
      ? String(e.code)
      : '';
  return (
    msg.includes('cancel') ||
    msg.includes('canceled') ||
    msg.includes('cancelled') ||
    code === '13' ||
    code === 'BIOMETRIC_ERROR_USER_CANCELED' ||
    // WebAuthn surfaces user-cancel as NotAllowedError. We can't fully
    // distinguish "user cancelled" from "no credential available" without
    // more state, but treating both as cancel keeps the lock screen
    // displaying a retry button rather than a hard error.
    (e as { name?: string }).name === 'NotAllowedError'
  );
}

// A fresh login lands on `/`, except on the OAuth consent page: that flow
// must resume at its own URL once the user is signed in.
function navigateHomeAfterLogin() {
  if (window.location.pathname.startsWith('/oauth/consent')) return;
  router.navigate({ to: '/' }).catch(() => undefined);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const {
    authRequired,
    authenticated,
    checking,
    locked,
    duressMode,
    user,
    deviceApproved,
    serverChanging,
    setAuth,
    setChecking,
  } = useAuth();
  const userId = user?.id ?? null;
  const [connError, setConnError] = useState<string | null>(null);
  // Bumped after the server address changes so the auth check runs again.
  const [checkNonce, setCheckNonce] = useState(0);
  const firstLoadGate = usePairedFirstLoadGate();
  // False on a fresh native install without a built-in server address.
  const configured = useSyncExternalStore(
    subscribeServerConfig,
    isServerConfigured,
  );

  // Lock-method gate state.
  //   - 'pin' on Android with an app PIN configured (Keystore HMAC backend).
  //   - 'biometric' on web/iOS with a WebAuthn-PRF vault configured.
  //   - 'web-pin' on a web browser whose user enrolled a PIN vault (no
  //     biometric vault): the session secrets are only in memory + the
  //     PIN-wrapped blob.
  //   - null when no app-level lock is set up (falls through to legacy
  //     biometric path on native, no lock on plain web).
  const [lockMethodChecked, setLockMethodChecked] = useState(false);
  const [lockMethod, setLockMethod] = useState<LockMethod>(null);
  const hasLock = lockMethod !== null;

  // Always run a fresh auth check on mount.
  useEffect(() => {
    if (useAuth.getState().authenticated) return;
    // A server change is still finishing (credential wipe, OTA reset, reload):
    // the new address must not be asked before the app restarts against it.
    if (serverChanging) return;
    // No address to ask. Not "checking", so a setup link is handled meanwhile.
    // A reset to an empty config (credentials already wiped) also drops the
    // previous server's identity, which would otherwise make the setup link
    // look like a change under a signed-in user.
    if (!configured) {
      setAuth(true, false, null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    checkAuth()
      .then(({ required, authenticated: authed, user }) => {
        // A superseded check (server changed, unmount) must not touch state.
        if (cancelled) return;
        if (useAuth.getState().checking) {
          setAuth(required, authed, user ?? null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Auth check failed:', err);
        // The server is unreachable; the Server editor is offered, so a setup
        // link may be handled as well.
        setChecking(false);
        setConnError(err.message || String(err));
        // The WebView only says "Failed to fetch"; name an untrusted certificate.
        void diagnoseUntrustedServer(API_BASE_URL).then((message) => {
          if (message && !cancelled) setConnError(message);
        });
      });
    return () => {
      cancelled = true;
    };
  }, [setAuth, setChecking, checkNonce, configured, serverChanging]);

  useEffect(() => {
    if (!isNative) return;
    void initBiometricAvailability();
  }, []);

  // Initialize push when the session becomes authenticated, unlocked, AND
  // the lock-method gate has been resolved. Initializing earlier would
  // attach the notif-tap listener before the lock is satisfied — a
  // notification tap could queue navigation while the user hasn't proven
  // they own the app yet. (Push only matters on Android, but the gate
  // ordering is platform-agnostic now.) Any resolved lock method qualifies,
  // including none: an Android user without an app PIN still needs push after
  // a biometric session restore, which leaves push startup to this gate.
  useEffect(() => {
    if (!authenticated || locked) return;
    if (isAndroidNative() && !lockMethodChecked) return;
    void initPush();
  }, [authenticated, locked, lockMethodChecked]);

  // Safety net: a native session without Keystore-bound credentials forces re-login.
  useEffect(() => {
    if (!isNative || !authenticated) return;
    if (!isAndroidNative()) return;
    let cancelled = false;
    (async () => {
      const ok = await hasNativeCredentials();
      if (cancelled || ok) return;
      console.warn(
        '[auth] device not bootstrapped — forcing re-login to bootstrap Keystore-bound key',
      );
      await logout();
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  // Resolve the lock method whenever `authenticated` (or the logged-in
  // user) flips. Until this resolves, we render the loading screen
  // rather than the children — a PIN/biometric-protected user could
  // otherwise see post-login content flash before the lock engages.
  // Re-running on `userId` change is what guarantees user B logging in
  // after user A doesn't see user A's PIN screen: each user's PIN lives
  // under their own namespace, so `appHasAppPin(userId)` returns false
  // for a user who hasn't set one.
  useEffect(() => {
    if (!authenticated) {
      setLockMethodChecked(false);
      setLockMethod(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let next: LockMethod = null;
      if (isAndroidNative()) {
        next = (await appHasAppPin(userId)) ? 'pin' : null;
      } else {
        next = vaultIsConfigured()
          ? 'biometric'
          : !isNative && vaultIsPinProtected()
            ? 'web-pin'
            : null;
      }
      if (cancelled) return;
      setLockMethod(next);
      setLockMethodChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, userId]);

  // Re-engage the lock when focus returns. Three cases, in order:
  //   1. Android with an app PIN: re-lock only if the app was hidden for
  //      ≥ 60 s (`wasHiddenWithinGrace()` threshold). The grace covers
  //      share-sheet hops and quick app-switches — e.g. opening another
  //      app, copying a link, and sharing it back to Carapa should not
  //      demand the PIN. The threshold measures time-in-background, NOT
  //      time-since-last-tap: a user can sit idle reading in the app and
  //      then briefly hop out without re-authenticating. The device-level
  //      lock still gates the 60 s window — an attacker grabbing a
  //      hands-on phone within 60 s also needs the OS unlock.
  //   2. Web/iOS with biometric vault, or a web PIN vault: re-lock only if the
  //      app was hidden ≥ 60 s (same threshold). Tab-switching on a desktop is
  //      common; demanding biometric/PIN every refocus would be hostile. Lock
  //      engagement also clears the in-memory session vault so a
  //      subsequent `apiFetch` returns no token until the user re-asserts.
  //   3. Native without an app lock: existing biometric path, same
  //      hidden-duration threshold.
  // Page reloads land on the lock screen via `computeInitialLocked()` —
  // this handler only covers in-process refocus.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      if (!useAuth.getState().authenticated || useAuth.getState().locked)
        return;
      let method = lockMethod;
      if (!isNative) {
        // A PIN vault can be enrolled or disabled after the lock method was
        // resolved; follow the live state so refocus never leaves a stale lock.
        const next = vaultIsPinProtected() ? 'web-pin' : null;
        if (method === null && next) {
          method = next;
          setLockMethod(next);
        } else if (method === 'web-pin' && !next) {
          method = null;
          setLockMethod(null);
        }
      }
      if (method === 'pin') {
        if (!wasHiddenWithinGrace()) useAuth.getState().setLocked(true);
        return;
      }
      if (method === 'biometric' || method === 'web-pin') {
        if (!wasHiddenWithinGrace()) {
          vaultClearMemory();
          useAuth.getState().setLocked(true);
        }
        return;
      }
      if (!isNative) return;
      if (!isUnlockAvailableCached()) return;
      if (!wasHiddenWithinGrace()) {
        useAuth.getState().setLocked(true);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [lockMethod]);

  // One-way retraction: if no auth method is available at all, drop the lock
  // so the user isn't trapped. With an app lock configured, the unlock
  // method (PIN or biometric vault) is always available — never retract.
  useEffect(() => {
    if (!isNative || !authenticated) return;
    if (!useAuth.getState().locked) return;
    if (hasLock) return;
    let cancelled = false;
    (async () => {
      await initBiometricAvailability();
      if (cancelled) return;
      if (!isUnlockAvailableCached()) {
        useAuth.getState().setLocked(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, hasLock]);

  if (duressMode) {
    // Indistinguishable from a real connection failure. The error message
    // is generic on purpose — anything device-specific (a timestamp, a
    // username, a route name) could differ from what a coercer expects of
    // a network outage. The Retry button reloads the WebView; on cold
    // restart, AuthGate runs through the auth check, sees no auth_token
    // (kill-switch cleared it), and routes to LoginForm. The duress flag
    // is in-memory only, so the legitimate user's restart drops them at
    // a clean login screen.
    return (
      <KeyboardSafeScreen className="flex flex-col items-center justify-center bg-background text-foreground p-6 text-center">
        <div className="text-destructive font-bold mb-4">Connection Failed</div>
        <div className="text-sm bg-muted p-4 rounded mb-6 break-words max-w-md">
          Failed to reach the server. Please check your connection and try
          again.
        </div>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </KeyboardSafeScreen>
    );
  }

  if (!configured) return <ServerSetupScreen />;

  // Ahead of the auth check's own outcome: an unreachable server on a first
  // load is reported by the gate, with its Retry and Change server actions.
  if (firstLoadGate.blocked && !authenticated && authRequired !== false) {
    return (
      <PairedFirstLoadScreen
        status={firstLoadGate.status}
        onServerSaved={() => {
          setConnError(null);
          setCheckNonce((n) => n + 1);
        }}
      />
    );
  }

  if (connError) {
    return (
      <KeyboardSafeScreen className="flex flex-col items-center justify-center bg-background text-foreground p-6 text-center">
        <div className="text-destructive font-bold mb-4">Connection Failed</div>
        <div className="text-sm bg-muted p-4 rounded mb-6 break-words max-w-md">
          {connError}
        </div>
        <Button onClick={() => window.location.reload()}>Retry</Button>
        {isNative && (
          <div className="mt-4 w-full max-w-sm">
            <ServerSettings
              onSaved={() => {
                setConnError(null);
                setCheckNonce((n) => n + 1);
              }}
            />
          </div>
        )}
      </KeyboardSafeScreen>
    );
  }

  if (checking || authRequired === null) {
    return <LoadingScreen />;
  }

  if (!authRequired || authenticated) {
    if (authenticated && !lockMethodChecked) {
      return <LoadingScreen />;
    }
    if (authenticated && locked) {
      return <LockScreen method={lockMethod} userId={userId} />;
    }
    if (authenticated && deviceApproved === false) {
      return <PendingApprovalScreen />;
    }
    return <>{children}</>;
  }

  return <LoginForm />;
}

/**
 * A paired server's own UI bundle must be running before the user logs in:
 * until the first check has finished, the built-in login (and the generic
 * connection-failure screen) stays hidden. The check itself runs in
 * AndroidOtaController.
 */
function usePairedFirstLoadGate(): {
  blocked: boolean;
  status: AndroidOtaStatus;
} {
  const required = useSyncExternalStore(
    subscribeServerConfig,
    androidOtaFirstLoadRequired,
  );
  const status = useSyncExternalStore(
    subscribeAndroidOtaStatus,
    getAndroidOtaStatus,
  );
  // Latched so a later foreground check cannot replace a form being filled in.
  // `current` means the server's own bundle is active (the check never reports
  // the built-in bundle as current on a first load).
  const [passed, setPassed] = useState(status.kind === 'current');
  useEffect(() => {
    if (status.kind === 'current') setPassed(true);
  }, [status]);
  useEffect(() => subscribeServerConfig(() => setPassed(false)), []);
  return { blocked: required && !passed, status };
}

function PairedFirstLoadScreen({
  status,
  onServerSaved,
}: {
  status: AndroidOtaStatus;
  onServerSaved: () => void;
}) {
  const loading = status.kind === 'checking' || status.kind === 'ready';
  let message = 'Loading the app from your server…';
  let canRetry = true;
  if (status.kind === 'incompatible') {
    message = 'This server needs a newer version of the app';
    canRetry = false;
  } else if (
    status.kind === 'unavailable' &&
    status.reason === 'not-published'
  ) {
    message = 'This server has not published an Android UI yet';
  } else if (!loading) {
    const error = (status.kind === 'error' && status.message) || '';
    message =
      untrustedServerMessage(error) ||
      error ||
      'Could not load the app from your server';
  }
  return (
    <KeyboardSafeScreen
      className="flex flex-col items-center justify-center bg-background text-foreground p-6 text-center"
      data-ui="android-ota-first-load"
    >
      <div
        className={`text-sm mb-6 max-w-md break-words ${loading ? 'text-muted-foreground' : 'text-destructive'}`}
      >
        {message}
      </div>
      {!loading && canRetry && (
        <Button
          onClick={() =>
            window.dispatchEvent(new Event(ANDROID_OTA_AVAILABLE_EVENT))
          }
        >
          Retry
        </Button>
      )}
      <div className="mt-4 w-full max-w-sm">
        <ServerSettings label="Change server" onSaved={onServerSaved} />
      </div>
    </KeyboardSafeScreen>
  );
}

function LoadingScreen() {
  return (
    <div
      data-ui="application-startup"
      className="h-screen bg-background"
      aria-label="Starting application"
    />
  );
}

function PendingApprovalScreen() {
  const username = useAuth((s) => s.user?.username ?? null);
  return (
    <div className="h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="size-12 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 flex items-center justify-center mx-auto">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="size-6"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Waiting for admin approval</h1>
          <p className="text-sm text-muted-foreground">
            {username ? (
              <>
                You're signed in as{' '}
                <span className="font-medium text-foreground">{username}</span>,
                but this device hasn't been approved yet.
              </>
            ) : (
              <>This device hasn't been approved yet.</>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            An administrator needs to approve it before you can use the app.
          </p>
        </div>
        <div className="flex flex-col gap-3 w-full max-w-xs mx-auto">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              import('@/lib/auth').then(({ checkAuth }) => checkAuth());
            }}
          >
            Check again
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              import('@/lib/auth').then(({ logout }) => logout());
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

function LockScreen({
  method,
  userId,
}: {
  method: LockMethod;
  userId: string | null;
}) {
  if (method === 'pin') return <PinLockScreen userId={userId} />;
  if (method === 'biometric') return <BiometricUnlockScreen />;
  if (method === 'web-pin') return <WebPinUnlockScreen />;
  return <BiometricLockScreen />;
}

function PinLockScreen({ userId }: { userId: string | null }) {
  const { setLocked } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function attemptUnlock(value: string) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const r: AppPinVerifyResult = await appVerifyAppPin(userId, value);
      if (r.ok) {
        markUserActive();
        setLocked(false);
        return;
      }
      if (r.reason === 'wrong') {
        setPin('');
        const left = r.attemptsRemaining;
        setError(
          left === 1
            ? 'Wrong PIN. 1 attempt left before the device is unregistered.'
            : `Wrong PIN. ${left} attempts left.`,
        );
        setTimeout(() => inputRef.current?.focus(), 0);
      } else if (r.reason === 'kill_switch') {
        // Native already wiped the Keystore device key + creds. The PIN
        // verifier itself survives (per-user, on a separate Keystore
        // alias) so the same user re-logs in and uses the same PIN.
        toast.error(
          'Too many wrong attempts. Device unregistered — please log in again.',
        );
        await logout();
        setLocked(false);
      } else if (r.reason === 'no_pin') {
        // PIN was disabled while the lock screen was showing — unlock and
        // let AuthGate re-evaluate.
        setLocked(false);
      } else if (r.reason === 'duress') {
        // Duress entry: signal, wipe credentials, log out, show the fake
        // connection-error screen (see runDuressSequence).
        await runDuressSequence();
        setLocked(false);
      } else if (r.reason === 'error') {
        setError(r.message ?? 'PIN verification failed');
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (pin.length >= APP_PIN_MIN) void attemptUnlock(pin);
  }

  async function handleSignOut() {
    await logout();
    setLocked(false);
  }

  return (
    <KeyboardSafeScreen className="flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="text-center space-y-2">
          <Lock className="w-10 h-10 mx-auto text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Enter PIN
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter your CarapaBoard PIN to unlock.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            maxLength={APP_PIN_MAX}
            disabled={busy}
          />
          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={busy || pin.length < APP_PIN_MIN}
          >
            {busy ? 'Verifying…' : 'Unlock'}
          </Button>
        </form>

        <Button
          variant="ghost"
          onClick={handleSignOut}
          disabled={busy}
          className="w-full"
        >
          Sign out
        </Button>
      </div>
    </KeyboardSafeScreen>
  );
}

function BiometricUnlockScreen() {
  // Web/iOS path. The session vault is encrypted under a key derived
  // from a WebAuthn PRF assertion — biometric (Touch ID / Face ID /
  // Windows Hello / hardware key with UV) is required to unwrap. Lock
  // engagement zeroed the in-memory secrets, so until the assertion
  // succeeds, no API call can succeed.
  //
  // We surface a button-driven unlock rather than auto-firing on mount.
  // Safari requires a user gesture for `navigator.credentials.get` and
  // some Windows setups race with the page-load animation otherwise.
  const { setLocked, user } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function unlock() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const credentialId = vaultGetCredentialId();
      if (!credentialId) {
        // Vault was removed under us (e.g. user wiped storage in another
        // tab). Drop the lock and let AuthGate re-evaluate.
        setLocked(false);
        return;
      }
      const prf = await webauthnAssertWithPRF(credentialId);
      await vaultUnwrapFromStorage(prf);
      // Blob from before owners were tracked: the signed-in account is the
      // one whose device signs requests, so record it as the owner.
      if (user) await vaultAdoptOwner(prf, user.username).catch(() => {});
      markUserActive();
      setLocked(false);
    } catch (err) {
      if (!isCancelError(err)) {
        setError('Authentication failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    await logout();
    setLocked(false);
  }

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-background px-6 gap-4">
      <Fingerprint className="w-12 h-12 text-muted-foreground" />
      <p className="text-sm text-muted-foreground text-center">
        Locked. Use Touch ID / Windows Hello / your hardware key to continue.
      </p>
      {error && <p className="text-sm text-destructive text-center">{error}</p>}
      <Button
        onClick={unlock}
        disabled={busy}
        className="space-x-2 w-full max-w-sm"
      >
        <Fingerprint className="w-4 h-4" />
        <span>{busy ? 'Authenticating…' : 'Unlock'}</span>
      </Button>
      <Button
        variant="ghost"
        onClick={handleSignOut}
        disabled={busy}
        className="w-full max-w-sm"
      >
        Sign out
      </Button>
    </div>
  );
}

function WebPinUnlockScreen() {
  // Web path for a browser whose user enrolled a PIN vault. The session
  // secrets exist only in memory and inside the Argon2id/AES-GCM PIN blob;
  // lock engagement or a reload leaves memory empty until the PIN unwraps it.
  const { setLocked } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function unlock(value: string) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const username = vaultPinUsername();
      if (!username) {
        // Vault was removed under us (e.g. disabled in another tab). Drop the
        // lock and let AuthGate re-evaluate.
        setLocked(false);
        return;
      }
      const r = await unlockPinVault(username, value);
      if (r.ok) {
        vaultApplyPinUnlock(username, r.creds, r.authToken, r.handle);
        markUserActive();
        setLocked(false);
        return;
      }
      if (r.reason === 'wrong_pin') {
        setPin('');
        setError(
          r.attemptsLeft === 1
            ? 'Wrong PIN. 1 attempt left before this device is wiped.'
            : `Wrong PIN. ${r.attemptsLeft} attempts left.`,
        );
        setTimeout(() => inputRef.current?.focus(), 0);
      } else if (r.reason === 'kill_switch') {
        // The vault itself was already wiped; drop the session too.
        toast.error(
          'Too many wrong attempts. This device was wiped — please log in again.',
        );
        await logout();
        setLocked(false);
      } else if (r.reason === 'no_vault') {
        setLocked(false);
      } else {
        setError(r.message || 'PIN unlock failed');
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (pin.length >= APP_PIN_MIN) void unlock(pin);
  }

  async function handleSignOut() {
    await logout();
    setLocked(false);
  }

  return (
    <div
      data-ui="web-pin-lock-screen"
      className="h-screen flex items-center justify-center bg-background"
    >
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="text-center space-y-2">
          <Lock className="w-10 h-10 mx-auto text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Enter PIN
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter your browser PIN to unlock.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            ref={inputRef}
            type="password"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            disabled={busy}
          />
          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={busy || pin.length < APP_PIN_MIN}
          >
            {busy ? 'Verifying…' : 'Unlock'}
          </Button>
        </form>

        <Button
          variant="ghost"
          onClick={handleSignOut}
          disabled={busy}
          className="w-full"
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}

function BiometricLockScreen() {
  // Native fallback when no app PIN is configured. Uses
  // capacitor-native-biometric which goes through the system
  // BiometricPrompt — separate from the WebAuthn path used on web/iOS.
  const { setLocked } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function unlock() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await NativeBridge.biometricLogin();
      markUserActive();
      setLocked(false);
    } catch (err) {
      if (!isCancelError(err)) {
        setError('Authentication failed');
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignOut() {
    await logout();
    setLocked(false);
  }

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-background px-6 gap-4">
      <Fingerprint className="w-12 h-12 text-muted-foreground" />
      <p className="text-sm text-muted-foreground text-center">
        Locked. Use biometrics to continue.
      </p>
      {error && <p className="text-sm text-destructive text-center">{error}</p>}
      <Button
        onClick={unlock}
        disabled={busy}
        className="space-x-2 w-full max-w-sm"
      >
        <Fingerprint className="w-4 h-4" />
        <span>{busy ? 'Authenticating…' : 'Unlock'}</span>
      </Button>
      <Button
        variant="ghost"
        onClick={handleSignOut}
        disabled={busy}
        className="w-full max-w-sm"
      >
        Sign out
      </Button>
    </div>
  );
}

function LoginForm() {
  const { setAuth, sessionExpired } = useAuth();
  const connectionMode = useStore((state) => state.connectionMode);
  const { homeUrl, remoteUrl, singleServer } = useServerUrls();
  const [editingServer, setEditingServer] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  // Switches the form into PIN-entry mode after the first submit reports that
  // a PIN vault is enrolled for this username. Username + password stay in
  // state so the second submit can resend them unchanged.
  const [pinRequired, setPinRequired] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [canBiometricLogin, setCanBiometricLogin] = useState(false);

  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    (async () => {
      await initBiometricAvailability();
      if (cancelled) return;
      const available = isBiometricAvailableCached();
      setBiometricAvailable(available);
      if (!available) return;
      const canLogin = isAndroidNative()
        ? await hasNativeCredentials()
        : !!(await NativeBridge.getSecureCredentials());
      if (cancelled) return;
      setCanBiometricLogin(canLogin);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror the attempt into the store so a setup link cannot replace the
  // server while a sign-in is finishing (and vice versa).
  useLayoutEffect(() => {
    useAuth.getState().setSigningIn(loading);
    return () => useAuth.getState().setSigningIn(false);
  }, [loading]);

  async function handleBiometricLogin() {
    if (loading || editingServer || useAuth.getState().serverChanging) return;
    setError('');
    setLoading(true);
    try {
      if (isAndroidNative()) {
        const result = await loginWithDeviceBiometrics();
        if (result.ok) {
          setAuth(true, true, result.user ?? null);
          navigateHomeAfterLogin();
        } else {
          setError(
            result.error ?? 'Could not restore your session. Please try again.',
          );
        }
        return;
      }
      await NativeBridge.biometricLogin();
      const creds = await NativeBridge.getSecureCredentials();
      if (!creds) {
        setCanBiometricLogin(false);
        setError('No saved credentials. Please log in.');
        return;
      }
      const result = await login(undefined, creds.username, creds.password);
      if (result.ok) {
        setAuth(true, true, result.user ?? null);
        // Defense-in-depth: ensure the new session never inherits the previous
        // user's URL (logout already routes to `/`, but a forced session loss
        // — server-side invalidation, kill-switch — may have skipped it).
        navigateHomeAfterLogin();
      } else {
        await NativeBridge.deleteSecureCredentials();
        setCanBiometricLogin(false);
        setError('Saved credentials no longer valid. Please log in.');
      }
    } catch (err) {
      if (!isCancelError(err)) {
        setError('Biometric authentication failed');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading || editingServer || useAuth.getState().serverChanging) return;
    setError('');
    setLoading(true);
    try {
      const result = await login(
        undefined,
        username,
        password,
        pinRequired ? pin : undefined,
      );
      if (result.ok) {
        if (isNative && !isAndroidNative() && biometricAvailable) {
          const enableBiometric = await confirmAction(
            'Sign in with your fingerprint or face next time instead of typing your password.',
            { title: 'Enable biometric login?', confirmLabel: 'Enable' },
          );
          if (enableBiometric) {
            try {
              await NativeBridge.setSecureCredentials({ username, password });
              setCanBiometricLogin(true);
            } catch (saveErr) {
              console.error('Failed to save biometric credentials:', saveErr);
            }
          }
        }
        setAuth(true, true, result.user ?? null);
        // Defense-in-depth: ensure the new session never inherits the previous
        // user's URL (logout already routes to `/`, but a forced session loss
        // — server-side invalidation, kill-switch — may have skipped it).
        navigateHomeAfterLogin();
        return;
      }
      // Failure routing. The auth.login() helper communicates PIN-related
      // outcomes via the `reason` field so the form can switch into
      // PIN-entry mode without surfacing a misleading "wrong password".
      if (result.reason === 'pin_required') {
        setPinRequired(true);
        setPin('');
        setError('');
        return;
      }
      if (result.reason === 'pin_wrong') {
        const left = result.attemptsLeft ?? 0;
        setPin('');
        setError(
          left === 1
            ? 'Wrong PIN. 1 attempt left before this device is wiped.'
            : `Wrong PIN. ${left} attempts left.`,
        );
        return;
      }
      if (result.reason === 'pin_kill_switch') {
        setPinRequired(false);
        setPin('');
        setError(
          'Too many wrong PIN attempts. This device was wiped — log in to enroll again.',
        );
        return;
      }
      // Prefer the server's message (e.g. device-conflict 403) over the
      // generic credentials hint; fall back when there isn't one.
      setError(result.error ?? 'Invalid username or password');
    } catch (err) {
      console.error('Login error:', err);
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelPin() {
    setPinRequired(false);
    setPin('');
    setError('');
  }

  function handleServerSaved(credentialsWiped: boolean) {
    if (credentialsWiped) setCanBiometricLogin(false);
    setError('');
  }

  function selectConnection(mode: 'home' | 'remote') {
    useStore.getState().setConnectionMode(mode);
    updateApiBaseUrl(mode);
    setError('');
  }

  return (
    <KeyboardSafeScreen className="flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4 py-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Carapa
          </h1>
          <p className="text-sm text-muted-foreground">
            Welcome to your AI assistant
          </p>
        </div>

        {sessionExpired && (
          <p
            role="alert"
            data-ui="login-session-expired"
            className="text-sm text-center text-muted-foreground"
          >
            Your session expired. Sign in again.
          </p>
        )}

        {isNative && biometricAvailable && canBiometricLogin && (
          <Button
            type="button"
            variant="outline"
            className="w-full space-x-2"
            onClick={handleBiometricLogin}
            disabled={loading || editingServer}
          >
            <Fingerprint className="w-4 h-4" />
            <span>Login with Biometrics</span>
          </Button>
        )}

        {isNative && !singleServer && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground text-center">
              Connect to
            </p>
            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-label="Server connection"
            >
              {(['home', 'remote'] as const).map((mode) => {
                const selected = connectionMode === mode;
                return (
                  <Button
                    key={mode}
                    type="button"
                    variant={selected ? 'default' : 'outline'}
                    className="h-auto py-2 text-xs"
                    onClick={() => selectConnection(mode)}
                    disabled={loading || editingServer}
                    aria-pressed={selected}
                  >
                    <span className="flex flex-col gap-0.5">
                      <span>
                        {mode === 'home' ? 'Home / LAN' : 'Remote / Cloud'}
                      </span>
                      <span className="font-normal opacity-70">
                        {
                          new URL(mode === 'home' ? homeUrl : remoteUrl)
                            .hostname
                        }
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {pinRequired ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground text-center">
                This browser is protected by a PIN. Enter it to unlock{' '}
                {username}'s device.
              </p>
              <Input
                type="password"
                placeholder="PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoFocus
                autoComplete="off"
                required
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                required
              />
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={
              loading ||
              editingServer ||
              (pinRequired ? !pin : !username || !password)
            }
          >
            {loading
              ? pinRequired
                ? 'Unlocking...'
                : 'Signing in...'
              : pinRequired
                ? 'Unlock'
                : 'Sign in'}
          </Button>
          {pinRequired && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={handleCancelPin}
              disabled={loading}
            >
              Use a different account
            </Button>
          )}
        </form>

        {isNative && !pinRequired && (
          <ServerSettings
            disabled={loading}
            onOpenChange={setEditingServer}
            onSaved={handleServerSaved}
          />
        )}
      </div>
    </KeyboardSafeScreen>
  );
}

/**
 * "Server" button that opens the address editor. `onOpenChange` lets the
 * parent block sign-in while the editor is open, so a login can never finish
 * against a server that is being replaced.
 */
function ServerSettings({
  disabled,
  label = 'Server',
  onOpenChange,
  onSaved,
}: {
  disabled?: boolean;
  label?: string;
  onOpenChange?: (open: boolean) => void;
  onSaved: (credentialsWiped: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  function toggle(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }
  if (open) {
    return (
      <ServerEditor
        onSaved={(wiped) => {
          useAuth.getState().setServerChanging(false);
          toggle(false);
          onSaved(wiped);
        }}
        onCancel={() => toggle(false)}
      />
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-full text-xs text-muted-foreground"
      onClick={() => toggle(true)}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

/** First run without a server: nothing is contacted until one is set up. */
function ServerSetupScreen() {
  const [editing, setEditing] = useState(false);
  return (
    <KeyboardSafeScreen
      className="flex flex-col items-center justify-center bg-background text-foreground p-6 text-center"
      data-ui="server-setup-screen"
    >
      <div className="font-bold mb-4">Set up your server</div>
      <div className="text-sm text-muted-foreground mb-6 max-w-md">
        Open your board in a browser, go to Account → Connect the Android app,
        and scan the setup QR code with this phone's camera.
      </div>
      <div className="w-full max-w-sm">
        {editing ? (
          <ServerEditor
            // Import-time endpoints (e.g. in api.ts) were built without an
            // origin, so restart against the new server like a setup link.
            onSaved={() => window.location.reload()}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Button type="button" onClick={() => setEditing(true)}>
            Enter the address manually
          </Button>
        )}
      </div>
    </KeyboardSafeScreen>
  );
}

/** Login-screen editor for the Home / Remote server addresses (native only). */
function ServerEditor({
  onSaved,
  onCancel,
}: {
  onSaved: (credentialsWiped: boolean) => void;
  onCancel: () => void;
}) {
  const stored = getServerConfig();
  const [homeInput, setHomeInput] = useState(stored.homeUrl ?? '');
  const [remoteInput, setRemoteInput] = useState(stored.remoteUrl ?? '');
  const [homeError, setHomeError] = useState('');
  const [remoteError, setRemoteError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  // Failure keeps the previous addresses: the native credential wipe failed.
  async function apply(next: ServerConfig | null) {
    setSaveError('');
    setSaving(true);
    // Held until the caller has finished the change (a reload, or resuming the
    // auth check): the gate must not ask the new address while the OTA reset
    // is pending, nor after it failed.
    useAuth.getState().setServerChanging(true);
    try {
      onSaved(await applyServerConfig(next));
    } catch (err) {
      console.error('Server change failed:', err);
      if (err instanceof ServerChangeIncompleteError) {
        // Startup recovery retries behind a blocking screen.
        window.location.reload();
        return;
      }
      useAuth.getState().setServerChanging(false);
      setSaveError(
        'Could not remove the saved device credentials, so the server was not changed. Try again or restart the app.',
      );
    } finally {
      setSaving(false);
    }
  }

  // Ask before a change discards a stored pin or the OTA key.
  async function confirmTrustLoss(next: ServerConfig | null) {
    const lost = [
      ...(['home', 'remote'] as const).flatMap((key) => {
        const url = stored[`${key}Url`];
        return stored[`${key}CertSha256`] &&
          next?.[`${key}CertSha256`] === undefined
          ? [`The pinned certificate for ${url} will be removed.`]
          : [];
      }),
      ...(stored.otaPublicKey && next?.otaPublicKey === undefined
        ? [
            'UI updates from this board will stop until the app is paired again.',
          ]
        : []),
    ];
    if (!lost.length) return true;
    return confirmAction(
      `${lost.join('\n')}\nThe app will then need the board's setup link (Account → Connect the Android app) again to trust a self-signed server.`,
      { title: 'Remove trust settings?', confirmLabel: 'Remove and save' },
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const fields = [homeInput, remoteInput].map((value) =>
      value.trim() ? parseServerUrl(value) : null,
    );
    const [home, remote] = fields;
    setHomeError(home && 'error' in home ? home.error : '');
    setRemoteError(remote && 'error' in remote ? remote.error : '');
    if (fields.some((f) => f && 'error' in f)) return;
    if (!home && !remote) {
      setHomeError('Enter at least one address');
      return;
    }
    const homeUrl = home && 'url' in home ? home.url : undefined;
    const remoteUrl = remote && 'url' in remote ? remote.url : undefined;
    // A pin belongs to its address, the OTA key to the unchanged server pair.
    const homeSame = homeUrl === stored.homeUrl;
    const remoteSame = remoteUrl === stored.remoteUrl;
    const next: ServerConfig = {
      homeUrl,
      remoteUrl,
      homeCertSha256: homeSame ? stored.homeCertSha256 : undefined,
      remoteCertSha256: remoteSame ? stored.remoteCertSha256 : undefined,
      otaPublicKey: homeSame && remoteSame ? stored.otaPublicKey : undefined,
    };
    if (await confirmTrustLoss(next)) await apply(next);
  }

  async function reset() {
    if (await confirmTrustLoss(null)) await apply(null);
  }

  return (
    <form
      onSubmit={save}
      noValidate
      className="space-y-3 rounded-md border p-3"
      data-ui="login-server-editor"
    >
      {(
        [
          [
            'Home / LAN URL',
            homeInput,
            setHomeInput,
            homeError,
            stored.homeUrl,
            stored.homeCertSha256,
          ],
          [
            'Remote URL',
            remoteInput,
            setRemoteInput,
            remoteError,
            stored.remoteUrl,
            stored.remoteCertSha256,
          ],
        ] as const
      ).map(([label, value, setValue, fieldError, storedUrl, storedPin]) => (
        <label key={label} className="block space-y-1 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <Input
            type="url"
            inputMode="url"
            placeholder="https://board.example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!!fieldError}
          />
          {fieldError && <span className="text-destructive">{fieldError}</span>}
          {storedUrl && (
            <span className="block text-muted-foreground">
              {describeCertPin(storedPin)}
            </span>
          )}
        </label>
      ))}
      {stored.otaPublicKey && (
        <p className="text-xs text-muted-foreground">
          {describeOtaKey(stored.otaPublicKey)}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Leave one empty to use a single server. Changing the server signs out
        and removes saved logins.
      </p>
      <p className="text-xs text-muted-foreground">
        Addresses typed here carry no certificate pin and no update key. To
        connect to a self-signed board or receive UI updates, scan the setup QR
        from the board's Account → Connect the Android app instead.
      </p>
      {saveError && (
        <p role="alert" className="text-xs text-destructive">
          {saveError}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="flex-1" disabled={saving}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full text-xs"
        onClick={() => void reset()}
        disabled={saving}
      >
        Reset to app defaults
      </Button>
    </form>
  );
}
