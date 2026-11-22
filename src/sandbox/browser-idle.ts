import fs from 'node:fs';
import { BROWSER_IDLE_TIMEOUT_MS, DATA_DIR } from '../config.js';
import {
  getActiveRunForConversation,
  getActiveRunsByStatus,
  getConversation,
} from '../db.js';
import { getSandboxClient, isSandboxReachable } from '../lib/mcp-client.js';
import { logger } from '../logger.js';
import { webBrowserSessions } from '../modules/web/browser-sessions.js';
import {
  browserSessionFile,
  readAllPersistentBrowsers,
  writeJsonFileAtomic,
  type PersistentBrowser,
} from './browser-sessions.js';

interface Activity {
  lastActivityAt: number;
  closed?: boolean;
}
interface BrowserIdleDeps {
  now: () => number;
  timeoutMs: number;
  dataDir: string;
  list: () => PersistentBrowser[];
  owner: (
    browser: PersistentBrowser,
  ) => Promise<{ busy: boolean; lastActivityAt: number }>;
  /** False while the browser's box is offline: cleanup waits for it. */
  reachable?: (browser: PersistentBrowser) => boolean;
  close: (browser: PersistentBrowser) => Promise<void>;
}

/** Browser expiry never removes a conversation, descriptor, or worktree. */
export class BrowserIdleService {
  private readonly viewers = new Map<string, Set<{ visible: boolean }>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private sweeping = false;
  constructor(private readonly deps: BrowserIdleDeps) {}

  private file(browser: PersistentBrowser): string {
    return browserSessionFile(browser, this.deps.dataDir).replace(
      /\.json$/,
      '.activity.json',
    );
  }
  private read(browser: PersistentBrowser): Activity {
    try {
      const state = JSON.parse(fs.readFileSync(this.file(browser), 'utf8'));
      if (Number.isFinite(state.lastActivityAt)) return state;
    } catch {
      /* Older sessions have no activity file yet. */
    }
    return { lastActivityAt: Date.parse(browser.createdAt) || this.deps.now() };
  }
  private write(browser: PersistentBrowser, state: Activity): void {
    writeJsonFileAtomic(this.file(browser), state);
  }
  private touch(browser: PersistentBrowser): void {
    this.write(browser, { lastActivityAt: this.deps.now() });
  }
  private viewerActivity(browser: PersistentBrowser): void {
    try {
      // Hiding or detaching a viewer must not mark an expired browser as open.
      this.write(browser, {
        ...this.read(browser),
        lastActivityAt: this.deps.now(),
      });
    } catch (error) {
      logger.warn(
        { sessionId: browser.id, error: String(error) },
        'Could not persist browser viewer activity',
      );
    }
  }
  private viewed(id: string): boolean {
    return [...(this.viewers.get(id) || [])].some((viewer) => viewer.visible);
  }
  private async serialize<T>(
    id: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.operations.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.operations.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.operations.get(id) === pending) this.operations.delete(id);
    }
  }

  /** New agent launches and explicit controls wait for any expiry in progress. */
  use<T>(
    browser: PersistentBrowser,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.serialize(browser.id, () => {
      this.touch(browser);
      return operation();
    });
  }

  async view(
    browser: PersistentBrowser,
  ): Promise<{ visible: (value: boolean) => void; release: () => void }> {
    return this.use(browser, () => {
      const token = { visible: true };
      const viewers =
        this.viewers.get(browser.id) || new Set<{ visible: boolean }>();
      this.viewers.set(browser.id, viewers);
      viewers.add(token);
      let released = false;
      const visible = (value: boolean) => {
        if (released || token.visible === value) return;
        token.visible = value;
        this.viewerActivity(browser);
      };
      return {
        visible,
        release: () => {
          if (released) return;
          viewers.delete(token);
          if (!viewers.size) this.viewers.delete(browser.id);
          released = true;
          this.viewerActivity(browser);
        },
      };
    });
  }

  async sweep(): Promise<number> {
    if (this.sweeping || this.deps.timeoutMs <= 0) return 0;
    this.sweeping = true;
    let closed = 0;
    try {
      for (const browser of this.deps.list()) {
        if (this.deps.reachable && !this.deps.reachable(browser)) continue;
        try {
          await this.serialize(browser.id, async () => {
            if (this.viewed(browser.id)) return;
            const state = this.read(browser);
            if (state.closed) return;
            const owner = await this.deps.owner(browser);
            if (owner.busy) {
              this.touch(browser);
              return;
            }
            // Visibility can change while the owner lookup is in flight.
            if (this.viewed(browser.id)) return;
            const lastActivity = Math.max(
              this.read(browser).lastActivityAt,
              owner.lastActivityAt,
            );
            if (this.deps.now() - lastActivity < this.deps.timeoutMs) return;
            await this.deps.close(browser);
            this.write(browser, { lastActivityAt: lastActivity, closed: true });
            closed++;
            logger.info(
              { sessionId: browser.id, projectId: browser.projectId },
              'Expired idle browser and preview server',
            );
          });
        } catch (error) {
          logger.warn(
            { sessionId: browser.id, error: String(error) },
            'Idle browser cleanup failed; will retry',
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
    return closed;
  }
}

/** Closes the sandbox browser and releases its hub lease on a native runner. */
export async function closeIdleBrowser(
  browser: PersistentBrowser,
): Promise<void> {
  const result = await getSandboxClient().sandboxExec(
    browser.stack,
    browser.service,
    `browser-close ${browser.id}`,
    { instance: browser.instance, timeout: 20 },
  );
  // Keep the descriptor so the next explicit start/agent turn can reactivate it.
  if (result.isError && !isBrowserAlreadyGone(result.stdout, browser.service))
    throw new Error(result.stdout || 'Browser cleanup failed');
  await webBrowserSessions.releaseTab(browser);
}

export const browserIdle = new BrowserIdleService({
  now: Date.now,
  timeoutMs: BROWSER_IDLE_TIMEOUT_MS,
  dataDir: DATA_DIR,
  list: readAllPersistentBrowsers,
  reachable: (browser) => isSandboxReachable({ instance: browser.instance }),
  owner: async (browser) => {
    if (!browser.conversationId) {
      const runs = await getActiveRunsByStatus('running');
      return {
        busy: runs.some((run) => run.group_folder === browser.projectId),
        lastActivityAt: 0,
      };
    }
    const [conversation, run] = await Promise.all([
      getConversation(browser.conversationId),
      getActiveRunForConversation(browser.conversationId),
    ]);
    return {
      busy: !!run || conversation?.status === 'working',
      lastActivityAt: Math.max(
        0,
        ...[
          conversation?.created_at,
          conversation?.last_user_at,
          conversation?.last_assistant_at,
          conversation?.lastTriggeredAt,
        ].map((value) => (value ? Date.parse(value) || 0 : 0)),
      ),
    };
  },
  close: closeIdleBrowser,
});

/**
 * True when a failed `browser-close` means no live browser or app process is
 * left to reclaim: the service is not running, its sandbox is stopped, or the
 * workspace folder is gone. Any other failure stays an error and is retried.
 */
export function isBrowserAlreadyGone(stdout: string, service: string): boolean {
  return (
    stdout.trim() === `service "${service}" is not running` ||
    /Sandbox \S+ is stopped/.test(stdout) ||
    /browser-close ENOENT.*stat \/workspace\//.test(stdout)
  );
}

export function startBrowserIdleCleanup(): () => void {
  const timer = setInterval(() => {
    void browserIdle
      .sweep()
      .catch((error) => logger.warn({ error }, 'Browser idle sweep failed'));
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
