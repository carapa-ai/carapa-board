import { sha256Hex } from '../../lib/hash.js';
import { projectChanges } from '../../lib/project-changes.js';
import { drizzleDbRef, isPostgresDatabase } from '../../db/drizzle-client.js';
import {
  appendChatTranscriptEntryAsync,
  readChatTranscript,
  removeChatTranscriptEntries,
} from '../../group-dir.js';
import { type ChatMessage, type ConversationStatus } from './types.js';
import {
  eq,
  and,
  asc,
  desc,
  or,
  isNull,
  isNotNull,
  gte,
  lt,
  ne,
  inArray,
  notExists,
  sql,
} from 'drizzle-orm';
import {
  conversations as drizzleConversations,
  activeRuns,
  conversationExecutionLeases,
  conversationAgentSessions as drizzleConversationAgentSessions,
  conversationPublicShares,
  aiUsers,
  nowDismissals,
  projects,
  users,
} from '../../db/schema.js';
import {
  isProviderContextEntry,
  mergeLateAudioTranscripts,
  withdrawnQueuedMessageIds,
} from '../transcripts/transcript-store.js';
import { logger } from '../../logger.js';
import { eraseChatTranscript } from '../transcripts/chat-transcript-erase.js';
import { sanitizePersistedAssistantProse } from './live-activity.js';
import { presentAccountIdentity } from '../account/profile.js';
import {
  appendOpenFileContext,
  openFileContextsByMessageId,
} from '../../lib/open-file-context.js';
import type { TriggerSource } from '../kanban/types.js';

// NULL means the session was stored by a caller that did not know the mode. Store an explicit
// sentinel for the normal/no-mode state so clearing a mode can never resume a
// session that was created with an older mode.
const DEFAULT_CHAT_MODE_SENTINEL = '__default__';

type AssistantOutcome = 'success' | 'failed' | 'pending';

function assistantOutcome(pending: unknown, failed: unknown): AssistantOutcome {
  return pending === true ? 'pending' : failed === true ? 'failed' : 'success';
}

// 'removal' and 'maintenance' are exclusive for the project+branch. Removal
// closes the gate to later admissions (they fail fast, the branch is going
// away); maintenance leaves it open, so later admissions simply queue behind it.
type ConversationWorktreeAdmissionMode =
  | 'admission'
  | 'removal'
  | 'maintenance';

type ConversationWorktreeAdmissionResult<T> =
  | { admitted: true; value: T }
  | { admitted: false };

type ConversationWorktreeAdmissionGate = {
  tail: Promise<void>;
  pendingOperations: number;
  pendingRemovals: number;
};

// PGlite is single-process and does not implement PostgreSQL advisory locks.
// Keep the same project+branch ordering boundary in process for development
// and tests. PostgreSQL additionally takes a transaction-scoped advisory lock
// below so multiple Board instances share the boundary.
const conversationWorktreeAdmissionGates = new Map<
  string,
  ConversationWorktreeAdmissionGate
>();

async function lockConversationWorktreeAdmission(
  tx: any,
  groupFolder: string,
  branch: string,
  mode: ConversationWorktreeAdmissionMode,
): Promise<boolean> {
  if (!isPostgresDatabase()) return true;
  if (mode !== 'admission') {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${groupFolder}), hashtext(${branch}))`,
    );
    return true;
  }
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock_shared(hashtext(${groupFolder}), hashtext(${branch})) AS admitted`,
  );
  const rows = (result as any).rows ?? result;
  return rows[0]?.admitted === true;
}

/**
 * Order branch binding/run admission against managed worktree removal.
 * Removal closes the local gate synchronously, so later admissions fail fast
 * instead of waiting until deletion has completed and then binding to a branch
 * which no longer has a worktree.
 */
export async function withConversationWorktreeAdmission<T>(
  groupFolder: string,
  branch: string,
  mode: ConversationWorktreeAdmissionMode,
  operation: (tx: any) => Promise<T>,
): Promise<ConversationWorktreeAdmissionResult<T>> {
  const key = `${groupFolder}\0${branch}`;
  let gate = conversationWorktreeAdmissionGates.get(key);
  if (!gate) {
    gate = {
      tail: Promise.resolve(),
      pendingOperations: 0,
      pendingRemovals: 0,
    };
    conversationWorktreeAdmissionGates.set(key, gate);
  }
  if (mode === 'admission' && gate.pendingRemovals > 0) {
    return { admitted: false };
  }

  const previous = gate.tail;
  const completion = Promise.withResolvers<void>();
  gate.tail = previous.then(
    () => completion.promise,
    () => completion.promise,
  );
  gate.pendingOperations += 1;
  if (mode === 'removal') gate.pendingRemovals += 1;

  await previous.catch(() => undefined);
  try {
    return await drizzleDbRef.current.transaction(async (tx) => {
      if (
        !(await lockConversationWorktreeAdmission(
          tx,
          groupFolder,
          branch,
          mode,
        ))
      ) {
        return { admitted: false } as ConversationWorktreeAdmissionResult<T>;
      }
      return {
        admitted: true,
        value: await operation(tx),
      } as ConversationWorktreeAdmissionResult<T>;
    });
  } finally {
    completion.resolve();
    gate.pendingOperations -= 1;
    if (mode === 'removal') gate.pendingRemovals -= 1;
    if (gate.pendingOperations === 0) {
      conversationWorktreeAdmissionGates.delete(key);
    }
  }
}

const pendingSteeringDeliveries = new Map<
  string,
  {
    promise: Promise<boolean>;
    resolve: (accepted: boolean) => void;
  }
>();
const steeredChatMessageIds = new Set<string>();

/** Hold persona-boundary delivery while the active harness decides whether it
 * accepted a steering message. A missing entry after a restart safely means
 * the visible user message falls back to the next participant. */
export function beginChatSteeringDelivery(messageId: string): void {
  if (pendingSteeringDeliveries.has(messageId)) return;
  let resolve!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  pendingSteeringDeliveries.set(messageId, { promise, resolve });
}

/** Persist an accepted-steer receipt without changing the canonical visible
 * user message. Rejected steers need no receipt: queued is the safe default. */
export async function completeChatSteeringDelivery(
  groupFolder: string,
  conversationId: string,
  messageId: string,
  accepted: boolean,
  boundary?: {
    streamKey?: string;
    contentOffset: number;
    targetMessageId?: string;
  },
): Promise<void> {
  const pending = pendingSteeringDeliveries.get(messageId);
  if (accepted) {
    steeredChatMessageIds.add(messageId);
    if (steeredChatMessageIds.size > 1_000) {
      steeredChatMessageIds.delete(
        steeredChatMessageIds.values().next().value!,
      );
    }
    try {
      await appendChatTranscriptEntryAsync(groupFolder, conversationId, {
        type: 'steering_delivery',
        messageId,
        delivery: 'steered',
        // contentOffset is measured against display text containing stable
        // tool identity markers.
        contentOffsetMarkerVersion: 2,
        ...(boundary ?? {}),
        created_at: new Date().toISOString(),
        conversation_id: conversationId,
      });
    } catch (err) {
      logger.warn(
        { err, conversationId, messageId },
        'Failed to persist steering delivery receipt',
      );
    }
  }
  pending?.resolve(accepted);
  if (pendingSteeringDeliveries.get(messageId) === pending) {
    pendingSteeringDeliveries.delete(messageId);
  }
}

export function steeredChatMessageIdsFromTranscript(
  entries: unknown[],
): Set<string> {
  return new Set(
    entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      return value.type === 'steering_delivery' &&
        value.delivery === 'steered' &&
        typeof value.messageId === 'string'
        ? [value.messageId]
        : [];
    }),
  );
}

const NATIVE_IMPORT_CONVERSATION_ID =
  /^conv-(?:claude|codex|gemini|cursor|vscode|antigravity)-/;

function isNativeImportedConversation(id: unknown): boolean {
  return typeof id === 'string' && NATIVE_IMPORT_CONVERSATION_ID.test(id);
}

async function getRunningNativeConversationIds(
  rows: Array<Record<string, unknown>>,
): Promise<Set<string>> {
  const ids = rows
    .filter((row) => isNativeImportedConversation(row.id))
    .map((row) => row.id as string);
  if (ids.length === 0) return new Set();

  const running = await drizzleDbRef.current
    .select({
      conversation_id: activeRuns.conversation_id,
    })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.status, 'running'),
        isNull(activeRuns.task_id),
        inArray(activeRuns.conversation_id, ids),
      ),
    );
  return new Set(
    running
      .map((row) => row.conversation_id)
      .filter((id): id is string => id != null),
  );
}

export function conversationStatusFromAggregates(
  row: Record<string, unknown>,
  hasActiveRun = false,
): ConversationStatus {
  const lastUserAt = (row.last_user_at as string | null | undefined) ?? null;
  const lastAssistantAt =
    (row.last_assistant_at as string | null | undefined) ?? null;
  if (lastUserAt && (!lastAssistantAt || lastAssistantAt < lastUserAt)) {
    // Native history can legitimately end with an unanswered user message.
    // It is historical, not an active Board run. If the imported conversation
    // is later resumed, the active-run row restores the normal working state.
    return isNativeImportedConversation(row.id) && !hasActiveRun
      ? 'idle'
      : 'working';
  }
  if (lastAssistantAt) {
    if (row.lastAssistantOutcome === 'pending') return 'pending';
    const readAt = (row.read_at as string | null | undefined) ?? null;
    if (readAt && readAt >= lastAssistantAt) return 'idle';
    return row.lastAssistantOutcome === 'failed' ? 'failed' : 'finished';
  }
  return 'idle';
}

/**
 * Best-effort extract of the display content from a raw transcript entry. The
 * transcript JSONL holds a mix of formats:
 *  - {type:'message', role, content, sender_name, source, ...}   ← from saveChatMessage
 *  - {type:'message_start', message:{role, content:[...]}}      ← from agents
 *  - {type:'message_update', message:{...}}                     ← from agents
 *  - {type:'message_end', message:{role, content:[...]}}        ← from agents
 *  - {type:'result', result:'<text>'}                           ← SDK final echo
 *  - {type:'tool_use', ...}                                     ← agent tool call
 *  - {type:'tool_result', ...}                                  ← agent tool result
 *  - {type:'thinking', ...}                                     ← agent thinking block
 *  - {type:'usage', ...}                                        ← telemetry chunks
 *  - {type:'telemetry', ...}                                    ← final per-turn entry
 *
 * For the simple readers below (getChatMessages, getPendingChatMessages) we
 * only need the canonical user/assistant rows that the chat detail route
 * renders. Anything we don't recognise falls back to a JSON string for safety.
 */
function extractEntryRole(entry: any): 'user' | 'assistant' | null {
  if (!entry || typeof entry !== 'object') return null;
  // Persona-boundary queue records are durable delivery state, not visible
  // transcript turns. They become canonical user messages only when consumed
  // at the next speaker boundary.
  if (entry.type === 'queued_user_message') return null;
  // Codex persists user-facing prose as a completed agent_message item.
  // Reasoning and command/tool items share the enclosing event shape, so only
  // this exact item type belongs in the ordinary chat transcript.
  if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
    return 'assistant';
  }
  if (
    entry.type === 'message' &&
    (entry.role === 'user' || entry.role === 'assistant')
  ) {
    return entry.role;
  }
  if (
    entry.message &&
    (entry.message.role === 'user' || entry.message.role === 'assistant')
  ) {
    return entry.message.role;
  }
  if (entry.role === 'user' || entry.role === 'assistant') return entry.role;
  return null;
}

function extractEntryContent(entry: any): string {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.type === 'item.completed' && entry.item?.type === 'agent_message') {
    if (typeof entry.item.text === 'string') return entry.item.text;
    if (typeof entry.item.content === 'string') return entry.item.content;
    if (Array.isArray(entry.item.content)) {
      return entry.item.content
        .map((part: any) =>
          typeof part === 'string'
            ? part
            : typeof part?.text === 'string'
              ? part.text
              : '',
        )
        .join('');
    }
    return '';
  }
  if (typeof entry.content === 'string') return entry.content;
  const msg = entry.message;
  if (msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('');
    }
  }
  if (typeof entry.result === 'string') return entry.result;
  if (typeof entry.text === 'string') return entry.text;
  return '';
}

function entryCreatedAt(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry as any;
  const candidates = [
    value.created_at,
    value.timestamp,
    value.item?.created_at,
    value.item?.timestamp,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) {
      return new Date(candidate).toISOString();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return new Date(
        candidate < 10_000_000_000 ? candidate * 1000 : candidate,
      ).toISOString();
    }
  }
  return null;
}

function stableContentHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function codexTurnTimestamp(entries: unknown[], index: number): string | null {
  // A turn_outcome is written after a streamed response. Prefer it over the
  // preceding user message so a later Codex turn is not displayed at the
  // conversation's creation time.
  for (let i = index + 1; i < entries.length; i++) {
    const entry = entries[i] as any;
    if (entry?.type === 'turn_outcome') return entryCreatedAt(entry);
    if (entry?.type === 'message' && entry.role === 'user') break;
  }
  for (let i = index - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type === 'message' && entry.role === 'user') {
      return entryCreatedAt(entry);
    }
    const timestamp = entryCreatedAt(entry);
    if (timestamp) return timestamp;
  }
  return null;
}

function transcriptEntryToChatMessage(
  entry: any,
  fallbackIndex: number,
  fallbackCreatedAt?: string,
): ChatMessage | null {
  const role = extractEntryRole(entry);
  if (!role) return null;
  const isCodexAgentMessage =
    entry.type === 'item.completed' && entry.item?.type === 'agent_message';
  const content = extractEntryContent(entry);
  if (isCodexAgentMessage && !content) return null;
  const created: ChatMessage = {
    id:
      entry.id ||
      entry.uuid ||
      entry.message?.id ||
      (isCodexAgentMessage ? entry.item?.id : undefined) ||
      (isCodexAgentMessage
        ? `codex-${fallbackCreatedAt ?? fallbackIndex}-${stableContentHash(content)}`
        : `t-${fallbackIndex}`),
    group_folder: '',
    role,
    content,
    sender_name: entry.sender_name ?? entry.message?.sender_name ?? null,
    senderUserId: entry.senderUserId ?? entry.message?.senderUserId ?? null,
    senderAvatarUrl:
      entry.senderAvatarUrl ?? entry.message?.senderAvatarUrl ?? null,
    source: entry.source ?? 'web',
    created_at:
      entryCreatedAt(entry) ??
      fallbackCreatedAt ??
      new Date(fallbackIndex).toISOString(),
    conversation_id:
      entry.conversation_id ?? entry.message?.conversation_id ?? null,
    objective_id: entry.objective_id ?? null,
    attachments: Array.isArray(entry.attachments) ? entry.attachments : null,
    clientSubmissionIds: Array.isArray(entry.clientSubmissionIds)
      ? entry.clientSubmissionIds.filter(
          (id: unknown): id is string => typeof id === 'string',
        )
      : undefined,
    telemetry:
      entry.telemetry && typeof entry.telemetry === 'object'
        ? entry.telemetry
        : null,
    emote: typeof entry.emote === 'string' ? entry.emote : null,
    speechText: typeof entry.speechText === 'string' ? entry.speechText : null,
  };
  return created;
}

/**
 * Read a conversation's transcript entries and project them to the ChatMessage
 * shape the DB rows used to expose. Returns entries newest-first to match the
 * prior `getChatMessages` ordering so consumers can keep doing `.reverse()`.
 */
function readChatTranscriptAsMessages(
  group_folder: string,
  conversation_id?: string,
  limit = 500,
  transcriptEntries = readChatTranscript(group_folder, conversation_id ?? ''),
): ChatMessage[] {
  transcriptEntries = mergeLateAudioTranscripts(transcriptEntries);
  const projected: ChatMessage[] = [];
  const projectedCodexMessageIds = new Set<string>();
  const seenGeneratedAttachmentUrls = new Set<string>();
  const fallbackBase = 946684800000; // Stable 2000-01-01 fallback for entries without a timestamp.
  const withdrawnMessageIds = withdrawnQueuedMessageIds(transcriptEntries);
  for (let i = 0; i < transcriptEntries.length; i++) {
    if (isProviderContextEntry(transcriptEntries[i])) continue;
    const candidate = transcriptEntries[i] as any;
    if (
      candidate?.type === 'message' &&
      candidate.role === 'user' &&
      withdrawnMessageIds.has(candidate.id)
    )
      continue;
    const isCodexAgentMessage =
      (transcriptEntries[i] as any)?.type === 'item.completed' &&
      (transcriptEntries[i] as any)?.item?.type === 'agent_message';
    const codexTimestamp = isCodexAgentMessage
      ? codexTurnTimestamp(transcriptEntries, i)
      : null;
    const m = transcriptEntryToChatMessage(
      transcriptEntries[i],
      fallbackBase + i,
      codexTimestamp ?? undefined,
    );
    if (!m) continue;
    // A recovered output stream can repeat its completed event. Item IDs are
    // stable within a Codex turn, unlike commentary/final messages which each
    // have their own item ID, so dedupe only identified repeats.
    if (isCodexAgentMessage) {
      const id = m.id;
      if (projectedCodexMessageIds.has(id)) continue;
      projectedCodexMessageIds.add(id);
    }
    if (!m.group_folder) m.group_folder = group_folder;
    if (
      (transcriptEntries[i] as any)?.type === 'attachments' &&
      Array.isArray(m.attachments)
    ) {
      const newAttachments = m.attachments.filter((attachment) => {
        const url = attachment?.url;
        if (!url) return true;
        if (seenGeneratedAttachmentUrls.has(url)) return false;
        seenGeneratedAttachmentUrls.add(url);
        return true;
      });
      const priorMessages = [...projected].reverse();
      const target =
        priorMessages.find(
          (candidate) => candidate.id === m.id && candidate.role === m.role,
        ) ?? priorMessages.find((candidate) => candidate.role === m.role);
      if (target) {
        target.attachments = [...(target.attachments || []), ...newAttachments];
        continue;
      }
    }
    projected.push(m);
  }
  return projected.slice(-limit).reverse();
}

export interface Conversation {
  id: string;
  group_folder: string;
  preview: string | null;
  title?: string | null;
  pinned?: number | null;
  publiclyShared?: boolean;
  created_at: string;
  read_at?: string | null;
  status?: ConversationStatus;
  lastAssistantOutcome?: 'success' | 'failed' | 'pending' | null;
  session_id?: string | null;
  forked_from?: string | null;
  use_worktree?: number | null;
  promptCache1h?: boolean;
  worktree_path?: string | null;
  worktreeMissing?: boolean;
  branch_name?: string | null;
  objective_id?: string | null;
  last_agent_cmd?: string | null;
  runtimeSelection?: {
    harnessId: string;
    modelId: string;
    reasoning?: string;
  } | null;
  /** Concrete model an Auto selection is pinned to; null until routed. */
  routedModel?: {
    modelId: string;
    harnessId: string | null;
    tier: string | null;
    routedAt: string;
  } | null;
  mainAiUserId?: string | null;
  mainAiUserMode?: 'inherit' | 'persona' | 'none';
  continuousPersonaLoop?: boolean;
  // Per-conversation timestamp aggregates, denormalized from the transcript.
  last_user_at?: string | null;
  last_assistant_at?: string | null;
  ownerUserId?: string | null;
  lastTriggeredByUserId?: string | null;
  lastTriggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
  lastTriggeredAt?: string | null;
  owner?: import('../kanban/types.js').AttributionUser | null;
  latestTrigger?: import('../kanban/types.js').TriggerMetadata;
}

const conversationSelect = {
  id: drizzleConversations.id,
  group_folder: drizzleConversations.group_folder,
  preview: drizzleConversations.preview,
  created_at: drizzleConversations.created_at,
  read_at: drizzleConversations.read_at,
  title: drizzleConversations.title,
  pinned: drizzleConversations.pinned,
  session_id: drizzleConversations.session_id,
  forked_from: drizzleConversations.forked_from,
  use_worktree: drizzleConversations.use_worktree,
  promptCache1h: drizzleConversations.promptCache1h,
  worktree_path: drizzleConversations.worktree_path,
  worktreeMissing: drizzleConversations.worktreeMissing,
  branch_name: drizzleConversations.branch_name,
  brain_managed: drizzleConversations.brain_managed,
  objective_id: drizzleConversations.objective_id,
  last_agent_cmd: drizzleConversations.last_agent_cmd,
  runtimeHarnessId: drizzleConversations.runtimeHarnessId,
  runtimeModelId: drizzleConversations.runtimeModelId,
  runtimeReasoning: drizzleConversations.runtimeReasoning,
  routedModelId: drizzleConversations.routedModelId,
  routedHarnessId: drizzleConversations.routedHarnessId,
  routedTier: drizzleConversations.routedTier,
  routedAt: drizzleConversations.routedAt,
  mainAiUserId: drizzleConversations.mainAiUserId,
  mainAiUserMode: drizzleConversations.mainAiUserMode,
  continuousPersonaLoop: drizzleConversations.continuousPersonaLoop,
  last_user_at: drizzleConversations.last_user_at,
  last_assistant_at: drizzleConversations.last_assistant_at,
  lastAssistantOutcome: drizzleConversations.lastAssistantOutcome,
  ownerUserId: drizzleConversations.ownerUserId,
  lastTriggeredByUserId: drizzleConversations.lastTriggeredByUserId,
  lastTriggerSource: drizzleConversations.lastTriggerSource,
  lastTriggeredAt: drizzleConversations.lastTriggeredAt,
};

const activePublicShare = sql<number>`case
  when ${conversationPublicShares.conversationId} is not null
    and ${conversationPublicShares.revokedAt} is null then 1
  else 0
end`;

const conversationListSelect = {
  ...conversationSelect,
  publiclyShared: activePublicShare,
};

function mapConversationRowsWithStatus(
  rows: Array<Record<string, unknown>>,
  runningNativeIds: ReadonlySet<string>,
): Conversation[] {
  return rows.map((row) => {
    const status = conversationStatusFromAggregates(
      row,
      runningNativeIds.has(row.id as string),
    );
    return { ...mapConversationRow(row), status } as Conversation;
  });
}

function mapConversationRow(row: any): Conversation {
  const {
    runtimeHarnessId,
    runtimeModelId,
    runtimeReasoning,
    routedModelId,
    routedHarnessId,
    routedTier,
    routedAt,
    ...rest
  } = row;
  return {
    ...rest,
    ...('publiclyShared' in row
      ? { publiclyShared: Boolean(row.publiclyShared) }
      : {}),
    continuousPersonaLoop: row.continuousPersonaLoop !== 0,
    promptCache1h: row.promptCache1h === 1,
    worktreeMissing: row.worktreeMissing !== 0,
    runtimeSelection:
      runtimeHarnessId && runtimeModelId
        ? {
            harnessId: runtimeHarnessId,
            modelId: runtimeModelId,
            ...(runtimeReasoning ? { reasoning: runtimeReasoning } : {}),
          }
        : null,
    routedModel:
      routedModelId && routedAt
        ? {
            modelId: routedModelId,
            harnessId: routedHarnessId ?? null,
            tier: routedTier ?? null,
            routedAt,
          }
        : null,
  } as Conversation;
}

async function attachConversationAttribution<T extends Conversation>(
  items: T[],
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
    ? await drizzleDbRef.current
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          avatarPath: users.avatarPath,
        })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const presented = await Promise.all(
    rows.map(async (row) => {
      const identity = await presentAccountIdentity(row);
      return [
        row.id,
        {
          id: identity.id,
          username: identity.username,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        },
      ] as const;
    }),
  );
  const byId = new Map(presented);
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
  }));
}

/**
 * Update `last_user_at`, `last_assistant_at` and related aggregate columns on
 * a conversation. This is the single write-through projection used by both: (1)
 * the live message-write path (`saveChatMessage` / `appendIncomingMessage`)
 * AND (2) the drift-recovery path
 * (`rebuildConversationAggregatesFromTranscript`). The value written is always
 * the MAX of previous + new so we never regress — transcripts are the source
 * of truth and aggregates are only a fast cache.
 *
 * Rows that predate the aggregation columns stay at NULL until either (a) a new message arrives (the
 * live write path) or (b) `rebuildConversationAggregatesFromTranscript()`
 * is invoked explicitly to rebuild them from the JSONL transcript. The
 * per-conversation `rebuildConversationAggregatesFromTranscript()` handles
 * on-demand recovery from a single transcript file.
 */
