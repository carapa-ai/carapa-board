import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDirectLlmSimulator } from './direct-llm-simulator.js';

import {
  SANDBOX_ADMIN,
  SANDBOX_MEMBER,
  TWO_USER_BROWSER_REQUIRED_MESSAGE,
  acquireSandboxStartupLock,
  buildSandboxEnv,
  browserCliArgs,
  browserIdentity,
  cleanupSandboxRoot,
  assertUserDeviceApproved,
  hasApprovedDeviceForUser,
  ownedBrowserSessions,
  parseSandboxOptions,
  requirePendingDeviceForUser,
  reserveDistinctLoopbackPorts,
  waitForUrl,
} from './shared.js';

const options = parseSandboxOptions(process.argv.slice(2));
const startupLock = await acquireSandboxStartupLock();
// Create the root only once the lock is held, and remove it again if startup
// fails or is interrupted before the main cleanup handlers below take over.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-board-ui-'));
const abortStartup = () => {
  startupLock.release();
  cleanupSandboxRoot(root, false);
};
const earlySignals = ['SIGINT', 'SIGTERM'] as const;
const onEarlySignal = () => {
  abortStartup();
  process.exit(0);
};
for (const signal of earlySignals) process.on(signal, onEarlySignal);
let ports: number[];
let llmSimulator: ReturnType<typeof startDirectLlmSimulator>;
let env: Record<string, string>;
let browserIdentityInfo: ReturnType<typeof browserIdentity>;
try {
  ports = await reserveDistinctLoopbackPorts(5);
  llmSimulator = startDirectLlmSimulator(ports[4]!, undefined, {
    autoRelease: process.env.UI_SANDBOX_LLM_AUTO_RELEASE === '1',
  });
  env = buildSandboxEnv(
    process.env,
    root,
    ports[0]!,
    ports[1]!,
    ports[2]!,
    options.twoUser,
    llmSimulator.baseUrl,
  );
  browserIdentityInfo = browserIdentity(root, process.env);
  if (!browserIdentityInfo.recorded && !browserIdentityInfo.managed) {
    for (const key of [
      'CARAPA_RECORD',
      'PLAYWRIGHT_CLI_SESSION',
      'CARAPA_RECORD_DIR',
      'CARAPA_RECORD_SESSION',
      'CARAPA_RECORD_DAEMON_DIR',
      'CARAPA_RECORD_SOCKETS_DIR',
    ]) {
      delete env[key];
    }
    env.PLAYWRIGHT_DAEMON_SESSION_DIR = path.join(root, 'playwright-daemon');
    env.PLAYWRIGHT_DAEMON_SOCKETS_DIR = path.join(root, 'playwright-sockets');
    fs.mkdirSync(env.PLAYWRIGHT_DAEMON_SESSION_DIR, { recursive: true });
    fs.mkdirSync(env.PLAYWRIGHT_DAEMON_SOCKETS_DIR, { recursive: true });
  }
} catch (error) {
  abortStartup();
  throw error;
}
const [apiPort, uiPort, boxPort, controlPort] = ports;
const boardOwnedBrowser =
  browserIdentityInfo.recorded || browserIdentityInfo.managed;
const uiUrl = `http://127.0.0.1:${uiPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const controlUrl = `http://127.0.0.1:${controlPort}`;
const authStatePath = path.join(root, 'playwright-admin.json');
const browserSession = browserIdentityInfo.session;
const memberBrowserSession = `${browserSession}-member`;
const memberAuthStatePath = `${authStatePath}.member`;
// Tests and sandbox hosts may provide an explicit executable without relying
// on a login-shell PATH probe. Production keeps the normal command discovery
// default when this seam is absent.
const playwrightCliBin = process.env.PLAYWRIGHT_CLI_BIN || 'playwright-cli';
const isSecurityScenario = process.env.UI_SANDBOX_SMOKE_SCENARIO === 'security';
const children: Bun.Subprocess[] = [];
const openBrowserSessions = new Set<string>();
let cleaningUp = false;

