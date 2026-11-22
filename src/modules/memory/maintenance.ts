/**
 * Memory maintenance — importance decay and deduplication.
 *
 * Runs periodically (hourly via task-scheduler) to keep the memory
 * store healthy: decays unused memories and merges duplicates.
 *
 * Decay rules:
 * - A memory keeps its importance for 7 days after its last access.
 * - After that it loses 1% of its importance per day, non-compounding per
 *   pass: decay is applied at most once a day per group, tracked by a durable
 *   per-group watermark in `DATA_DIR/memory-decay-watermarks.json`. The first
 *   pass for a group only records the watermark. A pass applies
 *   `0.99 ** min(days since watermark, 7)`.
 * - `identity` memories never decay.
 * - Archiving (importance < 0.1 and access_count < 3) is evaluated on every
 *   pass with the current importance. Decay-driven archiving of a default 0.8
 *   memory now takes 200+ days without access.
 * - Maintenance changes `importance` only; `updated_at` (the optimistic
 *   concurrency version used by supersede/invalidate) is left untouched.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../config.js';
import {
  getMemory,
  getMemoriesForMaintenance,
  batchUpdateImportance,
  supersedeMemory,
  invalidateMemory,
} from '../../db.js';
import { isRecord } from '../../lib/type-guards.js';
import { logger } from '../../logger.js';
import { retryPendingMemoryErasures } from './privacy-erasure.js';
import {
  reconcileInvalidatedVectors,
  measureValidVectorCoverage,
  createVectorBackfillBudget,
  type VectorBackfillBudget,
  sweepOrphanMemoryVectors,
  retryPendingGraphInvalidations,
  syncGraphInvalidation,
} from './graph-invalidation.js';
import { isDuplicateMemoryContent } from './dedup.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import type { Memory } from './types.js';

const DAY_MS = 86400_000;
const DECAY_GRACE_DAYS = 7;
const DECAY_PER_DAY = 0.99;
const MAX_ELAPSED_DAYS = 7;
/** Bounds the O(n^2) pairwise dedup cost per (group, type, objective) bucket. */
const MAX_DEDUP_BUCKET = 1000;
const DEFAULT_DECAY_STATE_PATH = path.join(
  DATA_DIR,
  'memory-decay-watermarks.json',
);

/** Pure decay rule: 7-day grace, then 1%/day for the elapsed days (max 7). */
export function decayedImportance(
  importance: number,
  daysSinceAccess: number,
  elapsedDays: number,
): number {
  if (daysSinceAccess <= DECAY_GRACE_DAYS) return importance;
  const days = Math.min(Math.max(elapsedDays, 0), MAX_ELAPSED_DAYS);
  return Math.round(importance * DECAY_PER_DAY ** days * 1000) / 1000;
}

function readWatermarks(statePath: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (isRecord(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error, statePath }, 'Ignoring bad decay watermarks');
    }
  }
  return {};
}

function writeWatermark(
  statePath: string,
  group_folder: string,
  at: number,
): void {
  // Re-read just before writing so other groups' watermarks are preserved.
  const watermarks = readWatermarks(statePath);
  watermarks[group_folder] = new Date(at).toISOString();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(watermarks, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, statePath);
}

export interface MaintainMemoriesOptions {
  now?: number;
  decayStatePath?: string;
  /** Override of {@link MAX_DEDUP_BUCKET}. */
  maxDedupBucket?: number;
  /**
   * Vector backfill budget shared across the groups of one pass. Created on
   * first use and stored here, so reusing one options object for every group
   * of a pass enforces the per-pass cap.
   */
  vectorBackfillBudget?: VectorBackfillBudget;
}

/**
 * Merge one duplicate pair. Must run under the memory lifecycle lock: both
 * rows are re-read because an agent or the reflector may have closed either
 * since the maintenance snapshot. Returns null when nothing was changed.
 */
async function mergeDuplicatePair(
  aId: string,
  bId: string,
): Promise<{ duplicate: Memory; retainedId: string } | null> {
  const [a, b] = await Promise.all([getMemory(aId), getMemory(bId)]);
  if (!a || !b) return null;
  const aOpen = !a.superseded_by && !a.valid_to;
  const bOpen = !b.superseded_by && !b.valid_to;
  if (!aOpen && !bOpen) return null;

  if (aOpen !== bOpen) {
    // An identical fact was already closed by someone else; its open twin is
    // equally stale, so close it the same way instead of leaving it current.
    const [open, gone] = aOpen ? [a, b] : [b, a];
    if (!gone.valid_to || gone.superseded_by === open.id) return null;
    let retainedId = gone.id;
    let changed = false;
    if (gone.superseded_by) {
      const successor = await getMemory(gone.superseded_by);
      if (!successor || successor.superseded_by || successor.valid_to)
        return null;
      retainedId = successor.id;
      changed = await supersedeMemory(
        open.id,
        successor.id,
        gone.valid_to,
        open.updated_at,
      );
    } else {
      changed = await invalidateMemory(open.id, gone.valid_to, open.updated_at);
    }
    if (!changed) return null;
    await syncGraphInvalidation(open.id, gone.valid_to);
    return { duplicate: open, retainedId };
  }

  // Keep the one with higher importance (or more recent if equal)
  const keepA =
    a.importance > b.importance ||
    (a.importance === b.importance && a.updated_at > b.updated_at);
  const [retained, duplicate] = keepA ? [a, b] : [b, a];
  const effectiveAt = new Date().toISOString();
  const closed = await supersedeMemory(
    duplicate.id,
    retained.id,
    effectiveAt,
    duplicate.updated_at,
  );
  if (!closed) return null;
  await syncGraphInvalidation(duplicate.id, effectiveAt);
  return { duplicate, retainedId: retained.id };
}

