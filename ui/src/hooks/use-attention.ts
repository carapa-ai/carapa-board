import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAttention, type AttentionResponse } from '@/lib/api';
import {
  holdVanishedRunningTasks,
  partitionAttention,
  type AttentionPartition,
} from '@/lib/attention';
import { queryKeys } from '@/lib/query-keys';
import { useUnreadNotifications } from '@/hooks/use-unread-notifications';

/** Running task rows kept through a stage handoff; see holdVanishedRunningTasks. */
let heldRunningTasks: ReadonlyMap<string, number> = new Map();
/** Re-check held rows this often so an ended run leaves within the hold. */
const HELD_ROW_REFETCH_MS = 2_000;

/**
 * Cross-project "Now" list. Websocket lifecycle handlers invalidate
 * `queryKeys.attention.all`; the stale time only bounds focus refetches.
 */
export function useAttention() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.attention.all,
    queryFn: async () => {
      const next = await fetchAttention();
      const { response, heldSince } = holdVanishedRunningTasks(
        queryClient.getQueryData<AttentionResponse>(queryKeys.attention.all),
        next,
        heldRunningTasks,
        Date.now(),
      );
      heldRunningTasks = heldSince;
      return response;
    },
    staleTime: 30_000,
    refetchInterval: () =>
      heldRunningTasks.size > 0 ? HELD_ROW_REFETCH_MS : false,
  });
}

/** The Now rows and the notifications left for the bell. */
export function useAttentionPartition(): AttentionPartition {
  const { data } = useAttention();
  const { data: notifications } = useUnreadNotifications();
  return useMemo(
    () => partitionAttention(data?.items ?? [], notifications?.items ?? []),
    [data?.items, notifications?.items],
  );
}
