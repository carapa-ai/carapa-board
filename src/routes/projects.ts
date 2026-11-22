/**
 * Projects route hub — project-level CRUD, settings, and sub-router mounting.
 *
 * Domain-specific endpoints are split into:
 *   - tasks.ts        — Task CRUD, status updates, execution
 *   - conversations.ts — Conversation/message/chat endpoints
 *   - cronjobs.ts     — Cron job management
 *   - datasets.ts     — Dataset task endpoints
 *   - objectives.ts   — Objective CRUD and dashboard
 *   - whatsapp/       — WhatsApp group management (module-mounted via getRouter)
 *
 * Shared validation helpers live in _helpers.ts.
 */
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import {
  BoxCleanupError,
  deleteProjectKeys,
  ownSandboxBinding,
} from '../modules/projects/integration-keys.js';
import { ipcReplica } from '../sandbox/ipc-replica.js';
import {
  appPublicationInput,
  getAppPublication,
  setAppPublication,
} from '../sandbox/app-publication.js';

import fsp from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../lib/hash.js';
import { acquireSharedCheckoutLease } from '../concurrency/shared-checkout-lease.js';
import { projectChanges } from '../lib/project-changes.js';
import {
  adminBypassesProject,
  isOwnedByOtherUser,
} from '../lib/project-ownership.js';
import {
  isSafeRepositoryUrl,
  isValidGitBranchName,
} from '../lib/git-ref-name.js';
import { verifyFreshSignature } from '../lib/device-auth/fresh-signature.js';
import {
  getEffectivePrivacyInfo,
  PrivacyRefusal,
  privacyModeRank,
  type PrivacyMode,
} from '../lib/privacy-policy.js';
import {
  resolveObjectiveRuntimeTiers,
  resolveProjectRuntimeTiers,
  RuntimeTiersHarnessError,
} from '../modules/objectives/objective-runtime-tiers.js';
import mailRouter from './mail.js';
import path from 'path';
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  getProjectAccess,
  getProjectsForUser,
  upsertProjectMember,
  insertProjectMemberIfMissing,
  getImplicitProjectIdsForUser,
  getMemberModesForUser,
  getSharedConversationIds,
  userIsProjectOwner,
} from '../modules/knowledge/db-kb.js';
import {
  getChatAgents,
  getRuntimeCatalog,
  isDirectRuntime,
  resolveRuntimeSelection,
  validateRuntimeSelection,
  type RuntimeSelection,
} from '../lib/chat-agents.js';
import { revokeGroupTokens } from '../mcp/auth-tokens.js';
import { hasPermission } from '../mcp/auth.js';
import {
  getTasksByProject,
  getRunningTaskIds,
  getProjectsStatusSummary,
  deleteProjectData,
  renameProjectFolder,
  getTaskProjectMap,
  getAllActiveObjectives,
  getObjectivesByProject,
  getAttentionTasks,
  getUnmergedBranchTasks,
  getAttentionRunningItems,
  getAttentionCompletedTasks,
  getAttentionConversations,
  getNowDismissals,
  dismissNowItems,
  markConversationRead,
  getUnreadPayloads,
  getConversationActivityTimes,
  getObjective,
  getAiUserRow,
  getAiUserTeamRow,
  countProjectTasksByStatus,
  commitProjectStageMigration,
  releaseAndNotifyStageEntryEvents,
  updateProjectSettingsWithAdmissionLock,
  ProjectAdmissionConflictError,
  assertTaskCheckoutModeChangeAllowed,
  recordFavoriteMove,
} from '../db.js';
import type { StageEntryEvent } from '../modules/kanban/types.js';
import { getObjectiveDir } from '../modules/objectives/objective-folder.js';
import {
  brainResolutionStatus,
  fetchBrain,
  getBrainAuthStatus,
  publishObjectiveStateEvent,
  resolveBrainAuthToken,
  resolveBrainAuthTokenOwner,
  resolveBrainContainer,
  resolveBrainSandboxInstance,
  resolveBrainUrl,
} from '../modules/objectives/brain-client.js';
import { detectAgentRunning } from './objectives.js';
import {
  registeredGroups,
  findSandboxNameConflict,
  isSandboxNameReserved,
  registerGroup,
  releaseSandboxNameReservations,
  reserveSandboxName,
  sandboxNameConflictMessage,
  unregisterGroup,
  updateGroup,
  applyGroupUpdateInMemory,
  serializeSettingsForDb,
  normalizeTaskCheckoutSettings,
  migrateGroupSession,
  regenerateGroupPrompt,
  getGroupByFolder,
  getGroupEntryByFolder,
  childProjectFolders,
} from '../state-manager.js';
import type {
  AttentionItem,
  AttentionResponse,
  AttentionState,
  ProjectModeStatuses,
  ProjectRevision,
  ProjectSettings,
  RegisteredGroup,
} from '../types.js';
import { effectiveMaxParallel, resolveToolCallDisplay } from '../types.js';
import {
  stopAllProjectTasks,
  cancelQueuedProjectTasks,
  getRunningTaskIds as getInMemoryRunningTaskIds,
  getQueuedTaskIds,
  drainProjectQueue,
} from '../modules/kanban/task-executor.js';
import {
  reconcileSandboxPool,
  killChatAgentProcess,
} from '../mcp/mcp-runner.js';
import { syncCarapaMailRelayToken } from '../sandbox/relay-token-sync.js';
import {
  checkReparentAllowed,
  ProjectReparentError,
  reparentProject,
  withReparentMutex,
} from '../modules/projects/reparent-project.js';
import { reconcileSandboxMounts } from '../sandbox/process.js';
import { objectiveWorkDirFor } from '../modules/objectives/work-dir.js';
import {
  shouldSyncProxyHostnameAliases,
  syncProxyHostnameAliases,
} from '../sandbox/proxy-alias-sync.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import { InFlightCoalescer } from '../lib/in-flight-coalescer.js';
import { logger } from '../logger.js';
import {
  isReservedMainFolder,
  isReservedProjectFolder,
} from '../modules/projects/reserved-folders.js';
import { getVectorStoreHooks } from '../modules/vector-store/hooks.js';
import { STAGE_ID_PATTERN, validateStages } from '../modules/kanban/stages.js';
import {
  inheritParentStages,
  StageInheritanceError,
} from '../modules/project-setup/stage-inheritance.js';
import {
  DATA_DIR,
  ASSISTANT_NAME,
  SHOW_SANDBOX_PORTS,
  ENABLE_NGINX_PROXY,
  AGENT_CMD,
  MEETING_LANGUAGES,
  BUILD_VERSION,
  BUILD_TIME,
  BOARD_SELF_DEPLOY_ENABLED,
  ENABLE_KANBAN,
  ENABLE_CHAT,
  ENABLE_OBJECTIVES,
} from '../config.js';
import { getGroupDir } from '../group-dir.js';
import {
  addFileSizesAt,
  listDirectoryAt,
  walkFilesAt,
} from '../lib/file-tree.js';
import {
  createFileThumbnail,
  isImageFilePath,
  MAX_THUMBNAIL_SOURCE_BYTES,
  readHandleBounded,
} from '../lib/file-thumbnail.js';
import {
  isSafeRelativePath,
  detectMimetypeForHandle,
  isTextMimetype,
  parseChunkParams,
  applyUtf8SafeWindow,
  MAX_TEXT_READ_BYTES,
  setRawFileHeaders,
} from '../lib/file-content.js';
import {
  GroupFsError,
  copyTree,
  lstatAt,
  openDirAt,
  openFileAt,
  openGroupDir,
  openParentDir,
  removeAt,
  renameAt,
  sendPinnedFile,
  type PinnedDir,
} from '../lib/group-fs.js';
import type { GroupFilesResponse } from '../types.js';
import {
  EditableFileError,
  loadEditableLocalFile,
  replaceEditableLocalFile,
  type EditableFileSource,
} from '../lib/editable-local-file.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import {
  deleteGroupPath,
  GroupFileOpError,
  moveGroupPath,
  renameGroupPath,
} from '../lib/group-file-ops.js';
import type {
  GroupFileOpOptions,
  GroupFileOpResult,
} from '../lib/group-file-ops.js';
import {
  effectiveSandboxSettings,
  projectDeletionSandboxTarget,
  validateInheritedSandboxUpdate,
} from '../sandbox/effective-settings.js';
import {
  MAX_LEN,
  lenError,
  readProjectPrompt,
  writeProjectPrompt,
  deleteProjectPrompt,
  readStarterPrompts,
  writeStarterPrompts,
  deleteStarterPrompts,
  readPrompt,
  writePrompt,
  seedDefaultWorkerPrompt,
  deletePrompt,
  userCanAccessGroup,
  userHasExplicitGroupAccess,
  canAccessProject,
  explicitLevelAtLeast,
  requireSignedInUser,
  canEditProjectLocalFiles,
} from './_helpers.js';

import { loadChatModePrompt } from '../prompt-loader.js';
import { shellQuote } from '../utils.js';
import {
  fetchDefaultBranch,
  getDefaultBranchSyncStatus,
  isLocalRepoMode,
  pullDefaultBranchFastForward,
  recordPushedDefaultBranch,
  withProjectGitLock,
  runGitInRepo,
} from '../lib/git-ops.js';
import {
  normalizeDiscoveryOptions,
  reconcileDiscoveredRepositories,
  scanParentWorkspace,
  validateDiscoveryRequest,
} from '../modules/projects/repository-discovery.js';
import {
  getGroupStages,
  getInitialStage,
  listCoStageOptions,
  listAbVariantSuffixes,
} from '../modules/kanban/stages.js';
import {
  planStageMigrations,
  StageMigrationValidationError,
  StageRemovalConflictError,
} from '../modules/kanban/stage-configuration.js';
import { importIssuesForProject } from '../modules/kanban/issue-import.js';
import { getRunsForTask } from '../db/active-runs.js';
import { findMergePending } from '../modules/kanban/tools.js';
import { readTaskMessages } from '../modules/transcripts/transcript-store.js';

// Sub-routers
import tasksRouter from './tasks.js';
import conversationsRouter, { DEFAULT_CHAT_MODES } from './conversations.js';
import conversationSharesRouter from './conversation-shares.js';
import conversationExportRouter from './conversation-export.js';
import cronjobsRouter from './cronjobs.js';
import datasetsRouter from './datasets.js';
import memoriesRouter from './memories.js';
import meetingsRouter from './meetings.js';
import proposalsRouter from './proposals.js';
import fileFavoritesRouter from './file-favorites.js';
import {
  dropDeletedFavorites,
  requireSettledFavoriteMoves,
  settleFavoriteMoves,
  withFavoritesLock,
} from '../lib/file-favorite-sync.js';
import { conversationAiUsersRouter } from './ai-users.js';
import { availableHarnessIds } from '../modules/boxes/harness-availability.js';
import { isBoxReachable } from '../modules/boxes/routing.js';

const router = Router();
const statusSummaryRequests = new InFlightCoalescer();
const STATUS_SUMMARY_CACHE_TTL_MS = 2_000;
const STATUS_SUMMARY_CACHE_MAX_ENTRIES = 256;
const statusSummaryCache = new Map<
  string,
  {
    value: Awaited<ReturnType<typeof getProjectsStatusSummary>>;
    expiresAt: number;
  }
>();

let emitStageMigrationTaskUpdated = (task: unknown): void => {
  broadcast({ type: 'task_updated', payload: task });
};

async function enrichStagePrompts(
  stages: ProjectSettings['stages'],
  folder: string,
  parentId: string | undefined,
) {
  return Promise.all(
    (stages ?? []).map(async (stage) => {
      // Only well-formed stage IDs may reach the filesystem (defense in depth;
      // persisted stages are validated on write).
      if (!stage.id || !STAGE_ID_PATTERN.test(stage.id)) return stage;
      const workerPrompt = await readPrompt(
        folder,
        parentId,
        `stage-${stage.id}.md`,
      );
      return { ...stage, workerPrompt: workerPrompt ?? undefined };
    }),
  );
}

function normalizeChatModeId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

function loadChatModePrompts(
  chatModes: Array<{ id?: string }>,
  folder: string,
  parentId: string | undefined,
): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const mode of chatModes) {
    const modeId = normalizeChatModeId(mode?.id);
    if (!modeId) continue;
    const prompt = loadChatModePrompt(folder, parentId, modeId);
    if (prompt) prompts[modeId] = prompt;
  }
  return prompts;
}

/** @internal Test hook for observing post-commit migration broadcasts. */
export function setStageMigrationTaskUpdatedEmitterForTests(
  emitter: ((task: unknown) => void) | undefined,
): void {
  emitStageMigrationTaskUpdated =
    emitter ?? ((task) => broadcast({ type: 'task_updated', payload: task }));
}

type ProjectQueueDrainRunner = typeof drainProjectQueue;
let projectQueueDrainRunner: ProjectQueueDrainRunner = drainProjectQueue;

/** @internal Test hook for observing post-save queue drains without fixed sleeps. */
export function setProjectQueueDrainRunnerForTests(
  runner: ProjectQueueDrainRunner | undefined,
): void {
  projectQueueDrainRunner = runner ?? drainProjectQueue;
}

export async function validateStageMainAiUserIds(
  stages: Array<Record<string, unknown>>,
): Promise<string | undefined> {
  for (const stage of stages) {
    const mainAiUserId = stage.mainAiUserId;
    if (mainAiUserId === undefined || mainAiUserId === null) continue;
    if (typeof mainAiUserId !== 'string' || !mainAiUserId.trim()) {
      return 'Stage mainAiUserId must be a non-empty AI user ID';
    }
    const aiUser = await getAiUserRow(mainAiUserId.trim());
    if (!aiUser?.enabled) {
      return 'Stage mainAiUserId must reference an enabled AI user';
    }
    stage.mainAiUserId = mainAiUserId.trim();
  }
  return undefined;
}
export function validateTaskCheckoutSettingsWrite(
  settings: unknown,
): string | undefined {
  if (!isRecord(settings)) {
    return undefined;
  }
  const record = settings as Record<string, unknown>;
  if ('createBranchPerTask' in record) {
    return 'createBranchPerTask is retired; use taskCheckoutMode';
  }
  if (
    'taskCheckoutMode' in record &&
    record.taskCheckoutMode !== 'shared' &&
    record.taskCheckoutMode !== 'branch' &&
    record.taskCheckoutMode !== 'worktree'
  ) {
    return 'taskCheckoutMode must be shared, branch, or worktree';
  }
  return undefined;
}

/**
 * Validate the shared-sandbox portion of a prospective settings update before
 * the route mutates parent links, names, folders, prompts, or persisted settings.
 */
export function validateProspectiveSharedSandboxSettings(
  current: ProjectSettings | undefined,
  update: Record<string, unknown>,
): string | undefined {
  if ('sandboxOwnership' in update) {
    const ownership = update.sandboxOwnership;
    if (ownership !== 'standalone' && ownership !== 'shared') {
      return 'sandboxOwnership must be either "standalone" or "shared"';
    }
  }

  for (const key of [
    'sharedWorkspaceHostLocation',
    'sharedWorkspaceContainerRoot',
    'webRootPath',
  ] as const) {
    if (key in update && typeof update[key] !== 'string') {
      return `${key} must be a string`;
    }
  }

  const prospective: ProjectSettings = { ...(current ?? {}) };
  for (const key of [
    'sandboxOwnership',
    'sharedWorkspaceHostLocation',
    'sharedWorkspaceContainerRoot',
    'webRootPath',
    'isParent',
  ] as const) {
    if (key in update) {
      (prospective as Record<string, unknown>)[key] = update[key] ?? undefined;
    }
  }

  if (
    prospective.sandboxOwnership !== undefined &&
    prospective.sandboxOwnership !== 'standalone' &&
    prospective.sandboxOwnership !== 'shared'
  ) {
    return 'sandboxOwnership must be either "standalone" or "shared"';
  }
  if (
    prospective.sharedWorkspaceHostLocation !== undefined &&
    typeof prospective.sharedWorkspaceHostLocation !== 'string'
  ) {
    return 'sharedWorkspaceHostLocation must be a string';
  }
  if (
    prospective.sharedWorkspaceContainerRoot !== undefined &&
    typeof prospective.sharedWorkspaceContainerRoot !== 'string'
  ) {
    return 'sharedWorkspaceContainerRoot must be a string';
  }
  if (
    prospective.webRootPath !== undefined &&
    typeof prospective.webRootPath !== 'string'
  ) {
    return 'webRootPath must be a string';
  }
  if (
    prospective.sandboxOwnership === 'shared' &&
    prospective.isParent !== true
  ) {
    return 'sandboxOwnership "shared" is only valid for a parent project';
  }
  if (
    prospective.sharedWorkspaceHostLocation &&
    !path.isAbsolute(prospective.sharedWorkspaceHostLocation)
  ) {
    return 'sharedWorkspaceHostLocation must be an absolute host path';
  }
  if (
    prospective.sharedWorkspaceContainerRoot &&
    !path.posix.isAbsolute(prospective.sharedWorkspaceContainerRoot)
  ) {
    return 'sharedWorkspaceContainerRoot must be an absolute container path';
  }
  if (prospective.webRootPath) {
    const webRootPath = prospective.webRootPath.trim();
    if (path.posix.isAbsolute(webRootPath)) {
      return 'webRootPath must be relative to the sandbox workspace';
    }
    if (
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(webRootPath) ||
      webRootPath
        .split('/')
        .some((component) => component === '..' || component === '.')
    ) {
      return 'webRootPath must be a safe relative path within the sandbox workspace';
    }
  }

  const instance =
    'defaultSandboxInstance' in update
      ? (update.defaultSandboxInstance ?? undefined)
      : current?.defaultSandboxInstance;
  if (instance !== undefined && typeof instance !== 'string') {
    return 'defaultSandboxInstance must be a string';
  }
  if (
    typeof instance === 'string' &&
    instance &&
    !/^[a-z0-9][a-z0-9_-]*$/.test(instance)
  ) {
    return `Invalid defaultSandboxInstance "${instance}": must consist only of lowercase alphanumeric characters, hyphens, and underscores, and start with a letter or number`;
  }

  const roots =
    'workspaceRoots' in update
      ? (update.workspaceRoots ?? undefined)
      : current?.workspaceRoots;
  if (roots !== undefined) {
    if (!Array.isArray(roots)) {
      return 'workspaceRoots must be an array of absolute paths';
    }
    if (roots.length > 8) return 'workspaceRoots is capped at 8 entries';
    for (const entry of roots) {
      if (typeof entry !== 'string') {
        return 'workspaceRoots entries must be strings';
      }
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (trimmed.length > 256) {
        return `workspaceRoots entry "${trimmed.slice(0, 60)}…" exceeds 256 characters`;
      }
      if (!trimmed.startsWith('/')) {
        return `workspaceRoots entry "${trimmed}" must be an absolute POSIX path`;
      }
      const normalized = path.posix.normalize(trimmed);
      if (normalized === '/' || normalized.split('/').includes('..')) {
        return `workspaceRoots entry "${trimmed}" is not a valid container path`;
      }
    }
  }
  const proxyAliases =
    'proxyHostnameAliases' in update
      ? (update.proxyHostnameAliases ?? undefined)
      : current?.proxyHostnameAliases;
  if (proxyAliases !== undefined) {
    if (!Array.isArray(proxyAliases)) {
      return 'proxyHostnameAliases must be an array of hostnames';
    }
    if (proxyAliases.length > 8) {
      return 'proxyHostnameAliases is capped at 8 entries';
    }
    for (const entry of proxyAliases) {
      if (typeof entry !== 'string') {
        return 'proxyHostnameAliases entries must be strings';
      }
      const hostname = entry.trim().toLowerCase().replace(/\.$/, '');
      if (
        !hostname ||
        hostname.length > 253 ||
        !hostname.includes('.') ||
        !hostname
          .split('.')
          .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
      ) {
        return `Invalid proxy hostname alias "${entry}"`;
      }
    }
  }
  const extraMounts =
    'extraMounts' in update ? (update.extraMounts ?? undefined) : undefined;
  if (extraMounts !== undefined) {
    if (!Array.isArray(extraMounts)) {
      return 'extraMounts must be an array of absolute host paths';
    }
    if (extraMounts.length > 2) return 'extraMounts is capped at 2 entries';
    for (const entry of extraMounts) {
      if (typeof entry !== 'string')
        return 'extraMounts entries must be strings';
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (
        trimmed.length > 256 ||
        !path.isAbsolute(trimmed) ||
        trimmed.split('/').includes('..')
      ) {
        return `extraMounts entry "${trimmed.slice(0, 60)}" must be an absolute host path without ".."`;
      }
    }
  }
  return undefined;
}

export function validateProspectiveParentId(
  group: RegisteredGroup,
  parentId: string | undefined,
  lookup: (folder: string) => RegisteredGroup | undefined = getGroupByFolder,
): string | undefined {
  if (!parentId) return undefined;
  if (parentId === group.folder) {
    return 'A project cannot be its own parent';
  }
  const parent = lookup(parentId);
  if (!parent) return `Parent project "${parentId}" not found`;

  const visited = new Set<string>();
  let cursor: RegisteredGroup | undefined = parent;
  while (cursor) {
    if (cursor.folder === group.folder) {
      return 'Parent project relationship would create a cycle';
    }
    if (visited.has(cursor.folder)) {
      return 'Parent project hierarchy contains a cycle';
    }
    visited.add(cursor.folder);
    cursor = cursor.parentId ? lookup(cursor.parentId) : undefined;
  }
  return undefined;
}

export function validateProspectiveSharedSandboxParent(
  current: ProjectSettings | undefined,
  update: Record<string, unknown>,
  parentId: string | undefined,
): string | undefined {
  const ownership =
    'sandboxOwnership' in update
      ? (update.sandboxOwnership ?? undefined)
      : current?.sandboxOwnership;
  if (ownership === 'shared' && parentId) {
    return 'sandboxOwnership "shared" is only valid for a top-level project without a parent';
  }
  return undefined;
}

function normalizedExtraMounts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    cleaned.add(path.normalize(entry.trim()));
  }
  return cleaned.size ? [...cleaned] : undefined;
}

/**
 * Whether a request value for a path list differs from the stored one, both
 * compared as they would be stored (in order). Missing, null, empty and blank
 * lists are the same value; anything that is not a list counts as a change.
 */
function pathListChanged(
  incoming: unknown,
  stored: unknown,
  normalize: (raw: unknown) => string[] | undefined,
): boolean {
  if (incoming != null && !Array.isArray(incoming)) return true;
  return (
    JSON.stringify(normalize(incoming) ?? []) !==
    JSON.stringify(normalize(stored) ?? [])
  );
}

