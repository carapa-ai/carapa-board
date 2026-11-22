import type { ProjectSettings, RegisteredGroup } from '../../types.js';
import { commitProjectStageMigration } from '../kanban/db-kanban.js';
import { serializeSettingsForDb } from '../../state-manager.js';

/** The project has no parent to inherit stages from. */
export class StageInheritanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageInheritanceError';
  }
}

/**
 * Drop a child project's own stage list so it inherits its parent's stages
 * again. Refuses with the occupied-stage error while a non-archived card
 * sits in a stage the parent lacks (archived cards stay where they are). The child's `stage-*.md` prompt files stay on disk; once the override is
 * gone, prompts resolve from the parent like for a project that never
 * overrode. Does nothing when the project already inherits.
 */
export async function inheritParentStages(
  group: RegisteredGroup,
  lookup: (folder: string) => RegisteredGroup | undefined,
  commit: (settings: ProjectSettings) => Promise<void> | void,
): Promise<void> {
  if (!group.parentId || !lookup(group.parentId)) {
    throw new StageInheritanceError(
      `Project "${group.folder}" has no parent project to inherit stages from`,
    );
  }
  if (!group.settings?.stages?.length) return;
  const { stages: _overridden, ...settings } = group.settings;
  await commitProjectStageMigration(
    group.folder,
    serializeSettingsForDb(settings),
    [],
    [],
    undefined,
    undefined,
    undefined,
    { excludeArchived: true },
  );
  await commit(settings);
}
