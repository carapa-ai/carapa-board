import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createUser, getUserById, initDatabase } from '../db.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import projectsRouter from './projects.js';

const pid = `enabled-modes-route-${process.pid}`;
const jid = `${pid}@web`;
let server: Server;
let baseUrl: string;
let adminId: string;

async function setStored(enabledModes?: string[]) {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Modes route',
    folder: pid,
    trigger: '@modes',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
      disableObservations: false,
      ...(enabledModes ? { enabledModes } : {}),
    },
  });
}

async function patch(settings: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/projects/${pid}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  return { status: response.status, body: await response.json() };
}

const stored = () => getGroupByFolder(pid)?.settings;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${pid}-admin`, 'password', 'admin')).id;
  await setStored(['kanban', 'chat']);

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

describe('PATCH /projects/:pid enabledModes', () => {
  test('rejects an empty list and leaves the settings unchanged', async () => {
    await setStored(['kanban', 'chat']);
    const res = await patch({ enabledModes: [], disableObservations: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'At least one mode must stay enabled' });
    expect(stored()?.enabledModes).toEqual(['kanban', 'chat']);
    expect(stored()?.disableObservations).toBe(false);
  });

  test('rejects a list with no mode the server offers', async () => {
    await setStored(['kanban']);
    const res = await patch({ enabledModes: ['unknown'] });
    expect(res.status).toBe(400);
    expect(stored()?.enabledModes).toEqual(['kanban']);
  });

  test('saves a non-empty list and unrelated fields without enabledModes', async () => {
    await setStored(['kanban', 'chat']);
    expect((await patch({ enabledModes: ['chat'] })).status).toBe(200);
    expect(stored()?.enabledModes).toEqual(['chat']);

    await setStored([]);
    expect((await patch({ disableObservations: true })).status).toBe(200);
    expect(stored()?.disableObservations).toBe(true);
    expect(stored()?.enabledModes).toEqual([]);
  });
});
