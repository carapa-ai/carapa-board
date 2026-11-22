/**
 * Normalizes a tool input that is expected to be an array of strings.
 * Handles:
 * - Native arrays
 * - JSON-encoded strings (e.g. '["a", "b"]')
 * - Comma-separated strings (e.g. 'a, b')
 * - Single strings (e.g. 'a')
 */
function normalizeValues(values: unknown[]): string[] {
  return values.map((value) => String(value).trim()).filter(Boolean);
}

export function normalizeStringArray(input: any): string[] {
  if (Array.isArray(input)) {
    return normalizeValues(input);
  }

  if (typeof input !== 'string') {
    return input ? [String(input)] : [];
  }

  const trimmed = input.trim();
  if (!trimmed) return [];

  // Handle JSON-encoded array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return normalizeValues(parsed);
      }
      return [String(parsed).trim()];
    } catch {
      // Fall through to comma-split if JSON parse fails
    }
  }

  // Handle comma-separated or single string
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalizes a task ID by prepending 'task-' if it looks like a raw numeric ID.
 */
export function normalizeTaskId(id: string): string {
  if (!id || typeof id !== 'string') return id;
  if (/^\d{13,}-[a-z0-9]{6}$/.test(id)) {
    return `task-${id}`;
  }
  return id;
}
