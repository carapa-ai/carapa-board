import { describe, expect, test } from 'bun:test';
import {
  isAutoSelection,
  normalizeBoardAgentsConfig,
  resolveAutoPinnedSelection,
  resolveAutoSelection,
  resolveRuntimeFromAgents,
} from './chat-agents.js';

const cli = (agentCmd: string) => ({
  label: agentCmd,
  kind: 'cli',
  agentCmd,
});
const tiers = (fast: string, balanced: string, frontier: string) => ({
  tiers: { fast, balanced, frontier },
});

function catalog() {
  return structuredClone({
    version: 2,
    harnesses: {
      claude: cli('claude'),
      codex: cli('codex'),
      'antigravity-acp': cli('antigravity-acp'),
    },
    models: {
      'harness-configured-default': {
        label: 'Harness configured default',
        bindings: { claude: {}, 'antigravity-acp': {} },
      },
      haiku: {
        label: 'Haiku',
        reasoning: { options: ['low', 'high'], default: 'low' },
        bindings: { claude: { model: 'haiku' } },
      },
      sonnet: {
        label: 'Sonnet',
        reasoning: { options: ['low', 'medium', 'high'], default: 'medium' },
        bindings: { claude: { model: 'sonnet' } },
      },
      opus: {
        label: 'Opus',
        reasoning: { options: ['low', 'high'], default: 'high' },
        bindings: { claude: { model: 'opus' } },
      },
      'gpt-mini': { label: 'GPT mini', bindings: { codex: {} } },
      gpt: { label: 'GPT', bindings: { codex: {} } },
      'gpt-pro': { label: 'GPT pro', bindings: { codex: {} } },
      auto: {
        label: 'Auto',
        auto: true,
        bindings: {
          claude: tiers('haiku', 'sonnet', 'opus'),
          codex: tiers('gpt-mini', 'gpt', 'gpt-pro'),
        },
      },
    },
    defaults: { harnessId: 'claude', modelId: 'sonnet' },
  });
}

const jev = { routingEngine: 'jev' } as const;
const off = { routingEngine: 'off' } as const;
const offered = (raw: unknown, options: typeof jev | typeof off) =>
  normalizeBoardAgentsConfig(raw, options)
    .catalog.models.find((model) => model.id === 'auto')
    ?.bindings.map((binding) => binding.harnessId);

