/**
 * Dataset task endpoints — CRUD, run, restart.
 */
import { Router } from 'express';
import {
  createDatasetTask,
  getDatasetTask,
  getDatasetTasksByProject,
  updateDatasetTask,
  deleteDatasetTask,
  getObjective,
} from '../db.js';
import { getGroupByFolder } from '../state-manager.js';
import { spawnNextDatasetRow } from '../modules/kanban/task-executor.js';
import { logger } from '../logger.js';
import { isRecord } from '../lib/type-guards.js';
import { MAX_LEN, lenError } from './_helpers.js';
import { validateRuntimeSelection } from '../lib/chat-agents.js';
import { validateRuntimeSelectionStage } from '../modules/kanban/stages.js';
import { isValidDataset } from '../modules/kanban/dataset-validation.js';

const router = Router();

const DATASET_TASK_STATUSES: readonly string[] = [
  'active',
  'paused',
  'completed',
];

// --- Dataset Tasks ---

/**
 * GET /api/projects/:pid/dataset-tasks
 * List dataset tasks for a project.
 */
router.get('/projects/:pid/dataset-tasks', async (req, res) => {
  const archived = req.query.archived === 'true';
  res.json(await getDatasetTasksByProject(req.params.pid, archived));
});

/**
 * POST /api/projects/:pid/dataset-tasks
 * Create a new dataset task.
 */
router.post('/projects/:pid/dataset-tasks', async (req, res) => {
  const {
    title,
    description,
    dataset,
    model,
    agent_name,
    runtimeSelection,
    runtimeSelectionStage,
    objective_id,
  } = req.body || {};

  if (!title || !dataset) {
    return res.status(400).json({ error: 'title and dataset are required' });
  }

  const dtTitleErr = lenError(title, MAX_LEN.title, 'title');
  if (dtTitleErr) return res.status(400).json({ error: dtTitleErr });
  const dtDescErr = lenError(description, MAX_LEN.description, 'description');
  if (dtDescErr) return res.status(400).json({ error: dtDescErr });
  const dtModelErr = lenError(model, MAX_LEN.short, 'model');
  if (dtModelErr) return res.status(400).json({ error: dtModelErr });
  const dtAgentErr = lenError(agent_name, MAX_LEN.short, 'agent_name');
  if (dtAgentErr) return res.status(400).json({ error: dtAgentErr });
  const runtimeError = validateRuntimeSelection(runtimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  const stageScopeError = validateRuntimeSelectionStage(
    getGroupByFolder(req.params.pid),
    runtimeSelectionStage,
  );
  if (stageScopeError) return res.status(400).json({ error: stageScopeError });
  const dtObjectiveErr = lenError(objective_id, MAX_LEN.short, 'objective_id');
  if (dtObjectiveErr) return res.status(400).json({ error: dtObjectiveErr });
  if (objective_id) {
    const objective = await getObjective(objective_id);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(400).json({
        error: 'objective_id must identify an objective in this project',
      });
    }
  }

  let parsedDataset: Record<string, string | number>[];
  if (typeof dataset === 'string') {
    try {
      parsedDataset = JSON.parse(dataset);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON in dataset' });
    }
  } else if (Array.isArray(dataset)) {
    parsedDataset = dataset;
  } else {
    return res.status(400).json({ error: 'dataset must be a JSON array' });
  }

  if (!isValidDataset(parsedDataset)) {
    return res.status(400).json({
      error:
        'dataset must be a non-empty array of objects with string or number values',
    });
  }

  const dt = await createDatasetTask({
    project_id: req.params.pid,
    title,
    description: description || '',
    dataset: parsedDataset,
    total_rows: parsedDataset.length,
    model,
    agent_name,
    runtimeSelection: runtimeSelection ?? null,
    runtimeSelectionStage: runtimeSelectionStage ?? null,
    objective_id: objective_id || null,
    status: 'active',
  });

  logger.info(
    {
      dataset_task_id: dt.id,
      project: req.params.pid,
      rows: parsedDataset.length,
    },
    'Dataset task created',
  );
  res.status(201).json(dt);
});

