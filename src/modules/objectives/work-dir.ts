import { resolveEffectiveSandbox } from '../../sandbox/effective-settings.js';
import type { RegisteredGroup } from '../../types.js';

/**
 * The container-side work_dir of an objective agent, as a path below the
 * project's `/workspace/group`: a project that mounts its own directory there
 * finds its objectives at `objectives/<id>`; one inside a shared owner's mount
 * finds them one level down, at `<project>/objectives/<id>`.
 *
 * Callers do not decide that themselves: use `objectiveWorkDirFor`.
 */
export function computeObjectiveWorkDir(
  project_id: string,
  objective_id: string,
  nestedInOwnersMount?: unknown,
): string {
  return nestedInOwnersMount
    ? `/workspace/group/${project_id}/objectives/${objective_id}`
    : `/workspace/group/objectives/${objective_id}`;
}

/**
 * The work_dir for an objective of `group`, from the same sandbox-ownership
 * resolution that decides what the project's container mounts (see
 * `buildSandboxEnv` and `effectiveContainerGroupDir`): nested only for an
 * inherited child of a shared owner, never merely because a parent exists.
 */
export function objectiveWorkDirFor(
  group: RegisteredGroup,
  objective_id: string,
  lookup?: Parameters<typeof resolveEffectiveSandbox>[1],
): string {
  return computeObjectiveWorkDir(
    group.folder,
    objective_id,
    resolveEffectiveSandbox(group, lookup).inherited,
  );
}

/**
 * The directory an objective's agent works in for the project as it is now:
 * the stored one, else the one derived from the project's sandbox mount.
 */
export function objectiveWorkDir(
  group: RegisteredGroup,
  objective: { id: string; work_dir?: string | null },
  lookup?: Parameters<typeof resolveEffectiveSandbox>[1],
): string {
  return objective.work_dir ?? objectiveWorkDirFor(group, objective.id, lookup);
}
