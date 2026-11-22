import type { SandboxInstance } from '@/lib/api';
import type { Project } from '@/types';

/** Stack and instance a project's sandbox runs as (shared parent sandbox included). */
export function projectSandboxTarget(
  project: Pick<Project, 'folder' | 'stack' | 'effectiveSandbox'> | undefined,
): { stack: string; instance: string | undefined } {
  return {
    stack: project?.effectiveSandbox?.stack || project?.stack || 'carapa-bot',
    instance: project?.effectiveSandbox?.instance || project?.folder,
  };
}

/** True when a `sandbox_ps` entry belongs to the given stack instance. */
export function isSandboxInstanceMatch(
  entry: Pick<SandboxInstance, 'name'>,
  stack: string,
  instance: string,
): boolean {
  return entry.name === `${stack}-${instance}` || entry.name === instance;
}

/** Display name of the project's sandbox, e.g. `carapa-bot-my-project`. */
export function projectSandboxName(project: Project): string {
  const { stack, instance } = projectSandboxTarget(project);
  return `${stack}-${instance}`;
}

/**
 * Ids of projects on a reachable host whose sandbox has no `sandbox_ps` entry.
 * Pass `undefined` while ps is loading or errored so nothing is flagged.
 */
export function sandboxDownProjectIds(
  projects: Project[] | undefined,
  ps: SandboxInstance[] | undefined,
): Set<string> {
  const down = new Set<string>();
  if (!projects || !ps) return down;
  for (const project of projects) {
    if (project.effectiveSandbox?.boxOnline === false) continue;
    const { stack, instance } = projectSandboxTarget(project);
    if (!instance) continue;
    if (!ps.some((i) => isSandboxInstanceMatch(i, stack, instance))) {
      down.add(project.id);
    }
  }
  return down;
}
