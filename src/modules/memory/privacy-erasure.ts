import {
  beginMemoryPrivacyErasure,
  completeGraphErasure,
  completeMemoryErasure,
  enqueueMemoryErasure,
  eraseMemory,
  recordPrivacyErasure,
  getMemory,
  getPendingGraphErasures,
  getPendingMemoryErasures,
  markGraphErasureAttempt,
  markMemoryErasureAttempt,
} from '../../db.js';
import { logger } from '../../logger.js';
import { getVectorStoreHooks } from '../vector-store/hooks.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import { parseBooleanEnv } from '../../lib/env.js';
import { protectedTargetTokens } from './privacy-token.js';
import { ENABLE_VECTOR_STORE, NEO4J_PASSWORD } from '../vector-store/config.js';
import { markPrivacyErasureStarted } from './privacy-epoch.js';

export { getPrivacyErasureEpoch } from './privacy-epoch.js';

/**
 * PRIVACY ERASURE CONTRACT: BEST-EFFORT + SYNCHRONOUS EPOCH GATE
 *
 * The process epoch advances synchronously first. The hard durable boundary is
 * then one SQL transaction that enqueues content-free external cleanup when
 * external storage may exist and deletes every matching SQL row. Writers in
 * this process serialize with erasure or compare the captured group epoch
 * immediately before persistence. Neo4j cleanup is best-effort and remains in
 * the durable queue across outages; reconnect/maintenance retries it.
 *
 * This is deliberately not atomic deletion across SQL and Neo4j: the queue
 * keeps keyed tokens, not plaintext or a reversible target. A separate
 * CarapaBoard process is outside the epoch gate; production supports one
 * board writer for these stores.
 *
 * BOUNDED FAILURE-MODE MAP (the task contract's numbered cases):
 *  1 graph invalidation + temporal store regression test;
 *  2 (retired: extractor mixed-batch filtering);
 *  3 keyed HMAC retry-token test;
 *  4 durable Neo4j retry;
 *  5 SQL-only/no-external-storage path test;
 *  6 SQL deletion does not wait for Neo4j; retry rows contain no plaintext;
 *  7 target graph cleanup test independent of provenance;
 *  8 forward-only 0005 migration regression test;
 *  9 observer epoch/filtering blocks recreation; graph matching is scoped;
 * 10 beginMemoryPrivacyErasure atomically enqueues and deletes;
 * 11 lifecycle locks + SQL/vector/relation epoch checks (one process);
 * 12 cross-chunk observer filtering test;
 * 13 reconnect retains the initial driver and services retries; shared entity
 *    names are anonymized by the store regression test.
 */

/**
 * External privacy-erasure gate.
 *
 * Privacy erasure has two halves:
 *  - Primary-store erasure (SQL row delete + privacy-erasure epoch advance),
 *    the immediate, irreversible privacy boundary. ALWAYS on.
 *  - External-store cleanup — Neo4j vector/graph facts and the durable retry
 *    queue that services outages.
 *
 * The external half is gated behind ENABLE_EXTERNAL_PRIVACY_ERASURE (default
 * on) under the bounded contract above. With it off, `[forgotten]`/`forget`
 * performs SQL-only erasure: matching memory rows are deleted and the epoch
 * advances (so in-flight relation writes from the same batch are dropped),
 * but no Neo4j or queue work runs. The external code paths
 * stay in place, dormant, to be revived by turning the gate on.
 */
let externalPrivacyErasureEnabled = parseBooleanEnv(
  process.env.ENABLE_EXTERNAL_PRIVACY_ERASURE,
  true,
);

function isExternalPrivacyErasureEnabled(): boolean {
  return externalPrivacyErasureEnabled;
}

/** Feature-flag / test override. Production reads the env default (on). */
export function setExternalPrivacyErasureEnabled(value: boolean): void {
  externalPrivacyErasureEnabled = value;
}

export function mayHaveGraphStorage(
  hooksPresent: boolean,
  enabled = ENABLE_VECTOR_STORE,
  password = NEO4J_PASSWORD,
): boolean {
  return hooksPresent || enabled || !!password;
}

/** Queue an ID only; delete SQL content only after external erasure succeeds. */
export async function eraseMemoryDurably(
  memoryId: string,
  group_folder: string,
  target: string,
): Promise<void> {
  await eraseMemoriesDurably([memoryId], group_folder, target, false);
}

