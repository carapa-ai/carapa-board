/**
 * Re-keying a project's jid (WhatsApp link / unlink / auto-link) must keep the
 * `projects` row, so rows that cascade from it survive.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';

import { eq } from 'drizzle-orm';

import { GROUPS_DIR } from './config.js';
import { createCronjob, createTask, initDatabase } from './db.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import { cronjobs, projects, tasks } from './db/schema.js';
import {
  getGroupEntryByFolder,
  loadState,
  registeredGroups,
  registerGroup,
  rekeyGroupJid,
  unregisterGroup,
} from './state-manager.js';
import { taskFixture } from './test-helpers.js';

const FOLDER = 'rekey-test-project';
const OLD_JID = 'ui-rekey-test-project';
const WA_JID = '123456789@g.us';

async function rows() {
  const db = drizzleDbRef.current;
  return {
    project: (
      await db.select().from(projects).where(eq(projects.id, FOLDER))
    )[0],
    tasks: await db.select().from(tasks).where(eq(tasks.project_id, FOLDER)),
    cronjobs: await db
      .select()
      .from(cronjobs)
      .where(eq(cronjobs.project_id, FOLDER)),
  };
}

describe('rekeyGroupJid', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    await registerGroup(OLD_JID, {
      name: 'Rekey project',
      folder: FOLDER,
      trigger: '@rekey',
      added_at: new Date().toISOString(),
      settings: { mode: 'chat' },
    });
    await createTask(taskFixture({ project_id: FOLDER, title: 'Keep me' }));
    await createCronjob({
      project_id: FOLDER,
      title: 'Keep me too',
      description: '',
      cron_expression: '0 0 * * *',
      queue_mode: 'always',
      status: 'active',
    });
  });

  afterAll(async () => {
    await unregisterGroup(WA_JID);
    await unregisterGroup(OLD_JID);
    fs.rmSync(`${GROUPS_DIR}/${FOLDER}`, { recursive: true, force: true });
  });

  test('link and unlink keep the project row and its dependent rows', async () => {
    await rekeyGroupJid(OLD_JID, WA_JID, { name: 'Linked' });
    let r = await rows();
    expect(r.project?.jid).toBe(WA_JID);
    expect(r.project?.name).toBe('Linked');
    expect(r.tasks).toHaveLength(1);
    expect(r.cronjobs).toHaveLength(1);
    expect(getGroupEntryByFolder(FOLDER)?.jid).toBe(WA_JID);
    expect(registeredGroups[OLD_JID]).toBeUndefined();

    await rekeyGroupJid(WA_JID, OLD_JID);
    r = await rows();
    expect(r.project?.jid).toBe(OLD_JID);
    expect(r.tasks).toHaveLength(1);
    expect(r.cronjobs).toHaveLength(1);
    expect(getGroupEntryByFolder(FOLDER)?.jid).toBe(OLD_JID);
  });

  test('a project without a DB row is not re-keyed in memory', async () => {
    registeredGroups['ui-orphan'] = {
      name: 'Orphan',
      folder: 'rekey-orphan',
      trigger: '@x',
      added_at: new Date().toISOString(),
    };
    try {
      await expect(rekeyGroupJid('ui-orphan', WA_JID)).rejects.toThrow(
        'no database row',
      );
      expect(registeredGroups['ui-orphan']).toBeDefined();
      expect(registeredGroups[WA_JID]).toBeUndefined();
    } finally {
      delete registeredGroups['ui-orphan'];
    }
  });

  test('a failed DB update leaves the registry on the old jid', async () => {
    const spy = spyOn(drizzleDbRef.current, 'update').mockImplementation(() => {
      throw new Error('db down');
    });
    try {
      await expect(rekeyGroupJid(OLD_JID, WA_JID)).rejects.toThrow('db down');
    } finally {
      spy.mockRestore();
    }
    expect(registeredGroups[OLD_JID]).toBeDefined();
    expect(registeredGroups[WA_JID]).toBeUndefined();
    expect((await rows()).project?.jid).toBe(OLD_JID);
  });
});
