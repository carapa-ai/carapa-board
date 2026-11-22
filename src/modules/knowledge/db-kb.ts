import { projectChanges } from '../../lib/project-changes.js';
import { adminBypassesProject } from '../../lib/project-ownership.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeBaseShares,
  kbMembers,
  users,
  projects,
  projectMembers,
  conversationMembers,
  conversationPublicShares,
  conversations,
  deviceKeys,
} from '../../db/schema.js';
import { eq, and, desc, asc, ilike, inArray, isNull, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { KnowledgeBase, KnowledgeDocumentMetadata } from './types.js';
import { logger } from '../../logger.js';
import { PERSONAL_MAIN_PREFIX } from '../projects/reserved-folders.js';

/** Persisted shape of document metadata; dates are stored as timestamptz. */
export type KnowledgeDocumentRowUpdate = Partial<
  Omit<KnowledgeDocumentMetadata, 'publishedAt'>
> & {
  publishedAt?: Date | null;
  /** Only supplied when the document is first created. */
  addedAt?: Date;
};

export async function getKnowledgeDocuments(kbId: string) {
  return drizzleDbRef.current
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.kbId, kbId));
}

export async function getKnowledgeDocument(kbId: string, path: string) {
  const [document] = await drizzleDbRef.current
    .select()
    .from(knowledgeDocuments)
    .where(
      and(eq(knowledgeDocuments.kbId, kbId), eq(knowledgeDocuments.path, path)),
    );
  return document;
}

export async function updateKnowledgeDocumentMetadata(
  kbId: string,
  path: string,
  metadata: KnowledgeDocumentRowUpdate,
): Promise<void> {
  if (!Object.keys(metadata).length) return;
  await drizzleDbRef.current
    .insert(knowledgeDocuments)
    .values({ kbId, path, ...metadata })
    .onConflictDoUpdate({
      target: [knowledgeDocuments.kbId, knowledgeDocuments.path],
      set: metadata,
    });
}

/** Fill a missing added_at; never overwrites an existing value. */
export async function backfillKnowledgeDocumentAddedAt(
  kbId: string,
  path: string,
  addedAt: Date,
): Promise<void> {
  await drizzleDbRef.current
    .update(knowledgeDocuments)
    .set({ addedAt })
    .where(
      and(
        eq(knowledgeDocuments.kbId, kbId),
        eq(knowledgeDocuments.path, path),
        isNull(knowledgeDocuments.addedAt),
      ),
    );
}

export async function setKnowledgeDocumentTags(
  kbId: string,
  path: string,
  tags: string[],
): Promise<void> {
  await drizzleDbRef.current
    .insert(knowledgeDocuments)
    .values({ kbId, path, tags })
    .onConflictDoUpdate({
      target: [knowledgeDocuments.kbId, knowledgeDocuments.path],
      set: { tags },
    });
}

export async function deleteKnowledgeDocument(
  kbId: string,
  path: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(knowledgeDocuments)
    .where(
      and(eq(knowledgeDocuments.kbId, kbId), eq(knowledgeDocuments.path, path)),
    );
}

export async function createKnowledgeBase(kb: KnowledgeBase): Promise<void> {
  await drizzleDbRef.current.insert(knowledgeBases).values({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    folder_path: kb.folder_path,
    last_indexed_at: kb.last_indexed_at,
    created_at: kb.created_at,
  });
}

export async function getKnowledgeBase(
  id: string,
): Promise<KnowledgeBase | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, id));
  if (!rows[0]) return undefined;

  return {
    id: rows[0].id,
    name: rows[0].name,
    description: rows[0].description,
    folder_path: rows[0].folder_path,
    last_indexed_at: rows[0].last_indexed_at,
    created_at: Number(rows[0].created_at),
  } as KnowledgeBase;
}

export async function getAllKnowledgeBases(): Promise<KnowledgeBase[]> {
  const rows = await drizzleDbRef.current
    .select()
    .from(knowledgeBases)
    .orderBy(desc(knowledgeBases.created_at));

  return rows.map(
    (row: any) =>
      ({
        id: row.id,
        name: row.name,
        description: row.description,
        folder_path: row.folder_path,
        last_indexed_at: row.last_indexed_at,
        created_at: Number(row.created_at),
      }) as KnowledgeBase,
  );
}

export async function updateKnowledgeBase(
  id: string,
  updates: Partial<KnowledgeBase>,
): Promise<void> {
  const setObj: any = {};
  if (updates.name !== undefined) setObj.name = updates.name;
  if (updates.description !== undefined)
    setObj.description = updates.description;
  if (updates.folder_path !== undefined)
    setObj.folder_path = updates.folder_path;
  if (updates.last_indexed_at !== undefined)
    setObj.last_indexed_at = updates.last_indexed_at;

  if (Object.keys(setObj).length === 0) return;

  await drizzleDbRef.current
    .update(knowledgeBases)
    .set(setObj)
    .where(eq(knowledgeBases.id, id));
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  await drizzleDbRef.current.delete(kbMembers).where(eq(kbMembers.kb_id, id));
  await drizzleDbRef.current
    .delete(knowledgeBaseShares)
    .where(eq(knowledgeBaseShares.knowledge_base_id, id));
  await drizzleDbRef.current
    .delete(knowledgeDocuments)
    .where(eq(knowledgeDocuments.kbId, id));
  await drizzleDbRef.current
    .delete(knowledgeBases)
    .where(eq(knowledgeBases.id, id));
}

/**
 * Share a knowledge base with a project.
 *
 * Project shares live in `knowledge_base_shares`, whose `group_folder` column
 * references `projects.id` with ON DELETE CASCADE. `kb_members` cannot carry
 * this: its `user_id` references `users.id`, so a synthetic `group:<folder>`
 * row is rejected by the foreign key.
 */
