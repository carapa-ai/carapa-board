import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  notLike,
  or,
} from 'drizzle-orm';
import { MCP_AGENT_TIMEOUT } from '../../config.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  activeRuns,
  conversationExecutionLeases,
  conversations,
} from '../../db/schema.js';
import { withConversationWorktreeAdmission } from './db-chats.js';

export type ConversationExecutionLease = {
  conversationId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
};

const HEARTBEAT_MS = 30_000;
/** A live owner renews `updated_at` every heartbeat; this many missed beats mean it died. */
const DEAD_OWNER_MS = 10 * HEARTBEAT_MS;
const LEASE_TTL_MS = Math.max(60_000, (MCP_AGENT_TIMEOUT + 60) * 1_000);

function expiry(timestamp = Date.now()): string {
  return new Date(timestamp + LEASE_TTL_MS).toISOString();
}

function project(row: typeof conversationExecutionLeases.$inferSelect) {
  return {
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  } satisfies ConversationExecutionLease;
}

/** Atomically acquire the one durable execution slot for a conversation. */
export async function acquireConversationExecutionLease(
  conversationId: string,
  ownerId: string,
): Promise<ConversationExecutionLease | null> {
  const [binding] = await drizzleDbRef.current
    .select({
      groupFolder: conversations.group_folder,
      useWorktree: conversations.use_worktree,
      branchName: conversations.branch_name,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!binding) return null;

  const acquire = async (tx: any) => {
    const conversation = await tx
      .select({
        id: conversations.id,
        groupFolder: conversations.group_folder,
        useWorktree: conversations.use_worktree,
        branchName: conversations.branch_name,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .for('update');
    if (!conversation[0]) return null;
    if (
      binding.useWorktree === 1 &&
      conversation[0].useWorktree === 1 &&
      (conversation[0].groupFolder !== binding.groupFolder ||
        (conversation[0].branchName || `chat-${conversationId}`) !==
          (binding.branchName || `chat-${conversationId}`))
    ) {
      return null;
    }
    const timestamp = new Date().toISOString();
    const current = await tx
      .select()
      .from(conversationExecutionLeases)
      .where(eq(conversationExecutionLeases.conversation_id, conversationId))
      .limit(1);
    if (current[0] && current[0].expires_at > timestamp) return null;
    if (current[0])
      await tx
        .delete(conversationExecutionLeases)
        .where(eq(conversationExecutionLeases.conversation_id, conversationId));
    const rows = await tx
      .insert(conversationExecutionLeases)
      .values({
        conversation_id: conversationId,
        owner_id: ownerId,
        acquired_at: timestamp,
        expires_at: expiry(),
        updated_at: timestamp,
      })
      .returning();
    return project(rows[0]);
  };

  if (binding.useWorktree !== 1) {
    return drizzleDbRef.current.transaction(acquire);
  }
  const admission = await withConversationWorktreeAdmission(
    binding.groupFolder,
    binding.branchName || `chat-${conversationId}`,
    'admission',
    acquire,
  );
  return admission.admitted ? admission.value : null;
}

/**
 * Delete the conversation's lease when its owner stopped heartbeating, e.g. a
 * chat run that died with the previous Board process. The TTL can be days
 * (MCP_AGENT_TIMEOUT + 60 s), so `expires_at` alone keeps such a lease alive.
 * A conversation with a running chat row keeps its lease: that run may have
 * survived the outage in its sandbox and recovery has yet to reattach it. The
 * lease frees up once recovery completes the row.
 */
export async function releaseDeadConversationExecutionLease(
  conversationId: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .delete(conversationExecutionLeases)
    .where(
      and(
        eq(conversationExecutionLeases.conversation_id, conversationId),
        lt(
          conversationExecutionLeases.updated_at,
          new Date(Date.now() - DEAD_OWNER_MS).toISOString(),
        ),
        notExists(
          drizzleDbRef.current
            .select({ id: activeRuns.id })
            .from(activeRuns)
            .where(
              and(
                eq(activeRuns.conversation_id, conversationId),
                eq(activeRuns.status, 'running'),
                isNull(activeRuns.task_id),
                or(
                  isNull(activeRuns.stage),
                  notLike(activeRuns.stage, 'direct-followup:%'),
                ),
              ),
            ),
        ),
      ),
    )
    .returning();
  return rows.length === 1;
}

export async function getConversationExecutionLease(
  conversationId: string,
): Promise<ConversationExecutionLease | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(conversationExecutionLeases)
    .where(eq(conversationExecutionLeases.conversation_id, conversationId))
    .limit(1);
  if (!rows[0] || rows[0].expires_at <= new Date().toISOString()) return null;
  return project(rows[0]);
}

async function renewConversationExecutionLease(
  conversationId: string,
  ownerId: string,
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .update(conversationExecutionLeases)
    .set({ expires_at: expiry(), updated_at: timestamp })
    .where(
      and(
        eq(conversationExecutionLeases.conversation_id, conversationId),
        eq(conversationExecutionLeases.owner_id, ownerId),
      ),
    )
    .returning();
  return rows.length === 1;
}

export async function releaseConversationExecutionLease(
  conversationId: string,
  ownerId: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .delete(conversationExecutionLeases)
    .where(
      and(
        eq(conversationExecutionLeases.conversation_id, conversationId),
        eq(conversationExecutionLeases.owner_id, ownerId),
      ),
    )
    .returning();
  return rows.length === 1;
}

export function startConversationExecutionLeaseHeartbeat(
  conversationId: string,
  ownerId: string,
): () => void {
  const timer = setInterval(() => {
    void renewConversationExecutionLease(conversationId, ownerId);
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Reconcile restart ownership. A preflight-only claim has no recoverable
 * executor after process restart, so retain an unexpired claim only when a
 * durable running chat row can actually be adopted.
 */
export async function recoverConversationExecutionLeases(): Promise<number> {
  const timestamp = new Date().toISOString();
  const runningRows = await drizzleDbRef.current
    .select({ conversationId: activeRuns.conversation_id })
    .from(activeRuns)
    .where(
      and(
        eq(activeRuns.status, 'running'),
        isNull(activeRuns.task_id),
        isNotNull(activeRuns.conversation_id),
      ),
    );
  const runningConversationIds = new Set(
    runningRows
      .map((row) => row.conversationId)
      .filter((id): id is string => id !== null),
  );
  const leaseRows = await drizzleDbRef.current
    .select({
      conversationId: conversationExecutionLeases.conversation_id,
      expiresAt: conversationExecutionLeases.expires_at,
    })
    .from(conversationExecutionLeases);
  const orphanedIds = leaseRows
    .filter(
      (row) =>
        row.expiresAt <= timestamp ||
        !runningConversationIds.has(row.conversationId),
    )
    .map((row) => row.conversationId);
  if (orphanedIds.length === 0) return 0;
  const rows = await drizzleDbRef.current
    .delete(conversationExecutionLeases)
    .where(inArray(conversationExecutionLeases.conversation_id, orphanedIds))
    .returning();
  return rows.length;
}
