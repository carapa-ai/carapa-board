import {
  pgTable,
  text,
  integer,
  real,
  bigint,
  bigserial,
  jsonb,
  boolean,
  primaryKey,
  foreignKey,
  index,
  uniqueIndex,
  check,
  timestamp,
  AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { RuntimeSelection } from '../lib/chat-agents.js';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    password_hash: text('password_hash').notNull(),
    // Bumped on every password change; session JWTs carry it (`tv`) and are
    // refused once it no longer matches.
    token_version: integer('token_version').default(0).notNull(),
    role: text('role').default('user').notNull(),
    created_at: text('created_at').notNull(),
    disabled: integer('disabled').default(0).notNull(),
    preferences: text('preferences'),
    dictationLanguage: text('dictation_language'),
    displayName: text('display_name'),
    avatarPath: text('avatar_path'),
  },
  (table) => [index('idx_users_created_at').on(table.created_at)],
);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  jid: text('jid').notNull(),
  name: text('name').notNull(),
  folder: text('folder').notNull(),
  trigger: text('trigger').notNull(),
  added_at: text('added_at').notNull(),
  order: integer('order'),
  parentId: text('parent_id').references((): AnyPgColumn => projects.id, {
    onDelete: 'set null',
  }),
  settings: text('settings'),
  is_main: integer('is_main').default(0).notNull(),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    group_folder: text('group_folder')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    chat_jid: text('chat_jid').notNull(),
    prompt: text('prompt').notNull(),
    schedule_type: text('schedule_type', {
      enum: ['cron', 'interval', 'once'],
    }).notNull(),
    schedule_value: text('schedule_value').notNull(),
    next_run: text('next_run'),
    last_run: text('last_run'),
    last_result: text('last_result'),
    status: text('status', { enum: ['active', 'paused', 'completed'] }).default(
      'active',
    ),
    created_at: text('created_at').notNull(),
    context_mode: text('context_mode', { enum: ['group', 'isolated'] }),
    runtimeSelection: jsonb('runtime_selection').$type<RuntimeSelection>(),
  },
  (table) => [
    index('idx_scheduled_tasks_next_run').on(table.next_run),
    index('idx_scheduled_tasks_status').on(table.status),
    index('idx_scheduled_tasks_group').on(table.group_folder),
  ],
);

export const taskRunLogs = pgTable(
  'task_run_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    run_id: text('run_id').references((): AnyPgColumn => activeRuns.id, {
      onDelete: 'set null',
    }),
    task_id: text('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    run_at: text('run_at').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    status: text('status', { enum: ['success', 'error'] }).notNull(),
    result: text('result'),
    error: text('error'),
  },
  (table) => [
    index('idx_task_run_logs_task_id').on(table.task_id, table.run_at),
    index('idx_task_run_logs_run_id').on(table.run_id),
  ],
);

export const cronjobs = pgTable(
  'cronjobs',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    cron_expression: text('cron_expression').notNull(),
    queue_mode: text('queue_mode', { enum: ['always', 'if_empty'] })
      .default('always')
      .notNull(),
    model: text('model'),
    agent_name: text('agent_name'),
    runtime_selection: text('runtime_selection'),
    // Base stage the runtime override is limited to; null applies to all stages.
    runtimeSelectionStage: text('runtime_selection_stage'),
    // Objective ownership is copied to every task spawned by this cronjob.
    // Plain text matches tasks.objective_id lifecycle semantics.
    objective_id: text('objective_id'),
    status: text('status', { enum: ['active', 'paused'] })
      .default('active')
      .notNull(),
    archived: integer('archived').default(0).notNull(),
    last_run: text('last_run'),
    next_run: text('next_run'),
    created_at: text('created_at').notNull(),
  },
  (table) => [
    index('idx_cronjobs_project').on(table.project_id),
    index('idx_cronjobs_next_run').on(table.next_run),
  ],
);

export const datasetTasks = pgTable(
  'dataset_tasks',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    dataset: text('dataset').notNull(),
    total_rows: integer('total_rows').notNull(),
    completed_rows: integer('completed_rows').default(0).notNull(),
    current_row_index: integer('current_row_index').default(0).notNull(),
    spawned_row_index: integer('spawned_row_index').default(-1).notNull(),
    generation: integer('generation').default(0).notNull(),
    model: text('model'),
    agent_name: text('agent_name'),
    runtime_selection: text('runtime_selection'),
    // Base stage the runtime override is limited to; null applies to all stages.
    runtimeSelectionStage: text('runtime_selection_stage'),
    // Objective ownership is copied to every generated row task.
    objective_id: text('objective_id'),
    status: text('status', { enum: ['active', 'paused', 'completed'] })
      .default('active')
      .notNull(),
    archived: integer('archived').default(0).notNull(),
    created_at: text('created_at').notNull(),
  },
  (table) => [index('idx_dataset_tasks_project').on(table.project_id)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    status: text('status').default('backlog').notNull(),
    priority: integer('priority').default(0).notNull(),
    runtime_selection: text('runtime_selection'),
    // Base stage the runtime override is limited to; null applies to all stages.
    runtimeSelectionStage: text('runtime_selection_stage'),
    output: text('output'),
    error: text('error'),
    session_id: text('session_id'),
    created_at: text('created_at').notNull(),
    started_at: text('started_at'),
    completed_at: text('completed_at'),
    cronjob_id: text('cronjob_id').references(() => cronjobs.id, {
      onDelete: 'set null',
    }),
    last_agent_name: text('last_agent_name'),
    depends_on_ids: text('depends_on_ids'),
    archived: integer('archived').default(0).notNull(),
    custom_values: text('custom_values'),
    author: text('author'),
    dataset_task_id: text('dataset_task_id').references(() => datasetTasks.id, {
      onDelete: 'set null',
    }),
    dataset_row_index: integer('dataset_row_index'),
    dataset_generation: integer('dataset_generation'),
    branch_name: text('branch_name'),
    execute_in_stage: text('execute_in_stage'),
    sandbox_instance: text('sandbox_instance'),
    worktree_path: text('worktree_path'),
    merge_commit: text('merge_commit'),
    // Per-task override: stage IDs to skip during auto-advance. null = no
    // skipping. Affects auto-advance only — manual drag and agent `update_task`
    // stage moves are NOT blocked by this list. Forward scan only (do not
    // apply to review-reject backwards path).
    skip_stages: text('skip_stages'),
    // Stage alternative suffix this card runs as (e.g. 'b' runs `<stage>.b`).
    // Null means the base stages (A).
    stageVariant: text('stage_variant'),
    // Ordered JSON array of extra stage alternatives (e.g. ["review.o"]) whose
    // runtimes judge the same implementation after the stage's own runtime.
    coStages: text('co_stages'),
    // List of variant identifiers for an A/B experiment parent card (JSON array e.g. ["a","b"]).
    abVariants: text('ab_variants'),
    // For variant child cards, points to the experiment parent task that spawned them.
    abParentTaskId: text('ab_parent_task_id'),
    // For experiment parent cards, points to the winning child variant task.
    abWinnerTaskId: text('ab_winner_task_id'),
    // The base stage at which the experiment diverged into child cards.
    abForkStage: text('ab_fork_stage'),
    // Git commit SHA from which all child variant branches diverged.
    abForkCommit: text('ab_fork_commit'),
    // Tags the task as belonging to a SMART objective. Plain text (no FK) so
    // deleting an objective does not cascade-delete or break its tasks — same
    // shape as `conversations.objective_id`. CarapaBrain routes task events to
    // the matching objective via this field.
    objective_id: text('objective_id'),
    ownerUserId: text('owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastTriggeredByUserId: text('last_triggered_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    lastTriggerSource: text('last_trigger_source', {
      enum: ['user', 'agent', 'schedule', 'public', 'system'],
    })
      .default('system')
      .notNull(),
    lastTriggeredAt: text('last_triggered_at'),
    sourceConversationId: text('source_conversation_id').references(
      (): AnyPgColumn => conversations.id,
      { onDelete: 'set null' },
    ),
    sourceRunId: text('source_run_id').references(
      (): AnyPgColumn => activeRuns.id,
      { onDelete: 'set null' },
    ),
  },
  (table) => [
    index('idx_tasks_project').on(table.project_id),
    index('idx_tasks_status').on(table.status),
    index('idx_tasks_project_status').on(table.project_id, table.status),
    index('idx_tasks_ab_parent_task_id').on(table.abParentTaskId),
    uniqueIndex('idx_tasks_ab_parent_variant').on(
      table.abParentTaskId,
      table.stageVariant,
    ),
  ],
);

