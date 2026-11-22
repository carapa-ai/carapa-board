import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';

import fs from 'node:fs';
import path from 'node:path';
import { eq, like } from 'drizzle-orm';

import { DATA_DIR, DEFAULT_SANDBOX_STACK } from '../config.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import * as db from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import {
  conversationMembers,
  conversations,
  datasetTasks,
  knowledgeBases,
  projects,
} from '../db/schema.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import {
  getProjectAccess,
  MainFolderTakenError,
  userCanAccessConversation,
} from '../modules/knowledge/db-kb.js';
import * as archiveMain from '../modules/projects/archive-main.js';
import {
  createOrEnableConversationPublicShare,
  resolveConversationPublicShare,
} from '../modules/chat/db-public-shares.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  updateGroup,
} from '../state-manager.js';
import { generateAgentToken, verifyToken } from '../mcp/auth-tokens.js';
import { liveGrants } from '../lib/folder-identity.js';
import { getAgentPermissions } from '../mcp/auth.js';
import { ipcReplica } from '../sandbox/ipc-replica.js';
import { getMemoryBackend } from '../modules/memory/backend/factory.js';
import { getPrivacyErasureEpoch } from '../modules/memory/privacy-epoch.js';
import { isForeignMainFor } from './_helpers.js';

const tag = `users-route-${process.pid}`;

// The route imports `createUser` from the db barrel, so the barrel is swapped
// for a controllable stub. Bun's mock.module is process-global: the stub
// delegates to the real implementation unless a test arms it, and the original
// module is registered again when this file finishes.
const originalExports = { ...db };
const realCreateUser = db.createUser;
const realInitDatabase = db.initDatabase;
let createUserImpl: typeof realCreateUser = realCreateUser;

mock.module('../db.js', () => ({
  ...originalExports,
  createUser: (...args: Parameters<typeof realCreateUser>) =>
    createUserImpl(...args),
}));

// Same pattern for the archive step, so a test can make one dependency fail.
const realArchivePersonalMain = archiveMain.archivePersonalMain;
let archiveOverrides: Partial<archiveMain.ArchiveMainDeps> = {};
mock.module('../modules/projects/archive-main.js', () => ({
  ...archiveMain,
  archivePersonalMain: (
    folder: string,
    deps: Partial<archiveMain.ArchiveMainDeps> = {},
  ) =>
    realArchivePersonalMain(folder, {
      // Never reach a live CarapaBox from the archive's key cleanup.
      deleteIntegrationKeys: async () => 0,
      ...deps,
      ...archiveOverrides,
    }),
}));

// Archiving stops the main's sandbox through MCP; keep the tests off the network.
const sandboxClient = getSandboxClient() as any;
const tmuxClient = getTmuxClient() as any;
const originalSandboxStop = sandboxClient.sandboxStop;
const originalSandboxStatus = sandboxClient.sandboxStatus;
const originalSandboxPs = sandboxClient.sandboxPs;
const nothingRunning = async () => ({
  stdout: 'No running sandboxes found.',
  isError: false,
});
const stoppedStatus = async () => ({ stdout: '[]', isError: false });
const originalForget = tmuxClient.forgetByInstance;

let server: Server;
let baseUrl: string;

async function postUser(body: Record<string, unknown>): Promise<{
  status: number;
  text: string;
  json: any;
}> {
  const response = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text ? JSON.parse(text) : null,
  };
}

async function insertActiveDatasetTask(
  id: string,
  project: string,
): Promise<void> {
  await drizzleDbRef.current.insert(datasetTasks).values({
    id,
    project_id: project,
    title: 'Rows',
    dataset: '[]',
    total_rows: 1,
    created_at: new Date().toISOString(),
  });
}

async function datasetStatus(id: string): Promise<string | undefined> {
  const [row] = await drizzleDbRef.current
    .select({ status: datasetTasks.status })
    .from(datasetTasks)
    .where(eq(datasetTasks.id, id));
  return row?.status;
}