export async function shareKnowledgeBase(
  kb_id: string,
  group_folder: string,
): Promise<void> {
  await drizzleDbRef.current
    .insert(knowledgeBaseShares)
    .values({ knowledge_base_id: kb_id, group_folder })
    .onConflictDoNothing({
      target: [
        knowledgeBaseShares.knowledge_base_id,
        knowledgeBaseShares.group_folder,
      ],
    });
}

export async function unshareKnowledgeBase(
  kb_id: string,
  group_folder: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(knowledgeBaseShares)
    .where(
      and(
        eq(knowledgeBaseShares.knowledge_base_id, kb_id),
        eq(knowledgeBaseShares.group_folder, group_folder),
      ),
    );
}

export async function getSharedKnowledgeBases(
  group_folder: string,
): Promise<KnowledgeBase[]> {
  const rows = await drizzleDbRef.current
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      folder_path: knowledgeBases.folder_path,
      last_indexed_at: knowledgeBases.last_indexed_at,
      created_at: knowledgeBases.created_at,
    })
    .from(knowledgeBaseShares)
    .innerJoin(
      knowledgeBases,
      eq(knowledgeBases.id, knowledgeBaseShares.knowledge_base_id),
    )
    .where(eq(knowledgeBaseShares.group_folder, group_folder))
    .orderBy(asc(knowledgeBases.name));

  return rows.map(
    (row: any) =>
      ({
        id: row.id,
        name: row.name,
        description: row.description,
        folder_path: row.folder_path,
        last_indexed_at: row.last_indexed_at,
        created_at: Number(row.created_at),
      }) as KnowledgeBase,
  );
}

export async function getKnowledgeBaseShares(kb_id: string): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ group_folder: knowledgeBaseShares.group_folder })
    .from(knowledgeBaseShares)
    .where(eq(knowledgeBaseShares.knowledge_base_id, kb_id));

  return rows.map((r: any) => String(r.group_folder));
}

export type UserRole = 'admin' | 'user';
export type ProjectAccessLevel = 'owner' | 'editor' | 'viewer';
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  displayName: string | null;
  avatarPath: string | null;
  created_at: string;
  disabled?: boolean;
  /** Session JWTs issued under an older value are refused. */
  tokenVersion?: number;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  logger.debug(
    { storedHashLength: storedHash?.length },
    '[verifyPassword] checking',
  );
  if (!storedHash.startsWith('scrypt:')) {
    const matched = password === storedHash;
    logger.debug({ matched }, '[verifyPassword] plain match result');
    return matched;
  }
  const [algo, saltB64, hashB64] = storedHash.split(':');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) {
    logger.debug('[verifyPassword] invalid scrypt format');
    return false;
  }
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length);
  const matched = crypto.timingSafeEqual(expected, actual);
  logger.debug({ matched }, '[verifyPassword] scrypt match result');
  return matched;
}

function newUserId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register the per-user `main-<username>` group for an existing user. Idempotent:
 * skips if the user already owns any `is_main` project (handles both the new
 * `main-<username>` convention and any legacy `main` that may already be theirs).
 * The new project is owned via `user_id` and intentionally has no
 * `project_members` row — the owner has implicit access via ownership.
 */
export async function ensureUserMainGroup(
  user_id: string,
  username: string,
): Promise<void> {
  const owned = await drizzleDbRef.current
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.user_id, user_id), eq(projects.is_main, 1)))
    .limit(1);
  if (owned.length > 0) return;

  const folderName = `main-${username.trim().toLowerCase()}`;

  const { registerGroup } = await import('../../state-manager.js');
  await registerGroup(folderName, {
    name: `${username.trim()}'s Assistant`,
    folder: folderName,
    trigger: '!',
    added_at: new Date().toISOString(),
    settings: {
      mode: 'chat',
      autoStartStack: true,
    },
    is_main: true,
    user_id,
  });
}

/**
 * Create the first administrator on a fresh install with a random password.
 * The password is written once to stderr, bypassing the log redaction that
 * would otherwise hide it; sign in with it and change it.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if ((await listUsers()).length > 0) return;
  const password = crypto.randomBytes(18).toString('base64url');
  await createUser('admin', password, 'admin');
  process.stderr.write(
    `\nCreated the first CarapaBoard administrator.\n  username: admin\n  password: ${password}\nSign in and change this password; it is not shown again.\n\n`,
  );
}

/** A non-orphaned project already uses the new user's `main-<username>` folder. */
export class MainFolderTakenError extends Error {
  constructor(folder: string) {
    super(`Personal project folder "${folder}" is already used by a project`);
    this.name = 'MainFolderTakenError';
  }
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole = 'user',
): Promise<AuthUser> {
  const now = new Date().toISOString();
  const id = newUserId();
  const password_hash = hashPassword(password);

  // Human principals are bound to `main-<username>`; refuse to create the user
  // when another project holds that folder. An orphaned main (its owner was
  // deleted before mains were archived) is archived, not re-adopted, so the
  // new user starts with an empty main.
  const mainFolder = `${PERSONAL_MAIN_PREFIX}${username.trim().toLowerCase()}`;
  const [existingMain] = await drizzleDbRef.current
    .select({ is_main: projects.is_main, user_id: projects.user_id })
    .from(projects)
    .where(eq(projects.id, mainFolder))
    .limit(1);
  // Another project's folder or configured sandbox instance equal to the main
  // folder would be served the new main's tokens; refuse before anything is
  // archived or inserted (the orphaned main itself is being replaced).
  const assertMainNameFree = async () => {
    const { findSandboxNameConflict } = await import('../../state-manager.js');
    if (
      findSandboxNameConflict(mainFolder, mainFolder, { includeFolders: true })
    )
      throw new MainFolderTakenError(mainFolder);
  };
  if (!existingMain) await assertMainNameFree();
  if (existingMain) {
    const [owner] = existingMain.user_id
      ? await drizzleDbRef.current
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, existingMain.user_id))
          .limit(1)
      : [];
    const orphaned = existingMain.is_main === 1 && !owner;
    // The same username's own main falls through: the insert below reports the
    // duplicate as a unique violation.
    if (!orphaned && owner?.username !== username.trim())
      throw new MainFolderTakenError(mainFolder);
    if (orphaned) {
      await assertMainNameFree();
      const { archivePersonalMain } =
        await import('../projects/archive-main.js');
      await archivePersonalMain(mainFolder);
    }
  }

  await drizzleDbRef.current.insert(users).values({
    id,
    username: username.trim(),
    password_hash,
    role,
    created_at: now,
  });

  // Accepted risks: a crash between the insert above and the delete below
  // leaves a user without a main (the boot backfill in src/index.ts retries
  // it); a project created with this folder after the check above makes
  // ensureUserMainGroup throw, which the delete-and-rethrow path catches.
  try {
    await ensureUserMainGroup(id, username);
  } catch (err) {
    logger.error(
      { err },
      '[createUser] failed to register main group for user',
    );
    await drizzleDbRef.current.delete(users).where(eq(users.id, id));
    throw err;
  }

  return {
    id,
    username: username.trim(),
    role,
    displayName: null,
    avatarPath: null,
    created_at: now,
  };
}

