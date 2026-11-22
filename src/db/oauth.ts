/**
 * Persistence for MCP OAuth 2.1 (dynamic clients, pending authorization
 * requests, single-use codes, grants and hashed access/refresh tokens).
 * Policy (validation, token minting, scope mapping) lives in `lib/oauth/`.
 */
import {
  and,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { drizzleDbRef } from './drizzle-client.js';
import {
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthGrants,
  oauthTokens,
  users,
  type OAuthGrantTargetEntry,
} from './schema.js';

const MAX_UNAPPROVED_OAUTH_CLIENTS = 100;
const MAX_PENDING_OAUTH_REQUESTS = 1000;
const UNAPPROVED_CLIENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthAuthorizationRequestRow =
  typeof oauthAuthorizationRequests.$inferSelect;
export type OAuthAuthorizationCodeRow =
  typeof oauthAuthorizationCodes.$inferSelect;
export type OAuthGrantRow = typeof oauthGrants.$inferSelect;
export type OAuthTokenInsert = typeof oauthTokens.$inferInsert;

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const db = () => drizzleDbRef.current;

// ── Clients ──────────────────────────────────────────────────────────────────

/** Insert a client; false when the unapproved-client cap is reached. */
export async function insertOAuthClient(
  row: typeof oauthClients.$inferInsert,
): Promise<boolean> {
  await db()
    .delete(oauthClients)
    .where(
      and(
        isNull(oauthClients.approved_at),
        lt(
          oauthClients.created_at,
          iso(Date.now() - UNAPPROVED_CLIENT_MAX_AGE_MS),
        ),
      ),
    );
  const [unapproved] = await db()
    .select({ total: count() })
    .from(oauthClients)
    .where(isNull(oauthClients.approved_at));
  if (unapproved.total >= MAX_UNAPPROVED_OAUTH_CLIENTS) return false;
  await db().insert(oauthClients).values(row);
  return true;
}

export async function getOAuthClient(
  id: string,
): Promise<OAuthClientRow | undefined> {
  return (
    await db().select().from(oauthClients).where(eq(oauthClients.id, id))
  )[0];
}

// ── Pending authorization requests ───────────────────────────────────────────

/** Insert a pending request; false when too many are outstanding. */
export async function insertOAuthAuthorizationRequest(
  row: typeof oauthAuthorizationRequests.$inferInsert,
): Promise<boolean> {
  await db()
    .delete(oauthAuthorizationRequests)
    .where(lt(oauthAuthorizationRequests.expires_at, iso()));
  const [pending] = await db()
    .select({ total: count() })
    .from(oauthAuthorizationRequests);
  if (pending.total >= MAX_PENDING_OAUTH_REQUESTS) return false;
  await db().insert(oauthAuthorizationRequests).values(row);
  return true;
}

export async function getOAuthAuthorizationRequest(
  id: string,
): Promise<OAuthAuthorizationRequestRow | undefined> {
  return (
    await db()
      .select()
      .from(oauthAuthorizationRequests)
      .where(
        and(
          eq(oauthAuthorizationRequests.id, id),
          gt(oauthAuthorizationRequests.expires_at, iso()),
        ),
      )
  )[0];
}

/** Atomically consume a pending request (a decision can be made only once). */
export async function takeOAuthAuthorizationRequest(
  id: string,
): Promise<OAuthAuthorizationRequestRow | undefined> {
  return (
    await db()
      .delete(oauthAuthorizationRequests)
      .where(
        and(
          eq(oauthAuthorizationRequests.id, id),
          gt(oauthAuthorizationRequests.expires_at, iso()),
        ),
      )
      .returning()
  )[0];
}

// ── Authorization codes ──────────────────────────────────────────────────────

export async function insertOAuthAuthorizationCode(
  row: typeof oauthAuthorizationCodes.$inferInsert,
): Promise<void> {
  await db()
    .delete(oauthAuthorizationCodes)
    .where(lt(oauthAuthorizationCodes.expires_at, iso()));
  await db().insert(oauthAuthorizationCodes).values(row);
}

/** Atomically consume a code; a second exchange of the same code finds nothing. */
export async function takeOAuthAuthorizationCode(
  codeHash: string,
): Promise<OAuthAuthorizationCodeRow | undefined> {
  return (
    await db()
      .delete(oauthAuthorizationCodes)
      .where(
        and(
          eq(oauthAuthorizationCodes.code_hash, codeHash),
          gt(oauthAuthorizationCodes.expires_at, iso()),
        ),
      )
      .returning()
  )[0];
}

// ── Grants and tokens ────────────────────────────────────────────────────────

/** Create a grant with its first tokens and mark the client as approved. */
export async function createOAuthGrant(
  grant: typeof oauthGrants.$inferInsert,
  tokens: OAuthTokenInsert[],
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.insert(oauthGrants).values(grant);
    await tx.insert(oauthTokens).values(tokens);
    await tx
      .update(oauthClients)
      .set({ approved_at: grant.created_at })
      .where(
        and(
          eq(oauthClients.id, grant.client_id),
          isNull(oauthClients.approved_at),
        ),
      );
  });
}

