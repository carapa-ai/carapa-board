import type { TaskMessage } from '../types.js';

const REVIEW_COMPARISON_REQUEST = '**Review comparison requested**';

export function findLatestTaskUserPrompt(
  messages: TaskMessage[],
  taskDescription: string,
): string | undefined {
  const description = taskDescription.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const content = message.content.trim();
    if (!content || content === REVIEW_COMPARISON_REQUEST) continue;
    // Fresh stage runs persist the task description as a user turn. It is
    // already included separately and is not the user's latest follow-up.
    if (description && content === description) continue;
    return content;
  }
  return undefined;
}

export function buildFreshSessionContinuationPrompt(
  taskDescription: string,
  latestPrompt?: string,
): string {
  const sections = [`## Task description\n\n${taskDescription.trim()}`];
  const latest = latestPrompt?.trim();
  if (latest) sections.push(`## Latest user prompt\n\n${latest}`);
  sections.push(
    '## Continuation guidance\n\nThis task has already been attempted and there is work in progress in the existing task worktree. Continue from those changes: inspect the current checkout and `git status`/`git diff` before editing, preserve useful work, and address the remaining task requirements. Do not reset or discard the worktree just because this is a fresh agent session.',
  );
  return sections.join('\n\n');
}
