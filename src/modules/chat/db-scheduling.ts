import { drizzleDbRef } from '../../db/drizzle-client.js';
import { activeRuns, scheduledTasks, taskRunLogs } from '../../db/schema.js';
import type { ActiveRun } from '../kanban/execution/types.js';
import {
  eq,
  and,
  desc,
  gt,
  gte,
  isNull,
  lte,
  isNotNull,
  notExists,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { ScheduledTask, TaskRunLog } from './scheduling/types.js';

type ScheduledTaskUpdates = Partial<
  Pick<
    ScheduledTask,
    | 'prompt'
    | 'schedule_type'
    | 'schedule_value'
    | 'next_run'
    | 'status'
    | 'runtimeSelection'
    | 'context_mode'
  >
>;

const SCHEDULED_TASK_UPDATE_KEYS = [
  'prompt',
  'schedule_type',
  'schedule_value',
  'next_run',
  'status',
  'runtimeSelection',
  'context_mode',
] as const;

function definedScheduledTaskUpdates(updates: ScheduledTaskUpdates): any {
  const defined: any = {};
  for (const key of SCHEDULED_TASK_UPDATE_KEYS) {
    if (updates[key] !== undefined) defined[key] = updates[key];
  }
  return defined;
}

export async function createScheduledTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await drizzleDbRef.current
    .insert(scheduledTasks)
    .values({
      id: task.id,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode || 'isolated',
      runtimeSelection: task.runtimeSelection ?? null,
      next_run: task.next_run,
      status: task.status,
      created_at: task.created_at,
    })
    .execute();
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id));
  if (!rows[0]) return undefined;
  return rows[0];
}

export async function getTasksForGroup(
  group_folder: string,
): Promise<ScheduledTask[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.group_folder, group_folder))
    .orderBy(desc(scheduledTasks.created_at))
    .limit(500);
  return rows;
}

export async function getAllScheduledTasks(): Promise<ScheduledTask[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(scheduledTasks)
    .orderBy(desc(scheduledTasks.created_at))
    .limit(1000);
  return rows;
}

export async function updateScheduledTask(
  id: string,
  updates: ScheduledTaskUpdates,
): Promise<void> {
  const setObj = definedScheduledTaskUpdates(updates);

  if (Object.keys(setObj).length === 0) return;

  await drizzleDbRef.current
    .update(scheduledTasks)
    .set(setObj)
    .where(eq(scheduledTasks.id, id))
    .execute();
}

/** Atomically reject edits once an occurrence exists, avoiding completion
 * overwriting a newly calculated schedule between a read and write. */
export async function updateScheduledTaskIfIdle(
  id: string,
  updates: ScheduledTaskUpdates,
): Promise<boolean> {
  const setObj = definedScheduledTaskUpdates(updates);
  if (!Object.keys(setObj).length) return true;
  // A status write without a new next_run keeps the current one, so a row with
  // next_run NULL (completed one-off) would become an active/paused marker
  // state (occurrence claim / deletion reservation). Reject that atomically.
  const keepsNullNextRun =
    setObj.status !== undefined && setObj.next_run === undefined;
  const rows = await drizzleDbRef.current
    .update(scheduledTasks)
    .set(setObj)
    .where(
      and(
        eq(scheduledTasks.id, id),
        keepsNullNextRun ? isNotNull(scheduledTasks.next_run) : undefined,
        or(
          ne(scheduledTasks.status, 'active'),
          isNotNull(scheduledTasks.next_run),
        ),
        or(
          ne(scheduledTasks.status, 'paused'),
          isNotNull(scheduledTasks.next_run),
        ),
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.scheduled_task_id, id),
                inFlightScheduledRunPredicate(),
              ),
            ),
        ),
      ),
    )
    .returning();
  return rows.length === 1;
}

