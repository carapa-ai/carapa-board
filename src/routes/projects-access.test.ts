import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canRunRepositoryDiscovery,
  discoveryMembershipProjectIds,
  canUpdateRepositoryConnection,
  REPOSITORY_CONNECTION_FIELDS,
  canEditProjectLocalFiles,
  createEditableFileHandlers,
  getEditableFileHandler,
  putEditableFileHandler,
  enforceProjectAccess,
  default as projectsRouter,
  preserveDetachedChildDirectory,
  removeDeletedMemorySourceReferences,
  rewriteRenamedProjectReferences,
  validateProspectiveParentId,
  validateProspectiveSharedSandboxParent,
  validateProspectiveSharedSandboxSettings,
  validateStageMainAiUserIds,
  validateTaskCheckoutSettingsWrite,
} from './projects.js';
import { EditableFileError } from '../lib/editable-local-file.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import {
  createConversation,
  createUser,
  initDatabase,
  insertAiUserRow,
} from '../db.js';
import {
  loadState,
  registerGroup,
  registeredGroups,
  unregisterGroup,
} from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import {
  removeProjectMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import conversationsRouter from './conversations.js';
import preferencesRouter from './preferences.js';
import usersRouter from './users.js';
import activeRunsRouter from './active-runs.js';
import browserRouter from './browser.js';
import objectivesRouter from './objectives.js';
import whatsappRouter from '../modules/whatsapp/whatsapp-routes.js';

beforeAll(async () => {
  await initDatabase(':memory:');
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe('enforceProjectAccess agent token scoping', () => {
  test('rejects an agent token scoped to a different project', async () => {
    const res = fakeResponse();
    let nextCalled = false;

    await enforceProjectAccess(
      {
        params: { pid: 'project-b' },
        tokenScope: { group_folder: 'project-a' },
      },
      res,
      () => {
        nextCalled = true;
      },
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied to this project' });
    expect(nextCalled).toBe(false);
  });

  test('allows an agent token scoped to the requested project', async () => {
    const res = fakeResponse();
    let nextCalled = false;

    await enforceProjectAccess(
      {
        params: { pid: 'project-a' },
        tokenScope: { group_folder: 'project-a' },
      },
      res,
      () => {
        nextCalled = true;
      },
    );

    expect(res.statusCode).toBe(200);
    expect(nextCalled).toBe(true);
  });

  describe('parent token reading a child project task list', () => {
    const run = async (
      method: string,
      url: string,
      permissions: Record<string, string[]>,
    ) => {
      const res = fakeResponse();
      let nextCalled = false;
      await enforceProjectAccess(
        {
          method,
          originalUrl: url,
          params: { pid: 'project-b' },
          tokenScope: { group_folder: 'project-a', permissions },
        },
        res,
        () => {
          nextCalled = true;
        },
      );
      return { res, nextCalled };
    };
    const parent = { 'project-b': ['tasks:*'] };

    test('admits GET /tasks with tasks:read on the child', async () => {
      const { res, nextCalled } = await run(
        'GET',
        '/api/projects/project-b/tasks?limit=5',
        parent,
      );
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    test.each([
      ['GET', '/api/projects/project-b/tasks/t1/messages'],
      ['POST', '/api/projects/project-b/tasks'],
      ['GET', '/api/projects/project-b/settings'],
    ])('rejects %s %s', async (method, url) => {
      const { res, nextCalled } = await run(method, url, parent);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
    });

    test('rejects the list without tasks:read', async () => {
      const { res, nextCalled } = await run(
        'GET',
        '/api/projects/project-b/tasks',
        { 'project-b': ['memories:read'] },
      );
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('enforceProjectAccess viewer read-only guard', () => {
  const pid = 'p1';
  const users = {
    owner: 'viewer-guard-owner',
    editor: 'viewer-guard-editor',
    viewer: 'viewer-guard-viewer',
  };

  beforeAll(async () => {
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES
         ('${users.owner}', '${users.owner}', 'test', 'user', '${now}'),
         ('${users.editor}', '${users.editor}', 'test', 'user', '${now}'),
         ('${users.viewer}', '${users.viewer}', 'test', 'user', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${pid}', '${pid}@web', 'Viewer guard', '${pid}', '!', '${now}', 0, '${users.owner}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertProjectMember(users.editor, pid, 'editor');
    await upsertProjectMember(users.viewer, pid, 'viewer');
  });

  async function run(userId: string, method: string, path: string) {
    const res = fakeResponse();
    let nextCalled = false;
    await enforceProjectAccess(
      {
        params: { pid },
        authUser: { id: userId, role: 'user' },
        method,
        originalUrl: `/api/projects/${pid}${path}`,
      },
      res,
      () => {
        nextCalled = true;
      },
    );
    return { res, nextCalled };
  }

  test.each([
    ['POST', '/tasks'],
    ['POST', '/tasks?x=1'],
    ['PATCH', '/tasks/t1'],
    ['POST', '/tasks/t1/execute'],
    ['DELETE', '/cronjobs/c1'],
    ['POST', '/dataset-tasks/d1/run'],
    ['POST', '/stop'],
    ['POST', '/TASKS'],
    ['DELETE', '/Cronjobs/c1'],
    ['POST', '/STOP'],
    ['POST', '/stop/'],
    ['PATCH', ''],
    ['PATCH', '/'],
    ['DELETE', ''],
    ['PATCH', '/scheduled-tasks/st1'],
    ['DELETE', '/scheduled-tasks/st1'],
    ['POST', '/git/push'],
    ['DELETE', '/artifacts/a.txt'],
    ['POST', '/regenerate-prompt'],
    ['POST', '/objectives'],
    ['PUT', '/objectives/o1'],
    ['DELETE', '/objectives/o1/'],
    ['POST', '/link-whatsapp'],
    ['patch', '/Scheduled-Tasks/st1'],
    ['POST', '/GIT/push?x=1'],
    ['DELETE', '/Objectives/o1?x=1'],
  ])('denies viewer %s %s', async (method, path) => {
    const { res, nextCalled } = await run(users.viewer, method, path);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'Viewers have read-only access to this project',
    });
    expect(nextCalled).toBe(false);
  });

  const writes = [
    ['PATCH', ''],
    ['DELETE', ''],
    ['PATCH', '/scheduled-tasks/st1'],
    ['DELETE', '/scheduled-tasks/st1'],
    ['POST', '/git/push'],
    ['DELETE', '/artifacts/a.txt'],
    ['POST', '/regenerate-prompt'],
    ['POST', '/objectives'],
    ['PUT', '/objectives/o1'],
    ['DELETE', '/objectives/o1/'],
    ['POST', '/link-whatsapp'],
  ];

  test.each(writes)('allows editor and owner %s %s', async (method, path) => {
    for (const userId of [users.editor, users.owner]) {
      expect((await run(userId, method, path)).nextCalled).toBe(true);
    }
  });

  test.each([
    ['POST', '/upload'],
    ['POST', '/messages'],
    ['POST', '/conversations/c1/read'],
    ...writes.map(([, path]) => ['GET', path]),
  ])('allows viewer %s %s', async (method, path) => {
    expect((await run(users.viewer, method, path)).nextCalled).toBe(true);
  });

  test.each([
    [users.viewer, 'GET', '/tasks'],
    [users.viewer, 'GET', '/cronjobs'],
    [users.viewer, 'POST', '/conversations/c1/messages'],
    [users.editor, 'POST', '/tasks'],
    [users.owner, 'POST', '/tasks'],
  ])('allows %s %s %s', async (userId, method, path) => {
    const { nextCalled } = await run(userId, method, path);
    expect(nextCalled).toBe(true);
  });
});

describe('every project write route is viewer-guarded', () => {
  const pid = 'route-table-project';
  const ownerId = 'route-table-owner';
  const viewerId = 'route-table-viewer';
  // Routes the viewer gate lets through; the value says why that is safe:
  // `participation`, `handler: <guard>`, or a known gap with no guard (reason
  // prefixed with the gap marker).
  const VIEWER_WRITE_ALLOWLIST: Record<string, string> = {
    'POST /projects/:pid/mail/send':
      'handler: mailRole editor check (requireMailAccount)',
    'POST /projects/:pid/mail/read-state':
      'handler: mailRole editor check (requireMailAccount)',
    'POST /projects/:pid/mail/move':
      'handler: mailRole editor check (requireMailAccount)',
    'POST /projects/:pid/conversations/imports/codex': 'handler: admin only',
    'POST /projects/:pid/conversations': 'handler: explicit owner/editor check',
    'POST /projects/:pid/conversations/:cid/read': 'participation',
    'POST /projects/:pid/conversations/:cid/resolve-pending': 'participation',
    'POST /projects/:pid/conversations/mark-all-read': 'participation',
    'POST /projects/:pid/upload': 'participation',
    'POST /projects/:pid/messages': 'participation',
    'POST /projects/:pid/messages/codex-answer': 'participation',
    'POST /projects/:pid/conversations/:cid/messages/:messageId/speech':
      'participation',
    'DELETE /projects/:pid/conversations/:cid/persona-live-mode/watcher':
      'participation',
    'POST /projects/:pid/conversations/:cid/persona-live-mode/heartbeat':
      'participation',
    'POST /projects/:pid/conversations/:cid/persona-live-mode/items/:itemId/started':
      'participation',
    'PUT /projects/:pid/files/favorites':
      'participation: a personal preference, changes no project data',
    'DELETE /projects/:pid/files/favorites':
      'participation: a personal preference, changes no project data',
    'PUT /projects/:pid/preferences': 'participation',
    'PUT /projects/:pid/preferences/mode': 'participation',
    'POST /projects/:pid/preferences/kanban-acknowledgement': 'participation',
    'PUT /projects/:pid/preferences/push': 'participation',
    'POST /projects/:pid/objectives/:oid/dashboard-ticket': 'participation',
    'POST /projects/:pid/objectives/:oid/dashboard-refresh': 'participation',
    'POST /projects/:pid/conversations/:cid/queued-messages/reconcile':
      'handler: requireConversationAccess(write)',
    'DELETE /projects/:pid/conversations/:cid/queued-messages/:messageId':
      'handler: requireConversationAccess(write)',
    'PATCH /projects/:pid/conversations/:cid':
      'handler: requireConversationAccess(write)',
    'POST /projects/:pid/conversations/:cid/generate-title':
      'handler: requireConversationAccess(write)',
    'DELETE /projects/:pid/conversations/:cid':
      'handler: requireConversationAccess(write)',
    'POST /projects/:pid/conversations/:cid/background-tasks/:taskId/stop':
      'handler: requireConversationAccess(write)',
    'PUT /projects/:pid/conversations/:cid/persona-live-mode':
      'handler: requireConversationAccess(write)',
    'PATCH /projects/:pid/conversations/:cid/persona-loop':
      'handler: requireConversationAccess(write)',
    'POST /projects/:pid/conversations/:cid/persona-round':
      'handler: requireConversationAccess(write)',
    'POST /projects/:pid/messages/stop':
      'handler: requireConversationAccess(write)',
    'POST /projects/:pid/conversations/:cid/worktree/merge':
      'handler: requireIdleOwnedConversationWorktree (conversation write access)',
    'POST /projects/:pid/conversations/:cid/worktree/update-from-default':
      'handler: requireIdleOwnedConversationWorktree (conversation write access)',
    'DELETE /projects/:pid/conversations/:cid/worktree':
      'handler: requireIdleOwnedConversationWorktree (conversation write access)',
    'POST /projects/:pid/conversations/:cid/fork':
      'handler: canEditProjectLocalFiles',
    'PUT /projects/:pid/files/editable-content':
      'handler: canEditProjectLocalFiles',
    'POST /projects/:pid/files/group/rename':
      'handler: canEditProjectLocalFiles',
    'POST /projects/:pid/files/group/move': 'handler: canEditProjectLocalFiles',
    'POST /projects/:pid/files/group/delete':
      'handler: canEditProjectLocalFiles',
    'POST /projects/:pid/conversations/:cid/handoff':
      'handler: destination project owner/editor check',
    'POST /projects/:pid/conversations/:cid/git/index':
      'handler: conversation write access, else canEditProjectLocalFiles',
    'POST /projects/:pid/commit':
      'handler: conversation write access, else canEditProjectLocalFiles',
    'POST /projects/:pid/conversations/:cid/commit':
      'handler: conversation write access, else canEditProjectLocalFiles',
    'PUT /projects/:pid/conversations/:cid/public-share':
      'handler: requireConversationOwnerOrAdmin',
    'POST /projects/:pid/conversations/:cid/public-share/regenerate':
      'handler: requireConversationOwnerOrAdmin',
    'PATCH /projects/:pid/conversations/:cid/public-share/visitor-prompts':
      'handler: requireConversationOwnerOrAdmin',
    'DELETE /projects/:pid/conversations/:cid/public-share':
      'handler: requireConversationOwnerOrAdmin',
    'POST /projects/:pid/conversations/:cid/members':
      'handler: requireConversationOwnerOrAdmin',
    'DELETE /projects/:pid/conversations/:cid/members/:user_id':
      'handler: requireConversationOwnerOrAdmin',
    'PATCH /projects/:pid/conversations/:cid/ai-users/main':
      'handler: ensureConversation(write)',
    'POST /projects/:pid/conversations/:cid/ai-users':
      'handler: ensureConversation(write)',
    'POST /projects/:pid/conversations/:cid/ai-users/teams/:teamId':
      'handler: ensureConversation(write)',
    'PATCH /projects/:pid/conversations/:cid/ai-users/:aiUserId':
      'handler: ensureConversation(write)',
    'DELETE /projects/:pid/conversations/:cid/ai-users/:aiUserId':
      'handler: ensureConversation(write)',
    'POST /projects/:pid/proposals/:id/approve':
      'handler: requireConversationAccess(write) + assertPromptApprover',
    'POST /projects/:pid/proposals/:id/deny':
      'handler: requireConversationAccess(write) + assertPromptApprover',
    'PUT /projects/:pid/published-app':
      'handler: canRunRepositoryDiscovery (owner/editor)',
    'POST /projects/:pid/discover-repositories':
      'handler: canRunRepositoryDiscovery (owner/editor)',
    'POST /projects/:pid/members': 'handler: requireProjectOwnerOrAdmin',
    'DELETE /projects/:pid/members/:user_id':
      'handler: requireProjectOwnerOrAdmin',
    'POST /projects/:projectId/shells':
      'handler: userHasExplicitGroupAccess(write)',
    'DELETE /projects/:projectId/shells/:tabId':
      'handler: userHasExplicitGroupAccess(write)',
    'POST /projects/:projectId/browser/viewers':
      'handler: authorizeBrowser (owner/editor)',
    'POST /projects/:projectId/browser/sessions/:sessionId':
      'handler: authorizeBrowser (owner/editor)',
    'POST /projects/:pid/objectives/:oid/move': 'handler: canWriteObjectivesIn',
  };

  beforeAll(async () => {
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES
         ('${ownerId}', '${ownerId}', 'test', 'user', '${now}'),
         ('${viewerId}', '${viewerId}', 'test', 'user', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects
         (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${pid}', '${pid}@web', 'Route table', '${pid}', '!', '${now}', 0, '${ownerId}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertProjectMember(viewerId, pid, 'viewer');
  });

  const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  /** Write routes of an Express router stack, descending into nested routers. */
  function walkWriteRoutes(stack: any[], found: Set<string>): void {
    for (const layer of stack) {
      if (layer.route) {
        const paths = [layer.route.path].flat();
        const methods = Object.keys(layer.route.methods).map((method) =>
          method === '_all' ? 'ALL' : method.toUpperCase(),
        );
        for (const routePath of paths) {
          if (typeof routePath !== 'string')
            throw new Error(`Unsupported non-string route path: ${routePath}`);
          for (const method of methods) {
            if (!READ_METHODS.has(method)) found.add(`${method} ${routePath}`);
          }
        }
      } else if (layer.handle?.stack) {
        // Mounted at a prefix we cannot read back would hide the real path.
        if (!layer.slash)
          throw new Error('Nested router mounted at a path prefix');
        walkWriteRoutes(layer.handle.stack, found);
      }
    }
  }

  const writeRoutes = (() => {
    const found = new Set<string>();
    for (const router of [
      projectsRouter, // + mail, tasks, conversations, shares, export, ai-users, cronjobs, datasets, memories, meetings, proposals
      preferencesRouter,
      usersRouter,
      activeRunsRouter,
      browserRouter,
      objectivesRouter,
      whatsappRouter,
    ]) {
      walkWriteRoutes((router as any).stack, found);
    }
    return [...found].filter((key) =>
      key.split(' ')[1].startsWith('/projects/:'),
    );
  })();

  /** `POST /projects/:pid/x/:id` -> `/x/x1` below the seeded project. */
  function tailOf(routePath: string): string {
    return routePath
      .replace(/^\/projects\/:[^/]+/, '')
      .replace(/:[A-Za-z_]\w*|\*\w*/g, 'x1');
  }

  async function runAsViewer(method: string, tail: string) {
    const res = fakeResponse();
    let nextCalled = false;
    await enforceProjectAccess(
      {
        params: { pid },
        authUser: { id: viewerId, role: 'user' },
        method: method === 'ALL' ? 'POST' : method,
        originalUrl: `/api/projects/${pid}${tail}`,
      },
      res,
      () => {
        nextCalled = true;
      },
    );
    return { res, nextCalled };
  }

  test('walks the real router tables', () => {
    expect(writeRoutes.length).toBeGreaterThanOrEqual(80);
    expect(writeRoutes).toContain('PATCH /projects/:pid/tasks/:fid');
    expect(writeRoutes).toContain('POST /projects/:projectId/browser/viewers');
  });

  test('allowlist has no stale entries', () => {
    expect(
      Object.keys(VIEWER_WRITE_ALLOWLIST).filter(
        (key) => !writeRoutes.includes(key),
      ),
    ).toEqual([]);
  });

  test('every project write route is denied to viewers unless allowlisted', async () => {
    const unguarded: string[] = [];
    for (const key of writeRoutes) {
      if (key in VIEWER_WRITE_ALLOWLIST) continue;
      const [method, routePath] = key.split(' ');
      const tail = tailOf(routePath);
      // Express matches case-insensitively and ignores a trailing slash.
      const variants = new Set([
        tail,
        `${tail}/`,
        tail.toUpperCase(),
        `${tail}?x=1`,
      ]);
      for (const variant of variants) {
        const { res, nextCalled } = await runAsViewer(method, variant);
        if (nextCalled || res.statusCode !== 403)
          unguarded.push(`${method} ${variant}`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});

describe('stage main persona validation', () => {
  test('normalizes enabled persona IDs for every stage type and rejects unavailable selections', async () => {
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: 'route-enabled-persona',
      name: 'Route persona',
      identity: 'Route persona',
      presetId: 'custom',
      promptPath: 'ai-users/route-enabled-persona/prompt.md',
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    const enabled = [
      { type: 'active', mainAiUserId: ' route-enabled-persona ' },
    ];
    expect(await validateStageMainAiUserIds(enabled)).toBeUndefined();
    expect(enabled[0].mainAiUserId).toBe('route-enabled-persona');
    const queue = [{ type: 'queue', mainAiUserId: ' route-enabled-persona ' }];
    expect(await validateStageMainAiUserIds(queue)).toBeUndefined();
    expect(queue[0].mainAiUserId).toBe('route-enabled-persona');
    expect(
      await validateStageMainAiUserIds([
        { type: 'review', mainAiUserId: 'missing-persona' },
      ]),
    ).toBe('Stage mainAiUserId must reference an enabled AI user');
  });
});

describe('repository discovery mutation authorization', () => {
  test('rejects project-scoped agent bearer tokens', () => {
    expect(
      canRunRepositoryDiscovery({ tokenScope: { group_folder: 'parent' } }),
    ).toBe(false);
  });

  test('rejects viewers and implicit chat members', () => {
    expect(
      canRunRepositoryDiscovery({
        authUser: { role: 'user' },
        projectAccess: { kind: 'explicit', level: 'viewer' },
      }),
    ).toBe(false);
    expect(
      canRunRepositoryDiscovery({
        authUser: { role: 'user' },
        projectAccess: { kind: 'implicit' },
      }),
    ).toBe(false);
  });

  test('allows authenticated editors, owners, and admins', () => {
    expect(
      canRunRepositoryDiscovery({
        authUser: { role: 'user' },
        projectAccess: { kind: 'explicit', level: 'editor' },
      }),
    ).toBe(true);
    expect(
      canRunRepositoryDiscovery({
        authUser: { role: 'user' },
        projectAccess: { kind: 'explicit', level: 'owner' },
      }),
    ).toBe(true);
    expect(canRunRepositoryDiscovery({ authUser: { role: 'admin' } })).toBe(
      true,
    );
  });
});

describe('repository connection mutation authorization', () => {
  test('rejects agents, viewers, and editors', () => {
    expect(
      canUpdateRepositoryConnection({
        tokenScope: { group_folder: 'project' },
      }),
    ).toBe(false);
    for (const level of ['viewer', 'editor']) {
      expect(
        canUpdateRepositoryConnection({
          authUser: { role: 'user' },
          projectAccess: { kind: 'explicit', level },
        }),
      ).toBe(false);
    }
  });

  test('covers every setting that chooses a host mount or remote', () => {
    expect(REPOSITORY_CONNECTION_FIELDS).toEqual(
      expect.arrayContaining([
        'repositoryLocation',
        'repositoryUrl',
        'sharedWorkspaceHostLocation',
      ]),
    );
  });

  test('allows the project owner and admin', () => {
    expect(
      canUpdateRepositoryConnection({
        authUser: { role: 'user' },
        projectAccess: { kind: 'explicit', level: 'owner' },
      }),
    ).toBe(true);
    expect(canUpdateRepositoryConnection({ authUser: { role: 'admin' } })).toBe(
      true,
    );
  });
});

describe('local file edit authorization', () => {
  test('denies direct requests from agents, anonymous users, viewers and implicit members', () => {
    expect(
      canEditProjectLocalFiles({ tokenScope: { group_folder: 'project' } }),
    ).toBe(false);
    expect(canEditProjectLocalFiles({})).toBe(false);
    expect(
      canEditProjectLocalFiles({
        authUser: { role: 'user' },
        projectAccess: { kind: 'explicit', level: 'viewer' },
      }),
    ).toBe(false);
    expect(
      canEditProjectLocalFiles({
        authUser: { role: 'user' },
        projectAccess: { kind: 'implicit' },
      }),
    ).toBe(false);
  });

  test('allows an explicit owner, an explicit editor or a board admin', () => {
    for (const level of ['owner', 'editor']) {
      expect(
        canEditProjectLocalFiles({
          authUser: { role: 'user' },
          projectAccess: { kind: 'explicit', level },
        }),
      ).toBe(true);
    }
    expect(canEditProjectLocalFiles({ authUser: { role: 'admin' } })).toBe(
      true,
    );
  });

  test('direct editable load/save requests are denied before filesystem access', async () => {
    const group = {
      name: 'Denied edit project',
      folder: 'denied-edit-project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
    };
    for (const request of [
      { tokenScope: { group_folder: group.folder } },
      { authUser: { role: 'user' }, projectAccess: { kind: 'implicit' } },
      {
        authUser: { role: 'user' },
        projectAccess: { kind: 'explicit', level: 'viewer' },
      },
    ]) {
      for (const handler of [getEditableFileHandler, putEditableFileHandler]) {
        const res = fakeResponse();
        await handler(
          {
            ...request,
            params: { pid: group.folder },
            query: { source: 'group', path: 'notes.txt' },
            body: {
              source: 'group',
              path: 'notes.txt',
              content: 'denied',
              expectedRevision: '0'.repeat(64),
            },
          },
          res,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
          error: 'Owner, editor or admin access is required',
        });
      }
    }
  });

  test('loads and saves through explicit source roots with no-store and source-specific invalidation', async () => {
    const calls: unknown[][] = [];
    const events: unknown[] = [];
    const revision = 'a'.repeat(64);
    const handlers = createEditableFileHandlers({
      getGroup: (() => ({ folder: 'route-project' })) as never,
      sourceRoot: ((folder: string, source: string) =>
        source === 'artifact'
          ? `/groups/${folder}/artifacts`
          : `/groups/${folder}`) as never,
      load: (async (...args: unknown[]) => {
        calls.push(['load', ...args]);
        return {
          source: 'group',
          path: 'notes.md',
          content: '# authoritative',
          mimetype: 'text/markdown',
          size: 15,
          revision,
          sensitive: false,
        };
      }) as never,
      replace: (async (...args: unknown[]) => {
        calls.push(['replace', ...args]);
        return {
          source: args[2],
          path: args[1],
          revision: 'b'.repeat(64),
          size: 7,
        };
      }) as never,
      emit: ((event: unknown) => events.push(event)) as never,
    });
    // An editor may open and save through the same handlers.
    const owner = {
      authUser: { role: 'user' },
      projectAccess: { kind: 'explicit', level: 'editor' },
      params: { pid: 'route-project' },
    };

    const loadRes = fakeResponse();
    await handlers.get(
      { ...owner, query: { source: 'group', path: 'notes.md' } },
      loadRes,
    );
    expect(loadRes.headers['Cache-Control']).toBe('no-store');
    expect(loadRes.body).toMatchObject({
      source: 'group',
      path: 'notes.md',
      content: '# authoritative',
      revision,
    });
    expect(calls[0]).toEqual([
      'load',
      '/groups/route-project',
      'notes.md',
      'group',
    ]);

    for (const source of ['group', 'artifact'] as const) {
      const saveRes = fakeResponse();
      await handlers.put(
        {
          ...owner,
          body: {
            source,
            path: 'notes.md',
            content: 'updated',
            expectedRevision: revision,
          },
        },
        saveRes,
      );
      expect(saveRes.headers['Cache-Control']).toBe('no-store');
      expect(saveRes.body).toEqual({
        source,
        path: 'notes.md',
        revision: 'b'.repeat(64),
        size: 7,
      });
    }
    expect(calls.slice(1)).toEqual([
      [
        'replace',
        '/groups/route-project',
        'notes.md',
        'group',
        'updated',
        revision,
      ],
      [
        'replace',
        '/groups/route-project/artifacts',
        'notes.md',
        'artifact',
        'updated',
        revision,
      ],
    ]);
    expect(events).toEqual([
      {
        type: 'group_files_changed',
        payload: { folder: 'route-project' },
      },
      {
        type: 'artifacts_changed',
        payload: { folder: 'route-project' },
      },
    ]);
  });

  test('returns metadata-only stale responses from the HTTP handler', async () => {
    const currentRevision = 'c'.repeat(64);
    const handlers = createEditableFileHandlers({
      getGroup: (() => ({ folder: 'route-project' })) as never,
      sourceRoot: (() => '/groups/route-project') as never,
      load: (async () => {
        throw new Error('unused');
      }) as never,
      replace: (async () => {
        throw new EditableFileError(409, 'File changed since it was loaded', {
          revision: currentRevision,
          size: 19,
        });
      }) as never,
      emit: (() => {
        throw new Error('stale saves must not broadcast');
      }) as never,
    });
    const res = fakeResponse();
    await handlers.put(
      {
        authUser: { role: 'admin' },
        params: { pid: 'route-project' },
        body: {
          source: 'group',
          path: 'notes.md',
          content: 'private draft contents',
          expectedRevision: 'a'.repeat(64),
        },
      },
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toEqual({
      error: 'File changed since it was loaded',
      currentRevision,
      currentSize: 19,
    });
    expect(JSON.stringify(res.body)).not.toContain('private draft contents');
  });
});

describe('shared sandbox project update validation', () => {
  test('rejects a prospective child-owned shared sandbox before parent detachment', () => {
    const child = {
      parentId: 'shared-parent',
      settings: { sandboxOwnership: 'standalone' as const },
    };

    const error = validateProspectiveSharedSandboxSettings(child.settings, {
      sandboxOwnership: 'shared',
    });

    expect(error).toBe(
      'sandboxOwnership "shared" is only valid for a parent project',
    );
    expect(child.parentId).toBe('shared-parent');
    expect(child.settings.sandboxOwnership).toBe('standalone');
  });

  test('accepts at most two absolute host paths for extraMounts', () => {
    expect(
      validateProspectiveSharedSandboxSettings(undefined, {
        extraMounts: ['/srv/docs', '/srv/data'],
      }),
    ).toBeUndefined();
    for (const extraMounts of [
      ['/a', '/b', '/c'],
      ['relative/path'],
      ['/srv/../etc'],
      'not-an-array',
    ]) {
      expect(
        validateProspectiveSharedSandboxSettings(undefined, { extraMounts }),
      ).toContain('extraMounts');
    }
  });

  test('rejects unknown sandbox ownership values', () => {
    expect(
      validateProspectiveSharedSandboxSettings(undefined, {
        sandboxOwnership: 'inherited',
      }),
    ).toBe('sandboxOwnership must be either "standalone" or "shared"');
  });

  test.each([
    ['sharedWorkspaceHostLocation', true],
    ['sharedWorkspaceContainerRoot', 42],
    ['webRootPath', 42],
  ])('rejects a non-string %s', (key, value) => {
    expect(
      validateProspectiveSharedSandboxSettings(
        { isParent: true, sandboxOwnership: 'shared' },
        { [key]: value },
      ),
    ).toBe(`${key} must be a string`);
  });

  test('validates absolute roots against the complete merged configuration', () => {
    expect(
      validateProspectiveSharedSandboxSettings(
        { isParent: true, sandboxOwnership: 'shared' },
        { sharedWorkspaceContainerRoot: 'relative/repos' },
      ),
    ).toBe('sharedWorkspaceContainerRoot must be an absolute container path');
    expect(
      validateProspectiveSharedSandboxSettings(
        { isParent: true },
        {
          sandboxOwnership: 'shared',
          sharedWorkspaceHostLocation: '/host/repos',
          sharedWorkspaceContainerRoot: '/workspace/repos',
        },
      ),
    ).toBeUndefined();
  });

  test('keeps the web root relative to the mounted workspace', () => {
    expect(
      validateProspectiveSharedSandboxSettings(undefined, {
        webRootPath: '/var/www/public',
      }),
    ).toBe('webRootPath must be relative to the sandbox workspace');
    expect(
      validateProspectiveSharedSandboxSettings(undefined, {
        webRootPath: '../sibling/public',
      }),
    ).toBe(
      'webRootPath must be a safe relative path within the sandbox workspace',
    );
    expect(
      validateProspectiveSharedSandboxSettings(undefined, {
        webRootPath: 'shop/public; include /tmp/override',
      }),
    ).toBe(
      'webRootPath must be a safe relative path within the sandbox workspace',
    );
    expect(
      validateProspectiveSharedSandboxSettings(undefined, {
        webRootPath: 'shop/public',
      }),
    ).toBeUndefined();
  });

  test.each([
    [
      { defaultSandboxInstance: 'INVALID.instance' },
      'Invalid defaultSandboxInstance "INVALID.instance"',
    ],
    [
      { workspaceRoots: ['relative/root'] },
      'workspaceRoots entry "relative/root" must be an absolute POSIX path',
    ],
  ])(
    'rejects detach-and-reconfigure sandbox settings before changing parentId',
    (settings, expectedError) => {
      const child = {
        parentId: 'shared-parent',
        settings: { repositoryLocation: '/host/repos/child' },
      };

      const error = validateProspectiveSharedSandboxSettings(
        child.settings,
        settings,
      );

      expect(error).toContain(expectedError);
      expect(child.parentId).toBe('shared-parent');
    },
  );
});

describe('prospective project parent validation', () => {
  const project = (folder: string, parentId?: string) => ({
    name: folder,
    folder,
    parentId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
  });

  test('rejects missing and self parent IDs', () => {
    const child = project('child');
    const lookup = (folder: string) =>
      folder === child.folder ? child : undefined;
    expect(validateProspectiveParentId(child, 'missing', lookup)).toBe(
      'Parent project "missing" not found',
    );
    expect(validateProspectiveParentId(child, 'child', lookup)).toBe(
      'A project cannot be its own parent',
    );
  });

  test('rejects direct and transitive ownership cycles', () => {
    const root = project('root');
    const child = project('child', 'root');
    const grandchild = project('grandchild', 'child');
    const groups = [root, child, grandchild];
    const lookup = (folder: string) =>
      groups.find((candidate) => candidate.folder === folder);
    expect(validateProspectiveParentId(root, 'child', lookup)).toContain(
      'cycle',
    );
    expect(validateProspectiveParentId(root, 'grandchild', lookup)).toContain(
      'cycle',
    );
  });

  test('accepts a legitimate prospective parent', () => {
    const parent = project('parent');
    const child = project('child');
    const lookup = (folder: string) =>
      folder === parent.folder ? parent : undefined;
    expect(
      validateProspectiveParentId(child, parent.folder, lookup),
    ).toBeUndefined();
  });

  test('rejects assigning a parent to a shared owner', () => {
    expect(
      validateProspectiveSharedSandboxParent(
        { isParent: true, sandboxOwnership: 'shared' },
        {},
        'parent',
      ),
    ).toBe(
      'sandboxOwnership "shared" is only valid for a top-level project without a parent',
    );
  });

  test('rejects enabling shared ownership on an existing child', () => {
    expect(
      validateProspectiveSharedSandboxParent(
        { isParent: true, sandboxOwnership: 'standalone' },
        { sandboxOwnership: 'shared' },
        'parent',
      ),
    ).toContain('top-level project');
  });

  test('allows a child to become a detached shared owner atomically', () => {
    expect(
      validateProspectiveSharedSandboxParent(
        { isParent: true, sandboxOwnership: 'standalone' },
        { sandboxOwnership: 'shared' },
        undefined,
      ),
    ).toBeUndefined();
  });
});

test('parent deletion preserves nested child data when detaching it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-detach-test-'));
  const oldChildDir = path.join(root, 'groups', 'parent', 'child');
  const newChildDir = path.join(root, 'groups', 'child');
  try {
    fs.mkdirSync(oldChildDir, { recursive: true });
    fs.mkdirSync(newChildDir, { recursive: true });
    fs.writeFileSync(path.join(oldChildDir, 'transcript.jsonl'), 'current');
    fs.writeFileSync(path.join(newChildDir, 'transcript.jsonl'), 'stale');
    fs.writeFileSync(path.join(newChildDir, 'flat-only.txt'), 'keep');

    await preserveDetachedChildDirectory(oldChildDir, newChildDir);

    expect(fs.existsSync(oldChildDir)).toBe(false);
    expect(
      fs.readFileSync(path.join(newChildDir, 'transcript.jsonl'), 'utf8'),
    ).toBe('current');
    expect(
      fs.readFileSync(path.join(newChildDir, 'flat-only.txt'), 'utf8'),
    ).toBe('keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parent rename rewrites child ownership references', async () => {
  const calls: Array<{ jid: string; updates: Record<string, unknown> }> = [];
  const groups = {
    parent: {
      name: 'Parent',
      folder: 'old-parent',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        isParent: true,
        sandboxOwnership: 'shared' as const,
        defaultSandboxInstance: 'shared-instance',
      },
    },
    child: {
      name: 'Child',
      folder: 'child',
      parentId: 'old-parent',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
    },
  };
  await rewriteRenamedProjectReferences(
    'old-parent',
    'new-parent',
    groups,
    async (jid, updates) => {
      calls.push({ jid, updates });
      Object.assign(groups[jid as keyof typeof groups], updates);
    },
  );

  expect(calls).toEqual([
    { jid: 'parent', updates: { folder: 'new-parent' } },
    { jid: 'child', updates: { parentId: 'new-parent' } },
  ]);
  expect(groups.child.parentId).toBe('new-parent');
  expect(
    resolveEffectiveSandbox(groups.child, (folder) =>
      Object.values(groups).find((group) => group.folder === folder),
    ).instance,
  ).toBe('shared-instance');
});

test('project rename rewrites memory source references', async () => {
  const calls: Array<{ jid: string; updates: Record<string, unknown> }> = [];
  const groups = {
    framework: {
      name: 'Framework',
      folder: 'demo-app',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {},
    },
    app: {
      name: 'App',
      folder: 'app',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { memorySourceProjects: ['demo-app'] },
    },
  };
  await rewriteRenamedProjectReferences(
    'demo-app',
    'demo-app-next',
    groups,
    async (jid, updates) => {
      calls.push({ jid, updates });
      Object.assign(groups[jid as keyof typeof groups], updates);
    },
  );
  expect(calls).toEqual([
    { jid: 'framework', updates: { folder: 'demo-app-next' } },
    {
      jid: 'app',
      updates: { settings: { memorySourceProjects: ['demo-app-next'] } },
    },
  ]);
});

test('project deletion removes memory source references', async () => {
  const groups = {
    framework: {
      name: 'Framework',
      folder: 'demo-app',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {},
    },
    app: {
      name: 'App',
      folder: 'app',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { memorySourceProjects: ['demo-app', 'other'] },
    },
  };
  await removeDeletedMemorySourceReferences(
    'demo-app',
    groups,
    async (jid, updates) => {
      Object.assign(groups[jid as keyof typeof groups], updates);
    },
  );
  expect(groups.app.settings.memorySourceProjects).toEqual(['other']);
});
describe('task checkout settings API validation', () => {
  test('rejects legacy writes and invalid modes while accepting valid modes', () => {
    expect(
      validateTaskCheckoutSettingsWrite({ createBranchPerTask: false }),
    ).toContain('createBranchPerTask is retired');
    expect(
      validateTaskCheckoutSettingsWrite({ taskCheckoutMode: 'invalid' }),
    ).toContain('taskCheckoutMode must be');
    expect(
      validateTaskCheckoutSettingsWrite({ taskCheckoutMode: 'branch' }),
    ).toBe(undefined);
  });
});

describe('reserved collection-route folders over HTTP', () => {
  const tag = `reserved-${process.pid}`;
  let server: Server;
  let baseUrl: string;
  let users: Record<'owner' | 'other' | 'viewer' | 'admin', string>;
  const foreign: Record<string, RegisteredGroup> = {};
  const jids: string[] = [];

  function makeGroup(folder: string, userId?: string, isMain = false) {
    return {
      name: folder,
      folder,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: userId,
      is_main: isMain,
    } as RegisteredGroup;
  }

  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    users = {
      owner: (await createUser(`${tag}-owner`, 'pw', 'user')).id,
      other: (await createUser(`${tag}-other`, 'pw', 'user')).id,
      viewer: (await createUser(`${tag}-viewer`, 'pw', 'user')).id,
      admin: (await createUser(`${tag}-admin`, 'pw', 'admin')).id,
    };
    // Pre-existing projects whose folders collide with collection routes.
    for (const [key, folder, isMain] of [
      ['attention', 'attention', false],
      ['status', 'status-summary', false],
      ['order', 'order', false],
      ['plain', `${tag}-plain`, false],
      ['open', `${tag}-open`, false],
      ['main', `${tag}-main`, true],
      ['viewed', `${tag}-viewed`, false],
      ['agent', 'agent-project', false],
    ] as const) {
      const jid = `${folder}@web`;
      // `open` is ownerless: the one ordinary project admins reach unaided.
      foreign[key] = makeGroup(
        folder,
        key === 'open' ? undefined : users.owner,
        isMain,
      );
      await registerGroup(jid, foreign[key]);
      jids.push(jid);
    }
    await upsertProjectMember(users.owner, `${tag}-plain`, 'owner');
    await upsertProjectMember(users.viewer, `${tag}-viewed`, 'viewer');
    // An admin who is a plain member gets exactly that membership level.
    await upsertProjectMember(users.admin, `${tag}-viewed`, 'viewer');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Other suites reload the shared registry; restore this suite's groups.
      for (const [index, group] of Object.values(foreign).entries()) {
        registeredGroups[jids[index]] ??= group;
      }
      const id = req.header('x-test-user');
      if (id) {
        Object.assign(req, {
          authUser: { id, role: id === users.admin ? 'admin' : 'user' },
        });
      } else if (req.header('x-test-token')) {
        Object.assign(req, {
          authCredentialKind: 'agent',
          tokenScope: {
            group_folder: 'agent-project',
            ...(req.header('x-test-token') === 'run'
              ? { task_id: 'run-task', run_id: 'run-1' }
              : {}),
          },
        });
      }
      next();
    });
    app.use(projectsRouter);
    app.use(usersRouter);
    app.use(conversationsRouter);
    // Mounted after projectsRouter, like browser.ts: relies on the shared guard.
    app.all('/projects/:projectId/browser/x', (_req, res) => {
      res.json({ reached: true });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const jid of jids) await unregisterGroup(jid);
  });

  const call = (
    user: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-test-user': user } : {}),
        ...headers,
      },
      body:
        body === undefined || method === 'GET'
          ? undefined
          : JSON.stringify(body),
    });

  test.each([
    ['GET', '/projects/attention/tasks'],
    ['POST', '/projects/attention/tasks'],
    ['GET', '/projects/attention/conversations'],
    ['GET', '/projects/status-summary/conversations'],
    ['GET', '/projects/status-summary/tasks'],
    ['GET', '/projects/Attention/tasks'],
    ['GET', '/projects/%61ttention/tasks'],
    ['GET', '/projects/order/tasks'],
    ['PATCH', '/projects/order/anything'],
    ['GET', '/projects/attention/browser/x'],
    ['POST', '/projects/attention/dismiss/extra'],
    ['GET', '/projects/status-summary/browser/x'],
  ])('denies a non-member %s %s', async (method, path) => {
    const res = await call(users.other, method, path, {});
    expect(res.status).toBe(403);
  });

  test.each(['1', 'run'])(
    'agent credential cannot create a project (%s)',
    async (kind) => {
      const res = await call(
        undefined,
        'POST',
        '/projects',
        { name: `${tag}-agent-made` },
        { 'x-test-token': kind },
      );
      expect(res.status).toBe(403);
      expect(
        Object.values(registeredGroups).some((g) =>
          g.folder.includes(`${tag}-agent-made`),
        ),
      ).toBe(false);
    },
  );

  test.each(['1', 'run'])(
    'agent credential cannot list projects or the Now list (%s)',
    async (kind) => {
      for (const path of ['/projects', '/projects/attention']) {
        const res = await call(undefined, 'GET', path, undefined, {
          'x-test-token': kind,
        });
        expect(res.status).toBe(403);
      }
    },
  );

  test.each(['1', 'run'])(
    'agent credential cannot change its own project settings (%s)',
    async (kind) => {
      const stored = () =>
        Object.values(registeredGroups).find(
          (g) => g.folder === 'agent-project',
        )!;
      const before = JSON.stringify([
        stored().name,
        stored().settings?.kanbanTaskCostLimitUsd,
        stored().settings?.disabledToolsets,
      ]);
      const res = await call(
        undefined,
        'PATCH',
        '/projects/agent-project',
        {
          settings: { kanbanTaskCostLimitUsd: 999, disabledToolsets: [] },
          name: 'renamed',
        },
        { 'x-test-token': kind },
      );
      expect(res.status).toBe(403);
      expect(
        JSON.stringify([
          stored().name,
          stored().settings?.kanbanTaskCostLimitUsd,
          stored().settings?.disabledToolsets,
        ]),
      ).toBe(before);
    },
  );

  test('an admin cannot hand a conversation off into a foreign personal main', async () => {
    const conversation = await createConversation(`${tag}-plain`, {
      ownerUserId: users.admin,
    });
    const res = await call(
      users.admin,
      'POST',
      `/projects/${tag}-plain/conversations/${conversation.id}/handoff`,
      { destinationProjectId: `${tag}-main` },
    );
    expect(res.status).toBe(403);
  });

  describe('memory source grants', () => {
    const target = `${tag}-plain`;
    const patchSources = (user: string, sources: string[]) =>
      call(user, 'PATCH', `/projects/${target}`, {
        settings: { memorySourceProjects: sources },
      });
    const configured = () =>
      Object.values(registeredGroups).find((g) => g.folder === target)!.settings
        ?.memorySourceProjects;

    beforeAll(async () => {
      await upsertProjectMember(users.viewer, target, 'editor');
      await upsertProjectMember(users.viewer, 'agent-project', 'editor');
    });

    afterAll(() => {
      delete foreign.plain.settings?.memorySourceProjects;
    });

    test('a viewer of the source cannot add it', async () => {
      const res = await patchSources(users.viewer, [`${tag}-viewed`]);
      expect(res.status).toBe(403);
      expect(configured()).toBeUndefined();
    });

    test('an admin cannot add a foreign personal main', async () => {
      const res = await patchSources(users.admin, [`${tag}-main`]);
      expect(res.status).toBe(403);
      expect(configured()).toBeUndefined();
    });

    test('an editor of both projects can add the source', async () => {
      const res = await patchSources(users.viewer, ['agent-project']);
      expect(res.status).toBe(200);
      expect(configured()).toEqual(['agent-project']);
    });

    test('re-saving an already configured source passes without access to it', async () => {
      foreign.plain.settings = {
        ...foreign.plain.settings,
        memorySourceProjects: [`${tag}-viewed`],
      };
      const res = await patchSources(users.viewer, [`${tag}-viewed`]);
      expect(res.status).toBe(200);
      expect(configured()).toEqual([`${tag}-viewed`]);
    });
  });

  test('guards later-mounted routers for a project named attention', async () => {
    const denied = await call(
      users.other,
      'GET',
      '/projects/attention/browser/x',
    );
    expect(denied.status).toBe(403);
    const owner = await call(
      users.owner,
      'GET',
      '/projects/attention/browser/x',
    );
    expect(owner.status).toBe(200);
  });

  test('collection routes remain reachable for a plain user', async () => {
    expect((await call(users.other, 'GET', '/projects/attention')).status).toBe(
      200,
    );
    expect(
      (await call(users.other, 'GET', '/projects/status-summary')).status,
    ).toBe(200);
  });

  test('an admin member of another user’s project cannot change the repository connection', async () => {
    await upsertProjectMember(users.admin, `${tag}-plain`, 'editor');
    try {
      const res = await call(users.admin, 'PATCH', `/projects/${tag}-plain`, {
        settings: { repositoryUrl: 'https://example.com/x.git' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Only the project owner can change the repository connection',
      });
      const discovery = await call(
        users.admin,
        'POST',
        `/projects/${tag}-plain/discover-repositories`,
        {},
      );
      expect(discovery.status).not.toBe(403);
    } finally {
      await removeProjectMember(users.admin, `${tag}-plain`);
    }
  });

  test('admins are closed out of projects owned by another user', async () => {
    // Not a member of a normal project of another user, nor of their main.
    for (const folder of [`${tag}-plain`, `${tag}-main`]) {
      expect(
        (await call(users.admin, 'GET', `/projects/${folder}/tasks`)).status,
      ).toBe(403);
    }
    // An ownerless project keeps the admin bypass.
    expect(
      (await call(users.admin, 'GET', `/projects/${tag}-open/tasks`)).status,
    ).toBe(200);
    // Membership gives an admin exactly that level: viewer reads, never writes.
    expect(
      (await call(users.admin, 'GET', `/projects/${tag}-viewed/tasks`)).status,
    ).toBe(200);
    const write = await call(
      users.admin,
      'POST',
      `/projects/${tag}-viewed/tasks`,
      {},
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({
      error: 'Viewers have read-only access to this project',
    });
  });

  test('the member list passes the project guard for admins and owners only', async () => {
    const list = (user: string, folder: string) =>
      call(user, 'GET', `/projects/${folder}/members`);
    // Mounted behind projectsRouter, so the project guard runs first: an admin
    // who is no member of a project owned by another user still gets the list.
    for (const folder of [`${tag}-plain`, `${tag}-main`, `${tag}-viewed`]) {
      expect([folder, (await list(users.admin, folder)).status]).toEqual([
        folder,
        200,
      ]);
    }
    expect((await list(users.owner, `${tag}-plain`)).status).toBe(200);
    // A personal main's owner has no owner membership row.
    expect((await list(users.owner, `${tag}-main`)).status).toBe(200);
    expect((await list(users.viewer, `${tag}-viewed`)).status).toBe(403);
    expect((await list(users.other, `${tag}-plain`)).status).toBe(403);
  });

  test('discovery does not add an admin to an existing project owned by another user', () => {
    const admin = { id: users.admin, role: 'admin' };
    const report = {
      created: [{ projectId: `${tag}-plain` }],
      existing: [
        { projectId: `${tag}-plain` },
        { projectId: `${tag}-open` },
        { projectId: null },
      ],
    };
    // Created children inherit the parent's owner, so they are always added.
    expect(discoveryMembershipProjectIds(report, admin)).toEqual([
      `${tag}-plain`,
      `${tag}-open`,
    ]);
    expect(
      discoveryMembershipProjectIds(
        { created: [], existing: report.existing },
        admin,
      ),
    ).toEqual([`${tag}-open`]);
    expect(
      discoveryMembershipProjectIds(
        { created: [], existing: report.existing },
        { ...admin, role: 'user' },
      ),
    ).toEqual([`${tag}-plain`, `${tag}-open`]);
  });

  describe('PATCH /projects/order', () => {
    const order = (folder: string) =>
      Object.values(registeredGroups).find((g) => g.folder === folder)?.order;
    const ownGroup = () => `${tag}-plain`;

    test('applies owned entries and skips foreign ones', async () => {
      const res = await call(users.owner, 'PATCH', '/projects/order', {
        orders: { [ownGroup()]: 7 },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, skipped: 0 });
      expect(order(ownGroup())).toBe(7);

      const mixed = await call(users.other, 'PATCH', '/projects/order', {
        orders: { [ownGroup()]: 99, 'does-not-exist': 1 },
      });
      expect(mixed.status).toBe(200);
      expect(await mixed.json()).toEqual({ ok: true, skipped: 2 });
      expect(order(ownGroup())).toBe(7);
    });

    test('does not let a viewer reorder a shared project', async () => {
      const res = await call(users.viewer, 'PATCH', '/projects/order', {
        orders: { [`${tag}-viewed`]: 5 },
      });
      expect(await res.json()).toEqual({ ok: true, skipped: 1 });
      expect(order(`${tag}-viewed`)).toBeUndefined();
    });

    test('lets an admin reorder an ownerless project but not one owned by another user', async () => {
      const res = await call(users.admin, 'PATCH', '/projects/order', {
        orders: { [ownGroup()]: 3, [`${tag}-main`]: 4, [`${tag}-open`]: 5 },
      });
      expect(await res.json()).toEqual({ ok: true, skipped: 2 });
      expect(order(ownGroup())).toBe(7);
      expect(order(`${tag}-main`)).toBeUndefined();
      expect(order(`${tag}-open`)).toBe(5);
    });

    test('rejects agent-token callers without a user', async () => {
      const res = await call(
        undefined,
        'PATCH',
        '/projects/order',
        { orders: { [ownGroup()]: 11 } },
        { 'x-test-token': '1' },
      );
      expect(res.status).toBe(403);
      expect(order(ownGroup())).toBe(7);
    });
  });

  describe('attaching a project to a parent', () => {
    const parent = `${tag}-parent`;
    const child = `${tag}-child`;
    const created: string[] = [];
    // A parent change asks CarapaBox which sandboxes are up; none are.
    const attachSandboxClient = getSandboxClient() as any;
    const originalSandboxPs = attachSandboxClient.sandboxPs;

    beforeAll(async () => {
      attachSandboxClient.sandboxPs = async () => ({
        stdout: '[]',
        isError: false,
      });
      for (const [key, folder] of [
        ['parent', parent],
        ['child', child],
      ] as const) {
        const jid = `${folder}@web`;
        foreign[key] = makeGroup(folder, users.owner);
        await registerGroup(jid, foreign[key]);
        jids.push(jid);
        await upsertProjectMember(users.owner, folder, 'owner');
      }
      // `viewer` manages only the parent; `other` edits only the child.
      await upsertProjectMember(users.viewer, parent, 'editor');
      await upsertProjectMember(users.other, child, 'editor');
    });

    afterAll(async () => {
      attachSandboxClient.sandboxPs = originalSandboxPs;
      for (const folder of created) await unregisterGroup(`ui-${folder}`);
    });

    const parentOf = (folder: string) =>
      Object.values(registeredGroups).find((g) => g.folder === folder)
        ?.parentId;
    const create = async (
      user: string | undefined,
      folder: string,
      headers: Record<string, string> = {},
    ) => {
      const res = await call(
        user,
        'POST',
        '/projects',
        { name: folder, parentId: parent },
        headers,
      );
      if (res.status === 201) created.push(folder);
      return res;
    };

    test('refuses creation under a parent the caller cannot manage', async () => {
      for (const [user, headers] of [
        [users.other, {}],
        [undefined, { 'x-test-token': '1' }],
      ] as const) {
        const folder = `${tag}-denied-${created.length}-${user ? 'u' : 't'}`;
        const res = await create(user, folder, headers);
        expect(res.status).toBe(403);
        expect(
          Object.values(registeredGroups).some((g) => g.folder === folder),
        ).toBe(false);
      }
    });

    test('allows creation by a parent editor but not by an admin without membership', async () => {
      expect((await create(users.viewer, `${tag}-by-editor`)).status).toBe(201);
      expect((await create(users.admin, `${tag}-by-admin`)).status).toBe(403);
      expect(parentOf(`${tag}-by-editor`)).toBe(parent);
    });

    test('refuses reparenting without ownership of the child and management of the parent', async () => {
      // Editor of the child only, then owner of the child without parent access.
      const asEditor = await call(users.other, 'PATCH', `/projects/${child}`, {
        parentId: parent,
      });
      expect(asEditor.status).toBe(403);
      const asTokenHolder = await call(
        undefined,
        'PATCH',
        `/projects/${child}`,
        { parentId: parent },
        { 'x-test-token': '1' },
      );
      expect(asTokenHolder.status).toBe(403);
      // Owner of a child without any access to the parent.
      const solo = `${tag}-solo`;
      foreign.solo = makeGroup(solo, users.other);
      await registerGroup(`${solo}@web`, foreign.solo);
      jids.push(`${solo}@web`);
      await upsertProjectMember(users.other, solo, 'owner');
      const foreignParent = await call(
        users.other,
        'PATCH',
        `/projects/${solo}`,
        {
          parentId: parent,
        },
      );
      expect(foreignParent.status).toBe(403);
      expect(parentOf(solo)).toBeUndefined();
      expect(parentOf(child)).toBeUndefined();
    });

    test('lets the child owner who manages the parent attach and clear it', async () => {
      const attach = await call(users.owner, 'PATCH', `/projects/${child}`, {
        parentId: parent,
      });
      expect(attach.status).toBe(200);
      expect(parentOf(child)).toBe(parent);
      const clear = await call(users.other, 'PATCH', `/projects/${child}`, {
        parentId: null,
      });
      expect(clear.status).toBe(200);
      expect(parentOf(child)).toBeUndefined();
    });
  });

  describe('DELETE /projects/:pid', () => {
    const target = `${tag}-del`;
    let editor: string;
    const sandboxClient = getSandboxClient() as any;
    const tmuxClient = getTmuxClient() as any;
    const originalSandboxStop = sandboxClient.sandboxStop;
    const originalForget = tmuxClient.forgetByInstance;
    const exists = (folder: string) =>
      Object.values(registeredGroups).some((g) => g.folder === folder);

    async function addProject(folder: string, ownerless = false) {
      foreign[folder] = makeGroup(folder, ownerless ? undefined : users.owner);
      await registerGroup(`${folder}@web`, foreign[folder]);
      jids.push(`${folder}@web`);
      await upsertProjectMember(users.owner, folder, 'owner');
      await upsertProjectMember(editor, folder, 'editor');
      await upsertProjectMember(users.viewer, folder, 'viewer');
    }

    beforeAll(async () => {
      // A successful delete stops the sandbox through CarapaBox; stub it.
      sandboxClient.sandboxStop = async () => ({ stdout: '', isError: false });
      tmuxClient.forgetByInstance = async () => 0;
      editor = (await createUser(`${target}-editor`, 'pw', 'user')).id;
      for (const suffix of ['', '-owner', '-admin-denied']) {
        await addProject(`${target}${suffix}`);
      }
      await addProject(`${target}-admin`, true);
    });

    afterAll(() => {
      sandboxClient.sandboxStop = originalSandboxStop;
      tmuxClient.forgetByInstance = originalForget;
    });

    test.each(['editor', 'viewer'] as const)(
      'denies %s and keeps the project',
      async (who) => {
        const user = who === 'editor' ? editor : users.viewer;
        expect((await call(user, 'DELETE', `/projects/${target}`)).status).toBe(
          403,
        );
        expect(exists(target)).toBe(true);
      },
    );

    test('denies an admin on a project owned by another user', async () => {
      const folder = `${target}-admin-denied`;
      expect(
        (await call(users.admin, 'DELETE', `/projects/${folder}`)).status,
      ).toBe(403);
      expect(exists(folder)).toBe(true);
    });

    test.each([
      ['owner', () => users.owner, '-owner'],
      ['admin (ownerless project)', () => users.admin, '-admin'],
    ] as const)(
      'lets the %s delete the project',
      async (_who, user, suffix) => {
        const folder = `${target}${suffix}`;
        expect(
          (await call(user(), 'DELETE', `/projects/${folder}`)).status,
        ).toBe(200);
        expect(exists(folder)).toBe(false);
      },
    );
  });

  describe('repository settings validation', () => {
    const patchSettings = (settings: Record<string, unknown>) =>
      call(users.owner, 'PATCH', `/projects/${tag}-plain`, { settings });

    test.each(['bad branch name..', '-x', 'a..b', 'x.lock', '@'])(
      'rejects defaultBranch %j',
      async (defaultBranch) => {
        const res = await patchSettings({ defaultBranch });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'defaultBranch is not a valid git branch name',
        });
      },
    );

    test.each(['not a url ;; rm -rf', 'https://x/y\n', '-oProxyCommand=x'])(
      'rejects repositoryUrl %j',
      async (repositoryUrl) => {
        const res = await patchSettings({ repositoryUrl });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(
          'repositoryUrl must not contain whitespace',
        );
      },
    );

    test.each([
      { defaultBranch: 'feature/a-b', repositoryUrl: 'git@github.com:o/r.git' },
      { defaultBranch: 'release-1.2', repositoryUrl: 'https://github.com/o/r' },
      { defaultBranch: '', repositoryUrl: '' },
      { repositoryUrl: '/home/user/projects/repo' },
    ])('accepts %j', async (settings) => {
      const res = await patchSettings(settings);
      expect(res.status).toBe(200);
    });
  });

  describe('reserved folder creation', () => {
    test.each([
      ['order', { name: 'order' }],
      ['attention', { name: 'attention' }],
      ['Status Summary', { name: 'Status Summary' }],
      ['main-newhire', { name: 'x', folder: 'main-newhire' }],
      ['Main Newhire', { name: 'Main Newhire' }],
      ['MAIN-X', { name: 'x', folder: 'MAIN-X' }],
    ])('POST /projects rejects %s', async (_label, body) => {
      const res = await call(users.owner, 'POST', '/projects', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'is reserved',
      );
    });

    test('creating a project after a rename never evicts the renamed project', async () => {
      const oldName = `${tag}-rn-old`;
      const newFolder = `${tag}-rn-new`;
      const jidsOf = (folder: string) =>
        Object.entries(registeredGroups)
          .filter(([, g]) => g.folder === folder)
          .map(([jid]) => jid);
      try {
        expect(
          (await call(users.owner, 'POST', '/projects', { name: oldName }))
            .status,
        ).toBe(201);
        expect(
          (
            await call(users.owner, 'PATCH', `/projects/${oldName}`, {
              folder: newFolder,
            })
          ).status,
        ).toBe(200);
        expect(
          (await call(users.owner, 'POST', '/projects', { name: oldName }))
            .status,
        ).toBe(201);

        const renamedJids = jidsOf(newFolder);
        const recreatedJids = jidsOf(oldName);
        expect(renamedJids).toHaveLength(1);
        expect(recreatedJids).toHaveLength(1);
        expect(renamedJids[0]).not.toBe(recreatedJids[0]);
      } finally {
        for (const folder of [oldName, newFolder]) {
          for (const jid of jidsOf(folder)) await unregisterGroup(jid);
        }
      }
    });

    test('folder rename to a reserved slug is rejected', async () => {
      const res = await call(users.owner, 'PATCH', `/projects/${tag}-plain`, {
        folder: 'attention',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'is reserved',
      );
    });

    test('folder rename to a main- slug is rejected', async () => {
      const res = await call(users.owner, 'PATCH', `/projects/${tag}-plain`, {
        folder: 'main-x',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'is reserved',
      );
    });
  });
});
