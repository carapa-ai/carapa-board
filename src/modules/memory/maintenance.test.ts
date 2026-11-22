import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  getMemory,
  initDatabase,
  insertMemory,
  supersedeMemory,
  invalidateMemory,
  getPendingMemoryInvalidations,
  searchMemories,
  eraseMemory,
} from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import { logger } from '../../logger.js';
import {
  getVectorStoreHooks,
  setVectorStoreHooks,
  type VectorStoreHooks,
} from '../vector-store/hooks.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { memories } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decayedImportance, maintainMemories } from './maintenance.js';
import {
  createVectorBackfillBudget,
  sweepOrphanMemoryVectors,
} from './graph-invalidation.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';

const GROUP = 'memory-maintenance-lifecycle';
const eraseCalls: string[] = [];
const invalidationCalls: Array<{ id: string; effectiveAt: string }> = [];
const markedBatches: Array<Array<{ id: string; effectiveAt: string }>> = [];
/** Fake Neo4j node ids (sorted) served to the orphan sweep. */
let vectorNodeIds: string[] = [];
const deletedOrphanBatches: string[][] = [];
let onInvalidate: ((id: string) => Promise<void>) | undefined;

const mockHooks: VectorStoreHooks = {
  embedAndStore: async () => {},
  enhanceRecall: async () => null,
  eraseMemory: async (id) => {
    eraseCalls.push(id);
  },
  invalidateMemory: async (id, effectiveAt) => {
    invalidationCalls.push({ id, effectiveAt });
    await onInvalidate?.(id);
  },
  markInvalidatedVectors: async (items) => {
    markedBatches.push(items);
    return items.length;
  },
  listMemoryVectorIdsPage: async (_group, afterId, limit) =>
    vectorNodeIds.filter((id) => id > afterId).slice(0, limit),
  deleteOrphanMemoryVectors: async (ids) => {
    deletedOrphanBatches.push(ids);
    vectorNodeIds = vectorNodeIds.filter((id) => !ids.includes(id));
    return ids.length;
  },
  eraseGraphFactsMatchingTarget: async () => {},
  upsertEntity: () => {},
  upsertRelation: async () => {},
  expandEntities: async () => null,
  isAvailable: () => true,
  isVectorOnlyRecall: () => false,
  minScore: () => 0.5,
};

beforeAll(async () => {
  await initDatabase(':memory:');
  setVectorStoreHooks(mockHooks);
});

beforeEach(async () => {
  await truncateTestDb();
  eraseCalls.length = 0;
  invalidationCalls.length = 0;
  markedBatches.length = 0;
  vectorNodeIds = [];
  deletedOrphanBatches.length = 0;
  onInvalidate = undefined;
});

const decayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-decay-'));

afterAll(() => {
  setVectorStoreHooks(null!);
  fs.rmSync(decayDir, { recursive: true, force: true });
});

