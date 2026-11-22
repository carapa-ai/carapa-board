/**
 * Shared dataTransfer MIME types for drag & drop into the chat input.
 *
 * The chat drop target (chat-page.tsx) reads these on `drop`; the producers
 * (the Files tree, the preview tab strip, the preview body) set them on
 * `dragstart`. Keeping the strings in one place prevents the producer and
 * consumer from drifting apart — a renamed type would otherwise silently
 * break the drop with no type error.
 */

/**
 * Carries the raw repo/group-relative file path. Set by the Files tree rows
 * and by the preview tab strip so a file can be dragged into the chat input
 * as an `@<path>` mention. `text/plain` is also set to `@<path>` so dropping
 * into a plain text editor yields something useful.
 */
export const FILE_DRAG_TYPE = 'application/x-carapa-file';

/**
 * Carries a JSON {@link PreviewSelectionPayload} for a text selection dragged
 * out of the file preview pane. The chat drop target turns it into a file
 * reference (`@<path> (lines a-b)` when line numbers are available) followed
 * by the selected text in a fenced code block.
 */
export const PREVIEW_SELECTION_DRAG_TYPE = 'application/x-carapa-preview-selection';

export interface PreviewSelectionPayload {
  /** Repo/group-relative path of the file the selection came from. Absent
   *  for back-compat tabs opened without a path. */
  path?: string;
  /** The selected text, verbatim. */
  text: string;
  /** 1-based line number of the first selected line, or null when the
   *  selection's line range can't be mapped to source lines (e.g. rendered
   *  markdown, or the chunked large-file renderer). */
  startLine: number | null;
  /** 1-based line number of the last selected line, or null. */
  endLine: number | null;
}
