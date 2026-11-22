import type { Project, StageDefinition, StageType, Task } from '@/types';
import { isStageAlternativeId } from '@/lib/stages';

/** Variant suffix of a stage alternative. `a` is reserved for the base stage. */
const VARIANT_SUFFIX_PATTERN = /^[a-z][a-z0-9]{0,7}$/;

/** Only these base stage types can have alternatives (mirrors the server). */
const ALTERNATIVE_BASE_TYPES: readonly StageType[] = [
  'active',
  'testing',
  'review',
];

export function canHaveStageAlternatives(
  stage: Pick<StageDefinition, 'type'>,
): boolean {
  return ALTERNATIVE_BASE_TYPES.includes(stage.type);
}

export function alternativeBaseId(id: string): string {
  return id.slice(0, id.indexOf('.'));
}

export function alternativeSuffix(id: string): string {
  return id.slice(id.indexOf('.') + 1);
}

/** The variant letter as the UI shows it (`b` → `B`). */
export function variantLabel(suffix: string): string {
  return suffix.toUpperCase();
}

/** Alternatives of one base stage, in list order. */
export function stageAlternatives(
  stages: readonly StageDefinition[],
  baseId: string,
): StageDefinition[] {
  return stages.filter(
    (stage) =>
      isStageAlternativeId(stage.id) && alternativeBaseId(stage.id) === baseId,
  );
}

/**
 * Sorted union of the suffixes with an alternative of an active base stage
 * (mirrors the server): only those can fork an A/B experiment. Review/testing
 * alternatives are chosen per task through `co_stages`.
 */
function listVariantSuffixes(
  stages: readonly StageDefinition[] | undefined,
): string[] {
  const activeIds = new Set(
    (stages ?? [])
      .filter((stage) => stage.type === 'active')
      .map((stage) => stage.id),
  );
  const suffixes = new Set<string>();
  for (const stage of stages ?? []) {
    if (
      isStageAlternativeId(stage.id) &&
      activeIds.has(alternativeBaseId(stage.id))
    ) {
      suffixes.add(alternativeSuffix(stage.id));
    }
  }
  return [...suffixes].sort();
}

/** First unused letter after `a` for a base stage's next alternative. */
export function nextFreeSuffix(
  stages: readonly StageDefinition[],
  baseId: string,
): string {
  const used = new Set(
    stageAlternatives(stages, baseId).map((stage) =>
      alternativeSuffix(stage.id),
    ),
  );
  for (let code = 'b'.charCodeAt(0); code <= 'z'.charCodeAt(0); code++) {
    const suffix = String.fromCharCode(code);
    if (!used.has(suffix)) return suffix;
  }
  for (let n = 1; ; n++) {
    if (!used.has(`b${n}`)) return `b${n}`;
  }
}

/**
 * Validate an alternative's suffix like the server does. `currentId` is the
 * alternative being renamed, which may keep its own suffix.
 */
export function validateAlternativeSuffix(
  suffix: string,
  baseId: string,
  stages: readonly StageDefinition[],
  currentId?: string,
): string | null {
  if (!VARIANT_SUFFIX_PATTERN.test(suffix)) {
    return 'Use 1–8 lowercase letters or digits, starting with a letter.';
  }
  if (suffix === 'a') {
    return '"a" is reserved for the base stage.';
  }
  const id = `${baseId}.${suffix}`;
  if (id !== currentId && stages.some((stage) => stage.id === id)) {
    return `${variantLabel(suffix)} already exists for this stage.`;
  }
  return null;
}

/**
 * Variant suffixes a project can run. The server resolves parent inheritance
 * (alternatives are stripped from `effectiveStages`), so a member who only has
 * access to a child does not need to see its parent project.
 */
export function projectVariantSuffixes(project: Project | undefined): string[] {
  return (
    project?.abVariantSuffixes ?? listVariantSuffixes(project?.settings?.stages)
  );
}

type AbFields = Pick<
  Task,
  | 'ab_variants'
  | 'abVariants'
  | 'ab_parent_task_id'
  | 'abParentTaskId'
  | 'ab_winner_task_id'
  | 'abWinnerTaskId'
  | 'ab_fork_stage'
  | 'abForkStage'
  | 'ab_fork_commit'
  | 'abForkCommit'
  | 'stage_variant'
  | 'stageVariant'
>;

export function taskAbVariants(task: AbFields): string[] {
  // Optimistic edits only set the camelCase field, so it wins even when null.
  return (
    (task.abVariants !== undefined ? task.abVariants : task.ab_variants) ?? []
  );
}

export function taskAbParentId(task: AbFields): string | null {
  return task.abParentTaskId ?? task.ab_parent_task_id ?? null;
}

export function taskAbWinnerId(task: AbFields): string | null {
  return task.abWinnerTaskId ?? task.ab_winner_task_id ?? null;
}

export function taskAbForkCommit(task: AbFields): string | null {
  return task.abForkCommit ?? task.ab_fork_commit ?? null;
}

export function taskStageVariant(task: AbFields): string | null {
  // Optimistic edits only set the camelCase field, so it wins even when null.
  return (
    (task.stageVariant !== undefined
      ? task.stageVariant
      : task.stage_variant) ?? null
  );
}

/**
 * The "Run variants" selection a card currently stands for: its A/B variants,
 * else the single variant its stage alternatives run on, else none.
 */
export function taskVariantSelection(task: AbFields): string[] {
  const variants = taskAbVariants(task);
  if (variants.length > 0) return variants;
  const stageVariant = taskStageVariant(task);
  return stageVariant ? [stageVariant] : [];
}

/** An experiment parent: two or more variants selected, or already forked. */
export function isAbParent(task: AbFields): boolean {
  return taskAbVariants(task).length >= 2 || taskAbForkCommit(task) !== null;
}

/**
 * The `ab_variants` value to send for a "Run variants" selection. Fewer than two
 * variants is not an experiment, which the server stores as null.
 */
export function abVariantsPayload(
  selected: readonly string[],
): string[] | null {
  const unique = [...new Set(selected)];
  if (unique.length < 2) return null;
  return unique.sort();
}

/**
 * The `stage_variant` value to send for a "Run variants" selection: exactly one
 * non-A variant runs the card on that stage alternative. A, none or an
 * experiment (two or more) leave the base stages, stored as null.
 */
export function stageVariantPayload(
  selected: readonly string[],
): string | null {
  const unique = [...new Set(selected)];
  return unique.length === 1 && unique[0] !== 'a' ? unique[0] : null;
}

export function sameVariantSelection(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}
