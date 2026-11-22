import { WebSocketServer, WebSocket } from 'ws';
import { BOX_CONNECT_PATH, handleBoxUpgrade } from '../boxes/connections.js';
import { browserViewers } from '../../lib/browser-viewer.js';
import {
  BROWSER_CDP_PATH,
  webBrowserSessions,
} from '../web/browser-sessions.js';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { logger } from '../../logger.js';
import { isStaleUserSession, verifyJwt } from '../../lib/auth-jwt.js';
import {
  getUserById,
  getProjectsForUser,
  getImplicitProjectIdsForUser,
  getSharedConversationIds,
  getUserDictationLanguage,
  getDeviceStateForUser,
} from '../../db.js';
import { getGroupByFolder } from '../../state-manager.js';
import { isOwnedByOtherUser } from '../../lib/project-ownership.js';
import { getConversation } from '../chat/db-chats.js';
import {
  getLiveActivities,
  getLiveActivity,
  upsertLiveActivity,
  type LiveConversationActivity,
} from '../chat/live-activity.js';
import { publishPublicEventFromBoardEvent } from '../chat/public-conversation-events.js';
import {
  closeLiveVoiceUserSockets,
  handleLiveVoiceUpgrade,
  type LiveVoiceStreamingDeps,
} from '../live-voice/streaming.js';

export type WsEventType =
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
  | 'task_stream_snapshot'
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
  | 'memory_audit_updated'
  | 'meeting_transcript'
  | 'live_activity'
  | 'live_activity_snapshot'
  | 'persona_live_mode'
  | 'persona_live_queue';

export type WsEvent = {
  type: WsEventType;
  payload: unknown;
};

let wss: WebSocketServer;

export function hasWebSocketClients(): boolean {
  return (
    !!wss &&
    [...wss.clients].some((client) => client.readyState === WebSocket.OPEN)
  );
}
let wsKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
// Access filtering is asynchronous. Keep each client's event stream ordered
// even when adjacent broadcasts resolve their access lookups differently.
const clientDeliveryChains = new WeakMap<WebSocket, Promise<void>>();
export const started_at = Date.now();
let verifySessionFn: ((id: string) => boolean) | null = null;

const wsTickets = new Map<string, { session_id: string; expires: number }>();

export function createWsTicket(session_id: string): string {
  const now = Date.now();
  for (const [key, value] of wsTickets) {
    if (value.expires <= now) wsTickets.delete(key);
  }
  const ticket = crypto.randomUUID();
  wsTickets.set(ticket, { session_id, expires: now + 30000 }); // 30s expiry
  return ticket;
}

/** Called by http-service to provide the session validator. */
export function setSessionVerifier(fn: (id: string) => boolean): void {
  verifySessionFn = fn;
}

// ---------------------------------------------------------------------------
// In-memory buffer for active chat streams — used to recover streaming state
// after a browser refresh.  Keyed by conversation_id.
// ---------------------------------------------------------------------------

export interface ActiveStreamBoundary {
  streamKey: string;
  contentOffset: number;
  targetMessageId?: string;
}

export interface ActiveStream {
  /** Full payload that was sent with chat_started (includes folder, streamKey, …) */
  startedPayload: Record<string, unknown>;
  streamKey: string;
  /** Accumulated rendered response used to hydrate a browser reconnect. */
  content: string;
  /** Absolute UTF-8 byte offset of the retained content prefix. */
  contentOffset?: number;
  /** Chat streams: UTF-16 length of the prefix trimmed from `content` by the
   * buffer cap, so absolute offsets stay monotonic past the cap. */
  droppedChars?: number;
  /** Complete semantic task-output entries retained for reconnect replay. */
  taskEntries?: Array<{
    id: string;
    content: string;
    startOffset: number;
    endOffset: number;
    complete: boolean;
  }>;
  /** Agents/commands still running after the turn, replayed on reconnect. */
  backgroundTasks?: Array<{
    id: string;
    description: string;
    startedAt?: number;
  }>;
  /** Invited persona currently holding the talking stick, when applicable. */
  activePersona?: {
    messageId: string;
    content: string;
    /** UTF-16 length of the prefix trimmed from `content` by the buffer cap. */
    droppedChars?: number;
    /** Original start event needed to recreate the in-progress bubble. */
    startedPayload: Record<string, unknown>;
  };
}
/**
 * Freeze the reconnect boundary before any newly-broadcast events can queue for
 * the client. Without this copy, an async access lookup can let the cumulative
 * snapshot absorb live chunks that are already waiting in the client's normal
 * delivery chain; replay then sends those chunks in the snapshot and the
 * delivery chain appends them a second time.
 */
export function captureActiveStreamReplay(
  streams: Iterable<[string, ActiveStream]>,
): Array<[string, ActiveStream]> {
  return [...streams].map(([id, stream]) => [
    id,
    {
      ...stream,
      startedPayload: { ...stream.startedPayload },
      activePersona: stream.activePersona
        ? {
            ...stream.activePersona,
            startedPayload: {
              ...stream.activePersona.startedPayload,
              message:
                stream.activePersona.startedPayload.message &&
                typeof stream.activePersona.startedPayload.message === 'object'
                  ? {
                      ...(stream.activePersona.startedPayload.message as Record<
                        string,
                        unknown
                      >),
                    }
                  : stream.activePersona.startedPayload.message,
            },
          }
        : undefined,
      taskEntries: stream.taskEntries?.map((entry) => ({ ...entry })),
    },
  ]);
}

