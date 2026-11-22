import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'node:http';

import { createSigningPayload } from '../crypto-verify.js';
import { createUser, initDatabase, registerDeviceKey } from '../db.js';
import { signUserJwt } from '../lib/auth-jwt.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { createKnowledgeBase } from '../modules/knowledge/db-kb.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';

const tag = `users-sig-${process.pid}`;
const pid = `${tag}-project`;
const kbId = `${tag}-kb`;
const callerDevice = `${tag}-caller-device`;
const otherDevice = `${tag}-other-device`;
let server: Server;
let sandboxSpies: Array<{ mockRestore(): void }> = [];
let baseUrl: string;
let callerToken: string;
let callerKey: CryptoKey;
let otherKey: CryptoKey;
let targetId: string;
let memberId: string;
let secondDeviceId: string;
let thirdDeviceId: string;
let pendingDeviceId: string;
let foreignDeviceId: string;

type Route = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  title?: string;
  path: () => string;
  body?: () => Record<string, unknown>;
  okStatus: number;
};

const routes: Route[] = [
  {
    method: 'POST',
    title: 'POST /api/users',
    path: () => '/api/users',
    body: () => ({
      username: `${tag}-created-${Math.random()}`,
      password: 'x',
    }),
    okStatus: 201,
  },
  {
    method: 'PATCH',
    title: 'PATCH /api/users/:userId',
    path: () => `/api/users/${targetId}`,
    body: () => ({ disabled: false }),
    okStatus: 200,
  },
  {
    method: 'POST',
    title: 'POST /api/projects/:projectId/members',
    path: () => `/api/projects/${pid}/members`,
    body: () => ({ user_id: memberId, access_level: 'viewer' }),
    okStatus: 200,
  },
  {
    method: 'DELETE',
    title: 'DELETE /api/projects/:projectId/members/:memberId',
    path: () => `/api/projects/${pid}/members/${memberId}`,
    okStatus: 200,
  },
  {
    method: 'POST',
    title: 'POST /api/knowledge-bases/:kbId/members',
    path: () => `/api/knowledge-bases/${kbId}/members`,
    body: () => ({ user_id: memberId, access_level: 'viewer' }),
    okStatus: 200,
  },
  {
    method: 'DELETE',
    title: 'DELETE /api/knowledge-bases/:kbId/members/:memberId',
    path: () => `/api/knowledge-bases/${kbId}/members/${memberId}`,
    okStatus: 200,
  },
  {
    method: 'DELETE',
    title: 'DELETE /api/users/:userId',
    path: () => `/api/users/${targetId}`,
    okStatus: 200,
  },
];

const deviceRoutes: Route[] = [
  {
    method: 'PUT',
    title: 'PUT /api/account/devices/:deviceId',
    path: () => `/api/account/devices/${secondDeviceId}`,
    body: () => ({ label: 'x' }),
    okStatus: 200,
  },
  {
    method: 'DELETE',
    title: 'DELETE /api/account/devices/:deviceId',
    path: () => `/api/account/devices/${thirdDeviceId}`,
    okStatus: 200,
  },
];

const adminDeviceRoutes: Route[] = [
  {
    method: 'POST',
    title: 'POST /api/admin/devices/:deviceId/approve',
    path: () => `/api/admin/devices/${pendingDeviceId}/approve`,
    okStatus: 200,
  },
  {
    method: 'DELETE',
    title: 'DELETE /api/admin/devices/:deviceId',
    path: () => `/api/admin/devices/${foreignDeviceId}`,
    okStatus: 200,
  },
];

// Admin writes on AI users/teams, memory audits and history-reflection review.
// Targets are missing, so a signed request passes the gate and fails later.
const adminWriteRoutes: Route[] = [
  {
    method: 'DELETE',
    path: () => '/api/admin/ai-users/missing',
    okStatus: 404,
  },
  {
    method: 'DELETE',
    path: () => '/api/admin/ai-user-teams/missing',
    okStatus: 404,
  },
  {
    method: 'POST',
    path: () => `/api/memory-review/projects/${pid}/audits/missing/apply`,
    okStatus: 0,
  },
  {
    method: 'DELETE',
    path: () =>
      `/api/history-reflection/batches/missing/projects/${pid}/review`,
    okStatus: 0,
  },
];

async function send(
  route: Route,
  sign?: { key: CryptoKey; deviceId: string; ageMs?: number },
  path = route.path(),
) {
  const bodyText = route.body ? JSON.stringify(route.body()) : '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${callerToken}`,
  };
  if (bodyText) headers['content-type'] = 'application/json';
  if (sign) {
    const timestamp = new Date(Date.now() - (sign.ageMs ?? 0)).toISOString();
    const payload = createSigningPayload(
      route.method,
      path,
      timestamp,
      bodyText,
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      sign.key,
      new TextEncoder().encode(payload),
    );
    headers['x-carapa-device-id'] = sign.deviceId;
    headers['x-carapa-timestamp'] = timestamp;
    headers['x-carapa-signature'] = Buffer.from(signature).toString('base64');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: route.method,
    headers,
    body: bodyText || undefined,
  });
  return response.status;
}

