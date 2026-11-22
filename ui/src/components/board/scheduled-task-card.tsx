import { memo, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { confirmAction } from '@/components/confirm-dialog';
import { ScheduledTaskDetailsDialog } from '@/components/scheduled-task-details-dialog';
import { cn, formatDuration, formatRelativeTime } from '@/lib/utils';
import {
  FRESH_CONTEXT_DESCRIPTION,
  formatScheduledTaskCadence,
} from '@/lib/scheduled-task-format';
import {
  useUpdateScheduledTask,
  useDeleteScheduledTask,
} from '@/hooks/use-scheduled-tasks';
import { useWallClockRefresh } from '@/hooks/use-wall-clock-refresh';
import { useElapsedTime } from '@/hooks/use-elapsed-time';
import type { ScheduledTask } from '@/types';

interface ScheduledTaskCardProps {
  scheduledTask: ScheduledTask;
  project_id: string;
  onOpen?: (task: ScheduledTask) => void;
}

export const ScheduledTaskCard = memo(function ScheduledTaskCard({
  scheduledTask,
  project_id,
  onOpen,
}: ScheduledTaskCardProps) {
  const updateMutation = useUpdateScheduledTask(project_id);
  const deleteMutation = useDeleteScheduledTask(project_id);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);

  const isPaused = scheduledTask.status === 'paused';
  const isCompleted = scheduledTask.status === 'completed';
  const nextRunIsFuture =
    Boolean(scheduledTask.nextRun) &&
    new Date(scheduledTask.nextRun!).getTime() > Date.now();
  const runningElapsed = useElapsedTime(
    scheduledTask.runningSince ?? undefined,
    scheduledTask.running,
  );
  useWallClockRefresh(
    Boolean(
      scheduledTask.lastRun ||
      (scheduledTask.nextRun && !isCompleted && nextRunIsFuture),
    ),
  );

  const toggleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isCompleted) return;
    if (!isPaused && scheduledTask.running) {
      setPauseDialogOpen(true);
      return;
    }
    updateMutation.mutate({
      scheduled_task_id: scheduledTask.id,
      data: { status: isPaused ? 'active' : 'paused' },
    });
  };

  const pauseRunningTask = (currentRunAction: 'finish' | 'stop') => {
    updateMutation.mutate(
      {
        scheduled_task_id: scheduledTask.id,
        data: { status: 'paused', currentRunAction },
      },
      { onSuccess: () => setPauseDialogOpen(false) },
    );
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await confirmAction('This cannot be undone.', {
      title: 'Delete this scheduled task?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    deleteMutation.mutate(scheduledTask.id);
  };

  const scheduleLabel = formatScheduledTaskCadence(scheduledTask);
  const openDetails = () => {
    onOpen?.(scheduledTask);
    setOpen(true);
  };

  return (
    <>
      <Card
        data-ui="scheduled-task-card"
        data-scheduled-task-id={scheduledTask.id}
        onClick={openDetails}
        className={cn(
          'border-dashed border-2 min-w-[220px] max-w-[280px] flex-shrink-0 transition-all overflow-hidden',
          isCompleted
            ? 'border-muted-foreground/20 opacity-50'
            : isPaused
              ? 'border-muted-foreground/30 opacity-60'
              : 'border-sky-600 dark:border-sky-500/40',
        )}
      >
        <CardContent className="py-3 px-1.5 space-y-2 min-w-0">
          {/* Header row */}
          <div className="flex items-start justify-between gap-2">
            <button
              type="button"
              data-ui="scheduled-task-details-trigger"
              aria-label={`Open scheduled task: ${scheduledTask.prompt}`}
              className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
              onClick={(event) => {
                event.stopPropagation();
                openDetails();
              }}
            >
              <CalendarClock className="size-3.5 flex-shrink-0 text-sky-700 dark:text-sky-500" />
              <p
                className="text-sm font-medium leading-tight min-w-0 flex-1 truncate"
                title={scheduledTask.prompt}
              >
                {scheduledTask.prompt}
              </p>
            </button>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {!isCompleted && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={isPaused ? 'Resume' : 'Pause'}
                  onClick={toggleStatus}
                  disabled={updateMutation.isPending}
                >
                  {isPaused ? (
                    <Play className="size-3" />
                  ) : (
                    <Pause className="size-3" />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                title="Delete"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>

          {/* Schedule expression */}
          <code className="text-[11px] text-muted-foreground font-mono block break-all whitespace-pre-wrap">
            {scheduleLabel}
          </code>

          {/* Badges + timestamps */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {scheduledTask.running && (
              <Badge
                data-ui="scheduled-task-running-marker"
                variant="outline"
                className="text-[10px] h-5 px-1.5 gap-1 border-sky-600 bg-sky-500/10 text-sky-700 dark:border-sky-500/60 dark:text-sky-400"
                title={
                  scheduledTask.runningSince
                    ? `Running since ${scheduledTask.runningSince}`
                    : 'Waiting to start'
                }
              >
                <LoaderCircle className="size-3 animate-spin" />
                {scheduledTask.runningSince
                  ? `Running ${formatDuration(runningElapsed)}`
                  : 'Starting'}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] h-4 px-1',
                isCompleted
                  ? 'border-muted-foreground/30 text-muted-foreground'
                  : isPaused
                    ? 'border-muted-foreground/40 text-muted-foreground'
                    : 'border-sky-600 text-sky-700 dark:border-sky-500/50 dark:text-sky-600',
              )}
            >
              {scheduledTask.status}
            </Badge>
            {scheduledTask.contextMode === 'isolated' && (
              <Badge
                variant="outline"
                className="text-[10px] h-4 px-1"
                title={FRESH_CONTEXT_DESCRIPTION}
              >
                fresh context
              </Badge>
            )}
            <div className="flex items-center gap-2 ml-auto">
              {scheduledTask.lastRun && (
                <span
                  data-ui="scheduled-task-last-run"
                  className="text-[10px] text-muted-foreground"
                  title={`Last run: ${scheduledTask.lastRun}`}
                >
                  ran {formatRelativeTime(scheduledTask.lastRun)}
                </span>
              )}
              {scheduledTask.nextRun && !isCompleted && nextRunIsFuture && (
                <span
                  data-ui="scheduled-task-next-run"
                  className="text-[10px] text-muted-foreground"
                  title={`Next run: ${scheduledTask.nextRun}`}
                >
                  next {formatRelativeTime(scheduledTask.nextRun)}
                </span>
              )}
            </div>
          </div>

          {/* Last result (expandable) */}
          {scheduledTask.lastResult && (
            <div className="border-t border-dashed border-muted-foreground/20 pt-1.5">
              <button
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setResultExpanded((v) => !v);
                }}
              >
                {resultExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                Last result
              </button>
              {resultExpanded && (
                <p className="text-[11px] text-muted-foreground mt-1 whitespace-pre-wrap break-words line-clamp-6">
                  {scheduledTask.lastResult}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <ScheduledTaskDetailsDialog
        project_id={project_id}
        task={scheduledTask}
        open={open}
        onOpenChange={setOpen}
      />
      <Dialog open={pauseDialogOpen} onOpenChange={setPauseDialogOpen}>
        <DialogContent
          data-ui="scheduled-task-pause-dialog"
          data-scheduled-task-id={scheduledTask.id}
        >
          <DialogHeader>
            <DialogTitle>Pause this scheduled task?</DialogTitle>
            <DialogDescription>
              This task is currently running. Choose what should happen to the
              current run; either choice pauses all future runs.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPauseDialogOpen(false)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              data-ui="scheduled-task-pause-after-run"
              onClick={() => pauseRunningTask('finish')}
              disabled={updateMutation.isPending}
            >
              Let it finish
            </Button>
            <Button
              variant="destructive"
              data-ui="scheduled-task-stop-and-pause"
              onClick={() => pauseRunningTask('stop')}
              disabled={updateMutation.isPending}
            >
              Stop now and pause
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
