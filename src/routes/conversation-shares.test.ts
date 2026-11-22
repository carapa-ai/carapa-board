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
import conversationSharesRouter from './conversation-shares.js';
import { enforceProjectAccess } from './projects.js';

const projectId = 'conv-shares-members';
const otherProjectId = 'conv-shares-members-other';
const ownerId = 'conv-shares-owner';
const implicitId = 'conv-shares-implicit';
const editorId = 'conv-shares-editor';
const adminId = 'conv-shares-admin';
const ownerlessProjectId = 'conv-shares-ownerless';

let baseUrl = '';
let server: Server | undefined;
let convA = '';
let convB = '';
let convOtherProject = '';
let convOwnerless = '';

function getMembers(userId: string, pid: string, cid: string) {
  return fetch(`${baseUrl}/api/projects/${pid}/conversations/${cid}/members`, {
    headers: { 'x-test-user-id': userId },
  });
}

describe('GET /projects/:pid/conversations/:cid/members access', () => {
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
         ('${implicitId}', '${implicitId}', 'test', 'user', '${now}'),
         ('${editorId}', '${editorId}', 'test', 'user', '${now}'),
         ('${adminId}', '${adminId}', 'test', 'admin', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    for (const pid of [projectId, otherProjectId]) {
      await client.exec(
        `INSERT INTO projects
           (id, jid, name, folder, trigger, added_at, is_main, user_id)
         VALUES ('${pid}', '${pid}@web', '${pid}', '${pid}', '!', '${now}', 0, '${ownerId}')
         ON CONFLICT (id) DO NOTHING`,
      );
    }
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main)
       VALUES ('${ownerlessProjectId}', '${ownerlessProjectId}@web', '${ownerlessProjectId}', '${ownerlessProjectId}', '!', '${now}', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertProjectMember(editorId, projectId, 'editor');
    await upsertProjectMember(adminId, projectId, 'editor');
    await loadState();
    convA = (await createConversation(projectId)).id;
    convB = (await createConversation(projectId)).id;
    convOtherProject = (await createConversation(otherProjectId)).id;
    convOwnerless = (await createConversation(ownerlessProjectId)).id;
    await upsertConversationMember(implicitId, convA, 'viewer');

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
    api.use(conversationSharesRouter);
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

  test('denies an implicit user the member list of another conversation', async () => {
    const res = await getMembers(implicitId, projectId, convB);
    expect(res.status).toBe(403);
  });

  test('allows an implicit user the member list of their own conversation', async () => {
    const res = await getMembers(implicitId, projectId, convA);
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ user_id: string }>;
    expect(members.map((m) => m.user_id)).toContain(implicitId);
  });

  test('allows an explicit project member any conversation in the project', async () => {
    const res = await getMembers(editorId, projectId, convB);
    expect(res.status).toBe(200);
  });

  test('returns 404 for a conversation belonging to another project', async () => {
    const res = await getMembers(editorId, projectId, convOtherProject);
    expect(res.status).toBe(404);
  });

  test('an admin is held to their membership level on another user’s project, not on an ownerless one', async () => {
    const put = (user: string, pid: string, cid: string) =>
      fetch(
        `${baseUrl}/api/projects/${pid}/conversations/${cid}/public-share`,
        {
          method: 'PUT',
          headers: { 'x-test-user-id': user },
        },
      );
    expect((await put(adminId, projectId, convB)).status).toBe(403);
    expect((await put(editorId, projectId, convB)).status).toBe(403);
    expect((await put(ownerId, projectId, convB)).status).toBe(200);
    expect((await put(adminId, ownerlessProjectId, convOwnerless)).status).toBe(
      200,
    );
  });
});
