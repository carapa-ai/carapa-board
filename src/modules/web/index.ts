// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

import type { CarapaModule } from '../types.js';
import * as tools from './tools.js';
import { registerTools } from '../tools/registry.js';

const webModule: CarapaModule = {
  name: 'web',

  isEnabled() {
    // Web tools are enabled by default if the dependencies are met
    return true;
  },

  async init() {
    // Register the tools in the central registry
    registerTools('web', tools);
  },

  getConfigFlags() {
    return { enableWebTools: true };
  },
};

export default webModule;
