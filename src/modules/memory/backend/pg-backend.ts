import {
  insertMemory,
  getMemory,
  getObjective,
  getMemoriesByIds,
  searchMemories,
  touchMemories,
  invalidateMemory,
  getDefaultImportance,
  updateMemory,
  type KeywordSearchStats,
} from '../../../db.js';
import { logger } from '../../../logger.js';
import {
  createVectorRecallStats,
  getVectorStoreHooks,
} from '../../vector-store/hooks.js';
import type { GraphFact } from '../../vector-store/graph-schema.js';
import { isDuplicateMemoryContent } from '../dedup.js';
import { rrfFuse } from '../fusion.js';
import {
  RECALL_FETCH_MULTIPLIER,
  RECALL_RRF_K,
  VECTOR_TEMPORAL_BLEND,
} from '../recall-config.js';
import { temporalRecencyFactor } from '../temporal-scoring.js';
import { chronoOrderFromQuery, type ChronoOrder } from '../chrono-query.js';
import type { Memory, MemoryType } from '../types.js';
import { assertMemoryScope, filterMemoriesByRecallScope } from './tenant.js';
import { eraseMemoryDurably } from '../privacy-erasure.js';
import { syncGraphInvalidation } from '../graph-invalidation.js';
import { withMemoryLifecycleLock } from '../lifecycle-lock.js';
import { getPrivacyErasureEpoch } from '../privacy-epoch.js';
import type {
  MemoryBackend,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemoryScope,
  MemoryWriteInput,
  MemorizeOutcome,
} from './types.js';

const IMPORTANCE_VECTOR_BLEND = 0.2;

/**
 * Orders vector hits for RRF fusion. Without `asOf`, by similarity alone;
 * importance, then recency, only break ties. Point-in-time recall (`asOf`)
 * keeps the similarity/recency/importance blend.
 */
export function orderVectorHitIds(
  hits: { id: string; score: number }[],
  byId: Map<string, Memory>,
  asOf?: string,
): string[] {
  if (!asOf) {
    const recency = (id: string): number => {
      const m = byId.get(id);
      return m
        ? temporalRecencyFactor(m.valid_from, undefined, m.last_accessed_at)
        : 0;
    };
    return [...hits]
      .sort(
        (a, b) =>
          b.score - a.score ||
          (byId.get(b.id)?.importance ?? 0) -
            (byId.get(a.id)?.importance ?? 0) ||
          recency(b.id) - recency(a.id),
      )
      .map((h) => h.id);
  }
  const temporalBlend = VECTOR_TEMPORAL_BLEND;
  const semanticWeight = 1 - temporalBlend - IMPORTANCE_VECTOR_BLEND;
  return [...hits]
    .sort((a, b) => {
      const ma = byId.get(a.id);
      const mb = byId.get(b.id);
      const ta = ma
        ? temporalRecencyFactor(ma.valid_from, asOf, ma.last_accessed_at)
        : 0;
      const tb = mb
        ? temporalRecencyFactor(mb.valid_from, asOf, mb.last_accessed_at)
        : 0;
      const sa =
        a.score * semanticWeight +
        ta * temporalBlend +
        (ma?.importance ?? 0) * IMPORTANCE_VECTOR_BLEND;
      const sb =
        b.score * semanticWeight +
        tb * temporalBlend +
        (mb?.importance ?? 0) * IMPORTANCE_VECTOR_BLEND;
      return sb - sa;
    })
    .map((h) => h.id);
}

function chronologicalIds(
  memories: Iterable<Memory>,
  fetchLimit: number,
  order: ChronoOrder,
): string[] {
  const sorted = [...memories].filter((m) => m.valid_from);
  sorted.sort((a, b) => {
    const diff =
      new Date(a.valid_from!).getTime() - new Date(b.valid_from!).getTime();
    return order === 'asc' ? diff : -diff;
  });
  return sorted.slice(0, fetchLimit).map((m) => m.id);
}

class PgMemoryBackend implements MemoryBackend {
  readonly id = 'pg' as const;