/** Durable idempotency ledger for issue-to-task imports. */
export const externalIssueImports = pgTable(
  'external_issue_imports',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    repository: text('repository').notNull(),
    issue_number: integer('issue_number').notNull(),
    task_id: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    issue_url: text('issue_url').notNull(),
    imported_at: text('imported_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.project_id,
        table.provider,
        table.repository,
        table.issue_number,
      ],
    }),
    index('idx_external_issue_imports_task').on(table.task_id),
  ],
);

export const taskBoardEvents = pgTable(
  'task_board_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Deliberately not a foreign key: deleted cards must remain replayable.
    task_id: text('task_id').notNull(),
    event_type: text('event_type', {
      enum: ['seed', 'created', 'updated', 'deleted'],
    }).notNull(),
    occurred_at: text('occurred_at').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    status: text('status').generatedAlwaysAs(sql`"snapshot"->>'status'`),
  },
  (table) => [
    index('idx_task_board_events_project_time').on(
      table.project_id,
      table.occurred_at,
      table.id,
    ),
    index('idx_task_board_events_task_time').on(
      table.task_id,
      table.occurred_at,
      table.id,
    ),
    index('idx_task_board_events_task_id_desc').on(
      table.task_id,
      table.id.desc(),
      table.status,
    ),
    index('idx_task_board_events_completed_task_id_desc')
      .on(table.task_id, table.id.desc())
      .where(sql`${table.status} = 'completed'`),
    // Archived-snapshot probe used by the Now/attention completion and
    // notification filters; the query predicate must match this one verbatim.
    index('idx_task_board_events_archived_task_id')
      .on(table.task_id, table.id)
      .where(sql`${table.snapshot}->>'archived' = 'true'`),
  ],
);

// `archived` is the SQL bool sibling of `dataset_tasks.archived` /
// `cronjobs.archived` — keep them aligned (default 0, not null) so that
// `WHERE archived = 0` doesn't silently miss NULL rows.

export const taskMessages = pgTable(
  'task_messages',
  {
    id: text('id').primaryKey(),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    agent_name: text('agent_name'),
    created_at: text('created_at').notNull(),
  },
  (table) => [
    index('idx_task_messages_task_id').on(table.task_id, table.created_at),
  ],
);

// Aggregate columns: denormalized from transcript so the sidebar/list and
// diagnostics can render without hitting the JSONL on every request. Every
// assistant turn in `src/modules/transcripts/transcript-store.ts` updates
// these fields (write-through) via `updateConversationAggregate()`. The data is
// rebuilt from transcript if it drifts, never corrupted by independent writes.
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    group_folder: text('group_folder')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    preview: text('preview'),
    created_at: text('created_at').notNull(),
    read_at: text('read_at'),
    title: text('title'),
    pinned: integer('pinned').default(0).notNull(),
    session_id: text('session_id'),
    forked_from: text('forked_from'),
    use_worktree: integer('use_worktree').default(0).notNull(),
    /** Chosen at creation: Claude runs request the 1-hour prompt cache. */
    promptCache1h: integer('prompt_cache_1h').default(0).notNull(),
    worktree_path: text('worktree_path'),
    worktreeMissing: integer('worktree_missing').default(0).notNull(),
    branch_name: text('branch_name'),
    brain_managed: integer('brain_managed').default(0).notNull(),
    objective_id: text('objective_id'),
    last_agent_cmd: text('last_agent_cmd'),
    runtimeHarnessId: text('runtime_harness_id'),
    runtimeModelId: text('runtime_model_id'),
    runtimeReasoning: text('runtime_reasoning'),
    // Concrete model the Auto selection was routed to; cleared on compaction.
    routedModelId: text('routed_model_id'),
    // Harness the pinned model runs on; the same model ID may exist on several.
    routedHarnessId: text('routed_harness_id'),
    routedTier: text('routed_tier'),
    routedAt: text('routed_at'),
    mainAiUserId: text('main_ai_user_id').references(() => aiUsers.id, {
      onDelete: 'set null',
    }),
    mainAiUserMode: text('main_ai_user_mode', {
      enum: ['inherit', 'persona', 'none'],
    })
      .default('inherit')
      .notNull(),
    // The effective main-persona fingerprint is used only to detect identity
    // transitions. The generation advances monotonically so A -> B -> A can
    // never select A's earlier persistent/native session scope.
    mainPersonaFingerprint: text('main_persona_fingerprint'),
    // Identifies the durable persona-source observation that published the
    // accepted fingerprint. A single observation may never publish two
    // different fingerprints, which closes file/DB publication races.
    mainPersonaSourceRevision: text('main_persona_source_revision'),
    mainPersonaGeneration: integer('main_persona_generation')
      .default(0)
      .notNull(),
    continuousPersonaLoop: integer('continuous_persona_loop')
      .default(0)
      .notNull(),

    // Per-conversation timestamp aggregates, denormalized from the transcript.
    // Updated by `updateConversationAggregate()` (write-through) in
    // `src/modules/chat/db-chats.ts` whenever `saveChatMessage()` /
    // `appendChatTranscriptEntry()` writes a turn. Replaces the
    // `max(created_at)` over `chat_messages` queries the sidebar and
    // `getStuckWorkingConversations` previously needed.
    last_user_at: text('last_user_at'),
    last_assistant_at: text('last_assistant_at'),
    lastAssistantOutcome: text('last_assistant_outcome', {
      enum: ['success', 'failed', 'pending'],
    }),
    ownerUserId: text('owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastTriggeredByUserId: text('last_triggered_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    lastTriggerSource: text('last_trigger_source', {
      enum: ['user', 'agent', 'schedule', 'public', 'system'],
    })
      .default('system')
      .notNull(),
    lastTriggeredAt: text('last_triggered_at'),
  },
  (table) => [
    index('idx_conversations_group_folder').on(
      table.group_folder,
      table.created_at,
    ),
    index('idx_conversations_last_assistant_at').on(table.last_assistant_at),
  ],
);
/**
 * The cross-process admission boundary for every conversation turn. The
 * process-local AbortController registry remains the cancellation mechanism;
 * this row is the authoritative serialization claim.
 */
