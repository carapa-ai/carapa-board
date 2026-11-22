import type { ProjectSettings, RegisteredGroup } from '../../types.js';
import type { StageDefinition, StageType, Task } from './types.js';
import {
  getGroupByFolder,
  resolveTaskCheckoutMode,
} from '../../state-manager.js';

export const DEFAULT_STAGES: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#8B8FA3' },
  { id: 'question', title: 'Question', type: 'queue', color: '#F59E02' },
  { id: 'in_progress', title: 'In Progress', type: 'active', color: '#3B82F6' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#22C55E' },
  { id: 'failed', title: 'Failed', type: 'queue', color: '#EF4444' },
];

/**
 * Stage ids: a base id (`coding`), or a stage alternative `<base>.<suffix>`
 * (`coding.b`). Alternatives are flat entries in the same stage list.
 */
export const STAGE_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9]{0,7})?$/;
const BASE_STAGE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Variant suffix of an alternative. `a` is reserved for the base stage. */
const VARIANT_SUFFIX_PATTERN = /^[a-z][a-z0-9]{0,7}$/;
const ALTERNATIVE_BASE_TYPES: readonly StageType[] = [
  'active',
  'testing',
  'review',
];
/** Only these run-config fields of an alternative override its base stage. */
const OVERRIDABLE_STAGE_KEYS = [
  'runtimeSelection',
  'mainAiUserId',
  'workerSandbox',
  'record',
  'stallTimeoutMs',
  'stallGraceMs',
] as const;

/** Whether a stage id names a stage alternative (`<base>.<suffix>`). */
export function isStageAlternativeId(id: string): boolean {
  return id.includes('.');
}

function withoutStageAlternatives(
  stages: StageDefinition[],
): StageDefinition[] {
  return stages.some((stage) => isStageAlternativeId(stage.id))
    ? stages.filter((stage) => !isStageAlternativeId(stage.id))
    : stages;
}

/** Get resolved stages for a project (uses defaults if not configured) */
export function getProjectStages(
  settings?: ProjectSettings,
): StageDefinition[] {
  return withoutStageAlternatives(
    settings?.stages?.length ? settings.stages : DEFAULT_STAGES,
  );
}

/** Resolve a group's local stages (alternatives included), falling back to its parent's stages. */
function getRawGroupStages(
  group: RegisteredGroup | undefined,
  lookup: (folder: string) => RegisteredGroup | undefined,
): StageDefinition[] {
  if (group?.settings?.stages?.length) return group.settings.stages;
  if (group?.parentId) {
    const parentStages = lookup(group.parentId)?.settings?.stages;
    if (parentStages?.length) return parentStages;
  }
  return DEFAULT_STAGES;
}

/** Resolve a group's stage columns, falling back to its parent's stages. */
export function getGroupStages(
  group?: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): StageDefinition[] {
  return withoutStageAlternatives(getRawGroupStages(group, lookup));
}

/** Stage alternatives (`<base>.<suffix>`) configured for a group, including inherited ones. */
export function getStageAlternatives(
  group?: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): StageDefinition[] {
  return getRawGroupStages(group, lookup).filter((stage) =>
    isStageAlternativeId(stage.id),
  );
}

/** Variant suffixes configured for a group, sorted (e.g. `['b', 'c']`). */
export function listVariantSuffixes(
  group?: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): string[] {
  const suffixes = getStageAlternatives(group, lookup).map((stage) =>
    stage.id.slice(stage.id.indexOf('.') + 1),
  );
  return [...new Set(suffixes)].sort();
}

/**
 * Suffixes that can fork an A/B experiment: those with an alternative of an
 * ACTIVE base stage (e.g. `coding.b`). Review/testing alternatives are chosen
 * per task through `co_stages` instead.
 */
export function listAbVariantSuffixes(
  group?: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): string[] {
  const activeIds = new Set(
    getGroupStages(group, lookup)
      .filter((stage) => stage.type === 'active')
      .map((stage) => stage.id),
  );
  const suffixes = getStageAlternatives(group, lookup)
    .filter((stage) => activeIds.has(stage.id.slice(0, stage.id.indexOf('.'))))
    .map((stage) => stage.id.slice(stage.id.indexOf('.') + 1));
  return [...new Set(suffixes)].sort();
}

