import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

let cachedSecret: string | null = null;

/**
 * Resolve the HS256 secret lazily. CARAPA_BOARD_ENCRYPTION_KEY wins (used as the
 * raw string). Otherwise a random secret is persisted in DATA_DIR/.jwt-secret.
 */
function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const envKey = process.env.CARAPA_BOARD_ENCRYPTION_KEY;
  if (envKey) {
    cachedSecret = envKey;
    return cachedSecret;
  }
  const secretPath = path.join(DATA_DIR, '.jwt-secret');
  const readSecret = (): string | null => {
    try {
      return fs.readFileSync(secretPath, 'utf8').trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  let secret = readSecret();
  if (!secret) {
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      fs.writeFileSync(secretPath, generated, { mode: 0o600, flag: 'wx' });
      secret = generated;
      logger.info({ generated: true }, 'Generated new JWT signing secret');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      secret = readSecret();
      if (!secret) throw err;
    }
  }
  cachedSecret = secret;
  return cachedSecret;
}

function base64url(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlToBuffer(base64url: string): Buffer {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

export function signJwt(
  payload: any,
  expiresInSeconds: number = 24 * 3600,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;

  const fullPayload = { ...payload, iat, exp };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));

  const hmac = crypto.createHmac('sha256', getJwtSecret());
  hmac.update(`${encodedHeader}.${encodedPayload}`);
  const signature = hmac.digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyJwt(token: string): any | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const hmac = crypto.createHmac('sha256', getJwtSecret());
    hmac.update(`${encodedHeader}.${encodedPayload}`);
    const expectedSignature = hmac.digest('base64url');

    const actual = Buffer.from(signature);
    const expected = Buffer.from(expectedSignature);
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      logger.warn('JWT signature verification failed');
      return null;
    }

    const payloadStr = base64urlToBuffer(encodedPayload).toString('utf8');
    const payload = JSON.parse(payloadStr);

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      logger.debug(
        { type: payload.type, sub: payload.sub, exp: payload.exp },
        'JWT has expired',
      );
      return null;
    }

    return payload;
  } catch (err) {
    logger.error({ err }, 'Error verifying JWT');
    return null;
  }
}

/** `tokenVersion` is the user's current `users.token_version` (see
 *  `isStaleUserSession`); callers that hold the user row must pass it. */
export function signUserJwt(
  user_id: string,
  device_id?: string,
  tokenVersion = 0,
): string {
  const payload: Record<string, unknown> = {
    type: 'user',
    sub: user_id,
    tv: tokenVersion,
  };
  if (device_id) payload.did = device_id;
  return signJwt(payload);
}

/** Token version a user JWT was issued under; tokens from before the claim
 *  existed count as version 0. */
function jwtTokenVersion(payload: { tv?: unknown }): number {
  return typeof payload.tv === 'number' ? payload.tv : 0;
}

/** True when `user` changed their password after this JWT was issued. A user
 *  that no longer exists is not stale here; callers already grant it nothing. */
export function isStaleUserSession(
  payload: { tv?: unknown },
  user: { tokenVersion?: number } | undefined,
): boolean {
  return !!user && jwtTokenVersion(payload) !== (user.tokenVersion ?? 0);
}

export const SESSION_COOKIE = 'carapa_session';

/** Build the `carapa_session` Set-Cookie string. The cookie envelope Max-Age
 *  persists for a year; the signed JWT inside governs the real session expiry. */
export function buildSessionCookie(
  value: string,
  req: { headers: Record<string, unknown> },
  maxAgeSeconds: number,
): string {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
