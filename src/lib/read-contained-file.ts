import fs, { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { mkdirContained } from './file-content.js';
import { isPathInside } from './path-containment.js';

export type ContainedFileErrorCode =
  | 'unreadable'
  | 'outside_root'
  | 'not_regular_file'
  | 'too_large';

export class ContainedFileError extends Error {
  constructor(
    readonly code: ContainedFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContainedFileError';
  }
}

/**
 * Verify the opened descriptor itself (not the path) is still inside the root.
 * Uses /proc/self/fd on Linux; elsewhere compares the descriptor's dev/ino with
 * the checked path's current identity. Throws ContainedFileError otherwise.
 */
function assertDescriptorContained(
  fd: number,
  realRoot: string,
  candidate: string,
  realCandidate: string,
  stat: fs.Stats,
): void {
  let openedPath: string | null = null;
  try {
    openedPath = fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    // Non-Linux: fall back to the identity comparison below.
  }
  if (openedPath !== null) {
    if (!isPathInside(realRoot, openedPath, { allowRoot: false })) {
      throw new ContainedFileError('outside_root', 'File is outside its root');
    }
    return;
  }
  let pathReal: string;
  let pathStat: fs.Stats;
  try {
    pathReal = fs.realpathSync(candidate);
    pathStat = fs.lstatSync(realCandidate);
  } catch {
    throw new ContainedFileError('unreadable', 'File is missing or unreadable');
  }
  if (
    !isPathInside(realRoot, pathReal, { allowRoot: false }) ||
    pathStat.dev !== stat.dev ||
    pathStat.ino !== stat.ino
  ) {
    throw new ContainedFileError('outside_root', 'File is outside its root');
  }
}

/**
 * Read a regular file that must live under `root`, safely against writers that
 * can mutate the tree concurrently (e.g. an agent writing `artifacts/`).
 *
 * The leaf is opened with O_NOFOLLOW | O_NONBLOCK, so a symlink swapped in
 * after the path was resolved is refused and a FIFO cannot block the open.
 * Containment and type/size checks are done on the opened descriptor, not on
 * the path, and at most `maxBytes` are read from it. `onStat` receives the
 * opened descriptor's stat once it is verified, for metadata (e.g. mtime) that
 * must come from the same file as the bytes.
 */
export async function readContainedFile(
  root: string,
  candidate: string,
  maxBytes: number,
  onStat?: (stat: fs.Stats) => void,
): Promise<Buffer> {
  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([
      fsp.realpath(root),
      fsp.realpath(candidate),
    ]);
  } catch {
    throw new ContainedFileError('unreadable', 'File is missing or unreadable');
  }
  if (!isPathInside(realRoot, realCandidate, { allowRoot: false })) {
    throw new ContainedFileError('outside_root', 'File is outside its root');
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      realCandidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new ContainedFileError('unreadable', 'File is missing or unreadable');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ContainedFileError(
        'not_regular_file',
        'File is not a regular file',
      );
    }
    if (stat.size > maxBytes) {
      throw new ContainedFileError('too_large', 'File exceeds the size limit');
    }

    assertDescriptorContained(
      handle.fd,
      realRoot,
      candidate,
      realCandidate,
      stat,
    );
    onStat?.(stat);

    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === buffer.length ? buffer : buffer.subarray(0, offset);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Synchronous variant of {@link readContainedFile} with identical checks and
 * error codes. The FIFO-safe open (O_NONBLOCK) means it never blocks.
 */
export function readContainedFileSync(
  root: string,
  candidate: string,
  maxBytes: number,
): Buffer {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(root);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new ContainedFileError('unreadable', 'File is missing or unreadable');
  }
  if (!isPathInside(realRoot, realCandidate, { allowRoot: false })) {
    throw new ContainedFileError('outside_root', 'File is outside its root');
  }

  let fd: number;
  try {
    fd = fs.openSync(
      realCandidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new ContainedFileError('unreadable', 'File is missing or unreadable');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ContainedFileError(
        'not_regular_file',
        'File is not a regular file',
      );
    }
    if (stat.size > maxBytes) {
      throw new ContainedFileError('too_large', 'File exceeds the size limit');
    }
    assertDescriptorContained(fd, realRoot, candidate, realCandidate, stat);

    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === buffer.length ? buffer : buffer.subarray(0, offset);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort close.
    }
  }
}

/**
 * Write `data` to a regular file that must live under `root`, safely against
 * writers that can mutate the tree concurrently (e.g. an agent swapping a
 * directory or the leaf for a symlink).
 *
 * The leaf is opened with O_NOFOLLOW | O_NONBLOCK and WITHOUT O_TRUNC, so
 * nothing is destroyed before the opened descriptor is verified: it must be a
 * regular file whose real path is inside the real `root`. Only then is it
 * truncated and written through the verified handle. Missing parent
 * directories are created only when the path stays inside `root`.
 *
 * Residual: a swap racing the open can make O_CREAT create one empty file
 * outside `root` when the leaf was absent; that call is refused before any
 * content is written.
 */
export async function writeContainedFileVerified(
  root: string,
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  if (!(await mkdirContained(root, path.dirname(filePath)))) {
    throw new ContainedFileError('outside_root', 'File is outside its root');
  }
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new ContainedFileError('unreadable', 'File is missing or unreadable');
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      filePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o644,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new ContainedFileError('outside_root', 'File is a symlink');
    }
    if (code === 'ENXIO' || code === 'EISDIR') {
      throw new ContainedFileError(
        'not_regular_file',
        'File is not a regular file',
      );
    }
    throw new ContainedFileError('unreadable', 'File is not writable');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ContainedFileError(
        'not_regular_file',
        'File is not a regular file',
      );
    }
    let realCandidate = filePath;
    try {
      realCandidate = await fsp.realpath(filePath);
    } catch {
      // The dev/ino fallback in assertDescriptorContained then fails closed.
    }
    assertDescriptorContained(
      handle.fd,
      realRoot,
      filePath,
      realCandidate,
      stat,
    );
    await handle.truncate(0);
    await handle.writeFile(data);
  } finally {
    await handle.close().catch(() => {});
  }
}
