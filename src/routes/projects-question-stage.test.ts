import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createUser, getUserById, initDatabase } from '../db.js';
import type { StageDefinition } from '../modules/kanban/types.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import projectsRouter from './projects.js';

const pid = `question-stage-route-${process.pid}`;
const jid = `${pid}@web`;
let server: Server;
let baseUrl: string;
let adminId: string;

// Legacy config trap: an active done-type Question column ahead of Completed.
const LEGACY_STAGES: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#8B8FA3' },
  { id: 'question', title: 'Question', type: 'done', color: '#F59E02' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#22C55E' },
];

async function setStored(stages?: StageDefinition[]) {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Question stage route',
    folder: pid,
    trigger: '@question-stage',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
      disableObservations: false,
      enabledModes: ['kanban', 'chat'],
      ...(stages ? { stages } : {}),
    },
  });
}

async function patch(settings: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/projects/${pid}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const stored = () => getGroupByFolder(pid)?.settings;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${pid}-admin`, 'password', 'admin')).id;
  await setStored();

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

describe('PATCH /projects/:pid Question stage type rule', () => {
  test('rejects a save that sends stages with an active done-type Question', async () => {
    await setStored();
    const res = await patch({ stages: LEGACY_STAGES });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid stages: /);
    expect(res.body.error).toMatch(/must be a queue stage/);
    expect(stored()?.stages).toBeUndefined();
  });

  test('allows a settings save without stages when stored stages are legacy', async () => {
    await setStored(LEGACY_STAGES);
    const res = await patch({ enabledModes: ['kanban', 'chat'] });
    expect(res.status).toBe(200);
    expect(stored()?.enabledModes).toEqual(['kanban', 'chat']);
    expect(stored()?.stages).toEqual(LEGACY_STAGES);
  });
});
