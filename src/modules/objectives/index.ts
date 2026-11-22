/**
 * Objectives module — optional SMART goals with CarapaBrain integration.
 *
 * When enabled, registers objective MCP tools and the objectives REST router.
 * When disabled, objective endpoints return 404 and tools are not registered.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CarapaModule } from '../types.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import { ENABLE_OBJECTIVES } from '../../config.js';
import { registerObjectiveTools } from './tools.js';
import objectivesRouter from '../../routes/objectives.js';

const objectivesModule: CarapaModule = {
  name: 'objectives',

  isEnabled() {
    return ENABLE_OBJECTIVES;
  },

  registerTools(server: McpServer, deps: McpServerDeps, scope?: any) {
    registerObjectiveTools(server, deps, scope);
  },

  getRouter() {
    return objectivesRouter;
  },

  getConfigFlags() {
    return { enableObjectives: true };
  },
};

export default objectivesModule;
