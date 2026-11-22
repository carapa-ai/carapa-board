/**
 * System prompt assembly — single source of truth for the order in which
 * prompt segments are concatenated before the prompt is handed to an
 * LLM. Both the Direct LLM path (`runDirectLlm`) and the sandbox path
 * (`runSandboxAgent`) build the system prompt through this helper so
 * the on-the-wire order, the cacheability layout, and the
 * `CACHE_BREAKPOINT_MARKER` placement are identical across paths.
 *
 * ## Two execution modes
 *
 * The board serves two very different runtime paths, and the system
 * prompt composition differs:
 *
 * - **Direct LLM** (`forDirectLlm: true`) — the LLM is a hosted API
 *   (Anthropic, OpenAI, OpenRouter, local llama.cpp via api-relay,
 *   etc.). The board is the only thing the LLM sees, so the board
 *   must inject every piece of context the model needs:
 *
 *   [STABLE PROJECT PREFIX — per-project, per-mode]
 *     1. base system prompt         (system.md / default)
 *     2. available toolsets         (getToolsetsSystemPrompt)
 *     3. project rules              (.agent/rules/*.md in groupHome)
 *     4. shared knowledge bases     (KnowledgeService.getSharedKBs)
 *
 *   === CACHE_BREAKPOINT ===
 *
 *   === VOLATILE_CONTEXT ===       (only when the tail is nonempty)
 *
 *   [PER-CONVERSATION TAIL — varies per chat/objective]
 *     5. objective rules            (.agent/rules/*.md in objDir, when in an objective chat)
 *
 *   Toolsets and shared KBs go into the *common prefix* (not a
 *   per-config section) because in this codebase they are stable
 *   across many turns and almost never change for a given project:
 *   a project registers a toolset once, and a shared KB is added
 *   rarely. Folding them into the prefix means the Anthropic prompt
 *   cache can hit across users and turns, and the cache
 *   region is invalidated only when a project genuinely adds or
 *   removes a toolset / KB — which is a deploy-level event, not a
 *   turn-level one.
 *
 * - **Sandbox (CLI agent)** (`forDirectLlm: false`) — the board
 *   launches `claude -p` / `codex` / `opencode` / etc. in the repo
 *   folder. The CLI agent auto-discovers its own context at runtime
 *   from its CWD: `CLAUDE.md`, `.claude/rules/`, its own tool list, and
 *   `.agent/rules/*.md` (when the worktree is rooted at the right
 *   directory). **Injecting any of those from the board duplicates
 *   the CLI's own work and pollutes the cache key.** The board
 *   therefore injects only:
 *
 *   [STABLE PROJECT PREFIX]
 *     1. base system prompt         (system.md / default)
 *
 *   === CACHE_BREAKPOINT ===
 *
 *   The CACHE_BREAKPOINT after step 1 is still emitted so a qualifying
 *   stable prefix remains explicitly cacheable without depending on
 *   authenticated-human context. The sandbox path does not use the
 *   Anthropic request shape, but keeping one assembly layout avoids
 *   divergent system-prompt composition.
 *   The sandbox path does not need toolsets / KBs / project rules
 *   because the CLI auto-discovers them from its CWD.
 *
 * ## Why objective rules are in the tail, not the prefix
 *
 * Objective rules are only present in objective chats. Putting them in
 * the common prefix would cause a chat user who toggles between a
 * regular chat and an objective chat to see the common prefix
 * invalidated on every toggle. With the new order the common prefix
 * (system.md + project rules + toolsets + shared KBs) is
 * identical across both modes, so cache hit is preserved on toggle.
 * The objective rules live in the per-conversation tail which never
 * participates in the cache region.
 *
 * ## Caching
 *
 * The full assembled prompt is cached for 1 minute (60 s) under a key
 * that covers every dimension that affects the result: (group,
 * parentId, objectiveId, baseDir, chatMode, forDirectLlm).
 * Within a single chat turn (which can call this helper twice for the
 * same key) the second call is a hash lookup with no DB / file hits.
 * 1 minute (not 5 s) because the board is not high-concurrency — a
 * user rarely sends two messages within 5 s, and 60 s absorbs a normal
 * back-and-forth exchange without forcing a re-read on every turn.
 */

