import { CornerLeftUp, FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import {
  isAbParent,
  taskAbParentId,
  taskAbVariants,
  taskStageVariant,
  variantLabel,
} from '@/lib/ab';
import { findStage } from '@/lib/stages';
import type { StageDefinition, TaskSummary } from '@/types';

interface AbCardBadgesProps {
  task: TaskSummary;
  /** Every task of the project, to find the parent or the variant cards. */
  tasks: TaskSummary[];
  stages: StageDefinition[];
  onOpenTask: (taskId: string) => void;
}

/**
 * Experiment markers for a board card: a variant badge and parent link on a
 * variant card, an "A/B n/m done" badge on the experiment parent, and a plain
 * variant badge on a card that runs on a stage alternative.
 */
export function AbCardBadges({
  task,
  tasks,
  stages,
  onOpenTask,
}: AbCardBadgesProps) {
  const parentId = taskAbParentId(task);
  if (parentId) {
    const parent = tasks.find((candidate) => candidate.id === parentId);
    const label = variantLabel(taskStageVariant(task) ?? '?');
    return (
      <div
        data-ui="task-ab-metadata"
        data-task-id={task.id}
        className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
      >
        <Badge
          variant="outline"
          data-ui="task-ab-variant-badge"
          title={`Variant ${label} of an A/B experiment`}
          className="h-4 gap-1 border-primary/40 px-1 text-[10px] font-semibold text-primary"
        >
          <FlaskConical className="size-2.5" />
          {label}
        </Badge>
        <button
          type="button"
          data-ui="task-ab-parent-link"
          data-parent-task-id={parentId}
          title={parent ? `Open ${parent.title}` : 'Open the A/B parent'}
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenTask(parentId);
          }}
        >
          <CornerLeftUp className="size-2.5 shrink-0" />
          <span className="truncate">{parent?.title ?? parentId}</span>
        </button>
      </div>
    );
  }

  if (!isAbParent(task)) {
    const stageVariant = taskStageVariant(task);
    if (!stageVariant) return null;
    const label = variantLabel(stageVariant);
    return (
      <div
        data-ui="task-ab-metadata"
        data-task-id={task.id}
        className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
      >
        <Tooltip
          content={`Runs on variant ${label} stage alternatives`}
          redundant={false}
        >
          <Badge
            variant="outline"
            data-ui="task-stage-variant-badge"
            className="h-4 border-primary/40 px-1 text-[10px] font-semibold text-primary"
          >
            {label}
          </Badge>
        </Tooltip>
      </div>
    );
  }
  const children = tasks.filter(
    (candidate) => taskAbParentId(candidate) === task.id,
  );
  // Before the fork there are no cards yet; the selected variants are the total.
  const total = children.length || taskAbVariants(task).length;
  const done = children.filter(
    (child) => findStage(stages, child.status)?.type === 'done',
  ).length;
  return (
    <div
      data-ui="task-ab-metadata"
      data-task-id={task.id}
      className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
    >
      <Badge
        variant="outline"
        data-ui="task-ab-progress-badge"
        className="h-4 gap-1 border-primary/40 px-1 text-[10px] text-primary"
        title="Variant cards that reached done"
      >
        <FlaskConical className="size-2.5" />
        A/B {done}/{total} done
      </Badge>
    </div>
  );
}
