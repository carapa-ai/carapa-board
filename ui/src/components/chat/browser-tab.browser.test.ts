// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  allocateBrowserTestRuntime,
  runBrowserCli,
  waitForViteReady,
} from '../../test-utils/browser-runtime';
const runtime = await allocateBrowserTestRuntime('live-browser-pane');
let vite: Bun.Subprocess;
const cli = (...args: string[]) => runBrowserCli(runtime, args);
describe('embedded upstream agent browser', () => {
  beforeAll(async () => {
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
        String(runtime.port),
        '--strictPort',
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    await waitForViteReady(vite);
    await cli('open', runtime.url);
  }, 120000);
  afterAll(async () => {
    try {
      if (!runtime.recorded) await cli('close');
    } finally {
      vite?.kill();
      await vite?.exited;
      runtime.cleanup();
    }
  });
  it('loads trusted assets in its iframe, shares navigation and input', async () => {
    const result = await cli(
      'run-code',
      `async page => {
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const messages = []; let attachments = 0; const waiters = [];
      const waitForMessage = predicate => messages.some(predicate) ? Promise.resolve() : new Promise(resolve => waiters.push({predicate, resolve}));
      await page.route('**/api/projects/browser-project/browser/sessions?*', route => route.fulfill({json:{sessions:[
        {sessionId:'run-one',scope:'conversation',runId:null,projectId:'browser-project',conversationId:'chat',agentName:'Test agent',worktree:'/workspace/app'},
        {sessionId:'run-two',scope:'run',runId:'run-two',projectId:'browser-project',taskId:'task',agentName:'Other agent'}
      ]}}));
      await page.route('**/api/projects/browser-project/browser/viewers', route => route.fulfill({json:{viewerId:'viewer-' + (++attachments)}}));
      await page.route('**/api/ws-ticket', route => route.fulfill({json:{ticket:'one-use-ticket'}}));
      await page.evaluate(() => { document.body.innerHTML='<main style="font:24px system-ui;color:#0f172a;padding:60px;background:#eff6ff;min-height:100vh"><h1>Local application</h1><p>Running inside the agent sandbox</p><input placeholder="Shared browser input"><button>Save</button></main>'; });
      const jpeg = await page.screenshot({type:'jpeg'});
      await page.routeWebSocket('**/api/browser/ws?*', socket => {
        if (!socket.url().includes('ticket=one-use-ticket')) throw new Error('Missing connection ticket');
        socket.onMessage(raw => {
          const message = JSON.parse(raw); messages.push(message);
          for (const waiter of waiters.splice(0)) { if (waiter.predicate(message)) waiter.resolve(); else waiters.push(waiter); }
          socket.send(JSON.stringify({id:message.id,result:{}}));
        });
        socket.send(JSON.stringify({method:'sessions',params:{sessions:[{title:'Agent session',browser:{guid:'browser',browserName:'chromium',launchOptions:{}}}],clientInfo:{}}}));
        socket.send(JSON.stringify({method:'tabs',params:{tabs:[{browser:'browser',context:'context',page:'page',title:'Local app',url:'http://localhost:3000/',selected:true}]}}));
        socket.send(JSON.stringify({method:'frame',params:{data:jpeg.toString('base64'),viewportWidth:1280,viewportHeight:720}}));
      });
      await page.evaluate(() => { document.body.innerHTML='<div id="browser-root"></div>'; });
      await page.evaluate(async () => { const module=await import('/src/components/chat/browser-tab-browser-harness.tsx'); module.mountBrowserHarness(document.getElementById('browser-root')); });
      const frame = page.frameLocator('iframe[title="Agent browser"]');
      await page.locator('[data-ui=browser-connection-state]').filter({hasText:'connected'}).waitFor();
      await frame.getByTitle('Disable interactive mode', {exact:true}).waitFor();
      await frame.locator('.screen').click({position:{x:120,y:90}});
      await frame.locator('.screen').press('a');
      const address = frame.locator('.omnibox');
      await address.fill('http://nginx:8082/'); await address.press('Enter');
      await Promise.all([
        waitForMessage(message => message.method==='mousedown'),
        waitForMessage(message => message.method==='keydown'),
        waitForMessage(message => message.method==='navigate' && message.params.url==='http://nginx:8082/'),
      ]);
      if (await frame.getByTitle('Record video', {exact:true}).isVisible()) throw new Error('Recording control is exposed');
      if (await frame.getByTitle('Close session', {exact:true}).isVisible()) throw new Error('Session lifecycle is exposed');
      if (errors.length) throw new Error(errors.join('; '));
      return {attachments,methods:messages.map(message=>message.method)};
    }`,
    );
    expect(result).toContain('navigate');
  }, 45000);
});
