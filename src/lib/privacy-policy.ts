import { logger } from '../logger.js';
import { getRuntimeLocality, type ChatAgentOption } from './chat-agents.js';
import { getGroupByFolder, registeredGroups } from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';

export type PrivacyMode = 'off' | 'local_memory' | 'strict';

export type PrivacyPurpose =
  | 'agent'
  | 'chat'
  | 'memory'
  | 'jev'
  | 'embedding'
  | 'knowledge_verify'
  | 'stt'
  | 'image'
  | 'web'
  | 'helper'
  | 'unknown';

const MODE_RANK: Record<PrivacyMode, number> = {
  off: 0,
  local_memory: 1,
  strict: 2,
};

export function privacyModeRank(mode: PrivacyMode | null | undefined): number {
  return MODE_RANK[mode ?? 'off'];
}

const LOCAL_MEMORY_PURPOSES: ReadonlySet<PrivacyPurpose> = new Set([
  'memory',
  'jev',
  'embedding',
  'knowledge_verify',
  'unknown',
]);

const MAX_ANCESTOR_DEPTH = 32;

/** The project's own stored mode, ignoring descendants. Unknown is `off`. */
export function getOwnPrivacyMode(projectId: string): PrivacyMode {
  return getGroupByFolder(projectId)?.settings?.privacyMode ?? 'off';
}

function hasAncestor(group: RegisteredGroup, ancestorId: string): boolean {
  const visited = new Set<string>([group.folder]);
  let parentId = group.parentId;
  for (let depth = 0; parentId && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (parentId === ancestorId) return true;
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    parentId = getGroupByFolder(parentId)?.parentId;
  }
  return false;
}

/**
 * Effective mode of a project plus the folder of the descendant it inherits
 * from (null when its own mode is already the strictest). A parent chain and
 * the main project can read descendants' folders by design, so they are at
 * least as strict as the strictest group below them; the main project covers
 * every registered group.
 */
export function getEffectivePrivacyInfo(projectId: string): {
  mode: PrivacyMode;
  inheritedFrom: string | null;
} {
  const own = getOwnPrivacyMode(projectId);
  let mode = own;
  let inheritedFrom: string | null = null;
  const isMain = getGroupByFolder(projectId)?.is_main === true;
  for (const group of Object.values(registeredGroups)) {
    if (group.folder === projectId) continue;
    if (!isMain && !hasAncestor(group, projectId)) continue;
    const groupMode = group.settings?.privacyMode ?? 'off';
    if (privacyModeRank(groupMode) > privacyModeRank(mode)) {
      mode = groupMode;
      inheritedFrom = group.folder;
    }
  }
  return { mode, inheritedFrom };
}

/** Strictest of the project's own mode and every descendant's (see above). */
export function getEffectivePrivacyMode(projectId: string): PrivacyMode {
  return getEffectivePrivacyInfo(projectId).mode;
}

/**
 * Effective mode for one project (unknown project is `off`). Without a project
 * id the strictest mode set on any registered project applies, so unattributed
 * calls fail closed once any project opts in and stay unchanged when none does.
 */
export function getProjectPrivacyMode(projectId?: string): PrivacyMode {
  if (projectId) return getEffectivePrivacyMode(projectId);
  let strictest: PrivacyMode = 'off';
  for (const group of Object.values(registeredGroups)) {
    const mode = group.settings?.privacyMode ?? 'off';
    if (privacyModeRank(mode) > privacyModeRank(strictest)) strictest = mode;
  }
  return strictest;
}

export function requiresLocal(
  mode: PrivacyMode,
  purpose: PrivacyPurpose,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'strict') return true;
  return LOCAL_MEMORY_PURPOSES.has(purpose);
}

/**
 * Whether content owned by a project in `sourceMode` may enter a run of a
 * different project in `readerMode`. Only a `strict` reader is allowed to
 * receive content whose owner requires local handling for the purpose, since
 * strict is the only mode that gates every consumer of the reader locally.
 */
export function crossProjectModesAllowed(
  sourceMode: PrivacyMode,
  readerMode: PrivacyMode,
  purpose: PrivacyPurpose,
): boolean {
  return !requiresLocal(sourceMode, purpose) || readerMode === 'strict';
}

/**
 * Registered-project variant of `crossProjectModesAllowed`. The same project
 * is always allowed; an unknown/absent reader counts as `off` (not the
 * board-wide strictest mode, which would wrongly allow).
 */
export function crossProjectReadAllowed(
  sourceProjectId: string,
  readerProjectId: string | undefined,
  purpose: PrivacyPurpose,
): boolean {
  if (sourceProjectId === readerProjectId) return true;
  return crossProjectModesAllowed(
    getProjectPrivacyMode(sourceProjectId),
    readerProjectId ? getProjectPrivacyMode(readerProjectId) : 'off',
    purpose,
  );
}

export class PrivacyRefusal extends Error {
  readonly projectId?: string;
  readonly purpose: PrivacyPurpose;
  readonly mode: PrivacyMode;
  readonly target: string;

  constructor(details: {
    projectId?: string;
    purpose: PrivacyPurpose;
    mode: PrivacyMode;
    target: string;
    message?: string;
  }) {
    super(
      details.message ??
        `Privacy mode "${details.mode}" refuses ${details.purpose} egress to a remote target`,
    );
    this.name = 'PrivacyRefusal';
    this.projectId = details.projectId;
    this.purpose = details.purpose;
    this.mode = details.mode;
    this.target = details.target;
  }
}

/**
 * Throws `PrivacyRefusal` when the project's mode requires a local target for
 * this purpose and `locality` is remote. `target` is a runtime id or URL
 * (origin + path), never content.
 */
export function assertEgressAllowed(input: {
  projectId?: string;
  purpose: PrivacyPurpose;
  locality: 'local' | 'remote';
  target: string;
}): void {
  const { projectId, purpose, locality, target } = input;
  const mode = getProjectPrivacyMode(projectId);
  if (!requiresLocal(mode, purpose) || locality !== 'remote') return;
  logger.warn(
    {
      event: 'privacy_refusal',
      projectId: projectId ?? null,
      purpose,
      mode,
      target,
    },
    'privacy_refusal',
  );
  throw new PrivacyRefusal({ projectId, purpose, mode, target });
}

/**
 * Refuses an agent run on a runtime whose locality is remote (including a
 * remote capacity fallback) when the project's mode requires local execution
 * for this purpose. Locality is derived from the runtime, never accepted from
 * the caller; a missing runtime is treated as remote. Returns before any
 * locality work or logging when the mode does not require local.
 */
export function assertRuntimeAllowed(input: {
  projectId?: string;
  purpose: PrivacyPurpose;
  runtime?: ChatAgentOption;
}): void {
  const { projectId, purpose, runtime } = input;
  if (!requiresLocal(getProjectPrivacyMode(projectId), purpose)) return;
  assertEgressAllowed({
    projectId,
    purpose,
    locality: runtime ? getRuntimeLocality(runtime) : 'remote',
    target: runtime?.id ?? 'unresolved-runtime',
  });
}

/** URL origin + path for refusal logs; drops credentials and query strings. */
export function egressTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}
