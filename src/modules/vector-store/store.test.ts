import { describe, expect, test } from 'bun:test';
import {
  eraseMemoryDataInSession,
  deleteGroupMemoryGraphInSession,
  DELETE_GROUP_MEMORY_GRAPH_CYPHER,
  eraseGraphFactsMatchingTargetInSession,
  invalidateMemoryGraphInSession,
  upsertRelationInSession,
  UPSERT_MEMORY_VECTOR_CYPHER,
  LIST_MEMORY_VECTOR_IDS_CYPHER,
  DELETE_ORPHAN_MEMORY_VECTORS_CYPHER,
  vectorValidityClause,
  searchSimilarMultiGroupInSession,
  searchSimilarAllGroupsInSession,
} from './store.js';
import { createVectorRecallStats } from './hooks.js';
import { VECTOR_MIN_SCORE } from './config.js';
import { protectedTargetTokens } from '../memory/privacy-token.js';

describe('upsertRelationInSession temporal validity', () => {
  test('uses a backdated observation time to open and close relation windows', async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    const session = {
      async run(query: string, params?: Record<string, unknown>) {
        calls.push({ query, params });
        return {};
      },
    };
    const validFrom = '2024-04-01T12:30:00.000Z';

    await upsertRelationInSession(session, {
      subject: 'Marta',
      relation: 'LIVES_IN',
      object: 'Madrid',
      group_folder: 'carapa-board',
      source_memory_id: 'mem-backdated-correction',
      validFrom,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain(
      'future.valid_from > datetime($effectiveAt)',
    );
    expect(calls[0].query).toContain(
      'active.valid_from <= datetime($effectiveAt)',
    );
    expect(calls[0].query).toContain(
      'active.valid_to > datetime($effectiveAt)',
    );
    expect(calls[0].query).toContain(
      'SET active.valid_to = datetime($effectiveAt)',
    );
    expect(calls[0].query).toContain('SET r.valid_to = nextValidFrom');
    expect(calls[0].params?.effectiveAt).toBe(validFrom);
    expect(
      calls.some((call) =>
        /r\.valid_(?:from|to) = datetime\(\)/.test(call.query),
      ),
    ).toBe(false);
  });
});

describe('eraseMemoryDataInSession privacy erasure', () => {
  test('removes provenance relations, orphan entities, and the vector node', async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    const session = {
      async run(query: string, params?: Record<string, unknown>) {
        calls.push({ query, params });
        return {};
      },
    };

    await eraseMemoryDataInSession(session, 'mem-private');

    expect(calls).toHaveLength(3);
    expect(calls[0].query).toContain('RETURN DISTINCT elementId(e)');
    expect(calls[1].query).toContain('r.source_memory_id = $id');
    expect(calls[1].query).toContain('DELETE relation');
    expect(calls[1].query).toContain('WHERE NOT (entity)--()');
    expect(calls[2].query).toContain('DETACH DELETE m');
    expect(calls.every((call) => call.params?.id === 'mem-private')).toBe(true);
  });

  test('deletes a sensitive entity even when it has other relationships', async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    const session = {
      async run(query: string, params?: Record<string, unknown>) {
        calls.push({ query, params });
        return calls.length === 1
          ? {
              records: [
                {
                  get: (key: string) =>
                    key === 'entityId'
                      ? 'entity-private-coffee'
                      : 'private coffee',
                },
              ],
            }
          : {};
      },
    };
    const hashes = protectedTargetTokens('private coffee');

    await eraseMemoryDataInSession(session, 'mem-private', hashes);

    const entityDelete = calls.find((call) =>
      call.query.includes('DETACH DELETE e'),
    );
    expect(entityDelete).toBeUndefined();
    const anonymize = calls.find((call) =>
      call.query.includes("e.name = '[erased]'"),
    );
    expect(anonymize?.params?.entityIds).toEqual(['entity-private-coffee']);
  });
});

describe('invalidateMemoryGraphInSession temporal invalidation', () => {
  test('closes provenance relations at the same effective boundary', async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    const session = {
      async run(query: string, params?: Record<string, unknown>) {
        calls.push({ query, params });
        return {};
      },
    };
    const effectiveAt = '2026-07-13T12:00:00.000Z';

    await invalidateMemoryGraphInSession(session, 'mem-expired', effectiveAt);

    expect(calls).toHaveLength(2);
    expect(calls[0].query).toContain('r.source_memory_id = $memoryId');
    expect(calls[0].query).toContain('SET r.valid_to = datetime($effectiveAt)');
    expect(calls[0].params).toEqual({ memoryId: 'mem-expired', effectiveAt });
    // The vector node is kept (asOf recall) but marked for current recall.
    expect(calls[1].query).toContain('(m:Memory OR m:EvalMemory)');
    expect(calls[1].query).toContain(
      'SET m.invalid_at = datetime($effectiveAt)',
    );
    expect(calls[1].query).not.toContain('DELETE');
    expect(calls[1].params).toEqual({ memoryId: 'mem-expired', effectiveAt });
  });
});

describe('vector node validity filtering', () => {
  test('current recall excludes invalidated nodes; asOf keeps nodes valid then', () => {
    expect(vectorValidityClause()).toBe('node.invalid_at IS NULL');
    expect(vectorValidityClause('2026-01-01T00:00:00.000Z')).toBe(
      '(node.invalid_at IS NULL OR node.invalid_at > datetime($asOf))',
    );
  });

  test('re-embedding an invalidated memory never clears invalid_at', () => {
    expect(UPSERT_MEMORY_VECTOR_CYPHER('Memory')).not.toContain('invalid_at');
  });
});

