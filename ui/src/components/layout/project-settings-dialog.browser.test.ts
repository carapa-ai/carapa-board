// @ts-nocheck
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  acquireRecordedSession,
  allocateBrowserTestRuntime,
  runBrowserCli,
} from '../../test-utils/browser-runtime';

const hasPlaywrightCli = Bun.which('playwright-cli') !== null;
const browser = hasPlaywrightCli ? describe : describe.skip;
const runtime = hasPlaywrightCli
  ? await allocateBrowserTestRuntime('project-settings-dialog')
  : undefined;
const session = runtime?.session ?? '';
const urlPattern = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/board\/ui-running)/;
let sandbox: Bun.Subprocess;
let sandboxUrl: string;
let releaseRecordedSession: () => void = () => {};

async function cli(...args: string[]) {
  return runBrowserCli(runtime, args);
}

async function startSandbox() {
  sandbox = Bun.spawn(['bun', 'scripts/ui-sandbox/start.ts', '--no-browser'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = sandbox.stdout.getReader();
  const ready = new Promise<void>((resolve, reject) => {
    void (async () => {
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
        const match = output.match(urlPattern);
        if (match) {
          sandboxUrl = match[1];
          resolve();
        }
      }
      reject(new Error('UI sandbox exited before becoming ready'));
    })();
  });
  await Promise.race([
    ready,
    Bun.sleep(60_000).then(() => {
      throw new Error('UI sandbox did not become ready');
    }),
  ]);
}

browser('Project Settings narrow viewport behavior', () => {
  beforeAll(async () => {
    releaseRecordedSession = await acquireRecordedSession(runtime);
    await startSandbox();
    await cli('open', sandboxUrl);
    await cli(
      'run-code',
      `async page => {
        page.once('dialog', async dialog => await dialog.dismiss());
        await page.goto(${JSON.stringify(sandboxUrl)});
        await page.getByPlaceholder('Username').waitFor();
        await page.getByPlaceholder('Username').fill('ui-admin');
        await page.getByPlaceholder('Password').fill('carapa-ui-sandbox');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.locator('[data-ui="kanban-content"]').waitFor();
        await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();
        await page.getByRole('menuitem', { name: 'Project settings' }).click();
        await page.locator('[data-ui="project-settings-dialog"]').waitFor();
      }`,
    );
  }, 180_000);

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (!runtime.recorded) {
        try {
          await cli('close');
        } catch (error) {
          cleanupError = error;
        }
      }
    } finally {
      try {
        sandbox?.kill('SIGTERM');
        await sandbox?.exited;
      } finally {
        try {
          runtime.cleanup();
        } finally {
          releaseRecordedSession();
        }
      }
    }
    if (cleanupError) throw cleanupError;
  });

  test('publishes and revokes external app access on desktop and mobile', async () => {
    const result = await cli(
      'run-code',
      `async page => {
      await page.getByRole('tab', { name: 'Deploy & publishing', exact: true }).click();
      const section = page.locator('#settings-app-publishing');
      for (const width of [1280, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await section.getByRole('status').filter({ hasText: 'External access is disabled.' }).waitFor();
        await section.getByLabel('App port', { exact: true }).fill('3137');
        await section.getByRole('button', { name: 'Publish app', exact: true }).click();
        const link = section.locator('[data-ui="published-app-link"]');
        await link.waitFor();
        if (await link.getAttribute('href') !== 'https://app.ui-sandbox.invalid/') throw new Error('Wrong published URL');
        const sidebarLink = page.locator('[data-ui="sidebar-published-app-link"][data-project-id="ui-running"]');
        await sidebarLink.waitFor({ state: 'attached' });
        if (await sidebarLink.getAttribute('href') !== 'https://app.ui-sandbox.invalid/') throw new Error('Sidebar omitted the published app URL');
        await section.getByRole('button', { name: 'Refresh', exact: true }).click();
        await section.getByRole('status').filter({ hasText: 'Ingress route is ready.' }).waitFor();
        await section.getByRole('button', { name: 'Disable access', exact: true }).click();
        await section.getByRole('status').filter({ hasText: 'External access is disabled.' }).waitFor();
        if (await link.count()) throw new Error('Revoked link remains visible');
        await sidebarLink.waitFor({ state: 'detached' });
      }
      return 'publication verified at 1280 and 360 pixels';
    }`,
    );
    expect(result).toContain('publication verified at 1280 and 360 pixels');
  }, 60_000);

  test('defaults tool activity to compact and persists explicit expanded opt-in', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.getByRole('tab', { name: 'General', exact: true }).click();
        const absentFromGeneral = await page.locator('#settings-expand-tool-activity').count();
        await page.getByRole('tab', { name: 'My preferences', exact: true }).click();
        const checkbox = page.locator('#settings-expand-tool-activity');
        await checkbox.scrollIntoViewIfNeeded();
        const initiallyChecked = await checkbox.getAttribute('data-state');
        await checkbox.click();
        const expandedSave = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/api/projects/ui-running'));
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        const expandedResponse = await expandedSave;
        const expandedPayload = expandedResponse.request().postDataJSON();
        await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();
        await page.getByRole('menuitem', { name: 'Project settings' }).click();
        await page.locator('[data-ui="project-settings-dialog"]').waitFor();
        await page.getByRole('tab', { name: 'My preferences', exact: true }).click();
        const reopened = page.locator('#settings-expand-tool-activity');
        await reopened.scrollIntoViewIfNeeded();
        const persistedState = await reopened.getAttribute('data-state');
        await reopened.click();
        const compactSave = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/api/projects/ui-running'));
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        const compactResponse = await compactSave;
        await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();
        await page.getByRole('menuitem', { name: 'Project settings' }).click();
        await page.locator('[data-ui="project-settings-dialog"]').waitFor();
        return {
          absentFromGeneral,
          initiallyChecked,
          expandedValue: expandedPayload.settings.toolCallDisplay,
          persistedState,
          compactValue: compactResponse.request().postDataJSON().settings.toolCallDisplay,
        };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result).toEqual({
      absentFromGeneral: 0,
      initiallyChecked: 'unchecked',
      expandedValue: 'expanded',
      persistedState: 'checked',
      compactValue: 'compact',
    });
  }, 60_000);

  test('moves occupied cards from the chooser and preserves the draft on a save conflict', async () => {
    const result = JSON.parse(
      (
        await cli(
          'run-code',
          `async page => {
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.keyboard.press('Escape');
            const projectId = 'ui-running';
            const project = await page.evaluate(async projectId => (await (await fetch('/api/projects')).json()).find(project => project.id === projectId), projectId);
            const stages = project.effectiveStages || project.settings.stages;
            const source = stages.find(stage => stage.id === 'review');
            const destination = stages.find(stage => stage.id === 'question');
            const raceStage = { id: 'ui_stage_race', title: 'UI Race', type: 'queue', color: '#F59E02' };
            if (!source || !destination) throw new Error('sandbox did not provide suitable stage fixtures');
            const patchProject = body => page.evaluate(async ({ projectId, body }) => {
              const response = await fetch('/api/projects/' + projectId, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              return { status: response.status, body: await response.json().catch(() => null) };
            }, { projectId, body });
            const patchAnyProject = (targetProjectId, body) => page.evaluate(async ({ targetProjectId, body }) => {
              const response = await fetch('/api/projects/' + targetProjectId, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              return { status: response.status, body: await response.json().catch(() => null) };
            }, { targetProjectId, body });
            const createTask = async title => page.evaluate(async ({ projectId, title }) => {
              const response = await fetch('/api/projects/' + projectId + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
              return response.json();
            }, { projectId, title });
            const patchTask = (taskId, body) => page.evaluate(async ({ projectId, taskId, body }) => {
              const response = await fetch('/api/projects/' + projectId + '/tasks/' + taskId, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              return response.status;
            }, { projectId, taskId, body });
            const deleteTask = taskId => page.evaluate(async ({ projectId, taskId }) => fetch('/api/projects/' + projectId + '/tasks/' + taskId, { method: 'DELETE' }), { projectId, taskId });
            const active = { id: 'ui-task-review' };
            const archived = { id: 'ui-task-review-archived' };
            const seededTasks = await page.evaluate(async ids => {
              return Promise.all(ids.map(id => fetch('/api/projects/ui-running/tasks/' + id).then(response => response.json())));
            }, [active.id, archived.id]);
            if (seededTasks[0].status !== source.id || seededTasks[0].archived || seededTasks[1].status !== source.id || !seededTasks[1].archived) {
              throw new Error('sandbox seed did not provide active and archived cards in the review stage');
            }
            const setup = await patchProject({ settings: { stages: [...stages, raceStage] } });
            if (setup.status !== 200) throw new Error('stage fixture setup failed: ' + JSON.stringify(setup));
            let raceOccupied = false;
            let inheritedOccupied = false;
            await page.route('**/api/projects/' + projectId + '/stage-occupancy', route => route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ occupancy: [...stages, raceStage].map(stage => ({
                stageId: stage.id,
                total: stage.id === source.id ? 2 : stage.id === 'backlog' && inheritedOccupied ? 1 : stage.id === raceStage.id && raceOccupied ? 1 : 0,
                active: stage.id === source.id ? 1 : stage.id === 'backlog' && inheritedOccupied ? 1 : stage.id === raceStage.id && raceOccupied ? 1 : 0,
                archived: stage.id === source.id ? 1 : 0,
              })) }),
            }));
            await page.reload();
            await page.locator('[data-ui="kanban-content"]').waitFor();
            const savePayloads = [];
            page.on('request', request => {
              if (request.method() === 'PATCH' && request.url().endsWith('/api/projects/' + projectId)) {
                try { savePayloads.push(JSON.parse(request.postData() || 'null')); } catch {}
              }
            });
            await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();
            await page.getByRole('menuitem', { name: 'Project settings' }).click();
            await page.getByRole('tab', { name: 'Board', exact: true }).click();
            const sourceRemove = page.locator('[data-ui="stage-editor-remove"][data-source-stage-id="' + source.id + '"]');
            await sourceRemove.click();
            const chooser = page.locator('[data-ui="stage-removal-dialog"]');
            await chooser.waitFor();
            const beforeCancel = await page.locator('[data-ui="stage-editor-stage"][data-stage-id="' + source.id + '"]').count();
            await page.locator('[data-ui="stage-removal-cancel"]').click();
            const afterCancel = await page.locator('[data-ui="stage-editor-stage"][data-stage-id="' + source.id + '"]').count();
            await sourceRemove.click();
            await chooser.waitFor();
            await page.locator('[data-ui="stage-removal-destination"]').click();
            await page.getByRole('option', { name: destination.title, exact: true }).click();
            const destinationMarker = await page.locator('[data-ui="stage-removal-destination"]').getAttribute('data-destination-stage-id');
            await page.locator('[data-ui="stage-removal-confirm"]').click();
            const removedAfterConfirm = await page.locator('[data-ui="stage-editor-stage"][data-stage-id="' + source.id + '"]').count();
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await page.locator('[data-ui="project-settings-dialog"]').waitFor({ state: 'hidden' });
            const migrated = await page.evaluate(async ({ projectId, ids }) => {
              const tasks = await Promise.all(ids.map(id => fetch('/api/projects/' + projectId + '/tasks/' + id).then(response => response.json())));
              return tasks.map(task => ({ status: task.status, archived: !!task.archived }));
            }, { projectId, ids: [active.id, archived.id] });

            await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();

            await page.getByRole('menuitem', { name: 'Project settings' }).click();
            await page.getByRole('tab', { name: 'Board', exact: true }).click();
            const raceRemove = page.locator('[data-ui="stage-editor-remove"][data-source-stage-id="' + raceStage.id + '"]');
            await raceRemove.click();
            await page.evaluate(async ({ projectId, raceStageId }) => {
              const task = await fetch('/api/projects/' + projectId + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'concurrent race card' }) }).then(response => response.json());
              await fetch('/api/projects/' + projectId + '/tasks/' + task.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: raceStageId }) });
            }, { projectId, raceStageId: raceStage.id });
            raceOccupied = true;
            const conflictDraftReady = page.locator('[data-ui="project-settings-dialog"]').waitFor({ state: 'visible' });
            const conflictChooserReady = page.locator('[data-ui="stage-removal-dialog"]').waitFor({ state: 'visible' });
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await Promise.all([conflictDraftReady, conflictChooserReady]);
            const conflictDraftOpen = await page.locator('[data-ui="project-settings-dialog"]').isVisible();
            const conflictChooserVisible = await page.locator('[data-ui="stage-removal-dialog"]').isVisible();
            const raceRestoredForChooser = await page.locator('[data-ui="stage-editor-stage"][data-stage-id="' + raceStage.id + '"]').count();
            await page.keyboard.press('Escape');
            const raceCleanup = await patchProject({ settings: { stages }, parentId: null, stageMigrations: [{ sourceStageId: raceStage.id, destinationStageId: destination.id }] });
            if (raceCleanup.status !== 200) throw new Error('race cleanup failed: ' + JSON.stringify(raceCleanup));
            const parentStages = stages.filter(stage => stage.id !== source.id && stage.id !== 'backlog');
            const parentCardMove = await page.evaluate(async ({ destinationId }) => {
              const response = await fetch('/api/projects/ui-paused/tasks/ui-task-paused-review', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: destinationId }) });
              return { status: response.status, body: await response.json().catch(() => null) };
            }, { destinationId: stages.find(stage => stage.id === 'question').id });
            if (parentCardMove.status !== 200) throw new Error('parent card setup failed: ' + JSON.stringify(parentCardMove));
            const backlogFixtureMove = await page.evaluate(async destinationId => {
              const tasks = await fetch('/api/projects/ui-running/tasks').then(response => response.json());
              const backlogTasks = tasks.filter(task => task.status === 'backlog');
              const results = await Promise.all(backlogTasks.map(task => fetch('/api/projects/ui-running/tasks/' + task.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: destinationId }) }).then(response => response.status)));
              return results;
            }, stages.find(stage => stage.id === 'question').id);
            if (backlogFixtureMove.some(status => status !== 200)) throw new Error('backlog fixture setup failed: ' + JSON.stringify(backlogFixtureMove));
            const parentSetup = await patchAnyProject('ui-paused', { settings: { stages: parentStages, isParent: true } });
            if (parentSetup.status !== 200) throw new Error('parent setup failed: ' + JSON.stringify(parentSetup));
            const inheritedTask = await createTask('occupied inherited-stage card');
            const inheritanceSource = stages.find(stage => stage.id === 'backlog');
            const inheritanceDestination = stages.find(stage => stage.id === 'question');
            const inheritedTaskMove = await patchTask(inheritedTask.id, { status: inheritanceSource.id });
            if (inheritedTaskMove !== 200) throw new Error('inherited task setup failed: ' + inheritedTaskMove);
            const inheritedTaskState = await page.evaluate(async taskId => fetch('/api/projects/ui-running/tasks/' + taskId).then(response => response.json()), inheritedTask.id);
            if (inheritedTaskState.status !== inheritanceSource.id) throw new Error('inherited task did not reach source stage: ' + JSON.stringify(inheritedTaskState));
            inheritedOccupied = true;
            await page.reload();
            await page.locator('[data-ui="kanban-content"]').waitFor();
            await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();
            await page.getByRole('menuitem', { name: 'Project settings' }).click();
            await page.locator('[data-ui="project-settings-dialog"]').waitFor();
            await page.getByRole('tab', { name: 'General', exact: true }).click();
            const pausedName = await page.evaluate(async () => {
              const projects = await fetch('/api/projects').then(response => response.json());
              return (Array.isArray(projects) ? projects : projects.projects).find(project => project.id === 'ui-paused').name;
            });
            await page.locator('#settings-parent-project').click();
            await page.getByRole('option', { name: pausedName, exact: true }).click();
            const selectedParent = await page.locator('#settings-parent-project').textContent();
            if (!selectedParent.includes(pausedName)) throw new Error('parent selection failed: ' + selectedParent);
            await page.getByRole('tab', { name: 'Board', exact: true }).click();
            await page.getByRole('button', { name: 'Reset to parent stages', exact: true }).click();
            const inheritanceChooser = page.locator('[data-ui="stage-removal-dialog"]');
            await inheritanceChooser.waitFor();
            while (await page.evaluate(() => document.querySelector('[data-ui="stage-removal-dialog"]')?.getAttribute('data-state') === 'open')) {
              await inheritanceChooser.locator('[data-ui="stage-removal-destination"]').click();
              await page.getByRole('option', { name: inheritanceDestination.title, exact: true }).click();
              await inheritanceChooser.locator('[data-ui="stage-removal-confirm"]').click();
              await page.waitForFunction(() => {
                const dialog = document.querySelector('[data-ui="stage-removal-dialog"]');
                const destination = dialog?.querySelector('[data-ui="stage-removal-destination"]');
                return !dialog || dialog.getAttribute('data-state') !== 'open' || destination?.getAttribute('data-destination-stage-id') === '';
              });
            }
            await inheritanceChooser.waitFor({ state: 'hidden' });
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await page.locator('[data-ui="project-settings-dialog"]').waitFor({ state: 'hidden' });
            const inheritedResult = await page.evaluate(async ({ projectId, taskId }) => {
              const project = (await (await fetch('/api/projects')).json()).find(project => project.id === projectId);
              const task = await fetch('/api/projects/' + projectId + '/tasks/' + taskId).then(response => response.json());
              return { parentId: project.parentId, stages: project.settings.stages, status: task.status };
            }, { projectId, taskId: inheritedTask.id });
            await deleteTask(active.id); await deleteTask(archived.id);
            await deleteTask(inheritedTask.id);
            return { beforeCancel, afterCancel, destinationMarker, destinationId: destination.id, removedAfterConfirm, migrated, savePayloads, conflictDraftOpen, conflictChooserVisible, raceRestoredForChooser, inheritedDestinationId: inheritanceDestination.id, inheritedResult };
          }`,
        )
      ).match(/### Result\n(.*)\n/)![1],
    );
    expect(result.beforeCancel).toBe(1);
    expect(result.afterCancel).toBe(1);
    expect(result.destinationMarker).toBe(result.destinationId);
    expect(result.removedAfterConfirm).toBe(0);
    expect(result.savePayloads[0].stageMigrations).toEqual([
      {
        sourceStageId: expect.any(String),
        destinationStageId: result.destinationId,
      },
    ]);
    expect(result.migrated).toEqual([
      { status: result.destinationId, archived: false },
      { status: result.destinationId, archived: true },
    ]);
    expect(result.conflictDraftOpen).toBe(true);
    expect(result.conflictChooserVisible).toBe(true);
    expect(result.raceRestoredForChooser).toBe(1);
    expect(result.inheritedResult).toEqual({
      parentId: 'ui-paused',
      stages: expect.anything(),
      status: result.inheritedDestinationId,
    });
    expect(result.inheritedResult.stages).toHaveLength(0);
  }, 60_000);
  test('switches checkout modes and conditionally exposes worktree parallelism', async () => {
    const result = JSON.parse(
      (
        await cli(
          'run-code',
          `async page => {
            await page.keyboard.press('Escape');
            await page.locator('[data-ui="project-title-menu-trigger"]:visible').first().click();
            await page.getByRole('menuitem', { name: 'Project settings' }).click();
            const dialog = page.locator('[data-ui="project-settings-dialog"]');
            await dialog.waitFor();
            await page.getByRole('tab', { name: 'Repository', exact: true }).click();
            const mode = page.locator('#settings-task-checkout-mode');
            const labels = { shared: 'Shared checkout', worktree: 'Dedicated worktree', branch: 'Dedicated branch' };
            const choose = async value => {
              await mode.click();
              await page.getByRole('option', { name: labels[value], exact: true }).click();
            };
            const currentValue = async () => {
              const text = await mode.textContent();
              return Object.entries(labels).find(([, label]) => text.includes(label))?.[0];
            };
            await choose('shared');
            const shared = {
              value: await currentValue(),
              explanation: await dialog.getByText(/may wait for the shared checkout/i).count(),
              parallel: await page.locator('#settings-parallel').count(),
            };

            await choose('worktree');
            const worktree = {
              value: await currentValue(),
              parallel: await page.locator('#settings-parallel').count(),
            };

            await choose('branch');
            const branch = {
              value: await currentValue(),
              parallel: await page.locator('#settings-parallel').count(),
            };
            return { shared, worktree, branch };
          }`,
        )
      ).match(/### Result\n(.*)\n/)![1],
    );
    expect(result.shared).toEqual({
      value: 'shared',
      explanation: 1,
      parallel: 0,
    });
    expect(result.worktree).toEqual({ value: 'worktree', parallel: 1 });
    expect(result.branch).toEqual({ value: 'branch', parallel: 0 });
  }, 30_000);
});
