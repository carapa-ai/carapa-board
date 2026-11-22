import { useQuery } from '@tanstack/react-query';
import { fetchConfig } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/** Server feature flags and defaults (`/api/config`), cached for the session. */
export function useAppConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: fetchConfig,
    staleTime: Infinity,
  });
}
