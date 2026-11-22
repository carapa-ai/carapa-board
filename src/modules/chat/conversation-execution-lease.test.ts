import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  completeActiveRun,
  createConversation,
  initDatabase,
  insertActiveRun,
} from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { conversationExecutionLeases } from '../../db/schema.js';
import { runFixture, truncateTestDb } from '../../test-helpers.js';
import {
  acquireConversationExecutionLease,
  getConversationExecutionLease,
  recoverConversationExecutionLeases,
  releaseConversationExecutionLease,
} from './conversation-execution-lease.js';

const GROUP = 'conversation-execution-lease-test';

beforeAll(() => initDatabase(':memory:'));
beforeEach(truncateTestDb);

describe('durable conversation execution lease', () => {
  test('serializes concurrent claims transactionally', async () => {
    const conversation = await createConversation(GROUP);
    const [first, second] = await Promise.all([
      acquireConversationExecutionLease(conversation.id, 'first-run'),
      acquireConversationExecutionLease(conversation.id, 'second-run'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const winner = first ?? second!;
    expect(await getConversationExecutionLease(conversation.id)).toMatchObject({
      ownerId: winner.ownerId,
    });
    expect(
      await releaseConversationExecutionLease(conversation.id, 'not-owner'),
    ).toBe(false);
    expect(
      await releaseConversationExecutionLease(conversation.id, winner.ownerId),
    ).toBe(true);
  });

  test('startup recovery removes expired and preflight-only claims without clearing recoverable runs', async () => {
    const expiredConversation = await createConversation(GROUP);
    const orphanedConversation = await createConversation(GROUP);
    const runningConversation = await createConversation(GROUP);
    await acquireConversationExecutionLease(
      expiredConversation.id,
      'expired-run',
    );
    await acquireConversationExecutionLease(
      orphanedConversation.id,
      'orphaned-preflight',
    );
    await acquireConversationExecutionLease(
      runningConversation.id,
      'recoverable-run',
    );
    const activeRunId = `run-${runningConversation.id}`;
    await insertActiveRun(
      runFixture({
        id: activeRunId,
        group_folder: GROUP,
        conversation_id: runningConversation.id,
        chat_jid: `${GROUP}@web`,
      }),
    );
    await drizzleDbRef.current
      .update(conversationExecutionLeases)
      .set({ expires_at: '2000-01-01T00:00:00.000Z' })
      .where(
        eq(conversationExecutionLeases.conversation_id, expiredConversation.id),
      );

    expect(await recoverConversationExecutionLeases()).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      await getConversationExecutionLease(expiredConversation.id),
    ).toBeNull();
    expect(
      await getConversationExecutionLease(orphanedConversation.id),
    ).toBeNull();
    expect(
      await getConversationExecutionLease(runningConversation.id),
    ).toMatchObject({ ownerId: 'recoverable-run' });
    await completeActiveRun(activeRunId, 'completed');
  });
});
