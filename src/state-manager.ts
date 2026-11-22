import { projectChanges } from './lib/project-changes.js';
/**
 * State management for sessions, registered groups, and per-group metadata.
 * Extracted from index.ts to isolate state persistence and group lifecycle.
 */

import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { and, eq } from 'drizzle-orm';
import { drizzleDbRef } from './db/drizzle-client.js';
import { projects } from './db/schema.js';

import { getMessagingProvider } from './modules/messaging/registry.js';
import type { MessagingConnectionStatus } from './modules/messaging/types.js';

import { DATA_DIR, GROUPS_DIR, PROMPTS_DIR } from './config.js';
import { getGroupDir } from './group-dir.js';
import { writeProjectDirsFile } from './modules/transcripts/project-dirs-file.js';
import {
  GroupFsError,
  lstatAtSync,
  mkdirAtSync,
  openDirAtSync,
  openGroupDirSync,
  openParentDirSync,
  renameAtSync,
  writeFileAtSync,
  type PinnedDir,
} from './lib/group-fs.js';
import { AvailableGroup } from './mcp/mcp-runner.js';
import { RegisteredGroup, Session, ProjectSettings } from './types.js';
import { loadJson, saveJson } from './utils.js';
import {
  logger,
  MAX_LOG_RECORD_BYTES,
  MAX_STRING_LENGTH,
  sanitizeLogValue,
} from './logger.js';
import { isReservedProjectFolder } from './modules/projects/reserved-folders.js';

// WhatsApp connection state exposed for HTTP status endpoint (now proxied via messaging MCP)
export type WhatsAppConnectionStatus = MessagingConnectionStatus;

export async function getWhatsAppStatus(): Promise<{
  status: WhatsAppConnectionStatus;
  qr?: string;
  jid?: string;
}> {
  const provider = getMessagingProvider();
  return provider ? provider.getStatus() : { status: 'disconnected' };
}

let lastTimestamp = '';
export const sessions: Session = {};
// Track last agent command per group folder (WhatsApp/legacy path) for session-drop on agent change
export const sessionAgentCmds: Record<string, string> = {};
// Track sessions that have been recently compacted and need instruction re-injection
export const compactedSessions = new Set<string>();
export const registeredGroups: Record<string, RegisteredGroup> = {};
export const lastAgentTimestamp: Record<string, string> = {};

let isStateLoaded = false;

// ── O(1) group-by-folder index ──────────────────────────────────────────────

const groupsByFolder = new Map<
  string,
  { jid: string; group: RegisteredGroup }
>();

function rebuildFolderIndex(): void {
  groupsByFolder.clear();
  for (const [jid, group] of Object.entries(registeredGroups)) {
    groupsByFolder.set(group.folder, { jid, group });
  }
  if (isStateLoaded) writeProjectDirsFile(Object.values(registeredGroups));
}

/** O(1) lookup of a RegisteredGroup by its folder name. */
export function getGroupByFolder(folder: string): RegisteredGroup | undefined {
  return groupsByFolder.get(folder)?.group;
}

/**
 * Sandbox names are the key to a project's integration tokens, so no name may
 * belong to two projects: a folder name or a configured `defaultSandboxInstance`
 * (compared case-insensitively). Returns another project (not `selfFolder`) whose
 * configured instance equals `name`, or, with `includeFolders`, whose folder does.
 */
export function findSandboxNameConflict(
  name: string,
  selfFolder?: string,
  options: { includeFolders?: boolean } = {},
): RegisteredGroup | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return Object.values(registeredGroups).find(
    (group) =>
      group.folder !== selfFolder &&
      ((options.includeFolders && group.folder.toLowerCase() === key) ||
        group.settings?.defaultSandboxInstance?.trim().toLowerCase() === key),
  );
}

const sandboxNameReservations = new Map<string, object>();

/**
 * Reserves a sandbox name for the in-flight request `owner` (in-process only):
 * the conflict check that passed and the reservation must have no `await`
 * between them. Returns false when another owner holds the name; the owner's
 * own reservation never conflicts.
 */
export function reserveSandboxName(name: string, owner: object): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return true;
  const holder = sandboxNameReservations.get(key);
  if (holder && holder !== owner) return false;
  sandboxNameReservations.set(key, owner);
  return true;
}

/** Whether an in-flight request has reserved `name`. */
export function isSandboxNameReserved(name: string): boolean {
  return sandboxNameReservations.has(name.trim().toLowerCase());
}

/** Drops every reservation held by `owner`. */
export function releaseSandboxNameReservations(owner: object): void {
  for (const [key, holder] of sandboxNameReservations)
    if (holder === owner) sandboxNameReservations.delete(key);
}

