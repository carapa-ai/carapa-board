import { useId, useMemo } from 'react';
import { Select, SelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useProjects } from '@/hooks/use-projects';
import {
  getActiveExecutionStages,
  getEffectiveProjectStages,
} from '@/lib/stages';
import type { RuntimeSelection } from '@/types';

interface RuntimeStageScopeProps {
  projectId: string;
  /** The control only applies to, and is only shown for, a selected override. */
  runtimeSelection: RuntimeSelection | null;
  /** Base stage the override is limited to; null applies it to all stages. */
  value: string | null;
  onChange: (stageId: string | null) => void;
  dataUi: string;
  disabled?: boolean;
  className?: string;
}

/** Limits a runtime override to one executable stage, or all stages (default). */
export function RuntimeStageScope({
  projectId,
  runtimeSelection,
  value,
  onChange,
  dataUi,
  disabled,
  className,
}: RuntimeStageScopeProps) {
  const id = useId();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const stages = useMemo(
    () => getActiveExecutionStages(getEffectiveProjectStages(project)),
    [project],
  );
  if (!runtimeSelection) return null;

  // A stored stage that is gone still shows, so the user sees why the
  // override does nothing. Not flagged until the project's stages are known.
  const missing = !!value && !!project && !stages.some((s) => s.id === value);

  return (
    <div className={cn('space-y-1', className)} data-ui={dataUi}>
      <label className="text-sm font-medium" htmlFor={id}>
        Apply override to
      </label>
      <Select
        id={id}
        value={value ?? ''}
        onValueChange={(next) => onChange(next || null)}
        disabled={disabled}
        className="w-full"
      >
        <SelectItem value="">All stages</SelectItem>
        {stages.map((stage) => (
          <SelectItem key={stage.id} value={stage.id}>
            {stage.title}
          </SelectItem>
        ))}
        {missing && (
          <SelectItem value={value} disabled>
            {value} (stage no longer exists)
          </SelectItem>
        )}
      </Select>
      <p className="text-xs text-muted-foreground">
        Other stages use their configured runtime.
      </p>
    </div>
  );
}
