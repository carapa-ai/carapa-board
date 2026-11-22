// In-memory vault for the four session secrets that drive every signed
// API request: `auth_token`, `device_id`, `device_pub_key`, `device_priv_key`.
//
// Two modes, picked transparently by `vaultIsConfigured()`:
//
//  * Unconfigured (no biometric set up yet): the vault is a thin proxy
//    over plain localStorage. Reads fall through to the same keys
//    `apiFetch` and `auth.ts` used historically. This keeps the existing
//    flow working when no extra protection is enabled.
//
//  * Configured (biometric set up): the four secrets live ONLY in module
//    memory while the user is unlocked. localStorage holds an AES-GCM
//    blob (`vault_v1`) wrapped with a key derived from the WebAuthn PRF
//    output. The plaintext localStorage keys are deleted so a stolen
//    laptop with closed browser exposes no recoverable session.
//
//  * PIN-protected (web PIN vault enrolled, no biometric): same memory-only
//    behaviour. The at-rest copy is the PIN vault blob in `pin-vault.ts`
//    (Argon2id-derived AES-GCM key), which now also carries the auth token.
//    The in-memory key handle from the last PIN entry is used to re-wrap it
//    whenever the secrets change; locking drops the handle.
//
// On lock engagement the visibility-change handler in `auth-gate.tsx`
// calls `vaultClearMemory()`. The wrapped blob stays in localStorage
// — the next unlock reads it, decrypts with a fresh PRF, and
// re-populates memory.

import {
  aesDecrypt,
  aesEncrypt,
  deriveWrapKey,
  type WebauthnBlob,
} from './webauthn';
import {
  hasPinVault,
  rewrapPinVault,
  type DeviceCreds,
  type PinKeyHandle,
} from './pin-vault';

const KEY_AUTH_TOKEN = 'auth_token';
const KEY_DEVICE_ID = 'device_id';
const KEY_DEVICE_PUB = 'device_pub_key';
const KEY_DEVICE_PRIV = 'device_priv_key';
const KEY_VAULT_BLOB = 'vault_v1';
const KEY_WEBAUTHN_META = 'webauthn_v1';
// Per-user device identity. Stored on disk so a user logging back in on the
// same browser reuses their previously-approved device row, without needing
// admin re-approval each session. Each user gets their own `device_id`; the
// server sees them as separate devices that happen to live in one browser.
const KEY_DEVICE_PER_USER_PREFIX = 'carapa_device_';

interface PerUserDeviceCreds {
  deviceId: string;
  pubKeyB64: string;
  privKeyB64: string;
}

function perUserKey(username: string): string {
  return KEY_DEVICE_PER_USER_PREFIX + username.trim().toLowerCase();
}

