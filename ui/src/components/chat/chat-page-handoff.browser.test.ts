// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  acquireRecordedSession,
  allocateBrowserTestRuntime,
  runBrowserCli,
} from '../../test-utils/browser-runtime';

const hasPlaywrightCli = Bun.which('playwright-cli') !== null;
const runtime = hasPlaywrightCli
  ? await allocateBrowserTestRuntime('chat-page-handoff')
  : undefined;
const { port, url } = runtime ?? { port: 0, url: '' };
const harnessUrl = `${url}/chat-page-handoff-harness.html`;
const packageJsonPath = new URL('../../../../package.json', import.meta.url)
  .pathname;
// Board-managed runs pin every CLI call to one shared session (see
// runPlaywrightCliOnce), so `close` would end it for the remaining tests.
const ownsBrowserSessions = !!runtime && !runtime.recorded && !runtime.managed;
const session = runtime?.session ?? '';
const configuredSession = `${session}-configured`;
const stopSession = `${session}-stop`;
const multiProjectSession = `${session}-multi-project`;
let vite: Bun.Subprocess;
let releaseRecordedSession: () => void = () => {};

async function cliFor(sessionName: string, ...args: string[]) {
  return runBrowserCli(
    runtime,
    args,
    sessionName === session ? undefined : sessionName,
  );
}

const cli = (...args: string[]) => cliFor(session, ...args);
const configuredCli = (...args: string[]) => cliFor(configuredSession, ...args);
const multiProjectCli = (...args: string[]) =>
  cliFor(multiProjectSession, ...args);

const describeBrowser = hasPlaywrightCli ? describe : describe.skip;

