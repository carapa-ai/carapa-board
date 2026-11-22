import fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { GROUPS_DIR } from '../../config.js';
import { createTask, initDatabase, insertActiveRun } from '../../db.js';
import { runFixture, taskFixture, truncateTestDb } from '../../test-helpers.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { activeRuns } from '../../db/schema.js';
import { createObjective } from './db-objectives.js';
import { getObjectiveDir } from './objective-folder.js';
import { refreshObjectiveTaskCost } from './objective-task-cost.js';

const PROJECT_ID = 'objective-task-cost-test';
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

async function objectiveWithPricedTaskRun(): Promise<string> {
  const objective = await createObjective({
    project_id: PROJECT_ID,
    title: 'Linked task cost',
    description: '',
    status: 'active',
    priority: 0,
    progress: 0,
  });
  const task = await createTask(
    taskFixture({ project_id: PROJECT_ID, objective_id: objective.id }),
  );
  await insertActiveRun(
    runFixture({
      task_id: task.id,
      group_folder: PROJECT_ID,
      status: 'completed',
    }),
  );
  await drizzleDbRef.current
    .update(activeRuns)
    .set({ cost_usd: 1.25 })
    .where(eq(activeRuns.task_id, task.id));
  await fs.mkdir(getObjectiveDir(PROJECT_ID, objective.id), {
    recursive: true,
  });
  return objective.id;
}

async function readCostFiles(objectiveId: string) {
  const dir = getObjectiveDir(PROJECT_ID, objectiveId);
  const read = async (name: string) =>
    JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
  return {
    metrics: await read('board-cost-metrics.json'),
    report: await read('board-cost-report.json'),
  };
}

describe('refreshObjectiveTaskCost', () => {
  test('publishes metrics and report with the same total', async () => {
    const objectiveId = await objectiveWithPricedTaskRun();

    expect(await refreshObjectiveTaskCost(PROJECT_ID, objectiveId)).toBe(1.25);

    const { metrics, report } = await readCostFiles(objectiveId);
    expect(metrics.taskCostUsd).toBe(1.25);
    expect(report.windows.all.byGroup.kanban).toBe(metrics.taskCostUsd);
    expect(report.windows.all.totalUsd).toBe(metrics.totalCostUsd);
  });

  test('concurrent refreshes leave both files consistent', async () => {
    const objectiveId = await objectiveWithPricedTaskRun();

    await Promise.all([
      refreshObjectiveTaskCost(PROJECT_ID, objectiveId),
      refreshObjectiveTaskCost(PROJECT_ID, objectiveId),
    ]);

    const { metrics, report } = await readCostFiles(objectiveId);
    expect(report.windows.all.totalUsd).toBe(1.25);
    expect(report.windows.all.totalUsd).toBe(metrics.totalCostUsd);
  });

  test('a failing report write does not reject the refresh', async () => {
    const objectiveId = await objectiveWithPricedTaskRun();
    // A directory in place of the report makes the atomic rename fail.
    await fs.mkdir(
      path.join(
        getObjectiveDir(PROJECT_ID, objectiveId),
        'board-cost-report.json',
      ),
    );

    expect(await refreshObjectiveTaskCost(PROJECT_ID, objectiveId)).toBe(1.25);
  });
});