/**
 * PATCH /api/projects/:pid/dataset-tasks/:dtid
 * Update a dataset task.
 */
router.patch('/projects/:pid/dataset-tasks/:dtid', async (req, res) => {
  const existing = await getDatasetTask(req.params.dtid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Dataset task not found' });
  }
  if (!isRecord(req.body)) {
    return res.status(400).json({ error: 'JSON body is required' });
  }
  if (
    req.body.title !== undefined &&
    (typeof req.body.title !== 'string' || !req.body.title.trim())
  ) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }

  const allowed = [
    'title',
    'description',
    'dataset',
    'model',
    'agent_name',
    'runtimeSelection',
    'runtimeSelectionStage',
    'objective_id',
    'status',
    'archived',
  ] as const;
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) data[key] = req.body[key];
  }

  // Validate lengths for fields being updated
  let dtPatchErr: string | null;
  if ((dtPatchErr = lenError(data.title, MAX_LEN.title, 'title')))
    return res.status(400).json({ error: dtPatchErr });
  if (
    (dtPatchErr = lenError(
      data.description,
      MAX_LEN.description,
      'description',
    ))
  )
    return res.status(400).json({ error: dtPatchErr });
  if ((dtPatchErr = lenError(data.model, MAX_LEN.short, 'model')))
    return res.status(400).json({ error: dtPatchErr });
  if ((dtPatchErr = lenError(data.agent_name, MAX_LEN.short, 'agent_name')))
    return res.status(400).json({ error: dtPatchErr });
  const runtimeError = validateRuntimeSelection(data.runtimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  const stageScopeError = validateRuntimeSelectionStage(
    getGroupByFolder(req.params.pid),
    data.runtimeSelectionStage,
  );
  if (stageScopeError) return res.status(400).json({ error: stageScopeError });
  if ((dtPatchErr = lenError(data.objective_id, MAX_LEN.short, 'objective_id')))
    return res.status(400).json({ error: dtPatchErr });
  if (typeof data.objective_id === 'string' && data.objective_id) {
    const objective = await getObjective(data.objective_id);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(400).json({
        error: 'objective_id must identify an objective in this project',
      });
    }
  }

  if (data.archived !== undefined && typeof data.archived !== 'boolean') {
    return res.status(400).json({ error: 'archived must be a boolean' });
  }
  if (
    data.status !== undefined &&
    !DATASET_TASK_STATUSES.includes(data.status as string)
  ) {
    return res.status(400).json({
      error: `status must be one of: ${DATASET_TASK_STATUSES.join(', ')}`,
    });
  }

  // If dataset changed, recalculate total_rows
  if (data.dataset !== undefined) {
    let parsed: unknown;
    if (typeof data.dataset === 'string') {
      try {
        parsed = JSON.parse(data.dataset as string);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON in dataset' });
      }
    } else if (Array.isArray(data.dataset)) {
      parsed = data.dataset;
    } else {
      return res.status(400).json({ error: 'dataset must be a JSON array' });
    }
    if (!isValidDataset(parsed)) {
      return res.status(400).json({
        error:
          'dataset must be a non-empty array of objects with string or number values',
      });
    }
    data.dataset = parsed;
    data.total_rows = parsed.length;
    // Rows appended to a finished dataset are exactly the rows after
    // current_row_index; reactivate so only those run (not a restart).
    if (
      existing.status === 'completed' &&
      data.status === undefined &&
      parsed.length > existing.current_row_index
    ) {
      data.status = 'active';
    }
  }

  const updated = await updateDatasetTask(req.params.dtid, data);

  // Resuming a dataset must restart row processing; a row may have finished
  // while it was paused. The spawn is idempotent (null when already in flight).
  if (updated && data.status === 'active' && existing.status !== 'active') {
    const group = getGroupByFolder(req.params.pid);
    if (group) {
      try {
        const callerUserId = (req as any).authUser?.id ?? null;
        await spawnNextDatasetRow(updated, group, {
          ownerUserId: callerUserId,
          triggeredByUserId: callerUserId,
          triggerSource: callerUserId ? 'user' : 'system',
        });
      } catch (err) {
        logger.error(
          { dataset_task_id: updated.id, error: String(err) },
          'Failed to start row after dataset task reactivation',
        );
      }
    }
  }
  res.json(updated);
});

