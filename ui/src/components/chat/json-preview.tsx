/**
 * Structured JSON / JSONC / JSONL previews for the file preview pane.
 *
 * These components are presentational: `preview-pane.tsx` owns fetching,
 * size caps and the raw (highlight.js) view and passes the raw renderer in
 * as `rawView`, so the existing line-selection / open-file-context behaviour
 * of `<pre data-file-lines>` is untouched in Raw mode.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FilePreviewHeader } from './file-preview-header';
import {
  parseJsonc,
  parseJsonlLine,
  recordSummary,
  splitJsonlRecords,
  type JsonlRecord,
} from '@/lib/json-viewer';

type ExpandSignal = { mode: 'all' | 'none'; n: number };

/** Children rendered per container before a "Show more" button. */
const CHILD_PAGE = 200;
const JSON_MODE_KEY = 'carapa.jsonPreviewMode';
const JSONL_MODE_KEY = 'carapa.jsonlPreviewMode';
const JSONL_CHUNK_BYTES = 128 * 1024;
const JSONL_NEAR_END_PX = 400;

type ViewMode = 'tree' | 'raw';

function useStoredMode(key: string): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(key) === 'raw' ? 'raw' : 'tree';
    } catch {
      return 'tree';
    }
  });
  const update = useCallback(
    (m: ViewMode) => {
      setMode(m);
      try {
        localStorage.setItem(key, m);
      } catch {
        // Storage unavailable: the choice just won't persist.
      }
    },
    [key],
  );
  return [mode, update];
}

/** Local expansion state that a toolbar `ExpandSignal` can reset. */
function useExpanded(initial: boolean, signal?: ExpandSignal) {
  const [expanded, setExpanded] = useState(() =>
    signal && signal.n > 0 ? signal.mode === 'all' : initial,
  );
  const seen = useRef(signal?.n ?? 0);
  const signalN = signal?.n;
  const signalMode = signal?.mode;
  useEffect(() => {
    if (signalN == null || signalN === seen.current) return;
    seen.current = signalN;
    setExpanded(signalMode === 'all');
  }, [signalN, signalMode]);
  return [expanded, setExpanded] as const;
}

