import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from '../../../config.js';
import { openGroupDirSync } from '../../../lib/group-fs.js';
import { runChatAgent } from '../../../agent-runner.js';
import { resolveRuntimeSelection } from '../../../lib/chat-agents.js';
import { drainProjectQueue } from '../../kanban/task-executor.js';
import {
  getDueTasks,
  logTaskRun,
  getLatestScheduledRunId,
  updateScheduledTaskAfterRun,
  skipScheduledTaskOccurrence,
  getDueCronjobs,
  getCronjob,
  getObjective,
  updateCronjob,
  createTaskForDueCronjob,
  getTasksByProjectForQueue,
  cleanupOldRecords,
  claimScheduledTaskOccurrence,
  releaseScheduledTaskOccurrenceClaim,
} from '../../../db.js';
import { logger } from '../../../logger.js';
import { broadcast } from '../../objectives/ws-events.js';
import { getGroupStages } from '../../kanban/stages.js';
import { RegisteredGroup } from '../../../types.js';
import { ScheduledTask } from './types.js';
import { archiveOldTranscripts } from '../../transcripts/transcript-store.js';
import {
  maintainMemories,
  type MaintainMemoriesOptions,
} from '../../memory/maintenance.js';
import {
  canStartBackgroundWork,
  trackBackgroundWork,
} from '../../../lib/background-work-gate.js';
import { calcNextRun } from './next-run.js';
import { createSchedulerDispatch } from './scheduler-dispatch.js';
import { maintainIpc } from '../../../sandbox/ipc-maintenance.js';

export { calcNextRun } from './next-run.js';

export interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  runChatAgent?: typeof runChatAgent;
}

function broadcastCronjobUpdate(
  cronjob: Awaited<ReturnType<typeof getCronjob>>,
) {
  if (cronjob) broadcast({ type: 'cronjob_updated', payload: cronjob });
}

async function updateCronjobAndBroadcast(
  cronjobId: string,
  data: Parameters<typeof updateCronjob>[1],
): Promise<Awaited<ReturnType<typeof updateCronjob>>> {
  const updated = await updateCronjob(cronjobId, data);
  broadcastCronjobUpdate(updated);
  return updated;
}

/** Advance a skipped cron occurrence, quarantining malformed legacy schedules. */
async function advanceSkippedCronjobOccurrence(
  cronjobId: string,
  cronExpression: string,
): Promise<void> {
  try {
    const next_run = getNextCronjobOccurrence(cronExpression);
    await updateCronjobAndBroadcast(cronjobId, { next_run });
  } catch {
    // A malformed legacy cron cannot be advanced and would otherwise remain
    // due forever, logging once per scheduler poll.
    await updateCronjobAndBroadcast(cronjobId, { status: 'paused' });
  }
}

function getNextCronjobOccurrence(cronExpression: string): string | undefined {
  const interval = CronExpressionParser.parse(cronExpression, {
    tz: TIMEZONE,
  });
  return interval.next().toISOString() ?? undefined;
}

async function broadcastPersistedCronjob(cronjobId: string): Promise<void> {
  try {
    broadcastCronjobUpdate(await getCronjob(cronjobId));
  } catch (err) {
    // A notification lookup must not change the scheduler's task creation or
    // queue-drain behavior after the cronjob transaction has committed.
    logger.warn(
      { cronjob_id: cronjobId, error: String(err) },
      'Failed to publish updated cronjob state',
    );
  }
}

async function persistScheduledRun(
  task: ScheduledTask,
  log: Parameters<typeof logTaskRun>[0],
  nextRun: string | null,
  resultSummary: string,
): Promise<void> {
  try {
    await logTaskRun(log);
  } catch (err) {
    // A log write must not leave the schedule due for another execution.
    logger.error(
      { task_id: task.id, error: String(err) },
      'Failed to persist scheduled task run log',
    );
  }

  // Advance the schedule independently of logging so transient log-table
  // failures cannot cause duplicate task executions on the next poll.
  try {
    await finalizeScheduledRun(task, nextRun, resultSummary);
    return;
  } catch (err) {
    logger.error(
      { task_id: task.id, error: String(err) },
      'Failed to finalize scheduled task run; retrying',
    );
  }
  try {
    await finalizeScheduledRun(task, nextRun, resultSummary);
  } catch (retryErr) {
    logger.error(
      { task_id: task.id, error: String(retryErr) },
      'Failed to finalize scheduled task run; leaving occurrence claimed',
    );
    scheduleFinalizationRetry(task, resultSummary, 0);
  }
}

