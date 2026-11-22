import type { QueryClient } from '@tanstack/react-query';
import type { LiveModeKind } from './live-mode.js';
import { queryKeys } from './query-keys.js';

/** The fields of the cached persona-live-mode status that stops rewrite. */
export interface PersonaLiveModeStatusPatch {
  enabled: boolean;
  ownedBySession: boolean;
  liveModeKind: LiveModeKind | null;
  liveModeSessionId: string | null;
  resumePlaybacks: unknown[];
  snapshot: unknown;
}

/**
 * Keeps already-cached persona-live-mode status entries of a conversation in
 * step with a start, stop or server event seen elsewhere. Without it, returning
 * to the conversation inside the query's stale window would re-apply the old
 * enabled/owned state. A stop also drops its resume data.
 */
export function patchPersonaLiveModeStatus(
  queryClient: QueryClient,
  conversationId: string,
  next: Partial<PersonaLiveModeStatusPatch> & { enabled: boolean },
): void {
  queryClient.setQueriesData<PersonaLiveModeStatusPatch>(
    {
      queryKey: queryKeys.personaLiveMode.all,
      predicate: (query) => query.queryKey[2] === conversationId,
    },
    (previous) =>
      previous && {
        ...previous,
        ...(next.enabled ? {} : { resumePlaybacks: [], snapshot: null }),
        ...next,
      },
  );
}
