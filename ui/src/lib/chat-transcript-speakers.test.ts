// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import {
  defaultAgentStreamAnchorId,
  hasPersonaResponseAfterLastUser,
  personaSenderId,
  startsNewPersonaBubble,
} from './chat-transcript-speakers';

describe('chat transcript speaker boundaries', () => {
  it('starts a new bubble when an invited persona follows the default agent', () => {
    expect(startsNewPersonaBubble(null, 'ai:invited', true)).toBe(true);
  });

  it('starts a new bubble for a streaming turn by the same persona', () => {
    expect(startsNewPersonaBubble('ai:main', 'ai:main', true, true)).toBe(
      true,
    );
  });

  it('does not split empty attribution metadata from its preceding response', () => {
    expect(startsNewPersonaBubble(null, 'ai:main', false)).toBe(false);
  });

  it('splits an empty streaming placeholder from the previous speaker', () => {
    expect(startsNewPersonaBubble('ai:main', 'ai:guest', false, true)).toBe(
      true,
    );
    expect(startsNewPersonaBubble('ai:main', 'ai:main', false, true)).toBe(
      false,
    );
  });

  it('normalizes main and invited persona attribution identities', () => {
    expect(personaSenderId({ agent_name: 'ai-main:main' })).toBe('ai:main');
    expect(personaSenderId({ senderUserId: 'ai:invited' })).toBe('ai:invited');
  });

  it('keeps the default-agent stream after before-personas and before after-personas', () => {
    const messages = [
      { id: 'user', role: 'user' },
      { id: 'before', role: 'assistant', senderUserId: 'ai:reviewer' },
      { id: 'after', role: 'assistant', senderUserId: 'ai:morgan' },
    ];
    expect(defaultAgentStreamAnchorId(messages, new Set(['ai:reviewer']))).toBe(
      'before',
    );
    expect(defaultAgentStreamAnchorId(messages, new Set())).toBe('user');
  });

  it('detects persona evidence only in the current user turn', () => {
    expect(
      hasPersonaResponseAfterLastUser([
        { id: 'old-user', role: 'user' },
        { id: 'old-persona', role: 'assistant', senderUserId: 'ai:morgan' },
        { id: 'current-user', role: 'user' },
        { id: 'main', role: 'assistant' },
      ]),
    ).toBe(false);
    expect(
      hasPersonaResponseAfterLastUser([
        { id: 'current-user', role: 'user' },
        { id: 'main', role: 'assistant' },
        { id: 'persona', role: 'assistant', senderUserId: 'ai:morgan' },
      ]),
    ).toBe(true);
  });
});
