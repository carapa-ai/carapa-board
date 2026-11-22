import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  getConversation,
  initDatabase,
  insertAiUserRow,
  insertAiUserTeamRow,
  listConversationAiUserRows,
  replaceAiUserTeamMembers,
} from '../db.js';
import { createObjective } from '../modules/objectives/db-objectives.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
  updateGroup,
} from '../state-manager.js';
import conversationsRouter from './conversations.js';

const projectId = `objective-conv-personas-${process.pid}`;
const jid = `${projectId}@web`;
const now = '2026-10-15T00:00:00.000Z';
let server: Server;
let baseUrl = '';
let objectiveId = '';

async function addPersona(id: string, enabled = 1) {
  await insertAiUserRow({
    id,
    name: id,
    presetId: 'fast',
    promptPath: `ai-users/${id}/prompt.md`,
    avatarPath: null,
    identity: id,
    turn: 'after',
    tools: [],
    enabled,
    createdAt: now,
    updatedAt: now,
  });
}

function createObjectiveChat(body: unknown) {
  return fetch(`${baseUrl}/projects/${projectId}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(body as object), objective_id: objectiveId }),
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(jid, {
    jid,
    name: 'Objective persona route test',
    folder: projectId,
    trigger: '@objective-personas',
    added_at: now,
    settings: {},
  });
  objectiveId = (
    await createObjective({
      project_id: projectId,
      title: 'Persona fixture',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      metadata: null,
      trigger_config: null,
      eventRuntimeSelection: null,
    })
  ).id;
  await addPersona('obj-main-persona');
  await addPersona('obj-invited-persona');
  const app = express();
  app.use(express.json());
  app.use(conversationsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(jid);
});

describe('POST /projects/:pid/conversations with objective_id personas', () => {
  test('applies the draft main persona and invited personas', async () => {
    const res = await createObjectiveChat({
      mainAiUserSelection: { mode: 'persona', aiUserId: 'obj-main-persona' },
      invitedAiUserIds: ['obj-invited-persona'],
      continuousPersonaLoop: true,
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as {
      id: string;
      objective_id: string;
      mainAiUserId: string | null;
      continuousPersonaLoop: boolean;
    };
    expect(conv.objective_id).toBe(objectiveId);
    expect(conv.mainAiUserId).toBe('obj-main-persona');
    expect(conv.continuousPersonaLoop).toBe(true);
    const stored = await getConversation(conv.id);
    expect(stored?.mainAiUserId).toBe('obj-main-persona');
    const invited = await listConversationAiUserRows(conv.id);
    expect(invited.map((row) => row.aiUser.id)).toEqual([
      'obj-invited-persona',
    ]);
  });

  test('rejects an unknown persona without creating a conversation', async () => {
    const res = await createObjectiveChat({
      mainAiUserSelection: { mode: 'persona', aiUserId: 'missing-persona' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'All selected AI users must exist and be enabled',
    });
  });

  test('an empty body still creates a plain objective chat', async () => {
    const res = await createObjectiveChat({});
    expect(res.status).toBe(201);
    const conv = (await res.json()) as { id: string };
    expect(await listConversationAiUserRows(conv.id)).toEqual([]);
  });

  test('explicit invitations still apply the project default teams', async () => {
    await addPersona('team-member-a');
    await addPersona('team-member-b');
    await addPersona('team-member-disabled', 0);
    await insertAiUserTeamRow({
      id: 'default-team',
      name: 'Default team',
      description: '',
      createdAt: now,
      updatedAt: now,
    });
    await replaceAiUserTeamMembers('default-team', [
      'team-member-a',
      'team-member-b',
      'team-member-disabled',
      'obj-invited-persona',
      'obj-main-persona',
    ]);
    await updateGroup(jid, {
      settings: {
        defaultInvitedAiUserTeamIds: ['default-team', 'missing-team'],
      },
    });
    try {
      const res = await createObjectiveChat({
        mainAiUserSelection: { mode: 'persona', aiUserId: 'obj-main-persona' },
        invitedAiUserIds: ['obj-invited-persona'],
      });
      expect(res.status).toBe(201);
      const conv = (await res.json()) as { id: string };
      const invited = await listConversationAiUserRows(conv.id);
      expect(invited.map((row) => row.aiUser.id).sort()).toEqual([
        'obj-invited-persona',
        'team-member-a',
        'team-member-b',
      ]);
    } finally {
      await updateGroup(jid, { settings: {} });
    }
  });
});
