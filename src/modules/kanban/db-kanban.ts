import { randomUUID } from 'crypto';
import {
  drizzleDbRef,
  executeRows,
  isPostgresDatabase,
} from '../../db/drizzle-client.js';
import {
  projects,
  tasks,
  externalIssueImports,
  activeRuns,
  agentAsks,
  cronjobs,
  datasetTasks,
  // chatMessages removed (chat_messages retirement): the JSONL transcript is
  // the canonical chat store. The DB table is on its way out and `db-kanban`
  // no longer reads or writes it directly.
  conversations,
  scheduledTasks,
  memories,
  objectives,
  taskMessages,
  taskRunLogs,
  taskBoardEvents,
  stageEntryEvents,
  objectiveTaskEventHolds,
  projectMembers,
  projectMemberKanbanAcknowledgements,
  externalRunCosts,
  fileFavoriteMoves,
  fileFavorites,
  knowledgeBaseShares,
  memoryAudits,
  memoryAuditItems,
  memoryEvidenceCertificates,
  memoryHistoryApplyOperations,
  memoryReflectorRuns,
  memoryTranscriptEvidence,
  proposals,
  pendingGraphErasures,
  memoryPrivacyErasureMarks,
  pendingMemoryErasures,
  conversationMembers,
  nowDismissals,
  notificationPayloads,
  users,
} from '../../db/schema.js';
import {
  eq,
  and,
  desc,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  sql,
  notExists,
  exists,
  lte,
  or,
  ne,
  gte,
  lt,
  count,
  asc,
} from 'drizzle-orm';
import {
  Task,
  TaskSummary,
  Cronjob,
  DatasetTask,
  StageDefinition,
  StageEntryEvent,
  StageEntryLifecycleNotification,
} from './types.js';
import {
  MAX_AUTOMATIC_RECOVERY_RUNS,
  REJECTION_CAP_BASE_KEY,
} from './review.js';
import { withStoredPipelineOwnedValues } from './pipeline-owned-values.js';
import { isRecord } from '../../lib/type-guards.js';
import type {
  ProjectModeStatus,
  ProjectsStatusSummary,
  ReviewFeedback,
} from '../../types.js';
import type { ActiveRun } from './execution/types.js';
import { Objective } from '../objectives/types.js';
import { assertObjectiveInProjectShared } from '../objectives/db-objectives.js';
import { logger } from '../../logger.js';
import { ATTENTION_WINDOW_MS } from '../chat/db-chats.js';
import {
  REPLAY_VISIBLE_FIELDS,
  replaySnapshotChanged,
  replayTaskSnapshot,
} from './board-replay.js';
import { classifyTaskFailure } from './failure-class.js';
import {
  DEFAULT_STAGES,
  findStage,
  getFailedStage,
  getGroupStages,
  getInitialStage,
  isFailedStage,
  getTestingBlockedStage,
  isQuestionStage,
  isRecoveryHookStage,
  isStageAlternativeId,
} from './stages.js';
import {
  getGroupByFolder,
  PENDING_FINALIZATION_KEY,
} from '../../state-manager.js';
import {
  broadcast,
  migrateProjectAccessCache,
} from '../objectives/ws-events.js';

function generateTaskId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `task-${Date.now()}-${rand}`;
}

function parseStoredRuntimeSelection(value: unknown): unknown | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseTask(row: any): Task | undefined {
  if (!row) return undefined;
  row = { ...row };

  // Internal dataset restart generation; DB mutations use it directly, but it
  // is not part of the task API model.
  delete row.dataset_generation;

  const rawDeps = row.depends_on_ids;
  if (typeof rawDeps === 'string') {
    try {
      row.depends_on_ids = JSON.parse(rawDeps);
    } catch {
      row.depends_on_ids = [];
    }
  } else if (Array.isArray(rawDeps)) {
    row.depends_on_ids = rawDeps;
  } else {
    row.depends_on_ids = [];
  }
  // skip_stages is stored as a JSON array of stage IDs (or null when unset).
  // Mirror the depends_on_ids parsing: tolerate a JSON string, an already-
  // parsed array, or fall back to null. Stage IDs are not validated here —
  // the pipeline filters via the project's stage config.
  const rawSkip = row.skip_stages;
  if (typeof rawSkip === 'string') {
    try {
      const parsed = JSON.parse(rawSkip);
      row.skip_stages = Array.isArray(parsed) ? parsed : null;
    } catch {
      row.skip_stages = null;
    }
  } else if (Array.isArray(rawSkip)) {
    row.skip_stages = rawSkip;
  } else {
    row.skip_stages = null;
  }
  row.archived = !!row.archived;
  if (typeof row.runtime_selection === 'string') {
    row.runtimeSelection = parseStoredRuntimeSelection(row.runtime_selection);
  } else if (
    row.runtime_selection === null ||
    row.runtime_selection === undefined
  )
    row.runtimeSelection = null;
  delete row.runtime_selection;
  const rawCustom = row.custom_values;
  if (typeof rawCustom === 'string') {
    try {
      row.custom_values = JSON.parse(rawCustom);
    } catch {
      row.custom_values = undefined;
    }
  }

  const rawVariants = row.ab_variants ?? row.abVariants;
  if (typeof rawVariants === 'string') {
    try {
      const parsed = JSON.parse(rawVariants);
      row.ab_variants = Array.isArray(parsed) ? parsed : null;
    } catch {
      row.ab_variants = null;
    }
  } else if (Array.isArray(rawVariants)) {
    row.ab_variants = rawVariants;
  } else {
    row.ab_variants = null;
  }
  row.abVariants = row.ab_variants;

  const parentId = row.ab_parent_task_id ?? row.abParentTaskId ?? null;
  row.ab_parent_task_id = parentId;
  row.abParentTaskId = parentId;

  const winnerId = row.ab_winner_task_id ?? row.abWinnerTaskId ?? null;
  row.ab_winner_task_id = winnerId;
  row.abWinnerTaskId = winnerId;

  const forkStage = row.ab_fork_stage ?? row.abForkStage ?? null;
  row.ab_fork_stage = forkStage;
  row.abForkStage = forkStage;

  const forkCommit = row.ab_fork_commit ?? row.abForkCommit ?? null;
  row.ab_fork_commit = forkCommit;
  row.abForkCommit = forkCommit;

  const stageVariant = row.stage_variant ?? row.stageVariant ?? null;
  row.stageVariant = stageVariant;
  row.stage_variant = stageVariant;

  const rawCoStages = row.co_stages ?? row.coStages;
  let coStages: string[] | null = null;
  if (Array.isArray(rawCoStages)) {
    coStages = rawCoStages;
  } else if (typeof rawCoStages === 'string') {
    try {
      const parsed = JSON.parse(rawCoStages);
      coStages = Array.isArray(parsed) ? parsed : null;
    } catch {
      coStages = null;
    }
  }
  row.coStages = coStages;
  row.co_stages = coStages;

  return row;
}

/** Stored form of `coStages`: a JSON array, or null when empty/unset. */
function serializeCoStages(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0
    ? JSON.stringify(value)
    : null;
}

/** Count of consecutive failed testing runs in `custom_values`. */
export const TESTING_FAILURE_COUNT_KEY = 'testing_failure_count';
/** Lifetime count of failed testing runs in `custom_values`; never lowered. */
export const TESTING_FAILURE_TOTAL_KEY = 'testing_failure_total';

function parseTasks(rows: any[]): Task[] {
  return rows
    .map(parseTask)
    .filter((task: Task | undefined): task is Task => !!task);
}

/** Serialize stage-changing task writes behind the project row lock. */
async function lockProjectStageConfiguration(
  tx: any,
  projectId: string,
): Promise<void> {
  return lockProjectStageConfigurations(tx, [projectId]);
}

/** Lock all affected project rows in a stable order to avoid cross-project deadlocks. */
async function lockProjectStageConfigurations(
  tx: any,
  projectIds: readonly string[],
): Promise<void> {
  const requestedIds = [...new Set(projectIds)].sort();
  if (requestedIds.length === 0) return;
  const projectRows = await tx
    .select({ parentId: projects.parentId })
    .from(projects)
    .where(inArray(projects.id, requestedIds));
  const ids = [
    ...new Set([
      ...requestedIds,
      ...projectRows
        .map((project: { parentId: string | null }) => project.parentId)
        .filter((parentId: string | null): parentId is string => !!parentId),
    ]),
  ].sort();
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.id, ids))
    .orderBy(asc(projects.id))
    .for('update');
}

