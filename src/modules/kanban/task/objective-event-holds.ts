/**
 * Hold failed / needs-input notifications of objective-tagged tasks while the
 * owning objective's agent handles the matching brain event.
 *
 * A hold is a persisted row (`held` → `notified` | `dropped`, settled with a
 * guarded SQL transition so it notifies at most once). It is released when:
 *   - the publish shows nobody will handle the event (skipped, failed, an old
 *     brain without `delivery`, or `delivery.status === 'dropped'`): notify;
 *   - the brain acks the run through `ack_objective_task_event`, or the
 *     fallback timeout passes: notify only if the task is still in the held
 *     stage, otherwise drop (the agent already moved it).
 */
import { randomUUID } from 'node:crypto';
import {
  insertObjectiveTaskEventHold,
  listOpenObjectiveTaskEventHolds,
  listOverdueObjectiveTaskEventHolds,
  settleObjectiveTaskEventHold,
} from '../../../db/objective-task-event-holds.js';
import type {
  ObjectiveTaskEventHold,
  ObjectiveTaskEventType,
} from '../../../db/objective-task-event-holds.js';
import { logger } from '../../../logger.js';
import type { RegisteredGroup } from '../../../types.js';
import { notifyEntityLifecycle } from '../../tools/push-tools.js';
import type { PublishEventResult } from '../../objectives/brain-client.js';
import { getTask } from '../db-kanban.js';
import type { Task } from '../types.js';
import {
  publishTaskFailed,
  publishTaskQuestion,
  type TaskFailedSource,
  type TaskQuestionSource,
} from './objective-events.js';

/** A hold the objective did not settle within this long is settled as if acked. */
export const OBJECTIVE_EVENT_HOLD_TIMEOUT_MS = 30 * 60 * 1000;

/** How often overdue holds are checked while the board runs. */
export const OBJECTIVE_EVENT_HOLD_SWEEP_INTERVAL_MS = 60 * 1000;

type LifecycleNotification = Parameters<typeof notifyEntityLifecycle>[0];

export interface ObjectiveEventHoldDeps {
  notify?: typeof notifyEntityLifecycle;
  /** Replaces the brain publish; receives the event timestamp. */
  publish?: ObjectiveEventPublisher;
}

export type ObjectiveTaskEventAckOutcome = 'handled' | 'failed' | 'skipped';

/** Whether the objective will report back for this publish. */
function objectiveWillHandle({ outcome, delivery }: PublishEventResult) {
  return (
    outcome === 'queued' ||
    (outcome === 'delivered' && delivery?.status === 'enqueued')
  );
}

async function deliver(
  hold: ObjectiveTaskEventHold,
  deps: ObjectiveEventHoldDeps,
): Promise<void> {
  try {
    await (deps.notify ?? notifyEntityLifecycle)({
      ...(JSON.parse(hold.notification) as LifecycleNotification),
      // The project may have been renamed since the hold was stored.
      group_folder: hold.project_id,
    });
  } catch (err) {
    logger.warn(
      { err, hold_id: hold.id, task_id: hold.task_id },
      'Held objective task notification failed to deliver',
    );
  }
}

type HoldSettleReason = 'not_handled' | 'ack' | 'timeout';

/** One info line per settled hold: its outcome, not the notification content. */
function logHoldSettled(
  hold: ObjectiveTaskEventHold,
  reason: HoldSettleReason,
  taskStatus?: string | null,
): void {
  logger.info(
    {
      hold_id: hold.id,
      task_id: hold.task_id,
      objective_id: hold.objective_id,
      project_id: hold.project_id,
      event_type: hold.event_type,
      stage_id: hold.stage_id,
      state: hold.state,
      reason,
      held_ms:
        hold.settled_at === null
          ? null
          : Date.parse(hold.settled_at) - Date.parse(hold.created_at),
      ...(hold.state === 'dropped' ? { task_status: taskStatus ?? null } : {}),
    },
    'Objective task event hold settled',
  );
}

/** Notify now, once, regardless of where the task is. */
async function releaseHold(
  holdId: string,
  deps: ObjectiveEventHoldDeps,
): Promise<void> {
  const hold = await settleObjectiveTaskEventHold(holdId, 'notified');
  if (!hold) return;
  logHoldSettled(hold, 'not_handled');
  await deliver(hold, deps);
}

/** Notify if the task is still in the held stage, else drop the hold. */
async function settleHold(
  hold: ObjectiveTaskEventHold,
  reason: 'ack' | 'timeout',
  deps: ObjectiveEventHoldDeps,
): Promise<boolean> {
  const task = await getTask(hold.task_id);
  const stillInStage = task?.status === hold.stage_id;
  const settled = await settleObjectiveTaskEventHold(
    hold.id,
    stillInStage ? 'notified' : 'dropped',
  );
  if (!settled) return false;
  logHoldSettled(settled, reason, task?.status);
  if (stillInStage) await deliver(settled, deps);
  return true;
}

