/**
 * Neo4j vector store for semantic memory recall.
 *
 * Stores memory embeddings in Neo4j alongside the DB primary store.
 * Uses Ollama (embeddinggemma) for text → 768d vector conversion.
 * All operations gracefully degrade to no-ops when Neo4j or Ollama is unavailable.
 */

import neo4j, { type Driver } from 'neo4j-driver';
import { sha256Hex } from '../../lib/hash.js';
import {
  NEO4J_URI,
  NEO4J_USER,
  NEO4J_PASSWORD,
  EMBEDDING_MODEL,
  EMBEDDING_API_URL,
  VECTOR_MIN_SCORE,
  VECTOR_SEARCH_K_MULTIPLIER,
  ENABLE_VECTOR_STORE,
  EMBEDDING_DIMENSIONS,
} from './config.js';
import { logger } from '../../logger.js';
import { isLocalEndpoint } from '../../lib/chat-agents.js';
import {
  assertEgressAllowed,
  egressTarget,
  PrivacyRefusal,
} from '../../lib/privacy-policy.js';
import { normalizeEntityName, type GraphFact } from './graph-schema.js';
import type { VectorRecallStats } from './hooks.js';
import { protectedTargetTokens } from '../memory/privacy-token.js';
import type { KnowledgeDocumentSource } from '../knowledge/types.js';
import { assertPrivacyWriteEpoch } from '../memory/privacy-epoch.js';
import {
  EVAL_GROUP_PREFIX,
  PROD_VECTOR_INDEX,
  memoryLabelForGroup,
  vectorIndexForGroups,
} from './eval-isolation.js';

let driver: Driver | null = null;
let available = false;
let reconnectHandler: (() => Promise<void>) | null = null;

/** Register maintenance work that must run whenever Neo4j becomes reachable. */
export function setNeo4jReconnectHandler(
  handler: (() => Promise<void>) | null,
): void {
  reconnectHandler = handler;
}

// ── Lifecycle ────────────────────────────────────────────────────────

/** Connect to Neo4j. Non-blocking — logs and continues if unavailable. */
export async function initNeo4j(): Promise<void> {
  if (!ENABLE_VECTOR_STORE) {
    logger.info('Vector store disabled (ENABLE_VECTOR_STORE is not set)');
    return;
  }

  if (!NEO4J_URI || !NEO4J_PASSWORD) {
    logger.warn(
      'Neo4j not configured (missing NEO4J_URI or NEO4J_PASSWORD) — vector store disabled',
    );
    return;
  }

  try {
    driver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    );
    await driver.verifyConnectivity();
    available = true;
    logger.info({ uri: NEO4J_URI }, 'Neo4j vector store connected');

    // Ensure the vector index exists (idempotent)
    await ensureVectorIndex();
  } catch (err) {
    logger.warn(
      { err, uri: NEO4J_URI },
      'Neo4j connection failed — vector store disabled, using DB-only',
    );
    available = false;
    // Retain the configured driver: nulling it here made an initial outage
    // permanent because the reconnect loop had nothing to verify.
    scheduleReconnect();
  }
}

/** Clean shutdown. */
export async function closeNeo4j(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (driver) {
    try {
      await driver.close();
    } catch {
      /* ignore */
    }
    driver = null;
    available = false;
  }
}

/** Whether Neo4j vector store is currently available. */
export function isVectorStoreAvailable(): boolean {
  return available && driver !== null;
}

// ── Index Management ─────────────────────────────────────────────────

async function ensureVectorIndex(): Promise<void> {
  if (!driver) return;
  const session = driver.session();
  try {
    // Create the vector index for memories
    await session.run(
      `
      CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
      FOR (m:Memory)
      ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dimensions,
        \`vector.similarity_function\`: 'cosine'
      }}
    `,
      { dimensions: neo4j.int(EMBEDDING_DIMENSIONS) },
    );

    // Benchmark eval vectors — isolated from production :Memory index
    await session.run(
      `
      CREATE VECTOR INDEX eval_memory_embeddings IF NOT EXISTS
      FOR (m:EvalMemory)
      ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dimensions,
        \`vector.similarity_function\`: 'cosine'
      }}
    `,
      { dimensions: neo4j.int(EMBEDDING_DIMENSIONS) },
    );

    // Create the vector index for knowledge chunks
    await session.run(
      `
      CREATE VECTOR INDEX knowledge_embeddings IF NOT EXISTS
      FOR (k:KnowledgeChunk)
      ON (k.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dimensions,
        \`vector.similarity_function\`: 'cosine'
      }}
    `,
      { dimensions: neo4j.int(EMBEDDING_DIMENSIONS) },
    );

    // Per-id lookups (invalid_at marking, orphan sweep) otherwise scan the label
    await session.run(`
      CREATE INDEX memory_id IF NOT EXISTS
      FOR (m:Memory)
      ON (m.id)
    `);

    // Index for graph entity nodes — speeds up MERGE-on-normalized-name within group scope
    await session.run(`
      CREATE INDEX entity_name IF NOT EXISTS
      FOR (e:Entity)
      ON (e.group_folder, e.norm_name)
    `);

    logger.info('Neo4j vector indexes ensured');
  } catch (err) {
    // Index may already exist — that's fine
    logger.debug({ err }, 'Vector index creation skipped (may already exist)');
  } finally {
    await session.close();
  }
}

// ── Embedding ────────────────────────────────────────────────────────

const EMBED_TIMEOUT = 10_000;
const EMBED_RETRIES = 2;

/** Throws `PrivacyRefusal` when the project's privacy mode forbids embedding. */
export function assertEmbeddingEgressAllowed(projectId?: string): void {
  assertEgressAllowed({
    projectId,
    purpose: 'embedding',
    locality: isLocalEndpoint(EMBEDDING_API_URL) ? 'local' : 'remote',
    target: egressTarget(EMBEDDING_API_URL),
  });
}

