import {
  completeMemoryInvalidation,
  getMemory,
  enqueueMemoryInvalidation,
  countGroupMemories,
  getExistingMemoryIds,
  getInvalidMemoriesPage,
  getValidMemoryIdsPage,
  getPendingMemoryInvalidations,
} from '../../db.js';
import { logger } from '../../logger.js';
import {
  ENABLE_VECTOR_STORE,
  ORPHAN_SWEEP_MAX_DELETE_PER_PASS,
} from '../vector-store/config.js';
import {
  getVectorStoreHooks,
  type VectorStoreHooks,
} from '../vector-store/hooks.js';
import { assertEmbeddingEgressAllowed } from '../vector-store/store.js';
import { PrivacyRefusal } from '../../lib/privacy-policy.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';

/** Persist graph lifecycle work without allowing optional Neo4j to block SQL. */
export async function syncGraphInvalidation(
  memoryId: string,
  effectiveAt: string,
): Promise<boolean> {
  const hooks = getVectorStoreHooks();
  if (!hooks && !ENABLE_VECTOR_STORE) {
    await completeMemoryInvalidation(memoryId);
    return true;
  }
  await enqueueMemoryInvalidation(memoryId, effectiveAt);
  if (!hooks) return false;
  try {
    await hooks.invalidateMemory(memoryId, effectiveAt);
    await completeMemoryInvalidation(memoryId);
    return true;
  } catch (err) {
    logger.warn({ err, memoryId }, 'Graph invalidation deferred for retry');
    return false;
  }
}

export async function retryPendingGraphInvalidations(): Promise<number> {
  let completed = 0;
  for (const item of await getPendingMemoryInvalidations()) {
    if (await syncGraphInvalidation(item.memory_id, item.effective_at))
      completed++;
  }
  return completed;
}

/** Rows fetched per keyset page by the reconcile and the orphan sweep. */
const VECTOR_RECONCILE_BATCH = 500;

/** Safety cap on rows covered by one reconcile or sweep call. */
const VECTOR_RECONCILE_MAX_PER_PASS = 20_000;

/** Repair stale graph scopes without embedding or blocking SQL moves. */
async function reconcileVectorScopes(
  group_folder: string,
  ids: string[],
  hooks: VectorStoreHooks,
): Promise<void> {
  if (!hooks.findMisScopedMemoryVectors || !hooks.moveMemoryScope) return;
  const mismatches = await hooks.findMisScopedMemoryVectors(ids, group_folder);
  for (const { id } of mismatches) {
    await withMemoryLifecycleLock(group_folder, async () => {
      const mem = await getMemory(id);
      if (!mem || mem.group_folder !== group_folder) return;
      const [current] = await hooks.findMisScopedMemoryVectors!(
        [id],
        group_folder,
      );
      if (!current) return;
      if (mem.objective_id && hooks.moveObjectiveMemoryScope) {
        await hooks.moveObjectiveMemoryScope([id], group_folder);
      } else if (!mem.objective_id) {
        await hooks.moveMemoryScope!(
          id,
          current.sourceGroupFolder,
          group_folder,
        );
      }
    });
  }
}

/**
 * Mark Neo4j vector nodes of memories already invalid in SQL, so current
 * recall skips them (they stay available for asOf recall). Covers nodes that
 * predate `invalid_at` and nodes embedded after their memory was invalidated.
 * Stateless and idempotent: one call pages through every invalid row of the
 * group (up to the cap), so process restarts cannot leave a backlog.
 */
export async function reconcileInvalidatedVectors(
  group_folder: string,
): Promise<number> {
  const hooks = getVectorStoreHooks();
  if (!hooks?.markInvalidatedVectors || !hooks.isAvailable()) return 0;
  try {
    let after: string | undefined;
    let scanned = 0;
    let marked = 0;
    while (scanned < VECTOR_RECONCILE_MAX_PER_PASS) {
      const page = await getInvalidMemoriesPage(
        group_folder,
        after,
        Math.min(
          VECTOR_RECONCILE_BATCH,
          VECTOR_RECONCILE_MAX_PER_PASS - scanned,
        ),
      );
      if (page.length === 0) break;
      await reconcileVectorScopes(
        group_folder,
        page.map((item) => item.id),
        hooks,
      );
      marked += await hooks.markInvalidatedVectors(page);
      scanned += page.length;
      if (page.length < VECTOR_RECONCILE_BATCH) break;
      after = page[page.length - 1].id;
    }
    if (scanned > 0) {
      logger.info(
        { event: 'memory_vector_reconcile', group_folder, scanned, marked },
        'Vector invalidation reconcile finished',
      );
    }
    return marked;
  } catch (err) {
    logger.warn({ err, group_folder }, 'Vector invalidation reconcile failed');
    return 0;
  }
}

