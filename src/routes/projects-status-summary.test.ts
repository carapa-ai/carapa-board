import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createTask, createUser, initDatabase, updateTask } from '../db.js';
import { recordBrainAuthResult } from '../modules/objectives/brain-client.js';
import {
  _testOnlyRegisterRunning,
  releaseTaskExecutionClaim,
} from '../modules/kanban/task/pipeline.js';
import {
  loadState,
  registerGroup,
  registeredGroups,
  unregisterGroup,
} from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import projectsRouter, { getVisibleStatusProjectIds } from './projects.js';

function group(
  folder: string,
  userId: string,
  isMain = false,
): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '!',
    added_at: '2026-08-26T10:00:00.000Z',
    user_id: userId,
    is_main: isMain,
  };
}

describe('status-summary project access filter', () => {
  test('keeps owned and shared projects while excluding foreign and foreign-main projects', () => {
    const userId = 'status-route-viewer';
    const groups = {
      owned: group('owned', userId),
      explicit: group('explicit', 'other-user'),
      implicit: group('implicit', 'other-user'),
      foreign: group('foreign', 'other-user'),
      ownMain: group('own-main', userId, true),
      foreignMain: group('foreign-main', 'other-user', true),
    };

    expect(
      [
        ...getVisibleStatusProjectIds(
          userId,
          ['explicit'],
          ['implicit'],
          groups,
        ),
      ].sort(),
    ).toEqual(['explicit', 'implicit', 'own-main', 'owned']);
  });
});

describe('GET /projects/status-summary in-memory Kanban merge', () => {
  const folder = `status-route-running-${process.pid}`;
  const jid = `${folder}@web`;
  let server: Server;
  let baseUrl: string;
  let userId: string;

  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    const user = await createUser(
      `status-route-running-${process.pid}`,
      'password',
    );
    userId = user.id;
    await registerGroup(jid, {
      jid,
      name: 'Status route running project',
      folder,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: userId,
    });

    const app = express();
    app.use((req, _res, next) => {
      // Other route suites reload the shared registry in the changed-files
      // runner. Restore this request's owned project at the HTTP boundary.
      registeredGroups[jid] ??= group(folder, userId);
      Object.assign(req, { authUser: { id: userId, role: 'user' } });
      next();
    });
    app.use(projectsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await unregisterGroup(jid);
  });

  test('ignores an archived task that remains in the executor running map', async () => {
    const task = await createTask({
      project_id: folder,
      title: 'Archived while running',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const abort = _testOnlyRegisterRunning(task.id, folder);

    try {
      await updateTask(task.id, { archived: true });
      const response = await fetch(`${baseUrl}/projects/status-summary`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        projects: {
          [folder]: {
            kanban: 'idle',
            chat: 'idle',
            objectives: 'idle',
          },
        },
      });
    } finally {
      releaseTaskExecutionClaim(task.id, abort);
    }
  });

  test('still reports an unarchived in-memory task as working', async () => {
    const task = await createTask({
      project_id: folder,
      title: 'Live running task',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const abort = _testOnlyRegisterRunning(task.id, folder);

    try {
      const response = await fetch(`${baseUrl}/projects/status-summary`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        projects: { [folder]: { kanban: 'working' } },
      });
    } finally {
      releaseTaskExecutionClaim(task.id, abort);
    }
  });
});

describe('GET /projects brainAuthRejected', () => {
  const folder = `brain-auth-route-${process.pid}`;
  const jid = `${folder}@web`;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    const user = await createUser(
      `brain-auth-route-${process.pid}`,
      'password',
    );
    const owned = {
      jid,
      ...group(folder, user.id),
      settings: { brainContainer: 'brain', brainAuthToken: 'stored-token' },
    };
    await registerGroup(jid, owned);
    const app = express();
    app.use((req, _res, next) => {
      registeredGroups[jid] ??= owned;
      Object.assign(req, { authUser: { id: user.id, role: 'user' } });
      next();
    });
    app.use(projectsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await unregisterGroup(jid);
  });

  async function settings() {
    const response = await fetch(`${baseUrl}/projects`);
    const projects = (await response.json()) as Array<{
      id: string;
      settings: Record<string, unknown>;
    }>;
    return projects.find((project) => project.id === folder)!.settings;
  }

  test('reports the brain rejection until a later success clears it', async () => {
    expect((await settings()).brainAuthRejected).toBeNull();

    const at = '2026-10-17T02:47:04.000Z';
    recordBrainAuthResult(folder, { ok: false, status: 403, at });
    const rejected = await settings();
    expect(rejected.brainAuthRejected).toEqual({ status: 403, at });
    expect(rejected).not.toHaveProperty('brainAuthToken');

    recordBrainAuthResult(folder, { ok: true, at: new Date().toISOString() });
    expect((await settings()).brainAuthRejected).toBeNull();
  });
});
