/**
 * FS module — sandbox-bound filesystem agent tools (read_file, ripgrep, peek, ...).
 *
 * Tools are registered via `TOOLSET_MODULES.fs` in `../tools/registry.ts`
 * (per-group active-toolsets path). This wrapper exists so fs is registered
 * alongside other modules and the UI can react to ENABLE_FS_TOOLS.
 */

import type { CarapaModule } from '../types.js';
import { ENABLE_FS_TOOLS } from '../../config.js';

const fsModule: CarapaModule = {
  name: 'fs',

  isEnabled() {
    return ENABLE_FS_TOOLS;
  },

  getConfigFlags() {
    return { enableFsTools: true };
  },
};

export default fsModule;
