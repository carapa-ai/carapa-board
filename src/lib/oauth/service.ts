/**
 * MCP OAuth 2.1 policy: secrets, PKCE, redirect-URI rules, and the mapping from
 * a grant (projects + read/write each) to the MCP `TokenScope` it confers.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../hash.js';
import {
  findOAuthAccessToken,
  touchOAuthGrant,
  type OAuthGrantRow,
} from '../../db/oauth.js';
import type { OAuthGrantTargetEntry } from '../../db/schema.js';
import { logger } from '../../logger.js';
import {
  getAgentPermissionsResolved,
  resolveMainReachableFolders,
  toReadOnlyPermissions,
} from '../../mcp/auth.js';
import type { TokenScope } from '../../mcp/auth-tokens.js';
import { getProjectAccess } from '../../modules/knowledge/db-kb.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import { adminBypassesProject } from '../project-ownership.js';
import { originOfResource } from './origins.js';

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const AUTH_CODE_TTL_MS = 60_000;
export const AUTH_REQUEST_TTL_MS = 10 * 60_000;
export const SCOPES_SUPPORTED = ['mcp:read', 'mcp:write'];

const ACCESS_PREFIX = 'cmo_';
const REFRESH_PREFIX = 'cmr_';
const ACCESS_SHAPE = /^cmo_[A-Za-z0-9_-]{43}$/;

export const hashSecret = (secret: string) => sha256Hex(secret);
const randomSecret = (prefix = '') =>
  prefix + randomBytes(32).toString('base64url');
export const newAccessToken = () => randomSecret(ACCESS_PREFIX);
export const newRefreshToken = () => randomSecret(REFRESH_PREFIX);
export const newAuthorizationCode = () => randomSecret();
export const newClientId = () => `cmcl_${randomBytes(16).toString('hex')}`;
export const newRequestId = () => randomBytes(24).toString('base64url');

export const isOAuthAccessTokenShape = (token: string) =>
  ACCESS_SHAPE.test(token);

export function scopeString(access: string): string {
  return access === 'write' ? 'mcp:read mcp:write' : 'mcp:read';
}

// ── PKCE (RFC 7636, S256 only) ───────────────────────────────────────────────

const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

export const isValidCodeChallenge = (value: string) =>
  CHALLENGE_SHAPE.test(value);

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_SHAPE.test(verifier)) return false;
  const computed = Buffer.from(
    createHash('sha256').update(verifier).digest('base64url'),
  );
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}

// ── Redirect URIs (RFC 8252 loopback or https only) ──────────────────────────

export function isValidRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  );
}

// ── Scope mapping ────────────────────────────────────────────────────────────

export function mainFolderFor(username: string): string {
  return `main-${username.toLowerCase()}`;
}

export type GrantTarget =
  | { kind: 'main'; folder: string }
  | { kind: 'project'; folder: string };

/**
 * Whether `user` may currently grant `access` on `target`. Used both when
 * approving and on every token use, so losing project access or being demoted
 * to viewer ends the token's effect immediately.
 */
export async function userMayGrant(
  user: { id: string; username: string; role: string },
  target: GrantTarget,
  access: 'read' | 'write',
): Promise<boolean> {
  const group = getGroupByFolder(target.folder);
  if (!group) return false;
  if (target.kind === 'main') {
    return (
      target.folder === mainFolderFor(user.username) &&
      !!group.is_main &&
      group.user_id === user.id
    );
  }
  if (group.is_main) return false;
  const projectAccess = await getProjectAccess(user.id, target.folder);
  if (projectAccess?.kind === 'explicit') {
    return access === 'read' || projectAccess.level !== 'viewer';
  }
  // Implicit chat-only access never qualifies; admin bypass respects ownership.
  return adminBypassesProject(user, target.folder);
}

export type { OAuthGrantTargetEntry };

type OAuthUser = { id: string; username: string; role: string };

/** Folder an entry resolves to; a `main` entry always follows the owner's main. */
export const entryFolder = (
  entry: OAuthGrantTargetEntry,
  user: { username: string },
): string =>
  entry.kind === 'main' ? mainFolderFor(user.username) : entry.folder;

/** `write` when any entry can write; `read` never changes data. */
export const grantAccessLevel = (
  entries: ReadonlyArray<Pick<OAuthGrantTargetEntry, 'access'>>,
): 'read' | 'write' =>
  entries.some((entry) => entry.access === 'write') ? 'write' : 'read';

/**
 * Entries the user may still grant, re-checked per folder with
 * {@link userMayGrant}: a folder the user can no longer reach (or that no
 * longer exists) is dropped, and `write` narrows to `read` when the user has
 * become a viewer. Fails closed to an empty list.
 */
export async function effectiveGrantEntries(
  entries: readonly OAuthGrantTargetEntry[],
  user: OAuthUser,
): Promise<OAuthGrantTargetEntry[]> {
  const checked = await Promise.all(
    entries.map(async (entry): Promise<OAuthGrantTargetEntry | null> => {
      const target: GrantTarget = {
        kind: entry.kind,
        folder: entryFolder(entry, user),
      };
      if (
        entry.access === 'write' &&
        (await userMayGrant(user, target, 'write'))
      ) {
        return entry;
      }
      return (await userMayGrant(user, target, 'read'))
        ? { ...entry, access: 'read' }
        : null;
    }),
  );
  return checked.filter((entry): entry is OAuthGrantTargetEntry => !!entry);
}