function parseProjectSettings(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stageDefinitionsFromSettings(
  settings: Record<string, unknown>,
): StageDefinition[] {
  if (!Array.isArray(settings.stages) || settings.stages.length === 0) {
    return [];
  }
  return settings.stages.filter(
    (stage: unknown): stage is StageDefinition =>
      !!stage &&
      typeof stage === 'object' &&
      'id' in stage &&
      typeof stage.id === 'string' &&
      !isStageAlternativeId(stage.id),
  );
}

async function effectiveStageDefinitionsFromLockedProject(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  projectId: string,
  settingsOverride?: Record<string, unknown>,
  parentIdOverride?: string | null,
): Promise<StageDefinition[]> {
  const [project] = await tx
    .select({ settings: projects.settings, parentId: projects.parentId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return [];

  const settings = settingsOverride ?? parseProjectSettings(project.settings);
  const localStages = stageDefinitionsFromSettings(settings);
  if (localStages.length > 0) return localStages;

  const parentId =
    parentIdOverride !== undefined ? parentIdOverride : project.parentId;
  if (parentId) {
    const [parent] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, parentId))
      .limit(1);
    const parentStages = stageDefinitionsFromSettings(
      parseProjectSettings(parent?.settings),
    );
    if (parentStages.length > 0) return parentStages;
  }
  return DEFAULT_STAGES;
}

async function effectiveStageIdsFromLockedProject(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  projectId: string,
  settingsOverride?: Record<string, unknown>,
  parentIdOverride?: string | null,
): Promise<string[]> {
  const stages = await effectiveStageDefinitionsFromLockedProject(
    tx,
    projectId,
    settingsOverride,
    parentIdOverride,
  );
  return stages.map((stage) => stage.id);
}

/** Read the effective stage IDs from the locked project rows, not stale memory. */
async function getLockedProjectStageIds(
  tx: any,
  projectId: string,
): Promise<string[] | undefined> {
  // Task-module unit tests intentionally use ad-hoc project IDs without
  // registering projects.  Their shared in-memory database can contain a
  // row left by another concurrently running test, so that row is not an
  // authoritative pipeline for the fixture.  Real projects are loaded into
  // the state manager before task writes and are therefore DB-authoritative.
  const registeredGroup = getGroupByFolder(projectId);
  if (!registeredGroup) return undefined;

  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return undefined;
  return effectiveStageIdsFromLockedProject(tx, projectId);
}

export class TaskStageWriteConflictError extends Error {
  statusCode = 409;

  constructor(projectId: string, status: string, stageIds: readonly string[]) {
    super(
      `Stage "${status}" is not in the current pipeline for project "${projectId}". Refresh the project stages and retry the task update. Valid stages: ${stageIds.join(', ')}`,
    );
    this.name = 'TaskStageWriteConflictError';
  }
}

export class TaskSourceProjectMismatchError extends Error {
  statusCode = 409;

  constructor(taskId: string, expectedProjectId: string) {
    super(`Task "${taskId}" is no longer in project "${expectedProjectId}".`);
    this.name = 'TaskSourceProjectMismatchError';
  }
}

/**
 * A task dependency references a task that belongs to a different project.
 * Task execution and unmet-dependency resolution are project-scoped, so a
 * foreign-project dependency would be treated as satisfied — reject such
 * edges before any task mutation.
 */
export class CrossProjectDependencyError extends Error {
  statusCode = 400;

  constructor(
    taskLabel: string,
    projectId: string,
    violations: Array<{
      dependencyId: string;
      dependencyProjectId: string;
    }>,
  ) {
    const detail = violations
      .map((v) => `"${v.dependencyId}" (project "${v.dependencyProjectId}")`)
      .join(', ');
    super(
      `Task "${taskLabel}" cannot depend on task(s) from another project: ${detail}. Dependencies of tasks in project "${projectId}" must belong to the same project.`,
    );
    this.name = 'CrossProjectDependencyError';
  }
}

async function assertLockedTaskStatus(
  tx: any,
  projectId: string,
  status: string,
): Promise<void> {
  const stageIds = await getLockedProjectStageIds(tx, projectId);
  if (stageIds && !stageIds.includes(status)) {
    throw new TaskStageWriteConflictError(projectId, status, stageIds);
  }
}

const UNRESOLVED_STAGE_ENTRY_STATES = [
  'pending',
  'claimed',
  'running',
  'failed',
] as const;
const BLOCKING_STAGE_ENTRY_STATES = ['pending', 'claimed', 'running'] as const;

function parseStageEntryEvent(
  row: typeof stageEntryEvents.$inferSelect | undefined,
): StageEntryEvent | undefined {
  if (!row) return undefined;
  let lifecycleNotification: StageEntryLifecycleNotification | undefined;
  if (row.lifecycle_notification) {
    try {
      const parsed = JSON.parse(
        row.lifecycle_notification,
      ) as Partial<StageEntryLifecycleNotification>;
      if (
        (parsed.event === 'completed' ||
          parsed.event === 'failed' ||
          parsed.event === 'needs_input') &&
        typeof parsed.title === 'string' &&
        typeof parsed.runId === 'string'
      ) {
        lifecycleNotification = {
          event: parsed.event,
          title: parsed.title,
          runId: parsed.runId,
          ...(Array.isArray(parsed.recipientUserIds)
            ? {
                recipientUserIds: parsed.recipientUserIds.filter(
                  (id): id is string => typeof id === 'string',
                ),
              }
            : {}),
        };
      }
    } catch {
      // Ignore malformed optional metadata from an older or manually repaired row.
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    stageId: row.stage_id,
    state: row.state,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? undefined,
    runId: row.run_id ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    lifecycleNotification,
  };
}

let stageEntryEventCommittedHandler:
  | ((event: StageEntryEvent) => void | Promise<void>)
  | null = null;

/** Register the process-local wakeup invoked after a new durable receipt commits. */
export function setStageEntryEventCommittedHandler(
  handler: ((event: StageEntryEvent) => void | Promise<void>) | null,
): void {
  stageEntryEventCommittedHandler = handler;
}

const taskStatusChangedListeners = new Set<(taskId: string) => void>();

/** Register a process-local callback run after `updateTask` or a stage migration commits a status change. */
export function onTaskStatusChanged(
  listener: (taskId: string) => void,
): () => void {
  taskStatusChangedListeners.add(listener);
  return () => taskStatusChangedListeners.delete(listener);
}

function notifyStageEntryEventCommitted(
  event: StageEntryEvent | undefined,
): void {
  if (!event || !stageEntryEventCommittedHandler) return;
  void Promise.resolve(stageEntryEventCommittedHandler(event)).catch(
    (error) => {
      logger.error(
        { error, eventId: event.id },
        'stage entry event committed handler failed',
      );
    },
  );
}

/** Details of a recovery hook that the automatic-recovery budget suppressed. */
export interface RecoveryBudgetExhaustion {
  taskId: string;
  projectId: string;
  stageId: string;
  runs: number;
}

let recoveryBudgetExhaustedHandler:
  | ((exhaustion: RecoveryBudgetExhaustion) => void | Promise<void>)
  | null = null;

/** Register the process-local reporter for suppressed automatic recovery hooks. */
export function setRecoveryBudgetExhaustedHandler(
  handler:
    | ((exhaustion: RecoveryBudgetExhaustion) => void | Promise<void>)
    | null,
): void {
  recoveryBudgetExhaustedHandler = handler;
}

function notifyRecoveryBudgetExhausted(
  exhaustion: RecoveryBudgetExhaustion | undefined,
): void {
  if (!exhaustion || !recoveryBudgetExhaustedHandler) return;
  void Promise.resolve(recoveryBudgetExhaustedHandler(exhaustion)).catch(
    (error) => {
      logger.error(
        { error, taskId: exhaustion.taskId },
        'recovery budget exhausted handler failed',
      );
    },
  );
}

/**
 * Count recovery-hook entries since the task's latest human trigger (all of
 * them when there is none) across every runOnEntry queue stage.
 */
async function countAutomaticRecoveryRuns(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  stages: StageDefinition[],
  task: Pick<
    Task,
    'id' | 'project_id' | 'lastTriggerSource' | 'lastTriggeredAt'
  >,
): Promise<number> {
  const recoveryStageIds = stages
    .filter(isRecoveryHookStage)
    .map((stage) => stage.id);
  if (recoveryStageIds.length === 0) return 0;
  const humanTriggeredAt =
    task.lastTriggerSource === 'user' ? task.lastTriggeredAt : null;
  const [row] = await tx
    .select({ runs: count() })
    .from(stageEntryEvents)
    .where(
      and(
        eq(stageEntryEvents.task_id, task.id),
        eq(stageEntryEvents.project_id, task.project_id),
        inArray(stageEntryEvents.stage_id, recoveryStageIds),
        humanTriggeredAt
          ? gte(stageEntryEvents.created_at, humanTriggeredAt)
          : undefined,
      ),
    );
  return Number(row?.runs ?? 0);
}

/**
 * Insert the entry receipt for a runOnEntry stage. When `automaticTask` is
 * supplied the transition is not human-initiated: entering a recovery (queue)
 * stage then consumes the automatic-recovery budget, and an exhausted budget
 * suppresses the receipt and reports through `onBudgetExhausted`.
 */
async function insertStageEntryEventIfEnabled(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  projectId: string,
  taskId: string,
  stageId: string,
  createdAt: string,
  automatic?: {
    task: Task;
    onBudgetExhausted: (exhaustion: RecoveryBudgetExhaustion) => void;
  },
): Promise<StageEntryEvent | undefined> {
  const stages = await effectiveStageDefinitionsFromLockedProject(
    tx,
    projectId,
  );
  const stage = stages.find((candidate) => candidate.id === stageId);
  if (!stage || stage.inactive || stage.runOnEntry !== true) return undefined;

  if (automatic && isRecoveryHookStage(stage)) {
    const runs = await countAutomaticRecoveryRuns(tx, stages, automatic.task);
    if (runs >= MAX_AUTOMATIC_RECOVERY_RUNS) {
      automatic.onBudgetExhausted({ taskId, projectId, stageId, runs });
      return undefined;
    }
  }

  const [row] = await tx
    .insert(stageEntryEvents)
    .values({
      id: `stage-entry-${randomUUID()}`,
      project_id: projectId,
      task_id: taskId,
      stage_id: stageId,
      state: 'pending',
      created_at: createdAt,
    })
    .returning();
  return parseStageEntryEvent(row);
}

/**
 * Source ids of the needs_input and failed task lifecycle notifications
 * (`task:<task>:<run>:<event>:<user>`, `stage-entry:<entry>:<event>:<user>`).
 * Two needs_input alerts are excluded because they deliberately describe a
 * task parked in Backlog although the project has a Question stage: the
 * cost-limit alert (run segment `cost-limit`) and, for alerts stored before
 * that run segment existed, any whose run segment is the task id.
 */
export function lifecycleAttentionSource() {
  const source = notificationPayloads.source_tool_use_id;
  return sql`((${source} like 'task:%:needs_input:%'
    or ${source} like 'task:%:failed:%'
    or ${source} like 'stage-entry:%:needs_input:%'
    or ${source} like 'stage-entry:%:failed:%')
    and not (${source} like 'task:%:needs_input:%'
      and (split_part(${source}, ':', 3) = 'cost-limit'
        or split_part(${source}, ':', 3) = split_part(${source}, ':', 2))))`;
}

/** Lifecycle event behind an attention notification. */
export type AttentionEvent = 'needs_input' | 'failed';

/**
 * Whether `stageId` is where a task needing attention is parked: the Question
 * or Failed stage, or the queue stage a project without them falls back to
 * (`getTestingBlockedStage` for needs_input, `getFailedStage` for failed).
 * With `event`, only that event's destination counts: a fallback queue is not
 * a needs_input destination while the project has a Question stage. Without
 * it, recovery-hook queues count too (see `reportRecoveryBudgetExhausted`).
 */
export function isAttentionStage(
  stages: StageDefinition[],
  stageId: string,
  event?: AttentionEvent,
): boolean {
  const needsInput =
    isQuestionStage(stages, stageId) ||
    getTestingBlockedStage(stages)?.id === stageId;
  const failed =
    isFailedStage(stages, stageId) || getFailedStage(stages)?.id === stageId;
  if (event === 'needs_input') return needsInput;
  if (event === 'failed') return failed;
  // A recovery queue is where an exhausted-budget alert parks a task.
  return (
    needsInput ||
    failed ||
    isRecoveryHookStage(stages.find((stage) => stage.id === stageId))
  );
}

/**
 * Ack the unread "needs your attention" notifications (the needs_input and
 * failed lifecycle events) about tasks that have left Question or Failed, so
 * they stop showing in the Now list and the bell, and open clients refresh.
 * Agent notifications and forms about the task are left alone. A later return
 * to Question or Failed sends a fresh notification. (`getUnreadPayloads`
 * also hides such a notification stored after the task has left.) Callers
 * broadcast the result with `broadcastAckedAttention` after commit.
 */
async function ackTaskAttentionPayloads(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  taskIds: readonly string[],
  ackedAt: string,
): Promise<AckedAttentionPayload[]> {
  if (taskIds.length === 0) return [];
  return tx
    .update(notificationPayloads)
    .set({ acked_at: ackedAt })
    .where(
      and(
        eq(notificationPayloads.kind, 'text'),
        isNull(notificationPayloads.acked_at),
        or(
          ...taskIds.map(
            (taskId) =>
              sql`${notificationPayloads.action_url} like ${`/board/%?taskId=${encodeURIComponent(taskId)}`}`,
          ),
        ),
        lifecycleAttentionSource(),
      ),
    )
    .returning({
      id: notificationPayloads.id,
      user_id: notificationPayloads.user_id,
    });
}

type AckedAttentionPayload = { id: string; user_id: string };

function broadcastAckedAttention(payloads: readonly AckedAttentionPayload[]) {
  for (const payload of payloads) {
    broadcast({
      type: 'notification_acked',
      payload: { user_id: payload.user_id, payload_id: payload.id },
    });
  }
}

async function resolveTaskStageEntryEvents(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  taskId: string,
  projectId: string,
  stageId: string | undefined,
  completedAt: string,
): Promise<StageEntryEvent[]> {
  const rows = await tx
    .update(stageEntryEvents)
    .set({ state: 'resolved', completed_at: completedAt })
    .where(
      and(
        eq(stageEntryEvents.task_id, taskId),
        eq(stageEntryEvents.project_id, projectId),
        stageId ? eq(stageEntryEvents.stage_id, stageId) : undefined,
        inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES),
      ),
    )
    .returning();
  return rows
    .map((row: typeof stageEntryEvents.$inferSelect) =>
      parseStageEntryEvent(row),
    )
    .filter(
      (event: StageEntryEvent | undefined): event is StageEntryEvent =>
        event !== undefined,
    );
}

async function attachTaskAttribution<T extends Task>(
  items: T[],
  db: any = drizzleDbRef.current,
): Promise<T[]> {
  const ids = [
    ...new Set(
      items.flatMap((item) =>
        [item.ownerUserId, item.lastTriggeredByUserId].filter(
          (id): id is string => !!id,
        ),
      ),
    ),
  ];
  const rows = ids.length
    ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const byId = new Map(
    rows.map((row: { id: string; username: string }) => [row.id, row]),
  );
  const sourceConversationIds = [
    ...new Set(
      items
        .map((item) => item.sourceConversationId)
        .filter((id): id is string => !!id),
    ),
  ];
  const sourceConversations = sourceConversationIds.length
    ? await db
        .select({ id: conversations.id, projectId: conversations.group_folder })
        .from(conversations)
        .where(inArray(conversations.id, sourceConversationIds))
    : [];
  const sourceProjectByConversationId = new Map(
    sourceConversations.map((row: { id: string; projectId: string }) => [
      row.id,
      row.projectId,
    ]),
  );
  return items.map((item) => ({
    ...item,
    owner: item.ownerUserId ? (byId.get(item.ownerUserId) ?? null) : null,
    latestTrigger: {
      user: item.lastTriggeredByUserId
        ? (byId.get(item.lastTriggeredByUserId) ?? null)
        : null,
      source: item.lastTriggerSource ?? 'system',
      triggeredAt: item.lastTriggeredAt ?? null,
    },
    sourceConversationProjectId: item.sourceConversationId
      ? (sourceProjectByConversationId.get(item.sourceConversationId) ?? null)
      : null,
  }));
}

type CreateTaskData = Omit<Task, 'id' | 'created_at' | 'priority'> & {
  /** Omit to append after the project's current task ordering. */
  priority?: number;
};

export interface ExternalIssueIdentity {
  provider: 'gitlab' | 'github';
  repository: string;
  issueNumber: number;
  issueUrl: string;
}

export interface ExternalIssueImport extends ExternalIssueIdentity {
  projectId: string;
  taskId: string;
  importedAt: string;
}

async function createTaskInTransaction(
  tx: any,
  data: CreateTaskData,
  id: string,
  created_at: string,
): Promise<{ task: Task; entryEvent?: StageEntryEvent }> {
  await assertSameProjectDependencies(tx, {
    taskLabel: id,
    projectId: data.project_id,
    dependsOnIds: data.depends_on_ids,
  });
  await lockProjectStageConfiguration(tx, data.project_id);
  await assertLockedTaskStatus(
    tx,
    data.project_id,
    data.status || DEFAULT_STAGES[0].id,
  );
  if (!data.ownerUserId) {
    const [project] = await tx
      .select({ userId: projects.user_id })
      .from(projects)
      .where(eq(projects.id, data.project_id))
      .limit(1);
    data = { ...data, ownerUserId: project?.userId ?? null };
  }
  // PostgreSQL deployments can receive creates from multiple board
  // instances. Serialize only implicit-priority creates for this project so
  // each gets a distinct append position. PGlite is single-process and does
  // not implement advisory locks.
  if (data.priority === undefined && isPostgresDatabase()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${data.project_id}))`,
    );
  }
  const priority =
    data.priority ?? (await getNextTaskPriority(tx, data.project_id));
  const rows = await tx
    .insert(tasks)
    .values(taskInsertValues(data, id, created_at, priority))
    .returning();
  const created = parseTask(rows[0]);
  if (!created) throw new Error(`Created task ${id} could not be reloaded`);
  await tx.insert(taskBoardEvents).values({
    project_id: created.project_id,
    task_id: created.id,
    event_type: 'created',
    occurred_at: created_at,
    snapshot: replayTaskSnapshot(created),
  });
  const entryEvent = created.archived
    ? undefined
    : await insertStageEntryEventIfEnabled(
        tx,
        created.project_id,
        created.id,
        created.status,
        created_at,
      );
  return {
    task: (await attachTaskAttribution([created], tx))[0],
    entryEvent,
  };
}

export async function createTask(data: CreateTaskData): Promise<Task> {
  const id = generateTaskId();
  const created_at = new Date().toISOString();

  const result = await drizzleDbRef.current.transaction((tx) =>
    createTaskInTransaction(tx, data, id, created_at),
  );
  notifyStageEntryEventCommitted(result.entryEvent);
  return result.task;
}

/**
 * Atomically reserve an external issue identity and create its task.
 * Returns null when that issue was imported previously, even if its task was
 * later deleted.
 */
export async function createImportedIssueTask(
  data: CreateTaskData,
  issue: ExternalIssueIdentity,
): Promise<Task | null> {
  const id = generateTaskId();
  const created_at = new Date().toISOString();
  const result = await drizzleDbRef.current.transaction(async (tx) => {
    const reserved = await tx
      .insert(externalIssueImports)
      .values({
        project_id: data.project_id,
        provider: issue.provider,
        repository: issue.repository,
        issue_number: issue.issueNumber,
        task_id: null,
        issue_url: issue.issueUrl,
        imported_at: created_at,
      })
      .onConflictDoNothing()
      .returning();
    if (reserved.length === 0) return null;

    const created = await createTaskInTransaction(tx, data, id, created_at);
    await tx
      .update(externalIssueImports)
      .set({ task_id: created.task.id })
      .where(
        and(
          eq(externalIssueImports.project_id, data.project_id),
          eq(externalIssueImports.provider, issue.provider),
          eq(externalIssueImports.repository, issue.repository),
          eq(externalIssueImports.issue_number, issue.issueNumber),
        ),
      );
    return created;
  });
  if (!result) return null;
  notifyStageEntryEventCommitted(result.entryEvent);
  return result.task;
}

/**
 * Return the external issue attached to a live task, if any. The ledger row
 * stays on the importing project when the task moves, so look up by task only;
 * `projectId` on the result is the importing project.
 */
export async function getExternalIssueImportByTaskId(
  taskId: string,
): Promise<ExternalIssueImport | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(externalIssueImports)
    .where(eq(externalIssueImports.task_id, taskId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    (row.provider !== 'gitlab' && row.provider !== 'github') ||
    !row.task_id
  ) {
    return undefined;
  }
  return {
    projectId: row.project_id,
    provider: row.provider,
    repository: row.repository,
    issueNumber: row.issue_number,
    taskId: row.task_id,
    issueUrl: row.issue_url,
    importedAt: row.imported_at,
  };
}

async function getNextTaskPriority(
  tx: any,
  projectId: string,
): Promise<number> {
  const [row] = await tx
    .select({ maxPriority: sql<number | null>`max(${tasks.priority})` })
    .from(tasks)
    .where(eq(tasks.project_id, projectId));
  return (row?.maxPriority ?? -1000) + 1000;
}

function taskInsertValues(
  data: CreateTaskData,
  id: string,
  created_at: string,
  priority: number,
) {
  return {
    id,
    project_id: data.project_id,
    title: data.title,
    description: data.description || '',
    status: data.status || 'backlog',
    priority,
    runtime_selection: data.runtimeSelection
      ? JSON.stringify(data.runtimeSelection)
      : null,
    runtimeSelectionStage: data.runtimeSelectionStage ?? null,
    output: data.output || null,
    error: data.error || null,
    session_id: data.session_id || null,
    cronjob_id: data.cronjob_id || null,
    last_agent_name: data.last_agent_name || null,
    dataset_task_id: data.dataset_task_id || null,
    dataset_row_index: data.dataset_row_index ?? null,
    depends_on_ids:
      data.depends_on_ids && data.depends_on_ids.length > 0
        ? JSON.stringify(data.depends_on_ids)
        : null,
    skip_stages:
      data.skip_stages && data.skip_stages.length > 0
        ? JSON.stringify(data.skip_stages)
        : null,
    stageVariant: data.stageVariant || data.stage_variant || null,
    coStages: serializeCoStages(data.coStages ?? data.co_stages),
    abVariants:
      (data.abVariants ?? data.ab_variants) &&
      (data.abVariants ?? data.ab_variants)!.length > 0
        ? JSON.stringify(data.abVariants ?? data.ab_variants)
        : null,
    abParentTaskId: data.abParentTaskId ?? data.ab_parent_task_id ?? null,
    abWinnerTaskId: data.abWinnerTaskId ?? data.ab_winner_task_id ?? null,
    abForkStage: data.abForkStage ?? data.ab_fork_stage ?? null,
    abForkCommit: data.abForkCommit ?? data.ab_fork_commit ?? null,
    execute_in_stage: data.execute_in_stage || null,
    archived: data.archived ? 1 : 0,
    custom_values: data.custom_values
      ? JSON.stringify(data.custom_values)
      : null,
    branch_name: data.branch_name || null,
    worktree_path: data.worktree_path || null,
    objective_id: data.objective_id ?? null,
    ownerUserId: data.ownerUserId ?? null,
    lastTriggeredByUserId: data.lastTriggeredByUserId ?? null,
    lastTriggerSource: data.lastTriggerSource ?? 'system',
    lastTriggeredAt: data.lastTriggeredAt ?? null,
    sourceConversationId: data.sourceConversationId ?? null,
    sourceRunId: data.sourceRunId ?? null,
    author: data.author || null,
    created_at,
    started_at: data.started_at || null,
    completed_at: data.completed_at || null,
  };
}

export async function getAbChildTaskIds(
  parentTaskId: string,
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.abParentTaskId, parentTaskId));
  return rows.map((r) => r.id);
}

export async function getAbChildTasks(parentTaskId: string): Promise<Task[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .where(eq(tasks.abParentTaskId, parentTaskId));
  return parseTasks(rows);
}

/**
 * Compare-and-set the experiment winner: succeeds for exactly one caller while
 * the parent has none. Returns false when a winner is already recorded (or the
 * parent no longer exists).
 */
export async function claimAbWinner(
  parentTaskId: string,
  winnerTaskId: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .update(tasks)
    .set({ abWinnerTaskId: winnerTaskId })
    .where(and(eq(tasks.id, parentTaskId), isNull(tasks.abWinnerTaskId)))
    .returning();
  return rows.length > 0;
}

/** Release a winner claim, but only if it still names `winnerTaskId`. */
export async function clearAbWinner(
  parentTaskId: string,
  winnerTaskId: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(tasks)
    .set({ abWinnerTaskId: null })
    .where(
      and(eq(tasks.id, parentTaskId), eq(tasks.abWinnerTaskId, winnerTaskId)),
    );
}

export async function spawnAbVariantsInDb(
  parent: Task,
  forkStage: string,
  forkCommit: string,
  /**
   * What the caller planned the fork from. The fork is admitted only while the
   * locked parent row still matches it; a concurrent edit (variants cleared or
   * changed, parent moved to another stage) aborts with no children.
   */
  expected: { status: string; variants: readonly string[] },
): Promise<Task[]> {
  return await drizzleDbRef.current.transaction(async (tx) => {
    // Lock parent row transactionally
    const parentRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, parent.id))
      .for('update');
    const currentParent = parseTask(parentRows[0]);
    if (!currentParent) return [];

    // If already forked, return existing children without overwriting snapshot
    if (currentParent.ab_fork_commit || currentParent.abForkCommit) {
      const existingChildRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.abParentTaskId, parent.id));
      return parseTasks(existingChildRows);
    }

    // Only the locked row's variants are authoritative: never fall back to the
    // caller's snapshot, which may predate an edit that cleared them.
    const variants: string[] =
      currentParent.ab_variants ?? currentParent.abVariants ?? [];
    if (
      variants.length < 2 ||
      currentParent.status !== expected.status ||
      variants.length !== expected.variants.length ||
      variants.some((v, i) => v !== expected.variants[i])
    ) {
      return [];
    }

    // 1. Update parent with abForkStage, abForkCommit, and ensure status is forkStage
    await tx
      .update(tasks)
      .set({
        status: forkStage,
        abForkStage: forkStage,
        abForkCommit: forkCommit,
      })
      .where(eq(tasks.id, parent.id));

    // 2. Insert variant cards for each variant
    const created_at = new Date().toISOString();
    for (const v of variants) {
      const variantLetter = v.toLowerCase();
      const childId = generateTaskId();
      const childData: CreateTaskData = {
        project_id: currentParent.project_id,
        title: `${currentParent.title} [${variantLetter.toUpperCase()}]`,
        description: currentParent.description ?? '',
        status: forkStage,
        priority: currentParent.priority ?? 0,
        objective_id: currentParent.objective_id ?? undefined,
        ownerUserId: currentParent.ownerUserId ?? undefined,
        custom_values: currentParent.custom_values ?? undefined,
        coStages: currentParent.coStages ?? undefined,
        stage_variant: variantLetter,
        stageVariant: variantLetter,
        ab_parent_task_id: currentParent.id,
        abParentTaskId: currentParent.id,
        runtimeSelection: null,
        runtimeSelectionStage: null,
        depends_on_ids: undefined,
      };
      const values = taskInsertValues(
        childData,
        childId,
        created_at,
        childData.priority ?? 0,
      );
      const insertedRows = await tx
        .insert(tasks)
        .values(values)
        .onConflictDoNothing({
          target: [tasks.abParentTaskId, tasks.stageVariant],
        })
        .returning();
      const created = parseTask(insertedRows[0]);
      if (created) {
        await tx.insert(taskBoardEvents).values({
          project_id: created.project_id,
          task_id: created.id,
          event_type: 'created',
          occurred_at: created_at,
          snapshot: replayTaskSnapshot(created),
        });
      }
    }

    // 3. Return all child tasks for this parent
    const childRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.abParentTaskId, parent.id));
    return parseTasks(childRows);
  });
}

export async function getTask(id: string): Promise<Task | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .where(eq(tasks.id, id));
  const parsed = parseTask(rows[0]);
  if (!parsed) return undefined;
  const childIds = await getAbChildTaskIds(id);
  if (childIds.length > 0) {
    parsed.child_ids = childIds;
    parsed.childIds = childIds;
  }
  return (await attachTaskAttribution([parsed]))[0];
}

/**
 * Tasks whose ID ends in `-<suffix>`. Used only to suggest candidates when an
 * agent mistypes the timestamp part of a task ID; never to resolve a task.
 */
export async function findTasksByIdSuffix(
  suffix: string,
  limit = 3,
): Promise<Task[]> {
  if (!/^[a-z0-9]{4,8}$/.test(suffix)) return [];
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .where(sql`${tasks.id} LIKE ${'%-' + suffix}`)
    .limit(limit);
  return parseTasks(rows);
}

/** Run count and total priced cost across every run of one task. */
export async function getTaskRunStats(
  taskId: string,
): Promise<{ run_count: number; cost_usd: number }> {
  const rows = await drizzleDbRef.current
    .select({
      runCount: count(activeRuns.id),
      cost_usd: sql<number | null>`sum(${activeRuns.cost_usd})`,
    })
    .from(activeRuns)
    .where(eq(activeRuns.task_id, taskId));
  const row = rows[0];
  return {
    run_count: row == null ? 0 : Number(row.runCount),
    cost_usd: row?.cost_usd == null ? 0 : Number(row.cost_usd),
  };
}

export interface TaskStageRunStat {
  stage: string | null;
  /** `coalesce(model_name, model)`: the priced model name, else the requested model. */
  model: string | null;
  /** Raw `model_name`; null when the group's runs recorded none. */
  modelName: string | null;
  runs: number;
  /** Runs with a recorded `cost_usd`. */
  pricedRuns: number;
  /** Sum over priced runs only; null (never 0) when `pricedRuns` is 0. */
  costUsd: number | null;
  tokTotal: number | null;
}

/** Per-stage/per-model run count, priced-run count, cost and tokens across every run of one task. */
export async function getTaskStageRunStats(
  taskId: string,
): Promise<TaskStageRunStat[]> {
  const model = sql<
    string | null
  >`coalesce(${activeRuns.model_name}, ${activeRuns.model})`;
  const rows = await drizzleDbRef.current
    .select({
      stage: activeRuns.stage,
      model,
      modelName: sql<string | null>`max(${activeRuns.model_name})`,
      runs: count(activeRuns.id),
      pricedRuns: count(activeRuns.cost_usd),
      costUsd: sql<number | null>`sum(${activeRuns.cost_usd})`,
      tokTotal: sql<number | null>`sum(${activeRuns.tok_total})`,
    })
    .from(activeRuns)
    .where(eq(activeRuns.task_id, taskId))
    .groupBy(activeRuns.stage, model);
  return rows.map((row) => ({
    stage: row.stage,
    model: row.model,
    modelName: row.modelName,
    runs: Number(row.runs),
    pricedRuns: Number(row.pricedRuns),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
    tokTotal: row.tokTotal == null ? null : Number(row.tokTotal),
  }));
}

/** Non-archived cards outside `doneStatuses`: only the fields card matching reads. */
export async function getOpenTaskCards(
  projectId: string,
  doneStatuses: readonly string[],
): Promise<Pick<Task, 'id' | 'title' | 'description'>[]> {
  return drizzleDbRef.current
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, projectId),
        eq(tasks.archived, 0),
        doneStatuses.length
          ? notInArray(tasks.status, [...doneStatuses])
          : undefined,
      ),
    );
}

export async function getTasksByProject(project_id: string): Promise<Task[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .where(eq(tasks.project_id, project_id))
    .orderBy(tasks.priority, desc(tasks.created_at), desc(tasks.id));
  return attachTaskAttribution(parseTasks(rows));
}

export interface TaskStatusCount {
  status: string;
  count: number;
}

/** Count project cards in the supplied statuses, including archived cards. */
export async function countProjectTasksByStatus(
  projectId: string,
  statuses: readonly string[],
  options: { excludeArchived?: boolean } = {},
): Promise<TaskStatusCount[]> {
  if (statuses.length === 0) return [];
  const rows = await drizzleDbRef.current
    .select({ status: tasks.status, count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, projectId),
        inArray(tasks.status, [...statuses]),
        options.excludeArchived ? eq(tasks.archived, 0) : undefined,
      ),
    )
    .groupBy(tasks.status)
    .orderBy(tasks.status);
  return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
}

/** Distinct projects holding non-archived task cards linked to an objective. */
export async function getObjectiveTaskProjectIds(
  objectiveId: string,
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .selectDistinct({ project_id: tasks.project_id })
    .from(tasks)
    .where(
      and(
        eq(tasks.objective_id, objectiveId),
        sql`(${tasks.archived} is null or ${tasks.archived} <> 1)`,
      ),
    );
  return rows.map((row) => row.project_id);
}

export async function getTasksByProjectSummary(
  project_id: string,
): Promise<TaskSummary[]> {
  const doneIds = doneStageIds(project_id);
  const rows = await drizzleDbRef.current
    .select({
      id: tasks.id,
      project_id: tasks.project_id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      runtime_selection: tasks.runtime_selection,
      runtimeSelectionStage: tasks.runtimeSelectionStage,
      error: tasks.error,
      created_at: tasks.created_at,
      started_at: tasks.started_at,
      completed_at: tasks.completed_at,
      cronjob_id: tasks.cronjob_id,
      last_agent_name: tasks.last_agent_name,
      depends_on_ids: tasks.depends_on_ids,
      archived: tasks.archived,
      custom_values: tasks.custom_values,
      author: tasks.author,
      dataset_task_id: tasks.dataset_task_id,
      dataset_row_index: tasks.dataset_row_index,
      branch_name: tasks.branch_name,
      worktree_path: tasks.worktree_path,
      skip_stages: tasks.skip_stages,
      stageVariant: tasks.stageVariant,
      coStages: tasks.coStages,
      abVariants: tasks.abVariants,
      abParentTaskId: tasks.abParentTaskId,
      abWinnerTaskId: tasks.abWinnerTaskId,
      abForkStage: tasks.abForkStage,
      abForkCommit: tasks.abForkCommit,
      objective_id: tasks.objective_id,
      ownerUserId: tasks.ownerUserId,
      lastTriggeredByUserId: tasks.lastTriggeredByUserId,
      lastTriggerSource: tasks.lastTriggerSource,
      lastTriggeredAt: tasks.lastTriggeredAt,
      sourceConversationId: tasks.sourceConversationId,
      sourceRunId: tasks.sourceRunId,
      // Compute transitions in one pass per task. A correlated predecessor
      // lookup repeats an index scan for every completed snapshot.
      completionEventId: sql<number | null>`case
        when ${doneIds.length > 0 ? sql`${tasks.status} in (${sqlStringList(doneIds)})` : sql`false`}
          and (${tasks.archived} is null or ${tasks.archived} <> 1)
        then (
          select max(completion_event.id)
          from (
            select id, status, lag(status) over (order by id) as previous_status
            from task_board_events
            where task_id = tasks.id
          ) completion_event
          where completion_event.status in (${sqlStringList(doneIds)})
            and coalesce(completion_event.previous_status, '') not in (${sqlStringList(doneIds)})
        )
        else null
      end`.mapWith((value) => (value == null ? null : Number(value))),
    })
    .from(tasks)
    .where(eq(tasks.project_id, project_id))
    .orderBy(tasks.priority, desc(tasks.created_at), desc(tasks.id));
  const parsed = parseTasks(rows) as TaskSummary[];
  if (parsed.length === 0) return parsed;
  const runStats = await drizzleDbRef.current
    .select({
      task_id: activeRuns.task_id,
      runCount: count(activeRuns.id),
      cost_usd: sql<number>`sum(${activeRuns.cost_usd})`,
      latestRunCompletedAt: sql<string | null>`max(${activeRuns.completed_at})`,
      latestRunModelName: sql<
        string | null
      >`(array_agg(${activeRuns.model_name} order by ${activeRuns.started_at} desc))[1]`,
      // Stage and agent of that same newest run, so the card can tell whether
      // its model describes the stage the task currently sits in.
      latestRunStage: sql<
        string | null
      >`(array_agg(${activeRuns.stage} order by ${activeRuns.started_at} desc))[1]`,
      latestRunAgentName: sql<
        string | null
      >`(array_agg(${activeRuns.agent_name} order by ${activeRuns.started_at} desc))[1]`,
      // A running run has its requested model before the reported model_name.
      runningRunModel: sql<
        string | null
      >`(array_agg(coalesce(${activeRuns.model_name}, ${activeRuns.model}) order by ${activeRuns.started_at} desc) filter (where ${activeRuns.status} = 'running'))[1]`,
      totalRunDurationMs: sql<number>`sum(case
        when ${activeRuns.completed_at} is not null then greatest(
          0,
          extract(epoch from ((${activeRuns.completed_at})::timestamptz - (${activeRuns.started_at})::timestamptz)) * 1000
        )
        else 0
      end)`,
    })
    .from(activeRuns)
    .where(
      inArray(
        activeRuns.task_id,
        parsed.map((task) => task.id),
      ),
    )
    .groupBy(activeRuns.task_id);
  const runStatsByTask = new Map(runStats.map((row) => [row.task_id, row]));
  const summaries = parsed.map((task) => {
    const stats = runStatsByTask.get(task.id);
    return {
      ...task,
      runCount: stats == null ? 0 : Number(stats.runCount),
      costUsd: stats?.cost_usd == null ? null : Number(stats.cost_usd),
      latestRunCompletedAt: stats?.latestRunCompletedAt ?? null,
      latestRunModelName: stats?.latestRunModelName ?? null,
      latestRunStage: stats?.latestRunStage ?? null,
      latestRunAgentName: stats?.latestRunAgentName ?? null,
      runningRunModel: stats?.runningRunModel ?? null,
      totalRunDurationMs:
        stats == null ? null : Number(stats.totalRunDurationMs),
    };
  });
  return attachTaskAttribution(summaries);
}

/**
 * Load the fields needed by queue selection and task startup without reading
 * the potentially very large persisted task output column.
 */
export async function getTasksByProjectForQueue(
  project_id: string,
): Promise<Task[]> {
  const rows = await drizzleDbRef.current
    .select({
      id: tasks.id,
      project_id: tasks.project_id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      runtime_selection: tasks.runtime_selection,
      runtimeSelectionStage: tasks.runtimeSelectionStage,
      error: tasks.error,
      session_id: tasks.session_id,
      created_at: tasks.created_at,
      started_at: tasks.started_at,
      completed_at: tasks.completed_at,
      cronjob_id: tasks.cronjob_id,
      last_agent_name: tasks.last_agent_name,
      depends_on_ids: tasks.depends_on_ids,
      archived: tasks.archived,
      custom_values: tasks.custom_values,
      author: tasks.author,
      dataset_task_id: tasks.dataset_task_id,
      dataset_row_index: tasks.dataset_row_index,
      branch_name: tasks.branch_name,
      execute_in_stage: tasks.execute_in_stage,
      sandbox_instance: tasks.sandbox_instance,
      worktree_path: tasks.worktree_path,
      merge_commit: tasks.merge_commit,
      skip_stages: tasks.skip_stages,
      stageVariant: tasks.stageVariant,
      coStages: tasks.coStages,
      abVariants: tasks.abVariants,
      abParentTaskId: tasks.abParentTaskId,
      abWinnerTaskId: tasks.abWinnerTaskId,
      abForkStage: tasks.abForkStage,
      abForkCommit: tasks.abForkCommit,
      objective_id: tasks.objective_id,
      ownerUserId: tasks.ownerUserId,
      lastTriggeredByUserId: tasks.lastTriggeredByUserId,
      lastTriggerSource: tasks.lastTriggerSource,
      lastTriggeredAt: tasks.lastTriggeredAt,
      sourceConversationId: tasks.sourceConversationId,
      sourceRunId: tasks.sourceRunId,
    })
    .from(tasks)
    .where(eq(tasks.project_id, project_id))
    .orderBy(tasks.priority, desc(tasks.created_at));
  return parseTasks(rows);
}

async function getTaskDependencyGraph(
  project_id: string,
): Promise<Map<string, string[]>> {
  const rows = await drizzleDbRef.current
    .select({ id: tasks.id, depends_on_ids: tasks.depends_on_ids })
    .from(tasks)
    .where(eq(tasks.project_id, project_id));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const depends_on_ids = row.depends_on_ids;
    let deps: string[] = [];
    if (depends_on_ids) {
      try {
        deps = JSON.parse(depends_on_ids);
      } catch {
        deps = [];
      }
    }
    map.set(row.id, deps);
  }
  return map;
}

export async function hasCircularDependency(
  project_id: string,
  task_id: string,
  newDeps: string[],
): Promise<boolean> {
  if (newDeps.length === 0) return false;
  const depMap = await getTaskDependencyGraph(project_id);
  depMap.set(task_id, newDeps);
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(id: string): boolean {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    for (const dep of depMap.get(id) || []) {
      if (dfs(dep)) return true;
    }
    stack.delete(id);
    return false;
  }
  return dfs(task_id);
}

/**
 * Shared data-integrity check for task dependency edges: every referenced
 * dependency that exists in the database must belong to the same project as
 * the dependent task. Unknown (nonexistent) IDs are tolerated to preserve
 * the pre-existing orphan-dependency behavior; a reference that resolves to
 * a different project raises CrossProjectDependencyError.
 */
async function assertSameProjectDependencies(
  db: any,
  options: {
    taskLabel: string;
    projectId: string | null | undefined;
    dependsOnIds: readonly string[] | null | undefined;
  },
): Promise<void> {
  if (!options.projectId) return;
  const depIds = [
    ...new Set(
      (options.dependsOnIds ?? []).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  if (depIds.length === 0) return;
  const rows = (await db
    .select({ id: tasks.id, project_id: tasks.project_id })
    .from(tasks)
    .where(inArray(tasks.id, depIds))) as Array<{
    id: string;
    project_id: string;
  }>;
  const projectByDepId = new Map<string, string>();
  for (const row of rows) {
    projectByDepId.set(row.id, row.project_id);
  }
  const violations: Array<{
    dependencyId: string;
    dependencyProjectId: string;
  }> = [];
  for (const dependencyId of depIds) {
    const dependencyProjectId = projectByDepId.get(dependencyId);
    // Undefined means the referenced task does not exist; only existing
    // tasks in a foreign project are rejected.
    if (
      dependencyProjectId !== undefined &&
      dependencyProjectId !== options.projectId
    ) {
      violations.push({ dependencyId, dependencyProjectId });
    }
  }
  if (violations.length > 0) {
    throw new CrossProjectDependencyError(
      options.taskLabel,
      options.projectId,
      violations,
    );
  }
}

/**
 * A dependency edge references a task ID that does not exist. The shared
 * DB-layer check tolerates unknown IDs, and the queue gate treats an absent
 * dependency as satisfied, so write entry points reject them explicitly.
 */
export class UnknownDependencyError extends Error {
  statusCode = 400;

  constructor(public missingIds: string[]) {
    super(`Unknown dependency task ID(s): ${missingIds.join(', ')}`);
    this.name = 'UnknownDependencyError';
  }
}

/**
 * Reject dependency IDs that do not resolve to an existing task, so cards do
 * not wait on (or launch past) a mistyped prerequisite.
 */
export async function assertDependenciesExist(
  ids: readonly string[],
): Promise<void> {
  const missing: string[] = [];
  for (const id of ids) {
    if (!(await getTask(id))) missing.push(id);
  }
  if (missing.length > 0) throw new UnknownDependencyError(missing);
}

/**
 * Pre-write precheck for shared task updates: callers that trigger
 * lifecycle side effects (branch merge on manual completion, worktree
 * removal on archive, durable stage handoff) before persisting the update
 * should run this first, so a rejection of a cross-project dependency edge
 * cannot leave those side effects behind. createTask/updateTask still
 * revalidate authoritatively inside their write transactions (updateTask
 * after the task row lock).
 */
export async function validateSameProjectDependencies(
  taskLabel: string,
  projectId: string,
  dependsOnIds: readonly string[] | null | undefined,
): Promise<void> {
  await assertSameProjectDependencies(drizzleDbRef.current, {
    taskLabel,
    projectId,
    dependsOnIds,
  });
}

export async function getTasksByProjectAndStatuses(
  project_id: string,
  statuses: string[],
): Promise<Task[]> {
  if (statuses.length === 0) return [];
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, project_id),
        inArray(tasks.status, statuses),
        or(isNull(tasks.archived), ne(tasks.archived, 1)),
      ),
    )
    .orderBy(tasks.priority, tasks.created_at);
  return parseTasks(rows);
}

export async function getTasksWithOrphanedWorktrees(): Promise<Task[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.worktree_path),
        notExists(
          drizzleDbRef.current
            .select({ one: sql`1` })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.task_id, tasks.id),
                eq(activeRuns.status, 'running'),
              ),
            ),
        ),
      ),
    );
  return parseTasks(rows);
}

export async function getAllTasks(): Promise<Task[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(tasks)
    .orderBy(tasks.priority, desc(tasks.created_at))
    .limit(5000);
  return parseTasks(rows);
}

export async function getTaskProjectMap(
  taskIds: readonly string[],
): Promise<Map<string, { projectId: string; archived: boolean }>> {
  if (taskIds.length === 0) return new Map();
  const rows = await drizzleDbRef.current
    .select({
      id: tasks.id,
      projectId: tasks.project_id,
      archived: tasks.archived,
    })
    .from(tasks)
    .where(inArray(tasks.id, [...taskIds]));
  return new Map(
    rows.map((row) => [
      row.id,
      { projectId: row.projectId, archived: row.archived === 1 },
    ]),
  );
}

export async function getAllActiveObjectives(): Promise<
  Array<Pick<Objective, 'id' | 'project_id'>>
> {
  return drizzleDbRef.current
    .select({ id: objectives.id, project_id: objectives.project_id })
    .from(objectives)
    .where(inArray(objectives.status, ['active', 'draft']))
    .orderBy(objectives.priority, objectives.created_at)
    .limit(500);
}

export async function getObjectiveChatStatusMap(
  project_id: string,
): Promise<Record<string, 'working' | 'finished' | 'failed' | 'pending'>> {
  // Get all objective IDs for this project
  const objectivesList = await drizzleDbRef.current
    .select({ id: objectives.id })
    .from(objectives)
    .where(eq(objectives.project_id, project_id));
  const objectiveIds = objectivesList.map((o: { id: string }) => o.id);
  if (objectiveIds.length === 0) return {};

  // (chat_messages retirement) The `last_user_at` / `last_assistant_at`
  // columns on `conversations` are now maintained by `updateConversationAggregate`
  // write-through (in `db-chats.ts`), so we can read them directly instead of
  // computing `MAX(chat_messages.created_at)` per conversation. The chat_messages
  // table was previously the source of truth for "last user/assistant timestamp";
  // the JSONL transcript is now, and these columns are a fast cache.

  // Get all conversations for those objectives (with the cached aggregates).
  const conversationsList = await drizzleDbRef.current
    .select({
      id: conversations.id,
      objective_id: conversations.objective_id,
      read_at: conversations.read_at,
      last_user_at: conversations.last_user_at,
      last_assistant_at: conversations.last_assistant_at,
      lastAssistantOutcome: conversations.lastAssistantOutcome,
    })
    .from(conversations)
    .where(
      and(
        isNotNull(conversations.objective_id),
        inArray(conversations.objective_id, objectiveIds),
      ),
    );

  if (conversationsList.length === 0) return {};

  // Classify each conversation
  const result: Record<string, 'working' | 'finished' | 'failed' | 'pending'> =
    {};
  const priority = { finished: 1, working: 2, failed: 3, pending: 4 } as const;
  for (const conv of conversationsList) {
    const assistantAt = conv.last_assistant_at ?? undefined;
    const userAt = conv.last_user_at ?? undefined;

    // "working": user sent a message after the last assistant message
    if (userAt && (!assistantAt || userAt > assistantAt)) {
      const current = result[conv.objective_id!];
      if (!current || priority.working > priority[current]) {
        result[conv.objective_id!] = 'working';
      }
      continue;
    }

    // A saved plan remains pending after it has been viewed. The next user
    // instruction (including "Start implementing") moves it to working.
    if (assistantAt && conv.lastAssistantOutcome === 'pending') {
      const current = result[conv.objective_id!];
      if (!current || priority.pending > priority[current]) {
        result[conv.objective_id!] = 'pending';
      }
      continue;
    }

    // "finished": assistant has replied and user hasn't read it yet
    if (assistantAt) {
      if (!conv.read_at || conv.read_at < assistantAt) {
        const candidate =
          conv.lastAssistantOutcome === 'failed' ? 'failed' : 'finished';
        const current = result[conv.objective_id!];
        if (!current || priority[candidate] > priority[current]) {
          result[conv.objective_id!] = candidate;
        }
      }
    }
  }

  return result;
}

function setProjectModeStatus(
  projects: ProjectsStatusSummary['projects'],
  projectId: string,
  mode: 'kanban' | 'chat' | 'objectives',
  status: Exclude<ProjectModeStatus, 'idle'>,
): void {
  const current = projects[projectId] ?? {
    kanban: 'idle',
    chat: 'idle',
    objectives: 'idle',
  };
  if (status === 'working' || current[mode] === 'idle') current[mode] = status;
  projects[projectId] = current;
}

/**
 * Completion events of tasks that are still completed and not archived: the
 * event that moved the task into `completed` from any other status, joined
 * with this user's acknowledgement of that exact event.
 */
/** IDs of a project's stages of type `done`; stage names are user-defined. */
function doneStageIds(projectId: string): string[] {
  return getGroupStages(getGroupByFolder(projectId))
    .filter((stage) => stage.type === 'done')
    .map((stage) => stage.id);
}

/** SQL list for an `in (...)` clause; an empty list yields a never-matching value. */
function sqlStringList(values: readonly string[]) {
  return values.length === 0
    ? sql`''`
    : sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      );
}

/**
 * Matches task_board_events rows that moved a task into a done-type stage from
 * a non-done status, for tasks currently sitting in a done-type stage and not
 * archived since the move. Done
 * stage IDs are resolved per project; projects sharing the same IDs are
 * grouped into one clause.
 */
function completionTransitionCondition(projectIds: readonly string[]) {
  const byDoneIds = new Map<string, { ids: string[]; projects: string[] }>();
  for (const projectId of projectIds) {
    const ids = doneStageIds(projectId);
    if (ids.length === 0) continue;
    const key = ids.join('\0');
    const entry = byDoneIds.get(key) ?? { ids, projects: [] };
    entry.projects.push(projectId);
    byDoneIds.set(key, entry);
  }
  const clauses = [...byDoneIds.values()].map(({ ids, projects }) =>
    and(
      inArray(tasks.project_id, projects),
      inArray(tasks.status, ids),
      inArray(taskBoardEvents.status, ids),
      // A completion that predates the task's latest archive stays hidden
      // after a restore; only a fresh completion counts.
      sql<boolean>`not exists (
        select 1
        from task_board_events archive_event
        where archive_event.task_id = ${taskBoardEvents.task_id}
          and archive_event.id >= ${taskBoardEvents.id}
          and archive_event.snapshot->>'archived' = 'true'
      )`,
      sql<boolean>`coalesce((
        select previous_event.status
        from task_board_events previous_event
        where previous_event.task_id = ${taskBoardEvents.task_id}
          and previous_event.id < ${taskBoardEvents.id}
        order by previous_event.id desc
        limit 1
      ), '') not in (${sqlStringList(ids)})`,
    ),
  );
  return clauses.length > 0 ? or(...clauses) : sql<boolean>`false`;
}

async function selectCompletionEvents(
  userId: string,
  projectIds: readonly string[],
  options: {
    unacknowledgedOnly?: boolean;
    since?: string;
    limit?: number;
  } = {},
) {
  const query = drizzleDbRef.current
    .select({
      projectId: tasks.project_id,
      taskId: tasks.id,
      title: tasks.title,
      eventId: taskBoardEvents.id,
      occurredAt: taskBoardEvents.occurred_at,
      acknowledgedEventId: projectMemberKanbanAcknowledgements.event_id,
    })
    .from(taskBoardEvents)
    .innerJoin(tasks, eq(tasks.id, taskBoardEvents.task_id))
    .leftJoin(
      projectMemberKanbanAcknowledgements,
      and(
        eq(projectMemberKanbanAcknowledgements.event_id, taskBoardEvents.id),
        eq(projectMemberKanbanAcknowledgements.project_id, tasks.project_id),
        eq(projectMemberKanbanAcknowledgements.user_id, userId),
      ),
    )
    .where(
      and(
        inArray(tasks.project_id, [...projectIds]),
        or(isNull(tasks.archived), ne(tasks.archived, 1)),
        options.unacknowledgedOnly
          ? isNull(projectMemberKanbanAcknowledgements.event_id)
          : undefined,
        options.since
          ? gte(taskBoardEvents.occurred_at, options.since)
          : undefined,
        completionTransitionCondition(projectIds),
      ),
    )
    .orderBy(desc(taskBoardEvents.occurred_at), desc(taskBoardEvents.id));
  return options.limit ? query.limit(options.limit) : query;
}

export async function getProjectsStatusSummary(
  userId: string,
  fullAccessProjectIds: readonly string[],
): Promise<ProjectsStatusSummary> {
  const result: ProjectsStatusSummary = { projects: {} };
  const fullAccessProjects = new Set(fullAccessProjectIds);

  // A task-backed active run always belongs to Kanban. Conversation-backed
  // runs are classified by objective ownership rather than the project's
  // selected mode, so all three modes can be active at once.
  const activeRows = await drizzleDbRef.current
    .select({
      projectId: activeRuns.group_folder,
      taskId: activeRuns.task_id,
      scheduledTaskId: activeRuns.scheduled_task_id,
      taskArchived: tasks.archived,
      conversationId: activeRuns.conversation_id,
      objectiveId: conversations.objective_id,
      sharedUserId: conversationMembers.user_id,
    })
    .from(activeRuns)
    .leftJoin(tasks, eq(tasks.id, activeRuns.task_id))
    .leftJoin(conversations, eq(conversations.id, activeRuns.conversation_id))
    .leftJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversation_id, activeRuns.conversation_id),
        eq(conversationMembers.user_id, userId),
      ),
    )
    .where(eq(activeRuns.status, 'running'));

  for (const row of activeRows) {
    if (row.taskId && fullAccessProjects.has(row.projectId)) {
      if (row.taskArchived !== 1) {
        setProjectModeStatus(
          result.projects,
          row.projectId,
          'kanban',
          'working',
        );
      }
    } else if (
      row.conversationId &&
      (fullAccessProjects.has(row.projectId) || row.sharedUserId === userId)
    ) {
      setProjectModeStatus(
        result.projects,
        row.projectId,
        row.objectiveId ? 'objectives' : 'chat',
        'working',
      );
    } else if (row.scheduledTaskId && fullAccessProjects.has(row.projectId)) {
      setProjectModeStatus(result.projects, row.projectId, 'chat', 'working');
    }
  }

  // Conversation read acknowledgement remains the sole source of Chat and
  // Objectives finished state.
  const conversationRows = await drizzleDbRef.current
    .select({
      projectId: conversations.group_folder,
      objectiveId: conversations.objective_id,
      readAt: conversations.read_at,
      assistantAt: conversations.last_assistant_at,
      userAt: conversations.last_user_at,
      sharedUserId: conversationMembers.user_id,
    })
    .from(conversations)
    .leftJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversation_id, conversations.id),
        eq(conversationMembers.user_id, userId),
      ),
    )
    .where(
      and(
        isNotNull(conversations.last_assistant_at),
        sql`${conversations.last_assistant_at} > coalesce(${conversations.read_at}, '')`,
        or(
          isNull(conversations.last_user_at),
          gte(conversations.last_assistant_at, conversations.last_user_at),
        ),
        fullAccessProjectIds.length > 0
          ? or(
              inArray(conversations.group_folder, [...fullAccessProjectIds]),
              eq(conversationMembers.user_id, userId),
            )
          : eq(conversationMembers.user_id, userId),
      ),
    );

  for (const row of conversationRows) {
    if (
      (fullAccessProjects.has(row.projectId) || row.sharedUserId === userId) &&
      row.assistantAt &&
      (!row.userAt || row.assistantAt >= row.userAt) &&
      (!row.readAt || row.readAt < row.assistantAt)
    ) {
      setProjectModeStatus(
        result.projects,
        row.projectId,
        row.objectiveId ? 'objectives' : 'chat',
        'finished',
      );
    }
  }

  // Completion attention is acknowledged by exact event identity. A sequence
  // value orders allocation, not transaction visibility, so a scalar cursor
  // could hide a lower-ID completion that commits after a higher-ID event was
  // acknowledged.
  // Do not scan completion events for projects that cannot affect this
  // user's result. The previous query fetched every completed task in the
  // database and only applied this access filter in memory.
  if (fullAccessProjectIds.length > 0) {
    const completionRows = await selectCompletionEvents(
      userId,
      fullAccessProjectIds,
    );

    for (const row of completionRows) {
      if (row.acknowledgedEventId === null) {
        setProjectModeStatus(
          result.projects,
          row.projectId,
          'kanban',
          'finished',
        );
      }
    }
  }

  return result;
}

export async function acknowledgeKanbanCompletions(
  userId: string,
  projectId: string,
  visibleCompletionEventIds: number[],
): Promise<number | null> {
  const readAcknowledgedEventId = async (): Promise<number | null> => {
    const [acknowledgement] = await drizzleDbRef.current
      .select({
        eventId: sql<
          number | null
        >`max(${projectMemberKanbanAcknowledgements.event_id})`,
      })
      .from(projectMemberKanbanAcknowledgements)
      .where(
        and(
          eq(projectMemberKanbanAcknowledgements.user_id, userId),
          eq(projectMemberKanbanAcknowledgements.project_id, projectId),
        ),
      );
    return acknowledgement?.eventId ?? null;
  };

  if (visibleCompletionEventIds.length === 0) {
    return readAcknowledgedEventId();
  }

  // Event IDs come from the same task-list snapshot that the user saw. Query
  // those exact events rather than the latest event for each task so a card
  // that is reopened and completes again while this request is in flight
  // leaves its newer completion unread.
  const visibleEvents = await drizzleDbRef.current
    .select({ eventId: taskBoardEvents.id })
    .from(taskBoardEvents)
    .innerJoin(tasks, eq(tasks.id, taskBoardEvents.task_id))
    .where(
      and(
        eq(tasks.project_id, projectId),
        inArray(taskBoardEvents.id, visibleCompletionEventIds),
        or(isNull(tasks.archived), ne(tasks.archived, 1)),
        completionTransitionCondition([projectId]),
      ),
    );
  const validEventIds = visibleEvents.map((row) => row.eventId);
  if (validEventIds.length === 0) return readAcknowledgedEventId();

  // Owners commonly have no project_members row. Create preference storage
  // only while projects.user_id proves ownership in this statement;
  // privileged access to a foreign project must never grant membership.
  const now = new Date().toISOString();
  await drizzleDbRef.current.execute(sql`
    insert into project_members (
      user_id,
      project_id,
      access_level,
      created_at
    )
    select ${userId}, ${projectId}, 'owner', ${now}
    from projects
    where id = ${projectId} and user_id = ${userId}
    on conflict (user_id, project_id) do nothing
  `);

  // Persist exact event identities. The membership join and composite foreign
  // key keep access revocation safe, while ON CONFLICT makes retries and
  // concurrent acknowledgements idempotent without imposing event ordering.
  await drizzleDbRef.current
    .insert(projectMemberKanbanAcknowledgements)
    .select(
      drizzleDbRef.current
        .select({
          user_id: projectMembers.user_id,
          project_id: projectMembers.project_id,
          event_id: taskBoardEvents.id,
        })
        .from(taskBoardEvents)
        .innerJoin(
          projectMembers,
          and(
            eq(projectMembers.user_id, userId),
            eq(projectMembers.project_id, projectId),
          ),
        )
        .where(inArray(taskBoardEvents.id, validEventIds)),
    )
    .onConflictDoNothing();

  return readAcknowledgedEventId();
}

/**
 * Tasks waiting on the user (question) or failed that entered that status
 * within the attention window.
 */
export async function getAttentionTasks(
  projectIds: readonly string[],
  windowMs = ATTENTION_WINDOW_MS,
): Promise<
  Array<{
    id: string;
    projectId: string;
    title: string;
    status: string;
    at: string;
  }>
> {
  if (projectIds.length === 0) return [];
  const since = new Date(Date.now() - windowMs).toISOString();
  // Stage entry = first event after the last event with a different status.
  // Later edits of the same status do not move it.
  // Columns are written qualified: drizzle strips the table prefix inside a
  // single-table select, which would capture the subquery's own columns.
  const enteredAt = sql<string>`coalesce((
    select min(entry.occurred_at)
    from task_board_events entry
    where entry.task_id = tasks.id
      and entry.id > coalesce((
        select max(other.id)
        from task_board_events other
        where other.task_id = tasks.id
          and other.status is distinct from tasks.status
      ), 0)
  ), tasks.created_at)`;
  const rows = await drizzleDbRef.current
    .select({
      id: tasks.id,
      projectId: tasks.project_id,
      title: tasks.title,
      status: tasks.status,
      at: enteredAt,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.project_id, [...projectIds]),
        inArray(tasks.status, ['question', 'failed']),
        or(isNull(tasks.archived), ne(tasks.archived, 1)),
        sql`${enteredAt} >= ${since}`,
      ),
    )
    .orderBy(desc(enteredAt))
    .limit(100);
  return rows;
}

function initialStageCondition(projectIds: readonly string[]) {
  const byInitialId = new Map<string, string[]>();
  for (const projectId of new Set(projectIds)) {
    const initialStageId = getInitialStage(
      getGroupStages(getGroupByFolder(projectId)),
    )?.id;
    if (!initialStageId) continue;
    const projectList = byInitialId.get(initialStageId) ?? [];
    projectList.push(projectId);
    byInitialId.set(initialStageId, projectList);
  }
  const clauses = [...byInitialId.entries()].map(([initialStageId, projects]) =>
    and(inArray(tasks.project_id, projects), eq(tasks.status, initialStageId)),
  );
  return clauses.length > 0 ? or(...clauses) : undefined;
}

/**
 * Unmerged, unarchived cards in their project's initial stage that still carry
 * a task branch. Candidates for a parked approved merge; the caller narrows
 * them by transcript.
 */
export async function getUnmergedBranchTasks(
  projectIds: readonly string[],
): Promise<
  Array<{
    id: string;
    projectId: string;
    title: string;
    status: string;
    mergeCommit: string | null;
  }>
> {
  if (projectIds.length === 0) return [];
  const initialStageClause = initialStageCondition(projectIds);
  if (!initialStageClause) return [];
  return drizzleDbRef.current
    .select({
      id: tasks.id,
      projectId: tasks.project_id,
      title: tasks.title,
      status: tasks.status,
      mergeCommit: tasks.merge_commit,
    })
    .from(tasks)
    .where(
      and(
        initialStageClause,
        isNotNull(tasks.branch_name),
        ne(tasks.branch_name, ''),
        or(isNull(tasks.merge_commit), eq(tasks.merge_commit, '')),
        or(isNull(tasks.archived), ne(tasks.archived, 1)),
      ),
    )
    .orderBy(desc(tasks.created_at), desc(tasks.id))
    .limit(200);
}

/** What one user may see in the running Now list, applied before the row limit. */
export interface AttentionRunningScope {
  /** Projects where the user sees every task and conversation run. */
  projectIds: readonly string[];
  /** Conversations shared with the user in projects without full access. */
  sharedConversationIds?: readonly string[];
}

/** Running task and conversation runs visible to the caller. */
export async function getAttentionRunningItems(
  scope: AttentionRunningScope,
): Promise<
  Array<{
    projectId: string;
    startedAt: string;
    taskId: string | null;
    taskTitle: string | null;
    conversationId: string | null;
    conversationTitle: string | null;
    conversationPreview: string | null;
    objectiveId: string | null;
  }>
> {
  const projectIds = scope.projectIds;
  const sharedConversationIds = scope.sharedConversationIds ?? [];
  if (projectIds.length === 0 && sharedConversationIds.length === 0) {
    return [];
  }
  return drizzleDbRef.current
    .select({
      projectId: activeRuns.group_folder,
      startedAt: activeRuns.started_at,
      taskId: tasks.id,
      taskTitle: tasks.title,
      conversationId: conversations.id,
      conversationTitle: conversations.title,
      conversationPreview: conversations.preview,
      objectiveId: conversations.objective_id,
    })
    .from(activeRuns)
    .leftJoin(
      tasks,
      and(
        eq(tasks.id, activeRuns.task_id),
        or(isNull(tasks.archived), ne(tasks.archived, 1)),
      ),
    )
    .leftJoin(conversations, eq(conversations.id, activeRuns.conversation_id))
    .where(
      and(
        eq(activeRuns.status, 'running'),
        or(
          projectIds.length > 0
            ? and(
                inArray(activeRuns.group_folder, [...projectIds]),
                or(isNotNull(tasks.id), isNotNull(conversations.id)),
              )
            : undefined,
          sharedConversationIds.length > 0
            ? and(
                isNull(tasks.id),
                isNotNull(conversations.id),
                inArray(conversations.id, [...sharedConversationIds]),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(desc(activeRuns.started_at))
    .limit(100);
}

/**
 * Task completions within the attention window, one per task. Board
 * acknowledgements are ignored: the Now list keeps a completion until the
 * user dismisses it.
 */
export async function getAttentionCompletedTasks(
  userId: string,
  projectIds: readonly string[],
  options: { windowMs?: number; limit?: number } = {},
): Promise<
  Array<{
    projectId: string;
    taskId: string;
    title: string;
    eventId: number;
    at: string;
  }>
> {
  if (projectIds.length === 0) return [];
  const limit = options.limit ?? 30;
  const rows = await selectCompletionEvents(userId, projectIds, {
    since: new Date(
      Date.now() - (options.windowMs ?? ATTENTION_WINDOW_MS),
    ).toISOString(),
    limit: limit * 2,
  });
  const seen = new Set<string>();
  const result = [];
  for (const row of rows) {
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    result.push({
      projectId: row.projectId,
      taskId: row.taskId,
      title: row.title,
      eventId: row.eventId,
      at: row.occurredAt,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * The user's Now dismissals made within the window, keyed `kind:id` with the
 * dismissal time in epoch ms. Older dismissals cannot hide anything: their
 * rows have already left the attention window.
 */
export async function getNowDismissals(
  userId: string,
  windowMs = ATTENTION_WINDOW_MS,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - windowMs);
  const rows = await drizzleDbRef.current
    .select({
      kind: nowDismissals.kind,
      itemId: nowDismissals.item_id,
      dismissedAt: nowDismissals.dismissedAt,
    })
    .from(nowDismissals)
    .where(
      and(
        eq(nowDismissals.user_id, userId),
        gte(nowDismissals.dismissedAt, since),
      ),
    );
  return new Map(
    rows.map((row) => [`${row.kind}:${row.itemId}`, row.dismissedAt.getTime()]),
  );
}

/** Hide Now rows for this user until they have newer activity. */
export async function dismissNowItems(
  userId: string,
  items: ReadonlyArray<{ kind: 'conversation' | 'task'; id: string }>,
): Promise<void> {
  if (items.length === 0) return;
  await drizzleDbRef.current
    .insert(nowDismissals)
    .values(
      items.map((item) => ({
        user_id: userId,
        kind: item.kind,
        item_id: item.id,
      })),
    )
    .onConflictDoUpdate({
      target: [
        nowDismissals.user_id,
        nowDismissals.kind,
        nowDismissals.item_id,
      ],
      set: { dismissedAt: sql`now()` },
    });
}

export async function updateTask(
  id: string,
  updates: Partial<Omit<Task, 'id' | 'created_at'>>,
  options: {
    suppressStageEntryEvent?: boolean;
    /** Classify a move into the failed stage as a user decision. */
    failureSource?: 'user';
    /**
     * When set, a `stage_variant` update is applied only if the stored status is
     * one of these ids (the project's queue stages). Prevents a variant change
     * from landing on a task a concurrent run has already started.
     */
    requireStageVariantStatuses?: readonly string[];
    /**
     * Synchronous predicate; when it returns true a `stage_variant` update is
     * rejected. Called in the same tick as the write (inside the row-locked
     * transaction when one is used) so an execution claim installed after the
     * check either sees the committed variant on its post-claim re-read or the
     * edit is blocked — the two cannot interleave.
     */
    isExecutionClaimed?: () => boolean;
    /**
     * Treat `custom_values` as a patch merged into the map stored under the
     * task row lock, instead of replacing it. For writers that set a few keys
     * from a snapshot that may be stale by the time the write lands.
     */
    mergeCustomValues?: boolean;
    /**
     * Restart recovery's own stage move for this run's completed result. Any
     * other stage change removes the card's pending-finalization marker; a
     * client cannot pass this option (server code only).
     */
    recoveryRunId?: string;
    /**
     * Atomically remove these keys from `custom_values` under the task row
     * lock. When passed without other field changes on a task that lacks all of
     * these keys, no database update is written.
     */
    omitCustomValueKeys?: readonly string[];
    /**
     * When replacing `custom_values` (`!mergeCustomValues`), copy any existing
     * pipeline-owned keys from the locked row rather than from a pre-lock
     * read (matches task-run credential PATCH semantics).
     */
    preservePipelineOwnedValues?: boolean;
    /**
     * Keys whose presence and value must reflect the locked DB row rather than
     * the incoming `custom_values` payload (e.g. deploy handoff markers), so a
     * stale `update_values` or `PATCH` snapshot can neither restore a consumed
     * marker nor erase an active one.
     */
    preserveCustomValueKeys?: readonly string[];
    /**
     * Reset `testing_failure_count` (and, when `restartRejectionCap` is true,
     * `rejection_cap_base` / `no_progress_count`) under the row lock for a
     * manual Question-stage retry.
     */
    manualQuestionRetry?: { restartRejectionCap: boolean };
  } = {},
): Promise<StageEntryEvent | undefined> {
  const setObj: any = {};
  const allowed = [
    'project_id',
    'title',
    'description',
    'status',
    'priority',
    'runtimeSelection',
    'runtimeSelectionStage',
    'output',
    'error',
    'session_id',
    'depends_on_ids',
    'skip_stages',
    'stageVariant',
    'coStages',
    'abVariants',
    'abParentTaskId',
    'abWinnerTaskId',
    'abForkStage',
    'abForkCommit',
    'execute_in_stage',
    'archived',
    'last_agent_name',
    'custom_values',
    'branch_name',
    'worktree_path',
    'merge_commit',
    'sandbox_instance',
    'started_at',
    'completed_at',
    'objective_id',
    'ownerUserId',
    'lastTriggeredByUserId',
    'lastTriggerSource',
    'lastTriggeredAt',
    'sourceConversationId',
    'sourceRunId',
  ] as const;

  for (const key of allowed) {
    const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
    const val =
      (updates as any)[snakeKey] !== undefined
        ? (updates as any)[snakeKey]
        : (updates as any)[key];
    if (val !== undefined) {
      if (
        (key === 'depends_on_ids' || key === 'skip_stages') &&
        Array.isArray(val)
      ) {
        // Serialize JSON arrays for both deps and skip_stages. Empty
        // arrays are stored as null to match createTask's behavior
        // (which collapses `[]` and unset to the same DB value).
        // parseTask reads both `null` and `'[]'` back to the same shape,
        // so the distinction is purely cosmetic — keep both write paths
        // in sync.
        setObj[key] = val.length > 0 ? JSON.stringify(val) : null;
      } else if (key === 'coStages') {
        setObj.coStages = serializeCoStages(val);
      } else if (key === 'abVariants') {
        if (Array.isArray(val)) {
          setObj.abVariants = val.length > 0 ? JSON.stringify(val) : null;
        } else if (typeof val === 'string') {
          setObj.abVariants = val;
        } else {
          setObj.abVariants = null;
        }
      } else if (
        key === 'custom_values' &&
        typeof val === 'object' &&
        val !== null
      ) {
        setObj[key] = JSON.stringify(val);
      } else if (key === 'runtimeSelection') {
        setObj.runtime_selection = val ? JSON.stringify(val) : null;
      } else if (key === 'archived') {
        setObj[key] = val ? 1 : 0;
      } else {
        setObj[key] = val ?? null;
      }
    }
  }

  const hasOmitKeys = !!options.omitCustomValueKeys?.length;
  const hasManualQuestionRetry = !!options.manualQuestionRetry;
  if (
    Object.keys(setObj).length === 0 &&
    !hasOmitKeys &&
    !hasManualQuestionRetry
  ) {
    return undefined;
  }

  const touchesDependencies =
    Object.prototype.hasOwnProperty.call(setObj, 'depends_on_ids') ||
    Object.prototype.hasOwnProperty.call(setObj, 'project_id');

  const touchesCustomValues =
    Object.prototype.hasOwnProperty.call(setObj, 'custom_values') ||
    hasOmitKeys ||
    hasManualQuestionRetry;

  const shouldCapture =
    touchesCustomValues ||
    REPLAY_VISIBLE_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(updates, field),
    );
  const touchesVariantOrAb =
    Object.prototype.hasOwnProperty.call(setObj, 'stageVariant') ||
    Object.prototype.hasOwnProperty.call(setObj, 'abVariants');
  const stageVariantQueueStatuses =
    options.requireStageVariantStatuses?.length && touchesVariantOrAb
      ? options.requireStageVariantStatuses
      : undefined;
  const queueFieldName = Object.prototype.hasOwnProperty.call(
    setObj,
    'abVariants',
  )
    ? 'ab_variants'
    : 'stage_variant';
  const stageVariantQueueError = () =>
    new Error(
      `Cannot change ${queueFieldName} for task ${id}: it is no longer in a queue stage.`,
    );
  // co_stages follows the same claim guard but has no queue-stage restriction.
  const touchesCoStages = Object.prototype.hasOwnProperty.call(
    setObj,
    'coStages',
  );
  const stageVariantClaimError = () =>
    new Error(
      `Cannot change ${touchesVariantOrAb ? queueFieldName : 'co_stages'} for task ${id}: it is claimed for execution.`,
    );
  const stageVariantEditGuard =
    options.isExecutionClaimed && (touchesVariantOrAb || touchesCoStages)
      ? options.isExecutionClaimed
      : undefined;
  // Dependency or project changes must run through the transactional path so
  // the same-project guard executes after the task row lock; replay-visible
  // fields already force it, and the explicit check keeps that true even if
  // the field list ever drifts. ab_variants must also use the row-locked
  // path to guarantee atomic preconditions under concurrency.
  if (
    !shouldCapture &&
    !touchesDependencies &&
    !Object.prototype.hasOwnProperty.call(setObj, 'abVariants')
  ) {
    if (stageVariantQueueStatuses) {
      if (stageVariantEditGuard?.()) throw stageVariantClaimError();
      const updated = await drizzleDbRef.current
        .update(tasks)
        .set(setObj)
        .where(
          and(
            eq(tasks.id, id),
            inArray(tasks.status, [...stageVariantQueueStatuses]),
          ),
        )
        .returning();
      if (updated.length === 0) throw stageVariantQueueError();
      return;
    }
    // The synchronous claim check and the UPDATE share one event-loop tick.
    if (stageVariantEditGuard?.()) throw stageVariantClaimError();
    await drizzleDbRef.current
      .update(tasks)
      .set(setObj)
      .where(eq(tasks.id, id))
      .execute();
    return;
  }

  let exhaustion: RecoveryBudgetExhaustion | undefined;
  let ackedAttention: AckedAttentionPayload[] = [];
  const result = await drizzleDbRef.current.transaction(async (tx) => {
    exhaustion = undefined;
    ackedAttention = [];
    const identityRows = await tx
      .select({ project_id: tasks.project_id, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, id));
    const projectId = identityRows[0]?.project_id;
    // Archiving resolves receipts, so it takes the project lock first, like
    // a stage migration (project, then receipts, then tasks).
    const changesStageOrProject =
      Object.prototype.hasOwnProperty.call(updates, 'status') ||
      Object.prototype.hasOwnProperty.call(updates, 'project_id');
    if (changesStageOrProject || setObj.archived === 1) {
      const targetProjectId =
        (setObj.project_id as string | null | undefined) ?? projectId;
      await lockProjectStageConfigurations(
        tx,
        [projectId, targetProjectId].filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0,
        ),
      );
      const targetStatus =
        (setObj.status as string | null | undefined) ?? identityRows[0]?.status;
      // An archive-only update must still succeed for a card whose stage was
      // removed from the pipeline, so only stage/project changes assert it.
      if (
        changesStageOrProject &&
        targetProjectId &&
        typeof targetStatus === 'string'
      ) {
        await assertLockedTaskStatus(tx, targetProjectId, targetStatus);
      }
    }
    const beforeRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .for('update');
    const before = parseTask(beforeRows[0]);
    const storedCustomValues = (before?.custom_values ?? {}) as Record<
      string,
      unknown
    >;
    const hasIncomingCustomValues = Object.prototype.hasOwnProperty.call(
      setObj,
      'custom_values',
    );
    const incomingCleared =
      hasIncomingCustomValues && setObj.custom_values === null;
    const hasOmittedStoredKey =
      hasOmitKeys &&
      options.omitCustomValueKeys!.some((key) =>
        Object.prototype.hasOwnProperty.call(storedCustomValues, key),
      );
    const shouldMutateCustomValues =
      hasIncomingCustomValues || hasManualQuestionRetry || hasOmittedStoredKey;

    let flooredCustomValues: Record<string, unknown> | undefined;
    if (shouldMutateCustomValues) {
      let nextValues: Record<string, unknown>;
      if (hasIncomingCustomValues) {
        let incomingMap: Record<string, unknown> = {};
        if (typeof setObj.custom_values === 'string') {
          try {
            const parsed = JSON.parse(setObj.custom_values);
            if (isRecord(parsed)) incomingMap = parsed;
          } catch {
            incomingMap = {};
          }
        }
        nextValues = options.mergeCustomValues
          ? { ...storedCustomValues, ...incomingMap }
          : { ...incomingMap };
      } else {
        nextValues = { ...storedCustomValues };
      }

      if (
        hasIncomingCustomValues &&
        !options.mergeCustomValues &&
        options.preservePipelineOwnedValues
      ) {
        nextValues = withStoredPipelineOwnedValues(
          { task_id: id },
          nextValues,
          storedCustomValues,
        );
      }

      if (options.preserveCustomValueKeys?.length) {
        for (const key of options.preserveCustomValueKeys) {
          if (Object.prototype.hasOwnProperty.call(storedCustomValues, key)) {
            nextValues[key] = storedCustomValues[key];
          } else {
            delete nextValues[key];
          }
        }
      }

      if (hasOmitKeys) {
        for (const key of options.omitCustomValueKeys!) {
          delete nextValues[key];
        }
      }

      if (options.manualQuestionRetry) {
        nextValues[TESTING_FAILURE_COUNT_KEY] = 0;
        if (options.manualQuestionRetry.restartRejectionCap) {
          const count = nextValues.rejection_count;
          nextValues[REJECTION_CAP_BASE_KEY] =
            typeof count === 'number' ? count : 0;
          nextValues.no_progress_count = 0;
        }
      }

      // `testing_failure_total` is a lifetime counter: a replacement map built
      // from a stale snapshot or supplied by a client must never lower it.
      const lockedTotal = storedCustomValues[TESTING_FAILURE_TOTAL_KEY];
      const nextTotal = nextValues[TESTING_FAILURE_TOTAL_KEY];
      if (
        typeof lockedTotal === 'number' &&
        !(typeof nextTotal === 'number' && nextTotal >= lockedTotal)
      ) {
        nextValues[TESTING_FAILURE_TOTAL_KEY] = lockedTotal;
      }

      if (incomingCleared && Object.keys(nextValues).length === 0) {
        setObj.custom_values = null;
      } else {
        flooredCustomValues = nextValues;
        setObj.custom_values = JSON.stringify(nextValues);
      }
    }

    if (Object.keys(setObj).length === 0) {
      return { entryEvent: undefined, resolvedOnArchive: undefined };
    }
    if (
      before &&
      before.project_id !== projectId &&
      (Object.prototype.hasOwnProperty.call(updates, 'status') ||
        Object.prototype.hasOwnProperty.call(updates, 'project_id'))
    ) {
      // A concurrent cross-project move committed between the unlocked
      // identity read and the row lock: lock the task's current project and
      // validate the target status against it.
      const currentTargetProjectId =
        (setObj.project_id as string | null | undefined) ?? before.project_id;
      await lockProjectStageConfigurations(tx, [
        before.project_id,
        currentTargetProjectId,
      ]);
      await assertLockedTaskStatus(
        tx,
        currentTargetProjectId,
        (setObj.status as string | null | undefined) ?? before.status,
      );
    }
    // The row is locked above, so this status is stable for the update below:
    // a variant change can only land while the task is still queued.
    let effectiveQueueStatuses = stageVariantQueueStatuses;
    if (
      !effectiveQueueStatuses &&
      Object.prototype.hasOwnProperty.call(setObj, 'abVariants') &&
      before
    ) {
      const group = getGroupByFolder(before.project_id);
      if (group) {
        const stages = getGroupStages(group);
        effectiveQueueStatuses = stages
          .filter((s) => s.type === 'queue')
          .map((s) => s.id);
      }
    }
    if (
      effectiveQueueStatuses &&
      before &&
      !effectiveQueueStatuses.includes(before.status)
    ) {
      throw stageVariantQueueError();
    }

    if (
      Object.prototype.hasOwnProperty.call(setObj, 'abVariants') &&
      before &&
      (before.ab_fork_commit || before.abForkCommit)
    ) {
      throw new Error(
        'Cannot change ab_variants: experiment has already forked',
      );
    }

    if (stageVariantEditGuard?.()) {
      throw stageVariantClaimError();
    }

    if (
      before &&
      typeof setObj.status === 'string' &&
      setObj.status !== before.status
    ) {
      // Record why the task failed, resolving the failed stage from the
      // locked stage configuration. Other updates leave the keys untouched.
      const stages = await effectiveStageDefinitionsFromLockedProject(
        tx,
        (setObj.project_id as string | null | undefined) ?? before.project_id,
      );
      const failedStage = getFailedStage(stages);
      if (
        failedStage &&
        failedStage.id === setObj.status &&
        isFailedStage(stages, failedStage.id)
      ) {
        // An explicit custom_values update replaces the stored map (callers
        // may remove keys, e.g. an exhausted retry counter), so only fall
        // back to the locked row when the update does not carry one.
        const baseValues = flooredCustomValues ?? before.custom_values ?? {};
        setObj.custom_values = JSON.stringify({
          ...baseValues,
          ...classifyTaskFailure(
            typeof setObj.error === 'string' ? setObj.error : null,
            options.failureSource,
            typeof setObj.description === 'string'
              ? setObj.description
              : before.description,
          ),
        });
      }
    }
    if (before && touchesDependencies) {
      // The task row is locked above: derive the effective post-update
      // project/dependency state from the locked row so neither a
      // concurrent move nor a concurrent update can invalidate the check
      // before the mutation below commits.
      const effectiveProject =
        typeof setObj.project_id === 'string' && setObj.project_id.length > 0
          ? setObj.project_id
          : before.project_id;
      let effectiveDeps: string[];
      if (Object.prototype.hasOwnProperty.call(setObj, 'depends_on_ids')) {
        effectiveDeps =
          typeof setObj.depends_on_ids === 'string'
            ? JSON.parse(setObj.depends_on_ids)
            : [];
      } else {
        effectiveDeps = before.depends_on_ids ?? [];
      }
      await assertSameProjectDependencies(tx, {
        taskLabel: id,
        projectId: effectiveProject,
        dependsOnIds: effectiveDeps,
      });
    }
    // The row is locked above; the synchronous claim check and the UPDATE
    // below share one event-loop tick, so a claim cannot be installed between
    // them and a claim installed before this point rejects the edit.
    if (stageVariantEditGuard?.()) throw stageVariantClaimError();
    const afterRows = await tx
      .update(tasks)
      .set(setObj)
      .where(eq(tasks.id, id))
      .returning();
    const after = parseTask(afterRows[0]);
    const occurredAt = new Date().toISOString();
    let stageEntryEvent: StageEntryEvent | undefined;
    if (
      before &&
      after &&
      (before.project_id !== after.project_id ||
        before.status !== after.status) &&
      // Restoring (archived -> unarchived) must not mint a receipt, even when
      // the same request also changes the status.
      !before.archived &&
      !after.archived &&
      !options.suppressStageEntryEvent
    ) {
      stageEntryEvent = await insertStageEntryEventIfEnabled(
        tx,
        after.project_id,
        after.id,
        after.status,
        occurredAt,
        // A user-triggered transition always fires the hook and opens a new
        // budget window; everything else spends the automatic budget.
        updates.lastTriggerSource === 'user'
          ? undefined
          : {
              task: after,
              onBudgetExhausted: (value) => {
                exhaustion = value;
              },
            },
      );
    }
    if (before && after && replaySnapshotChanged(before, after)) {
      await tx.insert(taskBoardEvents).values({
        project_id: after.project_id,
        task_id: after.id,
        event_type: 'updated',
        occurred_at: occurredAt,
        snapshot: replayTaskSnapshot(after),
      });
    }
    if (
      before &&
      after &&
      (before.project_id !== after.project_id || before.status !== after.status)
    ) {
      const resolved = await resolveTaskStageEntryEvents(
        tx,
        before.id,
        before.project_id,
        after.archived ? undefined : before.status,
        occurredAt,
      );
      await dropPendingFinalizationMarker(
        tx,
        before.project_id,
        before.id,
        options.recoveryRunId,
      );
      const beforeStages = await effectiveStageDefinitionsFromLockedProject(
        tx,
        before.project_id,
      );
      if (isAttentionStage(beforeStages, before.status)) {
        ackedAttention = await ackTaskAttentionPayloads(tx, [id], occurredAt);
      }
      return {
        entryEvent: stageEntryEvent,
        resolvedOnArchive:
          !before.archived && after.archived ? resolved[0] : undefined,
        statusChanged: before.status !== after.status,
      };
    }
    if (before && after && !before.archived && after.archived) {
      const resolved = await resolveTaskStageEntryEvents(
        tx,
        before.id,
        before.project_id,
        undefined,
        occurredAt,
      );
      return {
        entryEvent: undefined,
        resolvedOnArchive: resolved[0],
        statusChanged: false,
      };
    }
    return {
      entryEvent: undefined,
      resolvedOnArchive: undefined,
      statusChanged: false,
    };
  });
  broadcastAckedAttention(ackedAttention);
  notifyStageEntryEventCommitted(result.entryEvent ?? result.resolvedOnArchive);
  if (result.statusChanged)
    for (const listener of taskStatusChangedListeners) listener(id);
  notifyRecoveryBudgetExhausted(exhaustion);
  return result.entryEvent;
}

/**
 * The synchronous callback runs while the project row lock is held. Therefore
 * either an entry event commits before the barrier check, or the normal claim
 * linearizes first and the stage-changing transaction cannot commit until the
 * claim has already been established.
 */

export type NormalTaskAdmission<T> =
  | {
      blockedByEntry: true;
      claim: null;
      taskCheckoutMode?: 'shared' | 'branch' | 'worktree';
      ownerToken?: undefined;
    }
  | {
      blockedByEntry: false;
      claim: T | null;
      taskCheckoutMode: 'shared' | 'branch' | 'worktree';
      ownerToken?: string;
    };

export async function claimNormalTaskAdmission<T>(
  projectId: string,
  claim: (taskCheckoutMode: 'shared' | 'branch' | 'worktree') => T | null,
  ignoreStageEntryBarrier = false,
  admissionId?: string,
  fallbackMode: 'shared' | 'branch' | 'worktree' = 'shared',
  rollbackClaim?: (claim: T) => void,
  failedStageEntryHold?: { taskId: string; stageId: string },
): Promise<NormalTaskAdmission<T>> {
  let provisionalClaim: T | null = null;
  try {
    return await drizzleDbRef.current.transaction(async (tx) => {
      await lockProjectStageConfiguration(tx, projectId);
      const [project] = await tx
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const settings = project?.settings
        ? parseProjectSettings(project.settings)
        : undefined;
      const rawMode = settings?.taskCheckoutMode;
      const taskCheckoutMode: 'shared' | 'branch' | 'worktree' =
        rawMode === 'shared' || rawMode === 'branch' || rawMode === 'worktree'
          ? rawMode
          : fallbackMode;
      const [barrier] = ignoreStageEntryBarrier
        ? []
        : await tx
            .select({ id: stageEntryEvents.id })
            .from(stageEntryEvents)
            .where(
              and(
                eq(stageEntryEvents.project_id, projectId),
                inArray(stageEntryEvents.state, BLOCKING_STAGE_ENTRY_STATES),
              ),
            )
            .limit(1);
      const [failedTaskHold] = failedStageEntryHold
        ? await tx
            .select({ id: stageEntryEvents.id })
            .from(stageEntryEvents)
            .where(
              and(
                eq(stageEntryEvents.project_id, projectId),
                eq(stageEntryEvents.task_id, failedStageEntryHold.taskId),
                eq(stageEntryEvents.stage_id, failedStageEntryHold.stageId),
                eq(stageEntryEvents.state, 'failed'),
              ),
            )
            .limit(1)
        : [];
      const result = barrier
        ? { blockedByEntry: true as const, claim: null }
        : failedTaskHold
          ? {
              blockedByEntry: false as const,
              claim: null,
              taskCheckoutMode,
            }
          : {
              blockedByEntry: false as const,
              claim: claim(taskCheckoutMode),
              taskCheckoutMode,
            };
      provisionalClaim = result.claim;
      const ownerToken = result.claim && admissionId ? randomUUID() : undefined;
      if (ownerToken && admissionId) {
        const persisted = project?.settings
          ? (JSON.parse(project.settings) as Record<string, unknown>)
          : {};
        const admissions =
          persisted._checkoutAdmissions &&
          typeof persisted._checkoutAdmissions === 'object'
            ? { ...(persisted._checkoutAdmissions as Record<string, unknown>) }
            : {};
        admissions[admissionId] = { taskCheckoutMode, ownerToken };
        await tx
          .update(projects)
          .set({
            settings: JSON.stringify({
              ...persisted,
              _checkoutAdmissions: admissions,
            }),
          })
          .where(eq(projects.id, projectId));
      }
      return !result.blockedByEntry && ownerToken
        ? { ...result, ownerToken }
        : result;
    });
  } catch (error) {
    if (provisionalClaim !== null) rollbackClaim?.(provisionalClaim);
    throw error;
  }
}

/** Bind an admitted task to the exact run that crossed the launch boundary. */
export async function bindTaskAdmissionRun(
  projectId: string,
  taskId: string,
  runId: string,
  ownerToken?: string,
): Promise<void> {
  await withProjectAdmissionLock(projectId, async (tx) => {
    const [project] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project?.settings) return;
    const persisted = JSON.parse(project.settings) as Record<string, unknown>;
    const admissions = persisted._checkoutAdmissions;
    if (!admissions || typeof admissions !== 'object') return;
    const current = (admissions as Record<string, unknown>)[taskId];
    if (current === undefined) return;
    const currentOwner =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>).ownerToken
        : undefined;
    if (currentOwner !== ownerToken) return;
    const taskCheckoutMode =
      typeof current === 'string'
        ? current
        : current && typeof current === 'object'
          ? (current as Record<string, unknown>).taskCheckoutMode
          : undefined;
    if (
      taskCheckoutMode !== 'shared' &&
      taskCheckoutMode !== 'branch' &&
      taskCheckoutMode !== 'worktree'
    ) {
      return;
    }
    await tx
      .update(projects)
      .set({
        settings: JSON.stringify({
          ...persisted,
          _checkoutAdmissions: {
            ...(admissions as Record<string, unknown>),
            [taskId]: {
              taskCheckoutMode,
              runId,
              ...(ownerToken ? { ownerToken } : {}),
            },
          },
        }),
      })
      .where(eq(projects.id, projectId));
  });
}

/**
 * Whether an inline (Direct LLM) conversation turn of the project is admitted.
 * Those turns have no sandbox run and no active_runs row; their admission is
 * recorded under a `conversation:` key from before the turn starts until it
 * ends.
 */
export async function hasInlineConversationAdmission(
  projectId: string,
): Promise<boolean> {
  const [project] = await drizzleDbRef.current
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project?.settings) return false;
  const admissions = (JSON.parse(project.settings) as Record<string, unknown>)
    ._checkoutAdmissions;
  return (
    !!admissions &&
    typeof admissions === 'object' &&
    Object.keys(admissions).some((id) => id.startsWith('conversation:'))
  );
}

export type TaskAdmissionSnapshot = Map<
  string,
  Map<string, string | undefined>
>;

/** Capture admission owners before recovery reads runs or accepts new claims. */
export async function snapshotTaskAdmissionOwners(): Promise<TaskAdmissionSnapshot> {
  const rows = await drizzleDbRef.current
    .select({ id: projects.id, settings: projects.settings })
    .from(projects);
  const snapshot: TaskAdmissionSnapshot = new Map();
  for (const row of rows) {
    if (!row.settings) continue;
    const admissions = (JSON.parse(row.settings) as Record<string, unknown>)
      ._checkoutAdmissions;
    if (!admissions || typeof admissions !== 'object') continue;
    const owners = new Map<string, string | undefined>();
    for (const [id, entry] of Object.entries(admissions)) {
      const token =
        entry && typeof entry === 'object'
          ? (entry as Record<string, unknown>).ownerToken
          : undefined;
      owners.set(id, typeof token === 'string' ? token : undefined);
    }
    snapshot.set(row.id, owners);
  }
  return snapshot;
}

/** Drop one admission entry when its owner token matches; true when dropped. */
function dropTaskAdmission(
  persisted: Record<string, unknown>,
  admissionId: string,
  ownerToken: string | undefined,
): boolean {
  const admissions = persisted._checkoutAdmissions;
  if (!admissions || typeof admissions !== 'object') return false;
  const current = (admissions as Record<string, unknown>)[admissionId];
  const currentOwner =
    current && typeof current === 'object'
      ? (current as Record<string, unknown>).ownerToken
      : undefined;
  if (currentOwner !== ownerToken) return false;
  const next = { ...(admissions as Record<string, unknown>) };
  delete next[admissionId];
  if (Object.keys(next).length > 0) persisted._checkoutAdmissions = next;
  else delete persisted._checkoutAdmissions;
  return true;
}

export async function releaseTaskAdmission(
  projectId: string,
  admissionId: string,
  ownerToken?: string,
): Promise<void> {
  await withProjectAdmissionLock(projectId, async (tx) => {
    const [project] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project?.settings) return;
    const persisted = JSON.parse(project.settings) as Record<string, unknown>;
    if (!dropTaskAdmission(persisted, admissionId, ownerToken)) return;
    await tx
      .update(projects)
      .set({ settings: JSON.stringify(persisted) })
      .where(eq(projects.id, projectId));
  });
}
export async function recoverStaleTaskAdmissions(
  snapshot?: TaskAdmissionSnapshot,
): Promise<void> {
  snapshot ??= await snapshotTaskAdmissionOwners();
  const activeRunRows = await drizzleDbRef.current
    .select({
      projectId: activeRuns.group_folder,
      taskId: activeRuns.task_id,
      conversationId: activeRuns.conversation_id,
      chatJid: activeRuns.chat_jid,
    })
    .from(activeRuns)
    .where(eq(activeRuns.status, 'running'));
  const activeByProject = new Map<string, Set<string>>();
  for (const run of activeRunRows) {
    const ids = activeByProject.get(run.projectId) ?? new Set<string>();
    if (run.taskId) ids.add(run.taskId);
    if (run.conversationId) ids.add(`conversation:${run.conversationId}`);
    else if (run.chatJid)
      ids.add(`conversation:${run.projectId}:${run.chatJid}`);
    activeByProject.set(run.projectId, ids);
  }
  for (const [projectId, owners] of snapshot) {
    const activeIds = activeByProject.get(projectId) ?? new Set<string>();
    await withProjectAdmissionLock(projectId, async (tx) => {
      const [current] = await tx
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!current?.settings) return;
      const persisted = JSON.parse(current.settings) as Record<string, unknown>;
      const admissions = persisted._checkoutAdmissions;
      if (!admissions || typeof admissions !== 'object') return;
      const next = Object.fromEntries(
        Object.entries(admissions).filter(([id, entry]) => {
          const token =
            entry && typeof entry === 'object'
              ? (entry as Record<string, unknown>).ownerToken
              : undefined;
          return (
            activeIds.has(id) || !owners.has(id) || token !== owners.get(id)
          );
        }),
      );
      if (Object.keys(next).length === Object.keys(admissions).length) return;
      // The retry key of a completed run is written in the transaction that
      // drops its admission, so the run is never left without either. When
      // this boot recorded its pending runs, a run that completed later (and
      // was finalized by the stalled-run path) gets no marker.
      const recorded = bootPendingRunIds.get(snapshot);
      const existing = readPendingFinalizationMarkers(persisted);
      applyPendingFinalizationMarkers(
        persisted,
        pendingFinalizationMarkers(
          (
            await collectPendingFinalizationRuns(tx, projectId, persisted)
          ).filter(
            (run) =>
              !recorded ||
              recorded.has(run.id) ||
              existing.get(run.task_id)?.runId === run.id,
          ),
        ),
      );
      if (Object.keys(next).length > 0) persisted._checkoutAdmissions = next;
      else delete persisted._checkoutAdmissions;
      await tx
        .update(projects)
        .set({ settings: JSON.stringify(persisted) })
        .where(eq(projects.id, projectId));
    });
  }
}

/**
 * Retry key of a completed run whose boot finalization has not settled. It is
 * stored in the settings of the run's own project, so a project rename moves
 * it together with the run.
 */
export interface PendingFinalizationMarker {
  runId: string;
}

/** A completed run boot recovery owes a finalization, with how it was found. */
export type PendingFinalizationRun = ActiveRun & {
  task_id: string;
  /** The task's durable admission is bound to this exact run. */
  admitted: boolean;
};

function readPendingFinalizationMarkers(
  persisted: Record<string, unknown>,
): Map<string, PendingFinalizationMarker> {
  const markers = new Map<string, PendingFinalizationMarker>();
  const raw = persisted[PENDING_FINALIZATION_KEY];
  if (!raw || typeof raw !== 'object') return markers;
  for (const [taskId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const { runId } = entry as Record<string, unknown>;
    if (typeof runId === 'string') markers.set(taskId, { runId });
  }
  return markers;
}

/** Task by bound run id, from the task admissions of one project. */
function admittedTaskByRunId(admissions: unknown): Map<string, string> {
  const byRun = new Map<string, string>();
  if (!admissions || typeof admissions !== 'object') return byRun;
  for (const [taskId, admission] of Object.entries(admissions)) {
    if (
      taskId.startsWith('conversation:') ||
      !admission ||
      typeof admission !== 'object'
    ) {
      continue;
    }
    const runId = (admission as Record<string, unknown>).runId;
    if (typeof runId === 'string') byRun.set(runId, taskId);
  }
  return byRun;
}

/** Completed runs of one project reachable through its admissions or markers. */
async function collectPendingFinalizationRuns(
  db: Pick<typeof drizzleDbRef.current, 'select'>,
  projectId: string,
  persisted: Record<string, unknown>,
): Promise<PendingFinalizationRun[]> {
  const admitted = admittedTaskByRunId(persisted._checkoutAdmissions);
  const markers = readPendingFinalizationMarkers(persisted);
  const taskByRunId = new Map(admitted);
  for (const [taskId, marker] of markers) taskByRunId.set(marker.runId, taskId);
  if (taskByRunId.size === 0) return [];
  const rows = await db
    .select()
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, projectId),
        eq(activeRuns.status, 'completed'),
        inArray(activeRuns.id, [...taskByRunId.keys()]),
      ),
    );
  const runs: PendingFinalizationRun[] = [];
  for (const row of rows) {
    if (!row.task_id || taskByRunId.get(row.id) !== row.task_id) continue;
    runs.push({
      ...(row as ActiveRun),
      task_id: row.task_id,
      admitted: admitted.get(row.id) === row.task_id,
    });
  }
  return runs;
}

/**
 * One marker per task. A run that still owns the task's admission is the
 * task's current run and wins over an older run left behind by an earlier boot.
 */
function pendingFinalizationMarkers(
  runs: PendingFinalizationRun[],
): Record<string, PendingFinalizationMarker> {
  const markers: Record<string, PendingFinalizationMarker> = {};
  for (const run of [...runs].sort(
    (a, b) => Number(a.admitted) - Number(b.admitted),
  )) {
    markers[run.task_id] = { runId: run.id };
  }
  return markers;
}

/** Set or drop the marker map in project settings; true when it changed. */
function applyPendingFinalizationMarkers(
  persisted: Record<string, unknown>,
  markers: Record<string, unknown>,
): boolean {
  if (
    JSON.stringify(markers) ===
    JSON.stringify(persisted[PENDING_FINALIZATION_KEY] ?? {})
  ) {
    return false;
  }
  if (Object.keys(markers).length > 0) {
    persisted[PENDING_FINALIZATION_KEY] = markers;
  } else {
    delete persisted[PENDING_FINALIZATION_KEY];
  }
  return true;
}

/**
 * Find successful task runs that boot recovery still owes a finalization:
 * runs that still own a durable checkout admission, and runs recorded in the
 * project's pending-finalization markers.
 *
 * A successful launch can be persisted before its prompt-delivery receipt.
 * The admission remains durable until the executor unwinds, so it bounds the
 * boot-time reconciliation to runs that may be in that crash window instead
 * of scanning the complete active_runs history. The marker keeps such a run
 * findable after the admission is released by a boot whose finalization of it
 * did not settle.
 */
export async function getCompletedTaskRunsForStaleAdmissions(): Promise<
  PendingFinalizationRun[]
> {
  const projectRows = await drizzleDbRef.current
    .select({ id: projects.id, settings: projects.settings })
    .from(projects);
  const runs: PendingFinalizationRun[] = [];
  for (const project of projectRows) {
    if (!project.settings) continue;
    runs.push(
      ...(await collectPendingFinalizationRuns(
        drizzleDbRef.current,
        project.id,
        JSON.parse(project.settings) as Record<string, unknown>,
      )),
    );
  }
  return runs;
}

/**
 * Runs that were already completed when a boot recorded its markers, keyed by
 * that boot's admission snapshot. A run still `running` then is finalized by
 * the stalled-run path in the same boot and must not get a marker later.
 */
const bootPendingRunIds = new WeakMap<TaskAdmissionSnapshot, Set<string>>();

/**
 * Record a retry marker for every completed run that still owns an admission,
 * and drop markers whose run is gone or no longer completed (deleted task).
 * Runs first in boot recovery so that a failure in any later pass still leaves
 * the run findable on the next boot. `recoverStaleTaskAdmissions` writes the
 * same markers in the transaction that releases the admission, so a failure
 * here never leaves an admission released without its marker. Once every
 * project is recorded, the recorded runs are registered for `snapshot`.
 */
export async function recordPendingFinalizationRuns(
  snapshot?: TaskAdmissionSnapshot,
): Promise<void> {
  const projectRows = await drizzleDbRef.current
    .select({ id: projects.id, settings: projects.settings })
    .from(projects);
  const candidates = projectRows.filter((project) => {
    if (!project.settings) return false;
    const initial = JSON.parse(project.settings) as Record<string, unknown>;
    return !!initial._checkoutAdmissions || !!initial[PENDING_FINALIZATION_KEY];
  });
  // Eligibility is the runs completed now and is registered before any marker
  // is written: a failed write must not leave a run that completes later in
  // this boot eligible for a marker.
  const recorded = new Set<string>();
  for (const project of candidates) {
    const runs = await collectPendingFinalizationRuns(
      drizzleDbRef.current,
      project.id,
      JSON.parse(project.settings!) as Record<string, unknown>,
    );
    for (const run of runs) recorded.add(run.id);
  }
  if (snapshot) bootPendingRunIds.set(snapshot, recorded);
  // One project's failed write must not keep later projects from getting
  // theirs; the first failure is still reported.
  let firstError: unknown;
  for (const project of candidates) {
    try {
      await withProjectAdmissionLock(project.id, async (tx) => {
        const [current] = await tx
          .select({ settings: projects.settings })
          .from(projects)
          .where(eq(projects.id, project.id))
          .limit(1);
        if (!current?.settings) return;
        const persisted = JSON.parse(current.settings) as Record<
          string,
          unknown
        >;
        const runs = await collectPendingFinalizationRuns(
          tx,
          project.id,
          persisted,
        );
        if (
          !applyPendingFinalizationMarkers(
            persisted,
            pendingFinalizationMarkers(runs),
          )
        ) {
          return;
        }
        await tx
          .update(projects)
          .set({ settings: JSON.stringify(persisted) })
          .where(eq(projects.id, project.id));
      });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

/**
 * Settle a completed run: drop its marker and, when given, the admission it
 * still owns, in one transaction. A settled run can then never be rediscovered
 * through either and replayed.
 */
export async function settlePendingFinalizationRun(
  projectId: string,
  taskId: string,
  runId: string,
  admission?: { ownerToken?: string },
): Promise<void> {
  await withProjectAdmissionLock(projectId, async (tx) => {
    const [project] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project?.settings) return;
    const persisted = JSON.parse(project.settings) as Record<string, unknown>;
    const markers = readPendingFinalizationMarkers(persisted);
    if (markers.get(taskId)?.runId === runId) markers.delete(taskId);
    const markerDropped = applyPendingFinalizationMarkers(
      persisted,
      Object.fromEntries(markers),
    );
    const admissionDropped = admission
      ? dropTaskAdmission(persisted, taskId, admission.ownerToken)
      : false;
    if (!markerDropped && !admissionDropped) return;
    await tx
      .update(projects)
      .set({ settings: JSON.stringify(persisted) })
      .where(eq(projects.id, projectId));
  });
}

/**
 * A card that changes stage ends the stage visit its pending finalization was
 * recorded for, so a later return to the same stage must not revive the old
 * result. Removes the card's marker, except for the stage move recovery makes
 * itself for that run (`keepRunId`). The caller holds the project row lock.
 */
async function dropPendingFinalizationMarker(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  projectId: string,
  taskId: string,
  keepRunId?: string,
): Promise<void> {
  const [project] = await tx
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project?.settings?.includes(PENDING_FINALIZATION_KEY)) return;
  const persisted = JSON.parse(project.settings) as Record<string, unknown>;
  const markers = readPendingFinalizationMarkers(persisted);
  const marker = markers.get(taskId);
  if (!marker || marker.runId === keepRunId) return;
  markers.delete(taskId);
  applyPendingFinalizationMarkers(persisted, Object.fromEntries(markers));
  await tx
    .update(projects)
    .set({ settings: JSON.stringify(persisted) })
    .where(eq(projects.id, projectId));
}

/** Execute project admission work while holding the same row lock used by task claims. */
export async function withProjectAdmissionLock<T>(
  projectId: string,
  operation: (
    tx: Parameters<typeof lockProjectStageConfiguration>[0],
  ) => Promise<T>,
): Promise<T> {
  return drizzleDbRef.current.transaction(async (tx) => {
    await lockProjectStageConfiguration(tx, projectId);
    return operation(tx);
  });
}
export class ProjectAdmissionConflictError extends Error {
  constructor() {
    super(
      'Cannot change taskCheckoutMode while a task execution or admission is active',
    );
    this.name = 'ProjectAdmissionConflictError';
  }
}

function hasTaskCheckoutAdmission(admissions: unknown): boolean {
  return (
    !!admissions &&
    typeof admissions === 'object' &&
    Object.keys(admissions).some((id) => !id.startsWith('conversation:'))
  );
}

async function assertNoTaskCheckoutActivity(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  projectId: string,
  admissions: unknown,
): Promise<void> {
  if (hasTaskCheckoutAdmission(admissions)) {
    throw new ProjectAdmissionConflictError();
  }
  const [activeTaskRun] = await tx
    .select({ id: activeRuns.id })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.group_folder, projectId),
        eq(activeRuns.status, 'running'),
        isNotNull(activeRuns.task_id),
      ),
    )
    .limit(1);
  if (activeTaskRun) throw new ProjectAdmissionConflictError();
}

/** Throw ProjectAdmissionConflictError when a task checkout or run blocks a checkout-mode change. */
export async function assertTaskCheckoutModeChangeAllowed(
  projectId: string,
): Promise<void> {
  await withProjectAdmissionLock(projectId, async (tx) => {
    const [project] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const admissions = project?.settings
      ? (JSON.parse(project.settings) as Record<string, unknown>)
          ._checkoutAdmissions
      : undefined;
    await assertNoTaskCheckoutActivity(tx, projectId, admissions);
  });
}

/** Patch the SSH preference without overwriting concurrently saved settings or secrets. */
export async function updateProjectSshPreference(
  projectId: string,
  enabled: boolean,
): Promise<void> {
  await patchProjectSettings(projectId, { sshEnabled: enabled });
}

/** Assign the CarapaBox host for a project (undefined → the local box). */
export async function updateProjectBoxId(
  projectId: string,
  boxId: string | undefined,
): Promise<void> {
  await patchProjectSettings(projectId, { boxId: boxId || undefined });
}

/** Patch controller-owned publication state without overwriting other settings. */
export async function updateProjectAppPublication(
  projectId: string,
  publication: import('../../types.js').AppPublicationSettings,
): Promise<void> {
  await patchProjectSettings(projectId, { appPublication: publication });
}

/**
 * Set (or, for `undefined`, remove) keys of a project's stored settings and
 * return the previous value of each key, so the patch can be undone by passing
 * the result back. Throws when the project row is missing.
 */
export async function patchProjectSettings(
  projectId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withProjectAdmissionLock(projectId, async (tx) => {
    const [project] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new Error('Project not found');
    const settings = parseProjectSettings(project.settings);
    const previous: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      previous[key] = settings[key];
      if (value === undefined) delete settings[key];
      else settings[key] = value;
    }
    await tx
      .update(projects)
      .set({ settings: JSON.stringify(settings) })
      .where(eq(projects.id, projectId));
    return previous;
  });
}

export async function updateProjectSettingsWithAdmissionLock(
  projectId: string,
  serializedSettings: string,
): Promise<void> {
  await withProjectAdmissionLock(projectId, async (tx) => {
    const [project] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const currentSettings = parseProjectSettings(project?.settings ?? null);
    const nextSettings = parseProjectSettings(serializedSettings);
    const modeChanged =
      Object.prototype.hasOwnProperty.call(
        nextSettings ?? {},
        'taskCheckoutMode',
      ) &&
      nextSettings?.taskCheckoutMode !==
        (currentSettings?.taskCheckoutMode ?? 'shared');
    const admissions = project?.settings
      ? (JSON.parse(project.settings) as Record<string, unknown>)
          ._checkoutAdmissions
      : undefined;
    if (modeChanged) {
      await assertNoTaskCheckoutActivity(tx, projectId, admissions);
    }
    const nextPersisted = nextSettings ?? {};
    // Ordinary form saves cannot change the dedicated live SSH preference.
    nextPersisted.sshEnabled = currentSettings.sshEnabled === true;
    nextPersisted.appPublication = currentSettings.appPublication;
    nextPersisted.whatsappSelfChatAutoLinkDisabled =
      currentSettings.whatsappSelfChatAutoLinkDisabled;
    // Box placement is admin-only (dedicated endpoint), never a form field.
    nextPersisted.boxId = currentSettings.boxId;
    if (
      project?.settings &&
      !Object.prototype.hasOwnProperty.call(
        nextPersisted,
        '_checkoutAdmissions',
      )
    ) {
      const currentPersisted = JSON.parse(project.settings) as Record<
        string,
        unknown
      >;
      if (currentPersisted._checkoutAdmissions) {
        (nextPersisted as Record<string, unknown>)._checkoutAdmissions =
          currentPersisted._checkoutAdmissions;
      }
      if (currentPersisted[PENDING_FINALIZATION_KEY]) {
        (nextPersisted as Record<string, unknown>)[PENDING_FINALIZATION_KEY] =
          currentPersisted[PENDING_FINALIZATION_KEY];
      }
    }
    await tx
      .update(projects)
      .set({ settings: JSON.stringify(nextPersisted) })
      .where(eq(projects.id, projectId));
  });
}

/** Clear stale output only if a claimed entry event still owns its task stage. */
export async function prepareStageEntryEventIfOwned(
  eventId: string,
): Promise<boolean> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [identity] = await tx
      .select({ projectId: stageEntryEvents.project_id })
      .from(stageEntryEvents)
      .where(eq(stageEntryEvents.id, eventId))
      .limit(1);
    if (!identity) return false;
    await lockProjectStageConfiguration(tx, identity.projectId);
    const [eventRow] = await tx
      .select()
      .from(stageEntryEvents)
      .where(eq(stageEntryEvents.id, eventId))
      .for('update');
    if (!eventRow || eventRow.state !== 'claimed') return false;
    const rows = await tx
      .update(tasks)
      .set({ error: '', output: '' })
      .where(
        and(
          eq(tasks.id, eventRow.task_id),
          eq(tasks.project_id, eventRow.project_id),
          eq(tasks.status, eventRow.stage_id),
          eq(tasks.archived, 0),
        ),
      )
      .returning();
    if (rows.length !== 1) {
      await tx
        .update(stageEntryEvents)
        .set({ state: 'resolved', completed_at: new Date().toISOString() })
        .where(
          and(
            eq(stageEntryEvents.id, eventId),
            eq(stageEntryEvents.state, 'claimed'),
          ),
        );
      return false;
    }
    return true;
  });
}

/** Atomically persist a terminal entry outcome only while it owns the stage. */
export async function completeStageEntryEventIfOwned(input: {
  eventId: string;
  state: 'succeeded' | 'failed';
  output: string;
  error: string | null;
  lastAgentName: string | null;
  sessionId?: string;
}): Promise<{ event: StageEntryEvent; task: Task } | undefined> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [identity] = await tx
      .select({ projectId: stageEntryEvents.project_id })
      .from(stageEntryEvents)
      .where(eq(stageEntryEvents.id, input.eventId))
      .limit(1);
    if (!identity) return undefined;
    await lockProjectStageConfiguration(tx, identity.projectId);

    const [eventRow] = await tx
      .select()
      .from(stageEntryEvents)
      .where(eq(stageEntryEvents.id, input.eventId))
      .for('update');
    const eventOwnsStage =
      eventRow?.state === 'running' ||
      (input.state === 'failed' && eventRow?.state === 'claimed');
    if (!eventRow || !eventOwnsStage) return undefined;

    const [ownedTaskRow] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, eventRow.task_id),
          eq(tasks.project_id, eventRow.project_id),
          eq(tasks.status, eventRow.stage_id),
        ),
      )
      .for('update');
    if (!ownedTaskRow) return undefined;

    const allowedStateCondition =
      input.state === 'failed'
        ? inArray(stageEntryEvents.state, ['claimed', 'running'])
        : eq(stageEntryEvents.state, 'running');
    const [updatedEventRow] = await tx
      .update(stageEntryEvents)
      .set({
        state: input.state,
        completed_at: new Date().toISOString(),
        error: input.error,
      })
      .where(and(eq(stageEntryEvents.id, input.eventId), allowedStateCondition))
      .returning();
    if (!updatedEventRow) return undefined;

    const [updatedTaskRow] = await tx
      .update(tasks)
      .set({
        output: input.output,
        error: input.state === 'succeeded' ? '' : input.error,
        last_agent_name: input.lastAgentName,
        ...(input.sessionId === undefined
          ? {}
          : { session_id: input.sessionId }),
        ...(input.state === 'failed' ? { completed_at: null } : {}),
      })
      .where(
        and(
          eq(tasks.id, eventRow.task_id),
          eq(tasks.project_id, eventRow.project_id),
          eq(tasks.status, eventRow.stage_id),
        ),
      )
      .returning();
    if (!updatedTaskRow) {
      throw new Error(
        `Stage-entry event ${input.eventId} lost task ownership during completion`,
      );
    }
    const event = parseStageEntryEvent(updatedEventRow);
    const task = parseTask(updatedTaskRow);
    return event && task ? { event, task } : undefined;
  });
}

/** Find the durable stage-entry identity linked to one active run. */
export async function getStageEntryEventById(
  eventId: string,
): Promise<StageEntryEvent | undefined> {
  const [row] = await drizzleDbRef.current
    .select()
    .from(stageEntryEvents)
    .where(eq(stageEntryEvents.id, eventId))
    .limit(1);
  return parseStageEntryEvent(row);
}

/** Find the newest receipt for the task's current stage entry. */
export async function getCurrentStageEntryEvent(
  taskId: string,
  projectId: string,
  stageId: string,
): Promise<StageEntryEvent | undefined> {
  const [row] = await drizzleDbRef.current
    .select()
    .from(stageEntryEvents)
    .where(
      and(
        eq(stageEntryEvents.task_id, taskId),
        eq(stageEntryEvents.project_id, projectId),
        eq(stageEntryEvents.stage_id, stageId),
      ),
    )
    .orderBy(desc(stageEntryEvents.created_at), desc(stageEntryEvents.id))
    .limit(1);
  return parseStageEntryEvent(row);
}

/** Persist the lifecycle notification requested for a stage entry. */
export async function recordStageEntryLifecycleNotification(
  eventId: string,
  notification: StageEntryLifecycleNotification,
): Promise<StageEntryEvent | undefined> {
  const [row] = await drizzleDbRef.current
    .update(stageEntryEvents)
    .set({ lifecycle_notification: JSON.stringify(notification) })
    .where(
      and(
        eq(stageEntryEvents.id, eventId),
        inArray(stageEntryEvents.state, [
          'pending',
          'claimed',
          'running',
          'succeeded',
        ]),
        isNull(stageEntryEvents.lifecycle_notification),
      ),
    )
    .returning();
  return parseStageEntryEvent(row) ?? getStageEntryEventById(eventId);
}

/** Find the durable stage-entry identity linked to one active run. */
export async function getStageEntryEventByRunId(
  runId: string,
): Promise<StageEntryEvent | undefined> {
  const [row] = await drizzleDbRef.current
    .select()
    .from(stageEntryEvents)
    .where(eq(stageEntryEvents.run_id, runId))
    .limit(1);
  return parseStageEntryEvent(row);
}

/** Atomically claim the oldest eligible receipt for a project. */
export async function claimNextStageEntryEvent(
  projectId: string,
  recoverClaimedBefore: string,
): Promise<StageEntryEvent | undefined> {
  const claimedAt = new Date().toISOString();
  while (true) {
    const heldIds = [...heldStageEntryEventIds];
    const notHeld = heldIds.length
      ? sql`AND ${stageEntryEvents.id} NOT IN (${sql.join(
          heldIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
    const rows = await executeRows<typeof stageEntryEvents.$inferSelect>(sql`
      WITH candidate AS (
        SELECT id
        FROM ${stageEntryEvents}
        WHERE ${stageEntryEvents.project_id} = ${projectId}
          ${notHeld}
          AND (
            ${stageEntryEvents.state} = 'pending'
            OR (
              ${stageEntryEvents.state} = 'claimed'
              AND ${stageEntryEvents.run_id} IS NULL
              AND ${stageEntryEvents.claimed_at} < ${recoverClaimedBefore}
            )
          )
        ORDER BY ${stageEntryEvents.created_at} ASC, ${stageEntryEvents.id} ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${stageEntryEvents}
      SET state = 'claimed', claimed_at = ${claimedAt}, completed_at = NULL, error = NULL
      WHERE id = (SELECT id FROM candidate)
      RETURNING *
    `);
    const row = rows[0];
    if (!row) return undefined;
    // The hold is set before the migration commit, so a claim that only saw
    // the receipt after that commit may have built its exclusion list earlier.
    // Give such a claim back and retry with the current hold set.
    if (heldStageEntryEventIds.has(row.id)) {
      await releaseStageEntryEventClaim(row.id);
      continue;
    }
    return parseStageEntryEvent(row);
  }
}

/**
 * Receipts this process must not claim yet. In-memory only: a restart drops
 * the hold. Only the held receipts are skipped, so wakes for other receipts
 * in the same project keep draining.
 */
const heldStageEntryEventIds = new Set<string>();

/** Stop holding the receipts, then wake the drain for each of them. */
export function releaseAndNotifyStageEntryEvents(
  events: readonly StageEntryEvent[],
): void {
  for (const event of events) heldStageEntryEventIds.delete(event.id);
  for (const event of events) notifyStageEntryEventCommitted(event);
}

/** Release an unlinked claim when another task run still owns execution. */
export async function releaseStageEntryEventClaim(
  eventId: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .update(stageEntryEvents)
    .set({ state: 'pending', claimed_at: null })
    .where(
      and(
        eq(stageEntryEvents.id, eventId),
        eq(stageEntryEvents.state, 'claimed'),
        isNull(stageEntryEvents.run_id),
      ),
    )
    .returning();
  return rows.length === 1;
}

/** Mark a claimed receipt as executing, optionally linking its active run. */
export async function markStageEntryEventRunning(
  eventId: string,
  runId?: string,
): Promise<StageEntryEvent | undefined> {
  // A card archived after the claim must not start its entry run: refuse the
  // transition and resolve the receipt instead.
  const archivedTask = (archived: 0 | 1) =>
    drizzleDbRef.current
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stageEntryEvents.task_id),
          eq(tasks.archived, archived),
        ),
      );
  const [row] = await drizzleDbRef.current
    .update(stageEntryEvents)
    .set({
      state: 'running',
      ...(runId === undefined ? {} : { run_id: runId }),
    })
    .where(
      and(
        eq(stageEntryEvents.id, eventId),
        eq(stageEntryEvents.state, 'claimed'),
        notExists(archivedTask(1)),
      ),
    )
    .returning();
  if (!row) {
    await drizzleDbRef.current
      .update(stageEntryEvents)
      .set({ state: 'resolved', completed_at: new Date().toISOString() })
      .where(
        and(
          eq(stageEntryEvents.id, eventId),
          eq(stageEntryEvents.state, 'claimed'),
          exists(archivedTask(1)),
        ),
      );
  }
  return parseStageEntryEvent(row);
}

