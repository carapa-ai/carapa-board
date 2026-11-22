import { createHash } from 'crypto';

import { describe, expect, test } from 'bun:test';

import {
  annotateObjectiveEventRunOutcomes,
  createObjectiveHandler,
  currentObjectiveRun,
  groupObjectiveEvents,
  liveBrainRunDir,
  obsoleteObjectiveFieldsError,
  queuedObjectiveEventGroups,
} from './objectives.js';

describe('objective event run outcomes', () => {
  test('reports persisted source delivery instead of waiting for a local run', () => {
    const events = [
      {
        type: 'objective_event',
        timestamp: '2026-07-27T10:00:00.000Z',
        payload: {
          source_objective_id: 'obj-source',
          event: 'progress_updated',
        },
        delivery: { status: 'unmatched', targetObjectiveIds: [] },
      },
      {
        type: 'objective_event',
        timestamp: '2026-07-27T10:01:00.000Z',
        payload: {
          source_objective_id: 'obj-source',
          event: 'status_changed',
        },
        delivery: {
          status: 'enqueued',
          targetObjectiveIds: ['obj-subscriber'],
        },
      },
    ];

    const annotated = annotateObjectiveEventRunOutcomes(
      events,
      [],
      [],
      Date.now(),
      'obj-source',
    );
    expect(annotated.map((event) => event.runStatus)).toEqual([
      'unmatched',
      'delivered',
    ]);
    expect(groupObjectiveEvents(annotated)[1]?.delivery).toEqual({
      status: 'enqueued',
      targetObjectiveIds: ['obj-subscriber'],
    });
  });

  test('marks legacy source events unknown but keeps incoming events pending', () => {
    const sourceEvent = {
      type: 'objective_event',
      timestamp: '2026-07-27T10:00:00.000Z',
      payload: {
        source_objective_id: 'obj-source',
        event: 'progress_updated',
      },
    };

    expect(
      annotateObjectiveEventRunOutcomes(
        [sourceEvent],
        [],
        [],
        Date.now(),
        'obj-source',
      )[0]?.runStatus,
    ).toBe('unknown');
    expect(
      annotateObjectiveEventRunOutcomes(
        [sourceEvent],
        [],
        [],
        Date.now(),
        'obj-subscriber',
      )[0]?.runStatus,
    ).toBe('pending');
  });

  test('links batched trigger events to the agent run they produced', () => {
    const events = [
      {
        type: 'task_completed',
        timestamp: '2026-07-27T10:00:00.000Z',
        payload: {},
      },
      {
        type: 'task_completed',
        timestamp: '2026-07-27T10:00:01.000Z',
        payload: {},
      },
      {
        type: 'agent_invoked',
        timestamp: '2026-07-27T10:00:02.000Z',
        payload: { trigger_type: 'task_completed', run_id: 'run-123' },
      },
    ];

    const result = annotateObjectiveEventRunOutcomes(
      events,
      [],
      [{ runId: 'run-123' }],
    );
    expect(result.map((event) => event.runStatus)).toEqual([
      'run',
      'run',
      'run',
    ]);
    expect(result.map((event) => event.linkedRunId)).toEqual([
      'run-123',
      'run-123',
      'run-123',
    ]);
  });

  test('links mixed-type batched events to the run named after the first', () => {
    const events = [
      {
        type: 'box_started',
        timestamp: '2026-10-17T08:34:49.698Z',
        payload: {},
      },
      {
        type: 'board_started',
        timestamp: '2026-10-17T08:38:21.668Z',
        payload: {},
      },
      {
        type: 'agent_invoked',
        timestamp: '2026-10-17T09:02:19.173Z',
        payload: { trigger_type: 'box_started', run_id: 'run-batch' },
      },
    ];

    const result = annotateObjectiveEventRunOutcomes(
      events,
      [],
      [{ runId: 'run-batch' }],
    );
    expect(result.map((event) => event.runStatus)).toEqual([
      'run',
      'run',
      'run',
    ]);
    expect(result.map((event) => event.linkedRunId)).toEqual([
      'run-batch',
      'run-batch',
      'run-batch',
    ]);
  });

  test('shows an explicit no-run outcome for skipped events', () => {
    const events = [
      {
        type: 'task_completed',
        timestamp: '2026-07-27T10:00:00.000Z',
        payload: {},
      },
    ];
    const evals = [
      {
        runId: 'run-skipped',
        timestamp: '2026-07-27T10:00:01.000Z',
        triggerType: 'task_completed',
        skipped: true,
        rationale: 'Skipped — low-score waste gate',
      },
    ];

    expect(annotateObjectiveEventRunOutcomes(events, evals)[0]).toMatchObject({
      runStatus: 'skipped',
      linkedRunId: 'run-skipped',
      runRationale: 'Skipped — low-score waste gate',
    });
  });

  test('marks brain-flagged skipped events as no-run and keeps them out of the next batch', () => {
    const events = [
      {
        type: 'board_started',
        timestamp: '2026-10-26T14:20:36.000Z',
        payload: {},
        skipped: true,
      },
      {
        type: 'cron_triggered',
        timestamp: '2026-10-26T15:06:45.000Z',
        payload: {},
      },
      {
        type: 'agent_invoked',
        timestamp: '2026-10-26T15:06:46.000Z',
        payload: { run_id: 'run-drive' },
      },
    ];
    const runStats = [{ runId: 'run-drive' }];

    const result = annotateObjectiveEventRunOutcomes(events, [], runStats);
    expect(result[0]).toMatchObject({
      runStatus: 'skipped',
      runRationale: 'Handled by the brain without an agent run',
    });
    expect(result[0]!.linkedRunId).toBeUndefined();
    expect(result[1]).toMatchObject({
      runStatus: 'run',
      linkedRunId: 'run-drive',
    });
  });

  test('does not call a launcher attempt an actual run without run stats', () => {
    const events = [
      {
        type: 'cron_triggered',
        timestamp: '2026-07-27T10:00:00.000Z',
        payload: {},
      },
      {
        type: 'agent_invoked',
        timestamp: '2026-07-27T10:00:01.000Z',
        payload: {
          trigger_type: 'cron_triggered',
          run_id: 'run-launch-failed',
        },
      },
    ];

    const result = annotateObjectiveEventRunOutcomes(
      events,
      [],
      [],
      new Date('2026-07-27T10:05:00.000Z').getTime(),
    );
    expect(result.map((event) => event.runStatus)).toEqual([
      'pending',
      'pending',
    ]);
    expect(result[0]?.linkedRunId).toBe('run-launch-failed');
  });

  test('marks a stale invocation without run stats as failed', () => {
    const events = [
      {
        type: 'cron_triggered',
        timestamp: '2026-07-27T10:00:00.000Z',
        payload: {},
      },
      {
        type: 'agent_invoked',
        timestamp: '2026-07-27T10:00:01.000Z',
        payload: {
          trigger_type: 'cron_triggered',
          run_id: 'run-launch-failed',
        },
      },
    ];

    const result = annotateObjectiveEventRunOutcomes(
      events,
      [],
      [],
      new Date('2026-07-27T10:26:00.000Z').getTime(),
    );
    expect(result.map((event) => event.runStatus)).toEqual([
      'failed',
      'failed',
    ]);
    expect(result[0]?.runRationale).toBe(
      'Agent invocation did not produce a completed run',
    );
  });

  describe('brain liveness', () => {
    const invocation = (runId: string, timestamp: string) => ({
      type: 'agent_invoked',
      timestamp,
      payload: { run_id: runId },
    });
    const at = (iso: string) => new Date(iso).getTime();

    test('keeps a long-running invocation pending while the brain reports it active', () => {
      const result = annotateObjectiveEventRunOutcomes(
        [invocation('run-long', '2026-07-27T10:00:00.000Z')],
        [],
        [],
        at('2026-07-27T10:15:00.000Z'),
        'obj-1',
        true,
      );
      expect(result[0]).toMatchObject({
        runStatus: 'pending',
        linkedRunId: 'run-long',
      });
    });

    test('falls back to the age rule when liveness is unknown', () => {
      const events = [invocation('run-long', '2026-07-27T10:00:00.000Z')];
      expect(
        annotateObjectiveEventRunOutcomes(
          events,
          [],
          [],
          at('2026-07-27T10:15:00.000Z'),
          'obj-1',
          undefined,
        )[0]?.runStatus,
      ).toBe('pending');
      expect(
        annotateObjectiveEventRunOutcomes(
          events,
          [],
          [],
          at('2026-07-27T10:26:00.000Z'),
          'obj-1',
          undefined,
        )[0]?.runStatus,
      ).toBe('failed');
    });

    test('only the newest uncompleted invocation stays pending while active', () => {
      const result = annotateObjectiveEventRunOutcomes(
        [
          invocation('run-old', '2026-07-27T08:00:00.000Z'),
          invocation('run-new', '2026-07-27T09:00:00.000Z'),
        ],
        [],
        [],
        at('2026-07-27T10:00:00.000Z'),
        'obj-1',
        true,
      );
      expect(result.map((event) => event.runStatus)).toEqual([
        'failed',
        'pending',
      ]);
    });

    test('a completed run stays run regardless of liveness', () => {
      const result = annotateObjectiveEventRunOutcomes(
        [invocation('run-done', '2026-07-27T10:00:00.000Z')],
        [],
        [{ runId: 'run-done' }],
        at('2026-07-27T11:00:00.000Z'),
        'obj-1',
        true,
      );
      expect(result[0]?.runStatus).toBe('run');
    });
  });
});

