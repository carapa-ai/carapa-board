import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '../../config.js';
import { sha256Hex } from '../../lib/hash.js';
import { logger } from '../../logger.js';
import { sleep } from '../../lib/async.js';
import { isRecord } from '../../lib/type-guards.js';
import {
  type PinnedDir,
  lstatAtSync,
  openFileAtSync,
  openParentDir,
  openParentDirSync,
  readFileAtSync,
  readGroupFile,
  readGroupFileSync,
  removeAt,
  removeAtSync,
  renameAtSync,
} from '../../lib/group-fs.js';

const LOCK_SUFFIX = '.transcript.flock';
const INDEX_SUFFIX = '.transcript-index.json';
const CHECKPOINT_SUFFIX = '.ingest-checkpoint.json';
const SPOOL_ID_SUFFIX = '.spool-identity.json';
const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
/** Largest transcript read into one string (V8's string length limit). */
export const TRANSCRIPT_READ_LIMIT_BYTES = 0x1fffffe8;

interface LockOwner {
  token: string;
  fd: number | null;
}

interface TranscriptIndex {
  version: 2;
  device: number;
  inode: number;
  size: number;
  records: Record<string, string[]>;
}

interface SpoolIdentity {
  id: string;
  path: string;
  device: number;
  inode: number;
  birthtimeMs: number;
}

interface SpoolTransaction {
  id: string;
  targetPath: string;
  targetOffset: number;
  /** Original transform context, retained when a transaction is rebased. */
  transformOffset?: number;
  payloadLength: number;
  payloadDigest: string;
  sourceSize: number;
  sourceDigest: string;
}

interface SpoolCheckpoint {
  version: 1;
  spool: SpoolIdentity;
  pending: SpoolTransaction | null;
  committed: SpoolTransaction | null;
}

type TranscriptFaultPoint =
  | 'after_pending_checkpoint'
  | 'after_transcript_fsync'
  | 'after_committed_checkpoint';

export interface TranscriptSpoolResult {
  appendedLines: number;
  duplicateLines: number;
  alreadyCommitted: boolean;
  checkpointPath: string;
}

export interface TranscriptSpoolOptions {
  faultInjector?: (point: TranscriptFaultPoint) => void;
  /** Independent checkpoint consumer for dual-write migrations. */
  checkpointNamespace?: string;
}

export interface TranscriptSpoolTransformContext {
  targetPath: string;
  /** Complete durable rows visible before this transaction's append point. */
  durableLines: readonly string[];
  nextOrdinal: number;
  sourceArtifactId: string;
}

const activeLockTokens = new Map<string, string>();
const lockFilesToRemove = new Set<string>();
const asyncWriteQueues = new Map<string, Promise<void>>();

function lockPathFor(transcriptPath: string): string {
  return path.join(
    DATA_DIR,
    'transcript-locks',
    `${sha256Hex(path.resolve(transcriptPath))}${LOCK_SUFFIX}`,
  );
}

function checkpointNamespaceSuffix(namespace?: string): string {
  if (namespace === undefined) return '';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(namespace)) {
    throw new Error(`Invalid transcript checkpoint namespace: ${namespace}`);
  }
  return `.${namespace}`;
}

export function transcriptCheckpointPath(
  spoolPath: string,
  namespace?: string,
): string {
  return `${spoolPath}${CHECKPOINT_SUFFIX}${checkpointNamespaceSuffix(namespace)}`;
}

function spoolIdentityPath(spoolPath: string): string {
  return `${spoolPath}${SPOOL_ID_SUFFIX}`;
}

/** Create the immutable spool identity before a harness can write its first byte. */
export function initializeTranscriptSpoolSync(spoolPath: string): string {
  const identityPath = spoolIdentityPath(spoolPath);
  try {
    const existing = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as {
      version?: unknown;
      id?: unknown;
    };
    if (existing.version === 1 && typeof existing.id === 'string') {
      return existing.id;
    }
  } catch {
    // Create it below.
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    const fd = fs.openSync(identityPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ version: 1, id })}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectorySync(path.dirname(identityPath));
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as {
      id?: unknown;
    };
    if (typeof existing.id !== 'string') {
      throw new Error(`Invalid transcript spool identity: ${identityPath}`);
    }
    return existing.id;
  }
}