/**
 * Get a 768d embedding vector for text via Ollama.
 * Returns null on failure (allows graceful degradation).
 */
export async function embedText(
  text: string,
  opts?: { projectId?: string },
): Promise<number[] | null> {
  if (!ENABLE_VECTOR_STORE) return null;
  try {
    assertEmbeddingEgressAllowed(opts?.projectId);
  } catch (err) {
    if (err instanceof PrivacyRefusal) return null;
    throw err;
  }
  for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT);

      let res: Response;
      try {
        res = await fetch(EMBEDDING_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        throw new Error(
          `Embedding API returned ${res.status}: ${await res.text()}`,
        );
      }

      const data = (await res.json()) as { embeddings: number[][] };
      if (
        data.embeddings &&
        data.embeddings[0] &&
        data.embeddings[0].length > 0
      ) {
        return data.embeddings[0];
      }
      throw new Error('Empty embedding response');
    } catch (err) {
      if (attempt < EMBED_RETRIES) {
        logger.debug({ err, attempt }, 'Embedding attempt failed, retrying');
        continue;
      }
      logger.warn(
        { err },
        'Failed to generate embedding — skipping vector store',
      );
      return null;
    }
  }
  return null;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** Never touches `invalid_at`: re-embedding must not revive an invalidated node. */
export const UPSERT_MEMORY_VECTOR_CYPHER = (label: string) =>
  `MERGE (m:${label} {id: $id})
       SET m.content = $content,
           m.group_folder = $groupFolder,
           m.objective_id = $objectiveId,
           m.embedding = $embedding,
           m.updated_at = datetime()`;

/**
 * Upsert a Memory node with its embedding vector.
 * Uses MERGE on id to handle both create and update.
 */
export async function upsertMemoryVector(
  id: string,
  group_folder: string,
  content: string,
  embedding: number[],
  objective_id?: string | null,
  expectedPrivacyEpoch?: number,
): Promise<void> {
  if (!driver || !available) return;

  const label = memoryLabelForGroup(group_folder);
  const session = driver.session();
  try {
    if (expectedPrivacyEpoch !== undefined) {
      assertPrivacyWriteEpoch(group_folder, expectedPrivacyEpoch);
    }
    await session.run(UPSERT_MEMORY_VECTOR_CYPHER(label), {
      id,
      content,
      groupFolder: group_folder,
      objectiveId: objective_id ?? null,
      embedding,
    });
  } catch (err) {
    logger.warn(
      { err, memoryId: id },
      'Failed to upsert memory vector in Neo4j',
    );
    markUnavailableOnConnectionError(err);
  } finally {
    await session.close();
  }
}