export type RefreshRotation =
  | { status: 'invalid' }
  | { status: 'reused'; grantId: string }
  | { status: 'ok'; grant: OAuthGrantRow };

/**
 * Rotate a refresh token. The old token is marked used in the same transaction
 * that inserts the replacements returned by `issue`. Presenting an already
 * rotated token revokes the whole grant.
 */
export async function rotateOAuthRefreshToken(
  tokenHash: string,
  clientId: string,
  issue: (grant: OAuthGrantRow) => OAuthTokenInsert[] | null,
): Promise<RefreshRotation> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthTokens.grant_id, oauthGrants.id))
      .where(
        and(
          eq(oauthTokens.token_hash, tokenHash),
          eq(oauthTokens.kind, 'refresh'),
        ),
      )
      .for('update');
    if (!row || row.grant.client_id !== clientId || row.grant.revoked_at) {
      return { status: 'invalid' };
    }
    const now = iso();
    if (row.token.used_at) {
      await tx
        .update(oauthGrants)
        .set({ revoked_at: now })
        .where(eq(oauthGrants.id, row.grant.id));
      await tx
        .delete(oauthTokens)
        .where(eq(oauthTokens.grant_id, row.grant.id));
      return { status: 'reused', grantId: row.grant.id };
    }
    if (row.token.expires_at <= now || row.grant.expires_at <= now) {
      return { status: 'invalid' };
    }
    const fresh = issue(row.grant);
    if (!fresh) return { status: 'invalid' };
    await tx
      .update(oauthTokens)
      .set({ used_at: now })
      .where(eq(oauthTokens.id, row.token.id));
    await tx.insert(oauthTokens).values(fresh);
    // Bound table growth: drop dead access tokens and used refresh rows once
    // they expire. A used refresh row must outlive its use, or replaying it
    // would look like an unknown token and skip the reuse revocation; it is
    // kept until its own expiry (the grant lifetime). The cost is one row per
    // rotation for the life of the grant, removed when the grant expires or is
    // revoked.
    await tx
      .delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.grant_id, row.grant.id),
          or(
            and(
              eq(oauthTokens.kind, 'access'),
              lt(oauthTokens.expires_at, now),
            ),
            and(
              eq(oauthTokens.kind, 'refresh'),
              isNotNull(oauthTokens.used_at),
              lt(oauthTokens.expires_at, now),
            ),
          ),
        ),
      );
    return { status: 'ok', grant: row.grant };
  });
}

/** Refresh token with its grant and owner (used or not; rotation decides). */
export async function findOAuthRefreshToken(
  tokenHash: string,
): Promise<OAuthAccessLookup | undefined> {
  return (
    await db()
      .select({ grant: oauthGrants, user: users })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthTokens.grant_id, oauthGrants.id))
      .innerJoin(users, eq(oauthGrants.user_id, users.id))
      .where(
        and(
          eq(oauthTokens.token_hash, tokenHash),
          eq(oauthTokens.kind, 'refresh'),
        ),
      )
  )[0];
}

export interface OAuthAccessLookup {
  grant: OAuthGrantRow;
  user: typeof users.$inferSelect;
}

