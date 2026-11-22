import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Project, ProjectModeStatuses } from '@/types';
import { ProjectActionsMenu } from './project-actions-menu';

/**
 * The current project's name as a menu button (▾). It opens the same
 * {@link ProjectActionsMenu} as the sidebar rows' "…" buttons, so the open
 * project is two clicks from Share and Project settings even when the sidebar
 * is collapsed or the mobile drawer is closed.
 */
export function ProjectTitleMenu({
  project,
  fallbackName,
  statuses,
  className,
}: {
  project: Project | undefined;
  /** Shown as plain text until the project has loaded. */
  fallbackName: string;
  statuses?: ProjectModeStatuses;
  className?: string;
}) {
  const titleRef = useRef<HTMLSpanElement>(null);
  if (!project) {
    return (
      <span data-ui="global-sidebar-title" className="truncate">
        {fallbackName}
      </span>
    );
  }
  return (
    <ProjectActionsMenu
      project={project}
      statuses={statuses}
      align="start"
      trigger={
        <Tooltip content={project.name} whenClipped={titleRef} side="bottom">
          <button
            type="button"
            data-ui="project-title-menu-trigger"
            className={cn(
              'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 md:min-h-8',
              className,
            )}
          >
            <span
              ref={titleRef}
              data-ui="global-sidebar-title"
              className="truncate"
            >
              {project.name}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        </Tooltip>
      }
    />
  );
}
