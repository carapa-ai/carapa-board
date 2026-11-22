import { describe, expect, test } from 'bun:test';
import type { StageType } from '../modules/kanban/types.js';
import {
  isDirectRuntime,
  normalizeBoardAgentsConfig,
  normalizeBoardAgentsText,
  resolveAgentReferenceFromCatalog,
  resolveRuntimeFromAgents,
  mergeKanbanRuntimeSelections,
  runtimeSessionKey,
  validateRuntimeSelection,
} from './chat-agents.js';

const v2 = {
  version: 2,
  connections: {
    local: {
      baseUrl: 'http://local/v1',
      agent: 'connection-agent',
      env: { SHARED: 'connection', TOKEN: 'ollama' },
    },
  },
  harnesses: {
    direct: {
      label: 'Direct',
      kind: 'direct',
      env: { SHARED: 'harness', HARNESS: 'yes' },
    },
    claude: {
      label: 'Claude Code',
      kind: 'cli',
      agentCmd: 'claude',
      sessionFamily: 'claude-family',
      icon: '/harness-icons/anthropic.svg',
    },
  },
  models: {
    qwen: {
      label: 'Qwen',
      contextSize: 81920,
      capabilities: ['image'],
      agent: 'model-agent',
      env: { MODEL_ENV: 'yes' },
      reasoning: {
        options: ['off', 'none', 'medium', 'high'],
        default: 'medium',
        map: { off: null, none: null, high: 'xhigh' },
      },
      bindings: {
        direct: {
          connection: 'local',
          model: 'qwen-api',
          agent: 'binding-agent',
          env: { SHARED: 'binding' },
          extraBody: {
            chat_template_kwargs: {
              enable_thinking: true,
              preserve_thinking: true,
            },
          },
        },
        claude: {
          connection: 'local',
          model: 'qwen-cli',
          bare: true,
          reasoning: {
            options: ['off', 'none', 'medium', 'high'],
            default: 'high',
            map: { off: null, none: null, high: 'xhigh' },
            envVar: 'CLI_REASONING',
          },
        },
      },
    },
  },
  defaults: {
    harnessId: 'direct',
    modelId: 'qwen',
    reasoning: 'medium',
    env: { GLOBAL: 'yes', SHARED: 'global' },
  },
  presets: {
    fast: {
      label: 'Fast',
      harnessId: 'direct',
      modelId: 'qwen',
      reasoning: 'off',
      temperature: 0.35,
    },
  },
} as const;

