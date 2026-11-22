import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  deleteScheduledTask,
  getScheduledTaskRunIds,
  releaseScheduledTaskDeletion,
  reserveScheduledTaskDeletion,
} from '../db-scheduling.js';
import { getGroupDir } from '../../../group-dir.js';
import {
  type PinnedDir,
  lstatAtSync,
  mkdirAtSync,
  openGroupDirSync,
  removeAtSync,
  renameAtSync,
} from '../../../lib/group-fs.js';

interface ScheduledTaskDeletionDependencies {
  getRunIds: typeof getScheduledTaskRunIds;
  deleteTask: typeof deleteScheduledTask;
}

const defaultDependencies: ScheduledTaskDeletionDependencies = {
  getRunIds: getScheduledTaskRunIds,
  deleteTask: deleteScheduledTask,
};

/** File name shared by the transcript directory and the staging directory. */
type StagedArtifact = { name: string };

function restoreArtifacts(
  artifacts: StagedArtifact[],
  transcripts: PinnedDir | null,
  stage: PinnedDir | null,
): Error | null {
  let firstError: Error | null = null;
  if (!transcripts || !stage) return firstError;
  for (const artifact of [...artifacts].reverse()) {
    try {
      if (lstatAtSync(stage, artifact.name)) {
        renameAtSync(stage, artifact.name, transcripts, artifact.name);
      }
    } catch (err) {
      firstError ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  return firstError;
}

/** Delete canonical history and every linked immutable transcript artifact. */
export async function deleteScheduledTaskWithTranscripts(
  taskId: string,
  groupFolder: string,
  dependencies: ScheduledTaskDeletionDependencies = defaultDependencies,
): Promise<boolean> {
  const reservation = await reserveScheduledTaskDeletion(taskId);
  if (!reservation) return false;
  const transcriptDir = path.join(
    getGroupDir(groupFolder),
    'session-transcripts',
  );
  const stageRel = path.posix.join('.scheduled-task-deletions', randomUUID());
  const stagedArtifacts: StagedArtifact[] = [];
  // session-transcripts is agent-writable: every move names its entries
  // through these pinned directories, so a swapped directory or planted link
  // cannot redirect a rename outside the group.
  let transcripts: PinnedDir | null = null;
  let stage: PinnedDir | null = null;
  try {
    transcripts = openGroupDirSync(groupFolder, 'session-transcripts');
    const pinned = transcripts;
    const runIds = await dependencies.getRunIds(taskId);
    // No transcript directory means no artifacts to stage.
    for (const runId of runIds) {
      if (!pinned) break;
      for (const suffix of [
        '.jsonl',
        '.prompt.txt',
        '.system.txt',
        '.acp.raw.jsonl',
        '.codex.raw.jsonl',
        '.omp.raw.jsonl',
        '.opencode.raw.jsonl',
        '.pi.raw.jsonl',
        '.v1.jsonl',
        '.v1.meta.json',
      ]) {
        const name = `${runId}${suffix}`;
        const stat = lstatAtSync(pinned, name);
        if (!stat) continue;
        if (!stat.isFile()) {
          throw new Error(
            `Scheduled transcript artifact is not a file: ${path.join(transcriptDir, name)}`,
          );
        }
        stage ??= mkdirAtSync(pinned, stageRel);
        renameAtSync(pinned, name, stage, name);
        stagedArtifacts.push({ name });
      }
    }
    await dependencies.deleteTask(taskId);
  } catch (err) {
    const restoreError = restoreArtifacts(stagedArtifacts, transcripts, stage);
    let releaseError: unknown;
    try {
      await releaseScheduledTaskDeletion(reservation);
    } catch (releaseErr) {
      releaseError = releaseErr;
    }
    stage?.closeSync();
    transcripts?.closeSync();
    throw restoreError ?? releaseError ?? err;
  }
  // Database ownership is gone, so staged artifacts can no longer be restored
  // to a live task. Cleanup is best-effort; a leftover staging directory is
  // inert and remains distinguishable from readable transcript files.
  try {
    if (transcripts && stage) {
      removeAtSync(transcripts, stageRel, { recursive: true });
    }
  } catch {
    // Ownership deletion already committed. Leave the clearly staged artifact
    // for an operational filesystem sweep rather than report a retryable task
    // deletion failure after the task no longer exists.
  } finally {
    stage?.closeSync();
    transcripts?.closeSync();
  }
  return true;
}
