// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { eligibleAiUserTeamMemberIds } from './ai-user-teams';
import type { AiUser, AiUserTeam } from './api';

const team = {
  id: 'team',
  name: 'Team',
  description: '',
  memberIds: ['new', 'invited', 'main', 'disabled'],
  createdAt: '',
  updatedAt: '',
} satisfies AiUserTeam;
const available = [
  { id: 'new' },
  { id: 'invited' },
  { id: 'main' },
] as AiUser[];

describe('AI user team invitations', () => {
  test('keeps only enabled, absent, non-main personas', () => {
    expect(
      eligibleAiUserTeamMemberIds(
        team,
        available,
        new Set(['invited']),
        'main',
      ),
    ).toEqual(['new']);
  });
});
