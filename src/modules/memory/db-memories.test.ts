/**
 * Tests for memory CRUD functions in src/db.ts.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  initDatabase,
  insertMemory,
  getMemory,
  moveMemoryToGroup,
  invalidateMemory,
  supersedeMemory,
  insertSupersedingMemory,
  searchMemories,
  listCurrentProjectMemories,
  getMemoriesByIds,
  getPendingMemoryInvalidations,
  beginMemoryPrivacyErasure,
  getLastPrivacyErasureAt,
  type KeywordSearchStats,
} from '../../db.js';

import type { MemoryType } from './types.js';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { memories, memoryPrivacyErasureMarks } from '../../db/schema.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  getPrivacyErasureEpoch,
  markPrivacyErasureStarted,
} from './privacy-epoch.js';

const GROUP = 'mem-test-group';

function memFixture(
  overrides: Partial<{
    group_folder: string;
    content: string;
    memory_type: MemoryType;
    importance: number;
    tags: string[];
    source: 'agent' | 'user' | 'observer';
    sourceRef: string;
    objective_id: string | null;
    valid_from: string;
    valid_to: string | null;
  }> = {},
) {
  return {
    group_folder: GROUP,
    content: 'Test memory content',
    memory_type: 'task' as MemoryType,
    source: 'agent' as const,
    ...overrides,
  };
}

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
});

// ─── insertMemory ─────────────────────────────────────────────────────────────

describe('insertMemory', () => {
  test('rejects a writer whose captured privacy epoch is stale', async () => {
    const group_folder = 'mem-stale-privacy-writer';
    const expectedPrivacyEpoch = getPrivacyErasureEpoch(group_folder);
    markPrivacyErasureStarted(group_folder);

    await expect(
      insertMemory({
        ...memFixture({ group_folder }),
        expectedPrivacyEpoch,
      }),
    ).rejects.toThrow(/privacy erasure advanced/);
  });
});

describe('beginMemoryPrivacyErasure', () => {
  test('records a content-free erasure mark in the same transaction, only for a non-empty erasure', async () => {
    const group_folder = 'mem-erasure-mark-group';
    await beginMemoryPrivacyErasure([], group_folder, [], false, false);
    expect(await getLastPrivacyErasureAt(group_folder)).toBeNull();

    const mem = await insertMemory(
      memFixture({ group_folder, content: 'Secret address 12 Example Street' }),
    );
    await beginMemoryPrivacyErasure([mem.id], group_folder, [], false, false);

    expect(await getMemory(mem.id)).toBeFalsy();
    expect(await getLastPrivacyErasureAt(group_folder)).toEqual(
      expect.any(String),
    );
    const rows = await drizzleDbRef.current
      .select()
      .from(memoryPrivacyErasureMarks);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'group_folder',
      'last_erased_at',
    ]);
    expect(JSON.stringify(rows)).not.toContain('Example Street');
  });
});

describe('moveMemoryToGroup', () => {
  test('moves the memory and clears its source-project objective', async () => {
    const mem = await insertMemory(
      memFixture({ objective_id: 'source-objective' }),
    );

    await moveMemoryToGroup(mem.id, 'destination-group');

    const moved = await getMemory(mem.id);
    expect(moved?.group_folder).toBe('destination-group');
    expect(moved?.objective_id).toBeNull();
  });
});

// ─── eraseMemory ──────────────────────────────────────────────────────────────

describe('invalidateMemory', () => {
  test('closes validity without deleting historical content', async () => {
    const mem = await insertMemory(
      memFixture({
        valid_from: '2024-01-01T00:00:00.000Z',
      }),
    );
    await invalidateMemory(mem.id, '2024-02-01T00:00:00.000Z');

    expect((await getMemory(mem.id))!.valid_to).toBe(
      '2024-02-01T00:00:00.000Z',
    );
    expect(await getPendingMemoryInvalidations()).toEqual([
      {
        memory_id: mem.id,
        effective_at: '2024-02-01T00:00:00.000Z',
      },
    ]);
    expect(
      await searchMemories({ groupFolders: [GROUP], skipTouch: true }),
    ).toEqual([]);
    expect(
      (
        await searchMemories({
          groupFolders: [GROUP],
          asOf: '2024-01-15T00:00:00.000Z',
          skipTouch: true,
        })
      ).map((m) => m.id),
    ).toContain(mem.id);
  });
});

describe('searchMemories since / order=recent', () => {
  test('lists newest first, filters by since, and keeps default order', async () => {
    const stamps = [
      ['old-high', 0.9, '2026-01-01T00:00:00.000Z'],
      ['mid', 0.5, '2026-02-01T00:00:00.000Z'],
      ['new-low', 0.1, '2026-03-01T00:00:00.000Z'],
    ] as const;
    for (const [content, importance, updated] of stamps) {
      const m = await insertMemory(memFixture({ content, importance }));
      await drizzleDbRef.current
        .update(memories)
        .set({ updated_at: updated })
        .where(eq(memories.id, m.id));
    }
    const list = async (extra: object) =>
      (
        await searchMemories({
          groupFolders: [GROUP],
          skipTouch: true,
          ...extra,
        })
      ).map((m) => m.content);

    expect(await list({})).toEqual(['old-high', 'mid', 'new-low']);
    expect(await list({ order: 'recent', limit: 2 })).toEqual([
      'new-low',
      'mid',
    ]);
    expect(
      await list({ order: 'recent', since: '2026-02-01T00:00:00.000Z' }),
    ).toEqual(['new-low', 'mid']);
    expect(await list({ since: '2099-01-01T00:00:00.000Z' })).toEqual([]);
  });
});

// ─── supersedeMemory ──────────────────────────────────────────────────────────

describe('supersedeMemory', () => {
  test('sets superseded_by on the original memory', async () => {
    const old = await insertMemory(memFixture({ content: 'old info' }));
    const newMem = await insertMemory(memFixture({ content: 'new info' }));
    await supersedeMemory(old.id, newMem.id);
    expect((await getMemory(old.id))!.superseded_by).toBe(newMem.id);
    expect(await getPendingMemoryInvalidations()).toEqual([
      expect.objectContaining({ memory_id: old.id }),
    ]);
  });
});

describe('insertSupersedingMemory tags', () => {
  async function supersede(tags: string[] | undefined) {
    const prior = await insertMemory(
      memFixture({ content: 'old info', tags: ['alpha', 'beta'] }),
    );
    const replacement = await insertSupersedingMemory({
      targetMemoryId: prior.id,
      groupFolder: GROUP,
      expectedVersion: prior.updated_at,
      effectiveAt: new Date().toISOString(),
      content: 'new info',
      memoryType: 'task',
      source: 'agent',
      tags,
    });
    return (await getMemory(replacement!.id))!.tags;
  }

  test('inherits the prior tags when none are provided', async () => {
    expect(await supersede(undefined)).toEqual(['alpha', 'beta']);
  });

  test('an explicit empty list clears the prior tags', async () => {
    expect(await supersede([])).toEqual([]);
  });

  test('new tags replace the prior tags', async () => {
    expect(await supersede(['gamma'])).toEqual(['gamma']);
  });
});

// ─── searchMemories ───────────────────────────────────────────────────────────

/** Insert one old memory plus 501 newer ones, past the 500-row SQL cap. */
async function seedOldAndFlood(
  oldContent: string,
  floodContent: string,
  oldImportance?: number,
) {
  const old = await insertMemory(
    memFixture({ content: oldContent, importance: oldImportance }),
  );
  await drizzleDbRef.current
    .update(memories)
    .set({ updated_at: '2020-01-01T00:00:00.000Z' })
    .where(eq(memories.id, old.id));
  const now = new Date().toISOString();
  for (let start = 0; start < 501; start += 100) {
    const batch = [];
    for (let i = start; i < Math.min(start + 100, 501); i++) {
      batch.push({
        id: `flood-${i}`,
        group_folder: GROUP,
        content: `${floodContent} ${i}`,
        memory_type: 'task',
        importance: 0.5,
        source: 'agent',
        created_at: now,
        updated_at: now,
        last_accessed_at: now,
        access_count: 0,
        valid_from: now,
      });
    }
    await drizzleDbRef.current.insert(memories).values(batch);
  }
  return old;
}

