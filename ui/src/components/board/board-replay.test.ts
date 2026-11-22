// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import type { BoardReplayData, TaskSummary } from '@/types';
import { reconstructReplayTasks, replayRunsAt } from './board-replay-state';

const task = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'task-1',
  project_id: 'project-1',
  title: 'Replay me',
  description: '',
  status: 'backlog',
  priority: 0,
  created_at: '2026-07-30T10:00:00.000Z',
  ...overrides,
});

describe('board replay state reconstruction', () => {
  test('applies ordered updates and deletion at the selected timestamp', () => {
    const initial = task();
    const moved = task({ status: 'implementation', priority: 1000 });
    const data: BoardReplayData = {
      initialTasks: [initial],
      events: [
        {
          id: 1,
          project_id: initial.project_id,
          task_id: initial.id,
          event_type: 'updated',
          occurred_at: '2026-07-30T11:00:00.000Z',
          snapshot: moved,
        },
        {
          id: 2,
          project_id: initial.project_id,
          task_id: initial.id,
          event_type: 'deleted',
          occurred_at: '2026-07-30T12:00:00.000Z',
          snapshot: moved,
        },
      ],
      runs: [],
      reviewMilestones: [],
      exactHistoryAvailableFrom: null,
      runHistoryAvailableFrom: null,
    };

    expect(
      reconstructReplayTasks(data, Date.parse('2026-07-30T11:30:00Z'))[0],
    ).toMatchObject({ status: 'implementation', priority: 1000 });
    expect(
      reconstructReplayTasks(data, Date.parse('2026-07-30T12:00:00Z')),
    ).toEqual([]);
  });

  test('does not leak later review notes and scores into inferred pre-history', () => {
    const inferred = task({
      description:
        'Original task\n\n## Review notes\n\n- Verdict: accepted_with_nits',
      custom_values: {
        owner: 'alice',
        quality_score: 8,
        rejection_count: 2,
        testing_failure_count: 1,
      },
    });
    const boundary = '2026-07-30T12:00:00.000Z';
    const data: BoardReplayData = {
      initialTasks: [inferred],
      events: [
        {
          id: 1,
          project_id: inferred.project_id,
          task_id: inferred.id,
          event_type: 'seed',
          occurred_at: boundary,
          snapshot: inferred,
        },
      ],
      runs: [],
      reviewMilestones: [
        {
          task_id: inferred.id,
          occurred_at: '2026-07-30T11:30:00.000Z',
          score: 6,
          rejection_count: 1,
        },
      ],
      exactHistoryAvailableFrom: boundary,
      runHistoryAvailableFrom: null,
    };

    const before = reconstructReplayTasks(
      data,
      Date.parse('2026-07-30T11:00:00Z'),
    )[0];
    expect(before.description).toBe('Original task');
    expect(before.error).toBeUndefined();
    expect(before.custom_values).toEqual({
      owner: 'alice',
      testing_failure_count: 1,
    });

    const reviewed = reconstructReplayTasks(
      data,
      Date.parse('2026-07-30T11:45:00Z'),
    )[0];
    expect(reviewed.custom_values?.quality_score).toBe(6);
    expect(reviewed.custom_values?.rejection_count).toBe(1);

    const after = reconstructReplayTasks(data, Date.parse(boundary))[0];
    expect(after.description).toContain('## Review notes');
    expect(after.custom_values?.quality_score).toBe(8);
    expect(after.custom_values?.rejection_count).toBe(2);
  });

  test('shows an overlapping run as running, then exposes its outcome', () => {
    const data: BoardReplayData = {
      initialTasks: [task()],
      events: [],
      runs: [
        {
          id: 'run-1',
          task_id: 'task-1',
          started_at: '2026-07-30T10:00:00.000Z',
          completed_at: '2026-07-30T10:10:00.000Z',
          status: 'error',
          stage: 'testing',
          agent_name: 'codex',
          model: null,
          model_name: null,
        },
      ],
      reviewMilestones: [],
      exactHistoryAvailableFrom: null,
      runHistoryAvailableFrom: null,
    };

    expect(
      replayRunsAt(data, Date.parse('2026-07-30T10:05:00Z')).get('task-1')
        ?.status,
    ).toBe('running');
    expect(
      replayRunsAt(data, Date.parse('2026-07-30T10:11:00Z')).get('task-1')
        ?.status,
    ).toBe('error');
    expect(
      replayRunsAt(data, Date.parse('2026-07-30T10:11:00Z'), 30_000).get(
        'task-1',
      ),
    ).toBeUndefined();
  });
});
