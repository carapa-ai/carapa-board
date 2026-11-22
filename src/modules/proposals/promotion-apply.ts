/**
 * Writes and commits one approved platform/template proposal in its source
 * repository. Runs inside the promotion sandbox (via `scripts/apply-promotion.ts`),
 * never in the Board process: it has no Board dependencies on purpose.
 *
 * Everything is re-validated here, because the payload crossed a process
 * boundary. A refusal or failure leaves the repository exactly as it was.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from '../../lib/path-containment.js';
import {
  MAX_FILES,
  assertValidName,
  validateAction,
  ProposalValidationError,
} from './actions.js';
import {
  MAX_PROMOTION_BYTES,
  promotionFilePaths,
  promotionPayloadSchema,
  promotionTarget,
  type PromotionBase,
  type PromotionPayload,
} from './promotion-targets.js';

/** The target changed after the proposal was written. */
export class StalePromotionError extends Error {}
/** The checkout is not in a state this script may write to. */
export class PromotionRefusedError extends Error {}

const FALLBACK_IDENTITY = [
  '-c',
  'user.name=Carapa Board',
  '-c',
  'user.email=board@carapa.local',
];

function git(repo: string, args: string[], allowFailure = false): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout ?? '';
}

export function parsePayload(raw: unknown): PromotionPayload {
  const parsed = promotionPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProposalValidationError(
      `Invalid payload: ${parsed.error.issues
        .map(
          (issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`,
        )
        .join('; ')}`,
    );
  }
  const payload = parsed.data;
  assertValidName(payload.name);
  validateAction(
    { type: 'write_item', files: payload.files },
    { kind: payload.kind, name: payload.name },
  );
  return payload;
}

interface ResolvedPromotion {
  repoRoot: string;
  itemPath: string;
  itemAbs: string;
  writes: Array<{ abs: string; content: string }>;
}

function resolvePromotion(payload: PromotionPayload): ResolvedPromotion {
  const target = promotionTarget(payload.layer, payload.kind, payload.name);
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(payload.repoDir);
  } catch {
    throw new PromotionRefusedError(
      `Repository ${payload.repoDir} does not exist`,
    );
  }
  const toplevel = git(repoRoot, ['rev-parse', '--show-toplevel'], true).trim();
  if (!toplevel || fs.realpathSync(toplevel) !== repoRoot) {
    throw new PromotionRefusedError(
      `${payload.repoDir} is not the top level of a git checkout`,
    );
  }
  // No link below the repository root may redirect the write.
  let cursor = repoRoot;
  for (const segment of target.itemPath.split('/')) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new PromotionRefusedError(
        `${target.itemPath} passes through a symlink (${segment})`,
      );
    }
  }
  const relPaths = promotionFilePaths(target, payload.kind, payload.files);
  const writes = relPaths.map((rel, index) => ({
    abs: path.join(repoRoot, rel),
    content: payload.files[index].content,
  }));
  const itemAbs = path.join(repoRoot, target.itemPath);
  for (const write of writes) {
    if (
      (payload.kind === 'skill' && !isPathInside(itemAbs, write.abs)) ||
      (payload.kind === 'rule' && write.abs !== itemAbs)
    ) {
      throw new PromotionRefusedError(`Path escapes the target: ${write.abs}`);
    }
  }
  return { repoRoot, itemPath: target.itemPath, itemAbs, writes };
}

const isExecutable = (stat: fs.Stats) => (stat.mode & 0o111) !== 0;

/** Absolute paths of the regular files under `abs` that carry an execute bit. */
function executableFiles(abs: string, found = new Set<string>()): Set<string> {
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    for (const entry of fs.readdirSync(abs)) {
      executableFiles(path.join(abs, entry), found);
    }
  } else if (stat?.isFile() && isExecutable(stat)) {
    found.add(abs);
  }
  return found;
}

function hashTree(
  hash: ReturnType<typeof createHash>,
  abs: string,
  rel: string,
) {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) {
    hash.update(`${rel}\0link\0${fs.readlinkSync(abs)}\0`);
  } else if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(abs).sort()) {
      hashTree(hash, path.join(abs, entry), rel ? `${rel}/${entry}` : entry);
    }
  } else if (stat.isFile()) {
    const content = fs.readFileSync(abs);
    hash.update(
      `${rel}\0${isExecutable(stat) ? 'x' : '-'}\0${content.length}\0`,
    );
    hash.update(content);
  } else {
    hash.update(`${rel}\0special\0`);
  }
}

/** Hash of the item as it is on disk now ("absent" is a state of its own). */
export function hashItem(itemAbs: string): string {
  const hash = createHash('sha256');
  const exists = fs.lstatSync(itemAbs, { throwIfNoEntry: false }) !== undefined;
  hash.update(`exists=${exists}\n`);
  if (exists) hashTree(hash, itemAbs, '');
  return hash.digest('hex');
}

/**
 * The files and symbolic links of the item as they are on disk, for the
 * approval preview. Null when the item exceeds the payload limits or holds
 * another kind of entry: the preview then says its previous content is
 * unavailable instead of presenting a partial base as complete.
 */
function readItemFiles(
  itemAbs: string,
  kind: PromotionPayload['kind'],
): PromotionBase | null {
  if (!fs.lstatSync(itemAbs, { throwIfNoEntry: false })) return { files: [] };
  const found: Array<{ path: string; abs: string; link?: string }> = [];
  let unsupported = false;
  const walk = (abs: string, rel: string) => {
    const entry = fs.lstatSync(abs);
    if (entry.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
    } else if (entry.isSymbolicLink()) {
      found.push({ path: rel, abs, link: fs.readlinkSync(abs) });
    } else if (entry.isFile()) {
      found.push({ path: kind === 'rule' ? path.basename(abs) : rel, abs });
    } else {
      unsupported = true;
    }
  };
  walk(itemAbs, '');
  if (unsupported || found.length > MAX_FILES) return null;
  let total = 0;
  const files: PromotionBase['files'] = found.map((file) => {
    if (file.link !== undefined) {
      total += Buffer.byteLength(file.link, 'utf8');
      return { path: file.path, content: file.link, encoding: 'symlink' };
    }
    const bytes = fs.readFileSync(file.abs);
    total += bytes.length;
    const text = bytes.toString('utf8');
    return bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)
      ? {
          path: file.path,
          content: bytes.toString('base64'),
          encoding: 'base64',
        }
      : { path: file.path, content: text };
  });
  return total > MAX_PROMOTION_BYTES ? null : { files };
}

function assertCheckoutReady(payload: PromotionPayload, r: ResolvedPromotion) {
  const branch = git(
    r.repoRoot,
    ['symbolic-ref', '--short', '-q', 'HEAD'],
    true,
  ).trim();
  if (branch !== payload.branch) {
    throw new PromotionRefusedError(
      `${payload.repoDir} is on ${branch || 'a detached HEAD'}, not the default branch ${payload.branch}`,
    );
  }
  const dirty = git(r.repoRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignored',
    '--',
    r.itemPath,
  ]).trim();
  if (dirty) {
    throw new PromotionRefusedError(
      `${r.itemPath} has uncommitted changes in ${payload.repoDir}:\n${dirty}`,
    );
  }
}

/** Restore the item to HEAD. Every step must succeed or the caller is told. */
function rollback(r: ResolvedPromotion, inHead: boolean): void {
  const steps: string[][] = [
    ['reset', '-q', '--', r.itemPath],
    ...(inHead ? [['checkout', 'HEAD', '--', r.itemPath]] : []),
    ['clean', '-fdxq', '--', r.itemPath],
  ];
  const failures: string[] = [];
  for (const step of steps) {
    try {
      git(r.repoRoot, step);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Rollback failed, so ${r.itemPath} in ${r.repoRoot} may hold the partial change and needs manual cleanup: ${failures.join('; ')}`,
    );
  }
}

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 100;
/** A lock directory whose owner never recorded a pid is stale after this long. */
const LOCK_PID_GRACE_MS = 10_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(lockDir: string): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
    process.kill(pid, 0);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const stat = fs.statSync(lockDir, { throwIfNoEntry: false });
      return !!stat && Date.now() - stat.mtimeMs > LOCK_PID_GRACE_MS;
    }
    return false;
  }
}

