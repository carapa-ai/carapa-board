/**
 * Move an objective to another project, keeping its ID. The objective row, all
 * of its memories (with their sidecars), the Neo4j vectors, the objective
 * folder and its conversations follow it. A conversation's live transcript and
 * index sidecar are moved to the target `transcripts/` dir, an archived one is
 * restored there from the source bundles (which stay untouched). Proposals,
 * notifications and dashboards stay in the source project. Callers check
 * permissions.
 *
 * Calling it again for an objective that already sits in the target project
 * completes whichever steps (vector store, folder, conversations) did not
 * finish before. With nothing unfinished it still moves conversations of the
 * objective that an earlier move left in another project (backfill), provided
 * the caller can write to that project.
 */

import {
  getObjective,
  getObjectiveConversationsOutside,
  getObjectiveMemoryIds,
  hasRunningRunInConversations,
  clearObjectiveMoveSource,
  getObjectiveMoveState,
  moveObjectiveToProject,
  type ObjectiveMoveState,
} from './db-objectives.js';
import { objectiveWorkDirFor } from './work-dir.js';
import {
  getObjectiveDir,
  hasObjectiveFolderLeftover,
  isObjectiveFolderInPlace,
  lstatObjectiveFolder,
  moveObjectiveFolder,
  writeObjectiveContext,
} from './objective-folder.js';
import {
  publishEventWithOutcome,
  type PublishEventOutcome,
  resolveBrainContainer,
  resolveBrainUrl,
} from './brain-client.js';
import { GroupFsError } from '../../lib/group-fs.js';
import { broadcast } from './ws-events.js';
import { getGroupByFolder } from '../../state-manager.js';
import {
  moveObjectiveConversations,
  type ConversationMoveReport,
} from './move-objective-conversations.js';
import { withMemoryLifecycleLock } from '../memory/lifecycle-lock.js';
import { getPrivacyErasureEpoch } from '../memory/privacy-epoch.js';
import { getVectorStoreHooks } from '../vector-store/hooks.js';
import { logger } from '../../logger.js';
import type { Objective } from './types.js';

export class ObjectiveMoveError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface ObjectiveMoveResult extends ConversationMoveReport {
  objective: Objective;
  movedMemories: number;
  vectorStoreUpdated: boolean;
  folderMoved: boolean;
  /** False when the objective-context.md rewrite failed or was refused. */
  contextUpdated: boolean;
  /** Result of publishing `objective_created` to the target brain. */
  notified: PublishEventOutcome | 'pending';
}

/** Whether the objective's brain agent is mid-run (events.jsonl vs run-stats.jsonl). */
async function isBrainAgentRunning(objectiveDir: string): Promise<boolean> {
  // Imported lazily: the objectives router imports this module.
  const { detectAgentRunning, invalidateRunningCache } =
    await import('../../routes/objectives.js');
  invalidateRunningCache(objectiveDir);
  return detectAgentRunning(objectiveDir);
}

/** Hold the memory lifecycle lock of each folder, acquired in the given order. */
function withLifecycleLocks<T>(
  folders: string[],
  operation: () => Promise<T>,
): Promise<T> {
  if (folders.length === 0) return operation();
  const [first, ...rest] = folders;
  return withMemoryLifecycleLock(first, () =>
    withLifecycleLocks(rest, operation),
  );
}

function activeRunError(objective_id: string): ObjectiveMoveError {
  return new ObjectiveMoveError(
    409,
    `Objective "${objective_id}" has an active run. Wait for it to finish or stop it, then move the objective.`,
  );
}

