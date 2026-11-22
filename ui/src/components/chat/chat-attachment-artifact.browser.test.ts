// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  acquireRecordedSession,
  allocateBrowserTestRuntime,
  runBrowserCli,
  waitForViteReady,
} from '../../test-utils/browser-runtime';

const hasPlaywrightCli = Bun.which('playwright-cli') !== null;
const runtime = hasPlaywrightCli
  ? await allocateBrowserTestRuntime('chat-attachment-artifact')
  : undefined;
const { port, url } = runtime ?? { port: 0, url: '' };
const harnessUrl = `${url}/chat-page-handoff-harness.html`;
const session = runtime?.session ?? '';
let vite: Bun.Subprocess;
let releaseRecordedSession: () => void = () => {};
const describeBrowser = hasPlaywrightCli ? describe : describe.skip;

const cli = (...args: string[]) => runBrowserCli(runtime, args);

async function mount(page: string) {
  return `await ${page}.setContent('<div id="root"></div>'); await ${page}.evaluate(() => { const script = document.createElement('script'); script.type = 'module'; script.textContent = "import { mountChatPageHandoffHarness } from '/src/components/chat/chat-page-handoff-browser-harness.tsx'; window.chatPageHandoffHarness = await mountChatPageHandoffHarness(document.getElementById('root'), { initialEmptyConversation: true });"; document.head.append(script); }); await ${page}.locator('textarea[placeholder="Message…"]').waitFor();`;
}

