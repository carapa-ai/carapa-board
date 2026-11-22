/**
 * Board-side replica of the Box-owned sandbox IPC tree.
 *
 * CarapaBox owns `<IPC_MOUNT>/<stack>-<instance>` on the box host. Board keeps
 * its existing `DATA_DIR/ipc/<stack>-<instance>` layout as a replica so the run
 * lifecycle, transcript and recovery code keep reading local files. Every
 * change crosses the boundary through `sandbox_ipc_sync`:
 *
 *  - local changes (Board-originated writes/deletes) are detected against the
 *    last agreed state and pushed;
 *  - remote changes are pulled: large streams resume by byte offset, small
 *    files are replaced, deletions are mirrored, and completion markers only
 *    arrive after their data.
 *  - an append chunk needs a local prefix of at least its offset (missing or
 *    short prefixes are refused, never zero-filled); a failed append is pulled
 *    again, never pushed back to the box.
 *
 * The agreed state ("base") is persisted per project, so a Board restart
 * resumes where it stopped instead of re-downloading or resurrecting files.
 *
 * When Box and Board share one directory (single host, legacy layout) the
 * marker file `<DATA_DIR>/ipc/.carapa-board-replica` is visible to Box, which
 * then reports `shared` and replication is skipped for that project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { isPathInside } from '../lib/path-containment.js';
import {
  mkdirAtSync,
  openDirAtSync,
  openFileAtSync,
  openTrustedDirSync,
  readdirAtSync,
  lstatAtSync,
  removeAtSync,
  writeChunkAtSync,
  type PinnedDir,
} from '../lib/group-fs.js';
import {
  getSandboxClient,
  isSandboxReachable,
  type SandboxExecResult,
} from '../lib/mcp-client.js';

const REPLICA_MARKER = '.carapa-board-replica';
const SMALL_FILE_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_FILES = 20000;
const PROCESS_STARTED_AT = Date.now();
const SYNC_BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_ROUNDS_PER_SYNC = 16;
const MAX_PUSH_BYTES = 16 * 1024 * 1024;

/** Must match CarapaBox `EXCLUDED_DIRS` (runtime-private directories). */
const EXCLUDED_DIRS = new Set([
  'launch.lock',
  'lifecycle.lock',
  'claude-session',
  'pi-rpc',
  'hermes-home',
  'native-history',
  'node_modules',
  '.git',
]);

const IPC_SYNC_HOT_MS = positiveInt(process.env.IPC_SYNC_HOT_MS, 250);
const IPC_SYNC_IDLE_MS = positiveInt(process.env.IPC_SYNC_IDLE_MS, 5000);
const PROJECT_IDLE_EXPIRY_MS = 60 * 60 * 1000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** [remoteSize, remoteMtimeMs|null, localSize, localMtimeMs] */
type BaseEntry = [number, number | null, number, number];

interface ProjectState {
  files: Record<string, BaseEntry>;
  dirs: string[];
}

interface SyncFile {
  path: string;
  size: number;
  mtimeMs: number;
  offset: number;
  data: string;
  replace: boolean;
  complete: boolean;
}

interface SyncResponse {
  shared?: boolean;
  pushed: Array<{
    path: string;
    ok: boolean;
    error?: string;
    size?: number;
    mtimeMs?: number;
  }>;
  files: SyncFile[];
  dirs: string[];
  deleted: string[];
  more: boolean;
  truncated?: boolean;
  unavailable?: string;
}

interface PushOp {
  op: 'write' | 'remove' | 'mkdir';
  path: string;
  data?: string;
  offset?: number;
  recursive?: boolean;
}

/** Transport for the IPC tools of the box that owns a project. */
export interface ReplicaToolClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<SandboxExecResult>;
}
export type ReplicaClientResolver = (project: string) => ReplicaToolClient;
/** Lists the IPC projects present on every connected box. */
export type ReplicaProjectLister = () => Promise<string[]>;

const defaultClient: ReplicaToolClient = {
  callTool: (name, args) => getSandboxClient().callToolDirect(name, args),
};

/** Board-owned group data that never leaves the hub. */
const GROUP_BOARD_DIRS = [
  'logs',
  'session-transcripts',
  'transcripts',
  'recordings',
];

/** Which tree a replica mirrors and how it is laid out locally. */
export interface ReplicaTreeOptions {
  tree: 'ipc' | 'group';
  localRoot: () => string;
  stateDir: () => string;
  /** Roots kept current in the background for every active project. */
  backgroundRoots: string[];
  excludedDirs: Set<string>;
  /** Top-level dirs synced per child (e.g. runs/<id>); others per top-level dir. */
  splitRoots: string[];
  /** The tree replicates the whole project directory as one root (''). */
  wholeProject: boolean;
}

