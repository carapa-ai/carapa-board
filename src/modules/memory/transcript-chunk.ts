/**
 * Token-budget chunking for observer LLM calls (production transcripts + shared heuristic).
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Join pre-split transcript turns into observer chunks capped at maxTokensPerChunk. */
export function chunkTextParts(
  parts: string[],
  maxTokensPerChunk: number,
): string[] {
  if (parts.length === 0) return [];
  if (maxTokensPerChunk <= 0) return [parts.join('\n\n')];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current.join('\n\n'));
    current = [];
    currentTokens = 0;
  };

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const partTokens = estimateTokens(trimmed) + 2;
    if (current.length > 0 && currentTokens + partTokens > maxTokensPerChunk) {
      flush();
    }
    current.push(trimmed);
    currentTokens += partTokens;
  }
  flush();
  return chunks;
}
