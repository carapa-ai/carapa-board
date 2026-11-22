import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import type { RegisteredGroup } from '../../types.js';
import os from 'node:os';
import {
  effectiveProjectUploadDir,
  resolveEffectiveSandbox,
} from '../../sandbox/effective-settings.js';
import { validateProspectiveParentId } from '../../routes/projects.js';
import {
  type ActivitySources,
  describeSandboxTransition,
  findActivityOver,
  drainBrains,
  moveGroupDir,
  ProjectReparentError,
  reparentProject,
  type ReparentDeps,
} from './reparent-project.js';

// The file move runs for real below GROUPS_DIR; only the sandbox, run and
// registry lookups are replaced.
const suffix = `${process.pid}-${Date.now()}`;
const PARENT = `rp-parent-${suffix}`;
const OTHER_PARENT = `rp-other-${suffix}`;
const created = [PARENT, OTHER_PARENT];

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => fs.readFileSync(file, 'utf8');
const dir = (...parts: string[]) => path.join(GROUPS_DIR, ...parts);

function harness(folder: string, overrides: Partial<ReparentDeps> = {}) {
  const calls: string[] = [];
  const group = {
    name: folder,
    folder,
    trigger: '!',
    added_at: '2026-01-01',
  } as RegisteredGroup;
  const deps: Partial<ReparentDeps> = {
    getGroup: () => group,
    childFolders: () => [],
    isRemotePlaced: () => false,
    validateParent: () => undefined,
    describeSandbox: async () => ({
      affected: [folder],
      targets: [
        {
          instance: folder,
          ownerFolder: folder,
          fixedInstance: false,
          restart: true,
        },
      ],
    }),
    drainBrains: async () => {
      calls.push('drain');
      return { release: async () => void calls.push('undrain') };
    },
    syncReplica: async () => void calls.push('sync replica'),
    exclusive: async (_folder, operation) => {
      calls.push('pause replica');
      try {
        return await operation();
      } finally {
        calls.push('resume replica');
      }
    },
    holdRuns: async (_instances, operation) => {
      calls.push('hold');
      try {
        return await operation();
      } finally {
        calls.push('unhold');
      }
    },
    findActiveRun: async () => undefined,
    fenceRuns: async () => {
      calls.push('fence');
      return () => void calls.push('unfence');
    },
    // A coding stack and a separate Brain stack share the instance.
    runningStacks: async () => ['coding', 'brain'],
    stopSandbox: async (instance, stacks) =>
      void calls.push(`stop ${instance} ${stacks.join(',')}`),
    restartSandbox: async (target, stacks) =>
      void calls.push(`restart ${target.ownerFolder} ${stacks.join(',')}`),
    verifyGroupMount: async (target, stacks) =>
      void calls.push(`verify ${target.ownerFolder} ${stacks.join(',')}`),
    ...overrides,
  };
  return { calls, group, deps };
}

beforeAll(() => {
  for (const name of created) fs.mkdirSync(dir(name), { recursive: true });
});

afterAll(() => {
  for (const name of created)
    fs.rmSync(dir(name), { recursive: true, force: true });
});

