/**
 * Unit tests for memorize / recall / forget tool handlers (mocked vector hooks).
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  spyOn,
} from 'bun:test';
import {
  initDatabase,
  insertMemory,
  insertSupersedingMemory,
  getMemory,
  getPendingMemoryErasures,
  getPendingMemoryInvalidations,
  createObjective,
  updateMemory,
  supersedeMemory,
  searchMemories,
} from '../../db.js';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { truncateTestDb } from '../../test-helpers.js';
import { memorizeTool, recallTool, forgetTool } from './tools.js';
import { orderVectorHitIds } from './backend/pg-backend.js';
import type { Memory } from './types.js';
import {
  setVectorStoreHooks,
  type VectorStoreHooks,
} from '../vector-store/hooks.js';
import { getAgentPermissions, type McpServerDeps } from '../../mcp/auth.js';
import type { RegisteredGroup } from '../../types.js';
import { dispatchToolCall } from '../tools/index.js';
import type { MemoryType } from './types.js';
import { maintainMemories } from './maintenance.js';
import { setExternalPrivacyErasureEnabled } from './privacy-erasure.js';
import type { GraphFact } from '../vector-store/graph-schema.js';
import {
  createPreviewMemoryState,
  type ReflectorMemoryExecutionContext,
} from './execution-context.js';
import {
  beginReflectorOperation,
  ensureReflectorRun,
  reflectorRequestFingerprint,
  reflectorResultMemoryId,
} from './reflector-state.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  memories,
  memoryReflectorOperations,
  memoryTranscriptEvidence,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { projects, tasks } from '../../db/schema.js';
import { sweepObserverCardMemories } from './open-card-reflection.js';

const GROUP = 'mem-tools-test';
const deps = {} as McpServerDeps;

function makeContext(
  overrides: {
    group_folder?: string;
    permissions?: Record<string, string[]>;
    memoryExecution?: ReflectorMemoryExecutionContext;
    task_id?: string;
    conversation_id?: string;
  } = {},
) {
  return {
    group_folder: overrides.group_folder ?? GROUP,
    permissions: overrides.permissions ?? {
      [GROUP]: ['memories:read', 'memories:write'],
    },
    memoryExecution: overrides.memoryExecution,
    task_id: overrides.task_id,
    conversation_id: overrides.conversation_id,
  };
}

function reflectorContext(
  mode: 'live' | 'preview',
): ReflectorMemoryExecutionContext {
  return {
    kind: 'reflector',
    mode,
    runId: `reflector-${mode}`,
    chunkKey: 'chunk-0',
    sourceRef: 'transcripts/chat-evidence.output.jsonl',
    evidence: new Map([
      [
        'message-1',
        {
          id: 'message-1',
          role: 'user' as const,
          createdAt: '2025-02-01T10:00:00.000Z',
          content: 'Production moved from Madrid to Berlin.',
        },
      ],
    ]),
    preview: mode === 'preview' ? createPreviewMemoryState() : undefined,
    hadToolError: false,
    completedOperationKeys: new Set(),
  };
}

function memFixture(content: string, memory_type: MemoryType = 'project') {
  return {
    group_folder: GROUP,
    content,
    memory_type,
    source: 'agent' as const,
  };
}

describe('memory tool handlers', () => {
  const embedCalls: { id: string; content: string }[] = [];
  const deleteCalls: string[] = [];
  const graphEraseCalls: Array<{ group: string; hashes: string[] }> = [];
  const invalidationCalls: Array<{ id: string; effectiveAt: string }> = [];
  let enhanceRecallCalls = 0;

  const mockHooks: VectorStoreHooks = {
    embedAndStore: async (id, _group, content) => {
      embedCalls.push({ id, content });
    },
    enhanceRecall: async () => {
      enhanceRecallCalls += 1;
      return null;
    },
    eraseMemory: async (id) => {
      deleteCalls.push(id);
    },
    invalidateMemory: async (id, effectiveAt) => {
      invalidationCalls.push({ id, effectiveAt });
    },
    eraseGraphFactsMatchingTarget: async (group, hashes) => {
      graphEraseCalls.push({ group, hashes });
    },
    upsertEntity: () => {},
    upsertRelation: async () => {},
    expandEntities: async () => null,
    isAvailable: () => true,
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
    embedCalls.length = 0;
    deleteCalls.length = 0;
    graphEraseCalls.length = 0;
    invalidationCalls.length = 0;
    enhanceRecallCalls = 0;
    setVectorStoreHooks(mockHooks);
    // The external privacy-erasure path (Neo4j, journals, sandbox, retry
    // queue) is gated behind ENABLE_EXTERNAL_PRIVACY_ERASURE. The forget /
    // [forgotten] tests below exercise that path, so enable it for each test
    // and restore the neutralized default (off) afterwards.
    setExternalPrivacyErasureEnabled(true);
  });

  afterEach(() => {
    setVectorStoreHooks(null!);
    setExternalPrivacyErasureEnabled(false);
  });

  describe('memorize', () => {
    test('reflector skips only references to open cards in its project', async () => {
      for (const id of [GROUP, 'other-project']) {
        await drizzleDbRef.current.insert(projects).values({
          id,
          jid: id,
          name: id,
          folder: id,
          trigger: '@bot',
          added_at: new Date().toISOString(),
        });
      }
      const now = new Date().toISOString();
      await drizzleDbRef.current.insert(tasks).values([
        {
          id: 'open',
          project_id: GROUP,
          title: 'Issue UTF-8 SHA-256',
          description: 'Audit B-379',
          status: 'backlog',
          created_at: now,
        },
        {
          id: 'done',
          project_id: GROUP,
          title: 'B-380',
          status: 'completed',
          created_at: now,
        },
        {
          id: 'archived',
          project_id: GROUP,
          title: 'B-381',
          status: 'backlog',
          archived: 1,
          created_at: now,
        },
        {
          id: 'foreign',
          project_id: 'other-project',
          title: 'B-382',
          status: 'backlog',
          created_at: now,
        },
      ]);
      const execution = reflectorContext('live');
      const write = (content: string, key: string) =>
        memorizeTool.handler(
          {
            operation: 'create',
            content,
            memory_type: 'project',
            operation_key: key,
            evidence: [
              { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
            ],
          },
          deps,
          makeContext({ memoryExecution: execution }),
        );
      expect(await write('The issue was filed (B-379).', 'skip')).toContain(
        'Not stored: restates open card open (B-379)',
      );
      expect(await write('A fixed issue (B-380).', 'done')).toContain(
        'create completed',
      );
      expect(await write('An archived issue (B-381).', 'archived')).toContain(
        'create completed',
      );
      expect(await write('A foreign issue (B-382).', 'foreign')).toContain(
        'create completed',
      );
      expect(
        await write('Audit issue without a reference', 'no-ref'),
      ).toContain('create completed');
      expect(
        await write('UTF-8 and SHA-256 need care (D-958).', 'body'),
      ).toContain('create completed');
      expect(
        (
          await searchMemories({
            groupFolders: [GROUP],
            limit: 20,
            skipTouch: true,
          })
        ).length,
      ).toBe(5);
      expect(
        await memorizeTool.handler(
          {
            content: 'Explicit agent decision (B-379)',
            memory_type: 'project',
          },
          deps,
          makeContext(),
        ),
      ).toMatch(/memorized/i);
    });

    test('sweep invalidates recent observer memory and preserves old history', async () => {
      await drizzleDbRef.current.insert(projects).values({
        id: GROUP,
        jid: GROUP,
        name: GROUP,
        folder: GROUP,
        trigger: '@bot',
        added_at: new Date().toISOString(),
      });
      await drizzleDbRef.current.insert(tasks).values({
        id: 'audit',
        project_id: GROUP,
        title: 'Audit B-118',
        status: 'backlog',
        created_at: new Date().toISOString(),
      });
      const recent = await insertMemory({
        ...memFixture('Recent audit (B-118)'),
        source: 'observer',
        sourceRef: 'conversations/live.jsonl',
      });
      const old = await insertMemory({
        ...memFixture('Older audit (B-118)'),
        source: 'observer',
        sourceRef: 'conversations/live.jsonl',
      });
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const oldAt = new Date(Date.now() - 30 * 3600_000).toISOString();
      await drizzleDbRef.current
        .update(memories)
        .set({ created_at: hourAgo, updated_at: hourAgo })
        .where(eq(memories.id, recent.id));
      await drizzleDbRef.current
        .update(memories)
        .set({ created_at: oldAt, updated_at: oldAt })
        .where(eq(memories.id, old.id));
      await sweepObserverCardMemories(GROUP);
      expect((await getMemory(recent.id))?.valid_to).toBeTruthy();
      expect((await getMemory(old.id))?.valid_to).toBeNull();
    });

    test('stores memory and embeds', async () => {
      const result = await memorizeTool.handler(
        {
          content: 'Deploy runs on GKE in production',
          memory_type: 'project',
        },
        deps,
        makeContext(),
      );
      expect(result).toMatch(/memorized/i);
      expect(embedCalls).toHaveLength(1);
      expect(embedCalls[0].content).toContain('GKE');
    });

    test('rejects create/supersede content over 400 characters without writing', async () => {
      const tooLong = 'a'.repeat(401);
      await expect(
        memorizeTool.handler(
          { content: ` ${tooLong} `, memory_type: 'project' },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(
        'Memory content is 401 characters; the limit is 400. Store one idea in one or two plain sentences, or split it into separate memories.',
      );
      await expect(
        memorizeTool.handler(
          {
            operation: 'supersede',
            content: tooLong,
            memory_type: 'project',
            memory_id: 'missing',
            expected_version: 'x',
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow('the limit is 400');
      expect(
        await searchMemories({ groupFolders: [GROUP], skipTouch: true }),
      ).toHaveLength(0);

      await memorizeTool.handler(
        { content: 'a'.repeat(400), memory_type: 'project' },
        deps,
        makeContext(),
      );
      expect(
        await searchMemories({ groupFolders: [GROUP], skipTouch: true }),
      ).toHaveLength(1);
    });

    test('defaults agent sourceRef from task or conversation; explicit wins', async () => {
      const write = (content: string, ctx = {}, sourceRef?: string) =>
        memorizeTool.handler(
          { content, memory_type: 'project', sourceRef },
          deps,
          makeContext(ctx),
        );
      await write('From a task run', { task_id: 't1', conversation_id: 'c1' });
      await write('From a chat run', { conversation_id: 'c1' });
      await write('Explicit ref kept', { task_id: 't1' }, 'my-ref');
      const stored = await searchMemories({
        groupFolders: [GROUP],
        skipTouch: true,
      });
      const refOf = (text: string) =>
        stored.find((m) => m.content === text)?.sourceRef;
      expect(refOf('From a task run')).toBe('task:t1');
      expect(refOf('From a chat run')).toBe('conversation:c1');
      expect(refOf('Explicit ref kept')).toBe('my-ref');
    });

    test('parses a JSON-encoded tags string into clean tags', async () => {
      await memorizeTool.handler(
        {
          content: 'Tags arrive JSON-encoded from LLM callers',
          memory_type: 'decision',
          tags: '["x","y"]',
        },
        deps,
        makeContext(),
      );

      const stored = await searchMemories({
        groupFolders: [GROUP],
        skipTouch: true,
      });
      expect(stored).toHaveLength(1);
      expect(stored[0].tags).toEqual(['x', 'y']);
    });

    test('stores a caller-provided validFrom timestamp', async () => {
      const validFrom = '2024-02-03T04:05:06.000Z';
      const validFromWithOffset = '2024-02-03T05:05:06.000+01:00';

      await memorizeTool.handler(
        {
          content: 'The production region changed to Madrid',
          memory_type: 'decision',
          validFrom: validFromWithOffset,
        },
        deps,
        makeContext(),
      );

      const stored = await searchMemories({
        groupFolders: [GROUP],
        asOf: validFrom,
        skipTouch: true,
      });
      expect(stored).toHaveLength(1);
      expect(stored[0].valid_from).toBe(validFrom);
    });

    test('rejects future validFrom/effectiveAt beyond the skew and leaves the prior row current', async () => {
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const nearFuture = new Date(Date.now() + 60 * 1000).toISOString();
      await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Staging runs in Oslo',
          memory_type: 'project',
        },
        deps,
        makeContext(),
      );
      const [prior] = await searchMemories({
        groupFolders: [GROUP],
        skipTouch: true,
      });
      const base = {
        memory_type: 'project',
        memory_id: prior.id,
        expected_version: prior.updated_at,
      };

      await expect(
        memorizeTool.handler(
          {
            operation: 'create',
            content: 'Future create',
            memory_type: 'project',
            validFrom: future,
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/validFrom must not be more than 5 minutes/);
      await expect(
        memorizeTool.handler(
          {
            ...base,
            operation: 'supersede',
            content: 'Staging runs in Bergen',
            validFrom: future,
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/validFrom must not be more than 5 minutes/);
      await expect(
        memorizeTool.handler(
          { ...base, operation: 'invalidate', effectiveAt: future },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/effectiveAt must not be more than 5 minutes/);

      const current = await searchMemories({
        groupFolders: [GROUP],
        skipTouch: true,
      });
      expect(current.map((m) => m.id)).toEqual([prior.id]);
      expect(current[0].valid_to).toBeNull();

      await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Near-future create',
          memory_type: 'project',
          validFrom: nearFuture,
        },
        deps,
        makeContext(),
      );
    });

    test('agent explicit temporal writes default validFrom and effectiveAt to now', async () => {
      const before = Date.now();
      await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Staging runs in Oslo',
          memory_type: 'project',
        },
        deps,
        makeContext(),
      );
      const [created] = await searchMemories({
        groupFolders: [GROUP],
        skipTouch: true,
      });
      expect(Math.abs(Date.parse(created.valid_from!) - before)).toBeLessThan(
        5_000,
      );

      await memorizeTool.handler(
        {
          operation: 'supersede',
          content: 'Staging runs in Bergen',
          memory_type: 'project',
          memory_id: created.id,
          expected_version: created.updated_at,
        },
        deps,
        makeContext(),
      );
      const closed = (await getMemory(created.id))!;
      const replacement = (
        await searchMemories({ groupFolders: [GROUP], skipTouch: true })
      ).find((memory) => memory.content === 'Staging runs in Bergen')!;
      expect(closed.valid_to).toBe(replacement.valid_from);

      await memorizeTool.handler(
        {
          operation: 'invalidate',
          memory_id: replacement.id,
          expected_version: replacement.updated_at,
        },
        deps,
        makeContext(),
      );
      expect((await getMemory(replacement.id))!.valid_to).not.toBeNull();
    });

    test('rejects importance outside 0–1', async () => {
      await expect(
        memorizeTool.handler(
          { content: 'Bad importance', memory_type: 'task', importance: 5 },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/between 0 and 1/);
    });

    test('merges duplicate when importance is higher and re-embeds', async () => {
      const existing = await insertMemory(
        memFixture('user likes dark roast coffee every morning', 'preference'),
      );
      const result = await memorizeTool.handler(
        {
          content: 'user likes dark roast coffee every morning',
          memory_type: 'preference',
          importance: 0.95,
        },
        deps,
        makeContext(),
      );
      expect(result).toMatch(/merged/i);
      expect(embedCalls).toHaveLength(1);
      expect(embedCalls[0].id).toBe(existing.id);
    });

    test('retains duplicate when importance is not higher', async () => {
      const existing = await insertMemory(
        memFixture('immutable preference fact for testing', 'preference'),
      );
      await updateImportance(existing.id, 0.9);
      const result = await memorizeTool.handler(
        {
          content: 'immutable preference fact for testing',
          memory_type: 'preference',
          importance: 0.2,
        },
        deps,
        makeContext(),
      );
      expect(result).toMatch(/retained/i);
      expect(embedCalls).toHaveLength(0);
    });

    test('explicit create recognizes a stronger duplicate without rewriting it', async () => {
      const original = await insertMemory({
        ...memFixture('Production deploys run in Madrid'),
        importance: 0.4,
      });

      const result = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Production deploys run in Madrid',
          memory_type: 'project',
          importance: 0.9,
          validFrom: '2025-01-01T00:00:00.000Z',
        },
        deps,
        makeContext(),
      );

      expect(result).toContain(original.id);
      expect((await getMemory(original.id))?.importance).toBe(0.4);
      expect(
        await searchMemories({ groupFolders: [GROUP], limit: 10 }),
      ).toHaveLength(1);
    });

    test('create rejects missing and foreign-project objective scopes before writing', async () => {
      const foreignObjective = await createObjective({
        project_id: 'another-project',
        title: 'Foreign objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });

      await expect(
        memorizeTool.handler(
          {
            operation: 'create',
            content: 'A fact with a missing objective',
            memory_type: 'project',
            objective_id: 'obj-missing',
            validFrom: '2025-01-01T00:00:00.000Z',
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/Objective "obj-missing".*not found/);
      await expect(
        memorizeTool.handler(
          {
            operation: 'create',
            content: 'A fact with a foreign objective',
            memory_type: 'project',
            objective_id: foreignObjective.id,
            validFrom: '2025-01-01T00:00:00.000Z',
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/does not belong to project "mem-tools-test"/);

      expect(
        await searchMemories({ groupFolders: [GROUP], limit: 10 }),
      ).toEqual([]);
      expect(embedCalls).toEqual([]);
    });

    test('supersede rejects missing and foreign-project objective scopes before writing', async () => {
      const foreignObjective = await createObjective({
        project_id: 'another-project',
        title: 'Foreign objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const invalidObjectiveIds = ['obj-missing', foreignObjective.id];

      for (const objectiveId of invalidObjectiveIds) {
        const previous = await insertMemory({
          ...memFixture(`Original fact for ${objectiveId}`),
          valid_from: '2024-01-01T00:00:00.000Z',
        });

        await expect(
          memorizeTool.handler(
            {
              operation: 'supersede',
              content: `Replacement fact for ${objectiveId}`,
              memory_type: 'project',
              objective_id: objectiveId,
              memory_id: previous.id,
              expected_version: previous.updated_at,
              validFrom: '2025-01-01T00:00:00.000Z',
            },
            deps,
            makeContext(),
          ),
        ).rejects.toThrow(
          objectiveId === 'obj-missing'
            ? /Objective "obj-missing".*not found/
            : /does not belong to project "mem-tools-test"/,
        );
        expect(await getMemory(previous.id)).toMatchObject({
          valid_to: null,
          superseded_by: null,
        });
      }

      expect(embedCalls).toEqual([]);
    });

    test('agent supersede keeps the target scope and rejects a differing objective_id', async () => {
      const objectives = await Promise.all(
        ['one', 'two'].map((title) =>
          createObjective({
            project_id: GROUP,
            title: `Scope ${title}`,
            description: '',
            status: 'active',
            priority: 0,
            progress: 0,
          }),
        ),
      );
      const [objA, objB] = objectives;
      const supersede = (
        previous: { id: string; updated_at: string },
        objective_id?: string,
      ) =>
        memorizeTool.handler(
          {
            operation: 'supersede',
            content: 'Replacement fact',
            memory_type: 'project',
            memory_id: previous.id,
            expected_version: previous.updated_at,
            validFrom: '2025-01-01T00:00:00.000Z',
            ...(objective_id ? { objective_id } : {}),
          },
          deps,
          makeContext(),
        );
      const replacementOf = async (result: string) =>
        (await getMemory(result.match(/superseded by ([^.]+)/)![1]))!;

      const projectWide = await insertMemory({
        ...memFixture('Project-wide fact'),
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      await expect(supersede(projectWide, objA.id)).rejects.toThrow(
        /belongs to the project-wide scope.*omit objective_id/,
      );
      expect(await getMemory(projectWide.id)).toMatchObject({
        valid_to: null,
        superseded_by: null,
      });

      const scoped = await insertMemory({
        ...memFixture('Scoped fact'),
        objective_id: objA.id,
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      await expect(supersede(scoped, objB.id)).rejects.toThrow(
        new RegExp(`belongs to objective "${objA.id}"`),
      );
      expect(await getMemory(scoped.id)).toMatchObject({ valid_to: null });
      expect(
        (await replacementOf(await supersede(scoped, objA.id))).objective_id,
      ).toBe(objA.id);

      expect(
        (await replacementOf(await supersede(projectWide))).objective_id,
      ).toBeNull();
    });

    test('reflector dispatch recovers an invalid objective with the same operation key', async () => {
      const memoryExecution = reflectorContext('preview');
      const context = makeContext({ memoryExecution });
      const args = {
        operation: 'create' as const,
        content: 'Production moved to Berlin',
        memory_type: 'event' as const,
        validFrom: '2025-01-31T12:00:00.000Z',
        operation_key: 'message-1-production-region',
        evidence: [
          {
            message_id: 'message-1',
            excerpt: 'Production moved from Madrid to Berlin',
          },
        ],
      };

      const rejected = await dispatchToolCall(
        'memorize',
        { ...args, objective_id: 'obj-missing' },
        deps,
        context,
      );
      expect(rejected).toContain('No write was made');
      expect(rejected).toContain('retry the same operation_key');
      expect(memoryExecution.pendingEvidenceErrors).toEqual(
        new Set(['memorize:message-1-production-region']),
      );
      expect(memoryExecution.preview?.operations.size).toBe(0);

      const corrected = await dispatchToolCall('memorize', args, deps, context);
      expect(corrected).toMatch(/Preview staged memory/);
      expect(memoryExecution.hadToolError).toBe(false);
      expect(memoryExecution.hadOtherToolError).toBeUndefined();
      expect(memoryExecution.pendingEvidenceErrors).toEqual(new Set());
      expect(memoryExecution.completedOperationKeys).toContain(
        'chunk-0:message-1-production-region',
      );
      expect(memoryExecution.preview?.operations.size).toBe(1);
    });

    test('reflector supersede validates evidence and retries without duplication', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      const memoryExecution = reflectorContext('live');
      const args = {
        operation: 'supersede',
        content: 'Production runs in Berlin',
        memory_type: 'project',
        memory_id: previous.id,
        expected_version: previous.updated_at,
        validFrom: '2025-02-01T10:00:00.000Z',
        operation_key: 'message-1-production-region',
        evidence: [
          {
            message_id: 'message-1',
            excerpt: 'moved from Madrid to Berlin',
          },
        ],
      };

      const first = await memorizeTool.handler(
        args,
        deps,
        makeContext({ memoryExecution }),
      );
      const retry = await memorizeTool.handler(
        args,
        deps,
        makeContext({ memoryExecution }),
      );

      expect(first).toMatch(/supersede completed/);
      expect(retry).toMatch(/already completed/);
      const historical = await searchMemories({
        groupFolders: [GROUP],
        asOf: '2024-06-01T00:00:00.000Z',
        limit: 10,
      });
      const current = await searchMemories({
        groupFolders: [GROUP],
        limit: 10,
      });
      expect(historical.map((memory) => memory.content)).toEqual([
        'Production runs in Madrid',
      ]);
      expect(current.map((memory) => memory.content)).toEqual([
        'Production runs in Berlin',
      ]);
    });

    test('stale reflector transition can retry with the same operation key', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      await updateMemory(previous.id, { importance: 0.9 });
      await drizzleDbRef.current
        .update(memories)
        .set({
          updated_at: new Date(
            Date.parse(previous.updated_at) + 1_000,
          ).toISOString(),
        })
        .where(eq(memories.id, previous.id));
      const memoryExecution = reflectorContext('live');
      const args = {
        operation: 'invalidate' as const,
        memory_id: previous.id,
        expected_version: previous.updated_at,
        effectiveAt: '2025-02-01T10:00:00.000Z',
        operation_key: 'message-1-close-production-region',
        evidence: [
          {
            message_id: 'message-1',
            excerpt: 'moved from Madrid to Berlin',
          },
        ],
      };

      await expect(
        memorizeTool.handler(args, deps, makeContext({ memoryExecution })),
      ).rejects.toThrow(/changed concurrently/);
      expect(
        await drizzleDbRef.current.select().from(memoryReflectorOperations),
      ).toEqual([]);

      const current = (await getMemory(previous.id))!;
      const retried = await memorizeTool.handler(
        { ...args, expected_version: current.updated_at },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(retried).toMatch(/invalidate completed/);
      expect(await getMemory(previous.id)).toMatchObject({
        valid_to: args.effectiveAt,
      });
      expect(
        await drizzleDbRef.current.select().from(memoryReflectorOperations),
      ).toHaveLength(1);
    });

    test('stale reflector invalidate cannot recover through a different operation key', async () => {
      const inserted = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      // updated_at has millisecond resolution: backdate it so the first
      // invalidate always produces a new version, even on a fast machine.
      await drizzleDbRef.current
        .update(memories)
        .set({ updated_at: '2024-01-01T00:00:00.000Z' })
        .where(eq(memories.id, inserted.id));
      const previous = (await getMemory(inserted.id))!;
      const memoryExecution = reflectorContext('live');
      const baseArgs = {
        operation: 'invalidate' as const,
        memory_id: previous.id,
        expected_version: previous.updated_at,
        effectiveAt: '2025-02-01T10:00:00.000Z',
        evidence: [
          {
            message_id: 'message-1',
            excerpt: 'moved from Madrid to Berlin',
          },
        ],
      };

      expect(
        await memorizeTool.handler(
          { ...baseArgs, operation_key: 'first-invalidate' },
          deps,
          makeContext({ memoryExecution }),
        ),
      ).toMatch(/invalidate completed/);
      await expect(
        memorizeTool.handler(
          { ...baseArgs, operation_key: 'different-invalidate' },
          deps,
          makeContext({ memoryExecution }),
        ),
      ).rejects.toThrow(/changed concurrently/);

      expect(
        await drizzleDbRef.current.select().from(memoryReflectorOperations),
      ).toHaveLength(1);
    });

    test('reflector supersede closes a backdated replacement in secondary storage', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2025-02-01T10:00:00.000Z',
      });
      const current = await insertMemory({
        ...memFixture('Production runs in Lisbon'),
        valid_from: '2025-04-01T00:00:00.000Z',
      });
      await supersedeMemory(previous.id, current.id, current.valid_from!);
      const closedPrevious = (await getMemory(previous.id))!;
      const memoryExecution = reflectorContext('live');
      const operationKey = 'message-1-production-region-backdated';
      const replacementId = reflectorResultMemoryId(
        memoryExecution.runId,
        `${memoryExecution.chunkKey}:${operationKey}`,
      );

      await memorizeTool.handler(
        {
          operation: 'supersede',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          memory_id: previous.id,
          expected_version: closedPrevious.updated_at,
          validFrom: '2025-03-01T00:00:00.000Z',
          operation_key: operationKey,
          evidence: [
            {
              message_id: 'message-1',
              excerpt: 'moved from Madrid to Berlin',
            },
          ],
        },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(await getMemory(replacementId)).toMatchObject({
        valid_to: current.valid_from,
        superseded_by: current.id,
      });
      expect(invalidationCalls).toEqual([
        { id: previous.id, effectiveAt: '2025-03-01T00:00:00.000Z' },
        { id: replacementId, effectiveAt: current.valid_from! },
      ]);
    });

    test('reflector recovery restores both backdated graph boundaries', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2025-02-01T10:00:00.000Z',
      });
      const current = await insertMemory({
        ...memFixture('Production runs in Lisbon'),
        valid_from: '2025-04-01T00:00:00.000Z',
      });
      await supersedeMemory(previous.id, current.id, current.valid_from!);
      const closedPrevious = (await getMemory(previous.id))!;
      const memoryExecution = reflectorContext('live');
      const operationKey = 'chunk-0:recover-backdated-region';
      const replacementId = reflectorResultMemoryId(
        memoryExecution.runId,
        operationKey,
      );
      const evidence = [
        { message_id: 'message-1', excerpt: 'moved from Madrid to Berlin' },
      ];
      const requestFingerprint = reflectorRequestFingerprint({
        operation: 'supersede',
        content: 'Production runs in Berlin',
        memory_type: 'project',
        importance: undefined,
        objective_id: null,
        tags: undefined,
        validFrom: '2025-03-01T00:00:00.000Z',
        effectiveAt: undefined,
        memoryId: previous.id,
        expectedVersion: closedPrevious.updated_at,
        evidence,
      });
      await ensureReflectorRun({
        id: memoryExecution.runId,
        projectId: GROUP,
        transcriptPath: memoryExecution.sourceRef,
        transcriptFingerprint: 'recover-backdated-region',
        byteOffset: 0,
        profile: 'run-agent-conversation',
        mode: 'live',
        totalChunks: 1,
      });
      await beginReflectorOperation({
        runId: memoryExecution.runId,
        operationKey,
        requestFingerprint,
        operation: 'supersede',
        targetMemoryId: previous.id,
        resultMemoryId: replacementId,
      });
      await insertSupersedingMemory({
        id: replacementId,
        targetMemoryId: previous.id,
        groupFolder: GROUP,
        expectedVersion: closedPrevious.updated_at,
        effectiveAt: '2025-03-01T00:00:00.000Z',
        content: 'Production runs in Berlin',
        memoryType: 'project',
        objectiveId: null,
        source: 'observer',
        sourceRef: memoryExecution.sourceRef,
      });
      expect(await getPendingMemoryInvalidations()).toEqual(
        expect.arrayContaining([
          {
            memory_id: previous.id,
            effective_at: '2025-03-01T00:00:00.000Z',
          },
          {
            memory_id: replacementId,
            effective_at: current.valid_from!,
          },
        ]),
      );
      invalidationCalls.length = 0;

      const result = await memorizeTool.handler(
        {
          operation: 'supersede',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          memory_id: previous.id,
          expected_version: closedPrevious.updated_at,
          validFrom: '2025-03-01T00:00:00.000Z',
          operation_key: 'recover-backdated-region',
          evidence,
        },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(result).toMatch(/Recovered completed supersede/);
      expect(invalidationCalls).toEqual([
        { id: previous.id, effectiveAt: '2025-03-01T00:00:00.000Z' },
        { id: replacementId, effectiveAt: current.valid_from! },
      ]);
    });

    test('correcting evidence clears only the matching rejected write without duplicating previews', async () => {
      const memoryExecution = reflectorContext('preview');
      const context = makeContext({ memoryExecution });
      const args = {
        operation: 'create',
        content: 'Production runs in Berlin',
        memory_type: 'project',
        validFrom: '2025-02-01T10:00:00.000Z',
        evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
      };
      const invalidQuote = await dispatchToolCall(
        'memorize',
        {
          ...args,
          operation_key: 'quote',
          evidence: [
            { message_id: 'message-1', excerpt: 'invented quotation' },
          ],
        },
        deps,
        context,
      );
      expect(invalidQuote).toContain('not verbatim');
      expect(invalidQuote).toContain('retry the same operation_key');
      expect(
        await dispatchToolCall(
          'memorize',
          {
            ...args,
            operation_key: 'scope',
            evidence: [
              { message_id: 'other-chunk', excerpt: 'Madrid to Berlin' },
            ],
          },
          deps,
          context,
        ),
      ).toContain('not in this reflector chunk');
      expect(memoryExecution.preview!.operations.size).toBe(0);

      const invalidDate = await dispatchToolCall(
        'memorize',
        {
          ...args,
          operation_key: 'date',
          validFrom: 'not-a-date',
        },
        deps,
        context,
      );
      expect(invalidDate).toContain('Invalid ISO datetime');
      expect(invalidDate).toContain('validFrom');
      expect(invalidDate).toContain('retry the same operation_key');
      await dispatchToolCall(
        'memorize',
        { ...args, operation_key: 'date' },
        deps,
        context,
      );

      await dispatchToolCall(
        'memorize',
        { ...args, operation_key: 'unrelated' },
        deps,
        context,
      );
      expect(memoryExecution.hadToolError).toBe(true);
      await dispatchToolCall(
        'memorize',
        { ...args, operation_key: 'quote' },
        deps,
        context,
      );
      expect(memoryExecution.hadToolError).toBe(true);
      expect(memoryExecution.toolErrors).toHaveLength(1);
      await dispatchToolCall(
        'memorize',
        { ...args, operation_key: 'scope' },
        deps,
        context,
      );
      expect(memoryExecution.hadToolError).toBe(false);
      expect(memoryExecution.toolErrors).toEqual([]);
      const stagedCount = memoryExecution.preview!.operations.size;
      await dispatchToolCall(
        'memorize',
        { ...args, operation_key: 'scope' },
        deps,
        context,
      );
      expect(memoryExecution.preview!.operations.size).toBe(stagedCount);
      expect(await searchMemories({ groupFolders: [GROUP] })).toEqual([]);
    });

    test('classifies a not-verbatim excerpt without echoing transcript text', async () => {
      const memoryExecution = reflectorContext('preview');
      const base = {
        id: 'entry:text-2',
        role: 'assistant' as const,
        createdAt: '2025-02-01T10:00:00.000Z',
      };
      memoryExecution.evidence.set('entry:text-1', {
        ...base,
        id: 'entry:text-1',
        content: 'Quarterly plan: ship the billing rewrite by March.',
      });
      memoryExecution.evidence.set('entry:text-2', {
        ...base,
        content: 'Reviewed the staging deployment notes carefully today.',
        nonTextContent: 'policy: rotate-every-90-days',
      });
      // Holds the billing sentence too (so it lives in two other blocks) plus a
      // sentence that lives in exactly one other block.
      memoryExecution.evidence.set('entry2:text-1', {
        ...base,
        id: 'entry2:text-1',
        content:
          'Quarterly plan: ship the billing rewrite by March. Also audit the vendor contracts.',
      });
      const attempt = (excerpt: string, key: string, id = 'entry:text-2') =>
        dispatchToolCall(
          'memorize',
          {
            operation: 'create',
            content: `A fact ${key}`,
            memory_type: 'project',
            operation_key: key,
            evidence: [{ message_id: id, excerpt }],
          },
          deps,
          makeContext({ memoryExecution }),
        );
      const infoSpy = spyOn(logger, 'info');
      try {
        const cases: Array<[string, string, RegExp]> = [
          ['invented unrelated wording', 'paraphrase', /matches no text/],
          [
            'ship the billing rewrite by March',
            'other_block',
            /different message/i,
          ],
          ['rotate-every-90-days', 'non_text', /Tool output and file contents/],
          [
            'Reviewed the staging ... carefully today.',
            'truncated',
            /shortened or extended/,
          ],
          [
            'Reviewed the staging deployment notes carefully today, ok',
            'truncated',
            /shortened or extended/,
          ],
        ];
        for (const [excerpt, klass, hint] of cases) {
          const result = await attempt(
            excerpt,
            `op-${klass}-${excerpt.length}`,
          );
          expect(result).toContain(
            `divergence: ${klass}; cited block length: 54 chars`,
          );
          expect(result).toMatch(hint);
          expect(result).not.toContain(excerpt);
        }
        for (const [call] of infoSpy.mock.calls) {
          const serialized = JSON.stringify(call);
          expect(serialized).not.toContain('rotate-every');
          expect(serialized).not.toContain('billing');
        }
        expect(
          infoSpy.mock.calls.map(
            ([call]) => (call as any).evidenceDivergenceClass,
          ),
        ).toEqual([
          'paraphrase',
          'other_block',
          'non_text',
          'truncated',
          'truncated',
        ]);
      } finally {
        infoSpy.mockRestore();
      }

      // Unchanged accept path: a verbatim excerpt is still staged.
      const accepted = await attempt('staging deployment notes', 'op-accept');
      expect(accepted).not.toContain('Error:');
      expect(memoryExecution.preview!.operations.size).toBe(1);

      // Verbatim in exactly one other block: re-attributed to that block, for an
      // exact cited key and for a bare entry id.
      const infoSpy2 = spyOn(logger, 'info');
      try {
        const exact = await attempt('audit the vendor contracts', 'op-exact');
        const bare = await attempt(
          'audit the vendor contracts',
          'op-bare',
          'entry',
        );
        expect(exact).not.toContain('Error:');
        expect(bare).not.toContain('Error:');
        const staged = [...memoryExecution.preview!.operations.values()];
        expect(staged).toHaveLength(3);
        expect(staged.slice(1).map((op) => op.evidence)).toEqual([
          [
            {
              message_id: 'entry2:text-1',
              excerpt: 'audit the vendor contracts',
            },
          ],
          [
            {
              message_id: 'entry2:text-1',
              excerpt: 'audit the vendor contracts',
            },
          ],
        ]);
        const reattributed = infoSpy2.mock.calls
          .map(([call]) => call as any)
          .filter((call) => call.evidenceReattributed);
        expect(reattributed).toEqual([
          { evidenceReattributed: true, citedKind: 'exact' },
          { evidenceReattributed: true, citedKind: 'bare' },
        ]);
      } finally {
        infoSpy2.mockRestore();
      }

      // A bare id whose single block lacks the excerpt gets the classified
      // error, never "not in this reflector chunk"; several blocks get the
      // entry-level error.
      const single = await attempt(
        'invented unrelated wording',
        'op-s',
        'entry2',
      );
      expect(single).toContain('not verbatim (divergence: paraphrase');
      expect(single).not.toContain('not in this reflector chunk');
      const several = await attempt(
        'invented unrelated wording',
        'op-m',
        'entry',
      );
      expect(several).toContain('not verbatim in any block of that entry');
      expect(several).not.toContain('not in this reflector chunk');
    });

    test('corrected evidence cannot clear an unrelated permission failure', async () => {
      const memoryExecution = reflectorContext('preview');
      const context = makeContext({ memoryExecution });
      const args = {
        operation: 'create',
        operation_key: 'correctable',
        content: 'Production runs in Berlin',
        memory_type: 'project',
        validFrom: '2025-02-01T10:00:00.000Z',
      };
      await dispatchToolCall(
        'memorize',
        {
          ...args,
          evidence: [
            { message_id: 'message-1', excerpt: 'invented quotation' },
          ],
        },
        deps,
        context,
      );
      await expect(
        dispatchToolCall('recall', {}, deps, {
          ...context,
          permissions: { [GROUP]: ['memories:write'] },
        }),
      ).rejects.toThrow('Unauthorized');
      await dispatchToolCall(
        'memorize',
        {
          ...args,
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        context,
      );
      expect(memoryExecution.pendingEvidenceErrors?.size).toBe(0);
      expect(memoryExecution.hadToolError).toBe(true);
      expect(memoryExecution.toolErrors?.map((entry) => entry.tool)).toEqual([
        'recall',
      ]);
    });

    test('reflector retains a historical validity date before later evidence', async () => {
      const memoryExecution = reflectorContext('live');
      const result = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          validFrom: '2025-01-31T10:00:00.000Z',
          operation_key: 'historical-before-report',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(result).toMatch(/create completed/);
      expect(memoryExecution.hadToolError).toBe(false);
      expect(
        await searchMemories({
          groupFolders: [GROUP],
          asOf: '2025-02-01T00:00:00.000Z',
        }),
      ).toMatchObject([
        {
          content: 'Production runs in Berlin',
          valid_from: '2025-01-31T10:00:00.000Z',
        },
      ]);
    });

    test('does not resurrect an erased result from a pending create receipt', async () => {
      const memoryExecution = reflectorContext('live');
      const operationKey = 'chunk-0:erased-create';
      const resultMemoryId = reflectorResultMemoryId(
        memoryExecution.runId,
        operationKey,
      );
      await insertMemory({
        id: resultMemoryId,
        ...memFixture('Production runs in Berlin'),
        source: 'observer',
        sourceRef: memoryExecution.sourceRef,
        valid_from: '2025-02-01T10:00:00.000Z',
      });
      await ensureReflectorRun({
        id: memoryExecution.runId,
        projectId: GROUP,
        transcriptPath: memoryExecution.sourceRef,
        transcriptFingerprint: 'privacy-retry',
        byteOffset: 0,
        profile: 'run-agent-conversation',
        mode: 'live',
        totalChunks: 1,
      });
      const evidence = [
        { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
      ];
      await beginReflectorOperation({
        runId: memoryExecution.runId,
        operationKey,
        requestFingerprint: reflectorRequestFingerprint({
          operation: 'create',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          importance: undefined,
          objective_id: null,
          tags: undefined,
          validFrom: '2025-02-01T10:00:00.000Z',
          effectiveAt: undefined,
          memoryId: undefined,
          expectedVersion: undefined,
          evidence,
        }),
        operation: 'create',
        resultMemoryId,
      });

      await forgetTool.handler(
        { memory_id: resultMemoryId, reason: 'privacy request' },
        deps,
        makeContext(),
      );
      const retried = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'erased-create',
          evidence,
        },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(retried).toMatch(/deliberately erased/);
      expect(await getMemory(resultMemoryId)).toBeUndefined();
    });

    test('tombstones the resolved duplicate when evidence persistence fails', async () => {
      const existing = await insertMemory({
        ...memFixture('Production runs in Berlin'),
        valid_from: '2025-02-01T10:00:00.000Z',
      });
      const memoryExecution = reflectorContext('live');
      await ensureReflectorRun({
        id: memoryExecution.runId,
        projectId: GROUP,
        transcriptPath: memoryExecution.sourceRef,
        transcriptFingerprint: 'duplicate-privacy-retry',
        byteOffset: 0,
        profile: 'run-agent-conversation',
        mode: 'live',
        totalChunks: 1,
      });
      const args = {
        operation: 'create',
        content: 'Production runs in Berlin',
        memory_type: 'project',
        validFrom: '2025-02-01T10:00:00.000Z',
        operation_key: 'duplicate-evidence-failure',
        evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
      } as const;
      const deterministicId = reflectorResultMemoryId(
        memoryExecution.runId,
        'chunk-0:duplicate-evidence-failure',
      );
      const database = drizzleDbRef.current as any;
      const originalInsert = database.insert;
      database.insert = function (table: unknown) {
        if (table === memoryTranscriptEvidence) {
          throw new Error('simulated evidence persistence failure');
        }
        return originalInsert.call(this, table);
      };
      try {
        await expect(
          memorizeTool.handler(args, deps, makeContext({ memoryExecution })),
        ).rejects.toThrow(/simulated evidence persistence failure/);
      } finally {
        database.insert = originalInsert;
      }

      await forgetTool.handler(
        { memory_id: existing.id, reason: 'privacy request' },
        deps,
        makeContext(),
      );
      const retried = await memorizeTool.handler(
        args,
        deps,
        makeContext({ memoryExecution }),
      );

      expect(retried).toMatch(/deliberately erased/);
      expect(await getMemory(existing.id)).toBeUndefined();
      expect(await getMemory(deterministicId)).toBeUndefined();
    });

    test('explicit temporal writes reject stale versions and impossible dates', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2025-01-01T00:00:00.000Z',
      });
      await updateMemory(previous.id, { importance: 0.8 });
      await drizzleDbRef.current
        .update(memories)
        .set({
          updated_at: new Date(
            Date.parse(previous.updated_at) + 1_000,
          ).toISOString(),
        })
        .where(eq(memories.id, previous.id));

      await expect(
        memorizeTool.handler(
          {
            operation: 'invalidate',
            memory_id: previous.id,
            expected_version: previous.updated_at,
            effectiveAt: '2025-02-01T00:00:00.000Z',
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/changed concurrently/);

      const current = (await getMemory(previous.id))!;
      await expect(
        memorizeTool.handler(
          {
            operation: 'invalidate',
            memory_id: current.id,
            expected_version: current.updated_at,
            effectiveAt: '2024-12-31T00:00:00.000Z',
          },
          deps,
          makeContext(),
        ),
      ).rejects.toThrow(/cannot precede/);
    });

    test('explicit supersede closes a backdated replacement in secondary storage', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2025-01-01T00:00:00.000Z',
      });
      const current = await insertMemory({
        ...memFixture('Production runs in Lisbon'),
        valid_from: '2025-04-01T00:00:00.000Z',
      });
      await supersedeMemory(previous.id, current.id, current.valid_from!);
      const closedPrevious = (await getMemory(previous.id))!;

      const result = await memorizeTool.handler(
        {
          operation: 'supersede',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          memory_id: previous.id,
          expected_version: closedPrevious.updated_at,
          validFrom: '2025-03-01T00:00:00.000Z',
        },
        deps,
        makeContext(),
      );
      const replacementId = result.match(/superseded by ([^.]+)/)?.[1];

      expect(replacementId).toBeTruthy();
      expect(await getMemory(replacementId!)).toMatchObject({
        valid_to: current.valid_from,
        superseded_by: current.id,
      });
      expect(invalidationCalls).toEqual([
        { id: previous.id, effectiveAt: '2025-03-01T00:00:00.000Z' },
        { id: replacementId!, effectiveAt: current.valid_from! },
      ]);
    });

    test('preview recall sees staged writes without touching live storage', async () => {
      const memoryExecution = reflectorContext('preview');
      const createArgs = {
        operation: 'create',
        content: 'Production runs in Berlin',
        memory_type: 'project',
        validFrom: '2025-02-01T10:00:00.000Z',
        operation_key: 'preview-berlin',
        evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
      } as const;
      const staged = await memorizeTool.handler(
        createArgs,
        deps,
        makeContext({ memoryExecution }),
      );
      expect(
        await memorizeTool.handler(
          createArgs,
          deps,
          makeContext({ memoryExecution }),
        ),
      ).toMatch(/already staged/);
      const stagedId = staged.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];
      const recalled = await recallTool.handler(
        { query: 'Berlin', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(stagedId).toBeTruthy();
      expect(recalled.memories.map((memory: any) => memory.id)).toContain(
        stagedId,
      );
      const duplicate = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'preview-berlin-equivalent',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(duplicate).toMatch(/Duplicate detected/);
      expect(await getMemory(stagedId!)).toBeUndefined();
      expect([...memoryExecution.preview!.operations.values()]).toEqual([
        expect.objectContaining({
          operation: 'create',
          resultMemoryId: stagedId,
          validFrom: '2025-02-01T10:00:00.000Z',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        }),
      ]);
    });

    test('preview supersede inherits the target tags when none are given', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        tags: ['infra', 'region'],
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      const memoryExecution = reflectorContext('preview');
      const result = await memorizeTool.handler(
        {
          operation: 'supersede',
          content: 'Production runs in Berlin',
          memory_type: 'project',
          memory_id: previous.id,
          expected_version: previous.updated_at,
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'preview-inherit-tags',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const id = result.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];

      expect(memoryExecution.preview!.memories.get(id!)?.tags).toEqual([
        'infra',
        'region',
      ]);
    });

    describe('recall hiddenScopedCount', () => {
      const args = { query: 'brain deploy containers', limit: 10 };
      async function seedScopedMemory() {
        const objective = await createObjective({
          project_id: GROUP,
          title: 'Scoped deploy',
          description: '',
          status: 'active',
          priority: 0,
          progress: 0,
        });
        const scoped = await insertMemory({
          ...memFixture('Brain service deploy builds all containers'),
          objective_id: objective.id,
        });
        return { objective, scoped };
      }

      test('reports the hidden scoped match when objective_id is omitted', async () => {
        await seedScopedMemory();
        const omitted = await recallTool.handler(args, deps, makeContext());
        expect(omitted.memories).toEqual([]);
        expect(omitted.hiddenScopedCount).toBe(1);
      });

      test('returns the scoped memory without the field when objective_id is passed', async () => {
        const { objective, scoped } = await seedScopedMemory();
        const scopedRecall = await recallTool.handler(
          { ...args, objective_id: objective.id },
          deps,
          makeContext(),
        );
        expect(scopedRecall.memories.map((row: any) => row.id)).toContain(
          scoped.id,
        );
        expect('hiddenScopedCount' in scopedRecall).toBe(false);
      });

      test('labels each recalled memory with its objective scope', async () => {
        const { objective, scoped } = await seedScopedMemory();
        const wide = await insertMemory(
          memFixture('Brain service deploy uses project-wide containers'),
        );
        const scopedRecall = await recallTool.handler(
          { ...args, objective_id: objective.id },
          deps,
          makeContext(),
        );
        const scopeById = new Map(
          scopedRecall.memories.map((row: any) => [row.id, row.objective_id]),
        );
        expect(scopeById.get(scoped.id)).toBe(objective.id);
        expect(scopeById.get(wide.id)).toBeNull();

        const unscoped = await recallTool.handler(args, deps, makeContext());
        expect(unscoped.memories.map((row: any) => row.id)).toEqual([wide.id]);
        expect(unscoped.memories[0].objective_id).toBeNull();
      });

      describe('reflector evidence objective default', () => {
        function evidenceContext(
          mode: 'live' | 'preview',
          objectiveIds: Array<string | null>,
        ) {
          const context = reflectorContext(mode);
          context.evidence = new Map(
            objectiveIds.map((objectiveId, index) => [
              `message-${index}`,
              {
                id: `message-${index}`,
                role: 'user' as const,
                createdAt: '2025-02-01T10:00:00.000Z',
                content: 'Brain deploy',
                objectiveId,
              },
            ]),
          );
          return context;
        }
        const ids = (result: any) => result.memories.map((row: any) => row.id);

        test.each(['live', 'preview'] as const)(
          'defaults to the single evidence objective (%s)',
          async (mode) => {
            const { objective, scoped } = await seedScopedMemory();
            const wide = await insertMemory(
              memFixture('Brain service deploy uses project-wide containers'),
            );
            const result = await recallTool.handler(
              args,
              deps,
              makeContext({
                memoryExecution: evidenceContext(mode, [
                  objective.id,
                  objective.id,
                ]),
              }),
            );
            expect(ids(result)).toEqual(
              expect.arrayContaining([scoped.id, wide.id]),
            );
            expect('hiddenScopedCount' in result).toBe(false);
          },
        );

        test('leaves mixed-scope evidence unchanged', async () => {
          const { objective } = await seedScopedMemory();
          for (const scopes of [
            [objective.id, null],
            [objective.id, 'obj-other'],
          ]) {
            const result = await recallTool.handler(
              args,
              deps,
              makeContext({
                memoryExecution: evidenceContext('live', scopes),
              }),
            );
            expect(result.memories).toEqual([]);
            expect(result.hiddenScopedCount).toBe(1);
          }
        });

        test('leaves non-reflector callers unchanged', async () => {
          await seedScopedMemory();
          const result = await recallTool.handler(args, deps, makeContext());
          expect(result.memories).toEqual([]);
          expect(result.hiddenScopedCount).toBe(1);
        });

        test('an explicit objective_id wins', async () => {
          const { objective, scoped } = await seedScopedMemory();
          const result = await recallTool.handler(
            { ...args, objective_id: 'obj-explicit' },
            deps,
            makeContext({
              memoryExecution: evidenceContext('live', [objective.id]),
            }),
          );
          expect(ids(result)).not.toContain(scoped.id);
          expect('hiddenScopedCount' in result).toBe(false);
        });
      });

      test('omits the field in preview mode', async () => {
        await seedScopedMemory();
        const preview = await recallTool.handler(
          args,
          deps,
          makeContext({ memoryExecution: reflectorContext('preview') }),
        );
        expect('hiddenScopedCount' in preview).toBe(false);
      });
    });

    test('preview recall preserves live objective visibility for staged rows', async () => {
      const objective = await createObjective({
        project_id: GROUP,
        title: 'Scoped deployment',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const scopedLive = await insertMemory({
        ...memFixture('Objective-only deployment secret'),
        objective_id: objective.id,
      });
      const memoryExecution = reflectorContext('preview');

      const unscopedBefore = await recallTool.handler(
        { query: 'deployment secret', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );
      expect(unscopedBefore.memories).toEqual([]);

      const scopedBefore = await recallTool.handler(
        {
          query: 'deployment secret',
          objective_id: objective.id,
          limit: 10,
        },
        deps,
        makeContext({ memoryExecution }),
      );
      expect(scopedBefore.memories.map((row: any) => row.id)).toContain(
        scopedLive.id,
      );

      const staged = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Objective-only deployment decision',
          memory_type: 'decision',
          objective_id: objective.id,
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'preview-objective-decision',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const stagedId = staged.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];

      expect(
        (
          await recallTool.handler(
            { query: 'deployment decision', limit: 10 },
            deps,
            makeContext({ memoryExecution }),
          )
        ).memories,
      ).toEqual([]);
      expect(
        (
          await recallTool.handler(
            {
              query: 'deployment decision',
              objective_id: objective.id,
              limit: 10,
            },
            deps,
            makeContext({ memoryExecution }),
          )
        ).memories.map((row: any) => row.id),
      ).toContain(stagedId);
      expect(memoryExecution.preview!.memories.get(stagedId!)).toMatchObject({
        objective_id: objective.id,
      });
    });

    test('reflector infers an unambiguous objective scope from transcript evidence', async () => {
      const objective = await createObjective({
        project_id: GROUP,
        title: 'Scoped deployment',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const memoryExecution = reflectorContext('preview');
      memoryExecution.evidence.get('message-1')!.objectiveId = objective.id;

      const result = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Production deploys run in Berlin',
          memory_type: 'decision',
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'objective-scoped-create',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const stagedId = result.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];

      expect(memoryExecution.preview!.memories.get(stagedId!)).toMatchObject({
        objective_id: objective.id,
      });
      expect(
        [...memoryExecution.preview!.operations.values()][0],
      ).toMatchObject({ objectiveId: objective.id });
    });

    describe('reflector objective_id null (project-wide)', () => {
      const scopedObjective = () =>
        createObjective({
          project_id: GROUP,
          title: 'Scoped deployment',
          description: '',
          status: 'active',
          priority: 0,
          progress: 0,
        });
      const createNull = (
        memoryExecution: ReturnType<typeof reflectorContext>,
        memory_type: string,
        operation_key = 'null-scope-create',
      ) =>
        memorizeTool.handler(
          {
            operation: 'create',
            content: 'The user prefers Python scripts',
            memory_type,
            objective_id: null,
            validFrom: '2025-02-01T10:00:00.000Z',
            operation_key,
            evidence: [
              { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
            ],
          },
          deps,
          makeContext({ memoryExecution }),
        );

      test.each(['preference', 'identity', 'contact'])(
        'stores %s project-wide from objective evidence',
        async (memoryType) => {
          const objective = await scopedObjective();
          const memoryExecution = reflectorContext('preview');
          memoryExecution.evidence.get('message-1')!.objectiveId = objective.id;

          const result = await createNull(memoryExecution, memoryType);
          const stagedId = result.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];

          expect(
            memoryExecution.preview!.memories.get(stagedId!)!.objective_id,
          ).toBeNull();
        },
      );

      test('rejects other memory types and stages nothing', async () => {
        const objective = await scopedObjective();
        const memoryExecution = reflectorContext('preview');
        memoryExecution.evidence.get('message-1')!.objectiveId = objective.id;

        await expect(createNull(memoryExecution, 'decision')).rejects.toThrow(
          /only for creating user identity, preference or contact/,
        );
        expect(memoryExecution.preview!.memories.size).toBe(0);
        expect(memoryExecution.preview!.operations.size).toBe(0);
      });

      test('rejects null without authoritative evidence metadata', async () => {
        const memoryExecution = reflectorContext('preview');
        memoryExecution.evidence.get('message-1')!.objectiveId = undefined;

        await expect(createNull(memoryExecution, 'preference')).rejects.toThrow(
          /authoritative objective metadata/,
        );
        expect(memoryExecution.preview!.operations.size).toBe(0);
      });

      test('rejects null on supersede from objective evidence', async () => {
        const objective = await scopedObjective();
        const memoryExecution = reflectorContext('preview');
        memoryExecution.evidence.get('message-1')!.objectiveId = objective.id;

        await expect(
          memorizeTool.handler(
            {
              operation: 'supersede',
              content: 'The user prefers Python scripts',
              memory_type: 'preference',
              objective_id: null,
              memory_id: 'mem-any',
              expected_version: '2025-01-01T00:00:00.000Z',
              validFrom: '2025-02-01T10:00:00.000Z',
              operation_key: 'null-scope-supersede',
              evidence: [
                { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
              ],
            },
            deps,
            makeContext({ memoryExecution }),
          ),
        ).rejects.toThrow(/only for creating user identity/);
        expect(memoryExecution.preview!.operations.size).toBe(0);
      });
    });

    test('reflector rejects an objective scope conflicting with transcript evidence', async () => {
      const evidenceObjective = await createObjective({
        project_id: GROUP,
        title: 'Evidence objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const requestedObjective = await createObjective({
        project_id: GROUP,
        title: 'Different objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const memoryExecution = reflectorContext('preview');
      memoryExecution.evidence.get('message-1')!.objectiveId =
        evidenceObjective.id;

      await expect(
        memorizeTool.handler(
          {
            operation: 'create',
            content: 'Production deploys run in Berlin',
            memory_type: 'decision',
            objective_id: requestedObjective.id,
            validFrom: '2025-02-01T10:00:00.000Z',
            operation_key: 'wrong-objective-create',
            evidence: [
              { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
            ],
          },
          deps,
          makeContext({ memoryExecution }),
        ),
      ).rejects.toThrow(/conflicts with supporting transcript evidence/);
      expect(memoryExecution.preview!.operations.size).toBe(0);
    });

    test('reflector rejects evidence spanning multiple objective scopes', async () => {
      const firstObjective = await createObjective({
        project_id: GROUP,
        title: 'First evidence objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const secondObjective = await createObjective({
        project_id: GROUP,
        title: 'Second evidence objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });
      const memoryExecution = reflectorContext('preview');
      memoryExecution.evidence.get('message-1')!.objectiveId =
        firstObjective.id;
      memoryExecution.evidence.set('message-2', {
        id: 'message-2',
        role: 'user',
        createdAt: '2025-02-01T10:00:00.000Z',
        content: 'Production deploys require a signed manifest.',
        objectiveId: secondObjective.id,
      });

      await expect(
        memorizeTool.handler(
          {
            operation: 'create',
            content: 'Production deploys run in Berlin with signed manifests',
            memory_type: 'decision',
            validFrom: '2025-02-01T10:00:00.000Z',
            operation_key: 'mixed-objective-create',
            evidence: [
              { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
              { message_id: 'message-2', excerpt: 'signed manifest' },
            ],
          },
          deps,
          makeContext({ memoryExecution }),
        ),
      ).rejects.toThrow(/evidence spans multiple objective scopes/);
      expect(memoryExecution.preview!.operations.size).toBe(0);
    });

    test('reflector temporal transitions preserve memories outside the evidence objective in live and preview modes', async () => {
      const objective = await createObjective({
        project_id: GROUP,
        title: 'Scoped production rollout',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
      });

      for (const mode of ['live', 'preview'] as const) {
        const projectWide = await insertMemory({
          ...memFixture(`Project-wide production region for ${mode}`),
          valid_from: '2025-01-01T00:00:00.000Z',
        });
        const memoryExecution = reflectorContext(mode);
        memoryExecution.runId = `objective-transition-${mode}`;
        memoryExecution.evidence.get('message-1')!.objectiveId = objective.id;
        const evidence = [
          { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
        ];

        await expect(
          memorizeTool.handler(
            {
              operation: 'supersede',
              memory_id: projectWide.id,
              expected_version: projectWide.updated_at,
              content: 'This objective deploys production in Berlin',
              memory_type: 'decision',
              validFrom: '2025-02-01T10:00:00.000Z',
              operation_key: `${mode}-cross-scope-supersede`,
              evidence,
            },
            deps,
            makeContext({ memoryExecution }),
          ),
        ).rejects.toThrow(/Retain the existing memory.*operation "create"/);
        await expect(
          memorizeTool.handler(
            {
              operation: 'invalidate',
              memory_id: projectWide.id,
              expected_version: projectWide.updated_at,
              effectiveAt: '2025-02-01T10:00:00.000Z',
              operation_key: `${mode}-cross-scope-invalidate`,
              evidence,
            },
            deps,
            makeContext({ memoryExecution }),
          ),
        ).rejects.toThrow(/same objective scope/);

        expect(await getMemory(projectWide.id)).toMatchObject({
          objective_id: null,
          valid_to: null,
          superseded_by: null,
        });
        expect(memoryExecution.preview?.operations.size ?? 0).toBe(0);
      }
    });

    test('preview recall keeps a matching staged write inside a full result window', async () => {
      const live = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          insertMemory(
            memFixture(
              `Shared preview boundary live fact ${index} for component ${String.fromCharCode(97 + index)}`,
            ),
          ),
        ),
      );
      const memoryExecution = reflectorContext('preview');
      const staged = await memorizeTool.handler(
        {
          operation: 'create',
          content: 'Shared preview boundary staged deployment decision',
          memory_type: 'project',
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'preview-full-window',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const stagedId = staged.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];

      const recalled = await recallTool.handler(
        { query: 'Shared preview boundary', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(recalled.memories).toHaveLength(10);
      expect(recalled.memories[0]?.id).toBe(stagedId);
      expect(
        recalled.memories.filter((memory: any) =>
          live.some((item) => item.id === memory.id),
        ),
      ).toHaveLength(9);
      expect(await getMemory(stagedId!)).toBeUndefined();
    });

    test('preview transitions share one effective temporal view and remain isolated', async () => {
      const previous = await insertMemory({
        ...memFixture('Production runs in Madrid'),
        valid_from: '2025-01-01T00:00:00.000Z',
      });
      const memoryExecution = reflectorContext('preview');
      const evidence = [
        { message_id: 'message-1', excerpt: 'Madrid to Berlin' },
      ];

      const initial = await recallTool.handler(
        { query: 'Production Madrid', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );
      const initialVersion = initial.memories.find(
        (memory: any) => memory.id === previous.id,
      )!.updated;
      const superseded = await memorizeTool.handler(
        {
          operation: 'supersede',
          memory_id: previous.id,
          expected_version: initialVersion,
          content: 'Production runs in Berlin',
          memory_type: 'project',
          validFrom: '2025-02-01T10:00:00.000Z',
          operation_key: 'preview-move',
          evidence,
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const replacementId = superseded.match(/(mem-ref-[A-Za-z0-9_-]+)/)?.[1];

      const afterSupersede = await recallTool.handler(
        { query: 'Production', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );
      const replacement = afterSupersede.memories.find(
        (memory: any) => memory.id === replacementId,
      );
      expect(replacement).toBeDefined();
      expect(
        afterSupersede.memories.map((memory: any) => memory.id),
      ).not.toContain(previous.id);

      const beforeMove = await recallTool.handler(
        {
          query: 'Production',
          asOf: '2025-01-15T00:00:00.000Z',
          limit: 10,
        },
        deps,
        makeContext({ memoryExecution }),
      );
      expect(beforeMove.memories.map((memory: any) => memory.id)).toContain(
        previous.id,
      );
      expect(beforeMove.memories.map((memory: any) => memory.id)).not.toContain(
        replacementId,
      );

      await memorizeTool.handler(
        {
          operation: 'invalidate',
          memory_id: replacementId,
          expected_version: replacement.updated,
          effectiveAt: '2025-03-01T00:00:00.000Z',
          operation_key: 'preview-close',
          evidence,
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const afterInvalidation = await recallTool.handler(
        { query: 'Berlin', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );
      const duringReplacement = await recallTool.handler(
        {
          query: 'Berlin',
          asOf: '2025-02-15T00:00:00.000Z',
          limit: 10,
        },
        deps,
        makeContext({ memoryExecution }),
      );
      expect(afterInvalidation.memories).toEqual([]);
      expect(
        duringReplacement.memories.map((memory: any) => memory.id),
      ).toContain(replacementId);

      const forgetArgs = {
        memory_id: previous.id,
        operation_key: 'preview-erase-old',
        evidence,
      };
      await forgetTool.handler(
        forgetArgs,
        deps,
        makeContext({ memoryExecution }),
      );
      expect(
        await forgetTool.handler(
          forgetArgs,
          deps,
          makeContext({ memoryExecution }),
        ),
      ).toMatch(/already staged/);
      const afterErasure = await recallTool.handler(
        {
          query: 'Production',
          asOf: '2025-01-15T00:00:00.000Z',
          limit: 10,
        },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(afterErasure.memories).toEqual([]);
      expect([...memoryExecution.preview!.operations.values()]).toHaveLength(3);
      expect(await getMemory(previous.id)).toMatchObject({
        valid_to: null,
        superseded_by: null,
      });
      expect(await getMemory(replacementId!)).toBeUndefined();
    });

    test('preview recall hides graph facts from a staged erasure', async () => {
      const memory = await insertMemory(
        memFixture('Marta leads the Berlin deployment'),
      );
      setVectorStoreHooks({
        ...mockHooks,
        enhanceRecall: async () => [{ id: memory.id, score: 0.99 }],
        expandEntities: async () => [
          {
            subject: 'Marta',
            relation: 'WORKS_ON',
            object: 'Berlin',
            sourceMemoryId: memory.id,
          },
        ],
      });
      const memoryExecution = reflectorContext('preview');

      await forgetTool.handler(
        {
          memory_id: memory.id,
          operation_key: 'preview-forget-berlin',
          evidence: [{ message_id: 'message-1', excerpt: 'Madrid to Berlin' }],
        },
        deps,
        makeContext({ memoryExecution }),
      );
      const recalled = await recallTool.handler(
        { query: 'Marta Berlin deployment', limit: 10 },
        deps,
        makeContext({ memoryExecution }),
      );

      expect(recalled.memories).toEqual([]);
      expect(recalled.related).toBeUndefined();
      expect((await getMemory(memory.id))?.access_count).toBe(0);
      expect([...memoryExecution.preview!.operations.values()]).toEqual([
        expect.objectContaining({
          operation: 'forget',
          memoryId: memory.id,
          targetContent: 'Marta leads the Berlin deployment',
        }),
      ]);
    });

    test('denies write without permission', async () => {
      await expect(
        memorizeTool.handler(
          { content: 'Secret', memory_type: 'project' },
          deps,
          makeContext({ permissions: { [GROUP]: ['memories:read'] } }),
        ),
      ).rejects.toThrow(/Unauthorized/);
    });

    describe('project_id', () => {
      const base = {
        trigger: '@Capa',
        added_at: '2026-09-20T00:00:00.000Z',
      };
      const projects: Record<string, RegisteredGroup> = {
        main: {
          ...base,
          name: 'Main',
          folder: 'pid-main',
          is_main: true,
          user_id: 'pid-owner',
        },
        parent: {
          ...base,
          name: 'Parent',
          folder: 'pid-parent',
          settings: { isParent: true },
        },
        child: {
          ...base,
          name: 'Child',
          folder: 'pid-child',
          parentId: 'pid-parent',
        },
        sibling: { ...base, name: 'Sibling', folder: 'pid-sibling' },
        reader: {
          ...base,
          name: 'Reader',
          folder: 'pid-reader',
          settings: { memorySourceProjects: ['pid-child'] },
        },
      };
      const projectDeps = {
        getRegisteredGroups: () => projects,
      } as unknown as McpServerDeps;
      // The main's owner reaches the child; `pid-ghost` stands for a project
      // deleted after the token was minted.
      const mainReach = ['pid-child', 'pid-ghost'].map((folder) => ({
        folder,
        readOnly: false,
      }));
      const contextFor = (key: keyof typeof projects) => ({
        group_folder: projects[key].folder,
        permissions: getAgentPermissions(
          projects[key],
          projects,
          key === 'main' ? mainReach : undefined,
        ),
      });
      const stored = (folder: string) =>
        searchMemories({ groupFolders: [folder], limit: 10, skipTouch: true });

      test('main writes into another project and recalls it from there', async () => {
        const args = {
          content: 'Child project deploys on Fridays',
          memory_type: 'project',
          project_id: 'pid-child',
        };
        // The dispatch gate checks only the caller's own folder; main passes it.
        const result = await dispatchToolCall(
          'memorize',
          args,
          projectDeps,
          contextFor('main'),
        );
        expect(result).toMatch(/memorized/i);
        expect(await stored('pid-main')).toHaveLength(0);
        expect(await stored('pid-child')).toHaveLength(1);

        const recalled = await recallTool.handler(
          { query: 'deploys Fridays' },
          projectDeps,
          contextFor('main'),
        );
        expect(JSON.stringify(recalled)).toContain('pid-child');
      });

      test('parent writes to its child but not to a sibling or an unknown project', async () => {
        const parent = contextFor('parent');
        await memorizeTool.handler(
          {
            content: 'Child fact',
            memory_type: 'project',
            project_id: 'pid-child',
          },
          projectDeps,
          parent,
        );
        expect(await stored('pid-child')).toHaveLength(1);

        await expect(
          memorizeTool.handler(
            {
              content: 'Sibling fact',
              memory_type: 'project',
              project_id: 'pid-sibling',
            },
            projectDeps,
            parent,
          ),
        ).rejects.toThrow(/missing memories:write permission.*pid-sibling/);
        expect(await stored('pid-sibling')).toHaveLength(0);

        await expect(
          memorizeTool.handler(
            {
              content: 'Ghost fact',
              memory_type: 'project',
              project_id: 'pid-ghost',
            },
            projectDeps,
            contextFor('main'),
          ),
        ).rejects.toThrow(/Project "pid-ghost" not found/);
        expect(await stored('pid-ghost')).toHaveLength(0);
      });

      test('standard and read-only-source callers are denied; own folder is unchanged', async () => {
        for (const caller of ['sibling', 'reader'] as const) {
          await expect(
            memorizeTool.handler(
              {
                content: 'Cross-project fact',
                memory_type: 'project',
                project_id: 'pid-child',
              },
              projectDeps,
              contextFor(caller),
            ),
          ).rejects.toThrow(/missing memories:write permission.*pid-child/);
        }
        expect(await stored('pid-child')).toHaveLength(0);

        await memorizeTool.handler(
          {
            content: 'Own folder fact',
            memory_type: 'project',
            project_id: ' pid-sibling ',
          },
          projectDeps,
          contextFor('sibling'),
        );
        expect(await stored('pid-sibling')).toHaveLength(1);
      });

      test('objective and supersede/invalidate targets must belong to the target project', async () => {
        const childObjective = await createObjective({
          project_id: 'pid-child',
          title: 'Child objective',
          description: '',
          status: 'active',
          priority: 0,
          progress: 0,
        });
        await memorizeTool.handler(
          {
            content: 'Scoped child fact',
            memory_type: 'project',
            project_id: 'pid-child',
            objective_id: childObjective.id,
          },
          projectDeps,
          contextFor('main'),
        );
        const scoped = await searchMemories({
          groupFolders: ['pid-child'],
          objective_id: childObjective.id,
          skipTouch: true,
        });
        expect(scoped.map((m) => m.objective_id)).toContain(childObjective.id);
        // The objective belongs to pid-child, not to the caller's own project.
        await expect(
          memorizeTool.handler(
            {
              content: 'Wrong project objective',
              memory_type: 'project',
              objective_id: childObjective.id,
            },
            projectDeps,
            contextFor('main'),
          ),
        ).rejects.toThrow(/does not belong to project "pid-main"/);

        const mainMemory = await insertMemory({
          ...memFixture('Main-owned fact'),
          group_folder: 'pid-main',
          valid_from: '2024-01-01T00:00:00.000Z',
        });
        const childMemory = await insertMemory({
          ...memFixture('Child-owned fact'),
          group_folder: 'pid-child',
          valid_from: '2024-01-01T00:00:00.000Z',
        });
        const transition = (memory: typeof mainMemory, operation: string) => ({
          operation,
          content: 'Replacement',
          memory_type: 'project',
          project_id: 'pid-child',
          memory_id: memory.id,
          expected_version: memory.updated_at,
          validFrom: '2025-01-01T00:00:00.000Z',
          effectiveAt: '2025-01-01T00:00:00.000Z',
        });
        for (const operation of ['supersede', 'invalidate']) {
          await expect(
            memorizeTool.handler(
              transition(mainMemory, operation),
              projectDeps,
              contextFor('main'),
            ),
          ).rejects.toThrow(/does not belong to project "pid-child"/);
        }
        expect(await getMemory(mainMemory.id)).toMatchObject({
          valid_to: null,
          superseded_by: null,
        });
        await memorizeTool.handler(
          transition(childMemory, 'supersede'),
          projectDeps,
          contextFor('main'),
        );
        expect((await getMemory(childMemory.id))?.superseded_by).toBeTruthy();
      });
    });
  });

  describe('recall', () => {
    test('validates limit as an integer >= 1 and still accepts a future asOf', () => {
      const schema = z.object(recallTool.inputSchema);
      expect(schema.safeParse({ limit: -1 }).success).toBe(false);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 2.5 }).success).toBe(false);
      expect(schema.safeParse({ limit: 2000 }).success).toBe(true);
      expect(schema.parse({}).limit).toBe(10);
      expect(
        schema.safeParse({ asOf: '2999-01-01T00:00:00.000Z' }).success,
      ).toBe(true);
    });

    test('returns temporal validity and provenance for every memory', async () => {
      const old = await insertMemory({
        ...memFixture('The support rota owner was Marta', 'project'),
        source: 'observer',
        sourceRef: 'conversation-42',
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      const current = await insertMemory({
        ...memFixture('The support rota owner is João', 'project'),
        source: 'user',
        sourceRef: 'task-99',
        valid_from: '2024-04-01T00:00:00.000Z',
      });
      await supersedeMemory(old.id, current.id, current.valid_from!);

      const historical = await recallTool.handler(
        {
          query: 'support rota owner',
          asOf: '2024-03-01T00:00:00.000Z',
          limit: 5,
        },
        deps,
        makeContext(),
      );
      const present = await recallTool.handler(
        { query: 'support rota owner', limit: 5 },
        deps,
        makeContext(),
      );

      expect(historical.memories).toContainEqual(
        expect.objectContaining({
          id: old.id,
          validFrom: '2024-01-01T00:00:00.000Z',
          validTo: '2024-04-01T00:00:00.000Z',
          source: 'observer',
          sourceRef: 'conversation-42',
        }),
      );
      expect(present.memories).toContainEqual(
        expect.objectContaining({
          id: current.id,
          validFrom: '2024-04-01T00:00:00.000Z',
          validTo: null,
          source: 'user',
          sourceRef: 'task-99',
        }),
      );
      expect(
        present.memories.some((m: { id: string }) => m.id === old.id),
      ).toBe(false);
    });

    test('keyword and vector-assisted recall share historical validity', async () => {
      const old = await insertMemory({
        ...memFixture('Deployment region was Barcelona', 'project'),
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      const next = await insertMemory({
        ...memFixture('Deployment region is Madrid', 'project'),
        valid_from: '2024-04-01T00:00:00.000Z',
      });
      await supersedeMemory(old.id, next.id, next.valid_from!);

      setVectorStoreHooks({
        ...mockHooks,
        enhanceRecall: async () => [{ id: old.id, score: 0.99 }],
      });

      const historical = await recallTool.handler(
        {
          query: 'deployment region',
          asOf: '2024-03-01T00:00:00.000Z',
          limit: 5,
        },
        deps,
        makeContext(),
      );
      const current = await recallTool.handler(
        { query: 'deployment region', limit: 5 },
        deps,
        makeContext(),
      );

      expect(
        historical.memories.some((m: { id: string }) => m.id === old.id),
      ).toBe(true);
      expect(
        historical.memories.some((m: { id: string }) => m.id === next.id),
      ).toBe(false);
      expect(
        current.memories.some((m: { id: string }) => m.id === old.id),
      ).toBe(false);
      expect(
        current.memories.some((m: { id: string }) => m.id === next.id),
      ).toBe(true);
    });

    test('graph provenance uses the same asOf validity window', async () => {
      const old = await insertMemory({
        ...memFixture('Marta led the Barcelona deployment', 'project'),
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      const next = await insertMemory({
        ...memFixture('Marta leads the Madrid deployment', 'project'),
        valid_from: '2024-04-01T00:00:00.000Z',
      });
      await supersedeMemory(old.id, next.id, next.valid_from!);

      setVectorStoreHooks({
        ...mockHooks,
        enhanceRecall: async () => [
          { id: old.id, score: 0.99 },
          { id: next.id, score: 0.98 },
        ],
        expandEntities: async () => [
          {
            subject: 'Marta',
            relation: 'WORKS_ON',
            object: 'Barcelona',
            sourceMemoryId: old.id,
          },
          {
            subject: 'Marta',
            relation: 'WORKS_ON',
            object: 'Madrid',
            sourceMemoryId: next.id,
          },
        ],
      });

      const historical = await recallTool.handler(
        {
          query: 'Marta deployment',
          asOf: '2024-03-01T00:00:00.000Z',
          limit: 5,
        },
        deps,
        makeContext(),
      );
      const current = await recallTool.handler(
        { query: 'Marta deployment', limit: 5 },
        deps,
        makeContext(),
      );

      expect(
        historical.related?.map((f: GraphFact) => f.sourceMemoryId),
      ).toEqual([old.id]);
      expect(current.related?.map((f: GraphFact) => f.sourceMemoryId)).toEqual([
        next.id,
      ]);
    });

    test('scopes results to groups with read permission', async () => {
      await insertMemory(
        memFixture('Allowed group kubernetes fact', 'project'),
      );
      await insertMemory({
        ...memFixture('Secret kubernetes fact from other group', 'project'),
        group_folder: 'other-group',
      });

      const result = await recallTool.handler(
        { query: 'kubernetes', limit: 10 },
        deps,
        makeContext({ permissions: { [GROUP]: ['memories:read'] } }),
      );

      expect(result.memories.length).toBeGreaterThanOrEqual(1);
      expect(
        result.memories.every((m: { group: string }) => m.group === GROUP),
      ).toBe(true);
    });
  });

  describe('forget', () => {
    test('deletes memory and vector', async () => {
      const mem = await insertMemory(
        memFixture('Temporary note to delete', 'task'),
      );
      const result = await forgetTool.handler(
        { memory_id: mem.id },
        deps,
        makeContext(),
      );
      expect(result).toContain(mem.id);
      expect(await getMemory(mem.id)).toBeUndefined();
      expect(deleteCalls).toEqual([mem.id]);
    });

    test('outage queues external erasure durably and maintenance retries it', async () => {
      const mem = await insertMemory(
        memFixture('Private outage-safe note', 'task'),
      );
      let graphAttempts = 0;
      let memoryAttempts = 0;
      setVectorStoreHooks({
        ...mockHooks,
        eraseGraphFactsMatchingTarget: async () => {
          graphAttempts++;
        },
        eraseMemory: async () => {
          memoryAttempts++;
          throw new Error('Neo4j unavailable');
        },
      });

      const result = await forgetTool.handler(
        { memory_id: mem.id },
        deps,
        makeContext(),
      );
      expect(result).toContain(mem.id);

      expect(await getMemory(mem.id)).toBeUndefined();
      const pending = await getPendingMemoryErasures(GROUP);
      expect(pending.map((p) => p.memory_id)).toEqual([mem.id]);
      expect(pending[0]).not.toHaveProperty('target_hashes');
      expect(pending[0].target_tokens).not.toContain('Private');
      expect(graphAttempts).toBe(0);
      expect(memoryAttempts).toBe(1);

      // A restart with the optional module disabled must not discard work
      // that was queued while external storage was configured.
      setVectorStoreHooks(null!);
      await maintainMemories(GROUP);
      expect(await getPendingMemoryErasures(GROUP)).toHaveLength(1);
      expect(graphAttempts).toBe(0);
      expect(memoryAttempts).toBe(1);

      setVectorStoreHooks({
        ...mockHooks,
        eraseGraphFactsMatchingTarget: async () => {
          graphAttempts++;
        },
        eraseMemory: async () => {
          memoryAttempts++;
        },
      });
      await maintainMemories(GROUP);

      expect(graphAttempts).toBe(0);
      expect(memoryAttempts).toBe(2);
      expect(await getMemory(mem.id)).toBeUndefined();
      expect(await getPendingMemoryErasures(GROUP)).toEqual([]);
    });

    test('denies forget on another group', async () => {
      const mem = await insertMemory({
        ...memFixture('Owned by other group', 'project'),
        group_folder: 'other-group',
      });
      await expect(
        forgetTool.handler({ memory_id: mem.id }, deps, makeContext()),
      ).rejects.toThrow(/Unauthorized/);
    });

    // Regression guard for the explicit test override: with the external gate
    // OFF, [forgotten]/forget must perform SQL-only erasure — the row is
    // deleted and the epoch advances, but no Neo4j vector/graph hooks fire,
    // no durable retry queue is populated, and the call completes without
    // throwing. The external code stays dormant for a bounded redesign.
    describe('neutralized — SQL-only when ENABLE_EXTERNAL_PRIVACY_ERASURE is off', () => {
      beforeEach(() => {
        setExternalPrivacyErasureEnabled(false);
      });

      afterAll(() => {
        setExternalPrivacyErasureEnabled(false);
      });

      test('forget deletes the SQL row but skips vector/graph hooks and queues no retry', async () => {
        const mem = await insertMemory(
          memFixture('Temporary note to neutralize', 'task'),
        );
        const result = await forgetTool.handler(
          { memory_id: mem.id },
          deps,
          makeContext(),
        );
        expect(result).toContain(mem.id);
        expect(await getMemory(mem.id)).toBeUndefined();
        // SQL row gone, but external stores untouched (dormant).
        expect(deleteCalls).toEqual([]);
        expect(graphEraseCalls).toEqual([]);
        expect(await getPendingMemoryErasures(GROUP)).toEqual([]);
      });
    });
  });
});

async function updateImportance(id: string, importance: number): Promise<void> {
  await updateMemory(id, { importance });
}

describe('orderVectorHitIds', () => {
  test('orders by similarity before importance unless asOf is set', () => {
    const now = new Date().toISOString();
    const mem = (id: string, importance: number) =>
      [id, { id, importance, valid_from: now, last_accessed_at: now }] as const;
    const byId = new Map([
      mem('similar-low', 0.3),
      mem('weaker-high', 0.9),
    ]) as unknown as Map<string, Memory>;
    const hits = [
      { id: 'weaker-high', score: 0.7 },
      { id: 'similar-low', score: 0.75 },
    ];
    expect(orderVectorHitIds(hits, byId)).toEqual([
      'similar-low',
      'weaker-high',
    ]);
  });
});
