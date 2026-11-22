/**
 * Tests for the consolidated-telemetry persistence path in `db-chats.ts`:
 *
 *   `saveChatMessage` MUST append a `type:'telemetry'` companion entry to
 *   the JSONL transcript even when the caller passes `skipTranscript: true`
 *   (the streaming flow does this — content was already written
 *   incrementally via `appendChatTranscriptEntry`, but the post-run
 *   consolidated telemetry still needs to land in the transcript so a
 *   reloaded bubble renders duration / context / session / cache info).
 *
 *   Companion-telemetry adjacency is critical: the chat-page renderer
 *   matches `type:'telemetry'` entries to the assistant segment being
 *   built at the file position — a stray telemetry line elsewhere in the
 *   JSONL would glue metrics to the wrong bubble.
 *
 * Pinned here after code review against the staged rollout of the
 * `chat_messages` retirement so future refactors stay correct. The legacy
 * telemetry-backfill path (and the tests that seeded rows into the
 * dropped `chat_messages` table) was removed in stage 4 — the migration
 * is complete and there is nothing left to backfill.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  beforeAll,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  initDatabase,
  createConversation,
  saveChatMessage,
  getChatMessages,
} from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  appendChatTranscriptEntry,
  readChatTranscript,
  getGroupDir,
} from '../../group-dir.js';

const GROUP = 'telemetry-persistence-test';

/** Write a complete assistant message entry into the transcript (mirrors the
 *  streaming path: text chunks arrive via `appendChatTranscriptEntry`). */
function writeAssistantMessage(
  conversation_id: string,
  id: string,
  content: string,
  created_at: string,
): void {
  appendChatTranscriptEntry(GROUP, conversation_id, {
    id,
    type: 'message',
    role: 'assistant',
    content,
    source: 'web',
    created_at,
    conversation_id,
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await truncateTestDb();
  // Clean any residual transcript files from a previous test in this group.
  try {
    fs.rmSync(path.join(getGroupDir(GROUP), 'transcripts'), {
      recursive: true,
      force: true,
    });
  } catch {}
});

afterAll(() => {
  try {
    fs.rmSync(path.join(getGroupDir(GROUP), 'transcripts'), {
      recursive: true,
      force: true,
    });
  } catch {}
});

// ─── Fix 1: saveChatMessage companion telemetry for skipTranscript saves ─────

describe('saveChatMessage telemetry persistence', () => {
  test('persists deep links on the user transcript entry', async () => {
    const conv = await createConversation(GROUP);
    const deepLinks = [
      {
        label: 'Edit',
        href: '/memory-review?batchId=batch-1&projectId=project-1&itemId=memory-1&action=edit',
        variant: 'outline' as const,
      },
    ];

    await saveChatMessage({
      id: 'chat-user-deep-links',
      group_folder: GROUP,
      role: 'user',
      content: 'Verify this memory.',
      source: 'web',
      created_at: '2026-07-31T10:00:00.000Z',
      conversation_id: conv.id,
      deepLinks,
    });

    const entries = readChatTranscript(GROUP, conv.id) as Array<
      Record<string, unknown>
    >;
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: 'chat-user-deep-links',
        deepLinks,
      }),
    );
  });

  test('writes a type:telemetry companion entry to the transcript even when skipTranscript is true', async () => {
    // Live streaming scenario: the message text was already appended during
    // the run; the route layer now calls `saveChatMessage(...,
    // skipTranscript: true, telemetry: runTelemetry)` to persist the DB row
    // and the consolidated metrics. The consolidated metrics MUST land in
    // the transcript, not be silently dropped because of `skipTranscript`.
    const conv = await createConversation(GROUP);
    writeAssistantMessage(
      conv.id,
      'chat-streaming-1',
      'live reply text',
      '2026-06-30T10:00:00.000Z',
    );

    const telemetry = {
      tok_input: 1234,
      tok_output: 56,
      total_tokens: 1290,
      tok_context_last: 1290,
      duration_ms: 4321,
      model_name: 'claude-sonnet-4-6',
      context_size: 200000,
      session_id: 'sess-streaming-1',
      tok_cache_read: 200,
      tok_cache_write: 0,
    };

    await saveChatMessage({
      id: 'chat-streaming-1',
      group_folder: GROUP,
      role: 'assistant',
      content: 'live reply text',
      source: 'web',
      created_at: '2026-06-30T10:00:00.000Z',
      conversation_id: conv.id,
      telemetry,
      skipTranscript: true,
    });

    const entries = readChatTranscript(GROUP, conv.id) as Array<
      Record<string, unknown>
    >;
    const telemetryEntries = entries.filter(
      (e) => e.type === 'telemetry' && e.id === 'chat-streaming-1',
    );
    expect(telemetryEntries.length).toBe(1);
    expect(telemetryEntries[0].telemetry).toEqual(telemetry);
  });

  test('telemetry companion entry is adjacent to the message entry it pairs with', async () => {
    // The chat-page renderer matches `type:'telemetry'` entries to the
    // assistant segment being built at the file position — keep the pair
    // local so a reloaded bubble shows the right metrics. Simulate the
    // streaming flow: message content has already been appended during
    // the run; the post-run `saveChatMessage` then writes the telemetry
    // companion.
    const conv = await createConversation(GROUP);
    const userMsgTs = '2026-06-30T10:00:00.000Z';
    const asstMsgTs = '2026-06-30T10:00:05.000Z';
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'chat-user-1',
      type: 'message',
      role: 'user',
      content: 'hello',
      source: 'web',
      created_at: userMsgTs,
      conversation_id: conv.id,
    });
    appendChatTranscriptEntry(GROUP, conv.id, {
      id: 'chat-asst-1',
      type: 'message',
      role: 'assistant',
      content: 'world',
      source: 'web',
      created_at: asstMsgTs,
      conversation_id: conv.id,
    });

    await saveChatMessage({
      id: 'chat-asst-1',
      group_folder: GROUP,
      role: 'assistant',
      content: 'world',
      source: 'web',
      created_at: asstMsgTs,
      conversation_id: conv.id,
      telemetry: { duration_ms: 999, model_name: 'claude-sonnet-4-6' },
      skipTranscript: true,
    });

    const entries = readChatTranscript(GROUP, conv.id) as Array<
      Record<string, unknown>
    >;
    const asstIdx = entries.findIndex(
      (e) => e.id === 'chat-asst-1' && e.type === 'message',
    );
    expect(asstIdx).toBeGreaterThanOrEqual(0);

    // The telemetry line must come immediately after the message it pairs
    // with, sharing the same `id`.
    expect(asstIdx + 1).toBeLessThan(entries.length);
    expect((entries[asstIdx + 1] as any).type).toBe('telemetry');
    expect((entries[asstIdx + 1] as any).id).toBe('chat-asst-1');
  });
});