function normalizedWorkspaceRoots(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    cleaned.add(path.posix.normalize(entry.trim()));
  }
  return cleaned.size ? [...cleaned] : undefined;
}
export async function rewriteRenamedProjectReferences(
  oldFolder: string,
  newFolder: string,
  groups: Record<string, RegisteredGroup> = registeredGroups,
  updater: (
    jid: string,
    updates: Partial<RegisteredGroup>,
  ) => Promise<void> = updateGroup,
): Promise<void> {
  // Snapshot before updating: linked entries can share the same group object,
  // so comparing against a mutating `group.folder` skips later entries.
  const entries = Object.entries(groups).map(([entryJid, entryGroup]) => ({
    entryJid,
    folder: entryGroup.folder,
    parentId: entryGroup.parentId,
    memorySourceProjects: entryGroup.settings?.memorySourceProjects,
  }));
  for (const entry of entries) {
    const updates: Partial<RegisteredGroup> = {};
    if (entry.folder === oldFolder) updates.folder = newFolder;
    if (entry.parentId === oldFolder) updates.parentId = newFolder;
    if (entry.memorySourceProjects?.includes(oldFolder)) {
      updates.settings = {
        ...groups[entry.entryJid].settings,
        memorySourceProjects: entry.memorySourceProjects.map((folder) =>
          folder === oldFolder ? newFolder : folder,
        ),
      };
    }
    if (Object.keys(updates).length > 0) {
      await updater(entry.entryJid, updates);
    }
  }
}

export async function removeDeletedMemorySourceReferences(
  deletedFolder: string,
  groups: Record<string, RegisteredGroup> = registeredGroups,
  updater: (
    jid: string,
    updates: Partial<RegisteredGroup>,
  ) => Promise<void> = updateGroup,
): Promise<void> {
  for (const [jid, candidate] of Object.entries(groups)) {
    const sources = candidate.settings?.memorySourceProjects;
    if (!sources?.includes(deletedFolder)) continue;
    await updater(jid, {
      settings: {
        ...candidate.settings,
        memorySourceProjects: sources.filter(
          (source) => source !== deletedFolder,
        ),
      },
    });
  }
}

/** Lowercased path below /api/projects/:pid (Express routes case-insensitively). */
function projectRouteTail(req: any): string {
  const url: string = req.originalUrl || req.url || '';
  // Express routes on the pathname, so reduce an absolute-form request target
  // (`http://host/api/projects/...`) to it before stripping the project prefix.
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .replace(/^(?:\/api)?\/projects\/[^/?#]+/i, '')
    .split(/[?#]/)[0]
    .toLowerCase();
}

/**
 * The only /projects/<literal> collection routes, as `METHOD tail` below the
 * reserved name. Every other path under a reserved name (e.g.
 * /projects/attention/tasks) is a normal project route and must be guarded.
 */
const COLLECTION_ROUTES: Record<string, readonly string[]> = {
  attention: ['GET ', 'HEAD ', 'POST /dismiss', 'POST /dismiss-all'],
  'status-summary': ['GET ', 'HEAD '],
  order: ['PATCH '],
};

function isCollectionRoute(req: any, pid: string): boolean {
  const routes = COLLECTION_ROUTES[pid.toLowerCase()];
  if (!routes) return false;
  const method = String(req.method || 'GET').toUpperCase();
  const tail = projectRouteTail(req).replace(/\/+$/, '');
  return routes.includes(`${method} ${tail}`);
}

export async function enforceProjectAccess(
  req: any,
  res: any,
  next: any,
): Promise<void> {
  const pid = req.params.pid;
  if (!pid) return next();
  // Collection endpoints share the /projects/:pid shape but are not projects.
  if (isCollectionRoute(req, pid)) return next();

  // Agent bearer tokens do not populate authUser. They are still scoped
  // credentials, so enforce their group boundary here rather than allowing
  // them to bypass the project guard entirely.
  if (!req.authUser) {
    if (req.tokenScope && !(await userCanAccessGroup(req, pid))) {
      // Parent tokens carry tasks:* for child projects; admit only the
      // read-only task list (not /tasks/* transcripts, output or diffs).
      const method = String(req.method || 'GET').toUpperCase();
      if (
        (method === 'GET' || method === 'HEAD') &&
        projectRouteTail(req) === '/tasks' &&
        hasPermission(req.tokenScope.permissions, pid, 'tasks:read')
      ) {
        next();
        return;
      }
      res.status(403).json({ error: 'Access denied to this project' });
      return;
    }
    next();
    return;
  }

  // The member list authorizes itself (admins and the project owner only), so
  // an admin outside a project owned by another user must still reach it.
  if (
    /^\/members\/?$/.test(projectRouteTail(req)) &&
    ['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())
  )
    return next();

  // Admin bypass is intentionally narrow: admins reach their own projects and
  // ownerless ones, but a project owned by another user is closed to them.
  // There they get exactly their membership level, like any user. Without
  // this check, an admin holding a stale URL (or guessing a folder name) could
  // read another user's chats.
  if (adminBypassesProject(req.authUser, pid)) return next();

  const access = await getProjectAccess(req.authUser.id, pid);
  if (!access)
    return res.status(403).json({ error: 'Access denied to this project' });
  req.projectAccess = access;

  const tail = projectRouteTail(req);
  const isUnder = (prefix: string) =>
    tail === prefix || tail.startsWith(prefix + '/');

  if (access.kind === 'implicit') {
    // Chat-only (implicit) users may only hit conversation/message routes — anything
    // else under the project (board, tasks, cronjobs, settings) is denied.
    const allowed = ['/conversations', '/messages', '/live-activity'];
    if (!allowed.some(isUnder))
      return res.status(403).json({ error: 'Access denied to this project' });
  } else if (access.level === 'viewer') {
    // Denylist: viewers may not write under the paths listed below (project
    // root, tasks, cronjobs, dataset tasks, stop, scheduled tasks, git,
    // artifacts, regenerate-prompt, inherit-stages, link-whatsapp, integrations, meetings (not
    // for integration keys), and objective create/update/delete). Conversation
    // creation is guarded in its route for project and objective chats alike.
    // Any other write route is NOT blocked here, so add new write routes to
    // this list. Participation routes
    // (messages, upload, preferences, read state, pending resolution,
    // dashboard tickets/refresh) are intentionally left open.
    const method = String(req.method || 'GET').toUpperCase();
    const isRead =
      method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    // Not isUnder(''): that would match every path.
    const isProjectRoot = tail === '' || tail === '/';
    const isIntegration = req.authCredentialKind === 'integration';
    const guarded =
      isProjectRoot ||
      [
        '/tasks',
        '/cronjobs',
        '/dataset-tasks',
        '/stop',
        '/scheduled-tasks',
        '/git',
        '/artifacts',
        '/regenerate-prompt',
        '/inherit-stages',
        '/link-whatsapp',
        '/test-brain-connection',
        '/integrations',
      ].some(isUnder) ||
      // Integration keys keep meeting access: their scopes were already
      // checked, and they act for the key owner, not an interactive viewer.
      (!isIntegration && isUnder('/meetings')) ||
      /^\/objectives(\/[^/]+)?\/?$/.test(tail);
    if (!isRead && guarded)
      return res
        .status(403)
        .json({ error: 'Viewers have read-only access to this project' });
  }
  next();
}

/**
 * Discovery creates projects, so scoped agent tokens and viewers are read-only
 * here. An admin passes unless `enforceProjectAccess` resolved them through
 * membership (a project owned by another user): then only that level counts.
 */
export function canRunRepositoryDiscovery(req: any): boolean {
  if (!req.authUser) return false;
  if (req.authUser.role === 'admin' && !req.projectAccess) return true;
  return explicitLevelAtLeast(req.projectAccess, 'editor');
}

/**
 * Settings that decide which host folder (LOCAL_REPO) or which remote
 * (GIT_REPO) a sandbox receives. Only the project owner may change them.
 */
export const REPOSITORY_CONNECTION_FIELDS = [
  'repositoryLocation',
  'repositoryUrl',
  'repositoryRelativePath',
  'sharedWorkspaceHostLocation',
] as const;

/**
 * Repository selection is a user-owned capability, never an agent setting. An
 * admin passes unless resolved through membership of a project owned by
 * another user: then only an owner membership counts.
 */
export function canUpdateRepositoryConnection(req: any): boolean {
  if (!req.authUser) return false;
  if (req.authUser.role === 'admin' && !req.projectAccess) return true;
  return explicitLevelAtLeast(req.projectAccess, 'owner');
}

/** Blank, null and undefined all mean "no deploy service". */
function normalizeDeployService(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Blank, null and undefined all mean "not set"; other values compare exactly. */
function normalizeSandboxBindingString(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim() ? value : '';
  return value;
}

/** A folder rename found its target taken while it ran; the request answers 409. */
class FolderNameTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderNameTakenError';
  }
}

/**
 * Deletes the Box keys on a sandbox name this request releases, before the
 * change that releases it is saved. A Box failure becomes a `BoxCleanupError`
 * (502) with `refusal` as its message; `logContext` goes into the log lines only
 * (never key ids).
 */
async function deleteReleasedProjectKeys(
  name: string,
  logContext: Record<string, unknown>,
  refusal: string,
  removedNotice: string,
): Promise<void> {
  let removed: number;
  try {
    removed = await deleteProjectKeys(name);
  } catch (err) {
    logger.error(
      { ...logContext, err: String(err) },
      'Could not delete the released project integration keys; request refused',
    );
    throw new BoxCleanupError(refusal);
  }
  if (removed > 0) logger.warn({ ...logContext, removed }, removedNotice);
}

/**
 * Removes the sandbox name binding values (stack, service, instance, ownership)
 * that equal the stored ones, so they are neither validated, checked against
 * publication or inheritance, nor saved: the settings dialog resends the whole
 * form. Returns whether the request still sets, changes or clears the binding.
 */
function dropUnchangedSandboxBinding(
  settings: Record<string, unknown>,
  stored: ProjectSettings | undefined,
): boolean {
  let changed = false;
  for (const key of [
    'defaultSandbox',
    'defaultSandboxService',
    'defaultSandboxInstance',
  ] as const) {
    if (!(key in settings)) continue;
    const value = settings[key];
    if (
      (value === null || typeof value === 'string') &&
      normalizeSandboxBindingString(value) ===
        normalizeSandboxBindingString(stored?.[key])
    ) {
      delete settings[key];
    } else changed = true;
  }
  if ('sandboxOwnership' in settings) {
    const value = settings.sandboxOwnership;
    if (
      (value === null || value === 'standalone' || value === 'shared') &&
      (value === 'shared') === (stored?.sandboxOwnership === 'shared')
    ) {
      delete settings.sandboxOwnership;
    } else changed = true;
  }
  return changed;
}

/**
 * Whether the caller may change a project's display order. Mirrors the guard:
 * admins manage their own and ownerless projects, not those owned by another
 * user; other users need explicit owner/editor membership.
 */
async function canReorderProject(
  user: { id: string; role?: string },
  group: RegisteredGroup,
): Promise<boolean> {
  return canAccessProject(user, group.folder, { min: 'editor' });
}

/**
 * Whether the caller may place a project under `parentId`. A child inherits the
 * parent's folder tree and shared sandbox, so only users who can manage the
 * parent qualify: admins (except for a parent owned by another user) and
 * explicit owners/editors. Agent and share tokens never carry a user and are refused.
 * A parent that does not exist yields false for non-admins, so callers can
 * answer identically for "missing" and "not yours".
 */
async function canAttachToParent(
  caller: { authUser?: { id: string; role?: string } },
  parentId: string,
): Promise<boolean> {
  const user = caller.authUser;
  if (!user) return false;
  const parent = getGroupByFolder(parentId);
  // A missing parent is left to the caller's existing 400 for admins; everyone
  // else is denied, indistinguishable from a parent they cannot manage.
  if (!parent) return user.role === 'admin';
  return canReorderProject(user, parent);
}

/**
 * The discovered projects the discovering user is added to as a member: every
 * newly created child (it inherits the parent's owner), and the existing ones
 * except, for an admin, a child owned by another user: discovery must not
 * become a way for an admin to grant themselves access to it.
 */
export function discoveryMembershipProjectIds(
  report: {
    created: { projectId?: string | null }[];
    existing: { projectId?: string | null }[];
  },
  user: { id: string; role?: string },
): string[] {
  const ids = new Set<string>();
  for (const entry of report.created)
    if (entry.projectId) ids.add(entry.projectId);
  for (const entry of report.existing) {
    if (!entry.projectId) continue;
    if (user.role === 'admin' && isOwnedByOtherUser(user.id, entry.projectId))
      continue;
    ids.add(entry.projectId);
  }
  return [...ids];
}

const PARENT_ACCESS_DENIED = {
  error: 'You do not have access to the specified parent project',
};

router.use('/projects/:pid', enforceProjectAccess);

// Mount domain sub-routers — they all use /projects/:pid/… paths
router.use(mailRouter);
router.use(tasksRouter);
router.use(conversationsRouter);
router.use(conversationSharesRouter);
router.use(conversationExportRouter);
router.use(conversationAiUsersRouter);
router.use(cronjobsRouter);
router.use(datasetsRouter);
// Objectives router is mounted by the objectives module via getModuleRouters()
router.use(memoriesRouter);
router.use(meetingsRouter);
router.use(proposalsRouter);
router.use(fileFavoritesRouter);

// --- Config ---

import { getModuleConfigFlags } from '../modules/loader.js';
import {
  getConfigurableToolsets,
  getDefaultToolsets,
  resetToolsets,
} from '../modules/tools/registry.js';
import {
  normalizeDisabledSkills,
  reconcileDisabledSkills,
} from '../sandbox/disabled-skills.js';
import { isRecord } from '../lib/type-guards.js';

// Project membership is enforced above; reading the app link does not grant
// publishing permission or access beyond the app's own network/auth policy.
router.get('/projects/:pid/published-app', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json(await getAppPublication(group));
  } catch (error) {
    res.status(502).json({ error: String(error) });
  }
});
router.put('/projects/:pid/published-app', async (req: any, res) => {
  if (!canRunRepositoryDiscovery(req))
    return res.status(403).json({ error: 'Project editor access is required' });
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  const effective = resolveEffectiveSandbox(group);
  if (
    effective.inherited &&
    !adminBypassesProject(req.authUser, effective.ownerProjectId)
  ) {
    const access = await getProjectAccess(
      req.authUser.id,
      effective.ownerProjectId,
    );
    if (!explicitLevelAtLeast(access, 'editor'))
      return res.status(403).json({
        error:
          'Publishing from a shared sandbox requires editor access to its owning project',
      });
  }
  const parsed = appPublicationInput.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    });
  try {
    res.json(await setAppPublication(group, parsed.data));
  } catch (error) {
    res.status(502).json({ error: String(error) });
  }
});

router.get('/chat-agents', (_req, res) => {
  res.json(getChatAgents());
});

router.get('/runtime-catalog', (_req, res) => {
  res.json(getRuntimeCatalog());
});

router.get('/projects/:pid/harnesses', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  res.json({ harnessIds: await availableHarnessIds(group) });
});

router.get('/projects/:pid/support-runtimes', (req, res) => {
  const defaults = getRuntimeCatalog().defaults;
  const toSupportRuntime = (selection: RuntimeSelection | undefined) => {
    if (!selection) return null;
    const runtime = resolveRuntimeSelection(selection);
    if (!isDirectRuntime(runtime) || !runtime.baseUrl || !runtime.model) {
      return null;
    }
    return {
      baseUrl: runtime.baseUrl,
      model: runtime.model,
      wireApi: runtime.wireApi ?? 'chat_completions',
      reasoningEffort: runtime.reasoning_effort ?? null,
      maxTokens: runtime.max_tokens ?? null,
    };
  };
  // An unset or non-HTTP role selection falls back to the chat default; there
  // is no model fallback outside board_agents.jsonc.
  const resolveRole = (role: 'curator' | 'reflector') =>
    toSupportRuntime(defaults[role]) ?? toSupportRuntime(defaults.chat);

  const curator = resolveRole('curator');
  const reflector = resolveRole('reflector');
  if (!curator || !reflector) {
    return res.status(422).json({
      error:
        'defaults.curator and defaults.reflector (or defaults.chat as their fallback) must select HTTP-capable direct runtimes',
    });
  }
  res.json({
    curator,
    reflector,
  });
});

/**
 * GET /api/projects/:pid/objectives/:oid/runtime-tiers
 * Mounted here, before the module routers' device-signature gate, so the
 * brain can call it with its per-project agent token like `support-runtimes`.
 * The runtime objective events run on now, plus the runtime each Auto tier
 * (fast|balanced|frontier) resolves to, so the brain can pick a tier for an
 * event it originates instead of a hard-coded model id.
 */
router.get('/projects/:pid/objectives/:oid/runtime-tiers', async (req, res) => {
  const objective = await getObjective(req.params.oid);
  if (!objective || objective.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  try {
    return res.json(resolveObjectiveRuntimeTiers(objective));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res
      .status(err instanceof PrivacyRefusal ? 403 : 422)
      .json({ error: message });
  }
});

/**
 * GET /api/projects/:pid/runtime-tiers[?harness=<id>]
 * The same tier contracts for runs without an objective (project chats, task
 * runs). Without `harness` the project layer decides; with it, that
 * harness's Auto tier map is resolved. Unknown or not installed harness: 400.
 */
router.get('/projects/:pid/runtime-tiers', async (req, res) => {
  if (!getGroupByFolder(req.params.pid))
    return res.status(404).json({ error: 'Project not found' });
  const harness = req.query.harness;
  if (harness !== undefined && (typeof harness !== 'string' || !harness))
    return res.status(400).json({ error: 'harness must be a harness id' });
  try {
    return res.json(await resolveProjectRuntimeTiers(req.params.pid, harness));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof PrivacyRefusal
        ? 403
        : err instanceof RuntimeTiersHarnessError
          ? 400
          : 422;
    return res.status(status).json({ error: message });
  }
});

router.get('/config', (req: any, res) => {
  res.json({
    assistantName: ASSISTANT_NAME,
    showSandboxPorts: SHOW_SANDBOX_PORTS,
    enableNginxProxy: ENABLE_NGINX_PROXY,
    defaultAgentCmd: AGENT_CMD,
    buildVersion: BUILD_VERSION,
    buildTime: BUILD_TIME,
    enableBoardSelfDeploy: BOARD_SELF_DEPLOY_ENABLED,
    meetingLanguages: MEETING_LANGUAGES,
    toolsets: {
      available: getConfigurableToolsets(),
      defaults: getDefaultToolsets(),
    },
    ...getModuleConfigFlags(),
  });
});

// --- Projects ---

/** The brain's latest token rejection for this project, or null. */
function brainAuthRejected(
  folder: string,
): { status: number; at: string } | null {
  const status = getBrainAuthStatus(folder);
  return status && !status.ok && status.status !== undefined
    ? { status: status.status, at: status.at }
    : null;
}

/** Build the same representation for revisions, disk monitoring, and responses. */
async function projectData(jid: string, g: RegisteredGroup) {
  const [systemPrompt, workerPrompt, loadedStarterPrompts] = await Promise.all([
    readProjectPrompt(g.folder),
    readPrompt(g.folder, g.parentId, 'worker.md'),
    readStarterPrompts(g.folder),
  ]);
  const starterPrompts = loadedStarterPrompts || g.settings?.starterPrompts;
  const {
    brainAuthToken: _brainAuthToken,
    carapaMailToken: _carapaMailToken,
    ...safeSettings
  } = normalizeTaskCheckoutSettings(g.settings ?? {});
  // Enrich stages with workerPrompt loaded from filesystem
  const enrichedStages = await enrichStagePrompts(
    safeSettings.stages,
    g.folder,
    g.parentId,
  );
  const stagesInherited = !!g.parentId && !safeSettings.stages?.length;
  const effectiveStageOwner =
    stagesInherited && g.parentId ? getGroupByFolder(g.parentId) : g;
  const effectiveStages = await Promise.all(
    getGroupStages(g, getGroupByFolder).map(async (stage) => ({
      ...stage,
      workerPrompt: effectiveStageOwner
        ? await readPrompt(
            effectiveStageOwner.folder,
            effectiveStageOwner.parentId,
            `stage-${stage.id}.md`,
          )
        : undefined,
    })),
  );
  const chatModes =
    Array.isArray(safeSettings.chatModes) && safeSettings.chatModes.length > 0
      ? safeSettings.chatModes
      : [...DEFAULT_CHAT_MODES];
  const chatModePrompts = loadChatModePrompts(
    chatModes as Array<{ id?: string }>,
    g.folder,
    g.parentId,
  );
  const effectiveSandbox = {
    ...effectiveSandboxSettings(g),
    boxOnline: isBoxReachable({ tree: 'group', project: g.folder }),
  };
  const effectivePrivacy = getEffectivePrivacyInfo(g.folder);

  return {
    id: g.folder,
    name: g.name,
    folder: g.folder,
    order: g.order ?? 0,
    trigger: g.trigger,
    userId: g.user_id,
    isMain: !!g.is_main,
    ...(jid.includes('@s.whatsapp.net') || jid.includes('@g.us')
      ? { jid }
      : {}),
    ...(g.parentId ? { parentId: g.parentId } : {}),
    effectiveStages,
    // Alternatives are stripped from effectiveStages; expose the inherited
    // suffixes so a member who only sees this project can offer "Run variants".
    abVariantSuffixes: listAbVariantSuffixes(g, getGroupByFolder),
    // Review/testing alternatives a task can add as extra stages (`co_stages`).
    coStageOptions: listCoStageOptions(g, getGroupByFolder),
    stagesInherited,
    stack: effectiveSandbox.stack,
    effectiveSandbox,
    settings: {
      ...safeSettings,
      codeEnabled: safeSettings.codeEnabled ?? !g.is_main,
      toolCallDisplay: resolveToolCallDisplay(safeSettings.toolCallDisplay),
      effectivePrivacyMode: effectivePrivacy.mode,
      privacyModeInheritedFrom: effectivePrivacy.inheritedFrom,
      brainAuthTokenSet: !!_brainAuthToken,
      brainAuthRejected: brainAuthRejected(g.folder),
      carapaMailTokenSet: !!_carapaMailToken,
      systemPrompt,
      workerPrompt,
      starterPrompts,
      stages: enrichedStages,
      chatModes,
      chatModePrompts,
    },
  };
}

function projectRevision(project: unknown): string {
  return sha256Hex(JSON.stringify(project));
}

function projectSummary<T extends Awaited<ReturnType<typeof projectData>>>(
  project: T,
): T {
  const { systemPrompt, workerPrompt, chatModePrompts, ...settings } =
    project.settings;
  const withoutPrompt = <S extends { workerPrompt?: string }>(stage: S): S => {
    const { workerPrompt, ...rest } = stage;
    return rest as S;
  };
  return {
    ...project,
    settings: { ...settings, stages: settings.stages?.map(withoutPrompt) },
    effectiveStages: project.effectiveStages.map(withoutPrompt),
  } as T;
}

/** One server-side disk reconciliation loop, independent of connected clients. */
export function startProjectChangeMonitor(): () => void {
  let previous: string | undefined;
  let running = false;
  let stopped = false;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const projects = await Promise.all(
        Object.entries(registeredGroups).map(([jid, group]) =>
          projectData(jid, group),
        ),
      );
      const revision = projectRevision(projects);
      if (!stopped && previous !== undefined && previous !== revision) {
        broadcast({ type: 'projects_changed', payload: {} });
      }
      previous = revision;
    } catch (err) {
      logger.warn({ err }, 'Project change reconciliation failed');
    } finally {
      running = false;
    }
  };
  // Membership/preference changes must reach users who just lost access too.
  // This notification carries no project IDs or data; HTTP rechecks access.
  const onChange = () => broadcast({ type: 'projects_changed', payload: {} });
  projectChanges.on('changed', onChange);
  void check();
  const timer = setInterval(() => void check(), 5000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    projectChanges.off('changed', onChange);
  };
}