import {
  loadSystemPrompt,
  loadChatModePrompt,
  onChatModePromptInvalidated,
  loadAgentRules,
  clearPromptCaches,
  getGroupHomeDir,
} from './prompt-loader.js';
import { assembleCacheableSystemPrompt } from './prompt-cache.js';
import { getToolsetsSystemPrompt } from './modules/tools/registry.js';
import { KnowledgeService } from './modules/knowledge/knowledge-service.js';
import { logger } from './logger.js';
import path from 'path';
import { getConversation } from './db.js';
import {
  LIVE_ACTIVITY_AGENT_INSTRUCTION,
  LIVE_ACTIVITY_DISABLED_INSTRUCTION,
  PERSONA_LIVE_VOICE_INSTRUCTION,
} from './modules/chat/live-activity.js';

export interface SystemPromptParts {
  /** Base system prompt (system.md / default). Optional. */
  systemPrompt?: string | undefined;
  /** Project rules from .agent/rules/*.md under baseDir. Optional. */
  projectRules?: string;
  /** Direct-LLM-only: list of available toolsets. Optional. */
  toolsetInfo?: string;
  /** Direct-LLM-only: shared knowledge bases list. Optional. */
  sharedKbsInfo?: string;
  /** Objective rules from .agent/rules/*.md under objDir. Optional. */
  objectiveRules?: string;
}

/**
 * ## Where each prompt segment is loaded from
 *
 * It is critical to distinguish two filesystem roots and two runtime
 * modes:
 *
 *   1. **The group folder** = `groups/{parentId}/{folder}/` (or
 *      `groups/{folder}/` for top-level groups). This is where the
 *      board-stored assets live: `system.md`, `.agent/prompts/`,
 *      `.agent/rules/`, `.agent/reflections/`, knowledge base files,
 *      chat transcripts, etc. **All system-prompt content is loaded
 *      from the group folder.**
 *
 *   2. **The repository folder** = `group.settings.repositoryLocation`.
 *      This is a separate user-configured path that points at a Git
 *      repo. The CLI agent (`claude`, `codex`, etc.) runs in this
 *      folder; the CLI itself reads its own `CLAUDE.md` / `.claude/`
 *      from its CWD. The board does **not** inject repo-rooted content
 *      into the system prompt — the CLI does that itself. Mixing the
 *      two by reading `repositoryLocation/.agent/rules/` as part of
 *      the system prompt would (a) duplicate content the CLI will
 *      re-read on its own and (b) cause a different cache key for
 *      project rules depending on whether the repo is mounted.
 *
 *   3. **Two execution modes**, distinguished by `forDirectLlm`:
 *
 *      - **Sandbox (CLI agent) path** = `forDirectLlm: false`. The
 *        CLI (`claude`, `codex`, `opencode`, etc.) runs in CWD = repo
 *        folder. **The CLI auto-loads** `CLAUDE.md`, `.claude/rules/`,
 *        its own toolset, and any other CWD-rooted context. The
 *        board therefore injects only:
 *          - the group's `system.md` (user-curated project prompt)
 *        and skips project rules, toolsets, KBs, and objective
 *        rules. Adding them would (a) duplicate the CLI's own
 *        discovery and (b) make the cache key depend on the chat
 *        conversation's `objective_id` (which lives in the group
 *        folder, but the agent doesn't need it in CWD).
 *
 *      - **Direct LLM path** = `forDirectLlm: true`. The LLM is a
 *        hosted API. There is no CWD, no CLI to auto-discover
 *        anything. The board must inject everything the LLM needs to
 *        know:
 *          - `system.md`
 *          - `.agent/rules/*.md` from the group folder (project rules)
 *          - the toolset list (the LLM calls these via the board's
 *            MCP server, not via a CLI)
 *          - the shared knowledge-base list (the LLM uses
 *            `search_knowledge` MCP tool)
 *          - objective rules when in an objective chat
 *
 * `work_dir` (per-conversation override) is a CLI CWD concern, not
 * a system-prompt concern. The previous code conflated the two by
 * deriving `baseDir = work_dir || repositoryLocation || group_folder`
 * and reading `.agent/rules/` from it for the system prompt — that
 * was a bug regardless of cache concerns. This builder always reads
 * the group folder.
 */
