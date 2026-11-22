import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';

import { createUser, initDatabase, upsertProjectMember } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { objectives } from '../../db/schema.js';
import { getGroupDir } from '../../group-dir.js';
import {
  createObjectiveConversation,
  getConversations,
  markConversationRead,
  saveChatMessage,
} from '../chat/db-chats.js';
import { truncateTestDb } from '../../test-helpers.js';
import { getObjectiveChatStatusMap } from './db-kanban.js';

const PROJECT = 'objective-chat-status-test';
const OBJECTIVE = 'objective-chat-status-objective';
let initialized = false;

beforeEach(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await truncateTestDb();
  await drizzleDbRef.current.insert(objectives).values({
    id: OBJECTIVE,
    project_id: PROJECT,
    title: 'Status priority',
    description: '',
    status: 'active',
    priority: 0,
    progress: 0,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
  });
});

afterAll(() => {
  fs.rmSync(getGroupDir(PROJECT), { recursive: true, force: true });
});

describe('getObjectiveChatStatusMap', () => {
  test('objective conversations expose resolved owner and trigger metadata', async () => {
    const owner = await createUser('objective-owner', 'pw', 'user');
    await upsertProjectMember(owner.id, PROJECT, 'editor');
    const conversation = await createObjectiveConversation(PROJECT, OBJECTIVE, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });

    expect(conversation.owner).toEqual({
      id: owner.id,
      username: 'objective-owner',
      displayName: null,
      avatarUrl: null,
    });
    expect(conversation.latestTrigger).toEqual({
      user: {
        id: owner.id,
        username: 'objective-owner',
        displayName: null,
        avatarUrl: null,
      },
      source: 'user',
      triggeredAt: conversation.created_at,
    });
    expect(
      await getConversations(PROJECT, 50, 0, { objectiveId: OBJECTIVE }),
    ).toEqual([
      expect.objectContaining({
        id: conversation.id,
        owner: {
          id: owner.id,
          username: 'objective-owner',
          displayName: null,
          avatarUrl: null,
        },
        latestTrigger: expect.objectContaining({ source: 'user' }),
      }),
    ]);
  });

  test('prioritizes a viewed pending plan over failed, working, and finished conversations', async () => {
    const failed = await createObjectiveConversation(PROJECT, OBJECTIVE);
    await saveChatMessage({
      group_folder: PROJECT,
      conversation_id: failed.id,
      role: 'assistant',
      content: 'Provider failed',
      source: 'web',
      created_at: '2026-08-01T10:01:00.000Z',
      failed: true,
    });

    const working = await createObjectiveConversation(PROJECT, OBJECTIVE);
    await saveChatMessage({
      group_folder: PROJECT,
      conversation_id: working.id,
      role: 'user',
      content: 'Still waiting',
      source: 'web',
      created_at: '2026-08-01T10:02:00.000Z',
    });

    const finished = await createObjectiveConversation(PROJECT, OBJECTIVE);
    await saveChatMessage({
      group_folder: PROJECT,
      conversation_id: finished.id,
      role: 'assistant',
      content: 'Done',
      source: 'web',
      created_at: '2026-08-01T10:03:00.000Z',
    });

    const pending = await createObjectiveConversation(PROJECT, OBJECTIVE);
    await saveChatMessage({
      group_folder: PROJECT,
      conversation_id: pending.id,
      role: 'assistant',
      content: 'Plan ready',
      source: 'web',
      created_at: '2026-08-01T10:04:00.000Z',
      pending: true,
    });
    await markConversationRead(PROJECT, pending.id);

    expect((await getObjectiveChatStatusMap(PROJECT))[OBJECTIVE]).toBe(
      'pending',
    );
  });
});