export interface GrantableTarget {
  kind: 'main' | 'project';
  folder: string;
  name: string;
  /** Parent project folder, for rendering the project tree. */
  parentId?: string;
  isParent: boolean;
  order?: number;
  /** False when the user only has viewer access. */
  canWrite: boolean;
}

/**
 * Everything `user` may currently put in a grant: their main plus every
 * project `userMayGrant` allows, with whether write is available.
 */
export async function listGrantableTargets(
  user: OAuthUser,
): Promise<GrantableTarget[]> {
  const targets: GrantableTarget[] = [];
  const mainFolder = mainFolderFor(user.username);
  const main = getGroupByFolder(mainFolder);
  if (main?.user_id === user.id) {
    targets.push({
      kind: 'main',
      folder: mainFolder,
      name: main.name,
      isParent: false,
      canWrite: true,
    });
  }
  const candidates = new Set(
    user.role === 'admin'
      ? Object.values(registeredGroups).map((group) => group.folder)
      : (await resolveMainReachableFolders(user.id, registeredGroups)).map(
          ({ folder }) => folder,
        ),
  );
  const projects = await Promise.all(
    [...candidates].map(async (folder): Promise<GrantableTarget | null> => {
      const group = getGroupByFolder(folder);
      if (!group || group.is_main) return null;
      const target: GrantTarget = { kind: 'project', folder };
      const canWrite = await userMayGrant(user, target, 'write');
      if (!canWrite && !(await userMayGrant(user, target, 'read'))) return null;
      return {
        kind: 'project',
        folder,
        name: group.name,
        ...(group.parentId && { parentId: group.parentId }),
        isParent: group.settings?.isParent === true,
        ...(group.order !== undefined && { order: group.order }),
        canWrite,
      };
    }),
  );
  return [...targets, ...projects.filter((t): t is GrantableTarget => !!t)];
}

/** MCP scope a grant confers; never wildcard admin. */
export async function buildOAuthTokenScope(
  grant: Pick<OAuthGrantRow, 'targets'>,
  user: OAuthUser,
): Promise<TokenScope | null> {
  const entries = await effectiveGrantEntries(grant.targets, user);
  if (entries.length === 0) return null;
  const permissions: Record<string, string[]> = {};
  const permissionsFor = async (entry: OAuthGrantTargetEntry) => {
    const resolved = await getAgentPermissionsResolved(
      getGroupByFolder(entryFolder(entry, user))!,
      registeredGroups,
    );
    return Object.entries(resolved).map(
      ([folder, perms]) =>
        [
          folder,
          entry.access === 'read' ? toReadOnlyPermissions(perms) : perms,
        ] as const,
    );
  };
  // The main entry covers the main workspace plus every project it reaches.
  for (const entry of entries.filter((e) => e.kind === 'main')) {
    for (const [folder, perms] of await permissionsFor(entry)) {
      permissions[folder] = perms;
    }
  }
  // A listed project covers exactly its own folder (never memory-source
  // entries) and its own access replaces whatever the main entry reached, so
  // a read-only listing restricts a read/write main.
  for (const entry of entries.filter((e) => e.kind === 'project')) {
    const perms = (await permissionsFor(entry)).find(
      ([folder]) => folder === entry.folder,
    );
    permissions[entry.folder] = perms?.[1] ?? [];
  }
  return {
    // Primary (home) folder: the first selected entry that still applies.
    group_folder: entryFolder(entries[0], user),
    permissions,
    kind: 'oauth',
    oauth_access: grantAccessLevel(entries),
    oauth_user_id: user.id,
    oauth_user_is_admin: user.role === 'admin',
  };
}

// ── Access-token resolution (auth middleware) ────────────────────────────────

export interface ResolvedOAuthAccess {
  scope: TokenScope;
  /** Origin the token is bound to (from its RFC 8707 resource). */
  resourceOrigin: string;
}

const LAST_USED_THROTTLE_MS = 60_000;
const lastTouched = new Map<string, number>();

export async function resolveOAuthAccessToken(
  token: string,
): Promise<ResolvedOAuthAccess | null> {
  if (!isOAuthAccessTokenShape(token)) return null;
  const found = await findOAuthAccessToken(hashSecret(token));
  if (!found || found.user.disabled) return null;
  const resourceOrigin = originOfResource(found.grant.resource);
  if (!resourceOrigin) return null;
  const scope = await buildOAuthTokenScope(found.grant, found.user);
  if (!scope) return null;

  const now = Date.now();
  if (now - (lastTouched.get(found.grant.id) ?? 0) > LAST_USED_THROTTLE_MS) {
    lastTouched.set(found.grant.id, now);
    touchOAuthGrant(found.grant.id).catch((err: unknown) => {
      logger.warn(
        { err: String(err) },
        'Failed to update OAuth grant last_used_at',
      );
    });
  }
  return { scope, resourceOrigin };
}
