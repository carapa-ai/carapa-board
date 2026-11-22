import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  memories,
  memoryPrivacyErasureMarks,
  pendingMemoryErasures,
  pendingGraphErasures,
  pendingMemoryInvalidations,
  memoryReflectorOperations,
} from '../../db/schema.js';
import { Memory, MemoryType } from './types.js';
import {
  eq,
  and,
  or,
  isNull,
  isNotNull,
  desc,
  sql,
  inArray,
  gt,
  gte,
  lt,
  ilike,
  type SQL,
} from 'drizzle-orm';
import {
  escapeLikePattern,
  termFrequencies,
  termOverlap,
  tokenizeQueryTerms,
} from './search-terms.js';
import { assertPrivacyWriteEpoch } from './privacy-epoch.js';

// Memory CRUD

const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  identity: 1.0,
  goal: 0.9,
  decision: 0.8,
  task: 0.8,
  project: 0.7,
  preference: 0.7,
  contact: 0.6,
  event: 0.4,
};

function generateMemoryId(): string {
  const rand = Math.random().toString(36).substring(2, 8);
  return `mem-${Date.now()}-${rand}`;
}

export function parseMemory(row: any): Memory | undefined {
  if (!row) return undefined;
  const m: any = { ...row };
  if (typeof m.tags === 'string') {
    try {
      const parsed = JSON.parse(m.tags);
      m.tags = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      m.tags = [];
    }
  } else if (!Array.isArray(m.tags)) {
    m.tags = [];
  }
  return m as Memory;
}

function parseMemories(rows: any[]): Memory[] {
  return rows
    .map(parseMemory)
    .filter((memory): memory is Memory => memory !== undefined);
}

export function getDefaultImportance(memory_type: MemoryType): number {
  return DEFAULT_IMPORTANCE[memory_type] ?? 0.5;
}

export async function insertMemory(
  data: Omit<
    Memory,
    | 'id'
    | 'created_at'
    | 'updated_at'
    | 'last_accessed_at'
    | 'access_count'
    | 'importance'
  > & {
    importance?: number;
    /** Eval fixtures: deterministic id for reproducible recall. */
    id?: string;
    /** Captured before asynchronous extraction/dedup work begins. */
    expectedPrivacyEpoch?: number;
  },
): Promise<Memory> {
  const { expectedPrivacyEpoch: _expectedPrivacyEpoch, ...publicData } = data;
  const id = data.id ?? generateMemoryId();
  const now = new Date().toISOString();
  const importance = data.importance ?? getDefaultImportance(data.memory_type);

  if (data.expectedPrivacyEpoch !== undefined) {
    assertPrivacyWriteEpoch(data.group_folder, data.expectedPrivacyEpoch);
  }
  await drizzleDbRef.current.insert(memories).values({
    id,
    group_folder: data.group_folder,
    objective_id: data.objective_id || null,
    content: data.content,
    memory_type: data.memory_type,
    importance,
    source: data.source || 'agent',
    sourceRef: data.sourceRef || null,
    tags: data.tags ? JSON.stringify(data.tags) : null,
    created_at: now,
    updated_at: now,
    last_accessed_at: now,
    access_count: 0,
    superseded_by: null,
    valid_from: data.valid_from || now,
    valid_to: data.valid_to ?? null,
  });

  return {
    ...publicData,
    id,
    importance,
    objective_id: data.objective_id || null,
    source: data.source || 'agent',
    created_at: now,
    updated_at: now,
    last_accessed_at: now,
    access_count: 0,
    valid_from: data.valid_from || now,
    valid_to: data.valid_to ?? null,
  };
}

export async function getMemory(id: string): Promise<Memory | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memories)
    .where(eq(memories.id, id));
  if (rows.length === 0) return undefined;
  return parseMemory(rows[0]);
}

export async function updateMemory(
  id: string,
  updates: Partial<
    Pick<
      Memory,
      'content' | 'memory_type' | 'importance' | 'tags' | 'superseded_by'
    >
  >,
): Promise<void> {
  const setFields: Record<string, unknown> = {};

  if (updates.content !== undefined) {
    setFields.content = updates.content;
  }
  if (updates.memory_type !== undefined) {
    setFields.memory_type = updates.memory_type;
  }
  if (updates.importance !== undefined) {
    setFields.importance = updates.importance;
  }
  if (updates.tags !== undefined) {
    setFields.tags = JSON.stringify(updates.tags);
  }
  if (updates.superseded_by !== undefined) {
    setFields.superseded_by = updates.superseded_by;
  }

  if (Object.keys(setFields).length === 0) return;

  setFields.updated_at = new Date().toISOString();

  await drizzleDbRef.current
    .update(memories)
    .set(setFields)
    .where(eq(memories.id, id));
}

