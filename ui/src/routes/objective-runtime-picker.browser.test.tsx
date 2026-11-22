// @ts-nocheck
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  acquireRecordedSession,
  allocateBrowserTestRuntime,
  runBrowserCli,
} from '../test-utils/browser-runtime';

const hasPlaywrightCli = Bun.which('playwright-cli') !== null;
const browser = hasPlaywrightCli ? describe : describe.skip;
const runtime = hasPlaywrightCli
  ? await allocateBrowserTestRuntime('objective-runtime-picker')
  : undefined;
const urlPattern = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/board\/ui-running)/;
let sandbox: Bun.Subprocess;
let sandboxUrl: string;
let releaseRecordedSession: () => void = () => {};

// Opens a Radix Select trigger by its accessible name and picks an option by label.
const pickOption = `async function pick(page, scope, name, option) {
  await scope.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}`;

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

browser('Objective event runtime picker', () => {
  beforeAll(async () => {
    releaseRecordedSession = await acquireRecordedSession(runtime);
    await startSandbox();
    await cli('open', sandboxUrl);
    await cli(
      'run-code',
      `async page => {
        await page.goto(${JSON.stringify(sandboxUrl)});
        await page.getByPlaceholder('Username').fill('ui-admin');
        await page.getByPlaceholder('Password').fill('carapa-ui-sandbox');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.locator('[data-ui="kanban-content"]').waitFor();
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

  test('saves, reloads, and clears the event-only override', async () => {
    const result = JSON.parse(
      (
        await cli(
          'run-code',
          `async page => {
            const objectiveUrl = ${JSON.stringify(`${new URL(sandboxUrl).origin}/objective/ui-objectives/ui-objective-active`)};
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.goto(objectiveUrl);
            await page.getByRole('button', { name: 'Edit objective' }).waitFor();
            await page.getByRole('button', { name: 'Edit objective' }).click();
            let dialog = page.locator('[data-ui="edit-objective-dialog"]');
            const runtime = dialog.locator('[data-ui="objective-event-runtime-override"]');
            await runtime.waitFor();
            ${pickOption}
            await pick(page, runtime, 'Runtime', 'Direct');
            await pick(page, runtime, 'Reasoning', 'high');
            await Promise.all([
              page.waitForResponse(response => response.url().includes('/api/projects/ui-objectives/objectives/ui-objective-active') && response.request().method() === 'PUT' && response.ok()),
              dialog.getByRole('button', { name: 'Save' }).click(),
            ]);
            await dialog.waitFor({ state: 'hidden' });
            await page.reload();
            await page.getByRole('button', { name: 'Edit objective' }).waitFor();
            await page.getByRole('button', { name: 'Edit objective' }).click();
            dialog = page.locator('[data-ui="edit-objective-dialog"]');
            await dialog.waitFor();
            const reopenedRuntime = dialog.locator('[data-ui="objective-event-runtime-override"]');
            const reopened = [];
            for (const name of ['Runtime', 'Model', 'Reasoning']) {
              reopened.push((await reopenedRuntime.getByRole('combobox', { name, exact: true }).textContent())?.trim());
            }
            await pick(page, reopenedRuntime, 'Runtime', 'Default runtime');
            await Promise.all([
              page.waitForResponse(response => response.url().includes('/api/projects/ui-objectives/objectives/ui-objective-active') && response.request().method() === 'PUT' && response.ok()),
              dialog.getByRole('button', { name: 'Save' }).click(),
            ]);
            await dialog.waitFor({ state: 'hidden' });
            await page.reload();
            await page.getByRole('button', { name: 'Edit objective' }).waitFor();
            await page.getByRole('button', { name: 'Edit objective' }).click();
            dialog = page.locator('[data-ui="edit-objective-dialog"]');
            await dialog.waitFor();
            const clearedHarness = (await dialog.locator('[data-ui="objective-event-runtime-override"]').getByRole('combobox', { name: 'Runtime', exact: true }).textContent())?.trim();
            return { reopened, clearedHarness };
          }`,
        )
      ).match(/### Result\n(.*)\n/)![1],
    );
    expect(result).toEqual({
      reopened: ['Direct', 'Deterministic UI simulator', 'high'],
      clearedHarness: 'Default runtime',
    });
  }, 30_000);

  test('keeps activation failures visible and allows a budget correction', async () => {
    const result = JSON.parse(
      (
        await cli(
          'run-code',
          `async page => {
            const objectiveUrl = ${JSON.stringify(`${new URL(sandboxUrl).origin}/objective/ui-objectives/ui-objective-paused`)};
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.goto(objectiveUrl);
            await page.getByRole('button', { name: 'Edit objective' }).waitFor();
            await page.getByRole('button', { name: 'Edit objective' }).click();
            let dialog = page.locator('[data-ui="edit-objective-dialog"]');
            const costLimit = dialog.locator('label').filter({ hasText: 'Cost limit' }).locator('..').locator('input');
            await costLimit.fill('0');
            await Promise.all([
              page.waitForResponse(response => response.url().includes('/api/projects/ui-objectives/objectives/ui-objective-paused') && response.request().method() === 'PUT' && response.ok()),
              dialog.getByRole('button', { name: 'Save' }).click(),
            ]);
            await dialog.waitFor({ state: 'hidden' });

            const blockedResponsePromise = page.waitForResponse(response => response.url().includes('/api/projects/ui-objectives/objectives/ui-objective-paused') && response.request().method() === 'PUT');
            await page.locator('[data-ui="objective-status-action"][data-objective-status="active"]').click();
            const blockedResponse = await blockedResponsePromise;
            const statusError = page.locator('[data-ui="objective-status-error"]');
            await statusError.waitFor();
            const blocked = {
              status: blockedResponse.status(),
              message: (await statusError.textContent())?.trim(),
              renderedStatus: (await page.locator('[data-ui="objective-status-action"][aria-pressed="true"]').textContent())?.trim(),
            };

            await page.getByRole('button', { name: 'Edit objective' }).click();
            dialog = page.locator('[data-ui="edit-objective-dialog"]');
            ${pickOption}
            await pick(page, dialog, 'Status', 'Active');
            await dialog.locator('label').filter({ hasText: 'Cost limit' }).locator('..').locator('input').fill('1');
            await Promise.all([
              page.waitForResponse(response => response.url().includes('/api/projects/ui-objectives/objectives/ui-objective-paused') && response.request().method() === 'PUT' && response.ok()),
              dialog.getByRole('button', { name: 'Save' }).click(),
            ]);
            await dialog.waitFor({ state: 'hidden' });
            const correctedErrorVisible = await statusError.isVisible();
            await page.reload();
            await page.locator('[data-ui="objective-status-action"][aria-pressed="true"]').waitFor();
            const statusAfterReload = (await page.locator('[data-ui="objective-status-action"][aria-pressed="true"]').textContent())?.trim();
            return { blocked, correctedErrorVisible, statusAfterReload };
          }`,
        )
      ).match(/### Result\n(.*)\n/)![1],
    );

    expect(result).toEqual({
      blocked: {
        status: 409,
        message:
          "The objective's cost limit has been reached. Raise or remove the cost limit to resume it.",
        renderedStatus: 'Paused',
      },
      correctedErrorVisible: false,
      statusAfterReload: 'Active',
    });
  }, 30_000);

  test('keeps the edit open for request errors and successful status mismatches', async () => {
    const result = JSON.parse(
      (
        await cli(
          'run-code',
          `async page => {
            const objectiveUrl = ${JSON.stringify(`${new URL(sandboxUrl).origin}/objective/ui-objectives/ui-objective-draft`)};
            let updateAttempt = 0;
            await page.route('**/api/projects/ui-objectives/objectives/ui-objective-draft', async route => {
              if (route.request().method() !== 'PUT') return route.continue();
              updateAttempt += 1;
              if (updateAttempt === 1) {
                return route.fulfill({
                  status: 500,
                  contentType: 'application/json',
                  body: JSON.stringify({ error: 'Fixture update was rejected' }),
                });
              }
              return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                  id: 'ui-objective-draft',
                  project_id: 'ui-objectives',
                  title: 'Draft objective',
                  description: 'Not started.',
                  status: 'paused',
                  priority: 0,
                  progress: 0,
                  cost_limit_usd: 0,
                  created_at: '2026-07-25T09:00:00.000Z',
                  updated_at: '2026-07-28T07:30:00.000Z',
                }),
              });
            });
            await page.goto(objectiveUrl);
            await page.getByRole('button', { name: 'Edit objective' }).click();
            const dialog = page.locator('[data-ui="edit-objective-dialog"]');
            ${pickOption}
            await pick(page, dialog, 'Status', 'Active');
            await dialog.getByRole('button', { name: 'Save' }).click();
            const editError = dialog.locator('[data-ui="objective-edit-error"]');
            await editError.waitFor();
            const rejectedMessage = (await editError.textContent())?.trim();

            await pick(page, dialog, 'Status', 'Active');
            await dialog.getByRole('button', { name: 'Save' }).click();
            await editError.getByText('cost limit has been reached', { exact: false }).waitFor();
            const mismatchMessage = (await editError.textContent())?.trim();
            const dialogStillOpen = await dialog.isVisible();
            await page.unroute('**/api/projects/ui-objectives/objectives/ui-objective-draft');
            return { rejectedMessage, mismatchMessage, dialogStillOpen };
          }`,
        )
      ).match(/### Result\n(.*)\n/)![1],
    );

    expect(result).toEqual({
      rejectedMessage: 'Fixture update was rejected',
      mismatchMessage:
        "The objective's cost limit has been reached. Raise or remove the cost limit to resume it.",
      dialogStillOpen: true,
    });
  }, 30_000);
});
