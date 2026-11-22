import {
  getAiUserRow,
  inviteConversationAiUser,
  inviteConversationAiUserTeam,
} from '../../db.js';
import type { RegisteredGroup } from '../../types.js';

function normalizeConfiguredIds(ids: unknown[]): string[] {
  return ids
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .map((id) => id.trim());
}

/** Apply inherited project invitations without making stale settings block chat creation. */
export async function inviteProjectDefaultAiUsers(
  conversationId: string,
  group: RegisteredGroup,
  invitedBy: string | null,
  mainAiUserId?: string | null,
) {
  const configuredMainId = group.settings?.defaultMainAiUserId ?? null;
  const main = configuredMainId
    ? await getAiUserRow(configuredMainId)
    : undefined;
  const effectiveMainId =
    mainAiUserId === undefined
      ? main?.enabled === 1
        ? main.id
        : null
      : mainAiUserId;
  const configuredIds = normalizeConfiguredIds(
    group.settings?.defaultInvitedAiUserIds ?? [],
  );
  const users = await Promise.all(configuredIds.map((id) => getAiUserRow(id)));
  await Promise.all(
    users
      .filter(
        (user): user is NonNullable<typeof user> =>
          user?.enabled === 1 && user.id !== effectiveMainId,
      )
      .map((user) =>
        inviteConversationAiUser(conversationId, user.id, invitedBy),
      ),
  );
  await inviteProjectDefaultAiUserTeams(
    conversationId,
    group,
    invitedBy,
    effectiveMainId,
  );
}

/** Invite the project's configured default teams; unknown or empty team ids are no-ops. */
export async function inviteProjectDefaultAiUserTeams(
  conversationId: string,
  group: RegisteredGroup,
  invitedBy: string | null,
  mainAiUserId: string | null,
) {
  const teamIds = normalizeConfiguredIds(
    group.settings?.defaultInvitedAiUserTeamIds ?? [],
  );
  await Promise.all(
    [...new Set(teamIds)].map((teamId) =>
      inviteConversationAiUserTeam(
        conversationId,
        teamId,
        invitedBy,
        mainAiUserId,
      ),
    ),
  );
}