export async function updateConversationAggregate(
  group_folder: string,
  conversation_id: string,
  opts: {
    role?: 'user' | 'assistant';
    created_at?: string;
    model_name?: string;
    outcome?: 'success' | 'failed' | 'pending';
  },
): Promise<void> {
  if (!conversation_id) return;
  const ts = opts.created_at || new Date().toISOString();

  // Build the SET clause so we never assign a value that's older than what's
  // already in `conversations.<col>` (MAX semantics). GREATEST() returns
  // the larger of two text values, which works for ISO-8601 timestamps
  // (lexicographic order matches chronological order). GREATEST(col, ts)
  // already handles NULL — it skips NULL operands and returns the non-null
  // one — so no extra COALESCE is needed.
  const data: Record<string, any> = {};
  let hasUpdates = false;
  if (opts.role === 'user' || opts.role === undefined) {
    // Use GREATEST so out-of-order writes (notably from `recovery.ts`
    // backfills replaying historical turns) can't regress the timestamp;
    // COALESCE would only fill NULL and lock in the older value forever,
    // mislabeling conversations as stuck.
    data.last_user_at = sql`GREATEST(${drizzleConversations.last_user_at}, ${ts})`;
    hasUpdates = true;
  }
  if (opts.role === 'assistant') {
    // GREATEST(existing, ts) — not COALESCE — because out-of-order writes
    // (notably from `recovery.ts` backfills, which replay historical turns)
    // can deliver an older ts after a newer one. COALESCE would only fill
    // NULLs and lock in the older value forever, regressing the sidebar's
    // "last activity" marker and mislabeling conversations as stuck.
    data.last_assistant_at = sql`GREATEST(${drizzleConversations.last_assistant_at}, ${ts})`;
    if (opts.outcome) {
      data.lastAssistantOutcome = sql`CASE
        WHEN ${drizzleConversations.last_assistant_at} IS NULL
          OR ${ts} >= ${drizzleConversations.last_assistant_at}
        THEN ${opts.outcome}
        ELSE ${drizzleConversations.lastAssistantOutcome}
      END`;
    }
    hasUpdates = true;
  }
  if (!hasUpdates) return;

  await drizzleDbRef.current
    .update(drizzleConversations)
    .set(data)
    .where(
      and(
        eq(drizzleConversations.group_folder, group_folder),
        eq(drizzleConversations.id, conversation_id),
      ),
    )
    .execute();
}

/**
 * Rebuild a single conversation's `last_user_at` / `last_assistant_at`
 * aggregates from the on-disk chat transcript JSONL
 * (`groups/<folder>/transcripts/chat-<conv>.output.jsonl`). The transcript is
 * the source of truth while it exists — these aggregates are a denormalized
 * cache so the sidebar / `getStuckWorkingConversations` queries don't need
 * a `max(created_at)` scan over a per-row table.
 *
 * Scans the JSONL, takes the max `created_at` for entries whose `role` is
 * `'user'` and `'assistant'` respectively, and writes both via
 * `updateConversationAggregate()` — so a partially-populated column can never
 * be regressed by a transcript that lacks one of the two (the GREATEST
 * semantics inside `updateConversationAggregate` keep the existing max).
 *
 * Idempotent. Safe to call on demand (operator action, manual recovery
 * tool, replay scripts) for any conversation whose aggregate columns
 * were never populated (e.g. rows that predate migration 0001).
 *
 * Returns the resulting `last_user_at` / `last_assistant_at` (or null when
 * no matching entries were found).
 */
export async function rebuildConversationAggregatesFromTranscript(
  group_folder: string,
  conversation_id: string,
): Promise<{ last_user_at: string | null; last_assistant_at: string | null }> {
  if (!group_folder || !conversation_id) {
    return { last_user_at: null, last_assistant_at: null };
  }

  const entries = readChatTranscript(group_folder, conversation_id);
  let lastUserAt: string | null = null;
  let lastAssistantAt: string | null = null;
  let lastAssistantOutcome: 'success' | 'failed' | 'pending' | undefined;

  for (const raw of entries) {
    const entry = raw as {
      type?: string;
      role?: string;
      created_at?: unknown;
      failed?: unknown;
      pending?: unknown;
    };
    if (isProviderContextEntry(entry)) continue;
    if (entry?.type !== 'message' && entry?.type !== 'turn_outcome') continue;
    const ts = typeof entry.created_at === 'string' ? entry.created_at : null;
    if (!ts) continue;
    if (entry.type === 'turn_outcome') {
      if (lastAssistantAt === null || ts >= lastAssistantAt) {
        lastAssistantAt = ts;
        lastAssistantOutcome = assistantOutcome(entry.pending, entry.failed);
      }
      continue;
    }
    if (entry.role === 'user') {
      if (lastUserAt === null || ts > lastUserAt) lastUserAt = ts;
    } else if (entry.role === 'assistant') {
      if (lastAssistantAt === null || ts > lastAssistantAt) {
        lastAssistantAt = ts;
        lastAssistantOutcome = assistantOutcome(entry.pending, entry.failed);
      }
    }
  }

  // Both writes go through `updateConversationAggregate` so we re-use the
  // GREATEST semantics — calling this on a row that's already ahead of the
  // transcript (e.g. a newer message has arrived since the JSONL was
  // written) never regresses the existing aggregate.
  if (lastUserAt) {
    await updateConversationAggregate(group_folder, conversation_id, {
      role: 'user',
      created_at: lastUserAt,
    });
  }
  if (lastAssistantAt) {
    await updateConversationAggregate(group_folder, conversation_id, {
      role: 'assistant',
      created_at: lastAssistantAt,
      outcome: lastAssistantOutcome,
    });
  }

  return { last_user_at: lastUserAt, last_assistant_at: lastAssistantAt };
}

export async function saveChatMessage(
  data: Omit<ChatMessage, 'id'> & { id?: string; skipTranscript?: boolean },
): Promise<ChatMessage> {
  const rand = Math.random().toString(36).substring(2, 8);
  const id = data.id || `chat-${Date.now()}-${rand}`;
  const persistedContent =
    data.role === 'assistant'
      ? sanitizePersistedAssistantProse(data.content)
      : data.content;

  // The JSONL transcript is the canonical chat store for message content and
  // per-turn telemetry; the conversation aggregates (`last_user_at` /
  // `last_assistant_at`) are maintained as a write-through projection below.

  if (data.conversation_id && !data.skipTranscript) {
    // The transcript is the canonical store for both content AND per-turn
    // telemetry. The single message entry below carries the content; the
    // companion `type: 'telemetry'` line (when present) carries the
    // consolidated run metrics. The chat detail route merges the two on
    // reload so a reloaded message renders the same telemetry the live
    // bubble showed.
    //
    // `conversation_id` is included on every entry so transcript-based reads
    // can still filter by conversation — this used to be a DB column and
    // `getChatMessages(GROUP, limit, conversation_id)` callers relied on it
    // to scope results.
    await appendChatTranscriptEntryAsync(
      data.group_folder,
      data.conversation_id,
      {
        id,
        type: 'message',
        role: data.role,
        content: persistedContent,
        sender_name: data.sender_name ?? undefined,
        senderUserId: data.senderUserId ?? undefined,
        source: data.source ?? undefined,
        publicInteractionId: data.publicInteractionId ?? undefined,
        attachments: data.attachments,
        deepLinks: data.deepLinks,
        clientSubmissionIds: data.clientSubmissionIds,
        telemetry: data.telemetry,
        emote: data.emote ?? undefined,
        speechText: data.speechText ?? undefined,
        failed: data.role === 'assistant' ? data.failed === true : undefined,
        pending: data.role === 'assistant' ? data.pending === true : undefined,
        created_at: data.created_at,
        conversation_id: data.conversation_id,
        objective_id: data.objective_id ?? undefined,
      },
    );
  }

  // Always append a consolidated-telemetry companion entry when one is
  // provided, regardless of `skipTranscript`. The streaming callers (web
  // chat, WhatsApp, objectives, push responses) pass `skipTranscript: true`
  // because they already wrote the message entry incrementally via
  // `appendChatTranscriptEntry` during streaming — but they ALSO need the
  // post-run telemetry (duration_ms, context_size, total_tokens, tok_context
  // _last, session_id, cache stats) to land on the right bubble when the
  // page reloads. Gating this branch on `!skipTranscript` (the previous
  // behavior) silently dropped the consolidated telemetry for every live
  // save, leaving `extractTelemetry` to recover only the per-chunk usage
  // counters — i.e. no duration / context / session / cache info.
  //
  // Sharing the same `id` as the (already-written) message entry ties the
  // telemetry line to its turn; the chat-page renderer accumulates it into
  // the assistant segment being built at this file position.
  if (
    data.conversation_id &&
    data.telemetry &&
    typeof data.telemetry === 'object'
  ) {
    await appendChatTranscriptEntryAsync(
      data.group_folder,
      data.conversation_id,
      {
        id,
        type: 'telemetry',
        role: data.role,
        telemetry: data.telemetry,
        created_at: data.created_at,
        conversation_id: data.conversation_id,
        objective_id: data.objective_id ?? undefined,
      },
    );
  }

  // Streaming agents already wrote their prose to the transcript before the
  // terminal outcome was known. Add a metadata-only marker so transcript
  // rebuilds can recover the outcome without matching error text. Keep it
  // after telemetry because message→telemetry adjacency is part of the
  // transcript contract used by replay and cost readers.
  if (
    data.conversation_id &&
    data.role === 'assistant' &&
    data.skipTranscript
  ) {
    await appendChatTranscriptEntryAsync(
      data.group_folder,
      data.conversation_id,
      {
        id: `${id}-outcome`,
        messageId: id,
        type: 'turn_outcome',
        failed: data.failed === true,
        pending: data.pending === true,
        created_at: data.created_at,
        conversation_id: data.conversation_id,
        objective_id: data.objective_id ?? undefined,
      },
    );
  }

  // Streaming paths already persisted assistant prose incrementally. Preserve
  // generated-image attachments without duplicating that prose by appending a
  // small companion entry tied to the same message id.
  if (
    data.conversation_id &&
    data.skipTranscript &&
    Array.isArray(data.attachments) &&
    data.attachments.length > 0
  ) {
    await appendChatTranscriptEntryAsync(
      data.group_folder,
      data.conversation_id,
      {
        id,
        type: 'attachments',
        role: data.role,
        content: '',
        attachments: data.attachments,
        created_at: data.created_at,
        conversation_id: data.conversation_id,
        objective_id: data.objective_id ?? undefined,
      },
    );
  }

  // Single write-through projection: keep `conversations.last_user_at` /
  // `conversations.last_assistant_at` aligned with the transcript so the
  // sidebar and `getStuckWorkingConversations` never need a max() over
  // chat_messages. Aggregates are a fast cache; the transcript is the truth.
  if (data.conversation_id) {
    try {
      await updateConversationAggregate(
        data.group_folder,
        data.conversation_id,
        {
          role: data.role,
          created_at: data.created_at,
          outcome:
            data.role === 'assistant'
              ? assistantOutcome(data.pending, data.failed)
              : undefined,
        },
      );
    } catch (err) {
      logger.warn(
        { err, conversation_id: data.conversation_id, role: data.role },
        'Failed to update conversation aggregate after saveChatMessage',
      );
    }
  }

  return { ...data, content: persistedContent, id };
}

const queuedChatConsumptionClaims = new Map<string, Promise<void>>();

export async function withQueuedChatMessageClaim<T>(
  groupFolder: string,
  conversationId: string,
  messageId: string,
  action: () => Promise<T>,
): Promise<T> {
  const claimKey = `${groupFolder}:${conversationId}:${messageId}`;
  const previous =
    queuedChatConsumptionClaims.get(claimKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  queuedChatConsumptionClaims.set(claimKey, chained);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queuedChatConsumptionClaims.get(claimKey) === chained) {
      queuedChatConsumptionClaims.delete(claimKey);
    }
  }
}

