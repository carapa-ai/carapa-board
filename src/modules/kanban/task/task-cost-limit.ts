/**
 * Per-task cost limit. Once a card's accumulated run cost reaches its limit the
 * board stops starting automatic runs for it and parks it in the backlog queue
 * for a human. A run already in progress is never interrupted: run cost is only
 * recorded at completion, so the limit is evaluated before each run starts.
 */

import { logger } from '../../../logger.js';
import { getTask, getTaskRunStats, updateTask } from '../../../db.js';
import type { RegisteredGroup } from '../../../types.js';
import { notifyEntityLifecycle } from '../../tools/push-tools.js';
import { broadcast } from '../../objectives/ws-events.js';
import { appendTaskMessageDurableAsync } from '../../transcripts/transcript-store.js';
import { getGroupStages } from '../stages.js';
import type { StageDefinition, Task } from '../types.js';

/** Per-task override of the project limit (numeric custom value). */
const TASK_COST_LIMIT_KEY = 'cost_limit_usd';
/** Set while the card is parked by its limit so side effects fire once. */
const TASK_COST_LIMIT_HIT_KEY = 'cost_limit_hit_at';

function positiveLimit(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined;
}

/** The task's `cost_limit_usd` value wins over the project setting. */
function effectiveTaskCostLimitUsd(
  task: Pick<Task, 'custom_values'>,
  group: Pick<RegisteredGroup, 'settings'>,
): number | undefined {
  return (
    positiveLimit(task.custom_values?.[TASK_COST_LIMIT_KEY]) ??
    positiveLimit(group.settings?.kanbanTaskCostLimitUsd)
  );
}

/** The `backlog` stage, else the first active queue stage. */
function getBacklogStage(
  stages: StageDefinition[],
): StageDefinition | undefined {
  const queues = stages.filter((s) => s.type === 'queue' && !s.inactive);
  return (
    queues.find(
      (s) =>
        s.id.toLowerCase() === 'backlog' ||
        s.title.trim().toLowerCase() === 'backlog',
    ) ?? queues[0]
  );
}

function withoutHitMarker(
  values: NonNullable<Task['custom_values']>,
): NonNullable<Task['custom_values']> {
  const { [TASK_COST_LIMIT_HIT_KEY]: _hit, ...rest } = values;
  return rest;
}

/**
 * Decide whether a run for this task may start. Returns true when the task is
 * over its limit and has been parked (the caller must not start the run).
 * User-triggered runs are never blocked; they only reset the once-per-crossing
 * marker so a later automatic block is reported again.
 */
export async function enforceTaskCostLimit(
  task: Task,
  group: RegisteredGroup,
  options: { automatic: boolean },
): Promise<boolean> {
  const mayApply =
    group.settings?.kanbanTaskCostLimitUsd != null ||
    task.custom_values?.[TASK_COST_LIMIT_KEY] != null ||
    task.custom_values?.[TASK_COST_LIMIT_HIT_KEY] != null;
  if (!mayApply) return false;

  const fresh = (await getTask(task.id)) ?? task;
  const values = fresh.custom_values ?? {};
  const limit = effectiveTaskCostLimitUsd(fresh, group);
  const marked = values[TASK_COST_LIMIT_HIT_KEY] != null;
  const totalCostUsd =
    limit == null ? 0 : (await getTaskRunStats(task.id)).cost_usd;
  const overLimit = limit != null && totalCostUsd >= limit;

  if (!overLimit || !options.automatic) {
    if (marked) {
      await updateTask(task.id, { custom_values: withoutHitMarker(values) });
    }
    return false;
  }

  const stages = getGroupStages(group);
  const backlog = getBacklogStage(stages);
  const at = new Date().toISOString();
  await updateTask(
    task.id,
    {
      ...(backlog ? { status: backlog.id } : {}),
      custom_values: {
        ...values,
        [TASK_COST_LIMIT_HIT_KEY]: values[TASK_COST_LIMIT_HIT_KEY] ?? at,
      },
    },
    { suppressStageEntryEvent: true },
  );

  if (!marked) {
    const message = await appendTaskMessageDurableAsync(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'system_notice',
      content: `Cost limit reached: $${totalCostUsd.toFixed(2)} of $${limit.toFixed(2)} — automatic runs stopped`,
      created_at: at,
    });
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message,
      },
    });
    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      // Fixed source: the lifecycle read guard exempts this Backlog alert.
      run_id: 'cost-limit',
      event: 'needs_input',
      title: `Task needs input: ${task.title}`,
    });
    logger.info(
      { task_id: task.id, totalCostUsd, limit },
      'Task parked after reaching its cost limit',
    );
  }
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
  return true;
}
