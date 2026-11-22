import type { QueryClient } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/query-keys';
import { patchTaskLists } from '@/hooks/use-task-mutations';
import { useStore, type QueuedPrompt } from '@/store';
import type { BackgroundTask, WsEvent } from '@/types';
import { API_BASE_URL } from './api-config';
import { messageSpeechUrl } from './message-speech-url';
import {
  apiFetch,
  sendChatMessage,
  startPersonaLiveQueueItem,
  type MemoryContextLevel,
  type PersonaLiveQueueSnapshot,
  type SandboxInstance,
} from './api';
import {
  activateNativeSpeechSession,
  attachNativeSpeechPlaybackListener,
  dismissNativeNotification,
  enqueueNativeSpeech,
  stopNativeSpeech,
} from './push-bridge';
import {
  cutOffLiveSpeechForServerStop,
  enqueueLiveReply,
  prefetchLiveReply,
  enqueueLiveSpeech,
  getLiveSpeechState,
  setLiveSpeechFocus,
  subscribeLiveSpeech,
} from './use-tts';
import {
  beginLivePersonaReveal,
  bufferLivePersonaChunk,
  clearLivePersonaReveal,
  getLivePersonaRevealState,
  markLivePersonaPlaybackStarted,
  markLivePersonaSynthesizing,
  markLivePersonaThinking,
  replaceLivePersonaBuffer,
  releaseLivePersonaReveal,
} from './live-persona-reveal';
import { patchPersonaLiveModeStatus } from './live-mode-query';
import { speechForLiveActivity } from './live-speech-protocol';
import { vaultPopulate } from './session-vault';
import {
  canonicalStreamReplacement,
  completedStreamContent,
  reconcileChatStreamChunk,
} from './chat-stream-reconciliation';
import { completionOwnsConversationLifecycle } from './chat-completion-ownership';
import {
  discardQueuedPromptBatch,
  markQueuedPromptBatchAwaitingAcknowledgement,
  isConversationNotFoundError,
  missingConversationPromptNotice,
  reconcileQueuedPromptReceipts,
  removeAcknowledgedQueuedPromptBatch,
  releaseQueuedPromptBatchForDrain,
  replaceQueuedPromptBatchWithServerOwned,
} from './queued-prompt-lifecycle';
import { ANDROID_OTA_AVAILABLE_EVENT } from './android-ota';
import { showBuildLog } from './build-log';
import { invalidateGroupExplorerQueries } from './artifact-cache';
import { applicationWebSocketBaseUrl } from './websocket-url';
import { authenticatedApplicationWebSocketUrl } from './websocket-auth';
import { QueryInvalidationCoalescer } from './query-invalidation-coalescer';
import { transcriptMessageIdMatchesCanonical } from './chat-transcript-ownership';

const utf8Encoder = new TextEncoder();

export { applicationWebSocketBaseUrl } from './websocket-url';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let qcRef: QueryClient | null = null;
let knownServerStartedAt: number | null = null;
let healthPollTimer: ReturnType<typeof setInterval> | null = null;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 30_000;
const lifecycleInvalidations = new QueryInvalidationCoalescer(750);

function invalidateTaskLifecycleQueries(projectId: string): void {
  lifecycleInvalidations.invalidate(`tasks:${projectId}`, () => {
    qcRef?.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) });
  });
}

// The sidebar "Now" list is derived from the same lifecycle events as the
// project status summary, so it shares their coalescing window.
function invalidateAttention(): void {
  lifecycleInvalidations.invalidate('attention', () => {
    qcRef?.invalidateQueries({ queryKey: queryKeys.attention.all });
  });
}

function invalidateProjectStatusSummary(): void {
  lifecycleInvalidations.invalidate('projects:status-summary', () => {
    qcRef?.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
  });
  invalidateAttention();
}

/**
 * task_updated broadcasts carry the authoritative task record. Apply its
 * description in place to the project's cached task lists (plain and
 * filtered) and the dialog's full-task record so already-open views
 * show the change immediately. Entries for other tasks are left untouched.
 */
function reconcileExternalTaskDescription(
  project_id: string,
  task_id: string,
  payload: Record<string, unknown>,
): void {
  const description = payload.description;
  if (typeof description !== 'string') return;
  qcRef?.setQueriesData(
    {
      predicate: (query) =>
        query.queryKey[0] === 'tasks' && query.queryKey[1] === project_id,
    },
    (old: unknown) => {
      if (!Array.isArray(old)) return old;
      return old.map((task: unknown) =>
        task &&
        typeof task === 'object' &&
        (task as { id?: unknown }).id === task_id
          ? { ...(task as Record<string, unknown>), description }
          : task,
      );
    },
  );
  qcRef?.setQueryData(
    queryKeys.fullTask.all(project_id, task_id),
    (old: unknown) =>
      old && typeof old === 'object' && (old as { id?: unknown }).id === task_id
        ? { ...(old as Record<string, unknown>), description }
        : old,
  );
}

// Read at poll-arming time (not module load) so tests can tune the cadence
// via VITE_HEALTH_POLL_INTERVAL_MS without a test-only hook in this module.
function healthPollIntervalMs(): number {
  const parsed = Number(import.meta.env.VITE_HEALTH_POLL_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_HEALTH_POLL_INTERVAL_MS;
}
let pendingConnectGeneration: number | null = null;
let viewedConversationId: string | null = null;
// The server normally serializes delivery per socket, but retain ownership
// client-side too: a stale finish must never erase a newer task run.
const activeTaskRunIds = new Map<string, string>();
// Monotonic ownership token for async connection attempts. Login and AppShell
// mount can request a connection close together. Ticket acquisition is async,
// so without this guard an older attempt could finish last and replace the
// valid post-unlock socket.
let connectGeneration = 0;
const pendingPersonaSpeech = new Map<
  string,
  {
    messageId: string;
    conversationId: string;
    projectId: string;
    text: string;
    liveModeSessionId: string;
    voice?: string;
    lang?: string;
  }
>();
// Work-mode persona starts are metadata-only. Rendering that empty row lets
// transcript grouping attach its persona identity to the preceding assistant
// text until the first chunk arrives, producing an avatar/name flash. Hold the
// start locally and materialize the row with its first visible chunk instead.
const pendingWorkPersonaStarts = new Map<string, Record<string, unknown>>();
// Persona Live may generate one speaker ahead while the current voice is
// playing. Keep that lookahead's identity and chunks off-screen until the
// server-owned queue releases it.
const pendingLivePersonaStarts = new Map<string, Record<string, unknown>>();
// Canonical persona messages can arrive before the transcript file catches up.
// Keep them through the round-ending refetch so a stale response cannot erase
// telemetry/emote metadata that was already delivered over the socket.
const canonicalPersonaMessages = new Map<string, Map<string, any>>();
// Main canonical messages carry their run key explicitly. Retain the content
// until chat_completed so a late pre-completion output frame cannot win the
// final handoff merely because it arrived after chat_message.
const canonicalMainContentByStreamKey = new Map<string, string>();
/** Absolute offset of the buffered output's first char, for streams whose
 * snapshot the server trimmed at its buffer cap. Absent means 0. */
const chatStreamBaseOffsetByKey = new Map<string, number>();
/** Same as above, per persona message id. */
const personaBaseOffsetByMessageId = new Map<string, number>();

/** Reconcile a persona delta. A replay flagged `snapshot` into an empty row
 * carries a server-trimmed buffer, so its offset becomes the row's base. */
function reconcilePersonaChunk(
  messageId: string,
  current: string,
  chunk: string,
  contentOffset: number | undefined,
  snapshot: boolean,
): string {
  if (snapshot && !current && Number(contentOffset) > 0) {
    personaBaseOffsetByMessageId.set(messageId, contentOffset!);
  }
  return reconcileChatStreamChunk(
    current,
    chunk,
    contentOffset,
    personaBaseOffsetByMessageId.get(messageId),
  );
}
const liveQueueRevisionByConversation = new Map<string, number>();
const liveQueueCurrentByConversation = new Map<
  string,
  { messageId: string; state: string }
>();
// The first visible persona owns the row before its generated message has
// reached the durable queue. This closes the start-event race where a
// lookahead persona can begin before the first queue snapshot arrives.
const presentedLivePersonaByConversation = new Map<string, string>();
const liveQueueHiddenByConversation = new Map<string, Set<string>>();
const liveQueueCompletedByConversation = new Map<string, Set<string>>();
const liveQueueControlledMessageIds = new Set<string>();
const liveQueueEnabledConversations = new Set<string>();
const flushingQueuedPromptConversations = new Set<string>();
// A completion refetch can start before the browser drain persists its user
// turn. Retain acknowledged rows until that in-flight snapshot has settled so
// it cannot erase the newly materialized boundary.
const canonicalQueuedUserMessages = new Map<
  string,
  Map<string, Record<string, unknown>>
>();

/** Materialize the authoritative user boundary carried by a background drain
 * acknowledgement before the follow-up stream can render against this cache. */
function cacheCanonicalQueuedUserMessage(
  folder: string,
  conversationId: string,
  message: Record<string, unknown>,
): void {
  if (!qcRef || typeof message.id !== 'string') return;
  const stableIds = new Set<string>([
    message.id,
    ...(Array.isArray(message.clientSubmissionIds)
      ? message.clientSubmissionIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : []),
  ]);
  const canonicalMessage = {
    ...message,
    type: 'message',
    role: 'user',
  };
  const conversationKey = `${folder}\u0000${conversationId}`;
  const retained =
    canonicalQueuedUserMessages.get(conversationKey) ?? new Map();
  retained.set(message.id, canonicalMessage);
  canonicalQueuedUserMessages.set(conversationKey, retained);
  qcRef.setQueryData<TranscriptCache>(
    queryKeys.chatTranscript.all(folder, conversationId),
    (cached) => {
      if (!cached?.pages?.length) return cached;
      let replaced = false;
      const pages = cached.pages.map((page) => ({
        ...page,
        entries: (page.entries ?? []).map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const candidate = entry as Record<string, unknown>;
          const candidateIds = [
            candidate.id,
            ...(Array.isArray(candidate.clientSubmissionIds)
              ? candidate.clientSubmissionIds
              : []),
          ];
          if (
            candidate.type !== 'message' ||
            candidate.role !== 'user' ||
            !candidateIds.some(
              (id) => typeof id === 'string' && stableIds.has(id),
            )
          ) {
            return entry;
          }
          replaced = true;
          const canonicalCandidate: Record<string, unknown> = {
            ...candidate,
            ...canonicalMessage,
          };
          const { optimistic: _, ...canonical } = canonicalCandidate;
          return canonical;
        }),
      }));
      if (replaced) return { ...cached, pages };
      pages[0] = {
        ...pages[0],
        entries: [...(pages[0].entries ?? []), canonicalMessage],
      };
      return { ...cached, pages };
    },
  );
}

function restoreCanonicalQueuedUserMessages(
  folder: string,
  conversationId: string,
  clear = false,
): void {
  const conversationKey = `${folder}\u0000${conversationId}`;
  const messages = canonicalQueuedUserMessages.get(conversationKey);
  if (!messages) return;
  for (const message of messages.values()) {
    cacheCanonicalQueuedUserMessage(folder, conversationId, message);
  }
  if (clear) canonicalQueuedUserMessages.delete(conversationKey);
}

function applyQueuedPromptReceipts(payload: Record<string, unknown>): void {
  const conversationId =
    typeof payload.conversation_id === 'string'
      ? payload.conversation_id
      : undefined;
  if (!conversationId) return;
  const consumed = Array.isArray(payload.consumedQueuedMessageIds)
    ? payload.consumedQueuedMessageIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
  const released = Array.isArray(payload.releasedQueuedMessageIds)
    ? payload.releasedQueuedMessageIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
  if (consumed.length === 0 && released.length === 0) return;

  useStore.setState((state) => {
    const current = state.queuedPromptsByConv[conversationId] ?? [];
    const reconciled = reconcileQueuedPromptReceipts(current, {
      consumed,
      released,
    });
    if (reconciled === current) return state;
    const nextQueues = { ...state.queuedPromptsByConv };
    if (reconciled.length > 0) nextQueues[conversationId] = reconciled;
    else delete nextQueues[conversationId];
    return { queuedPromptsByConv: nextQueues };
  });
}
const MEMORY_CONTEXT_LEVELS: MemoryContextLevel[] = [
  'off',
  'minimal',
  'standard',
  'deep',
];

/**
 * Drain a completed conversation's browser queue from the app-level socket.
 * ChatPage is not necessarily mounted when a background conversation finishes.
 */
