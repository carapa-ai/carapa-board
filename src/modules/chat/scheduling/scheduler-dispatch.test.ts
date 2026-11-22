import { expect, test } from 'bun:test';
import { createSchedulerDispatch } from './scheduler-dispatch.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('keeps polling cron and newly due chats while maintenance and another chat wait', async () => {
  const maintenance = deferred();
  const chat = deferred();
  const chatStarted = deferred();
  const chatFinished = deferred();
  const errors: unknown[] = [];
  let tasks = [{ id: 'slow-chat' }];
  const starts: string[] = [];
  let cronPolls = 0;
  let maintenancePasses = 0;
  const poll = createSchedulerDispatch({
    getDueTasks: async () => tasks,
    runTask: async (task) => {
      starts.push(task.id);
      if (task.id === 'slow-chat') {
        chatStarted.resolve();
        await chat.promise;
        chatFinished.resolve();
      }
    },
    processCronjobs: async () => {
      cronPolls++;
    },
    maintain: async () => {
      maintenancePasses++;
      await maintenance.promise;
    },
    onError: (_lane, error) => errors.push(error),
  });

  const firstPoll = poll();
  try {
    await chatStarted.promise;
    // The agent-start callback runs inside admission; let that admission
    // finish before simulating the next timer tick.
    await Promise.resolve();
    tasks = [{ id: 'slow-chat' }, { id: 'new-chat' }];
    await poll();
    expect(starts).toEqual(['slow-chat', 'new-chat']);
    expect(cronPolls).toBe(2);
    expect(maintenancePasses).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    chat.resolve();
    maintenance.resolve();
    await Promise.all([firstPoll, chatFinished.promise]);
  }
});

test('a held cron sweep or schedule query cannot block other lanes or overlap itself', async () => {
  const cron = deferred();
  const query = deferred();
  const errors: unknown[] = [];
  let queries = 0;
  let cronPolls = 0;
  let maintenancePasses = 0;
  const poll = createSchedulerDispatch({
    getDueTasks: async () => {
      queries++;
      await query.promise;
      return [];
    },
    runTask: async () => {},
    processCronjobs: async () => {
      cronPolls++;
      await cron.promise;
    },
    maintain: async () => {
      maintenancePasses++;
    },
    onError: (_lane, error) => errors.push(error),
  });
  const firstPoll = poll();
  try {
    // Finish the immediately resolved maintenance lane, leaving both other
    // lanes deliberately in flight across the next polling tick.
    await Promise.resolve();
    await poll();
    expect(queries).toBe(1);
    expect(cronPolls).toBe(1);
    expect(maintenancePasses).toBe(2);
  } finally {
    cron.resolve();
    query.resolve();
    await firstPoll;
  }
  await poll();
  expect(queries).toBe(2);
  expect(cronPolls).toBe(2);
  expect(errors).toEqual([]);
});

test('releases failed lanes and tasks for retry without stopping healthy work', async () => {
  const errors: string[] = [];
  let attempt = 0;
  const starts: string[] = [];
  const poll = createSchedulerDispatch({
    getDueTasks: async () => {
      if (attempt === 0) throw new Error('query unavailable');
      return [{ id: 'failed-chat' }, { id: 'healthy-chat' }];
    },
    runTask: async (task) => {
      starts.push(task.id);
      if (task.id === 'failed-chat') throw new Error('launch failed');
    },
    processCronjobs: async () => {
      if (attempt === 0) throw new Error('cron unavailable');
    },
    maintain: async () => {
      if (attempt === 0) throw new Error('maintenance unavailable');
    },
    onError: (lane, _error, taskId) => errors.push(taskId ?? lane),
  });
  await poll();
  expect(errors.sort()).toEqual(['cronjobs', 'maintenance', 'scheduled_tasks']);
  attempt++;
  await poll();
  await poll();
  expect(starts).toEqual([
    'failed-chat',
    'healthy-chat',
    'failed-chat',
    'healthy-chat',
  ]);
  expect(errors.filter((id) => id === 'failed-chat')).toHaveLength(2);
});
