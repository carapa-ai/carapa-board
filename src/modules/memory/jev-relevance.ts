import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  JEV_MAX_CANDIDATES,
  JEV_MIN_SCORE,
  JEV_SHADOW_LOG_PATH,
  JEV_TIMEOUT_MS,
} from '../../config.js';
import { jevSystemOneBatch } from '../../lib/jev-client.js';
import { logger } from '../../logger.js';

/**
 * Observe-only Jev relevance scoring for memory-capsule candidates.
 *
 * The Jev-protocol System-1 service (self-hosted Laya, `POST /v1/systemone/batch`) answers a typed
 * `score` question per (request, memory) pair. In shadow mode the scores are
 * logged (stdout) and appended to a dedicated JSONL file (`JEV_SHADOW_LOG_PATH`,
 * default `<data dir>/jev-shadow.jsonl`) next to the LLM judge's selection so
 * agreement can be measured before Jev is allowed to influence what agents
 * receive.
 */

const REQUEST_MAX_CHARS = 1_200;
const MEMORY_MAX_CHARS = 600;
/**
 * States per batch call. The CPU-only self-hosted backend is ~250 ms/pair and
 * the gateway answers 502 at ~10 s, so large batches with long prompts fail;
 * 8 per call stayed well inside that in the offline eval.
 */
const MAX_STATES_PER_CALL = 8;

/** Tag logged with every shadow record: scores are only comparable within one version. */
const JEV_QUESTION_VERSION = 'v3-strict-rubric';

// Strict rubric: best variant in the offline eval (AUC 0.92 vs 0.83 for the
// original "How useful is the memory for the request?" wording).
const RELEVANCE_QUESTION = {
  type: 'score',
  instructions:
    'Would the memory materially help answer the request, beyond merely sharing a topic?',
  criteria: [
    'No: unrelated or only topically adjacent',
    'Maybe: partly related',
    'Yes: supplies a fact or constraint needed for the answer',
  ],
} as const;

export interface JevScoreCandidate {
  id: string;
  content: string;
  source?: string;
}

export interface JevRelevanceResult {
  /** Expected usefulness level per candidate id, 0 (unrelated) to 2 (directly useful). */
  scores: Map<string, number>;
  /** How many states each Laya checkpoint answered (english / multilingual / ...); hosted Jev has no routing info. */
  checkpoints: Record<string, number>;
}

export interface JevRelevanceOptions {
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Project the call is attributed to, for privacy-mode egress checks. */
  projectId?: string;
}

export type JevScorer = (
  request: string,
  candidates: JevScoreCandidate[],
  options?: JevRelevanceOptions,
) => Promise<JevRelevanceResult>;

/** Score each candidate memory against the request. Throws on any failure. */
export async function scoreMemoryRelevance(
  request: string,
  candidates: JevScoreCandidate[],
  options: JevRelevanceOptions = {},
): Promise<JevRelevanceResult> {
  // One deadline for the whole scoring run, however many chunks it needs.
  const signal = AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS);
  const scores = new Map<string, number>();
  const checkpoints: Record<string, number> = {};
  const trimmedRequest = request.slice(0, REQUEST_MAX_CHARS);

  for (let i = 0; i < candidates.length; i += MAX_STATES_PER_CALL) {
    const chunk = candidates.slice(i, i + MAX_STATES_PER_CALL);
    const results = await jevSystemOneBatch({
      states: chunk.map(
        (candidate) =>
          `Request: ${trimmedRequest}\nMemory: ${candidate.content.slice(0, MEMORY_MAX_CHARS)}`,
      ),
      questions: { relevance: RELEVANCE_QUESTION },
      url: options.url,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      projectId: options.projectId,
      signal,
    });
    results.forEach((result, index) => {
      const score = result.answers.relevance?.score;
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error('Jev returned a non-numeric relevance score');
      }
      scores.set(chunk[index].id, score);
      const model =
        typeof result.routing?.model === 'string'
          ? result.routing.model
          : 'unknown';
      checkpoints[model] = (checkpoints[model] ?? 0) + 1;
    });
  }
  return { scores, checkpoints };
}

interface JevAgreement {
  judgeSelectedCount: number;
  /** Share of judge-selected candidates inside Jev's top-k (k = judge count). */
  topKRecall: number | null;
  /** P(judge-selected outranks judge-rejected), ties count 0.5. */
  auc: number | null;
  /**
   * Share of scored candidates ranked strictly below every judge-selected one,
   * i.e. how much of the pool a Jev cutoff could drop with 100% recall.
   */
  poolCutAtFullRecall: number | null;
}

/** Pure agreement metrics between Jev scores and the LLM judge's selection. */
function computeJevAgreement(
  scores: Map<string, number>,
  judgeSelectedIds: string[],
): JevAgreement {
  const selected = new Set(judgeSelectedIds.filter((id) => scores.has(id)));
  const rejected = [...scores.keys()].filter((id) => !selected.has(id));
  const empty: JevAgreement = {
    judgeSelectedCount: selected.size,
    topKRecall: null,
    auc: null,
    poolCutAtFullRecall: null,
  };
  if (selected.size === 0) return empty;

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topK = new Set(ranked.slice(0, selected.size).map(([id]) => id));
  const topKRecall =
    [...selected].filter((id) => topK.has(id)).length / selected.size;

  let auc: number | null = null;
  if (rejected.length > 0) {
    let wins = 0;
    for (const s of selected) {
      for (const r of rejected) {
        const a = scores.get(s)!;
        const b = scores.get(r)!;
        wins += a > b ? 1 : a === b ? 0.5 : 0;
      }
    }
    auc = wins / (selected.size * rejected.length);
  }

  const minSelected = Math.min(...[...selected].map((id) => scores.get(id)!));
  const below = [...scores.values()].filter((v) => v < minSelected).length;
  return {
    judgeSelectedCount: selected.size,
    topKRecall,
    auc,
    poolCutAtFullRecall: below / scores.size,
  };
}

