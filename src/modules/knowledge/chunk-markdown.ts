const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Split Markdown without discarding source text. Size and overlap are character budgets. */
export function chunkMarkdown(
  text: string,
  size = 1000,
  overlap = 100,
): string[] {
  if (
    !Number.isInteger(size) ||
    size < 2 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= size
  ) {
    throw new RangeError(
      'Chunk size must be at least 2 and overlap must be smaller than size',
    );
  }
  if (!text.trim()) return [];

  // Keep paragraphs, list items, table rows and fenced code together where possible.
  // Retain original whitespace (including CRLF) and Markdown syntax.
  const blocks: string[] = [];
  let block = '';
  let fence: string | undefined;
  const flush = () => {
    if (block) blocks.push(block);
    block = '';
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)/);
    if (fence) {
      block += line;
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = undefined;
        flush();
      }
      continue;
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      flush();
      fence = marker[1];
      block = line;
      continue;
    }
    if (/^ {0,3}(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?|\|)/.test(line)) flush();
    block += line;
    if (!line.trim()) flush();
  }
  flush();

  // Oversized prose is split at sentences, then whitespace. Only an individual
  // unbroken token can require a hard cut; do not cut a UTF-16 surrogate pair.
  const splitWords = (value: string, budget = size): string[] => {
    const parts: string[] = [];
    let rest = value;
    while (rest.length > budget) {
      const prefix = rest.slice(0, budget);
      const boundaries = [...prefix.matchAll(/\s+/g)];
      const last = boundaries.at(-1);
      let end = last && last.index! > 0 ? last.index! + last[0].length : budget;
      if (
        /[\uD800-\uDBFF]/.test(rest[end - 1]) &&
        /[\uDC00-\uDFFF]/.test(rest[end])
      )
        end--;
      parts.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (rest) parts.push(rest);
    return parts;
  };
  const splitProse = (value: string): string[] =>
    [...sentences.segment(value)].flatMap(({ segment }) =>
      segment.length <= size ? [segment] : splitWords(segment),
    );
  const units = blocks.flatMap((value) => {
    if (value.length <= size) return [value];
    // Repeat the fence and language on oversized code blocks so each excerpt
    // still renders as code. The payload is split by lines, then words if needed.
    const lines = value.match(/[^\n]*\n|[^\n]+$/g) || [];
    const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n$/);
    const closing = lines
      .at(-1)
      ?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/);
    if (
      opening &&
      closing &&
      lines.length > 1 &&
      closing[1][0] === opening[1][0] &&
      closing[1].length >= opening[1].length
    ) {
      const first = lines[0]!;
      const last = lines[lines.length - 1];
      const newline = first.endsWith('\r\n') ? '\r\n' : '\n';
      const budget = size - first.length - last.length - newline.length;
      if (budget >= 2) {
        const parts: string[] = [];
        let body = '';
        const emit = () => {
          parts.push(
            first + body + (body.endsWith('\n') ? '' : newline) + last,
          );
          body = '';
        };
        for (const line of lines.slice(1, -1)) {
          for (const piece of splitWords(line, budget)) {
            if (body.length + piece.length > budget) emit();
            body += piece;
          }
        }
        if (body) emit();
        return parts;
      }
    }
    // Line boundaries take precedence for code, lists, quotes and tables.
    if (
      /^ {0,3}(?:`{3,}|~{3,}|[-+*]\s|\d+[.)]\s|>|\|)/.test(value) ||
      /^(?: {4}|\t)/.test(value)
    ) {
      return (value.match(/[^\n]*\n|[^\n]+$/g) || []).flatMap((line) =>
        line.length <= size ? [line] : splitWords(line),
      );
    }
    return splitProse(value);
  });

  // Avoid leaving a standalone heading behind when its following unit fits.
  for (let i = units.length - 2; i >= 0; i--) {
    if (
      /^ {0,3}#{1,6}[^\n]*\n\s*$/.test(units[i]) &&
      units[i].length + units[i + 1].length <= size
    ) {
      units.splice(i, 2, units[i] + units[i + 1]);
    }
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const unit of units) {
    if (length + unit.length > size) {
      if (current.join('').trim()) chunks.push(current.join(''));
      // Overlap only complete units, never a character slice of a sentence.
      const tail: string[] = [];
      let tailLength = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const nextLength = tailLength + current[i].length;
        if (nextLength > overlap || nextLength + unit.length > size) break;
        tail.unshift(current[i]);
        tailLength = nextLength;
      }
      current = tail;
      length = tailLength;
    }
    current.push(unit);
    length += unit.length;
  }
  if (current.join('').trim()) chunks.push(current.join(''));
  return chunks;
}
