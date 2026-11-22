import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createUser, getUserById, initDatabase } from '../db.js';
import { upsertProjectMember } from '../modules/knowledge/db-kb.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import projectsRouter from './projects.js';

const pid = `deploy-service-route-${process.pid}`;
const jid = `${pid}@web`;
let server: Server;
let baseUrl: string;
const users: Record<string, string> = {};

async function setStored(deployService?: string) {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Deploy service route',
    folder: pid,
    trigger: '@deploy',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
      ...(deployService ? { deployService } : {}),
    },
  });
  await upsertProjectMember(users.owner!, pid, 'owner');
  await upsertProjectMember(users.editor!, pid, 'editor');
  await upsertProjectMember(users.viewer!, pid, 'viewer');
}

async function patch(
  who: 'admin' | 'owner' | 'editor' | 'viewer' | 'agent',
  settings: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}/projects/${pid}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-test-who': who,
    },
    body: JSON.stringify({ settings }),
  });
  return { status: response.status, body: await response.json() };
}

const stored = () => getGroupByFolder(pid)?.settings?.deployService;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  for (const [name, role] of [
    ['admin', 'admin'],
    ['owner', 'user'],
    ['editor', 'user'],
    ['viewer', 'user'],
  ] as const) {
    users[name] = (await createUser(`${pid}-${name}`, 'password', role)).id;
  }
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

describe('PATCH /projects/:pid deployService', () => {
  test('an admin session can set, change and clear the deploy service', async () => {
    await setStored();
    expect(
      (await patch('admin', { deployService: 'carapa-board' })).status,
    ).toBe(200);
    expect(stored()).toBe('carapa-board');
    expect(
      (await patch('admin', { deployService: 'carapa-wa-link' })).status,
    ).toBe(200);
    expect(stored()).toBe('carapa-wa-link');
    expect((await patch('admin', { deployService: null })).status).toBe(200);
    expect(stored()).toBeUndefined();
  });

  test('non-admin owners, editors, viewers and agent tokens cannot set or change it', async () => {
    for (const who of ['owner', 'editor', 'viewer', 'agent'] as const) {
      await setStored();
      const setRes = await patch(who, { deployService: 'carapa-board' });
      expect(setRes.status).toBe(403);
      expect(stored()).toBeUndefined();

      await setStored('carapa-wa-link');
      const changeRes = await patch(who, { deployService: 'carapa-board' });
      expect(changeRes.status).toBe(403);
      expect(stored()).toBe('carapa-wa-link');

      const clearRes = await patch(who, { deployService: null });
      expect(clearRes.status).toBe(403);
      expect(stored()).toBe('carapa-wa-link');
    }
    const ownerRes = await patch('owner', { deployService: 'carapa-board' });
    expect(ownerRes.body).toEqual({
      error: 'Only a board admin can change the deploy service',
    });
  });

  test('a non-admin owner can save other settings while deployService is unchanged', async () => {
    await setStored('carapa-board');
    const sameValue = await patch('owner', {
      deployService: 'carapa-board',
      gracefulDeploy: true,
    });
    expect(sameValue.status).toBe(200);
    expect(stored()).toBe('carapa-board');
    expect(getGroupByFolder(pid)?.settings?.gracefulDeploy).toBe(true);

    await setStored();
    expect(
      (await patch('owner', { deployService: '', gracefulDeploy: true }))
        .status,
    ).toBe(200);
    expect(stored()).toBeFalsy();
  });
});
