import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import express from 'express';
import type { Server } from 'node:http';
import {
  createTask,
  createUser,
  getMemberMode,
  getMemberPreferences,
  getMemberPushEnabled,
  getProjectAccess,
  getProjectsForUser,
  getProjectsStatusSummary,
  getUserById,
  initDatabase,
  updateTask,
  updateUserProfile,
  upsertProjectMember,
} from '../db.js';
import {
  accountAvatarDirectory,
  writeAccountAvatar,
  writeAccountAvatarCandidate,
} from '../modules/account/avatar-storage.js';
import {
  LIVE_ACTIVITY_AGENT_INSTRUCTION,
  LIVE_ACTIVITY_DISABLED_INSTRUCTION,
} from '../modules/chat/live-activity.js';
import { loadPreferencesCascade } from '../prompt-loader.js';
import { buildSystemPrompt } from '../system-prompt-builder.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { projectMembers, projects } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { taskFixture } from '../test-helpers.js';
import { loadState, registerGroup } from '../state-manager.js';

const { default: preferencesRouter } = await import('./preferences.js');
const { default: tasksRouter } = await import('./tasks.js');

let server: Server;
let baseUrl: string;
let userId: string;
let authUserRole = 'user';

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  const user = await createUser(`preferences-${Date.now()}`, 'password');
  userId = user.id;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.authUser = { id: userId, role: authUserRole };
    next();
  });
  app.use('/api', tasksRouter);
  app.use('/api', preferencesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

afterAll(async () => {
  server?.close();
  await fs.rm(accountAvatarDirectory(userId), { recursive: true, force: true });
});

describe('account dictation preferences', () => {
  test('persists the structured language independently and normalizes invalid values', async () => {
    const initial = await fetch(`${baseUrl}/account/preferences`);
    expect(await initial.json()).toMatchObject({
      content: null,
      dictationLanguage: null,
    });

    const saved = await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Use concise replies.',
        dictationLanguage: 'ro',
      }),
    });
    expect(await saved.json()).toMatchObject({
      content: 'Use concise replies.',
      dictationLanguage: 'ro',
    });

    const invalid = await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Keep this prompt.',
        dictationLanguage: 'not-a-language',
      }),
    });
    expect(await invalid.json()).toMatchObject({
      content: 'Keep this prompt.',
      dictationLanguage: 'auto',
    });
  });
});

