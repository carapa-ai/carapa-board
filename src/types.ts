/** Content revision of one project as visible to the requesting account. */
export interface ProjectRevision {
  id: string;
  revision: string;
}

import type { StageDefinition } from './modules/kanban/types.js';

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

export type ProjectModeStatus = 'idle' | 'working' | 'finished';

export interface ProjectModeStatuses {
  kanban: ProjectModeStatus;
  chat: ProjectModeStatus;
  objectives: ProjectModeStatus;
}

export interface ProjectsStatusSummary {
  projects: Record<string, ProjectModeStatuses>;
}

export type AttentionState =
  | 'running'
  | 'pending'
  | 'failed'
  | 'question'
  | 'unread'
  | 'completed';

/** One row of the sidebar "Now" list from GET /api/projects/attention. */
export interface AttentionItem {
  kind: 'conversation' | 'task';
  id: string;
  projectId: string;
  /** Set when the conversation belongs to an objective. */
  objectiveId?: string;
  title: string;
  state: AttentionState;
  /** Run start, last assistant reply, stage entry, or completion time. */
  at: string;
  /** Completed tasks only. */
  completionEventId?: number;
  /**
   * Conversations only: false once the user opened the latest reply. Absent
   * for callers without a user, whose list holds only unread replies.
   */
  unread?: boolean;
}

export interface AttentionResponse {
  items: AttentionItem[];
  objectives: Array<{ id: string; title: string }>;
  /** Rows of a capped group (Replies, Completed) that were not returned. */
  hiddenCounts?: Partial<Record<'unread' | 'completed', number>>;
  /** Server time the list was built; `asOf` for dismissing a whole group. */
  generatedAt?: string;
}

export interface AppPublicationSettings {
  enabled: boolean;
  targetPort?: number;
  hostname?: string;
  /** Board-owned binding, never accepted from an agent or settings form. */
  binding: { stack: string; instance: string; service: string; id: string };
}

