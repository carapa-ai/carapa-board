/**
 * Reciprocal Rank Fusion (RRF) for combining multiple ranked result lists.
 *
 * Used by the `recall` tool to fuse keyword (SQL LIKE) and vector (semantic)
 * search results into a single ranking, keeping the strengths of both:
 * exact-match precision from keyword search and semantic recall from vectors.
 *
 * RRF score for a document d: Σ over lists  1 / (k + rank_i(d))
 * where rank_i is the 0-based position of d in list i (absent ⇒ no contribution).
 * k dampens the influence of top ranks; 60 is the value from the original
 * RRF paper (Cormack et al., SIGIR '09) and a common default.
 */

const DEFAULT_RRF_K = 60;

/**
 * Fuse several ranked lists of ids into one ranking by descending RRF score.
 * Ties are broken by the order of first appearance across the input lists,
 * which keeps the fusion deterministic.
 *
 * @param rankedLists Arrays of ids, each already ordered best-first.
 * @param k RRF damping constant (default 60).
 * @returns Deduplicated ids ordered by fused score, highest first.
 */
export function rrfFuse(
  rankedLists: string[][],
  k: number = DEFAULT_RRF_K,
): string[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let seenCounter = 0;

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, seenCounter++);
    }
  }

  return [...scores.keys()].sort((a, b) => {
    const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (diff !== 0) return diff;
    return (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
  });
}
