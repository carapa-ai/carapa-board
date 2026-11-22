/**
 * Pure helpers used by the boot-time recovery sweep in index.ts.
 * Keeping them in a separate module makes them independently testable
 * without initialising the database or the full server.
 */

import fs from 'fs';
import path from 'path';

export interface RecoveredScheduledRunOutcome {
  status: 'success' | 'error';
  error: string | null;
  resultSummary: string;
}

export interface OrphanedRunMetadata {
  groupFolder?: string;
  taskId?: string;
  conversationId?: string;
  sessionId?: string;
}

/**
 * Classify a scheduled run recovered after restart.
 *
 * Process failure is authoritative even when the agent emitted a result before
 * exiting non-zero. Preserve the existing missing-result handling and summary
 * shape used by recovery.
 */
export function getRecoveredScheduledRunOutcome(
  result: string | null,
  isError: boolean,
): RecoveredScheduledRunOutcome {
  const resultSummary = result?.slice(0, 200) || 'Recovered after restart';

  if (isError) {
    return {
      status: 'error',
      error: 'Agent exited with error during restart',
      resultSummary,
    };
  }

  if (!result) {
    return {
      status: 'error',
      error: 'Recovered after restart',
      resultSummary,
    };
  }

  return {
    status: 'success',
    error: null,
    resultSummary,
  };
}

/**
 * Identifiers read from an agent-writable run directory become path segments
 * of transcript files, so only plain file-name-safe tokens are accepted.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Read the launch identity needed to route orphaned output to its transcript.
 * run dirs are writable by the agent, so args.json is untrusted: its identity
 * is used only when its groupFolder is in `allowedGroupFolders`, and each id
 * must be a safe path token (an unsafe field is treated as absent).
 */
export function resolveOrphanedRunMetadata(
  runPath: string,
  ipcDirName: string,
  allowedGroupFolders: Iterable<string> = [],
): OrphanedRunMetadata {
  const allowed = new Set(allowedGroupFolders);
  try {
    const args = JSON.parse(
      fs.readFileSync(path.join(runPath, 'args.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const groupFolder = args.groupFolder;
    if (typeof groupFolder === 'string' && allowed.has(groupFolder)) {
      const idField = (field: string) => {
        const value = args[field];
        return typeof value === 'string' && SAFE_RUN_ID.test(value)
          ? value
          : undefined;
      };
      return {
        groupFolder,
        taskId: idField('taskId'),
        conversationId: idField('conversationId'),
        sessionId: idField('sessionId'),
      };
    }
  } catch {
    // args.json missing or malformed — fall through to ipcDir heuristic
  }

  const fromDir = resolveGroupFolderFromIpcDir(ipcDirName, allowed);
  return { groupFolder: fromDir && allowed.has(fromDir) ? fromDir : undefined };
}

/** Resolve a group folder from a `{stack}-{instance}` IPC directory name. */
export function resolveGroupFolderFromIpcDir(
  ipcDirName: string,
  knownGroupFolders: Iterable<string> = [],
): string | undefined {
  // Stack names may contain dashes (the default is `carapa-bot`). Prefer a
  // registered group suffix so `carapa-bot-my-project` resolves to
  // `my-project`, not `bot-my-project`.
  let matchingGroup: string | undefined;
  for (const folder of knownGroupFolders) {
    if (
      typeof folder === 'string' &&
      folder.length > (matchingGroup?.length ?? 0) &&
      (ipcDirName === folder || ipcDirName.endsWith(`-${folder}`))
    ) {
      matchingGroup = folder;
    }
  }
  if (matchingGroup) return matchingGroup;

  // Legacy fallback when the group is not registered.
  const fromDir = ipcDirName.replace(/^[^-]+-/, '');
  return fromDir || undefined;
}
