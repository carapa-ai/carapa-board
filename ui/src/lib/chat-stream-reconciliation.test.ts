// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import {
  canonicalStreamReplacement,
  reconcileChatStreamChunk,
} from './chat-stream-reconciliation';

describe('canonical stream reconciliation', () => {
  it('restores canonical Markdown whitespace for the same streamed response', () => {
    expect(
      canonicalStreamReplacement(
        'First paragraph. Second paragraph. - one - two',
        'First paragraph.\n\nSecond paragraph.\n\n- one\n- two',
      ),
    ).toBe('First paragraph.\n\nSecond paragraph.\n\n- one\n- two');
  });

  it('does not replace a different response or Work Live narration', () => {
    expect(
      canonicalStreamReplacement('Different response', 'Saved response'),
    ).toBeNull();
    expect(
      canonicalStreamReplacement(
        '[[live: Checking files]]\n\nSaved response',
        'Saved response',
      ),
    ).toBeNull();
  });
});

describe('chat stream chunk reconciliation', () => {
  it('does not append a replayed delta series after the completed text', () => {
    const chunks = ['The', ' keyword', ' is', ' **Bula**.'];
    const offsets = [0, 3, 11, 14];
    let content = '';
    for (const [index, chunk] of chunks.entries()) {
      content = reconcileChatStreamChunk(content, chunk, offsets[index]);
    }
    for (const [index, chunk] of chunks.entries()) {
      content = reconcileChatStreamChunk(content, chunk, offsets[index]);
    }
    expect(content).toBe('The keyword is **Bula**.');
  });

  it('fills an overlapping suffix but preserves state across gaps or conflicts', () => {
    expect(reconcileChatStreamChunk('The key', 'keyword', 4)).toBe(
      'The keyword',
    );
    expect(reconcileChatStreamChunk('The', 'word', 8)).toBe('The');
    expect(reconcileChatStreamChunk('The cat', 'dog', 4)).toBe('The cat');
  });
});