/**
 * The stage a task runs with: the base stage, overridden by the run config of
 * `<stageId>.<variant>` when that alternative exists. Type, title, color and
 * transitions always come from the base. Without a variant, or when the
 * alternative does not exist, this is the base stage.
 */
export function resolveStageForTask(
  group: RegisteredGroup | undefined,
  stageId: string,
  variant: string | null | undefined,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): StageDefinition | undefined {
  const stages = getRawGroupStages(group, lookup);
  const base = stages.find(
    (stage) => stage.id === stageId && !isStageAlternativeId(stage.id),
  );
  if (!base) return undefined;
  const alternative = variant
    ? stages.find((stage) => stage.id === `${stageId}.${variant}`)
    : undefined;
  if (!alternative) return base;
  const resolved: StageDefinition = { ...base };
  for (const key of OVERRIDABLE_STAGE_KEYS) {
    const value = alternative[key];
    if (value !== undefined && value !== null) {
      Object.assign(resolved, { [key]: value });
    }
  }
  return resolved;
}

/**
 * Whether `<stageId>.<variant>` is a configured alternative for the group. Used
 * to gate alternative prompts: a stale `stage-<base>.<variant>.md` file must not
 * be read once the alternative itself has been removed from the configuration.
 */
export function hasStageAlternative(
  group: RegisteredGroup | undefined,
  stageId: string,
  variant: string | null | undefined,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): boolean {
  if (!variant) return false;
  return getRawGroupStages(group, lookup).some(
    (stage) => stage.id === `${stageId}.${variant}`,
  );
}

/**
 * Effective stages including alternatives (`<base>.<suffix>`), for configuration
 * and setup consumers. Topology consumers (columns, transitions, initial and
 * done stages) must use `getGroupStages`/`getProjectStages`, which filter them.
 */
export function getGroupStagesWithAlternatives(
  group?: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): StageDefinition[] {
  return getRawGroupStages(group, lookup);
}

export type ValidateCoStagesResult =
  | { valid: true; coStages: string[] | null }
  | { valid: false; error: string };

/** Stage types whose alternatives may run as extra stages of a task. */
const CO_STAGE_BASE_TYPES: readonly StageType[] = ['review', 'testing'];

/**
 * Configured alternatives a task may pick as `co_stages` (review or testing
 * alternatives, including inherited ones), ordered by their base stage's
 * pipeline position and then by list order.
 */
export function listCoStageOptions(
  group?: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): string[] {
  const alternatives = getStageAlternatives(group, lookup);
  return getGroupStages(group, lookup)
    .filter((base) => CO_STAGE_BASE_TYPES.includes(base.type))
    .flatMap((base) =>
      alternatives
        .filter((alt) => alt.id.slice(0, alt.id.indexOf('.')) === base.id)
        .map((alt) => alt.id),
    );
}

export type ValidateStageVariantResult =
  | { valid: true; variant: string | null }
  | { valid: false; error: string };

/**
 * Validate a task's `stage_variant` against the project's configured
 * suffixes. Unset, null, '' and 'a' all mean the base stages, stored as null.
 */
export function validateStageVariant(
  group: RegisteredGroup | undefined,
  requested: unknown,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): ValidateStageVariantResult {
  if (requested === null || requested === undefined) {
    return { valid: true, variant: null };
  }
  if (typeof requested !== 'string') {
    return { valid: false, error: 'stage_variant must be a string or null' };
  }
  if (!requested || requested === 'a') return { valid: true, variant: null };
  const suffixes = listVariantSuffixes(group, lookup);
  if (!suffixes.includes(requested)) {
    return {
      valid: false,
      error: suffixes.length
        ? `Unknown stage variant "${requested}"; configured variants: ${suffixes.join(', ')}`
        : `Unknown stage variant "${requested}"; this project has no stage alternatives`,
    };
  }
  return { valid: true, variant: requested };
}

