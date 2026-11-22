import { useState } from 'react';
import type { QueryStatus, UseQueryResult } from '@tanstack/react-query';

type QueryLoadPhase = 'loading' | 'error' | 'empty' | 'ready';

type LoadQuery = UseQueryResult<unknown, Error>;

interface RetainedError {
  error: Error;
  /** Identifies the failure; a refetch keeps it, a different query has another. */
  errorUpdatedAt: number;
  /** Position in `queries` of the query that failed. */
  index: number;
}

/**
 * TanStack Query v5 resets a data-less failed query to `status: 'pending',
 * error: null` while it refetches, but keeps `errorUpdatedAt`. Carry the
 * aggregate error over that window and until every enabled query succeeds. A
 * source slot whose `errorUpdatedAt` differs (key change, even to a cached
 * query) holds a different query, and a source that became disabled no longer
 * applies. `errorUpdatedAt` survives a Retry and a later success.
 */
function retainError(
  queries: readonly LoadQuery[],
  previous: RetainedError | null,
): RetainedError | null {
  for (const [index, query] of queries.entries()) {
    if (!query.isEnabled || query.status !== 'error') continue;
    if (query.data !== undefined) continue;
    return previous?.index === index &&
      previous.error === query.error &&
      previous.errorUpdatedAt === query.errorUpdatedAt
      ? previous
      : {
          error: query.error,
          errorUpdatedAt: query.errorUpdatedAt,
          index,
        };
  }
  const source = previous && queries[previous.index];
  const enabled = queries.filter((query) => query.isEnabled);
  if (
    !previous ||
    !source?.isEnabled ||
    source.errorUpdatedAt !== previous.errorUpdatedAt ||
    enabled.every((query) => query.status === 'success')
  )
    return null;
  return previous;
}

/**
 * One load/error/empty policy for pages built on one or more queries.
 * - `error`: a query without data failed; kept until every enabled query
 *   succeeds, including while Retry is pending.
 * - `staleError`: a refetch failed but data is still shown (phase `ready`).
 * - `empty`: only reported once every enabled query succeeded and `isEmpty()`.
 * Disabled queries are ignored. `retry()` refetches only the failed queries.
 */
export function useQueryLoadState(
  queries: readonly LoadQuery[],
  options: { isEmpty?: () => boolean } = {},
) {
  const [retained, setRetained] = useState<RetainedError | null>(null);
  const current = retainError(queries, retained);
  if (current !== retained) setRetained(current);

  const enabled = queries.filter((query) => query.isEnabled);
  const failed = enabled.filter((query) => query.status === 'error');

  let phase: QueryLoadPhase;
  if (current) phase = 'error';
  else if (
    enabled.length === 0 ||
    enabled.some((query) => query.status === 'pending')
  )
    phase = 'loading';
  else if (
    enabled.every((query) => query.status === 'success') &&
    options.isEmpty?.()
  )
    phase = 'empty';
  else phase = 'ready';

  return {
    phase,
    error: current?.error ?? null,
    staleError: failed.find((query) => query.data !== undefined)?.error ?? null,
    isRetrying: enabled.some(
      (query) =>
        query.fetchStatus === 'fetching' &&
        (query.status === 'error' || query.status === 'pending'),
    ),
    retry: () => {
      for (const query of failed) {
        if (query.fetchStatus !== 'fetching') void query.refetch();
      }
    },
  };
}

/** `refetchInterval` that polls every `ms` but stops once the query errors. */
export const pollUnlessError =
  (ms: number) =>
  (query: { state: { status: QueryStatus } }): number | false =>
    query.state.status === 'error' ? false : ms;
