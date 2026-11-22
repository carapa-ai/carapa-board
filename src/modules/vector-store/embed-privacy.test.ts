// ENABLE_VECTOR_STORE is read when the config module loads, so this file runs
// in its own process (see scripts/test-file-groups.sh) and sets it first.
process.env.ENABLE_VECTOR_STORE = 'true';

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { PRIVACY_LOCAL_ENDPOINT_PREFIXES } from '../../config.js';
import { initDatabase } from '../../db.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';

// Imports are hoisted above the env assignment, so load these dynamically.
const { EMBEDDING_API_URL } = await import('./config.js');
const realStore = await import('./store.js');
const { embedText } = realStore;

// Make the vector store look connected so the hook sites reach embedText. The
// real embedText (and its privacy gate) is kept; this file runs in its own
// process, so the module mock cannot leak into other suites.
mock.module('./store.js', () => ({
  ...realStore,
  initNeo4j: async () => {},
  isVectorStoreAvailable: () => true,
  upsertMemoryVector: async () => {},
  searchSimilarMultiGroup: async () => [],
}));
const { default: vectorStoreModule } = await import('./index.js');
const { createVectorRecallStats, getVectorStoreHooks } =
  await import('./hooks.js');

const jid = `embed-privacy-${process.pid}@web`;
const originalFetch = globalThis.fetch;
const localPrefixes = PRIVACY_LOCAL_ENDPOINT_PREFIXES as string[];

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterGroup(jid);
});

const stubFetch = () => {
  const stub = mock(async () => Response.json({ embeddings: [[0.1, 0.2]] }));
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
};
const folderOf = (j: string) => j.replace('@web', '');
const setMode = async (privacyMode?: 'strict') => {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Embed privacy',
    folder: jid.replace('@web', ''),
    trigger: '@embed',
    added_at: new Date().toISOString(),
    settings: privacyMode ? { privacyMode } : {},
  });
};

describe('embedText privacy gate', () => {
  test('is unchanged when every project is off', async () => {
    await setMode();
    const fetchStub = stubFetch();
    expect(await embedText('hello')).toEqual([0.1, 0.2]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test('returns null without fetching or retrying when refused', async () => {
    await setMode('strict');
    const fetchStub = stubFetch();
    expect(await embedText('hello')).toBeNull();
    expect(
      await embedText('hello', { projectId: jid.replace('@web', '') }),
    ).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('a local embedding endpoint is allowed for a strict project', async () => {
    await setMode('strict');
    const origin = new URL(EMBEDDING_API_URL).origin;
    localPrefixes.push(origin);
    try {
      const fetchStub = stubFetch();
      expect(await embedText('hello')).toEqual([0.1, 0.2]);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally {
      localPrefixes.splice(localPrefixes.indexOf(origin), 1);
    }
  });
});

describe('memory embedding sites are attributed to their project', () => {
  const offJid = `embed-off-${process.pid}@web`;
  const strictJid = `embed-strict-${process.pid}@web`;
  const offFolder = folderOf(offJid);
  const strictFolder = folderOf(strictJid);

  const register = (j: string, privacyMode?: 'strict') =>
    registerGroup(j, {
      jid: j,
      name: j,
      folder: folderOf(j),
      trigger: '@embed',
      added_at: new Date().toISOString(),
      settings: privacyMode ? { privacyMode } : {},
    });

  beforeAll(async () => {
    await unregisterGroup(jid);
    await register(offJid);
    await register(strictJid, 'strict');
    await vectorStoreModule.init!();
  });
  afterAll(async () => {
    await vectorStoreModule.shutdown!();
    await unregisterGroup(offJid);
    await unregisterGroup(strictJid);
  });

  test('vector-store embedAndStore embeds an off project despite a strict one', async () => {
    const fetchStub = stubFetch();
    await getVectorStoreHooks()!.embedAndStore('mem-x', offFolder, 'fact');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await getVectorStoreHooks()!.embedAndStore('mem-y', strictFolder, 'fact');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test('recall query embedding is judged by the strictest searched folder', async () => {
    const fetchStub = stubFetch();
    const params = { query: 'q', limit: 5 };
    const hooks = getVectorStoreHooks()!;
    expect(
      await hooks.enhanceRecall({ ...params, groupFolders: [offFolder] }),
    ).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const refusedStats = createVectorRecallStats();
    expect(
      await hooks.enhanceRecall({
        ...params,
        groupFolders: [offFolder, strictFolder],
        stats: refusedStats,
      }),
    ).toBeNull();
    expect(refusedStats.embedSkipped).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // An empty list stays unattributed: strictest of all registered projects.
    expect(
      await hooks.enhanceRecall({ ...params, groupFolders: [] }),
    ).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
