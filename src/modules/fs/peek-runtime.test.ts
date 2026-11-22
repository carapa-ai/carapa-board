import { describe, expect, test } from 'bun:test';
import {
  selectPeekFilesRuntime,
  type PeekRuntimeCandidate,
} from './peek-runtime.js';

const direct: PeekRuntimeCandidate = {
  id: 'llm:direct:qwen',
  harnessKind: 'direct',
  baseUrl: 'http://relay.test/v1',
};
const cli: PeekRuntimeCandidate = {
  id: 'codex:qwen',
  harnessKind: 'cli',
  baseUrl: 'http://relay.test/v1',
};

describe('selectPeekFilesRuntime', () => {
  test('falls back from a synthetic persona ID to an HTTP direct binding', () => {
    expect(
      selectPeekFilesRuntime({
        agents: [cli, direct],
        currentAgentId: 'ai:morgan',
        defaultChat: cli,
      }),
    ).toBe(direct);
  });

  test('does not treat an ordinary CLI binding as HTTP-direct', () => {
    expect(
      selectPeekFilesRuntime({
        agents: [cli, direct],
        currentAgentId: cli.id,
        defaultChat: direct,
      }),
    ).toBeUndefined();
  });

  test('prefers an explicitly configured HTTP-direct binding', () => {
    expect(
      selectPeekFilesRuntime({
        agents: [direct],
        configured: direct,
        currentAgentId: 'ai:morgan',
      }),
    ).toBe(direct);
  });
});
