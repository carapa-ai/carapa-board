import type { Project } from '@/types';

export function projectUsesCode(project: Project): boolean {
  return project.settings?.codeEnabled ?? !project.isMain;
}

export function projectHasRepository(project: Project): boolean {
  return !!(
    project.settings?.repositoryLocation ||
    project.settings?.repositoryUrl ||
    project.settings?.repositoryRelativePath
  );
}

/**
 * The Changes view (git diff, commit, sync) only applies to projects with a
 * repository. Stays visible until the project has loaded to avoid tab flicker.
 */
export function showsChangesTab(project: Project | undefined): boolean {
  return !project || projectHasRepository(project);
}

/**
 * Mirrors `adminBypassesProject` in src/lib/project-ownership.ts: a board admin
 * skips project membership everywhere except on a project owned by another
 * user (a personal main of someone else, or an ordinary project with a
 * different owner). There the admin has only their membership level.
 */
export function adminBypassesProject(
  project: Pick<Project, 'userId' | 'isMain'> | undefined,
  user: { id: string; role?: string } | null | undefined,
): boolean {
  if (user?.role !== 'admin') return false;
  if (!project) return true;
  if (project.isMain) return project.userId === user.id;
  return !project.userId || project.userId === user.id;
}

/**
 * Shell access needs explicit editor-or-owner project membership. Chat-only
 * users (implicit access through a shared conversation) get `accessLevel: null`
 * and viewers are read-only; the server denies both. Stays permissive until the
 * project has loaded.
 */
export function canUseProjectShell(
  project: Project | undefined,
  user: { id: string; role?: string } | null | undefined,
): boolean {
  return (
    !project ||
    adminBypassesProject(project, user) ||
    (!!project.accessLevel && project.accessLevel !== 'viewer')
  );
}
