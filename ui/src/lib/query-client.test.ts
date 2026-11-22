// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { queryClient } from './query-client';

class StatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const retry = queryClient.getDefaultOptions().queries?.retry as (
  failureCount: number,
  error: Error,
) => boolean;

describe('queryClient default retry rule', () => {
  test('does not retry 4xx ApiError-style errors regardless of message text', () => {
    for (const [status, message] of [
      [404, 'Task not found'],
      [403, 'Forbidden'],
      [401, 'Session expired'],
      [422, 'Invalid payload'],
    ] as const) {
      expect(retry(0, new StatusError(message, status))).toBe(false);
    }
  });

  test('still retries 5xx and network errors while failureCount < 2', () => {
    for (const error of [
      new StatusError('Bad gateway', 502),
      new StatusError('Internal error', 500),
      new Error('Failed to fetch'),
    ]) {
      expect(retry(0, error)).toBe(true);
      expect(retry(1, error)).toBe(true);
      expect(retry(2, error)).toBe(false);
    }
  });

  test('does not retry an error whose message is HTTP 4xx without a status', () => {
    expect(retry(0, new Error('HTTP 404'))).toBe(false);
  });
});
