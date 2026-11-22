import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { initDatabase } from '../db.js';
import { logger } from '../logger.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import { applyPrivacyRecallScope } from '../modules/memory/backend/scope.js';
import type { ChatAgentOption } from './chat-agents.js';
import type { PrivacyMode } from './privacy-policy.js';
import {
  assertEgressAllowed,
  assertRuntimeAllowed,
  crossProjectModesAllowed,
  crossProjectReadAllowed,
  getEffectivePrivacyInfo,
  getEffectivePrivacyMode,
  getOwnPrivacyMode,
  getProjectPrivacyMode,
  PrivacyRefusal,
  requiresLocal,
} from './privacy-policy.js';

const prefix = `privacy-policy-${process.pid}`;
const jids: string[] = [];

async function register(
  name: string,
  privacyMode?: PrivacyMode,
  extra: { parentId?: string; is_main?: boolean } = {},
) {
  const jid = `${prefix}-${name}@web`;
  jids.push(jid);
  await registerGroup(jid, {
    jid,
    name,
    folder: `${prefix}-${name}`,
    trigger: `@${name}`,
    added_at: new Date().toISOString(),
    settings: privacyMode ? { privacyMode } : {},
    ...extra,
  });
  return `${prefix}-${name}`;
}

async function unregisterAll() {
  for (const jid of jids.splice(0)) await unregisterGroup(jid);
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
});

afterEach(unregisterAll);
afterAll(unregisterAll);

describe('getProjectPrivacyMode', () => {
  test('reads the mode of the named project; unknown projects are off', async () => {
    const strict = await register('strict', 'strict');
    const plain = await register('plain');
    expect(getProjectPrivacyMode(strict)).toBe('strict');
    expect(getProjectPrivacyMode(plain)).toBe('off');
    expect(getProjectPrivacyMode('no-such-project')).toBe('off');
  });

  test('without a project id the strictest registered mode applies', async () => {
    expect(getProjectPrivacyMode()).toBe('off');
    await register('plain');
    expect(getProjectPrivacyMode()).toBe('off');
    await register('lm', 'local_memory');
    expect(getProjectPrivacyMode()).toBe('local_memory');
    await register('strict', 'strict');
    expect(getProjectPrivacyMode()).toBe('strict');
  });
});

describe('effective privacy mode', () => {
  test('a strict child makes its parent chain strict; siblings and its own value are unchanged', async () => {
    const grandparent = await register('gp');
    const parent = await register('parent', undefined, {
      parentId: grandparent,
    });
    const child = await register('child', 'strict', { parentId: parent });
    const sibling = await register('sibling', undefined, { parentId: parent });
    expect(getEffectivePrivacyMode(parent)).toBe('strict');
    expect(getEffectivePrivacyMode(grandparent)).toBe('strict');
    expect(getEffectivePrivacyMode(sibling)).toBe('off');
    expect(getEffectivePrivacyMode(child)).toBe('strict');
    expect(getProjectPrivacyMode(parent)).toBe('strict');
    expect(getOwnPrivacyMode(parent)).toBe('off');
    expect(getOwnPrivacyMode(child)).toBe('strict');
    expect(getEffectivePrivacyInfo(grandparent)).toEqual({
      mode: 'strict',
      inheritedFrom: child,
    });
    expect(getEffectivePrivacyInfo(child)).toEqual({
      mode: 'strict',
      inheritedFrom: null,
    });
  });

  test('the strictest descendant wins', async () => {
    const parent = await register('parent');
    await register('lm', 'local_memory', { parentId: parent });
    expect(getEffectivePrivacyMode(parent)).toBe('local_memory');
    await register('strict', 'strict', { parentId: parent });
    expect(getEffectivePrivacyMode(parent)).toBe('strict');
  });

  test('main inherits the strictest of all groups and stays off when none has a mode', async () => {
    const main = await register('main', undefined, { is_main: true });
    const other = await register('other');
    expect(getEffectivePrivacyMode(main)).toBe('off');
    await register('lm', 'local_memory');
    expect(getEffectivePrivacyMode(main)).toBe('local_memory');
    await register('strict', 'strict');
    expect(getEffectivePrivacyMode(main)).toBe('strict');
    expect(getEffectivePrivacyMode(other)).toBe('off');
  });

  test('a parentId cycle terminates without throwing', async () => {
    const a = await register('a');
    const b = await register('b', 'strict', { parentId: a });
    await unregisterGroup(`${prefix}-a@web`);
    jids.splice(jids.indexOf(`${prefix}-a@web`), 1);
    await register('a', undefined, { parentId: b });
    expect(getEffectivePrivacyMode(a)).toBe('strict');
    expect(getEffectivePrivacyMode(`${prefix}-unrelated`)).toBe('off');
  });

  test('egress is refused for the parent of a strict child', async () => {
    const parent = await register('parent');
    await register('child', 'strict', { parentId: parent });
    expect(() =>
      assertEgressAllowed({
        projectId: parent,
        purpose: 'agent',
        locality: 'remote',
        target: 'http://remote.test/v1',
      }),
    ).toThrow(PrivacyRefusal);
  });
});

describe('requiresLocal', () => {
  test('off never, strict always, local_memory only for memory-class purposes', () => {
    const memoryClass = [
      'memory',
      'jev',
      'embedding',
      'knowledge_verify',
      'unknown',
    ] as const;
    const other = ['agent', 'chat', 'stt', 'image', 'web', 'helper'] as const;
    for (const purpose of [...memoryClass, ...other]) {
      expect(requiresLocal('off', purpose)).toBe(false);
      expect(requiresLocal('strict', purpose)).toBe(true);
    }
    for (const purpose of memoryClass) {
      expect(requiresLocal('local_memory', purpose)).toBe(true);
    }
    for (const purpose of other) {
      expect(requiresLocal('local_memory', purpose)).toBe(false);
    }
  });
});

