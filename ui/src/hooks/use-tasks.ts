import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { fetchTasks } from '@/lib/api';
import {
  applyPendingTaskListOperations,
  beginTaskListFetch,
  finishTaskListFetch,
} from '@/hooks/use-task-mutations';

export function useTasks(
  project_id: string | undefined,
  filters?: { ownerUserId?: string; triggeredByUserId?: string },
) {
  return useQuery({
    queryKey: queryKeys.tasks.list(project_id!, filters),
    queryFn: async ({ client, queryKey, signal }) => {
      const startSeq = beginTaskListFetch(client);
      const tasks = await fetchTasks(project_id!, filters);
      // A cancelled fetch's result is discarded, so it delivered nothing.
      if (!signal.aborted) finishTaskListFetch(client, queryKey, startSeq);
      return applyPendingTaskListOperations(client, project_id!, tasks);
    },
    enabled: !!project_id,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
