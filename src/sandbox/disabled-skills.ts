import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getGroupDir } from '../group-dir.js';
import { logger } from '../logger.js';
import { serialize } from '../lib/serial-queue.js';
import { registeredGroups, getGroupByFolder } from '../state-manager.js';
import { refreshAgentView } from '../modules/proposals/executor.js';
import { groupReplica } from './ipc-replica.js';
import { GROUPS_DIR } from '../config.js';
import { isPathInside } from '../lib/path-containment.js';
import { ProposalValidationError } from '../modules/proposals/actions.js';
import { fdPath, openChain } from '../modules/proposals/safe-fs.js';
import { resolveEffectiveSandbox } from './effective-settings.js';

/** Per-project file the container's `carapa-agent-view refresh` reads. */
const DISABLED_SKILLS_DIR = '.carapa';
const DISABLED_SKILLS_FILE = 'disabled-skills.json';
const REFRESH_TIMEOUT_SECONDS = 30;

/** Trimmed, de-duplicated, sorted skill names; anything that is not a string is dropped. */
export function normalizeDisabledSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)].sort();
}

/** Where a project's disabled-skills file lives, as its container mounts it. */
interface SkillsTarget {
  /** Project whose setting the container reads (the shared-sandbox owner). */
  ownerFolder: string;
  /** Board-side directory mounted at `/workspace/group` in that container. */
  baseDir: string;
  file: string;
}

/**
 * Resolve the file the project's container reads at
 * `/workspace/group/.carapa/disabled-skills.json`. This mirrors the
 * `GROUP_DIR` mount in `buildSandboxEnv`: a child sharing its parent's sandbox
 * mounts the owner's directory, everything else its own.
 */
function resolveSkillsTarget(folder: string): SkillsTarget | undefined {
  const group = getGroupByFolder(folder);
  if (!group) return undefined;
  const { owner } = resolveEffectiveSandbox(group);
  const baseDir = getGroupDir(owner.folder);
  return {
    ownerFolder: owner.folder,
    baseDir,
    file: path.join(baseDir, DISABLED_SKILLS_DIR, DISABLED_SKILLS_FILE),
  };
}

/**
 * The list the project's container applies. A project that shares its parent's
 * sandbox runs in the owner's container, so the owner's list is the effective
 * one and the child's own `disabledSkills` has no effect.
 */
export function getDisabledSkills(folder: string): string[] {
  const owner = resolveSkillsTarget(folder)?.ownerFolder ?? folder;
  return normalizeDisabledSkills(
    getGroupByFolder(owner)?.settings?.disabledSkills,
  );
}

/** Remove disabled skills from a slash-command list; non-skill commands are kept. */
export function withoutDisabledSkills<T extends { name: string; type: string }>(
  commands: T[],
  disabled: string[],
): T[] {
  if (!disabled.length) return commands;
  const hidden = new Set(disabled);
  return commands.filter((c) => c.type !== 'skill' || !hidden.has(c.name));
}

/** What `syncSkillsFile` did, so callers know whether containers are stale. */
interface DisabledSkillsSync {
  /** The file was (re)written. */
  written: boolean;
  /** The list differs from what the file said before (a missing file means none). */
  listChanged: boolean;
}

function skillsFileContent(list: string[]): string {
  return `${JSON.stringify({ disabledSkills: list }, null, 2)}\n`;
}

const MAX_DISABLED_SKILLS_FILE_BYTES = 256 * 1024;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

/**
 * The file's current text, or null when it is missing or not a plain bounded
 * regular file. The leaf is agent-writable: it is opened with O_NOFOLLOW |
 * O_NONBLOCK (a symlink is refused and a FIFO cannot hang the open) and
 * verified on the descriptor before reading.
 */
async function readSkillsFile(file: string): Promise<string | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_DISABLED_SKILLS_FILE_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function listFromFile(text: string | null): string[] {
  if (text === null) return [];
  try {
    return normalizeDisabledSkills(JSON.parse(text)?.disabledSkills);
  } catch {
    return [];
  }
}

/**
 * Write the container-visible `.carapa/disabled-skills.json` when it is
 * missing or differs from the effective setting. The write is atomic (temp
 * file + rename) so the container never reads a partial file. An empty list
 * still writes the file. Callers that can overlap must go through
 * `reconcileDisabledSkills`, which orders writes per file.
 *
 * The project folder is agent-writable and a surviving agent can swap any
 * directory below the groups root for a symlink at any moment. Every
 * directory down to `.carapa` is therefore opened with O_NOFOLLOW and held
 * open, and the read, temporary file and rename all go through that
 * descriptor (`/proc/self/fd/<n>`), so they stay on the verified inode.
 */
