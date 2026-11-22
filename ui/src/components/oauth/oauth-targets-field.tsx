import { useMemo } from 'react';
import { Folder, Layers } from 'lucide-react';
import {
  projectTreeOptions,
  type ProjectTreeOption,
} from '@/components/layout/project-picker';
import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import type {
  OAuthAccess,
  OAuthConsentTarget,
  OAuthGrantEntry,
} from '@/lib/api';
import { describeOAuthAccess, describeOAuthTarget } from '@/lib/oauth-display';
import type { Project } from '@/types';

const ACCESS_LEVELS: OAuthAccess[] = ['read', 'write'];

function toProject(target: OAuthConsentTarget): Project {
  return {
    id: target.folder,
    folder: target.folder,
    name: describeOAuthTarget(target, target.name),
    ...(target.parentId && { parentId: target.parentId }),
    ...(target.order !== undefined && { order: target.order }),
    settings: { isParent: target.isParent },
  };
}

interface OAuthTargetsFieldProps {
  /** Projects the user may grant (from the server). */
  options: OAuthConsentTarget[];
  value: OAuthGrantEntry[];
  onChange: (next: OAuthGrantEntry[]) => void;
  disabled?: boolean;
}

/**
 * Project tree with a checkbox and, once ticked, a read/write control per
 * project. Ticking a parent also ticks its direct children (all read-only
 * until raised); the stored list stays exact, so unticking a parent leaves its
 * children alone.
 */
export function OAuthTargetsField({
  options,
  value,
  onChange,
  disabled,
}: OAuthTargetsFieldProps) {
  const tree = useMemo(
    () => projectTreeOptions(options.map(toProject)),
    [options],
  );
  const byFolder = useMemo(
    () => new Map(options.map((option) => [option.folder, option])),
    [options],
  );

  function toggle(option: ProjectTreeOption, checked: boolean) {
    const target = byFolder.get(option.id);
    if (!target) return;
    if (!checked) {
      onChange(value.filter((entry) => entry.folder !== target.folder));
      return;
    }
    if (value.some((entry) => entry.folder === target.folder)) return;
    const added: OAuthGrantEntry[] = [
      { kind: target.kind, folder: target.folder, access: 'read' },
    ];
    if (target.isParent) {
      const selected = new Set(value.map((entry) => entry.folder));
      for (const child of options) {
        if (child.parentId === target.folder && !selected.has(child.folder)) {
          added.push({
            kind: child.kind,
            folder: child.folder,
            access: 'read',
          });
        }
      }
    }
    onChange([...value, ...added]);
  }

  function setAccess(folder: string, access: OAuthAccess) {
    onChange(
      value.map((entry) =>
        entry.folder === folder ? { ...entry, access } : entry,
      ),
    );
  }

  const byEntry = new Map(value.map((entry) => [entry.folder, entry]));

  return (
    <div className="space-y-2" data-ui="oauth-targets-field">
      <ul
        data-ui="oauth-targets-tree"
        className="max-h-72 overflow-y-auto rounded-md border bg-background p-1"
      >
        {tree.map((option) => {
          const target = byFolder.get(option.id);
          const entry = byEntry.get(option.id);
          const name = option.name;
          const Icon = option.settings?.isParent ? Layers : Folder;
          return (
            <li
              key={option.id}
              data-ui="oauth-target-row"
              data-folder={option.id}
              data-selected={entry ? 'true' : 'false'}
              aria-level={option.depth + 1}
              className="flex min-h-9 items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-muted/50"
              style={{ paddingLeft: `${0.5 + option.depth * 1.25}rem` }}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  aria-label={name}
                  checked={!!entry}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    toggle(option, checked === true)
                  }
                />
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
              </label>
              {entry && (
                <Select
                  compact
                  aria-label={`Access for ${name}`}
                  value={entry.access}
                  disabled={disabled}
                  onValueChange={(nextValue) =>
                    setAccess(entry.folder, nextValue as OAuthAccess)
                  }
                >
                  {ACCESS_LEVELS.map((access) => (
                    <SelectItem
                      key={access}
                      value={access}
                      disabled={access === 'write' && !target?.canWrite}
                    >
                      {describeOAuthAccess(access)}
                    </SelectItem>
                  ))}
                </Select>
              )}
            </li>
          );
        })}
      </ul>
      <p
        className="text-xs text-muted-foreground"
        data-ui="oauth-targets-count"
      >
        {value.length} of {options.length} selected
      </p>
      {value.some((entry) => entry.kind === 'main') && (
        <p
          // Translucent amber tint reads on both themes.
          role="note"
          data-ui="oauth-main-reach-note"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
        >
          The main workspace also covers every project you can reach, including
          projects you gain access to later, at the access chosen for it. A
          project listed separately uses its own access instead.
        </p>
      )}
    </div>
  );
}