function fsyncDirectorySync(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Some filesystems do not support directory fsync. File fsync and atomic
    // rename still provide the strongest durability available there.
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function atomicWriteSync(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectorySync(path.dirname(filePath));
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Run `fn` on the directory that holds `transcriptPath`, pinned by descriptor.
 * The transcripts directory is agent-writable, so every sidecar (index and
 * temp files) is addressed as an entry of this pinned directory,
 * never through the path again: swapping a directory for a symlink between
 * two operations cannot redirect them. With `create` a missing directory is
 * created (pinned, one segment at a time); otherwise `missing` answers for a
 * missing directory and, without it, a missing directory throws.
 */
function withPinnedParent<T>(
  transcriptPath: string,
  fn: (dir: PinnedDir, name: string) => T,
  opts: { create?: boolean; missing?: () => T } = {},
): T {
  const create = opts.create ?? false;
  let parent = openParentDirSync(transcriptPath, { create });
  if (!parent && create) {
    // Only a path outside GROUPS_DIR (a board-owned or temp directory) gets
    // here: its anchor is trusted, so a plain mkdir is safe.
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    parent = openParentDirSync(transcriptPath, { create });
  }
  if (!parent) {
    if (opts.missing) return opts.missing();
    throw new Error(
      `Transcript directory does not exist: ${path.dirname(transcriptPath)}`,
    );
  }
  try {
    return fn(parent.dir, parent.name);
  } finally {
    parent.dir.closeSync();
  }
}

function fsyncPinnedDirSync(dir: PinnedDir): void {
  try {
    fs.fsyncSync(dir.fd);
  } catch (error) {
    // See fsyncDirectorySync: not every filesystem supports directory fsync.
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
  }
}

async function fsyncPinnedDir(dir: PinnedDir): Promise<void> {
  const handle = await fs.promises.open(dir.self(), 'r');
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
  } finally {
    await handle.close();
  }
}

function temporaryNameFor(name: string): string {
  return `${name}.${process.pid}-${randomUUID()}.tmp`;
}

/** Durable temp + rename replacement of the entry `name` of the pinned `dir`. */
function atomicWriteAtSync(
  dir: PinnedDir,
  name: string,
  content: string | Buffer,
): void {
  const temporary = temporaryNameFor(name);
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir.entry(temporary), 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(dir.entry(temporary), dir.entry(name));
    fsyncPinnedDirSync(dir);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(dir.entry(temporary), { force: true });
  }
}

// Waiters and new writers must lock the same inode, so the flock file is only
// unlinked by `releaseLock` just before its holder unlocks;
// `tryAcquireLock` re-checks the inode after winning the flock.
type Flock = (fd: number, operation: number) => number;
let flockBackend: Flock | null | undefined;
function getFlock(): Flock | null {
  if (flockBackend !== undefined) return flockBackend;
  try {
    const { dlopen, FFIType, read } =
      require('bun:ffi') as typeof import('bun:ffi');
    for (const library of [
      'libc.so.6',
      'libc.musl-x86_64.so.1',
      'libc.musl-aarch64.so.1',
      '/lib/ld-musl-x86_64.so.1',
      '/lib/ld-musl-aarch64.so.1',
      '/usr/lib/libSystem.B.dylib',
    ]) {
      try {
        const errnoName =
          process.platform === 'darwin' ? '__error' : '__errno_location';
        const native = dlopen(library, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
          [errnoName]: { args: [], returns: FFIType.ptr },
        });
        flockBackend = (fd, operation) => {
          const result = native.symbols.flock(fd, operation);
          return result === 0
            ? 0
            : read.i32(
                native.symbols[errnoName]() as import('bun:ffi').Pointer,
                0,
              );
        };
        logger.info({ library }, 'Transcript lock backend: flock');
        return flockBackend;
      } catch {
        // Try the next platform library.
      }
    }
  } catch {
    // FFI is unavailable on this platform.
  }
  logger.error(
    'Transcript lock backend: in-process fallback; cross-process transcript writers are unsafe',
  );
  return (flockBackend = null);
}

function tryAcquireLock(transcriptPath: string): LockOwner | null {
  const lockPath = lockPathFor(transcriptPath);
  if (activeLockTokens.has(lockPath)) return null;
  const flock = getFlock();
  let fd: number | null = null;
  if (flock) {
    const acquired = withPinnedParent(
      lockPath,
      (dir, name): { fd: number } | { errno: number } => {
        for (;;) {
          const candidate = fs.openSync(
            dir.entry(name),
            fs.constants.O_CREAT |
              fs.constants.O_RDWR |
              fs.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            const errno = flock(candidate, 2 | 4); // LOCK_EX | LOCK_NB
            if (errno !== 0) {
              fs.closeSync(candidate);
              return { errno };
            }
            // A transcript delete unlinks its flock file: a lock won on an
            // unlinked inode excludes nobody, so retry on the current one.
            const held = fs.fstatSync(candidate);
            const current = lstatAtSync(dir, name);
            if (current?.ino === held.ino && current.dev === held.dev) {
              return { fd: candidate };
            }
          } catch (error) {
            fs.closeSync(candidate);
            throw error;
          }
          fs.closeSync(candidate);
        }
      },
      { create: true },
    );
    if ('errno' in acquired) {
      const { errno } = acquired;
      if (errno === (process.platform === 'darwin' ? 35 : 11) || errno === 4)
        return null;
      throw new Error(`flock failed for ${lockPath}: errno ${errno}`);
    }
    fd = acquired.fd;
  }
  const owner = { token: randomUUID(), fd };
  activeLockTokens.set(lockPath, owner.token);
  return owner;
}

function releaseLock(transcriptPath: string, owner: LockOwner): void {
  const lockPath = lockPathFor(transcriptPath);
  if (activeLockTokens.get(lockPath) !== owner.token) {
    throw new Error(`Transcript lock ownership changed for ${transcriptPath}`);
  }
  try {
    if (lockFilesToRemove.delete(lockPath)) {
      // Still holding the flock: a locker that opened the old inode re-checks
      // it after winning the lock (see `tryAcquireLock`).
      try {
        withPinnedParent(lockPath, (dir, name) => removeAtSync(dir, name), {
          missing: () => undefined,
        });
      } catch (err) {
        logger.warn({ err, lockPath }, 'Transcript flock file removal failed');
      }
    }
    if (owner.fd !== null) {
      try {
        const errno = getFlock()!(owner.fd, 8); // LOCK_UN
        if (errno !== 0) throw new Error(`flock unlock failed: errno ${errno}`);
      } finally {
        fs.closeSync(owner.fd);
      }
    }
  } finally {
    activeLockTokens.delete(lockPath);
  }
}

