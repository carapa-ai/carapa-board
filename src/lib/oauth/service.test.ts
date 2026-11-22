/**
 * Scope an OAuth grant confers: exactly the stored project list, each folder
 * limited to the user's current access; no implicit children or memory sources.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projectMembers, projects, users } from '../../db/schema.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import {
  buildOAuthTokenScope,
  listGrantableTargets,
  type OAuthGrantTargetEntry,
} from './service.js';

const now = () => new Date().toISOString();
const PARENT = 'oscope-parent';
const OWNED = 'oscope-child-owned';
const VIEWED = 'oscope-child-viewed';
const HIDDEN = 'oscope-child-hidden';
const MEMORY = 'oscope-memory-source';
const SOLO = 'oscope-solo';
const OWNERLESS = 'oscope-ownerless';
const MAIN = 'main-oscope-alice';
const ALICE = { id: 'oscope-alice', username: 'oscope-alice', role: 'user' };

const rows: Array<[string, string | undefined]> = [
  [PARENT, ALICE.id],
  [OWNED, ALICE.id],
  [VIEWED, 'oscope-bob'],
  [HIDDEN, 'oscope-bob'],
  [MEMORY, ALICE.id],
  [SOLO, ALICE.id],
  [OWNERLESS, undefined],
  [MAIN, ALICE.id],
];

const grant = (...targets: OAuthGrantTargetEntry[]) => ({ targets });
const project = (
  folder: string,
  access: 'read' | 'write',
): OAuthGrantTargetEntry => ({ kind: 'project', folder, access });

const readOnly = (perms: string[]) =>
  perms.every((p) => p.endsWith(':read') || p === 'agent:delegate');

beforeAll(async () => {
  await initDatabase(':memory:');
  const db = drizzleDbRef.current;
  for (const username of [ALICE.username, 'oscope-bob']) {
    await db.insert(users).values({
      id: username,
      username,
      password_hash: 'unused',
      role: 'user',
      created_at: now(),
      disabled: 0,
    });
  }
  for (const [folder, owner] of rows) {
    await db.insert(projects).values({
      id: folder,
      jid: `${folder}@oscope`,
      name: folder,
      folder,
      trigger: '!',
      added_at: now(),
      is_main: folder === MAIN ? 1 : 0,
      user_id: owner ?? null,
    });
  }
  await db.insert(projectMembers).values({
    user_id: ALICE.id,
    project_id: VIEWED,
    access_level: 'viewer',
    created_at: now(),
  });
  await loadState();
  for (const [folder, owner] of rows) {
    await registerGroup(`${folder}@oscope`, {
      name: folder,
      folder,
      jid: `${folder}@oscope`,
      trigger: '!',
      added_at: now(),
      user_id: owner,
      ...(folder === MAIN ? { is_main: true } : {}),
      ...(folder === PARENT
        ? { settings: { isParent: true, memorySourceProjects: [MEMORY] } }
        : {}),
      ...([OWNED, VIEWED, HIDDEN].includes(folder) ? { parentId: PARENT } : {}),
    });
  }
});

afterAll(async () => {
  for (const [folder] of rows) await unregisterGroup(`${folder}@oscope`);
});

describe('buildOAuthTokenScope for an explicit project list', () => {
  test('covers exactly the listed folders, narrowed per folder', async () => {
    const scope = await buildOAuthTokenScope(
      grant(
        project(PARENT, 'write'),
        project(OWNED, 'write'),
        project(VIEWED, 'write'),
      ),
      ALICE,
    );
    expect(scope?.group_folder).toBe(PARENT);
    expect(scope?.oauth_access).toBe('write');
    const perms = scope?.permissions ?? {};
    expect(Object.keys(perms).sort()).toEqual([OWNED, PARENT, VIEWED].sort());
    expect(perms[OWNED]).toContain('tasks:*');
    // Viewer membership narrows the requested write to read for that folder.
    expect(perms[VIEWED]).not.toContain('tasks:*');
    expect(readOnly(perms[VIEWED])).toBe(true);
  });

  test('a parent does not bring its children or memory sources', async () => {
    const scope = await buildOAuthTokenScope(
      grant(project(PARENT, 'write')),
      ALICE,
    );
    expect(Object.keys(scope?.permissions ?? {})).toEqual([PARENT]);
  });

  test('each folder keeps its own access level', async () => {
    const scope = await buildOAuthTokenScope(
      grant(project(SOLO, 'read'), project(OWNED, 'write')),
      ALICE,
    );
    const perms = scope?.permissions ?? {};
    expect(readOnly(perms[SOLO])).toBe(true);
    expect(perms[OWNED]).toContain('tasks:*');
    expect(scope?.oauth_access).toBe('write');
  });

  test('an all-read grant is read-only everywhere', async () => {
    const scope = await buildOAuthTokenScope(
      grant(project(PARENT, 'read'), project(OWNED, 'read')),
      ALICE,
    );
    expect(scope?.oauth_access).toBe('read');
    for (const entry of Object.values(scope?.permissions ?? {})) {
      expect(readOnly(entry)).toBe(true);
    }
  });

  test('drops folders the user cannot reach and fails closed when none remain', async () => {
    const mixed = await buildOAuthTokenScope(
      grant(
        project(HIDDEN, 'write'),
        project('oscope-missing', 'read'),
        project(OWNED, 'write'),
      ),
      ALICE,
    );
    expect(Object.keys(mixed?.permissions ?? {})).toEqual([OWNED]);
    expect(mixed?.group_folder).toBe(OWNED);
    expect(
      await buildOAuthTokenScope(
        grant(project(HIDDEN, 'write'), project('oscope-missing', 'read')),
        ALICE,
      ),
    ).toBeNull();
  });

  test('a user demoted to viewer narrows the whole grant to read', async () => {
    const scope = await buildOAuthTokenScope(
      grant(project(VIEWED, 'write')),
      ALICE,
    );
    expect(scope?.oauth_access).toBe('read');
  });

  test('a main entry covers the main workspace and reachable projects', async () => {
    const scope = await buildOAuthTokenScope(
      grant({ kind: 'main', folder: MAIN, access: 'write' }),
      ALICE,
    );
    expect(scope?.group_folder).toBe(MAIN);
    const perms = scope?.permissions ?? {};
    expect(Object.keys(perms)).toContain(MAIN);
    expect(perms[OWNED]).toContain('tasks:*');
    expect(readOnly(perms[VIEWED])).toBe(true);
    expect(perms[HIDDEN]).toBeUndefined();
    expect(perms['*']).toBeUndefined();
  });

  test('the home folder is the first selected entry even when it is read-only', async () => {
    const scope = await buildOAuthTokenScope(
      grant(project(SOLO, 'read'), project(OWNED, 'write')),
      ALICE,
    );
    expect(scope?.group_folder).toBe(SOLO);
    expect(readOnly(scope?.permissions?.[SOLO] ?? [])).toBe(true);
    expect(scope?.permissions?.[OWNED]).toContain('tasks:*');
  });

  test('a read-only project restricts a read/write main entry', async () => {
    const scope = await buildOAuthTokenScope(
      grant(
        { kind: 'main', folder: MAIN, access: 'write' },
        project(OWNED, 'read'),
      ),
      ALICE,
    );
    const perms = scope?.permissions ?? {};
    expect(readOnly(perms[OWNED])).toBe(true);
    // Other reachable projects keep the main entry's access.
    expect(perms[SOLO]).toContain('tasks:*');
  });

  test('a writable project listed beside a read-only main is writable', async () => {
    const scope = await buildOAuthTokenScope(
      grant(
        { kind: 'main', folder: MAIN, access: 'read' },
        project(OWNED, 'write'),
      ),
      ALICE,
    );
    const perms = scope?.permissions ?? {};
    expect(perms[OWNED]).toContain('tasks:*');
    expect(readOnly(perms[SOLO])).toBe(true);
    expect(scope?.group_folder).toBe(MAIN);
  });
});

describe('listGrantableTargets', () => {
  test('a member sees main plus reachable projects, viewer-only marked', async () => {
    const targets = await listGrantableTargets(ALICE);
    const folders = targets.map((t) => t.folder);
    expect(folders).toContain(MAIN);
    expect(folders).toContain(OWNED);
    expect(folders).not.toContain(HIDDEN);
    expect(targets.find((t) => t.folder === VIEWED)?.canWrite).toBe(false);
    expect(targets.find((t) => t.folder === OWNED)).toMatchObject({
      parentId: PARENT,
      canWrite: true,
    });
  });

  test('an admin bypasses membership only for ownerless or own projects', async () => {
    const admin = { ...ALICE, role: 'admin' };
    const targets = await listGrantableTargets(admin);
    const byFolder = new Map(targets.map((t) => [t.folder, t]));
    expect(byFolder.has(HIDDEN)).toBe(false);
    expect(byFolder.get(OWNERLESS)?.canWrite).toBe(true);
    expect(byFolder.get(OWNED)?.canWrite).toBe(true);
    expect(byFolder.get(VIEWED)?.canWrite).toBe(false);
    const scope = await buildOAuthTokenScope(
      grant(project(HIDDEN, 'write'), project(VIEWED, 'write')),
      admin,
    );
    expect(scope?.permissions?.[HIDDEN]).toBeUndefined();
    expect(scope?.oauth_access).toBe('read');
    expect(readOnly(scope?.permissions?.[VIEWED] ?? [])).toBe(true);
  });
});
