/**
 * Review decision parsing — extracts structured review decisions from agent output.
 */

import { isRecord } from '../../lib/type-guards.js';

export const MAX_REVIEW_NO_PROGRESS = 2;
/** Pipeline-owned `rejection_count` value at the last human retry from Question. */
export const REJECTION_CAP_BASE_KEY = 'rejection_cap_base';

/** Rejections counted against the cap: those since the last human retry. */
export function rejectionsSinceCapBase(
  customValues: Record<string, unknown> | undefined,
  rejectionCount: number,
): { base: number; since: number } {
  const stored = customValues?.[REJECTION_CAP_BASE_KEY];
  const base = typeof stored === 'number' ? stored : 0;
  return { base, since: rejectionCount - base };
}

/**
 * Values for a human retry out of Question: restart the rejection-cap window
 * at the current total and clear the no-progress streak. `rejection_count`
 * itself keeps counting up (routing escalation and events read it).
 */
export function restartRejectionCap(
  customValues: Record<string, string | number> | undefined,
): Record<string, string | number> {
  const count = customValues?.rejection_count;
  return {
    ...(customValues ?? {}),
    [REJECTION_CAP_BASE_KEY]: typeof count === 'number' ? count : 0,
    no_progress_count: 0,
  };
}
/**
 * Automatic recovery-hook runs allowed per task between human triggers. Counted
 * across every runOnEntry queue stage (Question and Failed share one budget).
 */
export const MAX_AUTOMATIC_RECOVERY_RUNS = 2;
export const MAX_REVIEW_FORMAT_RETRIES = 2;

export type ReviewProgress =
  | 'new_issue'
  | 'resolved_issue'
  | 'persistent_issue'
  | 'no_progress'
  | 'ambiguous';
/** One reviewer's verdict inside a multi-reviewer review round. */
export interface ReviewerVerdictSummary {
  reviewer: string;
  /** `null` when the reviewer produced no valid decision. */
  decision: 'approve' | 'reject' | null;
  score: number | null;
  issue_count: number;
  /** Review stage that ran (`review`, `review.o`); absent on older entries. */
  stage_id?: string;
  /** Blocking issues this reviewer raised; only set for a rejecting reviewer. */
  issues?: Array<{ id: string; text: string }>;
}

export interface ReviewHistoryEntry {
  timestamp: string;
  commit: string;
  issues: Array<{ id: string; text: string }>;
  summary: string;
  /**
   * Non-blocking notes from approving reviewers of a rejected multi-reviewer
   * round. Shown to the coder; never part of progress tracking.
   */
  advisory_issues?: Array<{ id: string; text: string }>;
  advisory_summary?: string;
  /** Present when several reviewers judged this commit (task `co_stages`). */
  reviewers?: ReviewerVerdictSummary[];
  /** Review stage that raised `issues` of a single-reviewer round. */
  stage_id?: string;
  /**
   * `approve` marks the record of an approved multi-reviewer round. Rejection
   * consumers (`readReviewHistory`) never see these entries.
   */
  decision?: 'approve';
  comparison?: {
    decision: 'retry' | 'pause';
    progress: ReviewProgress;
    reason: string;
  };
}
export interface RejectionComparison {
  decision: 'retry' | 'pause';
  progress: ReviewProgress;
  resolved_issue_ids: string[];
  persistent_issue_ids: string[];
  new_issue_ids: string[];
  reason: string;
}

export function formatReviewIssue(issue: ReviewIssue): string {
  return `${issue.title}${issue.description ? ` — ${issue.description}` : ''}`;
}

export function formatReviewIssues(issues: ReviewIssue[]): string {
  return issues.map((issue) => `- ${formatReviewIssue(issue)}`).join('\n');
}

