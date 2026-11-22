import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../lib/hash.js';
import { DATA_DIR } from '../config.js';
import type { SandboxClient } from '../lib/mcp-client.js';
import type { resolveEffectiveSandbox } from './effective-settings.js';

/** Atomically replace a private (0o600) JSON file via a temp file and rename. */
export function writeJsonFileAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Box persists host worktree paths; browser and agent execution need sandbox paths. */
export function resolveBrowserWorkDir(
  sandbox: { workspaceRoot: string },
  checkout: { worktree_path?: string | null; work_dir?: string },
): string {
  if (!checkout.worktree_path)
    return path.posix.resolve(sandbox.workspaceRoot, checkout.work_dir || '.');
  return path.posix.join(
    sandbox.workspaceRoot,
    relativeWorktreePath(checkout.worktree_path),
  );
}

/** `.worktrees/<branch>`, relative to whichever workspace holds the worktree. */
function relativeWorktreePath(worktree: string): string {
  // Keep the full branch suffix (branches can contain slashes), including for
  // older records already stored as container or repository-relative paths.
  const relative = path.posix.normalize(
    worktree.slice(worktree.lastIndexOf('/.worktrees/') + 1),
  );
  if (!relative.startsWith('.worktrees/') || relative === '.worktrees/')
    throw new Error('Invalid conversation worktree path');
  return relative;
}

const SERVICE_WORK_DIR_TTL_MS = 5 * 60_000;
const SERVICE_WORK_DIR_FAILURE_TTL_MS = 10_000;
const serviceWorkDirs = new Map<
  string,
  { cwd: Promise<string>; expires: number }
>();

/**
 * The service's actual cwd, which Board's settings do not record. Lookups are
 * shared while in flight and cached briefly (failures even more briefly), so a
 * changed service working dir is picked up and an unreachable sandbox is not
 * probed once per conversation.
 */
function resolveServiceWorkDir(
  sandbox: ReturnType<typeof resolveEffectiveSandbox>,
  client: Pick<SandboxClient, 'sandboxExec'>,
): Promise<string> {
  const key = [sandbox.stack, sandbox.instance, sandbox.service].join('\0');
  const cached = serviceWorkDirs.get(key);
  if (cached && cached.expires > Date.now()) return cached.cwd;
  const entry = {
    expires: Date.now() + SERVICE_WORK_DIR_TTL_MS,
    cwd: (async () => {
      const result = await client.sandboxExec(
        sandbox.stack,
        sandbox.service,
        'pwd',
        { instance: sandbox.instance, timeout: 15 },
      );
      const cwd = result.stdout.trim();
      if (result.isError || !path.posix.isAbsolute(cwd) || cwd.includes('\n'))
        throw new Error(
          `Could not resolve the sandbox service working directory: ${result.stdout.slice(0, 200)}`,
        );
      return cwd;
    })(),
  };
  entry.cwd.catch(() => {
    entry.expires = Date.now() + SERVICE_WORK_DIR_FAILURE_TTL_MS;
  });
  serviceWorkDirs.set(key, entry);
  return entry.cwd;
}

/**
 * Browser identity for a conversation checkout. The box shims accept a service
 * cwd only without a worktree and otherwise need an absolute existing directory,
 * so a worktree in a project without a Workspace Path is pinned to the path
 * beneath the service's real cwd (the /workspace/<folder> fallback may not exist).
 */
export async function resolveConversationBrowserTarget(
  sandbox: ReturnType<typeof resolveEffectiveSandbox>,
  checkout: { worktree_path?: string | null },
  client: Pick<SandboxClient, 'sandboxExec'>,
): Promise<{ workDir: string; useServiceWorkDir: boolean }> {
  const service = useServiceWorkDir(sandbox);
  if (service && checkout.worktree_path)
    return {
      workDir: path.posix.join(
        await resolveServiceWorkDir(sandbox, client),
        relativeWorktreePath(checkout.worktree_path),
      ),
      useServiceWorkDir: false,
    };
  return {
    workDir: resolveBrowserWorkDir(sandbox, checkout),
    useServiceWorkDir: service,
  };
}

