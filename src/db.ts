import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import {
  createDrizzleClient,
  drizzleDbRef,
  instrumentPglite,
} from './db/drizzle-client.js';
import {
  getTemplateCachePath,
  readPgliteTemplateBlob,
  writePgliteTemplate,
} from './db/pglite-template.js';
import { PGlite } from '@electric-sql/pglite';
import {
  drizzle as pgliteDrizzle,
  type PgliteDatabase,
} from 'drizzle-orm/pglite';
import { migrate as pgliteMigrate } from 'drizzle-orm/pglite/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as nodePgMigrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './db/schema.js';
import { MAX_PAYLOAD_TTL_MS } from './modules/push/payload-constants.js';
import {
  eq,
  and,
  or,
  lt,
  gt,
  inArray,
  isNull,
  desc,
  asc,
  count,
  ne,
  like,
  notLike,
  type SQL,
} from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { setMemberPreferenceColumn } from './modules/knowledge/db-kb.js';
import {
  isAttentionStage,
  lifecycleAttentionSource,
  type AttentionEvent,
} from './modules/kanban/db-kanban.js';
import { getGroupStages } from './modules/kanban/stages.js';
import { registeredGroups } from './state-manager.js';
import type { RegisteredGroup } from './types.js';

let isPostgres = false;
let pgliteLocation: string | undefined;

export function isUsingPostgres(): boolean {
  return isPostgres;
}

/** On-disk path (or `:memory:`) of the PGlite database; undefined on Postgres. */
export function getPgliteLocation(): string | undefined {
  return pgliteLocation;
}

function getDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const user = process.env.DB_USER || process.env.POSTGRES_USER || 'carapa';
  const host = process.env.DB_HOST || process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.DB_PORT || process.env.POSTGRES_PORT || '5432';
  const dbName = process.env.DB_NAME || process.env.POSTGRES_DB || 'carapa';

  const secretsDir = process.env.SECRETS_DIR || '/run/secrets';
  const passwordFile =
    process.env.POSTGRES_PASSWORD_FILE ||
    path.join(secretsDir, 'postgres_password');
  let password = process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || '';
  if (!password && fs.existsSync(passwordFile)) {
    try {
      password = fs.readFileSync(passwordFile, 'utf8').trim();
    } catch {
      /* ignore */
    }
  }

  if (password) {
    return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
  }
  return undefined;
}

function isPostgresDsn(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}

import { sql } from 'drizzle-orm';

const MIGRATIONS_FOLDER = path.join(process.cwd(), 'drizzle');

export async function initDatabase(customPath?: string): Promise<void> {
  const requestedMemory = customPath === ':memory:';
  let dsnOrPath =
    getDatabaseUrl() ||
    customPath ||
    'postgresql://carapa@localhost:5432/carapa';
  if (requestedMemory) {
    if ((globalThis as any).__testDb) {
      drizzleDbRef.current = (globalThis as any).__testDb;
      return;
    }
    dsnOrPath = ':memory:';
  } else {
    isPostgres = isPostgresDsn(dsnOrPath);
  }

  if (isPostgresDsn(dsnOrPath)) {
    // Narrow to the node-pg branch: createDrizzleClient returns the union, but
    // the postgres-DSN branch above is verified at runtime.
    const db = createDrizzleClient(dsnOrPath) as NodePgDatabase<typeof schema>;
    drizzleDbRef.current = db;
    await nodePgMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return;
  }

  // PGlite path (single-process; on-disk file or in-memory).
  const templatePath = requestedMemory
    ? getTemplateCachePath(MIGRATIONS_FOLDER)
    : null;
  if (requestedMemory && templatePath) {
    const cachedDb = await tryInitMemoryDbFromTemplate(templatePath);
    if (cachedDb) {
      (globalThis as any).__testDb = cachedDb;
      return;
    }
  }

  pgliteLocation = dsnOrPath;
  const pg = new PGlite(dsnOrPath === ':memory:' ? undefined : dsnOrPath);
  await pg.waitReady;
  instrumentPglite(pg);
  const db: PgliteDatabase<typeof schema> = pgliteDrizzle(pg, { schema });
  drizzleDbRef.current = db;
  await pgliteMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  if (requestedMemory) {
    if (templatePath) {
      await writePgliteTemplate(pg, templatePath);
    }
    (globalThis as any).__testDb = drizzleDbRef.current;
  }
}

async function tryInitMemoryDbFromTemplate(
  templatePath: string,
): Promise<PgliteDatabase<typeof schema> | null> {
  const blob = readPgliteTemplateBlob(templatePath);
  if (!blob) return null;

  let pg: PGlite | undefined;
  try {
    pg = new PGlite({ loadDataDir: blob });
    await pg.waitReady;
    instrumentPglite(pg);
    const db: PgliteDatabase<typeof schema> = pgliteDrizzle(pg, { schema });
    await pgliteMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    drizzleDbRef.current = db;
    return db;
  } catch (err) {
    logger.debug(
      { err, templatePath },
      'Failed to load cached PGlite test template; falling back to fresh init',
    );
    await pg?.close().catch(() => {});
    return null;
  }
}

export * from './db/active-runs.js';
export * from './db/external-run-costs.js';
export * from './db/file-favorites.js';
export * from './db/task-stage-comments.js';
export * from './modules/knowledge/db-kb.js';
export * from './modules/chat/db-chats.js';
export * from './modules/chat/db-public-shares.js';
export * from './modules/objectives/db-objectives.js';
export * from './modules/chat/db-scheduling.js';
export * from './modules/memory/db-memories.js';
export * from './modules/kanban/db-kanban.js';
export * from './modules/ai-users/db-ai-users.js';

export type TtsAudioAssetRow = typeof schema.ttsAudioAssets.$inferSelect;

export async function getTtsAudioAsset(
  id: string,
): Promise<TtsAudioAssetRow | undefined> {
  return (
    await drizzleDbRef.current
      .select()
      .from(schema.ttsAudioAssets)
      .where(eq(schema.ttsAudioAssets.id, id))
      .limit(1)
  )[0];
}

export async function insertTtsAudioAsset(
  row: typeof schema.ttsAudioAssets.$inferInsert,
): Promise<void> {
  await drizzleDbRef.current
    .insert(schema.ttsAudioAssets)
    .values(row)
    .onConflictDoNothing();
}

export async function touchTtsAudioAsset(
  id: string,
  lastAccessedAt = new Date().toISOString(),
): Promise<void> {
  await drizzleDbRef.current
    .update(schema.ttsAudioAssets)
    .set({ lastAccessedAt })
    .where(eq(schema.ttsAudioAssets.id, id));
}

