import { describe, expect, test } from 'bun:test';

import { getAgentPermissions, type McpServerDeps } from '../../mcp/auth.js';
import { createIdleRestartManager } from '../../sandbox/idle-restart.js';
import type { RegisteredGroup } from '../../types.js';
import {
  createSandboxRestartWhenIdleTool,
  SANDBOX_RESTART_COOLDOWN_MS,
} from './tools.js';

function group(
  folder: string,
  parentId?: string,
  settings?: RegisteredGroup['settings'],
): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@test',
    added_at: new Date().toISOString(),
    parentId,
    settings,
  };
}

const parent = group('parent', undefined, { isParent: true });
const child = group('child', 'parent');
const other = group('other');
const sharedOwner = group('shared-owner', undefined, {
  isParent: true,
  sandboxOwnership: 'shared',
});
const sharedChild = group('shared-child', 'shared-owner');
const groups = Object.fromEntries(
  [parent, child, other, sharedOwner, sharedChild].map((g) => [g.folder, g]),
);
const deps = {
  getRegisteredGroups: () => groups,
} as unknown as McpServerDeps;

function ctx(
  folder: string,
  extra: { task_id?: string; permissions?: Record<string, string[]> } = {},
) {
  return {
    group_folder: folder,
    conversation_id: 'conv-1',
    run_id: 'run-1',
    permissions: getAgentPermissions(groups[folder]!, groups),
    ...extra,
  };
}

function setup() {
  const state = { taskRuns: 1, now: Date.parse('2026-01-01T00:00:00Z') };
  const events: Array<Record<string, unknown>> = [];
  const manager = createIdleRestartManager({
    countTaskRuns: async () => state.taskRuns,
    countChatRuns: async () => 0,
    countHolds: async () => 0,
    listGroups: () => [],
    resolveBrainContainer: (() => undefined) as never,
    resolveTarget: (pending) => pending.target,
    restart: async () => true,
    drainProjectQueue: async () => {},
    broadcast: ((event: { payload: Record<string, unknown> }) => {
      events.push(event.payload);
    }) as never,
    schedule: () => () => {},
    now: () => new Date(state.now),
  });
  const tool = createSandboxRestartWhenIdleTool({
    request: manager.requestIdleRestart,
    cancel: manager.cancelIdleRestart,
    getPending: manager.getPendingIdleRestart,
    isPending: manager.isIdleRestartPending,
    getLastRestartAt: manager.getLastRestartAt,
    getWaitingOn: manager.getIdleRestartWaitingOn,
    countHolds: async () => 0,
    willTerminate: () => ({ tmuxSessions: 2 }),
    now: () => state.now,
  });
  const run = async (
    args: Record<string, unknown>,
    context = ctx('child'),
  ): Promise<Record<string, any>> =>
    JSON.parse(await tool.handler(args, deps, context));
  return { state, events, manager, tool, run };
}

describe('sandbox_restart_when_idle', () => {
  test('own folder: request, status and cancel', async () => {
    const t = setup();
    const requested = await t.run({ action: 'request', reason: 'free disk' });
    expect(requested).toMatchObject({
      alreadyPending: false,
      reason: 'free disk',
      requestedBy: {
        groupFolder: 'child',
        conversationId: 'conv-1',
        runId: 'run-1',
      },
    });
    expect(t.events[0]).toMatchObject({
      action: 'restart_pending',
      source: 'mcp',
      reason: 'free disk',
      requestedBy: 'child',
    });
    expect(await t.run({ action: 'status' })).toMatchObject({
      pending: true,
      reason: 'free disk',
      waitingOn: { taskRuns: 1, chatRuns: 0, brainRuns: 0 },
      willTerminate: { tmuxSessions: 2 },
    });
    expect(await t.run({ action: 'cancel' })).toEqual({ cancelled: true });
    expect((await t.run({ action: 'status' })).pending).toBe(false);
    expect(await t.run({ action: 'cancel' })).toEqual({ cancelled: false });
  });

  test('status of a held pending restart reports held and heldSince', async () => {
    const t = setup();
    await t.run({ action: 'request', reason: 'free disk' });
    const entry = t.manager.getPendingIdleRestart('child')!;
    expect((await t.run({ action: 'status' })).held).toBe(false);
    entry.heldSince = '2026-01-01T00:05:00.000Z';
    expect(await t.run({ action: 'status' })).toMatchObject({
      pending: true,
      held: true,
      heldSince: '2026-01-01T00:05:00.000Z',
    });
  });

  test('parent may target a direct child; an unrelated project is rejected', async () => {
    const t = setup();
    await t.run(
      { action: 'request', target_project: 'child', reason: 'parent asks' },
      ctx('parent'),
    );
    expect(t.manager.getPendingIdleRestart('child')?.requestedBy).toBe(
      'parent',
    );
    await expect(
      t.run({ action: 'status', target_project: 'other' }, ctx('parent')),
    ).rejects.toThrow('sandbox:restart');
  });

  test('task runs are rejected for every action', async () => {
    const t = setup();
    for (const action of ['request', 'cancel', 'status']) {
      await expect(
        t.run(
          { action, reason: 'from a task' },
          ctx('child', { task_id: 't' }),
        ),
      ).rejects.toThrow('not available to task runs');
    }
  });

  test('a child cannot restart a shared instance; its owner can', async () => {
    const t = setup();
    const childWithOwnerPerm = ctx('shared-child', {
      permissions: {
        'shared-child': ['sandbox:restart'],
        'shared-owner': ['sandbox:restart'],
      },
    });
    await expect(
      t.run({ action: 'request', reason: 'noisy sibling' }, childWithOwnerPerm),
    ).rejects.toThrow('shared');
    await t.run(
      { action: 'request', reason: 'owner restart' },
      ctx('shared-owner'),
    );
    expect(
      (await t.run({ action: 'status' }, ctx('shared-owner'))).pending,
    ).toBe(true);
  });

  test('second request keeps the pending entry; a recent restart enforces the cooldown', async () => {
    const t = setup();
    const first = await t.run({ action: 'request', reason: 'first request' });
    t.state.now += 1000;
    const second = await t.run({ action: 'request', reason: 'second request' });
    expect(second).toMatchObject({
      alreadyPending: true,
      requestedAt: first.requestedAt,
      reason: 'first request',
    });

    // Idle now: the pending restart runs and starts the cooldown.
    t.state.taskRuns = 0;
    await t.manager.poll();
    expect(t.manager.getPendingIdleRestart('child')).toBeUndefined();
    const status = await t.run({ action: 'status' });
    expect(status.lastRestartAt).toBeDefined();
    expect(status.cooldownRemainingMs).toBe(SANDBOX_RESTART_COOLDOWN_MS);
    await expect(
      t.run({ action: 'request', reason: 'again please' }),
    ).rejects.toThrow('try again in 600s');

    t.state.now += SANDBOX_RESTART_COOLDOWN_MS;
    t.state.taskRuns = 1;
    expect(
      (await t.run({ action: 'request', reason: 'after cooldown' }))
        .alreadyPending,
    ).toBe(false);
  });

  test('request requires a reason of 3-300 characters', async () => {
    const t = setup();
    await expect(t.run({ action: 'request' })).rejects.toThrow('reason');
    await expect(t.run({ action: 'request', reason: 'no' })).rejects.toThrow(
      'reason',
    );
    expect((await t.run({ action: 'status' })).pending).toBe(false);
  });
});
