import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { agentAsks } from '../../db/schema.js';
import { isUniqueViolationError } from '../../lib/db-errors.js';

export type AgentAskRow = typeof agentAsks.$inferSelect;
export type NewAgentAskRow = Omit<
  typeof agentAsks.$inferInsert,
  'id' | 'createdAt'
> & { id?: string; createdAt?: string };

/** The target conversation already has a pending ask. */
export class AgentAskPendingError extends Error {
  constructor(readonly targetConversationId: string) {
    super(`Conversation ${targetConversationId} already has a pending ask`);
    this.name = 'AgentAskPendingError';
  }
}

const PENDING_TARGET_INDEX = 'uq_agent_asks_pending_target_conversation';

/** A unique violation whose driver error names the pending-target index (not, e.g., the primary key). */
function isPendingTargetViolation(error: unknown): boolean {
  if (!isUniqueViolationError(error)) return false;
  for (let current: unknown = error, depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== 'object') return false;
    const { constraint, message, cause } = current as {
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (constraint === PENDING_TARGET_INDEX) return true;
    if (typeof message === 'string' && message.includes(PENDING_TARGET_INDEX))
      return true;
    current = cause;
  }
  return false;
}

function newAgentAskId(): string {
  return `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function insertAgentAsk(
  row: NewAgentAskRow,
): Promise<AgentAskRow> {
  try {
    const rows = await drizzleDbRef.current
      .insert(agentAsks)
      .values({
        ...row,
        id: row.id ?? newAgentAskId(),
        createdAt: row.createdAt ?? new Date().toISOString(),
      })
      .returning();
    return rows[0]!;
  } catch (error) {
    if (isPendingTargetViolation(error))
      throw new AgentAskPendingError(row.targetConversationId);
    throw error;
  }
}

async function askExists(where: SQL | undefined): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ id: agentAsks.id })
    .from(agentAsks)
    .where(where)
    .limit(1);
  return rows.length > 0;
}

/** True if any ask, in any status, targets the conversation. */
export function isAgentAskTarget(conversationId: string): Promise<boolean> {
  return askExists(eq(agentAsks.targetConversationId, conversationId));
}

/** True if a pending ask already targets the conversation. */
export function hasPendingAskOnConversation(
  targetConversationId: string,
): Promise<boolean> {
  return askExists(
    and(
      eq(agentAsks.targetConversationId, targetConversationId),
      eq(agentAsks.status, 'pending'),
    ),
  );
}

/** True if another project's agent has a pending ask against this project. */
export function hasPendingInboundAsk(projectId: string): Promise<boolean> {
  return askExists(
    and(
      eq(agentAsks.targetProjectId, projectId),
      eq(agentAsks.status, 'pending'),
    ),
  );
}

/** True if a pending ask targets the conversation and answers into a caller conversation. */
export function hasPendingChatCallerAsk(
  targetConversationId: string,
  askId?: string,
): Promise<boolean> {
  return askExists(
    and(
      eq(agentAsks.targetConversationId, targetConversationId),
      eq(agentAsks.status, 'pending'),
      askId ? eq(agentAsks.id, askId) : undefined,
      isNotNull(agentAsks.callerConversationId),
    ),
  );
}

export async function getAgentAsk(id: string): Promise<AgentAskRow | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(agentAsks)
    .where(eq(agentAsks.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Settle a pending ask as failed, e.g. when its turn could not be started. */
export async function failPendingAgentAsk(
  id: string,
  deliveryError: string,
  settledAt: string = new Date().toISOString(),
): Promise<void> {
  await drizzleDbRef.current
    .update(agentAsks)
    .set({ status: 'failed', settledAt, deliveryError })
    .where(and(eq(agentAsks.id, id), eq(agentAsks.status, 'pending')));
}

/**
 * Atomically settle every pending ask that targets the conversation and
 * return the rows this call settled. Concurrent terminal events cannot both
 * receive the same ask.
 */
export async function claimPendingAgentAsks(
  targetConversationId: string,
  status: Exclude<AgentAskRow['status'], 'pending'>,
  settledAt: string = new Date().toISOString(),
  askId?: string,
): Promise<AgentAskRow[]> {
  return drizzleDbRef.current
    .update(agentAsks)
    .set({ status, settledAt })
    .where(
      and(
        eq(agentAsks.targetConversationId, targetConversationId),
        eq(agentAsks.status, 'pending'),
        askId ? eq(agentAsks.id, askId) : undefined,
      ),
    )
    .returning();
}

/** Record why an already settled ask could not be delivered. */
export async function setAgentAskDeliveryError(
  id: string,
  deliveryError: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(agentAsks)
    .set({ deliveryError })
    .where(eq(agentAsks.id, id));
}
