/**
 * Infer chronological ranking direction from a recall query.
 * Returns null when a chrono RRF list would likely hurt semantic retrieval.
 */

export type ChronoOrder = 'asc' | 'desc';

/** Explicit recency / ordering cues only — avoid default chrono on every asOf query. */
export function chronoOrderFromQuery(
  query: string | undefined,
): ChronoOrder | null {
  if (!query?.trim()) return null;
  const q = query.toLowerCase();

  if (/\b(most recent|latest|last time|newest|recently)\b/.test(q)) {
    return 'desc';
  }
  if (
    /\b(which .+ (first|earlier)|came first|earliest|before .+ or|first, .+ or)\b/.test(
      q,
    )
  ) {
    return 'asc';
  }
  if (
    /\b(how many (days|weeks|months|years) before|which .+ did i .+ first|before the .+ event)\b/.test(
      q,
    )
  ) {
    return 'asc';
  }
  return null;
}
