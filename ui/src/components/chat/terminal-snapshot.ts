/**
 * The attach `replay` event is a `tmux capture-pane` snapshot whose rows are
 * separated by bare `\n`. xterm.js treats `\n` as a pure line feed, so the
 * snapshot needs a carriage return to start each row at column 0.
 *
 * Live output must NOT get this treatment: it is the pane's raw byte stream,
 * and TUIs such as the Antigravity CLI send a bare `\n` followed by a
 * cursor-back (`ESC[35D`) to reach their next column. Rewriting those line
 * feeds (xterm's `convertEol`) misplaces every such row.
 */
export function snapshotToTerminalText(snapshot: string): string {
  return snapshot.replace(/\r?\n/g, '\r\n');
}
