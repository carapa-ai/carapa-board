/**
 * Memory endpoints — allows external services (e.g. CarapaBrain) to create,
 * recall, and update memories stored for a group via REST rather than MCP.
 *
 * GET   /api/groups/:group_folder/memories
 *   ?q=<search query>
 *   &type=<memory_type>
 *   &objective_id=<objective_id>
 *   &min_importance=<number 0–1>
 *   &limit=<number, default 10, max 500>
 *
 * POST  /api/groups/:group_folder/memories
 * PATCH /api/groups/:group_folder/memories/:memoryId
 * DELETE /api/groups/:group_folder/memories/:memoryId
 */
import { Router } from 'express';
import {
  searchMemories,
  listCurrentProjectMemories,
  insertMemory,
  getMemory,
  moveMemoryToGroup,
  updateMemory,
  getDefaultImportance,
} from '../db.js';
import { getGroupEntryByFolder } from '../state-manager.js';
import { getObjective } from '../modules/objectives/db-objectives.js';
import { logger } from '../logger.js';
import { isDuplicateMemoryContent } from '../modules/memory/dedup.js';
import type { MemoryType } from '../modules/memory/types.js';
import {
  denyUnlessAdmin,
  lenError,
  MAX_LEN,
  userHasExplicitGroupAccess,
} from './_helpers.js';
import { getVectorStoreHooks } from '../modules/vector-store/hooks.js';
import { withMemoryLifecycleLock } from '../modules/memory/lifecycle-lock.js';
import { getPrivacyErasureEpoch } from '../modules/memory/privacy-epoch.js';
import { getMemoryBackend } from '../modules/memory/backend/factory.js';
import {
  historyMemoryEvalMarkedIds,
  setHistoryMemoryEvalMark,
} from '../modules/memory/history-review.js';

const VALID_MEMORY_TYPES: MemoryType[] = [
  'identity',
  'project',
  'goal',
  'decision',
  'preference',
  'contact',
  'event',
  'task',
];

const router = Router();

router.use('/groups/:group_folder/memories', async (req: any, res, next) => {
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (
    !(await userHasExplicitGroupAccess(req, req.params.group_folder, { write }))
  ) {
    return res.status(403).json({ error: 'Access denied to this group' });
  }
  next();
});

router.get('/groups/:group_folder/memories', async (req, res) => {
  const { group_folder } = req.params;

  // Validate the group exists
  const entry = getGroupEntryByFolder(group_folder);
  if (!entry) return res.status(404).json({ error: 'Group not found' });

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
  const type =
    typeof req.query.type === 'string' ? req.query.type.trim() : undefined;
  const objective_id =
    typeof req.query.objective_id === 'string'
      ? req.query.objective_id.trim()
      : undefined;

  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 10;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  if (req.query.paged === '1') {
    if (!denyUnlessAdmin(req, res)) return;
    const pageLimit = Math.min(limit, 100);
    const page = await listCurrentProjectMemories({
      groupFolder: group_folder,
      limit: pageLimit,
      offset,
      query: q || undefined,
      memory_type: type || undefined,
    });
    const evalMarked = historyMemoryEvalMarkedIds(group_folder);
    return res.json({
      items: page.memories.map((memory) => ({
        ...memory,
        marked_for_eval: evalMarked.has(memory.id),
      })),
      total: page.total,
      offset,
      limit: pageLimit,
    });
  }

  const rawMinImportance = Number(req.query.min_importance);
  let min_importance: number | undefined;
  if (req.query.min_importance !== undefined) {
    if (
      !Number.isFinite(rawMinImportance) ||
      rawMinImportance < 0 ||
      rawMinImportance > 1
    ) {
      return res
        .status(400)
        .json({ error: 'min_importance must be a number between 0 and 1' });
    }
    min_importance = rawMinImportance;
  }

  // updated_at is stored as an ISO string, so normalise `since` for comparison.
  const rawSince =
    typeof req.query.since === 'string' ? req.query.since.trim() : '';
  let since: string | undefined;
  if (rawSince) {
    const sinceMs = Date.parse(rawSince);
    if (Number.isNaN(sinceMs)) {
      return res.status(400).json({ error: 'since must be an ISO timestamp' });
    }
    since = new Date(sinceMs).toISOString();
  }

  const rawOrder =
    typeof req.query.order === 'string' ? req.query.order.trim() : '';
  if (rawOrder && rawOrder !== 'recent') {
    return res.status(400).json({ error: "order must be 'recent'" });
  }
  const order = rawOrder === 'recent' ? 'recent' : undefined;

  const memories = await searchMemories({
    groupFolders: [group_folder],
    query: q || undefined,
    memory_type: type || undefined,
    objective_id: objective_id || undefined,
    limit,
    min_importance,
    since,
    order,
    skipTouch: true,
  });

  const evalMarked = historyMemoryEvalMarkedIds(group_folder);
  return res.json(
    memories.map((memory) => ({
      ...memory,
      marked_for_eval: evalMarked.has(memory.id),
    })),
  );
});

