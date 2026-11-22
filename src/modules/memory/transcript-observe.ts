/**
 * Build dated observer chunks from production transcripts (chat JSONL or agent output).
 *
 * Chat histories: group turns by UTC calendar day, then chunk by token budget within
 * each day so relative-time phrases anchor correctly when ingesting old chats.
 *
 * Agent runs: token-chunk the condensed transcript; all chunks use the observation
 * date (today) when the source has no per-turn timestamps.
 */

import path from 'path';
import {
  parseTranscriptText,
  parseTranscriptEvidenceFromBuffer,
  parseTranscriptEvidenceMessages,
  normalizeTranscriptTimestamp,
  truncate,
} from './transcript-parser.js';
import { readFromByteOffset, sliceFromByteOffset } from './transcript-read.js';
import { chunkTextParts, estimateTokens } from './transcript-chunk.js';
import type { TranscriptInputKind } from './transcript-profiles.js';
import type { TranscriptEvidenceMessage } from './execution-context.js';

export { readFromByteOffset };

interface ObserverDatedChunk {
  text: string;
  messageDateUtc: string;
  inputKind: TranscriptInputKind;
}

export interface BuildObserverChunksResult {
  chunks: ObserverDatedChunk[];
  turnCount: number;
  length: number;
}

export interface ReflectorTranscriptChunk extends ObserverDatedChunk {
  messages: TranscriptEvidenceMessage[];
}

interface ObserverTurn {
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
}

interface DatedTurnPart {
  formatted: string;
  created_at?: string;
  dayKey: string;
}

function isChatTranscriptPath(filePath: string): boolean {
  const base = path.basename(filePath);
  return base.startsWith('chat-') && base.endsWith('.output.jsonl');
}

/** Task execution history is retained for reference, not automatic memory. */
export function isTaskReflectionSource(
  filePath: string,
  profile?: string,
): boolean {
  return (
    profile === 'kanban-task' ||
    /^(?:\d{4}-\d{2}-\d{2}-)?task-.+\.(?:output\.)?jsonl$/.test(
      path.basename(filePath),
    )
  );
}

/** UTC calendar day (YYYY-MM-DD) for grouping and fallback dating. */
function utcDayKey(iso?: string, fallbackDay?: string): string {
  if (iso) return normalizeTranscriptTimestamp(iso)!.slice(0, 10);
  return fallbackDay ?? new Date().toISOString().slice(0, 10);
}

/** ISO timestamp for observer prompt + memory valid_from. */
function observerMessageDateUtc(created_at?: string, dayKey?: string): string {
  if (created_at) return normalizeTranscriptTimestamp(created_at)!;
  const day = dayKey ?? new Date().toISOString().slice(0, 10);
  return `${day}T12:00:00.000Z`;
}

function extractContent(entry: Record<string, unknown>): string {
  if (typeof entry.content === 'string') return entry.content;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (msg?.content && Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text || ''))
      .join('\n');
  }
  if (typeof msg?.content === 'string') return msg.content;
  if (typeof entry.result === 'string') return entry.result;
  return '';
}

function entryCreatedAt(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.created_at === 'string')
    return normalizeTranscriptTimestamp(entry.created_at);
  if (typeof entry.timestamp === 'number')
    return new Date(entry.timestamp).toISOString();
  return undefined;
}

function extractChatObserverTurn(
  entry: Record<string, unknown>,
): ObserverTurn | null {
  const created_at = entryCreatedAt(entry);
  const type = entry.type as string | undefined;

  if (type === 'compaction_marker') return null;

  if (
    type === 'message' &&
    (entry.role === 'user' || entry.role === 'assistant')
  ) {
    const content =
      typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content || content.includes('[CONTEXT_SUMMARY:')) return null;
    return { role: entry.role, content: truncate(content, 2000), created_at };
  }

  if (type === 'user') {
    const content = extractContent(entry).trim();
    if (!content) return null;
    return { role: 'user', content: truncate(content, 2000), created_at };
  }

  if (type === 'assistant') {
    const content = extractContent(entry).trim();
    if (!content) return null;
    return { role: 'assistant', content: truncate(content, 2000), created_at };
  }

  if (type === 'result') {
    const content = typeof entry.result === 'string' ? entry.result.trim() : '';
    if (!content) return null;
    return { role: 'assistant', content: truncate(content, 1000), created_at };
  }

  return null;
}

function formatConversationTurn(turn: ObserverTurn): string {
  const label = turn.role === 'user' ? 'User' : 'Assistant';
  return `${label}: ${turn.content}`;
}

function chunkDatedTurnParts(
  parts: DatedTurnPart[],
  maxTokensPerChunk: number,
  inputKind: TranscriptInputKind,
): ObserverDatedChunk[] {
  if (parts.length === 0) return [];

  const textParts = parts.map((p) => p.formatted);
  if (maxTokensPerChunk <= 0) {
    const first = parts[0]!;
    return [
      {
        text: textParts.join('\n\n'),
        messageDateUtc: observerMessageDateUtc(first.created_at, first.dayKey),
        inputKind,
      },
    ];
  }

  const chunks: ObserverDatedChunk[] = [];
  let current: DatedTurnPart[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    chunks.push({
      text: current.map((p) => p.formatted).join('\n\n'),
      messageDateUtc: observerMessageDateUtc(first.created_at, first.dayKey),
      inputKind,
    });
    current = [];
    currentTokens = 0;
  };

  for (const part of parts) {
    const partTokens = estimateTokens(part.formatted) + 2;
    if (current.length > 0 && currentTokens + partTokens > maxTokensPerChunk) {
      flush();
    }
    current.push(part);
    currentTokens += partTokens;
  }
  flush();
  return chunks;
}

