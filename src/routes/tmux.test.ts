/**
 * HTTP integration tests for the tmux HTTP bridge in src/routes/tmux.ts.
 *
 * Focus: the three new security gates added by
 * "Harden tmux input/stream handlers: instance check, base64 cap + validation"
 * (task-1782817787543-qt77dk):
 *
 *   1. requireStreamForInstance() — a streamId issued for instance A MUST
 *      be rejected with 404 when used against instance B's URL across all
 *      four handlers (input, resize, close, output). Without this gate a
 *      caller authorized for instance A could drive keystrokes into
 *      instance B's tmux session.
 *   2. POST /input enforces a 64 KiB base64 length cap → 413.
 *   3. POST /input enforces the base64 alphabet → 400 on non-base64 input.
 *
 * Mocks strategy: we stub `../lib/tmux-client.js` with a fake `getTmuxClient`
 * that returns a TmuxClient-shaped object whose `getRecord` returns whatever
 * the test wants, and whose `sendKeys`/`resize`/`close`/`subscribe`/`replay`
 * record calls. We stub `../lib/on-demand-sandboxes.js` with a fake
 * OnDemandSandboxes that `findByInstance` returns a project the test
 * controls. The real `userHasExplicitGroupAccess` is exercised — admin users
 * bypass it, so we can skip the project_members seed and just use the
 * admin auth header.
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

import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { createConversation } from '../db.js';
import { projects } from '../db/schema.js';
import {
  createUser,
  upsertConversationMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import { truncateTestDb } from '../test-helpers.js';

import type { TmuxClient, TmuxSessionRecord } from '../lib/tmux-client.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

const _testProject = 'tmux-test-proj';
const _sharedChildProject = 'tmux-test-child';
const _routeGroups: Record<string, any> = {
  [_testProject]: {
    folder: _testProject,
    name: 'Tmux owner',
    trigger: '@owner',
    added_at: new Date().toISOString(),
    settings: {
      isParent: true,
      sandboxOwnership: 'shared',
      defaultSandbox: 'carapa-bot',
    },
  },
  [_sharedChildProject]: {
    folder: _sharedChildProject,
    name: 'Tmux child',
    parentId: _testProject,
    trigger: '@child',
    added_at: new Date().toISOString(),
    settings: { workspacePath: 'child' },
  },
};

// index.js has top-level process.on signal handlers and WhatsApp init; mock
// it so the route's transitive imports through _helpers.ts → state-manager
// resolve cleanly.
mock.module('../index.js', () => ({
  registeredGroups: _routeGroups,
  updateGroup: mock(() => {}),
  getGroupByFolder: mock((folder: string) => _routeGroups[folder]),
  getGroupEntryByFolder: mock(() => undefined),
}));
mock.module('../state-manager.js', () => ({
  registeredGroups: _routeGroups,
  getGroupByFolder: mock((folder: string) => _routeGroups[folder]),
}));

// Fake on-demand tracker. The auth gate in tmux.ts uses
// `getOnDemandSandboxes().findByInstance(instance)` to resolve the
// (projectId, stack, service, instance) tuple for a request. The route
// then calls `userHasExplicitGroupAccess(req, projectId)` — admin role bypasses
// this, so we can drive the auth gate to "ok" by sending the admin
// `x-test-auth` header. The fake's `findByInstance` always returns a
// record pointing at our test project so the gate resolves.
mock.module('../lib/on-demand-sandboxes.js', () => ({
  getOnDemandSandboxes: () => ({
    findByInstance: (_instance: string) => ({
      projectId: _testProject,
      stack: 'carapa-bot',
      service: 'agent',
      instance: _instance,
      createdAt: Date.now(),
    }),
  }),
  onDemandRecordKey: (r: { projectId: string; shellTabId?: string }) => {
    return r.shellTabId ? `${r.projectId}:${r.shellTabId}` : r.projectId;
  },
}));

// Fake TmuxClient. The route calls these methods in the order
//   1. requireStreamForInstance(client, streamId, params, res)
//      → client.getRecord(streamId)
//   2. (input)  client.sendKeys(streamId, keys)        → returns { isError, stdout }
//   3. (resize) client.resize(streamId, cols, rows)    → returns { isError, stdout }
//   4. (close)  client.close(streamId, { kill })       → returns void
//   5. (output) client.replay(streamId)                → returns string
//             + client.subscribe(streamId, onChunk)   → returns unsubscribe fn
//
// We record every call so tests can assert the right method was issued
// (or that NO method was issued when we expect the route to short-circuit).
interface FakeTmuxClient {
  getRecord: (streamId: string) => TmuxSessionRecord | undefined;
  sendKeysCalls: Array<{ streamId: string; keys: string }>;
  sendKeys: (
    streamId: string,
    keys: string,
  ) => Promise<{ isError: boolean; stdout: string }>;
  resizeCalls: Array<{ streamId: string; cols: number; rows: number }>;
  resize: (
    streamId: string,
    cols: number,
    rows: number,
  ) => Promise<{ isError: boolean; stdout: string }>;
  closeCalls: Array<{ streamId: string; kill: boolean }>;
  close: (streamId: string, opts: { kill?: boolean }) => Promise<void>;
  replayCalls: string[];
  replay: (streamId: string) => Promise<string>;
  subscribeCalls: string[];
  subscribe: (
    streamId: string,
    onChunk: (sid: string, chunk: string) => void,
  ) => () => void;
  subscribeExit: (
    streamId: string,
    onExit: (sid: string) => void,
  ) => () => void;
}

function makeFakeClient(): FakeTmuxClient {
  return {
    sendKeysCalls: [],
    resizeCalls: [],
    closeCalls: [],
    replayCalls: [],
    subscribeCalls: [],
    // Defaults; tests overwrite `getRecord` for the specific scenario.
    getRecord: (_streamId: string) => undefined,
    async sendKeys(streamId, keys) {
      this.sendKeysCalls.push({ streamId, keys });
      return { isError: false, stdout: '' };
    },
    async resize(streamId, cols, rows) {
      this.resizeCalls.push({ streamId, cols, rows });
      return { isError: false, stdout: '' };
    },
    async close(streamId, opts) {
      this.closeCalls.push({ streamId, kill: opts?.kill ?? false });
    },
    async replay(streamId) {
      this.replayCalls.push(streamId);
      return '';
    },
    subscribe(_streamId, _onChunk) {
      this.subscribeCalls.push(_streamId);
      return () => {
        /* no-op unsubscribe */
      };
    },
    subscribeExit() {
      return () => {
        /* no-op unsubscribe */
      };
    },
  };
}

