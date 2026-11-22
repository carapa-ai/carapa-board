import fs from 'fs';
import path from 'path';
import {
  PROMPTS_DIR,
  DEFAULT_SYSTEM_PROMPT_PATH,
  GROUPS_DIR,
  PROJECT_ROOT,
} from './config.js';
import { logger } from './logger.js';
import {
  GroupFsError,
  openDirAtSync,
  openParentDirSync,
  readdirAtSync,
  readFileAtSync,
  type PinnedDir,
} from './lib/group-fs.js';
import {
  ContainedFileError,
  readContainedFileSync,
} from './lib/read-contained-file.js';
import {
  getUserById,
  getUserPreferences,
  getMemberPreferences,
} from './modules/knowledge/db-kb.js';

const systemPromptCache = new Map<
  string,
  { value: string | undefined; ts: number }
>();
const SYSTEM_PROMPT_TTL = 60_000; // 1 minute — see PROMPT_HELPER_TTL rationale
const chatModePromptCache = new Map<
  string,
  { value: string | undefined; ts: number }
>();
const CHAT_MODE_PROMPT_TTL = 60_000;

/**
 * Generic TTL cache used by the prompt-assembly helpers below. Each cache
 * entry stores the resolved string and a timestamp; entries older
 * than the TTL are recomputed on the next call.
 *
 * The 60-second TTL matches `FULL_PROMPT_TTL` and the toolset-prompt
 * TTL in `system-prompt-builder.ts` / `modules/tools/registry.ts`.
 * The board is not a high-concurrency system — a user rarely sends two
 * messages within 5 s, so a 5 s TTL would just force a file/DB re-read
 * on every consecutive turn without buying anything. 60 s is long
 * enough to absorb a normal back-and-forth exchange and short enough
 * that an in-place edit to a project file is picked up on the next
 * turn (worst case 1 min staleness).
 *
 * Cache hit rate is reported as a log line on every 64th insertion, so a
 * stuck-cache bug surfaces in the board logs without spamming INFO on
 * every cache hit.
 */
const PROMPT_HELPER_TTL = 60_000;
interface TtlEntry<T> {
  value: T;
  ts: number;
}
const agentRulesCache = new Map<string, TtlEntry<string>>();
const userPreferencesCache = new Map<string, TtlEntry<string>>();
let promptHelperInserts = 0;

function readTtlCache<T>(
  cache: Map<string, TtlEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < PROMPT_HELPER_TTL) return entry.value;
  return undefined;
}

function writeTtlCache<T>(
  cache: Map<string, TtlEntry<T>>,
  key: string,
  value: T,
): void {
  cache.set(key, { value, ts: Date.now() });
  promptHelperInserts += 1;
  if (promptHelperInserts % 64 === 0) {
    logger.debug(
      {
        agentRulesSize: agentRulesCache.size,
        userPrefsSize: userPreferencesCache.size,
      },
      'Prompt-helper TTL cache size (every 64th insert)',
    );
  }
}

const chatModeInvalidationListeners: Array<(group_folder: string) => void> = [];

/**
 * Let a module that caches prompts assembled from chat-mode text (the full
 * prompt cache in `system-prompt-builder.ts`, which imports this module)
 * drop them when a chat-mode file changes.
 */
export function onChatModePromptInvalidated(
  listener: (group_folder: string) => void,
): void {
  chatModeInvalidationListeners.push(listener);
}

/** Drop the cached chat-mode prompt for one mode after its file changed. */
export function invalidateChatModePrompt(
  group_folder: string,
  parentId: string | undefined,
  modeId: string,
): void {
  chatModePromptCache.delete(`${parentId ?? ''}:${group_folder}:${modeId}`);
  for (const listener of chatModeInvalidationListeners) listener(group_folder);
}

export function clearPromptCaches(): void {
  systemPromptCache.clear();
  chatModePromptCache.clear();
  agentRulesCache.clear();
  userPreferencesCache.clear();
}

/**
 * Boundary between stable instructions and per-run system context.
 * The Anthropic adapter removes it and attaches cache_control to the prefix;
 * OpenAI-compatible paths retain it as ordinary prompt text. NInfer recognizes
 * it in leading system instructions as a structural cache boundary.
 * Reuse still requires an identical preceding prefix and a retained cache entry.
 * The marker's token cost depends on the model's tokenizer.
 */
export const CACHE_BREAKPOINT_MARKER = '\n\n=== CACHE_BREAKPOINT ===\n\n';
/** NInfer excludes this marker and the following system tail from durable cache selection. */
export const VOLATILE_CONTEXT_MARKER = '=== VOLATILE_CONTEXT ===\n\n';

