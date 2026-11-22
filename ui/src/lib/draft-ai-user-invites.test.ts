// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { personaControlLabel } from '@/components/chat/ai-users-menu';
import {
  effectiveDraftInvitedIds,
  seedDraftInvites,
} from './draft-ai-user-invites';

const ALL = ['a', 'b', 'c', 'd'];
const untouched = {
  mainSelection: { mode: 'inherit' },
  invitedAiUserIds: [],
  invitedAiUserIdsProvided: false,
};

describe('seedDraftInvites', () => {
  test('untouched draft keeps inheriting project defaults', () => {
    const result = seedDraftInvites(untouched, ['a', 'b'], ALL, null, {});
    expect(result).toBe(untouched);
    expect(result.invitedAiUserIdsProvided).toBe(false);
  });

  test('first invite seeds the project defaults', () => {
    const result = seedDraftInvites(untouched, ['a', 'b'], ALL, null, {
      add: ['c'],
    });
    expect(result.invitedAiUserIds).toEqual(['a', 'b', 'c']);
    expect(result.invitedAiUserIdsProvided).toBe(true);
  });

  test('removing a default keeps the others', () => {
    const result = seedDraftInvites(untouched, ['a', 'b'], ALL, null, {
      remove: ['a'],
    });
    expect(result.invitedAiUserIds).toEqual(['b']);
    expect(result.invitedAiUserIdsProvided).toBe(true);
  });

  test('main persona is excluded from the seeded list', () => {
    const result = seedDraftInvites(untouched, ['a', 'b'], ALL, 'a', {
      add: ['c'],
    });
    expect(result.invitedAiUserIds).toEqual(['b', 'c']);
    expect(effectiveDraftInvitedIds(untouched, ['a', 'b'], ALL, 'a')).toEqual([
      'b',
    ]);
  });

  test('stale or disabled defaults are not seeded', () => {
    const result = seedDraftInvites(
      untouched,
      ['a', 'stale'],
      ['a', 'c'],
      null,
      {
        add: ['c'],
      },
    );
    expect(result.invitedAiUserIds).toEqual(['a', 'c']);
  });

  test('an already provided draft is not re-seeded', () => {
    const provided = {
      ...untouched,
      invitedAiUserIds: ['c'],
      invitedAiUserIdsProvided: true,
    };
    const result = seedDraftInvites(provided, ['a', 'b'], ALL, null, {
      add: ['d'],
    });
    expect(result.invitedAiUserIds).toEqual(['c', 'd']);
  });
});

describe('personaControlLabel', () => {
  test('names the persona', () => {
    expect(personaControlLabel('Pause', 'Ada')).toBe('Pause Ada');
  });
});