export function loadPerUserDeviceCreds(
  username: string,
): PerUserDeviceCreds | null {
  try {
    const raw = localStorage.getItem(perUserKey(username));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.deviceId === 'string' &&
      typeof parsed?.pubKeyB64 === 'string' &&
      typeof parsed?.privKeyB64 === 'string'
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

export function savePerUserDeviceCreds(
  username: string,
  creds: PerUserDeviceCreds,
): void {
  try {
    localStorage.setItem(perUserKey(username), JSON.stringify(creds));
  } catch {}
}

// Removes any per-user creds for the given username. Used at login on
// biometric-configured browsers to nuke leftover plaintext blobs from before
// the vaultIsConfigured() guard was in place — leaving them around would
// circumvent the wrapped vault.
export function clearPerUserDeviceCreds(username: string): void {
  try {
    localStorage.removeItem(perUserKey(username));
  } catch {}
}

interface WebauthnMeta {
  credentialId: string;
}

interface VaultPayload {
  authToken: string | null;
  deviceId: string | null;
  devicePubKeyB64: string | null;
  devicePrivKeyB64: string | null;
  // Account that owns the device keypair (normalized). Absent in blobs written
  // before ownership was tracked; those are never reused across logins.
  username?: string | null;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

let memAuthToken: string | null = null;
let memDeviceId: string | null = null;
let memDevicePub: string | null = null;
let memDevicePriv: string | null = null;
let memUsername: string | null = null;

// Web PIN-vault protection for the current session. `handle` is the derived
// wrap key; null while locked/booting (no PIN entered yet in this page life).
let pinSession: { username: string; handle: PinKeyHandle | null } | null = null;
let pinPersistChain: Promise<void> = Promise.resolve();

function readMeta(): WebauthnMeta | null {
  try {
    const raw = localStorage.getItem(KEY_WEBAUTHN_META);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.credentialId === 'string') {
      return parsed as WebauthnMeta;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readBlob(): WebauthnBlob | null {
  try {
    const raw = localStorage.getItem(KEY_VAULT_BLOB);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ciphertext === 'string'
    ) {
      return parsed as WebauthnBlob;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeBlob(blob: WebauthnBlob): void {
  localStorage.setItem(KEY_VAULT_BLOB, JSON.stringify(blob));
}

function clearLegacyKeys(): void {
  localStorage.removeItem(KEY_AUTH_TOKEN);
  localStorage.removeItem(KEY_DEVICE_ID);
  localStorage.removeItem(KEY_DEVICE_PUB);
  localStorage.removeItem(KEY_DEVICE_PRIV);
}

function snapshotPayload(): VaultPayload {
  return {
    authToken: memAuthToken,
    deviceId: memDeviceId,
    devicePubKeyB64: memDevicePub,
    devicePrivKeyB64: memDevicePriv,
    username: memUsername,
  };
}

function applyPayload(payload: VaultPayload): void {
  memAuthToken = payload.authToken;
  memDeviceId = payload.deviceId;
  memDevicePub = payload.devicePubKeyB64;
  memDevicePriv = payload.devicePrivKeyB64;
  memUsername = payload.username ?? null;
}

/**
 * Sync probe used by the boot-time lock decision. True iff WebAuthn
 * metadata + a wrapped blob are both persisted.
 */
export function vaultIsConfigured(): boolean {
  return readMeta() !== null && readBlob() !== null;
}

export function vaultGetCredentialId(): string | null {
  return readMeta()?.credentialId ?? null;
}

/**
 * True when a web PIN vault protects this session (and no biometric vault
 * takes precedence). Secrets then live in memory only.
 */
export function vaultIsPinProtected(): boolean {
  return (
    !vaultIsConfigured() &&
    pinSession !== null &&
    hasPinVault(pinSession.username)
  );
}

function memoryOnly(): boolean {
  return vaultIsConfigured() || vaultIsPinProtected();
}

/** Username whose PIN vault protects the session, or null. */
export function vaultPinUsername(): string | null {
  return vaultIsPinProtected() ? (pinSession?.username ?? null) : null;
}

/**
 * Select the PIN-vault session for `username` (or none). Any plaintext
 * session keys are removed. `handle` is the key from the PIN entry that
 * just happened, or null when still locked (boot).
 */
export function vaultSetPinSession(
  username: string | null,
  handle: PinKeyHandle | null = null,
): void {
  pinSession = username ? { username, handle } : null;
  if (pinSession) {
    try {
      clearLegacyKeys();
    } catch {
      /* ignore */
    }
  }
}

/** PIN-lock-screen unlock: repopulate memory from the unwrapped payload. */
export function vaultApplyPinUnlock(
  username: string,
  creds: DeviceCreds,
  authToken: string | null,
  handle: PinKeyHandle,
): void {
  vaultSetPinSession(username, handle);
  applyPayload({
    authToken,
    deviceId: creds.deviceId,
    devicePubKeyB64: creds.pubKeyB64,
    devicePrivKeyB64: creds.privKeyB64,
  });
}

/**
 * PIN enrolment on a logged-in session: the current token + `creds` move into
 * memory and every plaintext copy is removed. The caller already wrapped them
 * in the PIN vault (with `vaultGetAuthToken()` read beforehand).
 */
export function vaultEnablePin(
  username: string,
  creds: DeviceCreds,
  handle: PinKeyHandle,
): void {
  const token = vaultGetAuthToken();
  vaultSetPinSession(username, handle);
  applyPayload({
    authToken: token,
    deviceId: creds.deviceId,
    devicePubKeyB64: creds.pubKeyB64,
    devicePrivKeyB64: creds.privKeyB64,
  });
}

/**
 * "Disable PIN": intentionally move the session back to plaintext storage.
 * Caller deletes the PIN vault; the secrets come from the PIN-verified
 * `creds`/`authToken` so a locked memory state still works.
 */
export function vaultDisablePin(
  creds: DeviceCreds,
  authToken: string | null,
): void {
  const token = memAuthToken ?? authToken;
  pinSession = null;
  vaultPopulate({
    authToken: token,
    deviceId: creds.deviceId,
    devicePubKeyB64: creds.pubKeyB64,
    devicePrivKeyB64: creds.privKeyB64,
  });
}

function schedulePinPersist(): void {
  const session = pinSession;
  const handle = session?.handle;
  if (!session || !handle) return;
  // Never overwrite the wrapped keypair with a partial login-in-progress state.
  if (!memDeviceId || !memDevicePub || !memDevicePriv) return;
  const payload = {
    deviceId: memDeviceId,
    pubKeyB64: memDevicePub,
    privKeyB64: memDevicePriv,
    authToken: memAuthToken,
  };
  pinPersistChain = pinPersistChain
    .then(() => rewrapPinVault(session.username, handle, payload))
    .then(
      () => undefined,
      () => undefined,
    );
}

/** Resolves once every queued PIN-vault re-wrap has been written. */
export function vaultFlushPinPersist(): Promise<void> {
  return pinPersistChain;
}

/**
 * Canonical read for `auth_token`. When biometric or PIN protection is
 * active, returns memory only — null while locked. Otherwise falls through
 * to localStorage.
 */
export function vaultGetAuthToken(): string | null {
  if (memoryOnly()) return memAuthToken;
  return localStorage.getItem(KEY_AUTH_TOKEN);
}

/**
 * Canonical read for the request-signing keys. When biometric or PIN
 * protection is active, returns memory only — both fields null while locked.
 * Otherwise falls through to localStorage.
 */
export function vaultGetDeviceCreds(): {
  deviceId: string | null;
  privKeyB64: string | null;
} {
  if (memoryOnly()) {
    return { deviceId: memDeviceId, privKeyB64: memDevicePriv };
  }
  return {
    deviceId: localStorage.getItem(KEY_DEVICE_ID),
    privKeyB64: localStorage.getItem(KEY_DEVICE_PRIV),
  };
}

/**
 * Canonical read for the device public key (registered at login). Memory only
 * under biometric or PIN protection — null while locked; otherwise localStorage.
 */
export function vaultGetDevicePubKey(): string | null {
  if (memoryOnly()) return memDevicePub;
  return localStorage.getItem(KEY_DEVICE_PUB);
}

/**
 * True when the unlocked biometric vault's device keypair belongs to
 * `username`. A shared browser holds one vault; another account's login must
 * not take over its device.
 */
export function vaultOwnedBy(username: string | undefined): boolean {
  return !!username && memUsername === normalizeUsername(username);
}

interface PopulateArgs {
  authToken?: string | null;
  deviceId?: string | null;
  devicePubKeyB64?: string | null;
  devicePrivKeyB64?: string | null;
  // Memory only (and the wrapped blob): never written to plain localStorage.
  username?: string | null;
}

/**
 * Update the vault contents. When neither biometric nor a PIN vault protects
 * the session, the relevant fields are also written to plain localStorage so
 * the legacy read paths continue to work. When biometric IS configured, only
 * memory is touched; persistence requires a separate `vaultRewrap` after the
 * caller secures a fresh PRF output. With a PIN vault, memory is updated and
 * the PIN-wrapped blob is re-written through the in-memory key handle.
 *
 * `undefined` fields are left as-is; pass `null` to explicitly clear.
 */
export function vaultPopulate(args: PopulateArgs): void {
  const configured = memoryOnly();
  if (args.authToken !== undefined) {
    memAuthToken = args.authToken;
    if (!configured) {
      if (args.authToken == null) localStorage.removeItem(KEY_AUTH_TOKEN);
      else localStorage.setItem(KEY_AUTH_TOKEN, args.authToken);
    }
  }
  if (args.deviceId !== undefined) {
    memDeviceId = args.deviceId;
    if (!configured) {
      if (args.deviceId == null) localStorage.removeItem(KEY_DEVICE_ID);
      else localStorage.setItem(KEY_DEVICE_ID, args.deviceId);
    }
  }
  if (args.devicePubKeyB64 !== undefined) {
    memDevicePub = args.devicePubKeyB64;
    if (!configured) {
      if (args.devicePubKeyB64 == null) localStorage.removeItem(KEY_DEVICE_PUB);
      else localStorage.setItem(KEY_DEVICE_PUB, args.devicePubKeyB64);
    }
  }
  if (args.devicePrivKeyB64 !== undefined) {
    memDevicePriv = args.devicePrivKeyB64;
    if (!configured) {
      if (args.devicePrivKeyB64 == null)
        localStorage.removeItem(KEY_DEVICE_PRIV);
      else localStorage.setItem(KEY_DEVICE_PRIV, args.devicePrivKeyB64);
    }
  }
  if (args.username !== undefined) {
    memUsername = args.username ? normalizeUsername(args.username) : null;
  }
  if (configured && !vaultIsConfigured()) schedulePinPersist();
}

/**
 * Encrypt the current memory contents under the PRF-derived key and
 * persist as `vault_v1`. Stamps the four legacy localStorage keys to
 * remove any plaintext residue. Caller passes the PRF output from a
 * just-completed WebAuthn ceremony.
 */
export async function vaultWrapAndPersist(
  prfOutput: ArrayBuffer,
  credentialId: string,
): Promise<void> {
  // Memory is empty after a reload on an unconfigured browser (the secrets are
  // read from plain localStorage there): carry them into the blob.
  if (!memoryOnly()) {
    memAuthToken ??= localStorage.getItem(KEY_AUTH_TOKEN);
    memDeviceId ??= localStorage.getItem(KEY_DEVICE_ID);
    memDevicePub ??= localStorage.getItem(KEY_DEVICE_PUB);
    memDevicePriv ??= localStorage.getItem(KEY_DEVICE_PRIV);
  }
  const key = await deriveWrapKey(prfOutput);
  const payload = snapshotPayload();
  const blob = await aesEncrypt(key, JSON.stringify(payload));
  writeBlob(blob);
  localStorage.setItem(KEY_WEBAUTHN_META, JSON.stringify({ credentialId }));
  clearLegacyKeys();
}

/**
 * Re-encrypt the current memory contents (e.g. after a fresh login while
 * biometric is configured). Reads the credentialId from existing meta
 * and reuses the PRF output the caller secured.
 */
export async function vaultRewrap(prfOutput: ArrayBuffer): Promise<void> {
  if (!vaultIsConfigured()) return;
  const key = await deriveWrapKey(prfOutput);
  const payload = snapshotPayload();
  const blob = await aesEncrypt(key, JSON.stringify(payload));
  writeBlob(blob);
}

/**
 * Upgrade for a blob written before owners were tracked: after an unlock, name
 * the signed-in account as the owner of the unwrapped device and re-wrap. A
 * blob that already has an owner is left alone.
 */
export async function vaultAdoptOwner(
  prfOutput: ArrayBuffer,
  username: string,
): Promise<void> {
  if (!vaultIsConfigured() || memUsername || !memDeviceId) return;
  memUsername = normalizeUsername(username);
  await vaultRewrap(prfOutput);
}

/**
 * Decrypt `vault_v1` with a freshly-asserted PRF output and populate
 * memory. Throws on missing blob, decryption failure, or bad payload.
 */
export async function vaultUnwrapFromStorage(
  prfOutput: ArrayBuffer,
): Promise<void> {
  const blob = readBlob();
  if (!blob) throw new Error('No vault blob to unwrap');
  const key = await deriveWrapKey(prfOutput);
  const json = await aesDecrypt(key, blob);
  const payload = JSON.parse(json) as VaultPayload;
  applyPayload({
    authToken: payload.authToken ?? null,
    deviceId: payload.deviceId ?? null,
    devicePubKeyB64: payload.devicePubKeyB64 ?? null,
    devicePrivKeyB64: payload.devicePrivKeyB64 ?? null,
    username: payload.username ?? null,
  });
}

/** Used by lock engagement — keeps the wrapped blob, drops in-memory plaintext. */
export function vaultClearMemory(): void {
  if (pinSession) pinSession.handle = null;
  memAuthToken = null;
  memDeviceId = null;
  memDevicePub = null;
  memDevicePriv = null;
  memUsername = null;
}

/** Logout / kill-switch / "remove biometric and sign out" — wipe everything. */
export function vaultClearAll(): void {
  vaultClearMemory();
  pinSession = null;
  try {
    localStorage.removeItem(KEY_VAULT_BLOB);
    localStorage.removeItem(KEY_WEBAUTHN_META);
    clearLegacyKeys();
  } catch {
    /* ignore */
  }
}

/**
 * "Remove biometric unlock" — decrypt the vault, write the secrets back
 * to plain localStorage, then drop the wrapped blob + WebAuthn meta. The
 * user remains logged in; they just no longer need biometric to unlock.
 * Caller has already secured `prfOutput` via a confirming assertion.
 */
export async function vaultRemoveBiometric(
  prfOutput: ArrayBuffer,
): Promise<void> {
  if (!vaultIsConfigured()) return;
  // First, make sure we have a usable plaintext snapshot. If memory is
  // currently locked, unwrap from storage; otherwise the in-memory copy
  // is already authoritative.
  if (memAuthToken === null && memDeviceId === null) {
    await vaultUnwrapFromStorage(prfOutput);
  }
  vaultDiscardWrapped();
}

/**
 * Drop the wrapped blob + WebAuthn meta (no PRF needed) and move the current
 * in-memory secrets to plain localStorage. Used when the session holds device
 * credentials that differ from the ones in the blob, so the vault can never
 * unlock to a stale device identity.
 */
export function vaultDiscardWrapped(): void {
  if (!vaultIsConfigured()) return;
  const payload = snapshotPayload();
  // Drop the wrapped blob + meta first so subsequent setItem() calls
  // hit the legacy-key path inside `vaultPopulate`.
  localStorage.removeItem(KEY_VAULT_BLOB);
  localStorage.removeItem(KEY_WEBAUTHN_META);
  vaultPopulate({
    authToken: payload.authToken,
    deviceId: payload.deviceId,
    devicePubKeyB64: payload.devicePubKeyB64,
    devicePrivKeyB64: payload.devicePrivKeyB64,
    username: payload.username,
  });
}