export async function flushQueuedPromptsAfterCompletion(
  payload: Record<string, unknown>,
  senders: { sendChatMessage: typeof sendChatMessage } = { sendChatMessage },
) {
  applyQueuedPromptReceipts(payload);
  const conversationId = String(payload.conversation_id || '');
  const objectiveId =
    typeof payload.objective_id === 'string' ? payload.objective_id : undefined;
  const projectId =
    typeof payload.project_id === 'string'
      ? payload.project_id
      : typeof payload.folder === 'string'
        ? payload.folder
        : undefined;
  const contextKey = objectiveId ?? projectId;
  if (!conversationId || !projectId || !contextKey) return;
  if (flushingQueuedPromptConversations.has(conversationId)) return;

  const store = useStore.getState();
  let queued = (store.queuedPromptsByConv[conversationId] ?? []).filter(
    (prompt) =>
      !prompt.serverOwned &&
      !prompt.consumedByServer &&
      !prompt.awaitingAcknowledgement,
  );
  if (queued.some((prompt) => prompt.openFileContext))
    queued = queued.slice(0, 1);
  if (
    queued.length === 0 ||
    queued.some((prompt) => prompt.contextKey !== contextKey)
  ) {
    return;
  }

  flushingQueuedPromptConversations.add(conversationId);
  useStore.setState((state) => {
    return {
      queuedPromptsByConv: {
        ...state.queuedPromptsByConv,
        [conversationId]: markQueuedPromptBatchAwaitingAcknowledgement(
          state.queuedPromptsByConv[conversationId] ?? [],
          queued,
        ),
      },
    };
  });

  const content = queued.map((prompt) => prompt.content).join('\n\n');
  const attachments = queued.flatMap((prompt) => prompt.attachments ?? []);
  const deepLinks = queued.flatMap((prompt) => prompt.deepLinks ?? []);
  const first = queued[0];
  const memoryContextLevel = queued.reduce<MemoryContextLevel>(
    (highest, prompt) =>
      MEMORY_CONTEXT_LEVELS.indexOf(prompt.memoryContextLevel ?? 'off') >
      MEMORY_CONTEXT_LEVELS.indexOf(highest)
        ? prompt.memoryContextLevel
        : highest,
    'off',
  );

  try {
    const result = await senders.sendChatMessage(
      projectId,
      content,
      conversationId,
      attachments.length > 0 ? attachments : undefined,
      first?.agent_cmd,
      first?.chat_mode,
      first?.liveMode === true,
      first?.runtimeSelection,
      undefined,
      deepLinks.length > 0 ? deepLinks : undefined,
      { level: memoryContextLevel },
      first?.liveModeSessionId,
      first?.liveModeKind,
      first?.id,
      queued.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
      objectiveId,
      first?.openFileContext,
    );

    const browserOwnsResult =
      result.delivery === 'queued' &&
      (!result.queueOwner || result.queueOwner === 'browser');
    if (!browserOwnsResult && result.userMessage) {
      cacheCanonicalQueuedUserMessage(
        projectId,
        conversationId,
        result.userMessage as unknown as Record<string, unknown>,
      );
    }
    const durableMessageId =
      result.userMessage?.id ??
      (result.delivery === 'queued' && result.queueOwner === 'persona'
        ? result.queuedMessageId
        : first?.id);
    const serverOwnedPrompt: QueuedPrompt | undefined = durableMessageId
      ? {
          id: durableMessageId,
          contextKey,
          content,
          bubbleContent: queued
            .map((prompt) => prompt.bubbleContent)
            .join('\n\n'),
          draftContent: queued
            .map((prompt) => prompt.draftContent ?? prompt.bubbleContent)
            .join('\n\n'),
          openFileContext: first?.openFileContext,
          conversation_id: conversationId,
          attachments: attachments.length > 0 ? attachments : undefined,
          deepLinks: deepLinks.length > 0 ? deepLinks : undefined,
          agent_cmd: first?.agent_cmd,
          chat_mode: first?.chat_mode,
          runtimeSelection: first?.runtimeSelection,
          memoryContextLevel,
          serverOwned: true,
          serverQueueOwner:
            result.queueOwner === 'persona'
              ? 'persona'
              : result.queueOwner === 'direct'
                ? 'direct'
                : 'server',
          liveMode: first?.liveMode,
          liveModeSessionId: first?.liveModeSessionId,
          liveModeKind: first?.liveModeKind,
        }
      : undefined;

    useStore.setState((state) => {
      const current = state.queuedPromptsByConv[conversationId] ?? [];
      const reconciled = browserOwnsResult
        ? releaseQueuedPromptBatchForDrain(current, queued)
        : serverOwnedPrompt
          ? replaceQueuedPromptBatchWithServerOwned(
              current,
              queued,
              { ...serverOwnedPrompt, serverReleased: undefined },
              false,
            )
          : removeAcknowledgedQueuedPromptBatch(current, queued);
      const nextQueues = { ...state.queuedPromptsByConv };
      if (reconciled.length > 0) nextQueues[conversationId] = reconciled;
      else delete nextQueues[conversationId];
      return { queuedPromptsByConv: nextQueues };
    });
  } catch (error) {
    const conversationMissing = isConversationNotFoundError(error);
    useStore.setState((state) => {
      const current = state.queuedPromptsByConv[conversationId] ?? [];
      const reconciled = conversationMissing
        ? discardQueuedPromptBatch(current, queued)
        : releaseQueuedPromptBatchForDrain(current, queued);
      const nextQueues = { ...state.queuedPromptsByConv };
      if (reconciled.length > 0) nextQueues[conversationId] = reconciled;
      else delete nextQueues[conversationId];
      return { queuedPromptsByConv: nextQueues };
    });
    if (conversationMissing) {
      toast.error(missingConversationPromptNotice(queued.length));
    } else if (error instanceof Error && !(error instanceof TypeError)) {
      toast.error(`Failed to send queued prompt: ${error.message}`);
    } else if (!(error instanceof TypeError)) {
      toast.error('Failed to send queued prompt.');
    }
  } finally {
    flushingQueuedPromptConversations.delete(conversationId);
  }
}

function livePersonaPlaybackContext(
  store: ReturnType<typeof useStore.getState>,
  conversationId: string,
  eventSessionId: unknown,
): {
  acceptsPlayback: boolean;
  sessionId: string | null;
} {
  const sessionId = typeof eventSessionId === 'string' ? eventSessionId : null;
  if (!sessionId) return { acceptsPlayback: false, sessionId: null };
  const ownsLiveSession = sessionId === store.liveModeSessionId;
  const watchingConversation = isConversationSelected(store, conversationId);
  // Persona events carrying a live session are themselves authoritative. This
  // also covers an observer whose access-filter lookup delivered the persona
  // event before the preceding mode-change event.
  if (
    watchingConversation &&
    store.liveModeSessionByConversation[conversationId] !== sessionId
  ) {
    store.setConversationLiveModeEnabled(conversationId, true);
    store.setConversationLiveModeSession(conversationId, sessionId);
  }
  if (watchingConversation) setLiveSpeechFocus(conversationId);
  const mirroredPlayback = watchingConversation;
  return {
    acceptsPlayback: ownsLiveSession || mirroredPlayback,
    sessionId,
  };
}

function personaEntryMatchesCanonicalId(
  entry: any,
  messageId: string,
): boolean {
  return (
    entry?.type === 'message' &&
    entry?.role === 'assistant' &&
    (transcriptMessageIdMatchesCanonical(entry.id, messageId) ||
      transcriptMessageIdMatchesCanonical(entry.canonicalMessageId, messageId))
  );
}

/**
 * Chat events always carry the owning project as `folder`; objective chats add
 * `objective_id`. Keep the objective's conversation list, cards, and attention
 * badges fresh from that extra field.
 */
function invalidateObjectiveChatQueries(
  payload: Record<string, any>,
  includeObjectives = false,
): void {
  const objectiveId = payload.objective_id;
  const projectId = payload.project_id ?? payload.folder;
  if (
    !qcRef ||
    typeof objectiveId !== 'string' ||
    typeof projectId !== 'string'
  )
    return;
  qcRef.invalidateQueries({
    queryKey: queryKeys.objectiveConversations.all(projectId, objectiveId),
  });
  qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
  if (includeObjectives) {
    qcRef.invalidateQueries({ queryKey: queryKeys.objectives.all(projectId) });
    qcRef.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
  }
}

/**
 * ChatPage keeps its selection/pending-run slots per view: the project chat and
 * each objective chat have separate ones. Events still carry the project folder.
 */
function chatViewKey(payload: Record<string, any>): string {
  return typeof payload.objective_id === 'string'
    ? payload.objective_id
    : (payload.folder as string);
}

/** Conversation ids are globally unique, so any view selecting one is watching it. */
function isConversationSelected(
  store: ReturnType<typeof useStore.getState>,
  conversationId: string,
): boolean {
  return Object.values(store.activeConvByProject).includes(conversationId);
}

function updatePersonaStreamEntry(
  folder: string,
  conversationId: string,
  messageId: string,
  update: (entry: any | undefined) => any | null,
): void {
  if (!qcRef) return;
  const key = queryKeys.chatTranscript.all(folder, conversationId);
  qcRef.setQueryData<any>(key, (cached: any) => {
    if (!cached?.pages?.length) return cached;
    // The canonical message and its ai_user_attribution companion share an
    // id.  Prefer the actual message row even if a refetch temporarily puts
    // the attribution record first; mutating that record would make the
    // renderer concatenate the same response twice.
    let targetPageIndex = -1;
    let targetEntryIndex = -1;
    for (let pageIndex = 0; pageIndex < cached.pages.length; pageIndex++) {
      const entries = cached.pages[pageIndex]?.entries ?? [];
      const messageIndex = entries.findIndex((entry: any) =>
        personaEntryMatchesCanonicalId(entry, messageId),
      );
      if (messageIndex >= 0) {
        targetPageIndex = pageIndex;
        targetEntryIndex = messageIndex;
        break;
      }
    }
    let found = false;
    const pages = cached.pages.map((page: any, pageIndex: number) => ({
      ...page,
      entries: (page.entries ?? []).flatMap(
        (entry: any, entryIndex: number) => {
          if (pageIndex !== targetPageIndex || entryIndex !== targetEntryIndex)
            return [entry];
          found = true;
          const next = update(entry);
          return next ? [next] : [];
        },
      ),
    }));
    if (!found) {
      const next = update(undefined);
      if (next) {
        // A stale transcript response may omit a completed persona row while
        // a later speaker is already current. Restore it at its durable
        // timestamp rather than appending it after the later speaker.
        const entries = [...(pages[0].entries ?? [])];
        const nextTime = next.created_at
          ? new Date(next.created_at).getTime()
          : Number.NaN;
        const insertionIndex = Number.isFinite(nextTime)
          ? entries.findIndex((entry: any) => {
              const entryTime = entry?.created_at
                ? new Date(entry.created_at).getTime()
                : Number.NaN;
              return Number.isFinite(entryTime) && entryTime > nextTime;
            })
          : -1;
        entries.splice(
          insertionIndex < 0 ? entries.length : insertionIndex,
          0,
          next,
        );
        pages[0] = { ...pages[0], entries };
      }
    }
    return { ...cached, pages };
  });
}

function personaConversationKey(
  folder: string,
  conversationId: string,
): string {
  return `${folder}\u0000${conversationId}`;
}

function rememberCanonicalPersonaMessage(
  folder: string,
  conversationId: string,
  message: any,
): void {
  const key = personaConversationKey(folder, conversationId);
  const messages = canonicalPersonaMessages.get(key) ?? new Map<string, any>();
  messages.set(message.id, message);
  canonicalPersonaMessages.set(key, messages);
}

/** Merge a saved persona message into the open transcript cache. */
function applyCanonicalPersonaMessage(
  store: ReturnType<typeof useStore.getState>,
  folder: string,
  convId: string,
  message: any,
): void {
  rememberCanonicalPersonaMessage(folder, convId, message);
  pendingWorkPersonaStarts.delete(message.id);
  const preserveLivePresentation =
    store.liveModeEnabledByConversation[convId] === true;
  updatePersonaStreamEntry(folder, convId, message.id, (entry) => {
    if (preserveLivePresentation && entry) {
      // Work Live rows contain replayable [[live: ...]] narration that
      // is intentionally absent from the canonical message. Persona
      // Live rows may also still be voice-delayed. Keep that rendered
      // content and lifecycle state until chat_persona_finished, while
      // accepting canonical identity/emote/telemetry metadata.
      return {
        ...entry,
        ...message,
        type: 'message',
        role: 'assistant',
        content: entry.content,
        streaming: entry.streaming,
      };
    }
    const preserveAggregatedReplay =
      entry?.canonicalMessageId === message.id &&
      typeof entry?.content === 'string';
    return {
      ...(preserveAggregatedReplay ? entry : {}),
      ...message,
      type: 'message',
      role: 'assistant',
      content: preserveAggregatedReplay
        ? entry.content
        : completedStreamContent(entry?.content, message.content),
      streaming: false,
    };
  });
}

function restoreCanonicalPersonaMessages(
  folder: string,
  conversationId: string,
  clear = false,
): void {
  const key = personaConversationKey(folder, conversationId);
  const messages = canonicalPersonaMessages.get(key);
  if (!messages) return;
  for (const message of messages.values()) {
    updatePersonaStreamEntry(folder, conversationId, message.id, (entry) => {
      const preserveAggregatedReplay =
        entry?.canonicalMessageId === message.id &&
        typeof entry?.content === 'string';
      return {
        ...(entry ?? {}),
        ...message,
        type: 'message',
        role: 'assistant',
        content: preserveAggregatedReplay
          ? entry.content
          : completedStreamContent(entry?.content, message.content),
        streaming: false,
      };
    });
  }
  if (clear) canonicalPersonaMessages.delete(key);
}

async function refetchTranscriptPreservingPersonas(
  folder: string,
  conversationId: string,
  clearAfterRefetch = false,
): Promise<void> {
  if (!qcRef) return;
  try {
    await qcRef.refetchQueries({
      queryKey: queryKeys.chatTranscript.all(folder, conversationId),
    });
  } finally {
    restoreCanonicalQueuedUserMessages(
      folder,
      conversationId,
      clearAfterRefetch,
    );
    restoreCanonicalPersonaMessages(folder, conversationId, clearAfterRefetch);
  }
}

function personaStreamEntryHasContent(
  folder: string,
  conversationId: string,
  messageId: string,
): boolean {
  const cached = qcRef?.getQueryData<any>(
    queryKeys.chatTranscript.all(folder, conversationId),
  );
  return (cached?.pages ?? []).some((page: any) =>
    (page.entries ?? []).some(
      (entry: any) =>
        entry?.id === messageId && String(entry.content ?? '').length > 0,
    ),
  );
}

function personaStreamEntryExists(
  folder: string,
  conversationId: string,
  messageId: string,
): boolean {
  const cached = qcRef?.getQueryData<any>(
    queryKeys.chatTranscript.all(folder, conversationId),
  );
  return (cached?.pages ?? []).some((page: any) =>
    (page.entries ?? []).some((entry: any) => entry?.id === messageId),
  );
}