function spawn(
  command: string[],
  extraEnv: Record<string, string> = {},
): Bun.Subprocess {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: { ...env, ...extraEnv },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.push(child);
  return child;
}

async function run(
  command: string[],
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const child = spawn(command, extraEnv);
  const code = await child.exited;
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  if (code !== 0)
    throw new Error(`${command.join(' ')} exited with code ${code}`);
}

// A Board-managed browser shim drops every `-s=` flag and pins all commands to
// the one shared session, so the member would land in the admin's signed-in
// browser. The member session therefore runs the real CLI directly, with its
// own daemon directories under the sandbox root, as an independent browser.
function cliInvocation(
  session: string,
  args: string[],
): { command: string[]; env: Record<string, string> } {
  const isBoardOwnedSession = session === browserSession;
  const realCli = process.env.CARAPA_PLAYWRIGHT_REAL;
  if (!isBoardOwnedSession && boardOwnedBrowser && realCli) {
    const memberEnv = { ...env };
    for (const key of Object.keys(memberEnv)) {
      if (key.startsWith('CARAPA_RECORD') || key.startsWith('CARAPA_BROWSER_'))
        delete memberEnv[key];
    }
    delete memberEnv.PLAYWRIGHT_CLI_SESSION;
    memberEnv.PLAYWRIGHT_DAEMON_SESSION_DIR = path.join(
      root,
      'playwright-daemon',
    );
    memberEnv.PLAYWRIGHT_DAEMON_SOCKETS_DIR = path.join(
      root,
      'playwright-sockets',
    );
    fs.mkdirSync(memberEnv.PLAYWRIGHT_DAEMON_SESSION_DIR, { recursive: true });
    fs.mkdirSync(memberEnv.PLAYWRIGHT_DAEMON_SOCKETS_DIR, { recursive: true });
    return { command: [realCli, `-s=${session}`, ...args], env: memberEnv };
  }
  const identity = isBoardOwnedSession
    ? browserIdentityInfo
    : { session, recorded: false };
  return {
    command: [
      playwrightCliBin,
      ...browserCliArgs(identity, args, !isBoardOwnedSession),
    ],
    env,
  };
}

