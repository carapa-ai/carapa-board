/**
 * Transcript parser.
 * Reads raw agent output.jsonl files and condenses them into
 * a compact text format suitable for the observer LLM.
 *
 * Supports multiple agent output formats:
 * - Claude Code: {type:"user", message:{role:"user", content:[{type:"text",text:"..."}]}}
 *                {type:"assistant", message:{content:[{type:"text",text:"..."}]}}
 * - Gemini: {type:"message", role:"user"|"assistant", content:"..."}
 * - Codex: {type:"item.completed", item:{type:"agent_message", text:"..."}}
 * - OpenCode: {type:"text", part:{type:"text", text:"..."}}
 */

import fs from 'fs';
import { readFromByteOffset } from './transcript-read.js';
import { stripMemoryCapsules } from './memory-capsule-markers.js';
import type { TranscriptEvidenceMessage } from './execution-context.js';

interface ParsedTranscript {
  /** Condensed text suitable for the observer */
  condensed: string;
  /** Approximate character count */
  length: number;
  /** Number of user/assistant turns */
  turnCount: number;
}

/**
 * CarapaBoard display normalization wraps tool calls and tool responses in a
 * `carapa-tool` HTML comment marker followed by a `>` blockquote body. A tool
 * body is always a contiguous run of `>` lines (blank quoted lines keep the
 * `>` prefix), so it ends at the first non-blockquote line.
 */
const TOOL_ACTIVITY_SEGMENT =
  /(?:^|\n)[ \t]*<!--\s*carapa-tool:(?:request|result|error)(?:\s+tool-id="[^"]*")?\s*-->[ \t]*\n(?:[ \t]*\n)*(?:[ \t]*>[ \t]?.*\n?)*/g;

/** Drop tool call/response segments, keeping only authored text. */
function stripToolActivitySegments(content: string): string {
  if (!content.includes('carapa-tool')) return content;
  return content.replace(TOOL_ACTIVITY_SEGMENT, '').replace(/\n{3,}/g, '\n\n');
}

/** Bound on the non-citable content retained per evidence message. */
const MAX_NON_TEXT_CONTENT = 20_000;

/** Raw string leaves of a JSON value, so escaping never hides copied text. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
  return out;
}

/** Tool call/response text of one raw content block, for classification only. */
function nonTextBlockContent(block: Record<string, unknown>): string {
  if (block.type === 'tool_use') return stringLeaves(block.input).join('\n');
  if (block.type !== 'tool_result') return '';
  if (typeof block.content === 'string') return block.content;
  return Array.isArray(block.content)
    ? block.content
        .map((part) =>
          typeof part?.text === 'string' ? (part.text as string) : '',
        )
        .join('\n')
    : '';
}

export function normalizeTranscriptTimestamp(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

/** The entry's own timestamp, normalized when parseable; undefined if absent. */
function ownTimestamp(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.created_at === 'string')
    return normalizeTranscriptTimestamp(entry.created_at);
  if (typeof entry.timestamp === 'string')
    return normalizeTranscriptTimestamp(entry.timestamp);
  if (
    typeof entry.timestamp === 'number' &&
    Number.isFinite(new Date(entry.timestamp).getTime())
  ) {
    return new Date(entry.timestamp).toISOString();
  }
  return undefined;
}

function entryTimestamp(entry: Record<string, unknown>, fallback: string) {
  return ownTimestamp(entry) ?? fallback;
}

/**
 * Per-line fallback for lines without their own timestamp: the next
 * parseable timestamp in the slice, else the nearest previous one, else
 * `fallback`. `stamps[i]` is the parseable own timestamp of line i, if any.
 */
function derivedTimestamps(
  stamps: Array<string | undefined>,
  fallback: string,
): string[] {
  const nextStamp = new Array<string | undefined>(stamps.length);
  let next: string | undefined;
  for (let i = stamps.length - 1; i >= 0; i--) {
    nextStamp[i] = next;
    next = stamps[i] ?? next;
  }
  let previous: string | undefined;
  return stamps.map((stamp, i) => {
    const derived = nextStamp[i] ?? previous ?? fallback;
    previous = stamp ?? previous;
    return derived;
  });
}

function entryIdentity(
  entry: Record<string, unknown>,
  sourcePosition: number,
  suffix = '',
): string {
  const message = entry.message as Record<string, unknown> | undefined;
  const item = entry.item as Record<string, unknown> | undefined;
  const raw = entry.id ?? message?.id ?? item?.id ?? `byte-${sourcePosition}`;
  return `${String(raw)}${suffix}`;
}

/**
 * Canonical evidence-bearing user/assistant messages for the tool reflector,
 * read from `outputJsonlPath`. Prefer {@link parseTranscriptEvidenceFromBuffer}
 * with bytes from a contained reader when the path is not trusted.
 */
