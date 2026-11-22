import { logger } from './logger.js';

/**
 * Server-side cryptographic signature verification.
 * Uses Bun's built-in WebCrypto implementation.
 */
const KEY_ALGO = {
  name: 'ECDSA',
  namedCurve: 'P-256',
};

const SIGN_ALGO = {
  name: 'ECDSA',
  hash: { name: 'SHA-256' },
};

/** Import a public key from base64. */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const binary = Buffer.from(base64, 'base64');
  return await crypto.subtle.importKey('spki', binary, KEY_ALGO, false, [
    'verify',
  ]);
}

/** Verify a signature against a payload. */
export async function verifySignature(
  publicKeyBase64: string,
  signatureBase64: string,
  payload: string,
): Promise<boolean> {
  try {
    const public_key = await importPublicKey(publicKeyBase64);
    const signature = Buffer.from(signatureBase64, 'base64');
    const encoder = new TextEncoder();
    const data = encoder.encode(payload);

    return await crypto.subtle.verify(SIGN_ALGO, public_key, signature, data);
  } catch (err) {
    logger.warn({ err }, 'Signature verification failed');
    return false;
  }
}

/** Reconstruct the signing payload from request details. */
export function createSigningPayload(
  method: string,
  url: string,
  timestamp: string,
  body: string,
): string {
  // Normalize URL to path only
  // Normalize URL to path only
  let path = url;
  try {
    if (url.startsWith('http')) {
      const urlObj = new URL(url);
      path = urlObj.pathname + urlObj.search;
    } else {
      // In Express/Bun, req.url/originalUrl is usually just the path,
      // but might include the host in some proxy setups.
      // If it doesn't start with http, but starts with /, it's already a path.
      // We strip query params if we want absolute path matching, but search is better.
      const urlObj = new URL(url, 'http://localhost');
      path = urlObj.pathname + urlObj.search;
    }
  } catch (e) {
    path = url.split('?')[0]; // Simple fallback
  }
  return `${timestamp}:${method}:${path}:${body || ''}`;
}

/** Validate that an ISO timestamp is recent enough for high-impact re-auth checks. */
export function isFreshTimestamp(
  timestamp: string,
  maxAgeMs = 30_000,
  nowMs = Date.now(),
): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs - ts) <= maxAgeMs;
}
