import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { getActiveRunsByStatus, initDatabase } from '../db.js';
import type { ChatAgentOption } from '../lib/chat-agents.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import { runContainerAgent, type ContainerInput } from './process.js';

const prefix = `process-privacy-${process.pid}`;
const jids: string[] = [];

const remoteRuntime: ChatAgentOption = {
  id: 'remote-runtime',
  label: 'Remote',
  locality: 'remote',
};

async function project(name: string, privacyMode?: 'strict' | 'local_memory') {
  const jid = `${prefix}-${name}@web`;
  jids.push(jid);
  const group: RegisteredGroup = {
    jid,
    name,
    folder: `${prefix}-${name}`,
    trigger: `@${name}`,
    added_at: new Date().toISOString(),
    settings: privacyMode ? { privacyMode } : {},
  };
  await registerGroup(jid, group);
  return group;
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
});

afterAll(async () => {
  for (const jid of jids.splice(0)) await unregisterGroup(jid);
});

describe('runContainerAgent privacy backstop', () => {
  test('a strict project refuses a remote runtime before any run starts', async () => {
    const group = await project('strict', 'strict');
    const runDirectLlm = mock(async () => ({}) as never);
    const base = {
      prompt: 'hello',
      group_folder: group.folder,
      chat_jid: 'privacy@kanban',
      isMain: false,
    };
    const inputs: ContainerInput[] = [
      // kanban-style run: runtime reaches the backstop through privacyRuntime
      { ...base, task_id: `${prefix}-task`, privacyRuntime: remoteRuntime },
      // sandbox-chat-style run: runtimeConfig is the governing runtime
      { ...base, runtimeConfig: remoteRuntime },
      // no known runtime is treated as remote
      { ...base },
    ];
    for (const input of inputs) {
      const result = await runContainerAgent(group, input, undefined, {
        resolveEffectiveSandbox,
        runDirectLlm: runDirectLlm as never,
      });
      expect(result).toMatchObject({ status: 'error', result: null });
      expect(result.error).toContain('Privacy mode "strict"');
      expect(result.activeRunId).toBeUndefined();
    }
    expect(runDirectLlm).not.toHaveBeenCalled();
    // Other suites share the test database; only this project's runs count.
    const running = await getActiveRunsByStatus('running');
    expect(
      running.filter((run) => run.group_folder === group.folder),
    ).toHaveLength(0);
  });

  test('a local_memory project judges memory-audit runs as memory, not chat', async () => {
    const group = await project('local-memory', 'local_memory');
    const base = {
      prompt: 'audit',
      group_folder: group.folder,
      chat_jid: 'memory-audit:privacy',
      isMain: false,
      privacyRuntime: remoteRuntime,
    };

    const refused = await runContainerAgent(
      group,
      { ...base, privacyPurpose: 'memory' },
      undefined,
      { resolveEffectiveSandbox, runDirectLlm: mock() as never },
    );
    expect(refused).toMatchObject({ status: 'error', result: null });
    expect(refused.error).toContain('refuses memory egress');
    expect(refused.activeRunId).toBeUndefined();
  });
});