/**
 * True while an in-process async writer holds `transcriptPath`'s lock. A
 * synchronous caller cannot wait for such a writer, so it should skip work
 * the writer owns instead of calling `withTranscriptLockSync`.
 */
export function isTranscriptLockHeldInProcess(transcriptPath: string): boolean {
  return activeLockTokens.has(lockPathFor(transcriptPath));
}

export class TranscriptLockBusyError extends Error {
  constructor(transcriptPath: string) {
    super(`Transcript lock is busy: ${transcriptPath}`);
    this.name = 'TranscriptLockBusyError';
  }
}

function acquireLockSync(transcriptPath: string): LockOwner {
  if (activeLockTokens.has(lockPathFor(transcriptPath))) {
    throw new TranscriptLockBusyError(transcriptPath);
  }
  const owner = tryAcquireLock(transcriptPath);
  if (owner) return owner;
  throw new TranscriptLockBusyError(transcriptPath);
}

async function acquireLock(transcriptPath: string): Promise<LockOwner> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const owner = tryAcquireLock(transcriptPath);
    if (owner) return owner;
    await sleep(LOCK_POLL_MS);
  }
  throw new Error(`Timed out acquiring transcript lock: ${transcriptPath}`);
}

/** Lock paths whose async holder is running a synchronous section right now. */
const heldForSyncSection = new Set<string>();

/**
 * Wait (up to the lock timeout) for the transcript's lock, then run a
 * synchronous operation that takes the same lock internally (for example
 * `ingestTranscriptSpoolSync`) without failing as busy.
 */
export function withTranscriptLockHeld<T>(
  transcriptPath: string,
  operation: () => T,
): Promise<T> {
  return withTranscriptLock(transcriptPath, () => {
    const lockPath = lockPathFor(transcriptPath);
    heldForSyncSection.add(lockPath);
    try {
      return operation();
    } finally {
      heldForSyncSection.delete(lockPath);
    }
  });
}

export function withTranscriptLockSync<T>(
  transcriptPath: string,
  operation: () => T,
): T {
  if (heldForSyncSection.has(lockPathFor(transcriptPath))) return operation();
  const owner = acquireLockSync(transcriptPath);
  try {
    return operation();
  } finally {
    releaseLock(transcriptPath, owner);
  }
}

const deferredSyncWriteCounts = new Map<string, number>();

/**
 * Run a synchronous transcript write now, or, when the lock is contended
 * (or earlier deferred writes are still queued), queue it behind the writer
 * so it is neither lost nor reordered. The caller cannot
 * wait for a deferred write, so its failure goes to `onDeferredFailure`.
 * Uncontended writes run inline exactly like `withTranscriptLockSync`.
 */
export function withTranscriptLockSyncOrDefer(
  transcriptPath: string,
  operation: () => void,
  onDeferredFailure: (error: unknown) => void,
): void {
  if (
    !deferredSyncWriteCounts.has(transcriptPath) &&
    !activeLockTokens.has(lockPathFor(transcriptPath))
  ) {
    const owner = tryAcquireLock(transcriptPath);
    if (owner) {
      try {
        operation();
      } finally {
        releaseLock(transcriptPath, owner);
      }
      return;
    }
  }
  deferredSyncWriteCounts.set(
    transcriptPath,
    (deferredSyncWriteCounts.get(transcriptPath) ?? 0) + 1,
  );
  void withTranscriptLock(transcriptPath, operation)
    .catch(onDeferredFailure)
    .finally(() => {
      const remaining = (deferredSyncWriteCounts.get(transcriptPath) ?? 1) - 1;
      if (remaining > 0) deferredSyncWriteCounts.set(transcriptPath, remaining);
      else deferredSyncWriteCounts.delete(transcriptPath);
    });
}

export async function withTranscriptLock<T>(
  transcriptPath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = asyncWriteQueues.get(transcriptPath) ?? Promise.resolve();
  let result!: T;
  let operationError: unknown;
  let operationFailed = false;
  const queued = previous
    .catch(() => {})
    .then(async () => {
      const owner = await acquireLock(transcriptPath);
      try {
        result = await operation();
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        releaseLock(transcriptPath, owner);
      }
    });
  const settled = queued.finally(() => {
    if (asyncWriteQueues.get(transcriptPath) === settled) {
      asyncWriteQueues.delete(transcriptPath);
    }
  });
  asyncWriteQueues.set(transcriptPath, settled);
  await settled;
  if (operationFailed) throw operationError;
  return result;
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function withTranscriptLocksSync<T>(
  transcriptPaths: string[],
  operation: () => T,
): T {
  const paths = uniqueSortedPaths(transcriptPaths);
  const run = (index: number): T =>
    index === paths.length
      ? operation()
      : withTranscriptLockSync(paths[index], () => run(index + 1));
  return run(0);
}

export async function withTranscriptLocks<T>(
  transcriptPaths: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  const paths = uniqueSortedPaths(transcriptPaths);
  const run = (index: number): Promise<T> =>
    index === paths.length
      ? Promise.resolve(operation())
      : withTranscriptLock(paths[index], () => run(index + 1));
  return run(0);
}

function parseIndexedRecord(
  line: string,
): { id: string; fingerprint: string; canonical: boolean } | null {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value)) return null;
  const record = value;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    id,
    fingerprint: sha256Hex(line),
    canonical: record.schemaVersion === '1' || id.startsWith('tev1_'),
  };
}