describe('searchMemories', () => {
  test('stopwords do not flood the candidate set past the keyword match', async () => {
    const old = await seedOldAndFlood(
      'reflector chunk timeout raised',
      'the board was updated with the notes',
    );
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'the reflector',
      limit: 5,
    });
    expect(results[0]?.id).toBe(old.id);
  });

  test('a low-importance row with the rare term outranks a high-importance row with a common term', async () => {
    for (let i = 0; i < 4; i++) {
      await insertMemory(
        memFixture({ content: `deploy checklist item ${i}`, importance: 0.9 }),
      );
    }
    const rare = await insertMemory(
      memFixture({ content: 'deploy zebrafish rollout', importance: 0.1 }),
    );
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'deploy zebrafish',
      limit: 5,
      skipTouch: true,
    });
    expect(results[0]?.id).toBe(rare.id);
    expect(results.length).toBe(5);
  });

  test('an old high-importance row survives a flood of equally matching newer rows', async () => {
    const old = await seedOldAndFlood(
      'reflector note about identity',
      'reflector note',
      1.0,
    );
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'reflector note',
      limit: 600,
      skipTouch: true,
    });
    expect(results.map((m) => m.id)).toContain(old.id);
  });

  test('the newest matching rows are kept when many older high-importance rows exist', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    const rows = Array.from({ length: 501 }, (_, i) => ({
      id: `old-important-${i}`,
      group_folder: GROUP,
      content: `reflector note ${i}`,
      memory_type: 'task' as const,
      importance: 1.0,
      source: 'agent' as const,
      created_at: old,
      updated_at: old,
      last_accessed_at: old,
      access_count: 0,
      valid_from: old,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      await drizzleDbRef.current
        .insert(memories)
        .values(rows.slice(i, i + 100));
    }
    const fresh = await insertMemory(
      memFixture({ content: 'reflector note newest', importance: 0.1 }),
    );
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'reflector note',
      limit: 600,
      skipTouch: true,
    });
    expect(results.map((m) => m.id)).toContain(fresh.id);
  });

  test('stats expose substring-only candidates dropped by the token filter', async () => {
    await insertMemory(memFixture({ content: 'deployments overview' }));
    const stats: KeywordSearchStats = {
      queryTerms: -1,
      prefiltered: -1,
      capped: true,
      overlapHits: -1,
      returned: -1,
    };
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'deploy',
      stats,
    });
    expect(results).toEqual([]);
    expect(stats.queryTerms).toBe(1);
    expect(stats.prefiltered).toBeGreaterThanOrEqual(1);
    expect(stats.capped).toBe(false);
    expect(stats.overlapHits).toBe(0);
    expect(stats.returned).toBe(0);
  });

  test('candidates matching more distinct query terms are kept first', async () => {
    const old = await seedOldAndFlood('board reflector', 'board');
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'board reflector',
      limit: 5,
    });
    expect(results[0]?.id).toBe(old.id);
  });

  test('administrative pagination counts all current memories, including objective-scoped rows', async () => {
    await insertMemory(
      memFixture({ content: 'project memory', importance: 0.9 }),
    );
    await insertMemory(
      memFixture({
        content: 'objective memory',
        objective_id: 'objective-without-filter',
        importance: 0.8,
      }),
    );
    const old = await insertMemory(memFixture({ content: 'old memory' }));
    const replacement = await insertMemory(
      memFixture({ content: 'replacement memory' }),
    );
    await supersedeMemory(old.id, replacement.id);

    const first = await listCurrentProjectMemories({
      groupFolder: GROUP,
      limit: 2,
    });
    const second = await listCurrentProjectMemories({
      groupFolder: GROUP,
      limit: 2,
      offset: 2,
    });
    expect(first.total).toBe(3);
    expect(first.memories).toHaveLength(2);
    expect(second.memories).toHaveLength(1);
    expect(
      [...first.memories, ...second.memories].map((memory) => memory.content),
    ).toContain('objective memory');
  });

  test('returns memories for specified group', async () => {
    await insertMemory(
      memFixture({ content: 'group A memory', group_folder: 'grp-a' }),
    );
    await insertMemory(
      memFixture({ content: 'group B memory', group_folder: 'grp-b' }),
    );
    const results = await searchMemories({ groupFolders: ['grp-a'] });
    expect(results.every((m) => m.group_folder === 'grp-a')).toBe(true);
    expect(results.some((m) => m.content === 'group A memory')).toBe(true);
  });

  test('excludes superseded memories', async () => {
    const old = await insertMemory(memFixture({ content: 'old' }));
    const next = await insertMemory(memFixture({ content: 'new' }));
    await supersedeMemory(old.id, next.id);
    const results = await searchMemories({ groupFolders: [GROUP] });
    expect(results.some((m) => m.id === old.id)).toBe(false);
    expect(results.some((m) => m.id === next.id)).toBe(true);
  });

  test('filters objective-scoped memories correctly', async () => {
    await insertMemory(
      memFixture({ content: 'project-wide', objective_id: null }),
    );
    await insertMemory(
      memFixture({ content: 'for obj1', objective_id: 'obj-1' }),
    );
    await insertMemory(
      memFixture({ content: 'for obj2', objective_id: 'obj-2' }),
    );

    // Without objective_id: only project-wide
    const projectWide = await searchMemories({
      groupFolders: [GROUP],
      skipTouch: true,
    });
    expect(projectWide.some((m) => m.content === 'project-wide')).toBe(true);
    expect(projectWide.some((m) => m.content === 'for obj1')).toBe(false);

    // With objective_id: project-wide + that objective's memories
    const withObj = await searchMemories({
      groupFolders: [GROUP],
      objective_id: 'obj-1',
      skipTouch: true,
    });
    expect(withObj.some((m) => m.content === 'project-wide')).toBe(true);
    expect(withObj.some((m) => m.content === 'for obj1')).toBe(true);
    expect(withObj.some((m) => m.content === 'for obj2')).toBe(false);
  });

  test('keyword search finds exact matches beyond the 500-row candidate cap', async () => {
    for (let i = 0; i < 510; i++) {
      await insertMemory(memFixture({ content: `filler memory number ${i}` }));
    }
    const target = await insertMemory(
      memFixture({
        content: 'Deployed fix for task-1791836412964-8phica today',
      }),
    );
    const results = await searchMemories({
      groupFolders: [GROUP],
      query: 'task-1791836412964-8phica',
      skipTouch: true,
    });
    expect(results[0]?.id).toBe(target.id);
  });

  test('keyword search matches tokens next to punctuation and returns nothing for unmatched queries', async () => {
    const board = await insertMemory(
      memFixture({ content: 'Board memory = PostgreSQL/Drizzle, not Neo4j.' }),
    );
    const idMem = await insertMemory(
      memFixture({ content: 'Tracked in `task-1-abc` for now' }),
    );
    await insertMemory(memFixture({ content: 'Unrelated note' }));

    for (const query of ['drizzle', 'neo4j', 'postgresql']) {
      const results = await searchMemories({
        groupFolders: [GROUP],
        query,
        skipTouch: true,
      });
      expect(results[0]?.id).toBe(board.id);
    }
    const byId = await searchMemories({
      groupFolders: [GROUP],
      query: 'task-1-abc',
      skipTouch: true,
    });
    expect(byId.map((m) => m.id)).toEqual([idMem.id]);

    const none = await searchMemories({
      groupFolders: [GROUP],
      query: 'zzzqqq nonexistent',
      skipTouch: true,
    });
    expect(none).toEqual([]);
  });

  test('keyword search matches pieces of hyphenated tokens and tags', async () => {
    const target = await insertMemory(
      memFixture({
        content: 'Deployed fix for task-1791836412964-lxbwjc today',
      }),
    );
    const tagged = await insertMemory(
      memFixture({ content: 'Unrelated body text', tags: ['task-creation'] }),
    );
    await insertMemory(memFixture({ content: 'Another unrelated note' }));

    const byPiece = await searchMemories({
      groupFolders: [GROUP],
      query: 'lxbwjc',
      skipTouch: true,
    });
    expect(byPiece[0]?.id).toBe(target.id);

    const byTagPiece = await searchMemories({
      groupFolders: [GROUP],
      query: 'creation',
      skipTouch: true,
    });
    expect(byTagPiece.map((m) => m.id)).toContain(tagged.id);

    const none = await searchMemories({
      groupFolders: [GROUP],
      query: 'zzzqqq nonexistent',
      skipTouch: true,
    });
    expect(none).toEqual([]);
  });
});

