import { afterEach, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setImmediate as realMacrotask } from 'node:timers/promises';
import { WebBrowserSessions, tabLeaseId } from './browser-sessions.js';

test('Board binds a capability to its run, revokes it on failure, and never puts it in the URL', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const service = new WebBrowserSessions({
    sidecarUrl: 'http://sidecar:3210',
    token: 'm'.repeat(64),
    gatewayUrl: 'ws://relay/board-api',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: init.method === 'POST' ? 201 : 204 });
    },
  });
  const id = `web-view-${randomUUID()}`;
  const env = await service.create(
    id,
    'group-one',
    'run-one',
    Date.now() + 10000,
    AbortSignal.timeout(1000),
  );
  const created = JSON.parse(requests[0].init.body as string);
  expect(created.group).toBe('group-one');
  expect(created.runId).toBe('run-one');
  expect(env.PLAYWRIGHT_MCP_CDP_HEADERS).toContain(created.token);
  expect(env.PLAYWRIGHT_MCP_CDP_ENDPOINT).not.toContain(created.token);
  expect(env.PLAYWRIGHT_MCP_PROXY_SERVER).toBe('');
  await service.close(id);
  const socket = new PassThrough();
  let response = '';
  socket.on('data', (data) => {
    response += data.toString();
  });
  await service.upgrade(
    {
      url: `/api/web-browser/sessions/${id}/cdp`,
      headers: { 'x-carapa-browser-token': created.token },
    } as any,
    socket,
    Buffer.alloc(0),
  );
  expect(response).toContain('403');
  expect(requests[1].init.method).toBe('DELETE');
});

test('sidecar startup errors trigger cleanup and remain explicit to callers', async () => {
  const methods: string[] = [];
  const service = new WebBrowserSessions({
    sidecarUrl: 'http://sidecar',
    token: 'm'.repeat(64),
    gatewayUrl: 'ws://relay/board-api',
    fetch: async (_url, init) => {
      methods.push(init.method!);
      return new Response(null, { status: init.method === 'POST' ? 429 : 204 });
    },
  });
  await expect(
    service.create(
      `web-view-${randomUUID()}`,
      'group',
      'run',
      Date.now() + 10000,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('capacity exhausted');
  expect(methods).toEqual(['POST', 'DELETE']);
});

afterEach(() => {
  jest.useRealTimers();
});

async function forbidden(
  service: WebBrowserSessions,
  id: string,
  headers: Record<string, string>,
) {
  const socket = new PassThrough();
  let response = '';
  socket.on('data', (data) => {
    response += data.toString();
  });
  await service.upgrade(
    { url: `/api/web-browser/sessions/${id}/cdp`, headers } as any,
    socket,
    Buffer.alloc(0),
  );
  return response.includes('403');
}

test('a tab lease is reused while live, renewed up to its maximum, then closed with the sidecar session', async () => {
  jest.useFakeTimers();
  const start = Date.now();
  const requests: { url: string; method: string; body?: any }[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  /** Resolves once the stub has seen `count` requests in total. */
  const arrived = (count: number) =>
    new Promise<void>((resolve) => {
      if (requests.length >= count) resolve();
      else waiters.push({ count, resolve });
    });
  const service = new WebBrowserSessions({
    sidecarUrl: 'http://sidecar:3210',
    token: 'm'.repeat(64),
    gatewayUrl: 'ws://relay/board-api',
    tabLeaseMs: 60_000,
    tabMaxLifetimeMs: 150_000,
    fetch: async (url, init) => {
      requests.push({
        url,
        method: init.method!,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      for (const waiter of waiters)
        if (requests.length >= waiter.count) waiter.resolve();
      return new Response(null, { status: init.method === 'POST' ? 201 : 204 });
    },
  });
  const browserId = `browser-${'ab12'.repeat(10)}`;
  const id = tabLeaseId(browserId);
  const signal = AbortSignal.timeout(1000);
  const first = await service.ensureTab(browserId, 'group', signal);
  // Board restart: the sidecar session is replaced before a fresh one is made.
  expect(requests.map((request) => request.method)).toEqual(['DELETE', 'POST']);
  expect(first).toMatchObject({
    created: true,
    endpoint: `ws://relay/board-api/api/web-browser/sessions/${id}/cdp`,
    headers: `X-Carapa-Browser-Token: ${requests[1].body.token}`,
  });
  expect(requests[1].body).toMatchObject({ id, group: 'group' });
  expect(await service.ensureTab(browserId, 'group', signal)).toEqual({
    ...first,
    created: false,
  });
  // Reuse first probes that the sidecar still has the session.
  expect(requests.map((request) => request.method)).toEqual([
    'DELETE',
    'POST',
    'PATCH',
  ]);

  // Renewal runs every third of the window and is clamped to the maximum.
  for (let tick = 1; tick <= 5; tick++) {
    jest.advanceTimersByTime(20_000);
    await arrived(3 + tick);
    // The next renewal is armed after the PATCH settles; a real macrotask
    // turn lets that promise chain finish (the fake clock only fakes timers).
    await realMacrotask();
  }
  expect(
    requests.slice(3).map((r) => [r.method, r.body.expiresAt - start]),
  ).toEqual([
    ['PATCH', 80_000],
    ['PATCH', 100_000],
    ['PATCH', 120_000],
    ['PATCH', 140_000],
    ['PATCH', 150_000],
  ]);
  expect(await forbidden(service, id, {})).toBe(true);

  // No further extension is possible; at the maximum the lease is deleted.
  jest.advanceTimersByTime(50_000);
  await arrived(9);
  expect(requests.at(-1)).toMatchObject({
    method: 'DELETE',
    url: expect.stringContaining(id),
  });
  expect(
    await forbidden(service, id, { 'x-carapa-browser-token': 'x'.repeat(64) }),
  ).toBe(true);
});

test('releasing a tab lease deletes it, and an unknown browser is a no-op', async () => {
  const methods: string[] = [];
  const service = new WebBrowserSessions({
    sidecarUrl: 'http://sidecar',
    token: 'm'.repeat(64),
    gatewayUrl: 'ws://relay/board-api',
    fetch: async (_url, init) => {
      methods.push(init.method!);
      return new Response(null, { status: 204 });
    },
  });
  const browserId = `browser-${'cd34'.repeat(10)}`;
  await service.releaseTab({ id: browserId });
  expect(methods).toEqual([]);
  await service.ensureTab(browserId, 'group', AbortSignal.timeout(1000));
  await service.releaseTab({ id: browserId });
  expect(methods).toEqual(['DELETE', 'POST', 'DELETE']);
  expect(await forbidden(service, tabLeaseId(browserId), {})).toBe(true);

  // After a Board restart the map is empty, but a descriptor that carries the
  // hub endpoint proves a lease may exist: its sidecar session is still deleted.
  methods.length = 0;
  await service.releaseTab({
    id: browserId,
    env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://relay/x' },
  });
  expect(methods).toEqual(['DELETE']);
});
