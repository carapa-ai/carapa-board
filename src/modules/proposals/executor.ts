/**
 * Applies one validated proposal action to the project/objective layer.
 *
 * Writes go to a staging path in the same directory and are renamed into
 * place, so a half-written skill is never visible. An existing symlink at the
 * item path is removed and replaced, never written through.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { logger } from '../../logger.js';
import { isSandboxRunning } from '../../sandbox/status.js';
import { resolveGroupSandbox } from '../fs/sandbox-fs.js';
import {
  itemEntryFile,
  ProposalValidationError,
  setLocalFrontmatter,
  validateAction,
  type ProposalAction,
} from './actions.js';
import { fdPath, openDirNoFollow, removeNoFollow } from './safe-fs.js';
import {
  unverifiableReason,
  withContainer,
  withCreatedContainer,
  type ItemSnapshot,
  type ItemTarget,
} from './targets.js';

export interface ExecutionOutcome {
  message: string;
  /** The set of items changed, so effective `~/.agent` views need a refresh. */
  needsRefresh: boolean;
}

const { O_RDONLY, O_NOFOLLOW } = fs.constants;

const REFRESH_COMMAND = 'carapa-agent-view refresh';
const REFRESH_TIMEOUT_SECONDS = 60;

function stagingName(): string {
  return `.proposal-${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Create `rel` (a validated relative path) below the directory held open by
 * `root`. Every parent folder is created and then opened without following
 * links before anything is written below it, so a link planted in the staging
 * tree cannot redirect the write. The file itself is created with O_EXCL.
 */
async function writeStagedFile(
  root: FileHandle,
  rel: string,
  content: string,
): Promise<void> {
  const segments = rel.split('/');
  const name = segments.pop()!;
  let current = root;
  try {
    for (const segment of segments) {
      const parent = fdPath(current);
      await fsp
        .mkdir(`${parent}/${segment}`)
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
      const next = await openDirNoFollow(parent, segment, rel);
      if (current !== root) await current.close();
      current = next;
    }
    await fsp.writeFile(`${fdPath(current)}/${name}`, content, {
      flag: 'wx',
      mode: 0o644,
    });
  } finally {
    if (current !== root) await current.close();
  }
}

/**
 * Replace the item with the staged entry, keeping the previous item until the
 * rename succeeds. Renaming moves a symlink itself, so a generated link is
 * replaced rather than written through.
 */
async function swapIntoPlace(dir: string, staging: string, item: string) {
  const backup = stagingName();
  let hadPrevious = true;
  try {
    await fsp.rename(`${dir}/${item}`, `${dir}/${backup}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    hadPrevious = false;
  }
  try {
    await fsp.rename(`${dir}/${staging}`, `${dir}/${item}`);
  } catch (err) {
    if (hadPrevious) {
      await fsp.rename(`${dir}/${backup}`, `${dir}/${item}`).catch(() => {});
    }
    throw err;
  }
  if (hadPrevious) await removeNoFollow(dir, backup);
}

// Every operation below runs against the verified container directory held
// open by withContainer (`dir` is /proc/self/fd/<n>), never a re-resolved path.

async function writeItem(
  target: ItemTarget,
  action: Extract<ProposalAction, { type: 'write_item' }>,
  snapshot: ItemSnapshot,
): Promise<ExecutionOutcome> {
  validateAction(action, target);
  await withCreatedContainer(target, async (dir) => {
    const staging = stagingName();
    try {
      if (target.kind === 'rule') {
        await fsp.writeFile(`${dir}/${staging}`, action.files[0].content, {
          flag: 'wx',
          mode: 0o644,
        });
      } else {
        await fsp.mkdir(`${dir}/${staging}`);
        const stagingDir = await openDirNoFollow(dir, staging, staging);
        try {
          for (const file of action.files) {
            await writeStagedFile(stagingDir, file.path, file.content);
          }
        } finally {
          await stagingDir.close();
        }
      }
      await swapIntoPlace(dir, staging, target.itemName);
    } catch (err) {
      await removeNoFollow(dir, staging).catch(() => {});
      throw err;
    }
  });
  const replaced = snapshot.symlink ? ' (replaced a generated link)' : '';
  return {
    message: `${snapshot.exists ? 'Updated' : 'Created'} ${target.itemPath}${replaced}`,
    needsRefresh: !snapshot.exists,
  };
}

async function deleteItem(target: ItemTarget): Promise<ExecutionOutcome> {
  const existed = await withContainer(target, false, async (dir) => {
    if (!dir) return false;
    const present = await fsp
      .lstat(`${dir}/${target.itemName}`)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
    if (!present) return false;
    await removeNoFollow(dir, target.itemName);
    return true;
  });
  return existed
    ? { message: `Deleted ${target.itemPath}`, needsRefresh: true }
    : { message: `${target.itemPath} was already absent`, needsRefresh: false };
}

