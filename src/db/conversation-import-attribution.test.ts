import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createObjective,
  createObjectiveConversation,
  createUser,
  getAttentionConversations,
  getConversation,
  initDatabase,
  insertImportedConversation,
} from '../db.js';
import { drizzleDbRef } from './drizzle-client.js';
import { projects } from './schema.js';
import { truncateTestDb } from '../test-helpers.js';

beforeAll(() => initDatabase(':memory:'));
beforeEach(() => truncateTestDb());

async function createOwnedProject(id: string) {
  const owner = await createUser(`${id}-owner`, 'pw', 'user');
  await drizzleDbRef.current.insert(projects).values({
    id,
    jid: `${id}@board`,
    name: id,
    folder: id,
    trigger: '!',
    added_at: new Date().toISOString(),
    user_id: owner.id,
  });
  return owner;
}

describe('historical conversation insertion attribution', () => {
  test('native imports inherit the project owner and are system-triggered with no trigger time', async () => {
    const projectId = 'native-import-owner-project';
    const owner = await createOwnedProject(projectId);
    expect(
      await insertImportedConversation(
        {
          id: 'native-import-conversation',
          group_folder: projectId,
          created_at: new Date().toISOString(),
        },
        [],
      ),
    ).toBe(true);
    expect(
      await insertImportedConversation(
        {
          id: 'native-import-conversation',
          group_folder: projectId,
          created_at: new Date().toISOString(),
        },
        [],
      ),
    ).toBe(false);

    expect(await getConversation('native-import-conversation')).toMatchObject({
      ownerUserId: owner.id,
      lastTriggeredByUserId: null,
      lastTriggerSource: 'system',
      lastTriggeredAt: null,
    });
  });

  test('a native import marked read is already checked off the Now list', async () => {
    const projectId = 'native-import-now-project';
    const owner = await createOwnedProject(projectId);
    const repliedAt = new Date(Date.now() - 60_000).toISOString();
    await insertImportedConversation(
      {
        id: 'native-import-now-conversation',
        group_folder: projectId,
        created_at: repliedAt,
        last_assistant_at: repliedAt,
        read_at: repliedAt,
      },
      [],
    );

    const listed = await getAttentionConversations(undefined, {
      includeRead: true,
      visibleTo: {
        userId: owner.id,
        projectIds: [projectId],
        sharedConversationIds: [],
      },
    });
    expect(listed.map((conversation) => conversation.id)).toEqual([]);
  });

  test('objective conversations inherit the project owner and are system-triggered with no trigger time', async () => {
    const projectId = 'objective-import-owner-project';
    const owner = await createOwnedProject(projectId);
    const objective = await createObjective({
      project_id: projectId,
      title: 'Imported objective',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      trigger_config: null,
      metadata: null,
      work_dir: null,
      cost_limit_usd: null,
    });
    const conversation = await createObjectiveConversation(
      projectId,
      objective.id,
    );

    expect(await getConversation(conversation.id)).toMatchObject({
      ownerUserId: owner.id,
      lastTriggeredByUserId: null,
      lastTriggerSource: 'system',
      lastTriggeredAt: null,
    });
  });
});
