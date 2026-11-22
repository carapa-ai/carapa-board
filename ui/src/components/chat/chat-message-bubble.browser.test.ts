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
  ? await allocateBrowserTestRuntime('chat-bubble-scroll')
  : undefined;
const { port, url } = runtime ?? { port: 0, url: '' };
let vite: Bun.Subprocess;
let releaseRecordedSession: () => void = () => {};

async function cli(...args: string[]) {
  return runBrowserCli(runtime, args);
}

const describeBrowser = hasPlaywrightCli ? describe : describe.skip;

describeBrowser('ChatMessageBubble browser scrolling', () => {
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
    await cli(
      'run-code',
      `async page => {
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ url: '/src/global.css' });
      await page.addStyleTag({ content: '[data-ui="chat-message-content"] { height: 120px; overflow-y: auto; }' });
      await page.evaluate(async () => {
        const { mountChatMessageBubbleHarness } = await import('/src/components/chat/chat-message-bubble-browser-harness.tsx'); mountChatMessageBubbleHarness(document.getElementById('root'));
      });
      await page.locator('[data-ui="chat-message-content"]').waitFor();
    }`,
    );
  }, 180_000);

  // Browser shutdown awaits process exit and profile cleanup; use the same
  // lifecycle budget as the neighboring browser suites, not Bun's 5s default.
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
  }, 30_000);

  it('resumes at bottom or preserves reader position through streaming handoff', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const canonical = page.locator('[data-ui="chat-message-content"][data-message-id="canonical-message-id"]');
        await page.evaluate(() => window.chatBubbleHarness.showStreaming());
        const streaming = page.locator('[data-ui="chat-message-content"][data-message-id="stream-run-id"]');
        await streaming.waitFor();
        await settle();
        await streaming.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight; node.dispatchEvent(new Event('scroll')); });
        await page.evaluate(() => window.chatBubbleHarness.append());
        await settle();
        await page.evaluate(() => window.chatBubbleHarness.handoff());
        await canonical.waitFor();
        await settle();
        const resumed = await canonical.evaluate(node => ({ id: node.getAttribute('data-message-id'), scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));

        await page.evaluate(() => window.chatBubbleHarness.showStreaming());
        await streaming.waitFor();
        await settle();
        await streaming.dispatchEvent('wheel', { deltaY: -80 });
        await streaming.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 80; node.dispatchEvent(new Event('scroll')); });
        await page.evaluate(() => window.chatBubbleHarness.handoff());
        await canonical.waitFor();
        await settle();
        const handedOff = await canonical.evaluate(node => ({ id: node.getAttribute('data-message-id'), scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
        return { resumed, handedOff };
      }`,
    );
    const state = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(state.resumed.id).toBe('canonical-message-id');
    expect(state.resumed.scrollTop).toBe(
      state.resumed.scrollHeight - state.resumed.clientHeight,
    );
    expect(state.handedOff.id).toBe('canonical-message-id');
    expect(state.handedOff.scrollTop).toBeLessThan(
      state.handedOff.scrollHeight - state.handedOff.clientHeight,
    );
  }, 20_000);

  it('initially positions a completed message at its inner bottom', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.evaluate(() => window.chatBubbleHarness.showCompleted());
        const el = page.locator('[data-ui="chat-message-content"][data-message-id="completed-message-id"]');
        await el.waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return await el.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
      }`,
    );
    const completed = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(completed.scrollTop).toBe(
      completed.scrollHeight - completed.clientHeight,
    );
  }, 20_000);
  it('keeps separate tool rounds readable and keyboard-accessible around assistant prose', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.evaluate(() => window.chatBubbleHarness.showToolActivity('compact', true));
        const content = page.locator('[data-ui="chat-message-content"]');
        const groups = content.locator('[data-ui="tool-activity-group"]');
        await groups.nth(1).waitFor();
        const firstToggle = groups.first().locator(':scope > button');
        await firstToggle.focus();
        await firstToggle.press('Enter');
        const firstCall = groups.first().locator('[data-ui="tool-call"]');
        await firstCall.first().locator(':scope > [role="button"]').click();
        const result = firstCall.first().locator('[data-ui="tool-call-result"]');
        await result.waitFor();
        await groups.nth(1).locator(':scope > button').click();
        const failedCall = groups.nth(1).locator('[data-ui="tool-call"]');
        await failedCall.locator(':scope > [role="button"]').focus();
        await failedCall.locator(':scope > [role="button"]').press('Enter');
        const failure = failedCall.locator('[data-ui="tool-call-result"]');
        await failure.waitFor();
        return {
          groups: await groups.count(),
          firstRound: await groups.first().textContent(),
          secondRound: await groups.nth(1).textContent(),
          result: await result.textContent(),
          failure: await failure.textContent(),
          text: await content.textContent(),
        };
      }`,
    );
    const state = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(state.groups).toBe(2);
    expect(state.result).toContain('Successful output');
    expect(state.failure).toContain('Permission denied');
    expect(state.firstRound).not.toContain('Permission denied');
    expect(state.secondRound).not.toContain('Successful output');
    expect(state.text.indexOf('Successful output')).toBeLessThan(
      state.text.indexOf('The agent explains what it found'),
    );
    expect(state.text.indexOf('The agent explains what it found')).toBeLessThan(
      state.text.indexOf('Permission denied'),
    );
  }, 30_000);

  it('keeps OMP reasoning separate from an outputless tool request', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        const inspect = async display => {
          await page.evaluate(value => window.chatBubbleHarness.showOutputlessToolThinking(value), display);
          const content = page.locator('[data-ui="chat-message-content"]');
          await content.getByText('Inspecting current files for commit').waitFor();
          return {
            toolCalls: await content.locator('[data-ui="tool-call"]').count(),
            toolResults: await content.locator('[data-tool-kind="result"]').count(),
            reasoning: await content.locator('[data-ui="agent-reasoning"]').count(),
            reasoningToolKind: await content.locator('[data-ui="agent-reasoning"]').getAttribute('data-tool-kind'),
            reasoningText: (await content.locator('[data-ui="agent-reasoning"]').textContent()).trim(),
          };
        };
        return {
          compact: await inspect('compact'),
          expanded: await inspect('expanded'),
        };
      }`,
    );
    const state = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    for (const display of [state.compact, state.expanded]) {
      expect(display).toEqual({
        toolCalls: 0,
        toolResults: 0,
        reasoning: 1,
        reasoningToolKind: null,
        reasoningText: 'Inspecting current files for commit',
      });
    }
  }, 20_000);

  it('keeps provenance markers out of mobile copy and knowledge exports', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async text => { window.__markerTestCopiedText = text; },
            },
          });
          window.chatBubbleHarness.showToolActivity('compact');
        });
        const actions = page.getByTitle('Message actions');
        await actions.waitFor();
        await actions.click();
        await page.getByRole('button', { name: 'Copy Text' }).click();
        await page.waitForFunction(() => typeof window.__markerTestCopiedText === 'string');
        const copied = await page.evaluate(() => window.__markerTestCopiedText);

        let saved;
        const savePattern = '**/api/knowledge/marker-free-kb/save-message';
        const saveHandler = async route => {
          saved = route.request().postDataJSON();
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, path: 'marker-free.md' }),
          });
        };
        await page.route(savePattern, saveHandler);
        await actions.click();
        await page.getByRole('button', { name: /Marker-free KB/ }).click();
        await page.waitForFunction(() => !document.body.textContent.includes('Message Actions'));
        await page.unroute(savePattern, saveHandler);
        return { copied, saved };
      }`,
    );
    const state = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    for (const exported of [state.copied, state.saved.content]) {
      expect(exported).toContain('webFetch');
      expect(exported).toContain('7 files');
      expect(exported).not.toContain('carapa-tool');
    }
    expect(state.saved.group_folder).toBe('browser-harness-project');
  }, 30_000);
});
