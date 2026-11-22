/** Content revision of one project as visible to the requesting account. */
export interface ProjectRevision {
  id: string;
  revision: string;
}

export type StageType = 'queue' | 'active' | 'testing' | 'done' | 'review';

export type TaskDefaultBranchStatus =
  | { available: false; defaultBranch: string; reason: string }
  | {
      available: true;
      defaultBranch: string;
      sourceCommit: string;
      taskHead: string;
      commitsBehind: number;
      state: 'ready' | 'dirty' | 'unresolved';
      conflictedPaths: string[];
    };

export interface TaskDefaultBranchMerge {
  defaultBranch: string;
  sourceCommit: string;
  taskHead: string;
  outcome:
    | 'merged'
    | 'conflicted'
    | 'uncommitted'
    | 'up-to-date'
    | 'failed'
    | 'interrupted';
  conflictedPaths: string[];
  delivery?: 'steered' | 'queued' | 'failed';
  error?: string;
  notification?: string;
}

export type ProjectMode = 'kanban' | 'chat' | 'objectives';
type ProjectModeStatus = 'idle' | 'working' | 'finished';

export interface ProjectModeStatuses {
  kanban: ProjectModeStatus;
  chat: ProjectModeStatus;
  objectives: ProjectModeStatus;
}

export interface ProjectsStatusSummary {
  projects: Record<string, ProjectModeStatuses>;
}

export interface RuntimeSelection {
  harnessId: string;
  modelId: string;
  reasoning?: string;
  temperature?: number;
}

export interface StageDefinition {
  id: string;
  title: string;
  type: StageType;
  color: string;
  inactive?: boolean;
  record?: boolean;
  runOnEntry?: boolean;
  persistSession?: boolean;
  workerPrompt?: string;
  runtimeSelection?: RuntimeSelection;
  workerSandbox?: string;
  mainAiUserId?: string;
  stallTimeoutMs?: number;
  stallGraceMs?: number;
}

export interface StageMigration {
  sourceStageId: string;
  destinationStageId: string;
}

export interface StageOccupancy {
  stageId: string;
  total: number;
  active: number;
  archived: number;
}

export interface TaskRunStageDuration {
  stageId: string | null;
  completedDurationMs: number;
  runningStartedAt: string[];
  runningDurationMs: number;
  runningReferenceAt: string;
  costUsd: number | null;
}

export type TaskStatus = string;

export interface AccountPreferences extends AccountProfile {
  content: string | null;
  dictationLanguage: string | null;
}

export interface AccountProfile {
  displayName: string | null;
  avatarUrl: string | null;
  avatarCandidateUrl: string | null;
}
type TriggerSource = 'user' | 'agent' | 'schedule' | 'public' | 'system';
interface AttributionUser {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}
interface TriggerMetadata {
  user: AttributionUser | null;
  source: TriggerSource;
  triggeredAt: string | null;
}

/** Mirrors the server `TaskPhase` (`src/modules/kanban/task-phase.ts`). */
export type TaskPhase =
  | 'running'
  | 'preparing'
  | 'queued'
  | 'waiting'
  | 'stalled'
  | 'idle';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  last_agent_name?: string | null;
  output?: string;
  error?: string;
  session_id?: string;
  cronjob_id?: string;
  dataset_task_id?: string;
  dataset_row_index?: number;
  depends_on_ids?: string[];
  /**
   * Per-task override: stage IDs to skip during auto-advance. null = no
   * skipping. Affects forward auto-advance only — manual drag and agent
   * `update_task` stage moves are NOT blocked by this list. The review-reject
   * backwards path is also unaffected.
   */
  skip_stages?: string[] | null;
  /**
   * Stage alternative suffix this card runs as (e.g. 'b'). Null means the base
   * stages (A). Editable only while the task is in a queue stage.
   */
  stageVariant?: string | null;
  stage_variant?: string | null;
  /**
   * List of variants selected for this experiment (e.g. ['a', 'b']).
   */
  ab_variants?: string[] | null;
  abVariants?: string[] | null;
  /** Ordered stage alternatives (e.g. ['review.o']) that run in addition to a stage's own runtime. */
  coStages?: string[] | null;
  co_stages?: string[] | null;
  /**
   * For variant child cards, points to the parent task that spawned them.
   */
  ab_parent_task_id?: string | null;
  abParentTaskId?: string | null;
  /**
   * For experiment parent cards, points to the winning child variant task.
   */
  ab_winner_task_id?: string | null;
  abWinnerTaskId?: string | null;
  /**
   * Base stage at which the experiment forked into child cards.
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
   * is not part of any objective. CarapaBrain uses this to route task events.
   */
  objective_id?: string | null;
  archived?: boolean;
  custom_values?: Record<string, string | number>;
  branch_name?: string | null;
  worktree_path?: string | null;
  merge_commit?: string | null;
  author?: string | null;
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
  running?: boolean;
  queued?: boolean;
  /** Eligible for automatic execution but not currently claimed or running. */
  waiting?: boolean;
  /** Claimed and creating its worktree; the agent has not launched yet. */
  preparing?: boolean;
  /** Server-derived execution phase; the booleans above are kept for compatibility. */
  phase?: TaskPhase;
  /** Sum of measured run costs for this task. Null when no priced run exists. */
  costUsd?: number | null;
}