export async function linkMessageSpeechAsset(input: {
  conversationId: string;
  messageId: string;
  assetId: string;
  speakerId?: string | null;
}): Promise<void> {
  await drizzleDbRef.current
    .insert(schema.messageSpeechAssets)
    .values({
      ...input,
      speakerId: input.speakerId ?? null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        schema.messageSpeechAssets.conversationId,
        schema.messageSpeechAssets.messageId,
      ],
      set: { assetId: input.assetId, speakerId: input.speakerId ?? null },
    });
}

export async function getMessageSpeechAsset(
  conversationId: string,
  messageId: string,
): Promise<TtsAudioAssetRow | undefined> {
  const rows = await drizzleDbRef.current
    .select({ asset: schema.ttsAudioAssets })
    .from(schema.messageSpeechAssets)
    .innerJoin(
      schema.ttsAudioAssets,
      eq(schema.messageSpeechAssets.assetId, schema.ttsAudioAssets.id),
    )
    .where(
      and(
        eq(schema.messageSpeechAssets.conversationId, conversationId),
        eq(schema.messageSpeechAssets.messageId, messageId),
      ),
    )
    .limit(1);
  return rows[0]?.asset;
}

export async function listMessageSpeechAssets(conversationId: string): Promise<
  Array<{
    messageId: string;
    asset: TtsAudioAssetRow;
  }>
> {
  return drizzleDbRef.current
    .select({
      messageId: schema.messageSpeechAssets.messageId,
      asset: schema.ttsAudioAssets,
    })
    .from(schema.messageSpeechAssets)
    .innerJoin(
      schema.ttsAudioAssets,
      eq(schema.messageSpeechAssets.assetId, schema.ttsAudioAssets.id),
    )
    .where(eq(schema.messageSpeechAssets.conversationId, conversationId));
}

export async function listUnlinkedTtsAudioAssets(): Promise<
  TtsAudioAssetRow[]
> {
  const rows = await drizzleDbRef.current
    .select({ asset: schema.ttsAudioAssets })
    .from(schema.ttsAudioAssets)
    .leftJoin(
      schema.messageSpeechAssets,
      eq(schema.ttsAudioAssets.id, schema.messageSpeechAssets.assetId),
    )
    .where(isNull(schema.messageSpeechAssets.assetId))
    .orderBy(asc(schema.ttsAudioAssets.lastAccessedAt));
  return rows.map((row: { asset: TtsAudioAssetRow }) => row.asset);
}

export async function deleteTtsAudioAsset(id: string): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    // A manually removed/corrupt cache file invalidates every durable message
    // link to that immutable asset. Remove the links before the restrict-FK row
    // so the same content key can be synthesized and inserted again.
    await tx
      .delete(schema.messageSpeechAssets)
      .where(eq(schema.messageSpeechAssets.assetId, id));
    await tx
      .delete(schema.ttsAudioAssets)
      .where(eq(schema.ttsAudioAssets.id, id));
  });
}

// --- Retention / cleanup ---

const RETENTION_TASK_RUN_LOGS_DAYS = 30;
// Note: `chat_messages` has been retired. The JSONL transcript is the only
// chat store and is append-only with no retention sweep — transcript
// cleanup is intentionally out of scope here.

export async function cleanupOldRecords(): Promise<{
  taskRunLogs: number;
}> {
  const taskRunCutoff = new Date(
    Date.now() - RETENTION_TASK_RUN_LOGS_DAYS * 86400_000,
  ).toISOString();

  let taskRunLogsChanges = 0;

  // Both PGlite (`Results`) and node-pg (`QueryResult`) expose affected-row
  // counts but under different field names — and the inferred union has neither
  // on it directly. Normalize at the call boundary.
  const affectedRowCount = (result: unknown): number => {
    const r = result as
      | {
          rowCount?: number | null;
          affectedRows?: number | null;
          rows?: unknown[];
        }
      | null
      | undefined;
    return r?.rowCount ?? r?.affectedRows ?? r?.rows?.length ?? 0;
  };

  try {
    const r1 = await drizzleDbRef.current
      .delete(schema.taskRunLogs)
      .where(lt(schema.taskRunLogs.run_at, taskRunCutoff));
    taskRunLogsChanges = affectedRowCount(r1);
  } catch (err) {
    logger.error({ err }, 'Error deleting old records');
  }

  return {
    taskRunLogs: taskRunLogsChanges,
  };
}

// Device Keys

export type RegisterDeviceResult =
  | { kind: 'registered'; isApproved: boolean }
  | { kind: 'refreshed'; isApproved: boolean }
  | { kind: 'reassigned'; isApproved: boolean; previousUserId: string };

/**
 * Inserts or refreshes a device key for the user authenticating *right now*.
 *
 * Three outcomes:
 * - `registered`: brand-new device_id. Inserted as pending approval, unless
 *   `autoApprove` is set (used for the bootstrap admin's first device).
 * - `refreshed`: device_id already exists and is bound to the same user_id.
 *   The keypair and last_used_at are refreshed; `is_approved` is preserved.
 * - `reassigned`: device_id exists but is bound to a *different* user (shared
 *   household phone, or someone signed out and a different account is signing
 *   in). The previous binding is wiped and a fresh pending row is created —
 *   the new user can't actually do anything until an admin approves. The
 *   previous owner's sessions on this device are revoked automatically on
 *   their next request (the auth middleware's consolidated state lookup
 *   returns `null` for them now).
 */
export async function registerDeviceKey(
  device_id: string,
  user_id: string,
  public_key: string,
  label?: string | null,
  autoApprove: boolean = false,
): Promise<RegisterDeviceResult> {
  const now = new Date().toISOString();
  const trimmedLabel = label?.trim() || null;

  return drizzleDbRef.current.transaction(async (tx) => {
    const existing = await tx
      .select({
        user_id: schema.deviceKeys.user_id,
        is_approved: schema.deviceKeys.is_approved,
        kind: schema.deviceKeys.kind,
      })
      .from(schema.deviceKeys)
      .where(eq(schema.deviceKeys.device_id, device_id))
      .for('update');

    const newRow = {
      device_id,
      user_id,
      public_key,
      is_active: true,
      is_approved: autoApprove,
      approved_at: autoApprove ? now : null,
      approved_by: autoApprove ? user_id : null,
      label: trimmedLabel,
      created_at: now,
      last_used_at: now,
    };
    if (existing.length === 0) {
      await tx.insert(schema.deviceKeys).values(newRow);
      return { kind: 'registered', isApproved: autoApprove };
    }

    if (existing[0].kind === 'integration')
      throw new Error(
        'Integration identities cannot be replaced through login',
      );

    if (existing[0].user_id !== user_id) {
      // Take over the device. CASCADE on device_push_tokens.device_id removes
      // the previous owner's push registration. The new owner lands pending.
      const previousUserId = existing[0].user_id;
      await tx
        .delete(schema.deviceKeys)
        .where(eq(schema.deviceKeys.device_id, device_id));
      await tx.insert(schema.deviceKeys).values(newRow);
      return { kind: 'reassigned', isApproved: autoApprove, previousUserId };
    }

    await tx
      .update(schema.deviceKeys)
      .set({
        public_key,
        is_active: true,
        last_used_at: now,
        label: sql`COALESCE(${schema.deviceKeys.label}, ${trimmedLabel})`,
      })
      .where(eq(schema.deviceKeys.device_id, device_id));
    return { kind: 'refreshed', isApproved: existing[0].is_approved };
  });
}