export const conversationExecutionLeases = pgTable(
  'conversation_execution_leases',
  {
    conversation_id: text('conversation_id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    owner_id: text('owner_id').notNull(),
    acquired_at: text('acquired_at').notNull(),
    expires_at: text('expires_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_conversation_execution_lease_expiry').on(table.expires_at),
  ],
);

export const conversationAgentSessions = pgTable(
  'conversation_agent_sessions',
  {
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agent_cmd: text('agent_cmd').notNull(),
    session_id: text('session_id'),
    // The system prompt mode active when this native agent session was created.
    // A mode change must start a fresh native session so the new instructions
    // are not silently ignored by persistent CLI runtimes.
    chat_mode: text('chat_mode'),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversation_id, table.agent_cmd] }),
    index('idx_cas_conversation').on(table.conversation_id),
  ],
);

export const activeRuns = pgTable(
  'active_runs',
  {
    id: text('id').primaryKey(),
    group_folder: text('group_folder')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    chat_jid: text('chat_jid').notNull(),
    session_id: text('session_id'),
    isMain: integer('is_main').default(0),
    isScheduledTask: integer('is_scheduled_task').default(0),
    scheduled_task_id: text('scheduled_task_id').references(
      () => scheduledTasks.id,
      { onDelete: 'set null' },
    ),
    task_id: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    sandbox_stack: text('sandbox_stack').notNull(),
    sandbox_service: text('sandbox_service').notNull(),
    sandbox_instance: text('sandbox_instance'),
    started_at: text('started_at').notNull(),
    timeout_at: text('timeout_at').notNull(),
    last_event_at: text('last_event_at'),
    status: text('status', {
      enum: ['running', 'completed', 'error', 'timeout', 'stalled'],
    }).default('running'),
    model: text('model'),
    stage: text('stage'),
    conversation_id: text('conversation_id').references(
      () => conversations.id,
      { onDelete: 'set null' },
    ),
    agent_name: text('agent_name'),
    // Associates recovery with the exact ask turn, not merely its conversation.
    agent_ask_id: text('agent_ask_id'),
    session_agent_key: text('session_agent_key'),
    // Stable hash of the executable/model/environment tuple that owns a
    // resumable native session. Session-agent keys intentionally permit some
    // model changes, so restart recovery needs this stricter discriminator.
    runtime_variant: text('runtime_variant'),
    // Identifies the interrupted predecessor when this row is the durable
    // outbox reservation for a Board restart continuation.
    restart_recovery_of_run_id: text('restart_recovery_of_run_id'),
    // Null while the restart-continuation outbox row is reserved but has not
    // crossed the harness launch boundary. A later boot may redispatch it.
    restart_recovery_dispatched_at: text('restart_recovery_dispatched_at'),
    completed_at: text('completed_at'),
    tok_total: integer('tok_total'),
    tok_output: integer('tok_output'),
    tok_input: integer('tok_input'),
    tok_cache_write: integer('tok_cache_write'),
    tok_cache_read: integer('tok_cache_read'),
    tok_context_last: integer('tok_context_last'),
    model_name: text('model_name'),
    tool_usage_count: integer('tool_usage_count'),
    cost_usd: real('cost_usd'),
    result: text('result'),
    reviewScore: real('review_score'),
    // Testing-stage verdict for this exact run ('pass' | 'fail' | 'blocked').
    testingDecision: text('testing_decision'),
    triggeredByUserId: text('triggered_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    triggerSource: text('trigger_source', {
      enum: ['user', 'agent', 'schedule', 'public', 'system'],
    })
      .default('system')
      .notNull(),
  },
  (table) => [
    index('idx_active_runs_status').on(table.status),
    index('idx_active_runs_group').on(table.group_folder),
    index('idx_active_runs_task').on(table.task_id),
    uniqueIndex('idx_active_runs_restart_recovery_of').on(
      table.restart_recovery_of_run_id,
    ),
    index('idx_active_runs_scheduled_task_started').on(
      table.scheduled_task_id,
      table.started_at,
    ),
    index('idx_active_runs_last_event').on(table.status, table.last_event_at),
  ],
);

export const stageEntryEvents = pgTable(
  'stage_entry_events',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stage_id: text('stage_id').notNull(),
    state: text('state', {
      enum: [
        'pending',
        'claimed',
        'running',
        'succeeded',
        'failed',
        'resolved',
      ],
    })
      .default('pending')
      .notNull(),
    created_at: text('created_at').notNull(),
    claimed_at: text('claimed_at'),
    run_id: text('run_id').references(() => activeRuns.id, {
      onDelete: 'set null',
    }),
    completed_at: text('completed_at'),
    error: text('error'),
    lifecycle_notification: text('lifecycle_notification'),
  },
  (table) => [
    index('idx_stage_entry_events_project_state_created').on(
      table.project_id,
      table.state,
      table.created_at,
    ),
    index('idx_stage_entry_events_task_stage_state').on(
      table.task_id,
      table.stage_id,
      table.state,
    ),
    index('idx_stage_entry_events_run').on(table.run_id),
  ],
);

/**
 * A failed / needs-input notification held back while the owning objective's
 * agent handles the matching brain event. Settled exactly once (`held` →
 * `notified` | `dropped`); see `kanban/task/objective-event-holds.ts`.
 */
export const objectiveTaskEventHolds = pgTable(
  'objective_task_event_holds',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    objective_id: text('objective_id').notNull(),
    /** Stage the task was in when the event was published. */
    stage_id: text('stage_id').notNull(),
    event_type: text('event_type', {
      enum: ['task_failed', 'task_question'],
    }).notNull(),
    event_timestamp: text('event_timestamp').notNull(),
    /** JSON of the `notifyEntityLifecycle` args to deliver on release. */
    notification: text('notification').notNull(),
    state: text('state', { enum: ['held', 'notified', 'dropped'] })
      .default('held')
      .notNull(),
    created_at: text('created_at').notNull(),
    settled_at: text('settled_at'),
  },
  (table) => [
    index('idx_objective_task_event_holds_state_created').on(
      table.state,
      table.created_at,
    ),
    index('idx_objective_task_event_holds_task_event').on(
      table.task_id,
      table.event_type,
      table.state,
    ),
  ],
);

