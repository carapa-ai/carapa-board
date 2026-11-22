import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConversation, initDatabase } from '../db.js';
import {
  createUser,
  upsertConversationMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import eventsRouter from './events.js';

const project = 'events-access-project';
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(`${project}@web`, {
    name: 'Events access project',
    folder: project,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'];
    (req as any).authUser =
      typeof id === 'string'
        ? { id, role: 'user' }
        : { id: 'events-admin', role: 'admin' };
    next();
  });
  app.use('/api', eventsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await unregisterGroup(`${project}@web`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST /events/shared_knowledge access', () => {
  test('denies chat-only users and admits explicit members', async () => {
    const implicit = await createUser('events-chat-only', 'pw-chat-only');
    const member = await createUser('events-viewer', 'pw-viewer');
    const conversation = await createConversation(project);
    await upsertConversationMember(implicit.id, conversation.id, 'viewer');
    await upsertProjectMember(member.id, project, 'editor');
    const viewer = await createUser('events-proj-viewer', 'pw-proj-viewer');
    await upsertProjectMember(viewer.id, project, 'viewer');

    const post = (userId: string) =>
      fetch(`${baseUrl}/api/events/shared_knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': userId },
        body: JSON.stringify({ project_id: project, content: 'note' }),
      });

    expect((await post(implicit.id)).status).toBe(403);
    // Past the access gate; no brain container is configured in tests.
    expect((await post(member.id)).status).toBe(503);
    // Viewers must not steer the brain.
    expect((await post(viewer.id)).status).toBe(403);
  });
});
