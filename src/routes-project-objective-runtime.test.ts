import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { createUser, initDatabase } from './db.js';
import { getGroupDir } from './group-dir.js';
import { resolveKanbanRuntimeSelection } from './lib/chat-agents.js';
import {
  createObjective,
  getObjective,
  updateObjectiveCostLimit,
} from './modules/objectives/db-objectives.js';
import { resolveObjectiveAgentRuntime } from './modules/objectives/objective-agent.js';
import { objectiveCostMetricsPath } from './modules/objectives/objective-cost-metrics.js';
import * as brainClient from './modules/objectives/brain-client.js';
import { getObjectiveDir } from './modules/objectives/objective-folder.js';
import { enforceObjectiveCostLimit } from './modules/objectives/objective-budget.js';
import * as pushTools from './modules/tools/push-tools.js';
import projectsRouter from './routes/projects.js';
import objectivesRouter from './routes/objectives.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from './state-manager.js';

const projectId = `route-objective-runtime-${process.pid}`;
const jid = `${projectId}@web`;
let server: Server;
let baseUrl: string;
let adminId: string;

afterEach(() => mock.restore());

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${projectId}-admin`, 'pw', 'admin')).id;
  await registerGroup(jid, {
    jid,
    name: 'Objective runtime route test',
    folder: projectId,
    trigger: '@objective-runtime',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { authUser: { id: adminId, role: 'admin' } });
    next();
  });
  app.use(projectsRouter);
  app.use(objectivesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

async function createObjectiveFixture({
  status = 'paused',
  costLimitUsd,
  totalCostUsd,
  historicalConversationCostUsd,
}: {
  status?: 'active' | 'paused';
  costLimitUsd?: number;
  totalCostUsd?: number;
  historicalConversationCostUsd?: number;
} = {}) {
  const objective = await createObjective({
    project_id: projectId,
    title: `Activation fixture ${Date.now()}-${Math.random()}`,
    description: '',
    status,
    priority: 0,
    deadline: null,
    progress: 0,
    metadata: null,
    trigger_config: null,
    eventRuntimeSelection: null,
  });
  if (costLimitUsd !== undefined) {
    await updateObjectiveCostLimit(objective.id, costLimitUsd);
  }
  const objectiveDir = getObjectiveDir(projectId, objective.id);
  fs.mkdirSync(objectiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(objectiveDir, 'state.json'),
    JSON.stringify({ status }),
  );
  if (historicalConversationCostUsd !== undefined) {
    fs.writeFileSync(
      objectiveCostMetricsPath(objectiveDir),
      JSON.stringify({ historicalConversationCostUsd }),
    );
  }
  if (totalCostUsd !== undefined) {
    fs.writeFileSync(
      path.join(objectiveDir, 'run-stats.jsonl'),
      `${JSON.stringify({
        runId: `run-${objective.id}`,
        timestamp: new Date().toISOString(),
        exitCode: 0,
        durationMs: 100,
        costUsd: totalCostUsd,
      })}\n`,
    );
  }
  return objective;
}

describe('PUT /projects/:pid/objectives/:oid activation outcome', () => {
  test('persists edit and direct activation when the current budget permits it', async () => {
    const publish = spyOn(
      brainClient,
      'publishObjectiveStateEvent',
    ).mockResolvedValue();
    const belowLimit = await createObjectiveFixture({
      costLimitUsd: 5,
      totalCostUsd: 4,
    });
    const editResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${belowLimit.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active', cost_limit_usd: 5 }),
      },
    );
    expect(editResponse.status).toBe(200);
    expect(((await editResponse.json()) as { status: string }).status).toBe(
      'active',
    );

    const detailResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${belowLimit.id}`,
    );
    expect(((await detailResponse.json()) as { status: string }).status).toBe(
      'active',
    );
    const listResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives`,
    );
    const listed = (await listResponse.json()) as Array<{
      id: string;
      status: string;
    }>;
    expect(listed.find((item) => item.id === belowLimit.id)?.status).toBe(
      'active',
    );
    expect((await getObjective(belowLimit.id))?.status).toBe('active');

    const unlimited = await createObjectiveFixture();
    const directResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${unlimited.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(directResponse.status).toBe(200);
    expect(((await directResponse.json()) as { status: string }).status).toBe(
      'active',
    );
    expect((await getObjective(unlimited.id))?.status).toBe('active');
    expect(publish.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.anything(),
          expect.objectContaining({
            type: 'objective_updated',
            objective_id: belowLimit.id,
            data: expect.objectContaining({
              changes: expect.objectContaining({ status: 'active' }),
            }),
          }),
        ]),
        expect.arrayContaining([
          expect.anything(),
          expect.objectContaining({
            type: 'objective_updated',
            objective_id: unlimited.id,
            data: expect.objectContaining({
              changes: expect.objectContaining({ status: 'active' }),
            }),
          }),
        ]),
      ]),
    );
  });

  test('keeps Brain state isolated when detail refreshes overlap activation', async () => {
    const objective = await createObjectiveFixture({
      costLimitUsd: 5,
      totalCostUsd: 2,
    });

    const [firstDetail, secondDetail, activation] = await Promise.all([
      fetch(`${baseUrl}/projects/${projectId}/objectives/${objective.id}`),
      fetch(`${baseUrl}/projects/${projectId}/objectives/${objective.id}`),
      fetch(`${baseUrl}/projects/${projectId}/objectives/${objective.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
    ]);

    expect(firstDetail.status).toBe(200);
    expect(secondDetail.status).toBe(200);
    expect(activation.status).toBe(200);
    expect(await activation.json()).toMatchObject({ status: 'active' });

    const refreshed = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
    );
    expect(await refreshed.json()).toMatchObject({ status: 'active' });
    expect((await getObjective(objective.id))?.status).toBe('active');
    const objectiveDir = getObjectiveDir(projectId, objective.id);
    // This harness has no Brain event consumer. Board refreshes must leave the
    // external service's full-file snapshot untouched.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(objectiveDir, 'state.json'), 'utf8'),
      ),
    ).toEqual({ status: 'paused' });
    expect(
      JSON.parse(
        fs.readFileSync(objectiveCostMetricsPath(objectiveDir), 'utf8'),
      ),
    ).toMatchObject({ autonomousCostUsd: 2, totalCostUsd: 2 });
  });

  test('orders a budget pause before a same-save limit increase and activation', async () => {
    const objective = await createObjectiveFixture({
      status: 'active',
      costLimitUsd: 5,
      totalCostUsd: 5,
    });
    let notificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notificationStarted = resolve;
    });
    let releaseNotification!: () => void;
    const notificationReleased = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    spyOn(pushTools, 'notifyProjectOwner').mockImplementation(async () => {
      notificationStarted();
      await notificationReleased;
      return true;
    });

    const pause = enforceObjectiveCostLimit(projectId, objective.id, 5);
    await started;
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'active', cost_limit_usd: 6 }),
        },
      );
    } finally {
      releaseNotification();
    }
    await pause;

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      status: 'active',
      cost_limit_usd: 6,
    });
    expect((await getObjective(objective.id))?.status).toBe('active');
    const outbox = JSON.parse(
      fs.readFileSync(
        brainClient.objectiveStateEventOutboxPath(projectId, objective.id),
        'utf8',
      ),
    ) as {
      events: Array<{
        event: { data: Record<string, unknown> };
      }>;
    };
    expect(outbox.events.map(({ event }) => event.data)).toEqual([
      {
        changes: { status: 'paused' },
        reason: 'cost_limit_reached',
        totalCostUsd: 5,
        costLimitUsd: 5,
      },
      { changes: { status: 'active', cost_limit_usd: 6 } },
    ]);
  });

  test('rejects exhausted activation and accepts a raised or removed limit in the same edit', async () => {
    const objective = await createObjectiveFixture({
      costLimitUsd: 5,
      totalCostUsd: 5,
    });
    const blockedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(blockedResponse.status).toBe(409);
    expect(await blockedResponse.json()).toEqual({
      error:
        "The objective's cost limit has been reached. Raise or remove the cost limit to resume it.",
    });
    expect((await getObjective(objective.id))?.status).toBe('paused');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(getObjectiveDir(projectId, objective.id), 'state.json'),
          'utf8',
        ),
      ).status,
    ).toBe('paused');

    const raisedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active', cost_limit_usd: 6 }),
      },
    );
    expect(raisedResponse.status).toBe(200);
    expect(((await raisedResponse.json()) as { status: string }).status).toBe(
      'active',
    );
    const raisedDetail = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
    );
    expect(((await raisedDetail.json()) as { status: string }).status).toBe(
      'active',
    );

    await fetch(`${baseUrl}/projects/${projectId}/objectives/${objective.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    const clearedResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active', cost_limit_usd: null }),
      },
    );
    expect(clearedResponse.status).toBe(200);
    expect(await clearedResponse.json()).toMatchObject({
      status: 'active',
      cost_limit_usd: null,
    });
    const clearedDetail = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
    );
    expect(await clearedDetail.json()).toMatchObject({
      status: 'active',
      cost_limit_usd: null,
    });
    const listResponse = await fetch(
      `${baseUrl}/projects/${projectId}/objectives`,
    );
    const listed = (await listResponse.json()) as Array<{
      id: string;
      status: string;
    }>;
    expect(listed.find((item) => item.id === objective.id)?.status).toBe(
      'active',
    );
    expect((await getObjective(objective.id))?.status).toBe('active');
  });

  test('explains an exhausted budget backed only by historical conversation cost', async () => {
    const objective = await createObjectiveFixture({
      costLimitUsd: 5,
      historicalConversationCostUsd: 5,
    });
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "The objective's cost limit has been reached. Raise or remove the cost limit to resume it.",
    });
    expect((await getObjective(objective.id))?.status).toBe('paused');

    const objectiveDir = getObjectiveDir(projectId, objective.id);
    fs.writeFileSync(
      path.join(objectiveDir, 'state.json'),
      JSON.stringify({ status: 'paused', lastSessionId: 'brain-rewrite' }),
    );
    const refresh = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
    );
    expect(
      (await refresh.json()) as { runStats: { totalCostUsd: number } },
    ).toMatchObject({ runStats: { totalCostUsd: 5 } });

    const retry = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(retry.status).toBe(409);
    expect((await getObjective(objective.id))?.status).toBe('paused');
  });

  test('leaves the objective paused when validation rejects the update', async () => {
    const objective = await createObjectiveFixture();
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'not-a-status' }),
      },
    );
    expect(response.status).toBe(400);
    expect((await getObjective(objective.id))?.status).toBe('paused');
  });
});

afterAll(async () => {
  server.close();
  await unregisterGroup(jid);
  fs.rmSync(getGroupDir(projectId), { recursive: true, force: true });
});

describe('PATCH /projects/:pid objective event runtime inheritance', () => {
  test('publishes inherited runtime changes without mutating Brain-owned state', async () => {
    const publish = spyOn(
      brainClient,
      'publishObjectiveStateEvent',
    ).mockResolvedValue();
    const objective = await createObjective({
      project_id: projectId,
      title: 'Inherited event runtime',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      metadata: null,
      trigger_config: null,
      eventRuntimeSelection: null,
    });
    const objectiveDir = getObjectiveDir(projectId, objective.id);
    fs.mkdirSync(objectiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(objectiveDir, 'state.json'),
      JSON.stringify({
        status: 'active',
        lastSessionId: 'brain-session',
        agentCmd: 'stale-runtime',
        agentModel: 'stale-model',
      }),
    );

    const projectRuntime = resolveKanbanRuntimeSelection([]).selection;
    const response = await fetch(`${baseUrl}/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: { kanbanRuntimeSelection: projectRuntime },
      }),
    });

    expect(response.status).toBe(200);
    const group = getGroupByFolder(projectId)!;
    expect(group.settings?.kanbanRuntimeSelection).toEqual(projectRuntime);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(objectiveDir, 'state.json'), 'utf8'),
      ),
    ).toEqual({
      status: 'active',
      lastSessionId: 'brain-session',
      agentCmd: 'stale-runtime',
      agentModel: 'stale-model',
    });
    expect(resolveObjectiveAgentRuntime(group, null).selection).toEqual(
      projectRuntime,
    );
    expect(
      (await getObjective(objective.id))!.eventRuntimeSelection,
    ).toBeNull();
    expect(publish).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: 'objective_updated',
        project_id: projectId,
        objective_id: objective.id,
        data: expect.objectContaining({ reason: 'project_runtime_changed' }),
      }),
      group,
    );
  });
});

