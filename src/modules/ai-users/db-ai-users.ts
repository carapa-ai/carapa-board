import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  aiTurnRuns,
  aiUserTeamMembers,
  aiUserTeams,
  aiUsers,
  conversationAiUsers,
} from '../../db/schema.js';
import { setConversationMainAiUser } from '../chat/db-chats.js';
import type { MainAiUserSelection } from '../../types.js';

export async function listAiUserRows() {
  return drizzleDbRef.current.select().from(aiUsers).orderBy(asc(aiUsers.name));
}

export async function getAiUserRow(id: string) {
  const [row] = await drizzleDbRef.current
    .select()
    .from(aiUsers)
    .where(eq(aiUsers.id, id))
    .limit(1);
  return row;
}

export async function insertAiUserRow(row: typeof aiUsers.$inferInsert) {
  const [created] = await drizzleDbRef.current
    .insert(aiUsers)
    .values(row)
    .returning();
  return created;
}

export async function updateAiUserRow(
  id: string,
  updates: Partial<typeof aiUsers.$inferInsert>,
) {
  const [updated] = await drizzleDbRef.current
    .update(aiUsers)
    .set(updates)
    .where(eq(aiUsers.id, id))
    .returning();
  return updated;
}

/** Publish a change that affects the effective main-persona fingerprint. */
export async function updateAiUserPersonaRow(
  id: string,
  updates: Omit<Partial<typeof aiUsers.$inferInsert>, 'personaRevision'>,
) {
  const [updated] = await drizzleDbRef.current
    .update(aiUsers)
    .set({
      ...updates,
      personaRevision: sql`${aiUsers.personaRevision} + 1`,
    })
    .where(eq(aiUsers.id, id))
    .returning();
  return updated;
}

type PublishedEmote = { name: string; path: string; version: string };

/** Publish an immutable emote asset with the persona revision it belongs to. */
export async function publishAiUserEmote(
  id: string,
  emote: PublishedEmote,
  updatedAt: string,
) {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [current] = await tx
      .select({ publishedEmotes: aiUsers.publishedEmotes })
      .from(aiUsers)
      .where(eq(aiUsers.id, id))
      .for('update');
    if (!current) return undefined;
    const manifest = current.publishedEmotes ?? [];
    const replaced = manifest.find((entry) => entry.name === emote.name);
    const publishedEmotes = [
      ...manifest.filter((entry) => entry.name !== emote.name),
      emote,
    ].sort((a, b) => a.name.localeCompare(b.name));
    const [updated] = await tx
      .update(aiUsers)
      .set({
        publishedEmotes,
        personaRevision: sql`${aiUsers.personaRevision} + 1`,
        updatedAt,
      })
      .where(eq(aiUsers.id, id))
      .returning();
    return { updated, replaced };
  });
}

/** Stop publishing an emote before its immutable asset is cleaned up. */
export async function unpublishAiUserEmote(
  id: string,
  name: string,
  updatedAt: string,
) {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [current] = await tx
      .select({ publishedEmotes: aiUsers.publishedEmotes })
      .from(aiUsers)
      .where(eq(aiUsers.id, id))
      .for('update');
    if (!current) return undefined;
    const manifest = current.publishedEmotes ?? [];
    const removed = manifest.find((entry) => entry.name === name);
    if (!removed) return { updated: undefined, removed: undefined };
    const [updated] = await tx
      .update(aiUsers)
      .set({
        publishedEmotes: manifest.filter((entry) => entry.name !== name),
        personaRevision: sql`${aiUsers.personaRevision} + 1`,
        updatedAt,
      })
      .where(eq(aiUsers.id, id))
      .returning();
    return { updated, removed };
  });
}

export async function deleteAiUserRow(id: string) {
  await drizzleDbRef.current.delete(aiUsers).where(eq(aiUsers.id, id));
}