describe('account profile and avatar boundary', () => {
  test('normalizes, persists, and clears a display name with username fallback', async () => {
    const saved = await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: null,
        displayName: '  Ａlex   Example  ',
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ displayName: 'Alex Example' });
    expect((await getUserById(userId))?.displayName).toBe('Alex Example');

    const tooLong = await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: null, displayName: 'x'.repeat(121) }),
    });
    expect(tooLong.status).toBe(400);
    expect((await getUserById(userId))?.displayName).toBe('Alex Example');

    const cleared = await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: null, displayName: null }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ displayName: null });
  });

  test('validates image bytes, serves a private thumbnail, and promotes only this account candidate', async () => {
    const spoofed = await fetch(`${baseUrl}/account/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dataUrl: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`,
      }),
    });
    expect(spoofed.status).toBe(400);
    expect((await getUserById(userId))?.avatarPath).toBeNull();

    const canvas = createCanvas(16, 16);
    const png = Buffer.from(await canvas.encode('png'));
    const uploaded = await fetch(`${baseUrl}/account/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        userId: 'another-user',
      }),
    });
    const uploadedBody = await uploaded.json();
    if (
      !uploadedBody ||
      typeof uploadedBody !== 'object' ||
      !('avatarUrl' in uploadedBody) ||
      typeof uploadedBody.avatarUrl !== 'string'
    ) {
      throw new Error('Avatar route did not return avatarUrl');
    }
    expect(uploaded.status).toBe(200);
    expect(uploadedBody.avatarUrl).toMatch(
      new RegExp(`/api/users/${userId}/avatar\\?thumbnail=1&v=`),
    );
    const avatarResponse = await fetch(
      `${baseUrl.replace(/\/api$/, '')}${uploadedBody.avatarUrl}`,
    );
    expect(avatarResponse.status).toBe(200);
    expect(avatarResponse.headers.get('content-type')).toContain('image/jpeg');
    expect(avatarResponse.headers.get('cache-control')).toContain('immutable');
    const replaced = await fetch(`${baseUrl}/account/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      }),
    });
    const replacedBody = await replaced.json();
    if (
      !replacedBody ||
      typeof replacedBody !== 'object' ||
      !('avatarUrl' in replacedBody) ||
      typeof replacedBody.avatarUrl !== 'string'
    ) {
      throw new Error('Replacement route did not return avatarUrl');
    }
    expect(replacedBody.avatarUrl).not.toBe(uploadedBody.avatarUrl);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    await writeAccountAvatarCandidate(userId, '.jpg', jpeg);
    const promoted = await fetch(`${baseUrl}/account/avatar/candidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'candidate', userId: 'another-user' }),
    });
    expect(promoted.status).toBe(200);
    expect((await getUserById(userId))?.avatarPath).toBe(
      `account-avatars/${userId}/avatar.jpg`,
    );

    await updateUserProfile(userId, { avatarPath: '../outside.png' });
    const traversal = await fetch(`${baseUrl}/users/${userId}/avatar`);
    expect(traversal.status).toBe(404);
    await updateUserProfile(userId, { avatarPath: null });
    const failedModify = await fetch(`${baseUrl}/account/avatar/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'modify', prompt: 'Add glasses' }),
    });
    expect(failedModify.status).toBe(400);
    const other = await createUser(`avatar-other-${process.pid}`, 'password');
    const otherAvatar = await writeAccountAvatar(other.id, '.png', png);
    await updateUserProfile(other.id, { avatarPath: otherAvatar.path });
    await updateUserProfile(userId, { avatarPath: otherAvatar.path });
    const crossAccountPath = await fetch(`${baseUrl}/users/${userId}/avatar`);
    const legitimateOtherRead = await fetch(
      `${baseUrl}/users/${other.id}/avatar`,
    );
    expect(legitimateOtherRead.status).toBe(200);
    expect(crossAccountPath.status).toBe(404);
    await fs.rm(accountAvatarDirectory(other.id), {
      recursive: true,
      force: true,
    });
    await updateUserProfile(userId, { avatarPath: null });
    expect((await getUserById(userId))?.avatarPath).toBeNull();
  });

  test('resolves and immediately invalidates human context without changing system prompts', async () => {
    const projectId = `identity-prompt-${process.pid}`;
    const now = new Date().toISOString();
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@test`,
      name: 'Identity prompt project',
      folder: projectId,
      trigger: '!',
      added_at: now,
      user_id: userId,
    });
    await updateUserProfile(userId, { displayName: 'Human Display' });
    const accountUpdate = await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Account preference',
        displayName: 'Human Display',
      }),
    });
    expect(accountUpdate.status).toBe(200);

    const systemPrompts = await Promise.all(
      [
        { forDirectLlm: true, liveMode: false },
        { forDirectLlm: false, liveMode: false },
        { forDirectLlm: true, liveMode: true },
      ].map((options) =>
        buildSystemPrompt({ group_folder: projectId, ...options }),
      ),
    );
    for (const prompt of systemPrompts) {
      expect(prompt).not.toContain('## Human Participant Identity');
      expect(prompt).not.toContain('## User Preferences');
    }

    const accountContext = await loadPreferencesCascade(userId, projectId);
    expect(accountContext).toContain('## Human Participant Identity');
    expect(accountContext).toContain(`Account user ID: ${userId}`);
    expect(accountContext).toContain('Username (login identifier):');
    expect(accountContext).toContain('Display name: Human Display');
    expect(accountContext).toContain('## User Preferences\nAccount preference');

    await fetch(`${baseUrl}/account/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Updated account preference',
        displayName: 'Updated Human Display',
      }),
    });
    const updatedAccountContext = await loadPreferencesCascade(
      userId,
      projectId,
    );
    expect(updatedAccountContext).toContain(
      'Display name: Updated Human Display',
    );
    expect(updatedAccountContext).toContain('Updated account preference');
    expect(updatedAccountContext).not.toContain(
      '## User Preferences\nAccount preference',
    );

    const projectPreferences = await fetch(
      `${baseUrl}/projects/${projectId}/preferences`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Project override' }),
      },
    );
    expect(projectPreferences.status).toBe(200);
    const overridden = await loadPreferencesCascade(userId, projectId);
    expect(overridden).toContain('## User Preferences\nProject override');
    expect(overridden).not.toContain('Updated account preference');

    expect(await loadPreferencesCascade(null, projectId)).toBe('');
    expect(await loadPreferencesCascade('unknown-user', projectId)).toBe('');
    expect(
      await buildSystemPrompt({
        group_folder: projectId,
        forDirectLlm: true,
      }),
    ).toBe(systemPrompts[0]);
  });

  test('isolates normal and Live Mode Direct LLM prompts in both cache orderings', async () => {
    for (const [folder, liveFirst] of [
      [`live-prompt-normal-first-${process.pid}`, false],
      [`live-prompt-live-first-${process.pid}`, true],
    ] as const) {
      const first = await buildSystemPrompt({
        group_folder: folder,
        forDirectLlm: true,
        liveMode: liveFirst,
      });
      const second = await buildSystemPrompt({
        group_folder: folder,
        forDirectLlm: true,
        liveMode: !liveFirst,
      });
      const live = liveFirst ? first : second;
      const normal = liveFirst ? second : first;

      expect(live).toContain(LIVE_ACTIVITY_AGENT_INSTRUCTION);
      expect(live).not.toContain(LIVE_ACTIVITY_DISABLED_INSTRUCTION);
      expect(normal).toContain(LIVE_ACTIVITY_DISABLED_INSTRUCTION);
      expect(normal).not.toContain(LIVE_ACTIVITY_AGENT_INSTRUCTION);
    }
  });
});

