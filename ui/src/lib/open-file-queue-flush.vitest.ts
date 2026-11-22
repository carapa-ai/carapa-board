import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { flushQueuedPromptsAfterCompletion } from './websocket';

describe('open-file queued prompt persistence and flush', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ queuedPromptsByConv: {} });
  });

  it('persists the captured snapshot and flushes that snapshot unchanged', async () => {
    useStore.getState().enqueuePrompt('conversation-1', {
      id: 'queued-context',
      contextKey: 'project-1',
      content: 'fix queued file',
      bubbleContent: 'fix queued file',
      memoryContextLevel: 'off',
      openFileContext: {
        source: 'artifact',
        path: 'plans/original.md',
        line: 12,
        column: 3,
      },
    });
    await Promise.resolve();
    expect(localStorage.getItem('carapa-ui-state')).toContain(
      'plans/original.md',
    );

    const sendChatMessage = vi.fn(async () => ({
      conversation_id: 'conversation-1',
    }));
    await flushQueuedPromptsAfterCompletion(
      { conversation_id: 'conversation-1', project_id: 'project-1' },
      {
        sendChatMessage: sendChatMessage as never,
      },
    );
    expect(sendChatMessage.mock.calls[0]?.at(-1)).toEqual({
      source: 'artifact',
      path: 'plans/original.md',
      line: 12,
      column: 3,
    });
    expect(useStore.getState().queuedPromptsByConv['conversation-1']).toEqual([
      expect.objectContaining({
        id: 'queued-context',
        openFileContext: {
          source: 'artifact',
          path: 'plans/original.md',
          line: 12,
          column: 3,
        },
        serverOwned: true,
      }),
    ]);
  });
});
