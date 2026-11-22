import { z } from 'zod';
import { logger } from '../../logger.js';
import {
  MCP_ALWAYS_LOAD_PROJECTS,
  MCP_ALWAYS_LOAD_TOOLS,
} from '../../config.js';
import { ToolDefinition } from './types.js';
import { getAllTools, getActiveToolsets, TOOLSET_MODULES } from './registry.js';
import {
  McpServerDeps,
  checkPermMatch,
  hasPermission,
  isBlockedForReadOnlyOAuth,
} from '../../mcp/auth.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TriggerSource } from '../kanban/types.js';
import { getMcpMailTools } from '../mail/tools.js';
import { executeToolHandler } from './tool-execution.js';
import { liveGrants } from '../../lib/folder-identity.js';
import { assertPrivacyWriteEpoch } from '../memory/privacy-epoch.js';
import {
  findUnknownArgKeys,
  loggableKeys,
  rejectUnknownArgs,
} from './unknown-args.js';
import {
  recordReflectorToolError,
  ReflectorValidationError,
  resolveReflectorEvidenceError,
  type ReflectorMemoryExecutionContext,
} from '../memory/execution-context.js';

/**
 * Whether the global gate accepts a required permission. It is normally
 * checked on the home folder. A multi-project OAuth grant can hold different
 * access per project, so for tools whose handlers authorize the project they
 * actually operate on, holding it on any of the grant's projects is enough;
 * the handler then refuses a project without it, including the home folder.
 */
function gatePermits(
  tool: ToolDefinition,
  context: {
    group_folder: string;
    kind?: string;
    permissions?: Record<string, string[]>;
  },
  required: string,
): boolean {
  if (hasPermission(context.permissions, context.group_folder, required)) {
    return true;
  }
  return (
    context.kind === 'oauth' &&
    tool.authorizesTargetProject === true &&
    Object.keys(context.permissions ?? {}).some((folder) =>
      hasPermission(context.permissions, folder, required),
    )
  );
}

/**
 * Check if a tool is authorized for a given scope.
 */
function isToolAuthorized(
  tool: ToolDefinition,
  scope: {
    group_folder: string;
    permissions?: Record<string, string[]>;
    kind?: string;
    oauth_access?: string;
  },
  deps: McpServerDeps,
): boolean {
  const { group_folder, permissions } = scope;

  if (isBlockedForReadOnlyOAuth(tool, scope)) return false;

  // Master override: check for wildcard permission
  if (hasPermission(permissions, '*', '*:*')) return true;
  if (tool.mainOnly) return false;

  // If the tool requires specific permissions, check them
  if (tool.requiredPermissions && tool.requiredPermissions.length > 0) {
    if (!permissions) return false;

    // Discovery check: is this tool authorized for ANY group in the record?
    // This makes the tool visible to the agent. Specific per-group enforcement
    // happens in the tool's handler at runtime.
    const hasAnyPermission = tool.requiredPermissions.some((req) => {
      return Object.values(permissions).some((perms) =>
        checkPermMatch(perms, req),
      );
    });

    if (!hasAnyPermission) return false;
  }

  // Special case: list_groups is only for main or parent groups
  if (tool.name === 'list_groups') {
    const groups = deps.getRegisteredGroups();
    const group = Object.values(groups).find((g) => g.folder === group_folder);
    return !!group?.is_main || group?.settings?.isParent === true;
  }

  return true;
}

/**
 * Converts our internal ToolDefinition inputSchema (Record of Zod types)
 * to a standard JSON Schema object for MCP and OpenAI.
 */
function toolInputSchemaToJsonSchema(
  inputSchema: Record<string, z.ZodType<any>>,
) {
  // Zod v4 no longer exposes the v3 `typeName` internals used by the old
  // converter. That silently advertised numbers, arrays, enums, and nested
  // evidence objects as strings to DirectLLM. Use Zod's supported converter
  // so the model and the application share the same contract.
  const exposedSchema = Object.fromEntries(
    Object.entries(inputSchema).filter(([key]) => key !== 'group_folder'),
  );
  const schema = z.toJSONSchema(z.object(exposedSchema)) as Record<string, any>;
  delete schema.$schema;
  return schema;
}

/**
 * Register all tools from the registry to an MCP server.
 */
