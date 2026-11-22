import crypto from 'node:crypto';
import { eq, lt, inArray } from 'drizzle-orm';
import { logger } from '../logger.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { agentTokens } from '../db/schema.js';
import { isResolvedBeforeChange } from '../lib/project-changes.js';

type TokenKind = 'agent' | 'user' | 'oauth';

export interface TokenScope {
  group_folder: string;
  task_id?: string;
  conversation_id?: string;
  run_id?: string;
  permissions?: Record<string, string[]>;
  kind?: TokenKind;
  /** Granted access level of an OAuth scope; `read` must never change data. */
  oauth_access?: 'read' | 'write';
  /** Human user behind an OAuth scope; set only by `buildOAuthTokenScope`. */
  oauth_user_id?: string;
  oauth_user_is_admin?: boolean;
}

interface TokenEntry {
  token: string;
  scope: TokenScope;
  expiresAt?: number;
}

declare global {
  namespace Express {
    interface Request {
      tokenScope?: TokenScope;
    }
  }
}

// In-memory registry for ephemeral agent tokens. Backed by the `agent_tokens`
// table so tokens survive a board restart — without this, a running sandbox
// gets 401s the moment carapa-board comes back up, since its on-host token is
// no longer recognized by a fresh in-memory map.
const tokenRegistry = new Map<string, TokenEntry>();

// Last time a token was minted for a group_folder. Used by the liveness sweep
// to skip groups whose sandbox is still booting (a freshly-minted token must
// not be revoked just because sandboxStatus hasn't reported "running" yet).
// In-memory only — intentionally not persisted: it only needs to bridge the
// mint→running window, which never spans a board restart.
const lastMintByGroup = new Map<string, number>();

// Listeners told synchronously when a token is registered, before its row is
// written. `stale` is true when the token's permissions were resolved before a
// project change that has since been emitted. A listener may return a promise;
// `generateAgentToken` waits for it before handing the token out, so a stale
// token is reconciled (the per-user main re-scope) before anyone can use it.
const mintListeners = new Set<
  (group_folder: string, stale: boolean) => void | Promise<void>
>();

export function onTokenMinted(
  listener: (group_folder: string, stale: boolean) => void | Promise<void>,
): void {
  mintListeners.add(listener);
}

// Row writes per token, run strictly in order. Each write serializes the
// registry scope at the moment it runs, so an older write can never land after
// (and overwrite) a newer one. The first link is the token's own insert.
const writeChains = new Map<string, Promise<void>>();

function chainWrite(token: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(token) ?? Promise.resolve();
  // A failed earlier write (e.g. the insert) must not block or fail this one.
  const next = prev.catch(() => {}).then(write);
  writeChains.set(token, next);
  const settled = () => {
    if (writeChains.get(token) === next) writeChains.delete(token);
  };
  next.then(settled, settled);
  return next;
}

/**
 * Resolves once every write already queued for `tokens` has finished. Call it
 * right after dropping the tokens from the registry: nothing queues new scope
 * writes for a token that is gone, so a delete issued afterwards cannot be
 * overtaken by a pending insert or update (which would resurrect the row).
 */
async function settleWrites(tokens: Iterable<string>): Promise<void> {
  await Promise.all(
    [...tokens].map((token) => writeChains.get(token)?.catch(() => {})),
  );
}

// Tokens whose registry scope may be ahead of their `agent_tokens` row (a
// failed UPDATE). Retried on every re-scope of their folder; after a restart
// the startup re-scope recomputes the scope of every per-user main token.
const unpersisted = new Set<string>();

/**
 * Load non-expired tokens from the database into the in-memory registry.
 * Call once at boot, after initDatabase().
 */
export async function hydrateTokenRegistry(): Promise<void> {
  const db = drizzleDbRef.current;
  if (!db) {
    logger.warn('hydrateTokenRegistry: DB not initialized, skipping');
    return;
  }

  const now = Date.now();
  // Drop expired rows first so we don't carry junk into memory or the table.
  await db.delete(agentTokens).where(lt(agentTokens.expires_at, now));

  const rows = await db.select().from(agentTokens);
  let loaded = 0;
  for (const row of rows) {
    let scope: TokenScope;
    try {
      scope = JSON.parse(row.scope);
    } catch (err) {
      logger.warn(
        { err: String(err), token: row.token.substring(0, 8) + '...' },
        'Skipping agent token with unparseable scope',
      );
      continue;
    }
    tokenRegistry.set(row.token, {
      token: row.token,
      scope,
      expiresAt: row.expires_at ?? undefined,
    });
    loaded++;
  }
  logger.info({ loaded }, 'Hydrated agent token registry from DB');
}