/** Move a memory vector and its provenance-owned relations to a new group. */
export async function moveMemoryData(
  id: string,
  sourceGroupFolder: string,
  targetGroupFolder: string,
): Promise<void> {
  if (!driver || !available) return;

  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `MATCH (m:Memory {id: $id})
         SET m.group_folder = $targetGroupFolder,
             m.objective_id = null,
             m.updated_at = datetime()`,
        { id, targetGroupFolder },
      );
      await tx.run(
        `MATCH (s:Entity)-[r:REL]->(o:Entity)
         WHERE r.source_memory_id = $id
           AND s.group_folder = $sourceGroupFolder
           AND o.group_folder = $sourceGroupFolder
         MERGE (targetS:Entity {norm_name: s.norm_name, group_folder: $targetGroupFolder})
           ON CREATE SET targetS.name = s.name, targetS.created_at = datetime()
         SET targetS.type = s.type, targetS.objective_id = null
         MERGE (targetO:Entity {norm_name: o.norm_name, group_folder: $targetGroupFolder})
           ON CREATE SET targetO.name = o.name, targetO.created_at = datetime()
         SET targetO.type = o.type, targetO.objective_id = null
         CREATE (targetS)-[moved:REL]->(targetO)
         SET moved = properties(r), moved.objective_id = null
         DELETE r`,
        { id, sourceGroupFolder, targetGroupFolder },
      );
      await tx.run(
        `MATCH (e:Entity {group_folder: $sourceGroupFolder})
         WHERE NOT (e)--()
         DELETE e`,
        { sourceGroupFolder },
      );
    });
  } catch (err) {
    logger.warn({ err, memoryId: id }, 'Failed to move memory data in Neo4j');
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Re-home an objective's memory vectors and provenance-owned relations into
 * another project, keeping their objective scope. Idempotent: relations
 * already in the target project no longer match, so a retry only repeats the
 * node update.
 */
export async function moveObjectiveMemoryData(
  memoryIds: string[],
  targetGroupFolder: string,
): Promise<void> {
  if (!driver || !available || memoryIds.length === 0) return;

  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `MATCH (m:Memory)
         WHERE m.id IN $ids
         SET m.group_folder = $targetGroupFolder`,
        { ids: memoryIds, targetGroupFolder },
      );
      await tx.run(
        `MATCH (s:Entity)-[r:REL]->(o:Entity)
         WHERE r.source_memory_id IN $ids
           AND s.group_folder <> $targetGroupFolder
           AND o.group_folder = s.group_folder
         MERGE (targetS:Entity {norm_name: s.norm_name, group_folder: $targetGroupFolder})
           ON CREATE SET targetS.name = s.name, targetS.created_at = datetime()
         SET targetS.type = s.type, targetS.objective_id = s.objective_id
         MERGE (targetO:Entity {norm_name: o.norm_name, group_folder: $targetGroupFolder})
           ON CREATE SET targetO.name = o.name, targetO.created_at = datetime()
         SET targetO.type = o.type, targetO.objective_id = o.objective_id
         CREATE (targetS)-[moved:REL]->(targetO)
         SET moved = properties(r)
         DELETE r
         WITH DISTINCT s, o
         UNWIND [s, o] AS e
         WITH DISTINCT e
         WHERE NOT (e)--()
         DELETE e`,
        { ids: memoryIds, targetGroupFolder },
      );
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to move objective memory data in Neo4j');
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Memory vector nodes stay in the index after invalidation (`invalid_at` is
 * set) so point-in-time recall still finds them. Current recall excludes them
 * so they cannot displace valid hits from the top-K; asOf recall keeps nodes
 * that were still valid at that instant.
 */
export function vectorValidityClause(asOf?: string, variable = 'node'): string {
  return asOf
    ? `(${variable}.invalid_at IS NULL OR ${variable}.invalid_at > datetime($asOf))`
    : `${variable}.invalid_at IS NULL`;
}

function objectiveScopeClause(objective_id?: string | null): string {
  return objective_id
    ? '(r.node.objective_id = $objectiveId OR r.node.objective_id IS NULL)'
    : 'r.node.objective_id IS NULL';
}

/**
 * One round trip returning the raw ANN row count, the count surviving the
 * scope filters (before LIMIT) and the limited hits, so a zero-hit recall can
 * be attributed to ANN starvation vs. the score floor. `filter` is a boolean
 * expression over `r.node`; hit order is the ANN order, as before.
 */
function vectorSearchCypher(filter: string): string {
  return `CALL db.index.vector.queryNodes($indexName, $k, $queryVec)
       YIELD node, score
       WITH collect({node: node, score: score}) AS raw
       WITH size(raw) AS rawAnnHits,
            [r IN raw WHERE ${filter}] AS kept
       RETURN rawAnnHits,
              size(kept) AS postFilterHits,
              [r IN kept | {id: r.node.id, score: r.score}][0..$limit] AS hits`;
}

function toCount(value: unknown): number {
  return neo4j.isInt(value) ? value.toNumber() : Number(value ?? 0);
}

function mapVectorHits(
  records: { get: (key: string) => unknown }[],
  stats?: VectorRecallStats,
): { id: string; score: number }[] {
  const record = records[0];
  if (!record) return [];
  const rows = ((record.get('hits') as unknown[] | null) ?? []).map((h) => {
    const row = h as { id: string; score: number };
    return { id: row.id, score: row.score };
  });
  const hits = rows.filter((r) => r.score >= VECTOR_MIN_SCORE);
  if (stats) {
    stats.rawAnnHits = toCount(record.get('rawAnnHits'));
    stats.postFilterHits = toCount(record.get('postFilterHits'));
    stats.belowMinScore = rows.length - hits.length;
  }
  return hits;
}

interface VectorSearchSession {
  run(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<{ records: { get: (key: string) => unknown }[] }>;
}

export async function searchSimilarMultiGroupInSession(
  session: VectorSearchSession,
  groupFolders: string[],
  queryEmbedding: number[],
  limit: number,
  objective_id?: string | null,
  asOf?: string,
  stats?: VectorRecallStats,
): Promise<{ id: string; score: number }[]> {
  const result = await session.run(
    vectorSearchCypher(
      `r.node.group_folder IN $groupFolders AND ${objectiveScopeClause(objective_id)}
         AND ${vectorValidityClause(asOf, 'r.node')}`,
    ),
    {
      indexName: vectorIndexForGroups(groupFolders),
      k: neo4j.int(limit * VECTOR_SEARCH_K_MULTIPLIER),
      queryVec: queryEmbedding,
      groupFolders,
      objectiveId: objective_id ?? null,
      asOf: asOf ?? null,
      limit: neo4j.int(limit),
    },
  );
  return mapVectorHits(result.records, stats);
}

export async function searchSimilarAllGroupsInSession(
  session: VectorSearchSession,
  queryEmbedding: number[],
  limit: number,
  objective_id?: string | null,
  asOf?: string,
  stats?: VectorRecallStats,
): Promise<{ id: string; score: number }[]> {
  const result = await session.run(
    vectorSearchCypher(
      `${objectiveScopeClause(objective_id)}
         AND NOT r.node.group_folder STARTS WITH $evalPrefix
         AND ${vectorValidityClause(asOf, 'r.node')}`,
    ),
    {
      indexName: PROD_VECTOR_INDEX,
      k: neo4j.int(limit * VECTOR_SEARCH_K_MULTIPLIER),
      queryVec: queryEmbedding,
      objectiveId: objective_id ?? null,
      evalPrefix: EVAL_GROUP_PREFIX,
      asOf: asOf ?? null,
      limit: neo4j.int(limit),
    },
  );
  return mapVectorHits(result.records, stats);
}

/**
 * Search similar memories across multiple group folders (for main/parent scoping).
 * When objective_id is provided, returns objective-scoped + project-wide memories.
 * When omitted, returns only project-wide memories (objective_id IS NULL).
 * Optional `stats` is filled with raw/post-filter/below-score counts.
 */
export async function searchSimilarMultiGroup(
  groupFolders: string[],
  queryEmbedding: number[],
  limit: number,
  objective_id?: string | null,
  asOf?: string,
  stats?: VectorRecallStats,
): Promise<{ id: string; score: number }[]> {
  if (!driver || !available) return [];
  if (groupFolders.length === 0) {
    // Empty = all groups (main agent)
    return searchSimilarAllGroups(
      queryEmbedding,
      limit,
      objective_id,
      asOf,
      stats,
    );
  }

  const session = driver.session();
  try {
    return await searchSimilarMultiGroupInSession(
      session,
      groupFolders,
      queryEmbedding,
      limit,
      objective_id,
      asOf,
      stats,
    );
  } catch (err) {
    logger.warn({ err }, 'Multi-group vector search failed');
    markUnavailableOnConnectionError(err);
    return [];
  } finally {
    await session.close();
  }
}

/** Search similar across ALL groups (used by main agent). */
async function searchSimilarAllGroups(
  queryEmbedding: number[],
  limit: number,
  objective_id?: string | null,
  asOf?: string,
  stats?: VectorRecallStats,
): Promise<{ id: string; score: number }[]> {
  if (!driver || !available) return [];

  const session = driver.session();
  try {
    return await searchSimilarAllGroupsInSession(
      session,
      queryEmbedding,
      limit,
      objective_id,
      asOf,
      stats,
    );
  } catch (err) {
    logger.warn({ err }, 'All-group vector search failed');
    markUnavailableOnConnectionError(err);
    return [];
  } finally {
    await session.close();
  }
}

/**
 * Permanently erase all Neo4j data owned by a memory.
 *
 * Temporal invalidation deliberately does not call this: historical vectors
 * and relation provenance remain usable for point-in-time recall. Privacy
 * erasure removes provenance relations, the vector node, and entity nodes that
 * became orphaned solely because those relations were removed.
 */
export async function eraseMemoryData(
  id: string,
  targetHashes: string[],
  tokenScheme: 'hmac-sha256' | 'sha256' = 'hmac-sha256',
): Promise<void> {
  if (!driver || !available) {
    throw new Error(
      'Vector store is unavailable; memory erasure was not completed',
    );
  }

  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await eraseMemoryDataInSession(tx, id, targetHashes, tokenScheme);
    });
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

interface ErasureCypherRunner {
  run(query: string, params?: Record<string, unknown>): Promise<unknown>;
}

export async function invalidateMemoryGraph(
  memoryId: string,
  effectiveAt: string,
): Promise<void> {
  if (!driver || !available) {
    throw new Error(
      'Vector store is unavailable; memory invalidation was not completed',
    );
  }
  const session = driver.session();
  try {
    await invalidateMemoryGraphInSession(session, memoryId, effectiveAt);
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

export async function invalidateMemoryGraphInSession(
  session: ErasureCypherRunner,
  memoryId: string,
  effectiveAt: string,
): Promise<void> {
  await session.run(
    `MATCH ()-[r:REL]->()
     WHERE r.source_memory_id = $memoryId
       AND (r.valid_from IS NULL OR r.valid_from <= datetime($effectiveAt))
       AND (r.valid_to IS NULL OR r.valid_to > datetime($effectiveAt))
     SET r.valid_to = datetime($effectiveAt)`,
    { memoryId, effectiveAt },
  );
  // Keep the vector node for asOf recall; mark it so current recall skips it.
  await session.run(
    `MATCH (m)
     WHERE (m:Memory OR m:EvalMemory) AND m.id = $memoryId
     SET m.invalid_at = datetime($effectiveAt)`,
    { memoryId, effectiveAt },
  );
}

/**
 * Backfill/race catch: mark vector nodes of memories that are already invalid
 * in SQL but whose node has no `invalid_at` (pre-existing nodes, or nodes
 * embedded after the invalidation ran). Idempotent: already-marked nodes are
 * left untouched. Returns the number of nodes newly marked.
 */
export async function markMemoryVectorsInvalid(
  items: Array<{ id: string; effectiveAt: string }>,
): Promise<number> {
  if (items.length === 0) return 0;
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; reconcile was not completed');
  }
  const session = driver.session();
  try {
    const result = await session.run(
      `UNWIND $items AS item
       MATCH (m)
       WHERE (m:Memory OR m:EvalMemory) AND m.id = item.id
         AND m.invalid_at IS NULL
       SET m.invalid_at = datetime(item.effectiveAt)
       RETURN count(m) AS marked`,
      { items },
    );
    const marked = result.records[0]?.get('marked');
    return toCount(marked);
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/** Nodes touched within the grace window may belong to an in-flight memorize. */
export const LIST_MEMORY_VECTOR_IDS_CYPHER = `MATCH (m)
     WHERE (m:Memory OR m:EvalMemory)
       AND m.group_folder = $groupFolder
       AND m.id > $afterId
       AND m.updated_at < datetime() - duration('PT10M')
     RETURN m.id AS id
     ORDER BY m.id
     LIMIT $limit`;

export const DELETE_ORPHAN_MEMORY_VECTORS_CYPHER = `MATCH (m)
     WHERE (m:Memory OR m:EvalMemory) AND m.id IN $ids
     DETACH DELETE m
     RETURN count(m) AS deleted`;

/** One keyset page of vector node ids in a group, past the in-flight grace. */
export async function listMemoryVectorIdsPage(
  group_folder: string,
  afterId: string,
  limit: number,
): Promise<string[]> {
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; orphan sweep was not run');
  }
  const session = driver.session();
  try {
    const result = await session.run(LIST_MEMORY_VECTOR_IDS_CYPHER, {
      groupFolder: group_folder,
      afterId,
      limit: neo4j.int(limit),
    });
    return result.records.map((r) => r.get('id') as string);
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

export const FIND_EXISTING_MEMORY_VECTOR_IDS_CYPHER = `MATCH (m)
     WHERE (m:Memory OR m:EvalMemory) AND m.id IN $ids
     RETURN m.id AS id`;

/** Find vector nodes whose stored project differs from the SQL project. */
export async function findMisScopedMemoryVectors(
  ids: string[],
  groupFolder: string,
): Promise<Array<{ id: string; sourceGroupFolder: string }>> {
  if (ids.length === 0) return [];
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; scopes were not measured');
  }
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Memory)
       WHERE m.id IN $ids AND m.group_folder <> $groupFolder
       RETURN m.id AS id, m.group_folder AS sourceGroupFolder`,
      { ids, groupFolder },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      sourceGroupFolder: r.get('sourceGroupFolder') as string,
    }));
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/** Which of the given memory ids have a vector node (read-only). */
export async function findExistingMemoryVectorIds(
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; coverage was not measured');
  }
  const session = driver.session();
  try {
    const result = await session.run(FIND_EXISTING_MEMORY_VECTOR_IDS_CYPHER, {
      ids,
    });
    return new Set(result.records.map((r) => r.get('id') as string));
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/** Delete vector nodes (and attached edges) whose SQL row no longer exists. */
export async function deleteOrphanMemoryVectors(
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; orphan sweep was not run');
  }
  const session = driver.session();
  try {
    const result = await session.run(DELETE_ORPHAN_MEMORY_VECTORS_CYPHER, {
      ids,
    });
    const deleted = result.records[0]?.get('deleted');
    return toCount(deleted);
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/** Store-level erasure split out so the privacy Cypher is unit-testable. */
export async function eraseMemoryDataInSession(
  session: ErasureCypherRunner,
  id: string,
  targetHashes: string[] = [],
  tokenScheme: 'hmac-sha256' | 'sha256' = 'hmac-sha256',
): Promise<void> {
  const entityResult: any = await session.run(
    `MATCH (e:Entity)-[r:REL]-()
     WHERE r.source_memory_id = $id
     RETURN DISTINCT elementId(e) AS entityId, e.name AS name`,
    { id },
  );
  const sensitiveEntityIds = (entityResult.records ?? [])
    .filter((record: any) =>
      entityContainsForgottenContent(
        graphTextHashes(String(record.get('name') ?? ''), tokenScheme),
        new Set(targetHashes),
      ),
    )
    .map((record: any) => record.get('entityId'));

  await session.run(
    `OPTIONAL MATCH (s:Entity)-[r:REL]->(o:Entity)
     WHERE r.source_memory_id = $id
     WITH collect(r) AS relations,
          collect(DISTINCT s) + collect(DISTINCT o) AS entities
     FOREACH (relation IN relations | DELETE relation)
     WITH entities
     UNWIND entities AS entity
     WITH DISTINCT entity
     WHERE NOT (entity)--()
     DELETE entity`,
    { id },
  );

  if (sensitiveEntityIds.length > 0) {
    await session.run(
      `MATCH (e:Entity)
       WHERE elementId(e) IN $entityIds AND (e)--()
       SET e.name = '[erased]',
           e.norm_name = '__erased__:' + elementId(e),
           e.type = null,
           e.privacy_erased = true`,
      { entityIds: sensitiveEntityIds },
    );
  }

  await session.run(
    `MATCH (m)
     WHERE (m:Memory OR m:EvalMemory) AND m.id = $id
     DETACH DELETE m`,
    { id },
  );
}

export async function eraseGraphFactsMatchingTarget(
  group_folder: string,
  targetHashes: string[],
  tokenScheme: 'hmac-sha256' | 'sha256' = 'hmac-sha256',
): Promise<void> {
  if (!driver || !available) {
    throw new Error(
      'Vector store is unavailable; graph erasure was not completed',
    );
  }
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await eraseGraphFactsMatchingTargetInSession(
        tx,
        group_folder,
        targetHashes,
        tokenScheme,
      );
    });
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

function graphTextHashes(
  value: string,
  tokenScheme: 'hmac-sha256' | 'sha256',
): Set<string> {
  if (tokenScheme === 'sha256') {
    return new Set(
      value
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 2)
        .map((word) => sha256Hex(word)),
    );
  }
  return new Set(protectedTargetTokens(value));
}

function hashesOverlapTarget(
  candidate: Set<string>,
  target: Set<string>,
): boolean {
  if (target.size === 0 || candidate.size === 0) return false;
  let hits = 0;
  for (const hash of target) if (candidate.has(hash)) hits++;
  return hits / Math.min(target.size, candidate.size) >= 0.5;
}

function entityContainsForgottenContent(
  candidate: Set<string>,
  target: Set<string>,
): boolean {
  if (target.size === 0 || candidate.size === 0) return false;
  if (target.size === 1)
    return candidate.size === 1 && hashesOverlapTarget(candidate, target);
  if (candidate.size < 2) return false;
  for (const hash of candidate) if (!target.has(hash)) return false;
  return true;
}

export async function eraseGraphFactsMatchingTargetInSession(
  session: ErasureCypherRunner,
  group_folder: string,
  targetHashes: string[],
  tokenScheme: 'hmac-sha256' | 'sha256' = 'hmac-sha256',
): Promise<void> {
  const result: any = await session.run(
    `MATCH (s:Entity)-[r:REL]->(o:Entity)
     WHERE s.group_folder = $groupFolder
     RETURN elementId(r) AS relationId,
            elementId(s) AS subjectId,
            elementId(o) AS objectId,
            s.name AS subject,
            o.name AS object,
            r.relation AS relation,
            r.raw_label AS rawLabel`,
    { groupFolder: group_folder },
  );
  const target = new Set(targetHashes);
  const matches = (result.records ?? []).filter((record: any) => {
    const candidate = graphTextHashes(
      [
        record.get('subject'),
        record.get('relation'),
        record.get('rawLabel'),
        record.get('object'),
      ]
        .filter(Boolean)
        .join(' '),
      tokenScheme,
    );
    return hashesOverlapTarget(candidate, target);
  });
  if (matches.length === 0) return;

  const relationIds = matches.map((record: any) => record.get('relationId'));
  const entityIds = [
    ...new Set(
      matches.flatMap((record: any) => [
        record.get('subjectId'),
        record.get('objectId'),
      ]),
    ),
  ];
  const sensitiveEntityIds = [
    ...new Set(
      matches
        .flatMap((record: any) => [
          { id: record.get('subjectId'), name: record.get('subject') },
          { id: record.get('objectId'), name: record.get('object') },
        ])
        .filter((entity: any) =>
          entityContainsForgottenContent(
            graphTextHashes(String(entity.name ?? ''), tokenScheme),
            target,
          ),
        )
        .map((entity: any) => entity.id),
    ),
  ];
  await session.run(
    `MATCH ()-[r:REL]->()
     WHERE elementId(r) IN $relationIds
     DELETE r`,
    { relationIds },
  );
  await session.run(
    `MATCH (e:Entity)
     WHERE elementId(e) IN $entityIds AND (e)--()
     SET e.name = '[erased]',
         e.norm_name = '__erased__:' + elementId(e),
         e.type = null,
         e.privacy_erased = true`,
    { entityIds: sensitiveEntityIds },
  );
  await session.run(
    `MATCH (e:Entity)
     WHERE elementId(e) IN $entityIds
       AND NOT (e)--()
     DELETE e`,
    { entityIds },
  );
}

/** Exact-equality scope: never prefix/regex, so sibling folders are untouched. */
export const DELETE_GROUP_MEMORY_GRAPH_CYPHER = `MATCH (n)
WHERE (n:Memory OR n:EvalMemory OR n:Entity) AND n.group_folder = $g
DETACH DELETE n
RETURN count(n) AS c`;

/**
 * Delete every :Memory/:EvalMemory/:Entity node (and its relations) owned by
 * one project folder. Returns 0 without querying for blank or eval folders.
 */
export async function deleteGroupMemoryGraphInSession(
  session: {
    run(
      query: string,
      params?: Record<string, unknown>,
    ): Promise<{ records: Array<{ get(key: string): unknown }> }>;
  },
  groupFolder: string,
): Promise<number> {
  if (!groupFolder.trim() || groupFolder.startsWith(EVAL_GROUP_PREFIX)) {
    return 0;
  }
  const result = await session.run(DELETE_GROUP_MEMORY_GRAPH_CYPHER, {
    g: groupFolder,
  });
  const count = result.records[0]?.get('c');
  return toCount(count);
}

/** Erase a deleted project's memory text and entities from Neo4j. */
export async function deleteGroupMemoryGraph(
  groupFolder: string,
): Promise<number> {
  if (!groupFolder.trim() || groupFolder.startsWith(EVAL_GROUP_PREFIX)) {
    return 0;
  }
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; project graph not deleted');
  }
  const session = driver.session();
  try {
    return await deleteGroupMemoryGraphInSession(session, groupFolder);
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

/** Exact-equality scope: never prefix/regex, so sibling folders are untouched. */
export const RENAME_GROUP_MEMORY_GRAPH_CYPHER = `MATCH (n)
WHERE (n:Memory OR n:Entity) AND n.group_folder = $old
SET n.group_folder = $new
RETURN count(n) AS c`;

function isRenameableGraphFolder(folder: string): boolean {
  return !!folder.trim() && !folder.startsWith(EVAL_GROUP_PREFIX);
}

/**
 * Re-key every :Memory/:Entity node of one project folder to a new folder in a
 * single write. Returns 0 without querying for blank or eval folders.
 */
export async function renameGroupMemoryGraphInSession(
  session: {
    run(
      query: string,
      params?: Record<string, unknown>,
    ): Promise<{ records: Array<{ get(key: string): unknown }> }>;
  },
  oldFolder: string,
  newFolder: string,
): Promise<number> {
  if (
    !isRenameableGraphFolder(oldFolder) ||
    !isRenameableGraphFolder(newFolder)
  ) {
    return 0;
  }
  const result = await session.run(RENAME_GROUP_MEMORY_GRAPH_CYPHER, {
    old: oldFolder,
    new: newFolder,
  });
  const count = result.records[0]?.get('c');
  return toCount(count);
}

/** Move a renamed project's memory/entity nodes to its new folder in Neo4j. */
export async function renameGroupMemoryGraph(
  oldFolder: string,
  newFolder: string,
): Promise<number> {
  if (
    !isRenameableGraphFolder(oldFolder) ||
    !isRenameableGraphFolder(newFolder)
  ) {
    return 0;
  }
  if (!driver || !available) {
    throw new Error('Vector store is unavailable; project graph not renamed');
  }
  const session = driver.session();
  try {
    return await renameGroupMemoryGraphInSession(session, oldFolder, newFolder);
  } catch (err) {
    markUnavailableOnConnectionError(err);
    throw err;
  } finally {
    await session.close();
  }
}

// ── Graph: entities & relations ──────────────────────────────────────

/**
 * Upsert an :Entity node, namespaced by group_folder.
 * Entity resolution v1 = case-insensitive exact match (MERGE on normalized
 * name within the group scope). See graph-schema.normalizeEntityName for the
 * future fuzzy-resolution seam.
 */
export async function upsertEntity(
  name: string,
  group_folder: string,
  objective_id?: string | null,
  type?: string | null,
): Promise<void> {
  if (!driver || !available) return;
  const norm = normalizeEntityName(name);
  if (!norm) return;

  const session = driver.session();
  try {
    await session.run(
      `MERGE (e:Entity {norm_name: $norm, group_folder: $groupFolder})
       ON CREATE SET e.name = $name, e.created_at = datetime()
       SET e.objective_id = $objectiveId,
           e.type = coalesce($type, e.type)`,
      {
        norm,
        name: name.trim(),
        groupFolder: group_folder,
        objectiveId: objective_id ?? null,
        type: type ?? null,
      },
    );
  } catch (err) {
    logger.warn({ err, name }, 'Failed to upsert entity in Neo4j');
    markUnavailableOnConnectionError(err);
  } finally {
    await session.close();
  }
}

/**
 * Upsert a (subject)-[:REL]->(object) edge with bi-temporal validity.
 *
 * Reconciliation (v1 contradiction rule): insert the observation into the
 * effective-time relation timeline. The edge active at that instant is closed,
 * while any newer edge remains current and bounds the inserted edge.
 */
export async function upsertRelation(params: {
  subject: string;
  relation: string;
  object: string;
  group_folder: string;
  source_memory_id?: string | null;
  raw_label?: string | null;
  objective_id?: string | null;
  validFrom?: string;
  expectedPrivacyEpoch?: number;
}): Promise<void> {
  if (!driver || !available) return;
  const subjNorm = normalizeEntityName(params.subject);
  const objNorm = normalizeEntityName(params.object);
  if (!subjNorm || !objNorm) return;

  const session = driver.session();
  try {
    if (params.expectedPrivacyEpoch !== undefined) {
      assertPrivacyWriteEpoch(params.group_folder, params.expectedPrivacyEpoch);
    }
    await upsertRelationInSession(session, params);
  } catch (err) {
    logger.warn(
      { err, subject: params.subject, object: params.object },
      'Failed to upsert relation in Neo4j',
    );
    markUnavailableOnConnectionError(err);
  } finally {
    await session.close();
  }
}

interface CypherRunner {
  run(query: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Store-level relation mutation, split out so temporal Cypher is unit-testable. */
export async function upsertRelationInSession(
  session: CypherRunner,
  params: {
    subject: string;
    relation: string;
    object: string;
    group_folder: string;
    source_memory_id?: string | null;
    raw_label?: string | null;
    objective_id?: string | null;
    validFrom?: string;
    expectedPrivacyEpoch?: number;
  },
): Promise<void> {
  const subjNorm = normalizeEntityName(params.subject);
  const objNorm = normalizeEntityName(params.object);
  if (!subjNorm || !objNorm) return;

  const effectiveAt = params.validFrom ?? new Date().toISOString();
  const args = {
    subjNorm,
    objNorm,
    subject: params.subject.trim(),
    object: params.object.trim(),
    relation: params.relation,
    groupFolder: params.group_folder,
    sourceMemoryId: params.source_memory_id ?? null,
    rawLabel: params.raw_label ?? null,
    objectiveId: params.objective_id ?? null,
    effectiveAt,
  };

  await session.run(
    `MERGE (s:Entity {norm_name: $subjNorm, group_folder: $groupFolder})
       ON CREATE SET s.name = $subject, s.created_at = datetime()
     MERGE (o:Entity {norm_name: $objNorm, group_folder: $groupFolder})
       ON CREATE SET o.name = $object, o.created_at = datetime()
     WITH s, o
     OPTIONAL MATCH (s)-[future:REL {relation: $relation}]->()
     WHERE future.valid_from > datetime($effectiveAt)
     WITH s, o, min(future.valid_from) AS nextValidFrom
     OPTIONAL MATCH (s)-[active:REL {relation: $relation}]->()
     WHERE (active.valid_from IS NULL OR active.valid_from <= datetime($effectiveAt))
       AND (active.valid_to IS NULL OR active.valid_to > datetime($effectiveAt))
     SET active.valid_to = datetime($effectiveAt)
     WITH DISTINCT s, o, nextValidFrom
     MERGE (s)-[r:REL {
       relation: $relation,
       valid_from: datetime($effectiveAt)
     }]->(o)
     SET r.valid_to = nextValidFrom,
         r.source_memory_id = $sourceMemoryId,
         r.raw_label = $rawLabel,
         r.objective_id = $objectiveId`,
    args,
  );
}

/**
 * 1-hop expansion: given the text of the top matched memories, find entities
 * mentioned in them and return relations valid at asOf (or current relations
 * when omitted) as additional context, each carrying provenance.
 *
 * Seeding is content-based (entity name appears in a matched memory). v1 keeps
 * this lightweight; TODO(v2): seed via explicit (:Entity)->(:Memory) links once
 * relations carry per-memory provenance edges.
 *
 * A minimum-length floor on norm_name guards against very short names (e.g. an
 * initial like "j") substring-matching many memory contents and pulling in
 * spurious relations.
 */
const MIN_SEED_ENTITY_LENGTH = 3;

export async function expandEntities(
  contents: string[],
  groupFolders: string[],
  limit: number,
  asOf?: string,
): Promise<GraphFact[]> {
  if (!driver || !available) return [];
  const lowered = contents
    .map((c) => (c || '').toLowerCase())
    .filter((c) => c.length > 0);
  if (lowered.length === 0) return [];

  const session = driver.session();
  try {
    const groupFilter =
      groupFolders.length > 0 ? 'AND e.group_folder IN $groupFolders' : '';

    const validityFilter = asOf
      ? `AND (r.valid_from IS NULL OR r.valid_from <= datetime($asOf))
         AND (r.valid_to IS NULL OR r.valid_to > datetime($asOf))`
      : 'AND r.valid_to IS NULL';

    const result = await session.run(
      `UNWIND $contents AS content
       MATCH (e:Entity)
       WHERE size(e.norm_name) >= $minSeedLen
         AND content CONTAINS e.norm_name ${groupFilter}
       WITH DISTINCT e
       MATCH (e)-[r:REL]-(t:Entity)
       WHERE true ${validityFilter}
       RETURN DISTINCT
         startNode(r).name AS subject,
         r.relation AS relation,
         r.raw_label AS rawLabel,
         endNode(r).name AS object,
         r.source_memory_id AS sourceMemoryId
       LIMIT $limit`,
      {
        contents: lowered,
        groupFolders,
        asOf: asOf ?? null,
        minSeedLen: neo4j.int(MIN_SEED_ENTITY_LENGTH),
        limit: neo4j.int(limit),
      },
    );

    // any: neo4j-driver types not available in this environment
    return result.records.map((r: any) => ({
      subject: r.get('subject') as string,
      relation: r.get('relation') as string,
      object: r.get('object') as string,
      rawLabel: (r.get('rawLabel') as string | null) ?? null,
      sourceMemoryId: (r.get('sourceMemoryId') as string | null) ?? null,
    }));
  } catch (err) {
    logger.warn({ err }, 'Entity 1-hop expansion failed');
    markUnavailableOnConnectionError(err);
    return [];
  } finally {
    await session.close();
  }
}

// ── Health ───────────────────────────────────────────────────────────

/**
 * If a connection-level error occurs, mark Neo4j as unavailable.
 * Future operations will no-op until reconnected.
 */
function markUnavailableOnConnectionError(err: unknown): void {
  if (
    err instanceof Error &&
    (err.message.includes('connection') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('ServiceUnavailable'))
  ) {
    logger.warn(
      'Neo4j connection lost — disabling vector store until reconnect',
    );
    available = false;
    // Try to reconnect in the background
    scheduleReconnect();
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (available || !driver) return;
    try {
      await driver.verifyConnectivity();
      available = true;
      await ensureVectorIndex();
      logger.info('Neo4j vector store reconnected');
      await reconnectHandler?.();
    } catch {
      logger.debug('Neo4j reconnect failed, will retry');
      scheduleReconnect();
    }
  }, 30_000); // retry every 30s
}

/**
 * Upsert a KnowledgeChunk node with its embedding vector.
 */
export async function upsertKnowledgeChunkVector(
  id: string,
  knowledge_base_id: string,
  content: string,
  embedding: number[],
  metadata: any = {},
): Promise<void> {
  if (!driver || !available) return;

  const session = driver.session();
  try {
    await session.run(
      `
      MERGE (k:KnowledgeChunk {id: $id})
       SET k.content = $content,
           k.knowledge_base_id = $knowledge_base_id,
           k.source = $source,
           k.embedding = $embedding,
           k.metadata = $metadata,
           k.updated_at = datetime()`,
      {
        id,
        content,
        knowledge_base_id,
        source: metadata.source || '',
        embedding,
        metadata: JSON.stringify(metadata),
      },
    );
  } catch (err) {
    logger.warn(
      { err, chunkId: id },
      'Failed to upsert knowledge chunk vector in Neo4j',
    );
    markUnavailableOnConnectionError(err);
  } finally {
    await session.close();
  }
}

/**
 * Search for semantically similar knowledge chunks across multiple knowledge bases.
 */
export async function searchKnowledgeSimilar(
  knowledgeBaseIds: string[],
  queryEmbedding: number[],
  limit: number,
  allowedSources?: KnowledgeDocumentSource[],
): Promise<
  {
    id: string;
    content: string;
    score: number;
    knowledge_base_id: string;
    metadata: any;
  }[]
> {
  if (
    !driver ||
    !available ||
    knowledgeBaseIds.length === 0 ||
    allowedSources?.length === 0
  )
    return [];

  const session = driver.session();
  try {
    const result = await session.run(
      allowedSources
        ? `
      MATCH (node:KnowledgeChunk)
       WHERE node.knowledge_base_id IN $knowledgeBaseIds
         AND any(source IN $allowedSources WHERE source.kbId = node.knowledge_base_id AND source.path = node.source)
         AND node.embedding IS NOT NULL
         AND size(node.embedding) = size($queryVec)
       WITH node, vector.similarity.cosine(node.embedding, $queryVec) AS score
       WHERE score IS NOT NULL
       RETURN node.id AS id, node.content AS content, node.knowledge_base_id AS kb_id, node.metadata AS metadata, score
       ORDER BY score DESC
       LIMIT $limit`
        : `
      CALL db.index.vector.queryNodes('knowledge_embeddings', $k, $queryVec)
       YIELD node, score
       WHERE node.knowledge_base_id IN $knowledgeBaseIds
       RETURN node.id AS id, node.content AS content, node.knowledge_base_id AS kb_id, node.metadata AS metadata, score
       LIMIT $limit`,
      {
        k: neo4j.int(limit * 5),
        queryVec: queryEmbedding,
        knowledgeBaseIds,
        allowedSources: allowedSources || [],
        limit: neo4j.int(limit),
      },
    );
    return result.records.map((r: any) => ({
      id: r.get('id'),
      content: r.get('content'),
      knowledge_base_id: r.get('kb_id'),
      metadata: r.get('metadata') ? JSON.parse(r.get('metadata')) : {},
      score: r.get('score'),
    }));
  } catch (err) {
    logger.warn(
      { err, knowledgeBaseIds },
      'Knowledge similarity search failed',
    );
    markUnavailableOnConnectionError(err);
    return [];
  } finally {
    await session.close();
  }
}

export async function deleteKnowledgeBaseVectors(
  knowledge_base_id: string,
): Promise<void> {
  if (!driver || !available) return;
  const session = driver.session();
  try {
    await session.run(
      'MATCH (k:KnowledgeChunk {knowledge_base_id: $kb_id}) DETACH DELETE k',
      { kb_id: knowledge_base_id },
    );
  } finally {
    await session.close();
  }
}

export async function deleteKnowledgeFileVectors(
  knowledge_base_id: string,
  source: string,
): Promise<void> {
  if (!driver || !available) return;
  const session = driver.session();
  try {
    await session.run(
      'MATCH (k:KnowledgeChunk {knowledge_base_id: $kb_id, source: $source}) DETACH DELETE k',
      { kb_id: knowledge_base_id, source },
    );
  } finally {
    await session.close();
  }
}
