import fs from 'fs';
import path from 'path';
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as brainClient from './brain-client.js';
import { objectiveAgentRuntimeEventData } from './brain-client.js';
import { getGroupDir } from '../../group-dir.js';
import { groupFsTestHooks } from '../../lib/group-fs.js';
import {
  ensureObjectiveFolderInitialised,
  getObjectiveDir,
  initObjectiveFolder,
  writeObjectiveContext,
} from './objective-folder.js';
import type { Objective } from './types.js';
import { resolveObjectiveAgentRuntime } from './objective-agent.js';
import { resolveKanbanRuntimeSelection } from '../../lib/chat-agents.js';

afterEach(() => {
  mock.restore();
});

describe('initObjectiveFolder', () => {
  test('sends the authorized bootstrap payload through the self-healing brain client', async () => {
    const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response(null, { status: 201 }),
    );
    const selection = resolveKanbanRuntimeSelection([]).selection;
    const objective: Objective = {
      id: 'objective-1',
      project_id: 'child-project',
      title: 'Ship the objective dashboard',
      description: 'Create and validate the dashboard.',
      status: 'active',
      priority: 1,
      deadline: '2026-09-30T00:00:00.000Z',
      progress: 25,
      metadata: { owner: 'board' },
      eventRuntimeSelection: selection,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    };

    expect(
      await initObjectiveFolder(
        'child-project',
        objective.id,
        objective,
        'brain-container',
        'parent-project',
        { settings: { brainAuthToken: 'test-token' } },
      ),
    ).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('brain-container');
    expect(fetchSpy.mock.calls[0]?.[1]).toBe('/init-objective');
    const init = fetchSpy.mock.calls[0]?.[2];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    });
    const eventRuntime = resolveObjectiveAgentRuntime(
      undefined,
      objective.eventRuntimeSelection,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      objective_id: objective.id,
      project_id: 'child-project',
      objective: {
        title: objective.title,
        id: objective.id,
        status: objective.status,
        progress: objective.progress,
        description: objective.description,
        deadline: objective.deadline,
        metadata: objective.metadata,
        ...objectiveAgentRuntimeEventData(eventRuntime),
      },
    });
  });

  describe('ensureObjectiveFolderInitialised', () => {
    const group = {
      parentId: undefined,
      settings: { brainContainer: 'brain-container', brainAuthToken: 'tok' },
    };
    const objectiveFor = (projectId: string): Objective => ({
      id: 'objective-1',
      project_id: projectId,
      title: 'Trade the close',
      description: '',
      status: 'active',
      priority: 1,
      deadline: null,
      progress: 0,
      metadata: null,
      eventRuntimeSelection: resolveKanbanRuntimeSelection([]).selection,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    });

    test('re-runs the brain init for an uninitialised folder and leaves an initialised one alone', async () => {
      const projectId = `ensure-init-${Date.now()}`;
      const objective = objectiveFor(projectId);
      const dir = getObjectiveDir(projectId, objective.id);
      const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
        new Response(null, { status: 201 }),
      );
      try {
        // Partial folder left behind by Board runtime files only.
        fs.mkdirSync(path.join(dir, '.agent', 'reflections'), {
          recursive: true,
        });
        await ensureObjectiveFolderInitialised(projectId, objective, group);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        fs.writeFileSync(path.join(dir, 'state.json'), '{}');
        await ensureObjectiveFolderInitialised(projectId, objective, group);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('explains a rejected brain token when the folder is missing, but tolerates it for an existing folder', async () => {
      const projectId = `ensure-reject-${Date.now()}`;
      const objective = objectiveFor(projectId);
      const dir = getObjectiveDir(projectId, objective.id);
      spyOn(brainClient, 'fetchBrain').mockResolvedValue(
        new Response(null, { status: 403 }),
      );
      try {
        await expect(
          ensureObjectiveFolderInitialised(projectId, objective, group),
        ).rejects.toThrow(/never set up.*HTTP 403.*auth token/);

        fs.mkdirSync(dir, { recursive: true });
        await ensureObjectiveFolderInitialised(projectId, objective, group);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('rewrites objective context as an always-on rule', async () => {
    const projectId = `objective-context-${Date.now()}`;
    const objectiveId = 'objective-1';
    const objectiveDir = getObjectiveDir(projectId, objectiveId);
    fs.mkdirSync(path.join(objectiveDir, '.claude', 'rules'), {
      recursive: true,
    });
    const objective: Objective = {
      id: objectiveId,
      project_id: projectId,
      title: 'Keep objective context active',
      description: 'Preserve context after an objective update.',
      status: 'active',
      priority: 1,
      deadline: null,
      progress: 40,
      metadata: null,
      eventRuntimeSelection: resolveKanbanRuntimeSelection([]).selection,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:00.000Z',
    };

    expect(await writeObjectiveContext(projectId, objective)).toBe(true);

    const context = fs.readFileSync(
      path.join(objectiveDir, '.claude', 'rules', 'objective-context.md'),
      'utf8',
    );
    expect(context).toStartWith('---\ntrigger: always_on\n');
    expect(context).toContain('# Objective: Keep objective context active');

    fs.rmSync(objectiveDir, { recursive: true, force: true });
  });

  describe('symlink containment', () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projectA = `objective-ctx-a-${stamp}`;
    const projectB = `objective-ctx-b-${stamp}`;
    const objective: Objective = {
      id: 'objective-1',
      project_id: projectA,
      title: 'Contained context',
      description: '',
      status: 'active',
      priority: 1,
      deadline: null,
      progress: 0,
      metadata: null,
      eventRuntimeSelection: resolveKanbanRuntimeSelection([]).selection,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:00.000Z',
    };

    afterAll(() => {
      fs.rmSync(getGroupDir(projectA), { recursive: true, force: true });
      fs.rmSync(getGroupDir(projectB), { recursive: true, force: true });
    });

    test('refuses a leaf symlink into another project', async () => {
      const objectiveDir = getObjectiveDir(projectA, 'leaf');
      const rulesDir = path.join(objectiveDir, '.claude', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      const victim = path.join(getGroupDir(projectB), '.claude', 'rules');
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, 'x.md'), 'orig');
      fs.symlinkSync(
        '../../../../../' + projectB + '/.claude/rules/x.md',
        path.join(rulesDir, 'objective-context.md'),
      );

      expect(
        await writeObjectiveContext(projectA, { ...objective, id: 'leaf' }),
      ).toBe(false);
      expect(fs.readFileSync(path.join(victim, 'x.md'), 'utf8')).toBe('orig');
    });

    test('refuses a .claude directory symlink into another project', async () => {
      const objectiveDir = getObjectiveDir(projectA, 'dir');
      fs.mkdirSync(objectiveDir, { recursive: true });
      const bDir = path.join(getGroupDir(projectB), 'dir-target');
      fs.mkdirSync(bDir, { recursive: true });
      fs.symlinkSync(bDir, path.join(objectiveDir, '.claude'));

      expect(
        await writeObjectiveContext(projectA, { ...objective, id: 'dir' }),
      ).toBe(false);
      expect(fs.readdirSync(bDir)).toEqual([]);
    });

    test('refuses .claude/rules swapped for a symlink after the check', async () => {
      const objectiveDir = getObjectiveDir(projectA, 'swap');
      const rulesDir = path.join(objectiveDir, '.claude', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      const victim = path.join(getGroupDir(projectB), 'swap-rules');
      fs.mkdirSync(victim, { recursive: true });
      let swapped = false;
      groupFsTestHooks.beforeOpen = (_label, segment) => {
        if (swapped || segment !== 'rules') return;
        swapped = true;
        fs.rmSync(rulesDir, { recursive: true, force: true });
        fs.symlinkSync(victim, rulesDir);
      };
      try {
        expect(
          await writeObjectiveContext(projectA, { ...objective, id: 'swap' }),
        ).toBe(false);
      } finally {
        groupFsTestHooks.beforeOpen = undefined;
      }
      expect(swapped).toBe(true);
      expect(fs.readdirSync(victim)).toEqual([]);
    });

    test('refuses a planted .agent symlink leaving the project', async () => {
      const objectiveDir = getObjectiveDir(projectA, 'planted');
      fs.mkdirSync(objectiveDir, { recursive: true });
      const victim = path.join(getGroupDir(projectB), '.agent');
      fs.mkdirSync(victim, { recursive: true });
      fs.symlinkSync(
        path.relative(objectiveDir, victim),
        path.join(objectiveDir, '.agent'),
      );
      fs.symlinkSync('.agent', path.join(objectiveDir, '.claude'));

      expect(
        await writeObjectiveContext(projectA, { ...objective, id: 'planted' }),
      ).toBe(false);
      expect(fs.readdirSync(victim)).toEqual([]);
    });

    test('follows an in-folder .claude -> .agent symlink', async () => {
      const objectiveDir = getObjectiveDir(projectA, 'inner');
      fs.mkdirSync(path.join(objectiveDir, '.agent'), { recursive: true });
      fs.symlinkSync('.agent', path.join(objectiveDir, '.claude'));

      expect(
        await writeObjectiveContext(projectA, { ...objective, id: 'inner' }),
      ).toBe(true);
      expect(
        fs.readFileSync(
          path.join(objectiveDir, '.agent', 'rules', 'objective-context.md'),
          'utf8',
        ),
      ).toContain('# Objective: Contained context');
    });
  });
});
