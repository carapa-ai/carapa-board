import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { initDatabase } from '../../db.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import { startReflectorGateScore } from './reflector-gate.js';

const jid = `reflector-gate-${process.pid}@web`;
const folder = `reflector-gate-${process.pid}`;
const openJid = `reflector-gate-open-${process.pid}@web`;
const openFolder = `reflector-gate-open-${process.pid}`;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(jid, {
    jid,
    name: 'Reflector gate',
    folder,
    trigger: '@gate',
    added_at: new Date().toISOString(),
    settings: { privacyMode: 'strict' },
  });
  await registerGroup(openJid, {
    jid: openJid,
    name: 'Reflector gate open',
    folder: openFolder,
    trigger: '@open',
    added_at: new Date().toISOString(),
    settings: {},
  });
});
afterAll(async () => {
  await unregisterGroup(jid);
  await unregisterGroup(openJid);
});

async function gateFetchCalls(groupFolder: string): Promise<number> {
  const fetchImpl = mock(async () => Response.json({ answers: {} }));
  const score = startReflectorGateScore(
    { text: 'chunk', index: 0 },
    {
      groupFolder,
      runId: 'run-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      shadowLogPath: null,
    },
  );
  await score.finish(0);
  return fetchImpl.mock.calls.length;
}

describe('reflector gate privacy attribution', () => {
  test('the gate is attributed to its project, not blocked project-wide', async () => {
    // The default Jev URL is the in-process test server (a remote endpoint).
    expect(await gateFetchCalls(folder)).toBe(0);
    expect(await gateFetchCalls(openFolder)).toBe(1);
  });
});