/** Build the ordered frames that hydrate one active conversation on reconnect. */
export function activeChatReplayEvents(
  conversationId: string,
  stream: ActiveStream,
): WsEvent[] {
  const folder = stream.startedPayload.folder as string | undefined;
  const events: WsEvent[] = [
    { type: 'chat_started', payload: stream.startedPayload },
  ];
  if (stream.content) {
    events.push({
      type: 'chat_stream_snapshot',
      payload: {
        folder,
        conversation_id: conversationId,
        streamKey: stream.streamKey,
        content: stream.content,
        // Absolute offset of content[0] once the cap trimmed a prefix; live
        // chunks that follow are positioned against it.
        ...(stream.droppedChars ? { contentOffset: stream.droppedChars } : {}),
      },
    });
  }
  if (stream.backgroundTasks?.length) {
    events.push({
      type: 'chat_background_tasks',
      payload: {
        folder,
        conversation_id: conversationId,
        streamKey: stream.streamKey,
        tasks: stream.backgroundTasks,
      },
    });
  }
  if (stream.activePersona) {
    events.push({
      type: 'chat_persona_started',
      payload: stream.activePersona.startedPayload,
    });
    if (stream.activePersona.content) {
      events.push({
        type: 'chat_persona_output',
        payload: {
          ...stream.activePersona.startedPayload,
          message: undefined,
          messageId: stream.activePersona.messageId,
          content: stream.activePersona.content,
          // Absolute offset of content[0]. `snapshot` tells the browser this
          // is a replay of the retained buffer, so a trimmed prefix is not a
          // gap it must wait on.
          contentOffset: stream.activePersona.droppedChars ?? 0,
          ...(stream.activePersona.droppedChars ? { snapshot: true } : {}),
        },
      });
    }
  }
  return events;
}

// Chunk count is not a meaningful size bound: Codex emits many very small
// reasoning/tool deltas, so a 1,000-chunk cap could discard the entire visible
// answer during an otherwise modest turn. Bound the rendered response by
// characters instead. The buffer is released as soon as chat_completed arrives.
export const MAX_ACTIVE_STREAM_CHARS = 16 * 1024 * 1024;
const TASK_ACTIVE_ENTRY_TARGET_BYTES = 32 * 1024;

export function appendTaskStreamEntry(
  entries: NonNullable<ActiveStream['taskEntries']>,
  entryId: string,
  content: string,
  startOffset: number,
  complete = true,
): NonNullable<ActiveStream['taskEntries']> {
  const next = entries.map((entry) => ({ ...entry }));
  const existing = next.find((entry) => entry.id === entryId);
  if (existing) {
    // A tool result can arrive after another tool has started. Keep all
    // fragments with their first-seen semantic entry for reconnect replay.
    existing.content += content;
    existing.complete = complete;
  } else {
    next.push({
      id: entryId,
      content,
      startOffset,
      endOffset: startOffset + Buffer.byteLength(content),
      complete,
    });
  }
  let projectedOffset = next[0]?.startOffset ?? startOffset;
  for (const entry of next) {
    entry.startOffset = projectedOffset;
    projectedOffset += Buffer.byteLength(entry.content);
    entry.endOffset = projectedOffset;
  }
  let retainedBytes = 0;
  let keepFrom = next.length - 1;
  for (; keepFrom >= 0; keepFrom -= 1) {
    const size = Buffer.byteLength(next[keepFrom].content);
    if (
      retainedBytes > 0 &&
      retainedBytes + size > TASK_ACTIVE_ENTRY_TARGET_BYTES
    )
      break;
    retainedBytes += size;
  }
  const targetKeepFrom = keepFrom + 1;
  const oldestOpen = next.findIndex((entry) => !entry.complete);
  return next.slice(
    oldestOpen >= 0 ? Math.min(targetKeepFrom, oldestOpen) : targetKeepFrom,
  );
}

export function appendActiveStreamContent(
  current: string,
  chunk: string,
): string {
  const combined = current + chunk;
  if (combined.length <= MAX_ACTIVE_STREAM_CHARS) return combined;
  const start = Math.max(0, combined.length - MAX_ACTIVE_STREAM_CHARS);
  const first = combined.charCodeAt(start);
  return combined.slice(start + (first >= 0xdc00 && first <= 0xdfff ? 1 : 0));
}

/** Absolute end offset of a chat/persona buffer, counting any prefix the cap trimmed. */
function activeStreamEnd(stream: {
  content: string;
  droppedChars?: number;
}): number {
  return (stream.droppedChars ?? 0) + stream.content.length;
}

/** Append a chunk to a capped buffer and return its absolute start offset. */
function appendTrackedStreamContent(
  buffer: { content: string; droppedChars?: number },
  chunk: string,
): number {
  const start = activeStreamEnd(buffer);
  const next = appendActiveStreamContent(buffer.content, chunk);
  buffer.droppedChars =
    (buffer.droppedChars ?? 0) +
    buffer.content.length +
    chunk.length -
    next.length;
  buffer.content = next;
  return start;
}

export function shouldReplayActiveStream(
  conversation: { status?: string } | null | undefined,
): boolean {
  if (!conversation) return false;
  // getConversation() returns the persisted row and does not compute the
  // aggregate-derived status added by getConversations(). Undefined therefore
  // means "known conversation", not "idle".
  return conversation.status == null || conversation.status === 'working';
}

const activeStreamsByConvId = new Map<string, ActiveStream>();
const activeTasksByTaskId = new Map<string, ActiveStream>();

export function chatReplayCompleteEvent(
  streams: Iterable<[string, { startedPayload: Record<string, unknown> }]>,
  canReplay: (startedPayload: Record<string, unknown>) => boolean,
): WsEvent {
  return {
    type: 'chat_replay_complete',
    payload: {
      activeConversationIds: [...streams]
        .filter(([, stream]) => canReplay(stream.startedPayload))
        .map(([conversationId]) => conversationId),
    },
  };
}

/** Stream key for an in-flight chat run, if any (used by recovery on failure). */
export function getActiveStreamKeyForConv(convId: string): string | undefined {
  return activeStreamsByConvId.get(convId)?.streamKey;
}

