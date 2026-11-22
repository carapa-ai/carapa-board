import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ExternalLink,
  GitMerge,
  Loader2,
  Star,
  Trophy,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePickAbWinner, useUpdateTask } from '@/hooks/use-task-mutations';
import { useResolveAgentLabel, useResolveModelLabel } from '@/lib/agents';
import {
  taskAbForkCommit,
  taskAbWinnerId,
  taskStageVariant,
  variantLabel,
} from '@/lib/ab';
import { fetchTaskRuns, getTaskDiff } from '@/lib/api';
import { approvalOfError } from '@/lib/merge-approval-prompt';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import { queryKeys } from '@/lib/query-keys';
import { findStage } from '@/lib/stages';
import { cn, formatDuration } from '@/lib/utils';
import type {
  StageDefinition,
  StageType,
  TaskRunLog,
  TaskSummary,
} from '@/types';

interface AbComparisonPanelProps {
  projectId: string;
  /** The experiment parent. */
  parent: TaskSummary;
  /** The parent's variant cards. */
  variants: TaskSummary[];
  /** Base stages of the project. */
  stages: StageDefinition[];
  onOpenTask: (taskId: string) => void;
}

/** Runs (newest first) executed in a stage of the given type. */
function runsInStageType(
  runs: TaskRunLog[],
  stages: StageDefinition[],
  type: StageType,
): TaskRunLog[] {
  const ids = new Set(
    stages.filter((stage) => stage.type === type).map((stage) => stage.id),
  );
  return runs.filter((run) => run.stage != null && ids.has(run.stage));
}

/**
 * Where a variant stands in Testing, separate from how often it failed there.
 * A pass resets `testing_failure_count`; a failure leaves it above zero and
 * sends the card back to coding.
 */
function testingOutcome(
  testingRuns: TaskRunLog[],
  values: TaskSummary['custom_values'],
  isDone: boolean,
): string {
  const latest = testingRuns[0];
  if (!latest) return isDone ? 'not run' : 'pending';
  if (latest.status === 'running') return 'running';
  if (latest.status === 'error') return 'errored';
  if (latest.status === 'stopped') return 'stopped';
  return typeof values?.testing_failure_count === 'number' &&
    values.testing_failure_count > 0
    ? 'failed'
    : 'passed';
}

function MetricCell({
  label,
  uiName,
  children,
}: {
  label: string;
  uiName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0" data-ui={uiName}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-xs">{children}</dd>
    </div>
  );
}