async function syncSkillsFile(
  target: SkillsTarget,
  list: string[],
): Promise<DisabledSkillsSync> {
  const content = skillsFileContent(list);
  const unchanged: DisabledSkillsSync = { written: false, listChanged: false };
  const targetDir = path.dirname(target.file);
  if (!isPathInside(GROUPS_DIR, targetDir, { allowRoot: false })) {
    logger.warn(
      { file: target.file },
      'Disabled-skills file is outside groups',
    );
    return unchanged;
  }
  const segments = path
    .relative(GROUPS_DIR, targetDir)
    .split(path.sep)
    .filter(Boolean);

  await fsp.mkdir(GROUPS_DIR, { recursive: true });
  let dir: fsp.FileHandle | null;
  try {
    dir = await openChain(GROUPS_DIR, segments, true);
  } catch (err) {
    if (!(err instanceof ProposalValidationError)) throw err;
    logger.warn(
      { file: target.file },
      'Refusing disabled-skills write via link',
    );
    return unchanged;
  }
  if (!dir) return unchanged;
  try {
    const leaf = `${fdPath(dir)}/${DISABLED_SKILLS_FILE}`;
    const current = await readSkillsFile(leaf);
    if (current === content) return unchanged;
    const listChanged =
      JSON.stringify(listFromFile(current)) !== JSON.stringify(list);
    const temporary = `${leaf}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(temporary, content, { mode: 0o644, flag: 'wx' });
      await fsp.rename(temporary, leaf);
    } catch (err) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw err;
    }
    return { written: true, listChanged };
  } finally {
    await dir.close().catch(() => undefined);
  }
}

/**
 * Ask every running sandbox that owns the project's instance to rebuild its
 * container-local skill and rule links (stopped instances refresh at start).
 * Never throws: a failure is logged and must not fail the caller.
 */
export async function refreshProjectAgentView(folder: string): Promise<void> {
  const outcome = await refreshAgentView(folder, REFRESH_TIMEOUT_SECONDS);
  if (/failed/i.test(outcome)) logger.warn({ folder, outcome }, outcome);
}

/** Files written locally that could not yet be pushed to a remote box. */
const unpushed = new Map<string, string>();
/**
 * Files (mapped to the owning project) whose list changed but whose running
 * containers have not been refreshed yet, because the push to a remote box
 * failed (typically a box that has not reconnected since boot).
 */
const pendingRefresh = new Map<string, { owner: string }>();

/**
 * Bring the container-visible `disabled-skills.json` in line with the
 * project's current effective setting and refresh its running containers.
 * Work is serialized per file and reads the setting inside the queue, so
 * overlapping saves end with the latest list in the file and a refresh after
 * it. For a project on a remote box the file is pushed through the group
 * replica before any refresh. Never rejects.
 *
 * `written` settles once the file (and its replica push) is done; `done` once
 * the refresh has finished too.
 */
export function reconcileDisabledSkills(folder: string): {
  written: Promise<void>;
  done: Promise<void>;
} {
  let target: SkillsTarget | undefined;
  try {
    target = resolveSkillsTarget(folder);
  } catch (err) {
    logger.error({ folder, err }, 'Failed to resolve disabled-skills file');
  }
  if (!target) return { written: Promise.resolve(), done: Promise.resolve() };
  const { file, ownerFolder } = target;
  const written = serialize(`disabled-skills:${file}`, async () => {
    try {
      const list = getDisabledSkills(folder);
      const sync = await syncSkillsFile(target, list);
      // Remember the stale containers before anything that can fail, so a
      // push error cannot drop the refresh.
      if (sync.listChanged) pendingRefresh.set(file, { owner: ownerFolder });
      if (sync.written || unpushed.has(file)) {
        unpushed.set(file, ownerFolder);
        // Maps to the owner's project (nested directories included); a
        // local project is a no-op.
        await groupReplica.flushPath(file, { strict: true });
        unpushed.delete(file);
      }
      return pendingRefresh.get(file);
    } catch (err) {
      logger.error({ folder, err }, 'Failed to write disabled-skills file');
      return undefined;
    }
  });
  const done = written.then((pending) =>
    pending
      ? serialize(`disabled-skills:${file}`, () => {
          // Consume only the intent this refresh was queued for: a later save
          // whose push failed has replaced it and must keep its own.
          if (pendingRefresh.get(file) === pending) pendingRefresh.delete(file);
          return refreshProjectAgentView(ownerFolder);
        })
      : undefined,
  );
  return { written: written.then(() => undefined), done };
}

/**
 * Retry files whose push to a remote box failed (the box was offline at boot),
 * then refresh their containers. Call after a box reconnects and its group
 * trees are synced. Resolves when every retry, including refreshes, finished.
 */
export async function replayPendingDisabledSkills(): Promise<void> {
  const owners = new Set([
    ...unpushed.values(),
    ...[...pendingRefresh.values()].map((pending) => pending.owner),
  ]);
  await Promise.all(
    [...owners].map((owner) => reconcileDisabledSkills(owner).done),
  );
}

/**
 * Boot-time pass: make every project's file match its setting, then refresh
 * containers that survived the restart with a stale list. Resolves when the
 * files are in place; refreshes continue in the background.
 */
export async function syncAllDisabledSkillsFiles(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const group of Object.values(registeredGroups)) {
    if (!fs.existsSync(getGroupDir(group.folder))) continue;
    const { written, done } = reconcileDisabledSkills(group.folder);
    await written;
    pending.push(done);
  }
  void Promise.all(pending);
}
