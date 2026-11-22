import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
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

// Box is never reached: the key deletion is replaced by a controllable stub.
const realKeys = await import('../modules/projects/integration-keys.js');
let deleteKeys: (name: string) => Promise<number> = async () => 0;
mock.module('../modules/projects/integration-keys.js', () => ({
  ...realKeys,
  deleteProjectKeys: (name: string) => deleteKeys(name),
}));
const { default: projectsRouter } = await import('./projects.js');

const base = `ikeys-${process.pid}`;
const folders = { a: `${base}-a`, b: `${base}-b`, c: `${base}-c` };
const jidOf = (key: keyof typeof folders) => `${folders[key]}@web`;
const instance = `held-${process.pid}`;
let server: Server;
let baseUrl: string;
let adminId: string;

const deleted: string[] = [];
let storedAtDelete: Array<string | undefined> = [];

async function setStored(
  key: keyof typeof folders,
  settings: Record<string, unknown> = {},
) {
  await unregisterGroup(jidOf(key));
  await registerGroup(jidOf(key), {
    jid: jidOf(key),
    name: `Integration keys ${key}`,
    folder: folders[key],
    trigger: `@${key}`,
    added_at: new Date().toISOString(),
    settings: { status: 'running', ...settings },
  });
}

async function send(method: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

const patch = (key: keyof typeof folders, body: Record<string, unknown>) =>
  send('PATCH', `/projects/${folders[key]}`, body);
const storedInstance = (key: keyof typeof folders) =>
  getGroupByFolder(folders[key])?.settings?.defaultSandboxInstance;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${base}-admin`, 'password', 'admin')).id;
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
  for (const key of ['a', 'b', 'c'] as const) await unregisterGroup(jidOf(key));
  await unregisterGroup(`ui-${instance}@web`);
});

beforeEach(() => {
  deleted.length = 0;
  storedAtDelete = [];
  deleteKeys = async (name) => {
    deleted.push(name);
    storedAtDelete.push(storedInstance('a'));
    return 1;
  };
});

describe('releasing a configured sandbox instance deletes its keys', () => {
  test('clearing or changing the instance deletes the keys on it once, before the save', async () => {
    for (const next of [null, 'bar']) {
      deleted.length = 0;
      storedAtDelete = [];
      await setStored('a', { defaultSandboxInstance: 'foo' });
      const res = await patch('a', {
        settings: { defaultSandboxInstance: next },
      });
      expect(res.status).toBe(200);
      expect(deleted).toEqual(['foo']);
      expect(storedAtDelete).toEqual(['foo']);
      expect(storedInstance('a')).toBe(next ?? undefined);
    }
  });

  test('an unchanged value, an instance equal to the folder or a stack-only change deletes nothing', async () => {
    await setStored('a', { defaultSandboxInstance: 'foo' });
    expect(
      (await patch('a', { settings: { defaultSandboxInstance: 'foo' } }))
        .status,
    ).toBe(200);
    expect(
      (await patch('a', { settings: { defaultSandbox: 'php' } })).status,
    ).toBe(200);

    await setStored('a', { defaultSandboxInstance: folders.a });
    expect(
      (await patch('a', { settings: { defaultSandboxInstance: null } })).status,
    ).toBe(200);

    // Renamed onto the instance it clears: the name stays with the project.
    await setStored('a', { defaultSandboxInstance: 'foo' });
    deleted.length = 0;
    const renamed = await patch('a', {
      folder: 'foo',
      settings: { defaultSandboxInstance: null },
    });
    expect(renamed.status).toBe(200);
    expect(deleted).toEqual([folders.a]);
    expect(getGroupByFolder('foo')).toBeDefined();

    // Renaming away from the instance it clears: the rename's key deletion
    // already covers that name, so it is not requested a second time.
    await setStored('a', { defaultSandboxInstance: folders.a });
    deleted.length = 0;
    const moved = await patch('a', {
      folder: `${base}-moved`,
      settings: { defaultSandboxInstance: null },
    });
    expect(moved.status).toBe(200);
    expect(deleted).toEqual([folders.a]);
    await unregisterGroup(jidOf('a'));
  });

  test('a Box failure refuses the save with 502 and keeps the instance', async () => {
    await setStored('a', { defaultSandboxInstance: 'foo' });
    deleteKeys = async () => {
      throw new Error('box down');
    };
    const res = await patch('a', {
      settings: { defaultSandboxInstance: 'bar', gracefulDeploy: true },
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/keys.*settings were not saved/);
    expect(storedInstance('a')).toBe('foo');
    expect(
      getGroupByFolder(folders.a)?.settings?.gracefulDeploy,
    ).toBeUndefined();
  });
});

describe('a sandbox name an in-flight request is taking', () => {
  test('is refused to other requests, and free again once the request has ended', async () => {
    await setStored('a');
    await setStored('b');
    await setStored('c');
    let entered!: () => void;
    const inKeyRelease = new Promise<void>((resolve) => (entered = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    deleteKeys = async (name) => {
      deleted.push(name);
      entered();
      await gate;
      return 0;
    };

    // A deferred rename (parentId present) blocked inside its key release.
    const first = patch('a', { folder: instance, parentId: null });
    await inKeyRelease;

    const secondRename = await patch('b', { folder: instance });
    const otherInstance = await patch('c', {
      settings: { defaultSandboxInstance: instance },
    });
    const created = await send('POST', '/projects', { name: instance });
    expect(secondRename.status).toBe(409);
    expect(otherInstance.status).toBe(400);
    expect(created.status).toBe(409);
    expect(getGroupByFolder(folders.b)).toBeDefined();
    expect(storedInstance('c')).toBeUndefined();
    expect(getGroupByFolder(instance)).toBeUndefined();
    expect(deleted).toEqual([folders.a]);

    open();
    expect((await first).status).toBe(200);
    expect(getGroupByFolder(instance)?.name).toBe('Integration keys a');
    deleted.length = 0;

    // A request refused with a 4xx after it reserved a name does not keep it.
    const refused = await patch('c', {
      settings: { defaultSandboxInstance: 'free-name' },
      name: '  ',
    });
    expect(refused.status).toBe(400);
    const next = await patch('b', {
      settings: { defaultSandboxInstance: 'free-name' },
    });
    expect(next.status).toBe(200);
  });
});
