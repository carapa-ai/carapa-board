/**
 * Cron job management endpoints — CRUD and manual run.
 */
import { Router } from 'express';
import { CronExpressionParser } from 'cron-parser';
import {
  createTask,
  createCronjob,
  getCronjob,
  getCronjobsByProject,
  getObjective,
  updateCronjob,
  deleteCronjob,
} from '../db.js';
import { TIMEZONE } from '../config.js';
import { getGroupByFolder } from '../state-manager.js';
import { drainProjectQueue } from '../modules/kanban/task-executor.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import {
  getGroupStages,
  getFirstExecutableStage,
  validateRuntimeSelectionStage,
} from '../modules/kanban/stages.js';
import { MAX_LEN, lenError } from './_helpers.js';
import { validateRuntimeSelection } from '../lib/chat-agents.js';

const router = Router();

/** Next occurrence of a cron expression; throws on an invalid expression. */
function nextCronRun(expression: string): string | null {
  return (
    CronExpressionParser.parse(expression, { tz: TIMEZONE })
      .next()
      .toISOString() ?? null
  );
}

// --- Cronjobs ---

/**
 * GET /api/projects/:pid/cronjobs
 * List cronjobs for a project.
 */
router.get('/projects/:pid/cronjobs', async (req, res) => {
  const archived = req.query.archived === 'true';
  try {
    const cronjobs = await getCronjobsByProject(req.params.pid, archived);
    res.json(cronjobs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch cronjobs' });
  }
});

/**
 * POST /api/projects/:pid/cronjobs
 * Create a new cronjob.
 */
router.post('/projects/:pid/cronjobs', async (req, res) => {
  const {
    title,
    description,
    cron_expression,
    queue_mode,
    model,
    agent_name,
    runtimeSelection,
    runtimeSelectionStage,
    objective_id,
  } = req.body || {};

  if (!title || !cron_expression) {
    return res
      .status(400)
      .json({ error: 'title and cron_expression are required' });
  }

  for (const [field, value] of Object.entries({
    title,
    description,
    cron_expression,
    model,
    agent_name,
    objective_id,
  })) {
    if (value !== undefined && typeof value !== 'string') {
      return res.status(400).json({ error: `${field} must be a string` });
    }
  }
  if (title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }

  const cronTitleErr = lenError(title, MAX_LEN.title, 'title');
  if (cronTitleErr) return res.status(400).json({ error: cronTitleErr });
  const cronDescErr = lenError(description, MAX_LEN.description, 'description');
  if (cronDescErr) return res.status(400).json({ error: cronDescErr });
  const cronExprErr = lenError(
    cron_expression,
    MAX_LEN.cron,
    'cron_expression',
  );
  if (cronExprErr) return res.status(400).json({ error: cronExprErr });
  const cronModelErr = lenError(model, MAX_LEN.short, 'model');
  if (cronModelErr) return res.status(400).json({ error: cronModelErr });
  const cronAgentErr = lenError(agent_name, MAX_LEN.short, 'agent_name');
  if (cronAgentErr) return res.status(400).json({ error: cronAgentErr });
  const runtimeError = validateRuntimeSelection(runtimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  const stageScopeError = validateRuntimeSelectionStage(
    getGroupByFolder(req.params.pid),
    runtimeSelectionStage,
  );
  if (stageScopeError) return res.status(400).json({ error: stageScopeError });
  const cronObjectiveErr = lenError(
    objective_id,
    MAX_LEN.short,
    'objective_id',
  );
  if (cronObjectiveErr)
    return res.status(400).json({ error: cronObjectiveErr });
  if (
    queue_mode !== undefined &&
    queue_mode !== 'always' &&
    queue_mode !== 'if_empty'
  ) {
    return res
      .status(400)
      .json({ error: 'queue_mode must be "always" or "if_empty"' });
  }

  // Validate cron expression
  let next_run: string | undefined;
  try {
    next_run = nextCronRun(cron_expression) ?? undefined;
  } catch {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  // Admin callers can pass the project-access middleware for arbitrary folder
  // names. Do not persist a schedule the scheduler can never execute.
  if (!getGroupByFolder(req.params.pid)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (objective_id) {
    const objective = await getObjective(objective_id);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(400).json({
        error: 'objective_id must identify an objective in this project',
      });
    }
  }

  const cronjob = await createCronjob({
    project_id: req.params.pid,
    title,
    description: description || '',
    cron_expression: cron_expression,
    queue_mode: queue_mode || 'always',
    model,
    agent_name,
    runtimeSelection: runtimeSelection ?? null,
    runtimeSelectionStage: runtimeSelectionStage ?? null,
    objective_id: objective_id || null,
    status: 'active',
    next_run: next_run,
  });

  logger.info(
    { cronjob_id: cronjob.id, project: req.params.pid },
    'Cronjob created',
  );
  res.status(201).json(cronjob);
});

/**
 * PATCH /api/projects/:pid/cronjobs/:cid
 * Update a cronjob.
 */
router.patch('/projects/:pid/cronjobs/:cid', async (req, res) => {
  const existing = await getCronjob(req.params.cid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Cronjob not found' });
  }

  const body = req.body ?? {};

  const allowed = [
    'title',
    'description',
    'cron_expression',
    'queue_mode',
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
    if (body[key] !== undefined) data[key] = body[key];
  }

  // Validate lengths / enum values for fields being updated
  for (const field of [
    'title',
    'description',
    'cron_expression',
    'model',
    'agent_name',
    'objective_id',
  ] as const) {
    const value = data[field];
    const nullable =
      field === 'model' || field === 'agent_name' || field === 'objective_id';
    if (
      value !== undefined &&
      typeof value !== 'string' &&
      !(nullable && value === null)
    ) {
      return res.status(400).json({ error: `${field} must be a string` });
    }
  }
  if (typeof data.title === 'string' && data.title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }
  if (typeof data.objective_id === 'string' && data.objective_id) {
    const objective = await getObjective(data.objective_id);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(400).json({
        error: 'objective_id must identify an objective in this project',
      });
    }
  }

  let patchErr: string | null;
  if ((patchErr = lenError(data.title, MAX_LEN.title, 'title')))
    return res.status(400).json({ error: patchErr });
  if (
    (patchErr = lenError(data.description, MAX_LEN.description, 'description'))
  )
    return res.status(400).json({ error: patchErr });
  if (
    (patchErr = lenError(data.cron_expression, MAX_LEN.cron, 'cron_expression'))
  )
    return res.status(400).json({ error: patchErr });
  if ((patchErr = lenError(data.model, MAX_LEN.short, 'model')))
    return res.status(400).json({ error: patchErr });
  if ((patchErr = lenError(data.agent_name, MAX_LEN.short, 'agent_name')))
    return res.status(400).json({ error: patchErr });
  const runtimeError = validateRuntimeSelection(data.runtimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  const stageScopeError = validateRuntimeSelectionStage(
    getGroupByFolder(req.params.pid),
    data.runtimeSelectionStage,
  );
  if (stageScopeError) return res.status(400).json({ error: stageScopeError });
  if (
    data.queue_mode !== undefined &&
    data.queue_mode !== 'always' &&
    data.queue_mode !== 'if_empty'
  ) {
    return res
      .status(400)
      .json({ error: 'queue_mode must be "always" or "if_empty"' });
  }
  if (
    data.status !== undefined &&
    data.status !== 'active' &&
    data.status !== 'paused'
  ) {
    return res
      .status(400)
      .json({ error: 'status must be "active" or "paused"' });
  }
  if (data.archived !== undefined && typeof data.archived !== 'boolean') {
    return res.status(400).json({ error: 'archived must be a boolean' });
  }

  // Recalculate next_run if cron_expression changed
  if (data.cron_expression !== undefined) {
    if (
      typeof data.cron_expression !== 'string' ||
      data.cron_expression.trim() === ''
    ) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }
    try {
      data.next_run = nextCronRun(data.cron_expression as string);
    } catch {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }
  }

  // Recalculate next_run when resuming from paused, or when unarchiving an
  // active cronjob (next_run is not advanced while archived and would
  // otherwise fire immediately on restore).
  const resumesFromPaused =
    data.status === 'active' && existing.status === 'paused';
  const unarchivesActive =
    data.archived === false &&
    !!existing.archived &&
    (data.status ?? existing.status) === 'active';
  if ((resumesFromPaused || unarchivesActive) && !data.cron_expression) {
    try {
      data.next_run = nextCronRun(existing.cron_expression);
    } catch {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }
  }

  const updated = await updateCronjob(req.params.cid, data);
  res.json(updated);
});

/**
 * POST /api/projects/:pid/cronjobs/:cid/run
 * Run a cronjob manually.
 */
router.post('/projects/:pid/cronjobs/:cid/run', async (req, res) => {
  const existing = await getCronjob(req.params.cid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Cronjob not found' });
  }

  // Find a registered group for this project
  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  }

  // Match every other task-start path: a paused/stopped project must not
  // accept new work. Checking before createTask is important because the
  // queue drain also refuses inactive projects, which would otherwise leave
  // an active-stage task permanently stranded on every manual run request.
  const projectStatus = group.settings?.status ?? 'running';
  if (projectStatus === 'paused' || projectStatus === 'stopped') {
    return res
      .status(409)
      .json({ error: `Project is ${projectStatus}. Start the project first.` });
  }

  try {
    // Create a new task from the cronjob — place it directly in the first
    // active stage so drainProjectQueue picks it up for execution.
    const stages = getGroupStages(group);
    const targetStage = getFirstExecutableStage(stages);

    if (!targetStage) {
      return res
        .status(500)
        .json({ error: 'No valid stage found for project' });
    }

    const callerUserId = (req as any).authUser?.id ?? null;
    const task = await createTask({
      project_id: existing.project_id,
      title: existing.title,
      description: existing.description,
      status: targetStage.id,
      priority: 0,
      runtimeSelection: existing.runtimeSelection ?? undefined,
      runtimeSelectionStage: existing.runtimeSelectionStage ?? undefined,
      objective_id: existing.objective_id ?? undefined,
      cronjob_id: existing.id,
      author: 'cronjob',
      ownerUserId: callerUserId ?? group.user_id ?? null,
      lastTriggeredByUserId: callerUserId,
      lastTriggerSource: callerUserId ? 'user' : 'schedule',
      lastTriggeredAt: new Date().toISOString(),
    });

    broadcast({ type: 'task_created', payload: task });
    logger.info(
      { cronjob_id: existing.id, task_id: task.id, stage: targetStage.id },
      'Cronjob manually spawned task',
    );

    // Start execution after the response path has completed. The task is
    // already persisted and broadcast, so agent startup must not delay the
    // card becoming visible to the caller.
    setImmediate(() => {
      drainProjectQueue(existing.project_id, group, {
        allowInactiveObjectiveTaskId: task.id,
      }).catch((err) => {
        logger.error(
          { cronjob_id: existing.id, task_id: task.id, error: String(err) },
          'Error draining queue for manually spawned cronjob task',
        );
      });
    });

    res.json({ ok: true, task_id: task.id, task });
  } catch (err) {
    logger.error(
      { cronjob_id: existing.id, error: String(err) },
      'Error running cronjob manually',
    );
    return res.status(500).json({ error: 'Failed to run cronjob' });
  }
});

/**
 * DELETE /api/projects/:pid/cronjobs/:cid
 * Delete a cronjob.
 */
router.delete('/projects/:pid/cronjobs/:cid', async (req, res) => {
  const existing = await getCronjob(req.params.cid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Cronjob not found' });
  }
  await deleteCronjob(req.params.cid);
  logger.info(
    { cronjob_id: req.params.cid, project: req.params.pid },
    'Cronjob deleted',
  );
  res.json({ ok: true });
});

export default router;
