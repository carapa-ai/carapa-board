export {};

const uiUrl = process.env.UI_SANDBOX_URL;
const apiUrl = process.env.UI_SANDBOX_API_URL;
const authCookie = process.env.UI_SANDBOX_AUTH_COOKIE;
const session = process.env.UI_SANDBOX_BROWSER_SESSION;
const root = process.env.UI_SANDBOX_ROOT;
const llmControlUrl = process.env.UI_SANDBOX_LLM_CONTROL_URL;
const recorded =
  process.env.CARAPA_RECORD === '1' &&
  process.env.PLAYWRIGHT_CLI_SESSION === session;

if (!uiUrl || !apiUrl || !authCookie || !session || !root || !llmControlUrl) {
  throw new Error('Manual overflow smoke environment is incomplete');
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

async function waitForCondition(
  description: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

type ProviderRequest = {
  id: number;
  status: string;
  lastUserText: string;
};

async function providerRequests(): Promise<ProviderRequest[]> {
  const response = await fetch(`${llmControlUrl}/requests`);
  if (!response.ok) {
    throw new Error(`LLM simulator returned ${response.status}`);
  }
  return (await response.json()) as ProviderRequest[];
}

for (const status of ['paused', 'running']) {
  const response = await fetch(`${apiUrl}/api/projects/ui-running`, {
    method: 'PATCH',
    headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { status } }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not set ui-running ${status}: ${await response.text()}`,
    );
  }
}

await waitForCondition(
  'two automatic task runs to fill configured capacity',
  async () =>
    (await providerRequests()).filter(
      (request) => request.status === 'connected',
    ).length === 2,
);

await cli(['goto', `${uiUrl}/board/ui-running`]);
await cli([
  'run-code',
  `async page => {
    const taskState = async () => page.evaluate(async () => (await (await window.fetch('/api/projects/ui-running/tasks')).json()));
    await page.waitForFunction(async () => {
      const tasks = await (await window.fetch('/api/projects/ui-running/tasks')).json();
      return ['ui-task-active', 'ui-task-auto-waiting'].every(id => tasks.some(task => task.id === id && task.waiting === true && task.running === false));
    });
    const trigger = page.locator('[data-ui="manual-task-trigger"][data-task-id="ui-task-active"]');
    await trigger.waitFor({ state: 'visible' });
    await trigger.click();
    await page.waitForFunction(async () => {
      const tasks = await (await window.fetch('/api/projects/ui-running/tasks')).json();
      const manual = tasks.find(task => task.id === 'ui-task-active');
      const capped = tasks.find(task => task.id === 'ui-task-auto-waiting');
      return manual?.running === true && capped?.running === false && capped?.waiting === true;
    });
    const tasks = await taskState();
    const manual = tasks.find(task => task.id === 'ui-task-active');
    const capped = tasks.find(task => task.id === 'ui-task-auto-waiting');
    if (manual?.running !== true || capped?.waiting !== true || capped?.running !== false) {
      throw new Error('manual overflow lifecycle or automatic cap projection is incorrect');
    }
  }`,
]);

await waitForCondition('sustained manual overflow provider run', async () => {
  const requests = await providerRequests();
  return (
    requests.filter((request) => request.status === 'connected').length === 3 &&
    requests.some(
      (request) =>
        request.status === 'connected' &&
        request.lastUserText.includes('Idle active task'),
    )
  );
});

const stopped = await fetch(
  `${apiUrl}/api/projects/ui-running/tasks/ui-task-active/stop`,
  { method: 'POST', headers: { Cookie: authCookie } },
);
if (!stopped.ok) throw new Error(`Manual task stop returned ${stopped.status}`);

await waitForCondition('manual overflow stop settlement', async () => {
  const [tasksResponse, requests] = await Promise.all([
    fetch(`${apiUrl}/api/projects/ui-running/tasks`, {
      headers: { Cookie: authCookie },
    }),
    providerRequests(),
  ]);
  const tasks = (await tasksResponse.json()) as Array<{
    id: string;
    status: string;
    running: boolean;
    waiting: boolean;
  }>;
  const manual = tasks.find((task) => task.id === 'ui-task-active');
  const capped = tasks.find((task) => task.id === 'ui-task-auto-waiting');
  const manualRequest = requests.find((request) =>
    request.lastUserText.includes('Idle active task'),
  );
  return (
    manual?.status === 'backlog' &&
    manual.running === false &&
    capped?.running === false &&
    capped.waiting === true &&
    manualRequest?.status === 'aborted'
  );
});

console.log('Manual overflow UI sandbox smoke test passed.');