/**
 * Hold one lock per repository across readiness checks, mutation, commit and
 * rollback, so two promotions never interleave their index operations.
 */
function withRepoLock<T>(repoRoot: string, timeoutMs: number, fn: () => T): T {
  const gitDir = git(repoRoot, ['rev-parse', '--absolute-git-dir']).trim();
  const lockDir = path.join(gitDir, 'carapa-promotion.lock');
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockIsStale(lockDir)) {
        // Serialize reapers with a kernel lock. The permanent guard file must
        // not be unlinked: waiters must all lock the same inode. The child
        // rechecks under flock, since the original stale observation can age.
        const reaper = spawnSync(
          'flock',
          [
            '-n',
            '-E',
            '75',
            `${lockDir}.guard`,
            process.execPath,
            '-e',
            `import { reapStalePromotionLock } from ${JSON.stringify(import.meta.url)}; reapStalePromotionLock(process.argv[1]);`,
            lockDir,
          ],
          { encoding: 'utf8' },
        );
        if (reaper.status === 0) continue;
        if (reaper.status !== 75) {
          throw new PromotionRefusedError(
            `Cannot safely reclaim promotion lock: ${reaper.stderr || reaper.error || reaper.status}`,
          );
        }
      }
      if (Date.now() >= deadline) {
        throw new PromotionRefusedError(
          `Another promotion is in progress in ${repoRoot}; try again shortly`,
        );
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(lockDir, 'owner'), token);
    return fn();
  } finally {
    // A missing or replaced lock is not ours to remove.
    try {
      if (fs.readFileSync(path.join(lockDir, 'owner'), 'utf8') === token) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/** Called only by the flock-protected reaper subprocess. */
export function reapStalePromotionLock(lockDir: string): void {
  if (lockIsStale(lockDir))
    fs.rmSync(lockDir, { recursive: true, force: true });
}

/**
 * The commit this proposal already made, if any. A replayed or retried apply
 * returns it instead of reporting the (now changed) target as stale.
 */
function findReceipt(r: ResolvedPromotion, proposalId: string): string | null {
  const sha = git(
    r.repoRoot,
    [
      'log',
      '-n1',
      '--format=%H',
      '-F',
      `--grep=Proposal: ${proposalId}`,
      '--',
      r.itemPath,
    ],
    true,
  ).trim();
  if (!sha) return null;
  const body = git(r.repoRoot, ['show', '-s', '--format=%B', sha], true);
  return body.split('\n').includes(`Proposal: ${proposalId}`) ? sha : null;
}

function commitMessage(payload: PromotionPayload, itemPath: string): string {
  const title = payload.title.replace(/\s+/g, ' ').trim();
  const prefix = promotionTarget(
    payload.layer,
    payload.kind,
    payload.name,
  ).commitPrefix;
  return `${prefix} ${title}\n\nProposal: ${payload.proposalId}\nTarget: ${itemPath}`;
}

/**
 * Write the item, commit it, and return the commit SHA. Idempotent per
 * proposal id: a repeated call returns the commit already made.
 */
export function applyPromotion(
  payload: PromotionPayload,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
): string {
  const r = resolvePromotion(payload);
  return withRepoLock(r.repoRoot, lockTimeoutMs, () => {
    const receipt = findReceipt(r, payload.proposalId);
    if (receipt) return receipt;
    assertCheckoutReady(payload, r);
    if (hashItem(r.itemAbs) !== payload.baseHash) {
      throw new StalePromotionError(
        `${r.itemPath} changed after this was proposed. Nothing was written.`,
      );
    }
    const inHead =
      git(r.repoRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        'HEAD',
        '--',
        r.itemPath,
      ]).trim() !== '';
    try {
      // The replacement is a whole-item rewrite: keep each file's execute bit.
      const executable = executableFiles(r.itemAbs);
      fs.rmSync(r.itemAbs, { recursive: true, force: true });
      for (const write of r.writes) {
        fs.mkdirSync(path.dirname(write.abs), { recursive: true });
        const mode = executable.has(write.abs) ? 0o755 : 0o644;
        fs.writeFileSync(write.abs, write.content, { flag: 'wx', mode });
        fs.chmodSync(write.abs, mode);
      }
      git(r.repoRoot, ['add', '-A', '--', r.itemPath]);
      // ls-files includes unchanged tracked files as well as newly staged ones.
      const indexed = new Set(
        git(r.repoRoot, ['ls-files', '-z', '--', r.itemPath]).split('\0'),
      );
      const missing = r.writes
        .map((write) => path.relative(r.repoRoot, write.abs))
        .filter((file) => !indexed.has(file));
      if (missing.length) {
        throw new PromotionRefusedError(
          `Files were not staged (possibly gitignored): ${missing.join(', ')}`,
        );
      }
      const staged = spawnSync(
        'git',
        ['-C', r.repoRoot, 'diff', '--cached', '--quiet', '--', r.itemPath],
        { env: process.env },
      );
      if (staged.status === 0) {
        throw new PromotionRefusedError(
          `${r.itemPath} already has this content; nothing to commit`,
        );
      }
      const hasIdentity = git(
        r.repoRoot,
        ['config', 'user.email'],
        true,
      ).trim();
      git(r.repoRoot, [
        ...(hasIdentity ? [] : FALLBACK_IDENTITY),
        'commit',
        '-q',
        '-m',
        commitMessage(payload, r.itemPath),
        '--',
        r.itemPath,
      ]);
    } catch (err) {
      try {
        rollback(r, inHead);
      } catch (rollbackErr) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\n${(rollbackErr as Error).message}`,
        );
      }
      throw err;
    }
    return git(r.repoRoot, ['rev-parse', 'HEAD']).trim();
  });
}

/** CLI entry: print one result line; the exit code is 0 only on success. */
export function runPromotionCli(mode: string, payloadFile: string): number {
  try {
    if (mode !== 'hash' && mode !== 'apply') {
      throw new ProposalValidationError(`Unknown mode "${mode}"`);
    }
    if (fs.statSync(payloadFile).size > MAX_PROMOTION_BYTES) {
      throw new ProposalValidationError('Payload is larger than 2 MiB');
    }
    const payload = parsePayload(
      JSON.parse(fs.readFileSync(payloadFile, 'utf8')),
    );
    if (mode === 'hash') {
      const { repoRoot, itemAbs } = resolvePromotion(payload);
      // Under the repository lock, so a concurrent promotion cannot land
      // between reading the files and hashing them: the stored base must be
      // exactly the version the hash protects.
      const hash = withRepoLock(repoRoot, LOCK_TIMEOUT_MS, () => {
        // The previous content goes beside the payload, never to stdout. No
        // file means it was too large to report.
        const base = readItemFiles(itemAbs, payload.kind);
        if (base) {
          fs.writeFileSync(
            path.join(path.dirname(payloadFile), 'base.json'),
            JSON.stringify(base),
          );
        }
        return hashItem(itemAbs);
      });
      console.log(`HASH ${hash}`);
    } else {
      console.log(`COMMIT ${applyPromotion(payload)}`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `${err instanceof StalePromotionError ? 'STALE' : 'ERROR'}: ${message}`,
    );
    return err instanceof StalePromotionError ? 3 : 1;
  }
}
