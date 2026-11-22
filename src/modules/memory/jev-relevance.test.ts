import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { initDatabase } from '../../db.js';
import { JevError } from '../../lib/jev-client.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import { scoreMemoryRelevance, selectByJev } from './jev-relevance.js';

const jid = `jev-relevance-${process.pid}@web`;
const folder = `jev-relevance-${process.pid}`;
const openJid = `jev-relevance-open-${process.pid}@web`;
const openFolder = `jev-relevance-open-${process.pid}`;
const candidates = [{ id: 'm1', content: 'memory', source: 'user' }] as any[];

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(jid, {
    jid,
    name: 'Jev relevance',
    folder,
    trigger: '@jev',
    added_at: new Date().toISOString(),
    settings: { privacyMode: 'strict' },
  });
  await registerGroup(openJid, {
    jid: openJid,
    name: 'Jev relevance open',
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

describe('Jev relevance privacy attribution', () => {
  test('projectId reaches the request gate: strict project + remote Jev is refused', async () => {
    const fetchImpl = mock(async () => Response.json({ results: [] }));
    const error = await scoreMemoryRelevance('request', candidates, {
      url: 'http://hosted-jev.test/api',
      projectId: folder,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JevError);
    expect(error.kind).toBe('privacy');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a non-strict project is not blocked by another strict project', async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        results: [{ answers: { relevance: { score: 2 } } }],
      }),
    );
    const result = await scoreMemoryRelevance('request', candidates, {
      url: 'http://hosted-jev.test/api',
      projectId: openFolder,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.scores.get('m1')).toBe(2);
  });

  test('selectByJev forwards projectId to the scorer', async () => {
    const scorer = mock(async () => ({
      scores: new Map([['m1', 2]]),
      checkpoints: {},
    }));
    await selectByJev('request', candidates, { scorer, projectId: folder });
    expect(scorer).toHaveBeenCalledWith('request', candidates, {
      projectId: folder,
    });
  });
});
