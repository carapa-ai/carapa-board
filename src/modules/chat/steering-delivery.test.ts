import { describe, expect, test } from 'bun:test';
import { steeredChatMessageIdsFromTranscript } from './db-chats.js';

describe('steering delivery receipts', () => {
  test('recognizes only accepted harness steering receipts', () => {
    const delivered = steeredChatMessageIdsFromTranscript([
      {
        type: 'message',
        id: 'visible',
        role: 'user',
        content: 'Steer this turn',
      },
      { type: 'steering_delivery', messageId: 'accepted', delivery: 'steered' },
      { type: 'steering_delivery', messageId: 'rejected', delivery: 'queued' },
    ]);

    expect([...delivered]).toEqual(['accepted']);
  });
});
