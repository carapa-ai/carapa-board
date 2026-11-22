import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';

import { initDatabase, createConversation } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import { readChatTranscript, getGroupDir } from '../../group-dir.js';
import {
  registeredGroups,
  applyGroupUpdateInMemory,
} from '../../state-manager.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import { sendMessageTool } from './core-tools.js';

const UI_FOLDER = 'send-message-ui-project';
const WA_FOLDER = 'send-message-wa-project';
const UI_JID = `ui-${UI_FOLDER}`;
const WA_JID = '123456@g.us';

const sent: Array<{ jid: string; text: string }> = [];
const deps = {
  sendMessage: async (jid: string, text: string) => {
    sent.push({ jid, text });
  },
} as unknown as McpServerDeps;

function transcriptTexts(folder: string, conversationId: string): string[] {
  return readChatTranscript(folder, conversationId)
    .filter((e: any) => e.type === 'message')
    .map((e: any) => e.content);
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb(); // disables FK checks for ad-hoc project ids
  for (const [jid, folder] of [
    [UI_JID, UI_FOLDER],
    [WA_JID, WA_FOLDER],
  ]) {
    registeredGroups[jid] = {
      name: folder,
      folder,
      trigger: '@bot',
      added_at: new Date().toISOString(),
    };
    applyGroupUpdateInMemory(jid, {});
  }
});

afterAll(() => {
  for (const folder of [UI_FOLDER, WA_FOLDER]) {
    fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
  }
});

describe('send_message tool', () => {
  test('UI-only project in a chat run persists to the conversation without an external send', async () => {
    const conv = await createConversation(UI_FOLDER);
    sent.length = 0;

    const result = await sendMessageTool.handler(
      { text: 'hello from ui' },
      deps,
      { group_folder: UI_FOLDER, conversation_id: conv.id },
    );

    expect(result).toBe('Message sent');
    expect(sent).toEqual([]);
    expect(transcriptTexts(UI_FOLDER, conv.id)).toEqual(['hello from ui']);
  });

  test('WhatsApp project in a chat run persists to the conversation and sends externally', async () => {
    const conv = await createConversation(WA_FOLDER);
    sent.length = 0;

    await sendMessageTool.handler({ text: 'hello from wa' }, deps, {
      group_folder: WA_FOLDER,
      conversation_id: conv.id,
    });

    expect(sent.map((s) => s.jid)).toEqual([WA_JID]);
    expect(transcriptTexts(WA_FOLDER, conv.id)).toEqual(['hello from wa']);
  });

  test('throws a clear error when there is neither a task nor a conversation for a UI-only project', async () => {
    await expect(
      sendMessageTool.handler({ text: 'x' }, deps, { group_folder: UI_FOLDER }),
    ).rejects.toThrow('Could not resolve chat destination');
  });
});