export async function approveDevice(
  device_id: string,
  admin_user_id: string,
): Promise<'ok' | 'not_found'> {
  const now = new Date().toISOString();
  const result = await drizzleDbRef.current
    .update(schema.deviceKeys)
    .set({ is_approved: true, approved_at: now, approved_by: admin_user_id })
    .where(eq(schema.deviceKeys.device_id, device_id))
    .returning();
  return result.length === 0 ? 'not_found' : 'ok';
}

// Admin-level cross-user delete. No last-active guard — admins can prune any
// row including the user's last device; that user will re-enroll on next login.
export async function adminDeleteDevice(
  device_id: string,
  adminId?: string,
): Promise<{ ownerId: string } | 'not_found'> {
  const result = await drizzleDbRef.current
    .delete(schema.deviceKeys)
    .where(eq(schema.deviceKeys.device_id, device_id))
    .returning();
  if (result[0]?.kind === 'integration')
    logger.info(
      {
        event: 'device.grant.revoked',
        deviceId: device_id,
        adminId,
        ownerId: result[0].user_id,
      },
      'Integration revoked',
    );
  return result[0] ? { ownerId: result[0].user_id } : 'not_found';
}

export async function getAllDevices(): Promise<
  Array<UserDevice & { userId: string; username: string | null }>
> {
  const rows = await drizzleDbRef.current
    .select({
      device_id: schema.deviceKeys.device_id,
      user_id: schema.deviceKeys.user_id,
      username: schema.users.username,
      label: schema.deviceKeys.label,
      created_at: schema.deviceKeys.created_at,
      last_used_at: schema.deviceKeys.last_used_at,
      is_active: schema.deviceKeys.is_active,
      is_approved: schema.deviceKeys.is_approved,
      kind: schema.deviceKeys.kind,
      scopes: schema.deviceKeys.scopes,
      expiresAt: schema.deviceKeys.expiresAt,
    })
    .from(schema.deviceKeys)
    .leftJoin(schema.users, eq(schema.users.id, schema.deviceKeys.user_id))
    .orderBy(schema.deviceKeys.is_approved, schema.deviceKeys.created_at);
  return rows.map((r) => ({
    deviceId: r.device_id,
    userId: r.user_id,
    username: r.username ?? null,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    isActive: r.is_active,
    isApproved: r.is_approved,
    kind: r.kind as 'interactive' | 'integration',
    scopes: r.scopes,
    expiresAt: r.expiresAt,
  }));
}

// Signature verification and token issuance only honor *active* AND *approved*
// device keys. Deactivating or revoking approval on a device must immediately
// revoke its ability to sign requests or mint new bearer tokens, regardless
// of any cached session it still holds.
export async function getDevicePublicKey(
  device_id: string,
): Promise<string | undefined> {
  const rows = await drizzleDbRef.current
    .select({ public_key: schema.deviceKeys.public_key })
    .from(schema.deviceKeys)
    .where(
      and(
        eq(schema.deviceKeys.device_id, device_id),
        eq(schema.deviceKeys.is_active, true),
        eq(schema.deviceKeys.is_approved, true),
        or(
          isNull(schema.deviceKeys.expiresAt),
          gt(schema.deviceKeys.expiresAt, new Date().toISOString()),
        ),
      ),
    );
  return rows[0]?.public_key;
}

export async function getUserIdByDevice(
  device_id: string,
): Promise<string | undefined> {
  const rows = await drizzleDbRef.current
    .select({ user_id: schema.deviceKeys.user_id })
    .from(schema.deviceKeys)
    .where(
      and(
        eq(schema.deviceKeys.device_id, device_id),
        eq(schema.deviceKeys.is_active, true),
        eq(schema.deviceKeys.is_approved, true),
        or(
          isNull(schema.deviceKeys.expiresAt),
          gt(schema.deviceKeys.expiresAt, new Date().toISOString()),
        ),
      ),
    );
  return rows[0]?.user_id || undefined;
}

export interface DeviceState {
  kind: 'interactive' | 'integration';
  scopes: string[];
  expiresAt: string | null;
  isActive: boolean;
  isApproved: boolean;
}

// Used by the auth middleware on every authenticated request to drive both
// session revocation (device deactivated/removed → drop session) and the
// pending-device gate (device exists but not yet approved → 403). Returns
// `null` when the device row doesn't exist for this user.
export async function getDeviceStateForUser(
  device_id: string,
  user_id: string,
): Promise<DeviceState | null> {
  const rows = await drizzleDbRef.current
    .select({
      is_active: schema.deviceKeys.is_active,
      is_approved: schema.deviceKeys.is_approved,
      kind: schema.deviceKeys.kind,
      scopes: schema.deviceKeys.scopes,
      expiresAt: schema.deviceKeys.expiresAt,
    })
    .from(schema.deviceKeys)
    .where(
      and(
        eq(schema.deviceKeys.device_id, device_id),
        eq(schema.deviceKeys.user_id, user_id),
      ),
    );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    isActive:
      r.is_active && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()),
    isApproved: r.is_approved,
    kind: r.kind as DeviceState['kind'],
    scopes: r.scopes,
    expiresAt: r.expiresAt,
  };
}

// Refreshes the `last_used_at` timestamp. Callers on the verified-signature
// path may omit `user_id`; ownership-aware callers (auth middleware accepting a
// client-supplied header) should pass it so a spoofed header can't bump
// someone else's row.
export async function updateDeviceLastUsed(
  device_id: string,
  user_id?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const condition = user_id
    ? and(
        eq(schema.deviceKeys.device_id, device_id),
        eq(schema.deviceKeys.user_id, user_id),
      )
    : eq(schema.deviceKeys.device_id, device_id);
  await drizzleDbRef.current
    .update(schema.deviceKeys)
    .set({ last_used_at: now })
    .where(condition);
}

// Device management (user-facing)

