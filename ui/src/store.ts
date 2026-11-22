import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ChatDeepLink,
  ChatMessageAttachment,
  OpenFileContext,
  BackgroundTask,
} from '@/types';
import type { LiveConversationMetadata } from '@/lib/live-mode';
import type { MemoryContextLevel, RuntimeSelection } from '@/lib/api';
import { liveModeSessionId } from '@/lib/live-mode-session';

const utf8Encoder = new TextEncoder();

function sliceUtf8From(value: string, startByte: number): string {
  let offset = 0;
  let start = 0;
  for (const point of value) {
    const next = offset + utf8Encoder.encode(point).byteLength;
    if (offset >= startByte) break;
    start += point.length;
    offset = next;
  }
  return value.slice(start);
}

export interface TaskStreamEntry {
  id: string;
  content: string;
  startOffset: number;
  endOffset: number;
  complete: boolean;
}

const TASK_STREAM_ENTRY_TARGET_BYTES = 32 * 1024;

function retainNewestWholeTaskEntries(
  entries: TaskStreamEntry[],
): TaskStreamEntry[] {
  let retainedBytes = 0;
  let keepFrom = entries.length - 1;
  for (; keepFrom >= 0; keepFrom -= 1) {
    const size = utf8Encoder.encode(entries[keepFrom].content).byteLength;
    if (
      retainedBytes > 0 &&
      retainedBytes + size > TASK_STREAM_ENTRY_TARGET_BYTES
    )
      break;
    retainedBytes += size;
  }
  const targetKeepFrom = keepFrom + 1;
  const oldestOpen = entries.findIndex((entry) => !entry.complete);
  return entries.slice(
    oldestOpen >= 0 ? Math.min(targetKeepFrom, oldestOpen) : targetKeepFrom,
  );
}

function appendToTaskStreamEntries(
  entries: TaskStreamEntry[],
  id: string,
  content: string,
  startOffset: number,
  complete = true,
): TaskStreamEntry[] {
  const next = entries.map((entry) => ({ ...entry }));
  const existing = next.find((entry) => entry.id === id);
  // Parallel calls interleave on the wire. Their stable identity, not chunk
  // adjacency, determines the renderer entry that receives a later result.
  if (existing) {
    existing.content += content;
    existing.complete = complete;
  } else
    next.push({
      id,
      content,
      startOffset,
      endOffset: startOffset,
      complete,
    });

  let projectedOffset = next[0]?.startOffset ?? startOffset;
  for (const entry of next) {
    entry.startOffset = projectedOffset;
    projectedOffset += utf8Encoder.encode(entry.content).byteLength;
    entry.endOffset = projectedOffset;
  }
  return next;
}
export type ConversationTabValue =
  | 'preview'
  | 'changes'
  | 'files'
  | 'browser'
  | 'bash'
  | 'mail';

export interface QueuedPrompt {
  id?: string;
  /** Project folder or objective ID that owns this queued send. */
  contextKey: string;
  content: string;
  bubbleContent: string;
  /** Original composer text, retained so a queued prompt can be edited. */
  draftContent?: string;
  deepLinks?: ChatDeepLink[];
  conversation_id?: string;
  attachments?: ChatMessageAttachment[];
  agent_cmd?: string;
  chat_mode?: string;
  runtimeSelection?: RuntimeSelection;
  memoryContextLevel: MemoryContextLevel;
  /** Captured when this prompt entered the delivery path; never recomputed. */
  openFileContext?: OpenFileContext;
  /** A durable server queue owns this prompt. */
  serverOwned?: boolean;
  /** Only persona-owned queues are withdrawable; other server receipts are immutable. */
  serverQueueOwner?: 'persona' | 'direct' | 'server';
  /** A terminal event returned this stable ID to browser ownership. */
  serverReleased?: boolean;
  /** Server consumed this prompt; keep it visible until its transcript row owns it. */
  consumedByServer?: boolean;
  /** The initial POST has not yet acknowledged which layer owns this prompt. */
  awaitingAcknowledgement?: boolean;
  liveMode?: boolean;
  liveModeSessionId?: string;
  liveModeKind?: 'personas' | 'work';
}
export type ChatModeOverride = string;

export type AdminOverlayId =
  | 'provider-accounts'
  | 'mcp-connections'
  | 'boxes'
  | 'ai-users'
  | 'memory-review'
  | 'costs'
  | 'users'
  | 'devices';

// A single preview tab in the right pane (e.g. image preview, file preview,
// html/markdown render). When the array is empty the right pane falls back to
// the existing ConversationExplorer (Changes/Files).
export interface PreviewTab {
  id: string;
  title: string;
  kind: string;
  source?: string;
  path?: string;
  /**
   * Optional MIME type for the file. When omitted the renderer infers one
   * from the path/filename extension. Set this when the source doesn't have
   * an extension or the extension is misleading (e.g. octet-stream uploads
   * that are actually images).
   */
  mimetype?: string;
  /** Optional byte size — used by the binary-download fallback. */
  size?: number | null;
  /**
   * Originating conversation for `source: 'repo'` tabs. Repo file content is
   * served from a conversation-scoped endpoint (and worktree conversations
   * have their own checkout), so a repo tab reflects the conversation it was
   * opened from — not whichever conversation is currently active. Pinning the
   * id here keeps the fetch URL stable when the user switches conversations,
   * so the preview doesn't re-fetch (and flash) on every conversation change.
   * Group-sourced files are project-scoped and don't need this.
   */
  conversation_id?: string;
  /** Conversation that explicitly established prompt context for this tab. */
  openFileContextConversationId?: string | null;
  /** Main checkout or a conversation-owned worktree. */
  repoContext?: 'main' | 'conversation';
  /** Extra read-only mount slot for `source: 'mount'` tabs. */
  mountSlot?: number;
  /** Index into the project's extra workspace roots for `source: 'root'` tabs. */
  rootIndex?: number;
  /** Absolute in-container path, used when dragging a mount file into the composer. */
  containerPath?: string;
  /** Embedded content used only when a historical artifact URL no longer exists. */
  fallbackContent?: string;
}

interface PreviewTabsState {
  tabs: PreviewTab[];
  activeTabId: string | null;
  activationSequence: number;
}

type LeaveDecision = boolean | Promise<boolean>;

const previewTabLeaveGuards = new Map<string, () => LeaveDecision>();
// One in-flight asynchronous guard per tab, so a repeated gesture (for example
// a double-click on a tab close) shares the open prompt instead of stacking
// another.
const pendingLeaveChecks = new Map<string, Promise<boolean>>();
const previewGuardKey = (projectId: string, tabId: string) =>
  `${projectId}\0${tabId}`;

export function registerPreviewTabLeaveGuard(
  projectId: string,
  tabId: string,
  guard: () => LeaveDecision,
): () => void {
  const key = previewGuardKey(projectId, tabId);
  previewTabLeaveGuards.set(key, guard);
  return () => {
    if (previewTabLeaveGuards.get(key) === guard)
      previewTabLeaveGuards.delete(key);
  };
}

/** Runs the tab's guard; stays synchronous unless the guard itself is async. */
function checkPreviewTabLeave(
  projectId: string,
  tabId: string | null,
): LeaveDecision {
  if (!tabId) return true;
  const key = previewGuardKey(projectId, tabId);
  const pending = pendingLeaveChecks.get(key);
  if (pending) return pending;
  const decision = previewTabLeaveGuards.get(key)?.() ?? true;
  if (typeof decision === 'boolean') return decision;
  const tracked: Promise<boolean> = decision.finally(() => {
    if (pendingLeaveChecks.get(key) === tracked) pendingLeaveChecks.delete(key);
  });
  pendingLeaveChecks.set(key, tracked);
  return tracked;
}

/**
 * Runs `apply` once a leave decision (e.g. the result of `openPreviewTab`)
 * allows it, synchronously when the decision is already known. Returns the
 * decision.
 */
export function applyIfLeaveAllowed(
  decision: LeaveDecision,
  apply: () => void,
): LeaveDecision {
  if (typeof decision === 'boolean') {
    if (decision) apply();
    return decision;
  }
  return decision.then((allowed) => {
    if (allowed) apply();
    return allowed;
  });
}

export async function canLeavePreviewTab(
  projectId: string,
  tabId: string | null,
): Promise<boolean> {
  return checkPreviewTabLeave(projectId, tabId);
}

export async function canLeaveActivePreview(
  projectId: string,
): Promise<boolean> {
  const activeTabId =
    useStore.getState().previewTabsByProject[projectId]?.activeTabId ?? null;
  return checkPreviewTabLeave(projectId, activeTabId);
}

