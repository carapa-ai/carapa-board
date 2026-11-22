import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  useInfiniteQuery,
  useIsFetching,
  type UseInfiniteQueryResult,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Grid2X2,
  List,
  Loader2,
  RefreshCw,
  TreePine,
} from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/field-row';
import { WorkspaceToolbar, WorkspaceToolbarRow } from './workspace-toolbar';
import type { FileExplorerEntry } from '@/types';
import { fileIconFor, formatFileSize } from '@/lib/file-type';
import { SecureImage } from '@/components/secure-image';
import { SearchInput } from '@/components/ui/search-input';
import { ImageHoverPreview } from '@/components/image-hover-preview';
import { useFileEntryMenu, type FileEntryActions } from './file-actions-menu';

export type FileExplorerMode = 'tree' | 'list' | 'grid';
const responsiveGridStyle: CSSProperties = {
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
};
interface FileExplorerSort {
  sort: 'name' | 'modified';
  order: 'asc' | 'desc';
}
const VIEW_MODES = [
  { mode: 'tree', label: 'Tree view', Icon: TreePine },
  { mode: 'list', label: 'List view', Icon: List },
  { mode: 'grid', label: 'Grid view', Icon: Grid2X2 },
] as const;

const SORT_OPTIONS: { value: string; label: string; sort: FileExplorerSort }[] =
  [
    {
      value: 'name-asc',
      label: 'Name A→Z',
      sort: { sort: 'name', order: 'asc' },
    },
    {
      value: 'name-desc',
      label: 'Name Z→A',
      sort: { sort: 'name', order: 'desc' },
    },
    {
      value: 'modified-desc',
      label: 'Newest first',
      sort: { sort: 'modified', order: 'desc' },
    },
    {
      value: 'modified-asc',
      label: 'Oldest first',
      sort: { sort: 'modified', order: 'asc' },
    },
  ];
const DEFAULT_SORT_VALUE = 'name-asc';
const SortContext = createContext<FileExplorerSort | undefined>(undefined);
const sortKey = (sort?: FileExplorerSort) =>
  sort ? `${sort.sort}-${sort.order}` : DEFAULT_SORT_VALUE;
