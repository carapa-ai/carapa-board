import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';

import { createSigningPayload } from '../crypto-verify.js';
import { createUser, initDatabase, registerDeviceKey } from '../db.js';
import { signUserJwt } from '../lib/auth-jwt.js';

const tag = `sandbox-ssh-sig-${process.pid}`;
const callerDevice = `${tag}-caller-device`;
const otherDevice = `${tag}-other-device`;
let server: Server;
let baseUrl: string;
let callerToken: string;
let callerKey: CryptoKey;
let otherKey: CryptoKey;

type Sign = { key: CryptoKey; deviceId: string; ageMs?: number };

const sshPath = '/api/sandbox/x/ssh';

async function send(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  sign?: Sign,
) {
  const bodyText = body ? JSON.stringify(body) : '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${callerToken}`,
  };
  if (bodyText) headers['content-type'] = 'application/json';
  if (sign) {
    const timestamp = new Date(Date.now() - (sign.ageMs ?? 0)).toISOString();
    const payload = createSigningPayload(method, path, timestamp, bodyText);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      sign.key,
      new TextEncoder().encode(payload),
    );
    headers['x-carapa-device-id'] = sign.deviceId;
    headers['x-carapa-timestamp'] = timestamp;
    headers['x-carapa-signature'] = Buffer.from(signature).toString('base64');
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyText || undefined,
  });
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
  const caller = await createUser(`${tag}-caller`, 'password', 'admin');
  const other = await createUser(`${tag}-other`, 'password', 'admin');
  callerKey = await registerDevice(callerDevice, caller.id);
  otherKey = await registerDevice(otherDevice, other.id);
  callerToken = signUserJwt(caller.id, callerDevice);
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
});

describe('sandbox SSH enable/disable needs a fresh device signature', () => {
  test('unsigned, stale and foreign-device POST are rejected', async () => {
    const attempts: Array<[string, Sign | undefined]> = [
      ['unsigned', undefined],
      ['stale', { key: callerKey, deviceId: callerDevice, ageMs: 120_000 }],
      ['foreign device', { key: otherKey, deviceId: otherDevice }],
    ];
    for (const [label, sign] of attempts) {
      const post = await send('POST', sshPath, { enabled: true }, sign);
      expect([label, post.status]).toEqual([label, 401]);
    }
  });

  test('mixed-case path does not bypass the guard', async () => {
    const response = await send('POST', '/API/Sandbox/x/SSH', {
      enabled: true,
    });
    expect(response.status).toBe(401);
  });

  test("request signed by the caller's own device passes the gate", async () => {
    const response = await send(
      'POST',
      sshPath,
      { enabled: true },
      { key: callerKey, deviceId: callerDevice },
    );
    expect(response.status).not.toBe(401);
  });

  test('GET status stays unsigned', async () => {
    const response = await send('GET', sshPath);
    expect(response.status).not.toBe(401);
  });
});
