import { memo } from 'react';
import {
  Archive,
  ArchiveRestore,
  Database,
  Pause,
  Pencil,
  Play,
  Trash2,
  PlayCircle,
  CheckCircle2,
  RotateCcw,
  MoreHorizontal,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useUpdateDatasetTask,
  useDeleteDatasetTask,
  useRunDatasetTask,
  useRestartDatasetTask,
} from '@/hooks/use-dataset-tasks';
import { useStore } from '@/store';
import type { DatasetTask, ObjectiveStatus } from '@/types';
import { ObjectiveMarker } from './objective-marker';
import { RuntimeOverrideBadges } from './runtime-override-badges';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { confirmAction } from '@/components/confirm-dialog';

interface DatasetTaskCardProps {
  datasetTask: DatasetTask;
  project_id: string;
  objectiveTitle?: string;
  objectiveStatus?: ObjectiveStatus;
}

export const DatasetTaskCard = memo(function DatasetTaskCard({
  datasetTask,
  project_id,
  objectiveTitle,
  objectiveStatus,
}: DatasetTaskCardProps) {
  const updateMutation = useUpdateDatasetTask(project_id);
  const deleteMutation = useDeleteDatasetTask(project_id);
  const runMutation = useRunDatasetTask(project_id);
  const restartMutation = useRestartDatasetTask(project_id);
  const setEditDatasetTaskId = useStore((s) => s.setEditDatasetTaskId);

  const isPaused = datasetTask.status === 'paused';
  const isCompleted = datasetTask.status === 'completed';
  const isArchived = datasetTask.archived ?? false;
  const progress =
    datasetTask.total_rows > 0
      ? Math.round((datasetTask.completed_rows / datasetTask.total_rows) * 100)
      : 0;

  const toggleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateMutation.mutate({
      dataset_task_id: datasetTask.id,
      data: { status: isPaused ? 'active' : 'paused' },
    });
  };

  const remove = async () => {
    const confirmed = await confirmAction('This cannot be undone.', {
      title: `Delete "${datasetTask.title}"?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    deleteMutation.mutate(datasetTask.id);
  };

  const handleRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    runMutation.mutate(datasetTask.id);
  };

  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const rows = datasetTask.total_rows;
    const confirmed = await confirmAction(
      `Progress counters (${datasetTask.completed_rows} / ${rows} rows) will reset and all ${rows} row${rows !== 1 ? 's' : ''} will be re-run.`,
      {
        title: `Restart "${datasetTask.title}" from the beginning?`,
        confirmLabel: 'Restart',
      },
    );
    if (!confirmed) return;
    restartMutation.mutate(datasetTask.id);
  };

  const archive = () => {
    updateMutation.mutate({
      dataset_task_id: datasetTask.id,
      data: { archived: true },
    });
  };

  const restore = () => {
    updateMutation.mutate({
      dataset_task_id: datasetTask.id,
      data: { archived: false },
    });
  };

  // Extract placeholders from description
  const placeholders = [
    ...new Set(
      (datasetTask.description.match(/\{\{(\w+)\}\}/g) || []).map((m) =>
        m.slice(2, -2),
      ),
    ),
  ];

  return (
    <Card
      className={cn(
        'border-dashed border-2 min-w-[200px] max-w-[260px] flex-shrink-0 transition-all overflow-hidden',
        isArchived
          ? 'border-muted-foreground/20 opacity-50'
          : isCompleted
            ? 'border-green-600 opacity-70 dark:border-green-500/40'
            : isPaused
              ? 'border-muted-foreground/30 opacity-60'
              : 'border-purple-600 dark:border-purple-500/40',
      )}
    >
      <CardContent className="py-3 px-1.5 space-y-2 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {isCompleted ? (
              <CheckCircle2 className="size-3.5 flex-shrink-0 text-green-600 dark:text-green-500" />
            ) : (
              <Database className="size-3.5 flex-shrink-0 text-purple-600 dark:text-purple-500" />
            )}
            <ObjectiveMarker
              objectiveId={datasetTask.objective_id}
              objectiveTitle={objectiveTitle}
              objectiveStatus={objectiveStatus}
            />
            <h4 className="text-sm font-medium leading-tight min-w-0 flex-1 truncate">
              {datasetTask.title}
            </h4>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {!isArchived && (
              <Button
                variant="ghost"
                size="icon-xs"
                title="Edit"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditDatasetTaskId(datasetTask.id);
                }}
              >
                <Pencil className="size-3" />
              </Button>
            )}
            {!isArchived && !isCompleted && (
              <>
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
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Run"
                  onClick={handleRun}
                  disabled={runMutation.isPending}
                  className="text-purple-600 hover:text-purple-600/80 dark:text-purple-500 dark:hover:text-purple-500/80"
                >
                  <PlayCircle className="size-3" />
                </Button>
              </>
            )}
            {!isArchived && (isCompleted || datasetTask.completed_rows > 0) && (
              <Button
                variant="ghost"
                size="icon-xs"
                title="Restart from beginning"
                onClick={handleRestart}
                disabled={restartMutation.isPending}
                className="text-orange-700 hover:text-orange-700/80 dark:text-orange-500 dark:hover:text-orange-500/80"
              >
                <RotateCcw className="size-3" />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="More automation actions"
                  aria-label="More automation actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                {isArchived ? (
                  <DropdownMenuItem
                    onSelect={restore}
                    disabled={updateMutation.isPending}
                  >
                    <ArchiveRestore />
                    Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onSelect={archive}
                    disabled={updateMutation.isPending}
                  >
                    <Archive />
                    Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={remove}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {datasetTask.completed_rows} / {datasetTask.total_rows} rows
            </span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                isCompleted
                  ? 'bg-green-700 dark:bg-green-500'
                  : 'bg-purple-600 dark:bg-purple-500',
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {isPaused && (
            <Badge
              data-ui="dataset-task-paused-badge"
              variant="outline"
              className="text-[10px] h-4 px-1 border-muted-foreground/40 text-muted-foreground"
            >
              Paused
            </Badge>
          )}
          {placeholders.length > 0 &&
            placeholders.slice(0, 3).map((p) => (
              <Badge
                key={p}
                variant="outline"
                className="text-[10px] h-4 px-1 border-purple-600 dark:border-purple-500/30"
              >
                {`{{${p}}}`}
              </Badge>
            ))}
          {placeholders.length > 3 && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">
              +{placeholders.length - 3}
            </Badge>
          )}
          <RuntimeOverrideBadges
            projectId={project_id}
            runtimeSelection={datasetTask.runtimeSelection}
            runtimeSelectionStage={datasetTask.runtimeSelectionStage}
            agentName={datasetTask.agent_name}
            model={datasetTask.model}
          />
        </div>
      </CardContent>
    </Card>
  );
});
