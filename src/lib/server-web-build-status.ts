import { canStartBackgroundWork, getInFlight } from './background-work-gate.js';
import { scrubSecretText } from '../logger.js';

type ServerWebBuildStatus = 'idle' | 'building' | 'ready' | 'failed';

export type ServerWebBuildState = {
  status: ServerWebBuildStatus;
  error?: string;
  /** Tail of the failed build's output (only while status is 'failed'). */
  output?: string;
  /** Automatic background LLM work is not starting new jobs. */
  backgroundPaused: boolean;
  /** A restart is waiting for in-flight background jobs and direct chat turns. */
  restartPending: boolean;
  /** In-flight background jobs and direct chat turns by label (only labels with work). */
  waitingOn: Record<string, number>;
};

let state: { status: ServerWebBuildStatus; error?: string; output?: string } = {
  status: 'idle',
};
let restartPending = false;

export function getServerWebBuildStatus(): ServerWebBuildState {
  return {
    ...state,
    backgroundPaused: !canStartBackgroundWork(),
    restartPending,
    waitingOn: getInFlight(),
  };
}

export function isServerWebRestartPending(): boolean {
  return restartPending;
}

export function setServerWebRestartPending(pending: boolean): void {
  restartPending = pending;
}

export function markServerWebBuildBuilding(): ServerWebBuildState {
  state = { status: 'building' };
  return getServerWebBuildStatus();
}

export function markServerWebBuildReady(): ServerWebBuildState {
  state = { status: 'ready' };
  return getServerWebBuildStatus();
}

const SERVER_WEB_BUILD_OUTPUT_LIMIT = 20_000;

/** Maximum number of failing lines reported for a failed server & web build. */
export const BUILD_FAILURE_LINE_LIMIT = 40;
/** Maximum length of a single reported failing line. */
export const BUILD_FAILURE_LINE_CHARS = 300;
/** Maximum length of the joined reported failing lines. */
export const BUILD_FAILURE_TOTAL_CHARS = 6_000;

/** Lines that usually carry the actual reason a build step failed. */
const BUILD_FAILURE_LINE_PATTERN =
  /\(fail\)|\berror\b|\bERROR\b|\bFAIL(ED)?\b|✗|failed to solve|exit code/i;

/**
 * Failing lines of a build log, for readers that cannot open the raw output.
 *
 * Docker BuildKit interleaves parallel stages, so the tail of a log is often
 * mostly other stages' lines. This keeps the lines that look like a failure
 * plus the last few lines of the log, then bounds the result so it can be
 * shown to a caller.
 *
 * The whole log is secret-scrubbed before it is split and before the per-line
 * bound is applied, so multi-line secrets are redacted and a redaction that
 * lengthens a line cannot push the result past its caps.
 */
export function extractBuildFailureLines(output: string): string[] {
  if (!output) return [];
  // Scrub the whole log before splitting: multi-line secrets (PEM blocks)
  // never match a rule once the log is cut into single lines.
  const lines = scrubSecretText(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const selected = new Set<number>();
  lines.forEach((line, index) => {
    if (BUILD_FAILURE_LINE_PATTERN.test(line)) selected.add(index);
  });
  // The last lines of the log carry the build system's own verdict, so they
  // are always kept, even when they do not look like a failure.
  for (
    let index = Math.max(lines.length - 5, 0);
    index < lines.length;
    index++
  ) {
    selected.add(index);
  }

  const bounded = [...selected]
    .sort((left, right) => left - right)
    .slice(-BUILD_FAILURE_LINE_LIMIT)
    .map((index) => lines[index].slice(0, BUILD_FAILURE_LINE_CHARS));
  const kept: string[] = [];
  let total = 0;
  for (let index = bounded.length - 1; index >= 0; index--) {
    const line = bounded[index];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > BUILD_FAILURE_TOTAL_CHARS) break;
    total += cost;
    kept.unshift(line);
  }
  return kept;
}

export function markServerWebBuildFailed(
  error: string,
  output?: string,
): ServerWebBuildState {
  const tail = output?.slice(-SERVER_WEB_BUILD_OUTPUT_LIMIT);
  state = { status: 'failed', error, ...(tail ? { output: tail } : {}) };
  return getServerWebBuildStatus();
}
