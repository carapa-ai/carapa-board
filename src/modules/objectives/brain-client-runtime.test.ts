import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import fs from 'fs';
import path from 'path';
import { readFile, rm } from 'fs/promises';

import { DATA_DIR } from '../../config.js';
import { initDatabase } from '../../db.js';
import { getGroupDir } from '../../group-dir.js';
import { logger } from '../../logger.js';
import {
  getChatAgents,
  reloadChatAgents,
  resolveKanbanRuntimeSelection,
  validateRuntimeSelection,
} from '../../lib/chat-agents.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../../state-manager.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  attachObjectiveAgentRuntime,
  getBrainAuthStatus,
  objectiveStateEventOutboxPath,
  publishEvent,
  publishObjectiveStateEvent,
  reconcilePendingObjectiveStateEvents,
  refreshBrainPortCache,
  resolveBrainUrl,
  type BrainEvent,
} from './brain-client.js';
import { createObjective, getObjective } from './db-objectives.js';
import {
  resolveObjectiveRuntimeTiers,
  resolveProjectRuntimeTiers,
  RuntimeTiersHarnessError,
} from './objective-runtime-tiers.js';
import { resolveEffectiveSandbox } from '../../sandbox/effective-settings.js';
import { createTask, updateTask } from '../../db.js';
import { insertActiveRun } from '../../db/active-runs.js';
import * as taskObjectiveEvents from '../kanban/task/objective-events.js';
import { runFixture, taskFixture } from '../../test-helpers.js';

const PROJECT_ID = 'objective-runtime-project';
const GROUP_ID = 'objective-runtime-group';
const TEST_RUNTIME_ID = 'codex:objective-review-model';

const originalIngressHost = process.env.BRAIN_INGRESS_HOST;
let initialized = false;
beforeEach(async () => {
  delete process.env.BRAIN_INGRESS_HOST;
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await truncateTestDb();
  for (const key of Object.keys(registeredGroups)) delete registeredGroups[key];
  registeredGroups[GROUP_ID] = {
    folder: PROJECT_ID,
    name: 'Legacy objective project',
    settings: {
      kanbanRuntimeSelection: resolveKanbanRuntimeSelection([]).selection,
      defaultAgent: 'must-not-win-over-structured-kanban',
    } as unknown as (typeof registeredGroups)[string]['settings'],
  } as (typeof registeredGroups)[string];
  // Rebuild the folder index so getGroupByFolder never returns a prior test's group.
  applyGroupUpdateInMemory(GROUP_ID, {});
});

// Shared-process suites read the strictest privacy mode of every registered
// group, so do not leave this file's strict project registered.
afterAll(() => {
  for (const key of Object.keys(registeredGroups)) delete registeredGroups[key];
});

afterEach(async () => {
  if (originalIngressHost === undefined) delete process.env.BRAIN_INGRESS_HOST;
  else process.env.BRAIN_INGRESS_HOST = originalIngressHost;
  mock.restore();
  const agents = getChatAgents({ watch: false });
  const testRuntimeIndex = agents.findIndex(
    (agent) => agent.id === TEST_RUNTIME_ID,
  );
  if (testRuntimeIndex >= 0) agents.splice(testRuntimeIndex, 1);
  await rm(getGroupDir(PROJECT_ID), { recursive: true, force: true });
});

async function objectiveEvent(
  data: Record<string, unknown> = {},
  runtime: {
    eventRuntimeSelection?: {
      harnessId: string;
      modelId: string;
      reasoning?: string;
    };
  } = {},
): Promise<BrainEvent> {
  const objective = await createObjective({
    project_id: PROJECT_ID,
    title: 'Objective runtime',
    description: '',
    status: 'active',
    priority: 0,
    deadline: null,
    progress: 0,
    metadata: null,
    trigger_config: null,
    eventRuntimeSelection: runtime.eventRuntimeSelection,
  });
  return {
    type: 'task_completed',
    project_id: PROJECT_ID,
    objective_id: objective.id,
    timestamp: new Date().toISOString(),
    data,
  };
}

describe('attachObjectiveAgentRuntime', () => {
  test('publishes inherited runtime metadata without persisting an override', async () => {
    const event = await objectiveEvent();

    const attached = await attachObjectiveAgentRuntime(event);
    const persisted = await getObjective(event.objective_id!);
    const inherited = resolveKanbanRuntimeSelection([]);

    expect(attached.data.agent_cmd).toBe(inherited.agent.id);
    expect(attached.data.runtime_selection).toEqual(inherited.selection);
    expect(persisted!.eventRuntimeSelection).toBeNull();
    expect(attached.data.agent_executable).toBe(
      inherited.agent.agentCmd || inherited.agent.id,
    );
  });

  test('does not let event data replace the objective event runtime', async () => {
    const event = await objectiveEvent({
      agent_cmd: 'chat-composer-runtime',
      reasoning_effort: 'chat-effort',
    });
    const inherited = resolveKanbanRuntimeSelection([]);

    const attached = await attachObjectiveAgentRuntime(event);

    expect(attached.data.agent_cmd).toBe(inherited.agent.id);
    expect(attached.data.reasoning_effort).not.toBe('chat-effort');
  });

  test('publishes a persisted override with mapped effort and coherent launch identity', async () => {
    const selection = {
      harnessId: 'codex',
      modelId: 'objective-review-model',
      reasoning: 'high',
    };
    const agents = getChatAgents({ watch: false });
    const runtime = {
      id: TEST_RUNTIME_ID,
      label: 'Objective review runtime',
      harnessId: selection.harnessId,
      harnessKind: 'cli' as const,
      modelId: selection.modelId,
      agentCmd: 'codex',
      model: 'objective-provider-model',
      sessionFamily: 'codex',
      reasoningOptions: ['low', 'high'],
      reasoningDefault: 'low',
      reasoningMap: { high: 'xhigh' },
    };
    agents.push(runtime);
    expect(validateRuntimeSelection(selection)).toBeNull();
    expect(selection).not.toEqual(
      registeredGroups[GROUP_ID].settings?.kanbanRuntimeSelection,
    );

    const event = await objectiveEvent(
      {},
      { eventRuntimeSelection: selection },
    );
    let request: { url: string; init?: RequestInit } | undefined;
    let resolveRequest!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
      request = { url: String(url), init };
      resolveRequest();
      return new Response(null, { status: 202 });
    }) as typeof fetch);

    publishEvent('http://brain.test', event, {
      settings: { brainAuthToken: 'brain-token' },
    });
    await requestReceived;

    expect(request?.url).toBe('http://brain.test/events');
    expect(request?.init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer brain-token',
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      type: 'task_completed',
      timestamp: event.timestamp,
      payload: {
        project_id: PROJECT_ID,
        objective_id: event.objective_id,
        agent_cmd: runtime.id,
        agent_model: runtime.model,
        agent_executable: 'codex',
        agent_session_key: 'codex@relay',
        runtime_selection: selection,
        reasoning_effort: 'xhigh',
      },
    });
    expect(
      (await getObjective(event.objective_id!))!.eventRuntimeSelection,
    ).toEqual(selection);
  });
});

