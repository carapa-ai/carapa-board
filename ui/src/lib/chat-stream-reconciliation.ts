import { stripChatControlMetadata } from './chat-control-metadata';

function comparableText(content: string): string {
  return stripChatControlMetadata(content).replace(/\s+/g, ' ').trim();
}

/**
 * Return canonical persisted Markdown only when it is the same response as the
 * accumulated stream. Whitespace is ignored for identity but preserved in the
 * returned value, so final paragraph/list structure becomes authoritative
 * without replacing Work Live narration or an unrelated participant's text.
 */
export function canonicalStreamReplacement(
  streamedContent: string,
  canonicalContent: string,
): string | null {
  const streamedComparable = comparableText(streamedContent);
  const canonical = stripChatControlMetadata(canonicalContent);
  if (
    !streamedComparable ||
    !canonical ||
    streamedComparable !== comparableText(canonical)
  ) {
    return null;
  }
  return canonical;
}

/** The saved final answer can be only the tail of its streamed turn. */
export function completedStreamContent(
  streamedContent: string | undefined,
  canonicalContent: string,
): string {
  if (!streamedContent) return canonicalContent;
  const streamed = comparableText(streamedContent);
  const canonical = comparableText(canonicalContent);
  // Retain commentary and tool activity until the full transcript takes over.
  // Equal responses still use the saved Markdown's authoritative whitespace.
  return canonical &&
    streamed !== canonical &&
    streamed.endsWith(canonical) &&
    // A replayed final answer is duplication, not earlier commentary.
    streamed.split(canonical).some((segment) => segment.trim().length > 0)
    ? streamedContent
    : canonicalContent;
}

/**
 * Apply a streamed delta at the server-provided UTF-16 content offset.
 * Replayed or overlapping ranges are idempotent; a gap/conflict leaves the
 * current snapshot intact until reconnect reconciliation supplies a new one.
 * Offset-less events retain the legacy best-effort suffix deduplication.
 * `baseOffset` is the absolute offset of `current[0]`: nonzero when `current`
 * came from a snapshot whose prefix the server trimmed at its buffer cap.
 */
export function reconcileChatStreamChunk(
  current: string,
  chunk: string,
  contentOffset?: number,
  baseOffset = 0,
): string {
  if (!Number.isInteger(contentOffset) || contentOffset! < 0) {
    return current && current.endsWith(chunk) ? current : current + chunk;
  }
  let offset = contentOffset! - baseOffset;
  if (offset < 0) {
    // The chunk starts inside the trimmed prefix; only its tail can be new.
    if (-offset >= chunk.length) return current;
    chunk = chunk.slice(-offset);
    offset = 0;
  }
  if (offset > current.length) return current;

  const overlapLength = Math.min(current.length - offset, chunk.length);
  if (
    current.slice(offset, offset + overlapLength) !==
    chunk.slice(0, overlapLength)
  ) {
    return current;
  }
  return current + chunk.slice(overlapLength);
}
