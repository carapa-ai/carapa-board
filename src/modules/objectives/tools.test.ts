import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as db from '../../db.js';
import * as brain from './brain-client.js';
import * as folders from './objective-folder.js';
import * as events from './ws-events.js';
import * as runStats from './objective-run-stats.js';
import * as pipeline from '../kanban/task/pipeline.js';
import * as state from '../../state-manager.js';
import { registerObjectiveTools } from './tools.js';
import type { Objective } from './types.js';
import type { RegisteredGroup } from '../../types.js';

afterEach(() => mock.restore());

test('MCP objective creation and activation notify Brain without restarting it', async () => {
  const objective: Objective = {
    id: 'late-objective',
    project_id: 'test-brain-project',
    title: 'Late objective',
    description: '',
    status: 'draft',
    priority: 3,
    progress: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const group: RegisteredGroup = {
    name: 'Test',
    folder: objective.project_id,
    trigger: '',
    added_at: '',
    settings: {
      brainContainer: 'test-brain-agent-1',
      brainAuthToken: 'test-token',
    },
  };
  spyOn(db, 'createObjective').mockResolvedValue(objective);
  spyOn(db, 'getObjective').mockResolvedValue(objective);
  const update = spyOn(db, 'updateObjective').mockResolvedValue(objective);
  spyOn(folders, 'initObjectiveFolder').mockResolvedValue(true);
  spyOn(folders, 'writeObjectiveContext').mockResolvedValue(true);
  spyOn(events, 'broadcast').mockImplementation(() => {});
  spyOn(brain, 'resolveBrainUrl').mockReturnValue('http://brain.test:3150');
  const publish = spyOn(brain, 'publishEvent').mockImplementation(() => {});
  const publishState = spyOn(
    brain,
    'publishObjectiveStateEvent',
  ).mockResolvedValue();
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerObjectiveTools(
    server,
    {
      getRegisteredGroups: () => ({ test: group }),
      sendMessage: async () => {},
      registerGroup: () => {},
      updateGroup: () => {},
    },
    {
      group_folder: group.folder,
      permissions: { [group.folder]: ['objectives:*'] },
    },
  );

  await handlers.get('create_objective')!({
    group_folder: group.folder,
    title: objective.title,
  });
  expect(publish.mock.calls[0]).toEqual([
    'http://brain.test:3150',
    expect.objectContaining({
      type: 'objective_created',
      project_id: group.folder,
      objective_id: objective.id,
    }),
    group,
  ]);

  update.mockResolvedValue({ ...objective, status: 'active' });
  spyOn(runStats, 'aggregateRunStats').mockResolvedValue(null);
  spyOn(db, 'getObjective').mockResolvedValue({
    ...objective,
    status: 'active',
  });
  await handlers.get('update_objective')!({
    group_folder: group.folder,
    objective_id: objective.id,
    status: 'active',
  });
  expect(publishState.mock.calls[0]).toEqual([
    'http://brain.test:3150',
    expect.objectContaining({
      type: 'objective_updated',
      project_id: group.folder,
      objective_id: objective.id,
      data: { changes: { status: 'active' } },
    }),
    group,
  ]);
});

test('MCP objective tools reject undeclared arguments without running the handler', async () => {
  const getObjective = spyOn(db, 'getObjective');
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<any>
  >();
  registerObjectiveTools(
    {
      registerTool: (name: string, _def: unknown, handler: any) =>
        handlers.set(name, handler),
    } as unknown as McpServer,
    {
      getRegisteredGroups: () => ({}),
      sendMessage: async () => {},
      registerGroup: () => {},
      updateGroup: () => {},
    },
    { group_folder: 'p', permissions: { p: ['objectives:*'] } },
  );
  expect(handlers.size).toBe(8);
  for (const handler of handlers.values()) {
    const result = await handler({
      group_folder: 'p',
      objective_id: 'o',
      agent_cmd: 'secret-value',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('agent_cmd');
    expect(result.content[0].text).not.toContain('secret-value');
  }
  expect(getObjective).not.toHaveBeenCalled();
});

test('MCP update_objective drains linked card projects only when it activates the objective', async () => {
  const objective: Objective = {
    id: 'held-objective',
    project_id: 'obj-project',
    title: 'Held',
    description: '',
    status: 'draft',
    priority: 3,
    progress: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const cardGroup = { folder: 'card-project' } as RegisteredGroup;
  const getObjective = spyOn(db, 'getObjective').mockResolvedValue(objective);
  const update = spyOn(db, 'updateObjective');
  spyOn(db, 'getObjectiveTaskProjectIds').mockResolvedValue(['card-project']);
  spyOn(state, 'getGroupByFolder').mockReturnValue(cardGroup);
  spyOn(folders, 'writeObjectiveContext').mockResolvedValue(true);
  spyOn(events, 'broadcast').mockImplementation(() => {});
  spyOn(brain, 'publishEvent').mockImplementation(() => {});
  spyOn(brain, 'publishObjectiveStateEvent').mockResolvedValue();
  const drain = spyOn(pipeline, 'drainProjectQueue').mockRejectedValue(
    new Error('drain failed'),
  );
  let handler!: (args: Record<string, unknown>) => Promise<any>;
  registerObjectiveTools(
    {
      registerTool: (name: string, _def: unknown, h: any) => {
        if (name === 'update_objective') handler = h;
      },
    } as unknown as McpServer,
    {
      getRegisteredGroups: () => ({}),
      sendMessage: async () => {},
      registerGroup: () => {},
      updateGroup: () => {},
    },
    {
      group_folder: 'obj-project',
      permissions: { 'obj-project': ['objectives:*'] },
    },
  );
  const call = (args: Record<string, unknown>) =>
    handler({
      group_folder: 'obj-project',
      objective_id: objective.id,
      ...args,
    });

  update.mockResolvedValue({ ...objective, title: 'Renamed' });
  await call({ title: 'Renamed' });
  update.mockResolvedValue({ ...objective, status: 'paused' });
  await call({ status: 'paused' });
  expect(drain).not.toHaveBeenCalled();

  update.mockResolvedValue({ ...objective, status: 'active' });
  spyOn(runStats, 'aggregateRunStats').mockResolvedValue(null);
  getObjective.mockResolvedValueOnce(objective).mockResolvedValueOnce({
    ...objective,
    status: 'active',
  });
  const result = await call({ status: 'active' });
  expect(result.isError).toBeUndefined();
  expect(drain.mock.calls.map((c) => [c[0], c[1]])).toEqual([
    ['card-project', cardGroup],
  ]);

  getObjective.mockResolvedValue({ ...objective, status: 'active' });
  await call({ title: 'Again' });
  expect(drain).toHaveBeenCalledTimes(1);
});

test('MCP update_objective refuses activation at the cost limit and skips the queue drain', async () => {
  const paused: Objective = {
    id: 'budget-objective',
    project_id: 'obj-project',
    title: 'Budget',
    description: '',
    status: 'paused',
    priority: 3,
    progress: 0,
    cost_limit_usd: 5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const active = { ...paused, status: 'active' as const };
  const getObjective = spyOn(db, 'getObjective').mockResolvedValue(paused);
  spyOn(db, 'updateObjective').mockResolvedValue(active);
  const aggregate = spyOn(runStats, 'aggregateRunStats');
  spyOn(folders, 'writeObjectiveContext').mockResolvedValue(true);
  spyOn(events, 'broadcast').mockImplementation(() => {});
  spyOn(brain, 'publishEvent').mockImplementation(() => {});
  spyOn(brain, 'publishObjectiveStateEvent').mockResolvedValue();
  const drain = spyOn(pipeline, 'drainProjectQueue').mockResolvedValue();
  spyOn(db, 'getObjectiveTaskProjectIds').mockResolvedValue(['card-project']);
  spyOn(state, 'getGroupByFolder').mockReturnValue({
    folder: 'card-project',
  } as RegisteredGroup);
  let handler!: (args: Record<string, unknown>) => Promise<any>;
  registerObjectiveTools(
    {
      registerTool: (name: string, _def: unknown, h: any) => {
        if (name === 'update_objective') handler = h;
      },
    } as unknown as McpServer,
    {
      getRegisteredGroups: () => ({}),
      sendMessage: async () => {},
      registerGroup: () => {},
      updateGroup: () => {},
    },
    {
      group_folder: 'obj-project',
      permissions: { 'obj-project': ['objectives:*'] },
    },
  );
  const call = () =>
    handler({
      group_folder: 'obj-project',
      objective_id: paused.id,
      status: 'active',
    });

  // Over the limit: the stats refresh re-pauses the objective.
  aggregate.mockResolvedValue({ totalCostUsd: 5 } as never);
  const refused = await call();
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain('cost limit has been reached');
  expect(drain).not.toHaveBeenCalled();

  // Under the limit the objective stays active and drains.
  getObjective.mockResolvedValueOnce(paused).mockResolvedValueOnce(active);
  aggregate.mockResolvedValue({ totalCostUsd: 1 } as never);
  const accepted = await call();
  expect(accepted.isError).toBeUndefined();
  expect(drain).toHaveBeenCalledTimes(1);
});
