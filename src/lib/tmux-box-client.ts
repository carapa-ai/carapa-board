/**
 * TmuxBoxClient — REST + SSE transport for carapa-box's tmux API.
 *
 * This is the board-side counterpart to carapa-box's new tmux surface:
 *
 *   POST   /api/tmux/attach    → SSE: `init` event first (carries streamId +
 *                                session/cols/rows/scrollback), then a
 *                                continuous stream of `delta` events carrying
 *                                `{ chunk }` strings, followed by `exit` when
 *                                the shell process ends. Connection stays open
 *                                for the life of the tmux attach.
 *   POST   /api/tmux/exec      → JSON body `{ session, input }`. `input` is
 *                                base64-encoded by the caller. The response
 *                                is a small `{ isError, stdout }` shape; live
 *                                echo arrives on the attach SSE stream, NOT
 *                                in this response.
 *   POST   /api/tmux/resize    → JSON body `{ session, cols, rows }`.
 *   DELETE /api/tmux/detach    → JSON body `{ session, streamId }`.
 *
 * The previous MCP-tool path (`sandbox_tmux_attach/exec/detach`) returned a
 * literal `"(no output)"` sentinel for every keystroke and dropped the live
 * pane deltas on the floor — this client replaces it.
 *
 * Auth mirrors `src/lib/mcp-client.ts:73-77` — Bearer token in the
 * `Authorization` header, taken from `CARAPA_BOX_API_TOKEN`. Board → box is
 * server-to-server, so the same token used by `sandboxExec` is reused here.
 *
 * Tests inject a fake `TmuxBoxClient` via constructor so the SSE pump and
 * the request URLs can be asserted on without a real HTTP roundtrip. See
 * `src/lib/tmux-box-client.test.ts` and `src/lib/tmux-client.test.ts`.
 */

import { logger } from '../logger.js';
import { CARAPA_BOX_API_TOKEN, CARAPA_BOX_URL } from '../config.js';
import { boxFetchFor, type BoxFetchArgs } from './box-fetch.js';
import { summarizeBoxFailure } from './box-failure.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface TmuxAttachInit {
  /** CarapaBox-assigned stream identifier; required for detach/resize routing. */
  streamId: string;
  /** Tmux session name (echoed back from the box). */
  session: string;
  /** Terminal dimensions. */
  cols: number;
  rows: number;
  /** Initial pane scrollback captured at attach time. */
  scrollback: string;
}

export interface TmuxAttachOptions {
  session: string;
  cols?: number;
  rows?: number;
}

export interface TmuxExecResult {
  isError: boolean;
  stdout: string;
}

export interface TmuxResizeOptions {
  session: string;
  cols: number;
  rows: number;
}

export interface TmuxExecOptions {
  /** Base64-encoded keystrokes. */
  input: string;
}

export interface TmuxDetachOptions {
  session: string;
  streamId: string;
}

/** Handle returned from `attach()`. Owns the live SSE reader. */
export interface TmuxAttachHandle {
  readonly init: TmuxAttachInit;
  /**
   * Register a delta listener. Multiple listeners are allowed (each gets every
   * chunk in registration order). Returns an unsubscribe function.
   *
   * The listener is invoked synchronously from the SSE pump loop; throwing
   * is allowed and will be logged + swallowed so one bad listener can't kill
   * the pump.
   */
  onDelta(listener: (chunk: string) => void): () => void;
  /** Register a listener for the remote tmux session ending. If the exit
   *  event arrived before registration, the listener is invoked immediately. */
  onExit(
    listener: (reason?: 'shell-exited' | 'transport-ended') => void,
  ): () => void;
  /** Send keystrokes. `input` is base64-encoded by the caller. */
  exec(input: TmuxExecOptions): Promise<TmuxExecResult>;
  /** Resize the attached tmux pane. */
  resize(opts: TmuxResizeOptions): Promise<TmuxExecResult>;
  /** Detach + tear down the tmux session on carapa-box. */
  detach(): Promise<void>;
  /**
   * Release the local SSE reader (aborts the underlying `fetch`). Does NOT
   * call `detach()` — callers that want the tmux session killed must do so
   * explicitly. Idempotent.
   */
  close(): void;
  /**
   * Resolves with the init payload once the SSE pump has read the `init`
   * event. Rejects if the stream ends/errors before `init` arrives or if
   * `close()` is called first. Internal — used by `attach()` so callers
   * never see a handle whose `init` getter would throw.
   */
  waitForInit(): Promise<TmuxAttachInit>;
}

