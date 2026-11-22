import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, createTask, getTask, updateTask } from '../../db.js';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { objectiveTaskEventHolds } from '../../db/schema.js';
import { taskFixture, truncateTestDb } from '../../test-helpers.js';
import { readTaskMessages } from '../transcripts/transcript-store.js';
import type { RegisteredGroup } from '../../types.js';
import * as brainClient from '../objectives/brain-client.js';
import type { StageDefinition } from './types.js';
import {
  MAX_TESTING_FORMAT_RETRIES,
  buildTestingTransportRecoveryOutput,
  buildTestingFormatRepairPrompt,
  parseTestingDecision,
  parseTestingDecisionWithRepair,
  shouldStartFreshTestingSession,
  stripAllTestingDecisions,
  TestingOutputStreamFilter,
  type TestingDecision,
} from './testing.js';
import {
  MAX_CONSECUTIVE_TESTING_FAILURES,
  TESTING_EVIDENCE_CARRIED_FROM_KEY,
  TESTING_HEAD_SHA_KEY,
  TESTING_TREE_SHA_KEY,
  ensureReviewHasCurrentTestingEvidence,
  getRequiredTestingStage,
  handleTestingDecision,
} from './task/testing.js';

const stages: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
  { id: 'question', title: 'Question', type: 'queue', color: '#fa0' },
  { id: 'in_progress', title: 'In Progress', type: 'active', color: '#33f' },
  { id: 'testing', title: 'Testing', type: 'testing', color: '#a3f' },
  { id: 'review', title: 'Review', type: 'review', color: '#f80' },
  { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
];
const group: RegisteredGroup = {
  name: 'Testing Project',
  folder: 'testing-project',
  trigger: '@Capa',
  added_at: 'now',
  settings: { stages },
};

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
});

const holdsFor = (taskId: string) =>
  drizzleDbRef.current
    .select()
    .from(objectiveTaskEventHolds)
    .where(eq(objectiveTaskEventHolds.task_id, taskId));

