import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { agentTokens, projects, users } from '../db/schema.js';
import { projectChanges } from '../lib/project-changes.js';
import { logger } from '../logger.js';
import {
  removeProjectMember,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import type { RegisteredGroup } from '../types.js';
import { hasPermission, resolveAgentPermissions } from './auth.js';
import {
  type TokenScope,
  generateAgentToken,
  hydrateTokenRegistry,
  revokeAgentToken,
  revokeGroupTokens,
  revokeTokensGrantingFolder,
  verifyToken,
} from './auth-tokens.js';
import {
  rescopeAllMainTokens,
  rescopeMainTokens,
  startMainReachSync,
} from './main-reach-sync.js';

const RUN = Math.random().toString(36).slice(2, 8);
const id = (name: string) => `${name}-${RUN}`;
const alice = id('u-alice');
const bob = id('u-bob');
const mainAlice = id('main-alice');
const mainBob = id('main-bob');
const plain = id('plain');
const shared = id('shared'); // owned by bob; alice becomes a member
const newProj = id('new-proj');

const group = (folder: string, extra: Partial<RegisteredGroup> = {}) =>
  ({
    name: folder,
    folder,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {},
    ...extra,
  }) as RegisteredGroup;

const groups: Record<string, RegisteredGroup> = {};
for (const g of [
  group(mainAlice, { is_main: true, user_id: alice }),
  group(mainBob, { is_main: true, user_id: bob }),
  group(plain),
  group(shared),
  group(newProj),
]) {
  groups[g.folder] = g;
}
const getGroups = () => groups;

async function mint(
  folder: string,
  extra: Partial<TokenScope> = {},
  ttlMs: number | null = null,
) {
  const base =
    groups[folder] && (await resolveAgentPermissions(groups[folder], groups));
  return generateAgentToken(
    {
      group_folder: folder,
      permissions: base?.permissions ?? {},
      ...extra,
    },
    ttlMs,
  );
}

const reaches = (token: string, folder: string, perm = 'tasks:read') =>
  hasPermission(verifyToken(token)?.permissions, folder, perm);

describe('per-user main token re-scope', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    const db = drizzleDbRef.current;
    const now = new Date().toISOString();
    for (const [name, userId] of [
      ['alice', alice],
      ['bob', bob],
    ]) {
      await db.insert(users).values({
        id: userId,
        username: `${name}-${RUN}`,
        password_hash: 'x',
        role: 'user',
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
    await project(mainAlice, alice, 1);
    await project(mainBob, bob, 1);
    await project(plain, null);
    await project(shared, bob);
  });

  afterEach(async () => {
    for (const folder of [mainAlice, mainBob, plain]) {
      await revokeGroupTokens(folder);
    }
    await removeProjectMember(alice, shared);
    await drizzleDbRef.current.delete(projects).where(eq(projects.id, newProj));
  });

  test('removing a membership drops the folder from sandbox and run tokens without a restart', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const sandboxToken = await mint(mainAlice);
    const runToken = await mint(
      mainAlice,
      { run_id: 'run-1', conversation_id: 'c-1' },
      60_000,
    );
    expect(reaches(sandboxToken, shared, 'tasks:write')).toBe(true);
    expect(reaches(runToken, shared, 'tasks:write')).toBe(true);

    await removeProjectMember(alice, shared);
    await rescopeMainTokens(mainAlice, getGroups);

    for (const token of [sandboxToken, runToken]) {
      expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();
      expect(reaches(token, mainAlice, 'tasks:write')).toBe(true);
    }
    // Everything else on the scope is preserved.
    expect(verifyToken(runToken)).toMatchObject({
      group_folder: mainAlice,
      run_id: 'run-1',
      conversation_id: 'c-1',
    });
  });

  test('owner to viewer leaves only read permissions for the folder', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const token = await mint(mainAlice);
    await upsertProjectMember(alice, shared, 'viewer');
    await rescopeMainTokens(mainAlice, getGroups);

    const perms = verifyToken(token)!.permissions![shared];
    expect(perms.length).toBeGreaterThan(0);
    expect(perms.every((p) => p.endsWith(':read'))).toBe(true);
    expect(reaches(token, shared, 'tasks:write')).toBe(false);
  });

  test('a project created for the user (owner row) becomes reachable', async () => {
    const token = await mint(mainAlice);
    expect(reaches(token, newProj)).toBe(false);
    await drizzleDbRef.current.insert(projects).values({
      id: newProj,
      jid: newProj,
      name: newProj,
      folder: newProj,
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: 0,
      user_id: alice,
    });
    await rescopeMainTokens(mainAlice, getGroups);
    expect(reaches(token, newProj, 'tasks:write')).toBe(true);
  });

  test('other mains, non-main projects, user and OAuth tokens are untouched', async () => {
    const aliceToken = await mint(mainAlice);
    const bobToken = await mint(mainBob);
    const plainToken = await mint(plain);
    const oauthToken = await mint(mainAlice, {
      kind: 'oauth',
      oauth_access: 'write',
    });
    const userToken = await mint(mainAlice, { kind: 'user' });
    const snapshot = () =>
      JSON.stringify(
        [bobToken, plainToken, oauthToken, userToken].map(verifyToken),
      );
    const before = snapshot();

    await upsertProjectMember(alice, shared, 'editor');
    await rescopeMainTokens(mainAlice, getGroups);

    expect(reaches(aliceToken, shared, 'tasks:write')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  test('resolver failure narrows tokens to the own folder and logs the failure', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const token = await mint(mainAlice);
    expect(reaches(token, shared)).toBe(true);

    // Fail the reach resolver's group enumeration (the 2nd), not the lookups.
    let enumerations = 0;
    const broken = new Proxy(groups, {
      ownKeys(target) {
        if (++enumerations === 2) throw new Error('boom');
        return Reflect.ownKeys(target);
      },
    });
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      await rescopeMainTokens(mainAlice, () => broken);
      expect(Object.keys(verifyToken(token)!.permissions!)).toEqual([
        mainAlice,
      ]);
      expect(
        warn.mock.calls.some(
          ([obj]) => (obj as any)?.event === 'main_reach_rescope_failed',
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a token revoked during an in-flight recompute is not resurrected', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const doomed = await mint(mainAlice);
    const survivor = await mint(mainAlice, { run_id: 'run-2' }, 60_000);
    await removeProjectMember(alice, shared);

    // Revoke while the reach resolution is awaiting.
    let enumerations = 0;
    const racing = new Proxy(groups, {
      ownKeys(target) {
        if (++enumerations === 2) void revokeAgentToken(doomed);
        return Reflect.ownKeys(target);
      },
    });
    await rescopeMainTokens(mainAlice, () => racing);

    expect(verifyToken(doomed)).toBeNull();
    const rows = await drizzleDbRef.current
      .select({ token: agentTokens.token })
      .from(agentTokens)
      .where(eq(agentTokens.token, doomed));
    expect(rows).toHaveLength(0);
    expect(verifyToken(survivor)?.permissions?.[shared]).toBeUndefined();
  });

  test('a failed scope write is retried so a restart cannot restore revoked access', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const token = await mint(mainAlice);
    await removeProjectMember(alice, shared);

    const db = drizzleDbRef.current as any;
    const had = Object.prototype.hasOwnProperty.call(db, 'update');
    const original = db.update;
    db.update = () => {
      throw new Error('db down');
    };
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      await rescopeMainTokens(mainAlice, getGroups);
    } finally {
      if (had) db.update = original;
      else delete db.update;
      warn.mockRestore();
    }
    expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();

    // Same grants in memory, but the next pass still writes the row.
    await rescopeMainTokens(mainAlice, getGroups);
    await hydrateTokenRegistry();
    expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();
  });

  test('a board restart after a failed scope write recomputes the scope before use', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const token = await mint(mainAlice);
    await removeProjectMember(alice, shared);

    const db = drizzleDbRef.current as any;
    const had = Object.prototype.hasOwnProperty.call(db, 'update');
    const original = db.update;
    db.update = () => {
      throw new Error('db down');
    };
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      await rescopeMainTokens(mainAlice, getGroups);
    } finally {
      if (had) db.update = original;
      else delete db.update;
      warn.mockRestore();
    }

    // Restart: the stale wide row is hydrated, then the startup pass narrows it.
    await hydrateTokenRegistry();
    expect(reaches(token, shared, 'tasks:write')).toBe(true);
    await rescopeAllMainTokens(getGroups);
    expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();
    await hydrateTokenRegistry();
    expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();
  });

  test('a token minted with a stale scope during a re-scope is reconciled', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const existing = await mint(mainAlice);
    const stale = (await resolveAgentPermissions(groups[mainAlice], groups))
      .permissions;
    expect(stale[shared]).toBeDefined();
    await removeProjectMember(alice, shared);

    // The run resolved its scope before the removal and registers its token
    // after the re-scope read the registry (while its DB write is in flight).
    const db = drizzleDbRef.current as any;
    const had = Object.prototype.hasOwnProperty.call(db, 'update');
    const original = db.update;
    let minted: Promise<string> | undefined;
    db.update = (...args: unknown[]) => {
      minted ??= generateAgentToken(
        { group_folder: mainAlice, permissions: stale },
        null,
      );
      return original.apply(db, args);
    };
    try {
      await rescopeMainTokens(mainAlice, getGroups);
    } finally {
      if (had) db.update = original;
      else delete db.update;
    }
    const late = await minted!;
    expect(verifyToken(existing)?.permissions?.[shared]).toBeUndefined();
    expect(verifyToken(late)?.permissions?.[shared]).toBeUndefined();
  });

  test('a token minted from a pre-change resolution after the pass finished is reconciled', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const stale = (await resolveAgentPermissions(groups[mainAlice], groups))
      .permissions;
    await removeProjectMember(alice, shared);
    const stop = startMainReachSync(getGroups, 3_600_000);
    try {
      const existing = await mint(mainAlice);
      await rescopeMainTokens(mainAlice, getGroups); // the pass has finished

      // The mint itself waits for the re-scope: the token is already narrowed
      // when it is returned, with no further waiting.
      const late = await generateAgentToken(
        { group_folder: mainAlice, permissions: stale },
        null,
      );
      expect(verifyToken(existing)?.permissions?.[shared]).toBeUndefined();
      expect(verifyToken(late)?.permissions?.[shared]).toBeUndefined();
    } finally {
      stop();
    }
  });

  test('scope writes for one token are applied in order, behind its insert', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const stale = (await resolveAgentPermissions(groups[mainAlice], groups))
      .permissions;
    await removeProjectMember(alice, shared);

    // Hold the token's insert so the re-scope's write queues behind it.
    const db = drizzleDbRef.current as any;
    const had = Object.prototype.hasOwnProperty.call(db, 'insert');
    const original = db.insert;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    db.insert = (table: unknown) => ({
      values: async (v: unknown) => {
        await gate;
        return original.call(db, table).values(v);
      },
    });
    try {
      const minted = generateAgentToken(
        { group_folder: mainAlice, permissions: stale },
        null,
      );
      const rescoped = rescopeMainTokens(mainAlice, getGroups);
      setTimeout(release, 50);
      const token = await minted;
      await rescoped;
      const [row] = await drizzleDbRef.current
        .select({ scope: agentTokens.scope })
        .from(agentTokens)
        .where(eq(agentTokens.token, token));
      expect(JSON.parse(row.scope).permissions[shared]).toBeUndefined();
    } finally {
      release();
      if (had) db.insert = original;
      else delete db.insert;
    }
  });

  test('a token revoked while its insert is pending is neither issued nor restored', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const perms = (await resolveAgentPermissions(groups[mainAlice], groups))
      .permissions;

    // Hold the insert; revoke the group while it is queued, then let it run.
    const db = drizzleDbRef.current as any;
    const had = Object.prototype.hasOwnProperty.call(db, 'insert');
    const original = db.insert;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const insertStarted = new Promise<void>((r) => (started = r));
    db.insert = (table: unknown) => ({
      values: async (v: unknown) => {
        started();
        await gate;
        return original.call(db, table).values(v);
      },
    });
    try {
      const minted = generateAgentToken(
        { group_folder: mainAlice, permissions: perms },
        null,
      ).then(
        () => 'issued',
        () => 'refused',
      );
      await insertStarted; // the insert is in flight, not merely queued
      const revoked = revokeGroupTokens(mainAlice);
      setTimeout(release, 50);
      await revoked;
      expect(await minted).toBe('refused');
    } finally {
      release();
      if (had) db.insert = original;
      else delete db.insert;
    }
    const rows = await drizzleDbRef.current
      .select({ scope: agentTokens.scope })
      .from(agentTokens);
    expect(
      rows.filter((r) => JSON.parse(r.scope).group_folder === mainAlice),
    ).toHaveLength(0);
  });

  test('a steady stream of project changes cannot postpone the re-scope', async () => {
    const token = await mint(mainAlice);
    await upsertProjectMember(alice, shared, 'editor');
    const rescoped = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('re-scope starved by continuous changes')),
        2_000,
      );
      const info = spyOn(logger, 'info').mockImplementation(((obj: any) => {
        if (obj?.event === 'main_reach_rescoped') {
          info.mockRestore();
          clearTimeout(timeout);
          resolve();
        }
      }) as never);
    });
    const stop = startMainReachSync(getGroups, 40);
    // Changes arrive faster than the delay and never pause.
    const stream = setInterval(() => projectChanges.emit('changed'), 10);
    try {
      await rescoped;
    } finally {
      clearInterval(stream);
      stop();
    }
    expect(reaches(token, shared, 'tasks:write')).toBe(true);
  });

  test('retiring a folder while a re-scope write is pending keeps registry and database consistent', async () => {
    await upsertProjectMember(alice, shared, 'editor');
    const token = await mint(mainAlice);
    await removeProjectMember(alice, shared);

    // Hold the re-scope's row update; registry is already narrowed by then.
    const db = drizzleDbRef.current as any;
    const had = Object.prototype.hasOwnProperty.call(db, 'update');
    const original = db.update;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const updateStarted = new Promise<void>((r) => (started = r));
    db.update = (table: unknown) => {
      const builder = original.call(db, table);
      return {
        set: (v: unknown) => {
          const set = builder.set(v);
          return {
            where: (c: unknown) => {
              const query = set.where(c);
              return {
                returning: async () => {
                  started();
                  await gate;
                  return query.returning();
                },
              };
            },
          };
        },
      };
    };
    try {
      const rescoped = rescopeMainTokens(mainAlice, getGroups);
      await updateStarted;
      expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();
      const retiring = revokeTokensGrantingFolder(shared);
      setTimeout(release, 50); // the scan would run well before this
      await Promise.all([rescoped, retiring]);
    } finally {
      release();
      if (had) db.update = original;
      else delete db.update;
    }

    // The token no longer grants the folder, so it survives in both places.
    const rows = await drizzleDbRef.current
      .select({ token: agentTokens.token })
      .from(agentTokens)
      .where(eq(agentTokens.token, token));
    expect(verifyToken(token)).not.toBeNull();
    expect(rows).toHaveLength(1);
  });

  test('a resolver failure is reported once even when scopes are already own-folder only', async () => {
    const token = await mint(mainAlice);
    await rescopeMainTokens(mainAlice, getGroups); // success clears any failure
    expect(Object.keys(verifyToken(token)!.permissions!)).toEqual([mainAlice]);

    const failOnce = () => {
      let enumerations = 0;
      return new Proxy(groups, {
        ownKeys(target) {
          if (++enumerations === 2) throw new Error('boom');
          return Reflect.ownKeys(target);
        },
      });
    };
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      const failures = () =>
        warn.mock.calls.filter(
          ([obj]) => (obj as any)?.event === 'main_reach_rescope_failed',
        ).length;
      const first = failOnce();
      await rescopeMainTokens(mainAlice, () => first);
      expect(failures()).toBe(1);
      const second = failOnce();
      await rescopeMainTokens(mainAlice, () => second);
      expect(failures()).toBe(1); // not repeated while it lasts
    } finally {
      warn.mockRestore();
      await rescopeMainTokens(mainAlice, getGroups);
    }
  });

  test('resolver failure grants no cross-folder memory access either', async () => {
    const withMemory = {
      ...groups[mainAlice],
      settings: { memorySourceProjects: [plain] },
    } as RegisteredGroup;
    const all = { ...groups, [mainAlice]: withMemory };
    let enumerations = 0;
    const broken = new Proxy(all, {
      ownKeys(target) {
        if (++enumerations === 1) throw new Error('boom');
        return Reflect.ownKeys(target);
      },
    });
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      const { permissions, reachFailed } = await resolveAgentPermissions(
        withMemory,
        broken,
      );
      expect(reachFailed).toBe(true);
      expect(Object.keys(permissions)).toEqual([mainAlice]);
    } finally {
      warn.mockRestore();
    }
  });

  test('add then remove in quick succession ends with the folder absent', async () => {
    const token = await mint(mainAlice);
    await upsertProjectMember(alice, shared, 'editor');
    const first = rescopeMainTokens(mainAlice, getGroups);
    await removeProjectMember(alice, shared);
    const second = rescopeMainTokens(mainAlice, getGroups);
    await Promise.all([first, second]);
    expect(verifyToken(token)?.permissions?.[shared]).toBeUndefined();
  });

  test('project changes trigger a debounced re-scope that persists to agent_tokens', async () => {
    const token = await mint(mainAlice);
    const rescoped = new Promise<void>((resolve) => {
      const info = spyOn(logger, 'info').mockImplementation(((obj: any) => {
        if (obj?.event === 'main_reach_rescoped') {
          info.mockRestore();
          resolve();
        }
      }) as never);
    });
    const stop = startMainReachSync(getGroups, 10);
    try {
      // Burst of changes collapses into one re-scope.
      await upsertProjectMember(alice, shared, 'editor');
      projectChanges.emit('changed');
      await rescoped;
    } finally {
      stop();
    }
    expect(reaches(token, shared, 'tasks:write')).toBe(true);

    const [row] = await drizzleDbRef.current
      .select({ scope: agentTokens.scope })
      .from(agentTokens)
      .where(eq(agentTokens.token, token));
    expect(JSON.parse(row.scope).permissions[shared]).toContain('tasks:*');

    // A board restart rebuilds the registry from the persisted scope.
    await hydrateTokenRegistry();
    expect(reaches(token, shared, 'tasks:write')).toBe(true);
  });
});