export interface ProjectSettings {
  /** Board-owned opt-out from WhatsApp self-chat auto-linking. */
  whatsappSelfChatAutoLinkDisabled?: boolean;
  /**
   * Outbound-content policy. `local_memory` keeps memory, Jev, embedding and
   * knowledge-verify traffic on local endpoints; `strict` keeps every gated
   * purpose local. Absent means `off`. Admin-only; downgrades need a fresh
   * device signature (see PATCH /projects/:pid).
   */
  privacyMode?: 'off' | 'local_memory' | 'strict';
  /** Desired sandbox SSH state, changed only through the owner-scoped SSH API. */
  sshEnabled?: boolean;
  /** Structured Kanban runtime override. */
  kanbanRuntimeSelection?:
    | import('./lib/chat-agents.js').RuntimeSelection
    | null;
  /** Structured chat runtime override. */
  chatRuntimeSelection?: import('./lib/chat-agents.js').RuntimeSelection | null;
  /** Default main persona inherited by conversations that have not overridden it. */
  defaultMainAiUserId?: string | null;
  /** Personas invited to new conversations unless the conversation supplies its own invite list. */
  defaultInvitedAiUserIds?: string[];
  /** Teams expanded into enabled persona invitations when a new conversation is created. */
  defaultInvitedAiUserTeamIds?: string[];
  chatModes?: Array<{ id: string; label: string }>;
  chatModePrompts?: Record<string, string>;
  /** Initial presentation for tool request/result activity in project chat. */
  toolCallDisplay?: 'compact' | 'expanded';
  systemPrompt?: string; // [DEPRECATED] Use .agent/prompts/system.md instead
  mode?: 'kanban' | 'chat' | 'objectives'; // 'objectives' shows a SMART objectives dashboard
  isParent?: boolean; // marks this as a parent/coordinator project (coordinates child groups)
  /** Code-project onboarding; defaults off for main agents and on for other projects. Not a tool permission. */
  codeEnabled?: boolean;
  /** Task checkout strategy: shared main checkout, serialized branch checkout, or isolated worktree. */
  taskCheckoutMode?: 'shared' | 'branch' | 'worktree';
  autoPushAfterMerge?: boolean; // automatically push default branch to remote after review merge
  /** Per-task USD limit: once a card's run cost reaches it, automatic runs stop. Null/absent = no limit. */
  kanbanTaskCostLimitUsd?: number | null;
  defaultBranch?: string; // base branch to return to after a task (default: 'develop')
  repositoryUrl?: string; // git repo URL
  /** Poll the repository's GitLab issues and import unseen open issues into backlog. */
  issueImportEnabled?: boolean;
  repositoryLocation?: string; // absolute path to repo on HOST — never accessible from inside containers
  repositoryRelativePath?: string; // path relative to a shared parent workspace
  relatedRepositories?: string[]; // additional repositories authorized for structural awareness
  /** Project folders whose memories this project may recall. */
  memorySourceProjects?: string[];
  workerPrompt?: string; // API transport for the prompt file; never persisted
  defaultSandbox?: string; // sandbox stack name override
  defaultSandboxService?: string; // sandbox service name override (default: 'agent')
  defaultSandboxInstance?: string; // fixed instance name — skips auto-naming and auto-start
  boxId?: string; // CarapaBox host running this project's sandbox (absent → local box); admin-assigned only
  sandboxOwnership?: 'standalone' | 'shared'; // shared = this parent explicitly owns one managed sandbox inherited by its children
  sharedWorkspaceHostLocation?: string; // host-side directory containing child repositories
  sharedWorkspaceContainerRoot?: string; // container-side root for the shared workspace
  webRootPath?: string; // relative path under the sandbox workspace served by web stacks (e.g. child-repo/public)
  appPublication?: AppPublicationSettings;
  proxyHostnameAliases?: string[]; // optional public aliases accepted by the generated host-nginx route
  maxParallelWorktrees?: number; // concurrent task slots (1–10, default 1)
  autoStartStack?: boolean; // auto-start sandbox stack at app startup (default true)
  stages?: StageDefinition[]; // kanban stages
  status?: 'running' | 'paused' | 'stopped'; // project execution state (default 'running')
  custom_values?: any[]; // user-defined value fields on tasks (will be CustomValueDefinition[])
  cardTemplate?: string; // twig-like HTML template for card display, e.g. "<b>{{score}}</b> {{summary}}"
  deployService?: string; // managed service name for auto-deploy (e.g. 'carapa-board')
  deployStage?: string; // stage ID that triggers auto-deploy (default: first done stage)
  workspacePath?: string; // container working dir slug for GIT_REPO mode (default: group folder)
  /** Up to two host folders mounted read-only at /workspace/<folder name>. CarapaBox enforces its mount allowlist. */
  extraMounts?: string[];
  workspaceRoots?: string[]; // additional absolute container-side paths the fs tools may read (operator must keep aligned with bind mounts)
  starterPrompts?: any[]; // [DEPRECATED] Use .agent/prompts/starters.json instead
  worktreeFiles?: string[]; // gitignored files to symlink into task worktrees (e.g. ['.env'])
  brainContainer?: string; // carapa-brain container name (from CarapaBox stack instance), e.g. 'carapa-brain-1'
  brainAuthToken?: string; // per-project auth token for the carapa-brain API (encrypted at rest)
  carapaMailToken?: string; // per-project carapa-mail MCP token (encrypted at rest); injected to the sandbox as CARAPA_MAIL_MCP_TOKEN for relay auth
  carapaMailEnabled?: boolean; // toggle carapa-mail MCP injection on/off for this project
  gracefulDeploy?: boolean; // deploy uses build_service + deploy_ready event; watcher restarts on health fail
  allowAgentTaskCreation?: boolean; // allow agents to create tasks in this project via MCP (default true); false = only manual UI creation
  disabledToolsets?: string[]; // project removals from the global default toolsets
  disabledSkills?: string[]; // shared skills hidden from this project's agents
  disableObservations?: boolean; // disable extraction of observations into .agent/reflections/observations.md (default false)
  enabledModes?: string[]; // optionally enabled modes per project (e.g., ['kanban', 'chat'])
}

export type ToolCallDisplay = NonNullable<ProjectSettings['toolCallDisplay']>;

/** Treat absent or legacy-invalid persisted values as the compact default. */
export function resolveToolCallDisplay(value: unknown): ToolCallDisplay {
  return value === 'expanded' ? 'expanded' : 'compact';
}

export type MainAiUserSelection =
  | { mode: 'inherit' }
  | { mode: 'none' }
  | { mode: 'persona'; aiUserId: string };

/**
 * Effective concurrent task slots for a project. Shared and branch modes
 * serialize because they mutate the main checkout; worktree mode may use the
 * configured parallel capacity.
 */
export function effectiveMaxParallel(settings?: ProjectSettings): number {
  if ((settings?.taskCheckoutMode ?? 'shared') !== 'worktree') return 1;

  const configuredMax = settings?.maxParallelWorktrees ?? 1;
  if (!Number.isFinite(configuredMax)) return 1;
  return Math.max(1, Math.min(10, Math.floor(configuredMax)));
}

interface OpenFilePosition {
  line: number;
  column: number;
}

/** Metadata for the single file visibly open beside a chat composer. */
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

export interface RegisteredGroup {
  name: string;
  jid?: string;
  folder: string;
  trigger: string;
  added_at: string;
  order?: number;
  parentId?: string; // folder of the parent project (if this is a child)
  settings?: ProjectSettings;
  is_main?: boolean;
  user_id?: string;
}

export type Project = RegisteredGroup;

