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
  ? await allocateBrowserTestRuntime('direct-llm-sandbox')
  : undefined;
let releaseRecordedSession: () => void = () => {};
let sandbox: Bun.Subprocess | undefined;
let ready: { uiUrl: string; apiUrl: string; llmControlUrl: string };

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
 * Build one self-contained Playwright callback per scenario. Browser actions,
 * simulator control, durable API polling, and assertions stay in the same CLI
 * process instead of paying a new playwright-cli startup for every step.
 */
function scenario(body: string): string {
  return `async page => {
    const uiUrl = ${JSON.stringify(ready.uiUrl)};
    const apiUrl = ${JSON.stringify(ready.apiUrl)};
    const llmControlUrl = ${JSON.stringify(ready.llmControlUrl)};
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const requests = async () => {
      const response = await page.request.get(llmControlUrl + '/requests');
      assert(response.ok(), 'Simulator requests failed: ' + response.status());
      return response.json();
    };
    const waitForProviderRequest = async id => {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const request = (await requests()).find(item => item.id === id);
        if (request) return request;
        await page.waitForTimeout(25);
      }
      throw new Error('Provider request ' + id + ' never connected');
    };
    const controlProvider = async (id, action, data = {}) => {
      const response = await page.request.post(
        llmControlUrl + '/requests/' + id + '/' + action,
        { data },
      );
      assert(response.ok(), 'Simulator ' + action + ' failed: ' + response.status());
    };
    const transcriptEntries = async conversationId => {
      const entries = [];
      for (let offset = 0; ; offset += 2) {
        const response = await page.request.get(
          apiUrl + '/api/projects/ui-chat/conversations/' + conversationId +
            '/transcript?limit=2&offset=' + offset,
        );
        assert(response.ok(), 'Transcript page failed: ' + response.status());
        const result = await response.json();
        entries.push(...result.entries);
        if (!result.hasMore) return entries;
      }
    };
    const waitForTranscript = async (conversationId, predicate) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const entries = await transcriptEntries(conversationId);
        if (predicate(entries)) return entries;
        await page.waitForTimeout(25);
      }
      throw new Error('Durable transcript did not reach the expected state');
    };
    const openScenario = async (conversationId, title) => {
      await page.goto(uiUrl + '/chat/ui-chat?conversationId=' + conversationId);
      await page.locator('[data-ui="chat-conversation-title"]')
        .filter({ hasText: title }).waitFor({ timeout: 60000 });
      await page.locator('textarea[placeholder="Message…"]').waitFor();
    };
    const send = async content => {
      const composer = page.locator('textarea[placeholder="Message…"]');
      await composer.fill(content);
      await page.locator('[data-ui="chat-send-message"]').click();
    };
    const sendAndWaitForAdmission = async content => {
      // Match this prompt's own POST: an earlier send's admission response
      // can still be in flight and would otherwise satisfy the wait.
      const responsePromise = page.waitForResponse(response => {
        const request = response.request();
        if (request.method() !== 'POST' ||
          !response.url().includes('/api/projects/ui-chat/messages')) return false;
        try {
          return String(request.postDataJSON()?.content ?? '').includes(content);
        } catch {
          return false;
        }
      });
      await send(content);
      const response = await responsePromise;
      assert(response.ok(), 'Message admission failed: ' + response.status());
      return response.json();
    };
    const setLiveMode = async enabled => {
      const toggle = page.locator('[data-ui="live-mode-toggle"]');
      const running = (await toggle.count()) > 0;
      if (enabled === running) return;
      if (enabled) {
        await page.locator('[data-ui="composer-add-menu"]').click();
        await page.locator('[data-ui="start-live-mode-work-menu-item"]').click();
        await toggle.waitFor();
        return;
      }
      await toggle.click();
      await toggle.waitFor({ state: 'detached' });
    };
    const waitForRunIdle = async () => {
      await page.getByTitle('Stop running agent').waitFor({ state: 'detached' });
    };
    const messages = (entries, role, content) => entries.filter(
      entry => entry.type === 'message' && entry.role === role && entry.content === content,
    );
    const receipts = (entries, type, messageId) => entries.filter(
      entry => entry.type === type && entry.messageId === messageId,
    );
    const assertBrowserQueueOwnership = (entries, userContent, assistantContent) => {
      const users = messages(entries, 'user', userContent);
      assert(users.length === 1, 'Expected one browser-queued user message');
      const messageId = users[0].id;
      assert(typeof messageId === 'string', 'Queued user message has no id');
      assert(receipts(entries, 'direct_user_pending', messageId).length === 0,
        'Browser queue unexpectedly recorded direct pending');
      assert(receipts(entries, 'queued_user_released', messageId).length === 0,
        'Browser queue unexpectedly recorded release');
      assert(receipts(entries, 'queued_user_consumed', messageId).length === 0,
        'Browser queue unexpectedly recorded consumption');
      assert(messages(entries, 'assistant', assistantContent).length === 1,
        'Expected one browser-queued assistant message');
    };
    const assertFollowupOwnership = (entries, userContent, assistantContent) => {
      const users = messages(entries, 'user', userContent);
      assert(users.length === 1, 'Expected one follow-up user message');
      const messageId = users[0].id;
      assert(typeof messageId === 'string', 'Follow-up user message has no id');
      assert(receipts(entries, 'direct_user_pending', messageId).length === 1,
        'Expected one direct pending receipt');
      assert(receipts(entries, 'queued_user_released', messageId).length === 1,
        'Expected one released receipt');
      const consumed = receipts(entries, 'queued_user_consumed', messageId);
      assert(consumed.length === 1 && consumed[0].consumer === 'direct-followup',
        'Expected one direct-followup consumption receipt');
      const runId = consumed[0].runId;
      const finished = receipts(entries, 'direct_followup_finished', messageId);
      assert(finished.length === 1 && finished[0].runId === runId &&
        finished[0].outcome === 'completed', 'Expected one completed follow-up');
      const assistants = messages(entries, 'assistant', assistantContent);
      assert(assistants.length === 1, 'Expected one follow-up assistant message');
      assert(receipts(entries, 'turn_outcome', finished[0].assistantMessageId).length === 1,
        'Expected one assistant turn outcome');
      return { messageId, runId };
    };
    const assertOneFollowupProviderRequest = async (initialId, content) => {
      await waitForRunIdle();
      const matching = (await requests()).filter(
        request => request.id > initialId && request.lastUserText.includes(content),
      );
      assert(matching.length === 1 && matching[0].id === initialId + 1 &&
        matching[0].status === 'completed', 'Expected one completed provider follow-up');
    };
    const assertBrowserQueueReconciled = async conversationId => {
      const response = await page.request.post(
        apiUrl + '/api/projects/ui-chat/conversations/' + conversationId +
          '/queued-messages/reconcile',
      );
      assert(response.ok(), 'Queue reconciliation failed: ' + response.status());
      const result = await response.json();
      assert(result.active === false && result.pending.length === 0 &&
        result.released.length === 0 && result.consumed.length === 0,
        'Browser queue did not reconcile cleanly');
    };
    ${body}
  }`;
}

