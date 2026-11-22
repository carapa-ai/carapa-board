import { logger } from '../../logger.js';
import { notifyProjectOwner } from '../tools/push-tools.js';
import { refreshObjectiveContext } from './objective-folder.js';
import {
  getObjective,
  pauseObjectiveIfCostLimitReached,
} from './db-objectives.js';
import { broadcast } from './ws-events.js';
import {
  publishObjectiveStateEvent,
  resolveBrainContainer,
  resolveBrainUrl,
} from './brain-client.js';
import { getGroupByFolder } from '../../state-manager.js';
import type { Objective } from './types.js';

/**
 * Enforce the user-owned objective cost limit at every board cost boundary.
 * The database transition is compare-and-set, so concurrent refreshes emit
 * side effects only once.
 */
export async function enforceObjectiveCostLimit(
  projectId: string,
  objectiveId: string,
  totalCostUsd: number,
): Promise<Objective | undefined> {
  if (!Number.isFinite(totalCostUsd) || totalCostUsd < 0) return undefined;
  const current = await getObjective(objectiveId);
  if (
    current?.status !== 'active' ||
    current.cost_limit_usd == null ||
    totalCostUsd < current.cost_limit_usd
  )
    return undefined;

  const paused = await pauseObjectiveIfCostLimitReached(
    objectiveId,
    totalCostUsd,
  );
  if (!paused) return undefined;

  const costLimitUsd = paused.cost_limit_usd!;
  const group = getGroupByFolder(projectId);
  await publishObjectiveStateEvent(
    resolveBrainUrl(group ? resolveBrainContainer(group) : undefined),
    {
      type: 'objective_updated',
      project_id: projectId,
      task_id: null,
      objective_id: objectiveId,
      timestamp: paused.updated_at,
      data: {
        changes: { status: 'paused' },
        reason: 'cost_limit_reached',
        totalCostUsd,
        costLimitUsd,
      },
    },
    group,
  );
  try {
    await refreshObjectiveContext(projectId, paused);
  } catch (err) {
    logger.warn(
      { err, projectId, objectiveId },
      'Failed to refresh context after objective budget pause',
    );
  }
  await notifyProjectOwner(projectId, {
    summary: `Objective paused: ${paused.title}`,
    content:
      `"${paused.title}" was automatically paused after reaching its ` +
      `$${costLimitUsd.toFixed(2)} budget. Total recorded cost: ` +
      `$${totalCostUsd.toFixed(2)}.`,
    source_id: `objective-budget:${objectiveId}:${paused.updated_at}`,
  });
  broadcast({
    type: 'objective_updated',
    payload: { project_id: projectId, objective: paused },
  });
  logger.info(
    { projectId, objectiveId, totalCostUsd, costLimitUsd },
    'Objective paused after reaching cost limit',
  );
  return paused;
}

/** Why an activation request left the objective inactive (REST and MCP share it). */
export function activationRefusalMessage(
  objective: Objective | undefined,
  totalCostUsd: number,
): string {
  return objective?.status === 'paused' &&
    objective.cost_limit_usd != null &&
    totalCostUsd >= objective.cost_limit_usd
    ? "The objective's cost limit has been reached. Raise or remove the cost limit to resume it."
    : `The objective could not be activated and remains ${objective?.status ?? 'unchanged'}.`;
}
