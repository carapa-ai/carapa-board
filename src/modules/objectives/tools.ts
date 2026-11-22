/**
 * Objective MCP tools — create, list, get, update, delete, refresh_dashboard.
 *
 * Extracted from agent-tools.ts. Registered by the objectives module
 * via registerTools().
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  createObjective,
  getObjective,
  getObjectivesByProject,
  updateObjective,
  deleteObjective,
} from '../../db.js';
import {
  initObjectiveFolder,
  archiveObjectiveFolders,
  getObjectiveDir,
  refreshObjectiveContext,
} from './objective-folder.js';
import { computeObjectiveWorkDir, objectiveWorkDirFor } from './work-dir.js';
import { getGroupByFolder } from '../../state-manager.js';
import {
  aggregateRunStats,
  forgetObjectiveRunStats,
} from './objective-run-stats.js';
import { activationRefusalMessage } from './objective-budget.js';
import { drainQueuesForObjective } from './drain-linked-queues.js';
import { moveObjective, ObjectiveMoveError } from './move-objective.js';
import { logger } from '../../logger.js';
import { acknowledgeObjectiveTaskEvent } from '../kanban/task/objective-event-holds.js';
import { broadcast } from './ws-events.js';
import { McpServerDeps, hasPermission } from '../../mcp/auth.js';
import { rejectUnknownArgs } from '../tools/unknown-args.js';
import { validateRuntimeSelection } from '../../lib/chat-agents.js';
import {
  publishEvent,
  publishObjectiveStateEvent,
  resolveBrainContainer,
  resolveBrainUrl,
} from './brain-client.js';

const runtimeSelectionSchema = z.object({
  harnessId: z.string().min(1),
  modelId: z.string().min(1),
  reasoning: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * server.registerTool that rejects arguments the tool does not declare
 * instead of silently dropping them.
 */