/** Move a memory into another project and detach any source-project objective. */
export async function moveMemoryToGroup(
  id: string,
  targetGroupFolder: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(memories)
    .set({
      group_folder: targetGroupFolder,
      objective_id: null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(memories.id, id));
}

/** Permanently erase a memory row. Reserved for explicit privacy erasure. */
export async function eraseMemory(id: string): Promise<void> {
  await drizzleDbRef.current.delete(memories).where(eq(memories.id, id));
}

async function upsertPrivacyErasureMark(
  executor: any,
  group_folder: string,
  erasedAt: string,
): Promise<void> {
  await executor
    .insert(memoryPrivacyErasureMarks)
    .values({ group_folder, last_erased_at: erasedAt })
    .onConflictDoUpdate({
      target: memoryPrivacyErasureMarks.group_folder,
      set: { last_erased_at: erasedAt },
    });
}

/** Record that a privacy erasure just ran in a project (content-free). */
export async function recordPrivacyErasure(
  group_folder: string,
): Promise<void> {
  await upsertPrivacyErasureMark(
    drizzleDbRef.current,
    group_folder,
    new Date().toISOString(),
  );
}

/** Time of the latest privacy erasure recorded for a project, if any. */
export async function getLastPrivacyErasureAt(
  group_folder: string,
): Promise<string | null> {
  const rows = await drizzleDbRef.current
    .select({ last_erased_at: memoryPrivacyErasureMarks.last_erased_at })
    .from(memoryPrivacyErasureMarks)
    .where(eq(memoryPrivacyErasureMarks.group_folder, group_folder))
    .limit(1);
  return rows[0]?.last_erased_at ?? null;
}

/**
 * Establish the durable privacy boundary in one SQL transaction.
 * A crash leaves either the old SQL state or deleted SQL plus retry work,
 * never deleted SQL with no way to reap its external copies.
 */
export async function beginMemoryPrivacyErasure(
  memoryIds: string[],
  group_folder: string,
  target_tokens: string[],
  erase_matching_graph: boolean,
  queue_external_cleanup: boolean,
): Promise<void> {
  if (memoryIds.length === 0) return;
  const now = new Date().toISOString();
  await drizzleDbRef.current.transaction(async (tx: any) => {
    // A pending reflector create may already have inserted its deterministic
    // result when a crash occurs. Preserve erasure as a tombstone on that
    // receipt so a later retry cannot recreate the deleted memory.
    await tx
      .update(memoryReflectorOperations)
      .set({ status: 'erased', updatedAt: now })
      .where(inArray(memoryReflectorOperations.resultMemoryId, memoryIds));
    if (queue_external_cleanup) {
      for (const memoryId of memoryIds) {
        await tx
          .insert(pendingMemoryErasures)
          .values({
            memory_id: memoryId,
            group_folder,
            target_tokens: JSON.stringify(target_tokens),
            token_scheme: 'hmac-sha256',
            erase_matching_graph,
            created_at: now,
            last_attempt_at: null,
          })
          .onConflictDoUpdate({
            target: pendingMemoryErasures.memory_id,
            set: {
              target_tokens: JSON.stringify(target_tokens),
              token_scheme: 'hmac-sha256',
              erase_matching_graph,
            },
          });
      }
    }
    await upsertPrivacyErasureMark(tx, group_folder, now);
    await tx.delete(memories).where(inArray(memories.id, memoryIds));
  });
}

/**
 * Close a memory's validity window without deleting its historical content.
 * Use this when a fact simply ceases to be true and has no replacement.
 */
export async function invalidateMemory(
  id: string,
  effectiveAt?: string,
  expectedVersion?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const boundary = effectiveAt ?? now;
  return await drizzleDbRef.current.transaction(async (tx: any) => {
    // A boundary earlier than valid_from would yield valid_to < valid_from.
    const [prior] = await tx
      .select({ validFrom: memories.valid_from })
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1);
    if (prior?.validFrom && boundary < prior.validFrom) return false;
    const changed = await tx
      .update(memories)
      .set({ valid_to: boundary, updated_at: now })
      .where(
        and(
          eq(memories.id, id),
          isNull(memories.valid_to),
          ...(expectedVersion
            ? [eq(memories.updated_at, expectedVersion)]
            : []),
        ),
      )
      .returning({ id: memories.id });
    if (changed.length > 0) {
      await tx
        .insert(pendingMemoryInvalidations)
        .values({
          memory_id: id,
          effective_at: boundary,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: pendingMemoryInvalidations.memory_id,
          set: { effective_at: boundary },
        });
    }
    return changed.length > 0;
  });
}

/** Thrown inside supersedeMemory's transaction to roll back a lost race. */
class SupersedeConflict extends Error {}

