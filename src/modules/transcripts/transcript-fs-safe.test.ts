import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRealDir, readNoFollowSync } from './transcript-fs-safe.js';

function canMkfifo(root: string): boolean {
  try {
    execFileSync('mkfifo', [path.join(root, '.probe')]);
    return true;
  } catch {
    return false;
  }
}

describe('transcript-fs-safe', () => {
  let root: string;
  let dir: string;
  let foreign: string;
  let fifoOk: boolean;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-fs-safe-'));
    dir = path.join(root, 'transcripts');
    foreign = path.join(root, 'foreign');
    fs.mkdirSync(dir);
    fs.mkdirSync(foreign);
    fifoOk = canMkfifo(root);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('reads a regular file through the sync reader', () => {
    const file = path.join(dir, 'ok.jsonl');
    fs.writeFileSync(file, 'hello\n');
    expect(readNoFollowSync(dir, file)?.content).toBe('hello\n');
    expect(readNoFollowSync(dir, path.join(dir, 'missing.jsonl'))).toBeNull();
  });

  test('refuses a symlinked leaf', () => {
    fs.writeFileSync(path.join(foreign, 'secret.jsonl'), 'secret\n');
    const link = path.join(dir, 'link.jsonl');
    fs.symlinkSync(path.join(foreign, 'secret.jsonl'), link);
    expect(readNoFollowSync(dir, link)).toBeNull();
  });

  test('refuses a symlinked parent directory even for a regular target', () => {
    const linkedDir = path.join(root, 'linked-dir');
    fs.symlinkSync(foreign, linkedDir);
    const file = path.join(linkedDir, 'secret.jsonl');
    expect(isRealDir(linkedDir)).toBe(false);
    expect(readNoFollowSync(linkedDir, file)).toBeNull();
  });

  test('refuses a FIFO without blocking', () => {
    if (!fifoOk) return;
    const fifo = path.join(dir, 'pipe.jsonl');
    execFileSync('mkfifo', [fifo]);
    expect(readNoFollowSync(dir, fifo)).toBeNull();
  }, 2000);

  test('tail returns the last maxBytes; oversized without tail is refused', () => {
    const file = path.join(dir, 'big.jsonl');
    fs.writeFileSync(file, '0123456789');
    expect(
      readNoFollowSync(dir, file, { maxBytes: 4, tail: true })?.content,
    ).toBe('6789');
    expect(readNoFollowSync(dir, file, { maxBytes: 4 })).toBeNull();
    expect(readNoFollowSync(dir, file, { maxBytes: 10 })?.content).toBe(
      '0123456789',
    );
  });
});