async function registerDevice(deviceId: string, userId: string) {
  const keys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  await registerDeviceKey(
    deviceId,
    userId,
    Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString(
      'base64',
    ),
    'test',
    true,
  );
  return keys.privateKey;
}

beforeAll(async () => {
  // Deleting a user archives their main, which stops its sandbox through
  // CarapaBox; none is reachable in tests, so report one that is already down.
  const sandbox = getSandboxClient();
  const down = { stdout: '[]', isError: false, exitCode: 0 } as never;
  sandboxSpies = [
    spyOn(sandbox, 'sandboxPs').mockResolvedValue(down),
    spyOn(sandbox, 'sandboxStop').mockResolvedValue(down),
    spyOn(sandbox, 'sandboxStatus').mockResolvedValue(down),
  ];
  await initDatabase(':memory:');
  await loadState();
  const caller = await createUser(`${tag}-caller`, 'password', 'admin');
  const other = await createUser(`${tag}-other`, 'password', 'admin');
  targetId = (await createUser(`${tag}-target`, 'password', 'user')).id;
  memberId = (await createUser(`${tag}-member`, 'password', 'user')).id;
  callerKey = await registerDevice(callerDevice, caller.id);
  secondDeviceId = `${tag}-caller-device-2`;
  thirdDeviceId = `${tag}-caller-device-3`;
  await registerDevice(secondDeviceId, caller.id);
  await registerDevice(thirdDeviceId, caller.id);
  otherKey = await registerDevice(otherDevice, other.id);
  pendingDeviceId = `${tag}-pending-device`;
  foreignDeviceId = `${tag}-foreign-device`;
  await registerDevice(pendingDeviceId, memberId);
  await registerDevice(foreignDeviceId, other.id);
  callerToken = signUserJwt(caller.id, callerDevice);
  await registerGroup(`${pid}@web`, {
    jid: `${pid}@web`,
    name: pid,
    folder: pid,
    trigger: '@x',
    added_at: new Date().toISOString(),
  });
  await createKnowledgeBase({
    id: kbId,
    name: kbId,
    description: '',
    folder_path: `/tmp/${kbId}`,
    last_indexed_at: null,
    created_at: Date.now(),
  });
  const { app } = await import('../http-service.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const spy of sandboxSpies) spy.mockRestore();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(`${pid}@web`);
});

describe('user and membership mutations need a fresh device signature', () => {
  test('unsigned, stale and foreign-device requests are rejected on every route', async () => {
    for (const route of [...routes, ...deviceRoutes, ...adminDeviceRoutes]) {
      const label = `${route.method} ${route.path()}`;
      expect([label, await send(route)]).toEqual([label, 401]);
      expect([
        label,
        await send(route, {
          key: callerKey,
          deviceId: callerDevice,
          ageMs: 120_000,
        }),
      ]).toEqual([label, 401]);
      expect([
        label,
        await send(route, { key: otherKey, deviceId: otherDevice }),
      ]).toEqual([label, 401]);
    }
  });

  test('mixed-case paths do not bypass the guard', async () => {
    const route = routes[0]!;
    expect(await send(route, undefined, '/API/Users')).toBe(401);
    expect(
      await send(
        deviceRoutes[0]!,
        undefined,
        `/API/Account/Devices/${secondDeviceId}`,
      ),
    ).toBe(401);
    expect(
      await send(
        adminDeviceRoutes[1]!,
        undefined,
        `/API/Admin/Devices/${foreignDeviceId}`,
      ),
    ).toBe(401);
  });

  // One test per route so each signed request has its own timeout. Bun runs
  // a file's tests sequentially in declaration order, and later routes depend
  // on earlier ones (the member is added before it is removed, the target user
  // is deleted last).
  describe("requests signed by the caller's own device succeed, in order", () => {
    for (const route of [...routes, ...deviceRoutes, ...adminDeviceRoutes]) {
      test(route.title ?? route.method, async () => {
        const label = `${route.method} ${route.path()}`;
        expect([
          label,
          await send(route, { key: callerKey, deviceId: callerDevice }),
        ]).toEqual([label, route.okStatus]);
      });
    }
  });

  test('AI-user, memory-audit and history-review writes need a signature', async () => {
    for (const route of adminWriteRoutes) {
      const label = `${route.method} ${route.path()}`;
      expect([label, await send(route)]).toEqual([label, 401]);
      expect([
        label,
        await send(route, { key: otherKey, deviceId: otherDevice }),
      ]).toEqual([label, 401]);
      const signed = await send(route, {
        key: callerKey,
        deviceId: callerDevice,
      });
      expect([label, signed]).not.toEqual([label, 401]);
    }
    expect(
      await send(
        adminWriteRoutes[0]!,
        undefined,
        '/API/Admin/AI-Users/missing',
      ),
    ).toBe(401);
  });

  test('GET requests stay unsigned', async () => {
    const response = await fetch(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${callerToken}` },
    });
    expect(response.status).toBe(200);
    const devices = await fetch(`${baseUrl}/api/account/devices`, {
      headers: { Authorization: `Bearer ${callerToken}` },
    });
    expect(devices.status).toBe(200);
    const adminDevices = await fetch(`${baseUrl}/api/admin/devices`, {
      headers: { Authorization: `Bearer ${callerToken}` },
    });
    expect(adminDevices.status).toBe(200);
  });
});