export const taskStageComments = pgTable(
  'task_stage_comments',
  {
    task_id: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stage_id: text('stage_id').notNull(),
    content: text('content').notNull(),
    updated_at: text('updated_at').notNull(),
    // Kept as an identifier rather than an FK so deleting a run explicitly does
    // not discard where the note's latest value came from.
    run_id: text('run_id'),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.stage_id] }),
    index('idx_task_stage_comments_task').on(table.task_id),
  ],
);

// Rebuildable reporting projection for runs performed outside CarapaBoard.
// Conversation content and telemetry remain canonical in the JSONL transcript.
export const externalRunCosts = pgTable(
  'external_run_costs',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    external_session_id: text('external_session_id').notNull(),
    external_turn_id: text('external_turn_id').notNull(),
    group_folder: text('group_folder')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    started_at: text('started_at').notNull(),
    completed_at: text('completed_at'),
    model_name: text('model_name'),
    tok_total: integer('tok_total'),
    tok_input: integer('tok_input'),
    tok_output: integer('tok_output'),
    tok_cache_read: integer('tok_cache_read'),
    tok_reasoning: integer('tok_reasoning'),
    cost_usd: real('cost_usd'),
    cost_estimated: integer('cost_estimated').default(1).notNull(),
    cost_source: text('cost_source').notNull(),
  },
  (table) => [
    uniqueIndex('uq_external_run_source_session_turn').on(
      table.source,
      table.external_session_id,
      table.external_turn_id,
    ),
    index('idx_external_run_started').on(table.started_at),
    index('idx_external_run_group').on(table.group_folder, table.started_at),
  ],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    group_folder: text('group_folder')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    memory_type: text('memory_type').notNull(),
    importance: real('importance').default(0.5).notNull(),
    source: text('source').default('agent'),
    sourceRef: text('source_ref'),
    tags: text('tags'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    last_accessed_at: text('last_accessed_at').notNull(),
    access_count: integer('access_count').default(0),
    superseded_by: text('superseded_by'),
    objective_id: text('objective_id'),
    // Temporal validity (bi-temporal): valid_from = when the fact became true,
    // valid_to = when it stopped being true (null = currently valid).
    // created_at already records "when the system learned it".
    valid_from: text('valid_from'),
    valid_to: text('valid_to'),
  },
  (table) => [index('idx_memories_group_folder').on(table.group_folder)],
);

/** Durable transcript-reflector progress, independent of legacy journals. */
export const memoryReflectorRuns = pgTable(
  'memory_reflector_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    transcriptPath: text('transcript_path').notNull(),
    transcriptFingerprint: text('transcript_fingerprint').notNull(),
    byteOffset: integer('byte_offset').default(0).notNull(),
    profile: text('profile').notNull(),
    mode: text('mode').default('live').notNull(),
    status: text('status').default('processing').notNull(),
    nextChunkIndex: integer('next_chunk_index').default(0).notNull(),
    totalChunks: integer('total_chunks').notNull(),
    originScopeKnown: integer('origin_scope_known').default(0).notNull(),
    originObjectiveId: text('origin_objective_id'),
    originConversationId: text('origin_conversation_id'),
    sourceGroupFolder: text('source_group_folder'),
    workspaceRoot: text('workspace_root'),
    sandboxStack: text('sandbox_stack'),
    sandboxService: text('sandbox_service'),
    sandboxInstance: text('sandbox_instance'),
    sandboxWorkspacePath: text('sandbox_workspace_path'),
    /** Most recent failure, kept through retries and completion for diagnosis. */
    error: text('error'),
    failureCount: integer('failure_count').default(0).notNull(),
    leaseToken: text('lease_token'),
    leaseExpiresAt: text('lease_expires_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('uq_memory_reflector_source').on(
      table.projectId,
      table.transcriptPath,
      table.transcriptFingerprint,
      table.byteOffset,
      table.profile,
      table.mode,
    ),
    index('idx_memory_reflector_project_status').on(
      table.projectId,
      table.status,
    ),
  ],
);

/** Content-free idempotency receipts for reflector memory mutations. */
export const memoryReflectorOperations = pgTable(
  'memory_reflector_operations',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => memoryReflectorRuns.id, { onDelete: 'cascade' }),
    operationKey: text('operation_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    operation: text('operation').notNull(),
    status: text('status').default('pending').notNull(),
    targetMemoryId: text('target_memory_id'),
    resultMemoryId: text('result_memory_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_memory_reflector_operation').on(
      table.runId,
      table.operationKey,
    ),
  ],
);

/** Durable per-operation progress for an approved History Review manifest. */
export const memoryHistoryApplyOperations = pgTable(
  'memory_history_apply_operations',
  {
    id: text('id').primaryKey(),
    manifestId: text('manifest_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    operationIndex: integer('operation_index').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    expectedTargetVersion: text('expected_target_version'),
    baselineFingerprint: text('baseline_fingerprint'),
    status: text('status').default('pending').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_memory_history_apply_operation').on(
      table.manifestId,
      table.operationIndex,
    ),
    index('idx_memory_history_apply_project').on(table.projectId),
  ],
);

/** Verbatim transcript support for a memory, removed with privacy erasure. */
export const memoryTranscriptEvidence = pgTable(
  'memory_transcript_evidence',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceRef: text('source_ref').notNull(),
    messageId: text('message_id').notNull(),
    messageCreatedAt: text('message_created_at').notNull(),
    excerpt: text('excerpt').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_memory_transcript_evidence').on(
      table.memoryId,
      table.sourceRef,
      table.messageId,
      table.excerpt,
    ),
    index('idx_memory_transcript_evidence_memory').on(table.memoryId),
  ],
);