async function runCli(session: string, args: string[]): Promise<string> {
  const invocation = cliInvocation(session, args);
  const child = Bun.spawn(invocation.command, {
    cwd: root,
    env: invocation.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
  return stdout;
}

function hasCommand(name: string): boolean {
  return (
    Bun.spawnSync(['bash', '-lc', `command -v ${name}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exitCode === 0
  );
}

function hasPlaywrightCli(): boolean {
  return (
    Boolean(process.env.PLAYWRIGHT_CLI_BIN) || hasCommand('playwright-cli')
  );
}

async function createPasswordOnlyAdminState(): Promise<string> {
  const deadline = Date.now() + 15_000;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SANDBOX_ADMIN),
    });
    if (response.status !== 404 && response.status !== 503) break;
    await Bun.sleep(100);
  }
  if (!response?.ok) {
    throw new Error(
      `Admin login failed: ${response?.status ?? 'unavailable'} ${response ? await response.text() : ''}`,
    );
  }
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie?.match(/(?:^|,\s*)carapa_session=([^;]+)/);
  if (!match)
    throw new Error('Admin login did not return a carapa_session cookie');

  const cookie = `carapa_session=${match[1]}`;
  fs.writeFileSync(
    authStatePath,
    JSON.stringify(
      {
        cookies: [
          {
            name: 'carapa_session',
            value: match[1],
            domain: '127.0.0.1',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  );
  return cookie;
}

interface AdminDeviceListEntry {
  deviceId: string;
  username: string | null;
  isApproved: boolean;
}

async function listAdminDevices(
  authCookie: string,
): Promise<AdminDeviceListEntry[]> {
  const { devices } = await apiRequest<{ devices: AdminDeviceListEntry[] }>(
    authCookie,
    '/api/admin/devices',
  );
  return devices;
}

// Admin device mutations need a fresh device signature, so a cookie-only
// request is rejected by design. Approve through the admin browser session,
// whose registered device key signs the request from the Devices page.
async function approvePendingBrowserDevice(
  authCookie: string,
  username: string,
): Promise<void> {
  const pendingDevice = requirePendingDeviceForUser(
    await listAdminDevices(authCookie),
    username,
  );
  const rowSelector = `[data-ui="admin-device-row"][data-device-id="${pendingDevice.deviceId}"]`;
  await runCli(browserSession, [
    'run-code',
    `async page => {
      await page.goto(${JSON.stringify(`${uiUrl}/admin/devices`)});
      const row = page.locator(${JSON.stringify(rowSelector)});
      await row.waitFor();
      await row.getByRole('button', { name: 'Approve' }).click();
      await row.getByRole('button', { name: 'Approve' }).waitFor({ state: 'detached' });
      await page.goto(${JSON.stringify(`${uiUrl}/board/ui-running`)});
    }`,
  ]);
  assertUserDeviceApproved(await listAdminDevices(authCookie), username);
}

// The admin's own first device cannot sign its own approval; the sandbox
// backend approves it (scripts/ui-sandbox/backend.ts), so wait for that.
async function waitForBootstrapAdminApproval(
  authCookie: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      hasApprovedDeviceForUser(
        await listAdminDevices(authCookie),
        SANDBOX_ADMIN.username,
      )
    ) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`${SANDBOX_ADMIN.username} device was not approved`);
}

async function createAdminState(bootstrapCookie?: string): Promise<string> {
  // The security scenario seeds a second user, which would leave a browser
  // device of the admin pending; its checks only need a session cookie.
  if ((options.noBrowser && !options.smoke) || isSecurityScenario) {
    return createPasswordOnlyAdminState();
  }
  if (!hasPlaywrightCli()) {
    console.warn(
      'playwright-cli is unavailable; start the browser manually with the printed credentials.',
    );
    return createPasswordOnlyAdminState();
  }
  await runCli(browserSession, [
    'open',
    ...(process.env.UI_SANDBOX_SMOKE_SCENARIO === 'mobile-kanban'
      ? ['--mobile']
      : []),
    'about:blank',
  ]);
  if (!browserIdentityInfo.recorded) openBrowserSessions.add(browserSession);
  await runCli(browserSession, ['goto', uiUrl]);
  const signedInReadyAssertion = options.twoUser
    ? `await page.getByText('Waiting for admin approval', { exact: true }).waitFor();`
    : `await page.locator('[data-ui="kanban-content"]').waitFor();`;
  await runCli(browserSession, [
    'run-code',
    `async page => {
      await page.getByPlaceholder('Username').fill('${SANDBOX_ADMIN.username}');
      await page.getByPlaceholder('Password').fill('${SANDBOX_ADMIN.password}');
      await page.getByRole('button', { name: 'Sign in' }).click();
      ${signedInReadyAssertion}
    }`,
  ]);
  if (options.twoUser) {
    if (!bootstrapCookie)
      throw new Error('Two-user admin enrollment needs a bootstrap session');
    await waitForBootstrapAdminApproval(bootstrapCookie);
    await runCli(browserSession, ['reload']);
    await runCli(browserSession, [
      'run-code',
      `async page => {
        await page.locator('[data-ui="kanban-content"]').waitFor();
        const response = await page.evaluate(async () => (await fetch('/api/auth/check')).json());
        if (response.user?.username !== ${JSON.stringify(SANDBOX_ADMIN.username)}) throw new Error('admin browser has the wrong authenticated user');
        if (response.device?.isApproved !== true) throw new Error('admin browser device is not approved');
      }`,
    ]);
  }
  await runCli(browserSession, ['state-save', authStatePath]);

  const state = JSON.parse(fs.readFileSync(authStatePath, 'utf8')) as {
    cookies?: Array<{ name?: string; value?: string }>;
  };
  const sessionCookie = state.cookies?.find(
    (cookie) => cookie.name === 'carapa_session',
  );
  if (!sessionCookie?.value)
    throw new Error('Playwright admin state has no session cookie');

  if (options.noBrowser && !options.smoke) {
    await runCli(browserSession, ['close']);
    openBrowserSessions.delete(browserSession);
  } else {
    await runCli(browserSession, ['goto', `${uiUrl}/board/ui-running`]);
  }
  return `carapa_session=${sessionCookie.value}`;
}

async function apiRequest<T>(
  authCookie: string,
  pathName: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${pathName}`, {
    ...init,
    headers: {
      Cookie: authCookie,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${pathName} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function provisionSecondUser(authCookie: string): Promise<void> {
  if (!hasPlaywrightCli()) {
    throw new Error(TWO_USER_BROWSER_REQUIRED_MESSAGE);
  }

  await runCli(memberBrowserSession, ['open', 'about:blank']);
  openBrowserSessions.add(memberBrowserSession);
  await runCli(memberBrowserSession, ['goto', uiUrl]);
  await runCli(memberBrowserSession, [
    'run-code',
    `async page => {
      await page.getByPlaceholder('Username').fill(${JSON.stringify(SANDBOX_MEMBER.username)});
      await page.getByPlaceholder('Password').fill(${JSON.stringify(SANDBOX_MEMBER.password)});
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByText('Waiting for admin approval', { exact: true }).waitFor();
    }`,
  ]);

  await approvePendingBrowserDevice(authCookie, SANDBOX_MEMBER.username);

  await runCli(memberBrowserSession, ['reload']);
  await runCli(memberBrowserSession, [
    'run-code',
    `async page => {
      await page.locator('[data-ui="kanban-content"]').waitFor();
      const response = await page.evaluate(async () => {
        const result = await fetch('/api/auth/check');
        return result.json();
      });
      if (response.user?.username !== ${JSON.stringify(SANDBOX_MEMBER.username)}) throw new Error('second browser has the wrong authenticated user');
      if (response.device?.isApproved !== true) throw new Error('second browser device is not approved');
    }`,
  ]);
  await runCli(memberBrowserSession, ['state-save', memberAuthStatePath]);
  await runCli(memberBrowserSession, ['goto', `${uiUrl}/board/ui-running`]);
}

async function verifyTwoUserAttributionFixture(): Promise<void> {
  await runCli(browserSession, [
    'run-code',
    `async page => {
      await page.goto(${JSON.stringify(`${uiUrl}/board/ui-running?taskId=ui-task-completed`)});
      const history = page.getByRole('tab', { name: /Run History/ });
      await history.waitFor();
      await history.click();
      const trigger = page.locator('[data-ui="task-run-trigger"][data-run-id="ui-run-completed"]');
      await trigger.waitFor();
      const text = (await trigger.textContent()) ?? '';
      const auth = await page.evaluate(async () => (await fetch('/api/auth/check')).json());
      if (!text.includes(${JSON.stringify(SANDBOX_ADMIN.username)})) throw new Error('completed fixture run trigger name is missing');
      if ((await trigger.getAttribute('data-user-id')) !== auth.user?.id) throw new Error('completed fixture run trigger user id is incorrect');
      if ((await trigger.getAttribute('data-trigger-source')) !== 'user') throw new Error('completed fixture run trigger source is incorrect');
      await page.goto(${JSON.stringify(`${uiUrl}/board/ui-running`)});
    }`,
  ]);

  await runCli(browserSession, [
    'run-code',
    `async page => {
      await page.goto(${JSON.stringify(`${uiUrl}/board/ui-running`)});
      const owner = page.locator('[data-ui="task-owner-filter"]');
      const triggerer = page.locator('[data-ui="task-trigger-filter"]');
      const pick = async (trigger, name) => {
        await trigger.click();
        await page.getByRole('option', { name, exact: true }).click();
      };
      await pick(owner, ${JSON.stringify(SANDBOX_MEMBER.username)});
      await pick(triggerer, ${JSON.stringify(SANDBOX_ADMIN.username)});
      const ownedByMember = page.locator('[data-ui="task-owner-badge"][data-entity-id="ui-task-completed"]');
      await ownedByMember.waitFor();
      if (!(await ownedByMember.textContent())?.includes(${JSON.stringify(SANDBOX_MEMBER.username)})) throw new Error('combined task owner filter did not retain the member-owned task');
      await pick(owner, 'All owners');
      await pick(triggerer, 'All triggerers');
      await page.locator('[data-ui="kanban-card"][data-task-id="ui-task-backlog"]').waitFor();

      const enabled = await page.evaluate(async () => {
        const response = await fetch('/api/projects/ui-running/preferences/push', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
        });
        return { status: response.status, body: await response.json() };
      });
      if (enabled.status !== 200 || enabled.body.enabled !== true) throw new Error('admin push opt-in did not persist');

      await page.locator('[data-ui="sidebar-now-item"]', { hasText: 'Open the attributed task' }).locator('button').first().click();
      await page.waitForURL('**/board/ui-running?taskId=ui-task-completed');
      await page.getByRole('tab', { name: 'Details', exact: true }).click();
      await page.locator('[data-ui="task-detail-owner-badge"][data-task-id="ui-task-completed"]').waitFor({ state: 'visible' });
    }`,
  ]);

  await runCli(memberBrowserSession, [
    'run-code',
    `async page => {
      await page.goto(${JSON.stringify(`${uiUrl}/chat/ui-chat`)});
      // Only admins and the project owner may list members, so an editor
      // member gets no owner/triggerer filters, and no failing members request.
      const memberListStatus = [];
      page.on('response', response => { if (response.url().endsWith('/members')) memberListStatus.push(response.status()); });
      const row = page.locator('[data-ui="conversation-list-item"][data-conversation-id="ui-conversation-pinned"]');
      await row.waitFor();
      if (await page.locator('[data-ui="conversation-owner-filter"]').count()) throw new Error('editor member sees the conversation owner filter');
      if (memberListStatus.length) throw new Error('editor member requested the member list');
      const direct = await page.evaluate(async () => (await fetch('/api/projects/ui-chat/members')).status);
      if (direct !== 403) throw new Error('editor member listed the project members');
      memberListStatus.length = 0;
      await page.locator('[data-ui="conversation-list-item"][data-conversation-id="ui-conversation-unread"]').waitFor();

      const disabled = await page.evaluate(async () => {
        const response = await fetch('/api/projects/ui-running/preferences/push', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false })
        });
        return { status: response.status, body: await response.json() };
      });
      if (disabled.status !== 200 || disabled.body.enabled !== false) throw new Error('member push opt-out did not persist');

      await page.locator('[data-ui="sidebar-now-item"]', { hasText: 'Open the attributed conversation' }).locator('button').first().click();
      await page.waitForURL('**/chat/ui-chat?conversationId=ui-conversation-pinned');
      const headerOwner = page.locator('[data-ui="chat-owner-badge"][data-conversation-id="ui-conversation-pinned"]');
      await headerOwner.waitFor();
      if (!(await headerOwner.textContent())?.includes(${JSON.stringify(SANDBOX_MEMBER.username)})) throw new Error('conversation deep link did not open the member-owned conversation');
      const headerTrigger = page.locator('[data-ui="chat-trigger-badge"][data-conversation-id="ui-conversation-pinned"]');
      if (!(await headerTrigger.textContent())?.includes(${JSON.stringify(SANDBOX_ADMIN.username)})) throw new Error('conversation deep link lost the admin trigger attribution');

      const unread = await page.evaluate(async () => (await fetch('/api/notifications/unread')).json());
      if (unread.items.some(item => item.summary === 'Review the completed fixture')) throw new Error('non-triggerer received the actionable form');

      await page.goto(${JSON.stringify(`${uiUrl}/board/ui-running?taskId=ui-task-completed`)});
      const history = page.getByRole('tab', { name: /Run History/ });
      await history.waitFor();
      await history.click();
      const trigger = page.locator('[data-ui="task-run-trigger"][data-run-id="ui-run-completed"]');
      await trigger.waitFor();
      if (!(await trigger.textContent())?.includes(${JSON.stringify(SANDBOX_ADMIN.username)})) throw new Error('editor member lost the stored triggerer name');
      for (const filter of ['task-owner-filter', 'task-trigger-filter'])
        if (await page.locator('[data-ui="' + filter + '"]').count()) throw new Error('editor member sees ' + filter);
      if (memberListStatus.length) throw new Error('editor member requested the member list on the board');
    }`,
  ]);

  await runCli(browserSession, [
    'run-code',
    `async page => {
      await page.goto(${JSON.stringify(`${uiUrl}/board/ui-running`)});
      await page.locator('[data-ui="kanban-content"]').waitFor();
      await page.getByRole('button', { name: /Notifications/ }).click();
      await page.getByRole('menuitem', { name: /Review the completed fixture/ }).click();
      await page.getByLabel('Verdict').click();
      await page.getByRole('option', { name: /approved/i }).click();
      await page.getByRole('button', { name: /Submit/ }).click();
      await page.getByText('Review the completed fixture', { exact: true }).waitFor({ state: 'detached' }).catch(() => {});
      const unread = await page.evaluate(async () => (await fetch('/api/notifications/unread')).json());
      if (unread.items.some(item => item.summary === 'Review the completed fixture')) throw new Error('triggerer form response was not acknowledged');
    }`,
  ]);
}

async function cleanup(exitCode: number): Promise<never> {
  // A signal-triggered cleanup terminates the children below. Their exit can
  // win the main Promise.race and enter the catch block while cleanup is still
  // running. Let the original cleanup retain its exit code instead of turning
  // a clean Ctrl+C into exit 1.
  if (cleaningUp) return await new Promise<never>(() => {});
  cleaningUp = true;
  startupLock.release();

  let cleanupFailure: string | undefined;
  const reportCloseFailure = (session: string, result: Bun.SyncSubprocess) => {
    const decode = (value: Uint8Array | string | undefined) =>
      typeof value === 'string'
        ? value
        : value
          ? new TextDecoder().decode(value)
          : '';
    const stdout = decode(result.stdout);
    const stderr = decode(result.stderr);
    if (
      result.exitCode !== 0 ||
      stdout.includes('### Error') ||
      stderr.includes('### Error')
    ) {
      cleanupFailure =
        `playwright-cli -s=${session} close failed` +
        (result.exitCode !== 0 ? ` with exit code ${result.exitCode}` : '') +
        (stderr || stdout ? `: ${stderr || stdout}` : '');
      console.error(cleanupFailure);
    }
  };

  if (hasPlaywrightCli()) {
    for (const session of ownedBrowserSessions(
      browserSession,
      memberBrowserSession,
      !!boardOwnedBrowser,
    ).filter((session) => openBrowserSessions.has(session))) {
      const invocation = cliInvocation(session, ['close']);
      const closeResult = Bun.spawnSync(invocation.command, {
        cwd: root,
        env: invocation.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      reportCloseFailure(session, closeResult);
    }
  }
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  const childExits = Promise.allSettled(children.map((child) => child.exited));
  const stoppedGracefully = await Promise.race([
    childExits.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stoppedGracefully) {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    await childExits;
  }
  llmSimulator.stop();

  if (options.keep) {
    console.log(`UI sandbox data preserved at ${root}`);
  } else {
    cleanupSandboxRoot(root, false);
  }
  process.exit(cleanupFailure ? 1 : exitCode);
}

// `on`, not `once`: a repeated signal during the up-to-5 s teardown must be
// absorbed by the `cleaningUp` guard instead of hitting the default action,
// which would skip the SIGKILL of children and the root removal.
for (const signal of earlySignals) {
  process.off(signal, onEarlySignal);
  process.on(signal, () => void cleanup(0));
}

try {
  if (options.twoUser && options.noBrowser && !options.smoke) {
    throw new Error(TWO_USER_BROWSER_REQUIRED_MESSAGE);
  }
  await run(['bun', 'scripts/ui-sandbox/seed.ts']);

  // The stub's restart_service delegates here so a board restart in the
  // sandbox really re-spawns the backend process: the UI must observe a
  // genuinely new started_at, not a simulated one.
  let backend: Bun.Subprocess = spawn([
    'bun',
    '--watch',
    'scripts/ui-sandbox/backend.ts',
  ]);
  let backendRestartInFlight = false;
  // The control handler SIGTERM's the backend it replaces. Mark each such
  // process before killing it: the supervisor below registers its
  // continuation on the exited promise before the handler does, so its
  // continuation runs first and must recognize the controlled exit instead
  // of reporting it as an unexpected crash.
  const controlledBackendExits = new Set<Bun.Subprocess>();
  const controlServer = Bun.serve({
    hostname: '127.0.0.1',
    port: controlPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/restart-board' || request.method !== 'POST') {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (cleaningUp) {
        return Response.json(
          { error: 'Sandbox is shutting down' },
          { status: 503 },
        );
      }
      if (backendRestartInFlight) {
        return Response.json(
          { error: 'Backend restart already in progress' },
          { status: 409 },
        );
      }
      backendRestartInFlight = true;
      const previous = backend;
      controlledBackendExits.add(previous);
      try {
        previous.kill('SIGTERM');
        await previous.exited;
        // Teardown may have run while the old backend was exiting; spawning
        // now would orphan the replacement.
        if (cleaningUp) {
          return Response.json(
            { error: 'Sandbox is shutting down' },
            { status: 503 },
          );
        }
        backend = spawn(['bun', '--watch', 'scripts/ui-sandbox/backend.ts']);
        await waitForUrl(`${apiUrl}/health`, 45_000);
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      } finally {
        backendRestartInFlight = false;
        // Release the mark on every path: once the replacement is spawned (or
        // the restart failed) any further exit of this process is unexpected.
        controlledBackendExits.delete(previous);
      }
    },
  });

  // spawn's env replaces the parent environment, so forward the stub's
  // build knobs only when the operator actually set them.
  const stubEnv: Record<string, string> = {
    UI_SANDBOX_BOX_PORT: String(boxPort),
    UI_SANDBOX_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
  };
  if (process.env.UI_SANDBOX_BUILD_DELAY_MS)
    stubEnv.UI_SANDBOX_BUILD_DELAY_MS = process.env.UI_SANDBOX_BUILD_DELAY_MS;
  if (process.env.UI_SANDBOX_BUILD_FORCE_FAIL)
    stubEnv.UI_SANDBOX_BUILD_FORCE_FAIL =
      process.env.UI_SANDBOX_BUILD_FORCE_FAIL;
  const stub = spawn(['bun', 'scripts/ui-sandbox/box-stub.ts'], stubEnv);
  await waitForUrl(`http://127.0.0.1:${boxPort}/health`);

  await waitForUrl(`${apiUrl}/health`, 45_000);

  const vite = spawn([
    'npm',
    '--prefix',
    'ui',
    'run',
    'dev',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ]);
  await waitForUrl(uiUrl, 45_000);
  startupLock.release();
  const bootstrapCookie = options.twoUser
    ? await createPasswordOnlyAdminState()
    : undefined;
  const authCookie = await createAdminState(bootstrapCookie);

  if (process.env.UI_SANDBOX_READY_FILE) {
    fs.writeFileSync(
      process.env.UI_SANDBOX_READY_FILE,
      JSON.stringify({
        uiUrl,
        apiUrl,
        llmBaseUrl: llmSimulator.baseUrl,
        llmControlUrl: llmSimulator.controlUrl,
      }),
    );
  }

  if (process.env.CARAPA_BROWSER_URL_FILE) {
    const target = process.env.CARAPA_BROWSER_URL_FILE;
    const temporary = `${target}.${process.pid}`;
    fs.writeFileSync(temporary, `${uiUrl}/board/ui-running\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  if (options.twoUser) {
    await provisionSecondUser(authCookie);
    await verifyTwoUserAttributionFixture();
  }

  console.log('\nDisposable CarapaBoard UI sandbox is ready.');
  console.log(`UI:       ${uiUrl}/board/ui-running`);
  console.log(`API:      ${apiUrl}`);
  console.log(`Control:  ${controlUrl} (POST /restart-board)`);
  console.log(`LLM:      ${llmSimulator.baseUrl} (loopback simulator)`);
  console.log(`LLM Ctrl: ${llmSimulator.controlUrl}`);
  console.log(
    '          Replies are held until released (or UI_SANDBOX_LLM_AUTO_RELEASE=1):',
  );
  console.log(`          curl ${llmSimulator.controlUrl}/requests`);
  console.log(
    `          curl -X POST ${llmSimulator.controlUrl}/requests/<id>/release -d '{"text":"..."}'`,
  );
  console.log(
    `          curl -X POST ${llmSimulator.controlUrl}/auto-release -d '{"enabled":true}'`,
  );
  console.log(
    `Admin:    ${SANDBOX_ADMIN.username} / ${SANDBOX_ADMIN.password}`,
  );
  console.log(
    boardOwnedBrowser
      ? `Browser:  playwright-cli <command> (board-owned session ${browserSession})`
      : `Browser:  playwright-cli -s=${browserSession} <command>`,
  );
  if (options.twoUser) {
    console.log(
      `Member:   ${SANDBOX_MEMBER.username} / ${SANDBOX_MEMBER.password}`,
    );
    console.log(
      browserIdentityInfo.recorded
        ? `Browser:  playwright-cli -s=${memberBrowserSession} <command> (launcher-owned member session)`
        : `Browser:  playwright-cli -s=${memberBrowserSession} <command>`,
    );
  }
  console.log(
    `Data:     ${root}${options.keep ? ' (kept on exit)' : ' (deleted on exit)'}`,
  );
  console.log(
    'External: local Git, CarapaBox, and Direct-LLM fixtures are available for deterministic checks; real containers, agents, credentials, messaging, and email remain unavailable.\n',
  );

  if (options.smoke) {
    // The security scenario is fetch-only and signs in with the password.
    if (!isSecurityScenario && !hasPlaywrightCli()) {
      throw new Error('ui:sandbox:smoke requires playwright-cli on PATH');
    }
    if (!options.twoUser) {
      const smokeScript =
        process.env.UI_SANDBOX_SMOKE_SCENARIO === 'manual-overflow'
          ? 'scripts/ui-sandbox/manual-overflow-smoke.ts'
          : process.env.UI_SANDBOX_SMOKE_SCENARIO === 'mobile-kanban'
            ? 'scripts/ui-sandbox/mobile-kanban-smoke.ts'
            : isSecurityScenario
              ? 'scripts/ui-sandbox/security-smoke.ts'
              : 'scripts/ui-sandbox/smoke.ts';
      await run(['bun', smokeScript], {
        UI_SANDBOX_URL: uiUrl,
        UI_SANDBOX_API_URL: apiUrl,
        UI_SANDBOX_AUTH_COOKIE: authCookie,
        UI_SANDBOX_BROWSER_SESSION: browserSession,
        UI_SANDBOX_ROOT: root,
        UI_SANDBOX_LLM_CONTROL_URL: llmSimulator.controlUrl,
      });
      console.log('UI sandbox smoke test passed.');
    } else {
      console.log('Two-user attribution UI workflow passed.');
    }
    await cleanup(0);
  }

  const exited = await Promise.race([
    stub.exited.then((code) => `CarapaBox stub exited with code ${code}`),
    // Re-arm on every controlled replacement: a SIGTERM'd backend that is
    // immediately re-spawned must not count as an unexpected exit.
    (async () => {
      for (;;) {
        const current = backend;
        const code = await current.exited;
        if (backend !== current || controlledBackendExits.has(current))
          continue;
        return `Backend exited with code ${code}`;
      }
    })(),
    vite.exited.then((code) => `Vite exited with code ${code}`),
  ]);
  throw new Error(exited);
} catch (error) {
  if (cleaningUp) await new Promise<never>(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  await cleanup(1);
}
