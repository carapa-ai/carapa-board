import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Load the tool registry first: importing tools.js directly hits a registry <-> tools
// import cycle (TDZ on SANDBOX_RESTART_COOLDOWN_MS) when this file runs alone.
import '../tools/registry.js';
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import type { RegisteredGroup } from '../../types.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import type { StageDefinition } from '../kanban/types.js';
import {
  completeActiveRun,
  createTask,
  initDatabase,
  insertAiUserRow,
  insertActiveRun,
  updateTask,
} from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { runFixture, taskFixture } from '../../test-helpers.js';
import {
  getProjectSetupTool,
  publishAppTool,
  getPublishedAppTool,
  projectSetupRevision,
  setProjectPromptTool,
  setProjectStagesTool,
  setProjectTaskCheckoutModeTool,
} from './tools.js';

const folder = `project-setup-test-${process.pid}`;
const checkoutEligibilityFolder = `${folder}-checkout-eligibility`;
const group: RegisteredGroup = {
  name: 'Project setup test',
  folder,
  trigger: '@test',
  added_at: new Date().toISOString(),
  settings: {
    repositoryLocation: '/host/private/repository',
    stages: [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888888' },
      {
        id: 'implementation',
        title: 'Implementation',
        type: 'active',
        color: '#3366ff',
      },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ],
  },
};
const groups = { 'test-jid': group };
const deps: McpServerDeps = {
  sendMessage: async () => {},
  getRegisteredGroups: () => groups,
  registerGroup: () => {},
  updateGroup: (_jid, updates) => {
    Object.assign(group, updates);
  },
};
const context = {
  group_folder: folder,
  permissions: {
    [folder]: ['project_setup:read', 'project_setup:write'],
  },
};

async function readSetup() {
  return JSON.parse(
    await getProjectSetupTool.handler({}, deps, context),
  ) as Record<string, any>;
}

