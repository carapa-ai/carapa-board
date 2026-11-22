import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'node:fs';
import path from 'node:path';

import {
  claimNormalTaskAdmission,
  completeActiveRun,
  commitProjectStageMigration,
  createConversation,
  createTask,
  getActiveRunById,
  getTask,
  initDatabase,
  insertActiveRun,
  releaseTaskAdmission,
  updateTask,
} from './db.js';
import { getBoardReplay } from './modules/kanban/board-replay.js';
import { runFixture, taskFixture, truncateTestDb } from './test-helpers.js';
import { projects } from './db/schema.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import {
  getGroupByFolder,
  getGroupEntryByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
  updateGroup,
} from './state-manager.js';
import { getGroupDir, setGroupLookup } from './group-dir.js';
import { getSandboxClient } from './lib/mcp-client.js';
import {
  createObjective,
  getObjective,
} from './modules/objectives/db-objectives.js';
import { readPrompt, writePrompt } from './routes/_helpers.js';
import {
  claimTaskExecution,
  drainProjectQueue,
  executeTask,
  releaseTaskExecutionClaim,
  setGroupResolver,
} from './modules/kanban/task-executor.js';
import projectsRouter, {
  setProjectQueueDrainRunnerForTests,
  setStageMigrationTaskUpdatedEmitterForTests,
} from './routes/projects.js';
import type { StageDefinition } from './modules/kanban/types.js';

import { eq } from 'drizzle-orm';
const folder = `route-stage-guard-${process.pid}`;
const jid = `${folder}@web`;
const legacyStages: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888888' },
  { id: 'legacy', title: 'Legacy', type: 'active', color: '#3366ff' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#22aa55' },
];
const replacementStages: StageDefinition[] = [
  legacyStages[0],
  { id: 'coding', title: 'Coding', type: 'active', color: '#3366ff' },
  legacyStages[2],
];

let server: Server;
let baseUrl: string;

