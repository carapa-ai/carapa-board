/**
 * Tests for `updateConversationAggregate()` write-through semantics in
 * `src/modules/chat/db-chats.ts`.
 *
 * The aggregate columns (`last_user_at`, `last_assistant_at`) are a fast
 * cache for the sidebar — they're written by every `saveChatMessage()` /
 * transcript append. The whole point is that an out-of-order backfill
 * (notably `recovery.ts` replaying historical turns) MUST NOT regress
 * the timestamp; otherwise the conversation would be mislabeled as stuck.
 *
 * The MAX semantics come from PG GREATEST(). Only the "older then newer"
 * case guards against `GREATEST(col, ts)` being replaced with
 * `COALESCE(col, ts)` (which only fills NULLs and would never advance the
 * column); the "newer then older" backfill case passes under COALESCE too.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActiveRunById, initDatabase } from '../../db.js';
import {
  absorbDirectSteeringCandidate,
  releaseAbsorbedDirectSteering,
  createConversation,
  saveChatMessage,
  getChatMessages,
  getConversation,
  getPendingChatMessages,
  getQueuedChatMessageStates,
  consumeQueuedChatMessageExactlyOnce,
  withdrawQueuedChatMessageExactlyOnce,
  beginChatSteeringDelivery,
  completeChatSteeringDelivery,
  releaseUnconsumedQueuedChatMessages,
  rebuildConversationAggregatesFromTranscript,
  updateConversationAggregate,
} from '../../modules/chat/db-chats.js';
import {
  appendChatTranscriptEntry,
  getGroupDir,
  readChatTranscript,
} from '../../group-dir.js';
import { truncateTestDb } from '../../test-helpers.js';
import { runDirectLlm } from './direct-llm.js';
import {
  formatTranscriptEntries,
  getAgentContextGap,
  getLlmHistory,
} from '../transcripts/transcript-store.js';
import {
  claimDirectLlmDelivery,
  closeDirectLlmDeliveryGate,
  deleteDirectLlmDeliveryGate,
  openDirectLlmDeliveryGate,
} from './direct-llm-delivery.js';
import {
  claimReleasedDirectFollowup,
  directFollowupRunId,
  releaseAndClaimDirectFollowups,
} from './direct-followups.js';

const GROUP = 'conv-aggregate-test';

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
});

afterAll(() => {
  // Per .agent/rules/05-runtime-artifacts.md, transcripts live at
  // `groups/<folder>/transcripts/`. Tests that synthesize a transcript
  // write there via `appendChatTranscriptEntry` — clean up so the
  // host worktree doesn't accumulate test data between runs.
  try {
    fs.rmSync(path.join(getGroupDir(GROUP), 'transcripts'), {
      recursive: true,
      force: true,
    });
  } catch {}
});

describe('updateConversationAggregate', () => {
  test('keeps newer last_user_at when a later message arrives', async () => {
    const conv = await createConversation(GROUP);
    const older = '2026-06-30T04:00:00.000Z';
    const newer = '2026-06-30T04:10:00.000Z';

    await updateConversationAggregate(GROUP, conv.id, {
      role: 'user',
      created_at: older,
    });
    await updateConversationAggregate(GROUP, conv.id, {
      role: 'user',
      created_at: newer,
    });

    const after = await getConversation(conv.id);
    expect(after?.last_user_at).toBe(newer);
  });

  test('does NOT regress last_user_at on an out-of-order backfill (the bug)', async () => {
    // recovery.ts replays historical turns after the live aggregate already
    // has the latest ts; the newer value must be preserved.
    const conv = await createConversation(GROUP);
    const newer = '2026-06-30T04:10:00.000Z';
    const olderBackfill = '2026-06-30T04:00:00.000Z';

    await updateConversationAggregate(GROUP, conv.id, {
      role: 'user',
      created_at: newer,
    });
    await updateConversationAggregate(GROUP, conv.id, {
      role: 'user',
      created_at: olderBackfill,
    });

    const after = await getConversation(conv.id);
    expect(after?.last_user_at).toBe(newer);
  });

  test('does not let an older failed outcome replace a newer success', async () => {
    const conv = await createConversation(GROUP);
    const newer = '2026-06-30T04:10:00.000Z';
    const older = '2026-06-30T04:00:00.000Z';

    await updateConversationAggregate(GROUP, conv.id, {
      role: 'assistant',
      created_at: newer,
      outcome: 'success',
    });
    await updateConversationAggregate(GROUP, conv.id, {
      role: 'assistant',
      created_at: older,
      outcome: 'failed',
    });

    const after = await getConversation(conv.id);
    expect(after?.last_assistant_at).toBe(newer);
    expect(after?.lastAssistantOutcome).toBe('success');
  });

  test('user and assistant timestamps are tracked independently', async () => {
    const conv = await createConversation(GROUP);
    const userTs = '2026-06-30T04:00:00.000Z';
    const asstTs = '2026-06-30T04:05:00.000Z';

    await updateConversationAggregate(GROUP, conv.id, {
      role: 'user',
      created_at: userTs,
    });
    await updateConversationAggregate(GROUP, conv.id, {
      role: 'assistant',
      created_at: asstTs,
    });

    const after = await getConversation(conv.id);
    expect(after?.last_user_at).toBe(userTs);
    expect(after?.last_assistant_at).toBe(asstTs);
  });
});

describe('rebuildConversationAggregatesFromTranscript', () => {
  function writeEntries(
    convId: string,
    entries: Array<{
      role: 'user' | 'assistant';
      created_at: string;
      content?: string;
    }>,
  ): void {
    for (const e of entries) {
      appendChatTranscriptEntry(GROUP, convId, {
        id: `t-${e.created_at}-${e.role}`,
        type: 'message',
        role: e.role,
        content: e.content ?? `${e.role}@${e.created_at}`,
        source: 'web',
        created_at: e.created_at,
      });
    }
  }

  test('keeps provider cache context out of human-message readers and aggregates', async () => {
    const conv = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'human-turn',
      type: 'message',
      role: 'user',
      content: 'Actual human prompt',
      source: 'web',
      created_at: '2026-06-30T04:00:00.000Z',
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'provider-turn',
      type: 'message',
      role: 'user',
      content: 'Internal persona turn prompt',
      agent_name: 'ai:luna',
      provider_context: true,
      created_at: '2026-06-30T04:10:00.000Z',
    });

    const visible = await getChatMessages(GROUP, 10, conv.id);
    expect(visible.map((message) => message.id)).toEqual(['human-turn']);

    const pending = await getPendingChatMessages(
      GROUP,
      conv.id,
      '2026-06-30T03:00:00.000Z',
    );
    expect(pending.map((message) => message.id)).toEqual(['human-turn']);

    const aggregate = await rebuildConversationAggregatesFromTranscript(
      GROUP,
      conv.id,
    );
    expect(aggregate.last_user_at).toBe('2026-06-30T04:00:00.000Z');
  });

  test('deduplicates a canonical queued ID when its consumed receipt was interrupted', async () => {
    const conv = await createConversation(GROUP);
    const queued = {
      id: 'stable-queued-id',
      type: 'queued_user_message',
      role: 'user',
      content: 'deliver once',
      source: 'web',
      created_at: '2026-06-30T04:00:00.000Z',
      conversation_id: conv.id,
      group_folder: GROUP,
    } as const;
    appendChatTranscriptEntry(GROUP, conv.id, queued);
    appendChatTranscriptEntry(GROUP, conv.id, {
      ...queued,
      type: 'message',
      created_at: '2026-06-30T04:01:00.000Z',
    });

    const pending = await getPendingChatMessages(
      GROUP,
      conv.id,
      '2026-06-30T03:00:00.000Z',
    );
    expect(pending).toEqual([]);
    expect(await consumeQueuedChatMessageExactlyOnce(queued as any)).toEqual({
      won: false,
    });
  });

  test('keeps open-file execution metadata agent-only for pending messages', async () => {
    const conv = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'contextual-user',
      type: 'message',
      role: 'user',
      content: 'fix this',
      source: 'web',
      created_at: '2026-06-30T04:00:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'open_file_context',
      messageId: 'contextual-user',
      context: {
        source: 'group',
        path: '.env',
        line: 1,
        column: 1,
        unsavedChanges: true,
      },
      created_at: '2026-06-30T04:00:00.001Z',
      conversation_id: conv.id,
    });

    const visible = await getChatMessages(GROUP, 10, conv.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.content).toBe('fix this');
    expect(JSON.stringify(visible)).not.toContain('open-file-context');
    expect(JSON.stringify(visible)).not.toContain('unsavedChanges');

    const pending = await getPendingChatMessages(
      GROUP,
      conv.id,
      '2026-06-30T03:00:00.000Z',
    );
    expect(pending[0]?.content).toBe('fix this');
    expect(pending[0]?.executionContent).toContain('open-file-context');
    expect(pending[0]?.executionContent).toContain('"path":".env"');
    expect(pending[0]?.executionContent).not.toContain('SECRET=[REDACTED]');
  });

  test('retains execution metadata when steering is rejected', async () => {
    const conv = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'rejected-steer',
      type: 'message',
      role: 'user',
      content: 'what is wrong here',
      source: 'web',
      created_at: '2026-06-30T04:00:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'open_file_context',
      messageId: 'rejected-steer',
      context: {
        source: 'artifact',
        path: 'logs/report.md',
        line: 7,
        column: 3,
      },
      created_at: '2026-06-30T04:00:00.001Z',
      conversation_id: conv.id,
    });
    beginChatSteeringDelivery('rejected-steer');
    await completeChatSteeringDelivery(GROUP, conv.id, 'rejected-steer', false);

    const pending = await getPendingChatMessages(
      GROUP,
      conv.id,
      '2026-06-30T03:00:00.000Z',
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.executionContent).toContain('"path":"logs/report.md"');
    expect(pending[0]?.content).toBe('what is wrong here');
  });

  test('answers a mid-stream DirectLLM message once with transcript persistence enabled', async () => {
    const conv = await createConversation(GROUP);
    await saveChatMessage({
      id: 'initial-direct-turn',
      group_folder: GROUP,
      role: 'user',
      content: 'start the response',
      source: 'web',
      created_at: '2026-06-30T05:00:00.000Z',
      conversation_id: conv.id,
    });

    let requestCount = 0;
    const abort = new AbortController();
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        requestCount++;
        // Bound the regression: an echoed transcript message used to restart
        // steering indefinitely, even after the original ID was acknowledged.
        if (requestCount > 2) abort.abort();
        if (requestCount === 1) {
          await saveChatMessage({
            id: 'absorbed-direct-turn',
            group_folder: GROUP,
            role: 'user',
            content: 'include this correction',
            source: 'web',
            created_at: '2026-06-30T05:00:01.000Z',
            conversation_id: conv.id,
          });
        }
        const content =
          requestCount === 1 ? 'first response' : 'corrected response';
        const body = [
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join('');
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const absorbed: string[] = [];
    let admissionClosed = false;
    try {
      const result = await runDirectLlm(
        'system',
        'start the response',
        'test-model',
        () => {},
        [],
        [],
        {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          signal: abort.signal,
          skipInitialLog: true,
          beforeSteeringComplete: () => {
            admissionClosed = true;
          },
          onSteeringAbsorbed: (messages) => {
            absorbed.push(...messages.map((message) => String(message.id)));
          },
        },
        undefined,
        (entry) => {
          // Match runChatAgent's production sink, including its append-time
          // timestamp. A callback-free test cannot expose transcript replays.
          appendChatTranscriptEntry(GROUP, conv.id, {
            ...entry,
            agent_name: 'llm:direct:test-model',
            created_at: new Date().toISOString(),
          });
        },
        undefined,
        GROUP,
        undefined,
        undefined,
        conv.id,
      );
      expect(result.result).toEndWith('corrected response');
    } finally {
      server.stop(true);
    }

    expect(requestCount).toBe(2);
    expect(absorbed).toEqual(['absorbed-direct-turn']);
    expect(admissionClosed).toBe(true);
    expect(
      readChatTranscript(GROUP, conv.id).filter(
        (entry: any) =>
          entry.type === 'message' &&
          entry.role === 'user' &&
          entry.content === 'include this correction',
      ),
    ).toHaveLength(1);
    expect(
      readChatTranscript(GROUP, conv.id).filter(
        (entry) =>
          (entry as { type?: string }).type === 'steering_delivery' &&
          (entry as { messageId?: string }).messageId ===
            'absorbed-direct-turn',
      ),
    ).toHaveLength(1);
    expect(
      (
        await getPendingChatMessages(GROUP, conv.id, '2026-06-30T04:59:00.000Z')
      ).some((message) => message.id === 'absorbed-direct-turn'),
    ).toBe(false);
  });

  test('durably releases an unconsumed persona record from future polling', async () => {
    const conv = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'released-queued-id',
      type: 'queued_user_message',
      role: 'user',
      content: 'browser must follow up',
      source: 'web',
      created_at: '2026-06-30T04:00:00.000Z',
      conversation_id: conv.id,
    });

    expect(await releaseUnconsumedQueuedChatMessages(GROUP, conv.id)).toEqual([
      'released-queued-id',
    ]);
    expect(await releaseUnconsumedQueuedChatMessages(GROUP, conv.id)).toEqual(
      [],
    );
    expect(
      await getPendingChatMessages(GROUP, conv.id, '2026-06-30T03:00:00.000Z'),
    ).toEqual([]);
  });

  test('serializes persona withdrawal against boundary consumption', async () => {
    const conv = await createConversation(GROUP);
    const queued = {
      id: 'withdraw-consume-race',
      type: 'queued_user_message',
      role: 'user',
      content: 'deliver or withdraw exactly once',
      source: 'web',
      created_at: '2026-06-30T04:30:00.000Z',
      conversation_id: conv.id,
      group_folder: GROUP,
    } as const;
    appendChatTranscriptEntry(GROUP, conv.id, queued);

    const [withdrawal, consumed] = await Promise.all([
      withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, queued.id),
      consumeQueuedChatMessageExactlyOnce(queued as any),
    ]);

    expect(Number(withdrawal.withdrawn) + Number(consumed.won)).toBe(1);
    expect(withdrawal.released).toBe(false);
    expect(getQueuedChatMessageStates(GROUP, conv.id).pending).toEqual([]);
    expect(
      (await getChatMessages(GROUP, 100, conv.id)).filter(
        (message) => message.id === queued.id,
      ),
    ).toHaveLength(consumed.won ? 1 : 0);
  });

  test('keeps a release authoritative over a stale persona consumer', async () => {
    const conv = await createConversation(GROUP);
    const queued = {
      id: 'released-before-stale-consumer',
      type: 'queued_user_message',
      role: 'user',
      content: 'return this prompt to its new owner',
      source: 'web',
      created_at: '2026-06-30T04:40:00.000Z',
      conversation_id: conv.id,
      group_folder: GROUP,
    } as const;
    appendChatTranscriptEntry(GROUP, conv.id, queued);

    expect(getQueuedChatMessageStates(GROUP, conv.id)).toMatchObject({
      pending: [queued.id],
      queueOwners: { [queued.id]: 'persona' },
    });

    expect(await releaseUnconsumedQueuedChatMessages(GROUP, conv.id)).toEqual([
      queued.id,
    ]);
    expect(await consumeQueuedChatMessageExactlyOnce(queued as any)).toEqual({
      won: false,
    });
    expect(
      (await getChatMessages(GROUP, 100, conv.id)).filter(
        (message) => message.id === queued.id,
      ),
    ).toEqual([]);
  });

  test('allows only the recorded Direct claim to consume a released prompt', async () => {
    const conv = await createConversation(GROUP);
    const queued = {
      id: 'claimed-before-consumer',
      type: 'queued_user_message',
      role: 'user',
      content: 'deliver through the claimed follow-up',
      source: 'web',
      created_at: '2026-06-30T04:42:00.000Z',
      conversation_id: conv.id,
      group_folder: GROUP,
    } as const;
    appendChatTranscriptEntry(GROUP, conv.id, queued);
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'queued_user_released',
      messageId: queued.id,
      created_at: '2026-06-30T04:42:00.001Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'queued_user_claimed',
      messageId: queued.id,
      runId: 'recorded-direct-run',
      created_at: '2026-06-30T04:42:00.002Z',
      conversation_id: conv.id,
    });

    expect(
      await consumeQueuedChatMessageExactlyOnce(queued as any, {
        consumer: 'direct-followup',
        runId: 'stale-run',
      }),
    ).toEqual({ won: false });
    expect(
      await consumeQueuedChatMessageExactlyOnce(queued as any, {
        consumer: 'direct-followup',
        runId: 'recorded-direct-run',
      }),
    ).toMatchObject({ won: true, message: { id: queued.id } });
  });

  test('rejects withdrawal when the canonical queued message already exists', async () => {
    const conv = await createConversation(GROUP);
    const messageId = 'canonical-before-withdrawal';
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: messageId,
      type: 'queued_user_message',
      role: 'user',
      content: 'already delivered',
      source: 'web',
      created_at: '2026-06-30T04:44:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: messageId,
      type: 'message',
      role: 'user',
      content: 'already delivered',
      source: 'web',
      created_at: '2026-06-30T04:44:00.001Z',
      conversation_id: conv.id,
    });

    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, messageId),
    ).toEqual({ withdrawn: false, released: false });
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, messageId),
    ).toEqual({ withdrawn: false, released: false });
    expect(
      readChatTranscript(GROUP, conv.id).filter(
        (entry) =>
          (entry as { type?: unknown }).type === 'queued_user_consumed' &&
          (entry as { messageId?: unknown }).messageId === messageId,
      ),
    ).toHaveLength(1);
    expect(getQueuedChatMessageStates(GROUP, conv.id).consumed).toContain(
      messageId,
    );
  });

  test('serializes persona withdrawal against release and server claim', async () => {
    const conv = await createConversation(GROUP);
    const messageId = 'withdraw-release-claim-race';
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: messageId,
      type: 'queued_user_message',
      role: 'user',
      content: 'release or withdraw exactly once',
      source: 'web',
      queuedExecutionContent: 'release or withdraw exactly once',
      queuedAgentCmd: 'direct-test-runtime',
      created_at: '2026-06-30T04:45:00.000Z',
      conversation_id: conv.id,
    });

    const [handoff, withdrawal] = await Promise.all([
      releaseAndClaimDirectFollowups(GROUP, conv.id),
      withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, messageId),
    ]);
    const claimedRun = await getActiveRunById(
      directFollowupRunId(GROUP, conv.id, messageId),
    );

    expect(Number(withdrawal.withdrawn) + Number(!!claimedRun)).toBe(1);
    expect(withdrawal.released).toBe(false);
    expect(handoff.releasedMessageIds).toEqual([]);
    expect(getQueuedChatMessageStates(GROUP, conv.id).released).toEqual([]);
  });

  test('releases an unabsorbed direct canonical row but not an absorbed one', async () => {
    const conv = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'direct-tail-message',
      type: 'message',
      role: 'user',
      content: 'arrived after the final checkpoint',
      source: 'web',
      created_at: '2026-06-30T06:00:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'direct_user_pending',
      messageId: 'direct-tail-message',
      created_at: '2026-06-30T06:00:00.001Z',
      conversation_id: conv.id,
    });

    expect(await releaseUnconsumedQueuedChatMessages(GROUP, conv.id)).toEqual([
      'direct-tail-message',
    ]);
    expect(getQueuedChatMessageStates(GROUP, conv.id)).toEqual({
      pending: [],
      consumed: [],
      released: ['direct-tail-message'],
      withdrawn: [],
      queueOwners: {},
    });

    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'direct-absorbed-message',
      type: 'message',
      role: 'user',
      content: 'absorbed before completion',
      source: 'web',
      created_at: '2026-06-30T06:01:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'direct_user_pending',
      messageId: 'direct-absorbed-message',
      created_at: '2026-06-30T06:01:00.001Z',
      conversation_id: conv.id,
    });
    await completeChatSteeringDelivery(
      GROUP,
      conv.id,
      'direct-absorbed-message',
      true,
    );
    expect(
      formatTranscriptEntries(readChatTranscript(GROUP, conv.id)).find(
        (entry) => (entry as { id?: unknown }).id === 'direct-absorbed-message',
      ),
    ).toMatchObject({ steeringDelivery: 'steered' });
    expect(await releaseUnconsumedQueuedChatMessages(GROUP, conv.id)).toEqual(
      [],
    );
    expect(getQueuedChatMessageStates(GROUP, conv.id).consumed).toContain(
      'direct-absorbed-message',
    );
  });

  test('claims a released Direct replay envelope exactly once', async () => {
    const conv = await createConversation(GROUP);
    const messageId = 'direct-server-followup';
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: messageId,
      type: 'message',
      role: 'user',
      content: 'run without a browser retry',
      source: 'web',
      attachments: [
        { type: 'image', url: '/image.png', mimetype: 'image/png' },
      ],
      created_at: '2026-06-30T06:05:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conv.id,
      agentCmd: 'direct-test-runtime',
      executionContent: 'memory and open-file enriched execution content',
      chatMode: 'ask',
      triggerSource: 'system',
      created_at: '2026-06-30T06:05:00.001Z',
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conv.id,
      created_at: '2026-06-30T06:05:00.002Z',
    });

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimReleasedDirectFollowup(GROUP, conv.id, messageId),
      ),
    );
    expect(attempts.filter((attempt) => attempt?.won)).toHaveLength(1);
    const runId = directFollowupRunId(GROUP, conv.id, messageId);
    expect(await getActiveRunById(runId)).toMatchObject({
      id: runId,
      stage: 'direct-followup:claimed',
      status: 'running',
      agent_name: 'direct-test-runtime',
    });
    expect(
      readChatTranscript(GROUP, conv.id).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'queued_user_consumed' &&
          'messageId' in entry &&
          entry.messageId === messageId,
      ),
    ).toHaveLength(0);
  });

  test('withdraws an unclaimed Direct follow-up once and rejects it after claim', async () => {
    const conv = await createConversation(GROUP);
    const seed = (messageId: string, createdAt: string) => {
      appendChatTranscriptEntry(GROUP, conv.id, {
        id: messageId,
        type: 'message',
        role: 'user',
        content: `content of ${messageId}`,
        source: 'web',
        created_at: createdAt,
        conversation_id: conv.id,
      });
      appendChatTranscriptEntry(GROUP, conv.id, {
        type: 'direct_user_pending',
        messageId,
        conversation_id: conv.id,
        agentCmd: 'direct-test-runtime',
        executionContent: `execution of ${messageId}`,
        chatMode: null,
        triggerSource: 'system',
        created_at: createdAt,
      });
    };
    const withdrawnMarkers = (messageId: string) =>
      readChatTranscript(GROUP, conv.id).filter(
        (entry) =>
          (entry as { type?: unknown }).type === 'queued_user_withdrawn' &&
          (entry as { messageId?: unknown }).messageId === messageId,
      );

    const withdrawnId = 'direct-withdrawn-before-claim';
    seed(withdrawnId, '2026-06-30T06:10:00.000Z');
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, withdrawnId),
    ).toEqual({ withdrawn: true, released: false });
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, withdrawnId),
    ).toEqual({ withdrawn: false, released: false });
    expect(withdrawnMarkers(withdrawnId)).toHaveLength(1);
    expect(getQueuedChatMessageStates(GROUP, conv.id)).toMatchObject({
      pending: [],
      withdrawn: [withdrawnId],
    });
    expect(
      formatTranscriptEntries(readChatTranscript(GROUP, conv.id)).some(
        (entry) => (entry as { id?: unknown }).id === withdrawnId,
      ),
    ).toBe(false);
    expect(
      (await getChatMessages(GROUP, 100, conv.id)).some(
        (message) => message.id === withdrawnId,
      ),
    ).toBe(false);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'assistant-before-next-turn',
      type: 'message',
      role: 'assistant',
      content: 'earlier answer',
      source: 'web',
      created_at: '2026-06-30T06:10:30.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'next-real-message',
      type: 'message',
      role: 'user',
      content: 'a real message',
      source: 'web',
      created_at: '2026-06-30T06:10:40.000Z',
      conversation_id: conv.id,
    });
    expect(JSON.stringify(await getLlmHistory(GROUP, conv.id))).not.toContain(
      `content of ${withdrawnId}`,
    );
    expect(
      getAgentContextGap(GROUP, conv.id, 'direct-test-runtime') ?? '',
    ).not.toContain(`content of ${withdrawnId}`);
    const handoff = await releaseAndClaimDirectFollowups(GROUP, conv.id);
    expect(handoff.claimed).toEqual([]);
    expect(
      await getActiveRunById(directFollowupRunId(GROUP, conv.id, withdrawnId)),
    ).toBeUndefined();

    const claimedId = 'direct-claimed-before-withdrawal';
    seed(claimedId, '2026-06-30T06:11:00.000Z');
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'queued_user_released',
      messageId: claimedId,
      conversation_id: conv.id,
      created_at: '2026-06-30T06:11:00.001Z',
    });
    expect(
      (await claimReleasedDirectFollowup(GROUP, conv.id, claimedId))?.won,
    ).toBe(true);
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, claimedId),
    ).toEqual({ withdrawn: false, released: false });
    expect(withdrawnMarkers(claimedId)).toHaveLength(0);
    expect(
      formatTranscriptEntries(readChatTranscript(GROUP, conv.id)).some(
        (entry) => (entry as { id?: unknown }).id === claimedId,
      ),
    ).toBe(true);
  });

  test('makes Direct steering absorption and withdrawal mutually exclusive', async () => {
    const conv = await createConversation(GROUP);
    const seed = (messageId: string, createdAt: string) => {
      appendChatTranscriptEntry(GROUP, conv.id, {
        id: messageId,
        type: 'message',
        role: 'user',
        content: `content of ${messageId}`,
        source: 'web',
        created_at: createdAt,
        conversation_id: conv.id,
      });
      appendChatTranscriptEntry(GROUP, conv.id, {
        type: 'direct_user_pending',
        messageId,
        conversation_id: conv.id,
        agentCmd: 'direct-test-runtime',
        executionContent: `execution of ${messageId}`,
        created_at: createdAt,
      });
    };
    const visible = (messageId: string) =>
      formatTranscriptEntries(readChatTranscript(GROUP, conv.id)).some(
        (entry) => (entry as { id?: unknown }).id === messageId,
      );

    const absorbedId = 'direct-absorbed-before-withdrawal';
    seed(absorbedId, '2026-06-30T06:30:00.000Z');
    expect(
      await absorbDirectSteeringCandidate(GROUP, conv.id, absorbedId),
    ).toBe(true);
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, absorbedId),
    ).toEqual({ withdrawn: false, released: false });
    expect(visible(absorbedId)).toBe(true);
    // A turn that ended without a receipt makes the message withdrawable again.
    releaseAbsorbedDirectSteering(GROUP, conv.id, [absorbedId]);
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, absorbedId),
    ).toEqual({ withdrawn: true, released: false });

    const withdrawnId = 'direct-withdrawn-before-absorption';
    seed(withdrawnId, '2026-06-30T06:31:00.000Z');
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, withdrawnId),
    ).toEqual({ withdrawn: true, released: false });
    expect(
      await absorbDirectSteeringCandidate(GROUP, conv.id, withdrawnId),
    ).toBe(false);
  });

  test('keeps a persona prompt visible when it is withdrawn and resent under the same id', async () => {
    const conv = await createConversation(GROUP);
    const messageId = 'persona-send-now-resend';
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'queued_user_message',
      id: messageId,
      role: 'user',
      content: 'send this now',
      created_at: '2026-06-30T06:20:00.000Z',
      queuedExecutionContent: 'send this now',
      queuedAgentCmd: 'direct-test-runtime',
      conversation_id: conv.id,
    });
    expect(
      await withdrawQueuedChatMessageExactlyOnce(GROUP, conv.id, messageId),
    ).toEqual({ withdrawn: true, released: false });
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: messageId,
      type: 'message',
      role: 'user',
      content: 'send this now',
      source: 'web',
      created_at: '2026-06-30T06:20:01.000Z',
      conversation_id: conv.id,
    });
    expect(
      formatTranscriptEntries(readChatTranscript(GROUP, conv.id)).some(
        (entry) => (entry as { id?: unknown }).id === messageId,
      ),
    ).toBe(true);
    expect(
      (await getChatMessages(GROUP, 100, conv.id)).some(
        (message) => message.id === messageId,
      ),
    ).toBe(true);
  });

  test('never claims an absorbed Direct message', async () => {
    const conv = await createConversation(GROUP);
    const messageId = 'direct-steered-no-followup';
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: messageId,
      type: 'message',
      role: 'user',
      content: 'absorbed',
      source: 'web',
      created_at: '2026-06-30T06:06:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conv.id,
      agentCmd: 'direct-test-runtime',
      executionContent: 'absorbed execution content',
      created_at: '2026-06-30T06:06:00.001Z',
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'steering_delivery',
      messageId,
      delivery: 'steered',
      conversation_id: conv.id,
      created_at: '2026-06-30T06:06:00.002Z',
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'queued_user_released',
      messageId,
      conversation_id: conv.id,
      created_at: '2026-06-30T06:06:00.003Z',
    });

    expect(
      await claimReleasedDirectFollowup(GROUP, conv.id, messageId),
    ).toBeUndefined();
    expect(
      await getActiveRunById(directFollowupRunId(GROUP, conv.id, messageId)),
    ).toBeUndefined();
  });

  test('terminal close drains an admitted write before exceptional release scanning', async () => {
    const conv = await createConversation(GROUP);
    const gate = openDirectLlmDeliveryGate(conv.id);
    const finishWrite = claimDirectLlmDelivery(conv.id);
    expect(finishWrite).toBeDefined();

    let scanning = false;
    const terminalRelease = (async () => {
      await closeDirectLlmDeliveryGate(conv.id, gate);
      scanning = true;
      return releaseUnconsumedQueuedChatMessages(GROUP, conv.id);
    })();
    // Drain promise continuations to detect an early close while the write is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scanning).toBe(false);
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'exception-tail-message',
      type: 'message',
      role: 'user',
      content: 'provider failed while this write was admitted',
      source: 'web',
      created_at: '2026-06-30T06:02:00.000Z',
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'direct_user_pending',
      messageId: 'exception-tail-message',
      created_at: '2026-06-30T06:02:00.001Z',
      conversation_id: conv.id,
    });
    finishWrite!();

    expect(await terminalRelease).toEqual(['exception-tail-message']);
    expect(claimDirectLlmDelivery(conv.id)).toBeUndefined();
    deleteDirectLlmDeliveryGate(conv.id, gate);
  });

  test('handles an out-of-order JSONL transcript (older entry appended after newer)', async () => {
    // Transcript writes are append-only JSONL, so out-of-order timestamps
    // are realistic (transcript-recovery replays, manual edits, etc.).
    // Even though the older `user` line appears AFTER the newer one in
    // the file, the rebuild must still pick the MAX per-role.
    const conv = await createConversation(GROUP);
    writeEntries(conv.id, [
      { role: 'user', created_at: '2026-06-30T04:10:00.000Z' },
      { role: 'assistant', created_at: '2026-06-30T04:11:00.000Z' },
      { role: 'user', created_at: '2026-06-30T04:00:00.000Z' }, // older appended later
      { role: 'assistant', created_at: '2026-06-30T04:05:00.000Z' }, // older appended later
    ]);

    const result = await rebuildConversationAggregatesFromTranscript(
      GROUP,
      conv.id,
    );
    expect(result.last_user_at).toBe('2026-06-30T04:10:00.000Z');
    expect(result.last_assistant_at).toBe('2026-06-30T04:11:00.000Z');

    const after = await getConversation(conv.id);
    expect(after?.last_user_at).toBe('2026-06-30T04:10:00.000Z');
    expect(after?.last_assistant_at).toBe('2026-06-30T04:11:00.000Z');
  });

  test('is idempotent: a second rebuild does not regress the columns', async () => {
    // Mirrors the boot-time backfill scenario: the conversation ends up
    // populated, then a later operator-triggered rebuild should be a no-op.
    // `rebuildConversationAggregatesFromTranscript` routes through
    // `updateConversationAggregate` which uses GREATEST(existing, ts), so
    // a transcript-sourced rebuild never regresses an existing aggregate.
    const conv = await createConversation(GROUP);
    writeEntries(conv.id, [
      { role: 'user', created_at: '2026-06-30T04:00:00.000Z' },
      { role: 'assistant', created_at: '2026-06-30T04:01:00.000Z' },
    ]);
    await rebuildConversationAggregatesFromTranscript(GROUP, conv.id);

    // A live write through the projection with a newer timestamp —
    // should NOT be regressed by a subsequent rebuild from the older
    // transcript.
    const newer = '2026-06-30T04:30:00.000Z';
    await updateConversationAggregate(GROUP, conv.id, {
      role: 'user',
      created_at: newer,
    });

    await rebuildConversationAggregatesFromTranscript(GROUP, conv.id);

    const after = await getConversation(conv.id);
    expect(after?.last_user_at).toBe(newer);
    expect(after?.last_assistant_at).toBe('2026-06-30T04:01:00.000Z');
  });

  test('leaves the column NULL when the transcript has no matching role', async () => {
    // Defensive: a transcript that contains only assistant entries must
    // leave `last_user_at` NULL; rebuild must not synthesize a value.
    const conv = await createConversation(GROUP);
    writeEntries(conv.id, [
      { role: 'assistant', created_at: '2026-06-30T04:01:00.000Z' },
    ]);

    const result = await rebuildConversationAggregatesFromTranscript(
      GROUP,
      conv.id,
    );
    expect(result.last_user_at).toBeNull();
    expect(result.last_assistant_at).toBe('2026-06-30T04:01:00.000Z');

    const after = await getConversation(conv.id);
    expect(after?.last_user_at).toBeNull();
    expect(after?.last_assistant_at).toBe('2026-06-30T04:01:00.000Z');
  });
});
