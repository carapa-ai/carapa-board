import { describe, expect, test } from 'bun:test';
import {
  getRuntimeLocality,
  isLocalEndpoint,
  normalizeBoardAgentsConfig,
  type ChatAgentOption,
} from './chat-agents.js';

const PREFIXES = ['http://llama-proxy:11434', 'http://api-relay:8080/laya/'];

function config(overrides: Record<string, any> = {}): any {
  return {
    version: 2,
    connections: {
      relay: { baseUrl: 'http://api-relay:8080/laya', locality: 'local' },
    },
    harnesses: {
      direct: { label: 'Direct', kind: 'direct' },
      claude: { label: 'Claude Code', kind: 'cli', agentCmd: 'claude' },
    },
    models: {
      jev: {
        label: 'Jev',
        bindings: { direct: { connection: 'relay' }, claude: {} },
      },
    },
    defaults: {
      chat: { harnessId: 'direct', modelId: 'jev' },
      kanban: { fallback: { harnessId: 'direct', modelId: 'jev' } },
    },
    ...overrides,
  };
}

function agentFor(raw: unknown, id: string): ChatAgentOption {
  const agent = normalizeBoardAgentsConfig(raw).agents.find((a) => a.id === id);
  if (!agent) throw new Error(`missing agent ${id}`);
  return agent;
}

describe('runtime locality', () => {
  test('binding overrides connection; unset stays undeclared', () => {
    const raw = config();
    expect(agentFor(raw, 'llm:direct:jev').locality).toBe('local');
    raw.models.jev.bindings.direct.locality = 'remote';
    expect(agentFor(raw, 'llm:direct:jev').locality).toBe('remote');
    expect(agentFor(raw, 'claude:jev').locality).toBeUndefined();
  });

  test('rejects values other than local/remote', () => {
    const raw = config();
    raw.harnesses.direct = { ...raw.harnesses.direct, locality: 'lan' } as any;
    expect(() => normalizeBoardAgentsConfig(raw)).toThrow(
      'harnesses.direct.locality must be "local" or "remote"',
    );
  });

  test('endpoint prefixes are path-aware', () => {
    expect(isLocalEndpoint('http://api-relay:8080/laya', PREFIXES)).toBe(true);
    expect(isLocalEndpoint('http://api-relay:8080/laya/v1', PREFIXES)).toBe(
      true,
    );
    expect(isLocalEndpoint('http://api-relay:8080/laya/', PREFIXES)).toBe(true);
    expect(isLocalEndpoint('http://llama-proxy:11434/v1', PREFIXES)).toBe(true);
    expect(isLocalEndpoint('http://api-relay:8080/anthropic', PREFIXES)).toBe(
      false,
    );
    expect(isLocalEndpoint('http://api-relay:8080/layax', PREFIXES)).toBe(
      false,
    );
    expect(isLocalEndpoint('https://api-relay:8080/laya', PREFIXES)).toBe(
      false,
    );
    expect(isLocalEndpoint('http://api-relay:8080/laya', [])).toBe(false);
  });

  test('undeclared runtimes are remote unless their endpoint is local', () => {
    const raw = config();
    delete raw.connections.relay.locality;
    const direct = agentFor(raw, 'llm:direct:jev');
    expect(getRuntimeLocality(direct, PREFIXES)).toBe('local');
    expect(getRuntimeLocality(direct, [])).toBe('remote');
    // CLI harness without a base URL talks to the vendor cloud.
    expect(getRuntimeLocality(agentFor(raw, 'claude:jev'), PREFIXES)).toBe(
      'remote',
    );
  });

  test('a remote fallback makes a local primary remote', () => {
    const raw = config({
      models: {
        jev: {
          label: 'Jev',
          fallbackModel: 'cloud',
          bindings: { direct: { connection: 'relay' } },
        },
        cloud: {
          label: 'Cloud',
          bindings: { direct: { baseUrl: 'http://api-relay:8080/anthropic' } },
        },
      },
    });
    const primary = agentFor(raw, 'llm:direct:jev');
    expect(primary.locality).toBe('local');
    expect(getRuntimeLocality(primary, PREFIXES)).toBe('remote');
  });
});
