/**
 * TmuxClient — lifecycle wrapper for sandbox tmux attach/detach.
 *
 * Owns streaming + scrollback for one tab. Mirrors the streaming shape used by
 * BashTab: the client emits raw pane chunks via a writable callback while
 * appending them to a per-task buffer file (`store/tmux/<taskId>.log`) so that
 * `replay()` can restore the last N lines (default 2000) on remount.
 *
 * A session index in `ipc/tmux-sessions.json` survives board restarts so the
 * UI can re-attach to the right streamId on reload.
 *
 * The carapa-box REST/SSE client is injected via the constructor — this keeps
 * tests hermetic (no global mock.module interceptors that leak across test
 * files).
 *
 * ## Live deltas
 *
 * As of this rewrite, the board talks to carapa-box via the new REST + SSE
 * tmux surface (`src/lib/tmux-box-client.ts`) instead of the MCP
 * `sandbox_tmux_*` tools. The previous MCP path returned a literal
 * `"(no output)"` sentinel for every keystroke and dropped the live pane
 * deltas on the floor; the SSE pump carried by `TmuxAttachHandle` is what
 * actually feeds the keystroke + shell-response bytes to xterm. `open()`
 * registers an internal listener that:
 *   - appends every chunk to the per-task buffer file (rolling 2 MB), and
 *   - fans it out through the constructor `onChunk` hook + every
 *     `subscribe()` listener.
 *
 * `sendKeys()` / `resize()` / `close({ kill: true })` route through the
 * handle's `exec` / `resize` / `detach` REST calls; `sendKeys()` no longer
 * fans out the exec response (it carries no echo — deltas arrive on the
 * SSE pump).
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { logger } from '../logger.js';
import { resolveInside } from './path-containment.js';
import { STORE_DIR, DATA_DIR } from '../config.js';
import type {
  TmuxBoxClient,
  TmuxAttachHandle,
  TmuxExecResult,
} from './tmux-box-client.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface TmuxOpenOptions {
  stack: string;
  service: string;
  instance: string;
  taskId: string;
  /** Initial terminal size for the attached pane. */
  cols?: number;
  rows?: number;
  /** Pre-existing tmux session name to attach to. Defaults to a name derived from taskId. */
  session?: string;
  /** Pre-existing scrollback (e.g. from replay) to seed the pane UI. */
  initialScrollback?: string;
}

export interface TmuxOpenResult {
  streamId: string;
  cols: number;
  rows: number;
  /** Initial scrollback captured at attach time. */
  scrollback: string;
  /** Tmux session name (echoed back from CarapaBox). */
  session: string;
}

export interface TmuxCloseOptions {
  /** When true, also tell CarapaBox to kill the tmux session. */
  kill?: boolean;
}

export interface TmuxReplayOptions {
  /** Maximum number of trailing lines to return. Defaults to the pane height. */
  fromLine?: number;
}

export interface TmuxSessionRecord {
  taskId: string;
  stack: string;
  service: string;
  instance: string;
  session: string;
  /** Pane height at attach time; used to replay a screen-sized snapshot. */
  rows?: number;
  /** CarapaBox streamId — required for `detach`. */
  boxStreamId?: string;
  createdAt: number;
}

export interface TmuxClientDeps {
  /**
   * CarapaBox REST/SSE client used for the actual tmux calls. The handle
   * returned from `attach()` is stored per-stream so subsequent `exec` /
   * `resize` / `detach` calls share the same SSE pump.
   */
  box: Pick<TmuxBoxClient, 'attach'>;
  /** Override the IPC directory (defaults to <DATA_DIR>/ipc). */
  ipcDir?: string;
  /** Override the scrollback directory (defaults to <STORE_DIR>/tmux). */
  storeDir?: string;
  /** Override the replay line cap. Defaults to 2000. */
  maxReplayLines?: number;
  /** Override the rolling buffer size in bytes. Defaults to ~2 MB. */
  maxBufferBytes?: number;
  /** Override the JSON session index path (defaults to <ipcDir>/tmux-sessions.json). */
  indexPath?: string;
  /**
   * Override the onChunk subscriber used by `open()` to fan out incoming pane
   * bytes. Production callsites wire this to a writable that fans out to a
   * websocket; tests use a sync callback for deterministic assertions.
   */
  onChunk?: (streamId: string, chunk: string) => void;
  /**
   * Override the `generateStreamId` factory. Defaults to
   * `crypto.randomUUID()`. Tests pin this to a deterministic value.
   */
  generateStreamId?: () => string;
  /** Override the wall clock for `createdAt` stamping. */
  now?: () => number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_REPLAY_LINES = 2000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024; // ~2 MB
const SESSIONS_FILENAME = 'tmux-sessions.json';
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
/** A prior stream of the same tab younger than this may still get its reader. */
const STALE_STREAM_GRACE_MS = 30_000;

// ── Client ───────────────────────────────────────────────────────────────────

export class TmuxClient {
  private readonly box: TmuxClientDeps['box'];
  private readonly ipcDir: string;
  private readonly storeDir: string;
  private readonly maxReplayLines: number;
  private readonly maxBufferBytes: number;
  private readonly indexPath: string;
  private readonly onChunk: (streamId: string, chunk: string) => void;
  private readonly generateStreamId: () => string;
  private readonly now: () => number;