/** Refusals decided by database state; also re-run inside the move transaction. */
function assertMovableState(
  objective_id: string,
  state: ObjectiveMoveState,
): void {
  if (state.moveSourceProject) {
    throw new ObjectiveMoveError(
      409,
      `A previous move of objective "${objective_id}" from "${state.moveSourceProject}" has unfinished steps. Repeat that move first.`,
    );
  }
  if (state.status === 'active') {
    throw new ObjectiveMoveError(
      409,
      `Objective "${objective_id}" is active. Pause it before moving it.`,
    );
  }
  if (state.runActive) {
    throw activeRunError(objective_id);
  }
  if (state.cronjobIds.length > 0 || state.datasetTaskIds.length > 0) {
    const parts = [
      state.cronjobIds.length > 0 && `cronjobs: ${state.cronjobIds.join(', ')}`,
      state.datasetTaskIds.length > 0 &&
        `dataset tasks: ${state.datasetTaskIds.join(', ')}`,
    ].filter(Boolean);
    throw new ObjectiveMoveError(
      409,
      `Objective "${objective_id}" is still referenced by ${parts.join('; ')}. Delete or detach them first; they cannot move with the objective.`,
    );
  }
}

/** lstat of an objective folder; a path through a link is refused with a 409. */
function lstatFolderOrRefuse(project: string, objective_id: string) {
  try {
    return lstatObjectiveFolder(project, objective_id);
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    throw new ObjectiveMoveError(
      409,
      `The objective folder path in project "${project}" runs through a link or a non-directory, so it was refused.`,
    );
  }
}

async function assertMovable(
  objective: Objective,
  target_project: string,
): Promise<void> {
  const state = await getObjectiveMoveState(objective.id);
  if (!state) throw new ObjectiveMoveError(404, 'Objective not found');
  assertMovableState(objective.id, state);
  if (
    await isBrainAgentRunning(
      getObjectiveDir(objective.project_id, objective.id),
    )
  ) {
    throw activeRunError(objective.id);
  }
  if (!lstatFolderOrRefuse(objective.project_id, objective.id)?.isDirectory()) {
    throw new ObjectiveMoveError(
      409,
      `Objective "${objective.id}" has no folder in project "${objective.project_id}" (its setup never finished), so there is nothing to move and the target brain could not register it. Finish its setup there first.`,
    );
  }
  if (lstatFolderOrRefuse(target_project, objective.id)) {
    throw new ObjectiveMoveError(
      409,
      `Project "${target_project}" already has a folder for objective "${objective.id}".`,
    );
  }
}

/**
 * `sourceProject` is the project the caller addressed and was authorized for.
 * It must own the objective. Once the objective sits in the target project, the
 * source is the one stored on the objective by the move that is still
 * unfinished; `sourceProject`, when given, must match it. With nothing left to
 * finish, the call changes nothing, whatever `sourceProject` is.
 */