/**
 * Slim task shape returned by GET /projects/:pid/tasks (the list endpoint).
 * Heavy/internal-only fields are omitted. Use Task (from GET /projects/:pid/tasks/:fid)
 * when the full record is needed (e.g. to look up a task missing from the list).
 */
export type TaskSummary = Omit<Task, 'output' | 'session_id'> & {
  /** Exact completion event represented by this list snapshot. */
  completionEventId?: number | null;
  /** Completion timestamp of the most recently finished execution run. */
  latestRunCompletedAt?: string | null;
  /** Sum of wall-clock durations for every completed execution run. */
  totalRunDurationMs?: number | null;
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
  /**
   * Client-only: a manual move to a done stage is merging the task branch.
   * Never sent by the server; set by the board's merging overlay.
   */
  merging?: boolean;
};

type TaskBoardEventType = 'seed' | 'created' | 'updated' | 'deleted';
type ReplayTaskSnapshot = TaskSummary;

interface TaskBoardEvent {
  id: number;
  project_id: string;
  task_id: string;
  event_type: TaskBoardEventType;
  occurred_at: string;
  snapshot: ReplayTaskSnapshot;
}

export interface BoardReplayRun {
  id: string;
  task_id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'error' | 'timeout' | 'stalled';
  stage: string | null;
  agent_name: string | null;
  model: string | null;
  model_name: string | null;
}

export interface BoardReplayData {
  initialTasks: ReplayTaskSnapshot[];
  events: TaskBoardEvent[];
  runs: BoardReplayRun[];
  reviewMilestones: BoardReplayReviewMilestone[];
  exactHistoryAvailableFrom: string | null;
  runHistoryAvailableFrom: string | null;
}

interface BoardReplayReviewMilestone {
  task_id: string;
  occurred_at: string;
  score: number;
  rejection_count: number | null;
}

export interface ChatMessageAttachment {
  type: 'audio' | 'image' | 'video' | 'document';
  url: string;
  mimetype: string;
  filename?: string;
  caption?: string;
  path?: string; // local absolute path on disk
  durationSeconds?: number;
}

export interface ChatDeepLink {
  label: string;
  href: string;
  variant?: 'default' | 'outline' | 'destructive';
}

export interface ChatMessage {
  id: string;
  group_folder: string;
  role: 'user' | 'assistant';
  content: string;
  sender_name?: string | null;
  senderUserId?: string | null;
  senderAvatarUrl?: string | null;
  source: 'whatsapp' | 'web' | 'http' | 'android' | 'ios' | 'public' | 'agent';
  publicInteractionId?: string | null;
  created_at: string;
  conversation_id?: string | null;
  attachments?: ChatMessageAttachment[] | null;
  deepLinks?: ChatDeepLink[] | null;
  objective_id?: string | null;
  telemetry?: Record<string, unknown> | null;
  emote?: string | null;
  speechText?: string | null;
  failed?: boolean;
  pending?: boolean;
  steeringDelivery?: 'pending' | 'steered' | 'queued' | 'unconfirmed';
  steeringStreamKey?: string;
}