describe('memory maintenance lifecycle', () => {
  test('archives decayed memories without privacy-erasing history or vectors', async () => {
    const memory = await insertMemory({
      group_folder: GROUP,
      content: 'Old low-value deployment note',
      memory_type: 'event',
      importance: 0.05,
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });

    await maintainMemories(GROUP);

    const archived = await getMemory(memory.id);
    expect(archived).toBeDefined();
    expect(archived!.valid_to).not.toBeNull();
    expect(eraseCalls).toEqual([]);
    expect(invalidationCalls).toHaveLength(1);
    expect(invalidationCalls[0].id).toBe(memory.id);
    expect(archived!.valid_to).toBe(invalidationCalls[0].effectiveAt);
    expect(
      await searchMemories({ groupFolders: [GROUP], skipTouch: true }),
    ).toEqual([]);
    expect(
      (
        await searchMemories({
          groupFolders: [GROUP],
          asOf: '2024-06-01T00:00:00.000Z',
          skipTouch: true,
        })
      ).map((m) => m.id),
    ).toContain(memory.id);
  });

  test('reconciles vector nodes of already-invalid memories only, repeatably', async () => {
    const open = await insertMemory({
      group_folder: GROUP,
      content: 'Still current preference',
      memory_type: 'preference',
      source: 'agent',
    });
    const closed = await insertMemory({
      group_folder: GROUP,
      content: 'Closed earlier fact',
      memory_type: 'event',
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    await invalidateMemory(closed.id, '2024-03-01T00:00:00.000Z');
    invalidationCalls.length = 0;

    await maintainMemories(GROUP);
    await maintainMemories(GROUP);

    const marked = markedBatches.flat();
    expect(marked.map((m) => m.id)).toEqual([closed.id, closed.id]);
    expect(
      marked.every((m) => m.effectiveAt === '2024-03-01T00:00:00.000Z'),
    ).toBe(true);
    expect(marked.some((m) => m.id === open.id)).toBe(false);
  });

  test('one pass marks every invalid row of a group and is repeatable across restarts', async () => {
    const stamp = new Date().toISOString();
    await drizzleDbRef.current.insert(memories).values(
      Array.from({ length: 1200 }, (_, i) => ({
        id: `invalid-${String(i).padStart(4, '0')}`,
        group_folder: GROUP,
        content: `closed fact ${i}`,
        memory_type: 'event',
        importance: 0.5,
        source: 'agent',
        created_at: stamp,
        updated_at: stamp,
        last_accessed_at: stamp,
        access_count: 0,
        valid_to: '2024-03-01T00:00:00.000Z',
      })),
    );

    await maintainMemories(GROUP);
    expect(new Set(markedBatches.flat().map((m) => m.id)).size).toBe(1200);

    // Reconcile keeps no in-process cursor, so a restart changes nothing.
    markedBatches.length = 0;
    await maintainMemories(GROUP);
    expect(new Set(markedBatches.flat().map((m) => m.id)).size).toBe(1200);
  });

  test('orphan sweep deletes only nodes without a SQL row', async () => {
    const kept = await insertMemory({
      group_folder: GROUP,
      content: 'Present current fact',
      memory_type: 'preference',
      source: 'agent',
    });
    const closed = await insertMemory({
      group_folder: GROUP,
      content: 'Invalid but present fact',
      memory_type: 'event',
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    await invalidateMemory(closed.id, '2024-03-01T00:00:00.000Z');
    const erased = await insertMemory({
      group_folder: GROUP,
      content: 'Erased fact',
      memory_type: 'event',
      source: 'agent',
    });
    await eraseMemory(erased.id);
    vectorNodeIds = [kept.id, closed.id, erased.id, 'never-had-a-row'].sort();

    await maintainMemories(GROUP);

    expect(deletedOrphanBatches).toEqual([
      [erased.id, 'never-had-a-row'].sort(),
    ]);
  });

  describe('orphan sweep guards', () => {
    const stamp = new Date().toISOString();
    const nodeId = (i: number) => `node-${String(i).padStart(4, '0')}`;
    const insertRows = (ids: string[]) =>
      drizzleDbRef.current.insert(memories).values(
        ids.map((id) => ({
          id,
          group_folder: GROUP,
          content: `row ${id}`,
          memory_type: 'event',
          importance: 0.5,
          source: 'agent',
          created_at: stamp,
          updated_at: stamp,
          last_accessed_at: stamp,
          access_count: 0,
        })),
      );
    const sweepLogs = (spy: ReturnType<typeof spyOn>, event: string) =>
      spy.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .filter((f: Record<string, unknown>) => f?.event === event);

    test('a failing SQL lookup deletes nothing, even from earlier pages', async () => {
      vectorNodeIds = Array.from({ length: 700 }, (_, i) => nodeId(i));
      const warn = spyOn(logger, 'warn');
      const realSelect = drizzleDbRef.current.select.bind(drizzleDbRef.current);
      let lookups = 0;
      const select = spyOn(drizzleDbRef.current, 'select').mockImplementation(((
        ...args: unknown[]
      ) => {
        // First page resolves (all orphans); the second page's lookup fails.
        if (++lookups === 2) throw new Error('sql unavailable');
        return (realSelect as any)(...args);
      }) as any);
      try {
        expect(await sweepOrphanMemoryVectors(GROUP)).toBe(0);
      } finally {
        select.mockRestore();
      }
      expect(deletedOrphanBatches).toEqual([]);
      expect(sweepLogs(warn, 'memory_vector_orphan_sweep_skipped')).toEqual([
        expect.objectContaining({
          group_folder: GROUP,
          reason: 'lookup_failed',
        }),
      ]);
      warn.mockRestore();
    });

    test('an empty SQL group with vector nodes deletes nothing', async () => {
      vectorNodeIds = Array.from({ length: 10 }, (_, i) => nodeId(i));
      const warn = spyOn(logger, 'warn');

      expect(await sweepOrphanMemoryVectors(GROUP)).toBe(0);

      expect(deletedOrphanBatches).toEqual([]);
      expect(sweepLogs(warn, 'memory_vector_orphan_sweep_skipped')).toEqual([
        expect.objectContaining({
          group_folder: GROUP,
          reason: 'sql_group_empty',
        }),
      ]);
      warn.mockRestore();
    });

    test('deletes exactly the nodes missing from SQL', async () => {
      const ids = Array.from({ length: 100 }, (_, i) => nodeId(i));
      await insertRows(ids.slice(2));
      vectorNodeIds = ids;
      const info = spyOn(logger, 'info');

      expect(await sweepOrphanMemoryVectors(GROUP)).toBe(2);

      expect(deletedOrphanBatches).toEqual([ids.slice(0, 2)]);
      expect(sweepLogs(info, 'memory_vector_orphan_sweep')).toEqual([
        expect.objectContaining({
          scanned: 100,
          orphanCount: 2,
          deleted: 2,
          remaining: 0,
        }),
      ]);
      info.mockRestore();
    });

    test('honours a lower delete cap and works through the rest on later passes', async () => {
      const ids = Array.from({ length: 500 }, (_, i) => nodeId(i));
      await insertRows(ids.slice(450));
      vectorNodeIds = ids;
      const info = spyOn(logger, 'info');

      expect(await sweepOrphanMemoryVectors(GROUP, 200)).toBe(200);
      expect(deletedOrphanBatches.flat()).toEqual(ids.slice(0, 200));
      expect(await sweepOrphanMemoryVectors(GROUP, 200)).toBe(200);
      expect(deletedOrphanBatches.flat()).toEqual(ids.slice(0, 400));
      // The default cap is the scan cap, so one uncapped pass clears the rest.
      expect(await sweepOrphanMemoryVectors(GROUP)).toBe(50);
      expect(deletedOrphanBatches.flat()).toEqual(ids.slice(0, 450));

      expect(sweepLogs(info, 'memory_vector_orphan_sweep')).toEqual([
        expect.objectContaining({
          scanned: 500,
          orphanCount: 450,
          deleted: 200,
          remaining: 250,
        }),
        expect.objectContaining({
          scanned: 300,
          orphanCount: 250,
          deleted: 200,
          remaining: 50,
        }),
        expect.objectContaining({
          scanned: 100,
          orphanCount: 50,
          deleted: 50,
          remaining: 0,
        }),
      ]);
      info.mockRestore();
    });
  });

  describe('valid row vector coverage', () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const row = (
      id: string,
      extra: Partial<typeof memories.$inferInsert> = {},
    ) => ({
      id,
      group_folder: GROUP,
      content: `coverage row ${id} distinct`,
      memory_type: 'event',
      importance: 0.5,
      source: 'agent',
      created_at: old,
      updated_at: old,
      last_accessed_at: old,
      access_count: 0,
      ...extra,
    });
    const coverageLogs = (spy: ReturnType<typeof spyOn>, event: string) =>
      spy.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .filter((f: Record<string, unknown>) => f?.event === event);
    const withFinder = (
      find: (ids: string[]) => Promise<Set<string>>,
      isAvailable = () => true,
    ) =>
      setVectorStoreHooks({
        ...mockHooks,
        findExistingMemoryVectorIds: find,
        isAvailable,
      });

    afterEach(() => setVectorStoreHooks(mockHooks));

    test('counts only old valid rows and reports those without a node', async () => {
      await drizzleDbRef.current
        .insert(memories)
        .values([
          row('cov-1'),
          row('cov-2'),
          row('cov-3'),
          row('cov-invalid', { valid_to: old }),
          row('cov-superseded', { superseded_by: 'cov-1', valid_to: old }),
          row('cov-recent', { updated_at: recent }),
        ]);
      const queried: string[][] = [];
      withFinder(async (ids) => {
        queried.push(ids);
        return new Set(ids.filter((id) => id !== 'cov-2'));
      });
      const info = spyOn(logger, 'info');

      await maintainMemories(GROUP);

      expect(queried[0]).toEqual(['cov-1', 'cov-2', 'cov-3']);
      expect(coverageLogs(info, 'memory_vector_coverage')).toEqual([
        expect.objectContaining({
          group_folder: GROUP,
          validRows: 3,
          validRowsWithoutNode: 1,
          excludedByPrivacy: false,
          sampleMissingIds: ['cov-2'],
        }),
      ]);
      info.mockRestore();
    });

    test('a failing lookup logs a warning and maintenance still completes', async () => {
      await drizzleDbRef.current.insert(memories).values([row('cov-1')]);
      withFinder(async () => {
        throw new Error('neo4j down');
      });
      const info = spyOn(logger, 'info');
      const warn = spyOn(logger, 'warn');

      await maintainMemories(GROUP);

      expect(coverageLogs(info, 'memory_vector_coverage')).toEqual([]);
      expect(coverageLogs(warn, 'memory_vector_coverage_failed')).toEqual([
        expect.objectContaining({ group_folder: GROUP }),
      ]);
      info.mockRestore();
      warn.mockRestore();
    });

    describe('backfill of missing vectors', () => {
      const insertGroupRows = (group: string, count: number) =>
        drizzleDbRef.current.insert(memories).values(
          Array.from({ length: count }, (_, i) =>
            row(`${group}-${String(i).padStart(3, '0')}`, {
              group_folder: group,
            }),
          ),
        );
      /** Fake store: embeds create a node unless `failEmbeds` is set. */
      const withStore = (
        opts: { failEmbeds?: boolean; isAvailable?: () => boolean } = {},
      ) => {
        const nodes = new Set<string>();
        const embedded: string[] = [];
        setVectorStoreHooks({
          ...mockHooks,
          embedAndStore: async (id) => {
            embedded.push(id);
            if (!opts.failEmbeds) nodes.add(id);
          },
          findExistingMemoryVectorIds: async (ids) =>
            new Set(ids.filter((id) => nodes.has(id))),
          isAvailable: opts.isAvailable ?? (() => true),
        });
        return embedded;
      };

      test('caps embeds at 50 per group and 200 per pass across groups', async () => {
        const groups = ['bf-a', 'bf-b', 'bf-c', 'bf-d', 'bf-e'];
        for (const g of groups) await insertGroupRows(g, 80);
        const embedded = withStore();
        const budget = createVectorBackfillBudget();

        await maintainMemories(groups[0], { vectorBackfillBudget: budget });
        expect(embedded).toHaveLength(50);
        for (const g of groups.slice(1))
          await maintainMemories(g, { vectorBackfillBudget: budget });
        expect(embedded).toHaveLength(200);
        expect(budget.remaining).toBe(0);
        expect(embedded.filter((id) => id.startsWith('bf-e'))).toHaveLength(0);
      });

      test('a privacy-refused group embeds nothing and is reported excluded', async () => {
        await loadState();
        await registerGroup('bf-private@web', {
          jid: 'bf-private@web',
          name: 'Backfill private',
          folder: 'bf-private',
          trigger: '@bf',
          added_at: new Date().toISOString(),
          settings: { privacyMode: 'strict' },
        });
        try {
          await insertGroupRows('bf-private', 3);
          const embedded = withStore();
          const info = spyOn(logger, 'info');

          await maintainMemories('bf-private');

          expect(embedded).toEqual([]);
          expect(coverageLogs(info, 'memory_vector_coverage')).toEqual([
            expect.objectContaining({
              validRowsWithoutNode: 3,
              excludedByPrivacy: true,
            }),
          ]);
          expect(coverageLogs(info, 'memory_vector_backfill')).toEqual([
            expect.objectContaining({
              group_folder: 'bf-private',
              excluded: 'privacy',
            }),
          ]);
          info.mockRestore();
        } finally {
          await unregisterGroup('bf-private@web');
        }
      });

      test('an unavailable store embeds nothing and does not throw', async () => {
        await insertGroupRows('bf-down', 3);
        const embedded = withStore({ isAvailable: () => false });

        await maintainMemories('bf-down');

        expect(embedded).toEqual([]);
      });

      test('three consecutive embeds without a node stop the group early', async () => {
        await insertGroupRows('bf-fail', 20);
        const embedded = withStore({ failEmbeds: true });
        const info = spyOn(logger, 'info');

        await maintainMemories('bf-fail');

        expect(embedded).toHaveLength(3);
        expect(coverageLogs(info, 'memory_vector_backfill')).toEqual([
          expect.objectContaining({
            group_folder: 'bf-fail',
            attempted: 3,
            created: 0,
            stoppedEarly: true,
          }),
        ]);
        info.mockRestore();
      });

      test('rows invalidated or deleted before embedding are never embedded', async () => {
        await insertGroupRows('bf-gone', 3);
        const embedded = withStore();
        // Close the middle row and delete the last one between measure and embed.
        const find = getVectorStoreHooks()!.findExistingMemoryVectorIds!;
        setVectorStoreHooks({
          ...getVectorStoreHooks()!,
          findExistingMemoryVectorIds: async (ids) => {
            const result = await find(ids);
            if (ids.length === 3) {
              await invalidateMemory('bf-gone-001', new Date().toISOString());
              await drizzleDbRef.current
                .delete(memories)
                .where(eq(memories.id, 'bf-gone-002'));
            }
            return result;
          },
        });
        const info = spyOn(logger, 'info');

        await maintainMemories('bf-gone');

        expect(embedded).toEqual(['bf-gone-000']);
        expect(coverageLogs(info, 'memory_vector_backfill')).toEqual([
          expect.objectContaining({ attempted: 1, created: 1, skipped: 2 }),
        ]);
        info.mockRestore();
      });
    });

    test('an unavailable store is not queried', async () => {
      await drizzleDbRef.current.insert(memories).values([row('cov-1')]);
      let calls = 0;
      withFinder(
        async () => {
          calls++;
          return new Set();
        },
        () => false,
      );

      await maintainMemories(GROUP);

      expect(calls).toBe(0);
    });
  });

  test('dedup supersedes rather than erases the older duplicate', async () => {
    const older = await insertMemory({
      group_folder: GROUP,
      content: 'Production deploys run in the Madrid region nightly',
      memory_type: 'project',
      importance: 0.7,
      source: 'agent',
    });
    const keeper = await insertMemory({
      group_folder: GROUP,
      content: 'Production deploys run in the Madrid region nightly',
      memory_type: 'project',
      importance: 0.8,
      source: 'agent',
    });

    await maintainMemories(GROUP);

    expect((await getMemory(older.id))!.superseded_by).toBe(keeper.id);
    expect((await getMemory(older.id))!.valid_to).not.toBeNull();
    expect(await getMemory(keeper.id)).toBeDefined();
    expect(eraseCalls).toEqual([]);
    expect(invalidationCalls).toHaveLength(1);
    expect(invalidationCalls[0].id).toBe(older.id);
    expect((await getMemory(older.id))!.valid_to).toBe(
      invalidationCalls[0].effectiveAt,
    );
  });

  test('dedup never reopens a retained row superseded after the snapshot read', async () => {
    const base = {
      group_folder: GROUP,
      memory_type: 'project' as const,
      source: 'agent' as const,
    };
    const duplicate = await insertMemory({
      ...base,
      content: 'Deploy target is staging',
      importance: 0.7,
    });
    const retained = await insertMemory({
      ...base,
      content: 'Deploy target is staging',
      importance: 0.8,
    });
    // Archived during maintenance, after the snapshot read and before dedup.
    const bait = await insertMemory({
      ...base,
      content: 'Old low-value note',
      memory_type: 'event',
      importance: 0.05,
    });
    // An agent supersedes the retained row mid-maintenance.
    let newerId = '';
    onInvalidate = async (id) => {
      if (id !== bait.id) return;
      const newer = await insertMemory({
        ...base,
        content: 'Deploy target is production now',
        importance: 0.8,
      });
      newerId = newer.id;
      await supersedeMemory(retained.id, newer.id);
    };

    await maintainMemories(GROUP, { decayStatePath: path.join(decayDir, 's') });

    // The retained row stays closed; its stale open twin is closed onto the
    // same successor, so only the newer fact is current.
    expect((await getMemory(retained.id))!.superseded_by).toBe(newerId);
    expect((await getMemory(duplicate.id))!.superseded_by).toBe(newerId);
    expect(
      (await searchMemories({ groupFolders: [GROUP], skipTouch: true })).map(
        (m) => m.id,
      ),
    ).toEqual([newerId]);
    expect(invalidationCalls.map((c) => c.id)).toEqual([bait.id, duplicate.id]);
  });

  test('dedup does not supersede identical memories across objective scopes', async () => {
    const content = 'Production deploys run in the Madrid region nightly';
    const base = {
      group_folder: GROUP,
      content,
      memory_type: 'project' as const,
      importance: 0.7,
      source: 'agent' as const,
    };
    const projectWide = await insertMemory(base);
    const objectiveA = await insertMemory({ ...base, objective_id: 'obj-a' });
    const objectiveB = await insertMemory({ ...base, objective_id: 'obj-b' });

    await maintainMemories(GROUP);

    for (const m of [projectWide, objectiveA, objectiveB]) {
      expect((await getMemory(m.id))!.superseded_by).toBeNull();
    }
    expect(invalidationCalls).toEqual([]);
  });

  test('maintains every current row of a group with more than 1000 rows', async () => {
    const stamp = new Date().toISOString();
    const base = {
      group_folder: GROUP,
      importance: 0.5,
      source: 'agent',
      created_at: stamp,
      updated_at: stamp,
      last_accessed_at: stamp,
      access_count: 0,
    };
    await drizzleDbRef.current.insert(memories).values([
      ...Array.from({ length: 1001 }, (_, i) => ({
        ...base,
        id: `bulk-decision-${String(i).padStart(4, '0')}`,
        content: `unrelated decision number ${i} topic${i}x${i * 7}`,
        memory_type: 'decision',
      })),
      {
        ...base,
        id: 'zz-task-low-value',
        content: 'stale task nobody touched',
        memory_type: 'task',
        // Archived only after one day of decay (0.1005 * 0.99 < 0.1).
        importance: 0.1005,
        last_accessed_at: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const info = spyOn(logger, 'info');
    const now = Date.now();
    const statePath = path.join(decayDir, 'over-1000.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({ [GROUP]: new Date(now - 2 * 86400_000).toISOString() }),
    );

    await maintainMemories(GROUP, { now, decayStatePath: statePath });

    expect((await getMemory('zz-task-low-value'))!.valid_to).not.toBeNull();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ group_folder: GROUP, scanned: 1002 }),
      'Memory maintenance completed',
    );
    info.mockRestore();
  });

  test('dedup bucket larger than the cap compares only the newest rows and warns', async () => {
    const warn = spyOn(logger, 'warn');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const duplicate = i >= 3; // the two newest rows share content
      const m = await insertMemory({
        group_folder: GROUP,
        content: duplicate
          ? 'Production deploys run in the Madrid region nightly'
          : `Distinct legacy fact ${i} about zebra${i}q${i * 13}`,
        memory_type: 'project',
        importance: 0.7,
        source: 'agent',
      });
      await drizzleDbRef.current
        .update(memories)
        .set({
          created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
          // Distinct versions so the retained row is deterministic.
          updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        })
        .where(eq(memories.id, m.id));
      ids.push(m.id);
    }

    await maintainMemories(GROUP, { maxDedupBucket: 3 });

    expect((await getMemory(ids[3]))!.superseded_by).toBe(ids[4]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ group_folder: GROUP, size: 5, skipped: 2 }),
      'Memory maintenance dedup bucket truncated',
    );
    warn.mockRestore();
  });

  test('archives SQL history and queues graph invalidation during a Neo4j outage', async () => {
    const memory = await insertMemory({
      group_folder: GROUP,
      content: 'Old outage-safe temporal note',
      memory_type: 'event',
      importance: 0.05,
      source: 'agent',
    });
    setVectorStoreHooks({
      ...mockHooks,
      invalidateMemory: async () => {
        throw new Error('Neo4j unavailable');
      },
    });

    await maintainMemories(GROUP);

    expect((await getMemory(memory.id))?.valid_to).not.toBeNull();
    expect(await getPendingMemoryInvalidations()).toEqual([
      expect.objectContaining({ memory_id: memory.id }),
    ]);
    setVectorStoreHooks(mockHooks);
    await maintainMemories(GROUP);
    expect(await getPendingMemoryInvalidations()).toEqual([]);
  });
});