export interface UserDevice {
  kind: 'interactive' | 'integration';
  scopes: string[];
  expiresAt: string | null;
  deviceId: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string;
  isActive: boolean;
  isApproved: boolean;
}

export async function getDevicesForUser(
  user_id: string,
): Promise<UserDevice[]> {
  const rows = await drizzleDbRef.current
    .select({
      device_id: schema.deviceKeys.device_id,
      label: schema.deviceKeys.label,
      created_at: schema.deviceKeys.created_at,
      last_used_at: schema.deviceKeys.last_used_at,
      is_active: schema.deviceKeys.is_active,
      is_approved: schema.deviceKeys.is_approved,
      kind: schema.deviceKeys.kind,
      scopes: schema.deviceKeys.scopes,
      expiresAt: schema.deviceKeys.expiresAt,
    })
    .from(schema.deviceKeys)
    .where(eq(schema.deviceKeys.user_id, user_id))
    .orderBy(schema.deviceKeys.created_at);
  return rows.map((r) => ({
    deviceId: r.device_id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    isActive: r.is_active,
    isApproved: r.is_approved,
    kind: r.kind as 'interactive' | 'integration',
    scopes: r.scopes,
    expiresAt: r.expiresAt,
  }));
}

export async function updateDeviceLabel(
  device_id: string,
  user_id: string,
  label: string | null,
): Promise<'ok' | 'not_found'> {
  const result = await drizzleDbRef.current
    .update(schema.deviceKeys)
    .set({ label })
    .where(
      and(
        eq(schema.deviceKeys.device_id, device_id),
        eq(schema.deviceKeys.user_id, user_id),
      ),
    )
    .returning();
  return result.length === 0 ? 'not_found' : 'ok';
}

export type DeviceMutationResult = 'ok' | 'not_found' | 'last_active';

export async function activateDeviceForUser(
  device_id: string,
  user_id: string,
): Promise<DeviceMutationResult> {
  const result = await drizzleDbRef.current
    .update(schema.deviceKeys)
    .set({ is_active: true })
    .where(
      and(
        eq(schema.deviceKeys.device_id, device_id),
        eq(schema.deviceKeys.user_id, user_id),
      ),
    )
    .returning();
  return result.length === 0 ? 'not_found' : 'ok';
}

interface LockedActiveDevices {
  /** Active interactive devices, approved or not. */
  activeIds: string[];
  /** Subset of `activeIds` that can actually sign in (approved). */
  approvedIds: string[];
}

// Locks every active-device row for the user inside the current transaction.
// SELECT ... FOR UPDATE serializes concurrent mutations: two concurrent
// deactivations on different rows can't both observe the pre-update count and
// strand the user with zero approved active devices. Pending (unapproved)
// devices are returned too, but only approved ones are a login capability.
async function lockActiveDevices(
  tx: any,
  user_id: string,
): Promise<LockedActiveDevices> {
  const rows = await tx
    .select({
      device_id: schema.deviceKeys.device_id,
      is_approved: schema.deviceKeys.is_approved,
    })
    .from(schema.deviceKeys)
    .where(
      and(
        eq(schema.deviceKeys.user_id, user_id),
        eq(schema.deviceKeys.is_active, true),
        eq(schema.deviceKeys.kind, 'interactive'),
      ),
    )
    .for('update');
  const typed = rows as Array<{ device_id: string; is_approved: boolean }>;
  return {
    activeIds: typed.map((r) => r.device_id),
    approvedIds: typed.filter((r) => r.is_approved).map((r) => r.device_id),
  };
}

export async function deactivateDeviceIfSafe(
  device_id: string,
  user_id: string,
): Promise<DeviceMutationResult> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const { activeIds, approvedIds } = await lockActiveDevices(tx, user_id);

    if (!activeIds.includes(device_id)) {
      // Either the device doesn't exist for this user, or it's already
      // inactive — distinguish for the response.
      const exists = await tx
        .select({ device_id: schema.deviceKeys.device_id })
        .from(schema.deviceKeys)
        .where(
          and(
            eq(schema.deviceKeys.device_id, device_id),
            eq(schema.deviceKeys.user_id, user_id),
          ),
        );
      if (!exists.length) return 'not_found';
      await tx
        .update(schema.deviceKeys)
        .set({ is_active: false })
        .where(
          and(
            eq(schema.deviceKeys.device_id, device_id),
            eq(schema.deviceKeys.user_id, user_id),
          ),
        );
      return 'ok';
    }

    if (approvedIds.length <= 1 && approvedIds.includes(device_id))
      return 'last_active';

    await tx
      .update(schema.deviceKeys)
      .set({ is_active: false })
      .where(
        and(
          eq(schema.deviceKeys.device_id, device_id),
          eq(schema.deviceKeys.user_id, user_id),
        ),
      );
    return 'ok';
  });
}

// Only enforces the last-active constraint when the target itself is an active,
// approved device — deleting an inactive or pending device never threatens
// login access.
export async function deleteDeviceIfSafe(
  device_id: string,
  user_id: string,
): Promise<DeviceMutationResult> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const { activeIds, approvedIds } = await lockActiveDevices(tx, user_id);
    const isActive = activeIds.includes(device_id);

    if (!isActive) {
      const exists = await tx
        .select({ device_id: schema.deviceKeys.device_id })
        .from(schema.deviceKeys)
        .where(
          and(
            eq(schema.deviceKeys.device_id, device_id),
            eq(schema.deviceKeys.user_id, user_id),
          ),
        );
      if (exists.length === 0) return 'not_found';
    } else if (approvedIds.length <= 1 && approvedIds.includes(device_id)) {
      return 'last_active';
    }

    await tx
      .delete(schema.deviceKeys)
      .where(
        and(
          eq(schema.deviceKeys.device_id, device_id),
          eq(schema.deviceKeys.user_id, user_id),
        ),
      );
    return 'ok';
  });
}

// Push Tokens
export async function upsertDevicePushToken(
  device_id: string,
  user_id: string,
  platform: 'android' | 'ios' | 'web',
  token: string,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(schema.devicePushTokens)
    .values({
      device_id,
      user_id,
      platform,
      token,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: schema.devicePushTokens.device_id,
      set: { user_id, platform, token, updated_at: now },
    });
}

export async function getPushTokensForUser(
  user_id: string,
): Promise<Array<{ device_id: string; platform: string; token: string }>> {
  return drizzleDbRef.current
    .select({
      device_id: schema.devicePushTokens.device_id,
      platform: schema.devicePushTokens.platform,
      token: schema.devicePushTokens.token,
    })
    .from(schema.devicePushTokens)
    .where(eq(schema.devicePushTokens.user_id, user_id));
}

