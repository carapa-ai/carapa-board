import type { TaskMessage } from '@/types';

/** Historical task messages above this size are expensive to Markdown-parse. */
export const DEFERRED_TASK_MESSAGE_CHARS = 128 * 1024;

/** Soft byte target for the older-output window retained in the browser. */
export const PAGED_OLDER_CONTENT_LIMIT = 1024 * 1024;

/**
 * Newest-tail page size used when a run-less oversized message has no
 * server-provided output page. Matches the byte page the loader requests.
 */
export const TASK_OUTPUT_TAIL_PAGE_BYTES = 32768;

export interface TaskOutputWindowEntry {
  id: string;
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface TaskOutputGap {
  startOffset: number;
  endOffset: number;
}

export interface TaskOutputWindow {
  entries: TaskOutputWindowEntry[];
  totalEndOffset: number;
}

function entryBytes(entry: TaskOutputWindowEntry): number {
  return new TextEncoder().encode(entry.content).byteLength;
}

function validWindowEntry(entry: TaskOutputWindowEntry): boolean {
  return (
    !!entry.id &&
    entry.startOffset >= 0 &&
    entry.endOffset >= entry.startOffset &&
    entry.endOffset - entry.startOffset === entryBytes(entry)
  );
}

export function createTaskOutputWindow(
  entries: TaskOutputWindowEntry[],
  totalEndOffset = entries.at(-1)?.endOffset ?? 0,
): TaskOutputWindow {
  const byId = new Map<string, TaskOutputWindowEntry>();
  for (const entry of entries) {
    if (validWindowEntry(entry)) byId.set(entry.id, { ...entry });
  }
  const ordered = [...byId.values()].sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  return {
    entries: ordered,
    totalEndOffset: Math.max(totalEndOffset, ordered.at(-1)?.endOffset ?? 0),
  };
}

export function taskOutputWindowGaps(
  window: TaskOutputWindow,
): TaskOutputGap[] {
  const gaps: TaskOutputGap[] = [];
  let cursor = 0;
  for (const entry of window.entries) {
    if (entry.startOffset > cursor)
      gaps.push({ startOffset: cursor, endOffset: entry.startOffset });
    cursor = Math.max(cursor, entry.endOffset);
  }
  if (window.totalEndOffset > cursor)
    gaps.push({ startOffset: cursor, endOffset: window.totalEndOffset });
  return gaps;
}

export function mergeTaskOutputWindow(
  current: TaskOutputWindow,
  incomingEntries: TaskOutputWindowEntry[],
  options: {
    direction: 'older' | 'newer';
    totalEndOffset?: number;
    targetBytes?: number;
  },
): TaskOutputWindow {
  const incoming = createTaskOutputWindow(incomingEntries).entries;
  if (incoming.length === 0)
    return {
      ...current,
      totalEndOffset: Math.max(
        current.totalEndOffset,
        options.totalEndOffset ?? 0,
      ),
    };

  const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  const all = [...byId.values()].sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  const requiredIds = new Set(incoming.map((entry) => entry.id));
  // The newest semantic entry is the live/completion handoff anchor. Keep it
  // beside an older requested page even when the soft target is crossed.
  const newest = all.at(-1);
  if (newest) requiredIds.add(newest.id);

  const target = options.targetBytes ?? PAGED_OLDER_CONTENT_LIMIT;
  const retained = new Set<string>(requiredIds);
  let retainedBytes = all
    .filter((entry) => retained.has(entry.id))
    .reduce((sum, entry) => sum + entryBytes(entry), 0);
  const requiredEntries = all.filter((entry) => requiredIds.has(entry.id));
  const requiredStart = requiredEntries[0]?.startOffset ?? 0;
  const requiredEnd = requiredEntries.at(-1)?.endOffset ?? requiredStart;
  const candidates = all
    .filter((entry) => !retained.has(entry.id))
    .sort((left, right) => {
      const leftDistance =
        left.endOffset <= requiredStart
          ? requiredStart - left.endOffset
          : left.startOffset >= requiredEnd
            ? left.startOffset - requiredEnd
            : 0;
      const rightDistance =
        right.endOffset <= requiredStart
          ? requiredStart - right.endOffset
          : right.startOffset >= requiredEnd
            ? right.startOffset - requiredEnd
            : 0;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return options.direction === 'older'
        ? left.startOffset - right.startOffset
        : right.startOffset - left.startOffset;
    });
  for (const entry of candidates) {
    const size = entryBytes(entry);
    if (retainedBytes > 0 && retainedBytes + size > target) {
      // A whole entry larger than the nominal window remains the retained
      // unit while a small live continuation is appended after it.
      if (!(size >= target && retained.size === requiredIds.size)) continue;
    }
    retained.add(entry.id);
    retainedBytes += size;
  }

  return createTaskOutputWindow(
    all.filter((entry) => retained.has(entry.id)),
    Math.max(
      current.totalEndOffset,
      options.totalEndOffset ?? 0,
      all.at(-1)?.endOffset ?? 0,
    ),
  );
}

/**
 * Rendered output is split into chunks keyed by the absolute byte offset
 * bucket of each entry. Loading an older page or appending a live entry then
 * changes only the chunks it touches, so unchanged chunks can skip Markdown
 * parsing instead of re-parsing the whole retained window.
 */
const TASK_OUTPUT_RENDER_CHUNK_BYTES = 64 * 1024;

export interface TaskOutputRenderChunk {
  key: string;
  content: string;
}

export function taskOutputWindowChunks(
  window: TaskOutputWindow,
  chunkBytes = TASK_OUTPUT_RENDER_CHUNK_BYTES,
): TaskOutputRenderChunk[] {
  const gaps = taskOutputWindowGaps(window);
  const chunks: TaskOutputRenderChunk[] = [];
  let hasContent = false;
  const append = (key: string, text: string) => {
    if (!text) return;
    const last = chunks.at(-1);
    if (last?.key === key) last.content += text;
    else chunks.push({ key, content: text });
    hasContent = true;
  };
  const appendMarker = (key: string) =>
    append(
      key,
      `${hasContent ? '\n\n' : ''}> [Output omitted from the bounded window]\n\n`,
    );
  for (const entry of window.entries) {
    const key = `chunk:${Math.floor(entry.startOffset / chunkBytes)}`;
    for (const gap of gaps) {
      if (gap.endOffset === entry.startOffset) appendMarker(key);
    }
    append(key, entry.content);
  }
  const lastEnd = window.entries.at(-1)?.endOffset ?? 0;
  if (gaps.some((gap) => gap.startOffset === lastEnd))
    appendMarker(chunks.at(-1)?.key ?? 'chunk:tail');
  return chunks;
}

export function shouldDeferTaskMessage(content: string): boolean {
  return content.length > DEFERRED_TASK_MESSAGE_CHARS;
}

function utf8CharLength(leadByte: number): number {
  if (leadByte < 0x80) return 1;
  if (leadByte < 0xe0) return 2;
  if (leadByte < 0xf0) return 3;
  return 4;
}

/**
 * Decode bytes[start, end) cut back to UTF-8 character boundaries.
 * Offsets in the result are relative to the start of `bytes`.
 */
function utf8SafeSlice(
  bytes: Uint8Array,
  start: number,
  end: number,
): { content: string; startOffset: number; endOffset: number } {
  const cap = Math.min(Math.max(0, end), bytes.length);
  let safeStart = Math.min(Math.max(0, start), bytes.length);
  while (
    safeStart < cap &&
    (bytes[safeStart] as number) >= 0x80 &&
    (bytes[safeStart] as number) < 0xc0
  ) {
    safeStart += 1;
  }
  // Advance from the safe start over whole characters only, so the end can
  // never land in the middle of a multi-byte sequence.
  let safeEnd = safeStart;
  while (safeEnd < cap) {
    const length = utf8CharLength(bytes[safeEnd] as number);
    if (safeEnd + length > cap) break;
    safeEnd += length;
  }
  return {
    // ignoreBOM keeps a leading U+FEFF in the slice; the default decoder
    // strips it and the slice would no longer match its byte offsets.
    content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      bytes.slice(safeStart, safeEnd),
    ),
    startOffset: safeStart,
    endOffset: safeEnd,
  };
}

