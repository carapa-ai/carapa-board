import { drizzleDbRef } from '../db/drizzle-client.js';
import {
  activeRuns,
  conversations,
  projects,
  tasks,
  users,
} from '../db/schema.js';
import {
  lockObjectiveShared,
  ObjectiveMoveInProgressError,
  objectiveMovedConversationMessage,
} from '../modules/objectives/db-objectives.js';
import { ActiveRun } from '../modules/kanban/execution/types.js';
import type { TestingRunDecision } from '../modules/kanban/testing.js';
import {
  eq,
  and,
  isNull,
  isNotNull,
  desc,
  gte,
  count,
  inArray,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { refreshObjectiveTaskCostForRun } from '../modules/objectives/objective-task-cost.js';

/**
 * Insert a run row. A run in an objective's conversation, or for a task tagged
 * with an objective, takes that objective's shared lock first, so its insert
 * cannot interleave with a move of the objective: the move either sees the run
 * and refuses, or commits first and the run is refused until the move has
 * finished all its steps. After a completed move, a task run goes ahead (the
 * task stays usable in its project), but a run in a conversation of the
 * objective's former project is refused with an error: old conversations are
 * not continued.
 */
async function withObjectiveRunLock<T>(
  run: ActiveRun,
  insert: (db: any) => PromiseLike<T>,
): Promise<T> {
  const { conversation_id, task_id } = run;
  if (!conversation_id && !task_id) return insert(drizzleDbRef.current);
  return drizzleDbRef.current.transaction(async (tx) => {
    const objectiveIds = new Set<string>();
    let conversationProject: string | undefined;
    let conversationObjectiveId: string | undefined;
    if (conversation_id) {
      const [row] = await tx
        .select({
          objective_id: conversations.objective_id,
          group_folder: conversations.group_folder,
        })
        .from(conversations)
        .where(eq(conversations.id, conversation_id));
      if (row?.objective_id) objectiveIds.add(row.objective_id);
      conversationObjectiveId = row?.objective_id ?? undefined;
      conversationProject = row?.group_folder;
    }
    if (task_id) {
      const [row] = await tx
        .select({ objective_id: tasks.objective_id })
        .from(tasks)
        .where(eq(tasks.id, task_id));
      if (row?.objective_id) objectiveIds.add(row.objective_id);
    }
    // Sorted so two runs locking the same pair cannot wait on each other.
    for (const objectiveId of [...objectiveIds].sort()) {
      const objective = await lockObjectiveShared(tx, objectiveId);
      // A move with steps left (folder, vector store) must finish before the
      // objective runs again; a completed move has no marker.
      if (objective?.move_source_project) {
        throw new ObjectiveMoveInProgressError(objective);
      }
      // Old conversations of a moved objective are not continued: they get an
      // error instead of a run against a folder that is no longer theirs.
      if (
        conversationProject &&
        objective &&
        objective.id === conversationObjectiveId &&
        objective.project_id !== conversationProject
      ) {
        throw new Error(objectiveMovedConversationMessage(objective));
      }
    }
    return insert(tx);
  });
}

export async function insertActiveRun(run: ActiveRun): Promise<void> {
  await withObjectiveRunLock(run, (db) =>
    db.insert(activeRuns).values(run).execute(),
  );
}

/** Atomically claim a deterministic run ID. */
export async function insertActiveRunIfAbsent(
  run: ActiveRun,
): Promise<boolean> {
  const rows = await withObjectiveRunLock<unknown[]>(run, (db) =>
    db
      .insert(activeRuns)
      .values(run)
      .onConflictDoNothing({ target: activeRuns.id })
      .returning(),
  );
  return rows.length === 1;
}

/** Exactly one process may cross the provider-dispatch boundary. */
export async function beginDirectFollowupDispatch(
  id: string,
  conversationId: string,
): Promise<boolean> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const conversationRuns = await tx
      .select({ id: activeRuns.id, stage: activeRuns.stage })
      .from(activeRuns)
      .where(
        and(
          eq(activeRuns.conversation_id, conversationId),
          eq(activeRuns.status, 'running'),
          inArray(activeRuns.stage, [
            'direct-followup:claimed',
            'direct-followup:dispatched',
          ]),
        ),
      )
      .orderBy(activeRuns.id)
      .for('update');
    if (!conversationRuns.some((run) => run.id === id)) return false;
    if (
      conversationRuns.some(
        (run) => run.id !== id && run.stage === 'direct-followup:dispatched',
      )
    ) {
      return false;
    }
    const rows = await tx
      .update(activeRuns)
      .set({
        stage: 'direct-followup:dispatched',
        last_event_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(activeRuns.id, id),
          eq(activeRuns.status, 'running'),
          eq(activeRuns.stage, 'direct-followup:claimed'),
        ),
      )
      .returning();
    return rows.length === 1;
  });
}
/**
 * Atomically finish a follow-up that is still claimed. Winning this update is
 * the reservation: the row is no longer running, so `beginDirectFollowupDispatch`
 * can never cross the provider boundary for it afterwards.
 */