/** Persist a claimed or running receipt failure for operator attention. */
export async function markStageEntryEventFailed(
  eventId: string,
  error: string,
): Promise<StageEntryEvent | undefined> {
  const [row] = await drizzleDbRef.current
    .update(stageEntryEvents)
    .set({
      state: 'failed',
      completed_at: new Date().toISOString(),
      error,
    })
    .where(
      and(
        eq(stageEntryEvents.id, eventId),
        inArray(stageEntryEvents.state, ['claimed', 'running']),
      ),
    )
    .returning();
  return parseStageEntryEvent(row);
}

/** Explicitly dismiss an unresolved entry receipt. */
export async function resolveStageEntryEvent(
  eventId: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .update(stageEntryEvents)
    .set({ state: 'resolved', completed_at: new Date().toISOString() })
    .where(
      and(
        eq(stageEntryEvents.id, eventId),
        inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES),
      ),
    )
    .returning();
  return rows.length === 1;
}

/** Resolve barriers whose task is archived or no longer in the recorded project and stage. */
export async function resolveStaleStageEntryEvents(
  projectId?: string,
): Promise<number> {
  const rows = await drizzleDbRef.current
    .update(stageEntryEvents)
    .set({ state: 'resolved', completed_at: new Date().toISOString() })
    .where(
      and(
        projectId ? eq(stageEntryEvents.project_id, projectId) : undefined,
        inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES),
        notExists(
          drizzleDbRef.current
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.id, stageEntryEvents.task_id),
                eq(tasks.project_id, stageEntryEvents.project_id),
                eq(tasks.status, stageEntryEvents.stage_id),
                eq(tasks.archived, 0),
              ),
            ),
        ),
      ),
    )
    .returning();
  return rows.length;
}

