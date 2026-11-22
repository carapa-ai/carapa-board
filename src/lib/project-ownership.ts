import { getGroupByFolder } from '../state-manager.js';

/**
 * True when project `folder` is closed to board admins other than its owner:
 * it has an owner (`user_id`) different from `userId`, or it is a personal main
 * (archived mains lost their owner and stay closed to everyone). An ownerless
 * ordinary project or an unknown folder is not, so admins keep their bypass.
 *
 * Lives outside `routes/_helpers.ts` because ws-events cannot import that
 * module (its import graph leads back to ws-events).
 */
export function isOwnedByOtherUser(
  userId: string | undefined,
  folder: string,
): boolean {
  const group = getGroupByFolder(folder);
  if (!group) return false;
  if (group.is_main) return group.user_id !== userId;
  return !!group.user_id && group.user_id !== userId;
}

/**
 * True when `user` is a board admin who skips project membership for `folder`:
 * every project except one owned by another user, where an admin has only
 * their membership level like any user.
 */
export function adminBypassesProject(
  user: { id: string; role?: string } | undefined,
  folder: string,
): boolean {
  return user?.role === 'admin' && !isOwnedByOtherUser(user.id, folder);
}
