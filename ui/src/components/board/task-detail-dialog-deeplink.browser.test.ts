// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'bun:test';

import {
  acquireRecordedSession,
  allocateBrowserTestRuntime,
  runBrowserCli,
} from '../../test-utils/browser-runtime';

const available = Bun.which('playwright-cli') !== null;
const runtime = available
  ? await allocateBrowserTestRuntime('task-detail-deeplink')
  : undefined;
let releaseRecordedSession: () => void = () => {};
let sandbox: Bun.Subprocess | undefined;
let ready: { uiUrl: string; apiUrl: string };

const describeBrowser = available ? describe.serial : describe.skip;

async function cli(...args: string[]): Promise<string> {
  return runBrowserCli(runtime, args);
}

async function waitForFile(filePath: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Install before inspecting the file so publication cannot fall between the
  // initial check and event subscription.
  const checkReady = () => {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'));
      resolve();
    } catch {
      // A creation event can precede the writer's completed JSON write.
    }
  };
  const watcher = fs.watch(path.dirname(filePath), (_event, filename) => {
    if (filename === path.basename(filePath)) checkReady();
  });
  watcher.on('error', reject);
  try {
    checkReady();
    await Promise.race([
      promise,
      sandbox!.exited.then(() => {
        throw new Error(
          'UI sandbox exited before publishing readiness metadata',
        );
      }),
    ]);
  } finally {
    watcher.close();
  }
}

/**
 * Build one self-contained Playwright callback. Each scenario drives the
 * production dialog against a seeded 120-message transcript with real browser
 * scroll clamping and lazy message layout — failure modes a mocked-geometry
 * suite cannot represent:
 *
 * - An ordinary kanban open (no runId) on a cold page performs the initial
 *   transcript fetch and must settle at the latest content once the initial
 *   data and delayed LazyBubble layout have settled. Closing it from the
 *   bottom, or after having read older content, and reopening (cached path),
 *   must again land at the bottom; a fresh page load must do the same on its
 *   own initial fetch.
 * - A first deep-link open aligns and flashes its run divider after loading
 *   older pages down to it.
 * - A reopened deep-linked dialog must settle at the latest content instead
 *   of re-jumping to the mid-transcript divider (the user-reported defect),
 *   while explicit Run History jumps keep targeting the divider.
 */
