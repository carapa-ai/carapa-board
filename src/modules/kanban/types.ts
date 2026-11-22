// Kanban stage types

import type { RuntimeSelection } from '../../lib/chat-agents.js';
import type { ModelTier } from '../../lib/model-router.js';
import type { TaskPhase } from './task-phase.js';

export type StageType = 'queue' | 'active' | 'testing' | 'done' | 'review';

export interface StageDefinition {
  id: string; // slug: 'in_testing', 'needs_feedback'
  title: string; // display: 'In Testing'
  type: StageType; // queue=manual, active/testing/review=executes, done=terminal
  color: string; // hex: '#3B82F6'
  inactive?: boolean; // if true, stage is not used by agents or UI
  record?: boolean; // if true, capture a Playwright video recording of the agent run for this stage
  /** Create one durable automatic execution receipt whenever a task enters this stage. */
  runOnEntry?: boolean;
  /** Whether native agent sessions are resumed when this stage is re-entered. */
  persistSession?: boolean;
  // Worker/entry-agent config
  workerPrompt?: string; // API transport for the prompt file; never persisted
  runtimeSelection?: RuntimeSelection;
  /** Floor for Auto routing: a run here never uses a lower tier than this. */
  minTier?: ModelTier;
  workerSandbox?: string;
  /** Enabled AI persona appended for ordinary executable or opted-in entry runs. */
  mainAiUserId?: string;
  // Stall detection overrides (fall back to STALL_TIMEOUT_MS / STALL_GRACE_MS)
  stallTimeoutMs?: number;
  stallGraceMs?: number;
}

type StageEntryEventState =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'resolved';

export interface StageEntryLifecycleNotification {
  event: 'completed' | 'failed' | 'needs_input';
  title: string;
  runId: string;
  recipientUserIds?: string[];
}

/** Mutable receipt target for a guarded task transition. */
export interface StageEntryEventRef {
  id?: string;
}

/** Durable receipt for one task transition into an automatically executed stage. */
export interface StageEntryEvent {
  id: string;
  projectId: string;
  taskId: string;
  stageId: string;
  state: StageEntryEventState;
  createdAt: string;
  claimedAt?: string;
  runId?: string;
  completedAt?: string;
  error?: string;
  lifecycleNotification?: StageEntryLifecycleNotification;
}

export interface CustomValueDefinition {
  key: string; // identifier used in templates: {{key}}
  label?: string; // display label (defaults to key)
  type?: 'text' | 'number'; // value type (default 'text')
}

// Kanban cronjobs

export interface Cronjob {
  id: string;
  project_id: string;
  title: string;
  description: string;
  cron_expression: string;
  queue_mode: 'always' | 'if_empty';
  model?: string | null;
  agent_name?: string | null;
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the runtime override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  /** Objective inherited by every task this cronjob spawns. */
  objective_id?: string | null;
  status: 'active' | 'paused';
  archived?: boolean | number;
  last_run?: string | null;
  next_run?: string | null;
  created_at: string;
}

// Kanban dataset tasks

export interface DatasetTask {
  id: string;
  project_id: string;
  title: string;
  description: string; // template with {{placeholders}}
  dataset: Record<string, string | number>[]; // parsed JSON array
  total_rows: number;
  completed_rows: number;
  current_row_index: number;
  model?: string;
  agent_name?: string;
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the runtime override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  /** Objective inherited by every generated row task. */
  objective_id?: string | null;
  status: 'active' | 'paused' | 'completed';
  archived?: boolean;
  created_at: string;
}

// Kanban task types

type TaskStatus = string;
export type TriggerSource = 'user' | 'agent' | 'schedule' | 'public' | 'system';

export interface AttributionUser {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}
export interface TriggerMetadata {
  user: AttributionUser | null;
  source: TriggerSource;
  triggeredAt: string | null;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent_name?: string | null;
  model_name?: string | null;
  created_at: string;
  /**
   * Discriminates a run-separator entry from a normal chat message.
   * `'run_start'` entries render as a run divider in the UI (not a bubble);
   * they are not user turn boundaries. Absent on legacy entries (= 'message').
   */
  entry_type?:
    | 'message'
    | 'run_start'
    | 'run_result'
    | 'system_notice'
    | 'external_comment'
    | 'review_feedback'
    | 'testing_feedback'
    | 'stage_prompt'
    | 'stage_prompt_delivery'
    | 'steering_request'
    | 'steering_assignment'
    | 'steering_delivery'
    | 'stage_handoff_request'
    | 'stage_handoff_delivery';
  /** Marks the canonical user message as a task-run steering prompt. */
  steering?: boolean;
  /** Durable delivery state derived from append-only steering receipts. */
  steeringDelivery?: 'steered' | 'queued';
  /** ID of the canonical steering prompt owned by an assignment or receipt. */
  prompt_id?: string;
  /** Exact executable stage that should receive a stage_prompt. */
  target_stage?: string;
  /** Executable stage owned by a deferred agent-requested handoff. */
  source_stage?: string;
  /** On a stage_handoff_request: the card's own run moved it into the needs-input fallback stage. */
  own_run_fallback_question?: boolean;
  /** active run that consumed this prompt or receipt. */
  run_id?: string | null;
  /** Set when the task-message API returns only a bounded tail. */
  contentTruncated?: boolean;
  contentTotalBytes?: number;
  contentStartBytes?: number;
}