describe('assertEgressAllowed', () => {
  test('a remote target for a strict project logs one privacy_refusal and throws', async () => {
    const projectId = await register('strict', 'strict');
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      let refusal: unknown;
      try {
        assertEgressAllowed({
          projectId,
          purpose: 'chat',
          locality: 'remote',
          target: 'http://remote.test/v1',
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(PrivacyRefusal);
      expect(refusal).toMatchObject({
        projectId,
        purpose: 'chat',
        mode: 'strict',
        target: 'http://remote.test/v1',
      });
      const refusals = warn.mock.calls.filter(
        ([fields]) => (fields as any)?.event === 'privacy_refusal',
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toEqual([
        {
          event: 'privacy_refusal',
          projectId,
          purpose: 'chat',
          mode: 'strict',
          target: 'http://remote.test/v1',
        },
        'privacy_refusal',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('local targets always pass, and remote passes when the mode does not require local', async () => {
    const strict = await register('strict', 'strict');
    const lm = await register('lm', 'local_memory');
    expect(() =>
      assertEgressAllowed({
        projectId: strict,
        purpose: 'memory',
        locality: 'local',
        target: 'local',
      }),
    ).not.toThrow();
    expect(() =>
      assertEgressAllowed({
        projectId: lm,
        purpose: 'chat',
        locality: 'remote',
        target: 'remote',
      }),
    ).not.toThrow();
  });
});

describe('assertRuntimeAllowed', () => {
  const runtime = (
    locality: 'local' | 'remote',
    fallback?: ChatAgentOption,
  ): ChatAgentOption => ({
    id: `${locality}-runtime`,
    label: locality,
    locality,
    fallback,
  });

  async function refusals(run: () => void) {
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      const logged = warn.mock.calls.filter(
        ([fields]) => (fields as any)?.event === 'privacy_refusal',
      );
      return { thrown, logged: logged.length };
    } finally {
      warn.mockRestore();
    }
  }

  test('off mode returns without throwing or logging, even without a runtime', async () => {
    const projectId = await register('plain');
    const result = await refusals(() =>
      assertRuntimeAllowed({ projectId, purpose: 'agent' }),
    );
    expect(result).toEqual({ thrown: undefined, logged: 0 });
  });

  test('strict refuses remote, remote-fallback and missing runtimes once each', async () => {
    const projectId = await register('strict', 'strict');
    for (const candidate of [
      runtime('remote'),
      runtime('local', runtime('remote')),
      undefined,
    ]) {
      const result = await refusals(() =>
        assertRuntimeAllowed({
          projectId,
          purpose: 'agent',
          runtime: candidate,
        }),
      );
      expect(result.thrown).toBeInstanceOf(PrivacyRefusal);
      expect((result.thrown as PrivacyRefusal).target).toBe(
        candidate?.id ?? 'unresolved-runtime',
      );
      expect(result.logged).toBe(1);
    }
  });

  test('strict allows a local runtime', async () => {
    const projectId = await register('strict', 'strict');
    expect(() =>
      assertRuntimeAllowed({
        projectId,
        purpose: 'agent',
        runtime: runtime('local'),
      }),
    ).not.toThrow();
  });

  test('local_memory allows remote agent runs but refuses memory runs', async () => {
    const projectId = await register('lm', 'local_memory');
    const remote = runtime('remote');
    expect(() =>
      assertRuntimeAllowed({ projectId, purpose: 'agent', runtime: remote }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeAllowed({ projectId, purpose: 'memory', runtime: remote }),
    ).toThrow(PrivacyRefusal);
  });
});

describe('cross-project reads', () => {
  test('only a strict reader receives memories from a local_memory/strict source', () => {
    for (const reader of ['off', 'local_memory', 'strict'] as const) {
      expect(crossProjectModesAllowed('off', reader, 'memory')).toBe(true);
    }
    for (const source of ['local_memory', 'strict'] as const) {
      expect(crossProjectModesAllowed(source, 'off', 'memory')).toBe(false);
      expect(crossProjectModesAllowed(source, 'local_memory', 'memory')).toBe(
        false,
      );
      expect(crossProjectModesAllowed(source, 'strict', 'memory')).toBe(true);
    }
    expect(crossProjectModesAllowed('local_memory', 'off', 'agent')).toBe(true);
  });

  test('same project is allowed; an absent reader counts as off', async () => {
    const strict = await register('strict', 'strict');
    expect(crossProjectReadAllowed(strict, strict, 'memory')).toBe(true);
    expect(crossProjectReadAllowed(strict, undefined, 'memory')).toBe(false);
  });

  test('recall scope drops protected projects and never widens to all projects', async () => {
    const plain = await register('plain');
    const other = await register('other');
    const strict = await register('strict', 'strict');
    const all = [plain, other, strict];

    expect(applyPrivacyRecallScope([plain, strict], plain, all)).toEqual([
      plain,
    ]);
    expect(applyPrivacyRecallScope([], plain, all)).toEqual([plain, other]);
    expect(applyPrivacyRecallScope([strict], plain, all)).toBeNull();
    expect(applyPrivacyRecallScope([strict], strict, all)).toEqual([strict]);
    expect(applyPrivacyRecallScope([plain], plain, all)).toEqual([plain]);
  });

  test('recall scope is unchanged when no project has a mode', async () => {
    const a = await register('a');
    const b = await register('b');
    expect(applyPrivacyRecallScope([], a, [a, b])).toEqual([]);
    expect(applyPrivacyRecallScope([a, b], a, [a, b])).toEqual([a, b]);
  });
});
