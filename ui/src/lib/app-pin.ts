// Thin Android-only facade for the app PIN. Web/iOS used to share this
// surface with a PBKDF2-localStorage backend; that's been replaced by
// `session-vault.ts` + WebAuthn-PRF. Non-Android callers now go through
// the vault directly, so this facade short-circuits to "no PIN" outside
// of Android.
//
// PINs are USER-bound, not device-bound: every operation requires the
// userId of the account the PIN belongs to. Two users sharing a device
// keep separate PINs (separate verifiers, separate Keystore HMAC
// aliases). Logout preserves the PIN — same user logs back in, same PIN
// works; a different user's login never has to clear or bypass the
// previous user's PIN.

import { Capacitor } from '@capacitor/core';
import {
  nativeClearAppPin,
  nativeHasAppPin,
  nativeResetAppPinAttempts,
  nativeSetAppPin,
  nativeVerifyAppPin,
  type AppPinVerifyResult,
} from './push-bridge';

export type { AppPinVerifyResult };

function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function hasAppPin(
  userId: string | null | undefined,
): Promise<boolean> {
  if (!isAndroid() || !userId) return false;
  return nativeHasAppPin(userId);
}

export async function setAppPin(
  userId: string | null | undefined,
  pin: string,
): Promise<{ ok: true } | { ok: false; message?: string }> {
  if (!isAndroid())
    return { ok: false, message: 'App PIN is only supported on Android' };
  if (!userId) return { ok: false, message: 'userId is required' };
  return nativeSetAppPin(userId, pin);
}

export async function verifyAppPin(
  userId: string | null | undefined,
  pin: string,
): Promise<AppPinVerifyResult> {
  if (!isAndroid()) return { ok: false, reason: 'no_pin' };
  if (!userId)
    return { ok: false, reason: 'error', message: 'userId is required' };
  return nativeVerifyAppPin(userId, pin);
}

export async function clearAppPin(
  userId: string | null | undefined,
): Promise<void> {
  if (!isAndroid() || !userId) return;
  return nativeClearAppPin(userId);
}

export async function resetAppPinAttempts(
  userId: string | null | undefined,
): Promise<void> {
  if (!isAndroid() || !userId) return;
  return nativeResetAppPinAttempts(userId);
}