export async function supersedeMemory(
  id: string,
  supersededById: string,
  effectiveAt?: string,
  expectedVersion?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const boundary = effectiveAt ?? now;

  try {
    return await drizzleDbRef.current.transaction(async (tx: any) => {
      const [prior] = await tx
        .select({
          validFrom: memories.valid_from,
          validTo: memories.valid_to,
          supersededBy: memories.superseded_by,
          updatedAt: memories.updated_at,
        })
        .from(memories)
        .where(eq(memories.id, id))
        .limit(1);
      if (!prior) return false;
      if (expectedVersion && prior.updatedAt !== expectedVersion) return false;
      // A boundary earlier than valid_from would yield valid_to < valid_from.
      if (prior.validFrom && boundary < prior.validFrom) return false;

      // Calls without an effective timestamp retain the legacy current-only
      // behavior. Explicit timestamps may splice a fact into a closed interval.
      if (!effectiveAt && prior.validTo !== null) return false;
      if (effectiveAt && prior.validTo !== null && prior.validTo <= effectiveAt)
        return false;

      // The retained row must still be current at the version we read; a
      // concurrent supersede/invalidate must not be overwritten (it would
      // reopen a closed fact).
      const [retained] = await tx
        .select({ updatedAt: memories.updated_at })
        .from(memories)
        .where(and(eq(memories.id, supersededById), isNull(memories.valid_to)))
        .limit(1);
      if (!retained) return false;

      // Preserve the old interval's successor on the inserted fact. This keeps a
      // backdated correction historical when a newer fact already exists.
      const retainedUpdated = await tx
        .update(memories)
        .set({
          superseded_by: prior.supersededBy,
          valid_to: prior.validTo,
          updated_at: now,
        })
        .where(
          and(
            eq(memories.id, supersededById),
            isNull(memories.valid_to),
            eq(memories.updated_at, retained.updatedAt),
          ),
        )
        .returning({ id: memories.id });
      if (retainedUpdated.length === 0) return false;

      const closed = await tx
        .update(memories)
        .set({
          superseded_by: supersededById,
          valid_to: boundary,
          updated_at: now,
        })
        .where(
          and(
            eq(memories.id, id),
            eq(memories.updated_at, prior.updatedAt),
            prior.validTo === null
              ? isNull(memories.valid_to)
              : eq(memories.valid_to, prior.validTo),
          ),
        )
        .returning({ id: memories.id });
      if (closed.length === 0) {
        // Roll back the retained-row write above.
        throw new SupersedeConflict();
      }

      await tx
        .insert(pendingMemoryInvalidations)
        .values({
          memory_id: id,
          effective_at: boundary,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: pendingMemoryInvalidations.memory_id,
          set: { effective_at: boundary },
        });
      return true;
    });
  } catch (error) {
    if (error instanceof SupersedeConflict) return false;
    throw error;
  }
}

/** Atomically insert a replacement and close its referenced timeline version. */
export async function insertSupersedingMemory(args: {
  id?: string;
  targetMemoryId: string;
  groupFolder: string;
  expectedVersion: string;
  effectiveAt: string;
  content: string;
  memoryType: MemoryType;
  importance?: number;
  objectiveId?: string | null;
  source: Memory['source'];
  sourceRef?: string | null;
  tags?: string[];
  expectedPrivacyEpoch?: number;
}): Promise<Memory | null> {
  if (args.expectedPrivacyEpoch !== undefined) {
    assertPrivacyWriteEpoch(args.groupFolder, args.expectedPrivacyEpoch);
  }
  const id = args.id ?? generateMemoryId();
  const now = new Date().toISOString();
  const importance = args.importance ?? getDefaultImportance(args.memoryType);

  return await drizzleDbRef.current.transaction(async (tx: any) => {
    const [prior] = await tx
      .select({
        groupFolder: memories.group_folder,
        validFrom: memories.valid_from,
        validTo: memories.valid_to,
        supersededBy: memories.superseded_by,
        updatedAt: memories.updated_at,
        tags: memories.tags,
      })
      .from(memories)
      .where(eq(memories.id, args.targetMemoryId))
      .limit(1);
    if (
      !prior ||
      prior.groupFolder !== args.groupFolder ||
      prior.updatedAt !== args.expectedVersion ||
      (prior.validFrom && args.effectiveAt < prior.validFrom) ||
      (prior.validTo && prior.validTo <= args.effectiveAt)
    ) {
      return null;
    }

    const [inserted] = await tx
      .insert(memories)
      .values({
        id,
        group_folder: args.groupFolder,
        objective_id: args.objectiveId ?? null,
        content: args.content,
        memory_type: args.memoryType,
        importance,
        source: args.source,
        sourceRef: args.sourceRef ?? null,
        // Omitted tags inherit the superseded row's; an explicit [] clears them.
        tags: args.tags ? JSON.stringify(args.tags) : prior.tags,
        created_at: now,
        updated_at: now,
        last_accessed_at: now,
        access_count: 0,
        superseded_by: prior.supersededBy,
        valid_from: args.effectiveAt,
        valid_to: prior.validTo,
      })
      .returning();
    const updated = await tx
      .update(memories)
      .set({
        superseded_by: id,
        valid_to: args.effectiveAt,
        updated_at: now,
      })
      .where(
        and(
          eq(memories.id, args.targetMemoryId),
          eq(memories.updated_at, args.expectedVersion),
        ),
      )
      .returning({ id: memories.id });
    if (updated.length === 0) {
      throw new Error(
        `Memory ${args.targetMemoryId} changed concurrently; recall it again and retry with its current updated version.`,
      );
    }
    await tx
      .insert(pendingMemoryInvalidations)
      .values({
        memory_id: args.targetMemoryId,
        effective_at: args.effectiveAt,
        created_at: now,
      })
      .onConflictDoUpdate({
        target: pendingMemoryInvalidations.memory_id,
        set: { effective_at: args.effectiveAt },
      });
    if (prior.validTo) {
      await tx
        .insert(pendingMemoryInvalidations)
        .values({
          memory_id: id,
          effective_at: prior.validTo,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: pendingMemoryInvalidations.memory_id,
          set: { effective_at: prior.validTo },
        });
    }
    return parseMemory(inserted) ?? null;
  });
}

