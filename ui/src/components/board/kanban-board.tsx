import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type {
  Announcements,
  CollisionDetection,
  KeyboardCoordinateGetter,
  DragStartEvent,
  DragEndEvent,
  DragCancelEvent,
  DragMoveEvent,
  DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  X,
  Trash2,
  Play,
  Square,
  RotateCcw,
  Archive,
  ArchiveRestore,
  Target,
  History,
  MoreHorizontal,
  SlidersHorizontal,
} from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { useTasks } from '@/hooks/use-tasks';
import { useCronjobs } from '@/hooks/use-cronjobs';
import { useDatasetTasks } from '@/hooks/use-dataset-tasks';
import { useScheduledTasks } from '@/hooks/use-scheduled-tasks';
import {
  useMoveTask,
  useUpdateTask,
  useBulkDeleteTasks,
  useBulkExecuteTasks,
  useBulkStartOverTasks,
  useBulkStopTasks,
  useBulkUpdateTasks,
  useMergingTasks,
  applyMergingTasks,
} from '@/hooks/use-task-mutations';
import { useAttributionMembers } from '@/hooks/use-attribution-members';
import { useProjects } from '@/hooks/use-projects';
import { queryKeys } from '@/lib/query-keys';
import { fetchObjectives, fetchReferencedObjectives } from '@/lib/api';
import { QueryErrorState } from '@/components/layout/query-error-state';
import {
  computeInsertPlacement,
  computeReorderUpdates,
} from '@/lib/kanban-reorder';
import { KanbanColumn } from './kanban-column';
import { KanbanCard } from './kanban-card';
import { CronjobCard } from './cronjob-card';
import { DatasetTaskCard } from './dataset-task-card';
import { ScheduledTaskCard } from './scheduled-task-card';
import {
  findStage,
  getActiveStage,
  getEffectiveProjectStages,
  getInitialStage,
  sortTasksForStage,
} from '@/lib/stages';
import type {
  StageDefinition,
  Task,
  TaskSummary,
  TaskStatus,
  Objective,
  BoardReplayRun,
  BoardReplayData,
} from '@/types';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { confirmAction } from '@/components/confirm-dialog';
import { BoardReplayPlayer, defaultReplayRange } from './board-replay';
import {
  isDesktopViewport,
  useBoardCollapsibleExpanded,
} from './use-board-strip-expanded';

const PAGE_SIZE = 20;
const EMPTY_TASKS: TaskSummary[] = [];

const formatTaskCount = (count: number) =>
  `${count} task${count === 1 ? '' : 's'}`;

/** Where a card dragged out of its column would land in another column. */
interface CrossPreview {
  stageId: string;
  /** Insertion index in the destination's visible list (dragged card excluded). */
  index: number;
  /**
   * The destination is a collapsed stage, which renders no cards. The drop
   * still lands there, but the dragged card stays mounted in its source column
   * meanwhile: unmounting it would leave dnd-kit without an active node and
   * stop the edge auto-scroll.
   */
  collapsed?: boolean;
}

interface KanbanBoardProps {
  project_id: string;
}

// Column a droppable belongs to: cards resolve to the column they are rendered
// in (an inactive-stage task renders in the fallback column, not under its raw
// status); columns use the stage id.
const droppableStage = (
  container: {
    id: string | number;
    data: { current?: { task?: { id?: string } } };
  },
  columnOf: (taskId: string) => string | undefined,
) => {
  const taskId = container.data.current?.task?.id;
  return (taskId && columnOf(taskId)) || String(container.id);
};

/**
 * Screen-reader texts for keyboard drags. They name the task by title and the
 * stage by title (an over-card resolves to that card's stage) rather than
 * exposing dnd-kit's raw draggable/droppable ids.
 */
export function buildKanbanAnnouncements(
  tasks: Pick<TaskSummary, 'id' | 'title' | 'status'>[],
  stages: StageDefinition[],
  // Column a task is rendered in; defaults to its raw status.
  columnOf?: (taskId: string) => string | undefined,
): Announcements {
  const taskById = (id: string | number) => tasks.find((t) => t.id === id);
  const stageOfTask = (id: string | number) =>
    columnOf?.(String(id)) ?? taskById(id)?.status;
  const taskLabel = (id: string | number) => {
    const title = taskById(id)?.title?.trim();
    return title ? `task "${title}"` : 'task';
  };
  const stageTitle = (stageId: string) =>
    findStage(stages, stageId)?.title ?? stageId;
  // Stage an over target stands for: a stage droppable or a card's stage.
  const overStage = (over: { id: string | number } | null) => {
    if (!over) return undefined;
    const id = String(over.id);
    if (findStage(stages, id)) return stageTitle(id);
    const overStageId = taskById(over.id) && stageOfTask(over.id);
    return overStageId ? stageTitle(overStageId) : undefined;
  };

  return {
    onDragStart: ({ active }) => {
      const stage = stageOfTask(active.id);
      return `Picked up ${taskLabel(active.id)}${
        stage ? ` from stage ${stageTitle(stage)}` : ''
      }.`;
    },
    onDragOver: ({ active, over }) => {
      const stage = overStage(over);
      return stage
        ? `${taskLabel(active.id)} is over stage ${stage}.`
        : `${taskLabel(active.id)} is not over a stage.`;
    },
    onDragEnd: ({ active, over }) => {
      const stage = overStage(over);
      if (!stage) return `${taskLabel(active.id)} was dropped. No change.`;
      const from = stageOfTask(active.id);
      return from && stageTitle(from) === stage
        ? `${taskLabel(active.id)} dropped in stage ${stage}.`
        : `${taskLabel(active.id)} moved to stage ${stage}.`;
    },
    onDragCancel: ({ active }) => {
      const stage = stageOfTask(active.id);
      return `Drag cancelled. ${taskLabel(active.id)} returned${
        stage ? ` to stage ${stageTitle(stage)}` : ''
      }.`;
    },
  };
}

// After a keyboard drag the dragged card can remount several times: in the
// target column, when a queue stage auto-advances it, and when a failed move or
// merge rolls it back, possibly long after the drop. Focus the card after the
// next frame, then re-focus it whenever a remount drops focus to <body>. The
// restore ends when the user interacts (key press, pointer press, or focus
// moving elsewhere), when another restore starts, or when the board unmounts.
let cancelCardFocusRestore: (() => void) | null = null;

