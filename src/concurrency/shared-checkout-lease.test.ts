import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { projects } from '../db/schema.js';
import {
  createTask,
  createConversation,
  completeActiveRun,
  initDatabase,
  insertActiveRun,
} from '../db.js';
import { runFixture, taskFixture } from '../test-helpers.js';
import { acquireSharedCheckoutLease } from './shared-checkout-lease.js';

const projectId = `lease-test-${process.pid}`;
function observeRetry(retryMs: number) {
  const blocked = Promise.withResolvers<void>();
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const handle = schedule(...args);
    if (args[1] === retryMs) blocked.resolve();
    return handle;
  }) as typeof setTimeout);
  return { blocked: blocked.promise, restore: () => timer.mockRestore() };
}

describe('shared checkout lease', () => {
  test('queues a second owner until the first releases', async () => {
    const first = await acquireSharedCheckoutLease(projectId, {
      type: 'task',
      id: 'first',
    });
    const retry = observeRetry(5);
    let secondStarted = false;
    const second = acquireSharedCheckoutLease(
      projectId,
      { type: 'task', id: 'second' },
      { retryMs: 5 },
    ).then((lease) => {
      secondStarted = true;
      return lease;
    });
    try {
      await Promise.race([
        retry.blocked,
        second.then(() => {
          throw new Error('second owner bypassed the held lease');
        }),
      ]);
      expect(secondStarted).toBe(false);
      await first.release();
      const acquired = await second;
      expect(acquired.owner).toEqual({ type: 'task', id: 'second' });
    } finally {
      retry.restore();
      await first.release();
      await (await second).release();
    }
  });

  test('heartbeat retains ownership', async () => {
    const lease = await acquireSharedCheckoutLease(projectId, {
      type: 'task',
      id: 'heartbeat',
    });
    expect(await lease.heartbeat()).toBe(true);
    await lease.release();
    expect(await lease.heartbeat()).toBe(false);
  });

  test('reclaims an expired lease after restart when its owner is gone', async () => {
    await initDatabase(':memory:');
    const project = `lease-restart-${process.pid}`;
    const file = path.join(
      DATA_DIR,
      'shared-checkout-leases',
      `${project}.json`,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        projectId: project,
        owner: { type: 'task', id: 'gone-task' },
        leaseToken: 'stale-token',
        expiresAt: Date.now() - 1,
      }),
    );
    const lease = await acquireSharedCheckoutLease(project, {
      type: 'task',
      id: 'recovered-owner',
    });
    expect(lease.owner.id).toBe('recovered-owner');
    await lease.release();
  });

  test('protects an expired lease while its active task run remains alive', async () => {
    const project = `lease-active-${process.pid}`;
    const file = path.join(
      DATA_DIR,
      'shared-checkout-leases',
      `${project}.json`,
    );
    await drizzleDbRef.current
      .insert(projects)
      .values({
        id: project,
        jid: `${project}@web`,
        name: project,
        folder: project,
        trigger: '@test',
        added_at: new Date().toISOString(),
      })
      .execute();
    const task = await createTask(
      taskFixture({ project_id: project, title: 'Active lease task' }),
    );
    const taskId = task.id;
    const runId = `run-${taskId}`;
    await insertActiveRun(
      runFixture({ id: runId, group_folder: project, task_id: taskId }),
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        projectId: project,
        owner: { type: 'task', id: taskId },
        leaseToken: 'active-stale-token',
        expiresAt: Date.now() - 1,
      }),
    );
    const controller = new AbortController();
    const retry = observeRetry(1);
    const pending = acquireSharedCheckoutLease(
      project,
      { type: 'task', id: 'blocked' },
      { retryMs: 1, signal: controller.signal },
    );
    try {
      await Promise.race([
        retry.blocked,
        pending.then(() => {
          throw new Error('active owner lease was stolen');
        }),
      ]);
      controller.abort();
      await expect(pending).rejects.toThrow('lease aborted');
    } finally {
      retry.restore();
      controller.abort();
    }
    await completeActiveRun(runId, 'completed');
    const lease = await acquireSharedCheckoutLease(project, {
      type: 'task',
      id: 'after-completion',
    });
    await lease.release();
  });

  test('reclaims an expired lease from an active worktree conversation after restart', async () => {
    const project = `lease-worktree-restart-${process.pid}`;
    const file = path.join(
      DATA_DIR,
      'shared-checkout-leases',
      `${project}.json`,
    );
    await drizzleDbRef.current
      .insert(projects)
      .values({
        id: project,
        jid: `${project}@web`,
        name: project,
        folder: project,
        trigger: '@test',
        added_at: new Date().toISOString(),
      })
      .execute();
    const conversation = await createConversation(project, {
      use_worktree: true,
      branch_name: 'task/recovered-worktree',
    });
    const runId = `run-${conversation.id}`;
    await insertActiveRun(
      runFixture({
        id: runId,
        group_folder: project,
        conversation_id: conversation.id,
        chat_jid: `${project}@web`,
      }),
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        projectId: project,
        owner: { type: 'conversation', id: conversation.id },
        leaseToken: 'stale-worktree-token',
        expiresAt: Date.now() - 1,
      }),
    );

    const lease = await acquireSharedCheckoutLease(project, {
      type: 'task',
      id: 'unrelated-conversation',
    });

    expect(lease.owner.id).toBe('unrelated-conversation');
    await lease.release();
    await completeActiveRun(runId, 'completed');
  });
});
