import type { TaskSummary } from '@/types';

export function taskChatDraft(
  task: Pick<TaskSummary, 'id' | 'title' | 'description'>,
) {
  return `Kanban task:\n\nTask ID: ${task.id}\nTitle: ${task.title}\n\nDescription:\n${task.description.trim() || '(No description provided.)'}\n\n`;
}

export function taskChatConversationOptions(
  task: Pick<TaskSummary, 'id' | 'branch_name' | 'worktree_path'>,
) {
  const branch = task.branch_name?.trim();
  const worktreePath = task.worktree_path?.trim();
  return {
    taskContextId: task.id,
    ...(branch && worktreePath ? { use_worktree: true as const, branch } : {}),
  };
}
