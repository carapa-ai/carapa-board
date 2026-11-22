import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';

import { createSigningPayload } from '../crypto-verify.js';
import {
  createConversation,
  createUser,
  initDatabase,
  registerDeviceKey,
} from '../db.js';
import { signUserJwt } from '../lib/auth-jwt.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';

const tag = `conv-shares-sig-${process.pid}`;
const pid = `${tag}-project`;
const callerDevice = `${tag}-caller-device`;
const otherDevice = `${tag}-other-device`;
let server: Server;
let baseUrl: string;
let callerToken: string;
let callerKey: CryptoKey;
let otherKey: CryptoKey;
let cid: string;
let memberId: string;

type Route = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: () => string;
  body?: () => Record<string, unknown>;
  okStatus: number;
};

const base = () => `/api/projects/${pid}/conversations/${cid}`;

// Ordered so the signed run succeeds end to end (the public link exists
// before it is patched, regenerated and revoked).
const routes: Route[] = [
  {
    method: 'PUT',
    path: () => `${base()}/public-share`,
    okStatus: 200,
  },
  {
    method: 'PATCH',
    path: () => `${base()}/public-share/visitor-prompts`,
    body: () => ({ enabled: false }),
    okStatus: 200,
  },
  {
    method: 'POST',
    path: () => `${base()}/public-share/regenerate`,
    okStatus: 200,
  },
  {
    method: 'DELETE',
    path: () => `${base()}/public-share`,
    okStatus: 200,
  },
  {
    method: 'POST',
    path: () => `${base()}/members`,
    body: () => ({ user_id: memberId, access_level: 'owner' }),
    okStatus: 200,
  },
  {
    method: 'DELETE',
    path: () => `${base()}/members/${memberId}`,
    okStatus: 200,
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
  await initDatabase(':memory:');
  await loadState();
  const caller = await createUser(`${tag}-caller`, 'password', 'admin');
  const other = await createUser(`${tag}-other`, 'password', 'admin');
  memberId = (await createUser(`${tag}-member`, 'password', 'user')).id;
  callerKey = await registerDevice(callerDevice, caller.id);
  otherKey = await registerDevice(otherDevice, other.id);
  callerToken = signUserJwt(caller.id, callerDevice);
  await registerGroup(`${pid}@web`, {
    jid: `${pid}@web`,
    name: pid,
    folder: pid,
    trigger: '@x',
    added_at: new Date().toISOString(),
  });
  cid = (await createConversation(pid)).id;
  const { app } = await import('../http-service.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(`${pid}@web`);
});

describe('conversation sharing mutations need a fresh device signature', () => {
  test('unsigned, stale and foreign-device requests are rejected on every route', async () => {
    for (const route of routes) {
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
    const route = routes[4]!;
    expect(
      await send(
        route,
        undefined,
        `/API/Projects/${pid}/Conversations/${cid}/Members`,
      ),
    ).toBe(401);
  });

  test("requests signed by the caller's own device succeed, in order", async () => {
    for (const route of routes) {
      const label = `${route.method} ${route.path()}`;
      expect([
        label,
        await send(route, { key: callerKey, deviceId: callerDevice }),
      ]).toEqual([label, route.okStatus]);
    }
  });

  test('GET requests stay unsigned', async () => {
    for (const suffix of ['members', 'public-share']) {
      const response = await fetch(`${baseUrl}${base()}/${suffix}`, {
        headers: { Authorization: `Bearer ${callerToken}` },
      });
      expect([suffix, response.status]).toEqual([suffix, 200]);
    }
  });
});
