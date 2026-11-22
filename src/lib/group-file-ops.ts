/**
 * Owner-only rename / move / delete of files and folders in a project's group
 * folder. Every filesystem step goes through the pinned-directory helpers of
 * `group-fs.ts`: no link is ever followed and a link anywhere on a path is
 * refused. Authorization (owner/admin) is the caller's job.
 */

import path from 'node:path';

import { getGroupDir } from '../group-dir.js';
import { withTargetReplacementLock } from './editable-local-file.js';
import { isSafeRelativePath } from './file-content.js';
import {
  GroupFsError,
  lstatAt,
  openDirAt,
  openGroupDir,
  readdirAt,
  removeAt,
  renameNoReplaceAt,
  splitRelPath,
} from './group-fs.js';
import type { PinnedDir } from './group-fs.js';

/**
 * Paths the board itself reads or writes. `root` entries sit directly in the
 * group folder; `objective` entries sit inside `objectives/<id>/`. A protected
 * entry is protected with everything below it, except the containers
 * `artifacts`, `objectives` and `objectives/<id>`, which are protected only as
 * themselves (`artifacts` may still receive moves; its contents stay editable).
 */
export const PROTECTED_GROUP_PATHS = {
  root: [
    '.agent',
    '.agents',
    '.claude',
    '.codex',
    '.gemini',
    '.pi',
    '.omp',
    '.carapa',
    'AGENTS.md',
    'AGENTS.override.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.mcp.json',
    'opencode.json',
    'queue.json',
    'session-log.jsonl',
    'transcripts',
    'session-transcripts',
    'logs',
    'recordings',
    'objectives',
    'artifacts',
  ],
  objective: [
    '.agent',
    '.agents',
    '.claude',
    'state.json',
    'events.jsonl',
    'decisions.jsonl',
    'dashboard',
    // Written by the board next to the brain-owned files.
    'run-stats.jsonl',
    'board-cost-metrics.json',
    'board-cost-report.json',
    'board-brain-state-events.json',
  ],
} as const;

const PROTECTED_PATH_MESSAGE =
  'This path is managed by the board and cannot be renamed, moved or deleted';

/** Maximum removed paths echoed back when a folder delete stops partway. */
const MAX_REPORTED_REMOVED = 100;

/** A refusal with the HTTP status the route should answer with. */
export class GroupFileOpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GroupFileOpError';
  }
}

export interface GroupFileOpResult {
  /** Group-relative path after the operation (the removed path for delete). */
  path: string;
  /** Previous path (rename/move). */
  from?: string;
  /** Whether the change touched `artifacts/` (selects the broadcast event). */
  artifacts: boolean;
  /** Entries removed by a delete. */
  removedCount?: number;
}

export interface GroupFileOpOptions {
  /** Extra root entries to protect, e.g. nested child project folders. */
  extraProtectedRoot?: readonly string[];
  /**
   * Called with the group-relative source and target after every check passed
   * (the target was free), right before a rename/move touches the filesystem. A
   * rejection aborts the change untouched.
   */
  beforeMove?: (from: string, to: string) => Promise<void>;
}

const SYMLINK_MESSAGE = 'Symbolic links cannot be changed or traversed';

const bad = (message: string) => new GroupFileOpError(400, message);

function parseRelPath(raw: unknown, what: string): string[] {
  if (!isSafeRelativePath(raw)) throw bad(`Invalid ${what}`);
  try {
    return splitRelPath(raw);
  } catch {
    throw bad(`Invalid ${what}`);
  }
}

function isProtected(
  segments: string[],
  role: 'source' | 'destination',
  extraRoot: readonly string[],
): boolean {
  const [top, , third] = segments;
  if (top === 'artifacts') return segments.length === 1 && role === 'source';
  if (top === 'objectives') {
    return (
      segments.length <= 2 ||
      (PROTECTED_GROUP_PATHS.objective as readonly string[]).includes(third)
    );
  }
  return (
    (PROTECTED_GROUP_PATHS.root as readonly string[]).includes(top) ||
    extraRoot.includes(top)
  );
}

function assertUnprotected(
  segments: string[],
  role: 'source' | 'destination',
  opts: GroupFileOpOptions,
): void {
  if (
    segments.length > 0 &&
    isProtected(segments, role, opts.extraProtectedRoot ?? [])
  ) {
    throw new GroupFileOpError(403, PROTECTED_PATH_MESSAGE);
  }
}

function mapFsError(err: unknown): GroupFileOpError {
  if (err instanceof GroupFileOpError) return err;
  if (err instanceof GroupFsError) {
    if (err.code === 'symlink')
      return new GroupFileOpError(403, SYMLINK_MESSAGE);
    if (err.code === 'invalid_path') return bad('Invalid path');
    if (err.code === 'not_found')
      return new GroupFileOpError(404, 'Path not found');
    if (err.code === 'not_directory') return bad('Not a directory');
  }
  return new GroupFileOpError(500, 'Filesystem operation failed');
}