describe('Kanban completion acknowledgement', () => {
  test('acknowledges only the exact completion events sent by the visible board', async () => {
    const projectId = 'preferences-kanban-ack';
    const now = new Date().toISOString();
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@test`,
      name: 'Acknowledgement project',
      folder: projectId,
      trigger: '!',
      added_at: now,
      user_id: userId,
    });
    const visible = await createTask(
      taskFixture({
        project_id: projectId,
        title: 'Visible completion',
        status: 'completed',
        completed_at: now,
      }),
    );
    await createTask(
      taskFixture({
        project_id: projectId,
        title: 'Completion not in the client snapshot',
        status: 'completed',
        completed_at: now,
      }),
    );
    const boardResponse = await fetch(`${baseUrl}/projects/${projectId}/tasks`);
    const boardTasks = (await boardResponse.json()) as Array<{
      id: string;
      completionEventId: number | null;
    }>;
    const visibleEventId = boardTasks.find(
      (task) => task.id === visible.id,
    )?.completionEventId;
    expect(visibleEventId).toEqual(expect.any(Number));

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preferences/kanban-acknowledgement`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          visibleCompletionEventIds: [visibleEventId],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledgedEventId: visibleEventId,
    });
    expect(
      (await getProjectsStatusSummary(userId, [projectId])).projects[projectId]
        ?.kanban,
    ).toBe('finished');
  });

  test('does not acknowledge a later completion of the same task', async () => {
    const projectId = 'preferences-kanban-recompletion';
    const now = new Date().toISOString();
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@test`,
      name: 'Recompletion project',
      folder: projectId,
      trigger: '!',
      added_at: now,
      user_id: userId,
    });
    const task = await createTask(
      taskFixture({
        project_id: projectId,
        title: 'Completes twice',
        status: 'completed',
        completed_at: now,
      }),
    );
    const boardResponse = await fetch(`${baseUrl}/projects/${projectId}/tasks`);
    const boardTasks = (await boardResponse.json()) as Array<{
      id: string;
      completionEventId: number | null;
    }>;
    const visibleEventId = boardTasks.find(
      (candidate) => candidate.id === task.id,
    )!.completionEventId!;

    await updateTask(task.id, { status: 'backlog' });
    await updateTask(task.id, {
      status: 'completed',
      completed_at: new Date(Date.now() + 1_000).toISOString(),
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preferences/kanban-acknowledgement`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          visibleCompletionEventIds: [visibleEventId],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(
      (await getProjectsStatusSummary(userId, [projectId])).projects[projectId]
        ?.kanban,
    ).toBe('finished');
  });

  test('admin acknowledgement never grants access to a foreign project', async () => {
    const owner = await createUser(
      `preferences-owner-${Date.now()}`,
      'password',
    );
    const projectId = 'preferences-admin-foreign';
    const now = new Date().toISOString();
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@test`,
      name: 'Foreign project',
      folder: projectId,
      trigger: '!',
      added_at: now,
      user_id: owner.id,
    });
    const task = await createTask(
      taskFixture({
        project_id: projectId,
        title: 'Foreign completion',
        status: 'completed',
        completed_at: now,
      }),
    );
    const boardResponse = await fetch(`${baseUrl}/projects/${projectId}/tasks`);
    const boardTasks = (await boardResponse.json()) as Array<{
      id: string;
      completionEventId: number | null;
    }>;
    const visibleEventId = boardTasks.find(
      (candidate) => candidate.id === task.id,
    )!.completionEventId!;

    authUserRole = 'admin';
    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/preferences/kanban-acknowledgement`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            visibleCompletionEventIds: [visibleEventId],
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ acknowledgedEventId: null });
    } finally {
      authUserRole = 'user';
    }

    expect(await getProjectsForUser(userId)).not.toContain(projectId);
  });
});

