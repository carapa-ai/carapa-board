/**
 * HTTP bridge for tmux streams.
 *
 * Exposes on-demand bash shell sessions (started via POST
 * /api/projects/:projectId/shells) to the browser via:
 *
 *   POST   /api/sandboxes/:stack/:service/:instance/tmux/sessions          → open
 *   GET    /api/sandboxes/:stack/:service/:instance/tmux/sessions/:sid/output  → SSE
 *   POST   /api/sandboxes/:stack/:service/:instance/tmux/sessions/:sid/input   → sendKeys
 *   POST   /api/sandboxes/:stack/:service/:instance/tmux/sessions/:sid/resize  → resize
 *   DELETE /api/sandboxes/:stack/:service/:instance/tmux/sessions/:sid        → close(kill:true)
 *
 * The SSE channel replays the persisted scrollback on connect and then
 * forwards live chunks for the duration of the request. Closing the request
 * (tab close, refresh) does NOT kill the tmux session — only the explicit
 * DELETE endpoint does. That matches the BashTab contract: a tab may
 * disconnect and remount without losing context.
 */

import { Router } from 'express';
import {
  getTmuxClient,
  type TmuxClient,
  type TmuxSessionRecord,
} from '../lib/tmux-client.js';
import { getOnDemandSandboxes } from '../lib/on-demand-sandboxes.js';
import { isSafeIdentifier, userHasExplicitGroupAccess } from './_helpers.js';
import { logger } from '../logger.js';
import { registeredGroups } from '../state-manager.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import { startSseKeepAlive } from '../lib/sse-keepalive.js';

const router = Router();

/** Max raw base64 length accepted by the input handler (64 KiB of base64
 *  decodes to ~48 KiB of UTF-8 keys, which is far more than a single
 *  keystroke burst but still cheap to allocate and parse). */
const MAX_INPUT_DATA_BYTES = 64 * 1024;

/** Standard base64 alphabet — matches what `Buffer.from(_, 'base64')`
 *  consumes. Trailing `=` padding is optional. Empty string is rejected
 *  upstream by the `if (!data)` check, so the `*` quantifier is fine. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function stopKeepAlive(timer: NodeJS.Timeout | null): void {
  if (!timer) return;
  clearInterval(timer);
}

/**
 * Pull the (stack, service, instance) tuple out of the route params and
 * sanity-check the values. Returns `null` and writes a 400 if anything is
 * missing or fails `isSafeIdentifier`.
 */
function parseSandboxParams(
  req: any,
  res: any,
): { stack: string; service: string; instance: string } | null {
  const { stack, service, instance } = req.params as Record<string, string>;
  if (!stack || !service || !instance) {
    res
      .status(400)
      .json({ error: 'stack, service, and instance are required' });
    return null;
  }
  if (
    !isSafeIdentifier(stack) ||
    !isSafeIdentifier(service) ||
    !isSafeIdentifier(instance)
  ) {
    res.status(400).json({ error: 'Invalid stack, service, or instance' });
    return null;
  }
  return { stack, service, instance };
}

/**
 * Authorize the caller to open a tmux session on the given sandbox
 * instance. The on-demand tracker is the sole source of truth — only
 * sandboxes the user explicitly started via the chat bash tab are
 * eligible. Active agent runs are NOT attachable: the agent runs
 * headless (`claude -p` / `codex exec`) and has no tmux pane to
 * attach to. If the user wants to interact with an agent, they open
 * an on-demand shell and type `claude` or `codex` directly.
 */
async function authorizeInstance(
  req: any,
  res: any,
  instance: string,
  opts: { write?: boolean } = {},
): Promise<{ groupFolder: string } | null> {
  const onDemand = getOnDemandSandboxes().findByInstance(instance);
  if (!onDemand) {
    res.status(404).json({ error: 'No on-demand sandbox for this instance' });
    return null;
  }
  if (!(await userHasExplicitGroupAccess(req, onDemand.projectId, opts))) {
    // A parent-owned shared sandbox is also the effective sandbox of each
    // inheriting child. Permit callers who can access one of those children;
    // otherwise the child shell list could expose an inherited tab that the
    // same caller is then forbidden to attach to.
    let inheritedGroupFolder: string | undefined;
    for (const group of Object.values(registeredGroups)) {
      if (group.folder === onDemand.projectId) continue;
      let effective;
      try {
        effective = resolveEffectiveSandbox(group);
      } catch {
        continue;
      }
      if (
        !effective.inherited ||
        effective.owner.folder !== onDemand.projectId ||
        effective.instance !== instance
      ) {
        continue;
      }
      if (await userHasExplicitGroupAccess(req, group.folder, opts)) {
        inheritedGroupFolder = group.folder;
        break;
      }
    }
    if (!inheritedGroupFolder) {
      res.status(403).json({ error: 'Access denied to this project' });
      return null;
    }
    return { groupFolder: inheritedGroupFolder };
  }
  return { groupFolder: onDemand.projectId };
}

