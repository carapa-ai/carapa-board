/** Flattens loaded pages in order, keeping the first occurrence of each key. */
export function mergeObjectivePages<T>(
  pages: readonly (readonly T[])[],
  getKey: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const page of pages) {
    for (const item of page) {
      const key = getKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/** Number of rows fetched so far, counted before deduplication. */
export function countLoadedObjectiveRows(
  pages: readonly (readonly unknown[])[],
): number {
  return pages.reduce((count, page) => count + page.length, 0);
}

/** Next server offset, or undefined once every row has been fetched. */
export function nextObjectiveOffset(
  loaded: number,
  total: number,
): number | undefined {
  return loaded < total ? loaded : undefined;
}