/**
 * Seed a bounded output window with only the newest tail of an oversized
 * run-less message (one that arrived with no server-provided output page).
 * Returns null when the content is small enough to render whole, so callers
 * keep their existing behaviour for those rows.
 *
 * `content` must be the raw stored message content, because the server pages
 * raw bytes. The tail is cut at a UTF-8 character boundary and its offsets are
 * byte offsets inside the message, so the uncovered prefix [baseOffset,
 * tailStart) surfaces as a gap that the existing "Load earlier output"
 * button pages through `/output?messageId=…&beforeOffset=`.
 */
export function seedTaskOutputTailWindow(
  entryId: string,
  content: string,
  baseOffset = 0,
): { entries: TaskOutputWindowEntry[]; totalEndOffset: number } | null {
  if (!shouldDeferTaskMessage(content)) return null;
  const bytes = new TextEncoder().encode(content);
  const slice = utf8SafeSlice(
    bytes,
    Math.max(0, bytes.byteLength - TASK_OUTPUT_TAIL_PAGE_BYTES),
    bytes.byteLength,
  );
  const totalEndOffset = baseOffset + bytes.byteLength;
  return {
    entries: [
      {
        id: entryId,
        content: slice.content,
        startOffset: baseOffset + slice.startOffset,
        endOffset: totalEndOffset,
      },
    ],
    totalEndOffset,
  };
}