/**
 * Look up a tmux stream by id and verify it belongs to the (stack, service,
 * instance) tuple from the route params. Writes 404 and returns null on miss.
 *
 * This is the single early-return gate used by the input / resize / close /
 * output handlers: it both null-checks the record AND enforces that a
 * streamId issued for one instance cannot be replayed against another
 * instance's URL (which would otherwise let a caller authorized for
 * instance A drive keystrokes into instance B's tmux session).
 */
function requireStreamForInstance(
  client: TmuxClient,
  streamId: string,
  params: { stack: string; service: string; instance: string },
  res: any,
): TmuxSessionRecord | null {
  const record = client.getRecord(streamId);
  if (
    !record ||
    record.stack !== params.stack ||
    record.service !== params.service ||
    record.instance !== params.instance
  ) {
    res.status(404).json({ error: 'Unknown streamId' });
    return null;
  }
  return record;
}

/**
 * POST /api/sandboxes/:stack/:service/:instance/tmux/sessions
 * Body: { taskId: string, sessionId?: string, cols?: number, rows?: number }
 *
 * Attaches to a tmux session in the given sandbox and returns the metadata
 * the frontend needs to wire up an SSE subscription. The `taskId` is a
 * stable client-supplied tmux-session identifier (see `tmux-client.open`).
 */
router.post(
  '/sandboxes/:stack/:service/:instance/tmux/sessions',
  async (req: any, res) => {
    const params = parseSandboxParams(req, res);
    if (!params) return;

    const taskId =
      typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : '';
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) {
      return res.status(400).json({
        error:
          'taskId must be 1-200 characters of letters, numbers, underscores, or hyphens',
      });
    }
    const sessionId =
      typeof req.body?.sessionId === 'string'
        ? req.body.sessionId.trim()
        : undefined;
    if (sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return res.status(400).json({
        error:
          'sessionId must contain only letters, numbers, underscores, or hyphens',
      });
    }
    const reqCols =
      typeof req.body?.cols === 'number' ? req.body.cols : undefined;
    const reqRows =
      typeof req.body?.rows === 'number' ? req.body.rows : undefined;

    const routeTraceId = `${params.stack}/${params.service}/${params.instance}/${taskId}`;
    const routeStart = Date.now();
    logger.info(
      { traceId: routeTraceId, cols: reqCols, rows: reqRows },
      '[tmux-route] open: parseSandboxParams + body ok',
    );

    const authorized = await authorizeInstance(req, res, params.instance, {
      write: true,
    });
    if (!authorized) return;
    logger.info(
      { traceId: routeTraceId, elapsedMs: Date.now() - routeStart },
      '[tmux-route] open: authorized',
    );

    try {
      const client = getTmuxClient();
      logger.info(
        {
          stack: params.stack,
          service: params.service,
          instance: params.instance,
          taskId,
        },
        'tmux session open requested',
      );
      const openStart = Date.now();
      const result = await client.open({
        stack: params.stack,
        service: params.service,
        instance: params.instance,
        taskId,
        ...(sessionId ? { session: sessionId } : {}),
        cols: reqCols,
        rows: reqRows,
      });
      logger.info(
        {
          traceId: routeTraceId,
          streamId: result.streamId,
          session: result.session,
          cols: result.cols,
          rows: result.rows,
          elapsedMs: Date.now() - openStart,
        },
        '[tmux-route] open: client.open resolved',
      );
      res.json({
        streamId: result.streamId,
        cols: result.cols,
        rows: result.rows,
        sessionName: result.session,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          traceId: routeTraceId,
          elapsedMs: Date.now() - routeStart,
          error:
            err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
        },
        '[tmux-route] open: client.open rejected',
      );
      res.status(500).json({ error: message });
    }
  },
);

