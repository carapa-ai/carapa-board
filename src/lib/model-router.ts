import {
  JEV_TIMEOUT_MS,
  JEV_URL,
  MODEL_ROUTING_ENGINE,
  type ModelRoutingEngine,
} from '../config.js';
import { logger } from '../logger.js';
import {
  isProbability,
  JevError,
  jevSystemOne,
  type JevAnswer,
} from './jev-client.js';

/**
 * Automatic model-tier routing. `routeText` asks the Jev System-1 service, in
 * one call, how demanding a request is and whether it touches sensitive
 * ground, then applies two escalation gates. Nothing calls it yet; with
 * `MODEL_ROUTING_ENGINE=off` (the default) it returns `null` without any
 * network access.
 */

export type ModelTier = 'fast' | 'balanced' | 'frontier';

/** Cheapest first; escalation walks right, never left. */
const TIER_LADDER: readonly ModelTier[] = ['fast', 'balanced', 'frontier'];

/** A tier answer below this confidence is moved up one tier. */
const TIER_MIN_CONFIDENCE = 0.6;
/** A `sensitive` probability at or above this forces the frontier tier. */
const SENSITIVE_FRONTIER_THRESHOLD = 0.7;
/** Upper bound for the routing call; routing must never add noticeable latency. */
const ROUTING_MAX_TIMEOUT_MS = 1500;

type RoutingReason = 'clean' | 'low-confidence-escalated' | 'sensitive-forced';

export interface RoutingDecision {
  /** Tier to use after the gates. */
  tier: ModelTier;
  /** Tier Jev picked before the gates. */
  rawTier: ModelTier;
  /** Confidence of the tier answer; `null` when Jev did not report one. */
  confidence: number | null;
  /** Probability that the text touches sensitive ground. */
  sensitive: number;
  latencyMs: number;
  reason: RoutingReason;
}

export interface RouteTextOptions {
  /** Overrides `MODEL_ROUTING_ENGINE`. */
  engine?: ModelRoutingEngine;
  /** Overrides `JEV_URL`. */
  url?: string;
  apiKey?: string;
  /** Capped at `ROUTING_MAX_TIMEOUT_MS`. Defaults to `JEV_TIMEOUT_MS`. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Project whose privacy mode governs the Jev call; unset applies the strictest registered mode. */
  projectId?: string;
}

const ROUTING_QUESTIONS = {
  tier: {
    type: 'choice',
    instructions:
      'How capable must the AI model be to handle this request well?',
    criteria: {
      fast: 'Mechanical or trivial work: rename, reformat, fix a typo, small lookup, simple question with an obvious answer',
      balanced:
        'Ordinary feature work or a bug fix with a clear cause, contained in a few files',
      frontier:
        'Architecture or design, a bug with an unclear root cause, a cross-cutting refactor, security design, or open-ended analysis',
    },
  },
  sensitive: {
    type: 'noul',
    instructions:
      'Does the request involve production systems, credentials or secrets, permissions or access control, or payments and billing?',
    criteria: {
      true: 'Touches production, credentials/secrets, permissions/access control, or payments/billing',
      false: 'Ordinary development work that touches none of these',
    },
  },
} as const;

function isTier(value: unknown): value is ModelTier {
  return TIER_LADDER.includes(value as ModelTier);
}

/**
 * `answer_confidence` (Laya's calibrated max(p)), else `confidence`, else the
 * highest probability, else unknown. Laya's `confidence` is an uncalibrated
 * entropy score, so it must not outrank `answer_confidence`.
 */
function tierConfidence(answer: JevAnswer): number | null {
  if (isProbability(answer.answer_confidence)) return answer.answer_confidence;
  if (isProbability(answer.confidence)) return answer.confidence;
  const probabilities = Object.values(answer.probabilities ?? {}).filter(
    isProbability,
  );
  return probabilities.length > 0 ? Math.max(...probabilities) : null;
}

function escalate(tier: ModelTier): ModelTier {
  const next = TIER_LADDER[TIER_LADDER.indexOf(tier) + 1];
  return next ?? tier;
}

/**
 * Pick a model tier for `text`. Returns `null` when routing is off, Jev is not
 * configured, or anything goes wrong (callers then keep their current model).
 * The text is never logged.
 */
export async function routeText(
  text: string,
  options: RouteTextOptions = {},
): Promise<RoutingDecision | null> {
  if ((options.engine ?? MODEL_ROUTING_ENGINE) !== 'jev') return null;
  if (!(options.url ?? JEV_URL)) return null;

  const timeoutMs = Math.min(
    options.timeoutMs ?? JEV_TIMEOUT_MS,
    ROUTING_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  try {
    const { answers } = await jevSystemOne({
      state: text,
      questions: ROUTING_QUESTIONS,
      // Only an explicit override bypasses the shared client's hosted failover.
      url: options.url,
      apiKey: options.apiKey,
      timeoutMs,
      fetchImpl: options.fetchImpl,
      projectId: options.projectId,
    });
    const tierAnswer = answers.tier;
    const sensitive = answers.sensitive?.noul;
    if (
      !tierAnswer ||
      !isTier(tierAnswer.choice) ||
      !isProbability(sensitive)
    ) {
      throw new JevError(
        'malformed',
        'Jev returned an unusable routing answer',
      );
    }

    const rawTier = tierAnswer.choice;
    const confidence = tierConfidence(tierAnswer);
    let tier = rawTier;
    let reason: RoutingReason = 'clean';
    if (confidence !== null && confidence < TIER_MIN_CONFIDENCE) {
      tier = escalate(tier);
      reason = 'low-confidence-escalated';
    }
    if (sensitive >= SENSITIVE_FRONTIER_THRESHOLD) {
      tier = 'frontier';
      reason = 'sensitive-forced';
    }
    return {
      tier,
      rawTier,
      confidence,
      sensitive,
      latencyMs: Date.now() - startedAt,
      reason,
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        kind: error instanceof JevError ? error.kind : 'unexpected',
        latencyMs: Date.now() - startedAt,
      },
      'Model routing failed; keeping the current model',
    );
    return null;
  }
}
