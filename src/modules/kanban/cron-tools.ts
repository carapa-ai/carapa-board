import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { ToolDefinition } from '../tools/types.js';
import { TIMEZONE } from '../../config.js';
import {
  createCronjob,
  getCronjob,
  getCronjobsByProject,
  getObjective,
  updateCronjob,
  deleteCronjob,
} from '../../db.js';
import { hasPermission } from '../../mcp/auth.js';

type CronPermission = 'cron:read' | 'cron:write';

function requireCronPermission(
  permissions: Record<string, string[]> | undefined,
  projectId: string,
  permission: CronPermission,
): void {
  if (!hasPermission(permissions, projectId, permission)) {
    throw new Error(
      `Unauthorized: missing ${permission} permission for project "${projectId}"`,
    );
  }
}

async function getAuthorizedCronjob(
  cronjobId: string,
  permissions: Record<string, string[]> | undefined,
  permission: CronPermission,
) {
  const cronjob = await getCronjob(cronjobId);
  if (!cronjob) throw new Error('Cronjob not found');
  requireCronPermission(permissions, cronjob.project_id, permission);
  return cronjob;
}

/** Return the first occurrence for a newly-created cronjob. */
export function getNextCronRun(cronExpression: string): string {
  try {
    // cron-parser accepts an empty string as "* * * * *"; a blank expression
    // would otherwise create a job that fires every minute.
    if (!cronExpression.trim()) throw new Error('Blank cron expression');
    const nextRun = CronExpressionParser.parse(cronExpression, { tz: TIMEZONE })
      .next()
      .toISOString();
    if (!nextRun) throw new Error('No next occurrence');
    return nextRun;
  } catch {
    throw new Error('Invalid cron expression');
  }
}

export const createCronjobTool: ToolDefinition = {
  name: 'create_cronjob',
  description: 'Create a new cronjob to spawn tasks.',
  inputSchema: {
    project_id: z
      .string()
      .optional()
      .describe('Target project folder (defaults to current)'),
    title: z.string().describe('Short title for the cronjob'),
    description: z
      .string()
      .optional()
      .describe('Detailed description of the spawned tasks'),
    cron_expression: z
      .string()
      .describe('Cron cadence (e.g. "0 9 * * 1" for Monday 9am)'),
    queue_mode: z
      .enum(['always', 'if_empty'])
      .optional()
      .describe(
        'When to spawn: "always" or only "if_empty" (previous task finished)',
      ),
    objective_id: z
      .string()
      .optional()
      .describe('Objective ID inherited by every spawned task'),
  },
  requiredPermissions: ['cron:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const {
      project_id,
      title,
      description,
      cron_expression,
      queue_mode,
      objective_id,
    } = args;
    const { group_folder, permissions } = context;
    const targetProject = project_id || group_folder;
    requireCronPermission(permissions, targetProject, 'cron:write');
    if (objective_id) {
      const objective = await getObjective(objective_id);
      if (!objective || objective.project_id !== targetProject) {
        throw new Error(
          `objective_id must identify an objective in project "${targetProject}"`,
        );
      }
    }
    const next_run = getNextCronRun(cron_expression);
    const cronjob = await createCronjob({
      project_id: targetProject,
      title,
      description: description || '',
      cron_expression,
      queue_mode: queue_mode || 'always',
      objective_id: objective_id || null,
      status: 'active',
      next_run,
    });
    return JSON.stringify(cronjob);
  },
};

export const listCronjobsTool: ToolDefinition = {
  name: 'list_cronjobs',
  description: 'List all cronjobs for a project.',
  inputSchema: {
    project_id: z
      .string()
      .optional()
      .describe('Project folder name (defaults to current)'),
    archived: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include archived cronjobs'),
  },
  requiredPermissions: ['cron:read'],
  handler: async ({ project_id, archived }, deps, context) => {
    const { group_folder, permissions } = context;
    const targetProject = project_id || group_folder;
    requireCronPermission(permissions, targetProject, 'cron:read');
    const cronjobs = await getCronjobsByProject(
      targetProject,
      archived ?? false,
    );
    return JSON.stringify(cronjobs, null, 2);
  },
};

