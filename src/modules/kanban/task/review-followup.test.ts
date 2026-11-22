import { describe, test, expect, beforeEach, beforeAll } from 'bun:test';
import type { ReviewDependencies } from './review.js';

const broadcastCalls: any[] = [];
const appendedMessages: any[] = [];
const lifecycleNotifications: any[] = [];
const reviewDependencies: ReviewDependencies = {
  appendTaskMessage: (_projectId, message) => {
    const saved = { id: `msg-${appendedMessages.length + 1}`, ...message };
    appendedMessages.push(saved);
    return saved;
  },
  broadcast: (event) => broadcastCalls.push(event),
  mergeTaskBranchWithResolution: async () => ({ mergeOk: true, output: '' }),
  publishEvent: async () => {},
  resolveBrainUrl: () => 'http://brain:1234',
  resolveBrainContainer: () => 'brain',
  triggerDeploy: async () => true,
  notifyEntityLifecycle: async (args) => {
    lifecycleNotifications.push(args);
  },
};

import { handleReviewDecision } from './review.js';
const { initDatabase, createTask, getTask, getTasksByProject, updateTask } =
  await import('../../../db.js');
const { truncateTestDb, taskFixture } =
  await import('../../../test-helpers.js');
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../../db/drizzle-client.js';
import { projects, stageEntryEvents } from '../../../db/schema.js';
import type { ReviewDecision } from '../review.js';
import type { StageDefinition } from '../types.js';

const PROJ = 'review-rework-test-project';
const REVIEW_STAGES = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
  { id: 'in_progress', title: 'In Progress', type: 'active', color: '#888' },
  { id: 'review', title: 'Review', type: 'review', color: '#888' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#888' },
] as StageDefinition[];
const REVIEW_STAGES_WITH_TESTING = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
  { id: 'in_progress', title: 'In Progress', type: 'active', color: '#888' },
  { id: 'testing', title: 'Testing', type: 'active', color: '#888' },
  { id: 'review', title: 'Review', type: 'review', color: '#888' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#888' },
] as StageDefinition[];
let initialized = false;
beforeAll(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
});
beforeEach(async () => {
  await truncateTestDb();
  broadcastCalls.length = 0;
  appendedMessages.length = 0;
  lifecycleNotifications.length = 0;
});

function group(): any {
  return {
    name: 'Review test',
    folder: PROJ,
    trigger: '!test',
    added_at: new Date().toISOString(),
    settings: { enabledModes: ['kanban'], stages: REVIEW_STAGES },
  };
}

async function original() {
  return createTask(
    taskFixture({
      project_id: PROJ,
      title: 'Add settings page',
      description: 'Build the settings UI',
      status: 'review',
    }),
  );
}

function decision(issues: ReviewDecision['issues'] = []): ReviewDecision {
  return {
    decision: 'approve',
    score: 9,
    issues,
    summary: 'Looks good',
  };
}

const context = (task: any) => ({
  task,
  group: group(),
  stages: REVIEW_STAGES,
  targetStatus: 'review',
  completionStageId: 'completed',
  assistantContent: 'Approved',
  agent_name: 'reviewer',
  model_name: null,
});