/**
 * Delete Neo4j vector nodes of a group whose SQL row no longer exists
 * (hard-deleted rows whose node was left behind). Rows that are merely
 * invalid still exist in SQL, so their nodes survive for asOf recall.
 * Nodes touched in the last 10 minutes are skipped by the store so an
 * in-flight memorize is never raced.
 *
 * Fails closed: the whole group is scanned and orphans collected before any
 * delete, and a lookup error or an empty SQL group (restored/half-migrated
 * database) deletes nothing. At most ORPHAN_SWEEP_MAX_DELETE_PER_PASS orphans
 * (lowest ids first) are deleted per call; the rest are counted as remaining.
 */
export async function sweepOrphanMemoryVectors(
  group_folder: string,
  maxDelete = ORPHAN_SWEEP_MAX_DELETE_PER_PASS,
): Promise<number> {
  const hooks = getVectorStoreHooks();
  if (
    !hooks?.listMemoryVectorIdsPage ||
    !hooks.deleteOrphanMemoryVectors ||
    !hooks.isAvailable()
  ) {
    return 0;
  }
  const skip = (reason: string, err?: unknown): number => {
    logger.warn(
      {
        event: 'memory_vector_orphan_sweep_skipped',
        group_folder,
        reason,
        err,
      },
      'Orphan memory vector sweep skipped; nothing deleted',
    );
    return 0;
  };

  const orphans: string[] = [];
  let scanned = 0;
  try {
    let after = '';
    while (scanned < VECTOR_RECONCILE_MAX_PER_PASS) {
      const ids = await hooks.listMemoryVectorIdsPage(
        group_folder,
        after,
        Math.min(
          VECTOR_RECONCILE_BATCH,
          VECTOR_RECONCILE_MAX_PER_PASS - scanned,
        ),
      );
      if (ids.length === 0) break;
      const existing = await getExistingMemoryIds(ids);
      for (const id of ids) if (!existing.has(id)) orphans.push(id);
      scanned += ids.length;
      if (ids.length < VECTOR_RECONCILE_BATCH) break;
      after = ids[ids.length - 1];
    }
    if (orphans.length > 0 && (await countGroupMemories(group_folder)) === 0) {
      return skip('sql_group_empty');
    }
  } catch (err) {
    return skip('lookup_failed', err);
  }

  const toDelete = orphans.slice(0, maxDelete);
  let deleted = 0;
  try {
    for (let i = 0; i < toDelete.length; i += VECTOR_RECONCILE_BATCH) {
      deleted += await hooks.deleteOrphanMemoryVectors(
        toDelete.slice(i, i + VECTOR_RECONCILE_BATCH),
      );
    }
  } catch (err) {
    logger.warn({ err, group_folder }, 'Orphan memory vector sweep failed');
    return deleted;
  }
  logger.info(
    {
      event: 'memory_vector_orphan_sweep',
      group_folder,
      scanned,
      orphanCount: orphans.length,
      deleted,
      remaining: orphans.length - deleted,
    },
    'Orphan memory vector sweep finished',
  );
  return deleted;
}

/** Rows updated more recently than this may still have an in-flight embed. */
const VECTOR_COVERAGE_GRACE_MS = 10 * 60 * 1000;

/** Embeds attempted per group in one maintenance pass. */
const VECTOR_BACKFILL_MAX_PER_GROUP = 50;

/** Embeds attempted across all groups in one maintenance pass. */
const VECTOR_BACKFILL_MAX_PER_PASS = 200;

/** Consecutive embeds leaving no node after which a group is abandoned. */
const VECTOR_BACKFILL_STOP_AFTER = 3;

/** Embed budget shared by every group of one maintenance pass. */
export interface VectorBackfillBudget {
  remaining: number;
}

export function createVectorBackfillBudget(): VectorBackfillBudget {
  return { remaining: VECTOR_BACKFILL_MAX_PER_PASS };
}

/**
 * Embed valid memory rows that have no vector node, bounded per group and per
 * pass. The caller has already passed the privacy gate for the group. Stops
 * the group once consecutive embeds leave no node (store or embedder down).
 * Logs counts only, never content.
 */
