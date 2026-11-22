import path from 'path';
import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import { normalizeStringArray } from '../tools/utils.js';
import { logger } from '../../logger.js';
import { llmComplete } from '../../lib/llm-client.js';
import {
  getChatAgents,
  getRuntimeCatalog,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import { selectPeekFilesRuntime } from './peek-runtime.js';
import {
  prepareGroupSandbox,
  prepareScopedSandbox,
  resolveSandboxPath,
  shellQuote,
} from './sandbox-fs.js';
import { getSandboxClient } from '../../lib/mcp-client.js';

const RIPGREP_TIMEOUT_S = 30;
const FILE_READ_TIMEOUT_S = 15;
const NOT_FOUND_SENTINEL = '__NOT_FOUND__';
const NO_OUTPUT_SENTINEL = '(no output)';

/**
 * CarapaBox `sandbox_exec` replaces empty output with the literal
 * `(no output)`. Treat a stdout that is exactly that sentinel as empty;
 * real output is returned unchanged.
 */
export function normalizeFsToolStdout(stdout: string | undefined): string {
  return stdout?.trim() === NO_OUTPUT_SENTINEL ? '' : (stdout ?? '');
}

export interface FsToolDependencies {
  prepareGroupSandbox: typeof prepareGroupSandbox;
  getSandboxClient: typeof getSandboxClient;
  getChatAgents: typeof getChatAgents;
  getRuntimeCatalog: typeof getRuntimeCatalog;
  resolveRuntimeSelection: typeof resolveRuntimeSelection;
  llmComplete: typeof llmComplete;
  prepareScopedSandbox?: typeof prepareScopedSandbox;
}

const defaultDependencies: FsToolDependencies = {
  prepareGroupSandbox,
  getSandboxClient,
  getChatAgents,
  getRuntimeCatalog,
  resolveRuntimeSelection,
  llmComplete,
  prepareScopedSandbox,
};

function dependenciesFromToolContext(deps: unknown): FsToolDependencies {
  return (
    (deps as { fsTools?: FsToolDependencies }).fsTools ?? defaultDependencies
  );
}

export const ripgrepTool: ToolDefinition = {
  name: 'ripgrep',
  description:
    'Search for a pattern in the project sandbox using ripgrep. Searches the project repo mounted inside the group\'s sandbox container under the project workspace root(s). For projects with multiple workspace roots, pass an absolute path; the error message lists the legal roots if you guess wrong. This is the FASTEST way to search the codebase and should be preferred over "agent_query" for simple searches. DO NOT use this for searching transcripts (use search_transcripts instead).',
  inputSchema: {
    query: z.string().describe('The pattern to search for'),
    path: z
      .string()
      .optional()
      .describe(
        'Path to search in. Optional for single-root projects (defaults to the primary workspace root). REQUIRED (as an absolute path) for projects with multiple workspace roots — call without a path first to receive the list of legal roots in the error message, then re-call with one of them.',
      ),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async (
    { query, path: subPath },
    _deps,
    { group_folder, memoryExecution },
  ) => {
    const dependencies = dependenciesFromToolContext(_deps);
    let resolved;
    try {
      resolved = await (
        dependencies.prepareScopedSandbox ?? prepareScopedSandbox
      )(group_folder, memoryExecution?.filesystem);
    } catch (err: any) {
      return `Error preparing sandbox: ${err.message}`;
    }

    let searchDir: string;
    try {
      searchDir = resolveSandboxPath(
        { primary: resolved.workspaceRoot, extra: resolved.extraRoots },
        subPath,
      );
    } catch (err: any) {
      return `Error: ${err.message}`;
    }

    if (searchDir.split(path.posix.sep).includes('transcripts')) {
      return "Error: Do not use ripgrep for transcripts. Use the transcript tools (e.g., 'search_transcripts', 'get_transcript') instead for searching conversation logs.";
    }

    const cmd = `fs-tool.sh ripgrep ${shellQuote(searchDir)} ${shellQuote(query)}`;

    let result;
    try {
      const client = dependencies.getSandboxClient();
      result = await client.sandboxExec(resolved.stack, resolved.service, cmd, {
        instance: resolved.instance,
        timeout: RIPGREP_TIMEOUT_S,
      });
    } catch (err: any) {
      return `Error executing ripgrep in sandbox: ${err.message}`;
    }

    const output = normalizeFsToolStdout(result.stdout);
    if (result.isError) {
      // ripgrep exits non-zero when there are no matches.
      if (!output.trim()) return 'No matches found.';
      return `Error: ${output}`;
    }
    if (!output.trim()) return 'No matches found.';

    const limit = 50000;
    if (output.length > limit) {
      return (
        output.slice(0, limit) +
        `\n... [Truncated ${output.length - limit} bytes]`
      );
    }
    return output;
  },
};

export const peekFilesTool: ToolDefinition = {
  name: 'peek_files',
  description:
    "Fastest way to preview and summarize multiple files at once without the overhead of agent delegation. Reads files from the project repo mounted inside the group's sandbox container, under the project workspace root(s). Each file is pre-filtered by a secondary LLM to extract only relevant parts, preventing context window bloat. Use this instead of agent_query for quick file exploration. For projects with multiple workspace roots, pass absolute paths.",
  inputSchema: {
    files: z
      .array(z.string())
      .describe(
        'List of file paths to peek into. Relative paths are joined to the primary workspace root; absolute paths must fall under the primary or any extra workspace root.',
      ),
    intent: z
      .string()
      .optional()
      .describe(
        'Optional hint to the preview LLM about what you are looking for (e.g. "I want to see how tools are registered")',
      ),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async ({ files, intent }, _deps, _context) => {
    const dependencies = dependenciesFromToolContext(_deps);
    const { group_folder, current_agent_id, memoryExecution } = _context;
    const fileList = normalizeStringArray(files);

    const catalog = dependencies.getRuntimeCatalog();
    const peekSelection = catalog.defaults.peekFiles;
    const configuredAgent = peekSelection
      ? dependencies.resolveRuntimeSelection(peekSelection)
      : undefined;
    const defaultChatAgent = catalog.defaults.chat
      ? dependencies.resolveRuntimeSelection(catalog.defaults.chat)
      : undefined;
    const resolvedAgent = selectPeekFilesRuntime({
      agents: dependencies.getChatAgents(),
      configured: configuredAgent,
      currentAgentId: current_agent_id,
      defaultChat: defaultChatAgent,
    });
    if (!resolvedAgent) {
      return `Error: peek_files needs an HTTP-capable v2 runtime binding. Configure defaults.peekFiles in board_agents.jsonc or select one for the current conversation.`;
    }
    // No hard maxTokens cap here: it would also bound the model's thinking
    // tokens and can crash smaller local models. When the peek binding has no
    // max_tokens of its own, the request omits the limit entirely and the
    // provider default applies.
    const peekConfig = { agentId: resolvedAgent.id };

    logger.info(
      { agentId: resolvedAgent.id, fileCount: fileList.length, group_folder },
      '[peek_files] Starting multi-file preview via sandbox',
    );

    let resolved;
    try {
      resolved = await (
        dependencies.prepareScopedSandbox ?? prepareScopedSandbox
      )(group_folder, memoryExecution?.filesystem);
    } catch (err: any) {
      return `Error preparing sandbox: ${err.message}`;
    }
    const client = dependencies.getSandboxClient();

    const results: string[] = [];
    for (const file of fileList) {
      let fullPath: string;
      try {
        fullPath = resolveSandboxPath(
          { primary: resolved.workspaceRoot, extra: resolved.extraRoots },
          file,
        );
      } catch (err: any) {
        results.push(`### File: ${file}\nError: ${err.message}`);
        continue;
      }

      const cmd = `fs-tool.sh read-file ${shellQuote(fullPath)}`;
      let execResult;
      try {
        execResult = await client.sandboxExec(
          resolved.stack,
          resolved.service,
          cmd,
          { instance: resolved.instance, timeout: FILE_READ_TIMEOUT_S },
        );
      } catch (err: any) {
        results.push(`### File: ${file}\nError reading file: ${err.message}`);
        continue;
      }

      const stdout = normalizeFsToolStdout(execResult.stdout).trim();
      if (execResult.isError) {
        results.push(`### File: ${file}\nError reading file: ${stdout}`);
        continue;
      }
      if (stdout === NOT_FOUND_SENTINEL) {
        results.push(`### File: ${file}\nError: File not found`);
        continue;
      }

      let content: string;
      try {
        content = Buffer.from(stdout, 'base64').toString('utf-8');
      } catch (err: any) {
        results.push(
          `### File: ${file}\nError decoding file content: ${err.message}`,
        );
        continue;
      }

      try {
        const fileName = path.posix.basename(fullPath);
        const systemPrompt = `You are a high-speed file preview assistant. I will provide you with a file's content.
Your task is to decide what information from this file is relevant for the current conversation context.
${intent ? `THE AGENT'S INTENT IS: "${intent}"` : ''}

Respond with:
- EXACTLY "full" if the entire content is important.
- EXACTLY "none" if none of it is important.
- A condensed version of the content containing ONLY the relevant snippets if only parts are useful.

BE EXTREMELY CONCISE. DO NOT EXPLAIN YOURSELF.`;

        const peekRes = await dependencies.llmComplete(
          peekConfig,
          systemPrompt,
          `FILENAME: ${fileName}\n\nCONTENT:\n${content}`,
          { projectId: group_folder, privacyPurpose: 'helper' },
        );
        const peekText = peekRes.content.trim();

        if (peekText.toLowerCase() === 'full') {
          results.push(`### File: ${file} (Full Content)\n${content}`);
        } else if (peekText.toLowerCase() === 'none') {
          results.push(`### File: ${file}\n(No relevant content found)`);
        } else {
          results.push(`### File: ${file} (Filtered Content)\n${peekText}`);
        }
      } catch (err: any) {
        results.push(`### File: ${file}\nError peeking file: ${err.message}`);
      }
    }

    return results.join('\n\n---\n\n');
  },
};

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    "Read a single file from the project repo mounted inside the group's sandbox container, under the project workspace root(s). Returns raw text content. Use this for full-file reads when peek_files' LLM filtering is not desired. Output is capped at max_bytes (default 100000) to protect the chat context window. For projects with multiple workspace roots, pass an absolute path.",
  inputSchema: {
    path: z
      .string()
      .describe(
        'File path. Relative paths are joined to the primary workspace root; absolute paths must fall under the primary or any extra workspace root.',
      ),
    max_bytes: z
      .number()
      .optional()
      .describe('Optional cap on returned bytes. Defaults to 100000.'),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async (
    { path: subPath, max_bytes },
    _deps,
    { group_folder, memoryExecution },
  ) => {
    const limit =
      typeof max_bytes === 'number' && max_bytes > 0 ? max_bytes : 100000;

    let resolved;
    try {
      const scoped = dependenciesFromToolContext(_deps).prepareScopedSandbox;
      resolved = await (scoped ?? prepareScopedSandbox)(
        group_folder,
        memoryExecution?.filesystem,
      );
    } catch (err: any) {
      return `Error preparing sandbox: ${err.message}`;
    }

    let fullPath: string;
    try {
      fullPath = resolveSandboxPath(
        { primary: resolved.workspaceRoot, extra: resolved.extraRoots },
        subPath,
      );
    } catch (err: any) {
      return `Error: ${err.message}`;
    }

    const cmd = `fs-tool.sh read-file ${shellQuote(fullPath)}`;
    let execResult;
    try {
      const client = getSandboxClient();
      execResult = await client.sandboxExec(
        resolved.stack,
        resolved.service,
        cmd,
        { instance: resolved.instance, timeout: FILE_READ_TIMEOUT_S },
      );
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }

    const stdout = normalizeFsToolStdout(execResult.stdout).trim();
    if (execResult.isError) {
      return `Error reading file: ${stdout}`;
    }
    if (stdout === NOT_FOUND_SENTINEL) {
      return `Error: File not found: ${subPath}`;
    }

    let content: string;
    try {
      content = Buffer.from(stdout, 'base64').toString('utf-8');
    } catch (err: any) {
      return `Error decoding file content: ${err.message}`;
    }

    if (content.length > limit) {
      return (
        content.slice(0, limit) +
        `\n... [Truncated ${content.length - limit} bytes; pass max_bytes to extend]`
      );
    }
    return content;
  },
};
