import { beforeAll, describe, expect, test } from 'bun:test';
import {
  getAgentPermissions,
  getAgentPermissionsResolved,
  hasPermission,
  resolveMainReachableFolders,
} from './auth.js';
import { verifyToken } from './auth-tokens.js';
import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { projectMembers, projects, users } from '../db/schema.js';
import { mintRunScopedAgentToken } from '../sandbox/process.js';
import type { RegisteredGroup } from '../types.js';
import { resolveRecallGroupFolders } from '../modules/memory/backend/scope.js';

function group(
  folder: string,
  parentId?: string,
  settings: RegisteredGroup['settings'] = {},
): RegisteredGroup {
  return {
    name: folder,
    folder,
    parentId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings,
  };
}

test('memory sources grant recall access to the selected projects only', () => {
  const app = group('app', undefined, {
    memorySourceProjects: ['demo-app', 'other-framework'],
  });
  const framework = group('demo-app');
  const child = group('demo-app-child', 'demo-app');
  const grandchild = group('demo-app-grandchild', 'demo-app-child');
  const other = group('other-framework');
  const unrelated = group('unrelated');
  const permissions = getAgentPermissions(app, {
    app,
    framework,
    child,
    grandchild,
    other,
    unrelated,
  });

  for (const folder of ['app', 'demo-app', 'other-framework']) {
    expect(hasPermission(permissions, folder, 'memories:read')).toBe(true);
  }
  expect(hasPermission(permissions, 'demo-app', 'memories:write')).toBe(false);
  expect(hasPermission(permissions, 'demo-app-child', 'memories:read')).toBe(
    false,
  );
  expect(
    hasPermission(permissions, 'demo-app-grandchild', 'memories:read'),
  ).toBe(false);
  expect(hasPermission(permissions, 'unrelated', 'memories:read')).toBe(false);
  expect(hasPermission(permissions, 'app', 'memories:write')).toBe(true);
  expect(resolveRecallGroupFolders(permissions).sort()).toEqual([
    'app',
    'demo-app',
    'other-framework',
  ]);
});

test('memory sources preserve existing parent access to a child', () => {
  const framework = group('framework', undefined, {
    isParent: true,
    memorySourceProjects: ['framework-child'],
  });
  const child = group('framework-child', 'framework');
  const permissions = getAgentPermissions(framework, { framework, child });

  expect(hasPermission(permissions, 'framework-child', 'tasks:write')).toBe(
    true,
  );
  expect(
    hasPermission(permissions, 'framework-child', 'project_setup:write'),
  ).toBe(true);
});

test('project agents can configure only their own setup surface', () => {
  const app = group('app');
  const other = group('other');
  const permissions = getAgentPermissions(app, { app, other });

  expect(hasPermission(permissions, 'app', 'project_setup:read')).toBe(true);
  expect(hasPermission(permissions, 'app', 'project_setup:write')).toBe(true);
  expect(hasPermission(permissions, 'other', 'project_setup:read')).toBe(false);
  expect(hasPermission(permissions, 'other', 'project_setup:write')).toBe(
    false,
  );
});

test('sandbox:restart is granted to the own folder and to a parent for its children', () => {
  const app = group('app');
  const parent = group('parent', undefined, { isParent: true });
  const child = group('child', 'parent');
  const groups = { app, parent, child };

  expect(
    hasPermission(getAgentPermissions(app, groups), 'app', 'sandbox:restart'),
  ).toBe(true);
  const parentPerms = getAgentPermissions(parent, groups);
  expect(hasPermission(parentPerms, 'child', 'sandbox:restart')).toBe(true);
  expect(hasPermission(parentPerms, 'app', 'sandbox:restart')).toBe(false);
});

test('parent projects can recall from an exact linked memory source', () => {
  const parent = group('parent', undefined, {
    isParent: true,
    memorySourceProjects: ['related'],
  });
  const child = group('child', 'parent');
  const related = group('related');
  const relatedChild = group('related-child', 'related');
  const permissions = getAgentPermissions(parent, {
    parent,
    child,
    related,
    relatedChild,
  });

  expect(hasPermission(permissions, 'child', 'memories:write')).toBe(true);
  expect(hasPermission(permissions, 'related', 'memories:read')).toBe(true);
  expect(hasPermission(permissions, 'related', 'memories:write')).toBe(false);
  expect(hasPermission(permissions, 'related-child', 'memories:read')).toBe(
    false,
  );
});