function addIndexedRecord(
  records: Map<string, Set<string>>,
  indexed: { id: string; fingerprint: string },
): void {
  const fingerprints = records.get(indexed.id) ?? new Set<string>();
  fingerprints.add(indexed.fingerprint);
  records.set(indexed.id, fingerprints);
}

function selectLinesWithRecords(
  records: Map<string, Set<string>>,
  lines: string[],
): {
  lines: string[];
  duplicateLines: number;
  records: Map<string, Set<string>>;
} {
  const selected: string[] = [];
  let duplicateLines = 0;
  for (const line of lines) {
    const indexed = parseIndexedRecord(line);
    if (!indexed) {
      selected.push(line);
      continue;
    }
    const fingerprints = records.get(indexed.id) ?? new Set<string>();
    if (fingerprints.has(indexed.fingerprint)) {
      duplicateLines++;
      continue;
    }
    if (indexed.canonical && fingerprints.size > 0) {
      throw new Error(`Conflicting canonical transcript ID: ${indexed.id}`);
    }
    addIndexedRecord(records, indexed);
    selected.push(line);
  }
  return { lines: selected, duplicateLines, records };
}

function normalizeLines(lines: Iterable<string | unknown>): string[] {
  const normalized: string[] = [];
  for (const value of lines) {
    const line =
      typeof value === 'string' ? value.trimEnd() : JSON.stringify(value);
    if (!line.trim()) continue;
    JSON.parse(line);
    normalized.push(line);
  }
  return normalized;
}

/**
 * Open the transcript `name` of the pinned `dir` for writing without following
 * a planted symlink, and require a single-link regular file. Transcript
 * directories are agent-writable, so a symlink or hardlink could redirect the
 * append to any file the board can write.
 */
