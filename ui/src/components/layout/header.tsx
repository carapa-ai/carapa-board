import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import {
  Plus,
  Play,
  Pause,
  Square,
  Clock,
  Database,
  LayoutGrid,
  MessageSquare,
  Target,
  Menu,
  ChevronUp,
  ChevronDown,
  PanelLeftOpen,
  FolderOpen,
} from 'lucide-react';
import { ProjectTitleMenu } from './project-title-menu';
import {
  useProjects,
  useProjectsStatusSummary,
  useStopProject,
  usePauseProject,
  useStartProject,
  useSetParallelism,
  useUpdateProjectMode,
} from '@/hooks/use-projects';
import { useStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { availableProjectModes } from '@/lib/modes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HeaderUtilities } from '@/components/layout/header-utilities';
import { useWorkspaceToggleStore } from '@/hooks/use-workspace-toggle';
import type { ProjectMode, ProjectModeStatuses } from '@/types';
import { useAppConfig } from '@/hooks/use-app-config';

interface HeaderProps {
  project_id: string;
}

type EnabledProjectModes = Record<ProjectMode, boolean>;

const projectModes = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'kanban', label: 'Kanban', icon: LayoutGrid },
  { id: 'objectives', label: 'Objectives', icon: Target },
] as const;

export function ProjectModeSwitcher({
  currentMode,
  enabledModes,
  statuses,
  compact = false,
  showLabels = false,
  className,
  onSwitch,
}: {
  currentMode: ProjectMode;
  enabledModes: EnabledProjectModes;
  statuses?: ProjectModeStatuses;
  compact?: boolean;
  /** Always render the mode name beside its icon and share the row evenly. */
  showLabels?: boolean;
  className?: string;
  onSwitch: (mode: ProjectMode) => void;
}) {
  return (
    <nav
      aria-label="Project views"
      data-ui="project-mode-switcher"
      data-display={compact ? 'compact' : 'desktop'}
      className={cn(
        'items-center gap-0.5 rounded-md border border-border p-0.5',
        className,
      )}
    >
      {projectModes.map(({ id, label, icon: Icon }) => {
        if (!enabledModes[id]) return null;
        const activityState = statuses?.[id] ?? 'idle';
        const activityLabel =
          activityState === 'idle' ? '' : `, ${activityState}`;
        return (
          <Tooltip
            key={id}
            content={showLabels ? null : `${label} mode${activityLabel}`}
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${label} mode${activityLabel}`}
              aria-current={currentMode === id ? 'page' : undefined}
              data-ui="project-mode-button"
              data-mode={id}
              onClick={() => onSwitch(id)}
              className={cn(
                'relative rounded',
                !compact && 'xl:h-8 xl:w-auto xl:px-2',
                showLabels && 'h-8 w-auto flex-1 gap-1.5 px-2 text-xs',
                currentMode === id && 'bg-accent text-accent-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {showLabels ? (
                <span>{label}</span>
              ) : (
                !compact && <span className="hidden xl:inline">{label}</span>
              )}
              {activityState !== 'idle' && (
                <span
                  role="status"
                  aria-label={`${label} ${activityState}`}
                  data-ui="project-mode-status"
                  data-mode={id}
                  data-state={activityState}
                  className={cn(
                    'absolute right-0.5 top-0.5 size-1.5 rounded-full',
                    activityState === 'working'
                      ? 'bg-blue-600 dark:bg-blue-500 animate-pulse'
                      : 'bg-green-600 dark:bg-green-500',
                  )}
                />
              )}
            </Button>
          </Tooltip>
        );
      })}
    </nav>
  );
}

/** Server accepts whole-number parallel worktrees in 1–10. */
export function clampParallelism(value: number): number {
  return Math.max(1, Math.min(10, value));
}

export function Header({ project_id }: HeaderProps) {
  const { data: projects } = useProjects();
  const { data: statusSummary } = useProjectsStatusSummary();
  const setAddDialogOpen = useStore((s) => s.setAddDialogOpen);
  const setAddCronjobDialogOpen = useStore((s) => s.setAddCronjobDialogOpen);
  const setAddDatasetTaskDialogOpen = useStore(
    (s) => s.setAddDatasetTaskDialogOpen,
  );
  const navigate = useNavigate();
  const { location } = useRouterState();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const desktopSidebarCollapsed = useStore((s) => s.desktopSidebarCollapsed);
  const setDesktopSidebarCollapsed = useStore(
    (s) => s.setDesktopSidebarCollapsed,
  );
  const activeObjectiveId = useStore(
    (s) => s.activeObjectiveByProject[project_id] ?? null,
  );

  const { data: config } = useAppConfig();
  const setLastProjectId = useStore((s) => s.setLastProjectId);
  const workspaceToggle = useWorkspaceToggleStore((s) => s.registration);

  useEffect(() => {
    if (project_id) {
      setLastProjectId(project_id);
    }
  }, [project_id, setLastProjectId]);
  const project = projects?.find((p) => p.id === project_id);
  const status = project?.settings?.status ?? 'running';
  const checkoutMode = project?.settings?.taskCheckoutMode ?? 'shared';
  const parallelism = project?.settings?.maxParallelWorktrees ?? 1;
  const availableModes = availableProjectModes(project, config);
  // The mode picker requires BOTH the global module flag (from /api/config) AND
  // either the per-project enabledModes list or per-project setting. The global
  // flag is a hard floor — if a module is disabled at the backend, no per-project
  // setting can re-enable it from the UI.
  const hasKanban = availableModes.includes('kanban');
  const hasChat = availableModes.includes('chat');
  const hasObjectives = availableModes.includes('objectives');
  const currentMode: ProjectMode = location.pathname.startsWith('/chat/')
    ? 'chat'
    : location.pathname.startsWith('/objectives/') ||
        location.pathname.startsWith('/objective/')
      ? 'objectives'
      : 'kanban';

  const setParallelism = useSetParallelism(project_id);
  const updateMode = useUpdateProjectMode(project_id);
  const stop = useStopProject(project_id);
  const pause = usePauseProject(project_id);
  const start = useStartProject(project_id);

  const lastClickRef = useRef(0);
  const parallelRowRef = useRef<HTMLDivElement>(null);

  const [localParallel, setLocalParallel] = useState(parallelism);
  useEffect(() => {
    if (!setParallelism.isPending) {
      setLocalParallel(parallelism);
    }
  }, [parallelism, setParallelism.isPending]);

  function flushParallel(value?: number) {
    const val = value !== undefined ? value : localParallel;
    const clamped = clampParallelism(val);
    setLocalParallel(clamped);
    if (clamped !== parallelism) {
      setParallelism.mutate(clamped);
    }
  }

  // Shared by pointer and keyboard activation; the cooldown swallows the
  // duplicate event a single touch can produce.
  function stepParallel(next: number) {
    const now = Date.now();
    if (now - lastClickRef.current < 200) return;
    lastClickRef.current = now;
    setLocalParallel(next);
    flushParallel(next);
  }

  function parallelControls(): HTMLElement[] {
    return Array.from(
      parallelRowRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input',
      ) ?? [],
    );
  }

  // Radix menus swallow Tab, so focus never reaches the stepper by itself:
  // Tab from a menu item enters the row, and Tab past either end of the row
  // returns focus to the menu.
  function handleMenuTab(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Tab') return;
    const controls = parallelControls();
    if (controls.length === 0) return;
    e.preventDefault();
    (e.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
  }

  function handleParallelRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Keep Radix typeahead/arrow handling away from the input and buttons.
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const controls = parallelControls();
    const index = controls.indexOf(e.target as HTMLElement);
    const leaving = e.shiftKey ? index <= 0 : index === controls.length - 1;
    if (!leaving) return;
    e.preventDefault();
    e.currentTarget.closest<HTMLElement>('[role="menu"]')?.focus();
  }

  function handleModeSwitch(mode: ProjectMode) {
    if (mode === currentMode) return;
    updateMode.mutate(mode);
    if (mode === 'objectives' && activeObjectiveId) {
      navigate({
        to: '/objective/$projectId/$objectiveId',
        params: { projectId: project_id, objectiveId: activeObjectiveId },
      });
      return;
    }
    const to =
      mode === 'chat'
        ? '/chat/$projectId'
        : mode === 'objectives'
          ? '/objectives/$projectId'
          : '/board/$projectId';
    navigate({ to, params: { projectId: project_id } });
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-y-2 px-4 md:px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-30">
      <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-initial">
        <Button
          variant="ghost"
          size="icon-xs"
          className="md:hidden shrink-0"
          aria-label="Open menu"
          data-ui="open-menu-trigger"
          aria-expanded={sidebarOpen}
          aria-controls="global-sidebar"
          onClick={() => setSidebarOpen(true)}
        >
          <Menu className="size-5" />
        </Button>
        {desktopSidebarCollapsed && (
          <Tooltip content="Show project sidebar" side="bottom">
            <Button
              variant="ghost"
              size="icon-xs"
              className="hidden md:inline-flex shrink-0"
              aria-label="Show project sidebar"
              aria-expanded={false}
              aria-controls="global-sidebar"
              data-ui="global-sidebar-expand"
              onClick={() => setDesktopSidebarCollapsed(false)}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </Tooltip>
        )}
        <h2 className="min-w-0 text-base font-semibold md:hidden">
          <ProjectTitleMenu
            project={project}
            fallbackName={project_id}
            statuses={statusSummary?.projects[project_id]}
          />
        </h2>
        {desktopSidebarCollapsed && (
          <>
            <h2 className="hidden min-w-0 max-w-32 text-base font-semibold md:block lg:max-w-44 xl:max-w-60">
              <ProjectTitleMenu
                project={project}
                fallbackName={project_id}
                statuses={statusSummary?.projects[project_id]}
              />
            </h2>
            <span
              aria-hidden="true"
              className="hidden text-muted-foreground xl:inline"
            >
              /
            </span>
          </>
        )}
        <ProjectModeSwitcher
          currentMode={currentMode}
          enabledModes={{
            kanban: hasKanban,
            chat: hasChat,
            objectives: hasObjectives,
          }}
          statuses={statusSummary?.projects[project_id]}
          onSwitch={handleModeSwitch}
          className="hidden md:flex"
        />
      </div>

      <div className="flex items-center gap-2 md:gap-4 ml-auto">
        {/* Kanban-only controls: hidden when the project has no kanban mode. */}
        {hasKanban && (
          <>
            {/* Desktop Run controls */}
            <div className="hidden sm:flex items-center gap-1 border-r border-border pr-2 md:pr-3 mr-0.5 md:mr-1">
              {checkoutMode === 'worktree' && (
                <div
                  className="flex items-center gap-0.5 bg-muted/30 border border-border rounded px-0.5"
                  data-toolbar-group
                  data-ui="header-parallelism"
                >
                  <span className="hidden pl-1 text-xs text-muted-foreground xl:inline">
                    Parallel
                  </span>
                  <Tooltip content="Parallel worktrees (1–10)" side="bottom">
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={localParallel}
                      onChange={(e) => setLocalParallel(Number(e.target.value))}
                      onBlur={() => flushParallel()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') flushParallel();
                      }}
                      aria-label="Parallel worktrees (1–10)"
                      className="w-5 md:w-6 text-center text-xs md:text-sm bg-transparent border-none focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </Tooltip>
                  <div className="flex flex-col">
                    <Tooltip content="Increase" side="bottom">
                      <button
                        onClick={() => {
                          const next = Math.min(10, localParallel + 1);
                          setLocalParallel(next);
                          flushParallel(next);
                        }}
                        className="hover:text-primary transition-colors"
                        aria-label="Increase"
                      >
                        <ChevronUp className="size-2.5" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Decrease" side="bottom">
                      <button
                        onClick={() => {
                          const next = Math.max(1, localParallel - 1);
                          setLocalParallel(next);
                          flushParallel(next);
                        }}
                        className="hover:text-primary transition-colors disabled:opacity-40 disabled:pointer-events-none"
                        aria-label="Decrease"
                        disabled={localParallel <= 1}
                      >
                        <ChevronDown className="size-2.5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              )}
              <Tooltip content="Stop all agents" side="bottom">
                <Button
                  variant={status === 'stopped' ? 'destructive' : 'ghost'}
                  size="icon-xs"
                  aria-label="Stop all agents"
                  onClick={() => stop.mutate()}
                  disabled={stop.isPending}
                  className="md:h-8 md:w-8"
                >
                  <Square className="size-3.5 md:size-4" />
                </Button>
              </Tooltip>
              <Tooltip
                content="Pause (finish current, no new tasks)"
                side="bottom"
              >
                <Button
                  variant={status === 'paused' ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  aria-label="Pause (finish current, no new tasks)"
                  onClick={() => pause.mutate()}
                  disabled={pause.isPending || status === 'paused'}
                  className="md:h-8 md:w-8"
                >
                  <Pause className="size-3.5 md:size-4" />
                </Button>
              </Tooltip>
              <Tooltip content="Start" side="bottom">
                <Button
                  variant={status === 'running' ? 'default' : 'ghost'}
                  size="icon-xs"
                  aria-label="Start"
                  onClick={() => start.mutate()}
                  disabled={start.isPending || status === 'running'}
                  className="md:h-8 md:w-8"
                >
                  <Play className="size-3.5 md:size-4" />
                </Button>
              </Tooltip>
            </div>

            {/* Mobile Run controls dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tooltip content="Project run controls" side="bottom">
                  <Button
                    size="icon-xs"
                    variant="outline"
                    className="sm:hidden mr-1"
                    aria-label="Project run controls"
                  >
                    {status === 'running' ? (
                      <Play className="size-3.5 text-primary" />
                    ) : status === 'paused' ? (
                      <Pause className="size-3.5 text-amber-700 dark:text-amber-500" />
                    ) : status === 'stopped' ? (
                      <Square className="size-3.5 text-destructive" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                  </Button>
                </Tooltip>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-52 p-2"
                onKeyDown={handleMenuTab}
              >
                {checkoutMode === 'worktree' && (
                  <div className="flex items-center justify-between mb-2 px-2">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                      Parallel:
                    </span>
                    <div
                      ref={parallelRowRef}
                      className="flex items-center gap-1"
                      onKeyDown={handleParallelRowKeyDown}
                    >
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className="size-8"
                        aria-label="Decrease parallel worktrees"
                        disabled={localParallel <= 1}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          stepParallel(Math.max(1, localParallel - 1));
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          stepParallel(Math.max(1, localParallel - 1));
                        }}
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        aria-label="Parallel worktrees"
                        value={localParallel}
                        onChange={(e) =>
                          setLocalParallel(Number(e.target.value))
                        }
                        onBlur={() => flushParallel()}
                        className="w-8 text-center text-sm bg-transparent border-none focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none font-medium"
                      />
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className="size-8"
                        aria-label="Increase parallel worktrees"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          stepParallel(Math.min(10, localParallel + 1));
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          stepParallel(Math.min(10, localParallel + 1));
                        }}
                      >
                        <ChevronUp className="size-4" />
                      </Button>
                    </div>
                  </div>
                )}
                <DropdownMenuItem
                  onClick={() => start.mutate()}
                  disabled={start.isPending || status === 'running'}
                  className="gap-2"
                >
                  <Play className="size-4" />
                  Start processing
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => pause.mutate()}
                  disabled={pause.isPending || status === 'paused'}
                  className="gap-2"
                >
                  <Pause className="size-4" />
                  Pause
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => stop.mutate()}
                  disabled={stop.isPending}
                  className="gap-2 text-destructive focus:text-destructive"
                >
                  <Square className="size-4" />
                  Stop All
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tooltip
                  content="New task, dataset task, or cronjob"
                  side="bottom"
                >
                  <Button
                    data-ui="header-create-menu-trigger"
                    aria-label="New task, dataset task, or cronjob"
                    size="icon-xs"
                    variant="default"
                    className="md:h-8 md:w-auto md:gap-1.5 md:px-3"
                  >
                    <Plus className="size-4" />
                    <span className="hidden md:inline">New</span>
                  </Button>
                </Tooltip>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                data-ui="header-create-menu"
                align="end"
                className="w-48"
              >
                <DropdownMenuItem onClick={() => setAddDialogOpen(true)}>
                  <Plus className="size-4 mr-2" />
                  Add Task
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setAddDatasetTaskDialogOpen(true)}
                >
                  <Database className="size-4 mr-2" />
                  Add Dataset Task
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAddCronjobDialogOpen(true)}>
                  <Clock className="size-4 mr-2" />
                  Add Cronjob
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        <HeaderUtilities />

        {workspaceToggle && (
          <div className="flex items-center border-l border-border/50 pl-2 md:pl-4">
            <Tooltip
              content={
                workspaceToggle.open ? 'Close workspace' : 'Open workspace'
              }
              side="bottom"
            >
              <Button
                data-ui="header-workspace-toggle"
                variant={workspaceToggle.open ? 'secondary' : 'ghost'}
                size="icon-xs"
                className="md:h-8 md:w-8"
                aria-label="Workspace"
                aria-pressed={workspaceToggle.open}
                onClick={workspaceToggle.toggle}
              >
                <FolderOpen className="size-4" />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
      <ProjectModeSwitcher
        currentMode={currentMode}
        enabledModes={{
          kanban: hasKanban,
          chat: hasChat,
          objectives: hasObjectives,
        }}
        statuses={statusSummary?.projects[project_id]}
        compact
        showLabels
        onSwitch={handleModeSwitch}
        className={cn(
          'basis-full md:hidden',
          // A single available view needs no switcher row of its own.
          [hasKanban, hasChat, hasObjectives].filter(Boolean).length > 1
            ? 'flex'
            : 'hidden',
        )}
      />
    </header>
  );
}
