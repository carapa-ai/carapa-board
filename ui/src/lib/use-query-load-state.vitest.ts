import { createElement, type ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pollUnlessError, useQueryLoadState } from './use-query-load-state';

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('useQueryLoadState', () => {
  it('goes loading -> error, keeps the error through a held Retry, then ready', async () => {
    const { wrapper } = setup();
    let attempt = deferred<string[]>();
    const fetcher = () => attempt.promise;
    const { result } = renderHook(
      () => {
        const query = useQuery({ queryKey: ['a'], queryFn: fetcher });
        return useQueryLoadState([query]);
      },
      { wrapper },
    );
    expect(result.current.phase).toBe('loading');

    attempt.reject(new Error('boom'));
    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.error?.message).toBe('boom');

    attempt = deferred();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.isRetrying).toBe(true));
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toBe('boom');

    // A second failed Retry updates the message.
    attempt.reject(new Error('still down'));
    await waitFor(() =>
      expect(result.current.error?.message).toBe('still down'),
    );
    expect(result.current.isRetrying).toBe(false);

    attempt = deferred();
    act(() => result.current.retry());
    attempt.resolve(['x']);
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.error).toBeNull();
    expect(result.current.isRetrying).toBe(false);
  });

  it('retries only the failed queries', async () => {
    const { wrapper } = setup();
    let okCalls = 0;
    let badCalls = 0;
    const { result } = renderHook(
      () => {
        const ok = useQuery({
          queryKey: ['ok'],
          queryFn: async () => {
            okCalls++;
            return 1;
          },
        });
        const bad = useQuery({
          queryKey: ['bad'],
          queryFn: async () => {
            badCalls++;
            throw new Error('bad');
          },
        });
        return useQueryLoadState([ok, bad]);
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe('error'));
    act(() => result.current.retry());
    await waitFor(() => expect(badCalls).toBe(2));
    expect(okCalls).toBe(1);
  });

  it('clears the retained error when the query key changes', async () => {
    const { wrapper } = setup();
    const next = deferred<string[]>();
    const { result, rerender } = renderHook(
      ({ kb }: { kb: string }) => {
        const query = useQuery({
          queryKey: ['files', kb],
          queryFn: () =>
            kb === 'A' ? Promise.reject(new Error('A failed')) : next.promise,
        });
        return useQueryLoadState([query]);
      },
      { wrapper, initialProps: { kb: 'A' } },
    );
    await waitFor(() => expect(result.current.error?.message).toBe('A failed'));
    rerender({ kb: 'B' });
    expect(result.current.phase).toBe('loading');
    expect(result.current.error).toBeNull();
  });

  it('drops a failure when the key changes to a cached query', async () => {
    const { client, wrapper } = setup();
    let bFails = false;
    const { result, rerender } = renderHook(
      ({ kb }: { kb: string }) => {
        const query = useQuery({
          queryKey: ['files', kb],
          queryFn: async () => {
            if (kb === 'A' || bFails) throw new Error(`${kb} failed`);
            return ['x'];
          },
        });
        return useQueryLoadState([query]);
      },
      { wrapper, initialProps: { kb: 'B' } },
    );
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    bFails = true;
    await act(() => client.refetchQueries({ queryKey: ['files', 'B'] }));
    await waitFor(() => expect(result.current.staleError).not.toBeNull());

    rerender({ kb: 'A' });
    await waitFor(() => expect(result.current.error?.message).toBe('A failed'));
    rerender({ kb: 'B' });
    expect(result.current.phase).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(result.current.staleError?.message).toBe('B failed');
  });

  it('reports empty only on success', async () => {
    const { wrapper } = setup();
    const attempt = deferred<string[]>();
    const { result } = renderHook(
      () => {
        const query = useQuery({
          queryKey: ['list'],
          queryFn: () => attempt.promise,
        });
        return useQueryLoadState([query], {
          isEmpty: () => !query.data?.length,
        });
      },
      { wrapper },
    );
    expect(result.current.phase).toBe('loading');
    attempt.resolve([]);
    await waitFor(() => expect(result.current.phase).toBe('empty'));
  });

  it('does not report empty when the load failed', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => {
        const query = useQuery({
          queryKey: ['failing-list'],
          queryFn: () => Promise.reject(new Error('nope')),
        });
        return useQueryLoadState([query], { isEmpty: () => true });
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe('error'));
  });

  it('ignores disabled queries', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => {
        const on = useQuery({ queryKey: ['on'], queryFn: async () => 1 });
        const off = useQuery({
          queryKey: ['off'],
          queryFn: async () => 2,
          enabled: false,
        });
        return useQueryLoadState([on, off]);
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe('ready'));
  });

  it('stays ready with staleError when a refetch fails over existing data', async () => {
    const { client, wrapper } = setup();
    let fail = false;
    const { result } = renderHook(
      () => {
        const query = useQuery({
          queryKey: ['stale'],
          queryFn: async () => {
            if (fail) throw new Error('refresh failed');
            return ['x'];
          },
        });
        return { query, state: useQueryLoadState([query]) };
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    fail = true;
    await act(() => client.refetchQueries({ queryKey: ['stale'] }));
    await waitFor(() =>
      expect(result.current.state.staleError?.message).toBe('refresh failed'),
    );
    expect(result.current.state.phase).toBe('ready');
    expect(result.current.state.error).toBeNull();
  });

  it('keeps the error until every enabled query succeeds', async () => {
    const { wrapper } = setup();
    const detail = deferred<string>();
    let batchesAttempt = deferred<string>();
    const { result } = renderHook(
      () => {
        const batches = useQuery({
          queryKey: ['batches'],
          queryFn: () => batchesAttempt.promise,
        });
        const batch = useQuery({
          queryKey: ['batch'],
          queryFn: () => detail.promise,
        });
        return useQueryLoadState([batches, batch]);
      },
      { wrapper },
    );
    batchesAttempt.reject(new Error('batches down'));
    await waitFor(() => expect(result.current.phase).toBe('error'));

    batchesAttempt = deferred();
    act(() => result.current.retry());
    batchesAttempt.resolve('ok');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.phase).toBe('error');
    expect(result.current.error?.message).toBe('batches down');

    detail.resolve('detail');
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.error).toBeNull();
  });

  it('ignores a disabled query that has a cached failure', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(['ok'], 1);
    await client
      .fetchQuery({
        queryKey: ['cached-bad'],
        queryFn: () => Promise.reject(new Error('old failure')),
      })
      .catch(() => undefined);
    let badCalls = 0;
    const { result } = renderHook(
      () => {
        const ok = useQuery({ queryKey: ['ok'], queryFn: async () => 1 });
        const off = useQuery({
          queryKey: ['cached-bad'],
          queryFn: async () => {
            badCalls++;
            return 2;
          },
          enabled: false,
        });
        return useQueryLoadState([ok, off]);
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    act(() => result.current.retry());
    expect(badCalls).toBe(0);
    expect(result.current.staleError).toBeNull();
  });

  it('does not warn when unmounted during a Retry', async () => {
    const { wrapper } = setup();
    let attempt = deferred<string[]>();
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { result, unmount } = renderHook(
        () => {
          const query = useQuery({
            queryKey: ['unmount'],
            queryFn: () => attempt.promise,
          });
          return useQueryLoadState([query]);
        },
        { wrapper },
      );
      attempt.reject(new Error('boom'));
      await waitFor(() => expect(result.current.phase).toBe('error'));
      attempt = deferred();
      act(() => result.current.retry());
      unmount();
      attempt.resolve(['x']);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }
    expect(errors).toEqual([]);
  });
});

describe('pollUnlessError', () => {
  it('polls until the query errors', () => {
    expect(pollUnlessError(2000)({ state: { status: 'success' } })).toBe(2000);
    expect(pollUnlessError(2000)({ state: { status: 'error' } })).toBe(false);
  });
});
