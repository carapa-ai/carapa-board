/**
 * MCP Client wrapper for sandbox operations.
 * Uses direct REST endpoints as primary transport (stateless, no SSE connection to drop).
 * Falls back to MCP SSE transport (Streamable HTTP) if REST is unavailable.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { sleep } from './async.js';
import { logger } from '../logger.js';
import { SandboxStateObserver } from '../sandbox/state-observer.js';
import { recordSandboxStartFingerprint } from '../sandbox/mount-generation.js';
import {
  isSandboxInstanceFenced,
  trackSandboxStart,
} from './sandbox-start-fence.js';

export interface SandboxExecResult {
  stdout: string;
  stderr?: string;
  isError: boolean;
}

export type ToolCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Do not retry over MCP after a REST failure (non-idempotent tools). */
  noFallback?: boolean;
};

/**
 * Settle with `promise`, or reject with the signal's reason as soon as it
 * aborts. The underlying work is not cancelled; its late result is dropped.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * build_service runs the whole image build (including tests) synchronously
 * for non-host-request services, so it can outlast Bun's 5-minute fetch
 * default. A retry would start a second build, so never fall back.
 */
export const BUILD_SERVICE_CALL_OPTIONS: ToolCallOptions = {
  timeoutMs: 60 * 60_000,
  noFallback: true,
};

// These mutations can outlive Bun's default fetch timeout; an ambiguous
// response must not cause a second dispatch over MCP.
const SANDBOX_START_CALL_OPTIONS: ToolCallOptions = {
  timeoutMs: 10 * 60_000,
  noFallback: true,
};
const SANDBOX_BRANCH_MUTATION_CALL_OPTIONS: ToolCallOptions = {
  timeoutMs: 10 * 60_000,
  noFallback: true,
};
const SANDBOX_WORKTREE_MUTATION_CALL_OPTIONS: ToolCallOptions = {
  timeoutMs: 10 * 60_000,
  noFallback: true,
};

const DEFAULT_SANDBOX_GIT_TIMEOUT_MS = (() => {
  const configured = Number.parseInt(
    process.env.RUN_GIT_TIMEOUT_MS ?? '60000',
    10,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
})();

/** Extract text from MCP tool call result content */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: { type?: string }) => c?.type === 'text')
    .map((c: { text?: string }) => c?.text || '')
    .join('');
}

/** CarapaBox represents successful commands with empty stdout using this sentinel. */
function extractCommandOutput(content: unknown): string {
  const output = extractText(content);
  return output === '(no output)' ? '' : output;
}

function toSandboxExecResult(
  result: Record<string, unknown>,
  extractOutput: (content: unknown) => string = extractText,
): SandboxExecResult {
  return {
    stdout: extractOutput(result.content),
    isError: result.isError === true,
  };
}

const REPLICATION_CALL_TIMEOUT_MS = 30_000;

type RawToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Multi-box routing. Returns the id of the connected box that must serve this
 * call, or null for the HTTP box at CARAPA_BOX_URL. Installed at startup by
 * the box registry (src/modules/boxes/routing.ts).
 */
export type SandboxCallRouter = (
  name: string,
  args: Record<string, unknown>,
) => string | null;
export type BoxToolCaller = (
  boxId: string,
  name: string,
  args: Record<string, unknown>,
  options: ToolCallOptions,
) => Promise<unknown>;

let callRouter: SandboxCallRouter | null = null;
let boxCaller: BoxToolCaller | null = null;
let connectedRemoteBoxes: () => string[] = () => [];

export function setSandboxCallRouter(
  router: SandboxCallRouter | null,
  caller: BoxToolCaller | null,
  remoteBoxes: () => string[] = () => [],
): void {
  callRouter = router;
  boxCaller = caller;
  connectedRemoteBoxes = remoteBoxes;
}

let sandboxReachable: (args: Record<string, unknown>) => boolean = () => true;

/**
 * Install the check behind isSandboxReachable (box routing, at startup).
 */
export function setSandboxReachability(
  check: (args: Record<string, unknown>) => boolean,
): void {
  sandboxReachable = check;
}

