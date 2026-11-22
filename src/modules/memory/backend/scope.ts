import { hasPermission } from '../../../mcp/auth.js';
import { crossProjectReadAllowed } from '../../../lib/privacy-policy.js';
import { logger } from '../../../logger.js';

/**
 * Build recall group list from MCP permissions.
 * Empty list = orchestrator full access (all projects).
 */
export function resolveRecallGroupFolders(
  permissions: Record<string, string[]> | undefined,
): string[] {
  const groupFolders = Object.keys(permissions || {}).filter((f) =>
    hasPermission(permissions, f, 'memories:read'),
  );
  if (groupFolders.includes('*')) {
    return [];
  }
  return groupFolders;
}

/**
 * Drops projects whose memories the reader may not receive under the privacy
 * policy. Evaluated at call time because the permission grant may predate a
 * mode change. Returns `groupFolders` unchanged when nothing is denied, the
 * filtered explicit list otherwise, and `null` when nothing remains (an empty
 * array would mean "all projects" to the backend).
 */
export function applyPrivacyRecallScope(
  groupFolders: string[],
  readerFolder: string | undefined,
  allFolders: string[],
): string[] | null {
  const scope = groupFolders.length > 0 ? groupFolders : allFolders;
  const denied = new Set(
    scope.filter(
      (folder) => !crossProjectReadAllowed(folder, readerFolder, 'memory'),
    ),
  );
  if (denied.size === 0) return groupFolders;
  logger.info(
    {
      event: 'privacy_cross_project_skip',
      path: 'recall',
      reader: readerFolder ?? null,
      skipped: denied.size,
    },
    'privacy_cross_project_skip',
  );
  const allowed = scope.filter((folder) => !denied.has(folder));
  return allowed.length > 0 ? allowed : null;
}