export function parseTranscriptEvidenceMessages(
  outputJsonlPath: string,
  byteOffset?: number,
  byteEndOffset?: number,
): TranscriptEvidenceMessage[] {
  let buf: Buffer;
  let fallback: string;
  try {
    // A timestamp-less appended record belongs to the run which last wrote
    // the file, not to the aggregate file's first turn.
    fallback = fs.statSync(outputJsonlPath).mtime.toISOString();
    buf = fs.readFileSync(outputJsonlPath);
  } catch {
    return [];
  }
  return parseTranscriptEvidenceFromBuffer(
    buf,
    byteOffset,
    byteEndOffset,
    fallback,
  );
}

/**
 * Same parsing as {@link parseTranscriptEvidenceMessages} over bytes the caller
 * already read: `buf` is the whole file and the optional offsets select a
 * slice. `fallback` stamps records without a timestamp.
 */
export function parseTranscriptEvidenceFromBuffer(
  buf: Buffer,
  byteOffset: number | undefined,
  byteEndOffset: number | undefined,
  fallback: string,
): TranscriptEvidenceMessage[] {
  const start = Math.max(0, byteOffset ?? 0);
  const end = Math.max(
    start,
    Math.min(buf.length, byteEndOffset ?? buf.length),
  );
  const raw = buf.subarray(start, end).toString('utf-8');

  const messages: TranscriptEvidenceMessage[] = [];
  const lineFallbacks = new Map<Record<string, unknown>, string>();
  const usedIds = new Set<string>();
  const push = (
    entry: Record<string, unknown>,
    sourcePosition: number,
    role: 'user' | 'assistant',
    content: string,
    suffix = '',
    entryNonText = '',
  ) => {
    const nonTextContent = [
      ...[...content.matchAll(TOOL_ACTIVITY_SEGMENT)].map(([m]) => m),
      entryNonText,
    ]
      .join('\n')
      .trim()
      .slice(0, MAX_NON_TEXT_CONTENT);
    const normalized = stripToolActivitySegments(
      stripMemoryCapsules(content)
        .replace(/^\[AGENT_CONTEXT:.*?\]\s*/s, '')
        .trim(),
    ).trim();
    if (!normalized || normalized.includes('[CONTEXT_SUMMARY:')) return;
    let id = entryIdentity(entry, sourcePosition, suffix);
    if (usedIds.has(id)) id = `${id}:byte-${sourcePosition}`;
    usedIds.add(id);
    messages.push({
      id,
      role,
      content: truncate(normalized, 2000),
      ...(nonTextContent ? { nonTextContent } : {}),
      createdAt: entryTimestamp(entry, lineFallbacks.get(entry) ?? fallback),
      ...('objective_id' in entry &&
      (entry.objective_id === null || typeof entry.objective_id === 'string')
        ? { objectiveId: entry.objective_id }
        : {}),
    });
  };

  // Parse the slice first: a record without a timestamp takes its neighbour's.
  let sourcePosition = Math.max(0, byteOffset ?? 0);
  const lines: Array<{
    linePosition: number;
    entry: Record<string, unknown>;
  }> = [];
  raw.split('\n').forEach((line) => {
    const linePosition = sourcePosition;
    sourcePosition += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim().startsWith('{')) return;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry && typeof entry === 'object')
        lines.push({ linePosition, entry });
    } catch {
      // A partial or non-JSON line neither yields evidence nor a timestamp.
    }
  });
  const lineTimestamps = derivedTimestamps(
    lines.map(({ entry }) => {
      const stamp = ownTimestamp(entry);
      return stamp && Number.isFinite(Date.parse(stamp)) ? stamp : undefined;
    }),
    fallback,
  );
  lines.forEach(({ linePosition, entry }, lineIndex) => {
    lineFallbacks.set(entry, lineTimestamps[lineIndex]!);
    const type = entry.type as string | undefined;
    if (
      type === 'message' &&
      (entry.role === 'user' || entry.role === 'assistant')
    ) {
      const content = extractContent(entry);
      if (content) push(entry, linePosition, entry.role, content);
      return;
    }
    if (type === 'user' || type === 'assistant') {
      const message = entry.message as Record<string, unknown> | undefined;
      const blocks = Array.isArray(message?.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [];
      const entryNonText = blocks.map(nonTextBlockContent).join('\n');
      blocks.forEach((block, blockIndex) => {
        if (block.type === 'text' && block.text) {
          push(
            entry,
            linePosition,
            type,
            String(block.text),
            `:text-${blockIndex + 1}`,
            entryNonText,
          );
        }
      });
      return;
    }
    if (type === 'item.completed') {
      const item = entry.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && item.text) {
        push(entry, linePosition, 'assistant', String(item.text));
      }
      return;
    }
    if (type === 'text') {
      const part = entry.part as Record<string, unknown> | undefined;
      if (part?.type === 'text' && part.text) {
        push(entry, linePosition, 'assistant', String(part.text));
      }
      return;
    }
    if (type === 'result' && typeof entry.result === 'string') {
      push(entry, linePosition, 'assistant', entry.result);
    }
  });
  return messages;
}

