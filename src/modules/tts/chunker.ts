/**
 * Split already-normalized text into sentence-ish chunks for pseudo-streaming TTS.
 *
 * Pseudo-streaming lives here (and in the route), not in the TTS server: we split
 * the reply into chunks, synthesize each sequentially, and emit them as they are
 * ready so the client starts playing chunk 0 while the rest render.
 *
 * Each chunk is <= maxChars and never splits inside a word. Sentence boundaries
 * (. ! ? … : ; —, plus newlines collapsed to spaces) are preferred; a single sentence
 * longer than maxChars is hard-wrapped on whitespace as a fallback.
 */
export function chunkForTts(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  // Sentences keep their trailing punctuation (and any closing quote/bracket).
  // Punctuation only ends a sentence before whitespace or the end of the text,
  // so "3.14", "10:30" and "example.com" are not split apart (which would make
  // the joined chunk read "3. 14"), and leading punctuation is not dropped.
  const sentences = clean.match(
    /\S.*?[.!?…:;—]+(?:["'’”»)\]]+)?(?=\s|$)|\S.*$/g,
  ) ?? [clean];

  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      flush();
      chunks.push(...hardWrap(sentence, maxChars));
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > maxChars) flush();
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  flush();
  return chunks;
}

/** Whether a chunk ends at a natural punctuation boundary rather than a hard wrap. */
export function endsAtTtsBoundary(text: string): boolean {
  return /[.!?…:;—]+(?:["'’”»)\]]+)?$/.test(text.trim());
}

function hardWrap(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of sentence.split(' ')) {
    if (cur && cur.length + 1 + word.length > maxChars) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}