describe('objective runtime tiers', () => {
  const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
  let previousAgents: string | undefined;

  beforeAll(() => {
    previousAgents = fs.existsSync(agentsFile)
      ? fs.readFileSync(agentsFile, 'utf8')
      : undefined;
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    const cli = (agentCmd: string) => ({
      label: agentCmd,
      kind: 'cli',
      agentCmd,
      sessionFamily: agentCmd,
    });
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        version: 2,
        harnesses: {
          codex: cli('codex'),
          claude: cli('claude'),
          plain: cli('plain'),
        },
        models: {
          'claude-big': {
            label: 'Claude big',
            reasoning: { options: ['turbo'] },
            bindings: { claude: { model: 'm-claude' } },
          },
          small: {
            label: 'Small',
            reasoning: { options: ['low', 'high'], default: 'low' },
            bindings: { codex: { model: 'm-fast', locality: 'local' } },
          },
          medium: {
            label: 'Medium',
            reasoning: { options: ['low', 'high'], default: 'low' },
            bindings: { codex: { model: 'm-mid' } },
          },
          large: {
            label: 'Large',
            reasoning: { options: ['low', 'high'], default: 'low' },
            bindings: { codex: { model: 'm-top' } },
          },
          solo: { label: 'Solo', bindings: { plain: { model: 'm-solo' } } },
          auto: {
            label: 'Auto',
            auto: true,
            bindings: {
              codex: {
                tiers: { fast: 'small', balanced: 'medium', frontier: 'large' },
              },
              // Claude's Auto routes to Codex candidates.
              claude: {
                tiers: {
                  fast: ['codex:small'],
                  balanced: ['codex:medium'],
                  frontier: ['codex:large', 'claude:claude-big'],
                },
              },
            },
          },
        },
        defaults: {
          chat: { harnessId: 'codex', modelId: 'medium' },
          kanban: {
            fallback: { harnessId: 'codex', modelId: 'medium' },
            stages: {},
          },
        },
      }),
    );
    reloadChatAgents();
  });

  afterAll(() => {
    if (previousAgents === undefined) fs.rmSync(agentsFile, { force: true });
    else fs.writeFileSync(agentsFile, previousAgents);
    reloadChatAgents();
  });

  const objectiveOn = async (harnessId: string, modelId: string) =>
    createObjective({
      project_id: PROJECT_ID,
      title: 'Tiers',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      metadata: null,
      trigger_config: null,
      eventRuntimeSelection: { harnessId, modelId },
    });

  test('a tier resolves to a cross-harness candidate with its own identity', async () => {
    const objective = await objectiveOn('claude', 'claude-big');
    const event = await attachObjectiveAgentRuntime({
      type: 'cron',
      project_id: PROJECT_ID,
      objective_id: objective.id,
      timestamp: new Date().toISOString(),
      data: {},
    });

    const result = resolveObjectiveRuntimeTiers(objective);

    expect(result.effective).toMatchObject(event.data);
    expect(result.unavailableTiers).toEqual([]);
    expect(Object.keys(result.tiers)).toEqual(['fast', 'balanced', 'frontier']);
    expect(result.tiers.frontier).toMatchObject({
      agent_cmd: 'codex:large',
      agent_model: 'm-top',
      agent_executable: 'codex',
      agent_session_key: 'codex@relay',
      runtime_selection: { harnessId: 'codex', modelId: 'large' },
      fallback_model: null,
    });
    expect(result.tiers.fast).toMatchObject({ agent_model: 'm-fast' });
  });

  test('a tier that privacy mode forbids is omitted and listed as unavailable', async () => {
    registeredGroups[GROUP_ID].settings = {
      ...registeredGroups[GROUP_ID].settings,
      privacyMode: 'strict',
    } as (typeof registeredGroups)[string]['settings'];
    applyGroupUpdateInMemory(GROUP_ID, {});
    const objective = await objectiveOn('codex', 'small');

    const result = resolveObjectiveRuntimeTiers(objective);

    expect(Object.keys(result.tiers)).toEqual(['fast']);
    expect(result.unavailableTiers.map((item) => item.tier)).toEqual([
      'balanced',
      'frontier',
    ]);
    expect(result.unavailableTiers[0]!.reason).toBeTruthy();
  });

  test('a harness without a tier map has no tiers', async () => {
    const result = resolveObjectiveRuntimeTiers(
      await objectiveOn('plain', 'solo'),
    );

    expect(result.effective).toMatchObject({ agent_model: 'm-solo' });
    expect(result.tiers).toEqual({});
    expect(result.unavailableTiers).toEqual([
      { tier: 'fast', reason: 'no auto tier map for harness plain' },
      { tier: 'balanced', reason: 'no auto tier map for harness plain' },
      { tier: 'frontier', reason: 'no auto tier map for harness plain' },
    ]);
  });

  describe('project runtime tiers without an objective', () => {
    beforeEach(() => {
      // The sandbox stack has codex installed, not claude.
      spyOn(getSandboxClient(), 'callTool').mockResolvedValue({
        isError: false,
        stdout: JSON.stringify([
          {
            name: resolveEffectiveSandbox(registeredGroups[GROUP_ID]!).stack,
            harnesses: ['codex'],
          },
        ]),
      } as Awaited<
        ReturnType<ReturnType<typeof getSandboxClient>['callTool']>
      >);
    });

    test('a harness override resolves that harness tier map', async () => {
      const result = await resolveProjectRuntimeTiers(PROJECT_ID, 'codex');

      expect(result.unavailableTiers).toEqual([]);
      expect(result.tiers.frontier).toMatchObject({ agent_model: 'm-top' });
      expect(result.tiers.fast).toMatchObject({ agent_model: 'm-fast' });
      expect(result.effective).toMatchObject({ agent_model: 'm-mid' });
    });

    test('the project reasoning is not carried to another harness', async () => {
      registeredGroups[GROUP_ID].settings = {
        ...registeredGroups[GROUP_ID].settings,
        kanbanRuntimeSelection: {
          harnessId: 'claude',
          modelId: 'claude-big',
          reasoning: 'turbo',
        },
      } as (typeof registeredGroups)[string]['settings'];
      applyGroupUpdateInMemory(GROUP_ID, {});

      const result = await resolveProjectRuntimeTiers(PROJECT_ID, 'codex');

      expect(result.unavailableTiers).toEqual([]);
      expect(result.tiers.frontier).toMatchObject({
        reasoning_effort: 'low',
      });
    });

    test('a harness the project cannot run yields no contracts', async () => {
      await expect(
        resolveProjectRuntimeTiers(PROJECT_ID, 'claude'),
      ).rejects.toBeInstanceOf(RuntimeTiersHarnessError);
      await expect(
        resolveProjectRuntimeTiers(PROJECT_ID, 'nope'),
      ).rejects.toBeInstanceOf(RuntimeTiersHarnessError);
    });

    test('without a harness the project layer decides', async () => {
      const result = await resolveProjectRuntimeTiers(PROJECT_ID);

      expect(result.effective).toMatchObject({ agent_model: 'm-mid' });
      expect(Object.keys(result.tiers)).toEqual([
        'fast',
        'balanced',
        'frontier',
      ]);
    });
  });
});