function personaStreamEntry(
  folder: string,
  conversationId: string,
  messageId: string,
): any | undefined {
  const cached = qcRef?.getQueryData<any>(
    queryKeys.chatTranscript.all(folder, conversationId),
  );
  for (const page of cached?.pages ?? []) {
    const entry = (page.entries ?? []).find(
      (candidate: any) => candidate?.id === messageId,
    );
    if (entry) return entry;
  }
  return undefined;
}

function isAiPersonaMessage(message: any): boolean {
  return (
    message?.senderUserId?.startsWith?.('ai:') ||
    message?.agent_name?.startsWith?.('ai:') ||
    message?.agent_name?.startsWith?.('ai-main:')
  );
}

function shouldDeferCanonicalTranscriptRefetch(
  store: ReturnType<typeof useStore.getState>,
  conversationId: string,
): boolean {
  const streamKey = store.activeStreamKeyByConv[conversationId];
  return Boolean(
    streamKey && store.chatStreamPresentation[streamKey]?.canonicalPersonaTurns,
  );
}

function handleServerRestarted(store: ReturnType<typeof useStore.getState>) {
  pendingWorkPersonaStarts.clear();
  canonicalMainContentByStreamKey.clear();
  pendingLivePersonaStarts.clear();
  pendingPersonaSpeech.clear();
  presentedLivePersonaByConversation.clear();
  store.setServerRestarted(true);
  // Keep in-memory streaming bubbles until the transcript refetch below proves
  // the content is persisted. clearAllChatStreaming here caused a blank gap on
  // every restart — JSONL often lags the DB (assistant saves use skipTranscript)
  // and recovery may take seconds to re-stream.
  if (qcRef) {
    void Promise.all([
      qcRef.refetchQueries({ queryKey: ['chatTranscript'] }),
      qcRef.refetchQueries({ queryKey: ['conversations'] }),
      qcRef.refetchQueries({ queryKey: ['objectiveConversations'] }),
      // The new server process resets in-memory build state, so any cached
      // "ready" board build must be re-fetched from the new process. Both the
      // health poll and the server_restarted handshake route through here, so
      // a forced reconnect that never delivers the handshake still clears it.
      qcRef.invalidateQueries({ queryKey: queryKeys.serverWebBuild }),
    ]);
  }
}

/** Poll /health to detect server restarts even when WS can't reconnect (e.g. session lost). */
function startHealthPoll() {
  stopHealthPoll();
  healthPollTimer = setInterval(async () => {
    try {
      const res = await apiFetch(API_BASE_URL + '/health');
      if (!res.ok) return;
      const data = await res.json();
      const serverStartedAt = data.started_at as number | undefined;
      if (!serverStartedAt) return;
      if (
        knownServerStartedAt !== null &&
        knownServerStartedAt !== serverStartedAt
      ) {
        handleServerRestarted(useStore.getState());
        // On Android a socket can remain apparently OPEN after the backend
        // process has restarted, so its onclose handler never gets a chance
        // to schedule the normal reconnect. Recreate it explicitly when the
        // health probe proves that we are talking to a new server process.
        if (qcRef) connectWebSocket(qcRef, { force: true });
      }
      knownServerStartedAt = serverStartedAt;
    } catch {
      /* server down — ignore, will retry */
    }
  }, healthPollIntervalMs());
}

function stopHealthPoll() {
  if (healthPollTimer) {
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }
}

function beginConnect(generation: number): void {
  pendingConnectGeneration = generation;
  void connect(generation).finally(() => {
    if (pendingConnectGeneration === generation)
      pendingConnectGeneration = null;
  });
}

let unsubscribeLiveSpeechMute: (() => void) | null = null;

export function connectWebSocket(
  queryClient: QueryClient,
  options: { force?: boolean } = {},
) {
  qcRef = queryClient;
  // Muted playback never consumes buffered persona speech text; drop it as
  // soon as the user mutes instead of waiting for the next queue snapshot.
  unsubscribeLiveSpeechMute ??= subscribeLiveSpeech(() => {
    if (getLiveSpeechState().muted) pendingPersonaSpeech.clear();
  });
  void attachNativeSpeechPlaybackListener((event) => {
    const store = useStore.getState();
    const activeMirroredSession = Object.values(
      store.liveModeSessionByConversation,
    ).includes(event.sessionId);
    if (event.sessionId !== store.liveModeSessionId && !activeMirroredSession)
      return;
    if (event.phase === 'started')
      markLivePersonaPlaybackStarted(event.messageId);
    else releaseLivePersonaReveal(event.messageId);
  });
  if (
    !options.force &&
    (pendingConnectGeneration !== null ||
      ws?.readyState === WebSocket.CONNECTING ||
      ws?.readyState === WebSocket.OPEN)
  ) {
    startHealthPoll();
    return;
  }
  // A new or forced connect request means a caller wants a socket now. Reset
  // the backoff so we retry promptly
  // instead of inheriting the grown delay from a prior failure loop — notably
  // the pre-login connect that ran with no session and backed off to 30s. On
  // Android cold-start that left the WS down for the first agent run, so
  // streaming silently broke until the user switched conversations. The
  // internal onclose auto-reconnect path still grows its own delay, so
  // unattended failures keep backing off.
  reconnectDelay = 1000;
  const generation = ++connectGeneration;
  beginConnect(generation);
  // Seed baseline started_at from /health so the poll can detect restarts
  // even if the WS never connects (e.g. 401 after session loss).
  apiFetch(API_BASE_URL + '/health')
    .then((r: Response) => (r.ok ? r.json() : null))
    .then((data: any) => {
      if (data?.started_at && knownServerStartedAt === null) {
        knownServerStartedAt = data.started_at;
      }
    })
    .catch(() => {});
  startHealthPoll();
}

export function disconnectWebSocket() {
  // Invalidate ticket requests that are still in flight. Otherwise one can
  // create a socket after logout/unmount has explicitly disconnected it.
  connectGeneration += 1;
  pendingConnectGeneration = null;
  useStore.getState().setWebsocketConnected(false);
  stopHealthPoll();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    // Remove onclose before closing to prevent the handler from scheduling a
    // reconnect timer after we've already cleared it.
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  qcRef = null;
}

function sendConversationPresence(socket: WebSocket | null = ws): void {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    typeof socket.send !== 'function'
  )
    return;
  socket.send(
    JSON.stringify({
      type: 'conversation_presence',
      payload: { conversation_id: viewedConversationId },
    }),
  );
}

/** Tell the server which visible conversation this device is actively viewing. */
export function setViewedConversationPresence(
  conversationId: string | null,
): void {
  viewedConversationId =
    typeof document === 'undefined' || document.visibilityState === 'visible'
      ? conversationId
      : null;
  sendConversationPresence();
}

/** Reconcile durable chat state after every successful socket connection. */
export function handleWebSocketConnected(): void {
  // A run can end while the socket is down and its terminal event is never
  // delivered. The server replays task_started only for still-running tasks,
  // so drop locally tracked live state here and let the replay and the
  // refetched task list re-establish it.
  activeTaskRunIds.clear();
  useStore.setState({ liveTaskIds: {} });
  qcRef?.invalidateQueries({ queryKey: ['tasks'] });
  qcRef?.invalidateQueries({ queryKey: queryKeys.runtimeCatalog });
  qcRef?.invalidateQueries({ queryKey: queryKeys.chatAgents });
  qcRef?.invalidateQueries({ queryKey: ['sandbox'] });
  qcRef?.invalidateQueries({ queryKey: ['bashTab', 'shells'] });
  useStore.getState().bumpProjectsChangeSeq();
  qcRef?.invalidateQueries({ queryKey: queryKeys.projects.all });
  qcRef?.invalidateQueries({ queryKey: queryKeys.publishedApps.all });
  // Status changes are pushed while the socket is connected. Reconcile once
  // after reconnect instead of polling the relatively expensive aggregate.
  qcRef?.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
  qcRef?.invalidateQueries({ queryKey: queryKeys.attention.all });
  // Unread notifications never go stale on their own; an archive or
  // acknowledgement missed while disconnected would otherwise leave a row.
  qcRef?.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
  void qcRef?.refetchQueries({
    queryKey: ['chatTranscript'],
    type: 'all',
  });
}

async function connect(generation = ++connectGeneration) {
  if (generation !== connectGeneration) return;
  useStore.getState().setWebsocketConnected(false);
  // Close any existing connection first to prevent orphaned sockets that
  // continue receiving events in parallel with the new connection.
  if (ws) {
    ws.onclose = null; // prevent reconnect scheduling from the old socket
    ws.close();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // API_BASE_URL always represents the active native connection mode. Android
  // trusts the bundled LAN certificate for the WebView too, so Home mode can
  // use its reachable local WSS endpoint while Remote mode uses the tunnel.
  const httpBase = API_BASE_URL;
  const baseWsUrl = applicationWebSocketBaseUrl(httpBase);
  const endpoint = (() => {
    try {
      const parsed = new URL(baseWsUrl);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return '<invalid-websocket-url>';
    }
  })();
  console.info('[WS] Connecting', {
    endpoint,
    transport: 'selected-origin',
    generation,
  });

  const url = await authenticatedApplicationWebSocketUrl(httpBase, {
    apiFetch,
    isAndroid: () =>
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android',
    populateVault: vaultPopulate,
  });

  // A newer explicit connect (most importantly the post-unlock connect) owns
  // the socket now. Do not let this older attempt overwrite it merely because
  // its HTTP ticket request completed later.
  if (generation !== connectGeneration) return;
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    console.info('[WS] Connected', { endpoint, generation });
    reconnectDelay = 1000;
    useStore.getState().setWebsocketConnected(true);
    sendConversationPresence(socket);
    handleWebSocketConnected();
    qcRef?.invalidateQueries({ queryKey: ['cronjobs'] });
    qcRef?.invalidateQueries({ queryKey: ['scheduledTaskRuns'] });
    qcRef?.invalidateQueries({ queryKey: ['scheduledTasks'] });
    qcRef?.invalidateQueries({ queryKey: queryKeys.serverWebBuild });
  };

  socket.onmessage = (event) => {
    // Ignore events from a stale socket that was replaced by a newer connect()
    if (ws !== socket) return;
    try {
      const data: WsEvent = JSON.parse(event.data);
      handleWebSocketEvent(data);
    } catch {
      /* ignore malformed messages */
    }
  };

  socket.onclose = (event) => {
    console.warn('[WS] Closed', {
      endpoint,
      generation,
      code: event.code,
      reason: event.reason || '<none>',
      wasClean: event.wasClean,
    });
    // Only schedule reconnect if this socket is still the current one.
    // If connect() was called again (replacing us), don't reconnect.
    if (ws !== socket) return;
    useStore.getState().setWebsocketConnected(false);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      const generation = ++connectGeneration;
      beginConnect(generation);
    }, reconnectDelay);
  };

  socket.onerror = () => {
    console.error('[WS] Connection error', { endpoint, generation });
    if (ws === socket) {
      useStore.getState().setWebsocketConnected(false);
      ws?.close();
    }
  };
}

type TranscriptCachePage = {
  entries?: unknown[];
  [key: string]: unknown;
};