/**
 * GET /api/projects
 * List registered groups as projects. Human-only: agent credentials are refused.
 */
router.get('/projects', async (_req, res) => {
  if (!requireSignedInUser(_req, res)) return;
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const seen = new Set<string>();
  let entries: Array<{ jid: string; g: (typeof registeredGroups)[string] }> =
    [];
  for (const [jid, g] of Object.entries(registeredGroups)) {
    if (seen.has(g.folder)) continue;
    seen.add(g.folder);
    entries.push({ jid, g });
  }

  const reqAny = _req as any;
  const memberModes = reqAny.authUser
    ? await getMemberModesForUser(reqAny.authUser.id)
    : {};
  // The sidebar shows the *user's* projects, not the platform's. Admins still
  // have privileged access to any project via the `/projects/:pid` middleware
  // and admin-only endpoints, but their default listing is scoped to "what I
  // own or what's been explicitly shared with me" — same as a regular user.
  if (reqAny.authUser) {
    const uid = reqAny.authUser.id;
    const [explicit, implicit] = await Promise.all([
      getProjectsForUser(uid),
      getImplicitProjectIdsForUser(uid),
    ]);
    const allowed = new Set([...explicit, ...implicit]);
    entries = entries.filter(({ g }) => {
      // is_main groups are private to their owner; never expose someone else's
      // personal main, even if a stray project_members or conversation row would
      // otherwise admit the viewer.
      if (g.is_main) return g.user_id === uid;
      // For ordinary projects: owners get implicit access, members keep theirs.
      if (g.user_id === uid) return true;
      return allowed.has(g.folder);
    });
  }
  const view = _req.query.view;
  if (
    view !== undefined &&
    !['manifest', 'summary', 'detail'].includes(String(view))
  ) {
    return res.status(400).json({ error: 'Invalid project view' });
  }
  if (_req.query.ids !== undefined) {
    let ids: unknown;
    try {
      ids = JSON.parse(String(_req.query.ids));
    } catch {}
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      return res.status(400).json({ error: 'Invalid project IDs' });
    }
    const selected = new Set(ids);
    entries = entries.filter(({ g }) => selected.has(g.folder));
  }
  const projects = await Promise.all(
    entries.map(async ({ jid, g }) => {
      const currentAccess = reqAny.authUser
        ? await getProjectAccess(reqAny.authUser.id, g.folder)
        : null;
      const project = {
        ...(await projectData(jid, g)),
        accessLevel:
          currentAccess?.kind === 'explicit' ? currentAccess.level : null,
        memberMode: memberModes[g.folder] ?? null,
      };
      const revision = projectRevision(project);
      return {
        ...(view === 'summary' ? projectSummary(project) : project),
        revision,
      };
    }),
  );
  projects.sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
  );
  res.json(
    view === 'manifest'
      ? projects.map(({ id, revision }): ProjectRevision => ({ id, revision }))
      : projects,
  );
});

/** Rows each capped Now group returns; the rest are only counted. */
const ATTENTION_GROUP_ROW_CAP = 30;
/** Upper bound of candidates read per kind, so totals stay bounded. */
const ATTENTION_CONVERSATION_SCAN_LIMIT = 500;
const ATTENTION_COMPLETED_SCAN_LIMIT = 200;

type CappedAttentionGroup = 'unread' | 'completed';
type DismissableAttentionGroup = 'needs-you' | CappedAttentionGroup;

function attentionGroupForState(
  state: AttentionState,
): DismissableAttentionGroup | 'running' {
  if (state === 'running') return 'running';
  if (state === 'unread' || state === 'completed') return state;
  return 'needs-you';
}

type AttentionConversationVisibility = (
  projectId: string,
  conversationId: string,
) => boolean;

/**
 * Every Now item visible to the user, with dismissed rows already removed.
 * With `capRows`, the Replies and Completed groups return at most
 * ATTENTION_GROUP_ROW_CAP rows and report how many more there are.
 */
async function collectAttentionItems(
  userId: string | undefined,
  capRows: boolean,
): Promise<{
  items: AttentionItem[];
  hiddenCounts: Partial<Record<CappedAttentionGroup, number>>;
  canSeeConversation: AttentionConversationVisibility;
}> {
  let visibleProjects = new Set(
    Object.values(registeredGroups).map((group) => group.folder),
  );
  let fullAccessProjects = visibleProjects;

  if (userId) {
    const [explicit, implicit] = await Promise.all([
      getProjectsForUser(userId),
      getImplicitProjectIdsForUser(userId),
    ]);
    visibleProjects = getVisibleStatusProjectIds(userId, explicit, implicit);
    // Tasks need full project access; other visible projects only expose
    // conversations shared with the user.
    fullAccessProjects = getFullAccessStatusProjectIds(
      userId,
      explicit,
      visibleProjects,
    );
  }

  const sharedByProject = new Map<string, Set<string>>();
  if (userId) {
    await Promise.all(
      [...visibleProjects]
        .filter((projectId) => !fullAccessProjects.has(projectId))
        .map(async (projectId) => {
          sharedByProject.set(
            projectId,
            new Set(await getSharedConversationIds(userId, projectId)),
          );
        }),
    );
  }

  const fullAccessProjectIds = [...fullAccessProjects];
  const sharedConversationIds = [...sharedByProject.values()].flatMap((ids) => [
    ...ids,
  ]);

  const [
    attentionTasks,
    unmergedBranchTasks,
    attentionConversations,
    running,
    completed,
    dismissals,
  ] = await Promise.all([
    getAttentionTasks(fullAccessProjectIds),
    getUnmergedBranchTasks(fullAccessProjectIds),
    getAttentionConversations(undefined, {
      includeRead: !!userId,
      limit: ATTENTION_CONVERSATION_SCAN_LIMIT,
      ...(userId
        ? {
            visibleTo: {
              userId,
              projectIds: fullAccessProjectIds,
              sharedConversationIds,
            },
          }
        : {}),
    }),
    getAttentionRunningItems({
      projectIds: fullAccessProjectIds,
      sharedConversationIds,
    }),
    userId
      ? getAttentionCompletedTasks(userId, fullAccessProjectIds, {
          limit: ATTENTION_COMPLETED_SCAN_LIMIT,
        })
      : Promise.resolve([]),
    userId
      ? getNowDismissals(userId)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const canSeeConversation = (projectId: string, conversationId: string) =>
    visibleProjects.has(projectId) &&
    (fullAccessProjects.has(projectId) ||
      !!sharedByProject.get(projectId)?.has(conversationId));
  const canSeeTask = (projectId: string) => fullAccessProjects.has(projectId);

  const items: AttentionItem[] = [];
  const hiddenCounts: Partial<Record<CappedAttentionGroup, number>> = {};
  const returnedCounts: Record<CappedAttentionGroup, number> = {
    unread: 0,
    completed: 0,
  };
  // A running conversation or task never also appears in another state.
  const taken = new Set<string>();
  const take = (item: AttentionItem) => {
    const key = `${item.kind}:${item.id}`;
    if (taken.has(key)) return;
    taken.add(key);
    const group = attentionGroupForState(item.state);
    if (capRows && (group === 'unread' || group === 'completed')) {
      if (returnedCounts[group] >= ATTENTION_GROUP_ROW_CAP) {
        hiddenCounts[group] = (hiddenCounts[group] ?? 0) + 1;
        return;
      }
      returnedCounts[group]++;
    }
    items.push(item);
  };
  // A dismissed row stays hidden until it has activity newer than the dismissal.
  const isDismissed = (kind: AttentionItem['kind'], id: string, at: string) => {
    const dismissedAt = dismissals.get(`${kind}:${id}`);
    return dismissedAt !== undefined && Date.parse(at) <= dismissedAt;
  };
  const conversationTitle = (c: {
    title?: string | null;
    preview?: string | null;
  }) => c.title?.trim() || c.preview?.trim() || 'Untitled chat';

  for (const row of running) {
    if (row.taskId) {
      if (canSeeTask(row.projectId))
        take({
          kind: 'task',
          id: row.taskId,
          projectId: row.projectId,
          title: row.taskTitle ?? 'Untitled task',
          state: 'running',
          at: row.startedAt,
        });
    } else if (
      row.conversationId &&
      canSeeConversation(row.projectId, row.conversationId)
    ) {
      take({
        kind: 'conversation',
        id: row.conversationId,
        projectId: row.projectId,
        ...(row.objectiveId ? { objectiveId: row.objectiveId } : {}),
        title: conversationTitle({
          title: row.conversationTitle,
          preview: row.conversationPreview,
        }),
        state: 'running',
        at: row.startedAt,
      });
    }
  }

  const conversations = attentionConversations.filter((conversation) =>
    canSeeConversation(conversation.group_folder, conversation.id),
  );
  for (const conversation of conversations) {
    const at = conversation.last_assistant_at ?? conversation.created_at;
    if (isDismissed('conversation', conversation.id, at)) continue;
    const state: AttentionState =
      conversation.status === 'pending'
        ? 'pending'
        : conversation.status === 'failed'
          ? 'failed'
          : 'unread';
    take({
      kind: 'conversation',
      id: conversation.id,
      projectId: conversation.group_folder,
      ...(conversation.objective_id
        ? { objectiveId: conversation.objective_id }
        : {}),
      title: conversationTitle(conversation),
      state,
      at,
      ...(userId
        ? {
            unread:
              !conversation.read_at ||
              conversation.read_at < (conversation.last_assistant_at ?? ''),
          }
        : {}),
    });
  }

  for (const task of attentionTasks) {
    if (!canSeeTask(task.projectId)) continue;
    if (isDismissed('task', task.id, task.at)) continue;
    take({
      kind: 'task',
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      state: task.status === 'failed' ? 'failed' : 'question',
      at: task.at,
    });
  }

  // A review-approved card whose merge was refused (e.g. dirty default
  // checkout) is parked in the initial stage and waits for the user to fix the
  // environment. It has no failed/question status, so detect it by its notice.
  for (const task of unmergedBranchTasks) {
    if (!canSeeTask(task.projectId)) continue;
    const group = getGroupByFolder(task.projectId);
    if (!group || getInitialStage(getGroupStages(group))?.id !== task.status)
      continue;
    const pending = findMergePending(
      { merge_commit: task.mergeCommit },
      readTaskMessages(task.projectId, task.id),
      await getRunsForTask(task.id),
    );
    if (!pending || isDismissed('task', task.id, pending.at)) continue;
    take({
      kind: 'task',
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      state: 'pending',
      at: pending.at,
    });
  }

  for (const task of completed) {
    if (isDismissed('task', task.taskId, task.at)) continue;
    take({
      kind: 'task',
      id: task.taskId,
      projectId: task.projectId,
      title: task.title,
      state: 'completed',
      at: task.at,
      completionEventId: task.eventId,
    });
  }

  return { items, hiddenCounts, canSeeConversation };
}

/**
 * GET /api/projects/attention
 * A compact cross-project "Now" list: running work, items needing the user,
 * replies and task completions. For a signed-in user rows stay (read ones
 * flagged `unread: false`) until the user dismisses them; a dismissed row
 * returns only once it has newer activity. Replies and Completed return at
 * most ATTENTION_GROUP_ROW_CAP rows each; `hiddenCounts` reports the rest.
 * Unlike the ordinary list endpoints this does not calculate conversation
 * costs, inspect objective run directories, or return thousands of records.
 * Human-only: agent credentials are refused.
 */
router.get('/projects/attention', async (req: any, res) => {
  if (!requireSignedInUser(req, res)) return;
  const userId: string | undefined = req.authUser?.id;
  const generatedAt = new Date().toISOString();
  const { items, hiddenCounts } = await collectAttentionItems(userId, true);

  const objectiveIds = [
    ...new Set(
      items.map((item) => item.objectiveId).filter((id): id is string => !!id),
    ),
  ];
  const objectives = (
    await Promise.all(objectiveIds.map((id) => getObjective(id)))
  )
    .filter((objective) => !!objective)
    .map((objective) => ({ id: objective.id, title: objective.title }));

  const response: AttentionResponse = {
    items,
    objectives,
    hiddenCounts,
    generatedAt,
  };
  res.json(response);
});

const MAX_NOW_DISMISSALS = 100;
const MAX_NOW_DISMISS_EXCLUSIONS = 200;

function isAttentionItemRef(
  item: unknown,
): item is { kind: 'conversation' | 'task'; id: string } {
  const ref = item as { kind?: unknown; id?: unknown } | null;
  return (
    !!ref &&
    (ref.kind === 'conversation' || ref.kind === 'task') &&
    typeof ref.id === 'string' &&
    ref.id.length > 0
  );
}

/**
 * POST /api/projects/attention/dismiss
 * Hide Now rows for the calling user. Only the caller's own view changes, so
 * project visibility needs no check.
 */
router.post('/projects/attention/dismiss', async (req: any, res) => {
  const userId: string | undefined = req.authUser?.id;
  if (!userId)
    return res.status(401).json({ error: 'Authentication required' });
  const raw = req.body?.items;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_NOW_DISMISSALS ||
    !raw.every(isAttentionItemRef)
  ) {
    return res.status(400).json({ error: 'Invalid items' });
  }
  const unique = new Map<
    string,
    { kind: 'conversation' | 'task'; id: string }
  >();
  for (const { kind, id } of raw) unique.set(`${kind}:${id}`, { kind, id });
  await dismissNowItems(userId, [...unique.values()]);
  res.json({ ok: true });
});

/** Conversations read at once, so a big group does not flood the database. */
const ATTENTION_READ_BATCH_SIZE = 20;

/**
 * A conversation a notification points at. The client synthesizes a Now row
 * for a text notification that deep-links to a conversation, so such a
 * conversation can be in the Replies group without being an attention item.
 */
interface NotificationConversationTarget {
  projectId: string;
  id: string;
  /** The conversation's own activity time; a reply newer than the list stays. */
  at?: string;
}

/**
 * Conversations referenced by the caller's own unread text notifications.
 *
 * A reply the agent sent while the user was speaking is not an attention
 * item (the attention query skips conversations whose last assistant message
 * predates the last user message), yet the client shows it as a Reply row
 * because a text notification deep-links to it. Reading it needs the same
 * conversation id, so it is resolved from the notification itself.
 *
 * Only the caller's own unacked notifications are considered, and only
 * `/chat/<project>?conversationId=<id>` links resolve to a conversation.
 */
async function collectNotificationConversationTargets(
  userId: string,
): Promise<NotificationConversationTarget[]> {
  const notifications = await getUnreadPayloads(userId);
  const targets = new Map<string, NotificationConversationTarget>();
  for (const notification of notifications) {
    // Form notifications are answered from the bell, not checked off.
    if (notification.kind !== 'text') continue;
    const target = conversationTargetFromActionUrl(notification.action_url);
    if (!target) continue;
    targets.set(`${target.projectId}:${target.id}`, target);
  }
  return [...targets.values()];
}

/** The conversation a chat deep link points at, if any. */
function conversationTargetFromActionUrl(
  actionUrl: string | null | undefined,
): { projectId: string; id: string } | null {
  if (!actionUrl) return null;
  const [path, query = ''] = actionUrl.split('?');
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'chat' || !segments[1]) return null;
  const conversationId = new URLSearchParams(query).get('conversationId');
  if (!conversationId) return null;
  let projectId: string;
  try {
    projectId = decodeURIComponent(segments[1]);
  } catch {
    projectId = segments[1];
  }
  return { projectId, id: conversationId };
}

/**
 * Mark conversations read without letting one failure stop the others. A
 * failed read leaves the reply flagged unread; the dismissal still holds.
 */
async function markDismissedConversationsRead(
  conversations: ReadonlyArray<{ projectId: string; id: string }>,
): Promise<void> {
  for (
    let index = 0;
    index < conversations.length;
    index += ATTENTION_READ_BATCH_SIZE
  ) {
    const batch = conversations.slice(index, index + ATTENTION_READ_BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ projectId, id }) => {
        try {
          await markConversationRead(projectId, id);
        } catch (error) {
          logger.warn(
            { project: projectId, conversation: id, error: String(error) },
            'Failed to mark dismissed conversation as read',
          );
        }
      }),
    );
  }
}

/**
 * POST /api/projects/attention/dismiss-all
 * Check off a whole Now group for the calling user, including rows beyond
 * the returned cap. Only items whose latest activity is not newer than
 * `asOf` (the `generatedAt` of the list the user saw) are dismissed, so
 * activity that arrived meanwhile stays. `exclude` keeps rows the client
 * protects, such as rows with an unanswered form.
 *
 * Checking off the Replies group also reads the dismissed conversations, so
 * their unread dot leaves the chat lists too. A failed read never fails the
 * dismissal: the row is already hidden, and the reply stays flagged unread.
 */
router.post('/projects/attention/dismiss-all', async (req: any, res) => {
  const userId: string | undefined = req.authUser?.id;
  if (!userId)
    return res.status(401).json({ error: 'Authentication required' });
  const group = req.body?.group;
  const asOf = Date.parse(req.body?.asOf);
  const exclude = req.body?.exclude ?? [];
  if (
    (group !== 'needs-you' && group !== 'unread' && group !== 'completed') ||
    !Number.isFinite(asOf) ||
    !Array.isArray(exclude) ||
    exclude.length > MAX_NOW_DISMISS_EXCLUSIONS ||
    !exclude.every(isAttentionItemRef)
  ) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const excluded = new Set(exclude.map(({ kind, id }) => `${kind}:${id}`));
  const { items, canSeeConversation } = await collectAttentionItems(
    userId,
    false,
  );
  const targets = items.filter(
    (item) =>
      attentionGroupForState(item.state) === group &&
      Date.parse(item.at) <= asOf &&
      !excluded.has(`${item.kind}:${item.id}`),
  );
  await dismissNowItems(
    userId,
    targets.map(({ kind, id }) => ({ kind, id })),
  );
  if (group === 'unread') {
    // The project folder comes from the server-side item, never from the
    // request, so this cannot read a conversation outside the caller's view.
    await markDismissedConversationsRead(
      await collectDismissedConversationTargets(
        userId,
        items,
        targets,
        asOf,
        excluded,
        canSeeConversation,
      ),
    );
  }
  res.json({ ok: true, dismissed: targets.length });
});

/**
 * The conversations the Replies dismissal marks read: the dismissed attention
 * items plus the conversations a notification deep-link puts in the Replies
 * group. A notification row is not an attention item, so it is resolved from
 * the caller's own unread notifications.
 *
 * `canSeeConversation` applies to both sources, so a notification cannot
 * make the dismissal read a conversation outside the caller's view.
 */
async function collectDismissedConversationTargets(
  userId: string,
  items: readonly AttentionItem[],
  targets: readonly AttentionItem[],
  asOf: number,
  excluded: ReadonlySet<string>,
  canSeeConversation: AttentionConversationVisibility,
): Promise<NotificationConversationTarget[]> {
  const conversations = new Map<string, NotificationConversationTarget>();
  for (const item of targets) {
    if (item.kind !== 'conversation') continue;
    conversations.set(`${item.projectId}:${item.id}`, {
      projectId: item.projectId,
      id: item.id,
      at: item.at,
    });
  }
  // The client reuses a server row when a notification points at a
  // conversation that already has one, so a conversation in another group
  // (running, needs you) is not a Reply row and must not be read here.
  const itemGroups = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== 'conversation') continue;
    itemGroups.set(
      `${item.projectId}:${item.id}`,
      attentionGroupForState(item.state),
    );
  }
  const notificationTargets =
    await collectNotificationConversationTargets(userId);
  const activityTimes = await getConversationActivityTimes(
    notificationTargets.map((target) => target.id),
  );
  for (const target of notificationTargets) {
    const key = `${target.projectId}:${target.id}`;
    // A reply newer than the list the user saw stays, exactly like a
    // notification that arrived after the dismissal. The conversation's own
    // activity times the row, not the notification that brought it here.
    const activityAt = activityTimes.get(target.id);
    if (activityAt === undefined) continue;
    if (Date.parse(activityAt) > asOf) continue;
    // A protected row the client keeps is not checked off, so it stays unread.
    if (excluded.has(`conversation:${target.id}`)) continue;
    const group = itemGroups.get(key);
    if (group && group !== 'unread') continue;
    if (!canSeeConversation(target.projectId, target.id)) continue;
    conversations.set(key, { ...target, at: activityAt });
  }
  return [...conversations.values()];
}

export function getVisibleStatusProjectIds(
  userId: string,
  explicitProjects: readonly string[],
  implicitProjects: readonly string[],
  groups: Readonly<Record<string, RegisteredGroup>> = registeredGroups,
): Set<string> {
  const allowed = new Set([...explicitProjects, ...implicitProjects]);
  const visibleProjectIds = new Set<string>();
  for (const group of Object.values(groups)) {
    if (group.is_main) {
      if (group.user_id === userId) visibleProjectIds.add(group.folder);
    } else if (group.user_id === userId || allowed.has(group.folder)) {
      visibleProjectIds.add(group.folder);
    }
  }
  return visibleProjectIds;
}

/**
 * Visible projects the user may inspect in full (tasks included): explicit
 * members plus projects they own. Other visible projects expose only the
 * conversations shared with the user.
 */
