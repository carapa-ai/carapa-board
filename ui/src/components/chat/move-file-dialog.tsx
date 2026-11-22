import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Folder, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { listGroupFiles } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** One pending Move…: the entry (group-relative path) and how to perform it. */
export interface MoveRequest {
  name: string;
  path: string;
  /** Moves into the group-relative `destination` folder; resolves true when moved. */
  move: (destination: string) => Promise<boolean>;
}

// Mirrors PROTECTED_GROUP_PATHS and the destination rules of
// `src/lib/group-file-ops.ts`, which stay authoritative (the server answers 403).
const PROTECTED_ROOT = [
  '.agent',
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
  '.pi',
  '.omp',
  '.carapa',
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mcp.json',
  'opencode.json',
  'queue.json',
  'session-log.jsonl',
  'transcripts',
  'session-transcripts',
  'logs',
  'recordings',
];
const PROTECTED_OBJECTIVE = [
  '.agent',
  '.agents',
  '.claude',
  'state.json',
  'events.jsonl',
  'decisions.jsonl',
  'dashboard',
  'run-stats.jsonl',
  'board-cost-metrics.json',
  'board-cost-report.json',
  'board-brain-state-events.json',
];

/**
 * How the picker treats a folder: `hidden` (the server refuses it and
 * everything below), `browse` (`objectives`, `objectives/<id>`: expandable but
 * not a destination) or `ok`. Direct child project folders are board-owned.
 */
function destinationRule(
  path: string,
  childFolders: readonly string[],
): 'hidden' | 'browse' | 'ok' {
  const [top, , third] = path.split('/');
  if (top === 'artifacts') return 'ok';
  if (top === 'objectives') {
    if (third !== undefined && PROTECTED_OBJECTIVE.includes(third))
      return 'hidden';
    return path.split('/').length <= 2 ? 'browse' : 'ok';
  }
  return PROTECTED_ROOT.includes(top) || childFolders.includes(top)
    ? 'hidden'
    : 'ok';
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

interface Shared {
  project_id: string;
  source: string;
  /** The source's current parent folder: greyed, not a destination. */
  currentParent: string;
  childFolders: readonly string[];
  initiallyExpanded: ReadonlySet<string>;
  selected: string | null;
  setSelected: (path: string) => void;
  active: string;
  setActive: (key: string) => void;
}

const rowClass =
  'flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md pr-2 text-left text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11';

/** Roving-tabindex keyboard model over the DOM-ordered visible tree items. */
function navigate(row: HTMLElement, key: string): boolean {
  const items = [
    ...row
      .closest('[role="tree"]')!
      .querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ];
  const at = items.indexOf(row);
  const level = Number(row.getAttribute('aria-level'));
  let target: HTMLElement | undefined;
  if (key === 'ArrowDown') target = items[at + 1];
  else if (key === 'ArrowUp') target = items[at - 1];
  else if (key === 'Home') target = items[0];
  else if (key === 'End') target = items[items.length - 1];
  else if (key === 'ArrowRight') {
    const next = items[at + 1];
    if (next && Number(next.getAttribute('aria-level')) > level) target = next;
  } else if (key === 'ArrowLeft')
    target = items
      .slice(0, at)
      .reverse()
      .find((item) => Number(item.getAttribute('aria-level')) < level);
  target?.focus();
  return !!target;
}

function Row({
  shared,
  rowKey,
  level,
  expanded,
  selectable,
  muted,
  onToggle,
  onActivate,
  children,
  path,
}: {
  shared: Shared;
  rowKey: string;
  level: number;
  /** undefined for a leaf. */
  expanded?: boolean;
  selectable: boolean;
  muted?: boolean;
  onToggle?: () => void;
  onActivate: () => void;
  children: ReactNode;
  path?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const { key } = event;
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      onActivate();
    } else if (key === 'ArrowRight' && expanded === false) {
      event.preventDefault();
      onToggle?.();
    } else if (key === 'ArrowLeft' && expanded === true) {
      event.preventDefault();
      onToggle?.();
    } else if (
      [
        'ArrowDown',
        'ArrowUp',
        'ArrowRight',
        'ArrowLeft',
        'Home',
        'End',
      ].includes(key)
    ) {
      event.preventDefault();
      navigate(event.currentTarget, key);
    }
  };
  return (
    <div
      role="treeitem"
      data-ui="move-target"
      data-path={path}
      aria-level={level}
      aria-expanded={expanded}
      aria-selected={selectable ? shared.selected === path : undefined}
      aria-disabled={path !== undefined && !selectable ? true : undefined}
      tabIndex={shared.active === rowKey ? 0 : -1}
      onFocus={() => shared.setActive(rowKey)}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      style={{ paddingLeft: `${(level - 1) * 16 + 4}px` }}
      className={`${rowClass} ${
        selectable && shared.selected === path
          ? 'bg-primary/15 font-medium'
          : ''
      } ${muted ? 'text-muted-foreground' : ''}`}
    >
      {children}
    </div>
  );
}