export interface TmuxBoxClientDeps {
  /** Override fetch (tests use this to inject a fake SSE byte stream). */
  fetch?: typeof fetch;
  /** fetch for the box running a sandbox (remote boxes tunnel over the hub). */
  fetchFor?: (args: BoxFetchArgs) => typeof fetch;
  /** Override the wall clock for keepalive / logging. */
  now?: () => number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SSE_PUMP_LOG_INTERVAL_MS = 5_000;

// ── Client ───────────────────────────────────────────────────────────────────

export class TmuxBoxClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchFor?: (args: BoxFetchArgs) => typeof fetch;
  private readonly now: () => number;

  constructor(url: string, token?: string, deps: TmuxBoxClientDeps = {}) {
    // Strip trailing /mcp so REST calls hit the bare base URL — same
    // normalization as src/lib/mcp-client.ts:41.
    this.baseUrl = url.replace(/\/mcp$/, '');
    this.token = token;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.fetchFor = deps.fetchFor;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Attach to a tmux session. Resolves once the `init` SSE event arrives —
   * at that point `init.streamId` is valid and live `delta` events are
   * streaming to registered listeners.
   *
   * Rejects if the HTTP response is non-2xx, if no `init` event arrives,
   * or if the SSE reader errors before `init` is parsed.
   */
  async attach(
    stack: string,
    service: string,
    instance: string,
    options: TmuxAttachOptions,
  ): Promise<TmuxAttachHandle> {
    const url = `${this.baseUrl}/api/tmux/attach`;
    // Attach and the handle's exec/resize/detach address the sandbox's box.
    const fetchImpl =
      this.fetchFor?.({ project: `${stack}-${instance}` }) ?? this.fetchImpl;
    const body = JSON.stringify({
      stack,
      service,
      instance,
      session: options.session,
      ...(options.cols !== undefined ? { cols: options.cols } : {}),
      ...(options.rows !== undefined ? { rows: options.rows } : {}),
    });
    const traceId = `${stack}/${service}/${instance}/${options.session}`;
    const attachStart = Date.now();
    logger.info(
      {
        traceId,
        url,
        session: options.session,
        cols: options.cols,
        rows: options.rows,
      },
      '[tmux-box] attach: POST start',
    );

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: this.jsonHeaders(),
        body,
      });
    } catch (err) {
      logger.error(
        {
          traceId,
          elapsedMs: Date.now() - attachStart,
          error:
            err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
        },
        '[tmux-box] attach: POST fetch failed',
      );
      throw new Error(
        `tmux attach: fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger.info(
      {
        traceId,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        elapsedMs: Date.now() - attachStart,
      },
      '[tmux-box] attach: POST response received',
    );

    if (!response.ok) {
      // Drain the body for the error message but don't try to parse it as SSE.
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        /* ignore */
      }
      logger.error(
        {
          traceId,
          status: response.status,
          detailLength: detail.length,
        },
        '[tmux-box] attach: POST non-ok',
      );
      throw new Error(
        `tmux attach: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    }

    const sseBody = response.body;
    if (!sseBody) {
      throw new Error('tmux attach: response has no body (SSE stream missing)');
    }

    const handle = createAttachHandle(sseBody, {
      baseUrl: this.baseUrl,
      token: this.token,
      fetchImpl,
      now: this.now,
      // Carried into every exec/resize/detach body so the box's zod
      // schemas accept the requests. See AttachContext.stack/service/
      // instance.
      stack,
      service,
      instance,
    });
    // Block until the SSE pump delivers the `init` event so callers
    // see a fully-usable handle. `init` is parsed on the first event
    // the pump reads from the wire; a parse failure (missing
    // streamId/session) propagates as a rejection from this await.
    logger.info({ traceId }, '[tmux-box] attach: waiting for SSE init event');
    try {
      await handle.waitForInit();
    } catch (err) {
      logger.error(
        {
          traceId,
          elapsedMs: Date.now() - attachStart,
          error:
            err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
        },
        '[tmux-box] attach: waitForInit rejected (no init SSE event arrived)',
      );
      throw err;
    }
    logger.info(
      {
        traceId,
        streamId: handle.init.streamId,
        session: handle.init.session,
        cols: handle.init.cols,
        rows: handle.init.rows,
        scrollbackBytes: handle.init.scrollback?.length ?? 0,
        elapsedMs: Date.now() - attachStart,
      },
      '[tmux-box] attach: init event received, handle ready',
    );
    return handle;
  }

  private jsonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _defaultClient: TmuxBoxClient | null = null;