/**
 * Validate a task's `co_stages`: every entry must be a configured stage
 * alternative (`<base>.<suffix>`) whose base stage is a review or testing
 * stage. Duplicates are dropped and the order is kept; null/[] clears the list.
 */
export function validateCoStages(
  group: RegisteredGroup | undefined,
  value: unknown,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): ValidateCoStagesResult {
  if (value === null || value === undefined) {
    return { valid: true, coStages: null };
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    return {
      valid: false,
      error: 'co_stages must be an array of stage alternative ids or null',
    };
  }
  const alternatives = new Set(
    getStageAlternatives(group, lookup).map((stage) => stage.id),
  );
  const baseStages = getGroupStages(group, lookup);
  const entries: string[] = [];
  for (const id of value as string[]) {
    if (!alternatives.has(id)) {
      return {
        valid: false,
        error: `Unknown co-stage "${id}"; it must be a configured stage alternative such as "review.o"`,
      };
    }
    const baseId = id.slice(0, id.indexOf('.'));
    const base = baseStages.find((stage) => stage.id === baseId);
    if (!base || !CO_STAGE_BASE_TYPES.includes(base.type)) {
      return {
        valid: false,
        error: `Co-stage "${id}" is not allowed: its base stage "${baseId}" must be a review or testing stage`,
      };
    }
    if (!entries.includes(id)) entries.push(id);
  }
  return { valid: true, coStages: entries.length > 0 ? entries : null };
}

/**
 * Alternatives of `task.coStages` that run after the own runtime of the
 * `stageType` stage `stageId`. Entries for other stages or stage types are not
 * extras of this stage. A card whose own variant already replaces this stage
 * (an A/B child running `<stage>.<variant>`) ignores the whole list for it.
 */
export function resolveCoStages(
  group: RegisteredGroup,
  task: Pick<Task, 'coStages' | 'stageVariant'>,
  stageId: string,
  stageType: StageType,
): string[] {
  const coStages = task.coStages ?? [];
  if (coStages.length === 0) return [];
  const isBase = getGroupStages(group).some(
    (stage) => stage.id === stageId && stage.type === stageType,
  );
  if (!isBase) return [];
  if (hasStageAlternative(group, stageId, task.stageVariant)) return [];
  const configured = new Set(getStageAlternatives(group).map((s) => s.id));
  return coStages.filter(
    (id) =>
      isStageAlternativeId(id) &&
      configured.has(id) &&
      id.slice(0, id.indexOf('.')) === stageId,
  );
}

export type ValidateAbVariantsResult =
  | { valid: true; variants: string[] | null }
  | { valid: false; error: string };

/**
 * Validate ab_variants for an experiment task.
 */
