import { beforeAll, describe, expect, test } from 'bun:test';
import { createUser, initDatabase, updateUserProfile } from '../../db.js';
import {
  hydrateTranscriptSenderNames,
  resolveConversationParticipants,
} from './conversation-participants.js';

beforeAll(async () => {
  await initDatabase(':memory:');
});

describe('conversation participants', () => {
  test('resolves distinct authenticated senders by stable id and overrides stale names', async () => {
    const first = await createUser(
      `participant-first-${process.pid}`,
      'password',
    );
    const second = await createUser(
      `participant-second-${process.pid}`,
      'password',
    );
    await updateUserProfile(first.id, { displayName: 'Shared Name' });
    await updateUserProfile(second.id, { displayName: 'Shared Name' });

    const entries = [
      {
        type: 'message',
        role: 'user',
        senderUserId: first.id,
        sender_name: 'Stale Mutable Label',
      },
      {
        type: 'message',
        role: 'user',
        senderUserId: second.id,
        sender_name: 'Shared Name',
      },
    ];
    const [participants] = await resolveConversationParticipants([entries]);
    expect(participants).toEqual([
      { userId: second.id, name: 'Shared Name', avatarUrl: null },
      { userId: first.id, name: 'Shared Name', avatarUrl: null },
    ]);

    const hydrated = (await hydrateTranscriptSenderNames(entries)) as Array<{
      senderUserId: string;
      sender_name: string;
      senderAvatarUrl: string | null;
    }>;
    expect(
      hydrated.map(({ senderUserId, sender_name }) => ({
        senderUserId,
        sender_name,
      })),
    ).toEqual([
      { senderUserId: first.id, sender_name: 'Shared Name' },
      { senderUserId: second.id, sender_name: 'Shared Name' },
    ]);
  });
  test('preserves persona and external sender metadata without human profiles', async () => {
    const entries = [
      {
        type: 'message',
        role: 'assistant',
        senderUserId: 'ai:persona-1',
        sender_name: 'Persona Luna',
        senderAvatarUrl: '/api/ai-users/persona-1/avatar',
      },
      {
        type: 'message',
        role: 'user',
        senderUserId: 'external-contact',
        sender_name: 'External Contact',
        senderAvatarUrl: 'external-avatar',
      },
    ];
    expect(await hydrateTranscriptSenderNames(entries)).toEqual(entries);
  });
});