export async function closeClaimedDirectFollowupRun(
  id: string,
  status: 'completed' | 'error',
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .update(activeRuns)
    .set({ status, completed_at: new Date().toISOString() })
    .where(
      and(
        eq(activeRuns.id, id),
        eq(activeRuns.status, 'running'),
        eq(activeRuns.stage, 'direct-followup:claimed'),
      ),
    )
    .returning();
  return rows.length === 1;
}

/** Atomically reserve claimed follow-ups for Stop before provider dispatch. */
export async function stopClaimedDirectFollowupRuns(
  groupFolder: string,
  conversationId: string,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .update(activeRuns)
    .set({
      stage: 'direct-followup:stopping',
      last_event_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(activeRuns.group_folder, groupFolder),
        eq(activeRuns.conversation_id, conversationId),
        eq(activeRuns.status, 'running'),
        inArray(activeRuns.stage, [
          'direct-followup:claimed',
          'direct-followup:stopping',
        ]),
      ),
    )
    .returning();
  return rows as ActiveRun[];
}

export async function getRunningDirectFollowupRuns(
  conversationId?: string,
): Promise<ActiveRun[]> {
  const filters = [
    eq(activeRuns.status, 'running'),
    inArray(activeRuns.stage, [
      'direct-followup:claimed',
      'direct-followup:dispatched',
      'direct-followup:stopping',
    ]),
  ];
  if (conversationId) {
    filters.push(eq(activeRuns.conversation_id, conversationId));
  }
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(and(...filters))
    .orderBy(activeRuns.started_at, activeRuns.id);
  return rows as ActiveRun[];
}

export async function getActiveRunsByStatus(
  status: ActiveRun['status'],
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(eq(activeRuns.status, status))
    .limit(500);
  return rows as ActiveRun[];
}

export async function getActiveRunById(
  id: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(eq(activeRuns.id, id));
  return rows[0] as ActiveRun | undefined;
}

export async function getRunningTaskIds(): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ task_id: activeRuns.task_id })
    .from(activeRuns)
    .where(
      and(eq(activeRuns.status, 'running'), isNotNull(activeRuns.task_id)),
    );
  return [
    ...new Set(
      rows
        .map((r: { task_id: string | null }) => r.task_id!)
        .filter((id: string) => id),
    ),
  ];
}

/** Return running task IDs for one project without a global result cap. */
export async function getRunningTaskIdsForGroup(
  group_folder: string,
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ task_id: activeRuns.task_id })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, group_folder),
        eq(activeRuns.status, 'running'),
        isNotNull(activeRuns.task_id),
      ),
    );
  return rows
    .map((row) => row.task_id)
    .filter((taskId): taskId is string => taskId !== null);
}

export async function getActiveRunForGroup(
  group_folder: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, group_folder),
        eq(activeRuns.status, 'running'),
      ),
    )
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

/**
 * Newest running row on `instance` owned by exactly this execution identity:
 * the task, or (without a task) the conversation / chat jid. Never returns
 * another owner's run that merely shares the instance.
 */
