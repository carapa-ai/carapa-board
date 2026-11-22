import { memo } from 'react';
import {
  Archive,
  ArchiveRestore,
  Clock,
  Pause,
  Pencil,
  Play,
  Trash2,
  PlayCircle,
  MoreHorizontal,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/confirm-dialog';
import { cn, formatRelativeTime } from '@/lib/utils';
import {
  useUpdateCronjob,
  useDeleteCronjob,
  useRunCronjob,
} from '@/hooks/use-cronjobs';
import { useWallClockRefresh } from '@/hooks/use-wall-clock-refresh';
import { useStore } from '@/store';
import type { Cronjob, ObjectiveStatus } from '@/types';
import { ObjectiveMarker } from './objective-marker';
import { RuntimeOverrideBadges } from './runtime-override-badges';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface CronjobCardProps {
  cronjob: Cronjob;
  project_id: string;
  objectiveTitle?: string;
  objectiveStatus?: ObjectiveStatus;
}

export const CronjobCard = memo(function CronjobCard({
  cronjob,
  project_id,
  objectiveTitle,
  objectiveStatus,
}: CronjobCardProps) {
  const updateMutation = useUpdateCronjob(project_id);
  const deleteMutation = useDeleteCronjob(project_id);
  const runMutation = useRunCronjob(project_id);
  const setEditCronjobId = useStore((s) => s.setEditCronjobId);

  const isPaused = cronjob.status === 'paused';
  const isArchived = cronjob.archived ?? false;
  const nextRunIsFuture =
    Boolean(cronjob.next_run) &&
    new Date(cronjob.next_run!).getTime() > Date.now();
  useWallClockRefresh(nextRunIsFuture && !isPaused);

  const toggleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateMutation.mutate({
      cronjob_id: cronjob.id,
      data: { status: isPaused ? 'active' : 'paused' },
    });
  };

  const archive = () => {
    updateMutation.mutate({
      cronjob_id: cronjob.id,
      data: { archived: true },
    });
  };

  const restore = () => {
    updateMutation.mutate({
      cronjob_id: cronjob.id,
      data: { archived: false },
    });
  };

  const isAlwaysQueue = cronjob.queue_mode === 'always';
  const queueModeLabel = isAlwaysQueue ? 'always' : 'if empty';
  const nextQueueModeLabel = isAlwaysQueue ? 'if empty' : 'always';

  const toggleQueueMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateMutation.mutate({
      cronjob_id: cronjob.id,
      data: { queue_mode: isAlwaysQueue ? 'if_empty' : 'always' },
    });
  };

  const remove = async () => {
    const confirmed = await confirmAction('This cannot be undone.', {
      title: `Delete "${cronjob.title}"?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    deleteMutation.mutate(cronjob.id);
  };

  const handleRunNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    runMutation.mutate(cronjob.id);
  };

  return (
    <Card
      data-ui="cronjob-card"
      data-cronjob-id={cronjob.id}
      className={cn(
        'border-dashed border-2 min-w-[200px] max-w-[260px] flex-shrink-0 transition-all overflow-hidden',
        isArchived
          ? 'border-muted-foreground/20 opacity-50'
          : isPaused
            ? 'border-muted-foreground/30 opacity-60'
            : 'border-primary/40',
      )}
    >
      <CardContent className="py-3 px-1.5 space-y-2 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <Clock className="size-3.5 flex-shrink-0 text-primary" />
            <ObjectiveMarker
              objectiveId={cronjob.objective_id}
              objectiveTitle={objectiveTitle}
              objectiveStatus={objectiveStatus}
            />
            <h4 className="text-sm font-medium leading-tight min-w-0 flex-1 truncate">
              {cronjob.title}
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
                  setEditCronjobId(cronjob.id);
                }}
              >
                <Pencil className="size-3" />
              </Button>
            )}
            {!isArchived && (
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
            {!isArchived && (
              <Button
                variant="ghost"
                size="icon-xs"
                title="Run Now"
                onClick={handleRunNow}
                disabled={runMutation.isPending}
                className="text-primary hover:text-primary/80"
              >
                <PlayCircle className="size-3" />
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

        <code className="text-[11px] text-muted-foreground font-mono block break-all whitespace-pre-wrap">
          {cronjob.cron_expression}
        </code>

        <div className="flex items-center gap-1.5 flex-wrap">
          {isPaused && (
            <Badge
              data-ui="cronjob-paused-badge"
              variant="outline"
              className="text-[10px] h-4 px-1 border-muted-foreground/40 text-muted-foreground"
            >
              Paused
            </Badge>
          )}
          <Badge asChild variant="outline">
            <button
              type="button"
              data-ui="cronjob-queue-mode-toggle"
              aria-label={`Queue mode: ${queueModeLabel}. Switch to ${nextQueueModeLabel}`}
              title={`Queue mode: ${queueModeLabel}. Click to switch to ${nextQueueModeLabel}`}
              disabled={updateMutation.isPending}
              onClick={toggleQueueMode}
              className={cn(
                'text-[10px] h-4 px-1 cursor-pointer select-none disabled:cursor-not-allowed disabled:opacity-50',
                isAlwaysQueue
                  ? 'border-primary/50'
                  : 'border-orange-600 dark:border-orange-500/50',
              )}
            >
              {isAlwaysQueue ? 'Always' : 'If empty'}
            </button>
          </Badge>
          <RuntimeOverrideBadges
            projectId={project_id}
            runtimeSelection={cronjob.runtimeSelection}
            runtimeSelectionStage={cronjob.runtimeSelectionStage}
            agentName={cronjob.agent_name}
            model={cronjob.model}
          />
          {nextRunIsFuture && !isPaused && (
            <span
              data-ui="cronjob-next-run"
              className="text-[10px] text-muted-foreground ml-auto"
              title={cronjob.next_run}
            >
              next {formatRelativeTime(cronjob.next_run!)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
});
