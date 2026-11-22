import { z } from 'zod';
import type { McpServerDeps } from '../../mcp/auth.js';
import type { ReflectorMemoryExecutionContext } from '../memory/execution-context.js';
import type { TriggerSource } from '../kanban/types.js';
import type { PrivacyPurpose } from '../../lib/privacy-policy.js';

/** From the MCP request (spread in by registerToolsToMcp); absent for non-MCP callers. */
export interface ToolProgressContext {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType<any>>;
  requiredPermissions?: string[];
  /**
   * The handler itself checks the required permissions against the project the
   * call operates on (a named target, the project of a referenced task or
   * record, or the home folder by default). The global gate then lets an OAuth
   * grant with per-project access through when any of its projects holds the
   * permission, instead of requiring it on the home folder.
   */
  authorizesTargetProject?: boolean;
  /** Visible and executable only with the main orchestrator's global permissions. */
  mainOnly?: boolean;
  /** Sends project content to a remote service; refused in privacy mode `strict`. */
  privacyPurpose?: PrivacyPurpose;
  mcpExempt?: boolean;
  /** Include for DirectLLM even when its normal toolset is project-disabled. */
  directLlmGlobal?: boolean;
  /**
   * Maximum wall-clock time for one tool invocation. Undefined uses the
   * global MCP_TOOL_TIMEOUT_MS default; null disables the deadline for tools
   * that intentionally wait on an external event.
   */
  mcpTimeoutMs?: number | null;
  handler: (
    args: any,
    deps: McpServerDeps,
    context: {
      group_folder: string;
      task_id?: string;
      conversation_id?: string;
      run_id?: string;
      /** Who started the calling turn; set only for DirectLLM runs. */
      trigger_source?: TriggerSource;
      permissions?: Record<string, string[]>;
      /** Set for MCP OAuth scopes (`'oauth'`); other callers carry no user. */
      kind?: string;
      oauth_user_id?: string;
      oauth_user_is_admin?: boolean;
      llmConfig?: { baseUrl?: string; apiKey?: string; model: string };
      /** Agent ID of the LLM currently invoking this tool (e.g. via DirectLLM). Empty when invoked through MCP. */
      current_agent_id?: string;
      /** Present only for the server-owned transcript reflector tool loop. */
      memoryExecution?: ReflectorMemoryExecutionContext;
      /**
       * Cancellation signal for the calling agent. Long-running tool handlers
       * (e.g. notify_user with wait=true) should listen on this so they unblock
       * when the conversation/task run is stopped or its transport closes.
       */
      signal?: AbortSignal;
    } & ToolProgressContext,
  ) => Promise<any>;
}
