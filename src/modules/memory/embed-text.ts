/**
 * Text sent to the embedding API (may differ from PG-stored content).
 */

const EVENT_DATE_PREFIX_RE = /^\[event \d{4}-\d{2}-\d{2}\]\s/;

/** Prefix content with an event date marker for retrieval (keyword + vector). */
function formatMemoryWithEventDate(
  content: string,
  valid_from?: string | null,
): string {
  if (!valid_from || EVENT_DATE_PREFIX_RE.test(content)) return content;
  const date = valid_from.slice(0, 10);
  return `[event ${date}] ${content}`;
}

/** Prefix event date for vector search when not already present in content. */
export function textForEmbedding(
  content: string,
  valid_from?: string | null,
): string {
  return formatMemoryWithEventDate(content, valid_from);
}
