import crypto from 'node:crypto';
import { sha256Hex } from '../../lib/hash.js';

const DASHBOARD_TICKET_TTL_MS = 60_000;

interface DashboardTicketRecord {
  projectId: string;
  objectiveId: string;
  expiresAt: number;
}

const tickets = new Map<string, DashboardTicketRecord>();

function pruneExpiredTickets(now = Date.now()): void {
  for (const [hash, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(hash);
  }
}

export function issueDashboardTicket(
  projectId: string,
  objectiveId: string,
): string {
  pruneExpiredTickets();
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(sha256Hex(ticket), {
    projectId,
    objectiveId,
    expiresAt: Date.now() + DASHBOARD_TICKET_TTL_MS,
  });
  return ticket;
}

export function verifyDashboardTicket(
  ticket: unknown,
  projectId: string,
  objectiveId: string,
): boolean {
  if (typeof ticket !== 'string') return false;
  pruneExpiredTickets();
  const record = tickets.get(sha256Hex(ticket));
  return (
    !!record &&
    record.projectId === projectId &&
    record.objectiveId === objectiveId
  );
}

// ── Path-embedded dashboard token ────────────────────────────────────────────
// The dashboard iframe is sandboxed without `allow-same-origin`, so its
// requests carry no session cookie. Authentication therefore travels in the URL
// path (`…/dashboard/t/<token>/<subPath>`) so relative URLs keep it.

const DASHBOARD_PATH_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const DASHBOARD_PATH_TOKEN_SEGMENT = 't';

const pathTokenKey = crypto
  .createHmac(
    'sha256',
    process.env.CARAPA_BOARD_ENCRYPTION_KEY || crypto.randomBytes(32),
  )
  .update('objective-dashboard-path-token-v1')
  .digest();

interface DashboardPathTokenPayload {
  pid: string;
  oid: string;
  userId: string | null;
  exp: number;
}

function signPathToken(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', pathTokenKey)
    .update(encodedPayload)
    .digest('base64url');
}

export function issueDashboardPathToken(
  projectId: string,
  objectiveId: string,
  userId: string,
  now = Date.now(),
): string {
  const payload: DashboardPathTokenPayload = {
    pid: projectId,
    oid: objectiveId,
    userId,
    exp: now + DASHBOARD_PATH_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signPathToken(encoded)}`;
}

/** Whether `userId` is an active user with current read access to `projectId`. */
export type DashboardUserAccessCheck = (
  userId: string,
  projectId: string,
) => Promise<boolean>;

function hasValidPathTokenSignature(token: string): boolean {
  const [encoded, signature, ...extra] = token.split('.');
  if (!encoded || !signature || extra.length > 0) return false;
  const expected = Buffer.from(signPathToken(encoded));
  const actual = Buffer.from(signature);
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

/**
 * The payload of an untampered, unexpired token issued for exactly this
 * pid/oid, or null. Tokens without a `userId` are refused: every issued token
 * names the user whose current access it depends on.
 */
function readDashboardPathToken(
  token: string,
  projectId: string,
  objectiveId: string,
  now: number,
): (DashboardPathTokenPayload & { userId: string }) | null {
  if (!hasValidPathTokenSignature(token)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    ) as Partial<DashboardPathTokenPayload>;
    if (
      payload.pid === projectId &&
      payload.oid === objectiveId &&
      typeof payload.userId === 'string' &&
      payload.userId !== '' &&
      typeof payload.exp === 'number' &&
      payload.exp > now
    ) {
      return payload as DashboardPathTokenPayload & { userId: string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True only for an untampered, unexpired token issued for exactly this
 * pid/oid to a user that `canUserRead` still admits to the project, so a token
 * stops working once its user is removed or disabled.
 */
export async function verifyDashboardPathToken(
  token: string,
  projectId: string,
  objectiveId: string,
  canUserRead: DashboardUserAccessCheck,
  now = Date.now(),
): Promise<boolean> {
  const payload = readDashboardPathToken(token, projectId, objectiveId, now);
  if (!payload) return false;
  try {
    return await canUserRead(payload.userId, projectId);
  } catch {
    return false;
  }
}

/** `<base64url payload>.<43-char base64url HMAC-SHA256>` — the issued token shape. */
const PATH_TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/**
 * Split a leading `t/<token>` pair off the dashboard wildcard segments so the
 * token never reaches the brain proxy or the filesystem lookup. A segment is
 * treated as a token by shape alone (so tampered, expired and foreign tokens
 * are still stripped and then refused by verification), while ordinary names
 * such as a dashboard's own `t/data.json` keep resolving as plain paths.
 */
export function splitDashboardPathToken(segments: string[]): {
  token: string | null;
  segments: string[];
} {
  if (
    segments.length >= 2 &&
    segments[0] === DASHBOARD_PATH_TOKEN_SEGMENT &&
    segments[1] &&
    PATH_TOKEN_SHAPE.test(segments[1])
  ) {
    return { token: segments[1], segments: segments.slice(2) };
  }
  return { token: null, segments };
}

const DASHBOARD_REQUEST_PATH =
  /^\/api\/projects\/([^/]+)\/objectives\/([^/]+)\/dashboard\/(.*)$/i;

/**
 * Auth-gate check: a path token authenticates only a GET below
 * `/api/projects/:pid/objectives/:oid/dashboard/` for the same pid/oid.
 */
export async function hasDashboardPathTokenAccess(
  method: string | undefined,
  requestPath: string,
  canUserRead: DashboardUserAccessCheck,
): Promise<boolean> {
  if (method !== 'GET') return false;
  const match = DASHBOARD_REQUEST_PATH.exec(requestPath);
  if (!match) return false;
  const { token } = splitDashboardPathToken(match[3].split('/'));
  if (!token) return false;
  try {
    return await verifyDashboardPathToken(
      token,
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
      canUserRead,
    );
  } catch {
    return false;
  }
}
