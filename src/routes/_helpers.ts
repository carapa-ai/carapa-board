/**
 * Shared helpers used across kanban route modules.
 * Kept in a single internal module to avoid circular imports between route files.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getGroupByFolder } from '../state-manager.js';
import {
  adminBypassesProject,
  isOwnedByOtherUser,
} from '../lib/project-ownership.js';
import {
  getTasksByProject,
  getConversation,
  userCanAccessConversation,
  getProjectAccess,
  getUserById,
  type ProjectAccessKind,
  type ProjectAccessLevel,
} from '../db.js';
import type { StageDefinition } from '../modules/kanban/types.js';
import { getGroupStages, isActiveStage } from '../modules/kanban/stages.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { isPathInside } from '../lib/path-containment.js';
import { logger } from '../logger.js';
import {
  getDisabledSkills,
  withoutDisabledSkills,
} from '../sandbox/disabled-skills.js';
import {
  ContainedFileError,
  readContainedFile,
  writeContainedFileVerified,
} from '../lib/read-contained-file.js';
import { PROMPTS_DIR } from '../config.js';
import {
  GroupFsError,
  openGroupDir,
  readFileAt,
  removeAt,
  writeFileAt,
} from '../lib/group-fs.js';

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a safe identifier (alphanumeric, hyphens, underscores, dots).
 * Use for stack names, instance names, and other values used in filesystem paths.
 */
export function isSafeIdentifier(val: string | undefined): boolean {
  if (!val) return true; // undefined/empty is OK (callers handle missing separately)
  return /^[a-zA-Z0-9._-]{1,200}$/.test(val);
}

/** Maximum character lengths for user-supplied string fields. */
export const MAX_LEN = {
  name: 200,
  title: 500,
  description: 100_000,
  message: 100_000,
  prompt: 100_000,
  trigger: 100,
  short: 200, // model, agent_name, sandbox identifiers, etc.
  token: 2_000, // API tokens and JWTs can be long
  url: 2_000, // repository URLs can be long on self-hosted instances
  convTitle: 500,
  cron: 200,
} as const;

/**
 * Returns a 400-compatible error string if `val` is a non-empty string that
 * exceeds `max` characters, otherwise returns `null` (no error).
 */
export function lenError(
  val: unknown,
  max: number,
  field: string,
): string | null {
  if (typeof val === 'string' && val.length > max) {
    return `${field} must be at most ${max} characters`;
  }
  return null;
}

/** Validate an optional `?stage=` override for manual task execution. */
export function executionStageError(
  stages: StageDefinition[],
  requestedStage: unknown,
): string | null {
  if (requestedStage === undefined) return null;
  if (
    typeof requestedStage !== 'string' ||
    !isActiveStage(stages, requestedStage)
  ) {
    return 'stage must name an active, executable stage';
  }
  return null;
}

export function normalizeProjectAccessLevel(
  value: unknown,
): ProjectAccessLevel {
  return value === 'owner' || value === 'editor' ? value : 'viewer';
}

// ---------------------------------------------------------------------------
// Conversation access guard
// ---------------------------------------------------------------------------

export type ConversationAccessLevel = 'read' | 'write' | 'owner';

/**
 * Verify the caller may access conversation `cid` at `level` and 403 otherwise.
 * Project-level access (the `:pid` middleware in kanban.ts) is necessary but not
 * sufficient — implicit (chat-shared) users only get the conversations they were
 * added to, not every conversation under the project. Admins bypass, except
 * in a project owned by another user, where they get what a normal user gets;
 * another user's personal main admits only its registered owner.
 *
 * Returns true when the caller is allowed; when false, the response has already
 * been sent and the route should `return`.
 */