describe('GET /projects/:pid/objectives/:oid/runs model and cache metrics', () => {
  test('returns model and cacheCreationTokens, defaulting them for legacy lines', async () => {
    const objective = await createObjectiveFixture();
    const objectiveDir = getObjectiveDir(projectId, objective.id);
    fs.writeFileSync(
      path.join(objectiveDir, 'run-stats.jsonl'),
      [
        {
          runId: 'run-legacy',
          triggerType: 'task_completed',
          durationMs: 1000,
          inputTokens: 5,
          outputTokens: 7,
          cacheReadTokens: 11,
          exitCode: 0,
        },
        {
          runId: 'run-current',
          triggerType: 'task_completed',
          durationMs: 797475,
          numSteps: 38,
          model: 'claude-opus-5-5',
          costUsd: 9.47,
          inputTokens: 52,
          outputTokens: 18154,
          cacheReadTokens: 2929361,
          cacheCreationTokens: 519528,
          exitCode: 0,
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/objectives/${objective.id}/runs`,
    );
    expect(response.status).toBe(200);
    const { runs } = (await response.json()) as {
      runs: Array<Record<string, unknown>>;
    };
    const byId = Object.fromEntries(runs.map((run) => [run.runId, run]));
    expect(byId['run-current']).toMatchObject({
      model: 'claude-opus-5-5',
      cacheCreationTokens: 519528,
      cacheReadTokens: 2929361,
      inputTokens: 52,
      outputTokens: 18154,
      costUsd: 9.47,
    });
    expect(byId['run-legacy']).toMatchObject({
      model: null,
      cacheCreationTokens: 0,
      cacheReadTokens: 11,
    });
  });
});
