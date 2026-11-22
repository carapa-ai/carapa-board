import { logger } from '../../logger.js';
import {
  hasPermission,
  isBlockedForReadOnlyOAuth,
  type McpServerDeps,
} from '../../mcp/auth.js';
import { assertEgressAllowed } from '../../lib/privacy-policy.js';
import {
  recordReflectorToolError,
  type ReflectorMemoryExecutionContext,
} from '../memory/execution-context.js';
import type { TriggerSource } from '../kanban/types.js';
import type { ToolDefinition, ToolProgressContext } from './types.js';

const DEFAULT_MCP_TOOL_TIMEOUT_MS = parseInt(
  process.env.MCP_TOOL_TIMEOUT_MS ?? '45000',
  10,
);

export interface ToolExecutionContext extends ToolProgressContext {
  group_folder: string;
  task_id?: string;
  conversation_id?: string;
  run_id?: string;
  /** Server-owned: set by DirectLLM runs, which have no active_runs row. */
  trigger_source?: TriggerSource;
  permissions?: Record<string, string[]>;
  /** Set for MCP OAuth scopes; read-only grants may not run write tools. */
  kind?: string;
  oauth_access?: string;
  oauth_user_id?: string;
  oauth_user_is_admin?: boolean;
  llmConfig?: { baseUrl?: string; apiKey?: string; model: string };
  current_agent_id?: string;
  signal?: AbortSignal;
  memoryExecution?: ReflectorMemoryExecutionContext;
}

/**
 * Keep a long-running MCP tool call alive. Clients such as pi-mcp-adapter restart
 * their request timeout (60 s by default) each time the server reports progress,
 * so a slow call finishes instead of failing with "Request timed out". Returns a
 * stop function; a no-op when the caller sent no progress token.
 */
export function startToolProgress(
  context: ToolProgressContext,
  message: string,
  intervalMs = 15_000,
): () => void {
  const progressToken = context._meta?.progressToken;
  const send = context.sendNotification;
  if (progressToken === undefined || !send) return () => {};
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    send({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    }).catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

function effectiveTimeout(tool: ToolDefinition): number | null {
  if (tool.mcpTimeoutMs === null) return null;
  const configured = tool.mcpTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

function combineSignals(
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return timeoutSignal;
}

/** Execute a tool with a bounded deadline and structured timing logs. */
export async function executeToolHandler(
  tool: ToolDefinition,
  args: any,
  deps: McpServerDeps,
  context: ToolExecutionContext,
): Promise<any> {
  const startedAt = Date.now();
  const timeoutMs = effectiveTimeout(tool);
  const timeoutController = new AbortController();
  const executionContext = {
    ...context,
    signal: combineSignals(context.signal, timeoutController.signal),
  };

  logger.debug(
    {
      tool: tool.name,
      group_folder: context.group_folder,
      task_id: context.task_id,
      timeout_ms: timeoutMs,
    },
    'MCP tool call started',
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    if (isBlockedForReadOnlyOAuth(tool, context)) {
      throw new Error(
        `Unauthorized: "${tool.name}" is not available to read-only access.`,
      );
    }
    if (tool.mainOnly && !hasPermission(context.permissions, '*', '*:*')) {
      throw new Error(`Only the main orchestrator can use "${tool.name}".`);
    }
    if (tool.privacyPurpose) {
      assertEgressAllowed({
        projectId: context.group_folder,
        purpose: tool.privacyPurpose,
        locality: 'remote',
        target: tool.name,
      });
    }
    const handlerPromise = tool.handler(args, deps, executionContext);
    const result =
      timeoutMs === null
        ? await handlerPromise
        : await Promise.race([
            handlerPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timeoutController.abort(
                  new ToolTimeoutError(tool.name, timeoutMs),
                );
                reject(new ToolTimeoutError(tool.name, timeoutMs));
              }, timeoutMs);
              timer.unref?.();
            }),
          ]);

    logger.debug(
      {
        tool: tool.name,
        group_folder: context.group_folder,
        duration_ms: Date.now() - startedAt,
        status: 'success',
      },
      'MCP tool call finished',
    );
    return result;
  } catch (err) {
    recordReflectorToolError(context.memoryExecution, tool.name, err);
    logger.warn(
      {
        tool: tool.name,
        group_folder: context.group_folder,
        duration_ms: Date.now() - startedAt,
        status: err instanceof ToolTimeoutError ? 'timeout' : 'error',
        err: String(err),
      },
      'MCP tool call finished',
    );
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