interface UIState {
  liveModeEnabled: boolean;
  liveModeFocusedConversationId: string | null;
  liveModeCurrentProjectId: string | null;
  liveModeRegistry: LiveConversationMetadata[];
  liveModeListening: boolean;
  liveModeSpeaking: boolean;
  liveModeSessionId: string;
  liveModeEnabledByConversation: Record<string, boolean>;
  liveModeSessionByConversation: Record<string, string | null>;
  liveModeKindByConversation: Record<string, 'personas' | 'work'>;
  liveModeMicrophoneEnabledByConversation: Record<string, boolean>;
  /** Per-chat speech-to-text language chosen on this device; absent means
   * the account dictation language or the operator default. */
  liveModeLanguageByConversation: Record<string, string>;
  liveModeRoutingResult: {
    kind: 'answer' | 'clarification' | 'error';
    message: string;
  } | null;
  setLiveModeEnabled: (enabled: boolean) => void;
  setConversationLiveModeEnabled: (
    conversationId: string,
    enabled: boolean,
  ) => void;
  setConversationLiveModeSession: (
    conversationId: string,
    sessionId: string | null,
  ) => void;
  setConversationLiveModeKind: (
    conversationId: string,
    kind: 'personas' | 'work',
  ) => void;
  setLiveModeFocus: (
    conversationId: string | null,
    projectId?: string | null,
  ) => void;
  setLiveModeRegistry: (registry: LiveConversationMetadata[]) => void;
  mergeLiveModeActivity: (
    activity: Partial<LiveConversationMetadata> & { conversationId: string },
  ) => void;
  setLiveModeAudioState: (listening: boolean, speaking: boolean) => void;
  setLiveModeMicrophoneEnabled: (
    conversationKey: string,
    enabled: boolean,
  ) => void;
  setLiveModeLanguage: (
    conversationKey: string,
    language: string | null,
  ) => void;
  setLiveModeRoutingResult: (result: UIState['liveModeRoutingResult']) => void;
  streamingOutput: Record<string, string>;
  streamingOutputStartOffsets: Record<string, number>;
  streamingOutputSnapshots: Record<
    string,
    { content: string; startOffset: number; entries: TaskStreamEntry[] }
  >;
  streamingOutputEntries: Record<string, TaskStreamEntry[]>;
  appendOutput: (
    task_id: string,
    chunk: string,
    entryId?: string,
    entryComplete?: boolean,
  ) => void;
  setTaskOutput: (
    task_id: string,
    content: string,
    startOffset?: number,
    entryId?: string,
    entries?: TaskStreamEntry[],
    entryComplete?: boolean,
  ) => void;
  clearOutput: (task_id: string) => void;
  clearAllTaskStreaming: () => void;

  // Exact run ownership for the retained task stream. A finished stream stays
  // available until the post-finish transcript refetch has completed, so the
  // dialog can hand off without either a duplicate bubble or an empty frame.
  taskStreamRunIds: Record<string, string>;
  finishedTaskStreamRunIds: Record<string, string>;
  readyTaskTranscriptRunIds: Record<string, string>;
  claimTaskStream: (task_id: string, run_id: string) => void;
  finishTaskStream: (task_id: string, run_id: string) => void;
  markTaskTranscriptReady: (task_id: string, run_id: string) => void;

  // Task IDs we've seen task_started for but not yet task_completed/task_error.
  // Acts as a UI-side fallback for the kanban-card pulse so it stays visible
  // even when the tasks API refetch races recovery completion and returns
  // running:false before the user has seen the pulse.
  liveTaskIds: Record<string, boolean>;
  markTaskLive: (task_id: string) => void;
  unmarkTaskLive: (task_id: string) => void;

  // Chat streaming output from WebSocket (streamKey → accumulated chunks)
  chatStreamingOutput: Record<string, string>;
  appendChatOutput: (key: string, chunk: string) => void;
  setChatOutput: (key: string, content: string) => void;
  clearChatOutput: (key: string) => void;
  // Attachments from the authoritative assistant chat_message. Completed
  // stream bubbles remain mounted during transcript handoff, so they need the
  // same durable attachments as the canonical transcript row they represent.
  chatStreamingAttachments: Record<string, ChatMessageAttachment[]>;
  setChatStreamingAttachments: (
    key: string,
    attachments: ChatMessageAttachment[],
  ) => void;

  // Tracks which stream keys have completed (content preserved for display)
  chatStreamingCompleted: Record<string, boolean>;
  markChatOutputCompleted: (key: string) => void;

  // Tracks telemetry (stats) for completed stream keys
  chatStreamingTelemetry: Record<string, Record<string, any>>;
  setChatStreamingTelemetry: (
    key: string,
    telemetry: Record<string, any>,
  ) => void;

  // Immutable presentation metadata captured when each chat run starts. The
  // conversation's selected main participant may change while an older run is
  // still streaming, so bubbles must not derive ownership from current config.
  chatStreamPresentation: Record<
    string,
    {
      personaDriven?: boolean;
      /** Persona turns arrive as canonical chat_message rows; no generic stream bubble owns them. */
      canonicalPersonaTurns?: boolean;
      virtualSender?: {
        id: string;
        name: string;
        identity: string;
        avatarUrl: string | null;
      } | null;
    }
  >;
  setChatStreamPresentation: (
    key: string,
    presentation: UIState['chatStreamPresentation'][string],
  ) => void;

  // Maps conversation_id → latest run stream key UUID (for stream content lookup)
  activeStreamKeyByConv: Record<string, string>;
  chatStreamRetiredByConv: Record<string, boolean>;
  setActiveStreamKeyForConv: (convId: string, key: string) => void;
  retireChatStreamForConv: (convId: string) => void;
  clearRetiredChatStreamForConv: (convId: string) => void;

  // Maps conversation_id → previous run stream key (shown while new run has no content yet)
  prevStreamKeyByConv: Record<string, string>;
  setPrevStreamKeyForConv: (convId: string, key: string) => void;
  clearPrevStreamKeyForConv: (convId: string) => void;
  clearAllChatStreaming: () => void;

  // Task detail dialog
  detailTaskId: string | null;
  setDetailTaskId: (id: string | null) => void;
  detailTaskTab:
    | 'details'
    | 'chat'
    | 'history'
    | 'changes'
    | 'recordings'
    | null;
  setDetailTaskTab: (
    tab: 'details' | 'chat' | 'history' | 'changes' | 'recordings' | null,
  ) => void;
  openTaskDetail: (
    taskId: string,
    tab: 'details' | 'chat' | 'history' | 'changes' | 'recordings',
  ) => void;
  reviewRunIntent: { taskId: string } | null;
  setReviewRunIntent: (intent: { taskId: string } | null) => void;
  openTaskWithReviewIntent: (taskId: string) => void;

  // Add task dialog
  addDialogOpen: boolean;
  setAddDialogOpen: (open: boolean) => void;

  // Add project dialog
  addProjectDialogOpen: boolean;
  setAddProjectDialogOpen: (open: boolean) => void;

  // Project settings dialog
  settingsProjectId: string | null;
  setSettingsProjectId: (id: string | null) => void;
  /** Project whose Share dialog is open; the dialog is mounted once at the app root. */
  shareProjectId: string | null;
  setShareProjectId: (id: string | null) => void;

  // Add cronjob dialog
  addCronjobDialogOpen: boolean;
  setAddCronjobDialogOpen: (open: boolean) => void;

  // Edit cronjob dialog
  editCronjobId: string | null;
  setEditCronjobId: (id: string | null) => void;

  // Add dataset task dialog
  addDatasetTaskDialogOpen: boolean;
  setAddDatasetTaskDialogOpen: (open: boolean) => void;

  // Edit dataset task dialog
  editDatasetTaskId: string | null;
  setEditDatasetTaskId: (id: string | null) => void;

  // Add WhatsApp group dialog
  addWhatsAppGroupDialogOpen: boolean;
  setAddWhatsAppGroupDialogOpen: (open: boolean) => void;

  // Link project to WhatsApp dialog
  linkProjectToWhatsAppDialogOpen: boolean;
  setLinkProjectToWhatsAppDialogOpen: (open: boolean) => void;
  linkProjectToWhatsAppProjectId: string | null;
  setLinkProjectToWhatsAppProjectId: (id: string | null) => void;

  // Active conversation per project (survives route navigation)
  activeConvByProject: Record<string, string | null>;
  setActiveConvForProject: (project_id: string, convId: string | null) => void;

  // Synchronous ownership latch for a deliberately opened blank composer.
  // Kept outside React component state so a background chat_started event
  // cannot auto-select its conversation in the same turn as the New click.
  composingNewConversationByProject: Record<string, boolean>;
  setComposingNewConversationForProject: (
    project_id: string,
    composing: boolean,
  ) => void;

  // Pinned conversations section expansion per project.
  pinnedConversationsExpandedByProject: Record<string, boolean>;
  setPinnedConversationsExpandedForProject: (
    project_id: string,
    expanded: boolean,
  ) => void;

