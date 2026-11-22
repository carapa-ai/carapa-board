import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { AI_USERS_DIR } from '../config.js';
import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { getRuntimeCatalog } from '../lib/chat-agents.js';
import { loadState } from '../state-manager.js';
import { aiUsersAdminRouter } from './ai-users.js';

const adminId = 'ai-user-name-cap-admin';
const presetId = 'ai-user-name-cap-preset';
const prompt = [
  '---',
  'identity: "Name cap persona"',
  'turn: after',
  'tools: []',
  '---',
  '',
  'Persona body.',
  '',
].join('\n');
const nameAtLimit = 'X'.repeat(120);
const secondNameAtLimit = 'Y'.repeat(120);
const nameOverLimit = 'X'.repeat(121);

let server: Server | undefined;
let baseUrl = '';
const createdIds: string[] = [];

function postAiUser(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/admin/ai-users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchAiUser(id: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/admin/ai-users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function listAiUsers() {
  const response = await fetch(`${baseUrl}/admin/ai-users`);
  return (await response.json()) as Array<{ id: string; name: string }>;
}

describe('admin AI user name length', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('${adminId}', '${adminId}', 'test', 'admin', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await loadState();

    const catalog = getRuntimeCatalog();
    if (!catalog.presets.some((preset) => preset.id === presetId))
      catalog.presets.push({
        id: presetId,
        label: 'Name cap preset',
        selection: { harnessId: 'direct', modelId: 'default' },
      });

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { id: adminId, username: adminId, role: 'admin' };
      next();
    });
    app.use(aiUsersAdminRouter);
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
    // Persona prompt files are written outside the in-memory database.
    for (const id of createdIds)
      await fs.rm(path.join(AI_USERS_DIR, id), {
        recursive: true,
        force: true,
      });
  });

  test('rejects a name longer than 120 characters and keeps shorter names', async () => {
    const tooLong = await postAiUser({
      name: nameOverLimit,
      presetId,
      prompt,
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({
      error: 'name must be at most 120 characters',
    });
    expect(
      (await listAiUsers()).some((user) => user.name === nameOverLimit),
    ).toBe(false);

    const atLimit = await postAiUser({
      name: nameAtLimit,
      presetId,
      prompt,
    });
    expect(atLimit.status).toBe(201);
    const created = (await atLimit.json()) as { id: string; name: string };
    createdIds.push(created.id);
    expect(created.name).toBe(nameAtLimit);

    const rejectedPatch = await patchAiUser(created.id, {
      name: nameOverLimit,
    });
    expect(rejectedPatch.status).toBe(400);
    expect(await rejectedPatch.json()).toEqual({
      error: 'name must be at most 120 characters',
    });
    const listed = (await listAiUsers()).find((user) => user.id === created.id);
    expect(listed?.name).toBe(nameAtLimit);

    const acceptedPatch = await patchAiUser(created.id, {
      name: secondNameAtLimit,
    });
    expect(acceptedPatch.status).toBe(200);
    expect(((await acceptedPatch.json()) as { name: string }).name).toBe(
      secondNameAtLimit,
    );
  });

  test('refuses the unpublished avatar candidate to non-admins', async () => {
    const memberApp = express();
    memberApp.use((req: any, _res, next) => {
      req.authUser = { id: 'member', username: 'member', role: 'user' };
      next();
    });
    memberApp.use(aiUsersAdminRouter);
    const memberServer = await new Promise<Server>((resolve) => {
      const started = memberApp.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const port = (memberServer.address() as AddressInfo).port;
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-users/any/avatar-candidate`,
      );
      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => memberServer.close(() => resolve()));
    }
  });
});