async function markLocal(
  target: ItemTarget,
  snapshot: ItemSnapshot,
): Promise<ExecutionOutcome> {
  if (!snapshot.exists || snapshot.symlink) {
    throw new ProposalValidationError(
      'mark_local needs an existing local item, not a generated link',
    );
  }
  const entry = itemEntryFile(target.kind, target.name);
  await withContainer(target, false, async (dir) => {
    if (!dir) throw new ProposalValidationError('The item does not exist');
    // A skill's frontmatter file lives in its folder; open that anchored too.
    const itemDir =
      target.kind === 'skill'
        ? await openDirNoFollow(dir, target.itemName, target.itemPath)
        : null;
    try {
      const folder = itemDir ? fdPath(itemDir) : dir;
      const file = `${folder}/${itemDir ? entry : target.itemName}`;
      const stat = await fsp.lstat(file).catch(() => null);
      if (!stat?.isFile()) {
        throw new ProposalValidationError(
          `${target.itemPath} is not a regular file`,
        );
      }
      const handle = await fsp.open(file, O_RDONLY | O_NOFOLLOW);
      let current: string;
      try {
        current = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      const tmp = `${file}.${stagingName()}`;
      try {
        await fsp.writeFile(tmp, setLocalFrontmatter(current), {
          flag: 'wx',
          mode: stat.mode & 0o777,
        });
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    } finally {
      await itemDir?.close();
    }
  });
  return { message: `Marked ${target.itemPath} as local`, needsRefresh: false };
}

export async function executeAction(
  action: ProposalAction,
  target: ItemTarget,
  snapshot: ItemSnapshot,
): Promise<ExecutionOutcome> {
  const blocked = unverifiableReason(action, snapshot);
  if (blocked) throw new ProposalValidationError(blocked);
  switch (action.type) {
    case 'write_item':
      return writeItem(target, action, snapshot);
    case 'delete_item':
      return deleteItem(target);
    case 'mark_local':
      return markLocal(target, snapshot);
    case 'none':
      return { message: 'No change', needsRefresh: false };
    case 'merge_task':
      throw new ProposalValidationError(
        'merge_task cannot run on a skill or rule',
      );
    case 'set_prompt':
      throw new ProposalValidationError(
        'set_prompt cannot run on a skill or rule',
      );
  }
}

interface RefreshTarget {
  stack: string;
  /** Services to try in order; the first that runs the refresh ends the stack. */
  services: string[];
}

const NOT_RUNNING = /exit|stop|dead|paused|created|restarting/i;

/**
 * Running `service` containers of `instance` in a sandbox_ps response, which
 * lists one entry per compose project with its `services[]`. A stack running
 * the instance under an override is found here even when the configured stack
 * is stopped.
 */
function runningTargets(
  raw: string,
  instance: string,
  service: string,
): RefreshTarget[] {
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry): RefreshTarget[] => {
      const e = entry as Record<string, unknown> | null;
      const stack = typeof e?.stack === 'string' ? e.stack : e?.name;
      if (e?.instance !== instance || typeof stack !== 'string') return [];
      const services = Array.isArray(e.services) ? e.services : [];
      const runningServices = services.flatMap(
        (svc: Record<string, unknown> | null): string[] =>
          typeof svc?.service === 'string' &&
          !(typeof svc.status === 'string' && NOT_RUNNING.test(svc.status))
            ? [svc.service]
            : [],
      );
      // The configured service is the agent when it runs in this stack. A
      // stack still running under an earlier service setting has no marker
      // that identifies its agent, so every running service is tried in turn
      // until one has the command (the others fail harmlessly).
      if (runningServices.includes(service))
        return [{ stack, services: [service] }];
      return runningServices.length
        ? [{ stack, services: runningServices }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Rebuild the effective `~/.agent` views in every running sandbox that serves
 * the project's instance: its configured stack and any other stack (a runtime
 * override) currently running the same instance. Never throws: each outcome is
 * reported to the caller and a failure never undoes the write.
 */
export async function refreshAgentView(
  projectId: string,
  timeout = REFRESH_TIMEOUT_SECONDS,
): Promise<string> {
  try {
    const resolved = resolveGroupSandbox(projectId);
    const client = getSandboxClient();
    const targets = new Map<string, RefreshTarget>();
    const ps = await client.sandboxPs(resolved.instance);
    if (!ps.isError) {
      for (const t of runningTargets(
        ps.stdout,
        resolved.instance,
        resolved.service,
      )) {
        targets.set(t.stack, t);
      }
    }
    if (!targets.has(resolved.stack)) {
      const status = await client.sandboxStatus(
        resolved.stack,
        resolved.instance,
      );
      if (isSandboxRunning(status)) {
        targets.set(resolved.stack, {
          stack: resolved.stack,
          services: [resolved.service],
        });
      }
    }
    if (targets.size === 0) {
      return 'Agent view refresh skipped: no sandbox is running (it refreshes on start)';
    }
    const outcomes: string[] = [];
    for (const { stack, services } of targets.values()) {
      let failure = '';
      let refreshed = false;
      for (const service of services) {
        try {
          const result = await client.sandboxExec(
            stack,
            service,
            REFRESH_COMMAND,
            { instance: resolved.instance, timeout },
          );
          if (!result.isError) {
            refreshed = true;
            break;
          }
          failure ||= (result.stderr || result.stdout).trim().slice(0, 300);
        } catch (err) {
          failure ||= err instanceof Error ? err.message : String(err);
        }
      }
      if (refreshed) {
        outcomes.push(`${stack}: refreshed`);
      } else {
        logger.warn(
          { projectId, stack, detail: failure },
          'Proposal: refresh failed',
        );
        outcomes.push(
          `${stack}: refresh failed (${failure || 'unknown error'})`,
        );
      }
    }
    return `Agent view ${outcomes.join('; ')}`;
  } catch (err) {
    logger.warn({ err, projectId }, 'Proposal: agent view refresh failed');
    return `Agent view refresh failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
