import fs from 'fs/promises';
import path from 'path';
import { ACCOUNT_AVATARS_DIR, DATA_DIR } from '../../config.js';
import { isPathInside } from '../../lib/path-containment.js';
import { serialize } from '../../lib/serial-queue.js';
import { sniffMime, type ImageReference } from '../image-generation/client.js';
import { randomUUID } from 'crypto';

const IMAGE_FILE = /^(?:avatar|avatar-candidate)\.(?:png|jpe?g|webp)$/i;
const CANDIDATE_FILE = /^avatar-candidate\.(?:png|jpe?g|webp)$/i;

function assertUserId(userId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(userId)) {
    throw new Error('Invalid account id');
  }
}

export function accountAvatarDirectory(userId: string): string {
  assertUserId(userId);
  return path.join(ACCOUNT_AVATARS_DIR, userId);
}

function accountAvatarRelativePath(userId: string, filename: string): string {
  assertUserId(userId);
  if (!IMAGE_FILE.test(filename) && filename !== 'avatar-thumbnail.jpg') {
    throw new Error('Invalid account avatar filename');
  }
  return path.posix.join('account-avatars', userId, filename);
}

function resolveAccountAvatarPath(relativePath: string): string {
  const resolved = path.resolve(DATA_DIR, relativePath);
  if (!isPathInside(ACCOUNT_AVATARS_DIR, resolved, { allowRoot: false })) {
    throw new Error('Invalid account avatar asset path');
  }
  return resolved;
}

export function resolveOwnedAccountAvatarPath(
  userId: string,
  relativePath: string,
): string {
  const resolved = resolveAccountAvatarPath(relativePath);
  if (
    !isPathInside(accountAvatarDirectory(userId), resolved, {
      allowRoot: false,
    })
  ) {
    throw new Error('Invalid account avatar owner path');
  }
  return resolved;
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, data);
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export interface AccountAvatarAsset {
  path: string;
  version: string;
}

async function assetAt(
  userId: string,
  relativePath: string,
): Promise<AccountAvatarAsset | null> {
  let filePath: string;
  try {
    filePath = resolveOwnedAccountAvatarPath(userId, relativePath);
  } catch {
    return null;
  }
  const stat = await fs.stat(filePath, { bigint: true }).catch(() => null);
  return stat
    ? {
        path: relativePath,
        version: `${stat.mtimeNs.toString(36)}-${stat.size.toString(36)}`,
      }
    : null;
}

export async function accountAvatarAsset(
  userId: string,
  relativePath: string | null | undefined,
): Promise<AccountAvatarAsset | null> {
  if (!relativePath) return null;
  return assetAt(userId, relativePath);
}

export async function writeAccountAvatar(
  userId: string,
  extension: string,
  data: Buffer,
  persist?: (avatarPath: string) => Promise<void>,
): Promise<AccountAvatarAsset> {
  return serialize(`account-avatar:${userId}`, async () => {
    const dir = accountAvatarDirectory(userId);
    const relative = accountAvatarRelativePath(userId, `avatar${extension}`);
    await fs.mkdir(dir, { recursive: true });
    const existing = (await fs.readdir(dir).catch(() => [] as string[])).filter(
      (name) => /^avatar\.(?:png|jpe?g|webp)$/i.test(name),
    );
    const archived = existing.map((name) => ({
      name,
      archive: `avatar-previous-${Date.now()}-${randomUUID()}-${name}`,
    }));
    try {
      for (const item of archived) {
        await fs.rename(
          path.join(dir, item.name),
          path.join(dir, item.archive),
        );
      }
      await atomicWrite(resolveAccountAvatarPath(relative), data);
      await fs
        .unlink(path.join(dir, 'avatar-thumbnail.jpg'))
        .catch(() => undefined);
      await persist?.(relative);
    } catch (error) {
      await fs
        .unlink(resolveAccountAvatarPath(relative))
        .catch(() => undefined);
      for (const item of archived) {
        await fs
          .rename(path.join(dir, item.archive), path.join(dir, item.name))
          .catch(() => undefined);
      }
      throw error;
    }
    await Promise.all(
      archived.map((item) =>
        fs.unlink(path.join(dir, item.archive)).catch(() => undefined),
      ),
    );
    return (await assetAt(userId, relative))!;
  });
}

