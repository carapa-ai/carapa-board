import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { drizzleDbRef } from './drizzle-client.js';
import {
  activeRuns,
  conversationAgentSessions,
  conversations,
  externalRunCosts,
  nowDismissals,
  objectives,
  projects,
  users,
} from './schema.js';

export type ExternalRunCostInsert = typeof externalRunCosts.$inferInsert;

export type ImportedConversationState = Pick<
  typeof conversations.$inferSelect,
  | 'id'
  | 'group_folder'
  | 'objective_id'
  | 'preview'
  | 'last_user_at'
  | 'last_assistant_at'
  | 'read_at'
>;

/** The only conversation columns a native-import update may change. */
export type ImportedConversationPatch = Partial<
  Pick<
    typeof conversations.$inferInsert,
    'preview' | 'last_user_at' | 'last_assistant_at' | 'read_at'
  >
>;

export type ExternalRunCostRow = typeof externalRunCosts.$inferSelect;

export type ExternalRunCostPatch = Partial<
  Pick<
    typeof externalRunCosts.$inferInsert,
    | 'cost_usd'
    | 'cost_estimated'
    | 'tok_total'
    | 'tok_input'
    | 'tok_output'
    | 'tok_cache_read'
    | 'tok_reasoning'
  >
>;

export async function getKnownBoardSessionIds(): Promise<Set<string>> {
  const [runs, legacy, perAgent] = await Promise.all([
    drizzleDbRef.current.select({ id: activeRuns.session_id }).from(activeRuns),
    drizzleDbRef.current
      .select({ id: conversations.session_id })
      .from(conversations),
    drizzleDbRef.current
      .select({ id: conversationAgentSessions.session_id })
      .from(conversationAgentSessions),
  ]);
  return new Set(
    [...runs, ...legacy, ...perAgent]
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

export async function getImportProjects() {
  return drizzleDbRef.current
    .select({
      id: projects.id,
      folder: projects.folder,
      name: projects.name,
      settings: projects.settings,
    })
    .from(projects);
}

export async function getObjectiveProjectIds(): Promise<Map<string, string>> {
  const rows = await drizzleDbRef.current
    .select({ id: objectives.id, projectId: objectives.project_id })
    .from(objectives);
  return new Map(rows.map((row) => [row.id, row.projectId]));
}

export async function getExistingConversationIds(
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await drizzleDbRef.current
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.id, ids));
  return new Set(rows.map((row) => row.id));
}

