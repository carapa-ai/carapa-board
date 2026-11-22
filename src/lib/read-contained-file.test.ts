import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ContainedFileError,
  readContainedFile,
  readContainedFileSync,
  writeContainedFileVerified,
} from './read-contained-file.js';

let tmp: string;
let root: string;
let outside: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contained-file-'));
  root = path.join(tmp, 'artifacts');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err: unknown) {
    return err instanceof ContainedFileError ? err.code : String(err);
  }
  return 'resolved';
}

describe('readContainedFile', () => {
  it('reads a regular file inside the root', async () => {
    const file = path.join(root, 'ok.png');
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    expect([...(await readContainedFile(root, file, 10))]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('rejects a leaf swapped for a symlink to an outside file', async () => {
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(secret, 'secret');
    const file = path.join(root, 'swapped.png');
    fs.writeFileSync(file, 'x');
    fs.rmSync(file);
    fs.symlinkSync(secret, file);
    expect(await codeOf(readContainedFile(root, file, 100))).toBe(
      'outside_root',
    );
  });

  it('rejects a FIFO promptly', async () => {
    const fifo = path.join(root, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    expect(await codeOf(readContainedFile(root, fifo, 100))).toBe(
      'not_regular_file',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects an oversize file without reading it', async () => {
    const big = path.join(root, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(2048));
    expect(await codeOf(readContainedFile(root, big, 1024))).toBe('too_large');
  });
});

function syncCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    return err instanceof ContainedFileError ? err.code : String(err);
  }
  return 'returned';
}

describe('readContainedFileSync', () => {
  it('reads a regular file inside the root', () => {
    const file = path.join(root, 'sync-ok.md');
    fs.writeFileSync(file, 'hello');
    expect(readContainedFileSync(root, file, 10).toString()).toBe('hello');
  });

  it('rejects a symlink leaf pointing outside the root', () => {
    const secret = path.join(outside, 'sync-secret.md');
    fs.writeFileSync(secret, 'secret');
    const link = path.join(root, 'sync-link.md');
    fs.symlinkSync(secret, link);
    expect(syncCodeOf(() => readContainedFileSync(root, link, 100))).toBe(
      'outside_root',
    );
  });

  it('rejects a FIFO without blocking', () => {
    const fifo = path.join(root, 'sync-pipe.md');
    execFileSync('mkfifo', [fifo]);
    // A regression to a blocking open would hang this child, not the suite.
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `import { readContainedFileSync } from ${JSON.stringify(
          path.resolve(import.meta.dir, 'read-contained-file.ts'),
        )};
try { readContainedFileSync(${JSON.stringify(root)}, ${JSON.stringify(fifo)}, 100); console.log('returned'); } catch (e) { console.log(e.code); }`,
      ],
      timeout: 5000,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    });
    expect(child.exitedDueToTimeout).toBeFalsy();
    expect(child.stdout.toString().trim()).toBe('not_regular_file');
  });

  it('rejects an oversize file', () => {
    const big = path.join(root, 'sync-big.md');
    fs.writeFileSync(big, Buffer.alloc(2048));
    expect(syncCodeOf(() => readContainedFileSync(root, big, 1024))).toBe(
      'too_large',
    );
  });

  it('allows a symlinked directory that stays inside the root', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'worker.md'), 'legacy');
    fs.symlinkSync('.claude', path.join(root, '.agent'));
    expect(
      readContainedFileSync(
        root,
        path.join(root, '.agent', 'worker.md'),
        100,
      ).toString(),
    ).toBe('legacy');
  });
});

describe('writeContainedFileVerified', () => {
  it('writes (creating parents) and overwrites a regular file inside the root', async () => {
    const file = path.join(root, 'w', 'nested', 'ok.md');
    await writeContainedFileVerified(root, file, 'first long content');
    await writeContainedFileVerified(root, file, 'second');
    expect(fs.readFileSync(file, 'utf-8')).toBe('second');
  });

  it('refuses a symlink leaf and leaves the outside target unchanged', async () => {
    const target = path.join(outside, 'w-target.md');
    fs.writeFileSync(target, 'original');
    const link = path.join(root, 'w-link.md');
    fs.symlinkSync(target, link);
    expect(
      await codeOf(writeContainedFileVerified(root, link, 'overwritten')),
    ).toBe('outside_root');
    expect(fs.readFileSync(target, 'utf-8')).toBe('original');
  });

  it('refuses a FIFO leaf promptly', async () => {
    const fifo = path.join(root, 'w-pipe.md');
    execFileSync('mkfifo', [fifo]);
    // A regression to a blocking open would hang this child, not the suite.
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `import { writeContainedFileVerified } from ${JSON.stringify(
          path.resolve(import.meta.dir, 'read-contained-file.ts'),
        )};
try { await writeContainedFileVerified(${JSON.stringify(root)}, ${JSON.stringify(fifo)}, 'x'); console.log('returned'); } catch (e) { console.log(e.code); }`,
      ],
      timeout: 5000,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    });
    expect(child.exitedDueToTimeout).toBeFalsy();
    expect(child.stdout.toString().trim()).toBe('not_regular_file');
  });
});