export async function getUserByUsername(
  username: string,
): Promise<(AuthUser & { password_hash: string }) | undefined> {
  const allUsers = await drizzleDbRef.current
    .select({
      id: users.id,
      username: users.username,
      password_hash: users.password_hash,
      role: users.role,
      created_at: users.created_at,
      displayName: users.displayName,
      avatarPath: users.avatarPath,
      disabled: users.disabled,
      token_version: users.token_version,
    })
    .from(users);

  const matched = allUsers.find(
    (u: any) => u.username.toLowerCase() === username.trim().toLowerCase(),
  );
  if (!matched) return undefined;

  if (allUsers.length === 1 && matched.role !== 'admin') {
    matched.role = 'admin';
    await drizzleDbRef.current
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, matched.id));
  }

  return {
    id: matched.id,
    username: matched.username,
    role: matched.role as UserRole,
    displayName: matched.displayName,
    avatarPath: matched.avatarPath,
    created_at: matched.created_at,
    disabled: !!matched.disabled,
    tokenVersion: matched.token_version,
    password_hash: matched.password_hash,
  };
}

export async function getUserById(id: string): Promise<AuthUser | undefined> {
  const rows = await drizzleDbRef.current
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      created_at: users.created_at,
      displayName: users.displayName,
      avatarPath: users.avatarPath,
      disabled: users.disabled,
      token_version: users.token_version,
    })
    .from(users)
    .where(eq(users.id, id));

  if (!rows[0]) return undefined;

  if (rows[0].role !== 'admin') {
    const totalUsers = await drizzleDbRef.current
      .select({ id: users.id })
      .from(users)
      .limit(2);
    if (totalUsers.length === 1) {
      rows[0].role = 'admin';
      await drizzleDbRef.current
        .update(users)
        .set({ role: 'admin' })
        .where(eq(users.id, rows[0].id));
    }
  }

  return {
    id: rows[0].id,
    username: rows[0].username,
    role: rows[0].role as UserRole,
    displayName: rows[0].displayName,
    avatarPath: rows[0].avatarPath,
    created_at: rows[0].created_at,
    disabled: !!rows[0].disabled,
    tokenVersion: rows[0].token_version,
  };
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarPath: string | null;
}

export async function getUserProfilesByIds(
  ids: string[],
): Promise<Record<string, UserProfile>> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return {};
  const rows = await drizzleDbRef.current
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarPath: users.avatarPath,
    })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

export async function getUsernamesByIds(
  ids: string[],
): Promise<Record<string, string>> {
  const profiles = await getUserProfilesByIds(ids);
  return Object.fromEntries(
    Object.values(profiles).map((profile) => [profile.id, profile.username]),
  );
}

export async function listUsers(): Promise<AuthUser[]> {
  const rows = await drizzleDbRef.current
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      displayName: users.displayName,
      avatarPath: users.avatarPath,
      created_at: users.created_at,
      disabled: users.disabled,
    })
    .from(users)
    .orderBy(asc(users.created_at));

  if (rows.length === 1 && rows[0].role !== 'admin') {
    rows[0].role = 'admin';
    await drizzleDbRef.current
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, rows[0].id));
  }

  return rows.map((r: any) => ({
    id: r.id,
    username: r.username,
    displayName: r.displayName,
    avatarPath: r.avatarPath,
    role: r.role as UserRole,
    created_at: r.created_at,
    disabled: !!r.disabled,
  }));
}

export async function verifyUserCredentials(
  username: string,
  password: string,
): Promise<AuthUser | undefined> {
  logger.debug({ username }, '[verifyUserCredentials] looking up username');
  const user = await getUserByUsername(username);
  logger.debug(
    { user: user ? { id: user.id, username: user.username } : null },
    '[verifyUserCredentials] user lookup result',
  );
  if (!user) return undefined;
  if (user.disabled) {
    logger.debug('[verifyUserCredentials] account disabled');
    return undefined;
  }
  const valid = verifyPassword(password, user.password_hash);
  logger.debug({ valid }, '[verifyUserCredentials] password check result');
  if (!valid) return undefined;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    avatarPath: user.avatarPath,
    created_at: user.created_at,
    disabled: false,
    tokenVersion: user.tokenVersion,
  };
}

export async function upsertProjectMember(
  user_id: string,
  project_id: string,
  access_level: ProjectAccessLevel,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(projectMembers)
    .values({
      user_id,
      project_id,
      access_level,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: [projectMembers.user_id, projectMembers.project_id],
      set: { access_level },
    });
  projectChanges.emit('changed');
}

/**
 * Add a membership row only when the user has none for the project. Unlike
 * `upsertProjectMember`, an existing access level is never changed.
 */
export async function insertProjectMemberIfMissing(
  user_id: string,
  project_id: string,
  access_level: ProjectAccessLevel,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(projectMembers)
    .values({
      user_id,
      project_id,
      access_level,
      created_at: now,
    })
    .onConflictDoNothing({
      target: [projectMembers.user_id, projectMembers.project_id],
    });
  projectChanges.emit('changed');
}