/**
 * Lazy singleton for production use. Reads `CARAPA_BOX_URL` /
 * `CARAPA_BOX_API_TOKEN` from `src/config.ts` at first call so tests can
 * safely construct `TmuxBoxClient` directly with their own URL/token.
 */
export function getTmuxBoxClient(): TmuxBoxClient {
  if (!_defaultClient) {
    _defaultClient = new TmuxBoxClient(CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN, {
      fetchFor: boxFetchFor,
    });
  }
  return _defaultClient;
}

// ── Internal: handle + SSE pump ──────────────────────────────────────────────

interface AttachContext {
  baseUrl: string;
  token: string | undefined;
  fetchImpl: typeof fetch;
  now: () => number;
  /**
   * CarapaBox instance coords captured at attach time. Every subsequent
   * exec/resize/detach call must echo them in the body so the box's
   * zod schemas (src/http/tmux.ts:execSchema/resizeSchema/detachSchema)
   * — which require `stack` and `service` — accept the request. The
   * /api/tmux/* routes have no stack/service/instance in the URL, so
   * the body is the only place to put them.
   */
  stack: string;
  service: string;
  instance: string;
}

/**
 * Build an attach handle from an in-flight SSE `ReadableStream<Uint8Array>`.
 *
 * The pump:
 *  1. Decodes each UTF-8 chunk as it arrives.
 *  2. Splits on `\n\n` boundaries to materialize SSE event records.
 *  3. Resolves the `init` promise on the first `init` event — at that
 *     point `handle.init` is populated and the handle is fully usable.
 *  4. Dispatches every subsequent `delta` event's `chunk` to all
 *     registered listeners (in registration order).
 *
 * Keep this parser small and allocation-light: live pane output streams
 * many events per second while the user is typing.
 */