export interface Task {
  id: string;
  project_id: string; // maps to group folder name
  title: string;
  description: string;
  status: TaskStatus;
  priority: number; // sort order within column (lower = higher)
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the runtime override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  last_agent_name?: string | null; // most recent assistant agent_name for this task
  output?: string; // accumulated agent output markdown
  error?: string; // last error message
  session_id?: string; // claude session ID for resume
  cronjob_id?: string; // set if spawned by a cronjob
  dataset_task_id?: string; // set if spawned by a dataset task
  dataset_row_index?: number; // index of the dataset row this task represents
  depends_on_ids?: string[]; // IDs of tasks this one depends on
  execute_in_stage?: string | null; // override: stage ID that should trigger execution (null = default)
  archived?: boolean; // hidden from board by default
  custom_values?: Record<string, string | number>; // user-defined values (JSON blob)
  branch_name?: string | null; // the git branch where this task was implemented
  worktree_path?: string | null; // host-side worktree path (set when using git worktree mode)
  merge_commit?: string | null; // SHA of the merge commit on the default branch (set after deploy merge, when branch_name is cleared)
  sandbox_instance?: string; // sandbox container instance assigned during execution
  /**
   * Per-task override: stage IDs to skip during auto-advance. null = no
   * skipping. Affects forward auto-advance only — manual drag and agent
   * `update_task` stage moves are NOT blocked by this list. Do not apply to
   * the review-reject backwards path.
   */
  skip_stages?: string[] | null;
  /**
   * Stage alternative suffix this card runs as (e.g. 'b' runs `<stage>.b`
   * where configured). Null means the base stages (A). Set only in a queue stage.
   */
  stageVariant?: string | null;
  stage_variant?: string | null;
  /**
   * Ordered stage alternatives (e.g. ['review.o']) that run in addition to the
   * stage's own runtime. Null/empty means only the stage's own runtime runs.
   */
  coStages?: string[] | null;
  co_stages?: string[] | null;
  /**
   * List of variants selected for this experiment (e.g. ['a', 'b']).
   * Stored on the parent task. Requires taskCheckoutMode === 'worktree'.
   */
  ab_variants?: string[] | null;
  abVariants?: string[] | null;
  /**
   * For variant child cards, points to the experiment parent task that spawned them.
   */
  ab_parent_task_id?: string | null;
  abParentTaskId?: string | null;
  /**
   * For experiment parent cards, points to the winning child variant task.
   */
  ab_winner_task_id?: string | null;
  abWinnerTaskId?: string | null;
  /**
   * The base stage at which the experiment diverged into child cards.
   */
  ab_fork_stage?: string | null;
  abForkStage?: string | null;
  /**
   * Git commit SHA from which all child variant branches diverged.
   */
  ab_fork_commit?: string | null;
  abForkCommit?: string | null;
  /**
   * Child task IDs spawned for an A/B experiment parent card.
   */
  child_ids?: string[];
  childIds?: string[];
  /**
   * ID of the SMART objective this task is tagged with. Null when the task
   * is not part of any objective. CarapaBrain routes `task_completed` /
   * `task_error` events to the matching objective via this field.
   */
  objective_id?: string | null;
  author?: string; // who created the task: 'user', 'agent', 'cronjob'
  ownerUserId?: string | null;
  lastTriggeredByUserId?: string | null;
  lastTriggerSource?: TriggerSource;
  lastTriggeredAt?: string | null;
  sourceConversationId?: string | null;
  sourceConversationProjectId?: string | null;
  sourceRunId?: string | null;
  owner?: AttributionUser | null;
  latestTrigger?: TriggerMetadata;
  created_at: string;
  started_at?: string;
  completed_at?: string | null;
  /** Eligible for automatic execution but not currently claimed or running. */
  waiting?: boolean;
  /** Claimed and creating its worktree; the agent has not launched yet. */
  preparing?: boolean;
  /** Authoritative execution phase derived on the server (`task-phase.ts`). */
  phase?: TaskPhase;
}

/**
 * Slim task shape returned by the list endpoint — omits large/internal-only fields
 * that are not needed to render kanban cards. Use Task (from GET /tasks/:fid) when
 * the full record is required (e.g. inside the task detail dialog for legacy output).
 */
export type TaskSummary = Omit<
  Task,
  'output' | 'session_id' | 'execute_in_stage' | 'sandbox_instance'
> & {
  /** Exact completion event represented by this list snapshot. */
  completionEventId?: number | null;
  /** Completion timestamp of the most recently finished execution run. */
  latestRunCompletedAt?: string | null;
  /** Sum of wall-clock durations for every completed execution run. */
  totalRunDurationMs?: number | null;
  /** Sum of measured run costs for this task. Null when no priced run exists. */
  costUsd?: number | null;
  /** Total persisted execution runs for this task. */
  runCount?: number;
  /** Model reported by the task's most recent run. */
  latestRunModelName?: string | null;
  /** Stage of the task's most recent run. */
  latestRunStage?: string | null;
  /** Agent of the task's most recent run. */
  latestRunAgentName?: string | null;
  /** Model of the task's in-flight run, if one is running. */
  runningRunModel?: string | null;
};

type TaskBoardEventType = 'seed' | 'created' | 'updated' | 'deleted';

export type ReplayTaskSnapshot = Pick<
  Task,
  | 'id'
  | 'project_id'
  | 'title'
  | 'description'
  | 'status'
  | 'priority'
  | 'runtimeSelection'
  | 'runtimeSelectionStage'
  | 'last_agent_name'
  | 'error'
  | 'cronjob_id'
  | 'dataset_task_id'
  | 'dataset_row_index'
  | 'depends_on_ids'
  | 'skip_stages'
  | 'objective_id'
  | 'archived'
  | 'custom_values'
  | 'branch_name'
  | 'author'
  | 'created_at'
  | 'started_at'
  | 'completed_at'
>;

export interface TaskBoardEvent {
  id: number;
  project_id: string;
  task_id: string;
  event_type: TaskBoardEventType;
  occurred_at: string;
  snapshot: ReplayTaskSnapshot;
}