/**
 * POST /api/projects/:pid/dataset-tasks/:dtid/run
 * Start or resume processing the dataset task.
 */
router.post('/projects/:pid/dataset-tasks/:dtid/run', async (req, res) => {
  const existing = await getDatasetTask(req.params.dtid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Dataset task not found' });
  }

  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  }

  // Ensure it's active
  if (existing.status !== 'active') {
    await updateDatasetTask(existing.id, { status: 'active' });
  }

  try {
    const dt = await getDatasetTask(existing.id)!;
    if (!dt) {
      return res.status(404).json({ error: 'Dataset task not found' });
    }
    const callerUserId = (req as any).authUser?.id ?? null;
    const task = await spawnNextDatasetRow(dt, group, {
      manual: true,
      ownerUserId: callerUserId,
      triggeredByUserId: callerUserId,
      triggerSource: callerUserId ? 'user' : 'system',
    });
    if (task) {
      res.json({ ok: true, task_id: task.id });
    } else {
      res.json({
        ok: true,
        message: 'No more rows to process or already running',
      });
    }
  } catch (err) {
    logger.error(
      { dataset_task_id: existing.id, error: String(err) },
      'Error running dataset task',
    );
    return res.status(500).json({ error: 'Failed to run dataset task' });
  }
});

/**
 * POST /api/projects/:pid/dataset-tasks/:dtid/restart
 * Restart processing from the beginning (row 0).
 */
router.post('/projects/:pid/dataset-tasks/:dtid/restart', async (req, res) => {
  const existing = await getDatasetTask(req.params.dtid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Dataset task not found' });
  }

  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  }

  // Reset progress and set active
  await updateDatasetTask(existing.id, {
    current_row_index: 0,
    completed_rows: 0,
    status: 'active',
  });

  try {
    const reset = await getDatasetTask(existing.id)!;
    if (!reset) {
      return res.status(404).json({ error: 'Dataset task not found' });
    }
    const callerUserId = (req as any).authUser?.id ?? null;
    const task = await spawnNextDatasetRow(reset, group, {
      manual: true,
      ownerUserId: callerUserId,
      triggeredByUserId: callerUserId,
      triggerSource: callerUserId ? 'user' : 'system',
    });
    if (task) {
      logger.info(
        { dataset_task_id: existing.id, project: req.params.pid },
        'Dataset task restarted',
      );
      res.json({ ok: true, task_id: task.id });
    } else {
      res.json({ ok: true, message: 'No rows to process' });
    }
  } catch (err) {
    logger.error(
      { dataset_task_id: existing.id, error: String(err) },
      'Error restarting dataset task',
    );
    return res.status(500).json({ error: 'Failed to restart dataset task' });
  }
});

/**
 * DELETE /api/projects/:pid/dataset-tasks/:dtid
 * Delete a dataset task.
 */
router.delete('/projects/:pid/dataset-tasks/:dtid', async (req, res) => {
  const existing = await getDatasetTask(req.params.dtid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Dataset task not found' });
  }
  await deleteDatasetTask(req.params.dtid);
  logger.info(
    { dataset_task_id: req.params.dtid, project: req.params.pid },
    'Dataset task deleted',
  );
  res.json({ ok: true });
});

export default router;