function getFullAccessStatusProjectIds(
  userId: string,
  explicitProjects: readonly string[],
  visibleProjectIds: ReadonlySet<string>,
  groups: Readonly<Record<string, RegisteredGroup>> = registeredGroups,
): Set<string> {
  const fullAccess = new Set(
    explicitProjects.filter((projectId) => visibleProjectIds.has(projectId)),
  );
  for (const group of Object.values(groups)) {
    if (group.user_id === userId && visibleProjectIds.has(group.folder))
      fullAccess.add(group.folder);
  }
  return fullAccess;
}

/** GET /api/projects/status-summary — user-aware activity by project and mode. */
router.get('/projects/status-summary', async (req: any, res) => {
  if (!req.authUser?.id) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const userId = req.authUser.id;
  const [explicitProjects, implicitProjects] = await Promise.all([
    getProjectsForUser(userId),
    getImplicitProjectIdsForUser(userId),
  ]);
  const visibleProjectIds = getVisibleStatusProjectIds(
    userId,
    explicitProjects,
    implicitProjects,
  );
  const fullAccessProjectIds = getFullAccessStatusProjectIds(
    userId,
    explicitProjects,
    visibleProjectIds,
  );
  const sortedFullAccessProjectIds = [...fullAccessProjectIds].sort();
  const statusSummaryKey = JSON.stringify([userId, sortedFullAccessProjectIds]);
  const sharedSummary = await statusSummaryRequests.run(
    statusSummaryKey,
    async () => {
      const cached = statusSummaryCache.get(statusSummaryKey);
      if (cached && cached.expiresAt > Date.now()) return cached.value;

      const value = await getProjectsStatusSummary(
        userId,
        sortedFullAccessProjectIds,
      );
      statusSummaryCache.set(statusSummaryKey, {
        value,
        expiresAt: Date.now() + STATUS_SUMMARY_CACHE_TTL_MS,
      });
      while (statusSummaryCache.size > STATUS_SUMMARY_CACHE_MAX_ENTRIES) {
        const oldestKey = statusSummaryCache.keys().next().value;
        if (oldestKey === undefined) break;
        statusSummaryCache.delete(oldestKey);
      }
      return value;
    },
  );
  // The remainder of this route adds request-time state. Keep the shared DB
  // result immutable so concurrent responses cannot affect each other.
  const summary = {
    projects: Object.fromEntries(
      Object.entries(sharedSummary.projects).map(([projectId, statuses]) => [
        projectId,
        { ...statuses },
      ]),
    ),
  };

  const idleStatuses = (): ProjectModeStatuses => ({
    kanban: 'idle',
    chat: 'idle',
    objectives: 'idle',
  });
  for (const projectId of visibleProjectIds) {
    summary.projects[projectId] ??= idleStatuses();
  }
  for (const projectId of Object.keys(summary.projects)) {
    if (!visibleProjectIds.has(projectId)) delete summary.projects[projectId];
  }

  // Merge in-memory task claims that have not reached active_runs yet.
  const inMemoryRunning = getInMemoryRunningTaskIds();
  if (inMemoryRunning.length > 0) {
    const taskProjectMap = await getTaskProjectMap(inMemoryRunning);
    for (const taskId of inMemoryRunning) {
      const task = taskProjectMap.get(taskId);
      if (!task || task.archived || !fullAccessProjectIds.has(task.projectId))
        continue;
      summary.projects[task.projectId] ??= idleStatuses();
      summary.projects[task.projectId].kanban = 'working';
    }
  }

  // Objective filesystem probes cover runs launched outside active_runs. Probe
  // every visible objective in one parallel batch; another mode's working
  // state must not suppress an Objectives indicator.
  const allObjectives = await getAllActiveObjectives();
  const probes = allObjectives
    .filter((objective) => fullAccessProjectIds.has(objective.project_id))
    .map((objective) => ({
      projectId: objective.project_id,
      objectiveId: objective.id,
    }));
  const probeResults = await Promise.all(
    probes.map((probe) =>
      detectAgentRunning(getObjectiveDir(probe.projectId, probe.objectiveId)),
    ),
  );
  probes.forEach((probe, index) => {
    if (!probeResults[index]) return;
    summary.projects[probe.projectId] ??= idleStatuses();
    summary.projects[probe.projectId].objectives = 'working';
  });

  res.json(summary);
});

/**
 * PATCH /api/projects/order
 * Update the display order of projects.
 */
router.patch('/projects/order', async (req, res) => {
  const { orders } = req.body || {}; // { folder: order }

  if (!orders || typeof orders !== 'object') {
    return res.status(400).json({ error: 'orders object is required' });
  }

  // The :pid guard skips this collection route, so authorize each entry here.
  // This route is UI-only: agent tokens carry no authUser.
  const user = (req as any).authUser;
  if (!user) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const requested = Object.entries(orders).filter(
    ([, order]) => typeof order === 'number' && Number.isFinite(order),
  );
  const applied = new Set<string>();
  const allowedByFolder = new Map<string, boolean>();
  for (const jid in registeredGroups) {
    const group = registeredGroups[jid];
    const order = orders[group.folder];
    if (typeof order !== 'number' || !Number.isFinite(order)) continue;
    let allowed = allowedByFolder.get(group.folder);
    if (allowed === undefined) {
      allowed = await canReorderProject(user, group);
      allowedByFolder.set(group.folder, allowed);
    }
    if (!allowed) continue;
    await updateGroup(jid, { order });
    applied.add(group.folder);
  }

  res.json({ ok: true, skipped: requested.length - applied.size });
});

/**
 * POST /api/projects
 * Create a new project (register a group from the UI).
 */
router.post('/projects', async (req, res) => {
  if (!requireSignedInUser(req, res)) return;
  const {
    name: rawName,
    folder: rawFolder,
    parentId: rawParentId,
  } = req.body || {};

  if (rawName === undefined || rawName === null || rawName === '') {
    return res.status(400).json({ error: 'name is required' });
  }
  if (typeof rawName !== 'string') {
    return res.status(400).json({ error: 'name must be a string' });
  }
  const name = rawName.trim();
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (
    rawFolder !== undefined &&
    rawFolder !== null &&
    rawFolder !== '' &&
    typeof rawFolder !== 'string'
  ) {
    return res.status(400).json({ error: 'folder must be a string' });
  }

  const nameErr = lenError(name, MAX_LEN.name, 'name');
  if (nameErr) return res.status(400).json({ error: nameErr });
  const folderErr = lenError(rawFolder, MAX_LEN.name, 'folder');
  if (folderErr) return res.status(400).json({ error: folderErr });

  // Derive folder slug from name if not provided
  const folder = (rawFolder || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!folder) {
    return res
      .status(400)
      .json({ error: 'Could not derive a valid folder slug' });
  }
  if (isReservedProjectFolder(folder) || isReservedMainFolder(folder)) {
    return res
      .status(400)
      .json({ error: `Project folder "${folder}" is reserved` });
  }

  let parentId: string | undefined;
  if (rawParentId !== undefined && rawParentId !== null) {
    if (typeof rawParentId !== 'string' || !rawParentId.trim()) {
      return res.status(400).json({ error: 'parentId must be a project ID' });
    }
    const parentErr = lenError(rawParentId, MAX_LEN.name, 'parentId');
    if (parentErr) return res.status(400).json({ error: parentErr });
    parentId = rawParentId.trim();
    if (parentId === folder) {
      return res
        .status(400)
        .json({ error: 'A project cannot be its own parent' });
    }
    if (!(await canAttachToParent(req as any, parentId))) {
      return res.status(403).json(PARENT_ACCESS_DENIED);
    }
    if (!getGroupByFolder(parentId)) {
      return res
        .status(400)
        .json({ error: `Parent project "${parentId}" not found` });
    }
  }

  // Check uniqueness
  const exists = Object.values(registeredGroups).some(
    (g) => g.folder === folder,
  );
  if (exists) {
    return res
      .status(409)
      .json({ error: `Project folder "${folder}" already exists` });
  }

  if (
    findSandboxNameConflict(folder, undefined, { includeFolders: true }) ||
    isSandboxNameReserved(folder)
  ) {
    return res.status(409).json({ error: sandboxNameConflictMessage(folder) });
  }

  // Keep the folder check above, this jid pick and registerGroup's synchronous
  // registry write in one stretch (no await) so concurrent creates cannot race.
  // A renamed project keeps its old jid; never overwrite that entry.
  const jidBase = `ui-${folder}`;
  let jid = jidBase;
  let jidSuffix = 2;
  while (registeredGroups[jid]) jid = `${jidBase}-${jidSuffix++}`;
  const reqAny = req as any;
  await registerGroup(
    jid,
    {
      name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      settings: { mode: 'chat' },
      user_id: reqAny.authUser.id,
      ...(parentId ? { parentId } : {}),
    },
    { requirePersistence: true },
  );

  try {
    await upsertProjectMember(reqAny.authUser.id, folder, 'owner');
  } catch (error) {
    logger.error(
      { folder, error: String(error) },
      'Failed to add project owner; rolling back project creation',
    );
    try {
      await unregisterGroup(jid);
    } catch (rollbackError) {
      logger.error(
        { folder, error: String(rollbackError) },
        'Project creation rollback failed',
      );
    }
    return res.status(500).json({ error: 'Failed to create project' });
  }

  try {
    await seedDefaultWorkerPrompt(folder, parentId);
  } catch (error) {
    logger.warn(
      { folder, error: String(error) },
      'Project created, but default worker prompt seeding failed',
    );
  }

  logger.info({ folder, name }, 'Project created via UI');

  res
    .status(201)
    .json({ id: folder, name, folder, ...(parentId ? { parentId } : {}) });
});

/**
 * POST /api/projects/:pid/discover-repositories
 * Scan a shared parent's container-mounted workspace and add missing children.
 */
