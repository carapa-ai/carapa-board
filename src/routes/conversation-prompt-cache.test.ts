import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  createConversation,
  getConversation,
  initDatabase,
  upsertConversationMember,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { loadState } from '../state-manager.js';
import conversationsRouter from './conversations.js';
import { enforceProjectAccess } from './projects.js';

const projectId = 'prompt-cache-route';
const ownerId = 'prompt-cache-owner';

let baseUrl = '';
let server: Server | undefined;
let conversationId = '';

function patchAsOwner(body: unknown) {
  return fetch(
    `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': ownerId,
      },
      body: JSON.stringify(body),
    },
  );
}

describe('PATCH /projects/:pid/conversations/:cid promptCache1h', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('${ownerId}', '${ownerId}', 'test', 'user', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${projectId}', '${projectId}@web', 'Prompt cache', '${projectId}', '!', '${now}', 0, '${ownerId}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await loadState();
    const conversation = await createConversation(projectId, {
      ownerUserId: ownerId,
    });
    conversationId = conversation.id;
    await upsertConversationMember(ownerId, conversationId, 'owner');

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const uid = req.headers['x-test-user-id'];
      const id = typeof uid === 'string' ? uid : ownerId;
      req.authUser = { id, username: id, role: 'user' };
      next();
    });
    const api = express.Router();
    api.use('/projects/:pid', enforceProjectAccess);
    api.use(conversationsRouter);
    app.use('/api', api);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test('saves true and false and returns the saved value', async () => {
    const on = await patchAsOwner({ promptCache1h: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, promptCache1h: true });
    expect((await getConversation(conversationId))?.promptCache1h).toBe(true);

    const off = await patchAsOwner({ promptCache1h: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, promptCache1h: false });
    expect((await getConversation(conversationId))?.promptCache1h).toBe(false);
  });

  test('rejects a non-boolean promptCache1h and keeps the stored value', async () => {
    await patchAsOwner({ promptCache1h: true });
    for (const value of ['yes', 1, null]) {
      const res = await patchAsOwner({ promptCache1h: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'promptCache1h must be a boolean',
      });
    }
    expect((await getConversation(conversationId))?.promptCache1h).toBe(true);
  });
});