function registerStrictTool<S extends z.ZodRawShape>(
  server: McpServer,
  scope: { group_folder: string } | undefined,
  name: string,
  config: { description: string; inputSchema: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  server.registerTool(
    name,
    {
      ...config,
      inputSchema: z.object(config.inputSchema).passthrough() as any,
    },
    async (args: any) =>
      rejectUnknownArgs(name, config.inputSchema, args, scope?.group_folder) ??
      handler(args as z.infer<z.ZodObject<S>>),
  );
}

export function registerObjectiveTools(
  server: McpServer,
  deps: McpServerDeps,
  scope?: {
    group_folder: string;
    task_id?: string;
    permissions?: Record<string, string[]>;
  },
): void {
  // ── create_objective ─────────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'create_objective',
    {
      description:
        'Create a new objective for a project. Objectives are high-level goals above tasks. ' +
        'Main agent can create in any project. A parent project can create in itself and its child projects. All other agents can only create in their own project.',
      inputSchema: {
        group_folder: z
          .string()
          .describe('Group folder from AGENT_CONTEXT (your identity)'),
        project_id: z
          .string()
          .optional()
          .describe(
            'Target project ID. Defaults to group_folder. Main agent may target any project; parent agents may target child projects.',
          ),
        title: z.string().describe('Title of the objective'),
        description: z.string().optional().describe('Detailed description'),
        status: z
          .enum(['draft', 'active', 'achieved', 'failed', 'paused'])
          .optional()
          .describe('Status (default: draft)'),
        priority: z
          .number()
          .int()
          .optional()
          .describe('Sort order (lower = higher priority, default: 0)'),
        deadline: z.string().optional().describe('ISO 8601 deadline date'),
        progress: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('Progress 0–100 (default: 0)'),
        metadata: z
          .string()
          .optional()
          .describe(
            'JSON string of arbitrary key-value metadata (e.g. SMART fields, OKR data)',
          ),
        trigger_config: z
          .string()
          .optional()
          .describe(
            'JSON string defining trigger configuration (cron, task events, manual, etc.)',
          ),
        eventRuntimeSelection: runtimeSelectionSchema
          .optional()
          .describe(
            'Optional runtime override used only for objective event handling. Omit to inherit the project Kanban runtime.',
          ),
      },
    },
    async ({
      group_folder,
      project_id,
      title,
      description,
      status,
      priority,
      deadline,
      progress,
      metadata,
      trigger_config,
      eventRuntimeSelection,
    }) => {
      const targetProject = project_id || group_folder;
      const groups = deps.getRegisteredGroups();

      if (
        !hasPermission(scope?.permissions, targetProject, 'objectives:write')
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: project "${group_folder}" is not allowed to create objectives in "${targetProject}"`,
            },
          ],
        };
      }

      const group = Object.values(groups).find(
        (g) => g.folder === targetProject,
      );
      if (!group) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Project "${targetProject}" not found`,
            },
          ],
        };
      }

      let parsedTrigger: Record<string, unknown> | null = null;
      if (trigger_config) {
        try {
          parsedTrigger = JSON.parse(trigger_config);
        } catch {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: 'Invalid JSON in trigger_config' },
            ],
          };
        }
      }

      let parsedMetadata: Record<string, unknown> | null = null;
      if (metadata) {
        try {
          parsedMetadata = JSON.parse(metadata);
        } catch {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: 'Invalid JSON in metadata' },
            ],
          };
        }
      }

      const runtimeError = validateRuntimeSelection(eventRuntimeSelection);
      if (runtimeError) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: runtimeError }],
        };
      }
      const objective = await createObjective({
        project_id: targetProject,
        title,
        description: description || '',
        status: status || 'draft',
        priority: priority ?? 0,
        deadline: deadline ?? null,
        progress: progress ?? 0,
        metadata: parsedMetadata,
        trigger_config: parsedTrigger,
        eventRuntimeSelection: eventRuntimeSelection ?? null,
      });

      const mcpGroup = group;
      const targetGroup = getGroupByFolder(targetProject) ?? mcpGroup;
      objective.work_dir = targetGroup
        ? objectiveWorkDirFor(targetGroup, objective.id)
        : computeObjectiveWorkDir(targetProject, objective.id);
      await updateObjective(objective.id, { work_dir: objective.work_dir });

      await initObjectiveFolder(
        targetProject,
        objective.id,
        objective,
        mcpGroup?.settings?.brainContainer,
        mcpGroup?.parentId,
        mcpGroup,
      );
      logger.info(
        { objective_id: objective.id, group_folder, targetProject, title },
        'Objective created via MCP',
      );
      broadcast({
        type: 'objective_created',
        payload: { project_id: targetProject, objective },
      });
      publishEvent(
        resolveBrainUrl(resolveBrainContainer(group)),
        {
          type: 'objective_created',
          project_id: targetProject,
          objective_id: objective.id,
          timestamp: new Date().toISOString(),
          data: {
            title: objective.title,
            status: objective.status,
            priority: objective.priority,
          },
        },
        group,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(objective) }],
      };
    },
  );

  // ── list_objectives ──────────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'list_objectives',
    {
      description:
        'List SMART objectives for a project. ' +
        'Main agent can list from any project. A parent project can list from itself and its child projects. All other agents can only list from their own project.',
      inputSchema: {
        group_folder: z
          .string()
          .describe('Group folder from AGENT_CONTEXT (your identity)'),
        project_id: z
          .string()
          .optional()
          .describe(
            'Target project ID. Defaults to group_folder. Main agent may target any project; parent agents may target child projects.',
          ),
      },
    },
    async ({ group_folder, project_id }) => {
      const targetProject = project_id || group_folder;

      if (
        !hasPermission(scope?.permissions, targetProject, 'objectives:read')
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: project "${group_folder}" is not allowed to list objectives in "${targetProject}"`,
            },
          ],
        };
      }

      const objectives = await getObjectivesByProject(targetProject);
      logger.info(
        { group_folder, targetProject, count: objectives.length },
        'Objectives listed via MCP',
      );
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(objectives, null, 2) },
        ],
      };
    },
  );

  // ── get_objective ────────────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'get_objective',
    {
      description:
        'Get a single SMART objective by ID. ' +
        'Main agent can get any objective. A parent project can get objectives in its child projects. All other agents can only get objectives in their own project.',
      inputSchema: {
        group_folder: z
          .string()
          .describe('Group folder from AGENT_CONTEXT (your identity)'),
        objective_id: z.string().describe('The objective ID to retrieve'),
      },
    },
    async ({ group_folder, objective_id }) => {
      const objective = await getObjective(objective_id);
      if (!objective) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Objective "${objective_id}" not found`,
            },
          ],
        };
      }

      if (
        !hasPermission(
          scope?.permissions,
          objective.project_id,
          'objectives:read',
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: objective "${objective_id}" does not belong to project "${group_folder}"`,
            },
          ],
        };
      }

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(objective, null, 2) },
        ],
      };
    },
  );

  // ── update_objective ─────────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'update_objective',
    {
      description:
        "Update an objective's fields. " +
        "Activation is refused while the objective's cost limit is reached. " +
        'Main agent can update any objective. A parent project can update objectives in its child projects. All other agents can only update objectives in their own project.',
      inputSchema: {
        group_folder: z
          .string()
          .describe('Group folder from AGENT_CONTEXT (your identity)'),
        objective_id: z.string().describe('The objective ID to update'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        status: z
          .enum(['draft', 'active', 'achieved', 'failed', 'paused'])
          .optional()
          .describe('New status'),
        priority: z.number().int().optional().describe('New sort order'),
        deadline: z
          .string()
          .nullable()
          .optional()
          .describe('New ISO 8601 deadline (null to clear)'),
        progress: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('New progress 0–100'),
        metadata: z
          .string()
          .nullable()
          .optional()
          .describe(
            'JSON string of arbitrary key-value metadata (null to clear)',
          ),
        trigger_config: z
          .string()
          .nullable()
          .optional()
          .describe('JSON string for trigger configuration (null to clear)'),
        eventRuntimeSelection: runtimeSelectionSchema
          .nullable()
          .optional()
          .describe(
            'Objective event runtime override. Set null to restore project Kanban inheritance.',
          ),
      },
    },
    async ({
      group_folder,
      objective_id,
      title,
      description,
      status,
      priority,
      deadline,
      progress,
      metadata,
      trigger_config,
      eventRuntimeSelection,
    }) => {
      const existing = await getObjective(objective_id);
      if (!existing) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Objective "${objective_id}" not found`,
            },
          ],
        };
      }

      if (
        !hasPermission(
          scope?.permissions,
          existing.project_id,
          'objectives:write',
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: objective "${objective_id}" does not belong to project "${group_folder}"`,
            },
          ],
        };
      }

      const data: Record<string, unknown> = {};
      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (status !== undefined) data.status = status;
      if (priority !== undefined) data.priority = priority;
      if (deadline !== undefined) data.deadline = deadline;
      if (progress !== undefined) data.progress = progress;
      if (eventRuntimeSelection !== undefined) {
        const runtimeError = validateRuntimeSelection(eventRuntimeSelection);
        if (runtimeError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: runtimeError }],
          };
        }
        data.eventRuntimeSelection = eventRuntimeSelection;
      }

      if (metadata !== undefined) {
        if (metadata === null) {
          data.metadata = null;
        } else {
          try {
            data.metadata = JSON.parse(metadata);
          } catch {
            return {
              isError: true,
              content: [
                { type: 'text' as const, text: 'Invalid JSON in metadata' },
              ],
            };
          }
        }
      }

      if (trigger_config !== undefined) {
        if (trigger_config === null) {
          data.trigger_config = null;
        } else {
          try {
            data.trigger_config = JSON.parse(trigger_config);
          } catch {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Invalid JSON in trigger_config',
                },
              ],
            };
          }
        }
      }

      if (Object.keys(data).length === 0) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'No updates provided' }],
        };
      }

      let updated = await updateObjective(objective_id, data);
      logger.info(
        { objective_id, group_folder, fields: Object.keys(data) },
        'Objective updated via MCP',
      );
      if (updated && data.status === 'active') {
        // Re-pauses the objective when it is over its cost limit.
        const runStats = await aggregateRunStats(
          getObjectiveDir(updated.project_id, updated.id),
          updated.project_id,
          updated.id,
        );
        updated = await getObjective(updated.id);
        if (updated?.status !== 'active') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: activationRefusalMessage(
                  updated,
                  runStats?.totalCostUsd ?? 0,
                ),
              },
            ],
          };
        }
      }
      if (updated) {
        await refreshObjectiveContext(updated.project_id, updated);
        const group = Object.values(deps.getRegisteredGroups()).find(
          (candidate) => candidate.folder === updated.project_id,
        );
        const event = {
          type: 'objective_updated',
          project_id: updated.project_id,
          objective_id,
          timestamp: new Date().toISOString(),
          data: { changes: data },
        };
        if (
          data.status !== undefined ||
          data.eventRuntimeSelection !== undefined
        ) {
          await publishObjectiveStateEvent(
            resolveBrainUrl(group ? resolveBrainContainer(group) : undefined),
            event,
            group,
          );
        } else {
          publishEvent(
            resolveBrainUrl(group ? resolveBrainContainer(group) : undefined),
            event,
            group,
          );
        }
        broadcast({
          type: 'objective_updated',
          payload: { project_id: updated.project_id, objective: updated },
        });
        if (existing.status !== 'active' && updated.status === 'active') {
          await drainQueuesForObjective(objective_id);
        }
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(updated, null, 2) },
        ],
      };
    },
  );

  // ── move_objective ───────────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'move_objective',
    {
      description:
        'Move an objective, with its memories, objective folder and conversations (with their transcripts), to another project. The objective keeps its ID. ' +
        'Needs objectives:write on both projects. The objective must have a folder, must not be active or running, and no cronjob or dataset task may reference it. ' +
        'If the response reports vectorStoreUpdated, folderMoved, contextUpdated or conversationStepComplete as false, call it again with the same arguments to finish. ' +
        'Calling it for an objective already in the target project moves conversations an earlier move left in another project (needs objectives:write there too); skippedTranscripts counts chats whose transcript was missing or not moved.',
      inputSchema: {
        group_folder: z
          .string()
          .describe('Group folder from AGENT_CONTEXT (your identity)'),
        objective_id: z.string().describe('The objective ID to move'),
        target_project: z.string().describe('Project ID to move it to'),
      },
    },
    async ({ group_folder, objective_id, target_project }) => {
      const existing = await getObjective(objective_id);
      if (!existing) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Objective "${objective_id}" not found`,
            },
          ],
        };
      }
      // The source authorized here is the one the service moves from. After a
      // committed move it is the project recorded on the objective, so the
      // same call can finish the move; with nothing left to finish there is no
      // source and only the target is needed.
      const sourceProject =
        existing.project_id === target_project
          ? (existing.move_source_project ?? undefined)
          : existing.project_id;
      if (
        (sourceProject &&
          !hasPermission(
            scope?.permissions,
            sourceProject,
            'objectives:write',
          )) ||
        !hasPermission(scope?.permissions, target_project, 'objectives:write')
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: moving objective "${objective_id}" to "${target_project}" needs objectives:write on both projects`,
            },
          ],
        };
      }
      try {
        const result = await moveObjective({
          objectiveId: objective_id,
          targetProject: target_project,
          sourceProject,
          canWriteProject: (project) =>
            hasPermission(scope?.permissions, project, 'objectives:write'),
        });
        logger.info(
          { objective_id, group_folder, target_project },
          'Objective moved via MCP',
        );
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        if (!(err instanceof ObjectiveMoveError)) throw err;
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err.message }],
        };
      }
    },
  );

  // ── delete_objective ─────────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'delete_objective',
    {
      description:
        'Permanently delete a SMART objective. ' +
        'Main agent can delete any objective. A parent project can delete objectives in its child projects. All other agents can only delete objectives in their own project.',
      inputSchema: {
        group_folder: z
          .string()
          .describe('Group folder from AGENT_CONTEXT (your identity)'),
        objective_id: z.string().describe('The objective ID to delete'),
      },
    },
    async ({ group_folder, objective_id }) => {
      const existing = await getObjective(objective_id);
      if (!existing) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Objective "${objective_id}" not found`,
            },
          ],
        };
      }

      if (
        !hasPermission(
          scope?.permissions,
          existing.project_id,
          'objectives:write',
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: objective "${objective_id}" does not belong to project "${group_folder}"`,
            },
          ],
        };
      }

      archiveObjectiveFolders(existing);
      try {
        await deleteObjective(objective_id);
        forgetObjectiveRunStats(objective_id);
      } catch (err) {
        logger.error(
          { err, objective_id, group_folder },
          'Objective delete failed',
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete objective "${objective_id}"`,
            },
          ],
        };
      }
      broadcast({
        type: 'objective_deleted',
        payload: { project_id: existing.project_id, objective_id },
      });
      logger.info({ objective_id, group_folder }, 'Objective deleted via MCP');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Objective "${objective_id}" deleted.`,
          },
        ],
      };
    },
  );

  // ── refresh_dashboard ───────────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'refresh_dashboard',
    {
      description:
        "Notify the UI to reload an objective's dashboard iframe. " +
        'Call this after writing/updating the dashboard HTML files for an objective. ' +
        'Main agent can refresh any objective. A parent project can refresh objectives in its child projects. All other agents can only refresh objectives in their own project.',
      inputSchema: {
        group_folder: z.string().describe('Group folder from AGENT_CONTEXT'),
        objective_id: z
          .string()
          .describe('The objective ID whose dashboard was updated'),
      },
    },
    async ({ group_folder, objective_id }) => {
      const objective = await getObjective(objective_id);
      if (!objective) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Objective "${objective_id}" not found`,
            },
          ],
        };
      }
      if (
        !hasPermission(
          scope?.permissions,
          objective.project_id,
          'objectives:write',
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: objective "${objective_id}" does not belong to project "${group_folder}"`,
            },
          ],
        };
      }
      broadcast({
        type: 'objective_dashboard_updated',
        payload: {
          project_id: objective.project_id,
          objective_id: objective_id,
        },
      });
      logger.info(
        { objective_id: objective_id, group_folder },
        'Dashboard refresh triggered via MCP',
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Dashboard refresh broadcast for objective "${objective_id}".`,
          },
        ],
      };
    },
  );
  // ── ack_objective_task_event ────────────────────────────────────
  registerStrictTool(
    server,
    scope,
    'ack_objective_task_event',
    {
      description:
        'Report that the objective run handling a task_failed or task_question event has ended. ' +
        'The board then sends the held "failed" / "needs input" notification if the task is still in that stage, and drops it if the task was moved. ' +
        "Needs objectives:write on the objective's project; task-run agents cannot call it. " +
        'An ack with no matching held notification is a no-op.',
      inputSchema: {
        group_folder: z.string().describe('Group folder from AGENT_CONTEXT'),
        objective_id: z
          .string()
          .describe('The objective that handled the event'),
        task_id: z.string().describe('The task the event was about'),
        event_type: z
          .enum(['task_failed', 'task_question'])
          .describe('Type of the handled event'),
        event_timestamp: z
          .string()
          .optional()
          .describe(
            'ISO timestamp of the handled event. Omit to settle every open hold of this task and event type.',
          ),
        outcome: z
          .enum(['handled', 'failed', 'skipped'])
          .describe('How the objective run ended'),
      },
    },
    async ({
      objective_id,
      task_id,
      event_type,
      event_timestamp,
      outcome,
      group_folder,
    }) => {
      const objective = await getObjective(objective_id);
      if (!objective) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Objective "${objective_id}" not found`,
            },
          ],
        };
      }
      if (
        scope?.task_id ||
        !hasPermission(
          scope?.permissions,
          objective.project_id,
          'objectives:write',
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Unauthorized: objective "${objective_id}" does not belong to project "${group_folder}" or the caller is a task run`,
            },
          ],
        };
      }
      const settled = await acknowledgeObjectiveTaskEvent({
        objective_id,
        task_id,
        event_type,
        event_timestamp,
        outcome,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Acknowledged ${event_type} for task "${task_id}": ${settled} held notification(s) settled.`,
          },
        ],
      };
    },
  );
}
