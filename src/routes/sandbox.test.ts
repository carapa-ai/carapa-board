import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RegisteredGroup } from '../types.js';
import {
  parseStatus,
  rejectFixedInstanceLifecycle,
  resolveLifecycleTarget,
  runningStackNamesForInstance,
} from './sandbox.js';
import { lifecycleSandboxInstance } from '../sandbox/effective-settings.js';
import { interruptSandboxChatRuns } from '../sandbox/run-interruption.js';
import type { ActiveRun } from '../modules/kanban/execution/types.js';
import sandboxRouter from './sandbox.js';
import {
  createConversation,
  getConversation,
  getConversationSessionId,
  initDatabase,
  setConversationSessionId,
  updateConversationWorktreePath,
} from '../db.js';
import { truncateTestDb } from '../test-helpers.js';
import {
  createUser,
  upsertConversationMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import * as wsEvents from '../modules/objectives/ws-events.js';
import {
  acquireConversationExecutionLease,
  releaseConversationExecutionLease,
} from '../modules/chat/conversation-execution-lease.js';

const removalProject = 'sandbox-removal-project';
const removalGroup: RegisteredGroup = {
  name: 'Sandbox removal project',
  folder: removalProject,
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: {
    repositoryLocation: '/host/repos/sandbox-removal-project',
    defaultSandbox: 'sandbox-removal-stack',
  },
};
let server: Server | undefined;
let baseUrl = '';
let sandboxWorktreeResult = { stdout: '', isError: false };
const sandboxWorktreeCalls: unknown[][] = [];
const sandboxClient = getSandboxClient() as any;
const originalSandboxWorktree = sandboxClient.sandboxWorktree;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(`${removalProject}@web`, removalGroup);
  sandboxClient.sandboxWorktree = async (...args: unknown[]) => {
    sandboxWorktreeCalls.push(args);
    return sandboxWorktreeResult;
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const rawAgent = req.headers['x-test-agent-scope'];
    if (typeof rawAgent === 'string') {
      (req as any).authCredentialKind = 'agent';
      (req as any).tokenScope = JSON.parse(rawAgent);
      return next();
    }
    const raw = req.headers['x-test-user'];
    (req as any).authUser =
      typeof raw === 'string'
        ? { id: raw, role: 'user' }
        : { id: 'sandbox-admin', role: 'admin' };
    next();
  });
  app.use('/api', sandboxRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  sandboxWorktreeCalls.length = 0;
  sandboxWorktreeResult = { stdout: '', isError: false };
  await truncateTestDb();
});