export async function requireConversationAccess(
  req: any,
  res: any,
  cid: string,
  level: ConversationAccessLevel,
): Promise<boolean> {
  if (req.authUser?.role === 'admin') {
    const conv = await getConversation(cid);
    if (!conv || !isOwnedByOtherUser(req.authUser.id, conv.group_folder)) {
      return true;
    }
  }
  if (!req.authUser?.id) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  const lvl = await userCanAccessConversation(req.authUser.id, cid);
  if (!lvl) {
    res.status(403).json({ error: 'Access denied to this conversation' });
    return false;
  }
  if (level === 'owner' && lvl !== 'owner') {
    res.status(403).json({ error: 'Conversation owner required' });
    return false;
  }
  if (level === 'write' && lvl !== 'editor' && lvl !== 'owner') {
    res
      .status(403)
      .json({ error: 'Write access to this conversation required' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Group / project access guards (for routes outside the /projects/:pid tree)
// ---------------------------------------------------------------------------

/**
 * True when the caller is an admin user. Used to gate operational routes that
 * aren't tied to a single project.
 */
export function isAdminUser(req: any): boolean {
  return req.authUser?.role === 'admin';
}

/** Sends 403 and returns false unless the caller is an admin user. */
export function denyUnlessAdmin(req: any, res: any): boolean {
  if (isAdminUser(req)) return true;
  res.status(403).json({ error: 'Admin access required' });
  return false;
}

/** Express middleware form of `denyUnlessAdmin`. */
export function requireAdmin(req: any, res: any, next: any): void {
  if (denyUnlessAdmin(req, res)) next();
}

/** Human-only routes: agent bearer tokens of every kind carry no authUser. */
export function requireSignedInUser(req: any, res: any): boolean {
  if (req.authUser?.id) return true;
  res.status(403).json({
    error:
      'This action requires a signed-in user; agent credentials are refused',
  });
  return false;
}

/** How the request authenticated, from `authCredentialKind` and its token scope. */
export type CallerKind =
  | 'human'
  | 'integration'
  | 'agent'
  | 'task-run'
  | 'oauth'
  | 'none';

/**
 * Classifies the caller. An agent token carrying `tokenScope.task_id` is a
 * `task-run`; every other agent token (including the env token each sandbox
 * receives) is `agent`.
 */
export function callerKind(req: any): CallerKind {
  if (req.authCredentialKind === 'agent')
    return req.tokenScope?.task_id ? 'task-run' : 'agent';
  const kind = req.authCredentialKind;
  if (kind === 'user') return 'human';
  if (kind === 'integration' || kind === 'oauth') return kind;
  return 'none';
}

/**
 * True for every agent bearer token, task runs included. Agent tokens must not
 * bypass the MCP update_task restrictions or act as users on these routes.
 */
export function isAgentCredential(req: any): boolean {
  const kind = callerKind(req);
  return kind === 'agent' || kind === 'task-run';
}

/**
 * True when the agent token is scoped to a task run. NOT a security boundary:
 * the HTTP layer cannot tell task runs from other agent tokens, so a caller
 * must not rely on this to grant anything (docs/SECURITY.md §16).
 */
export function isTaskRunCredential(req: any): boolean {
  return callerKind(req) === 'task-run';
}

/**
 * Middleware factory for owner-or-admin guards. Order: 401 without
 * `authUser.id`, then `opts.precheck` (which sends its own response and returns
 * false to stop), then admins pass unless `opts.adminBypass` says no, then
 * `isOwner`, else 403 `opts.denied`.
 */
export function requireOwnerOrAdmin(
  isOwner: (req: any) => Promise<boolean>,
  opts: {
    denied: string;
    precheck?: (req: any, res: any) => Promise<boolean>;
    /** Whether an admin skips `isOwner` for this request; defaults to true. */
    adminBypass?: (req: any) => boolean | Promise<boolean>;
  },
) {
  return async (req: any, res: any, next: any): Promise<any> => {
    if (!req.authUser?.id)
      return res.status(401).json({ error: 'Authentication required' });
    if (opts.precheck && !(await opts.precheck(req, res))) return;
    if (
      req.authUser.role === 'admin' &&
      (!opts.adminBypass || (await opts.adminBypass(req)))
    )
      return next();
    if (!(await isOwner(req)))
      return res.status(403).json({ error: opts.denied });
    return next();
  };
}

/**
 * True when `folder` is a per-user personal main owned by someone other than
 * `userId`. Only the owner may enter it: membership rows do not count. Use
 * `isOwnedByOtherUser` for the wider "closed to admins" rule.
 */
export function isForeignMainFor(
  userId: string | undefined,
  folder: string,
): boolean {
  const g = getGroupByFolder(folder);
  return !!g?.is_main && g.user_id !== userId;
}

const ACCESS_RANK: Record<ProjectAccessLevel, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};

/**
 * True when `access` is explicit project membership of at least `min`.
 * Implicit (chat-only) access and no access never qualify.
 */
export function explicitLevelAtLeast(
  access: ProjectAccessKind | undefined,
  min: ProjectAccessLevel,
): boolean {
  return (
    access?.kind === 'explicit' && ACCESS_RANK[access.level] >= ACCESS_RANK[min]
  );
}

/**
 * The project membership predicate for a signed-in user: admins (except in a
 * project owned by another user) pass; everyone else needs explicit membership
 * of at least `opts.min`, or any access (including implicit chat-only access
 * through a shared conversation) with `opts.implicit`. No user never passes.
 */
export async function canAccessProject(
  user: { id: string; role?: string } | undefined,
  folder: string,
  opts: { min: ProjectAccessLevel; implicit?: boolean },
): Promise<boolean> {
  if (!user) return false;
  if (adminBypassesProject(user, folder)) return true;
  const access = await getProjectAccess(user.id, folder);
  return opts.implicit
    ? access !== null
    : explicitLevelAtLeast(access, opts.min);
}

/**
 * Whether the user a dashboard path token was issued to may still read the
 * project's dashboards: the account exists, is not disabled, and holds the same
 * explicit viewer-or-higher access the dashboard-ticket route requires.
 */
export async function userCanReadProjectDashboard(
  userId: string,
  folder: string,
): Promise<boolean> {
  const user = await getUserById(userId);
  if (!user || user.disabled) return false;
  return canAccessProject(user, folder, { min: 'viewer' });
}

/**
 * Resolve whether the caller is allowed to read/write resources scoped to
 * `group_folder`. Used by routes that live outside the `/projects/:pid` tree
 * (memories, observations, sandbox) where the project-access middleware in
 * kanban.ts doesn't apply.
 *
 * Allow:
 *   - admin user, except for a project owned by another user
 *   - agent token (no `authUser`) scoped to this group
 *   - user-session caller with any project access, including implicit
 *     (chat-only) access via a shared conversation. Human access never comes
 *     from `tokenScope`: it is decided by ownership and membership.
 *
 * Routes that must not admit implicit chat-only users should use
 * `userHasExplicitGroupAccess` instead.
 */
export async function userCanAccessGroup(
  req: any,
  group_folder: string,
): Promise<boolean> {
  if (!req.authUser) return req.tokenScope?.group_folder === group_folder;
  return canAccessProject(req.authUser, group_folder, {
    min: 'viewer',
    implicit: true,
  });
}

/**
 * Like `userCanAccessGroup`, but a user-session caller must hold explicit
 * project membership (not merely implicit chat-only access through a shared
 * conversation). With `write: true`, viewers are also rejected. Admin users
 * (outside projects owned by another user) and agent tokens scoped to this group are
 * admitted as in `userCanAccessGroup`.
 */
export async function userHasExplicitGroupAccess(
  req: any,
  group_folder: string,
  opts: { write?: boolean } = {},
): Promise<boolean> {
  if (!req.authUser) return req.tokenScope?.group_folder === group_folder;
  return canAccessProject(req.authUser, group_folder, {
    min: opts.write ? 'editor' : 'viewer',
  });
}

// ---------------------------------------------------------------------------
// Dependency helpers
// ---------------------------------------------------------------------------

/**
 * Check whether all dependencies of a task are in a done stage.
 * Returns an array of unmet dependency IDs (empty if all satisfied).
 */
export async function getUnmetDependencies(task: {
  depends_on_ids?: string[];
  project_id: string;
}): Promise<string[]> {
  if (!task.depends_on_ids || task.depends_on_ids.length === 0) return [];
  const group = getGroupByFolder(task.project_id);
  const stages = getGroupStages(group);
  const doneStageIds = new Set(
    stages.filter((s) => s.type === 'done' && !s.inactive).map((s) => s.id),
  );
  const allTasks = await getTasksByProject(task.project_id);
  const taskMap = new Map(allTasks.map((f) => [f.id, f]));
  return task.depends_on_ids.filter((depId) => {
    const dep = taskMap.get(depId);
    if (!dep) return false; // missing dep treated as satisfied
    return !doneStageIds.has(dep.status);
  });
}

import {
  assertGroupHomeIntact,
  getGroupHomeDir,
  invalidateChatModePrompt,
  MAX_PROMPT_FILE_BYTES,
} from '../prompt-loader.js';

// ---------------------------------------------------------------------------
// Project prompt helpers
// ---------------------------------------------------------------------------

/** Resolve the group home dir for a folder (reusable across all prompt types). */
function groupPromptDir(folder: string, parentId?: string): string {
  return path.join(getGroupHomeDir(folder, parentId), '.agent', 'prompts');
}

/**
 * Read a prompt file from an agent-writable group home. The file must resolve
 * inside the real group home (intra-group symlinks such as .agent -> .claude
 * are fine), be a regular file and stay under the size cap. A refusal is
 * logged and treated as missing.
 *
 * Prompt writes and deletes below are best-effort against an agent that times
 * a directory swap: a delete racing a `.agent` swap can still unlink one
 * prompt-named file elsewhere (Node has no unlinkat), and a write racing a
 * swap can create one empty file elsewhere when the leaf was absent, but is
 * refused before any content is written.
 */
async function readGroupPromptFile(
  groupHome: string,
  filePath: string,
): Promise<string | undefined> {
  try {
    assertGroupHomeIntact(groupHome);
    const buf = await readContainedFile(
      groupHome,
      filePath,
      MAX_PROMPT_FILE_BYTES,
    );
    return buf.toString('utf-8');
  } catch (err) {
    if (err instanceof ContainedFileError && err.code !== 'unreadable') {
      logger.warn({ file: filePath, code: err.code }, 'Refused prompt file');
    }
    return undefined;
  }
}

/**
 * True when unlinking `filePath` cannot reach outside the real group home:
 * its parent directory must resolve inside it. The leaf itself is never
 * followed by unlink. A missing parent means there is nothing to delete.
 */
function canUnlinkPromptFile(groupHome: string, filePath: string): boolean {
  try {
    assertGroupHomeIntact(groupHome);
    const realHome = fs.realpathSync(groupHome);
    const realDir = fs.realpathSync(path.dirname(filePath));
    if (isPathInside(realHome, realDir)) return true;
    logger.warn(
      { file: filePath, code: 'outside_root' },
      'Refused prompt file',
    );
  } catch (err) {
    if (err instanceof ContainedFileError && err.code !== 'unreadable') {
      logger.warn({ file: filePath, code: err.code }, 'Refused prompt file');
    }
  }
  return false;
}

const projectPromptCache = new Map<
  string,
  { value: string | undefined; ts: number }
>();
const PROJECT_PROMPT_TTL = 5_000; // 5 seconds

export async function readProjectPrompt(
  folder: string,
): Promise<string | undefined> {
  const cached = projectPromptCache.get(folder);
  if (cached && Date.now() - cached.ts < PROJECT_PROMPT_TTL)
    return cached.value;

  const group = getGroupByFolder(folder);
  const parentId = group?.parentId;

  const groupHome = getGroupHomeDir(folder, parentId);
  const candidates = [
    path.join(groupPromptDir(folder, parentId), 'system.md'),
    path.join(PROMPTS_DIR, `${folder}.md`),
  ];

  let result: string | undefined;
  for (const [index, file] of candidates.entries()) {
    try {
      const raw =
        index === 0
          ? await readGroupPromptFile(groupHome, file)
          : await fsp.readFile(file, 'utf-8');
      const content = raw?.trim();
      if (content) {
        result = content;
        break;
      }
    } catch {
      // Try next
    }
  }

  projectPromptCache.set(folder, { value: result, ts: Date.now() });
  return result;
}

export async function writeProjectPrompt(
  folder: string,
  prompt: string,
): Promise<void> {
  const group = getGroupByFolder(folder);
  await writePrompt(folder, group?.parentId, 'system.md', prompt);
  projectPromptCache.delete(folder);
}

export function deleteProjectPrompt(folder: string): void {
  const group = getGroupByFolder(folder);
  const parentId = group?.parentId;
  const groupSpecificPath = path.join(
    groupPromptDir(folder, parentId),
    'system.md',
  );

  try {
    if (
      canUnlinkPromptFile(getGroupHomeDir(folder, parentId), groupSpecificPath)
    ) {
      fs.unlinkSync(groupSpecificPath);
    }
  } catch {
    /* ignore */
  }

  projectPromptCache.delete(folder);
  promptFileCache.delete(promptCacheKey(folder, parentId, 'system.md'));
}

// ---------------------------------------------------------------------------
// Generic prompt helpers (worker.md, stage-*.md, etc.)
// ---------------------------------------------------------------------------

const promptFileCache = new Map<
  string,
  { value: string | undefined; ts: number }
>();
const PROMPT_FILE_TTL = 5_000; // 5 seconds — matches projectPromptCache

function promptCacheKey(
  folder: string,
  parentId: string | undefined,
  filename: string,
): string {
  return `${parentId ?? ''}|${folder}|${filename}`;
}

/**
 * Drop every cache that can hold a prompt file's old content. Chat-mode
 * files also feed the chat-mode prompt cache and the assembled full-prompt
 * cache, which would otherwise serve the old text for up to a minute.
 */
function invalidatePromptFileCaches(
  folder: string,
  parentId: string | undefined,
  filename: string,
): void {
  promptFileCache.delete(promptCacheKey(folder, parentId, filename));
  const modeId = /^chat-mode-(.+)\.md$/.exec(filename)?.[1];
  if (modeId) invalidateChatModePrompt(folder, parentId, modeId);
}

/** Read a prompt file from the group's .agent/prompts directory. */
export async function readPrompt(
  folder: string,
  parentId: string | undefined,
  filename: string,
): Promise<string | undefined> {
  const key = promptCacheKey(folder, parentId, filename);
  const cached = promptFileCache.get(key);
  if (cached && Date.now() - cached.ts < PROMPT_FILE_TTL) return cached.value;

  const filePath = path.join(groupPromptDir(folder, parentId), filename);
  const content = (
    await readGroupPromptFile(getGroupHomeDir(folder, parentId), filePath)
  )?.trim();
  const result = content || undefined;
  promptFileCache.set(key, { value: result, ts: Date.now() });
  return result;
}

/** Write a prompt file to the group's .agent/prompts directory. */
export async function writePrompt(
  folder: string,
  parentId: string | undefined,
  filename: string,
  content: string,
): Promise<void> {
  const groupHome = getGroupHomeDir(folder, parentId);
  const filePath = path.join(groupPromptDir(folder, parentId), filename);
  try {
    // A group home that does not exist yet is created by the write below.
    if (fs.existsSync(groupHome)) assertGroupHomeIntact(groupHome);
    await writeContainedFileVerified(groupHome, filePath, content);
  } catch (err) {
    if (err instanceof ContainedFileError) {
      logger.warn({ file: filePath, code: err.code }, 'Refused prompt file');
      throw new Error(`Refused to write prompt file: ${err.message}`);
    }
    throw err;
  } finally {
    invalidatePromptFileCaches(folder, parentId, filename);
  }
}

/** Copy the bundled worker prompt into a newly created project's prompt directory. */
export async function seedDefaultWorkerPrompt(
  folder: string,
  parentId: string | undefined,
): Promise<void> {
  const content = await fsp.readFile(
    path.join(PROMPTS_DIR, 'worker.md'),
    'utf-8',
  );
  await writePrompt(folder, parentId, 'worker.md', content);
}

/** Delete a prompt file from the group's .agent/prompts directory. */
export async function deletePrompt(
  folder: string,
  parentId: string | undefined,
  filename: string,
): Promise<void> {
  const filePath = path.join(groupPromptDir(folder, parentId), filename);
  if (canUnlinkPromptFile(getGroupHomeDir(folder, parentId), filePath)) {
    try {
      await fsp.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logger.warn({ filePath, err }, 'Failed to delete prompt file');
      }
    }
  }
  invalidatePromptFileCaches(folder, parentId, filename);
}

// ---------------------------------------------------------------------------
// Starter prompt helpers
// ---------------------------------------------------------------------------

const starterPromptsCache = new Map<
  string,
  { value: any[] | undefined; ts: number }
>();
const STARTER_PROMPTS_TTL = 5_000;
const warnedStarterPrompts = new Set<string>();

function warnStarterPromptRefusal(file: string, err: unknown): void {
  const code =
    err instanceof GroupFsError || err instanceof ContainedFileError
      ? err.code
      : 'io';
  if (code === 'unreadable') return;
  const key = `${file}:${code}`;
  if (warnedStarterPrompts.has(key)) return;
  if (warnedStarterPrompts.size >= 1024) warnedStarterPrompts.clear();
  warnedStarterPrompts.add(key);
  logger.warn({ file, code }, 'Refused prompt file');
}

export async function readStarterPrompts(
  folder: string,
): Promise<any[] | undefined> {
  const cached = starterPromptsCache.get(folder);
  if (cached && Date.now() - cached.ts < STARTER_PROMPTS_TTL)
    return cached.value;

  const group = getGroupByFolder(folder);
  const parentId = group?.parentId;
  const filePath = path.join(groupPromptDir(folder, parentId), 'starters.json');

  let result: any[] | undefined;
  try {
    assertGroupHomeIntact(getGroupHomeDir(folder, parentId));
    const dir = await openGroupDir(folder, '.agent/prompts', {
      followInternalLinks: true,
    });
    if (dir) {
      try {
        const file = await readFileAt(dir, 'starters.json', {
          maxBytes: MAX_PROMPT_FILE_BYTES,
        });
        if (file) {
          const parsed: unknown = JSON.parse(file.data.toString('utf-8'));
          if (Array.isArray(parsed)) result = parsed;
        }
      } finally {
        await dir.close();
      }
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) warnStarterPromptRefusal(filePath, err);
  }
  starterPromptsCache.set(folder, { value: result, ts: Date.now() });
  return result;
}

export async function writeStarterPrompts(
  folder: string,
  starters: any[],
): Promise<void> {
  const group = getGroupByFolder(folder);
  const parentId = group?.parentId;
  const groupHome = getGroupHomeDir(folder, parentId);
  try {
    if (fs.existsSync(groupHome)) assertGroupHomeIntact(groupHome);
    const dir = await openGroupDir(folder, '.agent/prompts', {
      create: true,
      followInternalLinks: true,
    });
    if (!dir) throw new Error('Unable to open prompt directory');
    try {
      await writeFileAt(
        dir,
        'starters.json',
        JSON.stringify(starters, null, 2),
      );
    } finally {
      await dir.close();
    }
  } finally {
    starterPromptsCache.delete(folder);
  }
}

export async function deleteStarterPrompts(folder: string): Promise<void> {
  const group = getGroupByFolder(folder);
  const parentId = group?.parentId;
  const filePath = path.join(groupPromptDir(folder, parentId), 'starters.json');

  try {
    assertGroupHomeIntact(getGroupHomeDir(folder, parentId));
    const dir = await openGroupDir(folder, '.agent/prompts', {
      followInternalLinks: true,
    });
    if (dir) {
      try {
        await removeAt(dir, 'starters.json');
      } finally {
        await dir.close();
      }
    }
  } catch (err) {
    warnStarterPromptRefusal(filePath, err);
  } finally {
    starterPromptsCache.delete(folder);
  }
}

// ---------------------------------------------------------------------------
// Slash command discovery
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
  type: 'skill' | 'command';
}

const commandsCache = new Map<
  string,
  { data: SlashCommand[]; timestamp: number; ttl?: number }
>();
const COMMANDS_CACHE_TTL = 60_000; // 60 seconds
const COMMANDS_CACHE_ERROR_TTL = 5_000; // 5 seconds — short TTL on error to avoid hammering the tool

/** Parse frontmatter from a SKILL.md file and extract name/description. */
function parseSkillFrontmatter(
  content: string,
): { name?: string; description?: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  const nameMatch = fm.match(/name:\s*(.+)/);
  const descMatch = fm.match(/description:\s*(.+)/);
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
  };
}

