/**
 * Per-project isolation invariants for MemoryBackend.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { initDatabase, insertMemory, getMemory } from '../../../db.js';
import { truncateTestDb } from '../../../test-helpers.js';
import { logger } from '../../../logger.js';
import { invalidateMemory } from '../db-memories.js';
import { pgMemoryBackend } from './pg-backend.js';
import {
  setVectorStoreHooks,
  type VectorStoreHooks,
} from '../../vector-store/hooks.js';
import { filterMemoriesByRecallScope } from './tenant.js';
import type { Memory } from '../types.js';

const GROUP_A = 'iso-group-a';
const GROUP_B = 'iso-group-b';

const mockHooks: VectorStoreHooks = {
  embedAndStore: async () => {},
  enhanceRecall: async () => null,
  eraseMemory: async () => {},
  invalidateMemory: async () => {},
  eraseGraphFactsMatchingTarget: async () => {},
  upsertEntity: () => {},
  upsertRelation: async () => {},
  expandEntities: async () => null,
  isAvailable: () => false,
  isVectorOnlyRecall: () => false,
  minScore: () => 0.5,
};

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
  setVectorStoreHooks(mockHooks);
});

afterEach(() => {
  setVectorStoreHooks(null!);
});

describe('PgMemoryBackend project isolation', () => {
  test('recall with group B scope never returns group A memories', async () => {
    await pgMemoryBackend.memorize({
      group_folder: GROUP_A,
      content: 'kubernetes deployment runs on gke in group A',
      memory_type: 'project',
      source: 'agent',
    });
    await insertMemory({
      group_folder: GROUP_B,
      content: 'unrelated budget notes in group B',
      memory_type: 'event',
      source: 'agent',
    });

    const result = await pgMemoryBackend.recall({
      groupFolders: [GROUP_B],
      query: 'kubernetes gke',
      limit: 10,
    });

    expect(result.memories.every((m) => m.group_folder === GROUP_B)).toBe(true);
    expect(result.memories.some((m) => m.content.includes('group A'))).toBe(
      false,
    );
  });

  test('privacy erasure rejects cross-group scope even when id is known', async () => {
    const outcome = await pgMemoryBackend.memorize({
      group_folder: GROUP_A,
      content: 'Memory owned by group A',
      memory_type: 'project',
      source: 'agent',
    });

    await expect(
      pgMemoryBackend.erase(outcome.memory.id, { group_folder: GROUP_B }),
    ).rejects.toThrow(/scope violation/i);

    expect(await getMemory(outcome.memory.id)).toBeDefined();
  });

  test('privacy erasure succeeds with matching scope and removes row', async () => {
    const outcome = await pgMemoryBackend.memorize({
      group_folder: GROUP_A,
      content: 'Temporary note to delete',
      memory_type: 'task',
      source: 'agent',
    });

    await pgMemoryBackend.erase(outcome.memory.id, { group_folder: GROUP_A });
    expect(await getMemory(outcome.memory.id)).toBeUndefined();
  });
});

describe('PgMemoryBackend typed recall graph expansion', () => {
  test('memory_type filter applies to graph provenance rows and related facts', async () => {
    const pref = await insertMemory({
      group_folder: 'g1',
      content: 'Alex prefers kubernetes on gke',
      memory_type: 'preference',
      source: 'agent',
    });
    const evt = await insertMemory({
      group_folder: 'g1',
      content: 'outage event happened in staging',
      memory_type: 'event',
      source: 'agent',
    });
    setVectorStoreHooks({
      ...mockHooks,
      isAvailable: () => true,
      enhanceRecall: async () => [{ id: pref.id, score: 0.9 }],
      expandEntities: async () => [
        {
          subject: 'gke',
          relation: 'HOSTS',
          object: 'staging',
          sourceMemoryId: evt.id,
        },
        { subject: 'a', relation: 'B', object: 'c' },
      ],
    });

    const typed = await pgMemoryBackend.recall({
      groupFolders: ['g1'],
      query: 'kubernetes gke',
      memory_type: 'preference',
      limit: 10,
      skipTouch: true,
    });
    expect(typed.memories.map((m) => m.id)).toEqual([pref.id]);
    expect((typed.related ?? []).map((f) => f.subject)).toEqual(['a']);

    const untyped = await pgMemoryBackend.recall({
      groupFolders: ['g1'],
      query: 'kubernetes gke',
      limit: 10,
      skipTouch: true,
    });
    expect(untyped.memories.map((m) => m.id).sort()).toEqual(
      [pref.id, evt.id].sort(),
    );
    expect(untyped.related ?? []).toHaveLength(2);
  });
});

describe('PgMemoryBackend graph provenance fusion', () => {
  test('a graph-only memory returned for several relations does not outrank a memory ranked 2nd by keyword and vector', async () => {
    const k1 = await insertMemory({
      group_folder: 'g-fuse',
      content: 'fusion alpha first',
      memory_type: 'preference',
      source: 'agent',
    });
    const k2 = await insertMemory({
      group_folder: 'g-fuse',
      content: 'fusion beta second',
      memory_type: 'preference',
      source: 'agent',
    });
    const graphOnly = await insertMemory({
      group_folder: 'g-fuse',
      content: 'entity substring match only',
      memory_type: 'event',
      source: 'agent',
    });
    // Vector list mirrors the keyword order, so both rank the same memory 2nd.
    const keywordOrder = (
      await pgMemoryBackend.recall({
        groupFolders: ['g-fuse'],
        query: 'fusion',
        limit: 10,
        skipTouch: true,
      })
    ).memories.map((m) => m.id);
    expect([...keywordOrder].sort()).toEqual([k1.id, k2.id].sort());
    setVectorStoreHooks({
      ...mockHooks,
      isAvailable: () => true,
      enhanceRecall: async () =>
        keywordOrder.map((id, i) => ({ id, score: 0.9 - i / 10 })),
      expandEntities: async () =>
        ['R1', 'R2', 'R3'].map((relation) => ({
          subject: 'entity',
          relation,
          object: 'x',
          sourceMemoryId: graphOnly.id,
        })),
    });
    const info = spyOn(logger, 'info').mockImplementation((() => {}) as never);
    try {
      const res = await pgMemoryBackend.recall({
        groupFolders: ['g-fuse'],
        query: 'fusion',
        limit: 10,
        skipTouch: true,
      });
      const ids = res.memories.map((m) => m.id);
      expect(ids).toHaveLength(3);
      expect(ids.indexOf(graphOnly.id)).toBe(2);
      expect(res.related ?? []).toHaveLength(3);
      const graphLog = info.mock.calls.find(
        (c: unknown[]) =>
          (c[0] as { event?: string } | undefined)?.event ===
          'memory_recall_graph',
      );
      expect((graphLog![0] as { graphOnlyInTop: number }).graphOnlyInTop).toBe(
        1,
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe('PgMemoryBackend memory_recall_vector log', () => {
  function recallVectorLogs(spy: ReturnType<typeof spyOn>) {
    return spy.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { event?: string } | undefined)?.event ===
        'memory_recall_vector',
    );
  }

  test('logs counts of vector hits dropped by validity and type filters', async () => {
    const kept = await insertMemory({
      group_folder: 'g-log',
      content: 'preference kept by every filter',
      memory_type: 'preference',
      source: 'agent',
    });
    const wrongType = await insertMemory({
      group_folder: 'g-log',
      content: 'event dropped by the type filter',
      memory_type: 'event',
      source: 'agent',
    });
    const stale = await insertMemory({
      group_folder: 'g-log',
      content: 'preference that was invalidated',
      memory_type: 'preference',
      source: 'agent',
    });
    expect(await invalidateMemory(stale.id)).toBe(true);
    setVectorStoreHooks({
      ...mockHooks,
      isAvailable: () => true,
      enhanceRecall: async ({ stats }) => {
        if (stats) {
          stats.rawAnnHits = 12;
          stats.postFilterHits = 4;
          stats.belowMinScore = 1;
        }
        return [
          { id: kept.id, score: 0.9 },
          { id: wrongType.id, score: 0.8 },
          { id: stale.id, score: 0.7 },
        ];
      },
    });

    const info = spyOn(logger, 'info').mockImplementation((() => {}) as never);
    try {
      await pgMemoryBackend.recall({
        groupFolders: ['g-log'],
        query: 'preference',
        memory_type: 'preference',
        limit: 10,
        skipTouch: true,
      });
      const logs = recallVectorLogs(info);
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toEqual({
        event: 'memory_recall_vector',
        vectorHits: 3,
        hydratedValid: 2,
        typeFiltered: 1,
        keptHits: 1,
        embedSkipped: false,
        unavailable: false,
        rawAnnHits: 12,
        postFilterHits: 4,
        belowMinScore: 1,
        asOf: false,
        groups: 1,
      });
    } finally {
      info.mockRestore();
    }
  });

  test('logs zeros when the vector search returns no hits', async () => {
    setVectorStoreHooks({
      ...mockHooks,
      isAvailable: () => true,
      enhanceRecall: async ({ stats }) => {
        if (stats) stats.embedSkipped = true;
        return null;
      },
    });

    const info = spyOn(logger, 'info').mockImplementation((() => {}) as never);
    try {
      await pgMemoryBackend.recall({
        groupFolders: ['g-log'],
        query: 'anything',
        limit: 10,
        skipTouch: true,
      });
      const logs = recallVectorLogs(info);
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toMatchObject({
        vectorHits: 0,
        hydratedValid: 0,
        typeFiltered: 0,
        keptHits: 0,
        embedSkipped: true,
        unavailable: false,
        rawAnnHits: 0,
        postFilterHits: 0,
        belowMinScore: 0,
      });
    } finally {
      info.mockRestore();
    }
  });
});

describe('PgMemoryBackend memory_recall_graph log', () => {
  function graphLogs(spy: ReturnType<typeof spyOn>) {
    return spy.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { event?: string } | undefined)?.event ===
        'memory_recall_graph',
    );
  }

  async function recallWithGraph(
    hooks: Partial<VectorStoreHooks>,
  ): Promise<unknown[][]> {
    const seed = await insertMemory({
      group_folder: 'g-graph',
      content: 'graph seed memory',
      memory_type: 'preference',
      source: 'agent',
    });
    setVectorStoreHooks({
      ...mockHooks,
      isAvailable: () => true,
      enhanceRecall: async () => [{ id: seed.id, score: 0.9 }],
      ...hooks,
    });
    const info = spyOn(logger, 'info').mockImplementation((() => {}) as never);
    try {
      await pgMemoryBackend.recall({
        groupFolders: ['g-graph'],
        query: 'graph',
        limit: 10,
        skipTouch: true,
      });
      return graphLogs(info);
    } finally {
      info.mockRestore();
    }
  }

  test('logs expanded, provenance-less and kept fact counts', async () => {
    const source = await insertMemory({
      group_folder: 'g-graph',
      content: 'provenance memory',
      memory_type: 'event',
      source: 'agent',
    });
    const logs = await recallWithGraph({
      expandEntities: async () => [
        { subject: 'a', relation: 'R', object: 'b', sourceMemoryId: source.id },
        { subject: 'c', relation: 'R', object: 'd' },
      ],
    });
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toEqual({
      event: 'memory_recall_graph',
      expanded: 2,
      withoutProvenance: 1,
      kept: 2,
      graphOnlyInTop: 1,
      groups: 1,
    });
  });

  test('is not emitted when vectors are unavailable', async () => {
    const logs = await recallWithGraph({ isAvailable: () => false });
    expect(logs).toHaveLength(0);
  });

  test('logs zeros when expandEntities returns null', async () => {
    const logs = await recallWithGraph({ expandEntities: async () => null });
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toEqual({
      event: 'memory_recall_graph',
      expanded: 0,
      withoutProvenance: 0,
      kept: 0,
      graphOnlyInTop: 0,
      groups: 1,
    });
  });
});

describe('PgMemoryBackend memory_recall_keyword log', () => {
  function keywordLogs(spy: ReturnType<typeof spyOn>) {
    return spy.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { event?: string } | undefined)?.event ===
        'memory_recall_keyword',
    );
  }

  async function recallLogged(query: string | undefined) {
    const info = spyOn(logger, 'info').mockImplementation((() => {}) as never);
    try {
      await pgMemoryBackend.recall({
        groupFolders: ['g-kw'],
        query,
        limit: 10,
        skipTouch: true,
      });
      return keywordLogs(info);
    } finally {
      info.mockRestore();
    }
  }

  test('logs one counts-only line per text-query recall', async () => {
    await insertMemory({
      group_folder: 'g-kw',
      content: 'zebra migration notes',
      memory_type: 'project',
      source: 'agent',
    });
    const logs = await recallLogged('zebra');
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toEqual({
      event: 'memory_recall_keyword',
      queryTerms: 1,
      prefiltered: 1,
      capped: false,
      overlapHits: 1,
      returned: 1,
      asOf: false,
      groups: 1,
      vectorAvailable: false,
    });
    expect(JSON.stringify(logs[0][0])).not.toContain('zebra');
  });

  test('query with no searchable tokens logs zero terms and no results', async () => {
    const logs = await recallLogged('a of to');
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toMatchObject({
      queryTerms: 0,
      prefiltered: 0,
      returned: 0,
    });
  });

  test('recall without a text query writes no keyword line', async () => {
    expect(await recallLogged(undefined)).toHaveLength(0);
  });
});

describe('filterMemoriesByRecallScope', () => {
  test('strips memories outside allowed groupFolders', () => {
    const rows: Memory[] = [
      {
        id: '1',
        group_folder: GROUP_A,
        content: 'a',
        memory_type: 'project',
        importance: 0.5,
        source: 'agent',
        created_at: '',
        updated_at: '',
        last_accessed_at: '',
        access_count: 0,
      },
      {
        id: '2',
        group_folder: GROUP_B,
        content: 'b',
        memory_type: 'project',
        importance: 0.5,
        source: 'agent',
        created_at: '',
        updated_at: '',
        last_accessed_at: '',
        access_count: 0,
      },
    ];

    const filtered = filterMemoriesByRecallScope(rows, {
      groupFolders: [GROUP_A],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].group_folder).toBe(GROUP_A);
  });

  test('passes all rows when groupFolders is empty (orchestrator)', () => {
    const rows: Memory[] = [
      {
        id: '1',
        group_folder: GROUP_A,
        content: 'a',
        memory_type: 'project',
        importance: 0.5,
        source: 'agent',
        created_at: '',
        updated_at: '',
        last_accessed_at: '',
        access_count: 0,
      },
      {
        id: '2',
        group_folder: GROUP_B,
        content: 'b',
        memory_type: 'project',
        importance: 0.5,
        source: 'agent',
        created_at: '',
        updated_at: '',
        last_accessed_at: '',
        access_count: 0,
      },
    ];

    expect(
      filterMemoriesByRecallScope(rows, { groupFolders: [] }),
    ).toHaveLength(2);
  });
});
