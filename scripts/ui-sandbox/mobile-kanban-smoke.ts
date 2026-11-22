export {};

const uiUrl = process.env.UI_SANDBOX_URL;
const session = process.env.UI_SANDBOX_BROWSER_SESSION;
const root = process.env.UI_SANDBOX_ROOT;
const llmControlUrl = process.env.UI_SANDBOX_LLM_CONTROL_URL;
const recorded =
  process.env.CARAPA_RECORD === '1' &&
  process.env.PLAYWRIGHT_CLI_SESSION === session;

if (!uiUrl || !session || !root || !llmControlUrl) {
  throw new Error('Mobile Kanban smoke environment is incomplete');
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
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
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

await cli(['goto', `${uiUrl}/board/ui-running`]);
await cli([
  'run-code',
  `async page => {
    const taskId = 'ui-task-active';
    const stageScroll = page.locator('[data-ui="kanban-stage-scroll-region"][data-project-id="ui-running"]');
    const activeColumn = page.locator('[data-ui="kanban-column"][data-stage-id="in_progress"]');
    const activeCard = page.locator('[data-ui="kanban-card"][data-task-id="' + taskId + '"]');
    const runningMarker = activeCard.locator('[data-ui="task-running-marker"]');
    const activeListViewport = activeColumn.locator('[data-ui="kanban-card-list"] [data-slot="scroll-area-viewport"]');
    const cdp = await page.context().newCDPSession(page);

    await page.evaluate(() => {
      window.__mobileKanbanTouchStarts = [];
      document.addEventListener('touchstart', event => {
        window.__mobileKanbanTouchStarts.push({
          isTrusted: event.isTrusted,
          taskId: event.target instanceof Element
            ? event.target.closest('[data-ui="kanban-card"]')?.getAttribute('data-task-id') ?? null
            : null,
        });
      }, { capture: true });
    });
    const touchCapability = await page.evaluate(() => ({
      maxTouchPoints: navigator.maxTouchPoints,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
    }));
    if (touchCapability.maxTouchPoints < 1 || !touchCapability.coarsePointer) {
      throw new Error('Mobile Kanban smoke did not launch a touch-enabled browser context');
    }
    const touchSwipe = async (x, y, xDistance, yDistance) => {
      const touchStartCount = await page.evaluate(() => window.__mobileKanbanTouchStarts.length);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      // The first move exceeds the sensor's 5px tolerance before its delay,
      // while the full trusted gesture spans 320ms across that 250ms window.
      for (let step = 1; step <= 8; step += 1) {
        await page.waitForTimeout(40);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{
            x: x - (xDistance * step) / 8,
            y: y - (yDistance * step) / 8,
          }],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      return touchStartCount;
    };
    const assertTrustedCardTouchStart = async (touchStartCount, expectedTaskId, label) => {
      const touchStarts = await page.evaluate(() => window.__mobileKanbanTouchStarts);
      const touchStart = touchStarts[touchStartCount];
      if (!touchStart?.isTrusted || touchStart.taskId !== expectedTaskId) {
        throw new Error(label + ' did not begin with trusted touch input on draggable card ' + expectedTaskId);
      }
    };

    const trigger = activeCard.locator('[data-ui="manual-task-trigger"]');
    await trigger.waitFor({ state: 'visible' });
    await trigger.click();
    await page.waitForFunction(async id => {
      const tasks = await (await fetch('/api/projects/ui-running/tasks')).json();
      return tasks.some(task => task.id === id && task.running === true);
    }, taskId);
    await runningMarker.waitFor({ state: 'visible' });

    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => {
        const scroller = document.querySelector('[data-ui="kanban-stage-scroll-region"]');
        const column = document.querySelector('[data-ui="kanban-column"][data-stage-id="in_progress"]');
        if (!scroller || !column) return false;
        const scrollBox = scroller.getBoundingClientRect();
        const style = getComputedStyle(scroller);
        const usableWidth = scrollBox.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        // Phones size a column to the usable width minus a peek of the next one.
        const peek = usableWidth - column.getBoundingClientRect().width;
        return peek >= 24 && peek <= 56;
      }, null, { timeout: 5000 }).catch(() => { throw new Error(width + 'px column width did not settle'); });
      await stageScroll.evaluate(element => { element.scrollLeft = 0; });
      await activeColumn.evaluate(column => {
        const scroller = column.closest('[data-ui="kanban-stage-scroll-region"]');
        if (!scroller) throw new Error('Kanban stage scroll region is missing');
        const scrollBox = scroller.getBoundingClientRect();
        const columnBox = column.getBoundingClientRect();
        const paddingLeft = Number.parseFloat(getComputedStyle(scroller).paddingLeft);
        scroller.scrollLeft += columnBox.left - scrollBox.left - paddingLeft;
      });
      await page.waitForFunction(() => {
        const scroller = document.querySelector('[data-ui="kanban-stage-scroll-region"]');
        const column = document.querySelector('[data-ui="kanban-column"][data-stage-id="in_progress"]');
        if (!scroller || !column) return false;
        const scrollBox = scroller.getBoundingClientRect();
        const columnBox = column.getBoundingClientRect();
        const paddingLeft = Number.parseFloat(getComputedStyle(scroller).paddingLeft);
        return Math.abs(columnBox.left - scrollBox.left - paddingLeft) <= 1;
      }, null, { timeout: 5000 }).catch(() => { throw new Error(width + 'px active column did not align'); });

      const [scrollBox, columnBox, cardBox, markerBox, listBox] = await Promise.all([
        stageScroll.boundingBox(),
        activeColumn.boundingBox(),
        activeCard.boundingBox(),
        runningMarker.boundingBox(),
        activeListViewport.boundingBox(),
      ]);
      if (!scrollBox || !columnBox || !cardBox || !markerBox || !listBox) {
        throw new Error(width + 'px Kanban geometry is unavailable');
      }
      const scrollPadding = await stageScroll.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          left: Number.parseFloat(style.paddingLeft),
          right: Number.parseFloat(style.paddingRight),
        };
      });
      const usableLeft = scrollBox.x + scrollPadding.left;
      const usableRight = scrollBox.x + scrollBox.width - scrollPadding.right;
      const peekWidth = (usableRight - usableLeft) - columnBox.width;
      if (peekWidth < 24 || peekWidth > 56 || columnBox.x < usableLeft - 1 || columnBox.x + columnBox.width > usableRight + 1) {
        throw new Error(width + 'px expanded stage does not leave a 24-56px peek of the next column');
      }
      if (cardBox.x < listBox.x - 1 || cardBox.x + cardBox.width > listBox.x + listBox.width + 1) {
        throw new Error(width + 'px running card exceeds its list viewport');
      }
      if (markerBox.x < cardBox.x - 1 || markerBox.x + markerBox.width > cardBox.x + cardBox.width + 1 || markerBox.y < cardBox.y - 1 || markerBox.y + markerBox.height > cardBox.y + cardBox.height + 1 || markerBox.x < usableLeft - 1 || markerBox.x + markerBox.width > usableRight + 1) {
        throw new Error(width + 'px running marker is not fully visible inside its card');
      }
      const listOverflow = await activeListViewport.evaluate(element => ({
        range: element.scrollWidth - element.clientWidth,
        scrollLeft: element.scrollLeft,
      }));
      if (listOverflow.range > 1 || listOverflow.scrollLeft !== 0) {
        throw new Error(width + 'px card list has horizontal scroll range');
      }

      const outerBefore = await stageScroll.evaluate(element => element.scrollLeft);
      const touchStartCount = await touchSwipe(
        cardBox.x + cardBox.width / 2,
        cardBox.y + 24,
        160,
        0,
      );
      await assertTrustedCardTouchStart(touchStartCount, taskId, width + 'px horizontal swipe');
      await page.waitForFunction(
        previous => document.querySelector('[data-ui="kanban-stage-scroll-region"]')?.scrollLeft > previous,
        outerBefore,
        { timeout: 5000 },
      ).catch(() => { throw new Error(width + 'px horizontal card gesture did not move the stage strip'); });
      if (await activeListViewport.evaluate(element => element.scrollLeft) !== 0) {
        throw new Error(width + 'px horizontal card gesture moved the nested list');
      }
    }

    await page.setViewportSize({ width: 390, height: 640 });
    await stageScroll.evaluate(element => { element.scrollLeft = 0; });
    const backlogCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-backlog"]');
    const backlogViewport = page.locator('[data-ui="kanban-card-list"][data-stage-id="backlog"] [data-slot="scroll-area-viewport"]');
    await backlogViewport.evaluate(element => { element.scrollTop = 0; });
    const [backlogCardBox, backlogViewportBox] = await Promise.all([
      backlogCard.boundingBox(),
      backlogViewport.boundingBox(),
    ]);
    if (!backlogCardBox || !backlogViewportBox) throw new Error('Mobile backlog card geometry is unavailable');
    if (await backlogViewport.evaluate(element => element.scrollHeight - element.clientHeight) <= 0) {
      throw new Error('Mobile card list did not expose vertical overflow');
    }
    const visibleCardTop = Math.max(backlogCardBox.y, backlogViewportBox.y);
    const visibleCardBottom = Math.min(backlogCardBox.y + backlogCardBox.height, backlogViewportBox.y + backlogViewportBox.height);
    if (visibleCardBottom <= visibleCardTop) throw new Error('Mobile backlog card is outside its list viewport');
    const verticalTouchStartCount = await touchSwipe(
      backlogCardBox.x + backlogCardBox.width / 2,
      visibleCardTop + (visibleCardBottom - visibleCardTop) / 2,
      0,
      180,
    );
    await assertTrustedCardTouchStart(verticalTouchStartCount, 'ui-task-backlog', 'Vertical swipe');
    await page.waitForFunction(() => document.querySelector('[data-ui="kanban-card-list"][data-stage-id="backlog"] [data-slot="scroll-area-viewport"]')?.scrollTop > 0, null, { timeout: 5000 }).catch(() => { throw new Error('Vertical card gesture did not scroll the card list'); });
    if (await stageScroll.evaluate(element => element.scrollLeft) !== 0) {
      throw new Error('Vertical card gesture moved the outer stage strip');
    }
    const mobileTaskStatuses = await page.evaluate(async () => {
      const tasks = await (await fetch('/api/projects/ui-running/tasks')).json();
      return Object.fromEntries(tasks.map(task => [task.id, task.status]));
    });
    if (mobileTaskStatuses[taskId] !== 'in_progress' || mobileTaskStatuses['ui-task-backlog'] !== 'backlog') {
      throw new Error('Mobile card swipes were incorrectly handled as task drags');
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    const backlogColumn = page.locator('[data-ui="kanban-column"][data-stage-id="backlog"]');
    const desktopWidth = await backlogColumn.evaluate(element => element.getBoundingClientRect().width);
    if (desktopWidth < 240 || desktopWidth > 360) {
      throw new Error('Desktop expanded Kanban column left the 240-360px range');
    }
    const desktopCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-backlog"]');
    await desktopCard.hover();
    const selection = desktopCard.getByRole('checkbox', { name: 'Select Backlog task' });
    await selection.click();
    if (!await selection.isChecked()) throw new Error('Desktop card selection did not activate');
    await selection.click();
    await desktopCard.click();
    const taskDialog = page.locator('[role="dialog"]');
    await taskDialog.waitFor({ state: 'visible' });
    await taskDialog.locator('[data-slot="dialog-close"]').click();
    await taskDialog.waitFor({ state: 'hidden' });

    const questionCard = page.locator('[data-ui="kanban-card"][data-task-id="ui-task-question"]');
    const [dragBox, dropBox] = await Promise.all([desktopCard.boundingBox(), questionCard.boundingBox()]);
    if (!dragBox || !dropBox) throw new Error('Desktop drag geometry is unavailable');
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + 24);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + dragBox.width / 2 + 10, dragBox.y + 24, { steps: 2 });
    await page.mouse.move(dropBox.x + dropBox.width / 2, dropBox.y + 24, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(async () => {
      const tasks = await (await fetch('/api/projects/ui-running/tasks')).json();
      return tasks.some(task => task.id === 'ui-task-backlog' && task.status === 'question');
    }, null, { timeout: 5000 }).catch(() => { throw new Error('Desktop card drag did not move the task'); });

    await backlogColumn.getByTitle('Collapse Backlog').click();
    await page.waitForFunction(() => document.querySelector('[data-ui="kanban-column"][data-stage-id="backlog"]')?.getBoundingClientRect().width === 40);
    await backlogColumn.getByTitle('Expand Backlog').click();

    const stopResponse = await page.evaluate(async id => {
      const response = await fetch('/api/projects/ui-running/tasks/' + id + '/stop', { method: 'POST' });
      return response.status;
    }, taskId);
    if (stopResponse !== 200) throw new Error('Running task stop returned ' + stopResponse);
    await page.waitForFunction(async id => {
      const tasks = await (await fetch('/api/projects/ui-running/tasks')).json();
      return tasks.some(task => task.id === id && task.running === false);
    }, taskId);
  }`,
]);

const providerRequests = (await (
  await fetch(`${llmControlUrl}/requests`)
).json()) as Array<{ status: string; lastUserText: string }>;
const taskRequest = providerRequests.find((request) =>
  request.lastUserText.includes('Idle active task'),
);
if (taskRequest?.status !== 'aborted') {
  throw new Error('Mobile Kanban live task did not stop at the simulator');
}

console.log('Mobile Kanban UI sandbox smoke test passed.');
