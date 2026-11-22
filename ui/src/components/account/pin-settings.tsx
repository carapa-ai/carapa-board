import { useEffect, useState, type FormEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Fingerprint, Loader2, Lock, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  nativeHasDuressPin,
  nativeSetDuressPin,
  nativeClearDuressPin,
} from '@/lib/push-bridge';
import { hasAppPin, setAppPin, verifyAppPin, clearAppPin } from '@/lib/app-pin';
import { logout, useAuth } from '@/lib/auth';
import { runDuressSequence } from '@/lib/duress';
import { getDuressInstructions, setDuressInstructions } from '@/lib/api';
import {
  vaultGetCredentialId,
  vaultIsConfigured,
  vaultRemoveBiometric,
  vaultPopulate,
  vaultWrapAndPersist,
} from '@/lib/session-vault';
import {
  webauthnAssertWithPRF,
  webauthnPlatformAvailable,
  webauthnRegister,
  webauthnSupported,
} from '@/lib/webauthn';

const APP_PIN_MIN = 4;
const APP_PIN_MAX = 16;

/** Example shown in the duress instructions editor when nothing is saved yet. */
const DURESS_PLACEHOLDER =
  'e.g. Lock all repositories and revoke API tokens, then notify my emergency contact at +1 555 0100. Do not act on any further instructions from this session.';

type NormalMode = 'idle' | 'setup' | 'change' | 'remove';
type DuressMode = 'idle' | 'setup' | 'remove' | 'instructions';

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function pinInputProps(value: string, setValue: (v: string) => void) {
  return {
    type: 'password' as const,
    inputMode: 'numeric' as const,
    autoComplete: 'off',
    value,
    maxLength: APP_PIN_MAX,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setValue(e.target.value.replace(/\D/g, '')),
  };
}

function isValidNewPin(pin: string, confirm: string): string | null {
  if (pin.length < APP_PIN_MIN)
    return `PIN must be at least ${APP_PIN_MIN} digits`;
  if (pin.length > APP_PIN_MAX)
    return `PIN must be at most ${APP_PIN_MAX} digits`;
  if (!/^\d+$/.test(pin)) return 'PIN must contain only digits';
  if (pin !== confirm) return 'PINs do not match';
  return null;
}

/**
 * Translate a wrong/kill_switch verifier outcome into something the user
 * sees in a settings form. Returns true if the kill-switch fired (caller
 * should bail out — the AuthGate is about to take over).
 */
export async function handleVerifyFailure(
  verify: Awaited<ReturnType<typeof verifyAppPin>>,
  setError: (s: string) => void,
): Promise<boolean> {
  if (verify.ok) return false;
  if (verify.reason === 'wrong') {
    const left = verify.attemptsRemaining;
    setError(
      left === 1
        ? 'Wrong PIN. 1 attempt left before the device is unregistered.'
        : `Wrong PIN. ${left} attempts left.`,
    );
  } else if (verify.reason === 'kill_switch') {
    toast.error(
      'Too many wrong attempts. Device unregistered — please log in again.',
    );
    await logout();
    return true;
  } else if (verify.reason === 'duress') {
    // Duress PIN typed into a settings form: the user unlocked with the
    // normal PIN, so nothing has signalled duress yet. Run the full sequence;
    // no toast, so the coercer only sees the generic connection-error screen.
    await runDuressSequence();
    return true;
  } else if (verify.reason === 'error') {
    setError(verify.message ?? 'Verification failed');
  } else {
    setError('No PIN configured');
  }
  return false;
}

export function PinSettings() {
  // Two completely separate backends. Android stays on the hardware-backed
  // PIN (Keystore HMAC) + duress flow. Web/iOS uses WebAuthn-PRF to
  // wrap the session vault — no PIN UX, no kill-switch (the OS
  // rate-limits biometric attempts on its own).
  if (isAndroidNative()) return <AndroidPinSettings />;
  return <BiometricSettings />;
}

