/**
 * /api/projects/:pid/files/favorites
 * A user's personal favorite files in a project's Files tab, stored per user and
 * project so they follow the user across devices. Favoriting changes no project
 * data, so any member who can read the project (viewers included) may use it.
 */

import { Router } from 'express';
import {
  addFileFavorite,
  deleteMissingGroupFavorites,
  adminBypassesKb,
  getReachableKbIds,
  getKbAccessLevel,
  listFileFavorites,
  removeFileFavorite,
  type FileFavoriteRef,
  type FileFavoriteRow,
} from '../db.js';
import {
  GroupFileOpError,
  groupPathIsMissing,
  normalizeGroupPath,
  resolveGroupFile,
} from '../lib/group-file-ops.js';
import {
  requireSettledFavoriteMoves,
  settleFavoriteMoves,
  withFavoritesLock,
} from '../lib/file-favorite-sync.js';
import { logger } from '../logger.js';
import {
  KnowledgeFileError,
  KnowledgeService,
} from '../modules/knowledge/knowledge-service.js';
import { childProjectFolders, getGroupByFolder } from '../state-manager.js';
import { requireAuth } from './auth-helpers.js';

const router = Router();

const lastSegment = (value: string) => value.split('/').pop() || value;

function toApi(row: FileFavoriteRow) {
  const isGroup = row.kind === 'group';
  return {
    id: row.id,
    kind: row.kind,
    ...(isGroup
      ? { path: row.path }
      : { kbId: row.kb_id, filename: row.filename }),
    name: lastSegment((isGroup ? row.path : row.filename) ?? ''),
    createdAt: row.created_at,
  };
}

/** The identifier in a PUT/DELETE body, or null when it has the wrong shape. */
function parseRef(body: any): FileFavoriteRef | null {
  if (body?.kind === 'group' && typeof body.path === 'string')
    return { kind: 'group', path: body.path };
  if (
    body?.kind === 'knowledge' &&
    typeof body.kbId === 'string' &&
    body.kbId &&
    typeof body.filename === 'string' &&
    body.filename
  )
    return { kind: 'knowledge', kbId: body.kbId, filename: body.filename };
  return null;
}

/** Group favorites whose file is verifiably gone; errors never count as gone. */
async function findMissingGroupFavorites(
  folder: string,
  rows: FileFavoriteRow[],
): Promise<Array<{ id: string; path: string }>> {
  const checked = await Promise.all(
    rows.map(async (row) =>
      row.kind === 'group' && (await groupPathIsMissing(folder, row.path!))
        ? { id: row.id, path: row.path! }
        : null,
    ),
  );
  return checked.filter((row) => row !== null);
}

router.get(
  '/projects/:pid/files/favorites',
  requireAuth,
  async (req: any, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    try {
      // Under the project lock no move is half applied while paths are checked.
      const { rows, missing } = await withFavoritesLock(
        group.folder,
        async () => {
          const settled = await settleFavoriteMoves(group.folder);
          const rows = await listFileFavorites(req.authUser.id, group.folder);
          const missing = await findMissingGroupFavorites(group.folder, rows);
          // Nothing is dropped while a move is still unsynced: the stored paths
          // may be stale rather than the files gone.
          if (settled && missing.length > 0) {
            // Housekeeping: a failure still hides the entries below.
            await deleteMissingGroupFavorites(missing).catch((err) =>
              logger.warn({ err }, 'Failed to prune missing file favorites'),
            );
          }
          return { rows, missing };
        },
      );
      const missingIds = new Set(missing.map((row) => row.id));
      // A knowledge base the user lost access to stays stored but is not shown.
      const readableKbs = rows.some((row) => row.kind === 'knowledge')
        ? await getReachableKbIds(
            req.authUser,
            rows.flatMap((row) => (row.kb_id ? [row.kb_id] : [])),
          )
        : null;
      res.json({
        favorites: rows
          .filter(
            (row) =>
              !missingIds.has(row.id) &&
              (row.kind !== 'knowledge' ||
                readableKbs?.has(row.kb_id!) !== false),
          )
          .map(toApi),
      });
    } catch (err) {
      logger.warn({ err, project: req.params.pid }, 'List favorites failed');
      res.status(500).json({ error: 'Failed to list favorites' });
    }
  },
);

router.put(
  '/projects/:pid/files/favorites',
  requireAuth,
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const added = parseRef(req.body);
    if (!added) return res.status(400).json({ error: 'Invalid favorite' });
    try {
      // Serialized with file moves so the path checked is the path stored.
      const denied = await withFavoritesLock(group.folder, async () => {
        let target: FileFavoriteRef = added;
        if (added.kind === 'group') {
          // An unsettled move would later overwrite what is added now.
          await requireSettledFavoriteMoves(group.folder);
          target = {
            kind: 'group',
            path: await resolveGroupFile(group.folder, added.path, {
              extraProtectedRoot: childProjectFolders(group.folder),
            }),
          };
        } else {
          if (
            !(await adminBypassesKb(req.authUser, added.kbId)) &&
            !(await getKbAccessLevel(req.authUser.id, added.kbId))
          )
            return true;
          await KnowledgeService.getDocumentPath(added.kbId, added.filename);
        }
        await addFileFavorite(req.authUser.id, group.folder, target);
        return false;
      });
      if (denied)
        return res
          .status(403)
          .json({ error: 'Access denied to this knowledge base' });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof GroupFileOpError || err instanceof KnowledgeFileError)
        return res.status(err.status).json({ error: err.message });
      logger.warn({ err, project: req.params.pid }, 'Add favorite failed');
      res.status(500).json({ error: 'Failed to add favorite' });
    }
  },
);

router.delete(
  '/projects/:pid/files/favorites',
  requireAuth,
  async (req: any, res) => {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    let ref = parseRef(req.body);
    if (!ref) return res.status(400).json({ error: 'Invalid favorite' });
    try {
      // The file may be gone or the knowledge base no longer readable: a
      // favorite can always be removed by its identifier.
      if (ref.kind === 'group')
        ref = { kind: 'group', path: normalizeGroupPath(ref.path) };
      await removeFileFavorite(req.authUser.id, group.folder, ref);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof GroupFileOpError)
        return res.status(err.status).json({ error: err.message });
      logger.warn({ err, project: req.params.pid }, 'Remove favorite failed');
      res.status(500).json({ error: 'Failed to remove favorite' });
    }
  },
);

export default router;
