import type { DraftAiUserSelection } from '@/components/chat/ai-users-menu';

/**
 * Persona ids a new (not yet created) chat will invite. Until the draft
 * overrides the project defaults, the server inherits them, so they are what
 * the menu must show; the main persona is never part of the invited list. Inherited defaults are
 * limited to `availableIds` (enabled personas): the server skips stale or
 * disabled defaults when inheriting but rejects them in an explicit list.
 */
export function effectiveDraftInvitedIds(
  draft: Pick<
    DraftAiUserSelection,
    'invitedAiUserIds' | 'invitedAiUserIdsProvided'
  >,
  projectDefaultIds: readonly string[] | undefined,
  availableIds: readonly string[],
  mainAiUserId: string | null | undefined,
): string[] {
  const ids = draft.invitedAiUserIdsProvided
    ? draft.invitedAiUserIds
    : (projectDefaultIds ?? []).filter((id) => availableIds.includes(id));
  return [...new Set(ids)].filter((id) => id !== mainAiUserId);
}

/**
 * Apply an invite/remove change to a draft. The first change to a draft that
 * still inherits project defaults seeds the list with those defaults, so the
 * switch to an explicit list does not silently drop them. A change-free call
 * leaves the draft (and its inherit behaviour) untouched.
 */
export function seedDraftInvites(
  draft: DraftAiUserSelection,
  projectDefaultIds: readonly string[] | undefined,
  availableIds: readonly string[],
  mainAiUserId: string | null | undefined,
  change: { add?: readonly string[]; remove?: readonly string[] },
): DraftAiUserSelection {
  const add = change.add ?? [];
  const remove = new Set(change.remove ?? []);
  if (add.length === 0 && remove.size === 0) return draft;
  const ids = new Set(
    effectiveDraftInvitedIds(
      draft,
      projectDefaultIds,
      availableIds,
      mainAiUserId,
    ),
  );
  for (const id of add) ids.add(id);
  for (const id of remove) ids.delete(id);
  return {
    ...draft,
    invitedAiUserIds: [...ids],
    invitedAiUserIdsProvided: true,
  };
}