describe('durable objective state events', () => {
  test('replays an acknowledged state update after Brain credentials and availability recover', async () => {
    const event = await objectiveEvent({ changes: { status: 'active' } });
    event.type = 'objective_updated';
    const group = registeredGroups[GROUP_ID];
    const requests: Array<{
      url: string;
      init?: RequestInit;
      accepted: boolean;
    }> = [];
    let brainAvailable = false;
    spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
      // Other suites can leave fire-and-forget work in this shared process.
      // Count only delivery of this test's uniquely identified objective.
      let body: { payload?: { objective_id?: string } } | null = null;
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      } catch {
        // Unrelated requests need not use the Brain event wire format.
      }
      if (body?.payload?.objective_id === event.objective_id) {
        requests.push({ url: String(url), init, accepted: brainAvailable });
      }
      return new Response(brainAvailable ? null : 'unavailable', {
        status: brainAvailable ? 202 : 503,
      });
    }) as typeof fetch);

    await publishObjectiveStateEvent('http://brain.test', event, group);
    // Publishing returns after persistence, before its background flush ends.
    // Join that flush while credentials are still absent before changing them.
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);

    const outboxPath = objectiveStateEventOutboxPath(
      PROJECT_ID,
      event.objective_id!,
    );
    expect(JSON.parse(await readFile(outboxPath, 'utf-8')).events).toHaveLength(
      1,
    );
    expect(requests).toHaveLength(0);

    group.settings = { ...group.settings, brainAuthToken: 'brain-token' };
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((request) => request.accepted)).toBe(false);
    expect(JSON.parse(await readFile(outboxPath, 'utf-8')).events).toHaveLength(
      1,
    );

    brainAvailable = true;
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);

    const delivered = requests.find((request) => request.accepted);
    expect(delivered?.url).toBe('http://brain.test/events');
    expect(delivered?.init?.headers).toMatchObject({
      Authorization: 'Bearer brain-token',
    });
    expect(JSON.parse(String(delivered?.init?.body))).toMatchObject({
      type: 'objective_updated',
      payload: {
        project_id: PROJECT_ID,
        objective_id: event.objective_id,
        changes: { status: 'active' },
      },
    });
    expect(
      await readFile(outboxPath, 'utf-8').catch(
        (err: NodeJS.ErrnoException) => err.code,
      ),
    ).toBe('ENOENT');
  });

  test('replays against the currently configured Brain endpoint after migration', async () => {
    const event = await objectiveEvent({ changes: { status: 'active' } });
    event.type = 'objective_updated';
    const group = registeredGroups[GROUP_ID];
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 202 }),
    );
    const sandboxPs = spyOn(getSandboxClient(), 'sandboxPs').mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'current-brain',
          services: [
            {
              service: 'carapa-brain',
              hostname: 'current-brain-container',
              status: 'running',
            },
          ],
          ingress: [
            {
              service: 'carapa-brain',
              kind: 'http',
              host: 'box.test',
              port: 43112,
              direct: true,
            },
          ],
        },
      ]),
      isError: false,
    });

    await publishObjectiveStateEvent('http://old-brain.test', event, group);
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
    group.settings = {
      ...group.settings,
      brainAuthToken: 'brain-token',
      brainContainer: 'current-brain-container',
    };
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);

    expect(sandboxPs).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://box.test:43112/events');
    expect(
      await readFile(
        objectiveStateEventOutboxPath(PROJECT_ID, event.objective_id!),
        'utf-8',
      ).catch((err: NodeJS.ErrnoException) => err.code),
    ).toBe('ENOENT');
  });
});