export function useServiceWorkDir(
  sandbox: ReturnType<typeof resolveEffectiveSandbox>,
): boolean {
  // The conventional /workspace/<project> root need not exist in custom stacks.
  return (
    !sandbox.inherited &&
    sandbox.owner.settings?.sandboxOwnership !== 'shared' &&
    !sandbox.group.settings?.workspacePath?.trim()
  );
}

export interface PersistentBrowser {
  id: string;
  projectId: string;
  conversationId: string | null;
  stack: string;
  service: string;
  instance: string;
  workDir: string;
  /** Browsers without a pinned workspace can use the stack service's actual cwd. */
  useServiceWorkDir?: boolean;
  worktree: string | null;
  createdAt: string;
  requestedUrl?: string;
  env: Record<string, string>;
}

export function browserSessionFile(
  target: Pick<PersistentBrowser, 'stack' | 'instance' | 'id'>,
  dataDir = DATA_DIR,
): string {
  if (
    ![target.stack, target.instance, target.id].every((value) =>
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value),
    )
  )
    throw new Error('Invalid browser session identity');
  return path.join(
    dataDir,
    'ipc',
    `${target.stack}-${target.instance}`,
    'browser-sessions',
    `${target.id}.json`,
  );
}

/** A descriptor owns discovery independently of transient agent args.json files.
 * Only browser configuration is persisted here; agent credentials stay in runs.
 */
export function ensurePersistentBrowser(
  target: Omit<PersistentBrowser, 'id' | 'createdAt' | 'env' | 'requestedUrl'>,
  dataDir = DATA_DIR,
): PersistentBrowser {
  if (!path.posix.isAbsolute(target.workDir))
    throw new Error('Browser workspace must be absolute');
  const id =
    'browser-' +
    sha256Hex(
      JSON.stringify([
        target.projectId,
        target.conversationId,
        target.stack,
        target.service,
        target.instance,
        target.workDir,
      ]),
    ).slice(0, 40);
  const root = `/tmp/pwcli-${id}`;
  const value: PersistentBrowser = {
    ...target,
    id,
    createdAt: new Date().toISOString(),
    env: {
      CARAPA_BROWSER_SESSION_ID: id,
      CARAPA_BROWSER_WORK_DIR: target.useServiceWorkDir ? '' : target.workDir,
      PLAYWRIGHT_DAEMON_SESSION_DIR: root,
      PLAYWRIGHT_DAEMON_SOCKETS_DIR: `${root}/sockets`,
      PLAYWRIGHT_CLI_SESSION: id,
    },
  };
  const file = browserSessionFile(value, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing: PersistentBrowser = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !!existing.useServiceWorkDir !== !!target.useServiceWorkDir ||
    existing.env.CARAPA_BROWSER_WORK_DIR !== value.env.CARAPA_BROWSER_WORK_DIR
  ) {
    // Repair older descriptors without changing session identity, cookies or tabs.
    existing.useServiceWorkDir = target.useServiceWorkDir;
    existing.env.CARAPA_BROWSER_WORK_DIR = value.env.CARAPA_BROWSER_WORK_DIR;
    writeJsonFileAtomic(file, existing);
  }
  return existing;
}

export function readPersistentBrowsers(
  stack: string,
  instance: string,
  dataDir = DATA_DIR,
): PersistentBrowser[] {
  const dir = path.dirname(
    browserSessionFile({ stack, instance, id: 'valid' }, dataDir),
  );
  return readBrowserDirectory(dir, dataDir);
}

/** Include existing descriptors after a Board restart, not just sessions used this boot. */
export function readAllPersistentBrowsers(
  dataDir = DATA_DIR,
): PersistentBrowser[] {
  const ipc = path.join(dataDir, 'ipc');
  try {
    return fs
      .readdirSync(ipc, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        readBrowserDirectory(
          path.join(ipc, entry.name, 'browser-sessions'),
          dataDir,
        ),
      );
  } catch {
    return [];
  }
}

function readBrowserDirectory(
  dir: string,
  dataDir: string,
): PersistentBrowser[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^browser-[a-f0-9]{40}\.json$/.test(name))
      .flatMap((name) => {
        try {
          const file = path.join(dir, name);
          if (fs.statSync(file).size > 16 * 1024) return [];
          const value = JSON.parse(
            fs.readFileSync(file, 'utf8'),
          ) as PersistentBrowser;
          return browserSessionFile(value, dataDir) === file &&
            `${value.id}.json` === name
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
