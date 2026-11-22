import { ToolDefinition } from './types.js';
import { getGroupByFolder } from '../../state-manager.js';
import { getProjectPrivacyMode } from '../../lib/privacy-policy.js';
import { ENABLE_GITNEXUS, ENABLE_KANBAN, ENABLE_MEMORY } from '../../config.js';
import { invalidateGroupFullPromptCache } from '../../system-prompt-builder.js';

// Import toolsets
import * as core from './core-tools.js';
import * as proposals from '../proposals/tools.js';
import * as fs from '../fs/tools.js';
import * as transcripts from '../transcripts/tools.js';
import * as kanban from '../kanban/tools.js';
import * as scheduling from '../chat/scheduling/tools.js';
import * as memory from '../memory/tools.js';
import * as push from './push-tools.js';
import * as images from '../image-generation/tools.js';
import * as projectSetup from '../project-setup/tools.js';
import * as providerUsage from '../provider-usage/tools.js';
import * as buildInfo from '../build-info/tools.js';
import * as agentAsks from '../agent-asks/tools.js';
// web tools are registered dynamically by the module

/**
 * Global state for active toolsets per group.
 * Defaults to 'core' only.
 */
export const activeToolsets = new Map<string, Set<string>>();

function toolDefinitionsFrom(moduleExports: object): ToolDefinition[] {
  return Object.values(moduleExports).filter(
    (value): value is ToolDefinition =>
      value !== null && typeof value === 'object' && 'name' in value,
  );
}

/**
 * Categorized tool modules.
 */
export const TOOLSET_MODULES: Record<string, ToolDefinition[]> = {
  core: [...toolDefinitionsFrom(core), ...toolDefinitionsFrom(proposals)],
  fs: toolDefinitionsFrom(fs),
  transcripts: toolDefinitionsFrom(transcripts),
  kanban: toolDefinitionsFrom(kanban),
  scheduling: toolDefinitionsFrom(scheduling),
  memory: toolDefinitionsFrom(memory),
  push: toolDefinitionsFrom(push),
  images: toolDefinitionsFrom(images),
  project_setup: toolDefinitionsFrom(projectSetup),
  provider_usage: toolDefinitionsFrom(providerUsage),
  build_info: toolDefinitionsFrom(buildInfo),
  agent_asks: toolDefinitionsFrom(agentAsks),
  web: [], // Populated dynamically by web module
  gitnexus: [], // Populated dynamically if enabled
  knowledge: [], // Populated dynamically by knowledge module
  mail: [], // Populated dynamically from carapa-mail when carapaMailEnabled
};

/** Toolsets enabled for every group before project-specific exclusions. */
export function getDefaultToolsets(): string[] {
  const defaults = [
    'core',
    'fs',
    'transcripts',
    'scheduling',
    'web',
    'push',
    'images',
    'project_setup',
    'provider_usage',
    'build_info',
    'agent_asks',
  ];
  if (ENABLE_GITNEXUS) defaults.push('gitnexus');
  if (ENABLE_KANBAN) defaults.push('kanban');
  if (ENABLE_MEMORY) defaults.push('memory', 'knowledge');
  return defaults;
}

/** Toolsets that may be displayed in project settings. Mail has its own gate. */
export function getConfigurableToolsets(): string[] {
  return Object.keys(TOOLSET_MODULES).filter((name) => name !== 'mail');
}

/** Resolve a persona allowlist without mutating the group's globally active toolsets. */
export function resolveAllowedPersonaTools(
  group_folder: string,
  requestedToolsets: readonly string[],
): { toolsets: string[]; toolNames: string[] } {
  const disabled = getDisabledToolsets(group_folder);
  const toolsets = [...new Set(requestedToolsets)].filter(
    (name) => name !== 'core' && !!TOOLSET_MODULES[name] && !disabled.has(name),
  );
  const tools = [
    ...(TOOLSET_MODULES.core || []).filter(
      (tool) => tool.name !== 'load_toolset',
    ),
    ...toolsets.flatMap((name) => TOOLSET_MODULES[name] || []),
  ];
  return {
    toolsets,
    toolNames: [...new Set(tools.map((tool) => tool.name))],
  };
}

/** Toolsets whose tools send content to remote services (see `privacyPurpose`). */
const STRICT_PRIVACY_DISABLED_TOOLSETS = ['web', 'images'] as const;

export function getDisabledToolsets(group_folder: string): Set<string> {
  const configured = getGroupByFolder(group_folder)?.settings?.disabledToolsets;
  const disabled = new Set(
    (Array.isArray(configured) ? configured : []).filter(
      (name) => name !== 'core' && name !== 'mail',
    ),
  );
  if (getProjectPrivacyMode(group_folder) === 'strict') {
    for (const name of STRICT_PRIVACY_DISABLED_TOOLSETS) disabled.add(name);
  }
  return disabled;
}

