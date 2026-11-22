// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { sortTasksForStage } from './stages';

const task = (
  id: string,
  overrides: Partial<{
    running: boolean;
    priority: number;
    created_at: string;
    completed_at: string | null;
  }> = {},
) => ({
  id,
  running: false,
  priority: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  completed_at: null,
  ...overrides,
});

describe('sortTasksForStage', () => {
  test('orders active stages by running state, priority, then newest creation', () => {
    const tasks = [
      task('older', { priority: 10, created_at: '2026-01-01T00:00:00.000Z' }),
      task('newer', { priority: 10, created_at: '2026-02-01T00:00:00.000Z' }),
      task('priority', { priority: 5 }),
      task('running', { running: true, priority: 100 }),
    ];

    expect(
      sortTasksForStage(tasks, { type: 'active' }).map((item) => item.id),
    ).toEqual(['running', 'priority', 'newer', 'older']);
    expect(tasks.map((item) => item.id)).toEqual([
      'older',
      'newer',
      'priority',
      'running',
    ]);
  });

  test('orders done stages by newest completion', () => {
    const tasks = [
      task('old', { completed_at: '2026-01-01T00:00:00.000Z' }),
      task('new', { completed_at: '2026-03-01T00:00:00.000Z' }),
      task('middle', { completed_at: '2026-02-01T00:00:00.000Z' }),
    ];

    expect(
      sortTasksForStage(tasks, { type: 'done' }).map((item) => item.id),
    ).toEqual(['new', 'middle', 'old']);
  });
});
