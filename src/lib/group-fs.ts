/**
 * Race-free reads and writes inside agent-writable group folders.
 *
 * A sandbox agent can write `groups/<folder>/` (and, for a shared owner, the
 * whole subtree below it), so it can swap any directory in there for a symlink
 * at any moment. Checking a path (realpath, lstat, prefix test) and then using
 * the same path later is therefore not safe: the swap wins between the two.
 *
 * Instead every directory below the group root is opened one segment at a time
 * with O_NOFOLLOW, and every later operation names its target through the open
 * descriptor (`/proc/self/fd/<fd>/<name>`). The descriptor keeps pointing at
 * the verified inode whatever happens to the original path afterwards.
 *
 * Linux only: without `/proc/self/fd` every function fails closed with
 * `GroupFsError('unsupported')`.
 *
 * Directory segments are opened with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and
 * then checked with fstat, NOT with O_DIRECTORY: on gVisor kernels
 * `O_DIRECTORY | O_NOFOLLOW` follows a symlink to a directory (real Linux
 * answers ENOTDIR), which would defeat the whole scheme.
 *
 * Relative links that the board itself creates (`.claude -> .agent`,
 * `.claude/rules -> ../.agent/rules`, `CLAUDE.md -> AGENTS.md`) can be followed
 * with `followInternalLinks`: the target is read with readlink on the pinned
 * parent, must be relative and stay lexically inside the base directory, and
 * the substituted path is walked again from the base with the same
 * per-segment O_NOFOLLOW. Links at a leaf are resolved against the pinned
 * parent directory, so they cannot leave it.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Response } from 'express';

import { GROUPS_DIR } from '../config.js';
import { isPathInside } from './path-containment.js';
import { getGroupDir } from '../group-dir.js';
import { logger } from '../logger.js';

export type GroupFsErrorCode =
  | 'not_found'
  | 'symlink'
  | 'not_directory'
  | 'not_regular_file'
  | 'too_large'
  | 'invalid_path'
  /** A chunk offset lies beyond the existing local prefix; nothing was written. */
  | 'short_prefix'
  /** The destination of a no-replace rename already exists. */
  | 'exists'
  | 'unsupported'
  /** Any other failure (EACCES, EIO, ...); `errno` carries the system code. */
  | 'io';

export class GroupFsError extends Error {
  constructor(
    readonly code: GroupFsErrorCode,
    message: string,
    /** System error code (e.g. `EACCES`) when the failure came from the OS. */
    readonly errno?: string,
  ) {
    super(message);
    this.name = 'GroupFsError';
  }
}

/**
 * Test seams, honoured only when `NODE_ENV === 'test'`.
 * `beforeOpen` runs before every directory and leaf open with the label of the
 * directory being opened from and the segment name. Sync entry points call it
 * without awaiting.
 */
export const groupFsTestHooks: {
  beforeOpen?: (label: string, segment: string) => void | Promise<void>;
  /** Behave as if the platform check failed. */
  forceUnsupported?: boolean;
} = {};

const isTestEnv = (): boolean => process.env.NODE_ENV === 'test';

const platformSupported =
  process.platform === 'linux' && fs.existsSync('/proc/self/fd');

function assertSupported(): void {
  if (
    !platformSupported ||
    (isTestEnv() && groupFsTestHooks.forceUnsupported)
  ) {
    throw new GroupFsError(
      'unsupported',
      'Group file access needs Linux with /proc/self/fd',
    );
  }
}

async function runHook(label: string, segment: string): Promise<void> {
  if (isTestEnv()) await groupFsTestHooks.beforeOpen?.(label, segment);
}

function runHookSync(label: string, segment: string): void {
  if (isTestEnv()) void groupFsTestHooks.beforeOpen?.(label, segment);
}

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
const DIR_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const FILE_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const MAX_LINK_SUBSTITUTIONS = 8;

const openFd = promisify(fs.open);
const closeFd = promisify(fs.close);
const fstatFd = promisify(fs.fstat);

function isValidSegment(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function assertSegment(name: string): void {
  if (!isValidSegment(name)) {
    throw new GroupFsError('invalid_path', `Invalid path segment: ${name}`);
  }
}

/** Split a relative path into validated segments (no `.`, `..`, empty, NUL, `\`, absolute). */
export function splitRelPath(rel: string): string[] {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/')) {
    throw new GroupFsError('invalid_path', `Invalid relative path: ${rel}`);
  }
  const segments = rel.split('/');
  for (const segment of segments) assertSegment(segment);
  return segments;
}

/** A directory held open by descriptor. Always close it (also on error paths). */
export class PinnedDir {
  #closed = false;

  constructor(
    readonly fd: number,
    /** Human-readable path, for logs and test hooks only. Never used to open anything. */
    readonly label: string,
  ) {}

  /**
   * Path of ONE child of this directory. `/proc/self/fd/<fd>/a/b` follows
   * links in `a`, so multi-segment entries are forbidden: walk with
   * openDirAt() instead and take the entry from the pinned parent.
   */
  entry(name: string): string {
    assertSegment(name);
    return `${this.self()}/${name}`;
  }

  /** Path naming this very directory through its descriptor. */
  self(): string {
    if (this.#closed) throw new Error(`PinnedDir is closed: ${this.label}`);
    return `/proc/self/fd/${this.fd}`;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await closeFd(this.fd).catch(() => {});
  }

  closeSync(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* best effort */
    }
  }
}

export interface WalkOptions {
  /** Create missing directories (mkdir one pinned entry at a time). */
  create?: boolean;
  /** Follow relative links that stay inside the base directory. */
  followInternalLinks?: boolean;
}

export interface FileReadOptions {
  maxBytes: number;
  /** For an oversized file, return its last `maxBytes` bytes instead of failing. */
  tail?: boolean;
  followInternalLinks?: boolean;
  /** Refuse a file that has another name (a hard link planted from elsewhere). */
  rejectHardLinks?: boolean;
}

export interface FileRead {
  data: Buffer;
  stat: fs.Stats;
}

const errnoOf = (err: unknown): string | undefined =>
  (err as NodeJS.ErrnoException | null)?.code;

function mapError(err: unknown, what: string): GroupFsError {
  if (err instanceof GroupFsError) return err;
  const code = errnoOf(err);
  const detail = `${what}: ${code ?? String(err)}`;
  if (code === 'ELOOP') return new GroupFsError('symlink', detail, code);
  if (code === 'ENOTDIR')
    return new GroupFsError('not_directory', detail, code);
  if (code === 'ENXIO' || code === 'EISDIR') {
    return new GroupFsError('not_regular_file', detail, code);
  }
  return new GroupFsError('io', detail, code);
}

interface LinkBudget {
  n: number;
}

/**
 * Replace segment `index` of `segments` by the (relative, in-base) link
 * `target`, resolved lexically against the segments before it.
 */
function substituteLink(
  segments: string[],
  index: number,
  target: string,
  budget: LinkBudget,
): string[] {
  const refuse = (why: string) =>
    new GroupFsError(
      'symlink',
      `Refusing link "${segments.join('/')}": ${why}`,
    );
  if (++budget.n > MAX_LINK_SUBSTITUTIONS) throw refuse('too many links');
  if (target === '' || target.startsWith('/')) throw refuse('not relative');
  const out = segments.slice(0, index);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) throw refuse('leaves the base directory');
      out.pop();
    } else if (isValidSegment(part)) {
      out.push(part);
    } else {
      throw refuse('invalid target');
    }
  }
  if (out.length === 0) throw refuse('resolves to the base directory');
  return out.concat(segments.slice(index + 1));
}

/** Target of the symlink `parent/name` after an open failed with ELOOP/ENOTDIR; else throws. */
async function linkTarget(
  parent: PinnedDir,
  name: string,
  openErr: unknown,
): Promise<string> {
  const what = path.join(parent.label, name);
  const code = errnoOf(openErr);
  if (code !== 'ELOOP' && code !== 'ENOTDIR') throw mapError(openErr, what);
  try {
    return await fsp.readlink(parent.entry(name));
  } catch (err) {
    // EINVAL: the entry exists and is not a symlink; report the open error.
    if (errnoOf(err) === 'EINVAL') throw mapError(openErr, what);
    throw mapError(err, what);
  }
}