export async function getActiveRunForOwnerInstance(
  group_folder: string,
  instance: string,
  owner: { task_id?: string; conversation_id?: string; chat_jid?: string },
): Promise<ActiveRun | undefined> {
  const ownerFilter = owner.task_id
    ? [eq(activeRuns.task_id, owner.task_id)]
    : [
        isNull(activeRuns.task_id),
        owner.conversation_id
          ? eq(activeRuns.conversation_id, owner.conversation_id)
          : isNull(activeRuns.conversation_id),
        ...(owner.chat_jid ? [eq(activeRuns.chat_jid, owner.chat_jid)] : []),
      ];
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, group_folder),
        eq(activeRuns.sandbox_instance, instance),
        eq(activeRuns.status, 'running'),
        ...ownerFilter,
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

/**
 * Latest running (or recently-running) active run for a given `sandbox_instance`
 * across all groups. Used by the tmux HTTP route to authorize attach requests
 * without first having to know the parent group — the caller passes the
 * instance, the route looks up the row, then checks the user can read the
 * resolved `group_folder`.
 *
 * `running` is the only status we return; finished runs have a different
 * lifecycle and shouldn't be re-attached via this endpoint.
 */
export async function getActiveRunByInstance(
  instance: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.sandbox_instance, instance),
        eq(activeRuns.status, 'running'),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

export async function getActiveChatRunsForConversation(
  group_folder: string,
  conversation_id: string,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, group_folder),
        eq(activeRuns.conversation_id, conversation_id),
        isNull(activeRuns.task_id),
        eq(activeRuns.status, 'running'),
      ),
    )
    .orderBy(desc(activeRuns.started_at));
  return rows as ActiveRun[];
}
/** Return active legacy chat runs identified by project and chat JID. */
export async function getActiveChatRunsForLegacyIdentity(
  group_folder: string,
  chat_jid: string,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, group_folder),
        eq(activeRuns.chat_jid, chat_jid),
        eq(activeRuns.status, 'running'),
        isNull(activeRuns.task_id),
        isNull(activeRuns.conversation_id),
      ),
    )
    .orderBy(desc(activeRuns.started_at));
  return rows as ActiveRun[];
}

/** Return every running web-chat run owned by one managed sandbox instance. */
export async function getActiveChatRunsForSandboxInstance(
  sandbox_instance: string,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.sandbox_instance, sandbox_instance),
        isNull(activeRuns.task_id),
        eq(activeRuns.status, 'running'),
      ),
    )
    .orderBy(desc(activeRuns.started_at));
  return rows as ActiveRun[];
}

export async function getActiveTaskRunsForSandboxInstance(
  sandbox_instance: string,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.sandbox_instance, sandbox_instance),
        isNotNull(activeRuns.task_id),
        eq(activeRuns.status, 'running'),
      ),
    )
    .orderBy(desc(activeRuns.started_at));
  return rows as ActiveRun[];
}

/** Every running chat (non-task) run of a project, newest first. */
export async function getActiveChatRunsForGroup(
  group_folder: string,
  chat_jid?: string,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, group_folder),
        isNull(activeRuns.task_id),
        eq(activeRuns.status, 'running'),
        ...(chat_jid ? [eq(activeRuns.chat_jid, chat_jid)] : []),
      ),
    )
    .orderBy(desc(activeRuns.started_at));
  return rows as ActiveRun[];
}