// Protect durable delivery across the controller's Docker-port → ingress migration.
test.each([undefined, 'ingress-edge.test'])(
  'delivers retained state through ingress with host override %s',
  async (override) => {
    if (override) process.env.BRAIN_INGRESS_HOST = override;
    const expectedHost = override || 'box.test';
    const fixtures = [
      {
        name: 'demo-site-demo-site',
        service: 'php84',
        targetPort: 3100,
        port: 22155,
      },
      {
        name: 'llama-cpp-ninfer',
        service: 'agent',
        targetPort: 3150,
        port: 22180,
      },
    ];
    const instances = fixtures.map((fixture) => ({
      name: fixture.name,
      services: [
        {
          service: fixture.service,
          hostname: `${fixture.name}-${fixture.service}-1`,
          status: 'running',
        },
      ],
      ingress: [
        {
          service: 'nginx',
          targetPort: 80,
          kind: 'http',
          host: 'box.test',
          port: 22073,
        },
        {
          service: fixture.service,
          targetPort: 2222,
          kind: 'ssh',
          host: 'box.test',
          port: 22238,
        },
        ...(fixture.service === 'agent'
          ? [
              {
                service: 'agent',
                targetPort: 18881,
                kind: 'http',
                host: 'box.test',
                port: 22136,
              },
            ]
          : []),
        {
          service: fixture.service,
          targetPort: fixture.targetPort,
          kind: 'http',
          host: 'box.test',
          port: fixture.port,
        },
      ],
    }));
    spyOn(getSandboxClient(), 'sandboxPs').mockImplementation(async () => ({
      stdout: JSON.stringify(instances),
      isError: false,
    }));
    const delivered: string[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      url,
      init,
    ) => {
      const address = String(url);
      if (address.endsWith('/version')) {
        expect(init?.headers).toBeUndefined();
        expect(init?.body).toBeUndefined();
        return Response.json({
          service: address.startsWith(`http://${expectedHost}:22180/`)
            ? 'carapa-brain'
            : 'model-server',
        });
      }
      expect([
        `http://${expectedHost}:22155/events`,
        `http://${expectedHost}:22180/events`,
      ]).toContain(address);
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer brain-token',
      });
      delivered.push(address);
      return new Response(null, { status: 202 });
    }) as typeof fetch);

    for (const fixture of fixtures) {
      const group = registeredGroups[GROUP_ID];
      group.settings = {
        ...group.settings,
        brainAuthToken: undefined,
        brainContainer: `${fixture.name}-${fixture.service}-1`,
      };
      const event = await objectiveEvent({ changes: { status: 'active' } });
      event.type = 'objective_updated';
      await publishObjectiveStateEvent(null, event, group);
      await reconcilePendingObjectiveStateEvents(PROJECT_ID);
      const outbox = objectiveStateEventOutboxPath(
        PROJECT_ID,
        event.objective_id!,
      );
      expect(JSON.parse(await readFile(outbox, 'utf8')).events).toHaveLength(1);
      group.settings.brainAuthToken = 'brain-token';
      await reconcilePendingObjectiveStateEvents(PROJECT_ID);
      expect(delivered.at(-1)).toBe(
        `http://${expectedHost}:${fixture.port}/events`,
      );
      expect(
        await readFile(outbox, 'utf8').catch(
          (err: NodeJS.ErrnoException) => err.code,
        ),
      ).toBe('ENOENT');
    }
    expect(delivered).toHaveLength(2);
    const probes = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith('/version'),
    );
    expect(probes).toHaveLength(2); // Cached identity avoids repeat probes during outbox retries.
    instances.length = 0;
    await refreshBrainPortCache();
    expect(resolveBrainUrl('demo-site-demo-site-php84-1')).toBeNull();
    expect(resolveBrainUrl('llama-cpp-ninfer-agent-1')).toBeNull();
  },
);

describe('publishEvent project opt-in gate', () => {
  const PARENT_FOLDER = 'objective-runtime-parent';
  const CHILD_GROUP = {
    parentId: PARENT_FOLDER,
    settings: {},
  };

  function registerParent(): void {
    const jid = `${PARENT_FOLDER}-jid`;
    registeredGroups[jid] = {
      folder: PARENT_FOLDER,
      name: 'Parent',
      settings: { brainAuthToken: 'parent-token' },
    } as (typeof registeredGroups)[string];
    // Direct assignment bypasses the folder index used by getGroupByFolder.
    applyGroupUpdateInMemory(jid, {});
  }

  test('delivers objective-tagged events from a non-opted-in child, but skips untagged and tokenless ones', async () => {
    registerParent();
    const tagged = await objectiveEvent();
    const untagged: BrainEvent = { ...tagged, objective_id: null };
    const bodies: Array<{ headers: unknown; body: BrainEvent }> = [];
    let resolveRequest!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      bodies.push({
        headers: init?.headers,
        body: JSON.parse(String(init?.body)),
      });
      resolveRequest();
      return new Response(null, { status: 202 });
    }) as typeof fetch);

    // Skipped synchronously: no objective_id, and no token anywhere.
    publishEvent('http://brain.test', untagged, CHILD_GROUP);
    publishEvent('http://brain.test', tagged, { settings: {} });
    // Delivered: tagged, token resolved from the parent group.
    publishEvent('http://brain.test', tagged, CHILD_GROUP);
    await requestReceived;

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer parent-token',
    });
    expect(bodies[0]?.body).toMatchObject({
      type: 'task_completed',
      payload: { objective_id: tagged.objective_id },
    });
  });
});

