import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createTask,
  deleteTask,
  initDatabase,
  insertActiveRun,
  updateTask,
} from '../../db.js';
import {
  getBoardReplay,
  replayTaskSnapshot,
  reviewMilestonesFromMessages,
} from './board-replay.js';
import { runFixture, taskFixture, truncateTestDb } from '../../test-helpers.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { taskBoardEvents } from '../../db/schema.js';

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await truncateTestDb();
});

describe('board replay persistence', () => {
  test('extracts timestamped review scores and rejection counters', () => {
    expect(
      reviewMilestonesFromMessages('task-1', [
        {
          content:
            '**Review rejected** (score: 6/10, rejection 2)\n\nNeeds work',
          created_at: '2026-07-30T10:00:00.000Z',
        },
        {
          content: '**Review approved** (score: 9/10)',
          created_at: '2026-07-30T11:00:00.000Z',
        },
      ]),
    ).toEqual([
      {
        task_id: 'task-1',
        occurred_at: '2026-07-30T10:00:00.000Z',
        score: 6,
        rejection_count: 2,
      },
      {
        task_id: 'task-1',
        occurred_at: '2026-07-30T11:00:00.000Z',
        score: 9,
        rejection_count: null,
      },
    ]);
  });

  test('records visible changes but ignores execution-only bookkeeping', async () => {
    const task = await createTask(taskFixture());
    await updateTask(task.id, {
      output: 'streamed text',
      session_id: 'session-1',
    });
    await updateTask(task.id, { status: 'in_progress', priority: 2000 });

    const replay = await getBoardReplay(
      task.project_id,
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );

    expect(replay.events.map((event) => event.event_type)).toEqual([
      'created',
      'updated',
    ]);
    expect(replay.events[1]?.snapshot.status).toBe('in_progress');
    expect(replay.events[1]?.snapshot.priority).toBe(2000);
  });

  test('records runtime-only edits without emitting legacy task configuration', async () => {
    const initialRuntime = { harnessId: 'codex', modelId: 'gpt-5.6-sol' };
    const updatedRuntime = {
      harnessId: 'claude-code',
      modelId: 'claude-sonnet-4-5',
      reasoning: 'high',
    };
    const task = await createTask(
      taskFixture({ runtimeSelection: initialRuntime }),
    );
    await updateTask(task.id, { runtimeSelection: updatedRuntime });

    const replay = await getBoardReplay(
      task.project_id,
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );

    expect(
      replay.events.map((event) => event.snapshot.runtimeSelection),
    ).toEqual([initialRuntime, updatedRuntime]);
    for (const event of replay.events) {
      expect('model' in event.snapshot).toBe(false);
      expect('agent_name' in event.snapshot).toBe(false);
    }
  });

  test('loads previously stored replay snapshots with extra legacy keys', async () => {
    const task = await createTask(taskFixture());
    await drizzleDbRef.current.insert(taskBoardEvents).values({
      project_id: task.project_id,
      task_id: task.id,
      event_type: 'seed',
      occurred_at: '2026-01-01T00:00:00.000Z',
      snapshot: {
        ...replayTaskSnapshot(task),
        model: 'legacy-model',
        agent_name: 'legacy-agent',
      } as any,
    });

    const replay = await getBoardReplay(
      task.project_id,
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    );
    expect(replay.initialTasks[0]).toMatchObject({
      id: task.id,
      title: task.title,
    });
  });

  test('retains the final snapshot after a task and its runs are deleted', async () => {
    const task = await createTask(taskFixture({ title: 'Historical card' }));
    await insertActiveRun(
      runFixture({
        id: 'deleted-task-run',
        group_folder: task.project_id,
        task_id: task.id,
        stage: 'implementation',
        status: 'completed',
        completed_at: new Date().toISOString(),
      }),
    );

    await deleteTask(task.id);

    const replay = await getBoardReplay(
      task.project_id,
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );
    expect(replay.events.at(-1)?.event_type).toBe('deleted');
    expect(replay.events.at(-1)?.snapshot.title).toBe('Historical card');
    expect(replay.runs).toEqual([]);
  });

  test('returns runs overlapping the requested period with their stage', async () => {
    const task = await createTask(taskFixture());
    await insertActiveRun(
      runFixture({
        id: 'overlap-run',
        group_folder: task.project_id,
        task_id: task.id,
        stage: 'testing',
        started_at: '2026-07-30T10:00:00.000Z',
        completed_at: '2026-07-30T10:30:00.000Z',
        status: 'completed',
      }),
    );

    const replay = await getBoardReplay(
      task.project_id,
      '2026-07-30T10:15:00.000Z',
      '2026-07-30T10:20:00.000Z',
    );
    expect(replay.runs).toHaveLength(1);
    expect(replay.runs[0]).toMatchObject({
      id: 'overlap-run',
      task_id: task.id,
      stage: 'testing',
      status: 'completed',
    });
  });
});