/**
 * DELETE /api/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId
 *
 * Tears down the tmux session. Used by the "Disconnect" button — closes
 * both the local stream and the remote tmux session.
 *
 * Query params:
 *   - kill=true  → also call detach on carapa-box to destroy the
 *                  server-side tmux session. Use this for dedicated
 *                  on-demand shells where the tmux session is owned by
 *                  the bash tab and no other consumer (agent, viewer)
 *                  is using it. (Default behaviour for the chat
 *                  on-demand path.)
 *   - kill=false → only close the local SSE/stream reader. The tmux
 *                  session itself stays alive so any agent still attached
 *                  to it (or any sibling viewer) keeps working. Required
 *                  whenever a user closes a bash tab that is attached
 *                  to a RUNNING agent's sandbox — otherwise we'd
 *                  destroy the shared session and interrupt the agent.
 */
router.delete(
  '/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId',
  async (req: any, res) => {
    const params = parseSandboxParams(req, res);
    if (!params) return;

    const streamId =
      typeof req.params.streamId === 'string' ? req.params.streamId.trim() : '';
    if (!streamId) {
      return res.status(400).json({ error: 'streamId is required' });
    }

    // Parse the kill flag. Accept the canonical 'true' / 'false' strings;
    // anything else (including omitted) defaults to false so a buggy
    // client never accidentally tears down an active agent's tmux
    // session. The spec is explicit: kill=true is ONLY safe for
    // dedicated on-demand shells with no agent attached.
    const rawKill =
      typeof req.query?.kill === 'string'
        ? req.query.kill.trim().toLowerCase()
        : '';
    const kill = rawKill === 'true';

    const authorized = await authorizeInstance(req, res, params.instance, {
      write: true,
    });
    if (!authorized) return;

    try {
      const client = getTmuxClient();
      if (!requireStreamForInstance(client, streamId, params, res)) return;
      await client.close(streamId, { kill });
      res.json({ ok: true, streamId, kill });
    } catch (err) {
      logger.error(
        { streamId, error: String(err) },
        'tmux session close failed',
      );
      res.status(500).json({ error: String(err) });
    }
  },
);

/**
 * POST /api/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId/input
 * Body: { data: string } (base64-encoded keystrokes)
 *
 * Forwards keystrokes to the attached tmux session.
 */
router.post(
  '/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId/input',
  async (req: any, res) => {
    const params = parseSandboxParams(req, res);
    if (!params) return;

    const streamId =
      typeof req.params.streamId === 'string' ? req.params.streamId.trim() : '';
    if (!streamId) {
      return res.status(400).json({ error: 'streamId is required' });
    }

    const data = typeof req.body?.data === 'string' ? req.body.data : '';
    if (!data) {
      return res
        .status(400)
        .json({ error: 'data (base64-encoded keystrokes) is required' });
    }
    if (data.length > MAX_INPUT_DATA_BYTES) {
      return res.status(413).json({
        error: `data exceeds maximum length of ${MAX_INPUT_DATA_BYTES} characters`,
      });
    }
    if (!BASE64_RE.test(data)) {
      return res.status(400).json({ error: 'data is not valid base64' });
    }
    const keys = Buffer.from(data, 'base64').toString('utf8');

    const authorized = await authorizeInstance(req, res, params.instance, {
      write: true,
    });
    if (!authorized) return;

    try {
      const client = getTmuxClient();
      if (!requireStreamForInstance(client, streamId, params, res)) return;
      const result = await client.sendKeys(streamId, keys);
      res.json({
        ok: !result.isError,
        isError: result.isError,
        stdout: result.stdout,
      });
    } catch (err) {
      logger.error({ streamId, error: String(err) }, 'tmux sendKeys failed');
      res.status(500).json({ error: String(err) });
    }
  },
);

/**
 * POST /api/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId/resize
 * Body: { cols: number, rows: number }
 *
 * Resizes the attached tmux pane.
 */
router.post(
  '/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId/resize',
  async (req: any, res) => {
    const params = parseSandboxParams(req, res);
    if (!params) return;

    const streamId =
      typeof req.params.streamId === 'string' ? req.params.streamId.trim() : '';
    if (!streamId) {
      return res.status(400).json({ error: 'streamId is required' });
    }

    const cols = Number(req.body?.cols);
    const rows = Number(req.body?.rows);
    if (
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols <= 0 ||
      rows <= 0 ||
      cols > 1000 ||
      rows > 1000
    ) {
      return res
        .status(400)
        .json({ error: 'cols and rows must be positive numbers ≤ 1000' });
    }

    const authorized = await authorizeInstance(req, res, params.instance, {
      write: true,
    });
    if (!authorized) return;

    try {
      const client = getTmuxClient();
      if (!requireStreamForInstance(client, streamId, params, res)) return;
      const result = await client.resize(streamId, cols, rows);
      res.json({
        ok: !result.isError,
        isError: result.isError,
        stdout: result.stdout,
      });
    } catch (err) {
      logger.error(
        { streamId, cols, rows, error: String(err) },
        'tmux resize failed',
      );
      res.status(500).json({ error: String(err) });
    }
  },
);