let _fakeClient: FakeTmuxClient = makeFakeClient();

mock.module('../lib/tmux-client.js', () => ({
  getTmuxClient: () => _fakeClient as unknown as TmuxClient,
}));

// ─── Dynamic router import (after mocks are registered) ──────────────────────

const { default: tmuxRouter } = await import('../routes/tmux.js');

// ─── Test server ──────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

const ADMIN = { id: 'test-admin', role: 'admin' } as const;

beforeAll(async () => {
  await initDatabase(':memory:');

  const app = express();
  app.use(express.json());
  // Inject req.authUser from `x-test-auth`. Admin role bypasses
  // userHasExplicitGroupAccess, so we don't need to seed project_members.
  app.use((req: any, _res, next) => {
    const raw = req.headers['x-test-auth'];
    if (typeof raw === 'string') {
      try {
        req.authUser = JSON.parse(raw);
      } catch {
        req.authUser = null;
      }
    }
    const scope = req.headers['x-test-scope'];
    if (typeof scope === 'string') {
      try {
        req.tokenScope = JSON.parse(scope);
      } catch {
        req.tokenScope = null;
      }
    }
    next();
  });
  app.use('/api', tmuxRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  await truncateTestDb();
  // Reset the fake client between tests so call lists don't leak.
  _fakeClient = makeFakeClient();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function post(path: string, body: string = '{}') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'x-test-auth': JSON.stringify(ADMIN),
      'Content-Type': 'application/json',
    },
    body,
  });
}

function postAsChild(path: string, body: string = '{}') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'x-test-scope': JSON.stringify({ group_folder: _sharedChildProject }),
      'Content-Type': 'application/json',
    },
    body,
  });
}

function del(path: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'x-test-auth': JSON.stringify(ADMIN) },
  });
}

function get(path: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { 'x-test-auth': JSON.stringify(ADMIN) },
  });
}

/** Build a TmuxSessionRecord for a given (stack, service, instance) triple. */
function makeRecord(
  stack: string,
  service: string,
  instance: string,
): TmuxSessionRecord {
  return {
    taskId: 'task-1',
    stack,
    service,
    instance,
    session: 'tmux-session-1',
    createdAt: 0,
  };
}

describe('tmux shared-sandbox authorization', () => {
  test('a child-scoped caller can operate inherited parent tmux sessions', async () => {
    _fakeClient.getRecord = (streamId) =>
      streamId === 'shared-stream'
        ? makeRecord('carapa-bot', 'agent', _testProject)
        : undefined;

    const res = await postAsChild(
      `/sandboxes/carapa-bot/agent/${_testProject}/tmux/sessions/shared-stream/input`,
      JSON.stringify({ data: Buffer.from('pwd\n').toString('base64') }),
    );

    expect(res.status).toBe(200);
    expect(_fakeClient.sendKeysCalls).toEqual([
      { streamId: 'shared-stream', keys: 'pwd\n' },
    ]);
  });
});

