import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import {
  Layers,
  Plus,
  Power,
  RotateCcw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Server,
  RefreshCw,
  MessageCircle,
  Smartphone,
  Folder,
  GripVertical,
  X,
  ExternalLink,
  LogOut,
  Check,
  AlertCircle,
  HelpCircle,
  Database,
  Users,
  UserCircle,
  Plug,
  ShieldCheck,
  ChartNoAxesCombined,
  BrainCircuit,
  Bot,
  ChevronUp,
  PanelLeftClose,
  CloudOff,
  PowerOff,
  Clock,
  Ellipsis,
  ArrowUpDown,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import carapaBotIcon from '@/assets/carapa-bot.png';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PROJECTS_NOT_REORDERED_MESSAGE,
  useProjects,
  useUpdateProjectsOrder,
  useProjectsStatusSummary,
} from '@/hooks/use-projects';
import { useWhatsAppStatus } from '@/hooks/use-whatsapp';
import {
  logoutWhatsApp,
  rebuildBoard,
  restartBoard,
  cancelPendingBoardRestart,
  fetchServerWebBuildStatus,
  ApiError,
} from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  SandboxInfoDialog,
  computeAggregatedVersionStatus,
} from '@/components/layout/sandbox-info-dialog';
import {
  useSandboxStatus,
  usePublishedApp,
  useStartSandbox,
  useRestartSandbox,
  useRestartSandboxWhenIdle,
  useCancelPendingRestart,
  useSandboxPendingRestart,
  useSandboxPs,
  useSandboxInstancePs,
} from '@/hooks/use-sandbox';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/field-row';
import { toast } from 'sonner';
import { SearchInput } from '@/components/ui/search-input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, isTextClipped } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';
import { useQueryLoadState } from '@/lib/use-query-load-state';
import { showBuildLog } from '@/lib/build-log';
import {
  isSandboxInstanceMatch,
  projectSandboxName,
  projectSandboxTarget,
  sandboxDownProjectIds,
} from '@/lib/sandbox-instance';
import { useStore } from '@/store';
import { canUseProjectShell } from '@/lib/project-code';
import { useAuth } from '@/lib/auth';
import {
  canEditRepositoryConnection,
  sandboxLifecycleIsManaged,
} from '@/lib/sandbox-settings';
import { confirmAction } from '@/components/confirm-dialog';
import {
  ANDROID_OTA_PROMPT_EVENT,
  androidOtaStatusLabel,
  armAndroidOtaAutoApply,
  clearAndroidOtaAutoApply,
  getAndroidOtaStatus,
  isAndroidNative,
  subscribeAndroidOtaStatus,
} from '@/lib/android-ota';
import { AddProjectDialog } from './add-project-dialog';
import { QueryErrorState } from './query-error-state';
import {
  NowPanel,
  countNowBadge,
  countNowItems,
  useNowGroups,
} from './now-panel';
import { ProjectTitleMenu } from './project-title-menu';
import { rovingKeyDown, rovingRowOf } from './roving-list';
import {
  MODE_STATE_LABEL,
  PROJECT_MODE_STATUS_DEFINITIONS,
  ProjectActionsMenu,
  resolveEnabledModes,
  useProjectTarget,
} from './project-actions-menu';
import { SandboxSshLink } from './sandbox-ssh';
import { CopyableText } from './sandbox-endpoints';
import { AddWhatsAppGroupDialog } from './add-whatsapp-group-dialog';
import { LinkProjectToWhatsAppDialog } from './link-project-to-whatsapp-dialog';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project, ProjectMode, ProjectModeStatuses } from '@/types';
import { useAppConfig } from '@/hooks/use-app-config';

const COLLAPSED_PARENTS_KEY = 'sidebar_collapsed_parents';
const PROJECT_LAST_ACTIVE_KEY = 'sidebar_project_last_active';
/** How long a project stays in the collapsed projects list after activity. */
const RECENT_ACTIVITY_WINDOW_MS = 4 * 60 * 60 * 1000;
const RECENT_ACTIVITY_TICK_MS = 60_000;

const MOBILE_MAX_WIDTH = 768;
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function subscribeViewportWidth(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
const getIsMobileViewport = () => window.innerWidth < MOBILE_MAX_WIDTH;

// Tabbable descendants that are actually rendered (skips display:none, e.g.
// the desktop-only collapse button, and visibility:hidden subtrees).
function getTabbableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    for (let node: HTMLElement | null = el; node && node !== root; ) {
      if (getComputedStyle(node).display === 'none') return false;
      node = node.parentElement;
    }
    return getComputedStyle(el).visibility !== 'hidden';
  });
}

const MENU_TRIGGER_SELECTOR = '[data-ui="open-menu-trigger"]';
const MENU_TRIGGER_WAIT_MS = 2000;

// Focus the opener, or the destination page's "Open menu" trigger when
// navigation replaced it. The route may unmount the page that just received
// focus, so keep restoring for a short window while focus is on <body>.
function restoreFocusToMenuTrigger(opener: HTMLElement | null) {
  const findTrigger = () =>
    opener?.isConnected
      ? opener
      : document.querySelector<HTMLElement>(MENU_TRIGGER_SELECTOR);
  findTrigger()?.focus();
  const refocusIfLost = () => {
    if (!document.activeElement || document.activeElement === document.body) {
      findTrigger()?.focus();
    }
  };
  const observer = new MutationObserver(refocusIfLost);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    document.removeEventListener('pointerdown', stop, true);
    document.removeEventListener('keydown', stop, true);
  };
  const timer = setTimeout(stop, MENU_TRIGGER_WAIT_MS);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('keydown', stop, true);
}

