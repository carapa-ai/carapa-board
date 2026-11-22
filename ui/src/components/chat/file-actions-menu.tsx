import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  Link,
  MoreHorizontal,
  Pencil,
  SquareArrowOutUpRight,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { downloadFileContent } from '@/lib/api';
import type { FileExplorerEntry } from '@/types';

/** What a source lets the user do with one of its rows. */
export interface FileEntryActions {
  /**
   * Download source for a file; omitted entries have no Download item. A
   * `direct` URL serves the raw file and is linked as is; any other URL is a
   * file-content endpoint whose text envelope is decoded before saving.
   */
  download?: (
    entry: FileExplorerEntry,
  ) => { url: string; direct?: boolean } | undefined;
  /**
   * App path (`/chat/<project>?file=…`) that opens a file in the chat preview
   * panel. Omitted when the source or project cannot be deep-linked, which
   * hides Open in new tab and Copy link and disables modifier-click.
   */
  link?: (entry: FileExplorerEntry) => string | undefined;
  /**
   * The `@path` reference that dragging the row into the composer inserts;
   * entries without one have no Copy path item.
   */
  reference?: (entry: FileExplorerEntry) => string | undefined;
  /** Personal favorites: files get Add to / Remove from favorites by current state. */
  favorite?: {
    isFavorite: (entry: FileExplorerEntry) => boolean;
    toggle: (entry: FileExplorerEntry) => void;
  };
  /** Rename, Move… and Delete; read-only sources leave it out. */
  edit?: {
    /** Per entry, so a viewer's rows stay read-only (items are hidden). */
    canManage: (entry: FileExplorerEntry) => boolean;
    /** Resolves true when renamed; the implementation reports failures itself. */
    rename: (entry: FileExplorerEntry, newName: string) => Promise<boolean>;
    /** Opens the destination picker; the implementation moves and reports failures. */
    move: (entry: FileExplorerEntry) => void;
    remove: (entry: FileExplorerEntry) => void | Promise<void>;
  };
}

const LONG_PRESS_MS = 500;

/**
 * Context menu, keyboard shortcuts and inline rename state for one explorer
 * row. `rowProps` go on the row's main button, `menu` renders next to it (its
 * parent must be `relative`), and `renameField` replaces the button while
 * `renaming`.
 */
