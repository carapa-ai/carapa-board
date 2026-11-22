import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  isSafeIdentifier,
  executionStageError,
  normalizeProjectAccessLevel,
  requireConversationAccess,
  isAdminUser,
  userCanAccessGroup,
  userHasExplicitGroupAccess,
  scanAgentSkills,
  readPrompt,
  readProjectPrompt,
  writePrompt,
  deletePrompt,
} from './_helpers.js';

import { GROUPS_DIR } from '../config.js';
import {
  initDatabase,
  upsertConversationMember,
  upsertProjectMember,
  createConversation,
  createUser,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';

describe('Route & Context Helpers (optimized)', () => {
  const testGroupName = 'test-route-helpers-group-opt';

  beforeAll(() => {
    fs.mkdirSync(path.join(GROUPS_DIR, testGroupName), { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(path.join(GROUPS_DIR, testGroupName), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('isSafeIdentifier returns false for unsafe values', () => {
    expect(isSafeIdentifier('not safe!')).toBe(false);
    expect(isSafeIdentifier('invalid/slash')).toBe(false);
    expect(isSafeIdentifier('; rm -rf')).toBe(false);
  });

  test('executionStageError rejects invalid execution-stage overrides', () => {
    const stages = [
      {
        id: 'backlog',
        title: 'Backlog',
        type: 'queue' as const,
        color: '#aaa',
      },
      { id: 'build', title: 'Build', type: 'active' as const, color: '#00f' },
      { id: 'review', title: 'Review', type: 'review' as const, color: '#fa0' },
      {
        id: 'disabled',
        title: 'Disabled',
        type: 'active' as const,
        color: '#999',
        inactive: true,
      },
      { id: 'done', title: 'Done', type: 'done' as const, color: '#0f0' },
    ];

    expect(executionStageError(stages, undefined)).toBeNull();
    expect(executionStageError(stages, 'build')).toBeNull();
    expect(executionStageError(stages, 'review')).toBeNull();
    expect(executionStageError(stages, 'missing')).toBe(
      'stage must name an active, executable stage',
    );
    expect(executionStageError(stages, 'disabled')).toBe(
      'stage must name an active, executable stage',
    );
    expect(executionStageError(stages, 'done')).toBe(
      'stage must name an active, executable stage',
    );
    expect(executionStageError(stages, ['build', 'review'])).toBe(
      'stage must name an active, executable stage',
    );
  });

  test('normalizes project access levels with a viewer-safe default', () => {
    expect(normalizeProjectAccessLevel('owner')).toBe('owner');
    expect(normalizeProjectAccessLevel('editor')).toBe('editor');
    expect(normalizeProjectAccessLevel('viewer')).toBe('viewer');
    expect(normalizeProjectAccessLevel('admin')).toBe('viewer');
    expect(normalizeProjectAccessLevel(undefined)).toBe('viewer');
  });
});

describe('requireConversationAccess', () => {
  // Hits the real PGlite + userCanAccessConversation path so the test
  // exercises both the helper's gating logic and the underlying ACL query.
  const PROJECT = 'helper-acl-proj';
  const OWNER_ID = 'user-owner';
  const VIEWER_ID = 'user-viewer';
  const STRANGER_ID = 'user-stranger';
  const ADMIN_ID = 'user-admin';
  let convId = '';

  function fakeRes() {
    const r: any = {
      statusCode: 0,
      body: undefined as any,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: any) {
        this.body = b;
        return this;
      },
    };
    return r;
  }

  beforeAll(async () => {
    await initDatabase(':memory:');
    // Seed parent project so the conversation FK passes when the suite is
    // first to run (truncateTestDb would clear users/projects otherwise).
    const client = drizzleDbRef.current as any;
    const handle =
      client?.$client ?? client?._?.client ?? client?.session?.client;
    if (handle) {
      await handle.exec(
        `DELETE FROM conversations WHERE group_folder = '${PROJECT}'`,
      );
      await handle.exec(`DELETE FROM projects WHERE id = '${PROJECT}'`);
      await handle.exec(
        `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
         VALUES ('${PROJECT}', 'helper@kanban', 'Helper', '${PROJECT}', '!', '${new Date().toISOString()}', 0)
         ON CONFLICT (id) DO NOTHING`,
      );
    }
    await createUser('owner-h', 'pw', 'user');
    await createUser('viewer-h', 'pw', 'user');
    await createUser('stranger-h', 'pw', 'user');
    await createUser('admin-h', 'pw', 'admin');
    // createUser auto-generates IDs; map our fixed test IDs to the real rows
    // by re-inserting against the constants (test isolation is per-suite).
    if (handle) {
      await handle.exec(
        `UPDATE users SET id = '${OWNER_ID}' WHERE username = 'owner-h'`,
      );
      await handle.exec(
        `UPDATE users SET id = '${VIEWER_ID}' WHERE username = 'viewer-h'`,
      );
      await handle.exec(
        `UPDATE users SET id = '${STRANGER_ID}' WHERE username = 'stranger-h'`,
      );
      await handle.exec(
        `UPDATE users SET id = '${ADMIN_ID}' WHERE username = 'admin-h'`,
      );
    }
    const conv = await createConversation(PROJECT);
    convId = conv.id;
    await upsertConversationMember(OWNER_ID, convId, 'owner');
    await upsertConversationMember(VIEWER_ID, convId, 'viewer');
    // stranger has no row at all — no project membership, no conversation membership
  });

  test('admin bypasses access checks', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: ADMIN_ID, role: 'admin' } } as any,
      res,
      convId,
      'owner',
    );
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  test('unauthenticated request returns 401', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess({} as any, res, convId, 'read');
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('viewer can read', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: VIEWER_ID, role: 'user' } } as any,
      res,
      convId,
      'read',
    );
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  test('viewer cannot write', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: VIEWER_ID, role: 'user' } } as any,
      res,
      convId,
      'write',
    );
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('viewer cannot perform owner-only operations', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: VIEWER_ID, role: 'user' } } as any,
      res,
      convId,
      'owner',
    );
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('owner has owner-level access', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: OWNER_ID, role: 'user' } } as any,
      res,
      convId,
      'owner',
    );
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  test('stranger with no membership row is denied', async () => {
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: STRANGER_ID, role: 'user' } } as any,
      res,
      convId,
      'read',
    );
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('explicit project member inherits read access on every conversation', async () => {
    // userCanAccessConversation falls through to project_members when no
    // direct conversation_members row exists. Add stranger as a project
    // viewer and confirm the helper now allows read.
    await upsertProjectMember(STRANGER_ID, PROJECT, 'viewer');
    const res = fakeRes();
    const ok = await requireConversationAccess(
      { authUser: { id: STRANGER_ID, role: 'user' } } as any,
      res,
      convId,
      'read',
    );
    expect(ok).toBe(true);
  });
});