describe('project setup tools', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    await drizzleDbRef.current.insert(projects).values({
      id: folder,
      jid: `${folder}@board`,
      name: group.name,
      folder,
      trigger: group.trigger,
      added_at: group.added_at,
      settings: JSON.stringify(group.settings),
    });
  }, 30_000);

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    fs.rmSync(path.join(GROUPS_DIR, checkoutEligibilityFolder), {
      recursive: true,
      force: true,
    });
  });

  test('revision hashing is stable across object key order', () => {
    expect(projectSetupRevision({ a: 1, b: { c: 2 } })).toBe(
      projectSetupRevision({ b: { c: 2 }, a: 1 }),
    );
  });

  test('setup snapshot reports repository state without exposing its location', async () => {
    const setup = await readSetup();
    expect(setup.repository).toEqual({
      connected: true,
      source: 'local',
      defaultBranch: 'develop',
    });
    expect(setup.taskCheckout).toEqual({
      mode: 'shared',
      configuredMaxParallel: 1,
      effectiveMaxParallel: 1,
    });
    expect(setup.kanbanRuntimeSelection).toBeNull();
    expect(setup.revision).toHaveLength(16);
    expect(JSON.stringify(setup)).not.toContain('/host/private/repository');
  });

  test('stages and prompts update sequentially with revision checks', async () => {
    const initial = await readSetup();
    const stages: StageDefinition[] = [
      { id: 'queue', title: 'Queue', type: 'queue', color: '#888888' },
      { id: 'coding', title: 'Coding', type: 'active', color: '#3366ff' },
      { id: 'testing', title: 'Testing', type: 'testing', color: '#9955dd' },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    const stageResult = JSON.parse(
      await setProjectStagesTool.handler(
        { expected_revision: initial.revision, stages },
        deps,
        context,
      ),
    );
    expect(group.settings?.stages).toEqual(stages);

    const promptResult = JSON.parse(
      await setProjectPromptTool.handler(
        {
          expected_revision: stageResult.revision,
          prompt_type: 'stage',
          stage_id: 'testing',
          content: 'Run the canonical verification command.',
        },
        deps,
        context,
      ),
    );
    expect(promptResult.removed).toBe(false);
    expect((await readSetup()).prompts.stages.testing).toBe(
      'Run the canonical verification command.',
    );

    await expect(
      setProjectPromptTool.handler(
        {
          expected_revision: initial.revision,
          prompt_type: 'worker',
          content: 'stale write',
        },
        deps,
        context,
      ),
    ).rejects.toThrow('changed since it was inspected');
  });

  test('removing the system prompt returns a fresh revision immediately', async () => {
    const written = JSON.parse(
      await setProjectPromptTool.handler(
        {
          expected_revision: (await readSetup()).revision,
          prompt_type: 'system',
          content: 'System prompt X',
        },
        deps,
        context,
      ),
    );
    const before = await readSetup();
    expect(before.revision).toBe(written.revision);
    const removed = JSON.parse(
      await setProjectPromptTool.handler(
        {
          expected_revision: before.revision,
          prompt_type: 'system',
          content: null,
        },
        deps,
        context,
      ),
    );
    expect(removed.revision).not.toBe(before.revision);
    expect((await readSetup()).revision).toBe(removed.revision);
  });

  test('writes and removes prompts for enabled run-on-entry queue stages', async () => {
    const stages: StageDefinition[] = [
      {
        id: 'question',
        title: 'Question',
        type: 'queue',
        color: '#dd9933',
        runOnEntry: true,
      },
      { id: 'coding', title: 'Coding', type: 'active', color: '#3366ff' },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    const stageResult = JSON.parse(
      await setProjectStagesTool.handler(
        { expected_revision: (await readSetup()).revision, stages },
        deps,
        context,
      ),
    );

    const promptResult = JSON.parse(
      await setProjectPromptTool.handler(
        {
          expected_revision: stageResult.revision,
          prompt_type: 'stage',
          stage_id: 'question',
          content: 'Diagnose and replan autonomously.',
        },
        deps,
        context,
      ),
    );
    expect(promptResult.removed).toBe(false);
    expect((await readSetup()).prompts.stages.question).toBe(
      'Diagnose and replan autonomously.',
    );

    const removeResult = JSON.parse(
      await setProjectPromptTool.handler(
        {
          expected_revision: promptResult.revision,
          prompt_type: 'stage',
          stage_id: 'question',
          content: null,
        },
        deps,
        context,
      ),
    );
    expect(removeResult.removed).toBe(true);
    expect((await readSetup()).prompts.stages.question).toBeUndefined();
  });

  test('rejects prompts for passive queue stages', async () => {
    const stages: StageDefinition[] = [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888888' },
      { id: 'coding', title: 'Coding', type: 'active', color: '#3366ff' },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    const stageResult = JSON.parse(
      await setProjectStagesTool.handler(
        { expected_revision: (await readSetup()).revision, stages },
        deps,
        context,
      ),
    );

    await expect(
      setProjectPromptTool.handler(
        {
          expected_revision: stageResult.revision,
          prompt_type: 'stage',
          stage_id: 'backlog',
          content: 'This stage does not execute on entry.',
        },
        deps,
        context,
      ),
    ).rejects.toThrow('not an enabled executable or run-on-entry stage');
  });

  test('set_project_stages rejects an active non-queue Question stage', async () => {
    const stages: StageDefinition[] = [
      { id: 'queue', title: 'Queue', type: 'queue', color: '#888888' },
      { id: 'question', title: 'Question', type: 'done', color: '#dd9933' },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    await expect(
      setProjectStagesTool.handler(
        { expected_revision: (await readSetup()).revision, stages },
        deps,
        context,
      ),
    ).rejects.toThrow(/Invalid stages: .*must be a queue stage/);
  });

  test('rejects occupied stage removal until all cards are moved', async () => {
    const occupiedStages: StageDefinition[] = [
      { id: 'queue', title: 'Queue', type: 'queue', color: '#888888' },
      { id: 'legacy', title: 'Legacy', type: 'active', color: '#3366ff' },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    group.settings = { ...(group.settings ?? {}), stages: occupiedStages };
    await drizzleDbRef.current
      .update(projects)
      .set({ settings: JSON.stringify(group.settings) })
      .where(eq(projects.id, folder));
    const active = await createTask(
      taskFixture({ project_id: folder, status: 'legacy' }),
    );
    const archived = await createTask(
      taskFixture({ project_id: folder, status: 'legacy', archived: true }),
    );
    const replacement: StageDefinition[] = [
      occupiedStages[0],
      { id: 'coding', title: 'Coding', type: 'active', color: '#3366ff' },
      occupiedStages[2],
    ];
    let updateCalls = 0;
    const guardedDeps: McpServerDeps = {
      ...deps,
      updateGroup: (jid, updates) => {
        updateCalls++;
        deps.updateGroup(jid, updates);
      },
    };

    await expect(
      setProjectStagesTool.handler(
        {
          expected_revision: (await readSetup()).revision,
          stages: replacement,
        },
        guardedDeps,
        context,
      ),
    ).rejects.toThrow('"legacy" (2 cards)');
    expect(group.settings?.stages).toEqual(occupiedStages);
    expect(updateCalls).toBe(0);

    await updateTask(active.id, { status: 'done' });
    await updateTask(archived.id, { status: 'done' });
    await setProjectStagesTool.handler(
      {
        expected_revision: (await readSetup()).revision,
        stages: replacement,
      },
      guardedDeps,
      context,
    );
    expect(group.settings?.stages).toEqual(replacement);
    expect(updateCalls).toBe(0);
  });

  test('accepts only enabled personas on executable stages', async () => {
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: 'project-setup-enabled-persona',
      name: 'Enabled persona',
      identity: 'Enabled persona',
      presetId: 'custom',
      promptPath: 'ai-users/project-setup-enabled-persona/prompt.md',
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    const stages: StageDefinition[] = [
      { id: 'queue', title: 'Queue', type: 'queue', color: '#888888' },
      {
        id: 'coding',
        title: 'Coding',
        type: 'active',
        color: '#3366ff',
        mainAiUserId: 'project-setup-enabled-persona',
      },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    const setup = await readSetup();
    await setProjectStagesTool.handler(
      { expected_revision: setup.revision, stages },
      deps,
      context,
    );
    expect(group.settings?.stages?.[1]?.mainAiUserId).toBe(
      'project-setup-enabled-persona',
    );

    await expect(
      setProjectStagesTool.handler(
        {
          expected_revision: (await readSetup()).revision,
          stages: stages.map((stage) =>
            stage.type === 'queue'
              ? { ...stage, mainAiUserId: 'project-setup-enabled-persona' }
              : stage,
          ),
        },
        deps,
        context,
      ),
    ).rejects.toThrow('only valid for executable stages');
    await expect(
      setProjectStagesTool.handler(
        {
          expected_revision: (await readSetup()).revision,
          stages: stages.map((stage) =>
            stage.type === 'active'
              ? { ...stage, mainAiUserId: 'missing-persona' }
              : stage,
          ),
        },
        deps,
        context,
      ),
    ).rejects.toThrow('must reference an enabled AI user');
  });

  test('worktree isolation changes only after an explicit revisioned mutation', async () => {
    const previous = group.settings?.taskCheckoutMode;
    const setup = await readSetup();
    const result = JSON.parse(
      await setProjectTaskCheckoutModeTool.handler(
        {
          expected_revision: setup.revision,
          mode: 'worktree',
        },
        deps,
        context,
      ),
    );

    expect(result.taskCheckout.mode).toBe('worktree');
    expect(group.settings?.taskCheckoutMode).toBe('worktree');
    expect((await readSetup()).taskCheckout.mode).toBe('worktree');

    if (previous === undefined) delete group.settings?.taskCheckoutMode;
    else group.settings!.taskCheckoutMode = previous;
  });

  test('uses task activity rather than stage occupancy for revisioned mode changes', async () => {
    const checkoutStages: StageDefinition[] = [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888888' },
      {
        id: 'implementation',
        title: 'Implementation',
        type: 'active',
        color: '#3366ff',
      },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    const checkoutGroup: RegisteredGroup = {
      name: 'Checkout eligibility',
      folder: checkoutEligibilityFolder,
      trigger: '@checkout',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: checkoutStages,
      },
    };
    await drizzleDbRef.current.insert(projects).values({
      id: checkoutEligibilityFolder,
      jid: `${checkoutEligibilityFolder}@board`,
      name: checkoutGroup.name,
      folder: checkoutEligibilityFolder,
      trigger: checkoutGroup.trigger,
      added_at: checkoutGroup.added_at,
      settings: JSON.stringify(checkoutGroup.settings),
    });
    const activeCard = await createTask(
      taskFixture({
        project_id: checkoutEligibilityFolder,
        status: 'implementation',
      }),
    );
    const checkoutGroups = { checkout: checkoutGroup };
    const checkoutDeps: McpServerDeps = {
      ...deps,
      getRegisteredGroups: () => checkoutGroups,
      updateGroup: (_jid, updates) => Object.assign(checkoutGroup, updates),
    };
    const checkoutContext = {
      group_folder: checkoutEligibilityFolder,
      permissions: {
        [checkoutEligibilityFolder]: [
          'project_setup:read',
          'project_setup:write',
        ],
      },
    };

    const initial = JSON.parse(
      await getProjectSetupTool.handler({}, checkoutDeps, checkoutContext),
    );
    const changed = JSON.parse(
      await setProjectTaskCheckoutModeTool.handler(
        { expected_revision: initial.revision, mode: 'worktree' },
        checkoutDeps,
        checkoutContext,
      ),
    );
    expect(changed.taskCheckout.mode).toBe('worktree');
    const [persisted] = await drizzleDbRef.current
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, checkoutEligibilityFolder));
    expect(JSON.parse(persisted!.settings!).taskCheckoutMode).toBe('worktree');

    const run = runFixture({
      id: 'mcp-checkout-eligibility-task-run',
      group_folder: checkoutEligibilityFolder,
      task_id: activeCard.id,
    });
    await insertActiveRun(run);
    await expect(
      setProjectTaskCheckoutModeTool.handler(
        { expected_revision: changed.revision, mode: 'branch' },
        checkoutDeps,
        checkoutContext,
      ),
    ).rejects.toThrow('task execution or admission is active');
    await completeActiveRun(run.id, 'completed');
  });

  test('rejects writes without the dedicated current-project permission', async () => {
    const setup = await readSetup();
    await expect(
      setProjectPromptTool.handler(
        {
          expected_revision: setup.revision,
          prompt_type: 'worker',
          content: 'not allowed',
        },
        deps,
        { group_folder: folder, permissions: { [folder]: ['tasks:write'] } },
      ),
    ).rejects.toThrow('project_setup:write');
  });

  test('refuses a worker prompt symlinked outside the group and never returns its content', async () => {
    const promptsDir = path.join(GROUPS_DIR, folder, '.agent', 'prompts');
    const outsideFile = path.join(GROUPS_DIR, `${folder}-outside-secret.md`);
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'outside secret');
    const link = path.join(promptsDir, 'worker.md');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(outsideFile, link);
    try {
      await expect(
        setProjectPromptTool.handler(
          {
            expected_revision: (await readSetup()).revision,
            prompt_type: 'worker',
            content: 'overwrite attempt',
          },
          deps,
          context,
        ),
      ).rejects.toThrow('Refused to write prompt file');
      expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('outside secret');
      expect((await readSetup()).prompts.worker).toBeNull();
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });

  test('does not write an unused local stage prompt while stages are inherited', async () => {
    const previousParentId = group.parentId;
    const previousStages = group.settings?.stages;
    group.parentId = 'parent-project';
    group.settings = { ...(group.settings ?? {}), stages: undefined };
    const setup = await readSetup();

    await expect(
      setProjectPromptTool.handler(
        {
          expected_revision: setup.revision,
          prompt_type: 'stage',
          stage_id: 'in_progress',
          content: 'This would not be loaded.',
        },
        deps,
        context,
      ),
    ).rejects.toThrow('inherits its stages');

    group.parentId = previousParentId;
    group.settings = { ...(group.settings ?? {}), stages: previousStages };
  });

  test('refuses inherit_from_parent for a project without a parent', async () => {
    await expect(
      setProjectStagesTool.handler(
        {
          expected_revision: (await readSetup()).revision,
          inherit_from_parent: true,
        },
        deps,
        context,
      ),
    ).rejects.toThrow('has no parent project');
  });

  test('a shared-sandbox parent credential can configure its authorized child', async () => {
    const parentFolder = `${folder}-parent`;
    const childFolder = `${folder}-child`;
    const parent: RegisteredGroup = {
      name: 'Parent',
      folder: parentFolder,
      trigger: '@test',
      added_at: new Date().toISOString(),
      settings: {
        stages: [
          { id: 'queue', title: 'Queue', type: 'queue', color: '#888888' },
          { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
        ],
      },
    };
    const child: RegisteredGroup = {
      name: 'Child',
      folder: childFolder,
      parentId: parentFolder,
      trigger: '@test',
      added_at: new Date().toISOString(),
      settings: { repositoryRelativePath: 'child' },
    };
    const sharedGroups = { parent, child };
    for (const item of [parent, child]) {
      await drizzleDbRef.current.insert(projects).values({
        id: item.folder,
        jid: `${item.folder}@board`,
        name: item.name,
        folder: item.folder,
        trigger: item.trigger,
        added_at: item.added_at,
        parentId: item.parentId ?? null,
        settings: JSON.stringify(item.settings),
      });
    }
    const sharedDeps: McpServerDeps = {
      ...deps,
      getRegisteredGroups: () => sharedGroups,
      updateGroup: (jid, updates) => {
        Object.assign(sharedGroups[jid as keyof typeof sharedGroups], updates);
      },
    };
    const parentContext = {
      group_folder: parentFolder,
      permissions: {
        [parentFolder]: ['project_setup:read', 'project_setup:write'],
        [childFolder]: ['project_setup:read', 'project_setup:write'],
      },
    };

    const snapshot = JSON.parse(
      await getProjectSetupTool.handler(
        { target_project: childFolder },
        sharedDeps,
        parentContext,
      ),
    );
    expect(snapshot.projectId).toBe(childFolder);
    expect(snapshot.stagesInherited).toBe(true);

    const childStages: StageDefinition[] = [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888888' },
      { id: 'coding', title: 'Coding', type: 'active', color: '#3366ff' },
      { id: 'done', title: 'Done', type: 'done', color: '#22aa55' },
    ];
    await setProjectStagesTool.handler(
      {
        target_project: childFolder,
        expected_revision: snapshot.revision,
        stages: childStages,
      },
      sharedDeps,
      parentContext,
    );
    expect(child.settings?.stages).toEqual(childStages);
    expect(parent.settings?.stages).not.toEqual(childStages);

    const childSetup = JSON.parse(
      await getProjectSetupTool.handler(
        { target_project: childFolder },
        sharedDeps,
        parentContext,
      ),
    );
    await setProjectTaskCheckoutModeTool.handler(
      {
        target_project: childFolder,
        expected_revision: childSetup.revision,
        mode: 'worktree',
      },
      sharedDeps,
      parentContext,
    );
    expect(child.settings?.taskCheckoutMode).toBe('worktree');
    expect(parent.settings?.taskCheckoutMode).toBeUndefined();

    const inheritArgs = async () => ({
      target_project: childFolder,
      expected_revision: (
        JSON.parse(
          await getProjectSetupTool.handler(
            { target_project: childFolder },
            sharedDeps,
            parentContext,
          ),
        ) as { revision: string }
      ).revision,
      inherit_from_parent: true as const,
    });
    await expect(
      setProjectStagesTool.handler(
        { ...(await inheritArgs()), stages: childStages },
        sharedDeps,
        parentContext,
      ),
    ).rejects.toThrow('not both');
    const occupying = await createTask(
      taskFixture({ project_id: childFolder, status: 'coding' }),
    );
    await expect(
      setProjectStagesTool.handler(
        await inheritArgs(),
        sharedDeps,
        parentContext,
      ),
    ).rejects.toThrow('"coding" (1 card)');
    expect(child.settings?.stages).toEqual(childStages);

    await updateTask(occupying.id, { status: 'done' });
    // An archived card in a stage the parent lacks does not block inheriting.
    await createTask(
      taskFixture({
        project_id: childFolder,
        status: 'backlog',
        archived: true,
      }),
    );
    const inherited = JSON.parse(
      await setProjectStagesTool.handler(
        await inheritArgs(),
        sharedDeps,
        parentContext,
      ),
    );
    expect(inherited.stagesInherited).toBe(true);
    expect(inherited.stages).toEqual(parent.settings?.stages);
    expect(child.settings?.stages).toBeUndefined();
    expect(child.settings?.taskCheckoutMode).toBe('worktree');
    const inheritedSetup = JSON.parse(
      await getProjectSetupTool.handler(
        { target_project: childFolder },
        sharedDeps,
        parentContext,
      ),
    );
    expect(inheritedSetup.stagesInherited).toBe(true);
    expect(inheritedSetup.stages).toEqual(parent.settings?.stages);

    await expect(
      getProjectSetupTool.handler(
        { target_project: 'unrelated-project' },
        sharedDeps,
        parentContext,
      ),
    ).rejects.toThrow('project_setup:read');

    fs.rmSync(path.join(GROUPS_DIR, parentFolder), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(GROUPS_DIR, parentFolder, childFolder), {
      recursive: true,
      force: true,
    });
  });
});

test('app publishing enforces target and shared sandbox owner permissions before execution', async () => {
  await expect(
    publishAppTool.handler(
      { target_project: 'foreign', enabled: true, targetPort: 3000 },
      deps,
      context,
    ),
  ).rejects.toThrow('Unauthorized');
  await expect(
    getPublishedAppTool.handler({ target_project: 'foreign' }, deps, context),
  ).rejects.toThrow('Unauthorized');
  const owner: RegisteredGroup = {
    ...group,
    folder: 'app-owner',
    settings: { isParent: true, sandboxOwnership: 'shared' },
  };
  const child: RegisteredGroup = { ...group, parentId: owner.folder };
  await expect(
    publishAppTool.handler(
      { enabled: true, targetPort: 3000 },
      { ...deps, getRegisteredGroups: () => ({ child, owner }) },
      context,
    ),
  ).rejects.toThrow('Unauthorized');
});
