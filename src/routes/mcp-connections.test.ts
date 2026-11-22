import { afterAll, beforeAll, expect, test } from 'bun:test';
import express from 'express';
import { createMcpConnectionsRouter } from './mcp-connections.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const calls: Array<{
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}> = [];
let upstreamStatus = 200;
let upstreamFails = false;
let auth: Record<string, unknown> = {};

const upstream = (async (url: any, init: any) => {
  calls.push({
    url: String(url),
    method: init.method,
    authorization: new Headers(init.headers).get('authorization'),
    body: init.body ? JSON.parse(init.body) : undefined,
  });
  if (upstreamFails) throw new Error('connect ECONNREFUSED secret-host');
  if (upstreamStatus !== 200)
    return new Response('upstream detail with secret', {
      status: upstreamStatus,
    });
  return Response.json({ services: [], logins: [] });
}) as typeof fetch;

const adminAuth = {
  authUser: { id: 'admin', role: 'admin' },
  authDeviceId: 'device',
  authCredentialKind: 'user',
};
let server: ReturnType<ReturnType<typeof express>['listen']>;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    Object.assign(req, auth);
    next();
  });
  app.use(
    '/api',
    createMcpConnectionsRouter(upstream, {
      url: 'http://box.test',
      token: 'box-token',
    }),
  );
  app.use(
    '/missing',
    createMcpConnectionsRouter(upstream, { url: 'http://box.test', token: '' }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function send(
  method: string,
  path: string,
  body?: unknown,
  prefix = '/api/admin/mcp-connections',
) {
  return fetch(base + prefix + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-carapa-device-id': 'device',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('rejects non-admin and agent-token callers without an upstream call', async () => {
  calls.length = 0;
  for (const identity of [
    {},
    { ...adminAuth, authUser: { id: 'user', role: 'user' } },
    { ...adminAuth, authCredentialKind: 'agent' },
  ]) {
    auth = identity;
    expect([401, 403]).toContain((await send('GET', '')).status);
  }
  expect(calls).toHaveLength(0);
});

test('forwards only whitelisted operations and fields using the Box token', async () => {
  auth = adminAuth;
  upstreamStatus = 200;
  upstreamFails = false;
  calls.length = 0;
  const list = await send('GET', '');
  expect(list.status).toBe(200);
  expect(list.headers.get('cache-control')).toBe('no-store');
  expect(await list.json()).toEqual({ services: [], logins: [] });

  await send('POST', '/login', {
    service: 'cloudinary',
    project: 'carapa',
    extra: 'x',
    token: 'leak',
  });
  await send('POST', `/login/${ID}/complete`, {
    value: 'http://127.0.0.1:33418/callback?code=a&state=b',
    service: 'cloudinary',
  });
  await send('DELETE', `/login/${ID}`, { service: 'cloudinary' });
  await send('POST', '/revoke', {
    service: 'cloudinary',
    project: 'carapa',
    extra: 'x',
  });
  expect(calls).toEqual([
    {
      url: 'http://box.test/api/admin/mcp-connections',
      method: 'GET',
      authorization: 'Bearer box-token',
      body: undefined,
    },
    {
      url: 'http://box.test/api/admin/mcp-connections/login',
      method: 'POST',
      authorization: 'Bearer box-token',
      body: { service: 'cloudinary', project: 'carapa' },
    },
    {
      url: `http://box.test/api/admin/mcp-connections/login/${ID}/complete`,
      method: 'POST',
      authorization: 'Bearer box-token',
      body: { value: 'http://127.0.0.1:33418/callback?code=a&state=b' },
    },
    {
      url: `http://box.test/api/admin/mcp-connections/login/${ID}`,
      method: 'DELETE',
      authorization: 'Bearer box-token',
      body: undefined,
    },
    {
      url: 'http://box.test/api/admin/mcp-connections/revoke',
      method: 'POST',
      authorization: 'Bearer box-token',
      body: { service: 'cloudinary', project: 'carapa' },
    },
  ]);
});

test('unknown suffixes, invalid fields and non-UUID ids are rejected before Box is called', async () => {
  auth = adminAuth;
  calls.length = 0;
  expect((await send('GET', '/usage')).status).toBe(404);
  expect((await send('POST', '/other', {})).status).toBe(404);
  expect((await send('DELETE', '/revoke')).status).toBe(404);
  expect((await send('DELETE', '/login/not-a-uuid')).status).toBe(404);
  expect(
    (await send('POST', '/login/../revoke/complete', { value: 'x' })).status,
  ).toBe(404);
  expect(
    (await send('POST', '/login/not-a-uuid/complete', { value: 'x' })).status,
  ).toBe(404);
  for (const [path, body] of [
    ['/login', { service: 'bad service', project: 'carapa' }],
    ['/login', { service: 'cloudinary', project: ['carapa'] }],
    ['/login', { service: 'cloudinary' }],
    ['/revoke', { service: 'a'.repeat(129), project: 'carapa' }],
    ['/revoke', { service: 'cloudinary', project: '../x' }],
  ] as const)
    expect((await send('POST', path, body)).status).toBe(400);
  expect(
    (await send('POST', `/login/${ID}/complete`, { value: 42 })).status,
  ).toBe(400);
  expect(
    (await send('POST', `/login/${ID}/complete`, { value: 'x'.repeat(16385) }))
      .status,
  ).toBe(413);
  expect(calls).toHaveLength(0);
});

test('missing token is 503 and upstream failures map to generic errors', async () => {
  auth = adminAuth;
  calls.length = 0;
  expect(
    (await send('GET', '', undefined, '/missing/admin/mcp-connections')).status,
  ).toBe(503);
  expect(calls).toHaveLength(0);

  upstreamStatus = 409;
  const rejected = await send('POST', '/revoke', {
    service: 'cloudinary',
    project: 'carapa',
  });
  expect(rejected.status).toBe(409);
  expect(JSON.stringify(await rejected.json())).not.toContain('secret');

  upstreamStatus = 200;
  upstreamFails = true;
  const unreachable = await send('GET', '');
  expect(unreachable.status).toBe(502);
  expect(JSON.stringify(await unreachable.json())).not.toContain('secret');
});
