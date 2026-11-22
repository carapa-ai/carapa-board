/**
 * HTTP request-timing middleware. Logs every completed request at debug
 * level with `{method, route, routePattern, status, durationMs}`, and escalates
 * to a warn
 * when duration crosses a slow-request threshold. Pairs with the
 * `DB_SLOW_MS` slow-query log in `db/drizzle-client.ts`: a slow request that
 * doesn't show a corresponding slow query is CPU- or external-call-bound,
 * which DB-only logging would miss.
 *
 * Tunables:
 *   REQUEST_SLOW_MS     default 500     — warn threshold; 0 disables warn level
 *   REQUEST_SLOW_MS_LLM default 300000  — warn threshold for routes that block
 *                                         on an upstream LLM call (see isLlmRoute)
 *   REQUEST_SLOW_MS_GIT default 5000    — warn threshold for routes that fan
 *                                         out sandbox_git calls (see isGitRoute)
 *   REQUEST_LOG_LEVEL   default 'debug' — level for the always-logged success line
 *                                         ('debug' | 'info' | 'silent')
 *
 * Disabled when NODE_ENV === 'test' to keep the suite hermetic.
 */
import type { Request, Response, NextFunction } from 'express';
import { logger as defaultLogger } from '../logger.js';
import { maxLoopLagSince } from './event-loop-lag.js';

const SLOW_REQUEST_MS = parseInt(process.env.REQUEST_SLOW_MS ?? '500', 10);

/**
 * Threshold for routes that legitimately wait on an LLM turn. Such requests
 * routinely take tens of seconds without being "slow" in the sense this warn
 * is meant to surface, so they get a much higher bar — a genuinely stuck
 * request still warns, but a normal multi-minute LLM turn does not.
 */
const SLOW_REQUEST_LLM_MS = parseInt(
  process.env.REQUEST_SLOW_MS_LLM ?? '300000',
  10,
);

/**
 * Routes whose latency is dominated by an upstream LLM call. Currently the
 * chat-turn endpoint (`POST /api/projects/:id/messages`). The middleware only
 * sees method + path here, so match on those.
 */
function isLlmRoute(req: Request): boolean {
  return req.method === 'POST' && /\/messages$/.test(routePath(req));
}

/** Meeting recording — chunk/stop routinely block on ffmpeg + Whisper. */
function isMeetingRecordingRoute(req: Request): boolean {
  return /\/meetings\/record(\/|$)/.test(routePath(req));
}

/**
 * Routes that fan out multiple `sandbox_git` calls per request. These can
 * legitimately take a few seconds (worktree diff with hundreds of untracked
 * files, slow sandbox) and shouldn't trip the default 500ms warn threshold.
 * The threshold is tunable via `REQUEST_SLOW_MS_GIT`; default 5s — high enough
 * to absorb a worst-case batched diff on a slow box, low enough that a
 * genuinely stuck call still shows up in the log.
 */
const SLOW_REQUEST_GIT_MS = parseInt(
  process.env.REQUEST_SLOW_MS_GIT ?? '5000',
  10,
);

function isGitRoute(req: Request): boolean {
  const p = routePath(req);
  // Conversation git-diff, working-tree commit-message suggestion, and any
  // repo-files / repo-content read. These all go through `sandbox_git` or
  // read the repo tree, both of which can be slow on a large repo.
  return (
    /\/conversations\/[^/]+\/diff$/.test(p) ||
    /\/conversations\/[^/]+\/commit-message$/.test(p) ||
    /\/git\//.test(p)
  );
}

export type RequestLogLevel = 'debug' | 'info' | 'silent';

export interface RequestTimingLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

function configuredLevel(): RequestLogLevel {
  const raw = (process.env.REQUEST_LOG_LEVEL ?? 'debug').toLowerCase();
  if (raw === 'info' || raw === 'silent' || raw === 'debug') return raw;
  return 'debug';
}

/**
 * Strip query strings from the path so paths bind to a route shape rather
 * than to user-supplied parameters (avoids high-cardinality log keys).
 */
function routePath(req: Request): string {
  const url = req.originalUrl ?? req.url ?? '';
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

/**
 * Use Express's matched route template alongside the concrete query-free route
 * so logs contain both the project slug and the handler shape.
 */
function routeTemplate(req: Request): string {
  const matched = req.route?.path as unknown;
  if (typeof matched === 'string') return `${req.baseUrl || ''}${matched}`;
  if (matched instanceof RegExp) return `${req.baseUrl || ''}${matched}`;
  return '<unmatched>';
}

export function requestTiming(
  opts: {
    slowMs?: number;
    level?: RequestLogLevel;
    /** Test seam: inject a logger to capture output. Defaults to the app logger. */
    log?: RequestTimingLogger;
    /** Test seam: skip the NODE_ENV=test bypass so unit tests can exercise the body. */
    forceEnabled?: boolean;
  } = {},
) {
  const slowMs = opts.slowMs ?? SLOW_REQUEST_MS;
  const level = opts.level ?? configuredLevel();
  const skipNormal = level === 'silent';
  const log = opts.log ?? defaultLogger;
  const enabled = opts.forceEnabled || process.env.NODE_ENV !== 'test';

  return function requestTimingMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!enabled) return next();
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const fields = {
        method: req.method,
        route: routePath(req),
        routePattern: routeTemplate(req),
        status: res.statusCode,
        durationMs,
      };
      if (slowMs > 0 && !isMeetingRecordingRoute(req)) {
        const threshold = isLlmRoute(req)
          ? Math.max(slowMs, SLOW_REQUEST_LLM_MS)
          : isGitRoute(req)
            ? Math.max(slowMs, SLOW_REQUEST_GIT_MS)
            : slowMs;
        if (durationMs >= threshold) {
          log.warn(
            { ...fields, loopLagMs: maxLoopLagSince(start) },
            'slow request',
          );
          return;
        }
      }
      if (skipNormal) return;
      if (level === 'info') log.info(fields, 'request');
      else log.debug(fields, 'request');
    });
    next();
  };
}