function linkTargetSync(
  parent: PinnedDir,
  name: string,
  openErr: unknown,
): string {
  const what = path.join(parent.label, name);
  const code = errnoOf(openErr);
  if (code !== 'ELOOP' && code !== 'ENOTDIR') throw mapError(openErr, what);
  try {
    return fs.readlinkSync(parent.entry(name));
  } catch (err) {
    // EINVAL: the entry exists and is not a symlink; report the open error.
    if (errnoOf(err) === 'EINVAL') throw mapError(openErr, what);
    throw mapError(err, what);
  }
}

function refuseLink(parent: PinnedDir, name: string): GroupFsError {
  return new GroupFsError(
    'symlink',
    `Refusing symlink: ${path.join(parent.label, name)}`,
    'ELOOP',
  );
}

function notDirectory(label: string): GroupFsError {
  return new GroupFsError('not_directory', `Not a directory: ${label}`);
}

/** Open the child directory `name` of `cur`; null when missing and not created. */
async function stepDir(
  cur: PinnedDir,
  name: string,
  opts: WalkOptions,
): Promise<PinnedDir | null> {
  let fd: number;
  try {
    await runHook(cur.label, name);
    fd = await openFd(cur.entry(name), DIR_FLAGS);
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err;
    if (!opts.create) return null;
    await fsp.mkdir(cur.entry(name)).catch((e: unknown) => {
      if (errnoOf(e) !== 'EEXIST') throw e;
    });
    try {
      await runHook(cur.label, name);
      fd = await openFd(cur.entry(name), DIR_FLAGS);
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return null;
      throw e;
    }
  }
  const label = path.join(cur.label, name);
  const isDir = await fstatFd(fd)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!isDir) {
    await closeFd(fd).catch(() => {});
    throw notDirectory(label);
  }
  return new PinnedDir(fd, label);
}

function stepDirSync(
  cur: PinnedDir,
  name: string,
  opts: WalkOptions,
): PinnedDir | null {
  let fd: number;
  try {
    runHookSync(cur.label, name);
    fd = fs.openSync(cur.entry(name), DIR_FLAGS);
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err;
    if (!opts.create) return null;
    try {
      fs.mkdirSync(cur.entry(name));
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') throw e;
    }
    try {
      runHookSync(cur.label, name);
      fd = fs.openSync(cur.entry(name), DIR_FLAGS);
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return null;
      throw e;
    }
  }
  const label = path.join(cur.label, name);
  let isDir = false;
  try {
    isDir = fs.fstatSync(fd).isDirectory();
  } catch {
    /* treated as not a directory */
  }
  if (!isDir) {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
    throw notDirectory(label);
  }
  return new PinnedDir(fd, label);
}

interface Resolved {
  parent: PinnedDir;
  name: string;
  /** The segment list actually walked (after link substitutions). */
  segments: string[];
  release: () => Promise<void>;
}

interface ResolvedSync extends Omit<Resolved, 'release'> {
  release: () => void;
}

/** Open every directory of `segments` but the last; the result's parent holds the leaf. */
async function resolveParent(
  base: PinnedDir,
  segments: string[],
  opts: WalkOptions,
  budget: LinkBudget,
): Promise<Resolved | null> {
  let list = segments;
  let cur = base;
  let owned = false;
  try {
    for (let i = 0; i < list.length - 1; i++) {
      const name = list[i];
      let next: PinnedDir | null;
      try {
        next = await stepDir(cur, name, opts);
      } catch (err) {
        const target = await linkTarget(cur, name, err);
        if (!opts.followInternalLinks) throw refuseLink(cur, name);
        list = substituteLink(list, i, target, budget);
        if (owned) await cur.close();
        cur = base;
        owned = false;
        i = -1;
        continue;
      }
      if (!next) return null;
      if (owned) await cur.close();
      cur = next;
      owned = true;
    }
    const parent = cur;
    const release = owned ? () => parent.close() : async () => {};
    owned = false;
    return {
      parent,
      name: list[list.length - 1],
      segments: list,
      release,
    };
  } finally {
    if (owned) await cur.close();
  }
}

function resolveParentSync(
  base: PinnedDir,
  segments: string[],
  opts: WalkOptions,
  budget: LinkBudget,
): ResolvedSync | null {
  let list = segments;
  let cur = base;
  let owned = false;
  try {
    for (let i = 0; i < list.length - 1; i++) {
      const name = list[i];
      let next: PinnedDir | null;
      try {
        next = stepDirSync(cur, name, opts);
      } catch (err) {
        const target = linkTargetSync(cur, name, err);
        if (!opts.followInternalLinks) throw refuseLink(cur, name);
        list = substituteLink(list, i, target, budget);
        if (owned) cur.closeSync();
        cur = base;
        owned = false;
        i = -1;
        continue;
      }
      if (!next) return null;
      if (owned) cur.closeSync();
      cur = next;
      owned = true;
    }
    const parent = cur;
    const release = owned ? () => parent.closeSync() : () => {};
    owned = false;
    return {
      parent,
      name: list[list.length - 1],
      segments: list,
      release,
    };
  } finally {
    if (owned) cur.closeSync();
  }
}

/**
 * Resolve the parent of the last segment of `rel`, then run `op` on the leaf.
 * `op` may throw raw errors: ENOENT gives null, a leaf symlink is followed or
 * refused as for directories, anything else becomes a GroupFsError.
 */
async function withLeaf<T>(
  base: PinnedDir,
  rel: string,
  opts: WalkOptions,
  op: (parent: PinnedDir, name: string) => Promise<T | null>,
): Promise<T | null> {
  let segments = splitRelPath(rel);
  const budget: LinkBudget = { n: 0 };
  for (;;) {
    const resolved = await resolveParent(base, segments, opts, budget);
    if (!resolved) return null;
    const { parent, name } = resolved;
    try {
      return await op(parent, name);
    } catch (err) {
      if (err instanceof GroupFsError) throw err;
      if (errnoOf(err) === 'ENOENT') return null;
      const target = await linkTarget(parent, name, err);
      if (!opts.followInternalLinks) throw refuseLink(parent, name);
      segments = substituteLink(
        resolved.segments,
        resolved.segments.length - 1,
        target,
        budget,
      );
    } finally {
      await resolved.release();
    }
  }
}

