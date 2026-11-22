import { describe, expect, test } from 'bun:test';
import type { Response } from 'express';
import {
  publishPublicConversationEvent,
  publishPublicEventFromBoardEvent,
  subscribePublicConversation,
} from './public-conversation-events.js';

function fakeResponse() {
  const writes: string[] = [];
  let ended = false;
  const response = {
    write(value: string) {
      writes.push(value);
      return true;
    },
    end() {
      ended = true;
    },
  } as unknown as Response;
  return { response, writes, ended: () => ended };
}

describe('public conversation events', () => {
  test('scopes updates to one conversation and exposes no message content', () => {
    const target = fakeResponse();
    const other = fakeResponse();
    const unsubscribeTarget = subscribePublicConversation(
      'conv-public-a',
      target.response,
    );
    const unsubscribeOther = subscribePublicConversation(
      'conv-public-b',
      other.response,
    );

    publishPublicEventFromBoardEvent({
      type: 'chat_message',
      payload: {
        folder: 'private-project',
        liveModeSessionId: 'private-session',
        message: {
          id: 'message-a',
          conversation_id: 'conv-public-a',
          senderUserId: 'ai:persona-a',
          content: 'private payload content',
        },
      },
    });

    expect(target.writes).toHaveLength(1);
    expect(target.writes[0]).toContain('message-a');
    expect(target.writes[0]).toContain('"autoSpeak":false');
    expect(target.writes[0]).not.toContain('private payload content');
    expect(target.writes[0]).not.toContain('private-project');
    expect(target.writes[0]).not.toContain('private-session');
    expect(other.writes).toHaveLength(0);
    unsubscribeTarget();
    unsubscribeOther();
  });

  test('revocation closes active subscribers', () => {
    const target = fakeResponse();
    subscribePublicConversation('conv-revoked', target.response);
    publishPublicConversationEvent('conv-revoked', { type: 'revoked' });
    expect(target.ended()).toBe(true);
  });
});