/**
 * GET /api/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId/output
 * SSE endpoint. Emits:
 *   - `replay` event with buffered scrollback on connect
 *   - `data` events with `{chunk, ts}` for live updates
 *   - `exit` when the underlying shell process ends
 *
 * Closing the request only unsubscribes from live updates — the tmux
 * session itself is left alive.
 */
router.get(
  '/sandboxes/:stack/:service/:instance/tmux/sessions/:streamId/output',
  async (req: any, res) => {
    const params = parseSandboxParams(req, res);
    if (!params) return;

    const streamId =
      typeof req.params.streamId === 'string' ? req.params.streamId.trim() : '';
    if (!streamId) {
      return res.status(400).json({ error: 'streamId is required' });
    }

    const authorized = await authorizeInstance(req, res, params.instance);
    if (!authorized) return;

    const client = getTmuxClient();
    if (!requireStreamForInstance(client, streamId, params, res)) return;

    // Set up SSE headers BEFORE writing anything. Express needs the explicit
    // status + headers for `curl -N` to switch to streaming mode.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx response buffering
    res.flushHeaders?.();

    const keepAlive = startSseKeepAlive(res);

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      stopKeepAlive(keepAlive);
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // best-effort
        }
      }
      if (unsubscribeExit) {
        try {
          unsubscribeExit();
        } catch {
          // best-effort
        }
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // already closed
        }
      }
    };

    req.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    // 1. Subscribe BEFORE reading the replay and buffer live chunks: a delta
    //    arriving while the replay file is read is fanned out immediately but
    //    appended to the file later, so without an early subscription it
    //    would be in neither the replay nor the live stream.
    //
    //    The `event: data` field is REQUIRED — without it, the browser's
    //    EventSource dispatches the payload as a `message` event (the SSE
    //    default), not `data`. The bash tab's `addEventListener('data', ...)`
    //    is the only listener and would silently never fire. The `replay`
    //    frame below uses `event: replay` for the same reason.
    const writeChunk = (chunk: string) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(
          `event: data\ndata: ${JSON.stringify({ chunk, ts: Date.now() })}\n\n`,
        );
      } catch (err) {
        logger.warn(
          { streamId, error: String(err) },
          'tmux SSE write failed; closing subscription',
        );
        cleanup();
      }
    };
    let buffered: string[] | null = [];
    unsubscribe = client.subscribe(streamId, (_sid, chunk) => {
      if (buffered) buffered.push(chunk);
      else writeChunk(chunk);
    });

    // 2. Replay buffered scrollback as a named event so the client can
    //    distinguish the initial dump from subsequent live updates. `replay()`
    //    is called in the same tick as `subscribe()` above, so it holds
    //    exactly the deltas from before the subscription and `buffered` holds
    //    exactly the later ones.
    let replay = '';
    let replayError: string | undefined;
    try {
      replay = await client.replay(streamId);
    } catch (err) {
      replayError = String(err);
      logger.warn(
        { streamId, error: replayError },
        'tmux replay failed; continuing with live-only stream',
      );
    }

    // The client may have disconnected while the replay was awaited; cleanup
    // already released the subscription, so do not write.
    if (closed) return;

    // An empty replay is still emitted so the client knows the replay phase
    // finished and any subsequent `data` events are live.
    res.write(
      `event: replay\ndata: ${JSON.stringify({
        chunk: replay,
        ts: Date.now(),
        ...(replayError ? { error: replayError } : {}),
      })}\n\n`,
    );

    // 3. Flush chunks that arrived during the replay read, then go live.
    const pending = buffered;
    buffered = null;
    for (const chunk of pending) writeChunk(chunk);

    unsubscribeExit = client.subscribeExit(streamId, (sid, reason) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(
          `event: exit\ndata: ${JSON.stringify({ streamId: sid, reason: reason ?? 'shell-exited', ts: Date.now() })}\n\n`,
        );
      } finally {
        cleanup();
      }
    });
  },
);

export default router;