export async function moveObjective(params: {
  objectiveId: string;
  targetProject: string;
  sourceProject?: string;
  /**
   * Whether the caller may write objectives in a project. Asked for projects
   * other than the source and target that still hold chats of the objective.
   */
  canWriteProject: (project: string) => boolean | Promise<boolean>;
}): Promise<ObjectiveMoveResult> {
  const { objectiveId, targetProject, sourceProject, canWriteProject } = params;
  const initial = await getObjective(objectiveId);
  if (
    !initial ||
    (sourceProject &&
      ![sourceProject, targetProject].includes(initial.project_id))
  ) {
    throw new ObjectiveMoveError(404, 'Objective not found');
  }
  const targetGroup = getGroupByFolder(targetProject);
  if (!targetGroup) {
    throw new ObjectiveMoveError(404, 'Target project not found');
  }
  if (sourceProject === targetProject) {
    throw new ObjectiveMoveError(
      400,
      'Target project must be different from the source project',
    );
  }

  const alreadyInTarget = initial.project_id === targetProject;
  if (!alreadyInTarget) {
    if (sourceProject && initial.project_id !== sourceProject) {
      throw new ObjectiveMoveError(
        409,
        `Objective "${objectiveId}" belongs to project "${initial.project_id}", not "${sourceProject}".`,
      );
    }
    await assertMovable(initial, targetProject);
  }
  const source = alreadyInTarget
    ? (initial.move_source_project ?? undefined)
    : initial.project_id;
  // With nothing left to finish any source is accepted, so repeating a
  // completed request is a no-op; an unfinished move must match its source.
  if (alreadyInTarget && sourceProject && source && sourceProject !== source) {
    throw new ObjectiveMoveError(
      409,
      `Objective "${objectiveId}" was moved from "${source}", not "${sourceProject}".`,
    );
  }

  // Fixed lock order (sorted folder names) keeps concurrent opposite moves
  // from deadlocking.
  const lockOrder = [...new Set([source, targetProject])]
    .filter((folder): folder is string => !!folder)
    .sort();
  return withLifecycleLocks(lockOrder, async () => {
    // Re-read under the locks: the objective may have changed while waiting.
    const objective = await getObjective(objectiveId);
    if (!objective) throw new ObjectiveMoveError(404, 'Objective not found');
    const moveDb = objective.project_id !== targetProject;
    if (moveDb) {
      if (objective.project_id !== source) {
        throw new ObjectiveMoveError(
          409,
          `Objective "${objectiveId}" moved to project "${objective.project_id}" meanwhile.`,
        );
      }
      await assertMovable(objective, targetProject);
    } else if ((objective.move_source_project ?? undefined) !== source) {
      throw new ObjectiveMoveError(
        409,
        `Objective "${objectiveId}" changed meanwhile. Try again.`,
      );
    }

    // Refuse before anything changes: chats in a project the caller cannot
    // write to, or (backfill) with a run in progress. A move checks runs in
    // its own transaction.
    const leftovers = await getObjectiveConversationsOutside(
      objectiveId,
      targetProject,
    );
    for (const project of new Set(leftovers.map((c) => c.group_folder))) {
      if (project !== source && !(await canWriteProject(project))) {
        throw new ObjectiveMoveError(
          403,
          `Objective "${objectiveId}" has conversations in project "${project}"; moving them needs write access to it too.`,
        );
      }
    }
    if (
      !moveDb &&
      (await hasRunningRunInConversations(leftovers.map((c) => c.id)))
    ) {
      throw activeRunError(objectiveId);
    }

    let moved = objective;
    let memoryIds: string[];
    if (moveDb) {
      const epochs = lockOrder.map((folder) => getPrivacyErasureEpoch(folder));
      const result = await moveObjectiveToProject(
        objectiveId,
        source!,
        targetProject,
        objectiveWorkDirFor(targetGroup, objectiveId),
        (state) => {
          if (!state) throw new ObjectiveMoveError(404, 'Objective not found');
          assertMovableState(objectiveId, state);
        },
        () => {
          if (
            lockOrder.some(
              (folder, i) => getPrivacyErasureEpoch(folder) !== epochs[i],
            )
          ) {
            throw new ObjectiveMoveError(
              409,
              'A privacy erasure started during the move; nothing was changed. Try again.',
            );
          }
        },
      );
      moved = result.objective ?? objective;
      memoryIds = result.memoryIds;
    } else {
      memoryIds = await getObjectiveMemoryIds(objectiveId);
    }

    // No unfinished move: only chats an earlier move left elsewhere (if any)
    // are moved, otherwise a repeated call is a no-op.
    if (!source) {
      const conversations =
        leftovers.length > 0
          ? await moveObjectiveConversations(objectiveId, targetProject)
          : EMPTY_CONVERSATION_REPORT;
      if (leftovers.length > 0) {
        logger.info(
          { objective_id: objectiveId, targetProject, ...conversations },
          'Objective conversations moved',
        );
      }
      return {
        objective: moved,
        movedMemories: memoryIds.length,
        vectorStoreUpdated: true,
        folderMoved: false,
        contextUpdated: true,
        notified: 'skipped',
        ...conversations,
      };
    }

    // One report of the post-commit steps. The response, the decision to clear
    // `move_source_project` and the broadcast all derive from it, so a repeated
    // call completes whatever the report shows as unfinished.
    const report = await runPostCommitSteps({
      objective: moved,
      memoryIds,
      source,
      targetProject,
      targetGroup,
    });
    const stepsDone =
      report.vectorStoreUpdated &&
      report.folderSettled &&
      report.contextUpdated &&
      report.notified !== 'pending' &&
      report.notified !== 'failed' &&
      report.conversations.conversationStepComplete;
    if (stepsDone) {
      await clearObjectiveMoveSource(objectiveId);
      moved = (await getObjective(objectiveId)) ?? moved;
    }
    if (moveDb || report.folderMoved) {
      for (const project_id of [source, targetProject]) {
        broadcast({
          type: 'objective_updated',
          payload: { project_id, objective: moved },
        });
      }
    }
    logger.info(
      {
        objective_id: objectiveId,
        source,
        targetProject,
        movedMemories: memoryIds.length,
        stepsDone,
        ...report,
      },
      'Objective moved',
    );
    return {
      objective: moved,
      movedMemories: memoryIds.length,
      vectorStoreUpdated: report.vectorStoreUpdated,
      folderMoved: report.folderMoved,
      contextUpdated: report.contextUpdated,
      notified: report.notified,
      ...report.conversations,
    };
  });
}

