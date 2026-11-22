import { describe, expect, mock, test } from 'bun:test';

// Global module mock: this file is listed in `ci_backend_isolated_test_files`.
const realLlmClient = await import('../../lib/llm-client.js');
const llmComplete = mock(async () => ({ content: '[]' }) as any);
mock.module('../../lib/llm-client.js', () => ({
  ...realLlmClient,
  llmComplete,
}));

const { defaultDeps } = await import('./history-reflection.js');

describe('history reflection LLM privacy attribution', () => {
  test('observer and reflector calls carry the previewed project and memory purpose', async () => {
    const deps = defaultDeps({ projectId: 'history-project' });
    await deps.extractCandidates('system', 'user');
    await deps.reflect('system', 'user');

    expect(llmComplete).toHaveBeenCalledTimes(2);
    for (const call of llmComplete.mock.calls as unknown as unknown[][]) {
      expect(call[3]).toMatchObject({
        projectId: 'history-project',
        privacyPurpose: 'memory',
      });
    }
  });
});