export const getCronjobTool: ToolDefinition = {
  name: 'get_cronjob',
  description: 'Get a single cronjob by ID.',
  inputSchema: {
    cronjob_id: z.string().describe('ID of the cronjob to fetch'),
  },
  requiredPermissions: ['cron:read'],
  handler: async ({ cronjob_id }, deps, context) => {
    const { permissions } = context;
    const cronjob = await getAuthorizedCronjob(
      cronjob_id,
      permissions,
      'cron:read',
    );
    return JSON.stringify(cronjob, null, 2);
  },
};

export const updateCronjobTool: ToolDefinition = {
  name: 'update_cronjob',
  description: 'Update a cronjob config.',
  inputSchema: {
    cronjob_id: z.string().describe('ID of the cronjob to update'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    cron_expression: z.string().optional().describe('New cron expression'),
    queue_mode: z
      .enum(['always', 'if_empty'])
      .optional()
      .describe('New queue mode'),
    model: z.string().optional().describe('LLM model identifier'),
    agent_name: z.string().optional().describe('Agent command or label'),
    objective_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Objective ID inherited by spawned tasks; null clears ownership',
      ),
  },
  requiredPermissions: ['cron:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const { cronjob_id, ...data } = args;
    const { permissions } = context;
    const existing = await getAuthorizedCronjob(
      cronjob_id,
      permissions,
      'cron:write',
    );
    if (data.objective_id) {
      const objective = await getObjective(data.objective_id);
      if (!objective || objective.project_id !== existing.project_id) {
        throw new Error(
          `objective_id must identify an objective in project "${existing.project_id}"`,
        );
      }
    }
    // Keep the persisted schedule aligned with the expression. Without this,
    // changing an expression leaves the old next_run in place and the
    // scheduler can fire at a stale time (or not run until the old cadence).
    if (data.cron_expression !== undefined) {
      data.next_run = getNextCronRun(data.cron_expression);
    }
    const updated = await updateCronjob(cronjob_id, data as any);
    return JSON.stringify(updated);
  },
};

export const pauseCronjobTool: ToolDefinition = {
  name: 'pause_cronjob',
  description: 'Pause a cronjob.',
  inputSchema: {
    cronjob_id: z.string().describe('ID of the cronjob to pause'),
  },
  requiredPermissions: ['cron:write'],
  authorizesTargetProject: true,
  handler: async ({ cronjob_id }, deps, context) => {
    const { permissions } = context;
    const existing = await getAuthorizedCronjob(
      cronjob_id,
      permissions,
      'cron:write',
    );
    await updateCronjob(cronjob_id, { status: 'paused' });
    return JSON.stringify({ ...existing, status: 'paused' });
  },
};

export const resumeCronjobTool: ToolDefinition = {
  name: 'resume_cronjob',
  description: 'Resume a paused cronjob.',
  inputSchema: {
    cronjob_id: z.string().describe('ID of the cronjob to resume'),
  },
  requiredPermissions: ['cron:write'],
  authorizesTargetProject: true,
  handler: async ({ cronjob_id }, deps, context) => {
    const { permissions } = context;
    const existing = await getAuthorizedCronjob(
      cronjob_id,
      permissions,
      'cron:write',
    );
    const next_run = getNextCronRun(existing.cron_expression);
    const updated = await updateCronjob(cronjob_id, {
      status: 'active',
      next_run,
    });
    return JSON.stringify(updated);
  },
};

export const deleteCronjobTool: ToolDefinition = {
  name: 'delete_cronjob',
  description: 'Delete a cronjob.',
  inputSchema: {
    cronjob_id: z.string().describe('ID of the cronjob to delete'),
  },
  requiredPermissions: ['cron:write'],
  authorizesTargetProject: true,
  handler: async ({ cronjob_id }, deps, context) => {
    const { permissions } = context;
    await getAuthorizedCronjob(cronjob_id, permissions, 'cron:write');
    await deleteCronjob(cronjob_id);
    return `Cronjob ${cronjob_id} deleted.`;
  },
};
