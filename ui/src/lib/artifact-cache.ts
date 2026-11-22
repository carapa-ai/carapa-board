import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

export function invalidateArtifactExplorerQueries(
  queryClient: QueryClient,
  projectId: string,
): void {
  queryClient.invalidateQueries({
    queryKey: queryKeys.artifacts.all(projectId),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.artifacts.explorer(projectId),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.artifacts.search(projectId),
  });
}

/** Id of the Files tab's Favorites source; its explorer queries are keyed by it. */
export const favoritesSourceId = (projectId: string) =>
  `${projectId}:favorites`;

/** Refetches the user's favorites and the Favorites section built from them. */
export function invalidateFileFavorites(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: [kind, id] }) =>
      kind === 'fileFavorites'
        ? id === projectId
        : (kind === 'fileExplorer' || kind === 'fileExplorerSearch') &&
          id === favoritesSourceId(projectId),
  });
}

/**
 * Refreshes every explorer source that lists the group folder (the whole
 * folder, `artifacts/` and objective folders) and the Move… picker's folder
 * listings, after a rename, move or delete. Also refetches the favorites: the
 * server rewrites a renamed or moved favorite and drops a deleted one.
 */
export function invalidateGroupExplorerQueries(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  invalidateArtifactExplorerQueries(queryClient, projectId);
  queryClient.invalidateQueries({
    queryKey: queryKeys.groupMoveTargets.all(projectId),
  });
  void invalidateFileFavorites(queryClient, projectId);
  const isGroupSource = (id: unknown) =>
    id === `${projectId}:group` ||
    id === `${projectId}:artifacts` ||
    (typeof id === 'string' && id.startsWith(`${projectId}:objective:`));
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: [kind, id] }) =>
      (kind === 'fileExplorer' || kind === 'fileExplorerSearch') &&
      isGroupSource(id),
  });
}
