import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createDatasetTask,
  deleteDatasetTask,
  getDatasetTasksByProject,
  getDatasetTask,
  getTask,
  getTasksByProject,
  updateDatasetTask,
  initDatabase,
  createUser,
} from '../db.js';
import { truncateTestDb } from '../test-helpers.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import datasetsRouter from './datasets.js';

describe('dataset task route validation', () => {
  const projectId = 'dataset-route-validation';
  let datasetTaskId = '';
  let server: Server;
  let baseUrl = '';
  let callerId = '';
  const projectJid = `${projectId}@test`;

  beforeAll(async () => {
    await initDatabase(':memory:');
    await truncateTestDb();
    await loadState();
    const owner = await createUser('dataset-project-owner', 'pw', 'user');
    const caller = await createUser('dataset-manual-caller', 'pw', 'user');
    callerId = caller.id;
    await registerGroup(projectJid, {
      id: projectId,
      jid: projectJid,
      name: projectId,
      folder: projectId,
      trigger: '',
      added_at: new Date().toISOString(),
      user_id: owner.id,
      settings: {
        status: 'paused',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#00f',
          },
        ],
      },
    } as any);
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Validated dataset',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      status: 'active',
    });
    datasetTaskId = datasetTask.id;

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { id: callerId, role: 'user' };
      next();
    });
    app.use(datasetsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (datasetTaskId) await deleteDatasetTask(datasetTaskId);
    await unregisterGroup(projectJid);
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  test('rejects non-object rows instead of persisting an unexecutable dataset', async () => {
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/dataset-tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Broken dataset',
          description: 'Process {{name}}',
          dataset: ['not an object'],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await getDatasetTasksByProject(projectId)).toHaveLength(1);
  });

  test('attributes a manually spawned dataset row to the authenticated caller', async () => {
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/dataset-tasks/${datasetTaskId}/run`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { task_id: string };
    expect(await getTask(body.task_id)).toMatchObject({
      ownerUserId: callerId,
      lastTriggeredByUserId: callerId,
      lastTriggerSource: 'user',
    });
  });

  test('attributes a manually restarted dataset row to the authenticated caller', async () => {
    const restartable = await createDatasetTask({
      project_id: projectId,
      title: 'Restart {{name}}',
      description: 'Restart {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      status: 'paused',
    });
    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/dataset-tasks/${restartable.id}/restart`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { task_id: string };
      expect(await getTask(body.task_id)).toMatchObject({
        ownerUserId: callerId,
        lastTriggeredByUserId: callerId,
        lastTriggerSource: 'user',
      });
    } finally {
      await deleteDatasetTask(restartable.id);
    }
  });

  const patchStatus = (id: string, status: string) =>
    fetch(`${baseUrl}/projects/${projectId}/dataset-tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });

  test('resuming a paused dataset via PATCH spawns the current row exactly once', async () => {
    const paused = await createDatasetTask({
      project_id: projectId,
      title: 'Resume {{name}}',
      description: 'Resume {{name}}',
      dataset: [{ name: 'a' }, { name: 'b' }],
      total_rows: 2,
      status: 'paused',
    });
    try {
      // A row finished while paused: the index advanced without spawning.
      await updateDatasetTask(paused.id, { current_row_index: 1 });
      const rowTasks = async () =>
        (await getTasksByProject(projectId)).filter(
          (t) => t.dataset_task_id === paused.id,
        );

      expect((await patchStatus(paused.id, 'active')).status).toBe(200);
      const spawned = await rowTasks();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toMatchObject({
        dataset_row_index: 1,
        ownerUserId: callerId,
        lastTriggerSource: 'user',
      });

      // Already active: no duplicate row task.
      expect((await patchStatus(paused.id, 'active')).status).toBe(200);
      expect(await rowTasks()).toHaveLength(1);
    } finally {
      await deleteDatasetTask(paused.id);
    }
  });

  describe('editing the dataset of a finished task', () => {
    const patchDataset = (id: string, body: Record<string, unknown>) =>
      fetch(`${baseUrl}/projects/${projectId}/dataset-tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const withTask = async (
      status: 'completed' | 'paused',
      run: (id: string) => Promise<void>,
    ) => {
      const task = await createDatasetTask({
        project_id: projectId,
        title: 'Extend {{name}}',
        description: 'Extend {{name}}',
        dataset: [{ name: 'Alpha' }],
        total_rows: 1,
        status,
      });
      try {
        await updateDatasetTask(task.id, {
          current_row_index: 1,
          completed_rows: 1,
        });
        await run(task.id);
      } finally {
        await deleteDatasetTask(task.id);
      }
    };

    const rowTasks = async (id: string) =>
      (await getTasksByProject(projectId)).filter(
        (t) => t.dataset_task_id === id,
      );

    test('adding rows reactivates a completed task and runs only the new rows', async () => {
      await withTask('completed', async (id) => {
        const response = await patchDataset(id, {
          dataset: [{ name: 'Alpha' }, { name: 'Beta' }],
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: 'active',
          total_rows: 2,
          completed_rows: 1,
          current_row_index: 1,
        });
        const spawned = await rowTasks(id);
        expect(spawned).toHaveLength(1);
        expect(spawned[0]).toMatchObject({ dataset_row_index: 1 });
      });
    });

    test('editing rows without adding any keeps a completed task completed', async () => {
      await withTask('completed', async (id) => {
        const response = await patchDataset(id, {
          dataset: [{ name: 'Changed' }],
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'completed' });
        expect(await rowTasks(id)).toHaveLength(0);
      });
    });

    test('adding rows keeps a paused task paused', async () => {
      await withTask('paused', async (id) => {
        const response = await patchDataset(id, {
          dataset: [{ name: 'Alpha' }, { name: 'Beta' }],
        });
        expect(await response.json()).toMatchObject({
          status: 'paused',
          total_rows: 2,
        });
        expect(await rowTasks(id)).toHaveLength(0);
      });
    });

    test('an explicit status wins over automatic reactivation', async () => {
      await withTask('completed', async (id) => {
        const response = await patchDataset(id, {
          status: 'paused',
          dataset: [{ name: 'Alpha' }, { name: 'Beta' }],
        });
        expect(await response.json()).toMatchObject({ status: 'paused' });
        expect(await rowTasks(id)).toHaveLength(0);
      });
    });
  });

  test('rejects an unknown status and leaves the stored status unchanged', async () => {
    const response = await patchStatus(datasetTaskId, 'bogus');
    expect(response.status).toBe(400);
    expect((await getDatasetTask(datasetTaskId))?.status).toBe('active');
  });
});