/** Reconcile claim-to-run links without deciding terminal task semantics. */
export async function reconcileStageEntryEventRuns(): Promise<{
  linked: number;
  released: number;
}> {
  return drizzleDbRef.current.transaction(async (tx) => {
    // A crash can land after runContainerAgent inserts active_runs but before
    // onSlotAcquired links the claimed receipt. Match only runs created after
    // the claim for the same task/project/stage so an older ordinary run cannot
    // be mistaken for this entry event.
    const unlinkedClaims = await tx
      .select({
        eventId: stageEntryEvents.id,
        taskId: stageEntryEvents.task_id,
        projectId: stageEntryEvents.project_id,
        stageId: stageEntryEvents.stage_id,
        claimedAt: stageEntryEvents.claimed_at,
      })
      .from(stageEntryEvents)
      .where(
        and(
          eq(stageEntryEvents.state, 'claimed'),
          isNull(stageEntryEvents.run_id),
          isNotNull(stageEntryEvents.claimed_at),
        ),
      );
    let linked = 0;
    for (const claim of unlinkedClaims) {
      if (!claim.claimedAt) continue;
      const [run] = await tx
        .select({ id: activeRuns.id })
        .from(activeRuns)
        .where(
          and(
            eq(activeRuns.task_id, claim.taskId),
            eq(activeRuns.group_folder, claim.projectId),
            eq(activeRuns.stage, claim.stageId),
            gte(activeRuns.started_at, claim.claimedAt),
          ),
        )
        .orderBy(desc(activeRuns.started_at))
        .limit(1);
      if (!run) continue;
      const rows = await tx
        .update(stageEntryEvents)
        .set({ state: 'running', run_id: run.id })
        .where(
          and(
            eq(stageEntryEvents.id, claim.eventId),
            eq(stageEntryEvents.state, 'claimed'),
            isNull(stageEntryEvents.run_id),
          ),
        )
        .returning();
      linked += rows.length;
    }

    const missingRunRows = await tx
      .select({
        eventId: stageEntryEvents.id,
        linkedRunId: activeRuns.id,
      })
      .from(stageEntryEvents)
      .leftJoin(activeRuns, eq(activeRuns.id, stageEntryEvents.run_id))
      .where(eq(stageEntryEvents.state, 'running'));
    const releasedIds = missingRunRows
      .filter((row) => row.linkedRunId === null)
      .map((row) => row.eventId);
    const released = releasedIds.length
      ? await tx
          .update(stageEntryEvents)
          .set({
            state: 'pending',
            claimed_at: null,
            run_id: null,
            completed_at: null,
            error: null,
          })
          .where(
            and(
              inArray(stageEntryEvents.id, releasedIds),
              eq(stageEntryEvents.state, 'running'),
            ),
          )
          .returning()
      : [];
    return { linked, released: released.length };
  });
}

