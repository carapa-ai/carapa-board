import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import {
  pinVaultStatus,
  enrollPinVault,
  unlockPinVault,
  deletePinVault,
  validateWebVaultPin,
  type DeviceCreds,
  type PinVaultStatus,
} from '@/lib/pin-vault';
import {
  loadPerUserDeviceCreds,
  savePerUserDeviceCreds,
  clearPerUserDeviceCreds,
  vaultDisablePin,
  vaultEnablePin,
  vaultGetAuthToken,
  vaultIsConfigured,
} from '@/lib/session-vault';

// PIN-vault management is a web-only feature. Native (Android Keystore) and
// biometric web (Windows Hello / Touch ID) browsers already protect the
// device keypair at rest; piling a PIN on top would create two competing
// wrap stores and isn't worth the complexity.
function isApplicable(): boolean {
  if (Capacitor.isNativePlatform()) return false;
  if (vaultIsConfigured()) return false;
  return true;
}

export function PinVaultSettings() {
  const username = useAuth((s) => s.user?.username ?? null);
  const applicable = isApplicable();

  const [status, setStatus] = useState<PinVaultStatus>({
    exists: false,
    attemptsLeft: 5,
    weak: false,
  });
  const [mode, setMode] = useState<'idle' | 'enroll' | 'disable'>('idle');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setStatus(pinVaultStatus(username));
  }, [username]);

  function refreshStatus() {
    setStatus(pinVaultStatus(username));
  }

  function reset() {
    setMode('idle');
    setPin('');
    setConfirmPin('');
    setError('');
  }

  async function handleEnroll() {
    if (!username) return;
    setError('');
    const policyError = validateWebVaultPin(pin);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match.');
      return;
    }

    // We need a usable keypair to wrap. Before a PIN exists, the current
    // keypair lives in plaintext under `carapa_device_<username>`.
    const creds: DeviceCreds | null = loadPerUserDeviceCreds(username);
    if (!creds) {
      setError(
        'No device keypair found on this browser yet. Log out and log back in once, then try again.',
      );
      return;
    }

    setBusy(true);
    try {
      // The session token joins the keypair inside the wrapped blob so a
      // reload can resume after the PIN is entered.
      const result = await enrollPinVault(
        username,
        pin,
        creds,
        vaultGetAuthToken(),
      );
      if (!result.ok || !result.handle) {
        setError(result.error ?? 'Failed to enroll PIN.');
        return;
      }
      // The wrapped blob is now the only at-rest copy: move the live session
      // secrets to memory and remove every plaintext copy.
      vaultEnablePin(username, creds, result.handle);
      clearPerUserDeviceCreds(username);
      refreshStatus();
      reset();
      toast.success('PIN enabled. You will be asked for it on next login.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    if (!username) return;
    setError('');
    if (!pin) {
      setError('Enter your current PIN.');
      return;
    }
    setBusy(true);
    try {
      const result = await unlockPinVault(username, pin);
      if (!result.ok) {
        if (result.reason === 'wrong_pin') {
          setPin('');
          setError(
            result.attemptsLeft === 1
              ? 'Wrong PIN. 1 attempt left before this device is wiped.'
              : `Wrong PIN. ${result.attemptsLeft} attempts left.`,
          );
        } else if (result.reason === 'kill_switch') {
          setError(
            'Too many wrong attempts — the PIN-protected keypair was wiped. Log out and back in to enroll fresh.',
          );
          refreshStatus();
        } else {
          setError('PIN unlock failed.');
        }
        return;
      }
      // Intentionally move the session back to plaintext storage so signing
      // keeps working post-disable.
      savePerUserDeviceCreds(username, result.creds);
      deletePinVault(username);
      vaultDisablePin(result.creds, result.authToken);
      refreshStatus();
      reset();
      toast.success('PIN protection disabled.');
    } finally {
      setBusy(false);
    }
  }

  if (!applicable) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <CardTitle className="text-base">PIN protection</CardTitle>
          <p className="text-sm text-muted-foreground">
            {Capacitor.isNativePlatform()
              ? 'Not needed — this app already uses the Android Keystore to protect your keypair.'
              : "Not needed — this browser's keypair is already protected by biometric unlock."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              PIN protection
              {status.exists ? (
                <Badge className="text-[10px] px-1.5 py-0 bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/50 dark:text-emerald-300 dark:border-emerald-800">
                  Enabled
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Off
                </Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Encrypt this browser's device keypair and session token with a
              PIN. Argon2id-derived key, AES-GCM-wrapped; while enabled they are
              kept in memory only and never stored in plaintext on disk. The PIN
              must be at least 8 characters with letters and digits. You will be
              asked for the PIN to unlock after a reload or a long absence, and
              on every login from this browser.
            </p>
            {status.exists && status.weak && (
              <p
                data-ui="pin-vault-weak-warning"
                className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1"
              >
                <ShieldAlert className="size-3 mt-0.5 shrink-0" />
                Your PIN is short; anyone who copies this browser's data could
                guess it. Disable and set a longer PIN.
              </p>
            )}
            {status.exists && status.attemptsLeft < 5 && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <ShieldAlert className="size-3" />
                {status.attemptsLeft} wrong-PIN{' '}
                {status.attemptsLeft === 1 ? 'attempt' : 'attempts'} left this
                window.
              </p>
            )}
          </div>
        </div>

        {mode === 'idle' && (
          <div className="flex items-center gap-2">
            {!status.exists ? (
              <Button size="sm" onClick={() => setMode('enroll')}>
                <ShieldCheck className="size-3.5 mr-1" />
                Set up PIN
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMode('disable')}
              >
                Disable PIN
              </Button>
            )}
          </div>
        )}

        {mode === 'enroll' && (
          <div className="space-y-3 pt-2 border-t">
            <p className="text-xs text-muted-foreground">
              Choose a PIN. Forgetting it means losing this device's approval —
              you'll need to log in fresh and ask an admin to approve again.
            </p>
            <Input
              type="password"
              placeholder="New PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
              autoComplete="new-password"
            />
            <Input
              type="password"
              placeholder="Confirm PIN"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters, letters and digits.
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleEnroll}
                disabled={busy || !pin || !confirmPin}
              >
                {busy && <Loader2 className="size-3.5 mr-1 animate-spin" />}
                Enable
              </Button>
            </div>
          </div>
        )}

        {mode === 'disable' && (
          <div className="space-y-3 pt-2 border-t">
            <p className="text-xs text-muted-foreground">
              Enter your current PIN to disable protection. The keypair and
              session token will go back to plaintext storage on this browser.
            </p>
            <Input
              type="password"
              placeholder="Current PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
              autoComplete="off"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDisable}
                disabled={busy || !pin}
              >
                {busy && <Loader2 className="size-3.5 mr-1 animate-spin" />}
                Disable PIN
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
