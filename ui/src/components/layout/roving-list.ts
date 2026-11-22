import type { KeyboardEvent } from 'react';

/**
 * Roving-tabindex helpers for the sidebar's lists (projects, "Now").
 *
 * A list is one Tab stop: only the current row's primary control has
 * `tabIndex=0`. Arrow keys move between rows (Up/Down/Home/End) and across a
 * row's own controls (Right/Left: link, then its actions such as the "…" menu
 * and the drag handle). Mark rows with `data-roving-row`, every control with
 * `data-roving-item` (in DOM order) and the main control with
 * `data-roving-primary`.
 */
const ROW = '[data-roving-row]';
const ITEM = '[data-roving-item]';
const PRIMARY = '[data-roving-primary]';

/** Key handler for the list container. `busy` skips keys while dnd-kit owns them. */
export function rovingKeyDown(
  event: KeyboardEvent<HTMLElement>,
  busy = false,
): void {
  if (busy || event.defaultPrevented) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  // Menus are portaled but their keys still bubble through React.
  if (target.closest('[role="menu"], input, textarea, select')) return;
  const row = target.closest<HTMLElement>(ROW);
  // The handler may sit on a control inside the list (the row "…" trigger).
  const root =
    event.currentTarget.closest<HTMLElement>('[data-roving-root]') ??
    event.currentTarget;
  if (!row || !root.contains(row)) return;
  const items = Array.from(row.querySelectorAll<HTMLElement>(ITEM));
  const index = items.indexOf(target);
  if (index < 0) return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW));
  const at = rows.indexOf(row);
  const focusRow = (i: number) =>
    rows[i]?.querySelector<HTMLElement>(PRIMARY)?.focus();

  switch (event.key) {
    case 'ArrowDown':
      if (at < rows.length - 1) focusRow(at + 1);
      break;
    case 'ArrowUp':
      if (at > 0) focusRow(at - 1);
      break;
    case 'Home':
      focusRow(0);
      break;
    case 'End':
      focusRow(rows.length - 1);
      break;
    case 'ArrowRight':
      items[index + 1]?.focus();
      break;
    case 'ArrowLeft':
      items[index - 1]?.focus();
      break;
    default:
      return;
  }
  event.preventDefault();
}

/** The `data-roving-row` value of the row that contains `target`, if any. */
export function rovingRowOf(target: EventTarget): string | null {
  return (
    (target as HTMLElement).closest?.<HTMLElement>(ROW)?.dataset.rovingRow ??
    null
  );
}
