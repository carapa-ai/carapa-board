import { accountAvatarAsset } from './avatar-storage.js';

export interface AccountProfileSource {
  id: string;
  username: string;
  displayName: string | null;
  avatarPath: string | null;
}

export interface PresentedAccountIdentity {
  id: string;
  username: string;
  displayName: string | null;
  name: string;
  avatarUrl: string | null;
}

export async function presentAccountIdentity(
  user: AccountProfileSource,
): Promise<PresentedAccountIdentity> {
  const avatar = await accountAvatarAsset(user.id, user.avatarPath);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    name: user.displayName?.trim() || user.username,
    avatarUrl: avatar
      ? `/api/users/${encodeURIComponent(user.id)}/avatar?thumbnail=1&v=${encodeURIComponent(avatar.version)}`
      : null,
  };
}
