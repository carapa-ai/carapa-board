import { afterEach, describe, expect, test, vi } from 'vitest';
import { QueryInvalidationCoalescer } from './query-invalidation-coalescer';

const active: QueryInvalidationCoalescer[] = [];

afterEach(() => {
  for (const coalescer of active) coalescer.clear();
  active.length = 0;
  vi.useRealTimers();
});

describe('QueryInvalidationCoalescer', () => {
  test('does not combine independent cache keys', () => {
    const coalescer = new QueryInvalidationCoalescer(10);
    active.push(coalescer);
    const calls: string[] = [];

    coalescer.invalidate('tasks:a', () => calls.push('a'));
    coalescer.invalidate('tasks:b', () => calls.push('b'));

    expect(calls).toEqual(['a', 'b']);
  });

  test('waits for a quiet period instead of firing periodically', () => {
    vi.useFakeTimers();
    const coalescer = new QueryInvalidationCoalescer(10);
    active.push(coalescer);
    let calls = 0;

    coalescer.invalidate('tasks:project', () => calls++);
    vi.advanceTimersByTime(8);
    coalescer.invalidate('tasks:project', () => calls++);
    vi.advanceTimersByTime(8);
    coalescer.invalidate('tasks:project', () => calls++);
    vi.advanceTimersByTime(9);

    expect(calls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(2);
  });
});
