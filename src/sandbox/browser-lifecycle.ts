import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getSandboxClient, type SandboxClient } from '../lib/mcp-client.js';
import { persistRecordings } from '../modules/transcripts/transcript-store.js';
import { ipcReplica } from './ipc-replica.js';
import type { ActiveRun } from '../modules/kanban/execution/types.js';
import { getActiveRunsByStatus } from '../db.js';
import { logger } from '../logger.js';
import { webBrowserSessions } from '../modules/web/browser-sessions.js';
import {
  browserSessionFile,
  readPersistentBrowsers,
  type PersistentBrowser,
} from './browser-sessions.js';
import { isBrowserAlreadyGone } from './browser-idle.js';
import { queueTrailingIdleTrim } from './recording-trim.js';

const PERSISTENT_BROWSER_CLOSE_CONCURRENCY = 4;

type BrowserRun = Pick<
  ActiveRun,
  | 'id'
  | 'group_folder'
  | 'task_id'
  | 'sandbox_stack'
  | 'sandbox_service'
  | 'sandbox_instance'
>;
const finalizing = new Map<string, Promise<number>>();

/** Completion, recovery, and sandbox stop share one ordered finalizer. */
export function finalizeRunBrowser(
  run: BrowserRun,
  client?: SandboxClient,
): Promise<number> {
  const key = `${run.sandbox_stack}/${run.sandbox_instance || run.group_folder}/${run.id}`;
  const current = finalizing.get(key);
  if (current) return current;
  const pending = finalize(run, client).finally(() => finalizing.delete(key));
  finalizing.set(key, pending);
  return pending;
}

export async function finalizeSandboxBrowsers(
  stack: string,
  instance?: string,
  dataDir = DATA_DIR,
): Promise<void> {
  const runs = (await getActiveRunsByStatus('running')).filter(
    (run) =>
      run.sandbox_stack === stack &&
      (run.sandbox_instance || undefined) === instance,
  );
  for (const run of runs) await finalizeRunBrowser(run);
  if (instance) {
    const client = getSandboxClient();
    await forEachLimited(
      readPersistentBrowsers(stack, instance, dataDir),
      PERSISTENT_BROWSER_CLOSE_CONCURRENCY,
      (session) =>
        closePersistentBrowser(client, stack, instance, session, dataDir),
    );
  }
}

/**
 * Closing a browser that is already gone leaves nothing to reclaim, so its
 * descriptors are removed. A later use recreates them with the same id.
 */
async function closePersistentBrowser(
  client: SandboxClient,
  stack: string,
  instance: string,
  session: PersistentBrowser,
  dataDir: string,
): Promise<void> {
  try {
    const result = await client.sandboxExec(
      stack,
      session.service,
      `browser-close ${session.id}`,
      { instance, timeout: 20 },
    );
    if (
      result.isError &&
      !isBrowserAlreadyGone(result.stdout, session.service)
    ) {
      logger.warn(
        { sessionId: session.id },
        'Persistent browser cleanup reported an error',
      );
      return;
    }
    await webBrowserSessions.releaseTab(session);
    const file = browserSessionFile(session, dataDir);
    fs.rmSync(file, { force: true });
    fs.rmSync(file.replace(/\.json$/, '.activity.json'), { force: true });
  } catch (error) {
    logger.warn(
      { sessionId: session.id, error: String(error) },
      'Persistent browser cleanup failed',
    );
  }
}

/** Runs `work` over `items` with at most `limit` calls in flight. */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/** Video must finish before removing the run's discovery files. */
async function finalize(
  run: BrowserRun,
  client?: SandboxClient,
): Promise<number> {
  let videos: string[] = [];
  const safe = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
  const instance = run.sandbox_instance || run.group_folder;
  if (![run.id, run.sandbox_stack, instance].every((value) => safe.test(value)))
    return 0;
  const ipc = path.join(DATA_DIR, 'ipc', `${run.sandbox_stack}-${instance}`);
  let env: Record<string, string>;
  try {
    env = JSON.parse(
      fs.readFileSync(path.join(ipc, 'runs', run.id, 'args.json'), 'utf8'),
    ).env;
  } catch {
    return 0;
  }
  // Legacy and DirectLLM runs own no managed browser resources.
  if (env?.CARAPA_BROWSER_RUN_ID !== run.id) return 0;
  try {
    client ??= getSandboxClient();
    const branch = env.CARAPA_RECORD_SESSION;
    if (
      env.CARAPA_RECORD === '1' &&
      run.task_id &&
      safe.test(branch) &&
      env.PLAYWRIGHT_DAEMON_SESSION_DIR === `/tmp/pwcli-${branch}`
    ) {
      const stopped = await client.sandboxExec(
        run.sandbox_stack,
        run.sandbox_service,
        `record-end.sh '/tmp/pwcli-${branch}' '${branch}' '${run.id}'`,
        { instance, timeout: 30 },
      );
      if (stopped.isError)
        logger.warn(
          { runId: run.id, stdout: stopped.stdout },
          'Browser recording finalization reported an error',
        );
      else
        logger.info(
          { runId: run.id, stdout: stopped.stdout },
          'Stopped video recording',
        );
      // Recordings are written on the box host: pull them into the replica.
      const recordingsDir = path.join(ipc, 'recordings', branch);
      await ipcReplica.flushPath(recordingsDir);
      videos = persistRecordings(
        run.group_folder,
        run.task_id,
        recordingsDir,
        run.id,
      );
      // Mirror the moved-out recordings as removals on the box.
      await ipcReplica.flushPath(recordingsDir);
    }
  } catch (error) {
    logger.warn(
      { runId: run.id, error: String(error) },
      'Failed to finalize run browser recording',
    );
  } finally {
    if (client && !env.CARAPA_BROWSER_SESSION_ID)
      await client
        .sandboxExec(
          run.sandbox_stack,
          run.sandbox_service,
          `browser-close ${run.id}`,
          { instance, timeout: 20 },
        )
        .then((result) => {
          if (result.isError)
            logger.warn({ runId: run.id }, 'Browser cleanup reported an error');
        })
        .catch((error) =>
          logger.warn(
            { runId: run.id, error: String(error) },
            'Failed to close run browser',
          ),
        );
  }
  // Sandbox images need not ship ffmpeg; the board image does. Queued after
  // the browser closes so neither the run nor its browser waits on trimming.
  queueTrailingIdleTrim(videos);
  return videos.length;
}
