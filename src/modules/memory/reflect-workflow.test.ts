/**
 * Tests for the out-of-band `/reflect` workflow wrapper (DirectLLM runtimes).
 *
 * The tool-driven reflection pipeline itself is covered by
 * `tool-reflector.test.ts`; here we only guard the wrapper's gates:
 * memory-system disabled and missing reflector runtime configuration.
 */

import { describe, expect, it } from 'bun:test';
import {
  runReflectWorkflow,
  type ReflectWorkflowDependencies,
} from './reflect-workflow.js';

const GROUP = 'reflect-workflow';

function disabledDependencies(): ReflectWorkflowDependencies {
  return {
    getMemoryConfig: () =>
      ({
        enabled: false,
        observer: {
          llm: { maxTokens: 1024 },
          minTranscriptLength: 200,
          excludeGroups: [],
          maxTokensPerChunk: 5000,
        },
        reflector: {
          llm: { maxTokens: 4096 },
        },
        mainGroup: 'main',
      }) as never,
  };
}

describe('runReflectWorkflow gates', () => {
  it('refuses to run when the memory system is disabled', async () => {
    const result = await runReflectWorkflow(
      { group_folder: GROUP, transcriptPath: '/tmp/reflect.jsonl' },
      disabledDependencies(),
    );
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.errors).toContain('memory_disabled');
  });
});
