import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  claimScheduledTaskOccurrence,
  createScheduledTask,
  getTaskById,
  initDatabase,
  releaseOrphanedScheduledTaskOccurrenceClaims,
} from '../../../db.js';
import type { McpServerDeps } from '../../../mcp/auth.js';
import { getDefaultRuntimeSelection } from '../../../lib/chat-agents.js';
import { truncateTestDb } from '../../../test-helpers.js';
import type { ScheduledTask } from './types.js';
import {
  cancelTaskTool,
  parseIntervalMs,
  pauseTaskTool,
  resumeTaskTool,
  updateScheduledTaskTool,
} from './tools.js';

let initialized = false;

beforeAll(async () => {
  await initDatabase(':memory:');
  initialized = true;
});

beforeEach(async () => {
  if (!initialized) throw new Error('test database was not initialized');
  await truncateTestDb();
});

let taskSequence = 0;
// The scheduling handlers under test do not consult service dependencies.
const toolDeps = {} as unknown as McpServerDeps;

async function createToolTask(
  overrides: Partial<ScheduledTask> = {},
): Promise<ScheduledTask> {
  taskSequence += 1;
  const task: ScheduledTask = {
    id: `update-tool-${taskSequence}`,
    group_folder: 'update-tool-group',
    chat_jid: 'update-tool-group@web',
    prompt: 'Original prompt',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    runtimeSelection: null,
    next_run: new Date(Date.now() + 60_000).toISOString(),
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
  await createScheduledTask(task);
  return task;
}

function updateContext(groupFolder = 'update-tool-group') {
  return {
    group_folder: groupFolder,
    permissions: { [groupFolder]: ['scheduling:write'] },
  };
}

describe('parseIntervalMs', () => {
  test('accepts positive integer millisecond intervals', () => {
    expect(parseIntervalMs('60000')).toBe(60_000);
    expect(parseIntervalMs(' 60000 ')).toBe(60_000);
  });

  test('rejects values that parseInt would silently truncate', () => {
    expect(() => parseIntervalMs('60000oops')).toThrow(/positive integer/i);
    expect(() => parseIntervalMs('1.5')).toThrow(/positive integer/i);
  });

  test('rejects non-positive and unsafe intervals', () => {
    expect(() => parseIntervalMs('0')).toThrow(/positive integer/i);
    expect(() => parseIntervalMs('-1000')).toThrow(/positive integer/i);
    expect(() => parseIntervalMs('9007199254740992')).toThrow(/too large/i);
  });
});

describe('update_scheduled_task', () => {
  test('partially updates provided fields and preserves the task identity and cadence', async () => {
    const task = await createToolTask();
    const runtimeSelection = getDefaultRuntimeSelection('chat');

    const result = await updateScheduledTaskTool.handler(
      {
        task_id: task.id,
        prompt: 'Updated prompt',
        context_mode: 'group',
        runtimeSelection,
      },
      toolDeps,
      updateContext(),
    );

    expect(result).toBe(
      `Task ${task.id} updated: prompt, context mode, runtime.`,
    );
    expect(await getTaskById(task.id)).toMatchObject({
      id: task.id,
      prompt: 'Updated prompt',
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: 'group',
      runtimeSelection,
      next_run: task.next_run,
      status: task.status,
      created_at: task.created_at,
    });
  });

  test('rejects a missing task', async () => {
    await expect(
      updateScheduledTaskTool.handler(
        { task_id: 'missing-task', prompt: 'Updated prompt' },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow('Task not found');
  });

  test('checks write permission against the stored task group', async () => {
    const task = await createToolTask();

    await expect(
      updateScheduledTaskTool.handler(
        { task_id: task.id, prompt: 'Updated prompt' },
        toolDeps,
        updateContext('another-group'),
      ),
    ).rejects.toThrow(/missing scheduling:write permission/);
    expect((await getTaskById(task.id))?.prompt).toBe(task.prompt);
  });

  test('rejects an empty prompt without mutating the task', async () => {
    const task = await createToolTask();

    await expect(
      updateScheduledTaskTool.handler(
        { task_id: task.id, prompt: '   ' },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow('prompt must be non-empty');
    expect((await getTaskById(task.id))?.prompt).toBe(task.prompt);
  });

  test('validates a cron expression against the merged cadence', async () => {
    const task = await createToolTask({
      schedule_type: 'interval',
      schedule_value: 'not a cron expression',
    });

    await expect(
      updateScheduledTaskTool.handler(
        { task_id: task.id, schedule_type: 'cron' },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow('Invalid cron expression');
    expect(await getTaskById(task.id)).toMatchObject({
      schedule_type: 'interval',
      schedule_value: 'not a cron expression',
    });
  });

  test('rejects an invalid interval value', async () => {
    const task = await createToolTask();

    await expect(
      updateScheduledTaskTool.handler(
        { task_id: task.id, schedule_value: '1.5' },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow(/positive integer/i);
    expect((await getTaskById(task.id))?.schedule_value).toBe(
      task.schedule_value,
    );
  });

  test('rejects a past one-time timestamp', async () => {
    const task = await createToolTask();
    const past = new Date(Date.now() - 60_000).toISOString();

    await expect(
      updateScheduledTaskTool.handler(
        {
          task_id: task.id,
          schedule_type: 'once',
          schedule_value: past,
        },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow('One-time schedule must be a future ISO timestamp');
    expect((await getTaskById(task.id))?.schedule_type).toBe(
      task.schedule_type,
    );
  });

  test('validates runtime selection before persisting it', async () => {
    const task = await createToolTask();

    await expect(
      updateScheduledTaskTool.handler(
        {
          task_id: task.id,
          runtimeSelection: { harnessId: 'missing', modelId: 'missing' },
        },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow();
    expect((await getTaskById(task.id))?.runtimeSelection).toBeNull();
  });

  test('recomputes next_run when cadence changes', async () => {
    const task = await createToolTask();
    const beforeUpdate = Date.now();

    await updateScheduledTaskTool.handler(
      { task_id: task.id, schedule_value: '120000' },
      toolDeps,
      updateContext(),
    );

    const updated = await getTaskById(task.id);
    expect(updated?.schedule_value).toBe('120000');
    expect(Date.parse(updated!.next_run!)).toBeGreaterThanOrEqual(
      beforeUpdate + 120_000,
    );
  });

  test('sets next_run when resuming a paused recurring task while editing cadence', async () => {
    const task = await createToolTask({ status: 'paused' });

    await updateScheduledTaskTool.handler(
      {
        task_id: task.id,
        status: 'active',
        schedule_value: '120000',
      },
      toolDeps,
      updateContext(),
    );

    expect(await getTaskById(task.id)).toMatchObject({
      status: 'active',
      schedule_value: '120000',
    });
    expect((await getTaskById(task.id))?.next_run).not.toBeNull();
  });

  test('rejects a claimed occurrence without mutating it', async () => {
    const nextRun = new Date(Date.now() - 1_000).toISOString();
    const task = await createToolTask({
      schedule_type: 'once',
      schedule_value: nextRun,
      next_run: nextRun,
    });
    expect(await claimScheduledTaskOccurrence(task)).toBe(true);

    await expect(
      updateScheduledTaskTool.handler(
        { task_id: task.id, prompt: 'Must not be persisted' },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow('Scheduled task is currently running');
    expect(await getTaskById(task.id)).toMatchObject({
      prompt: task.prompt,
      next_run: null,
      last_run: null,
      last_result: null,
    });
  });

  test('rejects a task-id-only update while an occurrence is claimed', async () => {
    const nextRun = new Date(Date.now() - 1_000).toISOString();
    const task = await createToolTask({
      schedule_type: 'once',
      schedule_value: nextRun,
      next_run: nextRun,
    });
    expect(await claimScheduledTaskOccurrence(task)).toBe(true);

    await expect(
      updateScheduledTaskTool.handler(
        { task_id: task.id },
        toolDeps,
        updateContext(),
      ),
    ).rejects.toThrow('Scheduled task is currently running');
    expect(await getTaskById(task.id)).toMatchObject({
      prompt: task.prompt,
      next_run: null,
      last_run: null,
      last_result: null,
    });
  });
});

describe('scheduled-task status tools', () => {
  test.each([
    ['pause_task', pauseTaskTool],
    ['resume_task', resumeTaskTool],
  ] as const)(
    '%s rejects a claimed occurrence without mutating it',
    async (_name, tool) => {
      const nextRun = new Date(Date.now() - 1_000).toISOString();
      const task = {
        id: `tool-status-lock-${tool.name}`,
        group_folder: 'tool-status-lock',
        chat_jid: 'tool-status-lock@web',
        prompt: 'Keep this occurrence immutable',
        schedule_type: 'once' as const,
        schedule_value: nextRun,
        context_mode: 'isolated' as const,
        next_run: nextRun,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
      await createScheduledTask(task);
      expect(await claimScheduledTaskOccurrence(task)).toBe(true);

      await expect(
        tool.handler({ task_id: task.id }, toolDeps, {
          group_folder: task.group_folder,
          permissions: { [task.group_folder]: ['scheduling:write'] },
        }),
      ).rejects.toThrow('Scheduled task is currently running');
      expect(await getTaskById(task.id)).toMatchObject({
        status: 'active',
        next_run: null,
        last_run: null,
        last_result: null,
      });
    },
  );

  describe('completed one-off tasks', () => {
    const completedOnce = () =>
      createToolTask({
        schedule_type: 'once',
        schedule_value: new Date(Date.now() - 60_000).toISOString(),
        next_run: null,
        status: 'completed',
      });

    test.each([
      ['pause_task', pauseTaskTool],
      ['resume_task', resumeTaskTool],
    ] as const)(
      '%s is rejected and leaves the row unchanged',
      async (_n, tool) => {
        const task = await completedOnce();
        await expect(
          tool.handler({ task_id: task.id }, toolDeps, updateContext()),
        ).rejects.toThrow(
          'Completed scheduled tasks cannot be paused or resumed',
        );
        expect(await getTaskById(task.id)).toMatchObject({
          status: 'completed',
          next_run: null,
        });
        expect(await releaseOrphanedScheduledTaskOccurrenceClaims()).toEqual(
          [],
        );
      },
    );

    test('update_scheduled_task rejects status paused without a cadence change', async () => {
      const task = await completedOnce();
      await expect(
        updateScheduledTaskTool.handler(
          { task_id: task.id, status: 'paused' },
          toolDeps,
          updateContext(),
        ),
      ).rejects.toThrow('Completed scheduled tasks cannot be paused');
      expect(await getTaskById(task.id)).toMatchObject({
        status: 'completed',
        next_run: null,
      });
    });

    test('a cadence change still reactivates and cancel_task still deletes', async () => {
      const task = await completedOnce();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await updateScheduledTaskTool.handler(
        { task_id: task.id, schedule_value: future },
        toolDeps,
        updateContext(),
      );
      expect(await getTaskById(task.id)).toMatchObject({
        status: 'active',
        next_run: future,
      });

      const other = await completedOnce();
      await cancelTaskTool.handler(
        { task_id: other.id },
        toolDeps,
        updateContext(),
      );
      expect(await getTaskById(other.id)).toBeUndefined();
    });
  });
});