export function validateAbVariants(
  group?: RegisteredGroup,
  variants?: unknown,
  task?: {
    status: string;
    ab_fork_commit?: string | null;
    abForkCommit?: string | null;
  } | null,
  stages?: StageDefinition[],
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): ValidateAbVariantsResult {
  const effectiveStages = stages ?? (group ? getGroupStages(group) : undefined);
  /** Why the experiment's variants can no longer be modified, if they can't. */
  const abVariantsLockedError = (): string | null => {
    if (task && (task.ab_fork_commit || task.abForkCommit)) {
      return 'Cannot modify ab_variants: experiment has already forked';
    }
    if (task && effectiveStages) {
      const currentStage = findStage(effectiveStages, task.status);
      if (currentStage && currentStage.type !== 'queue') {
        return `ab_variants can only be modified in a queue stage; "${task.status}" is ${currentStage.type}`;
      }
    }
    return null;
  };
  if (variants === null || variants === undefined) {
    const lockedError = abVariantsLockedError();
    if (lockedError) return { valid: false, error: lockedError };
    return { valid: true, variants: null };
  }

  const checkoutMode = resolveTaskCheckoutMode(group?.settings ?? {});
  if (checkoutMode !== 'worktree') {
    return {
      valid: false,
      error:
        'A/B testing experiments require taskCheckoutMode to be "worktree"',
    };
  }
  if (
    !group?.settings?.repositoryLocation &&
    !group?.settings?.repositoryRelativePath
  ) {
    return {
      valid: false,
      error:
        'A/B testing experiments require a configured local repository (repositoryLocation) to create one worktree per variant',
    };
  }

  const lockedError = abVariantsLockedError();
  if (lockedError) return { valid: false, error: lockedError };

  if (!Array.isArray(variants)) {
    return {
      valid: false,
      error: 'ab_variants must be an array of variant strings',
    };
  }

  const normalized = Array.from(
    new Set(
      variants
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    ),
  );

  if (normalized.length < 2) {
    return {
      valid: false,
      error: 'ab_variants must contain at least 2 distinct variants',
    };
  }

  for (const v of normalized) {
    if (!VARIANT_SUFFIX_PATTERN.test(v)) {
      return {
        valid: false,
        error: `Invalid variant identifier "${v}". Must match ${VARIANT_SUFFIX_PATTERN.source}`,
      };
    }
  }

  const availableSuffixes = listAbVariantSuffixes(group, lookup);
  const nonAVariants = normalized.filter((v) => v !== 'a');
  if (nonAVariants.length === 0) {
    return {
      valid: false,
      error: 'ab_variants must contain at least one non-A variant',
    };
  }
  for (const v of nonAVariants) {
    if (!availableSuffixes.includes(v)) {
      return {
        valid: false,
        error: `Variant "${v}" has no coding stage alternative; use co_stages for review/testing alternatives`,
      };
    }
  }

  return { valid: true, variants: normalized };
}

/**
 * Compute the fork stage for an A/B experiment.
 * Returns the first executable active base stage in pipeline order where any
 * selected non-A variant has a configured alternative.
 */
export function computeAbForkStage(
  group?: RegisteredGroup,
  variants?: readonly string[] | null,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): string | undefined {
  if (!variants || !Array.isArray(variants) || variants.length < 2) {
    return undefined;
  }
  const nonAVariants = variants
    .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
    .filter((v) => v.length > 0 && v !== 'a');

  if (nonAVariants.length === 0) return undefined;

  const stages = getGroupStages(group, lookup).filter((s) => !s.inactive);
  for (const stage of stages) {
    if (stage.type === 'active') {
      const hasAlternative = nonAVariants.some((v) =>
        hasStageAlternative(group, stage.id, v, lookup),
      );
      if (hasAlternative) {
        return stage.id;
      }
    }
  }
  return undefined;
}

/**
 * Stage rule for creating a task with ab_variants. Queue stages and the fork
 * stage itself (or any stage before it) are allowed; a card created after the
 * fork stage would never fork, yet the deploy and merge A/B gates would still
 * treat it as an experiment. Returns an error message, or null when allowed.
 */
export function abVariantsCreationStageError(
  group: RegisteredGroup | undefined,
  variants: readonly string[] | null | undefined,
  status: string,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): string | null {
  const forkStage = computeAbForkStage(group, variants, lookup);
  if (!forkStage) return null;
  const stages = getGroupStages(group, lookup);
  const stage = findStage(stages, status);
  if (!stage || stage.type === 'queue') return null;
  const stageIndex = stages.findIndex((s) => s.id === status);
  const forkIndex = stages.findIndex((s) => s.id === forkStage);
  if (stageIndex <= forkIndex) return null;
  return `ab_variants can only be set on a task created in a queue stage or the A/B fork stage "${forkStage}"; "${status}" comes after the fork stage, so the task would never fork.`;
}

export function isAbExperimentParent(
  task?: {
    ab_variants?: string[] | null;
    abVariants?: string[] | null;
  } | null,
): boolean {
  if (!task) return false;
  const variants = task.ab_variants ?? task.abVariants;
  return Array.isArray(variants) && variants.length >= 2;
}

export function isAbExperimentChild(
  task?: {
    ab_parent_task_id?: string | null;
    abParentTaskId?: string | null;
  } | null,
): boolean {
  if (!task) return false;
  return Boolean(task.ab_parent_task_id ?? task.abParentTaskId);
}

