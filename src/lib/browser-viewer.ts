import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  browserIdle,
  type BrowserIdleService,
} from '../sandbox/browser-idle.js';
import { CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN } from '../config.js';
import { boxFetchFor, type BoxFetchArgs } from './box-fetch.js';
import {
  authorizeBrowser,
  type ManagedBrowser,
  type BrowserTarget,
} from './browser-session-access.js';

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_INPUT = 64 * 1024;
const MAX_PENDING_VIEWERS = 256;
const MAX_PENDING_VIEWERS_PER_USER = 8;

export class BrowserViewerLimitError extends Error {}
type ViewerRequest = {
  userId: string;
  projectId: string;
  sessionId: string;
  expires: number;
};
export interface BrowserViewerDeps {
  authorize(
    userId: string,
    projectId: string,
    sessionId: string,
  ): Promise<ManagedBrowser | null>;
  fetch: typeof fetch;
  /** fetch for the box running a sandbox (remote boxes tunnel over the hub). */
  fetchFor?: (args: BoxFetchArgs) => typeof fetch;
  baseUrl: string;
  token?: string;
  now: () => number;
  idle?: Pick<BrowserIdleService, 'view'>;
}

export class BrowserViewerService {
  private readonly pending = new Map<string, ViewerRequest>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INPUT,
  });
  constructor(private readonly deps: BrowserViewerDeps) {}

  async issue(
    userId: string,
    projectId: string,
    sessionId: string,
  ): Promise<string | null> {
    if (!(await this.deps.authorize(userId, projectId, sessionId))) return null;
    let userPending = 0;
    for (const [id, entry] of this.pending) {
      if (entry.expires <= this.deps.now()) this.pending.delete(id);
      else if (entry.userId === userId) userPending++;
    }
    if (
      this.pending.size >= MAX_PENDING_VIEWERS ||
      userPending >= MAX_PENDING_VIEWERS_PER_USER
    )
      throw new BrowserViewerLimitError('Too many pending browser viewers');
    const id = randomUUID();
    this.pending.set(id, {
      userId,
      projectId,
      sessionId,
      expires: this.deps.now() + 30_000,
    });
    return id;
  }

  /** The shared upgrade router has already authenticated the socket's user. */
  async upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const id =
      new URL(req.url || '/', 'http://localhost').searchParams.get(
        'viewerId',
      ) || '';
    const entry = this.pending.get(id);
    this.pending.delete(id);
    const userId = (req as IncomingMessage & { __userId?: string }).__userId;
    if (
      !entry ||
      entry.expires <= this.deps.now() ||
      !userId ||
      entry.userId !== userId
    ) {
      socket.destroy();
      return;
    }
    const managed = await this.deps.authorize(
      userId,
      entry.projectId,
      entry.sessionId,
    );
    if (!managed || socket.destroyed) {
      socket.destroy();
      return;
    }
    const presence = managed.persistent
      ? await this.deps.idle?.view(managed.persistent)
      : undefined;
    if (socket.destroyed) {
      presence?.release();
      return;
    }
    // A rejected WebSocket handshake never reaches attach() and its close hook.
    socket.once('close', () => presence?.release());
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.attach(ws, entry, managed.run, presence);
      });
    } catch (error) {
      presence?.release();
      throw error;
    }
  }

  private async attach(
    ws: WebSocket,
    entry: ViewerRequest,
    run: BrowserTarget,
    presence?: Awaited<ReturnType<BrowserIdleService['view']>>,
  ): Promise<void> {
    const controller = new AbortController();
    // The viewer, its input and its detach all address the run's own box.
    const boxFetch =
      run.sandbox_instance && this.deps.fetchFor
        ? this.deps.fetchFor({
            project: `${run.sandbox_stack}-${run.sandbox_instance}`,
          })
        : this.deps.fetch;
    const base = this.deps.baseUrl.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
    const headers = {
      Authorization: `Bearer ${this.deps.token || ''}`,
      'Content-Type': 'application/json',
    };
    let boxId: string | undefined;
    let closed = false;
    let ready = false;
    let input: string[] = [];
    let inputBytes = 0;
    let sending = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    const status = (state: string, error?: string) =>
      send(
        JSON.stringify({ method: 'carapaStatus', params: { state, error } }),
      );
    const close = () => {
      if (closed) return;
      closed = true;
      presence?.release();
      clearInterval(ownershipTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(flushTimer);
      clearTimeout(startupTimer);
      controller.abort();
      input = [];
      if (boxId)
        void boxFetch(`${base}/api/browser/${boxId}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Viewer detached');
    };
    const send = (data: string) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (
        Buffer.byteLength(data) > MAX_FRAME ||
        ws.bufferedAmount > MAX_FRAME
      ) {
        close();
        return;
      }
      ws.send(data);
    };
    const flush = async () => {
      if (!ready || !boxId || closed || sending || !input.length) return;
      sending = true;
      const batch = input;
      input = [];
      inputBytes = 0;
      try {
        const response = await boxFetch(`${base}/api/browser/${boxId}/input`, {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Browser input failed');
      } catch {
        status('disconnected');
        close();
      } finally {
        sending = false;
        if (input.length && !closed)
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            void flush();
          }, 16);
      }
    };
    const ownershipTimer = setInterval(() => {
      if (checking || closed) return;
      checking = true;
      void this.deps
        .authorize(entry.userId, entry.projectId, entry.sessionId)
        .then((active) => {
          if (!active) {
            status('ended');
            close();
          }
        })
        .catch(() => {
          status('disconnected');
          close();
        })
        .finally(() => {
          checking = false;
        });
    }, 2000);
    ownershipTimer.unref();
    // A vanished client must not keep an otherwise idle browser alive forever.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeatTimer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        close();
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    heartbeatTimer.unref();
    const startupTimer = setTimeout(() => {
      status('disconnected', 'Browser viewer startup timed out');
      close();
    }, 30_000);
    startupTimer.unref();
    ws.on('close', close);
    ws.on('error', close);
    ws.on('message', (data, isBinary) => {
      const line = data.toString();
      inputBytes += Buffer.byteLength(line);
      if (
        isBinary ||
        inputBytes > MAX_INPUT / 2 ||
        input.length >= 128 ||
        line.includes('\n')
      ) {
        close();
        return;
      }
      try {
        const message = JSON.parse(line);
        if (
          message?.method === 'setVisible' &&
          typeof message.params?.visible === 'boolean'
        )
          presence?.visible(message.params.visible);
      } catch {
        close();
        return;
      }
      input.push(line);
      if (!flushTimer)
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, 16);
    });
    try {
      if (!this.deps.token)
        throw new Error('CarapaBox browser access is not configured');
      const response = await boxFetch(`${base}/api/browser/attach`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          stack: run.sandbox_stack,
          service: run.sandbox_service,
          instance: run.sandbox_instance || undefined,
          sessionId: run.id,
        }),
      });
      if (!response.ok || !response.body)
        throw new Error('CarapaBox could not attach the browser viewer');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(pending) > MAX_FRAME)
          throw new Error('Browser frame too large');
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const event = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (event.type === 'attached') {
            if (!/^[a-f0-9-]{36}$/.test(event.viewerId))
              throw new Error('Invalid browser attachment');
            boxId = event.viewerId;
          } else if (event.type === 'ready') {
            ready = true;
            clearTimeout(startupTimer);
            status('waiting');
            void flush();
          } else if (event.type === 'message' && typeof event.data === 'string')
            send(event.data);
          else if (event.type === 'error')
            throw new Error(String(event.error).slice(0, 300));
          else if (event.type === 'ended') {
            status('ended');
            close();
          }
        }
      }
      if (!closed) status('disconnected');
    } catch (error) {
      if (!closed)
        status(
          'disconnected',
          error instanceof Error ? error.message : 'Browser connection failed',
        );
    } finally {
      close();
    }
  }
}

export const browserViewers = new BrowserViewerService({
  authorize: authorizeBrowser,
  fetch: globalThis.fetch.bind(globalThis),
  fetchFor: boxFetchFor,
  baseUrl: CARAPA_BOX_URL,
  token: CARAPA_BOX_API_TOKEN,
  now: Date.now,
  idle: { view: (browser) => browserIdle.view(browser) },
});