describe('tmux session open taskId validation', () => {
  test('rejects task ids that could escape the tmux buffer directory', async () => {
    const res = await postAsChild(
      `/sandboxes/carapa-bot/agent/${_testProject}/tmux/sessions`,
      JSON.stringify({ taskId: '../../groups/other/logs/x' }),
    );

    expect(res.status).toBe(400);
  });
});

describe('tmux chat-only (implicit) project access', () => {
  test('denies implicit users on every route and denies viewer writes and admits editors', async () => {
    await drizzleDbRef.current.insert(projects).values({
      id: _testProject,
      jid: `${_testProject}@web`,
      name: 'Tmux owner',
      folder: _testProject,
      trigger: '@owner',
      added_at: new Date().toISOString(),
    });
    const implicit = await createUser('tmux-chat-only', 'pw-chat-only');
    const member = await createUser('tmux-viewer', 'pw-viewer');
    const conversation = await createConversation(_testProject);
    await upsertConversationMember(implicit.id, conversation.id, 'viewer');
    await upsertProjectMember(member.id, _testProject, 'viewer');
    _fakeClient.getRecord = (streamId) =>
      streamId === 'sid-1'
        ? makeRecord('carapa-bot', 'agent', _testProject)
        : undefined;

    const base = `${baseUrl}/sandboxes/carapa-bot/agent/${_testProject}/tmux/sessions`;
    const as = (user: { id: string; role: string }) => ({
      'x-test-auth': JSON.stringify(user),
      'Content-Type': 'application/json',
    });
    const body = JSON.stringify({
      taskId: 'task-1',
      data: Buffer.from('ls\n').toString('base64'),
      cols: 80,
      rows: 24,
    });
    const requests: Array<[string, string]> = [
      ['POST', base],
      ['POST', `${base}/sid-1/input`],
      ['POST', `${base}/sid-1/resize`],
      ['DELETE', `${base}/sid-1`],
      ['GET', `${base}/sid-1/output`],
    ];
    for (const [method, url] of requests) {
      const res = await fetch(url, {
        method,
        headers: as({ id: implicit.id, role: 'user' }),
        ...(method === 'POST' ? { body } : {}),
      });
      expect(`${method} ${url} ${res.status}`).toContain(' 403');
    }
    expect(_fakeClient.sendKeysCalls).toEqual([]);

    // Viewers are read-only: every write route is denied, output stays open.
    for (const [method, url] of requests.slice(0, 4)) {
      const res = await fetch(url, {
        method,
        headers: as({ id: member.id, role: 'user' }),
        ...(method === 'POST' ? { body } : {}),
      });
      expect(`${method} ${url} ${res.status}`).toContain(' 403');
    }
    expect(_fakeClient.sendKeysCalls).toEqual([]);

    const editor = await createUser('tmux-editor', 'pw-editor');
    await upsertProjectMember(editor.id, _testProject, 'editor');
    const allowed = await fetch(`${base}/sid-1/input`, {
      method: 'POST',
      headers: as({ id: editor.id, role: 'user' }),
      body,
    });
    expect(allowed.status).toBe(200);
  });
});

// ─── Cross-instance 404 gate (security-critical) ─────────────────────────────

