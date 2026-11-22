/**
 * Classification of the free-text `error` recorded when a task enters the
 * project's failed stage. The result is stored in `custom_values` so get_task
 * and the UI can show a stable class plus a short, cleaned reason.
 */

import { isRecord } from '../../lib/type-guards.js';

const FAILURE_CLASSES = [
  'agent_error',
  'infra_transient',
  'timeout',
  'config',
  'deploy',
  'testing_failed',
  'review_cap',
  'user',
  'unknown',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FAILURE_REASON_MAX_LENGTH = 300;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function classify(error: string): FailureClass {
  const text = error.trim();
  if (!text) return 'unknown';
  if (text.startsWith('⚠️ Configuration error')) return 'config';
  if (/^Deploy\s/.test(text)) return 'deploy';
  if (/^Timed out/i.test(text)) return 'timeout';
  if (
    /^Interrupted:/.test(text) ||
    /^Retry/.test(text) ||
    text.startsWith('Transient error retries exhausted') ||
    /server restarted/i.test(text)
  ) {
    return 'infra_transient';
  }
  return 'agent_error';
}

function isJsonProtocolLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

/**
 * Remove a leading block that echoes the complete task description.
 * Requires the remainder to be empty or begin on a new line so any inline
 * continuation (e.g. "Deploy ...", path suffixes, or DNS names) is kept intact.
 */
function stripEchoedPrompt(text: string, description?: string | null): string {
  const prompt = description?.trim().replace(/\r\n/g, '\n');
  if (!prompt) return text;
  const body = text.trimStart();
  if (!body.startsWith(prompt)) return text;
  const rest = body.slice(prompt.length);
  return rest.length === 0 || rest.startsWith('\n') || rest.startsWith('\r')
    ? rest
    : text;
}

function cleanReason(error: string, description?: string | null): string {
  const lines = error.replace(ANSI_PATTERN, '').split(/\r?\n/);
  let remainderLines: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const slice = lines.slice(i).join('\n');
    const stripped = stripEchoedPrompt(slice, description);
    if (stripped !== slice) {
      // Filter JSON protocol records only on complete original lines, never on
      // an inline fragment exposed by removing a leading echo on that line.
      const [firstFragment, ...trailingLines] = stripped.split('\n');
      remainderLines = [
        firstFragment,
        ...trailingLines.filter((trailing) => !isJsonProtocolLine(trailing)),
      ];
      break;
    }
    if (!isJsonProtocolLine(line)) break;
  }

  const keptLines =
    remainderLines ?? lines.filter((line) => !isJsonProtocolLine(line));

  const collapsed = keptLines.join('\n').replace(/\s+/g, ' ').trim();
  return collapsed.length > FAILURE_REASON_MAX_LENGTH
    ? `${collapsed.slice(0, FAILURE_REASON_MAX_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

/**
 * Derive `failure_class` and a bounded `failure_reason` from a task's error
 * text. `failure_reason` is always non-empty and at most 300 characters.
 * `taskDescription`, when known, lets the cleaner drop an echoed prompt.
 */
export function classifyTaskFailure(
  error: string | null | undefined,
  source?: 'user',
  taskDescription?: string | null,
): { failure_class: FailureClass; failure_reason: string } {
  const failureClass: FailureClass =
    source === 'user' ? 'user' : classify(error ?? '');
  const reason = cleanReason(error ?? '', taskDescription);
  return {
    failure_class: failureClass,
    failure_reason: reason || `No error text captured (${failureClass})`,
  };
}
