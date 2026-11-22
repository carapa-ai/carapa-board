import {
  JEV_API_KEY,
  JEV_BATCH,
  JEV_BREAKER_COOLDOWN_MS,
  JEV_BREAKER_FAILURES,
  JEV_FALLBACK_API_KEY,
  JEV_FALLBACK_BATCH,
  JEV_FALLBACK_MODEL,
  JEV_FALLBACK_URL,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JEV_URL,
} from '../config.js';
import { logger } from '../logger.js';
import { isLocalEndpoint } from './chat-agents.js';
import { isRecord } from './type-guards.js';
import {
  assertEgressAllowed,
  egressTarget,
  getProjectPrivacyMode,
  PrivacyRefusal,
  requiresLocal,
} from './privacy-policy.js';

/**
 * Shared client for the Jev-protocol System-1 service (self-hosted Laya,
 * `POST /v1/systemone` and `POST /v1/systemone/batch`) or the hosted API
 * (`POST /v1/systemone` only; set `JEV_BATCH` off). It owns the URL, auth
 * header, deadline and response validation so callers only deal with typed
 * answers or a typed `JevError`.
 *
 * When `JEV_FALLBACK_URL` is set, a call without an explicit `url` fails over
 * once to that hosted profile after a primary network error, timeout or HTTP
 * 5xx, and a process-wide circuit breaker skips an unreachable primary. The
 * fallback passes through the same privacy gate; a project that refuses it
 * keeps the primary behaviour and error.
 */

export type JevErrorKind =
  | 'config'
  | 'timeout'
  | 'network'
  | 'http'
  | 'malformed'
  /** Refused by the project's privacy mode before any request was sent. */
  | 'privacy';

export class JevError extends Error {
  readonly kind: JevErrorKind;
  /** HTTP status for `http` errors. */
  readonly status?: number;

  constructor(
    kind: JevErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : options);
    this.name = 'JevError';
    this.kind = kind;
    this.status = options.status;
  }
}

/** One answer; which fields are present depends on the question `type`. */
export interface JevAnswer {
  type?: string;
  /** `choice` questions: the winning label. */
  choice?: string;
  /** `noul` questions: probability (0..1) that the statement holds. */
  noul?: number;
  /** `score` questions: expected level. */
  score?: number;
  /** Laya: calibrated `max(p)`. The hosted API omits it. */
  answer_confidence?: number;
  /** Hosted API: `max(p)`. Laya: an uncalibrated entropy score. */
  confidence?: number;
  probabilities?: Record<string, number>;
}

/** A finite probability in 0..1 (`noul`, `answer_confidence`); rejects NaN and out-of-range values. */
export function isProbability(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  routing?: { model?: unknown };
}

export interface JevRequestOptions {
  /** Overrides `JEV_URL`. */
  url?: string;
  /** Overrides `JEV_API_KEY`. */
  apiKey?: string;
  /** Overrides `JEV_TIMEOUT_MS`; ignored when `signal` is given. */
  timeoutMs?: number;
  /** An existing deadline, to share one across several calls. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Checkpoint name, forwarded as `model`; defaults to `JEV_MODEL`. */
  model?: string;
  /** Overrides `JEV_BATCH`: use the server's batch endpoint. */
  batch?: boolean;
  /** Project whose privacy mode governs this call; unset applies the strictest registered mode. */
  projectId?: string;
}

/** Parallel single calls per batch when the server has no batch endpoint. */
const FALLBACK_CONCURRENCY = 8;

export interface JevSystemOneRequest extends JevRequestOptions {
  state: string;
  questions: Record<string, unknown>;
}

export interface JevBatchRequest extends JevRequestOptions {
  states: string[];
  questions: Record<string, unknown>;
}

/** Everything that differs between the primary and the fallback endpoint. */
interface JevProfile {
  url: string;
  apiKey: string;
  /** Checkpoint sent as `model`; empty sends none. */
  model: string;
  /** Whether the endpoint has `/v1/systemone/batch`. */
  batch: boolean;
}