// ─── temporal validity ────────────────────────────────────────────────────────

describe('temporal validity', () => {
  test('backdated supersession splices into an existing timeline', async () => {
    const old = await insertMemory(
      memFixture({
        content: 'lives in Barcelona',
        valid_from: '2024-01-01T00:00:00.000Z',
      }),
    );
    const current = await insertMemory(
      memFixture({
        content: 'lives in Lisbon',
        valid_from: '2024-06-01T00:00:00.000Z',
      }),
    );
    await supersedeMemory(old.id, current.id, current.valid_from!);

    const middle = await insertMemory(
      memFixture({
        content: 'lives in Madrid',
        valid_from: '2024-04-01T00:00:00.000Z',
      }),
    );
    await supersedeMemory(old.id, middle.id, middle.valid_from!);

    expect((await getMemory(old.id))!.valid_to).toBe(middle.valid_from);
    expect((await getMemory(old.id))!.superseded_by).toBe(middle.id);
    expect((await getMemory(middle.id))!.valid_to).toBe(current.valid_from);
    expect((await getMemory(middle.id))!.superseded_by).toBe(current.id);
    expect((await getMemory(current.id))!.valid_to).toBeNull();

    const march = await searchMemories({
      groupFolders: [GROUP],
      asOf: '2024-03-01T00:00:00.000Z',
      skipTouch: true,
    });
    const may = await searchMemories({
      groupFolders: [GROUP],
      asOf: '2024-05-01T00:00:00.000Z',
      skipTouch: true,
    });
    const july = await searchMemories({
      groupFolders: [GROUP],
      asOf: '2024-07-01T00:00:00.000Z',
      skipTouch: true,
    });

    expect(march.map((m) => m.id)).toContain(old.id);
    expect(may.map((m) => m.id)).toContain(middle.id);
    expect(july.map((m) => m.id)).toContain(current.id);
  });
});

