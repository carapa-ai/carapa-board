/**
 * Tests for the cross-project move endpoint and the moveTaskToProject
 * DB helper. Covers: success path (status reset, deps filtered, branch
 * fields cleared), refusal cases (running, non-queue stage, branch set,
 * target equals source), and auth (non-owner).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';

import { initDatabase, createTask, createUser, getTask } from '../../db.js';
import { taskFixture, truncateTestDb, runFixture } from '../../test-helpers.js';
import { GROUPS_DIR } from '../../config.js';
import { moveTaskToProject } from './db-kanban.js';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { tasks } from '../../db/schema.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module('../../index.js', () => ({
  registeredGroups: {},
  updateGroup: mock(() => {}),
  getGroupByFolder: mock(() => undefined),
  getGroupEntryByFolder: mock(() => undefined),
}));

mock.module('../objectives/ws-events.js', () => ({
  broadcast: mock(() => {}),
}));

// ─── Dynamic router import (after mocks) ──────────────────────────────────────

const { default: tasksRouter } = await import('../../routes/tasks.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SRC = 'move-src-project';
const TGT = 'move-tgt-project';

let server: Server;
let baseUrl: string;

function makeGroup(
  opts: {
    folder: string;
    ownerId?: string | null;
    isMain?: boolean;
    enabledModes?: string[];
  } = { folder: 'default' },
) {
  return {
    folder: opts.folder,
    user_id: opts.ownerId ?? null,
    is_main: opts.isMain ? 1 : 0,
    settings: {
      enabledModes: opts.enabledModes ?? ['kanban', 'chat'],
      stages: [
        { id: 'backlog', title: 'Backlog', type: 'queue' },
        { id: 'in_progress', title: 'In Progress', type: 'active' },
        { id: 'completed', title: 'Completed', type: 'done' },
      ],
    },
  };
}

let srcGroup: any = makeGroup({ folder: SRC, ownerId: 'user-1' });
let tgtGroup: any = makeGroup({ folder: TGT, ownerId: 'user-1' });

mock.module('../../state-manager.js', () => ({
  getGroupByFolder: mock((folder: string) => {
    if (folder === SRC) return srcGroup;
    if (folder === TGT) return tgtGroup;
    return undefined;
  }),
  getGroupEntryByFolder: mock(() => undefined),
  updateGroup: mock(() => {}),
}));

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Fake auth: every request is the user with id 'user-1' and role 'user'.
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'user-1', role: 'user' };
    next();
  });
  app.use('/api', tasksRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
  for (const folder of [SRC, TGT]) {
    try {
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  }
});

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
});

async function apiPost(urlPath: string, body: unknown) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Seed a dependency edge directly on the task row, bypassing the guarded
 * createTask/updateTask write paths. The move flow under test operates on
 * edges that can cross projects (they are filtered to the target project at
 * move time); since the shared write guard now rejects foreign-project
 * edges, these fixtures are seeded at the DB level instead.
 */
async function seedDependencyEdge(
  taskId: string,
  dependsOnIds: string[],
): Promise<void> {
  await drizzleDbRef.current
    .update(tasks)
    .set({ depends_on_ids: JSON.stringify(dependsOnIds) })
    .where(eq(tasks.id, taskId));
}

// ─── moveTaskToProject DB helper ──────────────────────────────────────────────

