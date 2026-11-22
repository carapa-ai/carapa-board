import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createUser, getUserById, initDatabase } from '../db.js';
import {
  insertAiUserRow,
  insertAiUserTeamRow,
} from '../modules/ai-users/db-ai-users.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import projectsRouter from './projects.js';

const pid = `default-persona-route-${process.pid}`;
const jid = `${pid}@web`;
const now = '2026-08-01T00:00:00.000Z';
let server: Server;
let baseUrl: string;
let adminId: string;

async function addPersona(id: string, enabled: number) {
  await insertAiUserRow({
    id,
    name: id,
    presetId: 'fast',
    promptPath: `ai-users/${id}/prompt.md`,
    avatarPath: null,
    identity: id,
    turn: 'after',
    tools: [],
    enabled,
    createdAt: now,
    updatedAt: now,
  });
}

async function setStored(settings: Record<string, unknown>) {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Default persona route',
    folder: pid,
    trigger: '@persona',
    added_at: now,
    settings: { status: 'running', ...settings },
  });
}

async function patch(settings: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/projects/${pid}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { error?: string },
  };
}

const stored = () => getGroupByFolder(pid)?.settings;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${pid}-admin`, 'password', 'admin')).id;
  await addPersona('persona-active', 1);
  await addPersona('persona-disabled', 0);
  await insertAiUserTeamRow({
    id: 'team-active',
    name: 'Active',
    description: '',
    createdAt: now,
    updatedAt: now,
  });

  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    req.authUser = await getUserById(adminId);
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

describe('PATCH /projects/:pid default personas', () => {
  test('a stale stored default persona and invited ids do not block a resend', async () => {
    await setStored({
      defaultMainAiUserId: 'persona-disabled',
      defaultInvitedAiUserIds: ['persona-disabled', 'persona-gone'],
      defaultInvitedAiUserTeamIds: ['team-gone'],
    });
    const res = await patch({
      defaultMainAiUserId: 'persona-disabled',
      defaultInvitedAiUserIds: ['persona-disabled', 'persona-gone'],
      defaultInvitedAiUserTeamIds: ['team-gone'],
    });
    expect(res.status).toBe(200);
  });

  test('a cleaned resend removes the stale ids from stored settings', async () => {
    await setStored({
      defaultMainAiUserId: 'persona-disabled',
      defaultInvitedAiUserIds: ['persona-disabled'],
    });
    const res = await patch({
      defaultMainAiUserId: null,
      defaultInvitedAiUserIds: [],
    });
    expect(res.status).toBe(200);
    expect(stored()?.defaultMainAiUserId ?? null).toBeNull();
    expect(stored()?.defaultInvitedAiUserIds).toEqual([]);
  });

  test('newly setting a disabled or unknown persona is still rejected', async () => {
    await setStored({});
    for (const id of ['persona-disabled', 'persona-gone']) {
      const main = await patch({ defaultMainAiUserId: id });
      expect(main.status).toBe(400);
      expect(main.body.error).toBe(
        'defaultMainAiUserId must reference an enabled AI user',
      );
      const invited = await patch({
        defaultInvitedAiUserIds: ['persona-active', id],
      });
      expect(invited.status).toBe(400);
      expect(invited.body.error).toBe(
        'defaultInvitedAiUserIds must reference available AI users',
      );
    }
    const team = await patch({ defaultInvitedAiUserTeamIds: ['team-gone'] });
    expect(team.status).toBe(400);
    expect(stored()?.defaultMainAiUserId).toBeUndefined();
  });

  test('enabled personas and teams are accepted as new values', async () => {
    await setStored({});
    const res = await patch({
      defaultMainAiUserId: 'persona-active',
      defaultInvitedAiUserIds: ['persona-active'],
      defaultInvitedAiUserTeamIds: ['team-active'],
    });
    expect(res.status).toBe(200);
    expect(stored()?.defaultMainAiUserId).toBe('persona-active');
  });
});