export function sandboxNameConflictMessage(name: string): string {
  return `The name "${name}" is already used as a sandbox name by another project`;
}

/** Folders of the projects nested directly inside `folder` (board-owned paths there). */
export function childProjectFolders(folder: string): string[] {
  return Object.values(registeredGroups)
    .filter((child) => child.parentId === folder)
    .map((child) => child.folder);
}

/** O(1) lookup returning [jid, group] tuple by folder name (replaces Object.entries().find()). */
export function getGroupEntryByFolder(
  folder: string,
): { jid: string; group: RegisteredGroup } | undefined {
  return groupsByFolder.get(folder);
}

export function getLastTimestamp(): string {
  return lastTimestamp;
}

export function setLastTimestamp(ts: string): void {
  lastTimestamp = ts;
}

// ── Encryption helpers for brainAuthToken at rest ────────────────────────────

let _encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;
  const envKey = process.env.CARAPA_BOARD_ENCRYPTION_KEY;
  if (envKey) {
    _encryptionKey = Buffer.from(envKey, 'hex');
    return _encryptionKey;
  }
  const keyPath = path.join(DATA_DIR, '.encryption-key');
  if (fs.existsSync(keyPath)) {
    _encryptionKey = Buffer.from(
      fs.readFileSync(keyPath, 'utf8').trim(),
      'hex',
    );
    return _encryptionKey;
  }
  // Auto-generate and persist on first boot
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  logger.info(
    { generated: true },
    'Generated new encryption key for brainAuthToken',
  );
  _encryptionKey = key;
  return _encryptionKey;
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${ciphertext.toString('hex')}:${authTag.toString('hex')}`;
}

function decryptToken(encrypted: string): string | undefined {
  if (!encrypted.startsWith('enc:')) return encrypted;
  try {
    const [, ivHex, ciphertextHex, authTagHex] = encrypted.split(':');
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return (
      decipher.update(ciphertext).toString('utf8') + decipher.final('utf8')
    );
  } catch (err) {
    logger.warn(
      { error: String(err) },
      'Failed to decrypt brainAuthToken — treating as missing',
    );
    return undefined;
  }
}

// Settings fields holding secrets that are encrypted at rest. In-memory
// settings always hold plaintext (see loadState's decrypt step); these are
// the symmetric write/read sides.
const ENCRYPTED_SETTING_KEYS = ['brainAuthToken', 'carapaMailToken'] as const;

/**
 * Serialize a group's settings for DB persistence with secret fields
 * encrypted at rest. In-memory settings always hold the plaintext tokens (see
 * loadState's decrypt step); this is the symmetric write side.
 * Idempotent: a value that's already encrypted ('enc:...') is left as-is to
 * avoid double-encryption if memory somehow held ciphertext.
 */
/**
 * Project-settings keys written only by recovery code. They never enter the
 * in-memory settings, so every settings write copies the persisted value.
 * `_pendingFinalizationRuns[taskId] = { runId, projectId, stage }` is the
 * retry key for a completed task run whose boot finalization has not settled;
 * unlike `_checkoutAdmissions` it blocks nothing.
 */
export const PENDING_FINALIZATION_KEY = '_pendingFinalizationRuns';

export function serializeSettingsForDb(
  settings: ProjectSettings | undefined,
): string | null {
  if (!settings) return null;
  const normalized = normalizeTaskCheckoutSettings(settings);
  // normalizeTaskCheckoutSettings strips _checkoutAdmissions, so read it from
  // the input to keep persisted admissions visible to boot-time recovery.
  const admissions = (settings as Record<string, unknown>)._checkoutAdmissions;
  const pending = (settings as Record<string, unknown>)[
    PENDING_FINALIZATION_KEY
  ];
  const persisted = {
    ...normalized,
    ...(admissions ? { _checkoutAdmissions: admissions } : {}),
    ...(pending ? { [PENDING_FINALIZATION_KEY]: pending } : {}),
  } as ProjectSettings;
  let out: ProjectSettings | undefined;
  for (const key of ENCRYPTED_SETTING_KEYS) {
    const token = persisted[key];
    if (typeof token === 'string' && token && !token.startsWith('enc:')) {
      out = out ?? { ...persisted };
      out[key] = encryptToken(token);
    }
  }
  return JSON.stringify(out ?? persisted);
}

export function resolveTaskCheckoutMode(
  settings: ProjectSettings,
): 'shared' | 'branch' | 'worktree' {
  const mode = settings.taskCheckoutMode;
  return mode === 'shared' || mode === 'branch' || mode === 'worktree'
    ? mode
    : 'shared';
}

/** Normalize public/runtime settings; admissions and the retired createBranchPerTask key never enter memory. */
export function normalizeTaskCheckoutSettings(
  settings: ProjectSettings,
): ProjectSettings {
  const result = {
    ...settings,
    taskCheckoutMode: resolveTaskCheckoutMode(settings),
  };
  delete (result as Record<string, unknown>)._checkoutAdmissions;
  delete (result as Record<string, unknown>)[PENDING_FINALIZATION_KEY];
  delete (result as Record<string, unknown>).createBranchPerTask;
  return result;
}

/** Apply an already-validated update without issuing a second persistence write. */
export function applyGroupUpdateInMemory(
  jid: string,
  updates: Partial<RegisteredGroup>,
): void {
  const group = registeredGroups[jid];
  if (!group) return;
  Object.assign(group, updates);
  rebuildFolderIndex();
  projectChanges.emit('changed');
}

/** Existing collisions keep working; they are only reported. */
function warnSharedSandboxNames(): void {
  const folderSets = new Map<string, Set<string>>();
  for (const group of Object.values(registeredGroups)) {
    for (const name of [group.folder, group.settings?.defaultSandboxInstance]) {
      const key = name?.trim().toLowerCase();
      if (!key) continue;
      const folders = folderSets.get(key) ?? new Set<string>();
      folders.add(group.folder);
      folderSets.set(key, folders);
    }
  }
  const colliding = [...folderSets]
    .filter(([, folders]) => folders.size > 1)
    .map(([sandboxInstance, folders]) => ({
      sandboxInstance,
      folders: [...folders],
    }));
  if (colliding.length === 0) return;

  // Exactly one warning. The logger silently drops what exceeds its caps (20
  // array items, 256 chars per string, 4 KiB per record), so the payload must
  // pass `fits` unchanged. A name's folders are packed into comma-separated
  // strings, and entries go in arrays of 20 (`collisions`, `collisions2`, ...).
  // The complete report is sent when it fits; otherwise names and folders are
  // added while the payload, now carrying the omission counts, still fits.
  const message =
    'sandbox names used by more than one project (folder or defaultSandboxInstance); rename one so their integration tokens stay separate';
  const totalFolders = colliding.reduce((n, c) => n + c.folders.length, 0);
  const render = (shown: typeof colliding) => {
    const chunks = (folders: string[]) => {
      const out: string[] = [];
      for (const folder of folders) {
        const last = out.length - 1;
        if (
          last >= 0 &&
          out[last].length + 2 + folder.length <= MAX_STRING_LENGTH
        ) {
          out[last] += `, ${folder}`;
        } else out.push(folder);
      }
      return out;
    };
    const payload: Record<string, unknown> = {
      collisionCount: colliding.length,
    };
    shown.forEach(({ sandboxInstance, folders }, i) => {
      const key = i < 20 ? 'collisions' : `collisions${Math.floor(i / 20) + 1}`;
      const list = (payload[key] ??= []) as unknown[];
      list.push({ sandboxInstance, folders: chunks(folders) });
    });
    const shownFolders = shown.reduce((n, c) => n + c.folders.length, 0);
    if (shown.length < colliding.length)
      payload.omittedNames = colliding.length - shown.length;
    if (shownFolders < totalFolders)
      payload.omittedFolders = totalFolders - shownFolders;
    return payload;
  };
  const fits = (payload: object) => {
    const serialized = JSON.stringify(payload);
    return (
      // The logger counts 64 bytes of overhead plus message and payload.
      64 + message.length + serialized.length <= MAX_LOG_RECORD_BYTES &&
      JSON.stringify(sanitizeLogValue(payload)) === serialized
    );
  };

  let report = render(colliding);
  if (!fits(report)) {
    const shown: typeof colliding = [];
    for (const { sandboxInstance, folders } of colliding) {
      const entry = { sandboxInstance, folders: [] as string[] };
      shown.push(entry);
      for (const folder of folders) {
        entry.folders.push(folder);
        if (!fits(render(shown))) {
          entry.folders.pop();
          break;
        }
      }
      if (entry.folders.length === 0) shown.pop();
    }
    report = render(shown);
  }
  logger.warn(report, message);
}

export async function loadState(): Promise<void> {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  for (const key in lastAgentTimestamp) delete lastAgentTimestamp[key];
  Object.assign(lastAgentTimestamp, state.last_agent_timestamp || {});

  for (const key in sessions) delete sessions[key];
  Object.assign(sessions, loadJson(path.join(DATA_DIR, 'sessions.json'), {}));

  if (drizzleDbRef.current) {
    try {
      const rawProjects = await drizzleDbRef.current.select().from(projects);
      const newGroups: Record<string, RegisteredGroup> = {};
      for (const p of rawProjects) {
        // brainAuthToken is stored encrypted at rest (enc:<iv>:<ct>:<tag>);
        // decrypt on load so the in-memory copy holds plaintext, as the rest
        // of the code (resolveBrainAuthToken, dashboard proxy, event publisher)
        // assumes when it hands the value to the brain as a Bearer token.
        // decryptToken is a no-op for values that don't start with 'enc:'.
        const persistedSettings = p.settings
          ? (JSON.parse(p.settings) as ProjectSettings)
          : undefined;
        const settings = persistedSettings
          ? normalizeTaskCheckoutSettings(persistedSettings)
          : undefined;
        const serializedSettings = persistedSettings
          ? serializeSettingsForDb(persistedSettings)
          : null;
        if (
          serializedSettings &&
          serializedSettings !== JSON.stringify(persistedSettings)
        ) {
          await drizzleDbRef.current
            .update(projects)
            .set({ settings: serializedSettings })
            .where(eq(projects.id, p.id));
        }
        for (const key of ENCRYPTED_SETTING_KEYS) {
          const token = settings?.[key];
          if (settings && token) settings[key] = decryptToken(token);
        }
        if (isReservedProjectFolder(p.folder)) {
          logger.warn(
            { folder: p.folder },
            'reserved project folder: rename it; its routes are shadowed by collection routes',
          );
        }
        newGroups[p.jid] = {
          name: p.name,
          jid: p.jid,
          folder: p.folder,
          trigger: p.trigger,
          added_at: p.added_at,
          order: p.order || undefined,
          parentId: p.parentId || undefined,
          settings,
          is_main: p.is_main === 1,
          user_id: p.user_id || undefined,
        } as any;
      }

      for (const key in registeredGroups) delete registeredGroups[key];
      Object.assign(registeredGroups, newGroups);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to load projects from DB');
    }
  }

  isStateLoaded = true;
  rebuildFolderIndex();
  warnSharedSandboxNames();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/** Persist the session-id map. */
export function saveSessions(): void {
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

export function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveSessions();
}

/** Pin `groupDir` itself: its parent is walked without links, the directory is opened with O_NOFOLLOW. */
function openGroupRootAt(groupDir: string): PinnedDir | null {
  const parent = openParentDirSync(groupDir);
  if (!parent) return null;
  try {
    return openDirAtSync(parent.dir, parent.name);
  } finally {
    parent.dir.closeSync();
  }
}

/** Unlink one entry of a pinned directory (a link is removed, never followed). Best effort. */
function unlinkEntry(dir: PinnedDir, name: string): void {
  try {
    fs.unlinkSync(dir.entry(name));
  } catch {}
}

/** Like existsSync for one entry of a pinned directory: a dangling link does not exist. */
function entryResolves(dir: PinnedDir, name: string): boolean {
  try {
    fs.statSync(dir.entry(name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create cross-agent symlinks so all agents (Claude, Gemini, Codex) read the same config files.
 * Agents can write the whole group folder and swap any directory in it for a
 * symlink at any moment, so every step runs on a pinned group root and on
 * pinned `.agent`/`.claude`/`.gemini` directories: nothing is decided from a
 * path check and acted on later by path.
 */
function ensureAgentSymlinks(groupDir: string, group: RegisteredGroup): void {
  let root: PinnedDir | null = null;
  const pinned = new Map<string, PinnedDir>();
  const refused = new Set<string>();
  try {
    root = openGroupRootAt(groupDir);
    if (!root) return;
    const groupRoot = root;

    // Open (or create) a direct child directory of the group root; null when
    // it is absent and not created, or when it is not a real directory.
    const pinDir = (name: string, create = false): PinnedDir | null => {
      if (refused.has(name)) return null;
      const cached = pinned.get(name);
      if (cached) return cached;
      try {
        const dir = create
          ? mkdirAtSync(groupRoot, name)
          : openDirAtSync(groupRoot, name);
        if (dir) pinned.set(name, dir);
        return dir;
      } catch (err) {
        if (!(err instanceof GroupFsError)) throw err;
        refused.add(name);
        logger.warn(
          { groupDir, entry: name, err: err.message },
          'Skipping rules symlinks: entry is not a real directory',
        );
        return null;
      }
    };

    const claudeDirs = ['.claude', '.gemini'];
    for (const name of [...claudeDirs, '.agent']) pinDir(name);

    if (group.settings?.repositoryUrl || group.settings?.repositoryLocation) {
      // Projects with a repository manage their own config — remove any auto-generated files.
      // Unlink without an existence check so dangling symlinks are removed too.
      for (const name of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md']) {
        unlinkEntry(groupRoot, name);
      }
      for (const name of claudeDirs) {
        const dir = pinDir(name);
        if (dir) unlinkEntry(dir, 'rules');
      }
      return;
    }

    // Prompt file: AGENTS.md is the canonical file.
    // CLAUDE.md and GEMINI.md are symlinks to AGENTS.md for compat.
    // Migration: rename old CLAUDE.md real file → AGENTS.md if needed
    if (
      !entryResolves(groupRoot, 'AGENTS.md') &&
      entryResolves(groupRoot, 'CLAUDE.md')
    ) {
      try {
        if (lstatAtSync(groupRoot, 'CLAUDE.md')?.isFile()) {
          // CLAUDE.md is a real file (old layout) — rename to AGENTS.md
          renameAtSync(groupRoot, 'CLAUDE.md', groupRoot, 'AGENTS.md');
          // Remove old GEMINI.md symlink (pointed to CLAUDE.md)
          unlinkEntry(groupRoot, 'GEMINI.md');
        }
      } catch (err) {
        logger.debug(
          { groupDir, err: String(err) },
          'AGENTS.md migration rename failed',
        );
      }
    }
    const agentsMdExists = entryResolves(groupRoot, 'AGENTS.md');
    for (const name of ['CLAUDE.md', 'GEMINI.md']) {
      // lstat doesn't follow symlinks, so it detects dangling links too
      const entryExists = lstatAtSync(groupRoot, name) !== null;
      const targetReachable = entryResolves(groupRoot, name);
      if (agentsMdExists && !targetReachable) {
        // Missing or dangling — (re)create symlink
        if (entryExists) unlinkEntry(groupRoot, name);
        try {
          fs.symlinkSync('AGENTS.md', groupRoot.entry(name));
        } catch (err) {
          logger.warn(
            { linkPath: path.join(groupDir, name), err: String(err) },
            'Failed to create agent memory symlink',
          );
        }
      } else if (!agentsMdExists && entryExists && !targetReachable) {
        // Dangling symlink with no target — remove it
        unlinkEntry(groupRoot, name);
      }
    }

    // Rules directory: .agent/rules is the canonical location.
    // .claude/rules and .gemini/rules are symlinks to ../.agent/rules for compat.
    // Migration: if .claude/rules is a real dir and .agent/rules is absent, move it.
    // Only runs while .agent is a real directory or absent (a refused .agent is
    // never created into or renamed into).
    const claudeDir = pinDir('.claude');
    if (claudeDir && !refused.has('.agent')) {
      try {
        const agentDir = pinned.get('.agent') ?? null;
        if (
          lstatAtSync(claudeDir, 'rules')?.isDirectory() &&
          !(agentDir && entryResolves(agentDir, 'rules'))
        ) {
          const target = agentDir ?? pinDir('.agent', true);
          if (target) {
            renameAtSync(claudeDir, 'rules', target, 'rules');
            // Remove old .agent/rules and .gemini/rules symlinks that pointed to .claude/rules
            const geminiDir = pinDir('.gemini');
            if (geminiDir) unlinkEntry(geminiDir, 'rules');
          }
        }
      } catch (err) {
        logger.debug(
          { groupDir, err: String(err) },
          'Rules directory migration failed',
        );
      }
    }
    const agentDir = pinned.get('.agent');
    if (agentDir && entryResolves(agentDir, 'rules')) {
      for (const name of claudeDirs) {
        try {
          const dir = pinDir(name, true);
          if (!dir || entryResolves(dir, 'rules')) continue;
          fs.symlinkSync(
            path.join('..', '.agent', 'rules'),
            dir.entry('rules'),
          );
        } catch (err) {
          logger.warn(
            { linkPath: path.join(groupDir, name, 'rules'), err: String(err) },
            'Failed to create rules directory symlink',
          );
        }
      }
    }
  } catch (err) {
    logger.warn(
      { groupDir, err: String(err) },
      'Agent symlink maintenance failed',
    );
  } finally {
    for (const dir of pinned.values()) dir.closeSync();
    root?.closeSync();
  }
}

export { ensureAgentSymlinks };

/** True when any directory entry (including a dangling symlink) exists at `p`. */
function pathEntryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Regenerate a group's AGENTS.md from the appropriate prompt template. Returns true if written. */
export function regenerateGroupPrompt(group: RegisteredGroup): boolean {
  const hasRepo =
    group.settings?.repositoryUrl || group.settings?.repositoryLocation;
  if (hasRepo) return false;

  const groupDir = getGroupDir(group.folder);
  const isParent = group.settings?.isParent === true;
  const templatePath = path.join(
    PROMPTS_DIR,
    isParent ? 'AGENTS.parent.md' : 'AGENTS.md',
  );
  if (!fs.existsSync(templatePath)) return false;

  let content: string | Buffer;
  if (isParent) {
    const childGroups = Object.values(registeredGroups).filter(
      (g) => g.parentId === group.folder,
    );
    const childList =
      childGroups.length > 0
        ? childGroups.map((g) => `- **${g.folder}** — ${g.name}`).join('\n')
        : '_(no child projects registered yet)_';
    const template = fs.readFileSync(templatePath, 'utf-8');
    content = template.replace('{{children}}', childList);
  } else {
    content = fs.readFileSync(templatePath);
  }
  // Atomic write on the pinned group root: a planted AGENTS.md link is replaced,
  // never written through, and a swapped group folder is refused.
  let root: PinnedDir | null = null;
  try {
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    root = openGroupDirSync(group.folder, undefined, { create: true });
    if (!root) return false;
    writeFileAtSync(root, 'AGENTS.md', content);
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn(
      { folder: group.folder, err: err.message },
      'Refusing to write AGENTS.md: group folder is not a safe directory',
    );
    return false;
  } finally {
    root?.closeSync();
  }
  ensureAgentSymlinks(groupDir, group);
  return true;
}

/** Mark a JID's message cursor as "now" so old messages aren't replayed. */
export function setLastAgentTimestamp(jid: string, ts?: string): void {
  lastAgentTimestamp[jid] = ts || new Date().toISOString();
  saveState();
}

export async function registerGroup(
  jid: string,
  group: RegisteredGroup,
  options: { requirePersistence?: boolean } = {},
): Promise<void> {
  if (!isStateLoaded) {
    const message = 'Attempted to register group before state was loaded';
    logger.error(
      { jid, group_folder: group.folder },
      `${message}! This would cause data loss. Skipping registration.`,
    );
    if (options.requirePersistence) throw new Error(message);
    return;
  }
  const existing = groupsByFolder.get(group.folder);
  if (existing && existing.jid !== jid) {
    throw new Error(
      `Cannot register group "${group.name}" with folder "${group.folder}": ` +
        `folder already used by group "${existing.group.name}" (${existing.jid})`,
    );
  }

  if (
    !existing &&
    (findSandboxNameConflict(group.folder, undefined, {
      includeFolders: true,
    }) ||
      isSandboxNameReserved(group.folder))
  ) {
    throw new Error(sandboxNameConflictMessage(group.folder));
  }

  const previousAtJid = registeredGroups[jid];
  const rollbackMemory = () => {
    if (previousAtJid) registeredGroups[jid] = previousAtJid;
    else delete registeredGroups[jid];
    rebuildFolderIndex();
  };
  registeredGroups[jid] = group;
  rebuildFolderIndex();

  if (!drizzleDbRef.current && options.requirePersistence) {
    rollbackMemory();
    throw new Error(
      'Database is not initialized; group registration was not persisted',
    );
  }
  if (drizzleDbRef.current) {
    try {
      const isMainInt = group.is_main ? 1 : 0;
      const serializedSettings = serializeSettingsForDb(group.settings);
      await drizzleDbRef.current
        .insert(projects)
        .values({
          id: group.folder,
          jid: jid,
          name: group.name,
          folder: group.folder,
          trigger: group.trigger,
          added_at: group.added_at || new Date().toISOString(),
          order: group.order || null,
          parentId: group.parentId || null,
          settings: serializedSettings,
          is_main: isMainInt,
          user_id: group.user_id || null,
        })
        .onConflictDoUpdate({
          target: projects.id,
          set: {
            jid: jid,
            name: group.name,
            trigger: group.trigger,
            order: group.order || null,
            parentId: group.parentId || null,
            settings: serializedSettings,
            is_main: isMainInt,
            user_id: group.user_id || null,
          },
        });
    } catch (err) {
      logger.error(
        { jid, err: String(err) },
        'Failed to persist registered group to DB',
      );
      if (options.requirePersistence) {
        rollbackMemory();
        throw new Error(`Failed to persist registered group: ${String(err)}`);
      }
    }
  }

  try {
    // Create group folder with default AGENTS.md
    const groupDir = getGroupDir(group.folder);
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    openGroupDirSync(group.folder, 'logs', { create: true })?.closeSync();

    // Only generate AGENTS.md on first registration (don't overwrite existing)
    const agentsMdPath = path.join(groupDir, 'AGENTS.md');
    if (!pathEntryExists(agentsMdPath)) {
      regenerateGroupPrompt(group);
    }
    ensureAgentSymlinks(groupDir, group);
  } catch (err) {
    // In strict mode the DB row is already durable. Treat local prompt/folder
    // setup as auxiliary so callers never report a durable child as failed.
    if (!options.requirePersistence) throw err;
    logger.warn(
      { jid, folder: group.folder, err: String(err) },
      'Group persisted, but auxiliary filesystem setup failed',
    );
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
  projectChanges.emit('changed');
}

export function resetGroupSession(folder: string): void {
  delete sessions[folder];
  delete sessionAgentCmds[folder];
  saveSessions();
}

export async function unregisterGroup(jid: string): Promise<void> {
  const group = registeredGroups[jid];
  if (group) {
    delete registeredGroups[jid];
    rebuildFolderIndex();
    // Session cleanup is auxiliary: a failed sessions.json write must not keep
    // the DB row (or the registry entry) alive.
    try {
      resetGroupSession(group.folder);
    } catch (err) {
      logger.error(
        { jid, folder: group.folder, err: String(err) },
        'Failed to reset group session while unregistering',
      );
    }
    if (drizzleDbRef.current) {
      try {
        await drizzleDbRef.current
          .delete(projects)
          .where(eq(projects.id, group.folder));
      } catch (err) {
        registeredGroups[jid] = group;
        rebuildFolderIndex();
        logger.error(
          { jid, err: String(err) },
          'Failed to delete project from DB',
        );
        throw err;
      }
    }
    logger.info({ jid, folder: group.folder }, 'Group unregistered');
  }
  projectChanges.emit('changed');
}

export async function updateGroup(
  jid: string,
  updates: Partial<RegisteredGroup>,
): Promise<void> {
  const group = registeredGroups[jid];
  if (!group) return;
  if (updates.settings) {
    updates = {
      ...updates,
      settings: {
        ...updates.settings,
        appPublication: group.settings?.appPublication,
      },
    };
  }
  Object.assign(group, updates);
  rebuildFolderIndex();

  if (drizzleDbRef.current) {
    try {
      // Deferred to avoid the db-kanban <-> state-manager initialization cycle.
      const { withProjectAdmissionLock } =
        await import('./modules/kanban/db-kanban.js');
      await withProjectAdmissionLock(group.folder, async (tx) => {
        const [current] = await tx
          .select({ settings: projects.settings })
          .from(projects)
          .where(eq(projects.id, group.folder))
          .limit(1);
        const persisted = serializeSettingsForDb(group.settings);
        const nextSettings = persisted
          ? (JSON.parse(persisted) as Record<string, unknown>)
          : {};
        const currentSettings = current?.settings
          ? (JSON.parse(current.settings) as Record<string, unknown>)
          : {};
        nextSettings.appPublication = currentSettings.appPublication;
        nextSettings.whatsappSelfChatAutoLinkDisabled =
          currentSettings.whatsappSelfChatAutoLinkDisabled;
        if (group.settings) {
          group.settings.whatsappSelfChatAutoLinkDisabled =
            currentSettings.whatsappSelfChatAutoLinkDisabled as
              | boolean
              | undefined;
        }
        if (group.settings)
          group.settings.appPublication =
            currentSettings.appPublication as ProjectSettings['appPublication'];
        if (currentSettings._checkoutAdmissions) {
          nextSettings._checkoutAdmissions =
            currentSettings._checkoutAdmissions;
        }
        if (currentSettings[PENDING_FINALIZATION_KEY]) {
          (nextSettings as Record<string, unknown>)[PENDING_FINALIZATION_KEY] =
            currentSettings[PENDING_FINALIZATION_KEY];
        }
        const isMainInt = group.is_main ? 1 : 0;
        const nextSettingsJson = JSON.stringify(nextSettings);
        await tx
          .insert(projects)
          .values({
            id: group.folder,
            jid: group.jid || jid,
            name: group.name,
            folder: group.folder,
            trigger: group.trigger,
            added_at: group.added_at || new Date().toISOString(),
            order: group.order || null,
            parentId: group.parentId || null,
            settings: nextSettingsJson,
            is_main: isMainInt,
            user_id: group.user_id || null,
          })
          .onConflictDoUpdate({
            target: projects.id,
            set: {
              name: group.name,
              trigger: group.trigger,
              order: group.order || null,
              parentId: group.parentId || null,
              settings: nextSettingsJson,
              is_main: isMainInt,
              user_id: group.user_id || null,
            },
          });
      });
    } catch (err) {
      logger.error({ jid, err: String(err) }, 'Failed to update group in DB');
      // The in-memory registry already changed; tell listeners, then surface it.
      projectChanges.emit('changed');
      throw err;
    }
  }
  projectChanges.emit('changed');
}

/**
 * Move an in-memory group to a new jid and folder after the database rows were
 * re-keyed (`renameProjectFolder` with a jid override). Memory only.
 */
export function rekeyGroup(
  oldJid: string,
  newJid: string,
  newFolder: string,
): void {
  const group = registeredGroups[oldJid];
  if (!group) throw new Error(`Group "${oldJid}" is not registered`);
  if (newJid !== oldJid && registeredGroups[newJid]) {
    throw new Error(`Group "${newJid}" is already registered`);
  }
  delete registeredGroups[oldJid];
  group.folder = newFolder;
  if (group.jid) group.jid = newJid;
  registeredGroups[newJid] = group;
  rebuildFolderIndex();
  projectChanges.emit('changed');
}

/**
 * Change a registered project's jid in place. The `projects` row keeps its id
 * and only gets the new `jid`, so rows that cascade from `projects.id` survive
 * (unlike `unregisterGroup` + `registerGroup`, which deletes the project).
 * The DB is updated first; if that fails nothing in memory changes.
 */
export async function rekeyGroupJid(
  oldJid: string,
  newJid: string,
  updates: Partial<Pick<RegisteredGroup, 'name' | 'trigger'>> & {
    whatsappSelfChatAutoLinkDisabled?: boolean;
  } = {},
): Promise<void> {
  const group = registeredGroups[oldJid];
  if (!group) throw new Error(`Group "${oldJid}" is not registered`);
  if (newJid !== oldJid && registeredGroups[newJid]) {
    throw new Error(`Group "${newJid}" is already registered`);
  }
  if (drizzleDbRef.current) {
    const values = {
      jid: newJid,
      name: updates.name ?? group.name,
      trigger: updates.trigger ?? group.trigger,
    };
    const condition = and(
      eq(projects.id, group.folder),
      eq(projects.jid, oldJid),
    );
    let updated;
    if (updates.whatsappSelfChatAutoLinkDisabled !== undefined) {
      const { withProjectAdmissionLock } =
        await import('./modules/kanban/db-kanban.js');
      updated = await withProjectAdmissionLock(group.folder, async (tx) => {
        const [row] = await tx
          .select({ settings: projects.settings })
          .from(projects)
          .where(condition)
          .limit(1);
        if (!row) return [];
        const settings = row.settings ? JSON.parse(row.settings) : {};
        settings.whatsappSelfChatAutoLinkDisabled =
          updates.whatsappSelfChatAutoLinkDisabled;
        return tx
          .update(projects)
          .set({ ...values, settings: JSON.stringify(settings) })
          .where(condition)
          .returning();
      });
    } else {
      updated = await drizzleDbRef.current
        .update(projects)
        .set(values)
        .where(condition)
        .returning();
    }
    if (updated.length === 0) {
      throw new Error(
        `Project "${group.folder}" has no database row at jid "${oldJid}"`,
      );
    }
  }
  if (updates.name !== undefined) group.name = updates.name;
  if (updates.trigger !== undefined) group.trigger = updates.trigger;
  if (updates.whatsappSelfChatAutoLinkDisabled !== undefined) {
    group.settings = {
      ...group.settings,
      whatsappSelfChatAutoLinkDisabled:
        updates.whatsappSelfChatAutoLinkDisabled,
    };
  }
  rekeyGroup(oldJid, newJid, group.folder);
  try {
    resetGroupSession(group.folder);
  } catch (err) {
    logger.error(
      { oldJid, folder: group.folder, err: String(err) },
      'Failed to reset group session while re-keying',
    );
  }
  logger.info({ oldJid, newJid, folder: group.folder }, 'Group jid re-keyed');
}

export function migrateGroupSession(
  oldFolder: string,
  newFolder: string,
): void {
  if (sessions[oldFolder] !== undefined) {
    sessions[newFolder] = sessions[oldFolder];
    delete sessions[oldFolder];
    saveSessions();
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity via messaging MCP.
 */
export async function getAvailableGroups(): Promise<AvailableGroup[]> {
  const provider = getMessagingProvider();
  if (!provider) return [];
  const chats = await provider.listChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.chat_id.endsWith('@g.us'))
    .map((c) => ({
      jid: c.chat_id,
      name: c.name,
      lastActivity: c.last_activity,
      isRegistered: registeredJids.has(c.chat_id),
    }));
}
