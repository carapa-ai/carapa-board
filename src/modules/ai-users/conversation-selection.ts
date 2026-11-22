import { isRecord } from '../../lib/type-guards.js';
import type { MainAiUserSelection } from '../../types.js';

export interface ConversationAiUserSelection {
  mainAiUserSelection: MainAiUserSelection;
  invitedAiUserIds: string[];
  invitedAiUserIdsProvided: boolean;
}

export function parseConversationAiUserSelection(
  body: unknown,
):
  | { selection: ConversationAiUserSelection; error?: never }
  | { selection?: never; error: string } {
  const input = isRecord(body) ? body : {};
  let mainAiUserSelection: MainAiUserSelection;
  const rawSelection = input.mainAiUserSelection;
  if (rawSelection !== undefined) {
    if (!rawSelection || typeof rawSelection !== 'object') {
      return { error: 'mainAiUserSelection must be an object' };
    }
    const selection = rawSelection as Record<string, unknown>;
    if (selection.mode === 'inherit' || selection.mode === 'none') {
      mainAiUserSelection = { mode: selection.mode };
    } else if (
      selection.mode === 'persona' &&
      typeof selection.aiUserId === 'string' &&
      selection.aiUserId.trim()
    ) {
      mainAiUserSelection = {
        mode: 'persona',
        aiUserId: selection.aiUserId.trim(),
      };
    } else {
      return {
        error: 'mainAiUserSelection must select inherit, none, or a persona ID',
      };
    }
  } else if ('mainAiUserId' in input) {
    if (input.mainAiUserId == null) mainAiUserSelection = { mode: 'none' };
    else if (
      typeof input.mainAiUserId === 'string' &&
      input.mainAiUserId.trim()
    ) {
      mainAiUserSelection = {
        mode: 'persona',
        aiUserId: input.mainAiUserId.trim(),
      };
    } else return { error: 'mainAiUserId must be a non-empty string or null' };
  } else {
    mainAiUserSelection = { mode: 'inherit' };
  }

  const invitedAiUserIdsProvided = 'invitedAiUserIds' in input;
  const rawInvitedIds = input.invitedAiUserIds ?? [];
  if (
    !Array.isArray(rawInvitedIds) ||
    rawInvitedIds.length > 20 ||
    rawInvitedIds.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    return { error: 'invitedAiUserIds must contain at most 20 AI user IDs' };
  }
  const explicitMainId =
    mainAiUserSelection.mode === 'persona'
      ? mainAiUserSelection.aiUserId
      : null;
  const invitedAiUserIds = [
    ...new Set(rawInvitedIds.map((id) => id.trim())),
  ].filter((id) => id !== explicitMainId);
  return {
    selection: {
      mainAiUserSelection,
      invitedAiUserIds,
      invitedAiUserIdsProvided,
    },
  };
}
