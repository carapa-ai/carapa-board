import { z } from 'zod';
import { ToolDefinition } from './types.js';
import { getTask, saveChatMessage } from '../../db.js';
import { ASSISTANT_NAME } from '../../config.js';
import { broadcast } from '../objectives/ws-events.js';
import { hasPermission } from '../../mcp/auth.js';
import {
  getGroupEntryByFolder,
  getGroupByFolder,
} from '../../state-manager.js';
import { logger } from '../../logger.js';
import { normalizeStringArray } from './utils.js';
import { resolveKanbanRuntimeSelection } from '../../lib/chat-agents.js';

/**
 * agent_query always launches a sandbox CLI harness. It deliberately uses the
 * v2 Kanban policy rather than the legacy command settings or chat default:
 * chat may legitimately select a DirectLLM binding, which has no executable
 * sandbox command.
 */
export function resolveAgentQueryRuntime(
  group: ReturnType<typeof getGroupByFolder>,
  resolveRuntime: typeof resolveKanbanRuntimeSelection = resolveKanbanRuntimeSelection,
) {
  const resolved = resolveRuntime([
    group?.settings?.kanbanRuntimeSelection ?? undefined,
  ]);
  if (resolved.agent.harnessKind !== 'cli') {
    throw new Error(
      "agent_query requires a CLI Kanban runtime. Configure defaults.kanban (or this project's kanbanRuntimeSelection) with a CLI binding.",
    );
  }
  return resolved.agent;
}

/**
 * These tools are always available to agents.
 */

export const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description:
    'Send a message to the current chat. Use this to proactively share information or updates. The destination is resolved automatically from your context.',
  inputSchema: {
    text: z.string().describe('The message text to send'),
  },
  requiredPermissions: ['chat:write'],
  handler: async (
    { text },
    deps,
    { group_folder, task_id, conversation_id },
  ) => {
    // Resolve destination JID from context
    let resolvedJid: string | undefined;
    if (task_id) {
      // Task agent — send to kanban task chat
      const task = await getTask(task_id);
      if (!task || task.project_id !== group_folder) {
        throw new Error(
          `Unauthorized: task does not belong to project ${group_folder}`,
        );
      }
      resolvedJid = `task-${task_id}@kanban`;
    } else {
      // Chat/scheduled agent — send to the group's WhatsApp JID
      const entry = getGroupEntryByFolder(group_folder);
      resolvedJid = entry?.jid;
    }

    // A chat run carries its conversation, so the message can always be
    // persisted there even when the project has no external (WhatsApp) JID.
    const hasExternalJid = !!resolvedJid && resolvedJid.includes('@');
    if (!hasExternalJid && !(conversation_id && !task_id)) {
      throw new Error(
        `Could not resolve chat destination for project "${group_folder}"`,
      );
    }

    const isKanban = !!resolvedJid && resolvedJid.endsWith('@kanban');
    if (hasExternalJid) {
      const prefixedText = isKanban ? text : `${ASSISTANT_NAME}: ${text}`;
      await deps.sendMessage(resolvedJid!, prefixedText);
    }

    // Save to chat feed + broadcast to UI (matching the normal response pipeline)
    if (!isKanban) {
      const saved = await saveChatMessage({
        group_folder: group_folder,
        role: 'assistant',
        content: text,
        sender_name: null,
        source: hasExternalJid ? 'whatsapp' : 'web',
        created_at: new Date().toISOString(),
        conversation_id: conversation_id ?? null,
      });
      broadcast({
        type: 'chat_message',
        payload: { folder: group_folder, message: saved },
      });
    }

    return 'Message sent';
  },
};

export const listGroupsTool: ToolDefinition = {
  name: 'list_groups',
  description:
    'List all registered groups and their current configuration. ' +
    'Main/parent agents see authorized groups; standard agents see only their own project.',
  inputSchema: {},
  requiredPermissions: ['groups:read'],
  handler: async (_, deps, context) => {
    const groups = deps.getRegisteredGroups();

    const filteredGroups = Object.entries(groups).filter(([, g]) => {
      // Check for specific groups:read permission on the target project
      return hasPermission(context.permissions, g.folder, 'groups:read');
    });

    const groupList = filteredGroups.map(([jid, g]) => ({
      name: g.name,
      folder: g.folder,
      jid,
      added_at: g.added_at,
      local_repo: g.settings?.repositoryLocation,
    }));

    if (groupList.length === 0) {
      return `Error: No groups authorized for project "${context.group_folder}". (Permissions: ${JSON.stringify(context.permissions || {})})`;
    }
    return groupList;
  },
};