async function deleteUserRequest(id: string): Promise<{
  status: number;
  json: any;
}> {
  const response = await fetch(`${baseUrl}/api/users/${id}`, {
    method: 'DELETE',
  });
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  sandboxClient.sandboxStop = async () => ({ stdout: '', isError: false });
  sandboxClient.sandboxStatus = stoppedStatus;
  sandboxClient.sandboxPs = nothingRunning;
  tmuxClient.forgetByInstance = async () => 0;
  await realInitDatabase(':memory:');
  await loadState();
  const usersRouter = (await import('./users.js')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = req.header('x-test-user');
    const asAdmin = req.header('x-test-admin');
    (req as any).authUser = asAdmin
      ? { id: asAdmin, username: asAdmin, role: 'admin' }
      : asUser
        ? { id: asUser, username: asUser, role: 'user' }
        : {
            id: req.header('x-test-user-id') ?? 'admin-1',
            username: 'admin',
            role: 'admin',
          };
    next();
  });
  app.use('/api', usersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  // Sandbox storage the tests created (and the archive moved) under data/ipc.
  const ipcRoot = path.join(DATA_DIR, 'ipc');
  for (const name of fs.existsSync(ipcRoot) ? fs.readdirSync(ipcRoot) : []) {
    if (name.includes(tag))
      fs.rmSync(path.join(ipcRoot, name), { recursive: true, force: true });
  }
  createUserImpl = realCreateUser;
  sandboxClient.sandboxStop = originalSandboxStop;
  sandboxClient.sandboxStatus = originalSandboxStatus;
  sandboxClient.sandboxPs = originalSandboxPs;
  tmuxClient.forgetByInstance = originalForget;
  mock.module('../db.js', () => ({ ...originalExports }));
  mock.module('../modules/projects/archive-main.js', () => ({
    ...archiveMain,
  }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST /api/users', () => {
  test('reports a duplicate username as a conflict without leaking the driver error', async () => {
    const username = `${tag}-duplicate`;
    const created = await postUser({ username, password: 'secret-password' });
    expect(created.status).toBe(201);

    const duplicate = await postUser({
      username,
      password: 'secret-password',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json).toEqual({ error: 'Username already taken' });
    expect(duplicate.text).not.toContain('scrypt');
    expect(duplicate.text).not.toContain('insert into');
  });

  test('reports an unexpected database failure without the driver message', async () => {
    createUserImpl = async () => {
      throw new Error(
        'Failed query: insert into "users" ("id", "username") params: user-1,bob,scrypt:salt:hash,user,2026-01-01',
      );
    };
    try {
      const failure = await postUser({
        username: `${tag}-failure`,
        password: 'secret-password',
      });
      expect(failure.status).toBe(500);
      expect(failure.json).toEqual({ error: 'Failed to create user' });
      expect(failure.text).not.toContain('scrypt');
    } finally {
      createUserImpl = realCreateUser;
    }
  });

  test('reports a taken personal main folder as a conflict', async () => {
    createUserImpl = async () => {
      throw new MainFolderTakenError('main-x');
    };
    try {
      const taken = await postUser({
        username: `${tag}-taken`,
        password: 'secret-password',
      });
      expect(taken.status).toBe(409);
      expect(taken.json).toEqual({
        error:
          'The personal project folder for this username is already used by another project. Rename that project or choose another username.',
      });
    } finally {
      createUserImpl = realCreateUser;
    }
  });

  test('rejects a whitespace-only username as a bad request', async () => {
    const rejected = await postUser({
      username: '   ',
      password: 'secret-password',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toEqual({
      error: 'username and password are required',
    });
  });

  test('stores the trimmed username', async () => {
    const created = await postUser({
      username: `  ${tag}-trimmed  `,
      password: 'secret-password',
    });
    expect(created.status).toBe(201);
    expect(created.json.username).toBe(`${tag}-trimmed`);
  });
});

describe('member routes: admins and projects owned by another user', () => {
  const memberRequest = (
    method: 'POST' | 'DELETE',
    base: string,
    userId: string,
    asUser?: string,
    asAdmin?: string,
  ) =>
    fetch(
      `${baseUrl}/api/${base}/members${method === 'DELETE' ? `/${userId}` : ''}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(asUser ? { 'x-test-user': asUser } : {}),
          ...(asAdmin ? { 'x-test-admin': asAdmin } : {}),
        },
        body:
          method === 'POST' ? JSON.stringify({ user_id: userId }) : undefined,
      },
    );

  test('only the project owner manages members of a project owned by another user', async () => {
    const owner = (
      await postUser({
        username: `${tag}-m-owner`,
        password: 'secret-password',
      })
    ).json.id;
    const guest = (
      await postUser({
        username: `${tag}-m-guest`,
        password: 'secret-password',
      })
    ).json.id;
    for (const [folder, user_id] of [
      [`${tag}-owned`, owner],
      [`${tag}-ownerless`, undefined],
    ] as const) {
      await registerGroup(`${folder}@web`, {
        name: folder,
        folder,
        trigger: '!',
        added_at: new Date().toISOString(),
        user_id,
      });
    }
    await db.upsertProjectMember(owner, `${tag}-owned`, 'owner');
    const owned = `projects/${tag}-owned`;

    // The admin cannot add anyone, himself included, nor remove a member.
    expect((await memberRequest('POST', owned, 'admin-1')).status).toBe(403);
    expect((await memberRequest('POST', owned, guest)).status).toBe(403);
    expect(await getProjectAccess(guest, `${tag}-owned`)).toBeNull();
    await db.upsertProjectMember(guest, `${tag}-owned`, 'viewer');
    expect((await memberRequest('DELETE', owned, guest)).status).toBe(403);
    expect(await getProjectAccess(guest, `${tag}-owned`)).not.toBeNull();

    // The owner still manages them.
    expect((await memberRequest('DELETE', owned, guest, owner)).status).toBe(
      200,
    );
    expect((await memberRequest('POST', owned, guest, owner)).status).toBe(200);
    expect(await getProjectAccess(guest, `${tag}-owned`)).not.toBeNull();

    // An owner-level membership granted to an admin does not open the project.
    const memberAdmin = (
      await db.createUser(`${tag}-m-admin`, 'secret-password', 'admin')
    ).id;
    await db.upsertProjectMember(memberAdmin, `${tag}-owned`, 'owner');
    for (const method of ['POST', 'DELETE'] as const) {
      expect(
        (await memberRequest(method, owned, guest, undefined, memberAdmin))
          .status,
      ).toBe(403);
    }

    // An owner-level member who is not the registered owner cannot manage
    // members, so cannot hand an admin access either.
    const coOwner = (
      await postUser({
        username: `${tag}-m-coowner`,
        password: 'secret-password',
      })
    ).json.id;
    await db.upsertProjectMember(coOwner, `${tag}-owned`, 'owner');
    for (const method of ['POST', 'DELETE'] as const) {
      expect((await memberRequest(method, owned, guest, coOwner)).status).toBe(
        403,
      );
    }

    // The registered owner needs no owner membership row.
    const rowless = (
      await postUser({
        username: `${tag}-m-rowless`,
        password: 'secret-password',
      })
    ).json.id;
    await registerGroup(`${tag}-rowless@web`, {
      name: `${tag}-rowless`,
      folder: `${tag}-rowless`,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: rowless,
    });
    expect(
      (await memberRequest('POST', `projects/${tag}-rowless`, guest, rowless))
        .status,
    ).toBe(200);
    expect(
      (await memberRequest('POST', `projects/${tag}-rowless`, guest)).status,
    ).toBe(403);

    // Nobody else could reach an ownerless project: the admin bypass stays.
    const ownerless = `projects/${tag}-ownerless`;
    expect((await memberRequest('POST', ownerless, guest)).status).toBe(200);
    expect((await memberRequest('DELETE', ownerless, guest)).status).toBe(200);
    // With no registered owner, an owner member manages members.
    await db.upsertProjectMember(coOwner, `${tag}-ownerless`, 'owner');
    expect(
      (await memberRequest('POST', ownerless, guest, coOwner)).status,
    ).toBe(200);
  });

  test('only the KB owner manages members of a KB that has an owner', async () => {
    const owner = (
      await postUser({
        username: `${tag}-kb-owner`,
        password: 'secret-password',
      })
    ).json.id;
    const guest = (
      await postUser({
        username: `${tag}-kb-guest`,
        password: 'secret-password',
      })
    ).json.id;
    for (const id of [`${tag}-kb-owned`, `${tag}-kb-ownerless`]) {
      await drizzleDbRef.current
        .insert(knowledgeBases)
        .values({ id, name: id, folder_path: id, created_at: Date.now() });
    }
    await db.upsertKbMember(owner, `${tag}-kb-owned`, 'owner');

    const owned = `knowledge-bases/${tag}-kb-owned`;
    expect((await memberRequest('POST', owned, guest)).status).toBe(403);
    expect((await memberRequest('POST', owned, guest, owner)).status).toBe(200);
    expect((await memberRequest('DELETE', owned, guest)).status).toBe(403);
    expect((await memberRequest('DELETE', owned, guest, owner)).status).toBe(
      200,
    );

    const ownerless = `knowledge-bases/${tag}-kb-ownerless`;
    expect((await memberRequest('POST', ownerless, guest)).status).toBe(200);
  });
});

describe('GET /api/projects/:pid/members', () => {
  test('only admins and the project owner list the members', async () => {
    const folder = `${tag}-list`;
    await registerGroup(`${folder}@web`, {
      name: folder,
      folder,
      trigger: '!',
      added_at: new Date().toISOString(),
    });
    const ids: Record<string, string> = {};
    for (const name of ['owner', 'editor', 'viewer', 'chat', 'stranger']) {
      ids[name] = (
        await postUser({
          username: `${tag}-l-${name}`,
          password: 'secret-password',
        })
      ).json.id;
    }
    await db.upsertProjectMember(ids.owner, folder, 'owner');
    await db.upsertProjectMember(ids.editor, folder, 'editor');
    await db.upsertProjectMember(ids.viewer, folder, 'viewer');
    const conversation = await db.createConversation(folder, {
      ownerUserId: ids.owner,
    });
    await db.upsertConversationMember(ids.chat, conversation.id, 'editor');

    const list = (asUser?: string, asAdmin?: string) =>
      fetch(`${baseUrl}/api/projects/${folder}/members`, {
        headers: {
          ...(asUser ? { 'x-test-user': asUser } : {}),
          ...(asAdmin ? { 'x-test-admin': asAdmin } : {}),
        },
      });
    expect((await list(undefined, 'admin-1')).status).toBe(200);
    const asOwner = await list(ids.owner);
    expect(asOwner.status).toBe(200);
    expect(((await asOwner.json()) as unknown[]).length).toBe(3);
    for (const name of ['editor', 'viewer', 'chat', 'stranger']) {
      expect([name, (await list(ids[name])).status]).toEqual([name, 403]);
    }

    // The registered owner (`projects.user_id`) owns a project without any
    // owner membership row, such as a personal main. An owner membership the
    // owner granted lists the members too, but not on a personal main.
    const owned = `${tag}-list-owned`;
    await registerGroup(`${owned}@web`, {
      name: owned,
      folder: owned,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: ids.owner,
    });
    await db.upsertProjectMember(ids.stranger, owned, 'owner');
    const listOwned = (asUser: string) =>
      fetch(`${baseUrl}/api/projects/${owned}/members`, {
        headers: { 'x-test-user': asUser },
      });
    expect((await listOwned(ids.owner)).status).toBe(200);
    expect((await listOwned(ids.stranger)).status).toBe(200);
    expect((await listOwned(ids.editor)).status).toBe(403);
    const main = `${tag}-list-main`;
    await registerGroup(`${main}@web`, {
      name: main,
      folder: main,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: ids.owner,
      is_main: true,
    });
    await db.upsertProjectMember(ids.stranger, main, 'owner');
    const listMain = (asUser: string) =>
      fetch(`${baseUrl}/api/projects/${main}/members`, {
        headers: { 'x-test-user': asUser },
      });
    expect((await listMain(ids.owner)).status).toBe(200);
    expect((await listMain(ids.stranger)).status).toBe(403);
  });
});

describe('PATCH /api/users/:id password reset', () => {
  test("notifies the target of another user's reset but not of a self-reset", async () => {
    const target = await postUser({
      username: `${tag}-reset-target`,
      password: 'secret-password',
    });
    const reset = (id: string, asUserId?: string) =>
      fetch(`${baseUrl}/api/users/${id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(asUserId ? { 'x-test-user-id': asUserId } : {}),
        },
        body: JSON.stringify({ password: 'new-secret-password' }),
      });

    expect((await reset(target.json.id)).status).toBe(200);
    const notices = await db.getUnreadPayloads(target.json.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].summary).toMatch(
      /^Password reset by admin at \d{4}-\d{2}-\d{2}T/,
    );

    await db.ackUnreadPayloads(target.json.id);
    expect((await reset(target.json.id, target.json.id)).status).toBe(200);
    expect(await db.getUnreadPayloads(target.json.id)).toHaveLength(0);
  });
});

