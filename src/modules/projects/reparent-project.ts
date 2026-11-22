/**
 * Change a project's parent without orphaning its data.
 *
 * A child's group directory is derived from its parent (`groups/<parent>/<folder>`,
 * see `group-dir.ts`), and its sandbox bind-mounts that directory. Changing
 * `parentId` in the database alone therefore leaves the files at the old path
 * and the running container (a CarapaBrain, say) on the old mount.
 *
 * Order, with every step undone if a later one fails before the parent is saved:
 *   1. hold chat/task admission on every affected instance and wait for
 *      launches already past admission to record their run;
 *   2. refuse while the project, a child, or an affected instance has a run;
 *   3. fence sandbox starts and stop the containers of every affected sandbox
 *      (the project's own and, when it is or becomes a shared child, the
 *      owner's, whose Brain registry is only read at startup);
 *   4. merge the old directory into the new one (never overwriting a file),
 *      and move the project's upload directory when its namespace changes;
 *   5. persist the new parent;
 *   6. restart the stopped stacks together, verify their `/workspace/group`
 *      mount, release the hold.
 *
 * Child projects keep their own directories (`groups/<project>/<child>`
 * depends on the child's `parentId` only). They are left in place only where
 * they actually sit inside the moved directory, i.e. when the project's
 * directory is the flat `groups/<project>`. `data/ipc/<stack>-<instance>` is
 * keyed by stack and instance, and the group replica resolves a project's
 * directory on every sync, so neither needs a migration beyond uploads.
 */
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GROUPS_DIR, HOST_GROUPS_DIR } from '../../config.js';
import { groupDirFor } from '../../group-dir.js';
import {
  GroupFsError,
  lstatAt,
  mkdirAt,
  openDirAt,
  openParentDir,
  openTrustedDir,
  readdirAt,
  readFileAt,
  removeAt,
  renameNoReplaceAt,
  splitRelPath,
  type PinnedDir,
} from '../../lib/group-fs.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';

/** What the project is left in when a reparent fails. */
export type ReparentState =
  /** Nothing changed (the sandbox may have to be started again on demand). */
  | 'unchanged'
  /** Saving the parent failed; the files were moved back, the parent is unchanged. */
  | 'restored'
  /** Moving the files back failed: data is at the new path, parent not saved. */
  | 'needs_attention'
  /** Files moved and parent saved, but the sandbox did not restart. */
  | 'saved_sandbox_failed'
  /** Files moved and parent saved, but the restarted mount could not be verified. */
  | 'saved_mount_unverified'
  /** Files moved and parent saved, but entries remain at the old path. */
  | 'saved_cleanup_incomplete';

export class ProjectReparentError extends Error {
  constructor(
    readonly status: 404 | 409 | 500 | 502,
    message: string,
    readonly state: ReparentState,
    /** The error from saving the parent, when that is what failed. */
    readonly persistCause?: unknown,
  ) {
    super(message);
    this.name = 'ProjectReparentError';
  }
}

/** Largest file compared byte-by-byte when both locations hold the same name. */
const MAX_COMPARE_BYTES = 8 * 1024 * 1024;

interface MergePlan {
  /** Paths (relative to the project directory) renamed in one step each. */
  moves: string[];
  /** Directories present on both sides, merged entry by entry. */
  dirs: string[];
  /** Identical entries already at the destination; removed from the source afterwards. */
  duplicates: string[];
  /** Entries that exist on both sides with different content. */
  conflicts: string[];
}

export interface GroupDirMove {
  /** Undo the move. Rejects when something could not be put back. */
  rollback(): Promise<void>;
  /** Remove duplicates and emptied directories from the old path; resolves to what stays. */
  finalize(): Promise<string[]>;
  close(): Promise<void>;
}

/** The two directories hold different content under the same path. */
class GroupDirConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    const shown = conflicts.slice(0, 5).join(', ');
    const more =
      conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : '';
    super(
      `${conflicts.length} path(s) exist in both the old and the new location with different content: ${shown}${more}`,
    );
    this.name = 'GroupDirConflictError';
  }
}

/** A move failed and putting the already moved entries back failed too. */
class GroupDirRollbackError extends Error {
  constructor(
    readonly cause: unknown,
    readonly undoCause: unknown,
    readonly newDir: string,
  ) {
    super(
      `${String(cause)}; moving the entries back also failed (${String(undoCause)}), so part of the data is now at ${newDir}`,
    );
    this.name = 'GroupDirRollbackError';
  }
}

async function sameEntry(
  src: PinnedDir,
  dst: PinnedDir,
  name: string,
  s: Stats,
  d: Stats,
): Promise<boolean> {
  if (s.isSymbolicLink() && d.isSymbolicLink()) {
    return (
      (await fsp.readlink(src.entry(name))) ===
      (await fsp.readlink(dst.entry(name)))
    );
  }
  if (!s.isFile() || !d.isFile() || s.size !== d.size) return false;
  if (s.size > MAX_COMPARE_BYTES) return false;
  const opts = { maxBytes: MAX_COMPARE_BYTES };
  const [a, b] = await Promise.all([
    readFileAt(src, name, opts),
    readFileAt(dst, name, opts),
  ]);
  return !!a && !!b && a.data.equals(b.data);
}

async function planDir(
  src: PinnedDir,
  dst: PinnedDir,
  rel: string,
  skip: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
  plan: MergePlan,
): Promise<void> {
  for (const name of (await readdirAt(src)) ?? []) {
    if (skip.has(name)) continue;
    const entry = rel ? `${rel}/${name}` : name;
    const s = await lstatAt(src, name);
    if (!s) continue;
    const d = await lstatAt(dst, name);
    // A destination entry that is a child project's directory is not ours.
    if (d && reserved.has(name)) {
      plan.conflicts.push(`${entry} (a child project's directory)`);
      continue;
    }
    if (!d) {
      plan.moves.push(entry);
    } else if (s.isDirectory() && d.isDirectory()) {
      plan.dirs.push(entry);
      const subSrc = await openDirAt(src, name);
      const subDst = await openDirAt(dst, name);
      try {
        if (subSrc && subDst) {
          await planDir(subSrc, subDst, entry, new Set(), new Set(), plan);
        }
      } finally {
        await subSrc?.close();
        await subDst?.close();
      }
    } else if (await sameEntry(src, dst, name, s, d)) {
      plan.duplicates.push(entry);
    } else {
      plan.conflicts.push(entry);
    }
  }
}

export interface MoveDirOptions {
  /** Top-level names of `oldDir` that stay (child projects' directories). */
  keep?: readonly string[];
  /** Top-level names of `newDir` that belong to child projects: never merged into. */
  reserved?: readonly string[];
  /**
   * Board-owned directory both paths lie below (the IPC root). Every segment
   * below it is opened without following links; without it the paths are
   * group directories and are walked from GROUPS_DIR the same way.
   */
  anchor?: string;
  dryRun?: boolean;
}