describe('accepted reviews', () => {
  test('review approval preserves its run identity when entering deploy', async () => {
    const task = await original();
    const deployCalls: any[] = [];
    const deployGroup = group();
    deployGroup.settings.deployService = 'carapa-board';
    deployGroup.settings.deployStage = 'deploy';
    deployGroup.settings.stages = [
      ...REVIEW_STAGES,
      { id: 'deploy', title: 'Deploy', type: 'done', color: '#0a0' },
    ];

    await handleReviewDecision(
      decision(),
      {
        ...context(task),
        group: deployGroup,
        stages: deployGroup.settings.stages,
        completionStageId: 'deploy',
        runId: 'immutable-review-run',
      },
      {
        ...reviewDependencies,
        triggerDeploy: async (...args) => {
          deployCalls.push(args);
          return true;
        },
      },
    );

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.[2]).toEqual({
      skipMerge: true,
      lifecycleRunId: 'immutable-review-run',
    });
  });

  test('accepted-with-nits reopens the same task in progress without creating a backlog task', async () => {
    const task = await original();
    await handleReviewDecision(
      decision([
        { title: 'Fix typo', description: 'Line 5' },
        { title: 'Add test', description: 'Cover the edge case' },
      ]),
      context(task),
      reviewDependencies,
    );

    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.description).toContain('Build the settings UI');
    expect(updated?.description).toContain('## Review notes');
    expect(updated?.description).toContain('- [ ] **Fix typo** — Line 5');
    expect(updated?.description).toContain(
      '- [ ] **Add test** — Cover the edge case',
    );
    expect(await getTasksByProject(PROJ)).toHaveLength(1);
    expect(broadcastCalls.some((e) => e.type === 'task_created')).toBe(false);
    expect(appendedMessages.at(-1)?.content).toContain(
      '**Review accepted with nits**',
    );
  });

  test('nit_round_count increments per accepted-with-nits review and survives clean approval', async () => {
    const task = await original();
    const nit = decision([{ title: 'Nit', description: 'Polish it' }]);

    await handleReviewDecision(nit, context(task), reviewDependencies);
    expect((await getTask(task.id))?.custom_values?.nit_round_count).toBe(1);

    await updateTask(task.id, { status: 'review' });
    await handleReviewDecision(
      nit,
      context((await getTask(task.id))!),
      reviewDependencies,
    );
    expect((await getTask(task.id))?.custom_values?.nit_round_count).toBe(2);

    await updateTask(task.id, { status: 'review' });
    await handleReviewDecision(
      decision(),
      context((await getTask(task.id))!),
      reviewDependencies,
    );
    const approved = await getTask(task.id);
    expect(approved?.status).toBe('completed');
    expect(approved?.custom_values?.nit_round_count).toBe(2);
  });

  test('nit polish passes are capped at two; later nit approvals merge with notes', async () => {
    const nit = decision([{ title: 'Nit', description: 'Polish it' }]);
    const mergeCalls: any[] = [];
    const deps = {
      ...reviewDependencies,
      mergeTaskBranchWithResolution: async (...args: any[]) => {
        mergeCalls.push(args);
        return { mergeOk: true, output: '' };
      },
    } as ReviewDependencies;
    const makeTask = (custom_values?: Record<string, string | number>) =>
      createTask(
        taskFixture({
          project_id: PROJ,
          title: 'Cap test',
          description: 'Do work',
          status: 'review',
          custom_values,
        }),
      );

    // Missing count behaves like 0, count 1 reopens too.
    for (const [custom, expected] of [
      [undefined, 1],
      [{ nit_round_count: 1 }, 2],
    ] as const) {
      const task = await makeTask(custom);
      await handleReviewDecision(nit, context(task), deps);
      const reopened = await getTask(task.id);
      expect(reopened?.status).toBe('in_progress');
      expect(reopened?.custom_values?.nit_round_count).toBe(expected);
    }
    expect(mergeCalls).toHaveLength(0);

    // At the cap the card merges, keeps the nits as notes, count unchanged.
    const capped = await makeTask({ nit_round_count: 2 });
    await handleReviewDecision(nit, context(capped), deps);
    const merged = await getTask(capped.id);
    expect(mergeCalls).toHaveLength(1);
    expect(merged?.status).toBe('completed');
    expect(merged?.custom_values?.nit_round_count).toBe(2);
    expect(merged?.description).toContain(
      'Verdict: accepted with nits (polish cap reached)',
    );
    expect(merged?.description).toContain('- [ ] **Nit** — Polish it');

    // An unchanged head after an earlier nit review merges below the cap too,
    // but a new head, a first nit review, or a missing head still reopens.
    const reviewed = (task: any, head?: string) => ({
      ...context(task),
      review_head_sha: head,
    });
    const same = await makeTask({
      nit_round_count: 1,
      last_review_head: 'head-a',
    });
    await handleReviewDecision(nit, reviewed(same, 'head-a'), deps);
    const sameDone = await getTask(same.id);
    expect(mergeCalls).toHaveLength(2);
    expect(sameDone?.status).toBe('completed');
    expect(sameDone?.custom_values?.nit_round_count).toBe(1);
    expect(sameDone?.description).toContain(
      'Verdict: accepted with nits (polish cap reached)',
    );

    for (const [custom, head] of [
      [{ nit_round_count: 1, last_review_head: 'head-a' }, 'head-b'],
      [{ last_review_head: 'head-a' }, 'head-a'],
      [{ nit_round_count: 1, last_review_head: 'head-a' }, undefined],
    ] as const) {
      const task = await makeTask(custom);
      await handleReviewDecision(nit, reviewed(task, head), deps);
      expect((await getTask(task.id))?.status).toBe('in_progress');
    }
    expect(mergeCalls).toHaveLength(2);
  });

  test('accepted-with-nits falls back to an active stage, never backlog', async () => {
    const stages = [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      { id: 'review', title: 'Review', type: 'review', color: '#888' },
      {
        id: 'in_progress',
        title: 'In Progress',
        type: 'active',
        color: '#888',
      },
      { id: 'completed', title: 'Completed', type: 'done', color: '#888' },
    ] as StageDefinition[];
    const task = await original();
    await handleReviewDecision(
      decision([{ title: 'Nit', description: 'Polish it' }]),
      { ...context(task), stages },
      reviewDependencies,
    );

    expect((await getTask(task.id))?.status).toBe('in_progress');
    expect(await getTasksByProject(PROJ)).toHaveLength(1);
  });
});

