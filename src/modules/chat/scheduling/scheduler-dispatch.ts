interface SchedulerDispatchDependencies<Task extends { id: string }> {
  getDueTasks: () => Promise<Task[]>;
  runTask: (task: Task) => Promise<unknown>;
  processCronjobs: () => Promise<void>;
  maintain: () => Promise<void>;
  onError: (lane: string, error: unknown, taskId?: string) => void;
}

/** Independent lanes, with single-flight admission for each lane and schedule.
 * Polling never holds a lane open for an agent's lifetime. Durable occurrence
 * claims still own cross-process deduplication and restart recovery.
 */
export function createSchedulerDispatch<Task extends { id: string }>(
  deps: SchedulerDispatchDependencies<Task>,
): () => Promise<void> {
  const active = new Set<string>();

  async function run(
    lane: string,
    operation: () => Promise<unknown>,
    taskId?: string,
  ): Promise<void> {
    const key = taskId === undefined ? lane : `${lane}:${taskId}`;
    if (active.has(key)) return;
    active.add(key);
    try {
      await operation();
    } catch (error) {
      deps.onError(lane, error, taskId);
    } finally {
      active.delete(key);
    }
  }

  return async () => {
    await Promise.all([
      run('scheduled_tasks', async () => {
        for (const task of await deps.getDueTasks()) {
          void run('scheduled_task', () => deps.runTask(task), task.id);
        }
      }),
      run('cronjobs', deps.processCronjobs),
      run('maintenance', deps.maintain),
    ]);
  };
}
