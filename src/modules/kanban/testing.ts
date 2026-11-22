import { findBalancedJsonEnd } from './decision-json.js';
import { isRecord } from '../../lib/type-guards.js';

export const MAX_TESTING_FORMAT_RETRIES = 2;

/** Verdict a testing-stage run recorded: the stage outcome, not the process outcome. */
export type TestingRunDecision = 'pass' | 'fail' | 'blocked';

export interface TestingDecision {
  decision: TestingRunDecision;
  issues: string[];
  summary: string;
}

export interface TestingDecisionParseResult {
  decision: TestingDecision | null;
  output: string;
  repairAttempts: number;
}

const MAX_TESTING_RECOVERY_EVIDENCE_CHARS = 16_000;
const MAX_TESTING_RECOVERY_TOOL_CHARS = 12_000;
const MAX_TESTING_RECOVERY_STREAM_CHARS = 3_000;
const MAX_TESTING_RECOVERY_COMMAND_CHARS = 500;

function testingToolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text =
        part && typeof part === 'object'
          ? (part as { text?: unknown }).text
          : undefined;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Preserve bounded validation evidence when the tester loses its model connection. */
export function buildTestingTransportRecoveryOutput(
  rawTranscript: string | undefined,
  streamedOutput: string,
  transportError: string,
): string {
  let latestToolEvidence = '';
  // V1 `outputDelta` is incremental, so an unfinished call's evidence is the
  // concatenation of its deltas. Only the tail can reach the output.
  const partialOutputByCall = new Map<string, string>();
  for (const line of (rawTranscript ?? '').split('\n')) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        id?: unknown;
        status?: unknown;
        name?: unknown;
        input?: { command?: unknown } | null;
        output?: unknown;
        outputDelta?: unknown;
      };
      if (event.type !== 'tool_call') continue;
      const finished =
        event.status === 'completed' || event.status === 'failed';
      if (!finished && event.status !== 'in_progress') continue;
      const callId = typeof event.id === 'string' ? event.id : '';
      let text = testingToolResultText(
        finished ? event.output : event.outputDelta,
      );
      if (!finished && text) {
        text = `${partialOutputByCall.get(callId) ?? ''}${text}`.slice(
          -MAX_TESTING_RECOVERY_TOOL_CHARS,
        );
        partialOutputByCall.set(callId, text);
      }
      if (!text) continue;
      const tool = typeof event.name === 'string' ? event.name : 'tool';
      // Bound the header so the evidence section always fits under
      // MAX_TESTING_RECOVERY_EVIDENCE_CHARS and the final cap, which keeps only
      // the end, can never cut off the tool-result marker.
      const rawCommand =
        typeof event.input?.command === 'string' ? event.input.command : '';
      const command = rawCommand
        ? ` ${
            rawCommand.length <= MAX_TESTING_RECOVERY_COMMAND_CHARS
              ? rawCommand
              : `${rawCommand.slice(0, MAX_TESTING_RECOVERY_COMMAND_CHARS)}…`
          }`
        : '';
      // Blockquote every line so parseTestingDecision treats the evidence as
      // tool output, never as a tester-written verdict. Defuse HTML comment
      // openers so recovered output cannot inject its own carapa-tool markers
      // that would override the single result marker added below.
      const quote = (value: string) =>
        value
          .replaceAll('<!--', '<\\!--')
          .split('\n')
          .map((evidenceLine) => `> ${evidenceLine}`)
          .join('\n');
      let quotedText = quote(text);
      if (quotedText.length > MAX_TESTING_RECOVERY_TOOL_CHARS) {
        const tail = quotedText.slice(-MAX_TESTING_RECOVERY_TOOL_CHARS);
        const firstLineBreak = tail.indexOf('\n');
        quotedText = `> […older tool output truncated…]\n${
          firstLineBreak === -1 ? `> ${tail}` : tail.slice(firstLineBreak + 1)
        }`;
      }
      latestToolEvidence = `${quote(`${tool}${command}:`)}\n${quotedText}`;
    } catch {
      // Ignore malformed or truncated JSONL lines and keep the latest valid evidence.
    }
  }

  const trimmedStreamedOutput = streamedOutput.trim();
  if (!latestToolEvidence && !trimmedStreamedOutput) return '';

  const sections = [
    'The testing model connection failed after validation tools produced output.',
    `Transport error: ${transportError || '(unknown transport error)'}`,
    trimmedStreamedOutput
      ? `Captured testing output:\n${trimmedStreamedOutput.slice(-MAX_TESTING_RECOVERY_STREAM_CHARS)}`
      : '',
    latestToolEvidence
      ? `Latest validation tool evidence:\n<!-- carapa-tool:result -->\n${latestToolEvidence}`
      : '',
  ].filter(Boolean);
  const combined = sections.join('\n\n');
  return combined.length <= MAX_TESTING_RECOVERY_EVIDENCE_CHARS
    ? combined
    : `[…older recovery evidence truncated…]\n${combined.slice(-MAX_TESTING_RECOVERY_EVIDENCE_CHARS)}`;
}