/** Enqueue the complete matching set before making any fallible external call. */
export async function eraseMemoriesDurably(
  memoryIds: string[],
  group_folder: string,
  target: string,
  eraseMatchingGraph = true,
): Promise<void> {
  markPrivacyErasureStarted(group_folder);
  if (!isExternalPrivacyErasureEnabled()) {
    // Neutralized: SQL-only erasure. External stores (Neo4j vector/graph)
    // and the durable retry queue are left dormant for a bounded redesign.
    // The privacy boundary is the primary-store row delete — immediate and
    // irreversible.
    await beginMemoryPrivacyErasure(memoryIds, group_folder, [], false, false);
    return;
  }
  const hooks = getVectorStoreHooks();
  const targetTokens = protectedTargetTokens(target);
  const graphStorageMayExist = mayHaveGraphStorage(!!hooks);
  // In a deployment where vector storage is not configured, SQL is the only
  // memory store. Do not create an external retry that can never be serviced.
  if (!graphStorageMayExist) {
    await beginMemoryPrivacyErasure(
      memoryIds,
      group_folder,
      targetTokens,
      eraseMatchingGraph,
      false,
    );
    return;
  }
  await beginMemoryPrivacyErasure(
    memoryIds,
    group_folder,
    targetTokens,
    eraseMatchingGraph,
    true,
  );
  for (const memoryId of memoryIds) {
    await retryMemoryErasure(
      memoryId,
      group_folder,
      targetTokens,
      'hmac-sha256',
      eraseMatchingGraph,
    );
  }
}

async function retryMemoryErasure(
  memoryId: string,
  group_folder: string,
  targetTokens: string[],
  tokenScheme: 'hmac-sha256' | 'sha256' = 'hmac-sha256',
  eraseMatchingGraph = true,
): Promise<boolean> {
  const hooks = getVectorStoreHooks();
  if (!hooks) return false;
  await markMemoryErasureAttempt(memoryId);
  try {
    if (eraseMatchingGraph) {
      await hooks.eraseGraphFactsMatchingTarget(
        group_folder,
        targetTokens,
        tokenScheme,
      );
    }
    await hooks.eraseMemory(memoryId, targetTokens, tokenScheme);
    await completeMemoryErasure(memoryId);
    return true;
  } catch (err) {
    logger.warn(
      { err, memoryId },
      'External memory erasure deferred for durable retry',
    );
    return false;
  }
}

async function retryGraphErasure(
  id: string,
  group_folder: string,
  targetTokens: string[],
  tokenScheme: 'hmac-sha256' | 'sha256' = 'hmac-sha256',
): Promise<boolean> {
  const hooks = getVectorStoreHooks();
  if (!hooks) return false;
  await markGraphErasureAttempt(id);
  try {
    await hooks.eraseGraphFactsMatchingTarget(
      group_folder,
      targetTokens,
      tokenScheme,
    );
    await completeGraphErasure(id);
    return true;
  } catch (err) {
    logger.warn(
      { err, erasureId: id },
      'Graph erasure deferred for durable retry',
    );
    return false;
  }
}

function parseTargetTokens(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function parseTokenScheme(value: string): 'hmac-sha256' | 'sha256' {
  return value === 'sha256' ? 'sha256' : 'hmac-sha256';
}

export async function retryPendingMemoryErasures(
  group_folder?: string,
): Promise<number> {
  if (!isExternalPrivacyErasureEnabled()) return 0; // neutralized — queue not serviced
  const pending = await getPendingMemoryErasures(group_folder);
  let completed = 0;
  for (const item of pending) {
    // Legacy rows still hold SQL content. Mark and delete them under the
    // project lifecycle lock so history applies and previews see a consistent
    // erasure boundary.
    const { targetTokens, tokenScheme } = await withMemoryLifecycleLock(
      item.group_folder,
      async () => {
        let targetTokens = parseTargetTokens(item.target_tokens);
        let tokenScheme = parseTokenScheme(item.token_scheme);
        const legacyMemory = await getMemory(item.memory_id);
        if (
          legacyMemory &&
          (targetTokens.length === 0 || tokenScheme === 'sha256')
        ) {
          targetTokens = protectedTargetTokens(legacyMemory.content);
          tokenScheme = 'hmac-sha256';
          await enqueueMemoryErasure(
            item.memory_id,
            item.group_folder,
            targetTokens,
            item.erase_matching_graph,
          );
        }
        // Rows queued by older versions retained SQL until Neo4j recovered.
        if (legacyMemory) {
          markPrivacyErasureStarted(item.group_folder);
          await recordPrivacyErasure(item.group_folder);
          await eraseMemory(item.memory_id);
        }
        return { targetTokens, tokenScheme };
      },
    );
    if (
      await retryMemoryErasure(
        item.memory_id,
        item.group_folder,
        targetTokens,
        tokenScheme,
        item.erase_matching_graph,
      )
    )
      completed++;
  }
  for (const item of await getPendingGraphErasures()) {
    if (group_folder && item.group_folder !== group_folder) continue;
    if (
      await retryGraphErasure(
        item.id,
        item.group_folder,
        parseTargetTokens(item.target_tokens),
        parseTokenScheme(item.token_scheme),
      )
    )
      completed++;
  }
  return completed;
}
