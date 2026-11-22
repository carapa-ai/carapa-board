/**
 * Meeting transcript cleanup — collapse Whisper repetition and skip duplicate chunks.
 */

import type { MeetingLanguageScript } from './meeting-languages.js';

function normalizeTranscriptChunk(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

const LATIN_LETTER = /[A-Za-zÀ-ÿĂÂÎȘȚăâîșț]/;
const CYRILLIC_LETTER = /[\u0400-\u04FF]/;

function dominantScript(
  text: string,
): 'latin' | 'cyrillic' | 'mixed' | 'other' {
  const cyrillic = (text.match(new RegExp(CYRILLIC_LETTER.source, 'g')) ?? [])
    .length;
  const latin = (text.match(new RegExp(LATIN_LETTER.source, 'g')) ?? []).length;
  const letters = cyrillic + latin;
  if (letters === 0) return 'other';
  if (cyrillic > latin * 2) return 'cyrillic';
  if (latin > cyrillic * 2) return 'latin';
  return 'mixed';
}

/** Drop Cyrillic word runs — common Whisper hallucination on Romanian audio. */
function stripCyrillicRuns(text: string): string {
  return text
    .replace(/[^\s]*[\u0400-\u04FF]+[^\s]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean a meeting transcript chunk: dedupe repetition and strip wrong-script noise.
 */
export function sanitizeMeetingTranscriptChunk(
  text: string,
  priorContext?: string,
  languageScript: MeetingLanguageScript | 'auto' = 'auto',
): string {
  let cleaned = collapseImmediateRepetition(text);
  if (!cleaned) return '';

  const priorScript = priorContext ? dominantScript(priorContext) : null;
  const chunkScript = dominantScript(cleaned);

  if (languageScript === 'latin') {
    cleaned = stripCyrillicRuns(cleaned);
  } else if (
    languageScript === 'auto' &&
    priorScript === 'latin' &&
    chunkScript === 'mixed'
  ) {
    // Auto: strip Cyrillic only when it looks like a hallucination in a Latin session.
    const stripped = stripCyrillicRuns(cleaned);
    if (stripped.length < cleaned.length) cleaned = stripped;
  }

  return cleaned.trim();
}

export function meetingWhisperLanguage(
  language: string | null | undefined,
  fallback?: string,
): string | undefined {
  const lang = language?.trim().toLowerCase();
  if (lang && lang !== 'auto') return lang.split('-')[0]!;
  const fb = fallback?.trim();
  return fb || undefined;
}

export function isDuplicateTranscriptPart(prev: string, next: string): boolean {
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

// Keep at most 100 earlier words when processing the next 100. This bounds
// phrase matching even for a whole meeting without sentence punctuation.
const PHRASE_WINDOW_WORDS = 100;

/** Collapse a phrase repeated mid-chunk without a sentence break. */
function collapseInternalPhraseRepetition(text: string): string {
  const words = normalizeTranscriptChunk(text).split(' ');
  const output: string[] = [];
  for (let start = 0; start < words.length; start += PHRASE_WINDOW_WORDS) {
    const tail = output.splice(
      Math.max(0, output.length - PHRASE_WINDOW_WORDS),
    );
    const window = tail.concat(words.slice(start, start + PHRASE_WINDOW_WORDS));
    output.push(...collapsePhraseWindow(window.join(' ')).split(' '));
  }
  return output.join(' ');
}

function collapsePhraseWindow(t: string): string {
  if (t.length < 20) return t;

  const words = t.split(' ');
  const lowerWords = words.map((word) => word.toLowerCase());
  for (let split = 1; split < words.length; split++) {
    const maxOverlap = Math.min(split, words.length - split);
    for (let i = maxOverlap; i >= 3; i--) {
      if (lowerWords[split - 1] !== lowerWords[split + i - 1]) continue;
      let k = 0;
      while (k < i && lowerWords[split - i + k] === lowerWords[split + k]) k++;
      if (k === i) {
        const merged = [
          ...words.slice(0, split),
          ...words.slice(split + i),
        ].join(' ');
        return collapsePhraseWindow(merged);
      }
    }
  }

  // Z-values allow checking every repeated character prefix in linear time.
  const lower = t.toLowerCase();
  const z = new Uint32Array(lower.length);
  for (let i = 1, left = 0, right = 0; i < lower.length; i++) {
    if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]!);
    while (i + z[i]! < lower.length && lower[z[i]!] === lower[i + z[i]!])
      z[i]!++;
    if (i + z[i]! - 1 > right) {
      left = i;
      right = i + z[i]! - 1;
    }
  }
  for (let len = Math.floor(t.length / 2); len >= 15; len--) {
    const offset = t[len] === ' ' ? len + 1 : len;
    if (z[offset]! >= len) {
      return collapsePhraseWindow(
        `${t.slice(0, len)}${t.slice(offset + len)}`
          .replace(/\s+/g, ' ')
          .trim(),
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

/** Collapse back-to-back repeated sentences/phrases within one Whisper result. */
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

export function joinTranscriptParts(
  ...parts: (string | undefined | null)[]
): string {
  const chunks = parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .map(collapseImmediateRepetition);

  const out: string[] = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (prev) {
      const merged = mergeConsecutiveParts(prev, chunk);
      if (merged) {
        out[out.length - 1] = collapseImmediateRepetition(merged);
        continue;
      }
      if (isDuplicateTranscriptPart(prev, chunk)) continue;
    }
    out.push(chunk);
  }
  return out.join('\n\n');
}

/** Strip a segment prefix that repeats the end of the prior transcript. */
function stripPrefixOverlap(prior: string, segment: string): string {
  const pWords = normalizeTranscriptChunk(prior).split(' ');
  const sWords = normalizeTranscriptChunk(segment).split(' ');
  const prefix = sWords.map((word) => word.toLowerCase());
  const failure = new Uint32Array(prefix.length);
  for (let i = 1, matched = 0; i < prefix.length; i++) {
    while (matched && prefix[i] !== prefix[matched])
      matched = failure[matched - 1]!;
    if (prefix[i] === prefix[matched]) matched++;
    failure[i] = matched;
  }
  let overlapWords = 0;
  for (const word of pWords) {
    const lower = word.toLowerCase();
    while (
      overlapWords &&
      (overlapWords === prefix.length || lower !== prefix[overlapWords])
    ) {
      overlapWords = failure[overlapWords - 1]!;
    }
    if (lower === prefix[overlapWords]) overlapWords++;
  }
  if (overlapWords === 0) return segment.trim();
  return sWords.slice(overlapWords).join(' ').trim();
}

/** Merge a resumed session segment onto an earlier transcript. */
export function mergeMeetingTranscripts(
  prior: string,
  segment: string,
): string {
  const p = prior.trim();
  const s = collapseImmediateRepetition(segment.trim());
  if (!p) return s;
  if (!s) return p;

  const stripped = stripPrefixOverlap(p, s);
  if (!stripped) return p;
  if (isDuplicateTranscriptPart(p, stripped)) return p;

  return `${p}\n\n${stripped}`;
}
