/**
 * MCP authorization helpers and shared types.
 *
 * Centralizes the auth logic used by both agent and orchestrator tool sets.
 */

import { trackGrants } from '../lib/folder-identity.js';
import type { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  getProjectChangeEpoch,
  stampResolvedEpoch,
} from '../lib/project-changes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared dependency contract
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencies injected from index.ts to avoid circular imports */
export interface McpServerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void | Promise<void>;
  updateGroup: (jid: string, updates: Partial<RegisteredGroup>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the token scope allows the requiredPermission on the targetGroup.
 */
export function hasPermission(
  permissions: Record<string, string[]> | undefined,
  targetGroup: string,
  requiredPermission: string,
): boolean {
  if (!permissions) return false;

  // 1. Check for wildcard group '*'
  const allGroupPerms = permissions['*'];
  if (allGroupPerms && checkPermMatch(allGroupPerms, requiredPermission))
    return true;

  // 2. Check for explicit targetGroup
  const targetGroupPerms = permissions[targetGroup];
  if (targetGroupPerms && checkPermMatch(targetGroupPerms, requiredPermission))
    return true;

  return false;
}

export function checkPermMatch(perms: string[], required: string): boolean {
  if (perms.includes('*:*')) return true;
  if (perms.includes(required)) return true;

  // Wildcard match (e.g. 'tasks:*' matches 'tasks:write')
  const [feature] = required.split(':');
  if (perms.includes(`${feature}:*`)) return true;

  return false;
}

/**
 * Tools without `requiredPermissions` that only read or are otherwise harmless
 * to data. A read-only OAuth grant may call these, plus any tool whose
 * required permissions are all `:read`. Every other tool is refused, so a new
 * write tool that forgets to declare permissions fails closed for read grants.
 */
const READ_ONLY_PERMISSIONLESS_TOOLS = new Set([
  'web_search',
  'web_view',
  'load_toolset',
  'search_knowledge',
  'list_knowledge_tags',
  'list_knowledge_documents',
  'read_knowledge_document',
]);

/** True when a read-only OAuth scope must not see or call `tool`. */
export function isBlockedForReadOnlyOAuth(
  tool: { name: string; requiredPermissions?: string[] },
  scope: { kind?: string; oauth_access?: string } | undefined,
): boolean {
  if (scope?.kind !== 'oauth' || scope.oauth_access === 'write') return false;
  const required = tool.requiredPermissions ?? [];
  if (required.length > 0) return !required.every((p) => p.endsWith(':read'));
  return !READ_ONLY_PERMISSIONLESS_TOOLS.has(tool.name);
}

/** Keep `:read` entries and narrow `feature:*` wildcards to `feature:read`. */
export function toReadOnlyPermissions(perms: string[]): string[] {
  return [
    ...new Set(
      perms
        .map((perm) =>
          perm.endsWith(':*') ? perm.replace(/:\*$/, ':read') : perm,
        )
        .filter((perm) => perm.endsWith(':read')),
    ),
  ];
}

export interface MainReachableFolder {
  folder: string;
  readOnly: boolean;
}

/**
 * Folders a per-user main may reach: projects the user owns or is an explicit
 * member of (viewer memberships are read-only). Other users' main projects and
 * implicit conversation-only access are excluded.
 */
export async function resolveMainReachableFolders(
  userId: string,
  allGroups: Record<string, RegisteredGroup>,
): Promise<MainReachableFolder[]> {
  const { getMainReachableProjects } =
    await import('../modules/knowledge/db-kb.js');
  const folders = [
    ...new Set(Object.values(allGroups).map((candidate) => candidate.folder)),
  ];
  return getMainReachableProjects(userId, folders);
}

/**
 * Returns the default set of permissions for an agent based on its group's role.
 *
 * A main (`is_main`, owned by a user) gets explicit entries for its own folder
 * plus the `reachable` folders; without a `reachable` list it fails closed to
 * its own folder only. No agent group gets the `'*'` wildcard.
 */
export function getAgentPermissions(
  group: RegisteredGroup,
  allGroups?: Record<string, RegisteredGroup>,
  reachable?: MainReachableFolder[],
): Record<string, string[]> {
  const isMain = !!group.is_main;
  const isParent = group.settings?.isParent === true;

  const standardPerms = [
    'agent:delegate',
    'chat:write',
    'scheduling:*',
    'memories:*',
    'tasks:*',
    'cron:*',
    'datasets:*',
    'objectives:*',
    'groups:read',
    'fs:read',
    'project_setup:read',
    'project_setup:write',
    'sandbox:restart',
    'images:generate',
    'images:fetch',
    'gitnexus:read',
    'gitnexus:write',
  ];

  const permissions: Record<string, string[]> = {};

  // Standard permissions for own group
  permissions[group.folder] = [...standardPerms];

  // Only the main group can perform administrative group management
  if (isMain) {
    permissions[group.folder].push('groups:write');
    permissions[group.folder].push('stages:write');
    for (const { folder, readOnly } of reachable ?? []) {
      if (folder === group.folder) continue;
      const folderPerms = [...standardPerms];
      // A viewer must not gain write access through their main agent:
      // keep `:read` entries and narrow `feature:*` wildcards to read.
      permissions[folder] = readOnly
        ? toReadOnlyPermissions(folderPerms)
        : folderPerms;
    }
  }

  // Baking in hierarchy: if parent, grant standard perms to children too
  else if (isParent && allGroups) {
    for (const g of Object.values(allGroups)) {
      if (g.parentId === group.folder) {
        permissions[g.folder] = [...standardPerms];
      }
    }
  }

  // Projects may recall memories from explicitly selected projects.
  // Selections are exact: choosing a parent does not implicitly grant access
  // to its children. This deliberately grants no other cross-project capability.
  if (allGroups) {
    const sources = group.settings?.memorySourceProjects ?? [];
    const knownFolders = new Set(
      Object.values(allGroups).map((candidate) => candidate.folder),
    );
    for (const folder of sources) {
      if (folder !== group.folder && knownFolders.has(folder)) {
        permissions[folder] = [...(permissions[folder] ?? []), 'memories:read'];
      }
    }
  }

  return trackGrants(permissions);
}

/**
 * Async variant of {@link getAgentPermissions} that resolves the folders a
 * per-user main may reach. Resolution failure fails closed to the own folder.
 *
 * The result is a snapshot: tokens minted from it are kept in step with later
 * membership changes by `main-reach-sync`, which re-resolves through
 * {@link resolveAgentPermissions}.
 */
export async function getAgentPermissionsResolved(
  group: RegisteredGroup,
  allGroups?: Record<string, RegisteredGroup>,
): Promise<Record<string, string[]>> {
  return (await resolveAgentPermissions(group, allGroups)).permissions;
}

/**
 * {@link getAgentPermissionsResolved} that also reports whether reach
 * resolution failed (so the permissions were narrowed to the own folder),
 * letting callers log the failure as its own outcome. `quiet` lowers the
 * resolver's own log lines to debug for periodic callers.
 */
export async function resolveAgentPermissions(
  group: RegisteredGroup,
  allGroups?: Record<string, RegisteredGroup>,
  opts?: { quiet?: boolean },
): Promise<{ permissions: Record<string, string[]>; reachFailed: boolean }> {
  if (!group.is_main || !group.user_id) {
    return {
      permissions: getAgentPermissions(group, allGroups),
      reachFailed: false,
    };
  }
  // Read before resolving so a change landing mid-resolution marks the result.
  const epoch = getProjectChangeEpoch();
  let reachable: MainReachableFolder[] = [];
  let reachFailed = false;
  try {
    reachable = await resolveMainReachableFolders(
      group.user_id,
      allGroups ?? {},
    );
    // Periodic re-scope passes resolve repeatedly; only mints log at info.
    logger[opts?.quiet ? 'debug' : 'info'](
      {
        event: 'main_reach_resolved',
        folder: group.folder,
        count: reachable.length,
      },
      'Per-user main reachable projects resolved',
    );
  } catch (err) {
    reachFailed = true;
    logger[opts?.quiet ? 'debug' : 'warn'](
      { event: 'main_reach_resolve_failed', folder: group.folder, err },
      'Per-user main reach resolution failed; own folder only',
    );
  }
  const permissions = getAgentPermissions(group, allGroups, reachable);
  if (reachFailed) {
    // Fail closed: the own folder only, without the cross-folder memory grants
    // the full computation would add.
    return {
      permissions: stampResolvedEpoch(
        trackGrants({ [group.folder]: permissions[group.folder] }),
        epoch,
      ),
      reachFailed,
    };
  }
  return { permissions: stampResolvedEpoch(permissions, epoch), reachFailed };
}
