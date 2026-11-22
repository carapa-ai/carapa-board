/**
 * Kanban module — task cards, stages, and the execution pipeline.
 *
 * Currently this is a thin module wrapper that contributes the `enableKanban`
 * config flag. The kanban subsystem itself is large (router, MCP tools, executor,
 * scheduler integration) and stays where it is; the wrapper exists so kanban
 * is registered alongside other modules and the UI can react to ENABLE_KANBAN.
 *
 * Tools are registered via `TOOLSET_MODULES.kanban` in `../tools/registry.ts`
 * (per-group active-toolsets path). The HTTP router is mounted from
 * `src/http-service.ts` (gated by ENABLE_KANBAN). Bootstrap calls
 * (`setGroupResolver`, `drainProjectQueue`, `resumeActiveDatasetTasks`) live in
 * `src/index.ts` after sandboxes are ready (timing dependency cannot be
 * satisfied from `init()`, which runs before `ensureGroupSandboxes()`).
 */

import type { CarapaModule } from '../types.js';
import { ENABLE_KANBAN } from '../../config.js';

const kanbanModule: CarapaModule = {
  name: 'kanban',

  isEnabled() {
    return ENABLE_KANBAN;
  },

  getConfigFlags() {
    return { enableKanban: true };
  },
};

export default kanbanModule;
