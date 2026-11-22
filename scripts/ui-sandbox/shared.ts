import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_ADMIN = {
  username: 'ui-admin',
  password: 'carapa-ui-sandbox',
} as const;

export const SANDBOX_MEMBER = {
  username: 'ui-member',
  password: 'carapa-ui-member',
} as const;

export const SANDBOX_DIRECT_RUNTIME = {
  harnessId: 'direct',
  modelId: 'ui-simulator',
} as const;
export const SANDBOX_PERSONA_PRESET_ID = 'ui-simulator';

export function findPendingDeviceForUser<
  T extends { username: string | null; isApproved: boolean },
>(devices: T[], username: string): T | undefined {
  return devices.find(
    (device) => device.username === username && !device.isApproved,
  );
}

export const TWO_USER_BROWSER_REQUIRED_MESSAGE =
  'Two-user UI sandbox mode requires playwright-cli on PATH and cannot run with --no-browser: ' +
  'device approval mutations require a fresh device signature, which only a registered browser ' +
  'device key can produce (a password-only session cookie is rejected).';

export function hasApprovedDeviceForUser(
  devices: Array<{ username: string | null; isApproved: boolean }>,
  username: string,
): boolean {
  return devices.some(
    (device) => device.username === username && device.isApproved,
  );
}

/** The pending device the launcher must have the admin browser approve. */
export function requirePendingDeviceForUser<
  T extends { username: string | null; isApproved: boolean },
>(devices: T[], username: string): T {
  const pending = findPendingDeviceForUser(devices, username);
  if (!pending) {
    throw new Error(
      hasApprovedDeviceForUser(devices, username)
        ? `${username} device was already approved before the launcher could approve it`
        : `${username} did not register a pending device`,
    );
  }
  return pending;
}

export function assertUserDeviceApproved(
  devices: Array<{ username: string | null; isApproved: boolean }>,
  username: string,
): void {
  if (!hasApprovedDeviceForUser(devices, username)) {
    throw new Error(`${username} device is not approved`);
  }
}

/**
 * The first device of the bootstrap admin when other users already exist: the
 * product only auto-approves a lone admin, and a pending device cannot sign
 * the requests needed to approve itself. The sandbox backend approves exactly
 * this device in its own disposable database.
 */
export function findBootstrapAdminDevice<
  T extends { username: string | null; isApproved: boolean },
>(devices: T[], adminUsername: string): T | undefined {
  return hasApprovedDeviceForUser(devices, adminUsername)
    ? undefined
    : findPendingDeviceForUser(devices, adminUsername);
}

export interface SandboxOptions {
  keep: boolean;
  noBrowser: boolean;
  smoke: boolean;
  twoUser: boolean;
}

export interface BrowserIdentity {
  session: string;
  recorded: boolean;
  managed?: boolean;
}

function hasBoardRecordingEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CARAPA_RECORD === '1' &&
    env.PLAYWRIGHT_CLI_SESSION &&
    env.PLAYWRIGHT_DAEMON_SESSION_DIR &&
    env.PLAYWRIGHT_DAEMON_SOCKETS_DIR &&
    env.CARAPA_RECORD_DIR,
  );
}

export function browserIdentity(
  root: string,
  env: NodeJS.ProcessEnv = {},
): BrowserIdentity {
  if (hasBoardRecordingEnvironment(env)) {
    return { session: env.PLAYWRIGHT_CLI_SESSION!, recorded: true };
  }
  if (
    (env.CARAPA_BROWSER_SESSION_ID || env.CARAPA_BROWSER_RUN_ID) &&
    env.PLAYWRIGHT_CLI_SESSION &&
    env.PLAYWRIGHT_DAEMON_SESSION_DIR
  ) {
    return {
      session: env.PLAYWRIGHT_CLI_SESSION,
      recorded: false,
      managed: true,
    };
  }
  const rootName = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '-');
  return { session: `ui-sandbox-${rootName}`, recorded: false };
}

export function browserCliArgs(
  identity: BrowserIdentity,
  args: string[],
  forceSession = false,
): string[] {
  return (identity.recorded || identity.managed) && !forceSession
    ? args
    : [`-s=${identity.session}`, ...args];
}

/** Sessions this launcher is allowed to close during teardown. */
export function ownedBrowserSessions(
  adminSession: string,
  memberSession: string,
  recorded: boolean,
): string[] {
  return recorded ? [memberSession] : [adminSession, memberSession];
}