describe('moveTaskToProject (DB helper)', () => {
  test('updates project_id, status, depends_on_ids and clears branch fields', async () => {
    const owner = await createUser('move-task-owner', 'pw', 'user');
    const dep = await createTask(
      taskFixture({ project_id: TGT, title: 'Target dep' }),
    );
    const task = await createTask(
      taskFixture({
        project_id: SRC,
        title: 'Move me',
        branch_name: 'feature/branch',
        worktree_path: '/tmp/some-worktree',
        sandbox_instance: 'sandbox-1',
        merge_commit: 'abc1234',
        ownerUserId: owner.id,
        lastTriggeredByUserId: owner.id,
        lastTriggerSource: 'user',
      }),
    );
    // `dep` lives in TGT, so the shared write guard now rejects this edge;
    // seed it at the DB level to exercise the move's dep filtering.
    await seedDependencyEdge(task.id, [dep.id, 'stale-id-not-in-target']);
    const moved = await moveTaskToProject(task.id, TGT, 'backlog', [dep.id]);
    expect(moved).toBeDefined();
    const updated = moved!.task;
    expect(moved!.releasedDependentIds).toEqual([]);
    expect(updated.project_id).toBe(TGT);
    expect(updated.status).toBe('backlog');
    expect(updated.depends_on_ids).toEqual([dep.id]);
    expect(updated.branch_name).toBeNull();
    expect(updated.worktree_path).toBeNull();
    expect(updated.sandbox_instance).toBeNull();
    expect(updated.merge_commit).toBeNull();
    expect(updated.owner).toMatchObject({
      id: owner.id,
      username: owner.username,
    });
    expect(updated.latestTrigger).toMatchObject({
      user: { id: owner.id, username: owner.username },
      source: 'user',
    });
  });

  test('drops the moved task id from source-project dependents only', async () => {
    const a = await createTask(taskFixture({ project_id: SRC, title: 'A' }));
    const b = await createTask(taskFixture({ project_id: SRC, title: 'B' }));
    const c = await createTask(taskFixture({ project_id: SRC, title: 'C' }));
    const d = await createTask(taskFixture({ project_id: SRC, title: 'D' }));
    const e = await createTask(taskFixture({ project_id: SRC, title: 'E' }));
    await seedDependencyEdge(c.id, [a.id, b.id]);
    await seedDependencyEdge(d.id, [b.id]);
    // Shares a prefix with B's id but is a different id, so must be kept.
    const lookalike = `${b.id}x`;
    await seedDependencyEdge(e.id, [lookalike]);

    const moved = await moveTaskToProject(b.id, TGT, 'backlog', []);

    expect(moved!.task.project_id).toBe(TGT);
    expect(moved!.releasedDependentIds).toHaveLength(2);
    expect(moved!.releasedDependentIds).toEqual(
      expect.arrayContaining([c.id, d.id]),
    );
    expect((await getTask(c.id))!.depends_on_ids).toEqual([a.id]);
    const dAfter = (await getTask(d.id))!.depends_on_ids;
    expect(dAfter == null || dAfter.length === 0).toBe(true);
    expect((await getTask(e.id))!.depends_on_ids).toEqual([lookalike]);
  });
});

// ─── POST /api/projects/:pid/tasks/:fid/move ──────────────────────────────────

