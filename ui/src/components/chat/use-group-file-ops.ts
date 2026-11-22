import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deleteArtifact,
  deleteGroupPath,
  listGroupFiles,
  moveGroupPath,
  renameGroupPath,
} from '@/lib/api';
import { invalidateGroupExplorerQueries } from '@/lib/artifact-cache';
import { confirmAction } from '@/components/confirm-dialog';
import { canLeavePreviewTab, useStore } from '@/store';

/** Group-folder file operations with their side effects on tabs and caches. */
export interface GroupFileOps {
  /** Resolves the new group-relative path, or null when it failed or was cancelled. */
  rename: (path: string, newName: string) => Promise<string | null>;
  /**
   * Moves `path` into the group-relative folder `destination` ('' = group
   * root). Resolves the new group-relative path, or null when it failed or was
   * cancelled.
   */
  move: (path: string, destination: string) => Promise<string | null>;
  /** Asks for confirmation first; resolves true when deleted. */
  remove: (path: string, name: string, isFolder: boolean) => Promise<boolean>;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const isUnder = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`);

export function useGroupFileOps(project_id: string): GroupFileOps {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const affectedTabs = (path: string) =>
      (useStore.getState().previewTabsByProject[project_id]?.tabs ?? []).filter(
        (tab) => tab.source === 'group' && tab.path && isUnder(tab.path, path),
      );
    /** Asks every affected editor tab with unsaved changes; false aborts. */
    const tabsMayChange = async (path: string) => {
      for (const tab of affectedTabs(path))
        if (!(await canLeavePreviewTab(project_id, tab.id))) return false;
      return true;
    };
    const relocate = async (from: string, to: string) => {
      useStore.getState().relocateGroupPreviewTabs(project_id, from, to);
      await invalidateGroupExplorerQueries(queryClient, project_id);
    };
    return {
      rename: async (path, newName) => {
        if (!(await tabsMayChange(path))) return null;
        try {
          const { path: to } = await renameGroupPath(project_id, path, newName);
          await relocate(path, to);
          return to;
        } catch (error) {
          toast.error(errorMessage(error, 'Could not rename'));
          return null;
        }
      },
      move: async (path, destination) => {
        if (!(await tabsMayChange(path))) return null;
        try {
          const { path: to } = await moveGroupPath(
            project_id,
            path,
            destination,
          );
          await relocate(path, to);
          return to;
        } catch (error) {
          toast.error(errorMessage(error, 'Could not move'));
          return null;
        }
      },
      remove: async (path, name, isFolder) => {
        let detail = 'This cannot be undone.';
        if (isFolder) {
          try {
            const page = await listGroupFiles(project_id, {
              path,
              limit: 100,
            });
            const count = `${page.entries.length}${page.nextCursor ? '+' : ''}`;
            detail = `It holds ${count} direct ${count === '1' ? 'entry' : 'entries'}.\n${detail}`;
          } catch {
            // The count is informational; the server reports real failures.
          }
        }
        const confirmed = await confirmAction(detail, {
          title: `Delete ${name}?`,
          confirmLabel: 'Delete',
          destructive: true,
        });
        if (!confirmed || !(await tabsMayChange(path))) return false;
        try {
          // Artifact files go through the artifact route, which also removes
          // their sidecar.
          if (!isFolder && path.startsWith('artifacts/'))
            await deleteArtifact(project_id, path.slice('artifacts/'.length));
          else await deleteGroupPath(project_id, path);
        } catch (error) {
          toast.error(errorMessage(error, 'Could not delete'));
          await invalidateGroupExplorerQueries(queryClient, project_id);
          return false;
        }
        for (const tab of affectedTabs(path))
          useStore.getState().closePreviewTab(project_id, tab.id, true);
        await invalidateGroupExplorerQueries(queryClient, project_id);
        return true;
      },
    };
  }, [project_id, queryClient]);
}
