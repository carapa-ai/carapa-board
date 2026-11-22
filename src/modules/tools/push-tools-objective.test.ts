import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  notifyEntityLifecycle,
  notifyStageEntryLifecycle,
  notifyUserSystem,
} from './push-tools.js';
import {
  completeStageEntryEventIfOwned,
  createTask,
  createUser,
  getUnreadPayloads,
  initDatabase,
  upsertProjectMember,
} from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects, stageEntryEvents } from '../../db/schema.js';
import { taskFixture, truncateTestDb } from '../../test-helpers.js';

beforeAll(() => initDatabase(':memory:'));
beforeEach(() => truncateTestDb());

type NotifyInput = Parameters<typeof notifyUserSystem>[2];

/** Records the push decision for each recipient, then delegates to the real notifier. */
function recordingNotifier() {
  const calls: NotifyInput[] = [];
  const notifyUser: typeof notifyUserSystem = (userId, folder, input) => {
    calls.push(input);
    return notifyUserSystem(userId, folder, input);
  };
  return { calls, notifyUser };
}

async function setup(name: string, objectiveId?: string) {
  const owner = await createUser(`${name}-owner`, 'pw', 'user');
  const task = await createTask(
    taskFixture({
      project_id: `${name}-project`,
      ownerUserId: owner.id,
      lastTriggeredByUserId: owner.id,
      lastTriggerSource: 'user',
      ...(objectiveId ? { objective_id: objectiveId } : {}),
    }),
  );
  await upsertProjectMember(owner.id, task.project_id, 'owner');
  return { owner, task };
}

describe('objective task completion push suppression', () => {
  test('completed objective task keeps the in-app notification but skips the push', async () => {
    const { owner, task } = await setup('objective-completed', 'objective-1');
    const { calls, notifyUser } = recordingNotifier();

    await notifyEntityLifecycle(
      {
        group_folder: task.project_id,
        task_id: task.id,
        run_id: 'run-1',
        event: 'completed',
        title: 'Task completed: objective work',
      },
      { notifyUser },
    );

    expect(calls.map((call) => call.suppress_push)).toEqual([true]);
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({ summary: 'Task completed: objective work' }),
    ]);
  });

  test('completed task without an objective still pushes', async () => {
    const { owner, task } = await setup('plain-completed');
    const { calls, notifyUser } = recordingNotifier();

    await notifyEntityLifecycle(
      {
        group_folder: task.project_id,
        task_id: task.id,
        run_id: 'run-1',
        event: 'completed',
        title: 'Task completed: plain',
      },
      { notifyUser },
    );

    expect(calls.map((call) => call.suppress_push)).toEqual([false]);
    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
  });

  test('failed and needs_input events for objective tasks still push', async () => {
    const { task } = await setup('objective-other-events', 'objective-2');
    const { calls, notifyUser } = recordingNotifier();

    for (const event of ['failed', 'needs_input'] as const) {
      await notifyEntityLifecycle(
        {
          group_folder: task.project_id,
          task_id: task.id,
          run_id: `run-${event}`,
          event,
          title: `Task ${event}`,
        },
        { notifyUser },
      );
    }

    expect(calls.map((call) => call.suppress_push)).toEqual([false, false]);
  });

  test('deferred passive-stage-entry completion skips the push for objective tasks', async () => {
    const { owner, task } = await setup('objective-deferred', 'objective-3');
    await drizzleDbRef.current.insert(projects).values({
      id: task.project_id,
      jid: `${task.project_id}@board`,
      name: 'Deferred objective',
      folder: task.project_id,
      trigger: '@deferred',
      added_at: new Date().toISOString(),
      settings: '{}',
    });
    await drizzleDbRef.current.insert(stageEntryEvents).values({
      id: 'stage-entry-objective-deferred',
      project_id: task.project_id,
      task_id: task.id,
      stage_id: task.status,
      state: 'running',
      created_at: new Date().toISOString(),
    });
    const { calls, notifyUser } = recordingNotifier();

    await notifyEntityLifecycle(
      {
        group_folder: task.project_id,
        task_id: task.id,
        run_id: 'run-deferred',
        event: 'completed',
        title: 'Deferred objective completed',
        defer_stage_entry: true,
      },
      { notifyUser },
    );
    expect(calls).toHaveLength(0);

    const succeeded = await completeStageEntryEventIfOwned({
      eventId: 'stage-entry-objective-deferred',
      state: 'succeeded',
      output: '',
      error: null,
      lastAgentName: null,
    });
    // The receipt-recorded notification is replayed through the same dispatcher.
    await notifyStageEntryLifecycle(
      succeeded!.event,
      { id: task.id, project_id: task.project_id },
      { notifyUser },
    );

    expect(calls.map((call) => call.suppress_push)).toEqual([true]);
    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
  });
});
