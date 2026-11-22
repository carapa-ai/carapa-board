import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createTask, getTask, initDatabase } from '../../../db.js';
import { PrivacyRefusal } from '../../../lib/privacy-policy.js';
import { truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import * as pushTools from '../../tools/push-tools.js';
import { readTaskMessages } from '../../transcripts/transcript-store.js';
import { parkTaskForPrivacyRefusal } from './task-privacy-gate.js';

const queue = (id: string, title: string) => ({
  id,
  title,
  type: 'queue' as const,
  color: '#888',
});
const stagesWithQuestion = [
  queue('backlog', 'Backlog'),
  queue('question', 'Question'),
  {
    id: 'in_progress',
    title: 'In progress',
    type: 'active' as const,
    color: '#08f',
  },
];

function groupFor(folder: string, stages: typeof stagesWithQuestion) {
  return {
    name: folder,
    folder,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: { status: 'paused', stages },
  } as RegisteredGroup;
}

const refusal = () =>
  new PrivacyRefusal({
    projectId: 'p',
    purpose: 'agent',
    mode: 'strict',
    target: 'remote-runtime',
  });

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
});

afterAll(async () => {
  await truncateTestDb();
});

describe('parkTaskForPrivacyRefusal', () => {
  test.each([
    ['Question', 'task-privacy-gate-question', stagesWithQuestion, 'question'],
    [
      'backlog when there is no Question stage',
      'task-privacy-gate-backlog',
      stagesWithQuestion.filter((stage) => stage.id !== 'question'),
      'backlog',
    ],
  ])(
    'parks in %s with the reason and a needs_input notification',
    async (_label, projectId, stages, expectedStage) => {
      const notify = spyOn(
        pushTools,
        'notifyEntityLifecycle',
      ).mockResolvedValue(undefined);
      try {
        const task = await createTask({
          project_id: projectId,
          title: 'Private card',
          description: '',
          status: 'in_progress',
          priority: 0,
        });
        await parkTaskForPrivacyRefusal(
          task,
          groupFor(projectId, stages),
          refusal(),
        );

        const parked = await getTask(task.id);
        expect(parked?.status).toBe(expectedStage);
        expect(parked?.error).toBe(refusal().message);
        const notices = readTaskMessages(projectId, task.id).filter(
          (message) => message.entry_type === 'system_notice',
        );
        expect(notices.map((message) => message.content)).toEqual([
          'Privacy mode "strict" blocks this run: runtime "remote-runtime" is not local. Choose a local runtime (and a local or no fallback model) for this stage, or change the project privacy mode.',
        ]);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({
          task_id: task.id,
          event: 'needs_input',
        });
      } finally {
        notify.mockRestore();
      }
    },
  );
});
