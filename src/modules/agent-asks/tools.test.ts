import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import * as db from '../../db.js';
import {
  ConversationWorktreeTransitionInProgressError,
  createConversation,
  getChatMessages,
  getConversation,
  getConversations,
  initDatabase,
  saveChatMessage,
} from '../../db.js';
import { insertActiveRun } from '../../db/active-runs.js';
import { getDefaultRuntimeSelection } from '../../lib/chat-agents.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { agentAsks } from '../../db/schema.js';
import { mountMcpRoutes } from '../../mcp/mcp-server.js';
import { verifyToken } from '../../mcp/auth-tokens.js';
import { mintRunScopedAgentToken } from '../../sandbox/process.js';
import {
  getGroupByFolder,
  loadState,
  registeredGroups,
} from '../../state-manager.js';
import { runFixture } from '../../test-helpers.js';
import {
  getConversationMembers,
  upsertConversationMember,
} from '../knowledge/db-kb.js';
import { createObjective } from '../objectives/db-objectives.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import * as router from '../push/form-response-router.js';
import type { StartConversationTurnInput } from '../push/form-response-router.js';
import {
  failPendingAgentAsk,
  getAgentAsk,
  insertAgentAsk,
} from './db-agent-asks.js';
import { settleAgentAsksAfterTurn } from './delivery.js';
import { createAskProjectAgentTool } from './tools.js';

const ownerId = 'ask-owner';
const strangerId = 'ask-stranger';
const adminId = 'ask-admin';
const adminMainId = 'ask-admin-main';
const ownerlessId = 'ask-ownerless';
const mainId = 'ask-main';
const targetId = 'ask-target';
const viewerProjectId = 'ask-viewer-project';
const parentId = 'ask-parent';
const childId = 'ask-child';
const siblingId = 'ask-sibling';
const grandchildId = 'ask-grandchild';

const started: StartConversationTurnInput[] = [];
const busyConversations = new Set<string>();
const tool = createAskProjectAgentTool({
  startTurn: async (input) => {
    started.push(input);
    return 'started';
  },
  now: () => Date.parse('2026-11-04T12:00:00.000Z'),
  isConversationBusy: async (_folder, conversationId) =>
    busyConversations.has(conversationId),
});
const deps = {} as McpServerDeps;

async function countAsks(callerProjectId: string): Promise<number> {
  const rows = await drizzleDbRef.current
    .select({ n: count() })
    .from(agentAsks)
    .where(eq(agentAsks.callerProjectId, callerProjectId));
  return rows[0]?.n ?? 0;
}

const chatWrite = (...folders: string[]) =>
  Object.fromEntries(folders.map((folder) => [folder, ['chat:write']]));

async function conversationOf(folder: string) {
  return createConversation(folder, {
    ownerUserId: ownerId,
    triggerSource: 'user',
  });
}

