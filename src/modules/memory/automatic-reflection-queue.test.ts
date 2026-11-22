import { expect, test } from 'bun:test';
import { AutomaticReflectionQueue } from './automatic-reflection-queue.js';

test('retries an incomplete range before processing the next range', async () => {
  const queue = new AutomaticReflectionQueue(1);
  const calls: string[] = [];
  let firstAttempts = 0;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });

  queue.enqueue({
    sourceKey: 'project\0transcript',
    process: async () => {
      calls.push('first');
      firstAttempts++;
      return { completed: firstAttempts > 1 };
    },
  });
  queue.enqueue({
    sourceKey: 'project\0transcript',
    process: async () => {
      calls.push('second');
      resolveCompleted();
      return { completed: true };
    },
  });

  await completed;
  expect(calls).toEqual(['first', 'first', 'second']);
});

test('retries a thrown range without advancing the source queue', async () => {
  const queue = new AutomaticReflectionQueue(1);
  const calls: string[] = [];
  const failures: unknown[] = [];
  let firstAttempts = 0;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });

  queue.enqueue({
    sourceKey: 'project\0transcript',
    process: async () => {
      calls.push('first');
      firstAttempts++;
      if (firstAttempts === 1) throw new Error('provider unavailable');
      return { completed: true };
    },
    onIncomplete: (error) => failures.push(error),
  });
  queue.enqueue({
    sourceKey: 'project\0transcript',
    process: async () => {
      calls.push('second');
      resolveCompleted();
      return null;
    },
  });

  await completed;
  expect(calls).toEqual(['first', 'first', 'second']);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(Error);
});

test('limits concurrent work across independent transcript sources', async () => {
  const queue = new AutomaticReflectionQueue(1);
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let resolveSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStarted = resolve;
  });

  queue.enqueue({
    sourceKey: 'project-a\0transcript',
    process: async () => {
      calls.push('first');
      active++;
      maxActive = Math.max(maxActive, active);
      await firstReleased;
      active--;
      return { completed: true };
    },
  });
  queue.enqueue({
    sourceKey: 'project-b\0transcript',
    process: async () => {
      calls.push('second');
      active++;
      maxActive = Math.max(maxActive, active);
      resolveSecondStarted();
      active--;
      return { completed: true };
    },
  });

  releaseFirst();
  await secondStarted;
  expect(calls).toEqual(['first', 'second']);
  expect(maxActive).toBe(1);
});

test('backs off exponentially after a rate-limited reflection', async () => {
  let runRetry!: () => void;
  let markRetryScheduled!: (delayMs: number) => void;
  const retryScheduled = new Promise<number>((resolve) => {
    markRetryScheduled = resolve;
  });
  const queue = new AutomaticReflectionQueue(
    1,
    1,
    20,
    100,
    () => 0,
    (callback, delayMs) => {
      runRetry = callback;
      markRetryScheduled(delayMs);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
  );
  let attempts = 0;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });

  queue.enqueue({
    sourceKey: 'project\0transcript',
    process: async () => {
      attempts++;
      if (attempts === 1) {
        return {
          completed: false,
          error: 'LLM request failed (429): server overloaded',
        };
      }
      resolveCompleted();
      return { completed: true };
    },
  });

  expect(await retryScheduled).toBe(20);
  expect(attempts).toBe(1);
  runRetry();
  await completed;
  expect(attempts).toBe(2);
});

test('drops a job whose jobKey is already queued or running in any source', async () => {
  const queue = new AutomaticReflectionQueue(1);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];

  expect(
    queue.enqueue({
      sourceKey: 'project\0./chat.jsonl',
      jobKey: 'run-1',
      process: async () => {
        calls.push('first');
        await firstGate;
        return { completed: true };
      },
    }),
  ).toBe(true);
  // Running, under a different spelling of the source key.
  expect(
    queue.enqueue({
      sourceKey: 'project\0chat.jsonl',
      jobKey: 'run-1',
      process: async () => {
        calls.push('duplicate-running');
        return { completed: true };
      },
    }),
  ).toBe(false);
  // Queued behind the running job.
  expect(
    queue.enqueue({
      sourceKey: 'project\0./chat.jsonl',
      jobKey: 'run-2',
      process: async () => {
        calls.push('second');
        return { completed: true };
      },
    }),
  ).toBe(true);
  expect(
    queue.enqueue({
      sourceKey: 'other\0chat.jsonl',
      jobKey: 'run-2',
      process: async () => {
        calls.push('duplicate-queued');
        return { completed: true };
      },
    }),
  ).toBe(false);
  // Jobs without a key are never deduped.
  expect(
    queue.enqueue({
      sourceKey: 'keyless',
      process: async () => {
        calls.push('keyless-a');
        return { completed: true };
      },
    }),
  ).toBe(true);
  expect(
    queue.enqueue({
      sourceKey: 'keyless',
      process: async () => {
        calls.push('keyless-b');
        return { completed: true };
      },
    }),
  ).toBe(true);

  releaseFirst();
  await queue.whenIdle();
  expect(calls.sort()).toEqual(['first', 'keyless-a', 'keyless-b', 'second']);
});