/** An extra read-only host folder as mounted inside the sandbox. */
export interface ExtraMountSettings {
  slot: 1 | 2;
  hostPath: string;
  /** Folder name under /workspace. */
  name: string;
  containerPath: string;
}

export interface EffectiveSandboxSettings {
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
  extraMounts: ExtraMountSettings[];
  /** CarapaBox host running the sandbox (the owner's `settings.boxId`); absent → local box. */
  boxId?: string;
}

/** Structured feedback recorded in a task description for a polish/re-review pass. */
export interface ReviewFeedback {
  reviewer: string;
  verdict: 'accepted with nits' | 'accepted with nits (polish cap reached)';
  timestamp: string;
  nits: Array<{ title: string; description: string }>;
}

// --- Task description draft (one-shot LLM rewrite) ---

/**
 * A single prior refine turn from a description-draft session.
 * Ordered oldest first; the last entry is the newest draft.
 */
export interface TaskDescriptionDraftHistoryEntry {
  instruction: string;
  draft: string;
}

/** Request body for `POST /api/projects/:pid/tasks/:fid/description/draft`. */
export interface TaskDescriptionDraftRequest {
  instruction: string;
  /** Prior refine turns from the same panel, oldest first. Optional. */
  history?: TaskDescriptionDraftHistoryEntry[];
}

export interface Session {
  [folder: string]: string;
}

/** Read-only projection for task milestones stored by retired runtimes. */
export interface HistoricalTaskMilestoneTranscriptEntry {
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

/**
 * Response for `GET /api/projects/:pid/files/group`.
 * A flat list of file paths relative to `groups/<folder>/`, with noisy
 * directories (logs, node_modules, .git, …) skipped.
 */
export interface FileExplorerEntry {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  ignored?: boolean;
  /** Byte size; present on file entries when the listing could read it. */
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface GroupFilesResponse {
  entries: FileExplorerEntry[];
  nextCursor?: string;
  /** Whether the caller may rename, move and delete (owner/admin only). */
  canManage: boolean;
}

/**
 * Response for the project-main or conversation-scoped repo files endpoint.
 * Lists the project repo's tracked + untracked files (respecting .gitignore)
 * via the sandbox. Mirrors the conversation diff endpoint's availability shape:
 * `available: false` with a `reason` when there's no repo or the sandbox call fails.
 */
export interface RepoFilesResponse {
  /** True when the file list was resolved from the sandbox repo. */
  available: boolean;
  /** Why the list is unavailable: 'no-repo' | 'repo-error' | 'list-failed'. */
  reason?: string;
  /** Immediate children of the requested directory. */
  entries?: FileExplorerEntry[];
  nextCursor?: string;
  /**
   * Repo-relative paths matched by .gitignore, sorted alphabetically.
   * The UI renders these separately with muted styling so ignored files
   * stay visible (and openable) without bloating the main tree. Always
   * present (possibly empty) when `available` is true; defaults to `[]`
   * on the failure paths so consumers don't need a separate existence
   * check.
   */
  ignored?: string[];
}

export interface PersonaLiveQueueSnapshot {
  protocolVersion: 2;
  conversationId: string;
  runId: string;
  epoch: number;
  mode: 'personas' | 'work';
  revision: number;
  status: 'active' | 'paused' | 'stopping' | 'off';
  serverNow: string;
  leaderSessionId: string | null;
  /** Persisted lookahead messages that clients must not render yet. */
  hiddenMessageIds: string[];
  /** Identity-only metadata for hidden speakers; response text is omitted. */
  hiddenItems: Array<{
    messageId: string;
    participantId: string;
    state: 'generating' | 'synthesizing' | 'ready';
    senderName: string;
    createdAt: string;
    emote: string | null;
    telemetry: Record<string, unknown> | null;
  }>;
  /** Unreleased messages explicitly discarded by Stop/failure. */
  cancelledMessageIds: string[];
  /** Messages whose server-owned playback window has completed. */
  completedMessageIds: string[];
  /** Canonical data for completed messages whose playback snapshots were missed. */
  completedItems: Array<{
    messageId: string;
    participantId: string;
    text: string;
    content: string;
    senderName: string;
    createdAt: string;
    emote: string | null;
    telemetry: Record<string, unknown> | null;
  }>;
  current: null | {
    id: string;
    sequence: number;
    participantId: string;
    messageId: string;
    state:
      | 'generating'
      | 'synthesizing'
      | 'ready'
      | 'released'
      | 'playing'
      | 'completed'
      | 'failed'
      | 'cancelled';
    durationMs: number | null;
    releasedAt: string | null;
    startedAt: string | null;
    endsAt: string | null;
    error: string | null;
    text: string;
    content: string;
    senderName: string;
    createdAt: string;
    emote: string | null;
    telemetry: Record<string, unknown> | null;
  };
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
export interface MailMessage {
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
