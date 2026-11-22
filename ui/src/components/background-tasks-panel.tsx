import { memo, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { BackgroundTask } from '@/types';

function formatTaskAge(startedAt: number | undefined, now: number): string {
  if (!startedAt) return '';
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Shown while the agent has finished its reply but agents or commands it
 * started are still running. Its next turn begins when they report back, so
 * without this the conversation or task looks idle.
 */
export const BackgroundTasksPanel = memo(function BackgroundTasksPanel({
  tasks,
  onStop,
}: {
  tasks: BackgroundTask[] | undefined;
  onStop: (taskId: string) => Promise<boolean>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!tasks?.length) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [tasks?.length]);

  if (!tasks?.length) return null;

  const stop = async (taskId: string) => {
    setStopping((current) => ({ ...current, [taskId]: true }));
    try {
      if (!(await onStop(taskId))) toast.error('Could not stop that task');
    } catch (err) {
      console.warn('[background] stop failed', err);
      toast.error('Could not stop that task');
    } finally {
      setStopping((current) => ({ ...current, [taskId]: false }));
    }
  };

  return (
    <div className="flex justify-start">
      <div
        data-ui="agent-background-tasks"
        className="max-w-[75%] min-w-0 rounded-lg px-3 py-2 text-sm bg-muted/40 border border-border text-foreground"
      >
        <div className="flex items-start gap-2">
          <Loader2 className="size-3.5 mt-0.5 shrink-0 animate-spin text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Waiting for {tasks.length} background{' '}
              {tasks.length === 1 ? 'task' : 'tasks'}
            </p>
            <ul className="mt-1 space-y-1">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  data-background-task-id={task.id}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span className="min-w-0 flex-1 truncate opacity-70">
                    {task.description}
                  </span>
                  <span className="shrink-0 opacity-50">
                    {formatTaskAge(task.startedAt, now)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] shrink-0"
                    disabled={stopping[task.id]}
                    onClick={() => void stop(task.id)}
                  >
                    Stop
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
});
