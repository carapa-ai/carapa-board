import type { BoardReplayData, BoardReplayRun, TaskSummary } from '@/types';

const HOUR_MS = 60 * 60_000;
const REVIEW_NOTES_MARKER = '## Review notes';

function withoutFutureReviewMetadata(task: TaskSummary): TaskSummary {
  const markerAt = task.description.lastIndexOf(REVIEW_NOTES_MARKER);
  const customValues = task.custom_values
    ? { ...task.custom_values }
    : undefined;
  if (customValues) {
    delete customValues.quality_score;
    delete customValues.rejection_count;
  }
  return {
    ...task,
    description: markerAt >= 0
      ? task.description.slice(0, markerAt).trim()
      : task.description,
    // Task errors describe the latest operational state, not durable card
    // metadata. Run outcomes are rendered separately at their own timestamp.
    error: undefined,
    custom_values: customValues,
  };
}

/**
 * Real-time playback duration at 1×. Short periods stay easy to follow, while
 * day/week replays get enough screen time to make card movement legible.
 */
export function replayDurationMs(selectedPeriodMs: number): number {
  const hours = Math.max(0, selectedPeriodMs / HOUR_MS);
  if (hours <= 6) return 60_000;
  if (hours <= 24) {
    return 60_000 + ((hours - 6) / 18) * 60_000;
  }
  if (hours <= 168) {
    return 120_000 + ((hours - 24) / 144) * 480_000;
  }
  return 600_000 * (hours / 168);
}

export function reconstructReplayTasks(
  data: BoardReplayData | undefined,
  at: number,
): TaskSummary[] {
  if (!data) return [];
  const exactBoundary = data.exactHistoryAvailableFrom
    ? new Date(data.exactHistoryAvailableFrom).getTime()
    : null;
  const inferredPreHistory = exactBoundary !== null && at < exactBoundary;
  const tasks = new Map(data.initialTasks.map((task) => {
    const snapshot = inferredPreHistory
      ? withoutFutureReviewMetadata(task)
      : { ...task };
    return [task.id, snapshot];
  }));
  const actions = [
    ...data.reviewMilestones.map((milestone) => ({
      occurredAt: milestone.occurred_at,
      order: 0,
      milestone,
    })),
    ...data.events.map((event) => ({
      occurredAt: event.occurred_at,
      order: 1,
      event,
    })),
  ].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt) || a.order - b.order,
  );
  for (const action of actions) {
    if (new Date(action.occurredAt).getTime() > at) break;
    if ('event' in action && action.event) {
      const event = action.event;
      if (event.event_type === 'deleted') tasks.delete(event.task_id);
      else tasks.set(event.task_id, { ...event.snapshot });
      continue;
    }
    if (!('milestone' in action) || !action.milestone) continue;
    const milestone = action.milestone;
    const task = tasks.get(milestone.task_id);
    if (!task) continue;
    const customValues = { ...(task.custom_values ?? {}) };
    customValues.quality_score = milestone.score;
    if (milestone.rejection_count !== null) {
      customValues.rejection_count = milestone.rejection_count;
    }
    tasks.set(task.id, { ...task, custom_values: customValues });
  }
  return [...tasks.values()];
}

export function replayRunsAt(
  data: BoardReplayData | undefined,
  at: number,
  completedOutcomeWindowMs = Number.POSITIVE_INFINITY,
): Map<string, BoardReplayRun> {
  const result = new Map<string, BoardReplayRun>();
  if (!data) return result;
  for (const run of data.runs) {
    const start = new Date(run.started_at).getTime();
    const end = run.completed_at ? new Date(run.completed_at).getTime() : Infinity;
    if (start > at) continue;
    if (end <= at && at - end > completedOutcomeWindowMs) continue;
    const previous = result.get(run.task_id);
    if (!previous || new Date(previous.started_at).getTime() <= start) {
      result.set(run.task_id, {
        ...run,
        status: at < end ? 'running' : run.status,
      });
    }
  }
  return result;
}