/** Open the parent of `abs`, below `anchor` when given. Null when missing. */
async function openParent(
  abs: string,
  anchor: { dir: PinnedDir; path: string } | null,
  create: boolean,
): Promise<{ dir: PinnedDir; name: string } | null> {
  if (!anchor) return openParentDir(abs, { create });
  const rel = path.relative(anchor.path, path.resolve(abs));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GroupFsError('invalid_path', `${abs} is outside ${anchor.path}`);
  }
  const segments = splitRelPath(rel.split(path.sep).join('/'));
  const name = segments[segments.length - 1];
  if (segments.length === 1) return { dir: anchor.dir, name };
  const dir = await openDirAt(anchor.dir, segments.slice(0, -1).join('/'), {
    create,
  });
  return dir ? { dir, name } : null;
}

/**
 * Move the directory `oldDir` to `newDir`, merging into whatever is already
 * there (an empty skeleton, typically). Nothing is ever overwritten: entries
 * present on both sides with different content abort the move with a
 * `GroupDirConflictError` before anything is touched. Resolves to null when
 * there is nothing at `oldDir`.
 *
 * Both parents are pinned and every entry is named through them: the folders
 * are writable by sandbox agents, so no path is resolved a second time.
 */
export async function moveGroupDir(
  oldDir: string,
  newDir: string,
  options: MoveDirOptions = {},
): Promise<GroupDirMove | null> {
  const closers: Array<() => Promise<void>> = [];
  const closeAll = async () => {
    for (const close of closers.splice(0).reverse()) await close();
  };
  try {
    let anchor: { dir: PinnedDir; path: string } | null = null;
    if (options.anchor) {
      const dir = await openTrustedDir(options.anchor);
      if (!dir) return null;
      closers.push(() => dir.close());
      anchor = { dir, path: path.resolve(options.anchor) };
    }
    const srcParent = await openParent(oldDir, anchor, false);
    if (!srcParent) {
      await closeAll();
      return null;
    }
    closers.push(() => srcParent.dir.close());
    const srcStat = await lstatAt(srcParent.dir, srcParent.name);
    if (!srcStat) {
      await closeAll();
      return null;
    }
    if (!srcStat.isDirectory()) {
      throw new GroupFsError(
        'not_directory',
        `${oldDir} is not a directory, so it was not moved`,
      );
    }
    const dstParent = await openParent(newDir, anchor, !options.dryRun);
    if (dstParent) closers.push(() => dstParent.dir.close());
    const dstStat = dstParent
      ? await lstatAt(dstParent.dir, dstParent.name)
      : null;
    if (dstStat && !dstStat.isDirectory()) {
      throw new GroupFsError(
        'not_directory',
        `${newDir} exists and is not a directory, so nothing was moved`,
      );
    }
    const srcRoot = await openDirAt(srcParent.dir, srcParent.name);
    if (!srcRoot) {
      await closeAll();
      return null;
    }
    closers.push(() => srcRoot.close());

    const skip = new Set(options.keep ?? []);
    const reserved = new Set(options.reserved ?? []);
    const plan: MergePlan = {
      moves: [],
      dirs: [],
      duplicates: [],
      conflicts: [],
    };
    // With no destination the whole directory is renamed in one step, unless
    // some entries have to stay behind.
    const whole = !dstStat && skip.size === 0;
    if (dstStat && dstParent) {
      const dstRoot = await openDirAt(dstParent.dir, dstParent.name);
      if (!dstRoot) throw new GroupFsError('not_found', `${newDir} vanished`);
      try {
        await planDir(srcRoot, dstRoot, '', skip, reserved, plan);
      } finally {
        await dstRoot.close();
      }
    } else if (!whole) {
      for (const name of (await readdirAt(srcRoot)) ?? []) {
        if (!skip.has(name)) plan.moves.push(name);
      }
    }
    if (plan.conflicts.length > 0)
      throw new GroupDirConflictError(plan.conflicts);
    if (options.dryRun) {
      await closeAll();
      return null;
    }
    if (!dstParent) {
      throw new GroupFsError('not_found', `${path.dirname(newDir)} is missing`);
    }

    const done: string[] = [];
    let createdRoot = false;
    let dstRootPinned: PinnedDir | null = null;
    const undo = async () => {
      if (whole) {
        await renameNoReplaceAt(
          dstParent.dir,
          dstParent.name,
          srcParent.dir,
          srcParent.name,
        );
        return;
      }
      // One at a time, so a failure leaves the rest recorded.
      while (done.length > 0) {
        const entry = done[done.length - 1];
        await renameNoReplaceAt(dstRootPinned!, entry, srcRoot, entry);
        done.pop();
      }
      if (createdRoot) {
        await removeAt(dstParent.dir, dstParent.name).catch(() => {});
      }
    };
    try {
      if (whole) {
        await renameNoReplaceAt(
          srcParent.dir,
          srcParent.name,
          dstParent.dir,
          dstParent.name,
        );
      } else {
        if (!dstStat) {
          dstRootPinned = await mkdirAt(dstParent.dir, dstParent.name);
          createdRoot = true;
        } else {
          dstRootPinned = await openDirAt(dstParent.dir, dstParent.name);
        }
        if (!dstRootPinned) {
          throw new GroupFsError('not_found', `${newDir} vanished`);
        }
        const pinned = dstRootPinned;
        closers.push(() => pinned.close());
        for (const entry of plan.moves) {
          await renameNoReplaceAt(srcRoot, entry, pinned, entry);
          done.push(entry);
        }
      }
    } catch (err) {
      try {
        await undo();
      } catch (undoErr) {
        logger.error({ oldDir, newDir, err: undoErr }, 'Group dir undo failed');
        throw new GroupDirRollbackError(err, undoErr, newDir);
      }
      throw err;
    }

    return {
      rollback: undo,
      close: closeAll,
      finalize: async () => {
        if (whole) return [];
        for (const entry of plan.duplicates) {
          await removeAt(srcRoot, entry).catch(() => {});
        }
        // Deepest first: a directory empties only after its subdirectories.
        for (const entry of [...plan.dirs].reverse()) {
          await removeAt(srcRoot, entry).catch(() => {});
        }
        const left = ((await readdirAt(srcRoot)) ?? []).filter(
          (name) => !skip.has(name),
        );
        if (left.length === 0 && (await readdirAt(srcRoot))?.length === 0) {
          try {
            await removeAt(srcParent.dir, srcParent.name);
          } catch {
            left.push('(the emptied old directory itself)');
          }
        }
        return left;
      },
    };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** A sandbox instance a parent change has to stop and, usually, bring back. */
interface SandboxTarget {
  instance: string;
  /** Project whose settings define this sandbox once the change is saved. */
  ownerFolder: string;
  /** The instance is managed outside Board (`defaultSandboxInstance`). */
  fixedInstance: boolean;
  /** Bring it back up afterwards; false when the project no longer owns it. */
  restart: boolean;
  /**
   * Stack to start when nothing of this instance was running but another
   * target was: a child detached from a running shared owner now owns a
   * sandbox of its own.
   */
  ensureStack?: string;
  /**
   * Only a parent's sandbox that mounts the project's directory inside its
   * own; the project itself does not run in it.
   */
  exposure?: boolean;
}

/**
 * Every sandbox a parent change touches. A project that owns its sandbox loses
 * its mount source; a project inside a shared owner's sandbox moves out of (or
 * into) that owner's mount, and the owner's Brain only reads its objectives at
 * startup. So the old and the new owner are both stopped while the files move
 * and started again, with all runs on them refused or held beforehand.
 *
 * Objectives are served by the project's resolved Brain, which a child
 * inherits from its parent (`resolveBrainContainer`) and which runs in the
 * parent's sandbox. The Brain of the old parent keeps the subscriptions and the
 * Brain of the new one never loads them, so both Brains' instances are targets
 * too.
 */
export interface SandboxTransition {
  targets: SandboxTarget[];
  /**
   * Every project the change can disturb: the moved project and its
   * descendants, the owner of each target, and every project that runs in a
   * target's sandbox or is served by a target's Brain. All checks (runs,
   * conversations, objective agents, Brain drain) cover this one set.
   */
  affected: string[];
  /** Why the change cannot be made safely (checked before anything moves). */
  refusals?: string[];
  /** Project upload directory before and after, when the change moves it. */
  uploads?: { from: string; to: string; anchor: string };
}

export interface ReparentDeps {
  getGroup(folder: string): RegisteredGroup | undefined;
  /** Folders of the projects whose parent is `folder`. */
  childFolders(folder: string): string[];
  /** The project's group directory lives on a remote CarapaBox. */
  isRemotePlaced(folder: string): boolean;
  /**
   * Why `newParentId` is not a valid parent of `group` in the hierarchy as it
   * is now (missing, itself, a descendant); undefined when it is valid.
   */
  validateParent(
    group: RegisteredGroup,
    newParentId: string | undefined,
  ): string | undefined;

  describeSandbox(
    group: RegisteredGroup,
    newParentId: string | undefined,
  ): Promise<SandboxTransition>;
  /**
   * Stop the project's Brains (before and after the change) from starting
   * objective runs of their own and report whether one is running. The lease
   * lasts until `release` is called.
   */
  drainBrains(
    group: RegisteredGroup,
    newParentId: string | undefined,
    affected: string[],
  ): Promise<{ busy?: string; release(): Promise<void> }>;
  /** Pull the final state of a remotely placed project's directory from its box. */
  syncReplica(folder: string): Promise<void>;
  /**
   * Run `operation` while the project's replica sync is paused (a remotely
   * placed project's local directory is a replica of the box's).
   */
  exclusive<T>(folder: string, operation: () => Promise<T>): Promise<T>;
  /**
   * Hold chat and task admission on `instances` while `operation` runs, after
   * launches already past admission have recorded their run.
   */
  holdRuns<T>(instances: string[], operation: () => Promise<T>): Promise<T>;
  /**
   * Describes a run of any of the `affected` projects or on any of the
   * `instances` that would be stopped; undefined when none is active.
   */
  findActiveRun(
    affected: string[],
    instances: string[],
  ): Promise<string | undefined>;
  /** Refuse sandbox starts of `instances`; resolves to the release. */
  fenceRuns(instances: string[]): Promise<() => void>;
  /** Stacks with a container up for `instance`. */
  runningStacks(instance: string): Promise<string[]>;
  /** Stop `stacks` of `instance`; throws unless each stop is confirmed. */
  stopSandbox(instance: string, stacks: string[]): Promise<void>;
  /**
   * Start `stacks` of the target's owner again from the registry as it is now
   * (new mounts, once the parent is saved), all after one stop so that a later
   * start does not stop an earlier one. Throws if any did not come back.
   */
  restartSandbox(target: SandboxTarget, stacks: string[]): Promise<void>;
  /**
   * Check that each restarted stack mounts the owner's current group
   * directory at `/workspace/group`. Throws when the mount points elsewhere,
   * cannot be read, or is missing where the Brain needs it.
   */
  verifyGroupMount(target: SandboxTarget, stacks: string[]): Promise<void>;
  moveDir: typeof moveGroupDir;
}

export interface ReparentOutcome<T> {
  value: T;
  /** Whether the project had a directory that was moved. */
  filesMoved: boolean;
  sandboxRestarted: boolean;
  /** Set when files and parent are saved but a step after that failed. */
  postSaveError?: ProjectReparentError;
}

let reparentTail: Promise<void> = Promise.resolve();

/**
 * Parent changes run one at a time, process-wide. They are rare, and what each
 * one must see (the hierarchy for the cycle check, the children whose
 * directories stay, the sandboxes that mount the subtree) depends on every
 * other one having finished. Taken first, held through the file move, the
 * save, the restart and any rollback.
 */
export function withReparentMutex<T>(operation: () => Promise<T>): Promise<T> {
  const run = reparentTail.then(operation, operation);
  reparentTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Whether a registered chat abort controller belongs to `folder`. Inline
 * (Direct LLM) turns have no sandbox run and no active_runs row; they register
 * under `<folder>`, `<folder>:conv:<id>` or `<folder>:jid:<jid>`.
 */
function isInlineChatKeyOf(folder: string, keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (key === folder || key.startsWith(`${folder}:`)) return true;
  }
  return false;
}

export interface ActivitySources {
  runningTaskIds(): Promise<Set<string>>;
  taskIds(folder: string): Promise<string[]>;
  hasRun(folder: string): Promise<boolean>;
  /** An inline conversation admitted in the project row. */
  hasInlineAdmission(folder: string): Promise<boolean>;
  /** Keys of the registered chat abort controllers. */
  inlineChatKeys(): Iterable<string>;
  /** Id of an objective of the project whose agent is running. */
  runningObjective(folder: string): Promise<string | undefined>;
  /** Folder of the project running on the sandbox instance, if any. */
  runOnInstance(instance: string): Promise<string | undefined>;
}

/**
 * The first activity found over the one affected set and the instances that
 * would be stopped: sandbox runs and tasks, inline conversations, objective
 * agents. No check uses a narrower list of its own.
 */
export async function findActivityOver(
  affected: readonly string[],
  instances: readonly string[],
  sources: ActivitySources,
): Promise<string | undefined> {
  const running = await sources.runningTaskIds();
  for (const folder of affected) {
    for (const id of await sources.taskIds(folder)) {
      if (running.has(id)) return `task ${id} of "${folder}" is running`;
    }
    if (await sources.hasRun(folder)) {
      return `"${folder}" has a run in progress`;
    }
    if (
      (await sources.hasInlineAdmission(folder)) ||
      isInlineChatKeyOf(folder, sources.inlineChatKeys())
    ) {
      return `"${folder}" has a conversation in progress`;
    }
    const objective = await sources.runningObjective(folder);
    if (objective) {
      return `objective ${objective} of "${folder}" has an agent running`;
    }
  }
  for (const instance of instances) {
    const folder = await sources.runOnInstance(instance);
    if (folder) {
      return `sandbox instance "${instance}" has a run in progress (${folder})`;
    }
  }
  return undefined;
}

export interface TransitionEnv {
  groups: RegisteredGroup[];
  lookup: (folder: string) => RegisteredGroup | undefined;
  resolveEffectiveSandbox: typeof import('../../sandbox/effective-settings.js').resolveEffectiveSandbox;
  effectiveProjectUploadDir: typeof import('../../sandbox/effective-settings.js').effectiveProjectUploadDir;
  resolveBrainContainer: (group: RegisteredGroup) => string | undefined;
  /** Sandbox instance a running Brain container belongs to. */
  resolveBrainInstance: (container: string) => string | undefined;
  dataDir: string;
}

/** The sandboxes (and upload directory) a parent change touches. */
export function describeSandboxTransition(
  group: RegisteredGroup,
  newParentId: string | undefined,
  env: TransitionEnv,
): SandboxTransition {
  const before = env.resolveEffectiveSandbox(group, env.lookup);
  const next: RegisteredGroup = { ...group, parentId: newParentId };
  const after = env.resolveEffectiveSandbox(next, env.lookup);
  // The project's own sandbox disappears when it becomes a shared child.
  const keepsOwnSandbox = after.owner.folder === group.folder;
  const targets = new Map<string, SandboxTarget>();
  const add = (target: SandboxTarget) => {
    const known = targets.get(target.instance);
    if (!known) return void targets.set(target.instance, target);
    known.restart ||= target.restart;
    known.ensureStack ??= target.ensureStack;
    if (!target.exposure) delete known.exposure;
  };
  add({
    instance: before.instance,
    ownerFolder: before.owner.folder,
    fixedInstance: before.fixedInstance,
    restart: before.owner.folder !== group.folder || keepsOwnSandbox,
  });
  add({
    instance: after.instance,
    ownerFolder: after.owner.folder,
    fixedInstance: after.fixedInstance,
    restart: true,
    ...(keepsOwnSandbox && before.inherited
      ? { ensureStack: after.stack }
      : {}),
  });
  // A parent that owns its sandbox mounts its whole directory, which holds
  // this project's directory (`groups/<parent>/<project>`): its agents can
  // write there, and its Brain reads the project's objectives from there.
  for (const parentId of [group.parentId, newParentId]) {
    const parent = parentId ? env.lookup(parentId) : undefined;
    if (!parent) continue;
    const resolved = env.resolveEffectiveSandbox(parent, env.lookup);
    if (resolved.inherited) continue;
    add({
      instance: resolved.instance,
      ownerFolder: parent.folder,
      fixedInstance: resolved.fixedInstance,
      restart: true,
      exposure: true,
    });
  }
  // Objectives are served by the resolved Brain, which a child inherits from
  // its parent: both the old and the new one must reload.
  const refusals: string[] = [];
  for (const subject of [group, next]) {
    const container = env.resolveBrainContainer(subject);
    const instance = container
      ? env.resolveBrainInstance(container)
      : undefined;
    if (!instance || targets.has(instance)) continue;
    const owner = env.groups.find((candidate) => {
      const resolved = env.resolveEffectiveSandbox(candidate, env.lookup);
      return !resolved.inherited && resolved.instance === instance;
    });
    if (!owner) {
      refusals.push(
        `The Brain running in sandbox "${instance}" is not owned by any project, so Board cannot restart it to reload objectives.`,
      );
      continue;
    }
    add({
      instance,
      ownerFolder: owner.folder,
      fixedInstance: env.resolveEffectiveSandbox(owner, env.lookup)
        .fixedInstance,
      restart: true,
    });
  }
  // A project that stops owning its sandbox keeps an explicit Brain setting,
  // which would still point at the container that is left stopped.
  const retired = [...targets.values()].find(
    (target) => !target.restart && target.ownerFolder === group.folder,
  );
  const nextContainer = env.resolveBrainContainer(next);
  if (
    retired &&
    nextContainer &&
    env.resolveBrainInstance(nextContainer) === retired.instance
  ) {
    refusals.push(
      `The Brain "${nextContainer}" of "${group.folder}" runs in the sandbox it would stop owning. Move the Brain or clear brainContainer first.`,
    );
  }
  // Children keep their directories below the old one, out of reach of the
  // moved project's sandbox: a child that relies on this project's Brain would
  // lose it.
  const ownBrain = env.resolveBrainContainer(group);
  const dependent = env.groups.find(
    (child) =>
      child.parentId === group.folder &&
      !!ownBrain &&
      env.resolveBrainContainer(child) === ownBrain,
  );
  if (dependent) {
    refusals.push(
      `Child project "${dependent.folder}" uses the Brain of "${group.folder}", and its objectives stay below the old directory. Give it a Brain of its own or move it first.`,
    );
  }
  const instances = new Set([...targets.keys()]);
  const affected = new Set<string>([group.folder]);
  const addDescendants = (folder: string) => {
    for (const child of env.groups) {
      if (child.parentId === folder && !affected.has(child.folder)) {
        affected.add(child.folder);
        addDescendants(child.folder);
      }
    }
  };
  addDescendants(group.folder);
  for (const target of targets.values()) affected.add(target.ownerFolder);
  for (const candidate of env.groups) {
    if (
      instances.has(env.resolveEffectiveSandbox(candidate, env.lookup).instance)
    ) {
      affected.add(candidate.folder);
    }
    const container = env.resolveBrainContainer(candidate);
    const brainInstance = container
      ? env.resolveBrainInstance(container)
      : undefined;
    if (brainInstance && instances.has(brainInstance)) {
      affected.add(candidate.folder);
    }
  }
  const from = env.effectiveProjectUploadDir(group, env.dataDir, env.lookup);
  const to = env.effectiveProjectUploadDir(next, env.dataDir, env.lookup);
  return {
    targets: [...targets.values()],
    affected: [...affected],
    ...(refusals.length > 0 ? { refusals } : {}),
    ...(from !== to
      ? { uploads: { from, to, anchor: path.join(env.dataDir, 'ipc') } }
      : {}),
  };
}

export interface BrainDrainEnv {
  getGroup: (folder: string) => RegisteredGroup | undefined;
  resolveBrainContainer: (group: RegisteredGroup) => string | undefined;
  resolveBrainAuthToken: (group: RegisteredGroup) => string | undefined;
  fetchBrain: (
    container: string,
    path: string,
    init: RequestInit,
  ) => Promise<Response | null>;
}

/**
 * Lease the objective drain on the project's Brains (before and after the
 * change) and report whether one is running an objective. Fails closed: a Brain
 * that is reachable but does not accept the drain (including one too old to
 * have it) or report an idle status is
 * reported as busy. One that cannot be reached at all is not running.
 */
export async function drainBrains(
  group: RegisteredGroup,
  newParentId: string | undefined,
  affected: string[],
  env: BrainDrainEnv,
): Promise<{ busy?: string; release(): Promise<void> }> {
  const next: RegisteredGroup = { ...group, parentId: newParentId };
  const brains = new Map<string, string | undefined>();
  const subjects = [
    group,
    next,
    ...affected.flatMap((folder) => env.getGroup(folder) ?? []),
  ];
  for (const subject of subjects) {
    const container = env.resolveBrainContainer(subject);
    if (container) {
      brains.set(container, env.resolveBrainAuthToken(subject));
    }
  }
  type Reply = { response: Response | null } | { error: string };
  const call = async (
    container: string,
    token: string | undefined,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<Reply> => {
    try {
      const response = await env.fetchBrain(
        container,
        method === 'GET' ? '/status' : '/drain',
        {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      return { response };
    } catch (err) {
      return { error: String(err) };
    }
  };
  const lease = () =>
    Promise.all(
      [...brains].map(([container, token]) =>
        call(container, token, 'POST', { ttlMs: 120_000 }),
      ),
    );
  const failed = (container: string, why: string) => ({
    busy: `Brain ${container} could not be confirmed drained and idle (${why})`,
    release: async () => {},
  });
  const replies = await lease();
  // The lease expires on its own; keep renewing it while the move runs.
  const renew = setInterval(() => void lease(), 40_000);
  renew.unref?.();
  const release = async () => {
    clearInterval(renew);
    await Promise.all(
      [...brains].map(([container, token]) => call(container, token, 'DELETE')),
    );
  };
  // A Brain that is not running (no route to it even after a refresh)
  // starts nothing. Every running one must accept the drain and report
  // itself idle; anything else fails closed.
  const names = [...brains.keys()];
  for (const [index, container] of names.entries()) {
    const reply = replies[index];
    if ('error' in reply) {
      await release();
      return failed(container, reply.error);
    }
    if (!reply.response) continue;
    // A Brain that does not take the drain (404 on older ones) could start an
    // objective between the idle status below and the stop.
    if (!reply.response.ok) {
      await release();
      return failed(container, `drain answered ${reply.response.status}`);
    }
    const status = await call(container, brains.get(container), 'GET');
    if ('error' in status || !status.response?.ok) {
      await release();
      return failed(
        container,
        'error' in status
          ? status.error
          : `status answered ${status.response?.status ?? 'nothing'}`,
      );
    }
    const body = (await status.response.json().catch(() => null)) as {
      processor?: { activeObjectiveIds?: unknown };
    } | null;
    const ids = body?.processor?.activeObjectiveIds;
    if (!Array.isArray(ids)) {
      await release();
      return failed(container, 'malformed status');
    }
    if (ids.length > 0) {
      await release();
      return {
        busy: `Brain ${container} is running objective ${ids.join(', ')}`,
        release: async () => {},
      };
    }
  }
  return { release };
}

export async function projectMoveDeps(): Promise<ReparentDeps> {
  return defaultDeps();
}

async function defaultDeps(): Promise<ReparentDeps> {
  const [
    stateManager,
    effective,
    mcpClient,
    status,
    restart,
    activeRuns,
    kanbanDb,
    taskExecutor,
    objectivesDb,
    objectiveFolder,
    objectivesRoute,
    routing,
    fence,
    browserLifecycle,
    idleRestart,
    brainClient,
    config,
    tmuxClient,
    onDemand,
    { groupReplica },
    projectsRoute,
    sandboxProcess,
  ] = await Promise.all([
    import('../../state-manager.js'),
    import('../../sandbox/effective-settings.js'),
    import('../../lib/mcp-client.js'),
    import('../../sandbox/status.js'),
    import('../../sandbox/restart.js'),
    import('../../db/active-runs.js'),
    import('../kanban/db-kanban.js'),
    import('../kanban/task-executor.js'),
    import('../objectives/db-objectives.js'),
    import('../objectives/objective-folder.js'),
    import('../../routes/objectives.js'),
    import('../boxes/routing.js'),
    import('../../lib/sandbox-start-fence.js'),
    import('../../sandbox/browser-lifecycle.js'),
    import('../../sandbox/idle-restart.js'),
    import('../objectives/brain-client.js'),
    import('../../config.js'),
    import('../../lib/tmux-client.js'),
    import('../../lib/on-demand-sandboxes.js'),
    import('../../sandbox/ipc-replica.js'),
    import('../../routes/projects.js'),
    import('../../sandbox/process.js'),
  ]);
  const childFolders = (folder: string) =>
    Object.values(stateManager.registeredGroups)
      .filter((candidate) => candidate.parentId === folder)
      .map((candidate) => candidate.folder);

  return {
    getGroup: stateManager.getGroupByFolder,
    childFolders,
    isRemotePlaced: routing.isRemotePlacedFolder,
    validateParent: (group, newParentId) =>
      projectsRoute.validateProspectiveParentId(group, newParentId),
    describeSandbox: async (group, newParentId) => {
      // Fills the container -> instance map the Brain lookups below use.
      await brainClient.refreshBrainPortCache().catch(() => undefined);
      return describeSandboxTransition(group, newParentId, {
        groups: Object.values(stateManager.registeredGroups),
        lookup: stateManager.getGroupByFolder,
        resolveEffectiveSandbox: effective.resolveEffectiveSandbox,
        effectiveProjectUploadDir: effective.effectiveProjectUploadDir,
        resolveBrainContainer: brainClient.resolveBrainContainer,
        resolveBrainInstance: brainClient.resolveBrainSandboxInstance,
        dataDir: config.DATA_DIR,
      });
    },
    drainBrains: (group, newParentId, affected) =>
      drainBrains(group, newParentId, affected, {
        getGroup: stateManager.getGroupByFolder,
        resolveBrainContainer: brainClient.resolveBrainContainer,
        resolveBrainAuthToken: brainClient.resolveBrainAuthToken,
        fetchBrain: brainClient.fetchBrain,
      }),
    syncReplica: (folder) => groupReplica.syncRoot(folder, ''),
    exclusive: (folder, operation) =>
      groupReplica.runExclusive(folder, operation),
    holdRuns: (instances, operation) =>
      idleRestart.holdInstances(instances, operation),
    findActiveRun: (affected, instances) =>
      findActivityOver(affected, instances, {
        runningTaskIds: async () =>
          new Set([
            ...taskExecutor.getRunningTaskIds(),
            ...(await activeRuns.getRunningTaskIds()),
          ]),
        taskIds: async (folder) =>
          (await kanbanDb.getTasksByProject(folder)).map((task) => task.id),
        hasRun: async (folder) =>
          !!(await activeRuns.getActiveRunForGroup(folder)),
        hasInlineAdmission: kanbanDb.hasInlineConversationAdmission,
        inlineChatKeys: () => sandboxProcess.chatRunAbortControllers.keys(),
        runningObjective: async (folder) => {
          for (const objective of await objectivesDb.getObjectivesByProject(
            folder,
          )) {
            const dir = objectiveFolder.getObjectiveDir(folder, objective.id);
            objectivesRoute.invalidateRunningCache(dir);
            if (await objectivesRoute.detectAgentRunning(dir)) {
              return objective.id;
            }
          }
          return undefined;
        },
        runOnInstance: async (instance) =>
          (await activeRuns.getActiveRunByInstance(instance))?.group_folder,
      }),
    fenceRuns: async (instances) => {
      const release = fence.fenceSandboxInstances(instances);
      try {
        await fence.settleSandboxStarts(instances);
      } catch (err) {
        release();
        throw err;
      }
      return release;
    },
    runningStacks: async (instance) => {
      const ps = await mcpClient.getSandboxClient().sandboxPs(instance);
      if (ps.isError) {
        throw new Error(
          `Could not list running sandboxes of ${instance}: ${ps.stdout}`,
        );
      }
      return status.runningStackNamesForInstance(ps.stdout, instance);
    },
    stopSandbox: async (instance, stacks) => {
      const client = mcpClient.getSandboxClient();
      for (const stack of stacks) {
        try {
          await browserLifecycle.finalizeSandboxBrowsers(stack, instance);
        } catch (err) {
          logger.warn(
            { stack, err },
            'Failed to finalize browsers (non-fatal)',
          );
        }
        const stopped = await client.sandboxStop(stack, instance);
        if (stopped.isError) {
          logger.warn(
            { stack, instance, output: stopped.stdout },
            'sandbox_stop failed',
          );
        }
        // Only a status that shows it stopped proves the mount is released.
        const after = await client.sandboxStatus(stack, instance);
        if (!status.isSandboxStopped(after)) {
          throw new Error(
            `Could not confirm that sandbox ${stack}/${instance} stopped`,
          );
        }
      }
      await tmuxClient.getTmuxClient().forgetByInstance(instance);
      await onDemand.getOnDemandSandboxes().forgetByInstance(instance);
    },
    restartSandbox: async (target, stacks) => {
      const owner = stateManager.getGroupByFolder(target.ownerFolder);
      if (!owner) throw new Error(`Project ${target.ownerFolder} not found`);
      const resolved = effective.resolveEffectiveSandbox(owner);
      const ok = await restart.performSandboxRestart({
        stack: stacks[0],
        instance: resolved.instance,
        target: resolved,
        // Only the configured stack is limited to its configured service.
        start: stacks.map((stack) => ({
          stack,
          service: stack === resolved.stack ? resolved.service : null,
        })),
      });
      if (!ok) {
        throw new Error(
          `CarapaBox could not start ${stacks.join(', ')} for ${resolved.instance}`,
        );
      }
    },
    verifyGroupMount: async (target, stacks) => {
      const owner = stateManager.getGroupByFolder(target.ownerFolder);
      if (!owner) throw new Error(`Project ${target.ownerFolder} not found`);
      const resolved = effective.resolveEffectiveSandbox(owner);
      const relative = path
        .relative(
          GROUPS_DIR,
          groupDirFor(resolved.owner.folder, resolved.owner.parentId),
        )
        .split(path.sep)
        .join('/');
      const groupsBase = path.basename(HOST_GROUPS_DIR);
      const remote = routing.isRemotePlacedFolder(resolved.owner.folder);
      // The Brain container is named `<stack>-<instance>-<service>-<n>`.
      const brain = brainClient.resolveBrainContainer(owner);
      for (const stack of stacks) {
        const prefix = `${stack}-${resolved.instance}-`;
        const hostsBrain = !!brain?.startsWith(prefix);
        const service = hostsBrain
          ? brain!.slice(prefix.length).replace(/-\d+$/, '')
          : resolved.service;
        const result = await mcpClient
          .getSandboxClient()
          .sandboxExec(
            stack,
            service,
            `awk '$5 == "/workspace/group" { print $4 }' /proc/self/mountinfo`,
            { instance: resolved.instance, timeout: 15 },
          )
          .catch((err: unknown) => ({ isError: true, stdout: String(err) }));
        if (result.isError) {
          throw new Error(
            `could not read the mounts of ${stack}/${service}: ${result.stdout.slice(0, 200)}`,
          );
        }
        const roots = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (roots.length === 0) {
          // A stack without a group mount has nothing to check, except the Brain.
          if (hostsBrain) {
            throw new Error(
              `the Brain container ${brain} has no /workspace/group mount`,
            );
          }
          continue;
        }
        const ok = roots.some((root) =>
          remote
            ? // The box resolves `@group/<folder>` in its own layout, which is
              // flat by folder whatever Board's local replica looks like.
              root.endsWith(`/${resolved.owner.folder}`)
            : root.endsWith(`/${groupsBase}/${relative}`) ||
              root === `/${relative}`,
        );
        if (!ok) {
          throw new Error(
            `${stack}/${service} mounts ${roots.join(', ')} at /workspace/group, expected …/${remote ? resolved.owner.folder : `${groupsBase}/${relative}`}`,
          );
        }
      }
    },
    moveDir: moveGroupDir,
  };
}

/**
 * Why the parent of `group` cannot change to `newParentId` right now, or
 * undefined when it can. Read-only: the route calls it before it changes
 * anything, and `reparentProject` repeats it once run admission is held.
 */
export async function checkReparentAllowed(
  group: RegisteredGroup,
  newParentId: string | undefined,
  overrides: Partial<ReparentDeps> = {},
): Promise<ProjectReparentError | undefined> {
  const deps: ReparentDeps = { ...(await defaultDeps()), ...overrides };
  return checkWith(
    deps,
    group,
    newParentId,
    await deps.describeSandbox(group, newParentId),
  );
}

interface DirMove {
  from: string;
  to: string;
  options: MoveDirOptions;
}

function dirMoves(
  deps: ReparentDeps,
  group: RegisteredGroup,
  newParentId: string | undefined,
  transition: SandboxTransition,
): DirMove[] {
  const folder = group.folder;
  const from = groupDirFor(folder, group.parentId);
  const to = groupDirFor(folder, newParentId);
  // Child projects' directories sit inside the project's own only when that
  // is the flat `groups/<project>`; a nested project's children are elsewhere.
  const flat = groupDirFor(folder);
  const children = deps.childFolders(folder);
  return [
    {
      from,
      to,
      options: {
        keep: from === flat ? children : [],
        reserved: to === flat ? children : [],
      },
    },
    ...(transition.uploads
      ? [
          {
            from: transition.uploads.from,
            to: transition.uploads.to,
            options: { anchor: transition.uploads.anchor },
          },
        ]
      : []),
  ];
}

async function checkWith(
  deps: ReparentDeps,
  group: RegisteredGroup,
  newParentId: string | undefined,
  transition: SandboxTransition,
): Promise<ProjectReparentError | undefined> {
  const refuse = (message: string) =>
    new ProjectReparentError(
      409,
      `${message} Nothing was changed.`,
      'unchanged',
    );
  // A remote box resolves `@group/<folder>` by folder alone, so a sandbox there
  // never sees a project nested below it, and a remotely placed project's own
  // files stay flat on its box. Whenever another project's sandbox or Brain has
  // to see this one's files, the placement of every project involved must be
  // local: anything else would restart without the project's data.
  const others = transition.targets.filter(
    (target) => target.ownerFolder !== group.folder,
  );
  const needsOthers = others.filter((target) => !target.exposure);
  if (
    (needsOthers.length > 0 && deps.isRemotePlaced(group.folder)) ||
    others.some((target) => deps.isRemotePlaced(target.ownerFolder))
  ) {
    return refuse(
      `The change involves the sandbox or Brain of another project and a remotely placed project (${[group.folder, ...others.map((t) => t.ownerFolder)].filter(deps.isRemotePlaced).join(', ')}), whose box does not see the nested directory. This is not supported.`,
    );
  }
  // A remotely placed project's directory on its box is keyed by folder alone,
  // so only the local replica moves. Uploads are replicated per sandbox
  // instance, which this does not reconcile.
  if (deps.isRemotePlaced(group.folder) && transition.uploads) {
    return refuse(
      `Project "${group.folder}" is placed on a remote CarapaBox and the change would move its uploads between sandbox instances, which is not supported there.`,
    );
  }
  if (transition.refusals?.length) return refuse(transition.refusals[0]);
  const active = await deps.findActiveRun(
    transition.affected,
    transition.targets.map((target) => target.instance),
  );
  if (active) {
    return refuse(
      `Cannot change the parent while ${active}. Wait for it to finish or stop it, then try again.`,
    );
  }
  for (const target of transition.targets) {
    if (!target.fixedInstance) continue;
    let running: string[];
    try {
      running = await deps.runningStacks(target.instance);
    } catch (err) {
      return new ProjectReparentError(
        502,
        `Could not ask CarapaBox about sandbox "${target.instance}": ${String(err)}. Nothing was changed.`,
        'unchanged',
      );
    }
    if (running.length > 0) {
      return refuse(
        `Sandbox "${target.instance}" is managed outside Board and is running; Board cannot recreate it with the new mounts. Stop it first.`,
      );
    }
  }
  for (const move of dirMoves(deps, group, newParentId, transition)) {
    try {
      await deps.moveDir(move.from, move.to, { ...move.options, dryRun: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return err instanceof GroupDirConflictError
        ? refuse(
            `Cannot move ${move.from} to ${move.to}: ${reason}. Resolve them by hand, then try again.`,
          )
        : new ProjectReparentError(
            500,
            `Cannot move ${move.from} to ${move.to}: ${reason}. Nothing was changed.`,
            'unchanged',
          );
    }
  }
  return undefined;
}

/** What a transition holds, stops and checks, for comparing two of them. */
function topologyKey(transition: SandboxTransition): string {
  return JSON.stringify({
    targets: transition.targets
      .map((t) => [t.instance, t.ownerFolder, t.restart, !!t.exposure])
      .sort(),
    affected: [...transition.affected].sort(),
    uploads: transition.uploads ?? null,
    refusals: transition.refusals ?? [],
  });
}

/**
 * Change the parent of `folder` to `newParentId` (undefined clears it). The
 * caller's `persist` writes the new parent to the database and the in-memory
 * registry; it runs between the file move and the sandbox restart, and its
 * failure undoes the move and is rethrown unchanged. When the parent does not
 * change, only `persist` runs. Chat and task launches on the affected
 * instances are held from before the first check until the sandbox is verified.
 */
export async function reparentProject<T>(
  params: {
    folder: string;
    newParentId: string | undefined;
    persist: () => Promise<T>;
  },
  overrides: Partial<ReparentDeps> = {},
): Promise<ReparentOutcome<T>> {
  const { folder, newParentId, persist } = params;
  const deps: ReparentDeps = { ...(await defaultDeps()), ...overrides };
  return withReparentMutex(async () => {
    const group = deps.getGroup(folder);
    if (!group) {
      throw new ProjectReparentError(404, 'Project not found', 'unchanged');
    }
    if ((group.parentId ?? undefined) === newParentId) {
      return {
        value: await persist(),
        filesMoved: false,
        sandboxRestarted: false,
      };
    }
    // The route validated against the hierarchy as it was then; another
    // change may have finished since.
    const invalid = deps.validateParent(group, newParentId);
    if (invalid) {
      throw new ProjectReparentError(
        409,
        `${invalid} (the project hierarchy changed meanwhile). Nothing was changed.`,
        'unchanged',
      );
    }
    // Topology, children and the affected set are worked out under the mutex.
    const transition = await deps.describeSandbox(group, newParentId);
    try {
      return await deps.holdRuns(
        transition.targets.map((target) => target.instance),
        async () => {
          // Acquiring the hold may have waited for a restart or another hold.
          // What was worked out before is worked out again: only an unchanged
          // topology is the one that was checked and held.
          const current = deps.getGroup(folder) ?? group;
          const again = await deps.describeSandbox(current, newParentId);
          if (topologyKey(again) !== topologyKey(transition)) {
            throw new ProjectReparentError(
              409,
              'The sandboxes involved changed while waiting for them. Try again. Nothing was changed.',
              'unchanged',
            );
          }
          return reparentHeld(deps, current, newParentId, again, persist);
        },
      );
    } catch (err) {
      if (err instanceof Error && /still starting/.test(err.message)) {
        throw new ProjectReparentError(
          409,
          `Cannot change the parent: ${err.message}. Try again in a moment. Nothing was changed.`,
          'unchanged',
        );
      }
      throw err;
    }
  });
}

async function reparentHeld<T>(
  deps: ReparentDeps,
  group: RegisteredGroup,
  newParentId: string | undefined,
  transition: SandboxTransition,
  persist: () => Promise<T>,
): Promise<ReparentOutcome<T>> {
  // Brains start objective runs on their own; stop that before looking for
  // work, and keep them stopped until the sandboxes are back.
  const drain = await deps.drainBrains(group, newParentId, transition.affected);
  try {
    if (drain.busy) {
      throw new ProjectReparentError(
        409,
        `Cannot change the parent while ${drain.busy}. Wait for it to finish, then try again. Nothing was changed.`,
        'unchanged',
      );
    }
    return await reparentDrained(deps, group, newParentId, transition, persist);
  } finally {
    await drain.release().catch(() => undefined);
  }
}

async function reparentDrained<T>(
  deps: ReparentDeps,
  group: RegisteredGroup,
  newParentId: string | undefined,
  transition: SandboxTransition,
  persist: () => Promise<T>,
): Promise<ReparentOutcome<T>> {
  const folder = group.folder;
  const oldParentId = group.parentId ?? undefined;
  const plans = dirMoves(deps, group, newParentId, transition);
  const newDir = plans[0].to;

  const refusal = await checkWith(deps, group, newParentId, transition);
  if (refusal) throw refusal;

  // No sandbox start of the affected instances while their files move.
  const release = await deps.fenceRuns(
    transition.targets.map((target) => target.instance),
  );
  let released = false;
  const releaseOnce = () => {
    if (!released) release();
    released = true;
  };
  const states = transition.targets.map((target) => ({
    target,
    stacks: [] as string[],
  }));
  const stopped: typeof states = [];
  const moves: GroupDirMove[] = [];
  const closeMoves = () => Promise.all(moves.map((move) => move.close()));
  const rollbackMoves = async () => {
    for (const move of [...moves].reverse()) await move.rollback();
  };
  const remote = deps.isRemotePlaced(folder);
  const moveAll = async () => {
    for (const plan of plans) {
      try {
        const move = await deps.moveDir(plan.from, plan.to, plan.options);
        if (move) moves.push(move);
      } catch (err) {
        if (err instanceof GroupDirRollbackError) {
          // An earlier plan's entries are still moved; the failed one is partial.
          throw new ProjectReparentError(
            500,
            `Moving the project files failed and could not be undone: ${err.message}. The parent is still ${oldParentId ?? 'none'} in the database.`,
            'needs_attention',
          );
        }
        try {
          await rollbackMoves();
        } catch (undoErr) {
          throw new ProjectReparentError(
            500,
            `Moving ${plan.from} to ${plan.to} failed (${String(err)}) and putting the earlier moves back failed (${String(undoErr)}). The parent is still ${oldParentId ?? 'none'} in the database.`,
            'needs_attention',
          );
        }
        throw new ProjectReparentError(
          err instanceof GroupDirConflictError ? 409 : 500,
          `Could not move ${plan.from} to ${plan.to}: ${String(err)}. The files were put back and the parent was not changed.`,
          'unchanged',
        );
      }
    }
  };
  const saveOrUndo = async (): Promise<T> => {
    try {
      return await persist();
    } catch (err) {
      try {
        await rollbackMoves();
      } catch (rollbackErr) {
        logger.error(
          { folder, newDir, err: rollbackErr },
          'Reparent rollback failed',
        );
        throw new ProjectReparentError(
          500,
          `Saving the new parent failed (${String(err)}) and moving the files back failed (${String(rollbackErr)}). The project data is now at ${newDir}; the parent is still ${oldParentId ?? 'none'} in the database.`,
          'needs_attention',
        );
      }
      throw new ProjectReparentError(
        500,
        `Saving the new parent failed (${err instanceof Error ? err.message : String(err)}). The project files were moved back to ${plans[0].from} and the parent is still ${oldParentId ?? 'none'}.`,
        'restored',
        err,
      );
    }
  };
  let value: T;
  try {
    for (const state of states) {
      try {
        state.stacks = await deps.runningStacks(state.target.instance);
      } catch (err) {
        throw new ProjectReparentError(
          502,
          `Could not ask CarapaBox about sandbox "${state.target.instance}": ${String(err)}. Nothing was changed.`,
          'unchanged',
        );
      }
    }
    for (const state of states) {
      if (state.stacks.length === 0) continue;
      try {
        await deps.stopSandbox(state.target.instance, state.stacks);
        stopped.push(state);
      } catch (err) {
        throw new ProjectReparentError(
          502,
          `Could not stop the sandbox "${state.target.instance}": ${String(err)}. Nothing was changed.`,
          'unchanged',
        );
      }
    }
    if (remote) {
      // The box's copy is keyed by folder and does not move. Bring the local
      // replica up to date now that nothing writes to it.
      try {
        await deps.syncReplica(folder);
      } catch (err) {
        throw new ProjectReparentError(
          502,
          `Could not sync "${folder}" from its CarapaBox before moving it: ${String(err)}. Nothing was changed.`,
          'unchanged',
        );
      }
    }
    // A replica sync must not see the directory half-moved, and must not run
    // between the move and the registry change that tells it where to look.
    const moveAndSave = async () => {
      await moveAll();
      return saveOrUndo();
    };
    value = remote
      ? await deps.exclusive(folder, moveAndSave)
      : await moveAndSave();
  } catch (err) {
    releaseOnce();
    await closeMoves();
    if (
      err instanceof ProjectReparentError &&
      err.state === 'needs_attention'
    ) {
      throw err;
    }
    const recovery = await restartQuietly(deps, stopped);
    if (recovery.length > 0 && err instanceof ProjectReparentError) {
      throw new ProjectReparentError(
        err.status,
        `${err.message} Bringing the sandbox back up failed too: ${recovery.join('; ')}.`,
        err.state,
        err.persistCause,
      );
    }
    throw err;
  }

  releaseOnce();
  const problems: Array<{ state: ReparentState; message: string }> = [];
  const leftovers: string[] = [];
  for (const move of moves) {
    try {
      leftovers.push(...(await move.finalize()));
    } catch (err) {
      leftovers.push(String(err));
    } finally {
      await move.close();
    }
  }
  if (leftovers.length > 0) {
    logger.warn({ folder, leftovers }, 'Reparent left entries at the old path');
    problems.push({
      state: 'saved_cleanup_incomplete',
      message: `the old location still holds ${leftovers.slice(0, 5).join(', ')}${leftovers.length > 5 ? ` and ${leftovers.length - 5} more` : ''} (remove them by hand)`,
    });
  }

  const outcome: ReparentOutcome<T> = {
    value,
    filesMoved: moves.length > 0,
    sandboxRestarted: false,
  };
  const anyRunning = states.some((state) => state.stacks.length > 0);
  for (const { target, stacks: wasRunning } of states) {
    const stacks =
      wasRunning.length === 0 && anyRunning && target.ensureStack
        ? [target.ensureStack]
        : wasRunning;
    if (stacks.length === 0) continue;
    if (!target.restart) {
      logger.info(
        { folder, instance: target.instance, stacks },
        'Sandbox left stopped: the project no longer owns it',
      );
      continue;
    }
    try {
      await deps.restartSandbox(target, stacks);
      outcome.sandboxRestarted = true;
    } catch (err) {
      logger.error(
        { folder, instance: target.instance, err },
        'Sandbox did not restart after reparent',
      );
      problems.unshift({
        state: 'saved_sandbox_failed',
        message: `sandbox "${target.instance}" did not restart (${String(err)}); restart it from the project's sandbox settings`,
      });
      continue;
    }
    try {
      await deps.verifyGroupMount(target, stacks);
    } catch (err) {
      logger.error(
        { folder, instance: target.instance, err },
        'Sandbox mount not verified after reparent',
      );
      problems.unshift({
        state: 'saved_mount_unverified',
        message: `the restarted sandbox "${target.instance}" could not be verified (${String(err)})`,
      });
    }
  }
  if (problems.length > 0) {
    outcome.postSaveError = new ProjectReparentError(
      502,
      `The parent of "${folder}" is now ${newParentId ?? '(none)'} and its files are at ${newDir}, but ${problems.map((p) => p.message).join('; and ')}.`,
      problems[0].state,
    );
  }
  return outcome;
}

/**
 * Bring sandboxes stopped for an undone or refused reparent back up. Resolves
 * to what failed, for the error that reports the project's state.
 */
async function restartQuietly(
  deps: ReparentDeps,
  states: Array<{ target: SandboxTarget; stacks: string[] }>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const { target, stacks } of states) {
    if (stacks.length === 0) continue;
    try {
      await deps.restartSandbox(target, stacks);
    } catch (err) {
      logger.warn(
        { instance: target.instance, err },
        'Could not restart sandbox after reparent',
      );
      failures.push(`sandbox "${target.instance}": ${String(err)}`);
    }
  }
  return failures;
}