describe('ask_project_agent', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('${ownerId}', '${ownerId}', 'test', 'user', '${now}'),
              ('${strangerId}', '${strangerId}', 'test', 'user', '${now}'),
              ('${adminId}', '${adminId}', 'test', 'admin', '${now}')`,
    );
    const project = (
      id: string,
      opts: {
        main?: boolean;
        parent?: string;
        settings?: object;
        owner?: string | null;
      } = {},
    ) =>
      `('${id}', '${id}@web', 'Name of ${id}', '${id}', '!', '${now}', ${opts.main ? 1 : 0}, ${opts.owner === null ? 'NULL' : `'${opts.owner ?? ownerId}'`}, ${opts.parent ? `'${opts.parent}'` : 'NULL'}, ${opts.settings ? `'${JSON.stringify(opts.settings)}'` : 'NULL'})`;
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main, user_id, parent_id, settings)
       VALUES ${[
         project(mainId, { main: true }),
         project(targetId),
         project(viewerProjectId),
         project(parentId, { settings: { isParent: true } }),
         project(childId, { parent: parentId }),
         project(siblingId, { parent: parentId }),
         project(grandchildId, { parent: childId }),
         project(adminMainId, { main: true, owner: adminId }),
         project(ownerlessId, { owner: null }),
       ].join(',')}`,
    );
    await loadState();
  });

  test('a run-scoped MCP call keeps the source chat as the reply destination over reply_to_objective_id', async () => {
    const callerConversation = await conversationOf(mainId);
    const objective = await createObjective({
      project_id: mainId,
      title: 'Objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
    });
    const run = runFixture({
      group_folder: mainId,
      conversation_id: callerConversation.id,
    });
    await insertActiveRun(run);
    const token = await mintRunScopedAgentToken(
      getGroupByFolder(mainId)!,
      { conversation_id: callerConversation.id },
      run.id,
    );

    const startSpy = spyOn(
      router,
      'startConversationTurnForMessage',
    ).mockResolvedValue('started');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tokenScope =
        verifyToken(req.headers.authorization?.replace('Bearer ', '') ?? '') ??
        undefined;
      next();
    });
    mountMcpRoutes(app, {
      getRegisteredGroups: () => registeredGroups,
    } as McpServerDeps);
    const server = app.listen(0);
    const client = new Client({ name: 'ask-test', version: '1' });
    try {
      await new Promise<void>((r) => server.once('listening', () => r()));
      const { port } = server.address() as { port: number };
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp/carapa-board`),
          { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
        ),
      );
      const response = (await client.callTool({
        name: 'ask_project_agent',
        arguments: {
          project_id: targetId,
          prompt: 'Please check the build.',
          reply_to_objective_id: objective.id,
        },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(response.isError).toBeFalsy();
      const asked = JSON.parse(response.content[0]!.text);

      expect(await getAgentAsk(asked.ask_id)).toMatchObject({
        callerConversationId: callerConversation.id,
        callerObjectiveId: objective.id,
        callerRunId: run.id,
      });

      await saveChatMessage({
        group_folder: targetId,
        role: 'assistant',
        content: 'Build is green.',
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: asked.conversation_id,
      });
      const answerTurns: StartConversationTurnInput[] = [];
      const objectiveEvents: unknown[] = [];
      await settleAgentAsksAfterTurn(
        {
          group_folder: targetId,
          conversation_id: asked.conversation_id,
          event: 'completed',
        },
        {
          isConversationBusy: async () => false,
          startTurn: async (input) => {
            answerTurns.push(input);
            return 'started';
          },
          publishEvent: async (...args) => {
            objectiveEvents.push(args);
            return 'delivered';
          },
        },
      );

      expect(answerTurns).toHaveLength(1);
      expect(answerTurns[0]).toMatchObject({
        group_folder: mainId,
        conversation_id: callerConversation.id,
      });
      expect(objectiveEvents).toHaveLength(0);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((r) => server.close(() => r()));
      startSpy.mockRestore();
    }
  });

  test('a per-user main starts an attributed conversation owned by the human', async () => {
    const callerConversation = await conversationOf(mainId);
    const result = await tool.handler(
      { project_id: targetId, prompt: 'Please check the build.' },
      deps,
      {
        group_folder: mainId,
        conversation_id: callerConversation.id,
        permissions: chatWrite(targetId),
      },
    );

    expect(result).toMatchObject({
      project_id: targetId,
      status: 'pending',
      url: `/chat/${targetId}?conversationId=${result.conversation_id}`,
    });
    const conversation = await getConversation(result.conversation_id);
    expect(conversation).toMatchObject({
      group_folder: targetId,
      ownerUserId: ownerId,
      lastTriggerSource: 'agent',
      lastTriggeredByUserId: ownerId,
    });
    expect(
      (await getConversationMembers(result.conversation_id)).map((m: any) => [
        m.user_id,
        m.access_level,
      ]),
    ).toEqual([[ownerId, 'owner']]);
    expect(
      (await getConversations(targetId, 10, 0, { ownerUserId: ownerId })).map(
        (c) => c.id,
      ),
    ).toContain(result.conversation_id);

    const [message] = await getChatMessages(
      targetId,
      10,
      result.conversation_id,
    );
    expect(message).toMatchObject({
      role: 'user',
      source: 'agent',
      content: 'Please check the build.',
      sender_name: `Capa (Name of ${mainId}) for ${ownerId}`,
    });
    expect(message.senderUserId).toBeFalsy();

    const ask = await getAgentAsk(result.ask_id);
    expect(ask).toMatchObject({
      callerProjectId: mainId,
      callerConversationId: callerConversation.id,
      targetConversationId: result.conversation_id,
      askMessageId: message.id,
      ownerUserId: ownerId,
      status: 'pending',
    });
    const start = started.at(-1)!;
    expect(start).toMatchObject({
      group_folder: targetId,
      conversation_id: result.conversation_id,
      leaseOwnerId: `ask:${result.ask_id}`,
      attribution: {
        senderUserId: null,
        triggeredByUserId: ownerId,
        triggerSource: 'agent',
      },
    });
    expect(start.prompt).toEndWith('Please check the build.');
    // The caller's answer turn sends the one push.
    expect(start.lifecycleRecipientUserIds).toEqual([]);
    expect(start.prompt).toContain(`not written by ${ownerId}`);
  });

  test('an admin human needs explicit access to a project owned by another user, but not to an ownerless one', async () => {
    const adminConversation = await createConversation(adminMainId, {
      ownerUserId: adminId,
      triggerSource: 'user',
    });
    const context = {
      group_folder: adminMainId,
      conversation_id: adminConversation.id,
      permissions: chatWrite(targetId, ownerlessId),
    };
    const countBefore = (await getConversations(targetId, 100)).length;
    await expect(
      tool.handler({ project_id: targetId, prompt: 'Hello' }, deps, context),
    ).rejects.toThrow(/no editor access/);
    expect((await getConversations(targetId, 100)).length).toBe(countBefore);

    const open = await tool.handler(
      { project_id: ownerlessId, prompt: 'Hello' },
      deps,
      context,
    );
    expect(open).toMatchObject({ project_id: ownerlessId, status: 'pending' });

    // Explicit editor access is what lets the admin ask the other user's project.
    await db.upsertProjectMember(adminId, targetId, 'editor');
    const member = await tool.handler(
      { project_id: targetId, prompt: 'Hello' },
      deps,
      context,
    );
    expect(member).toMatchObject({ project_id: targetId, status: 'pending' });
  });

  test('a context-less caller names its running chat as the reply destination', async () => {
    const chat = await conversationOf(mainId);
    const context = { group_folder: mainId, permissions: chatWrite(targetId) };
    const ask = (reply_to_conversation_id: string) =>
      tool.handler(
        { project_id: targetId, prompt: 'Hello', reply_to_conversation_id },
        deps,
        context,
      );
    const otherOwner = await createConversation(mainId, {
      ownerUserId: strangerId,
      triggerSource: 'user',
    });
    const ownerless = await conversationOf(mainId);
    await (
      (drizzleDbRef.current as any).$client as {
        exec: (sql: string) => Promise<unknown>;
      }
    ).exec(
      `UPDATE conversations SET owner_user_id = NULL WHERE id = '${ownerless.id}'`,
    );
    const askedChat = await conversationOf(mainId);
    const hopAsk = await insertAgentAsk({
      callerProjectId: targetId,
      callerName: 'Capa',
      targetProjectId: mainId,
      targetConversationId: askedChat.id,
      askMessageId: 'msg-reply-hop',
      status: 'pending',
    });
    const refusals: [string, string, RegExp][] = [
      ['unknown', 'no-such-conversation', /not found/],
      [
        'another project',
        (await conversationOf(targetId)).id,
        /not a conversation of the calling project/,
      ],
      ['other owner', otherOwner.id, /not owned by the human owner/],
      ['null owner', ownerless.id, /not owned by the human owner/],
      ['idle', chat.id, /no turn in progress/],
      ['ask target', askedChat.id, /cannot ask further/],
    ];
    busyConversations.add(otherOwner.id).add(ownerless.id).add(askedChat.id);
    const asksBefore = await countAsks(mainId);
    for (const [name, id, message] of refusals) {
      await expect(ask(id), name).rejects.toThrow(message);
    }
    expect(await countAsks(mainId)).toBe(asksBefore);
    // The inbound ask only served the hop-limit row; settle it for the context-less guard.
    await failPendingAgentAsk(hopAsk.id, 'test');

    busyConversations.add(chat.id);
    const result = await ask(chat.id);
    busyConversations.delete(chat.id);
    expect(await getAgentAsk(result.ask_id)).toMatchObject({
      callerConversationId: chat.id,
      callerObjectiveId: null,
    });
    await failPendingAgentAsk(result.ask_id, 'test');
  });

  test('refuses and creates nothing', async () => {
    const mainConversation = await conversationOf(mainId);
    const objective = await createObjective({
      project_id: mainId,
      title: 'Objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
    });
    // An agent that was itself asked (hop limit) and a pending inbound ask.
    const askedConversation = await conversationOf(mainId);
    await insertAgentAsk({
      callerProjectId: targetId,
      callerName: 'Capa',
      targetProjectId: mainId,
      targetConversationId: askedConversation.id,
      askMessageId: 'msg-hop',
      status: 'pending',
    });
    const mainContext = {
      group_folder: mainId,
      conversation_id: mainConversation.id,
      permissions: chatWrite(targetId, siblingId, parentId),
    };
    const args = { project_id: targetId, prompt: 'Hello' };
    const rows: [string, RegExp, string, object, object][] = [
      [
        'child to parent',
        /Unauthorized/,
        childId,
        { ...args, project_id: parentId },
        { conversation_id: (await conversationOf(childId)).id },
      ],
      [
        'sibling to sibling',
        /Unauthorized/,
        siblingId,
        { ...args, project_id: childId },
        { conversation_id: (await conversationOf(siblingId)).id },
      ],
      [
        'task run',
        /task runs/,
        mainId,
        args,
        { task_id: 'task-1', conversation_id: mainConversation.id },
      ],
      [
        'viewer-narrowed permissions',
        /chat:write/,
        mainId,
        { ...args, project_id: viewerProjectId },
        { permissions: { [viewerProjectId]: ['chat:read'] } },
      ],
      [
        'hop limit',
        /cannot ask further/,
        mainId,
        args,
        { conversation_id: askedConversation.id },
      ],
      [
        'context-less token with a pending inbound ask',
        /pending ask from another project/,
        mainId,
        { ...args, reply_to_objective_id: objective.id },
        { conversation_id: undefined },
      ],
    ];

    for (const [name, message, caller, callArgs, override] of rows) {
      const countBefore = (await getConversations(targetId, 100)).length;
      const asksBefore = await countAsks(caller);
      const startedBefore = started.length;
      await expect(
        tool.handler(callArgs, deps, {
          ...mainContext,
          group_folder: caller,
          permissions: chatWrite(targetId, siblingId, parentId, childId),
          ...override,
        } as any),
        name,
      ).rejects.toThrow(message);
      expect(
        (await getConversations(targetId, 100)).length,
        `${name}: conversations`,
      ).toBe(countBefore);
      expect(await countAsks(caller), `${name}: asks`).toBe(asksBefore);
      expect(started.length, `${name}: turns`).toBe(startedBefore);
    }
  });

  test('continues an existing conversation only where the owner may post', async () => {
    const context = {
      group_folder: mainId,
      conversation_id: (await conversationOf(mainId)).id,
      permissions: chatWrite(targetId),
    };
    const ask = (conversation_id: string) =>
      tool.handler(
        { project_id: targetId, prompt: 'Continue this', conversation_id },
        deps,
        context,
      );
    const humanChat = await conversationOf(targetId);
    await upsertConversationMember(ownerId, humanChat.id, 'viewer');
    const countBefore = (await getConversations(targetId, 100)).length;
    const startedBefore = started.length;

    await expect(ask(humanChat.id)).rejects.toThrow(/no write access/);
    await expect(
      ask((await conversationOf(viewerProjectId)).id),
    ).rejects.toThrow(/not a project conversation/);
    expect(started.length).toBe(startedBefore);
    expect(await getChatMessages(targetId, 10, humanChat.id)).toHaveLength(0);

    await upsertConversationMember(ownerId, humanChat.id, 'editor');
    busyConversations.add(humanChat.id);
    await expect(ask(humanChat.id)).rejects.toThrow(/turn in progress/);
    expect(started.length).toBe(startedBefore);
    expect(await getChatMessages(targetId, 10, humanChat.id)).toHaveLength(0);
    busyConversations.delete(humanChat.id);
    const result = await ask(humanChat.id);
    expect(result.conversation_id).toBe(humanChat.id);
    expect((await getConversations(targetId, 100)).length).toBe(countBefore);
    expect(await getConversation(humanChat.id)).toMatchObject({
      ownerUserId: ownerId,
      lastTriggerSource: 'agent',
      lastTriggeredByUserId: ownerId,
    });
    const [message] = await getChatMessages(targetId, 10, humanChat.id);
    expect(message).toMatchObject({
      source: 'agent',
      sender_name: `Capa (Name of ${mainId}) for ${ownerId}`,
    });
    expect(message.senderUserId).toBeFalsy();
    expect(started.at(-1)).toMatchObject({ conversation_id: humanChat.id });

    // An ask is pending on it now.
    await expect(ask(humanChat.id)).rejects.toThrow(/pending ask/);
    // Settle it so later tests are unaffected.
    await failPendingAgentAsk(result.ask_id, 'test');
  });

  test('routes an ask to an objective chat of the target project only', async () => {
    const context = {
      group_folder: mainId,
      conversation_id: (await conversationOf(mainId)).id,
      permissions: chatWrite(targetId, viewerProjectId),
    };
    const objectiveOf = (project_id: string) =>
      createObjective({
        project_id,
        title: 'Objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
    const objective = await objectiveOf(targetId);
    const foreign = await objectiveOf(viewerProjectId);
    const startedBefore = started.length;

    await expect(
      tool.handler(
        { project_id: targetId, objective_id: foreign.id, prompt: 'Hi' },
        deps,
        context,
      ),
    ).rejects.toThrow(/not found in project/);
    const projectChat = await conversationOf(targetId);
    await expect(
      tool.handler(
        {
          project_id: targetId,
          objective_id: objective.id,
          conversation_id: projectChat.id,
          prompt: 'Hi',
        },
        deps,
        context,
      ),
    ).rejects.toThrow(/not a chat of objective/);
    expect(started.length).toBe(startedBefore);

    const result = await tool.handler(
      { project_id: targetId, objective_id: objective.id, prompt: 'Status?' },
      deps,
      context,
    );
    expect(result.url).toBe(`/objective/${targetId}/${objective.id}`);
    expect(await getConversation(result.conversation_id)).toMatchObject({
      group_folder: targetId,
      objective_id: objective.id,
      ownerUserId: ownerId,
      lastTriggerSource: 'agent',
    });
    expect(
      (
        await getConversations(targetId, 10, 0, { objectiveId: objective.id })
      ).map((c) => c.id),
    ).toEqual([result.conversation_id]);
    expect(started.at(-1)).toMatchObject({
      group_folder: targetId,
      conversation_id: result.conversation_id,
    });
    await failPendingAgentAsk(result.ask_id, 'test');

    // Without objective_id the objective chat stays refused.
    await expect(
      tool.handler(
        {
          project_id: targetId,
          conversation_id: result.conversation_id,
          prompt: 'Hi',
        },
        deps,
        context,
      ),
    ).rejects.toThrow(/not a project conversation/);
  });

  test('a parent may ask its direct child, but not a grandchild', async () => {
    const callerConversation = await conversationOf(parentId);
    const context = {
      group_folder: parentId,
      conversation_id: callerConversation.id,
      permissions: chatWrite(childId, grandchildId),
    };
    const result = await tool.handler(
      { project_id: childId, prompt: 'Status?', caller_name: 'Coordinator' },
      deps,
      context,
    );
    expect(await getConversation(result.conversation_id)).toMatchObject({
      group_folder: childId,
      ownerUserId: ownerId,
    });
    expect(started.at(-1)).toMatchObject({
      group_folder: childId,
      attribution: { triggerSource: 'agent', senderUserId: null },
    });
    await expect(
      tool.handler({ project_id: grandchildId, prompt: 'Hi' }, deps, context),
    ).rejects.toThrow(/Unauthorized/);
  });

  test('a strict caller cannot send to a non-strict target', async () => {
    // A main project inherits the strictest mode of every registered project.
    const group = getGroupByFolder(viewerProjectId)!;
    const previous = group.settings;
    group.settings = { ...previous, privacyMode: 'strict' };
    try {
      const before = (await getConversations(targetId, 100)).length;
      await expect(
        tool.handler({ project_id: targetId, prompt: 'Secret' }, deps, {
          group_folder: mainId,
          conversation_id: (await conversationOf(mainId)).id,
          permissions: chatWrite(targetId),
        }),
      ).rejects.toThrow(/Privacy mode/);
      expect((await getConversations(targetId, 100)).length).toBe(before);
    } finally {
      group.settings = previous;
    }
  });

  test('runtime_selection is stored on a new conversation and refused otherwise', async () => {
    const context = {
      group_folder: mainId,
      conversation_id: (await conversationOf(mainId)).id,
      permissions: chatWrite(targetId),
    };
    const defaults = getDefaultRuntimeSelection('chat');
    expect(defaults).toBeTruthy();
    const selection = {
      harnessId: defaults!.harnessId,
      modelId: defaults!.modelId,
    };
    const result = await tool.handler(
      { project_id: targetId, prompt: 'Pick', runtime_selection: selection },
      deps,
      context,
    );
    expect(
      (await getConversation(result.conversation_id))?.runtimeSelection,
    ).toEqual(selection);
    await failPendingAgentAsk(result.ask_id, 'test cleanup');

    const existing = await conversationOf(targetId);
    const before = (await getConversations(targetId, 100)).length;
    await expect(
      tool.handler(
        {
          project_id: targetId,
          prompt: 'Switch',
          conversation_id: existing.id,
          runtime_selection: selection,
        },
        deps,
        context,
      ),
    ).rejects.toThrow(/only to new conversations/);
    expect((await getConversations(targetId, 100)).length).toBe(before);

    const group = getGroupByFolder(targetId)!;
    const previous = group.settings;
    group.settings = { ...previous, privacyMode: 'strict' };
    try {
      await expect(
        tool.handler(
          {
            project_id: targetId,
            prompt: 'Remote',
            runtime_selection: { harnessId: 'ask-remote', modelId: 'x' },
          },
          deps,
          context,
        ),
      ).rejects.toThrow();
      await expect(
        tool.handler(
          {
            project_id: targetId,
            prompt: 'Remote',
            runtime_selection: selection,
          },
          deps,
          context,
        ),
      ).rejects.toThrow(/Privacy mode/);
    } finally {
      group.settings = previous;
    }
    expect((await getConversations(targetId, 100)).length).toBe(before);
  });

  test('use_worktree starts a chat worktree conversation, with an optional branch', async () => {
    const context = {
      group_folder: mainId,
      conversation_id: (await conversationOf(mainId)).id,
      permissions: chatWrite(targetId),
    };
    const group = getGroupByFolder(targetId)!;
    const previous = group.settings;
    group.settings = {
      ...previous,
      repositoryLocation: '/repos/ask-target',
      taskCheckoutMode: 'worktree',
    };
    try {
      for (const [branch, expected] of [
        [undefined, null],
        ['ui-x', 'ui-x'],
      ] as const) {
        const result = await tool.handler(
          { project_id: targetId, prompt: 'Edit', use_worktree: true, branch },
          deps,
          context,
        );
        expect(await getConversation(result.conversation_id)).toMatchObject({
          use_worktree: 1,
          branch_name: expected,
        });
        await failPendingAgentAsk(result.ask_id, 'test cleanup');
      }
    } finally {
      group.settings = previous;
    }
  });

  test('use_worktree refusals create nothing', async () => {
    const objective = await createObjective({
      project_id: targetId,
      title: 'Objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
    });
    const existing = await conversationOf(targetId);
    const context = {
      group_folder: mainId,
      conversation_id: (await conversationOf(mainId)).id,
      permissions: chatWrite(targetId),
    };
    const group = getGroupByFolder(targetId)!;
    const previous = group.settings;
    const worktreeSettings = {
      ...previous,
      repositoryLocation: '/repos/ask-target',
      taskCheckoutMode: 'worktree' as const,
    };
    const base = { project_id: targetId, prompt: 'Edit' };
    const rows: [string, object, RegExp, object?][] = [
      [
        'conversation_id',
        { use_worktree: true, conversation_id: existing.id },
        /only to new conversations/,
        worktreeSettings,
      ],
      [
        'objective_id',
        { use_worktree: true, objective_id: objective.id },
        /never run in a worktree/,
        worktreeSettings,
      ],
      [
        'branch without use_worktree',
        { branch: 'ui-x' },
        /requires use_worktree/,
      ],
      [
        'unsafe branch',
        { use_worktree: true, branch: 'a..b' },
        /Invalid branch name/,
        worktreeSettings,
      ],
      [
        'no repository',
        { use_worktree: true },
        /worktree checkout mode/,
        {
          ...previous,
          taskCheckoutMode: 'worktree',
        },
      ],
      [
        'shared checkout mode',
        { use_worktree: true },
        /worktree checkout mode/,
        {
          ...previous,
          repositoryLocation: '/repos/ask-target',
        },
      ],
    ];
    try {
      for (const [name, extra, message, settings] of rows) {
        group.settings = settings ?? previous;
        const conversations = (await getConversations(targetId, 100)).length;
        const asks = await countAsks(mainId);
        const startedBefore = started.length;
        await expect(
          tool.handler({ ...base, ...extra }, deps, context),
          name,
        ).rejects.toThrow(message);
        expect(
          (await getConversations(targetId, 100)).length,
          `${name}: conversations`,
        ).toBe(conversations);
        expect(await countAsks(mainId), `${name}: asks`).toBe(asks);
        expect(started.length, `${name}: turns`).toBe(startedBefore);
      }
    } finally {
      group.settings = previous;
    }
  });

  test('use_worktree on a branch whose worktree is being removed creates nothing', async () => {
    const context = {
      group_folder: mainId,
      conversation_id: (await conversationOf(mainId)).id,
      permissions: chatWrite(targetId),
    };
    const group = getGroupByFolder(targetId)!;
    const previous = group.settings;
    group.settings = {
      ...previous,
      repositoryLocation: '/repos/ask-target',
      taskCheckoutMode: 'worktree',
    };
    const conversations = (await getConversations(targetId, 100)).length;
    const asks = await countAsks(mainId);
    const startedBefore = started.length;
    // A real removal holds the single PGlite connection, so the admission
    // refusal (covered in db-conversations.test.ts) is simulated here.
    const create = spyOn(db, 'createConversation').mockRejectedValueOnce(
      new ConversationWorktreeTransitionInProgressError(
        targetId,
        'ask-removing',
      ),
    );
    try {
      await expect(
        tool.handler(
          {
            project_id: targetId,
            prompt: 'Edit',
            use_worktree: true,
            branch: 'ask-removing',
          },
          deps,
          context,
        ),
      ).rejects.toThrow(/Worktree "ask-removing".*being removed/);
      expect(create).toHaveBeenCalledWith(
        targetId,
        expect.objectContaining({
          use_worktree: true,
          branch_name: 'ask-removing',
        }),
      );
    } finally {
      create.mockRestore();
      group.settings = previous;
    }
    expect((await getConversations(targetId, 100)).length).toBe(conversations);
    expect(await countAsks(mainId)).toBe(asks);
    expect(started.length).toBe(startedBefore);
  });
});
