import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { AI_USERS_DIR, DATA_DIR } from '../../config.js';
import { isPathInside } from '../../lib/path-containment.js';
import { sniffMime, type ImageReference } from '../image-generation/client.js';
import { aiUserEmoteThumbnailPath } from './avatar-thumbnail.js';

function assertId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid AI user id');
}

export function normalizeEmoteName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!name) throw new Error('Emote name must contain letters or numbers');
  return name;
}

export function aiUserDirectory(id: string): string {
  assertId(id);
  return path.join(AI_USERS_DIR, id);
}

function aiUserRelativePath(id: string, filename: string): string {
  assertId(id);
  return path.posix.join('ai-users', id, filename);
}

export function resolveAiUserPath(relativePath: string): string {
  const resolved = path.resolve(DATA_DIR, relativePath);
  if (!isPathInside(AI_USERS_DIR, resolved, { allowRoot: false })) {
    throw new Error('Invalid AI user asset path');
  }
  return resolved;
}

export async function writeAiUserPrompt(
  id: string,
  content: string,
): Promise<string> {
  const dir = aiUserDirectory(id);
  await fs.mkdir(dir, { recursive: true });
  // Prompt paths are immutable publication artifacts. A persona edit writes
  // its own file, then atomically switches ai_users.prompt_path together with
  // the parsed metadata and persona revision. Reusing prompt.md would let two
  // concurrent edits publish one edit's row with the other edit's bytes.
  const relative = aiUserRelativePath(id, `prompt-${randomUUID()}.md`);
  await fs.writeFile(resolveAiUserPath(relative), content, 'utf8');
  return relative;
}

export async function readAiUserPrompt(relativePath: string): Promise<string> {
  return fs.readFile(resolveAiUserPath(relativePath), 'utf8');
}

export async function writeAiUserAvatar(
  id: string,
  extension: string,
  data: Buffer,
): Promise<string> {
  const dir = aiUserDirectory(id);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => /^avatar\.(?:png|jpe?g|webp)$/i.test(name))
      .map((name) => fs.unlink(path.join(dir, name))),
  );
  await fs
    .unlink(path.join(dir, 'avatar-thumbnail.jpg'))
    .catch(() => undefined);
  const relative = aiUserRelativePath(id, `avatar${extension}`);
  await fs.writeFile(resolveAiUserPath(relative), data);
  return relative;
}

export interface AiUserAvatarCandidate {
  path: string;
  version: string;
}

export async function findAiUserAvatarCandidate(
  id: string,
): Promise<AiUserAvatarCandidate | null> {
  const dir = aiUserDirectory(id);
  const entry = (await fs.readdir(dir).catch(() => [] as string[])).find(
    (name) => /^avatar-candidate\.(?:png|jpe?g|webp)$/i.test(name),
  );
  if (!entry) return null;
  const relativePath = aiUserRelativePath(id, entry);
  const stat = await fs.stat(resolveAiUserPath(relativePath)).catch(() => null);
  return stat
    ? { path: relativePath, version: stat.mtimeMs.toString(36) }
    : null;
}

export async function writeAiUserAvatarCandidate(
  id: string,
  extension: string,
  data: Buffer,
): Promise<AiUserAvatarCandidate> {
  const dir = aiUserDirectory(id);
  await fs.mkdir(dir, { recursive: true });
  const previous = await findAiUserAvatarCandidate(id);
  if (previous) await fs.unlink(resolveAiUserPath(previous.path));
  const relative = aiUserRelativePath(id, `avatar-candidate${extension}`);
  await fs.writeFile(resolveAiUserPath(relative), data);
  const stat = await fs.stat(resolveAiUserPath(relative));
  return { path: relative, version: stat.mtimeMs.toString(36) };
}

export async function discardAiUserAvatarCandidate(
  id: string,
): Promise<boolean> {
  const candidate = await findAiUserAvatarCandidate(id);
  if (!candidate) return false;
  await fs.unlink(resolveAiUserPath(candidate.path));
  return true;
}

export async function promoteAiUserAvatarCandidate(
  id: string,
  currentAvatarPath: string | null,
): Promise<string> {
  const candidate = await findAiUserAvatarCandidate(id);
  if (!candidate) throw new Error('No generated avatar candidate is available');
  const extension = path.extname(candidate.path).toLowerCase();
  const nextRelative = aiUserRelativePath(id, `avatar${extension}`);
  let archivedPath: string | null = null;
  if (currentAvatarPath) {
    const oldExtension = path.extname(currentAvatarPath).toLowerCase();
    archivedPath = aiUserRelativePath(
      id,
      `avatar-previous-${Date.now()}${oldExtension}`,
    );
    await fs.rename(
      resolveAiUserPath(currentAvatarPath),
      resolveAiUserPath(archivedPath),
    );
  }
  try {
    await fs.rename(
      resolveAiUserPath(candidate.path),
      resolveAiUserPath(nextRelative),
    );
    await fs
      .unlink(path.join(aiUserDirectory(id), 'avatar-thumbnail.jpg'))
      .catch(() => undefined);
  } catch (error) {
    if (currentAvatarPath && archivedPath) {
      await fs
        .rename(
          resolveAiUserPath(archivedPath),
          resolveAiUserPath(currentAvatarPath),
        )
        .catch(() => undefined);
    }
    throw error;
  }
  return nextRelative;
}

export async function readAiUserImageReference(
  relativePath: string,
): Promise<ImageReference> {
  const data = await fs.readFile(resolveAiUserPath(relativePath));
  const mimetype = sniffMime(data);
  if (!mimetype)
    throw new Error(
      'The current avatar is not a supported PNG, JPEG, or WebP image',
    );
  return { data: data.toString('base64'), mimetype };
}

export async function writeAiUserVoiceStyle(
  id: string,
  data: Buffer,
): Promise<string> {
  const dir = aiUserDirectory(id);
  await fs.mkdir(dir, { recursive: true });
  const relative = aiUserRelativePath(id, 'voice-style.json');
  await fs.writeFile(resolveAiUserPath(relative), data);
  return relative;
}

export interface AiUserEmoteAsset {
  name: string;
  path: string;
  /** Filesystem-backed cache version; changes whenever the image is replaced. */
  version: string;
}

/** Write a candidate that is invisible until its immutable path is published. */
export async function writeImmutableAiUserEmote(
  id: string,
  name: string,
  extension: string,
  data: Buffer,
): Promise<AiUserEmoteAsset> {
  const normalized = normalizeEmoteName(name);
  const dir = aiUserDirectory(id);
  await fs.mkdir(dir, { recursive: true });
  const relative = aiUserRelativePath(
    id,
    `emote-${normalized}-${randomUUID()}${extension}`,
  );
  await fs.writeFile(resolveAiUserPath(relative), data);
  const stat = await fs.stat(resolveAiUserPath(relative));
  return {
    name: normalized,
    path: relative,
    version: stat.mtimeMs.toString(36),
  };
}

export async function removeAiUserEmoteAsset(
  emote: AiUserEmoteAsset,
): Promise<void> {
  const sourcePath = resolveAiUserPath(emote.path);
  await fs.unlink(sourcePath).catch(() => undefined);
  await fs.unlink(aiUserEmoteThumbnailPath(sourcePath)).catch(() => undefined);
}

export async function removeAiUserFiles(id: string): Promise<void> {
  await fs.rm(aiUserDirectory(id), { recursive: true, force: true });
}
