/**
 * Normalizes caller-supplied memory tags. LLM callers often pass `tags` as a
 * JSON-encoded array string (`'["a","b"]'`) rather than an array or a
 * comma-separated string, so a plain comma split would store fragments such as
 * `["a"` and `"b"]`.
 */
export function parseTagsInput(value: unknown): string[] {
  let pieces: string[];
  if (Array.isArray(value)) {
    pieces = value.filter((tag): tag is string => typeof tag === 'string');
  } else if (typeof value === 'string') {
    pieces = splitTagString(value);
  } else {
    pieces = [];
  }
  return [...new Set(pieces.map((tag) => tag.trim()).filter(Boolean))];
}

function splitTagString(value: string): string[] {
  if (!value.trim().startsWith('[')) return value.split(',');
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((tag) => typeof tag === 'string')
    ) {
      return parsed;
    }
  } catch {
    // Malformed JSON: use the tolerant comma split below.
  }
  return value
    .split(',')
    .map((tag) => tag.trim().replace(/^[[\]"']+|[[\]"']+$/g, ''));
}