/**
 * Clip an older output page entry to the gap it was requested for.
 *
 * A run-less message query answers with the whole message as a single
 * entry, which would otherwise replace the seeded tail (same entry id) and
 * push megabytes back into the renderer. The clip keeps at most the page
 * size ending at the gap, cut at UTF-8 boundaries, under a distinct id so
 * the seeded tail survives the merge. Entries that already fit the gap are
 * returned unchanged, preserving existing run-based paging behaviour.
 * Returns null when the entry contributes nothing to the gap.
 */
export function clipTaskOutputPageEntryToGap(
  entry: TaskOutputWindowEntry,
  gap: TaskOutputGap,
): TaskOutputWindowEntry | null {
  const clipEndWanted = Math.min(entry.endOffset, gap.endOffset);
  const clipStartWanted = Math.max(
    entry.startOffset,
    gap.endOffset - TASK_OUTPUT_TAIL_PAGE_BYTES,
  );
  if (clipStartWanted >= clipEndWanted) return null;
  if (
    clipStartWanted === entry.startOffset &&
    clipEndWanted === entry.endOffset
  ) {
    return entry;
  }
  const slice = utf8SafeSlice(
    new TextEncoder().encode(entry.content),
    clipStartWanted - entry.startOffset,
    clipEndWanted - entry.startOffset,
  );
  if (slice.startOffset >= slice.endOffset) return null;
  const startOffset = entry.startOffset + slice.startOffset;
  return {
    id: `${entry.id}:${startOffset}`,
    content: slice.content,
    startOffset,
    endOffset: entry.startOffset + slice.endOffset,
  };
}

interface RenderableTaskMessage {
  role: string;
  content: string;
  entry_type?: string;
}

/** Structural delivery receipts are audit metadata, not chat content. */
export function isHiddenTaskMessage(message: RenderableTaskMessage): boolean {
  return (
    message.entry_type === 'stage_prompt_delivery' ||
    message.entry_type === 'steering_request' ||
    message.entry_type === 'steering_assignment' ||
    message.entry_type === 'steering_delivery' ||
    message.entry_type === 'stage_handoff_request' ||
    message.entry_type === 'stage_handoff_delivery'
  );
}

/** True when the whole content is a structured testing verdict payload. */
function isTestingVerdictPayload(content: string): boolean {
  const trimmed = content
    .trim()
    .replace(/^```json\s*\n/, '')
    .replace(/\n```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      ['pass', 'fail', 'blocked'].includes(String(parsed.decision)) &&
      Array.isArray(parsed.issues) &&
      typeof parsed.summary === 'string'
    );
  } catch {
    return false;
  }
}

/** True when the whole content is a parsed review verdict payload. */
export function isReviewVerdictPayload(content: string): boolean {
  const trimmed = content
    .trim()
    .replace(/^```json\s*\n/, '')
    .replace(/\n```$/, '')
    .trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      ['approve', 'reject'].includes(String(parsed.decision)) &&
      typeof parsed.score === 'number'
    );
  } catch {
    return false;
  }
}