/** Upper bound for a single prompt or rule file (MCP prompt limit is 100,000 chars). */
export const MAX_PROMPT_FILE_BYTES = 256 * 1024;

function warnRefused(file: string, err: unknown): void {
  if (err instanceof ContainedFileError && err.code !== 'unreadable') {
    logger.warn({ file, code: err.code }, 'Refused prompt file');
  } else if (
    err instanceof GroupFsError &&
    err.code !== 'not_found' &&
    err.code !== 'io'
  ) {
    logger.warn({ file, code: err.code }, 'Refused prompt file');
  }
}

/**
 * Throws unless the group home resolves to its lexical location under
 * GROUPS_DIR, i.e. an agent with write access to a shared parent did not swap
 * the home directory for a symlink. A missing home is merely 'unreadable'.
 */
export function assertGroupHomeIntact(groupHome: string): void {
  let realHome: string;
  let expected: string;
  try {
    realHome = fs.realpathSync(groupHome);
    expected = path.join(
      fs.realpathSync(GROUPS_DIR),
      path.relative(GROUPS_DIR, groupHome),
    );
  } catch {
    throw new ContainedFileError('unreadable', 'Group home is unreadable');
  }
  if (realHome !== expected) {
    throw new ContainedFileError('outside_root', 'Group home was redirected');
  }
}

/**
 * Read a prompt file. With `containRoot` (agent-writable group homes) the file
 * must resolve inside that root, be a regular file, and stay under the size cap;
 * symlink escapes and FIFOs are treated as missing.
 */
function readPromptFile(
  filePath: string,
  containRoot?: string,
): string | undefined {
  try {
    if (containRoot === undefined) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
    assertGroupHomeIntact(containRoot);
    return readContainedFileSync(containRoot, filePath, MAX_PROMPT_FILE_BYTES)
      .toString('utf-8')
      .trim();
  } catch (err) {
    warnRefused(filePath, err);
    // Treat unreadable prompt files as unavailable.
  }
  return undefined;
}

function readFirstNonEmptyPrompt(
  candidates: readonly { filePath: string; containRoot?: string }[],
): string | undefined {
  for (const { filePath, containRoot } of candidates) {
    const content = readPromptFile(filePath, containRoot);
    if (content) return content;
  }
  return undefined;
}

/**
 * Load the base system prompt for a group folder.
 * Priority:
 * 1. groups/{parentId}/{folder}/.agent/prompts/system.md
 * 2. PROMPTS_DIR/{folder}.md
 * 3. prompts/default.md
 */
export function loadSystemPrompt(
  group_folder: string,
  parentId?: string,
): string | undefined {
  const cacheKey = parentId ? `${parentId}:${group_folder}` : group_folder;
  const cached = systemPromptCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SYSTEM_PROMPT_TTL) return cached.value;

  const groupHome = getGroupHomeDir(group_folder, parentId);
  const candidates = [
    // 1. Group-specific prompts dir
    {
      filePath: path.join(groupHome, '.agent', 'prompts', 'system.md'),
      containRoot: groupHome,
    },
    // 2. Project-bundled prompts
    { filePath: path.join(PROMPTS_DIR, `${group_folder}.md`) },
    // 3. Default fallback
    { filePath: DEFAULT_SYSTEM_PROMPT_PATH },
  ];

  const result = readFirstNonEmptyPrompt(candidates);
  systemPromptCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

/**
 * Load a chat-mode prompt override from groups/{parentId}/{folder}/.agent/prompts/chat-mode-{modeId}.md
 * falling back to bundled defaults at prompts/chat-modes/{modeId}.md.
 */
export function loadChatModePrompt(
  group_folder: string,
  parentId: string | undefined,
  modeId: string,
): string | undefined {
  const cacheKey = `${parentId ?? ''}:${group_folder}:${modeId}`;
  const cached = chatModePromptCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHAT_MODE_PROMPT_TTL)
    return cached.value;

  const groupHome = getGroupHomeDir(group_folder, parentId);
  const localPath = path.join(
    groupHome,
    '.agent',
    'prompts',
    `chat-mode-${modeId}.md`,
  );
  const bundledPath = path.join(PROMPTS_DIR, 'chat-modes', `${modeId}.md`);
  const result = readFirstNonEmptyPrompt([
    { filePath: localPath, containRoot: groupHome },
    { filePath: bundledPath },
  ]);

  chatModePromptCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

/**
 * Get the home directory for a group folder, accounting for parentId hierarchy.
 */
