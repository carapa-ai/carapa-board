import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as chatAgents from '../../lib/chat-agents.js';
import * as groupDir from '../../group-dir.js';
import * as transcriptStore from '../transcripts/transcript-store.js';
import * as directLlm from './direct-llm.js';
import * as dbChats from './db-chats.js';
import * as conversationScope from './conversation-scope.js';
import {
  pauseBackgroundWork,
  resumeBackgroundWork,
} from '../../lib/background-work-gate.js';
import {
  generateConversationTitle,
  nameConversationInBackground,
} from './conversation-title.js';

afterEach(() => {
  mock.restore();
  resumeBackgroundWork();
});

test('conversation titles declare helper purpose for their own project', async () => {
  const agent = {
    id: 'title-agent',
    harnessKind: 'direct',
    model: 'title-model',
    baseUrl: 'https://remote.example/v1',
  };
  spyOn(chatAgents, 'getDefaultRuntimeSelection').mockReturnValue({
    harnessId: 'h',
    modelId: 'title-model',
  } as any);
  spyOn(chatAgents, 'getChatAgents').mockReturnValue([
    { ...agent, harnessId: 'h', modelId: 'title-model' },
  ] as any);
  spyOn(chatAgents, 'resolveRuntimeSelection').mockReturnValue(agent as any);
  spyOn(groupDir, 'readChatTranscript').mockReturnValue([]);
  spyOn(groupDir, 'appendChatTranscriptEntry').mockImplementation(() => {});
  spyOn(transcriptStore, 'formatTranscriptEntries').mockReturnValue([
    { type: 'message', role: 'user', content: 'Plan the launch' },
  ] as any);
  const llm = spyOn(directLlm, 'runDirectLlm').mockResolvedValue({
    result: 'Launch plan',
  } as any);

  expect(await generateConversationTitle('title-project', 'conv-1')).toBe(
    'Launch plan',
  );
  expect(llm.mock.calls[0]?.[6]?.privacy).toEqual({
    projectId: 'title-project',
    purpose: 'helper',
  });
});

function stubTitleBackend(title: string | null) {
  const agent = {
    id: 'a',
    harnessKind: 'direct',
    model: 'm',
    baseUrl: 'http://x/v1',
  };
  spyOn(chatAgents, 'getDefaultRuntimeSelection').mockReturnValue({
    harnessId: 'h',
    modelId: 'm',
  } as any);
  spyOn(chatAgents, 'getChatAgents').mockReturnValue([
    { ...agent, harnessId: 'h', modelId: 'm' },
  ] as any);
  spyOn(chatAgents, 'resolveRuntimeSelection').mockReturnValue(agent as any);
  spyOn(groupDir, 'readChatTranscript').mockReturnValue([]);
  spyOn(groupDir, 'appendChatTranscriptEntry').mockImplementation(() => {});
  spyOn(transcriptStore, 'formatTranscriptEntries').mockReturnValue([
    { type: 'message', role: 'user', content: 'Plan the launch' },
  ] as any);
  spyOn(conversationScope, 'broadcastConversationEvent').mockImplementation(
    () => {},
  );
  spyOn(dbChats, 'getConversation').mockResolvedValue({
    group_folder: 'p',
    title,
  } as any);
  const save = spyOn(
    dbChats,
    'updateConversationTitleIfUntitled',
  ).mockResolvedValue(true);
  const llm = spyOn(directLlm, 'runDirectLlm').mockResolvedValue({
    result: 'Launch plan',
  } as any);
  return { save, llm };
}

test('background naming titles an untitled conversation once', async () => {
  const { save, llm } = stubTitleBackend(null);
  nameConversationInBackground('p', 'c1');
  nameConversationInBackground('p', 'c1');
  await Bun.sleep(20);
  expect(llm).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('c1', 'p', 'Launch plan');
});

test('background naming leaves titled conversations and paused gates alone', async () => {
  const titled = stubTitleBackend('Manual');
  nameConversationInBackground('p', 'c2');
  await Bun.sleep(20);
  expect(titled.llm).not.toHaveBeenCalled();
  mock.restore();

  const paused = stubTitleBackend(null);
  pauseBackgroundWork('test');
  nameConversationInBackground('p', 'c3');
  await Bun.sleep(20);
  expect(paused.llm).not.toHaveBeenCalled();
});
