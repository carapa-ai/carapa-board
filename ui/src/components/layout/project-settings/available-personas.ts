import type { ProjectSettings } from '@/types';

type Availability = {
  availableAiUsers: { id: string }[];
  availableAiUserTeams: { id: string }[];
};

// Stored defaults may reference a persona or team that was disabled or deleted
// afterwards. Drop those ids so the form never shows them as selected and a
// save removes them from the stored settings.
export function pruneUnavailablePersonas(
  settings: ProjectSettings,
  { availableAiUsers, availableAiUserTeams }: Availability,
): ProjectSettings {
  const userIds = new Set(availableAiUsers.map((item) => item.id));
  const teamIds = new Set(availableAiUserTeams.map((item) => item.id));
  const result = { ...settings };
  if (result.defaultMainAiUserId && !userIds.has(result.defaultMainAiUserId)) {
    result.defaultMainAiUserId = null;
  }
  if (result.defaultInvitedAiUserIds) {
    result.defaultInvitedAiUserIds = result.defaultInvitedAiUserIds.filter(
      (id) => userIds.has(id),
    );
  }
  if (result.defaultInvitedAiUserTeamIds) {
    result.defaultInvitedAiUserTeamIds =
      result.defaultInvitedAiUserTeamIds.filter((id) => teamIds.has(id));
  }
  return result;
}