describeBrowser('mounted ChatPage persona handoff ownership', () => {
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
    const reader = vite.stdout.getReader();
    const decoder = new TextDecoder();
    let viteOutput = '';
    while (!viteOutput.includes('Local:')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Vite exited before becoming ready');
      viteOutput += decoder.decode(chunk.value);
    }
    reader.releaseLock();
    await cli('open', harnessUrl);
    await cli('resize', '390', '844');
    await multiProjectCli('open', harnessUrl);
    await multiProjectCli('resize', '390', '844');
    const output = await cli(
      'run-code',
      `async page => { await page.setContent('<div id="root"></div>'); await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); })); await page.locator('[data-ui="chat-generic-main-stream"]').waitFor(); }`,
    );
  }, 180_000);

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (ownsBrowserSessions) {
        try {
          await cli('close');
        } catch (error) {
          cleanupError = error;
        }
        try {
          await configuredCli('close');
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await cliFor(stopSession, 'close');
        } catch (error) {
          cleanupError ??= error;
        }
        try {
          await multiProjectCli('close');
        } catch (error) {
          cleanupError ??= error;
        }
      }
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
  }, 30_000);

  it('keeps text and attachment together through active-run queue draining', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        const uploadBodies = [];
        const messageBodies = [];
        const uploadGate = Promise.withResolvers();
        const uploadRequestGate = Promise.withResolvers();
        let acknowledgeMessage;
        const messageGate = Promise.withResolvers();
        const requestGate = Promise.withResolvers();
        await page.route('**/api/projects/handoff-browser-project/upload', async route => {
          uploadBodies.push(route.request().postDataJSON());
          uploadRequestGate.resolve();
          await uploadGate.promise;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            containerPath: '/workspace/group/uploads/package.json',
            browserUrl: '/api/projects/handoff-browser-project/attachments/package.json',
            originalName: 'package.json',
            absolutePath: '/workspace/group/uploads/package.json',
          }) });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', async route => {
          const requestBody = route.request().postDataJSON();
          messageBodies.push(requestBody);
          acknowledgeMessage = messageGate.resolve;
          requestGate.resolve();
          await messageGate.promise;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            conversation_id: 'handoff-browser-conversation',
            userMessage: {
              id: requestBody.clientSubmissionId,
              role: 'user',
              content: requestBody.content,
              created_at: new Date().toISOString(),
            },
          }) });
        });

        await page.evaluate(() => window.chatPageHandoffHarness.setComposerContext(
          'deep',
          [{ label: 'Task details', href: '/tasks/task-context' }],
        ));
        const fileInput = page.locator('input[type="file"][multiple]');
        await fileInput.setInputFiles('${packageJsonPath}');
        await page.locator('textarea[placeholder="Message…"]').fill('Keep this file with my text');
        await page.locator('[data-ui="chat-send-message"]').click();
        await uploadRequestGate.promise;
        await page.locator('textarea[placeholder="Message…"]').fill('A newer draft');
        uploadGate.resolve();

        const queued = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Keep this file with my text' });
        await queued.waitFor();
        const queuedOwners = await queued.count();
        const queuedState = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('carapa-ui-state')).state
            .queuedPromptsByConv['handoff-browser-conversation'],
        );

        const drainedRequest = page.waitForRequest(request =>
          request.url().endsWith('/api/projects/handoff-browser-project/messages'),
        );
        await page.evaluate(() => window.chatPageHandoffHarness.stop());
        await drainedRequest;
        await requestGate.promise;
        if (!messageBodies[0] || !acknowledgeMessage) throw new Error('queued message was not drained');
        const rendered = page.locator('[data-ui="chat-current-user-message"], [data-ui="chat-other-user-message"]').filter({ hasText: 'Keep this file with my text' });
        await rendered.waitFor();
        const drainedResponse = page.waitForResponse(response =>
          response.url().endsWith('/api/projects/handoff-browser-project/messages'),
        );
        acknowledgeMessage();
        await drainedResponse;
        await page.waitForFunction(() =>
          document.querySelector('[data-ui="chat-steering-queue"]') === null,
        );
        const renderedText = await rendered.textContent();
        const renderedAttachmentLinks = await rendered.locator(
          'a[href$="/api/projects/handoff-browser-project/attachments/package.json"]',
        ).count();

        const result = {
          uploadBodies,
          messageBodies,
          queuedOwners,
          queuedState,
          renderedText,
          renderedAttachmentLinks,
          composerDraft: await page.locator('textarea[placeholder="Message…"]').inputValue(),
          composerContext: await page.evaluate(() =>
            window.chatPageHandoffHarness.getComposerContext(),
          ),
        };
        await page.unroute('**/api/projects/handoff-browser-project/upload');
        await page.unroute('**/api/projects/handoff-browser-project/messages');
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.uploadBodies).toHaveLength(1);
    expect(result.queuedOwners).toBe(1);
    expect(result.queuedState).toHaveLength(1);
    expect(result.queuedState[0].bubbleContent).toBe(
      'Keep this file with my text',
    );
    expect(result.queuedState[0].content).toContain(
      'Keep this file with my text',
    );
    expect(result.queuedState[0].content).toContain(
      '/workspace/group/uploads/package.json',
    );
    expect(result.queuedState[0].attachments).toEqual([
      expect.objectContaining({
        filename: 'package.json',
        path: '/workspace/group/uploads/package.json',
      }),
    ]);
    expect(result.queuedState[0].memoryContextLevel).toBe('deep');
    expect(result.queuedState[0].deepLinks).toEqual([
      { label: 'Task details', href: '/tasks/task-context' },
    ]);
    expect(result.messageBodies).toHaveLength(1);
    expect(result.messageBodies[0].content).toContain(
      'Keep this file with my text',
    );
    expect(result.messageBodies[0].content).toContain(
      '/workspace/group/uploads/package.json',
    );
    expect(result.messageBodies[0].attachments).toEqual(
      result.queuedState[0].attachments,
    );
    expect(result.messageBodies[0].memoryContext).toEqual({ level: 'deep' });
    expect(result.messageBodies[0].deepLinks).toEqual(
      result.queuedState[0].deepLinks,
    );
    expect(result.renderedText).toContain('Keep this file with my text');
    expect(result.renderedText).toContain('package.json');
    expect(result.renderedAttachmentLinks).toBe(1);
    expect(result.composerDraft).toBe('A newer draft');
    expect(result.composerContext).toEqual({
      memoryContextLevel: 'off',
      deepLinks: [],
    });
  }, 20_000);

  it('keeps a consumed queued prompt between consecutive live assistant turns', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));

        const secondStreamKey = 'queued-follow-up-stream';
        let transcriptEntries = [
          { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', created_at: '2026-01-01T00:00:00.000Z', source: 'web' },
          { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', created_at: '2026-01-01T00:00:01.000Z', source: 'web' },
        ];
        const completionTranscriptGate = Promise.withResolvers();
        const completionTranscriptRequestGate = Promise.withResolvers();
        const drainAcknowledgementGate = Promise.withResolvers();
        let holdCompletionTranscript = true;
        await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript*', async route => {
          const body = JSON.stringify({ entries: transcriptEntries, hasMore: false, nextOffset: null });
          if (holdCompletionTranscript) {
            holdCompletionTranscript = false;
            completionTranscriptRequestGate.resolve();
            await completionTranscriptGate.promise;
          }
          await route.fulfill({ contentType: 'application/json', body });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', async route => {
          await completionTranscriptRequestGate.promise;
          const request = route.request().postDataJSON();
          const userMessage = {
            id: request.clientSubmissionId,
            clientSubmissionIds: request.clientSubmissionIds,
            conversation_id: 'handoff-browser-conversation',
            role: 'user',
            content: request.content,
            created_at: '2026-01-01T00:00:02.000Z',
            source: 'web',
          };
          transcriptEntries = [...transcriptEntries, { ...userMessage, type: 'message' }];
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', userMessage }),
          });
          await page.waitForFunction(id => document.querySelector('[data-ui="chat-current-user-message"][data-message-id="' + id + '"]'), request.clientSubmissionId);
          await page.evaluate(message => window.chatPageHandoffHarness.dispatch('chat_message', {
            folder: 'handoff-browser-project',
            message,
          }), userMessage);
          drainAcknowledgementGate.resolve();
        });

        await page.locator('textarea[placeholder="Message…"]').fill('Queued follow-up');
        await page.locator('[data-ui="chat-send-message"]').click();
        await page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Queued follow-up' }).waitFor();
        const queuedPromptId = await page.locator('[data-ui="chat-steering-queued-prompt"]').getAttribute('data-queued-prompt-id');
        if (!queuedPromptId) throw new Error('queued prompt is missing its stable id');
        const stablePromptId = queuedPromptId;
        const queuedControls = await page.locator('[data-ui="chat-steering-queued-prompt"] button').evaluateAll(buttons => buttons.map(button => button.getAttribute('title')));
        const ownershipFrames = [];
        const sample = async label => page.evaluate(([label, id]) => {
          const queued = document.querySelectorAll('[data-ui="chat-steering-queued-prompt"][data-queued-prompt-id="' + id + '"]').length;
          const sent = document.querySelectorAll('[data-ui="chat-current-user-message"][data-message-id="' + id + '"]').length;
          return { label, queued, sent, total: queued + sent };
        }, [label, stablePromptId]);
        ownershipFrames.push(await sample('queued'));
        await page.evaluate(([id]) => {
          window.__queuedPromptOwnershipFrames = [];
          const record = () => {
            const queued = document.querySelectorAll('[data-ui="chat-steering-queued-prompt"][data-queued-prompt-id="' + id + '"]').length;
            const sent = document.querySelectorAll('[data-ui="chat-current-user-message"][data-message-id="' + id + '"]').length;
            window.__queuedPromptOwnershipFrames.push({ label: 'mutation', queued, sent, total: queued + sent });
          };
          record();
          window.__queuedPromptOwnershipObserver = new MutationObserver(record);
          window.__queuedPromptOwnershipObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true });
        }, [stablePromptId]);

        const drainResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages') && response.status() === 200);
        const drainFinished = page.waitForEvent('requestfinished', {
          predicate: request => request.url().endsWith('/api/projects/handoff-browser-project/messages'),
        });
        await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_completed', {
          folder: 'handoff-browser-project',
          project_id: 'handoff-browser-project',
          conversation_id: 'handoff-browser-conversation',
          streamKey: 'handoff-browser-stream',
        }));
        await drainResponse;
        await drainFinished;
        await drainAcknowledgementGate.promise;
        ownershipFrames.push(await sample('acknowledged'));
        const completionTranscriptResponse = page.waitForResponse(response => response.url().includes('/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        completionTranscriptGate.resolve();
        await completionTranscriptResponse;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        ownershipFrames.push(await sample('stale-completion-refetch'));
        const staleCompletionTranscriptIds = await page.evaluate(() => window.chatPageHandoffHarness.transcriptEntries().map(entry => entry.id));

        await page.evaluate(([streamKey]) => window.chatPageHandoffHarness.dispatch('chat_started', {
          folder: 'handoff-browser-project',
          conversation_id: 'handoff-browser-conversation',
          streamKey,
        }), [secondStreamKey]);
        ownershipFrames.push(await sample('second-started'));
        await page.evaluate(([streamKey]) => window.chatPageHandoffHarness.dispatch('chat_output', {
          folder: 'handoff-browser-project',
          conversation_id: 'handoff-browser-conversation',
          streamKey,
          content: 'Second response',
        }), [secondStreamKey]);
        ownershipFrames.push(await sample('second-output'));

        const liveOrder = await page.locator('[data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-current-user-message"], [data-ui="chat-generic-main-stream"]').evaluateAll(nodes => nodes.map(node => ({
          ui: node.getAttribute('data-ui'),
          id: node.getAttribute('data-message-id'),
          text: node.textContent || '',
        })));

        const assistantMessage = {
          id: 'main-2',
          conversation_id: 'handoff-browser-conversation',
          role: 'assistant',
          content: 'Second response',
          created_at: '2026-01-01T00:00:03.000Z',
          source: 'web',
        };
        transcriptEntries = [...transcriptEntries, { ...assistantMessage, type: 'message' }];
        await page.evaluate(([streamKey, message]) => window.chatPageHandoffHarness.dispatch('chat_message', {
          folder: 'handoff-browser-project',
          streamKey,
          message,
        }), [secondStreamKey, assistantMessage]);
        await page.evaluate(([streamKey]) => window.chatPageHandoffHarness.dispatch('chat_completed', {
          folder: 'handoff-browser-project',
          project_id: 'handoff-browser-project',
          conversation_id: 'handoff-browser-conversation',
          streamKey,
        }), [secondStreamKey]);
        await page.waitForFunction(() => document.querySelectorAll('[data-ui="chat-canonical-main-transcript-message"]').length === 2);

        const mutationFrames = await page.evaluate(() => {
          window.__queuedPromptOwnershipObserver.disconnect();
          return window.__queuedPromptOwnershipFrames;
        });
        const settledOrder = await page.locator('[data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-current-user-message"]').evaluateAll(nodes => nodes.map(node => ({
          ui: node.getAttribute('data-ui'),
          id: node.getAttribute('data-message-id'),
          text: node.textContent || '',
        })));

        return { stablePromptId, queuedControls, ownershipFrames: [...ownershipFrames, ...mutationFrames], staleCompletionTranscriptIds, liveOrder, settledOrder };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.stablePromptId).toBeTruthy();
    expect(result.queuedControls).toEqual([
      'Use this queued prompt to steer the running turn',
      'Edit this queued prompt',
      'Delete queued prompt',
    ]);
    for (const frame of result.ownershipFrames) {
      expect(frame.total, frame.label).toBe(1);
    }
    expect(
      result.ownershipFrames.find((frame) => frame.label === 'queued'),
    ).toMatchObject({ queued: 1, sent: 0 });
    for (const label of [
      'acknowledged',
      'stale-completion-refetch',
      'second-started',
      'second-output',
    ]) {
      expect(
        result.ownershipFrames.find((frame) => frame.label === label),
        label,
      ).toMatchObject({ queued: 0, sent: 1 });
    }
    expect(result.staleCompletionTranscriptIds).toEqual([
      'prompt-1',
      'main-1',
      result.stablePromptId,
    ]);
    expect(result.liveOrder.map((item) => item.id)).toEqual([
      'prompt-1',
      'main-1',
      result.stablePromptId,
      'queued-follow-up-stream',
    ]);
    expect(result.liveOrder[1].text).toContain('Main response');
    expect(result.liveOrder[2].text).toContain('Queued follow-up');
    expect(result.liveOrder[3].text).toContain('Second response');
    expect(result.settledOrder.map((item) => item.id)).toEqual([
      'prompt-1',
      'main-1',
      result.stablePromptId,
      'main-2',
    ]);
  }, 20_000);

  it('restores a mixed submission when its upload fails', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        let messageRequests = 0;
        const uploadGate = Promise.withResolvers();
        const uploadRequestGate = Promise.withResolvers();
        await page.route('**/api/projects/handoff-browser-project/upload', async route => {
          uploadRequestGate.resolve();
          await uploadGate.promise;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Upload unavailable' }),
          });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', route => {
          messageRequests += 1;
          return route.abort();
        });

        const uploadResponse = page.waitForResponse(response =>
          response.url().endsWith('/api/projects/handoff-browser-project/upload'),
        );
        await page.evaluate(() => window.chatPageHandoffHarness.setComposerContext(
          'deep',
          [{ label: 'Task details', href: '/tasks/task-context' }],
        ));
        await page.locator('input[type="file"][multiple]').setInputFiles('${packageJsonPath}');
        await page.locator('textarea[placeholder="Message…"]').fill('Do not drop this file');
        await page.locator('[data-ui="chat-send-message"]').click();
        await uploadRequestGate.promise;
        await page.locator('textarea[placeholder="Message…"]').fill('A newer draft');
        uploadGate.resolve();
        await uploadResponse;
        await page.waitForFunction(() =>
          document.querySelector('textarea[placeholder="Message…"]')?.value ===
          'Do not drop this file\\n\\nA newer draft',
        );

        const result = {
          draft: await page.locator('textarea[placeholder="Message…"]').inputValue(),
          attachmentChips: await page.getByText('package.json', { exact: true }).count(),
          queuedPrompts: await page.locator('[data-ui="chat-steering-queued-prompt"]').count(),
          messageRequests,
          composerContext: await page.evaluate(() =>
            window.chatPageHandoffHarness.getComposerContext(),
          ),
        };
        await page.unroute('**/api/projects/handoff-browser-project/upload');
        await page.unroute('**/api/projects/handoff-browser-project/messages');
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result).toEqual({
      draft: 'Do not drop this file\n\nA newer draft',
      attachmentChips: 1,
      queuedPrompts: 0,
      messageRequests: 0,
      composerContext: {
        memoryContextLevel: 'deep',
        deepLinks: [{ label: 'Task details', href: '/tasks/task-context' }],
      },
    });
  }, 20_000);

  it('queues an ordinary active-stream follow-up, then steers it with one DOM owner', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        let acknowledge;
        const requestSeen = Promise.withResolvers();
        const requestBodies = [];
        await page.route('**/api/projects/handoff-browser-project/messages', async route => {
          const requestBody = route.request().postDataJSON();
          requestBodies.push(requestBody);
          requestSeen.resolve();
          await new Promise(resolve => { acknowledge = resolve; });
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            conversation_id: 'handoff-browser-conversation',
            delivery: 'steered',
            userMessage: { id: requestBody.clientSubmissionId, role: 'user', content: 'Adjust this now' },
            steeringBoundary: { streamKey: 'handoff-browser-stream', contentOffset: 13 },
          }) });
        });
        await page.locator('textarea[placeholder="Message…"]').fill('Adjust this now');
        await page.locator('[data-ui="chat-send-message"]').click();
        const queued = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Adjust this now' });
        await queued.waitFor({ timeout: 5_000 }).catch(async () => {
          throw new Error(await page.evaluate(() => document.body.innerText));
        });
        await queued.getByTitle('Use this queued prompt to steer the running turn').click();
        await requestSeen.promise;
        const requestBody = requestBodies[0];
        if (!requestBody || !acknowledge) throw new Error('steering request was not intercepted');
        const pending = page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]');
        await pending.waitFor();
        const promptOwnersBeforeAck = await page.locator('[data-message-id]').evaluateAll(nodes =>
          nodes.filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Adjust this now')).length,
        );
        const queuedBeforeAck = await page.locator('[data-ui="chat-steering-queued-prompt"]').count();
        const transcriptRoute = '**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript*';
        let transcriptPhase = 'steering-user';
        await page.route(transcriptRoute, async route => {
          const entries = transcriptPhase === 'steering-user'
            ? [
                { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' },
                { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', source: 'web' },
                { id: requestBodies[0]?.clientSubmissionId, type: 'message', role: 'user', content: 'Adjust this now', source: 'web', steeringDelivery: 'steered' },
              ]
            : [
                { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' },
                { id: 'main-1:before:' + requestBodies[0]?.clientSubmissionId, type: 'message', role: 'assistant', content: 'Main response', source: 'web' },
                { id: requestBodies[0]?.clientSubmissionId, type: 'message', role: 'user', content: 'Adjust this now', source: 'web', steeringDelivery: 'steered' },
                { id: 'main-1:after', type: 'message', role: 'assistant', content: ' AFTER', source: 'web' },
              ];
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries, hasMore: false, nextOffset: null }) });
        });
        const steeredResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages') && response.status() === 200);
        acknowledge();
        await steeredResponse;
        const applied = page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]');
        await applied.waitFor();
        const appliedText = await applied.textContent();
        const canonicalUserResponse = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        await page.evaluate(id => window.chatPageHandoffHarness.dispatch('chat_message', {
          folder: 'handoff-browser-project',
          message: { id, conversation_id: 'handoff-browser-conversation', role: 'user', content: 'Adjust this now', source: 'web', steeringDelivery: 'steered' },
        }), requestBody.clientSubmissionId);
        await canonicalUserResponse;
        await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_output', {
          conversation_id: 'handoff-browser-conversation',
          streamKey: 'handoff-browser-stream',
          content: ' AFTER',
        }));
        await page.locator('[data-ui="chat-generic-main-stream"]').filter({ hasText: 'AFTER' }).waitFor();
        const localSteeringOwnersBeforeCompletion = await page.locator('[data-ui="chat-steering-message"]').count();
        const preCompletionOwnership = await page.locator('[data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-generic-main-stream"], [data-ui="chat-steering-message"]').evaluateAll(nodes => nodes.map(node => node.textContent || ''));
        transcriptPhase = 'canonical';
        const canonicalResponse = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_completed', {
          folder: 'handoff-browser-project',
          conversation_id: 'handoff-browser-conversation',
          streamKey: 'handoff-browser-stream',
        }));
        await canonicalResponse;
        await page.waitForFunction(() => window.chatPageHandoffHarness.transcriptEntries().some(entry => entry.role === 'assistant' && entry.content === ' AFTER'));
        const localSteeringOwners = await page.locator('[data-ui="chat-steering-message"]').count();
        const authoritativeEntries = await page.evaluate(() => window.chatPageHandoffHarness.transcriptEntries());
        const visibleOrder = await page.locator('[data-message-id]').evaluateAll(nodes => nodes
          .filter(node => node.getAttribute('data-ui') !== 'chat-message-content')
          .map(node => (node.textContent || '').trim())
          .filter(text => text.includes('Main response') || text.includes('Adjust this now') || text.includes('AFTER')));
        return { requestBodies, promptOwnersBeforeAck, queuedBeforeAck, appliedText, localSteeringOwnersBeforeCompletion, preCompletionOwnership, localSteeringOwners, authoritativeEntries, visibleOrder };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.requestBodies).toHaveLength(1);
    expect(result.requestBodies[0].delivery).toBe('steer');
    expect(result.requestBodies[0].clientSubmissionId).toBeTruthy();
    expect(result.promptOwnersBeforeAck).toBe(1);
    expect(result.queuedBeforeAck).toBe(0);
    expect(result.appliedText).toContain('Applied to current turn');
    expect(result.localSteeringOwnersBeforeCompletion).toBe(1);
    expect(result.preCompletionOwnership).toHaveLength(3);
    expect(result.preCompletionOwnership[0]).toContain('Main response');
    expect(result.preCompletionOwnership[1]).toContain('Adjust this now');
    expect(result.preCompletionOwnership[2]).toContain('AFTER');
    expect(result.localSteeringOwners).toBe(0);
    expect(result.authoritativeEntries.map((entry) => entry.content)).toEqual([
      'Ask everyone',
      'Main response',
      'Adjust this now',
      ' AFTER',
    ]);
    expect(result.visibleOrder).toEqual([
      expect.stringContaining('Main response'),
      expect.stringContaining('Adjust this now'),
      expect.stringContaining('AFTER'),
    ]);
  }, 20_000);

  it('splits a selected main persona response around steering with Live Mode off', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.unroute('**/api/projects/handoff-browser-project/messages');
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { configuredMainPersona: true, liveMode: false }); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        await page.waitForFunction(() => Boolean(window.chatPageHandoffHarness));
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
        const mainMessage = { id: 'main-current', role: 'assistant', content: '', senderUserId: 'ai:main', sender_name: 'Main persona', source: 'web', conversation_id: base.conversation_id, created_at: '2026-01-01T00:00:03.000Z' };
        await page.evaluate(([base, message]) => window.chatPageHandoffHarness.dispatch('chat_persona_started', { ...base, message }), [base, mainMessage]);
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_output', { ...base, messageId: 'main-current', content: 'First half', senderUserId: 'ai:main' }), base);
        await page.route('**/api/projects/handoff-browser-project/messages', async route => {
          const requestBody = route.request().postDataJSON();
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: base.conversation_id, delivery: 'steered', userMessage: { id: requestBody.clientSubmissionId, role: 'user', content: 'Change direction' }, steeringBoundary: { streamKey: 'handoff-browser-stream', targetMessageId: 'main-current', contentOffset: 10 } }) });
        });
        await page.locator('textarea[placeholder="Message…"]').fill('Change direction');
        await page.locator('[data-ui="chat-send-message"]').click();
        const queued = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Change direction' });
        await queued.waitFor();
        await queued.getByTitle('Use this queued prompt to steer the running turn').click();
        await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]').waitFor();
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_output', { ...base, messageId: 'main-current', content: ' Second half', senderUserId: 'ai:main' }), base);
                return await page.locator('[data-message-id]').evaluateAll(nodes => nodes.filter(node => node.getAttribute('data-ui') !== 'chat-message-content').map(node => ({ text: node.textContent || '' })).filter(item => item.text.includes('First half') || item.text.includes('Change direction') || item.text.includes('Second half')));
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.map((item: { text: string }) => item.text)).toEqual([
      expect.stringContaining('First half'),
      expect.stringContaining('Change direction'),
      expect.stringContaining('Second half'),
    ]);
  }, 20_000);

  it('returns rejected steering to the editable queue without a footer bubble', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.route('**/api/projects/handoff-browser-project/messages', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          conversation_id: 'handoff-browser-conversation',
          delivery: 'queued',
          queueOwner: 'browser',
        }) }));
        await page.locator('textarea[placeholder="Message…"]').fill('Keep this queued');
        await page.locator('[data-ui="chat-send-message"]').click();
        const queued = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Keep this queued' });
        await queued.waitFor();
        await queued.getByTitle('Use this queued prompt to steer the running turn').click();
        await queued.waitFor();
        const result = {
          queuedOwners: await queued.count(),
          steerButtons: await queued.getByTitle('Use this queued prompt to steer the running turn').count(),
          editButtons: await queued.getByTitle('Edit this queued prompt').count(),
          localSteeringOwners: await page.locator('[data-ui="chat-steering-message"]').count(),
          queuedFooterOwners: await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="queued"]').count(),
        };
        await page.unroute('**/api/projects/handoff-browser-project/messages');
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result).toEqual({
      queuedOwners: 1,
      steerButtons: 1,
      editButtons: 1,
      localSteeringOwners: 0,
      queuedFooterOwners: 0,
    });
  }, 20_000);

  it('keeps exactly one real DOM owner through handoff and completion', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
      const states = [];
      const sample = async label => states.push({ label, generic: await page.locator('[data-ui="chat-generic-main-stream"]').count(), canonical: await page.locator('[data-ui="chat-canonical-main-transcript-message"]').count(), streamingPersonas: await page.locator('[data-ui="chat-invited-persona-stream"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sender-user-id'))), canonicalPersonas: await page.locator('[data-ui="chat-canonical-persona-transcript-message"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sender-user-id'))), order: await page.locator('[data-ui="chat-generic-main-stream"], [data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-ui'))) });
      const dispatch = async (type, payload) => { await page.evaluate(([type, payload]) => window.chatPageHandoffHarness.dispatch(type, payload), [type, payload]); await sample(type); };
      await sample('initial');
      await dispatch('chat_message', { folder: base.folder, message: { id: 'main-1', conversation_id: base.conversation_id, role: 'assistant', content: 'Main response' } });
      await dispatch('chat_persona_started', { ...base, message: { id: 'persona-1', role: 'assistant', senderUserId: 'ai:persona-1', sender_name: 'Persona One' } });
      await dispatch('chat_persona_output', { ...base, messageId: 'persona-1', content: 'Persona reply', senderUserId: 'ai:persona-1' });
      await dispatch('chat_persona_finished', { ...base, messageId: 'persona-1' });
      await dispatch('chat_persona_started', { ...base, message: { id: 'persona-2', role: 'assistant', senderUserId: 'ai:persona-2', sender_name: 'Persona Two' } });
      await dispatch('chat_persona_output', { ...base, messageId: 'persona-2', content: 'Second reply', senderUserId: 'ai:persona-2' });
      await dispatch('chat_persona_finished', { ...base, messageId: 'persona-2' });
      await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' }])); await sample('stale-transcript');
      await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' }, { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', source: 'web' }])); await sample('restored-transcript');
      const frames = await page.evaluate(async base => { const frame = () => ({ generic: document.querySelectorAll('[data-ui="chat-generic-main-stream"]').length, canonical: document.querySelectorAll('[data-ui="chat-canonical-main-transcript-message"]').length }); const samples = [frame()]; const observer = new MutationObserver(() => samples.push(frame())); observer.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true }); await window.chatPageHandoffHarness.dispatch('chat_completed', { ...base, streamKey: 'handoff-browser-stream' }); await window.chatPageHandoffHarness.dispatch('chat_message', { ...base, message: { id: 'main-1', role: 'assistant', content: 'Main response', source: 'web' } }); await window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' }, { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', source: 'web' }]); observer.disconnect(); return samples; }, base);
            await sample('chat_completed');
      return { states, frames };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    for (const state of result.states)
      expect(state.generic + state.canonical, state.label).toBe(1);
    for (const state of result.states) {
      const mainIndex = state.order.findIndex((ui: string) =>
        [
          'chat-generic-main-stream',
          'chat-canonical-main-transcript-message',
        ].includes(ui),
      );
      const personaIndex = state.order.findIndex((ui: string) =>
        [
          'chat-invited-persona-stream',
          'chat-canonical-persona-transcript-message',
        ].includes(ui),
      );
      if (mainIndex >= 0 && personaIndex >= 0) {
        expect(mainIndex, state.label).toBeLessThan(personaIndex);
      }
    }
    expect(
      result.states.find((state) => state.label === 'chat_persona_output')
        .streamingPersonas,
    ).toContain('ai:persona-1');
    expect(
      result.states.find((state) => state.label === 'chat_persona_finished')
        .canonicalPersonas,
    ).toContain('ai:persona-1');
    expect(
      result.states
        .filter((state) => state.label === 'chat_persona_output')
        .at(-1).streamingPersonas,
    ).toContain('ai:persona-2');
    expect(result.frames.length).toBeGreaterThan(1);
    for (const frame of result.frames)
      expect(frame.generic + frame.canonical).toBe(1);
    expect(result.frames.some((frame) => frame.generic === 1)).toBe(true);
    expect(result.frames.at(-1).canonical).toBe(1);
  }, 20_000);

  it('keeps the same response DOM owner when an ordinary stream is stopped', async () => {
    await cliFor(stopSession, 'open', harnessUrl);
    const output = await cliFor(
      stopSession,
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.route('**/api/projects/handoff-browser-project/messages/stop', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, stopped: true }) }));
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        const stream = page.locator('[data-ui="chat-generic-main-stream"]');
        await stream.waitFor();
        await page.evaluate(() => {
          window.__stoppedResponseOwner = document.querySelector('[data-ui="chat-generic-main-stream"]');
          window.__stopOwnerFrames = [];
          window.__sampleStopOwner = phase => {
            const current = document.querySelector('[data-ui="chat-generic-main-stream"]');
            window.__stopOwnerFrames.push({
              phase,
              generic: document.querySelectorAll('[data-ui="chat-generic-main-stream"]').length,
              canonical: document.querySelectorAll('[data-ui="chat-canonical-main-transcript-message"]').length,
              sameNode: current === window.__stoppedResponseOwner,
              initialConnected: window.__stoppedResponseOwner?.isConnected ?? false,
              messageId: current?.getAttribute('data-message-id') ?? null,
              streamKey: current?.getAttribute('data-stream-key') ?? null,
              parentUi: current?.parentElement?.getAttribute('data-ui') ?? null,
            });
          };
          window.__sampleStopOwner('initial');
          window.__stopOwnerObserver = new MutationObserver(() => window.__sampleStopOwner('mutation'));
          window.__stopOwnerObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true });
        });
        const stopResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages/stop') && response.status() === 200);
        await page.getByRole('button', { name: 'Stop' }).click();
        await stopResponse;
        await page.evaluate(() => window.__sampleStopOwner('stop-response'));
        await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_completed', {
          folder: 'handoff-browser-project',
          conversation_id: 'handoff-browser-conversation',
          streamKey: 'handoff-browser-stream',
          liveState: 'needs_input',
          completionSummary: 'Stopped by user.',
        }));
        await page.evaluate(() => window.__sampleStopOwner('chat-completed'));
        return await page.evaluate(() => {
          window.__stopOwnerObserver.disconnect();
          const current = document.querySelector('[data-ui="chat-generic-main-stream"]');
          return {
            sameNode: current === window.__stoppedResponseOwner,
            text: current?.textContent ?? '',
            frames: window.__stopOwnerFrames,
          };
        });
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.sameNode, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.text).toContain('Main response');
    for (const frame of result.frames) {
      expect(frame.generic, JSON.stringify(result, null, 2)).toBe(1);
      expect(frame.canonical, JSON.stringify(result, null, 2)).toBe(0);
    }
  }, 20_000);

  it('does not render an unrelated previous stream beneath a canonical persona reply', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
      await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
        { id: 'prompt-1', type: 'message', role: 'user', content: 'Current prompt', source: 'web' },
        { id: 'main-1', type: 'message', role: 'assistant', content: 'Current main response', source: 'web' },
      ]));
      await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_started', { ...base, streamKey: 'persona-phase-stream', personaDriven: true, canonicalPersonaTurns: false, virtualSender: null }), base);
      await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_started', { ...base, message: { id: 'persona-current', role: 'assistant', senderUserId: 'ai:persona-current', sender_name: 'Morgan' } }), base);
      await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_output', { ...base, messageId: 'persona-current', content: 'Current Morgan response', senderUserId: 'ai:persona-current' }), base);
      await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_finished', { ...base, messageId: 'persona-current', message: { id: 'persona-current', type: 'message', role: 'assistant', content: 'Current Morgan response', senderUserId: 'ai:persona-current', sender_name: 'Morgan' } }), base);
            return {
        genericText: await page.locator('[data-ui="chat-generic-main-stream"]').allTextContents(),
        order: await page.locator('[data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-canonical-persona-transcript-message"], [data-ui="chat-generic-main-stream"]').evaluateAll(nodes => nodes.map(node => ({ ui: node.getAttribute('data-ui'), text: node.textContent || '' }))),
      };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.genericText.join('\n')).not.toContain('Main response');
    const mainIndex = result.order.findIndex(
      (item: { ui: string }) =>
        item.ui === 'chat-canonical-main-transcript-message' ||
        item.ui === 'chat-generic-main-stream',
    );
    const personaIndex = result.order.findIndex(
      (item: { ui: string }) =>
        item.ui === 'chat-canonical-persona-transcript-message',
    );
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(mainIndex).toBeLessThan(personaIndex);
  }, 20_000);

  it('keeps a configured main persona between before and after speakers while streaming', async () => {
    await configuredCli('open', harnessUrl);
    let output: string;
    try {
      output = await configuredCli(
        'run-code',
        `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { configuredMainPersona: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
        await page.waitForFunction(() => Boolean(window.chatPageHandoffHarness));
        const states = [];
        const sample = async label => states.push({ label, bubbles: await page.locator('[data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"], [data-ui="chat-generic-main-stream"]').evaluateAll(nodes => nodes.map(node => ({ ui: node.getAttribute('data-ui'), sender: node.getAttribute('data-sender-user-id'), id: node.getAttribute('data-message-id'), project: node.getAttribute('data-project-id'), conversation: node.getAttribute('data-conversation-id'), stream: node.getAttribute('data-stream-key') }))) });
        const dispatch = async (type, payload) => { await page.evaluate(([type, payload]) => window.chatPageHandoffHarness.dispatch(type, payload), [type, payload]); await sample(type); };
        await sample('initial');
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
        await dispatch('chat_persona_started', { ...base, message: { id: 'after-1', role: 'assistant', senderUserId: 'ai:after', sender_name: 'After persona' } });
        await dispatch('chat_persona_output', { ...base, messageId: 'after-1', content: 'After response', senderUserId: 'ai:after' });
        await dispatch('chat_persona_finished', { ...base, messageId: 'after-1' });
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
          { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' },
          { id: 'before-1', type: 'message', role: 'assistant', content: 'Before response', senderUserId: 'ai:before', sender_name: 'Before persona', conversation_id: 'handoff-browser-conversation', source: 'web' },
          { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', senderUserId: 'ai:main', sender_name: 'Main persona', conversation_id: 'handoff-browser-conversation', source: 'web' },
          { id: 'after-1', type: 'message', role: 'assistant', content: 'After response', senderUserId: 'ai:after', sender_name: 'After persona', conversation_id: 'handoff-browser-conversation', source: 'web' },
        ]));
        await page.waitForFunction(() => { const ids = Array.from(document.querySelectorAll('[data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"], [data-ui="chat-generic-main-stream"]')).map(node => node.getAttribute('data-sender-user-id')); return ids.length === 3 && ids[0] === 'ai:before' && ids[1] === 'ai:main' && ids[2] === 'ai:after'; });
        await sample('authoritative-transcript');
        return states;
      }`,
      );
    } finally {
      if (ownsBrowserSessions) await configuredCli('close');
    }
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result[0].bubbles.map((bubble) => bubble.sender)).toEqual([
      'ai:before',
      'ai:main',
    ]);
    for (const state of result.slice(1)) {
      expect(
        state.bubbles.map((bubble) => bubble.sender),
        state.label,
      ).toEqual(['ai:before', 'ai:main', 'ai:after']);
      expect(
        state.bubbles.filter(
          (bubble) =>
            bubble.project !== 'handoff-browser-project' ||
            bubble.conversation !== 'handoff-browser-conversation',
        ),
      ).toEqual([]);
      expect(
        state.bubbles
          .filter((bubble) => bubble.ui === 'chat-generic-main-stream')
          .every((bubble) => bubble.stream === 'handoff-browser-stream'),
      ).toBe(true);
      if (state.label === 'chat_persona_output') {
        expect(
          state.bubbles
            .filter((bubble) => bubble.ui === 'chat-invited-persona-stream')
            .every((bubble) => bubble.stream === 'handoff-browser-stream'),
        ).toBe(true);
      }
    }
  }, 20_000);

  it('keeps an ordinary live main response before a persona row that arrives later', async () => {
    await configuredCli('open', harnessUrl);
    let output: string;
    try {
      output = await configuredCli(
        'run-code',
        `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
          await page.setContent('<div id="root"></div>');
          await page.evaluate(() => new Promise((resolve, reject) => {
            delete window.chatPageHandoffHarness;
            const script = document.createElement('script');
            script.type = 'module';
            script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
            script.onerror = reject;
            window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
            document.head.append(script);
          }));
          await page.waitForFunction(() => Boolean(window.chatPageHandoffHarness));
          await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
            { id: 'prompt-1', type: 'message', role: 'user', content: 'Earlier prompt', source: 'web' },
            { id: 'main-1', type: 'message', role: 'assistant', content: 'Earlier response', source: 'web' },
            { id: 'prompt-2', type: 'message', role: 'user', content: 'Current prompt', source: 'web' },
          ]));
          await page.evaluate(() => window.chatPageHandoffHarness.startOrdinaryFollowUp(false));
          const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
          await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_started', { ...base, message: { id: 'morgan-current', role: 'assistant', senderUserId: 'ai:after', sender_name: 'Morgan' } }), base);
          await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_persona_output', { ...base, messageId: 'morgan-current', content: 'Morgan after response', senderUserId: 'ai:after' }), base);
                    return await page.locator('[data-ui="chat-generic-main-stream"], [data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"]').evaluateAll(nodes => nodes.map(node => ({
            ui: node.getAttribute('data-ui'),
            id: node.getAttribute('data-message-id'),
            text: node.textContent || '',
          })));
        }`,
      );
    } finally {
      if (ownsBrowserSessions) await configuredCli('close');
    }
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    const mainIndex = result.findIndex(
      (item: { ui: string; text: string }) =>
        item.ui === 'chat-generic-main-stream' &&
        item.text.includes('Ordinary follow-up response'),
    );
    const morganIndex = result.findIndex(
      (item: { id: string }) => item.id === 'morgan-current',
    );
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(morganIndex).toBeGreaterThan(mainIndex);
  }, 20_000);

  it('keeps repeated configured-main turns through stale transcript replacement', async () => {
    await configuredCli('open', harnessUrl);
    let output: string;
    try {
      output = await configuredCli(
        'run-code',
        `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { configuredMainPersona: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
        await page.waitForFunction(() => Boolean(window.chatPageHandoffHarness));
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
        const entries = [
          { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web', created_at: '2026-01-01T00:00:00.000Z' },
          { id: 'before-1', type: 'message', role: 'assistant', content: 'B', senderUserId: 'ai:before', sender_name: 'Before persona', source: 'web', created_at: '2026-01-01T00:00:01.000Z' },
        ];
        await page.evaluate(entries => window.chatPageHandoffHarness.replaceTranscriptEntries(entries), entries);
        const snapshots = [];
        const sample = async label => snapshots.push({ label, ids: await page.locator('[data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"], [data-ui="chat-generic-main-stream"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id'))) });
        const dispatch = async (type, payload) => { await page.evaluate(([type, payload]) => window.chatPageHandoffHarness.dispatch(type, payload), [type, payload]); await sample(type + ':' + payload.messageId); };
        await sample('B');
        const main = async (id, content, time, reverse) => {
          const message = { id, role: 'assistant', content, senderUserId: 'ai:main', sender_name: 'Main persona', source: 'web', conversation_id: base.conversation_id, created_at: time };
          await dispatch('chat_persona_started', { ...base, message });
          await dispatch('chat_persona_output', { ...base, messageId: id, content, senderUserId: 'ai:main' });
          if (reverse) await dispatch('chat_persona_finished', { ...base, messageId: id, message });
          else { await dispatch('chat_message', { ...base, message }); await dispatch('chat_persona_finished', { ...base, messageId: id, message }); }
        };
        const after = async (id, content, time) => {
          const message = { id, role: 'assistant', content, senderUserId: 'ai:after', sender_name: 'After persona', source: 'web', conversation_id: base.conversation_id, created_at: time };
          await dispatch('chat_persona_started', { ...base, message });
          await dispatch('chat_persona_output', { ...base, messageId: id, content, senderUserId: 'ai:after' });
          await dispatch('chat_persona_finished', { ...base, messageId: id, message });
        };
        await main('main-1', 'M1', '2026-01-01T00:00:02.000Z', false);
        await sample('after-M1');
        await after('after-1', 'A1', '2026-01-01T00:00:03.000Z');
        await main('main-2', 'M2', '2026-01-01T00:00:04.000Z', true);
        await dispatch('chat_message', { ...base, message: { id: 'main-2', role: 'assistant', content: 'M2', senderUserId: 'ai:main', sender_name: 'Main persona', source: 'web', conversation_id: base.conversation_id, created_at: '2026-01-01T00:00:04.000Z' } });
        const refetchSeen = Promise.withResolvers();
        const refetchRelease = Promise.withResolvers();
        await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript*', async route => {
          refetchSeen.resolve();
          await refetchRelease.promise;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              entries: [...entries, { id: 'main-1', type: 'message', role: 'assistant', content: 'M1', senderUserId: 'ai:main', source: 'web', created_at: '2026-01-01T00:00:02.000Z' }, { id: 'after-1', type: 'message', role: 'assistant', content: 'A1', senderUserId: 'ai:after', source: 'web', created_at: '2026-01-01T00:00:03.000Z' }],
              hasMore: false,
              nextOffset: null,
            }),
          });
        });
        await dispatch('chat_completed', { ...base, streamKey: 'handoff-browser-stream' });
        await refetchSeen.promise;
        await sample('stale-refetch-pending');
        if (!snapshots.at(-1).ids.includes('main-2')) throw new Error('stale refetch erased completed M2');
        const canonicalResponse = page.waitForResponse(response => response.url().includes('/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        refetchRelease.resolve();
        await canonicalResponse;
        await page.waitForFunction(() => Boolean(document.querySelector('[data-message-id="main-2"]')));
        await sample('authoritative');
        if (!snapshots.at(-1).ids.includes('main-2')) throw new Error('canonical reconciliation did not restore M2');
        await after('after-2', 'A2', '2026-01-01T00:00:05.000Z');
        const beforeStop = snapshots.at(-1).ids;
        await page.evaluate(() => window.chatPageHandoffHarness.stop());
                await sample('stop');
        if (JSON.stringify(snapshots.at(-1).ids) !== JSON.stringify(beforeStop)) throw new Error('Stop changed transcript ownership');
        return snapshots;
      }`,
      );
    } finally {
      if (ownsBrowserSessions) await configuredCli('close');
    }
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    const byLabel = (label: string) =>
      result.find((state: any) => state.label === label).ids;
    expect(byLabel('after-M1')).toEqual(['before-1', 'main-1']);
    expect(
      result.find((state: any) => state.label.endsWith(':after-1')).ids,
    ).toContain('main-1');
    expect(byLabel('authoritative')).toEqual([
      'before-1',
      'main-1',
      'after-1',
      'main-2',
    ]);
    expect(result.at(-1).ids).toEqual([
      'before-1',
      'main-1',
      'after-1',
      'main-2',
      'after-2',
    ]);
    const finalIds = result.at(-1).ids;
    for (const state of result) {
      expect(new Set(state.ids).size).toBe(state.ids.length);
      expect(state.ids).toEqual(finalIds.slice(0, state.ids.length));
    }
  }, 20_000);

  it('keeps Persona Live preparing owners and voice-paced rows for B, M, and A', async () => {
    await configuredCli('open', harnessUrl);
    let output: string;
    try {
      output = await configuredCli(
        'run-code',
        `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { configuredMainPersona: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
        await page.waitForFunction(() => Boolean(window.chatPageHandoffHarness));
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation' };
        const speechRequests = [];
        await page.route('**/api/**', route => {
          if (route.request().url().includes('/messages/') && route.request().url().endsWith('/speech')) {
            speechRequests.push(route.request().url());
            return route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/ogg', 'X-Audio-Duration': '1' }, body: 'harness-audio' });
          }
          return route.continue();
        });
        await page.evaluate(() => {
          const audioInstances = [];
          class HarnessAudio {
            currentTime = 0.5;
            duration = 1;
            readyState = 4;
            onended = null;
            onerror = null;
            constructor() { audioInstances.push(this); }
            addEventListener() {}
            load() {}
            pause() {}
            removeAttribute() {}
            play() { return Promise.resolve(); }
          }
          window.Audio = HarnessAudio;
          window.finishHarnessAudio = () => audioInstances.at(-1)?.onended?.();
        });
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web', created_at: '2026-01-01T00:00:00.000Z' }]));
        const snapshots = [];
        const sample = async label => snapshots.push({ label, speechRequests: [...speechRequests], bubbles: await page.locator('[data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"], [data-ui="chat-generic-main-stream"]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-message-id'), ui: node.getAttribute('data-ui'), sender: node.getAttribute('data-sender-user-id'), text: node.querySelector('[data-ui="chat-message-content"]')?.innerText ?? '', status: node.querySelector('[data-ui="chat-persona-voice-status"]')?.textContent ?? '' }))), speech: await page.evaluate(async () => (await import('/src/lib/use-tts.ts')).getLiveSpeechState()) });
        const dispatch = async (type, payload) => { await page.evaluate(([type, payload]) => window.chatPageHandoffHarness.dispatch(type, payload), [type, payload]); const id = payload.snapshot?.current?.messageId ?? payload.messageId ?? payload.message?.id ?? 'queue'; await sample(type === 'persona_live_queue' ? type + ':' + payload.snapshot.revision + ':' + id : type + ':' + id); };
        const metadata = (messageId, participantId, senderName, createdAt, state = 'ready') => ({ messageId, participantId, state, senderName, createdAt, emote: null, telemetry: null });
        const completedMetadata = (messageId, participantId, senderName, createdAt, text) => ({ messageId, participantId, senderName, createdAt, text, content: text, emote: null, telemetry: null });
        const current = (messageId, participantId, state, content, createdAt) => ({ id: 'queue-' + messageId, sequence: 1, participantId, messageId, state, durationMs: 1000, releasedAt: state === 'released' || state === 'playing' ? createdAt : null, startedAt: state === 'playing' ? createdAt : null, endsAt: null, error: null, text: content, content, senderName: participantId, createdAt, emote: null, telemetry: null });
        const queue = (revision, currentItem, hiddenItems, completedMessageIds = [], completedItems = []) => ({ protocolVersion: 2, conversationId: base.conversation_id, runId: 'live-run', epoch: 1, mode: 'personas', revision, status: 'active', serverNow: '2026-01-01T00:00:00.000Z', leaderSessionId: 'live-session', hiddenMessageIds: hiddenItems.map(item => item.messageId), hiddenItems, cancelledMessageIds: [], completedMessageIds, completedItems, current: currentItem });
        const beforeMessage = { id: 'before-1', role: 'assistant', content: 'B voice response', senderUserId: 'ai:before', sender_name: 'Before persona', conversation_id: base.conversation_id };
        await dispatch('chat_persona_started', { ...base, message: beforeMessage, liveModeSessionId: 'live-session', voiceDelayed: true, hiddenUntilPlayback: true });
        await dispatch('chat_persona_output', { ...base, messageId: 'before-1', content: 'B raw response', senderUserId: 'ai:before', liveModeSessionId: 'live-session', voiceDelayed: true });
        const earlyMainMessage = { id: 'main-1', role: 'assistant', content: '', senderUserId: 'ai:main', sender_name: 'Main persona', conversation_id: base.conversation_id };
        await dispatch('chat_persona_started', { ...base, message: earlyMainMessage, liveModeSessionId: 'live-session', voiceDelayed: true, hiddenUntilPlayback: true });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(1, current('before-1', 'before', 'generating', 'B raw response', '2026-01-01T00:00:01.000Z'), [metadata('main-1', 'main', 'Main persona', '2026-01-01T00:00:02.000Z')]) });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(2, current('before-1', 'before', 'playing', 'B voice response', '2026-01-01T00:00:01.000Z'), [metadata('main-1', 'main', 'Main persona', '2026-01-01T00:00:02.000Z')]) });
        await page.waitForFunction((messageId) => Boolean(document.querySelector('[data-message-id="' + messageId + '"] [data-ui="chat-message-content"]')?.textContent?.trim()), 'before-1');
        await sample('before-speaking');
        await page.evaluate(() => window.finishHarnessAudio());
        await dispatch('persona_live_queue', { ...base, snapshot: queue(3, current('main-1', 'main', 'generating', 'M raw response', '2026-01-01T00:00:02.000Z'), [], ['before-1']) });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(4, current('main-1', 'main', 'playing', 'M voice response', '2026-01-01T00:00:02.000Z'), [metadata('after-1', 'after', 'After persona', '2026-01-01T00:00:03.000Z')], ['before-1']) });
        await page.waitForFunction((messageId) => Boolean(document.querySelector('[data-message-id="' + messageId + '"] [data-ui="chat-message-content"]')?.textContent?.trim()), 'main-1');
        await sample('main-speaking');
        await page.evaluate(() => window.finishHarnessAudio());
        const afterMessage = { id: 'after-1', role: 'assistant', content: 'A voice response', senderUserId: 'ai:after', sender_name: 'After persona', conversation_id: base.conversation_id };
        await dispatch('chat_persona_started', { ...base, message: afterMessage });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(5, current('after-1', 'after', 'generating', 'A raw response', '2026-01-01T00:00:03.000Z'), [], ['before-1', 'main-1']) });
        await dispatch('chat_persona_output', { ...base, messageId: 'after-1', content: 'A raw response', senderUserId: 'ai:after', liveModeSessionId: 'live-session', voiceDelayed: true });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(6, current('after-1', 'after', 'playing', 'A voice response', '2026-01-01T00:00:03.000Z'), [], ['before-1', 'main-1']) });
        await page.waitForFunction((messageId) => Boolean(document.querySelector('[data-message-id="' + messageId + '"] [data-ui="chat-message-content"]')?.textContent?.trim()), 'after-1');
        await sample('after-speaking');
        await page.evaluate(() => window.finishHarnessAudio());
        await dispatch('persona_live_queue', { ...base, snapshot: queue(7, current('after-1', 'after', 'completed', 'A voice response', '2026-01-01T00:00:03.000Z'), [], ['before-1', 'main-1', 'after-1']) });
        await dispatch('chat_persona_finished', { ...base, messageId: 'after-1', message: afterMessage });
        const main2Message = { id: 'main-2', role: 'assistant', content: 'M2 voice response', senderUserId: 'ai:main', sender_name: 'Main persona', conversation_id: base.conversation_id };
        await dispatch('chat_persona_started', { ...base, message: main2Message });
        await dispatch('chat_persona_output', { ...base, messageId: 'main-2', content: 'M2 raw response', senderUserId: 'ai:main', liveModeSessionId: 'live-session', voiceDelayed: true });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(8, current('main-2', 'main', 'generating', 'M2 raw response', '2026-01-01T00:00:04.000Z'), [metadata('after-2', 'after', 'After persona', '2026-01-01T00:00:05.000Z')], ['before-1', 'main-1', 'after-1']) });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(9, current('main-2', 'main', 'playing', 'M2 voice response', '2026-01-01T00:00:04.000Z'), [metadata('after-2', 'after', 'After persona', '2026-01-01T00:00:05.000Z')], ['before-1', 'main-1', 'after-1']) });
        await page.waitForFunction((messageId) => Boolean(document.querySelector('[data-message-id="' + messageId + '"] [data-ui="chat-message-content"]')?.textContent?.trim()), 'main-2');
        await page.evaluate(() => window.finishHarnessAudio());
        await dispatch('chat_persona_finished', { ...base, messageId: 'main-2', message: main2Message });
        await dispatch('chat_message', { ...base, message: main2Message });
        const after2Message = { id: 'after-2', role: 'assistant', content: 'A2 voice response', senderUserId: 'ai:after', sender_name: 'After persona', conversation_id: base.conversation_id };
        await dispatch('chat_persona_started', { ...base, message: after2Message });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(10, current('after-2', 'after', 'generating', 'A2 raw response', '2026-01-01T00:00:05.000Z'), [], ['before-1', 'main-1', 'after-1', 'main-2']) });
        await dispatch('chat_persona_output', { ...base, messageId: 'after-2', content: 'A2 raw response', senderUserId: 'ai:after', liveModeSessionId: 'live-session', voiceDelayed: true });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(11, current('after-2', 'after', 'completed', '', '2026-01-01T00:00:05.000Z'), [], ['before-1', 'main-1', 'after-1', 'main-2', 'after-2'], [completedMetadata('after-2', 'after', 'After persona', '2026-01-01T00:00:05.000Z', 'A2 voice response')]) });
        await dispatch('chat_message', { ...base, message: after2Message });
        await dispatch('chat_persona_finished', { ...base, messageId: 'after-2', message: after2Message });
        await dispatch('persona_live_queue', { ...base, snapshot: queue(12, current('after-2', 'after', 'completed', 'A2 voice response', '2026-01-01T00:00:05.000Z'), [], ['before-1', 'main-1', 'after-1', 'main-2', 'after-2']) });
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
          { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web', created_at: '2026-01-01T00:00:00.000Z' },
          { id: 'before-1', type: 'message', role: 'assistant', content: 'B voice response', senderUserId: 'ai:before', source: 'web', created_at: '2026-01-01T00:00:01.000Z' },
          { id: 'main-1', type: 'message', role: 'assistant', content: 'M voice response', senderUserId: 'ai:main', source: 'web', created_at: '2026-01-01T00:00:02.000Z' },
          { id: 'after-1', type: 'message', role: 'assistant', content: 'A voice response', senderUserId: 'ai:after', source: 'web', created_at: '2026-01-01T00:00:03.000Z' },
          { id: 'main-2', type: 'message', role: 'assistant', content: 'M2 voice response', senderUserId: 'ai:main', source: 'web', created_at: '2026-01-01T00:00:04.000Z' },
          { id: 'after-2', type: 'message', role: 'assistant', content: 'A2 voice response', senderUserId: 'ai:after', source: 'web', created_at: '2026-01-01T00:00:05.000Z' },
        ]));
        await sample('authoritative');
        const beforeStop = snapshots.at(-1).bubbles.map(bubble => bubble.id);
        await page.evaluate(() => window.chatPageHandoffHarness.stop());
        await sample('stop');
        const afterStop = snapshots.at(-1).bubbles.map(bubble => bubble.id);
        if (JSON.stringify(afterStop) !== JSON.stringify(beforeStop)) throw new Error('Stop changed Persona Live ownership');
        await page.evaluate(() => window.chatPageHandoffHarness.dispatch('persona_live_mode', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', enabled: false, liveModeSessionId: 'live-session', liveModeKind: 'personas' }));
                await page.evaluate(() => window.chatPageHandoffHarness.startOrdinaryFollowUp());
                const ordinary = await page.locator('[data-ui="chat-generic-main-stream"]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-message-id'), text: node.querySelector('[data-ui="chat-message-content"]')?.textContent ?? '' })));
        return { snapshots, ordinary };
      }`,
      );
    } finally {
      if (ownsBrowserSessions) await configuredCli('close');
    }
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    result.states = result.snapshots;
    const state = (label: string) =>
      result.states.find((item: any) => item.label === label);
    expect(
      state('chat_persona_started:before-1').bubbles.find(
        (bubble: any) => bubble.id === 'before-1',
      ).status,
    ).toContain('Thinking');
    expect(
      state('chat_persona_started:main-1').bubbles.some(
        (bubble: any) =>
          bubble.id === 'main-1' && bubble.ui === 'chat-invited-persona-stream',
      ),
    ).toBe(false);
    expect(
      state('persona_live_queue:1:before-1').bubbles.map(
        (bubble: any) => bubble.id,
      ),
    ).toEqual(['before-1', 'main-1']);
    expect(
      state('persona_live_queue:1:before-1').bubbles.some(
        (bubble: any) =>
          bubble.id === 'main-1' && bubble.ui === 'chat-invited-persona-stream',
      ),
    ).toBe(false);
    expect(
      state('persona_live_queue:1:before-1').bubbles.find(
        (bubble: any) => bubble.id === 'before-1',
      ).text,
    ).toBe('');
    expect(
      state('chat_persona_output:before-1').bubbles.some((bubble: any) =>
        bubble.text.includes('B raw response'),
      ),
    ).toBe(false);
    expect(
      state('chat_persona_output:before-1').bubbles.every(
        (bubble: any) => !bubble.text.includes('B raw response'),
      ),
    ).toBe(true);
    expect(
      state('persona_live_queue:3:main-1').bubbles.every(
        (bubble: any) => !bubble.text.includes('M raw response'),
      ),
    ).toBe(true);
    expect(
      state('chat_persona_output:after-1').bubbles.every(
        (bubble: any) => !bubble.text.includes('A raw response'),
      ),
    ).toBe(true);
    expect(
      state('main-speaking').bubbles.map((bubble: any) => bubble.id),
    ).toEqual(['before-1', 'main-1']);
    const beforeSpeakingText = state('before-speaking').bubbles.find(
      (bubble: any) => bubble.id === 'before-1',
    ).text;
    expect(
      beforeSpeakingText.length,
      JSON.stringify(state('before-speaking')),
    ).toBeGreaterThan(0);
    expect(state('before-speaking').speech.status).toBe('speaking');
    expect(state('main-speaking').speech.status).toBe('speaking');
    expect(state('after-speaking').speech.status).toBe('speaking');
    expect(
      state('before-speaking').speechRequests.some((url: string) =>
        url.includes('/messages/main-1/speech'),
      ),
    ).toBe(true);
    const mainSpeakingText = state('main-speaking').bubbles.find(
      (bubble: any) => bubble.id === 'main-1',
    ).text;
    expect(mainSpeakingText.length).toBeGreaterThan(0);
    expect('M voice response'.startsWith(mainSpeakingText)).toBe(true);
    expect(mainSpeakingText).not.toBe('M voice response');
    expect(
      state('main-speaking').bubbles.some(
        (bubble: any) => bubble.id === 'after-1',
      ),
    ).toBe(false);
    expect(
      state('chat_persona_started:main-2').bubbles.map(
        (bubble: any) => bubble.id,
      ),
    ).toEqual(['before-1', 'main-1', 'after-1', 'main-2']);
    expect(
      state('chat_persona_finished:main-2').bubbles.map(
        (bubble: any) => bubble.id,
      ),
    ).toEqual(['before-1', 'main-1', 'after-1', 'main-2']);
    expect(
      state('persona_live_queue:11:after-2').bubbles.map(
        (bubble: any) => bubble.id,
      ),
    ).toEqual(['before-1', 'main-1', 'after-1', 'main-2', 'after-2']);
    expect(
      state('persona_live_queue:11:after-2').bubbles.find(
        (bubble: any) => bubble.id === 'after-2',
      ).text,
    ).toContain('A2 voice response');
    expect(
      state('authoritative').bubbles.map((bubble: any) => bubble.id),
    ).toEqual(['before-1', 'main-1', 'after-1', 'main-2', 'after-2']);
    expect(state('stop').bubbles.map((bubble: any) => bubble.id)).toEqual([
      'before-1',
      'main-1',
      'after-1',
      'main-2',
      'after-2',
    ]);
    expect(result.ordinary).toHaveLength(1);
    expect(result.ordinary[0].text).toContain('Ordinary follow-up response');
    const finalIds = result.states
      .at(-1)
      .bubbles.map((bubble: any) => bubble.id);
    for (const item of result.states) {
      const ids = item.bubbles.map((bubble: any) => bubble.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(finalIds.slice(0, ids.length));
    }
  }, 30_000);

  it('bounds a 700-response turn and reveals older responses in order', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.setContent('<div id="root" style="height:100vh"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
          { id: 'large-prompt', type: 'message', role: 'user', content: 'Large persona turn', source: 'web' },
          ...Array.from({ length: 700 }, (_, index) => ({ id: 'persona-' + index, type: 'message', role: 'assistant', content: '**Persona response ' + index + '**', senderUserId: 'ai:persona-' + (index % 2), sender_name: 'Persona ' + (index % 2), source: 'web' })),
        ]));
        await page.locator('[data-ui="chat-canonical-persona-transcript-message"][data-message-id="persona-699"]').waitFor();
        await page.locator('[data-ui="chat-transcript-scroll"][data-transcript-revealed="true"]').waitFor();
        const transcriptWindow = page.locator('[data-ui="chat-mounted-transcript-window"]').last();
        const before = {
          rows: await transcriptWindow.locator('[data-message-id]:not([data-ui="chat-message-content"])').count(),
          markdown: await transcriptWindow.locator('[data-ui="chat-message-content"]').count(),
          latest: await page.locator('[data-ui="chat-canonical-persona-transcript-message"][data-message-id="persona-699"]').count(),
          first: await page.locator('[data-ui="chat-canonical-persona-transcript-message"][data-message-id="persona-0"]').count(),
        };
        const hidden = await transcriptWindow.getAttribute('data-hidden-row-count');
        await transcriptWindow.locator('[data-ui="chat-load-older-rendered-messages"]').click({ force: true });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-ui="chat-mounted-transcript-window"]')].at(-1)?.getAttribute('data-hidden-row-count') === '541');
        const revealedIds = await transcriptWindow.locator('[data-message-id]:not([data-ui="chat-message-content"])').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id')).filter(id => id?.startsWith('persona-')));
        const scroll = page.locator('[data-ui="chat-transcript-scroll"]');
        await scroll.evaluate(el => { el.scrollTop = Math.min(200, el.scrollHeight - el.clientHeight); });
        const scrollBeforeAppend = await scroll.evaluate(el => el.scrollTop);
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
          { id: 'large-prompt', type: 'message', role: 'user', content: 'Large persona turn', source: 'web' },
          ...Array.from({ length: 701 }, (_, index) => ({ id: 'persona-' + index, type: 'message', role: 'assistant', content: '**Persona response ' + index + '**', senderUserId: 'ai:persona-' + (index % 2), sender_name: 'Persona ' + (index % 2), source: 'web' })),
        ]));
        await page.waitForFunction(() => document.querySelector('[data-message-id="persona-700"]'));
        const appendedIds = await transcriptWindow.locator('[data-message-id]:not([data-ui="chat-message-content"])').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id')).filter(id => id?.startsWith('persona-')));
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
          ...Array.from({ length: 700 }, (_, index) => ({ id: 'prepended-' + index, type: 'message', role: 'assistant', content: 'Prepended response ' + index, senderUserId: 'ai:older-' + (index % 2), sender_name: 'Older persona', source: 'web' })),
          { id: 'large-prompt', type: 'message', role: 'user', content: 'Large persona turn', source: 'web' },
          ...Array.from({ length: 701 }, (_, index) => ({ id: 'persona-' + index, type: 'message', role: 'assistant', content: '**Persona response ' + index + '**', senderUserId: 'ai:persona-' + (index % 2), sender_name: 'Persona ' + (index % 2), source: 'web' })),
        ]));
        await page.waitForFunction(() => [...document.querySelectorAll('[data-ui="chat-mounted-transcript-window"]')].at(-1)?.getAttribute('data-hidden-row-count') === '1241');
        const afterPrependIds = await transcriptWindow.locator('[data-message-id]:not([data-ui="chat-message-content"])').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id')).filter(id => id?.startsWith('persona-')));
        const switchSamples = await page.evaluate(async () => {
          const counts = [];
          const sample = () => {
            const window = document.querySelector('[data-ui="chat-mounted-transcript-window"][data-conversation-id="cached-long-conversation"]');
            if (window) counts.push(window.querySelectorAll('[data-message-id]:not([data-ui="chat-message-content"])').length);
          };
          const observer = new MutationObserver(sample);
          observer.observe(document.getElementById('root'), { childList: true, subtree: true });
          const transitionComplete = Promise.withResolvers();
          const cachedWindowReady = () => document.querySelector('[data-ui="chat-mounted-transcript-window"][data-conversation-id="cached-long-conversation"]') !== null;
          if (cachedWindowReady()) transitionComplete.resolve();
          else {
            const transitionObserver = new MutationObserver(() => {
              if (cachedWindowReady()) {
                transitionObserver.disconnect();
                transitionComplete.resolve();
              }
            });
            transitionObserver.observe(document.getElementById('root'), { childList: true, subtree: true });
          }
          await window.chatPageHandoffHarness.activateCachedConversation('cached-long-conversation', [
            { id: 'cached-prompt', type: 'message', role: 'user', content: 'Cached large turn', source: 'web' },
            ...Array.from({ length: 700 }, (_, index) => ({ id: 'cached-persona-' + index, type: 'message', role: 'assistant', content: 'Cached response ' + index, senderUserId: 'ai:cached-' + (index % 2), sender_name: 'Cached persona', source: 'web' })),
          ]);
          await transitionComplete.promise;
          sample();
          observer.disconnect();
          return counts;
        });
        return { before, hidden, afterRows: revealedIds.length, firstAfter: revealedIds[0], lastAfter: revealedIds.at(-1), appendedRows: appendedIds.length, firstAfterAppend: appendedIds[0], lastAfterAppend: appendedIds.at(-1), afterPrependRows: afterPrependIds.length, firstAfterPrepend: afterPrependIds[0], lastAfterPrepend: afterPrependIds.at(-1), scrollBeforeAppend, scrollAfterAppend: await scroll.evaluate(el => el.scrollTop), switchSamples: switchSamples.length, switchMaxRows: Math.max(...switchSamples) };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.before.rows).toBeLessThanOrEqual(82);
    expect(result.before.markdown).toBeLessThanOrEqual(82);
    expect(result.before.latest).toBe(1);
    expect(result.before.first).toBe(0);
    expect(Number(result.hidden)).toBe(621);
    expect(result.afterRows).toBe(160);
    expect(result.firstAfter).toBe('persona-540');
    expect(result.lastAfter).toBe('persona-699');
    expect(result.appendedRows).toBe(161);
    expect(result.firstAfterAppend).toBe('persona-540');
    expect(result.lastAfterAppend).toBe('persona-700');
    expect(result.afterPrependRows).toBe(161);
    expect(result.firstAfterPrepend).toBe('persona-540');
    expect(result.lastAfterPrepend).toBe('persona-700');
    expect(result.scrollAfterAppend).toBe(result.scrollBeforeAppend);
    expect(result.switchSamples).toBeGreaterThan(0);
    expect(result.switchMaxRows).toBeLessThanOrEqual(82);
  }, 40_000);

  it('keeps a long historical task transcript visible after restart without stream content', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([
          { id: 'prompt-long-run', type: 'message', role: 'user', content: 'Track this task', source: 'web' },
          ...Array.from({ length: 100 }, (_, index) => [
            { id: 'response-' + index, type: 'message', role: 'assistant', content: 'Historical response ' + index, source: 'web' },
            { id: 'milestone-' + index, type: 'system_milestone', role: 'system', content: 'Task event ' + index, taskId: 'task-long-run' },
          ]).flat(),
        ]));
        await page.evaluate(() => window.chatPageHandoffHarness.simulateRestartedRunWithoutStreamContent());
        await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="response-99"]').waitFor();
        const window = page.locator('[data-ui="chat-mounted-transcript-window"]').last();
        return {
          latest: await page.locator('[data-message-id="response-99"]').count(),
          earlierInWindow: await page.locator('[data-message-id="response-80"]').count(),
          milestones: await window.locator('[data-ui="chat-task-milestone"]').count(),
          genericStream: await page.locator('[data-ui="chat-generic-main-stream"]').count(),
        };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.latest).toBe(1);
    expect(result.earlierInWindow).toBe(1);
    expect(result.milestones).toBeGreaterThan(0);
    expect(result.genericStream).toBe(0);
  }, 20_000);

  it('shows plan actions on the completed stream before canonical handoff', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.setContent('<div id="root"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      const payload = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'handoff-browser-stream' };
      const plan = '\\n\\n\`\`\`carapaplan\\n{"artifactPath":"artifacts/plans/example.md","planTitle":"Example plan","planText":"# Example plan"}\\n\`\`\`\\n';
      const transcriptRequested = Promise.withResolvers();
      const releaseTranscript = Promise.withResolvers();
      await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript*', async route => {
        transcriptRequested.resolve();
        await releaseTranscript.promise;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          entries: [
            { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' },
            { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response' + plan, source: 'web' },
          ],
          hasMore: false,
          nextOffset: null,
        }) });
      });
      await page.evaluate(([payload, plan]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...payload, content: plan }), [payload, plan]);
      const before = await page.locator('[data-ui="plan-start-implementing"]').count();
      await page.evaluate(payload => window.chatPageHandoffHarness.dispatch('chat_completed', payload), payload);
      await transcriptRequested.promise;
      await page.locator('[data-ui="plan-start-implementing"]').waitFor();
      const result = { before, implementing: await page.locator('[data-ui="plan-start-implementing"]').count(), kanban: await page.locator('[data-ui="plan-send-to-kanban"]').count(), owner: await page.locator('[data-ui="chat-generic-main-stream"]').count() };
      const transcriptResponse = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
      releaseTranscript.resolve();
      await transcriptResponse;
      return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.before).toBe(0);
    expect(result.implementing).toBe(1);
    expect(result.kanban).toBe(1);
    expect(result.owner).toBe(1);
  }, 20_000);

  it('opens a streamed Repo file link through the project preview boundary', async () => {
    const href = '/workspace/handoff-browser-project/docs/streamed.md';
    const path = 'docs/streamed.md';
    const output = await cli(
      'run-code',
      `async page => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.setContent('<div id="root"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => {
        delete window.chatPageHandoffHarness;
        const script = document.createElement('script');
        script.type = 'module';
        script.textContent = "import { useStore } from '/src/store.ts'; useStore.setState({ previewTabsByProject: {}, pendingPreviewActivationByProject: {} }); import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
        script.onerror = reject;
        window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
        document.head.append(script);
      }));
      await page.route('**/artifacts/handoff-browser-project/reports/streamed.md', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/markdown' }, body: '# Streamed report\\n\\nVisible preview' }));
      await page.route('**/files/*/content?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '${path}', mimetype: 'text/markdown', encoding: 'utf-8', content: '# Streamed report' }) }));
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_output', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'handoff-browser-stream', content: '[Report](${href})' }));
      const link = page.getByRole('link', { name: 'Report' });
      await link.waitFor();
      const routeBefore = await page.evaluate(() => location.pathname);
      await link.click();
      await page.locator('#file-preview-markdown').getByText('Streamed report').waitFor();
      const preview = await page.evaluate(() => window.chatPageHandoffHarness.previewTabs());
      return { routeBefore, routeAfter: await page.evaluate(() => location.pathname), href: await link.getAttribute('href'), panelVisible: await page.locator('[data-ui="chat-files-changes-panel"]').isVisible(), previewVisible: await page.locator('#file-preview-markdown').isVisible(), previewText: await page.locator('#file-preview-markdown').textContent(), preview };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.routeAfter).toBe(result.routeBefore);
    expect(result.href).toBe(href);
    expect(result.panelVisible).toBe(true);
    expect(result.previewVisible).toBe(true);
    expect(result.previewText).toContain('Streamed report');
    expect(result.preview.tabs).toHaveLength(1);
    expect(result.preview.tabs[0].source).toBe('repo');
    expect(result.preview.tabs[0].path).toBe(path);
    expect(result.preview.tabs[0].conversation_id).toBe(
      'handoff-browser-conversation',
    );
    expect(result.preview.activeTabId).toBe(
      `repo:handoff-browser-conversation:${path}`,
    );
  }, 20_000);

  it('keeps an ordinary previous response owned and follows only while pinned', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      let acknowledge;
      let clientSubmissionId;
      let requestCount = 0;
      const requestSeen = Promise.withResolvers();
      const canonicalCreatedAt = new Date().toISOString();
      await page.route('**/api/projects/handoff-browser-project/messages', async route => { requestCount += 1; const body = route.request().postDataJSON(); clientSubmissionId = body.clientSubmissionId; requestSeen.resolve(); await new Promise(resolve => { acknowledge = resolve; }); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', userMessage: { id: clientSubmissionId, role: 'user', content: 'Follow up', created_at: canonicalCreatedAt } }) }); });
      const installObserver = () => { const sample = label => { const genericText = [...document.querySelectorAll('[data-ui="chat-generic-main-stream"]')].map(node => node.textContent || ''); const canonicalText = [...document.querySelectorAll('[data-ui="chat-canonical-main-transcript-message"]')].map(node => node.textContent || ''); const userText = [...document.querySelectorAll('[data-message-id], [data-ui="chat-steering-queued-prompt"]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content').map(node => node.textContent || ''); window.__handoffSamples.push({ label, previousOwners: [...genericText, ...canonicalText].filter(text => text.includes('Main response')).length, followUpOwners: userText.filter(text => text.includes('Follow up')).length, genericText, canonicalText }); }; window.__handoffPhase = 'initial'; window.__handoffSamples = []; sample('initial'); window.__handoffObserver = new MutationObserver(() => sample(window.__handoffPhase)); window.__handoffObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, characterData: true }); };
      await page.evaluate(installObserver);
      await page.evaluate(() => { window.__handoffPhase = 'optimistic'; });
      await page.locator('textarea[placeholder="Message…"]').fill('Follow up');
      await page.locator('[data-ui="chat-send-message"]').click();
      await page.evaluate(() => { window.__handoffPhase = 'stale'; });
      await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' }]));
      await page.evaluate(() => { window.__handoffPhase = 'restored'; });
      await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' }, { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', source: 'web' }]));
      await requestSeen.promise;
      if (!acknowledge) throw new Error('message request did not reach acknowledgement boundary');
      const followUpResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages') && response.status() === 200);
      await page.evaluate(() => { window.__handoffPhase = 'acknowledged'; });
      acknowledge();
      await followUpResponse;
      await page.locator('textarea[placeholder="Message…"]').fill('Queue before start');
      await page.locator('[data-ui="chat-send-message"]').click();
      const queuedBeforeStart = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Queue before start' });
      await queuedBeforeStart.waitFor({ timeout: 2_000 });
      await queuedBeforeStart.getByTitle('Delete queued prompt').click();
      await page.evaluate(() => { window.__handoffPhase = 'started'; });
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_started', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'follow-up-stream', personaDriven: false, virtualSender: null }));
      await page.evaluate(() => { window.__handoffPhase = 'output'; });
      const scroll = page.locator('[data-ui="chat-transcript-scroll"]');
      const waitForContentFrame = (text) => page.evaluate((text) => {
        const { promise, resolve } = Promise.withResolvers();
        let observer;
        const finish = () => { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(resolve)); };
        observer = new MutationObserver(() => { const content = document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]'); if ((content?.textContent || '').includes(text)) finish(); });
        observer.observe(document.getElementById('root'), { childList: true, subtree: true, characterData: true });
        const content = document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]');
        if ((content?.textContent || '').includes(text)) finish();
        return promise;
      }, text);
      const followedFrame = waitForContentFrame('New response');
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_output', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'follow-up-stream', content: 'New response' }));
      await followedFrame;
      const followed = await scroll.evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
      const activeVisible = await page.locator('[data-ui="chat-generic-main-stream"]').evaluate((node) => { const bubble = node.getBoundingClientRect(); const viewport = document.querySelector('[data-ui="chat-transcript-scroll"]').getBoundingClientRect(); return bubble.bottom <= viewport.bottom + 1 && bubble.top < viewport.bottom; });
      await scroll.evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - 120); el.dispatchEvent(new Event('scroll')); });
      const beforeGrowth = await scroll.evaluate(el => el.scrollTop);
      const growthFrame = waitForContentFrame('More output');
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_output', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'follow-up-stream', content: '\\n\\n' + 'More output '.repeat(100) }));
      await growthFrame;
      const afterGrowth = await scroll.evaluate(el => el.scrollTop);
      await page.evaluate(() => { window.__handoffPhase = 'completion-stale'; });
      await page.evaluate(() => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' }]));
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_completed', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'follow-up-stream' }));
            await page.evaluate(() => { window.__handoffPhase = 'completion-restored'; });
      await page.evaluate(([createdAt, id]) => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', created_at: '2026-01-01T00:00:00.000Z', source: 'web' }, { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', created_at: '2026-01-01T00:00:01.000Z', source: 'web' }, { id, type: 'message', role: 'user', content: 'Follow up', created_at: createdAt, source: 'web' }, { id: 'main-2', type: 'message', role: 'assistant', content: 'New response\\n\\n' + 'More output '.repeat(100), created_at: new Date().toISOString(), source: 'web' }]), [canonicalCreatedAt, clientSubmissionId]);
            const samples = await page.evaluate(() => { window.__handoffObserver.disconnect(); return window.__handoffSamples; });
      return { samples, followed, activeVisible, beforeGrowth, afterGrowth, requestCount };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    for (const state of result.samples)
      expect(state.previousOwners, JSON.stringify(state)).toBe(1);
    const followUpFrames = result.samples.filter(
      (state) => state.followUpOwners > 0,
    );
    expect(followUpFrames.length).toBeGreaterThan(0);
    for (const state of followUpFrames)
      expect(state.followUpOwners, JSON.stringify(state)).toBe(1);
    for (const state of followUpFrames) {
      expect(
        state.genericText.some((text: string) =>
          text.includes('Main response'),
        ),
        JSON.stringify(state),
      ).toBe(false);
    }
    expect(
      result.samples.some((state) =>
        state.genericText.join(' ').includes('New response'),
      ),
    ).toBe(true);
    expect(result.followed.top).toBe(result.followed.max);
    expect(result.activeVisible).toBe(true);
    expect(result.afterGrowth).toBe(result.beforeGrowth);
    expect(result.requestCount).toBe(1);
  }, 20_000);

  it('removes a failed optimistic follow-up without dropping prior history', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.unroute('**/api/projects/handoff-browser-project/messages');
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      const requestSeen = Promise.withResolvers();
      const responseRelease = Promise.withResolvers();
      await page.route('**/api/projects/handoff-browser-project/messages', async route => {
        requestSeen.resolve();
        await responseRelease.promise;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Send failed' }) });
      });
      await page.evaluate(() => { const sample = () => { const owners = [...document.querySelectorAll('[data-ui="chat-generic-main-stream"], [data-ui="chat-canonical-main-transcript-message"]')].filter(node => (node.textContent || '').includes('Main response')).length; const prompts = [...document.querySelectorAll('[data-message-id]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Failed follow up')).length; window.__failedSamples.push({ owners, prompts }); }; window.__failedSamples = []; sample(); window.__failedObserver = new MutationObserver(sample); window.__failedObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, characterData: true }); });
      await page.locator('textarea[placeholder="Message…"]').fill('Failed follow up');
      const failedResponse = page.waitForResponse(response => response.url().includes('/api/projects/handoff-browser-project/messages') && response.status() === 500);
      await page.locator('[data-ui="chat-send-message"]').click();
      await page.waitForFunction(() => document.body.textContent.includes('Failed follow up'));
      await requestSeen.promise;
      responseRelease.resolve();
      await failedResponse;
      await page.waitForFunction(() => !window.chatPageHandoffHarness.transcriptEntries().some(entry => entry.type === 'message' && entry.role === 'user' && entry.content === 'Failed follow up') && ![...document.querySelectorAll('[data-message-id]')].some(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Failed follow up')));
      return await page.evaluate(() => { window.__failedObserver.disconnect(); return { samples: window.__failedSamples, finalPromptOwners: [...document.querySelectorAll('[data-message-id]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Failed follow up')).length }; });
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.samples.some((state) => state.prompts === 1)).toBe(true);
    for (const state of result.samples) {
      expect(state.owners, JSON.stringify(state)).toBe(1);
      expect(state.prompts, JSON.stringify(state)).toBeLessThanOrEqual(1);
    }
    expect(result.finalPromptOwners, JSON.stringify(result)).toBe(0);
  }, 20_000);

  it('deduplicates fast canonical refetch before acknowledgement', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.unroute('**/api/projects/handoff-browser-project/messages');
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      let acknowledge;
      let clientSubmissionId;
      const requestSeen = Promise.withResolvers();
      const createdAt = new Date().toISOString();
      await page.route('**/api/projects/handoff-browser-project/messages', async route => { const body = route.request().postDataJSON(); clientSubmissionId = body.clientSubmissionId; requestSeen.resolve(); await new Promise(resolve => { acknowledge = resolve; }); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', userMessage: { id: clientSubmissionId, role: 'user', content: 'Fast follow up', created_at: createdAt } }) }); });
      await page.evaluate(() => { const sample = () => { const nodes = [...document.querySelectorAll('[data-message-id], [data-ui="chat-steering-queued-prompt"]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content'); window.__fastSamples.push({ previous: [...document.querySelectorAll('[data-ui="chat-generic-main-stream"], [data-ui="chat-canonical-main-transcript-message"]')].filter(node => (node.textContent || '').includes('Main response')).length, prompts: nodes.filter(node => (node.textContent || '').includes('Fast follow up')).length, owners: nodes.filter(node => (node.textContent || '').includes('Fast follow up')).map(node => ({ ui: node.getAttribute('data-ui'), id: node.getAttribute('data-message-id'), queueId: node.getAttribute('data-queued-prompt-id') })) }); }; window.__fastSamples = []; window.__fastObserver = new MutationObserver(sample); window.__fastObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, characterData: true }); });
      await page.locator('textarea[placeholder="Message…"]').fill('Fast follow up');
      await page.locator('[data-ui="chat-send-message"]').click();
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_started', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'fast-stream', personaDriven: false, virtualSender: null }));
      await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', created_at: '2026-01-01T00:00:00.000Z', source: 'web' }, { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', created_at: '2026-01-01T00:00:01.000Z', source: 'web' }, { id: clientSubmissionId, type: 'message', role: 'user', content: 'Fast follow up', created_at: createdAt, source: 'web' }], total: 3, hasMore: false, nextOffset: 3 }) }));
      const transcriptResponse = page.waitForResponse(response => response.url().includes('/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_completed', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'fast-stream' }));
      await transcriptResponse;
      if (!acknowledge) throw new Error('fast message request was not intercepted');
      const fastResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages') && response.status() === 200);
      acknowledge();
      await fastResponse;
      await page.waitForFunction(() => [...document.querySelectorAll('[data-message-id], [data-ui="chat-steering-queued-prompt"]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Fast follow up')).length === 1);
      return await page.evaluate(() => { window.__fastObserver.disconnect(); return window.__fastSamples; });
    }`,
    );
    const samples = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    const firstOwnerIndex = samples.findIndex((state) => state.prompts === 1);
    expect(firstOwnerIndex).toBeGreaterThanOrEqual(0);
    for (const [index, state] of samples.entries()) {
      expect(state.previous, JSON.stringify(state)).toBe(1);
      if (index >= firstOwnerIndex) {
        expect(state.prompts, JSON.stringify(state)).toBe(1);
      } else {
        expect(state.prompts, JSON.stringify(state)).toBeLessThanOrEqual(1);
      }
    }
    expect(samples.at(-1).prompts).toBe(1);
  }, 20_000);

  it('transfers a backend-queued prompt out of transcript ownership', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.unroute('**/api/projects/handoff-browser-project/messages');
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      let acknowledgeQueued;
      let queuedMessageId;
      const requestSeen = Promise.withResolvers();
      await page.route('**/api/projects/handoff-browser-project/messages', async route => { const body = route.request().postDataJSON(); queuedMessageId = body.clientSubmissionId; requestSeen.resolve(); await new Promise(resolve => { acknowledgeQueued = resolve; }); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', delivery: 'queued', queueOwner: 'browser', userMessage: { id: queuedMessageId, role: 'user', content: 'Queue this follow up', created_at: new Date().toISOString() } }) }); });
      await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', created_at: '2026-01-01T00:00:00.000Z', source: 'web' }, { id: 'main-1', type: 'message', role: 'assistant', content: 'Main response', created_at: '2026-01-01T00:00:01.000Z', source: 'web' }, ...(queuedMessageId ? [{ id: queuedMessageId, type: 'message', role: 'user', content: 'Queue this follow up', created_at: new Date().toISOString(), source: 'web' }] : [])], total: queuedMessageId ? 3 : 2, hasMore: false, nextOffset: queuedMessageId ? 3 : 2 }) }));
      await page.evaluate(() => { const sample = () => { const nodes = [...document.querySelectorAll('[data-ui="chat-steering-queued-prompt"], [data-message-id]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Queue this follow up')); window.__backendQueuedSamples.push({ count: nodes.length, owners: nodes.map(node => ({ ui: node.getAttribute('data-ui'), id: node.getAttribute('data-message-id'), queueId: node.getAttribute('data-queued-prompt-id') })) }); }; window.__backendQueuedSamples = []; sample(); window.__backendQueuedObserver = new MutationObserver(sample); window.__backendQueuedObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, characterData: true }); });
      const waitForSingleOwner = async label => { try { await page.waitForFunction(() => [...document.querySelectorAll('[data-ui="chat-steering-queued-prompt"], [data-message-id]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Queue this follow up')).length === 1, undefined, { timeout: 5_000 }); } catch { const state = await page.evaluate(() => window.__backendQueuedSamples.at(-1)); throw new Error(label + ': ' + JSON.stringify(state)); } };
      await page.locator('textarea[placeholder="Message…"]').fill('Queue this follow up');
      await page.locator('[data-ui="chat-send-message"]').click();
      const transcriptPromptCount = () => [...document.querySelectorAll('[data-message-id]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Queue this follow up')).length;
      await waitForSingleOwner('optimistic');
      const optimisticOwners = await page.evaluate(transcriptPromptCount);
      await requestSeen.promise;
      if (!acknowledgeQueued) throw new Error('queued message request was not intercepted');
      await page.evaluate(id => { void window.chatPageHandoffHarness.dispatch('chat_message', { folder: 'handoff-browser-project', message: { id, conversation_id: 'handoff-browser-conversation', role: 'user', content: 'Queue this follow up', source: 'web' } }); }, queuedMessageId);
      await waitForSingleOwner('websocket');
      const queuedResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages') && response.status() === 200);
      acknowledgeQueued();
      await queuedResponse;
      await waitForSingleOwner('http');
      return await page.evaluate((optimistic) => { window.__backendQueuedObserver.disconnect(); return { optimisticOwners: optimistic, queuedOwners: [...document.querySelectorAll('[data-ui="chat-steering-queued-prompt"]')].filter(node => (node.textContent || '').includes('Queue this follow up')).length, previous: [...document.querySelectorAll('[data-ui="chat-generic-main-stream"], [data-ui="chat-canonical-main-transcript-message"]')].filter(node => (node.textContent || '').includes('Main response')).length, transcriptPrompts: [...document.querySelectorAll('[data-message-id]')].filter(node => node.getAttribute('data-ui') !== 'chat-message-content' && (node.textContent || '').includes('Queue this follow up')).length, samples: window.__backendQueuedSamples }; }, optimisticOwners);
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.optimisticOwners).toBe(1);
    expect(result.queuedOwners).toBe(1);
    expect(result.previous).toBe(1);
    expect(result.transcriptPrompts).toBe(0);
    const firstOwnerIndex = result.samples.findIndex(
      (sample) => sample.count === 1,
    );
    expect(firstOwnerIndex).toBeGreaterThanOrEqual(0);
    for (const [index, sample] of result.samples.entries()) {
      expect(sample.count, JSON.stringify(sample)).toBe(
        index < firstOwnerIndex ? 0 : 1,
      );
    }
  }, 20_000);

  it('shows direct delivery as current-turn pending instead of next-turn queued', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.unroute('**/api/projects/handoff-browser-project/messages');
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      const createdAt = new Date().toISOString();
      await page.route('**/api/projects/handoff-browser-project/messages', route => { const body = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', delivery: 'pending', queueOwner: 'direct', userMessage: { id: body.clientSubmissionId, group_folder: 'handoff-browser-project', role: 'user', content: 'Adjust this response', source: 'web', created_at: createdAt, conversation_id: 'handoff-browser-conversation', steeringDelivery: 'pending', steeringStreamKey: 'main-stream' } }) }); });
      await page.locator('textarea[placeholder="Message…"]').fill('Adjust this response');
      await page.locator('[data-ui="chat-send-message"]').click();
      const pending = page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]').filter({ hasText: 'Applying to current turn' });
      await pending.waitFor();
      return { pendingText: await pending.textContent(), queuedLabelCount: await page.getByText('Queued for the next turn', { exact: true }).count() };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.pendingText).toContain('Applying to current turn');
    expect(result.queuedLabelCount).toBe(0);
  }, 20_000);

  it('changes a mounted direct delivery from pending to applied on authoritative absorption', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.unroute('**/api/projects/handoff-browser-project/messages');
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; document.head.appendChild(script); window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      const createdAt = new Date().toISOString();
      await page.route('**/api/projects/handoff-browser-project/messages', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', delivery: 'pending', queueOwner: 'direct', userMessage: { id: 'direct-absorbed', group_folder: 'handoff-browser-project', role: 'user', content: 'Apply this now', source: 'web', created_at: createdAt, conversation_id: 'handoff-browser-conversation', steeringDelivery: 'pending', steeringStreamKey: 'main-stream' } }) }));
      await page.locator('textarea[placeholder="Message…"]').fill('Apply this now');
      await page.locator('[data-ui="chat-send-message"]').click();
      await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]').waitFor();
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_message', { folder: 'handoff-browser-project', message: { id: 'direct-absorbed', conversation_id: 'handoff-browser-conversation', role: 'user', content: 'Apply this now', steeringDelivery: 'steered' } }));
      const applied = page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]').filter({ hasText: 'Applied to current turn' });
      await applied.waitFor();
      return { appliedText: await applied.textContent(), pendingCount: await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]').count(), steeringOrder: await applied.locator('xpath=..').evaluate(container => [...container.children].map(node => node.getAttribute('data-ui'))) };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.appliedText).toContain('Applied to current turn');
    expect(result.pendingCount).toBe(0);
    expect(result.steeringOrder).toEqual([
      'chat-steering-acknowledgement',
      'chat-message-actions',
    ]);
  }, 20_000);

  it('keeps reversed delayed tool results under their calls through completion and reload', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root" style="height:100vh"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'tool-owner-stream' };
        const nl = String.fromCharCode(10);
        const request = (id, label) => nl + nl + '<!-- carapa-tool:request tool-id="' + id + '" -->' + nl + '> **Bash** ' + label + nl + nl;
        const result = (id, value, failed = false) => nl + nl + '<!-- carapa-tool:' + (failed ? 'error' : 'result') + ' tool-id="' + id + '" -->' + nl + (failed ? '> ⚠️' + nl : '') + '> ' + value + nl + nl;
        const terminalError = (id, value) => nl + nl + '<!-- carapa-tool:error tool-id="' + id + '" -->' + nl + '> **Error** ' + value + nl + nl;
        const content = request('call-a', 'repeated command') + 'Intervening prose.' + request('call-b', 'repeated command') + request('call-c', 'OpenCode command') + result('call-b', 'B owned output', true) + terminalError('call-c', 'OpenCode terminal failure') + result('call-a', 'A owned output') + 'Final prose.';
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_started', { ...base, personaDriven: false, virtualSender: null }), base);
        for (const chunk of [request('call-a', 'repeated command'), 'Intervening prose.', request('call-b', 'repeated command'), request('call-c', 'OpenCode command'), result('call-b', 'B owned output', true), terminalError('call-c', 'OpenCode terminal failure'), result('call-a', 'A owned output'), 'Final prose.']) {
          await page.evaluate(([base, chunk]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content: chunk }), [base, chunk]);
        }
        const ownerState = async () => {
          const calls = page.locator('[data-ui="chat-generic-main-stream"][data-stream-key="tool-owner-stream"] [data-ui="tool-call"]');
          await calls.nth(2).waitFor({ state: 'attached' });
          return calls.evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-tool-call-id'), failed: node.getAttribute('data-tool-call-failed'), text: node.textContent.replace(/\\s+/g, ' ').trim() })));
        };
        const live = await ownerState();
        await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'tool-prompt', type: 'message', role: 'user', content: 'Run tools' }, { id: 'tool-final', type: 'message', role: 'assistant', content }], hasMore: false, nextOffset: null }) }));
        const response = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_completed', base), base);
        await response;
        const canonical = page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="tool-final"]');
        await canonical.waitFor();
        const canonicalCalls = canonical.locator('[data-ui="tool-call"]');
        await canonicalCalls.nth(2).waitFor({ state: 'attached' });
        const reloaded = await canonicalCalls.evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-tool-call-id'), failed: node.getAttribute('data-tool-call-failed'), text: node.textContent.replace(/\\s+/g, ' ').trim() })));
        return { live, reloaded, canonicalText: await canonical.textContent() };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    for (const state of [result.live, result.reloaded]) {
      expect(state).toHaveLength(3);
      expect(state.find((call) => call.id === 'call-a')).toMatchObject({
        failed: 'false',
      });
      expect(state.find((call) => call.id === 'call-a').text).toContain(
        'A owned output',
      );
      expect(state.find((call) => call.id === 'call-a').text).not.toContain(
        'B owned output',
      );
      expect(state.find((call) => call.id === 'call-b')).toMatchObject({
        failed: 'true',
      });
      expect(state.find((call) => call.id === 'call-b').text).toContain(
        'B owned output',
      );
      expect(state.find((call) => call.id === 'call-b').text).not.toContain(
        'A owned output',
      );
      expect(state.find((call) => call.id === 'call-c')).toMatchObject({
        failed: 'true',
      });
      expect(state.find((call) => call.id === 'call-c').text).toContain(
        'OpenCode terminal failure',
      );
      expect(state.find((call) => call.id === 'call-c').text).not.toContain(
        'A owned output',
      );
    }
    expect(result.canonicalText.match(/A owned output/g)).toHaveLength(1);
    expect(result.canonicalText.match(/B owned output/g)).toHaveLength(1);
    expect(
      result.canonicalText.match(/OpenCode terminal failure/g),
    ).toHaveLength(1);
  }, 30_000);

  it('keeps tool ownership and subsequent prose around accepted steering', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root" style="height:100vh"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { configuredMainPersona: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        const nl = String.fromCharCode(10);
        const request = (id, label) => nl + nl + '<!-- carapa-tool:request tool-id="' + id + '" -->' + nl + '> **Bash** ' + label + nl + nl;
        const result = (id, value, failed = false) => nl + nl + '<!-- carapa-tool:' + (failed ? 'error' : 'result') + ' tool-id="' + id + '" -->' + nl + (failed ? '> ⚠️' + nl : '') + '> ' + value + nl + nl;
        const before = request('steer-a', 'same command') + 'Before steering prose.' + request('steer-b', 'same command');
        await page.evaluate(before => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'steered-prompt', type: 'message', role: 'user', content: 'Run tools' }, { id: 'main-1', type: 'message', role: 'assistant', content: before }]), before);
        await page.route('**/api/projects/handoff-browser-project/messages', route => { const body = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'handoff-browser-conversation', delivery: 'steered', queueOwner: 'direct', steeringBoundary: { streamKey: 'main-stream', contentOffset: before.length, targetMessageId: 'main-1' }, userMessage: { id: body.clientSubmissionId, role: 'user', content: 'Steer between calls and results', created_at: new Date().toISOString(), steeringDelivery: 'steered', steeringStreamKey: 'main-stream' } }) }); });
        await page.locator('textarea[placeholder="Message…"]').fill('Steer between calls and results');
        await page.locator('[data-ui="chat-send-message"]').click();
        await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]').waitFor();
        const partialB = nl + nl + '<!-- carapa-tool:error tool-id="steer-b" -->' + nl + '> ⚠️' + nl + '> B partial';
        const fullContent = before + partialB + ' failure' + nl + nl + result('steer-a', 'A delayed success') + 'After steering prose.';
        await page.evaluate(fullContent => window.chatPageHandoffHarness.replaceTranscriptEntries([{ id: 'steered-prompt', type: 'message', role: 'user', content: 'Run tools' }, { id: 'main-1', type: 'message', role: 'assistant', content: fullContent }]), fullContent);
        const applied = page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]');
        await applied.waitFor();
        const calls = await page.locator('[data-ui="tool-call"][data-tool-call-id^="steer-"]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-tool-call-id'), failed: node.getAttribute('data-tool-call-failed'), owner: node.closest('[data-message-id]')?.getAttribute('data-message-id'), text: node.textContent.replace(/\\s+/g, ' ').trim() })));
        const ordered = await page.locator('[data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-canonical-persona-transcript-message"], [data-ui="chat-current-user-message"]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-message-id'), text: node.textContent.replace(/\\s+/g, ' ').trim() })).filter(node => node.text.includes('Before steering prose.') || node.text.includes('Steer between calls and results') || node.text.includes('After steering prose.')));
        const steeringCount = await page.locator('[data-ui="chat-current-user-message"]').filter({ hasText: 'Steer between calls and results' }).count();
        return { calls, ordered, steeringCount };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.steeringCount).toBe(1);
    expect(result.calls).toHaveLength(2);
    expect(result.calls.find((call) => call.id === 'steer-a').text).toContain(
      'A delayed success',
    );
    expect(result.calls.find((call) => call.id === 'steer-b')).toMatchObject({
      failed: 'true',
    });
    expect(result.calls.find((call) => call.id === 'steer-b').text).toContain(
      'B partial failure',
    );
    expect(result.ordered, JSON.stringify(result.ordered)).toHaveLength(3);
    expect(result.ordered[0].text).toContain('Before steering prose.');
    expect(result.ordered[0].text).toContain('A delayed success');
    expect(result.ordered[0].text).toContain('B partial failure');
    expect(result.ordered[1].text).toContain('Steer between calls and results');
    expect(result.ordered[2].text).toContain('After steering prose.');
    expect(result.ordered[2].text).not.toContain('delayed');
    expect(result.ordered[2].text).not.toContain('partial failure');
  }, 30_000);

  it('keeps accepted steering boundaries in the active tool-bearing stream', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root" style="height:100vh"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        await page.waitForFunction(() => Boolean(window.chatPageHandoffHarness));
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'tool-steering-stream' };
        const nl = String.fromCharCode(10);
        const request = (id, command) => nl + nl + '<!-- carapa-tool:request tool-id="' + id + '" -->' + nl + '> **Bash** ' + command + nl + nl;
        const before = 'Visible before steering.' + request('live-success', 'inspect') + request('live-error', 'retry');
        const withdrawalOutput = 'Output while server queue withdrawal is pending.';
        const pendingOutput = 'Output while steering acknowledgement is pending.';
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_started', { ...base, personaDriven: false, virtualSender: null }), base);
        await page.evaluate(([base, before]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content: before }), [base, before]);
        await page.locator('[data-ui="chat-generic-main-stream"][data-stream-key="tool-steering-stream"]').filter({ hasText: 'Visible before steering.' }).waitFor();

        const requestSeen = [Promise.withResolvers(), Promise.withResolvers()];
        const acknowledgeRequest = [Promise.withResolvers(), Promise.withResolvers()];
        const requestBodies = [];
        const transcriptRoute = '**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript*';
        let transcriptPhase = 'steering-user';
        await page.route(transcriptRoute, route => {
          const firstId = requestBodies[0]?.clientSubmissionId;
          const secondId = requestBodies[1]?.clientSubmissionId;
          const firstPrompt = { id: firstId, type: 'message', role: 'user', content: 'Change course live', source: 'web', steeringDelivery: 'steered' };
          const secondPrompt = { id: secondId, type: 'message', role: 'user', content: 'Refine again live', source: 'web', steeringDelivery: 'steered' };
          let entries = [
            { id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', source: 'web' },
            firstPrompt,
          ];
          if (transcriptPhase !== 'steering-user') {
            entries = [
              entries[0],
              { id: 'live-main:before:' + firstId, type: 'message', role: 'assistant', content: before + withdrawalOutput + delayedResult, source: 'web' },
              firstPrompt,
              { id: 'live-main:first-after', type: 'message', role: 'assistant', content: pendingOutput + 'After first steering.', source: 'web' },
            ];
          }
          if (transcriptPhase === 'two-steering-live' || transcriptPhase === 'canonical') {
            entries.push(
              secondPrompt,
              { id: 'live-main', type: 'message', role: 'assistant', content: 'After second steering.', source: 'web' },
            );
          }
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries, hasMore: false, nextOffset: null }) });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', async route => {
          const body = route.request().postDataJSON();
          const requestIndex = requestBodies.length;
          requestBodies.push(body);
          requestSeen[requestIndex].resolve();
          await acknowledgeRequest[requestIndex].promise;
          const contentOffset = requestIndex === 0
            ? before.length + withdrawalOutput.length
            : before.length + withdrawalOutput.length + pendingOutput.length + delayedResult.length + 'After first steering.'.length;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            conversation_id: base.conversation_id,
            delivery: 'steered',
            userMessage: { id: body.clientSubmissionId, role: 'user', content: requestIndex === 0 ? 'Change course live' : 'Refine again live' },
            steeringBoundary: { streamKey: base.streamKey, contentOffset },
          }) });
        });
        const snapshots = [];
        const snapshotLive = async label => {
          const turn = page.locator('[data-ui="chat-steered-turn"][data-stream-key="tool-steering-stream"]');
          const owners = await turn.locator(':scope > *').evaluateAll(nodes => nodes.map(node => {
            const owner = node.matches('[data-message-id]') ? node : node.querySelector('[data-message-id]');
            return {
              ui: node.getAttribute('data-ui'),
              id: owner?.getAttribute('data-message-id'),
              streamKey: owner?.getAttribute('data-stream-key'),
              steeringStatus: node.getAttribute('data-steering-status'),
              text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
              toolIds: [...new Set([...node.querySelectorAll('[data-tool-call-id]')].map(tool => tool.getAttribute('data-tool-call-id')))],
            };
          }));
          const messageOwners = page.locator('[data-message-id]:not([data-ui="chat-message-content"])');
          snapshots.push({
            label,
            owners,
            firstPromptOwners: await messageOwners.filter({ hasText: 'Change course live' }).count(),
            secondPromptOwners: await messageOwners.filter({ hasText: 'Refine again live' }).count(),
          });
        };
        const liveTurn = page.locator('[data-ui="chat-steered-turn"][data-stream-key="tool-steering-stream"]');
        await page.locator('textarea[placeholder="Message…"]').fill('Change course live');
        await page.locator('[data-ui="chat-send-message"]').click();
        const queued = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Change course live' });
        await queued.waitFor();
        const queuedPromptId = await queued.getAttribute('data-queued-prompt-id');
        if (!queuedPromptId) throw new Error('queued steering prompt has no stable id');
        await page.evaluate(id => window.chatPageHandoffHarness.markQueuedPromptServerOwned(id), queuedPromptId);
        const withdrawalSeen = Promise.withResolvers();
        const finishWithdrawal = Promise.withResolvers();
        await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/queued-messages/*', async route => {
          if (route.request().method() !== 'DELETE') return route.fallback();
          withdrawalSeen.resolve();
          await finishWithdrawal.promise;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ withdrawn: true, released: false }) });
        });
        await queued.getByTitle('Use this queued prompt to steer the running turn').click();
        await withdrawalSeen.promise;
        await page.evaluate(([base, content]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content }), [base, withdrawalOutput]);
        await page.locator('[data-ui="chat-generic-main-stream"][data-stream-key="tool-steering-stream"]').filter({ hasText: withdrawalOutput }).waitFor();
        finishWithdrawal.resolve();
        await requestSeen[0].promise;
        await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="pending"]').waitFor();
        await snapshotLive('pending-first');
        await page.evaluate(([base, content]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content }), [base, pendingOutput]);
        await liveTurn.filter({ hasText: pendingOutput }).waitFor();
        await snapshotLive('pending-first-chunk');
        acknowledgeRequest[0].resolve();
        await page.locator('[data-ui="chat-steering-acknowledgement"][data-steering-status="steered"]').waitFor();
        await snapshotLive('steered-first');

        const delayedResult = nl + nl + '<!-- carapa-tool:result tool-id="live-success" -->' + nl + '> delayed success' + nl + nl + '<!-- carapa-tool:error tool-id="live-error" -->' + nl + '> ⚠️' + nl + '> delayed failure' + nl + nl;
        await page.evaluate(([base, content]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content }), [base, delayedResult + 'After first steering.']);
        await liveTurn.filter({ hasText: 'After first steering.' }).waitFor();
        await snapshotLive('post-first-chunk');

        transcriptPhase = 'live-continuation';
        const refetched = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        await page.evaluate(([base, id]) => window.chatPageHandoffHarness.dispatch('chat_message', {
          folder: base.folder,
          message: { id, conversation_id: base.conversation_id, role: 'user', content: 'Change course live', source: 'web', steeringDelivery: 'steered' },
        }), [base, requestBodies[0].clientSubmissionId]);
        await refetched;
        await page.waitForFunction(() => window.chatPageHandoffHarness.transcriptEntries().some(entry => entry.role === 'assistant' && entry.content.includes('After first steering.')));
        await snapshotLive('refetched-first');

        await page.locator('textarea[placeholder="Message…"]').fill('Refine again live');
        await page.locator('[data-ui="chat-send-message"]').click();
        const queuedSecond = page.locator('[data-ui="chat-steering-queued-prompt"]').filter({ hasText: 'Refine again live' });
        await queuedSecond.waitFor();
        await queuedSecond.getByTitle('Use this queued prompt to steer the running turn').click();
        await requestSeen[1].promise;
        await page.locator('[data-ui="chat-steering-message"][data-steering-status="pending"]').filter({ hasText: 'Refine again live' }).waitFor();
        await snapshotLive('pending-second');
        acknowledgeRequest[1].resolve();
        await page.locator('[data-ui="chat-steering-message"][data-steering-status="steered"]').filter({ hasText: 'Refine again live' }).waitFor();
        await snapshotLive('steered-second');
        await page.evaluate(([base, content]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content }), [base, 'After second steering.']);
        await liveTurn.filter({ hasText: 'After second steering.' }).waitFor();
        await snapshotLive('post-second-chunk');

        transcriptPhase = 'two-steering-live';
        const secondRefetch = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        await page.evaluate(([base, id]) => window.chatPageHandoffHarness.dispatch('chat_message', {
          folder: base.folder,
          message: { id, conversation_id: base.conversation_id, role: 'user', content: 'Refine again live', source: 'web', steeringDelivery: 'steered' },
        }), [base, requestBodies[1].clientSubmissionId]);
        await secondRefetch;
        await page.waitForFunction(() => window.chatPageHandoffHarness.transcriptEntries().some(entry => entry.content === 'After second steering.'));
        await snapshotLive('refetched-second');

        await page.route('**/api/projects/handoff-browser-project/messages/stop', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, stopped: true }) }));
        const stopResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/messages/stop') && response.status() === 200, { timeout: 5000 });
        await page.getByRole('button', { name: 'Stop' }).click({ timeout: 5000 });
        await stopResponse;
        await snapshotLive('stopped');

        transcriptPhase = 'canonical';
        const completedRefetch = page.waitForResponse(response => response.url().includes('/conversations/handoff-browser-conversation/transcript') && response.status() === 200);
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_completed', base), base);
        await completedRefetch;
        await page.locator('[data-ui="chat-steering-message"]').waitFor({ state: 'detached', timeout: 5000 });
        await page.locator('[data-ui="chat-generic-main-stream"][data-stream-key="tool-steering-stream"]').waitFor({ state: 'detached', timeout: 5000 });
        const canonicalOwners = await page.locator('[data-ui="chat-canonical-main-transcript-message"], [data-ui="chat-current-user-message"]').evaluateAll(nodes => nodes.map(node => ({
          id: node.getAttribute('data-message-id'),
          text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
          toolIds: [...new Set([...node.querySelectorAll('[data-tool-call-id]')].map(tool => tool.getAttribute('data-tool-call-id')))],
        })).filter(node => node.text.includes('Visible before steering.') || node.text.includes('Change course live') || node.text.includes('After first steering.') || node.text.includes('Refine again live') || node.text.includes('After second steering.')));
        return {
          snapshots,
          canonicalOwners,
          localSteeringOwners: await page.locator('[data-ui="chat-steering-message"]').count(),
          genericOwners: await page.locator('[data-ui="chat-generic-main-stream"][data-stream-key="tool-steering-stream"]').count(),
        };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    for (const snapshot of result.snapshots) {
      expect(snapshot.firstPromptOwners, snapshot.label).toBe(1);
      if (snapshot.label.includes('second'))
        expect(snapshot.secondPromptOwners, snapshot.label).toBe(1);
      expect(snapshot.owners[0].text, snapshot.label).toContain(
        'Visible before steering.',
      );
      expect(snapshot.owners[1].text, snapshot.label).toContain(
        'Change course live',
      );
    }
    const snapshot = (label: string) =>
      result.snapshots.find((entry) => entry.label === label);
    for (const label of result.snapshots.map((entry) => entry.label)) {
      expect(snapshot(label).owners[0].text, label).toContain(
        'Output while server queue withdrawal is pending.',
      );
    }
    expect(snapshot('pending-first-chunk').owners[0].text).not.toContain(
      'Output while steering acknowledgement is pending.',
    );
    expect(snapshot('pending-first-chunk').owners[2].text).toContain(
      'Output while steering acknowledgement is pending.',
    );
    for (const label of [
      'post-first-chunk',
      'refetched-first',
      'pending-second',
      'steered-second',
      'post-second-chunk',
      'refetched-second',
      'stopped',
    ]) {
      const current = snapshot(label);
      expect(current.owners[0].text, label).toContain('delayed success');
      expect(current.owners[0].text, label).toContain('delayed failure');
      expect(current.owners[0].toolIds, label).toEqual([
        'live-success',
        'live-error',
      ]);
      expect(current.owners[2].text, label).toContain('After first steering.');
      expect(current.owners[2].text, label).toContain(
        'Output while steering acknowledgement is pending.',
      );
    }
    for (const label of [
      'pending-second',
      'steered-second',
      'post-second-chunk',
      'refetched-second',
      'stopped',
    ]) {
      const current = snapshot(label);
      expect(current.owners[3].text, label).toContain('Refine again live');
    }
    for (const label of ['post-second-chunk', 'refetched-second', 'stopped']) {
      const current = snapshot(label);
      expect(current.owners[4].text, label).toContain('After second steering.');
    }
    expect(result.localSteeringOwners).toBe(0);
    expect(result.genericOwners).toBe(0);
    expect(result.canonicalOwners.map((owner) => owner.text)).toEqual([
      expect.stringContaining('Visible before steering.'),
      expect.stringContaining('Change course live'),
      expect.stringContaining('After first steering.'),
      expect.stringContaining('Refine again live'),
      expect.stringContaining('After second steering.'),
    ]);
    expect(result.canonicalOwners[0].text).toContain('delayed success');
    expect(result.canonicalOwners[0].text).toContain('delayed failure');
    expect(result.canonicalOwners[2].text).toContain(
      'Output while steering acknowledgement is pending.',
    );
  }, 30_000);

  it('does not follow the first output when the user scrolls up after chat_started', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.unroute('**/api/projects/handoff-browser-project/messages');
      await page.setContent('<div id="root" style="height:100vh"></div>');
      await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
      await page.locator('[data-ui="chat-canonical-main-transcript-message"][data-message-id="main-1"]').waitFor();
      await page.route('**/api/projects/handoff-browser-project/messages', () => {});
      await page.locator('textarea[placeholder="Message…"]').fill('Pause before output');
      await page.locator('[data-ui="chat-send-message"]').click();
      await page.waitForFunction(() => document.body.textContent.includes('Pause before output'));
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_started', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'paused-stream', personaDriven: false, virtualSender: null }));
      await page.locator('[data-ui="chat-generic-main-stream"]').waitFor();
      const scroll = page.locator('[data-ui="chat-transcript-scroll"]');
      await scroll.evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - 120); el.dispatchEvent(new Event('scroll')); });
      const beforeFirstOutput = await scroll.evaluate(el => el.scrollTop);
      const waitForContent = text => page.waitForFunction(text => Boolean(document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]')?.textContent?.includes(text)), text);
      const waitForFrame = () => page.evaluate(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; });
      const firstContent = waitForContent('First paused response');
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_output', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'paused-stream', content: 'First paused response' }));
      await firstContent;
      await waitForFrame();
      const afterFirstOutput = await scroll.evaluate(el => el.scrollTop);
      const growthContent = waitForContent('Continued output');
      await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_output', { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'paused-stream', content: '\\n\\n' + 'Continued output '.repeat(100) }));
      await growthContent;
      await waitForFrame();
      const afterGrowth = await scroll.evaluate(el => el.scrollTop);
      return { beforeFirstOutput, afterFirstOutput, afterGrowth };
    }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.afterFirstOutput).toBe(result.beforeFirstOutput);
    expect(result.afterGrowth).toBe(result.beforeFirstOutput);
  }, 20_000);
  it('keeps the production streaming bubble pinned until the reader scrolls up', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root" style="height:100vh"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => { delete window.chatPageHandoffHarness;
          const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { ordinaryFollowUp: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));"; script.onerror = reject; window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true }); document.head.append(script); }));
        const base = { folder: 'handoff-browser-project', conversation_id: 'handoff-browser-conversation', streamKey: 'inner-scroll-stream' };
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_started', { ...base, personaDriven: false, virtualSender: null }), base);
        const first = Array.from({ length: 100 }, (_, index) => 'Streaming line ' + index).join('\\n\\n');
        await page.evaluate(([base, first]) => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content: first }), [base, first]);
        const inner = page.locator('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]');
        await inner.waitFor();
        await inner.evaluate(el => { el.style.height = '120px'; el.style.overflowY = 'auto'; });
        await page.waitForFunction(() => { const el = document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]'); return el && el.scrollHeight > el.clientHeight && el.scrollTop === el.scrollHeight - el.clientHeight; });
        const initiallyPinned = await inner.evaluate(el => el.scrollTop === el.scrollHeight - el.clientHeight);
        await inner.dispatchEvent('wheel', { deltaY: -80 });
        await inner.evaluate(el => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 80); el.dispatchEvent(new Event('scroll')); });
        const pausedTop = await inner.evaluate(el => el.scrollTop);
        const waitForContentFrame = (text) => page.evaluate((text) => {
          const { promise, resolve } = Promise.withResolvers();
          const finish = () => { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(resolve)); };
          const observer = new MutationObserver(() => { const current = document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]'); if ((current?.textContent || '').includes(text)) finish(); });
          observer.observe(document.getElementById('root'), { childList: true, subtree: true, characterData: true });
          const current = document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]');
          if ((current?.textContent || '').includes(text)) finish();
          return promise;
        }, text);
        const pausedGrowthFrame = waitForContentFrame('Reader should stay here.');
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content: '\\n\\nReader should stay here.' }), base);
        await pausedGrowthFrame;
        const afterPausedGrowth = await inner.evaluate(el => ({ top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight }));
        await inner.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight; el.dispatchEvent(new Event('scroll')); });
        const resumedFrame = waitForContentFrame('Follow resumed.');
        await page.evaluate(base => window.chatPageHandoffHarness.dispatch('chat_output', { ...base, content: '\\n\\nFollow resumed.' }), base);
        await resumedFrame;
        await page.waitForFunction(() => { const el = document.querySelector('[data-ui="chat-generic-main-stream"] [data-ui="chat-message-content"]'); return el && el.scrollTop === el.scrollHeight - el.clientHeight; });
        const resumed = await inner.evaluate(el => el.scrollTop === el.scrollHeight - el.clientHeight);
        return { initiallyPinned, pausedTop, afterPausedGrowth, resumed };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.initiallyPinned).toBe(true);
    expect(result.afterPausedGrowth.top).toBe(result.pausedTop);
    expect(result.afterPausedGrowth.top).toBeLessThan(
      result.afterPausedGrowth.bottom,
    );
    expect(result.resumed).toBe(true);
  }, 20_000);

  it('lets canonical recovery own the mounted transcript across navigation', async () => {
    let output: string;
    try {
      await cli('tab-new', harnessUrl);
      await cli('resize', '390', '844');
      output = await cli(
        'run-code',
        `async page => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root')); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        await page.locator('[data-ui="chat-generic-main-stream"]').waitFor();
        const transcriptRequestSeen = Promise.withResolvers();
        const releaseTranscript = Promise.withResolvers();
        await page.route('**/api/projects/handoff-browser-project/conversations/handoff-browser-conversation/transcript?*', async route => { transcriptRequestSeen.resolve(); await releaseTranscript.promise; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'prompt-1', type: 'message', role: 'user', content: 'Ask everyone', created_at: '2026-01-01T00:00:00.000Z', source: 'web' }, { id: 'final-1', type: 'message', role: 'assistant', content: 'Canonical completed while away', created_at: '2026-01-01T00:00:02.000Z', source: 'web' }], total: 2, hasMore: false, nextOffset: 2 }) }); });
        await page.evaluate(() => window.chatPageHandoffHarness.dispatch('chat_replay_complete', { activeConversationIds: [] }));
        await transcriptRequestSeen.promise;
        releaseTranscript.resolve();
        await page.getByText('Canonical completed while away').waitFor();
        await page.waitForFunction(() => window.chatPageHandoffHarness.streamRetired() === false);
        const recovered = { generic: await page.locator('[data-ui="chat-generic-main-stream"]').count(), canonical: await page.locator('[data-ui="chat-canonical-main-transcript-message"]').count(), retired: await page.evaluate(() => window.chatPageHandoffHarness.streamRetired()) };
        await page.evaluate(() => window.chatPageHandoffHarness.selectConversation(null));
                await page.evaluate(() => window.chatPageHandoffHarness.selectConversation('handoff-browser-conversation'));
        await page.getByText('Canonical completed while away').waitFor();
        const returned = { generic: await page.locator('[data-ui="chat-generic-main-stream"]').count(), canonical: await page.locator('[data-ui="chat-canonical-main-transcript-message"]').count(), text: await page.getByText('Canonical completed while away').count() };
        await page.route('**/api/projects/handoff-browser-project/messages', () => {});
        await page.locator('textarea[placeholder="Message…"]').fill('New prompt after recovery');
        await page.locator('[data-ui="chat-send-message"]').click();
        await page.locator('[data-ui="chat-generic-main-stream"]').waitFor();
        const pendingBeforeStarted = await page.locator('[data-ui="chat-generic-main-stream"]').count();
        return { recovered, returned, pendingBeforeStarted };
      }`,
      );
    } finally {
      if (ownsBrowserSessions) await cli('close');
    }
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.recovered).toEqual({
      generic: 0,
      canonical: 1,
      retired: false,
    });
    expect(result.returned).toEqual({ generic: 0, canonical: 1, text: 1 });
    expect(result.pendingBeforeStarted).toBe(1);
  }, 20_000);
  it('keeps stream ownership isolated through repeated project deep links and ordinary return', async () => {
    const output = await multiProjectCli(
      'run-code',
      `async page => {
        await page.setContent('<div id="root"></div>');
        await page.evaluate(() => new Promise((resolve, reject) => {
          delete window.chatPageHandoffHarness;
          const script = document.createElement('script');
          script.type = 'module';
          script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { multiProjectRoute: true }); window.dispatchEvent(new Event('chatPageHandoffReady'));";
          script.onerror = reject;
          window.addEventListener('chatPageHandoffReady', () => resolve(), { once: true });
          document.head.append(script);
        }));
        const projectA = 'handoff-browser-project-a';
        const conversationA = 'handoff-browser-conversation-a';
        const streamA = 'handoff-browser-stream-a';
        const projectB = 'handoff-browser-project-b';
        const conversationB = 'handoff-browser-conversation-b';
        const streamB = 'handoff-browser-stream-b';
        const deepLink = (project, conversation) => '/chat/' + project + '?conversationId=' + conversation;
        const transitionSamples = [];
        const waitForRoute = url => page.waitForFunction(url => Array.from(document.querySelectorAll('[data-ui="chat-route-content"]')).some(node => node.getAttribute('data-route-location') === url), url);
        const waitForSurface = project => page.waitForFunction(project => Boolean(document.querySelector('[data-ui="chat-project-surface"][data-project-id="' + project + '"]')), project);
        const snapshot = async label => ({ label, url: await page.evaluate(() => window.chatPageHandoffHarness.routeLocation()), ownership: await page.evaluate(() => window.chatPageHandoffHarness.snapshotOwnership()) });
        const navigate = async (url, project) => {
          await page.evaluate(url => {
            window.__transitionSamples = [];
            window.__transitionObserver = new MutationObserver(() => window.__transitionSamples.push({ url, ownership: window.chatPageHandoffHarness.snapshotOwnership() }));
            window.__transitionObserver.observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, characterData: true });
          }, url);
          await page.evaluate(url => window.chatPageHandoffHarness.navigate(url), url);
          await waitForRoute(url);
          await waitForSurface(project);
          transitionSamples.push(...await page.evaluate(() => { window.__transitionObserver.disconnect(); return window.__transitionSamples; }));
        };
        const snapshots = [];
        await waitForRoute(deepLink(projectA, conversationA));
        await waitForSurface(projectA);
        await page.evaluate(([folder, conversation_id, streamKey]) => window.chatPageHandoffHarness.dispatch('chat_started', { folder, conversation_id, streamKey, personaDriven: false, virtualSender: null }), [projectA, conversationA, streamA]);
        snapshots.push(await snapshot('initial-a'));
        await page.evaluate(([folder, conversation_id, streamKey]) => window.chatPageHandoffHarness.dispatch('chat_output', { folder, conversation_id, streamKey, content: 'A active response' }), [projectA, conversationA, streamA]);
        await page.locator('[data-ui="chat-generic-main-stream"]').waitFor();
        snapshots.push(await snapshot('active-a'));
        await navigate(deepLink(projectB, conversationB), projectB);
        snapshots.push(await snapshot('deep-link-b'));
        await page.evaluate(([folder, conversation_id, streamKey]) => window.chatPageHandoffHarness.dispatch('chat_started', { folder, conversation_id, streamKey, personaDriven: false, virtualSender: null }), [projectB, conversationB, streamB]);
        await page.evaluate(([folder, conversation_id, streamKey]) => window.chatPageHandoffHarness.dispatch('chat_output', { folder, conversation_id, streamKey, content: 'B active response' }), [projectB, conversationB, streamB]);
        await page.locator('[data-ui="chat-generic-main-stream"]').waitFor();
        snapshots.push(await snapshot('active-b'));
        const transcriptStarted = Promise.withResolvers();
        const transcriptRelease = Promise.withResolvers();
        await page.route('**/api/projects/' + projectB + '/conversations/' + conversationB + '/transcript*', async route => { transcriptStarted.resolve(); await transcriptRelease.promise; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ id: conversationB + '-prompt', type: 'message', role: 'user', content: 'Project B prompt', created_at: '2026-01-01T00:00:00.000Z', source: 'web' }, { id: conversationB + '-settled', type: 'message', role: 'assistant', content: 'B active response', created_at: '2026-01-01T00:00:02.000Z', source: 'web' }], total: 2, hasMore: false, nextOffset: 2 }) }); });
        await page.evaluate(([folder, conversation_id, streamKey]) => window.chatPageHandoffHarness.dispatch('chat_completed', { folder, conversation_id, streamKey }), [projectB, conversationB, streamB]);
        await transcriptStarted.promise;
        snapshots.push(await snapshot('settling-b'));
        const completedTranscript = page.waitForResponse(response => response.url().includes('/api/projects/' + projectB + '/conversations/' + conversationB + '/transcript'));
        await navigate('/chat/' + projectA, projectA);
        snapshots.push(await snapshot('ordinary-a'));
        transcriptRelease.resolve();
        await completedTranscript;
        snapshots.push(await snapshot('settled-b-while-a'));
        await page.evaluate(([folder, conversation_id, message]) => window.chatPageHandoffHarness.dispatch('chat_message', { folder, conversation_id, message }), [projectB, conversationB, { id: conversationB + '-settled', role: 'assistant', content: 'B active response', created_at: '2026-01-01T00:00:02.000Z', source: 'web' }]);
        await page.unroute('**/api/projects/' + projectB + '/conversations/' + conversationB + '/transcript*');
        await navigate(deepLink(projectB, conversationB), projectB);
        snapshots.push(await snapshot('repeated-deep-link-b'));
        return { snapshots, transitionSamples };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    const snapshots = result.snapshots;
    expect(result.transitionSamples.length).toBeGreaterThan(0);
    const expected = {
      a: {
        projectId: 'handoff-browser-project-a',
        conversationId: 'handoff-browser-conversation-a',
      },
      b: {
        projectId: 'handoff-browser-project-b',
        conversationId: 'handoff-browser-conversation-b',
      },
    };
    for (const state of snapshots) {
      const owner =
        state.label.includes('-a') || state.label === 'ordinary-a'
          ? expected.a
          : expected.b;
      expect(
        state.ownership.filter((item) => item.projectId !== owner.projectId),
        state.label,
      ).toEqual([]);
      expect(
        state.ownership.filter(
          (item) => item.conversationId !== owner.conversationId,
        ),
        state.label,
      ).toEqual([]);
    }
    for (const transition of result.transitionSamples) {
      const owner = transition.url.includes('project-a')
        ? expected.a
        : expected.b;
      expect(
        transition.ownership.filter(
          (item) => item.projectId !== owner.projectId,
        ),
        transition.url,
      ).toEqual([]);
      expect(
        transition.ownership.filter(
          (item) => item.conversationId !== owner.conversationId,
        ),
        transition.url,
      ).toEqual([]);
    }
    expect(
      snapshots.find((state) => state.label === 'active-a').ownership,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ streamKey: 'handoff-browser-stream-a' }),
      ]),
    );
    expect(
      snapshots.find((state) => state.label === 'active-b').ownership,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ streamKey: 'handoff-browser-stream-b' }),
      ]),
    );
    expect(
      snapshots
        .find((state) => state.label === 'settled-b-while-a')
        .ownership.filter(
          (item) => item.streamKey === 'handoff-browser-stream-b',
        ),
    ).toEqual([]);
    expect(snapshots.find((state) => state.label === 'ordinary-a').url).toBe(
      '/chat/handoff-browser-project-a',
    );
    expect(
      snapshots.find((state) => state.label === 'repeated-deep-link-b').url,
    ).toContain('conversationId=handoff-browser-conversation-b');
  }, 20_000);
});
