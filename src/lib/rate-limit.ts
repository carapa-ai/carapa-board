/**
 * Rate limiters for authentication endpoints. Wired into /api/auth/login and
 * /api/auth/token by http-service.ts. Throttles credential stuffing without
 * locking out legitimate users.
 *
 * Tunable via env:
 *   AUTH_RATE_LIMIT_WINDOW_MS  (default 60000)  — sliding window length
 *   AUTH_LOGIN_RATE_LIMIT      (default 10)     — login attempts per window
 *   AUTH_TOKEN_RATE_LIMIT      (default 30)     — token-handshake reqs per window
 *
 * Disabled entirely when NODE_ENV === 'test' so the test suite isn't shaped by
 * timing windows.
 */
import rateLimit, {
  ipKeyGenerator,
  type RateLimitRequestHandler,
} from 'express-rate-limit';

const WINDOW_MS = parseInt(
  process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000',
  10,
);
const LOGIN_MAX = parseInt(process.env.AUTH_LOGIN_RATE_LIMIT ?? '10', 10);
const TOKEN_MAX = parseInt(process.env.AUTH_TOKEN_RATE_LIMIT ?? '30', 10);

const noopMiddleware = ((_req: unknown, _res: unknown, next: () => void) =>
  next()) as unknown as RateLimitRequestHandler;

function makeLimiter(
  max: number,
  message: string,
  opts: { skipSuccessfulRequests?: boolean } = {},
): RateLimitRequestHandler {
  if (process.env.NODE_ENV === 'test') return noopMiddleware;
  return buildLimiter({ max, message, ...opts });
}

/**
 * Test seam: build a limiter without honoring the NODE_ENV='test' bypass,
 * so unit tests can exercise the throttling behavior end-to-end. Production
 * code should use `loginLimiter` / `tokenLimiter` instead.
 */
export function buildLimiter(opts: {
  max: number;
  windowMs?: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  keyGenerator?: (req: any) => string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? WINDOW_MS,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    keyGenerator: opts.keyGenerator,
    message: { error: opts.message ?? 'Rate limit exceeded' },
  });
}

export function publicTokenRateLimitKey(req: any): string {
  const token = String(req.params?.token ?? 'unknown');
  const ip = req.ip ? ipKeyGenerator(req.ip) : 'unknown';
  return `${token}:${ip}`;
}

/**
 * Login limiter — only counts failed attempts so legitimate users aren't
 * throttled when they hit refresh after a successful sign-in.
 */
export const loginLimiter: RateLimitRequestHandler = makeLimiter(
  LOGIN_MAX,
  'Too many login attempts; try again in a minute',
  { skipSuccessfulRequests: true },
);

/**
 * Token-handshake limiter — counts every request because the device-signature
 * flow has no separate "success vs failure" body shape worth distinguishing
 * for abuse purposes; the limit is set higher to accommodate normal use.
 */
export const tokenLimiter: RateLimitRequestHandler = makeLimiter(
  TOKEN_MAX,
  'Too many token-handshake requests; try again shortly',
);

/** MCP OAuth endpoints (anonymous, so throttled per client IP). */
export const oauthRegisterLimiter: RateLimitRequestHandler = makeLimiter(
  10,
  'Too many client registrations; try again shortly',
);
export const oauthAuthorizeLimiter: RateLimitRequestHandler = makeLimiter(
  30,
  'Too many authorization requests; try again shortly',
);
export const oauthTokenLimiter: RateLimitRequestHandler = makeLimiter(
  30,
  'Too many token requests; try again shortly',
);
