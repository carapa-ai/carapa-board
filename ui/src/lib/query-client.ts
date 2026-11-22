import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

/**
 * The app-wide retry policy: never retry client errors, otherwise up to 2
 * retries.
 */
function defaultRetry(failureCount: number, error: unknown): boolean {
  // Check ApiError.status structurally (importing ApiError would create a cycle
  // with api.ts); the message regex is a fallback.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  if (error instanceof Error && error.message.match(/HTTP 4\d\d/)) return false;
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: defaultRetry,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false,
    },
  },
});

// The projects list (and `useProject`, same key) retries once, quickly, so a
// real outage shows its error soon. It still follows the app policy: a 4xx is
// never retried.
queryClient.setQueryDefaults(queryKeys.projects.all, {
  retry: (failureCount: number, error: Error) =>
    failureCount < 1 && defaultRetry(failureCount, error),
  retryDelay: 800,
});
// Query defaults match by key prefix, so the status-summary query under
// ['projects', …] would inherit the rule above; later registrations win, so
// give it the app policy back.
queryClient.setQueryDefaults(queryKeys.projects.statusSummary, {
  retry: defaultRetry,
  retryDelay: undefined,
});
