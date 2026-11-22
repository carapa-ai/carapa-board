import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { initDatabase, createConversation } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  readChatTranscript,
  appendChatTranscriptEntry,
  getGroupDir,
} from '../../group-dir.js';
import { copyChatTranscript } from '../transcripts/transcript-store.js';

const GROUP = 'copy-slicing-test';

/**
 * Regression tests for conversation fork slicing.
 *
 * The fork UI now only offers "fork from here" on USER messages (the only
 * bubbles that carry a backend-resolvable id). Forking from a user message N
 * must copy the conversation UP TO AND INCLUDING message N and then stop — the
 * following assistant response is dropped, because the fork prompt the user
 * types replaces it.
 *
 * Bug history: copyChatTranscript forward-extended the slice through the
 * trailing assistant turn for EVERY match, so forking from the last user
 * message extended to the end of the conversation and copied the whole thing.
 */
describe('fork slicing', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
  });

  afterAll(() => {
    const dir = path.join(getGroupDir(GROUP), 'transcripts');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  // --- Transcript JSONL copy (copyChatTranscript) ---

  function writeUser(convId: string, id: string, content: string, at: string) {
    appendChatTranscriptEntry(GROUP, convId, {
      id,
      type: 'message',
      role: 'user',
      content,
      source: 'web',
      created_at: at,
    });
  }
  function writeAssistant(convId: string, text: string, at: string) {
    appendChatTranscriptEntry(GROUP, convId, {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      agent_name: 'claude',
      created_at: at,
    });
    appendChatTranscriptEntry(GROUP, convId, {
      type: 'result',
      result: text,
      created_at: at,
    });
  }

  test('copyChatTranscript forks from the LAST user message without the trailing assistant turn', async () => {
    await truncateTestDb();
    const source = await createConversation(GROUP);
    const target = await createConversation(GROUP);
    writeUser(source.id, 'chat-1', 'u1', '2026-06-27T10:00:01.000Z');
    writeAssistant(source.id, 'a1', '2026-06-27T10:00:02.000Z');
    writeUser(source.id, 'chat-3', 'u2', '2026-06-27T10:00:03.000Z');
    writeAssistant(source.id, 'a2', '2026-06-27T10:00:04.000Z');
    writeUser(source.id, 'chat-5', 'u3', '2026-06-27T10:00:05.000Z');
    writeAssistant(source.id, 'a3', '2026-06-27T10:00:06.000Z');

    await copyChatTranscript(GROUP, source.id, target.id, 'chat-5');
    const after = readChatTranscript(GROUP, target.id) as any[];
    // u1, a1(2), u2, a2(2), u3 = 7 raw entries; a3(2) dropped.
    expect(after.length).toBe(7);
    const last = after[after.length - 1];
    expect(last.role).toBe('user');
    expect(last.id).toBe('chat-5');
    expect(
      after.some(
        (e) => e.result === 'a3' || e.message?.content?.[0]?.text === 'a3',
      ),
    ).toBe(false);
  });

  test('copyChatTranscript forks from a MIDDLE user message up to and including it', async () => {
    await truncateTestDb();
    const source = await createConversation(GROUP);
    const target = await createConversation(GROUP);
    writeUser(source.id, 'chat-1', 'u1', '2026-06-27T10:00:01.000Z');
    writeAssistant(source.id, 'a1', '2026-06-27T10:00:02.000Z');
    writeUser(source.id, 'chat-3', 'u2', '2026-06-27T10:00:03.000Z');
    writeAssistant(source.id, 'a2', '2026-06-27T10:00:04.000Z');
    writeUser(source.id, 'chat-5', 'u3', '2026-06-27T10:00:05.000Z');

    await copyChatTranscript(GROUP, source.id, target.id, 'chat-3');
    const after = readChatTranscript(GROUP, target.id) as any[];
    // u1, a1(2), u2 = 4 raw entries; a2,u3 dropped.
    expect(after.length).toBe(4);
    expect(after[after.length - 1].id).toBe('chat-3');
    expect(after.some((e) => e.result === 'a2')).toBe(false);
  });

  // --- Forking AFTER an assistant turn (includeFollowingAssistantTurn) ---
  // The UI anchors an assistant-turn fork on the preceding USER message id and
  // sets includeFollowingAssistantTurn=true so the backend includes the
  // assistant reply that follows it (instead of dropping it like a user fork).

  test('copyChatTranscript includes the following assistant turn when the flag is set', async () => {
    await truncateTestDb();
    const source = await createConversation(GROUP);
    const target = await createConversation(GROUP);
    writeUser(source.id, 'chat-1', 'u1', '2026-06-27T10:00:01.000Z');
    writeAssistant(source.id, 'a1', '2026-06-27T10:00:02.000Z');
    writeUser(source.id, 'chat-3', 'u2', '2026-06-27T10:00:03.000Z');
    writeAssistant(source.id, 'a2', '2026-06-27T10:00:04.000Z');
    writeUser(source.id, 'chat-5', 'u3', '2026-06-27T10:00:05.000Z');
    writeAssistant(source.id, 'a3', '2026-06-27T10:00:06.000Z');

    // Fork after assistant turn a2: anchor on its preceding user message
    // (chat-3) and include a2's reply. Must NOT include u3/a3.
    await copyChatTranscript(GROUP, source.id, target.id, 'chat-3', true);
    const after = readChatTranscript(GROUP, target.id) as any[];
    // u1, a1(2), u2, a2(2) = 6 raw entries; u3, a3 dropped.
    expect(after.length).toBe(6);
    expect(
      after.some(
        (e) => e.result === 'a2' || e.message?.content?.[0]?.text === 'a2',
      ),
    ).toBe(true);
    expect(after.some((e) => e.id === 'chat-5')).toBe(false);
    expect(after.some((e) => e.result === 'a3')).toBe(false);
  });
});