function validityConditions(asOf?: string): any[] {
  if (asOf) {
    return [
      or(isNull(memories.valid_from), sql`${memories.valid_from} <= ${asOf}`),
      or(isNull(memories.valid_to), sql`${memories.valid_to} > ${asOf}`),
    ];
  }

  return [isNull(memories.valid_to)];
}

/**
 * Bounded, untouched live-reflector candidates across all objective scopes:
 * never edited since creation (`updated_at = created_at`) and not written by a
 * History Review apply (whose source refs name a conversation, a memory file,
 * or `history-reflector`).
 */
export async function recentObserverMemories(
  projectId: string,
  since: string,
): Promise<Memory[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.group_folder, projectId),
        eq(memories.source, 'observer'),
        gte(memories.created_at, since),
        sql`${memories.updated_at} = ${memories.created_at}`,
        isNotNull(memories.sourceRef),
        sql`${memories.sourceRef} <> 'history-reflector'`,
        sql`${memories.sourceRef} not like 'conversation:%'`,
        sql`${memories.sourceRef} not like 'memory-file:%'`,
        ...validityConditions(),
      ),
    )
    .orderBy(desc(memories.created_at), desc(memories.id))
    .limit(50);
  return parseMemories(rows);
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25 over the prefiltered rows (content plus tags). Statistics (row count,
 * per-term document frequency, average length) come from `candidates` itself,
 * so no extra query is needed. Rows without a whole-token or piece match score
 * 0 and are dropped. Ties: higher importance, then newer `updated_at`.
 * Importance, recency and access count are not part of the score.
 */
function scoreBm25<
  T extends {
    content: string;
    tags?: string[] | string | null;
    importance: number;
    updated_at: string;
  },
>(queryTerms: readonly string[], candidates: readonly T[]): T[] {
  const docs = candidates.map((memory) => {
    const tagText = Array.isArray(memory.tags)
      ? memory.tags.join(' ')
      : memory.tags || '';
    return { memory, ...termFrequencies(`${memory.content} ${tagText}`) };
  });
  const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0);
  const avgLength = totalLength / docs.length || 1;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = docs.filter((doc) => doc.tf.has(term)).length;
    idf.set(term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
  }
  return docs
    .map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        score +=
          (idf.get(term)! * tf * (BM25_K1 + 1)) /
          (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength));
      }
      return { memory: doc.memory, score };
    })
    .filter((doc) => doc.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.memory.importance - a.memory.importance ||
        b.memory.updated_at.localeCompare(a.memory.updated_at),
    )
    .map((doc) => doc.memory);
}

/** Keyword prefilter slice sizes: newest rows and most important rows. */
const KEYWORD_RECENT_SLICE = 350;
const KEYWORD_IMPORTANT_SLICE = 250;

/** Per-search counts of the keyword path; filled only when requested. */
export interface KeywordSearchStats {
  queryTerms: number;
  /** Distinct rows from the SQL ILIKE prefilter's two slices (at most 600). */
  prefiltered: number;
  /** True when either prefilter slice (recent or important) hit its row cap. */
  capped: boolean;
  /** Prefiltered candidates with a BM25 score > 0. */
  overlapHits: number;
  returned: number;
}