describe('memory importance decay', () => {
  const HOUR = 3600_000;

  test('decayedImportance applies grace, 1%/day and a 7-day cap', () => {
    expect(decayedImportance(0.8, 7, 1)).toBe(0.8);
    expect(decayedImportance(0.8, 30, 1)).toBe(0.792);
    expect(decayedImportance(0.8, 30, 100)).toBe(decayedImportance(0.8, 30, 7));
  });

  test('decays at most one daily step across hourly passes and keeps updated_at', async () => {
    const statePath = path.join(decayDir, 'hourly.json');
    const start = Date.now();
    const memory = await insertMemory({
      group_folder: GROUP,
      content: 'Architecture note nobody has read lately',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
    });
    await drizzleDbRef.current
      .update(memories)
      .set({
        last_accessed_at: new Date(start - 10 * 86400_000).toISOString(),
      })
      .where(eq(memories.id, memory.id));
    const before = (await getMemory(memory.id))!;

    // First-ever pass records the watermark and does not decay.
    await maintainMemories(GROUP, { now: start, decayStatePath: statePath });
    expect((await getMemory(memory.id))!.importance).toBe(0.8);

    for (let h = 1; h <= 24; h++) {
      await maintainMemories(GROUP, {
        now: start + h * HOUR,
        decayStatePath: statePath,
      });
    }

    const after = (await getMemory(memory.id))!;
    expect(after.importance).toBe(0.792);
    expect(after.updated_at).toBe(before.updated_at);
  });

  test('completion log reports decayDue, elapsedDays and pastGrace', async () => {
    const statePath = path.join(decayDir, 'log-fields.json');
    const group = GROUP;
    const start = Date.now();
    const memory = await insertMemory({
      group_folder: group,
      content: 'Stale design note for decay logging',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
    });
    await drizzleDbRef.current
      .update(memories)
      .set({
        last_accessed_at: new Date(start - 10 * 86400_000).toISOString(),
      })
      .where(eq(memories.id, memory.id));
    const info = spyOn(logger, 'info');
    const completed = () =>
      info.mock.calls
        .filter((c: unknown[]) => c[1] === 'Memory maintenance completed')
        .map((c: unknown[]) => c[0] as Record<string, unknown>);

    await maintainMemories(group, { now: start, decayStatePath: statePath });
    await maintainMemories(group, {
      now: start + 25 * HOUR,
      decayStatePath: statePath,
    });
    const logs = completed();
    info.mockRestore();

    expect(logs).toEqual([
      expect.objectContaining({
        decayDue: false,
        elapsedDays: null,
        pastGrace: 1,
        decayed: 0,
      }),
      expect.objectContaining({
        decayDue: true,
        elapsedDays: 1.04,
        pastGrace: 1,
        decayed: 1,
      }),
    ]);
  });
});
