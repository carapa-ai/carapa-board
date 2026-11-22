import type { Task, TaskPhase } from '../types';

/**
 * One execution phase for a task. The server `phase` is authoritative; the
 * WebSocket live/stalled signals only overlay it, so every surface that shows
 * execution state agrees for the same task and store state.
 */
export function resolveTaskPhase(
  task: Pick<Task, 'phase'>,
  {
    isLive,
    isStalledFromStore,
    readOnly = false,
  }: { isLive: boolean; isStalledFromStore: boolean; readOnly?: boolean },
): TaskPhase {
  const serverPhase = task.phase ?? 'idle';
  if (!readOnly && isLive) return 'running';
  if (
    isStalledFromStore &&
    serverPhase !== 'running' &&
    serverPhase !== 'preparing' &&
    serverPhase !== 'queued'
  ) {
    return 'stalled';
  }
  return serverPhase;
}