function scenario(body: string): string {
  return `async page => {
    const uiUrl = ${JSON.stringify(ready.uiUrl)};
    const apiUrl = ${JSON.stringify(ready.apiUrl)};
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const projectId = 'ui-running';
    const taskId = 'ui-task-completed';
    const runId = 'ui-run-completed';
    const deepLinkUrl =
      uiUrl + '/board/' + projectId + '?taskId=' + taskId + '&runId=' + runId;
    const plainUrl = uiUrl + '/board/' + projectId;
    // Serialized into the browser; keep it free of outer closures.
    const viewportStats = () => {
      const viewport = document.querySelector(
        '[data-ui="task-tab-content"][data-task-tab="chat"]',
      );
      if (!viewport) return null;
      const divider = document.querySelector(
        '[data-ui="task-run-divider"][data-run-id="' + 'ui-run-completed' + '"]',
      );
      let dTop = null;
      let ring = false;
      if (divider) {
        dTop =
          divider.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        ring = divider.className.includes('ring-2');
      }
      const messages = document.querySelectorAll(
        '[data-ui="task-transcript-message"]',
      );
      let lastMsgId = null;
      let lastVisible = false;
      let lastBottom = null;
      const last = messages[messages.length - 1];
      if (last) {
        lastMsgId = last.getAttribute('data-msg-id');
        const vr = viewport.getBoundingClientRect();
        const lr = last.getBoundingClientRect();
        lastBottom = lr.bottom - vr.bottom;
        lastVisible = lr.bottom > vr.top && lr.top < vr.bottom;
      }
      return {
        db: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        dTop,
        ring,
        msgs: messages.length,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollTop: viewport.scrollTop,
        lastMsgId,
        lastVisible,
        lastBottom,
      };
    };
    const waitForViewport = async (predicate, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await page.evaluate(viewportStats);
        if (last && predicate(last)) return last;
        await page.waitForTimeout(200);
      }
      throw new Error(
        'Chat viewport did not reach the expected state; last: ' +
          JSON.stringify(last),
      );
    };
    // The bottom only counts once it holds: LazyBubble hydration reflows
    // message heights for seconds after first paint, so a single matching
    // sample would let a viewport that later drifts mid-transcript pass.
    // Require distance-to-bottom <= 4 with the latest message visible, stable
    // across a 700 ms gap, before declaring the viewport settled.
    const waitSettledBottom = async (
      timeoutMs = 20000,
      label = 'Chat viewport',
    ) => {
      const deadline = Date.now() + timeoutMs;
      let stableSince = 0;
      let last = null;
      while (Date.now() < deadline) {
        last = await page.evaluate(viewportStats);
        if (last && last.db <= 4 && last.lastVisible) {
          if (!stableSince) stableSince = Date.now();
          else if (Date.now() - stableSince >= 700) return last;
        } else {
          stableSince = 0;
        }
        await page.waitForTimeout(200);
      }
      throw new Error(
        label + ' did not settle at the bottom; last: ' + JSON.stringify(last),
      );
    };
    // Sample for ~2.5 s after settlement and require the final sample to
    // still be at the bottom with the latest message visible, catching late
    // lazy-layout drift a one-shot check would miss.
    const assertSettledHolds = async label => {
      let last = null;
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(250);
        last = await page.evaluate(viewportStats);
      }
      assert(
        last && last.db <= 4 && last.lastVisible,
        label + ' left the settled bottom during delayed layout: ' +
          JSON.stringify(last),
      );
      return last;
    };
    // Sample for ~2.5 s after a deliberate scroll-up and require every
    // sample to stay far from the bottom, catching a late auto-follow
    // snap-back that a one-shot check right after the scroll would miss.
    const assertScrolledUpHolds = async label => {
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(250);
        const sample = await page.evaluate(viewportStats);
        assert(
          sample && sample.db > 1000,
          label + ' was snapped back toward the bottom: ' +
            JSON.stringify(sample),
        );
      }
    };
    // Lazy Markdown and async syntax highlighting grow the transcript after
    // the first paint; plain one-line filler would never exercise that.
    const fillerMessage = number =>
      'Deep link filler line ' + number + '\\n\\n' +
      'Paragraph ' + number + ': ' +
      'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(8) +
      '\\n\\n- first point\\n- second point\\n\\n' +
      '\\x60\\x60\\x60ts\\n' +
      Array.from({ length: 12 }, (_, line) =>
        'export const value' + number + '_' + line + ' = ' + line + ';',
      ).join('\\n') +
      '\\n\\x60\\x60\\x60';
    // A fresh sandbox seeds only three messages for the completed fixture;
    // grow the transcript past several pages so the run divider sits deep
    // in the history and the viewport cannot fit the whole transcript.
    const seedTranscript = async targetTotal => {
      let nextNumber;
      for (let attempt = 0; attempt <= 400; attempt += 1) {
        const response = await page.request.get(
          apiUrl +
            '/api/projects/' + projectId + '/tasks/' + taskId +
            '/messages?limit=1',
        );
        assert(
          response.ok(),
          'Transcript total lookup failed: ' + response.status(),
        );
        const result = await response.json();
        if (result.total >= targetTotal) return result.total;
        if (nextNumber === undefined) nextNumber = result.total + 1;
        const appended = await page.request.post(
          apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId + '/messages',
          { data: { content: fillerMessage(nextNumber++) } },
        );
        assert(
          appended.ok(),
          'Transcript seeding failed: ' + appended.status(),
        );
      }
      throw new Error('Transcript seeding stalled below ' + targetTotal);
    };
    const navigateTo = async url => {
      await page.evaluate(target => {
        history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, url);
    };
    const closeDialog = async () => {
      await page.keyboard.press('Escape');
      await page.locator('[role="dialog"]').waitFor({
        state: 'detached',
        timeout: 5000,
      });
    };
    // The URL keeps its deep-link parameters when the dialog closes, and the
    // board route reopens the dialog from them, so mimic a real user leaving
    // and returning to the shared link within one page session.
    const reopenDeepLink = async () => {
      await navigateTo(plainUrl);
      // The board's deep-link effect only re-fires once the router has
      // observed the link-less location, so wait for it to be applied.
      await page.waitForFunction(() => {
        const router = window.__TSR_ROUTER__;
        return (
          router &&
          router.state.status === 'idle' &&
          !new URLSearchParams(router.state.location.searchStr).has('taskId')
        );
      });
      await navigateTo(deepLinkUrl);
      await page.locator('[role="dialog"]').waitFor({ timeout: 15000 });
      await page
        .locator('[data-ui="task-tab-content"][data-task-tab="chat"]')
        .waitFor({ timeout: 15000 });
    };
    // Ordinary kanban open: click the card (no runId in the URL), then wait
    // for the dialog's Chat viewport to mount.
    const openKanbanCard = async () => {
      const card = page.locator(
        '[data-ui="kanban-card"][data-task-id="' + taskId + '"]',
      );
      await card.waitFor({ timeout: 30000 });
      await card.scrollIntoViewIfNeeded();
      await card.click();
      await page
        .locator('[data-ui="task-tab-content"][data-task-tab="chat"]')
        .waitFor({ timeout: 15000 });
    };
    ${body}
  }`;
}