export interface JevSelection {
  /** Candidate ids with score >= minScore, best first. */
  selectedIds: string[];
  checkpoints: Record<string, number>;
}

/**
 * Select candidates by Jev score alone (no LLM judge). Scores every candidate;
 * throws on any Jev failure so the caller can fall back to the LLM judge.
 */
export async function selectByJev(
  request: string,
  candidates: JevScoreCandidate[],
  options: { minScore?: number; scorer?: JevScorer; projectId?: string } = {},
): Promise<JevSelection> {
  const scorer = options.scorer ?? scoreMemoryRelevance;
  const minScore = options.minScore ?? JEV_MIN_SCORE;
  const { scores, checkpoints } = await scorer(request, candidates, {
    projectId: options.projectId,
  });
  if (candidates.some((candidate) => !scores.has(candidate.id))) {
    throw new Error('Jev did not score every candidate');
  }
  const selectedIds = candidates
    .filter((candidate) => scores.get(candidate.id)! >= minScore)
    .sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
    .map((candidate) => candidate.id);
  return { selectedIds, checkpoints };
}

/** Single-flight lock for the memory-capsule site only; the reflector gate has its own scoring path. */
let shadowInFlight = false;

export interface JevShadowInput {
  groupFolder: string;
  level: string;
  request: string;
  candidates: JevScoreCandidate[];
  /** Candidate ids the LLM judge selected (only call after a successful judge run). */
  judgeSelectedIds: string[];
  scorer?: JevScorer;
  /** Project the scoring call is attributed to, for privacy-mode egress checks. */
  projectId?: string;
  maxCandidates?: number;
  /** Override the shadow JSONL log path; `null` disables file logging. */
  shadowLogPath?: string | null;
}

/**
 * Append one JSONL record to the shadow log. Fire-and-forget: disk problems
 * must never affect turns, so failures are only debug-logged.
 */
export async function appendShadowLogLine(
  logPath: string,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    logger.debug({ err: error, path: logPath }, 'Jev shadow log append failed');
  }
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Score candidates with Jev and log agreement with the judge. Never throws
 * and never blocks the caller: start it detached (`void`). Single-flight so a
 * CPU-only Jev host is not saturated by overlapping turns.
 */
export async function runJevShadow(input: JevShadowInput): Promise<void> {
  const scorer = input.scorer ?? scoreMemoryRelevance;
  if (shadowInFlight) {
    logger.debug(
      { group_folder: input.groupFolder },
      'Jev shadow scoring skipped — previous run still in flight',
    );
    return;
  }
  shadowInFlight = true;
  const startedAt = Date.now();
  const logPath =
    input.shadowLogPath === null
      ? null
      : (input.shadowLogPath ?? JEV_SHADOW_LOG_PATH);
  try {
    const cap = Math.max(1, input.maxCandidates ?? JEV_MAX_CANDIDATES);
    const scored = input.candidates.slice(0, cap);
    const { scores, checkpoints } = await scorer(input.request, scored, {
      projectId: input.projectId,
    });
    const agreement = computeJevAgreement(scores, input.judgeSelectedIds);
    const details: Record<string, unknown> = {
      group: input.groupFolder,
      level: input.level,
      candidateCount: input.candidates.length,
      scoredCount: scores.size,
      judgeSelectedIds: input.judgeSelectedIds,
      jev: Object.fromEntries(
        scored
          .filter((candidate) => scores.has(candidate.id))
          .map((candidate) => [
            candidate.id,
            {
              source: candidate.source,
              score: round(scores.get(candidate.id)!),
            },
          ]),
      ),
      checkpoints,
      agreement: {
        ...agreement,
        topKRecall:
          agreement.topKRecall === null ? null : round(agreement.topKRecall),
        auc: agreement.auc === null ? null : round(agreement.auc),
        poolCutAtFullRecall:
          agreement.poolCutAtFullRecall === null
            ? null
            : round(agreement.poolCutAtFullRecall),
      },
    };
    logger.info(
      {
        group_folder: input.groupFolder,
        level: input.level,
        selectionMode: 'jev_shadow',
        candidateCount: input.candidates.length,
        scoredCount: scores.size,
        judgeSelectedIds: input.judgeSelectedIds,
        jev: details.jev,
        checkpoints,
        agreement: details.agreement,
        durationMs: Date.now() - startedAt,
      },
      'Memory capsule Jev shadow scoring completed',
    );
    if (logPath) {
      void appendShadowLogLine(logPath, {
        ts: new Date().toISOString(),
        site: 'memory-capsule',
        status: 'completed',
        question: JEV_QUESTION_VERSION,
        ...details,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    logger.warn(
      {
        err: error,
        group_folder: input.groupFolder,
        level: input.level,
        selectionMode: 'jev_shadow',
        durationMs: Date.now() - startedAt,
      },
      'Memory capsule Jev shadow scoring failed',
    );
    if (logPath) {
      void appendShadowLogLine(logPath, {
        ts: new Date().toISOString(),
        site: 'memory-capsule',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        group: input.groupFolder,
        level: input.level,
        candidateCount: input.candidates.length,
        durationMs: Date.now() - startedAt,
      });
    }
  } finally {
    shadowInFlight = false;
  }
}
