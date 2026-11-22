import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BrowserSessions,
  equalSecret,
  SessionError,
  type SessionInput,
} from './sessions.js';
import { launchChromium } from './chromium.js';

interface SocketData {
  upstream: WebSocket;
  close: () => void;
}
const MAX_FRAME = 16 * 1024 * 1024;

export function startBrowserSidecar(options: {
  tokenHash: string;
  port?: number;
  hostname?: string;
  sessions?: BrowserSessions;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.tokenHash))
    throw new Error('Browser sidecar credential is required');
  const sessions =
    options.sessions ||
    new BrowserSessions(
      launchChromium,
      Number(process.env.WEB_BROWSER_MAX_SESSIONS) || 4,
      Number(process.env.WEB_BROWSER_AGENT_TIMEOUT_MS) || 90_000,
      undefined,
      {
        capacity: Number(process.env.WEB_BROWSER_TAB_MAX_SESSIONS) || 2,
        maxLifetimeMs:
          Number(process.env.WEB_BROWSER_TAB_LEASE_MS) || 1_200_000,
      },
    );
  const server = Bun.serve<SocketData>({
    port: options.port ?? 3210,
    hostname: options.hostname ?? '0.0.0.0',
    maxRequestBodySize: 4096,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/health' && req.method === 'GET')
        return new Response('ok');
      const match =
        /^\/sessions\/(web-view-[a-f0-9-]{36}|browser-tab-[a-f0-9]{40})(\/cdp)?$/.exec(
          url.pathname,
        );
      if (match?.[2] && req.method === 'GET' && !url.search) {
        const session = sessions.authorize(
          match[1],
          req.headers.get('x-carapa-browser-token'),
        );
        if (!session)
          return new Response('Browser session unavailable', { status: 403 });
        const upstream = new WebSocket(session.browser!.endpoint);
        let closed = false;
        const close = () => {
          if (!closed) {
            closed = true;
            session.connections.delete(close);
            upstream.close();
          }
        };
        session.connections.add(close);
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Browser connection timed out')),
              10_000,
            );
            upstream.onopen = () => {
              clearTimeout(timer);
              resolve();
            };
            upstream.onerror = upstream.onclose = () => {
              clearTimeout(timer);
              reject(new Error('Browser connection failed'));
            };
          });
          if (
            !sessions.authorize(
              match[1],
              req.headers.get('x-carapa-browser-token'),
            )
          ) {
            close();
            return new Response('Browser session ended', { status: 410 });
          }
          if (server.upgrade(req, { data: { upstream, close } })) return;
        } catch {
          /* bounded error, without connection credentials */
        }
        close();
        return new Response('Browser connection unavailable', { status: 502 });
      }
      if (
        !equalSecret(
          createHash('sha256')
            .update(
              (req.headers.get('authorization') || '').replace(/^Bearer /, ''),
            )
            .digest('hex'),
          options.tokenHash,
        )
      ) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        if (url.pathname === '/sessions' && req.method === 'POST') {
          const input = (await req.json()) as SessionInput;
          await sessions.create(input);
          return Response.json({ id: input.id }, { status: 201 });
        }
        if (match && !match[2] && req.method === 'PATCH') {
          sessions.renew(
            match[1],
            ((await req.json()) as { expiresAt?: unknown }).expiresAt,
          );
          return new Response(null, { status: 204 });
        }
        if (match && !match[2] && req.method === 'DELETE') {
          await sessions.delete(match[1]);
          return new Response(null, { status: 204 });
        }
        return new Response('Not found', { status: 404 });
      } catch (error) {
        return new Response(
          error instanceof SessionError
            ? error.message
            : 'Browser sidecar startup failed',
          { status: error instanceof SessionError ? error.status : 502 },
        );
      }
    },
    websocket: {
      maxPayloadLength: MAX_FRAME,
      backpressureLimit: MAX_FRAME,
      closeOnBackpressureLimit: true,
      open(ws) {
        const upstream = ws.data.upstream;
        upstream.onmessage = (event) => {
          if (
            typeof event.data !== 'string' ||
            Buffer.byteLength(event.data) > MAX_FRAME
          ) {
            ws.close(1009);
            return;
          }
          ws.send(event.data);
        };
        upstream.onclose = upstream.onerror = () =>
          ws.close(1011, 'Browser session ended');
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        if (
          upstream.readyState !== WebSocket.OPEN ||
          upstream.bufferedAmount > MAX_FRAME
        ) {
          ws.close(1011);
          return;
        }
        upstream.send(message);
      },
      close(ws) {
        ws.data.close();
      },
    },
  });
  return {
    server,
    async close() {
      await sessions.close();
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const service = startBrowserSidecar({
    tokenHash: readFileSync(
      process.env.WEB_BROWSER_SIDECAR_TOKEN_HASH_FILE ||
        '/run/secrets/web_browser_sidecar_token_sha256',
      'utf8',
    ).trim(),
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void service.close().finally(() => process.exit(0));
    });
}