export function Sidebar() {
  const queryClient = useQueryClient();
  const { data: config } = useAppConfig();
  const projectsQuery = useProjects();
  const projectsData = projectsQuery.data;
  const projectsLoad = useQueryLoadState([projectsQuery], {
    isEmpty: () => !projectsQuery.data?.length,
  });
  const { data: statusSummary } = useProjectsStatusSummary();
  const nowGroups = useNowGroups();
  const nowBadgeCount = countNowBadge(nowGroups);
  const nowExpandedDesktop = useStore((s) => s.sidebarNowExpanded);
  const setNowExpandedDesktop = useStore((s) => s.setSidebarNowExpanded);
  const nowExpandedMobile = useStore((s) => s.sidebarNowExpandedMobile);
  const setNowExpandedMobile = useStore((s) => s.setSidebarNowExpandedMobile);
  const projectsExpanded = useStore((s) => s.sidebarProjectsExpanded);
  const setProjectsExpanded = useStore((s) => s.setSidebarProjectsExpanded);
  const sandboxesExpanded = useStore((s) => s.sidebarSandboxesExpanded);
  const setSandboxesExpanded = useStore((s) => s.setSidebarSandboxesExpanded);
  const { data: runningSandboxes, isSuccess: sandboxPsLoaded } = useSandboxPs();
  const updateOrderMutation = useUpdateProjectsOrder();
  const authUser = useAuth((s) => s.user);
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };
  // The branding shows the open project, like the mobile header does.
  const selectedProject = projectsData?.find((p) => p.id === projectId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const desktopSidebarCollapsed = useStore((s) => s.desktopSidebarCollapsed);
  const setDesktopSidebarCollapsed = useStore(
    (s) => s.setDesktopSidebarCollapsed,
  );
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const username = useAuth((s) => s.user?.username);
  const accountNameRef = useRef<HTMLSpanElement>(null);
  const adminOverlay = useStore((s) => s.adminOverlay);
  const openAdminOverlay = useStore((s) => s.openAdminOverlay);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, [pathname, setSidebarOpen]);

  const isMobileViewport = useSyncExternalStore(
    subscribeViewportWidth,
    getIsMobileViewport,
  );
  const isMobileDrawerOpen = sidebarOpen && isMobileViewport;
  // The drawer keeps its own preference, collapsed by default, so the project
  // list gets the height; the section header still shows the item count.
  const nowExpanded = isMobileViewport ? nowExpandedMobile : nowExpandedDesktop;
  const setNowExpanded = isMobileViewport
    ? setNowExpandedMobile
    : setNowExpandedDesktop;

  const wasCollapsedRef = useRef(desktopSidebarCollapsed);
  useEffect(() => {
    const wasCollapsed = wasCollapsedRef.current;
    wasCollapsedRef.current = desktopSidebarCollapsed;
    if (!wasCollapsed || desktopSidebarCollapsed) return;
    // The header's expand button unmounts on expand, which would drop focus to
    // <body>. The sidebar is still `visibility: hidden` for the first frames
    // of its transition, so retry until the collapse button accepts focus.
    let frame = 0;
    let attempts = 0;
    const focusCollapse = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      document
        .querySelector<HTMLElement>('[data-ui="global-sidebar-collapse"]')
        ?.focus();
      if (document.activeElement === document.body && attempts++ < 20) {
        frame = requestAnimationFrame(focusCollapse);
      }
    };
    frame = requestAnimationFrame(focusCollapse);
    return () => cancelAnimationFrame(frame);
  }, [desktopSidebarCollapsed]);

  // Below md the drawer is modal-like: move focus in on open, keep Tab inside
  // it, close on Escape, and hand focus back to the "Open menu" trigger on close.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!sidebarOpen) setReorderMode(false);
  }, [sidebarOpen]);
  useEffect(() => {
    if (!isMobileDrawerOpen) return;
    const active = document.activeElement;
    drawerTriggerRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setSidebarOpen(false);
        return;
      }
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const drawer = document.getElementById('global-sidebar');
      if (!drawer) return;
      const focused = document.activeElement;
      // Leave focus inside portaled menus/dialogs opened from the drawer alone.
      if (focused && focused !== document.body && !drawer.contains(focused)) {
        return;
      }
      const tabbable = getTabbableWithin(drawer);
      if (tabbable.length === 0) return;
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      const target = event.shiftKey
        ? !focused || focused === document.body || focused === first
          ? last
          : null
        : !focused || focused === document.body || focused === last
          ? first
          : null;
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const opener = drawerTriggerRef.current;
      drawerTriggerRef.current = null;
      const focused = document.activeElement;
      if (
        focused &&
        focused !== document.body &&
        !document.getElementById('global-sidebar')?.contains(focused)
      ) {
        return;
      }
      restoreFocusToMenuTrigger(opener);
    };
  }, [isMobileDrawerOpen, setSidebarOpen]);
  const [items, setItems] = useState<Project[]>([]);
  const [search, setSearch] = useState('');
  // Touch reorder: handles are only shown (and the row links only inert) while on.
  const [reorderMode, setReorderMode] = useState(false);
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_PARENTS_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggleParent = (parentId: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      try {
        localStorage.setItem(COLLAPSED_PARENTS_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    if (projectsData) {
      setItems(projectsData);
    }
  }, [projectsData]);

  // Flag nothing until ps has loaded successfully (not loading, not errored).
  const sandboxDownIds = useMemo(
    () =>
      sandboxDownProjectIds(
        projectsData,
        sandboxPsLoaded ? runningSandboxes : undefined,
      ),
    [projectsData, runningSandboxes, sandboxPsLoaded],
  );

  // Build tree: separate root projects (no parentId or parentId not found) from children
  const isSearching = search.length > 0;
  const reorderActive = reorderMode && !isSearching;
  const [rovingId, setRovingId] = useState<string | null>(null);
  const draggingRef = useRef(false);
  const searchLower = search.toLowerCase();

  // When searching, flatten everything
  const filteredItems = isSearching
    ? items.filter((item) => item.name.toLowerCase().includes(searchLower))
    : items;

  // Build parent → children map for tree view
  const parentIds = new Set(
    items.filter((p) => p.settings?.isParent).map((p) => p.id),
  );
  const childrenByParent = new Map<string, Project[]>();
  const rootItems: Project[] = [];

  if (!isSearching) {
    for (const item of items) {
      if (item.parentId && parentIds.has(item.parentId)) {
        const arr = childrenByParent.get(item.parentId) ?? [];
        arr.push(item);
        childrenByParent.set(item.parentId, arr);
      } else {
        rootItems.push(item);
      }
    }
  }

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    // Long press, so a drag never competes with scrolling the list.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeItem = items.find((i) => i.id === active.id);
    const overItem = items.find((i) => i.id === over.id);
    if (!activeItem || !overItem) return;

    // Resolve effective parent (null = root)
    const activeParent =
      activeItem.parentId && parentIds.has(activeItem.parentId)
        ? activeItem.parentId
        : null;
    const overParent =
      overItem.parentId && parentIds.has(overItem.parentId)
        ? overItem.parentId
        : null;

    // Block cross-group drops (root ↔ child or different parent groups)
    if (activeParent !== overParent) return;

    // The server would skip a project the user cannot edit, so say so instead
    // of letting it silently snap back after the refetch.
    if (!canUseProjectShell(activeItem, authUser)) {
      toast.info(PROJECTS_NOT_REORDERED_MESSAGE);
      return;
    }

    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    const previousItems = items;
    const newItems = arrayMove(items, oldIndex, newIndex);

    // The server skips projects the user cannot edit; leave them out so its
    // `skipped` count only reports a project the user actually moved.
    const orders: Record<string, number> = {};
    newItems.forEach((item, index) => {
      if (canUseProjectShell(item, authUser)) orders[item.folder] = index;
    });
    // Nothing can be saved, so do not show an order that was never persisted.
    if (Object.keys(orders).length === 0) return;
    setItems(newItems);
    updateOrderMutation.mutate(orders, {
      onError: () => setItems(previousItems),
    });
  }

  const activeParentId = items.find((item) => item.id === projectId)?.parentId;
  const displayItems = isSearching ? filteredItems : rootItems;
  const currentlyActiveIds = useMemo(
    () =>
      items
        .filter((item) =>
          isProjectActive(
            resolveEnabledModes(item, config),
            statusSummary?.projects[item.id],
          ),
        )
        .map((item) => item.id),
    [items, config, statusSummary],
  );
  const { recentlyActiveIds, hideProject } =
    useRecentlyActiveProjectIds(currentlyActiveIds);
  // Collapsed list: tree order (each parent followed by its children), with a
  // child nested under its parent only when both are in the list.
  const activeEntries = useMemo(() => {
    if (projectsExpanded) return [];
    const kids = new Map<string, Project[]>();
    const roots: Project[] = [];
    for (const item of items) {
      if (item.parentId && parentIds.has(item.parentId)) {
        const arr = kids.get(item.parentId) ?? [];
        arr.push(item);
        kids.set(item.parentId, arr);
      } else {
        roots.push(item);
      }
    }
    const entries: {
      project: Project;
      isChild: boolean;
      isLastChild: boolean;
    }[] = [];
    for (const root of roots) {
      const rootActive = recentlyActiveIds.has(root.id);
      if (rootActive) {
        entries.push({ project: root, isChild: false, isLastChild: false });
      }
      const activeKids = (kids.get(root.id) ?? []).filter((c) =>
        recentlyActiveIds.has(c.id),
      );
      activeKids.forEach((child, i) =>
        entries.push({
          project: child,
          isChild: rootActive,
          isLastChild: i === activeKids.length - 1,
        }),
      );
    }
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsExpanded, items, recentlyActiveIds]);

  // Hiding removes the focused row, so focus moves to the next row (else the
  // previous one, else the Projects toggle) once the list has re-rendered.
  const hideFocusRef = useRef<string | null>(null);
  const hideFromList = (id: string) => {
    const index = activeEntries.findIndex((entry) => entry.project.id === id);
    hideFocusRef.current =
      (activeEntries[index + 1] ?? activeEntries[index - 1])?.project.id ?? '';
    hideProject(id);
  };
  useEffect(() => {
    const next = hideFocusRef.current;
    if (next === null) return;
    hideFocusRef.current = null;
    const target = next
      ? document.querySelector<HTMLElement>(
          `[data-ui="sidebar-active-projects"] [data-roving-row="${window.CSS.escape(next)}"] [data-roving-primary]`,
        )
      : document.querySelector<HTMLElement>(
          '[data-ui="sidebar-projects-toggle"]',
        );
    target?.focus();
  }, [activeEntries]);

  // The projects list is a single Tab stop: the row that last had focus, else
  // the open project, else the first row.
  const listRowIds = projectsExpanded
    ? displayItems.flatMap((item) => [
        item.id,
        ...(!isSearching &&
        item.settings?.isParent &&
        !collapsedParents.has(item.id)
          ? (childrenByParent.get(item.id) ?? []).map((child) => child.id)
          : []),
      ])
    : activeEntries.map(({ project }) => project.id);
  const rovingStopId =
    rovingId && listRowIds.includes(rovingId)
      ? rovingId
      : projectId && listRowIds.includes(projectId)
        ? projectId
        : listRowIds[0];
  const listNavProps = {
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) =>
      rovingKeyDown(event, draggingRef.current),
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      const id = rovingRowOf(event.target);
      if (id) setRovingId(id);
    },
  };

  return (
    <aside
      id="global-sidebar"
      data-ui="global-sidebar"
      {...(isMobileDrawerOpen && {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': 'Project menu',
      })}
      className={cn(
        'flex-shrink-0 border-r border-border bg-sidebar flex flex-col overflow-hidden transition-all duration-300 z-50',
        'fixed inset-y-0 left-0 w-[min(90vw,360px)] md:w-72 md:max-w-none md:relative md:translate-x-0',
        // Below md, visibility flips at once on open (so focus can move in) and
        // after the slide-out on close.
        sidebarOpen
          ? 'translate-x-0 max-md:[transition:transform_300ms,translate_300ms,visibility_0s]!'
          : '-translate-x-full max-md:invisible max-md:[transition:transform_300ms,translate_300ms,visibility_0s_linear_300ms]! md:translate-x-0',
        desktopSidebarCollapsed &&
          'md:!w-0 md:!border-r-0 md:!invisible md:!pointer-events-none',
      )}
    >
      {/* Branding */}
      <div
        data-ui="global-sidebar-branding"
        className="px-2 py-3 border-b border-sidebar-border flex items-center gap-1"
      >
        <h1 className="min-w-0 flex-1 text-base font-bold text-foreground flex items-center gap-1">
          <img
            src={carapaBotIcon}
            alt="CarapaBoard"
            className="size-6 shrink-0 rounded"
          />
          {projectId ? (
            <ProjectTitleMenu
              project={selectedProject}
              fallbackName={projectId}
              statuses={statusSummary?.projects[projectId]}
            />
          ) : (
            <span data-ui="global-sidebar-title" className="truncate">
              CarapaBoard
            </span>
          )}
        </h1>
        <Button
          ref={closeButtonRef}
          variant="ghost"
          size="icon-xs"
          // transition-none: a transitioning child would keep inherited
          // visibility hidden for a frame and refuse the open-time focus.
          className="md:hidden transition-none max-md:size-11"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        >
          <X className="size-4" />
        </Button>
        <Tooltip content="Hide project sidebar" side="right">
          <Button
            variant="ghost"
            size="icon-xs"
            className="hidden md:inline-flex"
            aria-label="Hide project sidebar"
            aria-expanded={!desktopSidebarCollapsed}
            aria-controls="global-sidebar"
            data-ui="global-sidebar-collapse"
            onClick={() => {
              setDesktopSidebarCollapsed(true);
              requestAnimationFrame(() => {
                document
                  .querySelector<HTMLElement>(
                    '[data-ui="global-sidebar-expand"]',
                  )
                  ?.focus();
              });
            }}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </Tooltip>
      </div>

      <div data-ui="sidebar-sections" className="flex min-h-0 flex-1 flex-col">
        {/* Now — what is running or needs the user, across projects */}
        <section
          data-ui="sidebar-now-section"
          data-expanded={nowExpanded}
          className={cn(
            'flex min-h-0 flex-col',
            // With Projects collapsed, Now takes the remaining sidebar height.
            nowExpanded && !projectsExpanded
              ? 'flex-1'
              : 'max-h-[35%] shrink-0',
          )}
        >
          <SidebarSectionToggle
            ui="sidebar-now-toggle"
            controls="sidebar-now-list"
            label="Now"
            count={isMobileViewport ? countNowItems(nowGroups) : nowBadgeCount}
            expanded={nowExpanded}
            onToggle={() => setNowExpanded(!nowExpanded)}
          />
          {nowExpanded && (
            <ScrollArea
              id="sidebar-now-list"
              className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
            >
              <div className="px-2 pr-3">
                <NowPanel groups={nowGroups} />
              </div>
            </ScrollArea>
          )}
        </section>

        {/* Projects */}
        <section
          data-ui="sidebar-projects-section"
          data-expanded={projectsExpanded}
          className={cn(
            'flex min-h-0 flex-col border-t border-sidebar-border/40',
            projectsExpanded
              ? 'flex-1'
              : cn('shrink-0', activeEntries.length > 0 && 'max-h-[30%]'),
          )}
        >
          <SidebarSectionToggle
            ui="sidebar-projects-toggle"
            controls="sidebar-projects-list"
            label="Projects"
            expanded={projectsExpanded}
            onToggle={() => setProjectsExpanded(!projectsExpanded)}
          />
          {projectsExpanded && (
            <>
              <FieldRow
                compact
                touch
                data-ui="project-sidebar-controls"
                className="gap-1 px-2 pb-1.5"
              >
                <SearchInput
                  compact
                  aria-label="Search projects"
                  placeholder="Search..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClear={() => setSearch('')}
                  clearLabel="Clear project search"
                  wrapperClassName="flex-1"
                  className="max-md:h-11"
                />
                <Button
                  variant={reorderActive ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  className="hidden shrink-0 max-md:inline-flex max-md:size-11 [@media(hover:none)]:inline-flex"
                  data-ui="project-reorder-toggle"
                  aria-label={
                    reorderActive ? 'Done reordering' : 'Reorder projects'
                  }
                  aria-pressed={reorderActive}
                  disabled={isSearching}
                  onClick={() => setReorderMode((on) => !on)}
                >
                  <ArrowUpDown className="size-3.5" />
                </Button>
                {config?.enableWhatsApp && (
                  <Tooltip content="Connect WhatsApp group" side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 max-md:size-11"
                      aria-label="Connect WhatsApp group"
                      onClick={() =>
                        useStore.getState().setAddWhatsAppGroupDialogOpen(true)
                      }
                    >
                      <MessageCircle className="size-3.5" />
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content="New project" side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 max-md:size-11"
                    aria-label="New project"
                    onClick={() =>
                      useStore.getState().setAddProjectDialogOpen(true)
                    }
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </Tooltip>
              </FieldRow>
              <ScrollArea
                id="sidebar-projects-list"
                className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
              >
                <nav
                  aria-label="Projects"
                  className="pr-2 pb-2"
                  data-roving-root
                  {...listNavProps}
                >
                  {projectsLoad.phase !== 'error' &&
                    projectsLoad.staleError && (
                      <QueryErrorState
                        compact
                        title="Could not refresh projects"
                        error={projectsLoad.staleError}
                        onRetry={projectsLoad.retry}
                        isRetrying={projectsLoad.isRetrying}
                      />
                    )}
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragStart={() => {
                      draggingRef.current = true;
                    }}
                    onDragCancel={() => {
                      draggingRef.current = false;
                    }}
                    onDragEnd={(event) => {
                      draggingRef.current = false;
                      handleDragEnd(event);
                    }}
                  >
                    <SortableContext
                      items={displayItems.map((item) => item.id)}
                      strategy={verticalListSortingStrategy}
                      disabled={isSearching}
                    >
                      <div role="list" className="space-y-0.5">
                        {displayItems.map((project) => (
                          // The listitem holds the row and its children's list, so a
                          // nested list sits inside an item rather than beside it.
                          <div key={project.id} role="listitem">
                            <SortableProjectItem
                              project={project}
                              listItem={false}
                              activeProjectId={projectId}
                              searchActive={isSearching}
                              modeStatuses={statusSummary?.projects[project.id]}
                              sandboxDown={sandboxDownIds.has(project.id)}
                              isCollapsed={collapsedParents.has(project.id)}
                              containsActive={project.id === activeParentId}
                              reorderMode={reorderActive}
                              rovingTabStop={project.id === rovingStopId}
                              onToggleCollapse={
                                project.settings?.isParent
                                  ? () => toggleParent(project.id)
                                  : undefined
                              }
                            />
                            {/* Render children of parent projects in their own sortable context */}
                            {!isSearching &&
                              project.settings?.isParent &&
                              !collapsedParents.has(project.id) && (
                                <SortableContext
                                  items={(
                                    childrenByParent.get(project.id) ?? []
                                  ).map((c) => c.id)}
                                  strategy={verticalListSortingStrategy}
                                >
                                  <div
                                    role="list"
                                    data-ui="project-children"
                                    data-parent-project-id={project.id}
                                    className="ml-2"
                                  >
                                    {(
                                      childrenByParent.get(project.id) ?? []
                                    ).map((child, childIndex, children) => (
                                      <SortableProjectItem
                                        key={child.id}
                                        project={child}
                                        activeProjectId={projectId}
                                        searchActive={false}
                                        modeStatuses={
                                          statusSummary?.projects[child.id]
                                        }
                                        sandboxDown={sandboxDownIds.has(
                                          child.id,
                                        )}
                                        isChild
                                        reorderMode={reorderActive}
                                        rovingTabStop={
                                          child.id === rovingStopId
                                        }
                                        isLastChild={
                                          childIndex === children.length - 1
                                        }
                                      />
                                    ))}
                                  </div>
                                </SortableContext>
                              )}
                          </div>
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>

                  {projectsLoad.phase === 'loading' ? (
                    <ProjectsLoading />
                  ) : projectsLoad.phase === 'error' ? (
                    <QueryErrorState
                      compact
                      title="Could not load projects"
                      error={projectsLoad.error}
                      onRetry={projectsLoad.retry}
                      isRetrying={projectsLoad.isRetrying}
                    />
                  ) : projectsLoad.phase === 'empty' ? (
                    <div
                      data-ui="sidebar-projects-empty"
                      className="space-y-2 px-3 py-2 text-xs md:text-sm text-muted-foreground"
                    >
                      <p>No projects yet</p>
                      <Button
                        variant="outline"
                        size="xs"
                        className="max-md:h-11"
                        onClick={() =>
                          useStore.getState().setAddProjectDialogOpen(true)
                        }
                      >
                        <Plus aria-hidden /> New project
                      </Button>
                    </div>
                  ) : isSearching && !filteredItems.length ? (
                    <p className="px-3 py-2 text-xs md:text-sm text-muted-foreground italic text-center">
                      No projects match "{search}"
                    </p>
                  ) : null}
                </nav>
              </ScrollArea>
            </>
          )}
          {!projectsExpanded && activeEntries.length > 0 && (
            <ScrollArea
              id="sidebar-projects-list"
              data-ui="sidebar-active-projects"
              className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
            >
              <nav
                aria-label="Active projects"
                className="pr-2 pb-2"
                data-roving-root
                {...listNavProps}
              >
                <div role="list" className="space-y-0.5">
                  {activeEntries.map(({ project, isChild, isLastChild }) => (
                    <div
                      key={project.id}
                      role="none"
                      data-ui={isChild ? 'project-children' : undefined}
                      className={isChild ? 'ml-2' : undefined}
                    >
                      <ActiveProjectItem
                        project={project}
                        activeProjectId={projectId}
                        containsActive={project.id === activeParentId}
                        rovingTabStop={project.id === rovingStopId}
                        modeStatuses={statusSummary?.projects[project.id]}
                        sandboxDown={sandboxDownIds.has(project.id)}
                        isChild={isChild}
                        isLastChild={isLastChild}
                        onHideFromList={hideFromList}
                      />
                    </div>
                  ))}
                </div>
              </nav>
            </ScrollArea>
          )}
        </section>

        {/* Sandboxes — the selected project's sandbox and the other running ones */}
        <section
          data-ui="sidebar-sandboxes-section"
          data-expanded={sandboxesExpanded}
          className="flex min-h-0 max-h-[40%] shrink-0 flex-col border-t border-sidebar-border/40"
        >
          <SidebarSectionToggle
            ui="sidebar-sandboxes-toggle"
            controls="sidebar-sandboxes-panel"
            label="Sandboxes"
            count={runningSandboxes?.length}
            expanded={sandboxesExpanded}
            onToggle={() => setSandboxesExpanded(!sandboxesExpanded)}
          />
          {sandboxesExpanded && (
            <ScrollArea
              id="sidebar-sandboxes-panel"
              className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
            >
              <SandboxPanel />
            </ScrollArea>
          )}
        </section>
      </div>

      {/* Account menu — collapses Knowledge Hub / Users & Roles / Devices / Account / Log Out
          into a single avatar dropdown so the projects tree gets the recovered rows. */}
      <div className="px-2 pt-2 pb-1 border-t border-sidebar-border/40">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Tooltip
              content={username ?? 'Account'}
              whenClipped={accountNameRef}
              side="right"
            >
              <button
                type="button"
                aria-label="Account menu"
                className="flex items-center gap-2 w-full px-2 py-1.5 max-md:min-h-11 rounded-md text-sm text-sidebar-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring transition-colors"
              >
                <span className="size-7 rounded-full bg-primary/15 text-primary text-xs md:text-sm font-semibold flex items-center justify-center shrink-0">
                  {(username?.[0] ?? '?').toUpperCase()}
                </span>
                <span
                  ref={accountNameRef}
                  className="flex-1 text-left truncate text-xs md:text-sm"
                >
                  {username ?? 'Account'}
                </span>
                <ChevronUp className="size-3.5 text-muted-foreground shrink-0" />
              </button>
            </Tooltip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground truncate">
                  {username ?? 'Account'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isAdmin ? 'Administrator' : 'User'}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                asChild
                className={cn(
                  'gap-2 cursor-pointer',
                  pathname === '/knowledge' &&
                    'bg-accent text-accent-foreground',
                )}
              >
                <Link to="/knowledge">
                  <Database className="size-3.5 text-primary" />
                  <span>Knowledge Hub</span>
                </Link>
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'provider-accounts' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('provider-accounts')}
                >
                  <ShieldCheck className="size-3.5 text-primary" />
                  <span>Provider accounts</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'mcp-connections' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('mcp-connections')}
                >
                  <Plug className="size-3.5 text-primary" />
                  <span>MCP connections</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'boxes' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('boxes')}
                >
                  <Server className="size-3.5 text-primary" />
                  <span>CarapaBox hosts</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'ai-users' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('ai-users')}
                >
                  <Bot className="size-3.5 text-cyan-700 dark:text-cyan-400" />
                  <span>AI Users</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'memory-review' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('memory-review')}
                >
                  <BrainCircuit className="size-3.5 text-violet-600 dark:text-violet-400" />
                  <span>Memory Review</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'costs' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('costs')}
                >
                  <ChartNoAxesCombined className="size-3.5 text-primary" />
                  <span>API Cost Report</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'users' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('users')}
                >
                  <Users className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>Users & Roles</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  className={cn(
                    'gap-2 cursor-pointer',
                    adminOverlay === 'devices' &&
                      'bg-accent text-accent-foreground',
                  )}
                  onSelect={() => openAdminOverlay('devices')}
                >
                  <ShieldCheck className="size-3.5 text-amber-700 dark:text-amber-400" />
                  <span>Devices</span>
                </DropdownMenuItem>
              )}
              {isAdmin && config?.enableBoardSelfDeploy && (
                <DropdownMenuItem
                  className="gap-2 cursor-pointer"
                  onSelect={() => {
                    void rebuildBoard()
                      .then(() => {
                        queryClient.setQueryData(queryKeys.serverWebBuild, {
                          status: 'building',
                        });
                        toast.success(
                          'Server & web build started. Restart will appear when ready.',
                        );
                      })
                      .catch((error) =>
                        toast.error(
                          `Could not start build: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                      );
                  }}
                  data-ui="admin-server-web-build-trigger"
                >
                  <Server className="size-3.5 text-emerald-700 dark:text-emerald-400" />
                  <span>Build app</span>
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <BuildStatusMenuItem
                  serverBuildVersion={config?.buildVersion}
                  serverBuildTime={config?.buildTime}
                />
              )}
              <DropdownMenuItem
                asChild
                className={cn(
                  'gap-2 cursor-pointer',
                  pathname.startsWith('/account') &&
                    'bg-accent text-accent-foreground',
                )}
              >
                <Link to="/account">
                  <UserCircle className="size-3.5 text-emerald-700 dark:text-emerald-400" />
                  <span>Account</span>
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                import('@/lib/auth').then(({ logout }) => logout());
              }}
              className="gap-2 cursor-pointer text-red-600 focus:text-red-600 dark:text-red-500 dark:focus:text-red-500"
            >
              <LogOut className="size-3.5" />
              <span>Log Out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* WhatsApp status */}
      {config?.enableWhatsApp && <WhatsAppPanel />}

      {/* Restart banner (shown after a successful build) */}
      {isAdmin && config?.enableBoardSelfDeploy && <RestartBanner />}

      <AddProjectDialog />
      {config?.enableWhatsApp && <AddWhatsAppGroupDialog />}
      {config?.enableWhatsApp && <LinkProjectToWhatsAppDialog />}
    </aside>
  );
}

/** "Loading projects…", which turns into "Still loading…" after a few seconds. */
function ProjectsLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p
      role="status"
      aria-busy="true"
      data-ui="sidebar-projects-loading"
      className="px-3 py-2 text-xs md:text-sm text-muted-foreground"
    >
      {slow ? 'Still loading…' : 'Loading projects…'}
    </p>
  );
}

function SidebarSectionToggle({
  ui,
  controls,
  label,
  count,
  expanded,
  onToggle,
}: {
  ui: string;
  controls: string;
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-ui={ui}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="flex w-full shrink-0 items-center gap-1.5 border-b border-sidebar-border/60 bg-muted/40 px-3 py-1.5 max-md:min-h-11 text-left transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {expanded ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/80">
        {label}
      </span>
      {count !== undefined && count > 0 && (
        <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium leading-none text-secondary-foreground">
          {count}
        </span>
      )}
    </button>
  );
}

function formatBuildTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function BuildStatusMenuItem({
  serverBuildVersion,
  serverBuildTime,
}: {
  serverBuildVersion?: string;
  serverBuildTime?: string;
}) {
  const androidStatus = useSyncExternalStore(
    subscribeAndroidOtaStatus,
    getAndroidOtaStatus,
    getAndroidOtaStatus,
  );
  const nativeAndroid = isAndroidNative();
  const webBuild = import.meta.env.VITE_BUILD_COMMIT || 'development';
  useEffect(() => {
    if (nativeAndroid) console.info(`[carapa-build] sidebar build ${webBuild}`);
  }, [nativeAndroid, webBuild]);

  if (!nativeAndroid) {
    const version = serverBuildVersion || webBuild;
    const shortVersion =
      version === 'development' ? 'Development' : version.slice(0, 12);
    const formattedTime = formatBuildTime(serverBuildTime);
    return (
      <Tooltip
        content={`Installed server & web build ${version}${serverBuildTime ? `, built ${serverBuildTime}` : ''}`}
        side="right"
      >
        <DropdownMenuLabel
          className="flex gap-2 px-2 py-1.5 text-xs font-normal"
          data-testid="build-commit"
          data-ui="admin-installed-build"
          data-build-version={version}
        >
          <Server className="size-3.5" />
          <span className="flex min-w-0 flex-col">
            <span className="font-mono">Build {shortVersion}</span>
            {formattedTime && (
              <span
                className="text-[10px] font-normal text-muted-foreground"
                data-ui="admin-installed-build-time"
              >
                {formattedTime}
              </span>
            )}
          </span>
        </DropdownMenuLabel>
      </Tooltip>
    );
  }

  const label = androidOtaStatusLabel(androidStatus);

  return (
    <DropdownMenuItem
      className="gap-2 cursor-pointer text-xs"
      data-testid="build-commit"
      data-ui="android-ota-status"
      data-update-status={androidStatus.kind}
      data-update-reason={
        androidStatus.kind === 'unavailable' ? androidStatus.reason : undefined
      }
      onSelect={() => window.dispatchEvent(new Event(ANDROID_OTA_PROMPT_EVENT))}
    >
      <Smartphone className="size-3.5" />
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        <span
          className="text-[10px] font-normal text-muted-foreground"
          data-ui="android-ota-web-build"
        >
          Web build{' '}
          {webBuild === 'development' ? 'Development' : webBuild.slice(0, 12)}
        </span>
      </span>
    </DropdownMenuItem>
  );
}

function loadLastActiveStamps(): Record<string, number> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PROJECT_LAST_ACTIVE_KEY) ?? '',
    );
    if (!parsed || typeof parsed !== 'object') return {};
    const stamps: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number') stamps[id] = ts;
    }
    return stamps;
  } catch {
    return {};
  }
}

/**
 * Projects that are active now or were last seen active within the last 4
 * hours. The last-seen time is kept per browser in localStorage and refreshed
 * every minute while a project stays active.
 */
function useRecentlyActiveProjectIds(currentlyActiveIds: readonly string[]): {
  recentlyActiveIds: Set<string>;
  /** Drop an idle project from the list until it is active again. */
  hideProject: (id: string) => void;
} {
  const stampsRef = useRef<Record<string, number> | null>(null);
  stampsRef.current ??= loadLastActiveStamps();
  const activeRef = useRef(currentlyActiveIds);
  activeRef.current = currentlyActiveIds;
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    const t = Date.now();
    const next: Record<string, number> = {};
    for (const [id, ts] of Object.entries(stampsRef.current ?? {})) {
      if (t - ts < RECENT_ACTIVITY_WINDOW_MS) next[id] = ts;
    }
    for (const id of activeRef.current) next[id] = t;
    stampsRef.current = next;
    try {
      localStorage.setItem(PROJECT_LAST_ACTIVE_KEY, JSON.stringify(next));
    } catch {}
    setNow(t);
  }, []);

  const hideProject = useCallback((id: string) => {
    const { [id]: _hidden, ...rest } = stampsRef.current ?? {};
    stampsRef.current = rest;
    try {
      localStorage.setItem(PROJECT_LAST_ACTIVE_KEY, JSON.stringify(rest));
    } catch {}
    setNow(Date.now());
  }, []);

  const activeKey = currentlyActiveIds.join('\n');
  useEffect(() => {
    refresh();
  }, [activeKey, refresh]);
  useEffect(() => {
    const timer = setInterval(refresh, RECENT_ACTIVITY_TICK_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const recentlyActiveIds = useMemo(() => {
    const ids = new Set(currentlyActiveIds);
    for (const [id, ts] of Object.entries(stampsRef.current ?? {})) {
      if (now - ts < RECENT_ACTIVITY_WINDOW_MS) ids.add(id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentlyActiveIds, now]);
  return { recentlyActiveIds, hideProject };
}

function isProjectActive(
  enabledModes: Record<ProjectMode, boolean>,
  statuses?: ProjectModeStatuses,
): boolean {
  return PROJECT_MODE_STATUS_DEFINITIONS.some(
    ({ mode }) =>
      enabledModes[mode] &&
      (statuses?.[mode] === 'working' || statuses?.[mode] === 'finished'),
  );
}

/**
 * Compact, non-interactive status dot on a project row. It is a labelled image
 * (not a control): blue and pulsing while any enabled mode is working, green
 * once something finished. The accessible name and the tooltip spell out every
 * mode; switching modes lives in the row's overflow menu.
 */
function ProjectStatusIndicator({
  projectId,
  statuses,
  enabledModes,
}: {
  projectId: string;
  statuses?: ProjectModeStatuses;
  enabledModes: Record<ProjectMode, boolean>;
}) {
  const active = PROJECT_MODE_STATUS_DEFINITIONS.flatMap(({ mode, label }) => {
    const state = statuses?.[mode];
    return enabledModes[mode] && (state === 'working' || state === 'finished')
      ? [{ label, state }]
      : [];
  });
  if (active.length === 0) return null;
  const description = active
    .map(({ label, state }) => `${label} ${MODE_STATE_LABEL[state]}`)
    .join(', ');
  const working = active.some(({ state }) => state === 'working');
  return (
    <Tooltip content={description} side="right">
      <span
        role="img"
        aria-label={description}
        data-ui="project-status-indicator"
        data-project-id={projectId}
        data-state={working ? 'working' : 'finished'}
        className={cn(
          'absolute left-[17px] top-1/2 -mt-2.5 size-2 rounded-full ring-2 ring-[var(--row-bg)] before:absolute before:-inset-1.5 before:content-[""]',
          working
            ? 'animate-pulse bg-blue-600 dark:bg-blue-500'
            : 'bg-green-600 dark:bg-green-500',
        )}
      />
    </Tooltip>
  );
}

type ProjectRowProps = {
  project: Project;
  activeProjectId?: string;
  searchActive?: boolean;
  modeStatuses?: ProjectModeStatuses;
  /** The project's sandbox is not running (its host is reachable). */
  sandboxDown?: boolean;
  isChild?: boolean;
  isLastChild?: boolean;
  isCollapsed?: boolean;
  /** True for the parent row of the currently open child project. */
  containsActive?: boolean;
  /** Touch reorder mode: handles are visible and the row link is inert. */
  reorderMode?: boolean;
  /** False when a wrapper owns the listitem role (a root row with a children list). */
  listItem?: boolean;
  /** Roving tabindex: false removes the row link from the Tab order. */
  rovingTabStop?: boolean;
  /** Collapsed list only: offers "Hide from list" on idle rows. */
  onHideFromList?: (projectId: string) => void;
  onToggleCollapse?: () => void;
};

type ProjectRowSortable = ReturnType<typeof useSortable>;

export function SortableProjectItem(props: ProjectRowProps) {
  const sortable = useSortable({
    id: props.project.id,
    disabled: props.searchActive,
  });
  return <ProjectRow {...props} sortable={sortable} />;
}

// Non-sortable row used by the collapsed Projects section: no drag handle and
// no dnd-kit registration, so it renders outside any DndContext.
export function ActiveProjectItem(props: ProjectRowProps) {
  return <ProjectRow {...props} />;
}

function ProjectRow({
  project,
  activeProjectId,
  searchActive,
  modeStatuses,
  sandboxDown,
  isChild,
  isLastChild,
  isCollapsed,
  containsActive,
  reorderMode,
  listItem,
  rovingTabStop,
  onHideFromList,
  onToggleCollapse,
  sortable,
}: ProjectRowProps & { sortable?: ProjectRowSortable }) {
  const style = sortable && {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    zIndex: sortable.isDragging ? 50 : undefined,
  };
  const isDragging = !!sortable?.isDragging;

  const { data: config } = useAppConfig();
  const target = useProjectTarget(project);
  const isWhatsApp = !!project.jid;
  const isParent = project.settings?.isParent;
  const boxOffline = project.effectiveSandbox?.boxOnline === false;
  // Computed against reachable hosts only, so it never shows with boxOffline.
  const sandboxStopped = !!sandboxDown && !boxOffline;
  const enabledModes = resolveEnabledModes(project, config);
  const [menuOpen, setMenuOpen] = useState(false);
  const nameRef = useRef<HTMLSpanElement>(null);

  return (
    <div
      ref={sortable?.setNodeRef}
      style={style}
      role={listItem === false ? undefined : 'listitem'}
      data-roving-row={project.id}
      onContextMenu={(event) => {
        if (reorderMode) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        'relative group w-full max-w-full',
        // --row-bg mirrors the row highlight so the revealed mode icons can mask text beneath them.
        activeProjectId === project.id
          ? 'text-accent-foreground [--row-bg:var(--accent)]'
          : 'text-sidebar-foreground [--row-bg:var(--sidebar)] hover:[--row-bg:color-mix(in_oklab,var(--sidebar),var(--accent)_50%)] focus-within:[--row-bg:color-mix(in_oklab,var(--sidebar),var(--accent)_50%)]',
        isDragging && 'opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        data-ui="project-row-background"
        data-project-id={project.id}
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 rounded-md',
          isChild ? 'left-0' : 'left-2',
          activeProjectId === project.id
            ? 'bg-accent'
            : 'group-hover:bg-accent/50 group-focus-within:bg-accent/50 group-active:bg-accent',
        )}
      />
      {activeProjectId === project.id && (
        <span
          aria-hidden="true"
          data-ui="project-active-indicator"
          data-project-id={project.id}
          className={cn(
            'pointer-events-none absolute inset-y-1.5 z-[2] w-0.5 rounded-full bg-primary',
            isChild ? 'left-0.5' : 'left-2.5',
          )}
        />
      )}
      {containsActive && activeProjectId !== project.id && (
        <span
          aria-hidden="true"
          data-ui="project-active-ancestor-indicator"
          data-project-id={project.id}
          className="pointer-events-none absolute inset-y-1.5 left-2.5 z-[2] w-0.5 rounded-full bg-primary/40"
        />
      )}
      {isChild && (
        <>
          <span
            aria-hidden="true"
            data-ui="project-tree-connector"
            className={cn(
              'pointer-events-none absolute -left-1 top-0 w-1 border-l border-sidebar-border',
              isLastChild ? 'h-1/2 rounded-bl-sm border-b' : 'bottom-0',
            )}
          />
          {!isLastChild && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-1 top-1/2 w-1 border-t border-sidebar-border"
            />
          )}
        </>
      )}
      <div
        className={cn(
          'relative z-[1] flex items-center',
          isChild ? 'pl-3' : 'pl-2',
        )}
      >
        {isParent && onToggleCollapse && (
          <Tooltip content={isCollapsed ? 'Expand' : 'Collapse'} side="right">
            <button
              type="button"
              data-ui="project-expand-toggle"
              data-roving-item
              tabIndex={-1}
              onClick={onToggleCollapse}
              className="relative z-[2] -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:size-11"
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3 text-muted-foreground"
                />
              ) : (
                <ChevronDown
                  aria-hidden="true"
                  className="size-3 text-muted-foreground"
                />
              )}
            </button>
          </Tooltip>
        )}
        <Tooltip content={project.name} whenClipped={nameRef} side="right">
          <Link
            to={target.to}
            params={target.params}
            activeOptions={{ exact: true }}
            data-roving-item
            data-roving-primary
            tabIndex={rovingTabStop === false ? -1 : undefined}
            onClick={(event) => {
              if (reorderMode) event.preventDefault();
            }}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              isChild && 'py-1.5 text-xs',
              (activeProjectId === project.id || containsActive) &&
                'font-medium',
              'relative max-md:min-h-11',
              reorderMode
                ? 'max-md:pr-[88px] [@media(hover:none)]:pr-[88px]'
                : 'max-md:pr-11 [@media(hover:none)]:pr-11',
            )}
          >
            {isParent ? (
              <Layers className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
            ) : isWhatsApp ? (
              <Smartphone className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {/* Left of the name: the row-action overlay covers the row's right end on hover. */}
            {boxOffline && (
              <Tooltip
                content={`Host "${project.effectiveSandbox?.boxId}" is offline`}
                side="right"
              >
                <span
                  role="img"
                  data-ui="project-box-offline"
                  aria-label={`Host "${project.effectiveSandbox?.boxId}" is offline`}
                  className="shrink-0"
                >
                  <CloudOff
                    aria-hidden="true"
                    className="size-3 text-muted-foreground"
                  />
                </span>
              </Tooltip>
            )}
            {sandboxStopped && (
              <Tooltip
                content={`Sandbox "${projectSandboxName(project)}" is not running`}
                side="right"
              >
                <span
                  role="img"
                  data-ui="project-sandbox-down"
                  aria-label={`Sandbox "${projectSandboxName(project)}" is not running`}
                  className="shrink-0"
                >
                  <PowerOff
                    aria-hidden="true"
                    className="size-3 text-muted-foreground"
                  />
                </span>
              </Tooltip>
            )}
            <span
              ref={nameRef}
              data-ui="project-name"
              className={cn(
                'min-w-0 flex-1 truncate',
                (boxOffline || sandboxStopped) && 'text-muted-foreground',
              )}
            >
              {project.name}
            </span>
            {containsActive && activeProjectId !== project.id && (
              <span className="sr-only">(contains the open project)</span>
            )}
            <ProjectStatusIndicator
              projectId={project.id}
              statuses={modeStatuses}
              enabledModes={enabledModes}
            />
          </Link>
        </Tooltip>
      </div>
      <div
        data-ui="project-row-actions"
        className={cn(
          'absolute inset-y-0 right-0 z-[3] flex items-center rounded-r-md bg-[var(--row-bg)] pl-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto has-[[data-state=open]]:opacity-100 has-[[data-state=open]]:pointer-events-auto max-md:opacity-100 max-md:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto',
          reorderMode && 'opacity-100 pointer-events-auto',
        )}
      >
        <ProjectActionsMenu
          project={project}
          statuses={modeStatuses}
          sandboxDown={sandboxStopped}
          onHideFromList={
            onHideFromList && !isProjectActive(enabledModes, modeStatuses)
              ? () => onHideFromList(project.id)
              : undefined
          }
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={
            <button
              type="button"
              data-ui="project-row-menu-trigger"
              data-project-id={project.id}
              data-roving-item
              tabIndex={-1}
              // Radix opens the menu on ArrowDown; here Up/Down move through
              // the list instead (Enter, Space and Shift+F10 still open it).
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  rovingKeyDown(event);
                }
              }}
              aria-label={`Actions for ${project.name}`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:size-11"
            >
              <Ellipsis
                aria-hidden="true"
                className="size-3.5 text-muted-foreground"
              />
            </button>
          }
        />
        {sortable && !searchActive && (
          <button
            type="button"
            {...sortable.attributes}
            {...sortable.listeners}
            ref={sortable.setActivatorNodeRef}
            data-ui="project-drag-handle"
            data-project-id={project.id}
            data-roving-item
            // dnd-kit contributes role/aria-roledescription but no accessible
            // name, and a tab stop. The list is one roving tab stop, so the
            // handle is reached with ArrowRight from its row's link.
            aria-label={`Reorder ${project.name}`}
            tabIndex={-1}
            className={cn(
              'inline-flex size-6 shrink-0 cursor-grab touch-manipulation select-none items-center justify-center rounded transition-colors [-webkit-touch-callout:none] hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing max-md:size-11',
              // Touch layouts only offer the handle in Reorder mode.
              !reorderMode && 'max-md:hidden [@media(hover:none)]:hidden',
            )}
          >
            <GripVertical
              aria-hidden="true"
              className="size-3 text-muted-foreground"
            />
          </button>
        )}
      </div>
    </div>
  );
}

function WhatsAppPanel() {
  const { data: waStatus, isLoading } = useWhatsAppStatus();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const queryClient = useQueryClient();

  const status = waStatus?.status ?? 'disconnected';
  const qr = waStatus?.qr;
  const logoutLabel =
    status === 'connected'
      ? 'Disconnect WhatsApp session'
      : 'Reset session & show QR';

  const logoutMutation = useMutation({
    mutationFn: logoutWhatsApp,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp', 'status'] });
    },
  });
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (qr && canvasRef.current) {
      import('qrcode').then((QRCode) => {
        if (canvasRef.current) {
          QRCode.toCanvas(canvasRef.current, qr, {
            width: 180,
            margin: 1,
            // QR modules follow the theme so the code stays scannable on the
            // light sidebar too (dark modules on transparent in light mode).
            color: {
              dark: resolvedTheme === 'dark' ? '#ffffffee' : '#000000ee',
              light: '#00000000',
            },
          });
        }
      });
    }
  }, [qr, resolvedTheme]);

  return (
    <div className="p-3 border-t border-sidebar-border">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'size-2.5 rounded-full',
            isLoading
              ? 'bg-yellow-700 dark:bg-yellow-500 animate-pulse'
              : status === 'connected'
                ? 'bg-green-600 dark:bg-green-500'
                : status === 'qr_pending'
                  ? 'bg-yellow-700 dark:bg-yellow-500 animate-pulse'
                  : 'bg-red-600 dark:bg-red-500',
          )}
        />
        <span className="text-xs md:text-sm text-muted-foreground flex-1">
          {isLoading
            ? 'Checking...'
            : status === 'connected'
              ? 'WhatsApp connected'
              : status === 'qr_pending'
                ? 'Scan QR to connect'
                : 'WhatsApp disconnected'}
        </span>
        {(status === 'connected' || status === 'disconnected') && (
          <Tooltip content={logoutLabel} side="right">
            <button
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              className="text-muted-foreground hover:text-red-600 dark:hover:text-red-500 transition-colors"
              aria-label={logoutLabel}
            >
              {logoutMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : status === 'connected' ? (
                <LogOut className="size-3.5" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </button>
          </Tooltip>
        )}
      </div>

      {status === 'qr_pending' && qr && (
        <div className="mt-2 flex justify-center">
          <canvas ref={canvasRef} className="rounded" />
        </div>
      )}
    </div>
  );
}

const reloadCurrentPage = () => window.location.reload();

/** "1 reflector, 2 memory audits" from the server's in-flight counts. */
function formatWaitingOn(waitingOn: Record<string, number> | undefined) {
  return Object.entries(waitingOn ?? {})
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}${count > 1 ? 's' : ''}`)
    .join(', ');
}

export function RestartBanner({
  reloadPage = reloadCurrentPage,
}: {
  reloadPage?: () => void;
} = {}) {
  // Driven solely by the recoverable build-status query: readiness survives
  // sidebar close/reopen, route changes, app background/foreground, and
  // WebSocket reconnects to the same process, and clears once the new server
  // process answers the status endpoint (deploy events only invalidate it).
  // If the server process dies while a build is in flight, the in-memory
  // status dies with it and failed refetches keep the stale 'building'
  // banner up — by design. It self-heals as soon as any probe lands: the
  // 2s building refetch, a WebSocket reconnect, the health poll, or a
  // window-focus refetch reaching a process that reports its fresh state.
  const { data: buildStatus, error: buildStatusError } = useQuery({
    queryKey: queryKeys.serverWebBuild,
    queryFn: fetchServerWebBuildStatus,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.status === 'building' ||
      query.state.data?.restartPending
        ? 2000
        : false,
  });
  const queryClient = useQueryClient();
  const status = buildStatus?.status;
  const restartPending = buildStatus?.restartPending === true;
  const waitingOn = formatWaitingOn(buildStatus?.waitingOn);
  const pending = status === 'ready';
  const building = status === 'building';
  const deviceClockOutOfSync =
    buildStatusError instanceof ApiError &&
    buildStatusError.status === 401 &&
    (buildStatusError.message === 'Stale biometric signature' ||
      buildStatusError.message === 'Stale timestamp');
  const [restarting, setRestarting] = useState(false);
  const serverRestarted = useStore((state) => state.serverRestarted);
  const setServerRestarted = useStore((state) => state.setServerRestarted);
  // This device asked for a restart. Unlike `restarting` (button state, cleared
  // once the status leaves 'ready'), it survives the new process answering the
  // status refetch before the server_restarted handshake arrives.
  const restartRequested = useRef(false);

  useEffect(() => {
    if (!pending) setRestarting(false);
  }, [pending]);

  const prevRestartPending = useRef(false);

  useEffect(() => {
    // The native shell serves the installed bundle, so a reload would only
    // restart the old UI; AndroidOtaController applies the new bundle instead.
    if (isAndroidNative()) return;
    const pendingStarted = restartPending && !prevRestartPending.current;
    prevRestartPending.current = restartPending;
    if (pendingStarted && !restartRequested.current) {
      // A restart this device did not request was pending: a `serverRestarted`
      // left over from an earlier restart is stale, and the old process is still
      // serving. Only a handshake from the new process may trigger the reload.
      setServerRestarted(false);
      return;
    }
    if ((restartRequested.current || restartPending) && serverRestarted) {
      restartRequested.current = false;
      reloadPage();
    }
  }, [reloadPage, restartPending, serverRestarted, setServerRestarted]);

  const refreshBuildStatus = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.serverWebBuild });
  const requestRestart = (force: boolean) => {
    setServerRestarted(false);
    restartRequested.current = true;
    setRestarting(true);
    if (isAndroidNative()) armAndroidOtaAutoApply();
    restartBoard({ force })
      .then(refreshBuildStatus)
      .catch(() => {
        clearAndroidOtaAutoApply();
        restartRequested.current = false;
        setRestarting(false);
      });
  };
  const cancelRestart = () => {
    clearAndroidOtaAutoApply();
    restartRequested.current = false;
    setRestarting(false);
    cancelPendingBoardRestart()
      .catch(() => {})
      .finally(refreshBuildStatus);
  };

  if (deviceClockOutOfSync) {
    return (
      <div
        data-ui="device-clock-error"
        role="alert"
        className="px-3 py-2 border-t border-destructive/40 bg-destructive/10"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-1">
            <p className="text-xs md:text-sm font-medium text-destructive">
              Device time is out of sync
            </p>
            <p className="text-xs text-muted-foreground">
              Synchronize the date and time, then reload this page.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Waiting for background jobs before restarting. With nothing left in
  // flight the server is already restarting, so the plain button state shows.
  if (restartPending && waitingOn) {
    return (
      <div
        data-ui="board-restart-pending"
        className="px-3 py-2 border-t border-sidebar-border"
      >
        <div className="flex items-start gap-2">
          <Loader2 className="size-3.5 mt-0.5 shrink-0 animate-spin text-amber-700 dark:text-amber-500" />
          <span
            data-ui="board-restart-pending-waiting-on"
            className="min-w-0 text-xs md:text-sm text-amber-700 dark:text-amber-400"
          >
            Restart pending — waiting for {waitingOn}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            data-ui="board-restart-cancel"
            className="h-6 md:h-7 px-2 text-xs md:text-sm text-muted-foreground"
            onClick={cancelRestart}
          >
            Cancel
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-ui="board-restart-now"
            className="h-6 md:h-7 px-2 text-xs md:text-sm text-amber-700 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={() => requestRestart(true)}
          >
            <RotateCcw className="size-3 mr-1" />
            Restart now
          </Button>
        </div>
      </div>
    );
  }

  if (status === 'failed' && buildStatus?.output) {
    return (
      <div
        data-ui="board-build-failed"
        className="px-3 py-2 border-t border-destructive/40 bg-destructive/10"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
            <span className="text-xs md:text-sm text-destructive">
              Build failed
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-ui="board-build-view-log"
            className="h-6 md:h-7 px-2 text-xs md:text-sm text-destructive hover:text-destructive"
            onClick={() => showBuildLog(buildStatus.output!)}
          >
            View log
          </Button>
        </div>
      </div>
    );
  }

  if (!pending && !building && !restartPending) return null;

  return (
    <div
      data-ui="board-restart-banner"
      className="px-3 py-2 border-t border-sidebar-border"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="size-3.5 shrink-0 text-amber-700 dark:text-amber-500" />
          <span className="text-xs md:text-sm text-amber-700 dark:text-amber-400 whitespace-nowrap">
            {building ? 'Building...' : 'New build'}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 md:h-7 px-2 text-xs md:text-sm text-amber-700 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300"
          disabled={restarting || restartPending || building}
          onClick={() => requestRestart(false)}
        >
          {restarting ? (
            <Loader2 className="size-3 animate-spin mr-1" />
          ) : building ? null : (
            <RotateCcw className="size-3 mr-1" />
          )}
          {restarting || restartPending
            ? 'Restarting...'
            : building
              ? 'Please wait'
              : 'Restart'}
        </Button>
      </div>
    </div>
  );
}

/** Sandbox instance URL link; the full URL appears on hover only when clipped. */
function InstanceUrlLink({
  url,
  className,
}: {
  url: string;
  className?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  return (
    <Tooltip content={url} whenClipped={textRef} side="right">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex max-w-full items-center gap-1 text-xs md:text-sm text-cyan-700 hover:text-cyan-600 dark:text-cyan-400 dark:hover:text-cyan-300',
          className,
        )}
      >
        <ExternalLink className="size-2.5 shrink-0" />
        <span ref={textRef} className="truncate">
          {url}
        </span>
      </a>
    </Tooltip>
  );
}

function SandboxPanel() {
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };
  const { data: projects } = useProjects();

  // Find the selected project to get its folder and stack
  const selectedProject = projects?.find((p) => p.id === projectId);
  const group_folder = selectedProject?.folder;
  const { stack, instance: effectiveInstance } =
    projectSandboxTarget(selectedProject);
  const lifecycleManaged = sandboxLifecycleIsManaged(selectedProject);
  const publicationEnabled =
    selectedProject?.settings?.appPublication?.enabled === true;
  const { data: publication } = usePublishedApp(
    group_folder,
    publicationEnabled,
  );
  const publishedAppUrl =
    publicationEnabled && publication?.enabled ? publication.url : undefined;

  const { data: status, isLoading } = useSandboxStatus(group_folder);
  const { data: allInstances } = useSandboxPs();
  const { data: selectedInstances } = useSandboxInstancePs(effectiveInstance);
  const startMutation = useStartSandbox();
  const restartMutation = useRestartSandbox();
  const restartWhenIdleMutation = useRestartSandboxWhenIdle();
  const cancelPendingMutation = useCancelPendingRestart();
  const [expanded, setExpanded] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const publishedAppUrlRef = useRef<HTMLSpanElement>(null);
  const restartingSandboxes = useStore((s) => s.restartingSandboxes);
  const authUser = useAuth((s) => s.user);
  // An immediate restart or stop interrupts running work: owners (and admins) only.
  const canRestartNow = canEditRepositoryConnection(selectedProject, authUser);

  // Determine if the selected group's sandbox is running
  const statusKey = group_folder || Object.keys(status ?? {})[0];
  const groupStatus = statusKey
    ? (status as Record<string, Record<string, unknown>> | undefined)?.[
        statusKey
      ]
    : undefined;
  // Degraded: some services run while another crash-loops (restarting/dead).
  const isDegraded = groupStatus?.status === 'degraded';
  const isRunning = groupStatus?.status === 'running' || isDegraded;
  const isRestarting =
    !!effectiveInstance && !!restartingSandboxes[effectiveInstance];
  const { data: pendingRestart } = useSandboxPendingRestart(
    stack,
    group_folder,
    lifecycleManaged,
  );
  const restartWaitingOn =
    pendingRestart?.pending === true
      ? [
          [pendingRestart.waitingOn.taskRuns, 'task'],
          [pendingRestart.waitingOn.chatRuns, 'chat'],
          [pendingRestart.waitingOn.launches ?? 0, 'launch'],
          [pendingRestart.waitingOn.brainRuns, 'objective'],
          [pendingRestart.waitingOn.builds ?? 0, 'build'],
          [pendingRestart.waitingOn.holds ?? 0, 'restart hold'],
        ]
          .filter(([count]) => (count as number) > 0)
          .map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`)
          .join(', ')
      : '';

  // Find the current project's sandbox instance and separate from others
  const currentInstance = effectiveInstance
    ? (selectedInstances ?? allInstances ?? []).find((i) =>
        isSandboxInstanceMatch(i, stack, effectiveInstance),
      )
    : undefined;
  const otherInstances = (allInstances ?? []).filter((i) =>
    effectiveInstance
      ? !isSandboxInstanceMatch(i, stack, effectiveInstance)
      : true,
  );
  const otherRunningCount = otherInstances.length;

  // Extract per-container version status from the sandbox status response
  const containers = (groupStatus as any)?.containers as
    | Array<{ service: string; upToDate: boolean | null }>
    | undefined;
  const versionableContainers =
    containers?.filter((c) => c.upToDate !== null) ?? [];

  const aggregatedVersionStatus = computeAggregatedVersionStatus(containers);

  const versionTitle = aggregatedVersionStatus
    ? versionableContainers
        .map((c) =>
          c.upToDate
            ? `${c.service}: up to date`
            : `${c.service}: outdated — newer image available`,
        )
        .join('\n')
    : '';

  return (
    <div data-ui="sidebar-sandbox-panel" className="px-3 pt-0.5 pb-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tooltip
            content={group_folder ? 'Sandbox details' : null}
            side="right"
            redundant={false}
          >
            <button
              type="button"
              onClick={() => {
                if (group_folder) setInfoOpen(true);
              }}
              disabled={!group_folder}
              className={cn(
                'flex items-center gap-2 min-w-0 text-left rounded max-md:min-h-11',
                group_folder &&
                  'cursor-pointer hover:text-foreground transition-colors -mx-1 px-1 -my-0.5 py-0.5 hover:bg-accent/40',
                !group_folder && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'size-2.5 rounded-full shrink-0',
                  isLoading
                    ? 'bg-yellow-700 dark:bg-yellow-500 animate-pulse'
                    : isRestarting
                      ? 'bg-orange-600 dark:bg-orange-500 animate-pulse'
                      : !lifecycleManaged
                        ? 'bg-slate-600 dark:bg-slate-500'
                        : isDegraded
                          ? 'bg-amber-600 dark:bg-amber-500 animate-pulse'
                          : isRunning
                            ? 'bg-green-600 dark:bg-green-500'
                            : 'bg-red-600 dark:bg-red-500',
                )}
              />
              <span className="text-xs md:text-sm text-muted-foreground truncate">
                {!group_folder
                  ? 'Select a project'
                  : isLoading
                    ? 'Checking...'
                    : isRestarting
                      ? 'Restarting...'
                      : !lifecycleManaged
                        ? 'Sandbox externally managed'
                        : isDegraded
                          ? 'Sandbox service crash-looping'
                          : isRunning
                            ? `Sandbox running`
                            : `Sandbox stopped`}
              </span>
            </button>
          </Tooltip>
          {aggregatedVersionStatus && (
            <Tooltip content={versionTitle} side="right">
              <span role="img" aria-label={versionTitle.replace(/\n/g, ', ')}>
                {aggregatedVersionStatus === 'up-to-date' ? (
                  <Check className="size-3 shrink-0 text-green-700 dark:text-green-500" />
                ) : aggregatedVersionStatus === 'outdated' ? (
                  <AlertCircle className="size-3 shrink-0 text-amber-700 dark:text-amber-500" />
                ) : (
                  <HelpCircle className="size-3 shrink-0 text-muted-foreground/50" />
                )}
              </span>
            </Tooltip>
          )}
        </div>
        {group_folder && lifecycleManaged && (
          <div className="flex items-center gap-0.5">
            {isRunning && !pendingRestart?.pending && (
              <Tooltip content="Restart when idle" side="top">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="max-md:size-11"
                  data-ui="sidebar-sandbox-restart-when-idle"
                  aria-label="Restart sandbox when idle"
                  onClick={() =>
                    restartWhenIdleMutation.mutate({
                      stack,
                      group: group_folder,
                    })
                  }
                  disabled={restartWhenIdleMutation.isPending || isRestarting}
                >
                  {restartWhenIdleMutation.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Clock className="size-3" />
                  )}
                </Button>
              </Tooltip>
            )}
            {!isRunning && (
              <Tooltip content="Start" side="top">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="max-md:size-11"
                  aria-label="Start"
                  onClick={() =>
                    startMutation.mutate({ stack, group: group_folder })
                  }
                  disabled={startMutation.isPending}
                >
                  {startMutation.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Power className="size-3" />
                  )}
                </Button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {group_folder && pendingRestart?.pending && (
        <div
          data-ui="sidebar-sandbox-restart-pending"
          className="mt-1.5 ml-5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs md:text-sm text-muted-foreground"
        >
          <span className="min-w-0">
            Restart pending
            {restartWaitingOn ? ` — waiting on ${restartWaitingOn}` : ''}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              data-ui="sidebar-sandbox-restart-cancel"
              className="max-md:h-11"
              onClick={() =>
                cancelPendingMutation.mutate({ stack, group: group_folder })
              }
              disabled={cancelPendingMutation.isPending}
            >
              Cancel
            </Button>
            {canRestartNow && (
              <Button
                variant="ghost"
                size="xs"
                data-ui="sidebar-sandbox-restart-now"
                className="max-md:h-11"
                onClick={async () => {
                  const confirmed = await confirmAction(
                    `${
                      restartWaitingOn
                        ? `Still running: ${restartWaitingOn}. `
                        : ''
                    }Runs still in progress are interrupted.`,
                    {
                      title: 'Restart sandbox now?',
                      confirmLabel: 'Restart now',
                      destructive: true,
                    },
                  );
                  if (confirmed)
                    restartMutation.mutate({ stack, group: group_folder });
                }}
                disabled={restartMutation.isPending || isRestarting}
              >
                {restartMutation.isPending || isRestarting ? (
                  <Loader2 className="size-3 mr-1 animate-spin" />
                ) : (
                  <RotateCcw className="size-3 mr-1" />
                )}
                Restart now
              </Button>
            )}
          </div>
        </div>
      )}

      {publishedAppUrl && (
        <div className="mt-1.5 ml-5 min-w-0">
          <Tooltip
            content={() => {
              const clipped = isTextClipped(publishedAppUrlRef.current);
              if (!clipped && publication?.ready) return null;
              return (
                <>
                  {clipped && <span className="block">{publishedAppUrl}</span>}
                  {!publication?.ready && (
                    <span className="block">Route not ready</span>
                  )}
                </>
              );
            }}
            side="right"
          >
            <a
              href={publishedAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-ui="sidebar-published-app-link"
              data-project-id={projectId}
              className="flex max-w-full items-center gap-1 text-xs md:text-sm text-cyan-700 hover:text-cyan-600 dark:text-cyan-400 dark:hover:text-cyan-300"
              aria-label={`Open published app for ${selectedProject?.name}${publication?.ready ? '' : ' (route not ready)'}`}
            >
              <ExternalLink className="size-3 shrink-0" />
              <span ref={publishedAppUrlRef} className="truncate">
                {publishedAppUrl}
              </span>
            </a>
          </Tooltip>
        </div>
      )}

      {currentInstance && currentInstance.services.length > 0 && (
        <div className="mt-1.5 ml-5 text-muted-foreground overflow-hidden">
          {!isRestarting && <SandboxSshLink ssh={currentInstance.ssh} />}
          {!isRestarting &&
            currentInstance.url &&
            currentInstance.url !== publishedAppUrl && (
              <InstanceUrlLink url={currentInstance.url} className="mb-1" />
            )}
          {currentInstance.services.map((svc) => {
            return (
              <div key={svc.hostname} className="text-xs md:text-sm min-w-0">
                <span className="flex items-center gap-1 min-w-0">
                  <span className="shrink-0">{svc.service} —</span>
                  <CopyableText
                    text={svc.hostname}
                    className="text-xs md:text-sm text-muted-foreground"
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {otherRunningCount > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 text-xs md:text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            <Server className="size-3" />
            <span>
              {otherRunningCount} other sandbox
              {otherRunningCount !== 1 ? 'es' : ''}
            </span>
          </button>
          {expanded && (
            <div className="mt-1.5 ml-3 space-y-1">
              {otherInstances.map((instance) => {
                const instanceFolder =
                  instance.instance ??
                  (instance.name.includes('-')
                    ? instance.name.split('-').slice(1).join('-')
                    : instance.name);
                const isOtherRestarting =
                  !!restartingSandboxes[instanceFolder] ||
                  !!restartingSandboxes[instance.name];
                const isOtherDegraded = instance.services.some(
                  (s) => s.status === 'restarting' || s.status === 'dead',
                );
                return (
                  <div key={instance.name} className="text-xs md:text-sm">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          isOtherRestarting
                            ? 'bg-orange-600 dark:bg-orange-500 animate-pulse'
                            : isOtherDegraded
                              ? 'bg-amber-600 dark:bg-amber-500 animate-pulse'
                              : 'bg-green-600 dark:bg-green-500',
                        )}
                      />
                      <CopyableText
                        text={instance.name}
                        className="font-medium text-foreground text-xs md:text-sm"
                      />
                    </div>
                    {!isOtherRestarting && instance.url && (
                      <InstanceUrlLink url={instance.url} className="ml-3" />
                    )}
                    {instance.services.length > 0 && (
                      <div className="ml-3 text-muted-foreground overflow-hidden">
                        {!isOtherRestarting && (
                          <SandboxSshLink ssh={instance.ssh} />
                        )}
                        {instance.services.map((svc) => (
                          <div key={svc.hostname} className="min-w-0">
                            <span className="flex items-center gap-1 min-w-0">
                              <span className="shrink-0">{svc.service} —</span>
                              <CopyableText
                                text={svc.hostname}
                                className="text-xs md:text-sm text-muted-foreground"
                              />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <SandboxInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        projectId={projectId}
        canStop={canRestartNow}
      />
    </div>
  );
}
