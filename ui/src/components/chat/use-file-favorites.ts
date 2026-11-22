import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  addFileFavorite,
  fetchFileFavorites,
  removeFileFavorite,
} from '@/lib/api';
import { invalidateFileFavorites } from '@/lib/artifact-cache';
import { queryKeys } from '@/lib/query-keys';
import type { FileFavorite, FileFavoriteRef } from '@/types';

/** Stable identity of a favorite, whichever record shape carries it. */
const favoriteKey = (favorite: FileFavoriteRef) =>
  favorite.kind === 'group'
    ? `group:${favorite.path}`
    : `knowledge:${favorite.kbId}/${favorite.filename}`;

/** The user's favorites in a project, and how to toggle one. */
export interface FileFavorites {
  /** Newest first; undefined until loaded (or when loading failed). */
  favorites: FileFavorite[] | undefined;
  isFavorite: (favorite: FileFavoriteRef) => boolean;
  /** Adds or removes by current state, then refetches; failures show a toast. */
  toggle: (favorite: FileFavoriteRef) => Promise<void>;
}

export function useFileFavorites(
  project_id: string,
  enabled: boolean,
): FileFavorites {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.fileFavorites.all(project_id),
    queryFn: () => fetchFileFavorites(project_id),
    enabled,
  });
  return useMemo(() => {
    const keys = new Set((data ?? []).map(favoriteKey));
    const isFavorite = (favorite: FileFavoriteRef) =>
      keys.has(favoriteKey(favorite));
    return {
      favorites: data,
      isFavorite,
      toggle: async (favorite) => {
        const remove = isFavorite(favorite);
        try {
          await (remove ? removeFileFavorite : addFileFavorite)(
            project_id,
            favorite,
          );
        } catch (error) {
          toast.error(
            error instanceof Error && error.message
              ? error.message
              : remove
                ? 'Could not remove from favorites'
                : 'Could not add to favorites',
          );
        }
        // Also after a failure: the stored state may differ from the cached one.
        await invalidateFileFavorites(queryClient, project_id);
      },
    };
  }, [data, project_id, queryClient]);
}