const MAX_SKILL_MD_BYTES = 64 * 1024;

/** Scan a directory for .agent/skills/<name>/SKILL.md files and extract slash commands. */
export async function scanAgentSkills(
  skillDir: string,
): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  if (!fs.existsSync(skillDir)) return commands;

  try {
    const entries = await fsp.readdir(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = path.join(skillDir, entry.name);
      try {
        // The skills tree is agent-writable: refuse symlinks, FIFOs and other
        // non-regular files, and cap the read size.
        const content = (
          await readContainedFile(
            entryDir,
            path.join(entryDir, 'SKILL.md'),
            MAX_SKILL_MD_BYTES,
          )
        ).toString('utf-8');
        const fm = parseSkillFrontmatter(content);
        if (fm?.name && fm.description) {
          commands.push({
            name: fm.name,
            description: fm.description,
            type: 'skill',
          });
        }
      } catch {
        // Skip unreadable files silently
      }
    }
  } catch {
    // Directory unreadable — skip
  }
  return commands;
}

/**
 * Slash commands for a project. Skills the project disabled are hidden unless
 * `includeDisabled` is set (the project settings checklist needs them all).
 */
export async function getProjectCommands(
  pid: string,
  stack: string,
  service: string,
  instance: string,
  additionalSkillDirs?: string[],
  options: { includeDisabled?: boolean } = {},
): Promise<SlashCommand[]> {
  const commands = await loadProjectCommands(
    pid,
    stack,
    service,
    instance,
    additionalSkillDirs,
  );
  return options.includeDisabled
    ? commands
    : withoutDisabledSkills(commands, getDisabledSkills(pid));
}

