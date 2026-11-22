import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { memories, objectives } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { initDatabase, insertMemory, getMemory } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  registeredGroups,
  applyGroupUpdateInMemory,
} from '../../state-manager.js';
import memoriesRouter from '../../routes/memories.js';
import { setVectorStoreHooks } from '../vector-store/hooks.js';
import { pgMemoryBackend } from './backend/pg-backend.js';
import { isDuplicateMemoryContent } from './dedup.js';
import { maintainMemories } from './maintenance.js';

const GROUP = 'memory-dedup-test';
const JID = 'memory-dedup-test@web';
const STAGING = 'Deploy target for the billing service is staging';
const PRODUCTION = 'Deploy target for the billing service is production';

beforeAll(async () => {
  await initDatabase(':memory:');
  setVectorStoreHooks(null!);
  registeredGroups[JID] = { folder: GROUP } as any;
  applyGroupUpdateInMemory(JID, {});
});

afterAll(() => {
  delete registeredGroups[JID];
  applyGroupUpdateInMemory(JID, {});
});

beforeEach(async () => {
  await truncateTestDb();
});

const write = (content: string, objective_id?: string, importance?: number) =>
  pgMemoryBackend.memorize({
    group_folder: GROUP,
    content,
    memory_type: 'project',
    source: 'agent',
    operation: 'create',
    ...(objective_id ? { objective_id } : {}),
    ...(importance !== undefined ? { importance } : {}),
  } as any);

const post = (body: Record<string, unknown>) =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        resolve({ status: this.statusCode, body: value });
        return this;
      },
    };
    const req: any = {
      method: 'POST',
      url: `/groups/${GROUP}/memories`,
      originalUrl: `/groups/${GROUP}/memories`,
      headers: {},
      query: {},
      params: {},
      authUser: { id: 'admin', username: 'admin', role: 'admin' },
      body,
      get: () => undefined,
    };
    (memoriesRouter as any).handle(req, res, (err: unknown) =>
      reject(err ?? new Error('route not handled')),
    );
  });

describe('isDuplicateMemoryContent', () => {
  test('identical text is a duplicate; contradictions are not', () => {
    expect(isDuplicateMemoryContent(STAGING, `${STAGING}.`)).toBe(true);
    expect(isDuplicateMemoryContent(STAGING, PRODUCTION)).toBe(false);
    expect(
      isDuplicateMemoryContent(
        'Alex wants WhatsApp morning briefs',
        'Alex no longer wants WhatsApp morning briefs',
      ),
    ).toBe(false);
  });

  test('reordered tokens are not duplicates', () => {
    expect(
      isDuplicateMemoryContent(
        'carapa-board depends on carapa-box',
        'carapa-box depends on carapa-board',
      ),
    ).toBe(false);
    expect(
      isDuplicateMemoryContent(
        'brain uses port 3111, board 3100',
        'brain uses port 3100, board 3111',
      ),
    ).toBe(false);
    expect(isDuplicateMemoryContent('version 0.1', 'version 1.0')).toBe(false);
  });

  test('case, punctuation and articles do not matter', () => {
    expect(isDuplicateMemoryContent(STAGING, STAGING)).toBe(true);
    expect(isDuplicateMemoryContent(STAGING, STAGING.toUpperCase())).toBe(true);
    expect(
      isDuplicateMemoryContent(
        'Deploy target for billing service is staging',
        STAGING,
      ),
    ).toBe(true);
    expect(isDuplicateMemoryContent('A cat sat', 'cat sat on the')).toBe(false);
    expect(isDuplicateMemoryContent('', '')).toBe(false);
  });
});

describe('memorize duplicate detection', () => {
  test('contradicting facts are created, exact re-write is a duplicate', async () => {
    expect((await write(STAGING)).kind).toBe('created');
    expect((await write(PRODUCTION)).kind).toBe('created');
    expect((await write(STAGING)).kind).toBe('duplicate');

    expect((await write('Alex wants WhatsApp morning briefs')).kind).toBe(
      'created',
    );
    expect(
      (await write('Alex no longer wants WhatsApp morning briefs')).kind,
    ).toBe('created');
  });

  test('objective write finds its own copy despite similar project-wide rows', async () => {
    const text = 'Billing deploy checklist requires approval before release';
    const now = new Date().toISOString();
    await drizzleDbRef.current.insert(objectives).values({
      id: 'obj-1',
      project_id: GROUP,
      title: 'Billing',
      created_at: now,
      updated_at: now,
    });
    for (let i = 0; i < 5; i++) {
      await insertMemory({
        group_folder: GROUP,
        content: `${text} variant${i}`,
        memory_type: 'project',
        importance: 0.99,
        source: 'agent',
      });
    }
    expect((await write(text, 'obj-1')).kind).toBe('created');
    expect((await write(text, 'obj-1')).kind).toBe('duplicate');
    const copies = (
      await drizzleDbRef.current
        .select()
        .from(memories)
        .where(eq(memories.objective_id, 'obj-1'))
    ).length;
    expect(copies).toBe(1);
  });
});

const insertObjective = async (id: string, project_id: string) => {
  const now = new Date().toISOString();
  await drizzleDbRef.current.insert(objectives).values({
    id,
    project_id,
    title: id,
    created_at: now,
    updated_at: now,
  });
};

describe('HTTP memory POST scope', () => {
  test('rejects an objective of another project without writing a row', async () => {
    await insertObjective('obj-foreign', 'other-project');

    const rejected = await post({
      content: STAGING,
      memory_type: 'project',
      objective_id: 'obj-foreign',
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe(
      'objective_id must be an objective of this project',
    );
    expect(await drizzleDbRef.current.select().from(memories)).toHaveLength(0);
  });

  test('objective-scoped POST never overwrites a project-wide row', async () => {
    await insertObjective('obj-1', GROUP);
    const projectWide = await insertMemory({
      group_folder: GROUP,
      content: STAGING,
      memory_type: 'project',
      importance: 0.3,
      source: 'agent',
    });

    const scoped = await post({
      content: STAGING,
      memory_type: 'project',
      importance: 0.9,
      objective_id: 'obj-1',
    });

    expect(scoped.status).toBe(201);
    expect(scoped.body.id).not.toBe(projectWide.id);
    expect((await getMemory(projectWide.id))!.importance).toBe(0.3);

    const again = await post({
      content: STAGING,
      memory_type: 'project',
      objective_id: 'obj-1',
    });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(scoped.body.id);
  });
});

describe('maintenance dedup', () => {
  test('does not merge contradicting facts but merges exact duplicates', async () => {
    const base = {
      group_folder: GROUP,
      memory_type: 'project' as const,
      importance: 0.7,
      source: 'agent' as const,
    };
    const staging = await insertMemory({ ...base, content: STAGING });
    const production = await insertMemory({ ...base, content: PRODUCTION });
    const copy = await insertMemory({ ...base, content: STAGING });

    await maintainMemories(GROUP);

    expect((await getMemory(production.id))!.superseded_by).toBeNull();
    const states = await Promise.all(
      [staging.id, copy.id].map(
        async (id) => (await getMemory(id))!.superseded_by,
      ),
    );
    expect(states.filter(Boolean)).toHaveLength(1);
  });
});
