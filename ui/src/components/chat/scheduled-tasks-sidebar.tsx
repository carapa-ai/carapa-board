import { memo, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CalendarClock,
  Pause,
  Play,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/confirm-dialog';
import { cn, formatRelativeTime } from '@/lib/utils';
import { formatScheduledTaskCadence } from '@/lib/scheduled-task-format';
import {
  useScheduledTasks,
  useUpdateScheduledTask,
  useDeleteScheduledTask,
} from '@/hooks/use-scheduled-tasks';
import type { ScheduledTask } from '@/types';
import { ScheduledTaskDetailsDialog } from '@/components/scheduled-task-details-dialog';

function statusColor(status: ScheduledTask['status']) {
  if (status === 'active') return 'text-sky-700 dark:text-sky-500';
  if (status === 'paused') return 'text-muted-foreground';
  return 'text-muted-foreground/50';
}

// ─── Single task row ────────────────────────────────────────────────────────

interface TaskRowProps {
  task: ScheduledTask;
  project_id: string;
  selected: boolean;
  task_id: string;
  onSelect: (id: string) => void;
}

const TaskRow = memo(function TaskRow({
  task,
  project_id,
  selected,
  task_id,
  onSelect,
}: TaskRowProps) {
  const update = useUpdateScheduledTask(project_id);
  const remove = useDeleteScheduledTask(project_id);
  const paused = task.status === 'paused';
  return (
    <div className="border-b border-border/40 last:border-0">
      <div
        data-ui="scheduled-task-sidebar-row"
        data-task-id={task.id}
        className={cn(
          'w-full text-left px-3 py-1.5 flex items-start gap-1.5 hover:bg-muted/60 transition-colors',
          selected && 'bg-muted/60',
        )}
        onClick={() => onSelect(task_id)}
      >
        <button
          type="button"
          data-ui="scheduled-task-details-trigger"
          aria-label={`Open scheduled task: ${task.prompt}`}
          className="min-w-0 flex-1 flex items-start gap-1.5 text-left"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(task_id);
          }}
        >
          <CalendarClock
            className={cn(
              'size-3 mt-0.5 flex-shrink-0',
              statusColor(task.status),
            )}
          />
          <div className="min-w-0 flex-1">
            <p
              className="text-[11px] font-medium truncate leading-tight"
              title={task.prompt}
            >
              {task.prompt}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {task.running && (
                <div
                  data-ui="scheduled-task-sidebar-running-marker"
                  className="size-1.5 rounded-full animate-pulse flex-shrink-0 bg-sky-600 dark:bg-sky-500"
                  title="Running"
                />
              )}
              <span className="text-[10px] text-muted-foreground font-mono">
                {formatScheduledTaskCadence(task)}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] h-3.5 px-1 leading-none',
                  task.status === 'active' &&
                    'border-sky-600/60 text-sky-700 dark:border-sky-500/50 dark:text-sky-600',
                  task.status === 'paused' &&
                    'border-muted-foreground/40 text-muted-foreground',
                  task.status === 'completed' &&
                    'border-muted-foreground/20 text-muted-foreground/50',
                )}
              >
                {task.status}
              </Badge>
              {task.nextRun &&
                task.status === 'active' &&
                new Date(task.nextRun).getTime() > Date.now() && (
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeTime(task.nextRun)}
                  </span>
                )}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1">
          {task.status !== 'completed' && (
            <Button
              data-ui="scheduled-task-sidebar-status"
              aria-label={
                paused ? 'Resume scheduled task' : 'Pause scheduled task'
              }
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={update.isPending}
              onClick={(event) => {
                event.stopPropagation();
                update.mutate({
                  scheduled_task_id: task.id,
                  data: { status: paused ? 'active' : 'paused' },
                });
              }}
            >
              {paused ? (
                <Play className="size-3" />
              ) : (
                <Pause className="size-3" />
              )}
            </Button>
          )}
          <Button
            data-ui="scheduled-task-sidebar-delete"
            aria-label="Delete scheduled task"
            variant="ghost"
            size="icon"
            className="size-6 text-destructive"
            disabled={remove.isPending}
            onClick={async (event) => {
              event.stopPropagation();
              const confirmed = await confirmAction('This cannot be undone.', {
                title: 'Delete this scheduled task?',
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (!confirmed) return;
              remove.mutate(task.id);
            }}
          >
            <Trash2 className="size-3" />
          </Button>
          {selected ? (
            <ChevronDown className="size-3 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground" />
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Main section component ──────────────────────────────────────────────────

interface ScheduledTasksSidebarSectionProps {
  project_id: string;
}

export function ScheduledTasksSidebarSection({
  project_id,
}: ScheduledTasksSidebarSectionProps) {
  const storageKey = `chat-scheduled-tasks-expanded-${project_id}`;

  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: tasks = [] } = useScheduledTasks(project_id, {
    refetchInterval: 60_000,
  });

  const toggleExpanded = () => {
    setExpanded((v) => {
      const next = !v;
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // ignore
      }
      if (!next) setSelectedId(null);
      return next;
    });
  };

  const handleSelectTask = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  return (
    <div className="border-t border-border flex-shrink-0">
      {/* Header / toggle */}
      <button
        data-ui="scheduled-tasks-sidebar-toggle"
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 px-3 py-2 hover:bg-muted/60 transition-colors text-left"
        onClick={toggleExpanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium text-muted-foreground flex-1">
          Scheduled Tasks
        </span>
        {tasks.length > 0 && (
          <Badge
            variant="secondary"
            className="text-[10px] h-4 px-1.5 leading-none"
          >
            {tasks.length}
          </Badge>
        )}
      </button>

      {/* Expanded list */}
      {expanded && (
        <div className="border-t border-border/40">
          {tasks.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-muted-foreground">
              No scheduled tasks.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  project_id={project_id}
                  selected={selectedId === task.id}
                  task_id={task.id}
                  onSelect={handleSelectTask}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <ScheduledTaskDetailsDialog
        project_id={project_id}
        task={tasks.find((task) => task.id === selectedId) ?? null}
        open={selectedId !== null}
        onOpenChange={(open) => !open && setSelectedId(null)}
      />
    </div>
  );
}
