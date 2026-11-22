import fs from 'fs/promises';
import path from 'path';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { GROUPS_DIR } from '../../config.js';
import { initDatabase } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import { createCronjob, getCronjob } from '../kanban/db-kanban.js';
import {
  createObjective,
  getObjective,
  updateObjectiveCostLimit,
} from './db-objectives.js';
import { enforceObjectiveCostLimit } from './objective-budget.js';

const PROJECT_ID = 'objective-budget-enforcement-test';
let initialized = false;

beforeEach(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await truncateTestDb();
});

afterAll(async () => {
  await fs.rm(path.join(GROUPS_DIR, PROJECT_ID), {
    recursive: true,
    force: true,
  });
});

describe('objective cost-limit enforcement', () => {
  test('pauses the objective and its cronjobs exactly once at the limit', async () => {
    const objective = await createObjective({
      project_id: PROJECT_ID,
      title: 'Bounded objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
    });
    await updateObjectiveCostLimit(objective.id, 5);
    const cronjob = await createCronjob({
      project_id: PROJECT_ID,
      objective_id: objective.id,
      title: 'Objective check',
      description: '',
      cron_expression: '0 * * * *',
      queue_mode: 'always',
      status: 'active',
    });

    expect(
      await enforceObjectiveCostLimit(PROJECT_ID, objective.id, 4.99),
    ).toBeUndefined();
    expect((await getCronjob(cronjob.id))?.status).toBe('active');

    const paused = await enforceObjectiveCostLimit(PROJECT_ID, objective.id, 5);
    expect(paused?.status).toBe('paused');
    expect((await getObjective(objective.id))?.status).toBe('paused');
    expect((await getCronjob(cronjob.id))?.status).toBe('paused');

    expect(
      await enforceObjectiveCostLimit(PROJECT_ID, objective.id, 6),
    ).toBeUndefined();
  });
});
