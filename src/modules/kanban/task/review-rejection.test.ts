import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createTask, getTask, initDatabase } from '../../../db.js';
import { getGroupDir } from '../../../group-dir.js';
import { taskFixture, truncateTestDb } from '../../../test-helpers.js';
import { readTaskMessages } from '../../transcripts/transcript-store.js';
import {
  buildFirstRejectionComparison,
  type ReviewDecision,
} from '../review.js';
import {
  createReviewRejectionPreparer,
  type AuxiliaryWorkerInput,
  type ReviewRejectionDeps,
} from './review-rejection.js';

const project = 'review-rejection-test';
const decision: ReviewDecision = {
  decision: 'reject',
  score: 4,
  issues: [{ title: 'Fix gate', description: 'Needs work' }],
  summary: 'gate is incorrect',
};
const comparisonJson =
  '{"decision":"retry","progress":"new_issue","resolved_issue_ids":[],"persistent_issue_ids":[],"new_issue_ids":["fix gate needs work"],"reason":"new defect"}';

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
});
afterAll(() => rmSync(getGroupDir(project), { recursive: true, force: true }));

async function setup(
  custom_values: Record<string, string | number> | undefined,
  output = comparisonJson,
  overrides: Partial<ReviewRejectionDeps> = {},
) {
  const task = await createTask({
    ...taskFixture({ project_id: project, description: 'Review me.' }),
    status: 'review',
    custom_values,
  });
  const calls: AuxiliaryWorkerInput[] = [];
  const deps: ReviewRejectionDeps = {
    task,
    targetStatus: 'implementation',
    getAgentName: () => 'agent-a',
    getModelName: () => 'model-1',
    getRunId: () => null,
    getReviewHead: () => 'head-1',
    clearTaskStream: () => {},
    runAuxiliary: async (input, onChunk) => {
      calls.push(input);
      onChunk?.({ type: 'text', content: output } as never);
      return { status: 'success', result: '' } as never;
    },
    ...overrides,
  };
  const preparer = createReviewRejectionPreparer(deps);
  const prepare = (assistantContent: string) =>
    preparer({ reviewDecision: decision, assistantContent });
  const contents = () =>
    readTaskMessages(project, task.id).map((m) => m.content);
  return { task, calls, prepare, contents };
}

test('first rejection runs no comparison and writes no comparison note', async () => {
  const { calls, prepare, contents } = await setup(undefined);
  const result = await prepare('v');
  expect(calls).toHaveLength(0);
  expect(result.rejectionComparison).toEqual(
    buildFirstRejectionComparison(decision),
  );
  expect(contents().join()).not.toContain('Review comparison');
});

test('later rejection persists pending state, compares and writes the note', async () => {
  const { calls, prepare, contents, task } = await setup({
    rejection_count: 1,
  });
  const result = await prepare('verdict');
  const values = (await getTask(task.id))?.custom_values;
  expect(values?.pending_review_decision).toBe(JSON.stringify(decision));
  expect(values?.pending_review_head).toBe('head-1');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain('Review me.');
  expect(result.rejectionComparison?.reason).toBe('new defect');
  expect(contents()).toContain('**Review comparison** — retry: new defect');
});

test('empty comparison output and result writes the failure note', async () => {
  const { prepare, contents } = await setup({ rejection_count: 1 }, '');
  const result = await prepare('v');
  expect(result.rejectionComparison).toBeUndefined();
  expect(contents().join()).toContain('**Review comparison failed**');
});

test('model name and default head are read at call time', async () => {
  let model: string | null = null;
  let head: string | undefined;
  const { prepare, task } = await setup({ rejection_count: 1 }, undefined, {
    getModelName: () => model,
    getReviewHead: () => head,
  });
  model = 'model-2';
  head = 'head-2';
  await prepare('verdict');
  const feedback = readTaskMessages(project, task.id).find(
    (m) => m.content === 'verdict',
  );
  expect(feedback?.model_name).toBe('model-2');
  expect((await getTask(task.id))?.custom_values?.pending_review_head).toBe(
    'head-2',
  );
});

test('whitespace-only assistantContent writes no feedback message', async () => {
  const { prepare, contents } = await setup(undefined);
  await prepare('  \n ');
  expect(contents()).toHaveLength(1);
});

test('falls back to the in-memory task when getTask finds nothing', async () => {
  const ghost = taskFixture({
    project_id: project,
    description: 'Ghost desc',
    custom_values: { rejection_count: 1 },
  });
  const { calls, prepare } = await setup(undefined, undefined, {
    task: { ...ghost, id: 'task-missing', created_at: 'now' },
  });
  await prepare('');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain('Ghost desc');
});

test('runAuxiliary failure propagates', async () => {
  const { prepare } = await setup({ rejection_count: 1 }, undefined, {
    runAuxiliary: async () => {
      throw new Error('aux boom');
    },
  });
  const run = prepare('v');
  await expect(run).rejects.toThrow('aux boom');
});
