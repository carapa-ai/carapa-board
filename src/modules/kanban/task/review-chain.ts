/**
 * Serial multi-reviewer chain for a review stage.
 *
 * A task with `co_stages` review entries (e.g. `review.o`) is judged by the
 * stage's own runtime first and then by each entry, one run at a time, all on
 * the same commit. Verdicts accumulate in `custom_values.review_chain` while
 * the card stays in the review stage; the card is decided once, after the last
 * reviewer, by `aggregateReviewChain`.
 */
import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import {
  isAutoSelection,
  type RuntimeSelection,
} from '../../../lib/chat-agents.js';
import { resolveCoStages } from '../stages.js';
import {
  formatReviewIssue,
  reviewIssueId,
  type ReviewDecision,
  type ReviewerVerdictSummary,
  type ReviewIssue,
} from '../review.js';

export const REVIEW_CHAIN_KEY = 'review_chain';
/** Marks the chain run that is in flight, so restart recovery can place it. */
export const REVIEW_CHAIN_RUN_KEY = 'review_chain_run';
/** Reviewer verdict summaries of a rejection awaiting its progress comparison. */
export const PENDING_REVIEW_REVIEWERS_KEY = 'pending_review_reviewers';

export interface ReviewChainVerdict {
  /** Stage id that ran: the review stage itself or a `<stage>.<suffix>` alternative. */
  stage_id: string;
  /** Model (or agent) label that judged, used to attribute issues. */
  reviewer: string;
  /** `null` when the run produced no valid decision. */
  decision: 'approve' | 'reject' | null;
  score: number | null;
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewChain {
  /** Commit every reviewer of this chain must judge. */
  head: string;
  /** When the primary review run began; later reviewers see only older history. */
  started_at: string;
  /**
   * Latest run of the task when the chain was last written. The chain continues
   * only while that is still the task's latest run; a coding run (or any other
   * run) in between means the round was abandoned.
   */
  after_run_id: string;
  /** Whether the round was admitted by a manual Review trigger (waives stale Testing evidence). */
  manual: boolean;
  /** Extra reviewer stage ids, in run order, frozen when the chain started. */
  stages: string[];
  /** One verdict per finished run: the primary first, then each extra in order. */
  verdicts: ReviewChainVerdict[];
}

/** Persisted when a chain reviewer run starts (see `REVIEW_CHAIN_RUN_KEY`). */
export interface ReviewChainRunMarker {
  run_id: string;
  role: 'primary' | 'extra';
  /** Stage that ran: the review stage itself or the extra's alternative. */
  stage_id: string;
  stages: string[];
  head: string;
  started_at: string;
  manual: boolean;
}

export function readReviewChainRun(
  customValues?: Record<string, string | number>,
): ReviewChainRunMarker | null {
  const raw = customValues?.[REVIEW_CHAIN_RUN_KEY];
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    if (
      value &&
      typeof value.run_id === 'string' &&
      (value.role === 'primary' || value.role === 'extra') &&
      typeof value.stage_id === 'string' &&
      Array.isArray(value.stages) &&
      typeof value.head === 'string' &&
      typeof value.started_at === 'string'
    ) {
      return {
        ...value,
        manual: value.manual === true,
      } as ReviewChainRunMarker;
    }
  } catch {
    // An unreadable marker cannot place a recovered run.
  }
  return null;
}

/**
 * The review role this run plays: the stage's own runtime, or the extra
 * reviewer `stageId` of an in-progress chain.
 */
export type ReviewChainPlan =
  | { role: 'primary'; stages: string[] }
  | { role: 'extra'; stages: string[]; stageId: string; chain: ReviewChain };

/**
 * Review alternatives of `task.coStages` that run after `reviewStageId`'s own
 * runtime. Testing entries and entries for other stages are not reviewers.
 */
export function resolveCoReviewStages(
  group: RegisteredGroup,
  task: Pick<Task, 'coStages' | 'stageVariant'>,
  reviewStageId: string,
): string[] {
  return resolveCoStages(group, task, reviewStageId, 'review');
}