describe('testing verdict parsing', () => {
  test('retains bounded tool evidence after a testing transport failure', () => {
    const raw = JSON.stringify({
      type: 'tool_call',
      id: 'call-1',
      status: 'in_progress',
      name: 'bash',
      input: { command: '.agent/verify.sh' },
      outputDelta: {
        content: [{ type: 'text', text: `${'x'.repeat(20_000)}\nverify: OK` }],
      },
    });

    const recovered = buildTestingTransportRecoveryOutput(
      raw,
      '',
      'socket closed',
    );
    expect(recovered).toContain('.agent/verify.sh');
    expect(recovered).toContain('verify: OK');
    expect(recovered).toContain('socket closed');
    expect(recovered.length).toBeLessThanOrEqual(16_050);
  });

  test('never treats recovered tool output as a verdict but keeps a streamed one', () => {
    const verdict =
      'prompts/testing.md:12:{"decision":"pass","issues":[],"summary":"x"}';
    const raw = JSON.stringify({
      type: 'tool_call',
      id: 'call-1',
      status: 'completed',
      name: 'bash',
      input: { command: 'grep -rn decision prompts' },
      output: verdict,
    });

    expect(
      parseTestingDecision(
        buildTestingTransportRecoveryOutput(raw, '', 'socket hang up'),
      ),
    ).toBeNull();
    expect(
      parseTestingDecision(
        buildTestingTransportRecoveryOutput(
          raw,
          '{"decision":"fail","issues":["red"],"summary":"red"}',
          'socket hang up',
        ),
      ),
    ).toMatchObject({ decision: 'fail', issues: ['red'] });
  });

  test('accepts fenced and bare verdicts and prefers the last object', () => {
    expect(
      parseTestingDecision(
        '```json\n{"decision":"pass","issues":[],"summary":"green"}\n```',
      )?.decision,
    ).toBe('pass');
    expect(
      parseTestingDecision(
        'prose {"decision":"fail","issues":["tests failed"],"summary":"red"}',
      )?.decision,
    ).toBe('fail');
    expect(
      parseTestingDecision(
        '{"decision":"blocked","issues":["no credentials"],"summary":"blocked"}',
      )?.decision,
    ).toBe('blocked');
  });

  test('picks the later of a fenced and a bare verdict, ignoring tool-evidence fences', () => {
    const fail = '{"decision":"fail","issues":["red"],"summary":"red"}';
    const pass = '{"decision":"pass","issues":[],"summary":"green"}';
    expect(
      parseTestingDecision(`\`\`\`json\n${fail}\n\`\`\`\nFinal: ${pass}`)
        ?.decision,
    ).toBe('pass');
    expect(
      parseTestingDecision(`${fail}\nFinal:\n\`\`\`json\n${pass}\n\`\`\``)
        ?.decision,
    ).toBe('pass');
    expect(
      parseTestingDecision(
        `${pass}\n**Bash output**\n\`\`\`json\n${fail}\n\`\`\``,
      )?.decision,
    ).toBe('pass');
  });

  test('tolerates one stray bracket before the closing brace only', () => {
    expect(
      parseTestingDecision(
        '{"decision":"fail","issues":["a"],"summary":"done."]}',
      ),
    ).toMatchObject({ decision: 'fail', issues: ['a'], summary: 'done.' });
    expect(
      parseTestingDecision(
        '{"decision":"fail","issues":["a"],"summary":"x"]]}',
      ),
    ).toBeNull();
  });

  test('normalizes structured issue details from a valid tester verdict', () => {
    expect(
      parseTestingDecision(
        JSON.stringify({
          decision: 'fail',
          issues: [
            {
              group: 'latest snapshot coalescing',
              severity: 'high',
              evidence: 'The dispatched snapshot omitted dependencies.',
            },
          ],
          summary: 'Validation found a regression.',
        }),
      ),
    ).toEqual({
      decision: 'fail',
      issues: [
        'latest snapshot coalescing (high): The dispatched snapshot omitted dependencies.',
      ],
      summary: 'Validation found a regression.',
    });
  });

  test('rejects invalid outcomes and empty failure evidence', () => {
    expect(
      parseTestingDecision('{"decision":"approve","issues":[],"summary":"x"}'),
    ).toBeNull();
    expect(
      parseTestingDecision('{"decision":"fail","issues":[],"summary":"x"}'),
    ).toBeNull();
  });

  test('accepts verdict without summary (fail)', () => {
    expect(parseTestingDecision('{"decision":"fail","issues":["a"]}')).toEqual({
      decision: 'fail',
      issues: ['a'],
      summary: 'a',
    });
  });

  test('accepts verdict without summary (pass)', () => {
    expect(parseTestingDecision('{"decision":"pass","issues":[]}')).toEqual({
      decision: 'pass',
      issues: [],
      summary: 'testing pass',
    });
  });

  test('still rejects fail without issues', () => {
    expect(parseTestingDecision('{"decision":"fail","issues":[]}')).toBeNull();
  });

  test('repairs incomplete schema-targeted verdicts', async () => {
    const invalid = 'Checks completed\n{"decision":"pass"}';
    let repairPrompt = '';
    const repaired = await parseTestingDecisionWithRepair(
      invalid,
      'task context',
      async (prompt) => {
        repairPrompt = prompt;
        return '{"decision":"pass","issues":[],"summary":"fixed"}';
      },
    );
    expect(repaired.decision?.decision).toBe('pass');
    expect(repairPrompt).toContain(invalid);
  });
  test('selects the final bare verdict over earlier fenced candidates', () => {
    const output = [
      'before',
      '```json',
      '{"decision":"pass","issues":[],"summary":"earlier"}',
      '```',
      '```json',
      '{"decision":"fail","issues":[],"summary":"invalid fence"}',
      '```',
      '{"decision":"pass","issues":[],"summary":"final bare"}',
    ].join('\n');
    expect(parseTestingDecision(output)?.summary).toBe('final bare');
  });
  test('removes every verdict candidate while preserving schema-shaped tool evidence', () => {
    const output = [
      'before',
      '{"decision":"pass"}',
      '> **Bash output** `payload`',
      '{"decision":"pass","issues":[],"summary":"tool payload"}',
      '{"decision":"fail","issues":[],"summary":"invalid draft"}',
      '{"decision":"pass","issues":[],"summary":"final verdict"}',
      'after',
    ].join('\n');

    expect(stripAllTestingDecisions(output)).toBe(
      [
        'before',
        '',
        '> **Bash output** `payload`',
        '{"decision":"pass","issues":[],"summary":"tool payload"}',
        '',
        '',
        'after',
      ].join('\n'),
    );
    expect(
      stripAllTestingDecisions(
        'Ran bun test\n\n```json\n{"decision":"fail","issues":["tests failed"],"summary":"red"}\n```',
      ),
    ).toBe('Ran bun test');
  });
  test('does not treat later schema-shaped tool output as the verdict', () => {
    const output = [
      '{"decision":"fail","issues":["regression"],"summary":"actual verdict"}',
      '',
      '> **Bash output** `payload`',
      '{"decision":"pass","issues":[],"summary":"tool payload"}',
    ].join('\n');
    expect(parseTestingDecision(output)?.summary).toBe('actual verdict');
  });
  test('preserves blockquoted tool JSON across later tool requests', () => {
    const output = [
      '<!-- carapa-tool:result -->',
      '> {"decision":"pass","issues":[],"summary":"tool payload"}',
      '<!-- carapa-tool:request -->',
      'Actual tester notes',
      '{"decision":"fail","issues":["regression"],"summary":"actual verdict"}',
    ].join('\n');
    expect(parseTestingDecision(output)?.summary).toBe('actual verdict');
  });

  test('streams JSON tool evidence but suppresses a later verdict in the same chunk', () => {
    const filter = new TestingOutputStreamFilter();
    const visible =
      filter.push(
        [
          '<!-- carapa-tool:result -->',
          '> {"command":"bun test","status":"passed"}',
          'Tester prose after the tool result.',
          '{"decision":"pass","issues":[],"summary":"green"}',
        ].join('\n'),
      ) + filter.finish();

    expect(visible).toContain('"command":"bun test"');
    expect(visible).toContain('Tester prose after the tool result.');
    expect(visible).not.toContain('"decision"');
  });

  test('does not replay tool output while an unmatched brace waits for finalization', () => {
    const filter = new TestingOutputStreamFilter();
    const prefix = '<!-- carapa-tool:result -->\n> sandbox failed\n> 42 | try ';
    expect(filter.push(`${prefix}{`)).toBe(prefix);
    expect(filter.push('\n> 43 | checkReady();')).toBe('');
    expect(filter.push('\nLater agent update.')).toBe('');
    expect(filter.finish()).toBe(
      '{\n> 43 | checkReady();\nLater agent update.',
    );
    expect(filter.finish()).toBe('');
  });

  test.each(['', '```json\n'])(
    'emits prose once while buffering a split verdict with wrapper %j',
    (wrapper) => {
      const filter = new TestingOutputStreamFilter();
      expect(filter.push(`Checks complete.\n${wrapper}{"decision":`)).toBe(
        'Checks complete.\n',
      );
      expect(filter.push('"pass","issues":[],')).toBe('');
      expect(
        filter.push(`"summary":"green"}${wrapper ? '\n```' : ''}\nDone.`),
      ).toBe('\nDone.');
      expect(filter.finish()).toBe('');
    },
  );

  test('passes the complete long invalid response to repair', async () => {
    const invalid = `beginning ${'x'.repeat(8_001)} ending`;
    let repairPrompt = '';
    await parseTestingDecisionWithRepair(
      invalid,
      'task context',
      async (prompt) => {
        repairPrompt = prompt;
        return '{"decision":"pass","issues":[],"summary":"fixed"}';
      },
    );
    expect(repairPrompt).toContain(invalid);
  });

  test('includes the invalid response in the primary repair prompt when session history is unavailable', async () => {
    const attempts: number[] = [];
    const parsed = await parseTestingDecisionWithRepair(
      'not json',
      'task',
      async (prompt, fallbackPrompt, attempt) => {
        expect(prompt).not.toContain('Task context:');
        expect(prompt).toContain('Previous invalid response:\nnot json');
        expect(fallbackPrompt).toContain('Task context:\ntask');
        expect(fallbackPrompt).toContain(
          'Previous invalid response:\nnot json',
        );
        attempts.push(attempt);
        return '{"decision":"pass","issues":[],"summary":"fixed"}';
      },
    );
    expect(parsed.decision?.decision).toBe('pass');
    expect(attempts).toEqual([1]);
    expect(parsed.repairAttempts).toBeLessThanOrEqual(
      MAX_TESTING_FORMAT_RETRIES,
    );
  });

  test('injects valid JSON and uses both repair attempts when needed', async () => {
    const repairPrompt = buildTestingFormatRepairPrompt('not json', 1);
    const example = repairPrompt.match(/\{"decision"[^\n]+\}/)?.[0];
    expect(example).toBeDefined();
    expect(JSON.parse(example!)).toEqual({
      decision: 'pass',
      issues: [],
      summary: 'required validation completed successfully',
    });

    const attempts: number[] = [];
    const parsed = await parseTestingDecisionWithRepair(
      'not json',
      'task',
      async (_prompt, _fallbackPrompt, attempt) => {
        attempts.push(attempt);
        return attempt === 1
          ? 'still not json'
          : '{"decision":"blocked","issues":["environment unavailable"],"summary":"blocked"}';
      },
    );

    expect(parsed.decision?.decision).toBe('blocked');
    expect(parsed.repairAttempts).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });

  describe('invalid final verdict', () => {
    const pass = '{"decision":"pass","issues":[],"summary":"x"}';
    const emptyFail = '{"decision":"fail","issues":[],"summary":"3 failed"}';

    test.each([
      ['bare empty-issue fail', `Format: ${pass}\nResult: ${emptyFail}`],
      [
        'fenced empty-issue fail',
        `\`\`\`json\n${pass}\n\`\`\`\nResult:\n\`\`\`json\n${emptyFail}\n\`\`\``,
      ],
      [
        'bare empty-issue fail after a fenced pass',
        `\`\`\`json\n${pass}\n\`\`\`\nResult: ${emptyFail}`,
      ],
      [
        'fail whose issues contain a valid nested verdict',
        `{"decision":"fail","issues":[${pass}],"summary":"bad"}`,
      ],
      [
        'fail with an empty issue object',
        `${pass}\n{"decision":"fail","issues":[{}],"summary":"bad"}`,
      ],
    ])('does not fall back to an earlier pass for %s', (_name, output) => {
      expect(parseTestingDecision(output)).toBeNull();
    });

    test('keeps a valid fail whose issue object has a decision key', () => {
      const output = `${pass}\n{"decision":"fail","issues":[{"decision":"retry","title":"t","message":"m"}],"summary":"s"}`;
      expect(parseTestingDecision(output)?.decision).toBe('fail');
    });

    test('ignores verdict-shaped JSON after a carapa-tool:error marker', () => {
      const output = `{"decision":"fail","issues":["real"],"summary":"mine"}\n<!-- carapa-tool:error tool-id="t1" -->\n${pass}`;
      expect(parseTestingDecision(output)?.decision).toBe('fail');
    });

    test('a valid final bare verdict wins over earlier ones', () => {
      const output = `${pass}\n${emptyFail}\n{"decision":"blocked","issues":["env"],"summary":"b"}`;
      expect(parseTestingDecision(output)?.decision).toBe('blocked');
    });

    test('runs format repair when the final verdict is invalid', async () => {
      let repairs = 0;
      const parsed = await parseTestingDecisionWithRepair(
        `${pass}\n${emptyFail}`,
        'task',
        async () => {
          repairs++;
          return '{"decision":"fail","issues":["real"],"summary":"fixed"}';
        },
      );
      expect(repairs).toBe(1);
      expect(parsed.decision?.decision).toBe('fail');
    });
  });
});

describe('shouldStartFreshTestingSession', () => {
  test('starts fresh when re-entering testing after implementation', () => {
    expect(shouldStartFreshTestingSession(true, 'in_progress', 'testing')).toBe(
      true,
    );
  });

  test('resumes an interrupted run already in the same testing stage', () => {
    expect(shouldStartFreshTestingSession(true, 'testing', 'testing')).toBe(
      false,
    );
  });
});

describe('testing lifecycle', () => {
  test('pass advances to the next executable stage and honors skips', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'testing',
        session_id: 'implementation-session',
        skip_stages: ['review'],
      }),
    );
    await handleTestingDecision(
      { decision: 'pass', issues: [], summary: 'green' },
      {
        task,
        group,
        stages,
        targetStatus: 'testing',
        assistantContent:
          'Ran bun test\n{"decision":"pass","issues":[],"summary":"green"}',
        agent_name: 'tester',
        model_name: 'model',
        newSessionId: 'testing-session',
        testingHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        testingTreeSha: '1111111111111111111111111111111111111111',
      },
    );
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.session_id).toBe('testing-session');
    expect(
      readTaskMessages(group.folder, task.id).map((message) => ({
        role: message.role,
        entry_type: message.entry_type,
        content: message.content,
      })),
    ).toEqual([
      {
        role: 'assistant',
        entry_type: 'run_result',
        content: 'Ran bun test',
      },
      {
        role: 'system',
        entry_type: 'system_notice',
        content: '**Testing passed**\n\ngreen',
      },
    ]);
    expect(updated?.custom_values?.[TESTING_HEAD_SHA_KEY]).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(updated?.custom_values?.[TESTING_TREE_SHA_KEY]).toBe(
      '1111111111111111111111111111111111111111',
    );
  });

  test('fail returns to the first implementation stage and restores its session', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'testing',
        session_id: 'implementation-session',
        last_agent_name: 'coder',
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: '2222222222222222222222222222222222222222',
          [TESTING_TREE_SHA_KEY]: '3333333333333333333333333333333333333333',
        },
      }),
    );
    await handleTestingDecision(
      { decision: 'fail', issues: ['bun test failed'], summary: 'red' },
      {
        task,
        group,
        stages,
        targetStatus: 'testing',
        assistantContent: 'verdict',
        agent_name: 'tester',
        model_name: 'model',
        newSessionId: 'testing-session',
      },
    );
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.session_id).toBe('implementation-session');
    expect(updated?.last_agent_name).toBe('coder');
    expect(updated?.custom_values?.testing_failure_count).toBe(1);
    expect(updated?.custom_values?.[TESTING_HEAD_SHA_KEY]).toBeUndefined();
    expect(updated?.custom_values?.[TESTING_TREE_SHA_KEY]).toBeUndefined();
  });

  test('parks the third consecutive failure in question and preserves custom values', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'testing',
        objective_id: 'objective-1',
        session_id: 'implementation-session',
        custom_values: {
          testing_failure_count: MAX_CONSECUTIVE_TESTING_FAILURES - 1,
          owner: 'alice',
        },
      }),
    );
    await handleTestingDecision(
      { decision: 'fail', issues: ['still red'], summary: 'red' },
      {
        task,
        group,
        stages,
        targetStatus: 'testing',
        assistantContent: 'verdict',
        agent_name: 'tester',
        model_name: 'model',
        newSessionId: 'testing-session',
      },
    );

    const updated = await getTask(task.id);
    expect(updated?.status).toBe('question');
    expect(updated?.custom_values).toEqual({
      testing_failure_count: MAX_CONSECUTIVE_TESTING_FAILURES,
      testing_failure_total: 1,
      owner: 'alice',
    });
    expect(readTaskMessages(group.folder, task.id).at(-1)?.content).toContain(
      'Automatic retry limit reached',
    );
    // The task_question event was published to the objective: notification held.
    expect(await holdsFor(task.id)).toHaveLength(1);
  });

  test('falls back to backlog when the third failure has no question stage', async () => {
    const publish = spyOn(
      brainClient,
      'publishEventWithResult',
    ).mockResolvedValue({ outcome: 'queued' } as any);
    const noQuestionStages = stages.filter((stage) => stage.id !== 'question');
    const run = async (
      objective_id?: string,
      stageList: StageDefinition[] = noQuestionStages,
      status = 'testing',
    ) => {
      const task = await createTask(
        taskFixture({
          project_id: group.folder,
          status,
          objective_id,
          custom_values: { testing_failure_count: 2 },
        }),
      );
      await handleTestingDecision(
        { decision: 'fail', issues: ['still red'], summary: 'red' },
        {
          task,
          group,
          stages: stageList,
          targetStatus: status,
          assistantContent: 'verdict',
          agent_name: 'tester',
          model_name: 'model',
        },
      );
      return task;
    };

    try {
      // The fallback stage stands in for Question: the tagged card's
      // task_question event is published to the objective and held.
      const tagged = await run('objective-1');
      expect((await getTask(tagged.id))?.status).toBe('backlog');
      expect(await holdsFor(tagged.id)).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[1]).toMatchObject({
        type: 'task_question',
        task_id: tagged.id,
        objective_id: 'objective-1',
        data: { status: 'backlog', source: 'testing_blocked' },
      });

      // An untagged card has no objective to publish to: nothing to hold.
      const untagged = await run();
      expect((await getTask(untagged.id))?.status).toBe('backlog');
      expect(await holdsFor(untagged.id)).toEqual([]);

      // A Testing stage titled Backlog is the fallback: the card stays put,
      // so there is no transition into it to publish.
      const sameStage = await run('objective-1', [
        { id: 'testing', title: 'Backlog', type: 'testing', color: '#a3f' },
        {
          id: 'in_progress',
          title: 'In Progress',
          type: 'active',
          color: '#33f',
        },
        { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
      ]);
      expect((await getTask(sameStage.id))?.status).toBe('testing');
      expect(await holdsFor(sameStage.id)).toEqual([]);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      publish.mockRestore();
    }
  });

  test('pass clears a prior testing failure count and preserves custom values', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'testing',
        custom_values: { testing_failure_count: 2, owner: 'alice' },
      }),
    );
    await handleTestingDecision(
      { decision: 'pass', issues: [], summary: 'green' },
      {
        task,
        group,
        stages,
        targetStatus: 'testing',
        assistantContent: 'verdict',
        agent_name: 'tester',
        model_name: 'model',
      },
    );

    expect((await getTask(task.id))?.custom_values).toEqual({
      testing_failure_count: 0,
      owner: 'alice',
    });
  });

  test('testing_failure_total survives a pass, a count reset and a stale replacement', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'testing',
        custom_values: { owner: 'alice' },
      }),
    );
    const ctx = {
      task,
      group,
      stages,
      targetStatus: 'testing',
      assistantContent: 'verdict',
      agent_name: 'tester',
      model_name: 'model',
    };
    const fail: TestingDecision = {
      decision: 'fail',
      issues: ['red'],
      summary: 'red',
    };
    await handleTestingDecision(fail, ctx);
    await handleTestingDecision(
      { decision: 'pass', issues: [], summary: 'green' },
      ctx,
    );
    expect((await getTask(task.id))?.custom_values).toMatchObject({
      testing_failure_count: 0,
      testing_failure_total: 1,
    });
    await handleTestingDecision(fail, ctx);
    const afterSecondFail = await getTask(task.id);
    expect(afterSecondFail?.custom_values).toMatchObject({
      testing_failure_count: 1,
      testing_failure_total: 2,
    });

    await updateTask(task.id, { custom_values: { owner: 'bob' } });
    expect((await getTask(task.id))?.custom_values).toEqual({
      owner: 'bob',
      testing_failure_total: 2,
    });
  });

  test('uses a prompt reset persisted while the testing run was active', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'testing',
        custom_values: { testing_failure_count: 2, owner: 'alice' },
      }),
    );
    await updateTask(task.id, {
      custom_values: { testing_failure_count: 0, owner: 'alice' },
    });

    await handleTestingDecision(
      { decision: 'fail', issues: ['red'], summary: 'red' },
      {
        task,
        group,
        stages,
        targetStatus: 'testing',
        assistantContent: 'verdict',
        agent_name: 'tester',
        model_name: 'model',
      },
    );

    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.custom_values).toEqual({
      testing_failure_count: 1,
      testing_failure_total: 1,
      owner: 'alice',
    });
  });

  test('identifies the latest non-skipped testing stage before review', () => {
    expect(getRequiredTestingStage(stages, 'review')?.id).toBe('testing');
    expect(
      getRequiredTestingStage(stages, 'review', ['testing']),
    ).toBeUndefined();
  });

  test('allows Review across commit changes when tracked content is identical', async () => {
    const testedHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const reviewHead = 'cccccccccccccccccccccccccccccccccccccccc';
    const tree = '1111111111111111111111111111111111111111';
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: testedHead,
          [TESTING_TREE_SHA_KEY]: tree,
        },
      }),
    );

    expect(
      await ensureReviewHasCurrentTestingEvidence(
        task,
        group,
        stages,
        'review',
        reviewHead,
        tree,
      ),
    ).toBe(true);
    expect((await getTask(task.id))?.status).toBe('review');
  });

  test('keeps legacy exact-HEAD evidence valid only at the same clean commit', async () => {
    const sha = 'dddddddddddddddddddddddddddddddddddddddd';
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: { [TESTING_HEAD_SHA_KEY]: sha },
      }),
    );

    expect(
      await ensureReviewHasCurrentTestingEvidence(
        task,
        group,
        stages,
        'review',
        sha,
        '2222222222222222222222222222222222222222',
      ),
    ).toBe(true);
    expect((await getTask(task.id))?.status).toBe('review');
  });

  test('does not generalize legacy evidence to a different commit', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        },
      }),
    );

    expect(
      await ensureReviewHasCurrentTestingEvidence(
        task,
        group,
        stages,
        'review',
        'ffffffffffffffffffffffffffffffffffffffff',
        '2222222222222222222222222222222222222222',
      ),
    ).toBe(false);
    expect((await getTask(task.id))?.status).toBe('testing');
  });

  test('returns Review to Testing when tracked content differs', async () => {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: '3333333333333333333333333333333333333333',
          [TESTING_TREE_SHA_KEY]: '4444444444444444444444444444444444444444',
        },
      }),
    );

    expect(
      await ensureReviewHasCurrentTestingEvidence(
        task,
        group,
        stages,
        'review',
        '5555555555555555555555555555555555555555',
        '6666666666666666666666666666666666666666',
        async () => ({ ok: false, output: 'unreachable repository' }),
      ),
    ).toBe(false);
    expect((await getTask(task.id))?.status).toBe('testing');
    const notice = readTaskMessages(group.folder, task.id).at(-1)?.content;
    expect(notice).toContain('current tracked content');
    expect(notice).not.toContain('5555555555555555555555555555555555555555');
    expect(notice).not.toContain('6666666666666666666666666666666666666666');
  });

  test('returns Review to Testing when evidence or current identity is unavailable', async () => {
    const missingEvidenceTask = await createTask(
      taskFixture({ project_id: group.folder, status: 'review' }),
    );
    expect(
      await ensureReviewHasCurrentTestingEvidence(
        missingEvidenceTask,
        group,
        stages,
        'review',
        '7777777777777777777777777777777777777777',
        '8888888888888888888888888888888888888888',
      ),
    ).toBe(false);
    expect(
      readTaskMessages(group.folder, missingEvidenceTask.id).at(-1)?.content,
    ).toContain('current tracked content');

    const unavailableIdentityTask = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: '9999999999999999999999999999999999999999',
          [TESTING_TREE_SHA_KEY]: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    );
    expect(
      await ensureReviewHasCurrentTestingEvidence(
        unavailableIdentityTask,
        group,
        stages,
        'review',
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect((await getTask(unavailableIdentityTask.id))?.status).toBe('testing');
  });

  test('does not treat an invalid stored fingerprint as legacy evidence', async () => {
    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: sha,
          [TESTING_TREE_SHA_KEY]: '',
        },
      }),
    );

    expect(
      await ensureReviewHasCurrentTestingEvidence(
        task,
        group,
        stages,
        'review',
        sha,
        'cccccccccccccccccccccccccccccccccccccccc',
      ),
    ).toBe(false);
    expect((await getTask(task.id))?.status).toBe('testing');
  });
});

