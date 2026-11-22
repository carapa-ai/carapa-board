// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';

import {
  DEFERRED_TASK_MESSAGE_CHARS,
  PAGED_OLDER_CONTENT_LIMIT,
  createTaskOutputWindow,
  mergeTaskOutputWindow,
  taskOutputWindowChunks,
  taskOutputWindowGaps,
  isDuplicateTestingFollowUp,
  hideTestingVerdictOutputEntries,
  isHiddenTaskMessage,
  isReviewVerdictPayload,
  reviewVerdictTone,
  isSupersededRunDivider,
  shouldDeferTaskMessage,
  streamAlreadySaved,
} from './task-message-rendering';

describe('bounded task output pagination', () => {
  const entry = (id: string, content: string, startOffset: number) => ({
    id,
    content,
    startOffset,
    endOffset: startOffset + new TextEncoder().encode(content).byteLength,
  });

  test('retains exact gap ranges and refetch anchors after whole-entry eviction', () => {
    const first = entry('first', 'A'.repeat(600_000), 0);
    const second = entry('second', 'B'.repeat(600_000), 600_000);
    const tail = entry('tail', 'tail', 1_200_000);
    let window = createTaskOutputWindow([second, tail]);
    window = mergeTaskOutputWindow(window, [first], { direction: 'older' });

    expect(window.entries.map(({ id }) => id)).toEqual(['first', 'tail']);
    expect(taskOutputWindowGaps(window)).toEqual([
      { startOffset: 600_000, endOffset: 1_200_000 },
    ]);
    expect(
      taskOutputWindowChunks(window)
        .map((chunk) => chunk.content)
        .join(''),
    ).toBe(
      `${first.content}\n\n> [Output omitted from the bounded window]\n\n${tail.content}`,
    );

    window = mergeTaskOutputWindow(window, [second], { direction: 'older' });
    expect(window.entries.map(({ id }) => id)).toEqual(['second', 'tail']);
    expect(taskOutputWindowGaps(window)).toEqual([
      { startOffset: 0, endOffset: 600_000 },
    ]);
  });

  test('keeps an oversized UTF-8 entry whole with its live continuation', () => {
    const oversized = entry(
      'oversized',
      'a'.repeat(PAGED_OLDER_CONTENT_LIMIT - 1) + '😀',
      0,
    );
    const tail = entry('tail', 'tail', oversized.endOffset);
    const window = mergeTaskOutputWindow(
      createTaskOutputWindow([oversized]),
      [tail],
      { direction: 'newer' },
    );
    expect(window.entries.map(({ id }) => id)).toEqual(['oversized', 'tail']);
    expect(window.entries[0].content.endsWith('😀')).toBe(true);
    expect(taskOutputWindowGaps(window)).toEqual([]);
  });
});

describe('task message rendering', () => {
  test('hides delivery bookkeeping but keeps addressed prompts', () => {
    expect(
      isHiddenTaskMessage({
        role: 'system',
        content: '',
        entry_type: 'stage_prompt_delivery',
      }),
    ).toBe(true);
    expect(
      isHiddenTaskMessage({
        role: 'system',
        content: 'Fix the failing test',
        entry_type: 'stage_prompt',
      }),
    ).toBe(false);
  });

  test('defers oversized historical output until the user opens it', () => {
    expect(
      shouldDeferTaskMessage('x'.repeat(DEFERRED_TASK_MESSAGE_CHARS + 1)),
    ).toBe(true);
  });
});

describe('isDuplicateTestingFollowUp', () => {
  test('detects a persisted composite of testing feedback and a user reply', () => {
    const feedback =
      '**Testing blocked**\n\nDisposable database verification is required.';
    const reply = 'use cms_test - that is configured now!';
    const messages = [
      { role: 'assistant', content: 'tester output' },
      { role: 'system', entry_type: 'testing_feedback', content: feedback },
      { role: 'user', content: reply },
      { role: 'user', content: `${feedback}\n\n${reply}` },
    ];

    expect(isDuplicateTestingFollowUp(messages, 3)).toBe(true);
  });

  test('keeps ordinary user messages and non-matching follow-ups', () => {
    const messages = [
      { role: 'system', entry_type: 'testing_feedback', content: 'blocked' },
      { role: 'user', content: 'use the configured database' },
      { role: 'user', content: 'a genuinely different follow-up' },
    ];

    expect(isDuplicateTestingFollowUp(messages, 1)).toBe(false);
    expect(isDuplicateTestingFollowUp(messages, 2)).toBe(false);
  });
});

describe('legacy testing transcript cleanup', () => {
  test('collapses only adjacent repair dividers', () => {
    const dividers = [
      { role: 'system', content: '', entry_type: 'run_start' },
      { role: 'system', content: '', entry_type: 'run_start' },
    ];
    expect(isSupersededRunDivider(dividers, 0)).toBe(false);
    expect(isSupersededRunDivider(dividers, 1)).toBe(true);
  });
});