export function isAbExperimentTask(
  task?: {
    ab_variants?: string[] | null;
    abVariants?: string[] | null;
    ab_parent_task_id?: string | null;
    abParentTaskId?: string | null;
    ab_fork_commit?: string | null;
    abForkCommit?: string | null;
  } | null,
): boolean {
  if (!task) return false;
  return (
    isAbExperimentParent(task) ||
    isAbExperimentChild(task) ||
    Boolean(task.ab_fork_commit ?? task.abForkCommit)
  );
}

/** Get only active stages for a project */
export function getActiveProjectStages(
  settings?: ProjectSettings,
): StageDefinition[] {
  return getProjectStages(settings).filter((s) => !s.inactive);
}

/** Find a stage by id */
export function findStage(
  stages: StageDefinition[],
  stageId: string,
): StageDefinition | undefined {
  return stages.find((s) => s.id === stageId);
}

/** Whether a stage represents the board's explicit Question/attention queue. */
export function isQuestionStage(
  stages: StageDefinition[],
  stageId: string | undefined,
): boolean {
  return isNamedStage(stages, stageId, 'question');
}

/** Whether a stage represents the board's explicit Failed/error queue. */
export function isFailedStage(
  stages: StageDefinition[],
  stageId: string | undefined,
): boolean {
  return isNamedStage(stages, stageId, 'failed');
}

function isNamedStage(
  stages: StageDefinition[],
  stageId: string | undefined,
  name: string,
): boolean {
  return isNamedStageDefinition(findStage(stages, stageId ?? ''), name);
}

function isNamedStageDefinition(
  stage: StageDefinition | undefined,
  name: string,
): boolean {
  return (
    !!stage &&
    (stage.id.toLowerCase() === name ||
      stage.title.trim().toLowerCase() === name)
  );
}

/** Find the active stage representing the board's Question queue. */
export function getQuestionStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return stages.find(
    (stage) => !stage.inactive && isNamedStageDefinition(stage, 'question'),
  );
}

/** Whether entering this stage starts a one-shot recovery agent (runOnEntry queue stage). */
export function isRecoveryHookStage(
  stage: StageDefinition | undefined,
): boolean {
  return (
    !!stage &&
    !stage.inactive &&
    stage.type === 'queue' &&
    stage.runOnEntry === true
  );
}

/** Get the first queue stage (where new tasks land) */
export function getInitialStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return (
    stages.find((s) => s.type === 'queue' && !s.inactive) ||
    stages.find((s) => !s.inactive) ||
    stages[0]
  );
}

/** Get the first active stage that can be executed by the task queue. */
export function getFirstExecutableStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return stages.find((s) => s.type === 'active' && !s.inactive);
}

/** Get the first 'done' stage */
export function getDoneStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return stages.find((s) => s.type === 'done' && !s.inactive);
}

/**
 * Get the failure/error stage for a project.
 * Prefers a stage with id='failed'; falls back to the first active queue stage.
 * Used by task-executor.ts for all failure/error recovery paths.
 */
export function getFailedStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return (
    stages.find((s) => s.id === 'failed' && !s.inactive) ??
    stages.find((s) => s.type === 'queue' && !s.inactive)
  );
}

/** Question when configured, then explicit backlog, then the first queue stage. */
export function getTestingBlockedStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  return (
    getQuestionStage(stages) ??
    stages.find(
      (stage) =>
        !stage.inactive &&
        (stage.id === 'backlog' ||
          stage.title.trim().toLowerCase() === 'backlog'),
    ) ??
    stages.find((stage) => !stage.inactive && stage.type === 'queue')
  );
}

/**
 * Whether a move from `fromStage` to `toStage` parks a card in the needs-input
 * fallback stage of a project without a Question stage, leaving an executable
 * stage. Such a move stands in for entering a Question stage. A fallback that is
 * a Failed stage is excluded: the move already publishes `task_failed`, and a
 * second hold would compete with its notice for the stage-entry notification.
 */
