/** Minimal line diff for proposal previews. Output is "+", "-" or " " prefixed lines. */

/** Beyond this product the LCS table is skipped and the whole file is shown replaced. */
const MAX_LCS_CELLS = 4_000_000;
const CONTEXT = 3;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function editScript(
  a: string[],
  b: string[],
): Array<[' ' | '+' | '-', string]> {
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((line): [' ' | '+' | '-', string] => ['-', line]),
      ...b.map((line): [' ' | '+' | '-', string] => ['+', line]),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const script: Array<[' ' | '+' | '-', string]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      script.push([' ', a[i]]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      script.push(['-', a[i]]);
      i += 1;
    } else {
      script.push(['+', b[j]]);
      j += 1;
    }
  }
  for (; i < a.length; i += 1) script.push(['-', a[i]]);
  for (; j < b.length; j += 1) script.push(['+', b[j]]);
  return script;
}

/**
 * Every changed line with a few lines of context; unchanged stretches become
 * "…". Never truncated: Approve must not authorize content the user could not read.
 */
export function lineDiff(before: string, after: string): string {
  const script = editScript(splitLines(before), splitLines(after));
  const keep = new Array<boolean>(script.length).fill(false);
  script.forEach(([op], index) => {
    if (op === ' ') return;
    for (
      let k = Math.max(0, index - CONTEXT);
      k <= Math.min(script.length - 1, index + CONTEXT);
      k += 1
    ) {
      keep[k] = true;
    }
  });
  const out: string[] = [];
  let skipped = false;
  script.forEach(([op, line], index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push('…');
    skipped = false;
    out.push(`${op}${line}`);
  });
  return out.join('\n');
}
