import { Badge } from '@/components/ui/badge';
import { useProjects } from '@/hooks/use-projects';
import { useResolveRuntimeSelectionLabel } from '@/lib/agents';
import { findStage, getEffectiveProjectStages } from '@/lib/stages';
import type { RuntimeSelection } from '@/types';

const BADGE_CLASS = 'text-[10px] h-4 px-1 min-w-0 max-w-full shrink truncate';

interface RuntimeOverrideBadgesProps {
  projectId: string;
  runtimeSelection?: RuntimeSelection | null;
  /** Base stage the override is limited to; null/unset applies to all stages. */
  runtimeSelectionStage?: string | null;
  agentName?: string | null;
  model?: string | null;
}

/**
 * Runtime badges for cronjob and dataset-task cards: the structured runtime
 * override when set, otherwise the legacy agent name and model.
 */
export function RuntimeOverrideBadges({
  projectId,
  runtimeSelection,
  runtimeSelectionStage,
  agentName,
  model,
}: RuntimeOverrideBadgesProps) {
  const resolveRuntimeSelectionLabel = useResolveRuntimeSelectionLabel();
  const { data: projects } = useProjects();

  if (runtimeSelection) {
    const stageTitle = runtimeSelectionStage
      ? (findStage(
          getEffectiveProjectStages(projects?.find((p) => p.id === projectId)),
          runtimeSelectionStage,
        )?.title ?? runtimeSelectionStage)
      : null;
    const label = resolveRuntimeSelectionLabel(runtimeSelection);
    return (
      <Badge
        variant="outline"
        data-ui="runtime-override-badge"
        className={BADGE_CLASS}
      >
        {stageTitle ? `${label} (${stageTitle})` : label}
      </Badge>
    );
  }

  return (
    <>
      {agentName && (
        <Badge variant="outline" className={BADGE_CLASS}>
          {agentName}
        </Badge>
      )}
      {model && (
        <Badge variant="outline" className={BADGE_CLASS}>
          {model}
        </Badge>
      )}
    </>
  );
}