export async function getProjectMemberships(
  project_id: string,
): Promise<Array<{ user_id: string; access_level: ProjectAccessLevel }>> {
  const rows = await drizzleDbRef.current
    .select({
      user_id: projectMembers.user_id,
      access_level: projectMembers.access_level,
    })
    .from(projectMembers)
    .where(eq(projectMembers.project_id, project_id));

  return rows.map((r: any) => ({
    user_id: r.user_id,
    access_level: r.access_level as ProjectAccessLevel,
  }));
}

export async function getUserPreferences(
  user_id: string,
): Promise<string | null> {
  const rows = await drizzleDbRef.current
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, user_id))
    .limit(1);
  return rows[0]?.preferences ?? null;
}

export async function setUserPreferences(
  user_id: string,
  content: string | null,
): Promise<void> {
  await drizzleDbRef.current
    .update(users)
    .set({ preferences: content })
    .where(eq(users.id, user_id));
}
export async function updateUserProfile(
  user_id: string,
  profile: { displayName?: string | null; avatarPath?: string | null },
): Promise<AuthUser | undefined> {
  await drizzleDbRef.current
    .update(users)
    .set(profile)
    .where(eq(users.id, user_id));
  return getUserById(user_id);
}

export async function getUserDictationLanguage(
  user_id: string,
): Promise<string | null> {
  const rows = await drizzleDbRef.current
    .select({ dictationLanguage: users.dictationLanguage })
    .from(users)
    .where(eq(users.id, user_id))
    .limit(1);
  return rows[0]?.dictationLanguage ?? null;
}

export async function setUserDictationLanguage(
  user_id: string,
  dictationLanguage: string | null,
): Promise<void> {
  await drizzleDbRef.current
    .update(users)
    .set({ dictationLanguage })
    .where(eq(users.id, user_id));
}

export async function getMemberPreferences(
  user_id: string,
  project_id: string,
): Promise<string | null> {
  const rows = await drizzleDbRef.current
    .select({ preferences: projectMembers.preferences })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, project_id),
      ),
    )
    .limit(1);
  return rows[0]?.preferences ?? null;
}

type MemberPreferenceColumn = 'preferences' | 'mode' | 'push_enabled';

/**
 * Persist one per-member preference column without ever creating membership
 * for a caller who does not already have it.
 *   - existing member row: only the preference column is updated;
 *   - no row, caller owns the project (projects.user_id): an 'owner' row is
 *     created in the same statement that proves ownership;
 *   - otherwise (e.g. an admin on a foreign project): nothing is written.
 * Privileged access to a foreign project must never grant membership.
 */
export async function setMemberPreferenceColumn(
  user_id: string,
  project_id: string,
  column: MemberPreferenceColumn,
  value: string | number | null,
): Promise<void> {
  const updated = await drizzleDbRef.current
    .update(projectMembers)
    .set({ [column]: value })
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, project_id),
      ),
    )
    .returning();
  if (updated.length > 0) return;

  const col = sql.identifier(column);
  await drizzleDbRef.current.execute(sql`
    insert into project_members (
      user_id,
      project_id,
      access_level,
      created_at,
      ${col}
    )
    select ${user_id}, ${project_id}, 'owner', ${new Date().toISOString()}, ${value}
    from projects
    where id = ${project_id} and user_id = ${user_id}
    on conflict (user_id, project_id) do update set ${col} = excluded.${col}
  `);
}

export async function setMemberPreferences(
  user_id: string,
  project_id: string,
  content: string | null,
): Promise<void> {
  await setMemberPreferenceColumn(user_id, project_id, 'preferences', content);
  projectChanges.emit('changed');
}

export type ProjectMode = 'kanban' | 'chat' | 'objectives';

export async function getMemberMode(
  user_id: string,
  project_id: string,
): Promise<ProjectMode | null> {
  const rows = await drizzleDbRef.current
    .select({ mode: projectMembers.mode })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, project_id),
      ),
    )
    .limit(1);
  const value = rows[0]?.mode;
  if (value === 'kanban' || value === 'chat' || value === 'objectives')
    return value;
  return null;
}

export async function getMemberModesForUser(
  user_id: string,
): Promise<Record<string, ProjectMode>> {
  const rows = await drizzleDbRef.current
    .select({
      project_id: projectMembers.project_id,
      mode: projectMembers.mode,
    })
    .from(projectMembers)
    .where(eq(projectMembers.user_id, user_id));
  const out: Record<string, ProjectMode> = {};
  for (const r of rows) {
    const m = r.mode;
    if (m === 'kanban' || m === 'chat' || m === 'objectives') {
      out[String(r.project_id)] = m;
    }
  }
  return out;
}

export async function setMemberMode(
  user_id: string,
  project_id: string,
  mode: ProjectMode | null,
): Promise<void> {
  await setMemberPreferenceColumn(user_id, project_id, 'mode', mode);
  projectChanges.emit('changed');
}

export async function upsertKbMember(
  user_id: string,
  kb_id: string,
  access_level: ProjectAccessLevel,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(kbMembers)
    .values({
      user_id,
      kb_id,
      access_level,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: [kbMembers.user_id, kbMembers.kb_id],
      set: { access_level },
    });
}

export async function getProjectsForUser(user_id: string): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ project_id: projectMembers.project_id })
    .from(projectMembers)
    .where(eq(projectMembers.user_id, user_id));
  return rows.map((r: any) => String(r.project_id));
}

/**
 * Folders (among `folders`) a user may reach through a per-user main agent:
 * projects the user owns (`projects.user_id`) or is an explicit member of.
 * `readOnly` is true for viewer memberships. Another user's `is_main` project
 * is never reachable, even with a stray `project_members` row (same rule as
 * `getProjectAccess`). Implicit conversation-only access does not count.
 */
