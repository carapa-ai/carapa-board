// Optional PIN-wrapped vault for the device keypair, scoped per-user.
//
// Used on desktop browsers that have no biometric / WebAuthn-PRF available
// (the codebase's existing `session-vault.ts` flow). Without this, the
// device's private key sits in plain localStorage and can be exfiltrated by
// anyone with access to the browser profile.
//
// Design summary:
//   - The user picks a PIN. We derive a 256-bit AES-GCM key with Argon2id
//     (memory-hard, GPU-resistant) from `pin + per-user salt`.
//   - The key wraps `{ deviceId, pubKeyB64, privKeyB64, authToken? }`. We
//     persist the wrapped blob + parameters in
//     `localStorage[pin_vault_<username>]`. `authToken` lets a reload resume
//     the session after the PIN is entered; older blobs without it still
//     unlock (the token is then simply absent).
//   - While a PIN vault exists, `session-vault.ts` keeps the live secrets in
//     memory only and re-wraps this blob (via the in-memory key handle) when
//     they change. No plaintext copy exists on disk.
//   - The plaintext per-user blob (`carapa_device_<username>`) is removed
//     at enrolment, and re-written only if the user later disables the PIN.
//   - 5 wrong-PIN attempts in a 30-minute window wipe the vault. The user
//     then has to log in fresh and an admin re-approves the new device row.
//
// One PIN per (browser, user). Two accounts sharing a browser each manage
// their own PIN independently; neither can read the other's vault.

import { argon2id } from 'hash-wasm';
import { aesEncrypt, aesDecrypt } from './webauthn';
import { base64ToBytes, bytesToBase64 } from './base64';

const KEY_PREFIX = 'pin_vault_';
const ATTEMPTS_PREFIX = 'pin_vault_attempts_';

const ARGON2_MEM_KB = 65536; // 64 MB
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

const WEB_PIN_MIN_LENGTH = 8;
const WEB_PIN_MAX_LENGTH = 64;

const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Policy for newly enrolled web vault PINs. Used at enrolment only: unlock must
 * never apply it, so older, shorter-PIN vaults keep working.
 */
export function validateWebVaultPin(pin: string): string | null {
  if (pin.length < WEB_PIN_MIN_LENGTH || pin.length > WEB_PIN_MAX_LENGTH) {
    return `PIN must be ${WEB_PIN_MIN_LENGTH}-${WEB_PIN_MAX_LENGTH} characters, with letters and digits.`;
  }
  if (!/\p{L}/u.test(pin) || !/\d/.test(pin)) {
    return 'PIN must contain at least one letter and one digit.';
  }
  return null;
}

export interface DeviceCreds {
  deviceId: string;
  pubKeyB64: string;
  privKeyB64: string;
}

/** Wrapped payload: the device keypair plus the optional session token. */
export interface PinVaultPayload extends DeviceCreds {
  authToken?: string | null;
}

/**
 * Derived AES key plus the salt it belongs to. Held in memory by the session
 * vault so it can re-wrap the blob without asking for the PIN again; the salt
 * lets a re-wrap detect that the blob was replaced underneath it.
 */
export interface PinKeyHandle {
  key: CryptoKey;
  salt: string;
}

interface PinVaultBlob {
  // Algorithm + parameters embedded so we can change them later without
  // breaking older vaults. (For now there's only one set.)
  kdf: 'argon2id';
  m: number;
  t: number;
  p: number;
  salt: string; // base64
  // AES-GCM-wrapped JSON of DeviceCreds.
  iv: string;
  ciphertext: string;
  // True when the PIN met `validateWebVaultPin` at enrolment. Absent on older
  // blobs, which count as weak. The PIN and its length are never stored.
  strong?: boolean;
}

interface AttemptRecord {
  failedCount: number;
  windowStartMs: number;
}

function vaultKey(username: string): string {
  return KEY_PREFIX + username.trim().toLowerCase();
}

function attemptsKey(username: string): string {
  return ATTEMPTS_PREFIX + username.trim().toLowerCase();
}