function restoreCardFocus(taskId: string) {
  cancelCardFocusRestore?.();
  const findCard = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-ui="kanban-card"]'),
    ).find((el) => el.dataset.taskId === taskId);
  const focusCard = () => findCard()?.focus();
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as Element | null;
    if (target && target !== findCard()) stop();
  };
  let observer: MutationObserver | null = null;
  const stop = () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('keydown', stop, true);
    window.removeEventListener('pointerdown', stop, true);
    window.removeEventListener('focusin', onFocusIn, true);
    if (cancelCardFocusRestore === stop) cancelCardFocusRestore = null;
  };
  cancelCardFocusRestore = stop;
  const frame = requestAnimationFrame(() => {
    focusCard();
    observer = new MutationObserver(() => {
      if (document.activeElement === document.body) focusCard();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Registered after the dropping key event has finished dispatching.
    window.addEventListener('keydown', stop, true);
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('focusin', onFocusIn, true);
  });
}

// Vertical midpoint of an element as laid out, without the translation that
// sortable applies while cards slide apart (scaling keeps the centre fixed).
function layoutTopY(el: Element) {
  const shift = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
  return el.getBoundingClientRect().top - shift;
}

function layoutMidpointY(el: Element) {
  return layoutTopY(el) + el.getBoundingClientRect().height / 2;
}

const isKeyboardDrag = (activatorEvent: Event | null) =>
  activatorEvent?.type === 'keydown';

// ArrowLeft/ArrowRight must move the dragged card to the adjacent column, not
// to a sibling card of the column it is currently over, so candidates in that
// column are excluded. Up/Down keep the default in-column reordering.
// `getPreviewStage` names the column the dragged card is previewed in: its own
// droppable still carries the column it came from. `columnOf` resolves a card
// to the column it is rendered in.
const kanbanKeyboardCoordinates =
  (
    getPreviewStage: () => string | undefined,
    columnOf: (taskId: string) => string | undefined,
  ): KeyboardCoordinateGetter =>
  (event, args) => {
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      const { active, over, droppableContainers } = args.context;
      const currentStage = over
        ? over.id === active?.id
          ? (getPreviewStage() ?? droppableStage(over, columnOf))
          : droppableStage(over, columnOf)
        : columnOf(active?.id as string);
      return sortableKeyboardCoordinates(event, {
        ...args,
        context: {
          ...args.context,
          droppableContainers: {
            get: (id: string | number) => droppableContainers.get(id),
            getEnabled: () =>
              droppableContainers
                .getEnabled()
                .filter((c) => droppableStage(c, columnOf) !== currentStage),
          } as typeof droppableContainers,
        },
      });
    }
    return sortableKeyboardCoordinates(event, args);
  };