async function post(
  path: string,
  body: Record<string, unknown>,
  profile: JevProfile,
  options: JevRequestOptions,
): Promise<unknown> {
  const { url } = profile;
  if (!url) throw new JevError('config', 'JEV_URL is not configured');
  try {
    assertEgressAllowed({
      projectId: options.projectId,
      purpose: 'jev',
      locality: isLocalEndpoint(url) ? 'local' : 'remote',
      target: egressTarget(url),
    });
  } catch (error) {
    if (error instanceof PrivacyRefusal) {
      throw new JevError('privacy', error.message, { cause: error });
    }
    throw error;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
  const signal =
    options.signal ?? AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS);
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${url}${path}`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timedOut =
      signal.aborted || name === 'TimeoutError' || name === 'AbortError';
    throw new JevError(
      timedOut ? 'timeout' : 'network',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new JevError('http', `Jev responded with HTTP ${response.status}`, {
      status: response.status,
    });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new JevError(
      signal.aborted ? 'timeout' : 'malformed',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

interface FailoverConfig {
  /** Absent when `JEV_FALLBACK_URL` is unset: no failover, no breaker. */
  fallback?: JevProfile;
  breakerFailures: number;
  breakerCooldownMs: number;
}

function configFromEnv(): FailoverConfig {
  return {
    fallback: JEV_FALLBACK_URL
      ? {
          url: JEV_FALLBACK_URL,
          apiKey: JEV_FALLBACK_API_KEY,
          model: JEV_FALLBACK_MODEL,
          batch: JEV_FALLBACK_BATCH,
        }
      : undefined,
    breakerFailures: JEV_BREAKER_FAILURES,
    breakerCooldownMs: JEV_BREAKER_COOLDOWN_MS,
  };
}

let failoverConfig = configFromEnv();

/** Circuit breaker for the primary endpoint; per process, shared by all call sites. */
const breaker = { failures: 0, openUntil: 0, open: false };

/** Test hook: clear the circuit breaker. */
export function __resetJevBreakerForTests(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
  breaker.open = false;
}

/** Test hook: replace the failover settings; no argument restores the environment's. */
export function __setJevFailoverConfigForTests(
  config?: Partial<FailoverConfig>,
): void {
  failoverConfig = config ? { ...configFromEnv(), ...config } : configFromEnv();
  __resetJevBreakerForTests();
}

/** Errors that mean the endpoint itself is unavailable, as opposed to a bad request or response. */
function isOutage(error: unknown): error is JevError {
  return (
    error instanceof JevError &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      (error.kind === 'http' && (error.status ?? 0) >= 500))
  );
}

function recordPrimaryFailure(): void {
  breaker.failures++;
  if (breaker.failures < failoverConfig.breakerFailures) return;
  breaker.openUntil = Date.now() + failoverConfig.breakerCooldownMs;
  if (!breaker.open) {
    breaker.open = true;
    logger.info(
      {
        event: 'jev_breaker_open',
        failures: breaker.failures,
        cooldownMs: failoverConfig.breakerCooldownMs,
      },
      'jev primary unavailable; using fallback',
    );
  }
}

function recordPrimarySuccess(): void {
  const wasOpen = breaker.open;
  __resetJevBreakerForTests();
  if (wasOpen) {
    logger.info({ event: 'jev_breaker_closed' }, 'jev primary recovered');
  }
}

/**
 * Run one operation against the primary profile, failing over once to the
 * fallback profile when the primary is unavailable. `run` performs the whole
 * operation (one call or a batch) against the profile it is given, so a batch
 * is re-planned for the fallback's batch support. Only logs ids and error
 * kinds, never request text.
 */
async function withFailover<T>(
  options: JevRequestOptions,
  overrides: { model?: string; batch?: boolean },
  path: (profile: JevProfile) => string,
  run: (profile: JevProfile) => Promise<T>,
): Promise<T> {
  const primary: JevProfile = {
    url: options.url ?? JEV_URL,
    apiKey: options.apiKey ?? JEV_API_KEY,
    model: overrides.model || JEV_MODEL,
    batch: overrides.batch ?? JEV_BATCH,
  };
  const fallback =
    options.url === undefined ? failoverConfig.fallback : undefined;
  if (!fallback) return run(primary);

  const attempt = async (
    endpoint: 'primary' | 'fallback',
    profile: JevProfile,
  ): Promise<T> => {
    try {
      return await run(profile);
    } catch (error) {
      if (error instanceof JevError && error.kind !== 'privacy') {
        logger.warn(
          {
            event: 'jev_attempt_failed',
            endpoint,
            kind: error.kind,
            status: error.status,
            path: path(profile),
            projectId: options.projectId,
          },
          'jev request failed',
        );
      }
      throw error;
    }
  };

  // A project whose privacy mode refuses the fallback keeps using the primary
  // alone, outside the breaker, so it recovers as soon as the primary does.
  const fallbackAllowed =
    isLocalEndpoint(fallback.url) ||
    !requiresLocal(getProjectPrivacyMode(options.projectId), 'jev');
  if (!fallbackAllowed) return attempt('primary', primary);

  if (breaker.open && Date.now() < breaker.openUntil) {
    return attempt('fallback', fallback);
  }

  let result: T;
  try {
    result = await attempt('primary', primary);
  } catch (primaryError) {
    if (!isOutage(primaryError)) throw primaryError;
    recordPrimaryFailure();
    // A caller-supplied deadline is shared, so an expired one leaves no time.
    if (options.signal?.aborted) throw primaryError;
    try {
      return await attempt('fallback', fallback);
    } catch (fallbackError) {
      if (
        fallbackError instanceof JevError &&
        fallbackError.kind === 'privacy'
      ) {
        throw primaryError;
      }
      throw fallbackError;
    }
  }
  recordPrimarySuccess();
  return result;
}

/** Callers validate the answer fields they rely on; a missing `answers` is an empty set. */
function parseResult(value: unknown, message: string): JevResult {
  if (!isRecord(value)) throw new JevError('malformed', message);
  return {
    answers: isRecord(value.answers)
      ? (value.answers as Record<string, JevAnswer>)
      : {},
    routing: isRecord(value.routing) ? value.routing : undefined,
  };
}

const SINGLE_PATH = '/v1/systemone';
const BATCH_PATH = '/v1/systemone/batch';

async function callOne(
  profile: JevProfile,
  state: string,
  questions: Record<string, unknown>,
  options: JevRequestOptions,
): Promise<JevResult> {
  const body = await post(
    SINGLE_PATH,
    { state, questions, model: profile.model || undefined },
    profile,
    options,
  );
  return parseResult(body, 'Jev returned a malformed response');
}

async function callBatch(
  profile: JevProfile,
  states: string[],
  questions: Record<string, unknown>,
  options: JevRequestOptions,
): Promise<JevResult[]> {
  if (!profile.batch) {
    // No batch endpoint: one call per state, a few at a time, order preserved.
    const results: JevResult[] = new Array(states.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < states.length) {
        const index = next++;
        try {
          results[index] = await callOne(
            profile,
            states[index],
            questions,
            options,
          );
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(FALLBACK_CONCURRENCY, states.length) },
        worker,
      ),
    );
    return results;
  }
  const body = await post(
    BATCH_PATH,
    { states, questions, model: profile.model || undefined },
    profile,
    options,
  );
  const malformed = 'Jev returned a malformed batch response';
  if (
    !isRecord(body) ||
    !Array.isArray(body.results) ||
    body.results.length !== states.length
  ) {
    throw new JevError('malformed', malformed);
  }
  return body.results.map((result) => parseResult(result, malformed));
}

/** Ask typed questions about one state. */
export async function jevSystemOne(
  request: JevSystemOneRequest,
): Promise<JevResult> {
  const { state, questions, model, batch: _batch, ...options } = request;
  return withFailover(
    options,
    { model },
    () => SINGLE_PATH,
    (profile) => callOne(profile, state, questions, options),
  );
}

/** Ask the same questions about several states; results keep the states' order. */
export async function jevSystemOneBatch(
  request: JevBatchRequest,
): Promise<JevResult[]> {
  const { states, questions, model, batch, ...options } = request;
  return withFailover(
    options,
    { model, batch },
    (profile) => (profile.batch ? BATCH_PATH : SINGLE_PATH),
    (profile) => callBatch(profile, states, questions, options),
  );
}
