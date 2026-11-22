import { getRunningTaskIds as getPersistedRunningTaskIds } from '../../db.js';
import {
  getRunningTaskIds,
  getQueuedTaskIds,
  getWaitingTaskIds,
  isTaskExecutionPresented,
} from './task-executor.js';
import { getPreparingWorktreeTaskIds } from './task/worktree-preparation.js';

/**
 * Authoritative execution phase of a task. There is no `error` phase: `error`
 * stays its own field on the task.
 */
export type TaskPhase =
  | 'running'
  | 'preparing'
  | 'queued'
  | 'waiting'
  | 'stalled'
  | 'idle';

export interface TaskExecutionFlags {
  running: boolean;
  queued: boolean;
  waiting: boolean;
  preparing: boolean;
}

export interface TaskExecutionMarkers {
  running: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  waiting: ReadonlySet<string>;
  preparing: ReadonlySet<string>;
}

/**
 * Precedence: running > preparing > queued > waiting > stalled (error starts
 * with `Stalled`) > idle.
 */
function deriveTaskPhase(
  flags: TaskExecutionFlags,
  error?: string | null,
): TaskPhase {
  if (flags.running) return 'running';
  if (flags.preparing) return 'preparing';
  if (flags.queued) return 'queued';
  if (flags.waiting) return 'waiting';
  if (error?.startsWith('Stalled')) return 'stalled';
  return 'idle';
}

/** Collect the id sets the execution flags and phase are derived from. */
export async function loadTaskExecutionMarkers(
  projectIds: string[],
): Promise<TaskExecutionMarkers> {
  const [persistedRunning, waitingByProject] = await Promise.all([
    getPersistedRunningTaskIds(),
    Promise.all(projectIds.map((projectId) => getWaitingTaskIds(projectId))),
  ]);
  return {
    running: new Set([
      ...persistedRunning.filter(isTaskExecutionPresented),
      ...getRunningTaskIds(),
    ]),
    queued: new Set(getQueuedTaskIds()),
    waiting: new Set(waitingByProject.flat()),
    preparing: new Set(getPreparingWorktreeTaskIds()),
  };
}

export function presentTaskExecution(
  task: { id: string; error?: string | null },
  markers: TaskExecutionMarkers,
): TaskExecutionFlags & { phase: TaskPhase } {
  // These projections are read asynchronously and can observe different
  // moments of a handoff. Normalize them at the response boundary so a
  // run finishing (or a new claim arriving) cannot expose contradictory
  // execution markers. A real running claim wins over a queued claim,
  // which wins over the authoritative pending projection. Error-marked
  // tasks are queue candidates (a transient "Retry scheduled:" marker
  // must stay drain-eligible) but are never presented as waiting.
  const running = markers.running.has(task.id);
  const queued = !running && markers.queued.has(task.id);
  const waiting =
    !running && !queued && !task.error && markers.waiting.has(task.id);
  const preparing = !running && markers.preparing.has(task.id);
  const flags = { running, queued, waiting, preparing };
  return { ...flags, phase: deriveTaskPhase(flags, task.error) };
}