export interface ConversationPublicShare {
  active: boolean;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  allowVisitorPrompts: boolean;
  visitorPromptingAvailable: boolean;
  visitorPromptingUnavailableReason: string | null;
}

export interface PublicAttachment {
  type: 'audio' | 'image' | 'video' | 'document';
  mimetype: string;
  filename?: string;
  caption?: string;
  url: string;
}

export interface PublicConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string | null;
  displayName: string | null;
  personaTitle: string | null;
  isPersona: boolean;
  avatarUrl: string | null;
  speechAvailable: boolean;
  speech: MessageSpeechDescriptor | null;
  attachments: PublicAttachment[];
}

export interface MessageSpeechDescriptor {
  state: 'available' | 'pending' | 'ready' | 'failed';
  durationMs: number | null;
  mimeType: string | null;
  url: string;
}

interface PublicConversation {
  title: string;
  liveMode: boolean;
  ttsEnabled: boolean;
  visitorPromptingEnabled: boolean;
  promptMaxChars: number;
}

export interface PublicConversationResponse {
  conversation: PublicConversation;
  messages: PublicConversationMessage[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}

// Raw transcript JSONL entry types (discriminated on `type`)
interface TranscriptUserMessage {
  id?: string;
  /** Browser submission IDs represented by a combined optimistic batch. */
  clientSubmissionIds?: string[];
  /** Browser-only entry awaiting canonical transcript ownership. */
  optimistic?: boolean;
  type: 'message';
  role: 'user';
  content: string;
  created_at?: string;
  sender_name?: string;
  senderUserId?: string;
  attachments?: ChatMessageAttachment[] | null;
  deepLinks?: ChatDeepLink[] | null;
  speech?: MessageSpeechDescriptor | null;
  steeringDelivery?: 'pending' | 'steered' | 'queued' | 'unconfirmed';
  steeringStreamKey?: string;
}

interface TranscriptAssistantMessage {
  id?: string;
  type: 'assistant';
  message: {
    model?: string;
    content: {
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      [key: string]: unknown;
    }[];
    usage?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface TranscriptResult {
  type: 'result';
  result: string | null;
  session_id?: string;
  duration_ms?: number;
  numTurns?: number;
  usage?: Record<string, unknown>;
  totalCostUsd?: number;
}

interface TranscriptSystem {
  type: 'system';
  subtype?: string;
  [key: string]: unknown;
}

// Fallback message from DB (when no transcript file exists)
interface TranscriptFallbackMessage {
  id?: string;
  type: 'message';
  role: 'assistant';
  content: string;
  created_at?: string;
  agent_name?: string;
  sender_name?: string;
  senderUserId?: string;
  telemetry?: Record<string, unknown>;
  emote?: string | null;
  speechText?: string | null;
  speech?: MessageSpeechDescriptor | null;
  steeringDelivery?: 'steered';
  /** Live provider message id represented by an aggregated replay segment. */
  canonicalMessageId?: string;
}

interface TranscriptMilestone {
  id: string;
  type: 'system_milestone';
  role: 'system';
  content: string;
  taskId: string;
  taskTitle: string | null;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  created_at: string;
}
/** An agent or command the chat's agent is still waiting on after its reply. */
export interface BackgroundTask {
  id: string;
  description: string;
  /** Epoch ms when the runtime first saw the task. */
  startedAt?: number;
}

type ApplicationWsEvent = { type: WsEventType; payload: unknown };

export type TranscriptEntry =
  | TranscriptUserMessage
  | TranscriptAssistantMessage
  | TranscriptResult
  | TranscriptSystem
  | TranscriptFallbackMessage
  | TranscriptMilestone;

export interface ConversationDiffFile {
  path: string;
  additions: number;
  deletions: number;
  kind?: 'file' | 'symlink';
  linkTarget?: string;
  renderError?: string;
  source?: 'task' | 'default-checkout-blocker';
  status?: string;
}

interface LinkedRepositoryDiff {
  name: string;
  path: string;
  base: string;
  branch: string;
  head?: string;
  merge_commit?: string;
  files: ConversationDiffFile[];
  patch: string;
}

export interface ConversationDiff {
  available: boolean;
  repositoryState?: 'unborn';
  defaultBranch?: string;
  reason?: string;
  scope?: 'branch' | 'worktree' | 'working-tree' | 'merged';
  base?: string;
  branch?: string;
  files?: ConversationDiffFile[];
  patch?: string;
  changeSections?: Array<{
    kind: 'committed' | 'staged' | 'unstaged';
    files: ConversationDiffFile[];
    patch: string;
  }> | null;
  /** True when the task-owned checkout has uncommitted or untracked changes. */
  uncommitted?: boolean;
  /** Worktree scope: commits on the local default branch the worktree branch lacks. */
  defaultBranchAhead?: number;
  /** Optional project-owned Git repositories nested inside the task worktree. */
  repositories?: LinkedRepositoryDiff[];
  /** Dirty default-checkout entries that are not attributed to the task-owned checkout. */
  blockers?: ConversationDiffFile[];
}

/** Response for `GET /api/projects/:pid/git/sync-status` (counts from the last fetch). */
export interface DefaultBranchSyncStatus {
  available: boolean;
  reason?: 'no-repository-url' | 'no-local-branch';
  branch: string;
  ahead: number;
  behind: number;
  /** False until the first fetch has created the tracking ref. */
  fetched: boolean;
  /** Whether a fast-forward pull of the shared checkout is possible now. */
  canPull: boolean;
  pullBlockedReason?: string;
}

/** Response for `GET /api/projects/:pid/files/group`. */
export interface FileExplorerEntry {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  ignored?: boolean;
  /** Byte size; present on file entries when the listing could read it. */
  sizeBytes?: number;
  /** ISO mtime; only returned for modified-date sorts. */
  modifiedAt?: string;
  /** Group-folder listings only: the caller may rename, move and delete it. */
  canManage?: boolean;
  /** Favorites section only: the favorite this row stands for. */
  favorite?: FileFavorite;
  /** Favorites section only: where the file lives, shown instead of its path. */
  origin?: string;
}

export interface GroupFilesResponse {
  entries: FileExplorerEntry[];
  nextCursor?: string;
  /** Whether the caller may rename, move and delete (owner, editor or admin). */
  canManage: boolean;
}

/** Identifies a favorite: a group-folder file or a knowledge-base document. */
export type FileFavoriteRef =
  | { kind: 'group'; path: string }
  | { kind: 'knowledge'; kbId: string; filename: string };

/** One of the caller's favorite files in a project, as `GET .../files/favorites` returns it. */
export type FileFavorite = FileFavoriteRef & {
  id: string;
  /** Display name (last path segment). */
  name: string;
  createdAt: string;
};

export type EditableFileSource = 'group' | 'artifact';

export interface EditableFileResponse {
  source: EditableFileSource;
  path: string;
  content: string;
  mimetype: string;
  size: number;
  revision: string;
  sensitive: boolean;
}

export interface EditableFileSaveResponse {
  source: EditableFileSource;
  path: string;
  size: number;
  revision: string;
}

/** Response for `GET /api/projects/:pid/conversations/:cid/files/repo`. */
export interface RepoFilesResponse {
  /** True when the file list was resolved from the sandbox repo. */
  available: boolean;
  /** Why the list is unavailable: 'no-repo' | 'repo-error' | 'list-failed'. */
  reason?: string;
  /** Immediate children of the requested directory. */
  entries?: FileExplorerEntry[];
  nextCursor?: string;
  /**
   * Repo-relative paths matched by .gitignore, sorted alphabetically. The
   * UI renders these with muted styling + a `.gitignore` badge so the
   * user can still open them (e.g. `.env` to inspect config) without
   * bloating the main tree.
   */
  ignored?: string[];
}

export interface Conversation {
  id: string;
  group_folder: string;
  preview: string | null;
  title?: string | null;
  pinned?: number | boolean;
  publiclyShared?: boolean;
  created_at: string;
  read_at?: string | null;
  session_id?: string | null;
  forked_from?: string | null;
  use_worktree?: number | boolean;
  promptCache1h?: boolean;
  worktree_path?: string | null;
  worktreeMissing?: boolean;
  branch_name?: string | null;
  status?: 'idle' | 'working' | 'finished' | 'failed' | 'pending';
  lastAssistantOutcome?: 'success' | 'failed' | 'pending' | null;
  objective_id?: string | null;
  last_agent_cmd?: string | null;
  runtimeSelection?: {
    harnessId: string;
    modelId: string;
    reasoning?: string;
  } | null;
  mainAiUserId?: string | null;
  mainAiUserMode?: 'inherit' | 'persona' | 'none';
  continuousPersonaLoop?: boolean;
  // Per-conversation timestamp aggregates, denormalized from the transcript.
  // Populated by `updateConversationAggregate()` whenever `saveChatMessage()`
  // writes a turn. The sidebar uses these to render the "last activity"
  // marker without scanning `chat_messages`.
  last_user_at?: string | null;
  last_assistant_at?: string | null;
  /** Sum of measured assistant-turn costs in this conversation. */
  costUsd?: number | null;
  /** True when some historical turns lacked full reported input usage. */
  costEstimated?: boolean;
  participants?: Array<{
    userId?: string;
    name: string;
    avatarUrl?: string | null;
  }>;
  ownerUserId?: string | null;
  lastTriggeredByUserId?: string | null;
  lastTriggerSource?: TriggerSource;
  lastTriggeredAt?: string | null;
  owner?: AttributionUser | null;
  latestTrigger?: TriggerMetadata;
}

export type ObjectiveStatus =
  | 'draft'
  | 'active'
  | 'achieved'
  | 'failed'
  | 'paused';

export interface Objective {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  priority: number;
  deadline?: string | null;
  progress: number;
  metadata?: Record<string, unknown> | null;
  trigger_config?: Record<string, unknown> | null;
  /** Optional override used only by autonomous objective event handling. */
  eventRuntimeSelection?: RuntimeSelection | null;
  work_dir?: string | null;
  cost_limit_usd?: number | null;
  created_at: string;
  updated_at: string;
  runStats?: ObjectiveRunStats | null;
  isAgentRunning?: boolean;
  chatStatus?: 'working' | 'finished' | 'failed' | 'pending' | null;
}

interface ObjectiveRunStats {
  totalCostUsd: number;
  runCount: number;
  lastRunAt: string | null;
  avgDurationMs: number;
  successRate: number; // 0-1
}

interface CustomValueDefinition {
  key: string;
  label?: string;
  type?: 'text' | 'number';
}

interface StarterPrompt {
  label: string;
  prompt: string;
}

interface OpenFilePosition {
  line: number;
  column: number;
}

export interface OpenFileContext {
  source: 'repo' | 'group' | 'artifact';
  path: string;
  repoContext?: 'main' | 'conversationWorktree';
  conversationId?: string;
  revision?: string;
  line?: number;
  column?: number;
  selection?: {
    start: OpenFilePosition;
    end: OpenFilePosition;
  };
  unsavedChanges?: boolean;
}

export interface ChatModeDefinition {
  id: string;
  label: string;
}

export interface ProjectSettings {
  sshEnabled?: boolean;
  kanbanRuntimeSelection?: RuntimeSelection | null;
  chatRuntimeSelection?: RuntimeSelection | null;
  defaultMainAiUserId?: string | null;
  defaultInvitedAiUserIds?: string[];
  defaultInvitedAiUserTeamIds?: string[];
  chatModes?: ChatModeDefinition[];
  chatModePrompts?: Record<string, string>;
  toolCallDisplay?: 'compact' | 'expanded';
  systemPrompt?: string;
  mode?: 'kanban' | 'chat' | 'objectives';
  isParent?: boolean;
  codeEnabled?: boolean;
  taskCheckoutMode?: 'shared' | 'branch' | 'worktree';
  autoPushAfterMerge?: boolean;
  privacyMode?: 'off' | 'local_memory' | 'strict' | null;
  kanbanTaskCostLimitUsd?: number | null;
  defaultBranch?: string;
  repositoryUrl?: string;
  issueImportEnabled?: boolean;
  repositoryLocation?: string;
  repositoryRelativePath?: string;
  relatedRepositories?: string[];
  memorySourceProjects?: string[];
  workerPrompt?: string;
  defaultSandbox?: string;
  defaultSandboxService?: string;
  defaultSandboxInstance?: string;
  sandboxOwnership?: 'standalone' | 'shared';
  sharedWorkspaceHostLocation?: string;
  sharedWorkspaceContainerRoot?: string;
  webRootPath?: string;
  appPublication?: {
    enabled: boolean;
    targetPort?: number;
    hostname?: string;
    binding: { stack: string; instance: string; service: string; id: string };
  };
  proxyHostnameAliases?: string[];
  maxParallelWorktrees?: number | null;
  autoStartStack?: boolean;
  stages?: StageDefinition[];
  status?: 'running' | 'paused' | 'stopped';
  custom_values?: CustomValueDefinition[];
  cardTemplate?: string;
  deployService?: string;
  deployStage?: string;
  starterPrompts?: StarterPrompt[];
  worktreeFiles?: string[];
  workspacePath?: string;
  workspaceRoots?: string[];
  extraMounts?: string[];
  brainContainer?: string;
  brainAuthToken?: string; // write-only: set a new token; never returned by the API
  brainAuthTokenSet?: boolean; // read-only: true when a token is currently configured
  effectivePrivacyMode?: 'off' | 'local_memory' | 'strict'; // read-only: strictest of own mode and all descendants'
  privacyModeInheritedFrom?: string | null; // read-only: folder of the strictest descendant when it raises the effective mode
  brainAuthRejected?: { status: number; at: string } | null; // read-only: the brain rejected the configured token (401/403) since board start
  carapaMailToken?: string; // write-only: set a new carapa-mail MCP token; never returned by the API
  carapaMailTokenSet?: boolean; // read-only: true when a carapa-mail token is currently configured
  carapaMailEnabled?: boolean; // toggle carapa-mail MCP injection for this project
  gracefulDeploy?: boolean;
  allowAgentTaskCreation?: boolean;
  disableObservations?: boolean;
  disabledToolsets?: string[]; // project removals from global default toolsets
  disabledSkills?: string[]; // shared skills hidden from this project's agents
  enabledModes?: string[];
}

export type ToolCallDisplay = NonNullable<ProjectSettings['toolCallDisplay']>;

export function resolveToolCallDisplay(value: unknown): ToolCallDisplay {
  return value === 'expanded' ? 'expanded' : 'compact';
}

export interface Project {
  revision?: string;
  id: string;
  name: string;
  folder: string;
  order?: number;
  jid?: string;
  stack?: string;
  service?: string;
  parentId?: string;
  userId?: string | null;
  accessLevel?: 'owner' | 'editor' | 'viewer' | null;
  isMain?: boolean;
  memberMode?: 'kanban' | 'chat' | 'objectives' | null;
  settings?: ProjectSettings;
  /** Runtime stage configuration after parent inheritance is resolved. */
  effectiveStages?: StageDefinition[];
  /** Variant suffixes of the stage alternatives configured here or inherited. */
  abVariantSuffixes?: string[];
  /** Review/testing stage alternatives a task can add as extra stages (`coStages`). */
  coStageOptions?: string[];
  stagesInherited?: boolean;
  effectiveSandbox?: EffectiveSandboxSettings;
}

interface RepositoryDiscoveryEntry {
  relativePath: string;
  repositoryLocation?: string;
  workspacePath?: string;
  projectId?: string;
  name?: string;
  originUrl?: string;
  reason?: string;
}

export interface RepositoryDiscoveryReport {
  created: RepositoryDiscoveryEntry[];
  existing: RepositoryDiscoveryEntry[];
  ignored: RepositoryDiscoveryEntry[];
  ambiguous: RepositoryDiscoveryEntry[];
  missing: RepositoryDiscoveryEntry[];
}

interface EffectiveSandboxSettings {
  ownerProjectId: string;
  inherited: boolean;
  managed: boolean;
  stack: string;
  instance: string;
  service: string;
  autoStart: boolean;
  hostWorkspaceLocation?: string;
  containerWorkspaceRoot: string;
  webRootPath: string;
  proxyHostnameAliases: string[];
  workspaceRoot: string;
  workspaceRoots: string[];
  extraMounts: Array<{
    slot: 1 | 2;
    hostPath: string;
    name: string;
    containerPath: string;
  }>;
  /** CarapaBox host running the sandbox; absent → this server's local box. */
  boxId?: string;
  /** False while that remote host is disconnected. */
  boxOnline?: boolean;
}

type WhatsAppConnectionStatus = 'disconnected' | 'qr_pending' | 'connected';

export interface WhatsAppStatus {
  status: WhatsAppConnectionStatus;
  qr?: string;
  jid?: string;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent_name?: string | null;
  model_name?: string | null;
  created_at: string;
  /** Feedback entries are actionable handoffs when an implementation run resumes. */
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
  steering?: boolean;
  steeringDelivery?: 'steered' | 'queued';
  run_id?: string | null;
  contentTruncated?: boolean;
  contentTotalBytes?: number;
  contentStartBytes?: number;
  target_stage?: string;
  source_stage?: string;
  prompt_id?: string;
}

export interface TaskRunLog {
  id: string;
  task_id: string;
  run_at: string;
  duration_ms: number | null;
  status: 'success' | 'error' | 'stopped' | 'running';
  output: string | null;
  error: string | null;
  model: string | null; // the model identifier used to configure/run the task
  model_name: string | null; // the full name string returned by the agent itself during execution
  agent_name: string | null;
  session_id: string | null;
  tok_total: number | null;
  tok_output?: number | null;
  tok_input?: number | null;
  tok_cache_write?: number | null;
  tok_cache_read?: number | null;
  tok_context_last?: number | null;
  tool_usage_count: number | null;
  cost_usd?: number | null;
  reviewScore: number | null;
  /** Tester verdict of a testing-stage run; null/absent when unknown or not a testing run. */
  testingDecision?: 'pass' | 'fail' | 'blocked' | null;
  stage: string | null;
  trigger?: TriggerMetadata;
}

export interface AvailableGroup {
  jid: string;
  name: string | null;
  lastActivity: string | null;
  isRegistered: boolean;
}

export interface Cronjob {
  id: string;
  project_id: string;
  title: string;
  description: string;
  cron_expression: string;
  objective_id?: string | null;
  queue_mode: 'always' | 'if_empty';
  model?: string | null;
  agent_name?: string | null;
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  status: 'active' | 'paused';
  last_run?: string;
  next_run?: string;
  archived?: boolean;
  created_at: string;
}

export interface ScheduledTask {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  runtimeSelection?: RuntimeSelection | null;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: 'active' | 'paused' | 'completed';
  running: boolean;
  runningSince?: string | null;
  createdAt: string;
}

export interface ScheduledTaskRun {
  id: string;
  runId: string | null;
  runAt: string;
  durationMs: number | null;
  status: 'running' | 'finalizing' | 'success' | 'error';
  result: string | null;
  error: string | null;
  model: string | null;
  modelName: string | null;
  tokTotal: number | null;
  costUsd: number | null;
  transcriptAvailable: boolean;
}

interface ScheduledTaskTranscriptEntry {
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  [key: string]: unknown;
}

export interface ScheduledTaskTranscript {
  prompt: string | null;
  entries: ScheduledTaskTranscriptEntry[];
}

export interface DatasetTask {
  id: string;
  project_id: string;
  title: string;
  description: string;
  dataset: Record<string, string | number>[];
  total_rows: number;
  completed_rows: number;
  current_row_index: number;
  model?: string | null;
  agent_name?: string | null;
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  objective_id?: string | null;
  status: 'active' | 'paused' | 'completed';
  archived?: boolean;
  created_at: string;
}

type WsEventType =
  | 'connected'
  | 'task_created'
  | 'task_updated'
  | 'cronjob_updated'
  | 'task_deleted'
  | 'task_started'
  | 'task_preparing'
  | 'run_finished'
  | 'task_output'
  | 'task_output_clear'
  | 'task_background_tasks'
  | 'task_completed'
  | 'task_error'
  | 'task_message'
  | 'run_stalled_warning'
  | 'run_stall_cleared'
  | 'run_killed_stalled'
  | 'chat_message'
  | 'chat_audio_transcript'
  | 'chat_persona_started'
  | 'chat_persona_output'
  | 'chat_persona_finished'
  | 'speech_ready'
  | 'speech_failed'
  | 'chat_started'
  | 'memory_capsule_ready'
  | 'chat_output'
  | 'chat_background_tasks'
  | 'chat_stream_snapshot'
  | 'chat_replay_complete'
  | 'chat_completed'
  | 'scheduled_task_run_started'
  | 'scheduled_task_run_completed'
  | 'live_activity'
  | 'live_activity_snapshot'
  | 'persona_live_mode'
  | 'persona_live_queue'
  | 'task_stream_snapshot'
  | 'meeting_transcript'
  | 'conversations_changed'
  | 'artifacts_changed'
  | 'group_files_changed'
  | 'projects_changed'
  | 'runtime_catalog_changed'
  | 'shells_changed'
  | 'sandbox_state_changed'
  | 'objective_created'
  | 'objective_updated'
  | 'objective_deleted'
  | 'objective_dashboard_updated'
  | 'dataset_task_updated'
  | 'messages_cleared'
  | 'sandbox_status'
  | 'whatsapp_status'
  | 'server_restarted'
  | 'deploy_ready'
  | 'deploy_failed'
  | 'android_update_ready'
  | 'notification_created'
  | 'notification_acked'
  | 'memory_audit_updated';

export type WsEvent = ApplicationWsEvent;

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  folder_path: string;
  last_indexed_at: number | null;
  created_at: number;
}

export interface KnowledgeVectorStatus {
  enabled: boolean;
  available: boolean;
  status: 'available' | 'unavailable' | 'disabled';
}

export interface KnowledgeChunk {
  id: string;
  knowledge_base_id: string;
  content: string;
  metadata: any;
  score?: number;
}

// Security — duress instructions the main agent follows when the duress
// signal fires. Stored server-side only (never on the device).

export interface DuressInstructionsResponse {
  /** The configured instructions, or an empty string when none are set. */
  instructions: string;
}

// Meeting recordings

export interface MeetingRecordingState {
  isRecording: boolean;
  isStarting: boolean;
  isStopping: boolean;
  recordingId: string | null;
  error: string | null;
  /** Duration in seconds since recording started */
  duration: number;
  /** Partial transcript received from the server */
  partialTranscript: string | null;
  /** Browser URL for the saved transcript artifact (set on stop) */
  artifactUrl: string | null;
  /** Group-relative path for the agent, e.g. artifacts/conv-id/file.md */
  artifactRelPath: string | null;
  artifactFilename: string | null;
  /** Saved recordings, one per recorded segment: browser URL and the
   * group-relative path for the agent. */
  audioRecordings: Array<{ url: string; relPath: string }>;
  /** ISO-639-1 language hint for this meeting, or auto. */
  language: string | null;
}
export interface BrowserSession {
  sessionId: string;
  scope: 'default' | 'conversation' | 'run';
  runId: string | null;
  projectId: string;
  taskId: string | null;
  conversationId: string | null;
  worktree: string | null;
  agentName: string | null;
  startedAt: string;
  availability: 'waiting';
}

interface MailCapabilities {
  read: boolean;
  send: boolean;
  organize: boolean;
}
export interface MailAccount {
  id: string;
  email: string;
  capabilities: MailCapabilities;
}
export interface MailFolder {
  name: string;
  path: string;
  total: number;
  unseen: number;
  specialUse?: string;
}
interface MailMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
  attachmentCount: number;
}
export interface MailMessageDetail extends MailMessage {
  cc: string;
  bodyText: string;
  replyTo: string;
  messageId: string;
  references: string[];
  attachments: { name: string; type: string; size: number }[];
}
export interface MailPage {
  items: MailMessage[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
}
export interface MailDraft {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
}
