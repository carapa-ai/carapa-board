import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import {
  createDatasetTask,
  getDatasetTask,
  getDatasetTasksByProject,
  updateDatasetTask,
  deleteDatasetTask,
  getObjective,
} from '../../db.js';
import { hasPermission } from '../../mcp/auth.js';
import { isValidDataset } from './dataset-validation.js';
import { logger } from '../../logger.js';

// task-executor reaches the tool registry (and therefore this module) through
// its import graph, so it must be loaded lazily to avoid a circular import.
async function spawnNextDatasetRow(
  ...args: Parameters<typeof import('./task-executor.js').spawnNextDatasetRow>
) {
  return (await import('./task-executor.js')).spawnNextDatasetRow(...args);
}

type DatasetPermission = 'datasets:read' | 'datasets:write';

function requireDatasetPermission(
  permissions: Record<string, string[]> | undefined,
  projectId: string,
  permission: DatasetPermission,
): void {
  if (!hasPermission(permissions, projectId, permission)) {
    throw new Error(
      `Unauthorized: missing ${permission} permission for project "${projectId}"`,
    );
  }
}

async function getAuthorizedDatasetTask(
  taskId: string,
  permissions: Record<string, string[]> | undefined,
  permission: DatasetPermission,
) {
  const task = await getDatasetTask(taskId);
  if (!task) throw new Error('Dataset task not found');
  requireDatasetPermission(permissions, task.project_id, permission);
  return task;
}

export const createDatasetTaskTool: ToolDefinition = {
  name: 'create_dataset_task',
  description: 'Create a new dataset task.',
  inputSchema: {
    project_id: z
      .string()
      .optional()
      .describe('Project folder name (defaults to current)'),
    title: z.string().describe('Title for the dataset task'),
    description: z
      .string()
      .optional()
      .describe('Context or instructions for the agent'),
    dataset: z.string().describe('JSON array of objects (rows) to process'),
    model: z.string().optional().describe('LLM model identifier'),
    agent_name: z.string().optional().describe('Agent command or label'),
    objective_id: z
      .string()
      .optional()
      .describe('Objective ID inherited by every generated row task'),
  },
  requiredPermissions: ['datasets:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const {
      project_id,
      title,
      description,
      dataset,
      model,
      agent_name,
      objective_id,
    } = args;
    const { group_folder, permissions } = context;
    const targetProject = project_id || group_folder;
    requireDatasetPermission(permissions, targetProject, 'datasets:write');
    const groups = deps.getRegisteredGroups();
    const group = Object.values(groups).find((g) => g.folder === targetProject);
    if (!group) throw new Error('Project not found');
    if (objective_id) {
      const objective = await getObjective(objective_id);
      if (!objective || objective.project_id !== targetProject) {
        throw new Error(
          `objective_id must identify an objective in project "${targetProject}"`,
        );
      }
    }
    const parsedDataset = JSON.parse(dataset);
    if (!isValidDataset(parsedDataset)) {
      throw new Error(
        'dataset must be a non-empty array of objects with string or number values',
      );
    }
    const dt = await createDatasetTask({
      project_id: targetProject,
      title,
      description: description || '',
      dataset: parsedDataset,
      total_rows: parsedDataset.length,
      model,
      agent_name: agent_name,
      objective_id: objective_id || null,
      status: 'active',
    });
    // Start the first row now; otherwise the dataset would sit idle until the
    // next board restart. An inactive owning objective keeps the row waiting
    // (spawnNextDatasetRow gates on it because `manual` is not set).
    try {
      const first = await spawnNextDatasetRow(dt, group, {
        triggerSource: 'agent',
      });
      return JSON.stringify({ ...dt, first_task_id: first?.id ?? null });
    } catch (err) {
      logger.error(
        { dataset_task_id: dt.id, error: String(err) },
        'Failed to start first row of MCP-created dataset task',
      );
      return JSON.stringify({
        ...dt,
        first_task_id: null,
        error: `Dataset task created but its first row failed to start: ${String(err)}`,
      });
    }
  },
};

export const listDatasetTasksTool: ToolDefinition = {
  name: 'list_dataset_tasks',
  description: 'List all dataset tasks for a project.',
  inputSchema: {
    project_id: z
      .string()
      .optional()
      .describe('Project folder name (defaults to current)'),
  },
  requiredPermissions: ['datasets:read'],
  handler: async ({ project_id }, deps, context) => {
    const { group_folder, permissions } = context;
    const targetProject = project_id || group_folder;
    requireDatasetPermission(permissions, targetProject, 'datasets:read');
    const tasks = await getDatasetTasksByProject(targetProject);
    return JSON.stringify(tasks, null, 2);
  },
};

export const getDatasetTaskTool: ToolDefinition = {
  name: 'get_dataset_task',
  description: 'Get a single dataset task by ID.',
  inputSchema: {
    task_id: z.string().describe('ID of the dataset task'),
  },
  requiredPermissions: ['datasets:read'],
  handler: async ({ task_id }, deps, context) => {
    const { permissions } = context;
    const task = await getAuthorizedDatasetTask(
      task_id,
      permissions,
      'datasets:read',
    );
    return JSON.stringify(task, null, 2);
  },
};

export const updateDatasetTaskTool: ToolDefinition = {
  name: 'update_dataset_task',
  description: 'Update a dataset task config.',
  inputSchema: {
    task_id: z.string().describe('ID of the dataset task'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    status: z
      .enum(['active', 'paused', 'completed'])
      .optional()
      .describe('New status'),
    objective_id: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Objective ID inherited by generated row tasks; null clears ownership',
      ),
  },
  requiredPermissions: ['datasets:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const { task_id, ...data } = args;
    const { permissions } = context;
    const existing = await getAuthorizedDatasetTask(
      task_id,
      permissions,
      'datasets:write',
    );
    if (data.objective_id) {
      const objective = await getObjective(data.objective_id);
      if (!objective || objective.project_id !== existing.project_id) {
        throw new Error(
          `objective_id must identify an objective in project "${existing.project_id}"`,
        );
      }
    }
    const updated = await updateDatasetTask(task_id, data as any);
    // Reactivating a dataset must restart row processing. The spawn is
    // idempotent: it returns null when the current row is already in flight.
    if (updated && data.status === 'active' && existing.status !== 'active') {
      const group = Object.values(deps.getRegisteredGroups()).find(
        (g: any) => g.folder === updated.project_id,
      );
      if (group) {
        try {
          await spawnNextDatasetRow(updated, group, { triggerSource: 'agent' });
        } catch (err) {
          logger.error(
            { dataset_task_id: updated.id, error: String(err) },
            'Failed to start row after MCP dataset task reactivation',
          );
        }
      }
    }
    return JSON.stringify(updated);
  },
};

export const deleteDatasetTaskTool: ToolDefinition = {
  name: 'delete_dataset_task',
  description: 'Delete a dataset task.',
  inputSchema: {
    task_id: z.string().describe('ID of the dataset task'),
  },
  requiredPermissions: ['datasets:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id }, deps, context) => {
    const { permissions } = context;
    await getAuthorizedDatasetTask(task_id, permissions, 'datasets:write');
    await deleteDatasetTask(task_id);
    return `Dataset task ${task_id} deleted.`;
  },
};
