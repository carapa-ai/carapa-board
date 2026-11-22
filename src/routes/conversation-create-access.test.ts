import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  createConversation,
  getChatMessages,
  getConversations,
  initDatabase,
  upsertConversationMember,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { generateAgentToken } from '../mcp/auth-tokens.js';
import { loadState } from '../state-manager.js';
import { upsertProjectMember } from '../modules/knowledge/db-kb.js';
import conversationsRouter from './conversations.js';
import { enforceProjectAccess } from './projects.js';

const projectId = 'conv-create-access';
const ownerId = 'conv-create-owner';
const editorId = 'conv-create-editor';
const viewerId = 'conv-create-viewer';
const implicitId = 'conv-create-implicit';
const strangerId = 'conv-create-stranger';
const adminId = 'conv-create-admin';
const memberAdminId = 'conv-create-member-admin';
const destProjectId = 'conv-create-dest';

let baseUrl = '';
let server: Server | undefined;

function postAs(userId: string) {
  return fetch(`${baseUrl}/api/projects/${projectId}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
    body: JSON.stringify({}),
  });
}

describe('POST /projects/:pid/conversations access levels', () => {
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
         ('${strangerId}', '${strangerId}', 'test', 'user', '${now}'),
         ('${adminId}', '${adminId}', 'test', 'admin', '${now}'),
         ('${memberAdminId}', '${memberAdminId}', 'test', 'admin', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${projectId}', '${projectId}@web', 'Create access', '${projectId}', '!', '${now}', 0, '${ownerId}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${destProjectId}', '${destProjectId}@web', 'Handoff dest', '${destProjectId}', '!', '${now}', 0, '${ownerId}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertProjectMember(editorId, destProjectId, 'viewer');
    await upsertProjectMember(editorId, projectId, 'editor');
    await upsertProjectMember(viewerId, projectId, 'viewer');
    await upsertProjectMember(memberAdminId, projectId, 'viewer');
    await loadState();

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const uid = req.headers['x-test-user-id'];
      const agent = req.headers['x-test-agent'];
      if (typeof agent === 'string') {
        req.tokenScope = {
          group_folder: projectId,
          ...(agent !== 'sandbox'
            ? { conversation_id: agent, run_id: 'r' }
            : {}),
        };
        req.authCredentialKind = 'agent';
        next();
        return;
      }
      const id = typeof uid === 'string' ? uid : ownerId;
      req.authUser = {
        id,
        username: id,
        role: id.includes('admin') ? 'admin' : 'user',
      };
      next();
    });
    // Production mount order from projects.ts (itself mounted under /api):
    // the access middleware first, then the domain routers. Keeping the
    // /api prefix makes req.originalUrl shaped like the production URLs, so
    // the implicit-user allowlist tail check runs against the same strings.
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

  test('denies an explicit viewer member and creates nothing', async () => {
    const before = (await getConversations(projectId)).length;
    const res = await postAs(viewerId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Cannot create conversations in this project',
    });
    const after = (await getConversations(projectId)).length;
    expect(after).toBe(before);
  });

  test('denies a non-member at the admission guard', async () => {
    const res = await postAs(strangerId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Access denied to this project',
    });
  });

  test('closes a project owned by another user to an admin who is not a member, and gives a member admin the member level', async () => {
    const before = (await getConversations(projectId)).length;
    const outsider = await postAs(adminId);
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toEqual({
      error: 'Access denied to this project',
    });
    const member = await postAs(memberAdminId);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
      error: 'Cannot create conversations in this project',
    });
    expect((await getConversations(projectId)).length).toBe(before);
  });

  test('still allows the project owner', async () => {
    const res = await postAs(ownerId);
    expect(res.status).toBe(201);
    const conversation = (await res.json()) as { id: string };
    expect(conversation.id).toBeTruthy();
  });

  test('still allows an explicit editor member', async () => {
    const res = await postAs(editorId);
    expect(res.status).toBe(201);
    const conversation = (await res.json()) as { id: string };
    expect(conversation.id).toBeTruthy();
  });

  test('still denies an implicit (chat-shared) user', async () => {
    // Membership in one project conversation is what makes a user implicit.
    const conversation = await createConversation(projectId);
    await upsertConversationMember(implicitId, conversation.id, 'viewer');
    const res = await postAs(implicitId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Cannot create conversations in this project',
    });
  });

  test('scopes message reads and stop to conversations the caller can reach', async () => {
    const shared = await createConversation(projectId);
    const other = await createConversation(projectId);
    await upsertConversationMember(implicitId, shared.id, 'viewer');
    await upsertConversationMember(ownerId, shared.id, 'owner');
    const as = (userId: string, path: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}/api/projects/${projectId}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': userId,
        },
      });
    const stop = (userId: string, conversation_id: string) =>
      as(userId, '/messages/stop', {
        method: 'POST',
        body: JSON.stringify({ conversation_id }),
      });

    expect(
      (await as(implicitId, `/messages?conversation_id=${shared.id}`)).status,
    ).toBe(200);
    expect(
      (await as(implicitId, `/messages?conversation_id=${other.id}`)).status,
    ).toBe(403);
    expect((await as(implicitId, '/messages')).status).toBe(403);
    expect((await stop(implicitId, shared.id)).status).toBe(403);
    expect((await stop(ownerId, 'missing-conversation')).status).toBe(404);
    for (const userId of [implicitId, viewerId]) {
      expect(
        (await as(userId, '/messages/stop', { method: 'POST', body: '{}' }))
          .status,
      ).toBe(403);
    }
    expect((await stop(ownerId, shared.id)).status).toBe(200);
  });

  test.each([
    ['an existing conversation', 'sandbox', true],
    ['its own scoped conversation', 'own', true],
    ['no conversation id (auto-create)', 'sandbox', false],
  ])(
    'agent credential cannot post a user turn into %s',
    async (_label, agent, withId) => {
      const target = await createConversation(projectId);
      const before = (await getConversations(projectId)).length;
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-agent': agent === 'own' ? target.id : agent,
        },
        body: JSON.stringify({
          content: 'x',
          ...(withId ? { conversation_id: target.id } : {}),
        }),
      });
      expect(res.status).toBe(403);
      expect(await getChatMessages(projectId, 10, target.id)).toHaveLength(0);
      expect(await getConversations(projectId)).toHaveLength(before);
    },
  );

  test('agent credential cannot stop the project chat run', async () => {
    const res = await fetch(
      `${baseUrl}/api/projects/${projectId}/messages/stop`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-agent': 'sandbox',
        },
        body: '{}',
      },
    );
    expect(res.status).toBe(403);
  });

  test('denies handoff into a project where the caller is only a viewer', async () => {
    const source = await createConversation(projectId);
    const res = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${source.id}/handoff`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': editorId,
        },
        body: JSON.stringify({ destinationProjectId: destProjectId }),
      },
    );
    expect(res.status).toBe(403);
    expect(await getConversations(destProjectId)).toHaveLength(0);
  });

  test('has no assistant-message route for project-scoped agent tokens', async () => {
    const conversation = await createConversation(projectId);
    const token = await generateAgentToken({
      group_folder: projectId,
      task_id: 'conv-create-task',
    });
    const res = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversation.id}/assistant-message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: 'forged assistant turn' }),
      },
    );
    expect(res.status).toBe(404);
    const messages = await getChatMessages(projectId, 10, conversation.id);
    expect(messages).toHaveLength(0);
  });
});
