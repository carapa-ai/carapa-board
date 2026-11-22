import { sha256Hex } from '../../lib/hash.js';
import type { RegisteredGroup } from '../../types.js';
import type { StageDefinition } from '../kanban/types.js';
import {
  getGroupStages,
  getGroupStagesWithAlternatives,
  getStageAlternatives,
} from '../kanban/stages.js';
import {
  deleteProjectPrompt,
  deletePrompt,
  readPrompt,
  writeProjectPrompt,
  writePrompt,
} from '../../routes/_helpers.js';

export type ProjectPromptType = 'system' | 'worker' | 'stage';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function projectSetupRevision(value: unknown): string {
  return sha256Hex(JSON.stringify(stableValue(value))).slice(0, 16);
}

export function findCurrentGroup(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): { jid: string; group: RegisteredGroup } {
  const entry = Object.entries(groups).find(
    ([, candidate]) => candidate.folder === folder,
  );
  if (!entry) throw new Error(`Project "${folder}" not found`);
  return { jid: entry[0], group: entry[1] };
}

export function findGroupByFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): RegisteredGroup | undefined {
  return Object.values(groups).find((candidate) => candidate.folder === folder);
}

function getStagesForGroup(
  group: RegisteredGroup,
  groups: Record<string, RegisteredGroup>,
): StageDefinition[] {
  return getGroupStages(group, (folder) => findGroupByFolder(groups, folder));
}

/**
 * Effective stages including alternatives. Used for the setup snapshot, prompt
 * revision inputs and `set_project_stages` round-trips so alternatives survive
 * an edit of the base topology. Topology consumers stay on `getStagesForGroup`.
 */
export function getStagesWithAlternativesForGroup(
  group: RegisteredGroup,
  groups: Record<string, RegisteredGroup>,
): StageDefinition[] {
  return getGroupStagesWithAlternatives(group, (folder) =>
    findGroupByFolder(groups, folder),
  );
}

export async function readLocalPrompts(
  group: RegisteredGroup,
  stageIds: readonly string[],
): Promise<{
  system: string | null;
  worker: string | null;
  stages: Record<string, string>;
}> {
  const [system, worker, ...stagePrompts] = await Promise.all([
    readPrompt(group.folder, group.parentId, promptFilename('system')),
    readPrompt(group.folder, group.parentId, promptFilename('worker')),
    ...stageIds.map((id) =>
      readPrompt(group.folder, group.parentId, promptFilename('stage', id)),
    ),
  ]);
  return {
    system: system ?? null,
    worker: worker ?? null,
    stages: Object.fromEntries(
      stageIds.flatMap((id, index) => {
        const prompt = stagePrompts[index];
        return prompt ? [[id, prompt]] : [];
      }),
    ),
  };
}

export async function revisionFor(
  group: RegisteredGroup,
  groups: Record<string, RegisteredGroup>,
): Promise<string> {
  // Read every configured stage prompt, including alternatives (`coding.b`), so
  // changing one through set_project_prompt invalidates a stale revision.
  const stages = getStagesWithAlternativesForGroup(group, groups);
  const localPrompts = await readLocalPrompts(
    group,
    stages.map((stage) => stage.id),
  );
  return projectSetupRevision({
    stages: group.settings?.stages ?? null,
    prompts: localPrompts,
    checkoutMode: group.settings?.taskCheckoutMode ?? 'shared',
  });
}

/** Throw unless `expected` is the current setup revision of the project. */
export async function requireRevision(
  expected: string,
  group: RegisteredGroup,
  groups: Record<string, RegisteredGroup>,
): Promise<void> {
  const actual = await revisionFor(group, groups);
  if (actual !== expected) {
    throw new Error(
      `Project setup changed since it was inspected (expected ${expected}, current ${actual}). Read the setup again before applying changes.`,
    );
  }
}

/** Prompt file name: `system.md`, `worker.md` or `stage-<id>.md`. */
function promptFilename(type: ProjectPromptType, stageId?: string): string {
  if (type === 'system') return 'system.md';
  if (type === 'worker') return 'worker.md';
  return `stage-${stageId}.md`;
}

/** Validate a prompt target and resolve its project and file name. */
export function resolvePromptTarget(
  groups: Record<string, RegisteredGroup>,
  folder: string,
  type: ProjectPromptType,
  stageId?: string,
): { group: RegisteredGroup; filename: string } {
  const { group } = findCurrentGroup(groups, folder);

  if (type === 'stage') {
    if (!stageId) throw new Error('stage_id is required for a stage prompt');
    if (!group.settings?.stages?.length && group.parentId) {
      throw new Error(
        'This project inherits its stages and stage prompts. Apply a local stage topology before setting a project-specific stage prompt.',
      );
    }
    // A stage alternative (`coding.b`) is a prompt target when it is configured
    // and its base stage is an enabled executable stage.
    const stages = getStagesForGroup(group, groups);
    const baseId = stageId.split('.')[0];
    const stage = stages.find((candidate) => candidate.id === baseId);
    const alternativeConfigured =
      stageId === baseId ||
      getStageAlternatives(group, (candidate) =>
        findGroupByFolder(groups, candidate),
      ).some((candidate) => candidate.id === stageId);
    if (
      !stage ||
      !alternativeConfigured ||
      stage.inactive ||
      (!['active', 'testing', 'review'].includes(stage.type) &&
        stage.runOnEntry !== true)
    ) {
      throw new Error(
        `Stage "${stageId}" is not an enabled executable or run-on-entry stage`,
      );
    }
  } else if (stageId) {
    throw new Error('stage_id is only valid for a stage prompt');
  }

  return { group, filename: promptFilename(type, stageId) };
}

/** Current board-owned content of a validated prompt target, or null. */
export async function readTargetPrompt(
  groups: Record<string, RegisteredGroup>,
  folder: string,
  type: ProjectPromptType,
  stageId?: string,
): Promise<string | null> {
  const { group, filename } = resolvePromptTarget(
    groups,
    folder,
    type,
    stageId,
  );
  return (await readPrompt(group.folder, group.parentId, filename)) ?? null;
}

/**
 * Validate the target, then write the prompt, or remove it for null or blank
 * content. Callers check permission and the expected revision first.
 */
export async function applyProjectPrompt(
  groups: Record<string, RegisteredGroup>,
  folder: string,
  type: ProjectPromptType,
  stageId: string | undefined,
  content: string | null,
): Promise<{ removed: boolean; revision: string }> {
  const { group, filename } = resolvePromptTarget(
    groups,
    folder,
    type,
    stageId,
  );

  const normalized = content?.trim() ?? '';
  if (type === 'system') {
    if (normalized) await writeProjectPrompt(group.folder, normalized);
    else deleteProjectPrompt(group.folder);
  } else if (normalized) {
    await writePrompt(group.folder, group.parentId, filename, normalized);
  } else {
    await deletePrompt(group.folder, group.parentId, filename);
  }

  return {
    removed: !normalized,
    revision: await revisionFor(group, groups),
  };
}
