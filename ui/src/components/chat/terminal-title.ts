/** Longest tab title kept; the tab strip truncates visually beyond its width anyway. */
const MAX_TITLE_LENGTH = 60;

/**
 * Turn a title a program set with OSC 0/2 into tab text.
 *
 * TUIs animate a leading spinner in the title (Codex sends `⠙ project`,
 * `⠹ project`, …); keeping it would repaint the tab many times a second, so
 * leading Braille glyphs are dropped. Control characters are removed. An empty
 * result means "no title", so the tab falls back to its own name.
 */
export function normalizeTerminalTitle(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/^[\s⠀-⣿]+/, '')
    .trim();
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : text;
}