export async function consumeQueuedChatMessageExactlyOnce(
  message: ChatMessage,
  receipt?: { consumer?: string; runId?: string },
): Promise<{ won: boolean; message?: ChatMessage }> {
  const conversationId = message.conversation_id;
  if (!conversationId) return { won: false };
  return withQueuedChatMessageClaim(
    message.group_folder,
    conversationId,
    message.id,
    async () => {
      const entries = readChatTranscript(message.group_folder, conversationId);
      const terminal = entries.find(
        (entry: any) =>
          (entry?.type === 'queued_user_consumed' ||
            entry?.type === 'queued_user_withdrawn') &&
          entry?.messageId === message.id,
      );
      if (terminal) return { won: false };
      const released = entries.some(
        (entry: any) =>
          entry?.type === 'queued_user_released' &&
          entry?.messageId === message.id,
      );
      const claimed = entries.find(
        (entry: any) =>
          entry?.type === 'queued_user_claimed' &&
          entry?.messageId === message.id,
      ) as Record<string, unknown> | undefined;
      if (
        (claimed &&
          (typeof claimed.runId !== 'string' ||
            claimed.runId !== receipt?.runId)) ||
        (released && !claimed)
      ) {
        return { won: false };
      }
      const canonicalExists = entries.some(
        (entry: any) => entry?.type === 'message' && entry?.id === message.id,
      );
      if (canonicalExists) {
        await appendChatTranscriptEntryAsync(
          message.group_folder,
          conversationId,
          {
            type: 'queued_user_consumed',
            messageId: message.id,
            ...receipt,
            created_at: new Date().toISOString(),
            conversation_id: conversationId,
          },
        );
        return { won: false };
      }
      const delivered = await saveChatMessage({
        ...message,
        id: message.id,
        created_at: new Date().toISOString(),
      });
      await appendChatTranscriptEntryAsync(
        message.group_folder,
        conversationId,
        {
          type: 'queued_user_consumed',
          messageId: message.id,
          ...receipt,
          created_at: new Date().toISOString(),
          conversation_id: conversationId,
        },
      );
      return { won: true, message: delivered };
    },
  );
}

/** Direct follow-ups the running DirectLLM turn has injected into its provider
 * conversation but whose durable `steered` receipt is not written yet. Guarded
 * by the per-message claim so absorption and withdrawal are mutually exclusive. */
const absorbedDirectSteering = new Set<string>();

function absorbedDirectSteeringKey(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): string {
  return `${groupFolder}:${conversationId}:${messageId}`;
}

/** Atomically decide whether the running turn may absorb a steering
 * candidate. Returns false when the user already withdrew it or when only its
 * own Direct follow-up may run it. */
export async function absorbDirectSteeringCandidate(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  return withQueuedChatMessageClaim(
    groupFolder,
    conversationId,
    messageId,
    async () => {
      const refused = readChatTranscript(groupFolder, conversationId).some(
        (entry: any) =>
          (entry?.type === 'queued_user_withdrawn' &&
            entry?.messageId === messageId) ||
          (entry?.type === 'queued_user_message' &&
            entry?.id === messageId &&
            entry?.directOwned === true),
      );
      if (refused) return false;
      absorbedDirectSteering.add(
        absorbedDirectSteeringKey(groupFolder, conversationId, messageId),
      );
      return true;
    },
  );
}

/** Forget in-flight absorptions once their receipt is durable or the turn
 * ended without one, so an unanswered message becomes withdrawable again. */
export function releaseAbsorbedDirectSteering(
  groupFolder: string,
  conversationId: string,
  messageIds: Iterable<string>,
): void {
  for (const messageId of messageIds) {
    absorbedDirectSteering.delete(
      absorbedDirectSteeringKey(groupFolder, conversationId, messageId),
    );
  }
}

/** Withdraw a durable persona-boundary prompt or an unclaimed Direct
 * follow-up before the browser edits, deletes, or sends it immediately. The shared claim prevents a withdrawal
 * from racing the speaker-boundary consumer. */
export async function withdrawQueuedChatMessageExactlyOnce(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): Promise<{ withdrawn: boolean; released: boolean }> {
  return withQueuedChatMessageClaim(
    groupFolder,
    conversationId,
    messageId,
    async () => {
      const entries = readChatTranscript(groupFolder, conversationId);
      const directPending = entries.some(
        (entry: any) =>
          entry?.type === 'direct_user_pending' &&
          entry?.messageId === messageId,
      );
      const queued =
        directPending ||
        entries.some(
          (entry: any) =>
            entry?.type === 'queued_user_message' && entry?.id === messageId,
        );
      if (!queued) return { withdrawn: false, released: false };
      const released = entries.some(
        (entry: any) =>
          entry?.type === 'queued_user_released' &&
          entry?.messageId === messageId,
      );
      const terminal = entries.some(
        (entry: any) =>
          (entry?.type === 'queued_user_consumed' ||
            entry?.type === 'queued_user_withdrawn' ||
            entry?.type === 'queued_user_claimed' ||
            (entry?.type === 'steering_delivery' &&
              entry?.delivery === 'steered')) &&
          entry?.messageId === messageId,
      );
      if (terminal) return { withdrawn: false, released: false };
      if (
        directPending &&
        absorbedDirectSteering.has(
          absorbedDirectSteeringKey(groupFolder, conversationId, messageId),
        )
      ) {
        return { withdrawn: false, released: false };
      }
      // A Direct follow-up always has its canonical row. Until it is claimed,
      // the claim lock makes the withdrawal marker authoritative: the claim
      // path skips withdrawn ids and transcript readers hide the row.
      const canonicalExists =
        !directPending &&
        entries.some(
          (entry: any) => entry?.type === 'message' && entry?.id === messageId,
        );
      if (canonicalExists) {
        await appendChatTranscriptEntryAsync(groupFolder, conversationId, {
          type: 'queued_user_consumed',
          messageId,
          created_at: new Date().toISOString(),
          conversation_id: conversationId,
        });
        return { withdrawn: false, released: false };
      }
      if (released) return { withdrawn: false, released: true };
      await appendChatTranscriptEntryAsync(groupFolder, conversationId, {
        type: 'queued_user_withdrawn',
        messageId,
        created_at: new Date().toISOString(),
        conversation_id: conversationId,
      });
      return { withdrawn: true, released: false };
    },
  );
}

export async function releaseUnconsumedQueuedChatMessages(
  groupFolder: string,
  conversationId: string,
  claimReleased?: (messageId: string) => Promise<string | undefined>,
): Promise<string[]> {
  const entries = readChatTranscript(groupFolder, conversationId);
  const terminalIds = new Set<string>();
  const canonicalIds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (value.type === 'message' && typeof value.id === 'string') {
      canonicalIds.add(value.id);
    }
    if (
      (value.type === 'queued_user_consumed' ||
        value.type === 'queued_user_released' ||
        value.type === 'queued_user_withdrawn' ||
        (value.type === 'steering_delivery' && value.delivery === 'steered')) &&
      typeof value.messageId === 'string'
    ) {
      terminalIds.add(value.messageId);
    }
  }
  const releasable = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    if (
      value.type === 'direct_user_pending' &&
      typeof value.messageId === 'string' &&
      !terminalIds.has(value.messageId)
    ) {
      return [value.messageId];
    }
    return value.type === 'queued_user_message' &&
      typeof value.id === 'string' &&
      !terminalIds.has(value.id) &&
      !canonicalIds.has(value.id)
      ? [value.id]
      : [];
  });
  const browserOwned: string[] = [];
  for (const messageId of new Set(releasable)) {
    const released = await withQueuedChatMessageClaim(
      groupFolder,
      conversationId,
      messageId,
      async () => {
        const currentEntries = readChatTranscript(groupFolder, conversationId);
        const currentTerminal = currentEntries.some(
          (entry: any) =>
            (entry?.type === 'queued_user_consumed' ||
              entry?.type === 'queued_user_released' ||
              entry?.type === 'queued_user_withdrawn' ||
              entry?.type === 'queued_user_claimed' ||
              (entry?.type === 'steering_delivery' &&
                entry?.delivery === 'steered')) &&
            entry?.messageId === messageId,
        );
        if (currentTerminal) return false;
        await appendChatTranscriptEntryAsync(groupFolder, conversationId, {
          type: 'queued_user_released',
          messageId,
          created_at: new Date().toISOString(),
          conversation_id: conversationId,
        });
        const claimedRunId = await claimReleased?.(messageId);
        if (claimedRunId) {
          await appendChatTranscriptEntryAsync(groupFolder, conversationId, {
            type: 'queued_user_claimed',
            messageId,
            runId: claimedRunId,
            created_at: new Date().toISOString(),
            conversation_id: conversationId,
          });
          return false;
        }
        return true;
      },
    );
    if (released) browserOwned.push(messageId);
  }
  return browserOwned;
}

export function getQueuedChatMessageStates(
  groupFolder: string,
  conversationId: string,
): {
  pending: string[];
  consumed: string[];
  released: string[];
  withdrawn: string[];
  queueOwners: Record<string, 'persona' | 'direct'>;
} {
  const entries = readChatTranscript(groupFolder, conversationId);
  const queued: string[] = [];
  const queuedIds = new Set<string>();
  const directPending = new Set<string>();
  const consumed = new Set<string>();
  const released = new Set<string>();
  const claimed = new Set<string>();
  const withdrawn = new Set<string>();
  const canonical = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (value.type === 'queued_user_message' && typeof value.id === 'string') {
      queued.push(value.id);
      queuedIds.add(value.id);
    }
    if (
      value.type === 'direct_user_pending' &&
      typeof value.messageId === 'string'
    ) {
      queued.push(value.messageId);
      queuedIds.add(value.messageId);
      directPending.add(value.messageId);
    }
    if (value.type === 'message' && typeof value.id === 'string')
      canonical.add(value.id);
    if (
      value.type === 'queued_user_consumed' &&
      typeof value.messageId === 'string'
    )
      consumed.add(value.messageId);
    if (
      value.type === 'queued_user_released' &&
      typeof value.messageId === 'string'
    )
      released.add(value.messageId);
    if (
      value.type === 'queued_user_claimed' &&
      typeof value.messageId === 'string'
    )
      claimed.add(value.messageId);
    if (
      value.type === 'queued_user_withdrawn' &&
      typeof value.messageId === 'string'
    )
      withdrawn.add(value.messageId);
    if (
      value.type === 'steering_delivery' &&
      value.delivery === 'steered' &&
      typeof value.messageId === 'string'
    )
      consumed.add(value.messageId);
  }
  for (const id of canonical) {
    if (queuedIds.has(id) && !directPending.has(id)) consumed.add(id);
  }
  return {
    pending: queued.filter(
      (id) => !consumed.has(id) && !released.has(id) && !withdrawn.has(id),
    ),
    consumed: [...consumed],
    released: [...released].filter(
      (id) => !claimed.has(id) && !consumed.has(id) && !withdrawn.has(id),
    ),
    withdrawn: [...withdrawn].filter((id) => !consumed.has(id)),
    queueOwners: Object.fromEntries(
      queued.flatMap((id) => {
        if (consumed.has(id) || released.has(id) || withdrawn.has(id))
          return [];
        return [[id, directPending.has(id) ? 'direct' : 'persona']];
      }),
    ),
  };
}

/** Reconstruct the ownership acknowledgement for an idempotent DirectLLM
 * submission retry. Transcript receipts are authoritative across HTTP loss and
 * process-local steering state. */
export function getDirectChatMessageDelivery(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): 'pending' | 'steered' | 'released' | 'followup' | undefined {
  let admitted = false;
  let followupStarted = false;
  let delivery: 'steered' | 'released' | undefined;
  for (const entry of readChatTranscript(groupFolder, conversationId)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (value.type === 'direct_user_pending' && value.messageId === messageId) {
      admitted = true;
    } else if (
      value.type === 'queued_user_consumed' &&
      value.messageId === messageId
    ) {
      followupStarted = true;
    } else if (
      value.type === 'queued_user_claimed' &&
      value.messageId === messageId
    ) {
      followupStarted = true;
    } else if (
      value.type === 'steering_delivery' &&
      value.delivery === 'steered' &&
      value.messageId === messageId
    ) {
      delivery = 'steered';
    } else if (
      value.type === 'queued_user_released' &&
      value.messageId === messageId &&
      delivery !== 'steered'
    ) {
      delivery = 'released';
    }
  }
  if (delivery === 'steered') return delivery;
  if (admitted && followupStarted) return 'followup';
  return delivery ?? (admitted ? 'pending' : undefined);
}

/**
 * Read chat messages for a conversation (or all conversations in a group)
 * from the JSONL transcript — the canonical store. Returns entries
 * newest-first, matching the prior DB shape so consumers can keep doing
 * `.reverse()` without changing their pagination math.
 *
 * The transcript is now the single source of truth for chat message
 * CONTENT (text, tool calls, tool results, attachments, sender, source) and
 * for PER-TURN TELEMETRY (model, token counts, context size, duration,
 * session id) — written by `saveChatMessage` and by the live streaming
 * append path. Retired the dual `chat_messages` DB row in favor of this
 * file-backed read in the prior task.
 */