  // Last open objective per project (survives route navigation)
  activeObjectiveByProject: Record<string, string | null>;
  setActiveObjectiveForProject: (
    project_id: string,
    objectiveId: string | null,
  ) => void;

  // Tracks the streamKey (= conversation_id) from the most recent chat_started
  // event per project folder. Used to display streaming output in the All-Messages
  // view before the HTTP response returns with the resolved conversation_id.
  pendingStreamKeyByProject: Record<string, string>;
  setPendingStreamKey: (folder: string, key: string) => void;
  clearPendingStreamKey: (folder: string) => void;

  // Server restart notification
  serverRestarted: boolean;
  setServerRestarted: (v: boolean) => void;

  // Actual realtime transport state. HTTP connectivity can remain healthy
  // while the WebSocket is unauthenticated or reconnecting.
  websocketConnected: boolean;
  setWebsocketConnected: (connected: boolean) => void;

  // Sandboxes currently restarting (instance key → true)
  restartingSandboxes: Record<string, boolean>;
  setRestartingSandbox: (instance: string, value: boolean) => void;

  // Persistent input drafts keyed by arbitrary string (survive navigation)
  draftByKey: Record<string, string>;
  saveDraftByKey: (key: string, value: string) => void;
  clearDraftByKey: (key: string) => void;
  draftDeepLinksByKey: Record<string, ChatDeepLink[]>;
  setDraftDeepLinksByKey: (key: string, links: ChatDeepLink[]) => void;
  clearDraftDeepLinksByKey: (key: string) => void;

  // Persistent chat mode selection keyed by composer context
  // (e.g. `${folderKey}:${conversationId|__new__}`).
  chatModeByComposerKey: Record<string, ChatModeOverride | null>;
  setChatModeForComposer: (key: string, mode: ChatModeOverride | null) => void;
  memoryLevelByComposerKey: Record<string, MemoryContextLevel>;
  setMemoryLevelForComposer: (key: string, level: MemoryContextLevel) => void;
  memoryCapsuleByConv: Record<
    string,
    { level: MemoryContextLevel; capsule: string }
  >;
  setMemoryCapsule: (
    convId: string,
    value: { level: MemoryContextLevel; capsule: string },
  ) => void;
  clearMemoryCapsule: (convId: string) => void;
  memoryPreparingByConv: Record<string, boolean>;
  setMemoryPreparing: (convId: string, preparing: boolean) => void;

  // Dashboard refresh counter per objective_id (incremented by WS event)
  dashboardRefresh: Record<string, number>;
  bumpDashboardRefresh: (objective_id: string) => void;

  // Meeting recording tracking (recording_id → true while active)
  activeRecordings: Record<string, boolean>;
  markRecordingActive: (recording_id: string, active: boolean) => void;

  // Bumped on every project-change notification (and socket reconnect), so
  // access checks can tell which responses predate the change.
  projectsChangeSeq: number;
  bumpProjectsChangeSeq: () => void;

  // Partial transcripts from WS events (recording_id → transcript text)
  meetingPartialTranscripts: Record<string, string>;
  setMeetingPartialTranscript: (
    recording_id: string,
    transcript: string,
  ) => void;

  // Track which conversations have an active agent run (set by chat_started, cleared by chat_completed)
  chatRunningByConv: Record<string, boolean>;
  setChatRunning: (convId: string, running: boolean) => void;

  // Authoritative acknowledgements for user messages absorbed by an active
  // DirectLLM run. This survives the race where the WebSocket acknowledgement
  // arrives before the original HTTP response supplies the canonical row ID.
  steeredChatMessageIds: Record<string, boolean>;
  acknowledgeSteeredChatMessage: (messageId: string) => void;
  /** Voice-message transcripts that arrived after their message was shown
   * (chat_audio_transcript), by message id, as the text block a reload
   * renders. Overlaid on the transcript so no cache rewrite can drop them. */
  lateAudioTranscripts: Record<string, string>;
  setLateAudioTranscript: (messageId: string, block: string) => void;

  // Idle-stall watchdog warnings for active chat runs. Populated by
  // run_stalled_warning; cleared when activity resumes, the run is killed or
  // completed, or an extension succeeds. UI shows a "Keep waiting" button.
  stalledWarningsByConv: Record<
    string,
    { runId: string; graceMs: number; warnedAt: number }
  >;
  // Agents/commands the chat's agent still has running after its reply, set by
  // chat_background_tasks; cleared when the run completes.
  backgroundTasksByConv: Record<string, BackgroundTask[]>;
  setBackgroundTasks: (convId: string, tasks: BackgroundTask[]) => void;
  backgroundTasksByTask: Record<string, BackgroundTask[]>;
  setTaskBackgroundTasks: (taskId: string, tasks: BackgroundTask[]) => void;
  setStalledWarning: (
    convId: string,
    info: { runId: string; graceMs: number; warnedAt: number },
  ) => void;
  clearStalledWarning: (convId: string) => void;

  // Tasks that ended in 'stalled'. Set by run_killed_stalled, cleared by
  // task_started for the same task. Used by the kanban card to show a Stalled
  // badge until the next run.
  stalledTaskIds: Record<string, boolean>;
  markTaskStalled: (task_id: string) => void;
  clearTaskStalled: (task_id: string) => void;

  // Queued prompts per conversation key (persists across navigation)
  queuedPromptsByConv: Record<string, QueuedPrompt[]>;
  enqueuePrompt: (convKey: string, prompt: QueuedPrompt) => void;
  removeQueuedPrompt: (convKey: string, index: number) => void;
  clearQueuedPrompts: (convKey: string) => void;

  // Last active project (for root redirect)
  lastProjectId: string | null;
  setLastProjectId: (id: string | null) => void;
  kbSaveDialogInfo: { content: string; project_id: string } | null;
  setKbSaveDialogInfo: (
    info: { content: string; project_id: string } | null,
  ) => void;
  messageActionsInfo: {
    id: string;
    content: string;
    project_id: string;
    anchorY: number;
    hasFork: boolean;
    onFork?: () => void;
  } | null;
  setMessageActionsInfo: (
    info: {
      id: string;
      content: string;
      project_id: string;
      anchorY: number;
      hasFork: boolean;
      onFork?: () => void;
    } | null,
  ) => void;

  // Mobile sidebar toggle state
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  // Admin page shown as an overlay over the current route. Intentionally not
  // persisted: a reload should return to the conversation or project URL.
  adminOverlay: AdminOverlayId | null;
  openAdminOverlay: (id: AdminOverlayId) => void;
  closeAdminOverlay: () => void;

  // Desktop sidebar visibility is a device-level layout preference. It is
  // deliberately separate from the mobile drawer's open state.
  desktopSidebarCollapsed: boolean;
  setDesktopSidebarCollapsed: (collapsed: boolean) => void;
  /** Collapse state of the sidebar's "Now" and "Projects" sections. */
  sidebarNowExpanded: boolean;
  setSidebarNowExpanded: (expanded: boolean) => void;
  /** Below md the "Now" section starts collapsed (its header still shows the count). */
  sidebarNowExpandedMobile: boolean;
  setSidebarNowExpandedMobile: (expanded: boolean) => void;
  sidebarProjectsExpanded: boolean;
  setSidebarProjectsExpanded: (expanded: boolean) => void;
  sidebarSandboxesExpanded: boolean;
  setSidebarSandboxesExpanded: (expanded: boolean) => void;
  toggleDesktopSidebarCollapsed: () => void;

  // Shared content from other apps
  sharedContent: { title?: string; text?: string; url?: string } | null;
  setSharedContent: (
    content: { title?: string; text?: string; url?: string } | null,
  ) => void;

  // Chat conversation sidebar toggle state
  chatSidebarOpen: boolean;
  setChatSidebarOpen: (open: boolean) => void;

  // Desktop conversation-list visibility is independent from the mobile
  // conversation drawer and applies to both regular and objective chat.
  desktopChatSidebarCollapsed: boolean;
  setDesktopChatSidebarCollapsed: (collapsed: boolean) => void;
  toggleDesktopChatSidebarCollapsed: () => void;

  // Network connection mode
  connectionMode: 'home' | 'remote';
  setConnectionMode: (mode: 'home' | 'remote') => void;

  // Wipe all user-bound UI state on logout. Keeps device-level preferences
  // (connectionMode) so the next account doesn't have to re-pick. Used by
  // src/lib/auth.ts on logout to prevent the next signed-in user from
  // briefly seeing the previous account's chats / drafts / queued prompts.
  resetForLogout: () => void;

