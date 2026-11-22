import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  activeRuns,
  conversations,
  cronjobs,
  datasetTasks,
  memories,
  memoryEvidenceCertificates,
  memoryTranscriptEvidence,
  objectives,
  tasks,
} from '../../db/schema.js';
import { eq, and, inArray, isNotNull, lte, ne } from 'drizzle-orm';
import { Objective } from './types.js';

function generateObjectiveId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `obj-${Date.now()}-${rand}`;
}

function rowToObjective(row: any): Objective {
  return {
    ...row,
    priority: Number(row.priority),
    progress: Number(row.progress),
    trigger_config: row.trigger_config
      ? JSON.parse(String(row.trigger_config))
      : null,
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : null,
    eventRuntimeSelection:
      typeof row.eventRuntimeSelection === 'string'
        ? JSON.parse(row.eventRuntimeSelection)
        : (row.eventRuntimeSelection ?? null),
    cost_limit_usd:
      row.cost_limit_usd == null ? null : Number(row.cost_limit_usd),
  } as Objective;
}

export async function createObjective(
  data: Omit<Objective, 'id' | 'created_at' | 'updated_at'>,
): Promise<Objective> {
  const id = generateObjectiveId();
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(objectives)
    .values({
      id,
      project_id: data.project_id,
      title: data.title,
      description: data.description ?? '',
      status: data.status ?? 'draft',
      priority: data.priority ?? 0,
      deadline: data.deadline ?? null,
      progress: data.progress ?? 0,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      trigger_config: data.trigger_config
        ? JSON.stringify(data.trigger_config)
        : null,
      eventRuntimeSelection: data.eventRuntimeSelection ?? null,
      work_dir: data.work_dir ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { ...data, id, created_at: now, updated_at: now };
}

export async function getObjective(id: string): Promise<Objective | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(objectives)
    .where(eq(objectives.id, id));
  return rows[0] ? rowToObjective(rows[0]) : undefined;
}

/** Status of each existing objective by id, regardless of owning project. */
export async function getObjectiveStatusesByIds(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const distinctIds = [...new Set(ids)];
  if (distinctIds.length === 0) return new Map();
  const rows = await drizzleDbRef.current
    .select({ id: objectives.id, status: objectives.status })
    .from(objectives)
    .where(inArray(objectives.id, distinctIds));
  return new Map(rows.map((row) => [row.id, String(row.status)]));
}

/**
 * Id, title and status of every objective that a project's tasks, cronjobs or
 * dataset tasks reference, including objectives owned by a parent project.
 */
export async function getReferencedObjectiveSummaries(
  project_id: string,
): Promise<Array<{ id: string; title: string; status: string }>> {
  const db = drizzleDbRef.current;
  const [fromTasks, fromCronjobs, fromDatasets] = await Promise.all([
    db
      .selectDistinct({ id: tasks.objective_id })
      .from(tasks)
      .where(
        and(eq(tasks.project_id, project_id), isNotNull(tasks.objective_id)),
      ),
    db
      .selectDistinct({ id: cronjobs.objective_id })
      .from(cronjobs)
      .where(
        and(
          eq(cronjobs.project_id, project_id),
          isNotNull(cronjobs.objective_id),
        ),
      ),
    db
      .selectDistinct({ id: datasetTasks.objective_id })
      .from(datasetTasks)
      .where(
        and(
          eq(datasetTasks.project_id, project_id),
          isNotNull(datasetTasks.objective_id),
        ),
      ),
  ]);
  const ids = [
    ...new Set(
      [...fromTasks, ...fromCronjobs, ...fromDatasets].map((row) => row.id!),
    ),
  ];
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: objectives.id,
      title: objectives.title,
      status: objectives.status,
    })
    .from(objectives)
    .where(inArray(objectives.id, ids));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: String(row.status),
  }));
}