export function getActiveToolsets(group_folder: string): string[] {
  const group = getGroupByFolder(group_folder);
  const settings = group?.settings;

  // Project settings subtract from the global baseline. Runtime load_toolset
  // calls may add capabilities, but cannot override an explicit project block.
  const disabled = getDisabledToolsets(group_folder);
  const sets = activeToolsets.get(group_folder);
  const result = [
    ...new Set([...getDefaultToolsets(), ...(sets ?? [])]),
  ].filter((name) => !disabled.has(name));

  // Central gate: the carapa-mail toolset is present iff the project enabled it,
  // regardless of which branch produced `result` or whether load_toolset added it.
  // The main agent always gets it so it can act on any mail-enabled project
  // (e.g. mail-gmail, mail-yahoo) via the per-call `project_id` parameter.
  const base = result.filter((s) => s !== 'mail');
  const mailVisible = settings?.carapaMailEnabled || !!group?.is_main;
  return mailVisible ? [...base, 'mail'] : base;
}

export function resetToolsets(group_folder: string) {
  activeToolsets.delete(group_folder);
  // Invalidate the toolset-prompt cache for this group. The next call
  // recomputes the available list from the now-empty active set.
  resetToolsetPromptCache(group_folder);
}

/** Public invalidation hook for callers that mutate `activeToolsets` directly
 * (currently only `load_toolset` in core-tools.ts). Drops every cached prompt
 * for the given group; the next `getToolsetsSystemPrompt` call rebuilds. */
export function resetToolsetPromptCache(group_folder: string): void {
  for (const key of toolsetPromptCache.keys()) {
    if (key.startsWith(`${group_folder}:`)) toolsetPromptCache.delete(key);
  }
  invalidateGroupFullPromptCache(group_folder);
}

/**
 * TTL cache for the toolset prompt. The function is called on every chat
 * turn and reports configurable toolsets that are not already active for the
 * project. The cache is keyed by that sorted available set, so the same
 * effective project configuration always returns the same string within the
 * TTL window.
 *
 * 1 minute matches the prompt-loader / system-prompt-builder TTLs.
 * Toolset membership is a deploy-level event (not turn-level), so 5 s
 * was over-eager.
 */
const toolsetPromptCache = new Map<string, { value: string; ts: number }>();
const TOOLSET_PROMPT_TTL = 60_000;

export function getToolsetsSystemPrompt(group_folder: string): string {
  const active = new Set(getActiveToolsets(group_folder));
  // Mail is capability-gated by project settings and cannot be activated via
  // load_toolset, so it must never appear in the "available to load" prompt.
  // Using the effective active set also prevents globally enabled defaults
  // from being advertised as unloaded.
  const available = getConfigurableToolsets().filter((s) => !active.has(s));

  // Cache key = sorted list of available toolsets (the available set is
  // what actually shapes the output). Group folder keeps independently
  // configured projects cache-isolated.
  const cacheKey = `${group_folder}:[${[...available].sort().join(',')}]`;
  const cached = toolsetPromptCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TOOLSET_PROMPT_TTL)
    return cached.value;

  if (available.length === 0) {
    toolsetPromptCache.set(cacheKey, { value: '', ts: Date.now() });
    return '';
  }

  const lines = available.map((s) => {
    const tools = TOOLSET_MODULES[s].map((t) => t.name).join(', ');
    return `- ${s}: ${tools}`;
  });

  const result = `\n\n## Available Toolsets\nYou can load specialized toolsets using \`load_toolset\`.
Available but not yet loaded:
${lines.join('\n')}

To use these, first call \`load_toolset(["set_name"])\`.

## Tool Usage Efficiency
- **Search**: Use \`ripgrep\` (fast) instead of \`agent_query\` (heavy) for codebase searches.
- **Read a single file**: Use \`read_file\` for the raw content of one file.
- **Exploration**: Use \`peek_files\` (fast) to summarize multiple files instead of delegating to a full agent.
- **Complex Tasks**: Reserve \`agent_query\` for complex research, multi-file edits, or tasks requiring deep reasoning.

`;
  toolsetPromptCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

/**
 * Get all available tools across all modules.
 */
export function getAllTools(): ToolDefinition[] {
  return Array.from(
    new Map(
      Object.values(TOOLSET_MODULES)
        .flat()
        .map((t) => [t.name, t]),
    ).values(),
  );
}

export function registerTools(name: string, tools: any) {
  // Module namespaces can also export factories and helpers. Only register
  // tool definitions; helpers have no schema to advertise or handler to call.
  TOOLSET_MODULES[name] = Object.entries(tools)
    .filter(
      ([, def]: [string, any]) =>
        def &&
        typeof def === 'object' &&
        def.inputSchema &&
        typeof def.handler === 'function',
    )
    .map(([toolName, def]: [string, any]) => ({
      name: toolName,
      ...def,
    }));
}