export function getGroupHomeDir(
  group_folder: string,
  parentId?: string,
): string {
  if (parentId) {
    return path.join(GROUPS_DIR, parentId, group_folder);
  }
  return path.join(GROUPS_DIR, group_folder);
}

/** Base stage id and variant suffix rules (kept in step with src/modules/kanban/stages.ts). */
const BASE_STAGE_PROMPT_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const VARIANT_PROMPT_SUFFIX_PATTERN = /^[a-z][a-z0-9]{0,7}$/;

/**
 * Load a stage-specific worker prompt from groups/{parentId}/{folder}/.agent/prompts/stage-{stageId}.md.
 * With a variant, `stage-{stageId}.{variant}.md` (a stage alternative's prompt) is preferred and
 * falls back to the base prompt. Invalid ids are rejected without reading any file.
 */
export function loadStagePrompt(
  group_folder: string,
  parentId: string | undefined,
  stageId: string,
  variant?: string | null,
): string | undefined {
  if (!BASE_STAGE_PROMPT_ID_PATTERN.test(stageId)) return undefined;
  if (variant && !VARIANT_PROMPT_SUFFIX_PATTERN.test(variant)) return undefined;
  const groupHome = getGroupHomeDir(group_folder, parentId);
  const promptsDir = path.join(groupHome, '.agent', 'prompts');
  if (variant) {
    const variantPrompt = readPromptFile(
      path.join(promptsDir, `stage-${stageId}.${variant}.md`),
      groupHome,
    );
    if (variantPrompt) return variantPrompt;
  }
  return readPromptFile(
    path.join(promptsDir, `stage-${stageId}.md`),
    groupHome,
  );
}

/**
 * Load the default worker prompt for a group from groups/{parentId}/{folder}/.agent/prompts/worker.md
 */
export function loadGroupWorkerPrompt(
  group_folder: string,
  parentId: string | undefined,
): string | undefined {
  const groupHome = getGroupHomeDir(group_folder, parentId);
  const filePath = path.join(groupHome, '.agent', 'prompts', 'worker.md');
  return readPromptFile(filePath, groupHome);
}

/** Compose shared project guidance before the instructions for one stage. */
export function composeWorkerPrompts(
  projectPrompt: string | undefined,
  stagePrompt: string | undefined,
): string | undefined {
  const parts = [projectPrompt?.trim(), stagePrompt?.trim()].filter(
    (part): part is string => !!part,
  );
  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Lightweight front matter parser.
 */
function parseFrontMatter(content: string): {
  frontMatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontMatter: {}, body: content };

  const yaml = match[1];
  const body = match[2];
  const frontMatter: Record<string, string> = {};

  yaml.split('\n').forEach((line) => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      frontMatter[key.trim()] = rest
        .join(':')
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  });

  return { frontMatter, body };
}

/**
 * Load agent rules from .agent/rules/*.md in the specified base directory.
 *
 * `sandboxBaseDir` renders file references for a harness instead of Board's
 * filesystem and uses generic file-reading guidance instead of `peek_files`.
 * Cached per source directory and rendered path for `PROMPT_HELPER_TTL`;
 * for the duration of a single chat turn the result is reused
 * across multiple `loadAgentRules` calls (chat path + sandbox path both
 * call this). See `PROMPT_HELPER_TTL` for the trade-off rationale.
 */