export interface BuildSystemPromptOptions {
  group_folder: string;
  parentId?: string;
  /** Conversation ID — when set, the objective rules (if any) are loaded. */
  conversation_id?: string;
  /**
   * Reserved for future use — currently ignored. The system prompt
   * always reads from the group folder. Kept in the signature so
   * callers that previously passed `baseDir` continue to compile;
   * the value is included in the cache key so two callers passing
   * different values do not share a stale entry.
   *
   * @deprecated Read the comment on the interface; the value is
   *   currently ignored. Will be removed once the codebase has
   *   migrated off the old `baseDir` chain.
   */
  baseDir?: string;
  /** chat-mode override id. */
  chat_mode?: string | null;
  /**
   * **True for the Direct LLM path, false for the CLI sandbox path.**
   * When true, the builder injects:
   *   - project rules (`.agent/rules/*.md` from the group folder)
   *   - toolset list (`getToolsetsSystemPrompt`)
   *   - shared knowledge-base list
   *   - objective rules (when in an objective chat)
   * When false, the builder injects only `system.md` because the CLI
   * auto-loads the rest from its CWD.
   */
  forDirectLlm?: boolean;
  liveMode?: boolean;
  /**
   * Persona Live Mode (`personas` kind): the turn's reply is spoken aloud, so
   * the prompt carries the spoken-reply instruction instead of the
   * "LIVE MODE IS OFF" notice. Mutually exclusive with `liveMode`.
   */
  personaVoice?: boolean;
}

// 1 minute. The board is not a high-concurrency system — a user
// rarely sends two messages within 5 s, so 5 s buys nothing and just
// forces a file/DB re-read on every consecutive turn. 60 s is long
// enough to absorb a normal back-and-forth exchange and short enough
// that an in-place edit to a project file is picked up on the next
// turn (worst case 1 min staleness). Applies to the full-prompt
// cache, the per-component helper caches, and the toolset prompt.
const FULL_PROMPT_TTL = 60_000;
const FULL_PROMPT_CACHE_MAX_ENTRIES = 500;
const fullPromptCache = new Map<
  string,
  { value: string; ts: number; group: string }
>();
let fullPromptCacheInserts = 0;

function readFullPromptCache(key: string): string | undefined {
  const entry = fullPromptCache.get(key);
  if (entry && Date.now() - entry.ts < FULL_PROMPT_TTL) return entry.value;
  if (entry) fullPromptCache.delete(key);
  return undefined;
}

function writeFullPromptCache(key: string, value: string, group: string): void {
  const now = Date.now();
  for (const [cachedKey, entry] of fullPromptCache) {
    if (now - entry.ts >= FULL_PROMPT_TTL) fullPromptCache.delete(cachedKey);
  }
  // Reinsertion puts a concurrently rebuilt key at the newest position.
  fullPromptCache.delete(key);
  fullPromptCache.set(key, { value, ts: now, group });
  while (fullPromptCache.size > FULL_PROMPT_CACHE_MAX_ENTRIES) {
    fullPromptCache.delete(fullPromptCache.keys().next().value!);
  }
  fullPromptCacheInserts += 1;
  if (fullPromptCacheInserts % 64 === 0) {
    logger.debug(
      { size: fullPromptCache.size },
      'Full-prompt cache size (every 64th insert)',
    );
  }
}

