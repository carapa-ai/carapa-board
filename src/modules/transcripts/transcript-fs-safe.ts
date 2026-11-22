/**
 * Symlink- and FIFO-safe file reads for the agent-writable transcripts tree.
 *
 * `<groupDir>/transcripts/` is mounted writable into the project's sandbox, so
 * an agent can plant symlinks (to another project's transcripts) or FIFOs
 * (which block a synchronous read forever) there. Readers in the board and in
 * the standalone `transcripts` CLI must therefore open files without following
 * a leaf symlink, never block on non-regular files, and verify on the open
 * descriptor that the file really lives in the expected directory.
 *
 * Only `node:fs` and `node:path` may be imported here: this module is bundled
 * into the sandbox `transcripts.mjs` CLI via `reader-core.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ReadNoFollowOptions {
  /** Size limit. Larger files yield `null`, or only their tail with `tail`. */
  maxBytes?: number;
  /** With `maxBytes`: read the last `maxBytes` bytes of an oversized file. */
  tail?: boolean;
}

export interface NoFollowText {
  content: string;
  stat: fs.Stats;
}

export interface NoFollowBuffer {
  buffer: Buffer;
  stat: fs.Stats;
}

/** True when `p` is a directory and not a symlink to one. False on any error. */
export function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

const OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW ?? 0) |
  (fs.constants.O_NONBLOCK ?? 0);

/**
 * Verify on the open descriptor that the file is a direct child of `dir`
 * (defeats a parent directory swapped for a symlink after the lstat check).
 */
function descriptorInDir(
  fd: number,
  stat: fs.Stats,
  dir: string,
  filePath: string,
): boolean {
  const realDir = fs.realpathSync(dir);
  let target: string | null = null;
  try {
    target = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    // No /proc: fall back to comparing identities below.
  }
  if (target !== null) return path.dirname(target) === realDir;
  const expected = fs.lstatSync(path.join(realDir, path.basename(filePath)));
  return expected.dev === stat.dev && expected.ino === stat.ino;
}

/** Byte range to read, or null when the file exceeds `maxBytes` without tail. */
function readWindow(
  size: number,
  opts: ReadNoFollowOptions,
): { start: number; length: number } | null {
  const { maxBytes } = opts;
  if (maxBytes === undefined || size <= maxBytes) {
    return { start: 0, length: size };
  }
  return opts.tail ? { start: size - maxBytes, length: maxBytes } : null;
}

function trimRead(buf: Buffer, filled: number): Buffer {
  return filled === buf.length ? buf : buf.subarray(0, filled);
}

function readFully(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, buf, filled, length - filled, start + filled);
    if (n === 0) break;
    filled += n;
  }
  return trimRead(buf, filled);
}

/**
 * Open a regular file directly inside `dir` for reading, with the same
 * refusals as {@link readNoFollowSync}. The caller owns (and must close) the
 * returned descriptor; use it to stream files too large to read at once.
 */
function openNoFollowSync(
  dir: string,
  filePath: string,
): { fd: number; stat: fs.Stats } | null {
  if (!isRealDir(dir)) return null;
  let fd: number;
  try {
    fd = fs.openSync(filePath, OPEN_FLAGS);
  } catch {
    return null; // ENOENT / ELOOP / ENXIO / EAGAIN / EACCES ...
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && descriptorInDir(fd, stat, dir, filePath)) {
      return { fd, stat };
    }
  } catch {
    /* refused below */
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Binary variant of {@link readNoFollowSync}. Returns `null` (never throws)
 * for a missing, symlinked, non-regular, oversized or misplaced file.
 */
export function readBufferNoFollowSync(
  dir: string,
  filePath: string,
  opts: ReadNoFollowOptions = {},
): NoFollowBuffer | null {
  const opened = openNoFollowSync(dir, filePath);
  if (!opened) return null;
  const { fd, stat } = opened;
  try {
    const window = readWindow(stat.size, opts);
    if (!window) return null;
    return { buffer: readFully(fd, window.start, window.length), stat };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a regular file directly inside `dir` without following a leaf symlink,
 * blocking on a FIFO, or accepting a file that resolves outside `dir`.
 * Returns the UTF-8 content and fstat of the descriptor that was read, or
 * `null` (never throws) when the read is refused or fails.
 */
export function readNoFollowSync(
  dir: string,
  filePath: string,
  opts: ReadNoFollowOptions = {},
): NoFollowText | null {
  const r = readBufferNoFollowSync(dir, filePath, opts);
  return r ? { content: r.buffer.toString('utf8'), stat: r.stat } : null;
}
