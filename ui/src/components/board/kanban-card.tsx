import { useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Clock,
  Database,
  Timer,
  RotateCcw,
  Square,
  Loader2,
  Link as LinkIcon,
  Copy,
  Check,
  Archive,
  ArchiveRestore,
  GitBranch,
  Bot,
  Star,
  RefreshCw,
  AlarmClockOff,
  SkipForward,
  Play,
  AlertCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { SELECT_CHECKBOX_CLASS } from './select-checkbox';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import {
  cn,
  formatRelativeTime,
  formatDuration,
  copyToClipboard,
} from '@/lib/utils';
import { useStore } from '@/store';
import { useProjects } from '@/hooks/use-projects';
import { useElapsedTime } from '@/hooks/use-elapsed-time';
import {
  useExecuteTask,
  useStopTask,
  useUpdateTask,
} from '@/hooks/use-task-mutations';
import {
  getActiveStage,
  getEffectiveProjectStages,
  isActiveStage,
  findStage,
} from '@/lib/stages';
import {
  useResolveAgentLabel,
  useResolveModelLabel,
  useResolveRuntimeSelectionLabel,
} from '@/lib/agents';
import type {
  BoardReplayRun,
  ObjectiveStatus,
  TaskPhase,
  TaskSummary,
} from '@/types';
import { resolveTaskPhase } from '@/lib/task-phase';
import { memo } from 'react';
import { useTasks } from '@/hooks/use-tasks';
import { ObjectiveMarker } from './objective-marker';
import { AbCardBadges } from './ab-card-badges';
import { CoStageCardBadges } from './co-stage-select';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import { useAuth } from '@/lib/auth';
import { taskAbForkCommit } from '@/lib/ab';

interface KanbanCardProps {
  task: TaskSummary;
  project_id: string;
  isOverlay?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (task_id: string) => void;
  objectiveTitle?: string;
  objectiveStatus?: ObjectiveStatus;
  readOnly?: boolean;
  /** Dragging is paused (e.g. while a drop's saves are still pending). */
  dragDisabled?: boolean;
  replayRun?: BoardReplayRun;
  replayReviewVisible?: boolean;
}

/**
 * Tone of the review-score badge. The board stores only the 1-10 score (the
 * approve/reject verdict is not on the card), so the colour follows the score:
 * 8+ strong, 5-7 acceptable-with-reservations, 4 and below weak.
 */
function reviewScoreTone(score: unknown): string {
  const value = Number(score);
  if (!Number.isFinite(value))
    return 'text-amber-700 border-amber-600 dark:text-amber-500 dark:border-amber-500/30';
  if (value >= 8)
    return 'text-emerald-700 border-emerald-600 dark:text-emerald-500 dark:border-emerald-500/30';
  if (value >= 5)
    return 'text-amber-700 border-amber-600 dark:text-amber-500 dark:border-amber-500/30';
  return 'text-rose-700 border-rose-600 dark:text-rose-500 dark:border-rose-500/30';
}

function TaskAttributionBadges({
  task,
}: {
  task: Pick<TaskSummary, 'id' | 'owner' | 'latestTrigger'>;
}) {
  const currentUserId = useAuth((state) => state.user?.id);

  if (!task.owner || task.owner.id === currentUserId) return null;

  return (
    <span
      className="min-w-0 max-w-full truncate text-[10px] leading-4 text-muted-foreground"
      data-ui="task-owner-badge"
      data-entity-id={task.id}
      data-user-id={task.owner.id}
      title={`Owner: ${task.owner.username}`}
    >
      Owner: {task.owner.username}
    </span>
  );
}

export const KanbanCard = memo(function KanbanCard({
  task,
  project_id,
  isOverlay,
  isSelected,
  onToggleSelect,
  objectiveTitle,
  objectiveStatus,
  readOnly = false,
  dragDisabled = false,
  replayRun,
  replayReviewVisible = false,
}: KanbanCardProps) {
  const setDetailTaskId = useStore((s) => s.setDetailTaskId);
  const openTaskWithReviewIntent = useStore((s) => s.openTaskWithReviewIntent);
  const isLiveFromStore = useStore((s) => !!s.liveTaskIds[task.id]);
  const isStalledFromStore = useStore((s) => !!s.stalledTaskIds[task.id]);
  const { data: projects } = useProjects();
  const { data: tasks = [] } = useTasks(project_id);
  const project = projects?.find((p) => p.id === project_id);
  const stages = useMemo(() => getEffectiveProjectStages(project), [project]);

  const { mutate: executeTask, isPending: isExecuting } =
    useExecuteTask(project_id);
  const { mutate: stopTask, isPending: isStopping } = useStopTask(project_id);
  const { mutate: updateTask } = useUpdateTask(project_id);

  const [copied, setCopied] = useState(false);

  // The server phase is overlaid with the WS live/stalled flags, which keep the
  // pulse visible during restart recovery even if a refetch lands with an idle
  // phase. A replay run is a card-local override to running.
  const phase: TaskPhase =
    replayRun?.status === 'running'
      ? 'running'
      : resolveTaskPhase(task, {
          isLive: isLiveFromStore,
          isStalledFromStore,
          readOnly,
        });
  const isRunInProgress = phase === 'running';
  const isActive = isRunInProgress;
  // Claimed and creating its worktree before the agent launches.
  const isPreparing = !readOnly && phase === 'preparing';
  const isQueued = phase === 'queued';
  const isWaiting = phase === 'waiting';
  const isStalled = phase === 'stalled';
  const isForkedAbParent = taskAbForkCommit(task) !== null;
  // Passive (queue/done) stages have no agent: play moves the task into the
  // first active stage and starts it there.
  const currentStageType = findStage(stages, task.status)?.type;
  const passiveRunStage =
    currentStageType === 'queue' || currentStageType === 'done'
      ? getActiveStage(stages)
      : undefined;
  // Archiving is offered only from passive stages; archived tasks keep Restore.
  const canArchive =
    !!task.archived ||
    currentStageType === 'queue' ||
    currentStageType === 'done';
  const canManuallyTrigger =
    !isForkedAbParent &&
    (project?.settings?.status === 'running' ||
      project?.settings?.status === 'paused' ||
      project?.settings?.status === 'stopped') &&
    (isActiveStage(stages, task.status) || !!passiveRunStage) &&
    (phase === 'idle' || phase === 'waiting' || phase === 'stalled') &&
    !isStopping;
  const isCronjob = !!task.cronjob_id;
  const isDatasetTask = !!task.dataset_task_id;
  const stage = findStage(stages, task.status);
  const replayRunStage = replayRun?.stage
    ? findStage(stages, replayRun.stage)
    : undefined;
  const resolveAgentLabel = useResolveAgentLabel();
  const resolveRuntimeSelectionLabel = useResolveRuntimeSelectionLabel();
  const resolveModelLabel = useResolveModelLabel();
  // Run history describes the stage it ran in. A task sitting in an agent
  // stage it has not run in yet (e.g. just moved back from review) shows that
  // stage's configured runtime instead: mixing it with the previous stage's
  // agent or model would name a harness/model pairing that never existed.
  const configuredRuntimeSelection =
    task.runtimeSelection ||
    stage?.runtimeSelection ||
    project?.settings?.kanbanRuntimeSelection;
  const awaitingStageRun =
    !replayRun &&
    !isRunInProgress &&
    stage?.type !== 'queue' &&
    stage?.type !== 'done' &&
    !!task.latestRunStage &&
    task.latestRunStage !== task.status &&
    !!configuredRuntimeSelection;
  const runModelName = awaitingStageRun
    ? null
    : resolveModelLabel(
        replayRun
          ? replayRun.model_name || replayRun.model
          : isRunInProgress
            ? task.runningRunModel
            : task.latestRunModelName,
      );
  // Replay run metadata remains authoritative. Otherwise task execution
  // history is shown before configured task/stage/project runtime selection,
  // except while a just-started run's model is still unknown: the configured
  // selection predicts it, whereas the last agent's label carries the
  // harness default model. The newest run's own agent pairs with its model;
  // `last_agent_name` skips review/testing runs.
  const explicitAgentName = replayRun
    ? replayRun.agent_name
    : isRunInProgress
      ? task.last_agent_name
      : task.latestRunAgentName || task.last_agent_name;
  const awaitingRunModel = !replayRun && isRunInProgress && !runModelName;
  const effectiveRuntimeSelection =
    explicitAgentName && !awaitingRunModel && !awaitingStageRun
      ? undefined
      : configuredRuntimeSelection;
  // With no run history and no configured runtime the label is only the
  // generic 'agent' fallback, which carries no information on the card.
  const hasKnownRuntime = !!(effectiveRuntimeSelection || explicitAgentName);
  const resolvedAgentName =
    (effectiveRuntimeSelection
      ? resolveRuntimeSelectionLabel(effectiveRuntimeSelection)
      : resolveAgentLabel(explicitAgentName)) || 'agent';
  const agentModelSeparator = resolvedAgentName.indexOf(' · ');
  const hasCombinedAgentModelLabel = agentModelSeparator !== -1;
  const displayedAgentName =
    runModelName && hasCombinedAgentModelLabel
      ? `${resolvedAgentName.slice(0, agentModelSeparator)} · ${runModelName}`
      : resolvedAgentName;
  const displayedModel =
    runModelName && !hasCombinedAgentModelLabel ? runModelName : undefined;
  const showRuntimeLabel =
    !!displayedAgentName &&
    (hasKnownRuntime || !!runModelName) &&
    !(displayedAgentName === 'agent' && !!displayedModel);
  const showExecutionRow =
    showRuntimeLabel || !!displayedModel || task.costUsd != null;

  // Dependency logic
  const { isBlocked, unmetDependencies } = useMemo(() => {
    const depends_on_ids = task.depends_on_ids;
    if (!depends_on_ids || depends_on_ids.length === 0) {
      return { isBlocked: false, unmetDependencies: [] };
    }
    const doneStageIds = new Set(
      stages.filter((s) => s.type === 'done' && !s.inactive).map((s) => s.id),
    );
    const tasksById = new Map(tasks.map((f) => [f.id, f]));
    const unmet = depends_on_ids
      .map((id) => tasksById.get(id))
      .filter((f): f is TaskSummary => !!f && !doneStageIds.has(f.status));
    return {
      isBlocked: unmet.length > 0,
      unmetDependencies: unmet,
    };
  }, [task.depends_on_ids, tasks, stages]);

  // Live elapsed timer for running tasks. Board Replay forces the running
  // phase, and a wall-clock timer would not follow the replay frame time.
  const elapsed = useElapsedTime(task.started_at, isActive && !readOnly);

  // Legacy fallback for tasks that predate persisted active-run history.
  const legacyCompletedDuration = useMemo(() => {
    const { started_at, completed_at } = task;
    if (!started_at || !completed_at) return null;
    const ms =
      new Date(completed_at).getTime() - new Date(started_at).getTime();
    return ms > 0 ? ms : null;
  }, [task.started_at, task.completed_at]);
  const completedDuration = task.totalRunDurationMs ?? legacyCompletedDuration;
  const totalElapsed = (task.totalRunDurationMs ?? 0) + elapsed;

  // Metadata row visibility. The status row renders only when at least one
  // execution-state indicator is visible; the context row always has content
  // (the task ID is always shown) and the timing footer always renders
  // because the creation time is always present.
  const showArchivedBadge = !!task.archived;
  const showSkipStagesBadge = (task.skip_stages?.length ?? 0) > 0;
  const showReviewScoreBadge =
    task.custom_values?.quality_score != null &&
    (!readOnly || replayReviewVisible);
  const showRejectionCountBadge =
    typeof task.custom_values?.rejection_count === 'number' &&
    task.custom_values.rejection_count > 0 &&
    (!readOnly || replayReviewVisible);
  const showTestingFailuresBadge =
    readOnly &&
    typeof task.custom_values?.testing_failure_count === 'number' &&
    task.custom_values.testing_failure_count > 0 &&
    replayRunStage?.type === 'testing';
  const isMerging = !!task.merging && !readOnly;
  const hasStatusMetadata =
    isMerging ||
    showArchivedBadge ||
    isBlocked ||
    showSkipStagesBadge ||
    isStalled ||
    showReviewScoreBadge ||
    showRejectionCountBadge ||
    showTestingFailuresBadge;

  const titleRef = useRef<HTMLHeadingElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { task },
    disabled: readOnly || isMerging || dragDisabled,
  });

  const isHighPriority = task.priority < 0;

  const style = { transform: CSS.Transform.toString(transform), transition };

  const openDetail = () => {
    if (!readOnly && !isDragging) setDetailTaskId(task.id);
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopTask(task.id);
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(task.id);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateTask({ task_id: task.id, data: { archived: !task.archived } });
  };

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBlocked) {
      const titles = unmetDependencies.map((d) => d.title).join(', ');
      alert(`Cannot execute. Blocked by: ${titles}`);
      return;
    }
    executeTask(
      passiveRunStage
        ? { task_id: task.id, stage: passiveRunStage.id }
        : task.id,
    );
  };

  const handleReviewScoreClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (readOnly) return;
    openTaskWithReviewIntent(task.id);
  };

  const card = (
    <Card
      ref={setNodeRef}
      data-ui="kanban-card"
      data-task-id={task.id}
      data-archived={task.archived ? 'true' : undefined}
      style={style}
      {...listeners}
      {...attributes}
      onClick={openDetail}
      onKeyDown={(e) => {
        // Keys pressed on inner controls (Select, Copy, Archive, ...) keep
        // their native behavior: neither open the task nor start a drag.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          openDetail();
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      className={cn(
        'cursor-pointer select-none [-webkit-touch-callout:none] transition-all border-border/40 hover:border-primary/30 group min-w-0 w-full max-w-full overflow-hidden',
        isDragging && 'opacity-50 border-primary/30',
        isOverlay && 'shadow-xl rotate-2 scale-105 border-primary/30',
        isCronjob && 'border-dashed border-2 border-primary/40',
        isDatasetTask &&
          'border-dashed border-2 border-purple-600 dark:border-purple-500/40',
        // Archived cards get the muted border of archived cronjob/dataset
        // cards. Listed before isSelected/isHighPriority so those accents
        // still win on conflict; the dimming below stays unconditional.
        task.archived && 'border-muted-foreground/20',
        isSelected && 'border-primary/60 bg-primary/5',
        isHighPriority && !isCronjob && 'border-l-2 border-l-primary/40',
        isBlocked && 'opacity-75 grayscale-[0.5]',
        // Archived wins over blocked: listed later, so twMerge keeps these
        // on conflict and the card reads dimmer (opacity-50) than a blocked
        // one (opacity-75).
        task.archived && 'opacity-50 grayscale-[0.5]',
        readOnly && 'cursor-default animate-in fade-in zoom-in-95 duration-300',
      )}
    >
      <CardContent className="py-3 px-1.5 space-y-2 min-w-0">
        {/* Title */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {isCronjob && (
              <Clock className="size-3.5 flex-shrink-0 text-primary" />
            )}
            {isDatasetTask && (
              <Database className="size-3.5 flex-shrink-0 text-purple-600 dark:text-purple-500" />
            )}
            <ObjectiveMarker
              objectiveId={task.objective_id}
              objectiveTitle={objectiveTitle}
              objectiveStatus={objectiveStatus}
            />
            <h4
              ref={titleRef}
              className="text-sm font-medium leading-tight min-w-0 flex-1 break-words whitespace-normal line-clamp-2"
            >
              {task.title}
            </h4>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isActive && (
              <div
                data-ui="task-running-marker"
                // Fallback when the task has no stage colour: light uses the
                // status token, dark keeps the exact pre-light-theme hex.
                className="size-2 rounded-full animate-pulse flex-shrink-0 bg-[color:var(--status-in-progress)] dark:bg-[#3B82F6]"
                style={
                  stage?.color ? { backgroundColor: stage.color } : undefined
                }
                title="Running"
              />
            )}
            {isPreparing && (
              <Loader2
                data-ui="task-preparing-marker"
                className="size-3 animate-spin flex-shrink-0 text-[color:var(--status-in-progress)] dark:text-[#3B82F6]"
                style={stage?.color ? { color: stage.color } : undefined}
                aria-label="Preparing worktree"
              />
            )}
            {!isPreparing && (isQueued || isWaiting) && (
              <div
                data-ui="task-waiting-marker"
                className="size-2 rounded-full border-2 flex-shrink-0 opacity-70 border-[color:var(--status-in-progress)] dark:border-[#3B82F6]"
                style={stage?.color ? { borderColor: stage.color } : undefined}
                title="Waiting to start"
              />
            )}
          </div>
        </div>

        {/* Custom values via card template */}
        {project?.settings?.cardTemplate &&
          task.custom_values &&
          Object.keys(task.custom_values).length > 0 && (
            <div
              className="text-xs text-muted-foreground break-words [&_b]:font-semibold [&_b]:text-foreground"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(
                  project.settings.cardTemplate.replace(
                    /\{\{(\w+)\}\}/g,
                    (_, key) => {
                      const val = task.custom_values?.[key];
                      return val !== undefined ? String(val) : '';
                    },
                  ),
                  {
                    ALLOWED_TAGS: [
                      'b',
                      'i',
                      'em',
                      'strong',
                      'span',
                      'div',
                      'br',
                      'a',
                    ],
                    ALLOWED_ATTR: ['class', 'href', 'target', 'rel'],
                  },
                ),
              }}
            />
          )}

        {/* Error */}
        {!readOnly && task.error && (
          <p
            data-ui="task-error-chip"
            className="flex min-w-0 items-start gap-1 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-1 text-[11px] leading-snug text-destructive"
            title={task.error}
          >
            <AlertCircle className="mt-px size-3 shrink-0" />
            <span className="line-clamp-2 min-w-0 break-words">
              {task.error}
            </span>
          </p>
        )}

        {/* Status row: execution-state indicators. Rendered only when the
            row has visible content; each row is its own wrapping block so
            categories never flow into another row. */}
        {hasStatusMetadata && (
          <div
            className="flex items-center gap-1.5 flex-wrap min-w-0 overflow-hidden"
            data-ui="task-status-metadata"
            data-task-id={task.id}
          >
            {isMerging && (
              <span
                data-ui="task-merging-marker"
                data-task-id={task.id}
                className="inline-flex items-center gap-1 text-[10px] leading-4 text-muted-foreground"
                title="Merging task branch"
              >
                <span
                  className="size-2 rounded-full animate-pulse flex-shrink-0 bg-[color:var(--status-completed)] dark:bg-[#22C55E]"
                  style={
                    stage?.color ? { backgroundColor: stage.color } : undefined
                  }
                />
                Merging…
              </span>
            )}
            {showArchivedBadge && (
              <Badge
                variant="outline"
                className="text-[10px] h-4 px-1 text-muted-foreground border-dashed"
                data-ui="task-archived-badge"
                data-task-id={task.id}
              >
                Archived
              </Badge>
            )}
            {isBlocked && (
              <Badge
                variant="secondary"
                className="text-[10px] h-4 px-1 text-muted-foreground gap-1 max-w-full"
                title={`Blocked by: ${unmetDependencies
                  .map((dependency) => dependency.title)
                  .join(', ')}`}
              >
                <LinkIcon className="size-2.5" />
                <span className="truncate">
                  Blocked by:{' '}
                  {unmetDependencies
                    .map((dependency) => dependency.title)
                    .join(', ')}
                </span>
              </Badge>
            )}
            {task.skip_stages && task.skip_stages.length > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] h-4 px-1 gap-1 text-muted-foreground border-dashed"
                title={`Auto-advance skips: ${task.skip_stages
                  .map((id) => stages.find((s) => s.id === id)?.title ?? id)
                  .join(', ')}`}
              >
                <SkipForward className="size-2.5" />
                skip:{' '}
                {task.skip_stages
                  .map((id) => stages.find((s) => s.id === id)?.title ?? id)
                  .join(', ')}
              </Badge>
            )}
            {isStalled && (
              <Badge
                variant="outline"
                className="text-[10px] h-4 px-1 gap-1 text-amber-700 border-amber-600 dark:text-amber-500 dark:border-amber-500/40"
                title={task.error || 'Killed by idle timeout (no agent output)'}
              >
                <AlarmClockOff className="size-2.5" />
                Stalled
              </Badge>
            )}
            {task.custom_values?.quality_score != null &&
              (!readOnly || replayReviewVisible) &&
              (readOnly ? (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] h-4 px-1 gap-0.5',
                    reviewScoreTone(task.custom_values.quality_score),
                  )}
                >
                  <Star className="size-2.5" />
                  {task.custom_values.quality_score}
                </Badge>
              ) : (
                <Badge
                  asChild
                  variant="outline"
                  className={cn(
                    'text-[10px] h-4 px-1 gap-0.5',
                    reviewScoreTone(task.custom_values.quality_score),
                  )}
                >
                  <button
                    type="button"
                    data-ui="task-review-score"
                    data-task-id={task.id}
                    aria-label={`Open latest review for ${task.title}`}
                    title="Open latest review transcript"
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onClick={handleReviewScoreClick}
                  >
                    <Star className="size-2.5" />
                    {task.custom_values.quality_score}
                  </button>
                </Badge>
              ))}
            {typeof task.custom_values?.rejection_count === 'number' &&
              task.custom_values.rejection_count > 0 &&
              (!readOnly || replayReviewVisible) && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-4 px-1 gap-0.5 text-rose-700 border-rose-600 dark:text-rose-500 dark:border-rose-500/30"
                >
                  <RefreshCw className="size-2.5" />
                  {task.custom_values.rejection_count}
                </Badge>
              )}
            {readOnly &&
              typeof task.custom_values?.testing_failure_count === 'number' &&
              task.custom_values.testing_failure_count > 0 &&
              replayRunStage?.type === 'testing' && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-4 px-1 gap-0.5 text-orange-700 border-orange-600 dark:text-orange-500 dark:border-orange-500/30"
                >
                  <RefreshCw className="size-2.5" />
                  {task.custom_values.testing_failure_count}
                </Badge>
              )}
          </div>
        )}

        {/* Board replay shows historical snapshots; live variant counts would mislead. */}
        {!readOnly && (
          <AbCardBadges
            task={task}
            tasks={tasks}
            stages={stages}
            onOpenTask={setDetailTaskId}
          />
        )}
        {!readOnly && <CoStageCardBadges task={task} />}

        {/* Identity row: muted task identity, exceptional origin, and
            ownership. The task ID is always present. */}
        <div
          className={cn(
            'flex items-center gap-1.5 flex-wrap min-w-0 overflow-hidden text-muted-foreground',
            // Pad the row by the checkbox hit-area overhang and cancel it with
            // a negative margin: overflow-hidden then no longer clips the 32px
            // touch target and the row keeps its height.
            !readOnly &&
              !isOverlay &&
              onToggleSelect &&
              'pointer-coarse:py-1.5 pointer-coarse:-my-1.5',
          )}
          data-ui="task-context-metadata"
          data-task-id={task.id}
        >
          {/* Multi-select checkbox: always present but dim so selection stays
            discoverable; it sits in the identity row (not before the title). */}
          {!readOnly && !isOverlay && onToggleSelect && (
            <div
              onClick={(e) => {
                e.stopPropagation();
              }}
              className={cn(
                // Left padding keeps the focus ring and the coarse-pointer hit
                // area clear of the row's overflow clipping.
                'flex-shrink-0 pl-[3px] pointer-coarse:pl-1.5 transition-opacity',
                isSelected
                  ? 'opacity-100'
                  : 'opacity-40 group-hover:opacity-100 pointer-coarse:opacity-100',
              )}
            >
              <Checkbox
                checked={isSelected ?? false}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onCheckedChange={() => onToggleSelect(task.id)}
                className={SELECT_CHECKBOX_CLASS}
                aria-label={`Select ${task.title}`}
              />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span
              className="max-w-full truncate text-[11px] font-mono"
              title={`Task ID: ${task.id}`}
            >
              {task.id.length > 18
                ? `${task.id.slice(0, 7)}…${task.id.slice(-6)}`
                : task.id}
            </span>
            {(task.author === 'agent' || task.author === 'cronjob') && (
              <span
                className={cn(
                  'inline-flex size-4 shrink-0 items-center justify-center rounded-full',
                  task.author === 'agent' &&
                    'bg-violet-500/15 text-violet-600 dark:text-violet-500',
                  task.author === 'cronjob' &&
                    'bg-amber-500/15 text-amber-800 dark:text-amber-500',
                )}
                data-ui="task-origin-marker"
                title={`Created by ${task.author}`}
              >
                {task.author === 'agent' ? (
                  <Bot className="size-2.5" />
                ) : (
                  <Clock className="size-2.5" />
                )}
              </span>
            )}
            <TaskAttributionBadges task={task} />
          </div>
          {!readOnly && !isOverlay && (
            <div
              className={cn(
                'flex flex-shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity',
                canManuallyTrigger && 'opacity-100',
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground hover:text-foreground"
                onClick={handleCopy}
                title="Copy task ID"
              >
                {copied ? (
                  <Check className="size-3 text-green-700 dark:text-green-500" />
                ) : (
                  <Copy className="size-3" />
                )}
              </Button>
              {isBlocked && (
                <div title={`Blocked by ${unmetDependencies.length} tasks`}>
                  <LinkIcon className="size-3 text-muted-foreground" />
                </div>
              )}
              {isActive && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 text-muted-foreground hover:text-destructive"
                  onClick={handleStop}
                  disabled={isStopping}
                  aria-label="Stop task"
                >
                  {isStopping ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Square className="size-3" />
                  )}
                </Button>
              )}
              {canManuallyTrigger && (
                <Button
                  data-ui="manual-task-trigger"
                  data-task-id={task.id}
                  variant="ghost"
                  size="icon"
                  className="size-5 text-muted-foreground hover:text-primary"
                  onClick={handleRetry}
                  disabled={isExecuting}
                  title={
                    isBlocked
                      ? 'Blocked by unmet dependencies'
                      : 'Run task manually'
                  }
                  aria-label="Run task manually"
                >
                  {isExecuting ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                </Button>
              )}
              {!canManuallyTrigger &&
                !isForkedAbParent &&
                phase !== 'running' &&
                phase !== 'preparing' &&
                phase !== 'queued' &&
                (task.error ||
                  (isBlocked &&
                    (stage?.type === 'active' ||
                      stage?.type === 'testing'))) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 text-muted-foreground hover:text-primary"
                    onClick={handleRetry}
                    disabled={isExecuting}
                    aria-label="Retry task"
                  >
                    {isExecuting ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3" />
                    )}
                  </Button>
                )}
              {canArchive && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 text-muted-foreground hover:text-primary"
                  onClick={handleArchive}
                  title={task.archived ? 'Restore task' : 'Archive task'}
                >
                  {task.archived ? (
                    <ArchiveRestore className="size-3" />
                  ) : (
                    <Archive className="size-3" />
                  )}
                </Button>
              )}
            </div>
          )}
        </div>

        {task.branch_name && (
          <div
            className="flex min-w-0 overflow-hidden text-muted-foreground"
            data-ui="task-branch-row"
            data-task-id={task.id}
          >
            <Badge
              variant="secondary"
              className={cn(
                'h-4 min-w-0 max-w-full gap-1 px-1 text-[10px] font-normal text-muted-foreground',
                stage?.type === 'done' && 'text-amber-800 dark:text-amber-500',
              )}
              title={
                stage?.type === 'done'
                  ? `Unmerged branch: ${task.branch_name}`
                  : task.branch_name
              }
            >
              <GitBranch className="size-2.5 shrink-0" />
              <span className="min-w-0 truncate">{task.branch_name}</span>
            </Badge>
          </div>
        )}

        {/* Execution row: runtime and model truncate on the left before the
            right-pinned cost can move or shrink. Omitted when it would only
            hold the generic fallback label. */}
        {showExecutionRow && (
          <div
            className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden"
            data-ui="task-execution-metadata"
            data-task-id={task.id}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {showRuntimeLabel && (
                <span
                  className="min-w-0 truncate text-[11px] text-muted-foreground"
                  data-ui="task-runtime-label"
                  title={displayedAgentName}
                >
                  {displayedAgentName}
                </span>
              )}
              {displayedModel && (
                <span
                  className="min-w-0 truncate text-[11px] text-muted-foreground"
                  data-ui="task-model-label"
                  title={displayedModel}
                >
                  {displayedModel}
                </span>
              )}
            </div>
            {task.costUsd != null && (
              <span
                className={cn(
                  'ml-auto shrink-0 text-[11px] font-medium tabular-nums',
                  COST_TEXT_CLASS,
                )}
                data-ui="task-total-cost"
                title="Total measured task cost"
              >
                ${task.costUsd.toFixed(4)}
              </span>
            )}
          </div>
        )}

        {/* Timing footer: always a full-width row of its own. Execution
            duration and run count group on the left; the right edge shows
            when the latest run finished, or the creation time for a task that
            has never run. */}
        <div
          className="flex w-full items-center gap-1.5 min-w-0 overflow-hidden"
          data-ui="task-timing-metadata"
          data-task-id={task.id}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {isPreparing && (
              <span
                data-ui="task-preparing-label"
                data-task-id={task.id}
                className="text-[11px] text-primary font-medium"
              >
                Preparing worktree…
              </span>
            )}
            {isActive && elapsed > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[11px] text-primary font-medium tabular-nums"
                title="Total execution time across all runs"
              >
                <Timer className="size-2.5" />
                {formatDuration(totalElapsed)}
              </span>
            )}
            {!isActive &&
              completedDuration != null &&
              completedDuration > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums"
                  title="Total execution time across all runs"
                >
                  <Timer className="size-2.5" />
                  {formatDuration(completedDuration)}
                </span>
              )}
            {!readOnly && (task.runCount ?? 0) > 0 && (
              <span
                data-ui="task-run-count"
                data-task-id={task.id}
                className="text-[11px] text-muted-foreground tabular-nums"
                title={`${task.runCount ?? 0} execution ${(task.runCount ?? 0) === 1 ? 'run' : 'runs'}`}
              >
                {task.runCount ?? 0}{' '}
                {(task.runCount ?? 0) === 1 ? 'run' : 'runs'}
              </span>
            )}
          </div>
          {task.latestRunCompletedAt ? (
            <span
              data-ui="task-latest-run-completion"
              data-task-id={task.id}
              className="ml-auto shrink-0 text-[11px] text-muted-foreground"
              title={`Latest run completed ${new Date(task.latestRunCompletedAt).toLocaleString()} · task created ${new Date(task.created_at).toLocaleString()}`}
            >
              ran {formatRelativeTime(task.latestRunCompletedAt)}
            </span>
          ) : (
            <span
              className="ml-auto shrink-0 text-[11px] text-muted-foreground"
              title={`Task created ${new Date(task.created_at).toLocaleString()}`}
            >
              {formatRelativeTime(task.created_at)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );

  // The card is the trigger so keyboard focus on the card itself opens the
  // tooltip; focus on its inner controls does not. Pointer hover counts only
  // over the name. The drag overlay follows the pointer, so it gets no tooltip.
  if (isOverlay) return card;
  return (
    <Tooltip
      content={task.title}
      whenClipped={titleRef}
      onPointerMove={(e) => {
        if (!titleRef.current?.contains(e.target as Node)) e.preventDefault();
      }}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) e.preventDefault();
      }}
    >
      {card}
    </Tooltip>
  );
});