/** Publishes the brain event with the given event timestamp. */
export type ObjectiveEventPublisher = (
  timestamp: string,
) => Promise<PublishEventResult | undefined> | undefined;

/**
 * Publish an objective event for a task that entered Question or Failed and
 * send the matching notification. An untagged task (no objective) notifies
 * immediately. A tagged task's notification is persisted as a hold before the
 * publish, so a restart mid-publish still ends in the timeout settlement; it
 * resolves once the hold exists and the publish outcome is handled in the
 * background, so a slow brain never delays the caller. `released` settles once
 * that outcome is handled; callers do not need to await it.
 *
 * `task` must already be in the stage it entered: the hold is dropped on
 * settlement when the task has left it. `publish` must use the timestamp it is
 * given as the event timestamp so the brain's ack can match the hold.
 */
export async function publishEventAndNotify(
  task: Task,
  eventType: ObjectiveTaskEventType,
  publishEvent: ObjectiveEventPublisher,
  notification: LifecycleNotification,
  deps: ObjectiveEventHoldDeps = {},
): Promise<{ released: Promise<void> }> {
  const notify = deps.notify ?? notifyEntityLifecycle;
  const timestamp = new Date().toISOString();
  const publish = () => (deps.publish ?? publishEvent)(timestamp);
  if (!task.objective_id) {
    void publish();
    await notify(notification);
    return { released: Promise.resolve() };
  }
  const holdId = randomUUID();
  try {
    await insertObjectiveTaskEventHold({
      id: holdId,
      project_id: task.project_id,
      task_id: task.id,
      objective_id: task.objective_id,
      stage_id: task.status,
      event_type: eventType,
      event_timestamp: timestamp,
      notification: JSON.stringify(notification),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { err, task_id: task.id },
      'Could not hold objective task notification — notifying now',
    );
    void publish();
    await notify(notification);
    return { released: Promise.resolve() };
  }
  const publication = publish();
  const released = (async () => {
    const result = (await publication) ?? { outcome: 'skipped' as const };
    if (!objectiveWillHandle(result)) await releaseHold(holdId, deps);
  })().catch((err: unknown) =>
    logger.warn(
      { err, hold_id: holdId, task_id: task.id },
      'Releasing held objective task notification failed',
    ),
  );
  return { released };
}

/** {@link publishEventAndNotify} for the standard Question / Failed events. */
export function publishTaskEventAndNotify(
  task: Task,
  group: RegisteredGroup,
  event:
    | { type: 'task_question'; source: TaskQuestionSource; reason?: string }
    | { type: 'task_failed'; source: TaskFailedSource },
  notification: LifecycleNotification,
  deps: ObjectiveEventHoldDeps = {},
): Promise<{ released: Promise<void> }> {
  return publishEventAndNotify(
    task,
    event.type,
    (timestamp) =>
      event.type === 'task_question'
        ? publishTaskQuestion(
            task,
            group,
            event.source,
            event.reason,
            timestamp,
          )
        : publishTaskFailed(task, group, event.source, timestamp),
    notification,
    deps,
  );
}

/**
 * Settle the open holds an objective run reports on (`ack_objective_task_event`).
 * With no matching hold this is a no-op. Returns how many holds it settled.
 */
export async function acknowledgeObjectiveTaskEvent(
  ack: {
    objective_id: string;
    task_id: string;
    event_type: ObjectiveTaskEventType;
    event_timestamp?: string;
    outcome: ObjectiveTaskEventAckOutcome;
  },
  deps: ObjectiveEventHoldDeps = {},
): Promise<number> {
  const holds = await listOpenObjectiveTaskEventHolds(ack);
  let settled = 0;
  for (const hold of holds) {
    if (await settleHold(hold, 'ack', deps)) settled++;
  }
  logger.info(
    { ...ack, matched: holds.length, settled },
    'Objective task event acknowledged',
  );
  return settled;
}

/** Settle every hold older than the timeout as if acked. Idempotent. */
export async function settleOverdueObjectiveTaskEventHolds(
  deps: ObjectiveEventHoldDeps = {},
  now = Date.now(),
): Promise<void> {
  const cutoff = new Date(now - OBJECTIVE_EVENT_HOLD_TIMEOUT_MS).toISOString();
  for (const hold of await listOverdueObjectiveTaskEventHolds(cutoff)) {
    await settleHold(hold, 'timeout', deps).catch((err: unknown) =>
      logger.warn(
        { err, hold_id: hold.id, task_id: hold.task_id },
        'Settling overdue objective task hold failed',
      ),
    );
  }
}