export async function getDevicePushTokenRow(
  device_id: string,
): Promise<{ user_id: string; platform: string; token: string } | undefined> {
  const rows = await drizzleDbRef.current
    .select({
      user_id: schema.devicePushTokens.user_id,
      platform: schema.devicePushTokens.platform,
      token: schema.devicePushTokens.token,
    })
    .from(schema.devicePushTokens)
    .where(eq(schema.devicePushTokens.device_id, device_id))
    .limit(1);
  return rows[0];
}

export async function deletePushTokenByDevice(
  device_id: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(schema.devicePushTokens)
    .where(eq(schema.devicePushTokens.device_id, device_id));
}

export async function deleteStalePushTokens(
  device_ids: string[],
): Promise<void> {
  if (device_ids.length === 0) return;
  await drizzleDbRef.current
    .delete(schema.devicePushTokens)
    .where(inArray(schema.devicePushTokens.device_id, device_ids));
}

// Push Recipients / Member Opt-in

async function getProjectOwnerAndMain(
  project_id: string,
): Promise<{ owner_id: string | null; is_main: boolean } | null> {
  const rows = await drizzleDbRef.current
    .select({
      user_id: schema.projects.user_id,
      is_main: schema.projects.is_main,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, project_id))
    .limit(1);
  if (rows.length === 0) return null;
  return {
    owner_id: rows[0].user_id ?? null,
    is_main: rows[0].is_main === 1,
  };
}

export async function resolvePushTargetUser(
  project_id: string,
  target_user_id: string,
): Promise<
  { allowed: true } | { allowed: false; reason: 'not_member' | 'not_opted_in' }
> {
  const project = await getProjectOwnerAndMain(project_id);
  if (!project) return { allowed: false, reason: 'not_member' };

  // Owner gets no special treatment — they go through the same opt-in check as
  // anyone else. To receive push from a project they own, the owner must tick
  // the toggle once (which creates a project_members row with push_enabled=1).
  const rows = await drizzleDbRef.current
    .select({ push_enabled: schema.projectMembers.push_enabled })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.project_id, project_id),
        eq(schema.projectMembers.user_id, target_user_id),
      ),
    )
    .limit(1);

  if (rows.length === 0) return { allowed: false, reason: 'not_member' };

  const flag = rows[0].push_enabled;
  if (flag === 1) return { allowed: true };
  if (flag === null && project.is_main) return { allowed: true };
  return { allowed: false, reason: 'not_opted_in' };
}

export async function getMemberPushEnabled(
  user_id: string,
  project_id: string,
): Promise<boolean | null> {
  const rows = await drizzleDbRef.current
    .select({ push_enabled: schema.projectMembers.push_enabled })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.user_id, user_id),
        eq(schema.projectMembers.project_id, project_id),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const flag = rows[0].push_enabled;
  if (flag === 1) return true;
  if (flag === 0) return false;
  return null;
}

export async function setMemberPushEnabled(
  user_id: string,
  project_id: string,
  enabled: boolean | null,
): Promise<void> {
  const value = enabled === null ? null : enabled ? 1 : 0;
  await setMemberPreferenceColumn(user_id, project_id, 'push_enabled', value);
}

// Notification Payloads
const DEFAULT_PAYLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RespondToKind = 'chat' | 'task' | 'objective';

export interface RespondToRef {
  kind: RespondToKind;
  /** conversation_id for chat/objective; task_id for task. */
  id: string;
  /** Required when kind === 'objective'. */
  objective_id?: string;
}

export interface NotificationPayloadRow {
  id: string;
  user_id: string;
  kind: string;
  summary: string;
  content: string;
  action_url: string | null;
  respond_to_kind: RespondToKind | null;
  respond_to_id: string | null;
  respond_to_objective_id: string | null;
  form_response: unknown;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  expires_at: string;
}

let lastNotificationPayloadCreatedAtMs = 0;

function nextNotificationPayloadCreatedAt(wallClockMs: number): string {
  lastNotificationPayloadCreatedAtMs = Math.max(
    wallClockMs,
    lastNotificationPayloadCreatedAtMs + 1,
  );
  return new Date(lastNotificationPayloadCreatedAtMs).toISOString();
}

export async function createNotificationPayload(args: {
  user_id: string;
  kind: 'text' | 'json_form' | 'html_form';
  summary: string;
  content: string;
  action_url?: string | null;
  respond_to?: RespondToRef | null;
  ttl_ms?: number;
  /**
   * When set, marks this payload as originating from an intercepted
   * PushNotification tool_use. A unique (user_id, source_tool_use_id) index
   * dedupes re-streamed output: the insert is a no-op on conflict and `created`
   * comes back false so the caller can skip re-sending the FCM push. Omitted
   * (NULL) for notify_user — NULLs are distinct, so those never conflict.
   */
  source_tool_use_id?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const id = randomUUID();
  const now = Date.now();
  const createdAt = nextNotificationPayloadCreatedAt(now);
  const ttl = args.ttl_ms ?? DEFAULT_PAYLOAD_TTL_MS;
  if (!Number.isFinite(ttl)) {
    throw new Error('ttl_ms must be a finite number');
  }
  const expires = new Date(
    now + Math.min(ttl, MAX_PAYLOAD_TTL_MS),
  ).toISOString();
  const inserted = await drizzleDbRef.current
    .insert(schema.notificationPayloads)
    .values({
      id,
      user_id: args.user_id,
      kind: args.kind,
      summary: args.summary,
      content: args.content,
      action_url: args.action_url ?? null,
      respond_to_kind: args.respond_to?.kind ?? null,
      respond_to_id: args.respond_to?.id ?? null,
      respond_to_objective_id: args.respond_to?.objective_id ?? null,
      source_tool_use_id: args.source_tool_use_id ?? null,
      form_response: null,
      created_at: createdAt,
      delivered_at: null,
      acked_at: null,
      expires_at: expires,
    })
    .onConflictDoNothing({
      target: [
        schema.notificationPayloads.user_id,
        schema.notificationPayloads.source_tool_use_id,
      ],
    })
    .returning();
  // Empty result ⇒ a row with this (user_id, source_tool_use_id) already
  // existed and the insert was skipped.
  return inserted.length > 0
    ? { id: inserted[0].id, created: true }
    : { id, created: false };
}

// Delete at most one batch, atomically selecting only rows beyond the grace period.
// Keep key-expiry:* rows so their (user_id, source_tool_use_id) index continues
// to deduplicate unchanged expiring/expired keys across polls and restarts.
export async function purgeExpiredNotificationPayloads(): Promise<number> {
  const table = schema.notificationPayloads;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const expired = drizzleDbRef.current
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        lt(table.expires_at, cutoff),
        or(
          isNull(table.source_tool_use_id),
          notLike(table.source_tool_use_id, 'key-expiry:%'),
        ),
      ),
    )
    .orderBy(table.expires_at, table.id)
    .limit(500);
  const deleted = await drizzleDbRef.current
    .delete(table)
    .where(inArray(table.id, expired))
    .returning();
  return deleted.length;
}