afterAll(async () => {
  sandboxClient.sandboxWorktree = originalSandboxWorktree;
  await unregisterGroup(`${removalProject}@web`);
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

const parent: RegisteredGroup = {
  name: 'Shared owner',
  folder: 'api-shared-owner',
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: {
    isParent: true,
    sandboxOwnership: 'shared',
    defaultSandbox: 'shared-stack',
    defaultSandboxInstance: 'custom-shared-instance',
    defaultSandboxService: 'worker',
  },
};

const child: RegisteredGroup = {
  name: 'Child repository',
  folder: 'api-shared-child',
  parentId: parent.folder,
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: { repositoryLocation: '/host/repos/child' },
};

const fixedStandalone: RegisteredGroup = {
  name: 'External fixed sandbox',
  folder: 'fixed-standalone',
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: {
    defaultSandbox: 'external-stack',
    defaultSandboxInstance: 'external-instance',
  },
};

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
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

const lookup = (folder: string) =>
  folder === parent.folder
    ? parent
    : folder === child.folder
      ? child
      : folder === fixedStandalone.folder
        ? fixedStandalone
        : undefined;

describe('sandbox lifecycle API target resolution', () => {
  test('resolves an owner-addressed lifecycle request to the shared custom instance', async () => {
    const target = await resolveLifecycleTarget(
      { query: { group: parent.folder } },
      fakeResponse(),
      'shared-stack',
      {
        getGroupByFolder: lookup,
        userHasExplicitGroupAccess: async () => true,
      },
    );

    expect(target).toMatchObject({
      stack: 'shared-stack',
      instance: 'custom-shared-instance',
      service: 'worker',
      owner: { folder: parent.folder },
      group: { folder: parent.folder },
    });
  });

  test('requires lifecycle callers to address the shared owner directly', async () => {
    const authorizedFolders: string[] = [];
    const res = fakeResponse();
    const target = await resolveLifecycleTarget(
      { query: { group: child.folder } },
      res,
      'shared-stack',
      {
        getGroupByFolder: lookup,
        userHasExplicitGroupAccess: async (_req, folder) => {
          authorizedFolders.push(folder);
          return true;
        },
      },
    );

    expect(authorizedFolders).toEqual([child.folder]);
    expect(target).toBeNull();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'Sandbox lifecycle is owned by parent project "api-shared-owner"',
    });
  });

  test('does not turn owner access into implicit child lifecycle control', async () => {
    const res = fakeResponse();
    const target = await resolveLifecycleTarget(
      { query: { group: child.folder } },
      res,
      'shared-stack',
      {
        getGroupByFolder: lookup,
        userHasExplicitGroupAccess: async (_req, folder) =>
          folder === child.folder,
      },
    );

    expect(target).toBeNull();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'Sandbox lifecycle is owned by parent project "api-shared-owner"',
    });
  });

  test('rejects a stack other than the selected project effective stack', async () => {
    const res = fakeResponse();
    const target = await resolveLifecycleTarget(
      { query: { group: child.folder } },
      res,
      'child-controlled-stack',
      {
        getGroupByFolder: lookup,
        userHasExplicitGroupAccess: async () => true,
      },
      true,
    );

    expect(target).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied to this stack' });
  });

  test('accepts project identity in the worktree-style request body', async () => {
    const target = await resolveLifecycleTarget(
      { query: {}, body: { group: child.folder } },
      fakeResponse(),
      'shared-stack',
      {
        getGroupByFolder: lookup,
        userHasExplicitGroupAccess: async () => true,
      },
      true,
    );

    expect(target).toMatchObject({
      instance: 'custom-shared-instance',
      group: { folder: child.folder },
    });
  });

  test('keeps a standalone fixed instance outside managed lifecycle operations', async () => {
    const target = await resolveLifecycleTarget(
      { query: { group: fixedStandalone.folder } },
      fakeResponse(),
      'external-stack',
      {
        getGroupByFolder: lookup,
        userHasExplicitGroupAccess: async () => true,
      },
    );

    expect(target).not.toBeNull();
    expect(target).toBeDefined();
    expect(target?.instance).toBe('external-instance');
    expect(target && lifecycleSandboxInstance(target)).toBe(
      fixedStandalone.folder,
    );
    const res = fakeResponse();
    expect(rejectFixedInstanceLifecycle(res, target)).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'This sandbox instance is externally managed',
    });
  });
});

describe('running sandbox stack discovery', () => {
  test('finds the old running stack by managed instance', () => {
    const raw = JSON.stringify([
      {
        name: 'old-stack-api-shared-owner',
        stack: 'old-stack',
        instance: 'api-shared-owner',
        services: [],
      },
      {
        name: 'unrelated-other-project',
        stack: 'unrelated',
        instance: 'other-project',
        services: [],
      },
    ]);

    expect(runningStackNamesForInstance(raw, 'api-shared-owner')).toEqual([
      'old-stack',
    ]);
  });

  test('deduplicates matching stacks and tolerates legacy payloads', () => {
    const raw = JSON.stringify([
      { name: 'legacy-project', services: [] },
      { stack: 'old-stack', instance: 'project' },
      { stack: 'old-stack', instance: 'project' },
    ]);

    expect(runningStackNamesForInstance(raw, 'project')).toEqual(['old-stack']);
    expect(runningStackNamesForInstance('not json', 'project')).toEqual([]);
  });
});

describe('sandbox status', () => {
  test('a running peer service does not hide a crash-looping service', () => {
    const entry = (Service: string, State: string) => ({ Service, State });
    const status = (...entries: object[]) =>
      parseStatus({ stdout: JSON.stringify(entries), isError: false }).status;

    expect(
      status(entry('nginx', 'running'), entry('agent', 'restarting')),
    ).toBe('degraded');
    expect(status(entry('nginx', 'running'), entry('agent', 'running'))).toBe(
      'running',
    );
    expect(status(entry('agent', 'restarting'))).toBe('stopped');
  });
});

