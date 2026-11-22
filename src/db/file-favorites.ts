import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { drizzleDbRef } from './drizzle-client.js';
import { fileFavoriteMoves, fileFavorites } from './schema.js';

export type FileFavoriteRow = typeof fileFavorites.$inferSelect;

/** What a favorite points at: a group-folder file or a knowledge document. */
export type FileFavoriteRef =
  | { kind: 'group'; path: string }
  | { kind: 'knowledge'; kbId: string; filename: string };

const refCondition = (
  userId: string,
  projectId: string,
  ref: FileFavoriteRef,
) =>
  and(
    eq(fileFavorites.user_id, userId),
    eq(fileFavorites.project_id, projectId),
    eq(fileFavorites.kind, ref.kind),
    ref.kind === 'group'
      ? eq(fileFavorites.path, ref.path)
      : and(
          eq(fileFavorites.kb_id, ref.kbId),
          eq(fileFavorites.filename, ref.filename),
        ),
  );

/**
 * `path` is `prefix` itself or lies below it (`prefix/...`). Lengths are taken
 * by PostgreSQL (characters), not JavaScript (UTF-16 units), so astral
 * characters such as emoji in a folder name still match their descendants.
 */
const atOrBelow = (prefix: string) =>
  sql`(${fileFavorites.path} = ${prefix} OR left(${fileFavorites.path}, char_length(${prefix}::text) + 1) = ${`${prefix}/`})`;

/** The user's favorites in a project, newest first. */
export async function listFileFavorites(
  userId: string,
  projectId: string,
): Promise<FileFavoriteRow[]> {
  return drizzleDbRef.current
    .select()
    .from(fileFavorites)
    .where(
      and(
        eq(fileFavorites.user_id, userId),
        eq(fileFavorites.project_id, projectId),
      ),
    )
    .orderBy(desc(fileFavorites.created_at), desc(fileFavorites.id));
}

/** Idempotent add: an existing favorite is left untouched. */
export async function addFileFavorite(
  userId: string,
  projectId: string,
  ref: FileFavoriteRef,
): Promise<void> {
  await drizzleDbRef.current
    .insert(fileFavorites)
    .values({
      id: `fav-${randomUUID()}`,
      user_id: userId,
      project_id: projectId,
      kind: ref.kind,
      path: ref.kind === 'group' ? ref.path : null,
      kb_id: ref.kind === 'knowledge' ? ref.kbId : null,
      filename: ref.kind === 'knowledge' ? ref.filename : null,
      created_at: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

/** Idempotent remove. */
export async function removeFileFavorite(
  userId: string,
  projectId: string,
  ref: FileFavoriteRef,
): Promise<void> {
  await drizzleDbRef.current
    .delete(fileFavorites)
    .where(refCondition(userId, projectId, ref));
}

/**
 * Drop favorites whose file was found gone at `path`. A row that was rewritten
 * or removed since it was read no longer matches and is left alone.
 */
export async function deleteMissingGroupFavorites(
  rows: Array<{ id: string; path: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  await drizzleDbRef.current
    .delete(fileFavorites)
    .where(
      or(
        ...rows.map((row) =>
          and(eq(fileFavorites.id, row.id), eq(fileFavorites.path, row.path)),
        ),
      ),
    );
}

/**
 * Drop every user's group favorites at `path` or, after a folder delete, below
 * it. Runs after the file was removed.
 */
export async function deleteGroupFavoritesAt(
  projectId: string,
  path: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(fileFavorites)
    .where(
      and(
        eq(fileFavorites.project_id, projectId),
        eq(fileFavorites.kind, 'group'),
        atOrBelow(path),
      ),
    );
}

export interface FavoriteMove {
  seq: number;
  from: string;
  to: string;
}

/** Record that `from` is about to be renamed/moved to `to` (before the file changes). */
export async function recordFavoriteMove(
  projectId: string,
  from: string,
  to: string,
): Promise<void> {
  await drizzleDbRef.current.insert(fileFavoriteMoves).values({
    project_id: projectId,
    from_path: from,
    to_path: to,
    created_at: new Date().toISOString(),
  });
}

/** Recorded moves of a project that are not settled yet, oldest first. */
export async function listFavoriteMoves(
  projectId: string,
): Promise<FavoriteMove[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(fileFavoriteMoves)
    .where(eq(fileFavoriteMoves.project_id, projectId))
    .orderBy(asc(fileFavoriteMoves.seq));
  return rows.map((row) => ({
    seq: row.seq,
    from: row.from_path,
    to: row.to_path,
  }));
}

/** Forget a recorded move without touching favorites (the file never moved). */
export async function discardFavoriteMove(seq: number): Promise<void> {
  await drizzleDbRef.current
    .delete(fileFavoriteMoves)
    .where(eq(fileFavoriteMoves.seq, seq));
}

/**
 * Complete a recorded move: rewrite every user's group favorites at `from` (or
 * below it, after a folder rename or move) to `to` and forget the record, in
 * one transaction. Stale favorites already at the destination are dropped first
 * so the per-user unique index cannot collide.
 */
export async function applyFavoriteMove(
  projectId: string,
  move: FavoriteMove,
): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    const inProject = and(
      eq(fileFavorites.project_id, projectId),
      eq(fileFavorites.kind, 'group'),
    );
    await tx.delete(fileFavorites).where(and(inProject, atOrBelow(move.to)));
    await tx
      .update(fileFavorites)
      .set({
        path: sql`${move.to}::text || substr(${fileFavorites.path}, char_length(${move.from}::text) + 1)`,
      })
      .where(and(inProject, atOrBelow(move.from)));
    await tx
      .delete(fileFavoriteMoves)
      .where(eq(fileFavoriteMoves.seq, move.seq));
  });
}
