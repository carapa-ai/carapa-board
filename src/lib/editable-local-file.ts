import { randomUUID } from 'crypto';
import { sha256Hex } from './hash.js';
import { constants, lstatSync, renameSync } from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {
  detectMimetype,
  isSafeRelativePath,
  isTextMimetype,
  safeResolve,
} from './file-content.js';
import { GROUP_FILES_IGNORE } from './file-tree.js';
import { isPathInside } from './path-containment.js';
import {
  GroupFsError,
  openDirAt,
  openParentDir,
  type PinnedDir,
} from './group-fs.js';

export const EDITABLE_TEXT_MAX_BYTES = 500 * 1024;
export type EditableFileSource = 'group' | 'artifact';

export interface EditableLocalFile {
  source: EditableFileSource;
  path: string;
  content: string;
  mimetype: string;
  size: number;
  revision: string;
  sensitive: boolean;
}

export class EditableFileError extends Error {
  constructor(
    public status: number,
    message: string,
    public stale?: { revision: string; size: number },
  ) {
    super(message);
  }
}

function revision(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

export function isSensitiveFilePath(relPath: string): boolean {
  const name = path.posix.basename(relPath).toLowerCase();
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    ['.npmrc', '.pypirc', '.netrc', '_netrc'].includes(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(?:\..+)?$/.test(name) ||
    /(^|[._-])(credentials?|secrets?|tokens?|private[-_]?key)([._-]|$)/i.test(
      name,
    ) ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}

function normalizedPath(raw: unknown, source: EditableFileSource): string {
  if (!isSafeRelativePath(raw))
    throw new EditableFileError(400, 'Invalid path');
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!isSafeRelativePath(normalized))
    throw new EditableFileError(400, 'Invalid path');
  const segments = normalized.split('/');
  if (
    source === 'group' &&
    (segments.some((segment) => GROUP_FILES_IGNORE.has(segment)) ||
      segments.slice(0, -1).some((segment) => segment.startsWith('.')) ||
      segments[0] === 'logs' ||
      segments[0] === 'transcripts' ||
      segments[0] === 'artifacts')
  )
    throw new EditableFileError(403, 'Runtime-managed files cannot be edited');
  if (
    source === 'artifact' &&
    (segments.some((segment) => segment.startsWith('.')) ||
      segments[0] === 'thumbnails' ||
      normalized.endsWith('.meta.json') ||
      normalized.endsWith('.archived'))
  )
    throw new EditableFileError(403, 'Managed artifact files cannot be edited');
  return normalized;
}

const replacementQueues = new Map<string, Promise<void>>();

/** Serialize board writers of one absolute path (editor save, rename, move). */
export async function withTargetReplacementLock<T>(
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(target);
  const previous = replacementQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  replacementQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (replacementQueues.get(key) === queued) replacementQueues.delete(key);
  }
}

