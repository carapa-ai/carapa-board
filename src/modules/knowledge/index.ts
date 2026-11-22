import { CarapaModule } from '../types.js';
import * as tools from './tools.js';
import { registerTools } from '../tools/registry.js';
import { getKnowledgeRouter } from './routes.js';

export const knowledgeModule: CarapaModule = {
  name: 'knowledge',
  isEnabled: () => true,
  init: async () => {
    // Populate the central tool registry so these are available to both
    // DirectLLM agents and the MCP bridge.
    registerTools('knowledge', tools);
  },
  getRouter: () => getKnowledgeRouter(),
};