/** Atomically reserve the exact due occurrence before waiting for capacity. */
export async function claimScheduledTaskOccurrence(
  task: ScheduledTask,
  now = new Date().toISOString(),
): Promise<boolean> {
  if (!task.next_run || task.next_run > now) return false;
  const rows = await drizzleDbRef.current
    .update(scheduledTasks)
    .set({ next_run: null })
    .where(
      and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.status, 'active'),
        eq(scheduledTasks.schedule_type, task.schedule_type),
        eq(scheduledTasks.schedule_value, task.schedule_value),
        eq(scheduledTasks.next_run, task.next_run),
      ),
    )
    .returning();
  return rows.length === 1;
}

/** A pause that lands on a claim whose run has not started leaves the row
 * paused with a NULL next_run, the same marker as a deletion reservation. The
 * claimant's release owns that row only while its last_run is unchanged: a
 * finalized occurrence advances last_run, so a stale release cannot touch a
 * later deletion reservation. */
export async function releaseScheduledTaskOccurrenceClaim(
  task: ScheduledTask,
): Promise<void> {
  if (!task.next_run) return;
  await drizzleDbRef.current
    .update(scheduledTasks)
    .set({ next_run: task.next_run })
    .where(
      and(
        eq(scheduledTasks.id, task.id),
        or(
          eq(scheduledTasks.status, 'active'),
          and(
            eq(scheduledTasks.status, 'paused'),
            task.last_run
              ? eq(scheduledTasks.last_run, task.last_run)
              : isNull(scheduledTasks.last_run),
          ),
        ),
        eq(scheduledTasks.schedule_type, task.schedule_type),
        eq(scheduledTasks.schedule_value, task.schedule_value),
        isNull(scheduledTasks.next_run),
      ),
    );
}

/** Release occurrence reservations that survived a process restart before a
 * current active_runs row could be created (for example while waiting for capacity).
 * Active null-next-run rows are claims, as are paused ones (a pause landed on
 * the claim); this runs only at startup, when no deletion is in flight, so a
 * paused null row cannot be a live deletion reservation. Completed one-offs are
 * excluded. */
export async function releaseOrphanedScheduledTaskOccurrenceClaims(
  retryAt = new Date().toISOString(),
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .update(scheduledTasks)
    .set({ next_run: retryAt })
    .where(
      and(
        or(
          eq(scheduledTasks.status, 'active'),
          eq(scheduledTasks.status, 'paused'),
        ),
        isNull(scheduledTasks.next_run),
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.scheduled_task_id, scheduledTasks.id),
                inFlightScheduledRunPredicate(),
              ),
            ),
        ),
      ),
    )
    .returning();
  return rows.map(({ id }) => id);
}

/** Reserve deletion against the same row marker used by occurrence claiming. */
export async function reserveScheduledTaskDeletion(
  id: string,
): Promise<ScheduledTask | null> {
  const task = await getTaskById(id);
  if (!task) return null;
  const statusMarker =
    task.status === null
      ? isNull(scheduledTasks.status)
      : eq(scheduledTasks.status, task.status);
  const nextRunMarker =
    task.next_run === null
      ? isNull(scheduledTasks.next_run)
      : eq(scheduledTasks.next_run, task.next_run);
  const rows = await drizzleDbRef.current
    .update(scheduledTasks)
    .set({ status: 'paused', next_run: null })
    .where(
      and(
        eq(scheduledTasks.id, id),
        statusMarker,
        nextRunMarker,
        eq(scheduledTasks.schedule_type, task.schedule_type),
        eq(scheduledTasks.schedule_value, task.schedule_value),
        // active + null is an occurrence reservation, not an idle task
        or(
          ne(scheduledTasks.status, 'active'),
          isNotNull(scheduledTasks.next_run),
        ),
        // paused + null is an in-progress deletion reservation
        or(
          ne(scheduledTasks.status, 'paused'),
          isNotNull(scheduledTasks.next_run),
        ),
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.scheduled_task_id, id),
                or(
                  eq(activeRuns.status, 'running'),
                  and(
                    notExists(
                      drizzleDbRef.current
                        .select({ one: sql`1` })
                        .from(taskRunLogs)
                        .where(eq(taskRunLogs.run_id, activeRuns.id)),
                    ),
                    or(
                      isNull(scheduledTasks.last_run),
                      gt(activeRuns.started_at, scheduledTasks.last_run),
                    ),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .returning();
  return rows.length === 1 ? task : null;
}

export async function releaseScheduledTaskDeletion(
  task: ScheduledTask,
): Promise<void> {
  await drizzleDbRef.current
    .update(scheduledTasks)
    .set({ status: task.status, next_run: task.next_run })
    .where(
      and(
        eq(scheduledTasks.id, task.id),
        eq(scheduledTasks.status, 'paused'),
        isNull(scheduledTasks.next_run),
        eq(scheduledTasks.schedule_type, task.schedule_type),
        eq(scheduledTasks.schedule_value, task.schedule_value),
      ),
    );
}

export async function deleteScheduledTask(id: string): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    await tx.delete(taskRunLogs).where(eq(taskRunLogs.task_id, id)).execute();
    await tx.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).execute();
  });
}

