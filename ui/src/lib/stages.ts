import type {
  StageDefinition,
  Project,
  ProjectSettings,
  TaskSummary,
} from '@/types';

export const DEFAULT_STAGES: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#8B8FA3' },
  { id: 'question', title: 'Question', type: 'queue', color: '#F59E02' },
  { id: 'in_progress', title: 'In Progress', type: 'active', color: '#3B82F6' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#22C55E' },
  { id: 'failed', title: 'Failed', type: 'queue', color: '#EF4444' },
];

/** Stage alternatives (`<base>.<suffix>`) run config only and are never columns. */
export function isStageAlternativeId(id: string): boolean {
  return id.includes('.');
}

export function getProjectStages(
  settings?: ProjectSettings,
): StageDefinition[] {
  const stages = settings?.stages?.length ? settings.stages : DEFAULT_STAGES;
  return stages.filter((stage) => !isStageAlternativeId(stage.id));
}

export function getEffectiveProjectStages(
  project?: Project,
): StageDefinition[] {
  const effective = project?.effectiveStages;
  if (!effective?.length) return getProjectStages(project?.settings);
  return effective.some((stage) => isStageAlternativeId(stage.id))
    ? effective.filter((stage) => !isStageAlternativeId(stage.id))
    : effective;
}

/** True when two stage rows (alternatives excluded) share an id. */
export function hasDuplicateStageIds(stages: StageDefinition[]): boolean {
  const ids = stages
    .filter((stage) => !isStageAlternativeId(stage.id))
    .map((stage) => stage.id);
  return new Set(ids).size !== ids.length;
}

/** Mirrors `STAGE_ID_PATTERN` in `src/modules/kanban/stages.ts` (the UI cannot import backend modules). */
export const STAGE_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9]{0,7})?$/;

/** True when any stage id (empty included) would be rejected by the server. */
export function hasInvalidStageIds(stages: StageDefinition[]): boolean {
  return stages.some((stage) => !STAGE_ID_PATTERN.test(stage.id));
}

export function getActiveProjectStages(
  settings?: ProjectSettings,
): StageDefinition[] {
  return getProjectStages(settings).filter((s) => !s.inactive);
}

export function findStage(
  stages: StageDefinition[],
  stageId: string,
): StageDefinition | undefined {
  return stages.find((s) => s.id === stageId);
}

type StageSortableTask = Pick<
  TaskSummary,
  'id' | 'running' | 'priority' | 'created_at' | 'completed_at'
>;

/** Return tasks in the same canonical order used by a kanban stage. */
export function sortTasksForStage<T extends StageSortableTask>(
  tasks: readonly T[],
  stage: Pick<StageDefinition, 'type'>,
): T[] {
  return [...tasks].sort((a, b) => {
    if (stage.type === 'done') {
      return (b.completed_at || '').localeCompare(a.completed_at || '');
    }

    // Running tasks always sort first within active stages. Keeping the same
    // rule for every non-done stage makes task order stable when a card moves.
    const runningOrder = Number(!a.running) - Number(!b.running);
    if (runningOrder !== 0) return runningOrder;

    return (
      a.priority - b.priority ||
      (b.created_at || '').localeCompare(a.created_at || '') ||
      b.id.localeCompare(a.id)
    );
  });
}

export function getInitialStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return (
    stages.find((s) => s.type === 'queue' && !s.inactive) ||
    stages.find((s) => !s.inactive) ||
    stages[0]
  );
}

export function getActiveStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return stages.find((s) => s.type === 'active' && !s.inactive);
}

export function getActiveExecutionStages(
  stages: StageDefinition[],
): StageDefinition[] {
  // Both active and review stages run an agent and are valid execution targets.
  return stages.filter(
    (s) =>
      (s.type === 'active' || s.type === 'testing' || s.type === 'review') &&
      !s.inactive,
  );
}

export function isActiveStage(
  stages: StageDefinition[],
  stageId: string,
): boolean {
  const stage = findStage(stages, stageId);
  return (
    (stage?.type === 'active' ||
      stage?.type === 'testing' ||
      stage?.type === 'review') &&
    !stage.inactive
  );
}
