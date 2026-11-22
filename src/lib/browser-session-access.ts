import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { logger, serializeError } from '../logger.js';
import {
  getActiveRunById,
  getActiveRunsByStatus,
  getConversation,
  getUserById,
  userCanAccessConversation,
} from '../db.js';
import type { ActiveRun } from '../modules/kanban/execution/types.js';
import type { BrowserSession } from '../types.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import {
  browserSessionFile,
  ensurePersistentBrowser,
  readPersistentBrowsers,
  resolveConversationBrowserTarget,
  useServiceWorkDir,
  type PersistentBrowser,
} from '../sandbox/browser-sessions.js';
import { getSandboxClient, type SandboxClient } from './mcp-client.js';
import { browserIdle } from '../sandbox/browser-idle.js';
import { isNativeBoxInstance } from '../modules/boxes/routing.js';
import {
  webBrowserSessions,
  type WebBrowserSessions,
} from '../modules/web/browser-sessions.js';
import { ipcReplica } from '../sandbox/ipc-replica.js';
import { shellQuote } from '../utils.js';
import { canAccessProject } from '../routes/_helpers.js';
import { adminBypassesProject } from './project-ownership.js';

export type BrowserTarget = Pick<
  ActiveRun,
  'id' | 'sandbox_stack' | 'sandbox_service' | 'sandbox_instance'
>;
export type ManagedBrowser = {
  run: BrowserTarget;
  session: BrowserSession;
  persistent?: PersistentBrowser;
};

async function canControl(
  userId: string,
  projectId: string,
  conversationId?: string | null,
): Promise<boolean> {
  const user = await getUserById(userId);
  // The viewer re-runs this check every 2 s, so a disabled account's open
  // browser viewer ends there.
  if (!user || user.disabled) return false;
  if (!(await canAccessProject(user, projectId, { min: 'editor' })))
    return false;
  // Admins pass the project check only outside projects owned by another user
  // and then skip the conversation check; a member admin gets the check.
  if (adminBypassesProject(user, projectId)) return true;
  if (conversationId) {
    const level = await userCanAccessConversation(userId, conversationId);
    if (level !== 'owner' && level !== 'editor') return false;
  }
  return true;
}

function describePersistent(
  value: PersistentBrowser,
  run?: ActiveRun,
): ManagedBrowser {
  return {
    persistent: value,
    run: {
      id: value.id,
      sandbox_stack: value.stack,
      sandbox_service: value.service,
      sandbox_instance: value.instance,
    },
    session: {
      sessionId: value.id,
      scope: value.conversationId ? 'conversation' : 'default',
      runId: run?.id || null,
      projectId: value.projectId,
      taskId: null,
      conversationId: value.conversationId,
      worktree: value.worktree,
      agentName: run?.agent_name || null,
      startedAt: value.createdAt,
      availability: 'waiting',
    },
  };
}

async function validPersistent(
  userId: string,
  projectId: string,
  value: PersistentBrowser,
  client: Pick<SandboxClient, 'sandboxExec'> = getSandboxClient(),
): Promise<boolean> {
  if (
    value.projectId !== projectId ||
    !(await canControl(userId, projectId, value.conversationId))
  )
    return false;
  const sandbox = resolveEffectiveSandbox(projectId);
  if (
    value.stack !== sandbox.stack ||
    value.instance !== sandbox.instance ||
    value.service !== sandbox.service
  )
    return false;
  if (!value.conversationId)
    return (
      value.workDir === sandbox.workspaceRoot &&
      !value.worktree &&
      (!value.useServiceWorkDir || useServiceWorkDir(sandbox))
    );
  const conversation = await getConversation(value.conversationId);
  // Deleted conversations and replaced worktrees can never retain access.
  if (!conversation || conversation.group_folder !== projectId) return false;
  let expected;
  try {
    expected = await resolveConversationBrowserTarget(
      sandbox,
      conversation,
      client,
    );
  } catch {
    return false;
  }
  return (
    value.workDir === expected.workDir &&
    value.worktree === (conversation.worktree_path || null) &&
    (!value.useServiceWorkDir ||
      (!conversation.worktree_path &&
        !conversation.use_worktree &&
        useServiceWorkDir(sandbox)))
  );
}