export function parseSandboxOptions(args: string[]): SandboxOptions {
  const known = new Set(['--keep', '--no-browser', '--smoke', '--two-user']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown UI sandbox option: ${unknown.join(', ')}`);
  }
  return {
    keep: args.includes('--keep'),
    noBrowser: args.includes('--no-browser'),
    smoke: args.includes('--smoke'),
    twoUser: args.includes('--two-user'),
  };
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function reserveDistinctLoopbackPorts(
  count: number,
): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await reserveLoopbackPort());
  return [...ports];
}

export interface SandboxStartupLock {
  release(): void;
}

const sandboxStartupLockPath = path.join(
  os.tmpdir(),
  'carapa-ui-sandbox-startup.lock',
);

/**
 * Serializes the short probe-to-bind window shared by disposable launchers.
 * Port 0 probes cannot remain open while child processes bind their assigned
 * ports, so concurrent launchers otherwise have a race between probe close
 * and service startup.
 */
export async function acquireSandboxStartupLock(
  timeoutMs = 60_000,
): Promise<SandboxStartupLock> {
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const ownerValue = JSON.stringify({ pid: process.pid, token });

  while (Date.now() < deadline) {
    try {
      // A symlink publishes its owner payload atomically, unlike creating a
      // directory and then writing a separate metadata file.
      fs.symlinkSync(ownerValue, sandboxStartupLockPath);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(
              fs.readlinkSync(sandboxStartupLockPath),
            ) as {
              token?: string;
            };
            if (owner.token === token)
              fs.rmSync(sandboxStartupLockPath, {
                recursive: true,
                force: true,
              });
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    try {
      const owner = JSON.parse(fs.readlinkSync(sandboxStartupLockPath)) as {
        pid?: number;
      };
      if (!Number.isInteger(owner.pid)) throw new Error('invalid lock owner');
      try {
        process.kill(owner.pid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          fs.rmSync(sandboxStartupLockPath, { recursive: true, force: true });
          continue;
        }
      }
    } catch {
      fs.rmSync(sandboxStartupLockPath, { recursive: true, force: true });
      continue;
    }
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the UI sandbox startup lock');
}

export function buildSandboxEnv(
  baseEnv: NodeJS.ProcessEnv,
  root: string,
  apiPort: number,
  uiPort: number,
  boxPort: number,
  twoUser = false,
  llmBaseUrl?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }

  for (const key of [
    'DB_HOST',
    'DB_PORT',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_PASSWORD_FILE',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ]) {
    delete env[key];
  }

  const dataDir = path.join(root, 'data');
  const secretsDir = path.join(root, 'secrets');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });

  return {
    ...env,
    NODE_ENV: 'development',
    API_PORT: String(apiPort),
    CARAPA_DATA_DIR: root,
    CARAPA_GROUPS_HOST_DIR: path.join(root, 'groups'),
    DATABASE_URL: path.join(dataDir, 'pglite'),
    SECRETS_DIR: secretsDir,
    CARAPA_BOARD_ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    CARAPA_BOX_URL: `http://127.0.0.1:${boxPort}`,
    CARAPA_BOX_API_TOKEN: 'ui-sandbox-box-token',
    CARAPA_BOX_ADMIN_TOKEN: '', // Do not inherit an operator's optional Box override.
    CORS_ORIGIN: `http://127.0.0.1:${uiPort}`,
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    ENABLE_KANBAN: 'true',
    ENABLE_CHAT: 'true',
    ENABLE_OBJECTIVES: 'true',
    ENABLE_SCHEDULER: 'false',
    ENABLE_SERVICE_WATCHER: 'false',
    AUTO_START_SANDBOXES: 'false',
    ENABLE_WHATSAPP: 'false',
    ENABLE_TTS: 'false',
    ENABLE_VECTOR_STORE: 'false',
    ENABLE_GITNEXUS: 'false',
    ENABLE_MEMORY_REFLECTOR: 'false',
    ENABLE_EXTERNAL_PRIVACY_ERASURE: 'false',
    ENABLE_NGINX_PROXY: 'false',
    SHOW_SANDBOX_PORTS: 'false',
    LOG_LEVEL: 'warn',
    UI_SANDBOX_TWO_USER: twoUser ? 'true' : 'false',
    UI_SANDBOX_GIT_REPO: path.join(root, 'repositories', 'ui-running'),
    UI_SANDBOX_AB_GIT_REPO: path.join(root, 'repositories', 'ui-ab'),
    ...(llmBaseUrl ? { UI_SANDBOX_LLM_BASE_URL: llmBaseUrl } : {}),
  };
}

export async function waitForUrl(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

export function cleanupSandboxRoot(root: string, keep: boolean): boolean {
  if (keep) return false;
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

export function writeSandboxDirectLlmConfig(
  root: string,
  baseUrl: string,
  options: { imageInput?: boolean } = {},
): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('UI sandbox Direct-LLM simulator must use loopback HTTP');
  }
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'board_agents.jsonc');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 2,
        connections: {
          simulator: {
            label: 'UI sandbox simulator',
            baseUrl,
            apiKey: 'ui-sandbox-local-only',
            wireApi: 'responses',
          },
        },
        harnesses: {
          direct: {
            label: 'Direct',
            kind: 'direct',
            sessionFamily: 'ui-sandbox-direct',
          },
        },
        models: {
          'ui-simulator': {
            label: 'Deterministic UI simulator',
            ...(options.imageInput ? { capabilities: ['image'] } : {}),
            reasoning: {
              options: ['low', 'high'],
              default: 'low',
              map: { high: 'xhigh' },
            },
            bindings: { direct: { connection: 'simulator' } },
          },
        },
        presets: {
          [SANDBOX_PERSONA_PRESET_ID]: {
            label: 'UI simulator',
            ...SANDBOX_DIRECT_RUNTIME,
          },
        },
        defaults: {
          chat: SANDBOX_DIRECT_RUNTIME,
          kanban: { fallback: SANDBOX_DIRECT_RUNTIME, stages: {} },
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}