function formatModified(modifiedAt: string) {
  return new Date(modifiedAt).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export interface FileExplorerSource {
  id: string;
  label: string;
  /** Lists honour the explorer's sort selection when true. */
  sortable?: boolean;
  list: (
    path: string,
    cursor?: string,
    sort?: FileExplorerSort,
  ) => Promise<{
    entries?: FileExplorerEntry[];
    nextCursor?: string;
    available?: boolean;
    reason?: string;
  }>;
  search?: (
    query: string,
    cursor?: string,
  ) => Promise<{ entries?: FileExplorerEntry[]; nextCursor?: string }>;
  thumbnailUrl?: (entry: FileExplorerEntry) => string | undefined;
  imagePreviewUrl?: (entry: FileExplorerEntry) => string | undefined;
  dragReference?: (
    entry: FileExplorerEntry,
  ) => { payloads: Record<string, string> } | undefined;
  open: (entry: FileExplorerEntry) => void;
  /**
   * Marks caches the source's `list`/`search` read through (beyond the
   * explorer's own queries) as stale, so a manual refresh reaches the server.
   */
  refresh?: () => Promise<void> | void;
  renderDetails?: (
    entry: FileExplorerEntry,
    mode: FileExplorerMode,
  ) => ReactNode;
  renderActions?: (
    entry: FileExplorerEntry,
    mode: FileExplorerMode,
  ) => ReactNode;
  /** Row context menu (Open, Download, Copy path and, when allowed, edits). */
  actions?: FileEntryActions;
}

const rowSelector = (sourceId: string, path?: string) =>
  `[data-source-id="${CSS.escape(sourceId)}"]${
    path === undefined ? '[data-path]' : `[data-path="${CSS.escape(path)}"]`
  }`;

/** A row, by source id and source-relative path. */
export interface ExplorerRowTarget {
  sourceId: string;
  path: string;
}

/**
 * For a row about to disappear or change path (delete, rename, move): remembers
 * the rows around it and returns a function that, once the list has
 * re-rendered, focuses the row at its new place if it is visible (`renamedTo`
 * in the same source, or any of `elsewhere`, e.g. the destination in another
 * section), else a surviving sibling (next, then previous), its parent folder
 * row, or the nearest other row. When none is left (the listing or the search
 * results became empty, or a search no longer matches the renamed file) it
 * falls back to the visible source-root row, the source's refresh button, and
 * finally the search box.
 */
export function focusAfterChange(sourceId: string, path: string) {
  const rows = [
    ...document.querySelectorAll<HTMLElement>(rowSelector(sourceId)),
  ].map((row) => row.dataset.path!);
  const at = rows.indexOf(path);
  const folderOf = (row: string) =>
    row.slice(0, Math.max(row.lastIndexOf('/'), 0));
  const gone = (other: string) =>
    other === path || other.startsWith(`${path}/`);
  const after = rows.slice(at + 1).filter((other) => !gone(other));
  const before = rows
    .slice(0, at)
    .reverse()
    .filter((other) => !gone(other));
  // Same folder first (next, then previous), then its folder row, then any row.
  const siblings = [...after, ...before].filter(
    (other) => folderOf(other) === folderOf(path),
  );
  const survivors = [
    ...siblings,
    ...(folderOf(path) ? [folderOf(path)] : []),
    ...after,
    ...before,
  ];
  const id = CSS.escape(sourceId);
  return (renamedTo?: string, elsewhere: readonly ExplorerRowTarget[] = []) =>
    requestAnimationFrame(() => {
      const selectors = [
        ...(renamedTo === undefined ? [] : [rowSelector(sourceId, renamedTo)]),
        ...elsewhere.map((target) => rowSelector(target.sourceId, target.path)),
        ...survivors.map((other) => rowSelector(sourceId, other)),
        `[data-ui="file-explorer-source-root"][data-source-id="${id}"]`,
        `[data-ui="file-explorer-refresh"][data-source-id="${id}"]`,
        '[data-ui="file-explorer-search"]',
      ];
      for (const selector of selectors)
        for (const el of document.querySelectorAll<HTMLElement>(selector))
          if (el.offsetParent && !(el as HTMLButtonElement).disabled)
            return el.focus();
    });
}

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/**
 * Sentinel at the end of a paged listing: loads the next page once it comes
 * within 200px of the nearest scrolling ancestor. The observer is recreated
 * after every fetch, so a sentinel that stays in view keeps loading pages.
 */
function AutoLoadMore({
  query,
}: {
  query: Pick<
    UseInfiniteQueryResult,
    | 'hasNextPage'
    | 'isFetchingNextPage'
    | 'isFetchNextPageError'
    | 'fetchNextPage'
  >;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  const fetchNextPage = query.fetchNextPage;
  const idle = hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  useEffect(() => {
    const node = ref.current;
    if (!idle || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (hits) => {
        if (!hits.some((hit) => hit.isIntersecting)) return;
        observer.disconnect();
        void fetchNextPage();
      },
      { root: scrollParent(node), rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [idle, fetchNextPage]);
  if (!hasNextPage) return null;
  return (
    <div
      ref={ref}
      data-ui="file-explorer-auto-load"
      aria-live="polite"
      className="flex min-h-9 items-center px-2 text-xs text-muted-foreground"
    >
      {isFetchingNextPage ? (
        'Loading…'
      ) : isFetchNextPageError ? (
        <>
          Couldn't load more ·{' '}
          <button
            type="button"
            className="ml-1 underline"
            onClick={() => void fetchNextPage()}
          >
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

function EntryRow({
  source,
  entry,
  mode,
  depth = 0,
  onNavigate,
}: {
  source: FileExplorerSource;
  entry: FileExplorerEntry;
  mode: FileExplorerMode;
  depth?: number;
  /** Folder click handler for drill-down lists; folders expand in place without it. */
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const entryMenu = useFileEntryMenu(source.actions, entry, () =>
    source.open(entry),
  );
  const sort = useContext(SortContext);
  const children = useInfiniteQuery({
    queryKey: ['fileExplorer', source.id, entry.path, sortKey(sort)],
    queryFn: ({ pageParam }) => source.list(entry.path, pageParam, sort),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && entry.kind === 'directory',
  });
  const marker =
    entry.kind === 'directory' ? 'file-explorer-folder' : 'file-explorer-file';
  // Files and folders share one drag contract: the source decides the payloads
  // (or returns undefined to opt an entry out of dragging).
  const dragProps = {
    draggable: !!source.dragReference?.(entry),
    onDragStart: (event: DragEvent<HTMLButtonElement>) => {
      const reference = source.dragReference?.(entry);
      if (!reference) return;
      for (const [type, value] of Object.entries(reference.payloads)) {
        event.dataTransfer.setData(type, value);
      }
      event.dataTransfer.effectAllowed = 'copy';
    },
  };
  const grid = mode === 'grid';
  const thumbnailUrl = grid ? source.thumbnailUrl?.(entry) : undefined;
  const imagePreviewUrl = source.imagePreviewUrl?.(entry);
  const showModified = !!sort && sort.sort === 'modified' && !!entry.modifiedAt;
  const FileIcon = fileIconFor(entry.name);
  const subtitle =
    entry.origin ?? (entry.path !== entry.name ? entry.path : undefined);
  const size =
    entry.sizeBytes !== undefined ? (
      <span
        data-ui="file-explorer-size"
        className={`shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground ${grid ? '' : 'w-16 text-right'}`}
      >
        {formatFileSize(entry.sizeBytes)}
      </span>
    ) : null;
  const details = (
    <>
      {source.renderDetails?.(entry, mode)}
      {showModified && (
        <time
          data-ui="file-explorer-modified"
          dateTime={entry.modifiedAt}
          className="shrink-0 text-[10px] text-muted-foreground"
        >
          {formatModified(entry.modifiedAt!)}
        </time>
      )}
      {entry.ignored && (
        <span className="shrink-0 rounded bg-muted px-1 text-[9px]">
          ignored
        </span>
      )}
    </>
  );
  if (entry.kind === 'directory') {
    const folderIcon = open ? (
      <FolderOpen className="size-5 shrink-0 text-primary/80" />
    ) : (
      <Folder className="size-5 shrink-0 text-primary/80" />
    );
    const folderClass = grid
      ? 'flex min-h-24 w-full min-w-0 flex-col items-start gap-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20 p-3 text-left transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      : 'flex min-h-10 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
    return (
      <div className="min-w-0">
        <div className="relative min-w-0">
          {entryMenu.renaming ? (
            entryMenu.renameField(folderIcon, folderClass)
          ) : (
            <button
              ref={entryMenu.rowRef}
              data-ui={marker}
              data-source-id={source.id}
              data-path={entry.path}
              {...dragProps}
              {...entryMenu.rowProps}
              onClick={entryMenu.guard(() =>
                onNavigate ? onNavigate() : setOpen(!open),
              )}
              className={`${folderClass} ${source.actions ? 'pr-12' : ''}`}
            >
              {folderIcon}
              <span className="w-full min-w-0 truncate text-xs font-medium">
                {entry.name}
              </span>
            </button>
          )}
          {entryMenu.menu}
        </div>
        {open && (
          <div className="ml-3 border-l border-border/50 pl-1">
            {children.isLoading ? (
              <Loader2 className="m-2 size-4 animate-spin" />
            ) : children.isError && !children.isFetchNextPageError ? (
              <p className="p-2 text-xs text-destructive">
                Could not load folder.
              </p>
            ) : (
              <>
                <Entries
                  source={source}
                  entries={
                    children.data?.pages.flatMap(
                      (page) => page.entries ?? [],
                    ) ?? []
                  }
                  mode="tree"
                  depth={depth + 1}
                />
                {!children.data?.pages.flatMap((page) => page.entries ?? [])
                  .length && (
                  <p className="p-2 text-xs text-muted-foreground">
                    Empty folder.
                  </p>
                )}
                <AutoLoadMore query={children} />
              </>
            )}
          </div>
        )}
      </div>
    );
  }
  const fileClass = grid
    ? `flex min-h-32 w-full min-w-0 flex-col items-start gap-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20 p-3 pr-12 text-left transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.ignored ? 'text-muted-foreground opacity-70' : ''}`
    : `@container flex min-h-10 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 pr-12 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.ignored ? 'text-muted-foreground' : ''}`;
  return (
    <div
      className="relative min-w-0"
      data-ui="file-explorer-entry"
      data-layout={mode}
    >
      {entryMenu.renaming ? (
        entryMenu.renameField(
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileIcon className="size-4" />
          </span>,
          fileClass,
        )
      ) : (
        <button
          ref={entryMenu.rowRef}
          data-ui={marker}
          data-source-id={source.id}
          data-path={entry.path}
          {...dragProps}
          {...entryMenu.rowProps}
          onClick={entryMenu.guard(() => source.open(entry))}
          className={fileClass}
        >
          {imagePreviewUrl ? (
            <ImageHoverPreview
              src={imagePreviewUrl}
              alt={entry.name}
              side="left"
            >
              <span className="inline-flex shrink-0">
                {thumbnailUrl ? (
                  <SecureImage
                    src={thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="size-11 shrink-0 rounded-md border border-border/50 bg-muted object-cover"
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <FileIcon className="size-4" />
                  </span>
                )}
              </span>
            </ImageHoverPreview>
          ) : thumbnailUrl ? (
            <SecureImage
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              className="size-11 shrink-0 rounded-md border border-border/50 bg-muted object-cover"
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <FileIcon className="size-4" />
            </span>
          )}
          <span className="min-w-0 max-w-full flex-1 overflow-hidden">
            <span
              className={`block text-xs font-medium ${grid ? 'line-clamp-2 max-h-8 overflow-hidden break-words' : 'truncate'}`}
              title={entry.name}
            >
              {entry.name}
            </span>
            {subtitle && (
              <span className="block truncate text-[10px] text-muted-foreground">
                {subtitle}
              </span>
            )}
          </span>
          {grid ? (
            <span className="mt-auto flex w-full min-w-0 items-end justify-between gap-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {details}
              </span>
              {size}
            </span>
          ) : (
            <span className="flex min-w-0 shrink items-center justify-end gap-2">
              {details}
              {size}
            </span>
          )}
        </button>
      )}
      {entryMenu.menu}
      {source.renderActions?.(entry, mode)}
    </div>
  );
}

function SourceRefreshButton({
  source,
  className = '',
}: {
  source: FileExplorerSource;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const fetching =
    useIsFetching({ queryKey: ['fileExplorer', source.id] }) +
      useIsFetching({ queryKey: ['fileExplorerSearch', source.id] }) >
    0;
  return (
    <button
      type="button"
      data-ui="file-explorer-refresh"
      data-source-id={source.id}
      aria-label={`Refresh ${source.label}`}
      title={`Refresh ${source.label}`}
      disabled={fetching}
      onClick={async (event) => {
        event.stopPropagation();
        await source.refresh?.();
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ['fileExplorer', source.id],
          }),
          queryClient.invalidateQueries({
            queryKey: ['fileExplorerSearch', source.id],
          }),
        ]);
      }}
      className={`flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${className}`}
    >
      <RefreshCw className={`size-3.5 ${fetching ? 'animate-spin' : ''}`} />
    </button>
  );
}

function SearchResults({
  source,
  query,
  mode,
}: {
  source: FileExplorerSource;
  query: string;
  mode: FileExplorerMode;
}) {
  const result = useInfiniteQuery({
    queryKey: ['fileExplorerSearch', source.id, query],
    queryFn: ({ pageParam }) => source.search!(query, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!source.search,
  });
  const entries =
    result.data?.pages.flatMap((page) => page.entries ?? []) ?? [];
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {source.label}
        </h3>
        <SourceRefreshButton source={source} />
      </div>
      {result.isLoading ? (
        <Loader2 className="m-2 size-4 animate-spin" />
      ) : result.isError && !result.isFetchNextPageError ? (
        <p className="py-2 text-xs text-destructive">Search failed.</p>
      ) : entries.length ? (
        <>
          <Entries source={source} entries={entries} mode={mode} />
          <AutoLoadMore query={result} />
        </>
      ) : (
        <p className="py-2 text-xs text-muted-foreground">No matches.</p>
      )}
    </section>
  );
}

function Entries({
  source,
  entries,
  mode,
  depth = 0,
}: {
  source: FileExplorerSource;
  entries: FileExplorerEntry[];
  mode: FileExplorerMode;
  depth?: number;
}) {
  const grid = mode === 'grid';
  return (
    <div
      data-ui="file-explorer-entries"
      data-layout={mode}
      style={grid ? responsiveGridStyle : undefined}
      className={grid ? 'grid min-w-0 gap-2' : 'min-w-0 space-y-0.5'}
    >
      {entries.map((entry) => (
        <EntryRow
          key={`${entry.kind}:${entry.path}`}
          source={source}
          entry={entry}
          mode={mode}
          depth={depth}
        />
      ))}
    </div>
  );
}

function SourceRoot({
  source,
  mode,
  visible,
  onExitSource,
}: {
  source: FileExplorerSource;
  mode: FileExplorerMode;
  visible: boolean;
  onExitSource?: () => void;
}) {
  const [treePath] = useState('');
  const [path, setPath] = useState('');
  const [expanded, setExpanded] = useState(false);
  const activePath = mode === 'tree' ? treePath : path;
  const sort = useContext(SortContext);
  const page = useInfiniteQuery({
    queryKey: ['fileExplorer', source.id, mode, activePath, sortKey(sort)],
    queryFn: ({ pageParam }) => source.list(activePath, pageParam, sort),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (result) => result.nextCursor,
    enabled: visible && (mode === 'tree' ? expanded : true),
  });
  const entries =
    page.data?.pages.flatMap((result) => result.entries ?? []) ?? [];
  if (mode === 'tree')
    return (
      <section
        className="overflow-hidden rounded-lg border border-border/60 bg-muted/10"
        hidden={!visible}
      >
        <div className="flex min-w-0 items-center pr-1">
          <button
            data-ui="file-explorer-folder"
            data-source-id={source.id}
            data-path=""
            aria-expanded={expanded}
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight
              className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            <span className="truncate">{source.label}</span>
          </button>
          <SourceRefreshButton source={source} />
        </div>
        {expanded && (
          <>
            {page.isLoading ? (
              <Loader2 className="m-3 size-4 animate-spin" />
            ) : (page.isError && !page.isFetchNextPageError) ||
              page.data?.pages[0]?.available === false ? (
              <p className="p-3 text-xs text-muted-foreground">
                {page.data?.pages[0]?.reason === 'no-repo'
                  ? 'No repository configured.'
                  : page.data?.pages[0]?.reason === 'sandbox-stale'
                    ? 'Sandbox is running with outdated mount settings. Restart the sandbox to apply the new mounts.'
                    : 'Could not load files.'}
              </p>
            ) : (
              <div className="p-1">
                <Entries source={source} entries={entries} mode="tree" />
                {!entries.length && (
                  <p className="p-2 text-xs text-muted-foreground">
                    Empty folder.
                  </p>
                )}
                <AutoLoadMore query={page} />
              </div>
            )}
          </>
        )}
      </section>
    );
  return (
    <section className="min-w-0 space-y-2" hidden={!visible}>
      <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/30 p-1 text-xs">
        <button
          data-ui="file-explorer-contextual-back"
          data-action={path ? 'parent-folder' : 'source-chooser'}
          data-state={path ? 'nested' : 'source-root'}
          aria-label={path ? `Back in ${source.label}` : 'Back to sources'}
          title={path ? `Back in ${source.label}` : 'Back to sources'}
          disabled={!path && !onExitSource}
          className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          onClick={() => {
            if (path) setPath(path.split('/').slice(0, -1).join('/'));
            else onExitSource?.();
          }}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          data-ui="file-explorer-source-root"
          data-source-id={source.id}
          onClick={() => setPath('')}
        >
          <strong>{source.label}</strong>
        </button>
        <nav
          aria-label={`${source.label} breadcrumbs`}
          className="flex min-w-0 flex-1 items-center gap-1 truncate"
        >
          {path
            .split('/')
            .filter(Boolean)
            .map((segment, index, parts) => {
              const crumbPath = parts.slice(0, index + 1).join('/');
              return (
                <span
                  key={crumbPath}
                  className="flex min-w-0 items-center gap-1"
                >
                  <span>/</span>
                  <button
                    type="button"
                    className="truncate text-muted-foreground hover:text-foreground"
                    onClick={() => setPath(crumbPath)}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
        </nav>
        <SourceRefreshButton source={source} />
      </div>
      {page.isLoading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (page.isError && !page.isFetchNextPageError) ||
        page.data?.pages[0]?.available === false ? (
        <p className="text-xs text-destructive">
          {page.data?.pages[0]?.reason === 'sandbox-stale'
            ? 'Sandbox is running with outdated mount settings. Restart the sandbox to apply the new mounts.'
            : 'Could not load files.'}
        </p>
      ) : (
        <div
          data-ui="file-explorer-entries"
          data-layout={mode}
          style={mode === 'grid' ? responsiveGridStyle : undefined}
          className={
            mode === 'grid' ? 'grid min-w-0 gap-2' : 'min-w-0 space-y-0.5'
          }
        >
          {entries.map((entry) => (
            <EntryRow
              key={`${entry.kind}:${entry.path}`}
              source={source}
              entry={entry}
              mode={mode}
              onNavigate={
                entry.kind === 'directory'
                  ? () => setPath(entry.path)
                  : undefined
              }
            />
          ))}
          {!entries.length && (
            <p className="p-2 text-xs text-muted-foreground">Empty folder.</p>
          )}
          <AutoLoadMore query={page} />
        </div>
      )}
    </section>
  );
}

export function FileExplorer({
  sources,
  storageKey,
  active = true,
  defaultMode = 'tree',
  searchPlaceholder = 'Search files',
}: {
  sources: FileExplorerSource[];
  storageKey: string;
  active?: boolean;
  defaultMode?: FileExplorerMode;
  searchPlaceholder?: string;
}) {
  const [mode, setMode] = useState<FileExplorerMode>(
    () => (localStorage.getItem(storageKey) as FileExplorerMode) || defaultMode,
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() =>
    sources.length === 1 ? sources[0]!.id : null,
  );
  const selectedSource =
    sources.find((source) => source.id === selectedSourceId) ?? null;
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const set = (next: FileExplorerMode) => {
    localStorage.setItem(storageKey, next);
    setMode(next);
  };
  const sortStorageKey = `${storageKey}:sort`;
  const [sortValue, setSortValue] = useState(() => {
    const stored = localStorage.getItem(sortStorageKey);
    return SORT_OPTIONS.some((option) => option.value === stored)
      ? stored!
      : DEFAULT_SORT_VALUE;
  });
  const sortable = sources.some((source) => source.sortable);
  // The default order sends no sort params, matching the pre-sort requests.
  const sort =
    sortable && sortValue !== DEFAULT_SORT_VALUE
      ? SORT_OPTIONS.find((option) => option.value === sortValue)?.sort
      : undefined;
  return (
    <SortContext.Provider value={sort}>
      <div className="min-w-0" data-ui="file-explorer">
        <WorkspaceToolbar data-ui="file-explorer-toolbar">
          <WorkspaceToolbarRow>
            <div
              data-toolbar-group
              className="flex w-fit items-center gap-0.5 rounded-lg bg-muted/40 p-0.5"
              role="toolbar"
              aria-label="File explorer view"
            >
              {VIEW_MODES.map(({ mode: viewMode, label, Icon }) => (
                <button
                  key={viewMode}
                  data-ui={`file-explorer-view-${viewMode}`}
                  aria-label={label}
                  aria-pressed={mode === viewMode}
                  onClick={() => set(viewMode)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
            {sortable && (
              <Select
                compact
                data-ui="file-explorer-sort"
                aria-label="Sort files"
                value={sortValue}
                onValueChange={(nextValue) => {
                  localStorage.setItem(sortStorageKey, nextValue);
                  setSortValue(nextValue);
                }}
              >
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            )}
          </WorkspaceToolbarRow>
          <FieldRow
            as="form"
            compact
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
            }}
          >
            <SearchInput
              compact
              data-ui="file-explorer-search"
              wrapperClassName="flex-1"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
            <Button type="submit" size="sm">
              Search
            </Button>
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setSearchDraft('');
                }}
              >
                Clear
              </Button>
            )}
          </FieldRow>
        </WorkspaceToolbar>
        <div className="space-y-3 pt-2">
          {search ? (
            <div className="space-y-3">
              {sources
                .filter((source) => source.search)
                .map((source) => (
                  <SearchResults
                    key={source.id}
                    source={source}
                    query={search}
                    mode={mode}
                  />
                ))}
            </div>
          ) : (
            <>
              {mode !== 'tree' && !selectedSource ? (
                <div
                  style={mode === 'grid' ? responsiveGridStyle : undefined}
                  className={
                    mode === 'grid' ? 'grid min-w-0 gap-2' : 'space-y-1'
                  }
                >
                  {sources.map((source) => (
                    <button
                      key={source.id}
                      data-ui="file-explorer-folder"
                      data-source-id={source.id}
                      data-path=""
                      className="flex min-h-11 min-w-0 w-full items-center gap-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20 px-3 text-left text-xs font-medium transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelectedSourceId(source.id)}
                    >
                      <Folder className="size-5 shrink-0 text-primary/80" />
                      <span className="truncate">{source.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
          <div hidden={Boolean(search)}>
            {sources.map((source) => (
              <SourceRoot
                key={source.id}
                source={source}
                mode={mode}
                onExitSource={
                  sources.length > 1
                    ? () => setSelectedSourceId(null)
                    : undefined
                }
                visible={
                  active &&
                  !search &&
                  (mode === 'tree' || source.id === selectedSourceId)
                }
              />
            ))}
          </div>
        </div>
      </div>
    </SortContext.Provider>
  );
}
