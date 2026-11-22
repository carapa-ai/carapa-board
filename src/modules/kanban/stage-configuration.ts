import type { StageDefinition } from './types.js';
import { countProjectTasksByStatus } from './db-kanban.js';

export interface RemovedStageUsage {
  stageId: string;
  cardCount: number;
}

export interface StageMigration {
  sourceStageId: string;
  destinationStageId: string;
}

export class StageMigrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageMigrationValidationError';
  }
}

async function getOccupiedRemovedStages(
  projectId: string,
  currentStages: readonly StageDefinition[],
  prospectiveStages: readonly StageDefinition[],
  options: { excludeArchived?: boolean } = {},
): Promise<RemovedStageUsage[]> {
  const prospectiveIds = new Set(prospectiveStages.map((stage) => stage.id));
  const removedIds = currentStages
    .map((stage) => stage.id)
    .filter((id) => !prospectiveIds.has(id));
  const counts = await countProjectTasksByStatus(
    projectId,
    removedIds,
    options,
  );
  return counts.map(({ status, count }) => ({
    stageId: status,
    cardCount: count,
  }));
}

function stageRemovalConflictMessage(
  occupiedStages: readonly RemovedStageUsage[],
): string {
  const details = occupiedStages
    .map(
      ({ stageId, cardCount }) =>
        `"${stageId}" (${cardCount} ${cardCount === 1 ? 'card' : 'cards'})`,
    )
    .join(', ');
  return `Cannot remove occupied stages: ${details}. Move these cards to stages in the new pipeline first.`;
}

export class StageRemovalConflictError extends Error {
  constructor(public readonly occupiedStages: readonly RemovedStageUsage[]) {
    super(stageRemovalConflictMessage(occupiedStages));
    this.name = 'StageRemovalConflictError';
  }
}

/** Validate the explicit moves required before accepting a pipeline omission. */
export async function planStageMigrations(
  projectId: string,
  currentStages: readonly StageDefinition[],
  prospectiveStages: readonly StageDefinition[],
  migrations: readonly StageMigration[] = [],
): Promise<{
  occupiedStages: RemovedStageUsage[];
  migrations: StageMigration[];
}> {
  const currentIds = new Set(currentStages.map((stage) => stage.id));
  const prospectiveIds = new Set(prospectiveStages.map((stage) => stage.id));
  const removedIds = new Set(
    [...currentIds].filter((id) => !prospectiveIds.has(id)),
  );
  const bySource = new Map<string, StageMigration>();

  for (const migration of migrations) {
    if (
      !migration ||
      typeof migration.sourceStageId !== 'string' ||
      typeof migration.destinationStageId !== 'string' ||
      !migration.sourceStageId.trim() ||
      !migration.destinationStageId.trim()
    ) {
      throw new StageMigrationValidationError('Invalid stage migration');
    }
    const sourceStageId = migration.sourceStageId.trim();
    const destinationStageId = migration.destinationStageId.trim();
    if (!currentIds.has(sourceStageId) || !removedIds.has(sourceStageId)) {
      throw new StageMigrationValidationError(
        `Stage migration source "${sourceStageId}" is not a removed stage`,
      );
    }
    if (!prospectiveIds.has(destinationStageId)) {
      throw new StageMigrationValidationError(
        `Stage migration destination "${destinationStageId}" is not in the new pipeline`,
      );
    }
    if (bySource.has(sourceStageId)) {
      throw new StageMigrationValidationError(
        `Stage migration source "${sourceStageId}" has multiple destinations`,
      );
    }
    bySource.set(sourceStageId, { sourceStageId, destinationStageId });
  }

  const occupiedStages = await getOccupiedRemovedStages(
    projectId,
    currentStages,
    prospectiveStages,
  );
  const missing = occupiedStages.filter(
    ({ stageId }) => !bySource.has(stageId),
  );
  if (missing.length > 0) throw new StageRemovalConflictError(missing);
  return { occupiedStages, migrations: [...bySource.values()] };
}
