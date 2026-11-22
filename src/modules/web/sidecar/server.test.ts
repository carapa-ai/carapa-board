import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket as Client } from 'ws';
import { BrowserSessions } from './sessions.js';
import { startBrowserSidecar } from './server.js';
import { WebBrowserSessions } from '../browser-sessions.js';

// This exercises real localhost servers; run in the supported Carapa sandbox.
test('Board and sidecar bridge only the selected lease and close it on expiry', async () => {
  const upstream = Bun.serve<{ id: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (server.upgrade(req, { data: { id: new URL(req.url).pathname } }))
        return;
      return new Response('upgrade required', { status: 400 });
    },
    websocket: {
      message(ws, message) {
        ws.send(
          JSON.stringify({ browser: ws.data.id, message: String(message) }),
        );
      },
    },
  });
  const token = 'm'.repeat(64);
  const sidecar = startBrowserSidecar({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    port: 0,
    hostname: '127.0.0.1',
    sessions: new BrowserSessions(async (id) => ({
      endpoint: `ws://127.0.0.1:${upstream.port}/${id}`,
      closed: new Promise(() => {}),
      stop: async () => {},
    })),
  });
  const url = `http://127.0.0.1:${sidecar.server.port}`;
  const board = new WebBrowserSessions({
    sidecarUrl: url,
    token,
    gatewayUrl: 'ws://unused',
    fetch,
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    void board.upgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const ids = [`web-view-${randomUUID()}`, `web-view-${randomUUID()}`];
  const clients: Client[] = [];
  const connect = (id: string, header: string) =>
    new Client(`ws://127.0.0.1:${port}/api/web-browser/sessions/${id}/cdp`, {
      headers: { 'x-carapa-browser-token': header.split(': ')[1] },
      handshakeTimeout: 1000,
    });
  try {
    expect(
      (await fetch(`${url}/sessions`, { method: 'POST', body: '{}' })).status,
    ).toBe(401);
    const envs = await Promise.all(
      ids.map((id, index) =>
        board.create(
          id,
          `group-${index}`,
          `run-${index}`,
          Date.now() + 2000,
          AbortSignal.timeout(1000),
        ),
      ),
    );
    const rejected = connect(ids[1], envs[0].PLAYWRIGHT_MCP_CDP_HEADERS);
    clients.push(rejected);
    const rejection = await new Promise<number>((resolve) => {
      rejected.on('unexpected-response', (_req, response) => {
        resolve(response.statusCode!);
        response.resume();
        rejected.terminate();
      });
      rejected.on('error', () => {});
    });
    expect(rejection).toBe(403);
    for (let i = 0; i < ids.length; i++) {
      const client = connect(ids[i], envs[i].PLAYWRIGHT_MCP_CDP_HEADERS);
      clients.push(client);
      await once(client, 'open');
      const response = once(client, 'message');
      client.send('snapshot');
      expect(JSON.parse(String((await response)[0]))).toEqual({
        browser: `/${ids[i]}`,
        message: 'snapshot',
      });
    }
    const ended = once(clients[1], 'close');
    await board.close(ids[0]);
    await ended;
    expect(clients[2].readyState).toBe(Client.OPEN);
    // Sidecar expiration also closes connections without a Board DELETE.
    await once(clients[2], 'close');
  } finally {
    for (const client of clients) client.terminate();
    await Promise.all(ids.map((id) => board.close(id).catch(() => {})));
    await sidecar.close();
    await upstream.stop(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);

test('a native-runner tab lease bridges with its own token, is renewed through the sidecar and is deleted on release', async () => {
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      return server.upgrade(req)
        ? undefined
        : new Response('upgrade required', { status: 400 });
    },
    websocket: {
      message(ws, message) {
        ws.send(String(message));
      },
    },
  });
  const token = 'n'.repeat(64);
  const sessions = new BrowserSessions(
    async () => ({
      endpoint: `ws://127.0.0.1:${upstream.port}/`,
      closed: new Promise(() => {}),
      stop: async () => {},
    }),
    4,
    90_000,
  );
  const sidecar = startBrowserSidecar({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    port: 0,
    hostname: '127.0.0.1',
    sessions,
  });
  const board = new WebBrowserSessions({
    sidecarUrl: `http://127.0.0.1:${sidecar.server.port}`,
    token,
    gatewayUrl: 'ws://unused',
    fetch,
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    void board.upgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const browserId = `browser-${randomUUID().replaceAll('-', '')}12345678`;
  const clients: Client[] = [];
  try {
    const lease = await board.ensureTab(
      browserId,
      'group',
      AbortSignal.timeout(1000),
    );
    const id = new URL(lease.endpoint.replace('ws:', 'http:')).pathname.split(
      '/',
    )[4];
    const connect = (header: string) => {
      const client = new Client(
        `ws://127.0.0.1:${port}/api/web-browser/sessions/${id}/cdp`,
        {
          headers: { 'x-carapa-browser-token': header },
          handshakeTimeout: 1000,
        },
      );
      clients.push(client);
      return client;
    };
    const wrong = connect('x'.repeat(64));
    const rejection = new Promise<number>((resolve) => {
      wrong.on('unexpected-response', (_req, response) => {
        resolve(response.statusCode!);
        response.resume();
      });
      wrong.on('error', () => {});
    });
    expect(await rejection).toBe(403);
    const client = connect(lease.headers.split(': ')[1]);
    await once(client, 'open');
    const echoed = once(client, 'message');
    client.send('ping');
    expect(String((await echoed)[0])).toBe('ping');
    // Longer than a web_view session may live, so only a renewable tab can.
    const patch = (sessionId: string) =>
      fetch(`http://127.0.0.1:${sidecar.server.port}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ expiresAt: Date.now() + 600_000 }),
      });
    expect((await patch(id)).status).toBe(204);
    expect((await patch(`web-view-${randomUUID()}`)).status).toBe(400);
    const closed = once(client, 'close');
    await board.releaseTab({ id: browserId });
    await closed;
    expect(
      sessions.authorize(id, lease.headers.split(': ')[1]),
    ).toBeUndefined();
  } finally {
    for (const client of clients) client.terminate();
    await board.releaseTab({ id: browserId }).catch(() => {});
    await sidecar.close();
    await upstream.stop(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);