export function isFallbackQuestionMove(
  stages: StageDefinition[],
  fromStage: string,
  toStage: string,
): boolean {
  return (
    !getQuestionStage(stages) &&
    getTestingBlockedStage(stages)?.id === toStage &&
    !isFailedStage(stages, toStage) &&
    isExecutableStage(findStage(stages, fromStage))
  );
}

function isExecutableStage(stage: StageDefinition | undefined): boolean {
  return (
    !!stage &&
    (stage.type === 'active' ||
      stage.type === 'testing' ||
      stage.type === 'review') &&
    !stage.inactive
  );
}

/**
 * Get the next active stage after the given stage ID, or undefined if none.
 *
 * `skipStages` (optional, used by auto-advance only) drops matching stage
 * IDs from the forward scan in addition to the existing inactive/type filter.
 * Undefined entries are ignored. If all remaining executable stages are
 * skipped, returns undefined so the caller falls back to the done stage.
 */
export function getNextActiveStage(
  stages: StageDefinition[],
  currentStageId: string,
  skipStages?: string[] | null,
): StageDefinition | undefined {
  const currentIndex = stages.findIndex((s) => s.id === currentStageId);
  if (currentIndex === -1) return undefined;
  const skipSet =
    skipStages && skipStages.length > 0 ? new Set(skipStages) : null;
  for (let i = currentIndex + 1; i < stages.length; i++) {
    if (
      isExecutableStage(stages[i]) &&
      (!skipSet || !skipSet.has(stages[i].id))
    )
      return stages[i];
  }
  return undefined;
}

/**
 * Review/testing stage IDs that `nextSkip` adds beyond `currentSkip`. Agents
 * must not add these, since skipping them lets a card reach done unreviewed.
 * Unknown IDs are ignored; removals and unchanged entries are not additions.
 */
export function addedGatedSkipStages(
  stages: StageDefinition[],
  currentSkip: string[] | null | undefined,
  nextSkip: string[] | null | undefined,
): string[] {
  if (!nextSkip || nextSkip.length === 0) return [];
  const current = new Set(currentSkip ?? []);
  const gated = new Set(
    stages
      .filter((s) => s.type === 'review' || s.type === 'testing')
      .map((s) => s.id),
  );
  return [...new Set(nextSkip)].filter(
    (id) => !current.has(id) && gated.has(id),
  );
}

/** Error text for an agent attempt to add review/testing skip entries. */
export function gatedSkipStagesDenial(ids: string[]): string {
  return `Agents cannot skip review or testing stages (${ids.join(', ')}); only a human may set this.`;
}

/** Stage to reopen after a passing review found non-blocking polish items. */
export function getReviewReworkStage(
  stages: StageDefinition[],
  reviewStageId: string,
): StageDefinition | undefined {
  const reviewIndex = stages.findIndex((stage) => stage.id === reviewStageId);
  if (reviewIndex === -1) return undefined;
  for (let index = 0; index < reviewIndex; index++) {
    const stage = stages[index];
    if (stage.type === 'active' && !stage.inactive) return stage;
  }
  return undefined;
}

/** Check if a stage triggers execution (active, testing, and review run agents). */
export function isActiveStage(
  stages: StageDefinition[],
  stageId: string,
): boolean {
  return isExecutableStage(findStage(stages, stageId));
}

/** Check if a stage is a review stage */
export function isReviewStage(
  stages: StageDefinition[],
  stageId: string,
): boolean {
  const stage = findStage(stages, stageId);
  return stage?.type === 'review' && !stage.inactive;
}

/** Whether a stage requires a structured, read-only testing verdict. */
export function isTestingStage(
  stages: StageDefinition[],
  stageId: string,
): boolean {
  const stage = findStage(stages, stageId);
  return stage?.type === 'testing' && !stage.inactive;
}

/**
 * Validate a `runtimeSelectionStage`: null/undefined (all stages) or the id of
 * a non-inactive active/testing/review base stage of the project. Returns an
 * error message, or null when the value is acceptable.
 */