function VariantRow({
  projectId,
  parent,
  variant,
  stages,
  isWinner,
  winnerPicked,
  mergeDisabled,
  mergePending,
  onOpenTask,
  onMerge,
  onDismiss,
}: {
  projectId: string;
  parent: TaskSummary;
  variant: TaskSummary;
  stages: StageDefinition[];
  isWinner: boolean;
  winnerPicked: boolean;
  /** Another variant's pick is in flight, so this one cannot be merged. */
  mergeDisabled: boolean;
  /** This variant's own pick is in flight. */
  mergePending: boolean;
  onOpenTask: (taskId: string) => void;
  onMerge: (variant: TaskSummary) => void;
  onDismiss: (variant: TaskSummary) => void;
}) {
  const resolveAgentLabel = useResolveAgentLabel();
  const resolveModelLabel = useResolveModelLabel();
  const stage = findStage(stages, variant.status);
  const isDone = stage?.type === 'done';
  const isRunning = stage?.type === 'active';

  const { data: runHistory } = useQuery({
    queryKey: queryKeys.runs.all(projectId, variant.id),
    queryFn: () => fetchTaskRuns(projectId, variant.id),
  });
  const { data: diff } = useQuery({
    queryKey: [
      ...queryKeys.taskDiff.all(projectId, variant.id),
      variant.status,
      variant.completed_at ?? null,
    ],
    queryFn: () => getTaskDiff(projectId, variant.id),
    enabled: isDone,
    staleTime: 60_000,
  });

  const runs = runHistory?.runs ?? [];
  const runtimeLabel = (run: TaskRunLog | undefined) => {
    if (!run) return '—';
    const agent = resolveAgentLabel(run.agent_name);
    const model = resolveModelLabel(run.model_name || run.model);
    // The recorded model wins over any model embedded in the profile label:
    // several profiles can share one command.
    const harness = agent.split(' · ')[0];
    return model ? `${harness || 'agent'} · ${model}` : agent || '—';
  };
  const coder = runtimeLabel(runsInStageType(runs, stages, 'active')[0]);
  const reviewRuns = runsInStageType(runs, stages, 'review');
  const reviewer = runtimeLabel(reviewRuns[0]);

  const values = variant.custom_values;
  const score = values?.quality_score;
  // A round is one finished review execution, whatever its verdict.
  const rounds = reviewRuns.filter((run) => run.status === 'success').length;
  const testingFailures =
    typeof values?.testing_failure_total === 'number'
      ? values.testing_failure_total
      : 0;
  const testingResult = !stages.some((s) => s.type === 'testing')
    ? '—'
    : [
        testingOutcome(
          runsInStageType(runs, stages, 'testing'),
          values,
          isDone,
        ),
        testingFailures > 0 ? `${testingFailures} failed` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  const files = diff?.available ? (diff.files ?? []) : [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const forkCommit = taskAbForkCommit(parent);
  const suffix = taskStageVariant(variant) ?? '?';

  return (
    <li
      data-ui="ab-comparison-row"
      data-task-id={variant.id}
      data-variant={suffix}
      data-winner={isWinner ? 'true' : undefined}
      className={cn(
        'space-y-2 rounded-md border border-border bg-muted/20 p-2',
        isWinner && 'border-green-600 bg-green-500/5 dark:border-green-500/50',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          data-ui="ab-variant-badge"
          className="text-xs font-semibold"
        >
          {variantLabel(suffix)}
        </Badge>
        <span
          data-ui="ab-comparison-stage"
          className="inline-flex items-center gap-1.5 text-xs"
        >
          <span
            // Fallback dot: light uses the status token, dark keeps the
            // exact pre-light-theme hex.
            className="size-2 shrink-0 rounded-full bg-[color:var(--status-backlog)] dark:bg-[#8B8FA3]"
            style={stage?.color ? { backgroundColor: stage.color } : undefined}
          />
          {stage?.title ?? variant.status}
        </span>
        {variant.archived && (
          <Badge
            variant="outline"
            data-ui="ab-dismissed-badge"
            className="text-[10px] text-muted-foreground"
          >
            Dismissed
          </Badge>
        )}
        {isWinner && (
          <Badge
            data-ui="ab-winner-badge"
            // White on the filled badge: >= 4.5:1 in light via green-700; dark
            // keeps the existing green-600 fill unchanged.
            className="gap-1 bg-green-700 text-[10px] text-white dark:bg-green-600"
          >
            <Trophy className="size-3" />
            Winner
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-ui="ab-open-variant"
            data-task-id={variant.id}
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => onOpenTask(variant.id)}
          >
            <ExternalLink className="size-3" />
            Open
          </Button>
          {isDone && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-ui="ab-merge-variant"
              data-task-id={variant.id}
              className="h-7 gap-1 px-2 text-xs"
              disabled={
                (!mergePending && (winnerPicked || mergeDisabled)) ||
                !!variant.archived
              }
              onClick={() => onMerge(variant)}
            >
              {mergePending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <GitMerge className="size-3" />
              )}
              {mergePending ? 'Merging…' : 'Merge this variant'}
            </Button>
          )}
          {!isWinner && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-ui="ab-dismiss-variant"
              data-task-id={variant.id}
              className="h-7 gap-1 px-2 text-xs"
              disabled={isRunning || mergePending || !!variant.archived}
              onClick={() => onDismiss(variant)}
            >
              <Archive className="size-3" />
              Dismiss
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        <MetricCell label="Coder" uiName="ab-metric-coder">
          <span title={coder}>{coder}</span>
        </MetricCell>
        <MetricCell label="Reviewer" uiName="ab-metric-reviewer">
          <span title={reviewer}>{reviewer}</span>
        </MetricCell>
        <MetricCell label="Review" uiName="ab-metric-review">
          {score != null ? (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-500">
              <Star className="size-3" />
              {score}
              <span className="text-muted-foreground">
                · {rounds} {rounds === 1 ? 'round' : 'rounds'}
              </span>
            </span>
          ) : (
            '—'
          )}
        </MetricCell>
        <MetricCell label="Testing" uiName="ab-metric-testing">
          {testingResult}
        </MetricCell>
        <MetricCell label="Cost" uiName="ab-metric-cost">
          {variant.costUsd != null ? (
            <span className={cn('tabular-nums', COST_TEXT_CLASS)}>
              ${variant.costUsd.toFixed(4)}
            </span>
          ) : (
            '—'
          )}
        </MetricCell>
        <MetricCell label="Duration" uiName="ab-metric-duration">
          {variant.totalRunDurationMs
            ? formatDuration(variant.totalRunDurationMs)
            : '—'}
        </MetricCell>
        <MetricCell label="Diff" uiName="ab-metric-diff">
          {files.length > 0 ? (
            <span className="tabular-nums">
              <span className="text-green-700 dark:text-green-500">
                +{additions}
              </span>{' '}
              <span className="text-rose-700 dark:text-rose-500">
                −{deletions}
              </span>
              <span className="text-muted-foreground">
                {' '}
                · {files.length} {files.length === 1 ? 'file' : 'files'}
              </span>
            </span>
          ) : (
            '—'
          )}
        </MetricCell>
        <MetricCell label="Fork commit" uiName="ab-metric-fork-commit">
          {forkCommit ? (
            <span className="font-mono" title={forkCommit}>
              {forkCommit.slice(0, 7)}
            </span>
          ) : (
            '—'
          )}
        </MetricCell>
      </dl>
    </li>
  );
}

/**
 * Side-by-side comparison of an A/B experiment's variant cards, with the
 * "Merge this variant" action that picks the winner.
 */
export function AbComparisonPanel({
  projectId,
  parent,
  variants,
  stages,
  onOpenTask,
}: AbComparisonPanelProps) {
  const pickWinner = usePickAbWinner(projectId);
  const updateTask = useUpdateTask(projectId);
  const [confirming, setConfirming] = useState<TaskSummary | null>(null);
  const [dismissing, setDismissing] = useState<TaskSummary | null>(null);
  const winnerId = taskAbWinnerId(parent);
  const winner = variants.find((variant) => variant.id === winnerId);
  const doneCount = variants.filter(
    (variant) => findStage(stages, variant.status)?.type === 'done',
  ).length;

  // A merge error describes the variants as they were; drop it once their
  // ids or stages change so it cannot sit next to a different state.
  const variantsSignature = variants
    .map((variant) => `${variant.id}:${variant.status}`)
    .join('|');
  // reset() detaches an in-flight mutation, so it only runs while idle.
  const { reset: resetPickWinner, isPending: mergePending } = pickWinner;
  const mergePendingRef = useRef(mergePending);
  mergePendingRef.current = mergePending;
  useEffect(() => {
    if (!mergePendingRef.current) resetPickWinner();
  }, [variantsSignature, resetPickWinner]);

  // Closing only hides the dialog; an in-flight pick keeps running and its
  // outcome is shown in the panel.
  const closeConfirm = () => setConfirming(null);
  const confirmMerge = () => {
    if (!confirming) return;
    pickWinner.mutate(
      { parent_task_id: parent.id, winner_task_id: confirming.id },
      { onSettled: () => setConfirming(null) },
    );
  };
  // The variant being merged right now must not be archived underneath the pick.
  const pendingMergeId = pickWinner.isPending
    ? pickWinner.variables?.winner_task_id
    : undefined;
  const confirmDismiss = () => {
    if (!dismissing) return;
    if (dismissing.id !== pendingMergeId) {
      updateTask.mutate({ task_id: dismissing.id, data: { archived: true } });
    }
    setDismissing(null);
  };

  return (
    <section
      data-ui="ab-comparison-panel"
      data-task-id={parent.id}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">Variant comparison</h3>
        <span
          data-ui="ab-comparison-progress"
          className="text-[11px] text-muted-foreground"
        >
          {doneCount}/{variants.length} done
        </span>
        {winnerId && (
          <span
            data-ui="ab-comparison-winner"
            className="inline-flex items-center gap-1 text-[11px] text-green-700 dark:text-green-500"
          >
            <Trophy className="size-3" />
            Winner:{' '}
            {winner ? variantLabel(taskStageVariant(winner) ?? '?') : winnerId}
          </span>
        )}
      </div>
      {pickWinner.isPending && !confirming && (
        <p
          data-ui="ab-merge-pending"
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <Loader2 className="size-3 animate-spin" />
          Merging variant…
        </p>
      )}
      {pickWinner.error && !approvalOfError(pickWinner.error) && (
        <p
          role="alert"
          data-ui="ab-winner-error"
          className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {pickWinner.error.message}
        </p>
      )}
      {variants.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Variant cards appear once the experiment forks.
        </p>
      ) : (
        <ul className="space-y-2">
          {variants.map((variant) => (
            <VariantRow
              key={variant.id}
              projectId={projectId}
              parent={parent}
              variant={variant}
              stages={stages}
              isWinner={variant.id === winnerId}
              winnerPicked={!!winnerId}
              mergeDisabled={pickWinner.isPending}
              mergePending={variant.id === pendingMergeId}
              onOpenTask={onOpenTask}
              onMerge={(picked) => {
                // Reopening a pending pick must not detach the mutation.
                if (!pickWinner.isPending) pickWinner.reset();
                setConfirming(picked);
              }}
              onDismiss={setDismissing}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={!!confirming}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
      >
        <DialogContent data-ui="ab-merge-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              Merge variant{' '}
              {confirming
                ? variantLabel(taskStageVariant(confirming) ?? '?')
                : ''}
              ?
            </DialogTitle>
            <DialogDescription>
              Only this variant&apos;s branch is merged into the default branch
              and the experiment is completed. The other variants stay unmerged.
              This cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              data-ui="ab-merge-cancel"
              onClick={closeConfirm}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-ui="ab-merge-confirm"
              onClick={confirmMerge}
              disabled={pickWinner.isPending}
            >
              {pickWinner.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Merge this variant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!dismissing}
        onOpenChange={(open) => {
          if (!open) setDismissing(null);
        }}
      >
        <DialogContent data-ui="ab-dismiss-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              Dismiss variant{' '}
              {dismissing
                ? variantLabel(taskStageVariant(dismissing) ?? '?')
                : ''}
              ?
            </DialogTitle>
            <DialogDescription>
              Its card is archived and its worktree removed. A dismissed variant
              can no longer be merged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              data-ui="ab-dismiss-cancel"
              onClick={() => setDismissing(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-ui="ab-dismiss-confirm"
              onClick={confirmDismiss}
            >
              Dismiss variant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