describe('auto model tier maps', () => {
  test('offers Auto only for harnesses with a tier map, only when the engine is jev', () => {
    expect(offered(catalog(), jev)).toEqual(['claude', 'codex']);
    expect(offered(catalog(), off)).toBeUndefined();
    const { catalog: built } = normalizeBoardAgentsConfig(catalog(), jev);
    expect(built.models.at(-1)?.label).toBe('Auto');
    // Auto only advertises reasoning every tier model accepts.
    expect(
      built.models.find((m) => m.id === 'auto')?.bindings[0]?.reasoning,
    ).toEqual({ options: ['low', 'high'], default: undefined });
  });

  test('resolves a tier to the mapped model; no routing decision means balanced', () => {
    const { autoTiers } = normalizeBoardAgentsConfig(catalog(), jev);
    const auto = { harnessId: 'claude', modelId: 'auto', reasoning: 'high' };
    expect(resolveAutoSelection(auto, 'fast', autoTiers)).toEqual({
      harnessId: 'claude',
      modelId: 'haiku',
      reasoning: 'high',
    });
    expect(resolveAutoSelection(auto, 'frontier', autoTiers).modelId).toBe(
      'opus',
    );
    expect(resolveAutoSelection(auto, null, autoTiers).modelId).toBe('sonnet');
    // 'medium' is supported by balanced only, so Auto rejects it for every tier.
    expect(() =>
      resolveAutoSelection({ ...auto, reasoning: 'medium' }, null, autoTiers),
    ).toThrow('Reasoning "medium" is not supported');
    expect(() =>
      resolveAutoSelection(
        { harnessId: 'antigravity-acp', modelId: 'auto' },
        null,
        autoTiers,
      ),
    ).toThrow('Incompatible runtime selection');
    expect(isAutoSelection(auto)).toBe(true);
    expect(isAutoSelection({ modelId: 'sonnet' })).toBe(false);
  });

  test('drops a tier map that references a model without a binding for the harness', () => {
    const raw: any = catalog();
    raw.models.auto.bindings.claude = tiers('haiku', 'sonnet', 'gpt');
    raw.models.auto.bindings.codex = { tiers: { fast: 'gpt-mini' } };
    const snapshot = normalizeBoardAgentsConfig(raw, jev);
    expect(snapshot.autoTiers.size).toBe(0);
    expect(snapshot.catalog.models.some((m) => m.id === 'auto')).toBe(false);
    expect(snapshot.catalog.models.some((m) => m.id === 'sonnet')).toBe(true);

    // An unsupported field drops only that harness's Auto binding.
    const extra: any = catalog();
    extra.models.auto.bindings.claude.reasoning = { options: ['low'] };
    expect([
      ...normalizeBoardAgentsConfig(extra, jev).autoTiers.keys(),
    ]).toEqual(['codex']);
  });

  test('with the engine off, a stored Auto selection runs as balanced', () => {
    const {
      agents,
      catalog: built,
      autoTiers,
    } = normalizeBoardAgentsConfig(catalog(), off);
    expect(built.models.some((m) => m.id === 'auto')).toBe(false);
    const resolved = resolveRuntimeFromAgents(
      agents,
      { harnessId: 'claude', modelId: 'auto' },
      autoTiers,
    );
    expect(resolved.modelId).toBe('sonnet');
    expect(resolved.model).toBe('sonnet');
    // A preset may select Auto without breaking catalog loading.
    const raw: any = catalog();
    raw.presets = {
      smart: { label: 'Smart', harnessId: 'codex', modelId: 'auto' },
    };
    expect(() => normalizeBoardAgentsConfig(raw, off)).not.toThrow();
    expect(() => normalizeBoardAgentsConfig(raw, jev)).not.toThrow();
  });

  test('harness-configured-default and Auto coexist on the same harness', () => {
    const {
      agents,
      catalog: built,
      autoTiers,
    } = normalizeBoardAgentsConfig(catalog(), jev);
    const claudeModels = built.models
      .filter((m) => m.bindings.some((b) => b.harnessId === 'claude'))
      .map((m) => m.id);
    expect(claudeModels).toContain('harness-configured-default');
    expect(claudeModels).toContain('auto');
    const configured = resolveRuntimeFromAgents(
      agents,
      { harnessId: 'claude', modelId: 'harness-configured-default' },
      autoTiers,
    );
    expect(configured.modelId).toBe('harness-configured-default');
    expect(configured.model).toBeUndefined();
    expect(
      resolveRuntimeFromAgents(
        agents,
        { harnessId: 'claude', modelId: 'auto' },
        autoTiers,
      ).modelId,
    ).toBe('sonnet');
    // A harness without a tier map keeps only its configured default.
    expect(
      built.models
        .filter((m) =>
          m.bindings.some((b) => b.harnessId === 'antigravity-acp'),
        )
        .map((m) => m.id),
    ).toEqual(['harness-configured-default']);
  });
});

