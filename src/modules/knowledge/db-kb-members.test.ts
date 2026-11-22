import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects, users } from '../../db/schema.js';
import { eq, like } from 'drizzle-orm';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { getTmuxClient } from '../../lib/tmux-client.js';
import { truncateTestDb } from '../../test-helpers.js';
import { loadState, registerGroup } from '../../state-manager.js';
import {
  MainFolderTakenError,
  createUser,
  getProjectMemberships,
  getProjectMembersDetailed,
  insertProjectMemberIfMissing,
  upsertProjectMember,
} from './db-kb.js';

// Archiving a main stops its sandbox through MCP; keep the tests off the network.
const sandboxClient = getSandboxClient() as any;
const tmuxClient = getTmuxClient() as any;
const originalSandboxStop = sandboxClient.sandboxStop;
const originalSandboxStatus = sandboxClient.sandboxStatus;
const originalSandboxPs = sandboxClient.sandboxPs;
const originalForget = tmuxClient.forgetByInstance;

beforeAll(async () => {
  sandboxClient.sandboxStop = async () => ({ stdout: '', isError: false });
  sandboxClient.sandboxStatus = async () => ({ stdout: '[]', isError: false });
  sandboxClient.sandboxPs = async () => ({
    stdout: 'No running sandboxes found.',
    isError: false,
  });
  tmuxClient.forgetByInstance = async () => 0;
  await initDatabase(':memory:');
});
afterAll(() => {
  sandboxClient.sandboxStop = originalSandboxStop;
  sandboxClient.sandboxStatus = originalSandboxStatus;
  sandboxClient.sandboxPs = originalSandboxPs;
  tmuxClient.forgetByInstance = originalForget;
});
beforeEach(() => truncateTestDb());

describe('project attribution member roster', () => {
  test('includes an implicit project owner without a membership row', async () => {
    const owner = await createUser('implicit-owner', 'pw', 'user');
    await drizzleDbRef.current.insert(projects).values({
      id: 'owner-only-project',
      jid: 'owner-only@board',
      name: 'Owner only',
      folder: 'owner-only-project',
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });

    expect(await getProjectMembersDetailed('owner-only-project')).toEqual([
      {
        user_id: owner.id,
        username: owner.username,
        access_level: 'owner',
      },
    ]);
  });

  test('deduplicates an explicit owner membership and preserves owner access', async () => {
    const owner = await createUser('dedup-owner', 'pw', 'user');
    const member = await createUser('another-member', 'pw', 'user');
    await drizzleDbRef.current.insert(projects).values({
      id: 'dedup-owner-project',
      jid: 'dedup-owner@board',
      name: 'Dedup owner',
      folder: 'dedup-owner-project',
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });
    await upsertProjectMember(owner.id, 'dedup-owner-project', 'editor');
    await upsertProjectMember(member.id, 'dedup-owner-project', 'viewer');

    expect(await getProjectMembersDetailed('dedup-owner-project')).toEqual([
      {
        user_id: member.id,
        username: member.username,
        access_level: 'viewer',
      },
      {
        user_id: owner.id,
        username: owner.username,
        access_level: 'owner',
      },
    ]);
  });

  test('excludes disabled explicit members and implicit owners', async () => {
    const owner = await createUser('disabled-owner', 'pw', 'user');
    const member = await createUser('disabled-member', 'pw', 'user');
    await drizzleDbRef.current.insert(projects).values({
      id: 'disabled-roster-project',
      jid: 'disabled-roster@board',
      name: 'Disabled roster',
      folder: 'disabled-roster-project',
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });
    await upsertProjectMember(member.id, 'disabled-roster-project', 'editor');
    await drizzleDbRef.current
      .update(users)
      .set({ disabled: 1 })
      .where(eq(users.id, owner.id));
    await drizzleDbRef.current
      .update(users)
      .set({ disabled: 1 })
      .where(eq(users.id, member.id));

    expect(await getProjectMembersDetailed('disabled-roster-project')).toEqual(
      [],
    );
  });
});

describe('insertProjectMemberIfMissing', () => {
  test('inserts a missing row and never changes an existing access level', async () => {
    const owner = await createUser('keep-owner', 'pw', 'user');
    const viewer = await createUser('keep-viewer', 'pw', 'user');
    const fresh = await createUser('fresh-member', 'pw', 'user');
    await drizzleDbRef.current.insert(projects).values({
      id: 'keep-level-project',
      jid: 'keep-level@board',
      name: 'Keep level',
      folder: 'keep-level-project',
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });
    await upsertProjectMember(owner.id, 'keep-level-project', 'owner');
    await upsertProjectMember(viewer.id, 'keep-level-project', 'viewer');

    for (const user of [owner, viewer, fresh]) {
      await insertProjectMemberIfMissing(
        user.id,
        'keep-level-project',
        'editor',
      );
    }

    const levels = Object.fromEntries(
      (await getProjectMemberships('keep-level-project')).map((m) => [
        m.user_id,
        m.access_level,
      ]),
    );
    expect(levels).toEqual({
      [owner.id]: 'owner',
      [viewer.id]: 'viewer',
      [fresh.id]: 'editor',
    });
  });
});

describe('createUser personal main folder', () => {
  test('refuses a username whose main folder is held by another project', async () => {
    const other = await createUser('squat-owner', 'pw', 'user');
    await drizzleDbRef.current.insert(projects).values({
      id: 'main-squatted-user',
      jid: 'ui-main-squatted-user',
      name: 'Squatter',
      folder: 'main-squatted-user',
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: 0,
      user_id: other.id,
    });

    await expect(createUser('squatted-user', 'pw')).rejects.toBeInstanceOf(
      MainFolderTakenError,
    );
    const rows = await drizzleDbRef.current
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'squatted-user'));
    expect(rows).toHaveLength(0);
  });

  test('archives the orphaned main of a deleted user and creates a fresh main', async () => {
    await drizzleDbRef.current.insert(projects).values({
      id: 'main-gone-user',
      jid: 'main-gone-user',
      name: 'Gone',
      folder: 'main-gone-user',
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: 1,
      user_id: 'deleted-id',
    });
    await loadState();
    await registerGroup('main-gone-user', {
      name: 'Gone',
      folder: 'main-gone-user',
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: true,
      user_id: 'deleted-id',
    });

    const user = await createUser('gone-user', 'pw');
    const [fresh] = await drizzleDbRef.current
      .select({ user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, 'main-gone-user'));
    expect(fresh.user_id).toBe(user.id);

    const archived = await drizzleDbRef.current
      .select({
        id: projects.id,
        jid: projects.jid,
        is_main: projects.is_main,
        user_id: projects.user_id,
      })
      .from(projects)
      .where(like(projects.id, 'archived-main-gone-user-%'));
    expect(archived).toHaveLength(1);
    expect(archived[0].jid).toBe(archived[0].id);
    expect(archived[0].is_main).toBe(1);
    expect(archived[0].user_id).toBeNull();
  });
});