async function withGroupRoot<T>(
  folder: string,
  fn: (root: PinnedDir) => Promise<T>,
): Promise<T> {
  let root: PinnedDir | null;
  try {
    root = await openGroupDir(folder);
  } catch (err) {
    throw mapFsError(err);
  }
  if (!root) throw new GroupFileOpError(404, 'Project folder not found');
  try {
    return await fn(root);
  } catch (err) {
    throw mapFsError(err);
  } finally {
    await root.close();
  }
}

/** lstat without following links; null when missing (or below a file). */
const lstatOrNull = (root: PinnedDir, segments: string[]) =>
  lstatAt(root, segments.join('/')).catch((err) => {
    if (err instanceof GroupFsError && err.code === 'not_directory')
      return null;
    throw err;
  });

/** lstat of the source: 404 when missing (or below a file), 403 for a link. */
async function statSource(root: PinnedDir, segments: string[]) {
  const stat = await lstatOrNull(root, segments);
  if (!stat) throw new GroupFileOpError(404, 'Path not found');
  if (stat.isSymbolicLink()) throw new GroupFileOpError(403, SYMLINK_MESSAGE);
  return stat;
}

async function renameChecked(
  root: PinnedDir,
  source: string[],
  target: string[],
  opts: GroupFileOpOptions,
): Promise<void> {
  await statSource(root, source);
  // A link at the target is refused like any other link; lstat never follows it.
  const existing = await lstatAt(root, target.join('/'));
  if (existing?.isSymbolicLink())
    throw new GroupFileOpError(403, SYMLINK_MESSAGE);
  // Checked before beforeMove, so a recorded move always had a free target.
  if (existing)
    throw new GroupFileOpError(409, 'A file or folder with that name exists');
  await opts.beforeMove?.(source.join('/'), target.join('/'));
  try {
    // Atomic: a target created after the lstat above still gives `exists`.
    await renameNoReplaceAt(root, source.join('/'), root, target.join('/'));
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'exists')
      throw new GroupFileOpError(409, 'A file or folder with that name exists');
    throw err;
  }
}

/**
 * Hold the editor-save lock of every given path (sorted, so two callers never
 * deadlock): a save cannot interleave with the rename of its file.
 */
function withPathLocks<T>(
  folder: string,
  paths: string[][],
  op: () => Promise<T>,
): Promise<T> {
  const keys = [
    ...new Set(paths.map((p) => path.join(getGroupDir(folder), ...p))),
  ].sort();
  const run = (i: number): Promise<T> =>
    i === keys.length
      ? op()
      : withTargetReplacementLock(keys[i], () => run(i + 1));
  return run(0);
}

const touchesArtifacts = (...paths: string[][]) =>
  paths.some((segments) => segments[0] === 'artifacts');

/** Rename `rawPath` in place to `rawName` (same parent). */
export async function renameGroupPath(
  folder: string,
  rawPath: unknown,
  rawName: unknown,
  opts: GroupFileOpOptions = {},
): Promise<GroupFileOpResult> {
  const source = parseRelPath(rawPath, 'path');
  let name: string[];
  try {
    if (typeof rawName !== 'string') throw new Error('not a string');
    name = splitRelPath(rawName);
    if (name.length !== 1) throw new Error('not a single segment');
  } catch {
    throw bad('newName must be a single file or folder name');
  }
  const target = [...source.slice(0, -1), name[0]];
  assertUnprotected(source, 'source', opts);
  assertUnprotected(target, 'source', opts);
  await withPathLocks(folder, [source, target], () =>
    withGroupRoot(folder, (root) => renameChecked(root, source, target, opts)),
  );
  return {
    path: target.join('/'),
    from: source.join('/'),
    artifacts: touchesArtifacts(source),
  };
}

/** Move `rawPath` into the folder `rawDestination` ('' = group root), keeping its name. */
export async function moveGroupPath(
  folder: string,
  rawPath: unknown,
  rawDestination: unknown,
  opts: GroupFileOpOptions = {},
): Promise<GroupFileOpResult> {
  const source = parseRelPath(rawPath, 'path');
  if (typeof rawDestination !== 'string') throw bad('Invalid destination');
  const destination =
    rawDestination === '' ? [] : parseRelPath(rawDestination, 'destination');
  const target = [...destination, source[source.length - 1]];
  if (
    destination.length >= source.length &&
    source.every((segment, i) => destination[i] === segment)
  )
    throw bad('A folder cannot be moved into itself');
  assertUnprotected(source, 'source', opts);
  assertUnprotected(destination, 'destination', opts);
  assertUnprotected(target, 'source', opts);
  await withPathLocks(folder, [source, target], () =>
    withGroupRoot(folder, async (root) => {
      if (destination.length > 0) {
        // Pinned without following links; a missing or non-directory target fails.
        const dir = await openDirAt(root, destination.join('/'));
        if (!dir)
          throw new GroupFileOpError(404, 'Destination folder not found');
        await dir.close();
      }
      await renameChecked(root, source, target, opts);
    }),
  );
  return {
    path: target.join('/'),
    from: source.join('/'),
    artifacts: touchesArtifacts(source, target),
  };
}

