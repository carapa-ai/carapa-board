import fs from 'node:fs';
import path from 'node:path';
import {
  MODEL_ROUTING_ENGINE,
  MODEL_ROUTING_LOG,
  type ModelRoutingEngine,
} from '../config.js';
import { logger } from '../logger.js';
import { setConversationRoutedModel } from '../db.js';
import {
  isAutoSelection,
  resolveAutoPinnedSelection,
  resolveAutoSelection,
  resolveRuntimeSelection,
  type RuntimeSelection,
} from './chat-agents.js';
import {
  routeText,
  type ModelTier,
  type RoutingDecision,
} from './model-router.js';

/**
 * Per-conversation Auto routing. The router runs only where the provider
 * prompt cache is cold anyway (a conversation's first message and the first
 * message after a compaction); the chosen model is then pinned so that
 * follow-up turns never switch models and lose their cache.
 */

export interface AutoModelPin {
  modelId: string;
  /** Absent on pins written before the harness was recorded; they ran on the selection's harness. */
  harnessId?: string | null;
  tier?: string | null;
}

export interface AutoRouting {
  /** Concrete selection to execute this turn. */
  selection: RuntimeSelection;
  /** Set when this turn routed and the result must be persisted. */
  newPin?: {
    modelId: string;
    harnessId: string;
    tier: ModelTier;
    decision: RoutingDecision | null;
  };
}

export interface AutoRoutingDependencies {
  engine: ModelRoutingEngine;
  routeText: typeof routeText;
  resolveAutoSelection: typeof resolveAutoSelection;
  resolveAutoPinnedSelection: typeof resolveAutoPinnedSelection;
  resolveRuntimeSelection: typeof resolveRuntimeSelection;
}

const defaultDependencies: AutoRoutingDependencies = {
  engine: MODEL_ROUTING_ENGINE,
  routeText,
  resolveAutoSelection,
  resolveAutoPinnedSelection,
  resolveRuntimeSelection,
};

/**
 * Concrete selection for `selection` when it is Auto, the engine is `jev` and
 * `pin` still names a model that is valid for its harness; otherwise
 * `undefined`. A pin left over from before the engine was switched off is
 * ignored so Auto resolves to balanced. Non-Auto selections are never touched.
 */
export function applyAutoModelPin(
  selection: RuntimeSelection,
  pin: AutoModelPin | null | undefined,
  dependencies: Pick<
    AutoRoutingDependencies,
    'engine' | 'resolveAutoPinnedSelection' | 'resolveRuntimeSelection'
  > = defaultDependencies,
): RuntimeSelection | undefined {
  if (dependencies.engine !== 'jev') return undefined;
  if (!pin || !isAutoSelection(selection)) return undefined;
  try {
    const pinned = dependencies.resolveAutoPinnedSelection(selection, {
      modelId: pin.modelId,
      harnessId: pin.harnessId ?? selection.harnessId,
      tier: pin.tier,
    });
    dependencies.resolveRuntimeSelection(pinned);
    return pinned;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an Auto `selection` for a fresh user message. Non-Auto selections
 * are returned unchanged and never reach the router. `routable: false` (for
 * example a `/compact` command) resolves without calling the router or
 * pinning.
 */
export async function routeAutoSelection(
  selection: RuntimeSelection,
  input: {
    pin?: AutoModelPin | null;
    userMessage: string;
    routable?: boolean;
    projectId?: string;
  },
  dependencies: AutoRoutingDependencies = defaultDependencies,
): Promise<AutoRouting> {
  if (!isAutoSelection(selection)) return { selection };
  const pinned = applyAutoModelPin(selection, input.pin, dependencies);
  if (pinned) return { selection: pinned };
  if (input.routable === false || dependencies.engine !== 'jev')
    return { selection: dependencies.resolveAutoSelection(selection, null) };

  const decision = await dependencies.routeText(input.userMessage, {
    projectId: input.projectId,
  });
  const tier = decision?.tier ?? 'balanced';
  const routed = dependencies.resolveAutoSelection(selection, tier);
  return {
    selection: routed,
    newPin: {
      modelId: routed.modelId,
      harnessId: routed.harnessId,
      tier,
      decision,
    },
  };
}

/** Persist and log a routing decision. The message text is never logged. */
export async function persistAutoModelPin(
  conversationId: string,
  newPin: NonNullable<AutoRouting['newPin']>,
  requestLog?: { dir: string; userMessage: string },
): Promise<void> {
  const { decision } = newPin;
  logger.info(
    {
      conversationId,
      tier: newPin.tier,
      rawTier: decision?.rawTier ?? null,
      confidence: decision?.confidence ?? null,
      sensitive: decision?.sensitive ?? null,
      latencyMs: decision?.latencyMs ?? null,
      reason: decision?.reason ?? 'router-unavailable',
    },
    'Auto model routed',
  );
  if (MODEL_ROUTING_LOG && requestLog) {
    try {
      const dir = path.join(requestLog.dir, 'routing');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.appendFile(
        path.join(dir, `${path.basename(conversationId)}.jsonl`),
        `${JSON.stringify({
          at: new Date().toISOString(),
          conversationId,
          text: requestLog.userMessage,
          tier: newPin.tier,
          modelId: newPin.modelId,
          decision,
        })}\n`,
      );
    } catch (err) {
      logger.warn({ err, conversationId }, 'Routing request log failed');
    }
  }
  await setConversationRoutedModel(conversationId, newPin);
}
