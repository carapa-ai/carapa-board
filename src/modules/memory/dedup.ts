/**
 * Strict duplicate detection for memory writes and maintenance.
 *
 * `wordOverlap` compares word sets, divides by the smaller set and ignores
 * words of two letters or fewer, so contradicting or corrected facts ("is
 * staging" vs "is production", "wants" vs "no longer wants", swapped
 * subject/object or swapped numbers) score as near-identical. A write is only
 * a duplicate when both texts contain the same ordered token sequence, ignoring
 * case, punctuation and the articles a/an/the. Negations ("no", "not",
 * "never"), numbers and word order all matter.
 */

/** Articles carry no meaning, so they may differ between duplicates. */
const IGNORABLE_WORDS = new Set(['a', 'an', 'the']);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !IGNORABLE_WORDS.has(word),
  );
}

export function isDuplicateMemoryContent(a: string, b: string): boolean {
  const tokensA = tokens(a);
  const tokensB = tokens(b);
  if (tokensA.length === 0 || tokensA.length !== tokensB.length) return false;
  return tokensA.every((word, i) => word === tokensB[i]);
}
