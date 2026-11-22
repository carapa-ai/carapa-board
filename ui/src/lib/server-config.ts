import {
  activeAndroidOtaBundleId,
  androidOtaApplyInFlight,
  androidOtaRestartPending,
  readPairedOtaRecordRaw,
  resetAndroidOtaForServerChange,
  runExclusiveAndroidOtaActivation,
  writePairedOtaRecordRaw,
} from '@/lib/android-ota';
import { NativeBridge } from '@/lib/native-bridge';
import { clearNativeCredentials, syncServerPins } from '@/lib/push-bridge';
import { vaultClearAll } from '@/lib/session-vault';
import { disconnectWebSocket } from '@/lib/websocket';
import {
  type ServerConfig,
  clearSessionCookies,
  drainNativeRequests,
  getServerConfig,
  invalidateServerConfigEpoch,
  resolveServerUrls,
  serverTrustChanged,
  setServerConfig,
} from '@/lib/api-config';

/**
 * The new config is saved but the built-in bundle could not be selected. The
 * previous server's bundle may still be running, so the caller must reload the
 * app: startup recovery then retries behind a blocking screen.
 */
export class ServerChangeIncompleteError extends Error {
  constructor(cause: unknown) {
    super('The server change could not be finished', { cause });
    this.name = 'ServerChangeIncompleteError';
  }
}

/**
 * Save new server addresses (null = app defaults). When a Home or Remote
 * origin, a certificate pin or the OTA key changes, everything that would be sent to the old server is wiped
 * first: session vault, session cookies, saved-login shortcut and the native
 * device key; the socket is dropped so a late token refresh cannot refill them.
 * Native certificate pins are updated just before the new config is used.
 * Returns true when credentials were wiped. Rejects, keeping the previous
 * config, when the native credential wipe or the pin update fails. Rejects
 * with `ServerChangeIncompleteError`, keeping the new config and the marker,
 * when the return to the built-in Android bundle fails.
 */
export function applyServerConfig(next: ServerConfig | null): Promise<boolean> {
  // An apply that is waiting or running may still fail or restart the WebView:
  // refuse instead of queueing behind it.
  if (androidOtaApplyInFlight()) {
    return Promise.reject(
      new Error('An app update is being applied; try again'),
    );
  }
  // Serialized with Android OTA activation: a change must not look at the
  // active bundle while an update is being switched in.
  return runExclusiveAndroidOtaActivation(() => applyServerConfigNow(next));
}

async function applyServerConfigNow(
  next: ServerConfig | null,
): Promise<boolean> {
  if (androidOtaRestartPending()) {
    // The updater is already restarting into another bundle, whose code may
    // not know about this change; nothing has been touched yet.
    throw new Error('The app is restarting for an update; try again');
  }
  const before = resolveServerUrls(getServerConfig());
  const after = resolveServerUrls(next ?? {});
  const changed =
    before.homeUrl !== after.homeUrl ||
    before.remoteUrl !== after.remoteUrl ||
    serverTrustChanged(getServerConfig(), next ?? {});
  if (changed) {
    invalidateServerConfigEpoch();
    disconnectWebSocket();
    await clearNativeCredentials({ strict: true });
    await NativeBridge.deleteSecureCredentials();
    vaultClearAll();
    // Cookies are not port-scoped: the old session JWT would reach the new
    // origin. Let requests to the old server finish (their Set-Cookie would
    // refill the jar), then clear it locally so it works with that server
    // offline. A response arriving after the drain times out clears again.
    await drainNativeRequests();
    await clearSessionCookies();
  }
  const previous = getServerConfig();
  const previousRecord = readPairedOtaRecordRaw();
  // Leaving the bundle reloads the WebView and ends this context, and the
  // process can end between saving the config and forgetting the per-server
  // record, so a marker is persisted first. The change is then rolled forward
  // at the next start: the reset is safe under any saved config.
  if (changed) writeServerChangeMarker();
  let saved = false;
  try {
    await syncServerPins(next ?? {});
    setServerConfig(next);
    saved = true;
    // Never keep one server's UI code running against another server. The
    // config is saved first because the reset reloads the WebView. If the
    // built-in bundle cannot be selected, the old bundle may run under the new
    // config: keep config and marker so the caller's reload ends in the
    // blocking startup recovery.
    if (changed && !(await resetAndroidOtaForServerChange())) {
      clearServerChangeMarker();
    }
  } catch (error) {
    if (saved) throw new ServerChangeIncompleteError(error);
    setServerConfig(previous);
    writePairedOtaRecordRaw(previousRecord);
    await syncServerPins(previous).catch((e) =>
      console.warn('[server-config] Restoring the server pins failed:', e),
    );
    clearServerChangeMarker();
    throw error;
  }
  return changed;
}

const SERVER_CHANGE_MARKER_KEY = 'carapa-server-change-pending';

function writeServerChangeMarker(): void {
  localStorage.setItem(SERVER_CHANGE_MARKER_KEY, '1');
}

function clearServerChangeMarker(): void {
  try {
    localStorage.removeItem(SERVER_CHANGE_MARKER_KEY);
  } catch (e) {
    console.warn(
      '[server-config] Failed to clear the server change marker:',
      e,
    );
  }
}

function serverChangeMarked(): boolean {
  try {
    return localStorage.getItem(SERVER_CHANGE_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Run at startup, before the configured server is used. If a server change
 * was interrupted (the process ended first, or the updater restored the
 * previous bundle), finish it: the saved config stays, the per-server record
 * is forgotten and the built-in bundle is selected again if another one is
 * active. A failure keeps the marker and rejects; the caller must not use the
 * saved config until a later start succeeds.
 */
export async function reconcileInterruptedServerChange(): Promise<void> {
  if (!serverChangeMarked()) return;
  await runExclusiveAndroidOtaActivation(async () => {
    if (!(await resetAndroidOtaForServerChange())) clearServerChangeMarker();
  });
}

/**
 * Call after `notifyAppReady` succeeded: once the built-in bundle is the
 * active one the change is final and the marker can go. A built-in bundle that
 * predates this code never gets here; the next bundle that does clears it.
 */
export async function completeServerChange(): Promise<void> {
  if (!serverChangeMarked()) return;
  if ((await activeAndroidOtaBundleId()) === null) clearServerChangeMarker();
}