export function readReviewChain(
  customValues?: Record<string, string | number>,
): ReviewChain | null {
  const raw = customValues?.[REVIEW_CHAIN_KEY];
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    if (
      value &&
      typeof value.head === 'string' &&
      typeof value.started_at === 'string' &&
      Array.isArray(value.stages) &&
      Array.isArray(value.verdicts) &&
      value.verdicts.length > 0 &&
      value.verdicts.length <= value.stages.length + 1
    ) {
      return {
        ...value,
        manual: value.manual === true,
        after_run_id:
          typeof value.after_run_id === 'string' ? value.after_run_id : '',
      } as ReviewChain;
    }
  } catch {
    // A malformed chain is treated as absent: the review starts over.
  }
  return null;
}

/** Stage id of the next extra reviewer, or undefined once every reviewer ran. */
export function nextReviewChainStage(chain: ReviewChain): string | undefined {
  return chain.stages[chain.verdicts.length - 1];
}

/**
 * Decide this run's role. A chain continues only for the exact commit it
 * started on and while reviewers remain; anything else (no chain, finished
 * chain, `restart`) begins a new chain with the stage's own runtime.
 */
export function planReviewChain(
  coReviewStages: string[],
  chain: ReviewChain | null,
  restart: boolean,
): ReviewChainPlan | undefined {
  if (!restart && chain) {
    const stageId = nextReviewChainStage(chain);
    if (stageId) return { role: 'extra', stages: chain.stages, stageId, chain };
  }
  return coReviewStages.length > 0
    ? { role: 'primary', stages: coReviewStages }
    : undefined;
}

/** `harness/model/reasoning` label of a resolved runtime, e.g. `claude/claude-opus-5-5/high`. */
function formatRuntimeSelectionLabel(selection: RuntimeSelection): string {
  return [selection.harnessId, selection.modelId, selection.reasoning]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join('/');
}

/** An extra reviewer dropped at chain start because it would rerun the primary's runtime. */
export interface SkippedCoReviewStage {
  stageId: string;
  /** Label of the identical runtime, for the transcript notice. */
  runtime: string;
}

function normalizedReasoning(selection: RuntimeSelection): string | undefined {
  return typeof selection.reasoning === 'string' && selection.reasoning.trim()
    ? selection.reasoning
    : undefined;
}

/**
 * Split a chain's extra reviewers into the ones to keep and the ones to skip
 * because their effective runtime is identical to the primary run's (same
 * harness, model and reasoning after `resolveKanbanRuntimeSelection`
 * layering): the same model on the same commit twice is cost, not a second
 * opinion. An Auto selection on either side is never skipped — the routed
 * model is not known in advance — and a runtime that fails to resolve is
 * kept, so the run itself reports that error.
 */
export function partitionCoReviewStagesByRuntime(
  stages: readonly string[],
  primary: RuntimeSelection,
  resolveExtraRuntime: (stageId: string) => RuntimeSelection,
): { kept: string[]; skipped: SkippedCoReviewStage[] } {
  const kept: string[] = [];
  const skipped: SkippedCoReviewStage[] = [];
  if (isAutoSelection(primary)) return { kept: [...stages], skipped };
  for (const stageId of stages) {
    let extra: RuntimeSelection;
    try {
      extra = resolveExtraRuntime(stageId);
    } catch {
      kept.push(stageId);
      continue;
    }
    const identical =
      !isAutoSelection(extra) &&
      extra.harnessId === primary.harnessId &&
      extra.modelId === primary.modelId &&
      normalizedReasoning(extra) === normalizedReasoning(primary);
    if (identical) {
      skipped.push({ stageId, runtime: formatRuntimeSelectionLabel(extra) });
    } else {
      kept.push(stageId);
    }
  }
  return { kept, skipped };
}

export function summarizeReviewerVerdicts(
  verdicts: ReviewChainVerdict[],
): ReviewerVerdictSummary[] {
  return verdicts.map((verdict) => ({
    reviewer: verdict.reviewer,
    decision: verdict.decision,
    score: verdict.score,
    issue_count: verdict.issues.length,
    stage_id: verdict.stage_id,
    ...(verdict.decision === 'reject'
      ? {
          issues: verdict.issues.map((issue) => ({
            id: reviewIssueId(issue),
            text: formatReviewIssue(issue),
          })),
        }
      : {}),
  }));
}

export type ReviewChainOutcome =
  | { kind: 'decided'; decision: ReviewDecision }
  /** No reviewer rejected, but at least one produced no valid decision. */
  | { kind: 'incomplete'; failedReviewers: string[] };

/**
 * Issues of `verdicts` as one list: prefixed by reviewer, exact duplicates
 * merged. Issues whose id is in `exclude` are left out.
 */
