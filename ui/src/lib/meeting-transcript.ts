/** Client-side meeting transcript cleanup (mirrors backend meeting-transcript.ts). */

function normalizeTranscriptChunk(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isDuplicateTranscriptPart(prev: string, next: string): boolean {
  const a = normalizeTranscriptChunk(prev).toLowerCase();
  const b = normalizeTranscriptChunk(next).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (
    minLen >= 12 &&
    minLen / maxLen >= 0.85 &&
    (a.includes(b) || b.includes(a))
  ) {
    return true;
  }
  return false;
}

function isRepeatedSentence(prev: string, next: string): boolean {
  if (isDuplicateTranscriptPart(prev, next)) return true;
  const p = normalizeTranscriptChunk(prev).toLowerCase();
  const n = normalizeTranscriptChunk(next).toLowerCase();
  return n.length >= 8 && p.endsWith(n);
}

function collapseInternalPhraseRepetition(text: string): string {
  const t = normalizeTranscriptChunk(text);
  if (t.length < 20) return t;

  const words = t.split(' ');
  const lower = words.map((w) => w.toLowerCase());
  for (let split = 1; split < words.length; split++) {
    // Largest overlap (>= 3 words) where the i words before `split` equal the i words after it.
    const maxOverlap = Math.min(split, words.length - split);
    let overlapWords = 0;
    for (let i = maxOverlap; i >= 3 && !overlapWords; i--) {
      if (lower[split - 1] !== lower[split + i - 1]) continue;
      let k = 0;
      while (k < i && lower[split - i + k] === lower[split + k]) k++;
      if (k === i) overlapWords = i;
    }
    if (overlapWords >= 3) {
      const merged = [
        ...words.slice(0, split),
        ...words.slice(split + overlapWords),
      ].join(' ');
      return collapseInternalPhraseRepetition(merged);
    }
  }

  for (let len = Math.floor(t.length / 2); len >= 15; len--) {
    const prefix = t.slice(0, len);
    const rest = t.slice(len).trimStart();
    if (rest.toLowerCase().startsWith(prefix.toLowerCase())) {
      return collapseInternalPhraseRepetition(
        `${prefix}${rest.slice(prefix.length)}`.replace(/\s+/g, ' ').trim(),
      );
    }
  }

  return t;
}

function mergeConsecutiveParts(prev: string, next: string): string | null {
  const p = normalizeTranscriptChunk(prev);
  const n = normalizeTranscriptChunk(next);
  const pLower = p.toLowerCase();
  const nLower = n.toLowerCase();
  if (nLower.startsWith(pLower) && n.length > p.length) return n;
  if (pLower.startsWith(nLower) && p.length >= n.length) return p;
  return null;
}

function collapseImmediateRepetition(text: string): string {
  let trimmed = collapseInternalPhraseRepetition(text.trim());
  if (!trimmed) return trimmed;

  const sentences = trimmed.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (sentences.length >= 2) {
    const deduped: string[] = [];
    for (const sentence of sentences) {
      const collapsed = collapseInternalPhraseRepetition(sentence);
      const prev = deduped[deduped.length - 1];
      if (prev && isRepeatedSentence(prev, collapsed)) continue;
      deduped.push(collapsed);
    }
    if (deduped.length < sentences.length) {
      return deduped.join(' ');
    }
    trimmed = deduped.join(' ');
  }

  const words = trimmed.split(/\s+/);
  if (words.length >= 4 && words.length % 2 === 0) {
    const mid = words.length / 2;
    const first = words.slice(0, mid).join(' ');
    const second = words.slice(mid).join(' ');
    if (isDuplicateTranscriptPart(first, second)) return first;
  }

  return collapseInternalPhraseRepetition(trimmed);
}

/** Words at the end of a transcript that are re-collapsed on every update. */
const COLLAPSE_TAIL_WORDS = 200;

/**
 * Collapse repetition only in the last COLLAPSE_TAIL_WORDS words. Earlier text was already
 * cleaned by the server, so re-scanning it on every live update would be needlessly costly.
 */
function collapseTailRepetition(text: string): string {
  const trimmed = text.trim();
  let words = 0;
  let inWord = false;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (/\s/.test(trimmed[i]!)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      if (++words > COLLAPSE_TAIL_WORDS) {
        const head = trimmed.slice(0, i + 1);
        const tail = trimmed.slice(i + 1);
        const gap = /^\s*/.exec(tail)![0];
        return head + gap + collapseImmediateRepetition(tail.trimStart());
      }
    }
  }
  return collapseImmediateRepetition(trimmed);
}

export function joinTranscriptParts(
  ...parts: (string | null | undefined)[]
): string {
  const chunks = parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .map(collapseTailRepetition);

  const out: string[] = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (prev) {
      const merged = mergeConsecutiveParts(prev, chunk);
      if (merged) {
        out[out.length - 1] = collapseTailRepetition(merged);
        continue;
      }
      if (isDuplicateTranscriptPart(prev, chunk)) continue;
    }
    out.push(chunk);
  }
  return out.join('\n\n');
}