describeBrowser('mounted ChatPage initial attachment submission', () => {
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
    await cli('open', harnessUrl);
    await cli('resize', '390', '844');
  }, 180_000);

  afterAll(async () => {
    if (!runtime.recorded) {
      try {
        await cli('close');
      } catch {}
    }
    vite?.kill();
    await vite?.exited;
    runtime.cleanup();
    releaseRecordedSession();
  }, 30_000);

  it('creates before upload, forwards the ID, and dispatches through ChatPage', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        const calls = [];
        const uploadBodies = [];
        const messageBodies = [];
        const createGate = Promise.withResolvers();
        const uploadGate = Promise.withResolvers();
        let createCompleted = false;
        let uploadBeforeCreateCompletion = false;
        const uploadRequest = Promise.withResolvers();
        await page.route('**/api/projects/handoff-browser-project/conversations', async route => {
          if (route.request().method() !== 'POST') return route.continue();
          calls.push('create');
          await createGate.promise;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'created-browser-conversation', title: 'Created', status: 'idle' }) });
          createCompleted = true;
        });
        await page.route('**/api/projects/handoff-browser-project/upload', async route => {
          calls.push('upload'); uploadBodies.push(route.request().postDataJSON());
          uploadBeforeCreateCompletion ||= !createCompleted;
          uploadRequest.resolve();
          await uploadGate.promise;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ containerPath: '/workspace/group/uploads/package.json', browserUrl: '/api/projects/handoff-browser-project/attachments/package.json', originalName: 'package.json', absolutePath: '/workspace/group/uploads/package.json' }) });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', async route => {
          calls.push('message'); const body = route.request().postDataJSON(); messageBodies.push(body);
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ conversation_id: 'created-browser-conversation', delivery: 'queued', userMessage: { id: 'created-message', role: 'user', content: body.content } }) });
        });
        ${await mount('page')}
        await page.locator('textarea[placeholder="Message…"]').fill('Initial browser prompt');
        await page.locator('input[type="file"][multiple]').setInputFiles('package.json');
        const createRequest = page.waitForRequest(request => request.url().endsWith('/api/projects/handoff-browser-project/conversations'));
        const createResponse = page.waitForResponse(response => response.url().endsWith('/api/projects/handoff-browser-project/conversations'));
        const messageRequest = page.waitForRequest(request => request.url().endsWith('/api/projects/handoff-browser-project/messages'));
        await page.locator('[data-ui="chat-send-message"]').click();
        await createRequest;
        await Promise.resolve();
        const uploadBeforeCreateGate = uploadBodies.length;
        createGate.resolve();
        await createResponse;
        await uploadRequest.promise;
        const messageBeforeUploadGate = messageBodies.length;
        uploadGate.resolve();
        await messageRequest;
        const result = { calls, uploadBodies, messageBodies, uploadBeforeCreateGate, messageBeforeUploadGate, uploadBeforeCreateCompletion };
        await page.unroute('**/api/projects/handoff-browser-project/conversations'); await page.unroute('**/api/projects/handoff-browser-project/upload'); await page.unroute('**/api/projects/handoff-browser-project/messages');
        return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.calls).toEqual(['create', 'upload', 'message']);
    expect(result.uploadBeforeCreateGate).toBe(0);
    expect(result.messageBeforeUploadGate).toBe(0);
    expect(result.uploadBeforeCreateCompletion).toBe(false);
    expect(result.uploadBodies[0].conversation_id).toBe(
      'created-browser-conversation',
    );
    expect(result.messageBodies[0].conversation_id).toBe(
      'created-browser-conversation',
    );
    expect(result.messageBodies[0].content).toContain(
      '/workspace/group/uploads/package.json',
    );
    expect(result.messageBodies[0].attachments[0]).toMatchObject({
      filename: 'package.json',
      path: '/workspace/group/uploads/package.json',
    });
  }, 20_000);

  it('restores draft and attachment exactly once when creation fails without dispatching', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        let messageRequests = 0;
        await page.route('**/api/projects/handoff-browser-project/conversations', async route => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Create unavailable' }) });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', route => { messageRequests += 1; return route.abort(); });
        ${await mount('page')}
        await page.locator('textarea[placeholder="Message…"]').fill('Keep initial draft');
        await page.locator('input[type="file"][multiple]').setInputFiles('package.json');
        await page.locator('[data-ui="chat-send-message"]').click();
        await page.waitForFunction(() => document.querySelector('textarea[placeholder="Message…"]')?.value === 'Keep initial draft');
        const result = { draft: await page.locator('textarea[placeholder="Message…"]').inputValue(), attachmentChips: await page.getByText('package.json', { exact: true }).count(), messageRequests };
        await page.unroute('**/api/projects/handoff-browser-project/conversations'); await page.unroute('**/api/projects/handoff-browser-project/messages');
        return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result).toEqual({
      draft: 'Keep initial draft',
      attachmentChips: 1,
      messageRequests: 0,
    });
  }, 20_000);
  it('restores draft and attachment when initial upload fails after creation without dispatching', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        const calls = [];
        const uploadBodies = [];
        let messageRequests = 0;
        await page.route('**/api/projects/handoff-browser-project/conversations', async route => {
          if (route.request().method() !== 'POST') return route.continue();
          calls.push('create');
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'created-upload-failure-conversation', title: 'Created', status: 'idle' }) });
        });
        await page.route('**/api/projects/handoff-browser-project/upload', async route => {
          calls.push('upload'); uploadBodies.push(route.request().postDataJSON());
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Upload unavailable' }) });
        });
        await page.route('**/api/projects/handoff-browser-project/messages', route => { calls.push('message'); messageRequests += 1; return route.abort(); });
        ${await mount('page')}
        await page.locator('textarea[placeholder="Message…"]').fill('Keep upload-failed draft');
        await page.locator('input[type="file"][multiple]').setInputFiles('package.json');
        await page.locator('[data-ui="chat-send-message"]').click();
        await page.waitForFunction(() => document.querySelector('textarea[placeholder="Message…"]')?.value === 'Keep upload-failed draft');
        const result = {
          calls,
          uploadBodies,
          draft: await page.locator('textarea[placeholder="Message…"]').inputValue(),
          attachmentChips: await page.getByText('package.json', { exact: true }).count(),
          messageRequests,
        };
        await page.unroute('**/api/projects/handoff-browser-project/conversations'); await page.unroute('**/api/projects/handoff-browser-project/upload'); await page.unroute('**/api/projects/handoff-browser-project/messages');
        return result;
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.calls).toEqual(['create', 'upload']);
    expect(result.uploadBodies[0].conversation_id).toBe(
      'created-upload-failure-conversation',
    );
    expect(result.draft).toBe('Keep upload-failed draft');
    expect(result.attachmentChips).toBe(1);
    expect(result.messageRequests).toBe(0);
  }, 20_000);
});