export function registerToolsToMcp(
  server: McpServer,
  deps: McpServerDeps,
  context?: {
    group_folder: string;
    task_id?: string;
    conversation_id?: string;
    run_id?: string;
    permissions?: Record<string, string[]>;
    kind?: string;
  },
  alwaysLoad: { projects: readonly string[]; tools: readonly string[] } = {
    projects: MCP_ALWAYS_LOAD_PROJECTS,
    tools: MCP_ALWAYS_LOAD_TOOLS,
  },
) {
  const preloadTools =
    context?.group_folder && alwaysLoad.projects.includes(context.group_folder)
      ? new Set(alwaysLoad.tools)
      : undefined;
  const selectedTools = context?.group_folder
    ? getActiveToolsets(context.group_folder).flatMap(
        (s) => TOOLSET_MODULES[s] || [],
      )
    : getAllTools();
  // The own-project mail variants replace the mcpExempt direct-LLM definitions.
  const mcpMailTools = context?.group_folder ? getMcpMailTools(context) : [];
  // A module may export a compatibility alias for an existing definition.
  // MCP rejects duplicate names, so normalize the active-toolset path just as
  // getAllTools() and getOpenAITools() already do.
  const tools = Array.from(
    new Map(
      [...selectedTools, ...mcpMailTools].map((tool) => [tool.name, tool]),
    ).values(),
  );

  for (const tool of tools) {
    // Dynamic filtering: skip tools marked for DirectLLM only
    if (tool.mcpExempt) {
      continue;
    }

    // Dynamic filtering: only register tools the current token is authorized for
    if (context ? !isToolAuthorized(tool, context, deps) : tool.mainOnly) {
      continue;
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // passthrough keeps undeclared keys visible so they can be rejected
        inputSchema: z.object(tool.inputSchema).passthrough() as any,
        // Claude Code loads these tools upfront instead of via ToolSearch.
        ...(preloadTools?.has(tool.name) && {
          _meta: { 'anthropic/alwaysLoad': true },
        }),
      },
      async (args: any, extra: any) => {
        // Enforce authorized context; merge with any optional extra data from transport
        const mergedContext = {
          ...((extra as any) || {}),
          ...context,
        };

        // 1. GLOBAL AUTHORIZATION GATE
        // Enforce required permissions for the context project before calling handler
        if (tool.requiredPermissions && tool.requiredPermissions.length > 0) {
          for (const req of tool.requiredPermissions) {
            if (!gatePermits(tool, mergedContext, req)) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `Unauthorized: missing "${req}" permission for project "${mergedContext.group_folder}"`,
                  },
                ],
              };
            }
          }
        }

        const rejected = rejectUnknownArgs(
          tool.name,
          tool.inputSchema,
          args,
          mergedContext.group_folder,
        );
        if (rejected) return rejected;

        try {
          const result = await executeToolHandler(
            tool,
            args,
            deps,
            mergedContext,
          );
          const textResult =
            typeof result === 'string' ? result : JSON.stringify(result);
          return {
            content: [{ type: 'text' as const, text: textResult }],
          };
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: err.message }],
          };
        }
      },
    );
  }
}

function getDirectLLMTools(
  context?: {
    group_folder: string;
    permissions?: Record<string, string[]>;
  },
  allowedToolNames?: readonly string[],
) {
  const allTools = getAllTools();
  let toolsToConvert = allTools;

  if (context?.group_folder) {
    const activeSets = getActiveToolsets(context.group_folder);
    toolsToConvert = Array.from(
      new Map(
        [
          ...activeSets.flatMap((s) => TOOLSET_MODULES[s] || []),
          ...allTools.filter((tool) => tool.directLlmGlobal),
        ].map((tool) => [tool.name, tool]),
      ).values(),
    );
  }

  toolsToConvert = toolsToConvert.filter(
    (tool) => !tool.mainOnly || hasPermission(context?.permissions, '*', '*:*'),
  );

  if (allowedToolNames !== undefined) {
    const allowed = new Set(allowedToolNames);
    toolsToConvert = toolsToConvert.filter((tool) => allowed.has(tool.name));
  }

  return toolsToConvert;
}

/** Convert tool definitions to OpenAI format, filtering by active toolsets. */
export function getOpenAITools(
  context?: {
    group_folder: string;
    permissions?: Record<string, string[]>;
  },
  allowedToolNames?: readonly string[],
) {
  return getDirectLLMTools(context, allowedToolNames).map((tool) => {
    const jsonSchema = toolInputSchemaToJsonSchema(tool.inputSchema);

    const openaiTool = {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema,
      },
    };

    return openaiTool;
  });
}