export async function findAccountAvatarCandidate(
  userId: string,
): Promise<AccountAvatarAsset | null> {
  const entry = (
    await fs.readdir(accountAvatarDirectory(userId)).catch(() => [] as string[])
  ).find((name) => CANDIDATE_FILE.test(name));
  return entry
    ? assetAt(userId, accountAvatarRelativePath(userId, entry))
    : null;
}

export async function writeAccountAvatarCandidate(
  userId: string,
  extension: string,
  data: Buffer,
): Promise<AccountAvatarAsset> {
  return serialize(`account-avatar:${userId}`, async () => {
    const dir = accountAvatarDirectory(userId);
    const relative = accountAvatarRelativePath(
      userId,
      `avatar-candidate${extension}`,
    );
    await atomicWrite(resolveAccountAvatarPath(relative), data);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter(
          (name) =>
            CANDIDATE_FILE.test(name) && name !== path.basename(relative),
        )
        .map((name) => fs.unlink(path.join(dir, name))),
    );
    return (await assetAt(userId, relative))!;
  });
}

export async function discardAccountAvatarCandidate(
  userId: string,
): Promise<boolean> {
  return serialize(`account-avatar:${userId}`, async () => {
    const candidate = await findAccountAvatarCandidate(userId);
    if (!candidate) return false;
    await fs.unlink(resolveAccountAvatarPath(candidate.path));
    return true;
  });
}

export async function promoteAccountAvatarCandidate(
  userId: string,
  getCurrentAvatarPath: () => Promise<string | null>,
  persist?: (avatarPath: string) => Promise<void>,
): Promise<AccountAvatarAsset> {
  return serialize(`account-avatar:${userId}`, async () => {
    const candidate = await findAccountAvatarCandidate(userId);
    if (!candidate)
      throw new Error('No generated avatar candidate is available');
    const currentAvatarPath = await getCurrentAvatarPath();
    const extension = path.extname(candidate.path).toLowerCase();
    const nextRelative = accountAvatarRelativePath(
      userId,
      `avatar${extension}`,
    );
    const archivedRelative = currentAvatarPath
      ? path.posix.join(
          'account-avatars',
          userId,
          `avatar-previous-${Date.now()}-${randomUUID()}${path.extname(currentAvatarPath).toLowerCase()}`,
        )
      : null;
    if (currentAvatarPath && archivedRelative) {
      try {
        await fs.rename(
          resolveOwnedAccountAvatarPath(userId, currentAvatarPath),
          resolveAccountAvatarPath(archivedRelative),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await fs.rename(
        resolveAccountAvatarPath(candidate.path),
        resolveAccountAvatarPath(nextRelative),
      );
      await fs
        .unlink(
          path.join(accountAvatarDirectory(userId), 'avatar-thumbnail.jpg'),
        )
        .catch(() => undefined);
      await persist?.(nextRelative);
      if (archivedRelative) {
        await fs
          .unlink(resolveAccountAvatarPath(archivedRelative))
          .catch(() => undefined);
      }
    } catch (error) {
      await fs
        .rename(
          resolveAccountAvatarPath(nextRelative),
          resolveAccountAvatarPath(candidate.path),
        )
        .catch(() => undefined);
      if (currentAvatarPath && archivedRelative) {
        await fs
          .rename(
            resolveAccountAvatarPath(archivedRelative),
            resolveOwnedAccountAvatarPath(userId, currentAvatarPath),
          )
          .catch(() => undefined);
      }
      throw error;
    }
    return (await assetAt(userId, nextRelative))!;
  });
}

export async function readAccountAvatarReference(
  userId: string,
  relativePath: string,
): Promise<ImageReference> {
  const data = await fs.readFile(
    resolveOwnedAccountAvatarPath(userId, relativePath),
  );
  const mimetype = sniffMime(data);
  if (!mimetype) {
    throw new Error(
      'The current avatar is not a supported PNG, JPEG, or WebP image',
    );
  }
  return { data: data.toString('base64'), mimetype };
}