/** Build (or return cached) command list for a project via the sandbox_commands MCP tool. */
async function loadProjectCommands(
  pid: string,
  stack: string,
  service: string,
  instance: string,
  additionalSkillDirs?: string[],
): Promise<SlashCommand[]> {
  const cached = commandsCache.get(pid);
  if (
    cached &&
    Date.now() - cached.timestamp < (cached.ttl ?? COMMANDS_CACHE_TTL)
  )
    return cached.data;

  try {
    // Get box-level skills from sandbox_commands
    let parsed: SlashCommand[] = [];
    try {
      const client = getSandboxClient();
      const result = await client.callTool('sandbox_commands', {
        name: stack,
        service,
        instance,
      });
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = [];
      }
    } catch (err) {
      logger.warn({ pid, stack, instance, err }, 'sandbox_commands failed');
    }

    // Scan additional skill directories if provided
    let localCommands: SlashCommand[] = [];
    if (additionalSkillDirs?.length) {
      const scanned = await Promise.all(
        additionalSkillDirs.map((dir) => scanAgentSkills(dir)),
      );
      localCommands = scanned.flat();
    }

    // Merge and deduplicate by name, preferring sandbox_commands results
    const mergedMap = new Map<string, SlashCommand>();
    for (const cmd of parsed) {
      if (cmd.name && cmd.description) {
        mergedMap.set(cmd.name, cmd);
      }
    }
    for (const cmd of localCommands) {
      if (cmd.name && cmd.description && !mergedMap.has(cmd.name)) {
        mergedMap.set(cmd.name, cmd);
      }
    }

    const data = Array.from(mergedMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    commandsCache.set(pid, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    logger.warn({ pid, stack, instance, err }, 'sandbox_commands failed');
    commandsCache.set(pid, {
      data: [],
      timestamp: Date.now(),
      ttl: COMMANDS_CACHE_ERROR_TTL,
    });
    return [];
  }
}

/** Invalidate the commands cache for a project (e.g. on ?reload). */
export function invalidateCommandsCache(pid: string): void {
  commandsCache.delete(pid);
}

/**
 * Project-level write: explicit owner/editor; never agents, viewers or chat-only
 * users. Admins pass too, except where `enforceProjectAccess` resolved them
 * through membership (a project owned by another user): they get that level.
 */
export function canEditProjectLocalFiles(req: any): boolean {
  if (!req.authUser) return false;
  if (req.authUser.role === 'admin' && !req.projectAccess) return true;
  return explicitLevelAtLeast(req.projectAccess, 'editor');
}