async function describeRun(run: ActiveRun): Promise<ManagedBrowser | null> {
  const safe = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
  if (
    ![
      run.id,
      run.sandbox_stack,
      run.sandbox_instance || run.group_folder,
    ].every((value) => safe.test(value))
  )
    return null;
  try {
    const file = path.join(
      DATA_DIR,
      'ipc',
      `${run.sandbox_stack}-${run.sandbox_instance || run.group_folder}`,
      'runs',
      run.id,
      'args.json',
    );
    if ((await fs.stat(file)).size > 1024 * 1024) return null;
    const args = JSON.parse(await fs.readFile(file, 'utf8'));
    if (args.env?.CARAPA_BROWSER_RUN_ID !== run.id) return null;
    if (args.env.CARAPA_BROWSER_SESSION_ID) {
      const value = readPersistentBrowsers(
        run.sandbox_stack,
        run.sandbox_instance || run.group_folder,
      ).find((session) => session.id === args.env.CARAPA_BROWSER_SESSION_ID);
      return value ? describePersistent(value, run) : null;
    }
    return {
      run,
      session: {
        sessionId: run.id,
        scope: 'run',
        runId: run.id,
        projectId: run.group_folder,
        taskId: run.task_id,
        conversationId: run.conversation_id,
        worktree: args.workDir || null,
        agentName: run.agent_name,
        startedAt: run.started_at,
        availability: 'waiting',
      },
    };
  } catch {
    return null;
  }
}

export async function authorizeBrowser(
  userId: string,
  projectId: string,
  sessionId: string,
  client?: Pick<SandboxClient, 'sandboxExec'>,
): Promise<ManagedBrowser | null> {
  if (!(await canControl(userId, projectId))) return null;
  if (/^browser-[a-f0-9]{40}$/.test(sessionId)) {
    let sandbox;
    try {
      sandbox = resolveEffectiveSandbox(projectId);
    } catch {
      return null;
    }
    const value = readPersistentBrowsers(sandbox.stack, sandbox.instance).find(
      (value) => value.id === sessionId,
    );
    return value && (await validPersistent(userId, projectId, value, client))
      ? describePersistent(value)
      : null;
  }
  const run = await getActiveRunById(sessionId);
  if (
    !run ||
    run.status !== 'running' ||
    run.group_folder !== projectId ||
    !(await canControl(userId, projectId, run.conversation_id))
  )
    return null;
  const managed = await describeRun(run);
  return managed && !managed.persistent ? managed : null;
}

