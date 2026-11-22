import { useRef } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { resolveRuntimeSelectionLabel } from '@/lib/agents';
import type { RuntimeCatalog } from '@/lib/api';
import type { RuntimeSelection } from '@/types';

interface StageRuntimeLabelProps {
  selection?: RuntimeSelection | null;
  catalog?: RuntimeCatalog;
}

/**
 * Compact "Harness · Model · reasoning" label for a stage's runtime override.
 * Renders nothing when the stage has no override.
 */
export function StageRuntimeLabel({
  selection,
  catalog,
}: StageRuntimeLabelProps) {
  const ref = useRef<HTMLSpanElement>(null);
  if (!selection) return null;
  const label = [
    resolveRuntimeSelectionLabel(selection, catalog),
    selection.reasoning,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Tooltip content={label} whenClipped={ref}>
      <span
        ref={ref}
        data-ui="stage-runtime-label"
        className="min-w-0 max-w-[55%] shrink truncate text-[11px] text-muted-foreground"
      >
        {label}
      </span>
    </Tooltip>
  );
}