  /** Open streams, keyed by streamId. */
  private readonly streams = new Map<string, TmuxStream>();
  private readonly replayWriters = new Map<string, string>();
  private readonly pendingChunks = new Map<
    string,
    { chunks: string[]; promise: Promise<void> }
  >();

  /** In-memory mirror of the session index; persisted to disk on every change. */
  private sessions: Record<string, TmuxSessionRecord> = {};

  /** Cached index load to avoid re-reading the file on every call. */
  private indexLoaded = false;

  /**
   * Per-task serial write queue for `appendChunks`. The SSE delta pump fires
   * listeners synchronously, so two adjacent deltas start `appendChunks`
   * promises that race on `readFile` → `writeFile` and the second clobbers
   * the first. Chaining each task's writes through a tail promise keeps the
   * file content correct (most-recent-wins semantics on the read, then
   * sequential writes).
   */
  private readonly appendQueues = new Map<string, Promise<unknown>>();

  constructor(deps: TmuxClientDeps) {
    this.box = deps.box;
    this.ipcDir = deps.ipcDir ?? path.join(DATA_DIR, 'ipc');
    this.storeDir = deps.storeDir ?? path.join(STORE_DIR, 'tmux');
    this.maxReplayLines = deps.maxReplayLines ?? DEFAULT_MAX_REPLAY_LINES;
    this.maxBufferBytes = deps.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.indexPath =
      deps.indexPath ?? path.join(this.ipcDir, SESSIONS_FILENAME);
    this.onChunk =
      deps.onChunk ??
      ((streamId: string, chunk: string) => {
        logger.debug({ streamId, bytes: chunk.length }, 'tmux chunk');
      });
    this.generateStreamId = deps.generateStreamId ?? defaultGenerateStreamId;
    this.now = deps.now ?? Date.now;
    // Load any persisted session index BEFORE returning from the constructor
    // — callers rely on `getRecord()` / `listSessions()` / `replay()` being
    // able to resolve streamIds that were written by a previous process.
    this.loadIndexSync();
  }

