import { describe, expect, test } from 'bun:test';
import { parseConversationAiUserSelection } from './conversation-selection.js';

describe('new-conversation AI user selection', () => {
  test('normalizes IDs, deduplicates invitations, and keeps the main user exclusive', () => {
    expect(
      parseConversationAiUserSelection({
        mainAiUserId: ' main ',
        invitedAiUserIds: ['guest', ' guest ', 'main'],
      }),
    ).toEqual({
      selection: {
        mainAiUserSelection: { mode: 'persona', aiUserId: 'main' },
        invitedAiUserIds: ['guest'],
        invitedAiUserIdsProvided: true,
      },
    });
  });

  test('preserves an explicit empty invitation list as a project-default override', () => {
    expect(parseConversationAiUserSelection({ invitedAiUserIds: [] })).toEqual({
      selection: {
        mainAiUserSelection: { mode: 'inherit' },
        invitedAiUserIds: [],
        invitedAiUserIdsProvided: true,
      },
    });
  });

  test('supports explicit none and structured persona selections', () => {
    expect(
      parseConversationAiUserSelection({
        mainAiUserSelection: { mode: 'none' },
      }),
    ).toEqual({
      selection: {
        mainAiUserSelection: { mode: 'none' },
        invitedAiUserIds: [],
        invitedAiUserIdsProvided: false,
      },
    });
    expect(
      parseConversationAiUserSelection({
        mainAiUserSelection: { mode: 'persona', aiUserId: ' main ' },
      }),
    ).toEqual({
      selection: {
        mainAiUserSelection: { mode: 'persona', aiUserId: 'main' },
        invitedAiUserIds: [],
        invitedAiUserIdsProvided: false,
      },
    });
  });

  test('rejects malformed selections', () => {
    expect(
      parseConversationAiUserSelection({ mainAiUserId: '' }),
    ).toHaveProperty('error');
    expect(
      parseConversationAiUserSelection({
        mainAiUserSelection: { mode: 'persona' },
      }),
    ).toHaveProperty('error');
    expect(
      parseConversationAiUserSelection({ invitedAiUserIds: [''] }),
    ).toHaveProperty('error');
    expect(
      parseConversationAiUserSelection({ invitedAiUserIds: 'guest' }),
    ).toHaveProperty('error');
  });
});