describe('DELETE /api/users/:id', () => {
  test('archives a main when no sandbox has ever created the IPC root', async () => {
    // Removed only when empty, so storage another test left behind is safe.
    try {
      fs.rmdirSync(path.join(DATA_DIR, 'ipc'));
    } catch {
      /* absent or in use */
    }
    const created = await postUser({
      username: `${tag}-noipc`,
      password: 'secret-password',
    });
    expect((await deleteUserRequest(created.json.id)).status).toBe(200);
  });

  test('archives the main so a re-created username starts empty', async () => {
    const username = `${tag}-recreate`;
    const folder = `main-${username}`;
    const first = await postUser({ username, password: 'secret-password' });
    await drizzleDbRef.current.insert(conversations).values({
      id: `${tag}-conversation`,
      group_folder: folder,
      created_at: new Date().toISOString(),
    });
    // Access that could outlive the owner: a shared conversation, a public
    // link, and another project that recalls the main's memories.
    const guest = await postUser({
      username: `${tag}-guest`,
      password: 'secret-password',
    });
    await drizzleDbRef.current.insert(conversationMembers).values({
      user_id: guest.json.id,
      conversation_id: `${tag}-conversation`,
      access_level: 'viewer',
      created_at: new Date().toISOString(),
    });
    const share = await createOrEnableConversationPublicShare(
      `${tag}-conversation`,
      null,
    );
    await registerGroup(`${tag}-reader`, {
      name: 'Reader',
      folder: `${tag}-reader`,
      trigger: '!',
      added_at: new Date().toISOString(),
      settings: { mode: 'chat', memorySourceProjects: [folder] },
    });
    expect(
      await userCanAccessConversation(guest.json.id, `${tag}-conversation`),
    ).toBeNull();
    // Persistent sandbox storage of the main, and a token that another
    // project's running agent obtained while it could recall the main.
    const ipcOld = path.join(
      DATA_DIR,
      'ipc',
      `${DEFAULT_SANDBOX_STACK}-${folder}`,
    );
    fs.mkdirSync(path.join(ipcOld, 'pi-sessions'), { recursive: true });
    fs.writeFileSync(path.join(ipcOld, 'pi-sessions', 'old.jsonl'), 'secret');
    // The permission map a running DirectLLM agent of that project copied.
    const runningGrants = getAgentPermissions(
      getGroupByFolder(`${tag}-reader`)!,
      {
        [`${tag}-reader`]: getGroupByFolder(`${tag}-reader`)!,
        [folder]: getGroupByFolder(folder)!,
      },
    );
    expect(runningGrants[folder]).toContain('memories:read');
    // A stored sandbox name equal to the folder still lets the username return.
    await updateGroup(folder, {
      settings: {
        ...getGroupByFolder(folder)!.settings,
        defaultSandboxInstance: folder,
      },
    });
    const readerToken = await generateAgentToken(
      {
        group_folder: `${tag}-reader`,
        permissions: {
          [`${tag}-reader`]: ['memories:*'],
          [folder]: ['memories:read'],
        },
      },
      null,
    );
    expect(verifyToken(readerToken)).not.toBeNull();

    await insertActiveDatasetTask(`${tag}-dataset`, folder);
    // A reflector that began before the deletion and is still awaiting its LLM.
    const reflectorEpoch = getPrivacyErasureEpoch(folder);

    expect((await deleteUserRequest(first.json.id)).status).toBe(200);
    const archived = await drizzleDbRef.current
      .select()
      .from(projects)
      .where(like(projects.id, `archived-${folder}-%`));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      jid: archived[0].id,
      is_main: 1,
      user_id: null,
    });
    expect(getGroupByFolder(folder)).toBeUndefined();
    // A restart must not resume the archived main's work: the barrier is
    // stored, honored by state load, and covers dataset recovery.
    await loadState();
    const reloaded = getGroupByFolder(archived[0].id)!;
    expect(reloaded.settings).toMatchObject({
      status: 'stopped',
      autoStartStack: false,
    });
    expect(resolveEffectiveSandbox(reloaded).autoStart).toBe(false);
    expect(await datasetStatus(`${tag}-dataset`)).toBe('paused');
    expect(isForeignMainFor('admin-1', archived[0].id)).toBe(true);
    expect(isForeignMainFor(first.json.id, archived[0].id)).toBe(true);

    expect(await getProjectAccess(guest.json.id, archived[0].id)).toBeNull();
    expect(
      await userCanAccessConversation(guest.json.id, `${tag}-conversation`),
    ).toBeNull();
    expect(await resolveConversationPublicShare(share.publicToken)).toBe(
      undefined,
    );
    expect(
      getGroupByFolder(`${tag}-reader`)?.settings?.memorySourceProjects,
    ).toEqual([]);

    expect(verifyToken(readerToken)).toBeNull();
    // ...and once the folder names another project, that copy no longer grants it.
    expect(liveGrants(runningGrants)?.[folder]).toBeUndefined();
    expect(liveGrants(runningGrants)?.[`${tag}-reader`]).toBeDefined();
    const archivedIpc = path.join(
      DATA_DIR,
      'ipc',
      `${DEFAULT_SANDBOX_STACK}-${archived[0].id}`,
    );
    expect(fs.existsSync(ipcOld)).toBe(false);
    expect(
      fs.readFileSync(
        path.join(archivedIpc, 'pi-sessions', 'old.jsonl'),
        'utf8',
      ),
    ).toBe('secret');

    const second = await postUser({ username, password: 'secret-password' });
    expect(second.status).toBe(201);
    // ...must not write into the project that took the folder over.
    await expect(
      getMemoryBackend().memorize({
        group_folder: folder,
        content: 'private content of the previous owner',
        memory_type: 'project',
        source: 'observer',
        mergeDuplicates: false,
        expectedPrivacyEpoch: reflectorEpoch,
      }),
    ).rejects.toThrow('privacy erasure advanced');
    const [fresh] = await drizzleDbRef.current
      .select({ user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, folder));
    expect(fresh.user_id).toBe(second.json.id);
    const moved = await drizzleDbRef.current
      .select({ group_folder: conversations.group_folder })
      .from(conversations)
      .where(eq(conversations.id, `${tag}-conversation`));
    expect(moved[0].group_folder).toBe(archived[0].id);
  });

  test('deletes a user whose main is missing', async () => {
    const created = await postUser({
      username: `${tag}-nomain`,
      password: 'secret-password',
    });
    await drizzleDbRef.current
      .delete(projects)
      .where(eq(projects.id, `main-${tag}-nomain`));
    expect((await deleteUserRequest(created.json.id)).status).toBe(200);
    expect(await db.getUserById(created.json.id)).toBeUndefined();
  });

  test('keeps the user and the main when the database rename fails', async () => {
    const username = `${tag}-dbfail`;
    const created = await postUser({ username, password: 'secret-password' });
    archiveOverrides = {
      renameProjectFolder: async () => {
        throw new Error('db down');
      },
    };
    try {
      const failed = await deleteUserRequest(created.json.id);
      expect(failed.status).toBe(500);
    } finally {
      archiveOverrides = {};
    }
    expect(await db.getUserById(created.json.id)).toBeDefined();
    expect(getGroupByFolder(`main-${username}`)).toMatchObject({
      is_main: true,
      user_id: created.json.id,
    });
  });

  test('keeps the user and the main when the sandbox stop is not confirmed', async () => {
    const username = `${tag}-stillup`;
    const created = await postUser({ username, password: 'secret-password' });
    const ipcDir = path.join(
      DATA_DIR,
      'ipc',
      `${DEFAULT_SANDBOX_STACK}-main-${username}`,
    );
    fs.mkdirSync(ipcDir, { recursive: true });
    sandboxClient.sandboxStatus = async () => ({
      stdout: JSON.stringify([{ State: 'running' }]),
      isError: false,
    });
    try {
      expect((await deleteUserRequest(created.json.id)).status).toBe(500);
    } finally {
      sandboxClient.sandboxStatus = stoppedStatus;
    }
    expect(await db.getUserById(created.json.id)).toBeDefined();
    expect(getGroupByFolder(`main-${username}`)?.user_id).toBe(created.json.id);
    expect(fs.existsSync(ipcDir)).toBe(true);
  });

  test('stops and archives the storage of every stack the main ran under', async () => {
    const username = `${tag}-multi`;
    const folder = `main-${username}`;
    const created = await postUser({ username, password: 'secret-password' });
    // Another user whose folder also ends with this folder, and the storage
    // of a stack the main used before it switched to the default one.
    const lookalike = await postUser({
      username: `x-${folder}`,
      password: 'secret-password',
    });
    const ipc = path.join(DATA_DIR, 'ipc');
    const names = {
      current: `${DEFAULT_SANDBOX_STACK}-${folder}`,
      former: `former-stack-${folder}`,
      other: `${DEFAULT_SANDBOX_STACK}-main-x-${folder}`,
    };
    for (const name of Object.values(names)) {
      fs.mkdirSync(path.join(ipc, name), { recursive: true });
    }
    fs.writeFileSync(path.join(ipc, names.former, 'history.jsonl'), 'old');
    const stopped: string[] = [];
    sandboxClient.sandboxPs = async () => ({
      stdout: JSON.stringify([{ stack: 'former-stack', instance: folder }]),
      isError: false,
    });
    sandboxClient.sandboxStop = async (stack: string, instance: string) => {
      stopped.push(`${stack}/${instance}`);
      return { stdout: '', isError: false };
    };
    try {
      expect((await deleteUserRequest(created.json.id)).status).toBe(200);
    } finally {
      sandboxClient.sandboxPs = nothingRunning;
      sandboxClient.sandboxStop = async () => ({ stdout: '', isError: false });
    }
    expect(stopped.sort()).toEqual([
      `${DEFAULT_SANDBOX_STACK}/${folder}`,
      `former-stack/${folder}`,
    ]);
    const [archived] = await drizzleDbRef.current
      .select({ id: projects.id })
      .from(projects)
      .where(like(projects.id, `archived-${folder}-%`));
    expect(fs.existsSync(path.join(ipc, names.current))).toBe(false);
    expect(fs.existsSync(path.join(ipc, names.former))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(ipc, `former-stack-${archived.id}`, 'history.jsonl'),
        'utf8',
      ),
    ).toBe('old');
    // The other user's storage stays where it was.
    expect(fs.existsSync(path.join(ipc, names.other))).toBe(true);
    expect(getGroupByFolder(`main-x-${folder}`)?.user_id).toBe(
      lookalike.json.id,
    );
  });

  test('keeps the user when the running sandboxes cannot be listed', async () => {
    const created = await postUser({
      username: `${tag}-psfail`,
      password: 'secret-password',
    });
    sandboxClient.sandboxPs = async () => ({ stdout: 'boom', isError: true });
    try {
      expect((await deleteUserRequest(created.json.id)).status).toBe(500);
    } finally {
      sandboxClient.sandboxPs = nothingRunning;
    }
    expect(await db.getUserById(created.json.id)).toBeDefined();
  });

  test('refuses to delete a user whose main has a custom sandbox instance', async () => {
    const username = `${tag}-custom`;
    const created = await postUser({ username, password: 'secret-password' });
    const group = getGroupByFolder(`main-${username}`)!;
    await updateGroup(`main-${username}`, {
      settings: { ...group.settings, defaultSandboxInstance: 'custom-inst' },
    });
    expect((await deleteUserRequest(created.json.id)).status).toBe(409);
    expect(await db.getUserById(created.json.id)).toBeDefined();
    expect(getGroupByFolder(`main-${username}`)?.user_id).toBe(created.json.id);
  });

  test('archives once when the same user is deleted twice at the same time', async () => {
    const username = `${tag}-twice`;
    const created = await postUser({ username, password: 'secret-password' });
    const statuses = (
      await Promise.all([
        deleteUserRequest(created.json.id),
        deleteUserRequest(created.json.id),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 404]);
    const archived = await drizzleDbRef.current
      .select({ id: projects.id })
      .from(projects)
      .where(like(projects.id, `archived-main-${username}-%`));
    expect(archived).toHaveLength(1);
    expect(getGroupByFolder(`main-${username}`)).toBeUndefined();
  });

  test('restores the execution state when the archive is rolled back late', async () => {
    const username = `${tag}-lateroll`;
    const folder = `main-${username}`;
    const created = await postUser({ username, password: 'secret-password' });
    await insertActiveDatasetTask(`${tag}-dataset-late`, folder);
    archiveOverrides = {
      renameGroupMemoryGraph: async () => {
        throw new Error('neo4j down');
      },
    };
    try {
      expect((await deleteUserRequest(created.json.id)).status).toBe(500);
    } finally {
      archiveOverrides = {};
    }
    expect(getGroupByFolder(folder)?.settings?.status).toBeUndefined();
    expect(getGroupByFolder(folder)?.settings?.autoStartStack).toBe(true);
    const [row] = await drizzleDbRef.current
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, folder));
    expect(JSON.parse(row.settings!)).toMatchObject({ autoStartStack: true });
    expect(JSON.parse(row.settings!).status).toBeUndefined();
    expect(await datasetStatus(`${tag}-dataset-late`)).toBe('active');
    expect(await db.getUserById(created.json.id)).toBeDefined();
  });

  test('keeps a second delete waiting while the first is still archiving', async () => {
    const username = `${tag}-slowgraph`;
    const created = await postUser({ username, password: 'secret-password' });
    let reachedGraph!: () => void;
    const atGraph = new Promise<void>((resolve) => (reachedGraph = resolve));
    let failGraph!: () => void;
    archiveOverrides = {
      renameGroupMemoryGraph: async () => {
        reachedGraph();
        await new Promise<void>(
          (_, reject) => (failGraph = () => reject(new Error('neo4j down'))),
        );
        return 0;
      },
    };
    try {
      const first = deleteUserRequest(created.json.id);
      await atGraph;
      // Ownership is already cleared here: a delete that looked the main up now
      // would find none and remove the user before the first can roll back.
      const second = deleteUserRequest(created.json.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await db.getUserById(created.json.id)).toBeDefined();
      failGraph();
      archiveOverrides = {};
      expect((await first).status).toBe(500);
      // The first rolled back; the second then ran its own full archive.
      expect((await second).status).toBe(200);
    } finally {
      archiveOverrides = {};
    }
    expect(await db.getUserById(created.json.id)).toBeUndefined();
  });

  test('keeps the user and the storage when the box tree is not confirmed shared', async () => {
    const username = `${tag}-boxtree`;
    const created = await postUser({ username, password: 'secret-password' });
    const ipcDir = path.join(
      DATA_DIR,
      'ipc',
      `${DEFAULT_SANDBOX_STACK}-main-${username}`,
    );
    fs.mkdirSync(ipcDir, { recursive: true });
    const original = ipcReplica.confirmSharedTree;
    ipcReplica.confirmSharedTree = async () => false;
    try {
      expect((await deleteUserRequest(created.json.id)).status).toBe(500);
    } finally {
      ipcReplica.confirmSharedTree = original;
    }
    expect(fs.existsSync(ipcDir)).toBe(true);
    expect(await db.getUserById(created.json.id)).toBeDefined();
    expect(getGroupByFolder(`main-${username}`)?.user_id).toBe(created.json.id);
  });

  test('refuses with a conflict while the main has running tasks', async () => {
    const created = await postUser({
      username: `${tag}-running`,
      password: 'secret-password',
    });
    archiveOverrides = { hasRunningTasks: async () => true };
    try {
      expect((await deleteUserRequest(created.json.id)).status).toBe(409);
    } finally {
      archiveOverrides = {};
    }
    expect(await db.getUserById(created.json.id)).toBeDefined();
  });
});