// ── POST /api/groups/:group_folder/memories ────────────────────────────────────
router.post('/groups/:group_folder/memories', async (req, res) => {
  const { group_folder } = req.params;

  const entry = getGroupEntryByFolder(group_folder);
  if (!entry) return res.status(404).json({ error: 'Group not found' });

  const { content, memory_type, tags, importance, objective_id, sourceRef } =
    req.body as {
      content?: string;
      memory_type?: string;
      tags?: string;
      importance?: number;
      objective_id?: string;
      sourceRef?: string;
    };

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  if (tags != null && typeof tags !== 'string') {
    return res.status(400).json({ error: 'tags must be a string' });
  }

  const fieldErr =
    lenError(content, MAX_LEN.description, 'content') ||
    lenError(tags, MAX_LEN.short, 'tags') ||
    lenError(sourceRef, MAX_LEN.short, 'sourceRef');
  if (fieldErr) return res.status(400).json({ error: fieldErr });

  if (!memory_type || !VALID_MEMORY_TYPES.includes(memory_type as MemoryType)) {
    return res.status(400).json({
      error: `memory_type is required and must be one of: ${VALID_MEMORY_TYPES.join(', ')}`,
    });
  }

  if (
    importance !== undefined &&
    (typeof importance !== 'number' || importance < 0 || importance > 1)
  ) {
    return res
      .status(400)
      .json({ error: 'importance must be a number between 0 and 1' });
  }

  // Same ownership rule as the MCP `memorize` tool.
  if (
    objective_id !== undefined &&
    (typeof objective_id !== 'string' ||
      !objective_id ||
      (await getObjective(objective_id))?.project_id !== group_folder)
  ) {
    return res
      .status(400)
      .json({ error: 'objective_id must be an objective of this project' });
  }

  return withMemoryLifecycleLock(group_folder, async () => {
    const writeEpoch = getPrivacyErasureEpoch(group_folder);
    // Dedup check — same logic as the MCP memorize tool
    const dupCandidates = await searchMemories({
      groupFolders: [group_folder],
      query: content.split(/\s+/).slice(0, 8).join(' '),
      memory_type: memory_type,
      limit: 5,
      skipTouch: true,
      strictScope: true,
      ...(objective_id ? { objective_id } : {}),
    });

    const dupMatch = dupCandidates.find((m) =>
      isDuplicateMemoryContent(m.content, content),
    );

    if (dupMatch) {
      const effectiveImportance =
        importance ?? getDefaultImportance(memory_type as MemoryType);
      logger.info(
        {
          memoryId: dupMatch.id,
          group_folder,
          objective_id: objective_id ?? null,
          merged: effectiveImportance > dupMatch.importance,
        },
        'Memory POST treated as duplicate of existing memory',
      );
      if (effectiveImportance > dupMatch.importance) {
        await updateMemory(dupMatch.id, {
          content,
          importance: effectiveImportance,
        });
        const vsHooks = getVectorStoreHooks();
        if (vsHooks?.isAvailable()) {
          await vsHooks.embedAndStore(
            dupMatch.id,
            group_folder,
            content,
            objective_id ?? null,
          );
        }
        return res.status(200).json({
          id: dupMatch.id,
          content,
          memory_type,
          importance: effectiveImportance,
        });
      }
      return res.status(200).json({
        id: dupMatch.id,
        content: dupMatch.content,
        memory_type: dupMatch.memory_type,
        importance: dupMatch.importance,
      });
    }

    const mem = await insertMemory({
      group_folder: group_folder,
      objective_id: objective_id || null,
      content,
      memory_type: memory_type as MemoryType,
      importance: importance ?? getDefaultImportance(memory_type as MemoryType),
      source: 'agent',
      sourceRef: sourceRef,
      tags: tags
        ? tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      expectedPrivacyEpoch: writeEpoch,
    });

    const vsHooks = getVectorStoreHooks();
    if (vsHooks?.isAvailable()) {
      await vsHooks.embedAndStore(
        mem.id,
        group_folder,
        content,
        objective_id ?? null,
      );
    }

    return res.status(201).json({
      id: mem.id,
      content: mem.content,
      memory_type: mem.memory_type,
      importance: mem.importance,
    });
  });
});