type TranscriptCache = {
  pages?: TranscriptCachePage[];
  [key: string]: unknown;
};
export function handleWebSocketEvent(event: WsEvent) {
  if (!qcRef) return;
  const store = useStore.getState();
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case 'task_created':
    case 'task_updated':
    case 'task_deleted': {
      // Invalidate tasks for the relevant project
      const project_id = payload.project_id as string | undefined;
      if (project_id) {
        invalidateTaskLifecycleQueries(project_id);
        qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
        const task_id = (payload.id || payload.task_id) as string | undefined;
        if (task_id) {
          qcRef.invalidateQueries({
            queryKey: queryKeys.taskDiff.all(project_id, task_id),
          });
          if (event.type === 'task_deleted') {
            // A deleted task's notifications are no longer returned; refetch
            // so its Now row and bell count clear.
            qcRef.invalidateQueries({
              queryKey: queryKeys.unreadNotifications,
            });
          }
          if (event.type === 'task_updated') {
            // The server acks an archived task's leftover notifications on the
            // next unread fetch; refetch so its Now row and bell count clear.
            if (payload.archived) {
              qcRef.invalidateQueries({
                queryKey: queryKeys.unreadNotifications,
              });
            }
            reconcileExternalTaskDescription(project_id, task_id, payload);
            qcRef.invalidateQueries({
              queryKey: queryKeys.fullTask.all(project_id, task_id),
            });
          }
        }
      } else {
        // Can't determine project — invalidate all tasks queries
        qcRef.invalidateQueries({ queryKey: ['tasks'] });
      }
      invalidateProjectStatusSummary();
      break;
    }

    case 'cronjob_updated': {
      const project_id = payload.project_id as string | undefined;
      if (project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.cronjobs.all(project_id),
        });
      } else {
        qcRef.invalidateQueries({ queryKey: ['cronjobs'] });
      }
      break;
    }

    case 'scheduled_task_run_started':
    case 'scheduled_task_run_completed': {
      const project_id = payload.project_id as string | undefined;
      const scheduled_task_id = payload.scheduled_task_id as string | undefined;
      if (project_id && scheduled_task_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.scheduledTasks.runs(
            project_id,
            scheduled_task_id,
          ),
        });
        qcRef.invalidateQueries({
          queryKey: queryKeys.scheduledTasks.detail(
            project_id,
            scheduled_task_id,
          ),
        });
        qcRef.invalidateQueries({
          queryKey: queryKeys.scheduledTasks.all(project_id),
        });
      } else {
        qcRef.invalidateQueries({ queryKey: ['scheduledTaskRuns'] });
        qcRef.invalidateQueries({ queryKey: ['scheduledTasks'] });
      }
      qcRef.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
      break;
    }

    case 'task_completed':
    case 'task_error': {
      const project_id = payload.project_id as string | undefined;
      const task_id = payload.task_id as string | undefined;
      if (task_id) {
        activeTaskRunIds.delete(task_id);
        store.unmarkTaskLive(task_id);
        store.setTaskBackgroundTasks(task_id, []);
      }
      if (project_id) {
        // Completion is authoritative. Update the cached flag immediately so
        // an overlapping priority drag cannot cancel the refetch and preserve
        // the task_started value (`running: true`) on the finished card.
        patchTaskLists(qcRef, project_id, (tasks) =>
          tasks.map((t) =>
            t.id === task_id
              ? {
                  ...t,
                  running: false,
                  phase: t.phase === 'running' ? 'idle' : t.phase,
                }
              : t,
          ),
        );
        invalidateTaskLifecycleQueries(project_id);
        qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
      } else {
        qcRef.invalidateQueries({ queryKey: ['tasks'] });
      }
      invalidateProjectStatusSummary();
      // Invalidate messages so they load and replace the streaming bubble
      if (task_id && project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.messages.all(project_id, task_id),
        });
        qcRef.invalidateQueries({
          queryKey: queryKeys.taskDiff.all(project_id, task_id),
        });
      } else if (task_id) {
        qcRef.invalidateQueries({ queryKey: ['messages'] });
      }
      // Refresh run history so run dividers show the run's final status/tokens.
      if (task_id && project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.runs.all(project_id, task_id),
        });
      } else {
        qcRef.invalidateQueries({ queryKey: ['runs'] });
      }
      // Do NOT clear streaming output here — let it stay visible until isRunning becomes
      // false (when the tasks query refetches). This prevents a flash of empty content
      // between the streaming bubble disappearing and the saved messages loading.
      // Streaming output is cleared on task_started (next run) and on task_started.
      break;
    }

    case 'run_finished': {
      const project_id = payload.project_id as string | undefined;
      const task_id = payload.task_id as string | undefined;
      const run_id = payload.run_id as string | undefined;
      const activeRunId = task_id ? activeTaskRunIds.get(task_id) : undefined;
      // Ignore an old finish if a newer task_started has already reached the
      // client. This also protects clients connected to older server builds
      // that cannot yet guarantee ordered authenticated delivery.
      if (task_id && (!activeRunId || !run_id || activeRunId === run_id)) {
        activeTaskRunIds.delete(task_id);
        store.unmarkTaskLive(task_id);
        store.setTaskBackgroundTasks(task_id, []);
        if (run_id) store.finishTaskStream(task_id, run_id);
      } else if (task_id) {
        break;
      }
      if (project_id && task_id) {
        // Update every filtered task-list cache immediately. The following
        // refetch supplies the authoritative waiting projection.
        patchTaskLists(qcRef, project_id, (tasks) =>
          tasks.map((t) =>
            t.id === task_id
              ? {
                  ...t,
                  running: false,
                  phase: t.phase === 'running' ? 'idle' : t.phase,
                }
              : t,
          ),
        );
        invalidateTaskLifecycleQueries(project_id);
        qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
      } else {
        qcRef.invalidateQueries({ queryKey: ['tasks'] });
      }
      invalidateProjectStatusSummary();
      if (project_id && task_id) {
        // Keep the finished run's live output until this exact refetch has
        // settled. The dialog then verifies that the matching run segment is
        // present before retiring the fallback, avoiding both duplicates and
        // a finish-before-refetch blank frame.
        void Promise.resolve(
          qcRef.invalidateQueries(
            { queryKey: queryKeys.messages.all(project_id, task_id) },
            { throwOnError: true },
          ),
        ).then(
          () => {
            if (run_id) {
              useStore.getState().markTaskTranscriptReady(task_id, run_id);
            }
          },
          () => {
            // Preserve the live fallback when the canonical transcript could
            // not be refreshed; a later task_message/reconnect can retry it.
          },
        );
        qcRef.invalidateQueries({
          queryKey: queryKeys.runs.all(project_id, task_id),
        });
      } else if (task_id) {
        qcRef.invalidateQueries({ queryKey: ['messages'] });
        qcRef.invalidateQueries({ queryKey: ['runs'] });
      }
      break;
    }

    case 'task_preparing': {
      const task_id = payload.task_id as string | undefined;
      const project_id = payload.project_id as string | undefined;
      if (task_id && project_id) {
        const preparing = payload.preparing === true;
        patchTaskLists(qcRef, project_id, (tasks) =>
          tasks.map((t) => (t.id === task_id ? { ...t, preparing } : t)),
        );
      }
      break;
    }

    case 'task_started': {
      const task_id = payload.task_id as string;
      const project_id = payload.project_id as string;
      const run_id = payload.run_id as string | undefined;
      if (task_id && run_id) {
        activeTaskRunIds.set(task_id, run_id);
        store.claimTaskStream(task_id, run_id);
      }
      // Task stream state is keyed by task ID, so it must be reset for every
      // run. Otherwise a new run appends to the previous run's output and the
      // live bubble grows to contain the task's entire history. A reconnect
      // immediately follows this event with task_stream_snapshot, restoring
      // the in-progress run without retaining stale output.
      // claimTaskStream clears the previous run's output in the same store
      // update as the ownership change.
      if (task_id) {
        store.markTaskLive(task_id);
        store.clearTaskStalled(task_id);
        store.setTaskBackgroundTasks(task_id, []);
      }
      if (project_id) {
        // Optimistically set running: true so the stop button appears immediately,
        // without waiting for the background refetch to complete.
        patchTaskLists(qcRef, project_id, (tasks) =>
          tasks.map((t) =>
            t.id === task_id ? { ...t, running: true, phase: 'running' } : t,
          ),
        );
        invalidateTaskLifecycleQueries(project_id);
      } else {
        qcRef.invalidateQueries({ queryKey: ['tasks'] });
      }
      invalidateProjectStatusSummary();
      // A new run started — refresh run history so the new run's divider + the
      // Runs tab pick it up.
      if (task_id && project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.runs.all(project_id, task_id),
        });
      } else {
        qcRef.invalidateQueries({ queryKey: ['runs'] });
      }
      break;
    }

    case 'task_output': {
      const task_id = payload.task_id as string;
      const content = payload.content as string;
      const run_id = payload.run_id as string | undefined;
      const entryId = payload.entry_id as string | undefined;
      const entryComplete =
        typeof payload.entry_complete === 'boolean'
          ? payload.entry_complete
          : true;
      if (run_id && activeTaskRunIds.get(task_id) !== run_id) break;
      const contentOffset = Number(payload.content_offset);
      if (Number.isFinite(contentOffset))
        store.setTaskOutput(
          task_id,
          content,
          contentOffset,
          entryId,
          undefined,
          entryComplete,
        );
      else store.appendOutput(task_id, content, entryId, entryComplete);
      break;
    }

    case 'task_background_tasks': {
      const task_id = payload.task_id as string | undefined;
      const run_id = payload.run_id as string | undefined;
      const tasks = payload.tasks;
      if (run_id && task_id && activeTaskRunIds.get(task_id) !== run_id) break;
      if (task_id && Array.isArray(tasks)) {
        store.setTaskBackgroundTasks(task_id, tasks as BackgroundTask[]);
      }
      break;
    }

    case 'task_output_clear': {
      const task_id = payload.task_id as string;
      const run_id = payload.run_id as string | undefined;
      const force = payload.force === true;
      const ownedRunId = store.taskStreamRunIds[task_id];
      if (task_id) {
        const matchesOwner = !!run_id && (!ownedRunId || ownedRunId === run_id);
        const transcriptReady =
          run_id && store.readyTaskTranscriptRunIds[task_id] === run_id;
        const canClear = run_id
          ? matchesOwner && (force || transcriptReady)
          : force || !ownedRunId;
        if (canClear) {
          store.clearOutput(task_id);
          store.unmarkTaskLive(task_id);
        }
      }
      break;
    }

    case 'task_stream_snapshot': {
      const task_id = payload.task_id as string;
      const content = payload.content as string;
      const run_id = payload.run_id as string | undefined;
      const contentOffset = Number(payload.content_offset);
      const entries = Array.isArray(payload.entries)
        ? (
            payload.entries as Array<{
              id: string;
              content: string;
              startOffset: number;
              endOffset: number;
              complete?: boolean;
            }>
          ).map((entry) => ({
            ...entry,
            complete: entry.complete ?? true,
          }))
        : undefined;
      if (
        !task_id ||
        !content ||
        (run_id && activeTaskRunIds.get(task_id) !== run_id)
      )
        break;
      const existing = store.streamingOutput[task_id] ?? '';
      const existingStart = store.streamingOutputStartOffsets[task_id] ?? 0;
      const incomingStart = Number.isFinite(contentOffset) ? contentOffset : 0;
      const incomingEnd =
        incomingStart + utf8Encoder.encode(content).byteLength;
      const existingEnd =
        existingStart + utf8Encoder.encode(existing).byteLength;
      if (incomingEnd <= existingEnd) break;
      store.setTaskOutput(task_id, content, incomingStart, undefined, entries);
      store.markTaskLive(task_id);
      break;
    }

    case 'task_message': {
      const task_id = payload.task_id as string;
      const project_id = payload.project_id as string;
      if (task_id && project_id) {
        const finishedRunId = store.finishedTaskStreamRunIds[task_id];
        void Promise.resolve(
          qcRef.invalidateQueries(
            { queryKey: queryKeys.messages.all(project_id, task_id) },
            { throwOnError: true },
          ),
        ).then(
          () => {
            if (finishedRunId) {
              useStore
                .getState()
                .markTaskTranscriptReady(task_id, finishedRunId);
            }
          },
          () => {
            // Retain the live fallback until a later refresh succeeds.
          },
        );
      }
      break;
    }

    case 'messages_cleared': {
      const task_id = payload.task_id as string;
      const project_id = payload.project_id as string;
      if (task_id && project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.messages.all(project_id, task_id),
        });
        store.clearOutput(task_id);
      }
      break;
    }

    // A voice message sent to a model that hears audio is transcribed after
    // the run starts; show the transcript on the message already on screen, in
    // the form a reload renders it.
    case 'chat_audio_transcript': {
      const messageId = payload.messageId as string;
      const block = (
        Array.isArray(payload.transcripts) ? payload.transcripts : []
      )
        .filter((text): text is string => typeof text === 'string')
        .map((text) => `[Voice message transcript]: ${text.trim()}`)
        .join('\n\n');
      if (messageId && block) store.setLateAudioTranscript(messageId, block);
      break;
    }

    case 'chat_message': {
      const folder = payload.folder as string;
      const message = payload.message as any;
      const convId = message?.conversation_id;
      invalidateObjectiveChatQueries(payload);
      const messageStreamKey = payload.streamKey as string | undefined;
      if (
        messageStreamKey &&
        convId &&
        message?.role === 'assistant' &&
        typeof message?.content === 'string' &&
        store.activeStreamKeyByConv[convId] === messageStreamKey
      ) {
        const completedContent = completedStreamContent(
          store.chatStreamingOutput[messageStreamKey],
          message.content,
        );
        canonicalMainContentByStreamKey.set(messageStreamKey, completedContent);
        store.setChatOutput(messageStreamKey, completedContent);
      }
      if (
        message?.role === 'user' &&
        typeof message?.id === 'string' &&
        message?.steeringDelivery === 'steered'
      ) {
        store.acknowledgeSteeredChatMessage(message.id);
      }
      if (
        convId &&
        message?.role === 'user' &&
        typeof message?.id === 'string' &&
        message?.steeringDelivery !== 'pending'
      ) {
        const queue = store.queuedPromptsByConv[convId] ?? [];
        const acknowledgedIds = new Set<string>([
          message.id,
          ...(Array.isArray(message.clientSubmissionIds)
            ? message.clientSubmissionIds.filter(
                (id: unknown): id is string => typeof id === 'string',
              )
            : []),
        ]);
        const acknowledgesBackgroundDrain = queue.some(
          (prompt) =>
            prompt.awaitingAcknowledgement &&
            typeof prompt.id === 'string' &&
            acknowledgedIds.has(prompt.id),
        );
        useStore.setState((state) => {
          const current = state.queuedPromptsByConv[convId] ?? [];
          let changed = false;
          const reconciled = current.flatMap<QueuedPrompt>((prompt) => {
            if (!prompt.id || !acknowledgedIds.has(prompt.id)) return [prompt];
            if (prompt.serverOwned || prompt.consumedByServer) return [prompt];
            // Background drains do not inject an optimistic transcript row.
            // The acknowledgement must leave a receipt visible until ChatPage
            // renders the canonical transcript owner.
            if (prompt.awaitingAcknowledgement) {
              changed = true;
              const {
                awaitingAcknowledgement: _,
                serverReleased: _serverReleased,
                ...acknowledged
              } = prompt;
              return [
                {
                  ...acknowledged,
                  serverOwned: true,
                  serverQueueOwner: 'server',
                },
              ];
            }
            if (prompt.serverReleased) return [prompt];
            changed = true;
            return [];
          });
          if (!changed) return state;
          const nextQueues = { ...state.queuedPromptsByConv };
          if (reconciled.length > 0) nextQueues[convId] = reconciled;
          else delete nextQueues[convId];
          return { queuedPromptsByConv: nextQueues };
        });
        if (acknowledgesBackgroundDrain && folder) {
          cacheCanonicalQueuedUserMessage(folder, convId, message);
        }
      }
      const canonicalPersonaMessage = Boolean(
        convId &&
        message?.role === 'assistant' &&
        typeof message?.id === 'string' &&
        isAiPersonaMessage(message),
      );

      // Replace accumulated deltas with the authoritative saved Markdown before
      // the transcript refetch completes. This preserves canonical newlines in
      // the final live frame; once the matching transcript row is available,
      // ChatPage atomically hands rendering to that canonical message. Identity
      // matching prevents an invited persona from overwriting the main
      // participant's stream, and canonical persona rounds do not own a generic
      // stream at all.
      if (
        convId &&
        message?.role === 'assistant' &&
        typeof message?.content === 'string'
      ) {
        const activeStreamKey = store.activeStreamKeyByConv[convId];
        const presentation = activeStreamKey
          ? store.chatStreamPresentation[activeStreamKey]
          : undefined;
        const virtualSenderId = presentation?.virtualSender?.id;
        const messageSenderId =
          typeof message?.senderUserId === 'string'
            ? message.senderUserId
            : typeof message?.agent_name === 'string' &&
                message.agent_name.startsWith('ai-main:')
              ? `ai:${message.agent_name.slice('ai-main:'.length)}`
              : typeof message?.agent_name === 'string' &&
                  message.agent_name.startsWith('ai:')
                ? message.agent_name
                : null;
        // Main follow-ups use identity-bound chat_persona_* rows. Their sender
        // matches the generic run's main persona, but their message lifecycle
        // does not own that older stream slot.
        const hasPersonaStreamEntry =
          canonicalPersonaMessage &&
          personaStreamEntryExists(folder, convId, message.id);
        const ownsGenericStream =
          !hasPersonaStreamEntry &&
          (virtualSenderId
            ? messageSenderId === `ai:${virtualSenderId}`
            : !isAiPersonaMessage(message));
        const streamedContent = activeStreamKey
          ? (store.chatStreamingOutput[activeStreamKey] ?? '')
          : '';
        const canonicalReplacement =
          activeStreamKey &&
          presentation?.canonicalPersonaTurns !== true &&
          ownsGenericStream
            ? canonicalStreamReplacement(streamedContent, message.content)
            : null;
        if (activeStreamKey && canonicalReplacement !== null) {
          store.setChatOutput(activeStreamKey, canonicalReplacement);
        }
        if (activeStreamKey && ownsGenericStream && message.telemetry) {
          store.setChatStreamingTelemetry(
            activeStreamKey,
            message.telemetry as Record<string, any>,
          );
        }
        if (
          activeStreamKey &&
          ownsGenericStream &&
          Array.isArray(message.attachments)
        ) {
          store.setChatStreamingAttachments(
            activeStreamKey,
            message.attachments,
          );
        }
      }

      if (folder) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.conversations.all(folder),
        });
        if (convId) {
          // A new USER message MAY mean the previous turn is over (new prompt),
          // OR it may be a mid-turn injection (e.g. answer submitted to an
          // AskUserQuestion form while the agent is still streaming). Only
          // force-clear when the previous stream is actually completed —
          // otherwise we wipe the in-flight bubble and the user sees the
          // pre-question content vanish before the post-question content
          // re-fills the same bubble.
          if (message.role === 'user') {
            // In-flight steering is rendered against the active stream by the
            // composer. Refetching here would place the canonical user row
            // above that stream before the delivery acknowledgement arrives.
            if (message.steeringDelivery === 'pending') {
              qcRef.invalidateQueries({
                queryKey: queryKeys.projects.statusSummary,
              });
              break;
            }
            // Skip the transcript refetch when this USER message is the one we
            // optimistically injected from the composer. The HTTP response in
            // sendPreparedMessage invalidates the transcript after the agent
            // finishes; invalidating here too would replace the optimistic
            // entry with the server's copy (different `id`, different
            // `created_at` → different React key → the bubble re-mounts),
            // producing a visible layout shift in the message list right after
            // the user sends. Skip for any recent optimistic user message in
            // this conversation — if another tab sent it, the
            // chat_completed refetch on that tab will reconcile.
            const transcriptKey = queryKeys.chatTranscript.all(folder, convId);
            const cached = qcRef.getQueryData<any>(transcriptKey);
            const serverCreatedAt = message?.created_at as string | undefined;
            let hasMatchingOptimistic = false;
            if (cached && serverCreatedAt) {
              const within = (a: string, b: string) =>
                Math.abs(new Date(a).getTime() - new Date(b).getTime()) <
                10_000;
              for (const page of cached.pages ?? []) {
                for (const entry of page.entries ?? []) {
                  if (
                    entry?.type === 'message' &&
                    entry?.role === 'user' &&
                    typeof entry?.created_at === 'string' &&
                    within(entry.created_at, serverCreatedAt)
                  ) {
                    hasMatchingOptimistic = true;
                    break;
                  }
                }
                if (hasMatchingOptimistic) break;
              }
            }
            if (hasMatchingOptimistic) {
              qcRef.invalidateQueries({
                queryKey: queryKeys.projects.statusSummary,
              });
              break;
            }
          }
          // Canonical persona payloads already contain the saved content,
          // identity, and telemetry. Refetching here can resolve with an older
          // transcript snapshot and erase telemetry while consecutive
          // participants finish. The authoritative transcript reconciliation
          // happens on chat_completed.
          if (!canonicalPersonaMessage) {
            qcRef.invalidateQueries({
              queryKey: queryKeys.chatTranscript.all(folder, convId),
            });
          }
        }
      }
      qcRef.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
      if (
        folder &&
        convId &&
        message?.role === 'assistant' &&
        typeof message?.id === 'string' &&
        isAiPersonaMessage(message)
      ) {
        applyCanonicalPersonaMessage(store, folder, convId, message);
      }
      const playback = livePersonaPlaybackContext(
        store,
        convId,
        payload.liveModeSessionId,
      );
      if (
        playback.acceptsPlayback &&
        message?.role === 'assistant' &&
        typeof message?.id === 'string' &&
        isAiPersonaMessage(message)
      ) {
        if (!getLivePersonaRevealState(message.id)) {
          beginLivePersonaReveal(message.id, convId);
          bufferLivePersonaChunk(message.id, String(message.content || ''));
        } else if (typeof message.content === 'string' && message.content) {
          // Keep the voice-paced renderer mounted, but replace its assembled
          // deltas with the canonical Markdown/newlines as soon as they exist.
          replaceLivePersonaBuffer(message.id, message.content);
        }
        pendingPersonaSpeech.set(message.id, {
          messageId: message.id,
          conversationId: convId,
          projectId: folder,
          text:
            typeof message.speechText === 'string'
              ? message.speechText
              : String(message.content || ''),
          voice: message.speechProfile?.voiceId,
          lang: message.speechProfile?.language,
          liveModeSessionId: playback.sessionId!,
        });
      }
      break;
    }

    case 'speech_ready': {
      const messageId = String(payload.messageId || '');
      const pending = pendingPersonaSpeech.get(messageId);
      if (!pending) break;
      pendingPersonaSpeech.delete(messageId);
      // Durable queue v2 owns release and playback for persona messages. The
      // legacy readiness event is synthesis telemetry only; enqueueing here
      // would let a hidden lookahead bypass the server talking-stick order.
      if (
        liveQueueControlledMessageIds.has(messageId) ||
        liveQueueEnabledConversations.has(pending.conversationId)
      )
        break;
      if (
        Capacitor.isNativePlatform() &&
        Capacitor.getPlatform() === 'android'
      ) {
        // Keep the bubble delayed until Media3 reports actual playback start.
        void activateNativeSpeechSession(pending.liveModeSessionId)
          .then(() =>
            enqueueNativeSpeech(
              pending.conversationId,
              messageId,
              pending.liveModeSessionId,
            ),
          )
          .then((queued) => {
            if (!queued) releaseLivePersonaReveal(messageId);
          });
        break;
      }
      const queued = enqueueLiveReply({
        ...pending,
        audioUrl: messageSpeechUrl(
          pending.projectId,
          pending.conversationId,
          messageId,
        ),
      });
      if (!queued) releaseLivePersonaReveal(messageId);
      break;
    }

    case 'speech_failed': {
      const messageId = String(payload.messageId || '');
      const pending = pendingPersonaSpeech.get(messageId);
      if (!pending) break;
      pendingPersonaSpeech.delete(messageId);
      if (
        liveQueueControlledMessageIds.has(messageId) ||
        liveQueueEnabledConversations.has(pending.conversationId)
      )
        break;
      releaseLivePersonaReveal(messageId);
      break;
    }

    case 'persona_live_queue': {
      const folder = String(payload.folder || '');
      const conversationId = String(payload.conversation_id || '');
      const snapshot = payload.snapshot as PersonaLiveQueueSnapshot | undefined;
      if (!folder || !conversationId || snapshot?.protocolVersion !== 2) break;
      const receivedAtMs = performance.now();
      const previousRevision =
        liveQueueRevisionByConversation.get(conversationId) ?? -1;
      if (snapshot.revision < previousRevision) break;
      liveQueueRevisionByConversation.set(conversationId, snapshot.revision);
      const store = useStore.getState();
      const enabled = snapshot.status !== 'off';
      if (enabled) liveQueueEnabledConversations.add(conversationId);
      else liveQueueEnabledConversations.delete(conversationId);
      store.setConversationLiveModeEnabled(conversationId, enabled);
      store.setConversationLiveModeSession(
        conversationId,
        enabled ? snapshot.leaderSessionId : null,
      );
      store.setConversationLiveModeKind(conversationId, snapshot.mode);
      if (qcRef)
        patchPersonaLiveModeStatus(qcRef, conversationId, {
          enabled,
          ownedBySession:
            enabled && snapshot.leaderSessionId === store.liveModeSessionId,
          liveModeSessionId: enabled ? snapshot.leaderSessionId : null,
          liveModeKind: snapshot.mode,
        });
      const watchingQueueConversation = isConversationSelected(
        store,
        conversationId,
      );
      if (
        enabled &&
        watchingQueueConversation &&
        snapshot.leaderSessionId === store.liveModeSessionId
      ) {
        store.setLiveModeEnabled(true);
        store.setLiveModeFocus(conversationId, folder);
      } else if (
        !enabled &&
        store.liveModeFocusedConversationId === conversationId
      ) {
        store.setLiveModeEnabled(false);
        store.setLiveModeFocus(null, null);
      }
      const item = snapshot.current;
      const previousCurrent =
        liveQueueCurrentByConversation.get(conversationId);
      const previousHidden =
        liveQueueHiddenByConversation.get(conversationId) ?? new Set<string>();
      const previousCompleted =
        liveQueueCompletedByConversation.get(conversationId) ??
        new Set<string>();
      const hidden = new Set(snapshot.hiddenMessageIds ?? []);
      const hiddenItems = new Map(
        (snapshot.hiddenItems ?? []).map((hiddenItem) => [
          hiddenItem.messageId,
          hiddenItem,
        ]),
      );
      const cancelled = new Set(snapshot.cancelledMessageIds ?? []);
      const completed = new Set(snapshot.completedMessageIds ?? []);
      const completedItems = new Map(
        (snapshot.completedItems ?? []).map((completedItem) => [
          completedItem.messageId,
          completedItem,
        ]),
      );
      for (const messageId of hidden)
        liveQueueControlledMessageIds.add(messageId);
      if (item) liveQueueControlledMessageIds.add(item.messageId);
      for (const messageId of hidden)
        beginLivePersonaReveal(messageId, conversationId);
      for (const messageId of hidden) {
        const metadata = hiddenItems.get(messageId);
        // Keep lookahead identity and response generation entirely off-screen.
        // The current item is materialized below; a queued item appears only
        // after the server advances playback ownership to it.
        if (messageId !== item?.messageId) {
          updatePersonaStreamEntry(
            folder,
            conversationId,
            messageId,
            () => null,
          );
        }
        if (
          metadata?.state === 'ready' &&
          watchingQueueConversation &&
          !getLiveSpeechState().muted &&
          snapshot.leaderSessionId &&
          !Capacitor.isNativePlatform()
        ) {
          prefetchLiveReply({
            messageId,
            conversationId,
            projectId: folder,
            audioUrl: messageSpeechUrl(folder, conversationId, messageId),
          });
        }
      }
      for (const messageId of previousHidden) {
        if (hidden.has(messageId) || item?.messageId === messageId) continue;
        liveQueueControlledMessageIds.delete(messageId);
        if (cancelled.has(messageId)) {
          // Only an explicit terminal cancellation may remove a persisted
          // lookahead. A throttled/background browser can legitimately skip
          // every snapshot where this message was current and playing.
          clearLivePersonaReveal(messageId);
          pendingLivePersonaStarts.delete(messageId);
          pendingPersonaSpeech.delete(messageId);
          updatePersonaStreamEntry(
            folder,
            conversationId,
            messageId,
            () => null,
          );
        } else {
          // The browser skipped over a completed speaker. Release its cached
          // reveal and reload the canonical transcript instead of deleting it.
          releaseLivePersonaReveal(messageId);
          void refetchTranscriptPreservingPersonas(folder, conversationId);
        }
      }
      liveQueueHiddenByConversation.set(conversationId, hidden);

      // A background browser can receive persona streaming events, creating a
      // local preparing reveal, then miss every queue snapshot where that
      // message is hidden/current. A later snapshot must therefore carry the
      // durable completed set, rather than relying on this browser having seen
      // the preceding queue transition.
      let discoveredCompletedMessage = false;
      for (const messageId of completed) {
        pendingPersonaSpeech.delete(messageId);
        const metadata = completedItems.get(messageId);
        // Completed snapshots are authoritative even when this browser missed
        // the released/playing frames. Materialize the canonical owner before
        // scheduling any refetch so throttled/reconnecting clients retain the
        // monotonic transcript floor synchronously.
        if (metadata) {
          replaceLivePersonaBuffer(
            messageId,
            metadata.content || metadata.text || '',
          );
          updatePersonaStreamEntry(
            folder,
            conversationId,
            messageId,
            (entry) => ({
              ...(entry ?? {
                id: messageId,
                type: 'message',
                role: 'assistant',
                source: 'web',
                conversation_id: conversationId,
              }),
              content:
                metadata.content || metadata.text || entry?.content || '',
              sender_name: entry?.sender_name || metadata.senderName,
              senderUserId:
                entry?.senderUserId || `ai:${metadata.participantId}`,
              agent_name: entry?.agent_name || `ai:${metadata.participantId}`,
              created_at: entry?.created_at || metadata.createdAt,
              emote: entry?.emote ?? metadata.emote,
              telemetry: entry?.telemetry ?? metadata.telemetry,
              streaming: false,
            }),
          );
        }
        releaseLivePersonaReveal(messageId);
        liveQueueControlledMessageIds.delete(messageId);
        if (!previousCompleted.has(messageId))
          discoveredCompletedMessage = true;
      }
      liveQueueCompletedByConversation.set(conversationId, completed);
      if (
        discoveredCompletedMessage &&
        [...completed].some(
          (messageId) =>
            !personaStreamEntryHasContent(folder, conversationId, messageId),
        )
      ) {
        void refetchTranscriptPreservingPersonas(folder, conversationId);
      }

      if (previousCurrent && previousCurrent.messageId !== item?.messageId) {
        // Advancing the server clock is the authoritative end of the previous
        // spoken item. Keep its now-complete transcript visible.
        releaseLivePersonaReveal(previousCurrent.messageId);
        liveQueueControlledMessageIds.delete(previousCurrent.messageId);
      }
      if (item)
        liveQueueCurrentByConversation.set(conversationId, {
          messageId: item.messageId,
          state: item.state,
        });
      else liveQueueCurrentByConversation.delete(conversationId);
      if (item && !['completed', 'cancelled', 'failed'].includes(item.state)) {
        presentedLivePersonaByConversation.set(conversationId, item.messageId);
      } else {
        presentedLivePersonaByConversation.delete(conversationId);
      }

      if (!item) break;
      const playbackVisible =
        item.state === 'released' || item.state === 'playing';
      if (
        !playbackVisible &&
        item.state !== 'completed' &&
        item.state !== 'cancelled' &&
        item.state !== 'failed'
      ) {
        // Current generation/synthesis/ready states retain the same owner,
        // but response text stays hidden until voice playback starts.
        beginLivePersonaReveal(item.messageId, conversationId);
        if (item.state === 'generating')
          markLivePersonaThinking(item.messageId);
        else markLivePersonaSynthesizing(item.messageId);
        updatePersonaStreamEntry(
          folder,
          conversationId,
          item.messageId,
          (entry) => ({
            ...(entry ?? {
              id: item.messageId,
              type: 'message',
              role: 'assistant',
              source: 'web',
              conversation_id: conversationId,
            }),
            content: '',
            sender_name: entry?.sender_name || item.senderName || undefined,
            senderUserId: entry?.senderUserId || `ai:${item.participantId}`,
            agent_name: entry?.agent_name || `ai:${item.participantId}`,
            created_at:
              entry?.created_at || item.createdAt || snapshot.serverNow,
            emote: entry?.emote ?? item.emote,
            telemetry: entry?.telemetry ?? item.telemetry,
            streaming: true,
          }),
        );
      }
      if (item.state === 'released' || item.state === 'playing') {
        pendingLivePersonaStarts.delete(item.messageId);
        beginLivePersonaReveal(item.messageId, conversationId);
        if (item.content)
          replaceLivePersonaBuffer(item.messageId, item.content);
        // Lookahead messages are deliberately not broadcast as chat_message.
        // Materialize a released item directly from the authoritative queue
        // snapshot so its audio and bubble cannot diverge while the transcript
        // endpoint is still catching up.
        updatePersonaStreamEntry(
          folder,
          conversationId,
          item.messageId,
          (entry) => ({
            ...(entry ?? {
              id: item.messageId,
              type: 'message',
              role: 'assistant',
              source: 'web',
              conversation_id: conversationId,
            }),
            // The queue snapshot resolves from the saved canonical message and
            // preserves Markdown/newlines. Prefer it over chunk-assembled cache
            // text, which may have provider-specific delta formatting.
            content: item.content || entry?.content || item.text,
            sender_name: entry?.sender_name || item.senderName,
            senderUserId: entry?.senderUserId || `ai:${item.participantId}`,
            agent_name: entry?.agent_name || `ai:${item.participantId}`,
            created_at:
              entry?.created_at || item.createdAt || snapshot.serverNow,
            emote: entry?.emote ?? item.emote,
            telemetry: entry?.telemetry ?? item.telemetry,
            streaming: false,
          }),
        );
      }
      if (
        item.state === 'completed' ||
        item.state === 'cancelled' ||
        item.state === 'failed'
      ) {
        if (item.state === 'completed') {
          const completedMetadata = completedItems.get(item.messageId);
          replaceLivePersonaBuffer(
            item.messageId,
            completedMetadata?.content ||
              completedMetadata?.text ||
              item.content ||
              item.text ||
              '',
          );
          updatePersonaStreamEntry(
            folder,
            conversationId,
            item.messageId,
            (entry) => ({
              ...(entry ?? {
                id: item.messageId,
                type: 'message',
                role: 'assistant',
                source: 'web',
                conversation_id: conversationId,
              }),
              content:
                completedMetadata?.content ||
                completedMetadata?.text ||
                item.content ||
                item.text ||
                entry?.content ||
                '',
              sender_name:
                completedMetadata?.senderName ||
                entry?.sender_name ||
                item.senderName,
              senderUserId:
                entry?.senderUserId ||
                (completedMetadata
                  ? `ai:${completedMetadata.participantId}`
                  : `ai:${item.participantId}`),
              agent_name:
                entry?.agent_name ||
                (completedMetadata
                  ? `ai:${completedMetadata.participantId}`
                  : `ai:${item.participantId}`),
              created_at:
                entry?.created_at ||
                completedMetadata?.createdAt ||
                item.createdAt ||
                snapshot.serverNow,
              emote: entry?.emote ?? completedMetadata?.emote ?? item.emote,
              telemetry:
                entry?.telemetry ??
                completedMetadata?.telemetry ??
                item.telemetry,
              streaming: false,
            }),
          );
        }
        releaseLivePersonaReveal(item.messageId);
        liveQueueControlledMessageIds.delete(item.messageId);
        pendingPersonaSpeech.delete(item.messageId);
        break;
      }
      const watching = isConversationSelected(store, conversationId);
      if (getLiveSpeechState().muted) {
        // Muted playback never consumes the buffered speech text.
        pendingPersonaSpeech.delete(item.messageId);
        break;
      }
      if (!watching || !snapshot.leaderSessionId) break;
      if (item.state !== 'released' && item.state !== 'playing') break;
      beginLivePersonaReveal(item.messageId, conversationId);
      const pending = pendingPersonaSpeech.get(item.messageId);
      const text = item.text || pending?.text || '';
      if (text && !getLivePersonaRevealState(item.messageId)?.bufferedText)
        bufferLivePersonaChunk(item.messageId, text);
      if (item.state === 'playing' && Capacitor.getPlatform() === 'android') {
        // Native Media3 playback has start/end events but no WebView progress
        // frames. Once the server confirms playback, show the canonical text
        // instead of leaving Markdown at reveal progress zero.
        releaseLivePersonaReveal(item.messageId);
      }
      // Resume from the server's own clock: the age of the item at snapshot
      // time plus the local time elapsed since the snapshot arrived. Never
      // compare the server's startedAt with the client's Date.now().
      const snapshotAgeMs =
        Date.parse(snapshot.serverNow) - Date.parse(item.startedAt ?? '');
      const offsetSeconds =
        item.state === 'playing' && Number.isFinite(snapshotAgeMs)
          ? Math.max(
              0,
              (snapshotAgeMs + performance.now() - receivedAtMs) / 1000,
            )
          : 0;
      if (
        Capacitor.isNativePlatform() &&
        Capacitor.getPlatform() === 'android'
      ) {
        void activateNativeSpeechSession(snapshot.leaderSessionId).then(() =>
          enqueueNativeSpeech(
            conversationId,
            item.messageId,
            snapshot.leaderSessionId!,
          ),
        );
      } else {
        enqueueLiveReply({
          messageId: item.messageId,
          conversationId,
          projectId: folder,
          text,
          audioUrl: messageSpeechUrl(folder, conversationId, item.messageId),
          startOffsetSeconds: offsetSeconds,
          onStarted:
            item.state === 'released'
              ? () => {
                  void startPersonaLiveQueueItem(
                    folder,
                    conversationId,
                    item.id,
                    snapshot.runId,
                    snapshot.leaderSessionId!,
                  );
                }
              : undefined,
        });
      }
      pendingPersonaSpeech.delete(item.messageId);
      break;
    }

    case 'chat_persona_started': {
      const folder = payload.folder as string;
      const conversationId = payload.conversation_id as string;
      const message = payload.message as any;
      if (!folder || !conversationId || !message?.id) break;
      const store = useStore.getState();
      // Persona activity belongs to the outer conversation run. Restore the
      // running flag if this tab reconnected or a stale older completion was
      // observed, so the user always retains a working Stop control.
      store.setChatRunning(conversationId, true);
      const playback = livePersonaPlaybackContext(
        store,
        conversationId,
        payload.liveModeSessionId,
      );
      const voiceDelayed =
        payload.voiceDelayed === true || playback.acceptsPlayback;
      if (voiceDelayed && !getLiveSpeechState().muted) {
        beginLivePersonaReveal(message.id, conversationId);
      }
      const currentLiveQueueItem =
        liveQueueCurrentByConversation.get(conversationId);
      const currentPresentedMessageId =
        currentLiveQueueItem &&
        !['completed', 'cancelled', 'failed'].includes(
          currentLiveQueueItem.state,
        )
          ? currentLiveQueueItem.messageId
          : presentedLivePersonaByConversation.get(conversationId);
      const isQueuedLookahead =
        voiceDelayed &&
        payload.hiddenUntilPlayback === true &&
        Boolean(
          currentPresentedMessageId && currentPresentedMessageId !== message.id,
        );
      if (isQueuedLookahead) {
        pendingLivePersonaStarts.set(message.id, message);
        break;
      }
      if (voiceDelayed) {
        presentedLivePersonaByConversation.set(conversationId, message.id);
        markLivePersonaThinking(message.id);
      }
      if (store.liveModeKindByConversation[conversationId] === 'work') {
        pendingWorkPersonaStarts.set(message.id, message);
        break;
      }
      updatePersonaStreamEntry(folder, conversationId, message.id, (entry) => {
        // Replayed start events must not erase an already-canonical message.
        if (entry && entry.streaming !== true) return entry;
        return {
          ...message,
          type: 'message',
          role: 'assistant',
          // A reconnect replays the start event for the active persona; a
          // voice-delayed row may already hold its reply text. Keep it so the
          // finished reply bubble does not blank out.
          content:
            entry &&
            typeof entry.content === 'string' &&
            entry.content.length > 0
              ? entry.content
              : '',
          streaming: true,
        };
      });
      break;
    }

    case 'chat_persona_output': {
      const folder = payload.folder as string;
      const conversationId = payload.conversation_id as string;
      const messageId = payload.messageId as string;
      const content = payload.content as string;
      const contentOffset = payload.contentOffset as number | undefined;
      const isSnapshot = payload.snapshot === true;
      if (!folder || !conversationId || !messageId || !content) break;
      const store = useStore.getState();
      const playback = livePersonaPlaybackContext(
        store,
        conversationId,
        payload.liveModeSessionId,
      );
      const shouldDelayVoice =
        payload.voiceDelayed === true || playback.acceptsPlayback;
      if (shouldDelayVoice && !getLivePersonaRevealState(messageId)) {
        beginLivePersonaReveal(messageId, conversationId);
      }
      const revealState = getLivePersonaRevealState(messageId);
      const voiceDelayed = revealState
        ? replaceLivePersonaBuffer(
            messageId,
            reconcilePersonaChunk(
              messageId,
              revealState.bufferedText,
              content,
              contentOffset,
              isSnapshot,
            ),
          )
        : bufferLivePersonaChunk(messageId, content);
      if (pendingLivePersonaStarts.has(messageId)) break;
      const pendingStart = pendingWorkPersonaStarts.get(messageId);
      updatePersonaStreamEntry(folder, conversationId, messageId, (entry) => {
        // A canonical chat_message can overtake the final streamed event on a
        // busy socket/refetch. It is complete and must never receive deltas.
        if (entry && entry.streaming !== true) return entry;
        return {
          ...(entry ??
            pendingStart ?? {
              id: messageId,
              type: 'message',
              role: 'assistant',
              agent_name: payload.agent_name,
              sender_name: payload.sender_name,
              senderUserId: payload.senderUserId,
              source: 'web',
              conversation_id: conversationId,
              created_at: payload.created_at,
            }),
          // A deferred work-mode start message carries no transcript `type`.
          // Without it the canonical message and finish event cannot find this
          // row, so it would stay streaming next to the saved reply.
          type: 'message',
          role: 'assistant',
          content: voiceDelayed
            ? (entry?.content ?? '')
            : reconcilePersonaChunk(
                messageId,
                entry?.content ?? '',
                content,
                contentOffset,
                isSnapshot,
              ),
          streaming: true,
        };
      });
      pendingWorkPersonaStarts.delete(messageId);
      if (payload.failed || payload.skipped)
        pendingLivePersonaStarts.delete(messageId);
      break;
    }

    case 'chat_persona_finished': {
      const folder = payload.folder as string;
      const conversationId = payload.conversation_id as string;
      const messageId = payload.messageId as string;
      if (!folder || !conversationId || !messageId) break;
      personaBaseOffsetByMessageId.delete(messageId);
      const store = useStore.getState();
      const canonicalMessage = payload.message as any;
      const completionTelemetry = (canonicalMessage?.telemetry ??
        payload.telemetry) as Record<string, unknown> | null | undefined;
      pendingWorkPersonaStarts.delete(messageId);
      if (payload.failed || payload.skipped) {
        releaseLivePersonaReveal(messageId);
        updatePersonaStreamEntry(folder, conversationId, messageId, () => null);
        clearLivePersonaReveal(messageId);
      } else {
        // The streamed placeholder is kept in the transcript cache until the
        // canonical chat_message/refetch arrives. Mark it complete immediately
        // so the telemetry bar does not keep pulsing on finished persona
        // replies (especially when several participants finish in sequence).
        const awaitingPersonaPlayback =
          store.liveModeEnabledByConversation[conversationId] === true &&
          store.liveModeKindByConversation[conversationId] === 'personas' &&
          Boolean(getLivePersonaRevealState(messageId));
        const hasCanonicalMessage = Boolean(
          canonicalMessage?.id === messageId &&
          canonicalMessage?.role === 'assistant' &&
          isAiPersonaMessage(canonicalMessage),
        );
        if (hasCanonicalMessage) {
          const completedMessage = completionTelemetry
            ? { ...canonicalMessage, telemetry: completionTelemetry }
            : canonicalMessage;
          rememberCanonicalPersonaMessage(
            folder,
            conversationId,
            completedMessage,
          );
          updatePersonaStreamEntry(
            folder,
            conversationId,
            messageId,
            (entry) => ({
              ...(entry ?? {}),
              ...completedMessage,
              type: 'message',
              role: 'assistant',
              content:
                entry &&
                (awaitingPersonaPlayback ||
                  entry.canonicalMessageId === completedMessage.id)
                  ? entry.content
                  : completedStreamContent(
                      entry?.content,
                      completedMessage.content,
                    ),
              streaming: awaitingPersonaPlayback
                ? entry?.streaming !== false
                : false,
            }),
          );
        } else if (completionTelemetry) {
          updatePersonaStreamEntry(
            folder,
            conversationId,
            messageId,
            (entry) =>
              entry ? { ...entry, telemetry: completionTelemetry } : entry,
          );
        }
        updatePersonaStreamEntry(folder, conversationId, messageId, (entry) =>
          entry
            ? {
                ...entry,
                streaming: awaitingPersonaPlayback ? entry.streaming : false,
              }
            : entry,
        );
        if (!hasCanonicalMessage) {
          const completedEntry = personaStreamEntry(
            folder,
            conversationId,
            messageId,
          );
          if (completedEntry) {
            rememberCanonicalPersonaMessage(folder, conversationId, {
              ...completedEntry,
              streaming: awaitingPersonaPlayback
                ? completedEntry.streaming
                : false,
            });
          }
        }
        // Manual persona rounds keep every completed row in the local cache
        // until chat_completed performs one authoritative refetch. An
        // intermediate refetch can resolve after the next speaker starts and
        // temporarily replace that speaker's identity/placeholder.
        if (
          !hasCanonicalMessage &&
          !shouldDeferCanonicalTranscriptRefetch(store, conversationId)
        ) {
          void refetchTranscriptPreservingPersonas(folder, conversationId);
        }
      }
      break;
    }

    case 'conversations_changed': {
      const folder = payload.folder as string;
      if (folder) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.conversations.all(folder),
        });
        qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
      }
      // Emitted after the response is persisted: refresh the objective card too.
      invalidateObjectiveChatQueries(payload, true);
      break;
    }

    case 'persona_live_mode': {
      const conversationId = String(payload.conversation_id || '');
      const enabled = payload.enabled === true;
      const ownerSessionId =
        typeof payload.liveModeSessionId === 'string'
          ? payload.liveModeSessionId
          : null;
      const liveModeKind =
        payload.liveModeKind === 'work' ? 'work' : 'personas';
      if (!conversationId) break;
      const store = useStore.getState();
      const previousSessionId =
        store.liveModeSessionByConversation[conversationId] ?? null;
      if (
        !enabled ||
        (previousSessionId && ownerSessionId !== previousSessionId)
      ) {
        presentedLivePersonaByConversation.delete(conversationId);
      }
      const watchingConversation = isConversationSelected(
        store,
        conversationId,
      );
      if (
        watchingConversation &&
        previousSessionId &&
        (!enabled || (ownerSessionId && ownerSessionId !== previousSessionId))
      ) {
        void cutOffLiveSpeechForServerStop();
        void stopNativeSpeech(previousSessionId);
      }
      store.setConversationLiveModeEnabled(conversationId, enabled);
      store.setConversationLiveModeSession(
        conversationId,
        enabled ? ownerSessionId : null,
      );
      store.setConversationLiveModeKind(conversationId, liveModeKind);
      if (qcRef)
        patchPersonaLiveModeStatus(qcRef, conversationId, {
          enabled,
          ownedBySession: enabled && ownerSessionId === store.liveModeSessionId,
          liveModeSessionId: enabled ? ownerSessionId : null,
          liveModeKind,
        });
      if (enabled && ownerSessionId === store.liveModeSessionId) {
        // The enable endpoint can spend time preparing resume audio after it
        // publishes ownership. Activate delay handling from this event so the
        // first persona cannot escape as ordinary streamed text.
        store.setLiveModeEnabled(true);
        store.setLiveModeFocus(conversationId, String(payload.folder || ''));
      }
      const locallyFocused =
        store.liveModeEnabled &&
        store.liveModeFocusedConversationId === conversationId;
      if (
        locallyFocused &&
        (!enabled || ownerSessionId !== store.liveModeSessionId)
      ) {
        void cutOffLiveSpeechForServerStop();
        void stopNativeSpeech(store.liveModeSessionId);
        store.setLiveModeEnabled(false);
        store.setLiveModeFocus(null, null);
      }
      break;
    }

    case 'live_activity':
    case 'live_activity_snapshot': {
      const activities =
        event.type === 'live_activity_snapshot'
          ? ((payload as { activities?: unknown[] }).activities ?? [])
          : [payload];
      for (const raw of activities) {
        const activity = raw as Record<string, unknown>;
        const conversationId = activity.conversation_id as string | undefined;
        if (!conversationId) continue;
        store.mergeLiveModeActivity({
          conversationId,
          projectId: activity.folder as string | undefined,
          projectName: activity.folder as string | undefined,
          title: (activity.title as string | null | undefined) ?? undefined,
          preview: (activity.preview as string | null | undefined) ?? undefined,
          state: activity.state as string | undefined,
          status: (activity.status as string | null | undefined) ?? null,
          updatedAt: activity.updated_at as string | undefined,
        });
        if (
          event.type === 'live_activity' &&
          store.liveModeKindByConversation[conversationId] === 'work' &&
          store.liveModeEnabledByConversation[conversationId] === true &&
          isConversationSelected(store, conversationId)
        ) {
          const speech = speechForLiveActivity(
            {
              conversationId,
              title: (activity.title as string | null | undefined) || '',
              state: (activity.state as string | undefined) || 'idle',
              status: (activity.status as string | null | undefined) ?? null,
              completionSummary:
                (activity.completion_summary as string | null | undefined) ??
                null,
            },
            store.liveModeFocusedConversationId,
            getLiveSpeechState().announceCompletions,
          );
          // Work narration never owns the talking stick. Preserve every short
          // marker in a client-side FIFO and let the server continue rotating
          // participants independently of local synthesis/playback timing.
          if (speech)
            enqueueLiveSpeech(
              conversationId,
              speech.text,
              speech.priority,
              'registry',
              'fifo',
              {
                voice:
                  typeof activity.speechVoice === 'string'
                    ? activity.speechVoice
                    : undefined,
                lang:
                  typeof activity.speechLang === 'string'
                    ? activity.speechLang
                    : undefined,
              },
            );
        }
      }
      break;
    }

    case 'artifacts_changed': {
      const folder = payload.folder as string;
      if (folder) invalidateGroupExplorerQueries(qcRef, folder);
      break;
    }

    case 'runtime_catalog_changed': {
      qcRef.invalidateQueries({ queryKey: queryKeys.runtimeCatalog });
      qcRef.invalidateQueries({ queryKey: queryKeys.chatAgents });
      break;
    }

    case 'shells_changed': {
      const folder = payload.folder as string;
      if (folder)
        qcRef.invalidateQueries({ queryKey: ['bashTab', 'shells', folder] });
      break;
    }

    case 'sandbox_state_changed': {
      qcRef.invalidateQueries({ queryKey: ['sandbox'] });
      qcRef.invalidateQueries({ queryKey: queryKeys.publishedApps.all });
      break;
    }

    case 'projects_changed': {
      useStore.getState().bumpProjectsChangeSeq();
      qcRef.invalidateQueries({ queryKey: queryKeys.projects.all });
      qcRef.invalidateQueries({ queryKey: queryKeys.publishedApps.all });
      break;
    }

    case 'group_files_changed': {
      const folder = payload.folder as string;
      if (folder) {
        qcRef.invalidateQueries({ queryKey: queryKeys.groupFiles.all(folder) });
        invalidateGroupExplorerQueries(qcRef, folder);
      }
      break;
    }

    case 'objective_created':
    case 'objective_updated':
    case 'objective_deleted': {
      const project_id = payload.project_id as string;
      if (project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.objectives.all(project_id),
        });
        qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
      }
      if (event.type !== 'objective_deleted') {
        const objective = payload.objective as
          | Record<string, unknown>
          | undefined;
        const objective_id = objective?.id as string | undefined;
        if (project_id && objective_id) {
          qcRef.invalidateQueries({
            queryKey: queryKeys.objectives.detail(project_id, objective_id),
          });
          store.bumpDashboardRefresh(objective_id);
        }
      }
      break;
    }

    case 'objective_dashboard_updated': {
      const objective_id = payload.objective_id as string;
      if (objective_id) {
        store.bumpDashboardRefresh(objective_id);
      }
      break;
    }

    case 'run_stalled_warning': {
      const runId = payload.runId as string | undefined;
      const conversationId = payload.conversationId as string | undefined;
      const graceMs = (payload.graceMs as number | undefined) ?? 30_000;
      if (conversationId && runId) {
        store.setStalledWarning(conversationId, {
          runId,
          graceMs,
          warnedAt: Date.now(),
        });
      }
      break;
    }

    case 'run_stall_cleared': {
      const conversationId = payload.conversationId as string | undefined;
      if (conversationId) {
        store.clearStalledWarning(conversationId);
      }
      break;
    }

    case 'run_killed_stalled': {
      const taskId = payload.taskId as string | undefined;
      const conversationId = payload.conversationId as string | undefined;
      if (taskId) {
        store.markTaskStalled(taskId);
        store.unmarkTaskLive(taskId);
      }
      if (conversationId) {
        store.clearStalledWarning(conversationId);
      }
      break;
    }

    case 'chat_started': {
      const streamKey = payload.streamKey as string;
      const folder = payload.folder as string;
      const conversation_id = payload.conversation_id as string | undefined;
      if (conversation_id) {
        store.setMemoryPreparing(
          conversation_id,
          payload.memoryPreparing === true,
        );
      }
      const completed = streamKey
        ? (store.chatStreamingCompleted[streamKey] ?? false)
        : false;
      const existing = streamKey
        ? (store.chatStreamingOutput[streamKey] ?? '')
        : '';
      if (streamKey) canonicalMainContentByStreamKey.delete(streamKey);
      // Reset only for a genuinely new run. WS reconnect replays reuse the
      // same streamKey — clearing would blank the bubble and make the snapshot
      // look like a fresh stream (re-parse + scroll animation).
      if (streamKey && !existing && !completed) {
        store.clearChatOutput(streamKey);
        chatStreamBaseOffsetByKey.delete(streamKey);
      }
      if (streamKey) {
        const rawSender = payload.virtualSender as
          | Record<string, unknown>
          | null
          | undefined;
        const hasVirtualSender =
          rawSender === null ||
          (rawSender &&
            typeof rawSender.id === 'string' &&
            typeof rawSender.name === 'string' &&
            typeof rawSender.identity === 'string');
        store.setChatStreamPresentation(streamKey, {
          ...(typeof payload.personaDriven === 'boolean'
            ? { personaDriven: payload.personaDriven }
            : {}),
          ...(typeof payload.canonicalPersonaTurns === 'boolean'
            ? { canonicalPersonaTurns: payload.canonicalPersonaTurns }
            : {}),
          ...(hasVirtualSender
            ? {
                virtualSender:
                  rawSender === null
                    ? null
                    : {
                        id: rawSender.id as string,
                        name: rawSender.name as string,
                        identity: rawSender.identity as string,
                        avatarUrl:
                          typeof rawSender.avatarUrl === 'string'
                            ? rawSender.avatarUrl
                            : null,
                      },
              }
            : {}),
        });
      }
      // Per-run UUID stream keys: each run has its own unique key so clearing
      // here does not wipe a still-visible previous run (different key).
      if (conversation_id && streamKey) {
        // Save the old active key as prev so the UI can keep showing it while
        // the new run hasn't produced any output yet.
        const prevKey = store.activeStreamKeyByConv?.[conversation_id];
        if (prevKey && prevKey !== streamKey) {
          store.setPrevStreamKeyForConv(conversation_id, prevKey);
        }
        store.setActiveStreamKeyForConv(conversation_id, streamKey);
      }
      // Store conversation_id (not the UUID) for auto-navigation of new conversations
      // (the All-Messages view uses this to navigate before the HTTP response returns).
      if (folder && conversation_id)
        store.setPendingStreamKey(chatViewKey(payload), conversation_id);
      if (conversation_id && !completed)
        store.setChatRunning(conversation_id, true);
      qcRef.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
      invalidateAttention();
      if (folder) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.conversations.all(folder),
        });
      }
      break;
    }

    case 'memory_capsule_ready': {
      const conversationId = payload.conversation_id as string | undefined;
      const level = payload.level as MemoryContextLevel | undefined;
      if (conversationId && level) {
        store.setMemoryCapsule(conversationId, {
          level,
          capsule: typeof payload.capsule === 'string' ? payload.capsule : '',
        });
      }
      break;
    }

    case 'chat_output': {
      const streamKey = payload.streamKey as string;
      const content = payload.content as string;
      const contentOffset = payload.contentOffset as number | undefined;
      const conversation_id = payload.conversation_id as string | undefined;
      if (streamKey && store.chatStreamingCompleted[streamKey]) break;
      if (streamKey && content) {
        const existing = store.chatStreamingOutput[streamKey] ?? '';
        const reconciled = reconcileChatStreamChunk(
          existing,
          content,
          contentOffset,
          chatStreamBaseOffsetByKey.get(streamKey),
        );
        if (reconciled === existing) break;
        // Defensive recovery: if chat_started was missed (or arrived after the
        // first chunk), bind the conversation to this streamKey so streaming
        // still renders in brand-new conversations.
        if (
          conversation_id &&
          !store.activeStreamKeyByConv?.[conversation_id]
        ) {
          store.setActiveStreamKeyForConv(conversation_id, streamKey);
          store.setChatRunning(conversation_id, true);
        }
        store.setChatOutput(streamKey, reconciled);
      }
      break;
    }

    case 'chat_background_tasks': {
      const conversation_id = payload.conversation_id as string | undefined;
      const tasks = payload.tasks;
      if (conversation_id && Array.isArray(tasks)) {
        store.setBackgroundTasks(conversation_id, tasks as BackgroundTask[]);
      }
      break;
    }

    case 'chat_stream_snapshot': {
      const streamKey = payload.streamKey as string;
      const content = payload.content as string;
      const conversation_id = payload.conversation_id as string | undefined;
      const contentOffset = Number(payload.contentOffset);
      if (!streamKey || !content) break;
      const existing = store.chatStreamingOutput[streamKey] ?? '';
      const baseOffset =
        Number.isInteger(contentOffset) && contentOffset > 0
          ? contentOffset
          : 0;
      if (baseOffset) chatStreamBaseOffsetByKey.set(streamKey, baseOffset);
      else chatStreamBaseOffsetByKey.delete(streamKey);
      if (existing === content) break;
      if (conversation_id && !store.activeStreamKeyByConv?.[conversation_id]) {
        store.setActiveStreamKeyForConv(conversation_id, streamKey);
        store.setChatRunning(conversation_id, true);
      }
      store.setChatOutput(streamKey, content);
      break;
    }

    case 'chat_replay_complete': {
      const activeConversationIds = new Set(
        Array.isArray(payload.activeConversationIds)
          ? payload.activeConversationIds.filter(
              (id): id is string => typeof id === 'string',
            )
          : [],
      );
      // Replayed chat_started frames have already rebound active owners. Any
      // remaining local owner represents a run that completed while this
      // client was unable to receive events. A run that both started and
      // completed while disconnected left no running owner, yet ChatPage still
      // holds send ownership of its open conversation until a completion that
      // will never arrive. Retire open conversations without a completed
      // stream too, so the composer and its queued prompts are released.
      const openConversationIds = Object.values(
        store.activeConvByProject,
      ).filter((conversationId): conversationId is string => {
        if (!conversationId) return false;
        const streamKey = store.activeStreamKeyByConv[conversationId];
        return !streamKey || !store.chatStreamingCompleted[streamKey];
      });
      for (const conversationId of new Set([
        ...Object.keys(store.chatRunningByConv),
        ...openConversationIds,
      ])) {
        if (!activeConversationIds.has(conversationId)) {
          store.retireChatStreamForConv(conversationId);
        }
      }
      void Promise.all([
        qcRef.refetchQueries({ queryKey: ['chatTranscript'] }),
        qcRef.refetchQueries({ queryKey: ['conversations'] }),
        qcRef.refetchQueries({ queryKey: ['objectiveConversations'] }),
      ]);
      break;
    }

    case 'chat_completed': {
      const folder = payload.folder as string;
      const streamKey = payload.streamKey as string;
      // Invalidate transcript + conversations so the UI reloads from JSONL.
      const convId = payload.conversation_id as string | undefined;
      applyQueuedPromptReceipts(payload);
      const currentStreamKey = convId
        ? store.activeStreamKeyByConv[convId]
        : undefined;
      const completionMatchesCurrent =
        !convId ||
        completionOwnsConversationLifecycle({
          eventStreamKey: streamKey,
          currentStreamKey,
          currentStreamCompleted: currentStreamKey
            ? !!store.chatStreamingCompleted[currentStreamKey]
            : false,
          hasQueuedPrompts: convId
            ? (store.queuedPromptsByConv[convId]?.length ?? 0) > 0
            : false,
        });
      let transcriptHandoff: Promise<void> | undefined;
      if (folder) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.conversations.all(folder),
        });
        qcRef.invalidateQueries({ queryKey: queryKeys.attention.all });
        qcRef.invalidateQueries({ queryKey: queryKeys.projects.statusSummary });
        invalidateObjectiveChatQueries(payload);
        if (convId) {
          // Refetch (not just invalidate) so the saved assistant message appears
          // immediately when the HTTP POST is still in flight.
          transcriptHandoff = refetchTranscriptPreservingPersonas(
            folder,
            convId,
            true,
          );
        }
      }
      // Mark the stream as completed so the live bubble can render its final
      // canonicalized frame until the matching transcript row is available.
      const resolvedStreamKey =
        streamKey || (convId ? store.activeStreamKeyByConv[convId] : undefined);
      if (resolvedStreamKey) {
        const canonicalMainContent =
          canonicalMainContentByStreamKey.get(resolvedStreamKey);
        if (canonicalMainContent !== undefined) {
          store.setChatOutput(resolvedStreamKey, canonicalMainContent);
          canonicalMainContentByStreamKey.delete(resolvedStreamKey);
        }
        if (payload.telemetry) {
          console.log(
            '[WS] Received telemetry for',
            resolvedStreamKey,
            payload.telemetry,
          );
          store.setChatStreamingTelemetry(
            resolvedStreamKey,
            payload.telemetry as Record<string, any>,
          );
        } else if (streamKey) {
          console.warn('[WS] chat_completed arrived without telemetry');
        }
        // Commit telemetry first so the first completed frame already has its
        // final footer. Marking completion first briefly exposed actions with
        // no metrics and left canonical-stream dedup dependent on a refetch.
        store.markChatOutputCompleted(resolvedStreamKey);
        if (transcriptHandoff) {
          void transcriptHandoff
            .then(() => {
              const current = useStore.getState();
              if (!current.chatStreamingCompleted[resolvedStreamKey]) return;
              // The persisted transcript now owns the completed response.
              // Keep the completion marker so a late output frame is rejected.
              current.setChatOutput(resolvedStreamKey, '');
            })
            .catch(() => {
              // Retain the completed live buffer when canonical reload fails.
            });
        }
      }
      // Clear the pending key so the All-Messages view doesn't show a stale
      // completed bubble after the stream finishes. The bubble is still visible
      // when viewing the specific conversation (activeConvId takes priority).
      if (folder && completionMatchesCurrent) {
        store.clearPendingStreamKey(chatViewKey(payload));
      }
      const completedConvId = payload.conversation_id as string | undefined;
      if (completedConvId && completionMatchesCurrent) {
        store.setMemoryPreparing(completedConvId, false);
        store.setChatRunning(completedConvId, false);
        store.clearStalledWarning(completedConvId);
        store.setBackgroundTasks(completedConvId, []);

        // Queue draining must not depend on ChatPage (or this conversation)
        // being open. The socket remains mounted across project/board routes.
        void flushQueuedPromptsAfterCompletion(payload);

        // Keep the completion unread until the user explicitly opens or
        // switches to the conversation. The finished state is also used by
        // the objective card and project sidebar, so auto-marking the active
        // conversation here would hide all three completion indicators.
        if (folder) {
          qcRef?.invalidateQueries({
            queryKey: queryKeys.conversations.all(folder),
          });
        }
        invalidateObjectiveChatQueries(payload);
        qcRef?.invalidateQueries({
          queryKey: queryKeys.projects.statusSummary,
        });
      }
      break;
    }

    case 'dataset_task_updated': {
      const project_id = payload.project_id as string | undefined;
      if (project_id) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.datasetTasks.all(project_id),
        });
      }
      break;
    }

    case 'sandbox_status': {
      const {
        action,
        instance: sbInstance,
        group: sandboxGroup,
        error: sbError,
      } = payload as {
        action?: string;
        instance?: string;
        group?: string;
        error?: string;
      };
      const { setRestartingSandbox } = useStore.getState();
      if (action?.startsWith('restart')) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.sandbox.restartPending(),
        });
      }
      if (action === 'ssh_changed') {
        qcRef.invalidateQueries({ queryKey: ['sandbox'] });
      }
      if (action === 'worktree_removed' && sandboxGroup) {
        qcRef.invalidateQueries({
          queryKey: queryKeys.conversations.all(sandboxGroup),
        });
      }
      if (action === 'restarting' && sbInstance) {
        // The completion event refreshes runtime state. Refetching here only
        // observes the sandbox mid-restart and amplifies traffic when several
        // stacks are restarted in succession.
        setRestartingSandbox(sbInstance, true);
      } else if (
        action === 'restart_pending' ||
        action === 'restart_pending_cancelled'
      ) {
        // Handled by the restart-pending invalidation above; the sandbox
        // itself is unchanged until the restart actually starts.
      } else if (action === 'stopped' && sbInstance) {
        qcRef.invalidateQueries({ queryKey: ['sandbox', 'status'] });
        qcRef.invalidateQueries({ queryKey: ['bashTab', 'shells'] });
        // The global sandbox list may be backed by CarapaBox's polling cache.
        // Remove the stopped instance immediately instead of rendering its
        // stale services until that cache catches up.
        const withoutStoppedInstance = (
          instances: SandboxInstance[] | undefined,
        ) =>
          instances?.filter(
            (item) =>
              item.name !== sbInstance && !item.name.endsWith(`-${sbInstance}`),
          );
        qcRef.setQueryData(queryKeys.sandbox.ps, withoutStoppedInstance);
        qcRef.setQueryData(queryKeys.sandbox.instancePs(sbInstance), []);
      } else if (action === 'restart_required' && sbInstance) {
        // Mount/workspace settings changed while the sandbox had active runs,
        // so the board could not restart it automatically.
        toast.warning(
          sbError ||
            `Sandbox ${sbInstance} needs a restart to apply its updated workspace mounts`,
        );
        qcRef.invalidateQueries({ queryKey: ['sandbox', 'status'] });
        qcRef.invalidateQueries({ queryKey: queryKeys.projects.all });
      } else if (action !== 'restarted') {
        qcRef.invalidateQueries({ queryKey: ['sandbox', 'status'] });
        qcRef.invalidateQueries({ queryKey: ['bashTab', 'shells'] });
        qcRef.invalidateQueries({ queryKey: queryKeys.sandbox.ps });
      }
      if (
        (action === 'restarted' || action === 'restart_failed') &&
        sbInstance
      ) {
        if (action === 'restarted') {
          toast.success(`Sandbox ${sbInstance} restarted`);
          qcRef.invalidateQueries({ queryKey: ['bashTab', 'shells'] });
          // Fetch after start; server reconciliation notifies us if ports
          // finish binding later. The ps prefix includes instance queries.
          const refetchPs = qcRef.refetchQueries({
            queryKey: queryKeys.sandbox.ps,
          });
          const refetchStatus = qcRef.refetchQueries({
            queryKey: ['sandbox', 'status'],
          });

          // Wait until the fresh data is loaded before setting isRestarting to false to prevent flash of old ports
          Promise.allSettled([refetchPs, refetchStatus]).finally(() => {
            setRestartingSandbox(sbInstance, false);
          });
        } else {
          setRestartingSandbox(sbInstance, false);
          toast.error(`Sandbox restart failed: ${sbError || 'unknown error'}`);
        }
      }
      break;
    }

    case 'whatsapp_status':
      qcRef.setQueryData(queryKeys.whatsapp.status, payload);
      break;

    case 'deploy_ready': {
      qcRef.invalidateQueries({ queryKey: queryKeys.serverWebBuild });
      break;
    }

    case 'deploy_failed': {
      const failure = payload as {
        target?: 'server-web';
        error?: string;
        output?: string;
      };
      const failureOutput = failure.output;
      if (failureOutput) {
        console.error('[Deploy] Background build failed', failureOutput);
      }
      toast.error(
        failure.error || 'Server & web build failed',
        failureOutput
          ? {
              action: {
                label: 'View log',
                onClick: () => showBuildLog(failureOutput),
              },
            }
          : undefined,
      );
      if (failure.target === 'server-web') {
        qcRef.invalidateQueries({ queryKey: queryKeys.serverWebBuild });
      }
      break;
    }

    case 'android_update_ready': {
      const update = payload as { version?: string };
      toast.success(
        update.version
          ? `Android update ${update.version} is ready`
          : 'Android update is ready',
      );
      window.dispatchEvent(new Event(ANDROID_OTA_AVAILABLE_EVENT));
      break;
    }

    case 'server_restarted': {
      const { started_at } = payload as { started_at: number };
      if (
        knownServerStartedAt !== null &&
        knownServerStartedAt !== started_at
      ) {
        handleServerRestarted(store);
      }
      knownServerStartedAt = started_at;
      window.dispatchEvent(new Event('carapa:server-restarted'));
      break;
    }

    case 'notification_created': {
      qcRef.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
      break;
    }
    case 'memory_audit_updated': {
      qcRef.invalidateQueries({ queryKey: queryKeys.memoryAudits.root });
      break;
    }
    case 'notification_acked': {
      qcRef.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
      // Clear the lingering Android system-tray notification for this
      // payload — the user already responded (here, in the in-app bell, or
      // on another device). No-op on non-native platforms.
      const payloadId = (payload as { payload_id?: string })?.payload_id;
      if (payloadId) void dismissNativeNotification(payloadId);
      break;
    }

    case 'meeting_transcript': {
      const recordingId = payload.recording_id as string | undefined;
      const partialTranscript = payload.partial_transcript as
        | string
        | undefined;
      const isFinal = payload.final === true;
      if (recordingId) {
        if (partialTranscript) {
          store.setMeetingPartialTranscript(recordingId, partialTranscript);
        }
        store.markRecordingActive(recordingId, !isFinal);
      }
      break;
    }
  }
}

/** Test-only injection point for exercising the same event dispatcher as the socket. */
export function setWebSocketQueryClientForTest(
  queryClient: QueryClient | null,
) {
  qcRef = queryClient;
}
