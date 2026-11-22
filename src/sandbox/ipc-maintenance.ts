import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getActiveRunsByStatus, getConversation } from '../db.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import type { PersistentBrowser } from './browser-sessions.js';

const DAY = 86_400_000;
const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
type Target = { stack: string; service: string; instance: string };
type Dependencies = {
  dataDir: string;
  now: number;
  activeIpc: () => Promise<Set<string>>;
  conversationExists: (id: string) => Promise<boolean>;
  exec: (target: Target, command: string) => Promise<void>;
};

async function entries(dir: string) {
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return [];
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Only rmdir is used: a concurrently created recording can never be deleted. */
export async function pruneEmptyRecordingDirectories(
  dir: string,
  cutoff: number,
): Promise<number> {
  let removed = 0;
  for (const entry of await entries(dir)) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    const before = await fs.lstat(child);
    if (!before.isDirectory() || before.mtimeMs >= cutoff) continue;
    removed += await pruneEmptyRecordingDirectories(child, cutoff);
    try {
      await fs.rmdir(child);
      removed++;
    } catch (error) {
      if (
        !['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(
          (error as NodeJS.ErrnoException).code || '',
        )
      )
        throw error;
    }
  }
  return removed;
}

/** Hourly retention of IPC artifacts; canonical transcripts and runs are untouched. */
export async function maintainIpc(
  groups: RegisteredGroup[],
  overrides: Partial<Dependencies> = {},
) {
  const deps: Dependencies = {
    dataDir: DATA_DIR,
    now: Date.now(),
    activeIpc: async () =>
      new Set(
        (await getActiveRunsByStatus('running')).map(
          (run) =>
            `${run.sandbox_stack}-${run.sandbox_instance || run.group_folder}`,
        ),
      ),
    conversationExists: async (id) => !!(await getConversation(id)),
    exec: async (target, command) => {
      const result = await getSandboxClient().sandboxExec(
        target.stack,
        target.service,
        command,
        { instance: target.instance, timeout: 60 },
      );
      if (result.isError)
        throw new Error(
          result.stderr || result.stdout || 'Sandbox maintenance failed',
        );
    },
    ...overrides,
  };
  const result = {
    recordingDirectories: 0,
    browserDescriptors: 0,
    sessionSweeps: 0,
    errors: [] as string[],
  };
  const projects = new Set(groups.map((group) => group.folder));
  const targets = new Map<string, Target>();
  for (const group of groups) {
    const value = resolveEffectiveSandbox(group, (folder) =>
      groups.find((item) => item.folder === folder),
    );
    targets.set(`${value.stack}-${value.instance}`, value);
  }
  const root = path.join(deps.dataDir, 'ipc');
  for (const entry of await entries(root)) {
    if (!entry.isDirectory()) continue;
    const ipc = path.join(root, entry.name);
    try {
      // Session ownership is checked inside the sandbox PID namespace. An
      // unrelated active or retained run must not block idle session cleanup.
      try {
        const target = targets.get(entry.name);
        if (target && (await entries(path.join(ipc, 'sessions'))).length) {
          await deps.exec(target, 'prune-ipc.sh --apply --days=7');
          result.sessionSweeps++;
        }
      } catch (error) {
        result.errors.push(`${entry.name}/sessions: ${String(error)}`);
      }
      // Retained runs may still own recordings or pending transcript recovery.
      if (
        (await deps.activeIpc()).has(entry.name) ||
        (await entries(path.join(ipc, 'runs'))).length
      )
        continue;
      result.recordingDirectories += await pruneEmptyRecordingDirectories(
        path.join(ipc, 'recordings'),
        deps.now - DAY,
      );
      for (const descriptor of await entries(
        path.join(ipc, 'browser-sessions'),
      )) {
        if (
          !descriptor.isFile() ||
          !/^browser-[a-f0-9]{40}\.json$/.test(descriptor.name)
        )
          continue;
        try {
          const file = path.join(ipc, 'browser-sessions', descriptor.name);
          const stat = await fs.lstat(file);
          if (
            !stat.isFile() ||
            stat.size > 16 * 1024 ||
            stat.mtimeMs >= deps.now - DAY
          )
            continue;
          const contents = await fs.readFile(file, 'utf8');
          const browser = JSON.parse(contents) as PersistentBrowser;
          if (
            ![
              browser.stack,
              browser.instance,
              browser.service,
              browser.id,
            ].every((value) => typeof value === 'string' && safe.test(value)) ||
            `${browser.stack}-${browser.instance}` !== entry.name ||
            `${browser.id}.json` !== descriptor.name
          )
            continue;
          const orphan =
            !projects.has(browser.projectId) ||
            (typeof browser.conversationId === 'string' &&
              !(await deps.conversationExists(browser.conversationId)));
          if (!orphan || (await deps.activeIpc()).has(entry.name)) continue;
          // Close through CarapaBox before removing discovery. Failure retains
          // the descriptor so a later pass can retry instead of losing ownership.
          await deps.exec(browser, `browser-close ${browser.id}`);
          if (
            (await deps.activeIpc()).has(entry.name) ||
            (await fs.readFile(file, 'utf8')) !== contents
          )
            continue;
          await fs.unlink(file);
          result.browserDescriptors++;
        } catch (error) {
          result.errors.push(
            `${entry.name}/browser-sessions/${descriptor.name}: ${String(error)}`,
          );
        }
      }
    } catch (error) {
      result.errors.push(`${entry.name}: ${String(error)}`);
    }
  }
  if (result.errors.length)
    logger.warn(result, 'IPC maintenance retained artifacts after errors');
  else if (
    result.recordingDirectories ||
    result.browserDescriptors ||
    result.sessionSweeps
  )
    logger.info(result, 'IPC maintenance completed');
  return result;
}
