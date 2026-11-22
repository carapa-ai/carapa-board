import { useState } from 'react';
import {
  CircleCheck,
  CircleX,
  RefreshCw,
  Star,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TaskVerdictSummary } from '@/lib/task-message-rendering';
import { cn, formatRelativeTime } from '@/lib/utils';

const OUTCOME_STYLE: Record<
  TaskVerdictSummary['outcome'],
  { tone: string; Icon: typeof CircleCheck }
> = {
  approved: {
    tone: 'text-emerald-700 dark:text-emerald-400',
    Icon: CircleCheck,
  },
  passed: { tone: 'text-emerald-700 dark:text-emerald-400', Icon: CircleCheck },
  rejected: { tone: 'text-rose-700 dark:text-rose-400', Icon: CircleX },
  failed: { tone: 'text-rose-700 dark:text-rose-400', Icon: CircleX },
  blocked: { tone: 'text-amber-700 dark:text-amber-400', Icon: TriangleAlert },
};

const MAX_ISSUES = 4;
const COLLAPSED_REVIEWS = 2;
const COLLAPSED_TESTING = 1;

function verdictLabel(verdict: TaskVerdictSummary): string {
  return verdict.kind === 'review'
    ? `Review ${verdict.outcome}`
    : `Testing ${verdict.outcome}`;
}

function VerdictItem({ verdict }: { verdict: TaskVerdictSummary }) {
  const { tone, Icon } = OUTCOME_STYLE[verdict.outcome];
  return (
    <li
      data-ui="task-verdict"
      data-kind={verdict.kind}
      data-outcome={verdict.outcome}
      className="space-y-1"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span
          className={cn('inline-flex items-center gap-1 font-medium', tone)}
        >
          <Icon className="size-3.5" aria-hidden />
          {verdictLabel(verdict)}
        </span>
        {verdict.score != null && (
          <span className="font-medium tabular-nums">{verdict.score}/10</span>
        )}
        {verdict.round != null && (
          <span className="text-muted-foreground">
            rejection {verdict.round}
          </span>
        )}
        <span className="text-muted-foreground">
          {formatRelativeTime(verdict.created_at)}
        </span>
      </div>
      {verdict.summary && (
        <p className="break-words text-sm text-foreground/90">
          {verdict.summary}
        </p>
      )}
      {verdict.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 break-words pl-5 text-xs text-muted-foreground">
          {verdict.issues.slice(0, MAX_ISSUES).map((issue, index) => (
            <li key={`${index}:${issue}`}>{issue}</li>
          ))}
          {verdict.issues.length > MAX_ISSUES && (
            <li className="list-none">
              +{verdict.issues.length - MAX_ISSUES} more in the chat
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * Review rounds and testing verdicts with their comments, newest first, so the
 * score, the verdict and the reviewer's issues are readable on the Details tab
 * without scrolling the transcript. Reviews come before testing; older
 * verdicts sit behind one toggle.
 */
export function TaskReviewTestingSummary({
  verdicts,
  onOpenChat,
}: {
  verdicts: TaskVerdictSummary[];
  onOpenChat: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (verdicts.length === 0) return null;
  const reviews = verdicts.filter((v) => v.kind === 'review').reverse();
  const testing = verdicts.filter((v) => v.kind === 'testing').reverse();
  const shown = showAll
    ? [...reviews, ...testing]
    : [
        ...reviews.slice(0, COLLAPSED_REVIEWS),
        ...testing.slice(0, COLLAPSED_TESTING),
      ];
  const hidden = verdicts.length - shown.length;
  return (
    <section
      data-ui="task-review-testing-summary"
      className="flex shrink-0 flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Review &amp; testing
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onOpenChat}
        >
          Open in chat
        </Button>
      </div>
      <ul className="space-y-3">
        {shown.map((verdict) => (
          <VerdictItem key={verdict.id} verdict={verdict} />
        ))}
      </ul>
      {(hidden > 0 || showAll) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 self-start px-2 text-xs"
          aria-expanded={showAll}
          onClick={() => setShowAll((open) => !open)}
        >
          {showAll ? 'Show fewer' : `Show ${hidden} earlier`}
        </Button>
      )}
    </section>
  );
}

/**
 * Review score and rejection count as header chips, so they stay visible on
 * every tab without a click.
 */
export function TaskReviewChips({
  customValues,
}: {
  customValues?: Record<string, string | number>;
}) {
  const score = customValues?.quality_score;
  const rejections = customValues?.rejection_count;
  const rejected = typeof rejections === 'number' && rejections > 0;
  if (score == null && !rejected) return null;
  return (
    <>
      {score != null && (
        <span
          data-ui="task-review-score"
          title="Review score"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
        >
          <Star className="size-3" aria-hidden />
          <span className="font-medium tabular-nums">{score}</span>
          <span className="text-muted-foreground">/ 10</span>
        </span>
      )}
      {rejected && (
        <span
          data-ui="task-rejection-count"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-rose-700 dark:text-rose-400"
        >
          <RefreshCw className="size-3" aria-hidden />
          <span className="font-medium tabular-nums">{rejections}</span>
          <span className="text-muted-foreground">
            {rejections === 1 ? 'rejection' : 'rejections'}
          </span>
        </span>
      )}
    </>
  );
}