async function backfillMissingVectors(
  group_folder: string,
  missingIds: string[],
  hooks: VectorStoreHooks,
  budget: VectorBackfillBudget,
): Promise<void> {
  if (!hooks.findExistingMemoryVectorIds || !hooks.isAvailable()) return;
  const limit = Math.min(VECTOR_BACKFILL_MAX_PER_GROUP, budget.remaining);
  let attempted = 0;
  let created = 0;
  let skipped = 0;
  let consecutiveMisses = 0;
  let stoppedEarly = false;
  for (const id of missingIds) {
    if (attempted >= limit) break;
    const mem = await getMemory(id);
    if (!mem || mem.valid_to || mem.superseded_by) {
      skipped++;
      continue;
    }
    attempted++;
    budget.remaining--;
    await hooks.embedAndStore(id, group_folder, mem.content, mem.objective_id);
    if ((await hooks.findExistingMemoryVectorIds([id])).has(id)) {
      created++;
      consecutiveMisses = 0;
    } else if (++consecutiveMisses >= VECTOR_BACKFILL_STOP_AFTER) {
      stoppedEarly = true;
      break;
    }
  }
  logger.info(
    {
      event: 'memory_vector_backfill',
      group_folder,
      attempted,
      created,
      skipped,
      stoppedEarly,
    },
    'Missing memory vectors backfilled',
  );
}

/**
 * Measure how many currently-valid memory rows have no vector node, then
 * backfill a bounded number of them. Such rows are invisible to vector recall;
 * they arise silently when the store is unavailable, a privacy refusal skips
 * embedding, or the privacy epoch changes mid-embed. Rows of a group whose
 * privacy mode refuses embedding are never embedded and are reported as
 * `excludedByPrivacy`. Logs one coverage line; never throws.
 */
export async function measureValidVectorCoverage(
  group_folder: string,
  budget: VectorBackfillBudget = createVectorBackfillBudget(),
): Promise<void> {
  const hooks = getVectorStoreHooks();
  if (!hooks?.findExistingMemoryVectorIds || !hooks.isAvailable()) return;
  try {
    const updatedBefore = new Date(Date.now() - VECTOR_COVERAGE_GRACE_MS);
    let after: string | undefined;
    let validRows = 0;
    let validRowsWithoutNode = 0;
    const sampleMissingIds: string[] = [];
    const backfillIds: string[] = [];
    while (validRows < VECTOR_RECONCILE_MAX_PER_PASS) {
      const ids = await getValidMemoryIdsPage(
        group_folder,
        after,
        Math.min(
          VECTOR_RECONCILE_BATCH,
          VECTOR_RECONCILE_MAX_PER_PASS - validRows,
        ),
        updatedBefore,
      );
      if (ids.length === 0) break;
      await reconcileVectorScopes(group_folder, ids, hooks);
      const existing = await hooks.findExistingMemoryVectorIds(ids);
      for (const id of ids) {
        if (existing.has(id)) continue;
        validRowsWithoutNode++;
        if (sampleMissingIds.length < 5) sampleMissingIds.push(id);
        // Rows may turn out invalid and be skipped, so keep a few spares.
        if (backfillIds.length < VECTOR_BACKFILL_MAX_PER_GROUP * 2) {
          backfillIds.push(id);
        }
      }
      validRows += ids.length;
      if (ids.length < VECTOR_RECONCILE_BATCH) break;
      after = ids[ids.length - 1];
    }
    let excludedByPrivacy = false;
    if (validRowsWithoutNode > 0) {
      try {
        assertEmbeddingEgressAllowed(group_folder);
      } catch (err) {
        if (!(err instanceof PrivacyRefusal)) throw err;
        excludedByPrivacy = true;
      }
    }
    if (validRows > 0) {
      logger.info(
        {
          event: 'memory_vector_coverage',
          group_folder,
          validRows,
          validRowsWithoutNode,
          excludedByPrivacy,
          sampleMissingIds,
        },
        'Valid memory vector coverage measured',
      );
    }
    if (excludedByPrivacy) {
      logger.info(
        { event: 'memory_vector_backfill', group_folder, excluded: 'privacy' },
        'Memory vector backfill skipped by privacy mode',
      );
    } else if (backfillIds.length > 0 && budget.remaining > 0) {
      await backfillMissingVectors(group_folder, backfillIds, hooks, budget);
    }
  } catch (err) {
    logger.warn(
      { event: 'memory_vector_coverage_failed', group_folder, err },
      'Valid memory vector coverage measurement failed',
    );
  }
}
