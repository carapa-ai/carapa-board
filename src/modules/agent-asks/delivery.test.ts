import { beforeAll, describe, expect, test } from 'bun:test';

import { createConversation, initDatabase, saveChatMessage } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  appendChatTranscriptEntryAsync,
  readChatTranscriptAsync,
} from '../../group-dir.js';
import { loadState } from '../../state-manager.js';
import {
  chatAbortKey,
  chatRunAbortControllers,
} from '../../sandbox/process.js';
import {
  consumeQueuedChatMessageExactlyOnce,
  getChatMessages,
  getPendingChatMessages,
} from '../chat/db-chats.js';
import {
  directFollowupRunId,
  enqueuePersistedDirectFollowup,
} from '../chat/direct-followups.js';
import type { StartConversationTurnInput } from '../push/form-response-router.js';
import { getAgentAsk, insertAgentAsk } from './db-agent-asks.js';
import {
  readAskAnswer,
  settleAgentAsksAfterTurn,
  type AgentAskDeliveryDeps,
} from './delivery.js';

const ownerId = 'deliver-owner';
const callerId = 'deliver-caller';
const targetId = 'deliver-target';

const started: StartConversationTurnInput[] = [];
const published: Parameters<AgentAskDeliveryDeps['publishEvent']>[] = [];
const deps: AgentAskDeliveryDeps = {
  isConversationBusy: async () => false,
  startTurn: async (input) => {
    started.push(input);
    return 'started';
  },
  publishEvent: async (...args) => {
    published.push(args);
    return 'delivered';
  },
};

/** An ask whose target conversation already holds the ask message and an answer. */
async function askWithAnswer(
  caller: { conversationId?: string; objectiveId?: string },
  answer: string,
) {
  const target = await createConversation(targetId, {
    ownerUserId: ownerId,
    triggerSource: 'agent',
  });
  const askMessage = await saveChatMessage({
    group_folder: targetId,
    role: 'user',
    content: 'Question',
    senderUserId: null,
    source: 'agent',
    created_at: new Date().toISOString(),
    conversation_id: target.id,
  });
  await saveChatMessage({
    group_folder: targetId,
    role: 'assistant',
    content: answer,
    source: 'web',
    created_at: new Date().toISOString(),
    conversation_id: target.id,
  });
  const ask = await insertAgentAsk({
    callerProjectId: callerId,
    callerConversationId: caller.conversationId ?? null,
    callerObjectiveId: caller.objectiveId ?? null,
    callerName: 'Capa',
    ownerUserId: ownerId,
    targetProjectId: targetId,
    targetConversationId: target.id,
    askMessageId: askMessage.id,
    status: 'pending',
  });
  return { ask, target };
}