/** Live (unexpired, unrevoked) access token joined with its grant and owner. */
export async function findOAuthAccessToken(
  tokenHash: string,
): Promise<OAuthAccessLookup | undefined> {
  const now = iso();
  return (
    await db()
      .select({ grant: oauthGrants, user: users })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthTokens.grant_id, oauthGrants.id))
      .innerJoin(users, eq(oauthGrants.user_id, users.id))
      .where(
        and(
          eq(oauthTokens.token_hash, tokenHash),
          eq(oauthTokens.kind, 'access'),
          gt(oauthTokens.expires_at, now),
          gt(oauthGrants.expires_at, now),
          isNull(oauthGrants.revoked_at),
        ),
      )
  )[0];
}

export async function touchOAuthGrant(id: string): Promise<void> {
  await db()
    .update(oauthGrants)
    .set({ last_used_at: iso() })
    .where(eq(oauthGrants.id, id));
}

export async function findOAuthTokenForRevocation(tokenHash: string) {
  return (
    await db()
      .select({ token: oauthTokens, clientId: oauthGrants.client_id })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthTokens.grant_id, oauthGrants.id))
      .where(eq(oauthTokens.token_hash, tokenHash))
  )[0];
}

export async function deleteOAuthToken(id: string): Promise<void> {
  await db().delete(oauthTokens).where(eq(oauthTokens.id, id));
}

/** Revoke a grant and drop its tokens. `userId` restricts it to the owner. */
export async function revokeOAuthGrant(
  id: string,
  userId?: string,
): Promise<OAuthGrantRow | undefined> {
  return db().transaction(async (tx) => {
    const [grant] = await tx
      .update(oauthGrants)
      .set({ revoked_at: iso() })
      .where(
        and(
          eq(oauthGrants.id, id),
          isNull(oauthGrants.revoked_at),
          userId ? eq(oauthGrants.user_id, userId) : undefined,
        ),
      )
      .returning();
    if (!grant) return undefined;
    await tx.delete(oauthTokens).where(eq(oauthTokens.grant_id, id));
    return grant;
  });
}

export async function listOAuthGrantsForUser(userId: string) {
  return db()
    .select({ grant: oauthGrants, clientName: oauthClients.client_name })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthGrants.client_id, oauthClients.id))
    .where(
      and(
        eq(oauthGrants.user_id, userId),
        isNull(oauthGrants.revoked_at),
        gt(oauthGrants.expires_at, iso()),
      ),
    )
    .orderBy(desc(oauthGrants.created_at));
}

/** A grant that is neither revoked nor expired, whoever owns it. */
export async function getLiveOAuthGrant(
  id: string,
): Promise<OAuthGrantRow | undefined> {
  return (
    await db()
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.id, id),
          isNull(oauthGrants.revoked_at),
          gt(oauthGrants.expires_at, iso()),
        ),
      )
  )[0];
}

/**
 * Replace a live grant's project list and, when `expiresAt` is given, its
 * expiry. Existing tokens never outlive the grant: access tokens are capped at
 * the new expiry and refresh tokens follow it (a refresh token always expires
 * with its grant). `userId` restricts the change to the owner.
 */
export async function updateOAuthGrant(
  id: string,
  userId: string,
  change: { targets: OAuthGrantTargetEntry[]; expiresAt?: string },
): Promise<OAuthGrantRow | undefined> {
  return db().transaction(async (tx) => {
    const [grant] = await tx
      .update(oauthGrants)
      .set({
        targets: change.targets,
        ...(change.expiresAt ? { expires_at: change.expiresAt } : {}),
      })
      .where(
        and(
          eq(oauthGrants.id, id),
          eq(oauthGrants.user_id, userId),
          isNull(oauthGrants.revoked_at),
          gt(oauthGrants.expires_at, iso()),
        ),
      )
      .returning();
    if (!grant) return undefined;
    await tx
      .update(oauthTokens)
      .set({
        expires_at: sql`case when ${oauthTokens.kind} = 'refresh' then ${grant.expires_at} else least(${oauthTokens.expires_at}, ${grant.expires_at}) end`,
      })
      .where(eq(oauthTokens.grant_id, id));
    return grant;
  });
}