export async function getActiveRunForTask(
  task_id: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(eq(activeRuns.task_id, task_id), eq(activeRuns.status, 'running')),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

/**
 * Latest running run for a given conversation, regardless of whether it was
 * task- or chat-driven. Used by the public active-run lookup endpoint to
 * resolve (stack, service, instance) from a conversation_id without first
 * having to know whether the run is task- or chat-scoped.
 */
export async function getActiveRunForConversation(
  conversation_id: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.conversation_id, conversation_id),
        eq(activeRuns.status, 'running'),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

export async function getLastActiveRunForTask(
  task_id: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(eq(activeRuns.task_id, task_id))
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

export async function getLastRunForStages(
  task_id: string,
  stages: string[],
): Promise<ActiveRun | undefined> {
  if (stages.length === 0) return undefined;
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(eq(activeRuns.task_id, task_id), inArray(activeRuns.stage, stages)),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

export interface RunTokenStats {
  result?: string | null;
  total_tokens?: number;
  tok_output?: number;
  tok_input?: number;
  inputTokenSemantics?: 'fresh' | 'total';
  tok_cache_write?: number;
  tok_cache_read?: number;
  tok_context_last?: number;
  tok_reasoning?: number;
  model_name?: string;
  /** Where the normalized token counts came from. */
  usageSource?: 'reported' | 'estimated';
  /** Provider usage payload before normalization, when one was emitted. */
  rawUsage?: Record<string, number>;
  /** Prompt-cache lifetime the provider applied to the run's last cache write. */
  cache_ttl_s?: number;
  tool_usage_count?: number;
  cost_usd?: number;
  prompt_dispatched_at_ms?: number;
  first_output_at_ms?: number;
  time_to_first_output_ms?: number;
}

export async function completeActiveRun(
  id: string,
  status: ActiveRun['status'],
  stats?: RunTokenStats,
  sessionId?: string,
): Promise<void> {
  // A stat-less error/stalled write is a late failure signal (stall catch,
  // kill paths). It may only finalize a row that is still running; it must not
  // overwrite a terminal row or null out the cost/tokens/result it persisted.
  const lateFailureWithoutStats =
    !stats && (status === 'error' || status === 'stalled');
  await drizzleDbRef.current
    .update(activeRuns)
    .set({
      status,
      completed_at: new Date().toISOString(),
      ...(stats
        ? {
            tok_total: stats.total_tokens ?? null,
            tool_usage_count: stats.tool_usage_count ?? null,
            cost_usd: stats.cost_usd ?? null,
            result: stats.result ?? null,
          }
        : {}),
      // Record the session this run actually used/produced so a later run can
      // resume this stage's own session (Run History is the per-stage source of
      // truth). Fresh runs are inserted with session_id=null; fill it here.
      ...(sessionId ? { session_id: sessionId } : {}),
    })
    .where(
      lateFailureWithoutStats
        ? and(eq(activeRuns.id, id), eq(activeRuns.status, 'running'))
        : eq(activeRuns.id, id),
    )
    .execute();
  if (stats?.cost_usd != null) {
    await refreshObjectiveTaskCostForRun(id);
  }
}

/**
 * Associate an observed native session with the exact task run that emitted it
 * and advance the task's live cursor in the same transaction.
 *
 * The run ID is the execution generation guard: callers must keep that
 * generation reserved until this write settles so an older callback cannot
 * advance the cursor after a newer task run starts.
 */
export async function persistTaskSessionForActiveRun(
  runId: string,
  taskId: string,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId.trim()) return false;
  return drizzleDbRef.current.transaction(async (tx) => {
    const ownedRuns = await tx
      .update(activeRuns)
      .set({ session_id: sessionId })
      .where(and(eq(activeRuns.id, runId), eq(activeRuns.task_id, taskId)))
      .returning();
    if (ownedRuns.length === 0) return false;
    await tx
      .update(tasks)
      .set({ session_id: sessionId })
      .where(eq(tasks.id, taskId))
      .execute();
    return true;
  });
}

export interface RestartRecoveryReservation {
  run: ActiveRun;
  created: boolean;
}

/** Persist that a reserved restart continuation crossed the harness boundary. */
export async function markRestartRecoveryRunDispatched(
  id: string,
  interruptedRunId: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .update(activeRuns)
    .set({ restart_recovery_dispatched_at: new Date().toISOString() })
    .where(
      and(
        eq(activeRuns.id, id),
        eq(activeRuns.status, 'running'),
        eq(activeRuns.restart_recovery_of_run_id, interruptedRunId),
        isNull(activeRuns.restart_recovery_dispatched_at),
      ),
    )
    .returning();
  return rows.length === 1;
}

/**
 * Durably reserve the only continuation allowed for an interrupted task run.
 *
 * The replacement row is the outbox record: it is committed before the Board
 * schedules any asynchronous setup, and the unique predecessor index makes a
 * repeated boot observe the same reservation instead of creating another
 * continuation. Retiring the predecessor in this transaction leaves no task
 * admission gap.
 */
export async function reserveRestartRecoveryRun(input: {
  interruptedRunId: string;
  replacement: ActiveRun;
  taskId: string;
  stageId: string;
  sessionId: string;
  sessionAgentKey: string;
  model: string | null;
  runtimeVariant: string;
}): Promise<RestartRecoveryReservation | null> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [interrupted] = await tx
      .select()
      .from(activeRuns)
      .where(eq(activeRuns.id, input.interruptedRunId))
      .for('update');
    const [existing] = await tx
      .select()
      .from(activeRuns)
      .where(eq(activeRuns.restart_recovery_of_run_id, input.interruptedRunId))
      .limit(1);
    if (existing) {
      return { run: existing as ActiveRun, created: false };
    }
    if (
      !interrupted ||
      interrupted.status !== 'running' ||
      interrupted.task_id !== input.taskId ||
      interrupted.stage !== input.stageId ||
      interrupted.session_id !== input.sessionId ||
      (interrupted.session_agent_key || interrupted.agent_name) !==
        input.sessionAgentKey ||
      interrupted.model !== input.model ||
      interrupted.runtime_variant !== input.runtimeVariant
    ) {
      return null;
    }

    const competing = await tx
      .select({ id: activeRuns.id })
      .from(activeRuns)
      .where(
        and(
          eq(activeRuns.task_id, input.taskId),
          eq(activeRuns.status, 'running'),
          ne(activeRuns.id, input.interruptedRunId),
        ),
      )
      .limit(1);
    if (competing.length > 0) return null;

    const [replacement] = await tx
      .insert(activeRuns)
      .values({
        ...input.replacement,
        restart_recovery_of_run_id: input.interruptedRunId,
        restart_recovery_dispatched_at: null,
      })
      .returning();
    const retired = await tx
      .update(activeRuns)
      .set({
        status: 'error',
        completed_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(activeRuns.id, input.interruptedRunId),
          eq(activeRuns.status, 'running'),
        ),
      )
      .returning();
    if (retired.length !== 1) {
      throw new Error(
        `Restart recovery predecessor ${input.interruptedRunId} changed during reservation`,
      );
    }
    return { run: replacement as ActiveRun, created: true };
  });
}

