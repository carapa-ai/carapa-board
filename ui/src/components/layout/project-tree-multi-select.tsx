import { Folder, Layers } from 'lucide-react';
import { FieldTrigger } from '@/components/ui/select';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProjectTreeOption } from '@/components/layout/project-picker';

interface ProjectTreeMultiSelectProps {
  /** Depth-ordered options from `projectTreeOptions`. */
  options: ProjectTreeOption[];
  selectedIds: readonly string[];
  onToggle: (option: ProjectTreeOption, checked: boolean) => void;
  /** Trigger text while nothing is selected. */
  emptyLabel: string;
  disabled?: boolean;
  dataUi: { trigger: string; content: string; item: string };
}

/**
 * Dropdown of checkable projects in tree order (indented by depth, parents
 * marked with a layers icon). Selection is exact: toggling a parent does not
 * touch its children unless the caller's `onToggle` does.
 */
export function ProjectTreeMultiSelect({
  options,
  selectedIds,
  onToggle,
  emptyLabel,
  disabled,
  dataUi,
}: ProjectTreeMultiSelectProps) {
  const labels = selectedIds.map(
    (id) => options.find((option) => option.id === id)?.name ?? id,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FieldTrigger
          disabled={disabled}
          className="w-full min-w-0"
          data-ui={dataUi.trigger}
          title={labels.join(', ') || emptyLabel}
        >
          <span
            className={
              labels.length > 0
                ? 'min-w-0 flex-1 truncate'
                : 'min-w-0 flex-1 truncate text-muted-foreground'
            }
          >
            {labels.join(', ') || emptyLabel}
          </span>
        </FieldTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 max-w-[var(--radix-dropdown-menu-content-available-width)] overflow-y-auto"
        data-ui={dataUi.content}
      >
        {options.map((candidate) => {
          const Icon = candidate.settings?.isParent ? Layers : Folder;
          return (
            <DropdownMenuCheckboxItem
              key={candidate.id}
              checked={selectedIds.includes(candidate.id)}
              onCheckedChange={(checked) => onToggle(candidate, checked)}
              onSelect={(event) => event.preventDefault()}
              style={{ marginLeft: `${candidate.depth * 1.125}rem` }}
              data-ui={dataUi.item}
              data-project-id={candidate.id}
              aria-level={candidate.depth + 1}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">
                {candidate.name}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