describe('objective event grouping', () => {
  test('groups batched triggers with the invocation they produced', () => {
    const events = annotateObjectiveEventRunOutcomes(
      [
        {
          type: 'task_completed',
          timestamp: '2026-07-27T10:00:00.000Z',
          payload: { task_id: 'task-1' },
        },
        {
          type: 'task_completed',
          timestamp: '2026-07-27T10:00:01.000Z',
          payload: { task_id: 'task-2' },
        },
        {
          type: 'agent_invoked',
          timestamp: '2026-07-27T10:00:02.000Z',
          payload: { trigger_type: 'task_completed', run_id: 'run-123' },
        },
      ],
      [],
      [{ runId: 'run-123' }],
    );

    expect(groupObjectiveEvents(events)).toEqual([
      expect.objectContaining({
        timestamp: '2026-07-27T10:00:02.000Z',
        linkedRunId: 'run-123',
        runStatus: 'run',
        events,
      }),
    ]);
  });

  test('keeps unrelated events as standalone groups', () => {
    const events = annotateObjectiveEventRunOutcomes(
      [
        {
          type: 'objective_created',
          timestamp: '2026-07-27T10:00:00.000Z',
          payload: {},
        },
        {
          type: 'objective_updated',
          timestamp: '2026-07-27T10:00:01.000Z',
          payload: {},
        },
      ],
      [],
    );

    expect(groupObjectiveEvents(events).map((group) => group.events)).toEqual([
      [events[0]],
      [events[1]],
    ]);
  });
});

