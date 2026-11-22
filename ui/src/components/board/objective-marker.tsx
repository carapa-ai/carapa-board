import { Target } from 'lucide-react';
import type { ObjectiveStatus } from '@/types';

interface ObjectiveMarkerProps {
  objectiveId?: string | null;
  objectiveTitle?: string;
  objectiveStatus?: ObjectiveStatus;
}

/** Compact ownership marker shared by task and automation cards. */
export function ObjectiveMarker({
  objectiveId,
  objectiveTitle,
  objectiveStatus,
}: ObjectiveMarkerProps) {
  if (!objectiveId) return null;

  // The queue only auto-starts tasks of an active objective.
  const held = objectiveStatus !== undefined && objectiveStatus !== 'active';
  const label = objectiveTitle || objectiveId;

  return (
    <span
      className={`inline-flex flex-shrink-0 ${held ? 'text-amber-600 dark:text-amber-500' : 'text-cyan-600 dark:text-cyan-500'}`}
      title={
        held
          ? `${label} (${objectiveStatus}) — its work will not start automatically`
          : label
      }
      aria-label={
        held ? `Objective: ${label}, ${objectiveStatus}` : `Objective: ${label}`
      }
      data-ui="objective-marker"
      data-objective-held={held ? 'true' : undefined}
    >
      <Target className="size-3.5" />
    </span>
  );
}
