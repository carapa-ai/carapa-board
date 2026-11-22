import type { Project } from '@/types';

const PREFIX = 'carapa-projects-v1:';
const memory = new Map<string, Project[]>();

export function readProjectCache(scope: string): Project[] | undefined {
  if (memory.has(scope)) return memory.get(scope);
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw) return undefined;
    const projects: unknown = JSON.parse(raw);
    if (
      !Array.isArray(projects) ||
      !projects.every(
        (project) =>
          project &&
          typeof project.id === 'string' &&
          typeof project.name === 'string' &&
          typeof project.folder === 'string' &&
          typeof project.revision === 'string',
      )
    )
      return undefined;
    memory.set(scope, projects);
    return projects;
  } catch {
    return undefined;
  }
}

export function writeProjectCache(scope: string, projects: Project[]): void {
  memory.set(scope, projects);
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify(projects));
  } catch {
    // Storage can be unavailable or full; the session cache still works.
  }
}

export function clearProjectCache(): void {
  memory.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {}
}
