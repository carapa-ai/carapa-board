import type { ReactNode } from 'react';
import { Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatDuration, formatRelativeTime } from '@/lib/utils';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import type { TaskRunLog } from '@/types';

export interface RunHistoryPresentationData {
  id: string;
  status: string;
  runAt: string;
  durationMs: number | null;
  model: string | null;
  modelName?: string | null;
  tokenTotal: number | null;
  costUsd: number | null;
  result: string | null;
  error: string | null;
}

const TESTING_VERDICT_LABEL = {
  pass: 'passed',
  fail: 'failed',
  blocked: 'blocked',
} as const;

/**
 * Label of a run's outcome. A finished testing run shows the tester's verdict
 * instead of the process outcome; an unknown verdict keeps the process status.
 */
export function runHistoryStatus(
  run: Pick<TaskRunLog, 'status' | 'testingDecision'>,
): string {
  return run.status === 'success' && run.testingDecision
    ? TESTING_VERDICT_LABEL[run.testingDecision]
    : run.status;
}

function statusDotClass(status: string) {
  if (status === 'success' || status === 'passed') {
    return 'bg-green-600 dark:bg-green-500';
  }
  if (status === 'blocked') return 'bg-amber-600 dark:bg-amber-500';
  if (status === 'running' || status === 'finalizing') {
    return 'bg-blue-600 dark:bg-blue-500 animate-pulse';
  }
  if (status === 'stopped') return 'bg-yellow-700 dark:bg-yellow-500';
  return 'bg-red-600 dark:bg-red-500';
}

export function RunHistoryEntryPresentation({
  run,
  details,
  metrics,
}: {
  run: RunHistoryPresentationData;
  details?: ReactNode;
  metrics?: ReactNode;
}) {
  const model = run.modelName || run.model;
  return (
    <>
      <RunHistoryEntryHeader run={run} />
      <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        {model && (
          <div className="flex items-center gap-1 min-w-0">
            <span className="font-semibold shrink-0">Model:</span>
            <span
              className="font-mono text-[10px] text-foreground/80 truncate"
              title={model}
            >
              {model}
            </span>
          </div>
        )}
        {details}
        {metrics ??
          (run.tokenTotal != null && (
            <div className="tabular-nums">
              ~{run.tokenTotal.toLocaleString()} tokens
            </div>
          ))}
        {run.error && (
          <div className="text-red-600 dark:text-red-500 line-clamp-2">
            {run.error}
          </div>
        )}
        {run.result && (
          <div className="opacity-80 line-clamp-3 overflow-hidden text-xs bg-muted/50 p-1.5 rounded mt-1 font-mono">
            {run.result.slice(0, 300)}
            {run.result.length > 300 ? '...' : ''}
          </div>
        )}
      </div>
    </>
  );
}

export function RunHistoryEntryHeader({
  run,
  trailing,
  lead,
  detail,
  showId = true,
}: {
  run: RunHistoryPresentationData;
  trailing?: ReactNode;
  /** Shown right after the outcome, e.g. the stage the run executed in. */
  lead?: ReactNode;
  /** Agent and model, truncated before the figures on the right. */
  detail?: ReactNode;
  /** The run id is secondary: callers may show it on a lower line instead. */
  showId?: boolean;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className={`size-2 rounded-full shrink-0 ${statusDotClass(run.status)}`}
        />
        <span className="text-xs font-medium capitalize">{run.status}</span>
        {lead}
        {detail}
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(run.runAt)}
        </span>
        {showId && (
          <span
            className="ml-1 max-w-[140px] truncate font-mono text-[11px] text-muted-foreground"
            title={`Run id: ${run.id}`}
          >
            {run.id}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
        {trailing}
        {run.costUsd != null && (
          <span className={COST_TEXT_CLASS} title="Measured cost for this run">
            ${run.costUsd.toFixed(4)}
          </span>
        )}
        {run.durationMs != null && (
          <span className="text-muted-foreground">
            {formatDuration(run.durationMs)}
          </span>
        )}
      </div>
    </div>
  );
}

export function TaskRunHistoryEntryFrame({
  run,
  onJump,
  children,
}: {
  run: TaskRunLog;
  onJump: (runId: string) => void;
  children: ReactNode;
}) {
  return (
    <div
      data-ui="task-run-history-entry"
      data-run-id={run.id}
      role="button"
      tabIndex={0}
      title="Jump to this run in chat"
      onClick={() => onJump(run.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onJump(run.id);
        }
      }}
      className="p-3 hover:bg-muted/40 hover:cursor-pointer transition-colors"
    >
      {children}
    </div>
  );
}

export function TaskRunReviewScore({ score }: { score: number | null }) {
  if (score == null) return null;
  return (
    <Badge
      data-ui="task-run-review-score"
      variant="outline"
      className="text-[11px] h-4 px-1 gap-0.5 text-amber-700 border-amber-600 dark:text-amber-500 dark:border-amber-500/30"
      title="Review score"
    >
      <Star className="size-2.5" />
      {score}
    </Badge>
  );
}