export async function listBrowserSessions(
  userId: string,
  projectId: string,
  conversationId?: string,
  client?: Pick<SandboxClient, 'sandboxExec'>,
): Promise<BrowserSession[] | null> {
  if (!(await canControl(userId, projectId))) return null;
  let sandbox;
  try {
    sandbox = resolveEffectiveSandbox(projectId);
  } catch {
    return [];
  }
  const target = {
    projectId,
    stack: sandbox.stack,
    instance: sandbox.instance,
    service: sandbox.service,
  };
  ensurePersistentBrowser({
    ...target,
    conversationId: null,
    workDir: sandbox.workspaceRoot,
    useServiceWorkDir: useServiceWorkDir(sandbox),
    worktree: null,
  });
  if (conversationId && (await canControl(userId, projectId, conversationId))) {
    const conversation = await getConversation(conversationId);
    if (
      conversation?.group_folder === projectId &&
      (!conversation.use_worktree || conversation.worktree_path)
    ) {
      try {
        ensurePersistentBrowser({
          ...target,
          conversationId,
          ...(await resolveConversationBrowserTarget(
            sandbox,
            conversation,
            client || getSandboxClient(),
          )),
          worktree: conversation.worktree_path || null,
        });
      } catch (error) {
        logger.warn(
          { projectId, conversationId, error: String(error) },
          'Could not prepare conversation browser',
        );
      }
    }
  }
  const sessions = new Map<string, BrowserSession>();
  for (const value of readPersistentBrowsers(sandbox.stack, sandbox.instance)) {
    if (await validPersistent(userId, projectId, value, client))
      sessions.set(value.id, describePersistent(value).session);
  }
  const runs = (await getActiveRunsByStatus('running')).filter(
    (run) => run.group_folder === projectId,
  );
  for (const run of runs) {
    if (!(await canControl(userId, projectId, run.conversation_id))) continue;
    const managed = await describeRun(run);
    if (
      managed &&
      (!managed.persistent ||
        (await validPersistent(userId, projectId, managed.persistent, client)))
    )
      sessions.set(managed.session.sessionId, managed.session);
  }
  const otherConversations = [...sessions.values()].filter(
    (session) =>
      session.scope === 'conversation' &&
      session.conversationId !== conversationId,
  );
  const open = new Set<string>();
  if (otherConversations.length) {
    // Descriptors survive Close and idle expiry. Inspect the sandbox's actual
    // browser registry without opening a viewer or refreshing idle activity.
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { readBrowser, browserIsOpen } = require(path.join(
        path.dirname(fs.realpathSync(process.argv[1])), 'browser-session.cjs'));
      const ids = JSON.parse(process.argv[2]);
      const open = ids.filter(id => {
        if (!fs.existsSync('/tmp/pwcli-' + id)) return false;
        try {
          const { env, cwd } = readBrowser(id, { forCleanup: true });
          return browserIsOpen(env, cwd);
        } catch { return false; }
      });
      process.stdout.write(JSON.stringify(open));
    `;
    try {
      const result = await (client || getSandboxClient()).sandboxExec(
        sandbox.stack,
        sandbox.service,
        `node -e ${shellQuote(script)} "$(command -v browser-open)" ${shellQuote(JSON.stringify(otherConversations.map((session) => session.sessionId)))}`,
        { instance: sandbox.instance, timeout: 20 },
      );
      if (!result.isError) {
        const ids: unknown = JSON.parse(result.stdout);
        if (Array.isArray(ids))
          for (const id of ids) if (typeof id === 'string') open.add(id);
      }
    } catch (error) {
      logger.warn(
        { projectId, error: String(error) },
        'Could not inspect open conversation browsers',
      );
    }
  }
  return [...sessions.values()]
    .filter(
      (session) =>
        session.scope !== 'conversation' ||
        session.conversationId === conversationId ||
        open.has(session.sessionId),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Only a native runner's descriptor carries a hub CDP endpoint. */
function withCdpEndpoint(
  env: Record<string, string>,
  endpoint?: string,
): Record<string, string> {
  const { PLAYWRIGHT_MCP_CDP_ENDPOINT: _stale, ...rest } = env;
  return endpoint ? { ...rest, PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint } : rest;
}

export interface BrowserControlDeps {
  isNative: (instance: string) => boolean;
  tabs: Pick<WebBrowserSessions, 'ensureTab' | 'releaseTab'>;
}
const defaultControlDeps: BrowserControlDeps = {
  isNative: isNativeBoxInstance,
  tabs: webBrowserSessions,
};

const changing = new Set<string>();
/** Explicit lifecycle controls use approved exec, never a caller-supplied command. */
export async function controlBrowser(
  userId: string,
  projectId: string,
  sessionId: string,
  action: 'start' | 'restart' | 'close',
  url?: string,
  client?: Pick<SandboxClient, 'sandboxExec'>,
  { isNative, tabs }: BrowserControlDeps = defaultControlDeps,
): Promise<void> {
  const managed = await authorizeBrowser(userId, projectId, sessionId, client);
  if (!managed?.persistent)
    throw new Error('Persistent browser session unavailable');
  if (url && action !== 'close') {
    const parsed = new URL(url);
    if (
      url.length > 4096 ||
      !['http:', 'https:', 'about:'].includes(parsed.protocol) ||
      (parsed.protocol === 'about:' && url !== 'about:blank') ||
      parsed.username ||
      parsed.password
    )
      throw new Error('Enter an HTTP or HTTPS app URL');
  }
  if (changing.has(sessionId))
    throw new Error('Browser is already changing; try again shortly');
  changing.add(sessionId);
  try {
    const value = managed.persistent;
    await browserIdle.use(value, async () => {
      // A native runner has no local Chromium: it drives a hub browser through
      // a leased CDP gateway session. The token only travels in the exec env.
      const tab =
        action !== 'close' && isNative(value.instance)
          ? await tabs.ensureTab(
              value.id,
              projectId,
              AbortSignal.timeout(30_000),
            )
          : undefined;
      try {
        if (action !== 'close') {
          const file = browserSessionFile(value);
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await fs.writeFile(
              temporary,
              JSON.stringify({
                ...value,
                env: withCdpEndpoint(value.env, tab?.endpoint),
                // Recompute on start to repair existing descriptors without changing
                // their identity or replacing a surviving browser's cookies/tabs.
                useServiceWorkDir:
                  !value.worktree &&
                  useServiceWorkDir(resolveEffectiveSandbox(projectId)),
                requestedUrl: url || undefined,
              }),
              { mode: 0o600 },
            );
            await fs.rename(temporary, file);
          } finally {
            await fs.rm(temporary, { force: true });
          }
          // A native runner reads the descriptor from its own disk: it must
          // hold the endpoint before browser-open runs.
          if (tab) await ipcReplica.flushPath(file, { strict: true });
        }
        const result = await (client || getSandboxClient()).sandboxExec(
          value.stack,
          value.service,
          action === 'close'
            ? `browser-close ${sessionId}`
            : `browser-open ${sessionId} ${action}`,
          // A project hook can start its app and authenticate the shared browser.
          {
            instance: value.instance,
            timeout: 150,
            ...(tab
              ? { env: { PLAYWRIGHT_MCP_CDP_HEADERS: tab.headers } }
              : {}),
          },
        );
        if (result.isError) {
          const error = new Error(
            `Browser ${action} failed: ${result.stdout.trim().slice(0, 4096) || 'Box returned no error detail'}`,
          );
          logger.warn(
            { projectId, sessionId, action, error },
            'Browser command failed',
          );
          throw new Error(String(serializeError(error).message));
        }
      } catch (error) {
        // A failed first start (including a dropped runner connection) leaves
        // no browser to keep the new lease for.
        if (tab?.created) await tabs.releaseTab(value);
        throw error;
      }
      if (action === 'close') await tabs.releaseTab(value);
    });
  } finally {
    changing.delete(sessionId);
  }
}