describe('current objective run', () => {
  const now = Date.parse('2026-10-17T09:00:00.000Z');
  const invoked = (runId: string, timestamp: string) => ({
    type: 'agent_invoked',
    timestamp,
    payload: { run_id: runId, trigger_type: 'self_reminder' },
  });

  test('returns the newest invocation without run stats', () => {
    const annotated = annotateObjectiveEventRunOutcomes(
      [
        invoked('run-done', '2026-10-17T08:40:00.000Z'),
        invoked('run-live', '2026-10-17T08:55:00.000Z'),
      ],
      [],
      [{ runId: 'run-done' }],
      now,
      'obj-1',
      true,
    );
    expect(currentObjectiveRun(annotated)).toEqual({
      runId: 'run-live',
      timestamp: '2026-10-17T08:55:00.000Z',
      triggerType: 'self_reminder',
    });
  });

  test('returns null when every invocation completed or went stale', () => {
    const annotated = annotateObjectiveEventRunOutcomes(
      [
        invoked('run-done', '2026-10-17T08:40:00.000Z'),
        invoked('run-stale', '2026-10-17T07:00:00.000Z'),
      ],
      [],
      [{ runId: 'run-done' }],
      now,
      'obj-1',
      false,
    );
    expect(currentObjectiveRun(annotated)).toBeNull();
  });

  test('hides the pending invocation only when the brain reports inactive', () => {
    const annotate = (active: boolean | undefined) =>
      annotateObjectiveEventRunOutcomes(
        [invoked('run-live', '2026-10-17T08:55:00.000Z')],
        [],
        [],
        now,
        'obj-1',
        active,
      );
    expect(currentObjectiveRun(annotate(false), false)).toBeNull();
    expect(currentObjectiveRun(annotate(undefined), undefined)?.runId).toBe(
      'run-live',
    );
    expect(currentObjectiveRun(annotate(true), true)?.runId).toBe('run-live');
  });

  test('maps the brain container to its IPC run directory', () => {
    expect(
      liveBrainRunDir('carapa-projects-carapa-agent-1', 'run-1')?.endsWith(
        'ipc/carapa-projects-carapa/brain-runs/runs/run-1',
      ),
    ).toBe(true);
    expect(liveBrainRunDir('not-a-compose-name', 'run-1')).toBeNull();
  });
});

