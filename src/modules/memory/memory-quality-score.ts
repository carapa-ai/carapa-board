/**
 * Read-only quality scorer for stored memories. Pure: no I/O, no DB imports.
 * Produces a JSON-serialisable baseline so prompt/model changes can be compared.
 */

export interface QualityItem {
  id: string;
  content: string;
  memory_type?: string;
  importance?: number;
  tags?: string[];
  source?: string;
}

interface NearDuplicatePair {
  a: string;
  b: string;
  similarity: number;
}

export interface QualityScopeReport {
  count: number;
  length: {
    median: number;
    p90: number;
    max: number;
    shareOver600: number;
    over600Ids: string[];
  };
  leadSentence: {
    /** Share of items whose first sentence ends within 240 chars. */
    share: number;
    /** Ids of items whose first sentence is longer than 240 chars. */
    missingIds: string[];
  };
  staleStatus: { share: number; count: number; ids: string[] };
  tags: { share: number; count: number; ids: string[] };
  importance: {
    /** Items that carry an importance value (the share's denominator). */
    considered: number;
    share: number;
    count: number;
    ids: string[];
  };
  nearDuplicates: {
    /** True when the scope exceeded the comparison limit; no pairs compared. */
    skipped: boolean;
    itemCount: number;
    pairCount: number;
    pairs: NearDuplicatePair[];
  };
}

export interface QualityReport {
  overall: QualityScopeReport;
  bySource: Record<string, QualityScopeReport>;
}

const LONG_CONTENT_CHARS = 600;
const LEAD_SENTENCE_MAX_CHARS = 240;
const HIGH_IMPORTANCE = 0.9;
const MIN_TAGS = 2;
const MAX_TAGS = 6;
const NEAR_DUPLICATE_JACCARD = 0.7;
const NEAR_DUPLICATE_MAX_ITEMS = 2000;
const MAX_LISTED_IDS = 50;
const MAX_LISTED_PAIRS = 50;

const STALE_STATUS_RE =
  /\b(not yet (live|merged|deployed|verified)|pending (deploy|merge|review|approval)|awaiting|in the backlog|in backlog|uncommitted|unmerged|in flight|in progress|currently running|todo)\b/i;

const SENTENCE_END_RE = /[.?!;] |\n/;

function share(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function capped(ids: string[]): string[] {
  return ids.slice(0, MAX_LISTED_IDS);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length, Math.ceil(p * sorted.length)) - 1];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Length of the first sentence, counting its terminator (whole text if none). */
function firstSentenceLength(content: string): number {
  const match = SENTENCE_END_RE.exec(content);
  if (!match) return content.length;
  // Terminator punctuation belongs to the sentence; a newline does not.
  return match[0] === '\n' ? match.index : match.index + 1;
}

function wordSet(content: string): Set<string> {
  return new Set(content.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}

function findNearDuplicates(items: QualityItem[]): {
  skipped: boolean;
  itemCount: number;
  pairCount: number;
  pairs: NearDuplicatePair[];
} {
  const itemCount = items.length;
  if (itemCount > NEAR_DUPLICATE_MAX_ITEMS) {
    return { skipped: true, itemCount, pairCount: 0, pairs: [] };
  }
  const sets = items.map((item) => wordSet(item.content));
  const pairs: NearDuplicatePair[] = [];
  let pairCount = 0;
  for (let i = 0; i < itemCount; i++) {
    const a = sets[i];
    if (a.size === 0) continue;
    for (let j = i + 1; j < itemCount; j++) {
      const b = sets[j];
      if (b.size === 0) continue;
      // Jaccard can never reach the threshold if the size ratio is too low.
      if (
        Math.min(a.size, b.size) / Math.max(a.size, b.size) <
        NEAR_DUPLICATE_JACCARD
      ) {
        continue;
      }
      let shared = 0;
      for (const word of a) if (b.has(word)) shared++;
      const similarity = shared / (a.size + b.size - shared);
      if (similarity < NEAR_DUPLICATE_JACCARD) continue;
      pairCount++;
      if (pairs.length < MAX_LISTED_PAIRS) {
        pairs.push({
          a: items[i].id,
          b: items[j].id,
          similarity: Math.round(similarity * 1000) / 1000,
        });
      }
    }
  }
  return { skipped: false, itemCount, pairCount, pairs };
}

function scoreScope(items: QualityItem[]): QualityScopeReport {
  const count = items.length;
  const lengths = items
    .map((item) => item.content.length)
    .sort((a, b) => a - b);
  const over600 = items.filter((i) => i.content.length > LONG_CONTENT_CHARS);
  const noLead = items.filter(
    (i) => firstSentenceLength(i.content) > LEAD_SENTENCE_MAX_CHARS,
  );
  const stale = items.filter((i) => STALE_STATUS_RE.test(i.content));
  const badTags = items.filter((i) => {
    const n = i.tags?.length ?? 0;
    return n < MIN_TAGS || n > MAX_TAGS;
  });
  const withImportance = items.filter(
    (i) => typeof i.importance === 'number' && !Number.isNaN(i.importance),
  );
  const highImportance = withImportance.filter(
    (i) => i.importance! >= HIGH_IMPORTANCE,
  );

  return {
    count,
    length: {
      median: median(lengths),
      p90: percentile(lengths, 0.9),
      max: lengths.at(-1) ?? 0,
      shareOver600: share(over600.length, count),
      over600Ids: capped(over600.map((i) => i.id)),
    },
    leadSentence: {
      share: share(count - noLead.length, count),
      missingIds: capped(noLead.map((i) => i.id)),
    },
    staleStatus: {
      share: share(stale.length, count),
      count: stale.length,
      ids: capped(stale.map((i) => i.id)),
    },
    tags: {
      share: share(badTags.length, count),
      count: badTags.length,
      ids: capped(badTags.map((i) => i.id)),
    },
    importance: {
      considered: withImportance.length,
      share: share(highImportance.length, withImportance.length),
      count: highImportance.length,
      ids: capped(highImportance.map((i) => i.id)),
    },
    nearDuplicates: findNearDuplicates(items),
  };
}

export function scoreMemoryQuality(items: QualityItem[]): QualityReport {
  const groups = new Map<string, QualityItem[]>();
  for (const item of items) {
    const key = item.source || 'unknown';
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const bySource: Record<string, QualityScopeReport> = {};
  for (const [source, group] of groups) bySource[source] = scoreScope(group);
  return { overall: scoreScope(items), bySource };
}
