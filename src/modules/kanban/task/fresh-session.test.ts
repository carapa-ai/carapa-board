import { describe, expect, test } from 'bun:test';
import { findLatestTaskUserPrompt } from './fresh-session.js';
import type { TaskMessage } from '../types.js';

function message(role: TaskMessage['role'], content: string): TaskMessage {
  return {
    id: `${role}-${content}`,
    task_id: 'task-1',
    role,
    content,
    created_at: '2026-08-05T00:00:00.000Z',
  };
}

describe('fresh task sessions', () => {
  test('selects the latest user follow-up instead of generated task turns', () => {
    const description = 'Implement the explorer';
    expect(
      findLatestTaskUserPrompt(
        [
          message('user', description),
          message('assistant', 'Initial implementation'),
          message('user', 'Fix thumbnails and navigation state'),
          message('assistant', 'Acknowledged'),
          message('user', description),
          message('user', '**Review comparison requested**'),
        ],
        description,
      ),
    ).toBe('Fix thumbnails and navigation state');
  });
});
