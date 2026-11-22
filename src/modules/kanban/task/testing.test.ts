import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Load the tool registry first: kanban/tools.js and the registry import each
// other, and evaluating kanban/tools.js first leaves its exports uninitialized.
import '../../tools/registry.js';
import { GROUPS_DIR } from '../../../config.js';
import {
  appendRunStartMarker,
  readTaskMessages,
} from '../../transcripts/transcript-store.js';
import type { TestingDecision } from '../testing.js';
import { persistTestingAssistantResponse } from './testing.js';
import { resultsByRun } from '../tools.js';

const PROJECT = 'testing-run-result-test';

afterAll(() => {
  fs.rmSync(path.join(GROUPS_DIR, PROJECT), { recursive: true, force: true });
});

function persist(
  taskId: string,
  assistantContent: string,
  decision: TestingDecision,
) {
  const runId = `run-${taskId}`;
  appendRunStartMarker(PROJECT, taskId, runId);
  persistTestingAssistantResponse({
    task: { id: taskId, project_id: PROJECT } as any,
    assistantContent,
    agent_name: 'tester',
    model_name: 'model',
    runId,
    decision,
  });
  const messages = readTaskMessages(PROJECT, taskId);
  return {
    runId,
    messages,
    results: messages.filter((m) => m.entry_type === 'run_result'),
  };
}

describe('persistTestingAssistantResponse', () => {
  test.each(['pass', 'fail', 'blocked'] as const)(
    'stores the verdict as the run result for JSON-only %s output',
    (verdict) => {
      const decision: TestingDecision = {
        decision: verdict,
        summary: 'Ran the suite.',
        issues: verdict === 'pass' ? [] : ['first problem', 'second problem'],
      };
      const { runId, messages, results } = persist(
        `task-json-only-${verdict}`,
        JSON.stringify(decision),
        decision,
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ role: 'assistant', run_id: runId });
      expect(results[0].content).toContain('Ran the suite.');
      for (const issue of decision.issues)
        expect(results[0].content).toContain(issue);
      expect(resultsByRun(messages).get(runId)?.content).toBe(
        results[0].content,
      );
    },
  );

  test('keeps only the prose when the output has prose plus JSON', () => {
    const decision: TestingDecision = {
      decision: 'pass',
      summary: 'Ran the suite.',
      issues: [],
    };
    const { results } = persist(
      'task-prose',
      `All 12 tests passed.\n\n${JSON.stringify(decision)}`,
      decision,
    );
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('All 12 tests passed.');
  });
});
