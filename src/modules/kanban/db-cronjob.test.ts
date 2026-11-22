/**
 * Tests for material cronjob persistence and scheduling queries in src/db.ts.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  initDatabase,
  createCronjob,
  getCronjob,
  updateCronjob,
  pauseCronjobsByObjective,
  getDueCronjobs,
} from '../../db.js';

import type { Cronjob } from './types.js';
import { truncateTestDb } from '../../test-helpers.js';

const PROJ = 'cron-test-project';

function cronjobFixture(
  overrides: Partial<Omit<Cronjob, 'id' | 'created_at'>> = {},
): Omit<Cronjob, 'id' | 'created_at'> {
  return {
    project_id: PROJ,
    title: 'Daily cleanup',
    description: 'Runs cleanup every day',
    cron_expression: '0 0 * * *',
    queue_mode: 'always',
    model: undefined,
    agent_name: undefined,
    status: 'active',
    last_run: undefined,
    next_run: undefined,
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

// ─── createCronjob ────────────────────────────────────────────────────────────

describe('createCronjob', () => {
  test('persists a structured runtime selection', async () => {
    const runtimeSelection = {
      harnessId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoning: 'high',
    };
    const cron = await createCronjob(cronjobFixture({ runtimeSelection }));
    expect((await getCronjob(cron.id))?.runtimeSelection).toEqual(
      runtimeSelection,
    );

    await updateCronjob(cron.id, { runtimeSelection: null });
    expect((await getCronjob(cron.id))?.runtimeSelection).toBeNull();
  });
});
describe('pauseCronjobsByObjective', () => {
  test('pauses active cronjobs owned by the objective only', async () => {
    const owned = await createCronjob(
      cronjobFixture({ objective_id: 'obj-over-budget' }),
    );
    const alreadyPaused = await createCronjob(
      cronjobFixture({
        objective_id: 'obj-over-budget',
        status: 'paused',
      }),
    );
    const other = await createCronjob(
      cronjobFixture({ objective_id: 'other-objective' }),
    );

    await pauseCronjobsByObjective('obj-over-budget');

    expect((await getCronjob(owned.id))?.status).toBe('paused');
    expect((await getCronjob(alreadyPaused.id))?.status).toBe('paused');
    expect((await getCronjob(other.id))?.status).toBe('active');
  });
});
// ─── getDueCronjobs ───────────────────────────────────────────────────────────

describe('getDueCronjobs', () => {
  test('returns only active cronjobs whose next_run is in the past', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await createCronjob(
      cronjobFixture({ title: 'Due', next_run: past, status: 'active' }),
    );
    await createCronjob(
      cronjobFixture({ title: 'Not due', next_run: future, status: 'active' }),
    );
    await createCronjob(
      cronjobFixture({
        title: 'No schedule',
        next_run: undefined,
        status: 'active',
      }),
    );
    const due = await getDueCronjobs();
    expect(due.some((c) => c.title === 'Due')).toBe(true);
    expect(due.some((c) => c.title === 'Not due')).toBe(false);
    expect(due.some((c) => c.title === 'No schedule')).toBe(false);
  });

  test('excludes inactive cronjobs even if past due', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await createCronjob(
      cronjobFixture({ title: 'Paused due', next_run: past, status: 'paused' }),
    );
    const due = await getDueCronjobs();
    expect(due.some((c) => c.title === 'Paused due')).toBe(false);
  });
});
