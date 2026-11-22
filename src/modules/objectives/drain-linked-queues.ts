import { getObjectiveTaskProjectIds } from '../../db.js';
import { logger } from '../../logger.js';
import { getGroupByFolder } from '../../state-manager.js';
import { drainProjectQueue } from '../kanban/task/pipeline.js';

/**
 * Wake cards held by the objective execution gate after the objective became
 * active. Linked cards may live in other projects than the objective, so every
 * project with a non-archived linked card is drained. Never throws: a drain
 * failure must not fail the objective update.
 */
export async function drainQueuesForObjective(
  objectiveId: string,
): Promise<void> {
  try {
    for (const projectId of await getObjectiveTaskProjectIds(objectiveId)) {
      const group = getGroupByFolder(projectId);
      if (!group) continue;
      await drainProjectQueue(projectId, group).catch((error) => {
        logger.warn(
          { err: error, objectiveId, projectId },
          'Queue drain after objective activation failed',
        );
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, objectiveId },
      'Queue drain after objective activation failed',
    );
  }
}