describe('sandbox chat-run interruption', () => {
  test('finishes persisted runs and clears each web conversation', async () => {
    const run = (overrides: Partial<ActiveRun>): ActiveRun => ({
      id: 'run-1',
      group_folder: 'project-a',
      chat_jid: 'project-a@web',
      session_id: null,
      conversation_id: 'conversation-a',
      isMain: 1,
      isScheduledTask: 0,
      scheduled_task_id: null,
      task_id: null,
      sandbox_stack: 'stack-a',
      sandbox_service: 'agent',
      sandbox_instance: 'instance-a',
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'running',
      model: null,
      agent_name: null,
      tok_total: null,
      tok_output: null,
      tok_input: null,
      tok_cache_write: null,
      tok_cache_read: null,
      tok_context_last: null,
      model_name: null,
      tool_usage_count: null,
      stage: null,
      ...overrides,
    });
    const completed: Array<[string, string]> = [];
    const aborted: string[] = [];
    const events: Array<{ type: string; payload: any }> = [];

    const count = await interruptSandboxChatRuns('instance-a', {
      getActiveRuns: async () => [
        run({}),
        run({ id: 'run-2', conversation_id: 'conversation-b' }),
        run({ id: 'run-3', chat_jid: 'bridge', conversation_id: null }),
      ],
      completeRun: async (id: string, status: string) => {
        completed.push([id, status]);
      },
      getConversation: async (id: string) =>
        id === 'conversation-b'
          ? ({ objective_id: 'objective-b' } as any)
          : undefined,
      abortWatcher: (_group: string, _jid: string, id?: string) => {
        if (id) aborted.push(id);
        return true;
      },
      broadcast: (event: any) => events.push(event),
    } as any);

    expect(count).toBe(3);
    expect(completed).toEqual([
      ['run-1', 'error'],
      ['run-2', 'error'],
      ['run-3', 'error'],
    ]);
    expect(aborted).toEqual(['conversation-a', 'conversation-b']);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'chat_completed',
      payload: {
        folder: 'project-a',
        conversation_id: 'conversation-a',
        failed: true,
        pending: false,
      },
    });
    expect(events[1]).toMatchObject({
      payload: {
        folder: 'project-a',
        conversation_id: 'conversation-b',
        objective_id: 'objective-b',
        project_id: 'project-a',
      },
    });
  });
});

describe('sandbox startup failures', () => {
  const failure =
    'Container llama-cpp-ninfer-agent-1 Starting\n' +
    'Error response from daemon: failed to fulfil mount request: ' +
    'open /run/nvidia-persistenced/socket: no such file or directory';

  test('returns the CarapaBox failure to the Start UI instead of announcing success', async () => {
    const start = spyOn(sandboxClient, 'sandboxStart').mockResolvedValue({
      stdout: failure,
      isError: true,
    });
    const broadcast = spyOn(wsEvents, 'broadcast').mockImplementation(() => {});
    try {
      const response = await fetch(`${baseUrl}/api/sandbox/llama-cpp/start`, {
        method: 'POST',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: `Error: ${failure}` });
      expect(start).toHaveBeenCalledTimes(1);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
      broadcast.mockRestore();
    }
  });

  test('publishes the failed restart with its original error after acknowledging the request', async () => {
    const start = spyOn(sandboxClient, 'sandboxStart').mockResolvedValue({
      stdout: failure,
      isError: true,
    });
    const stop = spyOn(sandboxClient, 'sandboxStop').mockResolvedValue({
      stdout: '',
      isError: false,
    });
    const ps = spyOn(sandboxClient, 'sandboxPs').mockResolvedValue({
      stdout: '[]',
      isError: false,
    });
    const events: Array<{
      action?: string;
      instance?: string;
      error?: string;
    }> = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const broadcast = spyOn(wsEvents, 'broadcast').mockImplementation(
      (event) => {
        if (event.type !== 'sandbox_status') return;
        const payload = event.payload as (typeof events)[number];
        events.push(payload);
        if (['restarted', 'restart_failed'].includes(String(payload.action))) {
          finish();
        }
      },
    );
    try {
      const response = await fetch(
        `${baseUrl}/api/sandbox/sandbox-removal-stack/restart?group=${removalProject}`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'restarting' });
      await completed;
      expect(start).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.action)).toEqual([
        'restarting',
        'restart_failed',
      ]);
      expect(events[1]).toMatchObject({
        instance: removalProject,
        error: `Error: ${failure}`,
      });
    } finally {
      start.mockRestore();
      stop.mockRestore();
      ps.mockRestore();
      broadcast.mockRestore();
    }
  });
});