export function getChatMessageById(
  groupFolder: string,
  conversationId: string,
  messageId: string,
): ChatMessage | undefined {
  const entries = readChatTranscript(groupFolder, conversationId);
  const index = entries.findIndex(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      'type' in entry &&
      entry.type === 'message' &&
      'id' in entry &&
      entry.id === messageId,
  );
  if (index < 0) return undefined;
  const message = transcriptEntryToChatMessage(entries[index], index);
  if (!message || message.role !== 'user') return undefined;
  return {
    ...message,
    group_folder: groupFolder,
    conversation_id: conversationId,
  };
}

export async function getChatMessages(
  group_folder: string,
  limit = 100,
  conversation_id?: string,
): Promise<ChatMessage[]> {
  return readChatTranscriptAsMessages(group_folder, conversation_id, limit);
}

/**
 * Read user-role messages from a conversation's transcript whose
 * `created_at >= since`, oldest-first. Used by the direct-LLM steering
 * loop to surface injected user messages to the in-flight agent without
 * hitting the (now-retired) DB table.
 */
export async function getPendingChatMessages(
  group_folder: string,
  conversation_id: string,
  since: string,
): Promise<ChatMessage[]> {
  const transcriptEntries = readChatTranscript(group_folder, conversation_id);
  const openFileContexts = openFileContextsByMessageId(transcriptEntries);
  const deliveredIds = steeredChatMessageIdsFromTranscript(transcriptEntries);
  const consumedQueuedIds = new Set(
    transcriptEntries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      return (value.type === 'queued_user_consumed' ||
        value.type === 'queued_user_released' ||
        value.type === 'queued_user_withdrawn') &&
        typeof value.messageId === 'string'
        ? [value.messageId]
        : [];
    }),
  );
  const entries = readChatTranscriptAsMessages(
    group_folder,
    conversation_id,
    1000,
    transcriptEntries,
  );
  const canonicalIds = new Set(entries.map((message) => String(message.id)));
  const queuedRecordIds = new Set(
    transcriptEntries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      return value.type === 'queued_user_message' &&
        typeof value.id === 'string'
        ? [value.id]
        : [];
    }),
  );
  // `readChatTranscriptAsMessages` returns newest-first; flip for chronological
  // iteration and filter on role/since to mirror the old DB query.
  const chrono = [...entries].reverse();
  const candidates = chrono.filter(
    (m) =>
      m.role === 'user' &&
      m.created_at >= since &&
      !consumedQueuedIds.has(String(m.id)) &&
      // A canonical row sharing a durable queued record's stable ID proves
      // that consumption already won, even if its receipt append was
      // interrupted. Do not offer that row to a later boundary again.
      !queuedRecordIds.has(String(m.id)),
  );
  const queued = transcriptEntries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    if (
      value.type !== 'queued_user_message' ||
      value.directOwned === true ||
      value.role !== 'user' ||
      typeof value.id !== 'string' ||
      typeof value.content !== 'string' ||
      typeof value.created_at !== 'string' ||
      consumedQueuedIds.has(value.id) ||
      canonicalIds.has(value.id)
    ) {
      return [];
    }
    return [
      {
        ...value,
        id: value.id,
        content: value.content,
        created_at: value.created_at,
        role: 'user' as const,
        group_folder,
        source: typeof value.source === 'string' ? value.source : 'web',
        conversation_id,
      } as ChatMessage,
    ];
  });
  const transcriptOrderById = new Map<string, number>();
  transcriptEntries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === 'string') transcriptOrderById.set(id, index);
  });
  const orderedCandidates = [...candidates, ...queued].sort(
    (left, right) =>
      (transcriptOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (transcriptOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const pending = await Promise.all(
    orderedCandidates.map(async (message) => {
      const delivery = pendingSteeringDeliveries.get(message.id);
      // prettier-ignore
      if (delivery && await delivery.promise) return null;
      if (deliveredIds.has(message.id) || steeredChatMessageIds.has(message.id))
        return null;
      return message;
    }),
  );
  return pending
    .filter((message): message is ChatMessage => message !== null)
    .map((message) => {
      const context = openFileContexts.get(String(message.id));
      return context
        ? {
            ...message,
            executionContent: appendOpenFileContext(message.content, context),
          }
        : message;
    });
}

export async function createConversation(
  group_folder: string,
  opts?: {
    use_worktree?: boolean;
    branch_name?: string | null;
    promptCache1h?: boolean;
    /** Marks an objective chat; the only other difference from a project chat. */
    objective_id?: string | null;
    ownerUserId?: string | null;
    triggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
  },
): Promise<Conversation> {
  const rand = Math.random().toString(36).substring(2, 8);
  const id = `conv-${Date.now()}-${rand}`;
  const created_at = new Date().toISOString();
  const useWt = opts?.use_worktree ? 1 : 0;
  // Only bind a branch when worktree mode is on; null means "new worktree" (chat-{id}).
  const branch_name = useWt ? opts?.branch_name || null : null;
  let ownerUserId = opts?.ownerUserId ?? null;

  const insertConversation = async (tx: any) => {
    if (!ownerUserId) {
      const [project] = await tx
        .select({ userId: projects.user_id })
        .from(projects)
        .where(eq(projects.id, group_folder))
        .limit(1);
      ownerUserId = project?.userId ?? null;
    }
    await tx.insert(drizzleConversations).values({
      id,
      group_folder,
      preview: null,
      created_at: created_at,
      read_at: null,
      title: null,
      pinned: 0,
      session_id: null,
      forked_from: null,
      use_worktree: useWt,
      promptCache1h: opts?.promptCache1h ? 1 : 0,
      worktree_path: null,
      branch_name,
      brain_managed: 0,
      objective_id: opts?.objective_id ?? null,
      last_agent_cmd: null,
      ownerUserId,
      lastTriggeredByUserId:
        opts?.triggerSource === 'user' ? ownerUserId : null,
      lastTriggerSource: opts?.triggerSource ?? 'system',
      lastTriggeredAt: opts?.triggerSource ? created_at : null,
    });
  };
  if (useWt) {
    const admission = await withConversationWorktreeAdmission(
      group_folder,
      branch_name || `chat-${id}`,
      'admission',
      insertConversation,
    );
    if (!admission.admitted) {
      throw new ConversationWorktreeTransitionInProgressError(
        group_folder,
        branch_name || `chat-${id}`,
      );
    }
  } else {
    await insertConversation(drizzleDbRef.current);
  }

  const createdConversation: Conversation = {
    id,
    group_folder: group_folder,
    preview: null,
    created_at,
    use_worktree: useWt,
    promptCache1h: opts?.promptCache1h === true,
    pinned: 0,
    objective_id: opts?.objective_id ?? null,
    title: null,
    read_at: null,
    session_id: null,
    forked_from: null,
    worktree_path: null,
    branch_name,
    mainAiUserId: null,
    mainAiUserMode: 'inherit',
    continuousPersonaLoop: false,
    ownerUserId,
    lastTriggeredByUserId: opts?.triggerSource === 'user' ? ownerUserId : null,
    lastTriggerSource: opts?.triggerSource ?? 'system',
    lastTriggeredAt: opts?.triggerSource ? created_at : null,
  };
  return (await attachConversationAttribution([createdConversation]))[0];
}

export function createObjectiveConversation(
  group_folder: string,
  objective_id: string,
  opts?: {
    ownerUserId?: string | null;
    triggerSource?: TriggerSource;
  },
): Promise<Conversation> {
  return createConversation(group_folder, { ...opts, objective_id });
}

/**
 * Conversations of an objective. A fork reports its `created_at` as
 * `forkedAt`: its transcript starts with the parent's entries, which the
 * parent already counts.
 */
export async function getObjectiveConversations(
  groupFolder: string,
  objectiveId: string,
): Promise<Array<{ id: string; forkedAt: string | null }>> {
  const rows = await drizzleDbRef.current
    .select({
      id: drizzleConversations.id,
      created_at: drizzleConversations.created_at,
      forked_from: drizzleConversations.forked_from,
    })
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.group_folder, groupFolder),
        eq(drizzleConversations.objective_id, objectiveId),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    forkedAt: row.forked_from ? row.created_at : null,
  }));
}

export async function getConversation(
  conversation_id: string,
): Promise<Conversation | undefined> {
  const q = drizzleDbRef.current
    .select(conversationSelect)
    .from(drizzleConversations)
    .where(eq(drizzleConversations.id, conversation_id));
  const rows = await q;
  return rows[0]
    ? (await attachConversationAttribution([mapConversationRow(rows[0])]))[0]
    : undefined;
}

/**
 * The activity time of conversations the Now list times its rows by: the
 * last assistant reply, falling back to the creation time. Conversations that
 * do not exist are absent from the result.
 *
 * The Now row of a conversation the agent replied to while the user was
 * speaking is timed by the conversation itself, not by the notification that
 * brought it to the attention list.
 */
export async function getConversationActivityTimes(
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  const times = new Map<string, string>();
  if (conversationIds.length === 0) return times;
  const rows = await drizzleDbRef.current
    .select({
      id: drizzleConversations.id,
      createdAt: drizzleConversations.created_at,
      lastAssistantAt: drizzleConversations.last_assistant_at,
    })
    .from(drizzleConversations)
    .where(inArray(drizzleConversations.id, [...conversationIds]));
  for (const row of rows) {
    times.set(row.id, row.lastAssistantAt ?? row.createdAt);
  }
  return times;
}

export class ConversationWorktreeInUseError extends Error {
  constructor(public readonly conversationIds: string[]) {
    super('Wait for the active conversation runs to finish first');
    this.name = 'ConversationWorktreeInUseError';
  }
}

export class ConversationWorktreeTransitionInProgressError extends Error {
  constructor(
    public readonly groupFolder: string,
    public readonly branch: string,
  ) {
    super('Worktree removal is in progress; retry after it finishes');
    this.name = 'ConversationWorktreeTransitionInProgressError';
  }
}

/**
 * Lock every conversation bound to a project branch and reject when any has an
 * unexpired execution lease or a running run. Returns the bound conversation
 * ids. Call inside a `withConversationWorktreeAdmission` exclusive operation.
 */
async function lockIdleWorktreeConversations(
  tx: any,
  group_folder: string,
  branch: string,
  ignoreLeaseOwnerId?: string,
): Promise<string[]> {
  const candidates = await tx
    .select({ id: drizzleConversations.id })
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.group_folder, group_folder),
        eq(drizzleConversations.use_worktree, 1),
        sql`coalesce(${drizzleConversations.branch_name}, 'chat-' || ${drizzleConversations.id}) = ${branch}`,
      ),
    )
    .orderBy(asc(drizzleConversations.id))
    .for('update');
  const conversationIds = candidates.map(
    (conversation: { id: string }) => conversation.id,
  );

  if (conversationIds.length > 0) {
    const now = new Date().toISOString();
    const activeLeaseRows = await tx
      .select({
        conversation_id: conversationExecutionLeases.conversation_id,
      })
      .from(conversationExecutionLeases)
      .where(
        and(
          inArray(conversationExecutionLeases.conversation_id, conversationIds),
          gte(conversationExecutionLeases.expires_at, now),
          ...(ignoreLeaseOwnerId
            ? [ne(conversationExecutionLeases.owner_id, ignoreLeaseOwnerId)]
            : []),
        ),
      );
    const activeRunRows = await tx
      .select({ conversation_id: activeRuns.conversation_id })
      .from(activeRuns)
      .where(
        and(
          inArray(activeRuns.conversation_id, conversationIds),
          eq(activeRuns.status, 'running'),
        ),
      );
    const busyConversationIds = [
      ...new Set(
        [...activeLeaseRows, ...activeRunRows].map(
          (row) => row.conversation_id,
        ),
      ),
    ].filter((id): id is string => id !== null);
    if (busyConversationIds.length > 0) {
      throw new ConversationWorktreeInUseError(busyConversationIds);
    }
  }
  return conversationIds;
}

/**
 * Serialize a managed worktree removal against every conversation using that
 * project branch. The project+branch lock is the same admission boundary used
 * for conversation binding and execution leases: an existing run rejects
 * removal, while a concurrently starting run either wins before the snapshot
 * or observes the completed transition before it acquires its lease.
 *
 * The external removal runs inside the transaction so a failure preserves all
 * bindings and sessions. Keep that callback limited to the one CarapaBox call.
 */
