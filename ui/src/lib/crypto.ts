/**
 * Cryptographic helpers for device-based request signing.
 * Uses WebCrypto API for secure key generation and signing.
 */

import { base64ToBytes, bytesToBase64 } from './base64';

const KEY_ALGO = {
  name: 'ECDSA',
  namedCurve: 'P-256',
};

const SIGN_ALGO = {
  name: 'ECDSA',
  hash: { name: 'SHA-256' },
};

/** Generate a new device key pair. */
export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(KEY_ALGO, true, ['sign', 'verify']);
}

/** Export a public key to base64 for server registration. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', key);
  return bytesToBase64(new Uint8Array(exported));
}

/** Sign a payload with the device private key. */
export async function signPayload(
  privateKey: CryptoKey,
  payload: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const signature = await crypto.subtle.sign(SIGN_ALGO, privateKey, data);
  return bytesToBase64(new Uint8Array(signature));
}

/** Create a standard payload for request signing. */
export function createSigningPayload(
  method: string,
  url: string,
  timestamp: string,
  body?: string,
): string {
  // Normalize URL to path only to ignore API_BASE_URL differences
  let path = url;
  try {
    // If it's a full URL, extract only the path
    if (url.startsWith('http')) {
      const urlObj = new URL(url);
      path = urlObj.pathname + urlObj.search;
    }
  } catch (e) {
    // Fallback if URL parsing fails
    path = url.split('://')[1]
      ? '/' + url.split('://')[1].split('/').slice(1).join('/')
      : url;
  }
  return `${timestamp}:${method}:${path}:${body || ''}`;
}

/** Helper to convert CryptoKey to/from base64 for storage if needed. */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('pkcs8', key);
  return bytesToBase64(new Uint8Array(exported));
}

export async function importPrivateKey(base64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64);
  return await crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer as ArrayBuffer,
    KEY_ALGO,
    false,
    ['sign'],
  );
}
