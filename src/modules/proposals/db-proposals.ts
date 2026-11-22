import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { proposals } from '../../db/schema.js';

export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
type TerminalStatus = 'applied' | 'denied' | 'failed' | 'stale';

export async function insertProposals(rows: NewProposalRow[]): Promise<void> {
  if (rows.length === 0) return;
  await drizzleDbRef.current.insert(proposals).values(rows).execute();
}

export async function getProposal(id: string): Promise<ProposalRow | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Compare-and-set `pending` -> `applying`. Exactly one of any number of
 * concurrent callers gets the row back; the others get null and must not act.
 */
export async function claimProposal(
  id: string,
  decidedBy: string,
): Promise<ProposalRow | null> {
  const rows = await drizzleDbRef.current
    .update(proposals)
    .set({
      status: 'applying',
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
    })
    .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
    .returning();
  return rows[0] ?? null;
}

export async function finishProposal(
  id: string,
  status: TerminalStatus,
  result: string,
): Promise<ProposalRow | null> {
  const rows = await drizzleDbRef.current
    .update(proposals)
    .set({ status, result })
    .where(and(eq(proposals.id, id), eq(proposals.status, 'applying')))
    .returning();
  return rows[0] ?? null;
}

/** Number of proposals in a conversation that still wait for a decision. */
export async function countOpenProposals(
  conversationId: string,
): Promise<number> {
  const rows = await drizzleDbRef.current
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.conversation_id, conversationId),
        inArray(proposals.status, ['pending', 'applying']),
      ),
    );
  return rows.length;
}

/** Set the result text of an already-decided proposal. */
export async function updateProposalResult(
  id: string,
  result: string,
): Promise<ProposalRow | null> {
  const rows = await drizzleDbRef.current
    .update(proposals)
    .set({ result })
    .where(and(eq(proposals.id, id), ne(proposals.status, 'applying')))
    .returning();
  return rows[0] ?? null;
}

export async function listApplyingProposals(): Promise<ProposalRow[]> {
  return drizzleDbRef.current
    .select()
    .from(proposals)
    .where(eq(proposals.status, 'applying'));
}

/**
 * True when a signed-in user approved merging exactly this task head commit:
 * an applied `merge` proposal named after the task whose base hash is the sha.
 */
export async function hasAppliedMergeApproval(
  taskId: string,
  headSha: string,
): Promise<boolean> {
  if (!headSha) return false;
  const rows = await drizzleDbRef.current
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.kind, 'merge'),
        eq(proposals.name, taskId),
        eq(proposals.base_hash, headSha),
        eq(proposals.status, 'applied'),
        isNotNull(proposals.decided_by),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The merge approval for this exact task head that is still usable: waiting for
 * a decision, being decided, or already approved.
 */
export async function findOpenMergeApproval(
  taskId: string,
  headSha: string,
): Promise<ProposalRow | null> {
  const rows = await drizzleDbRef.current
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.kind, 'merge'),
        eq(proposals.name, taskId),
        eq(proposals.base_hash, headSha),
        inArray(proposals.status, ['pending', 'applying', 'applied']),
      ),
    )
    .orderBy(asc(proposals.created_at), asc(proposals.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Replace the approve action of a row that is still waiting for a decision. */
export async function setPendingApproveAction(
  id: string,
  action: unknown,
): Promise<void> {
  await drizzleDbRef.current
    .update(proposals)
    .set({ approve_action: action })
    .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')));
}
