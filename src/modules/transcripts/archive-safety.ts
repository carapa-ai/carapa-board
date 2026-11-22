import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isPathInside } from '../../lib/path-containment.js';

const LIST_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Symlink/type safety for the agent-writable `transcripts/` tree and its
 * `archive/` bundles. Agents can plant symlinks (as the archive file itself or
 * as members of a tarball), so every archive is checked before it is
 * extracted or read and every extracted tree is checked before anything is
 * copied into it.
 */

/**
 * Require `p` to be a regular file (not a symlink) whose parent directory
 * resolves, symlinks included, to somewhere inside `root`. Throws otherwise.
 */
function assertRegularFileInside(root: string, p: string): void {
  const stat = fs.lstatSync(p);
  if (!stat.isFile()) {
    throw new Error(`not a regular file: ${p}`);
  }
  assertParentInside(root, p);
}

/** Require the parent directory of `p` to resolve inside `root`. */
function assertParentInside(root: string, p: string): void {
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(path.dirname(p));
  if (!isPathInside(realRoot, realParent)) {
    throw new Error(`path escapes ${root}: ${p}`);
  }
}

/** Non-throwing form of {@link assertRegularFileInside}. */
export function isRegularFileInside(root: string, p: string): boolean {
  try {
    assertRegularFileInside(root, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject a `tar -tv` listing that contains anything other than regular files
 * (symlinks, hardlinks, devices, FIFOs, directories). The single top-level
 * `./` directory entry written by `tar -c ... .` is tolerated.
 */
export function assertRegularArchiveMembers(verboseListing: string): void {
  for (const line of verboseListing.split('\n')) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type === '-') continue;
    if (type === 'd' && /\s\.\/?$/.test(line)) continue;
    throw new Error(
      `archive contains a non-regular member: ${line.slice(0, 200)}`,
    );
  }
}

/** Refuse a tarball that holds anything but regular files (before extracting). */
export function assertRegularArchive(tarPath: string): void {
  assertRegularArchiveMembers(
    execFileSync('tar', ['-tvzf', tarPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: LIST_MAX_BUFFER,
    }),
  );
}

/**
 * After `tar -x` into `dir`, refuse anything that is not a plain regular file
 * with a single link. Must run before any copy into `dir`.
 */
export function assertExtractedTreeRegular(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const stat = fs.lstatSync(path.join(dir, entry));
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error(
        `extracted archive member is not a regular file: ${entry}`,
      );
    }
  }
}