export async function getMainReachableProjects(
  user_id: string,
  folders: string[],
): Promise<Array<{ folder: string; readOnly: boolean }>> {
  if (folders.length === 0) return [];
  const projectRows = await drizzleDbRef.current
    .select({
      id: projects.id,
      user_id: projects.user_id,
      is_main: projects.is_main,
    })
    .from(projects)
    .where(inArray(projects.id, folders));
  const memberRows = await drizzleDbRef.current
    .select({
      project_id: projectMembers.project_id,
      access_level: projectMembers.access_level,
    })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        inArray(projectMembers.project_id, folders),
      ),
    );
  const levels = new Map<string, string>(
    memberRows.map((r: any) => [String(r.project_id), String(r.access_level)]),
  );

  const reachable: Array<{ folder: string; readOnly: boolean }> = [];
  for (const row of projectRows as any[]) {
    const ownerId: string | null = row.user_id ?? null;
    if (ownerId === user_id) {
      reachable.push({ folder: row.id, readOnly: false });
      continue;
    }
    if (row.is_main && ownerId) continue;
    const level = levels.get(row.id);
    if (level !== undefined) {
      reachable.push({ folder: row.id, readOnly: level === 'viewer' });
    }
  }
  return reachable;
}

export async function getKBsForUser(user_id: string): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ kb_id: kbMembers.kb_id })
    .from(kbMembers)
    .where(eq(kbMembers.user_id, user_id));
  return rows.map((r: any) => String(r.kb_id));
}

// ---------------------------------------------------------------------------
// Sharing — conversation members, ownership checks, and project-access kind
// ---------------------------------------------------------------------------

export interface UserSummary {
  id: string;
  username: string;
}

export interface MemberRow {
  user_id: string;
  username: string;
  access_level: ProjectAccessLevel;
}

export type ProjectAccessKind =
  | { kind: 'explicit'; level: ProjectAccessLevel }
  | { kind: 'implicit' }
  | null;

export async function searchUsersByUsername(
  prefix: string,
  limit = 10,
): Promise<UserSummary[]> {
  const trimmed = (prefix ?? '').trim();
  // Build query with optional WHERE before ORDER BY/LIMIT — Drizzle's chained
  // builders narrow the type after each call, so applying .where() to an
  // already-ordered query is a type error.
  const cap = Math.min(Math.max(1, limit), 50);
  const base = drizzleDbRef.current
    .select({ id: users.id, username: users.username })
    .from(users);
  const filtered = trimmed
    ? base.where(ilike(users.username, `${trimmed}%`))
    : base;
  const rows = await filtered.orderBy(asc(users.username)).limit(cap);
  return rows.map((r: any) => ({
    id: String(r.id),
    username: String(r.username),
  }));
}

export async function userIsProjectOwner(
  user_id: string,
  project_id: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ access_level: projectMembers.access_level })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, project_id),
      ),
    )
    .limit(1);
  return rows[0]?.access_level === 'owner';
}

/** Ordering of KB member levels; a level may do anything a lower rank may. */
export const KB_LEVEL_RANK: Record<ProjectAccessLevel, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};

export async function getKbAccessLevel(
  user_id: string,
  kb_id: string,
): Promise<ProjectAccessLevel | null> {
  const rows = await drizzleDbRef.current
    .select({ access_level: kbMembers.access_level })
    .from(kbMembers)
    .where(and(eq(kbMembers.user_id, user_id), eq(kbMembers.kb_id, kb_id)))
    .limit(1);
  return rows[0] ? (rows[0].access_level as ProjectAccessLevel) : null;
}

/** True when some user holds the owner level on the KB. */
export async function kbHasOwner(kb_id: string): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ user_id: kbMembers.user_id })
    .from(kbMembers)
    .where(and(eq(kbMembers.kb_id, kb_id), eq(kbMembers.access_level, 'owner')))
    .limit(1);
  return rows.length > 0;
}

/**
 * True when `user` is a board admin who skips KB membership for `kb_id`: only
 * a KB without an owner member. On a KB with an owner an admin has just their
 * membership level, like any user.
 */
export async function adminBypassesKb(
  user: { role?: string },
  kb_id: string,
): Promise<boolean> {
  return user.role === 'admin' && !(await kbHasOwner(kb_id));
}

/**
 * The ids among `kbIds` a signed-in user may reach: their memberships, plus for
 * an admin the KBs without an owner member.
 */
export async function getReachableKbIds(
  user: { id: string; role?: string },
  kbIds: string[],
): Promise<Set<string>> {
  const member = new Set(await getKBsForUser(user.id));
  let owned: Set<string> | null = null;
  if (user.role === 'admin') {
    const rows = await drizzleDbRef.current
      .select({ kb_id: kbMembers.kb_id })
      .from(kbMembers)
      .where(eq(kbMembers.access_level, 'owner'));
    owned = new Set(rows.map((r: any) => String(r.kb_id)));
  }
  return new Set(
    kbIds.filter((id) => member.has(id) || (owned !== null && !owned.has(id))),
  );
}

export async function userIsKbOwner(
  user_id: string,
  kb_id: string,
): Promise<boolean> {
  return (await getKbAccessLevel(user_id, kb_id)) === 'owner';
}

export async function userIsConversationOwner(
  user_id: string,
  conversation_id: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ access_level: conversationMembers.access_level })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.user_id, user_id),
        eq(conversationMembers.conversation_id, conversation_id),
      ),
    )
    .limit(1);
  return rows[0]?.access_level === 'owner';
}

export async function upsertConversationMember(
  user_id: string,
  conversation_id: string,
  access_level: ProjectAccessLevel,
): Promise<void> {
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .insert(conversationMembers)
    .values({ user_id, conversation_id, access_level, created_at: now })
    .onConflictDoUpdate({
      target: [
        conversationMembers.user_id,
        conversationMembers.conversation_id,
      ],
      set: { access_level },
    });
  projectChanges.emit('changed');
}

export async function removeConversationMember(
  user_id: string,
  conversation_id: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.user_id, user_id),
        eq(conversationMembers.conversation_id, conversation_id),
      ),
    );
  projectChanges.emit('changed');
}