export const loadToolsetTool: ToolDefinition = {
  name: 'load_toolset',
  description:
    'Load specialized toolsets from the available-toolsets list in your instructions. Availability depends on enabled modules and project settings. "core" is always loaded.',
  inputSchema: {
    toolsets: z.array(z.string()).describe('List of toolset names to load'),
  },
  requiredPermissions: [], // Core tool
  mcpExempt: true,
  handler: async (args, _deps, { group_folder }) => {
    const toolsets = normalizeStringArray(args.toolsets);

    // We import registry dynamically to avoid circular dependency
    const {
      activeToolsets,
      getActiveToolsets,
      getDisabledToolsets,
      TOOLSET_MODULES,
      resetToolsetPromptCache,
    } = await import('./registry.js');

    const sets = new Set(getActiveToolsets(group_folder));
    const disabled = getDisabledToolsets(group_folder);
    const loaded: string[] = [];
    const blocked: string[] = [];
    for (const s of toolsets) {
      if (disabled.has(s)) {
        blocked.push(s);
        continue;
      }
      if (TOOLSET_MODULES[s]) {
        sets.add(s);
        loaded.push(s);
      }
    }
    activeToolsets.set(group_folder, sets);
    // Drop any cached toolset-prompt entries for this group — the
    // available list (and therefore the cached string) just changed.
    resetToolsetPromptCache(group_folder);
    const newlyAvailableTools = loaded.flatMap((s) =>
      TOOLSET_MODULES[s].map((t) => t.name),
    );
    if (loaded.length === 0 && blocked.length > 0) {
      return `No toolsets loaded. Project settings disabled: ${blocked.join(', ')}.`;
    }
    const blockedMessage =
      blocked.length > 0
        ? ` Project settings disabled: ${blocked.join(', ')}.`
        : '';
    return `Loaded toolsets: ${loaded.join(', ')}. You now have access to these additional tools: ${newlyAvailableTools.join(', ')}.${blockedMessage}`;
  },
};

export const agentQueryTool: ToolDefinition = {
  name: 'agent_query',
  // Delegated agent workflows can legitimately run for many minutes. Their
  // lifecycle already follows the parent run's abort signal and run timeout.
  mcpTimeoutMs: null,
  description:
    'Delegate a complex task or research quest to a containerized agent harness (e.g. codex, claude-code). PREFER using lightweight tools like "ripgrep" for searching or "peek_files" for exploration. Use agent_query ONLY for complex, multi-step reasoning that requires a full agent workflow.',
  inputSchema: {
    prompt: z.string().describe('The prompt or instruction for the sub-agent.'),
    project_id: z
      .string()
      .optional()
      .describe('Target project ID (folder). Defaults to the current project.'),
  },
  requiredPermissions: ['agent:delegate'],
  mcpExempt: true,
  handler: async (args, _deps, context) => {
    const { prompt, project_id } = args;
    const { group_folder, permissions, signal } = context;

    const targetProject = project_id || group_folder;

    // Security check: if targeting a different project, verify explicit delegation permission
    if (targetProject !== group_folder) {
      if (!hasPermission(permissions, targetProject, 'agent:delegate')) {
        throw new Error(
          `Unauthorized: missing "agent:delegate" permission for project "${targetProject}"`,
        );
      }
    }

    // Bail early if the parent run was already cancelled before we even started.
    if (signal?.aborted) {
      throw new Error('Agent query cancelled before start');
    }

    const group = getGroupByFolder(targetProject);
    if (!group) {
      throw new Error(`Project "${targetProject}" not found`);
    }

    logger.info(
      {
        sourceProject: group_folder,
        targetProject,
        prompt,
      },
      '[Tool:agent_query] Delegating to container agent',
    );

    // Dynamic import to break circular dependency
    const { runSandboxAgent } = await import('../../agent-runner.js');
    const agentConfig = resolveAgentQueryRuntime(group);

    // Sub-agent runs are isolated from the parent conversation: pass undefined
    // for conversation_id so we don't append to the parent transcript, overwrite
    // its last_agent_cmd, or write a session row tied to it. The tool result is
    // returned synchronously to the caller.
    //
    // The parent's abort signal is forwarded so that pressing Stop in the parent
    // chat propagates into the sandbox sub-run and kills it (see
    // runContainerAgent: input.signal chains into the sub-run's controller).
    const output = await runSandboxAgent(
      group,
      prompt,
      'agent-tool',
      undefined, // onChunk
      null, // sessionIdOverride (null means start fresh)
      false, // forkSession
      undefined, // conversation_id — detached from parent
      undefined, // work_dir
      {
        agent_cmd: agentConfig.id,
        agentConfig,
        signal,
        // Inherit checkout ownership without attaching the child's session or
        // transcript to the calling conversation. Cross-project queries use
        // the target project's own checkout.
        checkoutConversationId:
          targetProject === group_folder ? context.conversation_id : undefined,
        skipSharedCheckoutLease: targetProject === group_folder,
      },
    );

    if (signal?.aborted) {
      throw new Error('Agent query cancelled by user');
    }

    if (output.result === null) {
      return 'Error: Agent delegation failed (no output returned).';
    }

    return output.result || '(No output from agent)';
  },
};
