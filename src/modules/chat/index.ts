/**
 * Chat module — chat conversations, scheduled-task loop, and direct-LLM helpers.
 *
 * Currently a thin module wrapper that contributes the `enableChat` config flag.
 * The chat subsystem itself is large (chat router, conversations, scheduler)
 * and stays where it is; the wrapper exists so chat is registered alongside
 * other modules and the UI can react to ENABLE_CHAT.
 *
 * Tools are registered via `TOOLSET_MODULES` in `../tools/registry.ts`. The
 * scheduler loop is started from `src/index.ts` (gated by ENABLE_CHAT) because
 * it needs sendMessage / registeredGroups / sessions callbacks that aren't
 * available to a `CarapaModule.init()` (which takes no deps).
 *
 * Sub-folders:
 * - `scheduling/` — scheduled-task loop, types, MCP tools
 *
 * Sibling modules that chat reads from (not nested):
 * - `transcripts/` — task transcript storage (also used by kanban, whatsapp)
 * - `memory/` — memorize/recall (also used by kanban git-ops)
 */

import type { CarapaModule } from '../types.js';
import { ENABLE_CHAT } from '../../config.js';

const chatModule: CarapaModule = {
  name: 'chat',

  isEnabled() {
    return ENABLE_CHAT;
  },

  getConfigFlags() {
    return { enableChat: true };
  },
};

export default chatModule;
