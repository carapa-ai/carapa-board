import path from 'node:path';
import { ensurePersistentImageThumbnail } from '../../lib/file-thumbnail.js';

const AI_USER_AVATAR_THUMBNAIL_SIZE = 256;

export function aiUserAvatarThumbnailPath(sourcePath: string): string {
  return path.join(path.dirname(sourcePath), 'avatar-thumbnail.jpg');
}

export function aiUserEmoteThumbnailPath(sourcePath: string): string {
  const name = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(path.dirname(sourcePath), 'emote-thumbnails', `${name}.jpg`);
}

async function ensureAiUserImageThumbnail(
  sourcePath: string,
  thumbnailPath: string,
): Promise<string | null> {
  return (await ensurePersistentImageThumbnail(
    sourcePath,
    thumbnailPath,
    AI_USER_AVATAR_THUMBNAIL_SIZE,
  ))
    ? thumbnailPath
    : null;
}

/**
 * Generate a persistent, bounded JPEG for avatar-sized UI surfaces. The
 * source mtime invalidates the cache whenever an avatar is replaced.
 */
export async function ensureAvatarThumbnail(
  sourcePath: string,
): Promise<string | null> {
  return ensureAiUserImageThumbnail(
    sourcePath,
    aiUserAvatarThumbnailPath(sourcePath),
  );
}

export const ensureAiUserAvatarThumbnail = ensureAvatarThumbnail;

export async function ensureAiUserEmoteThumbnail(
  sourcePath: string,
): Promise<string | null> {
  return ensureAiUserImageThumbnail(
    sourcePath,
    aiUserEmoteThumbnailPath(sourcePath),
  );
}