export function useFileEntryMenu(
  actions: FileEntryActions | undefined,
  entry: FileExplorerEntry,
  open: () => void,
) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressedAt = useRef(0);
  const wasRenaming = useRef(false);
  const edit = actions?.edit?.canManage(entry) ? actions.edit : undefined;
  const isFile = entry.kind === 'file';
  const favorite = isFile ? actions?.favorite : undefined;
  const reference = actions?.reference?.(entry);
  const download = isFile ? actions?.download?.(entry) : undefined;
  const link = isFile ? actions?.link?.(entry) : undefined;

  // The row button is replaced while renaming: put focus back when it returns.
  useEffect(() => {
    if (wasRenaming.current && !renaming) rowRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);
  useEffect(() => () => clearTimeout(pressTimer.current), []);

  // A folder row of a source that only offers file items has no menu.
  if (!actions || !(isFile || reference || edit))
    return {
      rowRef,
      rowProps: {},
      menu: null,
      renaming: false,
      renameField: (_icon: ReactNode, _className: string): ReactNode => null,
      guard: (fn: () => void) => fn,
    };

  const stopPress = () => clearTimeout(pressTimer.current);
  const openInNewTab = () => window.open(link, '_blank', 'noopener,noreferrer');
  const rowProps = {
    // Middle-click opens the link tab like Ctrl/Cmd+click does.
    onAuxClick: (event: MouseEvent) => {
      if (link && event.button === 1) {
        event.preventDefault();
        openInNewTab();
      }
    },
    onContextMenu: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      setMenuOpen(true);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (
        (event.shiftKey && event.key === 'F10') ||
        event.key === 'ContextMenu'
      ) {
        event.preventDefault();
        setMenuOpen(true);
      } else if (edit && event.key === 'F2') {
        event.preventDefault();
        setRenaming(true);
      } else if (edit && event.key === 'Delete') {
        event.preventDefault();
        edit.remove(entry);
      }
    },
    onTouchStart: (event: TouchEvent) => {
      stopPress();
      if (event.touches.length !== 1) return;
      pressTimer.current = setTimeout(() => {
        longPressedAt.current = Date.now();
        setMenuOpen(true);
      }, LONG_PRESS_MS);
    },
    onTouchMove: stopPress,
    onTouchEnd: stopPress,
    onTouchCancel: stopPress,
  };
  // A long press must not also activate the row when the finger lifts.
  // Ctrl/Cmd+click opens the file's link in a new tab instead.
  const guard = (fn: () => void) => (event?: MouseEvent) => {
    if (link && (event?.ctrlKey || event?.metaKey)) openInNewTab();
    else if (Date.now() - longPressedAt.current > 1000) fn();
  };
  const later = (fn: () => void) => () => {
    afterClose.current = () => setTimeout(fn, 0);
  };
  const itemClass = 'gap-2 text-xs max-md:min-h-11';
  const copy = async (text: string, done: string, failed: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(done);
    } catch {
      toast.error(failed);
    }
  };
  const menu = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-ui="file-actions-trigger"
          aria-label={`Actions for ${entry.name}`}
          className="absolute right-1 top-0.5 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40"
        data-ui="file-actions-menu"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          rowRef.current?.focus();
          const run = afterClose.current;
          afterClose.current = null;
          run?.();
        }}
      >
        {isFile && (
          <DropdownMenuItem className={itemClass} onSelect={open}>
            <SquareArrowOutUpRight className="size-3" />
            Open
          </DropdownMenuItem>
        )}
        {download?.direct ? (
          <DropdownMenuItem asChild>
            <a className={itemClass} href={download.url} download={entry.name}>
              <Download className="size-3" />
              Download
            </a>
          </DropdownMenuItem>
        ) : (
          download && (
            <DropdownMenuItem
              className={itemClass}
              onSelect={() =>
                void downloadFileContent(download.url, entry.name).catch(() =>
                  toast.error(`Could not download ${entry.name}`),
                )
              }
            >
              <Download className="size-3" />
              Download
            </DropdownMenuItem>
          )
        )}
        {link && (
          <>
            <DropdownMenuItem asChild>
              <a
                className={itemClass}
                href={link}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-3" />
                Open in new tab
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={itemClass}
              onSelect={() =>
                void copy(
                  new URL(link, window.location.origin).href,
                  'Link copied',
                  'Could not copy the link',
                )
              }
            >
              <Link className="size-3" />
              Copy link
            </DropdownMenuItem>
          </>
        )}
        {reference && (
          <DropdownMenuItem
            className={itemClass}
            onSelect={() =>
              void copy(reference, 'Copied', 'Could not copy the path')
            }
          >
            <Copy className="size-3" />
            Copy path
          </DropdownMenuItem>
        )}
        {favorite && (
          <DropdownMenuItem
            className={itemClass}
            onSelect={() => favorite.toggle(entry)}
          >
            {favorite.isFavorite(entry) ? (
              <>
                <StarOff className="size-3" />
                Remove from favorites
              </>
            ) : (
              <>
                <Star className="size-3" />
                Add to favorites
              </>
            )}
          </DropdownMenuItem>
        )}
        {edit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={itemClass}
              onSelect={later(() => setRenaming(true))}
            >
              <Pencil className="size-3" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className={itemClass}
              onSelect={later(() => edit.move(entry))}
            >
              <FolderInput className="size-3" />
              Move…
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              className={itemClass}
              onSelect={later(() => edit.remove(entry))}
            >
              <Trash2 className="size-3" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return {
    rowRef,
    rowProps,
    menu,
    renaming,
    guard,
    renameField: (icon: ReactNode, className: string) => (
      <RenameField
        entry={entry}
        icon={icon}
        className={className}
        onSubmit={(name) => edit!.rename(entry, name)}
        onDone={() => setRenaming(false)}
      />
    ),
  };
}

/** Inline name editor: Enter saves, Esc or blur cancels, errors keep it open. */
function RenameField({
  entry,
  icon,
  className,
  onSubmit,
  onDone,
}: {
  entry: FileExplorerEntry;
  icon: ReactNode;
  className: string;
  onSubmit: (name: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Keep the extension out of the initial selection.
    const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry.kind, entry.name]);
  const submit = async () => {
    const name = input.current?.value.trim() ?? '';
    if (!name || name === entry.name) return onDone();
    busy.current = true;
    const ok = await onSubmit(name);
    busy.current = false;
    if (ok) onDone();
    else input.current?.focus();
  };
  return (
    <div data-ui="file-rename" className={className}>
      {icon}
      <Input
        compact
        ref={input}
        defaultValue={entry.name}
        aria-label={`Rename ${entry.name}`}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => {
          if (!busy.current) onDone();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!busy.current) void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
      />
    </div>
  );
}