function inFlightScheduledRunPredicate() {
  return and(
    or(
      isNull(scheduledTasks.last_run),
      gt(activeRuns.started_at, scheduledTasks.last_run),
    ),
    or(
      eq(activeRuns.status, 'running'),
      notExists(
        drizzleDbRef.current
          .select({ one: sql`1` })
          .from(taskRunLogs)
          .where(eq(taskRunLogs.run_id, activeRuns.id)),
      ),
    ),
  );
}

export interface RunningScheduledTaskState {
  run: ActiveRun | null;
  startedAt: string | null;
}

/** Includes both occurrences waiting for a sandbox slot and occurrences with
 * an active-run row. Paused tasks remain visible here while their current
 * occurrence is allowed to finish. */
export async function getRunningScheduledTaskStatesForGroup(
  group_folder: string,
): Promise<Map<string, RunningScheduledTaskState>> {
  const rows = await drizzleDbRef.current
    .selectDistinctOn([scheduledTasks.id], {
      id: scheduledTasks.id,
      run: activeRuns,
    })
    .from(activeRuns)
    .innerJoin(
      scheduledTasks,
      eq(activeRuns.scheduled_task_id, scheduledTasks.id),
    )
    .where(
      and(
        eq(scheduledTasks.group_folder, group_folder),
        inFlightScheduledRunPredicate(),
      ),
    )
    .orderBy(scheduledTasks.id, desc(activeRuns.started_at));
  const states = new Map<string, RunningScheduledTaskState>();
  for (const { id, run } of rows) {
    if (!states.has(id)) {
      states.set(id, { run: run as ActiveRun, startedAt: run.started_at });
    }
  }

  const claims = await drizzleDbRef.current
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.group_folder, group_folder),
        or(
          eq(scheduledTasks.status, 'active'),
          eq(scheduledTasks.status, 'paused'),
        ),
        isNull(scheduledTasks.next_run),
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.scheduled_task_id, scheduledTasks.id),
                or(
                  isNull(scheduledTasks.last_run),
                  gt(activeRuns.started_at, scheduledTasks.last_run),
                ),
              ),
            ),
        ),
      ),
    );
  for (const { id } of claims) {
    if (!states.has(id)) states.set(id, { run: null, startedAt: null });
  }
  return states;
}

export async function getRunningScheduledTaskState(
  id: string,
): Promise<RunningScheduledTaskState | null> {
  const task = await getTaskById(id);
  if (!task) return null;
  return (
    (await getRunningScheduledTaskStatesForGroup(task.group_folder)).get(id) ??
    null
  );
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.status, 'active'),
        isNotNull(scheduledTasks.next_run),
        lte(scheduledTasks.next_run, now),
        // A schedule remains due until finalization advances last_run/next_run.
        // Recovery marks active_runs terminal before that update, so status alone
        // cannot identify an in-flight occurrence. Any run started after the
        // schedule's last finalized run still belongs to the current occurrence.
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.scheduled_task_id, scheduledTasks.id),
                inFlightScheduledRunPredicate(),
              ),
            ),
        ),
      ),
    )
    .orderBy(scheduledTasks.next_run);
  return rows;
}