/**
 * Re-entering testing after implementation changed the worktree must start a
 * new tester session. Resuming the prior testing session can make the model
 * repeat its old verdict without executing validation against the new HEAD.
 * Only an interrupted run whose live session is already in this same testing
 * stage may resume.
 */
export function shouldStartFreshTestingSession(
  enteringTesting: boolean,
  liveSessionStage: string | null,
  targetStatus: string,
): boolean {
  return enteringTesting && liveSessionStage !== targetStatus;
}

function validateTestingDecision(value: unknown): TestingDecision | null {
  if (!isRecord(value)) return null;
  if (!['pass', 'fail', 'blocked'].includes(String(value.decision)))
    return null;
  if (!Array.isArray(value.issues)) return null;
  const issues = value.issues.map(normalizeTestingIssue);
  if (issues.some((issue) => issue === null)) return null;
  if (value.decision !== 'pass' && issues.length === 0) return null;
  const summary =
    typeof value.summary === 'string' && value.summary.trim()
      ? value.summary
      : ((issues[0] as string | undefined) ?? `testing ${value.decision}`);
  return {
    decision: value.decision as TestingDecision['decision'],
    issues: issues as string[],
    summary,
  };
}

function normalizeTestingIssue(issue: unknown): string | null {
  if (typeof issue === 'string') return issue;
  if (!isRecord(issue)) return null;

  const firstString = (...keys: string[]): string => {
    for (const key of keys) {
      if (typeof issue[key] === 'string' && issue[key].trim()) {
        return issue[key].trim();
      }
    }
    return '';
  };
  const title = firstString('title', 'group', 'name');
  const severity = firstString('severity');
  const details = firstString('description', 'details', 'evidence', 'message');
  const heading = severity
    ? title
      ? `${title} (${severity})`
      : severity
    : title;

  if (heading && details) return `${heading}: ${details}`;
  return heading || details || null;
}

interface TestingDecisionMatch {
  decision: TestingDecision;
  start: number;
  end: number;
}