function buildChatObserverChunks(
  raw: string,
  maxTokensPerChunk: number,
): BuildObserverChunksResult {
  const fallbackDay = new Date().toISOString().slice(0, 10);

  const turns: ObserverTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const turn = extractChatObserverTurn(entry);
    if (turn) turns.push(turn);
  }

  const byDay = new Map<string, DatedTurnPart[]>();
  for (const turn of turns) {
    const dayKey = utcDayKey(turn.created_at, fallbackDay);
    const list = byDay.get(dayKey) ?? [];
    list.push({
      formatted: formatConversationTurn(turn),
      created_at: turn.created_at,
      dayKey,
    });
    byDay.set(dayKey, list);
  }

  const sortedDays = [...byDay.keys()].sort();
  const chunks: ObserverDatedChunk[] = [];
  for (const day of sortedDays) {
    chunks.push(
      ...chunkDatedTurnParts(
        byDay.get(day)!,
        maxTokensPerChunk,
        'conversation',
      ),
    );
  }

  const length = turns.reduce((n, t) => n + t.content.length, 0);
  return { chunks, turnCount: turns.length, length };
}

function buildAgentObserverChunks(
  raw: string,
  maxTokensPerChunk: number,
): BuildObserverChunksResult {
  const parsed = parseTranscriptText(raw);
  if (!parsed.condensed.trim()) {
    return { chunks: [], turnCount: 0, length: 0 };
  }

  const messageDateUtc = observerMessageDateUtc();
  const textChunks =
    maxTokensPerChunk > 0
      ? chunkTextParts(
          parsed.condensed
            .split('\n\n')
            .map((p) => p.trim())
            .filter(Boolean),
          maxTokensPerChunk,
        )
      : [parsed.condensed.trim()];

  const chunks: ObserverDatedChunk[] = textChunks.map((text) => ({
    text,
    messageDateUtc,
    inputKind: 'transcript',
  }));

  return { chunks, turnCount: parsed.turnCount, length: parsed.length };
}

/**
 * Observer chunks from transcript bytes the caller already read through a
 * contained reader. `filePath` only selects chat vs agent parsing by name and
 * is never read.
 */
export function buildObserverChunks(
  filePath: string,
  source: Buffer,
  byteOffset?: number,
  maxTokensPerChunk = 5000,
): BuildObserverChunksResult {
  const raw = sliceFromByteOffset(source, byteOffset, filePath);
  return isChatTranscriptPath(filePath)
    ? buildChatObserverChunks(raw, maxTokensPerChunk)
    : buildAgentObserverChunks(raw, maxTokensPerChunk);
}

function formatReflectorMessage(message: TranscriptEvidenceMessage): string {
  const objective =
    message.objectiveId === undefined
      ? ''
      : ` objective_id="${message.objectiveId ?? 'project-wide'}"`;
  return [
    `<message id="${message.id}" timestamp="${message.createdAt}" role="${message.role}"${objective}>`,
    message.content,
    '</message>',
  ].join('\n');
}

/** Whole-file bytes already read through a contained reader, plus its mtime. */
export interface ReflectorChunkSource {
  bytes: Buffer;
  /** ISO mtime of the opened file; stamps records without a timestamp. */
  mtimeIso: string;
}

/**
 * Evidence-preserving chunks with the observer's existing token limit. With
 * `source` the filesystem is never touched (`filePath` only selects the chunk
 * kind by name), so a path swapped after a contained read cannot change the
 * evidence.
 */
export function buildReflectorChunks(
  filePath: string,
  byteOffset?: number,
  maxTokensPerChunk = 5000,
  byteEndOffset?: number,
  source?: ReflectorChunkSource,
): ReflectorTranscriptChunk[] {
  const messages = source
    ? parseTranscriptEvidenceFromBuffer(
        source.bytes,
        byteOffset,
        byteEndOffset,
        source.mtimeIso,
      )
    : parseTranscriptEvidenceMessages(filePath, byteOffset, byteEndOffset);
  if (messages.length === 0) return [];
  messages.sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  const inputKind: TranscriptInputKind = isChatTranscriptPath(filePath)
    ? 'conversation'
    : 'transcript';
  const byDay = new Map<string, TranscriptEvidenceMessage[]>();
  for (const message of messages) {
    const day = utcDayKey(message.createdAt);
    const dayMessages = byDay.get(day) ?? [];
    dayMessages.push(message);
    byDay.set(day, dayMessages);
  }

  const chunks: ReflectorTranscriptChunk[] = [];
  for (const day of [...byDay.keys()].sort()) {
    let current: TranscriptEvidenceMessage[] = [];
    let currentTokens = 0;
    const flush = () => {
      if (current.length === 0) return;
      chunks.push({
        text: current.map(formatReflectorMessage).join('\n\n'),
        messageDateUtc: current[0]!.createdAt,
        inputKind,
        messages: current,
      });
      current = [];
      currentTokens = 0;
    };
    for (const message of byDay.get(day)!) {
      const tokens = estimateTokens(formatReflectorMessage(message)) + 2;
      if (
        maxTokensPerChunk > 0 &&
        current.length > 0 &&
        currentTokens + tokens > maxTokensPerChunk
      ) {
        flush();
      }
      current.push(message);
      currentTokens += tokens;
    }
    flush();
  }
  return chunks;
}