describe('orphan memory vector sweep queries', () => {
  test('listing is group-scoped, keyset-paged and skips in-flight nodes', () => {
    expect(LIST_MEMORY_VECTOR_IDS_CYPHER).toContain(
      'm.group_folder = $groupFolder',
    );
    expect(LIST_MEMORY_VECTOR_IDS_CYPHER).toContain('m.id > $afterId');
    expect(LIST_MEMORY_VECTOR_IDS_CYPHER).toContain(
      "m.updated_at < datetime() - duration('PT10M')",
    );
  });

  test('deletion detaches only the given ids', () => {
    expect(DELETE_ORPHAN_MEMORY_VECTORS_CYPHER).toContain('m.id IN $ids');
    expect(DELETE_ORPHAN_MEMORY_VECTORS_CYPHER).toContain('DETACH DELETE m');
  });
});

describe('eraseGraphFactsMatchingTargetInSession privacy erasure', () => {
  test('deletes matching relations even when anchored to a different memory', async () => {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    const values = new Map<string, unknown>([
      ['relationId', 'rel-private'],
      ['subjectId', 'entity-user'],
      ['objectId', 'entity-coffee'],
      ['subject', 'User'],
      ['object', 'private coffee'],
      ['relation', 'LIKES'],
      ['rawLabel', null],
      ['sourceMemoryId', 'mem-different-anchor'],
    ]);
    const session = {
      async run(query: string, params?: Record<string, unknown>) {
        calls.push({ query, params });
        return calls.length === 1
          ? { records: [{ get: (key: string) => values.get(key) }] }
          : {};
      },
    };
    const targetHashes = protectedTargetTokens('private coffee');

    await eraseGraphFactsMatchingTargetInSession(
      session,
      'carapa-board',
      targetHashes,
    );

    expect(calls).toHaveLength(4);
    expect(calls[0].query).not.toContain('r.source_memory_id IS NULL');
    expect(calls[0].query).toContain('s.group_folder = $groupFolder');
    expect(calls[0].params?.groupFolder).toBe('carapa-board');
    expect(calls[1].params?.relationIds).toEqual(['rel-private']);
    expect(calls[2].query).toContain("e.name = '[erased]'");
    expect(calls[2].params?.entityIds).toEqual(['entity-coffee']);
    expect(calls[3].params?.entityIds).toEqual([
      'entity-user',
      'entity-coffee',
    ]);
    expect(calls[3].query).not.toContain('DETACH DELETE');
  });
});

describe('deleteGroupMemoryGraphInSession', () => {
  function recorder(count = 3) {
    const calls: Array<{ query: string; params?: Record<string, unknown> }> =
      [];
    return {
      calls,
      session: {
        async run(query: string, params?: Record<string, unknown>) {
          calls.push({ query, params });
          return { records: [{ get: () => count }] };
        },
      },
    };
  }

  test('deletes by exact folder equality and returns the count', async () => {
    const { calls, session } = recorder(3);
    expect(await deleteGroupMemoryGraphInSession(session, 'proj-a')).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(DELETE_GROUP_MEMORY_GRAPH_CYPHER);
    expect(calls[0].query).toContain('n.group_folder = $g');
    expect(calls[0].query).not.toMatch(/STARTS WITH|=~/);
    expect(calls[0].params).toEqual({ g: 'proj-a' });
  });

  test('issues no query for blank or eval folders', async () => {
    const { calls, session } = recorder();
    for (const folder of ['', '   ', '__eval__:run-1']) {
      expect(await deleteGroupMemoryGraphInSession(session, folder)).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('vector search recall stats', () => {
  function searchSession(row: {
    rawAnnHits: number;
    postFilterHits: number;
    hits: Array<{ id: string; score: number }>;
  }) {
    return {
      async run() {
        return {
          records: [{ get: (key: string) => (row as never)[key] }],
        } as never;
      },
    };
  }

  test('returns the same hits with or without stats', async () => {
    const hits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: VECTOR_MIN_SCORE },
      { id: 'c', score: VECTOR_MIN_SCORE - 0.01 },
    ];
    const session = searchSession({ rawAnnHits: 9, postFilterHits: 3, hits });
    const expected = hits.slice(0, 2);
    expect(
      await searchSimilarMultiGroupInSession(session, ['g'], [0.1], 3),
    ).toEqual(expected);
    expect(await searchSimilarAllGroupsInSession(session, [0.1], 3)).toEqual(
      expected,
    );
  });

  test('reports ANN starvation when every raw row is filtered out', async () => {
    const stats = createVectorRecallStats();
    const session = searchSession({
      rawAnnHits: 30,
      postFilterHits: 0,
      hits: [],
    });
    expect(
      await searchSimilarMultiGroupInSession(
        session,
        ['g'],
        [0.1],
        10,
        undefined,
        undefined,
        stats,
      ),
    ).toEqual([]);
    expect(stats).toMatchObject({
      rawAnnHits: 30,
      postFilterHits: 0,
      belowMinScore: 0,
    });
  });

  test('reports rows dropped by the minimum score', async () => {
    const stats = createVectorRecallStats();
    const session = searchSession({
      rawAnnHits: 10,
      postFilterHits: 2,
      hits: [
        { id: 'a', score: VECTOR_MIN_SCORE - 0.1 },
        { id: 'b', score: VECTOR_MIN_SCORE - 0.2 },
      ],
    });
    expect(
      await searchSimilarAllGroupsInSession(
        session,
        [0.1],
        10,
        undefined,
        undefined,
        stats,
      ),
    ).toEqual([]);
    expect(stats).toMatchObject({
      rawAnnHits: 10,
      postFilterHits: 2,
      belowMinScore: 2,
    });
  });
});
