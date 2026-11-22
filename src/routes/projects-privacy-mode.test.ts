import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSigningPayload } from '../crypto-verify.js';
import {
  createUser,
  getUserById,
  initDatabase,
  registerDeviceKey,
} from '../db.js';
import { upsertProjectMember } from '../modules/knowledge/db-kb.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import projectsRouter from './projects.js';

const pid = `privacy-mode-route-${process.pid}`;
const jid = `${pid}@web`;
const adminDevice = `${pid}-admin-device`;
let server: Server;
let baseUrl: string;
let signingKey: CryptoKey;
const users: Record<string, string> = {};

async function setStored(privacyMode?: 'off' | 'local_memory' | 'strict') {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Privacy route',
    folder: pid,
    trigger: '@privacy',
    added_at: new Date().toISOString(),
    settings: { status: 'running', ...(privacyMode ? { privacyMode } : {}) },
  });
  await upsertProjectMember(users.owner!, pid, 'owner');
  await upsertProjectMember(users.viewer!, pid, 'viewer');
}

async function patch(
  who: 'admin' | 'owner' | 'viewer' | 'agent',
  privacyMode: unknown,
  { sign = false }: { sign?: boolean } = {},
) {
  const path = `/projects/${pid}`;
  const bodyText = JSON.stringify({ settings: { privacyMode } });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-who': who,
  };
  if (sign) {
    const timestamp = new Date().toISOString();
    const payload = createSigningPayload('PATCH', path, timestamp, bodyText);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      new TextEncoder().encode(payload),
    );
    headers['x-carapa-device-id'] = adminDevice;
    headers['x-carapa-timestamp'] = timestamp;
    headers['x-carapa-signature'] = Buffer.from(signature).toString('base64');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers,
    body: bodyText,
  });
  return { status: response.status, body: await response.json() };
}

const stored = () => getGroupByFolder(pid)?.settings?.privacyMode;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  for (const [name, role] of [
    ['admin', 'admin'],
    ['owner', 'user'],
    ['viewer', 'user'],
  ] as const) {
    users[name] = (await createUser(`${pid}-${name}`, 'password', role)).id;
  }
  const keys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  signingKey = keys.privateKey;
  await registerDeviceKey(
    adminDevice,
    users.admin!,
    Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString(
      'base64',
    ),
    'test',
    true,
  );
  await setStored();

  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    const who = String(req.headers['x-test-who']);
    if (who === 'agent') req.tokenScope = { group_folder: pid };
    else req.authUser = await getUserById(users[who]!);
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(jid);
});

describe('PATCH /projects/:pid privacyMode', () => {
  test('an admin session can raise the mode and it is persisted', async () => {
    await setStored();
    expect((await patch('admin', 'strict')).status).toBe(200);
    expect(stored()).toBe('strict');
  });

  test('agent tokens, viewers and non-admin owners get 403', async () => {
    await setStored();
    for (const who of ['agent', 'viewer', 'owner'] as const) {
      const res = await patch(who, 'strict');
      expect(res.status).toBe(403);
    }
    const ownerRes = await patch('owner', 'strict');
    expect(ownerRes.body).toEqual({
      error: 'Only a board admin can change the project privacy mode',
    });
    expect(stored()).toBeUndefined();
  });

  test('an invalid value is rejected with 400', async () => {
    await setStored();
    expect((await patch('admin', 'paranoid')).status).toBe(400);
    expect((await patch('admin', true)).status).toBe(400);
    expect(stored()).toBeUndefined();
  });

  test('a downgrade needs a fresh device signature', async () => {
    for (const next of ['off', null] as const) {
      await setStored('strict');
      expect((await patch('admin', next)).status).toBe(401);
      expect(stored()).toBe('strict');
      expect((await patch('admin', next, { sign: true })).status).toBe(200);
      expect(stored() ?? 'off').toBe('off');
    }
  });

  test('null removes the stored key', async () => {
    await setStored('local_memory');
    expect((await patch('admin', null, { sign: true })).status).toBe(200);
    expect(getGroupByFolder(pid)?.settings).not.toHaveProperty('privacyMode');
  });

  test('raising the mode needs no signature', async () => {
    await setStored();
    expect((await patch('admin', 'local_memory')).status).toBe(200);
    expect((await patch('admin', 'strict')).status).toBe(200);
    expect(stored()).toBe('strict');
  });
});
