import type { ProjectSettings, RepositoryDiscoveryReport } from '@/types';

export const DEFAULT_DISCOVERY_EXCLUSIONS = [
  '.worktrees', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  'coverage', '.cache', '.next', '.nuxt', '.turbo', '.vite', '.parcel-cache',
  '.gradle', '__pycache__', '.pytest_cache', '.mypy_cache', 'tmp', 'temp',
];

export function discoveryReportSummary(report: RepositoryDiscoveryReport): string {
  return [
    `${report.created.length} created`,
    `${report.existing.length} existing`,
    `${report.ignored.length} ignored`,
    `${report.ambiguous.length} ambiguous`,
    `${report.missing.length} missing`,
  ].join(' · ');
}

export function repositoryDiscoveryAvailability(
  draft: Pick<ProjectSettings, 'isParent' | 'sandboxOwnership' | 'sharedWorkspaceHostLocation' | 'sharedWorkspaceContainerRoot'>,
  persisted: Pick<ProjectSettings, 'isParent' | 'sandboxOwnership' | 'sharedWorkspaceHostLocation' | 'sharedWorkspaceContainerRoot'> | undefined,
): { enabled: boolean; reason?: string } {
  if (draft.isParent !== persisted?.isParent || draft.sandboxOwnership !== persisted?.sandboxOwnership) {
    return { enabled: false, reason: 'Save parent and sandbox ownership changes before running discovery.' };
  }
  if (persisted?.isParent !== true || persisted.sandboxOwnership !== 'shared') {
    return { enabled: false, reason: 'Save this project as a shared-sandbox parent before discovering repositories.' };
  }
  const savedHost = persisted?.sharedWorkspaceHostLocation?.trim() || '';
  const savedContainer = persisted?.sharedWorkspaceContainerRoot?.trim() || '';
  if (!savedHost || !savedContainer) {
    return { enabled: false, reason: 'Save both shared workspace locations before discovering repositories.' };
  }
  const draftHost = draft.sharedWorkspaceHostLocation?.trim() || '';
  const draftContainer = draft.sharedWorkspaceContainerRoot?.trim() || '';
  if (draftHost !== savedHost || draftContainer !== savedContainer) {
    return { enabled: false, reason: 'Save workspace location changes before running discovery.' };
  }
  return { enabled: true };
}
