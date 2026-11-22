import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageDefinition, TaskRunStageDuration } from '@/types';
import { TaskStageDurationSummary } from './task-stage-duration-summary';

vi.useFakeTimers();
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

const stages: StageDefinition[] = [
  { id: 'active', title: 'Build', type: 'active', color: '#123456' },
  {
    id: 'inactive-testing',
    title: 'Legacy Testing',
    type: 'testing',
    color: '#456789',
    inactive: true,
  },
  { id: 'review-a', title: 'Review', type: 'review', color: '#abcdef' },
  { id: 'review-b', title: 'Review', type: 'review', color: '#fedcba' },
];

const duration = (
  stageId: string | null,
  completedDurationMs: number,
  runningStartedAt: string[] = [],
  runningDurationMs = runningStartedAt.length ? 1 : 0,
  costUsd: number | null = null,
): TaskRunStageDuration => ({
  stageId,
  completedDurationMs,
  runningStartedAt,
  runningDurationMs,
  runningReferenceAt: runningStartedAt.length
    ? new Date(Date.now() - 1_000).toISOString()
    : new Date().toISOString(),
  costUsd,
});

describe('TaskStageDurationSummary', () => {
  it('orders configured stages, preserves duplicate titles, and appends history', () => {
    const { container } = render(
      <TaskStageDurationSummary
        stages={stages}
        durations={[
          duration('review-b', 120_000, [], 0, 0.4652),
          duration('removed', 30_000),
          duration(null, 0),
        ]}
      />,
    );
    const rows = [...container.querySelectorAll('[data-stage-id]')];
    expect(rows.map((row) => row.getAttribute('data-stage-id'))).toEqual([
      'active',
      'review-a',
      'review-b',
      'removed',
      'unknown',
    ]);
    expect(rows[1].textContent).toContain('Review');
    expect(rows[2].textContent).toContain('2m');
    expect(rows[2].textContent).toContain('$0.4652');
    expect(
      rows[0].querySelector('[data-ui="task-stage-duration-cost"]'),
    ).toBeNull();
  });

  it('advances running time while keeping completed duration as its base', () => {
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const { container } = render(
      <TaskStageDurationSummary
        stages={stages}
        durations={[duration('active', 5_000, [startedAt])]}
      />,
    );
    expect(
      container.querySelector('[data-stage-id="active"]')?.textContent,
    ).toContain('6s');
    act(() => {
      vi.setSystemTime(Date.now() + 2_000);
      vi.advanceTimersByTime(1_000);
    });
    expect(
      container.querySelector('[data-stage-id="active"]')?.textContent,
    ).toContain('9s');
  });

  it('clamps future and mixed running rows independently', () => {
    const referenceAt = new Date(Date.now()).toISOString();
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const futureAt = new Date(Date.now() + 10_000).toISOString();
    const { container } = render(
      <TaskStageDurationSummary
        stages={stages}
        durations={[
          {
            stageId: 'active',
            completedDurationMs: 0,
            runningStartedAt: [startedAt, futureAt],
            runningDurationMs: 2_000,
            runningReferenceAt: referenceAt,
            costUsd: null,
          },
        ]}
      />,
    );
    expect(
      container.querySelector('[data-stage-id="active"]')?.textContent,
    ).toContain('2s');
    act(() => {
      vi.setSystemTime(Date.now() + 2_000);
      vi.advanceTimersByTime(1_000);
    });
    expect(
      container.querySelector('[data-stage-id="active"]')?.textContent,
    ).toContain('5s');
  });
});