async function finalizeScheduledRun(
  task: ScheduledTask,
  nextRun: string | null,
  resultSummary: string,
): Promise<void> {
  const finalized = await updateScheduledTaskAfterRun(
    task.id,
    nextRun,
    resultSummary,
    task,
  );
  if (!finalized) {
    logger.info(
      { task_id: task.id },
      'Skipped stale scheduled occurrence finalization',
    );
  }
  broadcast({
    type: 'scheduled_task_run_completed',
    payload: {
      project_id: task.group_folder,
      scheduled_task_id: task.id,
    },
  });
}

/**
 * An occurrence whose finalization failed twice stays claimed (next_run NULL),
 * so it is neither due nor editable until finalized. Retry in the background
 * with backoff instead of waiting for the next restart's recovery.
 */
const FINALIZE_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

function scheduleFinalizationRetry(
  task: ScheduledTask,
  resultSummary: string,
  attempt: number,
): void {
  const delay = FINALIZE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    logger.error(
      { task_id: task.id },
      'Giving up background scheduled run finalization; startup recovery will repair it',
    );
    return;
  }
  setTimeout(async () => {
    try {
      // Recompute at repair time: the occurrence's original next_run may
      // already be in the past, which would make the task fire off-cadence.
      await finalizeScheduledRun(task, calcNextRun(task), resultSummary);
    } catch (err) {
      logger.error(
        { task_id: task.id, attempt: attempt + 1, error: String(err) },
        'Background scheduled run finalization failed',
      );
      scheduleFinalizationRetry(task, resultSummary, attempt + 1);
    }
  }, delay).unref();
}

