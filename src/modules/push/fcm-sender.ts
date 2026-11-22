import fs from 'fs';
import { createSign } from 'crypto';
import { logger } from '../../logger.js';
import {
  FCM_PROJECT_ID,
  FCM_SERVICE_ACCOUNT_PATH,
  PUSH_ENABLED,
} from '../../config.js';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface AccessToken {
  token: string;
  expires_at: number;
}

let cachedSA: ServiceAccount | null = null;
let cachedAccess: AccessToken | null = null;

function loadServiceAccount(): ServiceAccount {
  if (cachedSA) return cachedSA;
  const raw = fs.readFileSync(FCM_SERVICE_ACCOUNT_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('FCM service account missing client_email or private_key');
  }
  cachedSA = parsed as ServiceAccount;
  return cachedSA;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function signJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(sa.private_key);
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccess && cachedAccess.expires_at - 60_000 > now) {
    return cachedAccess.token;
  }
  const sa = loadServiceAccount();
  const jwt = signJwt(sa);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const res = await fetchTextWithTimeout(
    tokenUri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
    },
    FCM_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`OAuth2 token mint failed: ${res.status} ${res.text}`);
  }
  const data = JSON.parse(res.text) as {
    access_token: string;
    expires_in: number;
  };
  cachedAccess = {
    token: data.access_token,
    expires_at: now + data.expires_in * 1000,
  };
  return cachedAccess.token;
}

export interface SendPingResult {
  delivered: string[];
  /** Dead device tokens (caller should delete them from device_push_tokens). */
  stale: string[];
  /** Rejected for a config/credential reason; the token is kept. */
  failed: string[];
}

/** Optional identifiers added to the FCM rejection log lines. */
export interface SendPingLogContext {
  user_id?: string;
  group_folder?: string;
}

export interface SendPingTokenInput {
  device_id: string;
  token: string;
  platform: string;
}

// Only these mean the device token itself is dead.
const STALE_ERROR_CODES = new Set(['UNREGISTERED', 'NOT_FOUND']);
// These point at the Firebase project/credentials or the message, not the
// token, so deleting the token would hide the cause and repeat the failure.
const CONFIG_ERROR_CODES = new Set(['INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

function classifyFcmError(body: any): {
  kind: 'stale' | 'config' | 'transient';
  code: string;
} {
  const code: string =
    body?.error?.details?.find((d: any) => d?.errorCode)?.errorCode ??
    body?.error?.status ??
    '';
  if (STALE_ERROR_CODES.has(code)) return { kind: 'stale', code };
  if (CONFIG_ERROR_CODES.has(code)) return { kind: 'config', code };
  return { kind: 'transient', code };
}

// Cap how long we'll wait on Google for token mint and message send. Without
// a timeout the agent hangs whenever FCM is slow/unreachable from the
// container, even though the rest of notify_user is non-blocking.
const FCM_FETCH_TIMEOUT_MS = 5_000;

// The deadline covers the response body as well as the headers: the timer stays
// armed until the body is fully read, so a server that sends headers and then
// stalls cannot hang the caller.
async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a content-free data-only message to one or more device tokens. The
 * push payload contains `data: { kind, ref? }` and no notification block.
 *
 * - `kind: 'ping'` — wake the device to fetch a new payload (default).
 * - `kind: 'ack_dismiss'` — tell the native FCM service to cancel the
 *   system-tray notification for `ref`. Used after another device acks
 *   the payload so the lingering tray entry goes away even when the
 *   recipient app process has been killed.
 *
 * Returns the device_ids that delivered cleanly, those that came back as
 * stale (caller should delete those from device_push_tokens) and those FCM
 * rejected for a config reason (`failed`, tokens are kept). Every non-delivered
 * FCM response is logged with its error code, never the token.
 */
export async function sendPing(
  tokens: SendPingTokenInput[],
  ref?: string,
  kind: 'ping' | 'ack_dismiss' | 'live_tts' | 'live_tts_stop' = 'ping',
  logContext: SendPingLogContext = {},
): Promise<SendPingResult> {
  if (!PUSH_ENABLED) {
    throw new Error(
      'Push not configured: set FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_PATH',
    );
  }
  if (tokens.length === 0) return { delivered: [], stale: [], failed: [] };

  const accessToken = await getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;

  const data: Record<string, string> = { kind };
  if (ref) data.ref = ref;

  const delivered: string[] = [];
  const stale: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    tokens.map(async (t) => {
      // Data-only payload: the device's CarapaMessagingService picks this up
      // (even when the app is killed), fetches the real payload from
      // /api/notifications/payloads over the signed channel, and posts a
      // rich Android notification with the agent's actual summary/content.
      // Google never sees user content.
      const message = {
        message: {
          token: t.token,
          data,
          android: { priority: 'high' as const },
          // iOS: when the iOS app lands, swap this for an alert push with
          // mutable-content: 1 plus a Notification Service Extension that
          // calls our auth endpoint. Silent data pushes are throttled on iOS.
          // apns: { payload: { aps: { 'content-available': 1, 'mutable-content': 1 } } },
        },
      };
      try {
        const res = await fetchTextWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
          },
          FCM_FETCH_TIMEOUT_MS,
        );
        if (res.ok) {
          delivered.push(t.device_id);
          return;
        }
        let body: unknown = {};
        try {
          body = JSON.parse(res.text);
        } catch {
          // Non-JSON error body: classify as transient.
        }
        const { kind: errorKind, code } = classifyFcmError(body);
        const rejection = {
          ...logContext,
          device_id: t.device_id,
          status: res.status,
          error_code: code,
        };
        if (errorKind === 'stale') {
          stale.push(t.device_id);
          logger.info(rejection, '[FCM] device token rejected as stale');
        } else if (errorKind === 'config') {
          failed.push(t.device_id);
          logger.warn(
            rejection,
            '[FCM] send rejected (config/credential mismatch); token kept',
          );
        } else {
          logger.warn({ ...rejection, body }, '[FCM] transient send failure');
        }
      } catch (err) {
        logger.warn(
          { device_id: t.device_id, err: String(err) },
          '[FCM] request failed (timeout or network)',
        );
      }
    }),
  );

  return { delivered, stale, failed };
}
