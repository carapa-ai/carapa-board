import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  WEB_BROWSER_SIDECAR_URL,
  WEB_BROWSER_SIDECAR_TOKEN,
  WEB_BROWSER_AGENT_GATEWAY_URL,
  WEB_BROWSER_TAB_LEASE_MS,
  WEB_BROWSER_TAB_MAX_LIFETIME_MS,
} from '../../config.js';
import { logger } from '../../logger.js';
import { equalSecret, type SessionInput } from './sidecar/sessions.js';

export const BROWSER_CDP_PATH =
  /^\/api\/web-browser\/sessions\/(web-view-[a-f0-9-]{36}|browser-tab-[a-f0-9]{40})\/cdp$/;
const MAX_FRAME = 16 * 1024 * 1024;
interface Lease extends SessionInput {
  timer: ReturnType<typeof setTimeout>;
  sockets: Set<WebSocket>;
  /** Tab leases are renewed until this instant, then closed. */
  renewUntil?: number;
}

/** The hub lease backing a persistent browser tab on a native runner. */
export interface TabLease {
  /** Not secret: written to the browser descriptor. */
  endpoint: string;
  /** Capability header value; pass only through per-command exec env. */
  headers: string;
}

/** Deterministic, so a Board restart can replace a lease it no longer tracks. */
export function tabLeaseId(browserId: string): string {
  const hex = /^browser-([a-f0-9]{40})$/.exec(browserId)?.[1];
  if (!hex) throw new Error('Invalid persistent browser id');
  return `browser-tab-${hex}`;
}

class SidecarRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The sidecar answered that the session no longer exists. */
function sessionGone(error: unknown): boolean {
  return (
    error instanceof SidecarRequestError &&
    (error.status === 404 || error.status === 410)
  );
}

