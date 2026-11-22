import { z } from 'zod';
import { ToolDefinition } from '../../tools/types.js';
import {
  createScheduledTask,
  getAllScheduledTasks,
  getTasksForGroup,
  getTaskById,
  hasRunningScheduledTask,
  updateScheduledTaskIfIdle,
} from '../../../db.js';
import { deleteScheduledTaskWithTranscripts } from './delete-task.js';
import { hasPermission } from '../../../mcp/auth.js';
import { getGroupEntryByFolder } from '../../../state-manager.js';
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from '../../../config.js';
import { normalizeTaskId } from '../../tools/utils.js';
import { parseIntervalMs } from './interval.js';
import { calcNextRun } from './next-run.js';
import type { ScheduledTask } from './types.js';
import { validateRuntimeSelection } from '../../../lib/chat-agents.js';

export { parseIntervalMs } from './interval.js';

async function getWritableScheduledTask(
  rawTaskId: string,
  permissions: Record<string, string[]> | undefined,
): Promise<{ task_id: string; task: ScheduledTask }> {
  const task_id = normalizeTaskId(rawTaskId);
  const task = await getTaskById(task_id);
  if (!task) throw new Error('Task not found');
  if (!hasPermission(permissions, task.group_folder, 'scheduling:write')) {
    throw new Error(
      `Unauthorized: missing scheduling:write permission for project "${task.group_folder}"`,
    );
  }
  return { task_id, task };
}

function normalizeOneTimeSchedule(value: string): string {
  const isoTimestamp =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    !isoTimestamp.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) <= Date.now()
  ) {
    throw new Error('One-time schedule must be a future ISO timestamp');
  }
  return new Date(value).toISOString();
}

function assertNotCompletedForStatusChange(task: ScheduledTask): void {
  if (task.status === 'completed') {
    throw new Error(
      'Completed scheduled tasks cannot be paused or resumed; change the schedule to reactivate',
    );
  }
}