export function reviewIssueId(issue: ReviewIssue): string {
  return formatReviewIssue(issue)
    .toLowerCase()
    .replace(/\b(line|lines|column|columns|ln)\s*\d+(?:[-:]\d+)?/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

/** Every stored round, including approved multi-reviewer rounds. */
export function readStoredReviewHistory(
  customValues?: Record<string, string | number>,
): ReviewHistoryEntry[] {
  const raw = customValues?.review_history;
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** The rejected rounds, which drive rework prompts and progress comparison. */
export function readReviewHistory(
  customValues?: Record<string, string | number>,
): ReviewHistoryEntry[] {
  return readStoredReviewHistory(customValues).filter(
    (entry) => entry.decision !== 'approve',
  );
}

const EARLIER_REJECTIONS_MAX_CHARS = 2500;
const EARLIER_ISSUE_MAX_CHARS = 120;
const EARLIER_ISSUES_PER_LINE = 3;
const RECURRING_ISSUES_MAX = 5;

function truncateIssueText(text: string): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > EARLIER_ISSUE_MAX_CHARS
    ? `${flat.slice(0, EARLIER_ISSUE_MAX_CHARS - 1)}…`
    : flat;
}

function formatEarlierRejection(
  entry: ReviewHistoryEntry,
  round: number,
  includeCommit = true,
): string {
  const issues = Array.isArray(entry.issues) ? entry.issues : [];
  const labels = [
    ...(includeCommit
      ? [String(entry.commit ?? '').slice(0, 7) || 'no commit']
      : []),
    ...(entry.comparison?.progress ? [entry.comparison.progress] : []),
  ];
  const shown = issues
    .slice(0, EARLIER_ISSUES_PER_LINE)
    .map((issue) => truncateIssueText(issue.text));
  const more = issues.length - shown.length;
  const issueText =
    shown.length > 0 ? shown.join('; ') : '(no specific issues listed)';
  const label = labels.length > 0 ? ` (${labels.join(', ')})` : '';
  return `- Round ${round}${label}: ${issueText}${more > 0 ? `; +${more} more` : ''}`;
}

/** Issues present in the latest rejection that were also rejected earlier. */
function findRecurringIssues(
  history: ReviewHistoryEntry[],
): Array<{ text: string; rounds: number }> {
  const latest = history[history.length - 1];
  const rounds = new Map<string, number>();
  for (const entry of history) {
    const ids = new Set(
      (Array.isArray(entry.issues) ? entry.issues : []).map((i) => i.id),
    );
    for (const id of ids) rounds.set(id, (rounds.get(id) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const recurring: Array<{ text: string; rounds: number }> = [];
  for (const issue of latest.issues) {
    const count = rounds.get(issue.id) ?? 0;
    if (count < 2 || seen.has(issue.id)) continue;
    seen.add(issue.id);
    recurring.push({ text: truncateIssueText(issue.text), rounds: count });
  }
  // Array.prototype.sort is stable, so ties keep the latest entry's order.
  return recurring
    .sort((a, b) => b.rounds - a.rounds)
    .slice(0, RECURRING_ISSUES_MAX);
}

/**
 * Compact log of rejections before the latest one, bounded to about
 * EARLIER_REJECTIONS_MAX_CHARS. Oldest rounds are dropped first when over budget.
 */
function buildEarlierRejectionsSection(
  history: ReviewHistoryEntry[],
): string | undefined {
  const earlier = history.slice(0, -1);
  if (earlier.length === 0) return undefined;

  const lines = earlier.map((entry, i) => formatEarlierRejection(entry, i + 1));
  const recurring = findRecurringIssues(history);
  const render = (omitted: number): string => {
    const parts = ['## Earlier rejected attempts on this task', ''];
    if (omitted > 0) parts.push(`(${omitted} older rounds omitted)`);
    parts.push(...lines.slice(omitted));
    if (recurring.length > 0) {
      parts.push('');
      let currentRounds = -1;
      for (const issue of recurring) {
        if (issue.rounds !== currentRounds) {
          currentRounds = issue.rounds;
          parts.push(`Recurring issues (seen in ${issue.rounds} rounds):`);
        }
        parts.push(`- ${issue.text}`);
      }
      parts.push(
        '',
        'These recurring issues were not fixed by earlier strategies; they need a materially different approach, not another variation of what was already tried.',
      );
    }
    return parts.join('\n');
  };

  let omitted = 0;
  let section = render(omitted);
  while (
    section.length > EARLIER_REJECTIONS_MAX_CHARS &&
    omitted < lines.length
  ) {
    omitted += 1;
    section = render(omitted);
  }
  return section;
}

/**
 * The rejected rounds as one reviewer may see them, with card-level round
 * numbers. Each reviewer sees only the issues its own stage raised, so the
 * reviewers stay independent opinions. An entry written before per-stage
 * attribution is shown in full only to a reviewer that has no co-reviewers
 * now. The progress label compares the issues of all reviewers, so it stays
 * on rounds a single reviewer judged.
 */
function selectReviewerRounds(
  history: ReviewHistoryEntry[],
  stageId: string,
  hasExtraReviewers: boolean,
): Array<{ entry: ReviewHistoryEntry; round: number }> {
  const rounds: Array<{ entry: ReviewHistoryEntry; round: number }> = [];
  history.forEach((entry, i) => {
    const round = i + 1;
    const reviewers = entry.reviewers ?? [];
    let issues: ReviewHistoryEntry['issues'];
    if (reviewers.some((r) => r.stage_id !== undefined)) {
      issues = reviewers
        .filter((r) => r.stage_id === stageId)
        .flatMap((r) => r.issues ?? []);
    } else if (entry.stage_id !== undefined) {
      issues = entry.stage_id === stageId ? entry.issues : [];
    } else if (!hasExtraReviewers) {
      rounds.push({ entry, round });
      return;
    } else {
      return;
    }
    if (issues.length === 0) return;
    const singleReviewer = reviewers.length <= 1;
    rounds.push({
      entry: {
        ...entry,
        issues,
        comparison: singleReviewer ? entry.comparison : undefined,
      },
      round,
    });
  });
  return rounds;
}

/**
 * Re-review orientation appended to the reviewer's change inventory: one line
 * per rejected round (no commit ids, advisory notes never included) plus the
 * main repository files changed since the last rejected round. The char budget
 * covers only the rounds list — the delta sub-block and framing render outside
 * it, so a large delta cannot push rounds out, and the latest rejected round
 * is never omitted.
 */
function buildPriorRejectedRoundsSection(
  history: ReviewHistoryEntry[],
  delta: string | null,
  baseBranch: string,
  stageId: string,
  hasExtraReviewers: boolean,
): string {
  const lines = selectReviewerRounds(history, stageId, hasExtraReviewers).map(
    ({ entry, round }) => formatEarlierRejection(entry, round, false),
  );
  const deltaBlock =
    delta === null
      ? '(delta unavailable)'
      : delta.trim() === ''
        ? '(no changes since the last rejected round)'
        : delta;
  const renderRounds = (omitted: number): string => {
    const parts = ['## Earlier rejected review rounds', ''];
    if (omitted > 0) parts.push(`(${omitted} older rounds omitted)`, '');
    parts.push(...lines.slice(omitted));
    return parts.join('\n');
  };

  let omitted = 0;
  let rounds = renderRounds(omitted);
  const maxOmitted = Math.max(0, lines.length - 1);
  while (rounds.length > EARLIER_REJECTIONS_MAX_CHARS && omitted < maxOmitted) {
    omitted += 1;
    rounds = renderRounds(omitted);
  }
  return [
    ...(lines.length > 0 ? [rounds, ''] : []),
    'Files changed since the last rejected round:',
    '```',
    deltaBlock,
    '```',
    '',
    'Orientation only. Re-verify each earlier issue against the current files. If one is still present, report it again with the same title. This list is not a checklist: review the whole change against ' +
      `\`${baseBranch}\` as usual, including files not listed here.`,
  ].join('\n');
}

/** Build the implementation-stage handoff after the latest review rejection. */
export function buildReviewReworkPrompt(
  history: ReviewHistoryEntry[],
): string | undefined {
  const latest = history[history.length - 1];
  if (!latest) return undefined;

  const issueLines =
    latest.issues.length > 0
      ? latest.issues.map((issue) => `- ${issue.text}`).join('\n')
      : '- (no specific issues listed)';
  const comparison = latest.comparison
    ? `\n\nComparison decision: ${latest.comparison.decision}\nComparison reason: ${latest.comparison.reason}`
    : '';

  const advisoryLines = (latest.advisory_issues ?? []).map(
    (issue) => `- ${issue.text}`,
  );
  const advisory =
    advisoryLines.length > 0 || latest.advisory_summary
      ? [
          'Non-blocking notes from approving reviewers (fix if cheap; they do not block approval):',
          ...advisoryLines,
          ...(latest.advisory_summary ? [latest.advisory_summary] : []),
        ].join('\n')
      : '';

  const prompt = [
    '## Review feedback to address',
    '',
    'The previous implementation was rejected. Fix the following issues before continuing:',
    issueLines,
    '',
    `Reviewer summary: ${latest.summary}`,
    ...(advisory ? ['', advisory] : []),
    comparison,
    '',
    'Re-check the implementation and tests against this feedback; do not ignore it or repeat the same rejected approach.',
  ].join('\n');

  const earlier = buildEarlierRejectionsSection(history);
  return earlier ? `${prompt}\n\n${earlier}` : prompt;
}

/**
 * A first rejection has no earlier rejection to compare against. Legacy cards
 * with a positive rejection count but no recorded history still need the run.
 */
export function isFirstReviewRejection(
  customValues: Record<string, string | number> | undefined,
  history: ReviewHistoryEntry[],
): boolean {
  const count = customValues?.rejection_count;
  return (count === undefined || count === 0) && history.length === 0;
}

export function buildFirstRejectionComparison(
  current: ReviewDecision,
): RejectionComparison {
  return {
    decision: 'retry',
    progress: 'new_issue',
    resolved_issue_ids: [],
    persistent_issue_ids: [],
    new_issue_ids: current.issues.map(reviewIssueId),
    reason: 'First rejection; nothing to compare.',
  };
}

export function buildReviewComparisonPrompt(
  taskDescription: string,
  commit: string,
  totalRejections: number,
  noProgressCount: number,
  history: ReviewHistoryEntry[],
  current: ReviewDecision,
): string {
  const issues = current.issues.map((issue) => ({
    id: reviewIssueId(issue),
    text: formatReviewIssue(issue),
  }));
  // Advisory notes are non-blocking and must not influence the progress gate.
  const {
    advisory_issues: _currentAdvisoryIssues,
    advisory_summary: _currentAdvisorySummary,
    ...currentBlocking
  } = current;
  const blockingHistory = history.map(
    ({
      advisory_issues: _issues,
      advisory_summary: _summary,
      stage_id: _stageId,
      reviewers,
      ...entry
    }) => ({
      ...entry,
      ...(reviewers
        ? {
            reviewers: reviewers.map(
              ({ stage_id: _s, issues: _i, ...summary }) => summary,
            ),
          }
        : {}),
    }),
  );
  return [
    'You have just rejected a task review. Decide whether another implementation attempt is justified.',
    'This is a comparison gate, not a new code review. Do not invent issues and do not change the task.',
    'Return ONLY JSON: {"decision":"retry|pause","progress":"new_issue|resolved_issue|persistent_issue|no_progress|ambiguous","resolved_issue_ids":[],"persistent_issue_ids":[],"new_issue_ids":[],"reason":"..."}',
    'Retry when an earlier issue was resolved or a genuinely new issue was found. Pause when the same issue keeps recurring without progress or evidence is ambiguous.',
    'Total rejections may exceed five when progress is being made.',
    `Task description:\n${taskDescription}`,
    `Current reviewed commit: ${commit || '(unknown)'}`,
    `Total rejections: ${totalRejections}`,
    `Consecutive no-progress rounds: ${noProgressCount}`,
    `Previous review history:\n${JSON.stringify(blockingHistory)}`,
    `Current rejection:\n${JSON.stringify({ ...currentBlocking, issues })}`,
  ].join('\n\n');
}

/**
 * Bare-JSON scans must stay linear in the output size (an unbalanced `{`
 * otherwise scans to the end of the string per brace, so one large unfenced
 * message can freeze the event loop for minutes). Only the last
 * MAX_BARE_DECISION_TRAILING_CHARS + MAX_BARE_DECISION_OBJECT_CHARS of the
 * output are read, in one forward pass. Accepted trade-off: a bare decision
 * followed by more than 64 KB of trailing text, or larger than 64 KB itself, is
 * no longer found.
 */
const MAX_BARE_DECISION_TRAILING_CHARS = 64 * 1024;
const MAX_BARE_DECISION_OBJECT_CHARS = 64 * 1024;
/** `"decision"` including escaped spellings of the key (`"dec\u0069sion"`). */
const DECISION_NAME_SOURCE = `"${[...'decision']
  .map((letter) => {
    const hex = letter
      .charCodeAt(0)
      .toString(16)
      .replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${letter}|\\\\u00${hex})`;
  })
  .join('')}"`;
const DECISION_KEY_SOURCE = `${DECISION_NAME_SOURCE}\\s*:`;
const DECISION_KEY = new RegExp(DECISION_KEY_SOURCE, 'y');
const DECISION_KEY_ANYWHERE = new RegExp(DECISION_KEY_SOURCE, 'g');
const DECISION_NAME_PRESENT = new RegExp(DECISION_NAME_SOURCE);

/**
 * Cheap pre-check: whether `content` can hold a `"decision"` key (literal or
 * escaped spelling). A valid bare decision always does, so callers can skip
 * `parseReviewDecision` when this is false.
 */
export function mayContainDecisionKey(content: string): boolean {
  return DECISION_NAME_PRESENT.test(content);
}

interface BareObject {
  start: number;
  end: number;
  /** Quote-parity class (index of the stack that matched the braces). */
  parity: 0 | 1;
  /** Candidates directly nested inside this one, in source order. */
  kids: BareObject[];
  ok?: boolean;
}

/**
 * Candidate bare decision objects, newest start first, from ONE forward pass
 * over the scan window, as `{ start, end, value }` (`value` is the parsed JSON,
 * undefined when it is not valid JSON). A `{` is read as if scanning started at
 * it (outside a string), exactly like a per-brace rescan, but without the
 * rescans: the in-string state seen from any start is the parity of unescaped
 * quotes since it, i.e. the global quote parity xor the start's own parity. So
 * braces are matched on two stacks, one per parity class, and prose quotes
 * before a decision can never hide its opening brace. Unclosed braces and
 * stray `}` never abort the pass, so nothing after a decision can hide it.
 *
 * A pair qualifies when it is at most MAX_BARE_DECISION_OBJECT_CHARS long, ends
 * within the trailing cap and directly owns a `"decision":` key (the key's
 * innermost enclosing brace; wrapper objects around it cannot hold a top-level
 * decision, so they are never parsed). Nested candidates would be re-parsed by
 * every enclosing one, so a candidate is parsed with its nested candidates
 * replaced by `0` (each character is parsed once per parity class) and is
 * invalid when any nested candidate is, which is what parsing it whole gives.
 * Only the first candidate that the caller needs is ever parsed.
 */
function* bareDecisionObjects(
  output: string,
): Generator<{ start: number; end: number; value: unknown }> {
  const windowStart = Math.max(
    0,
    output.length -
      MAX_BARE_DECISION_TRAILING_CHARS -
      MAX_BARE_DECISION_OBJECT_CHARS,
  );
  DECISION_KEY_ANYWHERE.lastIndex = windowStart;
  if (!DECISION_KEY_ANYWHERE.test(output)) return;
  const stacks: [number[], number[]] = [[], []];
  const owners = new Set<number>();
  const found: BareObject[] = [];
  let parity: 0 | 1 = 0;
  let backslashes = 0;
  for (let i = windowStart; i < output.length; i++) {
    const character = output[i];
    if (character === '\\') {
      backslashes++;
      continue;
    }
    const escaped = backslashes % 2 === 1;
    backslashes = 0;
    if (character === '"') {
      if (escaped) continue;
      const owner = stacks[parity][stacks[parity].length - 1];
      if (owner !== undefined) {
        DECISION_KEY.lastIndex = i;
        if (DECISION_KEY.test(output)) owners.add(owner);
      }
      parity = parity === 0 ? 1 : 0;
    } else if (character === '{') stacks[parity].push(i);
    else if (character === '}' && stacks[parity].length) {
      const start = stacks[parity].pop() as number;
      const end = i + 1;
      if (
        owners.has(start) &&
        end - start <= MAX_BARE_DECISION_OBJECT_CHARS &&
        output.length - end <= MAX_BARE_DECISION_TRAILING_CHARS
      )
        found.push({ start, end, parity, kids: [] });
    }
  }
  // Within a parity class pairs are properly nested or disjoint.
  found.sort((a, b) => a.start - b.start);
  const open: [BareObject[], BareObject[]] = [[], []];
  for (const object of found) {
    const stack = open[object.parity];
    while (stack.length && stack[stack.length - 1].end <= object.start)
      stack.pop();
    stack[stack.length - 1]?.kids.push(object);
    stack.push(object);
  }
  for (let i = found.length - 1; i >= 0; i--) {
    const object = found[i];
    let text = '';
    let at = object.start;
    for (const kid of object.kids) {
      text += `${output.slice(at, kid.start)}0`;
      at = kid.end;
    }
    text += output.slice(at, object.end);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    object.ok = value !== undefined && object.kids.every((kid) => kid.ok);
    yield {
      start: object.start,
      end: object.end,
      value: object.ok ? value : undefined,
    };
  }
}

function toRejectionComparison(parsed: unknown): RejectionComparison | null {
  if (!isRecord(parsed)) return null;
  if (
    (parsed.decision !== 'retry' && parsed.decision !== 'pause') ||
    ![
      'new_issue',
      'resolved_issue',
      'persistent_issue',
      'no_progress',
      'ambiguous',
    ].includes(String(parsed.progress))
  )
    return null;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    decision: parsed.decision,
    progress: parsed.progress as ReviewProgress,
    resolved_issue_ids: strings(parsed.resolved_issue_ids),
    persistent_issue_ids: strings(parsed.persistent_issue_ids),
    new_issue_ids: strings(parsed.new_issue_ids),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

export function parseReviewComparison(
  output: string,
): RejectionComparison | null {
  const fenced: string[] = [];
  const fence = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(output))) fenced.push(match[1]);
  if (fenced.length) {
    for (const raw of fenced.reverse()) {
      try {
        const comparison = toRejectionComparison(JSON.parse(raw));
        if (comparison) return comparison;
      } catch {
        /* continue */
      }
    }
    return null;
  }
  // Bare JSON: every balanced-brace object is a candidate (braces inside
  // the reason string or in trailing prose must not hide the verdict).
  for (const { value } of bareDecisionObjects(output)) {
    const comparison = toRejectionComparison(value);
    if (comparison) return comparison;
  }
  return null;
}

/**
 * When re-entering the review stage from another stage (e.g. active after a
 * rejection), do not resume the prior review agent session — it will re-emit a
 * stale verdict without re-running git. Only resume when the interrupted run
 * was already in the review stage.
 */
export function shouldStartFreshReviewSession(
  enteringReview: boolean,
  liveSessionStage: string | null,
  targetStatus: string,
): boolean {
  return enteringReview && liveSessionStage !== targetStatus;
}

/** Extra re-review context appended to the review worker's change inventory. */
export interface ReReviewContext {
  /** Rejected review rounds, oldest first. Only their `issues` are shown, filtered per reviewer. */
  history: ReviewHistoryEntry[];
  /**
   * Formatted `diff --numstat` lines between the last rejected round and the
   * current head (main repository only). `null` when the delta could not be
   * computed; empty when nothing changed since that round.
   */
  delta: string | null;
  /** Review stage id of the run being started (`review`, `review.o`). */
  stageId: string;
  /** Whether this review round has reviewers besides the one being started. */
  hasExtraReviewers: boolean;
}

/** Prefixed onto the review worker prompt with a content-only diff summary. */
export function buildReviewGitContextBlock(
  baseBranch: string,
  diffStat: string,
  reReview?: ReReviewContext,
): string {
  const block = [
    '## Current change inventory',
    '',
    'The block below is a snapshot for orientation only. Re-read the current files',
    'and re-run the content diff before every verdict; never assume this snapshot',
    'or a prior review is still valid. CarapaBoard alone tracks repository identity.',
    'Do not inspect or reason about repository identity or history.',
    '',
    `Change inventory against \`${baseBranch}\`:`,
    '```',
    diffStat.trim() || '(no changes vs base)',
    '```',
    '',
    'Do **not** reject with "diff unchanged" or repeat a prior review without',
    're-verifying each issue against the current file contents.',
  ].join('\n');
  if (!reReview || reReview.history.length === 0) return block;
  return `${block}\n\n${buildPriorRejectedRoundsSection(reReview.history, reReview.delta, baseBranch, reReview.stageId, reReview.hasExtraReviewers)}`;
}

export interface ReviewIssue {
  title: string;
  description: string;
}

export interface ReviewDecision {
  decision: 'approve' | 'reject';
  score: number;
  issues: ReviewIssue[];
  summary: string;
  /** Approving reviewers' notes on a rejected chain round; non-blocking. */
  advisory_issues?: ReviewIssue[];
  advisory_summary?: string;
}

export interface ReviewDecisionParseResult {
  decision: ReviewDecision | null;
  output: string;
  repairAttempts: number;
  runId?: string;
}

/** Verdict JSON schema shared by the final-answer block and the repair prompt. */
const REVIEW_DECISION_SCHEMA = [
  '{',
  '  "decision": "approve" | "reject",',
  '  "score": 1-10,',
  '  "issues": [{"title": "short imperative title", "description": "specific actionable description"}],',
  '  "summary": "one sentence"',
  '}',
].join('\n');

/**
 * Restate the verdict contract at the very end of a review run's user prompt,
 * where the reviewer is most likely to follow it.
 */
export function appendReviewVerdictFormatBlock(prompt: string): string {
  return [
    prompt,
    [
      'Final answer format: reply with exactly one JSON code block matching this schema; no prose outside it.',
      '```json',
      REVIEW_DECISION_SCHEMA,
      '```',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * Ask a reviewer to repair an unstructured verdict without silently treating
 * prose as approval. The task context is included so a fresh-session fallback
 * can still perform the review rather than guessing from the invalid response.
 */
export function buildReviewFormatRepairPrompt(
  taskContext: string,
  invalidOutput: string,
  attempt: number,
): string {
  const priorExcerpt = invalidOutput.slice(-8_000);
  return [
    `Your previous review response could not be parsed (format repair ${attempt}/${MAX_REVIEW_FORMAT_RETRIES}).`,
    'Return exactly one JSON object and no surrounding prose or Markdown fence.',
    'Do not implement or modify the task. If you did not actually review the current code, perform the review now before deciding.',
    'The object must match this schema:',
    REVIEW_DECISION_SCHEMA,
    'Omit issues or use an empty array for a clean approval. Approval issues are non-blocking findings. A rejection must include at least one actionable issue; all rejection issues are blocking.',
    `Task context:\n${taskContext}`,
    `Previous invalid response:\n${priorExcerpt || '(empty response)'}`,
  ].join('\n\n');
}

export async function parseReviewDecisionWithRepair(
  initialOutput: string,
  taskContext: string,
  repair: (
    prompt: string,
    attempt: number,
  ) => Promise<string | { output: string; runId: string }>,
  maxAttempts = MAX_REVIEW_FORMAT_RETRIES,
  initialRunId?: string,
): Promise<ReviewDecisionParseResult> {
  let output = initialOutput;
  let decision = parseReviewDecision(output);
  let repairAttempts = 0;
  let runId = initialRunId;

  while (!decision && repairAttempts < maxAttempts) {
    repairAttempts += 1;
    const repaired = await repair(
      buildReviewFormatRepairPrompt(taskContext, output, repairAttempts),
      repairAttempts,
    );
    if (typeof repaired === 'string') {
      output = repaired;
    } else {
      output = repaired.output;
      runId = repaired.runId;
    }
    decision = parseReviewDecision(output);
  }

  return { decision, output, repairAttempts, runId };
}

/**
 * Validate and normalize a parsed JSON value into a ReviewDecision.
 * Returns null when the value is not a valid decision payload.
 */
function normalizeIssue(value: unknown): ReviewIssue | null {
  if (typeof value === 'string') {
    const title = value.trim();
    return title ? { title, description: '' } : null;
  }
  if (!isRecord(value)) return null;

  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  return {
    title: value.title.trim(),
    description:
      typeof value.description === 'string' ? value.description.trim() : '',
  };
}

function normalizeIssues(value: unknown): ReviewIssue[] {
  return Array.isArray(value)
    ? value
        .map((entry) => normalizeIssue(entry))
        .filter((entry): entry is ReviewIssue => entry !== null)
    : [];
}

function selectIssues(sources: unknown[]): ReviewIssue[] {
  // Prefer the first non-empty source. This keeps canonical findings
  // authoritative while allowing old approvals with `issues: []` and
  // populated `minor_issues` to retain their polish lifecycle.
  for (const source of sources) {
    const issues = normalizeIssues(source);
    if (issues.length > 0) return issues;
  }
  return [];
}

function validateDecision(parsed: unknown): ReviewDecision | null {
  if (!isRecord(parsed)) return null;
  if (parsed.decision !== 'approve' && parsed.decision !== 'reject')
    return null;
  if (typeof parsed.score !== 'number') return null;

  const findingSources = [
    parsed.issues,
    parsed.blocking_issues,
    parsed.minor_issues,
    parsed.suggestions,
  ];
  const issues = selectIssues(findingSources);
  const hasFindingEntries = findingSources.some(
    (source) => Array.isArray(source) && source.length > 0,
  );
  if (issues.length === 0 && hasFindingEntries) return null;
  if (parsed.decision === 'reject' && issues.length === 0) return null;

  return {
    decision: parsed.decision,
    score: parsed.score,
    issues,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

/**
 * Parse the decision stored as `pending_review_decision`. Unlike a reviewer's
 * own output it can carry the `advisory_*` fields of a compounded chain
 * verdict, which `parseReviewDecision` does not read.
 */
export function parsePendingReviewDecision(
  stored: string,
): ReviewDecision | null {
  const decision = parseReviewDecision(stored);
  if (!decision || decision.decision !== 'reject') return decision;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return decision;
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const advisoryIssues = selectIssues([obj.advisory_issues]);
  return {
    ...decision,
    ...(advisoryIssues.length > 0 ? { advisory_issues: advisoryIssues } : {}),
    ...(typeof obj.advisory_summary === 'string' && obj.advisory_summary
      ? { advisory_summary: obj.advisory_summary }
      : {}),
  };
}

/**
 * Scan text for the last balanced top-level `{...}` substring that parses as
 * JSON and contains a `decision` field. Robust to surrounding prose/tool-call
 * text. Returns null when nothing matches.
 */
function parseBareJsonDecision(output: string): ReviewDecision | null {
  // Scan candidate balanced-brace substrings from newest to oldest.
  for (const { start, end, value } of bareDecisionObjects(output)) {
    if (value === undefined) {
      if (output.slice(start, end).includes('"decision"')) return null;
      continue;
    }
    if (
      !isRecord(value) ||
      !Object.prototype.hasOwnProperty.call(value, 'decision')
    )
      continue;
    return validateDecision(value);
  }
  return null;
}

/**
 * Scan agent output for a structured ReviewDecision. When JSON fences are
 * present, the last fence is the reviewer's final verdict and is authoritative
 * even when invalid. Bare JSON is accepted only when no JSON fence exists.
 */
export function parseReviewDecision(output: string): ReviewDecision | null {
  const fenceRe = /```json\s*\n([\s\S]*?)```/g;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    lastMatch = m[1];
  }
  if (lastMatch !== null) {
    try {
      return validateDecision(JSON.parse(lastMatch.trim()));
    } catch {
      return null;
    }
  }
  // Fallback: accept a bare trailing JSON object only when no JSON fence exists.
  return parseBareJsonDecision(output);
}