export class WebBrowserSessions {
  private readonly leases = new Map<string, Lease>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
  });
  constructor(
    private readonly options: {
      sidecarUrl: string;
      token: string;
      gatewayUrl: string;
      fetch: (url: string, init: RequestInit) => Promise<Response>;
      /** Renewal window of a tab lease; the sidecar caps each extension to it. */
      tabLeaseMs?: number;
      /** Longest a tab lease is renewed after it was created. */
      tabMaxLifetimeMs?: number;
    },
  ) {}

  private async request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: SessionInput | { expiresAt: number },
  ) {
    if (!this.options.token)
      throw new Error('Browser sidecar is not configured');
    const response = await this.options.fetch(
      `${this.options.sidecarUrl}${path}`,
      {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new SidecarRequestError(
        response.status === 429
          ? 'Browser sidecar capacity exhausted'
          : `Browser sidecar request failed (${response.status})`,
        response.status,
      );
    }
    await response.body?.cancel();
  }

  private async open(
    id: string,
    group: string,
    runId: string,
    expiresAt: number,
    signal: AbortSignal,
    onTimer: (lease: Lease) => ReturnType<typeof setTimeout>,
    renewUntil?: number,
  ): Promise<Lease> {
    if (!runId || this.leases.has(id))
      throw new Error('Invalid browser extraction run');
    const lease: Lease = {
      id,
      group,
      runId,
      expiresAt,
      renewUntil,
      token: randomBytes(32).toString('hex'),
      sockets: new Set(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    lease.timer = onTimer(lease);
    lease.timer.unref();
    this.leases.set(id, lease);
    try {
      await this.request('/sessions', 'POST', signal, {
        id,
        group,
        runId,
        expiresAt,
        token: lease.token,
      });
      signal.throwIfAborted();
      if (!this.leases.has(id)) throw new Error('Browser extraction expired');
      return lease;
    } catch (error) {
      void this.close(id).catch(() => {});
      throw error;
    }
  }

  private endpoint(id: string): string {
    return `${this.options.gatewayUrl}/api/web-browser/sessions/${id}/cdp`;
  }

  async create(
    id: string,
    group: string,
    runId: string,
    expiresAt: number,
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const lease = await this.open(id, group, runId, expiresAt, signal, () =>
      setTimeout(
        () => {
          void this.close(id).catch(() => {});
        },
        Math.max(0, expiresAt - Date.now()),
      ),
    );
    return {
      PLAYWRIGHT_MCP_CDP_ENDPOINT: this.endpoint(id),
      PLAYWRIGHT_MCP_CDP_HEADERS: `X-Carapa-Browser-Token: ${lease.token}`,
      PLAYWRIGHT_MCP_PROXY_SERVER: '',
      PLAYWRIGHT_MCP_PROXY_BYPASS: '',
      PLAYWRIGHT_CLI_SESSION: id,
      CARAPA_BROWSER_RUN_ID: runId,
      CARAPA_BROWSER_CONTEXT_FILE: '',
      CARAPA_BROWSER_SESSION_ID: '',
      CARAPA_RECORD: '0',
      // Isolate the local CLI daemon as well as the remote Chromium process.
      PLAYWRIGHT_DAEMON_SESSION_DIR: `/tmp/pwcli-${id}`,
      PLAYWRIGHT_DAEMON_SOCKETS_DIR: `/tmp/pwcli-${id}/sockets`,
    };
  }

  /**
   * Returns the hub lease for a persistent browser on a native runner, reusing
   * a live one. Board renews it while the browser lives (up to the configured
   * maximum); the sidecar expires it if Board stops renewing. `created` tells
   * the caller whether this call opened a new lease.
   */
  async ensureTab(
    browserId: string,
    group: string,
    signal: AbortSignal,
  ): Promise<TabLease & { created: boolean }> {
    const id = tabLeaseId(browserId);
    const existing = this.leases.get(id);
    if (existing && existing.expiresAt > Date.now()) {
      if (!(await this.sessionLost(existing, signal)))
        return {
          endpoint: this.endpoint(id),
          headers: `X-Carapa-Browser-Token: ${existing.token}`,
          created: false,
        };
    }
    // Replaces an expired lease, or a sidecar session Board lost in a restart.
    await this.close(id);
    const leaseMs = this.options.tabLeaseMs ?? WEB_BROWSER_TAB_LEASE_MS;
    const renewUntil =
      Date.now() +
      (this.options.tabMaxLifetimeMs ?? WEB_BROWSER_TAB_MAX_LIFETIME_MS);
    const lease = await this.open(
      id,
      group,
      browserId,
      Math.min(Date.now() + leaseMs, renewUntil),
      signal,
      (created) => this.scheduleRenewal(created, leaseMs),
      renewUntil,
    );
    return {
      endpoint: this.endpoint(id),
      headers: `X-Carapa-Browser-Token: ${lease.token}`,
      created: true,
    };
  }

  /**
   * Probes the sidecar with a no-op renewal, because the session can die
   * (Chromium exit) long before the next scheduled renewal notices. Only a
   * definite "gone" answer drops the lease; other failures keep it, as renew does.
   */
  private async sessionLost(
    lease: Lease,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.request(
        `/sessions/${lease.id}`,
        'PATCH',
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        { expiresAt: lease.expiresAt },
      );
      return false;
    } catch (error) {
      if (!sessionGone(error)) return false;
      logger.warn(
        { leaseId: lease.id, error: String(error) },
        'Browser tab session is gone on the sidecar; replacing the lease',
      );
      return true;
    }
  }

  /**
   * Deletes the tab lease of a persistent browser. Board may no longer hold it
   * in memory (restart), so a descriptor carrying the hub endpoint also counts
   * as proof that a sidecar session may exist under the deterministic ID. A
   * browser that never used a lease (Docker) causes no sidecar request. A
   * sidecar failure is logged; its own expiry remains the backstop.
   */
  async releaseTab(browser: {
    id: string;
    env?: Record<string, string>;
  }): Promise<void> {
    const id = tabLeaseId(browser.id);
    if (!this.leases.has(id) && !browser.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT)
      return;
    try {
      await this.close(id);
    } catch (error) {
      logger.warn(
        { leaseId: id, error: String(error) },
        'Browser tab lease deletion failed; sidecar expiry remains active',
      );
    }
  }

  private scheduleRenewal(
    lease: Lease,
    leaseMs: number,
  ): ReturnType<typeof setTimeout> {
    const renewUntil = lease.renewUntil!;
    const now = Date.now();
    const delay = Math.max(
      1_000,
      Math.min(leaseMs / 3, lease.expiresAt - now, renewUntil - now),
    );
    return setTimeout(() => {
      void this.renew(lease, leaseMs).catch(() => {});
    }, delay);
  }

  private async renew(lease: Lease, leaseMs: number): Promise<void> {
    const current = () => this.leases.get(lease.id) === lease;
    if (!current()) return;
    const renewUntil = lease.renewUntil!;
    if (Date.now() >= renewUntil) return this.close(lease.id);
    const next = Math.min(Date.now() + leaseMs, renewUntil);
    if (next > lease.expiresAt) {
      try {
        await this.request(
          `/sessions/${lease.id}`,
          'PATCH',
          AbortSignal.timeout(15_000),
          { expiresAt: next },
        );
        if (current()) lease.expiresAt = next;
      } catch (error) {
        // The sidecar no longer has the session (e.g. Chromium exited): drop
        // the lease so the next ensureTab opens a new session.
        if (sessionGone(error)) {
          // A newer lease may already own this deterministic id.
          if (!current()) return;
          logger.warn(
            { leaseId: lease.id, error: String(error) },
            'Browser tab session is gone on the sidecar; closing the lease',
          );
          return this.close(lease.id);
        }
        logger.warn(
          { leaseId: lease.id, error: String(error) },
          'Browser tab lease renewal failed; will retry until it expires',
        );
      }
    }
    if (!current()) return;
    if (lease.expiresAt <= Date.now()) return this.close(lease.id);
    lease.timer = this.scheduleRenewal(lease, leaseMs);
    lease.timer.unref();
  }

  async close(id: string): Promise<void> {
    const pending = this.closing.get(id);
    if (pending) return pending;
    const lease = this.leases.get(id);
    if (lease) {
      this.leases.delete(id);
      clearTimeout(lease.timer);
      for (const socket of lease.sockets) socket.terminate();
    }
    // Deterministic IDs also let restart recovery clean sidecar sessions whose
    // in-memory Board lease was lost. Sidecar expiry is the independent backstop.
    const cleanup = this.request(
      `/sessions/${id}`,
      'DELETE',
      AbortSignal.timeout(15_000),
    );
    this.closing.set(id, cleanup);
    try {
      await cleanup;
    } finally {
      this.closing.delete(id);
    }
  }

  async upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const id = BROWSER_CDP_PATH.exec(url.pathname)?.[1];
    const lease = id ? this.leases.get(id) : undefined;
    // This capability is minted by Board for one immutable group/run/session.
    // The relay replaces ordinary Authorization; never use that shared header
    // as authority to attach a different run's browser.
    if (
      url.search ||
      !lease ||
      lease.expiresAt <= Date.now() ||
      !equalSecret(req.headers['x-carapa-browser-token'], lease.token) ||
      lease.sockets.size >= 4
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstreamUrl = new URL(
      `/sessions/${lease.id}/cdp`,
      this.options.sidecarUrl,
    );
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(upstreamUrl, {
      headers: { 'x-carapa-browser-token': lease.token },
      handshakeTimeout: 10_000,
      maxPayload: MAX_FRAME,
    });
    lease.sockets.add(upstream);
    const failed = () => {
      upstream.terminate();
      socket.destroy();
    };
    socket.once('close', () => upstream.terminate());
    socket.once('error', failed);
    upstream.once('close', () => {
      lease.sockets.delete(upstream);
      socket.destroy();
    });
    upstream.once('error', failed);
    upstream.once('open', () => {
      if (
        socket.destroyed ||
        this.leases.get(lease.id) !== lease ||
        lease.expiresAt <= Date.now()
      ) {
        failed();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (client) => {
        const forward = (from: WebSocket, to: WebSocket) =>
          from.on('message', (data, isBinary) => {
            if (
              to.readyState !== WebSocket.OPEN ||
              to.bufferedAmount > MAX_FRAME
            ) {
              from.terminate();
              to.terminate();
              return;
            }
            to.send(data, { binary: isBinary });
          });
        forward(client, upstream);
        forward(upstream, client);
        client.once('close', () => upstream.terminate());
        client.once('error', failed);
      });
    });
  }
}

export const webBrowserSessions = new WebBrowserSessions({
  sidecarUrl: WEB_BROWSER_SIDECAR_URL,
  token: WEB_BROWSER_SIDECAR_TOKEN,
  gatewayUrl: WEB_BROWSER_AGENT_GATEWAY_URL,
  fetch: (...args) => globalThis.fetch(...args),
});