describe('tmux handlers: requireStreamForInstance cross-instance gate', () => {
  // A streamId issued for instance A MUST be rejected with 404 when
  // replayed against instance B's URL. Without this gate a caller
  // authorized for A could drive keystrokes into B's tmux session.
  const INSTANCE_A = 'instance-A';
  const INSTANCE_B = 'instance-B';

  beforeEach(() => {
    // The record exists for instance A; the request URL targets B.
    _fakeClient.getRecord = (streamId) =>
      streamId === 'sid-A'
        ? makeRecord('carapa-bot', 'agent', INSTANCE_A)
        : undefined;
  });

  test('POST /input from instance A against streamId of instance B returns 404', async () => {
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE_B}/tmux/sessions/sid-A/input`,
      JSON.stringify({ data: Buffer.from('ls\n').toString('base64') }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown streamId/i);
    expect(_fakeClient.sendKeysCalls).toEqual([]);
  });

  test('POST /resize from instance A against streamId of instance B returns 404', async () => {
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE_B}/tmux/sessions/sid-A/resize`,
      JSON.stringify({ cols: 100, rows: 30 }),
    );
    expect(res.status).toBe(404);
    expect(_fakeClient.resizeCalls).toEqual([]);
  });

  test('DELETE /:streamId from instance A against streamId of instance B returns 404', async () => {
    const res = await del(
      `/sandboxes/carapa-bot/agent/${INSTANCE_B}/tmux/sessions/sid-A`,
    );
    expect(res.status).toBe(404);
    expect(_fakeClient.closeCalls).toEqual([]);
  });

  test('GET /output from instance A against streamId of instance B returns 404', async () => {
    // A cross-instance output request must fail before opening the SSE stream.
    const res = await get(
      `/sandboxes/carapa-bot/agent/${INSTANCE_B}/tmux/sessions/sid-A/output`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown streamId/i);
    // The route MUST NOT have proceeded to subscribe/replay — that
    // would mean we let the cross-instance request through to the
    // client layer, defeating the gate.
    expect(_fakeClient.subscribeCalls).toEqual([]);
    expect(_fakeClient.replayCalls).toEqual([]);
  });

  test('the same streamId from the matching instance passes (sanity check)', async () => {
    // Companion to the 404 tests above: prove the cross-instance gate
    // is what's rejecting, not a bug in the happy path. With the URL
    // matching the record's instance, the input handler proceeds and
    // calls sendKeys on the underlying client.
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE_A}/tmux/sessions/sid-A/input`,
      JSON.stringify({ data: Buffer.from('ls\n').toString('base64') }),
    );
    expect(res.status).toBe(200);
    expect(_fakeClient.sendKeysCalls).toEqual([
      { streamId: 'sid-A', keys: 'ls\n' },
    ]);
  });
});

// ─── 64 KiB base64 cap ───────────────────────────────────────────────────────

describe('POST /input: 64 KiB base64 cap', () => {
  // The cap is a defence against memory exhaustion: a single base64
  // chunk of unbounded size would force the route to allocate the
  // full decoded buffer in memory before forwarding.
  const INSTANCE = 'cap-test-inst';

  beforeEach(() => {
    _fakeClient.getRecord = () => makeRecord('carapa-bot', 'agent', INSTANCE);
  });

  test('returns 413 for input longer than 64 KiB', async () => {
    const oversized = 'A'.repeat(64 * 1024 + 1);
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE}/tmux/sessions/sid-1/input`,
      JSON.stringify({ data: oversized }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/maximum length/i);
    // The 413 short-circuits BEFORE sendKeys — otherwise an oversized
    // payload could still cost the downstream call a TCP write.
    expect(_fakeClient.sendKeysCalls).toEqual([]);
  });

  test('accepts input at exactly 64 KiB (boundary)', async () => {
    // Boundary check: 64 KiB of base64 == 65536 chars. The route
    // rejects STRICTLY LONGER payloads, so the boundary itself must
    // pass through to sendKeys.
    const atCap = 'A'.repeat(64 * 1024);
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE}/tmux/sessions/sid-1/input`,
      JSON.stringify({ data: atCap }),
    );
    expect(res.status).toBe(200);
    expect(_fakeClient.sendKeysCalls).toHaveLength(1);
  });
});

// ─── base64 alphabet validation ──────────────────────────────────────────────

describe('POST /input: base64 alphabet validation', () => {
  // Without the alphabet check, an attacker can pass arbitrary bytes —
  // including nulls, newlines, or shell metacharacters — through the
  // body unmolested. Buffer.from(_, 'base64') is permissive: it stops
  // at the first invalid char and silently truncates the input, so the
  // route must reject up front.
  const INSTANCE = 'b64-test-inst';

  beforeEach(() => {
    _fakeClient.getRecord = () => makeRecord('carapa-bot', 'agent', INSTANCE);
  });

  test('returns 400 for input containing a non-base64 character', async () => {
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE}/tmux/sessions/sid-1/input`,
      JSON.stringify({ data: 'not-base64!@#$%' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not valid base64/i);
    expect(_fakeClient.sendKeysCalls).toEqual([]);
  });

  test('accepts a valid base64 payload (sanity check)', async () => {
    // Companion: prove the regex isn't over-restrictive. The alphabet
    // is [A-Za-z0-9+/] with optional `=` padding; "aGVsbG8=" is the
    // base64 encoding of "hello".
    const res = await post(
      `/sandboxes/carapa-bot/agent/${INSTANCE}/tmux/sessions/sid-1/input`,
      JSON.stringify({ data: 'aGVsbG8=' }),
    );
    expect(res.status).toBe(200);
    expect(_fakeClient.sendKeysCalls).toEqual([
      { streamId: 'sid-1', keys: 'hello' },
    ]);
  });
});
