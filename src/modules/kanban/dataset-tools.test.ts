import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createDatasetTask,
  createObjective,
  getDatasetTasksByProject,
  getTasksByProject,
  initDatabase,
} from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  createDatasetTaskTool,
  updateDatasetTaskTool,
} from './dataset-tools.js';

const PROJECT = 'dataset-tools-test-project';

const INVALID_DATASET_ERROR =
  'dataset must be a non-empty array of objects with string or number values';

function context() {
  return {
    group_folder: PROJECT,
    permissions: { [PROJECT]: ['datasets:write'] },
  };
}

// A paused project keeps spawned rows from being executed by the queue drain.
const GROUP = {
  folder: PROJECT,
  settings: {
    status: 'paused' as const,
    stages: [
      {
        id: 'in_progress',
        title: 'In progress',
        type: 'active' as const,
        color: '#888',
      },
    ],
  },
};

function deps() {
  return { getRegisteredGroups: () => [GROUP] } as any;
}

let initialized = false;
beforeEach(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await truncateTestDb();
});

describe('create_dataset_task dataset validation', () => {
  test('creates a task for a valid row array', async () => {
    const result = await createDatasetTaskTool.handler(
      {
        title: 'Valid dataset',
        description: 'Process {{name}}',
        dataset: JSON.stringify([
          { name: 'first' },
          { name: 'second', count: 2 },
        ]),
      },
      deps(),
      context(),
    );

    const task = JSON.parse(result);
    const tasks = await getDatasetTasksByProject(PROJECT);
    expect(tasks).toHaveLength(1);
    expect(task.total_rows).toBe(2);
    expect(task.dataset).toEqual([
      { name: 'first' },
      { name: 'second', count: 2 },
    ]);
  });

  test('rejects a JSON object payload without persisting anything', async () => {
    // Regression: parsedDataset.length is undefined for a plain object, which
    // hit the notNull total_rows column with a raw DB constraint error.
    await expect(
      createDatasetTaskTool.handler(
        { title: 'Object dataset', dataset: '{"name":"first"}' },
        deps(),
        context(),
      ),
    ).rejects.toThrow(INVALID_DATASET_ERROR);
    expect(await getDatasetTasksByProject(PROJECT)).toHaveLength(0);
  });

  test('rejects an empty array without persisting a stranded task', async () => {
    // Regression: an empty array persisted with total_rows 0 and never
    // advanced, stranding the task in status "active" forever.
    await expect(
      createDatasetTaskTool.handler(
        { title: 'Empty dataset', dataset: '[]' },
        deps(),
        context(),
      ),
    ).rejects.toThrow(INVALID_DATASET_ERROR);
    expect(await getDatasetTasksByProject(PROJECT)).toHaveLength(0);
  });

  test('rejects rows that are not flat string/number objects', async () => {
    await expect(
      createDatasetTaskTool.handler(
        {
          title: 'Broken rows',
          dataset: JSON.stringify([
            'not an object',
            { name: false },
            { name: 'ok', nested: { deep: true } },
          ]),
        },
        deps(),
        context(),
      ),
    ).rejects.toThrow(INVALID_DATASET_ERROR);
    expect(await getDatasetTasksByProject(PROJECT)).toHaveLength(0);
  });

  test('still rejects callers without datasets:write before validation', async () => {
    await expect(
      createDatasetTaskTool.handler(
        { title: 'No permission', dataset: '[{"a":1}]' },
        deps(),
        { group_folder: PROJECT, permissions: {} },
      ),
    ).rejects.toThrow('Unauthorized: missing datasets:write permission');
  });
});

describe('dataset task start via MCP tools', () => {
  test('create spawns the first row task and returns its id', async () => {
    const result = JSON.parse(
      await createDatasetTaskTool.handler(
        {
          title: 'Row {{name}}',
          description: 'Process {{name}}',
          dataset: JSON.stringify([{ name: 'a' }, { name: 'b' }]),
        },
        deps(),
        context(),
      ),
    );

    const rows = await getTasksByProject(PROJECT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dataset_task_id: result.id,
      dataset_row_index: 0,
    });
    expect(result.first_task_id).toBe(rows[0]!.id);
  });

  test('create leaves the row waiting when the owning objective is inactive', async () => {
    const objective = await createObjective({
      project_id: PROJECT,
      title: 'Draft owner',
      description: '',
      status: 'draft',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });
    const result = JSON.parse(
      await createDatasetTaskTool.handler(
        {
          title: 'Row',
          dataset: JSON.stringify([{ name: 'a' }]),
          objective_id: objective.id,
        },
        deps(),
        context(),
      ),
    );

    expect(result.first_task_id).toBeNull();
    expect(await getTasksByProject(PROJECT)).toHaveLength(0);
  });

  test('reactivating a paused dataset spawns the next row exactly once', async () => {
    const dt = await createDatasetTask({
      project_id: PROJECT,
      title: 'Row',
      description: 'Process',
      dataset: [{ name: 'a' }, { name: 'b' }],
      total_rows: 2,
      status: 'paused',
    });
    const activate = () =>
      updateDatasetTaskTool.handler(
        { task_id: dt.id, status: 'active' },
        deps(),
        context(),
      );

    await activate();
    expect(await getTasksByProject(PROJECT)).toHaveLength(1);
    await activate();
    expect(await getTasksByProject(PROJECT)).toHaveLength(1);
  });
});