export function invalidateGroupFullPromptCache(group: string): void {
  for (const [key, entry] of fullPromptCache) {
    if (entry.group === group) fullPromptCache.delete(key);
  }
}

onChatModePromptInvalidated(invalidateGroupFullPromptCache);

export function invalidatePromptContextCaches(): void {
  clearPromptCaches();
  fullPromptCache.clear();
}

/**
 * Build the per-turn user-facing assembly of the system prompt parts.
 * Does NOT do any I/O — the caller passes already-loaded strings. Used by
 * callers that want to share the loading cache (TTL-cached helpers in
 * `prompt-loader.ts`) but want to apply their own ordering. The
 * `buildSystemPrompt` high-level helper is the right entry point for
 * most callers.
 */
export function assembleSystemPrompt(parts: SystemPromptParts): string {
  // Stable project prefix (common across all turns, all users, all
  // conversations on the same project). Toolsets + KBs go HERE
  // (not in their own per-config section) because they are stable
  // across many projects and almost never change for a given project
  // — folding them into the prefix maximises the Anthropic prompt
  // cache region.
  let prefix = '';
  if (parts.systemPrompt) prefix += parts.systemPrompt;
  if (parts.projectRules) prefix += parts.projectRules;
  if (parts.toolsetInfo) prefix += parts.toolsetInfo;
  if (parts.sharedKbsInfo) prefix += parts.sharedKbsInfo;

  // Objective rules vary per conversation. The volatile cutoff excludes them
  // from NInfer durable caching, including any markers quoted in those rules.
  let tail = '';
  if (parts.objectiveRules) tail += parts.objectiveRules;

  // Emit the single cache-breakpoint marker between the project
  // prefix and the variable tail. The Anthropic prompt cache
  // anchors at this byte offset: everything before is the common
  // prefix (cacheable across users and turns). The per-conversation
  // tail follows an explicit NInfer volatility cutoff. It remains visible
  // to the model while being excluded from the durable stable prefix.
  return assembleCacheableSystemPrompt(prefix, tail);
}

/**
 * Build the full system prompt for a (group, conversation, mode) tuple.
 * Loads each segment from its source (file / DB / in-memory) and assembles
 * them with `CACHE_BREAKPOINT_MARKER` separators at the boundaries that
 * `runDirectLlm` keys on. The result is cached for one minute per full key.
 *
 * `forDirectLlm` selects between the two execution modes described on
 * the `BuildSystemPromptOptions` interface. When false (CLI sandbox
 * path) only `system.md` is injected; everything
 * else is left to the CLI to discover at runtime.
 */
