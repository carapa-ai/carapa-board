/** Parse JSONL text into values, skipping blank and malformed lines. */
export function parseJsonl<T = unknown>(content: string): T[] {
  const results: T[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return results;
}