  // Preview tabs open in the right pane, keyed by project. When a project's
  // tab list is empty, the right pane falls back to ConversationExplorer
  // (Changes/Files). Tab state is session-scoped and intentionally
  // not persisted.
  previewTabsByProject: Record<string, PreviewTabsState>;
  /**
   * Explicit file activations that happened while the workspace pane was
   * unmounted. The pane consumes this marker to preserve the normal
   * open-file -> Preview transition across route remounts.
   */
  pendingPreviewActivationByProject: Record<string, boolean>;
  workspaceViewByProject: Record<string, ConversationTabValue>;
  setWorkspaceViewForProject: (
    project_id: string,
    view: ConversationTabValue,
  ) => void;
  consumePendingPreviewActivation: (project_id: string) => boolean;
  /**
   * `openPreviewTab`, `closePreviewTab` and `setActivePreviewTab` first ask the
   * active tab's leave guard. They return whether the change was allowed, as a
   * promise only when that guard is asynchronous.
   */
  openPreviewTab: (project_id: string, tab: PreviewTab) => LeaveDecision;
  updatePreviewTab: (
    project_id: string,
    tab_id: string,
    patch: Partial<PreviewTab>,
  ) => void;
  promotePreviewTabOpenFileContext: (
    project_id: string,
    fromConversationId: string | null,
    conversationId: string,
  ) => void;
  closePreviewTab: (
    project_id: string,
    tab_id: string,
    leaveGuardAlreadyChecked?: boolean,
  ) => LeaveDecision;
  /**
   * Points the open group-file tabs for `from` (and everything below it) at
   * `to` after a rename or move, retitling the tab of the renamed item itself.
   */
  relocateGroupPreviewTabs: (
    project_id: string,
    from: string,
    to: string,
  ) => void;
  setActivePreviewTab: (
    project_id: string,
    tab_id: string | null,
  ) => LeaveDecision;
}