interface Removal {
  /** Paths already gone, so a failure can report them (capped). */
  removed: string[];
  count: { n: number };
}

/**
 * Walk everything below `dir` depth first and refuse any symlink (403, like a
 * symlink named directly). With `removal` the entries are also deleted and the
 * walk stops at the first error; without it nothing is changed (pre-check).
 */
async function walkChildren(
  dir: PinnedDir,
  prefix: string,
  removal?: Removal,
): Promise<void> {
  for (const name of (await readdirAt(dir)) ?? []) {
    const rel = `${prefix}/${name}`;
    const stat = await lstatAt(dir, name);
    if (!stat) continue;
    if (stat.isSymbolicLink())
      throw new GroupFileOpError(403, `${SYMLINK_MESSAGE}: ${rel}`);
    if (stat.isDirectory()) {
      const sub = await openDirAt(dir, name);
      if (!sub) continue;
      try {
        await walkChildren(sub, rel, removal);
      } finally {
        await sub.close();
      }
    }
    if (removal && (await removeAt(dir, name))) {
      removal.count.n++;
      if (removal.removed.length < MAX_REPORTED_REMOVED)
        removal.removed.push(rel);
    }
  }
}

/** Delete a file, or a folder recursively. A folder delete fails closed. */
export async function deleteGroupPath(
  folder: string,
  rawPath: unknown,
  opts: GroupFileOpOptions = {},
): Promise<GroupFileOpResult> {
  const source = parseRelPath(rawPath, 'path');
  assertUnprotected(source, 'source', opts);
  const rel = source.join('/');
  const count = { n: 0 };
  const removed: string[] = [];
  await withGroupRoot(folder, async (root) => {
    const stat = await statSource(root, source);
    if (!stat.isDirectory()) {
      await removeAt(root, rel);
      count.n = 1;
      return;
    }
    const dir = await openDirAt(root, rel);
    if (!dir) throw new GroupFileOpError(404, 'Path not found');
    try {
      // Refuse a tree holding a link before anything is removed.
      await walkChildren(dir, rel);
      try {
        await walkChildren(dir, rel, { removed, count });
        await removeAt(root, rel);
        count.n++;
      } catch (err) {
        throw new GroupFileOpError(
          500,
          `Delete stopped after an error; ${count.n} entries were removed`,
          {
            removedCount: count.n,
            removed,
            artifacts: source[0] === 'artifacts',
            cause: mapFsError(err).message,
          },
        );
      }
    } finally {
      await dir.close();
    }
  });
  return {
    path: rel,
    artifacts: touchesArtifacts(source),
    removedCount: count.n,
  };
}

/** Canonical group-relative form of a client path; throws a 400 when invalid. */
export function normalizeGroupPath(rawPath: unknown): string {
  return parseRelPath(rawPath, 'path').join('/');
}

/**
 * Check that `rawPath` names an existing regular file the board does not
 * manage (the same protected paths and link refusals as rename/move/delete).
 * Returns the canonical path; refusals throw a GroupFileOpError.
 */
export async function resolveGroupFile(
  folder: string,
  rawPath: unknown,
  opts: GroupFileOpOptions = {},
): Promise<string> {
  const segments = parseRelPath(rawPath, 'path');
  assertUnprotected(segments, 'source', opts);
  await withGroupRoot(folder, async (root) => {
    if (!(await statSource(root, segments)).isFile())
      throw bad('Only files can be used here');
  });
  return segments.join('/');
}

/**
 * Whether `rel` exists: true/false when verified, null on any doubt (unreadable
 * folder, a link on the path, I/O error).
 */
export async function probeGroupPath(
  folder: string,
  rel: string,
): Promise<boolean | null> {
  try {
    return await withGroupRoot(
      folder,
      async (root) => !!(await lstatOrNull(root, splitRelPath(rel))),
    );
  } catch {
    return null;
  }
}

/** True only when `rel` is verifiably gone; any doubt answers false. */
export async function groupPathIsMissing(
  folder: string,
  rel: string,
): Promise<boolean> {
  return (await probeGroupPath(folder, rel)) === false;
}