const IPC_TREE: ReplicaTreeOptions = {
  tree: 'ipc',
  localRoot: () => path.join(DATA_DIR, 'ipc'),
  stateDir: () => path.join(DATA_DIR, 'ipc-replica'),
  backgroundRoots: ['runs', 'sessions', 'browser-sessions'],
  excludedDirs: EXCLUDED_DIRS,
  splitRoots: ['runs', 'sessions'],
  wholeProject: false,
};

const GROUP_TREE: ReplicaTreeOptions = {
  tree: 'group',
  localRoot: () => GROUPS_DIR,
  stateDir: () => path.join(DATA_DIR, 'group-replica'),
  backgroundRoots: [''],
  excludedDirs: new Set([...EXCLUDED_DIRS, ...GROUP_BOARD_DIRS]),
  splitRoots: [],
  wholeProject: true,
};

function relJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

/** A Box-supplied relative path: plain segments only, never '.', '..' or absolute. */
function safeRel(rel: unknown): rel is string {
  if (
    typeof rel !== 'string' ||
    !rel ||
    rel.includes('\0') ||
    rel.startsWith('/')
  ) {
    return false;
  }
  return rel
    .split('/')
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function under(rel: string, root: string): boolean {
  return !root || rel === root || rel.startsWith(`${root}/`);
}

function parseResult<T>(
  result: { stdout: string; isError: boolean },
  tool: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${tool}: ${result.stdout.slice(0, 300) || 'invalid response'}`,
    );
  }
  if (result.isError) {
    const message = (parsed as { error?: string })?.error ?? result.stdout;
    throw new Error(`${tool}: ${message}`);
  }
  return parsed as T;
}

class ProjectReplica {
  state: ProjectState = { files: {}, dirs: [] };
  private sharedState = false;
  lastActiveAt = Date.now();
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  /** No persisted state existed: older local files are not assumed to be ours. */
  /** Adopted on a first sync and not yet confirmed by a pull. */
  private adopted = new Set<string>();
  /** A pushless probe confirmed the tree is not shared (once per process). */
  private probed = false;
  /** When a shared-layout fallback (not a marker match) should be re-probed. */
  private sharedUntil = Infinity;
  /** Local stat captured when a push was read, keyed by project-relative path. */
  private pushedStats = new Map<string, { size: number; mtimeMs: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncAt = new Map<string, number>();
  private refused = new Set<string>();

  private warnApply(rel: string, err: unknown): void {
    if (this.refused.has(rel)) return;
    this.refused.add(rel);
    logger.warn(
      { err, project: this.project, path: rel },
      '[ipc-replica] Failed to apply remote entry',
    );
  }

  /** Pin the project from the board-owned tree anchor, including nested groups. */
  private openProject(create: boolean): PinnedDir | null {
    const anchorPath = path.resolve(this.owner.options.localRoot());
    const projectPath = path.resolve(this.localDir);
    if (!isPathInside(anchorPath, projectPath, { allowRoot: false }))
      throw new Error('Replica project outside tree');
    const anchor = openTrustedDirSync(anchorPath);
    if (!anchor) return null;
    try {
      return openDirAtSync(
        anchor,
        path.relative(anchorPath, projectPath).split(path.sep).join('/'),
        { create },
      );
    } finally {
      anchor.closeSync();
    }
  }

  constructor(
    readonly project: string,
    private readonly owner: IpcReplica,
  ) {}

  get localDir(): string {
    return this.owner.projectDirOf(this.project);
  }

  private get stateFile(): string {
    return path.join(this.owner.options.stateDir(), `${this.project}.json`);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.stateFile, 'utf8'),
      ) as ProjectState;
      if (raw && typeof raw.files === 'object' && Array.isArray(raw.dirs))
        this.state = raw;
    } catch {}
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(this.owner.options.stateDir(), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      logger.warn(
        { err, project: this.project },
        '[ipc-replica] Failed to persist replica state',
      );
    }
  }

  /** Serialize every sync of this project; overlapping roots share one base. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  recentlySynced(root: string, withinMs: number): boolean {
    return Date.now() - (this.lastSyncAt.get(root) ?? 0) < withinMs;
  }

  /**
   * Learn once whether the tree is shared/unavailable before sending any
   * local content. Returns false when the tree must not be replicated.
   */
  async ensureProbed(root: string): Promise<boolean> {
    if (this.shared) return false;
    if (this.probed) return true;
    const client = this.owner.clientFor(this.project);
    // Learn whether the tree is shared/unavailable before sending any
    // local content: on a single host every file would be uploaded in vain.
    let probe: SyncResponse;
    try {
      probe = parseResult<SyncResponse>(
        await client.callTool('sandbox_ipc_sync', {
          ...this.owner.treeArgs(),
          project: this.project,
          root,
          push: [],
          maxBytes: 1,
          replicaId: this.owner.replicaId(),
        }),
        'sandbox_ipc_sync',
      );
    } catch (err) {
      // The local box (old, misconfigured or unreachable) shares Board's
      // tree on a single host: never fail local launches over replication.
      if (this.owner.isLocalProject(this.project)) {
        probe = {
          pushed: [],
          files: [],
          dirs: [],
          deleted: [],
          more: false,
          unavailable: String(err),
        };
      } else {
        throw err;
      }
    }
    if (this.handleTreeStatus(probe)) return false;
    this.probed = true;
    return true;
  }

  /**
   * The box itself reported that its tree is Board's directory. The
   * "assume shared" fallback for an unreachable or outdated local box expires
   * (`sharedUntil`) and is not confirmation.
   */
  get confirmedShared(): boolean {
    return this.shared && this.sharedUntil === Infinity;
  }

  get shared(): boolean {
    if (this.sharedState && Date.now() > this.sharedUntil) this.resetStatus();
    return this.sharedState;
  }

  /** Re-detect sharing after a placement or connection change. */
  resetStatus(): void {
    this.sharedState = false;
    this.probed = false;
    this.sharedUntil = Infinity;
  }

  async sync(root: string): Promise<void> {
    if (this.shared) return;
    this.load();
    this.lastActiveAt = Date.now();
    const client = this.owner.clientFor(this.project);

    if (!(await this.ensureProbed(root))) return;
    // A whole root removed locally (run cleanup) is removed remotely in one op.
    const knownUnderRoot =
      Object.keys(this.state.files).some((rel) => under(rel, root)) ||
      this.state.dirs.some((rel) => under(rel, root));
    let rootMissing = false;
    if (root && knownUnderRoot) {
      const project = this.openProject(false);
      if (!project) rootMissing = true;
      else {
        try {
          rootMissing = lstatAtSync(project, root) === null;
        } finally {
          project.closeSync();
        }
      }
    }
    if (root && rootMissing && knownUnderRoot) {
      const result = await client.callTool('sandbox_ipc', {
        ...this.owner.treeArgs(),
        project: this.project,
        ops: [{ op: 'remove', path: root, recursive: true }],
      });
      parseResult(result, 'sandbox_ipc');
      this.forget(root);
      return;
    }

    // Unknown local files older than this process were not written by it
    // (e.g. pulled just before an unsaved shutdown): re-agree, never push.
    this.adoptExistingLocalFiles(root);
    for (let round = 0; round < MAX_ROUNDS_PER_SYNC; round++) {
      const push = round === 0 ? this.localChanges(root) : [];
      const base: Record<string, [number, number | null]> = {};
      const prefix = root ? `${root}/` : '';
      for (const [rel, entry] of Object.entries(this.state.files)) {
        // rs < 0: local-only file that predates replication; never diffed.
        if (!under(rel, root) || rel === root || entry[0] < 0) continue;
        base[rel.slice(prefix.length)] = [entry[0], entry[1]];
      }
      const result = await client.callTool('sandbox_ipc_sync', {
        ...this.owner.treeArgs(),
        project: this.project,
        root,
        base,
        push,
        maxBytes: SYNC_BUDGET_BYTES,
        replicaId: this.owner.replicaId(),
        ...(this.owner.options.tree === 'ipc'
          ? {}
          : { exclude: [...this.owner.options.excludedDirs] }),
      });
      const response = parseResult<SyncResponse>(result, 'sandbox_ipc_sync');
      if (this.handleTreeStatus(response)) return;
      this.applyPushResults(root, push, response);
      this.applyRemote(root, response);
      this.scheduleSave();
      if (!response.more) break;
    }
    this.lastSyncAt.set(root, Date.now());
  }

  /**
   * Without persisted state, local files older than this process are not
   * assumed to be Board's unpushed writes (pushing them could overwrite newer
   * remote content). They are re-agreed by size on the next pull: Box re-sends
   * what differs, and files Box lacks become local-only instead of deleted.
   */
  private adoptExistingLocalFiles(root: string): void {
    this.walkLocal(root, (projectRel, st) => {
      if (this.state.files[projectRel] || st.mtimeMs >= PROCESS_STARTED_AT)
        return;
      this.state.files[projectRel] = [st.size, null, st.size, st.mtimeMs];
      this.adopted.add(projectRel);
    });
  }

  /** Walk a local root (same exclusions as Box). Returns false when truncated. */
  private walkLocal(
    root: string,
    visit: (
      projectRel: string,
      st: fs.Stats,
      rel: string,
      dir: PinnedDir,
      name: string,
    ) => void,
    blocked?: (projectRel: string) => void,
  ): boolean {
    let count = 0;
    let readError = false;
    const walk = (dir: PinnedDir, rel: string, depth: number) => {
      if (depth > MAX_DEPTH || count >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = readdirAtSync(dir, undefined, { withFileTypes: true }) ?? [];
      } catch (err) {
        // A missing root is empty; any other failure must not look like deletions.
        if (!(rel === '' && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
          readError = true;
        }
        return;
      }
      for (const entry of entries) {
        if (count >= MAX_FILES) return;
        const childRel = relJoin(rel, entry.name);
        if (entry.isSymbolicLink()) {
          blocked?.(relJoin(root, childRel));
          continue;
        }
        if (entry.isDirectory()) {
          if (!this.owner.options.excludedDirs.has(entry.name)) {
            try {
              const sub = openDirAtSync(dir, entry.name);
              if (sub) {
                try {
                  walk(sub, childRel, depth + 1);
                } finally {
                  sub.closeSync();
                }
              }
            } catch {
              readError = true;
            }
          }
          continue;
        }
        if (!entry.isFile() || entry.name.includes('.replica-')) continue;
        let st: fs.Stats;
        try {
          const found = lstatAtSync(dir, entry.name);
          if (!found) continue;
          st = found;
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        count++;
        visit(relJoin(root, childRel), st, childRel, dir, entry.name);
      }
    };
    try {
      const project = this.openProject(false);
      if (project) {
        try {
          const target = root ? openDirAtSync(project, root) : project;
          if (target) {
            try {
              walk(target, '', 0);
            } finally {
              if (target !== project) target.closeSync();
            }
          }
        } finally {
          project.closeSync();
        }
      }
    } catch {
      readError = true;
    }
    return count < MAX_FILES && !readError;
  }

  /** True when the tree must not be replicated (shared or local fallback). */
  private handleTreeStatus(response: SyncResponse): boolean {
    if (response.unavailable) {
      // The local box predates Box-owned IPC (its controller cannot see the
      // tree): keep the single-host shared layout. A remote box must not.
      if (this.owner.isLocalProject(this.project)) {
        this.sharedState = true;
        // A fallback, not proof: look again later (Box may come back configured).
        this.sharedUntil = Date.now() + 60_000;
        logger.warn(
          { project: this.project, reason: response.unavailable },
          '[ipc-replica] Local CarapaBox cannot see the tree; assuming the shared single-host layout',
        );
        return true;
      }
      throw new Error(response.unavailable);
    }
    if (response.shared) {
      this.sharedState = true;
      logger.info(
        { project: this.project, tree: this.owner.options.tree },
        '[ipc-replica] Tree is shared with CarapaBox; replication disabled',
      );
      return true;
    }
    return false;
  }

  private forget(root: string): void {
    for (const rel of Object.keys(this.state.files))
      if (under(rel, root)) delete this.state.files[rel];
    this.state.dirs = this.state.dirs.filter((rel) => !under(rel, root));
    for (const rel of this.lastSyncAt.keys())
      if (under(rel, root)) this.lastSyncAt.delete(rel);
    this.scheduleSave();
  }

  /** Board-originated changes since the last agreed state. */
  private localChanges(root: string): PushOp[] {
    const ops: PushOp[] = [];
    const seen = new Set<string>();
    let pushBytes = 0;
    this.pushedStats.clear();
    const complete = this.walkLocal(
      root,
      (projectRel, st, childRel, dir, name) => {
        seen.add(projectRel);
        const known = this.state.files[projectRel];
        if (known && known[2] === st.size && known[3] === st.mtimeMs) return;
        if (pushBytes > MAX_PUSH_BYTES) return; // next sync
        // Large files Board extends (recovered output streams) push only the tail.
        const appendFrom =
          known &&
          known[0] >= 0 &&
          st.size > known[2] &&
          known[2] > SMALL_FILE_BYTES &&
          known[0] === known[2]
            ? known[2]
            : 0;
        let data: Buffer;
        try {
          const opened = openFileAtSync(dir, name);
          if (!opened) return;
          const fd = opened.fd;
          try {
            data = Buffer.alloc(st.size - appendFrom);
            const read = fs.readSync(fd, data, 0, data.length, appendFrom);
            data = data.subarray(0, read);
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return;
        }
        pushBytes += data.length;
        this.pushedStats.set(projectRel, {
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
        ops.push({
          op: 'write',
          path: childRel,
          data: data.toString('base64'),
          ...(appendFrom ? { offset: appendFrom } : {}),
        });
      },
      (blocked) => {
        for (const rel of Object.keys(this.state.files)) {
          if (under(rel, blocked)) seen.add(rel);
        }
      },
    );
    if (!complete) return ops; // never infer deletions from a truncated walk
    for (const [rel, entry] of Object.entries(this.state.files)) {
      if (!under(rel, root) || seen.has(rel)) continue;
      if (entry[0] < 0) {
        delete this.state.files[rel]; // local-only file deleted locally
        continue;
      }
      // Known locally and gone now: Board deleted it.
      ops.push({ op: 'remove', path: root ? rel.slice(root.length + 1) : rel });
    }
    return ops;
  }

  private applyPushResults(
    root: string,
    push: PushOp[],
    response: SyncResponse,
  ): void {
    response.pushed.forEach((result, index) => {
      const op = push[index];
      if (!op) return;
      const projectRel = relJoin(root, op.path);
      if (!result.ok) {
        logger.warn(
          { project: this.project, path: projectRel, error: result.error },
          '[ipc-replica] Push failed',
        );
        return;
      }
      if (op.op === 'remove') {
        delete this.state.files[projectRel];
        return;
      }
      if (op.op === 'write') {
        // Record the stat read with the pushed bytes: a rewrite that raced the
        // push differs from it and is pushed on the next sync.
        const st = this.pushedStats.get(projectRel);
        if (st)
          this.state.files[projectRel] = [
            result.size ?? st.size,
            result.mtimeMs ?? null,
            st.size,
            st.mtimeMs,
          ];
      }
    });
  }

  private applyRemote(root: string, response: SyncResponse): void {
    // Never trust Box paths: a compromised box must not escape the replica.
    response.dirs = response.dirs.filter(safeRel);
    response.files = response.files.filter((file) => safeRel(file.path));
    response.deleted = response.deleted.filter(
      (rel) =>
        safeRel(rel) && this.state.files[relJoin(root, rel)] !== undefined,
    );
    const remoteDirs = new Set(response.dirs.map((rel) => relJoin(root, rel)));
    for (const dir of remoteDirs) {
      try {
        const project = this.openProject(true);
        if (!project) throw new Error('Replica tree missing');
        try {
          mkdirAtSync(project, dir).closeSync();
        } finally {
          project.closeSync();
        }
      } catch (err) {
        this.warnApply(dir, err);
      }
    }
    for (const file of response.files) this.applyFile(root, file);
    // Adopted files Box does not have stay local-only; they are never deleted.
    response.deleted = response.deleted.filter((rel) => {
      const projectRel = relJoin(root, rel);
      if (!this.adopted.has(projectRel)) return true;
      const entry = this.state.files[projectRel];
      if (entry) this.state.files[projectRel] = [-1, null, entry[2], entry[3]];
      return false;
    });
    if (!response.more && !response.truncated) {
      for (const rel of this.adopted)
        if (under(rel, root)) this.adopted.delete(rel);
    }
    for (const rel of response.deleted) {
      const projectRel = relJoin(root, rel);
      const known = this.state.files[projectRel];
      try {
        const project = this.openProject(false);
        if (project) {
          try {
            const st = lstatAtSync(project, projectRel);
            // Locally modified since the agreed state: keep it; it is pushed next.
            if (st?.isSymbolicLink())
              throw new Error('Refusing symlinked replica entry');
            if (
              st &&
              known &&
              (st.size !== known[2] || st.mtimeMs !== known[3])
            )
              continue;
            removeAtSync(project, projectRel);
          } finally {
            project.closeSync();
          }
        }
        delete this.state.files[projectRel];
      } catch (err) {
        this.warnApply(projectRel, err);
      }
    }
    // Directories removed remotely (e.g. a discarded warm session).
    const previous = this.state.dirs.filter(
      (rel) => under(rel, root) && rel !== root,
    );
    const retainedDirs: string[] = [];
    for (const dir of previous.sort((a, b) => b.length - a.length)) {
      if (remoteDirs.has(dir)) continue;
      try {
        const project = this.openProject(false);
        if (project) {
          try {
            const st = lstatAtSync(project, dir);
            if (st?.isDirectory()) removeAtSync(project, dir);
            else if (st?.isSymbolicLink())
              throw new Error('Refusing symlinked replica directory');
          } finally {
            project.closeSync();
          }
        }
      } catch (err) {
        retainedDirs.push(dir);
        // Nonempty directories contain local-only data, not a refusal.
        if ((err as { errno?: string }).errno !== 'ENOTEMPTY')
          this.warnApply(dir, err);
      }
    }
    this.state.dirs = [
      ...this.state.dirs.filter((rel) => !under(rel, root) || rel === root),
      ...retainedDirs,
      ...remoteDirs,
    ];
  }

  private applyFile(root: string, file: SyncFile): void {
    const projectRel = relJoin(root, file.path);
    const data = Buffer.from(file.data, 'base64');
    const offset = file.replace && file.complete ? 0 : file.offset;
    try {
      const project = this.openProject(offset === 0);
      if (!project) throw new Error('Replica tree missing');
      let st: fs.Stats;
      try {
        st = writeChunkAtSync(
          project,
          projectRel,
          data,
          offset,
          file.complete ? new Date(file.mtimeMs) : undefined,
        );
      } finally {
        project.closeSync();
      }
      const received = file.offset + data.length;
      this.state.files[projectRel] = [
        received,
        file.complete ? file.mtimeMs : null,
        st.size,
        st.mtimeMs,
      ];
    } catch (err) {
      if (offset > 0) this.resyncAfterFailedAppend(projectRel, offset);
      this.warnApply(projectRel, err);
    }
  }

  /**
   * A failed append must not look like a Board-originated change on the next
   * scan: record what is on disk so the file is pulled again from the box.
   * An absent leaf keeps its entry (a Board deletion); a failing re-stat too.
   */
  private resyncAfterFailedAppend(projectRel: string, offset: number): void {
    try {
      const project = this.openProject(false);
      if (!project) return;
      let st: fs.Stats | null;
      try {
        st = lstatAtSync(project, projectRel);
      } finally {
        project.closeSync();
      }
      if (!st) return;
      this.state.files[projectRel] = [
        st.size === offset ? offset : 0,
        null,
        st.size,
        st.mtimeMs,
      ];
    } catch {
      /* the base stays unchanged */
    }
  }
}

export class IpcReplica {
  constructor(readonly options: ReplicaTreeOptions = IPC_TREE) {}

  private enabled: (project: string) => boolean = () => true;
  private localCheck: (project: string) => boolean = () => true;

  /** Whether a project runs on the local box (installed by the box router). */
  setLocalCheck(check: (project: string) => boolean): void {
    this.localCheck = check;
  }

  isLocalProject(project: string): boolean {
    return this.localCheck(project);
  }
  private projects = new Map<string, ProjectReplica>();
  private watchers = new Map<string, number>();
  private hotTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private resolver: ReplicaClientResolver = () => defaultClient;
  private lister: ReplicaProjectLister = async () =>
    parseResult<{ projects: string[] }>(
      await defaultClient.callTool('sandbox_ipc_projects', {}),
      'sandbox_ipc_projects',
    ).projects;
  private id: string | null = null;
  private disabled = process.env.IPC_REPLICA === 'off';

  setClientResolver(resolver: ReplicaClientResolver): void {
    this.resolver = resolver;
  }

  setProjectLister(lister: ReplicaProjectLister): void {
    this.lister = lister;
  }

  private projectDir: ((project: string) => string) | null = null;

  /**
   * Resolve a project's local directory when it is not simply
   * `<localRoot>/<project>` (group directories of nested projects live at
   * `<parent>/<child>`). Without it, or with `null`, the flat layout is used.
   */
  setProjectDir(resolve: ((project: string) => string) | null): void {
    this.projectDir = resolve;
  }

  projectDirOf(project: string): string {
    return (
      this.projectDir?.(project) ?? path.join(this.options.localRoot(), project)
    );
  }

  /** Restrict replication to some projects (group dirs: remote boxes only). */
  setEnabled(predicate: (project: string) => boolean): void {
    this.enabled = predicate;
  }

  treeArgs(): Record<string, string> {
    return this.options.tree === 'ipc' ? {} : { tree: this.options.tree };
  }

  /** False while the box owning this project is offline: skip, don't retry. */
  reachable(project: string): boolean {
    return isSandboxReachable({ ...this.treeArgs(), project });
  }

  clientFor(project: string): ReplicaToolClient {
    return this.resolver(project);
  }

  /** Stable id of this Board's IPC tree; Box reports `shared` when it sees it. */
  replicaId(): string {
    if (this.id) return this.id;
    const marker = path.join(this.options.localRoot(), REPLICA_MARKER);
    try {
      const existing = fs.readFileSync(marker, 'utf8').trim();
      if (existing) return (this.id = existing);
    } catch {
      /* create below */
    }
    const id = randomUUID();
    fs.mkdirSync(this.options.localRoot(), { recursive: true });
    fs.writeFileSync(marker, `${id}\n`);
    return (this.id = id);
  }

  private replica(project: string): ProjectReplica {
    let replica = this.projects.get(project);
    if (!replica) {
      replica = new ProjectReplica(project, this);
      this.projects.set(project, replica);
    }
    return replica;
  }

  /** Map a local path under DATA_DIR/ipc to its project and sync root. */
  locate(localPath: string): { project: string; root: string } | null {
    const localRoot = path.resolve(this.options.localRoot());
    const abs = path.resolve(localPath);
    if (!isPathInside(localRoot, abs, { allowRoot: false })) return null;
    const rel = path.relative(localRoot, abs);
    const [project, ...rest] = rel.split(path.sep);
    if (!project || project.startsWith('.')) return null;
    // A nested project's directory sits below its parent's: attribute the
    // path to the nested project, not to the parent.
    const nested = this.options.wholeProject ? rest[0] : undefined;
    if (
      nested &&
      !nested.startsWith('.') &&
      path.resolve(this.projectDirOf(nested)) ===
        path.join(this.options.localRoot(), project, nested)
    ) {
      return this.enabled(nested) ? { project: nested, root: '' } : null;
    }
    if (!this.enabled(project)) return null;
    if (this.options.wholeProject) return { project, root: '' };
    // Runs and warm sessions sync per directory; other areas per top-level dir.
    const root =
      this.options.splitRoots.includes(rest[0] ?? '') && rest[1]
        ? `${rest[0]}/${rest[1]}`
        : (rest[0] ?? '');
    return { project, root };
  }

  /**
   * Run `fn` while no sync of `project` is running or can start: every sync of
   * a project is serialized, so a sync queued meanwhile only runs afterwards.
   * For moving the project's local directory, which a sync must never see
   * half-moved (it would mirror the missing files as deletions). `fn` must not
   * itself sync the same project.
   */
  runExclusive<T>(project: string, fn: () => Promise<T>): Promise<T> {
    return this.replica(project).run(fn);
  }

  /**
   * Run `fn` with no sync of the project owning `localPath` in flight, so a
   * local removal cannot interleave with a pull that would re-create it. Runs
   * `fn` directly when the path is not replicated. `fn` must not sync.
   */
  async runExclusiveAt<T>(localPath: string, fn: () => T): Promise<T> {
    const located = this.locate(localPath);
    if (!located || this.disabled || !this.enabled(located.project))
      return fn();
    return this.runExclusive(located.project, async () => fn());
  }

  /** Sync one root now (push local changes, pull remote ones). */
  async syncRoot(project: string, root: string): Promise<void> {
    if (this.disabled || !this.enabled(project)) return;
    const replica = this.replica(project);
    if (replica.shared) return;
    await replica.run(() => replica.sync(root));
  }

  /** Sync the root containing `localPath`. Errors are logged, not thrown, unless `strict`. */
  async flushPath(
    localPath: string,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const located = this.locate(localPath);
    if (!located) return;
    try {
      await this.syncRoot(located.project, located.root);
    } catch (err) {
      if (options.strict) throw err;
      logger.warn({ err, path: localPath }, '[ipc-replica] Sync failed');
    }
  }

  /** Sync the root containing `localPath` unless it was synced within `maxAgeMs`. */
  async pollPath(localPath: string, maxAgeMs = IPC_SYNC_HOT_MS): Promise<void> {
    const located = this.locate(localPath);
    if (!located || this.disabled) return;
    const replica = this.replica(located.project);
    if (replica.shared || replica.recentlySynced(located.root, maxAgeMs))
      return;
    await this.flushPath(localPath);
  }

  /** Keep the root containing `localPath` hot until the returned disposer runs. */
  watchPath(localPath: string): () => void {
    const located = this.locate(localPath);
    if (!located || this.disabled) return () => {};
    const key = `${located.project}\u0000${located.root}`;
    this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1);
    this.ensureTimers();
    void this.flushPath(localPath);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = (this.watchers.get(key) ?? 1) - 1;
      if (count <= 0) this.watchers.delete(key);
      else this.watchers.set(key, count);
    };
  }

  /** Mark a project active so its background roots stay current. */
  touch(project: string): void {
    if (this.disabled || !this.enabled(project)) return;
    this.replica(project).lastActiveAt = Date.now();
    this.ensureTimers();
  }

  /** Sync the background roots of every project known locally or on the Box. */
  async syncAll(roots: string[] = this.options.backgroundRoots): Promise<void> {
    if (this.disabled) return;
    const projects = new Set<string>();
    try {
      for (const entry of fs.readdirSync(this.options.localRoot(), {
        withFileTypes: true,
      })) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !entry.name.includes('.stale-')
        ) {
          projects.add(entry.name);
        }
      }
    } catch {
      /* no local IPC yet */
    }
    try {
      for (const project of await this.lister()) projects.add(project);
    } catch (err) {
      // Box unreachable (or too old): recovery works from the last replica.
      logger.warn(
        { err },
        '[ipc-replica] Could not list remote IPC projects; skipping boot sync',
      );
      return;
    }
    for (const project of projects) {
      if (!this.enabled(project) || !this.reachable(project)) continue;
      this.touch(project);
      for (const root of roots) {
        try {
          await this.syncRoot(project, root);
        } catch (err) {
          logger.warn({ err, project, root }, '[ipc-replica] Boot sync failed');
        }
      }
    }
  }

  /** Remove a project's whole IPC tree on the Box (project deletion). */
  async removeProject(project: string): Promise<void> {
    if (this.disabled) return;
    const replica = this.replica(project);
    if (replica.shared) return;
    await replica.run(async () => {
      const client = this.clientFor(project);
      const listing = parseResult<{
        results: Array<{ ok: boolean; entries?: Array<{ name: string }> }>;
      }>(
        await client.callTool('sandbox_ipc', {
          ...this.treeArgs(),
          project,
          ops: [{ op: 'list', path: '' }],
        }),
        'sandbox_ipc',
      );
      const entries = listing.results[0]?.entries ?? [];
      if (entries.length) {
        parseResult(
          await client.callTool('sandbox_ipc', {
            ...this.treeArgs(),
            project,
            ops: entries.map((entry) => ({
              op: 'remove',
              path: entry.name,
              recursive: true,
            })),
          }),
          'sandbox_ipc',
        );
      }
      replica.state = { files: {}, dirs: [] };
      replica.saveNow();
    });
    this.projects.delete(project);
  }

  /** Run Box-side `prepareRuns` for a project (no-op when the tree is shared). */
  async prepareRuns(
    project: string,
    archiveUnwritable: boolean,
  ): Promise<void> {
    if (this.disabled) return;
    const replica = this.replica(project);
    // Detect a shared or unavailable tree first: a single-host Box must not
    // be asked to create or archive Board's own directory.
    if (!(await replica.run(() => replica.ensureProbed('runs')))) return;
    const response = parseResult<{
      results: Array<{ ok: boolean; error?: string }>;
    }>(
      await this.clientFor(project).callTool('sandbox_ipc', {
        project,
        ops: [{ op: 'prepareRuns', archiveUnwritable }],
      }),
      'sandbox_ipc',
    );
    const result = response.results[0];
    if (result && !result.ok)
      throw new Error(result.error || 'prepareRuns failed');
  }

  isShared(project: string): boolean {
    return this.replica(project).shared;
  }

  /**
   * Whether `project`'s local IPC directory IS the box's tree, confirmed by the
   * box (probing it if needed). When it is not, the box owns a separate tree,
   * so renaming or removing Board's directory does not touch the real data.
   * An unreachable box, or one that cannot say, is not confirmation. Replication
   * switched off (`IPC_REPLICA=off`) declares the single-host layout.
   */
  async confirmSharedTree(project: string): Promise<boolean> {
    if (this.disabled) return true;
    const replica = this.replica(project);
    await replica.run(() => replica.ensureProbed('runs'));
    return replica.confirmedShared;
  }

  /** Forget shared/probe results (placement or box connectivity changed). */
  resetStatus(): void {
    for (const replica of this.projects.values()) replica.resetStatus();
  }

  private ensureTimers(): void {
    if (!this.hotTimer) {
      this.hotTimer = setInterval(() => void this.hotTick(), IPC_SYNC_HOT_MS);
      this.hotTimer.unref?.();
    }
    if (!this.idleTimer) {
      this.idleTimer = setInterval(
        () => void this.idleTick(),
        IPC_SYNC_IDLE_MS,
      );
      this.idleTimer.unref?.();
    }
  }

  private hotBusy = false;
  private async hotTick(): Promise<void> {
    if (this.hotBusy) return;
    this.hotBusy = true;
    try {
      await Promise.all(
        [...this.watchers.keys()].map(async (key) => {
          const [project, root] = key.split('\u0000');
          if (!this.reachable(project)) return;
          try {
            await this.syncRoot(project, root);
          } catch (err) {
            logger.debug(
              { err, project, root },
              '[ipc-replica] Hot sync failed',
            );
          }
        }),
      );
    } finally {
      this.hotBusy = false;
    }
  }

  private idleBusy = false;
  private async idleTick(): Promise<void> {
    if (this.idleBusy) return;
    this.idleBusy = true;
    try {
      const now = Date.now();
      for (const [project, replica] of this.projects) {
        if (
          replica.shared ||
          !this.enabled(project) ||
          !this.reachable(project)
        )
          continue;
        const watched = [...this.watchers.keys()].some((key) =>
          key.startsWith(`${project}\u0000`),
        );
        if (!watched && now - replica.lastActiveAt > PROJECT_IDLE_EXPIRY_MS)
          continue;
        for (const root of this.options.backgroundRoots) {
          try {
            await this.syncRoot(project, root);
          } catch (err) {
            logger.debug(
              { err, project, root },
              '[ipc-replica] Background sync failed',
            );
          }
        }
      }
    } finally {
      this.idleBusy = false;
    }
  }

  /** Persist replica state and stop timers (shutdown, tests). */
  stop(): void {
    if (this.hotTimer) clearInterval(this.hotTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.hotTimer = null;
    this.idleTimer = null;
    for (const replica of this.projects.values()) replica.saveNow();
  }

  /** Test hook. */
  reset(): void {
    this.stop();
    this.projects.clear();
    this.watchers.clear();
    this.id = null;
    this.disabled = process.env.IPC_REPLICA === 'off';
  }
}

export const ipcReplica = new IpcReplica(IPC_TREE);

/**
 * Group directories of projects placed on remote boxes. Disabled until the
 * box router enables it: projects on the local box share GROUPS_DIR.
 */
export const groupReplica = new IpcReplica(GROUP_TREE);
groupReplica.setEnabled(() => false);
groupReplica.setProjectLister(async () => []);