export interface SearchMemoriesOpts {
  groupFolders: string[];
  query?: string;
  memory_type?: string;
  limit?: number;
  objective_id?: string | null;
  /**
   * Match the objective scope exactly: only rows whose objective_id equals
   * `objective_id` (or are project-wide when it is unset). By default a scoped
   * search also returns project-wide rows, which recall needs but a duplicate
   * lookup must not see.
   */
  strictScope?: boolean;
  skipTouch?: boolean;
  /**
   * Point-in-time query: return memories valid at this ISO timestamp.
   * When omitted, only currently-valid memories (valid_to IS NULL) are returned.
   */
  asOf?: string;
  /** Minimum importance (0–1 inclusive). Used by CarapaBrain decay scans. */
  min_importance?: number;
  /** Only memories with updated_at at or after this ISO timestamp. */
  since?: string;
  /**
   * 'recent' orders the no-query listing by updated_at only (newest first)
   * instead of importance first. Ignored when a text query is given.
   */
  order?: 'recent';
  /**
   * Opt-in: filled with keyword-path counts for a text query (left untouched
   * for an empty query).
   */
  stats?: KeywordSearchStats;
}

export interface ListCurrentProjectMemoriesOpts {
  groupFolder: string;
  limit: number;
  offset?: number;
  query?: string;
  memory_type?: string;
}

/**
 * Administrative, stable pagination over every current project memory.
 * Unlike semantic recall, this intentionally includes objective-scoped rows
 * and does not impose the 500-candidate search ceiling.
 */
export async function listCurrentProjectMemories(
  opts: ListCurrentProjectMemoriesOpts,
): Promise<{ memories: Memory[]; total: number }> {
  const conditions: any[] = [
    eq(memories.group_folder, opts.groupFolder),
    ...validityConditions(),
  ];
  if (opts.memory_type) {
    conditions.push(eq(memories.memory_type, opts.memory_type));
  }
  const query = opts.query?.trim().toLowerCase();
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(
      or(
        sql`lower(${memories.content}) like ${pattern} escape '\\'`,
        sql`lower(${memories.id}) like ${pattern} escape '\\'`,
        sql`lower(coalesce(${memories.tags}, '')) like ${pattern} escape '\\'`,
      ),
    );
  }
  const whereClause = and(...conditions);
  const [countRows, rows] = await Promise.all([
    drizzleDbRef.current
      .select({ total: sql<number>`count(*)` })
      .from(memories)
      .where(whereClause),
    drizzleDbRef.current
      .select()
      .from(memories)
      .where(whereClause)
      .orderBy(
        desc(memories.importance),
        desc(memories.updated_at),
        desc(memories.id),
      )
      .limit(opts.limit)
      .offset(opts.offset ?? 0),
  ]);
  return {
    memories: parseMemories(rows),
    total: Number(countRows[0]?.total ?? 0),
  };
}