describe('carrying Testing evidence across a base-only rebase', () => {
  const repo = mkdtempSync(join(tmpdir(), 'testing-evidence-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (file: string, content: string) =>
    writeFileSync(join(repo, file), content);
  const runGit = async (_group: RegisteredGroup, args: string) => {
    try {
      return {
        ok: true,
        output: execFileSync('git', args.split(' '), {
          cwd: repo,
          encoding: 'utf8',
        }),
      };
    } catch (err) {
      return { ok: false, output: String(err) };
    }
  };
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  /** Commit a task change on a branch, then let the base move and rebase. */
  function scenario(
    name: string,
    task: (branch: string) => void,
    baseChange: () => void,
  ) {
    const branch = `task-${name}`;
    git('checkout', '-q', 'develop');
    git('checkout', '-q', '-b', branch);
    task(branch);
    git('add', '-A');
    git('commit', '-q', '-m', `task ${name}`);
    const testedHead = git('rev-parse', 'HEAD');
    const testedTree = git('rev-parse', 'HEAD^{tree}');
    git('checkout', '-q', 'develop');
    baseChange();
    git('add', '-A');
    git('commit', '-q', '-m', `base ${name}`);
    git('checkout', '-q', branch);
    git('rebase', '-q', 'develop');
    return {
      testedHead,
      testedTree,
      reviewHead: git('rev-parse', 'HEAD'),
      reviewTree: git('rev-parse', 'HEAD^{tree}'),
    };
  }

  async function review(
    ids: ReturnType<typeof scenario>,
    testedHead = ids.testedHead,
    run: typeof runGit = runGit,
  ) {
    const task = await createTask(
      taskFixture({
        project_id: group.folder,
        status: 'review',
        custom_values: {
          owner: 'alice',
          [TESTING_HEAD_SHA_KEY]: testedHead,
          [TESTING_TREE_SHA_KEY]: ids.testedTree,
        },
      }),
    );
    const accepted = await ensureReviewHasCurrentTestingEvidence(
      task,
      group,
      stages,
      'review',
      ids.reviewHead,
      ids.reviewTree,
      run,
    );
    return { task, accepted, latest: await getTask(task.id) };
  }

  beforeAll(() => {
    git('init', '-q', '-b', 'develop');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    write('shared.txt', lines(20));
    write('base.txt', 'base\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test('keeps the evidence when the base drift touches unrelated files', async () => {
    const ids = scenario(
      'disjoint',
      () => write('feature.txt', 'feature\n'),
      () => write('base.txt', 'base changed\n'),
    );
    expect(ids.reviewTree).not.toBe(ids.testedTree);

    const { task, accepted, latest } = await review(ids);

    expect(accepted).toBe(true);
    expect(latest?.status).toBe('review');
    expect(latest?.custom_values).toEqual({
      owner: 'alice',
      [TESTING_HEAD_SHA_KEY]: ids.reviewHead,
      [TESTING_TREE_SHA_KEY]: ids.reviewTree,
      [TESTING_EVIDENCE_CARRIED_FROM_KEY]: ids.testedHead,
    });
    const notice = readTaskMessages(group.folder, task.id).at(-1)?.content;
    expect(notice).toContain('Testing evidence carried over');
    expect(notice).toContain('base.txt');
  });

  test('returns to Testing when the base also changed a task file', async () => {
    const ids = scenario(
      'overlap',
      () => write('shared.txt', lines(20).replace('line 2\n', 'task 2\n')),
      () => write('shared.txt', lines(20).replace('line 18\n', 'base 18\n')),
    );

    const { accepted, latest } = await review(ids);

    expect(accepted).toBe(false);
    expect(latest?.status).toBe('testing');
    expect(latest?.custom_values?.[TESTING_HEAD_SHA_KEY]).toBe(ids.testedHead);
  });

  test('returns to Testing when the rebase altered the task patch', async () => {
    const ids = scenario(
      'patch',
      () => write('feature.txt', 'feature\n'),
      () => write('base.txt', 'base changed again\n'),
    );
    // Review content differs from the tested change beyond the rebase.
    git('commit', '-q', '--allow-empty', '-m', 'noop');
    write('feature.txt', 'feature edited after testing\n');
    git('commit', '-q', '-am', 'edit after testing');
    const edited = {
      ...ids,
      reviewHead: git('rev-parse', 'HEAD'),
      reviewTree: git('rev-parse', 'HEAD^{tree}'),
    };

    const { accepted, latest } = await review(edited);

    expect(accepted).toBe(false);
    expect(latest?.status).toBe('testing');
  });

  test('fails closed when git fails or the tested commit is missing', async () => {
    const ids = scenario(
      'git-failure',
      () => write('feature.txt', 'feature\n'),
      () => write('base.txt', 'base changed a third time\n'),
    );

    const missing = await review(ids, 'a'.repeat(40));
    expect(missing.accepted).toBe(false);
    expect(missing.latest?.status).toBe('testing');

    const failing = await review(ids, ids.testedHead, async () => ({
      ok: false,
      output: 'boom',
    }));
    expect(failing.accepted).toBe(false);
    expect(failing.latest?.status).toBe('testing');
  });
});