/**
 * Run maintenance on a group's memories: decay + dedup.
 */
export async function maintainMemories(
  group_folder: string,
  options: MaintainMemoriesOptions = {},
): Promise<void> {
  await retryPendingMemoryErasures(group_folder);
  await retryPendingGraphInvalidations();
  await reconcileInvalidatedVectors(group_folder);
  await sweepOrphanMemoryVectors(group_folder);
  options.vectorBackfillBudget ??= createVectorBackfillBudget();
  await measureValidVectorCoverage(group_folder, options.vectorBackfillBudget);
  const memories = await getMemoriesForMaintenance(group_folder);
  if (memories.length === 0) return;

  // --- Importance decay ---
  const now = options.now ?? Date.now();
  const decayStatePath = options.decayStatePath ?? DEFAULT_DECAY_STATE_PATH;
  const watermark = readWatermarks(decayStatePath)[group_folder];
  const watermarkMs = watermark ? new Date(watermark).getTime() : NaN;
  // Decay at most once a day per group. Without a (valid) watermark, record
  // one and skip decay on this pass.
  const elapsedDays = Number.isFinite(watermarkMs)
    ? (now - watermarkMs) / DAY_MS
    : null;
  const decayDue = elapsedDays !== null && elapsedDays >= 1;
  const decayUpdates: { id: string; importance: number }[] = [];
  const toArchive = new Set<string>();
  let pastGrace = 0;

  for (const m of memories) {
    if (m.memory_type === 'identity') continue; // identity never decays

    const daysSinceAccess =
      (now - new Date(m.last_accessed_at).getTime()) / DAY_MS;
    if (daysSinceAccess > DECAY_GRACE_DAYS) pastGrace++;
    const newImportance = decayDue
      ? decayedImportance(m.importance, daysSinceAccess, elapsedDays)
      : m.importance;

    if (newImportance < 0.1 && m.access_count < 3) {
      toArchive.add(m.id);
    } else if (Math.abs(newImportance - m.importance) > 0.001) {
      decayUpdates.push({ id: m.id, importance: newImportance });
    }
  }

  if (decayUpdates.length > 0) {
    await batchUpdateImportance(decayUpdates);
  }
  if (elapsedDays === null || decayDue) {
    writeWatermark(decayStatePath, group_folder, now);
  }

  // Retention cleanup archives low-value memories by closing their validity
  // window. The row and vector stay available for asOf (point-in-time) recall;
  // the vector node gets `invalid_at` so current recall excludes it.
  for (const id of toArchive) {
    const effectiveAt = new Date().toISOString();
    await invalidateMemory(id, effectiveAt);
    await syncGraphInvalidation(id, effectiveAt);
  }

  // --- Dedup: find high-overlap memories of same type and objective scope ---
  const byType = new Map<string, typeof memories>();
  for (const m of memories) {
    if (toArchive.has(m.id)) continue;
    const key = `${m.group_folder}:${m.memory_type}:${m.objective_id ?? ''}`;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(m);
  }

  let dedupCount = 0;
  const settled = new Set<string>();
  const maxBucket = options.maxDedupBucket ?? MAX_DEDUP_BUCKET;
  for (const [bucket, rows] of byType) {
    let group = rows;
    if (group.length > maxBucket) {
      group = [...group]
        .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
        .slice(0, maxBucket);
      logger.warn(
        {
          group_folder,
          bucket,
          size: rows.length,
          skipped: rows.length - group.length,
        },
        'Memory maintenance dedup bucket truncated',
      );
    }
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.superseded_by || b.superseded_by) continue;
        if (settled.has(a.id) || settled.has(b.id)) continue;

        if (isDuplicateMemoryContent(a.content, b.content)) {
          const merged = await withMemoryLifecycleLock(group_folder, () =>
            mergeDuplicatePair(a.id, b.id),
          );
          if (!merged) continue;
          settled.add(merged.duplicate.id);
          logger.info(
            {
              memoryId: merged.duplicate.id,
              retainedId: merged.retainedId,
              group_folder: merged.duplicate.group_folder,
              objective_id: merged.duplicate.objective_id ?? null,
            },
            'Memory maintenance merged duplicate',
          );
          dedupCount++;
        }
      }
    }
  }

  logger.info(
    {
      group_folder,
      scanned: memories.length,
      decayed: decayUpdates.length,
      archived: toArchive.size,
      deduped: dedupCount,
      decayDue,
      elapsedDays:
        elapsedDays === null ? null : Math.round(elapsedDays * 100) / 100,
      pastGrace,
    },
    'Memory maintenance completed',
  );
}