export async function transitionConversationsFromRemovedWorktree<T>(
  group_folder: string,
  branch: string,
  removeWorktree: () => Promise<T>,
  removalSucceeded: (result: T) => boolean = () => true,
  /** A lease the caller itself holds, which must not block the removal. */
  ignoreLeaseOwnerId?: string,
): Promise<{ result: T; affectedConversationIds: string[] }> {
  const admission = await withConversationWorktreeAdmission(
    group_folder,
    branch,
    'removal',
    async (tx) => {
      const conversationIds = await lockIdleWorktreeConversations(
        tx,
        group_folder,
        branch,
        ignoreLeaseOwnerId,
      );

      const result = await removeWorktree();
      if (!removalSucceeded(result) || conversationIds.length === 0) {
        return { result, affectedConversationIds: [] };
      }

      await tx
        .update(drizzleConversations)
        .set({
          use_worktree: 0,
          worktree_path: null,
          worktreeMissing: 0,
          branch_name: null,
          session_id: null,
        })
        .where(inArray(drizzleConversations.id, conversationIds));
      await tx
        .delete(drizzleConversationAgentSessions)
        .where(
          inArray(
            drizzleConversationAgentSessions.conversation_id,
            conversationIds,
          ),
        );
      return { result, affectedConversationIds: conversationIds };
    },
  );
  // Removal admission is exclusive and never uses the fail-fast branch.
  if (!admission.admitted) {
    throw new Error('Could not acquire worktree removal admission');
  }
  return admission.value;
}

/**
 * Run `operation` while no conversation bound to the project branch can run:
 * existing runs reject with `ConversationWorktreeInUseError`, and every
 * conversation's admission (including the owner's) queues behind the
 * operation until it ends. Use for short maintenance that edits the checkout.
 */
export async function withConversationWorktreeMaintenance<T>(
  group_folder: string,
  branch: string,
  operation: () => Promise<T>,
): Promise<T> {
  const admission = await withConversationWorktreeAdmission(
    group_folder,
    branch,
    'maintenance',
    async (tx) => {
      await lockIdleWorktreeConversations(tx, group_folder, branch);
      return operation();
    },
  );
  if (!admission.admitted) {
    throw new Error('Could not acquire worktree maintenance admission');
  }
  return admission.value;
}

export async function updateConversationWorktreePath(
  conversation_id: string,
  worktree_path: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({ worktree_path, worktreeMissing: 0 })
    .where(eq(drizzleConversations.id, conversation_id))
    .execute();
}

