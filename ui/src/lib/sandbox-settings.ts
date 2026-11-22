import type { Project, ProjectSettings } from '@/types';
import { adminBypassesProject } from '@/lib/project-code';

const INHERITED_SANDBOX_FIELDS = [
  'defaultSandbox',
  'defaultSandboxService',
  'defaultSandboxInstance',
  'autoStartStack',
  'sandboxOwnership',
  'sharedWorkspaceHostLocation',
  'sharedWorkspaceContainerRoot',
  'webRootPath',
  'proxyHostnameAliases',
  'workspaceRoots',
  'extraMounts',
  // The owner's container applies its own skill list; a child's is ignored.
  'disabledSkills',
] as const satisfies readonly (keyof ProjectSettings)[];

// Mirrors REPOSITORY_CONNECTION_FIELDS in src/routes/projects.ts. The server
// rejects any PATCH carrying one of these keys unless the caller owns the
// project (or is an admin, except on a project owned by another user), so other roles must not send them at all.
export const REPOSITORY_CONNECTION_FIELDS = [
  'repositoryLocation',
  'repositoryUrl',
  'repositoryRelativePath',
  'sharedWorkspaceHostLocation',
] as const satisfies readonly (keyof ProjectSettings)[];

export function canEditRepositoryConnection(
  project: Pick<Project, 'accessLevel' | 'userId' | 'isMain'> | undefined,
  user: { id: string; role?: string } | null | undefined,
): boolean {
  // Auth disabled: there is no role to restrict by.
  if (!user) return true;
  if (adminBypassesProject(project, user)) return true;
  if (project?.accessLevel) return project.accessLevel === 'owner';
  return !!project?.userId && project.userId === user.id;
}

export function settingsForProjectUpdate(
  settings: ProjectSettings,
  inheritsSandbox: boolean,
  canEditRepository = true,
  canEditMounts = true,
): ProjectSettings {
  const result = { ...settings };
  // SSH has its own immediate, owner-authorized endpoint, outside form saves.
  delete result.sshEnabled;
  if (inheritsSandbox) {
    for (const field of INHERITED_SANDBOX_FIELDS) delete result[field];
  }
  if (!canEditRepository) {
    for (const field of REPOSITORY_CONNECTION_FIELDS) delete result[field];
  }
  // Only a board admin may change these; the server accepts unchanged values,
  // but a non-admin never needs to send them.
  if (!canEditMounts) {
    delete result.extraMounts;
    delete result.workspaceRoots;
  }
  return result;
}

export function sandboxLifecycleParams(group?: string): string {
  const params = new URLSearchParams();
  if (group) params.set('group', group);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function sharedSandboxParent(
  parentId: string | null | undefined,
  projects: Project[] | undefined,
): Project | undefined {
  if (!parentId) return undefined;
  const parent = projects?.find((candidate) => candidate.id === parentId);
  return parent?.settings?.isParent === true &&
    parent.settings.sandboxOwnership === 'shared'
    ? parent
    : undefined;
}

export function sandboxInheritanceForEdit(
  project: Project | undefined,
  selectedParentId: string | null | undefined,
  projects: Project[] | undefined,
): {
  inherited: boolean;
  owner: Project | undefined;
  effectiveSandbox: Project['effectiveSandbox'];
} {
  const selectedSharedParent = sharedSandboxParent(selectedParentId, projects);
  const usesPersistedInheritance =
    selectedParentId === project?.parentId &&
    project?.effectiveSandbox?.inherited === true;
  const ownerId = usesPersistedInheritance
    ? project.effectiveSandbox?.ownerProjectId
    : selectedSharedParent?.id;
  return {
    inherited: usesPersistedInheritance || !!selectedSharedParent,
    owner:
      selectedSharedParent ??
      projects?.find((candidate) => candidate.id === ownerId),
    effectiveSandbox: usesPersistedInheritance
      ? project?.effectiveSandbox
      : selectedSharedParent?.effectiveSandbox,
  };
}

export function sandboxCoordinates(project: Project | undefined): {
  stack: string;
  instance: string | undefined;
} {
  return {
    stack:
      project?.effectiveSandbox?.stack ||
      project?.settings?.defaultSandbox ||
      project?.stack ||
      'carapa-bot',
    instance: project?.effectiveSandbox?.instance || project?.folder,
  };
}

export function sandboxLifecycleIsManaged(
  project: Project | undefined,
): boolean {
  return (
    project?.effectiveSandbox?.managed !== false &&
    project?.effectiveSandbox?.inherited !== true
  );
}

export function sandboxWorkspaceLocationValues(
  settings: ProjectSettings,
  effectiveSandbox: Project['effectiveSandbox'],
  inherited: boolean,
): { hostWorkspaceLocation: string; containerWorkspaceRoot: string } {
  return inherited
    ? {
        hostWorkspaceLocation: effectiveSandbox?.hostWorkspaceLocation ?? '',
        containerWorkspaceRoot: effectiveSandbox?.containerWorkspaceRoot ?? '',
      }
    : {
        hostWorkspaceLocation: settings.sharedWorkspaceHostLocation ?? '',
        containerWorkspaceRoot: settings.sharedWorkspaceContainerRoot ?? '',
      };
}