function isToolEvidence(output: string, start: number): boolean {
  const lineStart = output.lastIndexOf('\n', start - 1) + 1;
  const previousLineEnd = lineStart - 1;
  const previousLineStart =
    previousLineEnd >= 0
      ? output.lastIndexOf('\n', previousLineEnd - 1) + 1
      : 0;
  const previousLine =
    previousLineEnd >= 0
      ? output.slice(previousLineStart, previousLineEnd)
      : '';
  const currentLinePrefix = output.slice(lineStart, start);
  const standalonePreviousLine =
    /^(?:>\s*)?\*{0,2}(?:Bash output|tool[_ ](?:output|result|use))\*{2}\s*$/i.test(
      previousLine.trim(),
    );
  const toolOutputHeader =
    /^(?:>\s*)?\*{0,2}(?:Bash output|tool[_ ](?:output|result|use))\*{2}\s+`[^`]*`\s*$/i.test(
      previousLine.trim(),
    );
  const inlineToolPrefix =
    /\*{0,2}(?:Bash output|tool[_ ](?:output|result|use))\*{2}\s*\S/i.test(
      currentLinePrefix,
    );
  const markedPrefix = output.slice(0, start);
  const lastToolMarker = (kind: 'request' | '(?:result|error)') =>
    [
      ...markedPrefix.matchAll(
        new RegExp(
          `<!--\\s*carapa-tool:${kind}(?:\\s+tool-id="[^"]+")?\\s*-->`,
          'g',
        ),
      ),
    ].at(-1);
  const toolResultMatch = lastToolMarker('(?:result|error)');
  const toolRequestMatch = lastToolMarker('request');
  const toolResultMarker = toolResultMatch?.index ?? -1;
  const toolRequestMarker = toolRequestMatch?.index ?? -1;
  const toolBodyPrefix = output.slice(
    toolResultMarker + (toolResultMatch?.[0].length ?? 0),
    start,
  );
  const directMarkedToolBody =
    toolResultMarker > toolRequestMarker &&
    /^\s*(?:>\s*)?$/.test(toolBodyPrefix);
  const blockquotedToolResult =
    directMarkedToolBody ||
    (toolResultMarker > toolRequestMarker &&
      output.slice(lineStart, start).trimStart().startsWith('>'));
  return (
    standalonePreviousLine ||
    toolOutputHeader ||
    inlineToolPrefix ||
    blockquotedToolResult
  );
}
// Tolerates one known model quirk: a single stray `]` between the final
// string's closing quote and the closing `}` of the verdict object.
function parseTestingDecisionJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (error) {
    if (!/"\s*\]\s*\}$/.test(candidate)) throw error;
    return JSON.parse(candidate.replace(/\](\s*\})$/, '$1'));
  }
}

/** True when a verdict-shaped object encloses the object at [start, end). */
function isInsideVerdictPayload(
  output: string,
  start: number,
  end: number,
): boolean {
  for (let j = start - 1; j >= 0; j--) {
    if (output[j] !== '{') continue;
    const parentEnd = findBalancedJsonEnd(output, j);
    if (parentEnd === null || parentEnd < end) continue;
    try {
      if (
        isTestingDecisionPayload(
          parseTestingDecisionJson(output.slice(j, parentEnd)),
        )
      ) {
        return true;
      }
    } catch {
      // Not parseable JSON, so it cannot own this object as a verdict.
    }
  }
  return false;
}

/**
 * Returns the last top-level bare verdict, `invalid` when that final
 * verdict-shaped object fails validation, or null when there is none.
 */
function findJsonDecision(
  output: string,
  ignoredRanges: ReadonlyArray<readonly [number, number]> = [],
): TestingDecisionMatch | { invalid: true; start: number } | null {
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i] !== '{') continue;
    if (ignoredRanges.some(([from, to]) => i >= from && i < to)) continue;
    const end = findBalancedJsonEnd(output, i);
    if (end === null) continue;
    try {
      const parsed = parseTestingDecisionJson(output.slice(i, end));
      const decision = validateTestingDecision(parsed);
      // The last top-level verdict-shaped object is the tester's final
      // answer; an invalid one must not fall through to an earlier verdict,
      // and a nested object never overrides its enclosing verdict.
      if (!isTestingDecisionPayload(parsed)) continue;
      if (isToolEvidence(output, i)) continue;
      if (isInsideVerdictPayload(output, i, end)) continue;
      return decision
        ? { decision, start: i, end }
        : { invalid: true, start: i };
    } catch {
      // Keep scanning for an earlier structured verdict.
    }
  }
  return null;
}

function findParsedTestingDecisionMatch(
  output: string,
): TestingDecisionMatch | null {
  const fence = /```json\s*\n([\s\S]*?)```/g;
  const toolFences: Array<[number, number]> = [];
  let lastFence: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(output)) !== null) {
    if (isToolEvidence(output, match.index)) {
      toolFences.push([match.index, match.index + match[0].length]);
    } else {
      lastFence = match;
    }
  }
  let fenced: TestingDecisionMatch | null = null;
  if (lastFence) {
    try {
      const decision = validateTestingDecision(JSON.parse(lastFence[1].trim()));
      if (decision) {
        fenced = {
          decision,
          start: lastFence.index,
          end: lastFence.index + lastFence[0].length,
        };
      }
    } catch {
      // Fall through to the bare-object search.
    }
  }
  const bare = findJsonDecision(output, toolFences);
  if (bare && 'invalid' in bare) {
    // An invalid final verdict after the fence must not leave the earlier
    // fenced verdict standing.
    return fenced && bare.start < fenced.end ? fenced : null;
  }
  if (!fenced || !bare) return fenced ?? bare;
  // The object inside the fence is also a bare candidate, so a bare match
  // only wins when it starts after the whole fence.
  return bare.start < fenced.end ? fenced : bare;
}