function pointerSegment(key: string | number): string {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

function Primitive({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return (
      <span className="hljs-string whitespace-pre-wrap break-words">
        {JSON.stringify(value)}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="hljs-number">{String(value)}</span>;
  }
  return <span className="hljs-literal">{String(value)}</span>;
}

function JsonNode({
  name,
  value,
  path,
  depth,
  defaultDepth,
  signal,
}: {
  /** Object key (string) or array index (number). */
  name?: string | number;
  value: unknown;
  path: string;
  depth: number;
  defaultDepth: number;
  signal?: ExpandSignal;
}) {
  const isContainer = value !== null && typeof value === 'object';
  const entries = useMemo<Array<[string | number, unknown]>>(() => {
    if (!isContainer) return [];
    return Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value as Record<string, unknown>);
  }, [isContainer, value]);
  const isArray = Array.isArray(value);
  const [expanded, setExpanded] = useExpanded(depth < defaultDepth, signal);
  const [limit, setLimit] = useState(CHILD_PAGE);

  const label = name !== undefined && (
    <>
      <span className="hljs-attr">
        {typeof name === 'number' ? name : JSON.stringify(name)}
      </span>
      <span className="text-muted-foreground">: </span>
    </>
  );

  if (!isContainer || entries.length === 0) {
    return (
      <div
        data-ui="json-node"
        data-path={path}
        className="whitespace-pre-wrap break-words py-px pl-[18px]"
      >
        {label}
        {isContainer ? (
          <span className="text-muted-foreground">{isArray ? '[]' : '{}'}</span>
        ) : (
          <Primitive value={value} />
        )}
      </div>
    );
  }

  const count = entries.length;
  const rest = count - limit;
  return (
    <div data-ui="json-node" data-path={path}>
      <div className="flex items-start gap-1 py-px">
        <button
          type="button"
          data-ui="json-node-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => setExpanded((e) => !e)}
          className="mt-[3px] shrink-0 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <div className="min-w-0 flex-1 break-words">
          {label}
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-left text-muted-foreground hover:text-foreground"
            >
              {isArray ? '[…]' : '{…}'} {count}{' '}
              {isArray
                ? count === 1
                  ? 'item'
                  : 'items'
                : count === 1
                  ? 'key'
                  : 'keys'}
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="ml-[7px] border-l border-border/50 pl-2.5">
          {entries.slice(0, limit).map(([k, v]) => (
            <JsonNode
              key={k}
              name={k}
              value={v}
              path={`${path}/${pointerSegment(k)}`}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              signal={signal}
            />
          ))}
          {rest > 0 && (
            <button
              type="button"
              data-ui="json-show-more"
              onClick={() => setLimit((l) => l + CHILD_PAGE)}
              className="py-0.5 pl-[18px] text-left text-[11px] text-muted-foreground hover:text-foreground"
            >
              Show {Math.min(CHILD_PAGE, rest)} more ({rest} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function JsonTree({
  value,
  defaultDepth,
  expandSignal,
}: {
  value: unknown;
  defaultDepth: number;
  expandSignal?: ExpandSignal;
}) {
  return (
    <div data-ui="json-tree" className="font-mono text-[12px] leading-relaxed">
      <JsonNode
        value={value}
        path=""
        depth={0}
        defaultDepth={defaultDepth}
        signal={expandSignal}
      />
    </div>
  );
}

function ViewModeToggle({
  mode,
  onChange,
  treeLabel,
  disabled,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
  treeLabel: string;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex shrink-0 rounded-md border p-0.5"
      data-ui="json-view-modes"
    >
      {(['tree', 'raw'] as const).map((m) => (
        <Button
          key={m}
          type="button"
          size="xs"
          variant={mode === m ? 'secondary' : 'ghost'}
          aria-pressed={mode === m}
          disabled={disabled && m === 'tree'}
          onClick={() => onChange(m)}
          data-ui="json-view-mode"
          data-mode={m}
        >
          {m === 'tree' ? treeLabel : 'Raw'}
        </Button>
      ))}
    </div>
  );
}

function ExpandButtons({
  onSignal,
}: {
  onSignal: (mode: 'all' | 'none') => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        data-ui="json-expand-all"
        onClick={() => onSignal('all')}
      >
        Expand all
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        data-ui="json-collapse-all"
        onClick={() => onSignal('none')}
      >
        Collapse all
      </Button>
    </div>
  );
}

function useExpandSignal() {
  const [signal, setSignal] = useState<ExpandSignal>({ mode: 'none', n: 0 });
  const fire = useCallback(
    (mode: 'all' | 'none') => setSignal((s) => ({ mode, n: s.n + 1 })),
    [],
  );
  return [signal, fire] as const;
}

/** `.json` / `.jsonc` / `.json5` preview: collapsible tree with a Raw toggle. */
export function JsonDocumentView({
  text,
  label,
  mimetype,
  sizeLabel,
  rawView,
}: {
  text: string;
  label: string;
  mimetype: string;
  sizeLabel: string;
  rawView: ReactNode;
}) {
  const [storedMode, setMode] = useStoredMode(JSON_MODE_KEY);
  const parsed = useMemo(() => parseJsonc(text), [text]);
  const [signal, fire] = useExpandSignal();
  const mode: ViewMode = parsed.ok ? storedMode : 'raw';

  return (
    <div
      className="flex h-full w-full flex-col"
      data-ui="json-document-preview"
      data-mode={mode}
    >
      <FilePreviewHeader
        label={label}
        mimetype={mimetype}
        meta={sizeLabel ? <span>{sizeLabel}</span> : null}
        controls={
          <>
            {mode === 'tree' && <ExpandButtons onSignal={fire} />}
            <ViewModeToggle
              mode={mode}
              onChange={setMode}
              treeLabel="Tree"
              disabled={!parsed.ok}
            />
          </>
        }
      />
      {!parsed.ok && (
        <div
          data-ui="json-parse-error"
          className="border-b border-border/50 px-3 py-1 text-[11px] text-destructive"
        >
          Not valid JSON: {parsed.error}
        </div>
      )}
      {mode === 'tree' && parsed.ok ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <JsonTree
            value={parsed.value}
            defaultDepth={2}
            expandSignal={signal}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1">{rawView}</div>
      )}
    </div>
  );
}

function JsonlRecordRow({
  record,
  signal,
}: {
  record: JsonlRecord;
  signal: ExpandSignal;
}) {
  const [expanded, setExpanded] = useExpanded(false, signal);
  const invalid = record.error !== undefined;
  return (
    <div
      data-ui="jsonl-record"
      data-line={record.line}
      className="border-b border-border/30 px-3 py-1"
    >
      <div className="flex items-start gap-1.5 text-[12px] leading-relaxed">
        <button
          type="button"
          data-ui="jsonl-record-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse record' : 'Expand record'}
          onClick={() => setExpanded((e) => !e)}
          className="mt-[3px] shrink-0 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          #{record.line}
        </span>
        {invalid && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            invalid JSON
          </span>
        )}
        {!expanded && (
          <span className="min-w-0 flex-1 truncate font-mono">
            {invalid ? record.raw : recordSummary(record.value)}
          </span>
        )}
      </div>
      {expanded && (
        <div className="ml-5 mt-0.5">
          {invalid ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px]">
              {record.raw}
            </pre>
          ) : (
            <JsonTree
              value={record.value}
              defaultDepth={1}
              expandSignal={signal}
            />
          )}
        </div>
      )}
    </div>
  );
}

export interface JsonlChunkResult {
  content: string;
  /** Total file size in bytes (present on chunked reads). */
  total?: number;
}

const utf8 = new TextEncoder();

/**
 * Incremental JSONL loader. Reads `JSONL_CHUNK_BYTES` windows head-first,
 * advancing the byte offset by the UTF-8 length of the returned content, and
 * carries the trailing partial line into the next window.
 */
export function useJsonlChunks(
  readChunk: (offset: number, length: number) => Promise<JsonlChunkResult>,
  totalHint: number | null | undefined,
) {
  const readRef = useRef(readChunk);
  readRef.current = readChunk;
  const offsetRef = useRef(0);
  const remainderRef = useRef('');
  const lineRef = useRef(1);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const [records, setRecords] = useState<JsonlRecord[]>([]);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [total, setTotal] = useState<number | null>(totalHint ?? null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (busyRef.current || doneRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const offset = offsetRef.current;
      const res = await readRef.current(offset, JSONL_CHUNK_BYTES);
      let content = res.content;
      // A server without a total returned the whole file in one go.
      const knownTotal = typeof res.total === 'number' ? res.total : null;
      const moreAfterWindow =
        knownTotal != null && offset + JSONL_CHUNK_BYTES < knownTotal;
      // A window that cuts a multi-byte character decodes to U+FFFD at its
      // end; drop it so the next window re-reads the complete character.
      if (moreAfterWindow && content.endsWith('�')) {
        content = content.slice(0, -1);
      }
      const nextOffset = offset + utf8.encode(content).length;
      const finished = content === '' || knownTotal == null || !moreAfterWindow;
      offsetRef.current = nextOffset;
      const split = splitJsonlRecords(
        remainderRef.current + content,
        lineRef.current,
      );
      const fresh = split.records;
      remainderRef.current = split.remainder;
      lineRef.current = split.nextLineNo;
      if (finished && split.remainder.trim()) {
        fresh.push(parseJsonlLine(split.remainder, split.nextLineNo));
        remainderRef.current = '';
      }
      if (knownTotal != null) setTotal(knownTotal);
      setLoadedBytes(nextOffset);
      setRecords((prev) => [...prev, ...fresh]);
      if (finished) {
        doneRef.current = true;
        setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMore();
  }, [loadMore]);

  return { records, loadedBytes, total, done, loading, error, loadMore };
}

type JsonlLoader = ReturnType<typeof useJsonlChunks>;

/** Records list for a JSONL file; `loader` is set for incremental loading. */
export function JsonLinesView({
  records,
  loader,
  label,
  mimetype,
  sizeLabel,
  formatBytes,
  rawView,
}: {
  records: JsonlRecord[];
  loader?: JsonlLoader;
  label: string;
  mimetype: string;
  sizeLabel: string;
  formatBytes: (n: number) => string;
  rawView: ReactNode;
}) {
  const [mode, setMode] = useStoredMode(JSONL_MODE_KEY);
  const [signal, fire] = useExpandSignal();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasMore = !!loader && !loader.done;
  const loadMore = loader?.loadMore;
  const busy = loader?.loading ?? false;
  const loadError = loader?.error ?? null;

  const maybeLoadMore = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !loadMore || !hasMore || busy || loadError) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < JSONL_NEAR_END_PX) {
      void loadMore();
    }
  }, [loadMore, hasMore, busy, loadError]);

  // Keep loading while the loaded records don't yet fill the viewport.
  useEffect(() => {
    if (mode === 'tree') maybeLoadMore();
  }, [mode, records.length, maybeLoadMore]);

  const progress =
    loader && loader.total != null
      ? `Loaded ${formatBytes(loader.loadedBytes)} / ${formatBytes(loader.total)}`
      : null;

  return (
    <div
      className="flex h-full w-full flex-col"
      data-ui="jsonl-preview"
      data-mode={mode}
    >
      <FilePreviewHeader
        label={label}
        mimetype={mimetype}
        meta={
          <>
            {sizeLabel && <span>{sizeLabel}</span>}
            {progress && hasMore && <span>· {progress}</span>}
          </>
        }
        controls={
          <>
            {mode === 'tree' && <ExpandButtons onSignal={fire} />}
            <ViewModeToggle
              mode={mode}
              onChange={setMode}
              treeLabel="Records"
            />
          </>
        }
      />
      {mode === 'tree' ? (
        <div
          ref={scrollRef}
          onScroll={maybeLoadMore}
          className="min-h-0 flex-1 overflow-auto"
        >
          {records.map((r) => (
            <JsonlRecordRow key={r.line} record={r} signal={signal} />
          ))}
          {records.length === 0 && !hasMore && !busy && !loadError && (
            <div className="p-4 text-xs text-muted-foreground">No records.</div>
          )}
          {loadError && (
            <div className="p-3 text-xs text-destructive">
              Could not load file: {loadError}
            </div>
          )}
          {(hasMore || busy) && (
            <div className="flex items-center justify-center gap-2 p-2">
              {busy ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-ui="jsonl-load-more"
                  onClick={() => void loadMore?.()}
                >
                  {loadError ? 'Retry' : 'Load more'}
                </Button>
              )}
              {progress && (
                <span className="text-[11px] text-muted-foreground">
                  {progress}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1">{rawView}</div>
      )}
    </div>
  );
}
