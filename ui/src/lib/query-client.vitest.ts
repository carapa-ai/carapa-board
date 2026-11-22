import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

type RetryFn = (failureCount: number, error: Error) => boolean;
const retryFor = (key: readonly unknown[]) =>
  queryClient.getQueryDefaults(key).retry as RetryFn;

describe('projects query retry scope', () => {
  it('retries the projects list once and never on a 4xx', () => {
    const retry = retryFor(queryKeys.projects.all);
    expect(retry(0, new ApiError('boom', 500))).toBe(true);
    expect(retry(1, new ApiError('boom', 500))).toBe(false);
    expect(retry(0, new ApiError('forbidden', 403))).toBe(false);
  });

  it('leaves the status-summary query on the app policy (2 retries, 4xx never)', () => {
    const retry = retryFor(queryKeys.projects.statusSummary);
    expect(retry(1, new ApiError('boom', 500))).toBe(true);
    expect(retry(2, new ApiError('boom', 500))).toBe(false);
    expect(retry(0, new ApiError('forbidden', 403))).toBe(false);
    expect(
      queryClient.getQueryDefaults(queryKeys.projects.statusSummary).retryDelay,
    ).toBeUndefined();
  });
});