router.post('/projects/:pid/discover-repositories', async (req, res) => {
  if (!canRunRepositoryDiscovery(req)) {
    return res.status(403).json({
      error: 'Editor or owner access is required for repository discovery',
    });
  }
  const parent = getGroupByFolder(req.params.pid);
  if (!parent) return res.status(404).json({ error: 'Project not found' });
  const reqAny = req as any;
  if (
    parent.settings?.isParent !== true ||
    parent.settings.sandboxOwnership !== 'shared'
  ) {
    return res.status(400).json({
      error:
        'Repository discovery requires a parent project with shared sandbox ownership',
    });
  }
  if (
    !parent.settings.sharedWorkspaceHostLocation ||
    !parent.settings.sharedWorkspaceContainerRoot
  ) {
    return res.status(400).json({
      error:
        'Configure both host and container shared workspace locations before discovery',
    });
  }
  if (
    path.normalize(parent.settings.sharedWorkspaceHostLocation) ===
      path.parse(parent.settings.sharedWorkspaceHostLocation).root ||
    path.posix.normalize(parent.settings.sharedWorkspaceContainerRoot) === '/'
  ) {
    return res.status(400).json({
      error: 'Shared workspace roots must be narrower than the filesystem root',
    });
  }
  const body = req.body || {};
  const requestError = validateDiscoveryRequest(body);
  if (requestError) return res.status(400).json({ error: requestError });

  try {
    const options = normalizeDiscoveryOptions(body);
    const scan = await scanParentWorkspace(parent, options);
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups: Object.values(registeredGroups),
      scan,
      create: async (group) => {
        const jidBase = `ui-${group.folder}`;
        let jid = jidBase;
        let jidSuffix = 2;
        // A renamed UI project can retain its old JID after freeing the old
        // folder slug. Never overwrite that unrelated in-memory entry.
        while (registeredGroups[jid]) jid = `${jidBase}-${jidSuffix++}`;
        await registerGroup(jid, group, { requirePersistence: true });
        if (getGroupEntryByFolder(group.folder)?.jid !== jid) {
          throw new Error(
            `Durable registration verification failed for project "${group.folder}"`,
          );
        }
        // Registration is the authoritative creation step. Auxiliary prompt
        // seeding/membership must not turn a successfully persisted child into
        // a misleading "failed" report or trigger a duplicate on the next run.
        try {
          await seedDefaultWorkerPrompt(group.folder, parent.folder);
          if (reqAny.authUser && reqAny.projectAccess?.kind === 'explicit') {
            await insertProjectMemberIfMissing(
              reqAny.authUser.id,
              group.folder,
              reqAny.projectAccess.level,
            );
          }
        } catch (error) {
          logger.warn(
            { project: group.folder, error: String(error) },
            'Discovered project created, but auxiliary setup was incomplete',
          );
        }
      },
    });
    // Project listing is membership-scoped, including for admins. Ensure the
    // user who discovered these repositories can see both newly created
    // children and children created by an earlier discovery run. Admins do not
    // have projectAccess populated by the route guard, so give them editor
    // membership rather than silently hiding the children they just created.
    const discoveryAccessLevel =
      reqAny.projectAccess?.kind === 'explicit'
        ? reqAny.projectAccess.level
        : reqAny.authUser?.role === 'admin'
          ? 'editor'
          : undefined;
    if (reqAny.authUser && discoveryAccessLevel) {
      for (const projectId of discoveryMembershipProjectIds(
        report,
        reqAny.authUser,
      )) {
        await insertProjectMemberIfMissing(
          reqAny.authUser.id,
          projectId,
          discoveryAccessLevel,
        );
      }
    }
    logger.info(
      {
        parent: parent.folder,
        created: report.created.length,
        existing: report.existing.length,
      },
      'Parent workspace repository discovery completed',
    );
    return res.json(report);
  } catch (error) {
    logger.error(
      { parent: parent.folder, error: String(error) },
      'Parent workspace repository discovery failed',
    );
    return res.status(502).json({
      error: `Repository discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

/**
 * PATCH /api/projects/:pid
 * Update project settings.
 */
router.get('/projects/:pid/stage-occupancy', async (req, res) => {
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) return res.status(404).json({ error: 'Project not found' });
  const stages = getGroupStages(entry.group, getGroupByFolder);
  const totals = await countProjectTasksByStatus(
    entry.group.folder,
    stages.map((stage) => stage.id),
  );
  const tasks = await getTasksByProject(entry.group.folder);
  const byStatus = new Map(
    stages.map((stage) => {
      const total = totals.find((item) => item.status === stage.id)?.count ?? 0;
      const matching = tasks.filter((task) => task.status === stage.id);
      const active = matching.filter((task) => !task.archived).length;
      return [
        stage.id,
        {
          stageId: stage.id,
          total,
          active,
          archived: matching.length - active,
        },
      ];
    }),
  );
  return res.json({ occupancy: [...byStatus.values()] });
});

/**
 * POST /api/projects/:pid/inherit-stages
 * Drop a child project's own stage list so it inherits its parent's stages.
 */
router.post('/projects/:pid/inherit-stages', async (req, res) => {
  if (!requireSignedInUser(req, res)) return;
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) return res.status(404).json({ error: 'Project not found' });
  try {
    await inheritParentStages(entry.group, getGroupByFolder, (settings) =>
      applyGroupUpdateInMemory(entry.jid, { settings }),
    );
  } catch (error) {
    if ((error as Error).name === 'StageRemovalConflictError') {
      return res.status(409).json({ error: (error as Error).message });
    }
    if (error instanceof StageInheritanceError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
  return res.json({ ok: true });
});

/**
 * True when an explicitly written `enabledModes` selects no mode the server
 * offers.
 */
function leavesNoSelectedMode(requestedModes: unknown[]): boolean {
  return !(
    (ENABLE_KANBAN && requestedModes.includes('kanban')) ||
    (ENABLE_CHAT && requestedModes.includes('chat')) ||
    (ENABLE_OBJECTIVES && requestedModes.includes('objectives'))
  );
}

/**
 * Settings that decide which sandboxes and Brains a project uses or what they
 * mount. They cannot change in the request that changes the parent.
 */
const REPARENT_EXCLUSIVE_SETTINGS = [
  'defaultSandbox',
  'defaultSandboxService',
  'defaultSandboxInstance',
  'sandboxOwnership',
  'isParent',
  'sharedWorkspaceHostLocation',
  'sharedWorkspaceContainerRoot',
  'repositoryLocation',
  'workspacePath',
  'workspaceRoots',
  'extraMounts',
  'brainContainer',
  'autoStartStack',
] as const;

// Names this request is about to take stay reserved until it has ended on
// every path, so a concurrent request cannot take them in between.
router.patch('/projects/:pid', async (req, res) => {
  const reservationOwner = {};
  try {
    await patchProject(req, res, reservationOwner);
  } finally {
    releaseSandboxNameReservations(reservationOwner);
  }
});

async function patchProject(
  req: Request<{ pid: string }>,
  res: Response,
  reservationOwner: object,
) {
  if (!requireSignedInUser(req, res)) return;
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { jid, group } = entry;
  const {
    settings,
    trigger,
    name,
    folder: newFolder,
    parentId: rawParentId,
  } = req.body || {};
  // An empty parent means "no parent", as when creating a project.
  const parentId =
    typeof rawParentId === 'string' && !rawParentId.trim() ? null : rawParentId;
  // A project's sandbox name decides which integration tokens CarapaBox serves
  // to its containers, so only a board admin may change it. Checked before any
  // other restriction or write, like the deploy service.
  if (
    isRecord(settings) &&
    dropUnchangedSandboxBinding(settings, group.settings) &&
    (req as any).authUser?.role !== 'admin'
  ) {
    return res.status(403).json({
      error: 'Only a board admin can change the sandbox binding',
    });
  }
  const publicationOwners = [
    group,
    ...Object.values(registeredGroups).filter(
      (candidate) => candidate.parentId === group.folder,
    ),
  ];
  const bindingFields = [
    'defaultSandbox',
    'defaultSandboxInstance',
    'defaultSandboxService',
    'sandboxOwnership',
    'isParent',
    'sharedWorkspaceHostLocation',
    'sharedWorkspaceContainerRoot',
  ];
  if (
    publicationOwners.some(
      (candidate) => candidate.settings?.appPublication?.enabled,
    ) &&
    ((newFolder !== undefined && newFolder !== group.folder) ||
      (parentId !== undefined &&
        (parentId ?? null) !== (group.parentId ?? null)) ||
      bindingFields.some(
        (key) =>
          settings &&
          Object.hasOwn(settings, key) &&
          settings[key] !== (group.settings as any)?.[key],
      ))
  )
    return res.status(409).json({
      error:
        'Disable app publishing for this project and its affected children before changing sandbox ownership or identity',
    });
  let stagePipelineUpdateRequested = false;
  const canCommitStagePipeline = () =>
    stagePipelineUpdateRequested && isRecord(settings);
  const deferredStageSaveSideEffects: Array<() => Promise<void>> = [];
  const persistStageSaveSideEffect = async (
    operation: () => Promise<void> | void,
  ): Promise<void> => {
    if (canCommitStagePipeline()) {
      deferredStageSaveSideEffects.push(async () => {
        await operation();
      });
      return;
    }
    await operation();
  };
  let deferredName: string | undefined;
  let deferredTrigger: string | undefined;
  let deferredParentId: string | undefined;
  let deferredFolderRename: (() => Promise<void>) | undefined;
  let releaseRenamedKeys: (() => Promise<void>) | undefined;
  // The registry entry is updated in place by a rename: keep the folder from
  // before it, and the folder the project has once this request is done.
  const startFolder = group.folder;
  let finalFolder = startFolder;
  // Set when the parent and files are saved but a step after that failed.
  let reparentPostSaveError: ProjectReparentError | undefined;
  // Runs `persist` (which writes the new parent) between the file move and the
  // sandbox restart when the parent changes; otherwise just runs it.
  // Prompt files live under the group directory, which a parent change moves:
  // deferred writes must resolve the parent that is committed by then.
  const currentParentId = () => getGroupByFolder(group.folder)?.parentId;
  // Stored objective directories change with the sandbox mount the new parent
  // implies. Resolved when the save runs, against the project as it is then.
  const objectiveWorkDirChange = (newParentId: string | undefined) => ({
    before: (objectiveId: string) => {
      const current = getGroupByFolder(group.folder) ?? group;
      return objectiveWorkDirFor(current, objectiveId);
    },
    after: (objectiveId: string) => {
      const current = getGroupByFolder(group.folder) ?? group;
      return objectiveWorkDirFor(
        { ...current, parentId: newParentId },
        objectiveId,
      );
    },
  });
  const persistParent = async <T>(persist: () => Promise<T>): Promise<T> => {
    // Every request that supplies a parent goes through the reparent mutex,
    // including one that repeats the current parent: whether anything has to
    // move is decided there, against the parent as it is by then, so a stale
    // value read at the start of the request is never committed over a move
    // that finished meanwhile.
    if (!('parentId' in (req.body || {}))) return persist();
    let outcome;
    try {
      outcome = await reparentProject({
        folder: group.folder,
        newParentId: requestedParentId,
        persist,
      });
    } catch (error) {
      // A refusal from the save itself (stage conflicts, admission) keeps its
      // own handling; the files were put back either way.
      const cause =
        error instanceof ProjectReparentError ? error.persistCause : undefined;
      if (
        cause instanceof ProjectAdmissionConflictError ||
        ['StageRemovalConflictError', 'StageMigrationValidationError'].includes(
          (cause as Error | undefined)?.name ?? '',
        )
      ) {
        throw cause;
      }
      throw error;
    }
    reparentPostSaveError = outcome.postSaveError;
    return outcome.value;
  };
  const rawStageMigrations = (req.body || {}).stageMigrations;
  if (
    rawStageMigrations !== undefined &&
    (!Array.isArray(rawStageMigrations) ||
      rawStageMigrations.some((migration) => {
        if (!migration || typeof migration !== 'object') return true;
        return Object.keys(migration as object).some(
          (key) => !['sourceStageId', 'destinationStageId'].includes(key),
        );
      }))
  ) {
    return res.status(400).json({
      error:
        'stageMigrations must contain only sourceStageId and destinationStageId',
    });
  }

  // Validate lengths up-front before mutating anything
  if (name !== undefined) {
    const e = lenError(name, MAX_LEN.name, 'name');
    if (e) return res.status(400).json({ error: e });
  }
  if (trigger !== undefined) {
    const e = lenError(trigger, MAX_LEN.trigger, 'trigger');
    if (e) return res.status(400).json({ error: e });
  }
  if (newFolder !== undefined) {
    const e = lenError(newFolder, MAX_LEN.name, 'folder');
    if (e) return res.status(400).json({ error: e });
  }
  if (
    settings !== undefined &&
    settings !== null &&
    (typeof settings !== 'object' || Array.isArray(settings))
  ) {
    return res.status(400).json({ error: 'settings must be an object' });
  }
  if (
    settings &&
    'stages' in settings &&
    !Array.isArray((settings as Record<string, unknown>).stages)
  ) {
    return res.status(400).json({ error: 'settings.stages must be an array' });
  }
  const checkoutSettingsError = validateTaskCheckoutSettingsWrite(settings);
  if (checkoutSettingsError) {
    return res.status(400).json({ error: checkoutSettingsError });
  }
  if (
    settings &&
    typeof settings === 'object' &&
    typeof (settings as Record<string, unknown>).taskCheckoutMode ===
      'string' &&
    (settings as Record<string, unknown>).taskCheckoutMode !==
      (group.settings?.taskCheckoutMode ?? 'shared')
  ) {
    const projectTasks = await getTasksByProject(group.folder);
    const runningIds = new Set([
      ...getInMemoryRunningTaskIds(),
      ...(await getRunningTaskIds()),
    ]);
    if (
      projectTasks.some((task) => !task.archived && runningIds.has(task.id))
    ) {
      return res.status(409).json({
        error: new ProjectAdmissionConflictError().message,
      });
    }
    // The in-memory view misses recorded admissions and runs of archived
    // tasks; check the stored state too, before anything is written.
    try {
      await assertTaskCheckoutModeChangeAllowed(group.folder);
    } catch (error) {
      if (error instanceof ProjectAdmissionConflictError) {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
  }
  if (settings && typeof settings === 'object') {
    if (
      Array.isArray(settings.enabledModes) &&
      leavesNoSelectedMode(settings.enabledModes)
    ) {
      return res
        .status(400)
        .json({ error: 'At least one mode must stay enabled' });
    }
    if (
      'codeEnabled' in settings &&
      typeof settings.codeEnabled !== 'boolean'
    ) {
      return res.status(400).json({ error: 'codeEnabled must be a boolean' });
    }
    if (
      'kanbanTaskCostLimitUsd' in settings &&
      settings.kanbanTaskCostLimitUsd !== null &&
      !(
        typeof settings.kanbanTaskCostLimitUsd === 'number' &&
        Number.isFinite(settings.kanbanTaskCostLimitUsd) &&
        settings.kanbanTaskCostLimitUsd > 0
      )
    ) {
      return res.status(400).json({
        error: 'kanbanTaskCostLimitUsd must be a positive number or null',
      });
    }
    if (
      'issueImportEnabled' in settings &&
      typeof settings.issueImportEnabled !== 'boolean'
    ) {
      return res
        .status(400)
        .json({ error: 'issueImportEnabled must be a boolean' });
    }
    const prospectiveIssueImportEnabled =
      settings.issueImportEnabled ??
      group.settings?.issueImportEnabled ??
      false;
    const prospectiveRepositoryUrl =
      'repositoryUrl' in settings
        ? settings.repositoryUrl
        : group.settings?.repositoryUrl;
    if (
      prospectiveIssueImportEnabled &&
      (typeof prospectiveRepositoryUrl !== 'string' ||
        !prospectiveRepositoryUrl.trim())
    ) {
      return res.status(400).json({
        error: 'A repository URL is required to enable GitLab issue import',
      });
    }
    if (
      REPOSITORY_CONNECTION_FIELDS.some((field) => field in settings) &&
      !canUpdateRepositoryConnection(req)
    ) {
      return res.status(403).json({
        error: 'Only the project owner can change the repository connection',
      });
    }
    if ('memorySourceProjects' in settings) {
      if (!(req as any).authUser) {
        return res
          .status(403)
          .json({ error: 'Agent tokens cannot change memory source projects' });
      }
      const rawSources = (settings as Record<string, unknown>)
        .memorySourceProjects;
      if (
        !Array.isArray(rawSources) ||
        rawSources.some((source) => typeof source !== 'string')
      ) {
        return res.status(400).json({
          error: 'memorySourceProjects must be an array of project folder IDs',
        });
      }
      const sources = [...new Set(rawSources.map((source) => source.trim()))];
      if (sources.some((source) => !source)) {
        return res.status(400).json({
          error: 'memorySourceProjects cannot contain empty project folder IDs',
        });
      }
      if (sources.includes(group.folder)) {
        return res
          .status(400)
          .json({ error: 'A project cannot be its own memory source' });
      }
      // Sources already configured stay valid: the settings dialog re-sends
      // the whole object on every save. Only newly added sources need
      // owner/editor access, since a source grants memories:read on it to
      // every agent and member of this project.
      const previousSources = new Set(
        group.settings?.memorySourceProjects ?? [],
      );
      for (const source of sources) {
        const sourceGroup = getGroupByFolder(source);
        if (!sourceGroup) {
          return res.status(400).json({
            error: `Memory source project "${source}" does not exist`,
          });
        }
        if (
          !previousSources.has(source) &&
          !(await userHasExplicitGroupAccess(req, source, { write: true }))
        ) {
          return res.status(403).json({
            error: `Access denied to memory source project "${source}"`,
          });
        }
      }
      (settings as Record<string, unknown>).memorySourceProjects = sources;
    }
    if ('privacyMode' in settings) {
      const rawMode = (settings as Record<string, unknown>).privacyMode;
      if (
        rawMode !== null &&
        rawMode !== 'off' &&
        rawMode !== 'local_memory' &&
        rawMode !== 'strict'
      ) {
        return res.status(400).json({
          error: 'privacyMode must be "off", "local_memory", "strict" or null',
        });
      }
      // The mode applies to unattributed calls installation-wide, so only a
      // board admin session may change it; agent tokens have no authUser.
      if ((req as any).authUser?.role !== 'admin') {
        return res.status(403).json({
          error: 'Only a board admin can change the project privacy mode',
        });
      }
      const nextRank = privacyModeRank(rawMode as PrivacyMode | null);
      if (nextRank < privacyModeRank(group.settings?.privacyMode)) {
        const signature = await verifyFreshSignature(req);
        if (!signature.ok) {
          return res.status(signature.status).json({ error: signature.error });
        }
      }
    }
    // The deploy service decides which managed service the board builds and
    // which build output it exposes, so only a board admin may change it. The
    // settings dialog resends the whole form, so an unchanged value passes.
    if (
      'deployService' in settings &&
      normalizeDeployService(settings.deployService) !==
        normalizeDeployService(group.settings?.deployService) &&
      (req as any).authUser?.role !== 'admin'
    ) {
      return res.status(403).json({
        error: 'Only a board admin can change the deploy service',
      });
    }
    // Extra mounts bind host folders into the sandbox and workspace roots
    // widen what it exposes, so only a board admin may change them. The
    // settings dialog resends the whole form, so an unchanged value passes.
    if (
      (['extraMounts', 'workspaceRoots'] as const).some(
        (key) =>
          key in settings &&
          pathListChanged(
            settings[key],
            group.settings?.[key],
            key === 'extraMounts'
              ? normalizedExtraMounts
              : normalizedWorkspaceRoots,
          ),
      ) &&
      (req as any).authUser?.role !== 'admin'
    ) {
      return res.status(403).json({
        error: 'Only a board admin can change mounts and workspace roots',
      });
    }
    for (const key of [
      'kanbanRuntimeSelection',
      'chatRuntimeSelection',
    ] as const) {
      const runtimeError = validateRuntimeSelection((settings as any)[key]);
      if (runtimeError)
        return res.status(400).json({ error: `${key}: ${runtimeError}` });
    }
    if ('defaultMainAiUserId' in settings) {
      const aiUserId = (settings as Record<string, unknown>)
        .defaultMainAiUserId;
      if (
        aiUserId !== null &&
        (typeof aiUserId !== 'string' || !aiUserId.trim())
      ) {
        return res.status(400).json({
          error: 'defaultMainAiUserId must be a non-empty AI user ID or null',
        });
      }
      if (typeof aiUserId === 'string') {
        // The settings dialog resends the whole form, so a persona that was
        // disabled or deleted after being stored must not block unrelated saves.
        const unchanged =
          aiUserId.trim() === group.settings?.defaultMainAiUserId;
        const aiUser = unchanged ? null : await getAiUserRow(aiUserId.trim());
        if (!unchanged && !aiUser?.enabled)
          return res.status(400).json({
            error: 'defaultMainAiUserId must reference an enabled AI user',
          });
        (settings as Record<string, unknown>).defaultMainAiUserId =
          aiUserId.trim();
      }
    }
    for (const [key, label] of [
      ['defaultInvitedAiUserIds', 'AI user'],
      ['defaultInvitedAiUserTeamIds', 'AI team'],
    ] as const) {
      if (!(key in settings)) continue;
      const ids = (settings as Record<string, unknown>)[key];
      if (
        !Array.isArray(ids) ||
        ids.length > 20 ||
        ids.some((id) => typeof id !== 'string' || !id.trim())
      ) {
        return res.status(400).json({
          error: `${key} must contain at most 20 ${label} IDs`,
        });
      }
      const normalized = [...new Set(ids.map((id) => id.trim()))];
      // Ids already stored may have been disabled or deleted since; only
      // newly added ids must reference an available user or team.
      const storedIds: unknown = group.settings?.[key];
      const added = normalized.filter(
        (id) => !(Array.isArray(storedIds) && storedIds.includes(id)),
      );
      const valid =
        key === 'defaultInvitedAiUserIds'
          ? (await Promise.all(added.map((id) => getAiUserRow(id)))).every(
              (row) => row?.enabled === 1,
            )
          : (await Promise.all(added.map((id) => getAiUserTeamRow(id)))).every(
              Boolean,
            );
      if (!valid) {
        return res.status(400).json({
          error: `${key} must reference available ${label}s`,
        });
      }
      (settings as Record<string, unknown>)[key] = normalized;
    }
    const stringLimits: [string, number][] = [
      ['workerPrompt', MAX_LEN.prompt],
      ['defaultSandbox', MAX_LEN.short],
      ['defaultSandboxService', MAX_LEN.short],
      ['defaultSandboxInstance', MAX_LEN.short],
      ['sharedWorkspaceHostLocation', MAX_LEN.short],
      ['sharedWorkspaceContainerRoot', MAX_LEN.short],
      ['webRootPath', MAX_LEN.short],
      ['defaultBranch', MAX_LEN.short],
      ['repositoryUrl', MAX_LEN.url],
      ['repositoryLocation', MAX_LEN.short],
      ['workspacePath', MAX_LEN.short],
      ['deployService', MAX_LEN.short],
      ['brainContainer', MAX_LEN.short],
      ['brainAuthToken', MAX_LEN.token],
      ['carapaMailToken', MAX_LEN.token],
      ['systemPrompt', MAX_LEN.prompt],
    ];
    for (const [key, max] of stringLimits) {
      const e = lenError((settings as Record<string, unknown>)[key], max, key);
      if (e) return res.status(400).json({ error: e });
    }
    const { defaultBranch, repositoryUrl } = settings as Record<
      string,
      unknown
    >;
    if (
      typeof defaultBranch === 'string' &&
      defaultBranch &&
      !isValidGitBranchName(defaultBranch)
    ) {
      return res
        .status(400)
        .json({ error: 'defaultBranch is not a valid git branch name' });
    }
    if (
      typeof repositoryUrl === 'string' &&
      repositoryUrl &&
      !isSafeRepositoryUrl(repositoryUrl)
    ) {
      return res.status(400).json({
        error:
          'repositoryUrl must not contain whitespace or control characters or start with "-"',
      });
    }
    if (
      'toolCallDisplay' in settings &&
      settings.toolCallDisplay !== 'compact' &&
      settings.toolCallDisplay !== 'expanded'
    ) {
      return res.status(400).json({
        error: 'toolCallDisplay must be compact or expanded',
      });
    }
    if ('chatModes' in settings) {
      const rawModes = (settings as Record<string, unknown>).chatModes;
      if (rawModes !== undefined && rawModes !== null) {
        if (!Array.isArray(rawModes)) {
          return res.status(400).json({ error: 'chatModes must be an array' });
        }
        if (rawModes.length > 20) {
          return res
            .status(400)
            .json({ error: 'chatModes is capped at 20 entries' });
        }
        const idPattern = /^[a-z][a-z0-9_-]{0,39}$/;
        const seen = new Set<string>();
        for (const mode of rawModes as Array<any>) {
          const id = normalizeChatModeId(mode?.id);
          const label =
            typeof mode?.label === 'string' ? mode.label.trim() : '';
          if (!id || !label) {
            return res
              .status(400)
              .json({ error: 'Each chat mode requires id and label' });
          }
          if (!idPattern.test(id)) {
            return res
              .status(400)
              .json({ error: `Invalid chat mode id "${id}"` });
          }
          if (label.length > 60) {
            return res
              .status(400)
              .json({ error: `chat mode label for "${id}" is too long` });
          }
          if (seen.has(id)) {
            return res
              .status(400)
              .json({ error: `Duplicate chat mode id "${id}"` });
          }
          seen.add(id);
        }
      }
    }
    if ('chatModePrompts' in settings) {
      const rawPrompts = (settings as Record<string, unknown>).chatModePrompts;
      if (rawPrompts !== undefined && rawPrompts !== null) {
        if (typeof rawPrompts !== 'object' || Array.isArray(rawPrompts)) {
          return res
            .status(400)
            .json({ error: 'chatModePrompts must be an object' });
        }
        const seenPromptKeys = new Set<string>();
        for (const [k, v] of Object.entries(
          rawPrompts as Record<string, unknown>,
        )) {
          const keyErr = lenError(k, 40, `chatModePrompts.${k}.key`);
          if (keyErr) return res.status(400).json({ error: keyErr });
          const normalizedKey = normalizeChatModeId(k);
          if (seenPromptKeys.has(normalizedKey)) {
            return res.status(400).json({
              error: `Duplicate chatModePrompts key "${normalizedKey}"`,
            });
          }
          seenPromptKeys.add(normalizedKey);
          if (typeof v === 'string') {
            const valErr = lenError(v, MAX_LEN.prompt, `chatModePrompts.${k}`);
            if (valErr) return res.status(400).json({ error: valErr });
          } else if (v !== null && v !== undefined) {
            return res
              .status(400)
              .json({ error: `chatModePrompts.${k} must be a string` });
          }
        }
      }
    }
    // Stored ids and prompt keys use the same form as the prompt filenames.
    if (Array.isArray((settings as Record<string, unknown>).chatModes)) {
      (settings as Record<string, unknown>).chatModes = (
        (settings as Record<string, unknown>).chatModes as Array<any>
      ).map((mode) => ({ ...mode, id: normalizeChatModeId(mode?.id) }));
    }
    const rawChatModePrompts = (settings as Record<string, unknown>)
      .chatModePrompts;
    if (rawChatModePrompts && typeof rawChatModePrompts === 'object') {
      (settings as Record<string, unknown>).chatModePrompts =
        Object.fromEntries(
          Object.entries(rawChatModePrompts).map(([k, v]) => [
            normalizeChatModeId(k),
            v,
          ]),
        );
    }
    if ('stages' in settings && Array.isArray(settings.stages)) {
      for (const stage of settings.stages) {
        if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
          return res
            .status(400)
            .json({ error: 'Each stage must be an object' });
        }
        const stageRecord = stage as Record<string, unknown>;
        const runtimeError = validateRuntimeSelection(
          stageRecord.runtimeSelection,
        );
        if (runtimeError) {
          return res
            .status(400)
            .json({ error: `Invalid stage runtimeSelection: ${runtimeError}` });
        }
        if (
          stageRecord.runOnEntry !== undefined &&
          typeof stageRecord.runOnEntry !== 'boolean'
        ) {
          return res.status(400).json({
            error: 'Stage runOnEntry must be a boolean',
          });
        }
        if (
          stageRecord.persistSession !== undefined &&
          typeof stageRecord.persistSession !== 'boolean'
        ) {
          return res.status(400).json({
            error: 'Stage persistSession must be a boolean',
          });
        }
        if (
          stageRecord.minTier !== undefined &&
          !['fast', 'balanced', 'frontier'].includes(
            stageRecord.minTier as string,
          )
        ) {
          return res.status(400).json({
            error: 'Stage minTier must be fast, balanced, or frontier',
          });
        }
      }
      const stagePersonaError = await validateStageMainAiUserIds(
        settings.stages as Array<Record<string, unknown>>,
      );
      if (stagePersonaError) {
        return res.status(400).json({ error: stagePersonaError });
      }
    }

    const sandboxSettingsError = validateProspectiveSharedSandboxSettings(
      group.settings,
      settings as Record<string, unknown>,
    );
    if (sandboxSettingsError) {
      return res.status(400).json({ error: sandboxSettingsError });
    }
    // Only a changed instance is checked: the settings dialog resends stored
    // values, and a collision that already exists keeps working.
    const requestedInstance = (settings as Record<string, unknown>)
      .defaultSandboxInstance;
    if (
      typeof requestedInstance === 'string' &&
      requestedInstance &&
      requestedInstance !== group.settings?.defaultSandboxInstance &&
      // The reservation follows the passing check with no await in between.
      (findSandboxNameConflict(requestedInstance, group.folder, {
        includeFolders: true,
      }) ||
        !reserveSandboxName(requestedInstance, reservationOwner))
    ) {
      return res
        .status(400)
        .json({ error: sandboxNameConflictMessage(requestedInstance) });
    }

    const prospectiveStages = Array.isArray(settings.stages)
      ? settings.stages.map((stage: Record<string, unknown>) => {
          const { workerPrompt: _workerPrompt, ...persistedStage } = stage;
          return persistedStage;
        })
      : group.settings?.stages;
    const prospectiveModes = Array.isArray(settings.enabledModes)
      ? settings.enabledModes
      : (group.settings?.enabledModes ?? ['kanban', 'chat']);
    if (prospectiveStages && prospectiveStages.length > 0) {
      // Stage IDs feed prompt filenames (`stage-<id>.md`) on read, write and
      // delete regardless of whether the kanban mode is enabled, so reject
      // unsafe IDs (traversal, multiple dots) before any filesystem use.
      for (const stage of prospectiveStages) {
        const id =
          stage && typeof stage === 'object' && typeof stage.id === 'string'
            ? stage.id
            : '';
        if (!STAGE_ID_PATTERN.test(id)) {
          return res.status(400).json({
            error: `Invalid stage ID "${String(stage?.id ?? '')}"`,
          });
        }
      }
      if (prospectiveModes.includes('kanban')) {
        // Only a save that sends stages gets the Question-type rule; a settings
        // save that leaves stages untouched must not be refused because of an
        // already stored legacy config.
        const stagesError = validateStages(prospectiveStages, {
          checkQuestionType: Array.isArray(settings.stages),
        });
        if (stagesError) {
          return res
            .status(400)
            .json({ error: `Invalid stages: ${stagesError}` });
        }
      }
    }
  }

  if (
    'parentId' in (req.body || {}) &&
    parentId !== null &&
    typeof parentId !== 'string'
  ) {
    return res
      .status(400)
      .json({ error: 'parentId must be a project ID or null' });
  }

  const requestedParentId =
    'parentId' in (req.body || {})
      ? typeof parentId === 'string'
        ? parentId
        : undefined
      : group.parentId;
  // Reparenting under a project is a grant of that project's folder tree and
  // shared sandbox: the caller must manage the new parent and own the child.
  if (
    typeof parentId === 'string' &&
    parentId !== (group.parentId ?? undefined)
  ) {
    const callerAny = req as any;
    const ownsChild = canUpdateRepositoryConnection(callerAny);
    if (!ownsChild || !(await canAttachToParent(callerAny, parentId))) {
      return res.status(403).json(PARENT_ACCESS_DENIED);
    }
  }
  const parentIdError = validateProspectiveParentId(group, requestedParentId);
  if (parentIdError) {
    return res.status(400).json({ error: parentIdError });
  }
  const nestedSharedOwnerError = validateProspectiveSharedSandboxParent(
    group.settings,
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {},
    requestedParentId,
  );
  if (nestedSharedOwnerError) {
    return res.status(400).json({ error: nestedSharedOwnerError });
  }
  // A parent change moves the project's files and recreates its sandbox: refuse
  // what cannot be done before any other part of this request is applied.
  const parentChanging =
    'parentId' in (req.body || {}) &&
    requestedParentId !== (group.parentId ?? undefined);
  if (parentChanging) {
    if (newFolder !== undefined && newFolder !== group.folder) {
      return res.status(400).json({
        error: 'Change the parent and the folder in separate requests',
      });
    }
    // The sandboxes to stop and restart are worked out from the settings as
    // they are now; a binding changed in the same request would be applied to
    // a different topology than the one that was checked and held.
    const changedBinding = REPARENT_EXCLUSIVE_SETTINGS.find(
      (key) =>
        settings &&
        typeof settings === 'object' &&
        Object.hasOwn(settings, key) &&
        JSON.stringify((settings as Record<string, unknown>)[key] ?? null) !==
          JSON.stringify((group.settings as any)?.[key] ?? null),
    );
    if (changedBinding) {
      return res.status(400).json({
        error: `Change the parent and "${changedBinding}" in separate requests`,
      });
    }
    const refusal = await checkReparentAllowed(group, requestedParentId);
    if (refusal) {
      return res
        .status(refusal.status)
        .json({ error: refusal.message, state: refusal.state });
    }
  }
  const requestedParent = requestedParentId
    ? getGroupByFolder(requestedParentId)
    : undefined;
  const inheritedUpdateError = validateInheritedSandboxUpdate(
    requestedParent,
    settings,
  );
  if (inheritedUpdateError) {
    return res.status(400).json({ error: inheritedUpdateError });
  }
  // Skills follow the sandbox owner the project will have after this save, so
  // detaching from a shared parent and editing skills in one request is valid.
  if (
    settings &&
    typeof settings === 'object' &&
    'disabledSkills' in settings &&
    requestedParent?.settings?.isParent === true &&
    requestedParent.settings.sandboxOwnership === 'shared' &&
    !(
      group.settings?.isParent === true &&
      group.settings.sandboxOwnership === 'shared'
    ) &&
    JSON.stringify(normalizeDisabledSkills(settings.disabledSkills)) !==
      JSON.stringify(normalizeDisabledSkills(group.settings?.disabledSkills))
  ) {
    return res.status(400).json({
      error: `This project shares the sandbox of ${requestedParent.folder}; change disabled skills on that project`,
    });
  }

  if (
    'parentId' in (req.body || {}) ||
    (settings && typeof settings === 'object' && 'stages' in settings)
  ) {
    stagePipelineUpdateRequested = true;
    const prospectiveGroup: RegisteredGroup = {
      ...group,
      parentId: requestedParentId,
      settings: {
        ...(group.settings ?? {}),
        ...('stages' in (settings ?? {})
          ? { stages: (settings as Record<string, unknown>).stages as any }
          : {}),
      },
    };
    const currentStages = getGroupStages(group);
    const prospectiveEffectiveStages = getGroupStages(
      prospectiveGroup,
      (folder) =>
        folder === requestedParentId
          ? requestedParent
          : getGroupByFolder(folder),
    );
    try {
      const planned = await planStageMigrations(
        group.folder,
        currentStages,
        prospectiveEffectiveStages,
        (rawStageMigrations ?? []) as Array<{
          sourceStageId: string;
          destinationStageId: string;
        }>,
      );
      (req as any).plannedStageMigrations = planned.migrations;
      (req as any).prospectiveStageIds = prospectiveEffectiveStages.map(
        (stage) => stage.id,
      );
    } catch (error) {
      if (error instanceof StageRemovalConflictError) {
        return res.status(409).json({ error: error.message });
      }
      if (error instanceof StageMigrationValidationError) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  } else if (rawStageMigrations !== undefined) {
    return res
      .status(400)
      .json({ error: 'stageMigrations requires a stage update' });
  }

  // Validate the display name now, but save it after the folder rename has
  // passed its checks: a refused rename must not leave the name changed.
  let trimmedName: string | undefined;
  if (name && typeof name === 'string') {
    trimmedName = name.trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
  }

  // Rename folder slug if provided and different
  if (
    newFolder &&
    typeof newFolder === 'string' &&
    newFolder !== group.folder
  ) {
    const oldFolder = group.folder;
    const slugified = newFolder
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slugified) {
      return res
        .status(400)
        .json({ error: 'Could not derive a valid folder slug' });
    }
    if (slugified !== newFolder) {
      return res.status(400).json({
        error: 'Folder slug must be lowercase alphanumeric with hyphens only',
      });
    }
    if (isReservedProjectFolder(slugified) || isReservedMainFolder(slugified)) {
      return res
        .status(400)
        .json({ error: `Project folder "${slugified}" is reserved` });
    }
    // Check no other project uses this slug
    const conflict = getGroupByFolder(slugified);
    if (conflict && conflict.folder !== group.folder) {
      return res
        .status(409)
        .json({ error: `Folder slug "${slugified}" is already in use` });
    }
    if (
      findSandboxNameConflict(slugified, group.folder, { includeFolders: true })
    ) {
      return res
        .status(409)
        .json({ error: sandboxNameConflictMessage(slugified) });
    }
    // Held until the request ends: nothing reserves the name across the awaits
    // below otherwise (running-task lookup, key deletion).
    if (!reserveSandboxName(slugified, reservationOwner)) {
      return res
        .status(409)
        .json({ error: sandboxNameConflictMessage(slugified) });
    }
    finalFolder = slugified;
    // Refuse if any runs are currently active or claimed for this project
    const projectTaskIds = new Set(
      (await getTasksByProject(group.folder)).map((f) => f.id),
    );
    const runningIds = new Set([
      ...getInMemoryRunningTaskIds(),
      ...getQueuedTaskIds(),
      ...(await getRunningTaskIds()),
    ]);
    if ([...projectTaskIds].some((id) => runningIds.has(id))) {
      return res
        .status(409)
        .json({ error: 'Cannot rename folder while tasks are running' });
    }
    // Integration keys are bound to a sandbox name, and the next project to use
    // the old folder name would be served them: delete the keys on that name
    // (any stack) before the folder is renamed. A configured instance with
    // another name is not released by the rename and keeps its keys. Box cannot
    // rebind a key, so the integrations must be added again.
    let keysReleased = false;
    releaseRenamedKeys = async () => {
      if (keysReleased) return;
      await deleteReleasedProjectKeys(
        oldFolder,
        { oldFolder, newFolder: slugified },
        'Could not delete the project integration keys from CarapaBox; the folder was not renamed',
        'Folder rename deleted project integration keys; add the integrations again',
      );
      keysReleased = true;
    };
    // Renaming re-parents the folder's children: serialized with parent changes.
    // Everything about the project is read again once the mutex is held: a
    // parent change that ran first moved its directory.
    const performFolderRename = () =>
      withReparentMutex(async () => {
        if (!getGroupByFolder(oldFolder)) {
          throw new Error(`Project "${oldFolder}" no longer exists`);
        }
        const conflictNow = getGroupByFolder(slugified);
        if (conflictNow && conflictNow.folder !== oldFolder) {
          throw new FolderNameTakenError(
            `Folder slug "${slugified}" is already in use`,
          );
        }
        if (
          findSandboxNameConflict(slugified, oldFolder, {
            includeFolders: true,
          })
        ) {
          throw new FolderNameTakenError(sandboxNameConflictMessage(slugified));
        }
        await releaseRenamedKeys?.();
        const oldDir = getGroupDir(oldFolder);
        // Rename filesystem directory through its pinned parent, derived from
        // oldDir so child-group nesting is preserved. The group folders are
        // agent-writable: no path is resolved again after the parent is pinned.
        // A directory that exists but cannot be renamed aborts before the
        // database is touched; only a project with no directory proceeds.
        const parent = await openParentDir(oldDir);
        let renamed = false;
        try {
          if (parent && (await lstatAt(parent.dir, parent.name))) {
            await renameAt(parent.dir, parent.name, parent.dir, slugified);
            renamed = true;
          }
        } catch (err) {
          await parent?.dir.close();
          throw err;
        }
        try {
          await renameProjectFolder(oldFolder, slugified);
        } catch (err) {
          try {
            if (parent && renamed) {
              await renameAt(parent.dir, slugified, parent.dir, parent.name);
            }
          } catch {
            /* best-effort rollback */
          }
          throw err;
        } finally {
          await parent?.dir.close();
        }
        migrateGroupSession(oldFolder, slugified);
        await rewriteRenamedProjectReferences(oldFolder, slugified);
        // Keep the project's Neo4j memory/entity nodes attached to the new
        // folder. Best-effort: an outage must not fail the rename.
        try {
          await getVectorStoreHooks()?.renameGroupMemoryGraph?.(
            oldFolder,
            slugified,
          );
        } catch (err) {
          logger.warn(
            { oldFolder, newFolder: slugified, err },
            'memory_vector_project_rename_failed',
          );
        }
      });
    if (canCommitStagePipeline()) {
      deferredFolderRename = performFolderRename;
    } else {
      await performFolderRename();
    }
  }

  if (trimmedName !== undefined) {
    if (canCommitStagePipeline()) deferredName = trimmedName;
    else await updateGroup(jid, { name: trimmedName });
  }

  // Update trigger word if provided
  if (trigger && typeof trigger === 'string') {
    if (canCommitStagePipeline()) deferredTrigger = trigger.trim();
    else await updateGroup(jid, { trigger: trigger.trim() });
  }

  // All request validation has completed. Persist the prospective parent only
  // after every branch that can reject with a 4xx response.
  if ('parentId' in (req.body || {})) {
    // Every reparent commits through the stage migration below.
    deferredParentId = parentId === null ? undefined : parentId;
  }

  // A deferred rename commits settings before it runs: the old folder name's
  // keys are deleted before that, so a Box failure refuses the whole request.
  if (releaseRenamedKeys && deferredFolderRename) await releaseRenamedKeys();

  // A configured instance that is changed or cleared releases its name: the
  // keys on it go before the settings are saved, or the next project that uses
  // the name is served them. A name equal to the project's folder stays claimed.
  if (isRecord(settings) && 'defaultSandboxInstance' in settings) {
    const releasedInstance = group.settings?.defaultSandboxInstance?.trim();
    const nextInstance =
      typeof settings.defaultSandboxInstance === 'string'
        ? settings.defaultSandboxInstance.trim()
        : '';
    if (
      releasedInstance &&
      releasedInstance.toLowerCase() !== nextInstance.toLowerCase() &&
      releasedInstance.toLowerCase() !== finalFolder.toLowerCase() &&
      // The rename already deleted the keys on its old folder name.
      !(finalFolder !== startFolder && releasedInstance === startFolder)
    )
      await deleteReleasedProjectKeys(
        releasedInstance,
        { folder: finalFolder, releasedInstance },
        'Could not delete the project integration keys from CarapaBox; the settings were not saved',
        'Changing the sandbox instance deleted project integration keys; add the integrations again',
      );
  }

  let parentOnlyStageCommitDone = false;
  if (stagePipelineUpdateRequested && !isRecord(settings)) {
    const deferredMigrationEntryEvents: StageEntryEvent[] = [];
    try {
      const changedTasks = await persistParent(async () => {
        const { tasks, entryEvents } = await commitProjectStageMigration(
          group.folder,
          serializeSettingsForDb(group.settings ?? {}),
          ((req as any).plannedStageMigrations ?? []) as Array<{
            sourceStageId: string;
            destinationStageId: string;
          }>,
          [],
          deferredParentId ?? null,
          objectiveWorkDirChange(deferredParentId),
          undefined,
          { deferStageEntryNotifications: true },
        );
        deferredMigrationEntryEvents.push(...entryEvents);
        applyGroupUpdateInMemory(jid, { parentId: deferredParentId });
        return tasks;
      });
      for (const task of changedTasks) emitStageMigrationTaskUpdated(task);
      parentOnlyStageCommitDone = true;
    } catch (error) {
      if (error instanceof ProjectReparentError) {
        return res
          .status(error.status)
          .json({ error: error.message, state: error.state });
      }
      if (
        (error as Error).name === 'StageRemovalConflictError' ||
        (error as Error).name === 'StageMigrationValidationError'
      ) {
        return res.status(409).json({ error: (error as Error).message });
      }
      throw error;
    } finally {
      // Wake deferred migration receipts only after in-memory group state and
      // reparent file moves finish. A board restart between DB commit and file
      // updates may still run the hook with previous prompt files; accepted
      // without a durable hold/token.
      releaseAndNotifyStageEntryEvents(deferredMigrationEntryEvents);
    }
  }

  if (settings && typeof settings === 'object') {
    // systemPrompt is stored as a file, not in DB
    if ('systemPrompt' in settings) {
      const prompt = settings.systemPrompt?.trim();
      if (prompt) {
        await persistStageSaveSideEffect(() =>
          writeProjectPrompt(group.folder, prompt),
        );
      } else {
        await persistStageSaveSideEffect(() =>
          deleteProjectPrompt(group.folder),
        );
      }
    }

    // workerPrompt is stored as a file, not in DB
    if ('workerPrompt' in settings) {
      const prompt = settings.workerPrompt?.trim();
      if (prompt) {
        // Use internal resolution to handle parentId correctly
        await persistStageSaveSideEffect(() =>
          writePrompt(group.folder, currentParentId(), 'worker.md', prompt),
        );
      } else {
        await persistStageSaveSideEffect(() =>
          deletePrompt(group.folder, currentParentId(), 'worker.md'),
        );
      }
    }

    if ('starterPrompts' in settings) {
      const starters = settings.starterPrompts;
      if (starters && Array.isArray(starters) && starters.length > 0) {
        await persistStageSaveSideEffect(() =>
          writeStarterPrompts(group.folder, starters),
        );
      } else {
        await persistStageSaveSideEffect(() =>
          deleteStarterPrompts(group.folder),
        );
      }
    }
    if ('chatModePrompts' in settings || 'chatModes' in settings) {
      const nextModesRaw = Array.isArray((settings as any).chatModes)
        ? ((settings as any).chatModes as Array<{
            id?: string;
            label?: string;
          }>)
        : (group.settings?.chatModes as
            | Array<{ id?: string; label?: string }>
            | undefined) || [...DEFAULT_CHAT_MODES];
      const nextModeIds = new Set(
        nextModesRaw.map((m) => normalizeChatModeId(m?.id)).filter(Boolean),
      );
      const oldModesRaw = (group.settings?.chatModes as
        | Array<{ id?: string; label?: string }>
        | undefined) || [...DEFAULT_CHAT_MODES];
      const oldModeIds = new Set(
        oldModesRaw.map((m) => normalizeChatModeId(m?.id)).filter(Boolean),
      );
      const promptMap =
        typeof (settings as any).chatModePrompts === 'object' &&
        (settings as any).chatModePrompts !== null
          ? ((settings as any).chatModePrompts as Record<
              string,
              string | null | undefined
            >)
          : {};
      for (const modeId of nextModeIds) {
        if (!(modeId in promptMap)) continue;
        const content = (promptMap[modeId] || '').trim();
        if (content) {
          await persistStageSaveSideEffect(() =>
            writePrompt(
              group.folder,
              currentParentId(),
              `chat-mode-${modeId}.md`,
              content,
            ),
          );
        } else {
          await persistStageSaveSideEffect(() =>
            deletePrompt(
              group.folder,
              currentParentId(),
              `chat-mode-${modeId}.md`,
            ),
          );
        }
      }
      if ('chatModes' in settings) {
        for (const oldModeId of oldModeIds) {
          if (!nextModeIds.has(oldModeId)) {
            await persistStageSaveSideEffect(() =>
              deletePrompt(
                group.folder,
                currentParentId(),
                `chat-mode-${oldModeId}.md`,
              ),
            );
          }
        }
      }
    }

    const allowed: (keyof ProjectSettings)[] = [
      'codeEnabled',
      'chatModes',
      'toolCallDisplay',
      'taskCheckoutMode',
      'autoPushAfterMerge',
      'kanbanTaskCostLimitUsd',
      'defaultBranch',
      'repositoryUrl',
      'issueImportEnabled',
      'repositoryLocation',
      'repositoryRelativePath',
      'defaultSandbox',
      'defaultSandboxService',
      'defaultSandboxInstance',
      'sandboxOwnership',
      'sharedWorkspaceHostLocation',
      'sharedWorkspaceContainerRoot',
      'webRootPath',
      'proxyHostnameAliases',
      'maxParallelWorktrees',
      'autoStartStack',
      'status',
      'mode',
      'custom_values',
      'cardTemplate',
      'deployService',
      'deployStage',
      'workspacePath',
      'workspaceRoots',
      'extraMounts',
      'isParent',
      'worktreeFiles',
      'brainContainer',
      'brainAuthToken',
      'carapaMailToken',
      'carapaMailEnabled',
      'gracefulDeploy',
      'allowAgentTaskCreation',
      'relatedRepositories',
      'memorySourceProjects',
      'disableObservations',
      'disabledToolsets',
      'disabledSkills',
      'enabledModes',
      'kanbanRuntimeSelection',
      'chatRuntimeSelection',
      'defaultMainAiUserId',
      'defaultInvitedAiUserIds',
      'defaultInvitedAiUserTeamIds',
      'privacyMode',
    ];
    const merged = { ...(group.settings ?? {}) };
    for (const key of allowed) {
      if (key in settings) {
        if (
          settings[key] === null &&
          (key === 'kanbanRuntimeSelection' ||
            key === 'chatRuntimeSelection' ||
            key === 'defaultMainAiUserId' ||
            key === 'privacyMode')
        ) {
          delete merged[key];
        } else {
          merged[key] = settings[key] ?? undefined;
        }
      }
    }
    if ('disabledSkills' in settings) {
      merged.disabledSkills = Array.isArray(settings.disabledSkills)
        ? normalizeDisabledSkills(settings.disabledSkills)
        : undefined;
    }
    // stages: handle specially — strip workerPrompt before DB merge (prompts go to filesystem)
    if ('stages' in settings && Array.isArray(settings.stages)) {
      // Write stage prompts from raw settings before stripping
      for (const stage of settings.stages) {
        // Prompt filenames come from stage IDs; never touch the filesystem
        // with an ID that fails the stage-ID pattern (defense in depth; the
        // request-level validation above already rejects these).
        if (
          !stage ||
          typeof stage !== 'object' ||
          typeof stage.id !== 'string' ||
          !STAGE_ID_PATTERN.test(stage.id)
        ) {
          continue;
        }
        if (
          typeof (stage as any).workerPrompt === 'string' ||
          (stage as any).workerPrompt === undefined ||
          (stage as any).workerPrompt === null
        ) {
          const wp = (stage as any).workerPrompt?.trim();
          if (wp) {
            await persistStageSaveSideEffect(() =>
              writePrompt(
                group.folder,
                currentParentId(),
                `stage-${String(stage.id)}.md`,
                wp,
              ),
            );
          } else {
            await persistStageSaveSideEffect(() =>
              deletePrompt(
                group.folder,
                currentParentId(),
                `stage-${String(stage.id)}.md`,
              ),
            );
          }
        }
      }
      // Strip workerPrompt from stages before DB merge
      merged.stages = settings.stages.map((s: Record<string, unknown>) => {
        const { workerPrompt: _wp, mainAiUserId, ...rest } = s;
        return mainAiUserId ? { ...rest, mainAiUserId } : rest;
      });
    }
    // Validation ran before any project mutation; normalize for persistence.
    if ('workspaceRoots' in settings) {
      const raw = (settings as Record<string, unknown>).workspaceRoots;
      merged.workspaceRoots = normalizedWorkspaceRoots(raw);
    }
    if ('extraMounts' in settings) {
      merged.extraMounts = normalizedExtraMounts(
        (settings as Record<string, unknown>).extraMounts,
      );
    }
    // Parallelism represents discrete task slots, so persist a whole value in
    // the supported 1–10 range.
    if (typeof merged.maxParallelWorktrees === 'number') {
      merged.maxParallelWorktrees = Math.max(
        1,
        Math.min(10, Math.floor(merged.maxParallelWorktrees)),
      );
    }
    const plannedStageMigrations = (req as any).plannedStageMigrations as
      | Array<{
          sourceStageId: string;
          destinationStageId: string;
        }>
      | undefined;

    // Capture old values before updating the in-memory group.
    const oldMax = group.settings?.maxParallelWorktrees ?? 1;
    const oldStatus = group.settings?.status ?? 'running';
    const oldMailToken = group.settings?.carapaMailToken;
    const oldMailEnabled = group.settings?.carapaMailEnabled ?? false;
    const oldIssueImportEnabled = group.settings?.issueImportEnabled ?? false;
    const oldIssueRepositoryUrl = group.settings?.repositoryUrl;
    const oldProxyHostnameAliases = group.settings?.proxyHostnameAliases;
    const oldSettings = group.settings;
    const removedStageIds = [
      ...new Set(
        getGroupStages(group)
          .map((stage) => stage.id)
          .filter((stageId) => {
            const prospectiveStageIds =
              ((req as any).prospectiveStageIds as string[] | undefined) ??
              (merged.stages ?? []).map((stage: any) => stage.id);
            return !prospectiveStageIds.includes(stageId);
          }),
      ),
    ];
    const deferredMigrationEntryEvents: StageEntryEvent[] = [];
    // commitProjectStageMigration holds the migration receipts it returns, so
    // no drain claims them before the prompt files below are written.
    try {
      if (stagePipelineUpdateRequested && !parentOnlyStageCommitDone) {
        // Task status changes, replay events, and the pipeline settings commit
        // together. Broadcast only after the transaction has succeeded.
        let changedTasks;
        try {
          changedTasks = await persistParent(async () => {
            const committedPlacement: { sshEnabled?: boolean; boxId?: string } =
              {};
            const { tasks, entryEvents } = await commitProjectStageMigration(
              group.folder,
              serializeSettingsForDb(merged),
              plannedStageMigrations ?? [],
              removedStageIds,
              'parentId' in (req.body || {})
                ? (deferredParentId ?? null)
                : undefined,
              objectiveWorkDirChange(deferredParentId),
              committedPlacement,
              { deferStageEntryNotifications: true },
            );
            deferredMigrationEntryEvents.push(...entryEvents);
            // The restart that follows reads the registry, so apply it first.
            merged.appPublication = group.settings?.appPublication;
            merged.whatsappSelfChatAutoLinkDisabled =
              group.settings?.whatsappSelfChatAutoLinkDisabled;
            merged.sshEnabled = committedPlacement.sshEnabled;
            merged.boxId = committedPlacement.boxId;
            applyGroupUpdateInMemory(jid, {
              settings: merged,
              ...('parentId' in (req.body || {})
                ? { parentId: deferredParentId }
                : {}),
            });
            return tasks;
          });
        } catch (error) {
          if (error instanceof ProjectReparentError) {
            return res
              .status(error.status)
              .json({ error: error.message, state: error.state });
          }
          if (
            error instanceof ProjectAdmissionConflictError ||
            (error as Error).name === 'StageRemovalConflictError' ||
            (error as Error).name === 'StageMigrationValidationError'
          ) {
            return res.status(409).json({ error: (error as Error).message });
          }
          throw error;
        }
        for (const task of changedTasks) {
          emitStageMigrationTaskUpdated(task);
        }
      } else {
        try {
          await updateProjectSettingsWithAdmissionLock(
            group.folder,
            serializeSettingsForDb(merged) ?? '{}',
          );
        } catch (error) {
          if (error instanceof ProjectAdmissionConflictError) {
            return res.status(409).json({ error: error.message });
          }
          throw error;
        }
        merged.sshEnabled = group.settings?.sshEnabled === true;
        merged.appPublication = group.settings?.appPublication;
        merged.whatsappSelfChatAutoLinkDisabled =
          group.settings?.whatsappSelfChatAutoLinkDisabled;
        merged.boxId = group.settings?.boxId;
        applyGroupUpdateInMemory(jid, { settings: merged });
      }
      if ('kanbanRuntimeSelection' in settings) {
        const runtimeGroup = registeredGroups[jid];
        const inheritedObjectives = (
          await getObjectivesByProject(group.folder)
        ).filter((objective) => objective.eventRuntimeSelection == null);
        await Promise.all(
          inheritedObjectives.map((objective) =>
            publishObjectiveStateEvent(
              resolveBrainUrl(resolveBrainContainer(runtimeGroup)),
              {
                type: 'objective_updated',
                project_id: group.folder,
                task_id: null,
                objective_id: objective.id,
                timestamp: new Date().toISOString(),
                data: {
                  changes: { eventRuntimeSelection: null },
                  reason: 'project_runtime_changed',
                },
              },
              runtimeGroup,
            ),
          ),
        );
      }
      if (deferredName !== undefined) {
        await updateGroup(jid, { name: deferredName });
      }
      if (deferredTrigger !== undefined) {
        await updateGroup(jid, { trigger: deferredTrigger });
      }
      for (const sideEffect of deferredStageSaveSideEffects) {
        await sideEffect();
      }
      if (deferredFolderRename) {
        await deferredFolderRename();
      }
    } finally {
      // Wake deferred migration receipts only after deferredStageSaveSideEffects
      // write the stage prompt files (even if a side effect throws). A board
      // restart between DB commit and prompt write may still run the hook with
      // the previous prompt on recovery; accepted without a durable hold/token.
      const currentFolder = registeredGroups[jid]?.folder;
      releaseAndNotifyStageEntryEvents(
        deferredMigrationEntryEvents.map((entryEvent) =>
          currentFolder && currentFolder !== entryEvent.projectId
            ? { ...entryEvent, projectId: currentFolder }
            : entryEvent,
        ),
      );
    }
    if ('disabledToolsets' in settings) {
      resetToolsets(registeredGroups[jid].folder);
    }
    // Every save reconciles the container-visible file from the merged
    // settings (an omitted field inherits), so a project registered after boot
    // also gets its file. The file is written and pushed to a remote box before
    // the response; the container refresh follows in the background. Neither
    // fails the save.
    await reconcileDisabledSkills(registeredGroups[jid].folder).written;

    if (
      merged.issueImportEnabled === true &&
      (!oldIssueImportEnabled || oldIssueRepositoryUrl !== merged.repositoryUrl)
    ) {
      const importGroup = registeredGroups[jid];
      logger.info(
        { project: importGroup.folder },
        'Issue import scheduled after settings update',
      );
      void importIssuesForProject(importGroup).catch((error) =>
        logger.error(
          { project: importGroup.folder, error },
          'Issue import failed after settings update',
        ),
      );
    }

    // Carapa-mail token/enable changed → push it straight into carapa-box's
    // relay-token store so the api-relay serves the new token without a
    // sandbox (or board) restart. Fire-and-forget; the helper logs failures.
    if (
      oldMailToken !== merged.carapaMailToken ||
      oldMailEnabled !== (merged.carapaMailEnabled ?? false)
    ) {
      void syncCarapaMailRelayToken(registeredGroups[jid]);
    }

    // Alias edits are controller metadata, so apply them to the running host
    // nginx route directly. Other project-setting saves never call CarapaBox.
    if (
      shouldSyncProxyHostnameAliases(
        settings as Record<string, unknown>,
        oldProxyHostnameAliases,
        merged.proxyHostnameAliases,
      )
    ) {
      try {
        await syncProxyHostnameAliases(registeredGroups[jid]);
      } catch (error) {
        // The settings remain authoritative and will be applied on the next
        // sandbox start if the stack is stopped or CarapaBox is unavailable.
        logger.warn(
          { error: String(error), group: group.folder },
          'Saved proxy hostname aliases, but live nginx reconciliation failed',
        );
      }
    }

    // Reconcile sandbox pool if parallelism changed
    const newMax = merged.maxParallelWorktrees ?? 1;
    if (oldMax !== newMax) {
      reconcileSandboxPool(registeredGroups[jid]).catch((err) =>
        logger.error(
          { error: String(err), group: group.folder },
          'Failed to reconcile sandbox pool',
        ),
      );
    }

    // Bind mounts only change when the sandbox container is recreated. When a
    // mount-affecting setting changed, reconcile the running sandbox so the
    // Files tab never lists a container that still mounts an older host
    // folder. Ownership/topology keys are excluded on purpose: re-parenting
    // needs operator attention, not an automatic container swap.
    const MOUNT_AFFECTING_SETTINGS: ReadonlyArray<keyof ProjectSettings> = [
      'extraMounts',
      'workspacePath',
      'workspaceRoots',
      'repositoryLocation',
      'sharedWorkspaceHostLocation',
      'sharedWorkspaceContainerRoot',
    ];
    const changedMountKeys =
      settings && typeof settings === 'object'
        ? MOUNT_AFFECTING_SETTINGS.filter(
            (key) =>
              Object.hasOwn(settings, key) &&
              JSON.stringify(merged[key]) !==
                JSON.stringify(oldSettings?.[key]),
          )
        : [];
    if (changedMountKeys.length > 0) {
      void reconcileSandboxMounts(
        registeredGroups[jid],
        changedMountKeys,
      ).catch((err) =>
        logger.error(
          { error: String(err), group: group.folder },
          'Failed to reconcile sandbox mounts after settings change',
        ),
      );
    }

    // Drain the queue when resuming from paused/stopped so queued tasks start executing
    const currentFolder = registeredGroups[jid].folder;
    const newStatus = merged.status ?? 'running';
    if (oldStatus === 'running' && newStatus === 'paused') {
      // Waiting tasks are already claimed, so a resume drain would otherwise
      // skip them. Preserve their stage while releasing their in-memory claim.
      await cancelQueuedProjectTasks(currentFolder);
    }
    // Queue drains are event-driven. Extra task slots (a higher
    // maxParallelWorktrees, or a switch to worktree mode) would otherwise
    // stay idle until a running task finished and woke the queue.
    const resumed =
      (oldStatus === 'paused' || oldStatus === 'stopped') &&
      newStatus === 'running';
    const capacityGrew =
      newStatus === 'running' &&
      effectiveMaxParallel(merged) > effectiveMaxParallel(oldSettings);
    if (resumed || capacityGrew) {
      projectQueueDrainRunner(currentFolder, registeredGroups[jid]).catch(
        (err) =>
          logger.error(
            { error: String(err), group: currentFolder },
            'Failed to drain project queue after settings change',
          ),
      );
    }
  }

  if (reparentPostSaveError) {
    return res.status(reparentPostSaveError.status).json({
      error: reparentPostSaveError.message,
      state: reparentPostSaveError.state,
    });
  }

  const updated = registeredGroups[jid];
  // Re-test the brain after its token or container changed, so the response
  // carries the fresh auth status instead of a stale rejection.
  if (
    settings &&
    ('brainAuthToken' in settings || 'brainContainer' in settings)
  ) {
    await testBrainConnection(updated);
  }
  const resolveGroup = getGroupByFolder(updated.folder);
  const [systemPrompt, workerPrompt, starterPrompts] = await Promise.all([
    readProjectPrompt(updated.folder),
    readPrompt(updated.folder, resolveGroup?.parentId, 'worker.md'),
    readStarterPrompts(updated.folder),
  ]);
  const {
    brainAuthToken: _patchBrainAuthToken,
    carapaMailToken: _patchCarapaMailToken,
    ...safePatchSettings
  } = updated.settings ?? {};
  // Enrich stages with workerPrompt loaded from filesystem
  const enrichedStages = await enrichStagePrompts(
    safePatchSettings.stages,
    updated.folder,
    resolveGroup?.parentId,
  );
  const chatModes =
    Array.isArray(safePatchSettings.chatModes) &&
    safePatchSettings.chatModes.length > 0
      ? safePatchSettings.chatModes
      : [...DEFAULT_CHAT_MODES];
  const chatModePrompts = loadChatModePrompts(
    chatModes as Array<{ id?: string }>,
    updated.folder,
    resolveGroup?.parentId,
  );
  const effectiveSandbox = effectiveSandboxSettings(updated);
  res.json({
    id: updated.folder,
    name: updated.name,
    folder: updated.folder,
    trigger: updated.trigger,
    stack: effectiveSandbox.stack,
    ...(updated.parentId ? { parentId: updated.parentId } : {}),
    effectiveSandbox,
    settings: {
      ...safePatchSettings,
      toolCallDisplay: resolveToolCallDisplay(
        safePatchSettings.toolCallDisplay,
      ),
      brainAuthTokenSet: !!_patchBrainAuthToken,
      brainAuthRejected: brainAuthRejected(updated.folder),
      carapaMailTokenSet: !!_patchCarapaMailToken,
      systemPrompt,
      workerPrompt,
      starterPrompts,
      stages: enrichedStages,
      chatModes,
      chatModePrompts,
    },
  });
}

/**
 * POST /api/projects/:pid/regenerate-prompt
 * Regenerate the project's AGENTS.md from the appropriate prompt template.
 */
type BrainConnectionTest =
  | {
      result:
        | 'accepted'
        | 'no-container'
        | 'no-token'
        | 'not-found'
        | 'no-endpoint'
        | 'discovery-failed';
    }
  | { result: 'unreachable'; code?: string }
  | { result: 'rejected' | 'error'; status: number };

/** Short transport error code safe to show the user (never a URL or message). */
function brainTransportErrorCode(err: unknown): string | undefined {
  const e = err as {
    name?: string;
    code?: unknown;
    cause?: { code?: unknown };
  } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)
    ? code
    : undefined;
}

/**
 * Whether a typed brain container may be probed: the project's own saved or
 * inherited container, or one whose sandbox instance runs a project the caller
 * can access. Admins can already list every container.
 */
async function mayProbeBrainContainer(
  group: RegisteredGroup,
  container: string,
  user?: { id: string; role?: string },
): Promise<boolean> {
  if (container === resolveBrainContainer(group)) return true;
  if (user?.role === 'admin') return true;
  const instance = resolveBrainSandboxInstance(container);
  if (!user || !instance) return false;
  for (const candidate of Object.values(registeredGroups)) {
    if (
      resolveEffectiveSandbox(candidate).instance === instance &&
      (await canAccessProject(user, candidate.folder, { min: 'viewer' }))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Ask the brain (authenticated `GET /status`) whether it accepts a token.
 * `typed` holds unsaved form values; each falls back to the project's saved
 * value. A saved token's result also updates the project's brain-auth status;
 * a typed token's does not, since it is not stored yet.
 */
async function testBrainConnection(
  group: RegisteredGroup,
  typed: { brainContainer?: string; brainAuthToken?: string } = {},
  user?: { id: string; role?: string },
): Promise<BrainConnectionTest> {
  const typedContainer = typed.brainContainer?.trim() ?? '';
  const typedToken = typed.brainAuthToken?.trim() ?? '';
  const brainContainer = typedContainer || resolveBrainContainer(group);
  const token = typedToken || resolveBrainAuthToken(group);
  if (!brainContainer) return { result: 'no-container' };
  if (!token) return { result: 'no-token' };
  // A typed name outside the caller's projects gets one neutral result, so
  // the test cannot probe which containers (other users' sandboxes) exist.
  if (
    typedContainer &&
    !(await mayProbeBrainContainer(group, typedContainer, user))
  ) {
    return { result: 'not-found' };
  }
  try {
    const resp = await fetchBrain(
      brainContainer,
      '/status',
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      },
      typedToken ? undefined : resolveBrainAuthTokenOwner(group, group.folder),
    );
    if (!resp) {
      const status = brainResolutionStatus(brainContainer);
      return { result: status === 'resolved' ? 'unreachable' : status };
    }
    if (resp.ok) return { result: 'accepted' };
    if (resp.status === 401 || resp.status === 403) {
      return { result: 'rejected', status: resp.status };
    }
    return { result: 'error', status: resp.status };
  } catch (err) {
    logger.info(
      {
        brainContainer,
        url: resolveBrainUrl(brainContainer),
        err: String(err),
      },
      'Brain connection test failed',
    );
    const code = brainTransportErrorCode(err);
    return code ? { result: 'unreachable', code } : { result: 'unreachable' };
  }
}

/**
 * POST /api/projects/:pid/test-brain-connection
 * Body: optional unsaved `brainContainer` and `brainAuthToken`.
 */
router.post('/projects/:pid/test-brain-connection', async (req, res) => {
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) return res.status(404).json({ error: 'Project not found' });
  const body = req.body || {};
  res.json(
    await testBrainConnection(
      entry.group,
      {
        brainContainer:
          typeof body.brainContainer === 'string' ? body.brainContainer : '',
        brainAuthToken:
          typeof body.brainAuthToken === 'string' ? body.brainAuthToken : '',
      },
      (req as any).authUser,
    ),
  );
});

router.post('/projects/:pid/regenerate-prompt', (req, res) => {
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) return res.status(404).json({ error: 'Project not found' });

  const { group } = entry;
  const written = regenerateGroupPrompt(group);
  if (!written)
    return res.status(400).json({
      error: 'Cannot regenerate — project uses a repository prompt',
    });

  res.json({ ok: true });
});

export async function preserveDetachedChildDirectory(
  oldChildDir: string,
  newChildDir: string,
): Promise<void> {
  // Both parents are pinned once (the parent group dir, or GROUPS_DIR), and
  // the child directories are only ever named through them.
  const src = await openParentDir(oldChildDir);
  if (!src) return;
  try {
    if (!(await lstatAt(src.dir, src.name).catch(() => null))) return;
    await fsp.mkdir(path.dirname(newChildDir), { recursive: true });
    const dst = await openParentDir(newChildDir);
    if (!dst) throw new GroupFsError('not_found', 'Missing detach target');
    try {
      const copyAndRemove = async () => {
        let from: PinnedDir | null = null;
        let to: PinnedDir | null = null;
        try {
          from = await openDirAt(src.dir, src.name);
          to = await openDirAt(dst.dir, dst.name, { create: true });
          if (!from || !to) {
            throw new GroupFsError('not_found', 'Child folder disappeared');
          }
          await copyTree(from, to);
        } finally {
          await from?.close();
          await to?.close();
        }
        await removeAt(src.dir, src.name, { recursive: true });
      };
      // The nested copy is authoritative: an existing flat folder is merged into.
      if (await lstatAt(dst.dir, dst.name).catch(() => null)) {
        await copyAndRemove();
        return;
      }
      try {
        await renameAt(src.dir, src.name, dst.dir, dst.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
        await copyAndRemove();
      }
    } finally {
      await dst.dir.close();
    }
  } finally {
    await src.dir.close();
  }
}

/**
 * DELETE /api/projects/:pid
 * Permanently delete a project and all associated data.
 */
router.delete('/projects/:pid', async (req, res) => {
  const entry = getGroupEntryByFolder(req.params.pid);

  if (!entry) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { group } = entry;

  if (group.is_main) {
    return res
      .status(403)
      .json({ error: 'Cannot delete the main group project' });
  }

  // Deletion is irreversible: owner/admin only, like member management.
  // Agent tokens and no-auth single-user mode carry no authUser.
  const authUser = (req as any).authUser;
  if (
    authUser &&
    !adminBypassesProject(authUser, req.params.pid) &&
    !(await userIsProjectOwner(authUser.id, req.params.pid))
  ) {
    return res.status(403).json({ error: 'Owner or admin access required' });
  }

  // Detaching children rewrites their `parentId` and moves directories: it
  // must not interleave with a parent change.
  return withReparentMutex(async () => {
    // The project and its children are read again under the mutex: a parent
    // change or rename that ran first has moved things since the request began.
    const fresh = getGroupEntryByFolder(req.params.pid);
    if (!fresh) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const { jid, group } = fresh;
    const deletionSandbox = projectDeletionSandboxTarget(group);
    const childEntries = Object.entries(registeredGroups).filter(
      ([, candidate]) => candidate.parentId === group.folder,
    );

    // Integration keys are bound to a sandbox name and the next project to use
    // it would be served them: delete those on the folder name (any stack) and
    // on the project's own binding before anything else changes. A child
    // inheriting its parent's sandbox has no own binding.
    try {
      const removed = await deleteProjectKeys(
        group.folder,
        ownSandboxBinding(group),
      );
      if (removed > 0)
        logger.info(
          { folder: group.folder, removed },
          'Deleted project integration keys before project deletion',
        );
    } catch (error) {
      logger.error(
        { folder: group.folder, err: String(error) },
        'Could not delete project integration keys',
      );
      return res.status(502).json({
        error:
          'Could not delete the project integration keys from CarapaBox; the project was not deleted',
      });
    }

    try {
      for (const affected of [
        group,
        ...childEntries.map(([, child]) => child),
      ]) {
        if (affected.settings?.appPublication)
          await setAppPublication(affected, { enabled: false });
      }
    } catch (error) {
      return res.status(502).json({
        error: `Could not revoke published app before project deletion: ${String(error)}`,
      });
    }

    // Child group directories live below the parent directory. Quiesce every
    // affected project before moving children out so no run writes into a path
    // while it is being detached.
    for (const affected of [group, ...childEntries.map(([, child]) => child)]) {
      const stoppedTasks = await stopAllProjectTasks(affected.folder);
      if (stoppedTasks > 0) {
        logger.info(
          { folder: affected.folder, stoppedTasks },
          'Stopped running tasks before project deletion',
        );
      }
      try {
        await killChatAgentProcess(affected.folder);
      } catch (err) {
        logger.warn(
          { folder: affected.folder, err },
          'Failed to kill chat agent (non-fatal)',
        );
      }
    }

    // Detach children and preserve their nested group data before deleting the
    // parent directory. The nested copy is authoritative if a stale flat path
    // from an older install also exists.
    for (const [childJid, child] of childEntries) {
      const oldChildDir = getGroupDir(child.folder);
      await updateGroup(childJid, { parentId: undefined });
      const newChildDir = getGroupDir(child.folder);
      if (oldChildDir !== newChildDir) {
        try {
          await preserveDetachedChildDirectory(oldChildDir, newChildDir);
        } catch (err) {
          await updateGroup(childJid, { parentId: group.folder });
          logger.error(
            { child: child.folder, oldChildDir, newChildDir, err },
            'Failed to preserve child data while deleting parent',
          );
          return res.status(500).json({
            error: `Failed to detach child project "${child.folder}"`,
          });
        }
      }
    }

    // Inherited children do not own their parent's container or IPC directory.
    // Shared owners use their configured effective instance; standalone
    // projects retain the legacy folder-named deletion target.
    if (deletionSandbox) {
      const { stack, instance } = deletionSandbox;
      try {
        const client = getSandboxClient();
        await client.sandboxStop(stack, instance);
        logger.info({ stack, instance }, 'Stopped sandbox container');
        await getTmuxClient().forgetByInstance(instance);
      } catch (err) {
        logger.warn(
          { stack, instance, err },
          'Failed to stop sandbox (non-fatal)',
        );
      }
    }

    // Project is being deleted — revoke its no-expiry agent tokens.
    await revokeGroupTokens(group.folder);

    // Remove deleted projects from every app's recall-only source list.
    await removeDeletedMemorySourceReferences(group.folder);

    // Delete all DB data for this project
    await deleteProjectData(group.folder);

    // Erase the project's Neo4j memory/entity nodes (SQL rows are already gone).
    // A Neo4j outage must not fail the delete; it only leaves orphans.
    try {
      const deleted = await getVectorStoreHooks()?.deleteGroupMemoryGraph?.(
        group.folder,
      );
      if (deleted !== undefined) {
        logger.info(
          { folder: group.folder, deleted },
          'memory_vector_project_deleted',
        );
      }
    } catch {
      logger.warn(
        { folder: group.folder },
        'memory_vector_project_delete_failed',
      );
    }

    // Remove project prompt files
    deleteProjectPrompt(group.folder);
    await deleteStarterPrompts(group.folder);

    // Clean up filesystem directories
    const groupDir = getGroupDir(group.folder);
    try {
      // Removed through the pinned parent: a link swapped in for the folder is
      // unlinked, never followed. A directory that is already gone counts as removed.
      const parent = await openParentDir(groupDir);
      if (parent) {
        try {
          await removeAt(parent.dir, parent.name, { recursive: true });
        } finally {
          await parent.dir.close();
        }
      }
      logger.info({ groupDir }, 'Removed group directory');
    } catch (err) {
      if (!(err instanceof GroupFsError && err.code === 'not_found')) {
        logger.warn({ groupDir, err }, 'Failed to remove group directory');
      }
    }

    if (deletionSandbox) {
      const ipcDir = path.join(
        DATA_DIR,
        'ipc',
        `${deletionSandbox.stack}-${deletionSandbox.instance}`,
      );
      try {
        await fsp.rm(ipcDir, { recursive: true, force: true });
        logger.info({ ipcDir }, 'Removed IPC directory');
      } catch {
        /* directory may not exist */
      }
      try {
        // The authoritative tree lives on the box host.
        await ipcReplica.removeProject(path.basename(ipcDir));
      } catch (err) {
        logger.warn({ err, ipcDir }, 'Failed to remove box-side IPC directory');
      }
    }

    // Unregister from in-memory groups registry
    await unregisterGroup(jid);

    logger.info({ folder: group.folder }, 'Project deleted');
    res.json({ ok: true });
  });
});

// --- Git push ---

export { canEditProjectLocalFiles };

function editableSourceRoot(
  groupFolder: string,
  source: EditableFileSource,
): string {
  const groupRoot = getGroupDir(groupFolder);
  return source === 'artifact' ? path.join(groupRoot, 'artifacts') : groupRoot;
}

function parseEditableSource(value: unknown): EditableFileSource | null {
  return value === 'group' || value === 'artifact' ? value : null;
}

function sendEditableError(res: any, error: unknown) {
  if (error instanceof EditableFileError) {
    if (error.status === 409 && error.stale) {
      return res.status(409).json({
        error: error.message,
        currentRevision: error.stale.revision,
        currentSize: error.stale.size,
      });
    }
    return res.status(error.status).json({ error: error.message });
  }
  logger.warn({ err: error }, 'Local file edit failed');
  return res.status(500).json({ error: 'Failed to edit file' });
}

export function createEditableFileHandlers(
  deps: {
    getGroup: typeof getGroupByFolder;
    sourceRoot: typeof editableSourceRoot;
    load: typeof loadEditableLocalFile;
    replace: typeof replaceEditableLocalFile;
    emit: typeof broadcast;
  } = {
    getGroup: getGroupByFolder,
    sourceRoot: editableSourceRoot,
    load: loadEditableLocalFile,
    replace: replaceEditableLocalFile,
    emit: broadcast,
  },
) {
  /** Owner/admin-only authoritative text load. Repo is intentionally not a source. */
  const get = async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!canEditProjectLocalFiles(req))
      return res
        .status(403)
        .json({ error: 'Owner, editor or admin access is required' });
    const group = deps.getGroup(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const source = parseEditableSource(req.query.source);
    if (!source) return res.status(400).json({ error: 'Invalid source' });
    try {
      res.json(
        await deps.load(
          deps.sourceRoot(group.folder, source),
          req.query.path,
          source,
        ),
      );
    } catch (error) {
      return sendEditableError(res, error);
    }
  };

  /** Atomic compare-and-swap replacement of an existing local text file. */
  const put = async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!canEditProjectLocalFiles(req))
      return res
        .status(403)
        .json({ error: 'Owner, editor or admin access is required' });
    const group = deps.getGroup(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const source = parseEditableSource(req.body?.source);
    if (!source) return res.status(400).json({ error: 'Invalid source' });
    try {
      const result = await deps.replace(
        deps.sourceRoot(group.folder, source),
        req.body?.path,
        source,
        req.body?.content,
        req.body?.expectedRevision,
      );
      deps.emit({
        type:
          source === 'artifact' ? 'artifacts_changed' : 'group_files_changed',
        payload: { folder: group.folder },
      });
      res.json(result);
    } catch (error) {
      return sendEditableError(res, error);
    }
  };

  return { get, put };
}

const editableFileHandlers = createEditableFileHandlers();
export const getEditableFileHandler = editableFileHandlers.get;
router.get('/projects/:pid/files/editable-content', getEditableFileHandler);

export const putEditableFileHandler = editableFileHandlers.put;
router.put('/projects/:pid/files/editable-content', putEditableFileHandler);

/**
 * POST /api/projects/:pid/files/group/{rename,move,delete}
 * Owner/editor/admin mutations of group-folder files and folders (paths are
 * group-relative). Protected paths and links are refused in group-file-ops.
 */
function groupFileMutationHandler(
  op: (
    folder: string,
    body: Record<string, unknown>,
    opts: GroupFileOpOptions,
  ) => Promise<GroupFileOpResult>,
  /** Runs after the change succeeded, under the favorites lock; a failure is logged only. */
  syncFavorites: (
    folder: string,
    result: Omit<GroupFileOpResult, 'artifacts'>,
  ) => Promise<void>,
) {
  return async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!canEditProjectLocalFiles(req))
      return res
        .status(403)
        .json({ error: 'Owner, editor or admin access is required' });
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const emit = (artifacts: unknown) =>
      broadcast({
        type: artifacts ? 'artifacts_changed' : 'group_files_changed',
        payload: { folder: group.folder },
      });
    try {
      // Nested child projects live inside this folder and are board-owned.
      // One lock per project: favorites reads never see the file moved but its
      // favorites not yet rewritten.
      const { artifacts, ...result } = await withFavoritesLock(
        group.folder,
        async () => {
          await requireSettledFavoriteMoves(group.folder);
          const done = await op(group.folder, req.body ?? {}, {
            extraProtectedRoot: childProjectFolders(group.folder),
            // Recorded before the file moves; settled right after it did.
            beforeMove: (from, to) =>
              recordFavoriteMove(group.folder, from, to),
          }).catch(async (error) => {
            // A refused or failed change must not leave its move record behind.
            await settleFavoriteMoves(group.folder);
            throw error;
          });
          // The file change is done; a favorites failure must not fail the request.
          await syncFavorites(group.folder, done).catch((err) =>
            logger.warn(
              { err, folder: group.folder },
              'File favorites sync failed',
            ),
          );
          return done;
        },
      );
      emit(artifacts);
      res.json({ ok: true, ...result });
    } catch (error) {
      if (!(error instanceof GroupFileOpError)) {
        logger.warn({ err: error }, 'Group file mutation failed');
        return res.status(500).json({ error: 'Failed to change files' });
      }
      const { artifacts, ...extra } = error.extra ?? {};
      // A folder delete that stopped partway still changed the listing.
      if (Number(extra.removedCount) > 0) emit(artifacts);
      res.status(error.status).json({ error: error.message, ...extra });
    }
  };
}

/** A failed settle leaves the record for the next favorites read or change. */
const settleMovedFavorites = async (folder: string) => {
  await settleFavoriteMoves(folder);
};
router.post(
  '/projects/:pid/files/group/rename',
  groupFileMutationHandler(
    (folder, body, opts) =>
      renameGroupPath(folder, body.path, body.newName, opts),
    settleMovedFavorites,
  ),
);
router.post(
  '/projects/:pid/files/group/move',
  groupFileMutationHandler(
    (folder, body, opts) =>
      moveGroupPath(folder, body.path, body.destination, opts),
    settleMovedFavorites,
  ),
);
router.post(
  '/projects/:pid/files/group/delete',
  groupFileMutationHandler(
    (folder, body, opts) => deleteGroupPath(folder, body.path, opts),
    (folder, result) => dropDeletedFavorites(folder, result.path),
  ),
);

/**
 * GET /api/projects/:pid/files/group
 * List the project's local working directory (`groups/<folder>/`) as a flat
 * list of relative file paths, skipping noisy dirs (logs, node_modules, .git).
 * Powers the chat/objective "Files" sidebar tab (group-folder source).
 */
router.get('/projects/:pid/files/group', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const dir = typeof req.query.path === 'string' ? req.query.path : '';
  const cursor =
    typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const search =
    typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 50;
  if (dir && !isSafeRelativePath(dir)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const sort = req.query.sort ?? 'name';
  const order = req.query.order ?? 'asc';
  if (
    (sort !== 'name' && sort !== 'modified') ||
    (order !== 'asc' && order !== 'desc')
  ) {
    return res.status(400).json({ error: 'Invalid sort' });
  }

  // The group folder is agent-writable: it is pinned once and every directory
  // below it is opened with O_NOFOLLOW from that descriptor.
  let root: PinnedDir | null = null;
  try {
    root = await openGroupDir(group.folder);
    if (search) {
      const start = cursor ? Number(cursor) : 0;
      if (!Number.isSafeInteger(start) || start < 0)
        return res.status(400).json({ error: 'Invalid cursor' });
      // `path` optionally scopes the search to one subdirectory. Matching uses
      // the scope-relative path; results stay relative to the group root so
      // they open like any other group file.
      const scope = dir.split(/[\\/]+/).filter((s) => s && s !== '.');
      let scopeDir: PinnedDir | null = null;
      if (root) {
        try {
          scopeDir =
            scope.length > 0 ? await openDirAt(root, scope.join('/')) : root;
        } catch (err) {
          // A linked or non-directory scope is outside the group: no results.
          if (!(err instanceof GroupFsError) || err.code === 'unsupported')
            throw err;
        }
      }
      const needle = search.toLowerCase();
      const prefix = scope.length > 0 ? `${scope.join('/')}/` : '';
      let matches: string[] = [];
      if (scopeDir) {
        try {
          matches = (await walkFilesAt(scopeDir))
            .filter((filePath) => filePath.toLowerCase().includes(needle))
            .map((filePath) => prefix + filePath);
        } finally {
          if (scopeDir !== root) await scopeDir.close();
        }
      }
      const pageEntries = matches
        .slice(start, start + limit)
        .map((filePath) => ({
          kind: 'file' as const,
          name: filePath.split('/').pop()!,
          path: filePath,
        }));
      if (root) await addFileSizesAt(root, pageEntries);
      return res.json({
        entries: pageEntries,
        nextCursor:
          start + limit < matches.length ? String(start + limit) : undefined,
        canManage: canEditProjectLocalFiles(req),
      } satisfies GroupFilesResponse);
    }
    if (!root) {
      throw Object.assign(new Error('Group folder not found'), {
        code: 'ENOENT',
      });
    }
    const listed = await listDirectoryAt(root, dir, limit, cursor, undefined, {
      sort,
      order,
    });
    res.json({
      ...listed,
      canManage: canEditProjectLocalFiles(req),
    } satisfies GroupFilesResponse);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === 'Invalid cursor' ||
        err.message === 'Path escapes root' ||
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'ENOTDIR' ||
        (err instanceof GroupFsError &&
          ['invalid_path', 'symlink', 'not_directory'].includes(err.code)))
    ) {
      return res.status(400).json({ error: 'Invalid directory or cursor' });
    }
    logger.warn({ err, project: req.params.pid }, 'Failed to list group files');
    res.status(500).json({ error: 'Failed to list group files' });
  } finally {
    await root?.close();
  }
});

/**
 * Pin `relPath` (already checked with isSafeRelativePath) below a group folder
 * and open it as a regular file without following any link. Null when it is
 * missing; refusals throw a GroupFsError. The caller closes the handle.
 */
async function openGroupContentFile(
  folder: string,
  relPath: string,
): ReturnType<typeof openFileAt> {
  const root = await openGroupDir(folder);
  if (!root) return null;
  try {
    return await openFileAt(
      root,
      relPath
        .split('/')
        .filter((segment) => segment && segment !== '.')
        .join('/'),
    );
  } finally {
    await root.close();
  }
}

/** GroupFsError codes that mean the path is not a usable group file (not an I/O problem). */
function isGroupFsRefusal(err: unknown): boolean {
  return (
    err instanceof GroupFsError &&
    ['invalid_path', 'symlink', 'not_directory', 'not_regular_file'].includes(
      err.code,
    )
  );
}

/**
 * HEAD /api/projects/:pid/files/group/content?path=<relative>
 * Same path safety as the GET counterpart, but only returns the headers
 * (notably Content-Length) so the preview pane can probe a file's size
 * before deciding whether to render the body inline. Lets us short-circuit
 * huge text/code files at ~500 KiB without ever pulling the body.
 *
 * Must be registered before the GET route: Express lets `router.get` answer
 * HEAD requests, so a later HEAD handler would never run.
 */
router.head('/projects/:pid/files/group/content', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).end();

  const relPath = req.query.path;
  if (!isSafeRelativePath(relPath)) {
    return res.status(400).end();
  }

  let opened: Awaited<ReturnType<typeof openFileAt>>;
  try {
    opened = await openGroupContentFile(group.folder, relPath);
  } catch (err) {
    if (isGroupFsRefusal(err)) return res.status(400).end();
    logger.warn(
      { err, project: req.params.pid, path: relPath },
      'Failed to open group file',
    );
    return res.status(500).end();
  }
  if (!opened) return res.status(404).end();

  try {
    const mimetype = await detectMimetypeForHandle(
      opened.handle,
      path.basename(relPath),
    );
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Length', String(opened.stat.size));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).end();
  } catch {
    return res.status(500).end();
  } finally {
    await opened.handle.close().catch(() => {});
  }
});

/**
 * GET /api/projects/:pid/files/group/content?path=<relative>
 * Return the bytes of a single file inside the group folder
 * (`groups/<folder>/`). Path safety: rejects `..` segments and absolute
 * paths up front so the resolved file can never escape the base dir.
 *
 * Response shape mirrors the repo counterpart:
 *   - Text-like mimetypes → JSON `{ path, mimetype, content, encoding: 'utf-8' }`,
 *     matching the JSON path that api.ts / handleResponse already understands.
 *     When `?offset=` and `?length=` are present (preview-pane chunked reads
 *     for large text/log files) the envelope adds `total`, `offset`, and
 *     `length` and `content` is just the requested byte slice. Chunked reads
 *     use `fs.createReadStream` and pipe through the same JSON envelope; the
 *     client treats the response as a 20 KiB window that may be followed by
 *     more on scroll.
 *   - Binary mimetypes (images, pdf, audio, video, octet-stream) →
 *     raw bytes with the matching `Content-Type` header, so the browser /
 *     native client (useSecureMedia) can render them directly without a
 *     base64 round-trip. Chunked reads are not supported for binary — the
 *     preview pane only chunks text.
 */
router.get('/projects/:pid/files/group/content', async (req, res) => {
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const relPath = req.query.path;
  if (!isSafeRelativePath(relPath)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  // Every directory is pinned with O_NOFOLLOW and the file is read (or sent)
  // through its descriptor, so a swap after the open cannot redirect the read.
  let opened: Awaited<ReturnType<typeof openFileAt>>;
  try {
    opened = await openGroupContentFile(group.folder, relPath);
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'not_regular_file') {
      return res.status(400).json({ error: 'Not a file' });
    }
    if (isGroupFsRefusal(err)) {
      return res.status(400).json({ error: 'Path escapes base directory' });
    }
    logger.warn(
      { err, project: req.params.pid, path: relPath },
      'Failed to read group file',
    );
    return res.status(500).json({ error: 'Failed to read file' });
  }
  if (!opened) return res.status(404).json({ error: 'File not found' });

  // sendPinnedFile takes over the handle for binary responses.
  let handedOff = false;
  try {
    const { handle, stat } = opened;
    const mimetype = await detectMimetypeForHandle(
      handle,
      path.basename(relPath),
    );
    const total = stat.size;

    if (req.query.thumbnail === '1') {
      if (!isImageFilePath(relPath))
        return res.status(415).json({ error: 'Thumbnail unavailable' });
      const source = await readHandleBounded(
        handle,
        total,
        MAX_THUMBNAIL_SOURCE_BYTES,
      );
      const thumbnail = source && (await createFileThumbnail(source));
      if (!thumbnail)
        return res.status(415).json({ error: 'Thumbnail unavailable' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(thumbnail.length));
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.send(thumbnail);
    }

    if (isTextMimetype(mimetype)) {
      // Parse + validate the offset/length query params. Out-of-range or
      // malformed values fall back to a read from the head so the caller
      // always gets something it can render. Both that and an explicit window
      // are capped, so a large file is never read whole: `total` and the byte
      // `length` tell the client to keep paging.
      const requested = parseChunkParams(req.query, total) ?? {
        offset: 0,
        length: total,
      };
      const offset = requested.offset;
      const length = Math.min(requested.length, MAX_TEXT_READ_BYTES);
      // For text reads we want a valid UTF-8 slice, so we read with a small
      // safety margin (up to 3 bytes on each side — the longest UTF-8
      // sequence) and then trim back to the nearest character boundary.
      // This avoids splitting a multi-byte character when the caller asks
      // for `offset=1000, length=20480` on a UTF-8 file. The previews are
      // monospace code/log text, so a few extra ASCII bytes at the edges
      // are harmless and far simpler than full codepoint alignment.
      const margin = 3;
      const readStart = Math.max(0, offset - margin);
      const readEnd = Math.min(total, offset + length + margin);
      const buf = Buffer.alloc(readEnd - readStart);
      const { bytesRead } = await handle.read(buf, 0, buf.length, readStart);
      // The file may have shrunk since fstat; drop the unread zero-filled tail.
      const readBuf = buf.subarray(0, bytesRead);
      const { start, end } = applyUtf8SafeWindow(
        readBuf,
        offset - readStart,
        offset - readStart + length,
        0,
      );
      res.json({
        path: relPath,
        mimetype,
        content: readBuf.subarray(start, end).toString('utf-8'),
        total,
        offset: readStart + start,
        length: end - start,
        encoding: 'utf-8',
      });
      return;
    }
    // Binary: stream raw bytes with Content-Type so the browser can render
    // the file directly (useSecureMedia wraps this path for chat attachments).
    // Chunked binary reads are not supported — the preview pane only chunks
    // text. The route still rejects `?offset=` cleanly for binary so the
    // client doesn't silently get the whole file when it asked for a slice.
    if (req.query.offset !== undefined) {
      return res.status(416).json({ error: 'Range not supported for binary' });
    }
    setRawFileHeaders(res, mimetype, path.basename(relPath));
    res.setHeader('Content-Length', String(total));
    res.setHeader('Cache-Control', 'private, max-age=60');
    handedOff = true;
    sendPinnedFile(res, opened);
  } catch (err) {
    logger.warn(
      { err, project: req.params.pid, path: relPath },
      'Failed to read group file',
    );
    return res.status(500).json({ error: 'Failed to read file' });
  } finally {
    if (!handedOff) await opened.handle.close().catch(() => {});
  }
});

const withGitLockInLocalRepoMode = <T>(
  group: RegisteredGroup,
  pid: string,
  fn: () => Promise<T>,
) =>
  // Network git can outlast the default lock timeout; the lock must stay held
  // until the operation settles so nothing else runs against the checkout.
  isLocalRepoMode(group)
    ? withProjectGitLock(pid, fn, { waitForCompletion: true })
    : fn();

const PUSH_SNAPSHOT_REF = 'refs/board/push-snapshot';

router.post('/projects/:pid/git/push', async (req, res) => {
  if (!requireSignedInUser(req, res)) return;
  const { pid } = req.params;
  const group = getGroupByFolder(pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const defaultBranch = group.settings?.defaultBranch?.trim() || 'develop';
  const repositoryUrl = group.settings?.repositoryUrl?.trim() || 'origin';
  const branchRef = `refs/heads/${defaultBranch}`;

  try {
    const pushFn = async (): Promise<{
      ok: boolean;
      output: string;
      warning?: string;
    }> => {
      const branch = await runGitInRepo(
        group,
        `rev-parse --verify ${shellQuote(`${branchRef}^{commit}`)}`,
      );
      if (!branch.ok) {
        return {
          ok: false,
          output: `Cannot read local branch "${defaultBranch}". Check that it has a commit and that Default Branch names the branch you want to publish.\n${branch.output}`,
        };
      }
      // Push and record one captured commit: a running agent may advance the
      // branch ref between these calls, which would make the recorded
      // tracking ref disagree with what was actually published.
      const pushedSha = branch.output.trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pushedSha)) {
        return {
          ok: false,
          output: `Could not resolve local branch "${defaultBranch}" to a commit.\n${branch.output}`,
        };
      }
      // CarapaBox qualifies a bare push source as refs/heads/<src>, so a raw
      // SHA cannot be pushed to a pinned URL. Pin the captured commit under a
      // fully qualified Board-owned ref and push that instead.
      const snapshot = await runGitInRepo(
        group,
        `update-ref ${shellQuote(PUSH_SNAPSHOT_REF)} ${shellQuote(pushedSha)}`,
        undefined,
        { waitForCompletion: true },
      );
      if (!snapshot.ok) {
        return {
          ok: false,
          output: `Could not snapshot local branch "${defaultBranch}" for pushing.\n${snapshot.output}`,
        };
      }
      let pushed: { ok: boolean; output: string };
      try {
        pushed = await runGitInRepo(
          group,
          `push -- ${shellQuote(repositoryUrl)} ${shellQuote(`${PUSH_SNAPSHOT_REF}:${branchRef}`)}`,
          undefined,
          { waitForCompletion: true },
        );
      } finally {
        const cleanup = await runGitInRepo(
          group,
          `update-ref -d ${shellQuote(PUSH_SNAPSHOT_REF)}`,
          undefined,
          { waitForCompletion: true },
        ).catch((err: unknown) => ({ ok: false, output: String(err) }));
        if (!cleanup.ok) {
          logger.warn(
            { project_id: pid, output: cleanup.output },
            '[git] could not delete push snapshot ref',
          );
        }
      }
      if (!pushed.ok) return pushed;
      // Pushing to a URL leaves tracking refs untouched. If refreshing the
      // Board-owned one fails, the push still happened: report it so the
      // caller does not present stale ahead/behind counts as current.
      const recorded = await recordPushedDefaultBranch(
        group,
        defaultBranch,
        pushedSha,
      );
      if (!recorded.ok) {
        logger.warn(
          { project_id: pid, output: recorded.output },
          '[git] could not refresh default-branch tracking ref after push',
        );
        return {
          ...pushed,
          warning:
            `Pushed, but could not refresh the remote-tracking ref, so ahead/behind may be stale: ${recorded.output}`.trim(),
        };
      }
      return pushed;
    };
    // Always serialize: concurrent pushes share one snapshot ref, in every
    // repository mode. Network git can outlast the default lock timeout.
    const result = await withProjectGitLock(pid, pushFn, {
      waitForCompletion: true,
    });

    if (!result.ok) {
      logger.warn(
        { project_id: pid, output: result.output },
        '[git] push to remote failed',
      );
      return res.status(500).json({
        ok: false,
        error: result.output || 'Git push failed without an error message',
        output: result.output,
      });
    }

    logger.info(
      { project_id: pid, branch: defaultBranch },
      '[git] pushed default branch to remote',
    );
    return res.json({
      ok: true,
      output: result.output,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (err) {
    logger.error({ project_id: pid, err }, '[git] push threw');
    return res.status(500).json({
      ok: false,
      error: String(err),
      output: String(err),
    });
  }
});

/** Default branch and saved remote URL used by the Changes-tab sync row. */
function defaultBranchSyncTarget(group: RegisteredGroup) {
  return {
    defaultBranch: group.settings?.defaultBranch?.trim() || 'develop',
    repositoryUrl: group.settings?.repositoryUrl?.trim() || '',
  };
}

/** Ahead/behind of the default branch from the last fetch (no network). */
router.get('/projects/:pid/git/sync-status', async (req, res) => {
  const { pid } = req.params;
  const group = getGroupByFolder(pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  try {
    const { defaultBranch } = defaultBranchSyncTarget(group);
    return res.json(await getDefaultBranchSyncStatus(group, defaultBranch));
  } catch (err) {
    logger.error({ project_id: pid, err }, '[git] sync-status threw');
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** How long a Pull waits for a running shared-checkout task before giving up. */
const SHARED_CHECKOUT_PULL_WAIT_MS = 5_000;

/**
 * Pull rewrites the shared checkout, which task agents edit while they hold
 * the shared-checkout lease. Take the same lease (before the git lock) so a
 * fast-forward never lands under a running agent; null when one is running.
 */
async function acquireSharedCheckoutForPull(pid: string) {
  const signal = AbortSignal.timeout(SHARED_CHECKOUT_PULL_WAIT_MS);
  try {
    return await acquireSharedCheckoutLease(
      pid,
      { type: 'task', id: `git-pull-${randomUUID()}` },
      { signal },
    );
  } catch (err) {
    if (signal.aborted) return null;
    throw err;
  }
}

for (const action of ['fetch', 'pull'] as const) {
  router.post(`/projects/:pid/git/${action}`, async (req, res) => {
    if (!requireSignedInUser(req, res)) return;
    const { pid } = req.params;
    const group = getGroupByFolder(pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const { defaultBranch, repositoryUrl } = defaultBranchSyncTarget(group);
    if (!repositoryUrl) {
      return res
        .status(400)
        .json({ ok: false, error: 'No repository URL saved for this project' });
    }
    let lease: Awaited<ReturnType<typeof acquireSharedCheckoutLease>> | null =
      null;
    try {
      const run =
        action === 'fetch' ? fetchDefaultBranch : pullDefaultBranchFastForward;
      if (action === 'pull') {
        lease = await acquireSharedCheckoutForPull(pid);
        if (!lease) {
          return res.status(409).json({
            ok: false,
            error:
              'A task is using the shared checkout right now. Try again when it finishes.',
          });
        }
      }
      const result = await withGitLockInLocalRepoMode(group, pid, () =>
        run(group, defaultBranch, repositoryUrl),
      );
      if (!result.ok) {
        logger.warn(
          { project_id: pid, output: result.output },
          `[git] ${action} failed`,
        );
        return res.status(500).json({
          ok: false,
          error:
            result.output || `Git ${action} failed without an error message`,
          output: result.output,
        });
      }
      logger.info(
        { project_id: pid, branch: defaultBranch },
        `[git] ${action} default branch`,
      );
      return res.json({ ok: true, output: result.output });
    } catch (err) {
      logger.error({ project_id: pid, err }, `[git] ${action} threw`);
      return res
        .status(500)
        .json({ ok: false, error: String(err), output: String(err) });
    } finally {
      await lease?.release();
    }
  });
}

// A rename or settings change refused because CarapaBox could not list or
// delete the project's integration keys answers 502, a rename that finds its
// target taken late answers 409, both with a JSON body.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof BoxCleanupError)
    return res.status(502).json({ error: err.message });
  if (err instanceof FolderNameTakenError)
    return res.status(409).json({ error: err.message });
  next(err);
});

export default router;