/**
 * Generate a new scoped bearer token for an agent.
 * Default expiry: 24 hours. Pass ttlMs = null for a no-expiry token whose
 * validity is bound to the sandbox lifecycle (revoked via revokeGroupTokens
 * on stop/restart and by the liveness sweep) rather than a fixed clock.
 */
export async function generateAgentToken(
  scope: TokenScope,
  ttlMs: number | null = 24 * 60 * 60 * 1000,
  beforePersist?: (token: string) => Promise<void>,
): Promise<string> {
  const token = `cat_${crypto.randomBytes(32).toString('hex')}`;
  // Establish durable ownership before the credential can be persisted.
  if (beforePersist) await beforePersist(token);
  const expiresAt = ttlMs === null ? undefined : Date.now() + ttlMs;
  const createdAt = new Date().toISOString();

  tokenRegistry.set(token, {
    token,
    scope,
    expiresAt,
  });
  const stale = isResolvedBeforeChange(scope.permissions);
  const reconciling = [...mintListeners].map((listener) =>
    listener(scope.group_folder, stale),
  );

  const db = drizzleDbRef.current;
  if (db) {
    // Later scope writes for this token queue behind its insert.
    const insert = chainWrite(token, async () => {
      // Revoked before the insert ran: there is nothing to persist.
      if (!tokenRegistry.has(token)) return;
      await db.insert(agentTokens).values({
        token,
        scope: JSON.stringify(scope),
        expires_at: expiresAt ?? null,
        created_at: createdAt,
      });
    });
    try {
      await insert;
    } catch (err) {
      // If persistence fails, drop the in-memory entry so we don't hand out a
      // token that can't survive a restart — caller can retry.
      tokenRegistry.delete(token);
      throw err;
    }
    // A token resolved before a project change is rewritten by the re-scope
    // its mint started; it is not handed out until that has finished.
    await Promise.all(reconciling);
    // Revoked while it was being persisted: its row is deleted behind the
    // insert, so never hand the token out.
    if (!tokenRegistry.has(token)) {
      throw new Error('Agent token was revoked before it was issued');
    }
  }

  lastMintByGroup.set(scope.group_folder, Date.now());
  logger.debug(
    {
      group_folder: scope.group_folder,
      task_id: scope.task_id,
      permissions: scope.permissions,
    },
    'Generated scoped agent token',
  );
  return token;
}

/** Verify an agent token and return its scope. */
export function verifyToken(token: string): TokenScope | null {
  const entry = tokenRegistry.get(token);
  if (!entry) return null;

  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    tokenRegistry.delete(token);
    // Fire-and-forget DB cleanup — verifyToken stays sync for hot-path callers.
    const db = drizzleDbRef.current;
    if (db) {
      db.delete(agentTokens)
        .where(inArray(agentTokens.token, [token]))
        .catch((err: unknown) => {
          logger.warn(
            { err: String(err) },
            'Failed to delete expired token from DB',
          );
        });
    }
    logger.warn(
      { token: token.substring(0, 8) + '...' },
      'Agent token expired',
    );
    return null;
  }

  return { ...entry.scope, kind: entry.scope.kind ?? 'agent' };
}

/**
 * Revoke all agent tokens scoped to a group, from memory and DB. Called when a
 * sandbox is stopped/restarted, before re-minting on start, and by the liveness
 * sweep for groups whose sandbox is no longer running. This is what binds a
 * no-expiry (ttlMs=null) token's validity to the sandbox's lifecycle.
 *
 * Pass `opts.exceptToken` to rotate tokens without a gap: mint + push the new
 * token first, then revoke every prior token for the group except the one just
 * adopted, so the sandbox's api-relay is never momentarily left without a valid
 * token.
 *
 * Pass `opts.sandboxLevelOnly` to leave run-scoped tokens (carrying a `run_id`,
 * `task_id` or `conversation_id`) alone. Use it when the sandbox keeps running,
 * so agents still in flight keep their MCP access.
 */
