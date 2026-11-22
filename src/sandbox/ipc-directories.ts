import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import type { SandboxClient } from '../lib/mcp-client.js';
import { ipcReplica } from './ipc-replica.js';
import { isSandboxStopped } from './status.js';

/**
 * Ensure the board can write run state for an instance that is about to start.
 *
 * Older/misconfigured starts may have let Docker create the bind-mount source
 * as root. The unprivileged board cannot chmod that directory, but it can move
 * the stopped instance's tree out of the way when the IPC parent is writable.
 * Preserve it for diagnostics/recovery rather than deleting runtime data.
 */
export function ensureIpcRunsDir(
  ipcDir: string,
  archiveUnwritableStoppedInstance: boolean,
): void {
  try {
    fs.mkdirSync(path.join(ipcDir, 'runs'), { recursive: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      !archiveUnwritableStoppedInstance ||
      (code !== 'EACCES' && code !== 'EPERM')
    ) {
      throw err;
    }

    const archiveDir = `${ipcDir}.stale-${Date.now()}`;
    try {
      fs.renameSync(ipcDir, archiveDir);
      fs.mkdirSync(path.join(ipcDir, 'runs'), { recursive: true });
      logger.warn(
        { ipcDir, archiveDir },
        'Archived an unwritable IPC directory before starting sandbox',
      );
    } catch (recoveryErr) {
      const recoveryCode = (recoveryErr as NodeJS.ErrnoException).code;
      throw new Error(
        `Sandbox IPC directory is not writable and could not be repaired automatically: ${ipcDir}. ` +
          'With the stack stopped, remove this directory from the host bind mount or change its ownership to the CarapaBoard user, then retry.' +
          (recoveryCode ? ` (${recoveryCode})` : ''),
        { cause: recoveryErr },
      );
    }
  }
}

/** Start error for a remote box that could not prepare a project's IPC tree. */
export function remoteIpcPreparationError(
  project: string,
  error: unknown,
): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `CarapaBox could not prepare the IPC directory for ${project} on its box: ${reason}. ` +
      "Check that box's CarapaBox log.",
  );
}

/** Repair legacy IPC storage only after a fresh, whole-stack stopped check. */
export async function prepareSandboxIpcRunsDir(
  ipcDir: string,
  client: Pick<SandboxClient, 'sandboxStatus'>,
  stack: string,
  instance?: string,
): Promise<void> {
  const project = path.basename(ipcDir);
  let remoteRepairNeeded = false;
  try {
    ensureIpcRunsDir(ipcDir, false);
    // The box-owned tree (remote, or the same directory) must be writable too.
    try {
      await ipcReplica.prepareRuns(project, false);
      return;
    } catch (error) {
      // Box-side failures never escalate to repairing the local box's tree:
      // on a single host that is Board's own directory, handled above.
      if (ipcReplica.isLocalProject(project)) {
        // An older or unreachable local Box must not block single-host starts;
        // the sandbox start itself reports real mount problems.
        logger.warn({ err: error, ipcDir }, 'Box-side IPC preparation failed');
        return;
      }
      // A remote box holds the only copy the sandbox mounts: starting without
      // it fails later with opaque replication errors.
      if (!/EACCES|EPERM/.test(String(error)))
        throw remoteIpcPreparationError(project, error);
      remoteRepairNeeded = true;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!remoteRepairNeeded && code !== 'EACCES' && code !== 'EPERM')
      throw error;
  }

  // Do not filter by agent service: a sidecar may still hold this mount.
  const status = await client.sandboxStatus(stack, instance);
  const stopped = isSandboxStopped(status);
  if (!stopped) {
    throw new Error(
      `Sandbox IPC directory is not writable: ${ipcDir}. ` +
        'Could not confirm that the entire stack is stopped; stop it before retrying IPC recovery.',
    );
  }
  ensureIpcRunsDir(ipcDir, true);
  await ipcReplica.prepareRuns(project, true);
}