export async function getObjectivesByProject(
  project_id: string,
): Promise<Objective[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(objectives)
    .where(eq(objectives.project_id, project_id))
    .orderBy(objectives.priority, objectives.created_at)
    .limit(500);
  return rows.map(rowToObjective);
}

export async function updateObjective(
  id: string,
  data: Partial<Omit<Objective, 'id' | 'project_id' | 'created_at'>>,
): Promise<Objective | undefined> {
  const setObj: any = {};
  const allowed = [
    'title',
    'description',
    'status',
    'priority',
    'deadline',
    'progress',
    'trigger_config',
    'metadata',
    'eventRuntimeSelection',
    'work_dir',
  ] as const;

  for (const key of allowed) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
    const val =
      (data as any)[snakeKey] !== undefined
        ? (data as any)[snakeKey]
        : (data as any)[key];
    if (val !== undefined) {
      if (key === 'metadata' || key === 'trigger_config') {
        setObj[key] = val ? JSON.stringify(val) : null;
      } else {
        setObj[key] = val ?? null;
      }
    }
  }

  if (Object.keys(setObj).length === 0) return getObjective(id);

  setObj.updated_at = new Date().toISOString();

  await drizzleDbRef.current
    .update(objectives)
    .set(setObj)
    .where(eq(objectives.id, id))
    .execute();
  return getObjective(id);
}

/** User-facing API only: this field is deliberately excluded from updateObjective. */
export async function updateObjectiveCostLimit(
  id: string,
  costLimitUsd: number | null,
): Promise<Objective | undefined> {
  await drizzleDbRef.current
    .update(objectives)
    .set({
      cost_limit_usd: costLimitUsd,
      updated_at: new Date().toISOString(),
    })
    .where(eq(objectives.id, id))
    .execute();
  return getObjective(id);
}

/** What decides whether an objective may be moved, read from one snapshot. */
export interface ObjectiveMoveState {
  status: string;
  /** Project an earlier, unfinished move started from. */
  moveSourceProject: string | null;
  /** Cronjobs and dataset tasks (archived ones included) that reference it. */
  cronjobIds: string[];
  datasetTaskIds: string[];
  /** A run is active in one of its conversations or for a task tagged with it. */
  runActive: boolean;
}

type DbReader = Pick<typeof drizzleDbRef.current, 'select'>;

export async function getObjectiveMoveState(
  objective_id: string,
  db: DbReader = drizzleDbRef.current,
): Promise<ObjectiveMoveState | undefined> {
  const [objectiveRows, cronjobRows, datasetRows, runRows, taskRunRows] =
    await Promise.all([
      db
        .select({
          status: objectives.status,
          moveSourceProject: objectives.move_source_project,
        })
        .from(objectives)
        .where(eq(objectives.id, objective_id)),
      db
        .select({ id: cronjobs.id })
        .from(cronjobs)
        .where(eq(cronjobs.objective_id, objective_id)),
      db
        .select({ id: datasetTasks.id })
        .from(datasetTasks)
        .where(eq(datasetTasks.objective_id, objective_id)),
      db
        .select({ id: activeRuns.id })
        .from(activeRuns)
        .innerJoin(
          conversations,
          eq(activeRuns.conversation_id, conversations.id),
        )
        .where(
          and(
            eq(conversations.objective_id, objective_id),
            eq(activeRuns.status, 'running'),
          ),
        )
        .limit(1),
      db
        .select({ id: activeRuns.id })
        .from(activeRuns)
        .innerJoin(tasks, eq(activeRuns.task_id, tasks.id))
        .where(
          and(
            eq(tasks.objective_id, objective_id),
            eq(activeRuns.status, 'running'),
          ),
        )
        .limit(1),
    ]);
  if (!objectiveRows[0]) return undefined;
  return {
    status: String(objectiveRows[0].status),
    moveSourceProject: objectiveRows[0].moveSourceProject,
    cronjobIds: cronjobRows.map((row) => row.id),
    datasetTaskIds: datasetRows.map((row) => row.id),
    runActive: runRows.length > 0 || taskRunRows.length > 0,
  };
}

