/** Return the exclusive end offset of a balanced JSON object. */
export function findBalancedJsonEnd(
  output: string,
  start: number,
): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index++) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index + 1;
  }
  return null;
}
