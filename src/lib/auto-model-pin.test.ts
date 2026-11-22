import { describe, expect, test } from 'bun:test';
import {
  normalizeBoardAgentsConfig,
  resolveAutoPinnedSelection,
  resolveAutoSelection,
  resolveRuntimeFromAgents,
} from './chat-agents.js';
import {
  routeAutoSelection,
  type AutoRoutingDependencies,
} from './auto-model-pin.js';
import type { ModelTier, RoutingDecision } from './model-router.js';

const cli = { label: 'claude', kind: 'cli', agentCmd: 'claude' };
const config = {
  version: 2,
  harnesses: { claude: cli },
  models: {
    'harness-configured-default': {
      label: 'Harness configured default',
      bindings: { claude: {} },
    },
    haiku: { label: 'Haiku', bindings: { claude: { model: 'haiku' } } },
    sonnet: { label: 'Sonnet', bindings: { claude: { model: 'sonnet' } } },
    opus: { label: 'Opus', bindings: { claude: { model: 'opus' } } },
    auto: {
      label: 'Auto',
      auto: true,
      bindings: {
        claude: {
          tiers: { fast: 'haiku', balanced: 'sonnet', frontier: 'opus' },
        },
      },
    },
  },
  defaults: { harnessId: 'claude', modelId: 'sonnet' },
};
const { agents, autoTiers } = normalizeBoardAgentsConfig(config, {
  routingEngine: 'jev',
});

function harness(
  engine: 'off' | 'jev',
  tier: ModelTier | null,
): {
  calls: string[];
  options: unknown[];
  deps: AutoRoutingDependencies;
} {
  const calls: string[] = [];
  const options: unknown[] = [];
  return {
    calls,
    options,
    deps: {
      engine,
      routeText: async (text, routeOptions) => {
        calls.push(text);
        options.push(routeOptions);
        return tier
          ? ({ tier, rawTier: tier, latencyMs: 1 } as RoutingDecision)
          : null;
      },
      resolveAutoSelection: (sel, t) => resolveAutoSelection(sel, t, autoTiers),
      resolveAutoPinnedSelection: (sel, pin) =>
        resolveAutoPinnedSelection(sel, pin, autoTiers),
      resolveRuntimeSelection: (sel) =>
        resolveRuntimeFromAgents(agents, sel, autoTiers),
    },
  };
}

const auto = { harnessId: 'claude', modelId: 'auto' };

describe('Auto model pinning', () => {
  test('routes the first message once, then keeps the pinned model until the pin is cleared', async () => {
    const { calls, deps } = harness('jev', 'fast');
    const first = await routeAutoSelection(
      auto,
      { userMessage: 'rename foo to bar' },
      deps,
    );
    expect(first.selection.modelId).toBe('haiku');
    expect(first.newPin?.modelId).toBe('haiku');

    for (let i = 0; i < 3; i++) {
      const next = await routeAutoSelection(
        auto,
        { userMessage: `follow-up ${i}`, pin: { modelId: 'haiku' } },
        deps,
      );
      expect(next.selection.modelId).toBe('haiku');
      expect(next.newPin).toBeUndefined();
    }
    expect(calls).toEqual(['rename foo to bar']);

    // Compaction clears the pin: the next message routes again.
    const recompacted = await routeAutoSelection(
      auto,
      { userMessage: 'design a new architecture' },
      harness('jev', 'frontier').deps,
    );
    expect(recompacted.selection.modelId).toBe('opus');
  });

  test('an unavailable router pins the balanced model', async () => {
    const { calls, deps } = harness('jev', null);
    const routing = await routeAutoSelection(auto, { userMessage: 'hi' }, deps);
    expect(calls).toHaveLength(1);
    expect(routing.selection.modelId).toBe('sonnet');
    expect(routing.newPin).toMatchObject({
      modelId: 'sonnet',
      tier: 'balanced',
    });
  });

  test('never calls the router for engine off, a non-Auto selection, or a /compact turn', async () => {
    const off = harness('off', 'fast');
    const offRouting = await routeAutoSelection(
      auto,
      { userMessage: 'hi' },
      off.deps,
    );
    expect(offRouting.selection.modelId).toBe('sonnet');
    expect(offRouting.newPin).toBeUndefined();
    // A pin from before the engine was switched off no longer applies.
    const stalePin = await routeAutoSelection(
      auto,
      { userMessage: 'hi', pin: { modelId: 'opus' } },
      off.deps,
    );
    expect(stalePin.selection.modelId).toBe('sonnet');

    const jev = harness('jev', 'fast');
    for (const modelId of ['opus', 'harness-configured-default']) {
      const routing = await routeAutoSelection(
        { harnessId: 'claude', modelId },
        { userMessage: 'hi' },
        jev.deps,
      );
      expect(routing.selection.modelId).toBe(modelId);
    }
    const compact = await routeAutoSelection(
      auto,
      { userMessage: '/compact', routable: false },
      jev.deps,
    );
    expect(compact.newPin).toBeUndefined();
    expect([...off.calls, ...jev.calls]).toEqual([]);
  });

  test('forwards the project to the router so its privacy mode applies', async () => {
    const { options, deps } = harness('jev', 'fast');
    await routeAutoSelection(
      auto,
      { userMessage: 'rename foo', projectId: 'proj-a' },
      deps,
    );
    expect(options).toEqual([{ projectId: 'proj-a' }]);
  });
});
