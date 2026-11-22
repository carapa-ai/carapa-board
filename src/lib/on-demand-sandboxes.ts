/**
 * OnDemandSandboxes — tracker for chat-shell sandboxes spawned on
 * demand outside the agent's normal lifecycle.
 *
 * Records are keyed by the effective sandbox owner's `projectId` and optionally
 * `${projectId}:${shellTabId}`. The project record (no `shellTabId`)
 * is the project's persistent chat shell container: started lazily
 * by `POST /api/projects/:projectId/shells` on the first tab, then
 * REUSED across all tabs in the project. Parent-owned shared sandboxes use the
 * parent's project id for both the container record and per-tab records, so
 * inheriting children discover the same open tmux sessions. It is written on first POST
 * and **never removed by user actions** — the shared record is a
 * "the container is alive" marker.
 *
 * Each per-tab record (with `shellTabId`) tracks the tab's tmux
 * session name. The per-tab DELETE forgets ONLY the per-tab record
 * and fires a server-side `tmux-tool.sh kill <tmuxSession>` against
 * the still-alive container.
 *
 * Rationale: the project's chat sandbox is meant to be long-lived
 * (analogous to a developer's terminal that they leave open across
 * projects). Tearing it down on every last-tab close was wrong — the
 * user expects "close this tab" to mean "close this tab", not "stop
 * the sandbox I'm about to use for the next tab".
 *
 * The tmux HTTP bridge uses `findByInstance` to authorize attaches,
 * so as long as SOME record (per-tab OR shared) maps to the running
 * container, the bridge works. Per-tab records give the tmux session
 * name to the route layer; the shared record is the "the container
 * is alive and the on-demand shell token was minted for it" marker
 * that the chat POST path uses to skip starting a second container.
 *
 * Records are persisted to `ipc/on-demand-sandboxes.json` so they
 * survive board restarts (mirroring the tmux-client pattern at
 * lib/tmux-client.ts).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { runtimeChanges } from './runtime-changes.js';

const INDEX_FILENAME = 'on-demand-sandboxes.json';

export interface OnDemandSandboxRecord {
  /**
   * Conversation id that originally spawned the chat shell. Recorded for
   * telemetry only — the storage key is `projectId` (and optionally
   * `shellTabId`), NOT `conversationId`. Shells therefore persist across
   * conversation switches within the same project, which is the user
   * expectation: opening a second conversation in the same project must
   * not evaporate shells the user already started.
   */
  conversationId?: string;
  /**
   * Optional per-shell discriminator. The chat bash tab allows multiple
   * shells per project (each its own tab); combining
   * `${projectId}:${shellTabId}` produces a unique storage key while
   * keeping the on-disk record flat. Must be set together with
   * `projectId`.
   */
  shellTabId?: string;
  /** Project folder (== CarapaBox instance name) the sandbox was started for. */
  projectId: string;
  stack: string;
  service: string;
  instance: string;
  /** Tmux session name to kill on teardown, if any. */
  tmuxSession?: string;
  /**
   * Plaintext agent token minted for the on-demand sandbox at start.
   * Recorded so the matching teardown path can revoke exactly that
   * one token instead of calling `revokeGroupTokens(projectId)` (which
   * would 401 the running chat agent that may be in the same group).
   *
   * The chat path intentionally does NOT revoke this token on
   * per-tab close — the persistent project container keeps running
   * and uses the token to call back into the board. The token is
   * still useful as a forensic record of "which board API token did
   * this container get". The chat POST mints a fresh token for
   * each project the first time, then reuses it across all tabs in
   * the project for the lifetime of the container.
   *
   * Optional for backward compatibility with records written before
   * this field existed — old records simply skip per-token
   * revocation.
   */
  agentToken?: string;
  /** A start has not committed; revoke its token before reuse or hydration. */
  pendingStart?: boolean;
  createdAt: number;
}

export interface OnDemandSandboxDeps {
  /** Override the IPC directory (defaults to <DATA_DIR>/ipc). */
  ipcDir?: string;
  /** Override the JSON index path (defaults to <ipcDir>/INDEX_FILENAME). */
  indexPath?: string;
}

export class OnDemandSandboxes {
  private readonly ipcDir: string;
  private readonly indexPath: string;
  /** In-memory mirror of the persisted index, keyed by
   *  `${projectId}` or `${projectId}:${shellTabId}` for chat shells. */
  private records: Record<string, OnDemandSandboxRecord> = {};
  private indexLoaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private queueWrite<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(deps: OnDemandSandboxDeps = {}) {
    this.ipcDir = deps.ipcDir ?? path.join(DATA_DIR, 'ipc');
    this.indexPath = deps.indexPath ?? path.join(this.ipcDir, INDEX_FILENAME);
    this.loadIndexSync();
  }