/**
 * Session id of the most recent run for this task in a given stage, run by the
 * same session-compatible runtime. Used to resume a stage's own session when
 * re-entering it.
 * Returns undefined when the newest compatible run does not own a session;
 * an older session must not bypass a newer unresumable run.
 */
export async function getLastRunSessionForStage(
  task_id: string,
  stage: string,
  session_agent_keys: string | readonly string[],
): Promise<string | undefined> {
  const compatibleKeys = [
    ...new Set(
      (Array.isArray(session_agent_keys)
        ? session_agent_keys
        : [session_agent_keys]
      ).filter(Boolean),
    ),
  ];
  if (compatibleKeys.length === 0) return undefined;
  const rows = await drizzleDbRef.current
    .select({ session_id: activeRuns.session_id })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.task_id, task_id),
        eq(activeRuns.stage, stage),
        or(
          inArray(activeRuns.session_agent_key, compatibleKeys),
          and(
            isNull(activeRuns.session_agent_key),
            inArray(activeRuns.agent_name, compatibleKeys),
          ),
        ),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  const sid = rows[0]?.session_id;
  return sid ? String(sid) : undefined;
}

/**
 * The session agent key that owns the newest session of `stage` on `task_id`:
 * the run whose native session a resumed run would continue. Undefined when no
 * run in the stage has a session.
 */
export async function getLastStageSessionOwner(
  task_id: string,
  stage: string,
): Promise<string | undefined> {
  const rows = await drizzleDbRef.current
    .select({
      session_agent_key: activeRuns.session_agent_key,
      agent_name: activeRuns.agent_name,
    })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.task_id, task_id),
        eq(activeRuns.stage, stage),
        isNotNull(activeRuns.session_id),
        ne(activeRuns.session_id, ''),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  const row = rows[0];
  return row
    ? (row.session_agent_key ?? row.agent_name ?? undefined)
    : undefined;
}