  async memorize(input: MemoryWriteInput): Promise<MemorizeOutcome> {
    return withMemoryLifecycleLock(input.group_folder, () =>
      this.memorizeUnlocked(input),
    );
  }

  private async memorizeUnlocked(
    input: MemoryWriteInput,
  ): Promise<MemorizeOutcome> {
    const {
      group_folder,
      content,
      memory_type,
      importance,
      objective_id,
      tags,
      source,
      sourceRef,
      validFrom,
      id,
      mergeDuplicates = true,
      onResolvedMemoryId,
    } = input;
    const writeEpoch =
      input.expectedPrivacyEpoch ?? getPrivacyErasureEpoch(group_folder);

    // Ownership was checked before this request waited for the lifecycle lock;
    // an objective move holds the same lock, so re-check it now.
    if (objective_id) {
      const objective = await getObjective(objective_id);
      if (!objective || objective.project_id !== group_folder) {
        throw new Error(
          `Objective "${objective_id}" does not belong to project "${group_folder}" (it may have been moved); use an objective owned by this project or omit objective_id.`,
        );
      }
    }

    const mType = (memory_type || 'project') as MemoryType;
    const imp = importance ?? getDefaultImportance(mType);
    const normalizedContent = content.trim();
    const query = normalizedContent.split(/\s+/).slice(0, 8).join(' ');

    const dupCandidates = await searchMemories({
      groupFolders: [group_folder],
      query,
      memory_type: mType,
      limit: 5,
      skipTouch: true,
      strictScope: true,
      ...(objective_id ? { objective_id } : {}),
    });

    const dupMatch = dupCandidates.find((m) =>
      isDuplicateMemoryContent(m.content, normalizedContent),
    );

    const vsHooks = getVectorStoreHooks();

    if (dupMatch) {
      if (mergeDuplicates && imp > dupMatch.importance) {
        await updateMemory(dupMatch.id, {
          content: normalizedContent,
          importance: imp,
        });
        if (vsHooks?.isAvailable()) {
          await vsHooks.embedAndStore(
            dupMatch.id,
            group_folder,
            normalizedContent,
            objective_id || null,
          );
        }
        const memory = (await getMemory(dupMatch.id))!;
        logger.info(
          {
            memoryId: dupMatch.id,
            group_folder,
            objective_id: objective_id || null,
          },
          'Memory write merged into existing duplicate',
        );
        await onResolvedMemoryId?.(memory.id);
        return {
          kind: 'merged',
          memory,
          message: `Memory merged with existing: ${dupMatch.id}`,
        };
      }
      logger.info(
        {
          memoryId: dupMatch.id,
          group_folder,
          objective_id: objective_id || null,
        },
        'Memory write treated as duplicate of existing memory',
      );
      await onResolvedMemoryId?.(dupMatch.id);
      return {
        kind: 'duplicate',
        memory: dupMatch,
        message: `Duplicate detected — existing memory ${dupMatch.id} retained`,
      };
    }

    const mem = await insertMemory({
      ...(id ? { id } : {}),
      group_folder,
      objective_id: objective_id || null,
      content: normalizedContent,
      memory_type: mType,
      importance: imp,
      source,
      sourceRef: sourceRef ?? undefined,
      tags,
      expectedPrivacyEpoch: writeEpoch,
      ...(validFrom ? { valid_from: validFrom } : {}),
    });

    await onResolvedMemoryId?.(mem.id);

    if (vsHooks?.isAvailable()) {
      await vsHooks.embedAndStore(
        mem.id,
        group_folder,
        normalizedContent,
        objective_id || null,
      );
    }

    return {
      kind: 'created',
      memory: mem,
      message: `Information memorized (ID: ${mem.id})`,
    };
  }