/** Terminal linked runs whose task-visible entry outcome still needs recovery. */
export async function getTerminalStageEntryRunEvents(): Promise<
  Array<{
    event: StageEntryEvent;
    runStatus: 'completed' | 'error' | 'timeout' | 'stalled';
  }>
> {
  const rows = await drizzleDbRef.current
    .select({ event: stageEntryEvents, runStatus: activeRuns.status })
    .from(stageEntryEvents)
    .innerJoin(activeRuns, eq(activeRuns.id, stageEntryEvents.run_id))
    .where(
      and(
        eq(stageEntryEvents.state, 'running'),
        inArray(activeRuns.status, [
          'completed',
          'error',
          'timeout',
          'stalled',
        ]),
      ),
    );
  return rows.flatMap((row) => {
    const event = parseStageEntryEvent(row.event);
    if (!event || !row.runStatus || row.runStatus === 'running') return [];
    return [{ event, runStatus: row.runStatus }];
  });
}
/** List every receipt that still needs execution or operator attention. */
export async function getUnresolvedStageEntryEvents(
  projectId?: string,
): Promise<StageEntryEvent[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(stageEntryEvents)
    .where(
      and(
        projectId ? eq(stageEntryEvents.project_id, projectId) : undefined,
        inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES),
      ),
    )
    .orderBy(asc(stageEntryEvents.created_at), asc(stageEntryEvents.id));
  return rows
    .map(parseStageEntryEvent)
    .filter((event): event is StageEntryEvent => event !== undefined);
}

