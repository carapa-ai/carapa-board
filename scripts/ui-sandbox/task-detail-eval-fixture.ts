/**
 * Opt-in task details fixtures (`UI_SANDBOX_TASK_DETAIL_EVAL=1 npm run ui:sandbox`).
 *
 * One completed task in `ui-running` that exercises every part of the task
 * details dialog at once: a review score with a rejected round, testing
 * verdicts (blocked, failed, passed), eight runs across three stages, a merged
 * diff with several files (one long, one with a very long line), two browser
 * recordings, dependencies, artifact links and a long transcript with tool
 * calls. A second task has no runs, changes or recordings (empty states).
 * Kept out of the default seed so the other scenarios keep their small data.
 */
import fs from 'node:fs';
import path from 'node:path';

import { drizzleDbRef } from '../../src/db/drizzle-client.js';
import { activeRuns, tasks } from '../../src/db/schema.js';
import { GROUPS_DIR } from '../../src/config.js';
import {
  appendRunStartMarker,
  appendTaskMessage,
} from '../../src/modules/transcripts/transcript-store.js';
import { PROSE, TABLE, WIDE_CODE, toolRound } from './chat-eval-fixture.js';
import { MEDIA_FIXTURE_DIR, runFixtureGit } from './git-fixture.js';

export const TASK_DETAIL_EVAL = {
  project: 'ui-running',
  task: 'ui-task-detail-eval',
  emptyTask: 'ui-task-detail-eval-empty',
  branch: 'ui-task-detail-eval',
} as const;

const BASE = Date.parse('2026-11-03T08:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

const REPORT_LINK = '/workspace/group/artifacts/reports/task-detail-notes.md';
const SCREENSHOT_LINK = '/workspace/group/artifacts/images/column-header.png';

const longComponent = (): string =>
  [
    "import { memo } from 'react';",
    '',
    ...Array.from({ length: 110 }, (_, i) =>
      i % 11 === 0
        ? `export const Section${i} = memo(function Section${i}({ title }: { title: string }) {`
        : i % 11 === 10
          ? '});'
          : `  // step ${i}: keep the column header keyboard reachable and announce its state`,
    ),
    '',
  ].join('\n');

function seedDiff(repo: string): { base: string; sha: string } {
  const worktree = path.join(repo, '.worktrees', TASK_DETAIL_EVAL.branch);
  const base = runFixtureGit(repo, ['rev-parse', 'HEAD']).trim();
  runFixtureGit(repo, [
    'worktree',
    'add',
    '-qb',
    TASK_DETAIL_EVAL.branch,
    worktree,
  ]);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(worktree, file), content);
  };
  write('src/board/column-header.tsx', longComponent());
  write(
    'src/board/column-header.test.tsx',
    "import { describe, it, expect } from 'vitest';\n\ndescribe('column header', () => {\n  it('is reachable by keyboard', () => {\n    expect(true).toBe(true);\n  });\n});\n",
  );
  write(
    'src/board/empty-state.tsx',
    `export const EMPTY_COPY = '${'No tasks in this column yet. Drag a card here or press N to add one. '.repeat(8)}';\n`,
  );
  write(
    'docs/keyboard-navigation.md',
    `# Keyboard navigation\n\n${PROSE.join('\n\n')}\n`,
  );
  write(
    'tracked-dir/fixture.txt',
    'tracked fixture\nkeyboard navigation added\n',
  );
  runFixtureGit(worktree, ['add', '.']);
  runFixtureGit(worktree, [
    'commit',
    '-qm',
    'keyboard navigation for column headers',
  ]);
  const sha = runFixtureGit(worktree, ['rev-parse', 'HEAD']).trim();
  runFixtureGit(repo, ['worktree', 'remove', '--force', worktree]);
  return { base, sha };
}