/** Record that every step of a move has finished. */
export async function clearObjectiveMoveSource(
  objective_id: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(objectives)
    .set({ move_source_project: null })
    .where(eq(objectives.id, objective_id));
}

/**
 * Why a conversation cannot run its objective any more: the objective was
 * moved to another project and this conversation is still in the old one.
 */
export function objectiveMovedConversationMessage(
  objective: Pick<Objective, 'id' | 'title' | 'project_id'>,
): string {
  return `Objective "${objective.title}" (${objective.id}) was moved to project "${objective.project_id}". This conversation stays in its original project and cannot be continued; start a new chat on the objective in "${objective.project_id}".`;
}

/** Thrown instead of starting work on an objective whose move has steps left. */
export class ObjectiveMoveInProgressError extends Error {
  constructor(
    objective: Pick<Objective, 'id' | 'title' | 'move_source_project'>,
  ) {
    super(
      `Objective "${objective.title}" (${objective.id}) is still being moved from project "${objective.move_source_project}", so it is not ready. Repeat the move to finish it, then try again.`,
    );
  }
}

/**
 * Take a shared row lock on an objective inside the caller's transaction. An
 * objective move holds the row `FOR UPDATE`, so a writer that locked first
 * finishes before the move reads its preconditions, and one that comes later
 * waits for the move to commit. Returns the locked row's owner and move marker.
 */
export async function lockObjectiveShared(
  tx: DbReader,
  objective_id: string,
): Promise<
  | Pick<Objective, 'id' | 'title' | 'project_id' | 'move_source_project'>
  | undefined
> {
  const [row] = await tx
    .select({
      id: objectives.id,
      title: objectives.title,
      project_id: objectives.project_id,
      move_source_project: objectives.move_source_project,
    })
    .from(objectives)
    .where(eq(objectives.id, objective_id))
    .for('share');
  return row;
}

/**
 * For writers that attach work to an objective of their own project (cronjobs,
 * dataset tasks): lock it, then check it still belongs to `project_id`. A
 * missing objective is left to the caller's own validation.
 */
export async function assertObjectiveInProjectShared(
  tx: DbReader,
  objective_id: string,
  project_id: string,
): Promise<void> {
  const objective = await lockObjectiveShared(tx, objective_id);
  if (objective && objective.project_id !== project_id) {
    throw new Error(
      `Objective "${objective_id}" belongs to project "${objective.project_id}", not "${project_id}"`,
    );
  }
}

/** IDs of every memory version (superseded and invalidated included) owned by an objective. */
export async function getObjectiveMemoryIds(
  objective_id: string,
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ id: memories.id })
    .from(memories)
    .where(eq(memories.objective_id, objective_id));
  return rows.map((row) => row.id);
}

/**
 * Re-home an objective and all of its memories in one transaction: the
 * objective row, every memory version, and the sidecar rows that carry a
 * project (transcript evidence, evidence certificates). `memory_history_apply_operations`
 * is deliberately left alone: its rows are receipts of a project-level History
 * Review manifest (keyed by manifest and operation index, with no memory or
 * objective column), and `prepareHistoryApplyReceipts` rejects a manifest whose
 * receipts do not all carry the applying project. Re-pointing some of them
 * would break resuming that manifest in the source project. Memory IDs,
 * `objective_id` and timestamps are kept. `assertUnchanged` runs before the
 * commit; throwing from it rolls everything back. The source project is
 * recorded on the objective (`move_source_project`) until every later step has
 * finished, so a repeated move call can complete them. The objective row is locked
 * first and `assertMovable` re-checks its status, schedule references and chat
 * runs inside the transaction, so a refused condition cannot be committed.
 */