export function KanbanBoard({ project_id }: KanbanBoardProps) {
  const navigate = useNavigate();
  const [ownerUserId, setOwnerUserId] = useState('');
  const [triggeredByUserId, setTriggeredByUserId] = useState('');
  const liveTasksQuery = useTasks(project_id, {
    ownerUserId: ownerUserId || undefined,
    triggeredByUserId: triggeredByUserId || undefined,
  });
  const mergingTasks = useMergingTasks(project_id);
  const liveTasks = useMemo(
    () => applyMergingTasks(liveTasksQuery.data ?? EMPTY_TASKS, mergingTasks),
    [liveTasksQuery.data, mergingTasks],
  );
  const { members: attributionMembers, canList: canListMembers } =
    useAttributionMembers(project_id);
  const { data: cronjobs = [] } = useCronjobs(project_id);
  const { data: archivedCronjobs = [] } = useCronjobs(project_id, {
    archived: true,
  });
  const { data: datasetTasks = [] } = useDatasetTasks(project_id);
  const { data: archivedDatasetTasks = [] } = useDatasetTasks(project_id, {
    archived: true,
  });
  const { data: scheduledTasks = [] } = useScheduledTasks(project_id);
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === project_id);
  const stages = useMemo(
    () => getEffectiveProjectStages(project).filter((stage) => !stage.inactive),
    [project],
  );
  const qc = useQueryClient();
  const { moveTask, bulkMoveTasks } = useMoveTask(project_id);
  const { mutate: updateTask, mutateAsync: updateTaskAsync } =
    useUpdateTask(project_id);
  const { mutate: bulkDeleteTasks } = useBulkDeleteTasks(project_id);
  const { mutate: bulkExecute } = useBulkExecuteTasks(project_id);
  const { mutate: bulkStop } = useBulkStopTasks(project_id);
  const { mutate: bulkStartOver } = useBulkStartOverTasks(project_id);
  const { mutate: bulkUpdate } = useBulkUpdateTasks(project_id);

  const [activeTask, setActiveTask] = useState<Task | null>(null);
  // Drag-time override only: it changes what the board renders until the drop,
  // never the cached task data.
  const [crossPreview, setCrossPreview] = useState<CrossPreview | null>(null);
  const crossPreviewRef = useRef<CrossPreview | null>(null);
  // A dropped card keeps its slot while the priority updates it depends on are
  // saved, so it does not jump back to its source column in between.
  // Tracked per task so overlapping drops do not overwrite each other.
  const [pendingDrops, setPendingDrops] = useState<
    Record<string, CrossPreview & { taskId: string }>
  >({});
  const columnOfTaskRef = useRef<Map<string, string>>(new Map());
  // Latest raw pointer position of a pointer drag, recorded by the collision
  // detection. The drag-move `delta` is scroll-adjusted by the dragged card's
  // scrollable ancestors, which change when the card is previewed in another
  // column, so it cannot be used to locate the pointer.
  const keyboardDragRef = useRef(false);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const updateCrossPreview = useCallback((next: CrossPreview | null) => {
    const current = crossPreviewRef.current;
    if (current?.stageId === next?.stageId && current?.index === next?.index) {
      return;
    }
    crossPreviewRef.current = next;
    setCrossPreview(next);
  }, []);
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>(
    {},
  );
  const [automationsExpanded, setAutomationsExpanded] =
    useBoardCollapsibleExpanded(project_id, 'automations', isDesktopViewport);
  const [archivedAutomationsExpanded, setArchivedAutomationsExpanded] =
    useBoardCollapsibleExpanded(project_id, 'archivedAutomations', () => false);
  const [scheduledTasksExpanded, setScheduledTasksExpanded] =
    useBoardCollapsibleExpanded(
      project_id,
      'scheduledTasks',
      isDesktopViewport,
    );
  const [objectivesExpanded, setObjectivesExpanded] =
    useBoardCollapsibleExpanded(project_id, 'objectives', () => true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // `seq` keys the announcement node so repeating an identical message still
  // mutates the live region and is announced again.
  const [bulkAnnouncement, setBulkAnnouncement] = useState({
    seq: 0,
    text: '',
  });
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const bulkMovePickedRef = useRef(false);
  // Column widths derive from the scroll region itself (not the viewport) so
  // the sidebar and workspace pane are accounted for and the next column peeks.
  // The same measurement drives the right-edge fade shown while more columns
  // are scrollable (data-more-right on the frame around the region).
  const scrollRegionCleanupRef = useRef<(() => void) | null>(null);
  const setScrollRegion = useCallback((node: HTMLDivElement | null) => {
    scrollRegionRef.current = node;
    scrollRegionCleanupRef.current?.();
    scrollRegionCleanupRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const publish = () => {
      node.style.setProperty('--kanban-region-width', `${node.clientWidth}px`);
      const hasMoreRight =
        node.scrollLeft + node.clientWidth < node.scrollWidth - 4;
      node.parentElement?.setAttribute('data-more-right', String(hasMoreRight));
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', publish, { passive: true });
    scrollRegionCleanupRef.current = () => {
      observer.disconnect();
      node.removeEventListener('scroll', publish);
    };
  }, []);
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // '' = "All objectives" (show everything, including tasks not tied to any
  // objective); otherwise only tasks tagged with that objective_id.
  const [selectedObjective, setSelectedObjective] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [replayMode, setReplayMode] = useState(false);
  const [replayRange, setReplayRange] = useState(() => defaultReplayRange());
  const [replayTasks, setReplayTasks] = useState<TaskSummary[]>([]);
  const [replayRuns, setReplayRuns] = useState<Map<string, BoardReplayRun>>(
    new Map(),
  );
  const [replayActiveTaskIds, setReplayActiveTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const [replayReviewedTaskIds, setReplayReviewedTaskIds] = useState<
    Set<string>
  >(new Set());
  // Replay is a derived visual projection only. While a historical run is
  // active, render its card in the stage recorded on that run without ever
  // writing the status back to the task API/database.
  const tasks = useMemo(() => {
    if (!replayMode) return liveTasks;
    return replayTasks.map((task) => {
      const run = replayRuns.get(task.id);
      return run?.status === 'running' && run.stage
        ? { ...task, status: run.stage, running: true }
        : { ...task, running: false };
    });
  }, [liveTasks, replayMode, replayRuns, replayTasks]);

  const handleReplayFrame = useCallback(
    (
      nextTasks: TaskSummary[],
      nextRuns: Map<string, BoardReplayRun>,
      data: BoardReplayData | undefined,
      at: number,
    ) => {
      setReplayTasks(nextTasks);
      setReplayRuns(nextRuns);
      setReplayActiveTaskIds(
        new Set(data?.runs.map((run) => run.task_id) ?? []),
      );
      const exactBoundary = data?.exactHistoryAvailableFrom
        ? new Date(data.exactHistoryAvailableFrom).getTime()
        : null;
      const exactStateAvailable = exactBoundary === null || at >= exactBoundary;
      const reviewed = new Set<string>();
      for (const task of nextTasks) {
        if (
          exactStateAvailable &&
          (task.custom_values?.quality_score != null ||
            (typeof task.custom_values?.rejection_count === 'number' &&
              task.custom_values.rejection_count > 0))
        ) {
          reviewed.add(task.id);
        }
      }
      for (const run of data?.runs ?? []) {
        if (
          run.completed_at &&
          new Date(run.completed_at).getTime() <= at &&
          run.stage &&
          findStage(stages, run.stage)?.type === 'review'
        ) {
          reviewed.add(run.task_id);
        }
      }
      for (const milestone of data?.reviewMilestones ?? []) {
        if (new Date(milestone.occurred_at).getTime() <= at) {
          reviewed.add(milestone.task_id);
        }
      }
      setReplayReviewedTaskIds(reviewed);
    },
    [stages],
  );

  const exitReplay = useCallback(() => {
    setReplayMode(false);
    setReplayTasks([]);
    setReplayRuns(new Map());
    setReplayActiveTaskIds(new Set());
    setReplayReviewedTaskIds(new Set());
    qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
  }, [project_id, qc]);

  const {
    data: objectives = [],
    isError: objectivesError,
    refetch: refetchObjectives,
  } = useQuery<Objective[]>({
    queryKey: queryKeys.objectives.all(project_id),
    queryFn: () => fetchObjectives(project_id),
    staleTime: 30_000,
  });
  // Cards can reference an objective owned by a parent project, which the
  // project's own objective list does not include.
  const { data: referencedObjectives = [] } = useQuery({
    queryKey: queryKeys.objectives.referenced(project_id),
    queryFn: () => fetchReferencedObjectives(project_id),
    staleTime: 30_000,
  });
  const objectiveTitles = useMemo(
    () =>
      new Map(
        [...referencedObjectives, ...objectives].map((objective) => [
          objective.id,
          objective.title,
        ]),
      ),
    [referencedObjectives, objectives],
  );
  const objectiveStatuses = useMemo(
    () =>
      new Map(
        [...referencedObjectives, ...objectives].map((objective) => [
          objective.id,
          objective.status,
        ]),
      ),
    [referencedObjectives, objectives],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        (e.target as HTMLElement).tagName !== 'INPUT' &&
        (e.target as HTMLElement).tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        const input = document.querySelector(
          'input[placeholder="Search tasks..."]',
        ) as HTMLInputElement;
        input?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    // Enter opens the task (see KanbanCard), so only Space starts/ends a
    // keyboard drag; Escape cancels.
    useSensor(KeyboardSensor, {
      coordinateGetter: kanbanKeyboardCoordinates(
        () => crossPreviewRef.current?.stageId,
        (taskId) => columnOfTaskRef.current.get(taskId),
      ),
      keyboardCodes: {
        start: ['Space'],
        cancel: ['Escape'],
        end: ['Space'],
      },
    }),
  );

  const filteredTasks = useMemo(() => {
    return tasks.filter((f) => {
      const lower = search.toLowerCase().trim();
      const matchSearch =
        !lower ||
        f.id.toLowerCase().includes(lower) ||
        f.title.toLowerCase().includes(lower) ||
        f.description?.toLowerCase().includes(lower) ||
        f.last_agent_name?.toLowerCase().includes(lower) ||
        f.runtimeSelection?.harnessId.toLowerCase().includes(lower) ||
        f.runtimeSelection?.modelId.toLowerCase().includes(lower) ||
        f.runtimeSelection?.reasoning?.toLowerCase().includes(lower) ||
        f.latestRunModelName?.toLowerCase().includes(lower);

      // Objective filter: '' = "All objectives" (show everything, including
      // tasks not tied to any objective). Otherwise show only tasks tagged
      // with the selected objective. Tasks with no objective_id are hidden
      // when a specific objective is selected.
      const matchObjective =
        !selectedObjective || f.objective_id === selectedObjective;
      // In replay, include an archived card only when it participated in the
      // selected period. The API's run list already contains only runs that
      // overlap that period.
      const matchArchived = replayMode
        ? !f.archived || replayActiveTaskIds.has(f.id)
        : showArchived || !f.archived;

      return matchSearch && matchObjective && matchArchived;
    });
  }, [
    tasks,
    search,
    selectedObjective,
    showArchived,
    replayMode,
    replayActiveTaskIds,
  ]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, TaskSummary[]> = {};
    for (const stage of stages) {
      grouped[stage.id] = [];
    }
    const fallback = stages.find((s) => s.type === 'queue') || stages[0];
    for (const task of filteredTasks) {
      const bucket = grouped[task.status];
      if (bucket) {
        bucket.push(task);
      } else {
        if (fallback) {
          grouped[fallback.id]?.push(task);
        }
      }
    }
    // Sort each bucket using the same canonical order as task navigation.
    for (const stage of stages) {
      const bucket = grouped[stage.id];
      if (!bucket) continue;
      grouped[stage.id] = sortTasksForStage(bucket, stage);
    }
    return grouped;
  }, [filteredTasks, stages]);

  // Every client-known card per stage, before search/objective/archived
  // filters and the page slice. Reordering needs it to keep hidden cards'
  // relative order intact.
  const fullTasksByStatus = useMemo(() => {
    const grouped: Record<string, TaskSummary[]> = {};
    for (const stage of stages) {
      grouped[stage.id] = [];
    }
    const fallback = stages.find((s) => s.type === 'queue') || stages[0];
    for (const task of tasks) {
      (
        grouped[task.status] ?? (fallback ? grouped[fallback.id] : undefined)
      )?.push(task);
    }
    for (const stage of stages) {
      grouped[stage.id] = sortTasksForStage(grouped[stage.id] ?? [], stage);
    }
    return grouped;
  }, [tasks, stages]);

  // Sliced view per column for progressive rendering
  const visibleTasksByStatus = useMemo(() => {
    const result: Record<string, TaskSummary[]> = {};
    for (const stage of stages) {
      const all = tasksByStatus[stage.id] ?? [];
      const count = visibleCounts[stage.id] ?? PAGE_SIZE;
      result[stage.id] = all.slice(0, count);
    }
    return result;
  }, [tasksByStatus, visibleCounts, stages]);

  // Column each client-known card is bucketed into (unknown statuses fall back
  // to the first queue stage, like the buckets above).
  const columnOfTask = useMemo(() => {
    const map = new Map<string, string>();
    for (const [stageId, list] of Object.entries(fullTasksByStatus)) {
      for (const task of list) map.set(task.id, stageId);
    }
    return map;
  }, [fullTasksByStatus]);
  columnOfTaskRef.current = columnOfTask;

  // What the columns render: the visible slices, except that a card dragged
  // over another column (or dropped there while its priority updates are still
  // being saved) is shown in that column's slot instead of its source column.
  const slots = useMemo(() => {
    const list = Object.values(pendingDrops);
    if (crossPreview && !crossPreview.collapsed && activeTask) {
      list.push({ taskId: activeTask.id, ...crossPreview });
    }
    return list;
  }, [crossPreview, activeTask, pendingDrops]);
  const renderedTasksByStatus = useMemo(() => {
    let rendered = visibleTasksByStatus;
    for (const slot of slots) {
      const dragged = tasks.find((task) => task.id === slot.taskId);
      const sourceStage = columnOfTask.get(slot.taskId);
      if (!dragged || !sourceStage || !rendered[slot.stageId]) continue;
      const without = (list: TaskSummary[]) =>
        list.filter((task) => task.id !== dragged.id);
      const destination = without(rendered[slot.stageId]);
      rendered = {
        ...rendered,
        [sourceStage]: without(rendered[sourceStage] ?? []),
        [slot.stageId]: [
          ...destination.slice(0, slot.index),
          dragged,
          ...destination.slice(slot.index),
        ],
      };
    }
    return rendered;
  }, [slots, tasks, columnOfTask, visibleTasksByStatus]);

  const handleLoadMore = useCallback(
    (stageId: string) => {
      setVisibleCounts((prev) => {
        const total = tasksByStatus[stageId]?.length ?? 0;
        const current = prev[stageId] ?? PAGE_SIZE;
        if (current >= total) return prev;
        return { ...prev, [stageId]: current + PAGE_SIZE };
      });
    },
    [tasksByStatus],
  );

  const handleToggleSelect = useCallback((task_id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(task_id)) next.delete(task_id);
      else next.add(task_id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(
    (stageId: string, select: boolean) => {
      const ids = visibleTasksByStatus[stageId]?.map((f) => f.id) ?? [];
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (select) ids.forEach((id) => next.add(id));
        else ids.forEach((id) => next.delete(id));
        return next;
      });
    },
    [visibleTasksByStatus],
  );

  // The bulk bar unmounts once the selection is cleared, so move focus to the
  // stable board container (never body) and announce the requested action.
  const finishBulkAction = useCallback((message?: string) => {
    setSelectedIds(new Set());
    if (message)
      setBulkAnnouncement((prev) => ({ seq: prev.seq + 1, text: message }));
    scrollRegionRef.current?.focus({ preventScroll: true });
  }, []);

  const handleBulkMove = useCallback(
    (targetStatus: TaskStatus) => {
      const ids = Array.from(selectedIds);
      bulkMoveTasks(ids, targetStatus);
      const stageTitle = findStage(stages, targetStatus)?.title ?? targetStatus;
      finishBulkAction(
        `Requested move of ${formatTaskCount(ids.length)} to ${stageTitle}`,
      );
    },
    [selectedIds, bulkMoveTasks, stages, finishBulkAction],
  );

  const handleBulkExecute = useCallback(() => {
    const ids = Array.from(selectedIds);
    bulkExecute(ids);
    finishBulkAction(`Requested start of ${formatTaskCount(ids.length)}`);
  }, [selectedIds, bulkExecute, finishBulkAction]);

  const handleBulkStop = useCallback(() => {
    const ids = Array.from(selectedIds);
    bulkStop(ids);
    finishBulkAction(`Requested stop of ${formatTaskCount(ids.length)}`);
  }, [selectedIds, bulkStop, finishBulkAction]);

  // Start over only applies to cards resting in a queue stage (e.g. Failed).
  const selectedQueueTasks = useMemo(
    () =>
      tasks.filter(
        (t) =>
          selectedIds.has(t.id) &&
          findStage(stages, t.status)?.type === 'queue',
      ),
    [tasks, selectedIds, stages],
  );

  const handleBulkStartOver = useCallback(async () => {
    const queueTasks = selectedQueueTasks;
    if (queueTasks.length === 0) return;
    const skippedCount = selectedIds.size - queueTasks.length;
    const targetTitle =
      getActiveStage(stages)?.title ?? 'the first active stage';
    const skipNote =
      skippedCount > 0
        ? ` ${skippedCount} selected card${skippedCount === 1 ? ' is' : 's are'} not in a queue stage and will be skipped.`
        : '';
    const confirmed = await confirmAction(
      `Each card's worktree, branch and chat history will be discarded, and the cards move to ${targetTitle}.${skipNote}`,
      {
        title: `Start over ${queueTasks.length} card${queueTasks.length === 1 ? '' : 's'}?`,
        confirmLabel: 'Start over',
        destructive: true,
      },
    );
    if (!confirmed) return;
    bulkStartOver({
      ids: queueTasks.map((t) => t.id),
      titles: Object.fromEntries(queueTasks.map((t) => [t.id, t.title])),
    });
    finishBulkAction(
      `Requested start over of ${formatTaskCount(queueTasks.length)}`,
    );
  }, [
    selectedQueueTasks,
    selectedIds,
    stages,
    bulkStartOver,
    finishBulkAction,
  ]);

  const handleClearSelection = useCallback(() => {
    finishBulkAction();
  }, [finishBulkAction]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    const count = ids.length;
    const runningCount = tasks.filter(
      (t) => selectedIds.has(t.id) && t.running,
    ).length;
    const stopNote =
      runningCount > 0
        ? ` ${runningCount} running task${runningCount === 1 ? '' : 's'} will be stopped first.`
        : '';
    const confirmed = await confirmAction(`This cannot be undone.${stopNote}`, {
      title: `Delete ${count} selected item${count !== 1 ? 's' : ''}?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    bulkDeleteTasks(ids);
    finishBulkAction(`Requested delete of ${formatTaskCount(count)}`);
  }, [selectedIds, tasks, bulkDeleteTasks, finishBulkAction]);

  const handleBulkArchive = useCallback(
    (archived: boolean) => {
      const ids = Array.from(selectedIds);
      bulkUpdate({ ids, archived });
      finishBulkAction(
        `Requested ${archived ? 'archive' : 'restore'} of ${formatTaskCount(ids.length)}`,
      );
    },
    [selectedIds, bulkUpdate, finishBulkAction],
  );

  const handleStartReplay = useCallback(() => {
    setSelectedIds(new Set());
    setShowArchived(false);
    setSearch('');
    setSelectedObjective('');
    setReplayRange(defaultReplayRange());
    setReplayMode(true);
  }, []);

  const handleArchiveAllDone = useCallback(async () => {
    const doneStageIds = new Set(
      stages.filter((s) => s.type === 'done' && !s.inactive).map((s) => s.id),
    );
    const doneTaskIds = tasks
      .filter((f) => doneStageIds.has(f.status) && !f.archived)
      .map((f) => f.id);

    if (doneTaskIds.length === 0) {
      toast.info('No non-archived completed tasks found.');
      return;
    }

    const count = doneTaskIds.length;
    const confirmed = await confirmAction(
      `${count} completed task${count === 1 ? '' : 's'} will be archived. You can bring them back with Show Archived.`,
      { title: 'Clean board?', confirmLabel: 'Archive' },
    );
    if (!confirmed) return;

    bulkUpdate({ ids: doneTaskIds, archived: true });
  }, [tasks, stages, bulkUpdate]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const task = event.active.data.current?.task as Task | undefined;
    keyboardDragRef.current = isKeyboardDrag(event.activatorEvent);
    setActiveTask(task || null);
  }, []);

  useEffect(() => () => cancelCardFocusRestore?.(), []);

  // dnd-kit steps a keyboard drag by comparing the drag overlay with the
  // droppable rects, which no longer line up once the dragged card is rendered
  // in the destination column. While it is previewed there, Up/Down move the
  // slot one card at a time instead.
  useEffect(() => {
    if (!activeTask) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const preview = crossPreviewRef.current;
      if (
        !keyboardDragRef.current ||
        !preview ||
        (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const visible = visibleTasksByStatus[preview.stageId] ?? [];
      const firstMovable = visible.findIndex((task) => !task.running);
      updateCrossPreview({
        stageId: preview.stageId,
        index: Math.min(
          Math.max(
            preview.index + (e.key === 'ArrowDown' ? 1 : -1),
            firstMovable === -1 ? visible.length : firstMovable,
          ),
          visible.length,
        ),
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeTask, visibleTasksByStatus, updateCrossPreview]);

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      setActiveTask(null);
      updateCrossPreview(null);
      keyboardDragRef.current = false;
      pointerRef.current = null;
      if (isKeyboardDrag(event.activatorEvent)) {
        restoreCardFocus(String(event.active.id));
      }
    },
    [updateCrossPreview],
  );

  const announcements = useMemo(
    () => buildKanbanAnnouncements(tasks, stages, (id) => columnOfTask.get(id)),
    [tasks, stages, columnOfTask],
  );

  const stageIds = useMemo(() => new Set(stages.map((s) => s.id)), [stages]);
  const initialStageId = useMemo(() => getInitialStage(stages)?.id, [stages]);

  const collisionDetectionStrategy = useCallback<CollisionDetection>(
    (args) => {
      // While the dragged card is previewed in another column, the card is its
      // own drop target there so sortable adds no transforms on top of the
      // layout the preview already produced.
      const preview = crossPreviewRef.current;
      const previewRect = preview && args.droppableRects.get(preview.stageId);
      const point = args.pointerCoordinates;
      pointerRef.current = point;
      if (
        previewRect &&
        point &&
        point.x >= previewRect.left &&
        point.x <= previewRect.right &&
        point.y >= previewRect.top &&
        point.y <= previewRect.bottom
      ) {
        return [{ id: args.active.id }];
      }

      const pointerCollisions = pointerWithin(args);
      if (pointerCollisions.length > 0) {
        // A card is more specific than its containing stage. Once the
        // pointer leaves a card, the stage remains a reliable target even
        // when the dragged card overlaps adjacent columns.
        const cardCollision = pointerCollisions.find(
          ({ id }) => !stageIds.has(id as string),
        );
        return [cardCollision ?? pointerCollisions[0]];
      }

      // Pointer coordinates are unavailable for keyboard sensors. Keep the
      // existing rectangle behavior as a fallback for those events.
      return rectIntersection(args);
    },
    [stageIds],
  );

  // Where a drag would land when it ends in a different, positionally ordered
  // column; null for every other drop (same column, initial stage, done stage).
  const resolveCrossDrop = useCallback(
    (
      event: Pick<DragMoveEvent, 'active' | 'over' | 'activatorEvent'>,
    ): CrossPreview | null => {
      if (replayMode) return null;
      const { active, over, activatorEvent } = event;
      const sourceStage = columnOfTask.get(active.id as string);
      if (!sourceStage) return null;

      // Keyboard drags have no pointer position.
      const isPointerDrag = !!getEventCoordinates(activatorEvent);
      const pointer = isPointerDrag ? pointerRef.current : null;
      if (isPointerDrag && !pointer) return null;
      let stageId: string | undefined;
      let collapsed = false;
      if (pointer) {
        for (const el of document.elementsFromPoint?.(pointer.x, pointer.y) ??
          []) {
          const column = el.closest('[data-ui="kanban-column"]');
          if (column) {
            stageId = column.getAttribute('data-stage-id') ?? undefined;
            collapsed = column.getAttribute('data-collapsed') === 'true';
            break;
          }
        }
      } else if (over) {
        // The previewed card is its own target in the destination column.
        if (over.id === active.id) return crossPreviewRef.current;
        stageId = stageIds.has(over.id as string)
          ? (over.id as string)
          : columnOfTask.get(over.id as string);
      }
      if (
        !stageId ||
        stageId === sourceStage ||
        stageId === initialStageId ||
        findStage(stages, stageId)?.type === 'done'
      ) {
        return null;
      }

      const visible = visibleTasksByStatus[stageId] ?? [];
      let index = visible.length;
      if (pointer) {
        // Cards are ordered top to bottom: the slot goes after every card
        // whose midpoint is above the pointer, so gaps and the area below the
        // last card both resolve to a position. Midpoints ignore the sortable
        // transform, which shifts cards while they animate to or from the slot,
        // and the previewed card's own slot, so the position depends only on
        // where the pointer is, not on the path that opened the slot.
        const column = document.querySelector(
          `[data-ui="kanban-column"][data-stage-id="${CSS.escape(stageId)}"]`,
        );
        const cardEl = (id: string) =>
          column?.querySelector(
            `[data-ui="kanban-card"][data-task-id="${CSS.escape(id)}"]`,
          );
        const slotEl = cardEl(active.id as string);
        const cards = visible.map((task) => cardEl(task.id));
        const nextAfterSlot = slotEl
          ? cards.find(
              (el) =>
                el &&
                slotEl.compareDocumentPosition(el) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
            )
          : undefined;
        const slotSpan =
          slotEl && nextAfterSlot
            ? layoutTopY(nextAfterSlot) - layoutTopY(slotEl)
            : 0;
        index = 0;
        for (const el of cards) {
          if (el) {
            const afterSlot =
              slotEl &&
              slotEl.compareDocumentPosition(el) &
                Node.DOCUMENT_POSITION_FOLLOWING;
            if (layoutMidpointY(el) - (afterSlot ? slotSpan : 0) >= pointer.y) {
              break;
            }
          }
          index++;
        }
      } else if (over && !stageIds.has(over.id as string)) {
        // Keyboard drags insert before the target card (the column appends).
        index = Math.max(
          visible.findIndex((task) => task.id === over.id),
          0,
        );
      }
      // Running cards always sort first, so the slot never opens above them.
      const leadingRunning = visible.findIndex((task) => !task.running);
      return {
        stageId,
        index: Math.max(
          index,
          leadingRunning === -1 ? visible.length : leadingRunning,
        ),
        ...(collapsed && { collapsed }),
      };
    },
    [
      replayMode,
      columnOfTask,
      stageIds,
      initialStageId,
      stages,
      visibleTasksByStatus,
    ],
  );

  // Pointer drags follow the pointer. dnd-kit reports a keyboard drag's new
  // target through onDragOver only after onDragMove has fired with the previous
  // one, so keyboard previews are resolved there instead.
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      if (keyboardDragRef.current) return;
      updateCrossPreview(resolveCrossDrop(event));
    },
    [resolveCrossDrop, updateCrossPreview],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!keyboardDragRef.current) return;
      // Up/Down step the slot inside its column, which moves the collision
      // target without the user choosing a new one; keep the stepped index.
      const next = resolveCrossDrop(event);
      const current = crossPreviewRef.current;
      updateCrossPreview(
        current && next?.stageId === current.stageId ? current : next,
      );
    },
    [resolveCrossDrop, updateCrossPreview],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      // The drop lands where the preview showed the slot, provided the current
      // target is still in that column. Layout can shift after the last move
      // event (scroll, pagination), and Up/Down step a keyboard slot within its
      // column without changing the target.
      const target = resolveCrossDrop(event);
      const previewed = crossPreviewRef.current;
      const crossDrop =
        target && previewed?.stageId === target.stageId ? previewed : target;
      updateCrossPreview(null);
      keyboardDragRef.current = false;
      pointerRef.current = null;
      setActiveTask(null);
      if (isKeyboardDrag(event.activatorEvent)) {
        restoreCardFocus(String(event.active.id));
      }
      if (replayMode) return;
      const { active, over } = event;

      const task_id = active.id as string;
      const dragged = tasks.find((f) => f.id === task_id);
      if (!dragged) return;

      if (crossDrop) {
        const { stageId, index } = crossDrop;
        const destination = visibleTasksByStatus[stageId] ?? [];
        const placement = computeInsertPlacement(
          destination,
          index,
          dragged,
          findStage(stages, stageId)?.type,
          fullTasksByStatus[stageId] ?? destination,
        );
        if (!placement) {
          // Nothing to anchor on (empty column): the card just moves.
          moveTask(task_id, stageId as TaskStatus);
        } else {
          // Keep the dropped slot until the saves settle. Renumbered
          // neighbours land first so the queue drain triggered by the move
          // sees the final priorities.
          setPendingDrops((prev) => ({
            ...prev,
            [task_id]: { taskId: task_id, stageId, index },
          }));
          // The drop pushes the page's last card out of the slice; widen it so
          // the dropped card stays where it was placed.
          if ((tasksByStatus[stageId]?.length ?? 0) > destination.length) {
            setVisibleCounts((prev) => ({
              ...prev,
              [stageId]: (prev[stageId] ?? PAGE_SIZE) + 1,
            }));
          }
          void Promise.all(
            placement.others.map(({ id, priority }) =>
              updateTaskAsync({ task_id: id, data: { priority } }),
            ),
          )
            .then(() =>
              updateTaskAsync({
                task_id,
                data: {
                  status: stageId as TaskStatus,
                  priority: placement.priority,
                },
              }),
            )
            .catch(() => undefined) // useUpdateTask already toasts the error
            .finally(() =>
              setPendingDrops(({ [task_id]: _done, ...rest }) => rest),
            );
        }
        return;
      }

      if (!over) return;

      if (stageIds.has(over.id as string)) {
        // Dropped on a column droppable
        const newStatus = over.id as TaskStatus;
        if (columnOfTask.get(task_id) !== newStatus) {
          moveTask(task_id, newStatus);
        }
      } else {
        // Dropped on a card
        const overTask = tasks.find((f) => f.id === over.id);
        if (!overTask) return;

        // Compare rendered columns: an inactive-stage task renders in the
        // fallback column, so its raw status is not a drop target.
        const sourceColumn = columnOfTask.get(task_id);
        const targetColumn = columnOfTask.get(overTask.id);
        if (!sourceColumn || !targetColumn) return;

        if (targetColumn !== sourceColumn) {
          // Cross-column drop on a card
          moveTask(task_id, targetColumn as TaskStatus);
        } else {
          // Same-column reorder → only the dragged card gets a new priority,
          // placed between its visible neighbours so hidden cards keep order
          const col = visibleTasksByStatus[sourceColumn] ?? [];
          const oldIdx = col.findIndex((f) => f.id === task_id);
          const newIdx = col.findIndex((f) => f.id === over.id);
          if (oldIdx === newIdx) return;
          const updates = computeReorderUpdates(
            col,
            oldIdx,
            newIdx,
            findStage(stages, sourceColumn)?.type,
            fullTasksByStatus[sourceColumn] ?? col,
          );
          // Persist each changed card to the server
          for (const { id, priority } of updates) {
            updateTask({ task_id: id, data: { priority } });
          }
        }
      }
    },
    [
      tasks,
      stages,
      stageIds,
      columnOfTask,
      visibleTasksByStatus,
      fullTasksByStatus,
      tasksByStatus,
      moveTask,
      updateTask,
      updateTaskAsync,
      replayMode,
      resolveCrossDrop,
      updateCrossPreview,
    ],
  );

  const showMobileFilters =
    filtersOpen || !!ownerUserId || !!triggeredByUserId || !!selectedObjective;

  if (liveTasksQuery.isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading tasks...
      </div>
    );
  }

  if (liveTasksQuery.data === undefined && liveTasksQuery.isError) {
    return (
      <QueryErrorState
        title="Could not load tasks"
        error={liveTasksQuery.error}
        onRetry={() => void liveTasksQuery.refetch()}
        isRetrying={liveTasksQuery.isFetching}
      />
    );
  }

  return (
    <div
      data-ui="kanban-board-content"
      data-project-id={project_id}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* Cronjobs + Dataset tasks strip */}
      {(cronjobs.length > 0 ||
        datasetTasks.length > 0 ||
        archivedCronjobs.length > 0 ||
        archivedDatasetTasks.length > 0) && (
        <div className="px-4 pt-3 pb-0 flex-shrink-0">
          {(cronjobs.length > 0 || datasetTasks.length > 0) && (
            <>
              <button
                data-ui="board-automations-header"
                aria-expanded={automationsExpanded}
                onClick={() => setAutomationsExpanded((expanded) => !expanded)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
              >
                {automationsExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                <Clock className="size-3" />
                <span>
                  Automations ({cronjobs.length + datasetTasks.length})
                </span>
              </button>
              {automationsExpanded && (
                <div
                  data-ui="board-automations-content"
                  className="flex gap-3 overflow-x-auto pb-2 no-scrollbar"
                >
                  {cronjobs.map((cj) => (
                    <CronjobCard
                      key={cj.id}
                      cronjob={cj}
                      project_id={project_id}
                      objectiveTitle={
                        cj.objective_id
                          ? objectiveTitles.get(cj.objective_id)
                          : undefined
                      }
                      objectiveStatus={
                        cj.objective_id
                          ? objectiveStatuses.get(cj.objective_id)
                          : undefined
                      }
                    />
                  ))}
                  {datasetTasks.map((dt) => (
                    <DatasetTaskCard
                      key={dt.id}
                      datasetTask={dt}
                      project_id={project_id}
                      objectiveTitle={
                        dt.objective_id
                          ? objectiveTitles.get(dt.objective_id)
                          : undefined
                      }
                      objectiveStatus={
                        dt.objective_id
                          ? objectiveStatuses.get(dt.objective_id)
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {(archivedCronjobs.length > 0 || archivedDatasetTasks.length > 0) && (
            <>
              <button
                onClick={() =>
                  setArchivedAutomationsExpanded(!archivedAutomationsExpanded)
                }
                className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors mb-2 mt-1"
              >
                {archivedAutomationsExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                <Archive className="size-3" />
                <span>
                  Archived (
                  {archivedCronjobs.length + archivedDatasetTasks.length})
                </span>
              </button>
              {archivedAutomationsExpanded && (
                <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
                  {archivedCronjobs.map((cj) => (
                    <CronjobCard
                      key={cj.id}
                      cronjob={cj}
                      project_id={project_id}
                      objectiveTitle={
                        cj.objective_id
                          ? objectiveTitles.get(cj.objective_id)
                          : undefined
                      }
                      objectiveStatus={
                        cj.objective_id
                          ? objectiveStatuses.get(cj.objective_id)
                          : undefined
                      }
                    />
                  ))}
                  {archivedDatasetTasks.map((dt) => (
                    <DatasetTaskCard
                      key={dt.id}
                      datasetTask={dt}
                      project_id={project_id}
                      objectiveTitle={
                        dt.objective_id
                          ? objectiveTitles.get(dt.objective_id)
                          : undefined
                      }
                      objectiveStatus={
                        dt.objective_id
                          ? objectiveStatuses.get(dt.objective_id)
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Scheduled Tasks strip */}
      {scheduledTasks.length > 0 && (
        <div className="px-4 pt-3 pb-0 flex-shrink-0">
          <button
            data-ui="board-scheduled-tasks-header"
            aria-expanded={scheduledTasksExpanded}
            onClick={() => setScheduledTasksExpanded((expanded) => !expanded)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            {scheduledTasksExpanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            <CalendarClock className="size-3" />
            <span>Scheduled Tasks ({scheduledTasks.length})</span>
          </button>
          {scheduledTasksExpanded && (
            <div
              data-ui="board-scheduled-tasks-content"
              className="flex gap-3 overflow-x-auto pb-2 no-scrollbar"
            >
              {scheduledTasks.map((st) => (
                <ScheduledTaskCard
                  key={st.id}
                  scheduledTask={st}
                  project_id={project_id}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Objectives load failure (replaces the strip while there is no data) */}
      {objectivesError && objectives.length === 0 && (
        <div
          data-ui="board-objectives-error"
          role="alert"
          className="flex items-center gap-2 px-4 pt-3 pb-0 text-xs text-muted-foreground flex-shrink-0"
        >
          <Target className="size-3" />
          <span>Couldn&apos;t load objectives</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void refetchObjectives()}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Objectives strip */}
      {objectives.length > 0 && (
        <div className="px-4 pt-3 pb-0 flex-shrink-0">
          <button
            onClick={() => setObjectivesExpanded(!objectivesExpanded)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            {objectivesExpanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            <Target className="size-3" />
            <span>Objectives ({objectives.length})</span>
          </button>
          {objectivesExpanded && (
            <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
              {objectives.map((obj) => (
                <button
                  key={obj.id}
                  onClick={() =>
                    navigate({
                      to: '/objective/$projectId/$objectiveId',
                      params: { projectId: project_id, objectiveId: obj.id },
                    })
                  }
                  className={cn(
                    'flex-shrink-0 flex flex-col gap-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors hover:bg-accent',
                    'min-w-[160px] max-w-[220px]',
                  )}
                >
                  <span className="font-medium truncate">{obj.title}</span>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="capitalize">{obj.status}</span>
                    <span>{obj.progress}%</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search and Filters Strip */}
      {replayMode && (
        <BoardReplayPlayer
          projectId={project_id}
          range={replayRange}
          onRangeChange={setReplayRange}
          onExit={exitReplay}
          onFrame={handleReplayFrame}
        />
      )}
      <div className="px-4 py-2 flex items-center gap-2 sm:gap-3 flex-wrap flex-shrink-0">
        <SearchInput
          placeholder="Search tasks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          wrapperClassName="flex-1 sm:max-w-sm"
        />
        <Button
          type="button"
          variant={showMobileFilters ? 'secondary' : 'outline'}
          size="icon"
          className="relative size-9 sm:hidden"
          title="Filter by owner, triggerer, or objective"
          aria-label={
            ownerUserId || triggeredByUserId || selectedObjective
              ? 'Filters (active)'
              : 'Filters'
          }
          aria-expanded={showMobileFilters}
          disabled={!!(ownerUserId || triggeredByUserId || selectedObjective)}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="size-3.5" />
          {(ownerUserId || triggeredByUserId || selectedObjective) && (
            <span
              data-ui="task-filters-active-dot"
              className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
            />
          )}
        </Button>
        {canListMembers && (
          <>
            <Select
              data-ui="task-owner-filter"
              data-project-id={project_id}
              aria-label="Owner"
              className={cn(
                'min-w-0 max-sm:order-last max-sm:flex-1 max-sm:basis-[calc(50%-0.25rem)]',
                !showMobileFilters && 'max-sm:hidden',
              )}
              value={ownerUserId}
              onValueChange={(nextValue) => setOwnerUserId(nextValue)}
            >
              <SelectItem value="">All owners</SelectItem>
              {attributionMembers.map((member) => (
                <SelectItem key={member.user_id} value={member.user_id}>
                  {member.username}
                </SelectItem>
              ))}
            </Select>
            <Select
              data-ui="task-trigger-filter"
              data-project-id={project_id}
              aria-label="Triggered by"
              className={cn(
                'min-w-0 max-sm:order-last max-sm:flex-1 max-sm:basis-[calc(50%-0.25rem)]',
                !showMobileFilters && 'max-sm:hidden',
              )}
              value={triggeredByUserId}
              onValueChange={(nextValue) => setTriggeredByUserId(nextValue)}
            >
              <SelectItem value="">All triggerers</SelectItem>
              {attributionMembers.map((member) => (
                <SelectItem key={member.user_id} value={member.user_id}>
                  {member.username}
                </SelectItem>
              ))}
            </Select>
          </>
        )}

        {objectives.length > 0 && (
          <Select
            data-ui="task-objective-filter"
            data-project-id={project_id}
            aria-label="Objective"
            className={cn(
              'min-w-0 max-sm:order-last max-sm:flex-1 max-sm:basis-[calc(50%-0.25rem)]',
              !showMobileFilters && 'max-sm:hidden',
            )}
            value={selectedObjective}
            onValueChange={(nextValue) => setSelectedObjective(nextValue)}
          >
            <SelectItem value="">All objectives</SelectItem>
            {objectives.map((obj) => (
              <SelectItem key={obj.id} value={obj.id}>
                {obj.title}
              </SelectItem>
            ))}
          </Select>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={showArchived ? 'secondary' : 'ghost'}
              size="icon"
              className="relative"
              data-ui="kanban-board-actions-trigger"
              data-archived-active={showArchived ? 'true' : undefined}
              title={
                showArchived
                  ? 'More board actions (archived tasks shown)'
                  : 'More board actions'
              }
              aria-label="More board actions"
            >
              <MoreHorizontal className="size-4" />
              {showArchived && (
                <span
                  data-ui="kanban-archived-active-indicator"
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-2 rounded-full bg-primary"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!replayMode && (
              <DropdownMenuItem
                data-ui="kanban-action-replay"
                onSelect={handleStartReplay}
              >
                <History />
                Replay board history
              </DropdownMenuItem>
            )}
            <DropdownMenuCheckboxItem
              data-ui="kanban-action-show-archived"
              checked={showArchived}
              disabled={replayMode}
              onCheckedChange={setShowArchived}
            >
              Show Archived
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              data-ui="kanban-action-clean-board"
              onSelect={handleArchiveAllDone}
            >
              <Archive />
              Clean Board
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        role="status"
        data-ui="kanban-bulk-action-status"
        className="sr-only"
      >
        <span key={bulkAnnouncement.seq}>{bulkAnnouncement.text}</span>
      </div>

      {/* Bulk action toolbar */}
      {!replayMode && selectedIds.size > 0 && (
        <div className="flex-shrink-0 mx-4 mb-2 mt-2 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 flex-wrap">
          <span className="text-sm font-medium text-foreground mr-1">
            {selectedIds.size} selected
          </span>

          <div className="flex items-center gap-1 border-r border-primary/20 pr-2 mr-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 bg-background"
              onClick={handleBulkExecute}
            >
              <Play className="size-3" />
              Execute
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 bg-background"
              onClick={handleBulkStop}
            >
              <Square className="size-3" />
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 bg-background"
              data-ui="kanban-bulk-start-over"
              disabled={selectedQueueTasks.length === 0}
              onClick={handleBulkStartOver}
            >
              <RotateCcw className="size-3" />
              Start over
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 bg-background"
              onClick={() => handleBulkArchive(true)}
            >
              <Archive className="size-3" />
              Archive
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 bg-background"
              onClick={() => handleBulkArchive(false)}
            >
              <ArchiveRestore className="size-3" />
              Restore
            </Button>
          </div>

          {/* Non-modal: a modal menu traps focus, which would pull focus back into
              the closing menu and drop it on <body> after finishBulkAction. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5 bg-background"
                data-ui="kanban-bulk-move"
              >
                Move to…
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              collisionPadding={8}
              data-ui="kanban-bulk-move-menu"
              onCloseAutoFocus={(e) => {
                // After a pick, finishBulkAction already moved focus to the
                // board; a plain dismissal returns focus to the trigger.
                if (bulkMovePickedRef.current) e.preventDefault();
                bulkMovePickedRef.current = false;
              }}
            >
              {stages.map((stage) => (
                <DropdownMenuItem
                  key={stage.id}
                  className="min-h-10"
                  onSelect={() => {
                    bulkMovePickedRef.current = true;
                    handleBulkMove(stage.id as TaskStatus);
                  }}
                >
                  <span
                    className="size-2 rounded-full inline-block flex-shrink-0"
                    style={{ backgroundColor: stage.color }}
                  />
                  {stage.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleBulkDelete}
            >
              <Trash2 className="size-3.5 mr-1" />
              Delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={handleClearSelection}
            >
              <X className="size-3.5 mr-1" />
              Clear
            </Button>
          </div>
        </div>
      )}

      <div
        data-ui="kanban-stage-scroll-frame"
        className="group/frame relative flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={setScrollRegion}
          tabIndex={-1}
          data-ui="kanban-stage-scroll-region"
          data-project-id={project_id}
          className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-3 focus:outline-none"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetectionStrategy}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
            accessibility={{ announcements }}
          >
            <div
              data-ui="kanban-stage-strip"
              data-project-id={project_id}
              className="flex gap-3 h-full min-w-max"
            >
              {stages.map((stage) => (
                <KanbanColumn
                  key={`${project_id}:${stage.id}`}
                  id={stage.id}
                  project_id={project_id}
                  title={stage.title}
                  color={stage.color}
                  count={tasksByStatus[stage.id]?.length || 0}
                  taskIds={
                    renderedTasksByStatus[stage.id]?.map((f) => f.id) ?? []
                  }
                  isDropTarget={crossPreview?.stageId === stage.id}
                  hasMore={
                    (tasksByStatus[stage.id]?.length ?? 0) >
                    (visibleTasksByStatus[stage.id]?.length ?? 0)
                  }
                  onLoadMore={() => handleLoadMore(stage.id)}
                  selectedIds={selectedIds}
                  onSelectAll={(select) => handleSelectAll(stage.id, select)}
                  emptyMessage={
                    search.trim() && selectedObjective
                      ? `No results for "${search}" in ${objectives.find((o) => o.id === selectedObjective)?.title ?? selectedObjective}`
                      : search.trim()
                        ? `No results for "${search}"`
                        : selectedObjective
                          ? `No tasks in ${objectives.find((o) => o.id === selectedObjective)?.title ?? selectedObjective}`
                          : 'No tasks'
                  }
                >
                  {renderedTasksByStatus[stage.id]?.map((task) => (
                    <KanbanCard
                      key={task.id}
                      task={task}
                      project_id={project_id}
                      objectiveTitle={
                        task.objective_id
                          ? objectiveTitles.get(task.objective_id)
                          : undefined
                      }
                      objectiveStatus={
                        task.objective_id
                          ? objectiveStatuses.get(task.objective_id)
                          : undefined
                      }
                      isSelected={selectedIds.has(task.id)}
                      onToggleSelect={handleToggleSelect}
                      readOnly={replayMode}
                      dragDisabled={task.id in pendingDrops}
                      replayRun={replayRuns.get(task.id)}
                      replayReviewVisible={replayReviewedTaskIds.has(task.id)}
                    />
                  ))}
                </KanbanColumn>
              ))}
            </div>

            <DragOverlay dropAnimation={null}>
              {activeTask ? (
                <KanbanCard
                  task={activeTask}
                  project_id={project_id}
                  objectiveTitle={
                    activeTask.objective_id
                      ? objectiveTitles.get(activeTask.objective_id)
                      : undefined
                  }
                  objectiveStatus={
                    activeTask.objective_id
                      ? objectiveStatuses.get(activeTask.objective_id)
                      : undefined
                  }
                  isOverlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
        <div
          aria-hidden="true"
          data-ui="kanban-stage-scroll-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent opacity-0 transition-opacity group-data-[more-right=true]/frame:opacity-100"
        />
      </div>
    </div>
  );
}