describeBrowser('task detail dialog deep-link Chat settling', () => {
  beforeAll(async () => {
    releaseRecordedSession = await acquireRecordedSession(runtime);
    const readyPath = path.join(runtime.root, 'sandbox-ready.json');
    sandbox = Bun.spawn(['bash', 'scripts/ui-sandbox/run.sh', '--no-browser'], {
      cwd: process.cwd(),
      env: { ...runtime.env, UI_SANDBOX_READY_FILE: readyPath },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await waitForFile(readyPath);
    ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    await cli('open', ready.uiUrl);
    // A reused browser session keeps whatever viewport an earlier suite left
    // behind; the desktop layout is required below.
    await cli('resize', '1280', '900');
    await cli(
      'run-code',
      `async page => {
        await page.getByPlaceholder('Username').fill('ui-admin');
        await page.getByPlaceholder('Password').fill('carapa-ui-sandbox');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.locator('[data-ui="project-mode-switcher"][data-display="desktop"]').waitFor();
      }`,
    );
  }, 120_000);

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (runtime && !runtime.recorded) await cli('close');
    } catch (error) {
      cleanupError = error;
    } finally {
      if (sandbox) {
        sandbox.kill('SIGTERM');
        const code = await sandbox.exited;
        if (code !== 0 && !cleanupError)
          cleanupError = new Error(`UI sandbox exited ${code}`);
      }
      runtime?.cleanup();
      releaseRecordedSession();
    }
    if (cleanupError) throw cleanupError;
  }, 90_000);

  it('settles an ordinary kanban open and its reopens at the latest transcript content', async () => {
    await cli(
      'run-code',
      scenario(`
      // Cold page load: the query cache is empty, so the kanban open below
      // performs the initial transcript fetch.
      await page.goto(plainUrl, { waitUntil: 'load' });
      const seededTotal = await seedTranscript(120);
      assert(seededTotal >= 120, 'Transcript seeding fell short of 120 messages');

      // Ordinary open from the kanban board (no runId in the URL).
      await openKanbanCard();
      // The first page (20 newest messages) has rendered…
      const firstPage = await waitForViewport(stats => stats.msgs >= 18);
      assert(
        firstPage.scrollHeight > firstPage.clientHeight + 200,
        'Transcript does not overflow the Chat viewport on first paint: ' +
          JSON.stringify(firstPage),
      );
      // …then wait for the viewport to hold the bottom; the sampling in
      // assertSettledHolds below covers the 1500 ms settle window and the
      // LazyBubble hydration reflow that follows the initial paint.
      const opened = await waitSettledBottom(20000, 'Initial kanban open');
      assert(opened.lastMsgId, 'Initial kanban open rendered no transcript messages');
      await assertSettledHolds('Initial kanban open');

      // Closing from the bottom and reopening (cached query path) must land
      // at the latest content again.
      await closeDialog();
      await openKanbanCard();
      const reopenFromBottom = await waitSettledBottom(20000, 'Reopen after closing from the bottom');
      assert(
        reopenFromBottom.lastMsgId === opened.lastMsgId,
        'Reopened Chat shows a different latest message: ' +
          JSON.stringify({ opened, reopenFromBottom }),
      );
      await assertSettledHolds('Reopen after closing from the bottom');

      // Deliberate scroll-up during the open session must persist without
      // auto-follow snapping the viewport back to the bottom.
      await page.evaluate(() => {
        const viewport = document.querySelector(
          '[data-ui="task-tab-content"][data-task-tab="chat"]',
        );
        viewport.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 600, bubbles: true }),
        );
        viewport.scrollTop = Math.floor(viewport.scrollHeight * 0.1);
        viewport.dispatchEvent(new Event('scroll'));
      });
      await waitForViewport(stats => stats.db > 1000, 8000);
      await assertScrolledUpHolds('Manual scroll-up');

      // Reopening after having read older content must still land at the
      // bottom — a mid-transcript position must not carry over.
      await closeDialog();
      await openKanbanCard();
      const reopenAfterOlder = await waitSettledBottom(20000, 'Reopen after reading older content');
      assert(
        reopenAfterOlder.lastMsgId === opened.lastMsgId,
        'Reopened Chat shows a different latest message: ' +
          JSON.stringify({ opened, reopenAfterOlder }),
      );
      await assertSettledHolds('Reopen after reading older content');

      // A fresh page load must settle at the bottom on its own initial
      // transcript fetch as well.
      await page.goto(plainUrl, { waitUntil: 'load' });
      await openKanbanCard();
      const coldOpen = await waitSettledBottom(20000, 'Cold-start kanban open');
      assert(
        coldOpen.lastMsgId === opened.lastMsgId,
        'Cold-start open shows a different latest message: ' +
          JSON.stringify({ opened, coldOpen }),
      );
      await assertSettledHolds('Cold-start kanban open');
    `),
    );
  }, 300_000);

  it('aligns the run divider on first deep-link open', async () => {
    await cli(
      'run-code',
      scenario(`
      // First deep-link open: the (task, run) link loads the transcript
      // pages down to its run divider, aligns it, and flashes it once.
      await page.goto(deepLinkUrl, { waitUntil: 'load' });
      await page
        .locator('[data-ui="task-tab-content"][data-task-tab="chat"]')
        .waitFor({ timeout: 15000 });
      await waitForViewport(
        stats =>
          stats.dTop !== null &&
          Math.abs(stats.dTop - 5) <= 10 &&
          stats.msgs > 20,
        15000,
      );
      const ringSeen = await waitForViewport(
        stats => stats.ring === true,
        8000,
      )
        .then(() => true)
        .catch(() => false);
      assert(ringSeen, 'First deep-link open did not flash the run divider');
    `),
    );
  }, 120_000);

  it('settles a reopened deep-linked Chat at the latest transcript content', async () => {
    await cli(
      'run-code',
      scenario(`
      // First deep-link open on a fresh page: the one-shot (task, run) link
      // aligns its run divider after loading older pages down to it. A build
      // that loses that jump settles at the bottom of the first page instead;
      // accept whatever state the initial open reaches so the test proceeds
      // to the reopening, where the reported defect manifests.
      await page.goto(deepLinkUrl, { waitUntil: 'load' });
      await page
        .locator('[data-ui="task-tab-content"][data-task-tab="chat"]')
        .waitFor({ timeout: 15000 });
      await waitForViewport(stats => stats.msgs >= 20, 15000);
      await waitForViewport(
        stats => stats.dTop !== null && Math.abs(stats.dTop - 5) <= 10,
        15000,
      ).catch(() => null);
      const afterInitial = await page.evaluate(viewportStats);
      assert(
        afterInitial && afterInitial.msgs >= 20,
        'Initial deep-link open never rendered transcript pages: ' +
          JSON.stringify(afterInitial),
      );
      const loadedAfterInitial = afterInitial.msgs;

      // The user scrolls to the bottom while the dialog is open, as in the
      // report, before closing it. Keep scrolling until the bottom holds so
      // late page loads and layout reflow cannot move the viewport away.
      await page.waitForFunction(() => {
        const viewport = document.querySelector(
          '[data-ui="task-tab-content"][data-task-tab="chat"]',
        );
        if (!viewport) return false;
        viewport.scrollTop = viewport.scrollHeight;
        viewport.dispatchEvent(new Event('scroll'));
        const messages = document.querySelectorAll(
          '[data-ui="task-transcript-message"]',
        );
        const last = messages[messages.length - 1];
        if (!last) return false;
        const vr = viewport.getBoundingClientRect();
        const lr = last.getBoundingClientRect();
        return (
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4 &&
          lr.bottom > vr.top &&
          lr.top < vr.bottom
        );
      }, null, { timeout: 15000 });

      // Reopen the same deep link in this page session. The link is
      // one-shot, so the reopened Chat must settle at the latest content
      // instead of re-jumping to the mid-transcript divider.
      await closeDialog();
      await reopenDeepLink();
      const reopened = await waitSettledBottom(20000, 'Reopened deep-linked Chat');
      assert(
        reopened.msgs >= Math.max(40, loadedAfterInitial),
        'Reopened deep-linked transcript lost history the first open had loaded: ' +
          JSON.stringify({ loadedAfterInitial, reopened }),
      );

      // Explicit Run History jumps keep positioning the run divider instead
      // of the latest content.
      await page.click('[data-ui="task-detail-tab"][data-tab="history"]');
      await page
        .locator('[data-ui="task-run-history-entry"][data-run-id="ui-run-completed"]')
        .click();
      await waitForViewport(
        stats => stats.dTop !== null && Math.abs(stats.dTop - 5) <= 12,
        8000,
      );
      const jumped = await page.evaluate(viewportStats);
      assert(
        jumped && jumped.db > 1000,
        'Explicit run jump landed at the bottom instead of the run: ' +
          JSON.stringify(jumped),
      );
    `),
    );
  }, 240_000);
});
