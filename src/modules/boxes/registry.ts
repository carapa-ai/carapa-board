/**
 * Registry of CarapaBox hosts allowed to connect to this Board.
 *
 * Each box authenticates its outbound WebSocket with a per-box bearer token.
 * Only the SHA-256 hash is stored; the plaintext is returned once on creation
 * (and on rotation). Revoking a box closes its live connection.
 */
import crypto from 'node:crypto';
import { sha256Hex } from '../../lib/hash.js';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { boxes } from '../../db/schema.js';

export type BoxKind = 'docker' | 'native';

/** The box Board reaches over CARAPA_BOX_URL when no remote box is selected. */
export const LOCAL_BOX_ID = 'local';

export interface BoxRecord {
  id: string;
  label: string;
  kind: BoxKind;
  tokenPrefix: string;
  isolationLevel: string;
  version: string | null;
  capabilities: string[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

const TOKEN_PREFIX = 'cbx_';
const BOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidBoxId(id: string): boolean {
  return BOX_ID_PATTERN.test(id);
}

/** Isolation implied by a box kind; native runners only have the harness sandbox. */
export function defaultIsolationLevel(kind: BoxKind): string {
  return kind === 'native' ? 'reduced' : 'container';
}

function hashBoxToken(token: string): string {
  return sha256Hex(token);
}

function newToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function db() {
  const current = drizzleDbRef.current;
  if (!current) throw new Error('Database not initialized');
  return current;
}

function toRecord(row: typeof boxes.$inferSelect): BoxRecord {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind === 'native' ? 'native' : 'docker',
    tokenPrefix: row.token_prefix,
    isolationLevel: row.isolation_level,
    version: row.version,
    capabilities: row.capabilities ?? [],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export async function listBoxes(): Promise<BoxRecord[]> {
  const rows = await db().select().from(boxes);
  return rows.map(toRecord).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getBox(id: string): Promise<BoxRecord | null> {
  const rows = await db().select().from(boxes).where(eq(boxes.id, id));
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function createBox(input: {
  id: string;
  label?: string;
  kind?: BoxKind;
}): Promise<{ box: BoxRecord; token: string }> {
  if (!isValidBoxId(input.id)) {
    throw new Error('Box id must be lowercase letters, digits and dashes');
  }
  const kind: BoxKind = input.kind === 'native' ? 'native' : 'docker';
  const issued = newToken();
  const row = {
    id: input.id,
    label: input.label?.trim() || input.id,
    kind,
    token_hash: hashBoxToken(issued),
    token_prefix: issued.slice(0, TOKEN_PREFIX.length + 6),
    isolation_level: defaultIsolationLevel(kind),
    capabilities: [] as string[],
    created_at: new Date().toISOString(),
  };
  await db().insert(boxes).values(row);
  const box = await getBox(input.id);
  if (!box) throw new Error('Box was not created');
  return { box, token: issued };
}

/** Issue a new token (the old one stops working immediately). */
export async function rotateBoxToken(id: string): Promise<string> {
  const issued = newToken();
  const updated = await db()
    .update(boxes)
    .set({
      token_hash: hashBoxToken(issued),
      token_prefix: issued.slice(0, TOKEN_PREFIX.length + 6),
      revoked_at: null,
    })
    .where(eq(boxes.id, id))
    .returning();
  if (!updated.length) throw new Error('Box not found');
  return issued;
}

export async function revokeBox(id: string): Promise<boolean> {
  const updated = await db()
    .update(boxes)
    .set({ revoked_at: new Date().toISOString() })
    .where(eq(boxes.id, id))
    .returning();
  return updated.length > 0;
}

export async function deleteBox(id: string): Promise<boolean> {
  const deleted = await db().delete(boxes).where(eq(boxes.id, id)).returning();
  return deleted.length > 0;
}

/** Verify a connecting box. Returns the record only for a live, matching token. */
export async function authenticateBox(
  id: string,
  token: string,
): Promise<BoxRecord | null> {
  if (!isValidBoxId(id) || !token.startsWith(TOKEN_PREFIX)) return null;
  const rows = await db().select().from(boxes).where(eq(boxes.id, id));
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  const expected = Buffer.from(row.token_hash, 'hex');
  const actual = Buffer.from(hashBoxToken(token), 'hex');
  if (expected.length !== actual.length) return null;
  return crypto.timingSafeEqual(expected, actual) ? toRecord(row) : null;
}

/** Record what a box reported on connect (version, capabilities, isolation). */
export async function recordBoxHello(
  id: string,
  hello: { version?: string; capabilities?: string[]; isolationLevel?: string },
): Promise<void> {
  const set: Partial<typeof boxes.$inferInsert> = {
    last_seen_at: new Date().toISOString(),
  };
  if (hello.version) set.version = hello.version.slice(0, 64);
  if (hello.capabilities) set.capabilities = hello.capabilities.slice(0, 32);
  if (hello.isolationLevel)
    set.isolation_level = hello.isolationLevel.slice(0, 32);
  await db().update(boxes).set(set).where(eq(boxes.id, id));
}

/**
 * Key a box's relay forwarder signs requests with: the SHA-256 of its
 * connection secret, which the box derives itself. Null for unknown or
 * revoked boxes.
 */
export async function getBoxForwarderKey(id: string): Promise<string | null> {
  const rows = await db().select().from(boxes).where(eq(boxes.id, id));
  const row = rows[0];
  return row && !row.revoked_at ? row.token_hash : null;
}

export async function touchBox(id: string): Promise<void> {
  await db()
    .update(boxes)
    .set({ last_seen_at: new Date().toISOString() })
    .where(eq(boxes.id, id));
}