function seedRecordings(): void {
  const dir = path.join(
    GROUPS_DIR,
    TASK_DETAIL_EVAL.project,
    'recordings',
    `task-${TASK_DETAIL_EVAL.task}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [
    '2026-11-03T09-14-02-checkout-flow.webm',
    '2026-11-03T09-31-40-keyboard-pass.webm',
  ]) {
    fs.copyFileSync(
      path.join(MEDIA_FIXTURE_DIR, 'fixture-video.WEBM'),
      path.join(dir, name),
    );
  }
}

const RUNS = [
  {
    id: 'code-1',
    stage: 'in_progress',
    agent: 'codex',
    model: 'gpt-5.5',
    status: 'completed',
    start: 0,
    minutes: 18,
    cost: 0.31,
  },
  {
    id: 'test-1',
    stage: 'testing',
    agent: 'claude',
    model: 'claude-sonnet-4.6',
    status: 'completed',
    start: 20,
    minutes: 4,
    cost: 0.06,
  },
  {
    id: 'test-2',
    stage: 'testing',
    agent: 'claude',
    model: 'claude-sonnet-4.6',
    status: 'completed',
    start: 26,
    minutes: 7,
    cost: 0.11,
  },
  {
    id: 'code-2',
    stage: 'in_progress',
    agent: 'codex',
    model: 'gpt-5.5',
    status: 'error',
    start: 36,
    minutes: 3,
    cost: 0.02,
  },
  {
    id: 'code-3',
    stage: 'in_progress',
    agent: 'codex',
    model: 'gpt-5.5',
    status: 'completed',
    start: 42,
    minutes: 12,
    cost: 0.22,
  },
  {
    id: 'test-3',
    stage: 'testing',
    agent: 'claude',
    model: 'claude-sonnet-4.6',
    status: 'completed',
    start: 56,
    minutes: 9,
    cost: 0.14,
  },
  {
    id: 'review-1',
    stage: 'review',
    agent: 'claude',
    model: 'claude-opus-4.8',
    status: 'completed',
    start: 68,
    minutes: 6,
    cost: 0.38,
    score: 5,
  },
  {
    id: 'code-4',
    stage: 'in_progress',
    agent: 'codex',
    model: 'gpt-5.5',
    status: 'completed',
    start: 78,
    minutes: 9,
    cost: 0.17,
  },
  {
    id: 'review-2',
    stage: 'review',
    agent: 'claude',
    model: 'claude-opus-4.8',
    status: 'completed',
    start: 90,
    minutes: 5,
    cost: 0.33,
    score: 8,
  },
] as const;

const runId = (id: string) => `ui-run-td-${id}`;

export async function seedTaskDetailEvalFixtures(opts: {
  adminId: string;
  gitRepo: string;
}): Promise<void> {
  const db = drizzleDbRef.current;
  const { project, task: taskId } = TASK_DETAIL_EVAL;
  const { base, sha } = seedDiff(opts.gitRepo);
  seedRecordings();

  const reviewHistory = [
    {
      timestamp: at(74),
      commit: '1a2b3c4d5e6f',
      summary:
        'Keyboard order is correct, but empty columns have no announcement and the focus ring is clipped.',
      issues: [
        {
          id: 'empty-announce',
          text: 'Empty columns are not announced to screen readers',
        },
        { id: 'focus-ring', text: 'Focus ring is clipped on the first column' },
      ],
    },
    {
      timestamp: at(95),
      commit: '6f5e4d3c2b1a',
      summary: 'Both issues are fixed.',
      issues: [],
    },
  ];

  await db.insert(tasks).values([
    {
      id: taskId,
      project_id: project,
      title: 'Keyboard navigation and empty states for board column headers',
      description: [
        'Make the board column headers reachable by keyboard and give empty columns a clear empty state.',
        '',
        '## Acceptance',
        '- Arrow keys move focus between column headers',
        '- An empty column shows a hint and announces itself',
        '- The focus ring is never clipped',
        '',
        `Design notes: [task-detail-notes.md](${REPORT_LINK})`,
      ].join('\n'),
      status: 'completed',
      priority: 0,
      created_at: at(-120),
      started_at: at(0),
      completed_at: at(95),
      archived: 0,
      merge_commit: sha,
      depends_on_ids: JSON.stringify(['ui-task-active', 'ui-task-backlog']),
      ownerUserId: opts.adminId,
      lastTriggeredByUserId: opts.adminId,
      lastTriggerSource: 'user',
      lastTriggeredAt: at(0),
      custom_values: JSON.stringify({
        quality_score: 8,
        rejection_count: 1,
        review_history: JSON.stringify(reviewHistory),
        task_diff_base_sha: base,
      }),
    },
    {
      id: TASK_DETAIL_EVAL.emptyTask,
      project_id: project,
      title: 'Empty task: no runs, changes or recordings',
      description: 'Used to check the empty states of every tab.',
      status: 'backlog',
      priority: 0,
      created_at: at(-60),
      archived: 0,
    },
  ] as never);

  const insertRun = async (run: (typeof RUNS)[number]) => {
    const id = runId(run.id);
    const score = 'score' in run ? run.score : null;
    await db.insert(activeRuns).values({
      id,
      group_folder: project,
      chat_jid: `task-${taskId}@kanban`,
      task_id: taskId,
      sandbox_stack: 'unavailable-in-ui-sandbox',
      sandbox_service: 'agent',
      started_at: at(run.start),
      timeout_at: at(run.start + 30),
      completed_at: at(run.start + run.minutes),
      status: run.status,
      stage: run.stage,
      agent_name: run.agent,
      model: run.model,
      model_name: run.model,
      cost_usd: run.cost,
      tok_input: 120_000 + run.start * 900,
      tok_output: 6_400 + run.minutes * 310,
      tok_cache_read: run.agent === 'claude' ? 410_000 : 0,
      tok_cache_write: run.agent === 'claude' ? 22_000 : 0,
      tok_context_last: 48_000 + run.start * 400,
      tok_total: 140_000 + run.start * 900,
      tool_usage_count: 12 + run.minutes * 2,
      session_id: `sess-${run.id}-0f3a9c1b7d5e`,
      reviewScore: score,
      triggeredByUserId: run.id === 'code-1' ? opts.adminId : null,
      triggerSource: run.id === 'code-1' ? 'user' : 'system',
    } as never);
  };

  const msg = (
    minutes: number,
    role: 'user' | 'assistant' | 'system',
    content: string,
    extra: Record<string, unknown> = {},
  ) =>
    appendTaskMessage(project, {
      task_id: taskId,
      role,
      content,
      created_at: at(minutes),
      ...extra,
    } as never);
  const agent = (run: (typeof RUNS)[number]) => ({
    agent_name: run.agent,
    model_name: run.model,
    run_id: runId(run.id),
  });
  const [code1, test1, test2, code2, code3, test3, review1, code4, review2] =
    RUNS;
  const startRun = async (run: (typeof RUNS)[number]) => {
    await insertRun(run);
    appendRunStartMarker(project, taskId, runId(run.id), {
      agent_name: run.agent,
      model_name: run.model,
      created_at: at(run.start),
    });
  };

  await startRun(code1);
  msg(
    0,
    'user',
    'Make the board column headers keyboard reachable and add an empty state for empty columns.',
  );
  msg(
    10,
    'assistant',
    [
      'I will read the column component first, then add the keyboard handling.',
      toolRound('td-code1', false),
      PROSE[0],
      WIDE_CODE,
      `Design notes are in [task-detail-notes.md](${REPORT_LINK}) and the result looks like ![column header](${SCREENSHOT_LINK}).`,
      TABLE,
    ].join('\n\n'),
    { ...agent(code1), entry_type: 'run_result' },
  );
  await startRun(test1);
  msg(
    24,
    'system',
    '**Testing blocked**\n\nThe dev server did not start inside the sandbox, so no browser check could run.\n\n**Issues:**\n- `bun run dev` exited with code 1: port 5173 already in use',
    { entry_type: 'testing_feedback', run_id: runId(test1.id) },
  );
  await startRun(test2);
  msg(
    32,
    'assistant',
    [
      'I started the app on a free port and ran the keyboard flow.',
      toolRound('td-test2', true),
      PROSE[1],
    ].join('\n\n'),
    { ...agent(test2), entry_type: 'run_result' },
  );
  msg(
    33,
    'system',
    '**Testing failed**\n\nArrow keys skip the third column and the empty state is not shown after the last card is deleted.\n\n**Issues:**\n- ArrowRight on column 2 jumps to column 4\n- Deleting the last card leaves the column blank',
    { entry_type: 'testing_feedback', run_id: runId(test2.id) },
  );
  await startRun(code2);
  msg(
    38,
    'assistant',
    'The run stopped: the container lost its network connection while installing dependencies.',
    { ...agent(code2), entry_type: 'run_result' },
  );
  await startRun(code3);
  msg(
    48,
    'assistant',
    [
      'Fixed the skipped column and the empty state after deleting the last card.',
      toolRound('td-code3', false),
      PROSE[2],
    ].join('\n\n'),
    {
      ...agent(code3),
      entry_type: 'run_result',
    },
  );
  await startRun(test3);
  msg(
    64,
    'system',
    '**Testing passed**\n\nKeyboard flow and empty states verified in the browser. Recordings are attached to the task.',
    { entry_type: 'system_notice', run_id: runId(test3.id) },
  );
  await startRun(review1);
  msg(
    73,
    'system',
    '**Review rejected** (score: 5/10, rejection 1)\n\nKeyboard order is correct, but empty columns have no announcement and the focus ring is clipped.\n\n**Issues:**\n- Empty columns are not announced to screen readers\n- Focus ring is clipped on the first column',
    { run_id: runId(review1.id) },
  );
  await startRun(code4);
  msg(
    84,
    'assistant',
    [
      'Added an `aria-live` hint for empty columns and moved the focus ring inside the header.',
      toolRound('td-code4', false),
    ].join('\n\n'),
    {
      ...agent(code4),
      entry_type: 'run_result',
    },
  );
  await startRun(review2);
  msg(
    94,
    'assistant',
    '**Review approved** (score: 8/10)\n\nBoth issues are fixed and the keyboard flow is complete.',
    { ...agent(review2), entry_type: 'run_result' },
  );
}
