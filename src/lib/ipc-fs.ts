import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  GroupFsError,
  type FileData,
  type GroupFsErrorCode,
  type PinnedDir,
  forEachLineAtSync,
  lstatAtSync,
  openDirAtSync,
  openTrustedDirSync,
  readFileAtSync,
  removeAtSync,
  splitRelPath,
  writeFileAtSync,
} from './group-fs.js';
import { isPathInside } from './path-containment.js';

/**
 * Descriptor-pinned access to the per-sandbox IPC directories
 * (`DATA_DIR/ipc/<stack>-<inst>/{runs/<runId>,sessions/<key>}`). In the shared
 * single-host layout the agent can write these directories as the board's uid,
 * so any entry (or `runs/<runId>` itself) may be a symlink, FIFO or hardlink.
 * `DATA_DIR/ipc` is the only trusted anchor; everything below it is opened one
 * O_NOFOLLOW segment at a time and used through the pinned descriptor.
 */

/** The only trusted anchor: board-owned, never agent-writable. */
export function ipcRoot(): string {
  return path.join(DATA_DIR, 'ipc');
}

/**
 * Open the directory `absPath` below {@link ipcRoot} without following links.
 * Null when it does not exist; a link anywhere below the anchor throws
 * `GroupFsError('symlink')`, a path outside the anchor (or the anchor itself)
 * `invalid_path`. The caller closes the result.
 */
export function openIpcDirSync(absPath: string): PinnedDir | null {
  const root = ipcRoot();
  const resolved = path.resolve(absPath);
  if (!isPathInside(root, resolved, { allowRoot: false })) {
    throw new GroupFsError(
      'invalid_path',
      `Not inside the IPC root: ${absPath}`,
    );
  }
  const rel = splitRelPath(
    path.relative(root, resolved).split(path.sep).join('/'),
  );
  const anchor = openTrustedDirSync(root);
  if (!anchor) return null;
  try {
    return openDirAtSync(anchor, rel.join('/'));
  } finally {
    anchor.closeSync();
  }
}

/**
 * {@link openIpcDirSync} for an agent-writable run directory: null when it is
 * missing or refused (a link, or a path outside the IPC root); a refusal is
 * logged. The caller closes the result.
 */
export function openIpcDirOrNullSync(absPath: string): PinnedDir | null {
  try {
    return openIpcDirSync(absPath);
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn(
      { hostDir: absPath, code: err.code },
      'Refusing unsafe IPC run dir',
    );
    return null;
  }
}

/** Entry names are single segments: `a/b`, `link/`, `..` and empty are `invalid_path`. */
function assertName(name: string): void {
  if (splitRelPath(name).length !== 1) {
    throw new GroupFsError('invalid_path', `Invalid IPC entry name: ${name}`);
  }
}

// Reasons a read is refused rather than reported as a missing file.
const REFUSED: ReadonlySet<GroupFsErrorCode> = new Set([
  'symlink',
  'not_regular_file',
  'too_large',
  'not_directory',
]);
const MAX_WARNED = 1000;
const warned = new Set<string>();

function warnRefusedOnce(
  label: string,
  name: string,
  reason: string,
  message = 'Refusing unsafe IPC entry',
): void {
  const key = `${label}\0${name}\0${reason}`;
  if (warned.has(key)) return;
  if (warned.size >= MAX_WARNED) warned.clear();
  warned.add(key);
  logger.warn({ dir: label, name, reason }, message);
}

/**
 * Read the regular file `name` of `dir` as UTF-8, at most `maxBytes` (the last
 * `maxBytes` of a longer file with `tail`, else it is refused). Null when
 * it is missing or refused (link, FIFO/device, oversized, swapped directory);
 * refusals are logged once per directory, name and reason.
 */
export function readIpcTextSync(
  dir: PinnedDir,
  name: string,
  maxBytes: number,
  opts: { rejectHardLinks?: boolean; tail?: boolean } = {},
): string | null {
  assertName(name);
  try {
    const read = readFileAtSync(dir, name, { maxBytes, ...opts });
    return read ? read.data.toString('utf8') : null;
  } catch (err) {
    if (err instanceof GroupFsError && REFUSED.has(err.code)) {
      warnRefusedOnce(dir.label, name, err.code);
      return null;
    }
    throw err;
  }
}

/**
 * Stream the lines of the regular file `name` of `dir` (see
 * {@link forEachLineAtSync}). False when it is missing or refused (link,
 * FIFO/device, hard link when asked, shrunk file, swapped directory); refusals
 * are logged once. Oversized lines are skipped and logged once.
 */
export function forEachIpcLineSync(
  dir: PinnedDir,
  name: string,
  opts: { maxLineBytes: number; rejectHardLinks?: boolean },
  onLine: (line: string) => void,
): boolean {
  assertName(name);
  try {
    return forEachLineAtSync(
      dir,
      name,
      {
        ...opts,
        onOversizeLine: () =>
          warnRefusedOnce(
            dir.label,
            name,
            'oversized_line',
            'Skipping oversized IPC line',
          ),
      },
      onLine,
    );
  } catch (err) {
    if (err instanceof GroupFsError && REFUSED.has(err.code)) {
      warnRefusedOnce(dir.label, name, err.code);
      return false;
    }
    throw err;
  }
}

/**
 * Atomically write `name` in `dir` (temp file + rename in the pinned
 * directory): a planted leaf link or hardlink is replaced, never written through.
 */
export function writeIpcFileSync(
  dir: PinnedDir,
  name: string,
  data: FileData,
): void {
  assertName(name);
  writeFileAtSync(dir, name, data);
}

/** Recursively remove `name` below the IPC directory `parentAbs`; false when missing. */
export function removeIpcTreeSync(parentAbs: string, name: string): boolean {
  assertName(name);
  const parent = openIpcDirSync(parentAbs);
  if (!parent) return false;
  try {
    return removeAtSync(parent, name, { recursive: true });
  } finally {
    parent.closeSync();
  }
}

/**
 * Remove the IPC run directory `dir` (a link is unlinked, never followed).
 * A missing dir, or a refused path (a link above `dir`, or a path outside the
 * IPC root), is logged once at warn and reported as false.
 */
export function removeIpcDirSync(dir: string): boolean {
  try {
    const removed = removeIpcTreeSync(path.dirname(dir), path.basename(dir));
    if (!removed) {
      warnRefusedOnce(dir, '', 'missing', 'IPC directory already removed');
    }
    return removed;
  } catch (err) {
    if (err instanceof GroupFsError) {
      warnRefusedOnce(dir, '', err.code);
      return false;
    }
    throw err;
  }
}

/** True when `name` exists in `dir`; a link counts as existing and is never followed. */
export function existsIpcEntrySync(dir: PinnedDir, name: string): boolean {
  assertName(name);
  return lstatAtSync(dir, name) !== null;
}

/** A pid file value: ASCII digits only (after trimming), nothing a shell could interpret. */
export function isNumericPid(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}