/** Snapshot the rendered output boundary used when an in-flight steering
 * message is acknowledged. The offset lets transcript replay split the
 * assistant turn at the same visible point. */
export function getActiveStreamBoundaryForConv(
  convId: string,
): ActiveStreamBoundary | undefined {
  const stream = activeStreamsByConvId.get(convId);
  if (!stream) return undefined;
  return stream.activePersona
    ? {
        streamKey: stream.streamKey,
        targetMessageId: stream.activePersona.messageId,
        contentOffset: activeStreamEnd(stream.activePersona),
      }
    : { streamKey: stream.streamKey, contentOffset: activeStreamEnd(stream) };
}

/** Boundary for steering the main harness. Persona streams are separately
 * non-steerable runs and may overlap the outer conversation lifecycle; using
 * their placeholder as the target makes the UI split the wrong speaker. */
export function getActiveMainStreamBoundaryForConv(
  convId: string,
): { streamKey: string; contentOffset: number } | undefined {
  const stream = activeStreamsByConvId.get(convId);
  return stream
    ? { streamKey: stream.streamKey, contentOffset: activeStreamEnd(stream) }
    : undefined;
}

function extractUserIdFromSession(session_id: string): string | null {
  const payload = verifyJwt(session_id);
  if (payload && payload.type === 'user' && typeof payload.sub === 'string') {
    return payload.sub;
  }
  return null;
}

/** A session issued before the user's last password change, or one whose
 * account is disabled, is refused. */
async function sessionIsStale(session_id: string): Promise<boolean> {
  const payload = verifyJwt(session_id);
  if (!payload || typeof payload.sub !== 'string') return false;
  const user = await getUserById(payload.sub);
  return !!user?.disabled || isStaleUserSession(payload, user);
}

function extractDeviceIdFromSession(session_id: string): string | null {
  const payload = verifyJwt(session_id);
  return payload && typeof payload.did === 'string' ? payload.did : null;
}

type ConversationPresenceClient = WebSocket & {
  __userId?: string;
  __deviceId?: string;
  __viewedConversationId?: string;
};

const conversationPresenceClients = new Set<ConversationPresenceClient>();

export function updateConversationPresence(
  client: ConversationPresenceClient,
  payload: unknown,
): void {
  const conversationId =
    payload && typeof payload === 'object'
      ? (payload as { conversation_id?: unknown }).conversation_id
      : undefined;
  if (typeof conversationId === 'string' && conversationId.length > 0) {
    client.__viewedConversationId = conversationId;
    conversationPresenceClients.add(client);
  } else {
    delete client.__viewedConversationId;
    conversationPresenceClients.delete(client);
  }
}

export function getViewingDeviceIds(
  userId: string,
  conversationId: string,
): Set<string> {
  const deviceIds = new Set<string>();
  for (const client of conversationPresenceClients) {
    if (
      client.__userId === userId &&
      client.__viewedConversationId === conversationId &&
      client.__deviceId
    ) {
      deviceIds.add(client.__deviceId);
    }
  }
  return deviceIds;
}