/**
 * Dispatch a tool call and return the result as a string.
 */
export async function dispatchToolCall(
  name: string,
  args: any,
  deps: McpServerDeps,
  context: {
    group_folder: string;
    task_id?: string;
    conversation_id?: string;
    run_id?: string;
    trigger_source?: TriggerSource;
    permissions?: Record<string, string[]>;
    current_agent_id?: string;
    signal?: AbortSignal;
    memoryExecution?: ReflectorMemoryExecutionContext;
    /** Exact per-run tool capability set advertised to the model. */
    allowedToolNames?: readonly string[];
  },
): Promise<string> {
  logger.debug(
    {
      tool: name,
      argumentKeys: Object.keys(args ?? {}).slice(0, 40),
      argumentCount: Object.keys(args ?? {}).length,
    },
    '[ToolDispatch] Calling tool',
  );
  // A run keeps the permission map it started with; a folder retired since
  // (its name now belongs to another project) is no longer granted.
  context = { ...context, permissions: liveGrants(context.permissions) };
  if (
    context.allowedToolNames !== undefined &&
    !context.allowedToolNames.includes(name)
  ) {
    const error = new Error(
      `Tool "${name}" is not allowed in this execution context`,
    );
    recordReflectorToolError(context.memoryExecution, name, error);
    throw error;
  }
  if (context.memoryExecution?.privacyEpoch !== undefined) {
    try {
      assertPrivacyWriteEpoch(
        context.group_folder,
        context.memoryExecution.privacyEpoch,
      );
    } catch (error) {
      recordReflectorToolError(context.memoryExecution, name, error);
      throw error;
    }
  }
  const tools =
    context.allowedToolNames === undefined
      ? getDirectLLMTools(context)
      : getAllTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const error = new Error(`Tool "${name}" not found`);
    recordReflectorToolError(context.memoryExecution, name, error);
    throw error;
  }

  // 1. GLOBAL AUTHORIZATION GATE
  // Enforce required permissions for the context project before calling handler
  if (tool.requiredPermissions && tool.requiredPermissions.length > 0) {
    for (const req of tool.requiredPermissions) {
      if (!hasPermission(context.permissions, context.group_folder, req)) {
        const error = new Error(
          `Unauthorized: missing "${req}" permission for project "${context.group_folder}"`,
        );
        recordReflectorToolError(context.memoryExecution, name, error);
        throw error;
      }
    }
  }

  const unknownKeys = findUnknownArgKeys(tool.inputSchema, args);
  if (unknownKeys.length > 0) {
    logger.warn(
      {
        tool: name,
        unknownKeys: loggableKeys(unknownKeys),
        group_folder: context.group_folder,
      },
      'DirectLLM tool call: unknown arguments',
    );
  }

  try {
    const parsed = z.object(tool.inputSchema).passthrough().safeParse(args);
    if (!parsed.success) {
      const error =
        context.memoryExecution && (name === 'memorize' || name === 'forget')
          ? new ReflectorValidationError(
              parsed.error.message,
              args?.operation_key,
              parsed.error.issues.every(
                (issue) =>
                  issue.path.length === 1 &&
                  (issue.path[0] === 'validFrom' ||
                    issue.path[0] === 'validTo'),
              )
                ? 'date'
                : 'input',
            )
          : parsed.error;
      throw error;
    }
    const result = await executeToolHandler(tool, parsed.data, deps, context);
    const textResult =
      typeof result === 'string' ? result : JSON.stringify(result);
    if (
      context.memoryExecution &&
      /^Error(?::(?:\s|$)| (?:preparing sandbox|executing ripgrep in sandbox|reading file|decoding file content):)/i.test(
        textResult.trimStart(),
      )
    ) {
      recordReflectorToolError(context.memoryExecution, name, textResult);
    } else {
      resolveReflectorEvidenceError(
        context.memoryExecution,
        name,
        args?.operation_key,
      );
    }
    return textResult;
  } catch (err: any) {
    recordReflectorToolError(context.memoryExecution, name, err);
    const correction =
      err instanceof ReflectorValidationError
        ? ` ${err.correctionGuidance}`
        : '';
    return `Error: ${err.message}${correction}`;
  }
}
