/**
 * Kanban "Auto" model routing. A task or stage whose runtime selection is the
 * Auto model is routed to a concrete tier only when its run starts a fresh
 * session; the decision is recorded in `custom_values.routing[stageId]` so
 * continuing sessions (and restart recovery) keep the model they started with.
 */

import {
  resolveAutoSelection,
  type AutoCandidate,
  type RuntimeSelection,
} from '../../../lib/chat-agents.js';
import type { ModelTier, RoutingDecision } from '../../../lib/model-router.js';
import { isRecord } from '../../../lib/type-guards.js';
import { getTask, updateTask } from '../../../db.js';
import {
  selectCapacityCandidate,
  type CapacityChoice,
  type CapacityReason,
} from '../../provider-usage/capacity.js';
import type { ProviderUsageAccount } from '../../provider-usage/tools.js';
import { readReviewHistory, type ReviewProgress } from '../review.js';
import type { Task } from '../types.js';
import { TESTING_FAILURE_COUNT_KEY } from './testing.js';

const TIER_LADDER: readonly ModelTier[] = ['fast', 'balanced', 'frontier'];

type StageRoutingReason =
  | RoutingDecision['reason']
  | 'router-unavailable'
  | 'escalation-no-progress'
  | 'escalation-kept'
  | 'escalation-router'
  /** The stage's `minTier` raised the routed tier. */
  | 'stage-min-tier';

/** One entry of `custom_values.routing`, keyed by stage ID. */
export interface StageRoutingRecord {
  tier: ModelTier;
  rawTier: ModelTier;
  /**
   * Harness the run started on. Absent on records written before routing could
   * leave the Auto selection's harness; those keep that harness.
   */
  harnessId?: string;
  /**
   * Session agent key of the agent the run started on. It names the owner of
   * the native session that a later resumption would continue. Absent on
   * records written before it was recorded.
   */
  sessionAgentKey?: string;
  modelId: string;
  /**
   * Why the tier's candidate was chosen by provider capacity. Absent when the
   * tier has a single candidate.
   */
  capacityReason?: CapacityReason;
  /** Remaining capacity of the chosen account's shortest window, when known. */
  remainingCapacity?: number;
  confidence: number | null;
  sensitive: number;
  latencyMs: number;
  reason: StageRoutingReason;
  at: string;
  /** `rejection_count` when decided; a higher value later means escalation. */
  rejectionCount: number;
  /** `testing_failure_count` when decided. */
  testingFailureCount: number;
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function higherTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_LADDER.indexOf(a) >= TIER_LADDER.indexOf(b) ? a : b;
}

function oneTierUp(tier: ModelTier): ModelTier {
  return TIER_LADDER[TIER_LADDER.indexOf(tier) + 1] ?? tier;
}

/** The recorded decision for `stageId`, or undefined when absent or malformed. */
export function readStageRouting(
  customValues: Task['custom_values'] | undefined,
  stageId: string,
): StageRoutingRecord | undefined {
  const routing: unknown = customValues?.routing;
  const entry = isRecord(routing) ? routing[stageId] : undefined;
  if (!isRecord(entry) || !TIER_LADDER.includes(entry.tier as ModelTier))
    return undefined;
  return entry as unknown as StageRoutingRecord;
}

/**
 * Choose the tier for a fresh session of `stageId` and describe the decision.
 * `route` is `routeText`, called at most once. `route: null` means routing is
 * off: no router call and no escalation. The record then holds the stage's
 * `minTier`, or is `null` when that does not raise the balanced default.
 * `minTier` is a floor for every decision, including escalations.
 * `providerUsage` (null when unavailable) steers the choice among a tier's
 * cross-provider candidates; the tier itself is never changed by it.
 */