export async function getConversations(
  group_folder: string,
  limit = 10,
  offset = 0,
  filters?: {
    ownerUserId?: string;
    triggeredByUserId?: string;
    allowedConversationIds?: string[];
    /** Absent: project chats only. Set: only that objective's chats. */
    objectiveId?: string;
  },
): Promise<Conversation[]> {
  if (filters?.allowedConversationIds?.length === 0) return [];
  const convRows = await drizzleDbRef.current
    .select(conversationListSelect)
    .from(drizzleConversations)
    .leftJoin(
      conversationPublicShares,
      eq(conversationPublicShares.conversationId, drizzleConversations.id),
    )
    .where(
      and(
        eq(drizzleConversations.group_folder, group_folder),
        filters?.objectiveId
          ? eq(drizzleConversations.objective_id, filters.objectiveId)
          : isNull(drizzleConversations.objective_id),
        filters?.allowedConversationIds
          ? inArray(drizzleConversations.id, filters.allowedConversationIds)
          : undefined,
        filters?.ownerUserId
          ? eq(drizzleConversations.ownerUserId, filters.ownerUserId)
          : undefined,
        filters?.triggeredByUserId
          ? eq(
              drizzleConversations.lastTriggeredByUserId,
              filters.triggeredByUserId,
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(activePublicShare),
      desc(drizzleConversations.pinned),
      desc(
        sql`case
          when coalesce(${drizzleConversations.pinned}, 0) = 0
          then coalesce(${drizzleConversations.last_assistant_at}, ${drizzleConversations.created_at})
          else null
        end`,
      ),
      desc(drizzleConversations.created_at),
    )
    .limit(limit)
    .offset(offset);
  if (convRows.length === 0) return [];
  const runningNativeIds = await getRunningNativeConversationIds(convRows);

  // Use the `last_user_at` / `last_assistant_at` aggregates populated by
  // `updateConversationAggregate()` during the transcript write path. This
  // replaces the prior `max(created_at)` over `chat_messages` query that
  // required a second DB roundtrip per sidebar render.
  const mapped = mapConversationRowsWithStatus(convRows, runningNativeIds);
  return attachConversationAttribution(mapped);
}

/**
 * Complete chronological conversation inventory for offline history reflection.
 * Unlike the sidebar query this includes objective conversations and has no
 * presentation-oriented limit or pinned ordering.
 */
export async function getConversationsForHistoryReflection(
  group_folder: string,
): Promise<Conversation[]> {
  const rows = await drizzleDbRef.current
    .select(conversationSelect)
    .from(drizzleConversations)
    .where(eq(drizzleConversations.group_folder, group_folder))
    .orderBy(
      asc(drizzleConversations.created_at),
      asc(drizzleConversations.id),
    );
  return rows.map(mapConversationRow);
}

/** How long a conversation or task stays in the cross-project Now list. */
export const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The `Date.toISOString()` shape the app writes to `last_assistant_at`, limited
 * to real calendar dates (Feb 29 is excluded, so no leap-year logic). Every
 * accepted value is a valid fixed-width UTC instant, so text order equals
 * instant order and the SQL dismissal check matches `Date.parse` exactly.
 * Feb 29 and every other value fail open: SQL never excludes them and the
 * caller's in-memory check decides.
 */
const CANONICAL_ISO_TIMESTAMP_PATTERN =
  '^[0-9]{4}-((0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-8])|(0[13-9]|1[0-2])-(29|30)|(0[13578]|1[02])-31)T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$';

/** What one user may see in the Now list, applied before the row limit. */
export interface AttentionConversationScope {
  userId: string;
  /** Projects where the user sees every conversation. */
  projectIds: readonly string[];
  /** Conversations shared with the user in projects without full access. */
  sharedConversationIds: readonly string[];
}

/**
 * Compact cross-project inbox query used by the sidebar Now section. Read
 * conversations are excluded unless `includeRead` is set (the Now list keeps
 * opened rows until the user dismisses them). With `visibleTo`, rows the user
 * cannot see or has dismissed (with no newer reply) are excluded before
 * `limit`, so they never take up a slot. Callers still apply their own final
 * visibility check.
 */
export async function getAttentionConversations(
  windowMs = ATTENTION_WINDOW_MS,
  options: {
    includeRead?: boolean;
    limit?: number;
    visibleTo?: AttentionConversationScope;
  } = {},
): Promise<Conversation[]> {
  const scope = options.visibleTo;
  if (
    scope &&
    scope.projectIds.length === 0 &&
    scope.sharedConversationIds.length === 0
  ) {
    return [];
  }
  const since = new Date(Date.now() - windowMs).toISOString();
  const convRows = await drizzleDbRef.current
    .select(conversationSelect)
    .from(drizzleConversations)
    .where(
      and(
        isNotNull(drizzleConversations.last_assistant_at),
        gte(drizzleConversations.last_assistant_at, since),
        or(
          isNull(drizzleConversations.last_user_at),
          gte(
            drizzleConversations.last_assistant_at,
            drizzleConversations.last_user_at,
          ),
        ),
        options.includeRead
          ? undefined
          : or(
              isNull(drizzleConversations.read_at),
              lt(
                drizzleConversations.read_at,
                drizzleConversations.last_assistant_at,
              ),
            ),
        scope
          ? and(
              or(
                scope.projectIds.length > 0
                  ? inArray(
                      drizzleConversations.group_folder,
                      scope.projectIds as string[],
                    )
                  : undefined,
                scope.sharedConversationIds.length > 0
                  ? inArray(
                      drizzleConversations.id,
                      scope.sharedConversationIds as string[],
                    )
                  : undefined,
              ),
              // Narrowing only: exclude a row when its dismissal is provably
              // at or after the latest reply. Fixed-width UTC text sorts like
              // instants, so no cast is needed and nothing can throw.
              notExists(
                drizzleDbRef.current
                  .select({ one: sql`1` })
                  .from(nowDismissals)
                  .where(
                    and(
                      eq(nowDismissals.user_id, scope.userId),
                      eq(nowDismissals.kind, 'conversation'),
                      eq(nowDismissals.item_id, drizzleConversations.id),
                      sql`CASE WHEN ${drizzleConversations.last_assistant_at} ~ ${CANONICAL_ISO_TIMESTAMP_PATTERN}
                        THEN to_char(${nowDismissals.dismissedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') >= ${drizzleConversations.last_assistant_at}
                        ELSE false
                      END`,
                    ),
                  ),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(drizzleConversations.last_assistant_at))
    .limit(options.limit ?? 200);
  return convRows.map((row: Record<string, unknown>) => ({
    ...mapConversationRow(row),
    status:
      row.lastAssistantOutcome === 'pending'
        ? ('pending' as const)
        : row.lastAssistantOutcome === 'failed'
          ? ('failed' as const)
          : ('finished' as const),
  }));
}

export async function updateConversationPreview(
  id: string,
  preview: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({ preview })
    .where(eq(drizzleConversations.id, id))
    .execute();
}

export async function isConversationForkPending(
  conversation_id: string,
): Promise<boolean> {
  const q1 = drizzleDbRef.current
    .select({
      created_at: drizzleConversations.created_at,
      group_folder: drizzleConversations.group_folder,
    })
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.id, conversation_id),
        isNotNull(drizzleConversations.forked_from),
      ),
    );
  const rows1 = await q1;
  const row = rows1[0];
  if (!row) return false;

  // The transcript is the source of truth: a fork is "pending" until at
  // least one user message arrives after the conversation's `created_at`.
  // (The prior DB query checked for ANY `chat_messages` row, but a
  // fork-pending state only resolves when the user actually engages.)
  const messages = readChatTranscriptAsMessages(
    row.group_folder,
    conversation_id,
    5000,
  );
  return !messages.some((m) => m.created_at > row.created_at);
}

export async function getConversationSessionId(
  conversation_id: string,
  agent_cmd: string,
): Promise<string | null> {
  const rows = await drizzleDbRef.current
    .select({ session_id: drizzleConversationAgentSessions.session_id })
    .from(drizzleConversationAgentSessions)
    .where(
      and(
        eq(drizzleConversationAgentSessions.conversation_id, conversation_id),
        eq(drizzleConversationAgentSessions.agent_cmd, agent_cmd),
      ),
    );
  return rows[0]?.session_id ?? null;
}

export interface ConversationMainPersonaSourceObservation {
  mainAiUserMode: 'inherit' | 'persona' | 'none';
  mainAiUserId: string | null;
  projectExists: boolean;
  projectSettings: string | null;
  sourceAiUserId: string | null;
  sourceAiUserExists: boolean;
  sourceAiUserEnabled: number | null;
  sourceAiUserPersonaRevision: number | null;
  sourceAiUserUpdatedAt: string | null;
}

function mainPersonaSourceRevision(
  source: ConversationMainPersonaSourceObservation,
): string {
  return sha256Hex(
    JSON.stringify([
      source.mainAiUserMode,
      source.mainAiUserId,
      source.projectExists,
      source.projectSettings,
      source.sourceAiUserId,
      source.sourceAiUserExists,
      source.sourceAiUserEnabled,
      source.sourceAiUserPersonaRevision,
      source.sourceAiUserUpdatedAt,
    ]),
  );
}

/** Read the durable inputs that select and version a conversation's persona. */
export async function getConversationMainPersonaSourceObservation(
  conversation_id: string,
): Promise<ConversationMainPersonaSourceObservation> {
  const [source] = await drizzleDbRef.current
    .select({
      mainAiUserMode: drizzleConversations.mainAiUserMode,
      mainAiUserId: drizzleConversations.mainAiUserId,
      projectId: projects.id,
      projectSettings: projects.settings,
    })
    .from(drizzleConversations)
    .leftJoin(projects, eq(projects.id, drizzleConversations.group_folder))
    .where(eq(drizzleConversations.id, conversation_id))
    .limit(1);
  if (!source) throw new Error(`Conversation not found: ${conversation_id}`);

  const mainAiUserMode =
    source.mainAiUserMode ?? (source.mainAiUserId ? 'persona' : 'inherit');
  let inheritedAiUserId: string | null = null;
  if (mainAiUserMode === 'inherit' && source.projectSettings) {
    try {
      const value = JSON.parse(source.projectSettings).defaultMainAiUserId;
      if (typeof value === 'string' && value) inheritedAiUserId = value;
    } catch {
      // Unparseable project settings have no effective inherited persona.
    }
  }
  const sourceAiUserId =
    mainAiUserMode === 'persona'
      ? source.mainAiUserId
      : mainAiUserMode === 'inherit'
        ? inheritedAiUserId
        : null;
  const [sourceAiUser] = sourceAiUserId
    ? await drizzleDbRef.current
        .select({
          enabled: aiUsers.enabled,
          personaRevision: aiUsers.personaRevision,
          updatedAt: aiUsers.updatedAt,
        })
        .from(aiUsers)
        .where(eq(aiUsers.id, sourceAiUserId))
        .limit(1)
    : [];

  return {
    mainAiUserMode,
    mainAiUserId: source.mainAiUserId,
    projectExists: !!source.projectId,
    projectSettings: source.projectSettings,
    sourceAiUserId,
    sourceAiUserExists: !!sourceAiUser,
    sourceAiUserEnabled: sourceAiUser?.enabled ?? null,
    sourceAiUserPersonaRevision: sourceAiUser?.personaRevision ?? null,
    sourceAiUserUpdatedAt: sourceAiUser?.updatedAt ?? null,
  };
}

/**
 * Resolve the durable main-persona generation for a conversation.
 *
 * The update is the transition boundary: it accepts the fingerprint only while
 * the conversation selection, inherited project settings, and persona version
 * still match the caller's observation. Equal fingerprints are idempotent;
 * stale observations return null so the orchestrator can rebuild both context
 * and routing together. Keeping the fingerprint out of routing keys prevents
 * A -> B -> A from reviving A's old provider session.
 */
export async function resolveConversationMainPersonaGeneration(
  conversation_id: string,
  fingerprint: string,
  source: ConversationMainPersonaSourceObservation,
): Promise<number | null> {
  if (!fingerprint) throw new Error('Main persona fingerprint is required');
  const sourceRevision = mainPersonaSourceRevision(source);
  const sourceAiUserMatches = source.sourceAiUserId
    ? source.sourceAiUserExists
      ? sql`EXISTS (
          SELECT 1 FROM ${aiUsers}
          WHERE ${aiUsers.id} = ${source.sourceAiUserId}
            AND ${aiUsers.enabled} IS NOT DISTINCT FROM ${source.sourceAiUserEnabled}
            AND ${aiUsers.personaRevision} IS NOT DISTINCT FROM ${source.sourceAiUserPersonaRevision}
            AND ${aiUsers.updatedAt} IS NOT DISTINCT FROM ${source.sourceAiUserUpdatedAt}
        )`
      : sql`NOT EXISTS (
          SELECT 1 FROM ${aiUsers}
          WHERE ${aiUsers.id} = ${source.sourceAiUserId}
        )`
    : sql`TRUE`;
  const inheritedSettingsMatch =
    source.mainAiUserMode === 'inherit'
      ? source.projectExists
        ? sql`EXISTS (
            SELECT 1 FROM ${projects}
            WHERE ${projects.id} = ${drizzleConversations.group_folder}
              AND ${projects.settings} IS NOT DISTINCT FROM ${source.projectSettings}
          )`
        : sql`NOT EXISTS (
            SELECT 1 FROM ${projects}
            WHERE ${projects.id} = ${drizzleConversations.group_folder}
          )`
      : sql`TRUE`;
  const updated = await drizzleDbRef.current
    .update(drizzleConversations)
    .set({
      mainPersonaFingerprint: fingerprint,
      mainPersonaSourceRevision: sourceRevision,
      mainPersonaGeneration: sql`CASE
        WHEN ${drizzleConversations.mainPersonaFingerprint} IS DISTINCT FROM ${fingerprint}
        THEN ${drizzleConversations.mainPersonaGeneration} + 1
        ELSE ${drizzleConversations.mainPersonaGeneration}
      END`,
    })
    .where(
      and(
        eq(drizzleConversations.id, conversation_id),
        sql`${drizzleConversations.mainAiUserMode} IS NOT DISTINCT FROM ${source.mainAiUserMode}`,
        sql`${drizzleConversations.mainAiUserId} IS NOT DISTINCT FROM ${source.mainAiUserId}`,
        inheritedSettingsMatch,
        sourceAiUserMatches,
        or(
          sql`${drizzleConversations.mainPersonaSourceRevision} IS DISTINCT FROM ${sourceRevision}`,
          sql`${drizzleConversations.mainPersonaFingerprint} IS NOT DISTINCT FROM ${fingerprint}`,
        ),
      ),
    )
    .returning();
  if (updated[0]) return updated[0].mainPersonaGeneration;
  return null;
}

export async function setConversationSessionId(
  conversation_id: string,
  agent_cmd: string,
  session_id: string | null,
  chat_mode?: string | null,
): Promise<void> {
  if (session_id === null) {
    await drizzleDbRef.current
      .delete(drizzleConversationAgentSessions)
      .where(
        and(
          eq(drizzleConversationAgentSessions.conversation_id, conversation_id),
          eq(drizzleConversationAgentSessions.agent_cmd, agent_cmd),
        ),
      )
      .execute();
    return;
  }
  const updated_at = new Date().toISOString();
  // Recovery callers do not know about chat mode. Preserve the
  // existing mode for those callers instead of erasing the session metadata.
  let sessionMode: string | null | undefined =
    chat_mode === null ? DEFAULT_CHAT_MODE_SENTINEL : chat_mode;
  if (sessionMode === undefined) {
    const existing = await drizzleDbRef.current
      .select({ chat_mode: drizzleConversationAgentSessions.chat_mode })
      .from(drizzleConversationAgentSessions)
      .where(
        and(
          eq(drizzleConversationAgentSessions.conversation_id, conversation_id),
          eq(drizzleConversationAgentSessions.agent_cmd, agent_cmd),
        ),
      );
    sessionMode = existing[0]?.chat_mode ?? null;
  }
  const persistedMode = sessionMode ?? null;
  await drizzleDbRef.current
    .insert(drizzleConversationAgentSessions)
    .values({
      conversation_id,
      agent_cmd,
      session_id,
      chat_mode: persistedMode,
      updated_at,
    })
    .onConflictDoUpdate({
      target: [
        drizzleConversationAgentSessions.conversation_id,
        drizzleConversationAgentSessions.agent_cmd,
      ],
      set: { session_id, chat_mode: persistedMode, updated_at },
    })
    .execute();
}

export async function setConversationAgentCmd(
  conversation_id: string,
  agent_cmd: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({ last_agent_cmd: agent_cmd })
    .where(eq(drizzleConversations.id, conversation_id))
    .execute();
}

export async function setConversationRuntimeSelection(
  conversation_id: string,
  selection: { harnessId: string; modelId: string; reasoning?: string } | null,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({
      runtimeHarnessId: selection?.harnessId ?? null,
      runtimeModelId: selection?.modelId ?? null,
      runtimeReasoning: selection?.reasoning ?? null,
    })
    .where(eq(drizzleConversations.id, conversation_id))
    .execute();
}

/** Pin (or, with `null`, clear) the concrete model an Auto conversation runs on. */
export async function setConversationRoutedModel(
  conversation_id: string,
  pin: { modelId: string; harnessId: string; tier: string | null } | null,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({
      routedModelId: pin?.modelId ?? null,
      routedHarnessId: pin?.harnessId ?? null,
      routedTier: pin?.tier ?? null,
      routedAt: pin ? new Date().toISOString() : null,
    })
    .where(eq(drizzleConversations.id, conversation_id))
    .execute();
}

export async function setConversationMainAiUser(
  conversation_id: string,
  selection: import('../../types.js').MainAiUserSelection,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({
      mainAiUserMode: selection.mode,
      mainAiUserId: selection.mode === 'persona' ? selection.aiUserId : null,
    })
    .where(eq(drizzleConversations.id, conversation_id))
    .execute();
}

export async function setConversationContinuousPersonaLoop(
  conversation_id: string,
  enabled: boolean,
): Promise<void> {
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({ continuousPersonaLoop: enabled ? 1 : 0 })
    .where(eq(drizzleConversations.id, conversation_id))
    .execute();
}

export async function clearConversationSession(
  conversation_id: string,
  agent_cmd?: string,
): Promise<void> {
  if (agent_cmd) {
    await drizzleDbRef.current
      .delete(drizzleConversationAgentSessions)
      .where(
        and(
          eq(drizzleConversationAgentSessions.conversation_id, conversation_id),
          eq(drizzleConversationAgentSessions.agent_cmd, agent_cmd),
        ),
      )
      .execute();
    return;
  }
  await drizzleDbRef.current
    .delete(drizzleConversationAgentSessions)
    .where(
      eq(drizzleConversationAgentSessions.conversation_id, conversation_id),
    )
    .execute();
}

export async function updateConversation(
  id: string,
  group_folder: string,
  fields: {
    title?: string | null;
    pinned?: boolean;
    promptCache1h?: boolean;
    lastTriggeredByUserId?: string | null;
    lastTriggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
    lastTriggeredAt?: string | null;
  },
): Promise<void> {
  const data: any = {};
  if ('title' in fields) {
    data.title = fields.title ?? null;
  }
  if ('pinned' in fields) {
    data.pinned = fields.pinned ? 1 : 0;
  }
  if ('promptCache1h' in fields) {
    data.promptCache1h = fields.promptCache1h ? 1 : 0;
  }
  if ('lastTriggeredByUserId' in fields)
    data.lastTriggeredByUserId = fields.lastTriggeredByUserId ?? null;
  if ('lastTriggerSource' in fields)
    data.lastTriggerSource = fields.lastTriggerSource;
  if ('lastTriggeredAt' in fields)
    data.lastTriggeredAt = fields.lastTriggeredAt ?? null;
  if (Object.keys(data).length === 0) return;

  await drizzleDbRef.current
    .update(drizzleConversations)
    .set(data)
    .where(
      and(
        eq(drizzleConversations.id, id),
        eq(drizzleConversations.group_folder, group_folder),
      ),
    )
    .execute();
}

/** Persist an automatic title only while the conversation is still untitled. */
export async function updateConversationTitleIfUntitled(
  id: string,
  group_folder: string,
  title: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .update(drizzleConversations)
    .set({ title })
    .where(
      and(
        eq(drizzleConversations.id, id),
        eq(drizzleConversations.group_folder, group_folder),
        or(
          isNull(drizzleConversations.title),
          eq(drizzleConversations.title, ''),
        ),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function getMostRecentConversation(
  group_folder: string,
): Promise<Conversation | undefined> {
  const q = drizzleDbRef.current
    .select(conversationSelect)
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.group_folder, group_folder),
        isNull(drizzleConversations.objective_id),
      ),
    )
    .orderBy(desc(drizzleConversations.created_at))
    .limit(1);
  const rows = await q;
  return rows[0] ? mapConversationRow(rows[0]) : undefined;
}

export async function getLastChatConversationId(
  group_folder: string,
): Promise<string | null> {
  // The `last_user_at` aggregate is maintained by `updateConversationAggregate`
  // for every conversation with at least one user turn. Picking the
  // `MAX(last_user_at)` gives the same answer as the prior
  // `chat_messages where role='user'` scan, with a single index lookup and
  // no `chat_messages` table read.
  const q = drizzleDbRef.current
    .select({
      id: drizzleConversations.id,
      last_user_at: drizzleConversations.last_user_at,
    })
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.group_folder, group_folder),
        isNotNull(drizzleConversations.last_user_at),
        isNull(drizzleConversations.objective_id),
      ),
    )
    .orderBy(desc(drizzleConversations.last_user_at))
    .limit(1);
  const rows = await q;
  return rows[0]?.id ?? null;
}

/**
 * Delete the auto-injected "interrupted by server restart" assistant marker
 * from a conversation, if present. The transcript is the source of truth, so
 * the chat detail route reads the JSONL file and the row here is what
 * actually disappears from the UI. The function still returns a number so
 * callers (form-response router, recovery) can log the outcome; the value
 * reflects the number of transcript entries removed (typically 0 or 1).
 *
 * Called by the form-response router when a deferred form answer arrives —
 * at that point the agent clearly wasn't crashed, it was waiting for input,
 * so the marker is misleading.
 */
export async function clearStuckRestartMarker(
  conversation_id: string,
  marker: string,
): Promise<number> {
  const conv = await drizzleDbRef.current
    .select({ group_folder: drizzleConversations.group_folder })
    .from(drizzleConversations)
    .where(eq(drizzleConversations.id, conversation_id));
  const group_folder: string | undefined = conv[0]?.group_folder;
  if (!group_folder) return 0;

  return removeChatTranscriptEntries(group_folder, conversation_id, (entry) => {
    const e = entry as { type?: string; role?: string; content?: string };
    return (
      e?.type === 'message' && e?.role === 'assistant' && e?.content === marker
    );
  });
}