function AndroidPinSettings() {
  const userId = useAuth((s) => s.user?.id ?? null);
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [hasDuress, setHasDuress] = useState<boolean>(false);

  async function refresh() {
    if (!userId) {
      setHasPin(false);
      setHasDuress(false);
      return;
    }
    const [has, hasD] = await Promise.all([
      hasAppPin(userId),
      nativeHasDuressPin(userId),
    ]);
    setHasPin(has);
    setHasDuress(hasD);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (hasPin === null) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <NormalPinCard userId={userId} hasPin={hasPin} onChanged={refresh} />
      {/* Duress PIN is only meaningful once a normal PIN is in place —
          the native side rejects duress setup without one, and the
          duress flow piggybacks on the normal PIN's lock screen. */}
      {hasPin && (
        <DuressPinCard
          userId={userId}
          hasDuress={hasDuress}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

// ──── Normal app PIN ─────────────────────────────────────────────────

function NormalPinCard({
  userId,
  hasPin,
  onChanged,
}: {
  userId: string | null;
  hasPin: boolean;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<NormalMode>('idle');

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="size-4" />
            App PIN
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            An additional PIN required to unlock the app, on top of your phone's
            screen lock. Stored locally — only your device knows it. Never sent
            to the server.
          </p>
        </div>

        {mode === 'idle' && (
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm">
              <span className="text-muted-foreground">Status: </span>
              <span
                className={
                  hasPin
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
                }
              >
                {hasPin ? 'On' : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              {hasPin ? (
                <>
                  <Button variant="outline" onClick={() => setMode('change')}>
                    Change PIN
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setMode('remove')}
                  >
                    Remove PIN
                  </Button>
                </>
              ) : (
                <Button onClick={() => setMode('setup')}>Set up app PIN</Button>
              )}
            </div>
          </div>
        )}

        {mode === 'setup' && (
          <SetupForm
            userId={userId}
            onCancel={() => setMode('idle')}
            onDone={async () => {
              await onChanged();
              setMode('idle');
            }}
          />
        )}
        {mode === 'change' && (
          <ChangeForm
            userId={userId}
            onCancel={() => setMode('idle')}
            onDone={async () => {
              await onChanged();
              setMode('idle');
            }}
          />
        )}
        {mode === 'remove' && (
          <RemoveForm
            userId={userId}
            onCancel={() => setMode('idle')}
            onDone={async () => {
              await onChanged();
              setMode('idle');
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SetupForm({
  userId,
  onCancel,
  onDone,
}: {
  userId: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const v = isValidNewPin(pin, confirm);
    if (v) {
      setError(v);
      return;
    }
    setError('');
    setBusy(true);
    try {
      const r = await setAppPin(userId, pin);
      if (!r.ok) {
        setError(r.message ?? 'Failed to set PIN');
        return;
      }
      toast.success('App PIN enabled');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Choose a {APP_PIN_MIN}–{APP_PIN_MAX} digit PIN. 6+ digits is
        recommended.
      </p>
      <Input placeholder="New PIN" autoFocus {...pinInputProps(pin, setPin)} />
      <Input
        placeholder="Confirm PIN"
        {...pinInputProps(confirm, setConfirm)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || pin.length < APP_PIN_MIN || pin !== confirm}
        >
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
          Set PIN
        </Button>
      </div>
    </form>
  );
}

function ChangeForm({
  userId,
  onCancel,
  onDone,
}: {
  userId: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (current.length < APP_PIN_MIN) {
      setError('Enter your current PIN');
      return;
    }
    const v = isValidNewPin(pin, confirm);
    if (v) {
      setError(v);
      return;
    }
    if (pin === current) {
      setError('New PIN must differ from current PIN');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const verify = await verifyAppPin(userId, current);
      if (!verify.ok) {
        if (await handleVerifyFailure(verify, setError)) return;
        return;
      }
      const r = await setAppPin(userId, pin);
      if (!r.ok) {
        setError(r.message ?? 'Failed to update PIN');
        return;
      }
      toast.success('App PIN updated');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
      <Input
        placeholder="Current PIN"
        autoFocus
        {...pinInputProps(current, setCurrent)}
      />
      <Input placeholder="New PIN" {...pinInputProps(pin, setPin)} />
      <Input
        placeholder="Confirm new PIN"
        {...pinInputProps(confirm, setConfirm)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            busy ||
            current.length < APP_PIN_MIN ||
            pin.length < APP_PIN_MIN ||
            pin !== confirm
          }
        >
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}

function RemoveForm({
  userId,
  onCancel,
  onDone,
}: {
  userId: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (current.length < APP_PIN_MIN) {
      setError('Enter your current PIN');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const verify = await verifyAppPin(userId, current);
      if (!verify.ok) {
        if (await handleVerifyFailure(verify, setError)) return;
        return;
      }
      // Removing the PIN also removes the duress PIN — duress without
      // a normal PIN is not a meaningful state (the lock screen has
      // nothing to gate against), and the native verifyPin path returns
      // NoPin if no normal verifier is stored.
      await nativeClearDuressPin(userId);
      await clearAppPin(userId);
      toast.success('App PIN removed');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Removing the PIN means the lock screen will fall back to biometrics only
        (or no lock if biometrics aren't enrolled). Your duress PIN will also be
        cleared.
      </p>
      <Input
        placeholder="Current PIN"
        autoFocus
        {...pinInputProps(current, setCurrent)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={busy || current.length < APP_PIN_MIN}
        >
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
          Remove PIN
        </Button>
      </div>
    </form>
  );
}

// ──── Duress PIN ─────────────────────────────────────────────────────

function DuressPinCard({
  userId,
  hasDuress,
  onChanged,
}: {
  userId: string | null;
  hasDuress: boolean;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<DuressMode>('idle');

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="size-4" />
            Duress PIN
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A separate PIN that, when entered on the lock screen, sends a
            "duress" signal to your main agent and immediately wipes the device
            session. The agent reacts based on the emergency instructions you
            configure below. To the person watching, the app shows a generic
            connection error — they can't tell duress from a real network
            outage.
          </p>
        </div>

        {mode === 'idle' && (
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm">
              <span className="text-muted-foreground">Status: </span>
              <span
                className={
                  hasDuress
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
                }
              >
                {hasDuress ? 'On' : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              {hasDuress ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setMode('instructions')}
                  >
                    Emergency instructions
                  </Button>
                  <Button variant="outline" onClick={() => setMode('setup')}>
                    Change duress PIN
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setMode('remove')}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Button onClick={() => setMode('setup')}>
                  Set up duress PIN
                </Button>
              )}
            </div>
          </div>
        )}

        {mode === 'setup' && (
          <DuressSetupForm
            userId={userId}
            onCancel={() => setMode('idle')}
            onDone={async () => {
              await onChanged();
              setMode('idle');
            }}
          />
        )}

        {mode === 'remove' && (
          <DuressRemoveForm
            userId={userId}
            onCancel={() => setMode('idle')}
            onDone={async () => {
              await onChanged();
              setMode('idle');
            }}
          />
        )}

        {mode === 'instructions' && (
          <AndroidDuressInstructionsForm
            userId={userId}
            onClose={() => setMode('idle')}
          />
        )}
      </CardContent>
    </Card>
  );
}

function DuressSetupForm({
  userId,
  onCancel,
  onDone,
}: {
  userId: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const v = isValidNewPin(pin, confirm);
    if (v) {
      setError(v);
      return;
    }
    setError('');
    setBusy(true);
    try {
      const r = await nativeSetDuressPin(userId ?? '', pin);
      if (!r.ok) {
        if (r.reason === 'same_as_normal') {
          setError('Duress PIN must differ from your normal PIN');
        } else if (r.reason === 'no_normal_pin') {
          setError('Set up a normal PIN first');
        } else if (r.reason === 'length') {
          setError(r.message ?? 'PIN length out of range');
        } else {
          setError(r.message ?? 'Failed to set duress PIN');
        }
        return;
      }
      toast.success('Duress PIN saved');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Choose a {APP_PIN_MIN}–{APP_PIN_MAX} digit PIN that you can recall under
        pressure but is different from your normal PIN.
      </p>
      <Input
        placeholder="Duress PIN"
        autoFocus
        {...pinInputProps(pin, setPin)}
      />
      <Input
        placeholder="Confirm duress PIN"
        {...pinInputProps(confirm, setConfirm)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || pin.length < APP_PIN_MIN || pin !== confirm}
        >
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}

// Android emergency-instructions editor. Gated by the NORMAL PIN (never the
// duress PIN — typing the duress PIN would trigger the duress flow). The PIN
// is verified before loading the instructions and again before saving them.
function AndroidDuressInstructionsForm({
  userId,
  onClose,
}: {
  userId: string | null;
  onClose: () => void;
}) {
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleUnlock(e: FormEvent) {
    e.preventDefault();
    if (pin.length < APP_PIN_MIN) {
      setError('Enter your normal PIN');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const verify = await verifyAppPin(userId, pin);
      if (!verify.ok) {
        if (await handleVerifyFailure(verify, setError)) return;
        return;
      }
      const res = await getDuressInstructions();
      setValue(res.instructions);
      setUnlocked(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load instructions',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setError('');
    setBusy(true);
    try {
      // Re-verify the normal PIN before persisting (re-auth before save).
      const verify = await verifyAppPin(userId, pin);
      if (!verify.ok) {
        if (await handleVerifyFailure(verify, setError)) return;
        return;
      }
      await setDuressInstructions(value);
      toast.success('Duress instructions saved');
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save instructions',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <form onSubmit={handleUnlock} className="space-y-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          Enter your normal PIN to view and edit the instructions your agent
          follows when the duress PIN is entered.
        </p>
        <Input
          placeholder="Normal PIN"
          autoFocus
          {...pinInputProps(pin, setPin)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || pin.length < APP_PIN_MIN}>
            {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
            Unlock
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Stored on the server only — never on this device — and delivered to your
        main agent the moment the duress PIN is entered.
      </p>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        placeholder={DURESS_PLACEHOLDER}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={busy}>
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

// ──── Biometric unlock (web/iOS) ─────────────────────────────────────

function BiometricSettings() {
  // Duress instructions are account-level: a user may configure them on
  // desktop and trigger duress on their Android phone. So the editor is shown
  // unconditionally alongside the biometric-unlock card.
  return (
    <div className="space-y-6">
      <BiometricUnlockCard />
      <WebDuressInstructionsCard />
    </div>
  );
}

function BiometricUnlockCard() {
  const user = useAuth((s) => s.user);
  const [configured, setConfigured] = useState<boolean | null>(null);
  // null = still detecting, true/false = settled
  const [platformAvailable, setPlatformAvailable] = useState<boolean | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  function refresh() {
    setConfigured(vaultIsConfigured());
  }

  useEffect(() => {
    refresh();
    let cancelled = false;
    (async () => {
      if (!webauthnSupported()) {
        if (!cancelled) setPlatformAvailable(false);
        return;
      }
      const ok = await webauthnPlatformAvailable();
      if (!cancelled) setPlatformAvailable(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSetup() {
    if (busy || !user) return;
    setBusy(true);
    try {
      const reg = await webauthnRegister({
        userId: user.id,
        userName: user.username,
        displayName: user.username,
      });
      // Some authenticators don't return PRF on `create()` — follow up
      // with an immediate assertion to derive the wrapping key.
      const prf =
        reg.prfOutput ?? (await webauthnAssertWithPRF(reg.credentialId));
      // The blob must name the device owner so password logins reuse it only
      // for this account.
      vaultPopulate({ username: user.username });
      await vaultWrapAndPersist(prf, reg.credentialId);
      toast.success('Biometric unlock enabled');
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Setup failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (busy || configured !== true) return;
    setBusy(true);
    try {
      // Confirm ownership before unwrapping — same effect as asking
      // for the current PIN before "Remove PIN" on Android.
      const credentialId = vaultIsConfigured()
        ? localStorage.getItem('webauthn_v1')
          ? (JSON.parse(localStorage.getItem('webauthn_v1') as string)
              .credentialId as string)
          : null
        : null;
      if (!credentialId) {
        toast.error('No biometric credential found');
        refresh();
        return;
      }
      const prf = await webauthnAssertWithPRF(credentialId);
      await vaultRemoveBiometric(prf);
      toast.success('Biometric unlock removed');
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Removal failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  if (configured === null || platformAvailable === null) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            <Fingerprint className="size-4" />
            Biometric Unlock
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Require Touch ID, Face ID, Windows Hello, or a hardware key on every
            page load. Your session keys are encrypted with a key derived from
            the WebAuthn PRF — without a successful biometric, the saved session
            can't be decrypted, even by a stolen laptop.
          </p>
          {!platformAvailable && !configured && (
            <p className="text-xs text-muted-foreground">
              No platform authenticator detected on this device. You can still
              set up biometric unlock if you have a hardware security key
              plugged in.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Status: </span>
            <span
              className={
                configured
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground'
              }
            >
              {configured ? 'On' : 'Off'}
            </span>
          </div>
          <div className="flex gap-2">
            {configured ? (
              <Button
                variant="destructive"
                onClick={handleRemove}
                disabled={busy}
              >
                {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
                Remove biometric unlock
              </Button>
            ) : (
              <Button
                onClick={handleSetup}
                disabled={busy || !webauthnSupported()}
              >
                {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
                Set up biometric unlock
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DuressRemoveForm({
  userId,
  onCancel,
  onDone,
}: {
  userId: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (current.length < APP_PIN_MIN) {
      setError('Enter your normal PIN to authorize');
      return;
    }
    setError('');
    setBusy(true);
    try {
      // Authorize removal with the NORMAL PIN (not the duress PIN —
      // typing the duress PIN would trigger the duress flow itself).
      const verify = await verifyAppPin(userId, current);
      if (!verify.ok) {
        if (await handleVerifyFailure(verify, setError)) return;
        return;
      }
      await nativeClearDuressPin(userId);
      toast.success('Duress PIN removed');
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Enter your normal PIN to authorize removing the duress PIN.
      </p>
      <Input
        placeholder="Normal PIN"
        autoFocus
        {...pinInputProps(current, setCurrent)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={busy || current.length < APP_PIN_MIN}
        >
          {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
          Remove duress PIN
        </Button>
      </div>
    </form>
  );
}

// ──── Duress instructions (web/iOS) ──────────────────────────────────

// Dedicated, always-visible card for editing the emergency instructions the
// main agent follows when the duress PIN is entered. The duress PIN itself is
// Android-only, but the instructions are account-level, so they're editable
// from any platform. Load and save are each gated by a biometric/WebAuthn
// re-auth (a fresh assertion against the configured credential).
function WebDuressInstructionsCard() {
  const [mode, setMode] = useState<'idle' | 'edit'>('idle');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function reauth(): Promise<boolean> {
    const credentialId = vaultGetCredentialId();
    if (!credentialId) {
      setError('Set up biometric unlock first to manage duress instructions.');
      return false;
    }
    try {
      await webauthnAssertWithPRF(credentialId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      return false;
    }
  }

  async function handleManage() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (!(await reauth())) return;
      const res = await getDuressInstructions();
      setValue(res.instructions);
      setMode('edit');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load instructions',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (!(await reauth())) return;
      await setDuressInstructions(value);
      toast.success('Duress instructions saved');
      setMode('idle');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save instructions',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="size-4" />
            Duress instructions
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            What your main agent should do if your duress PIN is entered on a
            mobile device — for example, lock repositories, revoke tokens, or
            notify someone. Stored on the server only, never on a device, and
            delivered the moment the duress signal fires. The duress PIN itself
            is set up on your Android phone.
          </p>
        </div>

        {mode === 'idle' && (
          <div className="flex items-center justify-end gap-2">
            {error && (
              <p className="text-sm text-destructive mr-auto">{error}</p>
            )}
            <Button onClick={handleManage} disabled={busy}>
              {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
              Manage instructions
            </Button>
          </div>
        )}

        {mode === 'edit' && (
          <div className="space-y-3 border-t pt-4">
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={6}
              placeholder={DURESS_PLACEHOLDER}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setMode('idle')}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} disabled={busy}>
                {busy && <Loader2 className="size-4 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