function createAttachHandle(
  stream: ReadableStream<Uint8Array>,
  ctx: AttachContext,
): TmuxAttachHandle {
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<
    (reason?: 'shell-exited' | 'transport-ended') => void
  >();
  let initResolve!: (init: TmuxAttachInit) => void;
  let initReject!: (err: Error) => void;
  const initPromise = new Promise<TmuxAttachInit>((resolve, reject) => {
    initResolve = resolve;
    initReject = reject;
  });
  let initDelivered = false;
  let initValue: TmuxAttachInit | null = null;
  let closed = false;
  let exitReason: 'shell-exited' | 'transport-ended' | undefined;
  const decoder = new TextDecoder('utf-8');
  // Buffer carries over partial SSE event text across fetch chunks.
  let buffer = '';

  const reader = stream.getReader();

  const notifyExit = (reason: 'shell-exited' | 'transport-ended') => {
    if (exitReason || closed) return;
    exitReason = reason;
    for (const listener of exitListeners) {
      try {
        listener(reason);
      } catch (err) {
        logger.warn(
          { error: String(err) },
          'tmux exit listener threw; swallowing',
        );
      }
    }
  };

  const pump = async () => {
    let lastLogAt = 0;
    let bytesSinceLastLog = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        bytesSinceLastLog += value.byteLength;
        const now = ctx.now();
        if (now - lastLogAt > SSE_PUMP_LOG_INTERVAL_MS) {
          logger.debug(
            { bytes: bytesSinceLastLog },
            'tmux SSE pump bytes received',
          );
          lastLogAt = now;
          bytesSinceLastLog = 0;
        }

        buffer += decoder.decode(value, { stream: true });
        // SSE events are delimited by a blank line. Splitting on `\n\n`
        // and keeping the trailing partial in `buffer` is the standard
        // event-stream parsing trick.
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          dispatchEvent(rawEvent);
        }
      }
      // Stream ended cleanly. Anything left in the buffer is an incomplete
      // event — surface as an error only if we never delivered `init`.
      if (!initDelivered) {
        initReject(
          new Error('tmux attach: SSE stream ended before init event'),
        );
      }
    } catch (err) {
      if (!initDelivered) {
        initReject(
          new Error(
            `tmux attach: SSE pump errored before init: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      } else if (!closed) {
        logger.warn({ error: String(err) }, 'tmux SSE pump errored after init');
      }
    } finally {
      if (initDelivered) notifyExit('transport-ended');
    }
  };

  const dispatchEvent = (rawEvent: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of rawEvent.split('\n')) {
      if (rawLine.length === 0) continue;
      if (rawLine.startsWith(':')) {
        // SSE comment (keep-alive) — ignore.
        continue;
      }
      const colonIdx = rawLine.indexOf(':');
      if (colonIdx < 0) continue;
      const field = rawLine.slice(0, colonIdx);
      let value = rawLine.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        eventName = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
      // Other fields (id, retry) intentionally ignored.
    }

    if (dataLines.length === 0) return;
    const dataText = dataLines.join('\n');

    if (eventName === 'init') {
      if (initDelivered) {
        logger.warn('tmux attach: duplicate init event ignored');
        return;
      }
      let parsed: Partial<TmuxAttachInit>;
      try {
        parsed = JSON.parse(dataText) as Partial<TmuxAttachInit>;
      } catch (err) {
        initReject(
          new Error(
            `tmux attach: init payload is not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
        return;
      }
      const init: TmuxAttachInit = {
        streamId: typeof parsed.streamId === 'string' ? parsed.streamId : '',
        session: typeof parsed.session === 'string' ? parsed.session : '',
        cols: typeof parsed.cols === 'number' ? parsed.cols : 0,
        rows: typeof parsed.rows === 'number' ? parsed.rows : 0,
        scrollback:
          typeof parsed.scrollback === 'string' ? parsed.scrollback : '',
      };
      if (!init.streamId || !init.session) {
        initReject(
          new Error(
            `tmux attach: init payload missing streamId/session: ${dataText}`,
          ),
        );
        return;
      }
      initDelivered = true;
      initValue = init;
      initResolve(init);
      return;
    }

    if (eventName === 'error') {
      let reasonText = dataText;
      try {
        const parsed = JSON.parse(dataText) as { error?: unknown } | null;
        if (parsed && typeof parsed.error === 'string') {
          reasonText = parsed.error;
        }
      } catch {
        /* non-JSON payload — use the raw text */
      }
      const reason = summarizeBoxFailure(reasonText);
      if (initDelivered) {
        logger.warn({ error: reason }, 'tmux attach: box reported error');
      } else {
        // Promise rejection is first-wins, so the later "stream ended before
        // init" rejection cannot overwrite this reason.
        initReject(
          new Error(`tmux attach: box reported error before init: ${reason}`),
        );
      }
      return;
    }

    if (eventName === 'exit') {
      if (initDelivered) notifyExit('shell-exited');
      return;
    }

    if (eventName !== 'delta') return;
    // Anything after `init` is only useful if listeners have registered and
    // init has been delivered. If a delta lands first (it shouldn't, but the
    // wire format allows it), drop it silently — the init listener will see
    // the init shortly.
    if (!initDelivered) return;
    let parsed: { delta?: unknown };
    try {
      parsed = JSON.parse(dataText) as { delta?: unknown };
    } catch (err) {
      logger.warn(
        { error: String(err) },
        'tmux attach: delta payload is not valid JSON; dropped',
      );
      return;
    }
    // The box sends `{ streamId, delta }` (see carapa-box/src/http/tmux.ts
    // handleAttach onDelta callback); `delta` is the raw pane bytes.
    const raw = typeof parsed.delta === 'string' ? parsed.delta : null;
    if (raw === null || raw.length === 0) return;
    const chunk = raw;
    for (const listener of listeners) {
      try {
        listener(chunk);
      } catch (err) {
        logger.warn(
          { error: String(err) },
          'tmux delta listener threw; swallowing',
        );
      }
    }
  };

  // Start pumping; don't await — the handle is usable immediately, callers
  // await the `init` promise themselves (or just access `handle.init`
  // after `await handle.exec(...)` etc. — exec/resize/detach all await
  // init internally so the public surface stays synchronous).
  void pump();

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      void reader.cancel();
    } catch {
      /* ignore */
    }
    if (!initDelivered) {
      initReject(new Error('tmux attach: handle closed before init event'));
    }
  };

  const ensureInit = async (): Promise<TmuxAttachInit> => {
    if (initValue) return initValue;
    return initPromise;
  };

  const exec: TmuxAttachHandle['exec'] = async (input) => {
    const init = await ensureInit();
    return execTmux(ctx, {
      session: init.session,
      input: input.input,
    });
  };

  const resize: TmuxAttachHandle['resize'] = async (opts) => {
    return resizeTmux(ctx, opts);
  };

  const detach: TmuxAttachHandle['detach'] = async () => {
    const init = await ensureInit();
    await detachTmux(ctx, {
      session: init.session,
      streamId: init.streamId,
    });
  };

  return {
    get init(): TmuxAttachInit {
      if (!initValue) {
        throw new Error('tmux attach: init not yet received');
      }
      return initValue;
    },
    onDelta: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onExit: (cb) => {
      if (exitReason) {
        cb(exitReason);
        return () => {};
      }
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
    exec,
    resize,
    detach,
    close,
    waitForInit: () => initPromise,
  };
}