export async function updateRunStats(
  id: string,
  stats: RunTokenStats,
): Promise<void> {
  const tok_total =
    stats.tok_input != null ||
    stats.tok_output != null ||
    stats.tok_cache_write != null
      ? (stats.tok_input ?? 0) +
        (stats.tok_output ?? 0) +
        (stats.tok_cache_write ?? 0)
      : (stats.total_tokens ?? null);
  await drizzleDbRef.current
    .update(activeRuns)
    .set({
      tok_total,
      tok_output: stats.tok_output ?? null,
      tok_input: stats.tok_input ?? null,
      tok_cache_write: stats.tok_cache_write ?? null,
      tok_cache_read: stats.tok_cache_read ?? null,
      tok_context_last: stats.tok_context_last ?? null,
      model_name: stats.model_name ?? null,
      tool_usage_count: stats.tool_usage_count ?? null,
      cost_usd: stats.cost_usd ?? null,
    })
    .where(eq(activeRuns.id, id))
    .execute();
  if (stats.cost_usd != null) {
    await refreshObjectiveTaskCostForRun(id);
  }
}

export async function updateLastEventAt(
  id: string,
  isoNow: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(activeRuns)
    .set({ last_event_at: isoNow })
    .where(eq(activeRuns.id, id))
    .execute();
}

/** Record the structured verdict score for the exact review execution. */
export async function updateActiveRunReviewScore(
  id: string,
  reviewScore: number,
): Promise<void> {
  await drizzleDbRef.current
    .update(activeRuns)
    .set({ reviewScore })
    .where(eq(activeRuns.id, id))
    .execute();
}

/** Record the structured verdict of the exact testing execution. */
export async function updateActiveRunTestingDecision(
  id: string,
  testingDecision: TestingRunDecision,
): Promise<void> {
  await drizzleDbRef.current
    .update(activeRuns)
    .set({ testingDecision })
    .where(eq(activeRuns.id, id))
    .execute();
}

export async function getRunsForTask(
  task_id: string,
  limit = 50,
): Promise<ActiveRun[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(eq(activeRuns.task_id, task_id))
    .orderBy(desc(activeRuns.started_at))
    .limit(limit);
  const userIds = [
    ...new Set(
      rows
        .map((row) => row.triggeredByUserId)
        .filter((id): id is string => !!id),
    ),
  ];
  const userRows = userIds.length
    ? await drizzleDbRef.current
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const byId = new Map(userRows.map((user) => [user.id, user]));
  return rows.map((row) => ({
    ...row,
    trigger: {
      user: row.triggeredByUserId
        ? (byId.get(row.triggeredByUserId) ?? null)
        : null,
      source: row.triggerSource ?? 'system',
      triggeredAt: row.started_at,
    },
  })) as ActiveRun[];
}

export async function getRunCountForTask(task_id: string): Promise<number> {
  const rows = await drizzleDbRef.current
    .select({ total: count() })
    .from(activeRuns)
    .where(eq(activeRuns.task_id, task_id));
  return Number(rows[0]?.total ?? 0);
}

/** Return the newest persisted scored review run without the history-page cap. */
export async function getLatestScoredReviewRunForTask(
  task_id: string,
): Promise<ActiveRun | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(activeRuns)
    .where(
      and(eq(activeRuns.task_id, task_id), isNotNull(activeRuns.reviewScore)),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(1);
  return rows[0] as ActiveRun | undefined;
}

export interface TaskRunStageDuration {
  stageId: string | null;
  completedDurationMs: number;
  runningStartedAt: string[];
  /** Live duration at the reference time supplied to the query. */
  runningDurationMs: number;
  /** Server clock instant at which runningDurationMs was measured. */
  runningReferenceAt: string;
  /** Summed cost of completed runs; null when none of them was priced. */
  costUsd: number | null;
}

const validTimestamp = (column: any) => sql`
  ${column} ~ '^(000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-](0[0-9]|1[0-3]):[0-5][0-9]|[+-]14:00)$'
  AND CASE
    WHEN substring(${column} from 6 for 2)::int IN (1, 3, 5, 7, 8, 10, 12)
      THEN substring(${column} from 9 for 2)::int <= 31
    WHEN substring(${column} from 6 for 2)::int IN (4, 6, 9, 11)
      THEN substring(${column} from 9 for 2)::int <= 30
    ELSE substring(${column} from 9 for 2)::int <= CASE
      WHEN substring(${column} from 1 for 4)::int % 4 = 0
        AND (substring(${column} from 1 for 4)::int % 100 <> 0
          OR substring(${column} from 1 for 4)::int % 400 = 0)
        THEN 29
      ELSE 28
    END
  END
`;

/** Parse the timestamp format persisted by active runs without allowing
 * Date.parse to normalize invalid calendar dates (for example, Feb 30). */
