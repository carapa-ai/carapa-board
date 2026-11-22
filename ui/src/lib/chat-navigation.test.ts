// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { shouldEndNewConversationComposition } from './chat-navigation';

describe('chat navigation ownership', () => {
  test('keeps a blank composer open when another conversation flushes its queue', () => {
    expect(shouldEndNewConversationComposition('conversation-a', null)).toBe(false);
  });

  test('ends blank composition for its own first send or the selected conversation', () => {
    expect(shouldEndNewConversationComposition(undefined, null)).toBe(true);
    expect(shouldEndNewConversationComposition('conversation-a', 'conversation-a')).toBe(true);
  });
});
