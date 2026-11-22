import { describe, expect, test } from 'bun:test';

import { isQuestionStage } from './stages.js';

describe('isQuestionStage', () => {
  test('recognizes a custom stage titled Question', () => {
    expect(
      isQuestionStage(
        [
          {
            id: 'needs-input',
            title: 'Question',
            type: 'queue',
            color: '#f59e0b',
          },
        ],
        'needs-input',
      ),
    ).toBe(true);
  });

  test('does not treat backlog or failed queues as Question', () => {
    const stages = [
      {
        id: 'backlog',
        title: 'Backlog',
        type: 'queue' as const,
        color: '#64748b',
      },
      {
        id: 'failed',
        title: 'Failed',
        type: 'queue' as const,
        color: '#ef4444',
      },
    ];
    expect(isQuestionStage(stages, 'backlog')).toBe(false);
    expect(isQuestionStage(stages, 'failed')).toBe(false);
  });
});