function compoundIssues(
  verdicts: ReviewChainVerdict[],
  exclude?: ReadonlySet<string>,
): ReviewIssue[] {
  const merged = new Map<string, { issue: ReviewIssue; reviewers: string[] }>();
  for (const verdict of verdicts) {
    for (const issue of verdict.issues) {
      const id = reviewIssueId(issue);
      if (exclude?.has(id)) continue;
      const entry = merged.get(id);
      if (!entry) merged.set(id, { issue, reviewers: [verdict.reviewer] });
      else if (!entry.reviewers.includes(verdict.reviewer)) {
        entry.reviewers.push(verdict.reviewer);
      }
    }
  }
  return [...merged.values()].map(({ issue, reviewers }) => ({
    title: `[${reviewers.join(', ')}] ${issue.title}`,
    description: issue.description,
  }));
}

/** Verdict summaries as `[reviewer] summary` paragraphs, empty ones skipped. */
function compoundSummaries(verdicts: ReviewChainVerdict[]): string {
  return verdicts
    .map((v) => (v.summary ? `[${v.reviewer}] ${v.summary}` : ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Compound the chain's verdicts into the single decision the card receives.
 *
 * Approved only when every reviewer approved. Otherwise rejected once with the
 * rejecting reviewers' issues and the lowest score; approving reviewers'
 * issues and summaries ride along as non-blocking `advisory_*` fields. A chain
 * with no rejection but a reviewer without a valid decision is never an
 * approval.
 */
export function aggregateReviewChain(
  verdicts: ReviewChainVerdict[],
): ReviewChainOutcome {
  const rejecting = verdicts.filter((v) => v.decision === 'reject');
  const failed = verdicts.filter((v) => v.decision === null);
  const scores = verdicts
    .filter((v) => v.decision !== null && v.score !== null)
    .map((v) => v.score as number);
  const score = scores.length > 0 ? Math.min(...scores) : 1;

  if (rejecting.length > 0) {
    const approving = verdicts.filter((v) => v.decision === 'approve');
    const blockingIds = new Set(
      rejecting.flatMap((v) => v.issues.map(reviewIssueId)),
    );
    const advisoryIssues = compoundIssues(approving, blockingIds);
    const advisorySummary = compoundSummaries(approving);
    return {
      kind: 'decided',
      decision: {
        decision: 'reject',
        score,
        issues: compoundIssues(rejecting),
        summary: compoundSummaries(rejecting),
        ...(advisoryIssues.length > 0
          ? { advisory_issues: advisoryIssues }
          : {}),
        ...(advisorySummary ? { advisory_summary: advisorySummary } : {}),
      },
    };
  }
  if (failed.length > 0) {
    return {
      kind: 'incomplete',
      failedReviewers: failed.map((v) => v.reviewer),
    };
  }
  return {
    kind: 'decided',
    decision: {
      decision: 'approve',
      score,
      issues: compoundIssues(verdicts),
      summary: compoundSummaries(verdicts),
    },
  };
}

/** One-line description of a verdict for the transcript. */
export function formatReviewChainVerdict(verdict: ReviewChainVerdict): string {
  if (verdict.decision === null) {
    return `**Reviewer ${verdict.reviewer}** produced no valid decision.`;
  }
  const verb = verdict.decision === 'approve' ? 'approved' : 'rejected';
  const issues = verdict.issues.length
    ? `\n\n**Issues:**\n${verdict.issues.map((i) => `- ${formatReviewIssue(i)}`).join('\n')}`
    : '';
  return `**Reviewer ${verdict.reviewer}** ${verb} (score: ${verdict.score}/10)${verdict.summary ? `\n\n${verdict.summary}` : ''}${issues}`;
}

/**
 * Whether a transcript entry is part of the conversation an extra reviewer
 * sees: everything from before the chain started, plus steering and stage
 * prompt entries at any time. Those are delivery bookkeeping; hiding a queued
 * prompt would leave it undelivered and the card held forever.
 */
export function isVisibleToExtraReviewer(
  message: { created_at: string; steering?: boolean; entry_type?: string },
  chainStartedAt: string,
): boolean {
  return (
    Date.parse(message.created_at) < Date.parse(chainStartedAt) ||
    message.steering === true ||
    /steering|stage_prompt|stage_handoff/.test(message.entry_type ?? '')
  );
}