export async function searchMemories(
  opts: SearchMemoriesOpts,
): Promise<Memory[]> {
  const {
    groupFolders,
    query,
    memory_type,
    limit = 10,
    objective_id,
    strictScope = false,
    skipTouch = false,
    asOf,
    min_importance,
    since,
    order,
    stats,
  } = opts;

  // Build WHERE conditions using Drizzle.
  const conditions: (typeof memories.superseded_by)[] = [];

  conditions.push(...validityConditions(asOf));

  if (groupFolders.length > 0) {
    conditions.push(inArray(memories.group_folder, groupFolders) as any);
  }

  if (memory_type) {
    conditions.push(eq(memories.memory_type, memory_type) as any);
  }

  if (objective_id && strictScope) {
    conditions.push(eq(memories.objective_id, objective_id) as any);
  } else if (objective_id) {
    conditions.push(
      or(
        eq(memories.objective_id, objective_id),
        isNull(memories.objective_id),
      ) as any,
    );
  } else {
    conditions.push(isNull(memories.objective_id) as any);
  }

  if (min_importance !== undefined) {
    conditions.push(gte(memories.importance, min_importance) as any);
  }

  if (since) {
    conditions.push(gte(memories.updated_at, since) as any);
  }

  const whereClause = and(...conditions);
  const queryTrimmed = query?.trim();

  if (!queryTrimmed) {
    const rows = await drizzleDbRef.current
      .select()
      .from(memories)
      .where(whereClause)
      .orderBy(
        ...(order === 'recent'
          ? [desc(memories.updated_at)]
          : [desc(memories.importance), desc(memories.updated_at)]),
      )
      .limit(limit)
      .execute();
    const results = parseMemories(rows);
    if (!skipTouch) await touchMemories(results.map((memory) => memory.id));
    return results;
  }

  // Keyword search: SQL pre-filter on the query terms (so matches beyond an
  // arbitrary row cap are still found), then BM25 ranking in JS
  // (see `scoreBm25`).
  const queryTerms = tokenizeQueryTerms(queryTrimmed);
  if (queryTerms.length === 0) {
    if (stats) {
      Object.assign(stats, {
        queryTerms: 0,
        prefiltered: 0,
        capped: false,
        overlapHits: 0,
        returned: 0,
      });
    }
    return [];
  }

  const termMatches = queryTerms.map((term) => {
    const pattern = `%${escapeLikePattern(term)}%`;
    return or(ilike(memories.content, pattern), ilike(memories.tags, pattern));
  });
  // Distinct query terms matched, so rows with the rare keyword outrank rows
  // matching only a common term when the slice caps truncate candidates.
  const matchCount = sql<number>`(${sql.join(
    termMatches.map((match) => sql`CASE WHEN ${match} THEN 1 ELSE 0 END`),
    sql` + `,
  )})`;

  // Two bounded slices over the same filter keep both recent and important
  // rows: importance is otherwise applied only in JS, after the SQL cap, so an
  // old identity/preference memory is cut when many rows match equally.
  const candidateWhere = and(whereClause, or(...termMatches));
  const selectSlice = (limitRows: number, ...order: SQL[]) =>
    drizzleDbRef.current
      .select()
      .from(memories)
      .where(candidateWhere)
      .orderBy(...order)
      .limit(limitRows)
      .execute();
  const [recentRows, importantRows] = await Promise.all([
    selectSlice(
      KEYWORD_RECENT_SLICE,
      desc(matchCount),
      desc(memories.updated_at),
    ),
    selectSlice(
      KEYWORD_IMPORTANT_SLICE,
      desc(matchCount),
      desc(memories.importance),
      desc(memories.updated_at),
    ),
  ]);
  const rowsById = new Map<string, (typeof recentRows)[number]>();
  for (const row of [...recentRows, ...importantRows]) {
    rowsById.set(row.id, row);
  }
  const rows = [...rowsById.values()];

  const scored = scoreBm25(queryTerms, parseMemories(rows));
  const results = scored.slice(0, limit);
  if (stats) {
    Object.assign(stats, {
      queryTerms: queryTerms.length,
      prefiltered: rows.length,
      capped:
        recentRows.length === KEYWORD_RECENT_SLICE ||
        importantRows.length === KEYWORD_IMPORTANT_SLICE,
      overlapHits: scored.length,
      returned: results.length,
    });
  }
  if (!skipTouch) await touchMemories(results.map((m) => m.id));
  return results;
}

/**
 * Count valid objective-scoped memories (non-null objective_id) that match the
 * same group, type and keyword filters searchMemories applies. Lets recall
 * report scoped memories it hid from a project-wide (no objective_id) search.
 */
export async function countObjectiveScopedMemories(opts: {
  groupFolders: string[];
  query?: string;
  memory_type?: string;
  asOf?: string;
}): Promise<number> {
  const { groupFolders, query, memory_type, asOf } = opts;
  const conditions: any[] = [
    ...validityConditions(asOf),
    sql`${memories.objective_id} IS NOT NULL`,
  ];
  if (groupFolders.length > 0) {
    conditions.push(inArray(memories.group_folder, groupFolders));
  }
  if (memory_type) conditions.push(eq(memories.memory_type, memory_type));

  const queryTrimmed = query?.trim();
  if (!queryTrimmed) {
    const [row] = await drizzleDbRef.current
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(and(...conditions))
      .execute();
    return Number(row?.count ?? 0);
  }

  const queryTerms = tokenizeQueryTerms(queryTrimmed);
  if (queryTerms.length === 0) return 0;
  const termConditions = queryTerms.flatMap((term) => {
    const pattern = `%${escapeLikePattern(term)}%`;
    return [ilike(memories.content, pattern), ilike(memories.tags, pattern)];
  });
  const rows = await drizzleDbRef.current
    .select({ content: memories.content, tags: memories.tags })
    .from(memories)
    .where(and(...conditions, or(...termConditions)))
    .limit(500)
    .execute();
  return rows.filter((row: any) => {
    const tagText = Array.isArray(row.tags)
      ? row.tags.join(' ')
      : row.tags || '';
    return termOverlap(queryTerms, `${row.content} ${tagText}`) > 0;
  }).length;
}

export async function touchMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(memories)
    .set({
      last_accessed_at: now,
      access_count: sql`${memories.access_count} + 1`,
    })
    .where(inArray(memories.id, ids));
}

/**
 * Fetch multiple memories by id, applying the same group/objective/validity
 * filters used by searchMemories. Used to hydrate vector-search hits.
 * Does not touch access counters.
 */
