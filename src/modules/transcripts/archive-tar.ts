import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import {
  openFileAt,
  openFileAtSync,
  type PinnedDir,
} from '../../lib/group-fs.js';
import { assertRegularArchiveMembers } from './archive-safety.js';

/**
 * Archive bundles live in the agent-writable `transcripts/archive/`. tar opens
 * and writes by path, so it must never read from, extract into or build inside
 * that directory: a swapped directory would let agent-authored members land
 * anywhere. Instead tar reads the bundle from a descriptor pinned with
 * `openFileAt` (stdin) and unpacks/packs only in board-owned temp space.
 */

/** Cap on tar output captured in memory (matches the largest extracted transcript). */
export const TAR_OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

/** Board-owned temp space for archive extraction and bundling. */
export function boardTranscriptTempRoot(): string {
  return path.join(DATA_DIR, 'tmp', 'transcripts');
}

/** Fresh unique directory in {@link boardTranscriptTempRoot}. Remove it in `finally`. */
export async function makeBoardTranscriptTempDir(
  prefix: string,
): Promise<string> {
  const root = boardTranscriptTempRoot();
  await fsp.mkdir(root, { recursive: true });
  return fsp.mkdtemp(path.join(root, prefix));
}

function tarFailure(
  status: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  return new Error(
    `tar exited with ${status ?? signal}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
  );
}

/** Run tar with `stdin` as its standard input; resolves with captured stdout. */
export function runTar(
  args: string[],
  stdin: number | 'ignore',
  maxOutputBytes = TAR_OUTPUT_CAP_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: [stdin, 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (exceeded) {
        reject(new Error(`tar output exceeds ${maxOutputBytes} bytes`));
      } else if (status !== 0) {
        reject(tarFailure(status, signal, stderr));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/** Sync twin of {@link runTar}. */
function runTarSync(
  args: string[],
  stdin: number | 'ignore',
  maxOutputBytes = TAR_OUTPUT_CAP_BYTES,
): Buffer {
  const result = spawnSync('tar', args, {
    stdio: [stdin, 'pipe', 'pipe'],
    maxBuffer: maxOutputBytes,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw tarFailure(
      result.status,
      result.signal,
      result.stderr?.toString('utf8') ?? '',
    );
  }
  return result.stdout;
}

/**
 * One bundle held open by descriptor. Every tar run gets a fresh open file
 * description of the very same inode (`/proc/self/fd/<fd>`), so a check and a
 * later extraction cannot be redirected to another file by renaming the path.
 */
export class PinnedArchive {
  private constructor(
    private readonly fd: number,
    private readonly handle: fsp.FileHandle | null,
    readonly stat: fs.Stats,
  ) {}

  /** Null when the bundle does not exist; throws GroupFsError for a link or non-regular file. */
  static async open(
    dir: PinnedDir,
    name: string,
  ): Promise<PinnedArchive | null> {
    const opened = await openFileAt(dir, name);
    return opened
      ? new PinnedArchive(opened.handle.fd, opened.handle, opened.stat)
      : null;
  }

  static openSync(dir: PinnedDir, name: string): PinnedArchive | null {
    const opened = openFileAtSync(dir, name);
    return opened ? new PinnedArchive(opened.fd, null, opened.stat) : null;
  }

  /** A new descriptor on the bundle for a child's stdin. The caller closes it. */
  openStdin(): number {
    return fs.openSync(`/proc/self/fd/${this.fd}`, fs.constants.O_RDONLY);
  }

  async run(args: string[], maxOutputBytes?: number): Promise<Buffer> {
    const stdin = this.openStdin();
    try {
      return await runTar(args, stdin, maxOutputBytes);
    } finally {
      fs.closeSync(stdin);
    }
  }

  runSync(args: string[], maxOutputBytes?: number): Buffer {
    const stdin = this.openStdin();
    try {
      return runTarSync(args, stdin, maxOutputBytes);
    } finally {
      fs.closeSync(stdin);
    }
  }

  async close(): Promise<void> {
    if (this.handle) await this.handle.close().catch(() => {});
    else this.closeSync();
  }

  closeSync(): void {
    if (this.handle) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* best effort */
    }
  }
}

/** Member names of a bundle (`./` prefixes stripped), listed from the pinned descriptor. */
export async function listArchiveMemberNames(
  archive: PinnedArchive,
): Promise<string[]> {
  return parseMemberNames(await archive.run(['-tzf', '-']));
}

/** Member names of a board-owned bundle file (e.g. one just built in temp space). */
export async function listTarFileMemberNames(
  bundlePath: string,
): Promise<string[]> {
  return parseMemberNames(await runTar(['-tzf', bundlePath], 'ignore'));
}

function parseMemberNames(listing: Buffer): string[] {
  return listing
    .toString('utf8')
    .split('\n')
    .map((line) => line.replace(/^\.\//, ''))
    .filter(Boolean);
}

/** Refuse a bundle holding anything but regular files, before it is extracted. */
export async function assertPinnedArchiveRegular(
  archive: PinnedArchive,
): Promise<void> {
  assertRegularArchiveMembers(
    (await archive.run(['-tvzf', '-'])).toString('utf8'),
  );
}

/** Unpack a (previously checked) bundle into the board temp directory `destDir`. */
export async function extractPinnedArchive(
  archive: PinnedArchive,
  destDir: string,
): Promise<void> {
  await archive.run(['-xzf', '-', '-C', destDir]);
}
