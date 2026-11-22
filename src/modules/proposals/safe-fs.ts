/**
 * Directory-anchored filesystem access for proposal targets.
 *
 * An agent can swap a directory for a symlink at any moment, so checking a
 * path and then using it is not safe. Instead each directory below the project
 * root is opened with O_NOFOLLOW and every later operation uses the open
 * descriptor (`/proc/self/fd/<n>/...`), which keeps naming the verified inode
 * whatever happens to the original path. Linux only; elsewhere it fails closed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ProposalValidationError } from './actions.js';

const { O_RDONLY, O_NOFOLLOW } = fs.constants;

/** Path that resolves inside the directory held open by `handle`. */
export function fdPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

function refused(what: string): ProposalValidationError {
  return new ProposalValidationError(
    `Refusing to use ${what}: it is not a plain directory`,
  );
}

/** Open the trusted project root (it may itself be reached through links). */
async function openRoot(rootDir: string): Promise<FileHandle> {
  try {
    const handle = await fsp.open(rootDir, O_RDONLY);
    if ((await handle.stat()).isDirectory()) return handle;
    await handle.close();
  } catch {
    /* reported below */
  }
  throw new ProposalValidationError(
    `Target directory does not exist: ${rootDir}`,
  );
}

/** Open `name` below `parentPath` as a real directory, never through a link. */
export async function openDirNoFollow(
  parentPath: string,
  name: string,
  display: string,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(`${parentPath}/${name}`, O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw refused(display);
    throw err;
  }
  if (!(await handle.stat()).isDirectory()) {
    await handle.close();
    throw refused(display);
  }
  return handle;
}

/**
 * Open `rootDir/segments...` one verified directory at a time. Returns null
 * when a segment is missing and `create` is false; with `create`, missing
 * segments are made. The caller closes the returned handle.
 */
export async function openChain(
  rootDir: string,
  segments: string[],
  create: boolean,
): Promise<FileHandle | null> {
  let current = await openRoot(rootDir);
  let display = rootDir;
  try {
    for (const segment of segments) {
      display = path.join(display, segment);
      let next: FileHandle;
      try {
        next = await openDirNoFollow(fdPath(current), segment, display);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!create) {
          await current.close();
          return null;
        }
        await fsp
          .mkdir(`${fdPath(current)}/${segment}`)
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'EEXIST') throw e;
          });
        next = await openDirNoFollow(fdPath(current), segment, display);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (err) {
    await current.close().catch(() => {});
    throw err;
  }
}

/** Remove `name` below the directory `parentPath`, never following links. */
export async function removeNoFollow(
  parentPath: string,
  name: string,
): Promise<void> {
  const child = `${parentPath}/${name}`;
  const stat = await fsp.lstat(child).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat) return;
  if (!stat.isDirectory()) {
    await fsp.unlink(child);
    return;
  }
  const dir = await openDirNoFollow(parentPath, name, child).catch(() => null);
  if (!dir) {
    // Swapped for a link or file between lstat and open: drop that entry only.
    await fsp.unlink(child).catch(() => {});
    return;
  }
  try {
    for (const entry of await fsp.readdir(fdPath(dir))) {
      await removeNoFollow(fdPath(dir), entry);
    }
  } finally {
    await dir.close();
  }
  await fsp.rmdir(child);
}
