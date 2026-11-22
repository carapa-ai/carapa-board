import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as chatAgents from '../lib/chat-agents.js';
import * as directLlm from '../modules/chat/direct-llm.js';
import { suggestWorkingTreeCommitMessage } from './conversations.js';

afterEach(() => mock.restore());

const files = [{ path: 'src/a.ts', additions: 1, deletions: 0 }] as any;

test('commit message suggestions declare helper purpose for the project and keep the refusal fallback', async () => {
  const agent = {
    id: 'commit-agent',
    harnessId: 'h',
    modelId: 'commit-model',
    harnessKind: 'direct',
    model: 'commit-model',
    baseUrl: 'https://remote.example/v1',
  };
  spyOn(chatAgents, 'getChatAgents').mockReturnValue([agent] as any);
  spyOn(chatAgents, 'getDefaultRuntimeSelection').mockReturnValue({
    harnessId: 'h',
    modelId: 'commit-model',
  } as any);
  const llm = spyOn(directLlm, 'runDirectLlm').mockResolvedValue({
    result: 'feat: add a',
  } as any);
  const group = { folder: 'commit-project', settings: {} } as any;

  expect(
    await suggestWorkingTreeCommitMessage(group, null, files, 'diff'),
  ).toBe('feat: add a');
  expect(llm.mock.calls[0]?.[6]?.privacy).toEqual({
    projectId: 'commit-project',
    purpose: 'helper',
  });

  llm.mockRejectedValue(new Error('privacy refusal'));
  expect(
    await suggestWorkingTreeCommitMessage(group, null, files, 'diff'),
  ).toBe('chore: update a');
});
