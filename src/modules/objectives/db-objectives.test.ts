/**
 * Tests for objective CRUD functions in src/modules/objectives/db-objectives.ts.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import { initDatabase } from '../../db.js';
import {
  createObjective,
  getObjective,
  getObjectivesByProject,
  updateObjective,
  updateObjectiveCostLimit,
  pauseObjectiveIfCostLimitReached,
  deleteObjective,
} from './db-objectives.js';

import type { Objective } from './types.js';
import { truncateTestDb } from '../../test-helpers.js';

const PROJ = 'obj-test-project';

function objectiveFixture(
  overrides: Partial<Omit<Objective, 'id' | 'created_at' | 'updated_at'>> = {},
): Omit<Objective, 'id' | 'created_at' | 'updated_at'> {
  return {
    project_id: PROJ,
    title: 'Build feature X',
    description: 'Implement the new feature',
    status: 'draft',
    priority: 0,
    progress: 0,
    deadline: null,
    metadata: null,
    trigger_config: null,
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

describe('objective event runtime persistence', () => {
  test('round-trips an override and clears it back to inheritance', async () => {
    const selection = {
      harnessId: 'direct',
      modelId: 'default',
      reasoning: 'high',
    };
    const obj = await createObjective(
      objectiveFixture({ eventRuntimeSelection: selection }),
    );

    expect((await getObjective(obj.id))!.eventRuntimeSelection).toEqual(
      selection,
    );
    expect(
      (await updateObjective(obj.id, { eventRuntimeSelection: null }))!
        .eventRuntimeSelection,
    ).toBeNull();
  });
});

describe('getObjectivesByProject', () => {
  test('orders by priority ASC then created_at', async () => {
    const high = await createObjective(
      objectiveFixture({ title: 'High priority', priority: 0 }),
    );
    const low = await createObjective(
      objectiveFixture({ title: 'Low priority', priority: 10 }),
    );
    const objs = await getObjectivesByProject(PROJ);
    const ids = objs.map((o) => o.id);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });

  test('returns objectives from multiple projects correctly', async () => {
    await createObjective(
      objectiveFixture({ title: 'Proj A 1', project_id: 'proj-a' }),
    );
    await createObjective(
      objectiveFixture({ title: 'Proj A 2', project_id: 'proj-a' }),
    );
    await createObjective(
      objectiveFixture({ title: 'Proj B 1', project_id: 'proj-b' }),
    );
    const aObjs = await getObjectivesByProject('proj-a');
    expect(aObjs).toHaveLength(2);
    expect(aObjs.every((o) => o.project_id === 'proj-a')).toBe(true);
    const bObjs = await getObjectivesByProject('proj-b');
    expect(bObjs).toHaveLength(1);
    expect(bObjs[0].title).toBe('Proj B 1');
  });
});

describe('updateObjective', () => {
  test('keeps the user-owned cost limit out of generic objective updates', async () => {
    const obj = await createObjective(objectiveFixture());
    await updateObjectiveCostLimit(obj.id, 25);
    await updateObjective(obj.id, { cost_limit_usd: 99 } as never);
    expect((await getObjective(obj.id))!.cost_limit_usd).toBe(25);
  });

  test('does not budget-pause draft or terminal objectives', async () => {
    for (const status of ['draft', 'paused', 'achieved', 'failed'] as const) {
      const obj = await createObjective(objectiveFixture({ status }));
      await updateObjectiveCostLimit(obj.id, 1);
      expect(await pauseObjectiveIfCostLimitReached(obj.id, 2)).toBeUndefined();
      expect((await getObjective(obj.id))!.status).toBe(status);
    }
  });
});

describe('deleteObjective', () => {
  test('does not affect other objectives', async () => {
    const keep = await createObjective(objectiveFixture({ title: 'Keep me' }));
    const remove = await createObjective(
      objectiveFixture({ title: 'Remove me' }),
    );
    await deleteObjective(remove.id);
    const remaining = await getObjectivesByProject(PROJ);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keep.id);
    expect(remaining[0].title).toBe('Keep me');
  });
});
