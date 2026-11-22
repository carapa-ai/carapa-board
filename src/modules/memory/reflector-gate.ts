import { sha256Hex } from '../../lib/hash.js';
import {
  JEV_SHADOW_LOG_PATH,
  JEV_URL,
  MEMORY_REFLECTOR_GATE,
} from '../../config.js';
import { isProbability, jevSystemOne } from '../../lib/jev-client.js';
import { logger, serializeError } from '../../logger.js';
import { appendShadowLogLine } from './jev-relevance.js';

/**
 * Observe-only Jev scoring of reflector transcript chunks. Each chunk of an
 * automatic live reflector run is scored concurrently with its LLM call and
 * one record is appended to the shared shadow log (`site: 'reflector-gate'`)
 * so the scores can later be compared with what the LLM actually wrote. It
 * never skips, delays, retries or fails a chunk, and never logs transcript
 * text. A record may carry the group-relative transcript path and the first
 * and last message ids of the chunk (`transcriptPath`, `firstMessageId`,
 * `lastMessageId`) so a disagreement can be re-read from the transcript.
 *
 * `failureReason` is present only on records of failed chunks (the chunk's try
 * block threw) and holds a category string only, never error or transcript
 * text: `tool_error:<tool>:<kind>` (`<tool>` is a reflector tool name or
 * `unknown`; `<kind>` is `evidence|date|input|version|other`), `no_completion`,
 * `lease_lost` or `llm_error`.
 */

/** Tag logged with every record: scores are only comparable within one version. */
const REFLECTOR_GATE_QUESTION_VERSION = 'reflector-gate-v1';

const GATE_QUESTIONS = {
  durable: {
    type: 'noul',
    instructions:
      'Does the conversation state a decision, a preference, a constraint, a commitment or a verified outcome?',
    criteria: {
      true: 'A decision, preference, constraint, commitment or verified outcome is stated',
      false: 'None of these is stated',
    },
  },
  correction: {
    type: 'noul',
    instructions:
      'Does the user correct, retract or end a fact that was stated earlier?',
    criteria: {
      true: 'The user corrects, retracts or ends a previously stated fact',
      false: 'No earlier fact is corrected, retracted or ended',
    },
  },
  erasure: {
    type: 'noul',
    instructions: 'Does the user ask to forget or delete something?',
    criteria: {
      true: 'The user asks to forget or delete something',
      false: 'The user does not ask to forget or delete anything',
    },
  },
} as const;

type GateQuestion = keyof typeof GATE_QUESTIONS;
const GATE_QUESTION_NAMES = Object.keys(GATE_QUESTIONS) as GateQuestion[];

// Whole-word (or stem) matches for explicit erasure requests in en / de / ro.
// `\b` is ASCII-only, so letter boundaries use Unicode lookarounds.
const ERASURE_KEYWORDS = [
  'forget(?:s|ting)?',
  'forgot',
  'delete[ds]?',
  'deleting',
  'erase[ds]?',
  'vergiss\\p{L}*',
  'vergessen',
  'lösch\\p{L}*',
  'loesch\\p{L}*',
  'uit[ăa](?!-te)',
  'uita[țt]i',
  '[șş]terge\\p{L}*',
  '[șş]tergi',
  '[șş]ter[șş]i',
];
const ERASURE_KEYWORD_PATTERN = new RegExp(
  `(?<!\\p{L})(?:${ERASURE_KEYWORDS.join('|')})(?!\\p{L})`,
  'iu',
);

/** Deterministic check for an explicit erasure request in the chunk text. */
function hasErasureKeyword(text: string): boolean {
  return ERASURE_KEYWORD_PATTERN.test(text);
}