export async function revokeGroupTokens(
  group_folder: string,
  opts?: { exceptToken?: string; sandboxLevelOnly?: boolean },
): Promise<number> {
  const keep = opts?.exceptToken;
  const toDelete: string[] = [];
  for (const [token, entry] of tokenRegistry.entries()) {
    const { run_id, task_id, conversation_id } = entry.scope;
    const runScoped = !!(run_id || task_id || conversation_id);
    if (opts?.sandboxLevelOnly && runScoped) continue;
    if (entry.scope.group_folder === group_folder && token !== keep) {
      tokenRegistry.delete(token);
      toDelete.push(token);
    }
  }
  const db = drizzleDbRef.current;
  if (db && toDelete.length > 0) {
    try {
      await settleWrites(toDelete);
      await db.delete(agentTokens).where(inArray(agentTokens.token, toDelete));
    } catch (err) {
      logger.warn(
        { err: String(err), group_folder },
        'Failed to delete revoked tokens from DB',
      );
    }
  }
  if (toDelete.length > 0) {
    logger.info(
      { group_folder, count: toDelete.length },
      'Revoked agent tokens for group',
    );
  }
  return toDelete.length;
}

/**
 * Revoke every token, whichever group owns it, whose permissions name `folder`.
 * Used when a folder is retired: a token minted while another project could
 * reach it must not keep that reach once the folder identifies someone else.
 * The database scope is authoritative, so persisted rows are scanned too.
 */
export async function revokeTokensGrantingFolder(
  folder: string,
): Promise<number> {
  const grants = (scope: TokenScope) =>
    Object.prototype.hasOwnProperty.call(scope.permissions ?? {}, folder);
  const toDelete = new Set<string>();
  for (const [token, entry] of tokenRegistry.entries()) {
    if (grants(entry.scope)) {
      tokenRegistry.delete(token);
      toDelete.add(token);
    }
  }
  const db = drizzleDbRef.current;
  if (db) {
    // A re-scope may have narrowed a token in memory while its row still holds
    // the old scope. Let every pending write land first so the persisted scan
    // sees the same grants as the registry scan, then revoke whatever the
    // persisted scope still grants from memory as well: registry and database
    // must never disagree about which tokens survive.
    await settleWrites(writeChains.keys());
    const persisted = await db
      .select({ token: agentTokens.token, scope: agentTokens.scope })
      .from(agentTokens);
    for (const row of persisted) {
      try {
        if (grants(JSON.parse(row.scope) as TokenScope)) {
          tokenRegistry.delete(row.token);
          toDelete.add(row.token);
        }
      } catch {
        // hydrateTokenRegistry owns diagnostics for malformed unrelated rows.
      }
    }
    if (toDelete.size > 0) {
      await db
        .delete(agentTokens)
        .where(inArray(agentTokens.token, [...toDelete]));
    }
  }
  if (toDelete.size > 0) {
    logger.info(
      { folder, count: toDelete.size },
      'Revoked tokens granting access to a retired folder',
    );
  }
  return toDelete.size;
}

const isAgentKind = (scope: TokenScope) => (scope.kind ?? 'agent') === 'agent';

/** True when the registry holds an agent-kind token for `group_folder`. */
export function hasAgentTokensForGroup(group_folder: string): boolean {
  for (const entry of tokenRegistry.values()) {
    if (entry.scope.group_folder === group_folder && isAgentKind(entry.scope))
      return true;
  }
  return false;
}

