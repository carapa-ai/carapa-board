/**
 * Verifies that the FK constraints cascade as designed when a parent row is deleted. The test suite suppresses
 * FK enforcement globally via session_replication_role='replica' (see
 * test-helpers.ts), so this suite restores enforcement just for these checks.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { initDatabase } from '../db.js';
import { drizzleDbRef } from './drizzle-client.js';

const PROJ = 'cascade-test-proj';

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

beforeAll(async () => {
  await initDatabase(':memory:');
  const c = client();
  // Re-enable FK enforcement for this suite.
  await c.exec("SET session_replication_role = 'origin'");
  // Wipe any state left by other suites without using truncateTestDb (which
  // would flip enforcement off again).
  await c.exec('DELETE FROM task_stage_comments');
  await c.exec('DELETE FROM task_messages');
  await c.exec('DELETE FROM tasks');
  await c.exec('DELETE FROM conversations');
  await c.exec('DELETE FROM cronjobs');
  await c.exec('DELETE FROM projects');
  await c.exec(
    `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
     VALUES ('${PROJ}', 'cascade@kanban', 'Cascade', '${PROJ}', '!', '2026-05-07T00:00:00Z', 0)`,
  );
});

afterAll(async () => {
  const c = client();
  if (c) await c.exec("SET session_replication_role = 'replica'");
});

describe('FK cascade behavior', () => {
  test('deleting a project cascades to tasks', async () => {
    const c = client();
    await c.exec(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, created_at)
       VALUES ('t-1', '${PROJ}', 'X', '', 'backlog', 0, '2026-05-07T00:00:00Z')`,
    );
    await c.exec(`DELETE FROM projects WHERE id = '${PROJ}'`);
    const after = await c.query(
      `SELECT id FROM tasks WHERE project_id = '${PROJ}'`,
    );
    expect(after.rows.length).toBe(0);

    await c.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
       VALUES ('${PROJ}', 'cascade@kanban', 'Cascade', '${PROJ}', '!', '2026-05-07T00:00:00Z', 0)`,
    );
  });

  test('deleting a task cascades to task_messages', async () => {
    const c = client();
    await c.exec(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, created_at)
       VALUES ('t-2', '${PROJ}', 'Y', '', 'backlog', 0, '2026-05-07T00:00:00Z')`,
    );
    await c.exec(
      `INSERT INTO task_messages (id, task_id, role, content, created_at)
       VALUES ('m-1', 't-2', 'user', 'hi', '2026-05-07T00:00:01Z')`,
    );
    await c.exec(`DELETE FROM tasks WHERE id = 't-2'`);
    const after = await c.query(
      `SELECT id FROM task_messages WHERE task_id = 't-2'`,
    );
    expect(after.rows.length).toBe(0);
  });

  test('deleting a task cascades to persistent stage comments', async () => {
    const c = client();
    await c.exec(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, created_at)
       VALUES ('t-stage-note', '${PROJ}', 'Note owner', '', 'testing', 0, '2026-05-07T00:00:00Z')`,
    );
    await c.exec(
      `INSERT INTO task_stage_comments (task_id, stage_id, content, updated_at)
       VALUES ('t-stage-note', 'testing', 'remember setup', '2026-05-07T00:00:01Z')`,
    );
    await c.exec(`DELETE FROM tasks WHERE id = 't-stage-note'`);
    const after = await c.query(
      `SELECT task_id FROM task_stage_comments WHERE task_id = 't-stage-note'`,
    );
    expect(after.rows.length).toBe(0);
  });

  test('inserting tasks for a missing project is rejected', async () => {
    const c = client();
    let threw = false;
    try {
      await c.exec(
        `INSERT INTO tasks (id, project_id, title, description, status, priority, created_at)
         VALUES ('t-3', 'no-such-project', 'Z', '', 'backlog', 0, '2026-05-07T00:00:00Z')`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
