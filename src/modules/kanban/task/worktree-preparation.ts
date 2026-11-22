/**
 * Tracks tasks whose isolated worktree is being created before the agent
 * launches. Creating a worktree can take a while in some projects (setup
 * hooks, dependency installs), and the task has no active run yet, so the UI
 * needs this separate signal to show progress on the card and in the dialog.
 */
import { broadcast } from '../../objectives/ws-events.js';

const preparingTasks = new Set<string>();

function setPreparing(
  task_id: string,
  project_id: string,
  preparing: boolean,
): void {
  if (preparing) preparingTasks.add(task_id);
  else preparingTasks.delete(task_id);
  broadcast({
    type: 'task_preparing',
    payload: { task_id, project_id, preparing },
  });
}

/** Mark `task_id` as preparing its worktree while `operation` runs. */
export async function withTaskWorktreePreparation<T>(
  task_id: string | undefined,
  project_id: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!task_id) return operation();
  setPreparing(task_id, project_id, true);
  try {
    return await operation();
  } finally {
    setPreparing(task_id, project_id, false);
  }
}

/** IDs of tasks currently creating their worktree. */
export function getPreparingWorktreeTaskIds(): string[] {
  return Array.from(preparingTasks);
}