describe('isAdminUser', () => {
  test('admin user passes', () => {
    expect(isAdminUser({ authUser: { id: 'a', role: 'admin' } })).toBe(true);
  });

  test('an agent token for a project named main gets no privilege', () => {
    expect(isAdminUser({ tokenScope: { group_folder: 'main' } })).toBe(false);
  });

  test('regular user is rejected', () => {
    expect(isAdminUser({ authUser: { id: 'b', role: 'user' } })).toBe(false);
  });

  test('group-scoped agent token is rejected', () => {
    expect(isAdminUser({ tokenScope: { group_folder: 'some-project' } })).toBe(
      false,
    );
  });

  test('unauthenticated request is rejected', () => {
    expect(isAdminUser({})).toBe(false);
  });
});

describe('userCanAccessGroup', () => {
  // Exercises the access decision used by memories/observations/sandbox routes
  // (the `/projects/:pid` middleware in kanban.ts doesn't apply to those).
  const PROJECT = 'helper-group-acl-proj';
  const OTHER_PROJECT = 'helper-group-acl-other';
  const MEMBER_ID = 'g-user-member';
  const STRANGER_ID = 'g-user-stranger';
  const ADMIN_ID = 'g-user-admin';
  const EDITOR_ID = 'g-user-editor';
  const IMPLICIT_ID = 'g-user-implicit';
  const FOREIGN_MAIN = 'helper-foreign-main';
  const ADMIN_MAIN = 'helper-admin-main';
  const OWNED_PROJECT = 'helper-owned-proj';

  afterAll(async () => {
    for (const folder of [FOREIGN_MAIN, ADMIN_MAIN, OWNED_PROJECT]) {
      await unregisterGroup(`${folder}@kanban`);
    }
  });

  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle =
      (drizzleDbRef.current as any)?.$client ??
      (drizzleDbRef.current as any)?._?.client ??
      (drizzleDbRef.current as any)?.session?.client;
    const now = new Date().toISOString();
    if (handle) {
      for (const id of [PROJECT, OTHER_PROJECT]) {
        await handle.exec(
          `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
           VALUES ('${id}', 'helper@kanban', 'Helper', '${id}', '!', '${now}', 0)
           ON CONFLICT (id) DO NOTHING`,
        );
      }
    }
    await createUser('group-member-h', 'pw', 'user');
    await createUser('group-stranger-h', 'pw', 'user');
    await createUser('group-admin-h', 'pw', 'admin');
    if (handle) {
      await handle.exec(
        `UPDATE users SET id = '${MEMBER_ID}' WHERE username = 'group-member-h'`,
      );
      await handle.exec(
        `UPDATE users SET id = '${STRANGER_ID}' WHERE username = 'group-stranger-h'`,
      );
      await handle.exec(
        `UPDATE users SET id = '${ADMIN_ID}' WHERE username = 'group-admin-h'`,
      );
    }
    await upsertProjectMember(MEMBER_ID, PROJECT, 'viewer');
    await createUser('group-editor-h', 'pw', 'user');
    await createUser('group-implicit-h', 'pw', 'user');
    if (handle) {
      await handle.exec(
        `UPDATE users SET id = '${EDITOR_ID}' WHERE username = 'group-editor-h'`,
      );
      await handle.exec(
        `UPDATE users SET id = '${IMPLICIT_ID}' WHERE username = 'group-implicit-h'`,
      );
    }
    await upsertProjectMember(EDITOR_ID, PROJECT, 'editor');
    const chat = await createConversation(PROJECT);
    await upsertConversationMember(IMPLICIT_ID, chat.id, 'viewer');

    // Personal mains: registered group (is_main, user_id) plus the projects
    // row that getProjectAccess reads.
    await loadState();
    for (const [folder, userId] of [
      [FOREIGN_MAIN, STRANGER_ID],
      [ADMIN_MAIN, ADMIN_ID],
    ]) {
      await registerGroup(`${folder}@kanban`, {
        name: folder,
        folder,
        jid: `${folder}@kanban`,
        trigger: '!',
        added_at: now,
        is_main: true,
        user_id: userId,
      });
      await handle.exec(
        `UPDATE projects SET is_main = 1, user_id = '${userId}' WHERE id = '${folder}'`,
      );
    }
    // An ordinary project owned by another user.
    await registerGroup(`${OWNED_PROJECT}@kanban`, {
      name: OWNED_PROJECT,
      folder: OWNED_PROJECT,
      jid: `${OWNED_PROJECT}@kanban`,
      trigger: '!',
      added_at: now,
      user_id: STRANGER_ID,
    });
  });

  test('admin user passes for an ownerless ordinary group', async () => {
    expect(
      await userCanAccessGroup(
        { authUser: { id: ADMIN_ID, role: 'admin' } },
        OTHER_PROJECT,
      ),
    ).toBe(true);
  });

  test('admin is refused in a foreign personal main but not in their own', async () => {
    const admin = { authUser: { id: ADMIN_ID, role: 'admin' } };
    expect(await userCanAccessGroup(admin, FOREIGN_MAIN)).toBe(false);
    expect(await userHasExplicitGroupAccess(admin, FOREIGN_MAIN)).toBe(false);
    expect(
      await userHasExplicitGroupAccess(admin, FOREIGN_MAIN, { write: true }),
    ).toBe(false);
    expect(await userCanAccessGroup(admin, ADMIN_MAIN)).toBe(true);
    expect(await userHasExplicitGroupAccess(admin, ADMIN_MAIN)).toBe(true);
  });

  test('admin is closed out of an ordinary project owned by another user and gets only their membership level', async () => {
    const admin = { authUser: { id: ADMIN_ID, role: 'admin' } };
    expect(await userCanAccessGroup(admin, OWNED_PROJECT)).toBe(false);
    expect(await userHasExplicitGroupAccess(admin, OWNED_PROJECT)).toBe(false);

    const req: any = { authUser: admin.authUser };
    const conv = await createConversation(OWNED_PROJECT);
    const callAccess = async (level: 'read' | 'write') => {
      const res: any = {};
      res.status = () => res;
      res.json = () => res;
      return requireConversationAccess(req, res, conv.id, level);
    };
    expect(await callAccess('read')).toBe(false);

    await upsertProjectMember(ADMIN_ID, OWNED_PROJECT, 'viewer');
    expect(await userCanAccessGroup(admin, OWNED_PROJECT)).toBe(true);
    expect(
      await userHasExplicitGroupAccess(admin, OWNED_PROJECT, { write: true }),
    ).toBe(false);
    expect(await callAccess('read')).toBe(true);
    expect(await callAccess('write')).toBe(false);

    await upsertProjectMember(ADMIN_ID, OWNED_PROJECT, 'editor');
    expect(
      await userHasExplicitGroupAccess(admin, OWNED_PROJECT, { write: true }),
    ).toBe(true);
    expect(await callAccess('write')).toBe(true);
  });

  test('admin conversation bypass stops at a foreign main even with membership', async () => {
    const req: any = { authUser: { id: ADMIN_ID, role: 'admin' } };
    const call = async (cid: string, level: 'read' | 'write') => {
      const res: any = {};
      res.status = (code: number) => {
        res.code = code;
        return res;
      };
      res.json = () => res;
      return { ok: await requireConversationAccess(req, res, cid, level), res };
    };
    const foreign = await createConversation(FOREIGN_MAIN);
    for (const level of ['read', 'write'] as const) {
      const denied = await call(foreign.id, level);
      expect(denied.ok).toBe(false);
      expect(denied.res.code).toBe(403);
    }
    const ordinary = await createConversation(OTHER_PROJECT);
    expect((await call(ordinary.id, 'write')).ok).toBe(true);
    // Neither project nor direct conversation membership admits a non-owner.
    await upsertProjectMember(ADMIN_ID, FOREIGN_MAIN, 'editor');
    expect((await call(foreign.id, 'write')).ok).toBe(false);
    await upsertConversationMember(ADMIN_ID, foreign.id, 'viewer');
    expect((await call(foreign.id, 'read')).ok).toBe(false);
  });

  test('a human session tokenScope does not admit a main owned by someone else', async () => {
    const scope = { group_folder: FOREIGN_MAIN, permissions: {} };
    const member = {
      authUser: { id: MEMBER_ID, role: 'user' },
      tokenScope: scope,
    };
    expect(await userCanAccessGroup(member, FOREIGN_MAIN)).toBe(false);
    expect(await userHasExplicitGroupAccess(member, FOREIGN_MAIN)).toBe(false);
    const owner = {
      authUser: { id: STRANGER_ID, role: 'user' },
      tokenScope: scope,
    };
    expect(await userCanAccessGroup(owner, FOREIGN_MAIN)).toBe(true);
    expect(await userHasExplicitGroupAccess(owner, FOREIGN_MAIN)).toBe(true);
  });

  test('explicit project member passes', async () => {
    expect(
      await userCanAccessGroup(
        { authUser: { id: MEMBER_ID, role: 'user' } },
        PROJECT,
      ),
    ).toBe(true);
  });

  test('member of another project is rejected for this group', async () => {
    expect(
      await userCanAccessGroup(
        { authUser: { id: MEMBER_ID, role: 'user' } },
        OTHER_PROJECT,
      ),
    ).toBe(false);
  });

  test('stranger with no membership is rejected', async () => {
    expect(
      await userCanAccessGroup(
        { authUser: { id: STRANGER_ID, role: 'user' } },
        PROJECT,
      ),
    ).toBe(false);
  });

  test('unauthenticated request is rejected', async () => {
    expect(await userCanAccessGroup({}, PROJECT)).toBe(false);
  });

  test('agent token scoped to the same group passes', async () => {
    expect(
      await userCanAccessGroup(
        { tokenScope: { group_folder: PROJECT } },
        PROJECT,
      ),
    ).toBe(true);
  });

  test('agent token scoped to a different group is rejected', async () => {
    expect(
      await userCanAccessGroup(
        { tokenScope: { group_folder: OTHER_PROJECT } },
        PROJECT,
      ),
    ).toBe(false);
  });

  test('an agent token for a project named main reaches only that project', async () => {
    expect(
      await userCanAccessGroup(
        { tokenScope: { group_folder: 'main' } },
        PROJECT,
      ),
    ).toBe(false);
  });

  test('userCanAccessGroup admits implicit chat-only users', async () => {
    expect(
      await userCanAccessGroup(
        { authUser: { id: IMPLICIT_ID, role: 'user' } },
        PROJECT,
      ),
    ).toBe(true);
  });

  test('userHasExplicitGroupAccess requires explicit membership', async () => {
    const as = (id: string) => ({ authUser: { id, role: 'user' } });
    expect(await userHasExplicitGroupAccess(as(IMPLICIT_ID), PROJECT)).toBe(
      false,
    );
    expect(
      await userHasExplicitGroupAccess(as(IMPLICIT_ID), PROJECT, {
        write: true,
      }),
    ).toBe(false);
    expect(await userHasExplicitGroupAccess(as(STRANGER_ID), PROJECT)).toBe(
      false,
    );
    expect(await userHasExplicitGroupAccess({}, PROJECT)).toBe(false);
    // viewer: read ok, write rejected
    expect(await userHasExplicitGroupAccess(as(MEMBER_ID), PROJECT)).toBe(true);
    expect(
      await userHasExplicitGroupAccess(as(MEMBER_ID), PROJECT, { write: true }),
    ).toBe(false);
    // editor and admin pass for write
    expect(
      await userHasExplicitGroupAccess(as(EDITOR_ID), PROJECT, { write: true }),
    ).toBe(true);
    expect(
      await userHasExplicitGroupAccess(
        { authUser: { id: ADMIN_ID, role: 'admin' } },
        PROJECT,
        { write: true },
      ),
    ).toBe(true);
    expect(
      await userHasExplicitGroupAccess(
        { tokenScope: { group_folder: PROJECT } },
        PROJECT,
        { write: true },
      ),
    ).toBe(true);
  });
});