  async recall(query: MemoryRecallQuery): Promise<MemoryRecallResult> {
    const {
      groupFolders,
      query: textQuery,
      memory_type,
      objective_id,
      asOf,
      limit: resultLimit,
      skipTouch,
    } = query;

    const vsHooks = getVectorStoreHooks();
    const vectorAvailable = !!vsHooks?.isAvailable();
    const useVector = !!textQuery && vectorAvailable;
    const validityOpts = {
      groupFolders,
      objective_id: objective_id || null,
      asOf,
    };

    const fetchLimit = vectorAvailable
      ? resultLimit * RECALL_FETCH_MULTIPLIER
      : resultLimit;

    const keywordStats: KeywordSearchStats = {
      queryTerms: 0,
      prefiltered: 0,
      capped: false,
      overlapHits: 0,
      returned: 0,
    };
    const keywordResults = await searchMemories({
      groupFolders,
      query: textQuery,
      memory_type,
      limit: fetchLimit,
      objective_id: objective_id || null,
      asOf,
      skipTouch: true,
      stats: keywordStats,
    });

    // Counts only (no query text, terms, ids or folder names): measures
    // stopword-only queries, ILIKE candidates dropped by the whole-token
    // overlap filter, prefilter cap hits and empty keyword results.
    if (textQuery?.trim()) {
      logger.info(
        {
          event: 'memory_recall_keyword',
          ...keywordStats,
          asOf: !!asOf,
          groups: groupFolders.length,
          vectorAvailable,
        },
        'memory_recall_keyword',
      );
    }

    const byId = new Map<string, Memory>();
    for (const m of keywordResults) byId.set(m.id, m);
    const rankedLists: string[][] = [keywordResults.map((m) => m.id)];

    if (useVector) {
      const vectorStats = createVectorRecallStats();
      const vectorHits = await vsHooks!.enhanceRecall({
        groupFolders,
        query: textQuery!,
        limit: fetchLimit,
        objective_id: objective_id || null,
        asOf,
        stats: vectorStats,
      });
      let hydratedValid = 0;
      let typeFiltered = 0;
      let keptHits = 0;

      if (vectorHits && vectorHits.length > 0) {
        const hydrated = await getMemoriesByIds(
          vectorHits.map((h) => h.id),
          validityOpts,
        );
        const validVector = memory_type
          ? hydrated.filter((m) => m.memory_type === memory_type)
          : hydrated;

        for (const m of validVector) if (!byId.has(m.id)) byId.set(m.id, m);

        const validVectorIds = new Set(validVector.map((m) => m.id));
        const filteredHits = vectorHits.filter((h) => validVectorIds.has(h.id));
        rankedLists.push(orderVectorHitIds(filteredHits, byId, asOf));
        hydratedValid = hydrated.length;
        typeFiltered = hydrated.length - validVector.length;
        keptHits = filteredHits.length;
      }

      // Counts only (no query text or folder names): measures the share of
      // vector hits dropped by hydration/validity/type filtering per recall,
      // and tells zero-hit causes apart (embed skipped, store unavailable, ANN
      // starvation by other projects, or all rows below the score floor).
      logger.info(
        {
          event: 'memory_recall_vector',
          vectorHits: vectorHits?.length ?? 0,
          hydratedValid,
          typeFiltered,
          keptHits,
          embedSkipped: vectorStats.embedSkipped,
          unavailable: vectorStats.unavailable,
          rawAnnHits: vectorStats.rawAnnHits,
          postFilterHits: vectorStats.postFilterHits,
          belowMinScore: vectorStats.belowMinScore,
          asOf: !!asOf,
          groups: groupFolders.length,
        },
        'memory_recall_vector',
      );
    }

    const chronoOrder = chronoOrderFromQuery(textQuery);
    if (asOf && chronoOrder && byId.size > 0) {
      const chrono = chronologicalIds(byId.values(), fetchLimit, chronoOrder);
      if (chrono.length > 0) rankedLists.push(chrono);
    }

    let fusedIds = rrfFuse(rankedLists, RECALL_RRF_K);

    let relatedFacts: GraphFact[] = [];
    let graphOnlyInTop = 0;
    if (vectorAvailable && fusedIds.length > 0) {
      const seedContents = fusedIds
        .slice(0, resultLimit)
        .map((id) => byId.get(id)?.content)
        .filter((c): c is string => !!c);

      const facts = await vsHooks!.expandEntities({
        contents: seedContents,
        groupFolders,
        limit: fetchLimit,
        asOf,
      });

      if (facts && facts.length > 0) {
        const provIds = [
          ...new Set(
            facts
              .map((f) => f.sourceMemoryId)
              .filter((id): id is string => !!id),
          ),
        ];
        let validFacts = facts.filter((f) => !f.sourceMemoryId);
        if (provIds.length > 0) {
          const hydratedProv = await getMemoriesByIds(provIds, validityOpts);
          const provRows = memory_type
            ? hydratedProv.filter((m) => m.memory_type === memory_type)
            : hydratedProv;
          for (const m of provRows) if (!byId.has(m.id)) byId.set(m.id, m);
          const validProv = new Set(provRows.map((m) => m.id));
          validFacts = facts.filter(
            (f) => !f.sourceMemoryId || validProv.has(f.sourceMemoryId),
          );
          // One entry per memory, first appearance kept: expandEntities returns
          // one row per relation, and rrfFuse adds a score per occurrence, so a
          // memory with N relations would otherwise be boosted N times.
          // Facts without sourceMemoryId stay in relatedFacts only.
          const graphIds = [
            ...new Set(
              validFacts
                .map((f) => f.sourceMemoryId)
                .filter((id): id is string => !!id && validProv.has(id)),
            ),
          ];
          const baseIds = new Set(rankedLists.flat());
          rankedLists.push(graphIds);
          fusedIds = rrfFuse(rankedLists, RECALL_RRF_K);
          const graphIdSet = new Set(graphIds);
          graphOnlyInTop = fusedIds
            .slice(0, resultLimit)
            .filter((id) => graphIdSet.has(id) && !baseIds.has(id)).length;
        }
        relatedFacts = validFacts;
      }

      // Counts only: measures how often recall serves graph facts that no
      // writer updates any more (no query text, folder names or content).
      logger.info(
        {
          event: 'memory_recall_graph',
          expanded: facts?.length ?? 0,
          withoutProvenance:
            facts?.filter((f) => !f.sourceMemoryId).length ?? 0,
          kept: relatedFacts.length,
          graphOnlyInTop,
          groups: groupFolders.length,
        },
        'memory_recall_graph',
      );
    }

    let finalMemories: Memory[] = fusedIds
      .slice(0, resultLimit)
      .map((id) => byId.get(id))
      .filter((m): m is Memory => !!m);

    finalMemories = filterMemoriesByRecallScope(finalMemories, {
      groupFolders,
    });

    if (finalMemories.length > 0 && !skipTouch) {
      await touchMemories(finalMemories.map((m) => m.id));
    }

    return { memories: finalMemories, related: relatedFacts };
  }

