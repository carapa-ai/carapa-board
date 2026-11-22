export type InputTokenSemantics = 'fresh' | 'total';

export function cacheHitPercent(
  inputTokens: number,
  cachedTokens: number,
  semantics: InputTokenSemantics,
  cacheWriteTokens = 0,
): number | null {
  const denominator =
    semantics === 'fresh'
      ? inputTokens + cachedTokens + cacheWriteTokens
      : inputTokens;
  if (denominator <= 0) return null;
  return Math.min(100, Math.max(0, (cachedTokens / denominator) * 100));
}
