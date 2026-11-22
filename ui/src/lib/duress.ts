import { sendDuressSignal } from '@/lib/api';
import { logout, useAuth } from '@/lib/auth';
import { clearNativeCredentials } from '@/lib/push-bridge';

/**
 * Run the duress response after the duress PIN was entered (lock screen or a
 * PIN settings form). Order matters here:
 *   1. sendDuressSignal — must run while the device key is still alive, since
 *      the request is signed by it. A failure (e.g. offline) must not keep the
 *      key alive, so it is swallowed and the wipe still happens.
 *   2. clearNativeCredentials — wipe the Keystore device key + persisted creds
 *      (the same kill-switch effect as 3 wrongs).
 *   3. logout() — clear auth_token + setAuth(false) so the AuthGate render
 *      decision converges. The PIN is per-user and untouched by logout, so the
 *      legitimate user re-logs in with the same PIN.
 *   4. setDuressMode(true) — flips AuthGate into a connection-error screen
 *      indistinguishable from a real network outage. The coercer watching the
 *      screen sees a brief "Verifying…" then a generic connection error.
 */
export async function runDuressSequence(): Promise<void> {
  try {
    await sendDuressSignal();
  } catch (err) {
    console.warn('[duress] sendDuressSignal failed', err);
  }
  await clearNativeCredentials();
  await logout();
  useAuth.getState().setDuressMode(true);
}
