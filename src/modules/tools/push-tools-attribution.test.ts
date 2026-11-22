import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { logger } from '../../logger.js';
import {
  notifyEntityLifecycle,
  notifyUserSystem,
  pushToUsersIfAllowed,
  resolveNotificationRecipientIds,
  notifyUserTool,
} from './push-tools.js';
import {
  createConversation,
  createTask,
  createUser,
  getPayloadById,
  getUnreadPayloads,
  initDatabase,
  insertActiveRun,
  updateUserAdminStanding,
  updateTask,
  upsertConversationMember,
  upsertProjectMember,
} from '../../db.js';
import { runFixture, taskFixture, truncateTestDb } from '../../test-helpers.js';
import { storePayload } from '../push/payload-store.js';
import { updateConversationPresence } from '../objectives/ws-events.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { conversations, projects } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../../state-manager.js';

beforeAll(() => initDatabase(':memory:'));
beforeEach(() => truncateTestDb());

const authorized = {
  has: (value: string) => ['owner', 'triggerer', 'named'].includes(value),
} as ReadonlySet<string>;

describe('ownership-aware notification recipients', () => {
  test('a named member replaces the owner and triggerer for text notifications', () => {
    expect(
      resolveNotificationRecipientIds({
        ownerUserId: 'owner',
        triggeredByUserId: 'triggerer',
        namedUserId: 'named',
        authorizedUserIds: authorized,
        form: false,
      }).userIds,
    ).toEqual(['named']);
  });

  test('text notifications deduplicate owner and triggerer', () => {
    expect(
      resolveNotificationRecipientIds({
        ownerUserId: 'owner',
        triggeredByUserId: 'owner',
        authorizedUserIds: authorized,
        form: false,
      }).userIds,
    ).toEqual(['owner']);
  });

  test('forms target the triggerer and fall back to the owner', () => {
    expect(
      resolveNotificationRecipientIds({
        ownerUserId: 'owner',
        triggeredByUserId: 'triggerer',
        authorizedUserIds: authorized,
        form: true,
      }).userIds,
    ).toEqual(['triggerer']);
    expect(
      resolveNotificationRecipientIds({
        ownerUserId: 'owner',
        triggeredByUserId: 'removed',
        authorizedUserIds: authorized,
        form: true,
      }).userIds,
    ).toEqual(['owner']);
  });

  test('forms target an authorized direct conversation member triggerer', async () => {
    const owner = await createUser('shared-form-owner', 'pw', 'user');
    const triggerer = await createUser('shared-form-triggerer', 'pw', 'user');
    const project = 'shared-form-project';
    await upsertProjectMember(owner.id, project, 'owner');
    const conversation = await createConversation(project, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });
    await upsertConversationMember(triggerer.id, conversation.id, 'editor');
    const run = runFixture({
      group_folder: project,
      conversation_id: conversation.id,
    });
    run.triggeredByUserId = triggerer.id;
    run.triggerSource = 'user';
    await insertActiveRun(run);

    await notifyUserTool.handler(
      {
        kind: 'json_form',
        summary: 'Shared conversation question',
        content: '{"type":"object","properties":{"answer":{"type":"string"}}}',
        wait: false,
      },
      {} as any,
      {
        group_folder: project,
        conversation_id: conversation.id,
        run_id: run.id,
      },
    );

    expect(await getUnreadPayloads(triggerer.id)).toEqual([
      expect.objectContaining({ summary: 'Shared conversation question' }),
    ]);
    expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
  });

  test('removed users receive nothing', () => {
    expect(
      resolveNotificationRecipientIds({
        ownerUserId: 'removed',
        triggeredByUserId: 'removed',
        namedUserId: 'removed',
        authorizedUserIds: authorized,
        form: false,
      }).userIds,
    ).toEqual([]);
  });

  test('disabled project owners are not authorized notification recipients', async () => {
    const owner = await createUser('disabled-notification-owner', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'disabled-notification-project',
        ownerUserId: owner.id,
        lastTriggeredByUserId: owner.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(owner.id, task.project_id, 'owner');
    await updateUserAdminStanding(owner.id, { disabled: true });

    const result = await notifyUserTool.handler(
      {
        kind: 'text',
        summary: 'Must not deliver',
        content: 'Disabled users are outside the authorization roster.',
      },
      {} as any,
      { group_folder: task.project_id, task_id: task.id },
    );

    expect(result).toMatchObject({ payload_ids: [], delivered_count: 0 });
    expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
  });

  test('a named user gets the notification alone and a not-opted-in one is reported as skipped', async () => {
    const owner = await createUser('named-skip-owner', 'pw', 'user');
    const named = await createUser('named-skip-target', 'pw', 'user');
    const project = 'named-skip-project';
    await drizzleDbRef.current.insert(projects).values({
      id: project,
      jid: `${project}@test`,
      name: project,
      folder: project,
      trigger: 'ai',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });
    await upsertProjectMember(owner.id, project, 'owner');
    await upsertProjectMember(named.id, project, 'editor');
    const conversation = await createConversation(project, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });

    const result = await notifyUserTool.handler(
      {
        kind: 'text',
        summary: 'Only for the named user',
        content: 'Body',
        username: 'named-skip-target',
      },
      {} as any,
      { group_folder: project, conversation_id: conversation.id },
    );

    expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
    expect(await getUnreadPayloads(named.id)).toHaveLength(1);
    expect(result.payload_ids).toHaveLength(1);
    expect(result.skipped).toEqual([
      { username: 'named-skip-target', reason: 'not_opted_in' },
    ]);
    expect(result.note).toBe(
      'no recipient received a push: named-skip-target not_opted_in',
    );
  });

  test('persists an in-app payload even when no push target is available', async () => {
    const user = await createUser('in-app-only-user', 'pw', 'user');
    expect(
      await notifyUserSystem(user.id, 'missing-project', {
        summary: 'In app',
        content: 'Stored without a device or project push opt-in',
        source_id: 'in-app-only:test',
      }),
    ).toBe(true);
    expect(await getUnreadPayloads(user.id)).toEqual([
      expect.objectContaining({ summary: 'In app' }),
    ]);
  });

  test('does not create a lifecycle notification while the conversation is viewed', async () => {
    const owner = await createUser('viewing-conversation-owner', 'pw', 'user');
    const project = 'viewing-conversation-project';
    await upsertProjectMember(owner.id, project, 'owner');
    const conversation = await createConversation(project, {
      ownerUserId: owner.id,
      triggerSource: 'user',
    });
    const run = runFixture({
      group_folder: project,
      conversation_id: conversation.id,
    });
    run.triggeredByUserId = owner.id;
    run.triggerSource = 'user';
    await insertActiveRun(run);
    const client = { __userId: owner.id } as any;
    updateConversationPresence(client, {
      conversation_id: conversation.id,
    });

    try {
      await notifyEntityLifecycle({
        group_folder: project,
        conversation_id: conversation.id,
        run_id: run.id,
        event: 'completed',
        title: 'Conversation completed',
      });

      expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
    } finally {
      updateConversationPresence(client, null);
    }
  });

  test('lifecycle delivery uses the immutable causal run', async () => {
    const owner = await createUser('lifecycle-owner', 'pw', 'user');
    const causal = await createUser('lifecycle-causal', 'pw', 'user');
    const later = await createUser('lifecycle-later', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'lifecycle-project',
        ownerUserId: owner.id,
        lastTriggeredByUserId: causal.id,
        lastTriggerSource: 'user',
      }),
    );
    for (const user of [owner, causal, later]) {
      await upsertProjectMember(user.id, task.project_id, 'editor');
    }
    const run = runFixture({ group_folder: task.project_id, task_id: task.id });
    run.triggeredByUserId = causal.id;
    run.triggerSource = 'user';
    await insertActiveRun(run);
    await updateTask(task.id, {
      lastTriggeredByUserId: later.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: new Date().toISOString(),
    });

    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: run.id,
      event: 'completed',
      title: 'Task completed',
    });

    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
    expect(await getUnreadPayloads(causal.id)).toHaveLength(1);
    expect(await getUnreadPayloads(later.id)).toHaveLength(0);
  });

  test('restricts lifecycle delivery to explicit natural recipients', async () => {
    const owner = await createUser('targeted-lifecycle-owner', 'pw', 'user');
    const triggerer = await createUser(
      'targeted-lifecycle-triggerer',
      'pw',
      'user',
    );
    const task = await createTask(
      taskFixture({
        project_id: 'targeted-lifecycle-project',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(owner.id, task.project_id, 'owner');
    await upsertProjectMember(triggerer.id, task.project_id, 'editor');

    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: 'targeted-manual-attempt',
      event: 'completed',
      title: 'Targeted task completed',
      recipient_user_ids: [owner.id],
    });

    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({ summary: 'Targeted task completed' }),
    ]);
    expect(await getUnreadPayloads(triggerer.id)).toHaveLength(0);
  });

  test('an immutable null run triggerer falls back to the owner, not a later entity triggerer', async () => {
    const owner = await createUser('system-run-owner', 'pw', 'user');
    const later = await createUser('system-run-later', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'system-run-project',
        ownerUserId: owner.id,
        lastTriggeredByUserId: later.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(owner.id, task.project_id, 'editor');
    await upsertProjectMember(later.id, task.project_id, 'editor');
    const run = runFixture({ group_folder: task.project_id, task_id: task.id });
    run.triggeredByUserId = null;
    run.triggerSource = 'system';
    await insertActiveRun(run);

    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: run.id,
      event: 'completed',
      title: 'System task completed',
    });

    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
    expect(await getUnreadPayloads(later.id)).toHaveLength(0);
  });

  test('a missing run row falls back to the entity triggerer', async () => {
    const owner = await createUser('prelaunch-owner', 'pw', 'user');
    const triggerer = await createUser('prelaunch-triggerer', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'prelaunch-project',
        status: 'failed',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(owner.id, task.project_id, 'editor');
    await upsertProjectMember(triggerer.id, task.project_id, 'editor');

    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: 'request-failed-before-active-run',
      event: 'failed',
      title: 'Task failed before launch',
    });

    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
    expect(await getUnreadPayloads(triggerer.id)).toHaveLength(1);
  });

  test('an older pending form does not suppress a new needs-input attempt', async () => {
    const owner = await createUser('new-question-owner', 'pw', 'user');
    const triggerer = await createUser('new-question-triggerer', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'new-question-project',
        status: 'question',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(owner.id, task.project_id, 'editor');
    await upsertProjectMember(triggerer.id, task.project_id, 'editor');
    await storePayload({
      user_id: triggerer.id,
      kind: 'json_form',
      summary: 'Older question',
      content: '{"type":"object","properties":{"answer":{"type":"string"}}}',
      respond_to: { kind: 'task', id: task.id },
      source_tool_use_id: 'notify-form-run:older-run:form-1',
    });
    const run = runFixture({ group_folder: task.project_id, task_id: task.id });
    run.triggeredByUserId = triggerer.id;
    run.triggerSource = 'user';
    await insertActiveRun(run);

    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: run.id,
      event: 'needs_input',
      title: 'New question needs input',
    });

    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
    expect(await getUnreadPayloads(triggerer.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: 'Older question' }),
        expect.objectContaining({ summary: 'Task needs your attention' }),
      ]),
    );
  });

  test('a same-run form suppresses only its recipient generic notification', async () => {
    const owner = await createUser('same-question-owner', 'pw', 'user');
    const triggerer = await createUser('same-question-triggerer', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'same-question-project',
        status: 'question',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(owner.id, task.project_id, 'editor');
    await upsertProjectMember(triggerer.id, task.project_id, 'editor');
    const run = runFixture({ group_folder: task.project_id, task_id: task.id });
    run.triggeredByUserId = triggerer.id;
    run.triggerSource = 'user';
    await insertActiveRun(run);
    await storePayload({
      user_id: triggerer.id,
      kind: 'json_form',
      summary: 'Current question',
      content: '{"type":"object","properties":{"answer":{"type":"string"}}}',
      respond_to: { kind: 'task', id: task.id },
      source_tool_use_id: `notify-form-run:${run.id}:form-1`,
    });

    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: run.id,
      event: 'needs_input',
      title: 'Generic current question',
    });

    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({ summary: 'Task needs your attention' }),
    ]);
    expect(await getUnreadPayloads(triggerer.id)).toEqual([
      expect.objectContaining({ summary: 'Current question' }),
    ]);
  });

  test('rejects an explicit form response target from another project', async () => {
    const owner = await createUser('form-target-owner', 'pw', 'user');
    const current = await createTask(
      taskFixture({
        project_id: 'form-current-project',
        ownerUserId: owner.id,
        lastTriggeredByUserId: owner.id,
        lastTriggerSource: 'user',
      }),
    );
    const foreign = await createTask(
      taskFixture({
        project_id: 'form-foreign-project',
        ownerUserId: owner.id,
      }),
    );
    await upsertProjectMember(owner.id, current.project_id, 'editor');

    await expect(
      notifyUserTool.handler(
        {
          kind: 'json_form',
          summary: 'Unauthorized target',
          content:
            '{"type":"object","properties":{"answer":{"type":"string"}}}',
          wait: false,
          respond_to: { kind: 'task', task_id: foreign.id },
        },
        {} as any,
        {
          group_folder: current.project_id,
          task_id: current.id,
        },
      ),
    ).rejects.toThrow('respond_to task must belong to the current project');
    expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
  });

  test('run-scoped DirectLLM forms ignore unrelated concurrent project runs', async () => {
    const conversationOwner = await createUser(
      'direct-conversation-owner',
      'pw',
      'user',
    );
    const conversationTriggerer = await createUser(
      'direct-conversation-triggerer',
      'pw',
      'user',
    );
    const unrelatedTriggerer = await createUser(
      'direct-unrelated-triggerer',
      'pw',
      'user',
    );
    const project = 'direct-concurrent-project';
    for (const user of [
      conversationOwner,
      conversationTriggerer,
      unrelatedTriggerer,
    ]) {
      await upsertProjectMember(user.id, project, 'editor');
    }

    const unrelatedTask = await createTask(
      taskFixture({
        project_id: project,
        ownerUserId: unrelatedTriggerer.id,
        lastTriggeredByUserId: unrelatedTriggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    const unrelatedRun = runFixture({
      group_folder: project,
      task_id: unrelatedTask.id,
    });
    unrelatedRun.triggeredByUserId = unrelatedTriggerer.id;
    unrelatedRun.triggerSource = 'user';
    await insertActiveRun(unrelatedRun);

    const conversation = await createConversation(project, {
      ownerUserId: conversationOwner.id,
      triggerSource: 'user',
    });
    const conversationRun = runFixture({
      group_folder: project,
      conversation_id: conversation.id,
    });
    conversationRun.triggeredByUserId = conversationTriggerer.id;
    conversationRun.triggerSource = 'user';
    await insertActiveRun(conversationRun);

    await notifyUserTool.handler(
      {
        kind: 'json_form',
        summary: 'Conversation question',
        content: '{"type":"object","properties":{"answer":{"type":"string"}}}',
        wait: false,
      },
      {} as any,
      {
        group_folder: project,
        run_id: conversationRun.id,
      },
    );

    expect(await getUnreadPayloads(conversationTriggerer.id)).toEqual([
      expect.objectContaining({
        summary: 'Conversation question',
      }),
    ]);
    expect(await getUnreadPayloads(conversationOwner.id)).toHaveLength(0);
    expect(await getUnreadPayloads(unrelatedTriggerer.id)).toHaveLength(0);
  });

  test('run-less callers do not borrow an unrelated active run', async () => {
    const projectOwner = await createUser('runless-owner', 'pw', 'user');
    const unrelatedMember = await createUser('runless-unrelated', 'pw', 'user');
    const project = 'runless-project';
    await upsertProjectMember(projectOwner.id, project, 'owner');
    await upsertProjectMember(unrelatedMember.id, project, 'editor');
    const jid = `${project}@test`;
    registeredGroups[jid] = {
      name: project,
      folder: project,
      trigger: 'ai',
      added_at: new Date().toISOString(),
      user_id: projectOwner.id,
    } as (typeof registeredGroups)[string];
    applyGroupUpdateInMemory(jid, {});

    try {
      const unrelatedTask = await createTask(
        taskFixture({
          project_id: project,
          ownerUserId: unrelatedMember.id,
          lastTriggeredByUserId: unrelatedMember.id,
          lastTriggerSource: 'user',
        }),
      );
      const unrelatedRun = runFixture({
        group_folder: project,
        task_id: unrelatedTask.id,
      });
      unrelatedRun.triggeredByUserId = unrelatedMember.id;
      unrelatedRun.triggerSource = 'user';
      await insertActiveRun(unrelatedRun);

      await notifyUserTool.handler(
        { kind: 'text', summary: 'Run-less ping', content: 'Body' },
        {} as any,
        { group_folder: project },
      );

      expect(await getUnreadPayloads(unrelatedMember.id)).toHaveLength(0);
      const ownerPayloads = await getUnreadPayloads(projectOwner.id);
      expect(ownerPayloads).toEqual([
        expect.objectContaining({ summary: 'Run-less ping', action_url: null }),
      ]);
      const stored = await getPayloadById(ownerPayloads[0].id, projectOwner.id);
      expect(stored?.respond_to_kind).toBeNull();
      expect(stored?.respond_to_id).toBeNull();
    } finally {
      delete registeredGroups[jid];
      applyGroupUpdateInMemory(jid, {});
    }
  });

  test('child project owners are notified by run-less and objective-chat callers', async () => {
    const parentOwner = await createUser('child-parent-owner', 'pw', 'user');
    const childOwner = await createUser('child-owner', 'pw', 'user');
    const uiOwner = await createUser('child-ui-owner', 'pw', 'user');
    const insertProject = (
      id: string,
      parentId: string | null,
      owner: string | null,
    ) =>
      drizzleDbRef.current.insert(projects).values({
        id,
        jid: `${id}@test`,
        name: id,
        folder: id,
        trigger: 'ai',
        added_at: new Date().toISOString(),
        parentId,
        user_id: owner,
      });
    await insertProject('child-parent', null, parentOwner.id);
    await insertProject('child-owned', 'child-parent', childOwner.id);
    await insertProject('child-ui', 'child-parent', null);
    await upsertProjectMember(parentOwner.id, 'child-parent', 'owner');
    await upsertProjectMember(uiOwner.id, 'child-ui', 'owner');
    const call = (group_folder: string, conversation_id?: string) =>
      notifyUserTool.handler(
        { kind: 'text', summary: 'Lead', content: 'Body' },
        {} as any,
        { group_folder, conversation_id },
      );

    // Brain (run-less) caller; no in-memory group exists for either child.
    expect((await call('child-owned')).payload_ids).toHaveLength(1);
    expect((await call('child-ui')).payload_ids).toHaveLength(1);
    expect(await getUnreadPayloads(childOwner.id)).toHaveLength(1);
    expect(await getUnreadPayloads(uiOwner.id)).toHaveLength(1);

    // Objective chat owned by a removed user, with no human triggerer: the
    // project owner stands in and the removed owner gets nothing.
    const removed = await createUser('child-removed-owner', 'pw', 'user');
    await updateUserAdminStanding(removed.id, { disabled: true });
    const conv = await createConversation('child-owned', {
      ownerUserId: removed.id,
      triggerSource: 'system',
    });
    await drizzleDbRef.current
      .update(conversations)
      .set({ objective_id: 'obj-1' })
      .where(eq(conversations.id, conv.id));
    expect((await call('child-owned', conv.id)).payload_ids).toHaveLength(1);
    expect(await getUnreadPayloads(childOwner.id)).toHaveLength(2);
    expect(await getUnreadPayloads(removed.id)).toHaveLength(0);

    // The parent's owner is not a recipient, and an unresolvable project says why.
    expect(await getUnreadPayloads(parentOwner.id)).toHaveLength(0);
    const disabledOwner = await createUser(
      'child-disabled-owner',
      'pw',
      'user',
    );
    await insertProject('child-disabled', 'child-parent', null);
    await upsertProjectMember(disabledOwner.id, 'child-disabled', 'owner');
    await updateUserAdminStanding(disabledOwner.id, { disabled: true });
    const rejected = await call('child-disabled');
    expect(rejected.payload_ids).toEqual([]);
    expect(rejected.note).toContain(
      `project owner=${disabledOwner.id} (rejected:`,
    );
    const none = await call('child-missing');
    expect(none.payload_ids).toEqual([]);
    expect(none.note).toContain('group_folder=child-missing');
    expect(none.note).toContain('project owner=none');
  });

  test('an already-aborted form wait resolves after its waiter is registered', async () => {
    const triggerer = await createUser('aborted-form-triggerer', 'pw', 'user');
    const task = await createTask(
      taskFixture({
        project_id: 'aborted-form-project',
        ownerUserId: triggerer.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    await upsertProjectMember(triggerer.id, task.project_id, 'editor');
    const controller = new AbortController();
    controller.abort();

    await expect(
      notifyUserTool.handler(
        {
          kind: 'json_form',
          summary: 'Already aborted',
          content:
            '{"type":"object","properties":{"answer":{"type":"string"}}}',
          wait: true,
          wait_timeout_ms: 5_000,
        },
        {} as any,
        {
          group_folder: task.project_id,
          task_id: task.id,
          signal: controller.signal,
        },
      ),
    ).resolves.toMatchObject({ status: 'aborted' });
  });
});

describe('push transport eligibility boundary', () => {
  const token = {
    device_id: 'device-1',
    platform: 'android',
    token: 'fcm-token',
  };
  const info = spyOn(logger, 'info');
  beforeEach(() => info.mockClear());
  afterAll(() => info.mockRestore());
  const dispatchLogs = () =>
    info.mock.calls
      .filter(([, msg]) => msg === '[push] dispatch')
      .map(([fields]) => fields);

  test('opted-in user with a token dispatches and reports delivery', async () => {
    const calls: string[] = [];
    const result = await pushToUsersIfAllowed('project', 'member', 'payload', {
      resolveEligibility: async () => ({ allowed: true, user_id: 'member' }),
      loadTokens: async () => [token],
      sendPing: async (tokens, ref) => {
        calls.push(`${tokens[0].device_id}:${ref}`);
        return { delivered: ['device-1'], stale: [], failed: [] };
      },
      deleteStaleTokens: async () => {},
    });

    expect(calls).toEqual(['device-1:payload']);
    expect(result).toEqual({ delivered_count: 1, stale_count: 0 });
    expect(dispatchLogs()).toEqual([
      {
        ref: 'payload',
        group_folder: 'project',
        user_id: 'member',
        outcome: 'sent',
        token_count: 1,
        delivered_count: 1,
        stale_count: 0,
      },
    ]);
  });

  test('opted-out user does not dispatch', async () => {
    let sent = false;
    const result = await pushToUsersIfAllowed('project', 'member', 'payload', {
      resolveEligibility: async () => ({
        allowed: false,
        reason: 'not_opted_in',
      }),
      loadTokens: async () => [token],
      sendPing: async () => {
        sent = true;
        return { delivered: [], stale: [], failed: [] };
      },
      deleteStaleTokens: async () => {},
    });

    expect(sent).toBe(false);
    expect(result).toEqual({ delivered_count: 0, stale_count: 0 });
    expect(dispatchLogs()).toEqual([
      {
        ref: 'payload',
        group_folder: 'project',
        user_id: 'member',
        outcome: 'ineligible',
        reason: 'not_opted_in',
        token_count: 0,
        delivered_count: 0,
        stale_count: 0,
      },
    ]);
  });

  test('does not push to a device currently viewing the conversation', async () => {
    let sent = false;
    const result = await pushToUsersIfAllowed(
      'project',
      'member',
      'payload',
      {
        resolveEligibility: async () => ({ allowed: true, user_id: 'member' }),
        loadTokens: async () => [token],
        sendPing: async () => {
          sent = true;
          return { delivered: [], stale: [], failed: [] };
        },
        deleteStaleTokens: async () => {},
      },
      new Set(['device-1']),
    );

    expect(sent).toBe(false);
    expect(result).toEqual({ delivered_count: 0, stale_count: 0 });
    expect(dispatchLogs()).toMatchObject([
      { outcome: 'no_tokens', token_count: 0 },
    ]);
  });
});

describe('notify_user action_url', () => {
  async function notifyFrom(
    name: string,
    makeContext: (
      project: string,
      ownerId: string,
    ) => Promise<{ task_id?: string; conversation_id?: string }>,
  ) {
    const owner = await createUser(`${name}-owner`, 'pw', 'user');
    const project = `${name}-project`;
    await upsertProjectMember(owner.id, project, 'owner');
    const ctx = await makeContext(project, owner.id);
    await notifyUserTool.handler(
      {
        kind: 'text',
        summary: 'Brief',
        content: 'Body',
        username: `${name}-owner`,
      },
      {} as any,
      { group_folder: project, ...ctx },
    );
    const [item] = await getUnreadPayloads(owner.id);
    return { project, item, ctx };
  }

  test('objective conversation links to the objective page', async () => {
    const { project, item } = await notifyFrom(
      'url-objective',
      async (p, o) => {
        const conv = await createConversation(p, {
          ownerUserId: o,
          triggerSource: 'user',
        });
        await drizzleDbRef.current
          .update(conversations)
          .set({ objective_id: 'obj-1' })
          .where(eq(conversations.id, conv.id));
        return { conversation_id: conv.id };
      },
    );
    expect(item.action_url).toBe(`/objective/${project}/obj-1`);
  });

  test('plain chat links to the conversation', async () => {
    const { project, item, ctx } = await notifyFrom(
      'url-chat',
      async (p, o) => ({
        conversation_id: (
          await createConversation(p, { ownerUserId: o, triggerSource: 'user' })
        ).id,
      }),
    );
    expect(item.action_url).toBe(
      `/chat/${project}?conversationId=${ctx.conversation_id}`,
    );
  });

  test('task run links to the board card', async () => {
    const { project, item, ctx } = await notifyFrom(
      'url-task',
      async (p, o) => ({
        task_id: (
          await createTask(
            taskFixture({
              project_id: p,
              ownerUserId: o,
              lastTriggeredByUserId: o,
              lastTriggerSource: 'user',
            }),
          )
        ).id,
      }),
    );
    expect(item.action_url).toBe(`/board/${project}?taskId=${ctx.task_id}`);
  });

  test('no run context stores no action_url', async () => {
    const { item } = await notifyFrom('url-none', async () => ({}));
    expect(item.action_url).toBeNull();
  });

  describe('action_path', () => {
    async function notifyWithPath(name: string, actionPath: string) {
      const owner = await createUser(`${name}-owner`, 'pw', 'user');
      const project = `${name}-project`;
      await upsertProjectMember(owner.id, project, 'owner');
      const notify = (path: string) =>
        notifyUserTool.handler(
          {
            kind: 'text',
            summary: 'Brief',
            content: 'Body',
            username: `${name}-owner`,
            action_path: path.replaceAll('{project}', project),
          },
          {} as any,
          { group_folder: project },
        );
      return { owner, project, notify: () => notify(actionPath) };
    }

    test('valid path inside the own project is stored exactly', async () => {
      const { owner, project, notify } = await notifyWithPath(
        'url-path-ok',
        '/objective/{project}/obj-1?report=a.md',
      );
      await notify();
      const [item] = await getUnreadPayloads(owner.id);
      expect(item.action_url).toBe(`/objective/${project}/obj-1?report=a.md`);
    });

    test.each([
      '/objective/other-project/obj-1?report=a.md',
      'https://example.com/objective/{project}/obj-1',
      '//evil.example/objective/{project}/obj-1',
      '/objective/{project}/../x',
      '/objective/{project}/%2e%2e/x',
      '/objective/{project}\\obj-1',
      '/objective/{project}/obj-1#frag',
      '/settings',
    ])('rejects %s and stores nothing', async (bad) => {
      const { owner, notify } = await notifyWithPath('url-path-bad', bad);
      await expect(notify()).rejects.toThrow(/Invalid action_path/);
      expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
    });
  });
});