export async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  onAgentStart?: () => void,
): Promise<void> {
  const startTime = Date.now();
  const occurrenceStartedAt = new Date(startTime).toISOString();
  // Create the group folder without following a swapped link; a refused
  // (linked) folder fails the run here, as an unusable one would later.
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  openGroupDirSync(task.group_folder, undefined, { create: true })?.closeSync();

  logger.info(
    { task_id: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { task_id: task.id, group_folder: task.group_folder },
      'Group not found for task',
    );
    // Advance next_run so the task isn't re-triggered on every scheduler poll.
    // Without this, a task whose group is missing would fire every 60 s indefinitely.
    // 'once' tasks: next_run stays null → updateScheduledTaskAfterRun marks them 'completed'
    await persistScheduledRun(
      task,
      {
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error: `Group not found: ${task.group_folder}`,
      },
      calcNextRun(task),
      `Error: group not found: ${task.group_folder}`,
    );
    return;
  }

  // A paused/stopped project must not launch new work. Advance this occurrence
  // without recording a run, matching the kanban cronjob scheduler behavior.
  const projectStatus = group.settings?.status ?? 'running';
  if (projectStatus === 'paused' || projectStatus === 'stopped') {
    // A deferred one-off must not be dropped: release the poll loop's claim so
    // it stays active with its original next_run and runs on the first poll
    // after the project resumes.
    if (task.schedule_type === 'once') {
      await releaseScheduledTaskOccurrenceClaim(task);
    } else {
      await skipScheduledTaskOccurrence(task.id, calcNextRun(task));
    }
    logger.debug(
      { task_id: task.id, project_status: projectStatus },
      'Skipping scheduled task for inactive project',
    );
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const session_id =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  let finalResult: string | null = null;
  let finalError: string | null = null;
  let runId: string | null = null;

  try {
    const resolvedAgent = task.runtimeSelection
      ? resolveRuntimeSelection(task.runtimeSelection)
      : undefined;
    // Keep the selected binding explicit even when a lightweight test/plugin
    // resolver returns only executable metadata.
    const explicitAgent =
      resolvedAgent && task.runtimeSelection
        ? {
            ...resolvedAgent,
            harnessId:
              resolvedAgent.harnessId ?? task.runtimeSelection.harnessId,
            modelId: resolvedAgent.modelId ?? task.runtimeSelection.modelId,
          }
        : undefined;
    onAgentStart?.();
    const output = await (deps.runChatAgent ?? runChatAgent)(
      group,
      task.prompt,
      task.chat_jid,
      undefined,
      session_id,
      false,
      undefined,
      undefined,
      {
        agent_cmd: explicitAgent?.id,
        agentConfig: explicitAgent,
        ephemeral: true,
        scheduledTaskId: task.id,
        isScheduledTask: true,
        senderUserId: null,
        triggeredByUserId: null,
        triggerSource: 'schedule',
        onSlotAcquired: () => {
          broadcast({
            type: 'scheduled_task_run_started',
            payload: {
              project_id: task.group_folder,
              scheduled_task_id: task.id,
            },
          });
        },
      },
    );

    if (output.failed) {
      finalError = output.result || 'Agent failed to produce output';
    } else {
      finalResult = output.result;
    }

    // Provider UUIDs identify the upstream session, not the board run. History
    // and preserved transcript files are keyed by the active_runs identifier.
    runId =
      output.activeRunId ??
      (await getLatestScheduledRunId(task.id, occurrenceStartedAt));

    logger.info(
      { task_id: task.id, duration_ms: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    finalError = err instanceof Error ? err.message : String(err);
    // The sandbox can create its active-run row before a launch/wait failure.
    // Recover the id so error history keeps its transcript ownership link.
    runId = await getLatestScheduledRunId(task.id, occurrenceStartedAt);
    logger.error({ task_id: task.id, error: finalError }, 'Task failed');
  }

  const duration_ms = Date.now() - startTime;

  const next_run = calcNextRun(task);
  // 'once' tasks have no next run (calcNextRun returns null)

  const resultSummary = finalError
    ? `Error: ${finalError}`
    : finalResult
      ? (finalResult as string).slice(0, 200)
      : 'Completed';
  await persistScheduledRun(
    task,
    {
      task_id: task.id,
      run_id: typeof runId === 'string' ? runId : null,
      run_at: new Date().toISOString(),
      duration_ms,
      status: finalError ? 'error' : 'success',
      result: finalResult,
      error: finalError,
    },
    next_run,
    resultSummary,
  );
}

/** Execute only the exact due occurrence selected by the scheduler query.
 * A PATCH may commit while the query result is being processed; reloading and
 * checking the occurrence marker prevents that stale selection from launching
 * a newly configured future cadence. The selected snapshot is intentionally
 * executed so prompt/runtime edits apply to subsequent occurrences only. */
export async function runSelectedDueTask(
  selected: ScheduledTask,
  deps: SchedulerDependencies,
  now = new Date().toISOString(),
): Promise<boolean> {
  if (!(await claimScheduledTaskOccurrence(selected, now))) return false;
  let agentStarted = false;
  try {
    await runTask(selected, deps, () => {
      agentStarted = true;
    });
  } catch (err) {
    if (!agentStarted) await releaseScheduledTaskOccurrenceClaim(selected);
    throw err;
  }
  return true;
}

export async function processDueCronjobs(
  deps: SchedulerDependencies,
): Promise<void> {
  const dueCronjobs = await getDueCronjobs();
  if (dueCronjobs.length === 0) return;

  logger.info({ count: dueCronjobs.length }, 'Found due cronjobs');

  const groups = deps.registeredGroups();
  const groupByFolder = new Map(
    Object.values(groups).map((g) => [g.folder, g]),
  );
  for (const cronjob of dueCronjobs) {
    try {
      const group = groupByFolder.get(cronjob.project_id);
      if (!group) {
        logger.warn(
          { cronjob_id: cronjob.id, project: cronjob.project_id },
          'No group found for cronjob',
        );
        // Advance next_run so a deleted or temporarily unregistered project
        // does not make this cronjob fire on every scheduler poll.
        await advanceSkippedCronjobOccurrence(
          cronjob.id,
          cronjob.cron_expression,
        );
        continue;
      }

      if (cronjob.objective_id) {
        const objective = await getObjective(cronjob.objective_id);
        if (!objective || objective.status !== 'active') {
          await updateCronjobAndBroadcast(cronjob.id, { status: 'paused' });
          logger.info(
            {
              cronjob_id: cronjob.id,
              objective_id: cronjob.objective_id,
              objective_status: objective?.status ?? 'missing',
            },
            'Cronjob waiting for active objective',
          );
          continue;
        }
      }

      // Compute stages once per cronjob iteration
      const stages = getGroupStages(group);

      // Pausing/stopping a project promises that no new tasks will be queued.
      // drainProjectQueue also guards this state, but it runs after task
      // creation; relying on that guard would accumulate active-stage cron
      // cards that all start when the project resumes.
      const projectStatus = group.settings?.status ?? 'running';
      if (projectStatus === 'paused' || projectStatus === 'stopped') {
        await advanceSkippedCronjobOccurrence(
          cronjob.id,
          cronjob.cron_expression,
        );
        continue;
      }

      // Check queue_mode: if 'if_empty', skip while the project still has
      // work queued in an execution stage. A task can remain in an active
      // stage without a running active_runs row after a launch failure; that
      // pending card must still prevent the cronjob from piling up duplicates.
      if (cronjob.queue_mode === 'if_empty') {
        const activeStageIds = new Set(
          stages
            .filter(
              (s) =>
                (s.type === 'active' ||
                  s.type === 'testing' ||
                  s.type === 'review') &&
                !s.inactive,
            )
            .map((s) => s.id),
        );
        const projectTasks = await getTasksByProjectForQueue(
          cronjob.project_id,
        );
        // Archived cards keep their stage (archiving has no stage-transition
        // side effects) but can never run — the drain and list_tasks both
        // exclude them — so an archived card must not pin an if_empty
        // cronjob in skip-forever.
        const hasPending = projectTasks.some(
          (task) => !task.archived && activeStageIds.has(task.status),
        );
        if (hasPending) {
          logger.debug(
            { cronjob_id: cronjob.id },
            'Skipping cronjob: project has pending tasks',
          );
          // Advance next_run so we don't re-check every poll, but do NOT update
          // last_run — the job didn't actually run, so last_run must stay accurate.
          let next_run: string | undefined;
          try {
            next_run = getNextCronjobOccurrence(cronjob.cron_expression);
          } catch {
            // A malformed legacy cron cannot be advanced and would otherwise
            // remain due forever, logging once per scheduler poll.
            await updateCronjobAndBroadcast(cronjob.id, { status: 'paused' });
            continue;
          }
          // Keep persistence failures retryable: a transient database error must
          // not quarantine an otherwise valid cronjob.
          await updateCronjobAndBroadcast(cronjob.id, { next_run });
          continue;
        }
      }

      // Create a new task from the cronjob — place it directly in the first
      // active stage so drainProjectQueue picks it up for execution. A project
      // may validly have no active stages (for example, only queue + done),
      // so do not fall back to a queue stage that drainProjectQueue cannot run.
      const activeStage = stages.find(
        (s) => s.type === 'active' && !s.inactive,
      );

      if (!activeStage) {
        logger.error(
          { cronjob_id: cronjob.id },
          'No active stage found for cronjob task; skipping',
        );
        await advanceSkippedCronjobOccurrence(
          cronjob.id,
          cronjob.cron_expression,
        );
        continue;
      }

      // Validate and advance the schedule before creating any work. Legacy or
      // directly imported rows can bypass API validation; those must be
      // quarantined without executing once merely because they are already due.
      let next_run: string;
      try {
        const parsedNextRun = getNextCronjobOccurrence(cronjob.cron_expression);
        if (!parsedNextRun) throw new Error('Cron produced no next run');
        next_run = parsedNextRun;
      } catch {
        await updateCronjobAndBroadcast(cronjob.id, { status: 'paused' });
        continue;
      }

      const task = await createTaskForDueCronjob(
        cronjob.id,
        cronjob.next_run!,
        next_run,
        {
          project_id: cronjob.project_id,
          title: cronjob.title,
          description: cronjob.description,
          status: activeStage.id,
          priority: 0,
          runtimeSelection: cronjob.runtimeSelection ?? undefined,
          runtimeSelectionStage: cronjob.runtimeSelectionStage ?? undefined,
          objective_id: cronjob.objective_id ?? undefined,
          cronjob_id: cronjob.id,
          author: 'cronjob',
          ownerUserId: group.user_id ?? null,
          lastTriggeredByUserId: null,
          lastTriggerSource: 'schedule',
          lastTriggeredAt: new Date().toISOString(),
        },
      );
      if (!task) {
        logger.debug(
          { cronjob_id: cronjob.id },
          'Skipping cronjob occurrence already claimed by another sweep',
        );
        continue;
      }

      await broadcastPersistedCronjob(cronjob.id);
      broadcast({ type: 'task_created', payload: task });
      logger.info(
        { cronjob_id: cronjob.id, task_id: task.id, stage: activeStage.id },
        'Cronjob spawned task',
      );

      // Trigger queue drain so the task starts executing
      drainProjectQueue(cronjob.project_id, group).catch((err) => {
        logger.error(
          { cronjob_id: cronjob.id, task_id: task.id, error: String(err) },
          'Error draining queue for cronjob task',
        );
      });
    } catch (err) {
      logger.error(
        { cronjob_id: cronjob.id, error: String(err) },
        'Error processing cronjob',
      );
    }
  }
}

const CLEANUP_INTERVAL_MS = 3600_000; // 1 hour
const TRANSCRIPT_ARCHIVE_INTERVAL_MS = 24 * 3600_000; // 1 day
const TRANSCRIPT_ARCHIVE_STAMP_PATH = path.join(
  DATA_DIR,
  'transcript-archive.last-run',
);
let lastCleanup = 0;
let lastTranscriptArchive: number | null = null;

async function claimTranscriptArchiveRun(): Promise<boolean> {
  const now = Date.now();
  if (lastTranscriptArchive === null) {
    try {
      lastTranscriptArchive = (
        await fs.promises.stat(TRANSCRIPT_ARCHIVE_STAMP_PATH)
      ).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      lastTranscriptArchive = 0;
    }
  }
  if (now - lastTranscriptArchive < TRANSCRIPT_ARCHIVE_INTERVAL_MS) {
    return false;
  }
  return true;
}

/** Persist the archive watermark only after the archive operation succeeds. */
async function recordTranscriptArchiveRun(): Promise<void> {
  const now = Date.now();
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(
    TRANSCRIPT_ARCHIVE_STAMP_PATH,
    `${new Date(now).toISOString()}\n`,
    { mode: 0o600 },
  );
  lastTranscriptArchive = now;
}

/** The LLM steps of the last hourly pass were skipped while paused. */
let llmMaintenancePending = false;

/**
 * Memory maintenance for every group. Returns false when the
 * background-work gate closed before all groups were handled, so the caller
 * retries the pass after resume.
 */
async function runLlmMaintenance(
  deps: SchedulerDependencies,
): Promise<boolean> {
  // Shared by every group so the vector backfill budget spans the whole pass.
  const maintenanceOptions: MaintainMemoriesOptions = {};
  for (const group of Object.values(deps.registeredGroups())) {
    if (!canStartBackgroundWork()) return false;
    try {
      await trackBackgroundWork('maintenance job', () =>
        maintainMemories(group.folder, maintenanceOptions),
      );
    } catch (err) {
      logger.warn(
        { err, group_folder: group.folder },
        'Memory maintenance failed (non-blocking)',
      );
    }
  }
  return true;
}

async function runMaintenancePoll(deps: SchedulerDependencies): Promise<void> {
  // Periodic DB cleanup (once per hour). Housekeeping is not LLM work and
  // keeps running while background work is paused.
  if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
    const deleted = await cleanupOldRecords();
    if (deleted.taskRunLogs > 0) {
      logger.info(deleted, 'Database cleanup completed');
    }
    if (await claimTranscriptArchiveRun()) {
      const archivedCount = await archiveOldTranscripts();
      await recordTranscriptArchiveRun();
      if (archivedCount > 0) {
        logger.info(
          { transcripts: archivedCount },
          'Transcript archival completed',
        );
      }
    }
    await maintainIpc(Object.values(deps.registeredGroups()));

    // Only mark the housekeeping complete after every non-optional cleanup
    // step above succeeds. If cleanupOldRecords or transcript archival
    // fails, the maintenance lane logs the error and the next poll should
    // retry instead of suppressing cleanup for a full hour.
    lastCleanup = Date.now();
    llmMaintenancePending = true;
  }

  if (llmMaintenancePending && canStartBackgroundWork()) {
    llmMaintenancePending = !(await runLlmMaintenance(deps));
  }
}

export function createSchedulerPoll(
  deps: SchedulerDependencies,
): () => Promise<void> {
  return createSchedulerDispatch({
    getDueTasks: async () => {
      const tasks = await getDueTasks();
      if (tasks.length > 0) {
        logger.info({ count: tasks.length }, 'Found due tasks');
      }
      return tasks;
    },
    runTask: (task) => runSelectedDueTask(task, deps),
    processCronjobs: () => processDueCronjobs(deps),
    maintain: () => runMaintenancePoll(deps),
    onError: (lane, error, taskId) => {
      logger.error(
        { lane, task_id: taskId, error: String(error) },
        'Error in scheduler lane',
      );
    },
  });
}

export function startSchedulerLoop(deps: SchedulerDependencies): () => void {
  logger.info('Scheduler loop started');

  const poll = createSchedulerPoll(deps);
  const tick = () => {
    void poll().catch((err) => {
      logger.error({ err }, 'Error in scheduler loop');
    });
  };
  // Keep the clock independent of job completion. Each lane and individual
  // scheduled task owns its own single-flight guard inside the dispatcher.
  const timer = setInterval(tick, SCHEDULER_POLL_INTERVAL);
  tick();
  return () => clearInterval(timer);
}