export async function getConversationMembers(
  conversation_id: string,
): Promise<MemberRow[]> {
  const rows = await drizzleDbRef.current
    .select({
      user_id: conversationMembers.user_id,
      username: users.username,
      access_level: conversationMembers.access_level,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.user_id))
    .where(
      and(
        eq(conversationMembers.conversation_id, conversation_id),
        eq(users.disabled, 0),
      ),
    )
    .orderBy(asc(users.username));
  return rows.map((r: any) => ({
    user_id: String(r.user_id),
    username: String(r.username),
    access_level: r.access_level as ProjectAccessLevel,
  }));
}

export async function getProjectMembersDetailed(
  project_id: string,
): Promise<MemberRow[]> {
  const [rows, ownerRows] = await Promise.all([
    drizzleDbRef.current
      .select({
        user_id: projectMembers.user_id,
        username: users.username,
        access_level: projectMembers.access_level,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.user_id))
      .where(
        and(eq(projectMembers.project_id, project_id), eq(users.disabled, 0)),
      ),
    drizzleDbRef.current
      .select({ user_id: users.id, username: users.username })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.user_id))
      .where(and(eq(projects.id, project_id), eq(users.disabled, 0)))
      .limit(1),
  ]);
  const byUserId = new Map<string, MemberRow>();
  for (const row of rows) {
    byUserId.set(String(row.user_id), {
      user_id: String(row.user_id),
      username: String(row.username),
      access_level: row.access_level as ProjectAccessLevel,
    });
  }
  const owner = ownerRows[0];
  if (owner) {
    byUserId.set(String(owner.user_id), {
      user_id: String(owner.user_id),
      username: String(owner.username),
      access_level: 'owner',
    });
  }
  return [...byUserId.values()].sort((a, b) =>
    a.username.localeCompare(b.username),
  );
}

/**
 * The user who owns a project: `projects.user_id`, or for projects created
 * without it (UI-created ones record their creator only as an `owner` member)
 * the earliest `owner` member. An enabled user is preferred; a disabled owner
 * is returned only when no enabled one exists, so callers can report it. This
 * is a candidate, not an authorization: callers must still check membership.
 */
export async function getProjectOwnerUserId(
  project_id: string,
): Promise<string | null> {
  const [owner] = await drizzleDbRef.current
    .select({ user_id: users.id, disabled: users.disabled })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .where(eq(projects.id, project_id))
    .limit(1);
  if (owner && owner.disabled === 0) return String(owner.user_id);
  const [member] = await drizzleDbRef.current
    .select({ user_id: projectMembers.user_id })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.user_id))
    .where(
      and(
        eq(projectMembers.project_id, project_id),
        eq(projectMembers.access_level, 'owner'),
      ),
    )
    .orderBy(
      asc(users.disabled),
      asc(projectMembers.created_at),
      asc(projectMembers.user_id),
    )
    .limit(1);
  if (member) return String(member.user_id);
  return owner ? String(owner.user_id) : null;
}

export async function getKbMembersDetailed(
  kb_id: string,
): Promise<MemberRow[]> {
  const rows = await drizzleDbRef.current
    .select({
      user_id: kbMembers.user_id,
      username: users.username,
      access_level: kbMembers.access_level,
    })
    .from(kbMembers)
    .innerJoin(users, eq(users.id, kbMembers.user_id))
    .where(and(eq(kbMembers.kb_id, kb_id)))
    .orderBy(asc(users.username));
  return rows.map((r: any) => ({
    user_id: String(r.user_id),
    username: String(r.username),
    access_level: r.access_level as ProjectAccessLevel,
  }));
}

export async function removeProjectMember(
  user_id: string,
  project_id: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, project_id),
      ),
    );
  projectChanges.emit('changed');
}

export async function removeKbMember(
  user_id: string,
  kb_id: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(kbMembers)
    .where(and(eq(kbMembers.user_id, user_id), eq(kbMembers.kb_id, kb_id)));
}

/**
 * Returns the user's access to a project. Explicit = row in project_members;
 * implicit = at least one shared conversation under the project. null = no access.
 */
export async function getProjectAccess(
  user_id: string,
  project_id: string,
): Promise<ProjectAccessKind> {
  // Project rows carry an owner (projects.user_id). For `is_main` projects we
  // treat ownership as the *only* admission path — stray project_members rows
  // on someone else's personal main group must not grant access.
  const proj = await drizzleDbRef.current
    .select({ user_id: projects.user_id, is_main: projects.is_main })
    .from(projects)
    .where(eq(projects.id, project_id))
    .limit(1);
  const ownerId = proj[0]?.user_id ?? null;
  const isMain = !!proj[0]?.is_main;

  if (ownerId && ownerId === user_id) {
    return { kind: 'explicit', level: 'owner' };
  }
  if (isMain && ownerId && ownerId !== user_id) {
    return null;
  }

  const explicit = await drizzleDbRef.current
    .select({ access_level: projectMembers.access_level })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, project_id),
      ),
    )
    .limit(1);
  if (explicit[0]) {
    return {
      kind: 'explicit',
      level: explicit[0].access_level as ProjectAccessLevel,
    };
  }

  const implicit = await drizzleDbRef.current
    .select({ id: conversationMembers.conversation_id })
    .from(conversationMembers)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationMembers.conversation_id),
    )
    .where(
      and(
        eq(conversationMembers.user_id, user_id),
        eq(conversations.group_folder, project_id),
      ),
    )
    .limit(1);
  if (implicit.length > 0) return { kind: 'implicit' };

  return null;
}

/**
 * Whether `user_id` may see a live recording transcript of `conversation_id`
 * recorded under `project_id`: one statement, so the conversation's project,
 * the project's owner, the user's role and the user's grants come from a single
 * snapshot. False for a disabled account, and when the conversation is gone or
 * no longer sits in
 * `project_id` (rename, reused folder). Mirrors `getProjectAccess` plus the
 * admin rule: the owner may; nobody else may see a personal main; an admin may
 * see a project no other user owns; otherwise an explicit membership, or a
 * share of this very conversation, is required.
 */