/**
 * False when these tool arguments address a remote box that is offline.
 * Background loops skip such sandboxes instead of retrying until it returns.
 */
export function isSandboxReachable(args: Record<string, unknown>): boolean {
  return sandboxReachable(args);
}

export class SandboxClient {
  private stateObserver = new SandboxStateObserver();

  startStateMonitor(hasClients: () => boolean): () => void {
    return this.stateObserver.start(hasClients);
  }

  private client!: Client;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private logCallback: ((chunk: string) => void) | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private baseUrl: string; // REST base URL (e.g. http://localhost:3100)

  constructor(
    private url: string,
    private token?: string,
  ) {
    // Strip trailing /mcp if present so REST calls use the base URL
    this.baseUrl = url.replace(/\/mcp$/, '');
    this.initClient();
  }

  private initClient(): void {
    this.client = new Client(
      { name: 'carapa-board', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // Prevent concurrent connect attempts — second caller waits for the first
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      // If a previous transport existed, the Client still holds a ref to it.
      // Re-initialize so connect() does not throw "Already connected to a transport".
      if (this.transport) {
        try {
          await this.transport.close();
        } catch {
          /* ignore */
        }
        this.transport = null;
        this.initClient();
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers },
      });

      // Reset connection state when transport drops
      this.transport.onclose = () => {
        logger.warn({ url: this.url }, 'MCP transport closed');
        this.connected = false;
      };
      this.transport.onerror = (error: Error) => {
        logger.warn(
          { url: this.url, error: error.message },
          'MCP transport error',
        );
        this.connected = false;
      };

      // Forward logging notifications to the active callback
      this.client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        (notification) => {
          if (this.logCallback && notification.params?.data) {
            this.logCallback(String(notification.params.data));
          }
        },
      );