export type ReviewVerdictTone = 'approve' | 'reject' | 'neutral';

const REVIEW_APPROVED_HEADING =
  /^\*\*Review (?:approved|accepted with nits)\*\* \(score: /;
const REVIEW_REJECTED_HEADING = /^\*\*Review rejected\*\* \(score: /;
const REVIEW_COMPARISON_HEADING = /^\*\*Review comparison\*\* — (\w+):/;
const REVIEW_COMPARISON_FAILED_HEADING = /^\*\*Review comparison failed\*\*/;

/**
 * Tone of the formatted review verdict card, so approvals and rejections stand
 * apart from the neutral system notes. Other review notices (paused, merge
 * pending) keep the neutral look. A 'neutral' tone renders an assistant-role
 * message as the amber system note.
 */
export function reviewVerdictTone(
  message: RenderableTaskMessage,
): ReviewVerdictTone | undefined {
  const content = message.content.trimStart();
  if (message.role === 'assistant' && REVIEW_APPROVED_HEADING.test(content))
    return 'approve';
  if (message.role === 'system' && REVIEW_REJECTED_HEADING.test(content))
    return 'reject';
  if (message.role === 'assistant') {
    // The comparison after a rejection either retries (neutral note) or
    // parks the card for manual resolution (red, like the rejection itself).
    if (REVIEW_COMPARISON_FAILED_HEADING.test(content)) return 'reject';
    const comparison = REVIEW_COMPARISON_HEADING.exec(content);
    if (comparison) return comparison[1] === 'pause' ? 'reject' : 'neutral';
  }
  return undefined;
}

export interface TaskVerdictSummary {
  /** Message id of the formatted verdict notice in the transcript. */
  id: string;
  kind: 'review' | 'testing';
  outcome: 'approved' | 'rejected' | 'passed' | 'failed' | 'blocked';
  /** Review score out of 10; null for testing verdicts. */
  score: number | null;
  /** Rejection round of a rejected review, when the notice carries it. */
  round: number | null;
  summary: string;
  issues: string[];
  created_at: string;
}

const VERDICT_HEADING =
  /^\*\*(Review (approved|accepted with nits|rejected)|Testing (passed|failed|blocked))\*\*(?: \(score: (\d+(?:\.\d+)?)\/10(?:, rejection (\d+))?\))?/;
const VERDICT_ISSUES_HEADING = /^\*\*(?:Non-blocking issues|Issues):\*\*$/;

/**
 * Review and testing verdicts found in the loaded transcript, oldest first,
 * parsed from the formatted notices the pipeline writes (heading, summary and
 * an issue list). Repeated identical verdicts, such as a tester's JSON-only
 * response followed by its formatted notice, collapse into one.
 */
export function extractTaskVerdicts(
  messages: Array<RenderableTaskMessage & { id: string; created_at: string }>,
): TaskVerdictSummary[] {
  const out: TaskVerdictSummary[] = [];
  for (const message of messages) {
    if (message.role === 'user') continue;
    const content = message.content.trimStart();
    const match = VERDICT_HEADING.exec(content);
    if (!match) continue;
    const blocks = content
      .slice(match[0].length)
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    const issuesAt = blocks.findIndex((block) =>
      VERDICT_ISSUES_HEADING.test(block.split('\n')[0]),
    );
    const issues =
      issuesAt >= 0
        ? blocks
            .slice(issuesAt)
            .join('\n')
            .split('\n')
            .slice(1)
            .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
            .filter(Boolean)
        : [];
    const kind = match[1].startsWith('Review') ? 'review' : 'testing';
    const verdict: TaskVerdictSummary = {
      id: message.id,
      kind,
      outcome:
        kind === 'review'
          ? match[2] === 'rejected'
            ? 'rejected'
            : 'approved'
          : (match[3] as 'passed' | 'failed' | 'blocked'),
      score: match[4] != null ? Number(match[4]) : null,
      round: match[5] != null ? Number(match[5]) : null,
      summary: (issuesAt >= 0 ? blocks.slice(0, issuesAt) : blocks.slice(0, 1))
        .join(' ')
        .trim(),
      issues,
      created_at: message.created_at,
    };
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.kind === verdict.kind &&
      previous.outcome === verdict.outcome &&
      previous.summary === verdict.summary
    ) {
      continue;
    }
    out.push(verdict);
  }
  return out;
}

/**
 * Blank output entries that are only a raw testing or review verdict. The
 * transcript keeps the verdict; the formatted notice renders it. Byte offsets
 * are preserved, so no bounded-window gap marker is introduced.
 */
export function hideTestingVerdictOutputEntries(
  window: TaskOutputWindow,
): TaskOutputWindow {
  return {
    ...window,
    entries: window.entries.map((entry) =>
      isTestingVerdictPayload(entry.content) ||
      isReviewVerdictPayload(entry.content)
        ? { ...entry, content: '' }
        : entry,
    ),
  };
}

/** Internal format-repair runs historically wrote adjacent divider markers. */
export function isSupersededRunDivider(
  messages: RenderableTaskMessage[],
  index: number,
): boolean {
  return (
    messages[index]?.entry_type === 'run_start' &&
    index > 0 &&
    messages[index - 1]?.entry_type === 'run_start'
  );
}

/** Hide legacy prompts assembled from testing feedback and already-shown replies. */
export function isDuplicateTestingFollowUp(
  messages: RenderableTaskMessage[],
  index: number,
): boolean {
  const current = messages[index];
  if (!current || current.role !== 'user') return false;

  let lastAssistantIndex = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  const promptParts = messages
    .slice(lastAssistantIndex + 1, index)
    .filter(
      (message) =>
        message.role === 'user' || message.entry_type === 'testing_feedback',
    );
  return (
    promptParts.some((message) => message.entry_type === 'testing_feedback') &&
    promptParts.some((message) => message.role === 'user') &&
    current.content.trim() ===
      promptParts
        .map((message) => message.content)
        .join('\n\n')
        .trim()
  );
}

/**
 * Sentinel string written by the backend when a user stops a run.
 * `flushStoppedTranscript` appends an assistant chat_message with this
 * trailing-period form; the stop handler sets `task.error` to the
 * no-period form. Both mark the same event; the UI renders it once,
 * inline at the chronological stop position, instead of also showing
 * the bottom error banner (which would duplicate it after any
 * follow-up prompt).
 */
export const STOPPED_BY_USER_MSG = 'Stopped by user.';

function normalizedTranscriptContent(content: string): string {
  // Persisted formatter entries may introduce a boundary newline where the
  // live parser appended adjacent chunks. Whitespace is presentation-only for
  // this ownership check; punctuation and all non-whitespace content remain.
  return content.replace(/\s+/g, '');
}

/**
 * A finished refetch can still return an intermediate transcript snapshot.
 * Only hand off when the loaded assistant entries account for the complete
 * retained stream. The comparison is deliberately directional: a persisted
 * prefix of a longer live response is not a replacement for that response.
 */
function transcriptEntriesCoverStream(
  currentStreaming: string,
  messages: TaskMessage[],
): boolean {
  const live = normalizedTranscriptContent(currentStreaming);
  if (!live) return true;

  const persisted = normalizedTranscriptContent(
    messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          message.content !== STOPPED_BY_USER_MSG &&
          !!message.content.trim(),
      )
      .map((message) => message.content)
      .join('\n'),
  );

  // The owned stream is the latest response, so it must reconcile against the
  // persisted assistant tail. A matching older response elsewhere on the page
  // is not evidence that the current run's final output has arrived.
  return !!persisted && persisted.endsWith(live);
}

