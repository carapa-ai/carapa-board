/**
 * Tests for the dataset-task completion broadcast in
 * src/modules/kanban/task/pipeline.ts (spawnNextDatasetRow).
 *
 * When a dataset's last row is processed, the dataset task must be marked
 * completed AND the `dataset_task_updated` broadcast must carry the
 * persisted dataset task — the UI invalidates its dataset list from
 * `payload.project_id`, so a broken payload leaves clients stranded on
 * stale state.
 *
 * Top-level module mocks (process-global; this file is listed in
 * scripts/test-ci.sh's isolated_test_files for that reason). The ws-events
 * mock must be registered before the pipeline module is first loaded, so
 * the pipeline is imported dynamically in beforeAll. Only the three names
 * the pipeline import graph imports from ws-events are provided.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test';
import {
  initDatabase,
  createDatasetTask,
  getDatasetTask,
  updateDatasetTask,
} from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';

const broadcastEvents: Array<{ type: string; payload: any }> = [];

mock.module('../objectives/ws-events.js', () => ({
  broadcast: mock((event: { type: string; payload: any }) => {
    broadcastEvents.push(event);
  }),
  getViewingDeviceIds: mock(async () => []),
  isConversationViewedByUser: mock(() => false),
}));

type SpawnNextDatasetRow =
  typeof import('./task/pipeline.js').spawnNextDatasetRow;

let spawnNextDatasetRow: SpawnNextDatasetRow;
let initialized = false;

beforeAll(async () => {
  // Imported after the ws-events mock is registered so pipeline.ts binds
  // the mocked broadcast.
  const pipeline = await import('./task/pipeline.js');
  spawnNextDatasetRow = pipeline.spawnNextDatasetRow;
  await initDatabase(':memory:');
  initialized = true;
});

beforeEach(async () => {
  if (!initialized) throw new Error('test database was not initialized');
  await truncateTestDb();
  broadcastEvents.length = 0;
});

describe('dataset task completion broadcast', () => {
  test('broadcasts the persisted completed dataset task when the last row is processed', async () => {
    const dt = await createDatasetTask({
      project_id: 'dataset-completion-broadcast',
      title: 'Rows {{name}}',
      description: 'Process {{name}}',
      dataset: [{ name: 'only' }],
      total_rows: 1,
      status: 'active',
    });
    // Simulate row 0 finishing: advance the cursor past the last row.
    await updateDatasetTask(dt.id, { current_row_index: 1 });

    const group = { folder: dt.project_id } as any;
    const task = await spawnNextDatasetRow(
      (await getDatasetTask(dt.id))!,
      group,
      { manual: true },
    );

    expect(task).toBeNull();
    expect((await getDatasetTask(dt.id))?.status).toBe('completed');

    const events = broadcastEvents.filter(
      (e) => e.type === 'dataset_task_updated',
    );
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload;
    // A Promise payload (the un-awaited getDatasetTask before the fix)
    // serializes to {} on the wire and breaks the UI invalidation.
    expect(payload).not.toBeInstanceOf(Promise);
    expect(payload).toMatchObject({
      id: dt.id,
      project_id: dt.project_id,
      status: 'completed',
    });
  });
});
