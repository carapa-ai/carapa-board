import path from 'path';
import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import { computeEffectiveWorkspaceRoot } from '../../../sandbox/effective-settings.js';
import { logger } from '../../../logger.js';
import { getTask, getTaskRunStats } from '../db-kanban.js';
import {
  publishEventWithResult,
  resolveBrainContainer,
  resolveBrainUrl,
} from '../../objectives/brain-client.js';
import type { PublishEventResult } from '../../objectives/brain-client.js';

export type TaskQuestionSource =
  | 'agent_update'
  | 'manual_update'
  | 'bulk_update'
  | 'testing_blocked'
  | 'review_no_progress'
  | 'merge_conflict';

export type TaskFailedSource = 'agent_update' | 'manual_update' | 'bulk_update';

/**
 * Compact provenance shared by every task-triggered Brain event.
 * Use the sandbox/container path because that is the path mounted into Brain;
 * persisted Task.worktree_path is host-side and must not be exposed as the CWD.
 */
export function taskEventHeaders(
  task: Task,
  group: RegisteredGroup,
): { title: string; working_directory: string } {
  const workspaceRoot = computeEffectiveWorkspaceRoot(group);
  return {
    title: task.title,
    working_directory:
      task.branch_name && task.worktree_path
        ? path.posix.join(workspaceRoot, '.worktrees', task.branch_name)
        : workspaceRoot,
  };
}

/**
 * Outcome data for a task_completed / task_failed Brain event, read from the
 * DB at publish time so the Brain can measure results without querying the
 * board. Returns {} when the lookup fails; callers still publish the event.
 */
export async function taskOutcomeEventData(
  taskId: string,
  type: 'task_completed' | 'task_failed',
): Promise<Record<string, unknown>> {
  try {
    const task = await getTask(taskId);
    if (!task) return {};
    const stats = await getTaskRunStats(taskId);
    const values = task.custom_values ?? {};
    const rejectionCount = Number(values.rejection_count);
    const testingFailureTotal = values.testing_failure_total;
    return {
      ...(typeof values.quality_score === 'number'
        ? { review_score: values.quality_score }
        : {}),
      rejection_count: Number.isFinite(rejectionCount) ? rejectionCount : 0,
      ...(typeof values.nit_round_count === 'number' &&
      Number.isFinite(values.nit_round_count) &&
      values.nit_round_count >= 0
        ? { nit_round_count: values.nit_round_count }
        : {}),
      testing_failure_total:
        typeof testingFailureTotal === 'number' &&
        Number.isFinite(testingFailureTotal)
          ? testingFailureTotal
          : 0,
      merged: !!task.merge_commit,
      ...(task.merge_commit ? { merge_commit: task.merge_commit } : {}),
      cost_usd: stats.cost_usd,
      run_count: stats.run_count,
      ...(type === 'task_failed'
        ? { failure_reason: task.error, failure_stage: task.status }
        : {}),
    };
  } catch (err) {
    logger.warn({ err, taskId, type }, 'Failed to load task outcome data');
    return {};
  }
}

function publishTaskStageEvent(
  task: Task,
  group: RegisteredGroup,
  type: 'task_question' | 'task_failed',
  data: Record<string, string>,
  timestamp: string,
): Promise<PublishEventResult> | undefined {
  if (!task.objective_id) return undefined;

  return publishEventWithResult(
    resolveBrainUrl(resolveBrainContainer(group)),
    {
      type,
      project_id: task.project_id,
      task_id: task.id,
      objective_id: task.objective_id,
      timestamp,
      data: {
        ...taskEventHeaders(task, group),
        status: task.status,
        ...data,
      },
    },
    group,
  );
}

/**
 * Notify CarapaBrain that an objective-owned task entered Question.
 *
 * Callers are responsible for transition detection. Untagged tasks deliberately
 * produce no objective event because there is no owning objective to route to.
 */
export function publishTaskQuestion(
  task: Task,
  group: RegisteredGroup,
  source: TaskQuestionSource,
  reason?: string,
  timestamp = new Date().toISOString(),
): Promise<PublishEventResult> | undefined {
  return publishTaskStageEvent(
    task,
    group,
    'task_question',
    { source, ...(reason ? { reason } : {}) },
    timestamp,
  );
}

/**
 * Notify CarapaBrain that an objective-owned task entered Failed.
 *
 * Execution and deploy failures publish richer events directly. This helper
 * covers explicit stage transitions; callers suppress same-stage duplicates.
 */
export function publishTaskFailed(
  task: Task,
  group: RegisteredGroup,
  source: TaskFailedSource,
  timestamp = new Date().toISOString(),
): Promise<PublishEventResult> | undefined {
  return publishTaskStageEvent(
    task,
    group,
    'task_failed',
    { source, ...(task.error ? { error: task.error } : {}) },
    timestamp,
  );
}