// ── Internal: REST calls ─────────────────────────────────────────────────────

async function execTmux(
  ctx: AttachContext,
  opts: { session: string; input: string },
): Promise<TmuxExecResult> {
  // The box's execSchema requires `stack` and `service` (and accepts
  // `instance`). The URLs are at the bare /api/tmux/* path with no
  // instance coords, so the body is the only place to put them.
  //
  // `inputBase64: true` is REQUIRED: the high-level API contract is
  // that `input` is base64-encoded bytes from the caller (the board
  // has already encoded the raw keystrokes in `TmuxClient.sendKeys`
  // to keep escape sequences intact over JSON). Without this flag the
  // box treats `input` as literal text and forwards it to
  // `tmux send-keys -l` verbatim — which is how a typed `h` was
  // arriving at the shell as the literal string `aA==`.
  return jsonRequest<TmuxExecResult>(ctx, `${ctx.baseUrl}/api/tmux/exec`, {
    method: 'POST',
    body: JSON.stringify({
      stack: ctx.stack,
      service: ctx.service,
      instance: ctx.instance,
      session: opts.session,
      input: opts.input,
      inputBase64: true,
    }),
  });
}

async function resizeTmux(
  ctx: AttachContext,
  opts: TmuxResizeOptions,
): Promise<TmuxExecResult> {
  return jsonRequest<TmuxExecResult>(ctx, `${ctx.baseUrl}/api/tmux/resize`, {
    method: 'POST',
    body: JSON.stringify({
      stack: ctx.stack,
      service: ctx.service,
      instance: ctx.instance,
      session: opts.session,
      cols: opts.cols,
      rows: opts.rows,
    }),
  });
}

async function detachTmux(
  ctx: AttachContext,
  opts: TmuxDetachOptions,
): Promise<void> {
  await jsonRequest<unknown>(ctx, `${ctx.baseUrl}/api/tmux/detach`, {
    method: 'DELETE',
    body: JSON.stringify({
      stack: ctx.stack,
      service: ctx.service,
      instance: ctx.instance,
      session: opts.session,
      streamId: opts.streamId,
    }),
  });
}

async function jsonRequest<T>(
  ctx: AttachContext,
  url: string,
  init: { method: string; body: string },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (ctx.token) {
    headers['Authorization'] = `Bearer ${ctx.token}`;
  }
  let response: Response;
  try {
    response = await ctx.fetchImpl(url, {
      method: init.method,
      headers,
      body: init.body,
    });
  } catch (err) {
    throw new Error(
      `tmux ${init.method} ${url}: fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `tmux ${init.method} ${url}: HTTP ${response.status} ${
        response.statusText
      }${detail ? ` — ${detail}` : ''}`,
    );
  }
  // detach() returns void and may respond with empty body — be tolerant.
  const text = await response.text();
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some endpoints may return a plain string — wrap it in the expected
    // TmuxExecResult shape so callers don't have to special-case.
    return { stdout: text, isError: false } as T;
  }
}
