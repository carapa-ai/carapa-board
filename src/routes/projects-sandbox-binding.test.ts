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

const pid = `sandbox-binding-route-${process.pid}`;
const jid = `${pid}@web`;
let server: Server;
let baseUrl: string;
const users: Record<string, string> = {};

async function setStored(binding: Record<string, unknown> = {}) {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Sandbox binding route',
    folder: pid,
    trigger: '@sandbox',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
      ...binding,
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

const stored = () => getGroupByFolder(pid)?.settings;

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

const FIELDS = [
  'defaultSandbox',
  'defaultSandboxService',
  'defaultSandboxInstance',
  'sandboxOwnership',
] as const;
const VALUES = {
  defaultSandbox: 'carapa-bot',
  defaultSandboxService: 'agent',
  defaultSandboxInstance: 'other-project',
  sandboxOwnership: 'shared',
} as const;
const OTHER = {
  defaultSandbox: 'php',
  defaultSandboxService: 'php84',
  defaultSandboxInstance: 'renamed-project',
  sandboxOwnership: 'standalone',
} as const;

describe('PATCH /projects/:pid sandbox binding', () => {
  test('an admin session can set, change and clear each field', async () => {
    for (const field of FIELDS) {
      await setStored({ isParent: true });
      expect((await patch('admin', { [field]: VALUES[field] })).status).toBe(
        200,
      );
      expect(stored()?.[field]).toBe(VALUES[field]);
      expect((await patch('admin', { [field]: OTHER[field] })).status).toBe(
        200,
      );
      expect(stored()?.[field]).toBe(OTHER[field]);
      // Ownership has no null value; "standalone" is its cleared state.
      const cleared = field === 'sandboxOwnership' ? 'standalone' : null;
      expect((await patch('admin', { [field]: cleared })).status).toBe(200);
      expect(stored()?.[field]).toBe(cleared ?? undefined);
    }
  });

  test('non-admin owners and editors cannot set, change or clear any field and nothing else is saved', async () => {
    for (const who of ['owner', 'editor'] as const) {
      for (const field of FIELDS) {
        await setStored({ isParent: true });
        const setRes = await patch(who, {
          [field]: VALUES[field],
          gracefulDeploy: true,
        });
        expect(setRes.status).toBe(403);
        expect(setRes.body).toEqual({
          error: 'Only a board admin can change the sandbox binding',
        });
        expect(stored()?.[field]).toBeUndefined();
        expect(stored()?.gracefulDeploy).toBeUndefined();

        await setStored({ isParent: true, [field]: VALUES[field] });
        expect((await patch(who, { [field]: OTHER[field] })).status).toBe(403);
        expect(stored()?.[field]).toBe(VALUES[field]);
        expect(
          (
            await patch(who, {
              [field]: field === 'sandboxOwnership' ? 'standalone' : null,
            })
          ).status,
        ).toBe(403);
        expect(stored()?.[field]).toBe(VALUES[field]);
      }
    }
  });

  test('a non-admin owner can save other settings while the stored values are resent', async () => {
    await setStored({ isParent: true });
    const blank = await patch('owner', {
      defaultSandbox: '',
      defaultSandboxService: null,
      defaultSandboxInstance: '',
      sandboxOwnership: 'standalone',
      gracefulDeploy: true,
    });
    expect(blank.status).toBe(200);
    expect(stored()?.gracefulDeploy).toBe(true);

    // Equivalent values are dropped, not saved: blank stays unset.
    await setStored({ isParent: true });
    const spaces = await patch('owner', {
      defaultSandbox: '  ',
      defaultSandboxService: ' ',
      sandboxOwnership: null,
      gracefulDeploy: true,
    });
    expect(spaces.status).toBe(200);
    expect(stored()?.defaultSandbox).toBeUndefined();
    expect(stored()?.defaultSandboxService).toBeUndefined();
    expect(stored()?.sandboxOwnership).toBeUndefined();

    await setStored({
      isParent: true,
      defaultSandbox: VALUES.defaultSandbox,
      defaultSandboxService: VALUES.defaultSandboxService,
      defaultSandboxInstance: VALUES.defaultSandboxInstance,
      sandboxOwnership: 'shared',
    });
    const same = await patch('owner', { ...VALUES, gracefulDeploy: true });
    expect(same.status).toBe(200);
    expect(stored()).toMatchObject({ ...VALUES, gracefulDeploy: true });
  });
});

describe('sandbox names are unique among projects', () => {
  const otherPid = `${pid}-other`;
  const otherJid = `${otherPid}@web`;
  const taken = `shared-x-${process.pid}`;
  const message = (name: string) => ({
    error: `The name "${name}" is already used as a sandbox name by another project`,
  });

  async function setOther(instance: string) {
    await unregisterGroup(otherJid);
    await registerGroup(otherJid, {
      jid: otherJid,
      name: 'Other project',
      folder: otherPid,
      trigger: '@other',
      added_at: new Date().toISOString(),
      settings: { status: 'running', defaultSandboxInstance: instance },
    });
  }

  async function send(method: string, path: string, body: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-who': 'admin' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  afterAll(async () => {
    await unregisterGroup(otherJid);
  });

  test("a new project cannot take another project's configured instance as its folder", async () => {
    await setOther(taken);
    const created = await send('POST', '/projects', { name: taken });
    expect(created.status).toBe(409);
    expect(created.body).toEqual(message(taken));
    expect(getGroupByFolder(taken)).toBeUndefined();
    await expect(
      registerGroup(`${taken}@web`, {
        jid: `${taken}@web`,
        name: 'Taken',
        folder: taken,
        trigger: '@taken',
        added_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(message(taken).error);
    expect(getGroupByFolder(taken)).toBeUndefined();
  });

  test('the comparison ignores case', async () => {
    await setOther(taken.toUpperCase());
    const created = await send('POST', '/projects', { name: taken });
    expect(created.status).toBe(409);
    expect(getGroupByFolder(taken)).toBeUndefined();
    expect(
      (await patch('admin', { defaultSandboxInstance: taken })).status,
    ).toBe(400);

    // A folder that differs only by case is a collision too.
    await setOther('unrelated');
    const mixed = `Shared-Folder-${process.pid}`;
    const mixedJid = `${mixed}@web`;
    await registerGroup(mixedJid, {
      jid: mixedJid,
      name: 'Mixed case',
      folder: mixed,
      trigger: '@mixed',
      added_at: new Date().toISOString(),
    });
    try {
      const lower = mixed.toLowerCase();
      expect((await send('POST', '/projects', { name: lower })).status).toBe(
        409,
      );
      expect(getGroupByFolder(lower)).toBeUndefined();
      await setStored();
      expect(
        (await send('PATCH', `/projects/${pid}`, { folder: lower })).status,
      ).toBe(409);
    } finally {
      await unregisterGroup(mixedJid);
    }
  });

  test("a rename onto another project's configured instance is refused and nothing is saved", async () => {
    await setStored();
    await setOther(taken);
    const renamed = await send('PATCH', `/projects/${pid}`, {
      name: 'Renamed project',
      folder: taken,
      settings: { gracefulDeploy: true },
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body).toEqual(message(taken));
    expect(getGroupByFolder(taken)).toBeUndefined();
    expect(getGroupByFolder(pid)?.name).toBe('Sandbox binding route');
    expect(stored()?.gracefulDeploy).toBeUndefined();
  });

  test("an instance equal to another project's folder or instance is refused, its own folder is allowed", async () => {
    await setStored();
    await setOther(taken);
    for (const name of [taken, otherPid]) {
      const res = await patch('admin', { defaultSandboxInstance: name });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(message(name));
      expect(stored()?.defaultSandboxInstance).toBeUndefined();
    }
    expect((await patch('admin', { defaultSandboxInstance: pid })).status).toBe(
      200,
    );
    expect(stored()?.defaultSandboxInstance).toBe(pid);
  });

  test('resending a stored instance that already collides still saves other settings', async () => {
    await setStored({ defaultSandboxInstance: taken });
    await setOther(taken);
    const res = await patch('admin', {
      defaultSandboxInstance: taken,
      gracefulDeploy: true,
    });
    expect(res.status).toBe(200);
    expect(stored()?.gracefulDeploy).toBe(true);
  });
});

describe('PATCH /projects/:pid extra mounts and workspace roots', () => {
  const stale = { extraMounts: ['/srv/b', '/srv/a'], workspaceRoots: ['/w/1'] };
  const refused = {
    error: 'Only a board admin can change mounts and workspace roots',
  };

  test('an admin session can set, change, reorder and clear both fields', async () => {
    await setStored();
    expect((await patch('admin', stale)).status).toBe(200);
    expect(stored()).toMatchObject(stale);
    const reordered = { extraMounts: ['/srv/a', '/srv/b'], workspaceRoots: [] };
    expect((await patch('admin', reordered)).status).toBe(200);
    expect(stored()?.extraMounts).toEqual(['/srv/a', '/srv/b']);
    expect(stored()?.workspaceRoots).toBeUndefined();
    expect(
      (await patch('admin', { extraMounts: null, workspaceRoots: null }))
        .status,
    ).toBe(200);
    expect(stored()?.extraMounts).toBeUndefined();
  });

  test('non-admin owners and editors cannot change either field and nothing else is saved', async () => {
    const changes = [
      { extraMounts: ['/srv/c'] },
      { extraMounts: ['/srv/a', '/srv/b'] },
      { extraMounts: [] },
      { workspaceRoots: ['/w/2'] },
      { workspaceRoots: null },
    ];
    for (const who of ['owner', 'editor'] as const) {
      for (const change of changes) {
        await setStored(stale);
        const res = await patch(who, { ...change, gracefulDeploy: true });
        expect(res.status).toBe(403);
        expect(res.body).toEqual(refused);
        expect(stored()).toMatchObject(stale);
        expect(stored()?.gracefulDeploy).toBeUndefined();
      }
    }
  });

  test('a non-admin owner can save other settings while the stored values are resent', async () => {
    await setStored(stale);
    expect(
      (
        await patch('owner', {
          extraMounts: [' /srv/b ', '/srv/a'],
          workspaceRoots: [' /w/1 '],
          gracefulDeploy: true,
        })
      ).status,
    ).toBe(200);
    expect(stored()).toMatchObject({ ...stale, gracefulDeploy: true });

    await setStored();
    expect(
      (
        await patch('owner', {
          extraMounts: [],
          workspaceRoots: [' '],
          gracefulDeploy: true,
        })
      ).status,
    ).toBe(200);
    expect(stored()?.gracefulDeploy).toBe(true);
  });

  test('a non-admin owner still changes the other repository connection fields', async () => {
    await setStored(stale);
    const res = await patch('owner', {
      repositoryUrl: 'https://example.com/r.git',
      repositoryRelativePath: 'sub',
      extraMounts: stale.extraMounts,
    });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({
      repositoryUrl: 'https://example.com/r.git',
      repositoryRelativePath: 'sub',
    });
  });
});
