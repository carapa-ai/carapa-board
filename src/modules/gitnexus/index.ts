/**
 * GitNexus module — code intelligence integration via the GitNexus Hub.
 *
 * On boot, fetches dynamic tool definitions from the Hub and populates
 * TOOLSET_MODULES.gitnexus so per-group toolsets can include them.
 *
 * Resources are registered per-server in mcp-server.ts since registration
 * is gated by per-group active toolsets, not just module-level enable.
 */

import type { CarapaModule } from '../types.js';
import { ENABLE_GITNEXUS } from '../../config.js';
import { initGitNexusTools } from './tools.js';

const gitnexusModule: CarapaModule = {
  name: 'gitnexus',

  isEnabled() {
    return ENABLE_GITNEXUS;
  },

  async init() {
    await initGitNexusTools();
  },

  getConfigFlags() {
    return { enableGitNexus: true };
  },
};

export default gitnexusModule;
