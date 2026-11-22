import {
  AUTO_MODEL_ID,
  getRuntimeCatalog,
  harnessSupportsAuto,
  isAutoSelection,
  resolveAutoSelection,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import type { RuntimeSelection } from '../../lib/chat-agents.js';
import { getModelPricingConfig } from '../../lib/model-pricing.js';
import type { ModelTier } from '../../lib/model-router.js';
import { assertRuntimeAllowed } from '../../lib/privacy-policy.js';
import { availableHarnessIds } from '../boxes/harness-availability.js';
import {
  findProjectGroup,
  objectiveAgentRuntimeEventData,
  resolveAllowedObjectiveRuntime,
} from './brain-client.js';
import {
  materializeObjectiveAgentRuntime,
  resolveObjectiveAgentRuntime,
} from './objective-agent.js';
import type { ObjectiveAgentRuntime } from './objective-agent.js';
import type { Objective } from './types.js';

const TIERS: readonly ModelTier[] = ['fast', 'balanced', 'frontier'];

/** One resolved runtime, in the keys the brain reads from an event payload. */
type ObjectiveRuntimeTierEntry = Record<string, unknown>;

export interface ObjectiveRuntimeTiers {
  effective: ObjectiveRuntimeTierEntry;
  tiers: Partial<Record<ModelTier, ObjectiveRuntimeTierEntry>>;
  unavailableTiers: Array<{ tier: ModelTier; reason: string }>;
  pricing: ReturnType<typeof getModelPricingConfig>;
}

function runtimeEntry(
  runtime: ObjectiveAgentRuntime,
): ObjectiveRuntimeTierEntry {
  const fallback = runtime.agent.fallback;
  return {
    agent_env: {},
    ...objectiveAgentRuntimeEventData(runtime),
    fallback_model: fallback?.model ?? null,
    fallback_reasoning_effort: fallback?.reasoning_effort ?? null,
  };
}

/** The Auto selection whose tier map names an objective's tier runtimes. */
function tierBaseSelection(
  selection: RuntimeSelection,
): RuntimeSelection | null {
  if (isAutoSelection(selection)) return selection;
  if (!harnessSupportsAuto(selection.harnessId)) return null;
  return {
    harnessId: selection.harnessId,
    modelId: AUTO_MODEL_ID,
    ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
  };
}

/** A `harness` request that names no harness this project can run. */
export class RuntimeTiersHarnessError extends Error {}

/**
 * `effective` plus the runtime each Auto tier of `base` resolves to. A tier
 * that cannot resolve is listed in `unavailableTiers`, never returned partially.
 */
function resolveTiers(
  projectId: string,
  effective: ObjectiveAgentRuntime,
  base: RuntimeSelection | null,
): ObjectiveRuntimeTiers {
  const tiers: ObjectiveRuntimeTiers['tiers'] = {};
  const unavailableTiers: ObjectiveRuntimeTiers['unavailableTiers'] = [];
  for (const tier of TIERS) {
    try {
      if (!base)
        throw new Error(
          `no auto tier map for harness ${effective.selection.harnessId}`,
        );
      const selection = resolveAutoSelection(base, tier);
      const runtime = materializeObjectiveAgentRuntime(
        selection,
        resolveRuntimeSelection(selection),
      );
      assertRuntimeAllowed({
        projectId,
        purpose: 'agent',
        runtime: runtime.agent,
      });
      tiers[tier] = runtimeEntry(runtime);
    } catch (err) {
      unavailableTiers.push({
        tier,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    effective: runtimeEntry(effective),
    tiers,
    unavailableTiers,
    pricing: getModelPricingConfig(),
  };
}

/**
 * The objective's effective event runtime plus the runtime each Auto tier
 * resolves to. Throws (like event attachment) when the effective runtime
 * fails to resolve or is refused by privacy mode.
 */
export function resolveObjectiveRuntimeTiers(
  objective: Pick<Objective, 'project_id' | 'eventRuntimeSelection'>,
): ObjectiveRuntimeTiers {
  const effective = resolveAllowedObjectiveRuntime(objective);
  return resolveTiers(
    objective.project_id,
    effective,
    tierBaseSelection(effective.selection),
  );
}

/**
 * The same tier contracts for a project without an objective. Without
 * `harnessId` the project layer decides (project Kanban runtime, then the
 * global Kanban fallback), exactly like an objective without an override.
 * With `harnessId` the tiers come from that harness's Auto tier map and
 * `effective` is its default (balanced) tier. The project's reasoning is only
 * carried over when the project itself runs that harness; strict Auto bindings
 * reject a reasoning that not every tier accepts. Throws
 * `RuntimeTiersHarnessError` for an unknown or not installed harness.
 */
export async function resolveProjectRuntimeTiers(
  projectId: string,
  harnessId?: string,
): Promise<ObjectiveRuntimeTiers> {
  if (harnessId === undefined) {
    const effective = resolveAllowedObjectiveRuntime({
      project_id: projectId,
      eventRuntimeSelection: null,
    });
    return resolveTiers(
      projectId,
      effective,
      tierBaseSelection(effective.selection),
    );
  }

  if (!getRuntimeCatalog().harnesses.some((item) => item.id === harnessId))
    throw new RuntimeTiersHarnessError(`Unknown harness ${harnessId}`);
  const group = findProjectGroup(projectId);
  const installed = group ? await availableHarnessIds(group) : null;
  if (installed && !installed.includes(harnessId))
    throw new RuntimeTiersHarnessError(
      `Harness ${harnessId} is not installed for this project`,
    );
  if (!harnessSupportsAuto(harnessId))
    throw new Error(`no auto tier map for harness ${harnessId}`);

  let projectSelection: RuntimeSelection | undefined;
  try {
    projectSelection = resolveObjectiveAgentRuntime(group, null).selection;
  } catch {
    // An unresolvable project runtime has no reasoning to carry over.
  }
  const base: RuntimeSelection = {
    harnessId,
    modelId: AUTO_MODEL_ID,
    ...(projectSelection?.harnessId === harnessId && projectSelection.reasoning
      ? { reasoning: projectSelection.reasoning }
      : {}),
  };
  const selection = resolveAutoSelection(base, null);
  const effective = materializeObjectiveAgentRuntime(
    selection,
    resolveRuntimeSelection(selection),
  );
  assertRuntimeAllowed({
    projectId,
    purpose: 'agent',
    runtime: effective.agent,
  });
  return resolveTiers(projectId, effective, base);
}