describe('publishEvent objective-owner routing', () => {
  test('posts a tagged task event to the objective owner’s brain with the owner’s token, not the task project’s unresolvable one', async () => {
    applyGroupUpdateInMemory(GROUP_ID, {
      settings: {
        ...registeredGroups[GROUP_ID].settings,
        brainContainer: 'owner-brain-container',
        brainAuthToken: 'owner-token',
      },
    });
    // Task project: its own stale container and token, no parent.
    const taskGroup = {
      settings: {
        brainContainer: 'stale-brain-container',
        brainAuthToken: 'task-token',
      },
    };
    const event = {
      ...(await objectiveEvent()),
      project_id: 'task-project-a',
      task_id: 'task-1',
    };
    spyOn(getSandboxClient(), 'sandboxPs').mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'owner-stack',
          services: [
            {
              service: 'carapa-brain',
              hostname: 'owner-brain-container',
              status: 'running',
            },
          ],
          ingress: [
            {
              service: 'carapa-brain',
              kind: 'http',
              host: 'box.test',
              port: 43111,
              direct: true,
            },
          ],
        },
      ]),
      isError: false,
    });
    let resolveRequest!: (request: { url: string; headers: unknown }) => void;
    const requestReceived = new Promise<{ url: string; headers: unknown }>(
      (resolve) => {
        resolveRequest = resolve;
      },
    );
    spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
      resolveRequest({ url: String(url), headers: init?.headers });
      return new Response(null, { status: 202 });
    }) as typeof fetch);

    publishEvent(null, event, taskGroup);

    expect(await requestReceived).toEqual({
      url: 'http://box.test:43111/events',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
    });
  });
});

describe('publishEvent objective-tagged delivery', () => {
  const brainPs = (hostname: string) => ({
    stdout: JSON.stringify([
      {
        name: 'stack',
        services: [
          {
            service: 'carapa-brain',
            hostname,
            status: 'running',
          },
        ],
        ingress: [
          {
            service: 'carapa-brain',
            kind: 'http',
            host: 'box.test',
            port: 43111,
            direct: true,
          },
        ],
      },
    ]),
    isError: false,
  });

  /** Resolves with the arguments of the first warn call after `trigger`. */
  async function publishAndAwaitWarn(
    event: BrainEvent,
    group: Parameters<typeof publishEvent>[2],
  ) {
    const warnings: Array<Record<string, unknown>> = [];
    let resolveWarn!: () => void;
    const warned = new Promise<void>((resolve) => {
      resolveWarn = resolve;
    });
    spyOn(logger, 'warn').mockImplementation(((
      ctx: Record<string, unknown>,
    ) => {
      warnings.push(ctx);
      resolveWarn();
    }) as never);
    publishEvent(null, event, group);
    await warned;
    return warnings;
  }

  /** Like publishAndAwaitWarn, but resolves on the retry-exhausted warning. */
  async function publishAndAwaitGiveUp(
    event: BrainEvent,
    group: Parameters<typeof publishEvent>[2],
  ) {
    const warnings: Array<Record<string, unknown>> = [];
    let resolveGiveUp!: () => void;
    const gaveUp = new Promise<void>((resolve) => {
      resolveGiveUp = resolve;
    });
    spyOn(logger, 'warn').mockImplementation(((
      ctx: Record<string, unknown>,
      message?: string,
    ) => {
      warnings.push(ctx);
      if (message?.includes('giving up') || message?.includes('not retrying'))
        resolveGiveUp();
    }) as never);
    publishEvent('http://brain.test', event, group);
    await gaveUp;
    return warnings;
  }

  test('refreshes an empty port cache on a null URL and posts the event', async () => {
    const sandboxPs = spyOn(getSandboxClient(), 'sandboxPs');
    sandboxPs.mockResolvedValue({
      stdout: 'No running compose projects',
      isError: false,
    });
    await refreshBrainPortCache();
    expect(resolveBrainUrl('task-brain')).toBeNull();
    sandboxPs.mockResolvedValue(brainPs('task-brain'));
    let resolveUrl!: (url: string) => void;
    const posted = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    spyOn(globalThis, 'fetch').mockImplementation((async (url) => {
      resolveUrl(String(url));
      return new Response(null, { status: 202 });
    }) as typeof fetch);

    publishEvent(null, await objectiveEvent(), {
      settings: { brainContainer: 'task-brain', brainAuthToken: 'task-token' },
    });

    expect(await posted).toBe('http://box.test:43111/events');
  });

  test('never reads or delivers from an outbox leaf that is a symlink', async () => {
    const event = await objectiveEvent({ changes: { status: 'active' } });
    event.type = 'objective_updated';
    const outboxPath = objectiveStateEventOutboxPath(
      PROJECT_ID,
      event.objective_id!,
    );
    const planted = path.join(getGroupDir(PROJECT_ID), 'planted-outbox.json');
    fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
    fs.writeFileSync(
      planted,
      JSON.stringify({
        version: 1,
        events: [{ id: 'planted', brainUrl: 'http://brain.test', event }],
      }),
    );
    fs.symlinkSync(planted, outboxPath);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async (_url) => new Response(null, { status: 202 })) as typeof fetch,
    );

    await expect(
      reconcilePendingObjectiveStateEvents(PROJECT_ID),
    ).rejects.toThrow();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.readlinkSync(outboxPath)).toBe(planted);
  });

  const readOutboxEvents = async (projectId: string, objectiveId: string) =>
    JSON.parse(
      await readFile(
        objectiveStateEventOutboxPath(projectId, objectiveId),
        'utf-8',
      ),
    ).events as Array<{ event: BrainEvent }>;

  const outboxExists = (projectId: string, objectiveId: string) =>
    readFile(
      objectiveStateEventOutboxPath(projectId, objectiveId),
      'utf-8',
    ).then(
      () => true,
      () => false,
    );

  test('queues an unresolvable-container event in the owner outbox without posting, then replays it once with its outcome and original timestamp', async () => {
    const sandboxPs = spyOn(getSandboxClient(), 'sandboxPs');
    sandboxPs.mockResolvedValue(brainPs('other'));
    const requests: Array<Record<string, unknown>> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url,
      init,
    ) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as typeof fetch);
    // The task lives in project A; the objective is owned by PROJECT_ID.
    const event: BrainEvent = {
      ...(await objectiveEvent({ summary: 'done', merge_commit: 'abc123' })),
      project_id: 'task-project-a',
      task_id: 'task-queued-1',
    };
    const objectiveId = event.objective_id!;
    const taskGroup = {
      settings: { brainContainer: 'missing', brainAuthToken: 'task-token' },
    };

    const warnings = await publishAndAwaitWarn(event, taskGroup);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      dropReason: 'url_not_discoverable',
      task_id: 'task-queued-1',
      objective_id: objectiveId,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const queued = await readOutboxEvents(PROJECT_ID, objectiveId);
    expect(queued).toHaveLength(1);
    expect(queued[0].event).toMatchObject({
      type: 'task_completed',
      task_id: 'task-queued-1',
      timestamp: event.timestamp,
    });
    expect(await outboxExists('task-project-a', objectiveId)).toBe(false);

    // The brain becomes resolvable: reconciliation delivers the queued event.
    applyGroupUpdateInMemory(GROUP_ID, {
      settings: {
        ...registeredGroups[GROUP_ID].settings,
        brainContainer: 'missing',
        brainAuthToken: 'owner-token',
      },
    });
    sandboxPs.mockResolvedValue(brainPs('missing'));
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: 'task_completed',
      timestamp: event.timestamp,
      payload: {
        project_id: 'task-project-a',
        task_id: 'task-queued-1',
        objective_id: objectiveId,
        summary: 'done',
        merge_commit: 'abc123',
      },
    });
    expect(await outboxExists(PROJECT_ID, objectiveId)).toBe(false);
  });

  test('does not queue an http_4xx failure', async () => {
    const sandboxPs = spyOn(getSandboxClient(), 'sandboxPs');
    sandboxPs.mockResolvedValue(brainPs('task-brain'));
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad request', { status: 400 }),
    );
    const base = await objectiveEvent();
    const group = {
      settings: { brainContainer: 'task-brain', brainAuthToken: 'task-token' },
    };

    const warnings = await publishAndAwaitGiveUp(
      { ...base, task_id: 'task-4xx' },
      group,
    );
    expect(warnings.at(-1)).toMatchObject({ dropReason: 'http_400' });

    // Both enqueues share one per-path lock, so once the later retryable
    // event is queued, any enqueue by the 4xx event would already be on disk.
    sandboxPs.mockResolvedValue(brainPs('other'));
    await publishAndAwaitWarn(
      { ...base, task_id: 'task-retryable' },
      { settings: { ...group.settings, brainContainer: 'missing' } },
    );

    const queued = await readOutboxEvents(PROJECT_ID, base.objective_id!);
    expect(queued.map((pending) => pending.event.task_id)).toEqual([
      'task-retryable',
    ]);
  }, 15_000);

  test('warns once with no_token when no token is configured anywhere', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    const event = await objectiveEvent();
    const warnings = await publishAndAwaitWarn(event, {
      settings: { brainContainer: 'task-brain' },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ dropReason: 'no_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await outboxExists(PROJECT_ID, event.objective_id!)).toBe(false);
  });
});

