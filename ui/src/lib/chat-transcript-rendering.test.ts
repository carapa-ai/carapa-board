// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { deduplicateCanonicalAssistantEntries } from './chat-transcript-rendering';

describe('deduplicateCanonicalAssistantEntries', () => {
  it('keeps the attribution boundary but removes a repeated canonical persona row', () => {
    const entries = [
      {
        id: 'angy-1',
        type: 'message',
        role: 'assistant',
        content: 'Angy response',
      },
      {
        id: 'angy-1',
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
      },
      {
        id: 'angy-1',
        type: 'message',
        role: 'assistant',
        content: 'Angy response',
      },
    ];
    expect(deduplicateCanonicalAssistantEntries(entries)).toEqual(
      entries.slice(0, 2),
    );
  });

  it('keeps a populated row when an empty placeholder arrives first', () => {
    const entries = [
      { id: 'angy-1', type: 'message', role: 'assistant', content: '' },
      {
        id: 'angy-1',
        type: 'message',
        role: 'assistant',
        content: 'Angy response',
      },
    ];
    expect(deduplicateCanonicalAssistantEntries(entries)).toEqual(entries);
  });
  it('deduplicates canonical aliases across an empty attribution boundary', () => {
    const entries = [
      {
        id: 'live-main-1',
        type: 'message',
        role: 'assistant',
        content: 'Final paragraph',
        canonicalMessageId: 'run-main-1',
      },
      {
        id: 'run-main-1',
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
      },
      {
        id: 'run-main-1',
        type: 'message',
        role: 'assistant',
        content: 'Final paragraph',
      },
    ];
    expect(deduplicateCanonicalAssistantEntries(entries)).toEqual(
      entries.slice(0, 2),
    );
  });

  it('scopes positional fallback IDs to their user turn', () => {
    const firstUser = {
      id: 'user-1',
      type: 'message',
      role: 'user',
      content: 'First prompt',
    };
    const firstAssistant = {
      id: 'transcript-entry-1',
      type: 'message',
      role: 'assistant',
      content: 'Same response',
    };
    const secondUser = {
      id: 'user-2',
      type: 'message',
      role: 'user',
      content: 'Second prompt',
    };
    const secondAssistant = {
      ...firstAssistant,
      id: 'transcript-entry-1',
    };
    const entries = [
      firstUser,
      firstAssistant,
      { ...firstAssistant },
      secondUser,
      secondAssistant,
    ];

    expect(deduplicateCanonicalAssistantEntries(entries)).toEqual([
      firstUser,
      firstAssistant,
      secondUser,
      secondAssistant,
    ]);
  });
});
