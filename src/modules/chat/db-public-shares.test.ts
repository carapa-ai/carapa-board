import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createConversation,
  createOrEnableConversationPublicShare,
  getConversationPublicShare,
  initDatabase,
  resolveConversationPublicShare,
  revokeConversationPublicShare,
  rotateConversationPublicShare,
  setConversationPublicVisitorPrompts,
} from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
});

afterAll(async () => {
  await truncateTestDb();
});

describe('conversation public shares', () => {
  test('creates one stable active link and rotates it on demand', async () => {
    const conversation = await createConversation('public-share-test');
    const first = await createOrEnableConversationPublicShare(
      conversation.id,
      null,
    );
    const repeated = await createOrEnableConversationPublicShare(
      conversation.id,
      null,
    );
    expect(repeated.publicToken).toBe(first.publicToken);
    expect(
      (await resolveConversationPublicShare(first.publicToken))?.conversationId,
    ).toBe(conversation.id);

    const rotated = await rotateConversationPublicShare(conversation.id, null);
    expect(rotated.publicToken).not.toBe(first.publicToken);
    expect(
      await resolveConversationPublicShare(first.publicToken),
    ).toBeUndefined();
    expect(
      (await resolveConversationPublicShare(rotated.publicToken))
        ?.conversationId,
    ).toBe(conversation.id);
    expect(rotated.allowVisitorPrompts).toBe(0);
  });

  test('visitor prompting defaults off, survives rotation, and is disabled by revocation', async () => {
    const conversation = await createConversation('public-share-prompt-toggle');
    const share = await createOrEnableConversationPublicShare(
      conversation.id,
      null,
    );
    expect(share.allowVisitorPrompts).toBe(0);
    expect(
      (await setConversationPublicVisitorPrompts(conversation.id, true))
        ?.allowVisitorPrompts,
    ).toBe(1);
    expect(
      (await rotateConversationPublicShare(conversation.id, null))
        .allowVisitorPrompts,
    ).toBe(1);
    await revokeConversationPublicShare(conversation.id);
    expect(
      (await getConversationPublicShare(conversation.id))?.allowVisitorPrompts,
    ).toBe(0);
  });

  test('revokes and re-enables with a new token', async () => {
    const conversation = await createConversation('public-share-revoke-test');
    const active = await createOrEnableConversationPublicShare(
      conversation.id,
      null,
    );
    await revokeConversationPublicShare(conversation.id);
    expect(
      await resolveConversationPublicShare(active.publicToken),
    ).toBeUndefined();
    expect(
      (await getConversationPublicShare(conversation.id))?.revokedAt,
    ).toBeTruthy();

    const enabled = await createOrEnableConversationPublicShare(
      conversation.id,
      null,
    );
    expect(enabled.publicToken).not.toBe(active.publicToken);
    expect(enabled.revokedAt).toBeNull();
  });
});