export interface AiUserTeamRecord {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export async function listAiUserTeamRows(): Promise<AiUserTeamRecord[]> {
  const [teams, memberships] = await Promise.all([
    drizzleDbRef.current
      .select()
      .from(aiUserTeams)
      .orderBy(asc(aiUserTeams.name)),
    drizzleDbRef.current.select().from(aiUserTeamMembers),
  ]);
  const membersByTeam = new Map<string, string[]>();
  for (const membership of memberships) {
    const memberIds = membersByTeam.get(membership.teamId) ?? [];
    memberIds.push(membership.aiUserId);
    membersByTeam.set(membership.teamId, memberIds);
  }
  return teams.map((team) => ({
    ...team,
    memberIds: (membersByTeam.get(team.id) ?? []).sort(),
  }));
}

export async function getAiUserTeamRow(
  id: string,
): Promise<AiUserTeamRecord | undefined> {
  const [team] = await drizzleDbRef.current
    .select()
    .from(aiUserTeams)
    .where(eq(aiUserTeams.id, id))
    .limit(1);
  if (!team) return undefined;
  const members = await drizzleDbRef.current
    .select({ aiUserId: aiUserTeamMembers.aiUserId })
    .from(aiUserTeamMembers)
    .where(eq(aiUserTeamMembers.teamId, id));
  return {
    ...team,
    memberIds: members.map((member) => member.aiUserId).sort(),
  };
}

export async function insertAiUserTeamRow(
  row: typeof aiUserTeams.$inferInsert,
) {
  const [created] = await drizzleDbRef.current
    .insert(aiUserTeams)
    .values(row)
    .returning();
  return created;
}

export async function updateAiUserTeamRow(
  id: string,
  updates: Partial<typeof aiUserTeams.$inferInsert>,
) {
  const [updated] = await drizzleDbRef.current
    .update(aiUserTeams)
    .set(updates)
    .where(eq(aiUserTeams.id, id))
    .returning();
  return updated;
}

export async function deleteAiUserTeamRow(id: string) {
  await drizzleDbRef.current.delete(aiUserTeams).where(eq(aiUserTeams.id, id));
}

export async function replaceAiUserTeamMembers(
  teamId: string,
  memberIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(memberIds)];
  await drizzleDbRef.current.transaction(async (tx) => {
    await tx
      .delete(aiUserTeamMembers)
      .where(eq(aiUserTeamMembers.teamId, teamId));
    if (uniqueIds.length > 0) {
      const now = new Date().toISOString();
      await tx
        .insert(aiUserTeamMembers)
        .values(
          uniqueIds.map((aiUserId) => ({ teamId, aiUserId, createdAt: now })),
        );
    }
  });
}

