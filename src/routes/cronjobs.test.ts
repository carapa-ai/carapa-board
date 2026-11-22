import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createCronjob,
  deleteCronjob,
  getCronjob,
  getTasksByProject,
  initDatabase,
  createUser,
} from '../db.js';
import { truncateTestDb } from '../test-helpers.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import cronjobsRouter from './cronjobs.js';

describe('cronjob route validation', () => {
  const projectId = 'cronjob-route-validation';
  let cronjobId = '';
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    await initDatabase(':memory:');
    await truncateTestDb();
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Validated schedule',
      description: '',
      cron_expression: '0 * * * *',
      queue_mode: 'always',
      status: 'active',
      next_run: new Date(Date.now() + 60_000).toISOString(),
    });
    cronjobId = cronjob.id;

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      const auth = req.header('x-test-auth');
      if (auth) req.authUser = JSON.parse(auth);
      next();
    });
    app.use(cronjobsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (cronjobId) await deleteCronjob(cronjobId);
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  test('rejects an empty cron expression without corrupting the schedule', async () => {
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/cronjobs/${cronjobId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cron_expression: '' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid cron expression' });
    expect((await getCronjob(cronjobId))?.cron_expression).toBe('0 * * * *');
  });

  test('does not create a cronjob for a project that does not exist', async () => {
    const response = await fetch(
      `${baseUrl}/projects/missing-cronjob-project/cronjobs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Orphaned schedule',
          description: '',
          cron_expression: '0 * * * *',
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Project not found' });
  });

  test('rejects resuming a legacy cronjob with an invalid expression', async () => {
    const staleNextRun = new Date(Date.now() - 60_000).toISOString();
    const invalidCronjob = await createCronjob({
      project_id: projectId,
      title: 'Invalid legacy schedule',
      description: '',
      cron_expression: 'not a cron expression',
      queue_mode: 'always',
      status: 'paused',
      next_run: staleNextRun,
    });

    try {
      const response = await fetch(
        `${baseUrl}/projects/${projectId}/cronjobs/${invalidCronjob.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Invalid cron expression',
      });
      expect(await getCronjob(invalidCronjob.id)).toMatchObject({
        status: 'paused',
        next_run: staleNextRun,
      });
    } finally {
      await deleteCronjob(invalidCronjob.id);
    }
  });

  test.each(['paused'] as const)(
    'does not strand a task when manually running a cronjob in a %s project',
    async (status) => {
      const pausedProjectId = `manual-run-${status}`;
      const jid = `${pausedProjectId}@test`;
      const cronjob = await createCronjob({
        project_id: pausedProjectId,
        title: 'Must not be created',
        description: '',
        cron_expression: '0 * * * *',
        queue_mode: 'always',
        status: 'active',
        next_run: new Date(Date.now() + 60_000).toISOString(),
      });

      await loadState();
      await registerGroup(jid, {
        jid,
        name: pausedProjectId,
        folder: pausedProjectId,
        trigger: '',
        added_at: new Date().toISOString(),
        settings: { status },
      });

      try {
        const response = await fetch(
          `${baseUrl}/projects/${pausedProjectId}/cronjobs/${cronjob.id}/run`,
          { method: 'POST' },
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: `Project is ${status}. Start the project first.`,
        });
        expect(await getTasksByProject(pausedProjectId)).toHaveLength(0);
      } finally {
        await deleteCronjob(cronjob.id);
        await unregisterGroup(jid);
      }
    },
  );

  test('attributes a manual cronjob run to the authenticated user', async () => {
    const manualProjectId = 'manual-run-attribution';
    const jid = `${manualProjectId}@test`;
    const owner = await createUser('manual-cron-owner', 'pw', 'user');
    const user = await createUser('manual-cron-triggerer', 'pw', 'user');
    await registerGroup(jid, {
      id: manualProjectId,
      jid,
      name: manualProjectId,
      folder: manualProjectId,
      trigger: '',
      added_at: new Date().toISOString(),
      user_id: owner.id,
      settings: {
        status: 'running',
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
    const cronjob = await createCronjob({
      project_id: manualProjectId,
      title: 'Run by a person',
      description: '',
      cron_expression: '0 * * * *',
      queue_mode: 'always',
      model: 'legacy-model',
      agent_name: 'legacy-agent',
      runtimeSelection: {
        harnessId: 'codex',
        modelId: 'gpt-5.6-sol',
        reasoning: 'high',
      },
      status: 'active',
      next_run: new Date(Date.now() + 60_000).toISOString(),
    });

    try {
      const response = await fetch(
        `${baseUrl}/projects/${manualProjectId}/cronjobs/${cronjob.id}/run`,
        {
          method: 'POST',
          headers: {
            'x-test-auth': JSON.stringify({ id: user.id, role: 'user' }),
          },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { task: Record<string, unknown> };
      expect(body.task).toMatchObject({
        ownerUserId: user.id,
        lastTriggeredByUserId: user.id,
        lastTriggerSource: 'user',
        runtimeSelection: cronjob.runtimeSelection,
      });
      expect('model' in body.task).toBe(false);
      expect('agent_name' in body.task).toBe(false);
    } finally {
      await deleteCronjob(cronjob.id);
      await unregisterGroup(jid);
    }
  });
});
