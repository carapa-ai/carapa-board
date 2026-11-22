import path from 'path';
import { Router } from 'express';
import { logger } from '../logger.js';
import {
  admitTranscriptMemory,
  processTranscriptMemory,
  type ProcessTranscriptMemoryOptions,
} from '../modules/memory/tool-reflector.js';
import { buildObserverChunks } from '../modules/memory/transcript-observe.js';
import { MAX_REFLECTOR_TRANSCRIPT_BYTES } from '../modules/memory/transcript-read.js';
import { GroupFsError, readGroupFile } from '../lib/group-fs.js';
import { isPathInside } from '../lib/path-containment.js';
import { getGroupDir } from '../group-dir.js';
import { userHasExplicitGroupAccess } from './_helpers.js';

const router = Router();

const BRAIN_GROUP_PREFIX = '/workspace/group/';

/**
 * Map a request `transcriptPath` to a normalized Board-local path strictly
 * inside `groupDir`, or undefined. Pure: touches no filesystem.
 */
export function resolveObservationTranscriptPath(
  transcriptPath: string,
  groupDir: string,
): string | undefined {
  const resolved = transcriptPath.startsWith(BRAIN_GROUP_PREFIX)
    ? path.join(groupDir, transcriptPath.slice(BRAIN_GROUP_PREFIX.length))
    : path.resolve(groupDir, transcriptPath);
  return isPathInside(groupDir, resolved, { allowRoot: false })
    ? resolved
    : undefined;
}

function observationObjectiveScope(
  body: unknown,
): Partial<Pick<ProcessTranscriptMemoryOptions, 'objectiveId'>> {
  if (!body || typeof body !== 'object') return {};
  if (!Object.prototype.hasOwnProperty.call(body, 'objective_id')) return {};
  const objectiveId = (body as { objective_id?: unknown }).objective_id;
  return typeof objectiveId === 'string' || objectiveId === null
    ? { objectiveId }
    : {};
}

/**
 * Translate an objective path from Brain's shared group mount into this
 * project's Board-local group directory.
 *
 * Brain uses /workspace/group/<project>/objectives/<id>, while getGroupDir()
 * already points at <project>. Strip that project segment rather than
 * duplicating it below the repository root.
 */
export function resolveObservationWorkspaceRoot(
  workspaceRoot: unknown,
  groupFolder: string,
  groupDir: string,
): string | undefined {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) return undefined;

  let resolved: string;
  if (workspaceRoot.startsWith(BRAIN_GROUP_PREFIX)) {
    const relative = workspaceRoot.slice(BRAIN_GROUP_PREFIX.length);
    const projectPrefix = `${groupFolder}/`;
    const projectRelative = relative.startsWith(projectPrefix)
      ? relative.slice(projectPrefix.length)
      : relative;
    resolved = path.resolve(groupDir, projectRelative);
  } else {
    resolved = path.resolve(groupDir, workspaceRoot);
  }

  return isPathInside(groupDir, resolved) ? resolved : undefined;
}

/**
 * POST /api/groups/:group_folder/extract-observations
 *
 * Triggers the single tool reflector by default. The legacy observer path is
 * available through the explicit rollback switch. Intended for external
 * services (e.g. carapa-brain) that have saved a JSONL transcript.
 *
 * Security: the normalized path (`..` segments collapsed) must be strictly
 * below the group directory, checked before any filesystem access. The file is
 * then read once through group-fs, which refuses symlinks, FIFOs and other
 * non-regular files, and the bytes feed the parser.
 *
 * Path resolution (see resolveObservationTranscriptPath):
 *   - Brain-side absolute paths (/workspace/group/<rel>) → re-resolved under groupDir
 *   - Other absolute paths (Board-local) → normalized, must lie under groupDir
 *   - Relative paths → resolved relative to groupDir
 */
router.post(
  '/groups/:group_folder/extract-observations',
  async (req: any, res) => {
    const { group_folder } = req.params;
    if (
      !(await userHasExplicitGroupAccess(req, group_folder, { write: true }))
    ) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }
    const { transcriptPath, byteOffset, workspaceRoot, objective_id } =
      req.body ?? {};

    if (!transcriptPath || typeof transcriptPath !== 'string') {
      return res.status(400).json({ error: 'transcriptPath is required' });
    }

    const groupDir = getGroupDir(group_folder);

    const resolvedPath = resolveObservationTranscriptPath(
      transcriptPath,
      groupDir,
    );
    if (!resolvedPath) {
      return res
        .status(400)
        .json({ error: 'Resolved path is outside the group directory' });
    }

    const resolvedWorkspaceRoot = resolveObservationWorkspaceRoot(
      workspaceRoot,
      group_folder,
      groupDir,
    );
    if (workspaceRoot && !resolvedWorkspaceRoot) {
      return res.status(400).json({
        error: 'workspaceRoot must resolve inside the requested group',
      });
    }

    const offset = byteOffset !== undefined ? Number(byteOffset) : undefined;

    try {
      let read: Awaited<ReturnType<typeof readGroupFile>>;
      try {
        read = await readGroupFile(resolvedPath, {
          maxBytes: MAX_REFLECTOR_TRANSCRIPT_BYTES,
        });
      } catch (err) {
        if (
          err instanceof GroupFsError &&
          [
            'symlink',
            'not_regular_file',
            'not_directory',
            'too_large',
            'invalid_path',
          ].includes(err.code)
        ) {
          return res.status(400).json({
            error:
              'transcriptPath must be a regular file inside the group directory',
          });
        }
        throw err;
      }
      if (!read) {
        return res.status(404).json({ error: 'Transcript not found' });
      }
      const parsed = buildObserverChunks(resolvedPath, read.data, offset);

      const reflectionOptions: ProcessTranscriptMemoryOptions = {
        byteOffset: offset,
        profile: 'run-agent-conversation',
        workspaceRoot: resolvedWorkspaceRoot,
        ...observationObjectiveScope(req.body),
      };
      const admitted = await admitTranscriptMemory(
        group_folder,
        resolvedPath,
        reflectionOptions,
      );
      const reflection = await processTranscriptMemory(
        group_folder,
        resolvedPath,
        admitted
          ? {
              ...reflectionOptions,
              byteOffset: admitted.byteOffset,
              byteEndOffset: admitted.byteEndOffset,
              admittedRunId: admitted.runId,
            }
          : reflectionOptions,
      );
      const count = reflection?.operationCount ?? 0;

      logger.info(
        {
          group_folder,
          transcriptPath,
          objective_id,
          count,
          turnCount: parsed.turnCount,
        },
        'extract-observations endpoint: done',
      );

      return res.json({
        observations: typeof reflection === 'string' ? reflection : null,
        count,
        turnCount: parsed.turnCount,
        ...(reflection && typeof reflection === 'object'
          ? {
              reflectorRunId: reflection.runId,
              completed: reflection.completed,
            }
          : {}),
      });
    } catch (err) {
      logger.error(
        { err, group_folder, transcriptPath },
        'extract-observations endpoint failed',
      );
      return res.status(500).json({ error: 'Observation extraction failed' });
    }
  },
);

export default router;