describe('saveChatMessage generated-image attachment persistence', () => {
  test('merges an attachment companion into the streamed assistant bubble on reload', async () => {
    const conv = await createConversation(GROUP);
    writeAssistantMessage(
      conv.id,
      'chat-streamed-image',
      'Here is the generated image.',
      '2026-06-30T11:00:00.000Z',
    );

    await saveChatMessage({
      // The post-run save can have a different generated id than the
      // incrementally streamed transcript entry. Reload should still attach
      // the artifact to the immediately preceding assistant bubble.
      id: 'chat-post-run-image',
      group_folder: GROUP,
      role: 'assistant',
      content: 'Here is the generated image.',
      source: 'web',
      created_at: '2026-06-30T11:00:00.000Z',
      conversation_id: conv.id,
      attachments: [
        {
          type: 'image',
          url: '/artifacts/telemetry-persistence-test/images/generated.png',
          mimetype: 'image/png',
          filename: 'generated.png',
          path: '/workspace/telemetry-persistence-test/artifacts/images/generated.png',
        },
      ],
      skipTranscript: true,
    });

    const messages = await getChatMessages(GROUP, 100, conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Here is the generated image.');
    expect(messages[0].attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        filename: 'generated.png',
      }),
    ]);
  });

  test('shows a generated artifact only on its first assistant bubble', async () => {
    const conv = await createConversation(GROUP);
    const attachment = {
      type: 'image' as const,
      url: '/artifacts/telemetry-persistence-test/images/generated.png',
      mimetype: 'image/png',
      filename: 'generated.png',
      path: '/workspace/telemetry-persistence-test/artifacts/images/generated.png',
    };

    writeAssistantMessage(
      conv.id,
      'first-image-reply',
      'Generated.',
      '2026-06-30T12:00:00.000Z',
    );
    await saveChatMessage({
      id: 'first-image-companion',
      group_folder: GROUP,
      role: 'assistant',
      content: 'Generated.',
      source: 'web',
      created_at: '2026-06-30T12:00:00.000Z',
      conversation_id: conv.id,
      attachments: [attachment],
      skipTranscript: true,
    });

    appendChatTranscriptEntry(GROUP, conv.id, {
      type: 'message',
      role: 'user',
      content: 'Next question',
      created_at: '2026-06-30T12:01:00.000Z',
      conversation_id: conv.id,
    });
    writeAssistantMessage(
      conv.id,
      'later-reply',
      'Plain response.',
      '2026-06-30T12:02:00.000Z',
    );
    await saveChatMessage({
      id: 'polluted-later-companion',
      group_folder: GROUP,
      role: 'assistant',
      content: 'Plain response.',
      source: 'web',
      created_at: '2026-06-30T12:02:00.000Z',
      conversation_id: conv.id,
      attachments: [attachment],
      skipTranscript: true,
    });

    const messages = await getChatMessages(GROUP, 100, conv.id);
    const first = messages.find(
      (message) => message.id === 'first-image-reply',
    );
    const later = messages.find((message) => message.id === 'later-reply');
    expect(first?.attachments).toHaveLength(1);
    expect(later?.attachments ?? []).toHaveLength(0);
  });
});