describe('board agents v2 normalization', () => {
  test('resolves a one-hop fallback on the same harness with its own settings', () => {
    const configured: any = structuredClone(v2);
    configured.models.qwen.fallbackModel = 'backup';
    configured.models.backup = {
      label: 'Backup',
      reasoning: {
        options: ['off', 'medium', 'high'],
        default: 'medium',
        map: { high: 'low' },
      },
      bindings: {
        direct: {
          connection: 'local',
          model: 'backup-api',
          contextSize: 64000,
        },
        claude: { connection: 'local', model: 'backup-cli' },
      },
    };
    const { agents, catalog } = normalizeBoardAgentsConfig(configured);
    const primary = resolveRuntimeFromAgents(agents, {
      harnessId: 'direct',
      modelId: 'qwen',
      reasoning: 'high',
    });
    expect(
      catalog.models.find((model) => model.id === 'qwen')?.fallbackModel,
    ).toBe('backup');
    expect(primary.fallback?.id).toBe('llm:direct:backup');
    expect(primary.fallback?.model).toBe('backup-api');
    expect(primary.fallback?.context_size).toBe(64000);
    expect(primary.fallback?.reasoning_effort).toBe('low');
    expect(primary.fallback?.fallback).toBeUndefined();
  });

  test('a reasoning choice can select the harness model the harness runs', () => {
    const configured: any = structuredClone(v2);
    configured.models.qwen.bindings.claude.reasoning = {
      options: ['low', 'high'],
      default: 'high',
      models: { low: 'qwen-cli-low', high: 'qwen-cli-high' },
    };
    const { agents } = normalizeBoardAgentsConfig(configured);
    const run = (reasoning?: string) =>
      resolveRuntimeFromAgents(agents, {
        harnessId: 'claude',
        modelId: 'qwen',
        reasoning,
      }).model;
    expect(run('low')).toBe('qwen-cli-low');
    expect(run()).toBe('qwen-cli-high');

    configured.models.qwen.bindings.claude.reasoning.models.medium = 'x';
    expect(() => normalizeBoardAgentsConfig(configured)).toThrow(
      'invalid reasoning model for "medium"',
    );
  });

  test('rejects invalid fallback model references and bindings', () => {
    const missing: any = structuredClone(v2);
    missing.models.qwen.fallbackModel = 'missing';
    expect(() => normalizeBoardAgentsConfig(missing)).toThrow(
      'unknown fallback model "missing"',
    );

    const self: any = structuredClone(v2);
    self.models.qwen.fallbackModel = 'qwen';
    expect(() => normalizeBoardAgentsConfig(self)).toThrow(
      'cannot fall back to itself',
    );

    const incompatible: any = structuredClone(v2);
    incompatible.models.qwen.fallbackModel = 'backup';
    incompatible.models.backup = {
      label: 'Backup',
      bindings: { direct: { connection: 'local', model: 'backup' } },
    };
    expect(() => normalizeBoardAgentsConfig(incompatible)).toThrow(
      'has no "claude" binding',
    );
  });

  test('isolates Codex native sessions by provider profile', () => {
    expect(
      runtimeSessionKey({
        id: 'codex:relay',
        agentCmd: 'codex',
        sessionFamily: 'codex',
      }),
    ).toBe('codex@relay');
    expect(
      runtimeSessionKey({
        id: 'codex:local',
        agentCmd: 'codex',
        sessionFamily: 'codex',
        env: { CODEX_PROFILE: 'ollama' },
      }),
    ).toBe('codex@ollama');
  });
  test('isolates Pi sessions by provider', () => {
    expect(
      runtimeSessionKey({
        id: 'pi:local',
        agentCmd: 'pi',
        sessionFamily: 'pi',
        model: 'llama-proxy/qwen3.8',
      } as any),
    ).toBe('pi@llama-proxy');
    expect(
      runtimeSessionKey({
        id: 'pi:freellm',
        agentCmd: 'pi',
        sessionFamily: 'pi',
        model: 'freellmapi/auto',
      } as any),
    ).toBe('pi@freellmapi');
  });
  test('isolates Claude sessions by Anthropic endpoint', () => {
    expect(
      runtimeSessionKey({
        id: 'claude:local',
        agentCmd: 'claude',
        sessionFamily: 'claude',
        env: { ANTHROPIC_BASE_URL: 'http://llama-proxy:8881' },
      }),
    ).toBe('claude@http://llama-proxy:8881');
    expect(
      runtimeSessionKey({
        id: 'claude:freellm',
        agentCmd: 'claude',
        sessionFamily: 'claude',
        env: { ANTHROPIC_BASE_URL: 'http://llama-proxy:3001' },
      }),
    ).toBe('claude@http://llama-proxy:3001');
  });
  test('isolates Hermes sessions by OpenAI endpoint', () => {
    expect(
      runtimeSessionKey({
        id: 'hermes:qwen',
        agentCmd: 'hermes-acp',
        sessionFamily: 'hermes-acp',
        env: { OPENAI_BASE_URL: 'http://llama-proxy:8881/v1' },
      }),
    ).toBe('hermes-acp@http://llama-proxy:8881/v1');
    expect(
      runtimeSessionKey({
        id: 'hermes:freellm',
        agentCmd: 'hermes-acp',
        sessionFamily: 'hermes-acp',
        env: { OPENAI_BASE_URL: 'http://llama-proxy:3001/v1' },
      }),
    ).toBe('hermes-acp@http://llama-proxy:3001/v1');
  });
  test('merges Kanban binding precedence while inheriting reasoning', () => {
    expect(
      mergeKanbanRuntimeSelections([
        { harnessId: 'direct', modelId: 'qwen' },
        { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
        { harnessId: 'direct', modelId: 'qwen', reasoning: 'low' },
      ]),
    ).toEqual({ harnessId: 'direct', modelId: 'qwen', reasoning: 'high' });
    expect(
      mergeKanbanRuntimeSelections([
        undefined,
        { harnessId: 'claude', modelId: 'qwen' },
        { harnessId: 'direct', modelId: 'qwen', reasoning: 'medium' },
      ]),
    ).toEqual({ harnessId: 'claude', modelId: 'qwen', reasoning: 'medium' });
    expect(
      mergeKanbanRuntimeSelections([
        { harnessId: 'direct', modelId: 'qwen', reasoning: null } as any,
        { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
      ]),
    ).toEqual({ harnessId: 'direct', modelId: 'qwen', reasoning: 'high' });
    expect(
      mergeKanbanRuntimeSelections([
        { harnessId: 'direct', modelId: 'qwen', reasoning: '' },
        { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
      ]),
    ).toEqual({ harnessId: 'direct', modelId: 'qwen', reasoning: 'high' });
    expect(
      mergeKanbanRuntimeSelections([
        { harnessId: 'direct', modelId: 'qwen', reasoning: '   ' },
        { harnessId: 'claude', modelId: 'qwen', reasoning: 'medium' },
      ]),
    ).toEqual({ harnessId: 'direct', modelId: 'qwen', reasoning: 'medium' });
  });
  test('rejects blank reasoning in persisted runtime selections', () => {
    expect(
      validateRuntimeSelection({
        harnessId: 'direct',
        modelId: 'qwen',
        reasoning: '',
      }),
    ).toBe('runtimeSelection.reasoning must be a non-empty string or null');
    expect(
      validateRuntimeSelection({
        harnessId: 'direct',
        modelId: 'qwen',
        reasoning: '   ',
      }),
    ).toBe('runtimeSelection.reasoning must be a non-empty string or null');
  });
  test('builds compatibility bindings and deterministic effective settings', () => {
    const { agents, catalog } = normalizeBoardAgentsConfig(v2);
    expect(catalog.models[0].bindings.map((b) => b.harnessId)).toEqual([
      'direct',
      'claude',
    ]);
    expect(
      catalog.harnesses.find((harness) => harness.id === 'claude')?.icon,
    ).toBe('/harness-icons/anthropic.svg');
    const direct = agents.find((a) => a.harnessId === 'direct')!;
    expect(direct.id).toBe('llm:direct:qwen');
    expect(direct.baseUrl).toBe('http://local/v1');
    expect(direct.context_size).toBe(81920);
    expect(direct.image).toBe(true);
    expect(direct.agent).toBe('binding-agent');
    expect(isDirectRuntime(direct)).toBe(true);
    expect(direct.env).toEqual({
      GLOBAL: 'yes',
      SHARED: 'binding',
      HARNESS: 'yes',
      TOKEN: 'ollama',
      MODEL_ENV: 'yes',
    });
    const cli = agents.find((a) => a.harnessId === 'claude')!;
    expect(cli.sessionFamily).toBe('claude-family');
    expect(cli.agent).toBe('model-agent');
    // CLI bindings may inherit an HTTP endpoint from their connection, but are
    // never eligible for DirectLLM consumers (commit messages, knowledge, TTS).
    expect(cli.baseUrl).toBe('http://local/v1');
    expect(isDirectRuntime(cli)).toBe(false);
    expect(
      resolveRuntimeFromAgents(agents, {
        harnessId: 'direct',
        modelId: 'qwen',
        reasoning: 'off',
      }).reasoning_effort,
    ).toBeUndefined();
    expect(
      resolveRuntimeFromAgents(agents, {
        harnessId: 'direct',
        modelId: 'qwen',
        reasoning: 'none',
      }).extra_body,
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
    expect(catalog.presets[0]?.selection.temperature).toBe(0.35);
    expect(
      resolveRuntimeFromAgents(agents, catalog.presets[0]!.selection)
        .temperature,
    ).toBe(0.35);
    expect(
      resolveRuntimeFromAgents(agents, {
        harnessId: 'claude',
        modelId: 'qwen',
        reasoning: 'high',
      }).env?.CLI_REASONING,
    ).toBe('xhigh');
    expect(
      resolveRuntimeFromAgents(agents, {
        harnessId: 'claude',
        modelId: 'qwen',
        reasoning: 'off',
      }).reasoning_effort,
    ).toBeUndefined();
    expect(
      resolveRuntimeFromAgents(agents, {
        harnessId: 'claude',
        modelId: 'qwen',
        reasoning: 'off',
      }).env?.CLI_REASONING,
    ).toBeUndefined();
    expect(
      resolveRuntimeFromAgents(agents, { harnessId: 'claude', modelId: 'qwen' })
        .reasoning_effort,
    ).toBe('xhigh');
    expect(
      resolveRuntimeFromAgents(agents, { harnessId: 'claude', modelId: 'qwen' })
        .env?.CLI_REASONING,
    ).toBe('xhigh');
    expect(
      resolveRuntimeFromAgents(agents, {
        harnessId: 'claude',
        modelId: 'qwen',
        reasoning: '',
      }).reasoning_effort,
    ).toBe('xhigh');
  });

  test('rejects invalid preset temperatures', () => {
    const configured: any = structuredClone(v2);
    configured.presets.fast.temperature = 2.5;
    expect(() => normalizeBoardAgentsConfig(configured)).toThrow(
      'temperature must be a finite number between 0 and 2',
    );
  });

  test('uses v2 defaults and compatibility aliases for non-picker consumers', () => {
    const { agents, catalog } = normalizeBoardAgentsConfig(v2);
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, undefined, {
        fallbackToDefault: true,
      })?.id,
    ).toBe('llm:direct:qwen');
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, 'llm:qwen')?.id,
    ).toBe('llm:direct:qwen');
    const cliCompatibility = resolveAgentReferenceFromCatalog(
      agents,
      catalog,
      'claude',
    );
    expect(cliCompatibility?.agentCmd).toBe('claude');
    expect(cliCompatibility?.model).toBe('qwen-cli');
    expect(cliCompatibility?.agent).toBe('model-agent');
    expect(cliCompatibility?.bare).toBe(true);
    expect(cliCompatibility?.env).toMatchObject({
      TOKEN: 'ollama',
      CLI_REASONING: 'xhigh',
    });
  });

  test('resolves scoped chat, kanban, and stage defaults independently', () => {
    const scoped = {
      ...v2,
      defaults: {
        chat: { harnessId: 'direct', modelId: 'qwen', reasoning: 'medium' },
        observer: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
        reflector: { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
        transcription: {
          harnessId: 'direct',
          modelId: 'qwen',
          reasoning: 'off',
        },
        peekFiles: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
        curator: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
        commitMessage: {
          harnessId: 'direct',
          modelId: 'qwen',
          reasoning: 'high',
        },
        auditMemories: {
          harnessId: 'direct',
          modelId: 'qwen',
          reasoning: 'off',
        },
        kanban: {
          fallback: { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
          stages: {
            in_progress: {
              harnessId: 'direct',
              modelId: 'qwen',
              reasoning: 'off',
            },
          },
        },
        settings: { env: { GLOBAL: 'yes' } },
      },
    } as const;
    const { agents, catalog } = normalizeBoardAgentsConfig(scoped);

    expect(catalog.defaults).toEqual({
      chat: { harnessId: 'direct', modelId: 'qwen', reasoning: 'medium' },
      observer: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
      reflector: { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
      transcription: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
      peekFiles: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
      commitMessage: {
        harnessId: 'direct',
        modelId: 'qwen',
        reasoning: 'high',
      },
      auditMemories: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
      curator: { harnessId: 'direct', modelId: 'qwen', reasoning: 'off' },
      kanban: {
        fallback: { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
        stages: {
          in_progress: {
            harnessId: 'direct',
            modelId: 'qwen',
            reasoning: 'off',
          },
        },
      },
    });
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, 'llm:direct:qwen')?.id,
    ).toBe('llm:direct:qwen');
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, 'default')?.id,
    ).toBe('claude:qwen');
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, 'default', {
        defaultScope: 'kanban',
        stageId: 'in_progress',
      })?.id,
    ).toBe('llm:direct:qwen');
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, undefined, {
        fallbackToDefault: true,
        defaultScope: 'kanban',
        stageId: 'in_progress',
      })?.reasoning_effort,
    ).toBeUndefined();
    expect(
      resolveAgentReferenceFromCatalog(agents, catalog, undefined, {
        fallbackToDefault: true,
        defaultScope: 'kanban',
        stageId: 'review',
      })?.reasoning_effort,
    ).toBe('xhigh');
    expect(
      resolveRuntimeFromAgents(agents, catalog.defaults.commitMessage!)
        .reasoning_effort,
    ).toBe('xhigh');
    expect(
      resolveRuntimeFromAgents(agents, catalog.defaults.peekFiles!).id,
    ).toBe('llm:direct:qwen');
    expect(
      resolveRuntimeFromAgents(agents, catalog.defaults.auditMemories!)
        .reasoning_effort,
    ).toBeUndefined();
  });

  test('resolves Kanban stage defaults by stage id, then stage type, then fallback', () => {
    const sel = (harnessId: string) => ({ harnessId, modelId: 'qwen' });
    const configured = {
      ...v2,
      defaults: {
        chat: sel('direct'),
        observer: sel('direct'),
        reflector: sel('claude'),
        kanban: {
          fallback: sel('claude'),
          stages: {
            active: sel('direct'),
            review: sel('direct'),
            in_progress: sel('claude'),
          },
        },
      },
    };
    const { agents, catalog } = normalizeBoardAgentsConfig(configured);
    const resolve = (stageId: string, stageType?: StageType) =>
      resolveAgentReferenceFromCatalog(agents, catalog, 'default', {
        defaultScope: 'kanban',
        stageId,
        stageType,
      })?.id;
    expect(resolve('coding', 'active')).toBe('llm:direct:qwen');
    expect(resolve('review', 'review')).toBe('llm:direct:qwen');
    expect(resolve('in_progress', 'active')).toBe('claude:qwen');
    expect(resolve('testing', 'testing')).toBe('claude:qwen');
    expect(resolve('testing')).toBe('claude:qwen');
  });

  test('omits bindings, models, and harnesses backed only by disabled connections', () => {
    const configured = {
      ...v2,
      connections: {
        ...v2.connections,
        offline: { baseUrl: 'http://offline.test/v1', disabled: true },
      },
      models: {
        qwen: {
          ...v2.models.qwen,
          bindings: {
            direct: {
              ...v2.models.qwen.bindings.direct,
              connection: 'offline',
            },
            claude: v2.models.qwen.bindings.claude,
          },
        },
        offlineOnly: {
          label: 'Offline only',
          bindings: {
            direct: { connection: 'offline', model: 'offline-only' },
          },
        },
      },
      defaults: { harnessId: 'claude', modelId: 'qwen', reasoning: 'high' },
      presets: {},
    } as const;

    const { agents, catalog } = normalizeBoardAgentsConfig(configured);
    expect(agents.map((agent) => agent.id)).toEqual(['claude:qwen']);
    expect(catalog.harnesses.map((harness) => harness.id)).toEqual(['claude']);
    expect(catalog.models.map((model) => model.id)).toEqual(['qwen']);
    expect(
      catalog.models[0].bindings.map((binding) => binding.harnessId),
    ).toEqual(['claude']);
  });

  test('rejects defaults that resolve through a disabled connection', () => {
    expect(() =>
      normalizeBoardAgentsConfig({
        ...v2,
        connections: { local: { ...v2.connections.local, disabled: true } },
        presets: {},
      }),
    ).toThrow('defaults.chat selects incompatible runtime direct/qwen');
  });

  test('requires the commit-message default to use an HTTP-capable direct runtime', () => {
    expect(() =>
      normalizeBoardAgentsConfig({
        ...v2,
        defaults: {
          chat: { harnessId: 'direct', modelId: 'qwen' },
          commitMessage: { harnessId: 'claude', modelId: 'qwen' },
          kanban: { fallback: { harnessId: 'claude', modelId: 'qwen' } },
        },
      }),
    ).toThrow(
      'defaults.commitMessage must select an HTTP-capable direct runtime',
    );
  });

  test('does not turn a logical CLI model id into an implicit --model override', () => {
    const { agents } = normalizeBoardAgentsConfig({
      version: 2,
      harnesses: {
        claude: { label: 'Claude Code', kind: 'cli', agentCmd: 'claude' },
        direct: { label: 'Direct', kind: 'direct' },
      },
      models: {
        default: {
          label: 'Default',
          bindings: { claude: {}, direct: {} },
        },
      },
      defaults: { harnessId: 'claude', modelId: 'default' },
    });

    expect(
      agents.find((agent) => agent.harnessId === 'claude')?.model,
    ).toBeUndefined();
    expect(agents.find((agent) => agent.harnessId === 'direct')?.model).toBe(
      'default',
    );
  });

  test('rejects invalid references and incompatible defaults', () => {
    expect(() =>
      normalizeBoardAgentsConfig({
        ...v2,
        defaults: { harnessId: 'missing', modelId: 'qwen' },
      }),
    ).toThrow('incompatible runtime');
    expect(() =>
      normalizeBoardAgentsConfig({
        ...v2,
        models: { qwen: { ...v2.models.qwen, bindings: { missing: {} } } },
      }),
    ).toThrow('unknown harness');
    expect(() =>
      normalizeBoardAgentsConfig({
        ...v2,
        models: { qwen: { ...v2.models.qwen, context_size: 10 } },
      }),
    ).toThrow('use camelCase');
  });

  test('retains the last known-good snapshot after a malformed hot reload', () => {
    const valid = normalizeBoardAgentsConfig(v2);
    const result = normalizeBoardAgentsText('{ "version": 2, broken', valid);
    expect(result.snapshot).toBe(valid);
    expect(result.error?.message).toBeTruthy();
  });
});
