// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  acquireRecordedSession,
  allocateBrowserTestRuntime,
  runBrowserCli,
  waitForViteReady,
} from '../../test-utils/browser-runtime';
const available = Bun.which('playwright-cli') !== null;
const runtime = available
  ? await allocateBrowserTestRuntime('queued-prompt')
  : undefined;
const { port, url } = runtime ?? { port: 0, url: '' };
let vite: Bun.Subprocess;
let releaseRecordedSession: () => void = () => {};
async function cli(...args: string[]) {
  return runBrowserCli(runtime, args);
}
(available ? describe : describe.skip)(
  'queued prompt mounted lifecycle',
  () => {
    beforeAll(async () => {
      releaseRecordedSession = await acquireRecordedSession(runtime);
      vite = Bun.spawn(
        [
          'npm',
          '--prefix',
          'ui',
          'run',
          'dev',
          '--',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      await waitForViteReady(vite);
      await cli('open', url);
    }, 180_000);
    afterAll(async () => {
      let cleanupError: unknown;
      try {
        if (!runtime.recorded) await cli('close');
      } catch (error) {
        cleanupError = error;
      } finally {
        try {
          vite?.kill();
          await vite?.exited;
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
    it('keeps restored persona prompt actions available', async () => {
      const output = await cli(
        'run-code',
        `async page => {
          await page.setContent('<div id="root"></div>');
          await page.evaluate(async () => {
            const { mountQueuedPromptListHarness } = await import('/src/components/chat/queued-prompt-list-browser-harness.tsx');
            mountQueuedPromptListHarness(document.getElementById('root'));
          });
          const queuedPrompt = page.locator('[data-ui="chat-steering-queued-prompt"]');
          await queuedPrompt.waitFor();
          const before = {
            text: await queuedPrompt.innerText(),
            actions: await queuedPrompt.locator('button').evaluateAll(buttons =>
              buttons.map(button => button.getAttribute('title')),
            ),
          };
          await page.evaluate(() => {
            window.queuedPromptHarness.drain();
            window.queuedPromptHarness.drain();
          });
          await queuedPrompt.waitFor({ state: 'detached' });
          return {
            before,
            after: {
              count: await page.locator('[data-ui="chat-steering-queued-prompt"]').count(),
              drains: await page.evaluate(() => window.queuedPromptHarness.drainCount()),
            },
          };
        }`,
      );
      expect(output).toContain('queued voice turn');
      expect(output).toContain(
        '"actions":["Use this queued prompt to steer the running turn","Edit this queued prompt","Delete queued prompt"]',
      );
      expect(output).toContain('"count":0');
      expect(output).toContain('"drains":1');
    }, 20_000);
  },
);