export async function getUndeliveredPayloads(
  user_id: string,
  max = 20,
): Promise<
  Array<{
    id: string;
    kind: string;
    summary: string;
    content: string;
    created_at: string;
  }>
> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .select({
      id: schema.notificationPayloads.id,
      kind: schema.notificationPayloads.kind,
      summary: schema.notificationPayloads.summary,
      content: schema.notificationPayloads.content,
      action_url: schema.notificationPayloads.action_url,
      created_at: schema.notificationPayloads.created_at,
    })
    .from(schema.notificationPayloads)
    .where(
      and(
        eq(schema.notificationPayloads.user_id, user_id),
        isNull(schema.notificationPayloads.delivered_at),
        gt(schema.notificationPayloads.expires_at, now),
      ),
    )
    .limit(max);
  if (rows.length > 0) {
    await drizzleDbRef.current
      .update(schema.notificationPayloads)
      .set({ delivered_at: now })
      .where(
        inArray(
          schema.notificationPayloads.id,
          rows.map((r: { id: string }) => r.id),
        ),
      );
  }
  return rows;
}

export async function getPayloadById(
  id: string,
  user_id: string,
): Promise<NotificationPayloadRow | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(schema.notificationPayloads)
    .where(
      and(
        eq(schema.notificationPayloads.id, id),
        eq(schema.notificationPayloads.user_id, user_id),
      ),
    );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind,
    summary: row.summary,
    content: row.content,
    action_url: row.action_url ?? null,
    respond_to_kind: (row.respond_to_kind as RespondToKind | null) ?? null,
    respond_to_id: row.respond_to_id ?? null,
    respond_to_objective_id: row.respond_to_objective_id ?? null,
    form_response: row.form_response ?? null,
    created_at: row.created_at,
    delivered_at: row.delivered_at ?? null,
    acked_at: row.acked_at ?? null,
    expires_at: row.expires_at,
  };
}

export type PersistFormResponseResult =
  | 'stored'
  | 'already_answered'
  | 'expired';

/**
 * Stores the first answer for a payload. Only an unanswered, unexpired payload
 * is updated, so a duplicate submit (same form open on two devices) or a late
 * one cannot overwrite the stored answer.
 */
export async function persistFormResponse(
  id: string,
  user_id: string,
  values: Record<string, unknown>,
): Promise<PersistFormResponseResult> {
  const table = schema.notificationPayloads;
  const owned = and(eq(table.id, id), eq(table.user_id, user_id));
  const updated = await drizzleDbRef.current
    .update(table)
    .set({ form_response: values })
    .where(
      and(
        owned,
        isNull(table.form_response),
        gt(table.expires_at, new Date().toISOString()),
      ),
    )
    .returning();
  if (updated.length > 0) return 'stored';

  const rows = await drizzleDbRef.current
    .select({ form_response: table.form_response })
    .from(table)
    .where(owned);
  return rows[0]?.form_response != null ? 'already_answered' : 'expired';
}

export async function ackPayload(id: string, user_id: string): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(schema.notificationPayloads)
    .set({ acked_at: now })
    .where(
      and(
        eq(schema.notificationPayloads.id, id),
        eq(schema.notificationPayloads.user_id, user_id),
      ),
    );
}

/** Ack the user's unread payloads, or only those in `ids` when given. */
export async function ackUnreadPayloads(
  user_id: string,
  ids?: readonly string[],
): Promise<Array<{ id: string; kind: string }>> {
  if (ids && ids.length === 0) return [];
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .update(schema.notificationPayloads)
    .set({ acked_at: now })
    .where(
      and(
        eq(schema.notificationPayloads.user_id, user_id),
        isNull(schema.notificationPayloads.acked_at),
        gt(schema.notificationPayloads.expires_at, now),
        ids ? inArray(schema.notificationPayloads.id, [...ids]) : undefined,
      ),
    )
    .returning();
  return rows.map((row) => ({ id: row.id, kind: row.kind }));
}

export async function ackSupersededNotificationPayloads(
  userId: string,
  actionUrl: string,
  currentSourceId: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(schema.notificationPayloads)
    .set({ acked_at: new Date().toISOString() })
    .where(
      and(
        eq(schema.notificationPayloads.user_id, userId),
        eq(schema.notificationPayloads.action_url, actionUrl),
        isNull(schema.notificationPayloads.acked_at),
        ne(schema.notificationPayloads.source_tool_use_id, currentSourceId),
      ),
    );
}

export async function ackDuplicateUnreadMemoryReviewPayloads(
  userId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .select({
      id: schema.notificationPayloads.id,
      actionUrl: schema.notificationPayloads.action_url,
    })
    .from(schema.notificationPayloads)
    .where(
      and(
        eq(schema.notificationPayloads.user_id, userId),
        isNull(schema.notificationPayloads.acked_at),
        gt(schema.notificationPayloads.expires_at, now),
        like(schema.notificationPayloads.action_url, '/memory-review?%'),
      ),
    )
    .orderBy(desc(schema.notificationPayloads.created_at));

  const seenActionUrls = new Set<string>();
  const duplicateIds: string[] = [];
  for (const row of rows) {
    if (!row.actionUrl || seenActionUrls.has(row.actionUrl)) {
      duplicateIds.push(row.id);
      continue;
    }
    seenActionUrls.add(row.actionUrl);
  }
  if (duplicateIds.length === 0) return;

  await drizzleDbRef.current
    .update(schema.notificationPayloads)
    .set({ acked_at: now })
    .where(inArray(schema.notificationPayloads.id, duplicateIds));
}

/**
 * Unread filter for notifications that link to a task
 * (`/board/<project>?taskId=<id>`): an archived task has no Now row, so
 * neither does a notification about it. A notification created before an
 * archive, or while the task was archived, stays hidden after a restore (the
 * board replay events record every archive and restore); one created after
 * the restore is shown normally. Derived at read time, so it covers every
 * archive path, offline recipients and notifications that predate the
 * archive, for text and form kinds alike.
 */
