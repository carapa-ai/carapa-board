import { describe, expect, it } from 'vitest';
import { taskChatConversationOptions } from './task-chat';

describe('task chat context', () => {
  it('binds complete task worktree metadata and always preserves task context', () => {
    expect(
      taskChatConversationOptions({
        id: 'task-1',
        branch_name: ' task/task-1 ',
        worktree_path: ' .worktrees/task-1 ',
      }),
    ).toEqual({
      taskContextId: 'task-1',
      use_worktree: true,
      branch: 'task/task-1',
    });
  });

  it('keeps incomplete legacy checkout metadata on the safe shared fallback', () => {
    expect(
      taskChatConversationOptions({
        id: 'task-legacy',
        branch_name: 'task/task-legacy',
        worktree_path: null,
      }),
    ).toEqual({ taskContextId: 'task-legacy' });
  });
});