export function parseTestingDecision(output: string): TestingDecision | null {
  return findParsedTestingDecisionMatch(output)?.decision ?? null;
}

/** Return true for JSON objects shaped as the machine-consumed verdict payload. */
function isTestingDecisionPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  // A decision is specific to the board-owned verdict protocol even when the
  // model omitted both companion fields. Without decision, require two schema
  // keys so ordinary JSON containing a generic summary remains visible.
  return (
    keys.includes('decision') ||
    (keys.includes('issues') && keys.includes('summary'))
  );
}

function isTestingDecisionPayloadText(value: string): boolean {
  try {
    return isTestingDecisionPayload(JSON.parse(value));
  } catch {
    return hasTestingDecisionKeys(value);
  }
}

function shouldShowTestingCandidate(
  output: string,
  candidate: string,
  start: number,
): boolean {
  return (
    !isTestingDecisionPayloadText(candidate) || isToolEvidence(output, start)
  );
}

function findSchemaTargetedDecision(
  output: string,
): Pick<TestingDecisionMatch, 'start' | 'end'> | null {
  let lastMatch: Pick<TestingDecisionMatch, 'start' | 'end'> | null = null;
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== '{') continue;
    const end = findBalancedJsonEnd(output, i);
    if (end !== null) {
      if (
        isTestingDecisionPayloadText(output.slice(i, end)) &&
        !isToolEvidence(output, i)
      ) {
        lastMatch = { start: i, end };
      }
      continue;
    }
    if (hasTestingDecisionKeys(output.slice(i)) && !isToolEvidence(output, i)) {
      const keyPattern = /"(?:decision|issues|summary)"\s*:/g;
      let lastKeyEnd = i;
      let keyMatch: RegExpExecArray | null;
      while ((keyMatch = keyPattern.exec(output.slice(i))) !== null) {
        lastKeyEnd = i + keyMatch.index;
      }
      const lineEnd = output.indexOf('\n', lastKeyEnd);
      lastMatch = {
        start: i,
        end: lineEnd === -1 ? output.length : lineEnd,
      };
    }
  }
  return lastMatch;
}

function hasTestingDecisionKeys(value: string): boolean {
  const keys = new Set(
    [...value.matchAll(/"(decision|issues|summary)"\s*:/g)].map(
      (match) => match[1],
    ),
  );
  return keys.has('decision') || keys.size >= 2;
}

/**
 * Incrementally filter a tester text stream before it reaches task_output.
 * Each JSON object is classified independently so tool JSON and a later
 * machine verdict may safely share one transport chunk.
 */
export class TestingOutputStreamFilter {
  private output = '';
  private cursor = 0;

  push(content: string): string {
    this.output += content;
    return this.readVisible(false);
  }

  finish(): string {
    return this.readVisible(true);
  }