function FolderNode({
  shared,
  path,
  name,
  level,
}: {
  shared: Shared;
  path: string;
  name: string;
  level: number;
}) {
  const [expanded, setExpanded] = useState(shared.initiallyExpanded.has(path));
  const rule = destinationRule(path, shared.childFolders);
  const current = path === shared.currentParent;
  const selectable = rule === 'ok' && !current;
  const folders = useInfiniteQuery({
    queryKey: queryKeys.groupMoveTargets.folder(shared.project_id, path),
    queryFn: ({ pageParam }) =>
      listGroupFiles(shared.project_id, {
        path,
        cursor: pageParam,
        limit: 100,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: expanded,
  });
  const toggle = () => setExpanded((open) => !open);
  const moreKey = `${path}\0more`;
  const hasMore = !!folders.hasNextPage;
  const { active, setActive } = shared;
  // The Load more row unmounts with the last page, dropping focus and the
  // roving tab stop: hand both to this folder's row.
  useEffect(() => {
    if (hasMore || active !== moreKey) return;
    setActive(path);
    const focused = document.activeElement;
    if (!focused || focused === document.body)
      document
        .querySelector<HTMLElement>(
          `[data-ui="move-target"][data-path="${CSS.escape(path)}"]`,
        )
        ?.focus();
  }, [hasMore, active, moreKey, path, setActive]);
  const children = (folders.data?.pages ?? [])
    .flatMap((page) => page.entries)
    .filter(
      (entry) =>
        entry.kind === 'directory' &&
        entry.path !== shared.source &&
        destinationRule(entry.path, shared.childFolders) !== 'hidden',
    );
  return (
    <>
      <Row
        shared={shared}
        rowKey={path}
        path={path}
        level={level}
        expanded={expanded}
        selectable={selectable}
        muted={!selectable}
        onToggle={toggle}
        onActivate={selectable ? () => shared.setSelected(path) : toggle}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-ui="move-target-toggle"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted max-md:h-11 max-md:w-11"
          onClick={(event) => {
            event.stopPropagation();
            shared.setActive(path);
            toggle();
          }}
        >
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
        <Folder className="size-4 shrink-0 text-primary/80" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {current && <span className="shrink-0 text-[10px]">current</span>}
      </Row>
      {expanded &&
        (folders.isLoading ? (
          <div
            role="none"
            className="p-2"
            style={{ paddingLeft: level * 16 + 8 }}
          >
            <Loader2 className="size-4 animate-spin" aria-label="Loading" />
          </div>
        ) : folders.isError && !folders.isFetchNextPageError ? (
          <p
            role="none"
            className="p-2 text-xs text-destructive"
            style={{ paddingLeft: level * 16 + 8 }}
          >
            Could not load folder.{' '}
            <button
              type="button"
              className="underline max-md:min-h-11 max-md:px-2"
              onClick={() => void folders.refetch()}
            >
              Retry
            </button>
          </p>
        ) : (
          <>
            {children.map((entry) => (
              <FolderNode
                key={entry.path}
                shared={shared}
                path={entry.path}
                name={entry.name}
                level={level + 1}
              />
            ))}
            {folders.hasNextPage && (
              <Row
                shared={shared}
                rowKey={moreKey}
                level={level + 1}
                selectable={false}
                muted
                onActivate={() => void folders.fetchNextPage()}
              >
                <span
                  data-ui="move-target-load-more"
                  className="pl-9"
                  aria-busy={folders.isFetchingNextPage}
                >
                  {folders.isFetchingNextPage
                    ? 'Loading…'
                    : folders.isFetchNextPageError
                      ? 'Could not load more · Retry'
                      : 'Load more'}
                </span>
              </Row>
            )}
            {!children.length && !folders.hasNextPage && (
              <p
                role="none"
                className="p-2 text-xs text-muted-foreground"
                style={{ paddingLeft: level * 16 + 36 }}
              >
                No subfolders.
              </p>
            )}
          </>
        ))}
    </>
  );
}

/**
 * Destination picker for Move…: a lazy folder tree of the group folder. The
 * dialog stays open while a move fails (the request reports the error) and
 * closes through `onClose` once it succeeded or was cancelled.
 */
export function MoveFileDialog({
  project_id,
  request,
  childFolders,
  onClose,
}: {
  project_id: string;
  request: MoveRequest;
  /** Direct child project folders of this project: the server refuses them. */
  childFolders: readonly string[];
  onClose: () => void;
}) {
  const currentParent = request.path.includes('/')
    ? parentOf(request.path)
    : '';
  const [initiallyExpanded] = useState(() => {
    const open = new Set(['']);
    for (let at = currentParent; at; at = at.includes('/') ? parentOf(at) : '')
      open.add(at);
    return open;
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState('');
  const [busy, setBusy] = useState(false);
  const moved = useRef(false);
  const tree = useRef<HTMLDivElement>(null);
  const submit = async () => {
    if (selected === null || busy) return;
    setBusy(true);
    const ok = await request.move(selected);
    setBusy(false);
    if (ok) {
      moved.current = true;
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        // Cancel closes it; the shared 16 px close icon is below the mobile target size.
        showCloseButton={false}
        data-ui="move-file-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          tree.current
            ?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
            ?.focus();
        }}
        // After a move the caller focuses the moved row; the opener is gone.
        onCloseAutoFocus={(event) => {
          if (moved.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-all">Move {request.name}</DialogTitle>
          <DialogDescription>
            Choose the folder to move it into.
          </DialogDescription>
        </DialogHeader>
        <div
          ref={tree}
          role="tree"
          aria-label="Destination folder"
          data-ui="move-target-tree"
          className="max-h-[50vh] min-h-32 overflow-y-auto rounded-md border p-1"
        >
          <FolderNode
            shared={{
              project_id,
              source: request.path,
              currentParent,
              childFolders,
              initiallyExpanded,
              selected,
              setSelected,
              active,
              setActive,
            }}
            path=""
            name="Group folder"
            level={1}
          />
        </div>
        <p
          aria-live="polite"
          data-ui="move-target-summary"
          className="min-h-4 break-all text-xs text-muted-foreground"
        >
          {selected === null
            ? 'No folder selected.'
            : `Into ${selected || 'the group folder'}`}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            className="max-md:h-11"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            data-ui="move-confirm"
            className="max-md:h-11"
            disabled={selected === null || busy}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
