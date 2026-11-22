import type { AiUser, AiUserTeam } from './api';

export function eligibleAiUserTeamMemberIds(
  team: AiUserTeam,
  available: readonly AiUser[],
  invitedIds: ReadonlySet<string>,
  mainAiUserId: string | null | undefined,
): string[] {
  const availableIds = new Set(available.map((item) => item.id));
  return team.memberIds.filter((id) =>
    availableIds.has(id) && !invitedIds.has(id) && id !== mainAiUserId,
  );
}