/** Same folders with the same permission sets, ignoring order. */
const sameGrants = (
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean => {
  const folders = Object.keys(a);
  if (folders.length !== Object.keys(b).length) return false;
  return folders.every((folder) => {
    const other = b[folder];
    if (!other) return false;
    const mine = new Set(a[folder]);
    return mine.size === new Set(other).size && other.every((p) => mine.has(p));
  });
};

/** Write each token's current registry scope to its existing row. */
async function persistScopes(tokens: Iterable<string>): Promise<void> {
  const db = drizzleDbRef.current;
  if (!db) return;
  await Promise.all(
    [...tokens].map((token) =>
      chainWrite(token, async () => {
        const entry = tokenRegistry.get(token);
        if (!entry) {
          unpersisted.delete(token);
          return;
        }
        try {
          const rows = await db
            .update(agentTokens)
            .set({ scope: JSON.stringify(entry.scope) })
            .where(eq(agentTokens.token, token))
            .returning();
          // No row: revoked meanwhile (nothing to persist) or not yet written.
          if (rows.length > 0 || !tokenRegistry.has(token))
            unpersisted.delete(token);
          else unpersisted.add(token);
        } catch (err) {
          unpersisted.add(token);
          logger.warn(
            { err: String(err), group_folder: entry.scope.group_folder },
            'Failed to persist re-scoped agent token to DB; will retry',
          );
        }
      }),
    ),
  );
}

/**
 * Replace only `permissions` on every agent-kind token (sandbox-level and run
 * tokens alike) scoped to `group_folder`, in memory and in `agent_tokens`.
 * Everything else in the scope and the expiry are preserved; user and OAuth
 * tokens and other folders are never touched. Tokens whose permissions already
 * match are skipped, except that a write that previously failed is retried.
 * `permissions` is shared by reference (not copied) so the folder-identity
 * grant tracking on it still applies.
 *
 * The registry is read synchronously, so a token revoked earlier is not
 * rewritten. The database write is an UPDATE keyed on the token (never an
 * insert), so a token revoked while the write is in flight is not resurrected.
 * Returns the number of tokens rewritten and the group's folder count before.
 */
export async function setAgentTokenPermissions(
  group_folder: string,
  permissions: Record<string, string[]>,
): Promise<{ rewritten: number; foldersBefore: number }> {
  const toPersist = new Set<string>();
  let rewritten = 0;
  let foldersBefore = 0;
  for (const [token, entry] of tokenRegistry.entries()) {
    const { scope } = entry;
    if (scope.group_folder !== group_folder || !isAgentKind(scope)) continue;
    const current = scope.permissions ?? {};
    foldersBefore = Math.max(foldersBefore, Object.keys(current).length);
    if (!sameGrants(current, permissions)) {
      entry.scope = { ...scope, permissions };
      rewritten++;
      toPersist.add(token);
    } else if (unpersisted.has(token)) {
      toPersist.add(token);
    }
  }
  await persistScopes(toPersist);
  return { rewritten, foldersBefore };
}

/**
 * Revoke a single agent token by its plaintext value. Used by the
 * on-demand shell teardown path (`/api/projects/:projectId/shells`) to
 * invalidate exactly the token
 * that was minted for the on-demand sandbox, without touching any
 * other token in the same group — including the running chat
 * agent's token. Calling `revokeGroupTokens` here would 401 the
 * agent the moment it next calls the board.
 *
 * Returns the number of tokens actually revoked (0 or 1).
 */
export async function revokeAgentToken(
  token: string,
  options: { requirePersistence?: boolean } = {},
): Promise<number> {
  const removed = tokenRegistry.delete(token) ? 1 : 0;
  const db = drizzleDbRef.current;
  if (db) {
    try {
      await settleWrites([token]);
      await db.delete(agentTokens).where(eq(agentTokens.token, token));
    } catch (err) {
      logger.warn(
        { err: String(err), token: token.substring(0, 8) + '...' },
        'Failed to delete single agent token from DB',
      );
      if (options.requirePersistence) throw err;
    }
  }
  if (removed > 0) {
    logger.debug(
      { token: token.substring(0, 8) + '...' },
      'Revoked single agent token',
    );
  }
  return removed;
}

/**
 * True if a token was minted for this group within `withinMs`. The liveness
 * sweep uses this to avoid revoking a just-minted token while its sandbox is
 * still booting (sandboxStatus not yet "running"). Returns false after a board
 * restart (the map is in-memory) — correct, since there is no mint in flight
 * across a restart and a genuinely-dead sandbox should still be swept.
 */
export function wasRecentlyMinted(
  group_folder: string,
  withinMs: number,
): boolean {
  const t = lastMintByGroup.get(group_folder);
  return t !== undefined && Date.now() - t < withinMs;
}
