/**
 * A logged-in human (browser session / user JWT) reaches /mcp/* with the same
 * scope as their per-user main agent, admins included: never the `'*'`
 * wildcard, never another user's personal main.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { projectMembers, projects, users } from '../db/schema.js';
import {
  loadState,
  registerGroup,
  registeredGroups,
  unregisterGroup,
} from '../state-manager.js';
import { mountMcpRoutes } from './mcp-server.js';
import type { McpServerDeps } from './auth.js';

const now = () => new Date().toISOString();
const MEMBER = 'usscope-member-proj';
const OTHER = 'usscope-other-proj';
const MAIN_ALICE = 'main-usscope-alice';
const MAIN_ADMIN = 'main-usscope-admin';
const MAIN_BOB = 'main-usscope-bob';
// Squatter: a plain project holding DAVE's main folder name, owned by BOB.
const MAIN_DAVE = 'main-usscope-dave';
const ALICE = { id: 'usscope-alice', username: 'usscope-Alice', role: 'user' };
const ADMIN = { id: 'usscope-admin', username: 'usscope-admin', role: 'admin' };
const CAROL = { id: 'usscope-carol', username: 'usscope-carol', role: 'user' };
const DAVE = { id: 'usscope-dave', username: 'usscope-dave', role: 'user' };
const BOB_ID = 'usscope-bob';

const groupRows: Array<[string, string, boolean]> = [
  [MEMBER, BOB_ID, false],
  [OTHER, BOB_ID, false],
  [MAIN_ALICE, ALICE.id, true],
  [MAIN_ADMIN, ADMIN.id, true],
  [MAIN_BOB, BOB_ID, true],
  [MAIN_DAVE, BOB_ID, false],
];

const initializeMessage = {
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

describe('MCP scope for logged-in users', () => {
  let server: Server;
  let baseUrl: string;
  let nextId = 0;

  beforeAll(async () => {
    await initDatabase(':memory:');
    const db = drizzleDbRef.current;
    for (const [id, username, role] of [
      [ALICE.id, ALICE.username, 'user'],
      [ADMIN.id, ADMIN.username, 'admin'],
      [CAROL.id, CAROL.username, 'user'],
      [DAVE.id, DAVE.username, 'user'],
      [BOB_ID, BOB_ID, 'user'],
    ]) {
      await db.insert(users).values({
        id,
        username,
        password_hash: 'unused',
        role,
        created_at: now(),
        disabled: 0,
      });
    }
    for (const [folder, owner, isMain] of groupRows) {
      await db.insert(projects).values({
        id: folder,
        jid: `${folder}@usscope`,
        name: folder,
        folder,
        trigger: '!',
        added_at: now(),
        is_main: isMain ? 1 : 0,
        user_id: owner,
      });
    }
    await db.insert(projectMembers).values({
      user_id: ALICE.id,
      project_id: MEMBER,
      access_level: 'editor',
      created_at: now(),
    });
    await loadState();
    for (const [folder, owner, isMain] of groupRows) {
      await registerGroup(`${folder}@usscope`, {
        name: folder,
        folder,
        jid: `${folder}@usscope`,
        trigger: '!',
        added_at: now(),
        user_id: owner,
        ...(isMain ? { is_main: true } : {}),
      });
    }

    const app = express();
    app.use(express.json());
    // Stand-in for the auth middleware: a browser session as a user credential,
    // with the empty-permissions scope http-service.ts assigns to every human.
    app.use((req, _res, next) => {
      const raw = req.headers['x-test-user'];
      if (typeof raw === 'string') {
        const user = JSON.parse(raw);
        (req as any).authUser = user;
        (req as any).authCredentialKind = 'user';
        req.tokenScope = {
          group_folder: `main-${user.username.toLowerCase()}`,
          permissions: {},
        };
      }
      next();
    });
    mountMcpRoutes(app, {
      getRegisteredGroups: () => registeredGroups,
    } as McpServerDeps);
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [folder] of groupRows)
      await unregisterGroup(`${folder}@usscope`);
  });

  async function rpc(
    user: object,
    message: Record<string, unknown>,
    session?: string,
  ) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-test-user': JSON.stringify(user),
    };
    if (session) {
      headers['mcp-session-id'] = session;
      headers['mcp-protocol-version'] = '2025-06-18';
    }
    const isNotification = String(message.method).startsWith('notifications/');
    const res = await fetch(`${baseUrl}/mcp/carapa-orchestrator`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(isNotification ? {} : { id: ++nextId }),
        ...message,
      }),
    });
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    const body = dataLine ? JSON.parse(dataLine.slice(5)) : undefined;
    return {
      status: res.status,
      session: res.headers.get('mcp-session-id') ?? session,
      result: body?.result,
    };
  }

  async function open(user: object) {
    const init = await rpc(user, initializeMessage);
    expect(init.status).toBe(200);
    await rpc(user, { method: 'notifications/initialized' }, init.session);
    return init.session!;
  }

  const listTasks = (user: object, session: string, project_id: string) =>
    rpc(
      user,
      {
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: { project_id } },
      },
      session,
    );

  const toolNames = async (user: object) => {
    const session = await open(user);
    const res = await rpc(user, { method: 'tools/list' }, session);
    return ((res.result?.tools ?? []) as Array<{ name: string }>).map(
      (t) => t.name,
    );
  };

  test('non-admin: member project allowed, non-member project denied, no mainOnly tool', async () => {
    const session = await open(ALICE);
    const denied = await listTasks(ALICE, session, OTHER);
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain('Unauthorized');
    const allowed = await listTasks(ALICE, session, MEMBER);
    expect(allowed.result.isError).toBeUndefined();

    const names = await toolNames(ALICE);
    expect(names).toContain('list_tasks');
    expect(names).not.toContain('register_group');
  });

  test("admin: another user's main is denied, own member-less reach has no wildcard", async () => {
    const session = await open(ADMIN);
    for (const folder of [MAIN_BOB, OTHER]) {
      const denied = await listTasks(ADMIN, session, folder);
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0].text).toContain('Unauthorized');
    }
    const own = await listTasks(ADMIN, session, MAIN_ADMIN);
    expect(own.result.isError).toBeUndefined();
  });

  test('missing main group fails closed with no permissions', async () => {
    const session = await open(CAROL);
    // The tool is not even registered, so no call can succeed.
    for (const folder of [MEMBER, MAIN_ALICE, 'main-usscope-carol']) {
      const denied = await listTasks(CAROL, session, folder);
      expect(denied.result?.isError ?? true).toBe(true);
    }
    expect(await toolNames(CAROL)).not.toContain('list_tasks');
  });

  test("a main folder held by another user's non-main project fails closed", async () => {
    const session = await open(DAVE);
    const denied = await listTasks(DAVE, session, MAIN_DAVE);
    expect(denied.result?.isError ?? true).toBe(true);
    expect(await toolNames(DAVE)).not.toContain('list_tasks');
  });

  test('resume works with unchanged membership and is rejected after a change', async () => {
    const session = await open(ALICE);
    expect((await listTasks(ALICE, session, MEMBER)).status).toBe(200);
    expect((await listTasks(ALICE, session, MEMBER)).result.isError).toBe(
      undefined,
    );

    await drizzleDbRef.current.insert(projectMembers).values({
      user_id: ALICE.id,
      project_id: OTHER,
      access_level: 'viewer',
      created_at: now(),
    });
    expect((await listTasks(ALICE, session, OTHER)).status).toBe(404);
  });
});
