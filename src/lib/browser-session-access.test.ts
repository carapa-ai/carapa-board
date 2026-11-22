import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createConversation,
  createUser,
  initDatabase,
  updateConversationWorktreePath,
  upsertConversationMember,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { activeRuns, projects } from '../db/schema.js';
import { upsertProjectMember } from '../modules/knowledge/db-kb.js';
import { loadState } from '../state-manager.js';
import { DATA_DIR } from '../config.js';
import {
  authorizeBrowser,
  controlBrowser,
  listBrowserSessions as listSessions,
} from './browser-session-access.js';
import {
  browserSessionFile,
  ensurePersistentBrowser,
} from '../sandbox/browser-sessions.js';
import { ipcReplica } from '../sandbox/ipc-replica.js';
import {
  WebBrowserSessions,
  tabLeaseId,
} from '../modules/web/browser-sessions.js';

const instance = `browser-auth-${process.pid}`;
const first = `${instance}-one`;
const second = `${instance}-two`;
const custom = `${instance}-custom`;
const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`);
const hostWorktree = `/var/www/${first}/.worktrees/chat/nested`;
const containerWorktree = `/workspace/${first}/.worktrees/chat/nested`;
let owner: string;
let viewer: string;
let editor: string;
let chat: string;
const serviceCwd = '/srv/service';
const listBrowserSessions = (
  userId: string,
  projectId: string,
  conversationId?: string,
) =>
  listSessions(userId, projectId, conversationId, {
    sandboxExec: async (_stack, _service, command) => ({
      stdout: command === 'pwd' ? `${serviceCwd}\n` : '[]',
      isError: false,
    }),
  });
beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  owner = (await createUser(`${instance}-owner`, 'test', 'user')).id;
  viewer = (await createUser(`${instance}-viewer`, 'test', 'user')).id;
  editor = (await createUser(`${instance}-editor`, 'test', 'user')).id;
  for (const id of [first, second, custom]) {
    await drizzleDbRef.current.insert(projects).values({
      id,
      jid: `${id}@board`,
      name: id,
      folder: id,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner,
      settings: JSON.stringify({
        defaultSandbox: 'carapa-bot',
        defaultSandboxService: 'agent',
        defaultSandboxInstance: instance,
        ...(id === custom ? {} : { workspacePath: `/workspace/${id}` }),
      }),
    });
    await upsertProjectMember(owner, id, 'owner');
    await upsertProjectMember(viewer, id, 'viewer');
    await upsertProjectMember(editor, id, 'editor');
  }
  await loadState();
  chat = (
    await createConversation(first, { use_worktree: true, ownerUserId: owner })
  ).id;
  await updateConversationWorktreePath(chat, hostWorktree);
  await upsertConversationMember(editor, chat, 'viewer');
});
afterAll(async () => {
  fs.rmSync(ipc, { recursive: true, force: true });
  for (const id of [first, second, custom])
    await drizzleDbRef.current.delete(projects).where(eq(projects.id, id));
  await loadState();
});

test('default browsing needs no run; persistent conversations survive completion and remain project/conversation authorized', async () => {
  // A pre-fix descriptor used Box's host path as the browser/agent cwd.
  const legacy = ensurePersistentBrowser({
    projectId: first,
    conversationId: chat,
    stack: 'carapa-bot',
    service: 'agent',
    instance,
    workDir: hostWorktree,
    worktree: hostWorktree,
  });
  const idle = (await listBrowserSessions(owner, first, chat))!;
  const main = idle.find((value) => value.scope === 'default')!;
  const conversation = idle.find((value) => value.conversationId === chat)!;
  expect(main).toMatchObject({ scope: 'default', runId: null, worktree: null });
  expect(conversation).toMatchObject({
    scope: 'conversation',
    runId: null,
    worktree: hostWorktree,
  });
  expect(idle.some((session) => session.sessionId === legacy.id)).toBe(false);
  expect(await authorizeBrowser(owner, first, legacy.id)).toBeNull();
  const authorized = await authorizeBrowser(
    owner,
    first,
    conversation.sessionId,
  );
  expect(authorized?.persistent?.workDir).toBe(containerWorktree);
  expect(authorized?.persistent?.env.CARAPA_BROWSER_WORK_DIR).toBe(
    containerWorktree,
  );
  expect(await listBrowserSessions(viewer, first, chat)).toBeNull();
  expect(
    await authorizeBrowser(editor, first, conversation.sessionId),
  ).toBeNull();
  expect(await authorizeBrowser(owner, second, main.sessionId)).toBeNull();
  expect(
    (await listBrowserSessions(owner, second, chat))!.every(
      (value) => value.projectId === second && value.conversationId !== chat,
    ),
  ).toBe(true);
  const value = ensurePersistentBrowser({
    projectId: first,
    conversationId: chat,
    stack: 'carapa-bot',
    service: 'agent',
    instance,
    workDir: containerWorktree,
    worktree: conversation.worktree,
  });
  expect(value.id).toBe(conversation.sessionId);
  const runId = `${instance}-turn`;
  const dir = path.join(ipc, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'args.json'),
    JSON.stringify({
      env: { ...value.env, CARAPA_BROWSER_RUN_ID: runId },
      workDir: value.workDir,
    }),
  );
  await drizzleDbRef.current.insert(activeRuns).values({
    id: runId,
    group_folder: first,
    chat_jid: `${first}@board`,
    conversation_id: chat,
    sandbox_stack: value.stack,
    sandbox_service: value.service,
    sandbox_instance: instance,
    started_at: new Date().toISOString(),
    timeout_at: new Date().toISOString(),
    status: 'running',
  });
  expect(
    (await listBrowserSessions(owner, first, chat))!.find(
      (value) => value.conversationId === chat,
    )?.runId,
  ).toBe(runId);
  await drizzleDbRef.current
    .update(activeRuns)
    .set({ status: 'completed' })
    .where(eq(activeRuns.id, runId));
  fs.rmSync(dir, { recursive: true });
  expect(
    (await authorizeBrowser(owner, first, conversation.sessionId))?.session
      .runId,
  ).toBeNull();
  expect(
    (await listBrowserSessions(owner, first, chat))!.find(
      (value) => value.conversationId === chat,
    )?.sessionId,
  ).toBe(conversation.sessionId);
  await updateConversationWorktreePath(
    chat,
    `/workspace/${first}/.worktrees/replacement`,
  );
  expect(
    await authorizeBrowser(owner, first, conversation.sessionId),
  ).toBeNull();
});

test('dedicated browsers use the service cwd and retain their ID when repairing an older descriptor', async () => {
  const main = (await listBrowserSessions(owner, custom))![0];
  const file = browserSessionFile({
    stack: 'carapa-bot',
    instance,
    id: main.sessionId,
  });
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.useServiceWorkDir;
  fs.writeFileSync(file, JSON.stringify(legacy));
  let descriptor: Record<string, unknown> | undefined;
  await controlBrowser(
    owner,
    custom,
    main.sessionId,
    'start',
    'http://nginx/',
    {
      sandboxExec: async (_stack, _service, command) => {
        expect(command).toBe(`browser-open ${main.sessionId} start`);
        descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { stdout: '', isError: false };
      },
    },
  );
  expect(descriptor).toMatchObject({
    id: main.sessionId,
    useServiceWorkDir: true,
  });
  const customChat = (await createConversation(custom, { ownerUserId: owner }))
    .id;
  const conversation = (await listBrowserSessions(
    owner,
    custom,
    customChat,
  ))!.find((session) => session.conversationId === customChat)!;
  const conversationFile = browserSessionFile({
    stack: 'carapa-bot',
    instance,
    id: conversation.sessionId,
  });
  const oldConversation = JSON.parse(fs.readFileSync(conversationFile, 'utf8'));
  delete oldConversation.useServiceWorkDir;
  oldConversation.env.CARAPA_BROWSER_WORK_DIR = oldConversation.workDir;
  fs.writeFileSync(conversationFile, JSON.stringify(oldConversation));
  await listBrowserSessions(owner, custom, customChat);
  const repaired = (await authorizeBrowser(
    owner,
    custom,
    conversation.sessionId,
  ))!.persistent!;
  expect(repaired.useServiceWorkDir).toBe(true);
  expect(repaired.env.CARAPA_BROWSER_WORK_DIR).toBe('');
  // Without a Workspace Path a chat worktree lives beneath the service's real
  // cwd, not the possibly missing /workspace/<folder> root. The box shims reject
  // a service-cwd descriptor with a worktree, so it is pinned to that path.
  const worktreeChat = (
    await createConversation(custom, { use_worktree: true, ownerUserId: owner })
  ).id;
  const worktreeName = `.worktrees/chat-${worktreeChat}`;
  await updateConversationWorktreePath(
    worktreeChat,
    `/host/repo/${worktreeName}`,
  );
  // A descriptor persisted by the old build pinned the /workspace/<folder> path.
  const broken = ensurePersistentBrowser({
    projectId: custom,
    conversationId: worktreeChat,
    stack: 'carapa-bot',
    service: 'agent',
    instance,
    workDir: `/workspace/${custom}/${worktreeName}`,
    worktree: `/host/repo/${worktreeName}`,
  });
  const worktreeSession = (await listBrowserSessions(
    owner,
    custom,
    worktreeChat,
  ))!.find((session) => session.conversationId === worktreeChat)!;
  expect(worktreeSession.sessionId).not.toBe(broken.id);
  expect(await authorizeBrowser(owner, custom, broken.id)).toBeNull();
  const worktreeBrowser = (await authorizeBrowser(
    owner,
    custom,
    worktreeSession.sessionId,
  ))!.persistent!;
  expect(worktreeBrowser.workDir).toBe(`${serviceCwd}/${worktreeName}`);
  expect(worktreeBrowser.env.CARAPA_BROWSER_WORK_DIR).toBe(
    `${serviceCwd}/${worktreeName}`,
  );
  expect(worktreeBrowser.useServiceWorkDir).toBe(false);
  await controlBrowser(
    owner,
    custom,
    conversation.sessionId,
    'start',
    undefined,
    {
      sandboxExec: async () => {
        expect(
          JSON.parse(fs.readFileSync(conversationFile, 'utf8'))
            .useServiceWorkDir,
        ).toBe(true);
        return { stdout: '', isError: false };
      },
    },
  );
  // Explicit workspace roots and conversation/worktree paths remain pinned.
  const pinned = (await listBrowserSessions(owner, first, chat))!;
  for (const session of pinned) {
    const value = (await authorizeBrowser(owner, first, session.sessionId))!
      .persistent!;
    expect(value.useServiceWorkDir).toBeFalsy();
  }
  await expect(
    controlBrowser(owner, custom, main.sessionId, 'start', undefined, {
      sandboxExec: async () => ({
        stdout:
          'browser-open: Browser working directory does not exist: /missing\nhttps://user:secret@nginx/?token=private',
        isError: true,
      }),
    }),
  ).rejects.toThrow('Browser working directory does not exist: /missing');
  try {
    await controlBrowser(owner, custom, main.sessionId, 'start', undefined, {
      sandboxExec: async () => ({
        stdout:
          'browser-open: Navigation failed for https://user:secret@nginx/?token=private',
        isError: true,
      }),
    });
    throw new Error('Expected navigation failure');
  } catch (error) {
    expect(String(error)).toContain('Navigation failed');
    expect(String(error)).not.toContain('secret');
    expect(String(error)).not.toContain('private');
  }
});

test('on-demand controls authorize before exec and keep navigation URLs out of commands', async () => {
  const main = (await listBrowserSessions(owner, first))!.find(
    (value) => value.scope === 'default',
  )!;
  const calls: string[] = [];
  const client = {
    sandboxExec: async (_stack: string, _service: string, command: string) => {
      calls.push(command);
      return { stdout: '', isError: false };
    },
  };
  await expect(
    controlBrowser(
      viewer,
      first,
      main.sessionId,
      'start',
      'http://nginx/',
      client,
    ),
  ).rejects.toThrow('unavailable');
  await expect(
    controlBrowser(
      owner,
      second,
      main.sessionId,
      'start',
      'http://nginx/',
      client,
    ),
  ).rejects.toThrow('unavailable');
  await expect(
    controlBrowser(
      owner,
      first,
      main.sessionId,
      'start',
      'file:///etc/passwd',
      client,
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
  for (const action of ['start', 'restart', 'close'] as const)
    await controlBrowser(
      owner,
      first,
      main.sessionId,
      action,
      'http://nginx/path?q=$(example)',
      client,
    );
  expect(calls).toEqual([
    `browser-open ${main.sessionId} start`,
    `browser-open ${main.sessionId} restart`,
    `browser-close ${main.sessionId}`,
  ]);
  const file = browserSessionFile({
    stack: 'carapa-bot',
    instance,
    id: main.sessionId,
  });
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).requestedUrl).toBe(
    'http://nginx/path?q=$(example)',
  );
});

test('an admin reaches a browser of a project owned by another user only as a member', async () => {
  const admin = (await createUser(`${instance}-admin`, 'test', 'admin')).id;
  const main = (await listBrowserSessions(owner, first))!.find(
    (value) => value.scope === 'default',
  )!;
  const conversation = (await listBrowserSessions(owner, first, chat))!.find(
    (value) => value.conversationId === chat,
  )!;
  expect(await listBrowserSessions(admin, first)).toBeNull();
  expect(await authorizeBrowser(admin, first, main.sessionId)).toBeNull();

  // A member admin is treated like the project editor they are.
  await upsertProjectMember(admin, first, 'viewer');
  expect(await authorizeBrowser(admin, first, main.sessionId)).toBeNull();
  await upsertProjectMember(admin, first, 'editor');
  expect(await authorizeBrowser(admin, first, main.sessionId)).not.toBeNull();
  expect(
    await authorizeBrowser(admin, first, conversation.sessionId),
  ).not.toBeNull();
});

test('native-runner starts lease a hub browser and keep its token out of Board files; docker starts are unchanged', async () => {
  const main = (await listBrowserSessions(owner, first))!.find(
    (value) => value.scope === 'default',
  )!;
  const file = browserSessionFile({
    stack: 'carapa-bot',
    instance,
    id: main.sessionId,
  });
  const sidecar: { method: string; body?: string }[] = [];
  const tabs = new WebBrowserSessions({
    sidecarUrl: 'http://sidecar:3210',
    token: 'm'.repeat(64),
    gatewayUrl: 'ws://relay/board-api',
    fetch: async (_url, init) => {
      sidecar.push({ method: init.method!, body: init.body as string });
      return new Response(null, { status: init.method === 'POST' ? 201 : 204 });
    },
  });
  const execs: { command: string; options: unknown }[] = [];
  const order: string[] = [];
  let failDispatch = false;
  const client = {
    sandboxExec: async (
      _stack: string,
      _service: string,
      command: string,
      options?: unknown,
    ) => {
      order.push(`exec ${command.split(' ')[0]}`);
      execs.push({ command, options });
      if (failDispatch) throw new Error('runner disconnected');
      return { stdout: '', isError: false };
    },
  };
  const flush = spyOn(ipcReplica, 'flushPath').mockImplementation(
    async (target, options) => {
      order.push(`flush ${path.basename(target)} strict=${!!options?.strict}`);
    },
  );
  const url = 'https://example.test/app';
  const control = (action: 'start' | 'restart' | 'close', native: boolean) =>
    controlBrowser(owner, first, main.sessionId, action, url, client, {
      isNative: () => native,
      tabs,
    });

  await control('start', false);
  expect(execs[0].options).toEqual({ instance, timeout: 150 });
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).env).not.toHaveProperty(
    'PLAYWRIGHT_MCP_CDP_ENDPOINT',
  );
  expect(sidecar).toHaveLength(0);

  expect(flush).not.toHaveBeenCalled();

  await control('start', true);
  // The Mac reads its own copy: the descriptor is replicated before dispatch.
  expect(order.slice(-2)).toEqual([
    `flush ${path.basename(file)} strict=true`,
    'exec browser-open',
  ]);
  const token = JSON.parse(sidecar.find((r) => r.method === 'POST')!.body!)
    .token as string;
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).env).toMatchObject({
    PLAYWRIGHT_MCP_CDP_ENDPOINT: `ws://relay/board-api/api/web-browser/sessions/${tabLeaseId(main.sessionId)}/cdp`,
  });
  expect(execs[1].options).toEqual({
    instance,
    timeout: 150,
    env: { PLAYWRIGHT_MCP_CDP_HEADERS: `X-Carapa-Browser-Token: ${token}` },
  });
  for (const name of fs.readdirSync(ipc, { recursive: true }) as string[]) {
    const entry = path.join(ipc, name);
    if (fs.statSync(entry).isFile())
      expect(fs.readFileSync(entry, 'utf8')).not.toContain(token);
  }

  // A restart reuses the live lease after probing it; close deletes it at the sidecar.
  const requests = sidecar.length;
  await control('restart', true);
  expect(sidecar.slice(requests).map((r) => r.method)).toEqual(['PATCH']);
  await control('close', true);
  expect(sidecar.at(-1)!.method).toBe('DELETE');

  // A runner that drops while dispatching leaves no browser: a lease created
  // by that start is deleted instead of being renewed.
  failDispatch = true;
  sidecar.length = 0;
  await expect(control('start', true)).rejects.toThrow('runner disconnected');
  expect(sidecar.map((r) => r.method)).toEqual(['DELETE', 'POST', 'DELETE']);
  flush.mockRestore();
});
