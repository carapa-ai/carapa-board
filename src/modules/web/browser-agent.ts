import crypto from 'node:crypto';
import { webBrowserSessions } from './browser-sessions.js';
import { WEB_BROWSER_AGENT_TIMEOUT_MS } from '../../config.js';
import type { ChatAgentRunResult } from '../../agent-runner.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { logger } from '../../logger.js';
import type {
  ContainerInput,
  SandboxExecutionTarget,
} from '../../mcp/mcp-runner.js';
import { getGroupByFolder } from '../../state-manager.js';
import type { RegisteredGroup } from '../../types.js';
import { resolveAgentQueryRuntime } from '../tools/core-tools.js';
import { shellQuote } from '../../utils.js';

export interface WebViewAgentContext {
  group_folder: string;
  conversation_id?: string;
  signal?: AbortSignal;
}

interface BrowserAgentRunOptions {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  agentConfig: ReturnType<typeof resolveAgentQueryRuntime>;
  signal: AbortSignal;
  timeoutSeconds: number;
  checkoutConversationId?: string;
  onCheckoutReady: NonNullable<ContainerInput['onCheckoutReady']>;
}

export interface BrowserAgentDependencies {
  getGroup: (folder: string) => RegisteredGroup | undefined;
  resolveRuntime: typeof resolveAgentQueryRuntime;
  runAgent: (options: BrowserAgentRunOptions) => Promise<ChatAgentRunResult>;
  execInSandbox: (
    target: SandboxExecutionTarget,
    command: string,
    timeoutSeconds: number,
    signal: AbortSignal,
    env?: Record<string, string>,
  ) => Promise<{ stdout: string; isError: boolean }>;
  createBrowser: typeof webBrowserSessions.create;
  closeBrowser: typeof webBrowserSessions.close;
  createSessionId: () => string;
  timeoutMs: number;
}

const defaultDependencies: BrowserAgentDependencies = {
  getGroup: getGroupByFolder,
  resolveRuntime: resolveAgentQueryRuntime,
  async runAgent(options) {
    const { runSandboxAgent } = await import('../../agent-runner.js');
    return runSandboxAgent(
      options.group,
      options.prompt,
      options.chatJid,
      undefined,
      null,
      false,
      undefined,
      undefined,
      {
        agent_cmd: options.agentConfig.id,
        agentConfig: options.agentConfig,
        signal: options.signal,
        timeout: options.timeoutSeconds,
        checkoutConversationId: options.checkoutConversationId,
        skipSharedCheckoutLease: true,
        skipUserPreferences: true,
        ephemeral: true,
        onCheckoutReady: options.onCheckoutReady,
      },
    );
  },
  async execInSandbox(target, command, timeoutSeconds, signal, env) {
    return getSandboxClient().sandboxExec(
      target.stack,
      target.service,
      command,
      {
        instance: target.instance,
        timeout: timeoutSeconds,
        signal,
        env,
      },
    );
  },
  createBrowser: (...args) => webBrowserSessions.create(...args),
  closeBrowser: (...args) => webBrowserSessions.close(...args),
  createSessionId: () => `web-view-${crypto.randomUUID()}`,
  timeoutMs: WEB_BROWSER_AGENT_TIMEOUT_MS,
};

export const BROWSER_CLEANUP_TIMEOUT_SECONDS = 15;
const WEB_VIEW_AGENT_JID_PREFIX = 'web-view-agent:';

export function webViewAgentSessionId(chatJid: string): string | undefined {
  if (!chatJid.startsWith(WEB_VIEW_AGENT_JID_PREFIX)) return undefined;
  return chatJid.slice(WEB_VIEW_AGENT_JID_PREFIX.length) || undefined;
}

export function closeBrowserSessionCommand(sessionId: string): string {
  return `playwright-cli -s=${shellQuote(sessionId)} close`;
}

function browserWorkerPrompt(url: string, sessionId: string): string {
  const successStart = `<<<CARAPA_WEB_VIEW_SUCCESS ${sessionId}>>>`;
  const successEnd = `<<<CARAPA_WEB_VIEW_END ${sessionId}>>>`;
  return [
    `Retrieve the useful page content from ${url}.`,
    `The requested page is already open in the isolated playwright-cli session ${sessionId}; use playwright-cli -s=${sessionId} and your own judgment to inspect, navigate, interact, wait, and extract as needed.`,
    'Do not call web_view.',
    `If successful, put the retrieved Markdown between these exact delimiter lines:\n${successStart}\n<retrieved Markdown>\n${successEnd}\nText outside the delimiters is ignored. If the content cannot be retrieved, briefly explain why without using the success delimiters.`,
  ].join('\n\n');
}

function timeoutValue(configured: number): number {
  return Number.isFinite(configured) && configured > 0 ? configured : 90_000;
}

function browserAgentFailure(output: ChatAgentRunResult): string {
  if (output.failed) {
    const detail = output.result?.trim();
    return detail
      ? `the sandbox agent failed: ${detail.slice(0, 1_000)}`
      : 'the sandbox agent failed';
  }
  if (output.result === null || !output.result.trim()) {
    return 'the sandbox agent returned no content';
  }
  return output.result.trim().slice(0, 1_000);
}

