import { expect, test } from 'bun:test';
import express from 'express';
import {
  createProviderAccountsRouter,
  providerAccountAdmin,
} from './provider-accounts.js';

test('provider account management requires a human administrator and enrolled device, never agent or share tokens', () => {
  for (const request of [
    {},
    { authUser: { id: 'admin', role: 'admin' } },
    {
      authUser: { id: 'admin', role: 'admin' },
      authDeviceId: 'device',
      authCredentialKind: 'user',
      headers: { 'x-carapa-device-id': 'another-device' },
    },
    { authUser: { id: 'user', role: 'user' }, authDeviceId: 'device' },
    {
      authUser: { id: 'admin', role: 'admin' },
      authDeviceId: 'device',
      authCredentialKind: 'agent',
      headers: {
        'x-carapa-device-id': 'device',
        authorization: 'Bearer agent-token',
      },
    },
  ]) {
    let status = 0;
    let admitted = false;
    const response = {
      status(value: number) {
        status = value;
        return this;
      },
      json() {
        return this;
      },
    };
    providerAccountAdmin(request, response, () => {
      admitted = true;
    });
    expect(admitted).toBe(false);
    expect([401, 403]).toContain(status);
  }
  let admitted = false;
  providerAccountAdmin(
    {
      authUser: { id: 'admin', role: 'admin' },
      authDeviceId: 'device',
      authCredentialKind: 'user',
      headers: { 'x-carapa-device-id': 'device' },
    },
    {},
    () => {
      admitted = true;
    },
  );
  expect(admitted).toBe(true);
});

test('provider account proxy uses the existing Box connection token, never the browser credential', async () => {
  const app = express();
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'admin', role: 'admin' };
    req.authDeviceId = 'device';
    req.authCredentialKind = 'user';
    next();
  });
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const upstream = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Response.json({ accounts: [], logins: [], clients: [] });
  }) as typeof fetch;
  app.use(
    '/api',
    createProviderAccountsRouter(upstream, {
      url: 'http://box.test',
      token: 'existing-box-api-token',
    }),
  );
  app.use(
    '/missing',
    createProviderAccountsRouter(upstream, {
      url: 'http://box.test',
      token: '',
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = {
      'x-carapa-device-id': 'device',
      Authorization: 'Bearer browser-user-token',
    };
    const response = await fetch(base + '/api/admin/provider-accounts', {
      headers,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      accounts: [],
      logins: [],
      clients: [],
    });
    expect(calls).toEqual([
      {
        url: 'http://box.test/api/admin/provider-accounts',
        authorization: 'Bearer existing-box-api-token',
      },
    ]);
    expect(
      (await fetch(base + '/missing/admin/provider-accounts', { headers }))
        .status,
    ).toBe(503);
    expect(calls).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('provider account PATCH forwards only label, tier and capacity to the account id path and passes Box validation errors through', async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'admin', role: 'admin' };
    req.authDeviceId = 'device';
    req.authCredentialKind = 'user';
    next();
  });
  const id = '0f8fad5b-d9cb-469f-a165-8c4b1a2b3c4d';
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let edits = 0;
  const upstream = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    // The ownership check reads the listing before each write; only writes are recorded.
    if (init?.method !== 'GET')
      calls.push({ url: String(url), method: init?.method, body });
    return body?.capacity === 5000
      ? Response.json(
          { error: 'capacity must be between 1 and 1000' },
          { status: 400 },
        )
      : Response.json({ ok: true });
  }) as typeof fetch;
  app.use(
    '/api',
    createProviderAccountsRouter(
      upstream,
      {
        url: 'http://box.test',
        token: 'existing-box-api-token',
      },
      () => {},
      () => edits++,
    ),
  );
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const patch = (path: string, body: unknown) =>
      fetch(base + '/api/admin/provider-accounts' + path, {
        method: 'PATCH',
        headers: {
          'x-carapa-device-id': 'device',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const ok = await patch(`/${id}`, {
      label: 'Renamed',
      tier: null,
      capacity: 5,
      credentialId: 'leak',
    });
    expect(ok.status).toBe(200);
    expect(calls).toEqual([
      {
        url: `http://box.test/api/admin/provider-accounts/${id}`,
        method: 'PATCH',
        body: { label: 'Renamed', tier: null, capacity: 5 },
      },
    ]);
    const rejected = await patch(`/${id}`, { capacity: 5000 });
    expect(edits).toBe(1);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'capacity must be between 1 and 1000',
    });
    expect((await patch('/login', { label: 'x' })).status).toBe(404);
    expect(calls).toHaveLength(2);
    expect(edits).toBe(1);
    const order = (body: unknown) =>
      fetch(base + '/api/admin/provider-accounts/order', {
        method: 'POST',
        headers: {
          'x-carapa-device-id': 'device',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    expect((await order({ ids: 'nope' })).status).toBe(400);
    expect((await order({ ids: [id, 'bad'] })).status).toBe(400);
    expect(calls).toHaveLength(2);
    expect((await order({ ids: [id], extra: 1 })).status).toBe(200);
    expect(calls[2]).toEqual({
      url: 'http://box.test/api/admin/provider-accounts/order',
      method: 'POST',
      body: { ids: [id] },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an API-key login forwards the key to Box and shows Box's key refusal", async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'admin', role: 'admin' };
    req.authDeviceId = 'device';
    req.authCredentialKind = 'user';
    next();
  });
  const bodies: unknown[] = [];
  const upstream = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.apiKey === 'bad-key-0000'
      ? Response.json(
          { error: 'The provider rejected this key' },
          { status: 400 },
        )
      : Response.json({ id: 'account', installed: true });
  }) as typeof fetch;
  app.use(
    '/api',
    createProviderAccountsRouter(upstream, {
      url: 'http://box.test',
      token: 'existing-box-api-token',
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = (apiKey: string) =>
      fetch(base + '/api/admin/provider-accounts/login', {
        method: 'POST',
        headers: {
          'x-carapa-device-id': 'device',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'mistral-vibe',
          label: 'Seat 2',
          scope: 'shared',
          apiKey,
          workspaceId: 'wrkspc_Test1',
          extra: 'dropped',
        }),
      });
    expect(await (await login('good-key-0000')).json()).toEqual({
      id: 'account',
      installed: true,
    });
    const refused = await login('bad-key-0000');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'The provider rejected this key',
    });
    expect(bodies[0]).toEqual({
      provider: 'mistral-vibe',
      label: 'Seat 2',
      scope: 'shared',
      apiKey: 'good-key-0000',
      workspaceId: 'wrkspc_Test1',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