function withLeafSync<T>(
  base: PinnedDir,
  rel: string,
  opts: WalkOptions,
  op: (parent: PinnedDir, name: string) => T | null,
): T | null {
  let segments = splitRelPath(rel);
  const budget: LinkBudget = { n: 0 };
  for (;;) {
    const resolved = resolveParentSync(base, segments, opts, budget);
    if (!resolved) return null;
    const { parent, name } = resolved;
    try {
      return op(parent, name);
    } catch (err) {
      if (err instanceof GroupFsError) throw err;
      if (errnoOf(err) === 'ENOENT') return null;
      const target = linkTargetSync(parent, name, err);
      if (!opts.followInternalLinks) throw refuseLink(parent, name);
      segments = substituteLink(
        resolved.segments,
        resolved.segments.length - 1,
        target,
        budget,
      );
    } finally {
      resolved.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Opening directories
// ---------------------------------------------------------------------------

/**
 * Open a board-owned anchor (GROUPS_DIR, a board temp dir). Unlike every other
 * open here this follows links, so the anchor may be a deployment symlink: only
 * pass paths the agent cannot write. Null when it does not exist.
 */
export async function openTrustedDir(abs: string): Promise<PinnedDir | null> {
  assertSupported();
  try {
    await runHook(path.dirname(abs), path.basename(abs));
    const fd = await openFd(abs, O_RDONLY | O_DIRECTORY);
    return new PinnedDir(fd, abs);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return null;
    throw mapError(err, abs);
  }
}

export function openTrustedDirSync(abs: string): PinnedDir | null {
  assertSupported();
  try {
    runHookSync(path.dirname(abs), path.basename(abs));
    const fd = fs.openSync(abs, O_RDONLY | O_DIRECTORY);
    return new PinnedDir(fd, abs);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return null;
    throw mapError(err, abs);
  }
}

/** Open directory `rel` below `base`, one O_NOFOLLOW segment at a time. Caller closes. */
export async function openDirAt(
  base: PinnedDir,
  rel: string,
  opts: WalkOptions = {},
): Promise<PinnedDir | null> {
  assertSupported();
  return withLeaf(base, rel, opts, (parent, name) =>
    stepDir(parent, name, opts),
  );
}

export function openDirAtSync(
  base: PinnedDir,
  rel: string,
  opts: WalkOptions = {},
): PinnedDir | null {
  assertSupported();
  return withLeafSync(base, rel, opts, (parent, name) =>
    stepDirSync(parent, name, opts),
  );
}

const warnedGroupFolders = new Set<string>();

function warnSymlinkedGroup(folder: string): void {
  if (warnedGroupFolders.has(folder)) return;
  warnedGroupFolders.add(folder);
  logger.warn(
    { folder },
    'Refusing symlinked group folder: group folders must be real directories',
  );
}

/** Path segments from GROUPS_DIR to the group's directory (nested children have two). */
function groupRootSegments(folder: string): string[] {
  const dir = getGroupDir(folder);
  if (!isPathInside(GROUPS_DIR, dir, { allowRoot: false })) {
    throw new GroupFsError('invalid_path', `Invalid group folder: ${folder}`);
  }
  const rel = path.relative(GROUPS_DIR, dir);
  return splitRelPath(rel.split(path.sep).join('/'));
}

/**
 * Walk GROUPS_DIR -> group root without following links; warns once per
 * symlinked folder. With `create`, a missing group root is created.
 */
async function openGroupRoot(
  rootSegments: string[],
  create = false,
): Promise<PinnedDir | null> {
  // The groups directory is board-owned: a first write may have to create it.
  if (create) await fsp.mkdir(GROUPS_DIR, { recursive: true });
  const anchor = await openTrustedDir(GROUPS_DIR);
  if (!anchor) return null;
  try {
    return await openDirAt(anchor, rootSegments.join('/'), { create });
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'symlink') {
      warnSymlinkedGroup(rootSegments.join('/'));
    }
    throw err;
  } finally {
    await anchor.close();
  }
}

function openGroupRootSync(
  rootSegments: string[],
  create = false,
): PinnedDir | null {
  if (create) fs.mkdirSync(GROUPS_DIR, { recursive: true });
  const anchor = openTrustedDirSync(GROUPS_DIR);
  if (!anchor) return null;
  try {
    return openDirAtSync(anchor, rootSegments.join('/'), { create });
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'symlink') {
      warnSymlinkedGroup(rootSegments.join('/'));
    }
    throw err;
  } finally {
    anchor.closeSync();
  }
}

/**
 * Open a group's directory (and optionally `sub` below it, with the group root
 * as the base for links). The group root itself is never reached through a link.
 * `opts.create` also creates a missing group root.
 */
export async function openGroupDir(
  folder: string,
  sub?: string,
  opts: WalkOptions = {},
): Promise<PinnedDir | null> {
  assertSupported();
  const root = await openGroupRoot(groupRootSegments(folder), opts.create);
  if (!root || sub === undefined) return root;
  try {
    return await openDirAt(root, sub, opts);
  } finally {
    await root.close();
  }
}

export function openGroupDirSync(
  folder: string,
  sub?: string,
  opts: WalkOptions = {},
): PinnedDir | null {
  assertSupported();
  const root = openGroupRootSync(groupRootSegments(folder), opts.create);
  if (!root || sub === undefined) return root;
  try {
    return openDirAtSync(root, sub, opts);
  } finally {
    root.closeSync();
  }
}

/**
 * Open a group directory given by absolute path. Under GROUPS_DIR the walk from
 * GROUPS_DIR never follows a link (a symlinked group folder is refused);
 * elsewhere (board temp dirs, tests) the directory is a trusted anchor.
 */
export async function openGroupDirAbs(
  absDir: string,
): Promise<PinnedDir | null> {
  assertSupported();
  const resolved = path.resolve(absDir);
  const rel = path.relative(GROUPS_DIR, resolved);
  const inside = isPathInside(GROUPS_DIR, resolved, { allowRoot: false });
  if (!inside) return openTrustedDir(resolved);
  return openGroupRoot(splitRelPath(rel.split(path.sep).join('/')));
}

interface ParentSplit {
  /** Segments from GROUPS_DIR to the group root; empty when outside or directly in GROUPS_DIR. */
  rootSegments: string[];
  /** Segments below the group root up to the file's parent. */
  rest: string[];
  name: string;
  /** Set when the path is not under GROUPS_DIR: pin this directory as a trusted anchor. */
  trusted?: string;
}

function splitParent(absPath: string): ParentSplit {
  const resolved = path.resolve(absPath);
  const name = path.basename(resolved);
  assertSegment(name);
  const rel = path.relative(GROUPS_DIR, resolved);
  const inside = isPathInside(GROUPS_DIR, resolved, { allowRoot: false });
  if (!inside) {
    return {
      rootSegments: [],
      rest: [],
      name,
      trusted: path.dirname(resolved),
    };
  }
  const parentParts = rel.split(path.sep).slice(0, -1);
  if (parentParts.length === 0) {
    return { rootSegments: [], rest: [], name, trusted: GROUPS_DIR };
  }
  // A nested child lives at GROUPS_DIR/<parent>/<child>; its folder is a root of its own.
  const nested =
    parentParts.length >= 2 &&
    getGroupDir(parentParts[1]) ===
      path.join(GROUPS_DIR, parentParts[0], parentParts[1]);
  const rootLength = nested ? 2 : 1;
  return {
    rootSegments: parentParts.slice(0, rootLength),
    rest: parentParts.slice(rootLength),
    name,
  };
}

/**
 * Pin the directory that contains `absPath` and return it with the file name.
 * Under GROUPS_DIR the group root is walked without links and the rest with
 * `opts`; elsewhere the dirname is pinned as a trusted anchor (board-owned
 * dirs, test temp dirs). Null when the directory does not exist; with
 * `opts.create` a missing group root and the directories below it are created.
 */
export async function openParentDir(
  absPath: string,
  opts: WalkOptions = {},
): Promise<{ dir: PinnedDir; name: string } | null> {
  assertSupported();
  const split = splitParent(absPath);
  if (split.trusted !== undefined) {
    const dir = await openTrustedDir(split.trusted);
    return dir ? { dir, name: split.name } : null;
  }
  const root = await openGroupRoot(split.rootSegments, opts.create);
  if (!root) return null;
  if (split.rest.length === 0) return { dir: root, name: split.name };
  try {
    const dir = await openDirAt(root, split.rest.join('/'), opts);
    return dir ? { dir, name: split.name } : null;
  } finally {
    await root.close();
  }
}

export function openParentDirSync(
  absPath: string,
  opts: WalkOptions = {},
): { dir: PinnedDir; name: string } | null {
  assertSupported();
  const split = splitParent(absPath);
  if (split.trusted !== undefined) {
    const dir = openTrustedDirSync(split.trusted);
    return dir ? { dir, name: split.name } : null;
  }
  const root = openGroupRootSync(split.rootSegments, opts.create);
  if (!root) return null;
  if (split.rest.length === 0) return { dir: root, name: split.name };
  try {
    const dir = openDirAtSync(root, split.rest.join('/'), opts);
    return dir ? { dir, name: split.name } : null;
  } finally {
    root.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function notRegular(label: string): GroupFsError {
  return new GroupFsError('not_regular_file', `Not a regular file: ${label}`);
}

function tooLarge(label: string, size: number, max: number): GroupFsError {
  return new GroupFsError(
    'too_large',
    `File exceeds ${max} bytes (${size}): ${label}`,
  );
}

/** First byte and length to read for a file of `size`, honouring `maxBytes`/`tail`. */
function readWindow(
  label: string,
  size: number,
  opts: FileReadOptions,
): { start: number; length: number } {
  if (size <= opts.maxBytes) return { start: 0, length: size };
  if (!opts.tail) throw tooLarge(label, size, opts.maxBytes);
  return { start: size - opts.maxBytes, length: opts.maxBytes };
}

/**
 * Open the regular file `rel` below `dir` (O_NOFOLLOW | O_NONBLOCK, fstat must
 * show a regular file, so a FIFO or device is refused without blocking).
 * Null only when the file does not exist. The caller closes the handle.
 */
export async function openFileAt(
  dir: PinnedDir,
  rel: string,
  opts: Pick<WalkOptions, 'followInternalLinks'> = {},
): Promise<{ handle: fsp.FileHandle; stat: fs.Stats } | null> {
  assertSupported();
  return withLeaf(dir, rel, opts, async (parent, name) => {
    await runHook(parent.label, name);
    const handle = await fsp.open(parent.entry(name), FILE_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw notRegular(path.join(parent.label, name));
      return { handle, stat };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  });
}

/** Sync twin of {@link openFileAt}; the caller closes the descriptor. */
export function openFileAtSync(
  dir: PinnedDir,
  rel: string,
  opts: Pick<WalkOptions, 'followInternalLinks'> &
    Pick<FileReadOptions, 'rejectHardLinks'> = {},
): { fd: number; stat: fs.Stats } | null {
  assertSupported();
  return withLeafSync(dir, rel, opts, (parent, name) => {
    runHookSync(parent.label, name);
    const fd = fs.openSync(parent.entry(name), FILE_FLAGS);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw notRegular(path.join(parent.label, name));
      if (opts.rejectHardLinks) {
        assertPlainFile(stat, path.join(parent.label, name));
      }
      return { fd, stat };
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
      throw err;
    }
  });
}

/** Read the regular file `rel` below `dir`. Null only when not found. */
export async function readFileAt(
  dir: PinnedDir,
  rel: string,
  opts: FileReadOptions,
): Promise<FileRead | null> {
  const opened = await openFileAt(dir, rel, opts);
  if (!opened) return null;
  const { handle, stat } = opened;
  try {
    const { start, length } = readWindow(
      path.join(dir.label, rel),
      stat.size,
      opts,
    );
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { data: buffer.subarray(0, offset), stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

export function readFileAtSync(
  dir: PinnedDir,
  rel: string,
  opts: FileReadOptions,
): FileRead | null {
  const opened = openFileAtSync(dir, rel, opts);
  if (!opened) return null;
  const { fd, stat } = opened;
  try {
    const { start, length } = readWindow(
      path.join(dir.label, rel),
      stat.size,
      opts,
    );
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { data: buffer.subarray(0, offset), stat };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Stream the lines of the regular file `rel` below `dir` through the pinned,
 * nonblocking descriptor of {@link openFileAtSync}, holding at most one line
 * of `maxLineBytes` plus a 1 MiB read buffer in memory. Only the bytes present
 * when the file was opened are read, so a writer that keeps appending cannot
 * extend the scan; a file that shrinks meanwhile throws `not_regular_file`. A
 * longer line is discarded without buffering (`onOversizeLine` is told) and
 * the scan goes on. Returns false when the file does not exist.
 */
export function forEachLineAtSync(
  dir: PinnedDir,
  rel: string,
  opts: {
    maxLineBytes: number;
    rejectHardLinks?: boolean;
    onOversizeLine?: () => void;
  },
  onLine: (line: string) => void,
): boolean {
  const opened = openFileAtSync(dir, rel, opts);
  if (!opened) return false;
  const label = path.join(dir.label, rel);
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    const endLine = () => {
      if (skipping) {
        skipping = false;
        opts.onOversizeLine?.();
      } else if (pendingBytes > 0) {
        onLine(Buffer.concat(pending, pendingBytes).toString('utf8'));
      }
      pending = [];
      pendingBytes = 0;
    };
    const keep = (part: Buffer) => {
      if (skipping) return;
      if (pendingBytes + part.length > opts.maxLineBytes) {
        skipping = true;
        pending = [];
        pendingBytes = 0;
        return;
      }
      // The chunk buffer is reused: copy what outlives this read.
      pending.push(Buffer.from(part));
      pendingBytes += part.length;
    };
    const size = opened.stat.size;
    for (let position = 0; position < size; ) {
      const want = Math.min(chunk.length, size - position);
      const n = fs.readSync(opened.fd, chunk, 0, want, position);
      if (n === 0) {
        throw new GroupFsError(
          'not_regular_file',
          `File changed while reading: ${label}`,
        );
      }
      position += n;
      const view = chunk.subarray(0, n);
      let start = 0;
      for (let nl = view.indexOf(10); nl !== -1; nl = view.indexOf(10, start)) {
        keep(view.subarray(start, nl));
        endLine();
        start = nl + 1;
      }
      keep(view.subarray(start));
    }
    endLine();
    return true;
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      /* best effort */
    }
  }
}

/** lstat of `rel` below `dir`: intermediate directories are pinned, the leaf is not followed. */
export async function lstatAt(
  dir: PinnedDir,
  rel: string,
): Promise<fs.Stats | null> {
  assertSupported();
  return withLeaf(dir, rel, {}, async (parent, name) => {
    await runHook(parent.label, name);
    return fsp.lstat(parent.entry(name));
  });
}

export function lstatAtSync(dir: PinnedDir, rel: string): fs.Stats | null {
  assertSupported();
  return withLeafSync(dir, rel, {}, (parent, name) => {
    runHookSync(parent.label, name);
    return fs.lstatSync(parent.entry(name));
  });
}

/**
 * List `rel` below `dir` (or `dir` itself without `rel`). Null when not found.
 * Dirent `parentPath` values name the descriptor path, not the real one.
 */
export async function readdirAt(
  dir: PinnedDir,
  rel?: string,
  opts?: { withFileTypes?: false },
): Promise<string[] | null>;
export async function readdirAt(
  dir: PinnedDir,
  rel: string | undefined,
  opts: { withFileTypes: true },
): Promise<fs.Dirent[] | null>;
export async function readdirAt(
  dir: PinnedDir,
  rel?: string,
  opts: { withFileTypes?: boolean } = {},
): Promise<string[] | fs.Dirent[] | null> {
  assertSupported();
  const list = (target: PinnedDir) =>
    opts.withFileTypes
      ? fsp.readdir(target.self(), { withFileTypes: true })
      : fsp.readdir(target.self());
  if (rel === undefined) return list(dir);
  const sub = await openDirAt(dir, rel);
  if (!sub) return null;
  try {
    return await list(sub);
  } finally {
    await sub.close();
  }
}

export function readdirAtSync(
  dir: PinnedDir,
  rel?: string,
  opts?: { withFileTypes?: false },
): string[] | null;
export function readdirAtSync(
  dir: PinnedDir,
  rel: string | undefined,
  opts: { withFileTypes: true },
): fs.Dirent[] | null;
export function readdirAtSync(
  dir: PinnedDir,
  rel?: string,
  opts: { withFileTypes?: boolean } = {},
): string[] | fs.Dirent[] | null {
  assertSupported();
  const list = (target: PinnedDir) =>
    opts.withFileTypes
      ? fs.readdirSync(target.self(), { withFileTypes: true })
      : fs.readdirSync(target.self());
  if (rel === undefined) return list(dir);
  const sub = openDirAtSync(dir, rel);
  if (!sub) return null;
  try {
    return list(sub);
  } finally {
    sub.closeSync();
  }
}

/** Read the file at an absolute path via {@link openParentDir} + {@link readFileAt}. */
export async function readGroupFile(
  absPath: string,
  opts: FileReadOptions,
): Promise<FileRead | null> {
  const parent = await openParentDir(absPath, opts);
  if (!parent) return null;
  try {
    return await readFileAt(parent.dir, parent.name, opts);
  } finally {
    await parent.dir.close();
  }
}

export function readGroupFileSync(
  absPath: string,
  opts: FileReadOptions,
): FileRead | null {
  const parent = openParentDirSync(absPath, opts);
  if (!parent) return null;
  try {
    return readFileAtSync(parent.dir, parent.name, opts);
  } finally {
    parent.dir.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Writes
//
// Every write names its target through the pinned parent directory, so a swap
// of any directory above it cannot redirect the write. Leaves are never
// followed: an atomic write replaces a planted link, in-place writes and
// appends refuse it.
// ---------------------------------------------------------------------------

const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND } = fs.constants;

export interface WriteFileOptions {
  /** Permission bits for a newly created file. Default 0o644. */
  mode?: number;
  /** Create missing parent directories (pinned, one segment at a time). */
  mkdirs?: boolean;
  /**
   * Default true: write a temp file next to the leaf and rename it over the
   * leaf. A planted leaf link or hardlink is replaced, never written through.
   * False: write the existing regular file in place (refuses links and
   * hardlinks) without truncating before it is verified.
   */
  atomic?: boolean;
  /** Follow relative links that stay inside the base (parent walk and leaf). */
  followInternalLinks?: boolean;
}

export type FileData = string | Uint8Array;

function notFound(label: string): GroupFsError {
  return new GroupFsError('not_found', `Not found: ${label}`);
}

/** Temp name for an atomic write: unique, hidden and short enough for NAME_MAX. */
function tempName(leaf: string): string {
  return `.${leaf.slice(0, 40)}.${process.pid}-${randomUUID()}.tmp`;
}

/** A leaf link met while following links: lets withLeaf substitute its target. */
function leafLink(): NodeJS.ErrnoException {
  return Object.assign(new Error('ELOOP: leaf is a symlink'), {
    code: 'ELOOP',
  });
}

/** In-place writes and appends need a regular file nobody else can reach by another name. */
function assertPlainFile(stat: fs.Stats, label: string): void {
  if (!stat.isFile()) throw notRegular(label);
  if (stat.nlink !== 1) {
    throw new GroupFsError(
      'not_regular_file',
      `Refusing hardlinked file: ${label}`,
    );
  }
}

const missingToNull = (err: unknown): null => {
  if (errnoOf(err) === 'ENOENT') return null;
  throw err;
};

async function writeAtomic(
  parent: PinnedDir,
  name: string,
  data: FileData,
  opts: WriteFileOptions,
): Promise<true> {
  const label = path.join(parent.label, name);
  await runHook(parent.label, name);
  const target = parent.entry(name);
  const existing = await fsp.lstat(target).catch(missingToNull);
  if (existing?.isDirectory()) throw notRegular(label);
  if (existing?.isSymbolicLink() && opts.followInternalLinks) throw leafLink();
  const temp = parent.entry(tempName(name));
  try {
    const handle = await fsp.open(
      temp,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      opts.mode ?? 0o644,
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.unlink(temp).catch(() => {});
    throw errnoOf(err) === 'EISDIR' ? notRegular(label) : err;
  }
  return true;
}

function writeAtomicSync(
  parent: PinnedDir,
  name: string,
  data: FileData,
  opts: WriteFileOptions,
): true {
  const label = path.join(parent.label, name);
  runHookSync(parent.label, name);
  const target = parent.entry(name);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch (err) {
    missingToNull(err);
  }
  if (existing?.isDirectory()) throw notRegular(label);
  if (existing?.isSymbolicLink() && opts.followInternalLinks) throw leafLink();
  const temp = parent.entry(tempName(name));
  try {
    const fd = fs.openSync(
      temp,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      opts.mode ?? 0o644,
    );
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw errnoOf(err) === 'EISDIR' ? notRegular(label) : err;
  }
  return true;
}

/**
 * Open the existing-or-new regular file `name` of `parent` with `flags`, check
 * it through the descriptor and run `write` on it. Shared by in-place writes
 * and appends.
 */
async function writeThroughHandle(
  parent: PinnedDir,
  name: string,
  flags: number,
  mode: number,
  write: (handle: fsp.FileHandle) => Promise<void>,
): Promise<true> {
  await runHook(parent.label, name);
  const handle = await fsp.open(
    parent.entry(name),
    flags | O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
    mode,
  );
  try {
    assertPlainFile(await handle.stat(), path.join(parent.label, name));
    await write(handle);
  } finally {
    await handle.close().catch(() => {});
  }
  return true;
}

function writeThroughHandleSync(
  parent: PinnedDir,
  name: string,
  flags: number,
  mode: number,
  write: (fd: number) => void,
): true {
  runHookSync(parent.label, name);
  const fd = fs.openSync(
    parent.entry(name),
    flags | O_WRONLY | O_NOFOLLOW | O_NONBLOCK,
    mode,
  );
  try {
    assertPlainFile(fs.fstatSync(fd), path.join(parent.label, name));
    write(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
  return true;
}

/** Create (or open) directory `rel` below `dir` and return it pinned. Caller closes. */
export async function mkdirAt(
  dir: PinnedDir,
  rel: string,
  opts: Pick<WalkOptions, 'followInternalLinks'> = {},
): Promise<PinnedDir> {
  const made = await openDirAt(dir, rel, { ...opts, create: true });
  if (!made) throw notFound(path.join(dir.label, rel));
  return made;
}

export function mkdirAtSync(
  dir: PinnedDir,
  rel: string,
  opts: Pick<WalkOptions, 'followInternalLinks'> = {},
): PinnedDir {
  const made = openDirAtSync(dir, rel, { ...opts, create: true });
  if (!made) throw notFound(path.join(dir.label, rel));
  return made;
}

/**
 * Write `data` to the regular file `rel` below `dir`. Atomic by default (temp
 * file + rename in the pinned parent); see {@link WriteFileOptions}. A leaf
 * that is a directory gives `not_regular_file`.
 */
export async function writeFileAt(
  dir: PinnedDir,
  rel: string,
  data: FileData,
  opts: WriteFileOptions = {},
): Promise<void> {
  assertSupported();
  const walk: WalkOptions = {
    create: opts.mkdirs ?? false,
    followInternalLinks: opts.followInternalLinks,
  };
  const done = await withLeaf(dir, rel, walk, (parent, name) =>
    (opts.atomic ?? true)
      ? writeAtomic(parent, name, data, opts)
      : writeThroughHandle(
          parent,
          name,
          O_CREAT,
          opts.mode ?? 0o644,
          async (handle) => {
            await handle.truncate(0);
            await handle.writeFile(data);
          },
        ),
  );
  if (!done) throw notFound(path.join(dir.label, rel));
}

export function writeFileAtSync(
  dir: PinnedDir,
  rel: string,
  data: FileData,
  opts: WriteFileOptions = {},
): void {
  assertSupported();
  const walk: WalkOptions = {
    create: opts.mkdirs ?? false,
    followInternalLinks: opts.followInternalLinks,
  };
  const done = withLeafSync(dir, rel, walk, (parent, name) =>
    (opts.atomic ?? true)
      ? writeAtomicSync(parent, name, data, opts)
      : writeThroughHandleSync(
          parent,
          name,
          O_CREAT,
          opts.mode ?? 0o644,
          (fd) => {
            fs.ftruncateSync(fd, 0);
            fs.writeFileSync(fd, data);
          },
        ),
  );
  if (!done) throw notFound(path.join(dir.label, rel));
}

/**
 * Append `data` at `offset` to an existing regular single-link file of at least
 * `offset` bytes, in place, through a handle opened `O_NOFOLLOW` below the
 * pinned parent. Null when the leaf is anything else, so the caller takes the
 * temp-file path (which also owns every refusal).
 */
function appendChunkInPlaceSync(
  parent: PinnedDir,
  name: string,
  data: Uint8Array,
  offset: number,
  mtime?: Date,
): fs.Stats | null {
  runHookSync(parent.label, name);
  let fd: number;
  try {
    fd = fs.openSync(parent.entry(name), O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < offset) {
      return null;
    }
    fs.ftruncateSync(fd, offset);
    try {
      let written = 0;
      while (written < data.length)
        written += fs.writeSync(
          fd,
          data,
          written,
          data.length - written,
          offset + written,
        );
      if (mtime) fs.futimesSync(fd, new Date(), mtime);
      return fs.fstatSync(fd);
    } catch (err) {
      // Bytes before `offset` were never touched: drop the partial tail.
      try {
        fs.ftruncateSync(fd, offset);
      } catch {
        /* best effort; the original error is the one thrown */
      }
      throw err;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Replace a file with its existing prefix and a received chunk: appends to a
 * regular single-link file are written in place, everything else is atomically
 * replaced through a temp file. A chunk at a positive `offset` needs an existing
 * leaf of at least `offset` bytes below existing directories: a missing leaf is
 * `not_found`, a shorter one `short_prefix`, and nothing is created or padded.
 */
export function writeChunkAtSync(
  dir: PinnedDir,
  rel: string,
  data: Uint8Array,
  offset: number,
  mtime?: Date,
): fs.Stats {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new GroupFsError('invalid_path', 'Invalid chunk offset');
  }
  const result = withLeafSync(dir, rel, { create: !offset }, (parent, name) => {
    if (offset) {
      const appended = appendChunkInPlaceSync(
        parent,
        name,
        data,
        offset,
        mtime,
      );
      if (appended) return appended;
    }
    let source: { fd: number; stat: fs.Stats } | null = null;
    if (offset) {
      source = openFileAtSync(parent, name);
      if (!source) return null;
      if (source.stat.size < offset) {
        fs.closeSync(source.fd);
        throw new GroupFsError(
          'short_prefix',
          `Local prefix is shorter than chunk offset ${offset}: ${path.join(parent.label, name)}`,
        );
      }
    }
    const temp = parent.entry(tempName(name));
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
      if (source) {
        const buffer = Buffer.alloc(64 * 1024);
        let pos = 0;
        while (pos < offset) {
          const n = fs.readSync(
            source.fd,
            buffer,
            0,
            Math.min(buffer.length, offset - pos),
            pos,
          );
          if (!n) break;
          let written = 0;
          while (written < n)
            written += fs.writeSync(
              fd,
              buffer,
              written,
              n - written,
              pos + written,
            );
          pos += n;
        }
      }
      fs.ftruncateSync(fd, offset);
      let written = 0;
      while (written < data.length)
        written += fs.writeSync(
          fd,
          data,
          written,
          data.length - written,
          offset + written,
        );
      if (mtime) fs.futimesSync(fd, new Date(), mtime);
      const stat = fs.fstatSync(fd);
      fs.renameSync(temp, parent.entry(name));
      return stat;
    } finally {
      if (source) fs.closeSync(source.fd);
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(temp);
      } catch {
        /* renamed or absent */
      }
    }
  });
  if (!result) throw notFound(path.join(dir.label, rel));
  return result;
}

/**
 * Append `data` to the regular file `rel` below `dir` (O_APPEND | O_NOFOLLOW).
 * Links and hardlinked files are refused; a missing file is created unless
 * `create` is false (then `not_found`).
 */
export function appendFileAtSync(
  dir: PinnedDir,
  rel: string,
  data: FileData,
  opts: { create?: boolean } = {},
): void {
  assertSupported();
  const done = withLeafSync(dir, rel, {}, (parent, name) =>
    writeThroughHandleSync(
      parent,
      name,
      O_APPEND | ((opts.create ?? true) ? O_CREAT : 0),
      0o644,
      (fd) => fs.writeFileSync(fd, data),
    ),
  );
  if (!done) throw notFound(path.join(dir.label, rel));
}

/**
 * Rename `srcRel` below `srcDir` to `dstRel` below `dstDir`. Both parents are
 * pinned and the rename runs between their entries; neither leaf is followed.
 * EXDEV (two filesystems) is rethrown unchanged so the caller can copy+remove.
 */
export async function renameAt(
  srcDir: PinnedDir,
  srcRel: string,
  dstDir: PinnedDir,
  dstRel: string,
): Promise<void> {
  assertSupported();
  const label = `${path.join(srcDir.label, srcRel)} -> ${path.join(dstDir.label, dstRel)}`;
  const src = await resolveParent(srcDir, splitRelPath(srcRel), {}, { n: 0 });
  if (!src) throw notFound(label);
  try {
    const dst = await resolveParent(dstDir, splitRelPath(dstRel), {}, { n: 0 });
    if (!dst) throw notFound(label);
    try {
      await fsp.rename(src.parent.entry(src.name), dst.parent.entry(dst.name));
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'EXDEV') throw err;
      throw code === 'ENOENT' ? notFound(label) : mapError(err, label);
    } finally {
      await dst.release();
    }
  } finally {
    await src.release();
  }
}

/** Renames the entry `from` of `fromFd` to `to` of `toFd` without replacing; returns errno (0 = done). */
type NativeNoReplaceRename = (
  fromFd: number,
  from: string,
  toFd: number,
  to: string,
) => number;

let nativeNoReplaceRename: Promise<NativeNoReplaceRename | null> | undefined;

/** Linux renameat2(RENAME_NOREPLACE) through libc; null where Bun's FFI or libc.so.6 is missing. */
function loadNativeNoReplaceRename(): Promise<NativeNoReplaceRename | null> {
  nativeNoReplaceRename ??= (async () => {
    if (process.platform !== 'linux') return null;
    try {
      const { dlopen, FFIType, ptr, read } = await import('bun:ffi');
      const { symbols } = dlopen('libc.so.6', {
        renameat2: {
          args: [
            FFIType.i32,
            FFIType.ptr,
            FFIType.i32,
            FFIType.ptr,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      const RENAME_NOREPLACE = 1;
      return (fromFd, from, toFd, to) => {
        const rc = symbols.renameat2(
          fromFd,
          ptr(Buffer.from(`${from}\0`)),
          toFd,
          ptr(Buffer.from(`${to}\0`)),
          RENAME_NOREPLACE,
        );
        return rc === 0 ? 0 : read.i32(symbols.__errno_location()!, 0);
      };
    } catch {
      return null;
    }
  })();
  return nativeNoReplaceRename;
}

const ERRNO_BY_NUMBER: Record<number, string> = {
  2: 'ENOENT',
  17: 'EEXIST',
  18: 'EXDEV',
  22: 'EINVAL',
  38: 'ENOSYS',
  95: 'EOPNOTSUPP',
};

/** Unlink `entry` only while it is still the file `stat` described. */
async function unlinkIfSame(entry: string, stat: fs.Stats): Promise<boolean> {
  const now = await fsp.lstat(entry).catch(() => null);
  if (!now || now.ino !== stat.ino || now.dev !== stat.dev) return false;
  await fsp.unlink(entry).catch(() => {});
  return true;
}

/**
 * Fallback for kernels without RENAME_NOREPLACE (e.g. gVisor). Nothing a
 * concurrent writer completed is ever overwritten or unlinked:
 * - a file is hard-linked to the new name (`EEXIST` when taken; the new name
 *   is the real file from the first instant), then the old name is moved to a
 *   private temp name with an atomic rename and unlinked only when it is still
 *   the same file. If an agent replaced the source in between, that newer file
 *   is put back and the call fails; both names are kept.
 * - a directory claims the new name with `mkdir` and is renamed over that
 *   empty directory; rename refuses a non-empty or non-directory occupant, so
 *   content written there meanwhile survives.
 * A kernel without hard links fails closed with an error.
 */
async function renameNoReplaceEmulated(from: string, to: string) {
  const before = await fsp.lstat(from);
  if (before.isDirectory()) {
    await fsp.mkdir(to);
    try {
      await fsp.rename(from, to);
    } catch (err) {
      await fsp.rmdir(to).catch(() => {}); // only ever removes an empty directory
      throw err;
    }
    return;
  }
  await fsp.link(from, to);
  const parked = path.join(path.dirname(from), tempName(path.basename(from)));
  try {
    await fsp.rename(from, parked);
  } catch (err) {
    // The source vanished: the file now lives at `to` only. Otherwise undo the claim.
    if (errnoOf(err) === 'ENOENT') return;
    await unlinkIfSame(to, before);
    throw err;
  }
  if (await unlinkIfSame(parked, before)) return;
  // An agent replaced the source in the window: restore its newer file.
  await fsp.link(parked, from).then(
    () => fsp.unlink(parked).catch(() => {}),
    () => {}, // `from` was recreated meanwhile; the newer file stays at `parked`
  );
  throw new GroupFsError('io', 'Source changed while it was renamed');
}

/**
 * Like {@link renameAt}, but never replaces an existing destination (link or
 * not): that gives `exists`. POSIX rename overwrites, so this uses
 * renameat2(RENAME_NOREPLACE) between the pinned parent descriptors, which is
 * atomic, and falls back to {@link renameNoReplaceEmulated} where the kernel
 * lacks it.
 */
export async function renameNoReplaceAt(
  srcDir: PinnedDir,
  srcRel: string,
  dstDir: PinnedDir,
  dstRel: string,
): Promise<void> {
  assertSupported();
  const label = `${path.join(srcDir.label, srcRel)} -> ${path.join(dstDir.label, dstRel)}`;
  const src = await resolveParent(srcDir, splitRelPath(srcRel), {}, { n: 0 });
  if (!src) throw notFound(label);
  try {
    const dst = await resolveParent(dstDir, splitRelPath(dstRel), {}, { n: 0 });
    if (!dst) throw notFound(label);
    try {
      let code = 'EINVAL';
      const native = await loadNativeNoReplaceRename();
      if (native) {
        const errno = native(src.parent.fd, src.name, dst.parent.fd, dst.name);
        code = errno === 0 ? '' : (ERRNO_BY_NUMBER[errno] ?? `errno ${errno}`);
      }
      if (code === 'EINVAL' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
        try {
          await renameNoReplaceEmulated(
            src.parent.entry(src.name),
            dst.parent.entry(dst.name),
          );
          code = '';
        } catch (err) {
          if (err instanceof GroupFsError) throw err;
          code = errnoOf(err) ?? 'EIO';
        }
      }
      if (code === 'EXDEV') throw Object.assign(new Error(label), { code });
      if (code === 'EEXIST') {
        throw new GroupFsError('exists', `Already exists: ${label}`, code);
      }
      if (code === 'ENOENT') throw notFound(label);
      if (code)
        throw mapError(Object.assign(new Error(label), { code }), label);
    } finally {
      await dst.release();
    }
  } finally {
    await src.release();
  }
}

export function renameAtSync(
  srcDir: PinnedDir,
  srcRel: string,
  dstDir: PinnedDir,
  dstRel: string,
): void {
  assertSupported();
  const label = `${path.join(srcDir.label, srcRel)} -> ${path.join(dstDir.label, dstRel)}`;
  const src = resolveParentSync(srcDir, splitRelPath(srcRel), {}, { n: 0 });
  if (!src) throw notFound(label);
  try {
    const dst = resolveParentSync(dstDir, splitRelPath(dstRel), {}, { n: 0 });
    if (!dst) throw notFound(label);
    try {
      fs.renameSync(src.parent.entry(src.name), dst.parent.entry(dst.name));
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'EXDEV') throw err;
      throw code === 'ENOENT' ? notFound(label) : mapError(err, label);
    } finally {
      dst.release();
    }
  } finally {
    src.release();
  }
}

/**
 * Remove `name` of `parent`, never following links. Directories are walked
 * through their descriptors: an entry swapped for a link or file after the
 * lstat is only unlinked, so nothing outside the tree is touched.
 */
async function removeEntry(parent: PinnedDir, name: string): Promise<void> {
  const target = parent.entry(name);
  const stat = await fsp.lstat(target).catch(missingToNull);
  if (!stat) return;
  if (!stat.isDirectory()) {
    await fsp.unlink(target).catch(missingToNull);
    return;
  }
  let fd: number;
  try {
    await runHook(parent.label, name);
    fd = await openFd(target, DIR_FLAGS);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') return;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      await fsp.unlink(target).catch(() => {});
      return;
    }
    throw mapError(err, path.join(parent.label, name));
  }
  const sub = new PinnedDir(fd, path.join(parent.label, name));
  try {
    if (!(await fstatFd(fd)).isDirectory()) {
      await fsp.unlink(target).catch(() => {});
      return;
    }
    for (const entry of await fsp.readdir(sub.self())) {
      await removeEntry(sub, entry);
    }
  } finally {
    await sub.close();
  }
  await fsp.rmdir(target).catch(missingToNull);
}

function removeEntrySync(parent: PinnedDir, name: string): void {
  const target = parent.entry(name);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    missingToNull(err);
  }
  if (!stat) return;
  if (!stat.isDirectory()) {
    try {
      fs.unlinkSync(target);
    } catch (err) {
      missingToNull(err);
    }
    return;
  }
  let fd: number;
  try {
    runHookSync(parent.label, name);
    fd = fs.openSync(target, DIR_FLAGS);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') return;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      try {
        fs.unlinkSync(target);
      } catch {
        /* best effort */
      }
      return;
    }
    throw mapError(err, path.join(parent.label, name));
  }
  const sub = new PinnedDir(fd, path.join(parent.label, name));
  try {
    if (!fs.fstatSync(fd).isDirectory()) {
      try {
        fs.unlinkSync(target);
      } catch {
        /* best effort */
      }
      return;
    }
    for (const entry of fs.readdirSync(sub.self())) {
      removeEntrySync(sub, entry);
    }
  } finally {
    sub.closeSync();
  }
  try {
    fs.rmdirSync(target);
  } catch (err) {
    missingToNull(err);
  }
}

/**
 * Remove `rel` below `dir`; false when it does not exist. Links and files are
 * unlinked (a link is never followed), a directory needs `recursive` unless it
 * is empty.
 */
export async function removeAt(
  dir: PinnedDir,
  rel: string,
  opts: { recursive?: boolean } = {},
): Promise<boolean> {
  assertSupported();
  const done = await withLeaf(dir, rel, {}, async (parent, name) => {
    const target = parent.entry(name);
    const stat = await fsp.lstat(target);
    if (!stat.isDirectory()) await fsp.unlink(target);
    else if (opts.recursive) await removeEntry(parent, name);
    else await fsp.rmdir(target);
    return true;
  });
  return done === true;
}

export function removeAtSync(
  dir: PinnedDir,
  rel: string,
  opts: { recursive?: boolean } = {},
): boolean {
  assertSupported();
  const done = withLeafSync(dir, rel, {}, (parent, name) => {
    const target = parent.entry(name);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) fs.unlinkSync(target);
    else if (opts.recursive) removeEntrySync(parent, name);
    else fs.rmdirSync(target);
    return true;
  });
  return done === true;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Create the symlink `entry` -> `target`, replacing an existing non-directory. */
async function placeLink(entry: string, target: string): Promise<void> {
  try {
    await fsp.symlink(target, entry);
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err;
    await fsp.unlink(entry);
    await fsp.symlink(target, entry);
  }
}

/**
 * Copy the tree below `src` into `dest` without following anything: every
 * directory is opened through its descriptor with O_NOFOLLOW, regular files
 * are read through an O_NONBLOCK descriptor and written atomically with
 * {@link writeFileAt}, symlinks are recreated with the same target text
 * (never followed), and FIFOs, sockets and devices are skipped. A link already
 * at a destination entry is replaced, never written through.
 *
 * `dest` is a pinned directory, or an absolute path owned by the board
 * (created as needed, then pinned like any other destination): never pass an
 * agent-writable path as a string, since the path itself is followed.
 */
export async function copyTree(
  src: PinnedDir,
  dest: PinnedDir | string,
): Promise<void> {
  assertSupported();
  if (typeof dest !== 'string') return copyInto(src, dest);
  await fsp.mkdir(dest, { recursive: true });
  const pinned = await openTrustedDir(dest);
  if (!pinned) throw notFound(dest);
  try {
    await copyInto(src, pinned);
  } finally {
    await pinned.close();
  }
}

async function copyInto(src: PinnedDir, dest: PinnedDir): Promise<void> {
  for (const name of await fsp.readdir(src.self())) {
    const from = src.entry(name);
    const label = path.join(src.label, name);
    const stat = await fsp.lstat(from).catch(missingToNull);
    if (!stat) continue; // vanished since the listing
    if (stat.isSymbolicLink()) {
      await placeLink(dest.entry(name), await fsp.readlink(from));
    } else if (stat.isDirectory()) {
      await copyDirectory(src, name, dest);
    } else if (stat.isFile()) {
      await copyFile(from, label, stat, name, dest);
    } else {
      logger.debug({ path: label }, 'copyTree: skipping special file');
    }
  }
}

async function copyDirectory(
  src: PinnedDir,
  name: string,
  dest: PinnedDir,
): Promise<void> {
  const label = path.join(src.label, name);
  let fd: number;
  try {
    await runHook(src.label, name);
    fd = await openFd(src.entry(name), DIR_FLAGS);
  } catch (err) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(errnoOf(err) ?? '')) {
      logger.debug({ path: label }, 'copyTree: directory changed, skipping');
      return;
    }
    throw mapError(err, label);
  }
  const sub = new PinnedDir(fd, label);
  try {
    if (!(await fstatFd(fd)).isDirectory()) {
      logger.debug({ path: label }, 'copyTree: directory changed, skipping');
      return;
    }
    // A link or file left at the destination by an earlier copy is replaced.
    const existing = await lstatAt(dest, name);
    if (existing && !existing.isDirectory()) await removeAt(dest, name);
    const target = await mkdirAt(dest, name);
    try {
      await copyInto(sub, target);
    } finally {
      await target.close();
    }
  } finally {
    await sub.close();
  }
}

async function copyFile(
  from: string,
  label: string,
  stat: fs.Stats,
  name: string,
  dest: PinnedDir,
): Promise<void> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(from, FILE_FLAGS);
  } catch (err) {
    // Swapped for a link, FIFO or removed since the lstat: not a regular file any more.
    if (['ENOENT', 'ELOOP', 'ENXIO'].includes(errnoOf(err) ?? '')) {
      logger.debug({ path: label }, 'copyTree: file changed, skipping');
      return;
    }
    throw mapError(err, label);
  }
  let data: Buffer;
  try {
    if (!(await handle.stat()).isFile()) {
      logger.debug({ path: label }, 'copyTree: file changed, skipping');
      return;
    }
    data = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
  await writeFileAt(dest, name, data, { mode: stat.mode & 0o777 });
}

function placeLinkSync(entry: string, target: string): void {
  try {
    fs.symlinkSync(target, entry);
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err;
    fs.unlinkSync(entry);
    fs.symlinkSync(target, entry);
  }
}

/** Synchronous twin of {@link copyTree}. */
export function copyTreeSync(src: PinnedDir, dest: PinnedDir | string): void {
  assertSupported();
  if (typeof dest !== 'string') return copyIntoSync(src, dest);
  fs.mkdirSync(dest, { recursive: true });
  const pinned = openTrustedDirSync(dest);
  if (!pinned) throw notFound(dest);
  try {
    copyIntoSync(src, pinned);
  } finally {
    pinned.closeSync();
  }
}

function lstatOrNullSync(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    return missingToNull(err);
  }
}

function copyIntoSync(src: PinnedDir, dest: PinnedDir): void {
  for (const name of fs.readdirSync(src.self())) {
    const from = src.entry(name);
    const label = path.join(src.label, name);
    const stat = lstatOrNullSync(from);
    if (!stat) continue; // vanished since the listing
    if (stat.isSymbolicLink()) {
      placeLinkSync(dest.entry(name), fs.readlinkSync(from));
    } else if (stat.isDirectory()) {
      copyDirectorySync(src, name, dest);
    } else if (stat.isFile()) {
      copyRegularFileSync(from, label, stat, name, dest);
    } else {
      logger.debug({ path: label }, 'copyTree: skipping special file');
    }
  }
}

function copyDirectorySync(
  src: PinnedDir,
  name: string,
  dest: PinnedDir,
): void {
  const label = path.join(src.label, name);
  let fd: number;
  try {
    runHookSync(src.label, name);
    fd = fs.openSync(src.entry(name), DIR_FLAGS);
  } catch (err) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(errnoOf(err) ?? '')) {
      logger.debug({ path: label }, 'copyTree: directory changed, skipping');
      return;
    }
    throw mapError(err, label);
  }
  const sub = new PinnedDir(fd, label);
  try {
    if (!fs.fstatSync(fd).isDirectory()) {
      logger.debug({ path: label }, 'copyTree: directory changed, skipping');
      return;
    }
    // A link or file left at the destination by an earlier copy is replaced.
    const existing = lstatAtSync(dest, name);
    if (existing && !existing.isDirectory()) removeAtSync(dest, name);
    const target = mkdirAtSync(dest, name);
    try {
      copyIntoSync(sub, target);
    } finally {
      target.closeSync();
    }
  } finally {
    sub.closeSync();
  }
}

function copyRegularFileSync(
  from: string,
  label: string,
  stat: fs.Stats,
  name: string,
  dest: PinnedDir,
): void {
  let fd: number;
  try {
    fd = fs.openSync(from, FILE_FLAGS);
  } catch (err) {
    // Swapped for a link, FIFO or removed since the lstat: not a regular file any more.
    if (['ENOENT', 'ELOOP', 'ENXIO'].includes(errnoOf(err) ?? '')) {
      logger.debug({ path: label }, 'copyTree: file changed, skipping');
      return;
    }
    throw mapError(err, label);
  }
  let data: Buffer;
  try {
    if (!fs.fstatSync(fd).isFile()) {
      logger.debug({ path: label }, 'copyTree: file changed, skipping');
      return;
    }
    data = fs.readFileSync(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
  writeFileAtSync(dest, name, data, { mode: stat.mode & 0o777 });
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/**
 * Serve an already opened file (see {@link openFileAt}) with `res.sendFile`.
 *
 * Express `send` re-resolves its path when it stats and streams the file, so
 * sending the original path would let a swap after the check redirect the
 * response. The magic link `/proc/self/fd/<fd>` instead names the inode the
 * handle pinned: a rename, replacement or symlink swap of the original path
 * after the open does not change what is sent. `send` stats and opens that
 * link like any file, so Range (206), ETag and Last-Modified (304) keep
 * working with the pinned inode's size and mtime.
 *
 * The link has no extension, so callers MUST set Content-Type themselves
 * (`opts.headers` or `res.type()` before the call). The handle is closed
 * exactly once, when the send finishes or fails and when the response closes
 * (e.g. an aborted client), whichever comes first. The caller must not close it.
 */
export function sendPinnedFile(
  res: Response,
  opened: { handle: fsp.FileHandle },
  opts: {
    headers?: Record<string, string | number | readonly string[]>;
    maxAge?: number | string;
    immutable?: boolean;
  } = {},
): void {
  const { handle } = opened;
  const fdPath = `/proc/self/fd/${handle.fd}`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void handle.close().catch(() => {});
  };
  res.once('close', close);
  try {
    res.sendFile(fdPath, { dotfiles: 'allow', ...opts }, (err) => {
      close();
      if (err && !res.headersSent && !res.writableEnded) {
        res.status(500).end();
      }
    });
  } catch (err) {
    close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Absolute-path convenience wrappers
// ---------------------------------------------------------------------------

/** Pin the parent of `absPath` for a write, creating missing directories on request. */
function openWriteParentSync(
  absPath: string,
  opts: Pick<WriteFileOptions, 'mkdirs' | 'followInternalLinks'>,
): { dir: PinnedDir; name: string } {
  const parent = openParentDirSync(absPath, {
    create: opts.mkdirs,
    followInternalLinks: opts.followInternalLinks,
  });
  if (!parent) throw notFound(absPath);
  return parent;
}

/** {@link writeFileAtSync} for the file at an absolute path. */
export function writeGroupFileSync(
  absPath: string,
  data: FileData,
  opts: WriteFileOptions = {},
): void {
  const parent = openWriteParentSync(absPath, opts);
  try {
    writeFileAtSync(parent.dir, parent.name, data, opts);
  } finally {
    parent.dir.closeSync();
  }
}

export function removeGroupPathSync(
  absPath: string,
  opts: { recursive?: boolean } = {},
): boolean {
  const parent = openParentDirSync(absPath);
  if (!parent) return false;
  try {
    return removeAtSync(parent.dir, parent.name, opts);
  } finally {
    parent.dir.closeSync();
  }
}

/** {@link lstatAt} for the path `absPath`: the leaf link itself is reported, not followed. */
export async function lstatGroupPath(
  absPath: string,
): Promise<fs.Stats | null> {
  const parent = await openParentDir(absPath);
  if (!parent) return null;
  try {
    return await lstatAt(parent.dir, parent.name);
  } finally {
    await parent.dir.close();
  }
}

export function lstatGroupPathSync(absPath: string): fs.Stats | null {
  const parent = openParentDirSync(absPath);
  if (!parent) return null;
  try {
    return lstatAtSync(parent.dir, parent.name);
  } finally {
    parent.dir.closeSync();
  }
}

/**
 * {@link readdirAtSync} for the directory at `absPath` (entries are typed, a
 * link is listed as a link). Null when it does not exist.
 */
export function readdirGroupPathSync(absPath: string): fs.Dirent[] | null {
  const parent = openParentDirSync(absPath);
  if (!parent) return null;
  try {
    return readdirAtSync(parent.dir, parent.name, { withFileTypes: true });
  } finally {
    parent.dir.closeSync();
  }
}
