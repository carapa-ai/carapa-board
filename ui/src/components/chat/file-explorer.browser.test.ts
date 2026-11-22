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
  ? await allocateBrowserTestRuntime('artifact-explorer')
  : undefined;
const { port, url } = runtime ?? { port: 0, url: '' };
let vite: Bun.Subprocess;
let releaseRecordedSession: () => void = () => {};
const browser = hasPlaywrightCli ? describe : describe.skip;

async function cli(...args: string[]) {
  return runBrowserCli(runtime, args);
}

browser('File explorer browser behavior', () => {
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
  it('mounts the local editor with file, permission, Markdown, dictation, sensitive, and conflict boundaries', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        let stage='navigate';
        try {
        await page.goto('${url}');
        await page.evaluate(() => { document.body.innerHTML='<div id="editor-root"></div>'; });
        await page.evaluate(async () => {
          const module = await import('/src/components/chat/file-editor-browser-harness.tsx');
          module.mountFileEditorHarness(document.getElementById('editor-root'));
        });
        stage='harness mount'; await page.waitForFunction(() => !!window.fileEditorHarness);
        const fixture=await page.evaluate(() => window.fileEditorHarness.state());
        if (fixture.source !== 'group' || fixture.mimetype !== 'text/markdown') throw new Error('Invalid editor fixture: '+JSON.stringify(fixture));
        const editButton=page.getByRole('button',{name:'Edit file'}); await editButton.waitFor(); await editButton.click();
        const editor=page.locator('[data-ui=file-preview-editor][data-source=group][data-path="one.md"]'); await editor.waitFor();
        stage='authoritative load'; await page.waitForFunction(() => window.fileEditorHarness.calls().includes('load:one.md'));
        const toolbar=page.locator('[data-ui=file-editor-toolbar]'); await toolbar.waitFor();
        const modes=page.locator('[data-ui=file-editor-markdown-mode]');
        if (await modes.count() !== 3) throw new Error('Markdown mode controls missing');
        if (await page.locator('[data-ui=file-editor-markdown-mode][data-mode=edit]').getAttribute('aria-pressed') !== 'true') throw new Error('Edit mode was not selected');
        for (const mode of ['edit', 'preview', 'split']) { const control=page.locator('[data-ui=file-editor-markdown-mode][data-mode=' + mode + ']'); const title=await control.getAttribute('title'); const label=await control.getAttribute('aria-label'); if (!title || title !== label) throw new Error('Mismatched accessible metadata for ' + mode + ': ' + title + ' / ' + label); }
        if (await toolbar.locator('[data-ui=file-editor-save]').getAttribute('aria-label') !== 'Save' || await toolbar.locator('[data-ui=file-editor-cancel]').getAttribute('aria-label') !== 'Cancel') throw new Error('Save/Cancel controls missing');
        const area=page.getByRole('textbox',{name:'Edit one.md'}); await area.waitFor();
        await page.waitForFunction(() => window.fileEditorHarness.context()?.context?.line === 1);
        const initialContext=await page.evaluate(() => window.fileEditorHarness.context());
        await area.fill('# Draft');
        await page.getByRole('button',{name:'Cancel'}).click();
        const discardDialog=page.locator('[data-ui=confirm-dialog]'); await discardDialog.waitFor();
        const confirmMessage=await discardDialog.getByRole('heading').textContent();
        if (confirmMessage !== 'Discard unsaved file changes?') throw new Error('Dirty confirmation was not requested');
        await page.locator('[data-ui=confirm-dialog-cancel]').click(); await discardDialog.waitFor({state:'hidden'});
        const dirtyProtected=await area.isVisible();
        if (!dirtyProtected) throw new Error('Dirty Cancel unexpectedly left Edit mode');
        await page.setViewportSize({width:1200,height:700});
        const desktop=await page.evaluate(() => ({width:innerWidth, matches:matchMedia('(min-width: 768px)').matches}));
        if (!desktop.matches) throw new Error('Desktop media query not active: '+JSON.stringify(desktop));
        const split=page.getByRole('button',{name:'Split'}); await split.waitFor({state:'visible'}); await split.click();
        if (await page.locator('[data-ui=file-editor-markdown-mode][data-mode=split]').getAttribute('aria-pressed') !== 'true') throw new Error('Split mode was not selected');
        const rendered=await page.locator('[data-ui=file-editor-markdown-preview]').textContent();
        await page.setViewportSize({width:390,height:700});
        stage='narrow split coercion'; await page.waitForFunction(() => !document.querySelector('[data-ui=file-editor-markdown-preview]'));
        await page.setViewportSize({width:1200,height:700});
        await split.waitFor({state:'visible'}); await split.click();
        await page.locator('[data-ui=file-editor-dictation]').click();
        const splitDictation=await page.locator('[data-ui=file-editor-dictation]').getAttribute('aria-pressed');
        await area.evaluate(async textarea => {
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          const module=await import('/src/components/chat/preview-pane.tsx');
          module.insertTextAtTextareaSelection(textarea, ' dictated');
          textarea.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:' dictated'}));
        });
        stage='dictation preview'; await page.waitForFunction(() => document.querySelector('[data-ui=file-editor-markdown-preview]')?.textContent?.includes('Draft dictated'));
        const dictatedPreview=await page.locator('[data-ui=file-editor-markdown-preview]').textContent();
        await page.evaluate(() => window.fileEditorHarness.delaySave(true));
        await page.getByRole('button',{name:'Save'}).click();
        stage='delayed save request'; await page.waitForFunction(() => window.fileEditorHarness.calls().includes('save:one.md:# Draft dictated'));
        await area.fill('# Typed during save');
        await page.evaluate(() => window.fileEditorHarness.releaseSave());
        await page.getByText('Unsaved',{exact:true}).waitFor();
        stage='dirty after delayed save'; await page.waitForFunction(() => !document.querySelector('button:disabled svg.lucide-save'));
        const typedDuringSave=await area.inputValue();
        await area.evaluate(textarea => {
          textarea.focus();
          textarea.setSelectionRange(2,7);
          textarea.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Shift'}));
        });
        await page.getByText('Ln 1, Col 3 – Ln 1, Col 8').waitFor();
        const selectionCoordinates=await page.getByText('Ln 1, Col 3 – Ln 1, Col 8').textContent();
        const selectedContext=await page.evaluate(() => window.fileEditorHarness.context());
        await page.getByRole('button',{name:'Preview'}).click();
        const previewContext=await page.evaluate(() => window.fileEditorHarness.context());
        stage='dictation release'; await page.waitForFunction(() => document.querySelector('[data-ui=file-editor-dictation]')?.getAttribute('aria-pressed') === 'false');
        const stopped=await page.locator('[data-ui=file-editor-dictation]').getAttribute('aria-pressed');
        const previewDictationDisabled=await page.locator('[data-ui=file-editor-dictation]').isDisabled();
        await page.getByRole('button',{name:'Edit'}).click();
        await page.evaluate(() => window.fileEditorHarness.setPath('two.md')); await discardDialog.waitFor();
        await page.locator('[data-ui=confirm-dialog-cancel]').click(); await discardDialog.waitFor({state:'hidden'});
        if (await page.evaluate(() => window.fileEditorHarness.state().path) !== 'one.md') throw new Error('Rejected switch left the file');
        const rejectedSwitchDraft=await page.getByRole('textbox',{name:'Edit one.md'}).inputValue();
        await page.evaluate(() => window.fileEditorHarness.setPath('two.md')); await discardDialog.waitFor(); await page.locator('[data-ui=confirm-dialog-confirm]').click(); await page.waitForFunction(() => window.fileEditorHarness.state().path === 'two.md');
        await page.getByRole('button',{name:'Edit file'}).click();
        const second=await page.getByRole('textbox',{name:'Edit two.md'}).inputValue();
        await page.evaluate(() => window.fileEditorHarness.setPath('.env')); await page.waitForFunction(() => window.fileEditorHarness.state().path === '.env'); await page.getByRole('button',{name:'Edit file'}).click();
        const reveal=page.getByRole('button',{name:'Reveal'}); await reveal.waitFor();
        const concealed=await reveal.isVisible(); const noTextarea=await page.getByRole('textbox',{name:'Edit .env'}).count();
        const concealedContext=await page.evaluate(() => window.fileEditorHarness.context());
        const concealedDictationDisabled=await page.locator('[data-ui=file-editor-dictation]').isDisabled();
        await reveal.click(); await page.getByRole('button',{name:'Cancel'}).click();
        await page.evaluate(() => { window.fileEditorHarness.setRole('editor'); window.fileEditorHarness.setPath('one.md'); }); await page.waitForFunction(() => window.fileEditorHarness.state().path === 'one.md');
        const editorButton=await page.getByRole('button',{name:'Edit file'}).count();
        await page.evaluate(() => window.fileEditorHarness.setPath('repo.md')); await page.waitForFunction(() => window.fileEditorHarness.state().path === 'repo.md');
        const repoButton=await page.getByRole('button',{name:'Edit file'}).count();
        await page.evaluate(() => { window.fileEditorHarness.setRole('admin'); window.fileEditorHarness.setPath('one.md'); window.fileEditorHarness.conflict(true); }); await page.waitForFunction(() => window.fileEditorHarness.state().path === 'one.md');
        await page.getByRole('button',{name:'Edit file'}).click(); const conflictArea=page.getByRole('textbox',{name:'Edit one.md'}); await conflictArea.fill('# Conflict'); await page.getByRole('button',{name:/Save/}).click();
        await page.getByRole('button',{name:'Reload latest'}).waitFor();
        const reload=await page.getByRole('button',{name:'Reload latest'}).count(); const cancel=page.locator('[data-ui="file-editor-cancel"]'); if (await cancel.count() && await cancel.isVisible()) { await cancel.click(); await discardDialog.waitFor(); await page.locator('[data-ui=confirm-dialog-confirm]').click(); } return {initialContext,selectedContext,previewContext,concealedContext,dirtyProtected,confirmMessage,rendered,splitDictation,dictatedPreview,typedDuringSave,selectionCoordinates,stopped,previewDictationDisabled,rejectedSwitchDraft,second,concealed,noTextarea,concealedDictationDisabled,editorButton,repoButton,reload};
        } catch (error) { throw new Error('Editor stage '+stage+': '+error.message); }
      }`,
    );
    const resultMatch = output.match(/### Result\n(.*)\n/);
    if (!resultMatch)
      throw new Error(`Editor browser result missing:\n${output}`);
    expect(JSON.parse(resultMatch[1])).toEqual({
      initialContext: {
        key: 'project:one.md',
        conversationId: null,
        context: {
          source: 'group',
          path: 'one.md',
          line: 1,
          column: 1,
          revision: '1'.repeat(64),
          unsavedChanges: false,
        },
      },
      selectedContext: {
        key: 'project:one.md',
        conversationId: null,
        context: {
          source: 'group',
          path: 'one.md',
          line: 1,
          column: 3,
          selection: {
            start: { line: 1, column: 3 },
            end: { line: 1, column: 8 },
          },
          revision: 'a'.repeat(64),
          unsavedChanges: true,
        },
      },
      previewContext: {
        key: 'project:one.md',
        conversationId: null,
        context: {
          source: 'group',
          path: 'one.md',
          line: 1,
          column: 3,
          selection: {
            start: { line: 1, column: 3 },
            end: { line: 1, column: 8 },
          },
          revision: 'a'.repeat(64),
          unsavedChanges: true,
        },
      },
      concealedContext: {
        key: 'project:.env',
        conversationId: null,
        context: {
          source: 'group',
          path: '.env',
          revision: '3'.repeat(64),
          unsavedChanges: false,
        },
      },
      dirtyProtected: true,
      confirmMessage: 'Discard unsaved file changes?',
      rendered: 'Draft',
      splitDictation: 'true',
      dictatedPreview: 'Draft dictated',
      typedDuringSave: '# Typed during save',
      selectionCoordinates: 'Ln 1, Col 3 – Ln 1, Col 8',
      stopped: 'false',
      previewDictationDisabled: true,
      rejectedSwitchDraft: '# Typed during save',
      second: '# Two',
      concealed: true,
      noTextarea: 0,
      concealedDictationDisabled: true,
      editorButton: 0,
      repoButton: 0,
      reload: 1,
    });
  }, 40000);

  it('renders Repo and Group sources in objective and conversation contexts', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.setContent('<link rel="stylesheet" href="/src/global.css"><div id="root"></div>'); await page.evaluate(() => { delete window.artifactExplorerHarness; document.documentElement.classList.remove('dark'); }); await page.evaluate(async () => { const module = await import('/src/components/chat/file-explorer-browser-harness.tsx'); module.mountArtifactExplorerHarness(document.getElementById('root')); }); await page.waitForFunction(() => !!window.artifactExplorerHarness); await page.locator('[data-ui=explorer-context]').waitFor(); await page.evaluate(() => window.artifactExplorerHarness.reset());
        await page.evaluate(() => window.artifactExplorerHarness.show('files', 'objective'));
        const context = page.locator('[data-ui="explorer-context"][data-context="objective"][data-consumer="files"]');
        await context.evaluate(el => { el.style.width = '260px'; });
        await page.setViewportSize({ width: 390, height: 700 });
        await page.getByRole('button', { name: 'Grid view' }).click();
        const repo = page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path=""]');
        await repo.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path="src"]').click();
        const repoFile = page.locator('[data-ui="file-explorer-file"][data-source-id="browser-project:repo:main"]').first();
        await repoFile.waitFor();
        const contextualBack = page.locator('[data-ui="file-explorer-contextual-back"]:visible');
        if (await contextualBack.getAttribute('data-action') !== 'parent-folder' || await contextualBack.getAttribute('data-state') !== 'nested') throw new Error('Nested Repo back control metadata was incorrect');
        const drag = await repoFile.evaluate(el => { const data = new DataTransfer(); el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data })); return data.getData('text/plain'); });
        if (!drag.startsWith('@src/')) throw new Error('Repo drag reference was not preserved');
        await repoFile.click();
        if (!(await page.evaluate(() => window.artifactExplorerHarness.previewPath()))?.startsWith('src/')) throw new Error('Repo preview did not open');
        await contextualBack.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path="src"]').waitFor();
        if (await contextualBack.getAttribute('data-action') !== 'source-chooser' || await contextualBack.getAttribute('data-state') !== 'source-root' || await contextualBack.isDisabled()) throw new Error('Root Repo back control did not target the source chooser');
        if (await page.getByRole('button', { name: 'Sources', exact: true }).count() !== 0) throw new Error('Standalone Sources control remained');
        await contextualBack.click();
        await repo.waitFor();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path=""]').click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path="notes"]').click();
        const groupFile = page.locator('[data-ui="file-explorer-file"][data-source-id="browser-project:group"]').first();
        await groupFile.waitFor();
        const groupBack = page.locator('[data-ui="file-explorer-contextual-back"]:visible');
        await groupBack.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path="notes"]').waitFor();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path="notes"]').click();
        await groupFile.waitFor();
        await context.evaluate(el => { el.style.width = '760px'; });

        await page.evaluate(() => window.artifactExplorerHarness.show('files', 'conversation'));
        const conversation = page.locator('[data-ui="explorer-context"][data-context="conversation"][data-consumer="files"]');
        await conversation.evaluate(el => { el.style.width = '760px'; });
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path=""]').waitFor();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path=""]').waitFor();

        await page.getByRole('button', { name: 'List view' }).click();
        const listRepo = page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path=""]');
        await listRepo.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path="src"]').click();
        await page.locator('[data-ui="file-explorer-file"][data-source-id="browser-project:repo:main"]').first().waitFor();
        const listBack = page.locator('[data-ui="file-explorer-contextual-back"]:visible');
        if (await listBack.getAttribute('data-action') !== 'parent-folder' || await listBack.getAttribute('data-state') !== 'nested') throw new Error('List-view nested Repo back control metadata was incorrect');
        await listBack.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path="src"]').waitFor();
        if (await listBack.getAttribute('data-action') !== 'source-chooser' || await listBack.getAttribute('data-state') !== 'source-root' || await listBack.isDisabled()) throw new Error('List-view root Repo back control did not target the source chooser');
        await listBack.click();
        await listRepo.waitFor();
        if (await page.getByRole('button', { name: 'Sources', exact: true }).count() !== 0) throw new Error('Standalone Sources control remained in List view');

        return await page.evaluate(() => window.artifactExplorerHarness.calls());
      }`,
    );
    const calls = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(calls).toContain('repo-list:');
    expect(calls).toContain('repo-list:src');
    expect(calls).toContain('group-list:');
    expect(calls).toContain('group-list:notes');
  }, 40000);

  it('keeps native Repo file drags bounded to copy and reusable after cancellation', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        await page.setContent('<link rel="stylesheet" href="/src/global.css"><div id="root"></div><div data-ui="native-file-drop-target" style="position:fixed;right:0;top:0;z-index:100;width:120px;height:120px"></div>');
        await page.evaluate(() => { delete window.artifactExplorerHarness; document.documentElement.classList.remove('dark'); });
        await page.evaluate(async () => {
          const module = await import('/src/components/chat/file-explorer-browser-harness.tsx');
          module.mountArtifactExplorerHarness(document.getElementById('root'));
        });
        await page.waitForFunction(() => !!window.artifactExplorerHarness);
        await page.locator('[data-ui="explorer-context"]').waitFor();
        await page.evaluate(() => window.artifactExplorerHarness.reset());
        await page.evaluate(() => window.artifactExplorerHarness.show('files', 'conversation'));
        await page.getByRole('button', { name: 'Tree view' }).click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path=""]').click();
        const repoFolder = page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path="src"]');
        await repoFolder.click();
        const repoFile = page.locator('[data-ui="file-explorer-file"][data-source-id="browser-project:repo:main"][data-path="src/second-file.ts"]');
        await repoFile.waitFor();

        await page.evaluate(() => {
          window.nativeFileDragEvidence = { starts: [], ends: 0, drops: [] };
          const target = document.querySelector('[data-ui="native-file-drop-target"]');
          document.addEventListener('dragstart', event => {
            window.nativeFileDragEvidence.starts.push({
              effectAllowed: event.dataTransfer.effectAllowed,
              path: event.dataTransfer.getData('application/x-carapa-file'),
              text: event.dataTransfer.getData('text/plain'),
            });
          });
          document.addEventListener('dragend', () => {
            window.nativeFileDragEvidence.ends += 1;
          });
          target.addEventListener('dragover', event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          });
          target.addEventListener('drop', event => {
            event.preventDefault();
            window.nativeFileDragEvidence.drops.push({
              path: event.dataTransfer.getData('application/x-carapa-file'),
              text: event.dataTransfer.getData('text/plain'),
            });
          });
        });

        const beginDrag = async () => {
          const box = await repoFile.boundingBox();
          if (!box) throw new Error('Repo file had no drag bounds');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 - 10, box.y + box.height / 2, { steps: 4 });
        };
        const targetBox = await page.locator('[data-ui="native-file-drop-target"]').boundingBox();
        if (!targetBox) throw new Error('Drop target had no bounds');

        await beginDrag();
        await page.mouse.move(targetBox.x + 20, targetBox.y + 20, { steps: 12 });
        await page.mouse.up();

        await beginDrag();
        await page.keyboard.press('Escape');
        await page.mouse.up();

        await beginDrag();
        await page.mouse.move(5, 690, { steps: 12 });
        await page.mouse.up();

        await beginDrag();
        await page.mouse.move(targetBox.x + 20, targetBox.y + 20, { steps: 12 });
        await page.mouse.up();

        const search = page.getByRole('textbox', { name: 'Search files' });
        await search.fill('still responsive');
        if (await search.inputValue() !== 'still responsive') throw new Error('Typing did not recover after native drags');
        await search.fill('');
        await repoFolder.click();
        await repoFolder.click();
        await repoFile.waitFor();
        await repoFile.click();
        const previewPath = await page.evaluate(() => window.artifactExplorerHarness.previewPath());
        return {
          evidence: await page.evaluate(() => window.nativeFileDragEvidence),
          previewPath,
        };
      }`,
    );
    const result = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(result.evidence.starts).toEqual(
      Array.from({ length: 4 }, () => ({
        effectAllowed: 'copy',
        path: 'src/second-file.ts',
        text: '@src/second-file.ts',
      })),
    );
    expect(result.evidence.ends).toBe(4);
    expect(result.evidence.drops).toEqual(
      Array.from({ length: 2 }, () => ({
        path: 'src/second-file.ts',
        text: '@src/second-file.ts',
      })),
    );
    expect(result.previewPath).toBe('src/second-file.ts');
  }, 40000);

  it('previews Repo and Group images from browsing and search results', async () => {
    const output = await cli(
      'run-code',
      `async page => {
        // A new document disposes roots/portals mounted by earlier editor and explorer scenarios.
        await page.route('**/file-explorer-image-harness.html', async route => {
          const response = await route.fetch();
          await route.fulfill({ response, body: (await response.text()).replace('<script type="module" src="/src/main.tsx"></script>', '') });
        });
        await page.goto(${JSON.stringify(url + '/file-explorer-image-harness.html')});
        await page.route('**/api/projects/browser-project/files/*/content?*', route => route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>',
        }));
        await page.setContent('<link rel="stylesheet" href="/src/global.css"><div id="root"></div>'); await page.evaluate(() => { delete window.artifactExplorerHarness; document.documentElement.classList.remove('dark'); }); await page.evaluate(async () => { const module = await import('/src/components/chat/file-explorer-browser-harness.tsx'); module.mountArtifactExplorerHarness(document.getElementById('root')); }); await page.waitForFunction(() => !!window.artifactExplorerHarness); await page.locator('[data-ui=explorer-context]').waitFor(); await page.evaluate(() => window.artifactExplorerHarness.reset());
        await page.evaluate(() => window.artifactExplorerHarness.show('files', 'objective'));
        const root = page.locator('[data-ui="explorer-context"][data-consumer="files"]');
        await root.waitFor();
        await page.getByRole('button', { name: 'Grid view' }).click();

        const assertPreview = async (entry, expectedEndpoint, expectedFilePath) => {
          await entry.waitFor();
          const thumbnail = entry.locator('img');
          const thumbnailSrc = await thumbnail.getAttribute('src');
          const thumbnailPath = decodeURIComponent(thumbnailSrc?.match(/[?&]path=([^&]*)/)?.[1] ?? '');
          if (!thumbnailSrc?.includes(expectedEndpoint) || thumbnailPath !== expectedFilePath || !thumbnailSrc.includes('thumbnail=1')) throw new Error('Grid thumbnail did not use the thumbnail endpoint');
          await page.mouse.move(0, 0);
          await page.waitForFunction(() => !document.querySelector('[data-ui="image-hover-preview"]'));
          await entry.locator('[data-ui="image-hover-preview-trigger"]').hover();
          const popup = page.locator('[data-ui="image-hover-preview"]').last();
          await popup.locator('img').filter({ visible: true }).waitFor();
          await page.waitForFunction(({ expectedEndpoint, expectedFilePath }) => {
            const src = [...document.querySelectorAll('[data-ui="image-hover-preview"] img')].at(-1)?.getAttribute('src');
            return src?.includes(expectedEndpoint) && new URL(src, location.href).searchParams.get('path') === expectedFilePath;
          }, { expectedEndpoint, expectedFilePath });
          const popupSrc = await popup.locator('img').getAttribute('src');
          const popupPath = decodeURIComponent(popupSrc?.match(/[?&]path=([^&]*)/)?.[1] ?? '');
          if (!popupSrc?.includes(expectedEndpoint) || popupPath !== expectedFilePath || popupSrc.includes('thumbnail=1')) throw new Error('Image hover preview did not use the full-content URL: ' + popupSrc + ' endpoint=' + expectedEndpoint + ' path=' + popupPath + ' expectedPath=' + expectedFilePath + ' hasThumbnail=' + popupSrc?.includes('thumbnail=1'));
          return { thumbnailSrc, popupSrc, thumbnailPath, popupPath };
        };

        const repoRoot = page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path=""]');
        await repoRoot.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:repo:main"][data-path="src"]').click();
        const repoPreview = await assertPreview(page.locator('[data-ui="file-explorer-file"][data-path="src/preview-image.png"]'), '/api/projects/browser-project/files/repo/content', 'src/preview-image.png');

        await page.locator('[data-ui="file-explorer-contextual-back"]:visible').click();
        await page.locator('[data-ui="file-explorer-contextual-back"]:visible').click();
        const groupRoot = page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path=""]');
        await groupRoot.click();
        await page.locator('[data-ui="file-explorer-folder"][data-source-id="browser-project:group"][data-path="notes"]').click();
        const groupPreview = await assertPreview(page.locator('[data-ui="file-explorer-file"][data-path="notes/preview-image.png"]'), '/api/projects/browser-project/files/group/content', 'notes/preview-image.png');

        const search = page.getByRole('textbox', { name: 'Search files' });
        await search.fill('image');
        await page.getByRole('button', { name: 'Search' }).click();
        const repoSearchPreview = await assertPreview(page.locator('[data-ui="file-explorer-file"][data-path="src/repo-search-image.png"]'), '/api/projects/browser-project/files/repo/content', 'src/repo-search-image.png');
        const groupSearchPreview = await assertPreview(page.locator('[data-ui="file-explorer-file"][data-path="notes/group-search-image.png"]'), '/api/projects/browser-project/files/group/content', 'notes/group-search-image.png');

        await page.getByRole('button', { name: 'Clear' }).click();
        await page.locator('[data-ui="file-explorer-file"][data-path="notes/preview-image.png"]').waitFor();
        await page.locator('[data-ui="file-explorer-file"][data-path="notes/preview-image.png"] [data-ui="image-hover-preview-trigger"]').hover();
        await page.locator('[data-ui="image-hover-preview"]').waitFor();
        return { repoPreview, groupPreview, repoSearchPreview, groupSearchPreview, imagePreviewCount: await page.locator('[data-ui="image-hover-preview"]').count(), nonImagePreviewCount: await page.locator('[data-ui="file-explorer-file"][data-path="notes/second-file.ts"] [data-ui="image-hover-preview-trigger"]').count() };
      }`,
    );
    const evidence = JSON.parse(output.match(/### Result\n(.*)\n/)![1]);
    expect(evidence.repoPreview.thumbnailPath).toBe('src/preview-image.png');
    expect(evidence.groupPreview.thumbnailPath).toBe('notes/preview-image.png');
    expect(evidence.repoSearchPreview.thumbnailPath).toBe(
      'src/repo-search-image.png',
    );
    expect(evidence.groupSearchPreview.thumbnailPath).toBe(
      'notes/group-search-image.png',
    );
    expect(evidence.imagePreviewCount).toBeGreaterThan(0);
    expect(evidence.nonImagePreviewCount).toBe(0);
  }, 40000);
});
