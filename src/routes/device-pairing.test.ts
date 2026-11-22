// New core boundary: enrollment and integration grants must survive requests without privilege escalation.
import { beforeAll, afterAll, test, expect } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import * as db from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { deviceKeys, devicePairings, projects, users } from '../db/schema.js';
import { integrationAccess } from '../lib/device-auth/access.js';
import { requiredDeviceScopes } from '../lib/device-auth/policy.js';
import { getDevicePairingRouter } from './device-pairing.js';
import { getKnowledgeRouter } from '../modules/knowledge/routes.js';
import {
  CarapaDeviceClient,
  type DeviceCredentials,
} from '../lib/carapa-device-client.js';
import { signJwt, signUserJwt, verifyJwt } from '../lib/auth-jwt.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-pairing-'));
const suffix = path.basename(root);
let server: Server,
  base: string,
  admin: any,
  member: any,
  adminClient: CarapaDeviceClient;
let paired: CarapaDeviceClient, pairingId: string;
const oldSecret = process.env.CARAPA_BOARD_ENCRYPTION_KEY;
const ids: string[] = [];
async function credentials(): Promise<DeviceCredentials> {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  return {
    board: base,
    deviceId: `test-${crypto.randomUUID()}`,
    pubKeyB64: Buffer.from(
      await crypto.subtle.exportKey('spki', keys.publicKey),
    ).toString('base64'),
    privKeyB64: Buffer.from(
      await crypto.subtle.exportKey('pkcs8', keys.privateKey),
    ).toString('base64'),
  };
}
async function adminRequest(route: string, body: unknown) {
  return adminClient.signedRequest(
    route,
    'POST',
    body,
    signUserJwt(admin.id, adminClient.credentials.deviceId),
  );
}
async function integrationRequest(
  route: string,
  method = 'GET',
  body?: unknown,
) {
  return paired.signedRequest(
    route,
    method,
    body,
    signJwt({
      type: 'device',
      sub: member.id,
      did: paired.credentials.deviceId,
    }),
  );
}
beforeAll(async () => {
  process.env.CARAPA_BOARD_ENCRYPTION_KEY ||=
    'device-pairing-test-only-key-000000000000';
  await db.initDatabase(':memory:');
  admin = await db.createUser(`${suffix}-admin`, 'test', 'admin');
  member = await db.createUser(`${suffix}-member`, 'test', 'user');
  const app = express();
  app.use(express.json());
  app.use(integrationAccess);
  // Ordinary authenticated admin context; the production pairing router still verifies its signature and key ownership.
  app.use(async (req: any, _res, next) => {
    if (!req.integrationGrant) {
      const payload = verifyJwt(req.headers.authorization?.slice(7) || '');
      if (payload?.type === 'user') {
        req.authUser = await db.getUserById(payload.sub);
        req.authDeviceId = payload.did;
      }
    }
    next();
  });
  app.use('/api', getDevicePairingRouter());
  app.use('/api', getKnowledgeRouter());
  // Stands in for the conversation routes: reaching it means the device policy allowed the request.
  app.use('/api/projects', (_req, res) => res.json({ reached: true }));
  app.use((_req, res) => res.status(404).json({ error: 'Unsupported route' }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  adminClient = new CarapaDeviceClient(await credentials());
  await db.registerDeviceKey(
    adminClient.credentials.deviceId,
    admin.id,
    adminClient.credentials.pubKeyB64,
    'Admin',
    true,
  );
  for (const name of ['allowed', 'private']) {
    const id = `${suffix}-${name}`;
    ids.push(id);
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'article.md'), 'Private article');
    await db.createKnowledgeBase({
      id,
      name,
      description: null,
      folder_path: folder,
      created_at: Date.now(),
      last_indexed_at: null,
    });
    if (name === 'allowed') await db.upsertKbMember(member.id, id, 'owner');
  }
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of ids) await db.deleteKnowledgeBase(id);
  await drizzleDbRef.current.delete(users).where(eq(users.id, admin.id));
  await drizzleDbRef.current.delete(users).where(eq(users.id, member.id));
  await drizzleDbRef.current
    .delete(devicePairings)
    .where(eq(devicePairings.id, pairingId));
  fs.rmSync(root, { recursive: true, force: true });
  if (oldSecret === undefined) delete process.env.CARAPA_BOARD_ENCRYPTION_KEY;
  else process.env.CARAPA_BOARD_ENCRYPTION_KEY = oldSecret;
});