/**
 * Parse a raw output.jsonl file into a condensed transcript.
 * Extracts user messages, assistant text responses, and tool names/outcomes.
 * Strips verbose tool outputs to keep token count low.
 */
export function parseTranscript(
  outputJsonlPath: string,
  byteOffset?: number,
): ParsedTranscript {
  let raw: string;
  try {
    raw = readFromByteOffset(outputJsonlPath, byteOffset);
  } catch {
    return { condensed: '', length: 0, turnCount: 0 };
  }
  return parseTranscriptText(raw);
}

/** Condense already-read transcript text; see {@link parseTranscript}. */
export function parseTranscriptText(raw: string): ParsedTranscript {
  const lines = raw.split('\n').filter((l) => l.trim());
  const parts: string[] = [];
  let turnCount = 0;

  for (const line of lines) {
    // Skip non-JSON lines (e.g. "YOLO mode is enabled...")
    if (!line.startsWith('{')) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type as string;

    // ── User messages ──
    if (type === 'message' && entry.role === 'user') {
      const content = extractContent(entry);
      if (content) {
        // Strip AGENT_CONTEXT prefix for brevity
        const cleaned = stripMemoryCapsules(content)
          .replace(/^\[AGENT_CONTEXT:.*?\]\s*/s, '')
          .trim();
        if (cleaned) {
          parts.push(`[USER] ${truncate(cleaned, 2000)}`);
          turnCount++;
        }
      }
      continue;
    }

    // ── Claude Code assistant messages ──
    if (type === 'assistant') {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && block.text) {
            parts.push(`[ASSISTANT] ${truncate(String(block.text), 2000)}`);
            turnCount++;
          } else if (block.type === 'tool_use') {
            parts.push(`[TOOL] ${block.name || 'unknown'}`);
          }
        }
      }
      continue;
    }

    // ── Claude Code user messages (type: "user") ──
    if (type === 'user') {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && block.text) {
            const cleaned = stripMemoryCapsules(String(block.text));
            if (!cleaned) continue;
            parts.push(`[USER] ${truncate(cleaned, 2000)}`);
            turnCount++;
          } else if (block.type === 'tool_result') {
            const content =
              typeof block.content === 'string' ? block.content : '';
            const firstLine = content.split('\n')[0]?.trim() || '';
            parts.push(
              `[TOOL_RESULT] ${block.is_error ? 'error' : 'success'}${firstLine ? ': ' + truncate(firstLine, 200) : ''}`,
            );
          }
        }
      }
      continue;
    }

    // ── Gemini/OpenCode assistant messages ──
    if (type === 'message' && entry.role === 'assistant') {
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (content) {
        parts.push(`[ASSISTANT] ${truncate(content, 2000)}`);
        turnCount++;
      }
      continue;
    }

    // ── OpenCode text parts ──
    if (type === 'text') {
      const part = entry.part as Record<string, unknown> | undefined;
      if (part?.type === 'text' && part.text) {
        parts.push(`[ASSISTANT] ${truncate(String(part.text), 2000)}`);
        turnCount++;
      }
      continue;
    }

    // ── Codex completed items ──
    if (type === 'item.completed') {
      const item = entry.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && item.text) {
        parts.push(`[ASSISTANT] ${truncate(String(item.text), 2000)}`);
        turnCount++;
      }
      continue;
    }

    // ── Tool calls — keep name only, skip verbose output ──
    if (type === 'tool_use') {
      const toolName = entry.tool_name || entry.name || 'unknown_tool';
      parts.push(`[TOOL] ${toolName}`);
      continue;
    }

    // ── Tool results — keep brief status only ──
    if (type === 'tool_result') {
      const status = entry.status || (entry.is_error ? 'error' : 'success');
      const output = typeof entry.output === 'string' ? entry.output : '';
      // Only include first line of output for context
      const firstLine = output.split('\n')[0]?.trim() || '';
      if (firstLine) {
        parts.push(`[TOOL_RESULT] ${status}: ${truncate(firstLine, 200)}`);
      }
      continue;
    }

    // ── Result/summary ──
    if (type === 'result') {
      const result = entry.result as string | undefined;
      if (result && typeof result === 'string') {
        parts.push(`[RESULT] ${truncate(result, 1000)}`);
      }
      continue;
    }
  }

  const condensed = parts.join('\n\n');
  return { condensed, length: condensed.length, turnCount };
}

/** Extract text content from various message formats. */
function extractContent(entry: Record<string, unknown>): string {
  if (typeof entry.content === 'string') return entry.content;
  if (Array.isArray(entry.content)) {
    return (entry.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text || ''))
      .join('\n');
  }
  return '';
}

/** Truncate a string to maxLen characters. */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}
