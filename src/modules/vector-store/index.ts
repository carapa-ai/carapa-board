/**
 * Vector store module — optional Neo4j-based semantic search for memories.
 *
 * When enabled, enhances the core memorize/recall/forget tools with
 * embedding-based similarity search.
 */

import type { CarapaModule } from '../types.js';
import {
  ENABLE_VECTOR_STORE,
  VECTOR_ONLY_RECALL,
  VECTOR_MIN_SCORE,
} from './config.js';
import {
  initNeo4j,
  closeNeo4j,
  isVectorStoreAvailable,
  embedText,
  upsertMemoryVector,
  moveMemoryData,
  moveObjectiveMemoryData,
  searchSimilarMultiGroup,
  eraseMemoryData,
  invalidateMemoryGraph,
  markMemoryVectorsInvalid,
  listMemoryVectorIdsPage as listMemoryVectorIdsPageFromStore,
  findExistingMemoryVectorIds as findExistingMemoryVectorIdsFromStore,
  findMisScopedMemoryVectors,
  deleteOrphanMemoryVectors as deleteOrphanMemoryVectorsFromStore,
  deleteGroupMemoryGraph as deleteGroupMemoryGraphFromStore,
  renameGroupMemoryGraph as renameGroupMemoryGraphFromStore,
  eraseGraphFactsMatchingTarget as eraseGraphFactsMatchingTargetFromStore,
  upsertEntity,
  upsertRelation,
  expandEntities,
  setNeo4jReconnectHandler,
} from './store.js';
import { setVectorStoreHooks } from './hooks.js';
import { logger } from '../../logger.js';
import { getMemory } from '../../db.js';
import {
  getProjectPrivacyMode,
  privacyModeRank,
} from '../../lib/privacy-policy.js';
import { textForEmbedding } from '../memory/embed-text.js';
import { withMemoryLifecycleLock } from '../memory/lifecycle-lock.js';
import { retryPendingMemoryErasures } from '../memory/privacy-erasure.js';
import { retryPendingGraphInvalidations } from '../memory/graph-invalidation.js';
import { getPrivacyErasureEpoch } from '../memory/privacy-erasure.js';

/** Folder with the strictest privacy mode, so a multi-project query is judged by it. */
function strictestFolder(folders: string[]): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const folder of folders) {
    const rank = privacyModeRank(getProjectPrivacyMode(folder));
    if (rank > bestRank) {
      best = folder;
      bestRank = rank;
    }
  }
  return best;
}

const vectorStoreModule: CarapaModule = {
  name: 'vector-store',

  isEnabled() {
    return ENABLE_VECTOR_STORE;
  },

  async init() {
    // Register hooks so core tools can use vector search
    setVectorStoreHooks({
      async embedAndStore(memoryId, group_folder, content, objective_id) {
        const writeEpoch = getPrivacyErasureEpoch(group_folder);
        try {
          const mem = await getMemory(memoryId);
          const embedContent = textForEmbedding(content, mem?.valid_from);
          const embedding = await embedText(embedContent, {
            projectId: group_folder,
          });
          // Embedding may outlive a concurrent privacy erasure. Re-check the
          // primary row immediately before the content-bearing graph write.
          if (
            embedding &&
            getPrivacyErasureEpoch(group_folder) === writeEpoch
          ) {
            // Embedding may also outlive an objective move that re-homed the
            // memory. The move holds this lock until its vector update is
            // done, so re-read the row under it and skip a stale scope.
            await withMemoryLifecycleLock(group_folder, async () => {
              const current = await getMemory(memoryId);
              if (current?.group_folder !== group_folder) return;
              await upsertMemoryVector(
                memoryId,
                group_folder,
                content,
                embedding,
                objective_id,
                writeEpoch,
              );
            });
          }
        } catch (err) {
          logger.warn({ err, memoryId }, 'Embedding generation failed');
        }
      },

      async moveMemoryScope(memoryId, sourceGroupFolder, targetGroupFolder) {
        try {
          await moveMemoryData(memoryId, sourceGroupFolder, targetGroupFolder);
        } catch (err) {
          logger.warn({ err, memoryId }, 'Failed to move memory graph data');
        }
      },

      async moveObjectiveMemoryScope(memoryIds, targetGroupFolder) {
        await moveObjectiveMemoryData(memoryIds, targetGroupFolder);
      },

      async enhanceRecall({
        groupFolders,
        query,
        limit,
        objective_id,
        asOf,
        stats,
      }) {
        if (!isVectorStoreAvailable()) {
          if (stats) stats.unavailable = true;
          return null;
        }
        const queryEmbedding = await embedText(query, {
          projectId: strictestFolder(groupFolders),
        });
        if (!queryEmbedding) {
          if (stats) stats.embedSkipped = true;
          return null;
        }
        return searchSimilarMultiGroup(
          groupFolders,
          queryEmbedding,
          limit,
          objective_id,
          asOf,
          stats,
        );
      },

      async eraseMemory(memoryId, targetHashes, tokenScheme) {
        await eraseMemoryData(memoryId, targetHashes, tokenScheme);
      },

      async invalidateMemory(memoryId, effectiveAt) {
        await invalidateMemoryGraph(memoryId, effectiveAt);
      },

      async markInvalidatedVectors(items) {
        return await markMemoryVectorsInvalid(items);
      },

      listMemoryVectorIdsPage: listMemoryVectorIdsPageFromStore,

      findExistingMemoryVectorIds: findExistingMemoryVectorIdsFromStore,
      findMisScopedMemoryVectors,

      deleteOrphanMemoryVectors: deleteOrphanMemoryVectorsFromStore,

      deleteGroupMemoryGraph: deleteGroupMemoryGraphFromStore,

      renameGroupMemoryGraph: renameGroupMemoryGraphFromStore,

      async eraseGraphFactsMatchingTarget(
        group_folder,
        targetHashes,
        tokenScheme,
      ) {
        await eraseGraphFactsMatchingTargetFromStore(
          group_folder,
          targetHashes,
          tokenScheme,
        );
      },

      upsertEntity(name, group_folder, objective_id, type) {
        upsertEntity(name, group_folder, objective_id, type).catch((err) =>
          logger.warn({ err, name }, 'Failed to upsert entity in Neo4j'),
        );
      },

      async upsertRelation(params) {
        await upsertRelation(params);
      },

      async expandEntities({ contents, groupFolders, limit, asOf }) {
        if (!isVectorStoreAvailable()) return null;
        return expandEntities(contents, groupFolders, limit, asOf);
      },

      isAvailable: isVectorStoreAvailable,
      isVectorOnlyRecall: () => VECTOR_ONLY_RECALL,
      minScore: () => VECTOR_MIN_SCORE,
    });

    setNeo4jReconnectHandler(async () => {
      await retryPendingMemoryErasures();
      await retryPendingGraphInvalidations();
    });

    // Connect to Neo4j (non-blocking)
    await initNeo4j();
    await retryPendingMemoryErasures();
    await retryPendingGraphInvalidations();
  },

  async shutdown() {
    setNeo4jReconnectHandler(null);
    setVectorStoreHooks(null!);
    await closeNeo4j();
  },

  getConfigFlags() {
    return { enableVectorStore: true };
  },
};

export default vectorStoreModule;