export async function buildSystemPrompt(
  opts: BuildSystemPromptOptions,
): Promise<string> {
  const isDirectLlm = !!opts.forDirectLlm;
  const cacheKey = JSON.stringify({
    group: opts.group_folder,
    parent: opts.parentId ?? null,
    conv: opts.conversation_id ?? null,
    base: opts.baseDir ?? null,
    mode: opts.chat_mode ?? null,
    directLlm: isDirectLlm,
    liveMode: !!opts.liveMode,
    personaVoice: !!opts.personaVoice,
  });
  const cached = readFullPromptCache(cacheKey);
  if (cached !== undefined) return cached;

  // 1. Base system prompt — always from the group folder.
  // Loaded for both paths: the CLI uses it as a "user-curated project
  // prompt" prefix, and the Direct LLM path uses it the same way.
  const systemPrompt = opts.chat_mode
    ? loadChatModePrompt(opts.group_folder, opts.parentId, opts.chat_mode) ||
      'You are a helpful assistant.'
    : loadSystemPrompt(opts.group_folder, opts.parentId) ||
      'You are a helpful assistant.';

  // Resolve the group home once — used by both project rules and
  // objective rules. The path is the same for both; only the suffix
  // (`/objectives/{oid}/`) differs.
  const groupHome = getGroupHomeDir(opts.group_folder, opts.parentId);

  // 2. Project rules — Direct LLM path ONLY.
  // The CLI agent reads its own rules (CLAUDE.md, .claude/rules/) from
  // its CWD at runtime, so the board must not duplicate them in the
  // system prompt. The Direct LLM path has no CWD, so the board must
  // inject them.
  const projectRules = isDirectLlm ? loadAgentRules(groupHome) : '';

  // 3-4. Per-config section: toolsets + shared KBs — Direct LLM path
  // ONLY. The CLI has its own toolset auto-discovery (claude-code lists
  // its own tools) and the board doesn't synthesize a tool list for
  // it. Knowledge bases are surfaced through the same MCP tools either
  // way, but the LLM path needs the explicit list so it knows which KBs
  // exist before searching.
  let sharedKbsInfo = '';
  if (isDirectLlm) {
    try {
      const sharedKbs = await KnowledgeService.getSharedKBs(opts.group_folder);
      if (sharedKbs && sharedKbs.length > 0) {
        let kbBlock =
          '\n\n=== SHARED KNOWLEDGE BASES ===\nThe following shared knowledge bases are available for this project. You can use search_knowledge and save_to_knowledge with these:\n';
        for (const kb of sharedKbs) {
          kbBlock += `- ID: "${kb.id}", Name: "${kb.name}"${kb.description ? `, Description: "${kb.description}"` : ''}\n`;
        }
        kbBlock += `\nUse the specific KB ID or Name when interacting with the knowledge tools.\n`;
        sharedKbsInfo = kbBlock;
      }
    } catch (err) {
      logger.error(
        { err, folder: opts.group_folder },
        'Failed to fetch shared knowledge bases for system prompt context',
      );
    }
  }

  // 5. Objective rules — Direct LLM path ONLY. Objective rules live
  // under `groups/{folder}/objectives/{oid}/.agent/rules/` and are
  // project-specific to the objective. The CLI auto-loads them from
  // its CWD when the CWD is set to the objective folder (which the
  // sandbox path does); the Direct LLM path has no CWD, so the board
  // must inject them. Loaded LAST so the common prefix (steps 1-2) is
  // identical across regular and objective chats, preserving cache hit
  // on toggle.
  let objectiveRules = '';
  if (isDirectLlm && opts.conversation_id) {
    try {
      const conv = await getConversation(opts.conversation_id);
      if (conv?.objective_id) {
        const objDir = path.join(groupHome, 'objectives', conv.objective_id);
        objectiveRules = loadAgentRules(objDir);
      }
    } catch (err) {
      logger.warn(
        { err, conversation_id: opts.conversation_id },
        'Failed to load objective conversation for system prompt',
      );
    }
  }

  // Read after asynchronous context loading so an overlapping toolset change
  // cannot repopulate the cache with the old list after invalidation.
  const toolsetInfo = isDirectLlm
    ? getToolsetsSystemPrompt(opts.group_folder)
    : '';
  const result = assembleSystemPrompt({
    // Marker production is explicitly scoped to opted-in Live Mode runs.
    // Persona Live Mode voices the full reply instead, so persona turns get
    // the spoken-reply instruction rather than the "LIVE MODE IS OFF" text.
    systemPrompt: `${systemPrompt}${opts.liveMode ? LIVE_ACTIVITY_AGENT_INSTRUCTION : opts.personaVoice ? PERSONA_LIVE_VOICE_INSTRUCTION : LIVE_ACTIVITY_DISABLED_INSTRUCTION}`,
    toolsetInfo,
    projectRules,
    sharedKbsInfo,
    objectiveRules,
  });
  writeFullPromptCache(cacheKey, result, opts.group_folder);
  return result;
}
