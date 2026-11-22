import { logger } from '../../logger.js';
import { isRecord } from '../../lib/type-guards.js';

export const DEPLOY_HOST_BUILD_KEY = 'deploy_host_build';
export const DEPLOY_PENDING_DISPATCH_KEY = 'deploy_pending_dispatch';
/**
 * Written by restart recovery in the same update that moves a card for a
 * completed run: `{ runId, stage, notice }`. It proves that move was the
 * recovery's own and whether the completion notice is still owed, so a retry
 * after a later failure replays only what the move still owes.
 */
export const RECOVERY_TRANSITION_KEY = 'recovery_transition';
/** This run's own recorded card transition (see RECOVERY_TRANSITION_KEY). */
export function readRecoveryTransition(
  task: { custom_values?: Record<string, string | number> | null },
  runId: string,
): { stage: string; notice: boolean } | undefined {
  const raw = task.custom_values?.[RECOVERY_TRANSITION_KEY];
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.runId === runId && typeof parsed.stage === 'string'
      ? { stage: parsed.stage, notice: parsed.notice === true }
      : undefined;
  } catch {
    return undefined;
  }
}

export function recoveryTransitionValue(
  runId: string,
  stage: string,
  notice: boolean,
): Record<string, string> {
  return {
    [RECOVERY_TRANSITION_KEY]: JSON.stringify({ runId, stage, notice }),
  };
}

/**
 * Pipeline-owned deploy handoff markers whose presence and removal are owned
 * by the deploy lifecycle, so concurrent snapshot writes via `update_values` or
 * task `PATCH` can neither restore a consumed marker nor erase an active one.
 */
export const DEPLOY_HANDOFF_VALUE_KEYS = [
  DEPLOY_PENDING_DISPATCH_KEY,
  DEPLOY_HOST_BUILD_KEY,
] as const;

/**
 * `custom_values` keys the pipeline reads to make decisions (review caps,
 * cost limit, merge bookkeeping, routing, testing evidence). Task-run agents
 * may only write project-declared keys; the pipeline itself writes these
 * through DB functions directly and is not subject to this guard.
 */
const PIPELINE_OWNED_KEYS: ReadonlySet<string> = new Set([
  'rejection_count',
  'rejection_cap_base',
  'nit_round_count',
  'quality_score',
  'last_review_head',
  'review_history',
  'review_chain',
  'review_chain_run',
  'pending_review_reviewers',
  'pending_review_head',
  'pending_review_decision',
  'no_progress_count',
  'task_diff_base_sha',
  'completed_commit_sha',
  'linked_repository_merges',
  'routing',
  'transient_retries',
  'cost_limit_usd',
  'cost_limit_hit_at',
  'failure_class',
  'failure_reason',
  DEPLOY_HOST_BUILD_KEY,
  DEPLOY_PENDING_DISPATCH_KEY,
  RECOVERY_TRANSITION_KEY,
]);

const PIPELINE_OWNED_PREFIX = 'testing_';

export function isPipelineOwnedValueKey(key: string): boolean {
  return PIPELINE_OWNED_KEYS.has(key) || key.startsWith(PIPELINE_OWNED_PREFIX);
}

/**
 * Pipeline-owned keys a credential may not write. A credential whose scope
 * carries a `task_id` is a task-run token; brain, board-client and user
 * credentials have none and are never denied.
 */
function deniedPipelineOwnedValueKeys(
  scope: { task_id?: string } | undefined,
  values: unknown,
): string[] {
  if (!scope?.task_id) return [];
  if (!isRecord(values)) return [];
  return Object.keys(values).filter(isPipelineOwnedValueKey);
}

/**
 * For a write that replaces the stored map (task PATCH), keep the stored
 * pipeline-owned keys when the caller is a task-run token so that omitting
 * them cannot erase them. Other credentials get the map unchanged.
 */
export function withStoredPipelineOwnedValues<
  T extends Record<string, unknown>,
>(
  scope: { task_id?: string } | undefined,
  replacement: T,
  stored: Record<string, unknown> | null | undefined,
): T {
  if (!scope?.task_id || !stored) return replacement;
  const kept = Object.fromEntries(
    Object.entries(stored).filter(([key]) => isPipelineOwnedValueKey(key)),
  );
  return { ...replacement, ...kept };
}

/**
 * Returns a clear error message (and logs a warning) when the credential may
 * not write the given values, or null when the write is allowed. Callers must
 * check this before writing anything so a denial never causes a partial write.
 */
export function pipelineOwnedValuesDenial(
  scope: { task_id?: string } | undefined,
  values: unknown,
  taskId: string | undefined,
): string | null {
  const denied = deniedPipelineOwnedValueKeys(scope, values);
  if (denied.length === 0) return null;
  logger.warn(
    { task_id: taskId, run_task_id: scope?.task_id, denied_keys: denied },
    'Rejected task-run write of pipeline-owned custom values',
  );
  const plural = denied.length > 1;
  return `Forbidden: ${denied.join(', ')} ${plural ? 'are pipeline-owned custom values' : 'is a pipeline-owned custom value'} and cannot be written by a task-run credential`;
}