/**
 * Testing deliberately removes the machine-readable verdict from the saved
 * assistant transcript and persists a formatted system outcome instead. That
 * outcome is therefore the canonical end marker even when earlier validation
 * prose from the same run was saved as an assistant message.
 */
function hasCanonicalTestingOutcome(messages: TaskMessage[]): boolean {
  return messages.some(
    (message) =>
      (message.entry_type === 'testing_feedback' ||
        message.entry_type === 'system_notice') &&
      message.content.trimStart().startsWith('**Testing '),
  );
}

/**
 * Decide whether a task's live streaming bubble can retire in favor of the
 * persisted transcript. A run-owned stream retires only after the refetch
 * for that exact run has settled AND the run's transcript segment accounts
 * for the stream; while the task is still running the fallback must remain
 * visible so in-flight output is never hidden.
 */
export function streamAlreadySaved(
  currentStreaming: string,
  messages: TaskMessage[],
  isRunning: boolean,
  streamRunId?: string,
  transcriptReadyRunId?: string,
): boolean {
  if (!currentStreaming) return true;

  if (streamRunId) {
    // Exact run ownership is authoritative. In particular, run_finished makes
    // the task idle before its message refetch resolves; allowing the legacy
    // idle heuristic below to inspect an already-fetched intermediate entry
    // would hide later live output during that gap. Retire only after the
    // matching run's refetch has settled and its transcript segment exists.
    if (transcriptReadyRunId !== streamRunId) return false;

    // The canonical final answer is intentionally independent from the live
    // display stream, which can contain megabytes of tool calls and results.
    // An exact-run result marker is therefore authoritative even when its
    // text does not cover or resemble the retained live stream.
    if (
      messages.some(
        (message) =>
          message.entry_type === 'run_result' &&
          message.run_id === streamRunId &&
          message.role === 'assistant' &&
          !!message.content.trim(),
      )
    ) {
      return true;
    }

    const runStart = messages.findIndex(
      (message) =>
        message.entry_type === 'run_start' && message.run_id === streamRunId,
    );
    if (runStart < 0) {
      // Transcript pagination is turn-based, so a long interactive run can
      // push its run_start marker out of the newest loaded page while keeping
      // that run's later assistant/tool entries visible. The exact finish +
      // settled-refetch identity proves which live run finished, but not that
      // a paginated/stale response contains that run's final output. Require
      // the loaded tail to cover the retained stream before handing off.
      return transcriptEntriesCoverStream(currentStreaming, messages);
    }

    const nextRunStart = messages.findIndex(
      (message, index) =>
        index > runStart && message.entry_type === 'run_start',
    );
    const runEnd = nextRunStart >= 0 ? nextRunStart : messages.length;
    const segment = messages.slice(runStart + 1, runEnd);
    if (transcriptEntriesCoverStream(currentStreaming, segment)) return true;
    if (hasCanonicalTestingOutcome(segment)) return true;
    // The pipeline can intentionally discard a run's raw output: format
    // repair retries persist only the corrected response plus a system
    // notice, never the invalid attempt. Once the settled refetch for this
    // exact run shows a segment with no assistant content, the stream can
    // never be reconciled — retire the live fallback instead of leaving it
    // pinned at the bottom of the chat, after every later run.
    return !segment.some(
      (message) => message.role === 'assistant' && !!message.content.trim(),
    );
  }

  // Persisted assistant/tool entries can be intermediate checkpoints. While
  // this run still owns the live stream, textual similarity alone is not proof
  // that the response has finished and must not hide the updating fallback.
  if (isRunning) return false;

  // A completed run can be persisted as several transcript entries (for
  // example text + tool calls), while streamingOutput contains the whole
  // accumulated run. In that case no single saved message contains the live
  // string, so the content comparison below cannot detect the hand-off and
  // both versions remain visible. Once the task is idle, any assistant entry
  // after the latest run marker proves that the current run has reached the
  // transcript and the live fallback can be removed.
  if (!isRunning) {
    let latestRunStart = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].entry_type === 'run_start') {
        latestRunStart = i;
        break;
      }
    }
    if (
      latestRunStart >= 0 &&
      messages
        .slice(latestRunStart + 1)
        .some(
          (message) => message.role === 'assistant' && !!message.content.trim(),
        )
    ) {
      return true;
    }
  }

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  const live = currentStreaming.trim();
  if (last.content === STOPPED_BY_USER_MSG) {
    const before = messages[messages.length - 2];
    if (before && before.role === 'assistant') {
      const saved = (before.content || '').trim();
      return (
        !!live && !!saved && (saved.includes(live) || live.includes(saved))
      );
    }
    return false;
  }
  const saved = (last.content || '').trim();
  return !!live && !!saved && (saved.includes(live) || live.includes(saved));
}