/** List nonterminal receipts that block project-wide normal admission. */
export async function getBlockingStageEntryEvents(
  projectId?: string,
): Promise<StageEntryEvent[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(stageEntryEvents)
    .where(
      and(
        projectId ? eq(stageEntryEvents.project_id, projectId) : undefined,
        inArray(stageEntryEvents.state, BLOCKING_STAGE_ENTRY_STATES),
      ),
    )
    .orderBy(asc(stageEntryEvents.created_at), asc(stageEntryEvents.id));
  return rows
    .map(parseStageEntryEvent)
    .filter((event): event is StageEntryEvent => event !== undefined);
}

/** List projects that need entry-receipt scheduling or operator attention. */
export async function getProjectsWithUnresolvedStageEntryEvents(): Promise<
  string[]
> {
  const rows = await drizzleDbRef.current
    .selectDistinct({ projectId: stageEntryEvents.project_id })
    .from(stageEntryEvents)
    .where(inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES))
    .orderBy(asc(stageEntryEvents.project_id));
  return rows.map((row) => row.projectId);
}
/**
 * Archive or restore many project tasks in one database round trip.
 * Returns only tasks whose archived state actually changed.
 */
export async function updateTasksArchived(
  projectId: string,
  ids: string[],
  archived: boolean,
): Promise<Task[]> {
  if (ids.length === 0) return [];

  const result = await drizzleDbRef.current.transaction(async (tx) => {
    // Same lock order as a stage migration: project, then receipts, then tasks.
    if (archived) await lockProjectStageConfiguration(tx, projectId);
    const rows = await tx
      .update(tasks)
      .set({ archived: archived ? 1 : 0 })
      .where(
        and(
          eq(tasks.project_id, projectId),
          inArray(tasks.id, ids),
          ne(tasks.archived, archived ? 1 : 0),
        ),
      )
      .returning();
    const changed = parseTasks(rows);
    let resolvedEntryEvent: StageEntryEvent | undefined;
    if (changed.length > 0) {
      const occurredAt = new Date().toISOString();
      await tx.insert(taskBoardEvents).values(
        changed.map((task) => ({
          project_id: task.project_id,
          task_id: task.id,
          event_type: 'updated' as const,
          occurred_at: occurredAt,
          snapshot: replayTaskSnapshot(task),
        })),
      );
      if (archived) {
        const resolvedRows = await tx
          .update(stageEntryEvents)
          .set({ state: 'resolved', completed_at: occurredAt })
          .where(
            and(
              eq(stageEntryEvents.project_id, projectId),
              inArray(
                stageEntryEvents.task_id,
                changed.map((task) => task.id),
              ),
              inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES),
            ),
          )
          .returning();
        resolvedEntryEvent = parseStageEntryEvent(resolvedRows[0]);
      }
    }
    return { changed, resolvedEntryEvent };
  });
  notifyStageEntryEventCommitted(result.resolvedEntryEvent);
  return attachTaskAttribution(result.changed);
}

/**
 * Commit stage migrations and the prospective project settings in one DB
 * transaction. Callers broadcast only after this promise succeeds.
 */
/**
 * How a project's derived objective working directories change with its
 * parent: the directory an objective has before and after, from the project's
 * sandbox mount (see `objectiveWorkDirFor`). Supplied by the caller, who
 * resolves ownership against the registry.
 */
export interface ObjectiveWorkDirChange {
  before(objectiveId: string): string;
  after(objectiveId: string): string;
}

/**
 * Objective working directories are container paths stored per objective.
 * When the parent changes, the ones still holding the derived value follow; a
 * custom directory is left alone. Part of the transaction that saves the
 * parent, so the two cannot disagree.
 */
async function rewriteObjectiveWorkDirs(
  tx: Parameters<typeof lockProjectStageConfiguration>[0],
  projectId: string,
  change: ObjectiveWorkDirChange,
): Promise<void> {
  const rows = await tx
    .select({ id: objectives.id, work_dir: objectives.work_dir })
    .from(objectives)
    .where(eq(objectives.project_id, projectId));
  for (const row of rows) {
    if (row.work_dir !== change.before(row.id)) continue;
    const next = change.after(row.id);
    if (next === row.work_dir) continue;
    await tx
      .update(objectives)
      .set({ work_dir: next })
      .where(eq(objectives.id, row.id));
  }
}

