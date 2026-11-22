import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { activeRuns, objectives, tasks } from '../../db/schema.js';
import { getObjectiveDir } from './objective-folder.js';
import { logger } from '../../logger.js';
import { aggregateRunStats } from './objective-run-stats.js';

/** Sum every priced run belonging to a task linked to this objective. */
async function getObjectiveTaskCostUsd(objectiveId: string): Promise<number> {
  const rows = await drizzleDbRef.current
    .select({ costUsd: sql<number | null>`sum(${activeRuns.cost_usd})` })
    .from(tasks)
    .leftJoin(activeRuns, eq(activeRuns.task_id, tasks.id))
    .where(eq(tasks.objective_id, objectiveId));
  const value = rows[0]?.costUsd;
  return value == null ? 0 : Number(value);
}

export async function refreshObjectiveTaskCost(
  projectId: string,
  objectiveId: string,
): Promise<number> {
  const objectiveRows = await drizzleDbRef.current
    .select({ projectId: objectives.project_id })
    .from(objectives)
    .where(eq(objectives.id, objectiveId))
    .limit(1);
  const ownerProjectId = objectiveRows[0]?.projectId ?? projectId;
  const taskCostUsd = await getObjectiveTaskCostUsd(objectiveId);
  // Publish metrics and report together through the per-objective refresh queue.
  try {
    await aggregateRunStats(
      getObjectiveDir(ownerProjectId, objectiveId),
      ownerProjectId,
      objectiveId,
    );
  } catch (err) {
    logger.warn(
      { err, projectId: ownerProjectId, objectiveId },
      'Failed to refresh linked task cost for objective',
    );
  }
  return taskCostUsd;
}

/** Refresh the owning objective, if the run belongs to a linked task. */
export async function refreshObjectiveTaskCostForRun(
  runId: string,
): Promise<void> {
  const owner = await drizzleDbRef.current
    .select({
      objectiveId: tasks.objective_id,
    })
    .from(activeRuns)
    .innerJoin(tasks, eq(activeRuns.task_id, tasks.id))
    .where(and(eq(activeRuns.id, runId), isNotNull(tasks.objective_id)))
    .limit(1);
  if (owner[0]?.objectiveId) {
    await refreshObjectiveTaskCost('', owner[0].objectiveId);
  }
}