export function isConversationViewedByUser(
  userId: string,
  conversationId: string,
): boolean {
  for (const client of conversationPresenceClients) {
    if (
      client.__userId === userId &&
      client.__viewedConversationId === conversationId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Authenticate a WebSocket upgrade. Every connection must belong to a user:
 * event delivery is filtered per user, so a session without one (an agent
 * JWT, for example) is refused. `requireTicket` disables the cookie fallback.
 */
function verifyWsAuth(req: IncomingMessage, requireTicket = false): boolean {
  // Check query parameter for ticket (for native apps)
  const url = new URL(req.url || '', 'http://localhost');
  const ticket = url.searchParams.get('ticket');
  if (ticket) {
    const data = wsTickets.get(ticket);
    wsTickets.delete(ticket); // One-time use, expired or not
    if (data && data.expires > Date.now()) {
      const ok = !!verifySessionFn && verifySessionFn(data.session_id);
      if (ok) {
        const uid = extractUserIdFromSession(data.session_id);
        if (uid) (req as any).__userId = uid;
        (req as any).__sessionId = data.session_id;
        const did = extractDeviceIdFromSession(data.session_id);
        if (did) (req as any).__deviceId = did;
      }
      return Boolean(ok && (req as any).__userId);
    }
  }

  if (requireTicket) return false;
  // Fallback: Check session cookie
  const cookieHeader = req.headers.cookie;
  if (cookieHeader && verifySessionFn) {
    for (const pair of cookieHeader.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      const value = rest.join('=');
      if (name?.trim() === 'carapa_session' && verifySessionFn(value)) {
        const uid = extractUserIdFromSession(value);
        if (!uid) return false;
        (req as any).__userId = uid;
        (req as any).__sessionId = value;
        const did = extractDeviceIdFromSession(value);
        if (did) (req as any).__deviceId = did;
        return true;
      }
    }
  }
  return false;
}

/**
 * Apply the HTTP session gates to an authenticated upgrade: a session issued
 * before the user's last password change is refused, and one bound to a device
 * is refused unless that device is active and approved. Sessions without a
 * device id are unaffected. Returns the HTTP status to refuse with, or null to
 * proceed; a lookup failure refuses (fail closed).
 */
async function deviceUpgradeRefusal(
  req: IncomingMessage,
): Promise<401 | 403 | null> {
  const deviceId = (req as any).__deviceId as string | undefined;
  const userId = (req as any).__userId as string;
  try {
    if (await sessionIsStale((req as any).__sessionId)) return 401;
    if (!deviceId) return null;
    const state = await getDeviceStateForUser(deviceId, userId);
    if (!state || !state.isActive) return 401;
    return state.isApproved ? null : 403;
  } catch (error) {
    logger.warn({ err: error, userId }, 'WebSocket device lookup failed');
    return 401;
  }
}

/** Close the open `/api/ws` and live-voice sockets of a disabled account. */
export function closeUserSockets(userId: string): void {
  closeLiveVoiceUserSockets(userId);
  if (!wss) return;
  for (const client of wss.clients as Set<ConversationPresenceClient>) {
    if (client.__userId === userId) client.close(1008, 'Account disabled');
  }
}

/** Close the open `/api/ws` sockets a revoked or removed device holds. */
export function closeDeviceSockets(userId: string, deviceId: string): void {
  if (!wss) return;
  for (const client of wss.clients as Set<ConversationPresenceClient>) {
    if (client.__userId === userId && client.__deviceId === deviceId) {
      client.close(1008, 'Device revoked');
    }
  }
}

// ---------------------------------------------------------------------------
// Access cache for broadcast filtering — keyed by user_id, ~30s TTL.
// ---------------------------------------------------------------------------

export interface UserAccess {
  /** A disabled account receives no events. */
  disabled?: boolean;
  isAdmin: boolean;
  explicitProjects: Set<string>;
  // Map of project_id → set of conversation_ids the user has shared access to
  implicitProjectConvIds: Map<string, Set<string>>;
  expires: number;
}

const USER_ACCESS_TTL = 30_000;

export interface UserAccessLoaders {
  getUserById: typeof getUserById;
  getProjectsForUser: typeof getProjectsForUser;
  getImplicitProjectIdsForUser: typeof getImplicitProjectIdsForUser;
  getSharedConversationIds: typeof getSharedConversationIds;
}

/** TTL cache whose generations prevent pre-mutation loads publishing stale access. */
export class UserAccessCache {
  private readonly cache = new Map<string, UserAccess>();
  private generation = 0;

  constructor(
    private readonly loaders: UserAccessLoaders,
    private readonly ttl = USER_ACCESS_TTL,
  ) {}

  async load(userId: string): Promise<UserAccess> {
    const cached = this.cache.get(userId);
    if (cached && cached.expires > Date.now()) return cached;

    const generation = this.generation;
    const user = await this.loaders.getUserById(userId).catch(() => undefined);
    const isAdmin = user?.role === 'admin';

    // Admins load their memberships too: they bypass only projects no other
    // user owns, and reach the rest through membership like any user.
    // Fan-out the two project-membership lookups; they share no data dependency.
    const [explicit, implicitProjects] = await Promise.all([
      this.loaders.getProjectsForUser(userId).catch(() => [] as string[]),
      this.loaders
        .getImplicitProjectIdsForUser(userId)
        .catch(() => [] as string[]),
    ]);
    const implicitProjectConvIds = new Map<string, Set<string>>();
    await Promise.all(
      implicitProjects.map(async (projectId) => {
        const ids = await this.loaders
          .getSharedConversationIds(userId, projectId)
          .catch(() => [] as string[]);
        implicitProjectConvIds.set(projectId, new Set(ids));
      }),
    );
    const access: UserAccess = {
      disabled: !!user?.disabled,
      isAdmin,
      explicitProjects: new Set(explicit),
      implicitProjectConvIds,
      expires: Date.now() + this.ttl,
    };

    // A membership mutation or project rename committed while this load was
    // running. Discard its snapshot and reload against the committed state.
    if (generation !== this.generation) {
      return this.load(userId);
    }
    this.cache.set(userId, access);
    return access;
  }

  invalidate(userId: string): void {
    // Invalidations must also supersede an older load still in progress.
    this.generation++;
    this.cache.delete(userId);
  }

  migrateProject(oldProjectId: string, newProjectId: string): void {
    // Increment before migrating warm entries. In-flight loads from the prior
    // generation will observe this and cannot repopulate an old project key.
    this.generation++;
    for (const access of this.cache.values()) {
      if (access.explicitProjects.delete(oldProjectId))
        access.explicitProjects.add(newProjectId);
      const sharedConversations =
        access.implicitProjectConvIds.get(oldProjectId);
      if (!sharedConversations) continue;
      access.implicitProjectConvIds.delete(oldProjectId);
      const target = access.implicitProjectConvIds.get(newProjectId);
      if (target) {
        for (const conversationId of sharedConversations)
          target.add(conversationId);
      } else {
        access.implicitProjectConvIds.set(newProjectId, sharedConversations);
      }
    }
  }
}

const userAccessCache = new UserAccessCache({
  getUserById,
  getProjectsForUser,
  getImplicitProjectIdsForUser,
  getSharedConversationIds,
});

async function loadUserAccess(userId: string): Promise<UserAccess> {
  return userAccessCache.load(userId);
}

/** Invalidate the cached access for a user — call after share changes. */
export function invalidateUserAccess(user_id: string): void {
  userAccessCache.invalidate(user_id);
}

/** Re-key live authorization records before a renamed-project event is sent. */
export function migrateProjectAccessCache(
  oldProjectId: string,
  newProjectId: string,
): void {
  userAccessCache.migrateProject(oldProjectId, newProjectId);
}

function eventProjectFolder(p: any): string | undefined {
  if (!p || typeof p !== 'object') return undefined;
  // Chat payloads use the owning project's folder; objective chats also carry
  // `project_id` with the same value.
  if (typeof p.project_id === 'string') return p.project_id;
  if (typeof p.projectId === 'string') return p.projectId;
  if (typeof p.folder === 'string') return p.folder;
  if (typeof p.message?.group_folder === 'string')
    return p.message.group_folder;
  return undefined;
}

/** The live registry is always project-scoped, even for objective chat streams. */
export function liveActivityProjectFolder(
  p: Record<string, unknown>,
): string | undefined {
  return typeof p.project_id === 'string'
    ? p.project_id
    : typeof p.folder === 'string'
      ? p.folder
      : undefined;
}

function eventConversationId(p: any): string | undefined {
  if (!p || typeof p !== 'object') return undefined;
  if (typeof p.conversation_id === 'string') return p.conversation_id;
  if (typeof p.conversationId === 'string') return p.conversationId;
  if (typeof p.message?.conversation_id === 'string')
    return p.message.conversation_id;
  return undefined;
}

/**
 * How `access` reaches `folder`: 'all' (admin bypass of a project no other user
 * owns), 'none' (another user's personal main, private even from admins) or
 * 'member' (decided by membership, as for any user — including admins in a
 * project owned by another user).
 */
function projectScope(
  access: Pick<UserAccess, 'isAdmin'>,
  folder: string,
  userId?: string,
): 'all' | 'none' | 'member' {
  if (!access.isAdmin) return 'member';
  if (!isOwnedByOtherUser(userId, folder)) return 'all';
  return getGroupByFolder(folder)?.is_main ? 'none' : 'member';
}

function shouldSendToUser(
  access: UserAccess,
  event: WsEvent,
  userId?: string,
): boolean {
  if (access.disabled) return false;
  // User-scoped events (e.g. notification_created/acked) carry the recipient's
  // user_id in the payload. Deliver ONLY to that user — admins do not bypass,
  // since notification summaries shouldn't leak across accounts.
  const targetUid = (event.payload as any)?.user_id;
  if (typeof targetUid === 'string') {
    return userId === targetUid;
  }

  const folder = eventProjectFolder(event.payload);
  // Global events without a project scope — always deliver (server_restarted, deploy_ready, etc.)
  if (!folder) return true;

  const scope = projectScope(access, folder, userId);
  if (scope !== 'member') return scope === 'all';

  if (access.explicitProjects.has(folder)) return true;

  const sharedConvs = access.implicitProjectConvIds.get(folder);
  if (!sharedConvs) return false;

  // Implicit project access: only chat events for shared conversations are forwarded,
  // plus conversations_changed so the UI refreshes the list.
  if (event.type === 'conversations_changed') return true;

  const convId = eventConversationId(event.payload);
  if (convId && sharedConvs.has(convId)) return true;
  return false;
}

/** Apply the same project + shared-conversation policy to reconnect snapshots. */
export function filterLiveActivitiesForAccess(
  activities: LiveConversationActivity[],
  access: Pick<
    UserAccess,
    'isAdmin' | 'explicitProjects' | 'implicitProjectConvIds'
  > | null,
  userId?: string,
): LiveConversationActivity[] {
  // A missing access record is an authorization failure, never a reason to
  // widen a reconnect snapshot.
  if (!access) return [];
  return activities.filter((activity) => {
    const scope = projectScope(access, activity.folder, userId);
    if (scope !== 'member') return scope === 'all';
    return (
      access.explicitProjects.has(activity.folder) ||
      access.implicitProjectConvIds
        .get(activity.folder)
        ?.has(activity.conversation_id)
    );
  });
}

interface LiveVoiceWebSocketDeps extends LiveVoiceStreamingDeps {
  resolveUserLanguage?: (userId: string) => Promise<string | null>;
}

export function attachWebSocket(
  server: Server,
  liveVoiceDeps: LiveVoiceWebSocketDeps = {},
): void {
  const {
    resolveUserLanguage = getUserDictationLanguage,
    ...liveVoiceStreamingDeps
  } = liveVoiceDeps;
  wss = new WebSocketServer({
    noServer: true,
  });

  // A single upgrade router is required when multiple WebSocket paths share
  // one HTTP server. A WebSocketServer constructed with { server, path }
  // rejects upgrades for every other path before another handler can see them.
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === BOX_CONNECT_PATH) {
      // CarapaBox hosts authenticate with their own per-box token.
      void handleBoxUpgrade(req, socket, head).catch(() => socket.destroy());
      return;
    }
    if (BROWSER_CDP_PATH.test(pathname)) {
      void webBrowserSessions
        .upgrade(req, socket, head)
        .catch(() => socket.destroy());
      return;
    }
    if (
      pathname !== '/api/ws' &&
      pathname !== '/api/live-voice/ws' &&
      pathname !== '/api/browser/ws'
    ) {
      socket.destroy();
      return;
    }
    if (!verifyWsAuth(req, pathname === '/api/browser/ws')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Tickets and cookies are only JWT-signature checks; the session must also
    // be current and its device still active and approved, as on HTTP. The raw
    // socket is held until the lookup settles, so keep its error events
    // handled meanwhile.
    const ignoreSocketError = () => {};
    socket.on('error', ignoreSocketError);
    void deviceUpgradeRefusal(req).then((refusal) => {
      socket.off('error', ignoreSocketError);
      if (refusal || socket.destroyed) {
        if (refusal) {
          const reason = refusal === 401 ? 'Unauthorized' : 'Forbidden';
          socket.write(
            `HTTP/1.1 ${refusal} ${reason}\r\nConnection: close\r\n\r\n`,
          );
        }
        socket.destroy();
        return;
      }
      routeAuthenticatedUpgrade(req, socket, head, pathname);
    });
  });

  const routeAuthenticatedUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pathname: string,
  ): void => {
    if (pathname === '/api/browser/ws') {
      void browserViewers
        .upgrade(req, socket, head)
        .catch(() => socket.destroy());
      return;
    }
    if (pathname === '/api/live-voice/ws') {
      const userId = (req as any).__userId as string | undefined;
      // Upgrade synchronously: the browser must never hold a raw,
      // un-upgraded socket while we await the preference lookup. The
      // language is resolved lazily by the session when its start message
      // arrives (streaming.ts), and a lookup failure there degrades to
      // the operator language instead of destroying the connection.
      try {
        handleLiveVoiceUpgrade(req, socket, head, {
          ...liveVoiceStreamingDeps,
          resolveBoundUserLanguage: userId
            ? () => resolveUserLanguage(userId)
            : undefined,
          userPreferenceBound: Boolean(userId),
        });
      } catch (error) {
        logger.warn({ err: error, userId }, 'Live voice upgrade failed');
        socket.destroy();
      }
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit('connection', client, req);
    });
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const userId = (req as any).__userId as string | undefined;
    if (userId) (ws as any).__userId = userId;
    const deviceId = (req as any).__deviceId as string | undefined;
    if (deviceId) (ws as any).__deviceId = deviceId;
    logger.debug({ userId }, 'WebSocket client connected');

    // Register the error listener before any send() calls so that errors from
    // those initial sends are handled rather than emitted as unhandled events.
    ws.on('error', (err) => {
      logger.debug({ err }, 'WebSocket client error');
    });

    ws.send(JSON.stringify({ type: 'connected' }));
    ws.send(
      JSON.stringify({ type: 'server_restarted', payload: { started_at } }),
    );

    // Capture the stream boundary synchronously, then make replay the first
    // item in this client's delivery chain. Broadcasts arriving during the
    // async access checks queue behind it and therefore continue strictly
    // after the captured snapshot instead of being represented twice.
    const chatReplay = captureActiveStreamReplay(activeStreamsByConvId);
    const taskReplay = captureActiveStreamReplay(activeTasksByTaskId);
    queueClientReplay(ws, async () => {
      let access: UserAccess | null = null;
      if (userId) {
        try {
          access = await loadUserAccess(userId);
        } catch (err) {
          // Do not replay any scoped state when the access lookup is unhealthy.
          logger.debug(
            { err, userId },
            'WS replay access lookup failed; denying replay',
          );
          return;
        }
        if (access.disabled) return;
      }
      // Admins are filtered too: another user's personal main stays private.
      const allowEverything = !userId;

      // This deliberately contains only registry metadata — never buffered
      // assistant chunks or tool output — and is filtered per conversation.
      ws.send(
        JSON.stringify({
          type: 'live_activity_snapshot',
          payload: {
            activities: allowEverything
              ? getLiveActivities()
              : filterLiveActivitiesForAccess(
                  getLiveActivities(),
                  access,
                  userId,
                ),
          },
        }),
      );

      const { listLiveQueueSnapshots } =
        await import('../ai-users/live-queue.js');
      for (const { folder, snapshot } of await listLiveQueueSnapshots()) {
        const evt: WsEvent = {
          type: 'persona_live_queue',
          payload: {
            folder,
            conversation_id: snapshot.conversationId,
            snapshot,
          },
        };
        if (
          !allowEverything &&
          (!access || !shouldSendToUser(access, evt, userId))
        )
          continue;
        ws.send(JSON.stringify(evt));
      }

      const replayableChats: Array<[string, ActiveStream]> = [];
      for (const [convId, stream] of chatReplay) {
        let lookupFailed = false;
        const conv = await getConversation(convId).catch((err) => {
          lookupFailed = true;
          logger.warn(
            { err, convId },
            'Conversation lookup failed during WS replay; keeping retained stream',
          );
          return null;
        });
        // A failed lookup says nothing about the conversation: skip replay for
        // this connection but keep the retained stream for other clients.
        if (lookupFailed) continue;
        if (!shouldReplayActiveStream(conv)) {
          if (
            activeStreamsByConvId.get(convId)?.streamKey === stream.streamKey
          ) {
            activeStreamsByConvId.delete(convId);
          }
          continue;
        }
        replayableChats.push([convId, stream]);
        const replayEvents = activeChatReplayEvents(convId, stream);
        const evt = replayEvents[0];
        if (
          !allowEverything &&
          (!access || !shouldSendToUser(access, evt, userId))
        )
          continue;
        try {
          // Send one cumulative snapshot per active output owner instead of
          // replaying every buffered chunk. This now includes a participant
          // currently holding the talking stick, so a second device sees the
          // same in-progress bubble as the device that started the run.
          for (const replayEvent of replayEvents) {
            ws.send(JSON.stringify(replayEvent));
          }
        } catch (err) {
          logger.debug(
            { err, convId },
            'Failed to replay active stream on WS connect',
          );
        }
      }

      // Marks the end of the access-filtered chat replay. Clients must not
      // infer completion from a delay because the registry and access lookup
      // above are asynchronous.
      ws.send(
        JSON.stringify(
          chatReplayCompleteEvent(replayableChats, (startedPayload) => {
            if (allowEverything) return true;
            const evt: WsEvent = {
              type: 'chat_started',
              payload: startedPayload,
            };
            return Boolean(access && shouldSendToUser(access, evt, userId));
          }),
        ),
      );

      for (const [task_id, stream] of taskReplay) {
        const evt: WsEvent = {
          type: 'task_started',
          payload: stream.startedPayload,
        };
        if (
          !allowEverything &&
          (!access || !shouldSendToUser(access, evt, userId))
        )
          continue;
        try {
          ws.send(JSON.stringify(evt));
          if (stream.content) {
            ws.send(
              JSON.stringify({
                type: 'task_stream_snapshot',
                payload: {
                  task_id,
                  run_id: (stream.startedPayload as { run_id?: string }).run_id,
                  content: stream.content,
                  content_offset: stream.contentOffset ?? 0,
                  entries: stream.taskEntries,
                },
              }),
            );
          }
          if (stream.backgroundTasks?.length) {
            ws.send(
              JSON.stringify({
                type: 'task_background_tasks',
                payload: {
                  task_id,
                  project_id: stream.startedPayload.project_id,
                  run_id: stream.startedPayload.run_id,
                  tasks: stream.backgroundTasks,
                },
              }),
            );
          }
        } catch (err) {
          logger.debug(
            { err, task_id },
            'Failed to replay active task on WS connect',
          );
        }
      }
    });

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: unknown;
          payload?: unknown;
        };
        if (message.type === 'conversation_presence') {
          updateConversationPresence(ws, message.payload);
        }
      } catch {
        // Ignore malformed client messages.
      }
    });

    ws.on('close', () => {
      updateConversationPresence(ws, null);
      logger.debug('WebSocket client disconnected');
    });
  });

  // Proxies often drop idle WS connections around 30–60s. Ping every 25s so
  // reconnect + stream replay does not fire while the user is reading chat.
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveTimer = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 25_000);
  wsKeepaliveTimer.unref?.();

  logger.info('WebSocket server attached at /api/ws');
}