describe('publishEvent task outcome data', () => {
  async function publishAndCapture(
    event: BrainEvent,
    group: { settings: Record<string, unknown> } = {
      settings: { brainAuthToken: 'brain-token' },
    },
  ) {
    let resolveRequest!: (body: { payload: Record<string, unknown> }) => void;
    const received = new Promise<{ payload: Record<string, unknown> }>(
      (resolve) => {
        resolveRequest = resolve;
      },
    );
    spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      resolveRequest(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as typeof fetch);
    publishEvent('http://brain.test', event, group);
    return (await received).payload;
  }

  async function taggedTask(
    overrides: Parameters<typeof taskFixture>[0] = {},
    objectiveId?: string,
  ) {
    const base = await objectiveEvent();
    const task = await createTask(
      taskFixture({
        project_id: PROJECT_ID,
        objective_id: objectiveId ?? base.objective_id,
        custom_values: { quality_score: 9, rejection_count: 1 },
        status: 'completed',
        ...overrides,
      }),
    );
    if (overrides.merge_commit !== null) {
      await updateTask(task.id, { merge_commit: 'deadbeef' });
    }
    await insertActiveRun({
      ...runFixture({
        id: `${task.id}-run`,
        task_id: task.id,
        group_folder: PROJECT_ID,
      }),
      cost_usd: 1.5,
    } as never);
    return { base, task };
  }

  test('task_completed carries outcome fields next to existing data', async () => {
    const { base, task } = await taggedTask();
    const payload = await publishAndCapture({
      ...base,
      task_id: task.id,
      data: {
        title: 'T',
        working_directory: '/workspace/x',
        status: 'completed',
      },
    });

    expect(payload).toMatchObject({
      title: 'T',
      working_directory: '/workspace/x',
      status: 'completed',
      review_score: 9,
      rejection_count: 1,
      merged: true,
      merge_commit: 'deadbeef',
      cost_usd: 1.5,
      run_count: 1,
    });
    expect(payload).not.toHaveProperty('failure_reason');
  });

  test('task_failed adds failure fields and keeps explicit event keys', async () => {
    const { base, task } = await taggedTask({
      status: 'failed',
      error: 'db error',
      merge_commit: null,
    });
    const payload = await publishAndCapture({
      ...base,
      type: 'task_failed',
      task_id: task.id,
      data: { status: 'in_progress', error: 'event error' },
    });

    expect(payload).toMatchObject({
      status: 'in_progress',
      error: 'event error',
      failure_reason: 'db error',
      failure_stage: 'failed',
      merged: false,
    });
  });

  test('untagged tasks and other event types get no outcome fields', async () => {
    const { base, task } = await taggedTask();
    const other = await publishAndCapture({
      ...base,
      type: 'task_question',
      task_id: task.id,
      data: {},
    });
    expect(other).not.toHaveProperty('run_count');

    const untagged = await publishAndCapture(
      { ...base, objective_id: null, task_id: task.id, data: {} },
      { settings: { brainAuthToken: 'brain-token' } },
    );
    expect(untagged).not.toHaveProperty('run_count');
  });

  test('a throwing lookup still publishes the original event', async () => {
    const { base, task } = await taggedTask();
    spyOn(taskObjectiveEvents, 'taskOutcomeEventData').mockRejectedValue(
      new Error('lookup failed'),
    );
    const payload = await publishAndCapture({
      ...base,
      task_id: task.id,
      data: { status: 'completed' },
    });
    expect(payload).toMatchObject({ status: 'completed' });
    expect(payload).not.toHaveProperty('run_count');
  });

  test('caps oversized task_failed error text and leaves other event text unchanged', async () => {
    const huge = 'E'.repeat(1_600_000);
    const { base, task } = await taggedTask({
      status: 'failed',
      error: huge,
      merge_commit: null,
    });
    const payload = await publishAndCapture({
      ...base,
      type: 'task_failed',
      task_id: task.id,
      data: { status: 'failed', error: huge },
    });

    expect(JSON.stringify(payload).length).toBeLessThan(20_000);
    expect(payload.error).toContain('…[truncated 1596000 chars]…');
    expect(payload.failure_reason).toContain('…[truncated 1596000 chars]…');

    const content = 'K'.repeat(10_000);
    const shared = await publishAndCapture({
      ...base,
      type: 'shared_knowledge',
      data: { content },
    });
    expect(shared.content).toBe(content);
  });
});

