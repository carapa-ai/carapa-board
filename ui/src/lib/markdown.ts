/**
 * Return true when Markdown contains a complete CommonMark-style backtick
 * fence. Inline or unfinished runs of backticks stay plain text so ordinary
 * user messages do not unexpectedly switch to Markdown rendering.
 */
export function hasCompleteBacktickFence(markdown: string): boolean {
  let openingLength: number | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (openingLength === null) {
      const opening = line.match(/^ {0,3}(`{3,})([^`]*)$/);
      if (opening) openingLength = opening[1].length;
      continue;
    }

    const closing = line.match(/^ {0,3}(`{3,})[ \t]*$/);
    if (closing && closing[1].length >= openingLength) return true;
  }

  return false;
}

/** Remove Board-owned display provenance without altering authored comments. */
export function stripToolActivityMarkers(markdown: string): string {
  return markdown.replace(
    /^[\t ]*<!--\s*carapa-tool:(?:request|result|error)(?:\s+tool-id="[^"]+")?\s*-->[\t ]*(?:\r?\n|$)/gim,
    '',
  );
}
