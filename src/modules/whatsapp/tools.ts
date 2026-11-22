import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import { hasPermission } from '../../mcp/auth.js';

export const registerGroupTool: ToolDefinition = {
  name: 'register_group',
  description:
    'Register a new WhatsApp group so the agent can respond to messages there. Main group only.',
  inputSchema: {
    jid: z
      .string()
      .describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name (lowercase, hyphens)'),
    trigger: z.string().describe('Trigger word (e.g., "@Capa")'),
  },
  requiredPermissions: ['groups:write'],
  mainOnly: true,
  handler: async ({ jid, name, folder, trigger }, deps, context) => {
    // Primary gate 'groups:write' is already checked in index.ts.
    // We still verify if this is specifically the main orchestrator (wildcard permission).
    if (!hasPermission(context.permissions, '*', '*:*')) {
      throw new Error('Only the main orchestrator can register new groups.');
    }

    const existingGroups = deps.getRegisteredGroups();
    const existing = existingGroups[jid];

    await deps.registerGroup(jid, {
      ...(existing || {}),
      name,
      folder,
      trigger,
      added_at: existing?.added_at || new Date().toISOString(),
      settings: existing?.settings || {},
    });

    return `Group "${name}" registered.`;
  },
};