export const memoryAudits = pgTable(
  'memory_audits',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    initiated_by: text('initiated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    runtime_id: text('runtime_id').notNull(),
    prompt_version: text('prompt_version').notNull(),
    mode: text('mode').default('cleanup').notNull(),
    status: text('status').notNull(),
    total_items: integer('total_items').default(0).notNull(),
    processed_items: integer('processed_items').default(0).notNull(),
    proposal_items: integer('proposal_items').default(0).notNull(),
    cursor: integer('cursor').default(0).notNull(),
    retry_count: integer('retry_count').default(0).notNull(),
    index_collector_token_hash: text('index_collector_token_hash'),
    index_collector_finished_at: text('index_collector_finished_at'),
    index_collector_summary: text('index_collector_summary'),
    index_collector_inspected_areas: text('index_collector_inspected_areas'),
    baseline_fingerprint: text('baseline_fingerprint').notNull(),
    error: text('error'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    started_at: text('started_at'),
    ready_at: text('ready_at'),
    applied_at: text('applied_at'),
  },
  (table) => [
    index('idx_memory_audits_project_created').on(
      table.project_id,
      table.created_at,
    ),
    index('idx_memory_audits_status').on(table.status),
    // At most one unfinished audit per project.
    uniqueIndex('uq_memory_audits_active_project')
      .on(table.project_id)
      .where(
        sql`${table.status} IN ('queued', 'running', 'ready', 'applying', 'paused')`,
      ),
  ],
);

// memory_id is deliberately not an FK: after an approved privacy erase the
// content-free audit item remains as an operational checkpoint. Certificates,
// which may contain reconstructive evidence, do cascade with the memory.
export const memoryAuditItems = pgTable(
  'memory_audit_items',
  {
    id: text('id').primaryKey(),
    audit_id: text('audit_id')
      .notNull()
      .references(() => memoryAudits.id, { onDelete: 'cascade' }),
    memory_id: text('memory_id').notNull(),
    memory_fingerprint: text('memory_fingerprint').notNull(),
    processing_state: text('processing_state').default('pending').notNull(),
    disposition: text('disposition'),
    confidence: real('confidence'),
    reason: text('reason'),
    proposed_content: text('proposed_content'),
    proposed_memory_type: text('proposed_memory_type'),
    proposed_importance: real('proposed_importance'),
    proposed_tags: text('proposed_tags'),
    merge_target_id: text('merge_target_id'),
    target_project_id: text('target_project_id'),
    retrieval_value: text('retrieval_value'),
    proposed_valid_from: text('proposed_valid_from'),
    proposal_evidence: text('proposal_evidence'),
    review_decision: text('review_decision').default('pending').notNull(),
    reviewed_by: text('reviewed_by'),
    reviewed_at: text('reviewed_at'),
    revision: integer('revision').default(0).notNull(),
    applied_at: text('applied_at'),
    applied_memory_id: text('applied_memory_id'),
    apply_error: text('apply_error'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_memory_audit_item_memory').on(
      table.audit_id,
      table.memory_id,
    ),
    index('idx_memory_audit_items_audit_state').on(
      table.audit_id,
      table.processing_state,
    ),
  ],
);

// Staged, repository-verified candidates emitted through the audit-only
// project index collector. They are not live memories and cascade with the
// parent audit. Reconciliation later promotes create/enhance candidates into
// memory_audit_items for human review.
export const memoryIndexCandidates = pgTable(
  'memory_index_candidates',
  {
    id: text('id').primaryKey(),
    audit_id: text('audit_id')
      .notNull()
      .references(() => memoryAudits.id, { onDelete: 'cascade' }),
    candidate_key: text('candidate_key').notNull(),
    content: text('content').notNull(),
    memory_type: text('memory_type').notNull(),
    importance: real('importance').notNull(),
    tags: text('tags').notNull(),
    retrieval_value: text('retrieval_value').notNull(),
    reason: text('reason').notNull(),
    valid_from: text('valid_from').notNull(),
    evidence: text('evidence').notNull(),
    disposition: text('disposition').default('discovered').notNull(),
    confidence: real('confidence'),
    reconciliation_reason: text('reconciliation_reason'),
    target_memory_id: text('target_memory_id'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_memory_index_candidate_key').on(
      table.audit_id,
      table.candidate_key,
    ),
    index('idx_memory_index_candidates_audit').on(table.audit_id),
  ],
);

export const memoryEvidenceCertificates = pgTable(
  'memory_evidence_certificates',
  {
    id: text('id').primaryKey(),
    memory_id: text('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    memory_fingerprint: text('memory_fingerprint').notNull(),
    verdict: text('verdict').notNull(),
    value_justification: text('value_justification').notNull(),
    evidence_type: text('evidence_type').notNull(),
    reflector_version: text('reflector_version').notNull(),
    origin: text('origin').notNull(),
    expires_at: text('expires_at'),
    revoked_at: text('revoked_at'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_memory_certificates_memory').on(
      table.memory_id,
      table.revoked_at,
    ),
    index('idx_memory_certificates_project').on(table.project_id),
  ],
);

export const memoryEvidenceFiles = pgTable(
  'memory_evidence_files',
  {
    id: text('id').primaryKey(),
    certificate_id: text('certificate_id')
      .notNull()
      .references(() => memoryEvidenceCertificates.id, {
        onDelete: 'cascade',
      }),
    repository_root: text('repository_root').notNull(),
    path: text('path').notNull(),
    file_sha256: text('file_sha256').notNull(),
    excerpt_sha256: text('excerpt_sha256').notNull(),
    watched_scope: text('watched_scope'),
    watched_scope_sha256: text('watched_scope_sha256'),
    line_start: integer('line_start'),
    line_end: integer('line_end'),
    excerpt: text('excerpt').notNull(),
    repository_commit: text('repository_commit'),
    verified_at: text('verified_at').notNull(),
  },
  (table) => [
    index('idx_memory_evidence_certificate').on(table.certificate_id),
    index('idx_memory_evidence_file_hash').on(table.file_sha256),
  ],
);

// Content-free durable queue for vector/graph privacy erasure retries.
// Deliberately has no FK to projects/memories: the SQL memory is removed before
// external cleanup may succeed, and project deletion must not discard retries.
export const pendingMemoryErasures = pgTable('pending_memory_erasures', {
  memory_id: text('memory_id').primaryKey(),
  group_folder: text('group_folder').notNull(),
  target_tokens: text('target_tokens').default('[]').notNull(),
  token_scheme: text('token_scheme').default('hmac-sha256').notNull(),
  erase_matching_graph: boolean('erase_matching_graph').default(true).notNull(),
  created_at: text('created_at').notNull(),
  last_attempt_at: text('last_attempt_at'),
});

// Content-free durable record of the latest privacy erasure per project. It
// outlives pending_memory_erasures rows (deleted when cleanup completes) so a
// stale History Review apply can detect an erasure that ran after its preview.
// No FK, for the same reason as pending_memory_erasures.
export const memoryPrivacyErasureMarks = pgTable(
  'memory_privacy_erasure_marks',
  {
    group_folder: text('group_folder').primaryKey(),
    last_erased_at: text('last_erased_at').notNull(),
  },
);

export const pendingGraphErasures = pgTable('pending_graph_erasures', {
  id: text('id').primaryKey(),
  group_folder: text('group_folder').notNull(),
  target_tokens: text('target_tokens').notNull(),
  token_scheme: text('token_scheme').default('hmac-sha256').notNull(),
  created_at: text('created_at').notNull(),
  last_attempt_at: text('last_attempt_at'),
});

export const pendingMemoryInvalidations = pgTable(
  'pending_memory_invalidations',
  {
    memory_id: text('memory_id').primaryKey(),
    effective_at: text('effective_at').notNull(),
    created_at: text('created_at').notNull(),
  },
);

export const objectives = pgTable(
  'objectives',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    status: text('status').default('draft').notNull(),
    priority: integer('priority').default(0).notNull(),
    deadline: text('deadline'),
    progress: integer('progress').default(0).notNull(),
    specific: text('specific'),
    measurable: text('measurable'),
    achievable: text('achievable'),
    relevant: text('relevant'),
    time_bound: text('time_bound'),
    trigger_config: text('trigger_config'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    metadata: text('metadata'),
    eventRuntimeSelection: jsonb(
      'event_runtime_selection',
    ).$type<RuntimeSelection>(),
    work_dir: text('work_dir'),
    cost_limit_usd: real('cost_limit_usd'),
    // Set while a move to another project still has steps left (vector store,
    // folder, brain registration); holds the project it was moved from.
    move_source_project: text('move_source_project'),
  },
  (table) => [
    index('idx_objectives_project').on(table.project_id),
    index('idx_objectives_status').on(table.status),
    check(
      'objectives_cost_limit_usd_nonnegative',
      sql`${table.cost_limit_usd} IS NULL OR ${table.cost_limit_usd} >= 0`,
    ),
  ],
);

export const deviceKeys = pgTable(
  'device_keys',
  {
    device_id: text('device_id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    public_key: text('public_key').notNull(),
    kind: text('kind').notNull().default('interactive'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    expiresAt: text('expires_at'),
    is_active: boolean('is_active').notNull().default(true),
    is_approved: boolean('is_approved').notNull().default(false),
    approved_at: text('approved_at'),
    approved_by: text('approved_by'),
    label: text('label'),
    created_at: text('created_at').notNull(),
    last_used_at: text('last_used_at').notNull(),
  },
  (table) => [index('idx_device_keys_user').on(table.user_id)],
);

export const devicePairings = pgTable(
  'device_pairings',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id').notNull().unique(),
    publicKey: text('public_key').notNull(),
    label: text('label').notNull(),
    requestedScopes: jsonb('requested_scopes').$type<string[]>().notNull(),
    codeHash: text('code_hash').notNull().unique(),
    secretHash: text('secret_hash').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    lastPolledAt: text('last_polled_at'),
    approvedBy: text('approved_by'),
  },
  (t) => [index('idx_device_pairings_expiry').on(t.expiresAt)],
);

export const devicePushTokens = pgTable(
  'device_push_tokens',
  {
    device_id: text('device_id')
      .primaryKey()
      .references(() => deviceKeys.device_id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    token: text('token').notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    last_acked_at: text('last_acked_at'),
  },
  (table) => [index('idx_push_tokens_user').on(table.user_id)],
);

export const notificationPayloads = pgTable(
  'notification_payloads',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    content: text('content').notNull(),
    action_url: text('action_url'),
    respond_to_kind: text('respond_to_kind'),
    respond_to_id: text('respond_to_id'),
    respond_to_objective_id: text('respond_to_objective_id'),
    form_response: jsonb('form_response'),
    // Stable source/correlation key. Intercepted PushNotification tool uses
    // use it for replay deduplication; actionable forms use a run-prefixed key
    // so lifecycle needs-input suppression matches only the same request.
    // NULLs are distinct in the unique index.
    source_tool_use_id: text('source_tool_use_id'),
    created_at: text('created_at').notNull(),
    delivered_at: text('delivered_at'),
    acked_at: text('acked_at'),
    expires_at: text('expires_at').notNull(),
  },
  (table) => [
    index('idx_notif_payloads_user_undelivered').on(
      table.user_id,
      table.delivered_at,
    ),
    index('idx_notif_payloads_expires').on(table.expires_at),
    uniqueIndex('uq_notif_payloads_source_tool_use').on(
      table.user_id,
      table.source_tool_use_id,
    ),
  ],
);

export const knowledgeBases = pgTable('knowledge_bases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  folder_path: text('folder_path').notNull(),
  last_indexed_at: bigint('last_indexed_at', { mode: 'number' }),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
});

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    kbId: text('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    tags: jsonb('tags').$type<string[]>().default([]).notNull(),
    title: text('title'),
    description: text('description'),
    sourceUrl: text('source_url'),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [primaryKey({ columns: [table.kbId, table.path] })],
);

export const knowledgeBaseShares = pgTable(
  'knowledge_base_shares',
  {
    knowledge_base_id: text('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    group_folder: text('group_folder')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.knowledge_base_id, table.group_folder] }),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    access_level: text('access_level').default('viewer').notNull(),
    created_at: text('created_at').notNull(),
    preferences: text('preferences'),
    push_enabled: integer('push_enabled'),
    mode: text('mode'),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.project_id] })],
);

