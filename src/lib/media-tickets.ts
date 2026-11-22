import crypto from 'node:crypto';

// Short-lived signed tickets that let a bare <video>/<audio src> stream a
// board file. The Android app is cross-origin and authenticates with headers a
// media element cannot send, so the client asks for a ticket bound to one exact
// file URL and appends it to that URL. The ticket stands in for its issuer's
// own session (same user, same device) on GET/HEAD of that URL only; project
// access and device checks still run on every request.

const MEDIA_TICKET_TTL_MS = 8 * 60 * 60 * 1000;

/** Query parameter that carries the ticket on a media URL. */
export const MEDIA_TICKET_PARAM = 'mediaTicket';

/** File-serving routes a ticket may be issued for. */
const MEDIA_TICKET_PATHS = [
  /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/recordings\/[^/]+$/i,
  /^\/api\/projects\/[^/]+\/files\/(?:group|repo)\/content$/i,
  /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/files\/repo\/content$/i,
  /^\/api\/projects\/[^/]+\/files\/mount\/\d+\/content$/i,
  /^\/artifacts\/[^/]+\/.+$/i,
];

const ticketKey = crypto
  .createHmac(
    'sha256',
    process.env.CARAPA_BOARD_ENCRYPTION_KEY || crypto.randomBytes(32),
  )
  .update('media-ticket-v1')
  .digest();

interface MediaTicketPayload {
  url: string;
  sub: string;
  did: string | null;
  exp: number;
}

function sign(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', ticketKey)
    .update(encodedPayload)
    .digest('base64url');
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl, 'http://board.invalid');
  } catch {
    return null;
  }
}

/**
 * Path plus sorted query without the ticket parameter, or null when the URL is
 * not an allowed file route. Absolute URLs are reduced to their path, so the
 * client may request a ticket for whichever board origin it streams from.
 */
function canonicalMediaUrl(rawUrl: string): string | null {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !MEDIA_TICKET_PATHS.some((p) => p.test(parsed.pathname)))
    return null;
  parsed.searchParams.delete(MEDIA_TICKET_PARAM);
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  return parsed.pathname + (query ? `?${query}` : '');
}

/** A ticket for `url`, or null when the URL is not an allowed file route. */
export function issueMediaTicket(
  url: string,
  userId: string,
  deviceId: string | null,
  now = Date.now(),
): string | null {
  const canonical = canonicalMediaUrl(url);
  if (!canonical) return null;
  const payload: MediaTicketPayload = {
    url: canonical,
    sub: userId,
    did: deviceId,
    exp: now + MEDIA_TICKET_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Auth-gate check: the issuing user and device when this GET/HEAD request URL
 * carries an untampered, unexpired ticket issued for exactly this URL; null for
 * anything else.
 */
export function resolveMediaTicket(
  method: string | undefined,
  originalUrl: string,
  now = Date.now(),
): { userId: string; deviceId: string | undefined } | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const parsed = parseUrl(originalUrl);
  const ticket = parsed?.searchParams.get(MEDIA_TICKET_PARAM);
  if (!parsed || !ticket) return null;
  // Refuse paths the URL parser would normalize (dot segments): the router
  // matches the raw path, which must be the one the ticket was issued for.
  if (originalUrl.split('?')[0] !== parsed.pathname) return null;
  const url = canonicalMediaUrl(originalUrl);
  if (!url) return null;
  const [encoded, signature, ...extra] = ticket.split('.');
  if (!encoded || !signature || extra.length > 0) return null;
  const expected = Buffer.from(sign(encoded));
  const actual = Buffer.from(signature);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  )
    return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<MediaTicketPayload>;
    if (
      payload.url !== url ||
      typeof payload.sub !== 'string' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now
    )
      return null;
    return {
      userId: payload.sub,
      deviceId: typeof payload.did === 'string' ? payload.did : undefined,
    };
  } catch {
    return null;
  }
}