async function validateDescriptorPath(rootFdPath: string, relPath: string) {
  let component = rootFdPath;
  for (const segment of relPath.split('/')) {
    component = path.join(component, segment);
    try {
      if ((await fsp.lstat(component)).isSymbolicLink())
        throw new EditableFileError(400, 'Symlinks cannot be edited');
    } catch (error) {
      if (error instanceof EditableFileError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new EditableFileError(404, 'File not found');
      throw error;
    }
  }
}

/**
 * Pin the editable root. The root's parent is pinned first (the group folder
 * for an artifacts root, the parent group folder for a nested child, each
 * walked from GROUPS_DIR without links), then the root is opened from it, so a
 * root that is not the last link in a swapped chain is refused too.
 */
async function openRootDir(root: string): Promise<PinnedDir> {
  try {
    const parent = await openParentDir(root);
    if (parent) {
      try {
        const dir = await openDirAt(parent.dir, parent.name);
        if (dir) return dir;
      } finally {
        await parent.dir.close();
      }
    }
  } catch (error) {
    if (error instanceof GroupFsError && error.code === 'symlink')
      throw new EditableFileError(400, 'Symlinks cannot be edited');
    throw error;
  }
  throw Object.assign(new Error(`Editable root not found: ${root}`), {
    code: 'ENOENT',
  });
}

async function openSecureExistingFile(
  root: string,
  rawPath: unknown,
  source: EditableFileSource,
) {
  const relPath = normalizedPath(rawPath, source);
  let absPath: string;
  try {
    absPath = safeResolve(root, relPath);
  } catch {
    throw new EditableFileError(400, 'Invalid path');
  }
  const rootHandle = await openRootDir(root);
  const rootFdPath = `/proc/self/fd/${rootHandle.fd}`;
  const candidate = path.join(rootFdPath, ...relPath.split('/'));
  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    await validateDescriptorPath(rootFdPath, relPath);
    handle = await fsp.open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    await rootHandle.close().catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new EditableFileError(400, 'Symlinks cannot be edited');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new EditableFileError(404, 'File not found');
    throw error;
  }
  try {
    const [rootReal, openedReal, stat] = await Promise.all([
      fsp.realpath(rootFdPath),
      fsp.realpath(`/proc/self/fd/${handle.fd}`),
      handle.stat(),
    ]);
    if (!stat.isFile())
      throw new EditableFileError(400, 'Only regular files can be edited');
    if (!isPathInside(rootReal, openedReal))
      throw new EditableFileError(400, 'Path escapes source boundary');

    // Recheck every lexical component and the final inode after opening. A
    // rename between the lexical checks and open cannot redirect subsequent
    // reads: they use this held descriptor, and an identity mismatch is denied.
    await validateDescriptorPath(rootFdPath, relPath);
    const current = await fsp.lstat(candidate);
    if (current.dev !== stat.dev || current.ino !== stat.ino)
      throw new EditableFileError(409, 'File changed while it was opened');
    return { relPath, absPath, stat, handle, rootHandle, rootReal };
  } catch (error) {
    await handle.close().catch(() => {});
    await rootHandle.close().catch(() => {});
    throw error;
  }
}