function openTranscriptForWrite(
  dir: PinnedDir,
  name: string,
  flags: number,
  mode = 0o600,
): number {
  const fd = fs.openSync(
    dir.entry(name),
    flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    mode,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(
        `Refusing to write transcript that is not a single-link regular file: ${path.join(dir.label, name)}`,
      );
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function truncateTranscriptSync(transcriptPath: string, size: number): void {
  withPinnedParent(transcriptPath, (dir, name) => {
    const fd = openTranscriptForWrite(dir, name, fs.constants.O_RDWR);
    try {
      fs.ftruncateSync(fd, size);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
}

function repairTrailingRecordUnderLock(transcriptPath: string): void {
  withPinnedParent(
    transcriptPath,
    (dir, name) => {
      if (!lstatAtSync(dir, name)) return;
      // Read, append and truncate through one validated handle so the path
      // cannot be swapped for a link between the check and the write.
      const fd = openTranscriptForWrite(
        dir,
        name,
        fs.constants.O_RDWR | fs.constants.O_APPEND,
      );
      try {
        const size = fs.fstatSync(fd).size;
        if (size === 0) return;
        const lastByte = Buffer.allocUnsafe(1);
        if (fs.readSync(fd, lastByte, 0, 1, size - 1) !== 1) {
          throw new Error('Could not read transcript tail');
        }
        if (lastByte[0] === 0x0a) return;
        const chunks: Buffer[] = [];
        let position = size;
        let trailingStart = 0;
        while (position > 0) {
          const length = Math.min(position, 64 * 1024);
          position -= length;
          const chunk = Buffer.allocUnsafe(length);
          if (fs.readSync(fd, chunk, 0, length, position) !== length) {
            throw new Error('Could not read transcript tail');
          }
          const newline = chunk.lastIndexOf(0x0a);
          if (newline !== -1) {
            trailingStart = position + newline + 1;
            chunks.unshift(chunk.subarray(newline + 1));
            break;
          }
          chunks.unshift(chunk);
        }
        const trailing = Buffer.concat(chunks);
        let completeRecord = true;
        try {
          JSON.parse(trailing.toString('utf8'));
        } catch {
          completeRecord = false;
        }
        if (completeRecord) {
          fs.writeSync(fd, '\n');
        } else {
          if (trailing.length > 0) {
            atomicWriteAtSync(
              dir,
              `${name}.partial-${Date.now()}-${randomUUID()}`,
              trailing,
            );
          }
          fs.ftruncateSync(fd, trailingStart);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    { missing: () => undefined },
  );
}

function serializeIndexRecords(
  records: Map<string, Set<string>>,
): Record<string, string[]> {
  return Object.fromEntries(
    [...records].map(([id, fingerprints]) => [id, [...fingerprints]]),
  );
}

const NO_STAT = { dev: 0, ino: 0, size: 0 };

function readTranscriptBytes(dir: PinnedDir, name: string): Buffer | null {
  return (
    readFileAtSync(dir, name, { maxBytes: TRANSCRIPT_READ_LIMIT_BYTES })
      ?.data ?? null
  );
}

/** Whole transcript through a pinned parent; null when it does not exist. */
function readTranscriptBytesUnderLock(transcriptPath: string): Buffer | null {
  return withPinnedParent(
    transcriptPath,
    (dir, name) => readTranscriptBytes(dir, name),
    { missing: () => null },
  );
}

function transcriptSizeUnderLock(transcriptPath: string): number {
  return withPinnedParent(
    transcriptPath,
    (dir, name) => lstatAtSync(dir, name)?.size ?? 0,
    { missing: () => 0 },
  );
}

function buildIndexAt(dir: PinnedDir, name: string): TranscriptIndex {
  const records = new Map<string, Set<string>>();
  const read = readFileAtSync(dir, name, {
    maxBytes: TRANSCRIPT_READ_LIMIT_BYTES,
  });
  if (read) {
    for (const line of read.data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const indexed = parseIndexedRecord(line);
        if (indexed) addIndexedRecord(records, indexed);
      } catch {
        // Only an incomplete final line may be repaired automatically. A
        // malformed complete row is preserved and intentionally not indexed.
      }
    }
  }
  const stat = read?.stat ?? NO_STAT;
  return {
    version: 2,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    records: serializeIndexRecords(records),
  };
}

function loadIndexUnderLock(transcriptPath: string): TranscriptIndex {
  return withPinnedParent(
    transcriptPath,
    (dir, name) => {
      const indexName = `${name}${INDEX_SUFFIX}`;
      try {
        const read = readFileAtSync(dir, indexName, {
          maxBytes: MAX_INDEX_BYTES,
        });
        if (read) {
          const index = JSON.parse(
            read.data.toString('utf8'),
          ) as TranscriptIndex;
          const stat = lstatAtSync(dir, name) ?? NO_STAT;
          if (
            index.version === 2 &&
            index.device === stat.dev &&
            index.inode === stat.ino &&
            index.size === stat.size &&
            index.records !== null &&
            typeof index.records === 'object'
          ) {
            return index;
          }
        }
      } catch {
        // Missing, stale, oversized and refused (link, FIFO) indexes are
        // rebuilt from the durable transcript.
      }
      const index = buildIndexAt(dir, name);
      atomicWriteAtSync(dir, indexName, `${JSON.stringify(index)}\n`);
      return index;
    },
    { create: true },
  );
}

function writeIndexUnderLock(transcriptPath: string): void {
  withPinnedParent(
    transcriptPath,
    (dir, name) =>
      atomicWriteAtSync(
        dir,
        `${name}${INDEX_SUFFIX}`,
        `${JSON.stringify(buildIndexAt(dir, name))}\n`,
      ),
    { create: true },
  );
}

function writeKnownIndexUnderLock(
  transcriptPath: string,
  records: Map<string, Set<string>>,
): void {
  withPinnedParent(transcriptPath, (dir, name) => {
    const stat = lstatAtSync(dir, name);
    if (!stat) throw new Error(`Transcript does not exist: ${transcriptPath}`);
    const index: TranscriptIndex = {
      version: 2,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      records: serializeIndexRecords(records),
    };
    atomicWriteAtSync(
      dir,
      `${name}${INDEX_SUFFIX}`,
      `${JSON.stringify(index)}\n`,
    );
  });
}

function selectNewLinesUnderLock(
  transcriptPath: string,
  lines: string[],
): {
  lines: string[];
  duplicateLines: number;
  records: Map<string, Set<string>>;
} {
  const index = loadIndexUnderLock(transcriptPath);
  const records = new Map(
    Object.entries(index.records).map(([id, fingerprints]) => [
      id,
      new Set(fingerprints),
    ]),
  );
  return selectLinesWithRecords(records, lines);
}

function selectNewLinesAtOffsetUnderLock(
  transcriptPath: string,
  targetOffset: number,
  lines: string[],
): {
  lines: string[];
  duplicateLines: number;
  records: Map<string, Set<string>>;
} {
  const records = new Map<string, Set<string>>();
  if (targetOffset > 0) {
    const prefix = (
      readTranscriptBytesUnderLock(transcriptPath) ?? Buffer.alloc(0)
    ).subarray(0, targetOffset);
    if (prefix.length !== targetOffset) {
      throw new Error('Transcript is shorter than the pending spool offset');
    }
    for (const line of prefix.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const indexed = parseIndexedRecord(line);
        if (indexed) addIndexedRecord(records, indexed);
      } catch {
        // Preserve malformed historical rows, matching index rebuild behavior.
      }
    }
  }
  return selectLinesWithRecords(records, lines);
}

function appendBytesUnderLock(transcriptPath: string, payload: Buffer): number {
  return withPinnedParent(
    transcriptPath,
    (dir, name) => {
      const before = lstatAtSync(dir, name);
      const offset = before?.size ?? 0;
      if (payload.length === 0) return offset;
      const fd = openTranscriptForWrite(
        dir,
        name,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      );
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (!before) fsyncPinnedDirSync(dir);
      return offset;
    },
    { create: true },
  );
}

export interface AppendTranscriptLinesResult {
  appendedLines: number;
  duplicateLines: number;
  /** Bytes written by this call; set only when lines were appended. */
  appendedRange?: { byteOffset: number; byteEndOffset: number };
}

export function appendTranscriptLinesUnderLock(
  transcriptPath: string,
  lines: Iterable<string | unknown>,
): AppendTranscriptLinesResult {
  repairTrailingRecordUnderLock(transcriptPath);
  const normalized = normalizeLines(lines);
  const selected = selectNewLinesUnderLock(transcriptPath, normalized);
  let appendedRange: AppendTranscriptLinesResult['appendedRange'];
  if (selected.lines.length > 0) {
    const payload = Buffer.from(`${selected.lines.join('\n')}\n`);
    const byteOffset = appendBytesUnderLock(transcriptPath, payload);
    appendedRange = { byteOffset, byteEndOffset: byteOffset + payload.length };
    writeKnownIndexUnderLock(transcriptPath, selected.records);
  }
  return {
    appendedLines: selected.lines.length,
    duplicateLines: selected.duplicateLines,
    ...(appendedRange ? { appendedRange } : {}),
  };
}

export function appendTranscriptLinesSync(
  transcriptPath: string,
  lines: Iterable<string | unknown>,
  prepareUnderLock?: () => unknown,
): AppendTranscriptLinesResult {
  return withTranscriptLockSync(transcriptPath, () => {
    prepareUnderLock?.();
    return appendTranscriptLinesUnderLock(transcriptPath, lines);
  });
}

export function appendTranscriptLines(
  transcriptPath: string,
  lines: Iterable<string | unknown>,
  prepareUnderLock?: () => Promise<unknown> | unknown,
): Promise<AppendTranscriptLinesResult> {
  return withTranscriptLock(transcriptPath, () => {
    const preparation = prepareUnderLock?.();
    if (
      preparation &&
      typeof (preparation as PromiseLike<unknown>).then === 'function'
    ) {
      return Promise.resolve(preparation).then(() =>
        appendTranscriptLinesUnderLock(transcriptPath, lines),
      );
    }
    return appendTranscriptLinesUnderLock(transcriptPath, lines);
  });
}

export function replaceTranscriptUnderLock(
  transcriptPath: string,
  content: string | Buffer,
): void {
  withPinnedParent(
    transcriptPath,
    (dir, name) => atomicWriteAtSync(dir, name, content),
    { create: true },
  );
  writeIndexUnderLock(transcriptPath);
}

export function replaceTranscriptSync(
  transcriptPath: string,
  content: string | Buffer,
): void {
  withTranscriptLockSync(transcriptPath, () =>
    replaceTranscriptUnderLock(transcriptPath, content),
  );
}

/**
 * Mark the transcript's flock file for unlinking when its lock is released, so
 * `transcript-locks` does not grow by one file per transcript ever written.
 * Unlinking earlier would let another process lock a fresh inode while the
 * caller still holds the old one. The caller holds the lock; later lockers
 * recreate the file (see `tryAcquireLock`).
 */
function removeLockFileOnRelease(transcriptPath: string): void {
  lockFilesToRemove.add(lockPathFor(transcriptPath));
}

export function deleteTranscriptUnderLock(transcriptPath: string): void {
  withPinnedParent(
    transcriptPath,
    (dir, name) => {
      removeAtSync(dir, name);
      removeAtSync(dir, `${name}${INDEX_SUFFIX}`);
      fsyncPinnedDirSync(dir);
    },
    { missing: () => undefined },
  );
  removeLockFileOnRelease(transcriptPath);
}

/**
 * Delete the transcript `name` and its index sidecar from the already pinned
 * `dir`. The caller holds the transcript's lock.
 */
export async function deleteTranscriptInDirUnderLockAsync(
  dir: PinnedDir,
  name: string,
  transcriptPath: string,
): Promise<void> {
  await removeAt(dir, name);
  await removeAt(dir, `${name}${INDEX_SUFFIX}`);
  await fsyncPinnedDir(dir);
  removeLockFileOnRelease(transcriptPath);
}

export async function deleteTranscriptUnderLockAsync(
  transcriptPath: string,
): Promise<void> {
  const parent = await openParentDir(transcriptPath);
  if (!parent) return;
  try {
    await deleteTranscriptInDirUnderLockAsync(
      parent.dir,
      parent.name,
      transcriptPath,
    );
  } finally {
    await parent.dir.close();
  }
}

export function moveTranscriptSync(
  sourcePath: string,
  destinationPath: string,
): void {
  withTranscriptLocksSync([sourcePath, destinationPath], () => {
    withPinnedParent(
      sourcePath,
      (sourceDir, sourceName) =>
        withPinnedParent(
          destinationPath,
          (destinationDir, destinationName) => {
            if (
              !lstatAtSync(sourceDir, sourceName) ||
              lstatAtSync(destinationDir, destinationName)
            ) {
              return;
            }
            renameAtSync(
              sourceDir,
              sourceName,
              destinationDir,
              destinationName,
            );
            const sourceIndex = `${sourceName}${INDEX_SUFFIX}`;
            if (lstatAtSync(sourceDir, sourceIndex)) {
              renameAtSync(
                sourceDir,
                sourceIndex,
                destinationDir,
                `${destinationName}${INDEX_SUFFIX}`,
              );
            }
            fsyncPinnedDirSync(sourceDir);
            if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
              fsyncPinnedDirSync(destinationDir);
            }
            // The renamed index records the same inode and size and remains valid.
          },
          { create: true },
        ),
      { missing: () => undefined },
    );
  });
}

function readCheckpoint(checkpointPath: string): SpoolCheckpoint | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(checkpointPath, 'utf8'),
    ) as SpoolCheckpoint;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

function spoolIdentity(sourcePath: string, stat: fs.Stats): SpoolIdentity {
  return {
    id: initializeTranscriptSpoolSync(sourcePath),
    path: path.resolve(sourcePath),
    device: stat.dev,
    inode: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  };
}

function sameSpool(a: SpoolIdentity, b: SpoolIdentity): boolean {
  // The committed spool is renamed to `<source>.archived` after every
  // consumer checkpoint is durable. Preserve identity across that rename;
  // device/inode/birthtime still reject a different file even if a sidecar is
  // accidentally reused at the same path.
  return (
    a.id === b.id &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.birthtimeMs === b.birthtimeMs
  );
}

function writeCheckpoint(
  checkpointPath: string,
  checkpoint: SpoolCheckpoint,
): void {
  atomicWriteSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
}

function recoverPendingTransactionUnderLock(
  checkpointPath: string,
  checkpoint: SpoolCheckpoint,
  payload: Buffer,
  normalized: string[],
  faultInjector?: TranscriptSpoolOptions['faultInjector'],
): void {
  const pending = checkpoint.pending;
  if (!pending) return;
  if (
    pending.payloadLength !== payload.length ||
    pending.payloadDigest !== sha256Hex(payload)
  ) {
    throw new Error('Spool checkpoint payload does not match replayed output');
  }
  const current =
    readTranscriptBytesUnderLock(pending.targetPath) ?? Buffer.alloc(0);
  const end = pending.targetOffset + pending.payloadLength;
  const existing = current.subarray(
    pending.targetOffset,
    Math.min(end, current.length),
  );
  if (existing.length === pending.payloadLength && existing.equals(payload)) {
    // The transcript fsync completed and only the checkpoint commit was lost.
  } else if (existing.length === 0 && current.length === pending.targetOffset) {
    appendBytesUnderLock(pending.targetPath, payload);
    faultInjector?.('after_transcript_fsync');
  } else if (
    current.length < end &&
    current.length >= pending.targetOffset &&
    existing.equals(payload.subarray(0, existing.length))
  ) {
    truncateTranscriptSync(pending.targetPath, pending.targetOffset);
    appendBytesUnderLock(pending.targetPath, payload);
    faultInjector?.('after_transcript_fsync');
  } else if (current.length >= pending.targetOffset) {
    // Persist the new append point before writing, so another crash can replay
    // it with the original transform context and the new deduplication prefix.
    repairTrailingRecordUnderLock(pending.targetPath);
    const selected = selectNewLinesUnderLock(pending.targetPath, normalized);
    const rebasedPayload = Buffer.from(
      selected.lines.length ? `${selected.lines.join('\n')}\n` : '',
    );
    const rebased: SpoolTransaction = {
      ...pending,
      transformOffset: pending.transformOffset ?? pending.targetOffset,
      targetOffset: transcriptSizeUnderLock(pending.targetPath),
      payloadLength: rebasedPayload.length,
      payloadDigest: sha256Hex(rebasedPayload),
    };
    checkpoint.pending = rebased;
    writeCheckpoint(checkpointPath, checkpoint);
    faultInjector?.('after_pending_checkpoint');
    recoverPendingTransactionUnderLock(
      checkpointPath,
      checkpoint,
      rebasedPayload,
      normalized,
      faultInjector,
    );
    return;
  } else {
    throw new Error('Transcript is shorter than the pending spool offset');
  }
  checkpoint.committed = pending;
  checkpoint.pending = null;
  writeCheckpoint(checkpointPath, checkpoint);
  faultInjector?.('after_committed_checkpoint');
  writeIndexUnderLock(pending.targetPath);
}

export interface TranscriptTextRead {
  content: string;
  stat: fs.Stats;
}

export interface TranscriptReadOptions {
  /** Size limit; defaults to {@link TRANSCRIPT_READ_LIMIT_BYTES}. */
  maxBytes?: number;
  /** For an oversized file, read its last `maxBytes` bytes instead of refusing it. */
  tail?: boolean;
}

/**
 * Read a file of the agent-writable transcripts tree through its pinned
 * parent directory: no directory above it and not the file itself is
 * followed as a link, and a FIFO or device is refused without blocking.
 * Returns null (never throws) when the file is missing or the read is refused.
 */
export function readTranscriptTextSync(
  filePath: string,
  opts: TranscriptReadOptions = {},
): TranscriptTextRead | null {
  try {
    const read = readGroupFileSync(filePath, {
      maxBytes: opts.maxBytes ?? TRANSCRIPT_READ_LIMIT_BYTES,
      tail: opts.tail,
    });
    return read
      ? { content: read.data.toString('utf8'), stat: read.stat }
      : null;
  } catch {
    return null;
  }
}

/** Async twin of {@link readTranscriptTextSync}. */
export async function readTranscriptText(
  filePath: string,
  opts: TranscriptReadOptions = {},
): Promise<TranscriptTextRead | null> {
  try {
    const read = await readGroupFile(filePath, {
      maxBytes: opts.maxBytes ?? TRANSCRIPT_READ_LIMIT_BYTES,
      tail: opts.tail,
    });
    return read
      ? { content: read.data.toString('utf8'), stat: read.stat }
      : null;
  } catch {
    return null;
  }
}

/**
 * Open a file of the transcripts tree for streaming through its pinned parent
 * (see {@link readTranscriptTextSync}). The caller closes the descriptor.
 */
export function openTranscriptFileSync(
  filePath: string,
): { fd: number; stat: fs.Stats } | null {
  try {
    const parent = openParentDirSync(filePath);
    if (!parent) return null;
    try {
      return openFileAtSync(parent.dir, parent.name);
    } finally {
      parent.dir.closeSync();
    }
  } catch {
    return null;
  }
}

/**
 * Read a run spool (agent-writable) without following a planted symlink.
 * Returns null when the file does not exist. Throws when the path is a
 * symlink, a non-regular file (FIFO, device, directory) or otherwise
 * unreadable, so callers treat the spool as not archivable and preserve it.
 */
function readRunSpoolNoFollow(
  sourcePath: string,
): { content: string; stat: fs.Stats } | null {
  let fd: number;
  try {
    fd = fs.openSync(
      sourcePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') {
      logger.warn({ sourcePath }, 'Refusing to read symlinked run spool');
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      logger.warn({ sourcePath }, 'Refusing to read non-regular run spool');
      throw new Error(
        `Refusing to read run spool that is not a regular file: ${sourcePath}`,
      );
    }
    return { content: fs.readFileSync(fd, 'utf8'), stat };
  } finally {
    fs.closeSync(fd);
  }
}

export function ingestTranscriptSpoolSync(
  targetPath: string,
  sourcePath: string,
  transform: (
    source: string,
    context: TranscriptSpoolTransformContext,
  ) => Iterable<string | unknown>,
  options: TranscriptSpoolOptions = {},
): TranscriptSpoolResult {
  return withTranscriptLockSync(targetPath, () => {
    const spool = readRunSpoolNoFollow(sourcePath);
    if (!spool) {
      throw new Error(`Spool source is missing: ${sourcePath}`);
    }
    const source = spool.content;
    const identity = spoolIdentity(sourcePath, spool.stat);
    const sourceBytes = Buffer.from(source);
    const sourceDigest = sha256Hex(sourceBytes);
    const checkpointPath = transcriptCheckpointPath(
      sourcePath,
      options.checkpointNamespace,
    );
    let checkpoint = readCheckpoint(checkpointPath) ?? {
      version: 1 as const,
      spool: identity,
      pending: null,
      committed: null,
    };
    if (!sameSpool(checkpoint.spool, identity)) {
      throw new Error('Spool identity changed; refusing to reuse checkpoint');
    }

    if (checkpoint.pending) {
      if (checkpoint.pending.targetPath !== targetPath) {
        throw new Error('Pending spool transaction was retargeted');
      }
      const durablePrefix = (
        readTranscriptBytesUnderLock(targetPath) ?? Buffer.alloc(0)
      )
        .subarray(
          0,
          checkpoint.pending.transformOffset ?? checkpoint.pending.targetOffset,
        )
        .toString('utf8');
      const durableLines = durablePrefix
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const normalized = normalizeLines(
        transform(source, {
          targetPath,
          durableLines,
          nextOrdinal: durableLines.length,
          sourceArtifactId: identity.id,
        }),
      );
      const selected = selectNewLinesAtOffsetUnderLock(
        targetPath,
        checkpoint.pending.targetOffset,
        normalized,
      );
      const payload = Buffer.from(
        selected.lines.length > 0 ? `${selected.lines.join('\n')}\n` : '',
      );
      recoverPendingTransactionUnderLock(
        checkpointPath,
        checkpoint,
        payload,
        normalized,
        options.faultInjector,
      );
      return {
        appendedLines: selected.lines.length,
        duplicateLines: selected.duplicateLines,
        alreadyCommitted: true,
        checkpointPath,
      };
    }

    if (checkpoint.committed) {
      if (
        checkpoint.committed.sourceSize !== sourceBytes.length ||
        checkpoint.committed.sourceDigest !== sourceDigest ||
        checkpoint.committed.targetPath !== targetPath
      ) {
        throw new Error('Committed spool was changed or retargeted');
      }
      return {
        appendedLines: 0,
        duplicateLines: 0,
        alreadyCommitted: true,
        checkpointPath,
      };
    }

    repairTrailingRecordUnderLock(targetPath);
    const durableLines = (
      readTranscriptBytesUnderLock(targetPath) ?? Buffer.alloc(0)
    )
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const normalized = normalizeLines(
      transform(source, {
        targetPath,
        durableLines,
        nextOrdinal: durableLines.length,
        sourceArtifactId: identity.id,
      }),
    );
    const selected = selectNewLinesUnderLock(targetPath, normalized);
    const payload = Buffer.from(
      selected.lines.length > 0 ? `${selected.lines.join('\n')}\n` : '',
    );

    const transaction: SpoolTransaction = {
      id: randomUUID(),
      targetPath,
      targetOffset: transcriptSizeUnderLock(targetPath),
      payloadLength: payload.length,
      payloadDigest: sha256Hex(payload),
      sourceSize: sourceBytes.length,
      sourceDigest,
    };
    checkpoint = { ...checkpoint, pending: transaction };
    writeCheckpoint(checkpointPath, checkpoint);
    options.faultInjector?.('after_pending_checkpoint');

    if (payload.length > 0) appendBytesUnderLock(targetPath, payload);
    options.faultInjector?.('after_transcript_fsync');
    checkpoint.pending = null;
    checkpoint.committed = transaction;
    writeCheckpoint(checkpointPath, checkpoint);
    options.faultInjector?.('after_committed_checkpoint');
    if (payload.length > 0) {
      writeKnownIndexUnderLock(targetPath, selected.records);
    }
    return {
      appendedLines: selected.lines.length,
      duplicateLines: selected.duplicateLines,
      alreadyCommitted: false,
      checkpointPath,
    };
  });
}