/** Establish reconnect replay as the client's delivery boundary. */
export function queueClientReplay(
  client: WebSocket,
  replay: () => Promise<void>,
): Promise<void> {
  const previous = clientDeliveryChains.get(client) ?? Promise.resolve();
  const delivery = previous.then(async () => {
    if (client.readyState !== WebSocket.OPEN) return;
    await replay();
  });
  const settled = delivery.catch((err) =>
    logger.debug({ err }, 'replay error'),
  );
  clientDeliveryChains.set(client, settled);
  return settled;
}

/** Queue one event for one client, preserving ordering across async access checks. */
export function queueClientEvent(
  client: WebSocket,
  event: WsEvent,
  accessLoader: (userId: string) => Promise<UserAccess> = loadUserAccess,
): Promise<void> {
  const previous = clientDeliveryChains.get(client) ?? Promise.resolve();
  const delivery = previous.then(async () => {
    if (client.readyState !== WebSocket.OPEN) return;
    const userId = (client as any).__userId as string | undefined;
    // Upgrades without a user are refused; never broadcast to one regardless.
    if (!userId) return;
    try {
      const access = await accessLoader(userId);
      if (shouldSendToUser(access, event, userId))
        client.send(JSON.stringify(event));
    } catch (err) {
      logger.debug({ err, userId }, 'broadcast filter failed; skipping client');
    }
  });
  const settled = delivery.catch((err) =>
    logger.debug({ err }, 'broadcast loop error'),
  );
  clientDeliveryChains.set(client, settled);
  return settled;
}

