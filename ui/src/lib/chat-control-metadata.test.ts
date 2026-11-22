// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { stripChatControlMetadata } from './chat-control-metadata';

describe('chat control metadata', () => {
  test('hides named talking-stick handoffs', () => {
    expect(
      stripChatControlMetadata(
        'Visible reply\n\n<!-- talking-stick: Software Engineering Code Critic -->',
      ),
    ).toBe('Visible reply');
  });

  test('hides pass and persona presentation controls', () => {
    expect(
      stripChatControlMetadata(
        'Visible reply\n<!-- persona-emote:happy -->\n<!-- talking-stick: pass -->',
      ),
    ).toBe('Visible reply');
  });

  test('hides talking-stick controls between visible content', () => {
    expect(
      stripChatControlMetadata(
        'First paragraph\n\n<!-- talking-stick: pass -->\n\nFinal paragraph',
      ),
    ).toBe('First paragraph\n\nFinal paragraph');
  });
});