describe('privacy mode objective event gate', () => {
  function makeStrict() {
    registeredGroups[GROUP_ID].settings = {
      ...registeredGroups[GROUP_ID].settings,
      privacyMode: 'strict',
      brainAuthToken: 'brain-token',
    } as (typeof registeredGroups)[string]['settings'];
    applyGroupUpdateInMemory(GROUP_ID, {});
  }

  test('drops a published event on a remote runtime with a privacy_refusal warning', async () => {
    makeStrict();
    const fetchSpy = spyOn(globalThis, 'fetch');
    const event = await objectiveEvent();
    let resolveDrop!: (ctx: Record<string, unknown>) => void;
    const dropped = new Promise<Record<string, unknown>>((resolve) => {
      resolveDrop = resolve;
    });
    spyOn(logger, 'warn').mockImplementation(((
      ctx: Record<string, unknown>,
    ) => {
      if (ctx?.dropReason === 'privacy_refusal') resolveDrop(ctx);
    }) as never);

    publishEvent('http://brain.test', event, registeredGroups[GROUP_ID]);

    expect(await dropped).toMatchObject({
      eventType: 'task_completed',
      objective_id: event.objective_id,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does not fall back to the default runtime when a strict project runtime fails to resolve', async () => {
    makeStrict();
    const fetchSpy = spyOn(globalThis, 'fetch');
    const event = await objectiveEvent(
      {},
      {
        eventRuntimeSelection: {
          harnessId: 'claude',
          modelId: 'claude-haiku-5-5',
        },
      },
    );
    await expect(attachObjectiveAgentRuntime(event)).rejects.toThrow(
      /Incompatible runtime selection/,
    );
    let resolveDrop!: () => void;
    const dropped = new Promise<void>((resolve) => {
      resolveDrop = resolve;
    });
    spyOn(logger, 'warn').mockImplementation(((
      ctx: Record<string, unknown>,
    ) => {
      if (ctx?.dropReason === 'privacy_refusal') resolveDrop();
    }) as never);

    publishEvent('http://brain.test', event, registeredGroups[GROUP_ID]);
    await dropped;

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does not keep a refused state event pending in the outbox', async () => {
    makeStrict();
    const fetchSpy = spyOn(globalThis, 'fetch');
    const event = await objectiveEvent({ changes: { status: 'active' } });
    event.type = 'objective_updated';

    await publishObjectiveStateEvent(
      'http://brain.test',
      event,
      registeredGroups[GROUP_ID],
    );
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await readFile(
        objectiveStateEventOutboxPath(PROJECT_ID, event.objective_id!),
        'utf-8',
      ).then(
        (raw) => JSON.parse(raw).events,
        (err: NodeJS.ErrnoException) => err.code,
      ),
    ).toSatisfy((v) => v === 'ENOENT' || (Array.isArray(v) && v.length === 0));
  });
});

describe('objective runtime attach failure fallback', () => {
  const STALE_SELECTION = {
    harnessId: 'claude',
    modelId: 'claude-haiku-5-5',
  };
  const callerRuntime = {
    agent_cmd: 'caller-cmd',
    agent_model: 'caller-model',
  };

  function captureObjectiveRequests(objectiveId: string | null | undefined) {
    const payloads: Array<Record<string, unknown>> = [];
    spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      try {
        const body = JSON.parse(String(init?.body)) as {
          payload?: Record<string, unknown>;
        };
        const payload = body.payload;
        if (payload && payload.objective_id === objectiveId) {
          payloads.push(payload);
        }
      } catch {
        // Unrelated requests from a shared process need not be Brain events.
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch);
    return payloads;
  }

  test('publishes the event without runtime keys and warns with task and objective ids', async () => {
    const event = await objectiveEvent(
      { ...callerRuntime, note: 'kept' },
      { eventRuntimeSelection: STALE_SELECTION },
    );
    event.task_id = 'task-stale-runtime';
    await expect(attachObjectiveAgentRuntime(event)).rejects.toThrow(
      /Incompatible runtime selection/,
    );
    let resolveRequest!: (body: { payload: Record<string, unknown> }) => void;
    const received = new Promise<{ payload: Record<string, unknown> }>(
      (resolve) => {
        resolveRequest = resolve;
      },
    );
    spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      resolveRequest(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as typeof fetch);
    const warn = spyOn(logger, 'warn');

    publishEvent('http://brain.test', event, {
      settings: { brainAuthToken: 'brain-token' },
    });
    const { payload } = await received;

    expect(payload).toMatchObject({ note: 'kept' });
    expect(payload).not.toHaveProperty('agent_cmd');
    expect(payload).not.toHaveProperty('agent_model');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dropReason: 'runtime_attach_failed',
        task_id: 'task-stale-runtime',
        objective_id: event.objective_id,
      }),
      expect.any(String),
    );
  });

  test('delivers a state event with a failing runtime attach and flushes the next outbox entry', async () => {
    const first = await objectiveEvent(
      { ...callerRuntime, seq: 1 },
      { eventRuntimeSelection: STALE_SELECTION },
    );
    first.type = 'objective_updated';
    const second = { ...first, data: { seq: 2 } };
    const group = registeredGroups[GROUP_ID];
    const payloads = captureObjectiveRequests(first.objective_id);

    // No token yet: both entries stay queued until credentials appear.
    await publishObjectiveStateEvent('http://brain.test', first, group);
    await publishObjectiveStateEvent('http://brain.test', second, group);
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);
    expect(payloads).toHaveLength(0);

    group.settings = { ...group.settings, brainAuthToken: 'brain-token' };
    await reconcilePendingObjectiveStateEvents(PROJECT_ID);

    expect(payloads.map((payload) => payload.seq)).toEqual([1, 2]);
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('agent_cmd');
    }
    await expect(
      readFile(
        objectiveStateEventOutboxPath(PROJECT_ID, first.objective_id!),
        'utf-8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('publishEvent brain auth status', () => {
  const TOKEN = 'secret-brain-token-xyz';
  const group = {
    settings: { brainContainer: 'auth-brain', brainAuthToken: TOKEN },
  };
  let retryDelays: number[];
  let fetchSpy: ReturnType<typeof spyOn>;

  /** Retry backoff is 1000ms * attempt: record it and fire immediately. */
  function fastRetries() {
    retryDelays = [];
    const realSetTimeout = globalThis.setTimeout;
    spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === 1000 || ms === 2000) {
        retryDelays.push(ms);
        queueMicrotask(fn);
        return 0;
      }
      return realSetTimeout(fn, ms);
    }) as never);
  }

  beforeEach(fastRetries);

  const event = (projectId: string): BrainEvent => ({
    type: 'task_completed',
    project_id: projectId,
    timestamp: new Date().toISOString(),
    data: {},
  });

  /** Publishes one event and resolves when `done` matches a log call. */
  async function publish(
    projectId: string,
    status: number,
    done: (ctx: Record<string, unknown>, message?: string) => boolean,
  ) {
    const logged: Array<Record<string, unknown>> = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const spy = (ctx: Record<string, unknown>, message?: string) => {
      logged.push(ctx);
      if (done(ctx, message)) finish();
    };
    spyOn(logger, 'warn').mockImplementation(spy as never);
    spyOn(logger, 'debug').mockImplementation(spy as never);
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('nope', { status })) as unknown as typeof fetch,
    );
    publishEvent('http://brain.test', event(projectId), group);
    await finished;
    return logged;
  }

  test('a 403 is not retried, records the rejection, and a later success clears it', async () => {
    const logged = await publish(
      'auth-403',
      403,
      (ctx) => ctx.event === 'brain_auth_rejected',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(retryDelays).toEqual([]);
    expect(getBrainAuthStatus('auth-403')).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(logged[0]).toMatchObject({
      event: 'brain_auth_rejected',
      project: 'auth-403',
      status: 403,
      brainUrl: 'http://brain.test',
    });
    expect(JSON.stringify(logged)).not.toContain(TOKEN);

    mock.restore();
    let delivered!: () => void;
    const accepted = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      queueMicrotask(delivered);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch);
    publishEvent('http://brain.test', event('auth-403'), group);
    await accepted;
    while (getBrainAuthStatus('auth-403')?.ok !== true) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(getBrainAuthStatus('auth-403')?.status).toBeUndefined();
  });

  test('a repeated rejection logs at debug instead of warn', async () => {
    await publish(
      'auth-repeat',
      401,
      (ctx) => ctx.event === 'brain_auth_rejected',
    );
    mock.restore();
    const warn = spyOn(logger, 'warn');
    await publish(
      'auth-repeat',
      401,
      (ctx) => ctx.event === 'brain_auth_rejected',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test('a 500 and a 429 are retried up to the retry limit', async () => {
    for (const status of [500, 429]) {
      await publish(
        `auth-${status}`,
        status,
        (_ctx, message) => !!message?.includes('giving up'),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(retryDelays).toEqual([1000, 2000]);
      expect(getBrainAuthStatus(`auth-${status}`)).toBeUndefined();
      mock.restore();
      fastRetries();
    }
  });
});