/** Extract only the invocation-bound success payload and add source attribution. */
export function validateBrowserAgentMarkdown(
  output: ChatAgentRunResult,
  url: string,
  sessionId: string,
): string {
  if (output.failed) {
    throw new Error(
      `Browser agent could not retrieve useful page content: ${browserAgentFailure(output)}`,
    );
  }

  const result = output.result || '';
  const successStart = `<<<CARAPA_WEB_VIEW_SUCCESS ${sessionId}>>>`;
  const successEnd = `<<<CARAPA_WEB_VIEW_END ${sessionId}>>>`;
  const lines = result.split(/\r?\n/);
  const startLines = lines.flatMap((line, index) =>
    line === successStart ? [index] : [],
  );
  const endLines = lines.flatMap((line, index) =>
    line === successEnd ? [index] : [],
  );
  if (
    startLines.length !== 1 ||
    endLines.length !== 1 ||
    startLines[0] >= endLines[0]
  ) {
    throw new Error(
      `Browser agent could not retrieve useful page content: missing or malformed success envelope; ${browserAgentFailure(output)}`,
    );
  }

  const content = lines
    .slice(startLines[0] + 1, endLines[0])
    .join('\n')
    .trim();
  if (!content) {
    throw new Error(
      'Browser agent could not retrieve useful page content: the success envelope was empty',
    );
  }

  return `> **Source**: ${url}\n\n${content}`;
}

/** Run an isolated, configured sandbox agent against an already-open browser. */
export async function retrieveWithBrowserAgent(
  url: string,
  context: WebViewAgentContext,
  dependencyOverrides: Partial<BrowserAgentDependencies> = {},
): Promise<string> {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Browser extraction supports only HTTP(S) URLs');
  }
  url = parsedUrl.toString();
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const group = dependencies.getGroup(context.group_folder);
  if (!group) {
    throw new Error(`Project "${context.group_folder}" not found`);
  }
  if (context.signal?.aborted) {
    throw new Error('Browser extraction cancelled before start');
  }

  const agentConfig = dependencies.resolveRuntime(group);
  const sessionId = dependencies.createSessionId();
  const chatJid = `${WEB_VIEW_AGENT_JID_PREFIX}${sessionId}`;
  const totalTimeoutMs = timeoutValue(dependencies.timeoutMs);
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error('Browser extraction timed out')),
    totalTimeoutMs,
  );
  timer.unref?.();
  const signal = context.signal
    ? AbortSignal.any([context.signal, timeoutController.signal])
    : timeoutController.signal;
  let sandboxTarget: SandboxExecutionTarget | undefined;
  let browserMayExist = false;
  let browserEnv: Record<string, string> | undefined;
  const expiresAt = Date.now() + totalTimeoutMs;
  let output: ChatAgentRunResult | undefined;
  let runError: unknown;

  try {
    output = await dependencies.runAgent({
      group,
      prompt: browserWorkerPrompt(url, sessionId),
      chatJid,
      agentConfig,
      signal,
      timeoutSeconds: Math.max(1, Math.ceil(totalTimeoutMs / 1000)),
      checkoutConversationId: context.conversation_id,
      onCheckoutReady: async (input, target) => {
        if (!target) {
          throw new Error('Browser extraction sandbox target was unavailable');
        }
        sandboxTarget = target;
        browserMayExist = true;
        browserEnv = await dependencies.createBrowser(
          sessionId,
          group.folder,
          input.run_id!,
          expiresAt,
          signal,
        );
        input.env = { ...input.env, ...browserEnv };
        // sandbox_exec accepts one executable with arguments, without shell
        // checks, redirection, or chaining. Surface launch errors below.
        const opened = await dependencies.execInSandbox(
          target,
          `playwright-cli -s=${shellQuote(sessionId)} open ${shellQuote(url)}`,
          Math.min(30, Math.max(1, Math.ceil(totalTimeoutMs / 1000))),
          signal,
          browserEnv,
        );
        if (opened.isError) {
          // playwright-cli can launch the named browser and then report a
          // navigation error. Keep that live session available to the agent,
          // which may be able to retry or navigate around the obstacle.
          if (!/\bbrowser\b.*\bopened\b/i.test(opened.stdout)) {
            throw new Error(
              `playwright-cli could not open the requested page: ${opened.stdout || 'command failed'}`,
            );
          }
          logger.debug(
            { sessionId, output: opened.stdout },
            'Initial browser navigation failed; delegating the live session to the agent',
          );
        }
        if (signal.aborted) throw signal.reason;
      },
    });
  } catch (error) {
    runError = error;
  } finally {
    // Revoke the remote capability immediately and clean both ends in parallel
    // so the independent cleanup budget stays at fifteen seconds overall.
    const sidecarCleanup = browserMayExist
      ? dependencies.closeBrowser(sessionId).catch(() => {
          logger.warn(
            { sessionId },
            'Sidecar cleanup failed; session expiry remains active',
          );
        })
      : Promise.resolve();
    if (sandboxTarget && browserMayExist) {
      try {
        // The run signal is necessarily aborted on cancellation or timeout.
        // Cleanup must still reach CarapaBox, so give it a separate short
        // deadline instead of reusing the signal that stopped the worker.
        const cleanupSignal = AbortSignal.timeout(
          BROWSER_CLEANUP_TIMEOUT_SECONDS * 1_000,
        );
        const closed = await dependencies.execInSandbox(
          sandboxTarget,
          closeBrowserSessionCommand(sessionId),
          BROWSER_CLEANUP_TIMEOUT_SECONDS,
          cleanupSignal,
          browserEnv,
        );
        if (closed.isError) {
          logger.warn(
            { sessionId, output: closed.stdout },
            'Browser agent session cleanup failed',
          );
        }
      } catch (error) {
        logger.warn(
          { sessionId, error },
          'Browser agent session cleanup failed',
        );
      }
    }
    await sidecarCleanup;
    clearTimeout(timer);
  }

  if (context.signal?.aborted) {
    throw new Error('Browser extraction cancelled by user');
  }
  if (timeoutController.signal.aborted) {
    throw new Error(`Browser extraction timed out after ${totalTimeoutMs}ms`);
  }
  if (runError) throw runError;
  return validateBrowserAgentMarkdown(output!, url, sessionId);
}