  async invalidate(
    memoryId: string,
    scope: MemoryScope,
    effectiveAt?: string,
    expectedVersion?: string,
  ): Promise<void> {
    const mem = await getMemory(memoryId);
    if (!mem) {
      throw new Error(`Memory ${memoryId} not found.`);
    }
    assertMemoryScope(scope, mem.group_folder);

    const boundary = effectiveAt ?? new Date().toISOString();
    const changed = await invalidateMemory(memoryId, boundary, expectedVersion);
    if (!changed) {
      throw new Error(
        `Memory ${memoryId} changed concurrently; recall it again and retry with its current updated version.`,
      );
    }
    await syncGraphInvalidation(memoryId, boundary);
  }

  async erase(memoryId: string, scope: MemoryScope): Promise<void> {
    await withMemoryLifecycleLock(scope.group_folder, async () => {
      const mem = await getMemory(memoryId);
      if (!mem) {
        throw new Error(`Memory ${memoryId} not found.`);
      }
      assertMemoryScope(scope, mem.group_folder);

      await eraseMemoryDurably(memoryId, mem.group_folder, mem.content);
    });
  }

  async get(memoryId: string): Promise<Memory | null> {
    const mem = await getMemory(memoryId);
    return mem ?? null;
  }
}

export const pgMemoryBackend = new PgMemoryBackend();
