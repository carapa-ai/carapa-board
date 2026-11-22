import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import type { Task } from '@/types';

/** Extra stages the task has saved; an optimistic edit's camelCase field wins. */
export function taskCoStages(
  task: Pick<Task, 'coStages' | 'co_stages'>,
): string[] {
  return (task.coStages !== undefined ? task.coStages : task.co_stages) ?? [];
}

/** Selected extras in pipeline order (the order of `options`), without duplicates. */
export function coStagesPayload(
  selected: readonly string[],
  options: readonly string[],
): string[] {
  return options.filter((id) => selected.includes(id));
}

interface CoStageSelectProps {
  /** Review/testing alternatives the project offers, in pipeline order. */
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Extra stages cannot change while the task is running or queued for a slot (the server rejects it). */
  disabled?: boolean;
}

/** "Also run": choose which review/testing alternatives run for this task. */
export function CoStageSelect({
  options,
  selected,
  onChange,
  disabled = false,
}: CoStageSelectProps) {
  if (options.length === 0) return null;

  const toggle = (id: string, checked: boolean) =>
    onChange(
      coStagesPayload(
        checked ? [...selected, id] : selected.filter((item) => item !== id),
        options,
      ),
    );

  return (
    <div
      data-ui="co-stage-select"
      className="space-y-1.5 rounded-md border border-border bg-muted/20 p-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs font-medium">Also run</span>
        {options.map((id) => (
          <label
            key={id}
            data-ui="co-stage-option"
            data-stage-id={id}
            className="flex items-center gap-1.5 text-xs"
          >
            <Checkbox
              checked={selected.includes(id)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(id, checked === true)}
              aria-label={`Also run ${id}`}
            />
            {id}
          </label>
        ))}
      </div>
      {disabled && (
        <p
          data-ui="co-stage-select-reason"
          className="text-[11px] text-muted-foreground"
        >
          Extra stages can&apos;t be changed while the task is running or
          queued.
        </p>
      )}
    </div>
  );
}

/** Board-card badges for a task's extra stages; nothing when it has none. */
export function CoStageCardBadges({
  task,
}: {
  task: Pick<Task, 'id' | 'coStages' | 'co_stages'>;
}) {
  const coStages = taskCoStages(task);
  if (coStages.length === 0) return null;
  return (
    <div
      data-ui="task-co-stage-metadata"
      data-task-id={task.id}
      className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden"
    >
      {coStages.map((id) => (
        <Badge
          key={id}
          variant="outline"
          data-ui="task-co-stage-badge"
          data-stage-id={id}
          title={`Also runs ${id}`}
          className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
        >
          +{id}
        </Badge>
      ))}
    </div>
  );
}