export const useStore = create<UIState>()(
  persist(
    (set, get) => ({
      liveModeEnabled: false,
      liveModeFocusedConversationId: null,
      liveModeCurrentProjectId: null,
      liveModeRegistry: [],
      liveModeListening: false,
      liveModeSpeaking: false,
      liveModeSessionId: liveModeSessionId(),
      liveModeEnabledByConversation: {},
      liveModeSessionByConversation: {},
      liveModeKindByConversation: {},
      liveModeMicrophoneEnabledByConversation: {},
      liveModeLanguageByConversation: {},
      liveModeRoutingResult: null,
      setLiveModeEnabled: (enabled) => set({ liveModeEnabled: enabled }),
      setConversationLiveModeEnabled: (conversationId, enabled) =>
        set((state) => ({
          liveModeEnabledByConversation: {
            ...state.liveModeEnabledByConversation,
            [conversationId]: enabled,
          },
        })),
      setConversationLiveModeSession: (conversationId, sessionId) =>
        set((state) => ({
          liveModeSessionByConversation: {
            ...state.liveModeSessionByConversation,
            [conversationId]: sessionId,
          },
        })),
      setConversationLiveModeKind: (conversationId, kind) =>
        set((state) => ({
          liveModeKindByConversation: {
            ...state.liveModeKindByConversation,
            [conversationId]: kind,
          },
        })),
      setLiveModeFocus: (conversationId, projectId = null) =>
        set({
          liveModeFocusedConversationId: conversationId,
          liveModeCurrentProjectId: projectId,
        }),
      setLiveModeRegistry: (registry) => set({ liveModeRegistry: registry }),
      mergeLiveModeActivity: (activity) =>
        set((s) => ({
          liveModeRegistry: s.liveModeRegistry.some(
            (item) => item.conversationId === activity.conversationId,
          )
            ? s.liveModeRegistry.map((item) =>
                item.conversationId === activity.conversationId
                  ? { ...item, ...activity }
                  : item,
              )
            : [
                ...s.liveModeRegistry,
                {
                  conversationId: activity.conversationId,
                  projectId: activity.projectId || '',
                  projectName:
                    activity.projectName || activity.projectId || 'Project',
                  title:
                    activity.title ||
                    `Conversation ${activity.conversationId.slice(0, 8)}`,
                  preview: activity.preview || '',
                  state: activity.state || 'idle',
                  status: activity.status || null,
                  updatedAt: activity.updatedAt || new Date().toISOString(),
                },
              ],
        })),
      setLiveModeAudioState: (listening, speaking) =>
        set({ liveModeListening: listening, liveModeSpeaking: speaking }),
      setLiveModeMicrophoneEnabled: (conversationKey, enabled) =>
        set((state) => ({
          liveModeMicrophoneEnabledByConversation: {
            ...state.liveModeMicrophoneEnabledByConversation,
            [conversationKey]: enabled,
          },
        })),
      setLiveModeLanguage: (conversationKey, language) =>
        set((state) => {
          const { [conversationKey]: _, ...rest } =
            state.liveModeLanguageByConversation;
          return {
            liveModeLanguageByConversation: language
              ? { ...rest, [conversationKey]: language }
              : rest,
          };
        }),
      setLiveModeRoutingResult: (result) =>
        set({ liveModeRoutingResult: result }),
      streamingOutput: {},
      streamingOutputStartOffsets: {},
      streamingOutputSnapshots: {},
      streamingOutputEntries: {},
      appendOutput: (task_id, chunk, entryId, entryComplete = true) =>
        set((s) => {
          const currentEntries = s.streamingOutputEntries[task_id] ?? [];
          const currentEnd = currentEntries.at(-1)?.endOffset ?? 0;
          const id = entryId ?? `live:${task_id}`;
          const nextEntries = appendToTaskStreamEntries(
            currentEntries,
            id,
            chunk,
            currentEnd,
            entryComplete,
          );
          const retainedEntries = retainNewestWholeTaskEntries(nextEntries);
          const content = retainedEntries
            .map((entry) => entry.content)
            .join('');
          const startOffset = retainedEntries[0]?.startOffset ?? currentEnd;
          return {
            streamingOutput: { ...s.streamingOutput, [task_id]: content },
            streamingOutputStartOffsets: {
              ...s.streamingOutputStartOffsets,
              [task_id]: startOffset,
            },
            streamingOutputSnapshots: {
              ...s.streamingOutputSnapshots,
              [task_id]: { content, startOffset, entries: retainedEntries },
            },
            streamingOutputEntries: {
              ...s.streamingOutputEntries,
              [task_id]: retainedEntries,
            },
          };
        }),
      setTaskOutput: (
        task_id,
        content,
        startOffset = 0,
        entryId,
        suppliedEntries,
        entryComplete = true,
      ) =>
        set((s) => {
          if (suppliedEntries?.length) {
            const retainedEntries = retainNewestWholeTaskEntries(
              suppliedEntries.map((entry) => ({
                ...entry,
                complete: entry.complete ?? true,
              })),
            );
            const retainedContent = retainedEntries
              .map((entry) => entry.content)
              .join('');
            const retainedOffset =
              retainedEntries[0]?.startOffset ?? startOffset;
            return {
              streamingOutput: {
                ...s.streamingOutput,
                [task_id]: retainedContent,
              },
              streamingOutputStartOffsets: {
                ...s.streamingOutputStartOffsets,
                [task_id]: retainedOffset,
              },
              streamingOutputSnapshots: {
                ...s.streamingOutputSnapshots,
                [task_id]: {
                  content: retainedContent,
                  startOffset: retainedOffset,
                  entries: retainedEntries,
                },
              },
              streamingOutputEntries: {
                ...s.streamingOutputEntries,
                [task_id]: retainedEntries,
              },
            };
          }
          const existing = s.streamingOutput[task_id] ?? '';
          const existingStart = s.streamingOutputStartOffsets[task_id] ?? 0;
          const existingEnd =
            existingStart + utf8Encoder.encode(existing).byteLength;
          const incomingEnd =
            startOffset + utf8Encoder.encode(content).byteLength;
          let merged = content;
          let mergedStart = startOffset;
          if (startOffset <= existingEnd && incomingEnd > existingStart) {
            if (startOffset >= existingStart) {
              const overlap = Math.max(0, existingEnd - startOffset);
              merged = existing + sliceUtf8From(content, overlap);
              mergedStart = existingStart;
            } else if (incomingEnd >= existingEnd) {
              merged = content;
            } else {
              return s;
            }
          }
          const id = entryId ?? `live:${task_id}`;
          const existingEntries = s.streamingOutputEntries[task_id] ?? [];
          let mergedEntries: TaskStreamEntry[];
          if (existingEntries.length > 0 && startOffset === existingEnd) {
            mergedEntries = appendToTaskStreamEntries(
              existingEntries,
              id,
              content,
              startOffset,
              entryComplete,
            );
          } else {
            mergedEntries = [
              {
                id,
                content: merged,
                startOffset: mergedStart,
                endOffset: mergedStart + utf8Encoder.encode(merged).byteLength,
                complete: entryComplete,
              },
            ];
          }
          const retainedEntries = retainNewestWholeTaskEntries(mergedEntries);
          const retainedContent = retainedEntries
            .map((entry) => entry.content)
            .join('');
          const retainedOffset = retainedEntries[0]?.startOffset ?? mergedStart;
          return {
            streamingOutput: {
              ...s.streamingOutput,
              [task_id]: retainedContent,
            },
            streamingOutputStartOffsets: {
              ...s.streamingOutputStartOffsets,
              [task_id]: retainedOffset,
            },
            streamingOutputSnapshots: {
              ...s.streamingOutputSnapshots,
              [task_id]: {
                content: retainedContent,
                startOffset: retainedOffset,
                entries: retainedEntries,
              },
            },
            streamingOutputEntries: {
              ...s.streamingOutputEntries,
              [task_id]: retainedEntries,
            },
          };
        }),
      clearOutput: (task_id) =>
        set((s) => {
          const { [task_id]: _, ...rest } = s.streamingOutput;
          const { [task_id]: __, ...offsets } = s.streamingOutputStartOffsets;
          const { [task_id]: ___, ...snapshots } = s.streamingOutputSnapshots;
          const { [task_id]: _entries, ...streamingOutputEntries } =
            s.streamingOutputEntries;
          return {
            streamingOutput: rest,
            streamingOutputStartOffsets: offsets,
            streamingOutputSnapshots: snapshots,
            streamingOutputEntries,
          };
        }),
      clearAllTaskStreaming: () =>
        set({
          streamingOutput: {},
          streamingOutputStartOffsets: {},
          streamingOutputSnapshots: {},
          streamingOutputEntries: {},
        }),

      taskStreamRunIds: {},
      finishedTaskStreamRunIds: {},
      readyTaskTranscriptRunIds: {},
      claimTaskStream: (task_id, run_id) =>
        set((s) => {
          const { [task_id]: _output, ...streamingOutput } = s.streamingOutput;
          const { [task_id]: _finished, ...finishedTaskStreamRunIds } =
            s.finishedTaskStreamRunIds;
          const { [task_id]: _ready, ...readyTaskTranscriptRunIds } =
            s.readyTaskTranscriptRunIds;
          const { [task_id]: _snapshot, ...streamingOutputSnapshots } =
            s.streamingOutputSnapshots;
          const { [task_id]: _entries, ...streamingOutputEntries } =
            s.streamingOutputEntries;
          return {
            streamingOutput,
            streamingOutputStartOffsets: {
              ...s.streamingOutputStartOffsets,
              [task_id]: 0,
            },
            streamingOutputSnapshots,
            streamingOutputEntries,
            taskStreamRunIds: { ...s.taskStreamRunIds, [task_id]: run_id },
            finishedTaskStreamRunIds,
            readyTaskTranscriptRunIds,
          };
        }),
      finishTaskStream: (task_id, run_id) =>
        set((s) =>
          s.taskStreamRunIds[task_id] === run_id
            ? {
                finishedTaskStreamRunIds: {
                  ...s.finishedTaskStreamRunIds,
                  [task_id]: run_id,
                },
              }
            : s,
        ),
      markTaskTranscriptReady: (task_id, run_id) =>
        set((s) =>
          s.taskStreamRunIds[task_id] === run_id &&
          s.finishedTaskStreamRunIds[task_id] === run_id
            ? {
                readyTaskTranscriptRunIds: {
                  ...s.readyTaskTranscriptRunIds,
                  [task_id]: run_id,
                },
              }
            : s,
        ),

      liveTaskIds: {},
      markTaskLive: (task_id) =>
        set((s) => ({ liveTaskIds: { ...s.liveTaskIds, [task_id]: true } })),
      unmarkTaskLive: (task_id) =>
        set((s) => {
          const { [task_id]: _, ...rest } = s.liveTaskIds;
          return { liveTaskIds: rest };
        }),

      chatStreamingOutput: {},
      appendChatOutput: (key, chunk) =>
        set((s) => ({
          chatStreamingOutput: {
            ...s.chatStreamingOutput,
            [key]: (s.chatStreamingOutput[key] || '') + chunk,
          },
        })),
      setChatOutput: (key, content) =>
        set((s) => ({
          chatStreamingOutput: { ...s.chatStreamingOutput, [key]: content },
        })),
      clearChatOutput: (key) =>
        set((s) => {
          const { [key]: _, ...rest } = s.chatStreamingOutput;
          const { [key]: __, ...completedRest } = s.chatStreamingCompleted;
          const { [key]: ___, ...presentationRest } = s.chatStreamPresentation;
          const { [key]: ____, ...attachmentRest } = s.chatStreamingAttachments;
          return {
            chatStreamingOutput: rest,
            chatStreamingCompleted: completedRest,
            chatStreamPresentation: presentationRest,
            chatStreamingAttachments: attachmentRest,
          };
        }),
      chatStreamingAttachments: {},
      setChatStreamingAttachments: (key, attachments) =>
        set((s) => ({
          chatStreamingAttachments: {
            ...s.chatStreamingAttachments,
            [key]: attachments,
          },
        })),

      chatStreamingCompleted: {},
      markChatOutputCompleted: (key) =>
        set((s) => ({
          chatStreamingCompleted: { ...s.chatStreamingCompleted, [key]: true },
        })),

      chatStreamingTelemetry: {},
      setChatStreamingTelemetry: (key, telemetry) =>
        set((s) => ({
          chatStreamingTelemetry: {
            ...s.chatStreamingTelemetry,
            [key]: telemetry,
          },
        })),

      chatStreamPresentation: {},
      setChatStreamPresentation: (key, presentation) =>
        set((s) => ({
          chatStreamPresentation: {
            ...s.chatStreamPresentation,
            [key]: presentation,
          },
        })),

      activeStreamKeyByConv: {},
      chatStreamRetiredByConv: {},
      setActiveStreamKeyForConv: (convId, key) =>
        set((s) => {
          const { [convId]: _retired, ...chatStreamRetiredByConv } =
            s.chatStreamRetiredByConv;
          return {
            // A run UUID has exactly one conversation owner. Remove stale
            // aliases defensively so a navigation race or replayed event cannot
            // render one live response in two conversation views.
            activeStreamKeyByConv: {
              ...Object.fromEntries(
                Object.entries(s.activeStreamKeyByConv).filter(
                  ([ownerId, ownerKey]) =>
                    ownerId === convId || ownerKey !== key,
                ),
              ),
              [convId]: key,
            },
            prevStreamKeyByConv: Object.fromEntries(
              Object.entries(s.prevStreamKeyByConv).filter(
                ([ownerId, ownerKey]) => ownerId === convId || ownerKey !== key,
              ),
            ),
            chatStreamRetiredByConv,
          };
        }),

      prevStreamKeyByConv: {},
      setPrevStreamKeyForConv: (convId, key) =>
        set((s) => ({
          activeStreamKeyByConv: Object.fromEntries(
            Object.entries(s.activeStreamKeyByConv).filter(
              ([ownerId, ownerKey]) => ownerId === convId || ownerKey !== key,
            ),
          ),
          prevStreamKeyByConv: {
            ...Object.fromEntries(
              Object.entries(s.prevStreamKeyByConv).filter(
                ([ownerId, ownerKey]) => ownerId === convId || ownerKey !== key,
              ),
            ),
            [convId]: key,
          },
        })),
      clearPrevStreamKeyForConv: (convId) =>
        set((s) => {
          const { [convId]: _, ...rest } = s.prevStreamKeyByConv;
          return { prevStreamKeyByConv: rest };
        }),
      retireChatStreamForConv: (convId) =>
        set((s) => {
          const { [convId]: _active, ...activeStreamKeyByConv } =
            s.activeStreamKeyByConv;
          const { [convId]: _previous, ...prevStreamKeyByConv } =
            s.prevStreamKeyByConv;
          const { [convId]: _running, ...chatRunningByConv } =
            s.chatRunningByConv;
          const { [convId]: _warning, ...stalledWarningsByConv } =
            s.stalledWarningsByConv;
          const { [convId]: _background, ...backgroundTasksByConv } =
            s.backgroundTasksByConv;
          return {
            backgroundTasksByConv,
            activeStreamKeyByConv,
            prevStreamKeyByConv,
            chatRunningByConv,
            stalledWarningsByConv,
            chatStreamRetiredByConv: {
              ...s.chatStreamRetiredByConv,
              [convId]: true,
            },
          };
        }),
      clearRetiredChatStreamForConv: (convId) =>
        set((s) => {
          if (!s.chatStreamRetiredByConv[convId]) return s;
          const { [convId]: _retired, ...chatStreamRetiredByConv } =
            s.chatStreamRetiredByConv;
          return { chatStreamRetiredByConv };
        }),
      clearAllChatStreaming: () =>
        set({
          chatStreamingOutput: {},
          chatStreamingCompleted: {},
          chatStreamingTelemetry: {},
          chatStreamingAttachments: {},
          chatStreamPresentation: {},
          activeStreamKeyByConv: {},
          chatStreamRetiredByConv: {},
          prevStreamKeyByConv: {},
          pendingStreamKeyByProject: {},
          chatRunningByConv: {},
          memoryPreparingByConv: {},
        }),

      detailTaskId: null,
      detailTaskTab: null,
      // Ordinary dialog navigation must invalidate any pending one-shot review
      // jump. The score control uses openTaskWithReviewIntent below so the task
      // selection and targeted intent remain atomic.
      setDetailTaskId: (id) =>
        set({ detailTaskId: id, detailTaskTab: null, reviewRunIntent: null }),
      setDetailTaskTab: (tab) => set({ detailTaskTab: tab }),
      openTaskDetail: (taskId, tab) =>
        set({
          detailTaskId: taskId,
          detailTaskTab: tab,
          reviewRunIntent: null,
        }),
      reviewRunIntent: null,
      setReviewRunIntent: (intent) => set({ reviewRunIntent: intent }),
      openTaskWithReviewIntent: (taskId) =>
        set({
          detailTaskId: taskId,
          detailTaskTab: null,
          reviewRunIntent: { taskId },
        }),

      addDialogOpen: false,
      setAddDialogOpen: (open) => set({ addDialogOpen: open }),

      addProjectDialogOpen: false,
      setAddProjectDialogOpen: (open) => set({ addProjectDialogOpen: open }),

      settingsProjectId: null,
      setSettingsProjectId: (id) => set({ settingsProjectId: id }),
      shareProjectId: null,
      setShareProjectId: (id) => set({ shareProjectId: id }),

      addCronjobDialogOpen: false,
      setAddCronjobDialogOpen: (open) => set({ addCronjobDialogOpen: open }),

      editCronjobId: null,
      setEditCronjobId: (id) => set({ editCronjobId: id }),

      addDatasetTaskDialogOpen: false,
      setAddDatasetTaskDialogOpen: (open) =>
        set({ addDatasetTaskDialogOpen: open }),

      editDatasetTaskId: null,
      setEditDatasetTaskId: (id) => set({ editDatasetTaskId: id }),

      addWhatsAppGroupDialogOpen: false,
      setAddWhatsAppGroupDialogOpen: (open) =>
        set({ addWhatsAppGroupDialogOpen: open }),

      linkProjectToWhatsAppDialogOpen: false,
      setLinkProjectToWhatsAppDialogOpen: (open) =>
        set({ linkProjectToWhatsAppDialogOpen: open }),
      linkProjectToWhatsAppProjectId: null,
      setLinkProjectToWhatsAppProjectId: (id) =>
        set({ linkProjectToWhatsAppProjectId: id }),

      pinnedConversationsExpandedByProject: {},
      setPinnedConversationsExpandedForProject: (project_id, expanded) =>
        set((s) => ({
          pinnedConversationsExpandedByProject: {
            ...s.pinnedConversationsExpandedByProject,
            [project_id]: expanded,
          },
        })),

      activeConvByProject: {},
      setActiveConvForProject: (project_id, convId) =>
        set((s) => ({
          activeConvByProject: {
            ...s.activeConvByProject,
            [project_id]: convId,
          },
        })),

      composingNewConversationByProject: {},
      setComposingNewConversationForProject: (project_id, composing) =>
        set((s) => {
          if (composing) {
            return {
              composingNewConversationByProject: {
                ...s.composingNewConversationByProject,
                [project_id]: true,
              },
            };
          }
          const { [project_id]: _, ...rest } =
            s.composingNewConversationByProject;
          return { composingNewConversationByProject: rest };
        }),

      activeObjectiveByProject: {},
      setActiveObjectiveForProject: (project_id, objectiveId) =>
        set((s) => ({
          activeObjectiveByProject: {
            ...s.activeObjectiveByProject,
            [project_id]: objectiveId,
          },
        })),

      pendingStreamKeyByProject: {},
      setPendingStreamKey: (folder, key) =>
        set((s) => ({
          pendingStreamKeyByProject: {
            ...s.pendingStreamKeyByProject,
            [folder]: key,
          },
        })),
      clearPendingStreamKey: (folder) =>
        set((s) => {
          const { [folder]: _, ...rest } = s.pendingStreamKeyByProject;
          return { pendingStreamKeyByProject: rest };
        }),

      previewTabsByProject: {},
      pendingPreviewActivationByProject: {},
      workspaceViewByProject: {},
      setWorkspaceViewForProject: (project_id, view) =>
        set((s) => ({
          workspaceViewByProject: {
            ...s.workspaceViewByProject,
            [project_id]: view,
          },
        })),
      consumePendingPreviewActivation: (project_id) => {
        let wasPending = false;
        set((s) => {
          wasPending = s.pendingPreviewActivationByProject[project_id] === true;
          if (!wasPending) return s;
          const { [project_id]: _, ...rest } =
            s.pendingPreviewActivationByProject;
          return { pendingPreviewActivationByProject: rest };
        });
        return wasPending;
      },
      openPreviewTab: (project_id, tab) => {
        const activeTabId =
          get().previewTabsByProject[project_id]?.activeTabId ?? null;
        return applyIfLeaveAllowed(
          activeTabId !== tab.id
            ? checkPreviewTabLeave(project_id, activeTabId)
            : true,
          () =>
            set((s) => {
              const existing = s.previewTabsByProject[project_id];
              const tabs = existing?.tabs ?? [];
              const pendingPreviewActivationByProject = {
                ...s.pendingPreviewActivationByProject,
                [project_id]: true,
              };
              // De-dupe by id — opening an already-open tab just activates it.
              if (tabs.some((t) => t.id === tab.id)) {
                return {
                  pendingPreviewActivationByProject,
                  previewTabsByProject: {
                    ...s.previewTabsByProject,
                    [project_id]: {
                      tabs: tabs.map((existingTab) =>
                        existingTab.id === tab.id
                          ? { ...existingTab, ...tab }
                          : existingTab,
                      ),
                      activeTabId: tab.id,
                      activationSequence:
                        (existing?.activationSequence ?? 0) + 1,
                    },
                  },
                };
              }
              return {
                pendingPreviewActivationByProject,
                previewTabsByProject: {
                  ...s.previewTabsByProject,
                  [project_id]: {
                    tabs: [...tabs, tab],
                    activeTabId: tab.id,
                    activationSequence: (existing?.activationSequence ?? 0) + 1,
                  },
                },
              };
            }),
        );
      },
      updatePreviewTab: (project_id, tab_id, patch) =>
        set((s) => {
          const existing = s.previewTabsByProject[project_id];
          if (!existing?.tabs.some((tab) => tab.id === tab_id)) return s;
          return {
            previewTabsByProject: {
              ...s.previewTabsByProject,
              [project_id]: {
                ...existing,
                tabs: existing.tabs.map((tab) =>
                  tab.id === tab_id ? { ...tab, ...patch } : tab,
                ),
              },
            },
          };
        }),
      promotePreviewTabOpenFileContext: (
        project_id,
        fromConversationId,
        conversationId,
      ) =>
        set((s) => {
          const existing = s.previewTabsByProject[project_id];
          if (!existing) return s;
          let changed = false;
          const tabs = existing.tabs.map((tab) => {
            if (tab.openFileContextConversationId !== fromConversationId)
              return tab;
            changed = true;
            return {
              ...tab,
              openFileContextConversationId: conversationId,
            };
          });
          if (!changed) return s;
          return {
            previewTabsByProject: {
              ...s.previewTabsByProject,
              [project_id]: { ...existing, tabs },
            },
          };
        }),
      closePreviewTab: (
        project_id,
        tab_id,
        leaveGuardAlreadyChecked = false,
      ) => {
        if (!get().previewTabsByProject[project_id]) return true;
        return applyIfLeaveAllowed(
          leaveGuardAlreadyChecked
            ? true
            : checkPreviewTabLeave(project_id, tab_id),
          () =>
            set((s) => {
              const existing = s.previewTabsByProject[project_id];
              if (!existing) return s;
              const tabs = existing.tabs.filter((t) => t.id !== tab_id);
              // Closing the last tab collapses the right pane back to
              // ConversationExplorer — drop the project key entirely.
              if (tabs.length === 0) {
                const { [project_id]: _, ...rest } = s.previewTabsByProject;
                return { previewTabsByProject: rest };
              }
              let activeTabId = existing.activeTabId;
              if (activeTabId === tab_id) {
                // Prefer the previous sibling, else the new first tab.
                const closedIndex = existing.tabs.findIndex(
                  (t) => t.id === tab_id,
                );
                activeTabId =
                  existing.tabs[closedIndex - 1]?.id ?? tabs[0]?.id ?? null;
              }
              return {
                previewTabsByProject: {
                  ...s.previewTabsByProject,
                  [project_id]: {
                    tabs,
                    activeTabId,
                    activationSequence: existing.activationSequence,
                  },
                },
              };
            }),
        );
      },
      relocateGroupPreviewTabs: (project_id, from, to) =>
        set((s) => {
          const existing = s.previewTabsByProject[project_id];
          if (!existing) return s;
          let activeTabId = existing.activeTabId;
          const tabs = existing.tabs.map((tab) => {
            if (tab.source !== 'group' || !tab.path) return tab;
            if (tab.path !== from && !tab.path.startsWith(`${from}/`))
              return tab;
            const path = to + tab.path.slice(from.length);
            const id =
              tab.id === `group:${tab.path}` ? `group:${path}` : tab.id;
            if (activeTabId === tab.id) activeTabId = id;
            const title =
              tab.path === from
                ? (path.split('/').pop() ?? tab.title)
                : tab.title;
            return { ...tab, id, path, title };
          });
          return {
            previewTabsByProject: {
              ...s.previewTabsByProject,
              [project_id]: { ...existing, tabs, activeTabId },
            },
          };
        }),
      setActivePreviewTab: (project_id, tab_id) => {
        const existing = get().previewTabsByProject[project_id];
        if (!existing) return false;
        if (tab_id !== null && !existing.tabs.some((t) => t.id === tab_id))
          return false;
        return applyIfLeaveAllowed(
          existing.activeTabId !== tab_id
            ? checkPreviewTabLeave(project_id, existing.activeTabId)
            : true,
          () =>
            set((s) => {
              const current = s.previewTabsByProject[project_id];
              if (!current) return s;
              return {
                previewTabsByProject: {
                  ...s.previewTabsByProject,
                  [project_id]: { ...current, activeTabId: tab_id },
                },
              };
            }),
        );
      },

      serverRestarted: false,
      setServerRestarted: (v) => set({ serverRestarted: v }),

      websocketConnected: false,
      setWebsocketConnected: (connected) =>
        set({ websocketConnected: connected }),

      restartingSandboxes: {},
      setRestartingSandbox: (instance, value) =>
        set((s) => {
          if (value) {
            return {
              restartingSandboxes: {
                ...s.restartingSandboxes,
                [instance]: true,
              },
            };
          }
          const { [instance]: _, ...rest } = s.restartingSandboxes;
          return { restartingSandboxes: rest };
        }),

      draftByKey: {},
      saveDraftByKey: (key, value) =>
        set((s) => ({ draftByKey: { ...s.draftByKey, [key]: value } })),
      clearDraftByKey: (key) =>
        set((s) => {
          const { [key]: _, ...rest } = s.draftByKey;
          return { draftByKey: rest };
        }),
      draftDeepLinksByKey: {},
      setDraftDeepLinksByKey: (key, links) =>
        set((s) => ({
          draftDeepLinksByKey: { ...s.draftDeepLinksByKey, [key]: links },
        })),
      clearDraftDeepLinksByKey: (key) =>
        set((s) => {
          const { [key]: _, ...rest } = s.draftDeepLinksByKey;
          return { draftDeepLinksByKey: rest };
        }),
      chatModeByComposerKey: {},
      setChatModeForComposer: (key, mode) =>
        set((s) => {
          if (mode === null) {
            const { [key]: _, ...rest } = s.chatModeByComposerKey;
            return { chatModeByComposerKey: rest };
          }
          return {
            chatModeByComposerKey: { ...s.chatModeByComposerKey, [key]: mode },
          };
        }),
      memoryLevelByComposerKey: {},
      setMemoryLevelForComposer: (key, level) =>
        set((s) => ({
          memoryLevelByComposerKey: {
            ...s.memoryLevelByComposerKey,
            [key]: level,
          },
        })),
      memoryCapsuleByConv: {},
      setMemoryCapsule: (convId, value) =>
        set((s) => ({
          memoryCapsuleByConv: {
            ...s.memoryCapsuleByConv,
            [convId]: value,
          },
          memoryPreparingByConv: Object.fromEntries(
            Object.entries(s.memoryPreparingByConv).filter(
              ([id]) => id !== convId,
            ),
          ),
        })),
      clearMemoryCapsule: (convId) =>
        set((s) => {
          const { [convId]: _, ...memoryCapsuleByConv } = s.memoryCapsuleByConv;
          return { memoryCapsuleByConv };
        }),
      memoryPreparingByConv: {},
      setMemoryPreparing: (convId, preparing) =>
        set((s) => {
          if (preparing) {
            return {
              memoryPreparingByConv: {
                ...s.memoryPreparingByConv,
                [convId]: true,
              },
            };
          }
          const { [convId]: _, ...memoryPreparingByConv } =
            s.memoryPreparingByConv;
          return { memoryPreparingByConv };
        }),

      dashboardRefresh: {},
      bumpDashboardRefresh: (objective_id) =>
        set((s) => ({
          dashboardRefresh: {
            ...s.dashboardRefresh,
            [objective_id]: (s.dashboardRefresh[objective_id] || 0) + 1,
          },
        })),

      activeRecordings: {},
      markRecordingActive: (recording_id, active) =>
        set((s) => {
          if (active) {
            return {
              activeRecordings: { ...s.activeRecordings, [recording_id]: true },
            };
          }
          const { [recording_id]: _, ...rest } = s.activeRecordings;
          return { activeRecordings: rest };
        }),

      projectsChangeSeq: 0,
      bumpProjectsChangeSeq: () =>
        set((s) => ({ projectsChangeSeq: s.projectsChangeSeq + 1 })),

      meetingPartialTranscripts: {},
      setMeetingPartialTranscript: (recording_id, transcript) =>
        set((s) => ({
          meetingPartialTranscripts: {
            ...s.meetingPartialTranscripts,
            [recording_id]: transcript,
          },
        })),

      chatRunningByConv: {},
      setChatRunning: (convId, running) =>
        set((s) => {
          if (running) {
            return {
              chatRunningByConv: { ...s.chatRunningByConv, [convId]: true },
            };
          }
          const { [convId]: _, ...rest } = s.chatRunningByConv;
          return { chatRunningByConv: rest };
        }),

      lateAudioTranscripts: {},
      setLateAudioTranscript: (messageId, block) =>
        set((s) =>
          s.lateAudioTranscripts[messageId] === block
            ? s
            : {
                lateAudioTranscripts: {
                  ...Object.fromEntries(
                    Object.entries(s.lateAudioTranscripts).slice(-199),
                  ),
                  [messageId]: block,
                },
              },
        ),
      steeredChatMessageIds: {},
      acknowledgeSteeredChatMessage: (messageId) =>
        set((s) => {
          if (s.steeredChatMessageIds[messageId]) return s;
          const entries = Object.entries(s.steeredChatMessageIds);
          const retained =
            entries.length >= 1_000
              ? entries.slice(entries.length - 999)
              : entries;
          return {
            steeredChatMessageIds: {
              ...Object.fromEntries(retained),
              [messageId]: true,
            },
          };
        }),

      backgroundTasksByConv: {},
      setBackgroundTasks: (convId, tasks) =>
        set((s) => {
          if (!tasks.length) {
            if (!s.backgroundTasksByConv[convId]) return s;
            const { [convId]: _, ...rest } = s.backgroundTasksByConv;
            return { backgroundTasksByConv: rest };
          }
          return {
            backgroundTasksByConv: {
              ...s.backgroundTasksByConv,
              [convId]: tasks,
            },
          };
        }),

      backgroundTasksByTask: {},
      setTaskBackgroundTasks: (taskId, tasks) =>
        set((s) => {
          if (!tasks.length) {
            if (!s.backgroundTasksByTask[taskId]) return s;
            const { [taskId]: _, ...rest } = s.backgroundTasksByTask;
            return { backgroundTasksByTask: rest };
          }
          return {
            backgroundTasksByTask: {
              ...s.backgroundTasksByTask,
              [taskId]: tasks,
            },
          };
        }),

      stalledWarningsByConv: {},
      setStalledWarning: (convId, info) =>
        set((s) => ({
          stalledWarningsByConv: { ...s.stalledWarningsByConv, [convId]: info },
        })),
      clearStalledWarning: (convId) =>
        set((s) => {
          if (!s.stalledWarningsByConv[convId]) return s;
          const { [convId]: _, ...rest } = s.stalledWarningsByConv;
          return { stalledWarningsByConv: rest };
        }),

      stalledTaskIds: {},
      markTaskStalled: (task_id) =>
        set((s) => ({
          stalledTaskIds: { ...s.stalledTaskIds, [task_id]: true },
        })),
      clearTaskStalled: (task_id) =>
        set((s) => {
          if (!s.stalledTaskIds[task_id]) return s;
          const { [task_id]: _, ...rest } = s.stalledTaskIds;
          return { stalledTaskIds: rest };
        }),

      queuedPromptsByConv: {},
      enqueuePrompt: (convKey, prompt) =>
        set((s) => ({
          queuedPromptsByConv: {
            ...s.queuedPromptsByConv,
            [convKey]: [...(s.queuedPromptsByConv[convKey] ?? []), prompt],
          },
        })),
      removeQueuedPrompt: (convKey, index) =>
        set((s) => {
          const prompts = s.queuedPromptsByConv[convKey] ?? [];
          const remaining = prompts.filter(
            (_, promptIndex) => promptIndex !== index,
          );
          if (remaining.length === prompts.length) return s;
          if (remaining.length === 0) {
            const { [convKey]: _, ...rest } = s.queuedPromptsByConv;
            return { queuedPromptsByConv: rest };
          }
          return {
            queuedPromptsByConv: {
              ...s.queuedPromptsByConv,
              [convKey]: remaining,
            },
          };
        }),
      clearQueuedPrompts: (convKey) =>
        set((s) => {
          const { [convKey]: _, ...rest } = s.queuedPromptsByConv;
          return { queuedPromptsByConv: rest };
        }),

      lastProjectId: null,
      setLastProjectId: (id) => set({ lastProjectId: id }),

      sharedContent: null,
      setSharedContent: (content) => set({ sharedContent: content }),

      kbSaveDialogInfo: null,
      setKbSaveDialogInfo: (info) => set({ kbSaveDialogInfo: info }),
      messageActionsInfo: null,
      setMessageActionsInfo: (info) => set({ messageActionsInfo: info }),

      sidebarOpen: false,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      adminOverlay: null,
      openAdminOverlay: (id) => set({ adminOverlay: id }),
      closeAdminOverlay: () => set({ adminOverlay: null }),
      chatSidebarOpen: false,
      setChatSidebarOpen: (open) => set({ chatSidebarOpen: open }),
      desktopChatSidebarCollapsed: false,

      desktopSidebarCollapsed: false,
      setDesktopSidebarCollapsed: (collapsed) =>
        set({ desktopSidebarCollapsed: collapsed }),
      sidebarNowExpanded: true,
      setSidebarNowExpanded: (expanded) =>
        set({ sidebarNowExpanded: expanded }),
      sidebarNowExpandedMobile: false,
      setSidebarNowExpandedMobile: (expanded) =>
        set({ sidebarNowExpandedMobile: expanded }),
      sidebarProjectsExpanded: true,
      setSidebarProjectsExpanded: (expanded) =>
        set({ sidebarProjectsExpanded: expanded }),
      sidebarSandboxesExpanded: true,
      setSidebarSandboxesExpanded: (expanded) =>
        set({ sidebarSandboxesExpanded: expanded }),
      toggleDesktopSidebarCollapsed: () =>
        set((state) => ({
          desktopSidebarCollapsed: !state.desktopSidebarCollapsed,
        })),
      setDesktopChatSidebarCollapsed: (collapsed) =>
        set({ desktopChatSidebarCollapsed: collapsed }),
      toggleDesktopChatSidebarCollapsed: () =>
        set((state) => ({
          desktopChatSidebarCollapsed: !state.desktopChatSidebarCollapsed,
        })),

      connectionMode: 'remote',
      setConnectionMode: (mode) => set({ connectionMode: mode }),

      resetForLogout: () => {
        // Reset every user-bound slice. Leaves connectionMode untouched (it's a
        // device preference, not account state). Any new state added to UIState
        // that ties to a user must be reset here too.
        set({
          streamingOutput: {},
          streamingOutputStartOffsets: {},
          streamingOutputSnapshots: {},
          streamingOutputEntries: {},
          taskStreamRunIds: {},
          finishedTaskStreamRunIds: {},
          readyTaskTranscriptRunIds: {},
          liveModeEnabled: false,
          liveModeFocusedConversationId: null,
          liveModeCurrentProjectId: null,
          liveModeRegistry: [],
          liveModeListening: false,
          liveModeSpeaking: false,
          liveModeSessionId: liveModeSessionId(true),
          liveModeEnabledByConversation: {},
          liveModeSessionByConversation: {},
          liveModeKindByConversation: {},
          liveModeMicrophoneEnabledByConversation: {},
          liveModeLanguageByConversation: {},
          liveModeRoutingResult: null,
          liveTaskIds: {},
          chatStreamingOutput: {},
          chatStreamingCompleted: {},
          chatStreamingTelemetry: {},
          chatStreamingAttachments: {},
          chatStreamPresentation: {},
          activeStreamKeyByConv: {},
          chatStreamRetiredByConv: {},
          prevStreamKeyByConv: {},
          detailTaskId: null,
          detailTaskTab: null,
          reviewRunIntent: null,
          addDialogOpen: false,
          addProjectDialogOpen: false,
          settingsProjectId: null,
          shareProjectId: null,
          addCronjobDialogOpen: false,
          editCronjobId: null,
          addDatasetTaskDialogOpen: false,
          editDatasetTaskId: null,
          addWhatsAppGroupDialogOpen: false,
          linkProjectToWhatsAppDialogOpen: false,
          linkProjectToWhatsAppProjectId: null,
          activeConvByProject: {},
          pinnedConversationsExpandedByProject: {},

          composingNewConversationByProject: {},
          activeObjectiveByProject: {},
          pendingStreamKeyByProject: {},
          serverRestarted: false,
          restartingSandboxes: {},
          draftByKey: {},
          draftDeepLinksByKey: {},
          chatModeByComposerKey: {},
          memoryLevelByComposerKey: {},
          memoryCapsuleByConv: {},
          memoryPreparingByConv: {},
          dashboardRefresh: {},
          activeRecordings: {},
          meetingPartialTranscripts: {},
          chatRunningByConv: {},
          steeredChatMessageIds: {},
          stalledWarningsByConv: {},
          backgroundTasksByConv: {},
          backgroundTasksByTask: {},
          stalledTaskIds: {},
          queuedPromptsByConv: {},
          lastProjectId: null,
          kbSaveDialogInfo: null,
          messageActionsInfo: null,
          sidebarOpen: false,
          adminOverlay: null,
          sharedContent: null,
          chatSidebarOpen: false,
          previewTabsByProject: {},
          pendingPreviewActivationByProject: {},
          workspaceViewByProject: {},
        });
      },
    }),
    {
      name: 'carapa-ui-state',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        lastProjectId: state.lastProjectId,
        activeConvByProject: state.activeConvByProject,
        activeObjectiveByProject: state.activeObjectiveByProject,
        pinnedConversationsExpandedByProject:
          state.pinnedConversationsExpandedByProject,

        draftByKey: state.draftByKey,
        draftDeepLinksByKey: state.draftDeepLinksByKey,
        chatModeByComposerKey: state.chatModeByComposerKey,
        memoryLevelByComposerKey: state.memoryLevelByComposerKey,
        queuedPromptsByConv: Object.fromEntries(
          Object.entries(state.queuedPromptsByConv).map(([key, prompts]) => [
            key,
            prompts.map(({ awaitingAcknowledgement: _, ...prompt }) => prompt),
          ]),
        ),
        connectionMode: state.connectionMode,
        desktopSidebarCollapsed: state.desktopSidebarCollapsed,
        sidebarNowExpanded: state.sidebarNowExpanded,
        sidebarNowExpandedMobile: state.sidebarNowExpandedMobile,
        sidebarProjectsExpanded: state.sidebarProjectsExpanded,
        sidebarSandboxesExpanded: state.sidebarSandboxesExpanded,
        desktopChatSidebarCollapsed: state.desktopChatSidebarCollapsed,
        liveModeMicrophoneEnabledByConversation:
          state.liveModeMicrophoneEnabledByConversation,
        liveModeLanguageByConversation: state.liveModeLanguageByConversation,
      }),
      // Playback ownership is tab-scoped. Persisting this identifier made
      // every open tab accept and play the same Live Mode speech events.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<UIState>),
        // Live Mode is server-authoritative and conversation-scoped. Do not
        // revive a stale global selection when a tab or device reloads.
        liveModeEnabled: false,
        liveModeFocusedConversationId: null,
        liveModeCurrentProjectId: null,
        liveModeEnabledByConversation: {},
        liveModeSessionByConversation: {},
        liveModeKindByConversation: {},
        liveModeSessionId: current.liveModeSessionId,
      }),
    },
  ),
);