describe('sandbox worktree removal', () => {
  async function remove(branch: string) {
    return fetch(
      `${baseUrl}/api/sandbox/sandbox-removal-stack/worktree/remove`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: removalProject, branch }),
      },
    );
  }

  test('resets every matching conversation after CarapaBox confirms removal', async () => {
    const first = await createConversation(removalProject, {
      use_worktree: true,
      branch_name: 'shared-task-branch',
    });
    const second = await createConversation(removalProject, {
      use_worktree: true,
      branch_name: 'shared-task-branch',
    });
    const kept = await createConversation(removalProject, {
      use_worktree: true,
      branch_name: 'kept-branch',
    });
    await updateConversationWorktreePath(
      first.id,
      '.worktrees/shared-task-branch',
    );
    await updateConversationWorktreePath(
      second.id,
      '.worktrees/shared-task-branch',
    );
    await setConversationSessionId(first.id, 'codex', 'first-session');
    await setConversationSessionId(second.id, 'claude', 'second-session');
    await setConversationSessionId(kept.id, 'codex', 'kept-session');

    const response = await remove('shared-task-branch');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      affectedConversationIds: string[];
    };
    expect(new Set(body.affectedConversationIds)).toEqual(
      new Set([first.id, second.id]),
    );
    expect(sandboxWorktreeCalls).toHaveLength(1);
    expect(sandboxWorktreeCalls[0]).toMatchObject([
      'sandbox-removal-stack',
      'remove',
      {
        branch: 'shared-task-branch',
        localRepo: '/host/repos/sandbox-removal-project',
      },
    ]);
    expect(await getConversation(first.id)).toMatchObject({
      use_worktree: 0,
      worktree_path: null,
      branch_name: null,
    });
    expect(await getConversation(second.id)).toMatchObject({
      use_worktree: 0,
      worktree_path: null,
      branch_name: null,
    });
    expect(await getConversationSessionId(first.id, 'codex')).toBeNull();
    expect(await getConversationSessionId(second.id, 'claude')).toBeNull();
    expect(await getConversation(kept.id)).toMatchObject({
      use_worktree: 1,
      branch_name: 'kept-branch',
    });
    expect(await getConversationSessionId(kept.id, 'codex')).toBe(
      'kept-session',
    );
  });

  test('preserves bindings and sessions when CarapaBox rejects removal', async () => {
    const conversation = await createConversation(removalProject, {
      use_worktree: true,
      branch_name: 'failed-branch',
    });
    await updateConversationWorktreePath(
      conversation.id,
      '.worktrees/failed-branch',
    );
    await setConversationSessionId(conversation.id, 'codex', 'kept-session');
    sandboxWorktreeResult = { stdout: 'worktree is busy', isError: true };

    const response = await remove('failed-branch');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'worktree is busy' });
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 1,
      worktree_path: '.worktrees/failed-branch',
      branch_name: 'failed-branch',
    });
    expect(await getConversationSessionId(conversation.id, 'codex')).toBe(
      'kept-session',
    );
  });

  test('returns a conflict without calling CarapaBox for an active conversation', async () => {
    const conversation = await createConversation(removalProject, {
      use_worktree: true,
      branch_name: 'busy-branch',
    });
    const lease = await acquireConversationExecutionLease(
      conversation.id,
      'busy-owner',
    );
    expect(lease).not.toBeNull();

    const response = await remove('busy-branch');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait for the active conversation runs to finish first',
      conversationIds: [conversation.id],
    });
    expect(sandboxWorktreeCalls).toHaveLength(0);
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 1,
      branch_name: 'busy-branch',
    });
    await releaseConversationExecutionLease(conversation.id, 'busy-owner');
  });
});

describe('sandbox lifecycle access for agent tokens', () => {
  const lifecycleCalls = (b: string): Array<[string, string]> => [
    ['POST', `${b}/ssh`],
    ['POST', `${b}/start`],
    ['POST', `${b}/stop`],
    ['POST', `${b}/restart`],
    ['POST', `${b}/restart?when=idle`],
    ['POST', `${b}/worktree/remove`],
  ];
  const call = (method: string, url: string, scope: object) =>
    fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-agent-scope': JSON.stringify(scope),
      },
      body: JSON.stringify({
        group: removalProject,
        branch: 'agent-x',
        enabled: true,
      }),
    });

  test('refuses task-run tokens and tokens without sandbox:restart', async () => {
    const b = `${baseUrl}/api/sandbox/sandbox-removal-stack`;
    const taskScope = {
      group_folder: removalProject,
      task_id: 'task-1',
      permissions: { [removalProject]: ['sandbox:restart'] },
    };
    const noPermission = {
      group_folder: removalProject,
      permissions: { [removalProject]: ['tasks:*'] },
    };
    for (const scope of [taskScope, noPermission]) {
      for (const [method, url] of lifecycleCalls(b)) {
        const response = await call(method, url, scope);
        expect(`${method} ${url} ${response.status}`).toContain(' 403');
      }
    }
    expect(sandboxWorktreeCalls).toHaveLength(0);
  });

  test('admits a non-task agent holding sandbox:restart but keeps SSH user-only', async () => {
    const b = `${baseUrl}/api/sandbox/sandbox-removal-stack`;
    const scope = {
      group_folder: removalProject,
      permissions: { [removalProject]: ['sandbox:restart'] },
    };
    const removal = await call('POST', `${b}/worktree/remove`, scope);
    expect(removal.status).toBe(200);
    const ssh = await call('POST', `${b}/ssh`, scope);
    expect(ssh.status).toBe(403);
  });
});

