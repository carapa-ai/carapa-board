import { browserIdentity } from './shared.js';

const uiUrl = process.env.UI_SANDBOX_URL;
const apiUrl = process.env.UI_SANDBOX_API_URL;
const authCookie = process.env.UI_SANDBOX_AUTH_COOKIE;
const session = process.env.UI_SANDBOX_BROWSER_SESSION;
const root = process.env.UI_SANDBOX_ROOT;
const recorded =
  process.env.CARAPA_RECORD === '1' &&
  process.env.PLAYWRIGHT_CLI_SESSION === session;
// Board-managed runs share the operator's browser session, and recorded runs
// are finalized by Board after Testing (see README); closing either here would
// end Board's session or recording early. Only a session this launcher opened
// itself is closed.
const boardManaged = browserIdentity('', process.env).managed === true;

if (!uiUrl || !apiUrl || !authCookie || !session || !root) {
  throw new Error('UI sandbox smoke environment is incomplete');
}

async function cli(args: string[]): Promise<void> {
  const child = Bun.spawn(
    ['playwright-cli', ...(recorded ? args : [`-s=${session}`, ...args])],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (
    code !== 0 ||
    stdout.includes('### Error') ||
    stderr.includes('### Error')
  ) {
    throw new Error(`playwright-cli ${args.join(' ')} failed`);
  }
}

for (const endpoint of ['/health', '/api/auth/check', '/api/config']) {
  const response = await fetch(`${apiUrl}${endpoint}`, {
    headers: endpoint === '/health' ? {} : { Cookie: authCookie },
  });
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}`);
}

const sandboxStatus = await fetch(
  `${apiUrl}/api/sandbox/status?group=ui-running`,
  { headers: { Cookie: authCookie } },
);
if (!sandboxStatus.ok)
  throw new Error(`sandbox status returned ${sandboxStatus.status}`);
const statusBody = (await sandboxStatus.json()) as Record<
  string,
  { status?: string }
>;
if (statusBody['ui-running']?.status !== 'stopped') {
  throw new Error(
    'CarapaBox stub did not return the deterministic stopped state',
  );
}

const unsupportedStart = await fetch(
  `${apiUrl}/api/sandbox/carapa-bot/start?group=ui-running`,
  {
    method: 'POST',
    headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
    body: '{}',
  },
);
const unsupportedBody = (await unsupportedStart.json()) as {
  error?: string;
};
if (
  unsupportedStart.status !== 500 ||
  !unsupportedBody.error?.includes('unavailable')
) {
  throw new Error(
    `CarapaBox lifecycle operation was not rejected as unavailable: ${JSON.stringify(unsupportedBody)}`,
  );
}

await cli(['goto', `${uiUrl}/board/ui-paused`]);
await cli([
  'run-code',
  `async page => {
    if (!await page.evaluate(() => localStorage.getItem('device_id'))) throw new Error('authenticated device key is missing');
    if (await page.getByText('Waiting for admin approval', { exact: true }).count()) throw new Error('authenticated device is not approved');
    const assertNoHorizontalOverflow = async (locator, label) => {
      const overflow = await locator.evaluate(element => element.scrollWidth - element.clientWidth);
      if (overflow > 1) throw new Error(label + ' has ' + overflow + 'px horizontal overflow');
    };
    const assertSeparatedRows = async (upper, lower, label) => {
      const [upperBox, lowerBox] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
      if (!upperBox || !lowerBox || lowerBox.y < upperBox.y + upperBox.height - 1) {
        throw new Error(label + ' rows overlap or are not vertically separated');
      }
    };
    await page.getByText('Manual trigger while paused', { exact: true }).waitFor();
    const trigger = page.locator('[data-ui="manual-task-trigger"][data-task-id="ui-task-paused-manual"]');
    await trigger.waitFor({ state: 'visible' });
    if (await trigger.getAttribute('aria-label') !== 'Run task manually') throw new Error('manual trigger marker mismatch');
    await page.goto('${uiUrl}/board/ui-running');
    await page.getByText('Completed task with history', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    const completedCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-completed"]');
    await completedCard.waitFor();
    if (await completedCard.locator('[data-ui="task-owner-badge"]').count() !== 0) throw new Error('single-user Kanban card unexpectedly rendered an owner badge for the current user');
    await assertNoHorizontalOverflow(completedCard, 'desktop Kanban card');

    // Repository-backed acceptance: drive manual completion and task diff
    // through the production API, then inspect the real task Changes tab.
    const symlinkCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-symlink-changes"]');
    await symlinkCard.waitFor();
    const completion = await page.evaluate(async () => {
      const response = await fetch('/api/projects/ui-running/tasks/ui-task-symlink-changes', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      return { status: response.status, body: await response.json() };
    });
    if (completion.status !== 200) throw new Error('dirty-checkout completion did not succeed with integration pending: ' + JSON.stringify(completion));
    const completedTask = await page.evaluate(async () => {
      const response = await fetch('/api/projects/ui-running/tasks/ui-task-symlink-changes', { credentials: 'include' });
      return { status: response.status, body: await response.json() };
    });
    if (completedTask.status !== 200 || completedTask.body.status !== 'completed') throw new Error('dirty-checkout completion did not leave the task completed: ' + JSON.stringify(completedTask));
    const completionMessages = await page.evaluate(async () => {
      const response = await fetch('/api/projects/ui-running/tasks/ui-task-symlink-changes/messages', { credentials: 'include' });
      return { status: response.status, body: await response.json() };
    });
    if (completionMessages.status !== 200 || !completionMessages.body.some(message => message.role === 'system' && /integration pending/i.test(message.content))) {
      throw new Error('completion did not record an integration pending notice: ' + JSON.stringify(completionMessages));
    }
    const taskDiffPayload = await page.evaluate(async () => {
      const response = await fetch('/api/projects/ui-running/tasks/ui-task-symlink-changes/diff', {
        credentials: 'include',
      });
      return { status: response.status, body: await response.json() };
    });
    const taskDiffLink = taskDiffPayload.body.files?.find(entry => entry.path === '.agents/skills');
    if (taskDiffPayload.status !== 200 || taskDiffLink?.kind !== 'symlink' || taskDiffLink.linkTarget !== '../tracked-dir') {
      throw new Error('production task diff omitted worktree symlink: ' + JSON.stringify(taskDiffPayload));
    }
    const completionBlocker = taskDiffPayload.body.blockers?.find(entry => entry.path === 'external-blocker');
    if (!completionBlocker || completionBlocker.kind !== 'symlink' || completionBlocker.linkTarget !== 'tracked-dir' || completionBlocker.status !== '??') {
      throw new Error('task diff omitted concrete symlink blocker: ' + JSON.stringify(taskDiffPayload));
    }

    await symlinkCard.click();
    await page.locator('[role="dialog"]').getByText('ui-task-symlink-changes', { exact: true }).waitFor();
    await page.locator('[data-ui="task-detail-tab"][data-tab="changes"]').click();
    const changesPanel = page.locator('[data-ui="task-changes-tab"][data-task-id="ui-task-symlink-changes"]');
    await changesPanel.waitFor();
    const taskLink = changesPanel.locator('[data-ui="changed-file"][data-file-path=".agents/skills"]');
    await taskLink.waitFor();
    if (await taskLink.getAttribute('data-change-type') !== 'symlink' || await taskLink.getAttribute('data-change-source') !== 'task' || await taskLink.getAttribute('data-link-target') !== '../tracked-dir') {
      throw new Error('task-attributable symlink row metadata is incomplete');
    }
    const checkoutBlocker = changesPanel.locator('[data-ui="changed-file"][data-file-path="external-blocker"]');
    await checkoutBlocker.waitFor();
    if (await checkoutBlocker.getAttribute('data-change-type') !== 'symlink' || await checkoutBlocker.getAttribute('data-change-source') !== 'default-checkout-blocker' || await checkoutBlocker.getAttribute('data-link-target') !== 'tracked-dir' || await checkoutBlocker.getAttribute('data-git-status') !== '??') {
      throw new Error('default-checkout blocker row metadata is incomplete');
    }
    await changesPanel.locator('[data-ui="default-checkout-blockers"]').waitFor();
    if (!await changesPanel.getByText(/not changes attributed to this task/i).isVisible()) {
      throw new Error('checkout blocker distinction is not visible');
    }
    await page.keyboard.press('Escape');
    await changesPanel.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('${uiUrl}/board/ui-running');
    const mobileCompletedCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-completed"]');
    await mobileCompletedCard.waitFor();
    await assertNoHorizontalOverflow(mobileCompletedCard, 'mobile Kanban card');
    await page.goto('${uiUrl}/chat/ui-chat?conversationId=ui-conversation-pending');
    await page.locator('[data-ui="chat-conversation-title"]').filter({ hasText: 'Pending implementation plan' }).waitFor();
    if (await page.locator('[data-ui="open-file-preview-body"]').count()) throw new Error('historical plan was auto-opened during transcript hydration');
    if (await page.locator('[data-ui="chat-files-changes-panel"]').count()) throw new Error('historical plan opened the artifacts panel');
    if (await page.locator('[data-ui="composer-open-file-context"]').count()) throw new Error('composer rendered stale open-file context chrome');
    if (await page.getByText('Restore open file context', { exact: true }).count()) throw new Error('composer rendered the removed restore control');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('${uiUrl}/chat/ui-chat?conversationId=ui-conversation-pending');
    await page.locator('[data-ui="chat-conversation-title"]').filter({ hasText: 'Pending implementation plan' }).waitFor();
    if (await page.locator('[data-ui="open-file-preview-body"]').count()) throw new Error('mobile hydration opened a historical plan preview');
    await page.locator('[data-ui="header-workspace-toggle"]').click();
    const mobilePanel = page.locator('[data-ui="chat-files-changes-panel"]');
    // The panel tabs and body render in the persistent surface, a fixed overlay
    // aligned to the marker element rather than a DOM descendant of it.
    const workspaceSurface = page.locator('[data-ui="persistent-workspace-surface"]');
    await mobilePanel.waitFor({ state: 'visible' });
    // Artifacts are a section of the Files explorer: search from Files and open
    // the hit listed under the Artifacts source. Scoped by source id because the
    // Group folder section also lists the same files.
    const openSeededArtifact = async name => {
      await workspaceSurface.getByRole('tab', { name: 'Files', exact: true }).click();
      const fileSearch = workspaceSurface.getByPlaceholder('Search files', { exact: true });
      await fileSearch.fill(name);
      await fileSearch.press('Enter');
      await workspaceSurface.locator('[data-ui="file-explorer-file"][data-source-id="ui-chat:artifacts"][data-path="reports/' + name + '"]').click();
    };
    await openSeededArtifact('fixture-report.md');
    await page.locator('[data-ui="open-file-preview-body"]').waitFor();
    if (await page.locator('[data-ui="composer-open-file-context"]').count()) throw new Error('composer rendered open-file context chrome while previewing an artifact');
    await workspaceSurface.getByRole('button', { name: 'Close fixture-report.md', exact: true }).click();
    // Closing the last preview keeps the workspace open on Files, with exactly one explorer.
    if (await workspaceSurface.locator('[data-ui="file-explorer"]:visible').count() !== 1) throw new Error('closing the mobile preview did not leave exactly one file explorer');
    await workspaceSurface.getByTitle('Hide panel').click();
    await mobilePanel.waitFor({ state: 'hidden' });
    if (!await page.locator('[data-ui="chat-transcript-scroll"]').isVisible()) throw new Error('closing the mobile panel did not return to chat');

    // Exercise the production Chat/Kanban composition boundary. The pane is
    // mounted by the real routes, and the Kanban Changes request proves the
    // production null-conversation path reaches the shared main tree.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      localStorage.setItem('artifactsPanelOpenByProject', JSON.stringify({ 'ui-chat': true }));
      localStorage.setItem('artifactsPanelWidth', '512');
    });
    await page.goto('${uiUrl}/chat/ui-chat?conversationId=ui-conversation-pinned');
    await page.locator('[data-ui="chat-project-surface"]').waitFor();
    const chatPane = page.locator('[data-ui="chat-files-changes-panel"]');
    await chatPane.waitFor({ state: 'visible' });
    if ((await chatPane.evaluate(element => getComputedStyle(element).width)) !== '512px') throw new Error('Chat did not restore the persisted pane width');

    // Keep the selected top-level view as the pane crosses the real route
    // boundary. This intentionally uses the production ChatPage,
    // BoardPage, ProjectWorkspacePane, and ConversationExplorer composition.
    const assertSelectedWorkspaceTab = async (pane, name) => {
      const tab = pane.getByRole('tab', { name, exact: true });
      await tab.waitFor();
      const selected = await tab.getAttribute('aria-selected');
      const state = await tab.getAttribute('data-state');
      if (selected !== 'true' && state !== 'active') throw new Error(name + ' is not the selected workspace view (aria-selected=' + selected + ', data-state=' + state + ')');
    };
    await workspaceSurface.getByRole('tab', { name: 'Files', exact: true }).click();
    await assertSelectedWorkspaceTab(workspaceSurface, 'Files');

    await page.locator('[data-ui="project-mode-switcher"][data-display="desktop"] [aria-label^="Kanban mode"]').click();
    await page.locator('[data-ui="kanban-content"]').waitFor();
    const kanbanPane = page.locator('[data-ui="kanban-workspace-pane"]');
    await kanbanPane.waitFor({ state: 'visible' });
    if ((await kanbanPane.evaluate(element => getComputedStyle(element).width)) !== '512px') throw new Error('Kanban did not restore the persisted pane width');
    await assertSelectedWorkspaceTab(workspaceSurface, 'Files');

    // Kanban must use the main checkout even though the selected Changes view
    // originated in Chat. Capture the request before selecting the tab so the
    // assertion observes the destination route's context.
    const changesRequest = page.waitForRequest(request => request.url().includes('/api/projects/ui-chat/diff'));
    await workspaceSurface.getByRole('tab', { name: 'Changes', exact: true }).click();
    await changesRequest;
    await assertSelectedWorkspaceTab(workspaceSurface, 'Changes');

    // Chat restores Changes, but its active worktree conversation supplies a
    // conversation-scoped request. The selected view survives the remount;
    // only the Changes data context changes with the destination route.
    const conversationChangesRequest = page.waitForRequest(request => request.url().includes('/api/projects/ui-chat/conversations/ui-conversation-pinned/diff'));
    await page.locator('[data-ui="project-mode-switcher"][data-display="desktop"] [aria-label^="Chat mode"]').click();
    const returnedChatPane = page.locator('[data-ui="chat-files-changes-panel"]');
    await returnedChatPane.waitFor({ state: 'visible' });
    await assertSelectedWorkspaceTab(workspaceSurface, 'Changes');
    await conversationChangesRequest;

    // Exercise Bash persistence as well, then open a real artifact preview.
    await workspaceSurface.getByRole('tab', { name: 'Bash', exact: true }).click();
    await assertSelectedWorkspaceTab(workspaceSurface, 'Bash');
    await page.locator('[data-ui="project-mode-switcher"][data-display="desktop"] [aria-label^="Kanban mode"]').click();
    const bashKanbanPane = page.locator('[data-ui="kanban-workspace-pane"]');
    await bashKanbanPane.waitFor({ state: 'visible' });
    await assertSelectedWorkspaceTab(workspaceSurface, 'Bash');

    await openSeededArtifact('fixture-report.md');
    await page.locator('[data-ui="open-file-preview-body"]').waitFor();
    const activePreviewPath = page.locator('[data-ui="open-file-preview-body"]');
    if (await activePreviewPath.count() !== 1) throw new Error('Explicit artifact opening did not activate a preview');
    await page.locator('[data-ui="project-mode-switcher"][data-display="desktop"] [aria-label^="Chat mode"]').click();
    const previewChatPane = page.locator('[data-ui="chat-files-changes-panel"]');
    await previewChatPane.waitFor({ state: 'visible' });
    await page.locator('[data-ui="open-file-preview-body"]').waitFor();
    if (!await workspaceSurface.getByRole('button', { name: 'Close fixture-report.md', exact: true }).isVisible()) throw new Error('Active preview tab did not survive Chat/Kanban switching');
    // Selecting another file explicitly must jump back to Preview. Closing
    // the last tab returns to the explorer view selected before it (Files).
    await workspaceSurface.getByRole('tab', { name: 'Files', exact: true }).click();
    const secondFileSearch = workspaceSurface.getByPlaceholder('Search files', { exact: true });
    await secondFileSearch.fill('fixture-data.json');
    await secondFileSearch.press('Enter');
    const explicitFile = workspaceSurface.locator('[data-ui="file-explorer-file"][data-source-id="ui-chat:group"][data-path="artifacts/reports/fixture-data.json"]');
    await explicitFile.waitFor();
    await explicitFile.click();
    await page.locator('[data-ui="open-file-preview-body"]').waitFor();
    await workspaceSurface.getByRole('button', { name: 'Close fixture-data.json', exact: true }).click();
    await workspaceSurface.getByRole('button', { name: 'Close fixture-report.md', exact: true }).click();
    await assertSelectedWorkspaceTab(workspaceSurface, 'Files');

    if ((await returnedChatPane.evaluate(element => getComputedStyle(element).width)) !== '512px') throw new Error('Chat did not retain the pane width after returning from Kanban');

    // A real editable preview must block the production Kanban toggle once it
    // becomes dirty, then allow the close after the discard decision.
    await page.goto('${uiUrl}/board/ui-chat');
    const dirtyKanbanPane = page.locator('[data-ui="kanban-workspace-pane"]');
    await dirtyKanbanPane.waitFor({ state: 'visible' });
    await openSeededArtifact('fixture-report.md');
    await page.locator('[data-ui="open-file-preview-body"]').waitFor();
    await page.getByRole('button', { name: 'Edit file' }).click();
    const dirtyEditor = page.getByRole('textbox', { name: /Edit fixture-report\.md/ });
    await dirtyEditor.fill('# Dirty smoke fixture');
    // The discard prompt is the in-app confirm dialog, not a native dialog.
    const discardConfirm = page.locator('[data-ui="confirm-dialog"]');
    await workspaceSurface.getByTitle('Hide panel').click();
    await discardConfirm.waitFor();
    if (await discardConfirm.getByRole('heading').textContent() !== 'Discard unsaved file changes?') throw new Error('Dirty production preview did not prompt before hiding');
    await page.locator('[data-ui="confirm-dialog-cancel"]').click();
    await discardConfirm.waitFor({ state: 'hidden' });
    await dirtyKanbanPane.waitFor({ state: 'visible' });
    await workspaceSurface.getByTitle('Hide panel').click();
    await discardConfirm.waitFor();
    await page.locator('[data-ui="confirm-dialog-confirm"]').click();
    await dirtyKanbanPane.waitFor({ state: 'hidden' });
    await page.locator('[data-ui="header-workspace-toggle"]').click();
    await dirtyKanbanPane.waitFor({ state: 'visible' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('${uiUrl}/board/ui-chat');
    await page.locator('[data-ui="kanban-content"]').waitFor();
    if (await page.locator('[data-ui="kanban-workspace-pane"]').count()) throw new Error('Narrow Kanban restored the desktop pane preference');
    await page.locator('[data-ui="header-workspace-toggle"]').click();
    const narrowKanbanPane = page.locator('[data-ui="kanban-workspace-pane"]');
    await narrowKanbanPane.waitFor({ state: 'visible' });
    if (await narrowKanbanPane.evaluate(element => getComputedStyle(element).position) !== 'absolute') throw new Error('Narrow Kanban pane is not a full-surface overlay');

    await page.goto('${uiUrl}/objective/ui-objectives/ui-objective-active');
    await page.locator('[data-ui="chat-project-surface"]').waitFor();
    if (await page.locator('[data-ui="objective-workspace-pane"]').count()) throw new Error('Narrow Objective mode restored the desktop pane preference');
    await page.locator('[data-ui="header-workspace-toggle"]').click();
    const narrowObjectivePane = page.locator('[data-ui="objective-workspace-pane"]');
    await narrowObjectivePane.waitFor({ state: 'visible' });
    if (await narrowObjectivePane.evaluate(element => getComputedStyle(element).position) !== 'absolute') throw new Error('Narrow Objective pane is not a full-surface overlay');
    await narrowObjectivePane.getByRole('tab', { name: 'Dashboard', exact: true }).waitFor();
    // Changes only exists for repository-backed projects; ui-objectives has none.
    const objectiveEventsTab = narrowObjectivePane.getByRole('tab', { name: 'Events', exact: true });
    await objectiveEventsTab.click();
    if (await objectiveEventsTab.getAttribute('aria-selected') !== 'true') throw new Error('Narrow Objective tabs are not navigable');
    await narrowObjectivePane.getByRole('tab', { name: 'Dashboard', exact: true }).click();
    await narrowObjectivePane.getByLabel('Hide objective workspace').click();
    await narrowObjectivePane.waitFor({ state: 'hidden' });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('${uiUrl}/board/ui-running');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLegacyCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-backlog"]');
    await mobileLegacyCard.waitFor();
    await assertNoHorizontalOverflow(mobileLegacyCard, 'mobile legacy Kanban card');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('${uiUrl}/chat/ui-chat');

    const pinnedRow = page.locator('[data-ui="conversation-list-item"][data-conversation-id="ui-conversation-pinned"]');
    const legacyRow = page.locator('[data-ui="conversation-list-item"][data-conversation-id="ui-conversation-unread"]');

    await page.setViewportSize({ width: 1280, height: 900 });
    await pinnedRow.waitFor();
    await assertNoHorizontalOverflow(page.locator('[data-ui="conversations-list"]'), 'desktop conversation sidebar');
    await pinnedRow.click();
    await page.locator('[data-ui="chat-owner-badge"][data-conversation-id="ui-conversation-pinned"]').waitFor();
    const desktopNameRow = page.locator('[data-ui="chat-conversation-name-row"]');
    const desktopAttributionRow = page.locator('[data-ui="chat-attribution-row"]');
    await assertSeparatedRows(desktopNameRow, desktopAttributionRow, 'desktop chat name/attribution');
    // The pane preference persists, so the toggle may read Open or Close.
    if (!await page.locator('[data-ui="header-workspace-toggle"]').isVisible()) throw new Error('desktop folder control is unreachable');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('${uiUrl}/chat/ui-chat?conversationId=ui-conversation-pinned');
    const mobileNameRow = page.locator('[data-ui="chat-conversation-name-row"]');
    const mobileAttributionRow = page.locator('[data-ui="chat-attribution-row"]');
    const mobileTechnicalRow = page.locator('[data-ui="chat-technical-metadata-row"]');
    await mobileAttributionRow.waitFor();
    await mobileTechnicalRow.waitFor();
    await assertSeparatedRows(mobileNameRow, mobileAttributionRow, 'mobile chat name/attribution');
    await assertSeparatedRows(mobileAttributionRow, mobileTechnicalRow, 'mobile chat attribution/technical metadata');
    await assertNoHorizontalOverflow(page.locator('html'), 'mobile chat page');
    const mobileTitleBox = await page.locator('[data-ui="chat-conversation-title"]').boundingBox();
    if (!mobileTitleBox || mobileTitleBox.width < 200) throw new Error('mobile conversation name was squeezed by metadata');
    if (!(await mobileTechnicalRow.textContent())?.includes('session:')) throw new Error('mobile session metadata is unreachable');
    if (!(await mobileTechnicalRow.textContent())?.includes('tokens')) throw new Error('mobile token metadata is unreachable');
    const chatOwner = page.locator('[data-ui="chat-owner-badge"][data-conversation-id="ui-conversation-pinned"]');
    const chatTrigger = page.locator('[data-ui="chat-trigger-badge"][data-conversation-id="ui-conversation-pinned"]');
    if (!await chatOwner.getAttribute('title') || !await chatTrigger.getAttribute('title')) throw new Error('mobile chat attribution lost full-value titles');
    if (!await page.getByTitle('Show conversations').isVisible()) throw new Error('mobile conversation control is unreachable');
    await page.getByTitle('Show conversations').click();
    await legacyRow.waitFor();
    await assertNoHorizontalOverflow(page.locator('[data-ui="conversations-list"]'), 'mobile conversation sidebar');
    if (!await pinnedRow.getByLabel('Conversation actions').isVisible()) throw new Error('conversation menu is unreachable beside attribution');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('${uiUrl}/board/ui-running?taskId=ui-task-completed');
    const taskDialog = page.locator('[role="dialog"]');
    await taskDialog.waitFor();
    const taskHeader = taskDialog.locator('[data-ui="task-detail-header"]');
    if (await taskHeader.locator('[data-ui="task-detail-owner-badge"], [data-ui="task-detail-trigger-badge"]').count()) throw new Error('desktop task header contains attribution');
    const detailAttribution = taskDialog.locator('[data-ui="task-detail-attribution"]');
    await page.getByRole('tab', { name: 'Details', exact: true }).click();
    await detailAttribution.waitFor();
    if (!await detailAttribution.locator('[data-ui="task-detail-owner-badge"]').isVisible()) throw new Error('task owner is missing from Details');
    if (!await detailAttribution.locator('[data-ui="task-detail-trigger-badge"]').isVisible()) throw new Error('task triggerer is missing from Details');
    const detailsTab = taskDialog.locator('[data-ui="task-detail-tab"][data-tab="details"]');
    if (await detailsTab.getAttribute('aria-selected') !== 'true') throw new Error('Details tab did not become active');
    const aiEdit = taskDialog.getByRole('button', { name: 'AI edit', exact: true });
    await aiEdit.waitFor({ state: 'visible' });
    await aiEdit.click();
    await taskDialog.locator('[data-ui="task-ai-description"]').waitFor({ state: 'visible' });
    await taskDialog.locator('[data-ui="task-ai-description-input"]').waitFor({ state: 'visible' });
    await taskDialog.locator('[data-ui="task-ai-description"]').getByRole('button', { name: 'Close AI edit panel' }).click();
    await page.getByRole('tab', { name: /^Run History/ }).click();
    if (await detailAttribution.isVisible()) throw new Error('task attribution is visible outside Details');
    await page.getByRole('tab', { name: 'Details', exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(taskDialog, 'mobile task dialog');
    if (await taskHeader.locator('[data-ui="task-detail-owner-badge"], [data-ui="task-detail-trigger-badge"]').count()) throw new Error('mobile task header contains attribution');
    if (!await detailAttribution.isVisible()) throw new Error('mobile task attribution is missing from Details');
    if (!await taskDialog.getByText('View Task', { exact: true }).isVisible()) throw new Error('mobile task heading is obscured');
    await taskDialog.locator('[data-slot="dialog-close"]').click();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('${uiUrl}/board/ui-chat');
    const scheduled = page.locator('[data-ui="scheduled-task-card"]').filter({ hasText: 'Summarize new UI feedback.' });
    await scheduled.waitFor({ state: 'visible' });
    const boardDetailsTrigger = scheduled.locator('[data-ui="scheduled-task-details-trigger"]');
    await boardDetailsTrigger.focus();
    await boardDetailsTrigger.press('Enter');
    const scheduledDialog = page.locator('[data-ui="scheduled-task-details-dialog"]');
    await scheduledDialog.waitFor();
    await scheduledDialog.getByLabel('Prompt', { exact: true }).waitFor();
    await scheduledDialog.getByLabel('Schedule type', { exact: true }).waitFor();
    await scheduledDialog.getByLabel('Schedule value', { exact: true }).waitFor();
    await scheduledDialog.getByLabel('Context mode', { exact: true }).waitFor();
    await scheduledDialog.locator('[data-slot="dialog-close"]').click();
    await scheduledDialog.waitFor({ state: 'hidden' });
    await page.waitForTimeout(50);
    if (await scheduledDialog.isVisible()) throw new Error('board dialog reopened after close');
    await scheduled.click();
    await scheduledDialog.waitFor();
    const save = page.locator('[data-ui="scheduled-task-save"]');
    if (!await save.isDisabled()) throw new Error('clean scheduled-task draft must not be saveable');
    const cadence = page.locator('[data-ui="scheduled-task-schedule-value"]');
    await cadence.fill('not a cron');
    await page.getByText('Use a valid cron expression.', { exact: true }).waitFor();
    if (!await save.isDisabled()) throw new Error('invalid cron must disable save');
    await cadence.fill('0 8 * * *');
    await page.locator('[data-ui="scheduled-task-prompt"]').fill('Unsaved scheduled draft');
    await page.locator('[data-ui="scheduled-task-status"]').click();
    if (await save.isDisabled()) throw new Error('dirty scheduled-task draft must be saveable');
    await scheduledDialog.locator('[data-slot="dialog-close"]').click();
    await scheduled.click();
    await scheduledDialog.waitFor();
    if (await page.locator('[data-ui="scheduled-task-prompt"]').inputValue() !== 'Summarize new UI feedback.') throw new Error('reopening retained an unsaved prompt draft');
    if (await page.locator('[data-ui="scheduled-task-status"]').textContent() !== 'Resume') throw new Error('reopening retained an unsaved status draft');
    await page.locator('[data-ui="scheduled-task-prompt"]').fill('Summarize updated UI feedback.');
    await save.click();
    await page.getByText('Summarize updated UI feedback.', { exact: true }).waitFor();
    const revealScheduledTask = async taskId => {
      const toggle = page.locator('[data-ui="scheduled-tasks-sidebar-toggle"]');
      await toggle.waitFor({ state: 'visible' });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const row = page.locator('[data-ui="scheduled-task-sidebar-row"][data-task-id="' + taskId + '"]');
      await row.waitFor({ state: 'visible' });
      return row;
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('${uiUrl}/chat/ui-chat');
    await page.getByTitle('Show conversations').click();
    const completedOnceTask = await revealScheduledTask('ui-scheduled-completed-once');
    const completedOnceDetail = page.waitForResponse(response => response.url().endsWith('/api/projects/ui-chat/scheduled-tasks/ui-scheduled-completed-once') && response.ok());
    await completedOnceTask.locator('[data-ui="scheduled-task-details-trigger"]').click();
    await completedOnceDetail;
    const completedOnceValue = page.locator('[data-ui="scheduled-task-schedule-value"]');
    const historicalOnceValue = await completedOnceValue.inputValue();
    await page.locator('[data-ui="scheduled-task-prompt"]').fill('Updated completed one-off task.');
    if (await page.locator('[data-ui="scheduled-task-save"]').isDisabled()) throw new Error('completed one-off non-cadence edit was blocked by its historical timestamp');
    await completedOnceValue.fill('2020-01-01T00:00:00.000Z');
    await page.getByText('Use a future ISO timestamp.', { exact: true }).waitFor();
    if (!await page.locator('[data-ui="scheduled-task-save"]').isDisabled()) throw new Error('changed one-off cadence accepted a past timestamp');
    await completedOnceValue.fill(historicalOnceValue);
    await page.locator('[data-ui="scheduled-task-save"]').click();
    await page.getByText('Updated completed one-off task.', { exact: true }).waitFor();
    await page.locator('[data-slot="dialog-close"]').click();
    await scheduledDialog.waitFor({ state: 'hidden' });
    await page.goto('${uiUrl}/chat/ui-chat');
    await page.getByTitle('Show conversations').click();
    const targetRow = await revealScheduledTask('ui-scheduled-chat');
    const quickStatus = targetRow.locator('[data-ui="scheduled-task-sidebar-status"]');
    await quickStatus.focus();
    await quickStatus.press('Space');
    if (await page.locator('[data-ui="scheduled-task-details-dialog"]').isVisible()) throw new Error('keyboard sidebar quick status opened details');
    await targetRow.getByLabel('Pause scheduled task').waitFor();
    await targetRow.getByLabel('Pause scheduled task').click();
    await targetRow.getByLabel('Resume scheduled task').waitFor();
    await page.getByText('Summarize updated UI feedback.', { exact: true }).click();
    await page.locator('[data-ui="scheduled-task-details-dialog"]').waitFor();
    await page.locator('[data-ui="scheduled-task-runs-tab"]').click();
    const completedRun = page.locator('[data-ui="scheduled-task-run-history-entry"]').filter({ hasText: 'Scheduled fixture completed.' });
    await completedRun.waitFor();
    const transcriptToggle = completedRun.locator('button[aria-controls]');
    if (await transcriptToggle.getAttribute('aria-expanded') !== 'false') throw new Error('collapsed transcript toggle did not expose aria-expanded=false');
    const transcriptRegionId = await transcriptToggle.getAttribute('aria-controls');
    if (!transcriptRegionId) throw new Error('transcript toggle did not expose aria-controls');
    await transcriptToggle.click();
    if (await transcriptToggle.getAttribute('aria-expanded') !== 'true') throw new Error('expanded transcript toggle did not expose aria-expanded=true');
    await page.locator('#' + transcriptRegionId).waitFor();
    const userTranscriptBubbles = completedRun.locator('[data-ui="scheduled-task-transcript-message"][data-role="user"]').filter({ hasText: 'Summarize new UI feedback.' });
    await userTranscriptBubbles.first().waitFor();
    if (await userTranscriptBubbles.count() < 1) throw new Error('expanded run did not show a user transcript bubble');
    const assistantTranscriptBubbles = completedRun.locator('[data-ui="scheduled-task-transcript-message"][data-role="assistant"]').filter({ hasText: 'No blocking feedback was found.' });
    await assistantTranscriptBubbles.first().waitFor();
    if (await assistantTranscriptBubbles.count() < 1) throw new Error('expanded run did not show an assistant transcript bubble');
    await page.getByText('Transcript unavailable', { exact: true }).waitFor();
    await page.locator('[data-slot="dialog-close"]').click();
    await scheduledDialog.waitFor({ state: 'hidden' });
    await page.goto('${uiUrl}/chat/ui-chat');
    await page.getByTitle('Show conversations').click();
    const emptyTask = await revealScheduledTask('ui-scheduled-empty');
    await emptyTask.click();
    await page.locator('[data-ui="scheduled-task-runs-tab"]').click();
    await page.getByText('No runs yet.', { exact: true }).waitFor();
    await page.locator('[data-slot="dialog-close"]').click();
    await scheduledDialog.waitFor({ state: 'hidden' });
    await page.goto('${uiUrl}/chat/ui-chat');
    await page.getByTitle('Show conversations').click();
    const runningTask = await revealScheduledTask('ui-scheduled-running-state');

    await page.route('**/api/projects/ui-chat/scheduled-tasks/ui-scheduled-running-state/runs', async route => {
      await page.waitForTimeout(400);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'running-ui', runId: 'running-ui', runAt: new Date().toISOString(), durationMs: null, status: 'running', result: null, error: null, model: 'fixture', modelName: 'fixture', tokTotal: null, costUsd: null, transcriptAvailable: false }]) });
    });
    await runningTask.click();
    await page.locator('[data-ui="scheduled-task-runs-tab"]').click();
    await page.getByText('Loading runs…', { exact: true }).waitFor();
    await page.locator('[data-ui="scheduled-task-details-tab"]').click();
    await page.locator('[data-ui="scheduled-task-running-lock"]').waitFor();
    if (!await page.locator('[data-ui="scheduled-task-save"]').isDisabled()) throw new Error('running task save was not locked');
    await page.locator('[data-slot="dialog-close"]').click();
    await scheduledDialog.waitFor({ state: 'hidden' });
    await page.goto('${uiUrl}/chat/ui-chat');
    await page.getByTitle('Show conversations').click();
    const errorTask = await revealScheduledTask('ui-scheduled-error-state');

    await page.route('**/api/projects/ui-chat/scheduled-tasks/ui-scheduled-error-state/runs', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture failure' }) }));
    await errorTask.click();
    await page.locator('[data-ui="scheduled-task-runs-tab"]').click();
    await page.getByText('Unable to load runs.', { exact: true }).waitFor();
    await page.goto('${uiUrl}/objectives/ui-objectives');
    await page.getByText('Improve onboarding', { exact: true }).waitFor();
  }`,
]);
if (!recorded && !boardManaged) await cli(['close']);
