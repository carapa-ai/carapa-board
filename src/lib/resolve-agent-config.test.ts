import { describe, expect, test } from 'bun:test';
import type { RegisteredGroup } from '../types.js';
import {
  getResolvedAgentConfig as getResolvedAgentConfigWithDefaults,
  getResolvedRuntimeConfig as getResolvedRuntimeConfigWithDefaults,
  resolveSessionAgentKey as resolveSessionAgentKeyWithDefaults,
  type ResolveAgentConfigDependencies,
} from './resolve-agent-config.js';

const mockAgents = [
  {
    id: 'direct:gemma4-12b',
    label: 'Gemma4 structured',
    baseUrl: 'http://x/v1',
    audio: true,
    harnessKind: 'direct',
  },
  {
    id: 'llm:gemma4-12b',
    label: 'Gemma4',
    baseUrl: 'http://x/v1',
    audio: true,
    harnessKind: 'direct',
  },
  {
    id: 'llm:direct:qwen',
    label: 'Qwen',
    baseUrl: 'http://x/v1',
    audio: false,
    harnessKind: 'direct',
  },
  {
    id: 'claude:qwen',
    label: 'Claude Qwen',
    agentCmd: 'claude',
    sessionFamily: 'claude-family',
    harnessKind: 'cli',
  },
  {
    id: 'claude:sonnet',
    label: 'Claude Sonnet',
    agentCmd: 'claude',
    sessionFamily: 'claude-family',
    harnessKind: 'cli',
  },
  {
    id: 'codex:relay',
    label: 'Codex Relay',
    agentCmd: 'codex',
    sessionFamily: 'codex',
    harnessKind: 'cli',
  },
  {
    id: 'codex:openrouter',
    label: 'Codex OpenRouter',
    agentCmd: 'codex',
    sessionFamily: 'codex',
    harnessKind: 'cli',
    env: { CODEX_PROFILE: 'openrouter' },
  },
];
const mockRuntimeCatalog = {
  presets: [] as Array<{
    id: string;
    label: string;
    selection: { harnessId: string; modelId: string };
  }>,
  defaults: { chat: { harnessId: 'direct', modelId: 'qwen' } },
};

const dependencies: ResolveAgentConfigDependencies = {
  getChatAgents: () => mockAgents as any,
  getDefaultRuntimeSelection: () => mockRuntimeCatalog.defaults.chat,
  resolveChatAgent: (_group, id) => id || 'claude:qwen',
  runtimeSessionKey: (agent) => {
    const family = agent.sessionFamily || agent.agentCmd || agent.id;
    if (agent.agentCmd !== 'codex') return family;
    return `${family}@${agent.env?.CODEX_PROFILE || 'relay'}`;
  },
  resolveRuntimeSelection: (selection) =>
    ({
      ...(mockAgents.find(
        (agent) => agent.id === `${selection.harnessId}:${selection.modelId}`,
      ) || {
        id: `${selection.harnessId}:${selection.modelId}`,
        label: 'Structured runtime',
      }),
      harnessId: selection.harnessId,
      modelId: selection.modelId,
      reasoning_effort: selection.reasoning,
    }) as any,
};

const getResolvedAgentConfig = (
  group: RegisteredGroup,
  rawAgentCmd?: string | null,
) => getResolvedAgentConfigWithDefaults(group, rawAgentCmd, dependencies);
const getResolvedRuntimeConfig = (
  group: RegisteredGroup,
  selection?: Parameters<typeof getResolvedRuntimeConfigWithDefaults>[1],
  rawAgentCmd?: string | null,
) =>
  getResolvedRuntimeConfigWithDefaults(
    group,
    selection,
    rawAgentCmd,
    dependencies,
  );
const resolveSessionAgentKey = (
  group: RegisteredGroup,
  override?: string | null,
  selection?: Parameters<typeof resolveSessionAgentKeyWithDefaults>[2],
) =>
  resolveSessionAgentKeyWithDefaults(group, override, selection, dependencies);

const group: RegisteredGroup = {
  name: 'main',
  folder: 'main',
  trigger: '@capa',
  added_at: new Date().toISOString(),
  settings: {
    chatRuntimeSelection: { harnessId: 'direct', modelId: 'gemma4-12b' },
  },
};

describe('getResolvedAgentConfig', () => {
  test('resolves an explicit materialized runtime', () => {
    const cfg = getResolvedAgentConfig(group, 'llm:gemma4-12b');
    expect(cfg?.id).toBe('llm:gemma4-12b');
  });

  test('uses the project structured selection when no override is supplied', () => {
    const cfg = getResolvedAgentConfig(group);
    expect(cfg?.id).toBe('direct:gemma4-12b');
    expect(cfg?.audio).toBe(true);
  });

  test('does not replace an explicit unknown runtime with the chat default', () => {
    expect(getResolvedAgentConfig(group, 'retired-runtime')).toBeUndefined();
  });

  test('rejects legacy aliases instead of resolving them to the chat default', () => {
    expect(getResolvedAgentConfig(group, 'default')).toBeUndefined();
    expect(getResolvedAgentConfig(group, 'claude')).toBeUndefined();
  });

  test('structured runtime resolution remains independent when supplied', () => {
    const cfg = getResolvedRuntimeConfig(group, {
      harnessId: 'claude',
      modelId: 'qwen',
      reasoning: 'high',
    });
    expect(cfg?.id).toBe('claude:qwen');
    expect(cfg?.reasoning_effort).toBe('high');
  });

  test('structured selections also control the native session identity', () => {
    expect(
      resolveSessionAgentKey(group, undefined, {
        harnessId: 'claude',
        modelId: 'qwen',
      }),
    ).toBe('claude-family');
  });
});