export function loadAgentRules(
  baseDir: string,
  sandboxBaseDir?: string,
): string {
  const cacheKey = JSON.stringify([baseDir, sandboxBaseDir]);
  const cached = readTtlCache(agentRulesCache, cacheKey);
  if (cached !== undefined) return cached;

  const contextPath = (file: string) =>
    sandboxBaseDir
      ? path.posix.join(sandboxBaseDir, path.relative(baseDir, file))
      : path.relative(PROJECT_ROOT, file);
  const rulesDir = path.join(baseDir, '.agent', 'rules');
  let result = '';

  // Pin .agent/rules once and list and read it through that descriptor: the
  // folder is agent-writable, so a path swapped after the check must not win.
  // Links inside the base (legacy .agent -> .claude) are followed; the rules
  // directory and every rule file are not.
  let rules: PinnedDir | null = null;
  try {
    const parent = openParentDirSync(rulesDir, { followInternalLinks: true });
    if (parent) {
      try {
        rules = openDirAtSync(parent.dir, parent.name);
      } finally {
        parent.dir.closeSync();
      }
    }
    if (rules) {
      const files = (readdirAtSync(rules) ?? [])
        .filter((f) => f.endsWith('.md'))
        .sort();
      let combined = '';
      let discoverySection = '';

      for (const file of files) {
        const fullPath = path.join(rulesDir, file);
        let content: string;
        try {
          const read = readFileAtSync(rules, file, {
            maxBytes: MAX_PROMPT_FILE_BYTES,
          });
          if (!read) continue;
          content = read.data.toString('utf-8').trim();
        } catch (err) {
          warnRefused(fullPath, err);
          continue;
        }
        if (!content) continue;

        const { frontMatter, body } = parseFrontMatter(content);
        const trigger = frontMatter.trigger || 'model_decision';
        const description =
          frontMatter.description || 'No description provided.';
        const rulePath = contextPath(fullPath);

        if (trigger === 'always_on') {
          combined += `\n\n### Rule: ${file}\n${body}`;
        } else {
          discoverySection += `\n- **${file}**: ${description} (Path: ${rulePath})`;
        }
      }

      if (combined) {
        result += `\n\n## Active Agent Rules\n${combined}`;
      }
      if (discoverySection) {
        const reader = sandboxBaseDir
          ? 'your file-reading tools'
          : 'the `peek_files` tool';
        result += `\n\n## Available Rules (Peek if needed)\nUse ${reader} to read these rules if they are relevant to your task:\n${discoverySection}`;
      }
    }
  } catch (err) {
    logger.warn({ err, rulesDir }, 'Failed to load agent rules');
  } finally {
    rules?.closeSync();
  }

  writeTtlCache(agentRulesCache, cacheKey, result);
  return result;
}

/**
 * Resolve the authenticated human context for a `(user, project)` pair.
 * The structured identity is always present for a known account. Project-scoped
 * preferences fully override account preferences when present.
 */
export async function loadPreferencesCascade(
  user_id: string | undefined | null,
  project_id: string | undefined | null,
): Promise<string> {
  if (!user_id) return '';

  const cacheKey = `${user_id}:${project_id ?? ''}`;
  const cached = readTtlCache(userPreferencesCache, cacheKey);
  if (cached !== undefined) return cached;

  const user = await getUserById(user_id).catch((err) => {
    logger.warn({ err, user_id }, 'Failed to load authenticated user identity');
    return undefined;
  });
  if (!user) {
    writeTtlCache(userPreferencesCache, cacheKey, '');
    return '';
  }

  const displayName = user.displayName?.trim() || user.username;
  let result = [
    '## Human Participant Identity',
    `Account user ID: ${user.id}`,
    `Username (login identifier): ${user.username}`,
    `Display name: ${displayName}`,
    'Attribute human-authored turns to this account identity. The username is for authentication; use the display name when addressing the human.',
  ].join('\n');

  let memberPrefs: string | null = null;
  if (project_id) {
    try {
      memberPrefs = await getMemberPreferences(user_id, project_id);
    } catch (err) {
      logger.warn(
        { err, user_id, project_id },
        'Failed to load member preferences',
      );
    }
  }
  let effectivePreferences = memberPrefs?.trim() || '';
  if (!effectivePreferences) {
    try {
      effectivePreferences = (await getUserPreferences(user_id))?.trim() || '';
    } catch (err) {
      logger.warn({ err, user_id }, 'Failed to load user preferences');
    }
  }
  if (effectivePreferences) {
    result += `\n\n## User Preferences\n${effectivePreferences}`;
  }

  writeTtlCache(userPreferencesCache, cacheKey, result);
  return result;
}

/** Load CarapaBoard's built-in review lifecycle and response protocol. */
export function loadReviewPrompt(options?: {
  testingStagePresent?: boolean;
}): string {
  const globalReviewPath = path.join(PROMPTS_DIR, 'review.md');
  let prompt =
    readPromptFile(globalReviewPath) ??
    'You are a technical reviewer. Evaluate the changes and provide a structured JSON decision.';

  if (options?.testingStagePresent) {
    prompt += `

## Validation boundary

This pipeline has a dedicated Testing stage. Treat its current verdict and
evidence as the validation record. Do not rerun lint, typecheck, build, unit,
integration, end-to-end, or browser test commands during Review. Review the
task and code diff independently and assess whether the recorded testing
evidence is adequate. If required evidence is absent or does not cover a
material risk, report that as a review issue instead of running the checks
yourself.`;
  }

  return prompt;
}

/** Load the built-in testing lifecycle prompt. */
export function loadTestingPrompt(): string {
  return (
    readPromptFile(path.join(PROMPTS_DIR, 'testing.md')) ??
    "Run the required validation and return one JSON verdict with decision pass, fail, or blocked. Never call update_task or change the code under test; the project Testing stage prompt decides which data-changing actions are allowed in the task's isolated environment, and never mutate a shared or production environment."
  );
}
