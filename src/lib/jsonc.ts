/** Parse JSON with JavaScript-style comments and trailing commas. */
export function parseJsonc(raw: string): unknown {
  // Both passes skip string literals so `//`, `/*` or `,}` inside a value
  // is left untouched. Comments go first: `1, // note\n}` ends in a trailing comma.
  const withoutComments = raw.replace(
    /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (_match, string) => string || '',
  );
  return JSON.parse(
    withoutComments.replace(
      /("(?:\\.|[^"\\])*")|,(\s*[}\]])/g,
      (_match, string, closer) => string || closer,
    ),
  );
}