/**
 * Deliver one event through the common project filter. `accessFor` resolves a
 * recipient's access inside that client's ordered delivery chain, so the event
 * is authorized at delivery time and in emission order; the shared access cache
 * is not consulted.
 */
export function broadcastWithAccess(
  event: WsEvent,
  accessFor: (userId: string) => Promise<UserAccess>,
): void {
  if (!wss) return;
  for (const client of Array.from(wss.clients)) {
    void queueClientEvent(client, event, accessFor);
  }
}

export function broadcast(event: WsEvent): void {
  const p = event.payload as Record<string, unknown>;
  publishPublicEventFromBoardEvent(event);
  // Maintain the in-memory stream buffer so reconnecting clients can catch up.
  if (event.type === 'chat_started') {
    const convId = p.conversation_id as string | undefined;
    const streamKey = p.streamKey as string | undefined;
    if (convId && streamKey) {
      activeStreamsByConvId.set(convId, {
        startedPayload: p,
        streamKey,
        content: '',
      });
      const folder = liveActivityProjectFolder(p);
      if (folder) {
        const activity = upsertLiveActivity({
          folder,
          conversation_id: convId,
          persona_driven: p.personaDriven === true,
          state: 'working',
          title: p.liveTitle as string | undefined,
          preview: p.livePreview as string | undefined,
          status: 'Working',
          completion_summary: null,
        });
        broadcast({ type: 'live_activity', payload: activity });
      }
    }
  } else if (event.type === 'memory_capsule_ready') {
    const convId = p.conversation_id as string | undefined;
    const stream = convId ? activeStreamsByConvId.get(convId) : undefined;
    if (stream && stream.streamKey === p.streamKey) {
      // Replayed chat_started must not report preparation once the capsule is ready.
      stream.startedPayload = {
        ...stream.startedPayload,
        memoryPreparing: false,
      };
    }
  } else if (event.type === 'chat_output') {
    const convId = p.conversation_id as string | undefined;
    const content = p.content as string | undefined;
    if (convId && content) {
      const stream = activeStreamsByConvId.get(convId);
      // A late chunk from a stopped run must not shift the new run's offsets.
      if (stream && stream.streamKey === p.streamKey) {
        // Give every delta an absolute position in the retained stream. A
        // browser can briefly receive the same queued frame from an old socket
        // and its replacement around reconnect; without an offset, the client
        // has no way to distinguish that replay from intentional repeated text.
        // Mutate the payload before it enters any per-client delivery chain so
        // every recipient observes the same idempotency boundary.
        p.contentOffset = appendTrackedStreamContent(stream, content);
      }
    }
  } else if (event.type === 'chat_background_tasks') {
    const convId = p.conversation_id as string | undefined;
    const stream = convId ? activeStreamsByConvId.get(convId) : undefined;
    if (stream && stream.streamKey === p.streamKey) {
      stream.backgroundTasks = Array.isArray(p.tasks)
        ? (p.tasks as NonNullable<ActiveStream['backgroundTasks']>)
        : [];
    }
  } else if (event.type === 'chat_persona_started') {
    const convId = p.conversation_id as string | undefined;
    const message = p.message as Record<string, unknown> | undefined;
    const stream = convId ? activeStreamsByConvId.get(convId) : undefined;
    if (stream && typeof message?.id === 'string') {
      stream.activePersona = {
        messageId: message.id,
        content: typeof message.content === 'string' ? message.content : '',
        startedPayload: {
          ...p,
          message: { ...message },
        },
      };
    }
  } else if (event.type === 'chat_persona_output') {
    const convId = p.conversation_id as string | undefined;
    const messageId = p.messageId as string | undefined;
    const content = p.content as string | undefined;
    const persona = convId
      ? activeStreamsByConvId.get(convId)?.activePersona
      : undefined;
    if (persona && persona.messageId === messageId && content) {
      p.contentOffset = appendTrackedStreamContent(persona, content);
    }
  } else if (event.type === 'chat_persona_finished') {
    const convId = p.conversation_id as string | undefined;
    const messageId = p.messageId as string | undefined;
    const stream = convId ? activeStreamsByConvId.get(convId) : undefined;
    if (stream && stream.activePersona?.messageId === messageId) {
      delete stream.activePersona;
    }
  } else if (event.type === 'chat_completed') {
    const convId = p.conversation_id as string | undefined;
    if (convId) {
      const activeStream = activeStreamsByConvId.get(convId);
      const completedStreamKey = p.streamKey as string | undefined;
      const completionMatchesActive =
        !activeStream ||
        !completedStreamKey ||
        activeStream.streamKey === completedStreamKey;
      // A late completion from an older run must not erase a newer autonomous
      // run for the same conversation. This is also what keeps reconnect
      // snapshots and the Stop control attached to the current run.
      if (completionMatchesActive) {
        activeStreamsByConvId.delete(convId);
        const folder = liveActivityProjectFolder(p);
        if (folder) {
          const current = getLiveActivity(folder, convId);
          const activity = upsertLiveActivity({
            folder,
            conversation_id: convId,
            state:
              p.liveState === 'failed'
                ? 'failed'
                : p.liveState === 'needs_input' ||
                    current?.state === 'needs_input'
                  ? 'needs_input'
                  : 'complete',
            status: null,
            completion_summary: p.completionSummary as string | undefined,
          });
          broadcast({ type: 'live_activity', payload: activity });
        }
      }
    }
  } else if (event.type === 'task_started') {
    const task_id = p.task_id as string | undefined;
    if (task_id) {
      activeTasksByTaskId.set(task_id, {
        startedPayload: p,
        streamKey: '',
        content: '',
        contentOffset: 0,
        taskEntries: [],
      });
    }
  } else if (event.type === 'task_output') {
    const task_id = p.task_id as string | undefined;
    const run_id = p.run_id as string | undefined;
    const content = typeof p.content === 'string' ? p.content : '';
    const entryComplete =
      typeof p.entry_complete === 'boolean' ? p.entry_complete : true;
    if (task_id && (content || typeof p.entry_complete === 'boolean')) {
      const stream = task_id ? activeTasksByTaskId.get(task_id) : undefined;
      const activeRunId = stream?.startedPayload?.run_id as string | undefined;
      if (stream && (!run_id || !activeRunId || run_id === activeRunId)) {
        const hasExplicitOffset = Number.isFinite(Number(p.content_offset));
        const currentStart = stream.contentOffset ?? 0;
        const currentEnd = currentStart + Buffer.byteLength(stream.content);
        const start = hasExplicitOffset ? Number(p.content_offset) : currentEnd;
        const incomingEnd = start + Buffer.byteLength(content);
        if (incomingEnd > currentEnd || typeof p.entry_complete === 'boolean') {
          const entryId =
            typeof p.entry_id === 'string'
              ? p.entry_id
              : `live:${activeRunId ?? task_id}`;
          stream.taskEntries = appendTaskStreamEntry(
            start >= currentEnd ? (stream.taskEntries ?? []) : [],
            entryId,
            content,
            start,
            entryComplete,
          );
          stream.content = stream.taskEntries
            .map((entry) => entry.content)
            .join('');
          stream.contentOffset =
            stream.taskEntries[0]?.startOffset ?? incomingEnd;
        }
      }
    }
  } else if (event.type === 'task_background_tasks') {
    const task_id = p.task_id as string | undefined;
    const run_id = p.run_id as string | undefined;
    const stream = task_id ? activeTasksByTaskId.get(task_id) : undefined;
    const activeRunId = stream?.startedPayload?.run_id as string | undefined;
    if (stream && (!run_id || !activeRunId || run_id === activeRunId)) {
      stream.backgroundTasks = Array.isArray(p.tasks)
        ? (p.tasks as NonNullable<ActiveStream['backgroundTasks']>)
        : [];
    }
  } else if (event.type === 'task_output_clear') {
    const task_id = p.task_id as string | undefined;
    const run_id = p.run_id as string | undefined;
    const stream = task_id ? activeTasksByTaskId.get(task_id) : undefined;
    const activeRunId = stream?.startedPayload?.run_id as string | undefined;
    if (task_id && (!run_id || !activeRunId || run_id === activeRunId))
      activeTasksByTaskId.delete(task_id);
  } else if (
    event.type === 'run_finished' ||
    event.type === 'task_completed' ||
    event.type === 'task_error'
  ) {
    // run_finished may be a stage handoff that releases the current run without
    // completing the task. Every terminal run/task event retires the replay
    // registry entry so reconnecting cannot resurrect its running marker. The
    // browser's live output is intentionally left alone until task data and
    // transcripts are reconciled.
    const task_id = p.task_id as string | undefined;
    if (task_id) activeTasksByTaskId.delete(task_id);
  }

  if (!wss) {
    logger.debug({ type: event.type }, 'broadcast: no wss attached');
    return;
  }

  // Queue each recipient independently. Different clients may still be
  // filtered in parallel, but one client's run lifecycle cannot be reordered
  // by asynchronous access lookups.
  for (const client of Array.from(wss.clients)) {
    queueClientEvent(client, event);
  }
}