async function openSecureParentDirectory(
  rootHandle: PinnedDir,
  rootReal: string,
  relPath: string,
) {
  const parent = path.posix.dirname(relPath);
  const rootFdPath = `/proc/self/fd/${rootHandle.fd}`;
  const parentViaRoot = path.join(
    rootFdPath,
    ...(parent === '.' ? [] : parent.split('/')),
  );
  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    if (parent !== '.') await validateDescriptorPath(rootFdPath, parent);
    const expected = await fsp.stat(parentViaRoot);
    handle = await fsp.open(
      parentViaRoot,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const opened = await handle.stat();
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      await handle.close().catch(() => {});
      throw new EditableFileError(409, 'Parent directory changed');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new EditableFileError(400, 'Symlinks cannot be edited');
    throw error;
  }
  try {
    if (parent !== '.') await validateDescriptorPath(rootFdPath, parent);
    const [real, opened, current] = await Promise.all([
      fsp.realpath(`/proc/self/fd/${handle.fd}`),
      handle.stat(),
      fsp.stat(parentViaRoot),
    ]);
    if (!isPathInside(rootReal, real))
      throw new EditableFileError(400, 'Path escapes source boundary');
    if (opened.dev !== current.dev || opened.ino !== current.ino)
      throw new EditableFileError(409, 'Parent directory changed');
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function validateText(relPath: string, bytes: Buffer): string {
  if (bytes.length > EDITABLE_TEXT_MAX_BYTES)
    throw new EditableFileError(413, 'File is too large to edit');
  const mimetype = detectMimetype(relPath, bytes);
  if (!isTextMimetype(mimetype))
    throw new EditableFileError(415, 'File is not editable text');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EditableFileError(415, 'File is not valid UTF-8 text');
  }
  return mimetype;
}

export async function loadEditableLocalFile(
  root: string,
  rawPath: unknown,
  source: EditableFileSource,
): Promise<EditableLocalFile> {
  const resolved = await openSecureExistingFile(root, rawPath, source);
  try {
    if (resolved.stat.size > EDITABLE_TEXT_MAX_BYTES)
      throw new EditableFileError(413, 'File is too large to edit');
    const bytes = await resolved.handle.readFile();
    const mimetype = validateText(resolved.relPath, bytes);
    return {
      source,
      path: resolved.relPath,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      mimetype,
      size: bytes.length,
      revision: revision(bytes),
      sensitive: isSensitiveFilePath(resolved.relPath),
    };
  } finally {
    await Promise.all([resolved.handle.close(), resolved.rootHandle.close()]);
  }
}

export async function replaceEditableLocalFile(
  root: string,
  rawPath: unknown,
  source: EditableFileSource,
  content: unknown,
  expectedRevision: unknown,
  hooks?: { beforeFinalRevalidation?: () => void | Promise<void> },
) {
  if (
    typeof content !== 'string' ||
    typeof expectedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedRevision)
  )
    throw new EditableFileError(
      400,
      'content and expectedRevision are required',
    );
  const replacement = Buffer.from(content, 'utf8');
  if (replacement.toString('utf8') !== content)
    throw new EditableFileError(400, 'Content must be valid UTF-8');
  const relPath = normalizedPath(rawPath, source);
  const target = safeResolve(root, relPath);
  return withTargetReplacementLock(target, async () => {
    const resolved = await openSecureExistingFile(root, relPath, source);
    let parentHandle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      validateText(resolved.relPath, replacement);
      const current = await resolved.handle.readFile();
      validateText(resolved.relPath, current);
      if (revision(current) !== expectedRevision)
        throw new EditableFileError(409, 'File changed since it was loaded', {
          revision: revision(current),
          size: current.length,
        });
      parentHandle = await openSecureParentDirectory(
        resolved.rootHandle,
        resolved.rootReal,
        resolved.relPath,
      );
    } finally {
      await Promise.all([resolved.handle.close(), resolved.rootHandle.close()]);
    }

    const parentFdPath = `/proc/self/fd/${parentHandle.fd}`;
    const basename = path.basename(resolved.absPath);
    const temp = path.join(
      parentFdPath,
      `.${basename}.carapa-${randomUUID()}.tmp`,
    );
    const targetViaParent = path.join(parentFdPath, basename);
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      handle = await fsp.open(temp, 'wx', resolved.stat.mode);
      await handle.writeFile(replacement);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.chmod(temp, resolved.stat.mode);
      await hooks?.beforeFinalRevalidation?.();
      // The final revision check and rename use the held parent descriptor, so
      // replacing a lexical parent cannot redirect either operation. Keep the
      // target open, compare the pathname to that exact inode after reading,
      // then synchronously rename with no awaited work in between.
      let liveHandle: Awaited<ReturnType<typeof fsp.open>>;
      try {
        liveHandle = await fsp.open(
          targetViaParent,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new EditableFileError(404, 'File not found');
        if ((error as NodeJS.ErrnoException).code === 'ELOOP')
          throw new EditableFileError(400, 'Symlinks cannot be edited');
        throw error;
      }
      try {
        const live = await liveHandle.readFile();
        validateText(resolved.relPath, live);
        if (revision(live) !== expectedRevision)
          throw new EditableFileError(409, 'File changed since it was loaded', {
            revision: revision(live),
            size: live.length,
          });
        const handleStat = await liveHandle.stat();
        const pathStat = lstatSync(targetViaParent);
        if (
          !pathStat.isFile() ||
          pathStat.isSymbolicLink() ||
          pathStat.dev !== handleStat.dev ||
          pathStat.ino !== handleStat.ino ||
          pathStat.size !== handleStat.size ||
          pathStat.mtimeMs !== handleStat.mtimeMs ||
          pathStat.ctimeMs !== handleStat.ctimeMs
        )
          throw new EditableFileError(409, 'File changed since it was loaded', {
            revision: revision(live),
            size: live.length,
          });
        renameSync(temp, targetViaParent);
      } finally {
        await liveHandle.close().catch(() => {});
      }
      return {
        source,
        path: resolved.relPath,
        revision: revision(replacement),
        size: replacement.length,
      };
    } finally {
      await handle?.close().catch(() => {});
      await fsp.unlink(temp).catch(() => {});
      await parentHandle.close().catch(() => {});
    }
  });
}
