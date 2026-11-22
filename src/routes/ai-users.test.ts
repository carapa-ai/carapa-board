import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  createConversation,
  initDatabase,
  upsertConversationMember,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { loadState } from '../state-manager.js';
import { upsertProjectMember } from '../modules/knowledge/db-kb.js';
import { conversationAiUsersRouter } from './ai-users.js';
import { enforceProjectAccess } from './projects.js';

const projectId = 'ai-users-access';
const ownerId = 'ai-users-owner';
const editorId = 'ai-users-editor';
const viewerId = 'ai-users-viewer';
const implicitId = 'ai-users-implicit';
const adminId = 'ai-users-admin';

let baseUrl = '';
let server: Server | undefined;
let convA = '';
let convB = '';

function request(userId: string, cid: string, method: string, tail: string) {
  return fetch(
    `${baseUrl}/api/projects/${projectId}/conversations/${cid}/ai-users${tail}`,
    {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
      body: method === 'GET' ? undefined : JSON.stringify(bodyFor(tail)),
    },
  );
}

function bodyFor(tail: string) {
  return tail === '/main' ? { selection: { mode: 'inherit' } } : {};
}

describe('conversation AI user routes enforce per-conversation access', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES
         ('${ownerId}', '${ownerId}', 'test', 'user', '${now}'),
         ('${editorId}', '${editorId}', 'test', 'user', '${now}'),
         ('${viewerId}', '${viewerId}', 'test', 'user', '${now}'),
         ('${implicitId}', '${implicitId}', 'test', 'user', '${now}'),
         ('${adminId}', '${adminId}', 'test', 'admin', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${projectId}', '${projectId}@web', 'AI users access', '${projectId}', '!', '${now}', 0, '${ownerId}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertProjectMember(editorId, projectId, 'editor');
    await upsertProjectMember(viewerId, projectId, 'viewer');
    convA = (await createConversation(projectId)).id;
    convB = (await createConversation(projectId)).id;
    await upsertConversationMember(implicitId, convA, 'editor');
    await loadState();

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const uid = req.headers['x-test-user-id'];
      const id = typeof uid === 'string' ? uid : ownerId;
      req.authUser = {
        id,
        username: id,
        role: id === adminId ? 'admin' : 'user',
      };
      next();
    });
    const api = express.Router();
    api.use('/projects/:pid', enforceProjectAccess);
    api.use(conversationAiUsersRouter);
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

  test('implicit member of one conversation is denied on another', async () => {
    expect((await request(implicitId, convA, 'GET', '')).status).toBe(200);
    for (const [method, tail] of [
      ['GET', ''],
      ['GET', '/available'],
      ['GET', '/main'],
      ['GET', '/main-selection'],
      ['PATCH', '/main'],
      ['POST', ''],
      ['POST', '/teams/t1'],
      ['PATCH', '/ai-user-1'],
      ['DELETE', '/ai-user-1'],
    ] as const) {
      const res = await request(implicitId, convB, method, tail);
      expect([method, tail, res.status]).toEqual([method, tail, 403]);
    }
  });

  test('viewer can read but not change AI users', async () => {
    expect((await request(viewerId, convB, 'GET', '/main')).status).toBe(200);
    for (const [method, tail] of [
      ['PATCH', '/main'],
      ['POST', ''],
      ['POST', '/teams/t1'],
      ['PATCH', '/ai-user-1'],
      ['DELETE', '/ai-user-1'],
    ] as const) {
      const res = await request(viewerId, convB, method, tail);
      expect([method, tail, res.status]).toEqual([method, tail, 403]);
    }
  });

  test('editor can change the main AI user; an admin outside the project cannot', async () => {
    expect((await request(editorId, convB, 'PATCH', '/main')).status).toBe(200);
    expect((await request(adminId, convB, 'PATCH', '/main')).status).toBe(403);
  });
});