export interface ReflectorGateChunk {
  text: string;
  index: number;
  /** Group-relative transcript path the chunk was read from. */
  transcriptPath?: string;
  firstMessageId?: string;
  lastMessageId?: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export interface ReflectorGateOptions {
  groupFolder: string;
  runId: string;
  fetchImpl?: typeof fetch;
  /** Override the shadow JSONL log path; `null` disables file logging. */
  shadowLogPath?: string | null;
}

/** Optional additive measurements of the chunk's LLM call; unknown fields are omitted. */
interface ReflectorGateChunkStats {
  /** Wall time of the chunk's LLM call. */
  llmDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Transcript message count in the chunk. */
  chunkMessages?: number;
}

export interface ReflectorGateScore {
  /**
   * Await the Jev result and append the log record. Never throws. `operationCount`
   * is the chunk's completed memory-operation count, or `null` if its LLM call failed.
   * `failureReason` is a bounded category set only when the chunk failed.
   * `model` (the reflector runtime) and `stats` are logged when known, for
   * successful and failed chunks alike.
   */
  finish(
    operationCount: number | null,
    failureReason?: string,
    model?: string,
    stats?: ReflectorGateChunkStats,
  ): Promise<void>;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

type GateOutcome =
  | { status: 'completed'; scores: Record<GateQuestion, number> }
  | { status: 'failed'; error: string };

/** Whether reflector chunks of this run should be shadow-scored. */
export function reflectorGateEnabled(run: {
  mode: string;
  explicitReview?: boolean;
}): boolean {
  return (
    MEMORY_REFLECTOR_GATE === 'shadow' &&
    Boolean(JEV_URL) &&
    run.mode === 'live' &&
    !run.explicitReview
  );
}

/**
 * Start scoring a chunk immediately and return a handle to finish it once the
 * chunk's LLM outcome is known. The Jev call can never reject.
 */
export function startReflectorGateScore(
  chunk: ReflectorGateChunk,
  options: ReflectorGateOptions,
): ReflectorGateScore {
  const startedAt = Date.now();
  const outcome: Promise<GateOutcome & { latencyMs: number }> = jevSystemOne({
    state: chunk.text,
    questions: GATE_QUESTIONS,
    fetchImpl: options.fetchImpl,
    projectId: options.groupFolder,
  }).then(
    (result) => {
      const scores = {} as Record<GateQuestion, number>;
      for (const name of GATE_QUESTION_NAMES) {
        const value = result.answers[name]?.noul;
        if (!isProbability(value)) {
          return {
            status: 'failed' as const,
            error: `Jev returned no noul score for "${name}"`,
            latencyMs: Date.now() - startedAt,
          };
        }
        scores[name] = round(value);
      }
      return {
        status: 'completed' as const,
        scores,
        latencyMs: Date.now() - startedAt,
      };
    },
    (error: unknown) => ({
      status: 'failed' as const,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    }),
  );

  return {
    async finish(operationCount, failureReason, model, stats) {
      try {
        const result = await outcome;
        if (result.status === 'failed') {
          logger.warn(
            {
              group_folder: options.groupFolder,
              runId: options.runId,
              chunk: chunk.index,
              error: result.error,
            },
            'Reflector gate Jev shadow scoring failed',
          );
        }
        const logPath =
          options.shadowLogPath === null
            ? null
            : (options.shadowLogPath ?? JEV_SHADOW_LOG_PATH);
        if (!logPath) return;
        await appendShadowLogLine(logPath, {
          ts: new Date().toISOString(),
          site: 'reflector-gate',
          status: result.status,
          question: REFLECTOR_GATE_QUESTION_VERSION,
          group: options.groupFolder,
          runId: options.runId,
          chunkIndex: chunk.index,
          chunkHash: sha256Hex(chunk.text),
          ...(isNonEmptyString(chunk.transcriptPath)
            ? { transcriptPath: chunk.transcriptPath }
            : {}),
          ...(isNonEmptyString(chunk.firstMessageId)
            ? { firstMessageId: chunk.firstMessageId }
            : {}),
          ...(isNonEmptyString(chunk.lastMessageId)
            ? { lastMessageId: chunk.lastMessageId }
            : {}),
          chunkChars: chunk.text.length,
          ...(result.status === 'completed' ? { scores: result.scores } : {}),
          erasureKeyword: hasErasureKeyword(chunk.text),
          operationCount,
          ...(failureReason ? { failureReason } : {}),
          ...(model ? { model } : {}),
          ...(isCount(stats?.llmDurationMs)
            ? { llmDurationMs: stats.llmDurationMs }
            : {}),
          ...(isCount(stats?.promptTokens)
            ? { promptTokens: stats.promptTokens }
            : {}),
          ...(isCount(stats?.completionTokens)
            ? { completionTokens: stats.completionTokens }
            : {}),
          ...(isCount(stats?.chunkMessages)
            ? { chunkMessages: stats.chunkMessages }
            : {}),
          jevLatencyMs: result.latencyMs,
        });
      } catch (error) {
        logger.debug(
          { err: serializeError(error) },
          'Reflector gate shadow record failed',
        );
      }
    },
  };
}