  /**
   * Eagerly load the persisted index so callers can resolve keys that
   * were written by a previous board process. The payload is a small JSON
   * object — sync I/O is fine.
   *
   * Only canonical project-scoped keys are loaded. Stale records from the
   * pre-release conversation/task-keyed formats remain untouched on disk but
   * are ignored, so startup never adopts the wrong sandbox or rewrites user
   * data. A subsequent explicit record/forget operation replaces the index
   * atomically with the live canonical set.
   */
  private loadIndexSync(): void {
    if (this.indexLoaded) return;
    let loaded: Record<string, OnDemandSandboxRecord> = {};
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        loaded = parsed as Record<string, OnDemandSandboxRecord>;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn(
          { path: this.indexPath, error: String(err) },
          'on-demand sandbox index read failed',
        );
      }
      this.records = {};
      this.indexLoaded = true;
      return;
    }

    const canonical: Record<string, OnDemandSandboxRecord> = {};
    for (const [storedKey, value] of Object.entries(loaded)) {
      if (!value || typeof value !== 'object') continue;
      const expectedKey = onDemandRecordKey(value);
      if (
        expectedKey &&
        expectedKey === storedKey &&
        !Object.hasOwn(value, 'taskId')
      ) {
        canonical[storedKey] = value;
      } else {
        logger.info(
          { stored_key: storedKey, project_id: value.projectId },
          'ignoring stale on-demand sandbox record',
        );
      }
    }
    this.records = canonical;
    this.indexLoaded = true;
  }

  /** Persist the in-memory index to disk atomically. */
  private async persistIndex(): Promise<void> {
    await fs.promises.mkdir(this.ipcDir, { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    await fs.promises.writeFile(
      tmp,
      JSON.stringify(this.records, null, 2),
      'utf8',
    );
    await fs.promises.rename(tmp, this.indexPath);
  }

  /**
   * Look up the project's shared chat-shell record (no `shellTabId`).
   * Returns undefined when the project has no shells at all OR when
   * it has only per-tab records — callers that want to enumerate
   * every shell for a project should use `listByProject` instead.
   */
  getByProject(projectId: string): OnDemandSandboxRecord | undefined {
    return this.records[projectId];
  }

  /**
   * Look up a specific per-shell record inside a project. Returns
   * undefined for both "project has no shells" and "project has other
   * shells, but not this one" — callers that want to enumerate should use
   * `listByProject` instead.
   */
  getByProjectTab(
    projectId: string,
    shellTabId: string,
  ): OnDemandSandboxRecord | undefined {
    return this.records[`${projectId}:${shellTabId}`];
  }

  /**
   * List every on-demand record tied to a project, in storage-key
   * order. Used by the chat bash tab to discover previously-opened
   * shells when the user revisits a conversation (or refreshes the
   * page) — the strip is project-scoped, not conversation-scoped.
   *
   * Returns a shallow copy; mutating it does not affect the in-memory
   * index.
   */
  listByProject(projectId: string): OnDemandSandboxRecord[] {
    const out: OnDemandSandboxRecord[] = [];
    for (const [key, record] of Object.entries(this.records)) {
      if (key === projectId || key.startsWith(`${projectId}:`)) {
        out.push(record);
      }
    }
    return out;
  }

  /**
   * Look up a record by CarapaBox instance name. The tmux HTTP bridge
   * uses this so project-scoped on-demand shells can attach
   * without an `active_runs` row — the on-demand tracker is the
   * source of truth for "this instance is alive because a user
   * explicitly spawned it".
   */
  findByInstance(instance: string): OnDemandSandboxRecord | undefined {
    for (const record of Object.values(this.records)) {
      if (record.instance === instance) return record;
    }
    return undefined;
  }

  /** List all currently-tracked records. */
  list(): Record<string, OnDemandSandboxRecord> {
    return { ...this.records };
  }

  /**
   * Record a freshly-spawned on-demand sandbox. Persists the updated index
   * to disk; rolls back the in-memory mutation if the write fails so the
   * next call retries from a clean slate.
   */
  async record(record: OnDemandSandboxRecord): Promise<void> {
    const key = onDemandRecordKey(record);
    if (!key) {
      throw new Error(
        'OnDemandSandboxRecord requires projectId (and optional shellTabId)',
      );
    }
    return this.queueWrite(async () => {
      const previous = this.records[key];
      this.records[key] = record;
      try {
        await this.persistIndex();
      } catch (err) {
        if (previous) this.records[key] = previous;
        else delete this.records[key];
        throw err;
      }
      if (record.shellTabId) runtimeChanges.emit('shells', record.projectId);
    });
  }

  /**
   * Update fields on an existing record (e.g. recording the tmux session
   * name once the bash tab attaches to a tmux pane). Returns the updated
   * record, or undefined if no entry exists for this key.
   */
  async update(
    key: string,
    patch: Partial<
      Omit<
        OnDemandSandboxRecord,
        | 'conversationId'
        | 'projectId'
        | 'stack'
        | 'service'
        | 'instance'
        | 'createdAt'
      >
    >,
  ): Promise<OnDemandSandboxRecord | undefined> {
    return this.queueWrite(async () => {
      const existing = this.records[key];
      if (!existing) return undefined;
      const updated: OnDemandSandboxRecord = { ...existing, ...patch };
      this.records[key] = updated;
      try {
        await this.persistIndex();
      } catch (err) {
        this.records[key] = existing;
        throw err;
      }
      if (updated.shellTabId) runtimeChanges.emit('shells', updated.projectId);
      return updated;
    });
  }

  /**
   * Remove a record from the index. Returns the removed record, or
   * undefined if no entry existed. Does NOT stop the sandbox — callers
   * are responsible for calling `client.sandboxStop` first.
   */
  async forget(key: string): Promise<OnDemandSandboxRecord | undefined> {
    return this.queueWrite(async () => {
      const existing = this.records[key];
      if (!existing) return undefined;
      delete this.records[key];
      try {
        await this.persistIndex();
      } catch (err) {
        this.records[key] = existing;
        throw err;
      }
      if (existing.shellTabId)
        runtimeChanges.emit('shells', existing.projectId);
      return existing;
    });
  }

  private async forgetMatching(
    matches: (key: string, record: OnDemandSandboxRecord) => boolean,
  ): Promise<OnDemandSandboxRecord[]> {
    return this.queueWrite(async () => {
      const removed: Array<[string, OnDemandSandboxRecord]> = [];
      for (const [key, record] of Object.entries(this.records)) {
        // A pending start owns a token until durable revocation; lifecycle
        // cleanup must not discard that ownership while a start is in flight.
        if (record.pendingStart || !matches(key, record)) continue;
        removed.push([key, record]);
        delete this.records[key];
      }
      if (removed.length === 0) return [];
      try {
        await this.persistIndex();
      } catch (err) {
        for (const [key, record] of removed) this.records[key] = record;
        throw err;
      }
      for (const owner of new Set(
        removed
          .filter(([, record]) => record.shellTabId)
          .map(([, record]) => record.projectId),
      )) {
        runtimeChanges.emit('shells', owner);
      }
      return removed.map(([, record]) => record);
    });
  }

  /**
   * Remove the shared shell record and every per-tab record for a project in
   * one persisted update. Used when the project's effective sandbox tuple
   * changes so no tab can keep routing requests to the previous container.
   */
  async forgetProject(projectId: string): Promise<OnDemandSandboxRecord[]> {
    return this.forgetMatching(
      (key) => key === projectId || key.startsWith(`${projectId}:`),
    );
  }

  /**
   * Remove every shell record backed by a sandbox instance. A container
   * restart destroys all of its tmux sessions, including projects that share
   * an inherited sandbox owner, so project-scoped cleanup is insufficient.
   */
  async forgetByInstance(instance: string): Promise<OnDemandSandboxRecord[]> {
    return this.forgetMatching((_key, record) => record.instance === instance);
  }
}

/**
 * Resolve the storage key for a record.
 *  - projectId alone (no shellTabId) → projectId
 *  - projectId + shellTabId → `${projectId}:${shellTabId}`
 * The composite form lets one project host many parallel chat shells
 * tracked independently, each with its own CarapaBox instance. Exported so
 * the route layer can build the same key when calling `forget` after
 * resolving a record by another lookup (instance, project+tab).
 */
export function onDemandRecordKey(
  record: Pick<OnDemandSandboxRecord, 'projectId' | 'shellTabId'>,
): string | null {
  if (record.projectId) {
    return record.shellTabId
      ? `${record.projectId}:${record.shellTabId}`
      : record.projectId;
  }
  return null;
}

// Singleton — matches the pattern used by getSandboxClient / TmuxClient.
let _instance: OnDemandSandboxes | null = null;

export function getOnDemandSandboxes(): OnDemandSandboxes {
  if (!_instance) {
    _instance = new OnDemandSandboxes();
  }
  return _instance;
}