export async function getStuckWorkingConversations(): Promise<
  {
    id: string;
    group_folder: string;
  }[]
> {
  // Reads the per-conversation `last_user_at` / `last_assistant_at` aggregates
  // maintained by `updateConversationAggregate()`. A conversation is "stuck"
  // when the latest user message is newer than the latest assistant message —
  // i.e. the assistant never replied. Filtering by an active run keeps us
  // from sweeping conversations that are genuinely still working.
  const convRows = await drizzleDbRef.current
    .select({
      id: drizzleConversations.id,
      group_folder: drizzleConversations.group_folder,
    })
    .from(drizzleConversations)
    .where(
      and(
        isNotNull(drizzleConversations.last_user_at),
        ne(drizzleConversations.last_user_at, ''),
        or(
          isNull(drizzleConversations.last_assistant_at),
          eq(drizzleConversations.last_assistant_at, ''),
          lt(
            drizzleConversations.last_assistant_at,
            drizzleConversations.last_user_at,
          ),
        ),
      ),
    )
    .orderBy(desc(drizzleConversations.created_at));

  const stuckRows = convRows.filter((c) => !isNativeImportedConversation(c.id));
  if (stuckRows.length === 0) return [];

  const activeRunRows = await drizzleDbRef.current
    .select({
      conversation_id: activeRuns.conversation_id,
    })
    .from(activeRuns)
    .where(
      and(
        isNull(activeRuns.task_id),
        eq(activeRuns.status, 'running'),
        isNotNull(activeRuns.conversation_id),
      ),
    );
  const activeRunConvIds = new Set(
    activeRunRows
      .map((r: { conversation_id: string | null }) => r.conversation_id)
      .filter((id): id is string => id != null),
  );

  // A human/persona turn owns this durable lease before sandbox preflight has
  // created its active_runs row. Treat that admitted preparation window as
  // live work; otherwise the minute sweep can mark the turn failed while it is
  // waiting for the shared checkout or a bounded CarapaBox preflight call.
  const activeLeaseRows = await drizzleDbRef.current
    .select({
      conversation_id: conversationExecutionLeases.conversation_id,
    })
    .from(conversationExecutionLeases)
    .where(
      gte(conversationExecutionLeases.expires_at, new Date().toISOString()),
    );
  const activeLeaseConvIds = new Set(
    activeLeaseRows.map((row) => row.conversation_id),
  );

  return stuckRows
    .filter((c) => !activeRunConvIds.has(c.id) && !activeLeaseConvIds.has(c.id))
    .map((c) => ({ id: c.id, group_folder: c.group_folder }));
}

export async function markConversationRead(
  group_folder: string,
  conversation_id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(drizzleConversations)
    // Imported/recovered transcripts can carry timestamps slightly ahead of
    // the board clock. A wall-clock-only watermark leaves those rows unread,
    // so the attention query immediately adds them back after the UI clears
    // the finished badge.
    .set({
      read_at: sql`GREATEST(COALESCE(${drizzleConversations.last_assistant_at}, ${now}), ${now})`,
    })
    .where(
      and(
        eq(drizzleConversations.id, conversation_id),
        eq(drizzleConversations.group_folder, group_folder),
      ),
    )
    .execute();
}

/**
 * Resolve the latest pending assistant plan without creating a synthetic user
 * message. The transcript marker keeps aggregate rebuilds from restoring the
 * pending state, while the read watermark makes the handled plan immediately
 * idle in conversation lists.
 */
export async function resolvePendingConversation(
  group_folder: string,
  conversation_id: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({
      lastAssistantAt: drizzleConversations.last_assistant_at,
      lastAssistantOutcome: drizzleConversations.lastAssistantOutcome,
    })
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.id, conversation_id),
        eq(drizzleConversations.group_folder, group_folder),
      ),
    )
    .limit(1);
  const conversation = rows[0];
  if (
    !conversation?.lastAssistantAt ||
    conversation.lastAssistantOutcome !== 'pending'
  ) {
    return false;
  }

  await appendChatTranscriptEntryAsync(group_folder, conversation_id, {
    id: `pending-resolution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'turn_outcome',
    pending: false,
    failed: false,
    created_at: conversation.lastAssistantAt,
    conversation_id,
  });

  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({
      lastAssistantOutcome: 'success',
      read_at: sql`GREATEST(COALESCE(${drizzleConversations.last_assistant_at}, ${now}), ${now})`,
    })
    .where(
      and(
        eq(drizzleConversations.id, conversation_id),
        eq(drizzleConversations.group_folder, group_folder),
        eq(drizzleConversations.lastAssistantOutcome, 'pending'),
        eq(
          drizzleConversations.last_assistant_at,
          conversation.lastAssistantAt,
        ),
      ),
    )
    .execute();
  return true;
}

/**
 * Mark every currently finished conversation in a project as read. When
 * allowedIds is supplied (implicit/shared project access), only those
 * conversations are updated.
 */
export async function markFinishedConversationsRead(
  group_folder: string,
  objective_id: string | null = null,
  allowedIds?: string[],
): Promise<void> {
  if (allowedIds && allowedIds.length === 0) return;
  const finished = and(
    eq(drizzleConversations.group_folder, group_folder),
    objective_id === null
      ? isNull(drizzleConversations.objective_id)
      : eq(drizzleConversations.objective_id, objective_id),
    isNotNull(drizzleConversations.last_assistant_at),
    or(
      isNull(drizzleConversations.last_user_at),
      gte(
        drizzleConversations.last_assistant_at,
        drizzleConversations.last_user_at,
      ),
    ),
    or(
      isNull(drizzleConversations.read_at),
      lt(drizzleConversations.read_at, drizzleConversations.last_assistant_at),
    ),
    ...(allowedIds ? [inArray(drizzleConversations.id, allowedIds)] : []),
  );
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(drizzleConversations)
    .set({
      read_at: sql`GREATEST(COALESCE(${drizzleConversations.last_assistant_at}, ${now}), ${now})`,
    })
    .where(finished)
    .execute();
}

export async function forkConversation(
  group_folder: string,
  sourceConvId: string,
  opts?: {
    ownerUserId?: string | null;
    triggerSource?: TriggerSource;
  },
): Promise<Conversation> {
  const qSource = drizzleDbRef.current
    .select({
      session_id: drizzleConversations.session_id,
      last_agent_cmd: drizzleConversations.last_agent_cmd,
      objective_id: drizzleConversations.objective_id,
      runtimeHarnessId: drizzleConversations.runtimeHarnessId,
      runtimeModelId: drizzleConversations.runtimeModelId,
      runtimeReasoning: drizzleConversations.runtimeReasoning,
      mainAiUserId: drizzleConversations.mainAiUserId,
      mainAiUserMode: drizzleConversations.mainAiUserMode,
      mainPersonaFingerprint: drizzleConversations.mainPersonaFingerprint,
      mainPersonaSourceRevision: drizzleConversations.mainPersonaSourceRevision,
      mainPersonaGeneration: drizzleConversations.mainPersonaGeneration,
      continuousPersonaLoop: drizzleConversations.continuousPersonaLoop,
    })
    .from(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.id, sourceConvId),
        eq(drizzleConversations.group_folder, group_folder),
      ),
    );
  const rows = await qSource;
  const source = rows[0];
  if (!source) throw new Error('Source conversation not found');

  const rand = Math.random().toString(36).substring(2, 8);
  const id = `conv-${Date.now()}-${rand}`;
  const created_at = new Date().toISOString();
  const ownerUserId = opts?.ownerUserId ?? null;
  const lastTriggeredByUserId =
    opts?.triggerSource === 'user' ? ownerUserId : null;
  const lastTriggerSource = opts?.triggerSource ?? 'system';
  const lastTriggeredAt = opts?.triggerSource ? created_at : null;

  const sId = source.session_id ?? null;
  const lCmd = source.last_agent_cmd ?? null;
  const objId = source.objective_id ?? null;

  await drizzleDbRef.current
    .insert(drizzleConversations)
    .values({
      id,
      group_folder,
      preview: null,
      created_at: created_at,
      read_at: null,
      title: null,
      pinned: 0,
      session_id: sId,
      forked_from: sourceConvId,
      use_worktree: 0,
      worktree_path: null,
      brain_managed: 0,
      objective_id: objId,
      last_agent_cmd: lCmd,
      runtimeHarnessId: source.runtimeHarnessId,
      runtimeModelId: source.runtimeModelId,
      runtimeReasoning: source.runtimeReasoning,
      mainAiUserId: source.mainAiUserId,
      mainAiUserMode: source.mainAiUserMode,
      mainPersonaFingerprint: source.mainPersonaFingerprint,
      mainPersonaSourceRevision: source.mainPersonaSourceRevision,
      mainPersonaGeneration: source.mainPersonaGeneration,
      continuousPersonaLoop: source.continuousPersonaLoop,
      ownerUserId,
      lastTriggeredByUserId,
      lastTriggerSource,
      lastTriggeredAt,
    })
    .execute();

  // The row is already inserted: remove it again if anything below fails so
  // the caller never sees a half-built fork (sessions cascade with the row).
  try {
    const sessionRows = await drizzleDbRef.current
      .select({
        agent_cmd: drizzleConversationAgentSessions.agent_cmd,
        session_id: drizzleConversationAgentSessions.session_id,
        chat_mode: drizzleConversationAgentSessions.chat_mode,
        updated_at: drizzleConversationAgentSessions.updated_at,
      })
      .from(drizzleConversationAgentSessions)
      .where(
        eq(drizzleConversationAgentSessions.conversation_id, sourceConvId),
      );

    if (sessionRows.length > 0) {
      await drizzleDbRef.current
        .insert(drizzleConversationAgentSessions)
        .values(
          sessionRows.map((r) => ({
            conversation_id: id,
            agent_cmd: r.agent_cmd,
            session_id: r.session_id,
            chat_mode: r.chat_mode,
            updated_at: r.updated_at,
          })),
        )
        .execute();
    }

    const forked: Conversation = {
      id,
      group_folder: group_folder,
      preview: null,
      created_at,
      session_id: sId,
      forked_from: sourceConvId,
      objective_id: objId,
      last_agent_cmd: lCmd,
      mainAiUserId: source.mainAiUserId,
      mainAiUserMode: source.mainAiUserMode,
      continuousPersonaLoop: source.continuousPersonaLoop !== 0,
      ownerUserId,
      lastTriggeredByUserId,
      lastTriggerSource,
      lastTriggeredAt,
      runtimeSelection:
        source.runtimeHarnessId && source.runtimeModelId
          ? {
              harnessId: source.runtimeHarnessId,
              modelId: source.runtimeModelId,
              ...(source.runtimeReasoning
                ? { reasoning: source.runtimeReasoning }
                : {}),
            }
          : null,
    };
    return (await attachConversationAttribution([forked]))[0];
  } catch (err) {
    await drizzleDbRef.current
      .delete(drizzleConversations)
      .where(eq(drizzleConversations.id, id))
      .execute()
      .catch(() => {});
    throw err;
  }
}

/** Permanently erase a conversation's transcript (live file and archived copies). */
export async function eraseConversationTranscript(
  group_folder: string,
  conversation_id: string,
): Promise<void> {
  await eraseChatTranscript(group_folder, conversation_id);
}

export async function deleteConversation(
  group_folder: string,
  conversation_id: string,
  options: { transcriptErased?: boolean } = {},
): Promise<void> {
  // The transcript under `groups/<folder>/transcripts/` (live file plus any
  // archived copy) carries the message content and is erased first. If that
  // fails the row stays and the error propagates, so the user can retry
  // instead of ending up with an orphaned, unreachable transcript. Row deletion
  // then cascades to dependent rows on the FK (active_runs.conversation_id is
  // set-null; the route refuses to delete while a run is active). A caller
  // that already erased it (before clearing the row's session_id) passes
  // `transcriptErased`.
  if (!options.transcriptErased) {
    await eraseConversationTranscript(group_folder, conversation_id);
  }
  await drizzleDbRef.current
    .delete(drizzleConversations)
    .where(
      and(
        eq(drizzleConversations.id, conversation_id),
        eq(drizzleConversations.group_folder, group_folder),
      ),
    )
    .execute();
  projectChanges.emit('changed');
}