describe('agent ask answer delivery', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    const client = (drizzleDbRef.current as any).$client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('${ownerId}', '${ownerId}', 'test', 'user', '${now}')`,
    );
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('${callerId}', '${callerId}@web', 'Caller', '${callerId}', '!', '${now}', 1, '${ownerId}'),
              ('${targetId}', '${targetId}@web', 'Target Name', '${targetId}', '!', '${now}', 0, '${ownerId}')`,
    );
    await loadState();
  });

  test('settling the same conversation twice delivers one agent-attributed answer', async () => {
    const callerConversation = await createConversation(callerId, {
      ownerUserId: ownerId,
      triggerSource: 'user',
    });
    const answer = `${'x'.repeat(60_000)}\n\nDecisions: ship it`;
    const { ask, target } = await askWithAnswer(
      { conversationId: callerConversation.id },
      answer,
    );
    const input = {
      group_folder: targetId,
      conversation_id: target.id,
      event: 'completed',
    } as const;

    await settleAgentAsksAfterTurn(input, deps);
    await settleAgentAsksAfterTurn(input, deps);

    expect(await getAgentAsk(ask.id)).toMatchObject({
      status: 'answered',
      deliveryError: null,
    });
    const messages = (
      (await readChatTranscriptAsync(callerId, callerConversation.id)) as any[]
    ).filter((m) => m.type === 'message' && m.source === 'agent');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      sender_name: 'Agent (Target Name)',
      deepLinks: [
        {
          label: 'Open conversation',
          href: `/chat/${targetId}?conversationId=${target.id}`,
        },
      ],
    });
    expect(messages[0]!.senderUserId).toBeFalsy();
    expect(messages[0]!.content).toStartWith(
      `Answer from the ${targetId} agent (status: answered):`,
    );
    expect(messages[0]!.content).toEndWith(answer);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      group_folder: callerId,
      conversation_id: callerConversation.id,
      leaseOwnerId: `ask-answer:${ask.id}`,
      attribution: {
        senderUserId: null,
        triggeredByUserId: ownerId,
        triggerSource: 'agent',
      },
    });
    expect(started[0]!.prompt).toContain('untrusted data');
    expect(started[0]!.prompt).toContain(`conversation_id: ${target.id}`);
    expect(started[0]!.prompt).toContain(answer);
  });

  test('an answer is read from a turn stored only as raw SDK stream lines', async () => {
    const stream = (content: unknown[]) => ({
      type: 'assistant',
      message: { role: 'assistant', content },
    });
    const tool = { type: 'tool_use', id: 't1', name: 'Bash', input: {} };
    const answerOf = async (entries: unknown[]) => {
      const { ask, target } = await askWithAnswer({}, '');
      for (const entry of entries)
        await appendChatTranscriptEntryAsync(targetId, target.id, entry);
      return readAskAnswer(ask);
    };

    expect(
      await answerOf([
        stream([{ type: 'text', text: 'Working...' }, tool]),
        stream([{ type: 'text', text: 'Final summary' }]),
        { type: 'result', subtype: 'success', result: 'Final summary' },
        { type: 'turn_outcome', failed: false },
      ]),
    ).toBe('Final summary');
    expect(await answerOf([stream([tool]), { type: 'turn_outcome' }])).toBe('');
  });

  test('an answer for a busy chat is saved when its queued turn starts, after the running reply', async () => {
    const callerConversation = await createConversation(callerId, {
      ownerUserId: ownerId,
      triggerSource: 'user',
    });
    const { ask, target } = await askWithAnswer(
      { conversationId: callerConversation.id },
      'pong',
    );
    // The caller's turn that made the ask is still running.
    const abortKey = chatAbortKey(
      callerId,
      callerConversation.id,
      `${callerId}@web`,
    );
    chatRunAbortControllers.set(abortKey, new AbortController());
    const queuedDeps: AgentAskDeliveryDeps = {
      ...deps,
      isConversationBusy: async () => true,
      startTurn: async (input) => {
        await enqueuePersistedDirectFollowup({
          message: input.userMessage,
          deferMessage: input.deferUserMessage,
          metadata: {
            conversationId: input.conversation_id,
            executionContent: input.prompt,
            agentCmd: 'test-agent',
            senderUserId: null,
            triggeredByUserId: input.attribution.triggeredByUserId,
            triggerSource: input.attribution.triggerSource,
          },
        });
        return 'queued';
      },
    };
    const answers = async () =>
      (
        (await readChatTranscriptAsync(
          callerId,
          callerConversation.id,
        )) as any[]
      ).filter((m) => m.type === 'message' && m.source === 'agent');

    try {
      await settleAgentAsksAfterTurn(
        {
          group_folder: targetId,
          conversation_id: target.id,
          event: 'completed',
        },
        queuedDeps,
      );
      expect(await answers()).toHaveLength(0);
      // The running turn must not steer the raw answer into itself.
      expect(
        await getPendingChatMessages(callerId, callerConversation.id, '1970'),
      ).toHaveLength(0);

      // The running turn ends and saves its reply, then the queued turn starts.
      const reply = await saveChatMessage({
        group_folder: callerId,
        role: 'assistant',
        content: 'Asked it.',
        source: 'web',
        created_at: new Date().toISOString(),
        conversation_id: callerConversation.id,
      });
      const runId = directFollowupRunId(
        callerId,
        callerConversation.id,
        `ask-answer-${ask.id}`,
      );
      const queued = (
        (await readChatTranscriptAsync(
          callerId,
          callerConversation.id,
        )) as any[]
      ).find((m) => m.type === 'queued_user_message');
      const consumed = await consumeQueuedChatMessageExactlyOnce(
        { ...queued, group_folder: callerId },
        {
          consumer: 'direct-followup',
          runId,
        },
      );

      expect(consumed.won).toBe(true);
      expect(consumed.message!.created_at > reply.created_at).toBe(true);
      const listed = await answers();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: `ask-answer-${ask.id}`,
        sender_name: 'Agent (Target Name)',
        deepLinks: [
          {
            label: 'Open conversation',
            href: `/chat/${targetId}?conversationId=${target.id}`,
          },
        ],
      });
      const ordered = (
        await getChatMessages(callerId, 10, callerConversation.id)
      )
        .reverse()
        .map((m) => m.id);
      expect(ordered).toEqual([reply.id, `ask-answer-${ask.id}`]);
    } finally {
      chatRunAbortControllers.delete(abortKey);
    }
  });

  test('an ask with only an objective publishes one agent_answer event', async () => {
    const { ask, target } = await askWithAnswer(
      { objectiveId: 'obj-1' },
      'Done.',
    );
    published.length = 0;
    const input = {
      group_folder: targetId,
      conversation_id: target.id,
      event: 'failed',
    } as const;

    await settleAgentAsksAfterTurn(input, deps);
    await settleAgentAsksAfterTurn(input, deps);

    expect(published).toHaveLength(1);
    expect(published[0]![1]).toMatchObject({
      type: 'agent_answer',
      project_id: callerId,
      objective_id: 'obj-1',
      data: {
        ask_id: ask.id,
        target_project_id: targetId,
        conversation_id: target.id,
        status: 'failed',
        answer: 'Done.',
        url: `/chat/${targetId}?conversationId=${target.id}`,
      },
    });
    expect(await getAgentAsk(ask.id)).toMatchObject({ status: 'failed' });
  });
});