export function validateRuntimeSelectionStage(
  group: RegisteredGroup | undefined,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    return 'runtimeSelectionStage must be a string or null';
  }
  const stages = getGroupStages(group);
  if (isActiveStage(stages, value)) return null;
  const valid = stages
    .filter((s) => isActiveStage(stages, s.id))
    .map((s) => s.id)
    .join(', ');
  return `Invalid runtimeSelectionStage "${value}". Executable stages: ${valid}`;
}

/** Get the deploy stage ID for a project (explicit setting → first done stage) */
export function getDeployStageId(
  settings?: ProjectSettings,
  resolvedStages?: StageDefinition[],
): string | undefined {
  if (settings?.deployStage) return settings.deployStage;
  const stages = resolvedStages ?? getProjectStages(settings);
  return stages.find((s) => s.type === 'done' && !s.inactive)?.id;
}

/** Validate a stage configuration. Returns error string or null if valid. */
export function validateStages(
  stages: StageDefinition[],
  options?: { checkQuestionType?: boolean },
): string | null {
  if (!Array.isArray(stages) || stages.length === 0)
    return 'At least one stage is required';
  const ids = stages.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return 'Stage IDs must be unique';
  // Alternatives take their type, title and color from the base stage, so
  // they are excluded from the column, queue/done and review counts.
  const baseStages = stages.filter((s) => !isStageAlternativeId(s.id));
  const activeStages = baseStages.filter((s) => !s.inactive);
  if (!activeStages.some((s) => s.type === 'queue'))
    return 'At least one active queue stage is required';
  if (!activeStages.some((s) => s.type === 'done'))
    return 'At least one active done stage is required';
  for (const stage of stages) {
    if (isStageAlternativeId(stage.id)) {
      const alternativeError = validateStageAlternative(stage, stages);
      if (alternativeError) return alternativeError;
      continue;
    }
    if (!BASE_STAGE_ID_PATTERN.test(stage.id))
      return `Stage ID "${stage.id}" must be lowercase alphanumeric with underscores`;
    if (!stage.title?.trim()) return 'All stages must have a title';
    if (!stage.color?.trim()) return 'All stages must have a color';
    if (!['queue', 'active', 'testing', 'done', 'review'].includes(stage.type))
      return `Invalid stage type "${stage.type}"`;
  }
  const reviewStages = baseStages.filter(
    (s) => s.type === 'review' && !s.inactive,
  );
  if (reviewStages.length > 1)
    return 'Only one active review stage is allowed per project';
  // The Question stage is the attention queue for tasks waiting on the user;
  // a non-queue type would silently reroute completions into it (getDoneStage
  // picks the first active done stage in column order).
  if (options?.checkQuestionType ?? true) {
    const questionStage = activeStages.find(
      (stage) =>
        isNamedStageDefinition(stage, 'question') && stage.type !== 'queue',
    );
    if (questionStage) {
      return `Stage "${questionStage.id}" is the Question stage (id or title "Question") and must be a queue stage, not "${questionStage.type}". Change its type to queue or rename it.`;
    }
  }
  return null;
}

function validateStageAlternative(
  alternative: StageDefinition,
  stages: StageDefinition[],
): string | null {
  if (!STAGE_ID_PATTERN.test(alternative.id))
    return `Stage ID "${alternative.id}" must be <base>.<suffix>: a lowercase base id, a dot, then 1-8 lowercase letters or digits`;
  const [baseId, suffix] = alternative.id.split('.');
  if (!VARIANT_SUFFIX_PATTERN.test(suffix))
    return `Stage ID "${alternative.id}" has an invalid variant suffix`;
  if (suffix === 'a')
    return `Stage ID "${alternative.id}" uses "a", which is reserved for the base stage`;
  const base = stages.find((s) => s.id === baseId);
  if (!base)
    return `Stage alternative "${alternative.id}" needs its base stage "${baseId}"`;
  if (!ALTERNATIVE_BASE_TYPES.includes(base.type))
    return `Stage alternative "${alternative.id}" needs an active, testing or review base stage`;
  return null;
}