export async function canReceiveRecordingTranscript(
  user_id: string,
  conversation_id: string,
  project_id: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({
      owner: projects.user_id,
      isMain: projects.is_main,
      role: sql<
        string | null
      >`(select ${users.role} from ${users} where ${users.id} = ${user_id})`,
      disabled: sql<
        number | boolean | null
      >`(select ${users.disabled} from ${users} where ${users.id} = ${user_id})`,
      member: sql<boolean>`exists (select 1 from ${projectMembers} where ${projectMembers.project_id} = ${projects.id} and ${projectMembers.user_id} = ${user_id})`,
      shared: sql<boolean>`exists (select 1 from ${conversationMembers} where ${conversationMembers.conversation_id} = ${conversations.id} and ${conversationMembers.user_id} = ${user_id})`,
    })
    .from(conversations)
    .innerJoin(projects, eq(projects.id, conversations.group_folder))
    .where(
      and(
        eq(conversations.id, conversation_id),
        eq(conversations.group_folder, project_id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.disabled) return false;
  if (row.owner === user_id) return true;
  if (row.isMain) return false;
  if (row.role === 'admin' && !row.owner) return true;
  return !!row.member || !!row.shared;
}

/**
 * Returns the user's access level on a specific conversation.
 * Falls through to the parent project's explicit access (project members
 * always have full chat access). null = no access.
 */
/** Access from an explicit `conversation_members` row only; no project inheritance. */
export async function getDirectConversationAccess(
  user_id: string,
  conversation_id: string,
): Promise<ProjectAccessLevel | null> {
  const direct = await drizzleDbRef.current
    .select({ access_level: conversationMembers.access_level })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.user_id, user_id),
        eq(conversationMembers.conversation_id, conversation_id),
      ),
    )
    .limit(1);
  return (direct[0]?.access_level as ProjectAccessLevel) ?? null;
}

export async function userCanAccessConversation(
  user_id: string,
  conversation_id: string,
): Promise<ProjectAccessLevel | null> {
  const conv = await drizzleDbRef.current
    .select({
      group_folder: conversations.group_folder,
      is_main: projects.is_main,
      owner_id: projects.user_id,
    })
    .from(conversations)
    .leftJoin(projects, eq(projects.id, conversations.group_folder))
    .where(eq(conversations.id, conversation_id))
    .limit(1);
  const folder = conv[0]?.group_folder;
  if (!folder) return null;

  // A registered personal main admits only its owner, regardless of stray
  // conversation or project membership rows.
  if (conv[0].is_main && conv[0].owner_id) {
    return conv[0].owner_id === user_id ? 'owner' : null;
  }

  const direct = await getDirectConversationAccess(user_id, conversation_id);
  if (direct) return direct;

  const project = await drizzleDbRef.current
    .select({ access_level: projectMembers.access_level })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.user_id, user_id),
        eq(projectMembers.project_id, folder),
      ),
    )
    .limit(1);
  return (project[0]?.access_level as ProjectAccessLevel) ?? null;
}

/**
 * The rule for posting into an existing conversation: admins except in a
 * project owned by another user, otherwise `editor` or `owner` access on that
 * conversation.
 */
export async function userMayPostInConversation(
  user_id: string,
  conversation_id: string,
): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ role: users.role, group_folder: conversations.group_folder })
    .from(users)
    .leftJoin(conversations, eq(conversations.id, conversation_id))
    .where(eq(users.id, user_id))
    .limit(1);
  if (
    rows[0]?.role === 'admin' &&
    (!rows[0].group_folder ||
      adminBypassesProject(
        { id: user_id, role: 'admin' },
        rows[0].group_folder,
      ))
  )
    return true;
  const level = await userCanAccessConversation(user_id, conversation_id);
  return level === 'editor' || level === 'owner';
}

/**
 * Returns the conversation IDs a user has implicit access to under a project.
 * Used to filter conversation lists for users without explicit project access.
 */
export async function getSharedConversationIds(
  user_id: string,
  project_id: string,
): Promise<string[]> {
  const rows = await drizzleDbRef.current
    .select({ id: conversationMembers.conversation_id })
    .from(conversationMembers)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationMembers.conversation_id),
    )
    .where(
      and(
        eq(conversationMembers.user_id, user_id),
        eq(conversations.group_folder, project_id),
      ),
    );
  return rows.map((r: any) => String(r.id));
}

/**
 * Returns project IDs a user has *implicit* (chat-shared) access to but is not
 * an explicit member of. For surfacing under "Shared with me" alongside
 * explicit shared projects.
 */
export async function getImplicitProjectIdsForUser(
  user_id: string,
): Promise<string[]> {
  const explicit = await drizzleDbRef.current
    .select({ project_id: projectMembers.project_id })
    .from(projectMembers)
    .where(eq(projectMembers.user_id, user_id));
  const explicitSet = new Set(explicit.map((r: any) => String(r.project_id)));

  const implicit = await drizzleDbRef.current
    .selectDistinct({ folder: conversations.group_folder })
    .from(conversationMembers)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationMembers.conversation_id),
    )
    .where(eq(conversationMembers.user_id, user_id));

  return implicit
    .map((r: any) => String(r.folder))
    .filter((f: string) => !explicitSet.has(f));
}

// ---------------------------------------------------------------------------
// Admin user management — role/password/disabled updates and cascading delete
// ---------------------------------------------------------------------------

/** Thrown when a change would leave the install without an active admin. */
export class LastAdminError extends Error {
  constructor() {
    super('Cannot remove the last remaining active admin');
    this.name = 'LastAdminError';
  }
}

/** Drizzle transaction handle, as passed to `transaction()` callbacks. */
type AdminTx = Parameters<
  Parameters<(typeof drizzleDbRef.current)['transaction']>[0]
>[0];

/**
 * Serializes every change to the set of active admins. The lock is held until
 * the surrounding transaction ends, so a later holder counts the admins after
 * an earlier one committed.
 */
