import { useCallback, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  CloudOff,
  ExternalLink,
  EyeOff,
  LayoutGrid,
  Link2,
  MessageSquare,
  PowerOff,
  Settings,
  Share2,
  Target,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUpdateProjectMode } from '@/hooks/use-projects';
import {
  availableProjectModes,
  resolveProjectMode,
  type ModeAvailabilityConfig,
} from '@/lib/modes';
import { toast } from 'sonner';
import { loadProjectSettingsDialog } from './project-dialogs-host';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useStore } from '@/store';
import type { Project, ProjectMode, ProjectModeStatuses } from '@/types';
import { useAppConfig } from '@/hooks/use-app-config';

export const PROJECT_MODE_STATUS_DEFINITIONS = [
  { mode: 'chat', label: 'Chat', icon: MessageSquare },
  { mode: 'kanban', label: 'Kanban', icon: LayoutGrid },
  { mode: 'objectives', label: 'Objectives', icon: Target },
] as const;

export const MODE_STATE_LABEL = {
  working: 'working',
  finished: 'finished',
} as const;

export function resolveEnabledModes(
  project: Project,
  config: ModeAvailabilityConfig | undefined,
): Record<ProjectMode, boolean> {
  const available = availableProjectModes(project, config);
  return {
    kanban: available.includes('kanban'),
    chat: available.includes('chat'),
    objectives: available.includes('objectives'),
  };
}

export type ProjectTarget =
  | {
      to: '/objective/$projectId/$objectiveId';
      params: { projectId: string; objectiveId: string };
    }
  | {
      to: '/objectives/$projectId' | '/chat/$projectId' | '/board/$projectId';
      params: { projectId: string };
    };

/**
 * Where a project's name takes you right now: its resolved mode (allowed for the
 * project AND enabled at the backend), or the open objective for objectives.
 * While the config is loading it falls back to the saved/preferred mode; the
 * route guard redirects if needed once the config arrives.
 */
export function useProjectTarget(project: Project): ProjectTarget {
  const { data: config } = useAppConfig();
  const activeObjectiveId = useStore(
    (state) => state.activeObjectiveByProject[project.id] ?? null,
  );
  const enabledModeList = project.settings?.enabledModes ?? ['kanban', 'chat'];
  const mode =
    resolveProjectMode(project, config) ??
    project.settings?.mode ??
    (enabledModeList.includes('kanban')
      ? 'kanban'
      : enabledModeList[0] || 'chat');
  const params = { projectId: project.id };
  if (mode === 'objectives') {
    return activeObjectiveId
      ? {
          to: '/objective/$projectId/$objectiveId',
          params: { ...params, objectiveId: activeObjectiveId },
        }
      : { to: '/objectives/$projectId', params };
  }
  return {
    to: mode === 'chat' ? '/chat/$projectId' : '/board/$projectId',
    params,
  };
}

function projectTargetHref(target: ProjectTarget): string {
  const params: Record<string, string> = target.params;
  return target.to.replace(/\$(\w+)/g, (_, key: string) =>
    encodeURIComponent(params[key]),
  );
}

/** Switch a project to a mode and open that mode's view. */
function useSelectProjectMode(projectId: string) {
  const navigate = useNavigate();
  const updateMode = useUpdateProjectMode(projectId);
  const activeObjectiveId = useStore(
    (state) => state.activeObjectiveByProject[projectId] ?? null,
  );
  return useCallback(
    (mode: ProjectMode) => {
      updateMode.mutate(mode);
      if (mode === 'objectives' && activeObjectiveId) {
        navigate({
          to: '/objective/$projectId/$objectiveId',
          params: { projectId, objectiveId: activeObjectiveId },
        });
        return;
      }
      const to =
        mode === 'chat'
          ? '/chat/$projectId'
          : mode === 'objectives'
            ? '/objectives/$projectId'
            : '/board/$projectId';
      navigate({ to, params: { projectId } });
    },
    [activeObjectiveId, navigate, projectId, updateMode],
  );
}

/**
 * The one project menu: open a project in a mode (with each mode's status),
 * share it, or open its settings. Used by every sidebar row's "…" button and by
 * the current-project title, so both always offer the same actions. Share and
 * settings are store-driven dialogs mounted once at the app root, so they open
 * for any project from any page.
 */