      await this.client.connect(this.transport);
      this.connected = true;
      this.startKeepAlive();
      logger.info({ url: this.url }, 'MCP sandbox client connected');
    })().finally(() => {
      // Always clear so future connect() attempts start fresh
      this.connecting = null;
    });

    return this.connecting;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Ping every 60s to prevent idle SSE connection drops (Docker networking)
    this.keepAliveTimer = setInterval(() => {
      if (!this.connected) return;
      this.client.ping().catch(() => {
        // Ping failure will trigger onerror/onclose → reconnect on next call
      });
    }, 60_000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.stopKeepAlive();
    if (!this.connected) return;
    try {
      await this.transport?.close();
    } catch {
      // Ignore close errors
    }
    this.connected = false;
  }

  /**
   * Force a fresh connection (new Client + transport), retrying with backoff.
   * An aborted `signal` stops the attempt (connect or backoff wait) and the
   * remaining retries, rejecting with the signal's reason.
   */
  private async reconnect(signal?: AbortSignal): Promise<void> {
    const maxAttempts = 5;
    const baseDelay = 1000; // 1s, 2s, 4s, 8s, 16s

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw signal.reason;
      await this.disconnect();
      this.initClient();
      try {
        await abortable(this.connect(), signal);
        logger.info(
          { url: this.url, attempt },
          'MCP sandbox client reconnected',
        );
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt === maxAttempts) {
          logger.error(
            { url: this.url, attempt, error: String(err) },
            'MCP reconnect failed after all attempts',
          );
          throw err;
        }
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(
          { url: this.url, attempt, nextRetryMs: delay, error: String(err) },
          'MCP reconnect attempt failed, retrying...',
        );
        await abortable(sleep(delay), signal);
      }
    }
  }

  /** Forward a log chunk to the active sandbox_exec callback, if any. */
  emitLog(chunk: string): void {
    this.logCallback?.(chunk);
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  /** Dispatch to a connected box when the router selects one. */
  private routed(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions,
  ): Promise<RawToolResult> | null {
    const boxId = callRouter?.(name, args);
    if (!boxId || !boxCaller) return null;
    return boxCaller(boxId, name, args, options) as Promise<RawToolResult>;
  }

  /** Call a tool via REST endpoint (primary transport — stateless, no SSE connection to drop) */
  private async callToolRest(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions = {},
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const routed = this.routed(name, args, options);
    if (routed) return routed;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const timeoutSignal = options.timeoutMs
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;
    const res = await fetch(`${this.baseUrl}/api/tools/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal:
        options.signal && timeoutSignal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : (timeoutSignal ?? options.signal),
      // An explicit timeoutMs replaces Bun's built-in 5-minute fetch timeout.
      ...(timeoutSignal ? { timeout: false } : {}),
    });

    // Try to parse the response body regardless of status code
    let data: { result?: string; isError?: boolean; error?: string };
    try {
      data = (await res.json()) as {
        result?: string;
        isError?: boolean;
        error?: string;
      };
    } catch {
      // Not valid JSON — this IS a transport/infrastructure error
      throw new Error(
        `REST tool call failed: ${res.status} ${res.statusText} (non-JSON response)`,
      );
    }

    // If the body has a valid tool result shape, return it — even on 500.
    // A 500 with { result, isError: true } means the tool ran but failed,
    // which is a tool-level error, not a transport failure. MCP fallback won't help.
    if (typeof data.result === 'string') {
      return {
        content: [{ type: 'text', text: data.result }],
        isError: data.isError,
      };
    }

    // No valid result in body — treat as transport failure (triggers MCP fallback)
    throw new Error(
      `REST tool call failed: ${res.status} ${res.statusText} — ${data.error ?? 'unknown'}`,
    );
  }

  /** Call a tool REST-first; fall back to MCP SSE on REST failure */
  private async callToolWithReconnect(
    name: string,
    args: Record<string, unknown>,
    options: ToolCallOptions = {},
  ) {
    const routed = this.routed(name, args, options);
    if (routed) return routed;
    // Try REST first (stateless, no connection to drop)
    try {
      return await this.callToolRest(name, args, options);
    } catch (restErr) {
      if (options.signal?.aborted || options.noFallback) throw restErr;
      logger.warn(
        { tool: name, error: String(restErr) },
        'REST tool call failed, falling back to MCP',
      );
    }

    // Fallback: MCP SSE (existing logic)
    try {
      if (!this.connected) await this.reconnect(options.signal);
      if (options.signal?.aborted) throw options.signal.reason;
      return await this.client.callTool({ name, arguments: args }, undefined, {
        signal: options.signal,
        timeout: options.timeoutMs,
      });
    } catch (mcpErr) {
      if (options.signal?.aborted) throw mcpErr;
      logger.warn(
        { tool: name, error: String(mcpErr) },
        'MCP tool call also failed, reconnecting...',
      );
      await this.reconnect(options.signal);
      if (options.signal?.aborted) throw options.signal.reason;
      return await this.client.callTool({ name, arguments: args }, undefined, {
        signal: options.signal,
        timeout: options.timeoutMs,
      });
    }
  }

  /**
   * REST only, no MCP fallback or reconnect backoff. For high-frequency,
   * idempotent calls (IPC replication) that must fail fast when Box is down.
   */
  async callToolDirect(
    name: string,
    args: Record<string, unknown>,
  ): Promise<SandboxExecResult> {
    // Bounded: a stalled Box must not hold Board boot or a kill path.
    return toSandboxExecResult(
      await this.callToolRest(name, args, {
        signal: AbortSignal.timeout(REPLICATION_CALL_TIMEOUT_MS),
        timeoutMs: REPLICATION_CALL_TIMEOUT_MS,
      }),
    );
  }

  /** Call an arbitrary MCP tool by name with REST-first transport */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<SandboxExecResult> {
    const result = await this.callToolWithReconnect(name, args, options);
    return toSandboxExecResult(result);
  }

  async sandboxExec(
    name: string,
    service: string,
    command: string,
    options?: {
      instance?: string;
      timeout?: number;
      onLog?: (chunk: string) => void;
      env?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<SandboxExecResult> {
    this.logCallback = options?.onLog || null;
    try {
      const args: Record<string, unknown> = { name, service, command };
      if (options?.instance) args.instance = options.instance;
      if (options?.timeout) args.timeout = options.timeout;
      if (options?.env && Object.keys(options.env).length > 0) {
        args.env = options.env;
      }

      const result = await this.callToolWithReconnect('sandbox_exec', args, {
        signal: options?.signal,
      });

      return toSandboxExecResult(result);
    } finally {
      this.logCallback = null;
    }
  }

  async sandboxGit(
    name: string,
    command: string,
    instance?: string,
    service?: string,
    options: ToolCallOptions & {
      waitForCompletion?: boolean;
      remoteUrl?: string;
    } = {},
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = { name, command };
    if (instance) args.instance = instance;
    if (service) args.service = service;
    if (options.remoteUrl?.trim()) args.remoteUrl = options.remoteUrl.trim();
    if (options.waitForCompletion) {
      // An abort only ends our HTTP wait, not the Git process in CarapaBox.
      // Await one dispatch without local cancellation or transport replay: a
      // failed response does not prove that it is safe to execute a merge again.
      const result = await this.callToolRest('sandbox_git', args);
      return toSandboxExecResult(result, extractCommandOutput);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_GIT_TIMEOUT_MS;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else
      options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`sandbox_git timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    timer.unref?.();

    try {
      const result = await this.callToolWithReconnect('sandbox_git', args, {
        signal: controller.signal,
        timeoutMs,
      });

      return toSandboxExecResult(result, extractCommandOutput);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  async sandboxWorktree(
    name: string,
    action: 'add' | 'reuse' | 'remove' | 'list' | 'reset',
    options?: {
      branch?: string;
      base?: string;
      instance?: string;
      localRepo?: string;
      repoPath?: string;
      symlinkFiles?: string[];
      service?: string;
      remoteUrl?: string;
    },
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = { name, action };
    if (options?.branch) args.branch = options.branch;
    if (options?.base) args.base = options.base;
    if (options?.instance) args.instance = options.instance;
    if (options?.localRepo) args.localRepo = options.localRepo;
    if (options?.repoPath) args.repoPath = options.repoPath;
    if (options?.symlinkFiles?.length) args.symlinkFiles = options.symlinkFiles;
    if (options?.service) args.service = options.service;
    if (options?.remoteUrl?.trim()) args.remoteUrl = options.remoteUrl.trim();

    return this.callTool(
      'sandbox_worktree',
      args,
      action === 'add' || action === 'remove' || action === 'reset'
        ? SANDBOX_WORKTREE_MUTATION_CALL_OPTIONS
        : undefined,
    );
  }

  async sandboxBranch(
    name: string,
    action: 'prepare_review' | 'inspect' | 'merge' | 'reject' | 'commit',
    options: {
      branch: string;
      base?: string;
      instance?: string;
      localRepo?: string;
      repoPath?: string;
      service?: string;
      autoPush?: boolean;
      worktree_path?: string;
      commitMessage?: string;
      paths?: string[];
      remoteUrl?: string;
    },
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = {
      name,
      action,
      branch: options.branch,
    };
    if (options.base) args.base = options.base;
    if (options.instance) args.instance = options.instance;
    if (options.localRepo) args.localRepo = options.localRepo;
    if (options.repoPath) args.repoPath = options.repoPath;
    if (options.service) args.service = options.service;
    if (options.autoPush) args.autoPush = options.autoPush;
    // CarapaBox's public sandbox_branch schema uses camelCase.
    if (options.worktree_path) args.worktreePath = options.worktree_path;
    if (options.commitMessage) args.commitMessage = options.commitMessage;
    if (options.paths) args.paths = options.paths;
    if (options.remoteUrl?.trim()) args.remoteUrl = options.remoteUrl.trim();

    return this.callTool(
      'sandbox_branch',
      args,
      action === 'merge' || action === 'commit' || action === 'reject'
        ? SANDBOX_BRANCH_MUTATION_CALL_OPTIONS
        : undefined,
    );
  }

  async sandboxStart(
    name: string,
    env?: Record<string, string>,
    instance?: string,
    service?: string,
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = { name };
    if (env) args.env = env;
    if (instance) args.instance = instance;
    if (service) args.service = service;

    if (isSandboxInstanceFenced(instance)) {
      return {
        stdout: `Sandbox instance ${instance} cannot start: its project is being archived`,
        isError: true,
      };
    }
    const result = await trackSandboxStart(
      instance,
      this.callTool('sandbox_start', args, SANDBOX_START_CALL_OPTIONS),
    );
    // Remember the mount layout this start requested so the board can tell
    // whether a later settings change left the running container stale.
    if (!result.isError) {
      recordSandboxStartFingerprint(name, instance, env);
    }
    return result;
  }

  async sandboxPublishApp(
    name: string,
    options: {
      instance: string;
      id: string;
      action: 'status' | 'publish' | 'unpublish';
      service?: string;
      targetPort?: number;
      hostname?: string;
      aliases?: string[];
    },
  ): Promise<SandboxExecResult> {
    return this.callTool('sandbox_publish_app', { name, ...options });
  }

  async sandboxProxyAliases(
    name: string,
    aliases: string[],
    instance?: string,
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = { name, aliases };
    if (instance) args.instance = instance;

    return this.callTool('sandbox_proxy_aliases', args);
  }

  async sandboxSsh(
    name: string,
    action: 'status' | 'start' | 'stop',
    instance: string,
  ): Promise<SandboxExecResult> {
    return this.callTool('sandbox_ssh', {
      name,
      action,
      instance,
    });
  }

  async sandboxStop(
    name: string,
    instance?: string,
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = { name };
    if (instance) args.instance = instance;

    return this.callTool('sandbox_stop', args);
  }

  async sandboxPs(instance?: string): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = {};
    if (instance) args.instance = instance;
    const read = async () => {
      const local = await this.callTool('sandbox_ps', args);
      const remotes = instance ? [] : connectedRemoteBoxes();
      if (!remotes.length || !boxCaller) return local;
      // The unfiltered list spans every connected box.
      const merged: unknown[] = [];
      const collect = (result: SandboxExecResult) => {
        if (result.isError) return;
        try {
          const parsed: unknown = JSON.parse(result.stdout);
          if (Array.isArray(parsed)) merged.push(...parsed);
        } catch {
          /* "No running sandboxes found." */
        }
      };
      collect(local);
      for (const boxId of remotes) {
        try {
          collect(
            toSandboxExecResult(
              (await boxCaller(boxId, 'sandbox_ps', {}, {})) as Record<
                string,
                unknown
              >,
            ),
          );
        } catch (err) {
          logger.warn({ boxId, err: String(err) }, 'sandbox_ps failed on box');
        }
      }
      if (local.isError && !merged.length) return local;
      return {
        stdout: merged.length
          ? JSON.stringify(merged, null, 2)
          : 'No running sandboxes found.',
        isError: false,
      };
    };
    // Instance reads bypass CarapaBox caching; monitor the shared list only.
    return instance ? read() : this.stateObserver.read('ps', read, true);
  }

  async sandboxStatus(
    name: string,
    instance?: string,
    service?: string,
    options: { observe?: boolean } = {},
  ): Promise<SandboxExecResult> {
    const args: Record<string, unknown> = { name };
    if (instance) args.instance = instance;
    if (service) args.service = service;

    return this.stateObserver.read(
      JSON.stringify(['status', name, instance, service]),
      () => this.callTool('sandbox_status', args),
      options.observe,
    );
  }
}

// Singleton instance
let _client: SandboxClient | null = null;

/** Deliver a sandbox_exec log chunk streamed by a WebSocket-connected box. */
export function forwardSandboxLog(chunk: string): void {
  _client?.emitLog(chunk);
}

export function getSandboxClient(): SandboxClient {
  if (!_client) {
    // Import config at runtime to avoid circular dependencies
    const url = process.env.CARAPA_BOX_URL || 'http://localhost:3100';
    const token = process.env.CARAPA_BOX_API_TOKEN || undefined;
    _client = new SandboxClient(url, token);
  }
  return _client;
}
