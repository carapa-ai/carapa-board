import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createConversation,
  deleteAiUserRow,
  deleteAiUserTeamRow,
  getAiUserRow,
  getAiUserTeamRow,
  initDatabase,
  insertAiUserRow,
  insertAiUserTeamRow,
  inviteConversationAiUser,
  inviteConversationAiUserTeam,
  listConversationAiUserRows,
  replaceAiUserTeamMembers,
  setConversationAiUserStatus,
  setMainConversationAiUser,
} from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import { inviteProjectDefaultAiUsers } from './project-default-invitations.js';

const now = '2026-08-01T00:00:00.000Z';

async function addPersona(id: string, enabled = 1) {
  await insertAiUserRow({
    id,
    name: id,
    presetId: 'fast',
    promptPath: `ai-users/${id}/prompt.md`,
    avatarPath: null,
    identity: id,
    turn: 'after',
    tools: [],
    enabled,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
});

afterAll(async () => {
  await truncateTestDb();
});

describe('AI user teams', () => {
  test('supports many-to-many membership and preserves personas when a team is deleted', async () => {
    await addPersona('team-persona-a');
    await addPersona('team-persona-b');
    await insertAiUserTeamRow({
      id: 'team-alpha',
      name: 'Alpha',
      description: 'First team',
      createdAt: now,
      updatedAt: now,
    });
    await insertAiUserTeamRow({
      id: 'team-beta',
      name: 'Beta',
      description: 'Second team',
      createdAt: now,
      updatedAt: now,
    });
    await replaceAiUserTeamMembers('team-alpha', [
      'team-persona-a',
      'team-persona-b',
    ]);
    await replaceAiUserTeamMembers('team-beta', ['team-persona-a']);

    expect((await getAiUserTeamRow('team-alpha'))?.memberIds).toEqual([
      'team-persona-a',
      'team-persona-b',
    ]);
    expect((await getAiUserTeamRow('team-beta'))?.memberIds).toEqual([
      'team-persona-a',
    ]);
    await deleteAiUserTeamRow('team-alpha');
    expect(await getAiUserTeamRow('team-alpha')).toBeUndefined();
    expect(await getAiUserRow('team-persona-a')).toBeTruthy();
    expect((await getAiUserTeamRow('team-beta'))?.memberIds).toEqual([
      'team-persona-a',
    ]);
  });

  test('enforces globally unique team names', async () => {
    await insertAiUserTeamRow({
      id: 'team-unique-a',
      name: 'Unique team',
      description: '',
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      insertAiUserTeamRow({
        id: 'team-unique-b',
        name: 'Unique team',
        description: '',
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  test('bulk invitation is additive and skips disabled, main, active, and paused members', async () => {
    for (const [id, enabled] of [
      ['bulk-new', 1],
      ['bulk-disabled', 0],
      ['bulk-main', 1],
      ['bulk-active', 1],
      ['bulk-paused', 1],
    ] as const)
      await addPersona(id, enabled);
    await insertAiUserTeamRow({
      id: 'team-bulk',
      name: 'Bulk team',
      description: '',
      createdAt: now,
      updatedAt: now,
    });
    await replaceAiUserTeamMembers('team-bulk', [
      'bulk-new',
      'bulk-disabled',
      'bulk-main',
      'bulk-active',
      'bulk-paused',
    ]);
    const conversation = await createConversation('team-test-group');
    await setMainConversationAiUser(conversation.id, {
      mode: 'persona',
      aiUserId: 'bulk-main',
    });
    await inviteConversationAiUser(conversation.id, 'bulk-active', null);
    await inviteConversationAiUser(conversation.id, 'bulk-paused', null);
    await setConversationAiUserStatus(conversation.id, 'bulk-paused', 'paused');

    const result = await inviteConversationAiUserTeam(
      conversation.id,
      'team-bulk',
      null,
      'bulk-main',
    );
    expect(result.invitedIds).toEqual(['bulk-new']);
    expect(new Set(result.skippedIds)).toEqual(
      new Set(['bulk-disabled', 'bulk-main', 'bulk-active', 'bulk-paused']),
    );
    const memberships = await listConversationAiUserRows(conversation.id);
    expect(
      memberships.find(({ aiUser }) => aiUser.id === 'bulk-paused')?.membership
        .status,
    ).toBe('paused');
    expect(
      (
        await inviteConversationAiUserTeam(
          conversation.id,
          'team-bulk',
          null,
          'bulk-main',
        )
      ).invitedIds,
    ).toEqual([]);
  });

  test('expands current project defaults into active invitations', async () => {
    for (const [id, enabled] of [
      ['defaults-main', 1],
      ['defaults-direct', 1],
      ['defaults-shared', 1],
      ['defaults-team-only', 1],
      ['defaults-disabled', 0],
      ['defaults-deleted', 1],
      ['defaults-later-team-member', 1],
    ] as const)
      await addPersona(id, enabled);
    await insertAiUserTeamRow({
      id: 'defaults-team',
      name: 'Project defaults team',
      description: '',
      createdAt: now,
      updatedAt: now,
    });
    await replaceAiUserTeamMembers('defaults-team', [
      'defaults-main',
      'defaults-shared',
      'defaults-team-only',
      'defaults-disabled',
    ]);
    await deleteAiUserRow('defaults-deleted');
    const group = {
      name: 'Defaults',
      folder: 'project-defaults',
      trigger: '!',
      added_at: now,
      settings: {
        defaultMainAiUserId: 'defaults-main',
        defaultInvitedAiUserIds: [
          'defaults-direct',
          'defaults-shared',
          'defaults-main',
          'defaults-disabled',
          'defaults-deleted',
        ],
        defaultInvitedAiUserTeamIds: ['defaults-team', 'deleted-team'],
      },
    };
    const first = await createConversation(group.folder);
    await inviteProjectDefaultAiUsers(first.id, group, 'inviter');
    const firstInvitations = await listConversationAiUserRows(first.id);
    expect(firstInvitations.map(({ aiUser }) => aiUser.id).sort()).toEqual([
      'defaults-direct',
      'defaults-shared',
      'defaults-team-only',
    ]);
    expect(
      firstInvitations.every(
        ({ membership }) => membership.status === 'active',
      ),
    ).toBe(true);

    await replaceAiUserTeamMembers('defaults-team', [
      'defaults-later-team-member',
    ]);
    const second = await createConversation(group.folder);
    await inviteProjectDefaultAiUsers(second.id, group, 'inviter');
    expect(
      (await listConversationAiUserRows(second.id))
        .map(({ aiUser }) => aiUser.id)
        .sort(),
    ).toEqual([
      'defaults-direct',
      'defaults-later-team-member',
      'defaults-shared',
    ]);
  });
});
