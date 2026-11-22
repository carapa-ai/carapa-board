import { Router } from 'express';
import {
  publishEvent,
  resolveBrainUrl,
  resolveBrainContainer,
} from '../modules/objectives/brain-client.js';
import { getObjective } from '../modules/objectives/db-objectives.js';
import { logger } from '../logger.js';
import { getGroupByFolder } from '../state-manager.js';
import { lenError, MAX_LEN, userHasExplicitGroupAccess } from './_helpers.js';

const router = Router();

/**
 * POST /api/events/shared_knowledge
 *
 * Forward a shared_knowledge event from the coordinator to the brain container.
 * The brain handles routing (to specific objective, project broadcast, or group-level).
 *
 * Body: {
 *   project_id: string        — required: which project/group to target
 *   content: string            — required: the knowledge to share
 *   objective_id?: string      — optional: target a specific objective
 *   priority?: number          — optional: queue priority (default 3)
 * }
 */
router.post('/events/shared_knowledge', async (req, res) => {
  const { project_id, content, objective_id, priority } = req.body ?? {};

  if (!project_id || typeof project_id !== 'string') {
    return res.status(400).json({ error: 'project_id is required' });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }
  const contentErr = lenError(content, MAX_LEN.description, 'content');
  if (contentErr) return res.status(400).json({ error: contentErr });
  if (
    priority !== undefined &&
    (typeof priority !== 'number' || !Number.isFinite(priority))
  ) {
    return res.status(400).json({ error: 'priority must be a finite number' });
  }

  const group = getGroupByFolder(project_id);
  if (!group) {
    return res
      .status(404)
      .json({ error: `No group found for project ${project_id}` });
  }

  if (!(await userHasExplicitGroupAccess(req, project_id, { write: true }))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (
    objective_id !== undefined &&
    (typeof objective_id !== 'string' ||
      !objective_id ||
      (await getObjective(objective_id))?.project_id !== project_id)
  ) {
    return res
      .status(400)
      .json({ error: 'objective_id must be an objective of this project' });
  }

  const brainUrl = resolveBrainUrl(resolveBrainContainer(group));
  if (!brainUrl) {
    return res.status(503).json({
      error: 'Brain container not configured or not running for this project',
    });
  }

  publishEvent(
    brainUrl,
    {
      type: 'shared_knowledge',
      project_id,
      objective_id: objective_id ?? null,
      timestamp: new Date().toISOString(),
      data: {
        content,
        ...(priority != null ? { priority } : {}),
      },
    },
    group,
  );

  logger.info(
    { project_id, objective_id, contentPreview: content.slice(0, 80) },
    'shared_knowledge forwarded to brain',
  );

  return res.json({ ok: true });
});

export default router;