describe('auto tier candidate lists', () => {
  /** The catalog with a Claude Auto binding that uses candidate lists. */
  const withCandidates = (claudeTiers: Record<string, unknown>) => {
    const raw: any = catalog();
    raw.connections = { off: { disabled: true } };
    raw.models['gpt-off'] = {
      label: 'GPT off',
      bindings: { codex: { connection: 'off' } },
    };
    raw.models.auto.bindings.claude = { tiers: claudeTiers };
    return raw;
  };
  const auto = { harnessId: 'claude', modelId: 'auto' };

  test('a tier resolves to its first enabled candidate, possibly on another harness', () => {
    const { agents, autoTiers } = normalizeBoardAgentsConfig(
      withCandidates({
        fast: ['codex:gpt-mini'],
        balanced: [
          'codex:gpt-off',
          'claude:unknown',
          'codex:gpt',
          'claude:sonnet',
        ],
        frontier: ['codex:nope', 'codex:gpt-pro', 'claude:opus'],
      }),
      jev,
    );
    expect(resolveAutoSelection(auto, 'fast', autoTiers)).toEqual({
      harnessId: 'codex',
      modelId: 'gpt-mini',
    });
    // The disabled and unknown candidates are skipped in favour of codex:gpt.
    expect(resolveAutoSelection(auto, null, autoTiers)).toEqual({
      harnessId: 'codex',
      modelId: 'gpt',
    });
    expect(resolveAutoSelection(auto, 'frontier', autoTiers)).toEqual({
      harnessId: 'codex',
      modelId: 'gpt-pro',
    });
    // The run starts on the candidate's harness.
    expect(resolveRuntimeFromAgents(agents, auto, autoTiers).agentCmd).toBe(
      'codex',
    );
  });

  test('a tier with no valid candidate drops the Auto binding', () => {
    const snapshot = normalizeBoardAgentsConfig(
      withCandidates({
        fast: ['codex:gpt-mini'],
        balanced: ['claude:sonnet'],
        frontier: ['codex:gpt-off', 'nope:x', 'codex'],
      }),
      jev,
    );
    expect(snapshot.autoTiers.has('claude')).toBe(false);
    expect(snapshot.autoTiers.has('codex')).toBe(true);
  });

  test('a cross-harness tier keeps only the reasoning its candidate supports', () => {
    const { autoTiers, catalog: built } = normalizeBoardAgentsConfig(
      withCandidates({
        fast: ['claude:haiku'],
        balanced: ['claude:sonnet'],
        frontier: ['codex:gpt-pro'],
      }),
      jev,
    );
    // Offered choices are every candidate's, not the intersection.
    expect(
      built.models
        .find((m) => m.id === 'auto')
        ?.bindings.find((b) => b.harnessId === 'claude')?.reasoning.options,
    ).toEqual(['low', 'high', 'medium']);
    // gpt-pro has no reasoning choices, so the candidate's default applies.
    expect(
      resolveAutoSelection(
        { ...auto, reasoning: 'high' },
        'frontier',
        autoTiers,
      ),
    ).toEqual({ harnessId: 'codex', modelId: 'gpt-pro' });
    expect(
      resolveAutoSelection({ ...auto, reasoning: 'medium' }, 'fast', autoTiers),
    ).toEqual({ harnessId: 'claude', modelId: 'haiku' });
    expect(
      resolveAutoSelection(
        { ...auto, reasoning: 'medium' },
        'balanced',
        autoTiers,
      ),
    ).toEqual({ harnessId: 'claude', modelId: 'sonnet', reasoning: 'medium' });
  });

  test('a stored routing resolves to the harness and model it recorded', () => {
    const { autoTiers } = normalizeBoardAgentsConfig(
      withCandidates({
        fast: ['codex:gpt-mini'],
        balanced: ['claude:sonnet'],
        frontier: ['claude:opus', 'codex:gpt-pro'],
      }),
      jev,
    );
    // The recorded candidate wins over the tier's first enabled candidate.
    expect(
      resolveAutoPinnedSelection(
        auto,
        { harnessId: 'codex', modelId: 'gpt-pro', tier: 'frontier' },
        autoTiers,
      ),
    ).toEqual({ harnessId: 'codex', modelId: 'gpt-pro' });
    // A pair no tier lists is kept as recorded.
    expect(
      resolveAutoPinnedSelection(
        auto,
        { harnessId: 'codex', modelId: 'retired' },
        autoTiers,
      ),
    ).toEqual({ harnessId: 'codex', modelId: 'retired' });
    // The same-harness reasoning check still applies to a stored routing.
    expect(() =>
      resolveAutoPinnedSelection(
        { harnessId: 'codex', modelId: 'auto', reasoning: 'high' },
        { harnessId: 'codex', modelId: 'gpt' },
        autoTiers,
      ),
    ).toThrow('Reasoning "high" is not supported');
  });

  test('a chat pin keeps its harness when the candidate order changes', () => {
    const order = (first: string, second: string) => {
      const { autoTiers } = normalizeBoardAgentsConfig(
        withCandidates({
          fast: ['codex:gpt-mini'],
          balanced: ['claude:sonnet'],
          frontier: [first, second],
        }),
        jev,
      );
      return autoTiers;
    };
    const pinned = { harnessId: 'codex', modelId: 'gpt-pro', tier: 'frontier' };
    // Hot reload reverses the list; both candidates stay enabled.
    expect(
      resolveAutoPinnedSelection(
        auto,
        pinned,
        order('codex:gpt-pro', 'antigravity-acp:harness-configured-default'),
      ),
    ).toEqual({ harnessId: 'codex', modelId: 'gpt-pro' });
    expect(
      resolveAutoPinnedSelection(
        auto,
        pinned,
        order('antigravity-acp:harness-configured-default', 'codex:gpt-pro'),
      ),
    ).toEqual({ harnessId: 'codex', modelId: 'gpt-pro' });
  });
});
