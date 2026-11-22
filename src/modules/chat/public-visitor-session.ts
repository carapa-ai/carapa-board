import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { DATA_DIR } from '../../config.js';

const COOKIE_NAME = 'carapa_public_visitor';
const MAX_AGE_SECONDS = 24 * 60 * 60;
let signingKey: Buffer | null = null;

function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  const keyPath = path.join(DATA_DIR, 'public-visitor-signing.key');
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length >= 32) return (signingKey = existing);
  } catch {
    // Generated below.
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated, { mode: 0o600, flag: 'wx' });
  return (signingKey = generated);
}

function sign(value: string): string {
  return crypto
    .createHmac('sha256', getSigningKey())
    .update(value)
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cookies(req: Request): Record<string, string> {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name, value]) => Boolean(name && value))
      .map(([name, ...value]) => [name, safeDecode(value.join('='))]),
  );
}

export interface PublicVisitorSession {
  id: string;
  pseudonym: string;
}

function decodeSession(req: Request): PublicVisitorSession | null {
  const raw = cookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature || !safeEqual(sign(encoded), signature))
    return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as {
      id?: unknown;
      exp?: unknown;
    };
    if (
      typeof payload.id !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(payload.id) ||
      typeof payload.exp !== 'number' ||
      payload.exp < Date.now()
    )
      return null;
    return {
      id: payload.id,
      pseudonym: `Visitor ${sign(`name:${payload.id}`).slice(0, 4).toUpperCase()}`,
    };
  } catch {
    return null;
  }
}

export function ensurePublicVisitorSession(
  req: Request,
  res: Response,
): PublicVisitorSession {
  const existing = decodeSession(req);
  if (existing) return existing;
  const id = crypto.randomBytes(18).toString('base64url');
  const encoded = Buffer.from(
    JSON.stringify({ id, exp: Date.now() + MAX_AGE_SECONDS * 1000 }),
  ).toString('base64url');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(`${encoded}.${sign(encoded)}`)}; Path=/api/public; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
  );
  return {
    id,
    pseudonym: `Visitor ${sign(`name:${id}`).slice(0, 4).toUpperCase()}`,
  };
}

export function publicVisitorCsrf(
  session: PublicVisitorSession,
  token: string,
): string {
  return sign(`csrf:${session.id}:${token}`);
}

export function validatePublicVisitorRequest(
  req: Request,
  token: string,
): PublicVisitorSession | null {
  const session = decodeSession(req);
  if (!session) return null;
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  const origin = req.get('origin');
  if (!origin || origin !== expectedOrigin) return null;
  const csrf = req.get('x-public-csrf') || '';
  if (!safeEqual(publicVisitorCsrf(session, token), csrf)) return null;
  return session;
}

export function publicVisitorHash(
  _session: PublicVisitorSession,
  ip: string | undefined,
): string {
  const day = new Date().toISOString().slice(0, 10);
  // The conversation id scopes the DB query, so this is effectively a
  // rotating per-link + IP quota key. Clearing the visitor cookie must not
  // reset the anonymous rate limit.
  return sign(`visitor:${day}:${ip || 'unknown'}`);
}

/**
 * Prompt request ids are bound to the visitor session (not the IP/day quota
 * key) so status reads survive UTC midnight and IP changes.
 */
export function newPublicPromptRequestId(
  session: PublicVisitorSession,
): string {
  const nonce = crypto.randomUUID();
  return `${nonce}.${sign(`prompt:${session.id}:${nonce}`).slice(0, 22)}`;
}

export function ownsPublicPromptRequest(
  session: PublicVisitorSession,
  requestId: string,
): boolean {
  const [nonce, mac, ...rest] = requestId.split('.');
  if (!nonce || !mac || rest.length > 0) return false;
  return safeEqual(sign(`prompt:${session.id}:${nonce}`).slice(0, 22), mac);
}