/**
 * A user's favorite files in one project's Files tab. `group` favorites are
 * group-folder-relative file paths (`path`); `knowledge` favorites address a
 * knowledge-base document by `kb_id` + `filename`.
 */
export const fileFavorites = pgTable(
  'file_favorites',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['group', 'knowledge'] }).notNull(),
    path: text('path'),
    kb_id: text('kb_id').references(() => knowledgeBases.id, {
      onDelete: 'cascade',
    }),
    filename: text('filename'),
    created_at: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_favorites_group')
      .on(table.user_id, table.project_id, table.path)
      .where(sql`${table.kind} = 'group'`),
    uniqueIndex('uq_file_favorites_knowledge')
      .on(table.user_id, table.project_id, table.kb_id, table.filename)
      .where(sql`${table.kind} = 'knowledge'`),
    index('idx_file_favorites_project_path').on(table.project_id, table.path),
    check(
      'chk_file_favorites_shape',
      sql`(${table.kind} = 'group' AND ${table.path} IS NOT NULL AND ${table.kb_id} IS NULL AND ${table.filename} IS NULL)
        OR (${table.kind} = 'knowledge' AND ${table.path} IS NULL AND ${table.kb_id} IS NOT NULL AND ${table.filename} IS NOT NULL)`,
    ),
  ],
);

/**
 * Intent of a group-folder rename/move, recorded before the file changes and
 * removed in the transaction that rewrites the favorites, so a failure or
 * restart between the two can always be completed or discarded later.
 */
export const fileFavoriteMoves = pgTable(
  'file_favorite_moves',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    from_path: text('from_path').notNull(),
    to_path: text('to_path').notNull(),
    created_at: text('created_at').notNull(),
  },
  (table) => [index('idx_file_favorite_moves_project').on(table.project_id)],
);

export const projectMemberKanbanAcknowledgements = pgTable(
  'project_member_kanban_acknowledgements',
  {
    user_id: text('user_id').notNull(),
    project_id: text('project_id').notNull(),
    event_id: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => taskBoardEvents.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({
      columns: [table.user_id, table.project_id, table.event_id],
    }),
    foreignKey({
      columns: [table.user_id, table.project_id],
      foreignColumns: [projectMembers.user_id, projectMembers.project_id],
    }).onDelete('cascade'),
  ],
);

export const kbMembers = pgTable(
  'kb_members',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kb_id: text('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    access_level: text('access_level').default('viewer').notNull(),
    created_at: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.kb_id] })],
);

export const conversationMembers = pgTable(
  'conversation_members',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    access_level: text('access_level').default('viewer').notNull(),
    created_at: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.conversation_id] })],
);

export const conversationPublicShares = pgTable(
  'conversation_public_shares',
  {
    conversationId: text('conversation_id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    publicToken: text('public_token').notNull().unique(),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revokedAt: text('revoked_at'),
    allowVisitorPrompts: integer('allow_visitor_prompts').default(0).notNull(),
  },
  (table) => [
    index('idx_conversation_public_shares_token').on(table.publicToken),
  ],
);

/** Metadata-only audit and quota state for anonymous public prompts. */
export const publicPromptRequests = pgTable(
  'public_prompt_requests',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    visitorHash: text('visitor_hash').notNull(),
    status: text('status', {
      enum: ['judging', 'running', 'completed', 'rejected', 'failed'],
    }).notNull(),
    safetyCategory: text('safety_category'),
    responderCount: integer('responder_count').default(0).notNull(),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_public_prompt_requests_conversation_created').on(
      table.conversationId,
      table.createdAt,
    ),
    index('idx_public_prompt_requests_visitor_created').on(
      table.visitorHash,
      table.createdAt,
    ),
  ],
);