describe('per-user main reach', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  const id = (name: string) => `${name}-${RUN}`;
  const userIds = {
    alice: id('u-alice'),
    admin: id('u-admin'),
    bob: id('u-bob'),
  };
  const ownFolder = (user: string) => `main-${user}-${RUN}`;
  const folders = {
    a: id('proj-a'),
    b: id('proj-b'),
    v: id('proj-v'),
    c: id('proj-c'),
    bobMain: ownFolder('bob'),
  };

  function perUserMain(userId: string, folder: string): RegisteredGroup {
    return { ...group(folder), is_main: true, user_id: userId };
  }
  const allGroups: Record<string, RegisteredGroup> = {};
  for (const folder of [
    ...Object.values(folders),
    ownFolder('alice'),
    ownFolder('admin'),
  ]) {
    allGroups[folder] = group(folder);
  }

  beforeAll(async () => {
    await initDatabase(':memory:');
    const db = drizzleDbRef.current;
    const now = new Date().toISOString();
    for (const [name, userId] of Object.entries(userIds)) {
      await db.insert(users).values({
        id: userId,
        username: `${name}-${RUN}`,
        password_hash: 'x',
        role: name === 'admin' ? 'admin' : 'user',
        created_at: now,
      } as any);
    }
    const project = (folder: string, owner: string | null, isMain = 0) =>
      db.insert(projects).values({
        id: folder,
        jid: folder,
        name: folder,
        folder,
        trigger: '!',
        added_at: now,
        is_main: isMain,
        user_id: owner,
      });
    await project(ownFolder('alice'), userIds.alice, 1);
    await project(ownFolder('admin'), userIds.admin, 1);
    await project(folders.bobMain, userIds.bob, 1);
    await project(folders.a, userIds.alice);
    await project(folders.b, userIds.bob);
    await project(folders.v, userIds.bob);
    await project(folders.c, userIds.bob);
    const member = (user: string, folder: string, level: string) =>
      db.insert(projectMembers).values({
        user_id: user,
        project_id: folder,
        access_level: level,
        created_at: now,
      });
    await member(userIds.alice, folders.b, 'editor');
    await member(userIds.alice, folders.v, 'viewer');
    await member(userIds.alice, folders.bobMain, 'editor'); // stray row
    await member(userIds.admin, folders.b, 'editor');
    await member(userIds.admin, folders.v, 'viewer');
  });

  function expectScoped(p: Record<string, string[]>) {
    expect(hasPermission(p, folders.b, 'tasks:write')).toBe(true);
    expect(hasPermission(p, folders.v, 'tasks:read')).toBe(true);
    expect(hasPermission(p, folders.v, 'tasks:write')).toBe(false);
    expect(hasPermission(p, folders.v, 'groups:read')).toBe(true);
    expect(hasPermission(p, folders.c, 'tasks:write')).toBe(false);
    expect(hasPermission(p, folders.bobMain, 'tasks:read')).toBe(false);
    expect(hasPermission(p, '*', '*:*')).toBe(false);
    expect(p['*']).toBeUndefined();
  }

  test('per-user main reaches owned and member projects with viewer read-only', async () => {
    const main = perUserMain(userIds.alice, ownFolder('alice'));
    const p = await getAgentPermissionsResolved(main, allGroups);
    expect(hasPermission(p, ownFolder('alice'), 'stages:write')).toBe(true);
    expect(hasPermission(p, folders.a, 'tasks:write')).toBe(true);
    expectScoped(p);
  });

  test('per-user main of an admin user is scoped the same way', async () => {
    const main = perUserMain(userIds.admin, ownFolder('admin'));
    const p = await getAgentPermissionsResolved(main, allGroups);
    expectScoped(p);
    expect(hasPermission(p, folders.a, 'tasks:read')).toBe(false);
  });

  test('missing reachable list fails closed to the own folder', () => {
    const main = perUserMain(userIds.alice, ownFolder('alice'));
    const p = getAgentPermissions(main, allGroups);
    expect(Object.keys(p)).toEqual([ownFolder('alice')]);
    expect(hasPermission(p, folders.b, 'tasks:read')).toBe(false);
  });

  test('resolver error fails closed to the own folder', async () => {
    const main = perUserMain(userIds.alice, ownFolder('alice'));
    let failed = false;
    const broken = new Proxy(allGroups, {
      ownKeys(target) {
        // Fail only the resolver's enumeration, not the later permission build.
        if (!failed) {
          failed = true;
          throw new Error('boom');
        }
        return Reflect.ownKeys(target);
      },
    });
    const p = await getAgentPermissionsResolved(main, broken);
    expect(Object.keys(p)).toEqual([ownFolder('alice')]);
  });

  test("resolver excludes another user's main despite a stray member row", async () => {
    const reach = await resolveMainReachableFolders(userIds.alice, allGroups);
    const reached = reach.map((r) => r.folder).sort();
    expect(reached).toEqual(
      [ownFolder('alice'), folders.a, folders.b, folders.v].sort(),
    );
    expect(reach.find((r) => r.folder === folders.v)?.readOnly).toBe(true);
    expect(reach.find((r) => r.folder === folders.b)?.readOnly).toBe(false);
  });

  test('run-scoped token for a per-user main has no wildcard', async () => {
    const main = perUserMain(userIds.alice, ownFolder('alice'));
    const token = await mintRunScopedAgentToken(main, { run_id: 'r1' }, 'r1');
    const scope = verifyToken(token);
    expect(scope?.permissions?.['*']).toBeUndefined();
    expect(
      hasPermission(scope?.permissions, ownFolder('alice'), 'tasks:write'),
    ).toBe(true);
  });
});