describe('queued objective events', () => {
  const boxStarted = {
    type: 'box_started',
    timestamp: '2026-10-17T08:34:49.698Z',
    payload: { project_id: 'carapa', version: '43c8f09' },
  };
  const boardStarted = {
    type: 'board_started',
    timestamp: '2026-10-17T08:38:21.668Z',
    payload: { project_id: 'carapa', version: 'cf1ecd2' },
  };

  test('lists batched pending events of this objective as one queued group', () => {
    const groups = queuedObjectiveEventGroups(
      {
        items: [
          {
            objectiveId: 'obj-1',
            triggerEvent: boxStarted,
            pendingEvents: [boxStarted, boardStarted],
          },
          { objectiveId: 'obj-2', triggerEvent: boardStarted },
        ],
        currentItems: [{ objectiveId: 'obj-1', triggerEvent: boardStarted }],
      },
      'obj-1',
    );
    expect(groups).toEqual([
      {
        timestamp: boardStarted.timestamp,
        runStatus: 'queued',
        events: [
          { ...boxStarted, runStatus: 'queued' },
          { ...boardStarted, runStatus: 'queued' },
        ],
      },
    ]);
  });

  test('uses the trigger event, skips logged events and marks delayed items', () => {
    const loggedKey = createHash('sha1')
      .update(JSON.stringify(boxStarted))
      .digest('hex');
    const groups = queuedObjectiveEventGroups(
      {
        items: [
          {
            objectiveId: 'obj-1',
            triggerEvent: boxStarted,
            loggedEventKeys: [loggedKey],
          },
          {
            objectiveId: 'obj-1',
            triggerEvent: boardStarted,
            notBefore: '2026-10-17T09:00:00.000Z',
          },
        ],
      },
      'obj-1',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events.map((event) => event.type)).toEqual([
      'board_started',
    ]);
    expect(groups[0]!.runRationale).toBe(
      'Scheduled for 2026-10-17T09:00:00.000Z',
    );
  });

  test('tolerates a missing or malformed queue', () => {
    expect(queuedObjectiveEventGroups(null, 'obj-1')).toEqual([]);
    expect(queuedObjectiveEventGroups({ items: 'x' }, 'obj-1')).toEqual([]);
  });
});

describe('objective creation compatibility validation', () => {
  test('rejects unsupported legacy event runtime fields', () => {
    expect(obsoleteObjectiveFieldsError({ agent_cmd: 'codex' })).toBe(
      'Legacy objective runtime fields are not supported: agent_cmd. Use eventRuntimeSelection instead.',
    );
  });

  test('rejects an invalid structured event runtime through shared validation', async () => {
    let status = 200;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };

    await createObjectiveHandler(
      {
        params: { pid: 'project' },
        body: {
          title: 'Invalid runtime',
          eventRuntimeSelection: {
            harnessId: 'missing',
            modelId: 'missing',
          },
        },
      },
      res,
    );

    expect(status).toBe(400);
    expect(body).toEqual({
      error: 'Incompatible runtime selection missing/missing',
    });
  });
});