// ── PATCH /api/groups/:group_folder/memories/:memoryId ─────────────────────────
router.patch(
  '/groups/:group_folder/memories/:memoryId',
  async (req: any, res) => {
    const { group_folder, memoryId } = req.params;

    const entry = getGroupEntryByFolder(group_folder);
    if (!entry) return res.status(404).json({ error: 'Group not found' });

    return withMemoryLifecycleLock(group_folder, async () => {
      const existing = await getMemory(memoryId);
      if (!existing || existing.group_folder !== group_folder) {
        return res.status(404).json({ error: 'Memory not found' });
      }

      const {
        importance,
        content,
        tags,
        memory_type,
        mark_for_eval,
        targetProjectId,
      } = req.body as {
        importance?: number;
        content?: string;
        tags?: string;
        memory_type?: string;
        mark_for_eval?: boolean;
        targetProjectId?: string;
      };

      if (
        targetProjectId !== undefined &&
        typeof targetProjectId !== 'string'
      ) {
        return res
          .status(400)
          .json({ error: 'targetProjectId must be a project id' });
      }
      if (tags !== undefined && typeof tags !== 'string') {
        return res.status(400).json({ error: 'tags must be a string' });
      }

      const targetProject = targetProjectId?.trim();
      if (targetProjectId !== undefined && !targetProject) {
        return res
          .status(400)
          .json({ error: 'targetProjectId must be a project id' });
      }
      if (targetProject && targetProject !== group_folder) {
        if (!getGroupEntryByFolder(targetProject)) {
          return res
            .status(404)
            .json({ error: 'Destination project not found' });
        }
        if (
          !(await userHasExplicitGroupAccess(req, targetProject, {
            write: true,
          }))
        ) {
          return res
            .status(403)
            .json({ error: 'Access denied to destination project' });
        }
      }

      if (
        importance !== undefined &&
        (typeof importance !== 'number' || importance < 0 || importance > 1)
      ) {
        return res
          .status(400)
          .json({ error: 'importance must be a number between 0 and 1' });
      }
      if (mark_for_eval !== undefined && typeof mark_for_eval !== 'boolean') {
        return res.status(400).json({ error: 'mark_for_eval must be boolean' });
      }

      if (
        content !== undefined &&
        (typeof content !== 'string' || !content.trim())
      ) {
        return res
          .status(400)
          .json({ error: 'content must be a non-empty string' });
      }
      const fieldErr =
        lenError(content, MAX_LEN.description, 'content') ||
        lenError(tags, MAX_LEN.short, 'tags');
      if (fieldErr) return res.status(400).json({ error: fieldErr });

      const updates: Parameters<typeof updateMemory>[1] = {};
      if (importance !== undefined) updates.importance = importance;
      if (content !== undefined) updates.content = content;
      if (tags !== undefined) {
        updates.tags = tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (memory_type !== undefined) {
        if (!VALID_MEMORY_TYPES.includes(memory_type as MemoryType)) {
          return res.status(400).json({
            error: `memory_type must be one of: ${VALID_MEMORY_TYPES.join(', ')}`,
          });
        }
        updates.memory_type = memory_type as MemoryType;
      }

      const wasMarked = historyMemoryEvalMarkedIds(group_folder).has(memoryId);
      await updateMemory(memoryId, updates);

      const moved = !!targetProject && targetProject !== group_folder;
      if (moved) {
        await moveMemoryToGroup(memoryId, targetProject);
        const vsHooks = getVectorStoreHooks();
        if (vsHooks?.isAvailable()) {
          await vsHooks.moveMemoryScope?.(
            memoryId,
            group_folder,
            targetProject,
          );
        }
      }

      if (content !== undefined) {
        const vsHooks = getVectorStoreHooks();
        if (vsHooks?.isAvailable()) {
          await vsHooks.embedAndStore(
            memoryId,
            targetProject || group_folder,
            content,
            moved ? null : existing.objective_id,
          );
        }
      }

      const updated = await getMemory(memoryId);
      if (!updated)
        return res.status(500).json({ error: 'Memory not found after update' });
      const markedForEval = mark_for_eval ?? wasMarked;
      if (targetProject && targetProject !== group_folder && wasMarked) {
        setHistoryMemoryEvalMark(
          group_folder,
          existing,
          false,
          req.authUser?.username ?? req.authUser?.id ?? 'administrator',
        );
      }
      if (
        mark_for_eval !== undefined ||
        (wasMarked &&
          (content !== undefined ||
            (!!targetProject && targetProject !== group_folder)))
      ) {
        setHistoryMemoryEvalMark(
          targetProject || group_folder,
          updated,
          markedForEval,
          req.authUser?.username ?? req.authUser?.id ?? 'administrator',
        );
      }
      return res.json({ ...updated, marked_for_eval: markedForEval });
    });
  },
);

// ── DELETE /api/groups/:group_folder/memories/:memoryId ──────────────────────
router.delete(
  '/groups/:group_folder/memories/:memoryId',
  async (req: any, res) => {
    const { group_folder, memoryId } = req.params;
    const entry = getGroupEntryByFolder(group_folder);
    if (!entry) return res.status(404).json({ error: 'Group not found' });

    const existing = await getMemory(memoryId);
    if (!existing || existing.group_folder !== group_folder) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    setHistoryMemoryEvalMark(
      group_folder,
      existing,
      false,
      req.authUser?.username ?? req.authUser?.id ?? 'administrator',
    );
    await getMemoryBackend().erase(memoryId, { group_folder });
    return res.json({ ok: true });
  },
);

export default router;
