import { beforeEach, describe, expect, test } from 'bun:test';
import { createCronjob, getCronjob, initDatabase } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  getNextCronRun,
  resumeCronjobTool,
  updateCronjobTool,
} from './cron-tools.js';

const PROJECT = 'cron-tools-test-project';

function context() {
  return {
    group_folder: PROJECT,
    permissions: { [PROJECT]: ['cron:write'] },
  };
}

let initialized = false;
beforeEach(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await truncateTestDb();
});

describe('getNextCronRun', () => {
  test('rejects invalid expressions instead of creating an unscheduled job', () => {
    expect(() => getNextCronRun('not a cron expression')).toThrow(
      'Invalid cron expression',
    );
  });

  test('rejects a blank expression that cron-parser would run every minute', () => {
    expect(() => getNextCronRun('')).toThrow('Invalid cron expression');
    expect(() => getNextCronRun('  ')).toThrow('Invalid cron expression');
  });
});

describe('cron schedule mutations', () => {
  test('recalculates next_run when the expression is changed through MCP', async () => {
    const cron = await createCronjob({
      project_id: PROJECT,
      title: 'Schedule test',
      description: '',
      cron_expression: '0 0 * * *',
      queue_mode: 'always',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    await updateCronjobTool.handler(
      { cronjob_id: cron.id, cron_expression: '* * * * *' },
      {} as any,
      context(),
    );

    const updated = await getCronjob(cron.id);
    expect(updated?.cron_expression).toBe('* * * * *');
    expect(Date.parse(updated!.next_run!)).toBeGreaterThan(Date.now());
  });

  test('recalculates next_run when a paused job is resumed through MCP', async () => {
    const cron = await createCronjob({
      project_id: PROJECT,
      title: 'Resume test',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'always',
      status: 'paused',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await resumeCronjobTool.handler(
      { cronjob_id: cron.id },
      {} as any,
      context(),
    );

    const updated = JSON.parse(result);
    expect(updated.status).toBe('active');
    expect(Date.parse(updated.next_run)).toBeGreaterThan(Date.now());
  });
});
