import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createConversation,
  createUser,
  getUserById,
  initDatabase,
} from '../db.js';
import {
  upsertConversationMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import { enforceProjectAccess } from './projects.js';
import {
  createProjectIntegrationsRouter,
  humanDeviceUser,
} from './provider-accounts.js';

const tag = `integrations-${process.pid}`;
const KEY_ID = '11111111-1111-4111-8111-111111111111';
const ALLOW = [{ method: 'GET', path: '/api/v4/projects' }];
type Who =
  | 'admin'
  | 'owner'
  | 'ownerMember'
  | 'editor'
  | 'viewer'
  | 'chatOnly'
  | 'agent'
  | 'ownerAgentCredential';
const users: Record<string, string> = {};
const jids: string[] = [];
let server: Server;
let baseUrl: string;
let boxCalls: Array<{ method: string; url: string; body: any }> = [];
// The project the current request addresses; Box lists its key under that binding.
let requested = '';

const folder = (name: string) => `${tag}-${name}`;

async function project(
  name: string,
  group: {
    user_id?: string;
    is_main?: boolean;
    parentId?: string;
    settings?: Record<string, unknown>;
  },
  members: Record<string, 'owner' | 'editor' | 'viewer'> = {},
) {
  const jid = `${folder(name)}@web`;
  jids.push(jid);
  await registerGroup(jid, {
    jid,
    name,
    folder: folder(name),
    trigger: '@x',
    added_at: new Date().toISOString(),
    ...group,
    settings: { status: 'running', ...group.settings },
  });
  for (const [who, level] of Object.entries(members))
    await upsertProjectMember(users[who]!, folder(name), level);
}

async function call(
  who: Who,
  name: string,
  method = 'GET',
  body?: unknown,
  suffix = '',
) {
  requested = folder(name);
  const response = await fetch(
    `${baseUrl}/api/projects/${folder(name)}/integrations${suffix}`,
    {
      method,
      headers: { 'content-type': 'application/json', 'x-test-who': who },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as any,
  };
}

/** All four routes for one caller, one after another (`requested` is shared). */
async function allRoutes(who: Who, name: string) {
  return [
    await call(who, name),
    await call(who, name, 'POST', {
      provider: 'gitlab',
      host: 'https://gitlab.example.com',
      apiKey: 'k',
      allow: ALLOW,
    }),
    await call(who, name, 'PATCH', { allow: ALLOW }, `/${KEY_ID}`),
    await call(who, name, 'DELETE', undefined, `/${KEY_ID}`),
  ];
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  for (const [name, role] of [
    ['admin', 'admin'],
    ['owner', 'user'],
    ['ownerMember', 'user'],
    ['editor', 'user'],
    ['viewer', 'user'],
    ['chatOnly', 'user'],
  ] as const)
    users[name] = (await createUser(`${tag}-${name}`, 'password', role)).id;

  // The Box account listing: one key on the stack/instance of `shared`.
  const upstream = (async (url: any, init: any) => {
    boxCalls.push({
      method: init.method,
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const { stack, instance } = resolveEffectiveSandbox(requested);
    return Response.json({
      accounts: [
        { id: KEY_ID, scope: 'project', project: { stack, instance } },
      ],
    });
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    const who = String(req.headers['x-test-who']) as Who;
    if (who === 'agent') {
      // A project-scoped agent bearer: no user, a token scope.
      req.tokenScope = { group_folder: folder('own'), permissions: [] };
      req.authCredentialKind = 'agent';
    } else {
      // `ownerAgentCredential`: a valid owner session whose accepted credential is an agent token.
      req.authUser = await getUserById(
        users[who === 'ownerAgentCredential' ? 'owner' : who]!,
      );
      req.authCredentialKind =
        who === 'ownerAgentCredential' ? 'agent' : 'user';
    }
    req.authDeviceId = 'device';
    req.headers['x-carapa-device-id'] = 'device';
    next();
  });
  // The production order: the project gate (projects router), then the human check.
  app.use('/api/projects/:pid', enforceProjectAccess);
  app.use('/api/projects/:pid/integrations', humanDeviceUser);
  app.use(
    '/api',
    createProjectIntegrationsRouter(upstream, {
      url: 'http://box.test',
      token: 'box-token',
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await project(
    'own',
    { user_id: users.owner },
    {
      ownerMember: 'owner',
      editor: 'editor',
      viewer: 'viewer',
      admin: 'viewer',
    },
  );
  // Chat-only: a member of one conversation, nothing else.
  const conversation = await createConversation(folder('own'), {
    ownerUserId: users.owner,
  });
  await upsertConversationMember(users.chatOnly!, conversation.id, 'viewer');
  await project('free', {});
  await project('adminOwn', { user_id: users.admin });
  await project('other', { user_id: users.owner }, { editor: 'editor' });
  await project('main', { is_main: true, user_id: users.owner });
  await project(
    'parent',
    {
      user_id: users.owner,
      settings: { isParent: true, sandboxOwnership: 'shared' },
    },
    { editor: 'editor' },
  );
  await project(
    'child',
    { user_id: users.editor, parentId: folder('parent') },
    // The parent's registered owner reaches the child as an editor member.
    { ownerMember: 'owner', owner: 'editor' },
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const jid of jids) await unregisterGroup(jid);
});

beforeEach(() => {
  boxCalls = [];
});

describe('project integrations authorization', () => {
  test('a non-admin registered owner and an owner member use all four routes', async () => {
    for (const who of ['owner', 'ownerMember'] as const) {
      const results = await allRoutes(who, 'own');
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    }
  });

  test('editors, viewers and chat-only users are refused on all four routes, with no Box call', async () => {
    const ROUTE = 'Only the project owner can manage integrations';
    const VIEWER = 'Viewers have read-only access to this project';
    const GATE = 'Access denied to this project';
    const expected = {
      // The route refuses an editor; the project gate refuses the rest.
      editor: [ROUTE, ROUTE, ROUTE, ROUTE],
      // A viewer reads through the gate (the route refuses), but its writes
      // are denied by the gate's denylist, not by an allowlist.
      viewer: [ROUTE, VIEWER, VIEWER, VIEWER],
      chatOnly: [GATE, GATE, GATE, GATE],
    } as const;
    for (const who of ['editor', 'viewer', 'chatOnly'] as const) {
      const results = await allRoutes(who, 'own');
      expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
      expect(results.map((r) => r.body.error)).toEqual([...expected[who]]);
    }
    expect(boxCalls).toEqual([]);
  });

  test('an agent credential is refused on all four routes, with no Box call', async () => {
    // A scoped agent bearer without a user, and an agent token that arrives
    // with a valid owner session: both stop at the human check.
    for (const result of await allRoutes('agent', 'own'))
      expect([401, 403]).toContain(result.status);
    for (const result of await allRoutes('ownerAgentCredential', 'own')) {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('Human user credential required');
    }
    expect(boxCalls).toEqual([]);
  });

  test('a board admin works on an ownerless project and on their own', async () => {
    for (const name of ['free', 'adminOwn'])
      expect((await allRoutes('admin', name)).map((r) => r.status)).toEqual([
        200, 200, 200, 200,
      ]);
  });

  test('a board admin is refused on another user’s project, even as editor or viewer member, and on a personal main', async () => {
    for (const name of ['own', 'other', 'main'])
      for (const result of await allRoutes('admin', name))
        expect(result.status).toBe(403);
    // `own` gives the admin viewer membership; `other` gives no membership.
    await upsertProjectMember(users.admin!, folder('other'), 'editor');
    for (const result of await allRoutes('admin', 'other'))
      expect(result.status).toBe(403);
    expect(boxCalls).toEqual([]);
  });

  test('an inheriting child follows the owner of the sandbox', async () => {
    // Owner-level on the child, none on the parent.
    for (const result of await allRoutes('ownerMember', 'child')) {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe(
        `Integrations of this project are managed on ${folder('parent')}`,
      );
    }
    expect(boxCalls).toEqual([]);
    // The parent's owner reaches the child and works on the parent's binding.
    const results = await allRoutes('owner', 'child');
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(results[0]!.body.sandbox).toEqual(
      expect.objectContaining({
        instance: resolveEffectiveSandbox(folder('parent')).instance,
      }),
    );
  });
});

describe('project integrations host rule', () => {
  const post = (who: Who, body: Record<string, unknown>) =>
    call(who, 'own', 'POST', { apiKey: 'k', allow: ALLOW, ...body });
  const REFUSAL =
    'Enter a public host name such as https://gitlab.example.com. An IP address, a host name without a dot or a port needs a board admin';

  test.each([
    { provider: 'gitlab', host: 'https://10.0.0.5' },
    { provider: 'github', host: 'https://localhost' },
    { provider: 'gitlab', host: 'https://gitlab.example.com:8443' },
    { provider: 'gitlab', host: 'https://[::1]' },
    {
      provider: 'custom',
      route: 'crm',
      baseUrl: 'https://10.0.0.5/v1',
      auth: { type: 'bearer' },
    },
  ])('a non-admin owner is refused %o without a Box call', async (body) => {
    const result = await post('owner', body);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(REFUSAL);
    expect(boxCalls).toEqual([]);
  });

  test('a public host name is forwarded', async () => {
    expect(
      (
        await post('owner', {
          provider: 'gitlab',
          host: 'https://gitlab.example.com',
        })
      ).status,
    ).toBe(200);
    expect(boxCalls.some((c) => c.method === 'POST')).toBe(true);
  });

  test('an admin may name an IP address', async () => {
    const result = await call('admin', 'free', 'POST', {
      provider: 'gitlab',
      host: 'https://10.0.0.5',
      apiKey: 'k',
      allow: ALLOW,
    });
    expect(result.status).toBe(200);
    expect(boxCalls.find((c) => c.method === 'POST')?.body.host).toBe(
      'https://10.0.0.5',
    );
  });
});
