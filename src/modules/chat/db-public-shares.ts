import { randomBytes } from 'node:crypto';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversationPublicShares,
  publicPromptRequests,
} from '../../db/schema.js';

export type ConversationPublicShareRow =
  typeof conversationPublicShares.$inferSelect;

function newPublicToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function getConversationPublicShare(
  conversationId: string,
): Promise<ConversationPublicShareRow | undefined> {
  const [row] = await drizzleDbRef.current
    .select()
    .from(conversationPublicShares)
    .where(eq(conversationPublicShares.conversationId, conversationId))
    .limit(1);
  return row;
}

export async function resolveConversationPublicShare(
  publicToken: string,
): Promise<ConversationPublicShareRow | undefined> {
  const [row] = await drizzleDbRef.current
    .select()
    .from(conversationPublicShares)
    .where(eq(conversationPublicShares.publicToken, publicToken))
    .limit(1);
  return row?.revokedAt ? undefined : row;
}

export async function createOrEnableConversationPublicShare(
  conversationId: string,
  createdBy: string | null,
): Promise<ConversationPublicShareRow> {
  const existing = await getConversationPublicShare(conversationId);
  if (existing && !existing.revokedAt) return existing;
  const now = new Date().toISOString();
  const [row] = await drizzleDbRef.current
    .insert(conversationPublicShares)
    .values({
      conversationId,
      publicToken: newPublicToken(),
      createdBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revokedAt: null,
      allowVisitorPrompts: 0,
    })
    .onConflictDoUpdate({
      target: conversationPublicShares.conversationId,
      set: {
        publicToken: sql`case when ${conversationPublicShares.revokedAt} is null then ${conversationPublicShares.publicToken} else excluded.public_token end`,
        createdBy: sql`case when ${conversationPublicShares.revokedAt} is null then ${conversationPublicShares.createdBy} else excluded.created_by end`,
        updatedAt: sql`case when ${conversationPublicShares.revokedAt} is null then ${conversationPublicShares.updatedAt} else excluded.updated_at end`,
        revokedAt: null,
        allowVisitorPrompts: sql`case when ${conversationPublicShares.revokedAt} is null then ${conversationPublicShares.allowVisitorPrompts} else 0 end`,
      },
    })
    .returning();
  return row;
}

export async function rotateConversationPublicShare(
  conversationId: string,
  createdBy: string | null,
): Promise<ConversationPublicShareRow> {
  const now = new Date().toISOString();
  const [row] = await drizzleDbRef.current
    .insert(conversationPublicShares)
    .values({
      conversationId,
      publicToken: newPublicToken(),
      createdBy,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: conversationPublicShares.conversationId,
      set: {
        publicToken: newPublicToken(),
        createdBy,
        updatedAt: now,
        revokedAt: null,
      },
    })
    .returning();
  return row;
}

export async function revokeConversationPublicShare(
  conversationId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(conversationPublicShares)
    .set({ revokedAt: now, updatedAt: now, allowVisitorPrompts: 0 })
    .where(eq(conversationPublicShares.conversationId, conversationId));
}

export async function setConversationPublicVisitorPrompts(
  conversationId: string,
  enabled: boolean,
): Promise<ConversationPublicShareRow | undefined> {
  const [row] = await drizzleDbRef.current
    .update(conversationPublicShares)
    .set({
      allowVisitorPrompts: enabled ? 1 : 0,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversationPublicShares.conversationId, conversationId))
    .returning();
  return row;
}

export type PublicPromptRequestRow = typeof publicPromptRequests.$inferSelect;

export async function insertPublicPromptRequest(
  row: typeof publicPromptRequests.$inferInsert,
): Promise<PublicPromptRequestRow> {
  const [created] = await drizzleDbRef.current
    .insert(publicPromptRequests)
    .values(row)
    .returning();
  return created;
}

export async function updatePublicPromptRequest(
  id: string,
  updates: Partial<typeof publicPromptRequests.$inferInsert>,
): Promise<PublicPromptRequestRow | undefined> {
  const [updated] = await drizzleDbRef.current
    .update(publicPromptRequests)
    .set(updates)
    .where(eq(publicPromptRequests.id, id))
    .returning();
  return updated;
}

export async function getPublicPromptRequest(
  id: string,
): Promise<PublicPromptRequestRow | undefined> {
  const [row] = await drizzleDbRef.current
    .select()
    .from(publicPromptRequests)
    .where(eq(publicPromptRequests.id, id))
    .limit(1);
  return row;
}

export async function countPublicPromptRequestsSince(
  conversationId: string,
  since: string,
): Promise<number> {
  const [row] = await drizzleDbRef.current
    .select({ value: count() })
    .from(publicPromptRequests)
    .where(
      and(
        eq(publicPromptRequests.conversationId, conversationId),
        gte(publicPromptRequests.createdAt, since),
      ),
    );
  return Number(row?.value ?? 0);
}

export async function countPublicVisitorPromptRequestsSince(
  conversationId: string,
  visitorHash: string,
  since: string,
): Promise<number> {
  const [row] = await drizzleDbRef.current
    .select({ value: count() })
    .from(publicPromptRequests)
    .where(
      and(
        eq(publicPromptRequests.conversationId, conversationId),
        eq(publicPromptRequests.visitorHash, visitorHash),
        gte(publicPromptRequests.createdAt, since),
      ),
    );
  return Number(row?.value ?? 0);
}

export async function hasInFlightPublicPromptRequest(
  conversationId: string,
  since: string,
): Promise<boolean> {
  const [row] = await drizzleDbRef.current
    .select({ value: count() })
    .from(publicPromptRequests)
    .where(
      and(
        eq(publicPromptRequests.conversationId, conversationId),
        inArray(publicPromptRequests.status, ['judging', 'running']),
        gte(publicPromptRequests.createdAt, since),
      ),
    );
  return Number(row?.value ?? 0) > 0;
}