describe('review verdict rendering', () => {
  const verdict =
    '```json\n{"decision":"approve","score":10,"issues":[],"summary":"ok"}\n```';

  test('recognises only a whole parsed verdict payload', () => {
    expect(isReviewVerdictPayload(verdict)).toBe(true);
    expect(
      isReviewVerdictPayload('{"decision":"reject","score":4,"issues":[]}'),
    ).toBe(true);
    expect(isReviewVerdictPayload('Looks fine.\n' + verdict)).toBe(false);
    expect(isReviewVerdictPayload('```json\n{"decision":"approve"')).toBe(
      false,
    );
    expect(isReviewVerdictPayload('{"decision":"pass","score":1}')).toBe(false);
  });

  test('blanks verdict output entries and keeps other entries and offsets', () => {
    const tool = '\n\n<!-- carapa-tool:request -->';
    const window = createTaskOutputWindow([
      { id: 'tool', content: tool, startOffset: 0, endOffset: tool.length },
      {
        id: 'message:a',
        content: verdict,
        startOffset: tool.length,
        endOffset: tool.length + verdict.length,
      },
    ]);
    expect(window.entries).toHaveLength(2);
    const hidden = hideTestingVerdictOutputEntries(window);
    expect(hidden.entries.map((entry) => entry.content)).toEqual([tool, '']);
    expect(hidden.entries[1].endOffset).toBe(tool.length + verdict.length);
  });

  test('tones only approval and rejection verdict cards', () => {
    const tone = (role, content) => reviewVerdictTone({ role, content });
    expect(tone('assistant', '**Review approved** (score: 10/10)\n\nok')).toBe(
      'approve',
    );
    expect(
      tone('assistant', '**Review accepted with nits** (score: 8/10)\n\nok'),
    ).toBe('approve');
    expect(
      tone('system', '**Review rejected** (score: 4/10, rejection 2)\n\nx'),
    ).toBe('reject');
    expect(tone('system', '**Review paused** (3 total rejections)')).toBe(
      undefined,
    );
    expect(tone('system', '**Review approved, merge pending** — x')).toBe(
      undefined,
    );
    expect(tone('user', '**Review approved** (score: 10/10)')).toBe(undefined);
    expect(
      tone('assistant', '**Review comparison** — retry: First rejection.'),
    ).toBe('neutral');
    expect(
      tone('assistant', '**Review comparison** — pause: no progress.'),
    ).toBe('reject');
    expect(
      tone(
        'assistant',
        '**Review comparison failed** — the task will be paused',
      ),
    ).toBe('reject');
    expect(tone('assistant', '**Review comparison requested**')).toBe(
      undefined,
    );
  });
});

describe('streamAlreadySaved', () => {
  const runStart = (runId: string) => ({
    id: `marker-${runId}`,
    task_id: 'task-1',
    role: 'system',
    content: '',
    entry_type: 'run_start',
    run_id: runId,
    created_at: '2026-08-22T01:21:06.559Z',
  });
  const notice = (content: string) => ({
    id: 'notice-1',
    task_id: 'task-1',
    role: 'system',
    content,
    entry_type: 'system_notice',
    created_at: '2026-08-22T01:25:56.644Z',
  });
  const assistant = (content: string) => ({
    id: 'assistant-1',
    task_id: 'task-1',
    role: 'assistant',
    content,
    created_at: '2026-08-22T01:26:25.857Z',
  });

  test('retires the fallback when a discarded run leaves no assistant content', () => {
    // Review format repair keeps only the corrected response plus a system
    // notice; the invalid attempt (the live stream) is never persisted. The
    // settled refetch for that exact run must still retire the live bubble,
    // otherwise it lingers at the bottom of the chat after every later run.
    const live = '{"decision":"approve","score":9,"issues":';
    const messages = [
      runStart('run-19'),
      notice(
        'Review response format was invalid. Requesting corrected JSON (1/2)…',
      ),
      runStart('run-20'),
      assistant('**Review approved** (score: 9/10)'),
    ];

    expect(streamAlreadySaved(live, messages, false, 'run-19', 'run-19')).toBe(
      true,
    );
  });

  test("keeps the fallback until the owning run's refetch has settled", () => {
    const live = '{"decision":"approve","score":9,"issues":';
    const messages = [
      runStart('run-19'),
      notice(
        'Review response format was invalid. Requesting corrected JSON (1/2)…',
      ),
      runStart('run-20'),
      assistant('**Review approved** (score: 9/10)'),
    ];

    expect(streamAlreadySaved(live, messages, false, 'run-19', undefined)).toBe(
      false,
    );
    expect(streamAlreadySaved(live, messages, false, 'run-19', 'run-20')).toBe(
      false,
    );
    expect(streamAlreadySaved(live, messages, true, 'run-19', 'run-19')).toBe(
      true,
    );
  });

  test('hands off when the run segment already holds the streamed content', () => {
    const live = 'The fix lands in waitForRun.';
    const messages = [
      runStart('run-19'),
      assistant('The fix lands in waitForRun.'),
    ];

    expect(streamAlreadySaved(live, messages, false, 'run-19', 'run-19')).toBe(
      true,
    );
  });

  test('retires a testing stream after its formatted outcome is persisted', () => {
    const live =
      'Focused validation completed.\n{"decision":"blocked","issues":["database unavailable"],"summary":"blocked"}';
    const messages = [
      runStart('run-19'),
      assistant('Focused validation completed.'),
      {
        ...notice(
          '**Testing blocked**\n\nTesting could not reach a verdict.\n\n**Issues:**\n- database unavailable',
        ),
        entry_type: 'testing_feedback',
      },
    ];

    expect(streamAlreadySaved(live, messages, false, 'run-19', 'run-19')).toBe(
      true,
    );
  });

  test('keeps the fallback when the segment has assistant content that does not cover the stream', () => {
    const live = 'Still streaming a much longer response…';
    const messages = [
      runStart('run-19'),
      assistant('An unrelated checkpoint answer.'),
      runStart('run-20'),
    ];

    expect(streamAlreadySaved(live, messages, false, 'run-19', 'run-19')).toBe(
      false,
    );
  });

  test('retires the fallback for an unowned idle task with a saved reply', () => {
    const messages = [runStart('run-19'), assistant('Saved reply.')];

    expect(streamAlreadySaved('Saved reply.', messages, false)).toBe(true);
    expect(streamAlreadySaved('Saved reply.', messages, true)).toBe(false);
  });
});
