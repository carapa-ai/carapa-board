/**
 * HTTP integration tests for the on-demand shell + run-extension endpoints
 * in src/routes/active-runs.ts (project-scoped shells and
 * POST /active-runs/:runId/extend). This file mirrors the setup of
 * `src/routes-tasks.test.ts`: real in-memory PGLite
 * (`initDatabase(':memory:')`) and an `../index.js` mock so the routes
 * under test can import `state-manager` without booting WhatsApp /
 * signal handlers.
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

import {
  initDatabase,
  createConversation,
  createUser,
  insertActiveRun,
  upsertProjectMember,
  upsertConversationMember,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { runFixture, truncateTestDb } from '../test-helpers.js';
import {
  registerStallControl,
  unregisterStallControl,
} from '../sandbox/stall-registry.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

// State-manager owns the folder index used by these routes; mock it directly
// so tests can exercise project-scoped access without booting app state.
const _routeGroups: Record<string, any> = {};
mock.module('../state-manager.js', () => ({
  registeredGroups: _routeGroups,
  registerGroup: mock(() => {}),
  updateGroup: mock(() => {}),
  // Strict lookup: unregistered folders must miss so the "no registered
  // group" 404s stay honest (Bun's mock.module is process-global, so a
  // catch-all here would fabricate groups for suites that load later).
  getGroupByFolder: mock((folder: string) => _routeGroups[folder]),
  getGroupEntryByFolder: mock(() => undefined),
}));

// Stub the on-demand sandbox singleton with a real OnDemandSandboxes
// instance bound to a per-suite temp file. The route calls
// `getOnDemandSandboxes()` to access the tracker, so a single shared
// instance with `clear()` between tests is enough — we don't need
// route-level injection for the GET /shells tests below.
import { OnDemandSandboxes } from '../lib/on-demand-sandboxes.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpIndexPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'active-runs-test-')),
  'on-demand-sandboxes.json',
);
const _testTracker = new OnDemandSandboxes({ indexPath: tmpIndexPath });
mock.module('../lib/on-demand-sandboxes.js', () => ({
  getOnDemandSandboxes: () => _testTracker,
  onDemandRecordKey: (r: { projectId: string; shellTabId?: string }) => {
    return r.shellTabId ? `${r.projectId}:${r.shellTabId}` : r.projectId;
  },
}));

// Spy on the auth-token helpers. The conversation shell's POST/DELETE
// MUST NOT call `revokeGroupTokens` (revokes EVERY token for the group,
// including the running agent's token) and MUST instead call
// `revokeAgentToken` with the specific token the on-demand shell was
// minted. We replace both with in-test stubs that record calls so the
// new tests below can assert the contract.
let onSandboxExec: (() => void) | undefined;
const _authCalls: { method: string; args: string[] }[] = [];
let _sandboxStatusResult = { stdout: 'not found', isError: false };
// When set, `sandboxStatus` rejects instead of answering — the board must
// treat that as "status unknown" rather than "sandbox is stopped".
let _sandboxStatusError: Error | undefined;
mock.module('../mcp/auth-tokens.js', () => ({
  generateAgentToken: mock(async () => {
    const tok = `cat_${Math.random().toString(36).slice(2)}`;
    _authCalls.push({ method: 'generateAgentToken', args: [tok] });
    return tok;
  }),
  revokeAgentToken: mock(async (token: string) => {
    _authCalls.push({ method: 'revokeAgentToken', args: [token] });
    return 1;
  }),
  revokeGroupTokens: mock(async (folder: string) => {
    _authCalls.push({ method: 'revokeGroupTokens', args: [folder] });
    return 0;
  }),
}));

// Stub the CarapaBox sandbox client. The DELETE path calls
// `client.sandboxStop(...)` and (on the per-tab branch) `client.sandboxExec(...)`
// to kill the per-tab tmux session; the POST path calls `client.sandboxStart`
// (we never exercise the POST happy-path here, but stub it anyway so a
// future test that does doesn't trip on a real MCP round-trip).
mock.module('../lib/mcp-client.js', () => ({
  getSandboxClient: () => ({
    sandboxStatus: async (stack: string, instance: string) => {
      _authCalls.push({ method: 'sandboxStatus', args: [stack, instance] });
      if (_sandboxStatusError) throw _sandboxStatusError;
      return _sandboxStatusResult;
    },
    sandboxStop: async (stack: string, instance: string) => {
      _authCalls.push({ method: 'sandboxStop', args: [stack, instance] });
      return { stdout: 'ok', isError: false };
    },
    sandboxStart: async (
      _stack: string,
      _env: unknown,
      _instance: string,
      _service?: string,
    ) => {
      _authCalls.push({ method: 'sandboxStart', args: [_stack, _instance] });
      return { stdout: 'ok', isError: false };
    },
    sandboxExec: async (
      _stack: string,
      _service: string,
      _command: string,
      _options?: {
        instance?: string;
        timeout?: number;
        env?: Record<string, string>;
      },
    ) => {
      // Record the call so tests can assert the per-tab tmux kill
      // was issued (with the right tmux session name).
      _authCalls.push({
        method: 'sandboxExec',
        args: [_stack, _service, _command],
      });
      onSandboxExec?.();
      return { stdout: 'ok', isError: false };
    },
  }),
}));

// ─── Dynamic router import (after mocks are registered) ──────────────────────

const { default: activeRunsRouter, projectShellTmuxSession } =
  await import('../routes/active-runs.js');

test('project shell tmux sessions do not collide after tab ID sanitization', () => {
  expect(projectShellTmuxSession('ab')).not.toBe(
    projectShellTmuxSession('a.b'),
  );
  expect(projectShellTmuxSession('ab')).not.toBe(projectShellTmuxSession('AB'));
  expect(projectShellTmuxSession('a.b')).toMatch(/^shell-ab-[0-9a-f]{12}$/);
  expect(projectShellTmuxSession('AB')).toMatch(/^shell-ab-[0-9a-f]{12}$/);
});

// ─── Test server ──────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Inject req.authUser from the `x-test-auth` header so each test can
  // simulate a different caller (admin, member, stranger, anonymous).
  app.use((req: any, _res, next) => {
    const raw = req.headers['x-test-auth'];
    if (typeof raw === 'string') {
      try {
        req.authUser = JSON.parse(raw);
      } catch {
        req.authUser = null;
      }
    }
    next();
  });
  app.use('/api', activeRunsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server?.close();
});

// ─── Per-test DB reset ────────────────────────────────────────────────────────

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
  _authCalls.length = 0;
  onSandboxExec = undefined;
  _sandboxStatusResult = { stdout: 'not found', isError: false };
  _sandboxStatusError = undefined;
  for (const key of Object.keys(_routeGroups)) delete _routeGroups[key];
  // Reset the shared on-demand tracker so each GET /shells test starts
  // from a clean slate (no leftover records from prior suites). The
  // test instance is bound to a per-suite tmp file so there's no
  // cross-test disk pollution either.
  const all = _testTracker.list();
  for (const key of Object.keys(all)) {
    await _testTracker.forget(key);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authedFetch(authUser: { id: string; role: string } | null) {
  return (path: string) =>
    fetch(`${baseUrl}${path}`, {
      headers: authUser ? { 'x-test-auth': JSON.stringify(authUser) } : {},
    });
}

// Explicit-method helpers — authedFetch above only sets headers, so a
// plain `authedFetch(ADMIN)('/projects/.../shells')` would send GET
// and hit Express's default 404 page rather than the POST/DELETE route.
function authedPost(
  authUser: { id: string; role: string } | null,
  path: string,
  body: string = '{}',
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(authUser ? { 'x-test-auth': JSON.stringify(authUser) } : {}),
      'Content-Type': 'application/json',
    },
    body,
  });
}

function authedDelete(
  authUser: { id: string; role: string } | null,
  path: string,
  body: string = '{}',
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: {
      ...(authUser ? { 'x-test-auth': JSON.stringify(authUser) } : {}),
      'Content-Type': 'application/json',
    },
    body,
  });
}

describe('source run location', () => {
  test('returns an authorized camelCase entity location', async () => {
    const user = await createUser('run-location-user', 'pw', 'user');
    await upsertProjectMember(user.id, PROJ, 'editor');
    const conversation = await createConversation(PROJ, {
      ownerUserId: user.id,
      triggerSource: 'user',
    });
    const run = runFixture({
      group_folder: PROJ,
      conversation_id: conversation.id,
    });
    await insertActiveRun(run);

    const response = await authedFetch({ id: user.id, role: 'user' })(
      `/active-runs/${run.id}/location`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: run.id,
      projectId: PROJ,
      taskId: null,
      conversationId: conversation.id,
    });
  });
});

const ADMIN = { id: 'test-admin', role: 'admin' } as const;
const MEMBER = { id: 'user-member', role: 'user' } as const;
const STRANGER = { id: 'user-stranger', role: 'user' } as const;

const PROJ = 'active-run-test-proj';
const SHARED_OWNER = {
  name: 'Shell owner',
  folder: 'shell-shared-owner',
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: {
    isParent: true,
    sandboxOwnership: 'shared',
    defaultSandbox: 'shared-stack',
    defaultSandboxInstance: 'shared-instance',
  },
};
const SHARED_CHILD = {
  name: 'Shell child',
  folder: 'shell-shared-child',
  parentId: SHARED_OWNER.folder,
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: { workspacePath: 'child-repo' },
};

async function seedProjectAndUsers() {
  // FK checks are bypassed at the test PGlite layer (see test-helpers.ts),
  // so projects/users can be inserted via raw SQL with deterministic IDs.
  const handle =
    (drizzleDbRef.current as any)?.$client ??
    (drizzleDbRef.current as any)?._?.client ??
    (drizzleDbRef.current as any)?.session?.client;
  const now = new Date().toISOString();
  if (handle) {
    await handle.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
       VALUES ('${PROJ}', 'arun@kanban', 'AR', '${PROJ}', '!', '${now}', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
  }
  await createUser('arun-member', 'pw', 'user');
  await createUser('arun-stranger', 'pw', 'user');
  if (handle) {
    await handle.exec(
      `UPDATE users SET id = '${MEMBER.id}' WHERE username = 'arun-member'`,
    );
    await handle.exec(
      `UPDATE users SET id = '${STRANGER.id}' WHERE username = 'arun-stranger'`,
    );
  }
  await upsertProjectMember(MEMBER.id, PROJ, 'viewer');
  // Register the project under the strict state-manager mock so the
  // routes' group lookup resolves it (mirrors the real registerGroup).
  _routeGroups[PROJ] = { folder: PROJ, settings: {} };
}

// ─── POST /api/projects/:projectId/shells ─────────────────────────────────────

describe('POST /api/projects/:projectId/shells', () => {
  for (const [label, status, expectedStatus] of [
    ['stopped', { stdout: 'not running', isError: false }, 409],
    ['missing', { stdout: 'not found', isError: false }, 409],
    ['status error', { stdout: 'temporary MCP failure', isError: true }, 503],
  ] as const) {
    test(`child shell does not start parent sandbox when status is ${label}`, async () => {
      _routeGroups[SHARED_OWNER.folder] = SHARED_OWNER;
      _routeGroups[SHARED_CHILD.folder] = SHARED_CHILD;
      _sandboxStatusResult = status;

      const res = await authedPost(
        ADMIN,
        `/projects/${SHARED_CHILD.folder}/shells`,
        JSON.stringify({ tabId: `tab-${label.replace(' ', '-')}` }),
      );

      expect(res.status).toBe(expectedStatus);
      expect(await res.json()).toMatchObject({
        ownerProjectId: SHARED_OWNER.folder,
      });
      expect(
        _authCalls.filter((call) => call.method === 'sandboxStart'),
      ).toEqual([]);
      expect(
        _authCalls.filter((call) => call.method === 'generateAgentToken'),
      ).toEqual([]);
    });
  }

  test('child shell adopts a conclusively running parent sandbox without starting it', async () => {
    _routeGroups[SHARED_OWNER.folder] = SHARED_OWNER;
    _routeGroups[SHARED_CHILD.folder] = SHARED_CHILD;
    _sandboxStatusResult = { stdout: '"running"', isError: false };

    const res = await authedPost(
      ADMIN,
      `/projects/${SHARED_CHILD.folder}/shells`,
      JSON.stringify({ tabId: 'tab-running' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      instance: 'shared-instance',
      projectId: SHARED_OWNER.folder,
      reused: true,
    });
    expect(
      _testTracker.getByProjectTab(SHARED_OWNER.folder, 'tab-running'),
    ).toMatchObject({
      projectId: SHARED_OWNER.folder,
      instance: 'shared-instance',
      tmuxSession: projectShellTmuxSession('tab-running'),
    });
    expect(
      _testTracker.getByProjectTab(SHARED_CHILD.folder, 'tab-running'),
    ).toBeUndefined();
    expect(_authCalls.filter((call) => call.method === 'sandboxStart')).toEqual(
      [],
    );
  });

  // A standalone (non-inherited) project can have a running sandbox while
  // the shared tracker record is missing — the chat/task path auto-starts
  // sandboxes without writing a record, and restart/stop paths clear it.
  // Starting again in that state recreates the container and kills every
  // in-flight run inside it.
  test('standalone shell adopts a running sandbox without restarting it', async () => {
    await seedProjectAndUsers();
    _routeGroups[PROJ] = {
      folder: PROJ,
      settings: { defaultSandbox: 'solo-stack', defaultSandboxService: 'solo' },
    };
    _sandboxStatusResult = { stdout: '"running"', isError: false };

    const res = await authedPost(
      ADMIN,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: 'tab-adopted' }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      stack: 'solo-stack',
      service: 'solo',
      instance: PROJ,
      projectId: PROJ,
      reused: true,
    });
    expect(_authCalls.filter((call) => call.method === 'sandboxStart')).toEqual(
      [],
    );
    expect(
      _authCalls.filter((call) => call.method === 'generateAgentToken'),
    ).toEqual([]);

    // The shared record is written without a token: the running container
    // already carries the token minted when it was started.
    const shared = _testTracker.getByProject(PROJ);
    expect(shared).toMatchObject({
      projectId: PROJ,
      stack: 'solo-stack',
      service: 'solo',
      instance: PROJ,
    });
    expect(shared?.agentToken).toBeUndefined();

    // The tab record is created as usual.
    expect(_testTracker.getByProjectTab(PROJ, 'tab-adopted')).toMatchObject({
      projectId: PROJ,
      instance: PROJ,
      tmuxSession: projectShellTmuxSession('tab-adopted'),
    });
  });

  test('standalone shell starts a stopped sandbox as before', async () => {
    await seedProjectAndUsers();
    _routeGroups[PROJ] = {
      folder: PROJ,
      settings: { defaultSandbox: 'solo-stack', defaultSandboxService: 'solo' },
    };
    _sandboxStatusResult = { stdout: 'not running', isError: false };

    const res = await authedPost(
      ADMIN,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: 'tab-started' }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      stack: 'solo-stack',
      service: 'solo',
      instance: PROJ,
      reused: false,
    });
    expect(_authCalls.filter((call) => call.method === 'sandboxStart')).toEqual(
      [{ method: 'sandboxStart', args: ['solo-stack', PROJ] }],
    );
    expect(
      _authCalls.filter((call) => call.method === 'generateAgentToken'),
    ).toHaveLength(1);
  });

  test('standalone shell fails closed when the sandbox status is unavailable', async () => {
    await seedProjectAndUsers();
    _sandboxStatusError = new Error('box unreachable');

    const res = await authedPost(
      ADMIN,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: 'tab-unknown' }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status is unavailable/i);
    expect(_authCalls.filter((call) => call.method === 'sandboxStart')).toEqual(
      [],
    );
    expect(
      _authCalls.filter((call) => call.method === 'generateAgentToken'),
    ).toEqual([]);
    expect(_testTracker.getByProject(PROJ)).toBeUndefined();
  });

  test('standalone shell fails closed when the sandbox status reports an error', async () => {
    await seedProjectAndUsers();
    _sandboxStatusResult = {
      stdout: 'temporary MCP failure',
      isError: true,
    };

    const res = await authedPost(
      ADMIN,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: 'tab-status-error' }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status is unavailable/i);
    expect(_authCalls.filter((call) => call.method === 'sandboxStart')).toEqual(
      [],
    );
    expect(
      _authCalls.filter((call) => call.method === 'generateAgentToken'),
    ).toEqual([]);
    expect(_testTracker.getByProject(PROJ)).toBeUndefined();
  });

  test('invalidates cached shell coordinates after the project switches stacks', async () => {
    await seedProjectAndUsers();
    _routeGroups[PROJ] = {
      folder: PROJ,
      settings: {
        defaultSandbox: 'shop',
        defaultSandboxService: 'php82',
      },
    };
    await _testTracker.record({
      projectId: PROJ,
      stack: 'php',
      service: 'php84',
      instance: PROJ,
      createdAt: Date.now(),
    });
    await _testTracker.record({
      projectId: PROJ,
      shellTabId: 'stale-tab',
      stack: 'php',
      service: 'php84',
      instance: PROJ,
      tmuxSession: 'shell-stale-tab',
      createdAt: Date.now(),
    });

    const res = await authedPost(
      ADMIN,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: 'new-tab' }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      stack: 'shop',
      service: 'php82',
      instance: PROJ,
      reused: false,
    });
    expect(_testTracker.getByProjectTab(PROJ, 'stale-tab')).toBeUndefined();
    expect(_testTracker.getByProject(PROJ)).toMatchObject({
      stack: 'shop',
      service: 'php82',
      instance: PROJ,
    });
    expect(_authCalls.filter((call) => call.method === 'sandboxStart')).toEqual(
      [{ method: 'sandboxStart', args: ['shop', PROJ] }],
    );
  });

  test('returns 401 when unauthenticated', async () => {
    await seedProjectAndUsers();
    const res = await authedPost(null, `/projects/${PROJ}/shells`);
    expect(res.status).toBe(401);
  });

  test('returns 404 when the project is not registered', async () => {
    // registeredGroups is {} under the test mock, so the project lookup
    // resolves to "no registered group" before we touch any sandbox.
    const res = await authedPost(ADMIN, '/projects/conv-ghost/shells');
    if (res.status !== 404) {
      // Helpful breadcrumb if a future change moves the failure point.
      console.error(
        'POST /projects/:projectId/shells status:',
        res.status,
        'body:',
        await res.clone().text(),
      );
    }
    expect(res.status).toBe(404);
    const text = await res.text();
    let body: { error: string } = { error: '' };
    if (text) {
      try {
        body = JSON.parse(text) as { error: string };
      } catch {
        // Empty/non-JSON body still satisfies the "no registered group"
        // 404 — surface the text for debugging instead of crashing.
        body = { error: text };
      }
    }
    expect(body.error).toMatch(/no registered group/i);
  });

  test('rejects an oversized tabId', async () => {
    // The route is the only thing that owns this 64-char cap; verify it
    // 400s instead of silently truncating so the UI's tab ids stay
    // honest about what was accepted.
    await seedProjectAndUsers();
    const big = 'a'.repeat(200);
    const res = await authedPost(
      ADMIN,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: big }),
    );
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/projects/:projectId/shells/:tabId ────────────────────────────

describe('DELETE /api/projects/:projectId/shells/:tabId', () => {
  test('returns 401 when unauthenticated', async () => {
    await seedProjectAndUsers();
    const res = await authedDelete(null, `/projects/${PROJ}/shells/tab-a`);
    expect(res.status).toBe(401);
  });

  test('rejects an oversized tabId', async () => {
    const big = 'a'.repeat(200);
    const res = await authedDelete(ADMIN, `/projects/${PROJ}/shells/${big}`);
    expect(res.status).toBe(400);
  });

  test('denies viewers on shell create and close', async () => {
    await seedProjectAndUsers();
    const created = await authedPost(
      MEMBER,
      `/projects/${PROJ}/shells`,
      JSON.stringify({ tabId: 'viewer-tab' }),
    );
    expect(created.status).toBe(403);
    const closed = await authedDelete(MEMBER, `/projects/${PROJ}/shells/tab-a`);
    expect(closed.status).toBe(403);
  });
});

// ─── GET /api/projects/:projectId/shells ──────────────────────────────────────

describe('GET /api/projects/:projectId/shells', () => {
  test('returns 401 when unauthenticated', async () => {
    await seedProjectAndUsers();
    const res = await authedFetch(null)(`/projects/${PROJ}/shells`);
    expect(res.status).toBe(401);
  });

  test('returns 404 when the project is not registered', async () => {
    await seedProjectAndUsers();
    const res = await authedFetch(ADMIN)(`/projects/conv-ghost/shells`);
    expect(res.status).toBe(404);
  });

  test('returns 403 when the caller has no project access', async () => {
    await seedProjectAndUsers();
    const res = await authedFetch(STRANGER)(`/projects/${PROJ}/shells`);
    expect(res.status).toBe(403);
  });

  test('returns an empty shells array when the project has no on-demand sandboxes', async () => {
    await seedProjectAndUsers();
    const res = await authedFetch(MEMBER)(`/projects/${PROJ}/shells`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shells: unknown[] };
    expect(body.shells).toEqual([]);
  });

  test('returns only per-tab project shells (and excludes shared and other-project records)', async () => {
    await seedProjectAndUsers();

    // Two shells for the project under test, one for a different project.
    _routeGroups['active-run-test-other'] = {
      folder: 'active-run-test-other',
      settings: {},
    };
    await _testTracker.record({
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      createdAt: 1,
    });
    await _testTracker.record({
      projectId: PROJ,
      shellTabId: 'tab-2',
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat-tab-2`,
      createdAt: 2,
    });
    await _testTracker.record({
      projectId: 'active-run-test-other',
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'active-run-test-other-chat-other',
      createdAt: 3,
    });
    await _testTracker.record({
      projectId: 'active-run-test-other',
      shellTabId: 'other-tab',
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'active-run-test-other-chat-other-tab',
      createdAt: 4,
    });

    const res = await authedFetch(MEMBER)(`/projects/${PROJ}/shells`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shells: Array<{
        projectId: string;
        instance: string;
        shellTabId?: string;
      }>;
    };
    const instances = body.shells.map((s) => s.instance).sort();
    expect(instances).toEqual([`${PROJ}-chat-tab-2`]);
    for (const s of body.shells) {
      expect(s.projectId).toBe(PROJ);
      expect(s.shellTabId).toBeDefined();
    }
    // Cross-project sanity check: the other project's record never appears.
    const otherRes = await authedFetch(ADMIN)(
      '/projects/active-run-test-other/shells',
    );
    expect(otherRes.status).toBe(200);
    const otherBody = (await otherRes.json()) as {
      shells: Array<{ instance: string }>;
    };
    expect(otherBody.shells.map((s) => s.instance)).toEqual([
      'active-run-test-other-chat-other-tab',
    ]);
  });

  test('child projects inherit open tmux tabs from their shared sandbox owner', async () => {
    _routeGroups[SHARED_OWNER.folder] = SHARED_OWNER;
    _routeGroups[SHARED_CHILD.folder] = SHARED_CHILD;
    await _testTracker.record({
      projectId: SHARED_OWNER.folder,
      stack: 'shared-stack',
      service: 'agent',
      instance: 'shared-instance',
      createdAt: 1,
    });
    await _testTracker.record({
      projectId: SHARED_OWNER.folder,
      shellTabId: 'parent-tab',
      stack: 'shared-stack',
      service: 'agent',
      instance: 'shared-instance',
      tmuxSession: 'shell-parent-tab',
      createdAt: 2,
    });

    const parentRes = await authedFetch(ADMIN)(
      `/projects/${SHARED_OWNER.folder}/shells`,
    );
    const childRes = await authedFetch(ADMIN)(
      `/projects/${SHARED_CHILD.folder}/shells`,
    );

    expect(parentRes.status).toBe(200);
    expect(childRes.status).toBe(200);
    const parentBody = (await parentRes.json()) as { shells: unknown[] };
    const childBody = (await childRes.json()) as { shells: unknown[] };
    expect(childBody.shells).toEqual(parentBody.shells);
    expect(childBody.shells).toEqual([
      expect.objectContaining({
        projectId: SHARED_OWNER.folder,
        shellTabId: 'parent-tab',
        tmuxSession: 'shell-parent-tab',
      }),
    ]);
  });

  test('child shell listing preserves legacy child-keyed tabs alongside inherited tabs', async () => {
    _routeGroups[SHARED_OWNER.folder] = SHARED_OWNER;
    _routeGroups[SHARED_CHILD.folder] = SHARED_CHILD;
    for (const [projectId, shellTabId] of [
      [SHARED_OWNER.folder, 'parent-tab'],
      [SHARED_CHILD.folder, 'legacy-child-tab'],
    ]) {
      await _testTracker.record({
        projectId,
        shellTabId,
        stack: 'shared-stack',
        service: 'agent',
        instance: 'shared-instance',
        tmuxSession: `shell-${shellTabId}`,
        createdAt: 1,
      });
    }

    const res = await authedFetch(ADMIN)(
      `/projects/${SHARED_CHILD.folder}/shells`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shells: Array<{ shellTabId?: string }>;
    };
    expect(body.shells.map((shell) => shell.shellTabId).sort()).toEqual([
      'legacy-child-tab',
      'parent-tab',
    ]);
  });
});

// ─── Close-tab contract ──────────────────────────────────────────────────────
//
// Regression suite for the "close a chat bash tab" semantics. The
// project's chat sandbox is persistent by design: it must stay up so
// future tabs (and sibling tabs that are still open) can keep
// reusing it. Closing a tab MUST NOT stop the container, revoke the
// per-shell token, or disturb sibling tab records.
//
// The only thing closing a tab does is:
//   1. Fire a best-effort `tmux-tool.sh kill <tmuxSession>` against
//      the box so the per-tab tmux session inside the still-running
//      container is reaped. The tmux session is transient; the
//      container is persistent.
//   2. Forget the per-tab tracker record so the UI strip
//      rehydrates without it.
//
// The shared project record (no `shellTabId`) is left in place —
// it's a "the container is alive and the on-shell token was minted
// for it" marker, not a teardown pointer.

describe('project-shell close-tab contract', () => {
  beforeEach(() => {
    _authCalls.length = 0;
  });

  test('DELETE /projects/:projectId/shells/:tabId kills ONLY the per-tab tmux session', async () => {
    // Seed the persistent shared record + one per-tab record. The
    // close-tab contract requires that ONLY the per-tab tmux session
    // is killed: the container, the per-shell token, and the shared
    // record are all preserved.
    const conv = await createConversation(PROJ);
    _routeGroups[PROJ] = { folder: PROJ, settings: {} };
    const sharedToken = `cat_shared_${Math.random().toString(36).slice(2)}`;
    await _testTracker.record({
      conversationId: conv.id,
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      agentToken: sharedToken,
      createdAt: Date.now(),
    });
    await _testTracker.record({
      conversationId: conv.id,
      shellTabId: 'shell-tab-A',
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      tmuxSession: 'shell-shell-tab-A',
      createdAt: Date.now(),
    });

    const killed = Promise.withResolvers<void>();
    onSandboxExec = killed.resolve;
    const res = await authedDelete(
      ADMIN,
      `/projects/${PROJ}/shells/shell-tab-A`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stopped: boolean;
      tmuxSession?: string | null;
      instance?: string;
      reason?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.stopped).toBe(false);
    expect(body.tmuxSession).toBe('shell-shell-tab-A');
    expect(body.instance).toBe(`${PROJ}-chat`);
    expect(body.reason).toMatch(/container retained/i);

    // Observe the production kill dispatch before inspecting its scope.
    await killed.promise;
    const killCalls = _authCalls.filter(
      (c) =>
        c.method === 'sandboxExec' &&
        (c.args[2] ?? '').includes('tmux-tool.sh kill'),
    );

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]?.args[2]).toContain('shell-shell-tab-A');
    // The kill command is scoped to the per-tab tmux session, not
    // `tmux kill-server` or any all-sessions command.
    expect(killCalls[0]?.args[2]).not.toMatch(/kill-server|kill-session -a/);

    // Critical assertions for the new contract:
    const stopCalls = _authCalls.filter((c) => c.method === 'sandboxStop');
    expect(stopCalls).toEqual([]); // container stays up

    const revokeCalls = _authCalls.filter(
      (c) => c.method === 'revokeAgentToken',
    );
    expect(revokeCalls).toEqual([]); // per-shell token survives

    const revokeGroupCalls = _authCalls.filter(
      (c) => c.method === 'revokeGroupTokens',
    );
    expect(revokeGroupCalls).toEqual([]); // never nuke the whole group

    // Tracker state: per-tab record gone, shared project record intact.
    expect(_testTracker.getByProjectTab(PROJ, 'shell-tab-A')).toBeUndefined();
    expect(_testTracker.getByProject(PROJ)).toBeDefined();
  });

  test('an inheriting child can close a tmux tab from the parent-owned shared sandbox', async () => {
    _routeGroups[SHARED_OWNER.folder] = SHARED_OWNER;
    _routeGroups[SHARED_CHILD.folder] = SHARED_CHILD;
    await _testTracker.record({
      projectId: SHARED_OWNER.folder,
      stack: 'shared-stack',
      service: 'agent',
      instance: 'shared-instance',
      createdAt: 1,
    });
    await _testTracker.record({
      projectId: SHARED_OWNER.folder,
      shellTabId: 'inherited-tab',
      stack: 'shared-stack',
      service: 'agent',
      instance: 'shared-instance',
      tmuxSession: 'shell-inherited-tab',
      createdAt: 2,
    });

    const res = await authedDelete(
      ADMIN,
      `/projects/${SHARED_CHILD.folder}/shells/inherited-tab`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      tmuxSession: 'shell-inherited-tab',
      instance: 'shared-instance',
    });
    expect(
      _testTracker.getByProjectTab(SHARED_OWNER.folder, 'inherited-tab'),
    ).toBeUndefined();
    expect(_testTracker.getByProject(SHARED_OWNER.folder)).toBeDefined();
  });

  test('close, navigate away, and return does not rehydrate the closed shell tab', async () => {
    await seedProjectAndUsers();
    const conv = await createConversation(PROJ);
    await _testTracker.record({
      conversationId: conv.id,
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      createdAt: Date.now(),
    });
    await _testTracker.record({
      conversationId: conv.id,
      shellTabId: 'shell-tab-A',
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      tmuxSession: 'shell-shell-tab-A',
      createdAt: Date.now(),
    });

    const closeRes = await authedDelete(
      ADMIN,
      `/projects/${PROJ}/shells/shell-tab-A`,
    );
    expect(closeRes.status).toBe(200);

    // Returning to the project triggers this rehydration request.
    // The shared container record remains, but it is not a shell tab.
    const returnRes = await authedFetch(MEMBER)(`/projects/${PROJ}/shells`);
    expect(returnRes.status).toBe(200);
    const body = (await returnRes.json()) as {
      shells: Array<{ shellTabId?: string }>;
    };
    expect(body.shells).toEqual([]);
  });

  test('DELETE /projects/:projectId/shells/:tabId leaves sibling tab records intact', async () => {
    // Companion test: closing tab A must not touch tab B's record or
    // its tmux session. The shared project record is the persistent
    // "container is alive" marker — it survives every close.
    const conv = await createConversation(PROJ);
    _routeGroups[PROJ] = { folder: PROJ, settings: {} };
    await _testTracker.record({
      conversationId: conv.id,
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      createdAt: Date.now(),
    });
    await _testTracker.record({
      conversationId: conv.id,
      shellTabId: 'shell-tab-A',
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      tmuxSession: 'shell-shell-tab-A',
      createdAt: Date.now(),
    });
    await _testTracker.record({
      conversationId: conv.id,
      shellTabId: 'shell-tab-B',
      projectId: PROJ,
      stack: 'carapa-bot',
      service: 'agent',
      instance: `${PROJ}-chat`,
      tmuxSession: 'shell-shell-tab-B',
      createdAt: Date.now(),
    });

    const killed = Promise.withResolvers<void>();
    onSandboxExec = killed.resolve;
    const res = await authedDelete(
      ADMIN,
      `/projects/${PROJ}/shells/shell-tab-A`,
    );
    expect(res.status).toBe(200);

    // Tab A is gone, tab B and the shared record are intact.
    expect(_testTracker.getByProjectTab(PROJ, 'shell-tab-A')).toBeUndefined();
    expect(_testTracker.getByProjectTab(PROJ, 'shell-tab-B')).toBeDefined();
    expect(_testTracker.getByProject(PROJ)).toBeDefined();

    // Only tab A's tmux session was killed — not tab B's. The kill
    // command names the specific session, so the box's tmux layer
    // won't accidentally take down a sibling.
    await killed.promise;
    const killCalls = _authCalls.filter(
      (c) =>
        c.method === 'sandboxExec' &&
        (c.args[2] ?? '').includes('tmux-tool.sh kill'),
    );

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]?.args[2]).toContain('shell-shell-tab-A');
    expect(killCalls[0]?.args[2]).not.toContain('shell-shell-tab-B');
  });

  test('DELETE /projects/:projectId/shells/:tabId is safe to retry when missing', async () => {
    // Second DELETE for the same tabId returns the same idempotent
    // "no on-demand sandbox" body — important so a flaky network or
    // a React strict-mode double-call doesn't surface as an error to
    // the user.
    const conv = await createConversation(PROJ);
    _routeGroups[PROJ] = { folder: PROJ, settings: {} };
    const first = await authedDelete(
      ADMIN,
      `/projects/${PROJ}/shells/shell-tab-A`,
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { reason?: string }).reason).toMatch(
      /no on-demand sandbox/i,
    );

    // No sandboxStop / sandboxExec / revoke calls leaked through.
    expect(_authCalls.filter((c) => c.method === 'sandboxStop')).toEqual([]);
    expect(
      _authCalls.filter(
        (c) =>
          c.method === 'sandboxExec' &&
          (c.args[2] ?? '').includes('tmux-tool.sh kill'),
      ),
    ).toEqual([]);
    expect(_authCalls.filter((c) => c.method === 'revokeAgentToken')).toEqual(
      [],
    );
  });
});

// ─── Run access: personal mains and the extend write check ───────────────────

describe('run access', () => {
  const MAIN = 'active-run-foreign-main';
  const stallControl = {
    reset() {},
    pause() {},
    resume() {},
    interrupt() {},
  };
  const runIds: string[] = [];

  async function insertRun(folder: string, conversationId: string | null) {
    const run = runFixture({
      group_folder: folder,
      conversation_id: conversationId,
    });
    await insertActiveRun(run);
    registerStallControl(run.id, stallControl as any);
    runIds.push(run.id);
    return run;
  }

  afterAll(() => {
    for (const id of runIds) unregisterStallControl(id);
  });

  async function seedForeignMain() {
    const handle =
      (drizzleDbRef.current as any)?.$client ??
      (drizzleDbRef.current as any)?._?.client ??
      (drizzleDbRef.current as any)?.session?.client;
    await handle.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${MAIN}', 'armain@kanban', 'Main', '${MAIN}', '!', '${new Date().toISOString()}', 1, 'other-owner')
       ON CONFLICT (id) DO NOTHING`,
    );
    _routeGroups[MAIN] = {
      folder: MAIN,
      is_main: true,
      user_id: 'other-owner',
      settings: {},
    };
    return insertRun(MAIN, null);
  }

  test('location is refused for an admin and for a stray member of a foreign main', async () => {
    await seedProjectAndUsers();
    const run = await seedForeignMain();
    const stray = await createUser('arun-stray', 'pw', 'user');
    await upsertProjectMember(stray.id, MAIN, 'editor');

    const path = `/active-runs/${run.id}/location`;
    expect((await authedFetch(ADMIN)(path)).status).toBe(403);
    expect(
      (await authedFetch({ id: stray.id, role: 'user' })(path)).status,
    ).toBe(403);
  });

  test('extend is refused for an admin on a foreign main', async () => {
    await seedProjectAndUsers();
    const run = await seedForeignMain();
    const res = await authedPost(ADMIN, `/active-runs/${run.id}/extend`);
    expect(res.status).toBe(403);
  });

  test('extend needs project write access or an editor conversation role', async () => {
    await seedProjectAndUsers();
    const conversation = await createConversation(PROJ, {
      ownerUserId: ADMIN.id,
      triggerSource: 'user',
    });
    const run = await insertRun(PROJ, conversation.id);
    const path = `/active-runs/${run.id}/extend`;

    // Explicit viewer without conversation write.
    expect((await authedPost(MEMBER, path)).status).toBe(403);

    // The same viewer as an editor of the run's conversation.
    await upsertConversationMember(MEMBER.id, conversation.id, 'editor');
    expect((await authedPost(MEMBER, path)).status).toBe(200);

    // Explicit project editor.
    const editor = await createUser('arun-editor', 'pw', 'user');
    await upsertProjectMember(editor.id, PROJ, 'editor');
    expect(
      (await authedPost({ id: editor.id, role: 'user' }, path)).status,
    ).toBe(200);
  });
});