async function lockAdminSet(tx: AdminTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('admin-set'))`);
}

/** Throws `LastAdminError` when `id` is the only active admin. */
async function assertNotLastActiveAdmin(
  tx: AdminTx,
  id: string,
): Promise<void> {
  const [row] = await tx
    .select({ role: users.role, disabled: users.disabled })
    .from(users)
    .where(eq(users.id, id));
  if (!row || row.role !== 'admin' || row.disabled) return;
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.disabled, 0)));
  if (admins.length <= 1) throw new LastAdminError();
}

/**
 * Applies a role and/or disabled change. A change that takes the user out of
 * the active admins is refused with `LastAdminError` when no other active
 * admin remains; the check and the update run under one lock.
 */
export async function updateUserAdminStanding(
  id: string,
  change: { role?: UserRole; disabled?: boolean },
): Promise<void> {
  const set: { role?: UserRole; disabled?: number } = {};
  if (change.role !== undefined) set.role = change.role;
  if (change.disabled !== undefined) set.disabled = change.disabled ? 1 : 0;
  if (Object.keys(set).length === 0) return;
  const losesAdmin =
    (change.role !== undefined && change.role !== 'admin') ||
    change.disabled === true;
  await drizzleDbRef.current.transaction(async (tx) => {
    if (losesAdmin) {
      await lockAdminSet(tx);
      await assertNotLastActiveAdmin(tx, id);
    }
    await tx.update(users).set(set).where(eq(users.id, id));
  });
}

/** Sets the password and bumps `token_version`, which ends every session JWT
 *  issued before the change. Returns the new version, so a caller changing its
 *  own password can re-issue its session. */
export async function updateUserPassword(
  id: string,
  plain: string,
): Promise<number | undefined> {
  const password_hash = hashPassword(plain);
  const [row] = await drizzleDbRef.current
    .update(users)
    .set({ password_hash, token_version: sql`${users.token_version} + 1` })
    .where(eq(users.id, id))
    .returning();
  return row?.token_version;
}

/**
 * Counts admins that are still active (not disabled). Used to enforce
 * "cannot delete/demote/disable the last remaining admin".
 */
export async function countActiveAdmins(): Promise<number> {
  const rows = await drizzleDbRef.current
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.disabled, 0)));
  return rows.length;
}

/** Grants `revokeProjectAccess` removed, so a rollback can restore them. */
export interface RevokedProjectAccess {
  projectMembers: Array<typeof projectMembers.$inferSelect>;
  conversationMembers: Array<typeof conversationMembers.$inferSelect>;
  publicShareConversationIds: string[];
}

/**
 * Remove every way for someone else to open a project's conversations: project
 * and conversation memberships, and live public share links. The conversations
 * and their transcripts stay. Used when a personal main is archived.
 */
export async function revokeProjectAccess(
  projectId: string,
): Promise<RevokedProjectAccess> {
  return drizzleDbRef.current.transaction(async (tx) => {
    const conversationIds = (
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.group_folder, projectId))
    ).map((row) => row.id);
    const revoked: RevokedProjectAccess = {
      projectMembers: await tx
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.project_id, projectId)),
      conversationMembers: [],
      publicShareConversationIds: [],
    };
    await tx
      .delete(projectMembers)
      .where(eq(projectMembers.project_id, projectId));
    if (conversationIds.length === 0) return revoked;
    revoked.conversationMembers = await tx
      .select()
      .from(conversationMembers)
      .where(inArray(conversationMembers.conversation_id, conversationIds));
    await tx
      .delete(conversationMembers)
      .where(inArray(conversationMembers.conversation_id, conversationIds));
    const live = await tx
      .update(conversationPublicShares)
      .set({ revokedAt: new Date().toISOString() })
      .where(
        and(
          inArray(conversationPublicShares.conversationId, conversationIds),
          isNull(conversationPublicShares.revokedAt),
        ),
      )
      .returning();
    revoked.publicShareConversationIds = live.map((row) => row.conversationId);
    return revoked;
  });
}

export async function restoreProjectAccess(
  revoked: RevokedProjectAccess,
): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    if (revoked.projectMembers.length > 0) {
      await tx
        .insert(projectMembers)
        .values(revoked.projectMembers)
        .onConflictDoNothing();
    }
    if (revoked.conversationMembers.length > 0) {
      await tx
        .insert(conversationMembers)
        .values(revoked.conversationMembers)
        .onConflictDoNothing();
    }
    if (revoked.publicShareConversationIds.length > 0) {
      await tx
        .update(conversationPublicShares)
        .set({ revokedAt: null })
        .where(
          inArray(
            conversationPublicShares.conversationId,
            revoked.publicShareConversationIds,
          ),
        );
    }
  });
}

/** Folder of the personal main project owned by `userId`, if any. */
export async function getUserMainFolder(
  userId: string,
): Promise<string | undefined> {
  const [row] = await drizzleDbRef.current
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.user_id, userId), eq(projects.is_main, 1)))
    .limit(1);
  return row?.id;
}

/**
 * Hard-delete a user and cascade-remove their membership/device rows. Projects
 * created by the user are left intact (their `user_id` will dangle).
 */
export async function deleteUser(id: string): Promise<void> {
  await drizzleDbRef.current.transaction(async (tx) => {
    await lockAdminSet(tx);
    await assertNotLastActiveAdmin(tx, id);
    await tx.delete(projectMembers).where(eq(projectMembers.user_id, id));
    await tx.delete(kbMembers).where(eq(kbMembers.user_id, id));
    await tx
      .delete(conversationMembers)
      .where(eq(conversationMembers.user_id, id));
    await tx.delete(deviceKeys).where(eq(deviceKeys.user_id, id));
    await tx.delete(users).where(eq(users.id, id));
  });
  projectChanges.emit('changed');
}

/** True when a project row with this id exists. */
export async function projectRowExists(id: string): Promise<boolean> {
  const rows = await drizzleDbRef.current
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return rows.length > 0;
}