const EMPTY_CONVERSATION_REPORT: ConversationMoveReport = {
  movedConversations: 0,
  skippedTranscripts: 0,
  conversationStepComplete: true,
};

interface PostCommitReport {
  vectorStoreUpdated: boolean;
  /** The folder moved in this call and nothing of it is left in the source. */
  folderMoved: boolean;
  /** Nothing of the folder is left in the source project. */
  folderSettled: boolean;
  contextUpdated: boolean;
  /** `pending`: not attempted yet because an earlier step is unfinished. */
  notified: PublishEventOutcome | 'pending';
  conversations: ConversationMoveReport;
}

/** Vector store, conversations, folder, context file and brain registration. */
async function runPostCommitSteps(input: {
  objective: Objective;
  memoryIds: string[];
  source: string;
  targetProject: string;
  targetGroup: NonNullable<ReturnType<typeof getGroupByFolder>>;
}): Promise<PostCommitReport> {
  const { objective, memoryIds, source, targetProject, targetGroup } = input;
  const log = { objective_id: objective.id, source, targetProject };

  let vectorStoreUpdated = true;
  const hooks = getVectorStoreHooks();
  if (hooks?.moveObjectiveMemoryScope && memoryIds.length > 0) {
    try {
      if (!hooks.isAvailable()) throw new Error('vector store unavailable');
      await hooks.moveObjectiveMemoryScope(memoryIds, targetProject);
    } catch (err) {
      vectorStoreUpdated = false;
      logger.warn(
        { err, ...log },
        'Objective memories moved, but the vector store update failed',
      );
    }
  }

  const conversations = await moveObjectiveConversations(
    objective.id,
    targetProject,
  );

  let folderChanged = false;
  try {
    folderChanged = moveObjectiveFolder(
      source,
      targetProject,
      objective.id,
    ).moved;
  } catch (err) {
    logger.error(
      { err, ...log },
      'Objective moved, but its folder could not be moved',
    );
  }
  const folderSettled = !hasObjectiveFolderLeftover(source, objective.id);
  const folderInTarget = isObjectiveFolderInPlace(targetProject, objective.id);

  // The target brain registers the objective only once its folder is in place
  // and names the target project.
  let contextUpdated = true;
  if (folderInTarget) {
    try {
      contextUpdated = await writeObjectiveContext(targetProject, objective);
    } catch (err) {
      contextUpdated = false;
      logger.error(
        { err, ...log },
        'Objective moved, but its context file could not be rewritten',
      );
    }
  }

  let notified: PostCommitReport['notified'] = 'pending';
  if (!folderInTarget) {
    notified = 'skipped'; // nothing for the brain to register
  } else if (folderSettled && contextUpdated) {
    notified = await publishEventWithOutcome(
      resolveBrainUrl(resolveBrainContainer(targetGroup)),
      {
        type: 'objective_created',
        project_id: targetProject,
        task_id: null,
        objective_id: objective.id,
        timestamp: new Date().toISOString(),
        data: {
          title: objective.title,
          status: objective.status,
          priority: objective.priority,
        },
      },
      targetGroup,
    );
  }
  return {
    vectorStoreUpdated,
    folderMoved: folderChanged && folderSettled,
    folderSettled,
    contextUpdated,
    notified,
    conversations,
  };
}