describe('other review verdicts', () => {
  test('allows rejection counts above five when comparison reports progress', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        title: 'Progressing task',
        description: 'Do work',
        status: 'review',
        custom_values: { rejection_count: 5, no_progress_count: 0 },
      }),
    );
    await handleReviewDecision(
      {
        ...decision(),
        decision: 'reject',
        issues: [{ title: 'Fix new issue', description: 'New issue remains' }],
      },
      {
        ...context(task),
        rejection_comparison: {
          decision: 'retry',
          progress: 'new_issue',
          resolved_issue_ids: [],
          persistent_issue_ids: [],
          new_issue_ids: ['New issue'],
          reason: 'New issue found',
        },
      },
      reviewDependencies,
    );
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.custom_values?.rejection_count).toBe(6);
  });

  describe('hard rejection cap', () => {
    const progressing = {
      decision: 'retry' as const,
      progress: 'new_issue' as const,
      resolved_issue_ids: [],
      persistent_issue_ids: [],
      new_issue_ids: ['New issue'],
      reason: 'New issue found',
    };
    const reject = () => ({
      ...decision(),
      decision: 'reject' as const,
      issues: [{ title: 'Fix new issue', description: 'New issue remains' }],
    });

    test('pauses at the cap even when every comparison reports progress', async () => {
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          title: 'Endless task',
          description: 'Do work',
          status: 'review',
          objective_id: 'objective-1',
          custom_values: { rejection_count: 7, no_progress_count: 0 },
        }),
      );
      const events: any[] = [];
      await handleReviewDecision(
        reject(),
        { ...context(task), rejection_comparison: progressing },
        {
          ...reviewDependencies,
          publishEvent: async (_url, event) => {
            events.push(event);
          },
        },
      );
      const updated = await getTask(task.id);
      expect(updated?.status).toBe('backlog');
      expect(updated?.custom_values?.rejection_count).toBe(8);
      expect(
        appendedMessages.some((m) =>
          /rejection cap reached/i.test(String(m.content)),
        ),
      ).toBe(true);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'task_question',
          data: expect.objectContaining({
            reason: expect.stringMatching(/rejection cap reached/i),
          }),
        }),
      ]);
    });

    test('a no-progress pause parks in the runOnEntry question stage and starts recovery', async () => {
      const stages = [
        REVIEW_STAGES[0],
        {
          id: 'question',
          title: 'Question',
          type: 'queue',
          color: '#888',
          runOnEntry: true,
        },
        ...REVIEW_STAGES.slice(1),
      ] as StageDefinition[];
      await drizzleDbRef.current.insert(projects).values({
        id: PROJ,
        jid: `${PROJ}@board`,
        name: 'Review test',
        folder: PROJ,
        trigger: '!test',
        added_at: new Date().toISOString(),
        settings: JSON.stringify({ stages }),
      });
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          title: 'Stuck task',
          description: 'Do work',
          status: 'review',
          custom_values: { rejection_count: 1, no_progress_count: 1 },
          session_id: 'claude-session',
          last_agent_name: 'claude@carapa',
        }),
      );
      await handleReviewDecision(
        reject(),
        {
          ...context(task),
          stages,
          rejection_comparison: {
            decision: 'retry',
            progress: 'no_progress',
            resolved_issue_ids: [],
            persistent_issue_ids: ['Fix new issue'],
            new_issue_ids: [],
            reason: 'Same issue persists',
          },
        },
        reviewDependencies,
      );
      const parked = await getTask(task.id);
      expect(parked?.status).toBe('question');
      // The saved session belongs to the previous agent, not the reviewer;
      // recording the reviewer would make re-entry resume a foreign session.
      expect(parked?.session_id).toBe('claude-session');
      expect(parked?.last_agent_name).toBe('claude@carapa');
      const events = await drizzleDbRef.current
        .select()
        .from(stageEntryEvents)
        .where(eq(stageEntryEvents.task_id, task.id));
      expect(events.map((event) => event.stage_id)).toEqual(['question']);
    });

    test('keeps retrying below the cap', async () => {
      const task = await createTask(
        taskFixture({
          project_id: PROJ,
          title: 'Below cap',
          description: 'Do work',
          status: 'review',
          custom_values: { rejection_count: 6, no_progress_count: 0 },
        }),
      );
      await handleReviewDecision(
        reject(),
        { ...context(task), rejection_comparison: progressing },
        reviewDependencies,
      );
      const updated = await getTask(task.id);
      expect(updated?.status).toBe('in_progress');
      expect(updated?.custom_values?.rejection_count).toBe(7);
    });

    test('parseMaxReviewRejections falls back to 8 for invalid values', async () => {
      const { parseMaxReviewRejections } = await import('../../../config.js');
      expect(parseMaxReviewRejections(undefined)).toBe(8);
      expect(parseMaxReviewRejections('0')).toBe(8);
      expect(parseMaxReviewRejections('abc')).toBe(8);
      expect(parseMaxReviewRejections('12')).toBe(12);
    });
  });

  test('clean approval keeps the existing completion path', async () => {
    const task = await original();
    await handleReviewDecision(
      decision(),
      { ...context(task), runId: 'review-run' },
      reviewDependencies,
    );
    expect((await getTask(task.id))?.status).toBe('completed');
    expect(lifecycleNotifications).toEqual([
      expect.objectContaining({
        task_id: task.id,
        run_id: 'review-run',
        event: 'completed',
      }),
    ]);
  });

  test('review approval reuses the checkout lease held by the task pipeline', async () => {
    const task = await original();
    let mergeOptions: { leaseAlreadyHeld?: boolean } | undefined;

    await handleReviewDecision(
      decision(),
      { ...context(task), leaseAlreadyHeld: true },
      {
        ...reviewDependencies,
        mergeTaskBranchWithResolution: async (
          _task,
          _group,
          _source,
          _dependencies,
          options,
        ) => {
          mergeOptions = options;
          return { mergeOk: true, output: '' };
        },
      },
    );

    expect(mergeOptions).toEqual({ leaseAlreadyHeld: true });
    expect((await getTask(task.id))?.status).toBe('completed');
  });

  test('rejection does not create review notes or a followup card', async () => {
    const task = await original();
    await handleReviewDecision(
      {
        ...decision(),
        decision: 'reject',
        issues: [{ title: 'Fix the behavior', description: 'It needs work' }],
      },
      context(task),
      reviewDependencies,
    );
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.description).not.toContain('## Review notes');
    expect(await getTasksByProject(PROJ)).toHaveLength(1);
    expect(appendedMessages).toHaveLength(1);
    expect(appendedMessages[0].content).toContain('**Review rejected**');
    expect(appendedMessages[0].content).not.toContain('"decision"');
    expect(appendedMessages[0].content).toContain(
      'Fix the behavior — It needs work',
    );
    const history = JSON.parse(String(updated?.custom_values?.review_history));
    expect(history[0].issues).toEqual([
      {
        id: 'fix the behavior it needs work',
        text: 'Fix the behavior — It needs work',
      },
    ]);
    const updateEvent = broadcastCalls.find(
      (event) => event.type === 'task_updated',
    );
    expect(updateEvent?.payload.status).toBe('in_progress');
  });

  test('rejection restarts at implementation before testing and review', async () => {
    const task = await original();
    await handleReviewDecision(
      {
        ...decision(),
        decision: 'reject',
        issues: [
          {
            title: 'Fix implementation',
            description: 'The implementation is still incorrect',
          },
        ],
      },
      {
        ...context(task),
        stages: REVIEW_STAGES_WITH_TESTING,
        rejection_comparison: {
          decision: 'retry',
          progress: 'new_issue',
          resolved_issue_ids: [],
          persistent_issue_ids: [],
          new_issue_ids: ['Fix implementation'],
          reason: 'A new implementation issue was found',
        },
      },
      reviewDependencies,
    );

    expect((await getTask(task.id))?.status).toBe('in_progress');
  });

  test('approval stores the reviewer transcript followed by a readable summary', async () => {
    const task = await original();
    const json = JSON.stringify(decision());
    await handleReviewDecision(
      decision(),
      { ...context(task), assistantContent: json },
      reviewDependencies,
    );

    expect(appendedMessages).toHaveLength(2);
    expect(appendedMessages[0].role).toBe('assistant');
    expect(appendedMessages[0].content).toBe(json);
    expect(appendedMessages[1].role).toBe('assistant');
    expect(appendedMessages[1].content).toContain('**Review approved**');
    expect(appendedMessages[1].content).toContain('Looks good');
    expect(appendedMessages[1].content).not.toContain('"decision"');
  });

  test('review approval returns a real merge conflict to implementation with a stage prompt', async () => {
    const task = await original();
    let source = '';
    await handleReviewDecision(decision(), context(task), {
      ...reviewDependencies,
      mergeTaskBranchWithResolution: async (_task, _group, value) => {
        source = value;
        return {
          mergeOk: false,
          failureKind: 'conflict',
          output: 'complete merge output',
        };
      },
    });

    expect(source).toBe('review');
    expect((await getTask(task.id))?.status).toBe('in_progress');
    expect(appendedMessages.at(-1)?.content).toContain('complete merge output');
    expect(appendedMessages.at(-1)?.entry_type).toBe('stage_prompt');
    expect(appendedMessages.at(-1)?.target_stage).toBe('in_progress');
    expect(appendedMessages.at(-1)?.content).toContain('Merge `develop`');
  });

  test('merge conflict return keeps this review score, not a stale one', async () => {
    const task = await original();
    await updateTask(task.id, {
      custom_values: { quality_score: 3, last_review_head: 'stale-sha' },
    });
    await handleReviewDecision(
      decision(),
      { ...context(task), review_head_sha: 'fresh-sha' } as ReturnType<
        typeof context
      >,
      {
        ...reviewDependencies,
        mergeTaskBranchWithResolution: async () => ({
          mergeOk: false,
          failureKind: 'conflict',
          output: 'conflict output',
        }),
      },
    );

    const updated = await getTask(task.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.custom_values?.quality_score).toBe(9);
    expect(updated?.custom_values?.last_review_head).toBe('fresh-sha');
  });

  test('approved environmental merge failure parks outside review instead of launching another reviewer', async () => {
    const task = await original();
    await handleReviewDecision(decision(), context(task), {
      ...reviewDependencies,
      mergeTaskBranchWithResolution: async () => ({
        mergeOk: false,
        failureKind: 'environment',
        output: '[env] default checkout is dirty',
      }),
    });

    expect((await getTask(task.id))?.status).toBe('backlog');
    const notice = appendedMessages.find(
      (message) => message.role === 'system',
    );
    expect(notice?.content).toContain('Review approved, merge pending');
    expect(notice?.content).toContain('[env] default checkout is dirty');
    const updateEvent = broadcastCalls.find(
      (event) => event.type === 'task_updated',
    );
    expect(updateEvent?.payload.status).toBe('backlog');
  });
});
