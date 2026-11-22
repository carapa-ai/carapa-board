import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { initDatabase, createTask, updateTask } from '../../../db.js';
import { insertActiveRun } from '../../../db/active-runs.js';
import {
  runFixture,
  taskFixture,
  truncateTestDb,
} from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import { taskEventHeaders, taskOutcomeEventData } from './objective-events.js';
import { truncateEventText } from '../../objectives/brain-client.js';

const baseTask = {
  id: 'task-1',
  project_id: 'demo',
  title: 'Fix the editor',
  description: '',
  status: 'active',
  priority: 0,
  created_at: new Date().toISOString(),
} satisfies Task;

const group = {
  name: 'Demo',
  folder: 'demo',
  trigger: '@Demo',
  added_at: new Date().toISOString(),
  settings: { workspacePath: '/workspace/demo' },
} satisfies RegisteredGroup;

describe('taskEventHeaders', () => {
  test('uses the configured mounted workspace for a non-worktree task', () => {
    expect(taskEventHeaders(baseTask, group)).toEqual({
      title: 'Fix the editor',
      working_directory: '/workspace/demo',
    });
  });

  test('uses the mounted branch worktree instead of the persisted host path', () => {
    expect(
      taskEventHeaders(
        {
          ...baseTask,
          branch_name: 'task/task-1',
          worktree_path: '/host/repos/demo/.worktrees/task-1',
        },
        group,
      ),
    ).toEqual({
      title: 'Fix the editor',
      working_directory: '/workspace/demo/.worktrees/task/task-1',
    });
  });

  test('uses the mounted workspace for a branch-mode task without a worktree', () => {
    expect(
      taskEventHeaders(
        { ...baseTask, branch_name: 'task/task-1', worktree_path: null },
        group,
      ),
    ).toEqual({
      title: 'Fix the editor',
      working_directory: '/workspace/demo',
    });
  });
});

describe('taskOutcomeEventData', () => {
  const PROJ = 'task-outcome-project';
  let initialized = false;
  beforeAll(async () => {
    if (!initialized) {
      await initDatabase(':memory:');
      initialized = true;
    }
  });
  beforeEach(async () => {
    await truncateTestDb();
  });

  test('omits review_score, defaults rejection_count and zero stats for a fresh task', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const data = await taskOutcomeEventData(task.id, 'task_completed');
    expect(data).toEqual({
      rejection_count: 0,
      testing_failure_total: 0,
      merged: false,
      cost_usd: 0,
      run_count: 0,
    });
    expect('review_score' in data).toBe(false);
  });

  test('includes nit_round_count only when set to a finite non-negative number', async () => {
    const withNits = await createTask(
      taskFixture({ project_id: PROJ, custom_values: { nit_round_count: 2 } }),
    );
    expect(
      (await taskOutcomeEventData(withNits.id, 'task_completed'))
        .nit_round_count,
    ).toBe(2);

    const without = await createTask(taskFixture({ project_id: PROJ }));
    expect(
      'nit_round_count' in
        (await taskOutcomeEventData(without.id, 'task_completed')),
    ).toBe(false);
  });

  test('reports score, rejections, merge commit and summed run cost', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        custom_values: {
          quality_score: 8,
          rejection_count: 2,
          testing_failure_total: 2,
          testing_failure_count: 0,
        },
      }),
    );
    await updateTask(task.id, { merge_commit: 'abc123' });
    for (const [id, cost] of [
      ['outcome-run-1', 0.25],
      ['outcome-run-2', 0.5],
      ['outcome-run-3', null],
    ] as const) {
      await insertActiveRun({
        ...runFixture({ id, task_id: task.id, group_folder: PROJ }),
        cost_usd: cost,
      } as never);
    }

    expect(await taskOutcomeEventData(task.id, 'task_completed')).toEqual({
      review_score: 8,
      rejection_count: 2,
      testing_failure_total: 2,
      merged: true,
      merge_commit: 'abc123',
      cost_usd: 0.75,
      run_count: 3,
    });
  });

  test('adds failure_reason and failure_stage only for task_failed', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, status: 'failed', error: 'boom' }),
    );
    expect(await taskOutcomeEventData(task.id, 'task_failed')).toMatchObject({
      failure_reason: 'boom',
      failure_stage: 'failed',
    });
    expect(
      await taskOutcomeEventData(task.id, 'task_completed'),
    ).not.toHaveProperty('failure_reason');
  });
});

describe('truncateEventText', () => {
  test('leaves text up to 4000 characters unchanged', () => {
    const text = 'x'.repeat(4000);
    expect(truncateEventText(text)).toBe(text);
  });

  test('keeps the first and last 2000 characters around a marker above the limit', () => {
    const text = `${'H'.repeat(2000)}${'M'.repeat(1000)}${'T'.repeat(2000)}`;
    expect(truncateEventText(text)).toBe(
      `${'H'.repeat(2000)}…[truncated 1000 chars]…${'T'.repeat(2000)}`,
    );
    expect(truncateEventText('x'.repeat(4001))).toBe(
      `${'x'.repeat(2000)}…[truncated 1 chars]…${'x'.repeat(2000)}`,
    );
  });
});
