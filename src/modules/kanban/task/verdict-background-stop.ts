import { logger } from '../../../logger.js';
import { stopTaskBackgroundTask } from '../../../sandbox/process.js';
import { parseReviewDecision } from '../review.js';
import { parseTestingDecision } from '../testing.js';

export type VerdictStageKind = 'testing' | 'review';

/**
 * A testing or review run that already gave its verdict ends only when its
 * background tasks do, and a watcher the agent armed may never end by itself.
 * The returned function takes each `background_tasks` list the run reports and,
 * once the run's text so far holds a verdict the stage's own parser accepts,
 * stops the listed tasks so the run ends and the verdict is parsed as usual.
 * Each background task is stopped at most once per run; a refused stop is
 * logged and not retried. Create one per run.
 */
export function createVerdictBackgroundTaskStopper(input: {
  kind: VerdictStageKind;
  taskId: string;
  stageId: string;
  getRunId: () => string | null | undefined;
  /** The run's assistant text so far. */
  getOutput: () => string;
  stopBackgroundTask?: typeof stopTaskBackgroundTask;
}): (backgroundTasks: Array<{ id: string }>) => void {
  const stoppedIds = new Set<string>();
  const stopBackgroundTask = input.stopBackgroundTask ?? stopTaskBackgroundTask;
  return (backgroundTasks) => {
    const pending = backgroundTasks.filter(({ id }) => !stoppedIds.has(id));
    if (pending.length === 0) return;
    const output = input.getOutput();
    const hasVerdict =
      input.kind === 'testing'
        ? parseTestingDecision(output)
        : parseReviewDecision(output);
    if (!hasVerdict) return;
    if (stoppedIds.size === 0) {
      logger.info(
        {
          task_id: input.taskId,
          run_id: input.getRunId(),
          stage_id: input.stageId,
          count: pending.length,
        },
        'Stopping background tasks of a run that already gave its verdict',
      );
    }
    for (const { id } of pending) {
      stoppedIds.add(id);
      const warnNotAccepted = (error?: unknown) =>
        logger.warn(
          {
            task_id: input.taskId,
            run_id: input.getRunId(),
            background_task_id: id,
            ...(error ? { err: error } : {}),
          },
          'Background task stop was not accepted',
        );
      stopBackgroundTask(input.taskId, id).then(
        (accepted) => {
          if (!accepted) warnNotAccepted();
        },
        (error) => warnNotAccepted(error),
      );
    }
  };
}
