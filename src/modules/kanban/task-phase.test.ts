import { describe, expect, test } from 'bun:test';
import { presentTaskExecution, type TaskPhase } from './task-phase.js';

const ID = 'task-1';

function present(
  markers: Partial<
    Record<'running' | 'queued' | 'waiting' | 'preparing', true>
  >,
  error?: string,
) {
  const set = (key: keyof typeof markers) => new Set(markers[key] ? [ID] : []);
  return presentTaskExecution(
    { id: ID, error },
    {
      running: set('running'),
      queued: set('queued'),
      waiting: set('waiting'),
      preparing: set('preparing'),
    },
  );
}

describe('presentTaskExecution', () => {
  const cases: Array<
    [
      string,
      Parameters<typeof present>[0],
      string | undefined,
      TaskPhase,
      Partial<ReturnType<typeof present>>,
    ]
  > = [
    [
      'running wins over queued',
      { running: true, queued: true },
      undefined,
      'running',
      { running: true, queued: false },
    ],
    [
      'preparing wins over queued',
      { preparing: true, queued: true },
      undefined,
      'preparing',
      { preparing: true, queued: true },
    ],
    [
      'queued with an error stays queued',
      { queued: true },
      'Retry scheduled: later',
      'queued',
      { queued: true },
    ],
    [
      'waiting with an error is not waiting',
      { waiting: true },
      'Stalled: agent silent for 60s (idle timeout)',
      'stalled',
      { waiting: false },
    ],
    [
      'waiting with a non-stalled error is idle',
      { waiting: true },
      'Retry scheduled: later',
      'idle',
      { waiting: false },
    ],
    [
      'stalled error without markers',
      {},
      'Stalled: agent silent for 60s (idle timeout)',
      'stalled',
      {},
    ],
    ['no markers', {}, undefined, 'idle', {}],
  ];

  test.each(cases)('%s', (_name, markers, error, phase, flags) => {
    const result = present(markers, error);
    expect(result.phase).toBe(phase);
    expect(result).toMatchObject(flags);
  });
});
