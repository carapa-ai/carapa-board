/** Compute word overlap ratio between two strings (0-1). */
export function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let hits = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) hits++;
  }
  return hits / Math.min(wordsA.size, wordsB.size);
}
