import { Check, Folder, Layers } from 'lucide-react';
import { FieldTrigger } from '@/components/ui/select';

import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Project } from '@/types';

export interface ProjectTreeOption extends Project {
  depth: number;
}

export function projectTreeOptions(projects: Project[]): ProjectTreeOption[] {
  const knownIds = new Set(projects.map((project) => project.id));
  const sourceIndex = new Map(
    projects.map((project, index) => [project.id, index]),
  );
  const siblings = new Map<string | null, Project[]>();

  for (const project of projects) {
    const parentId =
      project.parentId && knownIds.has(project.parentId)
        ? project.parentId
        : null;
    const group = siblings.get(parentId) ?? [];
    group.push(project);
    siblings.set(parentId, group);
  }

  const configuredOrder = (left: Project, right: Project) => {
    const leftOrder = left.order ?? sourceIndex.get(left.id) ?? 0;
    const rightOrder = right.order ?? sourceIndex.get(right.id) ?? 0;
    return (
      leftOrder - rightOrder ||
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    );
  };
  for (const group of siblings.values()) group.sort(configuredOrder);

  const result: ProjectTreeOption[] = [];
  const visited = new Set<string>();
  const visit = (project: Project, depth: number) => {
    if (visited.has(project.id)) return;
    visited.add(project.id);
    result.push({ ...project, depth });
    for (const child of siblings.get(project.id) ?? []) visit(child, depth + 1);
  };

  for (const root of siblings.get(null) ?? []) visit(root, 0);
  // Retain malformed or cyclic records instead of silently dropping them.
  for (const project of projects) visit(project, 0);
  return result;
}

interface ProjectPickerProps {
  projects: Project[];
  value: string;
  onValueChange: (value: string) => void;
  allowedProjectIds?: ReadonlySet<string>;
  excludedProjectIds?: ReadonlySet<string>;
  emptyOption?: { label: string; value: string };
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  size?: 'sm' | 'default';
  id?: string;
  'aria-label'?: string;
  'data-ui'?: string;
  /**
   * Opt-in per-project badge text (keyed by project id), rendered as a
   * small text badge next to the item label. Only non-empty values render,
   * so callers pass an empty record (or omit the prop) for unaffected
   * usages.
   */
  badges?: Readonly<Record<string, string>>;
}

export function ProjectPicker({
  projects,
  value,
  onValueChange,
  allowedProjectIds,
  excludedProjectIds,
  emptyOption,
  placeholder = 'Select project',
  disabled,
  className,
  contentClassName,
  size = 'default',
  id,
  'aria-label': ariaLabel,
  'data-ui': dataUi = 'project-picker',
  badges,
}: ProjectPickerProps) {
  const options = projectTreeOptions(projects).filter(
    (project) =>
      (!allowedProjectIds || allowedProjectIds.has(project.id)) &&
      !excludedProjectIds?.has(project.id),
  );
  const selected = options.find((project) => project.id === value);
  const selectedLabel =
    selected?.name ||
    (emptyOption?.value === value ? emptyOption.label : undefined) ||
    placeholder;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <FieldTrigger
          id={id}
          aria-label={ariaLabel}
          data-ui={dataUi}
          compact={size === 'sm'}
          className={cn('min-w-0', className)}
        >
          <span className="truncate">{selectedLabel}</span>
        </FieldTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn(
          'max-h-80 w-[var(--radix-dropdown-menu-trigger-width)] min-w-56',
          contentClassName,
        )}
      >
        {emptyOption && (
          <DropdownMenuItem onSelect={() => onValueChange(emptyOption.value)}>
            <span className="min-w-0 flex-1 truncate">{emptyOption.label}</span>
            {value === emptyOption.value && (
              <Check className="size-3.5 text-primary" />
            )}
          </DropdownMenuItem>
        )}
        {options.map((project) => {
          const Icon = project.settings?.isParent ? Layers : Folder;
          return (
            <DropdownMenuItem
              key={project.id}
              data-project-id={project.id}
              onSelect={() => onValueChange(project.id)}
              style={{ paddingLeft: `${0.5 + project.depth * 1.125}rem` }}
            >
              <Icon
                className={cn(
                  'size-3.5',
                  project.settings?.isParent
                    ? 'text-violet-600 dark:text-violet-400'
                    : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {(badges?.[project.id] ?? '').trim() ? (
                <Badge
                  // Translucent amber fill reads on both themes; border/text tones are theme-swapped.
                  className="border-amber-600/40 bg-amber-500/10 text-amber-700 dark:border-amber-500/30 dark:text-amber-300"
                >
                  {badges?.[project.id]}
                </Badge>
              ) : null}
              {project.id === value && (
                <Check className="size-3.5 text-primary" />
              )}
            </DropdownMenuItem>
          );
        })}
        {!emptyOption && options.length === 0 && (
          <DropdownMenuItem disabled>No projects available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