export const scheduleTaskTool: ToolDefinition = {
  name: 'schedule_task',
  description: `Schedule a recurring or one-time chat-context task. This operates on ScheduledTasks — chat-tied prompts that run as a full agent on a schedule.`,
  inputSchema: {
    prompt: z
      .string()
      .describe('Instructions for the agent to execute on schedule'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'Schedule cadence (cron expression, interval in ms, or ISO timestamp)',
      ),
    schedule_value: z
      .string()
      .describe(
        'Value for the schedule (e.g. "0 9 * * 1", "3600000", or "2099-01-01T10:00:00Z")',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe('Whether to share main chat context or start fresh'),
    targetGroup: z
      .string()
      .optional()
      .describe('Target project folder (defaults to current)'),
    runtimeSelection: z
      .object({
        harnessId: z.string().min(1),
        modelId: z.string().min(1),
        reasoning: z.string().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .optional()
      .describe(
        'Optional runtime override. When omitted, the project or global chat runtime is used.',
      ),
  },
  requiredPermissions: ['scheduling:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const { group_folder, permissions } = context;
    const {
      prompt,
      schedule_type,
      schedule_value: rawScheduleValue,
      context_mode,
      targetGroup: rawTargetGroup,
      runtimeSelection,
    } = args;
    const targetGroup = rawTargetGroup ? rawTargetGroup : group_folder;

    if (!hasPermission(permissions, targetGroup, 'scheduling:write')) {
      throw new Error(
        `Unauthorized: missing scheduling:write permission for project "${targetGroup}"`,
      );
    }
    const targetJid = getGroupEntryByFolder(targetGroup)?.jid;
    if (!targetJid)
      throw new Error(`Target group "${targetGroup}" not registered`);

    const runtimeError = validateRuntimeSelection(runtimeSelection);
    if (runtimeError) throw new Error(runtimeError);

    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('prompt must be non-empty');
    }
    let schedule_value = rawScheduleValue;
    let next_run: string | null = null;
    if (schedule_type === 'cron') {
      // cron-parser treats an empty string as "* * * * *" (every minute).
      if (!schedule_value.trim()) throw new Error('Invalid cron expression');
      const interval = CronExpressionParser.parse(schedule_value, {
        tz: TIMEZONE,
      });
      next_run = interval.next().toISOString();
    } else if (schedule_type === 'interval') {
      const ms = parseIntervalMs(schedule_value);
      next_run = new Date(Date.now() + ms).toISOString();
    } else if (schedule_type === 'once') {
      schedule_value = normalizeOneTimeSchedule(schedule_value);
      next_run = schedule_value;
    }

    const task_id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await createScheduledTask({
      id: task_id,
      group_folder: targetGroup,
      chat_jid: targetJid,
      prompt,
      schedule_type,
      schedule_value,
      context_mode,
      runtimeSelection,
      next_run,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    return `Task scheduled (${task_id}): ${schedule_type} - ${schedule_value}`;
  },
};

export const listScheduledTasksTool: ToolDefinition = {
  name: 'list_scheduled_tasks',
  description: 'List all chat-context scheduled tasks.',
  inputSchema: {},
  requiredPermissions: ['scheduling:read'],
  handler: async (_, deps, context) => {
    const { permissions } = context;
    const allowedGroups = Object.keys(permissions || {}).filter((f) =>
      hasPermission(permissions, f, 'scheduling:read'),
    );

    const tasks = allowedGroups.includes('*')
      ? await getAllScheduledTasks()
      : (await Promise.all(allowedGroups.map(getTasksForGroup))).flat();

    if (tasks.length === 0) return 'No scheduled tasks found.';
    return tasks
      .map(
        (t) =>
          `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
      )
      .join('\n');
  },
};

export const updateScheduledTaskTool: ToolDefinition = {
  name: 'update_scheduled_task',
  description:
    'Update an existing chat-context scheduled task without replacing its identity or history.',
  inputSchema: {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('Updated agent instructions'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('Updated schedule cadence type'),
    schedule_value: z.string().optional().describe('Updated schedule value'),
    status: z
      .enum(['active', 'paused'])
      .optional()
      .describe('Updated task status'),
    context_mode: z
      .enum(['group', 'isolated'])
      .optional()
      .describe('Whether to share main chat context or start fresh'),
    runtimeSelection: z
      .object({
        harnessId: z.string().min(1),
        modelId: z.string().min(1),
        reasoning: z.string().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .optional()
      .describe('Updated runtime override'),
  },
  requiredPermissions: ['scheduling:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const { task_id, task } = await getWritableScheduledTask(
      args.task_id,
      context.permissions,
    );

    const updates: Parameters<typeof updateScheduledTaskIfIdle>[1] = {};
    const changedFields: string[] = [];

    if (args.prompt !== undefined) {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        throw new Error('prompt must be non-empty');
      }
      updates.prompt = args.prompt;
      changedFields.push('prompt');
    }

    const hasScheduleType = args.schedule_type !== undefined;
    const hasScheduleValue = args.schedule_value !== undefined;
    if (
      hasScheduleType &&
      !['cron', 'interval', 'once'].includes(args.schedule_type)
    ) {
      throw new Error('Invalid schedule type');
    }
    if (hasScheduleValue && typeof args.schedule_value !== 'string') {
      throw new Error('Invalid schedule value');
    }
    const scheduleType = hasScheduleType
      ? args.schedule_type
      : task.schedule_type;
    const scheduleValue = hasScheduleValue
      ? args.schedule_value
      : task.schedule_value;
    const cadenceChanged =
      (hasScheduleType && scheduleType !== task.schedule_type) ||
      (hasScheduleValue && scheduleValue !== task.schedule_value);

    if (cadenceChanged) {
      if (scheduleType === 'cron') {
        try {
          // cron-parser treats an empty string as "* * * * *" (every minute).
          if (!scheduleValue.trim()) throw new Error('Blank cron expression');
          CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
        } catch {
          throw new Error('Invalid cron expression');
        }
      } else if (scheduleType === 'interval') {
        parseIntervalMs(scheduleValue);
      }

      const normalizedScheduleValue =
        scheduleType === 'once'
          ? normalizeOneTimeSchedule(scheduleValue)
          : scheduleValue;
      updates.schedule_type = scheduleType;
      updates.schedule_value = normalizedScheduleValue;
      updates.next_run =
        scheduleType === 'once'
          ? normalizedScheduleValue
          : calcNextRun({
              ...task,
              schedule_type: scheduleType,
              schedule_value: normalizedScheduleValue,
            });
      changedFields.push('schedule');
    }

    if (args.context_mode !== undefined) {
      if (args.context_mode !== 'group' && args.context_mode !== 'isolated') {
        throw new Error('context_mode must be "group" or "isolated"');
      }
      updates.context_mode = args.context_mode;
      changedFields.push('context mode');
    }

    if (args.status !== undefined) {
      if (args.status !== 'active' && args.status !== 'paused') {
        throw new Error('status must be "active" or "paused"');
      }
      if (
        args.status === 'active' &&
        task.status === 'completed' &&
        !cadenceChanged
      ) {
        throw new Error('Completed scheduled tasks cannot be reactivated');
      }
      if (
        args.status === 'paused' &&
        task.status === 'completed' &&
        !cadenceChanged
      ) {
        throw new Error('Completed scheduled tasks cannot be paused');
      }
      updates.status = args.status;
      changedFields.push('status');
    }
    if (cadenceChanged && task.status === 'completed') {
      updates.status = 'active';
    }

    if (args.runtimeSelection !== undefined) {
      const runtimeError = validateRuntimeSelection(args.runtimeSelection);
      if (runtimeError) throw new Error(runtimeError);
      updates.runtimeSelection = args.runtimeSelection;
      changedFields.push('runtime');
    }

    if (
      updates.status === 'active' &&
      task.status === 'paused' &&
      scheduleType !== 'once' &&
      !cadenceChanged
    ) {
      const nextRun = calcNextRun(task);
      if (nextRun === null) throw new Error('Invalid recurring schedule');
      updates.next_run = nextRun;
    }

    if (
      Object.keys(updates).length === 0 &&
      (await hasRunningScheduledTask(task_id))
    ) {
      throw new Error('Scheduled task is currently running');
    }
    if (!(await updateScheduledTaskIfIdle(task_id, updates))) {
      throw new Error('Scheduled task is currently running');
    }
    const summary = changedFields.length ? `: ${changedFields.join(', ')}` : '';
    return `Task ${task_id} updated${summary}.`;
  },
};

export const pauseTaskTool: ToolDefinition = {
  name: 'pause_task',
  description: 'Pause a chat-context scheduled task.',
  inputSchema: {
    task_id: z.string().describe('The task ID to pause'),
  },
  requiredPermissions: ['scheduling:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id: raw_id }, deps, context) => {
    const { task_id, task } = await getWritableScheduledTask(
      raw_id,
      context.permissions,
    );
    assertNotCompletedForStatusChange(task);
    if (!(await updateScheduledTaskIfIdle(task_id, { status: 'paused' }))) {
      throw new Error('Scheduled task is currently running');
    }
    return `Task ${task_id} paused.`;
  },
};

export const resumeTaskTool: ToolDefinition = {
  name: 'resume_task',
  description: 'Resume a paused chat-context scheduled task.',
  inputSchema: {
    task_id: z.string().describe('The task ID to resume'),
  },
  requiredPermissions: ['scheduling:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id: raw_id }, deps, context) => {
    const { task_id, task } = await getWritableScheduledTask(
      raw_id,
      context.permissions,
    );
    assertNotCompletedForStatusChange(task);
    const updates: Parameters<typeof updateScheduledTaskIfIdle>[1] = {
      status: 'active',
    };
    if (task.status === 'paused' && task.schedule_type !== 'once') {
      const nextRun = calcNextRun(task);
      if (nextRun === null) {
        throw new Error('Invalid recurring schedule');
      }
      updates.next_run = nextRun;
    }
    if (!(await updateScheduledTaskIfIdle(task_id, updates))) {
      throw new Error('Scheduled task is currently running');
    }
    return `Task ${task_id} resumed.`;
  },
};

export const cancelTaskTool: ToolDefinition = {
  name: 'cancel_task',
  description: 'Cancel and permanently delete a chat-context scheduled task.',
  inputSchema: {
    task_id: z.string().describe('The task ID to cancel'),
  },
  requiredPermissions: ['scheduling:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id: raw_id }, deps, context) => {
    const { task_id, task } = await getWritableScheduledTask(
      raw_id,
      context.permissions,
    );
    if (
      !(await deleteScheduledTaskWithTranscripts(task_id, task.group_folder))
    ) {
      throw new Error('Scheduled task is currently running');
    }
    return `Task ${task_id} cancelled.`;
  },
};
