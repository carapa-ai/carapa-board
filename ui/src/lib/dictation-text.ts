export interface DictationInsertion {
  text: string;
  start: number;
  end: number;
}

/** Build a caret-safe insertion while retaining punctuation and surrounding
 * user edits. The browser applies this with setRangeText(..., 'end'). */
export function dictatedTextInsertion(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  phrase: string,
): DictationInsertion | null {
  const spoken = phrase.trim();
  if (!spoken) return null;
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace =
    before && !/\s$/.test(before) && !/^[,.;:!?)]/.test(spoken) ? ' ' : '';
  const trailingSpace =
    after && !/^\s/.test(after) && !/[([{]$/.test(spoken) ? ' ' : '';
  return {
    text: `${leadingSpace}${spoken}${trailingSpace}`,
    start,
    end,
  };
}