export async function commitProjectStageMigration(
  projectId: string,
  settingsJson: string | null,
  migrations: readonly {
    sourceStageId: string;
    destinationStageId: string;
  }[],
  _removedStageIds: readonly string[] | undefined,
  parentId: string | null | undefined,
  objectiveWorkDirs: ObjectiveWorkDirChange | undefined,
  committedPlacement: { sshEnabled?: boolean; boxId?: string } | undefined,
  options: { excludeArchived?: boolean; deferStageEntryNotifications: true },
): Promise<{ tasks: Task[]; entryEvents: StageEntryEvent[] }>;
export async function commitProjectStageMigration(
  projectId: string,
  settingsJson: string | null,
  migrations: readonly {
    sourceStageId: string;
    destinationStageId: string;
  }[],
  _removedStageIds?: readonly string[],
  parentId?: string | null,
  objectiveWorkDirs?: ObjectiveWorkDirChange,
  committedPlacement?: { sshEnabled?: boolean; boxId?: string },
  options?: { excludeArchived?: boolean; deferStageEntryNotifications?: false },
): Promise<Task[]>;
export async function commitProjectStageMigration(
  projectId: string,
  settingsJson: string | null,
  migrations: readonly {
    sourceStageId: string;
    destinationStageId: string;
  }[],
  _removedStageIds: readonly string[] = migrations.map(
    (migration) => migration.sourceStageId,
  ),
  parentId?: string | null,
  objectiveWorkDirs?: ObjectiveWorkDirChange,
  committedPlacement?: { sshEnabled?: boolean; boxId?: string },
  options: {
    excludeArchived?: boolean;
    deferStageEntryNotifications?: boolean;
  } = {},
): Promise<Task[] | { tasks: Task[]; entryEvents: StageEntryEvent[] }> {
  let ackedAttention: AckedAttentionPayload[] = [];
  const result = await drizzleDbRef.current.transaction(async (tx) => {
    await lockProjectStageConfigurations(
      tx,
      [projectId, parentId].filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      ),
    );
    const prospectiveSettings = parseProjectSettings(settingsJson);
    const [projectRow] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const currentSettings = parseProjectSettings(projectRow?.settings ?? null);
    const persistedInput = settingsJson
      ? (JSON.parse(settingsJson) as Record<string, unknown>)
      : {};
    const modeChanged =
      Object.prototype.hasOwnProperty.call(
        persistedInput,
        'taskCheckoutMode',
      ) &&
      prospectiveSettings?.taskCheckoutMode !== undefined &&
      prospectiveSettings.taskCheckoutMode !==
        (currentSettings?.taskCheckoutMode ?? 'shared');
    const admissions = projectRow?.settings
      ? (JSON.parse(projectRow.settings) as Record<string, unknown>)
          ._checkoutAdmissions
      : undefined;
    if (modeChanged) {
      await assertNoTaskCheckoutActivity(tx, projectId, admissions);
    }
    if (admissions && typeof admissions === 'object') {
      persistedInput._checkoutAdmissions = admissions;
    }
    const pendingFinalization = projectRow?.settings
      ? (JSON.parse(projectRow.settings) as Record<string, unknown>)[
          PENDING_FINALIZATION_KEY
        ]
      : undefined;
    if (pendingFinalization && typeof pendingFinalization === 'object') {
      persistedInput[PENDING_FINALIZATION_KEY] = pendingFinalization;
    }
    persistedInput.appPublication = currentSettings?.appPublication;
    persistedInput.whatsappSelfChatAutoLinkDisabled =
      currentSettings?.whatsappSelfChatAutoLinkDisabled;
    // The SSH preference and box placement have dedicated endpoints; a stage or
    // parent save must not revert a change that committed after its snapshot.
    for (const key of ['sshEnabled', 'boxId'] as const) {
      if (Object.prototype.hasOwnProperty.call(currentSettings, key)) {
        persistedInput[key] = currentSettings[key];
      } else {
        delete persistedInput[key];
      }
    }
    if (committedPlacement) {
      committedPlacement.sshEnabled = currentSettings.sshEnabled === true;
      committedPlacement.boxId = currentSettings.boxId as string | undefined;
    }
    const settingsToPersist =
      Object.keys(persistedInput).length > 0
        ? JSON.stringify(persistedInput)
        : settingsJson;
    const parentIdWasSupplied = parentId !== undefined;
    const currentStageIds = await effectiveStageIdsFromLockedProject(
      tx,
      projectId,
    );
    const prospectiveStageIds = await effectiveStageIdsFromLockedProject(
      tx,
      projectId,
      prospectiveSettings,
      parentIdWasSupplied ? parentId : undefined,
    );
    const prospectiveSet = new Set(prospectiveStageIds);
    const removedStageIds = currentStageIds.filter(
      (stageId) => !prospectiveSet.has(stageId),
    );
    const migrationSources = new Set<string>();
    for (const migration of migrations) {
      if (
        migrationSources.has(migration.sourceStageId) ||
        !removedStageIds.includes(migration.sourceStageId) ||
        !prospectiveSet.has(migration.destinationStageId)
      ) {
        const error = new Error(
          `Invalid stage migration from "${migration.sourceStageId}" to "${migration.destinationStageId}" for the current pipeline`,
        );
        error.name = 'StageMigrationValidationError';
        throw error;
      }
      migrationSources.add(migration.sourceStageId);
    }
    const occupied = removedStageIds.length
      ? await tx
          .select({ status: tasks.status, count: count() })
          .from(tasks)
          .where(
            and(
              eq(tasks.project_id, projectId),
              inArray(tasks.status, removedStageIds),
              options.excludeArchived ? eq(tasks.archived, 0) : undefined,
            ),
          )
          .groupBy(tasks.status)
      : [];
    const missing = occupied.filter(
      (row) =>
        !migrations.some((migration) => migration.sourceStageId === row.status),
    );
    if (missing.length > 0) {
      const details = missing
        .map(
          ({ status, count: cardCount }) =>
            `"${status}" (${Number(cardCount)} ${Number(cardCount) === 1 ? 'card' : 'cards'})`,
        )
        .join(', ');
      const error = new Error(
        `Cannot remove occupied stages: ${details}. Move these cards to stages in the new pipeline first.`,
      );
      error.name = 'StageRemovalConflictError';
      throw error;
    }
    const changedRows: any[] = [];
    const migratedTasksForEntry: Task[] = [];
    const statusChangedTaskIds: string[] = [];
    const attentionStages = await effectiveStageDefinitionsFromLockedProject(
      tx,
      projectId,
    );
    const leftAttentionTaskIds: string[] = [];
    const migrationCompletedAt = new Date().toISOString();
    for (const migration of migrations) {
      await tx
        .update(stageEntryEvents)
        .set({ state: 'resolved', completed_at: migrationCompletedAt })
        .where(
          and(
            eq(stageEntryEvents.project_id, projectId),
            eq(stageEntryEvents.stage_id, migration.sourceStageId),
            inArray(stageEntryEvents.state, UNRESOLVED_STAGE_ENTRY_STATES),
          ),
        );
      const rows = await tx
        .update(tasks)
        .set({ status: migration.destinationStageId })
        .where(
          and(
            eq(tasks.project_id, projectId),
            eq(tasks.status, migration.sourceStageId),
          ),
        )
        .returning();
      changedRows.push(...rows);
      if (migration.sourceStageId !== migration.destinationStageId) {
        statusChangedTaskIds.push(...rows.map((row) => row.id));
      }
      for (const task of parseTasks(rows)) {
        if (!task.archived) migratedTasksForEntry.push(task);
      }
      if (
        migration.sourceStageId !== migration.destinationStageId &&
        isAttentionStage(attentionStages, migration.sourceStageId)
      ) {
        leftAttentionTaskIds.push(...rows.map((row) => row.id));
      }
    }
    ackedAttention = await ackTaskAttentionPayloads(
      tx,
      leftAttentionTaskIds,
      migrationCompletedAt,
    );
    const prospectiveStages = await effectiveStageDefinitionsFromLockedProject(
      tx,
      projectId,
      prospectiveSettings,
      parentIdWasSupplied ? parentId : undefined,
    );
    const currentStages = await effectiveStageDefinitionsFromLockedProject(
      tx,
      projectId,
    );
    const migratedIds = new Set(changedRows.map((row) => row.id));
    const semanticRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.project_id, projectId));
    for (const row of semanticRows) {
      if (migratedIds.has(row.id)) continue;
      const currentType = findStage(currentStages, row.status)?.type;
      const nextType = findStage(prospectiveStages, row.status)?.type;
      if (currentType && nextType && currentType !== nextType) {
        changedRows.push(row);
      }
    }
    const changedTasks = parseTasks(changedRows);
    if (changedTasks.length > 0) {
      const occurredAt = new Date().toISOString();
      await tx.insert(taskBoardEvents).values(
        changedTasks.map((task) => ({
          project_id: task.project_id,
          task_id: task.id,
          event_type: 'updated' as const,
          occurred_at: occurredAt,
          snapshot: replayTaskSnapshot(task),
        })),
      );
    }
    const projectUpdate: {
      settings: string | null;
      parentId?: string | null;
    } = { settings: settingsToPersist };
    if (parentId !== undefined) projectUpdate.parentId = parentId;
    await tx
      .update(projects)
      .set(projectUpdate)
      .where(eq(projects.id, projectId));
    if (parentId !== undefined && objectiveWorkDirs) {
      await rewriteObjectiveWorkDirs(tx, projectId, objectiveWorkDirs);
    }
    const entryEvents: StageEntryEvent[] = [];
    for (const task of migratedTasksForEntry) {
      const entryEvent = await insertStageEntryEventIfEnabled(
        tx,
        projectId,
        task.id,
        task.status,
        migrationCompletedAt,
      );
      if (entryEvent) entryEvents.push(entryEvent);
    }
    if (options.deferStageEntryNotifications) {
      // Hold before the commit makes the receipts visible to any drain. If
      // the commit fails the ids match no row, so the entries are inert.
      for (const event of entryEvents) heldStageEntryEventIds.add(event.id);
    }
    return { changedTasks, entryEvents, statusChangedTaskIds };
  });
  broadcastAckedAttention(ackedAttention);
  for (const taskId of result.statusChangedTaskIds) {
    for (const listener of taskStatusChangedListeners) listener(taskId);
  }
  if (!options.deferStageEntryNotifications) {
    for (const entryEvent of result.entryEvents) {
      notifyStageEntryEventCommitted(entryEvent);
    }
  }
  const changed = result.changedTasks;
  // The transaction has committed, including the project's parent: a failure
  // of this display-only enrichment must not read as a failed save (a caller
  // that moved files for the new parent would undo them).
  let attributed: Task[];
  try {
    attributed = await attachTaskAttribution(changed);
  } catch (err) {
    logger.warn(
      { projectId, err },
      'Task attribution failed after a committed stage migration',
    );
    attributed = changed;
  }
  return options.deferStageEntryNotifications
    ? { tasks: attributed, entryEvents: result.entryEvents }
    : attributed;
}

/** Append review feedback without replacing the task's original description. */
export async function appendTaskReviewFeedback(
  id: string,
  feedback: ReviewFeedback,
): Promise<Task | undefined> {
  const task = await getTask(id);
  if (!task) return undefined;
  const checklist = feedback.nits
    .map((nit) => `- [ ] **${nit.title}** — ${nit.description}`)
    .join('\n');
  const block = [
    '## Review notes',
    '',
    `- Reviewer: ${feedback.reviewer || 'unknown'}`,
    `- Verdict: ${feedback.verdict}`,
    `- Timestamp: ${feedback.timestamp}`,
    '',
    '### Nits',
    checklist || '- [ ] (none listed)',
  ].join('\n');
  const description = task.description
    ? `${task.description.trim()}\n\n${block}`
    : block;
  await updateTask(id, { description });
  return getTask(id);
}

export async function deleteTask(id: string): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .for('update');
    const taskRow = rows[0];
    const task = parseTask(taskRow);

    if (task) {
      await tx.insert(taskBoardEvents).values({
        project_id: task.project_id,
        task_id: task.id,
        event_type: 'deleted',
        occurred_at: new Date().toISOString(),
        snapshot: replayTaskSnapshot(task),
      });
    }

    await tx.delete(activeRuns).where(eq(activeRuns.task_id, id));
    await tx.delete(taskMessages).where(eq(taskMessages.task_id, id));
    await tx.delete(taskRunLogs).where(eq(taskRunLogs.task_id, id));
    await tx.delete(tasks).where(eq(tasks.id, id));

    if (
      taskRow?.dataset_task_id &&
      taskRow.dataset_row_index != null &&
      taskRow.dataset_generation != null
    ) {
      // Release only this row's live spawn claim. Deleting an older dataset
      // card after progress has moved on must not reopen the current row.
      await tx
        .update(datasetTasks)
        .set({ spawned_row_index: -1 })
        .where(
          and(
            eq(datasetTasks.id, taskRow.dataset_task_id),
            eq(datasetTasks.current_row_index, taskRow.dataset_row_index),
            eq(datasetTasks.spawned_row_index, taskRow.dataset_row_index),
            eq(datasetTasks.generation, taskRow.dataset_generation),
          ),
        );
    }
  });
}

/**
 * Move a task to a different project. Updates `project_id`, status, and
 * dependency list in a single transaction. Clears `branch_name`,
 * `worktree_path`, `sandbox_instance`, and `merge_commit` defensively —
 * these are tied to the source project's repo and must not follow the task
 * across projects.
 *
 * Note: this is reference-only — `task_messages` rows stay under the task_id
 * (cascade) but the on-disk transcript file remains in the source project's
 * `transcripts/` directory. Callers are responsible for the empty-transcript
 * UX on the receiving project.
 *
 * Returns the moved task and the IDs of source-project dependents whose
 * `depends_on_ids` had `taskId` removed, or undefined if the task no longer exists.
 */
export async function moveTaskToProject(
  taskId: string,
  targetProjectId: string,
  newStatus: string,
  filteredDeps: string[],
  expectedSourceProjectId?: string,
): Promise<{ task: Task; releasedDependentIds: string[] } | undefined> {
  let ackedAttention: AckedAttentionPayload[] = [];
  const result = await drizzleDbRef.current.transaction(async (tx) => {
    ackedAttention = [];
    const releasedDependentIds: string[] = [];
    const identityRows = await tx
      .select({ project_id: tasks.project_id })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const initialSourceProjectId = identityRows[0]?.project_id;
    await lockProjectStageConfigurations(
      tx,
      [expectedSourceProjectId, initialSourceProjectId, targetProjectId].filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      ),
    );
    await assertLockedTaskStatus(tx, targetProjectId, newStatus);
    const beforeRows = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for('update');
    const before = parseTask(beforeRows[0]);
    if (!before) {
      return undefined;
    }
    if (
      expectedSourceProjectId !== undefined &&
      before.project_id !== expectedSourceProjectId
    ) {
      throw new TaskSourceProjectMismatchError(taskId, expectedSourceProjectId);
    }
    const sourceProjectId = before.project_id;
    const afterRows = await tx
      .update(tasks)
      .set({
        project_id: targetProjectId,
        status: newStatus,
        depends_on_ids: JSON.stringify(filteredDeps),
        branch_name: null,
        worktree_path: null,
        sandbox_instance: null,
        merge_commit: null,
      })
      .where(eq(tasks.id, taskId))
      .returning();
    const after = parseTask(afterRows[0]);
    if (sourceProjectId && sourceProjectId !== targetProjectId) {
      // Source-project dependents must not keep a reference to a task that now
      // lives in another project: the scheduler treats a missing dependency
      // as satisfied and the shared write guard rejects the edge.
      const dependentRows = await tx
        .select({ id: tasks.id, depends_on_ids: tasks.depends_on_ids })
        .from(tasks)
        .where(
          and(
            eq(tasks.project_id, sourceProjectId),
            ne(tasks.id, taskId),
            sql`strpos(${tasks.depends_on_ids}, ${taskId}) > 0`,
          ),
        )
        .for('update');
      for (const dependent of dependentRows) {
        let deps: unknown;
        try {
          deps = JSON.parse(dependent.depends_on_ids ?? '[]');
        } catch {
          continue;
        }
        if (!Array.isArray(deps) || !deps.includes(taskId)) continue;
        const remaining = deps.filter((id) => id !== taskId);
        await tx
          .update(tasks)
          .set({
            depends_on_ids: remaining.length ? JSON.stringify(remaining) : null,
          })
          .where(eq(tasks.id, dependent.id));
        releasedDependentIds.push(dependent.id);
      }
    }
    let entryEvent: StageEntryEvent | undefined;
    if (after) {
      const occurredAt = new Date().toISOString();
      await tx.insert(taskBoardEvents).values([
        {
          project_id: before.project_id,
          task_id: before.id,
          event_type: 'deleted',
          occurred_at: occurredAt,
          snapshot: replayTaskSnapshot(before),
        },
        {
          project_id: after.project_id,
          task_id: after.id,
          event_type: 'created',
          occurred_at: occurredAt,
          snapshot: replayTaskSnapshot(after),
        },
      ]);
      if (
        before.project_id !== after.project_id ||
        before.status !== after.status
      ) {
        await resolveTaskStageEntryEvents(
          tx,
          before.id,
          before.project_id,
          before.status,
          occurredAt,
        );
        entryEvent = await insertStageEntryEventIfEnabled(
          tx,
          after.project_id,
          after.id,
          after.status,
          occurredAt,
        );
        const beforeStages = await effectiveStageDefinitionsFromLockedProject(
          tx,
          before.project_id,
        );
        if (isAttentionStage(beforeStages, before.status)) {
          ackedAttention = await ackTaskAttentionPayloads(
            tx,
            [before.id],
            occurredAt,
          );
        }
      }
    }
    const attachedMoved = after
      ? (await attachTaskAttribution([after], tx))[0]
      : undefined;
    return { moved: attachedMoved, entryEvent, releasedDependentIds };
  });
  if (!result) return undefined;
  broadcastAckedAttention(ackedAttention);
  notifyStageEntryEventCommitted(result.entryEvent);
  if (!result.moved) return undefined;
  return {
    task: result.moved,
    releasedDependentIds: result.releasedDependentIds,
  };
}

export async function deleteProjectData(folder: string): Promise<void> {
  // Run the cascade of deletes inside a single transaction so a mid-cascade
  // failure (e.g. one of the child tables errors) doesn't leave the project
  // half-deleted with orphaned rows. Propagate failures so the route does not
  // continue with irreversible filesystem cleanup and project unregistering.
  await drizzleDbRef.current.transaction(async (tx) => {
    const taskIds = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.project_id, folder));
    const taskIdList = taskIds.map((t) => t.id);

    if (taskIdList.length > 0) {
      await tx
        .delete(activeRuns)
        .where(inArray(activeRuns.task_id, taskIdList));
    }
    await tx
      .delete(activeRuns)
      .where(
        and(eq(activeRuns.group_folder, folder), isNull(activeRuns.task_id)),
      );
    await tx.delete(cronjobs).where(eq(cronjobs.project_id, folder));
    await tx.delete(datasetTasks).where(eq(datasetTasks.project_id, folder));
    await tx.delete(tasks).where(eq(tasks.project_id, folder));
    // The chat_messages table was retired and dropped by migration
    // 0002. Conversation rows are still deleted here so the project
    // cleanup completes; the FK from chat_messages → conversations is
    // gone, so this is now a leaf delete.
    await tx
      .delete(conversations)
      .where(eq(conversations.group_folder, folder));
    await tx
      .delete(scheduledTasks)
      .where(eq(scheduledTasks.group_folder, folder));
    await tx.delete(memories).where(eq(memories.group_folder, folder));
    await tx.delete(objectives).where(eq(objectives.project_id, folder));
    await tx.delete(fileFavorites).where(eq(fileFavorites.project_id, folder));
    await tx
      .delete(fileFavoriteMoves)
      .where(eq(fileFavoriteMoves.project_id, folder));
  });
}

function generateCronjobId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `cron-${Date.now()}-${rand}`;
}

function parseCronjob(source: any): Cronjob | undefined {
  if (!source) return undefined;
  const row: any = { ...source };
  if (typeof row.runtime_selection === 'string') {
    row.runtimeSelection = parseStoredRuntimeSelection(row.runtime_selection);
  } else {
    row.runtimeSelection = null;
  }
  delete row.runtime_selection;
  return row as Cronjob;
}

/**
 * Run an insert/update that writes `objective_id` under the objective's shared
 * lock, so it cannot interleave with a move of that objective to another project.
 */
async function withObjectiveScopeLock(
  objective_id: string | null | undefined,
  project_id: string | undefined,
  write: (db: typeof drizzleDbRef.current) => PromiseLike<unknown>,
): Promise<void> {
  if (!objective_id) {
    await write(drizzleDbRef.current);
    return;
  }
  await drizzleDbRef.current.transaction(async (tx) => {
    if (project_id) {
      await assertObjectiveInProjectShared(tx, objective_id, project_id);
    }
    await write(tx as unknown as typeof drizzleDbRef.current);
  });
}

export async function createCronjob(
  data: Omit<Cronjob, 'id' | 'created_at'>,
): Promise<Cronjob> {
  const id = generateCronjobId();
  const created_at = new Date().toISOString();
  await withObjectiveScopeLock(data.objective_id, data.project_id, (db) =>
    db
      .insert(cronjobs)
      .values({
        id,
        project_id: data.project_id,
        title: data.title,
        description: data.description || '',
        cron_expression: data.cron_expression,
        queue_mode: data.queue_mode || 'always',
        model: data.model || null,
        agent_name: data.agent_name || null,
        runtime_selection: data.runtimeSelection
          ? JSON.stringify(data.runtimeSelection)
          : null,
        runtimeSelectionStage: data.runtimeSelectionStage ?? null,
        objective_id: data.objective_id || null,
        status: data.status || 'active',
        last_run: data.last_run || null,
        next_run: data.next_run || null,
        created_at: created_at,
      })
      .execute(),
  );
  return { ...data, id, created_at };
}

export async function getCronjob(id: string): Promise<Cronjob | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(cronjobs)
    .where(eq(cronjobs.id, id));
  if (!rows[0]) return undefined;
  return parseCronjob(rows[0]);
}

export async function getCronjobsByProject(
  project_id: string,
  archived = false,
): Promise<Cronjob[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(cronjobs)
    .where(
      and(
        eq(cronjobs.project_id, project_id),
        eq(cronjobs.archived, archived ? 1 : 0),
      ),
    )
    .orderBy(cronjobs.created_at);
  return rows
    .map(parseCronjob)
    .filter((cronjob): cronjob is Cronjob => !!cronjob);
}

export async function updateCronjob(
  id: string,
  data: Partial<Cronjob>,
): Promise<Cronjob | undefined> {
  const setObj: any = {};
  if (data.project_id !== undefined) setObj.project_id = data.project_id;
  if (data.title !== undefined) setObj.title = data.title;
  if (data.description !== undefined) setObj.description = data.description;
  if (data.cron_expression !== undefined)
    setObj.cron_expression = data.cron_expression;
  if (data.queue_mode !== undefined) setObj.queue_mode = data.queue_mode;
  if (data.model !== undefined) setObj.model = data.model;
  if (data.agent_name !== undefined) setObj.agent_name = data.agent_name;
  if (data.runtimeSelection !== undefined) {
    setObj.runtime_selection = data.runtimeSelection
      ? JSON.stringify(data.runtimeSelection)
      : null;
  }
  if (data.runtimeSelectionStage !== undefined)
    setObj.runtimeSelectionStage = data.runtimeSelectionStage;
  if (data.objective_id !== undefined) setObj.objective_id = data.objective_id;
  if (data.status !== undefined) setObj.status = data.status;
  if (data.archived !== undefined) setObj.archived = data.archived ? 1 : 0;
  if (data.last_run !== undefined) setObj.last_run = data.last_run;
  if (data.next_run !== undefined) setObj.next_run = data.next_run;

  if (Object.keys(setObj).length === 0) return getCronjob(id);

  const project_id = data.objective_id
    ? (data.project_id ?? (await getCronjob(id))?.project_id)
    : undefined;
  await withObjectiveScopeLock(data.objective_id, project_id, (db) =>
    db.update(cronjobs).set(setObj).where(eq(cronjobs.id, id)).execute(),
  );
  return getCronjob(id);
}

/** Pause every active cronjob owned by an objective. */
export async function pauseCronjobsByObjective(
  objectiveId: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(cronjobs)
    .set({ status: 'paused' })
    .where(
      and(
        eq(cronjobs.objective_id, objectiveId),
        eq(cronjobs.status, 'active'),
      ),
    )
    .execute();
}

/**
 * Atomically claim one due cron occurrence and create its task.
 *
 * The expected next-run value makes the update a compare-and-swap: if another
 * scheduler sweep already claimed this occurrence, no second task is created.
 */
