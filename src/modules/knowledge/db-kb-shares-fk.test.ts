/**
 * Project sharing must work with foreign keys ENFORCED.
 *
 * The test suite disables FK checks globally (`session_replication_role =
 * 'replica'`, see test-helpers.ts), which hid a real defect: project shares
 * were written as synthetic `group:<folder>` rows in `kb_members`, whose
 * `user_id` references `users.id`. No such user exists, so every share insert
 * failed on a real database and the Knowledge Hub could never share a KB with
 * a project. These suites restore enforcement so the defect cannot return.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { knowledgeBases, projects, users } from '../../db/schema.js';
import {
  getKnowledgeBaseShares,
  getSharedKnowledgeBases,
  shareKnowledgeBase,
  unshareKnowledgeBase,
  upsertProjectMember,
} from './db-kb.js';

function client(): PGlite {
  const handle = drizzleDbRef.current as unknown as
    | {
        $client?: PGlite;
        _?: { client?: PGlite };
        session?: { client?: PGlite };
      }
    | undefined;
  return (handle?.$client ??
    handle?._?.client ??
    handle?.session?.client) as PGlite;
}

const OWNER = 'kb-shares-owner';
const PROJECT = 'kb-shares-project';
const OTHER_PROJECT = 'kb-shares-other-project';
const KB = 'kb-shares-kb';

beforeAll(async () => {
  await initDatabase(':memory:');
  // Re-enable FK enforcement for this suite; truncateTestDb would turn it off.
  await client().exec("SET session_replication_role = 'origin'");
});

afterAll(async () => {
  const c = client();
  if (c) await c.exec("SET session_replication_role = 'replica'");
});

beforeEach(async () => {
  const c = client();
  await c.exec('DELETE FROM knowledge_base_shares');
  await c.exec('DELETE FROM kb_members');
  await c.exec('DELETE FROM knowledge_documents');
  await c.exec('DELETE FROM knowledge_bases');
  await c.exec('DELETE FROM project_members');
  await c.exec('DELETE FROM projects');
  await c.exec('DELETE FROM users');

  await drizzleDbRef.current.insert(users).values({
    id: OWNER,
    username: 'kb-shares-owner',
    password_hash: 'unused',
    created_at: new Date().toISOString(),
  });
  for (const id of [PROJECT, OTHER_PROJECT]) {
    await drizzleDbRef.current.insert(projects).values({
      id,
      jid: `${id}@web`,
      name: id,
      folder: id,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: OWNER,
    });
  }
  await drizzleDbRef.current.insert(knowledgeBases).values({
    id: KB,
    name: 'Shared KB',
    description: null,
    folder_path: '/tmp/kb-shares-kb',
    created_at: Date.now(),
    last_indexed_at: null,
  });
  await upsertProjectMember(OWNER, PROJECT, 'editor');
  await upsertProjectMember(OWNER, OTHER_PROJECT, 'editor');
});

describe('knowledge base project shares with foreign keys enforced', () => {
  test('sharing a KB into an existing project succeeds and is visible', async () => {
    await shareKnowledgeBase(KB, PROJECT);

    expect(await getKnowledgeBaseShares(KB)).toEqual([PROJECT]);
    const shared = await getSharedKnowledgeBases(PROJECT);
    expect(shared.map((kb) => kb.id)).toEqual([KB]);
    expect(shared[0].name).toBe('Shared KB');
  });

  test('sharing is idempotent and keeps a single share row', async () => {
    await shareKnowledgeBase(KB, PROJECT);
    await shareKnowledgeBase(KB, PROJECT);

    expect(await getKnowledgeBaseShares(KB)).toEqual([PROJECT]);
    const rows = await client().query(
      `SELECT knowledge_base_id, group_folder FROM knowledge_base_shares`,
    );
    expect(rows.rows).toEqual([
      { knowledge_base_id: KB, group_folder: PROJECT },
    ]);
  });

  test('a KB shared with one project is not visible to another project', async () => {
    await shareKnowledgeBase(KB, PROJECT);

    expect(await getKnowledgeBaseShares(KB)).toEqual([PROJECT]);
    expect(await getSharedKnowledgeBases(OTHER_PROJECT)).toEqual([]);
  });

  test('unsharing removes the share', async () => {
    await shareKnowledgeBase(KB, PROJECT);
    await unshareKnowledgeBase(KB, PROJECT);

    expect(await getKnowledgeBaseShares(KB)).toEqual([]);
    expect(await getSharedKnowledgeBases(PROJECT)).toEqual([]);
  });

  test('sharing into a missing project is rejected by the foreign key', async () => {
    await expect(shareKnowledgeBase(KB, 'no-such-project')).rejects.toThrow();
    expect(await getKnowledgeBaseShares(KB)).toEqual([]);
  });

  test('deleting the project removes the share through the cascade', async () => {
    await shareKnowledgeBase(KB, PROJECT);
    await drizzleDbRef.current.delete(projects).where(eq(projects.id, PROJECT));

    expect(await getKnowledgeBaseShares(KB)).toEqual([]);
    expect(await getSharedKnowledgeBases(PROJECT)).toEqual([]);
  });
});