// ─── getMemoriesByIds ─────────────────────────────────────────────────────────

describe('getMemoriesByIds', () => {
  test('hydrates only currently-valid ids and respects group scope', async () => {
    const a = await insertMemory(
      memFixture({ content: 'A', group_folder: 'grp-x' }),
    );
    const b = await insertMemory(
      memFixture({ content: 'B', group_folder: 'grp-x' }),
    );
    const other = await insertMemory(
      memFixture({ content: 'C', group_folder: 'grp-y' }),
    );
    const next = await insertMemory(
      memFixture({ content: 'B2', group_folder: 'grp-x' }),
    );
    await supersedeMemory(b.id, next.id);

    const rows = await getMemoriesByIds([a.id, b.id, other.id], {
      groupFolders: ['grp-x'],
    });
    const ids = rows.map((m) => m.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id); // superseded → excluded
    expect(ids).not.toContain(other.id); // wrong group → excluded
  });

  test('hydrates a superseded id when it was valid asOf', async () => {
    const old = await insertMemory(
      memFixture({
        content: 'Historical deployment target',
        valid_from: '2024-01-01T00:00:00.000Z',
      }),
    );
    const next = await insertMemory(
      memFixture({
        content: 'Current deployment target',
        valid_from: '2024-06-01T00:00:00.000Z',
      }),
    );
    await supersedeMemory(old.id, next.id, next.valid_from!);

    const historical = await getMemoriesByIds([old.id], {
      groupFolders: [GROUP],
      asOf: '2024-03-01T00:00:00.000Z',
    });
    const current = await getMemoriesByIds([old.id], { groupFolders: [GROUP] });

    expect(historical.map((m) => m.id)).toEqual([old.id]);
    expect(current).toEqual([]);
  });
});