describe('scanAgentSkills', () => {
  const root = path.join(GROUPS_DIR, 'test-scan-agent-skills-group');
  const outside = path.join(GROUPS_DIR, 'test-scan-agent-skills-outside.md');
  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: d ${name}\n---\n`;

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  test('skips symlink, FIFO and oversized SKILL.md without blocking', async () => {
    fs.mkdirSync(root, { recursive: true });
    const mk = (n: string) => {
      fs.mkdirSync(path.join(root, n), { recursive: true });
      return path.join(root, n, 'SKILL.md');
    };
    fs.writeFileSync(mk('ok'), skill('ok'));
    fs.writeFileSync(outside, skill('leak'));
    fs.symlinkSync(outside, mk('link'));
    fs.writeFileSync(mk('big'), skill('big') + 'x'.repeat(70 * 1024));
    const fifo = mk('fifo');
    const made = Bun.spawnSync(['mkfifo', fifo]).exitCode === 0;

    const result = await Promise.race([
      scanAgentSkills(root),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    expect(result).not.toBeNull();
    expect(result!.map((c) => c.name)).toEqual(['ok']);
    if (!made) console.warn('mkfifo unavailable; FIFO case not exercised');
  });
});

describe('group prompt file containment', () => {
  const folder = 'test-prompt-containment-group';
  const home = path.join(GROUPS_DIR, folder);
  const outsideDir = path.join(GROUPS_DIR, `${folder}-outside`);
  const promptsDir = path.join(home, '.agent', 'prompts');

  beforeAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test('readPrompt refuses a symlink leaf out of the group and a FIFO, but reads through an intra-group .agent link', async () => {
    const secret = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(secret, 'outside secret');
    fs.symlinkSync(secret, path.join(promptsDir, 'worker.md'));
    expect(await readPrompt(folder, undefined, 'worker.md')).toBeUndefined();

    const fifo = path.join(promptsDir, 'stage-fifo.md');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    // Resolves promptly (refused, not blocked); the runner timeout is the guard.
    expect(
      await readPrompt(folder, undefined, 'stage-fifo.md'),
    ).toBeUndefined();

    const linked = 'test-prompt-containment-linked';
    const linkedHome = path.join(GROUPS_DIR, linked);
    try {
      fs.mkdirSync(path.join(linkedHome, '.claude', 'prompts'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(linkedHome, '.claude', 'prompts', 'worker.md'),
        ' legacy worker ',
      );
      fs.symlinkSync('.claude', path.join(linkedHome, '.agent'));
      expect(await readPrompt(linked, undefined, 'worker.md')).toBe(
        'legacy worker',
      );
    } finally {
      fs.rmSync(linkedHome, { recursive: true, force: true });
    }
  });

  test('readProjectPrompt falls back past a group system.md symlinked out', async () => {
    const secret = path.join(outsideDir, 'system-secret.md');
    fs.writeFileSync(secret, 'outside system');
    fs.symlinkSync(secret, path.join(promptsDir, 'system.md'));
    expect((await readProjectPrompt(folder)) ?? '').not.toContain(
      'outside system',
    );
  });

  test('writePrompt refuses a symlink leaf and leaves the outside target unchanged', async () => {
    const target = path.join(outsideDir, 'target.md');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, path.join(promptsDir, 'stage-x.md'));
    await expect(
      writePrompt(folder, undefined, 'stage-x.md', 'overwritten'),
    ).rejects.toThrow('Refused to write prompt file');
    expect(fs.readFileSync(target, 'utf-8')).toBe('original');
  });

  test('writePrompt and deletePrompt do not touch a group whose .agent points outside', async () => {
    const swapped = 'test-prompt-containment-swapped';
    const swappedHome = path.join(GROUPS_DIR, swapped);
    const victimDir = path.join(outsideDir, 'victim');
    try {
      fs.mkdirSync(path.join(victimDir, 'prompts'), { recursive: true });
      fs.writeFileSync(path.join(victimDir, 'prompts', 'worker.md'), 'victim');
      fs.mkdirSync(swappedHome, { recursive: true });
      fs.symlinkSync(victimDir, path.join(swappedHome, '.agent'));

      await expect(
        writePrompt(swapped, undefined, 'worker.md', 'planted'),
      ).rejects.toThrow('Refused to write prompt file');
      await expect(
        writePrompt(swapped, undefined, 'new.md', 'planted'),
      ).rejects.toThrow('Refused to write prompt file');
      expect(fs.existsSync(path.join(victimDir, 'prompts', 'new.md'))).toBe(
        false,
      );

      await deletePrompt(swapped, undefined, 'worker.md');
      expect(
        fs.readFileSync(path.join(victimDir, 'prompts', 'worker.md'), 'utf-8'),
      ).toBe('victim');
    } finally {
      fs.rmSync(swappedHome, { recursive: true, force: true });
    }
  });
});