/** Terminal scheduled runs whose occurrence was never finalized on its schedule. */
export async function getUnfinalizedScheduledRuns(): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select({ run: activeRuns })
    .from(activeRuns)
    .innerJoin(
      scheduledTasks,
      eq(activeRuns.scheduled_task_id, scheduledTasks.id),
    )
    .where(
      and(
        ne(scheduledTasks.status, 'completed'),
        ne(activeRuns.status, 'running'),
        or(
          isNull(scheduledTasks.last_run),
          gt(activeRuns.started_at, scheduledTasks.last_run),
        ),
      ),
    )
    .orderBy(desc(activeRuns.started_at));
  return rows.map(({ run }) => run as ActiveRun);
}

export async function updateScheduledTaskAfterRun(
  id: string,
  next_run: string | null,
  last_result: string,
  expectedOccurrence?: Pick<
    ScheduledTask,
    'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'last_run'
  >,
): Promise<boolean> {
  const now = new Date().toISOString();
  const dueMarker = expectedOccurrence
    ? expectedOccurrence.next_run === null
      ? isNull(scheduledTasks.next_run)
      : or(
          eq(scheduledTasks.next_run, expectedOccurrence.next_run),
          isNull(scheduledTasks.next_run),
        )
    : undefined;
  const statusMarker = expectedOccurrence
    ? expectedOccurrence.status === null
      ? isNull(scheduledTasks.status)
      : expectedOccurrence.status === 'active'
        ? // A pause during the run leaves the claimed row paused with a NULL
          // next_run; the run must still finalize and keep that status.
          or(
            eq(scheduledTasks.status, 'active'),
            and(
              eq(scheduledTasks.status, 'paused'),
              isNull(scheduledTasks.next_run),
            ),
          )
        : eq(scheduledTasks.status, expectedOccurrence.status)
    : undefined;
  // Finalization advances last_run, so a changed last_run means this occurrence
  // was already finalized (and a NULL next_run may be a newer claim): a delayed
  // retry must not write over it.
  const lastRunMarker = expectedOccurrence
    ? expectedOccurrence.last_run
      ? eq(scheduledTasks.last_run, expectedOccurrence.last_run)
      : isNull(scheduledTasks.last_run)
    : undefined;
  const rows = await drizzleDbRef.current
    .update(scheduledTasks)
    .set({
      next_run,
      last_run: now,
      last_result,
      status: next_run === null ? 'completed' : sql`status`,
    })
    .where(
      expectedOccurrence
        ? and(
            eq(scheduledTasks.id, id),
            eq(scheduledTasks.schedule_type, expectedOccurrence.schedule_type),
            eq(
              scheduledTasks.schedule_value,
              expectedOccurrence.schedule_value,
            ),
            statusMarker!,
            dueMarker!,
            lastRunMarker!,
          )
        : eq(scheduledTasks.id, id),
    )
    .returning();
  return rows.length === 1;
}

/** Advance an occurrence that was intentionally skipped without recording a run. */
export async function skipScheduledTaskOccurrence(
  id: string,
  next_run: string | null,
): Promise<void> {
  await drizzleDbRef.current
    .update(scheduledTasks)
    .set({
      next_run,
      status: next_run === null ? 'completed' : sql`status`,
    })
    .where(eq(scheduledTasks.id, id))
    .execute();
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await drizzleDbRef.current
    .insert(taskRunLogs)
    .values({
      task_id: log.task_id,
      run_id: log.run_id ?? null,
      run_at: log.run_at,
      duration_ms: log.duration_ms,
      status: log.status,
      result: log.result,
      error: log.error,
    })
    .execute();
}

export async function hasTaskRunLogForRun(runId: string): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ id: taskRunLogs.id })
    .from(taskRunLogs)
    .where(eq(taskRunLogs.run_id, runId))
    .limit(1);
  return rows.length > 0;
}