function notArchivedTaskPayload() {
  const actionUrl = schema.notificationPayloads.action_url;
  const taskId = sql`substring(${actionUrl} from 'taskId=([^&]+)')`;
  return sql`(${actionUrl} is null
    or ${actionUrl} not like '/board/%taskId=%'
    or not (
      exists (
        select 1 from ${schema.tasks}
        where ${schema.tasks.id} = ${taskId} and ${schema.tasks.archived} = 1
      )
      or exists (
        select 1 from ${schema.taskBoardEvents}
        where ${schema.taskBoardEvents.task_id} = ${taskId}
          and ${schema.taskBoardEvents.snapshot}->>'archived' = 'true'
          and ${schema.taskBoardEvents.occurred_at} >= ${schema.notificationPayloads.created_at}
      )
      or coalesce((
        select ${schema.taskBoardEvents.snapshot}->>'archived'
        from ${schema.taskBoardEvents}
        where ${schema.taskBoardEvents.task_id} = ${taskId}
          and ${schema.taskBoardEvents.occurred_at} <= ${schema.notificationPayloads.created_at}
        order by ${schema.taskBoardEvents.occurred_at} desc, ${schema.taskBoardEvents.id} desc
        limit 1
      ), 'false') = 'true'
    ))`;
}

/**
 * Unread filter for task-linked notifications (`/board/<project>?taskId=<id>`)
 * whose task was deleted: a deleted card has no Now row either. Detected by
 * the missing `tasks` row, not a `deleted` board event, because moving a task
 * to another project also records one and keeps its id and notifications.
 * Every task-linked notification is created for an existing task (issue
 * import, task notify and notify_user all run against a stored task row).
 */
function existingTaskPayload() {
  const actionUrl = schema.notificationPayloads.action_url;
  return sql`(${actionUrl} is null
    or ${actionUrl} not like '/board/%taskId=%'
    or exists (
      select 1 from ${schema.tasks}
      where ${schema.tasks.id} = substring(${actionUrl} from 'taskId=([^&]+)')
    ))`;
}

/**
 * SQL for "`projectId`/`status` name a stage where a task with an `event`
 * notification needs attention" (any attention stage without `event`). Stage definitions are in memory (project configuration, not task
 * state), so they are expanded into the statement as project/stage lists.
 */
function attentionStageSql(
  projectId: SQL,
  status: SQL,
  event?: AttentionEvent,
): SQL {
  const idsOf = (group: RegisteredGroup | undefined) => {
    const stages = getGroupStages(group);
    return stages
      .filter((stage) => isAttentionStage(stages, stage.id, event))
      .map((stage) => stage.id);
  };
  const foldersByStages = new Map<
    string,
    { ids: string[]; folders: string[] }
  >();
  const registered: string[] = [];
  for (const group of Object.values(registeredGroups)) {
    registered.push(group.folder);
    const ids = idsOf(group);
    const key = JSON.stringify(ids);
    const entry = foldersByStages.get(key) ?? { ids, folders: [] };
    entry.folders.push(group.folder);
    foldersByStages.set(key, entry);
  }
  const list = (values: string[]) =>
    sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    );
  const clauses = [...foldersByStages.values()]
    .filter((entry) => entry.ids.length > 0)
    .map(
      (entry) =>
        sql`(${projectId} in (${list(entry.folders)}) and ${status} in (${list(entry.ids)}))`,
    );
  // Projects without a registered group use the default stages.
  const defaults = idsOf(undefined);
  if (defaults.length > 0) {
    clauses.push(
      registered.length > 0
        ? sql`(${projectId} not in (${list(registered)}) and ${status} in (${list(defaults)}))`
        : sql`${status} in (${list(defaults)})`,
    );
  }
  return clauses.length > 0
    ? sql`(${sql.join(clauses, sql` or `)})`
    : sql`false`;
}

/**
 * Unread needs_input/failed lifecycle notifications about a task that is not
 * in the Question or Failed stage of its project right now, or that were
 * stored before the task last arrived in its current stage (a late delivery
 * that would resurface on a return). The task is read in the same statement as
 * the list or count, so a delivery at any moment is judged on the task's
 * state at that moment. A notification whose task is missing is not stale.
 */
function staleAttentionPayload(): SQL {
  const actionUrl = schema.notificationPayloads.action_url;
  const source = schema.notificationPayloads.source_tool_use_id;
  const needsInputSource = sql`(${source} like 'task:%:needs_input:%'
    or ${source} like 'stage-entry:%:needs_input:%')`;
  // `task:<task>:recovery-exhausted:<stage>:<message>:needs_input:<user>`.
  const recoveryStageSource = sql`(${source} like 'task:%:needs_input:%'
    and split_part(${source}, ':', 3) = 'recovery-exhausted')`;
  return sql`(${schema.notificationPayloads.kind} = 'text'
    and ${actionUrl} like '/board/%taskId=%'
    and ${lifecycleAttentionSource()}
    and exists (
      select 1 from ${schema.tasks} as t
      where t.id = substring(${actionUrl} from 'taskId=([^&]+)')
        and (
          not (case
            -- Recovery exhaustion reports needs_input for the recovery stage the
            -- task was parked in (any Failed, Question or recovery queue).
            when ${recoveryStageSource} then t.status = split_part(${source}, ':', 4)
            when ${needsInputSource} then ${attentionStageSql(sql`t.project_id`, sql`t.status`, 'needs_input')}
            -- A failed stage-entry agent keeps the card in its entry stage; the
            -- failed receipt is resolved when the card leaves that stage.
            else (${attentionStageSql(sql`t.project_id`, sql`t.status`, 'failed')}
              or exists (
                select 1 from ${schema.stageEntryEvents} as se
                where se.task_id = t.id
                  and se.stage_id = t.status
                  and se.state = 'failed'
              ))
          end)
          -- Board events are written on every stage change: the first event of
          -- the current stage after the last event of another stage.
          or ${schema.notificationPayloads.created_at} < (
            select e.occurred_at from task_board_events e
            where e.task_id = t.id
              and e.status = t.status
              and e.id > (
                select max(p.id) from task_board_events p
                where p.task_id = t.id and p.status <> t.status
              )
            order by e.id asc limit 1
          )
        )
    ))`;
}

/** Unread, unexpired payloads of `user_id` that the Now list and bell show. */
function visibleUnreadPayload(user_id: string, now: string) {
  return and(
    eq(schema.notificationPayloads.user_id, user_id),
    isNull(schema.notificationPayloads.acked_at),
    gt(schema.notificationPayloads.expires_at, now),
    notArchivedTaskPayload(),
    existingTaskPayload(),
    // Null (no source id, no link) is not stale.
    sql`not coalesce(${staleAttentionPayload()}, false)`,
  );
}

export async function getUnreadPayloads(
  user_id: string,
  max = 50,
): Promise<
  Array<{
    id: string;
    kind: string;
    summary: string;
    action_url: string | null;
    created_at: string;
  }>