describe('sandbox lifecycle access for chat-only users', () => {
  test('denies implicit users and admits explicit members', async () => {
    const implicit = await createUser('sandbox-chat-only', 'pw-chat-only');
    const member = await createUser('sandbox-viewer', 'pw-viewer');
    const conversation = await createConversation(removalProject);
    await upsertConversationMember(implicit.id, conversation.id, 'viewer');
    await upsertProjectMember(member.id, removalProject, 'viewer');

    const base = `${baseUrl}/api/sandbox/sandbox-removal-stack`;
    const calls: Array<[string, string]> = [
      ['GET', `${base}/ssh?group=${removalProject}`],
      ['POST', `${base}/start?group=${removalProject}`],
      ['POST', `${base}/stop?group=${removalProject}`],
      ['POST', `${base}/restart?group=${removalProject}`],
      ['GET', `${base}/restart-pending?group=${removalProject}`],
      ['DELETE', `${base}/restart-pending?group=${removalProject}`],
      ['GET', `${baseUrl}/api/sandbox/status?group=${removalProject}`],
    ];
    for (const [method, url] of calls) {
      const denied = await fetch(url, {
        method,
        headers: { 'x-test-user': implicit.id },
      });
      expect(`${method} ${url} ${denied.status}`).toContain(' 403');
    }
    const worktree = await fetch(`${base}/worktree/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': implicit.id,
      },
      body: JSON.stringify({ group: removalProject, branch: 'chat-x' }),
    });
    expect(worktree.status).toBe(403);

    // Viewers may read lifecycle state but not change it.
    const viewerRead = await fetch(
      `${base}/restart-pending?group=${removalProject}`,
      { headers: { 'x-test-user': member.id } },
    );
    expect(viewerRead.status).not.toBe(403);
    const writes: Array<[string, string]> = [
      ['POST', `${base}/ssh?group=${removalProject}`],
      ['POST', `${base}/start?group=${removalProject}`],
      ['POST', `${base}/stop?group=${removalProject}`],
      ['POST', `${base}/restart?group=${removalProject}`],
      ['DELETE', `${base}/restart-pending?group=${removalProject}`],
      ['POST', `${base}/worktree/remove`],
    ];
    const writeInit = (userId: string) => ({
      headers: { 'content-type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        group: removalProject,
        branch: 'chat-x',
        enabled: true,
      }),
    });
    for (const [method, url] of writes) {
      const viewerWrite = await fetch(url, {
        method,
        ...writeInit(member.id),
      });
      expect(`${method} ${url} ${viewerWrite.status}`).toContain(' 403');
    }

    const editor = await createUser('sandbox-editor', 'pw-editor');
    await upsertProjectMember(editor.id, removalProject, 'editor');
    const editorWrite = await fetch(
      `${base}/restart-pending?group=${removalProject}`,
      { method: 'DELETE', headers: { 'x-test-user': editor.id } },
    );
    expect(editorWrite.status).not.toBe(403);
  });

  test('omits the project from unscoped status and ps for implicit users', async () => {
    const implicit = await createUser('sandbox-list-chat-only', 'pw-list-co');
    const member = await createUser('sandbox-list-viewer', 'pw-list-vw');
    const conversation = await createConversation(removalProject);
    await upsertConversationMember(implicit.id, conversation.id, 'viewer');
    await upsertProjectMember(member.id, removalProject, 'viewer');

    const status = spyOn(sandboxClient, 'sandboxStatus').mockResolvedValue({
      stdout: '[]',
      isError: false,
    });
    const instance = resolveEffectiveSandbox(removalGroup).instance;
    const ps = spyOn(sandboxClient, 'sandboxPs').mockResolvedValue({
      stdout: JSON.stringify([{ instance }]),
      isError: false,
    });
    try {
      const getJson = async (path: string, userId: string): Promise<any> =>
        (
          await fetch(`${baseUrl}${path}`, {
            headers: { 'x-test-user': userId },
          })
        ).json();

      expect(
        Object.keys(await getJson('/api/sandbox/status', implicit.id)),
      ).not.toContain(removalProject);
      expect(
        Object.keys(await getJson('/api/sandbox/status', member.id)),
      ).toContain(removalProject);

      expect(await getJson('/api/sandbox/ps', implicit.id)).toEqual([]);
      expect(await getJson('/api/sandbox/ps', member.id)).toHaveLength(1);
    } finally {
      status.mockRestore();
      ps.mockRestore();
    }
  });
});
