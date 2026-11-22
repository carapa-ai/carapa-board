/**
 * Keeps favorites consistent with group-folder changes. The filesystem change
 * and the favorites update cannot share a transaction, so:
 *  - everything that moves, deletes, adds or prunes favorites of a project runs
 *    under one per-project lock, so a read never judges a path "missing" in the
 *    gap between a rename and the rewrite of its favorites;
 *  - a rename/move is recorded in the database BEFORE the file changes (a
 *    failed record aborts the change), and the record is removed in the same
 *    transaction that rewrites the favorites. A failure or restart in between
 *    leaves the record, and `settleFavoriteMoves` completes or discards it by
 *    looking at the filesystem. Nothing is pruned while a record is unsettled.
 */

import {
  applyFavoriteMove,
  deleteGroupFavoritesAt,
  discardFavoriteMove,
  listFavoriteMoves,
} from '../db/file-favorites.js';
import { logger } from '../logger.js';
import { GroupFileOpError, probeGroupPath } from './group-file-ops.js';

const lockTails = new Map<string, Promise<void>>();

/**
 * Serialize favorites work per project. A namespace of its own (keyed by the
 * project folder, not a file path) so no file name can alias it. Not reentrant.
 */
export async function withFavoritesLock<T>(
  folder: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = lockTails.get(folder) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  lockTails.set(folder, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lockTails.get(folder) === tail) lockTails.delete(folder);
  }
}

/**
 * Complete or discard every recorded move of a project, oldest first. A move
 * whose source is gone and target exists happened: its favorites are rewritten.
 * Otherwise it never happened (or the file is gone since) and the record is
 * dropped. Returns false, leaving the rest, when the filesystem or database
 * could not give a firm answer. Hold the lock.
 */
export async function settleFavoriteMoves(folder: string): Promise<boolean> {
  try {
    for (const move of await listFavoriteMoves(folder)) {
      const [source, target] = [
        await probeGroupPath(folder, move.from),
        await probeGroupPath(folder, move.to),
      ];
      if (source === null || target === null) return false;
      if (!source && target) await applyFavoriteMove(folder, move);
      else await discardFavoriteMove(move.seq);
    }
    return true;
  } catch (err) {
    logger.warn({ err, folder }, 'File favorites move settle failed');
    return false;
  }
}

/**
 * Before a rename/move: the earlier moves must be settled, or this one could
 * make them unrecoverable. Hold the lock.
 */
export async function requireSettledFavoriteMoves(
  folder: string,
): Promise<void> {
  if (!(await settleFavoriteMoves(folder)))
    throw new GroupFileOpError(
      503,
      'Favorites are still being updated for an earlier change; try again',
    );
}

/** Drop favorites of a removed file or folder (after earlier moves settle). Hold the lock. */
export async function dropDeletedFavorites(
  folder: string,
  removed: string,
): Promise<void> {
  await settleFavoriteMoves(folder);
  await deleteGroupFavoritesAt(folder, removed);
}