export async function inviteConversationAiUserTeam(
  conversationId: string,
  teamId: string,
  invitedBy: string | null,
  mainAiUserId: string | null,
): Promise<{ invitedIds: string[]; skippedIds: string[] }> {
  const members = await drizzleDbRef.current
    .select({ aiUserId: aiUserTeamMembers.aiUserId, enabled: aiUsers.enabled })
    .from(aiUserTeamMembers)
    .innerJoin(aiUsers, eq(aiUserTeamMembers.aiUserId, aiUsers.id))
    .where(eq(aiUserTeamMembers.teamId, teamId));
  if (members.length === 0) return { invitedIds: [], skippedIds: [] };

  const memberIds = members.map((member) => member.aiUserId);
  const existing = await drizzleDbRef.current
    .select({ aiUserId: conversationAiUsers.aiUserId })
    .from(conversationAiUsers)
    .where(
      and(
        eq(conversationAiUsers.conversationId, conversationId),
        inArray(conversationAiUsers.aiUserId, memberIds),
      ),
    );
  const existingIds = new Set(
    existing.map((membership) => membership.aiUserId),
  );
  const eligibleIds = members
    .filter(
      (member) =>
        member.enabled === 1 &&
        member.aiUserId !== mainAiUserId &&
        !existingIds.has(member.aiUserId),
    )
    .map((member) => member.aiUserId);
  const now = new Date().toISOString();
  const inserted =
    eligibleIds.length > 0
      ? await drizzleDbRef.current
          .insert(conversationAiUsers)
          .values(
            eligibleIds.map((aiUserId) => ({
              conversationId,
              aiUserId,
              invitedBy,
              status: 'active' as const,
              invitedAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoNothing()
          .returning()
      : [];
  const invitedIds = inserted.map((row) => row.aiUserId);
  const invited = new Set(invitedIds);
  return { invitedIds, skippedIds: memberIds.filter((id) => !invited.has(id)) };
}

export async function listConversationAiUserRows(conversationId: string) {
  return drizzleDbRef.current
    .select({ aiUser: aiUsers, membership: conversationAiUsers })
    .from(conversationAiUsers)
    .innerJoin(aiUsers, eq(conversationAiUsers.aiUserId, aiUsers.id))
    .where(eq(conversationAiUsers.conversationId, conversationId))
    .orderBy(asc(aiUsers.name));
}

export async function inviteConversationAiUser(
  conversationId: string,
  aiUserId: string,
  invitedBy: string | null,
) {
  const now = new Date().toISOString();
  const [row] = await drizzleDbRef.current
    .insert(conversationAiUsers)
    .values({
      conversationId,
      aiUserId,
      invitedBy,
      status: 'active',
      invitedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        conversationAiUsers.conversationId,
        conversationAiUsers.aiUserId,
      ],
      set: { status: 'active', invitedBy, updatedAt: now },
    })
    .returning();
  return row;
}

export async function setConversationAiUserStatus(
  conversationId: string,
  aiUserId: string,
  status: 'active' | 'paused',
) {
  const [row] = await drizzleDbRef.current
    .update(conversationAiUsers)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(conversationAiUsers.conversationId, conversationId),
        eq(conversationAiUsers.aiUserId, aiUserId),
      ),
    )
    .returning();
  return row;
}

export async function removeConversationAiUser(
  conversationId: string,
  aiUserId: string,
) {
  await drizzleDbRef.current
    .delete(conversationAiUsers)
    .where(
      and(
        eq(conversationAiUsers.conversationId, conversationId),
        eq(conversationAiUsers.aiUserId, aiUserId),
      ),
    );
}

export async function setMainConversationAiUser(
  conversationId: string,
  selection: MainAiUserSelection,
) {
  await setConversationMainAiUser(conversationId, selection);
  if (selection.mode === 'persona')
    await removeConversationAiUser(conversationId, selection.aiUserId);
}

export async function insertAiTurnRun(row: typeof aiTurnRuns.$inferInsert) {
  const [created] = await drizzleDbRef.current
    .insert(aiTurnRuns)
    .values(row)
    .returning();
  return created;
}

export async function updateAiTurnRun(
  id: string,
  updates: Partial<typeof aiTurnRuns.$inferInsert>,
) {
  const [updated] = await drizzleDbRef.current
    .update(aiTurnRuns)
    .set(updates)
    .where(eq(aiTurnRuns.id, id))
    .returning();
  return updated;
}

export async function getAiTurnRunInspection(
  id: string,
  conversationId: string,
) {
  const [row] = await drizzleDbRef.current
    .select({
      id: aiTurnRuns.id,
      aiUserId: aiTurnRuns.aiUserId,
      phase: aiTurnRuns.phase,
      presetId: aiTurnRuns.presetId,
      decision: aiTurnRuns.decision,
      status: aiTurnRuns.status,
      createdAt: aiTurnRuns.createdAt,
      startedAt: aiTurnRuns.startedAt,
      completedAt: aiTurnRuns.completedAt,
      inspection: aiTurnRuns.inspection,
    })
    .from(aiTurnRuns)
    .where(
      and(eq(aiTurnRuns.id, id), eq(aiTurnRuns.conversationId, conversationId)),
    )
    .limit(1);
  return row;
}