> {
  const now = new Date().toISOString();
  return drizzleDbRef.current
    .select({
      id: schema.notificationPayloads.id,
      kind: schema.notificationPayloads.kind,
      summary: schema.notificationPayloads.summary,
      action_url: schema.notificationPayloads.action_url,
      created_at: schema.notificationPayloads.created_at,
    })
    .from(schema.notificationPayloads)
    .where(visibleUnreadPayload(user_id, now))
    .orderBy(desc(schema.notificationPayloads.created_at))
    .limit(max);
}

export async function countUnreadPayloads(user_id: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .select({ c: count() })
    .from(schema.notificationPayloads)
    .where(visibleUnreadPayload(user_id, now));
  return Number(rows[0]?.c ?? 0);
}

/**
 * Conversation IDs that have at least one unacked, non-expired notification
 * payload waiting for a response. Used by the stuck-conversation sweep so it
 * doesn't mislabel "agent waiting for form" as "agent crashed by restart".
 */
export async function getConversationIdsWithPendingForms(): Promise<
  Set<string>
> {
  const now = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .select({ conversation_id: schema.notificationPayloads.respond_to_id })
    .from(schema.notificationPayloads)
    .where(
      and(
        eq(schema.notificationPayloads.respond_to_kind, 'chat'),
        isNull(schema.notificationPayloads.acked_at),
        gt(schema.notificationPayloads.expires_at, now),
      ),
    );
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.conversation_id) ids.add(r.conversation_id);
  }
  return ids;
}

export async function hasPendingFormForEntity(
  kind: 'chat' | 'task',
  id: string,
  correlation?: { userId: string; runId: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const correlationConditions = correlation
    ? [
        eq(schema.notificationPayloads.user_id, correlation.userId),
        like(
          schema.notificationPayloads.source_tool_use_id,
          `notify-form-run:${correlation.runId}:%`,
        ),
      ]
    : [];
  const rows = await drizzleDbRef.current
    .select({ id: schema.notificationPayloads.id })
    .from(schema.notificationPayloads)
    .where(
      and(
        eq(schema.notificationPayloads.kind, 'json_form'),
        eq(schema.notificationPayloads.respond_to_kind, kind),
        eq(schema.notificationPayloads.respond_to_id, id),
        isNull(schema.notificationPayloads.acked_at),
        gt(schema.notificationPayloads.expires_at, now),
        ...correlationConditions,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Integration enrollment is insert-only: it must never refresh a trusted key.
export async function getDeviceRecord(deviceId: string) {
  return (
    await drizzleDbRef.current
      .select()
      .from(schema.deviceKeys)
      .where(eq(schema.deviceKeys.device_id, deviceId))
  )[0];
}

export async function createDevicePairing(
  value: typeof schema.devicePairings.$inferInsert,
) {
  await drizzleDbRef.current
    .delete(schema.devicePairings)
    .where(
      lt(
        schema.devicePairings.expiresAt,
        new Date(Date.now() - 86400000).toISOString(),
      ),
    );
  const [pending] = await drizzleDbRef.current
    .select({ total: count() })
    .from(schema.devicePairings)
    .where(gt(schema.devicePairings.expiresAt, new Date().toISOString()));
  if (pending.total >= 1000)
    throw new Error('Pairing capacity reached; try later');
  await drizzleDbRef.current.insert(schema.devicePairings).values(value);
}

export async function getDevicePairing(id: string) {
  return (
    await drizzleDbRef.current
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, id))
  )[0];
}

export async function resolveDevicePairing(codeHash: string) {
  return (
    await drizzleDbRef.current
      .select()
      .from(schema.devicePairings)
      .where(
        and(
          eq(schema.devicePairings.codeHash, codeHash),
          eq(schema.devicePairings.status, 'pending'),
          gt(schema.devicePairings.expiresAt, new Date().toISOString()),
        ),
      )
  )[0];
}

export async function pollDevicePairing(id: string) {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, id))
      .for('update');
    if (!row || Date.parse(row.expiresAt) <= Date.now()) return 'expired';
    if (row.lastPolledAt && Date.now() - Date.parse(row.lastPolledAt) < 5000)
      return 'slow_down';
    await tx
      .update(schema.devicePairings)
      .set({ lastPolledAt: new Date().toISOString() })
      .where(eq(schema.devicePairings.id, id));
    return row.status;
  });
}

export async function decideDevicePairing(
  id: string,
  adminId: string,
  decision: 'approved' | 'denied',
  ownerId: string,
  scopes: string[],
  expiresAt: string | null,
) {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, id))
      .for('update');
    if (!row || Date.parse(row.expiresAt) <= Date.now()) return 'expired';
    if (row.status !== 'pending') return 'already_decided';
    const [admin] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, adminId));
    const [owner] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, ownerId));
    if (
      !admin ||
      admin.disabled ||
      admin.role !== 'admin' ||
      !owner ||
      owner.disabled
    )
      return 'invalid_user';
    if (scopes.some((scope) => !row.requestedScopes.includes(scope)))
      return 'invalid_scopes';
    const now = new Date().toISOString();
    if (decision === 'approved') {
      if (!scopes.length) return 'invalid_scopes';
      await tx.insert(schema.deviceKeys).values({
        device_id: row.deviceId,
        user_id: ownerId,
        public_key: row.publicKey,
        kind: 'integration',
        scopes,
        expiresAt,
        label: row.label,
        is_active: true,
        is_approved: true,
        approved_at: now,
        approved_by: adminId,
        created_at: now,
        last_used_at: now,
      });
    }
    await tx
      .update(schema.devicePairings)
      .set({ status: decision, approvedBy: adminId })
      .where(eq(schema.devicePairings.id, id));
    logger.info(
      {
        event: `device.pairing.${decision}`,
        deviceId: row.deviceId,
        adminId,
        ownerId,
        scopes,
        expiresAt,
      },
      'Integration pairing decision',
    );
    return decision;
  });
}

export async function updateIntegrationGrant(
  deviceId: string,
  adminId: string,
  scopes: string[],
  expiresAt: string | null | undefined,
) {
  return drizzleDbRef.current.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.deviceKeys)
      .where(eq(schema.deviceKeys.device_id, deviceId))
      .for('update');
    if (!row || row.kind !== 'integration') return 'not_found';
    if (!scopes.length || scopes.some((scope) => !row.scopes.includes(scope)))
      return 'invalid_scopes';
    expiresAt = expiresAt === undefined ? row.expiresAt : expiresAt;
    await tx
      .update(schema.deviceKeys)
      .set({ scopes, expiresAt })
      .where(eq(schema.deviceKeys.device_id, deviceId));
    logger.info(
      { event: 'device.grant.updated', deviceId, adminId, scopes, expiresAt },
      'Integration grant updated',
    );
    return 'ok';
  });
}