describe('POST /api/projects/:pid/tasks/:fid/move', () => {
  test('moves a backlog task to target project and resets status', async () => {
    const task = await createTask(
      taskFixture({ project_id: SRC, title: 'Move me', status: 'backlog' }),
    );
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      project_id: string;
      status: string;
    };
    expect(body.id).toBe(task.id);
    expect(body.project_id).toBe(TGT);
    expect(body.status).toBe('backlog');
  });

  test('drops depends_on_ids that are not in the target project', async () => {
    const otherTargetDep = await createTask(
      taskFixture({ project_id: TGT, title: 'Kept' }),
    );
    const orphanDep = await createTask(
      taskFixture({ project_id: SRC, title: 'Dropped' }),
    );
    const task = await createTask(taskFixture({ project_id: SRC }));
    // `otherTargetDep` lives in TGT, so the shared write guard now rejects
    // this edge at creation; seed it at the DB level to exercise the move's
    // dep filtering (kept deps present in target, dropped deps absent).
    await seedDependencyEdge(task.id, [otherTargetDep.id, orphanDep.id]);
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { depends_on_ids: string[] };
    expect(body.depends_on_ids).toEqual([otherTargetDep.id]);
  });

  test('refuses to move a task that still has a branch', async () => {
    const task = await createTask(
      taskFixture({
        project_id: SRC,
        status: 'backlog',
        branch_name: 'feat/x',
        worktree_path: '/tmp/x',
        sandbox_instance: 'sbx-1',
      }),
    );
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    // Source has branch set — must refuse.
    expect(res.status).toBe(409);
  });

  test('refuses when source task is in an active stage', async () => {
    const task = await createTask(
      taskFixture({ project_id: SRC, status: 'in_progress' }),
    );
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/queue/i);
  });

  test('refuses when source task has an active run', async () => {
    const task = await createTask(taskFixture({ project_id: SRC }));
    const run = runFixture({ task_id: task.id, status: 'running' });
    await createTask(taskFixture({ project_id: SRC }));
    // Insert active run
    const { insertActiveRun } = await import('../../db.js');
    await insertActiveRun(run);

    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/running/i);
  });

  test('refuses when target project does not exist', async () => {
    const task = await createTask(taskFixture({ project_id: SRC }));
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: 'no-such-target',
    });
    expect(res.status).toBe(404);
  });

  test('refuses when target has kanban mode disabled', async () => {
    tgtGroup = makeGroup({
      folder: TGT,
      ownerId: 'user-1',
      enabledModes: ['chat'],
    });
    const task = await createTask(taskFixture({ project_id: SRC }));
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/kanban/i);
    // Reset for subsequent tests
    tgtGroup = makeGroup({ folder: TGT, ownerId: 'user-1' });
  });

  test('refuses 403 when caller does not own source project', async () => {
    // srcGroup owner is 'user-2' but authUser.id is 'user-1'
    srcGroup = makeGroup({ folder: SRC, ownerId: 'user-2' });
    const task = await createTask(taskFixture({ project_id: SRC }));
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(403);
    // Reset for subsequent tests
    srcGroup = makeGroup({ folder: SRC, ownerId: 'user-1' });
  });

  test('refuses 403 when caller does not own target project', async () => {
    srcGroup = makeGroup({ folder: SRC, ownerId: 'user-1' });
    tgtGroup = makeGroup({ folder: TGT, ownerId: 'user-2' });
    const task = await createTask(taskFixture({ project_id: SRC }));
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(403);
    tgtGroup = makeGroup({ folder: TGT, ownerId: 'user-1' });
  });

  test('agent credential cannot move a task (403) even between ownerless projects', async () => {
    srcGroup = makeGroup({ folder: SRC, ownerId: null });
    tgtGroup = makeGroup({ folder: TGT, ownerId: null });
    const task = await createTask(taskFixture({ project_id: SRC }));
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req: any, _res, next) => {
      req.authCredentialKind = 'agent';
      req.tokenScope = { kind: 'project' };
      next();
    });
    agentApp.use('/api', tasksRouter);
    const agentServer = agentApp.listen(0, '127.0.0.1');
    const agentBase = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/api`;
    try {
      const res = await fetch(
        `${agentBase}/projects/${SRC}/tasks/${task.id}/move`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_project_id: TGT }),
        },
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        'Agents cannot move tasks between projects',
      );
      expect((await getTask(task.id))?.project_id).toBe(SRC);
    } finally {
      agentServer.close();
      srcGroup = makeGroup({ folder: SRC, ownerId: 'user-1' });
      tgtGroup = makeGroup({ folder: TGT, ownerId: 'user-1' });
    }
  });

  test('admin caller moves across ownerless projects but not those owned by another user', async () => {
    const task = await createTask(taskFixture({ project_id: SRC }));
    // Re-launch the app with admin auth to avoid test contamination.
    const adminApp = express();
    adminApp.use(express.json());
    adminApp.use((req: any, _res, next) => {
      req.authUser = { id: 'admin-1', role: 'admin' };
      next();
    });
    adminApp.use('/api', tasksRouter);
    const adminServer = adminApp.listen(0, '127.0.0.1');
    const adminBase = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}/api`;
    const move = () =>
      fetch(`${adminBase}/projects/${SRC}/tasks/${task.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_project_id: TGT }),
      });
    try {
      srcGroup = makeGroup({ folder: SRC, ownerId: 'user-2' });
      tgtGroup = makeGroup({ folder: TGT, ownerId: 'user-2' });
      expect((await move()).status).toBe(403);
      // Only the target is owned by another user.
      srcGroup = makeGroup({ folder: SRC });
      expect((await move()).status).toBe(403);
      expect((await getTask(task.id))?.project_id).toBe(SRC);
      tgtGroup = makeGroup({ folder: TGT });
      expect((await move()).status).toBe(200);
    } finally {
      adminServer.close();
      srcGroup = makeGroup({ folder: SRC, ownerId: 'user-1' });
      tgtGroup = makeGroup({ folder: TGT, ownerId: 'user-1' });
    }
  });

  test('returns 404 when source task is not in source project', async () => {
    const task = await createTask(taskFixture({ project_id: TGT }));
    const res = await apiPost(`/projects/${SRC}/tasks/${task.id}/move`, {
      target_project_id: TGT,
    });
    expect(res.status).toBe(404);
  });
});