export async function getMemoriesByIds(
  ids: string[],
  opts: {
    groupFolders: string[];
    objective_id?: string | null;
    asOf?: string;
  } = {
    groupFolders: [],
  },
): Promise<Memory[]> {
  if (ids.length === 0) return [];
  const { groupFolders, objective_id, asOf } = opts;

  const conditions: any[] = [
    inArray(memories.id, ids),
    ...validityConditions(asOf),
  ];

  if (groupFolders.length > 0) {
    conditions.push(inArray(memories.group_folder, groupFolders));
  }

  if (objective_id) {
    conditions.push(
      or(
        eq(memories.objective_id, objective_id),
        isNull(memories.objective_id),
      ),
    );
  } else {
    conditions.push(isNull(memories.objective_id));
  }

  const rows = await drizzleDbRef.current
    .select()
    .from(memories)
    .where(and(...conditions))
    .execute();
  return parseMemories(rows);
}

const MAINTENANCE_PAGE_SIZE = 1000;

/** Every current row of a group, loaded in keyset pages ordered by id. */
export async function getMemoriesForMaintenance(
  group_folder: string,
): Promise<Memory[]> {
  const all: Memory[] = [];
  let afterId: string | undefined;
  for (;;) {
    const rows = await drizzleDbRef.current
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.group_folder, group_folder),
          isNull(memories.valid_to),
          afterId ? gt(memories.id, afterId) : undefined,
        ),
      )
      .orderBy(memories.id)
      .limit(MAINTENANCE_PAGE_SIZE)
      .execute();
    all.push(...parseMemories(rows));
    if (rows.length < MAINTENANCE_PAGE_SIZE) return all;
    afterId = rows[rows.length - 1].id;
  }
}

/**
 * One keyset page of already-invalid memories (closed or superseded) in a
 * group, ordered by id, for reconciling their Neo4j vector nodes.
 */
export async function getInvalidMemoriesPage(
  group_folder: string,
  afterId: string | undefined,
  limit: number,
): Promise<Array<{ id: string; effectiveAt: string }>> {
  const rows = await drizzleDbRef.current
    .select({
      id: memories.id,
      valid_to: memories.valid_to,
    })
    .from(memories)
    .where(
      and(
        eq(memories.group_folder, group_folder),
        isNotNull(memories.valid_to),
        afterId ? gt(memories.id, afterId) : undefined,
      ),
    )
    .orderBy(memories.id)
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    // The query keeps only rows with valid_to set.
    effectiveAt: r.valid_to as string,
  }));
}

/**
 * One keyset page of currently-valid memory ids (not superseded, not closed)
 * in a group, ordered by id, last updated before `updatedBefore` so rows
 * whose vector is still being written are excluded.
 */
export async function getValidMemoryIdsPage(
  group_folder: string,
  afterId: string | undefined,
  limit: number,
  updatedBefore: Date,
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.group_folder, group_folder),
        isNull(memories.valid_to),
        lt(memories.updated_at, updatedBefore.toISOString()),
        afterId ? gt(memories.id, afterId) : undefined,
      ),
    )
    .orderBy(memories.id)
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Which of the given ids still have a SQL row. Deliberately no validity
 * filter: invalid rows keep their vector nodes for asOf recall.
 */
export async function getExistingMemoryIds(
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await drizzleDbRef.current
    .select({ id: memories.id })
    .from(memories)
    .where(inArray(memories.id, ids))
    .execute();
  return new Set(rows.map((r) => r.id));
}

/** Every SQL row of a group, valid or not; 0 means the group has no memories. */
export async function countGroupMemories(
  group_folder: string,
): Promise<number> {
  const [row] = await drizzleDbRef.current
    .select({ count: sql<number>`count(*)` })
    .from(memories)
    .where(eq(memories.group_folder, group_folder))
    .execute();
  return Number(row?.count ?? 0);
}

/** Complete bi-temporal history for offline reconciliation and audit. */
export async function getMemoryTimeline(
  group_folder: string,
): Promise<Memory[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memories)
    .where(eq(memories.group_folder, group_folder))
    .orderBy(memories.valid_from, memories.created_at)
    .execute();
  return parseMemories(rows);
}

/** Fetch every temporal version in a group for explicit privacy erasure only. */
export async function getMemoriesForErasure(
  group_folder: string,
): Promise<Memory[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(memories)
    .where(eq(memories.group_folder, group_folder))
    .execute();
  return parseMemories(rows);
}

/**
 * Link an already-created historical row to a known later version without
 * mutating that successor. This is the prepend counterpart to
 * supersedeMemory's middle-of-chain splice.
 */
export async function setMemorySuccessor(
  id: string,
  successorId: string,
  effectiveAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current.transaction(async (tx: any) => {
    await tx
      .update(memories)
      .set({
        superseded_by: successorId,
        valid_to: effectiveAt,
        updated_at: now,
      })
      .where(eq(memories.id, id));
    await tx
      .insert(pendingMemoryInvalidations)
      .values({
        memory_id: id,
        effective_at: effectiveAt,
        created_at: now,
      })
      .onConflictDoUpdate({
        target: pendingMemoryInvalidations.memory_id,
        set: { effective_at: effectiveAt },
      });
  });
}