async function deriveKey(pin: string, saltB64: string): Promise<CryptoKey> {
  const raw = await argon2id({
    password: pin,
    salt: base64ToBytes(saltB64),
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEM_KB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export function hasPinVault(username: string | null | undefined): boolean {
  if (!username) return false;
  try {
    return !!localStorage.getItem(vaultKey(username));
  } catch {
    return false;
  }
}

export interface EnrollResult {
  ok: boolean;
  error?: string;
  handle?: PinKeyHandle;
}

export async function enrollPinVault(
  username: string,
  pin: string,
  creds: DeviceCreds,
  authToken: string | null = null,
): Promise<EnrollResult> {
  if (!username) return { ok: false, error: 'username required' };
  if (!pin || pin.length < 4)
    return { ok: false, error: 'PIN must be at least 4 characters' };

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltB64 = bytesToBase64(salt);
  let key: CryptoKey;
  try {
    key = await deriveKey(pin, saltB64);
  } catch (err) {
    return {
      ok: false,
      error: 'Failed to derive key: ' + (err as Error).message,
    };
  }
  const payload: PinVaultPayload = { ...creds, authToken };
  const wrapped = await aesEncrypt(key, JSON.stringify(payload));

  const blob: PinVaultBlob = {
    kdf: 'argon2id',
    m: ARGON2_MEM_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
    salt: saltB64,
    iv: wrapped.iv,
    ciphertext: wrapped.ciphertext,
    strong: validateWebVaultPin(pin) === null,
  };
  try {
    localStorage.setItem(vaultKey(username), JSON.stringify(blob));
    localStorage.removeItem(attemptsKey(username));
  } catch (err) {
    return {
      ok: false,
      error: 'Failed to write vault: ' + (err as Error).message,
    };
  }
  return { ok: true, handle: { key, salt: saltB64 } };
}

/**
 * Replace the wrapped payload using an already-derived key (no PIN prompt).
 * No-ops when the vault was deleted or re-enrolled since `handle` was derived,
 * so a late write can never resurrect or corrupt a vault.
 */
export async function rewrapPinVault(
  username: string,
  handle: PinKeyHandle,
  payload: PinVaultPayload,
): Promise<boolean> {
  const wrapped = await aesEncrypt(handle.key, JSON.stringify(payload));
  try {
    const raw = localStorage.getItem(vaultKey(username));
    if (!raw) return false;
    const blob = JSON.parse(raw) as PinVaultBlob;
    if (blob.salt !== handle.salt) return false;
    localStorage.setItem(
      vaultKey(username),
      JSON.stringify({
        ...blob,
        iv: wrapped.iv,
        ciphertext: wrapped.ciphertext,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export type UnlockResult =
  | {
      ok: true;
      creds: DeviceCreds;
      authToken: string | null;
      handle: PinKeyHandle;
    }
  | { ok: false; reason: 'wrong_pin'; attemptsLeft: number }
  | { ok: false; reason: 'kill_switch' }
  | { ok: false; reason: 'no_vault' }
  | { ok: false; reason: 'error'; message: string };

function readAttempts(username: string): AttemptRecord {
  try {
    const raw = localStorage.getItem(attemptsKey(username));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.failedCount === 'number' &&
        typeof parsed.windowStartMs === 'number'
      ) {
        return parsed;
      }
    }
  } catch {}
  return { failedCount: 0, windowStartMs: Date.now() };
}

function writeAttempts(username: string, record: AttemptRecord): void {
  try {
    localStorage.setItem(attemptsKey(username), JSON.stringify(record));
  } catch {}
}

function clearAttempts(username: string): void {
  try {
    localStorage.removeItem(attemptsKey(username));
  } catch {}
}

export async function unlockPinVault(
  username: string,
  pin: string,
): Promise<UnlockResult> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(vaultKey(username));
  } catch {
    return { ok: false, reason: 'error', message: 'localStorage unavailable' };
  }
  if (!raw) return { ok: false, reason: 'no_vault' };

  let blob: PinVaultBlob;
  try {
    blob = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'error', message: 'Vault blob is corrupt' };
  }

  let key: CryptoKey;
  try {
    key = await deriveKey(pin, blob.salt);
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: 'Failed to derive key: ' + (err as Error).message,
    };
  }

  let plaintext: string;
  try {
    plaintext = await aesDecrypt(key, {
      iv: blob.iv,
      ciphertext: blob.ciphertext,
    });
  } catch {
    // AES-GCM auth tag failure ⇒ wrong PIN. Track + maybe kill-switch.
    const now = Date.now();
    const prev = readAttempts(username);
    const inWindow = now - prev.windowStartMs < ATTEMPT_WINDOW_MS;
    const nextRecord: AttemptRecord = inWindow
      ? { failedCount: prev.failedCount + 1, windowStartMs: prev.windowStartMs }
      : { failedCount: 1, windowStartMs: now };
    if (nextRecord.failedCount >= ATTEMPT_LIMIT) {
      try {
        localStorage.removeItem(vaultKey(username));
        localStorage.removeItem(attemptsKey(username));
      } catch {}
      return { ok: false, reason: 'kill_switch' };
    }
    writeAttempts(username, nextRecord);
    return {
      ok: false,
      reason: 'wrong_pin',
      attemptsLeft: ATTEMPT_LIMIT - nextRecord.failedCount,
    };
  }

  let creds: DeviceCreds;
  let authToken: string | null = null;
  try {
    const parsed = JSON.parse(plaintext) as PinVaultPayload;
    if (
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.pubKeyB64 !== 'string' ||
      typeof parsed.privKeyB64 !== 'string'
    ) {
      throw new Error('Unexpected payload shape');
    }
    creds = {
      deviceId: parsed.deviceId,
      pubKeyB64: parsed.pubKeyB64,
      privKeyB64: parsed.privKeyB64,
    };
    if (typeof parsed.authToken === 'string' && parsed.authToken) {
      authToken = parsed.authToken;
    }
  } catch {
    return {
      ok: false,
      reason: 'error',
      message: 'Vault contents are corrupt',
    };
  }
  clearAttempts(username);
  return { ok: true, creds, authToken, handle: { key, salt: blob.salt } };
}

export function deletePinVault(username: string): void {
  if (!username) return;
  try {
    localStorage.removeItem(vaultKey(username));
    localStorage.removeItem(attemptsKey(username));
  } catch {}
}

export interface PinVaultStatus {
  exists: boolean;
  attemptsLeft: number;
  /** True when the vault predates the PIN policy or was enrolled with a weak PIN. */
  weak: boolean;
}

function isWeakVault(username: string): boolean {
  try {
    const raw = localStorage.getItem(vaultKey(username));
    return !raw || (JSON.parse(raw) as PinVaultBlob).strong !== true;
  } catch {
    return true;
  }
}

export function pinVaultStatus(
  username: string | null | undefined,
): PinVaultStatus {
  const none = { exists: false, attemptsLeft: ATTEMPT_LIMIT, weak: false };
  if (!username) return none;
  const exists = hasPinVault(username);
  if (!exists) return none;
  const rec = readAttempts(username);
  const now = Date.now();
  const inWindow = now - rec.windowStartMs < ATTEMPT_WINDOW_MS;
  const used = inWindow ? rec.failedCount : 0;
  return {
    exists: true,
    attemptsLeft: Math.max(0, ATTEMPT_LIMIT - used),
    weak: isWeakVault(username),
  };
}