/** Immutable, content-addressed speech files shared by every TTS consumer. */
export const ttsAudioAssets = pgTable(
  'tts_audio_assets',
  {
    id: text('id').primaryKey(),
    format: text('format').notNull(),
    mimeType: text('mime_type').notNull(),
    durationMs: integer('duration_ms').notNull(),
    sampleRate: integer('sample_rate').notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    model: text('model').notNull(),
    voiceId: text('voice_id').notNull(),
    language: text('language').notNull(),
    parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: text('created_at').notNull(),
    lastAccessedAt: text('last_accessed_at').notNull(),
  },
  (table) => [
    index('idx_tts_audio_assets_last_accessed').on(table.lastAccessedAt),
  ],
);

/** Durable association that freezes a persona message's original voice. */
export const messageSpeechAssets = pgTable(
  'message_speech_assets',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    assetId: text('asset_id')
      .notNull()
      .references(() => ttsAudioAssets.id, { onDelete: 'restrict' }),
    speakerId: text('speaker_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.messageId] }),
    index('idx_message_speech_assets_asset').on(table.assetId),
  ],
);

/** Durable, conversation-scoped authority for Live Mode playback. */
export const conversationLiveRuns = pgTable(
  'conversation_live_runs',
  {
    conversationId: text('conversation_id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    epoch: integer('epoch').default(1).notNull(),
    mode: text('mode', { enum: ['personas', 'work'] })
      .default('personas')
      .notNull(),
    status: text('status', { enum: ['active', 'paused', 'stopping', 'off'] })
      .default('off')
      .notNull(),
    revision: integer('revision').default(0).notNull(),
    nextSequence: integer('next_sequence').default(1).notNull(),
    currentItemId: text('current_item_id'),
    leaderUserId: text('leader_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    leaderDeviceId: text('leader_device_id'),
    leaderSessionId: text('leader_session_id'),
    leaderPlatform: text('leader_platform', {
      enum: ['web', 'android', 'ios'],
    }),
    /** 1 when the leading device speaks replies itself (no Supertonic). */
    leaderDeviceSpeech: integer('leader_device_speech').default(0).notNull(),
    leaseToken: text('lease_token'),
    leaseExpiresAt: text('lease_expires_at'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_conversation_live_runs_status').on(table.status)],
);

/** Ordered control metadata; transcript files remain the message source of truth. */
export const conversationLiveQueueItems = pgTable(
  'conversation_live_queue_items',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    epoch: integer('epoch').notNull(),
    sequence: integer('sequence').notNull(),
    participantId: text('participant_id').notNull(),
    messageId: text('message_id').notNull(),
    state: text('state', {
      enum: [
        'generating',
        'synthesizing',
        'ready',
        'released',
        'playing',
        'completed',
        'failed',
        'cancelled',
      ],
    }).notNull(),
    assetId: text('asset_id').references(() => ttsAudioAssets.id, {
      onDelete: 'restrict',
    }),
    durationMs: integer('duration_ms'),
    releasedAt: text('released_at'),
    startedAt: text('started_at'),
    endsAt: text('ends_at'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_live_queue_run_sequence').on(table.runId, table.sequence),
    uniqueIndex('idx_live_queue_conversation_message').on(
      table.conversationId,
      table.messageId,
    ),
    index('idx_live_queue_conversation_state').on(
      table.conversationId,
      table.state,
    ),
  ],
);

export const aiUsers = pgTable(
  'ai_users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    presetId: text('preset_id').notNull(),
    promptPath: text('prompt_path').notNull(),
    avatarPath: text('avatar_path'),
    voiceId: text('voice_id'),
    voiceLang: text('voice_lang'),
    voiceStylePath: text('voice_style_path'),
    identity: text('identity').notNull(),
    turn: text('turn', { enum: ['before', 'after'] })
      .default('after')
      .notNull(),
    tools: jsonb('tools').$type<string[]>().default([]).notNull(),
    enabled: integer('enabled').default(1).notNull(),
    // Published entries point at immutable assets so the persona revision and
    // every emote fingerprint input change atomically. Null reads as no emotes.
    publishedEmotes:
      jsonb('published_emotes').$type<
        Array<{ name: string; path: string; version: string }>
      >(),
    // Monotonic publication version for identity/instruction/tool/emote
    // changes. Prompt edits write an immutable file first, then atomically
    // switch promptPath and advance this version with their parsed metadata.
    personaRevision: integer('persona_revision').default(0).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_ai_users_enabled').on(table.enabled, table.name)],
);

export const aiUserTeams = pgTable(
  'ai_user_teams',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').default('').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('uq_ai_user_teams_name').on(table.name)],
);

export const aiUserTeamMembers = pgTable(
  'ai_user_team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => aiUserTeams.id, { onDelete: 'cascade' }),
    aiUserId: text('ai_user_id')
      .notNull()
      .references(() => aiUsers.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.aiUserId] }),
    index('idx_ai_user_team_members_ai_user').on(table.aiUserId),
  ],
);

export const conversationAiUsers = pgTable(
  'conversation_ai_users',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    aiUserId: text('ai_user_id')
      .notNull()
      .references(() => aiUsers.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['active', 'paused'] })
      .default('active')
      .notNull(),
    invitedBy: text('invited_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    invitedAt: text('invited_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.aiUserId] }),
    index('idx_conversation_ai_users_conversation').on(
      table.conversationId,
      table.status,
    ),
  ],
);

export const aiTurnRuns = pgTable(
  'ai_turn_runs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    aiUserId: text('ai_user_id')
      .notNull()
      .references(() => aiUsers.id, { onDelete: 'cascade' }),
    phase: text('phase', { enum: ['before', 'after'] }).notNull(),
    presetId: text('preset_id').notNull(),
    effectiveToolsets: jsonb('effective_toolsets')
      .$type<string[]>()
      .default([])
      .notNull(),
    decision: text('decision'),
    inspection: jsonb('inspection').$type<{
      systemPrompt: string;
      prompt: string;
      history?: Array<{ role: string; content: string }>;
      transcript: string;
      systemPromptInjected?: boolean;
      handoff: Record<string, unknown>;
    } | null>(),
    status: text('status', {
      enum: ['queued', 'running', 'completed', 'skipped', 'failed'],
    }).notNull(),
    stopReason: text('stop_reason'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_ai_turn_runs_conversation').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

// Persistent backing for the in-memory agent token registry in
// src/mcp/auth-tokens.ts. Survives carapa-board restarts so a running
// sandbox doesn't get 401s the moment the board comes back up.
export const agentTokens = pgTable(
  'agent_tokens',
  {
    token: text('token').primaryKey(),
    scope: text('scope').notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }),
    created_at: text('created_at').notNull(),
  },
  (table) => [index('idx_agent_tokens_expires_at').on(table.expires_at)],
);

