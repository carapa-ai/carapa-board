import { useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchUnreadNotifications } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export function useUnreadNotifications() {
  return useQuery({
    queryKey: queryKeys.unreadNotifications,
    queryFn: fetchUnreadNotifications,
    staleTime: Infinity,
  });
}

export function invalidateUnreadNotifications(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
}
