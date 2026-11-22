import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createConversation, initDatabase } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  createKnowledgeBase,
  createUser,
  getKbAccessLevel,
  getKnowledgeBase,
  getKnowledgeBaseShares,
  shareKnowledgeBase,
  upsertConversationMember,
  upsertKbMember,
  upsertProjectMember,
} from './db-kb.js';
import { getKnowledgeRouter } from './routes.js';
import usersRouter from '../../routes/users.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-access-'));
let server: Server;
let origin: string;
let kbSeq = 0;

beforeAll(async () => {
  await initDatabase(':memory:');
  const app = express();
  app.use(express.json());
  // Stand-in for the auth middleware: identity comes from a test header.
  app.use((req: any, _res, next) => {
    const raw = req.get('x-test-user');
    if (raw) req.authUser = JSON.parse(raw);
    // Agent (sandbox) token: scope only, no authUser.
    const scope = req.get('x-test-scope');
    if (scope) {
      req.tokenScope = JSON.parse(scope);
      req.authCredentialKind = 'agent';
    }
    next();
  });
  app.use('/api', getKnowledgeRouter());
  app.use('/api', usersRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => truncateTestDb());

afterAll(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedKb() {
  const id = `kb-access-${++kbSeq}`;
  const folder = path.join(root, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'doc.md'), '# doc');
  await createKnowledgeBase({
    id,
    name: id,
    description: null,
    folder_path: folder,
    created_at: Date.now(),
    last_indexed_at: null,
  });
  return { id, folder };
}

async function seedUser(
  name: string,
  level?: 'owner' | 'editor' | 'viewer',
  kb?: string,
) {
  const user = await createUser(name, 'pw', 'user');
  if (level && kb) await upsertKbMember(user.id, kb, level);
  return { id: user.id, role: 'user' };
}

async function call(
  authUser: { id: string; role: string } | null,
  method: string,
  url: string,
  body?: unknown,
  scope?: Record<string, unknown>,
) {
  return fetch(origin + '/api' + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authUser ? { 'x-test-user': JSON.stringify(authUser) } : {}),
      ...(scope ? { 'x-test-scope': JSON.stringify(scope) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const b64 = Buffer.from('hello').toString('base64');

function mutations(kb: string) {
  return {
    upload: [
      'POST',
      `/knowledge/${kb}/files`,
      { name: 'new.md', content: b64 },
    ],
    deleteFile: ['DELETE', `/knowledge/${kb}/files/doc.md`],
    tagsBody: [
      'PATCH',
      `/knowledge/${kb}/files/metadata`,
      { filename: 'doc.md', tags: ['a'] },
    ],
    tagsPath: [
      'PATCH',
      `/knowledge/${kb}/files/doc.md/metadata`,
      { tags: ['b'] },
    ],
    saveMessage: [
      'POST',
      `/knowledge/${kb}/save-message`,
      { content: 'see https://example.com/some-article' },
    ],
    index: ['POST', `/knowledge/${kb}/index`],
    rename: ['PATCH', `/knowledge/${kb}`, { name: 'renamed' }],
    share: ['POST', `/knowledge/${kb}/share`, { group_folder: 'g1' }],
    unshare: ['DELETE', `/knowledge/${kb}/share/g1`],
    deleteKb: ['DELETE', `/knowledge/${kb}`],
  } as Record<string, [string, string, unknown?]>;
}

const EDITOR_ROUTES = [
  'upload',
  'tagsBody',
  'tagsPath',
  'saveMessage',
  'index',
  'deleteFile',
];
const OWNER_ROUTES = ['rename', 'share', 'unshare', 'deleteKb'];

describe('knowledge router access levels', () => {
  test('viewer reads but cannot mutate; the KB survives', async () => {
    const kb = await seedKb();
    const viewer = await seedUser('viewer', 'viewer', kb.id);

    for (const suffix of ['/files', '/tags', '/shares']) {
      expect(
        (await call(viewer, 'GET', `/knowledge/${kb.id}${suffix}`)).status,
      ).toBe(200);
    }
    for (const [name, [method, url, body]] of Object.entries(
      mutations(kb.id),
    )) {
      const res = await call(viewer, method, url, body);
      expect([name, res.status]).toEqual([name, 403]);
      expect(await res.json()).toEqual({
        error: 'Insufficient access level for this knowledge base',
      });
    }
    expect(fs.existsSync(path.join(kb.folder, 'doc.md'))).toBe(true);
    expect(await getKnowledgeBase(kb.id)).toBeTruthy();
    expect(await getKbAccessLevel(viewer.id, kb.id)).toBe('viewer');
  });

  test('editor manages documents but not the KB itself', async () => {
    const kb = await seedKb();
    const editor = await seedUser('editor', 'editor', kb.id);
    const all = mutations(kb.id);

    for (const name of OWNER_ROUTES) {
      const [method, url, body] = all[name];
      const res = await call(editor, method, url, body);
      expect([name, res.status]).toEqual([name, 403]);
    }
    expect(await getKnowledgeBase(kb.id)).toBeTruthy();
    for (const name of EDITOR_ROUTES) {
      const [method, url, body] = all[name];
      const res = await call(editor, method, url, body);
      expect([name, res.status]).toEqual([name, 200]);
    }
  });

  test('owner can rename, share, unshare and delete', async () => {
    const kb = await seedKb();
    const owner = await seedUser('owner', 'owner', kb.id);
    await upsertProjectMember(owner.id, 'g1', 'editor');
    const all = mutations(kb.id);

    for (const name of ['rename', 'share', 'unshare', 'deleteKb']) {
      const [method, url, body] = all[name];
      const res = await call(owner, method, url, body);
      expect([name, res.status]).toEqual([name, 200]);
    }
    expect(await getKnowledgeBase(kb.id)).toBeFalsy();
  });

  test('create and rename reject blank names and store trimmed ones', async () => {
    const kb = await seedKb();
    const owner = await seedUser('owner', 'owner', kb.id);

    for (const name of ['', '   ', 42, null]) {
      const created = await call(owner, 'POST', '/knowledge', { name });
      expect([name, created.status]).toEqual([name, 400]);
      expect(await created.json()).toEqual({ error: 'Name is required' });
      const renamed = await call(owner, 'PATCH', `/knowledge/${kb.id}`, {
        name,
      });
      expect([name, renamed.status]).toEqual([name, 400]);
    }
    expect((await getKnowledgeBase(kb.id))?.name).toBe(kb.id);

    const created = await call(owner, 'POST', '/knowledge', {
      name: '  Docs  ',
    });
    expect(created.status).toBe(200);
    const createdKb = (await created.json()) as {
      name: string;
      folder_path: string;
    };
    expect(createdKb.name).toBe('Docs');
    fs.rmSync(createdKb.folder_path, { recursive: true, force: true });

    const renamed = await call(owner, 'PATCH', `/knowledge/${kb.id}`, {
      name: '  Handbook ',
    });
    expect(((await renamed.json()) as { name: string }).name).toBe('Handbook');
    expect((await getKnowledgeBase(kb.id))?.name).toBe('Handbook');

    const described = await call(owner, 'PATCH', `/knowledge/${kb.id}`, {
      description: 'only text',
    });
    expect(described.status).toBe(200);
    expect(await described.json()).toMatchObject({
      name: 'Handbook',
      description: 'only text',
    });
  });

  test('sharing into a project requires explicit owner/editor access to it', async () => {
    const kb = await seedKb();
    const owner = await seedUser('share-owner', 'owner', kb.id);
    const share = (folder: string) =>
      call(owner, 'POST', `/knowledge/${kb.id}/share`, {
        group_folder: folder,
      });

    const denied = await share('victim');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'Insufficient access to the target project',
    });

    await upsertProjectMember(owner.id, 'victim', 'viewer');
    expect((await share('victim')).status).toBe(403);

    const conversation = await createConversation('chat-only');
    await upsertConversationMember(owner.id, conversation.id, 'owner');
    expect((await share('chat-only')).status).toBe(403);
    expect(await getKnowledgeBaseShares(kb.id)).toEqual([]);

    await upsertProjectMember(owner.id, 'victim', 'editor');
    expect((await share('victim')).status).toBe(200);
    expect(await getKnowledgeBaseShares(kb.id)).toEqual(['victim']);
  });

  test('admin without membership and unauthenticated callers keep full access', async () => {
    const admin = { id: 'admin-user', role: 'admin' };
    const kb = await seedKb();
    expect(
      (
        await call(admin, 'POST', `/knowledge/${kb.id}/share`, {
          group_folder: 'any',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(null, 'POST', `/knowledge/${kb.id}/share`, {
          group_folder: 'other',
        })
      ).status,
    ).toBe(200);
    expect((await call(admin, 'DELETE', `/knowledge/${kb.id}`)).status).toBe(
      200,
    );

    const other = await seedKb();
    expect(
      (await call(null, 'PATCH', `/knowledge/${other.id}`, { name: 'x' }))
        .status,
    ).toBe(200);
  });

  test('admin is closed out of a KB owned by another user unless a member', async () => {
    const kb = await seedKb();
    const open = await seedKb();
    await seedUser('kb-owner', 'owner', kb.id);
    const admin = await createUser('kb-admin', 'pw', 'admin');
    const asAdmin = { id: admin.id, role: 'admin' };

    for (const [method, url] of [
      ['GET', `/knowledge/${kb.id}/files`],
      ['DELETE', `/knowledge/${kb.id}`],
      ['GET', `/knowledge-bases/${kb.id}/members`],
    ]) {
      expect([url, (await call(asAdmin, method, url)).status]).toEqual([
        url,
        403,
      ]);
    }
    const listed = async () =>
      ((await (await call(asAdmin, 'GET', '/knowledge')).json()) as any[])
        .map((entry) => entry.id)
        .sort();
    expect(await listed()).toEqual([open.id]);
    expect(
      (await call(asAdmin, 'GET', `/knowledge/${open.id}/files`)).status,
    ).toBe(200);

    await upsertKbMember(admin.id, kb.id, 'viewer');
    expect(await listed()).toEqual([kb.id, open.id].sort());
    expect(
      (await call(asAdmin, 'GET', `/knowledge/${kb.id}/files`)).status,
    ).toBe(200);
    expect((await call(asAdmin, 'DELETE', `/knowledge/${kb.id}`)).status).toBe(
      403,
    );
  });

  test('non-member is denied with the access message', async () => {
    const kb = await seedKb();
    const stranger = await seedUser('stranger');
    const res = await call(stranger, 'GET', `/knowledge/${kb.id}/files`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Access denied to this knowledge base',
    });
  });

  test('member list is visible only to members and admins', async () => {
    const kb = await seedKb();
    const viewer = await seedUser('list-viewer', 'viewer', kb.id);
    const stranger = await seedUser('list-stranger');

    expect(
      (await call(stranger, 'GET', `/knowledge-bases/${kb.id}/members`)).status,
    ).toBe(403);
    expect(
      (await call(viewer, 'GET', `/knowledge-bases/${kb.id}/members`)).status,
    ).toBe(200);
    expect(
      (
        await call(
          { id: 'admin-user', role: 'admin' },
          'GET',
          `/knowledge-bases/${kb.id}/members`,
        )
      ).status,
    ).toBe(200);
  });

  describe('agent tokens', () => {
    const agent = (folder: string) => ({
      group_folder: folder,
      permissions: { '*': ['*:*'] },
    });
    const asAgent = (
      folder: string,
      method: string,
      url: string,
      body?: unknown,
    ) => call(null, method, url, body, agent(folder));

    test('agent only sees and touches KBs shared with its project', async () => {
      const shared = await seedKb();
      const other = await seedKb();
      await shareKnowledgeBase(shared.id, 'proj-a');

      const list = (await (
        await asAgent('proj-a', 'GET', '/knowledge')
      ).json()) as { id: string }[];
      expect(list.map((kb) => kb.id)).toEqual([shared.id]);

      for (const [name, [method, url, body]] of Object.entries(
        mutations(other.id),
      )) {
        const res = await asAgent('proj-a', method, url, body);
        expect([name, res.status]).toEqual([name, 403]);
      }
      expect(
        (await asAgent('proj-a', 'GET', `/knowledge/${other.id}/files`)).status,
      ).toBe(403);
      expect(fs.existsSync(path.join(other.folder, 'doc.md'))).toBe(true);
      expect(await getKnowledgeBase(other.id)).toBeTruthy();
    });

    test('agent manages documents on a shared KB but not the KB itself', async () => {
      const kb = await seedKb();
      await shareKnowledgeBase(kb.id, 'proj-a');
      const all = mutations(kb.id);

      expect(
        (await asAgent('proj-a', 'GET', `/knowledge/${kb.id}/files`)).status,
      ).toBe(200);
      for (const name of OWNER_ROUTES) {
        const [method, url, body] = all[name];
        const res = await asAgent('proj-a', method, url, body);
        expect([name, res.status]).toEqual([name, 403]);
      }
      expect(await getKnowledgeBase(kb.id)).toBeTruthy();
      const [method, url, body] = all.upload;
      expect((await asAgent('proj-a', method, url, body)).status).toBe(200);
    });

    test('agent may read only its own project shares and cannot create KBs', async () => {
      const kb = await seedKb();
      await shareKnowledgeBase(kb.id, 'proj-a');

      expect(
        (await asAgent('proj-a', 'GET', '/knowledge/shared/proj-b')).status,
      ).toBe(403);
      expect(
        (await asAgent('proj-a', 'GET', '/knowledge/shared/proj-a')).status,
      ).toBe(200);
      expect(
        (await asAgent('proj-a', 'POST', '/knowledge', { name: 'new' })).status,
      ).toBe(403);
    });
  });
});
