import { describe, expect, test } from 'bun:test';
import { effectiveMaxParallel } from './types.js';

describe('effectiveMaxParallel', () => {
  test('serializes tasks when worktree isolation is disabled', () => {
    expect(effectiveMaxParallel({ maxParallelWorktrees: 4 })).toBe(1);
  });

  test('uses configured parallelism in worktree mode', () => {
    expect(
      effectiveMaxParallel({
        taskCheckoutMode: 'worktree',
        maxParallelWorktrees: 4,
      }),
    ).toBe(4);
  });

  test('does not allow zero slots to stall the queue', () => {
    expect(
      effectiveMaxParallel({
        taskCheckoutMode: 'worktree',
        maxParallelWorktrees: 0,
      }),
    ).toBe(1);
  });
});