export async function decideStageRouting(input: {
  task: Pick<Task, 'title' | 'description' | 'custom_values'>;
  stageId: string;
  selection: RuntimeSelection;
  minTier?: ModelTier;
  providerUsage?: ProviderUsageAccount[] | null;
  route: ((text: string) => Promise<RoutingDecision | null>) | null;
}): Promise<StageRoutingRecord | null> {
  const { task, stageId, selection, minTier, route } = input;
  const providerUsage = input.providerUsage ?? null;
  const values = task.custom_values;
  const rejectionCount = count(values?.rejection_count);
  const testingFailureCount = count(values?.[TESTING_FAILURE_COUNT_KEY]);
  const stored = readStageRouting(values, stageId);
  const startedAt = Date.now();

  const record = (
    routed: ModelTier,
    routedReason: StageRoutingReason,
    decision?: RoutingDecision | null,
  ): StageRoutingRecord => {
    const tier =
      minTier && TIER_LADDER.indexOf(minTier) > TIER_LADDER.indexOf(routed)
        ? minTier
        : routed;
    let choice: CapacityChoice<AutoCandidate> | undefined;
    const target = resolveAutoSelection(
      selection,
      tier,
      undefined,
      (candidates) =>
        (choice = selectCapacityCandidate(candidates, providerUsage)).candidate,
    );
    return {
      tier,
      rawTier: decision?.rawTier ?? stored?.rawTier ?? routed,
      harnessId: target.harnessId,
      modelId: target.modelId,
      ...(choice?.capacityReason && {
        capacityReason: choice.capacityReason,
        ...(choice.remainingCapacity !== undefined && {
          remainingCapacity: choice.remainingCapacity,
        }),
      }),
      confidence: decision ? decision.confidence : (stored?.confidence ?? null),
      sensitive: decision?.sensitive ?? stored?.sensitive ?? 0,
      latencyMs: decision?.latencyMs ?? 0,
      reason: tier === routed ? routedReason : 'stage-min-tier',
      at: new Date().toISOString(),
      rejectionCount,
      testingFailureCount,
    };
  };

  if (!route) {
    if (
      !minTier ||
      TIER_LADDER.indexOf(minTier) <= TIER_LADDER.indexOf('balanced')
    )
      return null;
    return record('balanced', 'stage-min-tier');
  }

  const rejected = !!stored && rejectionCount > count(stored.rejectionCount);
  const testFailed =
    !!stored && testingFailureCount > count(stored.testingFailureCount);
  const baseText = `${task.title}\n\n${task.description ?? ''}`;

  if (!stored || (!rejected && !testFailed)) {
    const decision = await route(baseText);
    if (!decision) {
      const fallback = record('balanced', 'router-unavailable');
      return { ...fallback, latencyMs: Date.now() - startedAt };
    }
    return record(decision.tier, decision.reason, decision);
  }

  // The tier never goes down on escalation. Only a rejection with no testing
  // failure since the stored decision has a review comparison to consult.
  const latestReview = rejected ? readReviewHistory(values).at(-1) : undefined;
  const progress: ReviewProgress | undefined = testFailed
    ? undefined
    : latestReview?.comparison?.progress;
  if (progress === 'no_progress' || progress === 'persistent_issue')
    return record(oneTierUp(stored.tier), 'escalation-no-progress');
  if (progress === 'resolved_issue')
    return record(stored.tier, 'escalation-kept');

  const issues = latestReview?.issues.map((issue) => issue.text).join('\n');
  const decision = await route(issues ? `${baseText}\n\n${issues}` : baseText);
  if (!decision) {
    const fallback = record(stored.tier, 'router-unavailable');
    return { ...fallback, latencyMs: Date.now() - startedAt };
  }
  return record(
    higherTier(stored.tier, decision.tier),
    'escalation-router',
    decision,
  );
}

/**
 * Merge one decision into `custom_values.routing` without touching other values.
 * A `null` record removes the stage's decision: a fresh run that is not routed
 * must not leave an earlier pin for its continuations to restore.
 */
export async function persistStageRouting(
  task: Pick<Task, 'id' | 'custom_values'>,
  stageId: string,
  record: StageRoutingRecord | null,
): Promise<void> {
  const latest = (await getTask(task.id)) ?? task;
  const values = latest.custom_values ?? {};
  const current: Record<string, unknown> = isRecord(values.routing)
    ? values.routing
    : {};
  if (!record && !(stageId in current)) return;
  const routing: Record<string, unknown> = { ...current };
  if (record) routing[stageId] = record;
  else delete routing[stageId];
  await updateTask(task.id, {
    // `routing` is a nested object; the column stores arbitrary JSON.
    custom_values: {
      ...values,
      routing,
    } as unknown as Task['custom_values'],
  });
}
