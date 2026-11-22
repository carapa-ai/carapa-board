/**
 * Vector store hooks — allows core memorize/recall/forget tools to use
 * vector search when the module is loaded, without a direct import.
 */

import type { GraphFact } from './graph-schema.js';

/**
 * Optional out-parameter filled by `enhanceRecall` so callers can tell why a
 * recall produced no vector hits. Counts and booleans only.
 */
export interface VectorRecallStats {
  /** Store was unavailable (Neo4j down / not connected). */
  unavailable: boolean;
  /** Query was never embedded (privacy refusal or embedding failure). */
  embedSkipped: boolean;
  /** Rows the ANN index returned (top-k) before any filtering. */
  rawAnnHits: number;
  /** Rows left after group/objective/eval-prefix/validity filters, before LIMIT. */
  postFilterHits: number;
  /** Rows dropped for scoring below VECTOR_MIN_SCORE (counted after LIMIT). */
  belowMinScore: number;
}

export function createVectorRecallStats(): VectorRecallStats {
  return {
    unavailable: false,
    embedSkipped: false,
    rawAnnHits: 0,
    postFilterHits: 0,
    belowMinScore: 0,
  };
}

export interface VectorStoreHooks {
  /** Embed text and store in Neo4j (fire-and-forget). */
  embedAndStore(
    memoryId: string,
    group_folder: string,
    content: string,
    objective_id?: string | null,
  ): Promise<void>;

  /** Move vector and provenance graph data into another project scope. */
  moveMemoryScope?(
    memoryId: string,
    sourceGroupFolder: string,
    targetGroupFolder: string,
  ): Promise<void>;

  /**
   * Move an objective's memory vectors and provenance graph data into another
   * project scope, keeping their objective scope. Throws when the store fails.
   */
  moveObjectiveMemoryScope?(
    memoryIds: string[],
    targetGroupFolder: string,
  ): Promise<void>;

  /**
   * Enhance recall with vector search. Returns ranked IDs+scores or null
   * when vector store is unavailable.
   */
  enhanceRecall(params: {
    groupFolders: string[];
    query: string;
    limit: number;
    objective_id?: string | null;
    /** Point-in-time recall: keep vectors invalidated after this instant. */
    asOf?: string;
    /** Out-parameter: filled with zero-hit diagnostics when provided. */
    stats?: VectorRecallStats;
  }): Promise<{ id: string; score: number }[] | null>;

  /** Irreversibly erase a memory vector and graph relations with its provenance. */
  eraseMemory(
    memoryId: string,
    targetHashes: string[],
    tokenScheme?: 'hmac-sha256' | 'sha256',
  ): Promise<void>;

  /**
   * Delete every memory/entity graph node owned by a deleted project folder
   * (exact match). Resolves to the node count; throws when the store is down.
   */
  deleteGroupMemoryGraph?(group_folder: string): Promise<number>;

  /**
   * Re-key every memory/entity graph node of a renamed project folder to the
   * new folder (exact match). Resolves to the node count; throws when the
   * store is down.
   */
  renameGroupMemoryGraph?(
    old_folder: string,
    new_folder: string,
  ): Promise<number>;

  /** Close provenance-backed relation validity while retaining history. */
  invalidateMemory(memoryId: string, effectiveAt: string): Promise<void>;

  /**
   * Mark vector nodes of already-invalid memories so current recall skips
   * them. Idempotent; resolves to the number of nodes newly marked.
   */
  markInvalidatedVectors?(
    items: Array<{ id: string; effectiveAt: string }>,
  ): Promise<number>;

  /** One keyset page of vector node ids in a group (past the in-flight grace). */
  listMemoryVectorIdsPage?(
    group_folder: string,
    afterId: string,
    limit: number,
  ): Promise<string[]>;

  /**
   * Which of the given memory ids have a vector node. Throws when the store
   * is unavailable.
   */
  findExistingMemoryVectorIds?(ids: string[]): Promise<Set<string>>;

  /** Find existing vector nodes in a different project scope. */
  findMisScopedMemoryVectors?(
    ids: string[],
    groupFolder: string,
  ): Promise<Array<{ id: string; sourceGroupFolder: string }>>;

  /** Delete vector nodes whose SQL row is gone; resolves to the count deleted. */
  deleteOrphanMemoryVectors?(ids: string[]): Promise<number>;

  /** Erase every relation matching protected target tokens within one group. */
  eraseGraphFactsMatchingTarget(
    group_folder: string,
    targetHashes: string[],
    tokenScheme?: 'hmac-sha256' | 'sha256',
  ): Promise<void>;

  /** Upsert a graph :Entity node (fire-and-forget). */
  upsertEntity(
    name: string,
    group_folder: string,
    objective_id?: string | null,
    type?: string | null,
  ): void;

  /** Upsert a graph (subject)-[:REL]->(object) edge (fire-and-forget). */
  upsertRelation(params: {
    subject: string;
    relation: string;
    object: string;
    group_folder: string;
    source_memory_id?: string | null;
    raw_label?: string | null;
    objective_id?: string | null;
    /** Effective time from the observed source, not ingestion time. */
    validFrom?: string;
    /** Epoch captured before relation extraction began. */
    expectedPrivacyEpoch?: number;
  }): Promise<void>;

  /**
   * 1-hop graph expansion: surface relations valid at asOf (or current when
   * omitted) for entities mentioned in the given memory contents.
   */
  expandEntities(params: {
    contents: string[];
    groupFolders: string[];
    limit: number;
    asOf?: string;
  }): Promise<GraphFact[] | null>;

  /** Whether the vector store is currently reachable. */
  isAvailable(): boolean;

  /** Whether VECTOR_ONLY_RECALL mode is enabled. */
  isVectorOnlyRecall(): boolean;

  /** Minimum cosine similarity score threshold. */
  minScore(): number;
}

let hooks: VectorStoreHooks | null = null;

export function setVectorStoreHooks(h: VectorStoreHooks): void {
  hooks = h;
}

export function getVectorStoreHooks(): VectorStoreHooks | null {
  return hooks;
}