export async function getTaskRunLogs(
  task_id: string,
  limit = 10,
): Promise<TaskRunLog[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(taskRunLogs)
    .where(eq(taskRunLogs.task_id, task_id))
    .orderBy(desc(taskRunLogs.run_at))
    .limit(limit);
  return rows.map(
    (row: any): TaskRunLog => ({
      task_id: row.task_id,
      run_id: row.run_id,
      run_at: row.run_at,
      duration_ms: row.duration_ms,
      status: row.status,
      result: row.result,
      error: row.error,
    }),
  );
}

export async function hasRunningScheduledTask(id: string): Promise<boolean> {
  const claimed = await drizzleDbRef.current
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.id, id),
        eq(scheduledTasks.status, 'active'),
        isNull(scheduledTasks.next_run),
      ),
    )
    .limit(1);
  if (claimed.length > 0) return true;
  const rows = await drizzleDbRef.current
    .select({ id: activeRuns.id })
    .from(activeRuns)
    .innerJoin(
      scheduledTasks,
      eq(activeRuns.scheduled_task_id, scheduledTasks.id),
    )
    .where(
      and(
        eq(activeRuns.scheduled_task_id, id),
        inFlightScheduledRunPredicate(),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Finds the occurrence created by a sandbox even if its caller throws before
 * returning the active-run UUID. */
export async function getLatestScheduledRunId(
  id: string,
  startedAtOrAfter: string,
): Promise<string | null> {
  const rows = await drizzleDbRef.current
    .select({ id: activeRuns.id })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.scheduled_task_id, id),
        gte(activeRuns.started_at, startedAtOrAfter),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Canonical scheduled history is task_run_logs, with active-run telemetry
 * attached where the occurrence has a run link. Legacy null links remain. */
export async function getScheduledTaskRuns(taskId: string, limit = 50) {
  const logs = await drizzleDbRef.current
    .select({ log: taskRunLogs, run: activeRuns })
    .from(taskRunLogs)
    .leftJoin(activeRuns, eq(taskRunLogs.run_id, activeRuns.id))
    .where(eq(taskRunLogs.task_id, taskId))
    .orderBy(desc(taskRunLogs.run_at))
    .limit(limit);
  // Keep the newest occurrence visible until its canonical log is inserted.
  // Sandbox completion marks active_runs terminal before the scheduler writes
  // task_run_logs, so filtering only status=running creates a polling gap.
  const pending = await drizzleDbRef.current
    .select({ run: activeRuns })
    .from(activeRuns)
    .innerJoin(
      scheduledTasks,
      eq(activeRuns.scheduled_task_id, scheduledTasks.id),
    )
    .where(
      and(
        eq(activeRuns.scheduled_task_id, taskId),
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(taskRunLogs)
            .where(eq(taskRunLogs.run_id, activeRuns.id)),
        ),
        or(
          eq(activeRuns.status, 'running'),
          isNull(scheduledTasks.last_run),
          gt(activeRuns.started_at, scheduledTasks.last_run),
        ),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return { logs, pending: pending[0]?.run ?? null };
}

export async function getScheduledTaskRunIds(
  taskId: string,
): Promise<string[]> {
  const logRows = await drizzleDbRef.current
    .select({ run_id: taskRunLogs.run_id })
    .from(taskRunLogs)
    .where(and(eq(taskRunLogs.task_id, taskId), isNotNull(taskRunLogs.run_id)));
  // History retention may have removed task_run_logs while active_runs still
  // owns the persisted per-run transcript. Include both ownership sources so
  // later task deletion cannot leave expired-history artifacts orphaned.
  const activeRows = await drizzleDbRef.current
    .select({ run_id: activeRuns.id })
    .from(activeRuns)
    .where(eq(activeRuns.scheduled_task_id, taskId));
  return [
    ...new Set(
      [...logRows, ...activeRows]
        .map((row) => row.run_id)
        .filter((runId): runId is string => !!runId),
    ),
  ];
}