export function ProjectActionsMenu({
  project,
  statuses,
  sandboxDown,
  onHideFromList,
  trigger,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  align = 'end',
}: {
  project: Project;
  statuses?: ProjectModeStatuses;
  /** The project's sandbox is not running; shows a label at the top. */
  sandboxDown?: boolean;
  /** When set, the menu offers "Hide from list" (collapsed sidebar list only). */
  onHideFromList?: () => void;
  /** The button that opens the menu (rendered with `asChild`). */
  trigger: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChangeProp ?? setOpenState;
  const onOpenChange = (next: boolean) => {
    // Settings is a lazy chunk: start loading it as soon as a menu opens, so
    // choosing "Project settings" does not wait on the network.
    if (next) void loadProjectSettingsDialog().catch(() => {});
    setOpen(next);
  };
  // Share/Settings open once the menu has closed and focus is back on the
  // trigger, so the dialog remembers the trigger (not the vanished menu item)
  // as the element to return focus to.
  const afterClose = useRef<(() => void) | null>(null);
  // The store update re-renders synchronously, so wait one tick: the dialog must
  // mount after Radix has put focus back on the trigger.
  const openAfterClose = (open: () => void) => {
    afterClose.current = () => setTimeout(open, 0);
  };
  const { data: config } = useAppConfig();
  const selectMode = useSelectProjectMode(project.id);
  const target = useProjectTarget(project);
  const href = projectTargetHref(target);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        new URL(href, window.location.origin).toString(),
      );
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };
  const setShareProjectId = useStore((s) => s.setShareProjectId);
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const setSettingsProjectId = useStore((s) => s.setSettingsProjectId);
  const enabledModes = resolveEnabledModes(project, config);
  const modes = PROJECT_MODE_STATUS_DEFINITIONS.filter(
    ({ mode }) => enabledModes[mode],
  );
  const offlineHost =
    project.effectiveSandbox?.boxOnline === false
      ? project.effectiveSandbox.boxId
      : undefined;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-56"
        onCloseAutoFocus={() => {
          const run = afterClose.current;
          afterClose.current = null;
          run?.();
        }}
      >
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
          {project.name}
        </DropdownMenuLabel>
        {offlineHost && (
          <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <CloudOff aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              Host "{offlineHost}" is offline
            </span>
          </DropdownMenuLabel>
        )}
        {sandboxDown && (
          <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <PowerOff aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0 truncate">Sandbox is not running</span>
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        {modes.map(({ mode, label, icon: Icon }) => {
          const state = statuses?.[mode] ?? 'idle';
          return (
            <DropdownMenuItem
              key={mode}
              data-mode={mode}
              data-state={state}
              className="gap-2 max-md:min-h-11"
              onSelect={() => selectMode(mode)}
            >
              <Icon aria-hidden="true" className="size-3.5" />
              <span className="flex-1">Open {label}</span>
              {state !== 'idle' && (
                <span
                  className={cn(
                    'text-xs',
                    state === 'working'
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-green-700 dark:text-green-400',
                  )}
                >
                  {MODE_STATE_LABEL[state]}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
        {modes.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem asChild className="gap-2 max-md:min-h-11">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            data-ui="project-menu-open-new-tab"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            Open in new tab
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-ui="project-menu-copy-link"
          className="gap-2 max-md:min-h-11"
          onSelect={() => void copyLink()}
        >
          <Link2 aria-hidden="true" className="size-3.5" />
          Copy link
        </DropdownMenuItem>
        {onHideFromList && (
          <DropdownMenuItem
            data-ui="project-menu-hide-from-list"
            className="gap-2 max-md:min-h-11"
            onSelect={() => openAfterClose(onHideFromList)}
          >
            <EyeOff aria-hidden="true" className="size-3.5" />
            Hide from list
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {/* Only admins and owners may list or change members. */}
        {(isAdmin || project.accessLevel === 'owner') && (
          <DropdownMenuItem
            data-ui="project-menu-share"
            className="gap-2 max-md:min-h-11"
            onSelect={() => openAfterClose(() => setShareProjectId(project.id))}
          >
            <Share2 aria-hidden="true" className="size-3.5" />
            Share…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          data-ui="project-menu-settings"
          className="gap-2 max-md:min-h-11"
          onSelect={() =>
            openAfterClose(() => setSettingsProjectId(project.id))
          }
        >
          <Settings aria-hidden="true" className="size-3.5" />
          Project settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