export async function createTaskForDueCronjob(
  cronjobId: string,
  expectedNextRun: string,
  nextRun: string,
  data: Omit<Task, 'id' | 'created_at'>,
): Promise<Task | undefined> {
  const result = await drizzleDbRef.current.transaction(async (tx) => {
    const lastRun = new Date().toISOString();
    const claimed = await tx
      .update(cronjobs)
      .set({ last_run: lastRun, next_run: nextRun })
      .where(
        and(
          eq(cronjobs.id, cronjobId),
          eq(cronjobs.status, 'active'),
          eq(cronjobs.archived, 0),
          eq(cronjobs.next_run, expectedNextRun),
        ),
      )
      .returning();
    if (claimed.length === 0) return undefined;

    // The status comes from in-memory stages; validate it against the locked
    // stage configuration so a concurrent stage removal cannot be bypassed.
    await lockProjectStageConfiguration(tx, data.project_id);
    await assertLockedTaskStatus(tx, data.project_id, data.status || 'backlog');
    const id = generateTaskId();
    const created_at = new Date().toISOString();
    const rows = await tx
      .insert(tasks)
      .values(taskInsertValues(data, id, created_at, data.priority))
      .returning();
    const created = parseTask(rows[0]);
    if (!created) return undefined;
    await tx.insert(taskBoardEvents).values({
      project_id: created.project_id,
      task_id: created.id,
      event_type: 'created',
      occurred_at: created_at,
      snapshot: replayTaskSnapshot(created),
    });
    const entryEvent = await insertStageEntryEventIfEnabled(
      tx,
      created.project_id,
      created.id,
      created.status,
      created_at,
    );
    return { created, entryEvent };
  });
  if (!result) return undefined;
  notifyStageEntryEventCommitted(result.entryEvent);
  return result.created;
}

export async function deleteCronjob(id: string): Promise<void> {
  await drizzleDbRef.current
    .delete(cronjobs)
    .where(eq(cronjobs.id, id))
    .execute();
}

function generateDatasetTaskId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `dtask-${Date.now()}-${rand}`;
}

function parseDatasetTask(row: any): DatasetTask | undefined {
  if (!row) return undefined;
  const dt: any = { ...row };
  // Internal exactly-once spawn state; never expose it through API models.
  delete dt.spawned_row_index;
  delete dt.generation;
  dt.archived = !!dt.archived;
  if (typeof dt.runtime_selection === 'string') {
    dt.runtimeSelection = parseStoredRuntimeSelection(dt.runtime_selection);
  } else {
    dt.runtimeSelection = null;
  }
  delete dt.runtime_selection;
  if (typeof dt.dataset === 'string') {
    try {
      dt.dataset = JSON.parse(dt.dataset);
    } catch {
      logger.warn(
        `[db] parseDatasetTask: failed to parse dataset JSON for task ${dt.id ?? '(unknown)'} — treating as empty`,
      );
      dt.dataset = [];
    }
  }
  return dt as DatasetTask;
}

export async function createDatasetTask(
  data: Omit<
    DatasetTask,
    'id' | 'created_at' | 'completed_rows' | 'current_row_index'
  >,
): Promise<DatasetTask> {
  const id = generateDatasetTaskId();
  const created_at = new Date().toISOString();
  await withObjectiveScopeLock(data.objective_id, data.project_id, (db) =>
    db
      .insert(datasetTasks)
      .values({
        id,
        project_id: data.project_id,
        title: data.title,
        description: data.description || '',
        dataset: JSON.stringify(data.dataset),
        total_rows: data.total_rows,
        completed_rows: 0,
        current_row_index: 0,
        model: data.model || null,
        agent_name: data.agent_name || null,
        runtime_selection: data.runtimeSelection
          ? JSON.stringify(data.runtimeSelection)
          : null,
        runtimeSelectionStage: data.runtimeSelectionStage ?? null,
        objective_id: data.objective_id || null,
        status: data.status || 'active',
        created_at: created_at,
      })
      .execute(),
  );
  return { ...data, id, created_at, completed_rows: 0, current_row_index: 0 };
}

export async function createDatasetRowTask(
  data: Omit<Task, 'id' | 'created_at'> & {
    dataset_task_id: string;
    dataset_row_index: number;
  },
): Promise<Task | undefined> {
  const result = await drizzleDbRef.current.transaction(async (tx) => {
    // Claim this dataset's current row and insert its task in the same
    // transaction. Recovery, resume, and manual run requests may overlap, but
    // only one caller can move spawned_row_index to the expected row.
    const claimed = await tx
      .update(datasetTasks)
      .set({ spawned_row_index: data.dataset_row_index })
      .where(
        and(
          eq(datasetTasks.id, data.dataset_task_id),
          eq(datasetTasks.status, 'active'),
          eq(datasetTasks.archived, 0),
          eq(datasetTasks.current_row_index, data.dataset_row_index),
          ne(datasetTasks.spawned_row_index, data.dataset_row_index),
          notExists(
            drizzleDbRef.current
              .select({ one: sql`1` })
              .from(tasks)
              .where(
                and(
                  eq(tasks.dataset_task_id, datasetTasks.id),
                  eq(tasks.dataset_row_index, data.dataset_row_index),
                  eq(tasks.dataset_generation, datasetTasks.generation),
                ),
              ),
          ),
        ),
      )
      .returning();
    if (claimed.length === 0) return undefined;

    // The status comes from in-memory stages; validate it against the locked
    // stage configuration so a concurrent stage removal cannot be bypassed.
    await lockProjectStageConfiguration(tx, data.project_id);
    await assertLockedTaskStatus(tx, data.project_id, data.status || 'backlog');
    const id = generateTaskId();
    const created_at = new Date().toISOString();
    const [project] = await tx
      .select({ ownerUserId: projects.user_id })
      .from(projects)
      .where(eq(projects.id, data.project_id))
      .limit(1);
    const attributedData = {
      ...data,
      ownerUserId: data.ownerUserId ?? project?.ownerUserId ?? null,
      lastTriggeredByUserId: data.lastTriggeredByUserId ?? null,
      lastTriggerSource: data.lastTriggerSource ?? ('system' as const),
      lastTriggeredAt: data.lastTriggeredAt ?? created_at,
    };
    const rows = await tx
      .insert(tasks)
      .values({
        ...taskInsertValues(attributedData, id, created_at, data.priority),
        dataset_generation: claimed[0].generation,
      })
      .returning();
    const created = parseTask(rows[0]);
    if (!created) return undefined;
    await tx.insert(taskBoardEvents).values({
      project_id: created.project_id,
      task_id: created.id,
      event_type: 'created',
      occurred_at: created_at,
      snapshot: replayTaskSnapshot(created),
    });
    const entryEvent = await insertStageEntryEventIfEnabled(
      tx,
      created.project_id,
      created.id,
      created.status,
      created_at,
    );
    return { created, entryEvent };
  });
  if (!result) return undefined;
  notifyStageEntryEventCommitted(result.entryEvent);
  return (await attachTaskAttribution([result.created]))[0];
}

export async function getDatasetTask(
  id: string,
): Promise<DatasetTask | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(datasetTasks)
    .where(eq(datasetTasks.id, id));
  return parseDatasetTask(rows[0]);
}

export async function getCurrentDatasetRowTask(
  datasetTaskId: string,
  rowIndex: number,
): Promise<Task | undefined> {
  const rows = await drizzleDbRef.current
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(
      datasetTasks,
      and(
        eq(tasks.dataset_task_id, datasetTasks.id),
        eq(tasks.dataset_generation, datasetTasks.generation),
      ),
    )
    .where(
      and(
        eq(datasetTasks.id, datasetTaskId),
        eq(tasks.dataset_row_index, rowIndex),
      ),
    )
    .orderBy(desc(tasks.created_at))
    .limit(1);
  return parseTask(rows[0]?.task);
}

export async function getDatasetTasksByProject(
  project_id: string,
  archived = false,
): Promise<DatasetTask[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(datasetTasks)
    .where(
      and(
        eq(datasetTasks.project_id, project_id),
        eq(datasetTasks.archived, archived ? 1 : 0),
      ),
    )
    .orderBy(datasetTasks.created_at);
  return rows
    .map((row: any) => parseDatasetTask(row))
    .filter((dt: DatasetTask | undefined): dt is DatasetTask => !!dt);
}

export async function getIncompleteActiveDatasetTasks(): Promise<
  DatasetTask[]
> {
  const rows = await drizzleDbRef.current
    .select()
    .from(datasetTasks)
    .where(
      and(
        eq(datasetTasks.status, 'active'),
        eq(datasetTasks.archived, 0),
        lt(datasetTasks.current_row_index, datasetTasks.total_rows),
      ),
    )
    .orderBy(datasetTasks.created_at);
  return rows
    .map((row: any) => parseDatasetTask(row))
    .filter((dt: DatasetTask | undefined): dt is DatasetTask => !!dt);
}

export async function updateDatasetTask(
  id: string,
  data: Partial<DatasetTask>,
): Promise<DatasetTask | undefined> {
  const setObj: any = {};
  if (data.project_id !== undefined) setObj.project_id = data.project_id;
  if (data.title !== undefined) setObj.title = data.title;
  if (data.description !== undefined) setObj.description = data.description;
  if (data.dataset !== undefined)
    setObj.dataset =
      typeof data.dataset === 'string'
        ? data.dataset
        : JSON.stringify(data.dataset);
  if (data.total_rows !== undefined) setObj.total_rows = data.total_rows;
  if (data.completed_rows !== undefined)
    setObj.completed_rows = data.completed_rows;
  if (data.current_row_index !== undefined)
    setObj.current_row_index = data.current_row_index;
  // Explicit cursor resets (currently the restart path) begin a new processing
  // pass and must allow that row to be spawned again.
  if (data.current_row_index !== undefined) {
    setObj.spawned_row_index = -1;
    setObj.generation = sql`${datasetTasks.generation} + 1`;
  }
  if (data.model !== undefined) setObj.model = data.model;
  if (data.agent_name !== undefined) setObj.agent_name = data.agent_name;
  if (data.runtimeSelection !== undefined) {
    setObj.runtime_selection = data.runtimeSelection
      ? JSON.stringify(data.runtimeSelection)
      : null;
  }
  if (data.runtimeSelectionStage !== undefined)
    setObj.runtimeSelectionStage = data.runtimeSelectionStage;
  if (data.objective_id !== undefined) setObj.objective_id = data.objective_id;
  if (data.status !== undefined) setObj.status = data.status;
  if (data.archived !== undefined) setObj.archived = data.archived ? 1 : 0;

  if (Object.keys(setObj).length === 0) return getDatasetTask(id);

  const project_id = data.objective_id
    ? (data.project_id ?? (await getDatasetTask(id))?.project_id)
    : undefined;
  await withObjectiveScopeLock(data.objective_id, project_id, (db) =>
    db
      .update(datasetTasks)
      .set(setObj)
      .where(eq(datasetTasks.id, id))
      .execute(),
  );
  return getDatasetTask(id);
}

export async function deleteDatasetTask(id: string): Promise<void> {
  await drizzleDbRef.current
    .delete(datasetTasks)
    .where(eq(datasetTasks.id, id))
    .execute();
}

export async function incrementDatasetTaskProgress(
  taskId: string,
): Promise<DatasetTask | undefined> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const taskRows = await tx
      .select({
        dataset_task_id: tasks.dataset_task_id,
        dataset_row_index: tasks.dataset_row_index,
        dataset_generation: tasks.dataset_generation,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const task = taskRows[0];
    if (
      !task?.dataset_task_id ||
      task.dataset_row_index == null ||
      task.dataset_generation == null
    ) {
      return undefined;
    }

    const updated = await tx
      .update(datasetTasks)
      .set({
        completed_rows: sql`${datasetTasks.completed_rows} + 1`,
        current_row_index: sql`${datasetTasks.current_row_index} + 1`,
        status: sql`CASE
          WHEN ${datasetTasks.current_row_index} + 1 >= ${datasetTasks.total_rows}
            THEN 'completed'
          ELSE ${datasetTasks.status}
        END`,
      })
      .where(
        and(
          eq(datasetTasks.id, task.dataset_task_id),
          eq(datasetTasks.current_row_index, task.dataset_row_index),
          eq(datasetTasks.generation, task.dataset_generation),
        ),
      )
      .returning();
    return parseDatasetTask(updated[0]);
  });
}

/**
 * `table.column` entries that still hold `projectId` in a foreign key to
 * `projects.id`. The live schema is queried each call so a table added later is
 * covered without a hand-kept list.
 */
async function findProjectFkReferences(
  tx: Pick<typeof drizzleDbRef.current, 'execute'>,
  projectId: string,
): Promise<string[]> {
  const result = await tx.execute(sql`
    SELECT DISTINCT kcu.table_name AS table_name, kcu.column_name AS column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.constraint_schema = 'public'
      AND ccu.table_name = 'projects'
      AND ccu.column_name = 'id'
    ORDER BY 1, 2
  `);
  const columns = result.rows as { table_name: string; column_name: string }[];
  const remaining: string[] = [];
  for (const { table_name, column_name } of columns) {
    const hit = await tx.execute(sql`
      SELECT 1 FROM ${sql.identifier(table_name)}
      WHERE ${sql.identifier(column_name)} = ${projectId}
      LIMIT 1
    `);
    if (hit.rows.length > 0) remaining.push(`${table_name}.${column_name}`);
  }
  return remaining;
}

export async function renameProjectFolder(
  oldFolder: string,
  newFolder: string,
  options: { jid?: string } = {},
): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    const [oldProject] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, oldFolder));
    if (!oldProject) {
      throw new Error(`Project "${oldFolder}" not found`);
    }

    // Project-scoped rows have foreign keys to projects.id, so the target row
    // must exist before any dependent key is moved. onConflictDoNothing also
    // repairs renames made by the previous implementation, which could leave
    // an empty target project beside all data under the old key.
    await tx
      .insert(projects)
      .values({
        ...oldProject,
        id: newFolder,
        folder: newFolder,
        jid: options.jid ?? oldProject.jid,
      })
      .onConflictDoNothing();

    await tx
      .update(tasks)
      .set({ project_id: newFolder })
      .where(eq(tasks.project_id, oldFolder));
    await tx
      .update(stageEntryEvents)
      .set({ project_id: newFolder })
      .where(eq(stageEntryEvents.project_id, oldFolder));
    await tx
      .update(objectiveTaskEventHolds)
      .set({ project_id: newFolder })
      .where(eq(objectiveTaskEventHolds.project_id, oldFolder));
    await tx
      .update(taskBoardEvents)
      .set({
        project_id: newFolder,
        snapshot: sql`jsonb_set(${taskBoardEvents.snapshot}, '{project_id}', to_jsonb(${newFolder}::text))`,
      })
      .where(eq(taskBoardEvents.project_id, oldFolder));
    await tx
      .update(scheduledTasks)
      .set({ group_folder: newFolder })
      .where(eq(scheduledTasks.group_folder, oldFolder));
    await tx
      .update(activeRuns)
      .set({ group_folder: newFolder })
      .where(eq(activeRuns.group_folder, oldFolder));
    await tx
      .update(agentAsks)
      .set({ callerProjectId: newFolder })
      .where(eq(agentAsks.callerProjectId, oldFolder));
    await tx
      .update(agentAsks)
      .set({ targetProjectId: newFolder })
      .where(eq(agentAsks.targetProjectId, oldFolder));
    // The chat_messages table was dropped by migration 0002 — no rename
    // needed. The JSONL transcript under groups/<folder>/transcripts/ is
    // moved by the caller's directory rename.
    await tx
      .update(conversations)
      .set({ group_folder: newFolder })
      .where(eq(conversations.group_folder, oldFolder));
    await tx
      .update(datasetTasks)
      .set({ project_id: newFolder })
      .where(eq(datasetTasks.project_id, oldFolder));
    await tx
      .update(cronjobs)
      .set({ project_id: newFolder })
      .where(eq(cronjobs.project_id, oldFolder));
    await tx
      .update(memories)
      .set({ group_folder: newFolder })
      .where(eq(memories.group_folder, oldFolder));
    await tx
      .update(objectives)
      .set({ project_id: newFolder })
      .where(eq(objectives.project_id, oldFolder));
    await tx
      .update(externalIssueImports)
      .set({ project_id: newFolder })
      .where(eq(externalIssueImports.project_id, oldFolder));
    await tx
      .update(externalRunCosts)
      .set({ group_folder: newFolder })
      .where(eq(externalRunCosts.group_folder, oldFolder));
    await tx
      .update(memoryReflectorRuns)
      .set({ projectId: newFolder })
      .where(eq(memoryReflectorRuns.projectId, oldFolder));
    await tx
      .update(memoryReflectorRuns)
      .set({ sourceGroupFolder: newFolder })
      .where(eq(memoryReflectorRuns.sourceGroupFolder, oldFolder));
    await tx
      .update(memoryHistoryApplyOperations)
      .set({ projectId: newFolder })
      .where(eq(memoryHistoryApplyOperations.projectId, oldFolder));
    await tx
      .update(memoryTranscriptEvidence)
      .set({ projectId: newFolder })
      .where(eq(memoryTranscriptEvidence.projectId, oldFolder));
    await tx
      .update(memoryAudits)
      .set({ project_id: newFolder })
      .where(eq(memoryAudits.project_id, oldFolder));
    await tx
      .update(memoryAuditItems)
      .set({ target_project_id: newFolder })
      .where(eq(memoryAuditItems.target_project_id, oldFolder));
    await tx
      .update(memoryEvidenceCertificates)
      .set({ project_id: newFolder })
      .where(eq(memoryEvidenceCertificates.project_id, oldFolder));
    await tx
      .update(fileFavorites)
      .set({ project_id: newFolder })
      .where(eq(fileFavorites.project_id, oldFolder));
    await tx
      .update(fileFavoriteMoves)
      .set({ project_id: newFolder })
      .where(eq(fileFavoriteMoves.project_id, oldFolder));
    await tx
      .update(knowledgeBaseShares)
      .set({ group_folder: newFolder })
      .where(eq(knowledgeBaseShares.group_folder, oldFolder));
    // These queues intentionally have no FK to projects, but retries still
    // address the project by its folder key.
    await tx
      .update(pendingMemoryErasures)
      .set({ group_folder: newFolder })
      .where(eq(pendingMemoryErasures.group_folder, oldFolder));
    // Proposals are audit records without an FK; their chat cards resolve them
    // by the project in the URL, so they must follow the project.
    await tx
      .update(proposals)
      .set({ project_id: newFolder })
      .where(eq(proposals.project_id, oldFolder));
    // Marks outlive project deletion, so the new folder may already have one.
    // Merge into it, keeping the latest erasure time, then drop the old key.
    await tx.execute(sql`
      INSERT INTO ${memoryPrivacyErasureMarks} (group_folder, last_erased_at)
      SELECT ${newFolder}::text, last_erased_at FROM ${memoryPrivacyErasureMarks}
      WHERE group_folder = ${oldFolder}
      ON CONFLICT (group_folder) DO UPDATE
      SET last_erased_at = GREATEST(
        ${memoryPrivacyErasureMarks.last_erased_at},
        EXCLUDED.last_erased_at
      )
    `);
    await tx
      .delete(memoryPrivacyErasureMarks)
      .where(eq(memoryPrivacyErasureMarks.group_folder, oldFolder));
    await tx
      .update(pendingGraphErasures)
      .set({ group_folder: newFolder })
      .where(eq(pendingGraphErasures.group_folder, oldFolder));
    // Acknowledgements reference project_members(user_id, project_id) with
    // ON UPDATE NO ACTION, so the member key cannot be updated in place while
    // acks exist. Create the new member rows, re-point the acks, then delete
    // the old members (any ack left on the old key would cascade with them).
    await tx.execute(sql`
      INSERT INTO ${projectMembers}
        (user_id, project_id, access_level, created_at, preferences, push_enabled, mode)
      SELECT user_id, ${newFolder}, access_level, created_at, preferences, push_enabled, mode
      FROM ${projectMembers}
      WHERE project_id = ${oldFolder}
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO ${projectMemberKanbanAcknowledgements}
        (user_id, project_id, event_id)
      SELECT user_id, ${newFolder}, event_id
      FROM ${projectMemberKanbanAcknowledgements}
      WHERE project_id = ${oldFolder}
      ON CONFLICT DO NOTHING
    `);
    await tx
      .delete(projectMembers)
      .where(eq(projectMembers.project_id, oldFolder));
    await tx
      .update(projects)
      .set({ parentId: newFolder })
      .where(eq(projects.parentId, oldFolder));
    // Foreign keys to projects cascade on delete: a table this function does
    // not move would lose its rows. Fail and roll back instead.
    const unmoved = await findProjectFkReferences(tx, oldFolder);
    if (unmoved.length > 0) {
      throw new Error(
        `Cannot rename project "${oldFolder}": rows in ${unmoved.join(', ')} were not moved and would be deleted`,
      );
    }
    await tx.delete(projects).where(eq(projects.id, oldFolder));
  });
  migrateProjectAccessCache(oldFolder, newFolder);
}

/** Rows `pauseProjectAutomation` changed, so a rollback can restore them. */
export interface PausedProjectAutomation {
  scheduledTaskIds: string[];
  cronjobIds: string[];
  datasetTaskIds: string[];
  objectives: Array<{ id: string; status: string }>;
}

/**
 * Pause everything in a project that starts work by itself: active scheduled
 * tasks, cronjobs and dataset tasks (restart recovery resumes active ones), and
 * every objective that is not already paused.
 */
export async function pauseProjectAutomation(
  projectId: string,
): Promise<PausedProjectAutomation> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const scheduled = await tx
      .update(scheduledTasks)
      .set({ status: 'paused' })
      .where(
        and(
          eq(scheduledTasks.group_folder, projectId),
          eq(scheduledTasks.status, 'active'),
        ),
      )
      .returning();
    const crons = await tx
      .update(cronjobs)
      .set({ status: 'paused' })
      .where(
        and(eq(cronjobs.project_id, projectId), eq(cronjobs.status, 'active')),
      )
      .returning();
    const datasets = await tx
      .update(datasetTasks)
      .set({ status: 'paused' })
      .where(
        and(
          eq(datasetTasks.project_id, projectId),
          eq(datasetTasks.status, 'active'),
        ),
      )
      .returning();
    const before = await tx
      .select({ id: objectives.id, status: objectives.status })
      .from(objectives)
      .where(
        and(
          eq(objectives.project_id, projectId),
          ne(objectives.status, 'paused'),
        ),
      );
    if (before.length > 0) {
      await tx
        .update(objectives)
        .set({ status: 'paused', updated_at: new Date().toISOString() })
        .where(
          inArray(
            objectives.id,
            before.map((o) => o.id),
          ),
        );
    }
    return {
      scheduledTaskIds: scheduled.map((r) => r.id),
      cronjobIds: crons.map((r) => r.id),
      datasetTaskIds: datasets.map((r) => r.id),
      objectives: before,
    };
  });
}

export async function restoreProjectAutomation(
  paused: PausedProjectAutomation,
): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    if (paused.scheduledTaskIds.length > 0) {
      await tx
        .update(scheduledTasks)
        .set({ status: 'active' })
        .where(inArray(scheduledTasks.id, paused.scheduledTaskIds));
    }
    if (paused.cronjobIds.length > 0) {
      await tx
        .update(cronjobs)
        .set({ status: 'active' })
        .where(inArray(cronjobs.id, paused.cronjobIds));
    }
    if (paused.datasetTaskIds.length > 0) {
      await tx
        .update(datasetTasks)
        .set({ status: 'active' })
        .where(inArray(datasetTasks.id, paused.datasetTaskIds));
    }
    for (const objective of paused.objectives) {
      await tx
        .update(objectives)
        .set({ status: objective.status })
        .where(eq(objectives.id, objective.id));
    }
  });
}

export async function getDueCronjobs(): Promise<Cronjob[]> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .select()
    .from(cronjobs)
    .where(
      and(
        eq(cronjobs.status, 'active'),
        eq(cronjobs.archived, 0),
        isNotNull(cronjobs.next_run),
        lte(cronjobs.next_run, now),
      ),
    )
    .limit(500);
  return rows
    .map(parseCronjob)
    .filter((cronjob): cronjob is Cronjob => !!cronjob);
}