describe('reparentProject', () => {
  test('stops, moves, persists, then restarts; merges into a skeleton and leaves nothing behind', async () => {
    const folder = `rp-move-${suffix}`;
    created.push(folder);
    write(dir(folder, 'objectives', 'obj-1', 'objective.md'), 'objective');
    write(dir(folder, 'transcripts', 't.jsonl'), 'line');
    write(dir(folder, 'AGENTS.md'), 'same');
    // What an earlier, data-less move left at the destination.
    write(dir(PARENT, folder, 'AGENTS.md'), 'same');
    fs.mkdirSync(dir(PARENT, folder, 'transcripts'), { recursive: true });
    const { calls, deps } = harness(folder);

    const outcome = await reparentProject(
      {
        folder,
        newParentId: PARENT,
        persist: async () => {
          calls.push(
            `persist new=${fs.existsSync(dir(PARENT, folder, 'objectives', 'obj-1', 'objective.md'))} old=${fs.existsSync(dir(folder, 'objectives'))}`,
          );
          return 'saved';
        },
      },
      deps,
    );

    expect(calls).toEqual([
      'hold',
      'drain',
      'fence',
      `stop ${folder} coding,brain`,
      'persist new=true old=false',
      'unfence',
      `restart ${folder} coding,brain`,
      `verify ${folder} coding,brain`,
      'undrain',
      'unhold',
    ]);
    expect(outcome).toMatchObject({
      value: 'saved',
      filesMoved: true,
      sandboxRestarted: true,
    });
    expect(outcome.postSaveError).toBeUndefined();
    expect(read(dir(PARENT, folder, 'transcripts', 't.jsonl'))).toBe('line');
    expect(fs.existsSync(dir(folder))).toBe(false);
  });

  test('refuses while a run is active and changes nothing', async () => {
    const folder = `rp-busy-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder, {
      findActiveRun: async () => `"${folder}" has a run in progress`,
    });

    const err = await reparentProject(
      {
        folder,
        newParentId: PARENT,
        persist: async () => void calls.push('persist'),
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectReparentError);
    expect((err as ProjectReparentError).status).toBe(409);
    expect(calls.some((c) => c.startsWith('stop'))).toBe(false);
    expect(calls).not.toContain('persist');
    expect(read(dir(folder, 'queue.json'))).toBe('[]');
    expect(fs.existsSync(dir(PARENT, folder))).toBe(false);
  });

  test('puts the files back and restarts the old sandbox when saving the parent fails', async () => {
    const folder = `rp-fail-${suffix}`;
    created.push(folder);
    write(dir(PARENT, folder, 'session-log.jsonl'), 'log');
    const { calls, deps } = harness(folder);
    (deps.getGroup!(folder) as RegisteredGroup).parentId = PARENT;

    const err = await reparentProject(
      {
        folder,
        newParentId: OTHER_PARENT,
        persist: async () => {
          throw new Error('db down');
        },
      },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectReparentError);
    expect((err as ProjectReparentError).state).toBe('restored');
    expect((err as ProjectReparentError).message).toMatch(/db down/);
    expect(((err as ProjectReparentError).persistCause as Error).message).toBe(
      'db down',
    );
    expect(read(dir(PARENT, folder, 'session-log.jsonl'))).toBe('log');
    expect(fs.existsSync(dir(OTHER_PARENT, folder))).toBe(false);
    expect(calls).toEqual([
      'hold',
      'drain',
      'fence',
      `stop ${folder} coding,brain`,
      'unfence',
      `restart ${folder} coding,brain`,
      'undrain',
      'unhold',
    ]);
  });

  test('stops on a file that differs at both paths', async () => {
    const folder = `rp-conflict-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), 'old');
    write(dir(PARENT, folder, 'queue.json'), 'new');
    const { calls, deps } = harness(folder);

    const err = await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'x' },
      deps,
    ).catch((e: unknown) => e);

    expect((err as ProjectReparentError).status).toBe(409);
    expect(calls.some((c) => c.startsWith('stop'))).toBe(false);
    expect(read(dir(folder, 'queue.json'))).toBe('old');
    expect(read(dir(PARENT, folder, 'queue.json'))).toBe('new');
  });

  test('reports a saved parent whose restarted mount cannot be verified', async () => {
    const folder = `rp-verify-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { deps } = harness(folder, {
      verifyGroupMount: async () => {
        throw new Error('no mount');
      },
    });

    const outcome = await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'saved' },
      deps,
    );

    expect(outcome.value).toBe('saved');
    expect(outcome.postSaveError?.state).toBe('saved_mount_unverified');
    expect(read(dir(PARENT, folder, 'queue.json'))).toBe('[]');
  });

  test('stops and restarts the old and the new shared owner, never the project it no longer owns', async () => {
    const folder = `rp-attach-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder, {
      describeSandbox: async () => ({
        affected: [folder],
        targets: [
          {
            instance: folder,
            ownerFolder: folder,
            fixedInstance: false,
            restart: false,
          },
          {
            instance: 'owner',
            ownerFolder: 'owner',
            fixedInstance: false,
            restart: true,
          },
        ],
      }),
      runningStacks: async (instance) =>
        instance === 'owner' ? ['brain'] : ['coding'],
    });

    await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'saved' },
      deps,
    );

    expect(calls).toEqual([
      'hold',
      'drain',
      'fence',
      `stop ${folder} coding`,
      'stop owner brain',
      'unfence',
      'restart owner brain',
      'verify owner brain',
      'undrain',
      'unhold',
    ]);
  });

  test('starts a sandbox for a child detached from a running owner', async () => {
    const folder = `rp-detach-${suffix}`;
    created.push(folder);
    write(dir(PARENT, folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder, {
      describeSandbox: async () => ({
        affected: [folder],
        targets: [
          {
            instance: 'owner',
            ownerFolder: 'owner',
            fixedInstance: false,
            restart: true,
          },
          {
            instance: folder,
            ownerFolder: folder,
            fixedInstance: false,
            restart: true,
            ensureStack: 'brain',
          },
        ],
      }),
      runningStacks: async (instance) =>
        instance === 'owner' ? ['brain'] : [],
    });
    (deps.getGroup!(folder) as RegisteredGroup).parentId = PARENT;

    await reparentProject(
      { folder, newParentId: undefined, persist: async () => 'saved' },
      deps,
    );

    expect(calls).toEqual([
      'hold',
      'drain',
      'fence',
      'stop owner brain',
      'unfence',
      'restart owner brain',
      'verify owner brain',
      `restart ${folder} brain`,
      `verify ${folder} brain`,
      'undrain',
      'unhold',
    ]);
    expect(read(dir(folder, 'queue.json'))).toBe('[]');
  });

  test('keeps a child folder only where it sits inside the moved directory', async () => {
    const folder = `rp-kids-${suffix}`;
    created.push(folder);
    // Flat project: the child's directory is inside it and stays.
    write(dir(folder, 'own.txt'), 'own');
    write(dir(folder, 'objectives', 'child.txt'), 'child');
    const flat = harness(folder, { childFolders: () => ['objectives'] });
    await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'saved' },
      flat.deps,
    );
    expect(read(dir(PARENT, folder, 'own.txt'))).toBe('own');
    expect(read(dir(folder, 'objectives', 'child.txt'))).toBe('child');

    // Nested project: its own `objectives` is not the child's and must move,
    // and merging it into the child's directory at the flat path is refused.
    const nested = harness(folder, { childFolders: () => ['objectives'] });
    (nested.deps.getGroup!(folder) as RegisteredGroup).parentId = PARENT;
    write(dir(PARENT, folder, 'objectives', 'obj.md'), 'own objective');
    const err = await reparentProject(
      { folder, newParentId: undefined, persist: async () => 'saved' },
      nested.deps,
    ).catch((e: unknown) => e);
    expect((err as ProjectReparentError).status).toBe(409);
    expect(read(dir(PARENT, folder, 'objectives', 'obj.md'))).toBe(
      'own objective',
    );
    expect(read(dir(folder, 'objectives', 'child.txt'))).toBe('child');
  });

  test('does not follow a sandbox-planted link above an upload directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ipc-'));
    try {
      const ipc = path.join(root, 'ipc');
      write(path.join(ipc, 'victim', 'sessions', 'kid', 'secret.txt'), 's');
      // The shared sandbox replaced its `uploads` directory with a link.
      fs.mkdirSync(path.join(ipc, 'shared'), { recursive: true });
      fs.symlinkSync(
        path.join(ipc, 'victim', 'sessions'),
        path.join(ipc, 'shared', 'uploads'),
      );

      const result = await moveGroupDir(
        path.join(ipc, 'shared', 'uploads', 'kid'),
        path.join(ipc, 'own', 'uploads'),
        { anchor: ipc },
      ).catch((e: unknown) => e);

      expect(result).toBeInstanceOf(Error);
      expect(
        read(path.join(ipc, 'victim', 'sessions', 'kid', 'secret.txt')),
      ).toBe('s');
      expect(fs.existsSync(path.join(ipc, 'own', 'uploads'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses while a Brain is running an objective of its own', async () => {
    const folder = `rp-brainbusy-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder, {
      drainBrains: async () => {
        calls.push('drain');
        return {
          busy: 'Brain b is running objective obj-1',
          release: async () => void calls.push('undrain'),
        };
      },
    });

    const err = await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'x' },
      deps,
    ).catch((e: unknown) => e);

    expect((err as ProjectReparentError).status).toBe(409);
    expect(calls).toEqual(['hold', 'drain', 'undrain', 'unhold']);
    expect(read(dir(folder, 'queue.json'))).toBe('[]');
  });

  test('moves a remotely placed project between replica syncs, and undoes inside the pause', async () => {
    const folder = `rp-remote-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder, {
      isRemotePlaced: () => true,
      runningStacks: async () => [],
    });

    await reparentProject(
      {
        folder,
        newParentId: PARENT,
        persist: async () => void calls.push('persist'),
      },
      deps,
    );
    expect(calls).toEqual([
      'hold',
      'drain',
      'fence',
      'sync replica',
      'pause replica',
      'persist',
      'resume replica',
      'unfence',
      'undrain',
      'unhold',
    ]);
    expect(read(dir(PARENT, folder, 'queue.json'))).toBe('[]');

    const failing = harness(folder, {
      isRemotePlaced: () => true,
      runningStacks: async () => [],
    });
    (failing.deps.getGroup!(folder) as RegisteredGroup).parentId = PARENT;
    const err = await reparentProject(
      {
        folder,
        newParentId: undefined,
        persist: async () => {
          failing.calls.push(
            `persist at-new=${fs.existsSync(dir(folder, 'queue.json'))}`,
          );
          throw new Error('db down');
        },
      },
      failing.deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectReparentError);
    expect((err as ProjectReparentError).state).toBe('restored');
    expect((err as ProjectReparentError).message).toMatch(/db down/);
    expect(((err as ProjectReparentError).persistCause as Error).message).toBe(
      'db down',
    );
    expect(read(dir(PARENT, folder, 'queue.json'))).toBe('[]');
    expect(failing.calls.slice(3, 7)).toEqual([
      'sync replica',
      'pause replica',
      'persist at-new=true',
      'resume replica',
    ]);
  });

  test('includes the Brains of the old and the new parent as sandboxes to reload', () => {
    const base = { name: 'x', trigger: '!', added_at: '2026-01-01' };
    const parents = {
      'p-old': {
        ...base,
        folder: 'p-old',
        settings: { brainContainer: 'brain-old' },
      },
      'p-new': {
        ...base,
        folder: 'p-new',
        settings: { brainContainer: 'brain-new' },
      },
    } as Record<string, RegisteredGroup>;
    // The child has no Brain of its own: it inherits its parent's.
    const child = {
      ...base,
      folder: 'kid',
      parentId: 'p-old',
    } as RegisteredGroup;
    const lookup = (folder: string) =>
      folder === 'kid' ? child : parents[folder];
    const instanceOfBrain: Record<string, string> = {
      'brain-old': 'p-old',
      'brain-new': 'p-new',
    };
    const env = {
      groups: [child, parents['p-old'], parents['p-new']],
      lookup,
      resolveEffectiveSandbox,
      effectiveProjectUploadDir,
      resolveBrainContainer: (g: RegisteredGroup) =>
        g.settings?.brainContainer ??
        (g.parentId ? lookup(g.parentId)?.settings?.brainContainer : undefined),
      resolveBrainInstance: (container: string) => instanceOfBrain[container],
      dataDir: '/data',
    };

    const transition = describeSandboxTransition(child, 'p-new', env);

    expect(
      transition.targets.map((t) => [t.instance, t.ownerFolder, t.restart]),
    ).toEqual([
      ['kid', 'kid', true],
      ['p-old', 'p-old', true],
      ['p-new', 'p-new', true],
    ]);
    expect(transition.refusals).toBeUndefined();
  });

  test('does not proceed unless every running Brain is confirmed drained and idle', async () => {
    const group = { name: 'x', folder: 'kid', trigger: '!' } as RegisteredGroup;
    const run = async (
      handler: (method: string, path: string) => Response | null | Error,
    ) => {
      const seen: string[] = [];
      const result = await drainBrains(group, undefined, [], {
        getGroup: () => undefined,
        resolveBrainContainer: () => 'brain-1',
        resolveBrainAuthToken: () => 'token',
        fetchBrain: async (_container, path, init) => {
          const method = init.method ?? 'GET';
          seen.push(`${method} ${path}`);
          const reply = handler(method, path);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      });
      await result.release();
      return { busy: result.busy, seen };
    };
    const idle = () => Response.json({ processor: { activeObjectiveIds: [] } });

    const ok = await run((method) =>
      method === 'GET' ? idle() : new Response(null, { status: 200 }),
    );
    expect(ok.busy).toBeUndefined();
    expect(ok.seen).toEqual(['POST /drain', 'GET /status', 'DELETE /drain']);

    // Not running at all: nothing to drain.
    expect((await run(() => null)).busy).toBeUndefined();

    for (const bad of [
      (method: string) =>
        method === 'POST' ? new Response(null, { status: 401 }) : idle(),
      // Too old to take a drain: it could start an objective before the stop.
      (method: string) =>
        method === 'POST' ? new Response(null, { status: 404 }) : idle(),
      (method: string) => (method === 'POST' ? new Error('timeout') : idle()),
      (method: string) =>
        method === 'GET'
          ? new Response(null, { status: 500 })
          : new Response(null),
      (method: string) =>
        method === 'GET' ? Response.json({}) : new Response(null),
    ]) {
      expect((await run(bad)).busy).toMatch(/could not be confirmed/);
    }
    const busy = await run((method) =>
      method === 'GET'
        ? Response.json({ processor: { activeObjectiveIds: ['obj-1'] } })
        : new Response(null),
    );
    expect(busy.busy).toMatch(/obj-1/);
  });

  test('refuses attaching a project to a shared owner when its own Brain would be left stopped', () => {
    const base = { name: 'x', trigger: '!', added_at: '2026-01-01' };
    const owner = {
      ...base,
      folder: 'shared-owner',
      settings: { isParent: true, sandboxOwnership: 'shared' },
    } as RegisteredGroup;
    const solo = {
      ...base,
      folder: 'solo',
      settings: { brainContainer: 'brain-solo' },
    } as RegisteredGroup;
    const lookup = (folder: string) =>
      ({ solo, 'shared-owner': owner })[folder];
    const transition = describeSandboxTransition(solo, 'shared-owner', {
      groups: [solo, owner],
      lookup,
      resolveEffectiveSandbox,
      effectiveProjectUploadDir,
      resolveBrainContainer: (g) => g.settings?.brainContainer,
      resolveBrainInstance: () => 'solo',
      dataDir: '/data',
    });
    expect(transition.refusals?.[0]).toMatch(/Brain "brain-solo"/);
  });

  test('reports a sandbox that could not be brought back after the save failed', async () => {
    const folder = `rp-recover-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { deps } = harness(folder, {
      restartSandbox: async () => {
        throw new Error('box offline');
      },
    });

    const err = await reparentProject(
      {
        folder,
        newParentId: PARENT,
        persist: async () => {
          throw new Error('db down');
        },
      },
      deps,
    ).catch((e: unknown) => e);

    expect((err as ProjectReparentError).state).toBe('restored');
    expect((err as ProjectReparentError).message).toMatch(/db down/);
    expect((err as ProjectReparentError).message).toMatch(/box offline/);
    expect(read(dir(folder, 'queue.json'))).toBe('[]');
  });

  test('moves that share a parent directory run one after the other and see each other', async () => {
    const p = `rp-p-${suffix}`;
    const c = `rp-c-${suffix}`;
    created.push(p, c);
    write(dir(p, 'p.txt'), 'p');
    write(dir(c, 'c.txt'), 'c');
    const registry: Record<string, RegisteredGroup> = {};
    for (const folder of [p, c]) {
      registry[folder] = {
        name: folder,
        folder,
        trigger: '!',
        added_at: '2026-01-01',
      } as RegisteredGroup;
    }
    const events: string[] = [];
    let releaseP!: () => void;
    const holdP = new Promise<void>((resolve) => (releaseP = resolve));
    let pSaving!: () => void;
    const pIsSaving = new Promise<void>((resolve) => (pSaving = resolve));
    const shared = {
      getGroup: (folder: string) => registry[folder],
      childFolders: (folder: string) =>
        Object.values(registry)
          .filter((g) => g.parentId === folder)
          .map((g) => g.folder),
      runningStacks: async () => [],
    };
    const moveP = reparentProject(
      {
        folder: p,
        newParentId: PARENT,
        persist: async () => {
          events.push('p saving');
          pSaving();
          await holdP;
          registry[p].parentId = PARENT;
          events.push('p saved');
        },
      },
      harness(p, shared).deps,
    );
    await pIsSaving;
    // Attaches C below P while P is still being moved.
    let cStarted!: () => void;
    const cIsRunning = new Promise<void>((resolve) => (cStarted = resolve));
    const moveC = reparentProject(
      {
        folder: c,
        newParentId: p,
        persist: async () => {
          events.push('c saving');
          registry[c].parentId = p;
        },
      },
      harness(c, {
        ...shared,
        holdRuns: async (_instances, operation) => {
          cStarted();
          return operation();
        },
      }).deps,
    );
    // Unlocked, C would get going within the microtasks that setImmediate
    // waits out; locked, it cannot start until P has finished.
    await Promise.race([
      cIsRunning,
      new Promise((resolve) => setImmediate(resolve)),
    ]);
    releaseP();
    await Promise.all([moveP, moveC]);

    expect(events).toEqual(['p saving', 'p saved', 'c saving']);
    expect(read(dir(PARENT, p, 'p.txt'))).toBe('p');
    // Where getGroupDir(c) resolves with c below p: not carried along with p.
    expect(read(dir(p, c, 'c.txt'))).toBe('c');
    expect(fs.existsSync(dir(PARENT, p, c))).toBe(false);
  });

  test('refuses a change that needs another project to see files of a remotely placed one', async () => {
    const folder = `rp-remote-owner-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder, {
      isRemotePlaced: (f) => f === 'owner',
      describeSandbox: async () => ({
        affected: [folder],
        targets: [
          {
            instance: 'owner',
            ownerFolder: 'owner',
            fixedInstance: false,
            restart: true,
          },
        ],
      }),
    });

    const err = await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'x' },
      deps,
    ).catch((e: unknown) => e);

    expect((err as ProjectReparentError).status).toBe(409);
    expect(calls.some((c) => c.startsWith('stop'))).toBe(false);
    expect(read(dir(folder, 'queue.json'))).toBe('[]');
  });

  test('every activity check and the Brain drain run over the one affected set', async () => {
    const base = { name: 'x', trigger: '!', added_at: '2026-01-01' };
    const top = {
      ...base,
      folder: 'top',
      settings: { brainContainer: 'brain-top' },
    } as RegisteredGroup;
    const kid = { ...base, folder: 'kid', parentId: 'top' } as RegisteredGroup;
    const stranger = { ...base, folder: 'stranger' } as RegisteredGroup;
    const all = { top, kid, stranger } as Record<string, RegisteredGroup>;
    const lookup = (folder: string) => all[folder];
    const env = {
      groups: Object.values(all),
      lookup,
      resolveEffectiveSandbox,
      effectiveProjectUploadDir,
      resolveBrainContainer: (g: RegisteredGroup) =>
        g.settings?.brainContainer ??
        (g.parentId ? lookup(g.parentId)?.settings?.brainContainer : undefined),
      resolveBrainInstance: () => undefined,
      dataDir: '/data',
    };
    // Detaching kid: the sandbox of `top` mounts the directory it leaves.
    const transition = describeSandboxTransition(kid, undefined, env);
    expect(transition.affected.sort()).toEqual(['kid', 'top']);

    const idle: ActivitySources = {
      runningTaskIds: async () => new Set(),
      taskIds: async () => [],
      hasRun: async () => false,
      hasInlineAdmission: async () => false,
      inlineChatKeys: () => [],
      runningObjective: async () => undefined,
      runOnInstance: async () => undefined,
    };
    const instances = transition.targets.map((t) => t.instance);
    // A streaming inline conversation of the exposing parent blocks the move.
    expect(
      await findActivityOver(transition.affected, instances, {
        ...idle,
        inlineChatKeys: () => ['top:conv:conv-1'],
      }),
    ).toMatch(/"top" has a conversation/);
    expect(
      await findActivityOver(transition.affected, instances, {
        ...idle,
        inlineChatKeys: () => ['stranger:conv:conv-1'],
      }),
    ).toBeUndefined();

    // The exposing parent's Brain is drained too, not only the moved project's.
    const drained: string[] = [];
    const result = await drainBrains(kid, undefined, transition.affected, {
      getGroup: lookup,
      resolveBrainContainer: env.resolveBrainContainer,
      resolveBrainAuthToken: () => 'token',
      fetchBrain: async (container, _path, init) => {
        drained.push(`${init.method ?? 'GET'} ${container}`);
        return init.method === 'GET'
          ? Response.json({ processor: { activeObjectiveIds: [] } })
          : new Response(null);
      },
    });
    await result.release();
    expect(drained).toContain('POST brain-top');
  });

  test('includes a nonshared parent that mounts the project, and refuses a child that relies on its Brain', () => {
    const base = { name: 'x', trigger: '!', added_at: '2026-01-01' };
    const parent = { ...base, folder: 'top' } as RegisteredGroup;
    const kid = { ...base, folder: 'kid', parentId: 'top' } as RegisteredGroup;
    const lookup = (folder: string) => ({ top: parent, kid })[folder];
    const env = {
      groups: [parent, kid],
      lookup,
      resolveEffectiveSandbox,
      effectiveProjectUploadDir,
      resolveBrainContainer: (g: RegisteredGroup) =>
        g.settings?.brainContainer ??
        (g.parentId ? lookup(g.parentId)?.settings?.brainContainer : undefined),
      resolveBrainInstance: () => undefined,
      dataDir: '/data',
    };

    // The parent's sandbox mounts groups/top, which holds the child.
    const detach = describeSandboxTransition(kid, undefined, env);
    expect(detach.targets.map((t) => [t.instance, t.exposure])).toEqual([
      ['kid', undefined],
      ['top', true],
    ]);

    // Moving a parent whose Brain a child inherits would strand the child.
    const withBrain = {
      ...parent,
      settings: { brainContainer: 'brain-top' },
    } as RegisteredGroup;
    const withBrainLookup = (folder: string) =>
      ({ top: withBrain, kid })[folder];
    const moveParent = describeSandboxTransition(withBrain, 'elsewhere', {
      ...env,
      groups: [withBrain, kid],
      lookup: withBrainLookup,
      resolveBrainContainer: (g) =>
        g.settings?.brainContainer ??
        (g.parentId
          ? withBrainLookup(g.parentId)?.settings?.brainContainer
          : undefined),
    });
    expect(moveParent.refusals?.[0]).toMatch(/Child project "kid"/);
  });

  test('a ring of parent changes cannot close, whatever the order', async () => {
    const names = ['a', 'b', 'c', 'd'].map((n) => `rp-cy-${n}-${suffix}`);
    const [a, b, c, d] = names;
    created.push(...names);
    const registry: Record<string, RegisteredGroup> = {};
    for (const folder of names) {
      write(dir(folder, 'f.txt'), folder);
      registry[folder] = {
        name: folder,
        folder,
        trigger: '!',
        added_at: '2026-01-01',
      } as RegisteredGroup;
    }
    // b below c, d below a: a under b and c under d would close the ring.
    registry[b].parentId = c;
    registry[d].parentId = a;
    const shared = {
      getGroup: (folder: string) => registry[folder],
      childFolders: () => [] as string[],
      runningStacks: async () => [] as string[],
      validateParent: (group: RegisteredGroup, parentId: string | undefined) =>
        validateProspectiveParentId(group, parentId, (f) => registry[f]),
    };
    const attach = (folder: string, parentId: string) =>
      reparentProject(
        {
          folder,
          newParentId: parentId,
          persist: async () => void (registry[folder].parentId = parentId),
        },
        harness(folder, shared).deps,
      );
    const results = await Promise.allSettled([attach(a, b), attach(c, d)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });

  test('refuses when the sandboxes changed while the hold was being acquired', async () => {
    const folder = `rp-topology-${suffix}`;
    created.push(folder);
    write(dir(folder, 'queue.json'), '[]');
    const { calls, deps } = harness(folder);
    const original = deps.describeSandbox!;
    let described = 0;
    deps.describeSandbox = async (group, parent) => {
      const transition = await original(group, parent);
      // The second look finds another sandbox involved.
      return ++described === 1
        ? transition
        : {
            ...transition,
            targets: [
              ...transition.targets,
              {
                instance: 'newcomer',
                ownerFolder: 'newcomer',
                fixedInstance: false,
                restart: true,
              },
            ],
          };
    };

    const err = await reparentProject(
      { folder, newParentId: PARENT, persist: async () => 'x' },
      deps,
    ).catch((e: unknown) => e);

    expect((err as ProjectReparentError).status).toBe(409);
    expect(calls.some((c) => c.startsWith('stop'))).toBe(false);
    expect(read(dir(folder, 'queue.json'))).toBe('[]');
  });
});