describe('preference writes and project membership', () => {
  async function insertProject(id: string, ownerId: string) {
    await drizzleDbRef.current.insert(projects).values({
      id,
      jid: `${id}@test`,
      name: id,
      folder: id,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: ownerId,
    });
  }

  async function memberRows(projectId: string) {
    return drizzleDbRef.current
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.user_id, userId),
          eq(projectMembers.project_id, projectId),
        ),
      );
  }

  async function putAll(projectId: string) {
    const put = (path: string, body: unknown) =>
      fetch(`${baseUrl}/projects/${projectId}/preferences${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return [
      await put('', { content: 'my prefs' }),
      await put('/mode', { mode: 'chat' }),
      await put('/push', { enabled: true }),
    ];
  }

  test('admin on a foreign project succeeds without persisting or granting membership', async () => {
    const owner = await createUser(`pref-owner-${Date.now()}`, 'password');
    const projectId = 'pref-admin-foreign';
    await insertProject(projectId, owner.id);

    authUserRole = 'admin';
    try {
      for (const response of await putAll(projectId)) {
        expect(response.status).toBe(200);
      }
    } finally {
      authUserRole = 'user';
    }

    expect(await memberRows(projectId)).toHaveLength(0);
    expect(await getMemberPreferences(userId, projectId)).toBeNull();
    expect(await getMemberMode(userId, projectId)).toBeNull();
    expect(await getMemberPushEnabled(userId, projectId)).toBeNull();
    // Without the admin role the leaked-row scenario has nothing to fall back on.
    expect(await getProjectAccess(userId, projectId)).toBeNull();
  });

  test('admin is refused preferences of a registered project owned by another user but keeps an ownerless one', async () => {
    const owner = await createUser(`pref-owner3-${Date.now()}`, 'password');
    for (const [folder, user_id] of [
      ['pref-admin-registered', owner.id],
      ['pref-admin-ownerless', undefined],
    ] as const) {
      await registerGroup(`${folder}@web`, {
        name: folder,
        folder,
        trigger: '!',
        added_at: new Date().toISOString(),
        user_id,
      });
    }

    authUserRole = 'admin';
    try {
      for (const response of await putAll('pref-admin-registered')) {
        expect(response.status).toBe(403);
      }
      for (const response of await putAll('pref-admin-ownerless')) {
        expect(response.status).toBe(200);
      }
    } finally {
      authUserRole = 'user';
    }
  });

  test('owner without a member row gets an owner row holding each value', async () => {
    const projectId = 'pref-owner-no-row';
    await insertProject(projectId, userId);

    for (const response of await putAll(projectId)) {
      expect(response.status).toBe(200);
    }

    const rows = await memberRows(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      access_level: 'owner',
      preferences: 'my prefs',
      mode: 'chat',
      push_enabled: 1,
    });
  });

  test('existing member keeps its access level while values are updated', async () => {
    const owner = await createUser(`pref-owner2-${Date.now()}`, 'password');
    const projectId = 'pref-existing-member';
    await insertProject(projectId, owner.id);
    await upsertProjectMember(userId, projectId, 'editor');

    for (const response of await putAll(projectId)) {
      expect(response.status).toBe(200);
    }

    const rows = await memberRows(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      access_level: 'editor',
      preferences: 'my prefs',
      mode: 'chat',
      push_enabled: 1,
    });
  });
});