test('proof-bound pairing, admin approval, single-use code, retryable polling and real KB isolation', async () => {
  paired = new CarapaDeviceClient(await credentials());
  const start = await paired.signedRequest('/api/auth/device-pairing', 'POST', {
    publicKey: paired.credentials.pubKeyB64,
    label: 'Knowledge import',
    scopes: ['knowledge:read', 'knowledge:write'],
    nonce: crypto.randomUUID(),
  });
  expect(start.status).toBe(200);
  const request = (await start.json()) as any;
  pairingId = request.id;
  paired.credentials.deviceId = request.deviceId;
  const row = await db.getDevicePairing(pairingId);
  expect(row!.secretHash).not.toBe(request.pollingSecret);
  expect(row!.codeHash).not.toContain(request.userCode);
  const pollBody = { id: pairingId, pollingSecret: request.pollingSecret };
  const wrong = new CarapaDeviceClient(await credentials());
  expect(
    (
      await wrong.signedRequest(
        '/api/auth/device-pairing/poll',
        'POST',
        pollBody,
      )
    ).status,
  ).toBe(401);
  const resolved = await adminRequest('/api/admin/device-pairing/resolve', {
    code: request.userCode,
  });
  expect(resolved.status).toBe(200);
  const decision = {
    decision: 'approved',
    ownerId: member.id,
    scopes: ['knowledge:read'],
    days: 30,
  };
  expect(
    (
      await adminRequest(`/api/admin/device-pairing/${pairingId}/decision`, {
        ...decision,
        scopes: ['projects:read'],
      })
    ).status,
  ).toBe(409);
  const decisions = await Promise.all([
    adminRequest(`/api/admin/device-pairing/${pairingId}/decision`, decision),
    adminRequest(`/api/admin/device-pairing/${pairingId}/decision`, decision),
  ]);
  expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (
      await adminRequest('/api/admin/device-pairing/resolve', {
        code: request.userCode,
      })
    ).status,
  ).toBe(404);
  const grant = await db.getDeviceRecord(request.deviceId);
  expect(
    (
      await adminRequest(`/api/admin/devices/${request.deviceId}/grant`, {
        scopes: ['knowledge:read', 'knowledge:write'],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await adminRequest(`/api/admin/devices/${request.deviceId}/grant`, {
        scopes: ['knowledge:read'],
      })
    ).status,
  ).toBe(200);
  expect((await db.getDeviceRecord(request.deviceId))?.expiresAt).toBe(
    grant?.expiresAt,
  );
  const poll = await paired.signedRequest(
    '/api/auth/device-pairing/poll',
    'POST',
    pollBody,
  );
  // Approval remains recoverable through the independent polling proof.
  expect(poll.status).toBe(200);
  expect(((await poll.json()) as any).status).toBe('approved');
  expect(await db.pollDevicePairing(pairingId)).toBe('slow_down');
  expect(
    (await integrationRequest(`/api/knowledge/${ids[0]}/files`)).status,
  ).toBe(200);
  expect(
    (await integrationRequest(`/api/knowledge/${ids[1]}/files`)).status,
  ).toBe(403);
  expect(
    (
      await integrationRequest(`/api/knowledge/${ids[0]}/files`, 'POST', {
        name: 'x.md',
        content: 'YQ==',
      })
    ).status,
  ).toBe(403);
  expect((await integrationRequest('/api/admin/devices')).status).toBe(403);
  const listing = await integrationRequest('/api/knowledge');
  expect(((await listing.json()) as any[]).map((kb) => kb.id)).toEqual([
    ids[0],
  ]);
  await expect(
    db.registerDeviceKey(
      paired.credentials.deviceId,
      member.id,
      paired.credentials.pubKeyB64,
    ),
  ).rejects.toThrow('cannot be replaced');
});

test('revocation, expiry, disabled users, mixed identities and legacy aliases cannot escape scopes', async () => {
  const id = paired.credentials.deviceId;
  const userToken = signUserJwt(member.id, id);
  expect(
    (
      await paired.signedRequest(
        `/api/knowledge/${ids[0]}/files`,
        'GET',
        undefined,
        userToken,
      )
    ).status,
  ).toBe(401);
  for (const url of [
    '/mcp/carapa-board',
    // Live events are session-only: no WS ticket for device keys, so objective chat events never reach them.
    '/api/ws-ticket',
    '/api/auth/login',
    '/api/devices/push-token',
    '/api/unknown',
    '/uploads/anything',
  ])
    expect((await integrationRequest(url)).status).toBe(403);
  expect(
    (
      await integrationRequest(
        `/api/knowledge/${ids[0]}/files/article.md/content`,
      )
    ).status,
  ).toBe(200);
  await drizzleDbRef.current
    .update(deviceKeys)
    .set({ expiresAt: new Date(Date.now() - 1).toISOString() })
    .where(eq(deviceKeys.device_id, id));
  expect(await db.getDevicePublicKey(id)).toBeUndefined();
  expect((await integrationRequest('/api/knowledge')).status).toBe(401);
  await drizzleDbRef.current
    .update(deviceKeys)
    .set({ expiresAt: null })
    .where(eq(deviceKeys.device_id, id));
  await drizzleDbRef.current
    .update(users)
    .set({ disabled: 1 })
    .where(eq(users.id, member.id));
  expect((await integrationRequest('/api/knowledge')).status).toBe(401);
  await drizzleDbRef.current
    .update(users)
    .set({ disabled: 0 })
    .where(eq(users.id, member.id));
  await db.adminDeleteDevice(id);
  expect((await integrationRequest('/api/knowledge')).status).toBe(401);
});

test('pending enrollment requires an approved admin and denial or expiry cannot create a grant', async () => {
  for (const outcome of ['denied', 'expired'] as const) {
    const client = new CarapaDeviceClient(await credentials());
    const start = await client.signedRequest(
      '/api/auth/device-pairing',
      'POST',
      {
        publicKey: client.credentials.pubKeyB64,
        label: outcome,
        scopes: ['knowledge:read'],
        nonce: crypto.randomUUID(),
      },
    );
    expect(start.status).toBe(200);
    const request = (await start.json()) as any;
    try {
      expect(
        (
          await client.signedRequest(
            '/api/admin/device-pairing/resolve',
            'POST',
            { code: request.userCode },
          )
        ).status,
      ).toBe(403);
      if (outcome === 'expired')
        await drizzleDbRef.current
          .update(devicePairings)
          .set({ expiresAt: new Date(Date.now() - 1).toISOString() })
          .where(eq(devicePairings.id, request.id));
      const response = await adminRequest(
        `/api/admin/device-pairing/${request.id}/decision`,
        {
          decision: outcome === 'denied' ? 'denied' : 'approved',
          ownerId: member.id,
          scopes: ['knowledge:read'],
          days: 30,
        },
      );
      expect(response.status).toBe(outcome === 'denied' ? 200 : 409);
      const poll = await client.signedRequest(
        '/api/auth/device-pairing/poll',
        'POST',
        { id: request.id, pollingSecret: request.pollingSecret },
      );
      expect(((await poll.json()) as any).status).toBe(outcome);
      expect(await db.getDeviceRecord(request.deviceId)).toBeUndefined();
    } finally {
      await drizzleDbRef.current
        .delete(devicePairings)
        .where(eq(devicePairings.id, request.id));
    }
  }
});

test('explicit scope catalog separates data and actions across supported domains', () => {
  for (const [url, scope] of [
    ['/projects', 'projects:read'],
    ['/projects/p/tasks', 'tasks:read'],
    ['/projects/p/objectives', 'objectives:read'],
    ['/projects/p/conversations', 'conversations:read'],
    ['/projects/p/files/group/content', 'files:read'],
    ['/groups/p/memories', 'memories:read'],
    ['/projects/p/cronjobs', 'schedules:read'],
    ['/projects/p/dataset-tasks', 'datasets:read'],
    ['/projects/p/mail/messages', 'mail:read'],
    ['/reports/run-costs', 'reports:read'],
    ['/notifications/unread', 'notifications:read'],
    ['/sandbox/status', 'sandboxes:read'],
  ])
    expect(requiredDeviceScopes('GET', '/api' + url, {})).toContain(scope);
  for (const [url, scope] of [
    ['/projects/p/tasks/t/execute', 'tasks:execute'],
    ['/projects/p/mail/send', 'mail:send'],
    ['/sandbox/s/start', 'sandboxes:control'],
    ['/projects/p/meetings/record', 'meetings:execute'],
    ['/projects/p/git/push', 'git:push'],
  ])
    expect(requiredDeviceScopes('POST', '/api' + url, {})).toContain(scope);
  expect(
    requiredDeviceScopes('PATCH', '/api/projects/p/tasks/t', { title: 'Edit' }),
  ).toEqual(['tasks:write']);
  expect(
    requiredDeviceScopes('PATCH', '/api/projects/p/tasks/t', {
      status: 'running',
    }),
  ).toContain('tasks:execute');
  expect(
    requiredDeviceScopes('PATCH', '/api/projects/p', {
      settings: { members: [] },
    }),
  ).toBeNull();
  expect(requiredDeviceScopes('POST', '/api/knowledge/k/share', {})).toBeNull();
});

test('objective chats require the objective scopes in addition to the conversation scopes', async () => {
  expect(
    requiredDeviceScopes('POST', '/api/projects/p/conversations', {
      objective_id: 'obj-1',
    }),
  ).toEqual(
    expect.arrayContaining([
      'conversations:write',
      'conversations:execute',
      'objectives:write',
      'objectives:execute',
    ]),
  );
  expect(
    requiredDeviceScopes(
      'GET',
      '/api/projects/p/conversations',
      {},
      {
        objective_id: 'obj-1',
      },
    ),
  ).toEqual(['conversations:read', 'objectives:read']);
  expect(
    requiredDeviceScopes('POST', '/api/projects/p/messages', {
      objective_id: 'obj-1',
    }),
  ).toContain('objectives:execute');
  expect(
    requiredDeviceScopes('GET', '/api/projects/p/conversations', {}, {}),
  ).toEqual(['conversations:read']);
  expect(
    requiredDeviceScopes('POST', '/api/projects/p/conversations', {
      objective_id: '  ',
    }),
  ).toEqual(['conversations:write', 'conversations:execute']);

  const project = `${suffix}-chats`;
  for (const id of [project, `${project}-other`])
    await drizzleDbRef.current.insert(projects).values({
      id,
      jid: `${id}@web`,
      name: id,
      folder: id,
      trigger: '@x',
      added_at: new Date().toISOString(),
    });
  const objectiveConv = await db.createConversation(project, {
    objective_id: 'obj-1',
  });
  const projectConv = await db.createConversation(project);
  const foreignObjectiveConv = await db.createConversation(`${project}-other`, {
    objective_id: 'obj-2',
  });
  const conversationScopes = [
    'conversations:read',
    'conversations:write',
    'conversations:execute',
    'conversations:delete',
    'files:write',
  ];
  const devices: string[] = [];
  async function client(scopes: string[]) {
    const c = new CarapaDeviceClient(await credentials());
    devices.push(c.credentials.deviceId);
    await drizzleDbRef.current.insert(deviceKeys).values({
      device_id: c.credentials.deviceId,
      user_id: member.id,
      public_key: c.credentials.pubKeyB64,
      kind: 'integration',
      scopes,
      is_active: true,
      is_approved: true,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    });
    return async (route: string, method = 'GET', body?: unknown) => {
      const response = await c.signedRequest(
        route,
        method,
        body,
        signJwt({
          type: 'device',
          sub: member.id,
          did: c.credentials.deviceId,
        }),
      );
      return { status: response.status, body: await response.json() };
    };
  }
  const prefix = `/api/projects/${project}`;
  const missing = { status: 404, body: { error: 'Conversation not found' } };
  try {
    const chatOnly = await client(conversationScopes);
    const withRead = await client([...conversationScopes, 'objectives:read']);
    const full = await client([
      ...conversationScopes,
      'objectives:read',
      'objectives:write',
      'objectives:execute',
    ]);
    // Denied status without objective scopes: 403 when the request names the
    // objective itself, 404 when it only names the objective conversation.
    const objectiveRequests: [string, string, unknown, number][] = [
      ['POST', `${prefix}/conversations`, { objective_id: 'obj-1' }, 403],
      ['GET', `${prefix}/conversations?objective_id=obj-1`, undefined, 403],
      ['GET', `${prefix}/conversations/${objectiveConv.id}`, undefined, 404],
      [
        'GET',
        `${prefix}/conversations/${objectiveConv.id}/transcript`,
        undefined,
        404,
      ],
      [
        'GET',
        `${prefix}/messages?conversation_id=${objectiveConv.id}`,
        undefined,
        404,
      ],
      [
        'POST',
        `${prefix}/messages`,
        { conversation_id: objectiveConv.id },
        404,
      ],
      ['POST', `${prefix}/messages`, { conversationId: objectiveConv.id }, 404],
      [
        'POST',
        `${prefix}/messages?conversationId=${objectiveConv.id}`,
        { content: 'hi' },
        404,
      ],
      [
        'POST',
        `${prefix}/upload`,
        { filename: 'a.txt', data: 'YQ==', conversation_id: objectiveConv.id },
        404,
      ],
      ['POST', `${prefix}/messages`, { objective_id: 'obj-1' }, 403],
      [
        'POST',
        `${prefix}/messages/stop`,
        { conversation_id: objectiveConv.id },
        404,
      ],
      [
        'PATCH',
        `${prefix}/conversations/${objectiveConv.id}`,
        { title: 't' },
        404,
      ],
      ['DELETE', `${prefix}/conversations/${objectiveConv.id}`, undefined, 404],
    ];
    const allowed = { status: 200, body: { reached: true } };
    for (const [method, route, body, denied] of objectiveRequests) {
      expect((await chatOnly(route, method, body)).status).toBe(denied);
      expect(await full(route, method, body)).toEqual(allowed);
      // Read and execute are enforced separately.
      expect((await withRead(route, method, body)).status).toBe(
        method === 'GET' ? 200 : denied,
      );
    }
    // Resolving by conversation id gives no existence oracle.
    const unknown = (route: string) => chatOnly(route);
    expect(await unknown(`${prefix}/conversations/conv-nope`)).toEqual(missing);
    expect(
      await unknown(`${prefix}/conversations/${objectiveConv.id}`),
    ).toEqual(missing);
    expect(
      await unknown(`${prefix}/conversations/${foreignObjectiveConv.id}`),
    ).toEqual(missing);
    for (const who of [chatOnly, full])
      expect(
        await who(`${prefix}/conversations/${foreignObjectiveConv.id}`),
      ).toEqual(missing);
    // Project chats are unchanged.
    for (const [method, route, body] of [
      ['GET', `${prefix}/conversations`],
      ['GET', `${prefix}/conversations/${projectConv.id}/transcript`],
      ['POST', `${prefix}/conversations`, {}],
      ['POST', `${prefix}/messages`, { conversation_id: projectConv.id }],
      ['POST', `${prefix}/messages/stop`, { conversation_id: projectConv.id }],
      [
        'POST',
        `${prefix}/upload`,
        { filename: 'a.txt', data: 'YQ==', conversation_id: projectConv.id },
      ],
    ] as [string, string, unknown?][])
      expect(await chatOnly(route, method, body)).toEqual(allowed);
  } finally {
    for (const id of devices) await db.adminDeleteDevice(id);
    for (const id of [project, `${project}-other`])
      await drizzleDbRef.current.delete(projects).where(eq(projects.id, id));
  }
});