export async function getImportedConversationState(
  id: string,
): Promise<ImportedConversationState | null> {
  const [row] = await drizzleDbRef.current
    .select({
      id: conversations.id,
      group_folder: conversations.group_folder,
      objective_id: conversations.objective_id,
      preview: conversations.preview,
      last_user_at: conversations.last_user_at,
      last_assistant_at: conversations.last_assistant_at,
      read_at: conversations.read_at,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return row ?? null;
}

export async function getExternalRunCostsForConversation(
  conversationId: string,
): Promise<ExternalRunCostRow[]> {
  return drizzleDbRef.current
    .select()
    .from(externalRunCosts)
    .where(eq(externalRunCosts.conversation_id, conversationId));
}

type ImportTransaction = Parameters<
  Parameters<typeof drizzleDbRef.current.transaction>[0]
>[0];

/**
 * Check an imported conversation off every user's Now list. Its history was
 * reviewed outside the Board, so it should not wait there as a viewed reply.
 * A later Board reply is newer than this dismissal and shows up as usual.
 */
async function dismissImportedConversationFromNow(
  tx: ImportTransaction,
  conversationId: string,
): Promise<void> {
  await tx
    .insert(nowDismissals)
    .select(
      tx
        .select({
          user_id: users.id,
          kind: sql<string>`'conversation'`.as('kind'),
          item_id: sql<string>`${conversationId}`.as('item_id'),
          dismissedAt: sql<Date>`now()`.as('dismissed_at'),
        })
        .from(users),
    )
    .onConflictDoUpdate({
      target: [
        nowDismissals.user_id,
        nowDismissals.kind,
        nowDismissals.item_id,
      ],
      set: { dismissedAt: sql`now()` },
    })
    .execute();
}

/**
 * Apply a native-import update in one transaction: insert missing run-cost
 * rows, correct differing ones, and patch only the allowed conversation
 * columns. Nothing is deleted.
 */
export async function applyImportedConversationUpdate(
  conversationId: string,
  update: {
    conversationPatch: ImportedConversationPatch;
    insertRuns: ExternalRunCostInsert[];
    updateRuns: Array<{ id: string; patch: ExternalRunCostPatch }>;
  },
): Promise<void> {
  const { conversationPatch, insertRuns, updateRuns } = update;
  if (
    Object.keys(conversationPatch).length === 0 &&
    insertRuns.length === 0 &&
    updateRuns.length === 0
  )
    return;
  await drizzleDbRef.current.transaction(async (tx) => {
    if (insertRuns.length > 0) {
      await tx.insert(externalRunCosts).values(insertRuns).execute();
    }
    for (const { id, patch } of updateRuns) {
      await tx
        .update(externalRunCosts)
        .set(patch)
        .where(eq(externalRunCosts.id, id))
        .execute();
    }
    if (Object.keys(conversationPatch).length > 0) {
      const { read_at: readAt, ...rest } = conversationPatch;
      await tx
        .update(conversations)
        .set({
          ...rest,
          // read_at was planned from an earlier snapshot. Keep a later (or
          // cleared) value a concurrent read left, so it never moves backwards.
          ...(readAt
            ? {
                read_at: sql`CASE WHEN ${conversations.read_at} IS NOT NULL AND ${conversations.read_at}::timestamptz < ${readAt}::timestamptz THEN ${readAt}::text ELSE ${conversations.read_at} END`,
              }
            : {}),
        })
        .where(eq(conversations.id, conversationId))
        .execute();
      // The planner advances read_at only for a fully read conversation, so
      // its newer native reply stays checked off as well.
      if (readAt) await dismissImportedConversationFromNow(tx, conversationId);
    }
  });
}

export async function insertImportedConversation(
  conversation: typeof conversations.$inferInsert,
  runs: ExternalRunCostInsert[],
): Promise<boolean> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [project] = await tx
      .select({ ownerUserId: projects.user_id })
      .from(projects)
      .where(eq(projects.id, conversation.group_folder))
      .limit(1);
    const inserted = await tx
      .insert(conversations)
      .values({
        ...conversation,
        ownerUserId: conversation.ownerUserId ?? project?.ownerUserId ?? null,
        lastTriggerSource: conversation.lastTriggerSource ?? 'system',
      })
      .onConflictDoNothing()
      .returning()
      .execute();
    // A deterministic external-session ID may race with another import. Do
    // not attach this import's cost rows to a conversation we did not create.
    if (inserted.length === 0) return false;
    if (runs.length > 0) {
      await tx
        .insert(externalRunCosts)
        .values(runs)
        .onConflictDoNothing()
        .execute();
    }
    if (conversation.read_at) {
      await dismissImportedConversationFromNow(tx, inserted[0].id);
    }
    return true;
  });
}

export async function getExternalRunCostRowsSince(startedAt: string) {
  return drizzleDbRef.current
    .select({
      groupFolder: externalRunCosts.group_folder,
      taskId: conversations.objective_id, // selected then normalized below; always reported as chat
      conversationId: externalRunCosts.conversation_id,
      scheduledTaskId: conversations.objective_id,
      startedAt: externalRunCosts.started_at,
      stage: externalRunCosts.cost_source,
      taskCompletedAt: externalRunCosts.completed_at,
      taskStartedAt: externalRunCosts.started_at,
      taskCreatedAt: conversations.created_at,
      agentName: externalRunCosts.source,
      model: externalRunCosts.model_name,
      modelName: externalRunCosts.model_name,
      costUsd: externalRunCosts.cost_usd,
    })
    .from(externalRunCosts)
    .innerJoin(
      conversations,
      eq(externalRunCosts.conversation_id, conversations.id),
    )
    .where(and(gte(externalRunCosts.started_at, startedAt)))
    .orderBy(desc(externalRunCosts.started_at))
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        taskId: null,
        scheduledTaskId: null,
        stage: null,
        taskCompletedAt: null,
        taskStartedAt: null,
        taskCreatedAt: null,
      })),
    );
}
