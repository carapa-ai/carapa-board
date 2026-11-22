import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import express from 'express';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUser, initDatabase } from '../db.js';
import { getGroupDir } from '../group-dir.js';
import { PROTECTED_GROUP_PATHS } from '../lib/group-file-ops.js';
import { upsertProjectMember } from '../modules/knowledge/db-kb.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import projectsRouter from './projects.js';

const folder = `project-file-mutations-${process.pid}`;
const jid = `${folder}@web`;
const ROUTES = ['rename', 'move', 'delete'] as const;
let server: Server;
let baseUrl: string;
let outside: string;
let users: Record<'owner' | 'editor' | 'viewer' | 'other', string>;

const root = () => getGroupDir(folder);
const exists = (rel: string) =>
  fsp.lstat(path.join(root(), rel)).then(
    () => true,
    () => false,
  );

function call(
  user: string | 'agent' | undefined,
  action: (typeof ROUTES)[number],
  body: Record<string, unknown>,
) {
  return fetch(`${baseUrl}/projects/${folder}/files/group/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(user === 'agent'
        ? { 'x-test-token': '1' }
        : user
          ? { 'x-test-user': user }
          : {}),
    },
    body: JSON.stringify(body),
  });
}

/** One valid request per route against the seeded tree. */
const VALID = {
  rename: { path: 'notes.txt', newName: 'renamed.txt' },
  move: { path: 'notes.txt', destination: 'dest' },
  delete: { path: 'docs' },
};

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  const tag = `fmut-${process.pid}`;
  users = {
    owner: (await createUser(`${tag}-owner`, 'pw', 'user')).id,
    editor: (await createUser(`${tag}-editor`, 'pw', 'user')).id,
    viewer: (await createUser(`${tag}-viewer`, 'pw', 'user')).id,
    other: (await createUser(`${tag}-other`, 'pw', 'user')).id,
  };
  await registerGroup(jid, {
    jid,
    name: 'File mutations',
    folder,
    trigger: '!',
    added_at: new Date().toISOString(),
    user_id: users.owner,
  } as never);
  await upsertProjectMember(users.editor, folder, 'editor');
  await upsertProjectMember(users.viewer, folder, 'viewer');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.header('x-test-user');
    if (id) Object.assign(req, { authUser: { id, role: 'user' } });
    else if (req.header('x-test-token'))
      Object.assign(req, { tokenScope: { group_folder: folder } });
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'group-mutations-'));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await unregisterGroup(jid);
  await fsp.rm(root(), { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

beforeEach(async () => {
  await fsp.rm(root(), { recursive: true, force: true });
  for (const dir of [
    'docs/sub',
    'dest',
    'artifacts',
    'objectives/obj1/dashboard',
  ])
    await fsp.mkdir(path.join(root(), dir), { recursive: true });
  for (const file of [
    'notes.txt',
    'taken.txt',
    'dest/taken.txt',
    'docs/a.md',
    'docs/sub/b.md',
    'artifacts/x.txt',
    'objectives/obj1/notes.md',
    'AGENTS.md',
  ])
    await fsp.writeFile(path.join(root(), file), file);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fsp.symlink(outside, path.join(root(), 'link'));
});

describe('group file mutations: permissions', () => {
  test.each(['owner', 'editor'] as const)(
    '%s can rename, move and delete files and folders',
    async (who) => {
      const rename = await call(users[who], 'rename', VALID.rename);
      expect(rename.status).toBe(200);
      expect(await rename.json()).toMatchObject({
        ok: true,
        path: 'renamed.txt',
        from: 'notes.txt',
      });
      expect(await exists('notes.txt')).toBe(false);

      expect(
        (
          await call(users[who], 'move', {
            path: 'renamed.txt',
            destination: 'dest',
          })
        ).status,
      ).toBe(200);
      expect(await exists('dest/renamed.txt')).toBe(true);

      expect((await call(users[who], 'delete', VALID.delete)).status).toBe(200);
      expect(await exists('docs')).toBe(false);
      expect(
        (await call(users[who], 'delete', { path: 'dest/renamed.txt' })).status,
      ).toBe(200);
    },
  );

  test.each([
    ['viewer', () => users.viewer],
    ['non-member', () => users.other],
    ['agent token', () => 'agent' as const],
    ['anonymous', () => undefined],
  ])('%s gets 403 on every route and nothing changes', async (_name, who) => {
    for (const action of ROUTES) {
      expect((await call(who(), action, VALID[action])).status).toBe(403);
    }
    expect(await exists('notes.txt')).toBe(true);
    expect(await exists('docs/a.md')).toBe(true);
  });

  test('the list reports canManage per caller', async () => {
    const list = async (user: string) => {
      const res = await fetch(`${baseUrl}/projects/${folder}/files/group`, {
        headers: { 'x-test-user': user },
      });
      return ((await res.json()) as { canManage: boolean }).canManage;
    };
    expect(await list(users.owner)).toBe(true);
    expect(await list(users.editor)).toBe(true);
    expect(await list(users.viewer)).toBe(false);
  });
});

describe('group file mutations: path safety', () => {
  test.each([
    ['rename', { path: '', newName: 'x' }],
    ['rename', { path: '../escape.txt', newName: 'x' }],
    ['rename', { path: 'docs/../notes.txt', newName: 'x' }],
    ['rename', { path: '/etc/passwd', newName: 'x' }],
    ['rename', { path: 'notes.\0txt', newName: 'x' }],
    ['rename', { path: 'notes.txt', newName: '' }],
    ['rename', { path: 'notes.txt', newName: '..' }],
    ['rename', { path: 'notes.txt', newName: 'a/b' }],
    ['rename', { path: 'notes.txt', newName: 'a\\b' }],
    ['move', { path: 'notes.txt', destination: '../outside' }],
    ['move', { path: 'notes.txt', destination: '/tmp' }],
    ['move', { path: '/notes.txt', destination: 'dest' }],
    ['delete', { path: '..' }],
    ['delete', { path: '/' }],
  ] as const)('refuses %s %j with 400', async (action, body) => {
    expect((await call(users.owner, action, body)).status).toBe(400);
    expect(await exists('notes.txt')).toBe(true);
  });

  test('refuses symlinks as source, component and destination (403)', async () => {
    for (const [action, body] of [
      ['delete', { path: 'link/secret.txt' }],
      ['delete', { path: 'link' }],
      ['rename', { path: 'link/secret.txt', newName: 'x' }],
      ['move', { path: 'link/secret.txt', destination: 'dest' }],
      ['move', { path: 'notes.txt', destination: 'link' }],
      ['rename', { path: 'notes.txt', newName: 'link' }],
    ] as const) {
      expect((await call(users.owner, action, body)).status).toBe(403);
    }
    expect(await fsp.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'secret',
    );
    expect(await exists('link')).toBe(true);
    expect(await exists('notes.txt')).toBe(true);
  });

  test('deleting a folder that contains a symlink is refused before anything is removed', async () => {
    await fsp.symlink(outside, path.join(root(), 'docs/sub/escape'));
    const res = await call(users.owner, 'delete', { path: 'docs' });
    expect(res.status).toBe(403);
    expect(await exists('docs/a.md')).toBe(true);
    expect(await exists('docs/sub/escape')).toBe(true);
    expect(await fsp.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'secret',
    );
  });

  test('moving a folder into itself or a descendant returns 400', async () => {
    for (const destination of ['docs', 'docs/sub'])
      expect(
        (await call(users.owner, 'move', { path: 'docs', destination })).status,
      ).toBe(400);
    expect(await exists('docs/sub/b.md')).toBe(true);
  });

  test('concurrent renames to one name never overwrite: one wins, one gets 409', async () => {
    await fsp.mkdir(path.join(root(), 'one'));
    await fsp.mkdir(path.join(root(), 'two'));
    for (const [a, b] of [
      ['taken.txt', 'notes.txt'],
      ['one', 'two'],
    ]) {
      const results = await Promise.all(
        [a, b].map((p) =>
          call(users.owner, 'rename', { path: p, newName: 'target' }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      await fsp.rm(path.join(root(), 'target'), { recursive: true });
    }
  });

  test('a rename racing an editor save never loses the saved content', async () => {
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(path.join(root(), 'notes.txt'), 'before');
      const url = `${baseUrl}/projects/${folder}/files/editable-content`;
      const loaded = (await (
        await fetch(`${url}?source=group&path=notes.txt`, {
          headers: { 'x-test-user': users.editor },
        })
      ).json()) as { revision: string };
      const [save, rename] = await Promise.all([
        fetch(url, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'x-test-user': users.editor,
          },
          body: JSON.stringify({
            source: 'group',
            path: 'notes.txt',
            content: 'saved',
            expectedRevision: loaded.revision,
          }),
        }),
        call(users.owner, 'rename', VALID.rename),
      ]);
      expect(rename.status).toBe(200);
      if (save.status === 200)
        expect(
          await fsp.readFile(path.join(root(), 'renamed.txt'), 'utf8'),
        ).toBe('saved');
      await fsp.rm(path.join(root(), 'renamed.txt'), { force: true });
    }
  });

  test('a missing source returns 404 and an existing target 409', async () => {
    expect(
      (await call(users.owner, 'delete', { path: 'missing.txt' })).status,
    ).toBe(404);
    expect(
      (
        await call(users.owner, 'rename', {
          path: 'notes.txt',
          newName: 'taken.txt',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(users.owner, 'move', {
          path: 'taken.txt',
          destination: 'dest',
        })
      ).status,
    ).toBe(409);
    expect(
      await fsp.readFile(path.join(root(), 'dest/taken.txt'), 'utf8'),
    ).toBe('dest/taken.txt');
  });
});

describe('group file mutations: protected paths', () => {
  test('every protected root entry is refused for each action', async () => {
    for (const name of PROTECTED_GROUP_PATHS.root) {
      for (const [action, body] of [
        ['rename', { path: name, newName: 'x' }],
        ['move', { path: name, destination: 'dest' }],
        ['delete', { path: name }],
      ] as const) {
        expect((await call(users.owner, action, body)).status).toBe(403);
      }
    }
    expect(await exists('AGENTS.md')).toBe(true);
    expect(await exists('artifacts')).toBe(true);
  });

  test('objective roots and their board files are protected, other contents are not', async () => {
    for (const [action, body] of [
      ['delete', { path: 'objectives/obj1' }],
      ['rename', { path: 'objectives/obj1', newName: 'obj2' }],
      ['delete', { path: 'objectives/obj1/dashboard' }],
      ['move', { path: 'notes.txt', destination: 'objectives/obj1/dashboard' }],
      ['rename', { path: 'notes.txt', newName: 'AGENTS.override.md' }],
    ] as const) {
      expect((await call(users.owner, action, body)).status).toBe(403);
    }
    expect(
      (
        await call(users.owner, 'rename', {
          path: 'objectives/obj1/notes.md',
          newName: 'renamed.md',
        })
      ).status,
    ).toBe(200);
  });

  test('artifacts contents can be changed and moves into artifacts are allowed', async () => {
    expect(
      (
        await call(users.owner, 'move', {
          path: 'notes.txt',
          destination: 'artifacts',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(users.owner, 'delete', { path: 'artifacts/x.txt' })).status,
    ).toBe(200);
    expect(await exists('artifacts/notes.txt')).toBe(true);
  });
});
