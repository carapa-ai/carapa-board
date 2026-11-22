import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createConversation, getChatMessages, initDatabase } from '../../db.js';
import { getGroupDir, appendChatTranscriptEntry } from '../../group-dir.js';
import { truncateTestDb } from '../../test-helpers.js';

const GROUP = 'codex-transcript-projection-test';

function cleanTranscripts(): void {
  fs.rmSync(path.join(getGroupDir(GROUP), 'transcripts'), {
    recursive: true,
    force: true,
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await truncateTestDb();
  cleanTranscripts();
});

afterAll(cleanTranscripts);

describe('Codex transcript projection', () => {
  test('reloads completed agent messages in transcript order without duplicates', async () => {
    const conversation = await createConversation(GROUP);

    appendChatTranscriptEntry(GROUP, conversation.id, {
      id: 'user-1',
      type: 'message',
      role: 'user',
      content: 'Please investigate this.',
      created_at: '2026-08-04T10:00:00.000Z',
      conversation_id: conversation.id,
    });
    appendChatTranscriptEntry(GROUP, conversation.id, {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'I found the relevant transcript path.',
      },
    });
    // Recovery can replay the same raw completion event. It must not create a
    // second assistant bubble when no canonical `type: 'message'` was saved.
    appendChatTranscriptEntry(GROUP, conversation.id, {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'I found the relevant transcript path.',
      },
    });
    appendChatTranscriptEntry(GROUP, conversation.id, {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: 'The fix is complete.',
      },
    });
    appendChatTranscriptEntry(GROUP, conversation.id, {
      type: 'item.completed',
      item: { type: 'reasoning', text: 'Internal reasoning' },
    });
    appendChatTranscriptEntry(GROUP, conversation.id, {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'bun test' },
    });

    // getChatMessages is newest-first; reverse to assert transcript order.
    const messages = (
      await getChatMessages(GROUP, 20, conversation.id)
    ).reverse();
    expect(
      messages.map((message) => [message.id, message.role, message.content]),
    ).toEqual([
      ['user-1', 'user', 'Please investigate this.'],
      [
        expect.any(String),
        'assistant',
        'I found the relevant transcript path.',
      ],
      [expect.any(String), 'assistant', 'The fix is complete.'],
    ]);
    expect(messages[1].created_at).not.toBe('1970-01-01T00:00:00.001Z');
    expect(new Date(messages[1].created_at).getTime()).toBeGreaterThan(0);
  });

  test('uses surrounding turn metadata for later id-less turns and remains stable without an epoch id', async () => {
    const conversationId = 'imported-codex-session';
    appendChatTranscriptEntry(GROUP, conversationId, {
      type: 'message',
      role: 'user',
      content: 'First question',
      created_at: '2026-08-04T10:00:00.000Z',
    });
    appendChatTranscriptEntry(GROUP, conversationId, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'First response' },
    });
    appendChatTranscriptEntry(GROUP, conversationId, {
      type: 'turn_outcome',
      created_at: '2026-08-04T10:01:00.000Z',
    });
    appendChatTranscriptEntry(GROUP, conversationId, {
      type: 'message',
      role: 'user',
      content: 'Second question',
      created_at: '2026-08-04T11:00:00.000Z',
    });
    appendChatTranscriptEntry(GROUP, conversationId, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Second response' },
    });
    appendChatTranscriptEntry(GROUP, conversationId, {
      type: 'turn_outcome',
      created_at: '2026-08-04T11:02:00.000Z',
    });

    const firstRead = await getChatMessages(GROUP, 20, conversationId);
    const secondRead = await getChatMessages(GROUP, 20, conversationId);
    const chronological = [...firstRead].reverse();
    expect(
      chronological.filter((message) => message.role === 'assistant'),
    ).toMatchObject([
      { content: 'First response', created_at: '2026-08-04T10:01:00.000Z' },
      { content: 'Second response', created_at: '2026-08-04T11:02:00.000Z' },
    ]);
    expect(secondRead.map((message) => message.id)).toEqual(
      firstRead.map((message) => message.id),
    );
  });

  test('keeps persisted partial agent messages from failed turns without fabricating one from telemetry', async () => {
    const withPartial = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, withPartial.id, {
      type: 'item.completed',
      item: { id: 'partial', type: 'agent_message', text: 'Partial answer.' },
    });
    appendChatTranscriptEntry(GROUP, withPartial.id, {
      type: 'turn_outcome',
      failed: true,
      created_at: '2026-08-04T10:01:00.000Z',
    });

    expect(await getChatMessages(GROUP, 20, withPartial.id)).toMatchObject([
      { id: 'partial', role: 'assistant', content: 'Partial answer.' },
    ]);

    const telemetryOnly = await createConversation(GROUP);
    appendChatTranscriptEntry(GROUP, telemetryOnly.id, {
      type: 'telemetry',
      telemetry: { tok_output: 42 },
    });
    appendChatTranscriptEntry(GROUP, telemetryOnly.id, {
      type: 'turn_outcome',
      failed: true,
      created_at: '2026-08-04T10:02:00.000Z',
    });

    expect(await getChatMessages(GROUP, 20, telemetryOnly.id)).toEqual([]);
  });
});