  private readVisible(final: boolean): string {
    let visible = '';
    while (this.cursor < this.output.length) {
      const fenceStart = this.output.indexOf('```json', this.cursor);
      const objectStart = this.output.indexOf('{', this.cursor);
      const candidateStart =
        fenceStart !== -1 && (objectStart === -1 || fenceStart < objectStart)
          ? fenceStart
          : objectStart;
      if (candidateStart === -1) {
        visible += this.output.slice(this.cursor);
        this.cursor = this.output.length;
        break;
      }

      visible += this.output.slice(this.cursor, candidateStart);
      // Consume the emitted prefix even when the candidate needs more chunks.
      this.cursor = candidateStart;
      if (candidateStart === fenceStart) {
        const fenceEndMarker = this.output.indexOf('```', fenceStart + 7);
        if (fenceEndMarker === -1 && !final) break;
        const fenceEnd =
          fenceEndMarker === -1 ? this.output.length : fenceEndMarker + 3;
        const candidate = this.output.slice(fenceStart, fenceEnd);
        const bodyStart = candidate.indexOf('{');
        const absoluteBodyStart =
          bodyStart === -1 ? fenceStart : fenceStart + bodyStart;
        if (
          shouldShowTestingCandidate(this.output, candidate, absoluteBodyStart)
        ) {
          visible += candidate;
        }
        this.cursor = fenceEnd;
        continue;
      }

      const objectEnd = findBalancedJsonEnd(this.output, objectStart);
      if (objectEnd === null) {
        if (final) {
          const candidate = this.output.slice(objectStart);
          if (shouldShowTestingCandidate(this.output, candidate, objectStart)) {
            visible += candidate;
          }
          this.cursor = this.output.length;
        }
        break;
      }
      const candidate = this.output.slice(objectStart, objectEnd);
      if (shouldShowTestingCandidate(this.output, candidate, objectStart)) {
        visible += candidate;
      }
      this.cursor = objectEnd;
    }
    return visible;
  }
}

function findTestingDecisionToStrip(
  output: string,
): Pick<TestingDecisionMatch, 'start' | 'end'> | null {
  return (
    findParsedTestingDecisionMatch(output) ?? findSchemaTargetedDecision(output)
  );
}

function removeTestingDecision(
  output: string,
  selected: Pick<TestingDecisionMatch, 'start' | 'end'>,
): string {
  let { start, end } = selected;
  const fence = /```json\s*\n([\s\S]*?)(```|$)/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fence.exec(output)) !== null) {
    const fenceEnd = fenceMatch.index + fenceMatch[0].length;
    if (start >= fenceMatch.index && start < fenceEnd) {
      start = fenceMatch.index;
      end = fenceEnd;
    }
  }
  return `${output.slice(0, start)}${output.slice(end)}`;
}

/** Remove every non-tool schema candidate from accumulated stopped output. */
export function stripAllTestingDecisions(output: string): string {
  let filtered = output;
  let selected = findTestingDecisionToStrip(filtered);
  while (selected) {
    filtered = removeTestingDecision(filtered, selected);
    selected = findTestingDecisionToStrip(filtered);
  }
  return filtered.trim();
}

export function buildTestingFormatRepairPrompt(
  invalidOutput: string,
  attempt: number,
): string {
  return [
    `Your previous testing verdict could not be parsed (format repair ${attempt}/${MAX_TESTING_FORMAT_RETRIES}).`,
    'Do not run validation or use tools. Only reformat the completed findings below into the required schema.',
    'Do not edit files or call update_task. Return exactly one JSON object with no Markdown fence or prose:',
    '{"decision":"pass","issues":[],"summary":"required validation completed successfully"}',
    'Set decision to exactly pass, fail, or blocked.',
    'The issues field must be an array of plain strings, never objects. Use an empty issues array only for pass. Use fail for a reproducible validation failure and blocked when validation could not reach a result.',
    `Previous invalid response:\n${invalidOutput || '(empty response)'}`,
  ].join('\n\n');
}

function buildTestingFormatRepairFallbackPrompt(
  taskContext: string,
  invalidOutput: string,
  attempt: number,
): string {
  return [
    buildTestingFormatRepairPrompt(invalidOutput, attempt),
    `Task context:\n${taskContext}`,
  ].join('\n\n');
}

export async function parseTestingDecisionWithRepair(
  initialOutput: string,
  taskContext: string,
  repair: (
    prompt: string,
    fallbackPrompt: string,
    attempt: number,
  ) => Promise<string>,
  maxAttempts = MAX_TESTING_FORMAT_RETRIES,
): Promise<TestingDecisionParseResult> {
  let output = initialOutput;
  let decision = parseTestingDecision(output);
  let repairAttempts = 0;
  while (!decision && repairAttempts < maxAttempts) {
    repairAttempts++;
    output = await repair(
      buildTestingFormatRepairPrompt(output, repairAttempts),
      buildTestingFormatRepairFallbackPrompt(
        taskContext,
        output,
        repairAttempts,
      ),
      repairAttempts,
    );
    decision = parseTestingDecision(output);
  }
  return { decision, output, repairAttempts };
}
