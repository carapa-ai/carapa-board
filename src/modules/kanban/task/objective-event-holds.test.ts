import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTask, initDatabase, updateTask } from '../../../db.js';
import { drizzleDbRef } from '../../../db/drizzle-client.js';
import { objectiveTaskEventHolds } from '../../../db/schema.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import type { PublishEventResult } from '../../objectives/brain-client.js';
import type { notifyEntityLifecycle } from '../../tools/push-tools.js';
import type { Task } from '../types.js';
import {
  OBJECTIVE_EVENT_HOLD_TIMEOUT_MS,
  acknowledgeObjectiveTaskEvent,
  publishEventAndNotify,
  publishTaskEventAndNotify,
  settleOverdueObjectiveTaskEventHolds,
} from './objective-event-holds.js';

const PROJ = 'objective-hold-project';
const OBJECTIVE = 'obj-1';
const group = {
  name: 'Hold',
  folder: PROJ,
  trigger: '@Hold',
  added_at: new Date().toISOString(),
} satisfies RegisteredGroup;

type Notified = Parameters<typeof notifyEntityLifecycle>[0];

let notified: Notified[];
const notify = async (args: Notified) => {
  notified.push(args);
};

async function publishQuestion(task: Task, publication: PublishEventResult) {
  const { released } = await publishTaskEventAndNotify(
    task,
    group,
    { type: 'task_question', source: 'agent_update' },
    {
      group_folder: PROJ,
      task_id: task.id,
      run_id: 'run-1',
      event: 'needs_input',
      title: 'Task needs input',
    },
    { notify, publish: async () => publication },
  );
  await released;
}

async function questionTask(objective_id: string | null = OBJECTIVE) {
  return createTask(
    taskFixture({
      project_id: PROJ,
      status: 'question',
      ...(objective_id ? { objective_id } : {}),
    }),
  );
}

const enqueued: PublishEventResult = {
  outcome: 'delivered',
  delivery: { status: 'enqueued' },
};
const ack = (task: Task, timestamp?: string) => ({
  objective_id: OBJECTIVE,
  task_id: task.id,
  event_type: 'task_question' as const,
  event_timestamp: timestamp,
  outcome: 'handled' as const,
});

describe('objective task-event notification holds', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
  });
  beforeEach(async () => {
    await truncateTestDb();
    notified = [];
  });

  test('an untagged task notifies immediately', async () => {
    const task = await questionTask(null);
    await publishQuestion(task, enqueued);
    expect(notified).toHaveLength(1);
    expect(
      await drizzleDbRef.current.select().from(objectiveTaskEventHolds),
    ).toEqual([]);
  });

  test('a raw event publisher is still called for an untagged task', async () => {
    const task = await questionTask(null);
    const timestamps: string[] = [];
    await publishEventAndNotify(
      task,
      'task_failed',
      async (timestamp) => {
        timestamps.push(timestamp);
        return enqueued;
      },
      {
        group_folder: PROJ,
        task_id: task.id,
        run_id: 'r',
        event: 'failed',
        title: 't',
      },
      { notify },
    );
    expect(timestamps).toHaveLength(1);
    expect(notified).toHaveLength(1);
  });

  test.each<[string, PublishEventResult]>([
    ['skipped', { outcome: 'skipped' }],
    ['failed', { outcome: 'failed' }],
    ['legacy brain without delivery', { outcome: 'delivered' }],
    [
      'dropped',
      { outcome: 'delivered', delivery: { status: 'dropped', reason: 'busy' } },
    ],
  ])('releases immediately when the publish is %s', async (_, publication) => {
    const task = await questionTask();
    await publishQuestion(task, publication);
    expect(notified).toHaveLength(1);
    expect(await acknowledgeObjectiveTaskEvent(ack(task), { notify })).toBe(0);
    expect(notified).toHaveLength(1);
  });

  test.each<[string, PublishEventResult]>([
    ['enqueued', enqueued],
    ['queued in the outbox', { outcome: 'queued' }],
  ])('keeps the hold when the publish is %s', async (_, publication) => {
    const task = await questionTask();
    await publishQuestion(task, publication);
    expect(notified).toEqual([]);
  });

  test('an ack notifies once while the task is still in the held stage', async () => {
    const task = await questionTask();
    await publishQuestion(task, enqueued);
    expect(await acknowledgeObjectiveTaskEvent(ack(task), { notify })).toBe(1);
    expect(await acknowledgeObjectiveTaskEvent(ack(task), { notify })).toBe(0);
    await settleOverdueObjectiveTaskEventHolds(
      { notify },
      Date.now() + 2 * OBJECTIVE_EVENT_HOLD_TIMEOUT_MS,
    );
    expect(notified).toHaveLength(1);
  });

  test('an ack drops the notification when the agent moved the task', async () => {
    const task = await questionTask();
    await publishQuestion(task, enqueued);
    await updateTask(task.id, { status: 'in_progress' });
    expect(await acknowledgeObjectiveTaskEvent(ack(task), { notify })).toBe(1);
    expect(notified).toEqual([]);
  });

  test('an ack only settles the hold with the matching timestamp', async () => {
    const task = await questionTask();
    await publishQuestion(task, enqueued);
    expect(
      await acknowledgeObjectiveTaskEvent(
        ack(task, '2000-01-01T00:00:00.000Z'),
        {
          notify,
        },
      ),
    ).toBe(0);
    expect(notified).toEqual([]);
  });

  test('the timeout settles an unacked hold from the persisted row', async () => {
    const stillThere = await questionTask();
    const moved = await questionTask();
    await publishQuestion(stillThere, enqueued);
    await publishQuestion(moved, enqueued);
    await updateTask(moved.id, { status: 'in_progress' });

    await settleOverdueObjectiveTaskEventHolds({ notify });
    expect(notified).toEqual([]);

    const later = Date.now() + OBJECTIVE_EVENT_HOLD_TIMEOUT_MS + 1000;
    await settleOverdueObjectiveTaskEventHolds({ notify }, later);
    await settleOverdueObjectiveTaskEventHolds({ notify }, later);
    expect(notified.map((entry) => entry.task_id)).toEqual([stillThere.id]);
  });
});