export interface PendingMemoryErasure {
  memory_id: string;
  group_folder: string;
  target_tokens: string;
  token_scheme: string;
  erase_matching_graph: boolean;
  created_at: string;
  last_attempt_at: string | null;
}

/** Queue keyed matching tokens without retaining plaintext or dictionary hashes. */
export async function enqueueMemoryErasure(
  memoryId: string,
  group_folder: string,
  target_tokens: string[],
  erase_matching_graph = true,
): Promise<void> {
  await drizzleDbRef.current
    .insert(pendingMemoryErasures)
    .values({
      memory_id: memoryId,
      group_folder,
      target_tokens: JSON.stringify(target_tokens),
      token_scheme: 'hmac-sha256',
      erase_matching_graph,
      created_at: new Date().toISOString(),
      last_attempt_at: null,
    })
    .onConflictDoUpdate({
      target: pendingMemoryErasures.memory_id,
      set: {
        target_tokens: JSON.stringify(target_tokens),
        token_scheme: 'hmac-sha256',
        erase_matching_graph,
      },
    });
}

export async function getPendingMemoryErasures(
  group_folder?: string,
): Promise<PendingMemoryErasure[]> {
  const query = drizzleDbRef.current.select().from(pendingMemoryErasures);
  return (
    group_folder
      ? await query
          .where(eq(pendingMemoryErasures.group_folder, group_folder))
          .execute()
      : await query.execute()
  ) as PendingMemoryErasure[];
}

export async function markMemoryErasureAttempt(
  memoryId: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(pendingMemoryErasures)
    .set({ last_attempt_at: new Date().toISOString() })
    .where(eq(pendingMemoryErasures.memory_id, memoryId));
}

export async function completeMemoryErasure(memoryId: string): Promise<void> {
  await drizzleDbRef.current
    .delete(pendingMemoryErasures)
    .where(eq(pendingMemoryErasures.memory_id, memoryId));
}

export interface PendingGraphErasure {
  id: string;
  group_folder: string;
  target_tokens: string;
  token_scheme: string;
  created_at: string;
  last_attempt_at: string | null;
}

export async function enqueueGraphErasure(
  id: string,
  group_folder: string,
  target_tokens: string[],
): Promise<void> {
  await drizzleDbRef.current
    .insert(pendingGraphErasures)
    .values({
      id,
      group_folder,
      target_tokens: JSON.stringify(target_tokens),
      token_scheme: 'hmac-sha256',
      created_at: new Date().toISOString(),
      last_attempt_at: null,
    })
    .onConflictDoNothing();
}

export async function getPendingGraphErasures(): Promise<
  PendingGraphErasure[]
> {
  return await drizzleDbRef.current
    .select()
    .from(pendingGraphErasures)
    .execute();
}

export async function markGraphErasureAttempt(id: string): Promise<void> {
  await drizzleDbRef.current
    .update(pendingGraphErasures)
    .set({ last_attempt_at: new Date().toISOString() })
    .where(eq(pendingGraphErasures.id, id));
}

export async function completeGraphErasure(id: string): Promise<void> {
  await drizzleDbRef.current
    .delete(pendingGraphErasures)
    .where(eq(pendingGraphErasures.id, id));
}

export async function enqueueMemoryInvalidation(
  memory_id: string,
  effective_at: string,
): Promise<void> {
  await drizzleDbRef.current
    .insert(pendingMemoryInvalidations)
    .values({
      memory_id,
      effective_at,
      created_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: pendingMemoryInvalidations.memory_id,
      set: { effective_at },
    });
}

export async function getPendingMemoryInvalidations(): Promise<
  Array<{
    memory_id: string;
    effective_at: string;
  }>
> {
  return await drizzleDbRef.current
    .select({
      memory_id: pendingMemoryInvalidations.memory_id,
      effective_at: pendingMemoryInvalidations.effective_at,
    })
    .from(pendingMemoryInvalidations)
    .execute();
}

export async function completeMemoryInvalidation(
  memory_id: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(pendingMemoryInvalidations)
    .where(eq(pendingMemoryInvalidations.memory_id, memory_id));
}

export async function batchUpdateImportance(
  updates: { id: string; importance: number }[],
): Promise<void> {
  // updated_at is the optimistic-concurrency version for supersede/invalidate;
  // importance-only maintenance must not invalidate versions obtained by recall.
  for (const u of updates) {
    await drizzleDbRef.current
      .update(memories)
      .set({ importance: u.importance })
      .where(eq(memories.id, u.id));
  }
}