  /**
   * Eagerly load the persisted session index from disk so that
   * `getRecord()`, `listSessions()`, and `replay()` can resolve streamIds
   * that were written by a previous board process. Called once from the
   * constructor; idempotent thereafter.
   *
   * Reads synchronously — the constructor itself is synchronous and the
   * contract is that after `new TmuxClient()` returns, the in-memory
   * `sessions` map reflects what's on disk. The payload is a small JSON
   * object, so sync I/O is fine here.
   */
  private loadIndexSync(): void {
    if (this.indexLoaded) return;
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.sessions = parsed as Record<string, TmuxSessionRecord>;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn(
          { path: this.indexPath, error: String(err) },
          'tmux session index read failed',
        );
      }
      this.sessions = {};
    }
    this.indexLoaded = true;
  }

  /**
   * Sweep stale entries from the persisted session index.
   *
   * Called on board startup (and on demand). Drops entries whose
   * `createdAt` is older than `maxAgeMs` and are NOT currently held
   * in this process's `streams` map. The in-process guard avoids
   * dropping a live stream that an in-flight BashTab is using.
   *
   * Why TTL-based instead of pinging the box for each entry: a
   * reconcile pass that N HTTP calls the box for N entries would
   * hammer the box on every board restart. The actual failure mode
   * the user reported is "stale entries after a long time", which
   * is what TTL catches. Combined with the sweep-on-open inside
   * `open()` (which drops the OLD entry when the user re-attaches
   * to the same taskId), this gives a complete cleanup story:
   *
   *   - User re-opens within TTL   → sweep-on-open drops the old entry
   *   - User never re-opens        → TTL eventually drops the entry
   *   - User opens a different tab → the new taskId is unrelated, old
   *                                   entry survives until TTL
   *
   * Returns the number of entries dropped, for logging / tests.
   */
  async reconcile(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    if (!this.indexLoaded) this.loadIndexSync();
    const now = this.now();
    let dropped = 0;
    for (const [streamId, record] of Object.entries(this.sessions)) {
      if (this.streams.has(streamId)) continue;
      const age = now - record.createdAt;
      if (age > maxAgeMs) {
        logger.info(
          { streamId, taskId: record.taskId, ageMs: age, maxAgeMs },
          '[tmux-client] reconcile: dropping aged-out entry',
        );
        delete this.sessions[streamId];
        dropped += 1;
      }
    }
    if (dropped > 0) await this.persistIndex();
    return dropped;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Attach to a tmux session in the given sandbox.
   *
   * Side effects:
   *  - Registers the stream in `ipc/tmux-sessions.json` (survives restarts).
   *  - Persists any initial scrollback from the attach response to the
   *    per-task buffer file.
   *  - Wires the SSE delta pump so live pane bytes flow into `onChunk`
   *    AND into the buffer file for as long as the attach stays open.
   *  - Forwards the initial scrollback seed to `onChunk` once.
   */
  async open(options: TmuxOpenOptions): Promise<TmuxOpenResult> {
    await this.ensureDirs();

    const streamId = this.generateStreamId();
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const session = options.session ?? deriveTmuxSessionName(options.taskId);
    const traceId = `${options.stack}/${options.service}/${options.instance}/${session}`;
    const openStart = Date.now();
    logger.info(
      { traceId, streamId, cols, rows, taskId: options.taskId },
      '[tmux-client] open: before box.attach',
    );

    // 1. Attach to the tmux session in carapa-box. The handle owns the
    //    open SSE stream — `await attach(...)` resolves once the `init`
    //    event has been parsed.
    let handle: TmuxAttachHandle;
    try {
      handle = await this.box.attach(
        options.stack,
        options.service,
        options.instance,
        {
          session,
          cols,
          rows,
        },
      );
    } catch (err) {
      logger.error(
        {
          traceId,
          streamId,
          elapsedMs: Date.now() - openStart,
          error:
            err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
        },
        '[tmux-client] open: box.attach rejected',
      );
      throw new Error(
        `tmux attach failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger.info(
      {
        traceId,
        streamId,
        initStreamId: handle.init.streamId,
        initSession: handle.init.session,
        initCols: handle.init.cols,
        initRows: handle.init.rows,
        scrollbackBytes: handle.init.scrollback?.length ?? 0,
        elapsedMs: Date.now() - openStart,
      },
      '[tmux-client] open: box.attach resolved (init received)',
    );

    const init = handle.init;
    const resolvedSession = init.session || session;
    const scrollback = init.scrollback;

    // Sweep any prior index entry for the SAME taskId before adding
    // the new one. Without this, every board restart (or browser
    // refresh) leaves a stale entry behind: the UI re-opens a fresh
    // stream for the same taskId, gets a new streamId, and the old
    // streamId's record just sits in `tmux-sessions.json` forever
    // because no one ever closes it. A prior stream that is still read
    // is not stale: two mounted shell panels or two browser windows view
    // the same tab, and CarapaBox fans one tmux session out to every
    // attach. Only unread streams past a short grace period (an open's
    // reader connects right after it returns) are swept. Persist after
    // the sweep so the file is consistent in a single write.
    let sweptStreamId: string | null = null;
    for (const [existingStreamId, existingRecord] of Object.entries(
      this.sessions,
    )) {
      if (existingStreamId === streamId) continue;
      if (existingRecord.taskId === options.taskId) {
        const prior = this.streams.get(existingStreamId);
        if (
          prior &&
          (prior.subscribers.size > 0 ||
            this.now() - existingRecord.createdAt < STALE_STREAM_GRACE_MS)
        ) {
          continue;
        }
        sweptStreamId = existingStreamId;
        logger.info(
          {
            traceId,
            newStreamId: streamId,
            sweptStreamId,
            sweptTaskId: existingRecord.taskId,
          },
          '[tmux-client] open: sweeping stale prior entry for same taskId',
        );
        delete this.sessions[existingStreamId];
        await this.close(existingStreamId);
      }
    }

    // 2. Persist the session index.
    //    Order matters: mutate `this.sessions` AND `persistIndex` together
    //    so a write failure rolls back the in-memory state, then register
    //    `this.streams` only on success. If we registered `this.streams`
    //    first and persistIndex threw, the next call would see a half-open
    //    stream and the on-disk index would be out of sync.
    const record: TmuxSessionRecord = {
      taskId: options.taskId,
      stack: options.stack,
      service: options.service,
      instance: options.instance,
      session: resolvedSession,
      rows: init.rows || rows,
      boxStreamId: init.streamId,
      createdAt: this.now(),
    };
    this.sessions[streamId] = record;
    try {
      await this.persistIndex();
    } catch (err) {
      // Roll back the in-memory mutation so the next open() can retry from
      // a clean slate. Also release the SSE pump.
      delete this.sessions[streamId];
      try {
        handle.close();
      } catch {
        /* ignore */
      }
      throw err;
    }

    // 3. The attach response is a complete pane snapshot, so replace the
    // replay buffer rather than appending it. Appending every reconnect's
    // capture made each remount replay all prior output twice.
    // Deliberately keep the session index entry if the buffer write fails:
    // the index and replay buffer are allowed to be eventually consistent,
    // and rolling back here could discard a valid attach that can be
    // recovered by a later buffer write/reconnect.
    this.replayWriters.set(options.taskId, streamId);
    await this.replaceBuffer(
      options.taskId,
      scrollback + (options.initialScrollback ?? ''),
    );

    // 4. Wire the SSE delta pump. The listener appends each chunk to the
    //    buffer file and fans it out through the constructor `onChunk` hook
    //    + every `subscribe()` listener.
    //
    //    [DEBUG] Loud logging on every delta so we can confirm whether
    //    box is actually emitting deltas and whether board's SSE pump
    //    is delivering them. If no logs appear for `streamId`, the SSE
    //    connection between board and box is dead.
    const unsubscribeDelta = handle.onDelta((chunk) => {
      //logger.info(
      //  { streamId, taskId: options.taskId, bytes: chunk.length },
      //  '[tmux-client] onDelta: chunk received from box',
      //);
      // Best-effort fire-and-forget: the buffer append is async but the
      // SSE pump runs sync per chunk. Errors are logged inside
      // `appendChunks` and don't bubble back here.
      if (this.replayWriters.get(options.taskId) === streamId) {
        void this.appendChunks(options.taskId, [chunk]).catch((err) => {
          logger.warn(
            { streamId, taskId: options.taskId, error: String(err) },
            'tmux SSE delta buffer append failed',
          );
        });
      }
      this.fanOutChunk(streamId, chunk);
    });

    // 5. Track the stream locally so close()/replay() can find it later.
    //    Done last so a failure in steps 2/3 above never leaves a half-open
    //    stream entry pointing at missing disk state.
    const seed = scrollback + (options.initialScrollback ?? '');
    const stream: TmuxStream = {
      record,
      handle,
      unsubscribeDelta,
      unsubscribeExit: () => {},
      exitReason: undefined,
      subscribers: new Set(),
      exitSubscribers: new Set(),
    };
    this.streams.set(streamId, stream);
    stream.unsubscribeExit = handle.onExit((reason) => {
      if (stream.exitReason) return;
      stream.exitReason = reason ?? 'shell-exited';
      this.electReplayWriter(stream.record.taskId, streamId);
      this.fanOutExit(streamId);
    });

    // 6. Fan out the initial scrollback to subscribers.
    if (seed.length > 0) {
      this.fanOutChunk(streamId, seed);
    }

    return {
      streamId,
      cols: init.cols || cols,
      rows: init.rows || rows,
      scrollback: seed,
      session: resolvedSession,
    };
  }

  /**
   * Send keystrokes to an attached tmux session.
   *
   * Keys are base64-encoded before forwarding to CarapaBox to keep the wire
   * encoding free of escape-sequence issues. The exec response carries no
   * echo — live pane bytes arrive via the SSE pump registered in `open()`.
   */
  async sendKeys(streamId: string, keys: string): Promise<TmuxExecResult> {
    const stream = this.requireStream(streamId);
    const encoded = Buffer.from(keys, 'utf8').toString('base64');
    return await stream.handle.exec({ input: encoded });
  }

  /** Resize an attached tmux pane. */
  async resize(
    streamId: string,
    cols: number,
    rows: number,
  ): Promise<TmuxExecResult> {
    const stream = this.requireStream(streamId);
    return await stream.handle.resize({
      session: stream.record.session,
      cols,
      rows,
    });
  }

  /**
   * Register `onChunk` as a live-chunk sink for `streamId`. Each call returns
   * an `unsubscribe` function the caller MUST invoke when its reader goes
   * away (e.g. on `req.on('close')` for the SSE route) — otherwise the
   * stream's subscriber set leaks.
   *
   * Subscribers are stacked on top of the constructor-level `onChunk` hook,
   * which is preserved unchanged. Initial scrollback is NOT replayed here;
   * call `subscribe` and `replay(streamId)` in the same tick, buffering live
   * chunks until the replay is delivered.
   *
   * If `streamId` is unknown (never opened in this process) the call returns
   * a no-op unsubscribe. The route layer is expected to fall back to the
   * persisted index in that case.
   */
  subscribe(
    streamId: string,
    onChunk: (streamId: string, chunk: string) => void,
  ): () => void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return () => {};
    }
    stream.subscribers.add(onChunk);
    return () => {
      stream.subscribers.delete(onChunk);
    };
  }

  /** Subscribe to a shell exit or loss of the box transport. Closing a local
   *  reader during an ordinary remount does not produce an exit. */
  subscribeExit(
    streamId: string,
    onExit: (
      streamId: string,
      reason?: 'shell-exited' | 'transport-ended',
    ) => void,
  ): () => void {
    const stream = this.streams.get(streamId);
    if (!stream) return () => {};
    if (stream.exitReason) {
      onExit(streamId, stream.exitReason);
      return () => {};
    }
    stream.exitSubscribers.add(onExit);
    return () => {
      stream.exitSubscribers.delete(onExit);
    };
  }

  /**
   * Tear down a stream.
   *
   * - `kill: true`  → also call `detach` on carapa-box (destroys the
   *                   server-side tmux session) and remove the session
   *                   from the persisted index. The buffer file is left on
   *                   disk for post-mortem inspection.
   * - `kill: false` (default) → just close the local SSE/stream reader. The
   *                   buffer file and session record stay around so the tab
   *                   can be remounted.
   */
  async close(streamId: string, options: TmuxCloseOptions = {}): Promise<void> {
    const stream = this.streams.get(streamId);
    this.streams.delete(streamId);
    if (stream) this.electReplayWriter(stream.record.taskId, streamId);

    if (!stream) {
      // Already closed in this process; still honour `kill` semantics
      // against the persisted record if it exists.
      if (options.kill) {
        const record = this.sessions[streamId];
        if (record) {
          delete this.sessions[streamId];
          await this.persistIndex();
        }
      }
      return;
    }

    // Always drop the SSE delta listener + close the handle so the pump
    // releases its fetch reader. This is a local-only operation.
    try {
      stream.unsubscribeDelta();
    } catch {
      /* ignore */
    }
    try {
      stream.unsubscribeExit();
    } catch {
      /* ignore */
    }
    try {
      stream.handle.close();
    } catch (err) {
      logger.warn(
        { streamId, error: String(err) },
        'tmux handle.close() threw during local teardown',
      );
    }

    if (options.kill) {
      const record = this.sessions[streamId];
      try {
        await stream.handle.detach();
      } catch (err) {
        // carapa-box's DELETE /api/tmux/detach may return `HTTP 500
        // {"ok":true,"exitCode":1}` when the tmux session was already
        // gone before the kill (e.g. user Ctrl+D'd out of the shell and
        // tmux exited on its own — the desired end-state). The box now
        // treats that case as a successful no-op (HTTP 200), but a
        // future box version could regress, so the board stays
        // tolerant: when the body carries `ok:true`, log at debug
        // level only. Real failures (network errors, validation
        // failures) still warn.
        const message = err instanceof Error ? err.message : String(err);
        const isBenignAlreadyGone =
          /\bok":true\b/.test(message) && /\bexitCode":1\b/.test(message);
        if (isBenignAlreadyGone) {
          logger.debug(
            { streamId, error: message },
            'tmux detach: session already gone at box (no-op, expected on Ctrl+D close)',
          );
        } else {
          logger.warn(
            { streamId, error: message },
            'tmux detach failed during close(kill:true)',
          );
        }
      }
      if (record) {
        delete this.sessions[streamId];
        await this.persistIndex();
      }
    }
  }

  /** Wait for pane output already received by this client to reach its replay buffer. */
  async flush(streamId: string): Promise<void> {
    const record = this.getRecord(streamId);
    if (record) await this.appendQueues.get(record.taskId);
  }

  /**
   * Tail the buffer file for a stream and return the last N lines.
   *
   * Used by BashTab on mount to repaint the pane before the live stream
   * connects — without it, reconnects would lose the visible context.
   */
  async replay(
    streamId: string,
    options: TmuxReplayOptions = {},
  ): Promise<string> {
    const record = this.sessions[streamId];
    if (!record) {
      return '';
    }
    // Serialize the read behind every append queued so far and cut the
    // coalescing batch, so deltas arriving after this call are appended after
    // the read. A caller that subscribes in the same tick as this call (the
    // SSE route) therefore finds exactly the pre-subscription deltas in the
    // replay and exactly the later ones in its subscription, for any stream
    // of the task. Streams of one task are independent box connections that
    // each deliver their own copy of the pane bytes while only the replay
    // writer's copy is persisted; a non-writer whose copy of a chunk lands
    // at a different time than the writer's can still see it duplicated or
    // missing, which is not recoverable at this layer.
    this.pendingChunks.delete(record.taskId);
    const prev = this.appendQueues.get(record.taskId) ?? Promise.resolve();
    const read = prev
      .catch(() => undefined)
      .then(() => this.readReplay(record, options));
    this.appendQueues.set(
      record.taskId,
      read.catch(() => undefined),
    );
    return await read;
  }

  private async readReplay(
    record: TmuxSessionRecord,
    options: TmuxReplayOptions,
  ): Promise<string> {
    const filePath = this.bufferPathFor(record.taskId);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size === 0) return '';
      const data = await fsp.readFile(filePath, 'utf8');
      const allLines = truncateToWindow(data, this.maxBufferBytes).split('\n');
      // Drop the trailing empty element from a final newline, if any.
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      // A tmux capture can contain a long normal-shell history followed by
      // an alternate-screen TUI. Replaying that entire capture into a fresh
      // xterm leaves stale commands behind the TUI's cursor stream. A pane-
      // sized tail is the actual visible screen; older persisted records fall
      // back to the historical cap until they are reattached once.
      const cap = options.fromLine ?? record.rows ?? this.maxReplayLines;
      const tail = allLines.slice(-cap);
      // Re-join with `\n` separators but DON'T add a trailing newline.
      // The buffer is byte-faithful to what tmux pane-pane wrote; tmux
      // capture-pane already trims trailing row-padding, so adding a
      // newline here would push the cursor down by one line on every
      // remount. If the buffer ends on a real newline (i.e. the shell
      // actually emitted one), the last split element would have been
      // empty and the pop above would have removed it — join gives us
      // the right shape without the forced terminator.
      return tail.join('\n');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return '';
      throw err;
    }
  }

  /**
   * Return the stream record for a streamId. Used by callers (and the
   * cleanup hook) that need to resolve a streamId back to its underlying
   * task/session metadata.
   */
  getRecord(streamId: string): TmuxSessionRecord | undefined {
    return this.sessions[streamId];
  }

  /**
   * Remove the persisted index entry for a given taskId WITHOUT calling
   * the box's detach (the caller has already killed the tmux session
   * directly via `tmux-tool.sh kill`). This prevents orphaned entries
   * from accumulating in `tmux-sessions.json` after a tab is closed.
   *
   * Also closes any in-memory stream handle that might still be open
   * (e.g. if the SSE pump was still running from a prior attach).
   */
  async forgetByTaskId(taskId: string): Promise<void> {
    let dropped = false;
    for (const [streamId, record] of Object.entries(this.sessions)) {
      if (record.taskId !== taskId) continue;
      await this.close(streamId);
      delete this.sessions[streamId];
      dropped = true;
    }
    if (dropped) await this.persistIndex();
  }

  /** Forget all attaches to a specific tmux session in its sandbox. */
  async forgetBySession(
    target: Pick<
      TmuxSessionRecord,
      'stack' | 'service' | 'instance' | 'session'
    >,
  ): Promise<void> {
    let dropped = false;
    for (const [streamId, record] of Object.entries(this.sessions)) {
      if (
        record.stack !== target.stack ||
        record.service !== target.service ||
        record.instance !== target.instance ||
        record.session !== target.session
      )
        continue;
      await this.close(streamId);
      delete this.sessions[streamId];
      dropped = true;
    }
    if (dropped) await this.persistIndex();
  }

  /**
   * List all currently-tracked sessions. Useful for the cleanup hook and
   * for /api/tmux/sessions introspection.
   */
  listSessions(): Record<string, TmuxSessionRecord> {
    return { ...this.sessions };
  }

  /**
   * Remove ALL persisted index entries and in-memory streams for a given
   * sandbox instance. Called when the sandbox container is stopped or
   * restarted — all tmux sessions inside the container die, so the
   * board's index entries are stale and must be cleaned to prevent
   * zombie tabs from reappearing in the UI.
   */
  async forgetByInstance(instance: string): Promise<number> {
    let dropped = 0;
    for (const [streamId, record] of Object.entries(this.sessions)) {
      if (record.instance !== instance) continue;
      await this.close(streamId);
      delete this.sessions[streamId];
      dropped++;
    }
    if (dropped > 0) {
      await this.persistIndex();
      logger.info(
        { instance, dropped },
        '[tmux-client] forgetByInstance: cleaned stale tmux session entries',
      );
    }
    return dropped;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private electReplayWriter(taskId: string, departedStreamId: string): void {
    if (this.replayWriters.get(taskId) !== departedStreamId) return;
    const remaining = [...this.streams.entries()]
      .reverse()
      .find(
        ([id, candidate]) =>
          id !== departedStreamId &&
          candidate.record.taskId === taskId &&
          !candidate.exitReason,
      );
    if (remaining) this.replayWriters.set(taskId, remaining[0]);
    else this.replayWriters.delete(taskId);
  }

  /**
   * Fan a chunk out to the constructor-level `onChunk` hook AND to every
   * subscriber registered via `subscribe()`. Errors thrown by an individual
   * subscriber are swallowed and logged — one bad SSE writer shouldn't break
   * the others.
   */
  private fanOutChunk(streamId: string, chunk: string): void {
    try {
      this.onChunk(streamId, chunk);
    } catch (err) {
      logger.warn(
        { streamId, error: String(err) },
        'tmux onChunk subscriber threw',
      );
    }
    const stream = this.streams.get(streamId);
    if (!stream) return;
    for (const sub of stream.subscribers) {
      try {
        sub(streamId, chunk);
      } catch (err) {
        logger.warn(
          { streamId, error: String(err) },
          'tmux subscribe() subscriber threw',
        );
      }
    }
  }

  private fanOutExit(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    for (const sub of [...stream.exitSubscribers]) {
      try {
        sub(streamId, stream.exitReason);
      } catch (err) {
        logger.warn(
          { streamId, error: String(err) },
          'tmux exit subscriber threw',
        );
      }
    }
  }

  private requireStream(streamId: string): TmuxStream {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(
        `tmux stream not found: ${streamId} (already closed or never opened)`,
      );
    }
    return stream;
  }

  private bufferPathFor(taskId: string): string {
    return resolveInside(this.storeDir, `${taskId}.log`);
  }

  private async ensureDirs(): Promise<void> {
    await fsp.mkdir(this.ipcDir, { recursive: true });
    await fsp.mkdir(this.storeDir, { recursive: true });
  }

  /**
   * Serialize persistIndex calls so concurrent writes don't race on the
   * `.tmp` file. Without this, two concurrent calls both write to
   * `<indexPath>.tmp`, one renames it, and the other gets ENOENT on
   * rename — surfacing as a 500 to the UI.
   */
  private persistQueue: Promise<void> = Promise.resolve();

  private async persistIndex(): Promise<void> {
    this.persistQueue = this.persistQueue
      .then(async () => {
        await this.ensureDirs();
        const tmp = `${this.indexPath}.tmp`;
        await fsp.writeFile(
          tmp,
          JSON.stringify(this.sessions, null, 2),
          'utf8',
        );
        await fsp.rename(tmp, this.indexPath);
      })
      .catch((err) => {
        logger.warn(
          { err: String(err), indexPath: this.indexPath },
          '[tmux-client] persistIndex failed',
        );
      });
    return this.persistQueue;
  }

  /**
   * Append raw pane chunks to the per-task buffer file with a rolling 2 MB
   * window. Lines that would push the file over the cap get dropped from the
   * front so the most recent output is always preserved.
   *
   * Writes are serialized per-taskId via `appendQueues` — the SSE pump calls
   * this from a synchronous listener, so two adjacent deltas otherwise race
   * on read-then-write and clobber each other.
   */
  private appendChunks(taskId: string, chunks: string[]): Promise<void> {
    const pending = this.pendingChunks.get(taskId);
    if (pending) {
      pending.chunks.push(...chunks);
      return pending.promise;
    }
    const batch = { chunks: [...chunks], promise: Promise.resolve() };
    this.pendingChunks.set(taskId, batch);
    const prev = this.appendQueues.get(taskId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => {
        if (this.pendingChunks.get(taskId) === batch)
          this.pendingChunks.delete(taskId);
        return this.appendChunksUnchecked(taskId, batch.chunks);
      });
    batch.promise = next;
    // Track the chain so the next call awaits it, but don't propagate failures
    // back through `appendQueues` (otherwise an unrelated error would break
    // every subsequent append for the same task).
    this.appendQueues.set(
      taskId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Replace the replay buffer with an authoritative tmux pane snapshot. */
  private replaceBuffer(taskId: string, content: string): Promise<void> {
    this.pendingChunks.delete(taskId);
    const prev = this.appendQueues.get(taskId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const filePath = this.bufferPathFor(taskId);
        await fsp.mkdir(this.storeDir, { recursive: true });
        await fsp.writeFile(
          filePath,
          truncateToWindow(content, this.maxBufferBytes),
          'utf8',
        );
      });
    this.appendQueues.set(
      taskId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async appendChunksUnchecked(
    taskId: string,
    chunks: string[],
  ): Promise<void> {
    const joined = chunks.filter((c) => c.length > 0).join('');
    if (!joined) return;

    const filePath = this.bufferPathFor(taskId);
    await fsp.mkdir(this.storeDir, { recursive: true });

    await fsp.appendFile(filePath, joined, 'utf8');
    const stat = await fsp.stat(filePath);
    if (stat.size > this.maxBufferBytes * 1.25) {
      const data = await fsp.readFile(filePath, 'utf8');
      await fsp.writeFile(
        filePath,
        truncateToWindow(data, this.maxBufferBytes),
        'utf8',
      );
    }
  }
}

// ── Internals shared with tests ─────────────────────────────────────────────

interface TmuxStream {
  record: TmuxSessionRecord;
  /** CarapaBox SSE attach handle — owns the live delta pump. */
  handle: TmuxAttachHandle;
  /** Drop the SSE delta listener when the stream closes. */
  unsubscribeDelta: () => void;
  /** Drop the remote-session exit listener when this stream closes. */
  unsubscribeExit: () => void;
  /** Sticky lifecycle state so late subscribers still observe shell exit. */
  exitReason?: 'shell-exited' | 'transport-ended';
  /**
   * Per-stream live-chunk sinks registered via `subscribe()`. Each entry
   * receives every chunk that flows through the constructor-level `onChunk`
   * hook (initial scrollback, live SSE deltas, etc.). Stored in a Set so
   * `subscribe()` / the returned `unsubscribe` are O(1).
   */
  subscribers: Set<(streamId: string, chunk: string) => void>;
  exitSubscribers: Set<
    (streamId: string, reason?: 'shell-exited' | 'transport-ended') => void
  >;
}

/**
 * Truncate `data` so the returned string is at most `maxBytes` long, snapping
 * to the next newline boundary so we never split a line in half.
 */
function truncateToWindow(data: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(data, 'utf8');
  if (buf.length <= maxBytes) {
    return data;
  }
  // Drop bytes from the front; then advance to the next \n to avoid a
  // half-line at the head of the new window. The initial byte offset may
  // land in the middle of a UTF-8 sequence; advance past continuation bytes
  // before decoding so replay never contains a replacement character (and
  // remains within the byte cap after round-tripping through UTF-8).
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  const slice = buf.subarray(start);
  const newlineIdx = slice.indexOf(0x0a);
  if (newlineIdx >= 0 && newlineIdx + 1 < slice.length) {
    return slice.subarray(newlineIdx + 1).toString('utf8');
  }
  return slice.toString('utf8');
}

/**
 * Derive a tmux-safe session name from a task or conversation id.
 * tmux only allows `[a-zA-Z0-9_-]`.
 */
function deriveTmuxSessionName(taskId: string): string {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  if (!sanitized) {
    throw new Error('taskId cannot produce a valid tmux session name');
  }
  return sanitized;
}

function defaultGenerateStreamId(): string {
  // crypto.randomUUID is available in both Node and Bun.
  return globalThis.crypto.randomUUID();
}

// Re-export the truncate helper for tests.
export const __test__ = { truncateToWindow, deriveTmuxSessionName };

// ── Singleton ───────────────────────────────────────────────────────────────

import { getTmuxBoxClient } from './tmux-box-client.js';

let _defaultClient: TmuxClient | null = null;

/**
 * Lazy singleton that wires the production `TmuxBoxClient` into a `TmuxClient`.
 * Mirrors the pattern in `getSandboxClient()` so routes can call a single
 * import without having to construct / dispose the wrapper themselves.
 *
 * Tests construct `TmuxClient` directly with injected deps — never via this
 * helper — so the singleton cannot leak across test files in the same Bun
 * process (see `.agent/rules/08-testing-patterns.md`).
 */
export function getTmuxClient(): TmuxClient {
  if (!_defaultClient) {
    _defaultClient = new TmuxClient({
      box: getTmuxBoxClient(),
    });
  }
  return _defaultClient;
}
