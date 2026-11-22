/**
 * Tokenizer for keyword memory search.
 *
 * Unlike `wordOverlap` (whitespace-only splitting, relied on by dedupe and
 * maintenance thresholds), this splits on surrounding punctuation so tokens such
 * as `` `drizzle` `` or `PostgreSQL/Drizzle` match plain query words, while
 * keeping inner `-`, `_` and `.` so identifiers like `task-1791836412964-8phica`
 * and `db-memories.ts` stay whole.
 */

const MIN_TERM_LENGTH = 3;
const MAX_QUERY_TERMS = 16;

// Whitespace, quotes, brackets, and separator punctuation. `-`, `_` and `.` are
// deliberately absent: they are kept inside tokens and trimmed at token edges.
const SEPARATORS = /[\s`"'“”‘’()[\]{}<>,;:/\\=|!?*#~^@&+]+/;
const EDGE_JOINERS = /^[.\-_]+|[.\-_]+$/g;

function tokenizeSearchTerms(
  text: string,
  maxTerms: number = Infinity,
): string[] {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(SEPARATORS)) {
    const term = raw.replace(EDGE_JOINERS, '');
    if (term.length < MIN_TERM_LENGTH) continue;
    terms.add(term);
    if (terms.size >= maxTerms) break;
  }
  return [...terms];
}

/**
 * English function words that match nearly every memory as a substring and
 * would flood the SQL candidate set. Dropped from query terms only.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'with',
  'that',
  'this',
  'from',
  'but',
  'not',
  'has',
  'have',
  'had',
  'its',
  'into',
  'our',
  'you',
  'your',
  'all',
  'any',
  'can',
  'did',
  'does',
  'how',
  'why',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'would',
  'should',
  'could',
  'been',
  'being',
  'than',
  'then',
  'them',
  'they',
  'there',
  'these',
  'those',
  'also',
  'just',
  'only',
  'over',
  'such',
  'very',
  'each',
  'more',
  'most',
  'some',
  'about',
  'after',
  'before',
  'onto',
  'upon',
  'while',
]);

/**
 * Distinct search terms of a user query, capped at 16, without stopwords. A
 * query made only of stopwords keeps them so it still searches.
 */
export function tokenizeQueryTerms(query: string): string[] {
  const terms = tokenizeSearchTerms(query);
  const meaningful = terms.filter((term) => !QUERY_STOPWORDS.has(term));
  return (meaningful.length > 0 ? meaningful : terms).slice(0, MAX_QUERY_TERMS);
}

/**
 * Adds a text token and every contiguous run of its `-`/`_`/`.` separated
 * pieces (re-joined with the original separators), so `pg-backend.ts` also
 * yields `pg-backend`, `backend.ts` and `backend`. Single pieces shorter than
 * `MIN_TERM_LENGTH` are skipped. No prefix or stem matching.
 */
function addTokenParts(token: string, out: Set<string>): void {
  out.add(token);
  const pieces = token.split(/[-_.]+/);
  if (pieces.length < 2) return;
  const seps = token.match(/[-_.]+/g) ?? [];
  for (let i = 0; i < pieces.length; i++) {
    let run = pieces[i];
    if (run.length >= MIN_TERM_LENGTH) out.add(run);
    for (let j = i + 1; j < pieces.length; j++) {
      run += seps[j - 1] + pieces[j];
      out.add(run);
    }
  }
}

/**
 * Share of the smaller term set that appears in both (0-1). A query term hits
 * when it equals a whole text token or a contiguous run of that token's
 * `-`/`_`/`.` pieces (e.g. `lxbwjc` matches `task-1791836412964-lxbwjc`). The
 * denominator counts whole text tokens, not the expanded pieces.
 */
export function termOverlap(
  queryTerms: readonly string[],
  text: string,
): number {
  if (queryTerms.length === 0) return 0;
  const tokens = tokenizeSearchTerms(text);
  if (tokens.length === 0) return 0;
  const lookup = new Set<string>();
  for (const token of tokens) addTokenParts(token, lookup);
  let hits = 0;
  for (const term of queryTerms) {
    if (lookup.has(term)) hits++;
  }
  return Math.min(1, hits / Math.min(queryTerms.length, tokens.length));
}

/**
 * Term frequencies of a text for BM25: every whole token plus its `-`/`_`/`.`
 * pieces (the same matches `termOverlap` accepts), and the document length in
 * whole tokens. Tokens are distinct, so a term's frequency is the number of
 * tokens that equal it or contain it as a piece run.
 */
export function termFrequencies(text: string): {
  tf: Map<string, number>;
  length: number;
} {
  const tokens = tokenizeSearchTerms(text);
  const tf = new Map<string, number>();
  for (const token of tokens) {
    const parts = new Set<string>();
    addTokenParts(token, parts);
    for (const part of parts) tf.set(part, (tf.get(part) ?? 0) + 1);
  }
  return { tf, length: tokens.length };
}

/** Escape LIKE/ILIKE wildcards (`%`, `_`) and the escape character itself. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
