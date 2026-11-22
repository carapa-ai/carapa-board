import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import {
  getTranscriptSummary,
  listTranscripts,
  showTranscript,
  searchTranscripts,
  getGroups,
} from './logic.js';
import { hasPermission } from '../../mcp/auth.js';

/**
 * Returns the list of groups the caller is permitted to read transcripts from.
 * Returns undefined (no filter) when the caller has wildcard access.
 */
function getPermittedGroups(
  permissions?: Record<string, string[]>,
): string[] | undefined {
  if (!permissions) return [];
  // Wildcard means all groups allowed — no filtering needed
  if (hasPermission(permissions, '*', 'fs:read')) return undefined;
  return getGroups().filter((g) => hasPermission(permissions, g, 'fs:read'));
}

export const searchTranscriptsTool: ToolDefinition = {
  name: 'search_transcripts',
  description:
    'Search for a keyword across all group conversation transcripts. ALWAYS use this instead of ripgrep for searching conversation logs.',
  inputSchema: {
    query: z.string().describe('The keyword or pattern to search for'),
    group: z.string().optional().describe('Filter to a specific group'),
    full: z
      .boolean()
      .optional()
      .describe('Show full message content (default: false)'),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async ({ query, group, full }, _deps, context) => {
    if (group) {
      if (!hasPermission(context.permissions, group, 'fs:read')) {
        return `Unauthorized: no access to transcripts for group "${group}"`;
      }
      return searchTranscripts(query, group, full);
    }
    // No group filter — restrict to permitted groups
    const allowed = getPermittedGroups(context.permissions);
    return searchTranscripts(query, undefined, full, allowed);
  },
};

export const listTranscriptsTool: ToolDefinition = {
  name: 'list_transcripts',
  description:
    'List all available transcripts for a specific group. Use this to find conversation logs instead of generic file listing.',
  inputSchema: {
    group: z.string().describe('The group name to list transcripts for'),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async ({ group }, _deps, context) => {
    if (!hasPermission(context.permissions, group, 'fs:read')) {
      return `Unauthorized: no access to transcripts for group "${group}"`;
    }
    return listTranscripts(group);
  },
};

export const getTranscriptTool: ToolDefinition = {
  name: 'get_transcript',
  description:
    'Show messages from a specific transcript. Defaults to the most recent one if no task_id is provided. Use this to read conversation history instead of peek_files or cat.',
  inputSchema: {
    group: z.string().describe('The group name'),
    task_id: z
      .string()
      .optional()
      .describe('Optional Task ID or partial match'),
    last: z.number().optional().describe('Show only the last N messages'),
    full: z
      .boolean()
      .optional()
      .describe('Show full message content (default: false)'),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async ({ group, task_id, last, full }, _deps, context) => {
    if (!hasPermission(context.permissions, group, 'fs:read')) {
      return `Unauthorized: no access to transcripts for group "${group}"`;
    }
    return showTranscript(group, task_id, last, full);
  },
};

export const summarizeTranscriptsTool: ToolDefinition = {
  name: 'summarize_transcripts',
  description:
    'Get an overview of transcript activity across all groups or a specific one. Use this for discovery of recent agent activity.',
  inputSchema: {
    group: z.string().optional().describe('Filter to a specific group'),
  },
  requiredPermissions: ['fs:read'],
  mcpExempt: true,
  handler: async ({ group }, _deps, context) => {
    if (group) {
      if (!hasPermission(context.permissions, group, 'fs:read')) {
        return `Unauthorized: no access to transcripts for group "${group}"`;
      }
      return getTranscriptSummary(group);
    }
    // No group filter — restrict to permitted groups
    const allowed = getPermittedGroups(context.permissions);
    return getTranscriptSummary(undefined, allowed);
  },
};