describeBrowser('real Direct-LLM disposable sandbox lifecycle', () => {
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
    // Board-managed runs share one browser across suites; reset any mobile
    // viewport a previous suite left so the desktop mode switcher renders.
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

  it('keeps the running task composer available and queues one same-stage continuation', async () => {
    await cli(
      'run-code',
      scenario(`
      const projectId = 'ui-task-steering';
      const taskId = 'ui-task-steering';
      const queuedContent = 'Apply this queued task correction once';
      const initialId = (await requests()).length + 1;
      const execution = await page.request.post(
        apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId +
          '/execute?stage=in_progress',
        { data: { prompt: 'Hold the initial task response open' } },
      );
      assert(execution.status() === 202,
        'Task execution did not start: ' + execution.status());
      await waitForProviderRequest(initialId);

      await page.goto(
        uiUrl + '/board/' + projectId + '?taskId=' + taskId,
      );
      await page.locator(
        '[data-ui="task-detail-tab"][data-tab="chat"]',
      ).click();
      await page.getByText('Agent is running…', { exact: false }).waitFor();
      const stop = page.getByRole('button', { name: 'Stop', exact: true });
      await stop.waitFor();
      const composer = page.locator('textarea[placeholder="Follow-up message…"]');
      await composer.waitFor();

      const admissionPromise = page.waitForResponse(response =>
        response.request().method() === 'POST' &&
        response.url().endsWith(
          '/api/projects/' + projectId + '/tasks/' + taskId + '/messages',
        ),
      );
      await composer.fill(queuedContent);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const admission = await admissionPromise;
      assert(admission.ok(), 'Task message admission failed: ' + admission.status());
      const delivery = await admission.json();
      assert(delivery.delivery === 'queued',
        'Unsupported Direct-LLM steering was not queued');
      assert(typeof delivery.id === 'string' && delivery.id.length > 0,
        'Canonical task message has no stable ID');

      const acknowledgement = page.locator(
        '[data-ui="task-steering-delivery"]' +
          '[data-message-id="' + delivery.id + '"]' +
          '[data-steering-status="queued"]',
      );
      await acknowledgement.waitFor();
      assert((await acknowledgement.textContent())?.includes(
        'Message queued for the continuation.',
      ), 'Queued task delivery feedback is missing');
      assert(await page.getByText(queuedContent, { exact: true }).count() === 1,
        'Task UI did not render one canonical user bubble');

      const beforeRelease = await page.request.get(
        apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId,
      );
      assert(beforeRelease.ok(), 'Task lookup failed before completion');
      assert((await beforeRelease.json()).status === 'in_progress',
        'Queued steering changed the task stage before completion');

      await controlProvider(initialId, 'release', {
        text: 'Initial task response completed',
      });
      const continuation = await waitForProviderRequest(initialId + 1);
      assert(continuation.lastUserText.includes(queuedContent),
        'Same-stage continuation did not receive the queued prompt');
      assert(continuation.lastUserText.split(queuedContent).length === 2,
        'Same-stage continuation received the queued prompt more than once');

      const duringContinuation = await page.request.get(
        apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId,
      );
      assert(duringContinuation.ok(), 'Task lookup failed during continuation');
      assert((await duringContinuation.json()).status === 'in_progress',
        'Finishing run advanced before its continuation completed');

      await controlProvider(initialId + 1, 'release', {
        text: 'Queued task correction applied',
      });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const response = await page.request.get(
          apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId,
        );
        if (response.ok() && (await response.json()).status === 'completed') break;
        await page.waitForTimeout(25);
      }
      const completed = await page.request.get(
        apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId,
      );
      assert(completed.ok() && (await completed.json()).status === 'completed',
        'Task did not advance after its pending prompt was consumed');

      const transcriptResponse = await page.request.get(
        apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId +
          '/messages?limit=100&offset=0',
      );
      assert(transcriptResponse.ok(), 'Task transcript lookup failed');
      const transcript = (await transcriptResponse.json()).messages;
      const canonical = transcript.filter(message =>
        message.role === 'user' && message.content === queuedContent,
      );
      assert(canonical.length === 1 && canonical[0].id === delivery.id,
        'Task transcript did not retain exactly one canonical queued message');
      const taskReceipts = transcript.filter(message =>
        message.entry_type === 'steering_delivery' &&
        message.prompt_id === delivery.id,
      );
      const runsResponse = await page.request.get(
        apiUrl + '/api/projects/' + projectId + '/tasks/' + taskId + '/runs',
      );
      assert(runsResponse.ok(), 'Task run history lookup failed');
      const runHistory = await runsResponse.json();
      assert(runHistory.total === 2 && runHistory.runs.length === 2,
        'Queued correction did not produce exactly two task runs');
      assert(runHistory.runs.every(run => run.stage === 'in_progress'),
        'Continuation did not remain in the originating stage');
      assert(taskReceipts.length === 1 &&
        taskReceipts[0].run_id === runHistory.runs[0].id &&
        taskReceipts[0].run_id !== runHistory.runs[1].id,
        'Continuation did not write one durable prompt receipt');
    `),
    );
  }, 120_000);

  it('steers an in-flight response and renders the same-run acknowledgement', async () => {
    await cli(
      'run-code',
      scenario(`
      const conversationId = 'ui-conversation-direct';
      await openScenario(conversationId, 'Direct LLM steering lifecycle');
      const initialId = (await requests()).length + 1;
      await setLiveMode(true);
      await send('S1 initial held response');
      await waitForProviderRequest(initialId);
      const admissionPromise = sendAndWaitForAdmission('S1 steer current response');
      await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]')
        .filter({ hasText: 'Applying to current turn…' }).waitFor();
      await admissionPromise;
      await controlProvider(initialId, 'release', { text: 'S1 initial assistant response' });
      const steeredRequest = await waitForProviderRequest(initialId + 1);
      assert(steeredRequest.lastUserText.includes('S1 steer current response'),
        'Steered provider request did not contain the prompt');
      const steeredAcknowledgement = page
        .locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]')
        .filter({ hasText: 'Applied to current turn' }).waitFor();
      await controlProvider(initialId + 1, 'release', { text: 'S1 steered assistant response' });
      await Promise.all([steeredAcknowledgement, waitForTranscript(conversationId, items =>
        messages(items, 'user', 'S1 steer current response')
          .some(message => message.steeringDelivery === 'steered'))]);
      await page.getByText('S1 steered assistant response', { exact: true }).waitFor();
      const entries = await waitForTranscript(conversationId,
        items => messages(items, 'assistant', 'S1 steered assistant response').length === 1);
      const pending = entries.filter(entry => entry.type === 'direct_user_pending');
      assert(pending.length === 1, 'Expected one steered pending receipt');
      const messageId = pending[0].messageId;
      const steered = messages(entries, 'user', 'S1 steer current response')
        .filter(message => message.id === messageId && message.steeringDelivery === 'steered');
      assert(steered.length === 1, 'Expected one steered user message');
      assert(receipts(entries, 'queued_user_released', messageId).length === 0,
        'Steered message was unexpectedly released');
      assert(receipts(entries, 'queued_user_consumed', messageId).length === 0,
        'Steered message was unexpectedly consumed');
      await setLiveMode(false);
      await waitForRunIdle();
    `),
    );
  }, 120_000);

  it('queues at the terminal boundary and starts one canonical follow-up', async () => {
    await cli(
      'run-code',
      scenario(`
      const conversationId = 'ui-conversation-direct-queue';
      await openScenario(conversationId, 'Direct LLM queued follow-up');
      const initialId = (await requests()).length + 1;
      await setLiveMode(true);
      await send('S2 terminal-boundary response');
      await waitForProviderRequest(initialId);
      const submit = (async () => {
        await page.locator('[data-ui="chat-canonical-main-transcript-message"]')
          .filter({ hasText: 'S2 first assistant response' }).waitFor();
        const admission = sendAndWaitForAdmission('S2 exactly-once queued follow-up');
        await page.locator('[data-ui="chat-steering-queued-prompt"]')
          .filter({ hasText: 'S2 exactly-once queued follow-up' }).waitFor();
        await admission;
      })();
      await controlProvider(initialId, 'release', { text: 'S2 first assistant response' });
      await submit;
      const followup = await waitForProviderRequest(initialId + 1);
      assert(followup.lastUserText.includes('S2 exactly-once queued follow-up'),
        'Queued follow-up did not reach the provider');
      await controlProvider(initialId + 1, 'release', { text: 'S2 follow-up assistant response' });
      const entries = await waitForTranscript(conversationId,
        items => messages(items, 'assistant', 'S2 follow-up assistant response').length === 1);
      assertBrowserQueueOwnership(entries, 'S2 exactly-once queued follow-up',
        'S2 follow-up assistant response');
      await setLiveMode(false);
      await assertOneFollowupProviderRequest(initialId, 'S2 exactly-once queued follow-up');
      await assertBrowserQueueReconciled(conversationId);
    `),
    );
  }, 120_000);

  it('releases an admitted prompt after provider failure and follows up once', async () => {
    await cli(
      'run-code',
      scenario(`
      const conversationId = 'ui-conversation-direct-failure';
      await openScenario(conversationId, 'Direct LLM provider failure');
      const initialId = (await requests()).length + 1;
      await setLiveMode(true);
      await send('S3 provider failure response');
      await waitForProviderRequest(initialId);
      await sendAndWaitForAdmission('S3 admitted before failure');
      await controlProvider(initialId, 'fail', { message: 'S3 deterministic provider failure' });
      const followup = await waitForProviderRequest(initialId + 1);
      assert(followup.lastUserText.includes('S3 admitted before failure'),
        'Failure follow-up did not reach the provider');
      await controlProvider(initialId + 1, 'release', { text: 'S3 recovered follow-up response' });
      const entries = await waitForTranscript(conversationId, items =>
        messages(items, 'assistant', 'S3 recovered follow-up response').length === 1 &&
        items.some(entry => entry.type === 'direct_followup_finished' &&
          typeof entry.messageId === 'string'));
      assertFollowupOwnership(entries, 'S3 admitted before failure',
        'S3 recovered follow-up response');
      await setLiveMode(false);
      await assertOneFollowupProviderRequest(initialId, 'S3 admitted before failure');
    `),
    );
  }, 120_000);

  it('reconciles an admitted prompt when the active run is stopped', async () => {
    await cli(
      'run-code',
      scenario(`
      const conversationId = 'ui-conversation-direct-stop';
      await openScenario(conversationId, 'Direct LLM stopped run');
      const initialId = (await requests()).length + 1;
      await setLiveMode(true);
      await send('S4 stopped response');
      await waitForProviderRequest(initialId);
      await sendAndWaitForAdmission('S4 admitted before stop');
      await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]')
        .filter({ hasText: 'Applying to current turn…' }).last().waitFor();
      await page.getByTitle('Stop running agent').click();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const stopped = (await requests()).find(item => item.id === initialId);
        if (stopped?.status === 'aborted') break;
        await page.waitForTimeout(25);
      }
      assert((await requests()).find(item => item.id === initialId)?.status === 'aborted',
        'Provider request was not aborted');
      const followup = await waitForProviderRequest(initialId + 1);
      assert(followup.lastUserText.includes('S4 admitted before stop'),
        'Stopped-run follow-up did not reach the provider');
      await controlProvider(initialId + 1, 'release', { text: 'S4 reconciled follow-up response' });
      const entries = await waitForTranscript(conversationId, items =>
        messages(items, 'assistant', 'S4 reconciled follow-up response').length === 1 &&
        items.some(entry => entry.type === 'direct_followup_finished' &&
          typeof entry.messageId === 'string'));
      const ownership = assertFollowupOwnership(entries, 'S4 admitted before stop',
        'S4 reconciled follow-up response');
      await setLiveMode(false);
      let reconciliation;
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const response = await page.request.post(apiUrl +
          '/api/projects/ui-chat/conversations/' + conversationId + '/queued-messages/reconcile');
        if (response.ok()) {
          reconciliation = await response.json();
          if (!reconciliation.active) break;
        }
        await page.waitForTimeout(25);
      }
      assert(reconciliation?.active === false, 'Stopped queue stayed active');
      assert([...reconciliation.released, ...reconciliation.consumed]
        .includes(ownership.messageId), 'Stopped message was not reconciled');
      await assertOneFollowupProviderRequest(initialId, 'S4 admitted before stop');
    `),
    );
  }, 120_000);

  it('recovers a queued response from durable state after missing chat_completed', async () => {
    await cli(
      'run-code',
      scenario(`
      const conversationId = 'ui-conversation-direct-reconnect';
      await openScenario(conversationId, 'Direct LLM reconnect recovery');
      const initialId = (await requests()).length + 1;
      await send('S5 reconnect response');
      const request = await waitForProviderRequest(initialId);
      assert(request.lastUserText.includes('S5 reconnect response'),
        'Reconnect request did not reach the provider');
      await send('S5 reconnect queued follow-up');
      await page.locator('[data-ui="chat-steering-queued-prompt"]')
        .filter({ hasText: 'S5 reconnect queued follow-up' }).waitFor();
      await page.context().setOffline(true);
      await controlProvider(initialId, 'release', { text: 'S5 completed while disconnected' });
      await waitForTranscript(conversationId,
        items => messages(items, 'assistant', 'S5 completed while disconnected').length === 1);
      await page.context().setOffline(false);
      await page.reload();
      await page.getByText('S5 completed while disconnected', { exact: true }).waitFor();
      const followup = await waitForProviderRequest(initialId + 1);
      assert(followup.lastUserText.includes('S5 reconnect queued follow-up'),
        'Reconnect follow-up did not reach the provider');
      await controlProvider(initialId + 1, 'release', { text: 'S5 durable reconnect follow-up' });
      await page.getByText('S5 durable reconnect follow-up', { exact: true }).waitFor();
      const entries = await waitForTranscript(conversationId,
        items => messages(items, 'assistant', 'S5 durable reconnect follow-up').length === 1);
      assertBrowserQueueOwnership(entries, 'S5 reconnect queued follow-up',
        'S5 durable reconnect follow-up');
      await assertOneFollowupProviderRequest(initialId, 'S5 reconnect queued follow-up');
      await assertBrowserQueueReconciled(conversationId);
    `),
    );
  }, 120_000);
});