async function patchProject(body: unknown) {
  return fetch(`${baseUrl}/projects/${folder}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  const app = express();
  app.use(express.json());
  // Reparenting requires an authenticated manager of the project.
  app.use((req, _res, next) => {
    Object.assign(req, {
      authUser: { id: 'stage-guard-admin', role: 'admin' },
    });
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateTestDb();
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Stage guard route test',
    folder,
    trigger: '@stage-guard',
    added_at: new Date().toISOString(),
    settings: { status: 'running', stages: legacyStages },
  });
  await writePrompt(folder, undefined, 'stage-legacy.md', 'Original prompt');
});

afterAll(() => {
  setProjectQueueDrainRunnerForTests(undefined);
  setStageMigrationTaskUpdatedEmitterForTests(undefined);
  server.close();
  void unregisterGroup(jid);
  fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
});

describe('PATCH /projects/:pid stage orphan guard', () => {
  test('migrates active and archived cards while preserving archive state', async () => {
    const active = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const archived = await createTask(
      taskFixture({ project_id: folder, status: 'legacy', archived: true }),
    );
    const emitted: string[] = [];
    setStageMigrationTaskUpdatedEmitterForTests((changed) => {
      emitted.push((changed as { id: string }).id);
    });
    const accepted = await patchProject({
      settings: { stages: replacementStages },
      stageMigrations: [
        { sourceStageId: 'legacy', destinationStageId: 'coding' },
      ],
    });
    expect(accepted.status).toBe(200);
    expect((await getTask(active.id))?.status).toBe('coding');
    expect((await getTask(archived.id))?.status).toBe('coding');
    expect((await getTask(archived.id))?.archived).toBe(true);
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(
      replacementStages,
    );
    expect(emitted).toEqual(expect.arrayContaining([active.id, archived.id]));
    const replay = await getBoardReplay(
      folder,
      new Date(0).toISOString(),
      new Date(Date.now() + 1000).toISOString(),
    );
    expect(
      replay.events
        .filter((event) => event.event_type === 'updated')
        .map((event) => event.task_id),
    ).toEqual(expect.arrayContaining([active.id, archived.id]));
  });

  test('rejects an empty stage ID naming the raw id, never "[object Object]"', async () => {
    const res = await patchProject({
      settings: { stages: [{ ...replacementStages[0], id: '' }] },
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe('Invalid stage ID ""');
    expect(error).not.toContain('[object Object]');
  });

  test('rechecks occupancy at the commit boundary and emits task updates after commit', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const events: string[] = [];
    setStageMigrationTaskUpdatedEmitterForTests((changed) => {
      events.push((changed as { id: string }).id);
    });
    const committed = await commitProjectStageMigration(
      folder,
      JSON.stringify({ stages: replacementStages }),
      [{ sourceStageId: 'legacy', destinationStageId: 'coding' }],
      ['legacy'],
    );
    expect(committed.map((changed) => changed.id)).toEqual([task.id]);
    // The route emitter is deliberately only called after the transaction;
    // this direct boundary test proves the transaction returns changed rows
    // for the route to broadcast.
    expect(events).toEqual([]);
    expect((await getTask(task.id))?.status).toBe('coding');
  });

  test('rejects newly occupied unmapped stages during the commit recheck', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    await expect(
      commitProjectStageMigration(
        folder,
        JSON.stringify({ stages: replacementStages }),
        [],
        ['legacy'],
      ),
    ).rejects.toThrow('Cannot remove occupied stages');
    expect((await getTask(task.id))?.status).toBe('legacy');
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
  });

  test('rejects stale task writes after a guarded stage removal commits', async () => {
    await commitProjectStageMigration(
      folder,
      JSON.stringify({ stages: replacementStages }),
      [],
      ['legacy'],
    );

    await expect(
      createTask(taskFixture({ project_id: folder, status: 'legacy' })),
    ).rejects.toMatchObject({
      name: 'TaskStageWriteConflictError',
      statusCode: 409,
    });

    const task = await createTask(
      taskFixture({ project_id: folder, status: 'coding' }),
    );
    await expect(
      updateTask(task.id, { status: 'legacy' }),
    ).rejects.toMatchObject({
      name: 'TaskStageWriteConflictError',
      statusCode: 409,
    });
    expect((await getTask(task.id))?.status).toBe('coding');
  });

  test('rejects stale writes after resetting a root project to default stages', async () => {
    await commitProjectStageMigration(
      folder,
      JSON.stringify({
        stages: [legacyStages[0], legacyStages[1], legacyStages[2]],
      }),
      [],
      [],
    );
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );

    await commitProjectStageMigration(
      folder,
      JSON.stringify({ stages: [] }),
      [{ sourceStageId: 'legacy', destinationStageId: 'backlog' }],
      ['legacy'],
    );

    await expect(
      updateTask(task.id, { status: 'legacy' }),
    ).rejects.toMatchObject({
      name: 'TaskStageWriteConflictError',
      statusCode: 409,
    });
    expect((await getTask(task.id))?.status).toBe('backlog');
  });

  test('persists parent inheritance with the guarded migration', async () => {
    const parentFolder = `${folder}-parent`;
    const parentJid = `${parentFolder}@web`;
    await registerGroup(parentJid, {
      jid: parentJid,
      name: 'Stage guard parent',
      folder: parentFolder,
      trigger: '@stage-parent',
      added_at: new Date().toISOString(),
      settings: { stages: replacementStages },
    });
    try {
      await updateGroup(jid, {
        parentId: parentFolder,
        settings: { stages: legacyStages },
      });
      const task = await createTask(
        taskFixture({ project_id: folder, status: 'legacy' }),
      );

      await commitProjectStageMigration(
        folder,
        JSON.stringify({ stages: [] }),
        [{ sourceStageId: 'legacy', destinationStageId: 'coding' }],
        ['legacy'],
        parentFolder,
      );

      await expect(
        updateTask(task.id, { status: 'legacy' }),
      ).rejects.toMatchObject({
        name: 'TaskStageWriteConflictError',
        statusCode: 409,
      });
      expect((await getTask(task.id))?.status).toBe('coding');
    } finally {
      await unregisterGroup(parentJid);
    }
  });

  test('executes parent-only inheritance migrations without a settings object', async () => {
    const oldParentFolder = `${folder}-old-parent`;
    const newParentFolder = `${folder}-new-parent`;
    const oldParentJid = `${oldParentFolder}@web`;
    const newParentJid = `${newParentFolder}@web`;
    await registerGroup(oldParentJid, {
      jid: oldParentJid,
      name: 'Stage guard old parent',
      folder: oldParentFolder,
      trigger: '@stage-old-parent',
      added_at: new Date().toISOString(),
      settings: { stages: legacyStages },
    });
    await registerGroup(newParentJid, {
      jid: newParentJid,
      name: 'Stage guard new parent',
      folder: newParentFolder,
      trigger: '@stage-new-parent',
      added_at: new Date().toISOString(),
      settings: { stages: replacementStages },
    });
    // A parent change asks CarapaBox which sandboxes are up; none are.
    const sandboxClient = getSandboxClient() as any;
    const originalSandboxPs = sandboxClient.sandboxPs;
    sandboxClient.sandboxPs = async () => ({ stdout: '[]', isError: false });
    try {
      await updateGroup(jid, { parentId: oldParentFolder, settings: {} });
      const task = await createTask(
        taskFixture({ project_id: folder, status: 'legacy' }),
      );

      const response = await patchProject({
        parentId: newParentFolder,
        stageMigrations: [
          { sourceStageId: 'legacy', destinationStageId: 'coding' },
        ],
      });
      expect(response.status).toBe(200);
      expect((await getTask(task.id))?.status).toBe('coding');
      expect(getGroupByFolder(folder)?.parentId).toBe(newParentFolder);
    } finally {
      sandboxClient.sandboxPs = originalSandboxPs;
      await unregisterGroup(oldParentJid);
      await unregisterGroup(newParentJid);
    }
  });

  test('derived objective directories follow the sandbox mount, not the mere presence of a parent', async () => {
    const plain = `${folder}-wd-plain`;
    const shared = `${folder}-wd-shared`;
    const groupsToClean: string[] = [];
    for (const [name, settings] of [
      [plain, { stages: legacyStages }],
      [
        shared,
        {
          stages: legacyStages,
          isParent: true,
          sandboxOwnership: 'shared' as const,
        },
      ],
    ] as const) {
      groupsToClean.push(`${name}@web`);
      await registerGroup(`${name}@web`, {
        jid: `${name}@web`,
        name,
        folder: name,
        trigger: `@${name}`,
        added_at: new Date().toISOString(),
        settings,
      });
    }
    const sandboxClient = getSandboxClient() as any;
    const originalSandboxPs = sandboxClient.sandboxPs;
    sandboxClient.sandboxPs = async () => ({ stdout: '[]', isError: false });
    try {
      const make = (title: string, work_dir: string | null) =>
        createObjective({
          project_id: folder,
          title,
          status: 'draft',
          priority: 0,
          progress: 0,
          description: '',
          deadline: null,
          metadata: undefined,
          trigger_config: undefined,
          eventRuntimeSelection: null,
          work_dir,
        } as any);
      const flat = (id: string) => `/workspace/group/objectives/${id}`;
      const nested = (id: string) =>
        `/workspace/group/${folder}/objectives/${id}`;
      const derived = await make('derived', null);
      const custom = await make('custom', '/somewhere/else');
      const { drizzleDbRef: db } = await import('./db/drizzle-client.js');
      const { objectives } = await import('./db/schema.js');
      await db.current
        .update(objectives)
        .set({ work_dir: flat(derived.id) })
        .where(eq(objectives.id, derived.id));
      const workDir = async () => (await getObjective(derived.id))?.work_dir;

      // A parent that does not own the sandbox: the project keeps its own
      // sandbox and mounts its directory directly at /workspace/group.
      expect((await patchProject({ parentId: plain })).status).toBe(200);
      expect(await workDir()).toBe(flat(derived.id));
      // A shared parent mounts its whole tree: the project sits below it.
      expect((await patchProject({ parentId: shared })).status).toBe(200);
      expect(await workDir()).toBe(nested(derived.id));
      expect((await patchProject({ parentId: plain })).status).toBe(200);
      expect(await workDir()).toBe(flat(derived.id));
      expect((await patchProject({ parentId: null })).status).toBe(200);
      expect(await workDir()).toBe(flat(derived.id));
      // A custom directory is never rewritten.
      expect((await patchProject({ parentId: shared })).status).toBe(200);
      expect((await getObjective(custom.id))?.work_dir).toBe('/somewhere/else');
    } finally {
      sandboxClient.sandboxPs = originalSandboxPs;
      for (const j of groupsToClean) await unregisterGroup(j);
    }
  });

  test('a PATCH that repeats the current parent cannot undo a move that finished meanwhile', async () => {
    const parentX = `${folder}-rx`;
    const parentY = `${folder}-ry`;
    const jids = [parentX, parentY].map((f) => `${f}@web`);
    for (const [index, parentFolder] of [parentX, parentY].entries()) {
      await registerGroup(jids[index], {
        jid: jids[index],
        name: parentFolder,
        folder: parentFolder,
        trigger: `@${parentFolder}`,
        added_at: new Date().toISOString(),
        settings: { stages: legacyStages },
      });
    }
    const sandboxClient = getSandboxClient() as any;
    const originalSandboxPs = sandboxClient.sandboxPs;
    sandboxClient.sandboxPs = async () => ({ stdout: '[]', isError: false });
    const realDb = drizzleDbRef.current;
    let armed = false;
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => (reachedCommit = resolve));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    // Holds the first database transaction after arming: the save of the
    // request that already read the (soon to be stale) parent.
    drizzleDbRef.current = new Proxy(realDb, {
      get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return async (...args: unknown[]) => {
          if (armed) {
            armed = false;
            reachedCommit();
            await gate;
          }
          return (target as any).transaction(...args);
        };
      },
    });
    // As in the server: a child's directory is derived from its parent.
    setGroupLookup(getGroupByFolder);
    try {
      await updateGroup(jid, { parentId: parentX, settings: {} });
      fs.mkdirSync(getGroupDir(folder), { recursive: true });
      fs.writeFileSync(path.join(getGroupDir(folder), 'marker.txt'), 'data');

      armed = true;
      const repeat = patchProject({ parentId: parentX });
      await atCommit;
      const move = patchProject({ parentId: parentY });
      // Unserialized, the move finishes while the first request is held.
      for (
        let turns = 0;
        turns < 500 && getGroupByFolder(folder)?.parentId !== parentY;
        turns++
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      openGate();
      const [first, second] = await Promise.all([repeat, move]);

      expect([first.status, second.status]).toEqual([200, 200]);
      const parent = getGroupByFolder(folder)?.parentId;
      // Files and parent agree, whichever request won.
      expect(fs.existsSync(path.join(getGroupDir(folder), 'marker.txt'))).toBe(
        true,
      );
      expect(parent).toBe(parentY);
    } finally {
      setGroupLookup(() => undefined);
      drizzleDbRef.current = realDb;
      sandboxClient.sandboxPs = originalSandboxPs;
      for (const j of jids) await unregisterGroup(j);
    }
  });

  test('a folder rename queued behind a parent change renames the directory where it is now', async () => {
    const parentX = `${folder}-nx`;
    const parentY = `${folder}-ny`;
    const renamed = `${folder}-renamed`;
    const jids = [parentX, parentY].map((f) => `${f}@web`);
    for (const [index, parentFolder] of [parentX, parentY].entries()) {
      await registerGroup(jids[index], {
        jid: jids[index],
        name: parentFolder,
        folder: parentFolder,
        trigger: `@${parentFolder}`,
        added_at: new Date().toISOString(),
        settings: { stages: legacyStages },
      });
    }
    const sandboxClient = getSandboxClient() as any;
    const originalSandboxPs = sandboxClient.sandboxPs;
    sandboxClient.sandboxPs = async () => ({ stdout: '[]', isError: false });
    const realDb = drizzleDbRef.current;
    let armed = false;
    let reachedCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => (reachedCommit = resolve));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    // Holds the parent change at its save, while it owns the reparent mutex.
    drizzleDbRef.current = new Proxy(realDb, {
      get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return async (...args: unknown[]) => {
          if (armed) {
            armed = false;
            reachedCommit();
            await gate;
          }
          return (target as any).transaction(...args);
        };
      },
    });
    // As in the server: a child's directory is derived from its parent.
    setGroupLookup(getGroupByFolder);
    try {
      await updateGroup(jid, { parentId: parentX, settings: {} });
      fs.mkdirSync(getGroupDir(folder), { recursive: true });
      fs.writeFileSync(path.join(getGroupDir(folder), 'marker.txt'), 'data');

      armed = true;
      const move = patchProject({ parentId: parentY });
      await atCommit;
      // Worked out from the directory as it is before the move finishes.
      const rename = patchProject({ folder: renamed });
      for (let turns = 0; turns < 200; turns++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      openGate();
      const [moved, renameResponse] = await Promise.all([move, rename]);

      expect(moved.status).toBe(200);
      expect(renameResponse.status).toBe(200);
      // The data went with the rename instead of being orphaned.
      expect(fs.existsSync(path.join(getGroupDir(renamed), 'marker.txt'))).toBe(
        true,
      );
    } finally {
      setGroupLookup(() => undefined);
      drizzleDbRef.current = realDb;
      sandboxClient.sandboxPs = originalSandboxPs;
      for (const j of jids) await unregisterGroup(j);
      const entry = getGroupEntryByFolder(renamed);
      if (entry) await unregisterGroup(entry.jid);
      fs.rmSync(getGroupDir(renamed), { recursive: true, force: true });
    }
  });

  test('resuming and renaming a project in one PATCH drains the renamed queue', async () => {
    const renamed = `${folder}-resumed-rename`;
    const stagesWithQuestion: StageDefinition[] = [
      legacyStages[0],
      { id: 'question', title: 'Question', type: 'queue', color: '#ffaa00' },
      legacyStages[1],
      legacyStages[2],
    ];
    await updateGroup(jid, {
      settings: {
        status: 'paused',
        privacyMode: 'strict',
        stages: stagesWithQuestion,
      },
    });
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const drainCalls: Array<{ projectId: string; groupFolder: string }> = [];
    let drainPromise: Promise<void> | undefined;
    let executionPromise: Promise<void> | undefined;

    setGroupResolver(getGroupByFolder);
    setProjectQueueDrainRunnerForTests(
      (drainProjectId, drainGroup, options) => {
        drainCalls.push({
          projectId: drainProjectId,
          groupFolder: drainGroup.folder,
        });
        drainPromise = drainProjectQueue(drainProjectId, drainGroup, {
          ...options,
          testDependencies: {
            ...options?.testDependencies,
            executeTask: (startedTask, startedGroup, executionClaim) => {
              executionPromise = executeTask(startedTask, startedGroup, {
                executionClaim,
              });
              return executionPromise;
            },
          },
        });
        return drainPromise;
      },
    );

    try {
      const response = await patchProject({
        folder: renamed,
        settings: { status: 'running' },
      });

      expect(response.status).toBe(200);
      expect(drainPromise).toBeDefined();
      await drainPromise;
      expect(executionPromise).toBeDefined();
      await executionPromise;
      await releaseTaskAdmission(renamed, task.id);

      expect(drainCalls).toEqual([
        { projectId: renamed, groupFolder: renamed },
      ]);
      expect(await getTask(task.id)).toMatchObject({
        project_id: renamed,
        status: 'question',
      });
    } finally {
      await executionPromise?.catch(() => undefined);
      setGroupResolver(() => undefined);
      setProjectQueueDrainRunnerForTests(undefined);
      const entry = getGroupEntryByFolder(renamed);
      if (entry) await unregisterGroup(entry.jid);
      fs.rmSync(getGroupDir(renamed), { recursive: true, force: true });
    }
  });

  test('rejects folder rename while a project task is claimed and queued', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const claim = claimTaskExecution(task.id, folder);
    expect(claim).not.toBeNull();
    try {
      const rejected = await patchProject({
        folder: `${folder}-queued-conflict`,
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({
        error: 'Cannot rename folder while tasks are running',
      });
      expect(getGroupByFolder(folder)?.folder).toBe(folder);
    } finally {
      if (claim) releaseTaskExecutionClaim(task.id, claim);
    }
  });

  test('recomputes removals when a stale pipeline snapshot omits a newly occupied stage', async () => {
    const newlyAddedStage: StageDefinition = {
      id: 'newly_added',
      title: 'Newly Added',
      type: 'active',
      color: '#aa66ff',
    };
    const expandedStages = [
      ...legacyStages.slice(0, 2),
      newlyAddedStage,
      legacyStages[2],
    ];
    await updateGroup(jid, { settings: { stages: expandedStages } });
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'newly_added' }),
    );

    await expect(
      commitProjectStageMigration(
        folder,
        JSON.stringify({ stages: replacementStages }),
        [{ sourceStageId: 'legacy', destinationStageId: 'coding' }],
        ['legacy'],
      ),
    ).rejects.toMatchObject({ name: 'StageRemovalConflictError' });
    expect((await getTask(task.id))?.status).toBe('newly_added');
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(expandedStages);
  });

  test('removing an empty stage succeeds without a migration', async () => {
    const accepted = await patchProject({
      settings: { stages: replacementStages },
    });
    expect(accepted.status).toBe(200);
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(
      replacementStages,
    );
  });

  test('rejects a migration to a stage omitted by the same update', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const rejected = await patchProject({
      settings: { stages: replacementStages },
      stageMigrations: [
        { sourceStageId: 'legacy', destinationStageId: 'missing' },
      ],
    });
    expect(rejected.status).toBe(400);
    expect((await getTask(task.id))?.status).toBe('legacy');
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
  });

  test('does not migrate cards when a later request validation fails', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const rejected = await patchProject({
      name: ' ',
      settings: { stages: replacementStages },
      stageMigrations: [
        { sourceStageId: 'legacy', destinationStageId: 'coding' },
      ],
    });
    expect(rejected.status).toBe(400);
    expect((await getTask(task.id))?.status).toBe('legacy');
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
  });

  test('rejects missing migration for an occupied removed stage', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const rejected = await patchProject({
      settings: { stages: replacementStages },
    });
    expect(rejected.status).toBe(409);
    expect((await getTask(task.id))?.status).toBe('legacy');
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
  });

  test('rejects stale and unknown migration sources', async () => {
    const stale = await patchProject({
      settings: { stages: replacementStages },
      stageMigrations: [
        { sourceStageId: 'backlog', destinationStageId: 'coding' },
      ],
    });
    expect(stale.status).toBe(400);
    const unknown = await patchProject({
      settings: { stages: replacementStages },
      stageMigrations: [
        { sourceStageId: 'not-a-stage', destinationStageId: 'coding' },
      ],
    });
    expect(unknown.status).toBe(400);
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
  });

  test('rejects mappings carrying another project identity', async () => {
    const rejected = await patchProject({
      settings: { stages: replacementStages },
      stageMigrations: [
        {
          projectId: 'another-project',
          sourceStageId: 'legacy',
          destinationStageId: 'coding',
        },
      ],
    });
    expect(rejected.status).toBe(400);
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
  });

  test('rejects explicit occupied-stage removal before settings or prompt writes', async () => {
    expect(getGroupByFolder(folder)).toBeDefined();
    const active = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const archived = await createTask(
      taskFixture({ project_id: folder, status: 'legacy', archived: true }),
    );

    const rejected = await patchProject({
      name: 'Must not change',
      settings: {
        systemPrompt: 'Must not be written',
        stages: replacementStages.map((stage) => ({
          ...stage,
          workerPrompt: 'Must not be written',
        })),
      },
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error:
        'Cannot remove occupied stages: "legacy" (2 cards). Move these cards to stages in the new pipeline first.',
    });
    expect(getGroupByFolder(folder)?.name).toBe('Stage guard route test');
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);
    expect(await readPrompt(folder, undefined, 'system.md')).toBeUndefined();
    expect(await readPrompt(folder, undefined, 'stage-legacy.md')).toBe(
      'Original prompt',
    );
    expect(
      await readPrompt(folder, undefined, 'stage-coding.md'),
    ).toBeUndefined();

    await updateTask(active.id, { status: 'completed' });
    await updateTask(archived.id, { status: 'completed' });
    const accepted = await patchProject({
      settings: { stages: replacementStages },
    });
    expect(accepted.status).toBe(200);
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(
      replacementStages,
    );
  });

  test('round-trips opt-in and prompt configuration for a queue entry agent', async () => {
    const configuredStages = legacyStages.map((stage) =>
      stage.id === 'backlog'
        ? {
            ...stage,
            runOnEntry: true,
            workerPrompt: 'Inspect each newly queued card once.',
          }
        : stage,
    );

    const response = await patchProject({
      settings: { stages: configuredStages },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: { stages: StageDefinition[] };
    };
    expect(
      body.settings.stages.find((stage) => stage.id === 'backlog'),
    ).toEqual(
      expect.objectContaining({
        type: 'queue',
        runOnEntry: true,
        workerPrompt: 'Inspect each newly queued card once.',
      }),
    );
    expect(
      getGroupByFolder(folder)?.settings?.stages?.find(
        (stage) => stage.id === 'backlog',
      ),
    ).toEqual(expect.objectContaining({ runOnEntry: true }));
    expect(await readPrompt(folder, undefined, 'stage-backlog.md')).toBe(
      'Inspect each newly queued card once.',
    );
  });

  test('rejects resetting to defaults while a removed stage is occupied', async () => {
    updateGroup(jid, { settings: { stages: legacyStages } });
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );

    const rejected = await patchProject({ settings: { stages: [] } });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: string }).error).toContain(
      '"legacy" (1 card)',
    );
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual(legacyStages);

    await updateTask(task.id, { status: 'completed' });
    const accepted = await patchProject({ settings: { stages: [] } });
    expect(accepted.status).toBe(200);
    expect(getGroupByFolder(folder)?.settings?.stages).toEqual([]);
  });
});

describe('project tool activity display setting', () => {
  test('persists compact and expanded values through the project route', async () => {
    for (const toolCallDisplay of ['compact', 'expanded'] as const) {
      const response = await patchProject({ settings: { toolCallDisplay } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        settings: { toolCallDisplay: string };
      };
      expect(body.settings.toolCallDisplay).toBe(toolCallDisplay);
      expect(getGroupByFolder(folder)?.settings?.toolCallDisplay).toBe(
        toolCallDisplay,
      );
    }
  });
});

describe('project task checkout mode settings', () => {
  test('allows an unpaused idle project with an active conversation and idle active-stage card', async () => {
    await createTask(taskFixture({ project_id: folder, status: 'legacy' }));
    const conversation = await createConversation(folder);
    const run = runFixture({
      id: 'route-active-conversation-mode-change',
      group_folder: folder,
      conversation_id: conversation.id,
      task_id: null,
    });
    await insertActiveRun(run);
    const admissionId = `conversation:${conversation.id}`;
    const admission = await claimNormalTaskAdmission(
      folder,
      () => 'conversation-token',
      true,
      admissionId,
    );

    const response = await patchProject({
      settings: {
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages: legacyStages,
      },
    });

    expect(response.status).toBe(200);
    expect(getGroupByFolder(folder)?.settings).toMatchObject({
      status: 'running',
      taskCheckoutMode: 'worktree',
    });
    const [row] = await drizzleDbRef.current
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, folder));
    expect(
      JSON.parse(row!.settings!)._checkoutAdmissions[admissionId],
    ).toMatchObject({
      taskCheckoutMode: 'shared',
      ownerToken: admission.ownerToken,
    });
    expect((await getActiveRunById(run.id))?.status).toBe('running');

    await releaseTaskAdmission(folder, admissionId, admission.ownerToken);
    await completeActiveRun(run.id, 'completed');
  });

  test('returns an actionable conflict for an actual task run', async () => {
    const task = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const run = runFixture({
      id: 'route-active-task-mode-change',
      group_folder: folder,
      task_id: task.id,
    });
    await insertActiveRun(run);

    const response = await patchProject({
      settings: { taskCheckoutMode: 'branch' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        'Cannot change taskCheckoutMode while a task execution or admission is active',
    });
    expect(
      getGroupByFolder(folder)?.settings?.taskCheckoutMode,
    ).toBeUndefined();
    await completeActiveRun(run.id, 'completed');
  });
});