function parseValidRunTimestamp(value: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-](0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return undefined;
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > daysInMonth[month - 1]) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Aggregate every completed execution for a task by its recorded stage. The
 * running rows are fetched separately because they need their timestamps for
 * the UI's live clock, while completed history should remain a DB aggregate.
 */
export async function getTaskRunStageDurations(
  task_id: string,
  referenceAt: Date | string = new Date(),
): Promise<TaskRunStageDuration[]> {
  const referenceDate =
    referenceAt instanceof Date
      ? referenceAt
      : new Date(parseValidRunTimestamp(referenceAt) ?? Date.now());
  const referenceIso = referenceDate.toISOString();
  const completedRows = await drizzleDbRef.current
    .select({
      stageId: activeRuns.stage,
      completedDurationMs: sql<number>`COALESCE(SUM(CASE
        WHEN ${validTimestamp(activeRuns.started_at)}
          AND ${validTimestamp(activeRuns.completed_at)}
        THEN GREATEST(
          0,
          EXTRACT(EPOCH FROM (
            (${activeRuns.completed_at})::timestamptz -
            (${activeRuns.started_at})::timestamptz
          )) * 1000
        )
        ELSE 0
      END), 0)`,
      costUsd: sql<number | null>`SUM(${activeRuns.cost_usd})`,
    })
    .from(activeRuns)
    .where(
      and(eq(activeRuns.task_id, task_id), isNotNull(activeRuns.completed_at)),
    )
    .groupBy(activeRuns.stage);
  const runningRows = await drizzleDbRef.current
    .select({ stageId: activeRuns.stage, startedAt: activeRuns.started_at })
    .from(activeRuns)
    .where(
      and(eq(activeRuns.task_id, task_id), eq(activeRuns.status, 'running')),
    );
  const nowMs = referenceDate.getTime();
  const aggregates = new Map<string | null, TaskRunStageDuration>();

  for (const row of completedRows) {
    aggregates.set(row.stageId, {
      stageId: row.stageId,
      completedDurationMs: Math.max(0, Number(row.completedDurationMs) || 0),
      runningStartedAt: [],
      runningDurationMs: 0,
      runningReferenceAt: referenceIso,
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
    });
  }
  for (const row of runningRows) {
    const aggregate = aggregates.get(row.stageId) ?? {
      stageId: row.stageId,
      completedDurationMs: 0,
      runningStartedAt: [],
      runningDurationMs: 0,
      runningReferenceAt: referenceIso,
      costUsd: null,
    };
    aggregate.runningStartedAt.push(row.startedAt);
    const startedAtMs = parseValidRunTimestamp(row.startedAt);
    const duration = startedAtMs === undefined ? 0 : nowMs - startedAtMs;
    aggregate.runningDurationMs +=
      Number.isFinite(duration) && duration > 0 ? duration : 0;
    aggregates.set(row.stageId, aggregate);
  }

  return [...aggregates.values()];
}

export async function getRunCostRowsSince(startedAt: string) {
  return drizzleDbRef.current
    .select({
      id: activeRuns.id,
      status: activeRuns.status,
      tokInput: activeRuns.tok_input,
      tokOutput: activeRuns.tok_output,
      groupFolder: activeRuns.group_folder,
      taskId: activeRuns.task_id,
      conversationId: activeRuns.conversation_id,
      scheduledTaskId: activeRuns.scheduled_task_id,
      startedAt: activeRuns.started_at,
      stage: activeRuns.stage,
      taskCompletedAt: tasks.completed_at,
      taskStartedAt: tasks.started_at,
      taskCreatedAt: tasks.created_at,
      agentName: activeRuns.agent_name,
      model: activeRuns.model,
      modelName: activeRuns.model_name,
      costUsd: activeRuns.cost_usd,
    })
    .from(activeRuns)
    .leftJoin(tasks, eq(activeRuns.task_id, tasks.id))
    .where(and(gte(activeRuns.started_at, startedAt)))
    .orderBy(desc(activeRuns.started_at));
}

export async function getProjectHierarchyRows() {
  return drizzleDbRef.current
    .select({ id: projects.id, parentId: projects.parentId })
    .from(projects);
}