// CarapaBox hosts that connect out to this Board over WebSocket. The box
// authenticates with a per-box bearer token; only its SHA-256 hash is stored
// and the plaintext is shown once at creation. Projects select a box through
// `settings.boxId` (absent → the local box).
export const boxes = pgTable('boxes', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  // 'docker' (full CarapaBox) or 'native' (Docker-less runner, reduced isolation)
  kind: text('kind').notNull().default('docker'),
  token_hash: text('token_hash').notNull().unique(),
  token_prefix: text('token_prefix').notNull(),
  isolation_level: text('isolation_level').notNull().default('container'),
  version: text('version'),
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  created_at: text('created_at').notNull(),
  last_seen_at: text('last_seen_at'),
  revoked_at: text('revoked_at'),
});

// Per-user "checked off" rows of the sidebar Now list. A row stays hidden
// while its latest activity is not newer than `dismissed_at`.
export const nowDismissals = pgTable(
  'now_dismissals',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    item_id: text('item_id').notNull(),
    dismissedAt: timestamp('dismissed_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.kind, table.item_id] }),
    check(
      'now_dismissals_kind_check',
      sql`${table.kind} in ('conversation','task')`,
    ),
  ],
);

// ── MCP OAuth 2.1 (remote MCP clients) ──────────────────────────────────────
// Dynamically registered public clients (RFC 7591). `approved_at` stays null
// until a user completes a grant for the client; unapproved rows are capped
// and pruned by age.
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    client_name: text('client_name').notNull(),
    redirect_uris: jsonb('redirect_uris').$type<string[]>().notNull(),
    created_at: text('created_at').notNull(),
    approved_at: text('approved_at'),
  },
  (table) => [index('idx_oauth_clients_created').on(table.created_at)],
);

// Pending /oauth/authorize requests awaiting a consent decision (short TTL).
export const oauthAuthorizationRequests = pgTable(
  'oauth_authorization_requests',
  {
    id: text('id').primaryKey(),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirect_uri: text('redirect_uri').notNull(),
    state: text('state'),
    code_challenge: text('code_challenge').notNull(),
    resource: text('resource').notNull(),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
  },
  (table) => [index('idx_oauth_requests_expiry').on(table.expires_at)],
);

// One project a grant covers, with its own access level. `main` is the user's
// main workspace plus every project it can reach; `project` is exactly one
// folder (no implicit children). The list is exact: nothing is inherited.
export interface OAuthGrantTargetEntry {
  kind: 'main' | 'project';
  folder: string;
  access: 'read' | 'write';
}

// Single-use authorization codes, hashed at rest. They carry the approved
// grant parameters; the grant row is created when the code is exchanged.
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    code_hash: text('code_hash').primaryKey(),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirect_uri: text('redirect_uri').notNull(),
    code_challenge: text('code_challenge').notNull(),
    resource: text('resource').notNull(),
    targets: jsonb('targets').$type<OAuthGrantTargetEntry[]>().notNull(),
    grant_expires_at: text('grant_expires_at').notNull(),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
  },
  (table) => [index('idx_oauth_codes_expiry').on(table.expires_at)],
);

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    targets: jsonb('targets').$type<OAuthGrantTargetEntry[]>().notNull(),
    created_at: text('created_at').notNull(),
    last_used_at: text('last_used_at'),
    expires_at: text('expires_at').notNull(),
    revoked_at: text('revoked_at'),
  },
  (table) => [index('idx_oauth_grants_user').on(table.user_id)],
);

// Opaque access and refresh tokens, stored as SHA-256 hashes. A rotated
// refresh token keeps its row (`used_at` set) so reuse can be detected.
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    grant_id: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
    used_at: text('used_at'),
  },
  (table) => [
    index('idx_oauth_tokens_grant').on(table.grant_id),
    check(
      'oauth_tokens_kind_check',
      sql`${table.kind} in ('access','refresh')`,
    ),
  ],
);

// Agent-proposed changes to rules and skills. A proposal is created by the
// `propose_changes` tool and decided by a user from a Board chat card; the
// stored typed actions are the only thing the approve/deny endpoints execute.
// No FKs: a proposal is an audit record and must outlive its conversation.
export const proposals = pgTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull(),
    objective_id: text('objective_id'),
    conversation_id: text('conversation_id').notNull(),
    created_by_run: text('created_by_run'),
    title: text('title').notNull(),
    rationale: text('rationale').notNull(),
    kind: text('kind', {
      enum: ['skill', 'rule', 'prompt', 'merge'],
    }).notNull(),
    name: text('name').notNull(),
    target_layer: text('target_layer', {
      enum: [
        'project',
        'objective',
        'group_template',
        'objective_template',
        'platform',
      ],
    }).notNull(),
    approve_action: jsonb('approve_action').notNull(),
    deny_action: jsonb('deny_action'),
    base_hash: text('base_hash').notNull(),
    /** Platform/template layers: the target's files when proposed, for the diff. */
    base_files: jsonb('base_files'),
    status: text('status', {
      enum: ['pending', 'applying', 'applied', 'denied', 'failed', 'stale'],
    })
      .default('pending')
      .notNull(),
    decided_by: text('decided_by'),
    decided_at: text('decided_at'),
    result: text('result'),
    created_at: text('created_at').notNull(),
  },
  (table) => [
    index('idx_proposals_conversation').on(table.conversation_id),
    index('idx_proposals_project').on(table.project_id, table.created_at),
  ],
);

/**
 * One row per question an agent asks another project's (or objective's) chat
 * agent through a visible conversation. At most one ask per target
 * conversation can be `pending` at a time.
 */
export const agentAsks = pgTable(
  'agent_asks',
  {
    id: text('id').primaryKey(),
    callerProjectId: text('caller_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    callerConversationId: text('caller_conversation_id').references(
      () => conversations.id,
      { onDelete: 'set null' },
    ),
    callerObjectiveId: text('caller_objective_id'),
    callerRunId: text('caller_run_id'),
    callerName: text('caller_name').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    targetProjectId: text('target_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    targetConversationId: text('target_conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    askMessageId: text('ask_message_id').notNull(),
    status: text('status', {
      enum: ['pending', 'answered', 'needs_input', 'failed'],
    })
      .default('pending')
      .notNull(),
    createdAt: text('created_at').notNull(),
    settledAt: text('settled_at'),
    deliveryError: text('delivery_error'),
  },
  (table) => [
    index('idx_agent_asks_caller_created').on(
      table.callerProjectId,
      table.createdAt,
    ),
    index('idx_agent_asks_target_status').on(
      table.targetProjectId,
      table.status,
    ),
    uniqueIndex('uq_agent_asks_pending_target_conversation')
      .on(table.targetConversationId)
      .where(sql`${table.status} = 'pending'`),
  ],
);