export async function moveObjectiveToProject(
  objective_id: string,
  source_project: string,
  target_project: string,
  work_dir: string,
  assertMovable: (state: ObjectiveMoveState | undefined) => void,
  assertUnchanged: () => void,
): Promise<{ objective: Objective | undefined; memoryIds: string[] }> {
  const memoryIds = await drizzleDbRef.current.transaction(async (tx) => {
    await tx
      .select({ id: objectives.id })
      .from(objectives)
      .where(eq(objectives.id, objective_id))
      .for('update');
    const state = await getObjectiveMoveState(objective_id, tx);
    assertMovable(state);
    await tx
      .update(objectives)
      .set({
        project_id: target_project,
        work_dir,
        move_source_project: source_project,
        updated_at: new Date().toISOString(),
      })
      .where(eq(objectives.id, objective_id));
    const moved = await tx
      .update(memories)
      .set({ group_folder: target_project })
      .where(eq(memories.objective_id, objective_id))
      .returning();
    const ids = moved.map((row) => row.id);
    if (ids.length > 0) {
      await tx
        .update(memoryTranscriptEvidence)
        .set({ projectId: target_project })
        .where(inArray(memoryTranscriptEvidence.memoryId, ids));
      await tx
        .update(memoryEvidenceCertificates)
        .set({ project_id: target_project })
        .where(inArray(memoryEvidenceCertificates.memory_id, ids));
    }
    assertUnchanged();
    return ids;
  });
  return { objective: await getObjective(objective_id), memoryIds };
}

/** A chat of an objective, as needed to move its transcript. */
export interface ObjectiveConversationRef {
  id: string;
  group_folder: string;
  created_at: string;
}

/** Chats tagged with an objective that sit in a project other than `project_id`. */
export async function getObjectiveConversationsOutside(
  objective_id: string,
  project_id: string,
): Promise<ObjectiveConversationRef[]> {
  return drizzleDbRef.current
    .select({
      id: conversations.id,
      group_folder: conversations.group_folder,
      created_at: conversations.created_at,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.objective_id, objective_id),
        ne(conversations.group_folder, project_id),
      ),
    )
    .orderBy(conversations.created_at);
}

/** Whether any of the chats has a run in progress. */
export async function hasRunningRunInConversations(
  conversation_ids: string[],
): Promise<boolean> {
  if (conversation_ids.length === 0) return false;
  const rows = await drizzleDbRef.current
    .select({ id: activeRuns.id })
    .from(activeRuns)
    .where(
      and(
        inArray(activeRuns.conversation_id, conversation_ids),
        eq(activeRuns.status, 'running'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Re-home one chat; a no-op when it is no longer in `from_project`. */
export async function moveConversationToProject(
  conversation_id: string,
  from_project: string,
  to_project: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(conversations)
    .set({ group_folder: to_project })
    .where(
      and(
        eq(conversations.id, conversation_id),
        eq(conversations.group_folder, from_project),
      ),
    );
}

/** Atomically pause an over-budget objective and all of its active cronjobs. */
export async function pauseObjectiveIfCostLimitReached(
  id: string,
  totalCostUsd: number,
): Promise<Objective | undefined> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const rows = await tx
      .update(objectives)
      .set({
        status: 'paused',
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(objectives.id, id),
          eq(objectives.status, 'active'),
          isNotNull(objectives.cost_limit_usd),
          lte(objectives.cost_limit_usd, totalCostUsd),
        ),
      )
      .returning();
    if (!rows[0]) return undefined;

    await tx
      .update(cronjobs)
      .set({ status: 'paused' })
      .where(and(eq(cronjobs.objective_id, id), eq(cronjobs.status, 'active')));
    return rowToObjective(rows[0]);
  });
}

export async function deleteObjective(id: string): Promise<void> {
  await drizzleDbRef.current
    .delete(objectives)
    .where(eq(objectives.id, id))
    .execute();
}
