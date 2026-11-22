import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import express from 'express';

import { GROUPS_DIR } from '../config.js';
import { setGroupLookup } from '../group-dir.js';
import type { RegisteredGroup } from '../types.js';
import {
  GroupFsError,
  type GroupFsErrorCode,
  appendFileAtSync,
  copyTree,
  groupFsTestHooks,
  lstatAt,
  mkdirAt,
  openDirAt,
  openFileAt,
  openGroupDir,
  openGroupDirSync,
  readFileAt,
  readFileAtSync,
  readGroupFile,
  readdirAt,
  removeAt,
  removeAtSync,
  renameAt,
  sendPinnedFile,
  splitRelPath,
  writeChunkAtSync,
  writeFileAt,
  writeFileAtSync,
  writeGroupFileSync,
} from './group-fs.js';

// Security regression suite: an agent can swap a directory it owns for a
// symlink at any moment, so these tests drive the swap from the open hook.
const suffix = `${process.pid}-${Date.now()}`;
const A = `gfs-a-${suffix}`;
const B = `gfs-b-${suffix}`;
const CHILD = `gfs-child-${suffix}`;
const dirA = path.join(GROUPS_DIR, A);
const dirB = path.join(GROUPS_DIR, B);
const OPTS = { maxBytes: 1024 };
const fdCount = () => fs.readdirSync('/proc/self/fd').length;
let baselineFds = 0;
let hasFifo = false;

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const rejectsWith = async (
  promise: Promise<unknown>,
  code: GroupFsErrorCode,
) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GroupFsError);
  expect((err as GroupFsError).code).toBe(code);
};

beforeAll(() => {
  fs.mkdirSync(dirA, { recursive: true });
  write(path.join(dirB, 'secret.txt'), 'B-secret');
  write(path.join(dirB, 'sub', 'secret.txt'), 'B-secret');
  // Spawning a process makes Bun add runtime fds, so do it before the baseline.
  try {
    execFileSync('mkfifo', [path.join(dirA, 'fifo')]);
    fs.mkdirSync(path.join(dirA, 'ctsrc'), { recursive: true });
    execFileSync('mkfifo', [path.join(dirA, 'ctsrc', 'fifo')]);
    hasFifo = true;
  } catch {
    /* mkfifo unavailable */
  }
  baselineFds = fdCount();
});

afterEach(() => {
  groupFsTestHooks.beforeOpen = undefined;
  groupFsTestHooks.forceUnsupported = false;
});

afterAll(() => {
  setGroupLookup(() => undefined);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

describe('group-fs pinned reads', () => {
  test('refuses a pre-planted symlink at a middle segment and at the leaf', async () => {
    fs.symlinkSync(path.join(dirB, 'sub'), path.join(dirA, 'mid'));
    fs.symlinkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'leaf.txt'));
    const root = (await openGroupDir(A))!;
    try {
      await rejectsWith(readFileAt(root, 'mid/secret.txt', OPTS), 'symlink');
      await rejectsWith(openDirAt(root, 'mid'), 'symlink');
      await rejectsWith(readFileAt(root, 'leaf.txt', OPTS), 'symlink');
      await rejectsWith(
        readGroupFile(path.join(dirA, 'leaf.txt'), OPTS),
        'symlink',
      );
      expect(() => openGroupDirSync(A, 'mid')).toThrow(GroupFsError);
      // lstat reports the leaf link itself; a middle link is still refused.
      expect((await lstatAt(root, 'leaf.txt'))?.isSymbolicLink()).toBe(true);
      await rejectsWith(lstatAt(root, 'mid/secret.txt'), 'symlink');
    } finally {
      await root.close();
    }
    expect(fs.readFileSync(path.join(dirB, 'secret.txt'), 'utf8')).toBe(
      'B-secret',
    );
    expect(fs.readdirSync(dirB).sort()).toEqual(['secret.txt', 'sub']);
  });

  test('a directory swapped for a symlink just before its open is refused', async () => {
    write(path.join(dirA, 'race', 'next', 'f.txt'), 'A-data');
    let swapped = false;
    groupFsTestHooks.beforeOpen = (label, segment) => {
      if (label !== path.join(dirA, 'race') || segment !== 'next') return;
      fs.rmSync(path.join(dirA, 'race', 'next'), { recursive: true });
      fs.symlinkSync(path.join(dirB, 'sub'), path.join(dirA, 'race', 'next'));
      swapped = true;
    };
    const root = (await openGroupDir(A))!;
    try {
      await rejectsWith(
        readFileAt(root, 'race/next/secret.txt', OPTS),
        'symlink',
      );
    } finally {
      await root.close();
    }
    expect(swapped).toBe(true);
  });

  test('a renamed and replaced directory still reads from the pinned inode', async () => {
    write(path.join(dirA, 'pinned', 'f.txt'), 'original');
    const pinned = (await openGroupDir(A, 'pinned'))!;
    try {
      fs.renameSync(path.join(dirA, 'pinned'), path.join(dirA, 'pinned-old'));
      fs.symlinkSync(dirB, path.join(dirA, 'pinned'));
      const read = await readFileAt(pinned, 'f.txt', OPTS);
      expect(read?.data.toString()).toBe('original');
      expect(await readdirAt(pinned)).toEqual(['f.txt']);
      expect(await readFileAt(pinned, 'missing.txt', OPTS)).toBeNull();
    } finally {
      await pinned.close();
    }
  });

  test('a FIFO leaf is refused without blocking', async () => {
    if (!hasFifo) return;
    const root = (await openGroupDir(A))!;
    try {
      await rejectsWith(readFileAt(root, 'fifo', OPTS), 'not_regular_file');
      expect(() => readFileAtSync(root, 'fifo', OPTS)).toThrow(GroupFsError);
    } finally {
      await root.close();
    }
  });

  test('enforces maxBytes and reads the tail on request', async () => {
    write(path.join(dirA, 'big.txt'), '0123456789');
    const root = (await openGroupDir(A))!;
    try {
      await rejectsWith(
        readFileAt(root, 'big.txt', { maxBytes: 4 }),
        'too_large',
      );
      const tail = await readFileAt(root, 'big.txt', {
        maxBytes: 4,
        tail: true,
      });
      expect(tail?.data.toString()).toBe('6789');
      expect(readFileAtSync(root, 'big.txt', OPTS)?.data.toString()).toBe(
        '0123456789',
      );
    } finally {
      await root.close();
    }
  });

  test('followInternalLinks follows board links and refuses escapes', async () => {
    const proj = path.join(dirA, 'proj');
    write(path.join(proj, '.agent', 'rules', 'r.md'), 'rule');
    write(path.join(proj, '.agent', 'AGENTS.md'), 'agents');
    fs.symlinkSync('.agent', path.join(proj, '.claude'));
    fs.mkdirSync(path.join(proj, 'other', '.claude'), { recursive: true });
    write(path.join(proj, 'other', '.agent', 'rules', 'o.md'), 'other-rule');
    fs.symlinkSync(
      '../.agent/rules',
      path.join(proj, 'other', '.claude', 'rules'),
    );
    fs.symlinkSync('.agent/AGENTS.md', path.join(proj, 'CLAUDE.md'));
    fs.symlinkSync('../../' + B, path.join(proj, 'esc'));
    fs.symlinkSync(dirB, path.join(proj, 'abs'));
    // Chains: 8 links resolve, 9 do not.
    write(path.join(proj, 'real.txt'), 'real');
    for (let i = 1; i <= 9; i++) {
      const target = i === 9 ? 'real.txt' : `l${i + 1}`;
      fs.symlinkSync(target, path.join(proj, `l${i}`));
    }
    fs.symlinkSync('l2', path.join(proj, 'chain9'));
    const follow = { ...OPTS, followInternalLinks: true };
    const root = (await openGroupDir(A))!;
    try {
      const text = async (rel: string, o = follow) =>
        (await readFileAt(root, rel, o))?.data.toString();
      expect(await text('proj/.claude/rules/r.md')).toBe('rule');
      expect(await text('proj/other/.claude/rules/o.md')).toBe('other-rule');
      expect(await text('proj/CLAUDE.md')).toBe('agents');
      expect(await text('proj/l2')).toBe('real'); // 8 substitutions
      await rejectsWith(readFileAt(root, 'proj/l1', follow), 'symlink'); // 9
      await rejectsWith(
        readFileAt(root, 'proj/esc/secret.txt', follow),
        'symlink',
      );
      await rejectsWith(
        readFileAt(root, 'proj/abs/secret.txt', follow),
        'symlink',
      );
      await rejectsWith(
        readFileAt(root, 'proj/.claude/rules/r.md', OPTS),
        'symlink',
      );
      expect(fs.readFileSync(path.join(dirB, 'secret.txt'), 'utf8')).toBe(
        'B-secret',
      );
    } finally {
      await root.close();
    }
  });

  test('a nested child replaced by a symlink is refused; bad folders are invalid_path', async () => {
    setGroupLookup((folder) =>
      folder === CHILD ? ({ parentId: A } as RegisteredGroup) : undefined,
    );
    write(path.join(dirA, CHILD, 'x.txt'), 'child');
    const child = (await openGroupDir(CHILD))!;
    expect((await readFileAt(child, 'x.txt', OPTS))?.data.toString()).toBe(
      'child',
    );
    await child.close();
    expect(
      (
        await readGroupFile(path.join(dirA, CHILD, 'x.txt'), OPTS)
      )?.data.toString(),
    ).toBe('child');

    fs.renameSync(path.join(dirA, CHILD), path.join(dirA, `${CHILD}-old`));
    fs.symlinkSync(dirB, path.join(dirA, CHILD));
    await rejectsWith(openGroupDir(CHILD), 'symlink');
    await rejectsWith(
      readGroupFile(path.join(dirA, CHILD, 'secret.txt'), OPTS),
      'symlink',
    );

    await rejectsWith(openGroupDir('../x'), 'invalid_path');
    await rejectsWith(openGroupDir(''), 'invalid_path');
    expect(await openGroupDir(`gfs-missing-${suffix}`)).toBeNull();
  });

  test('splitRelPath rejects unsafe paths', () => {
    for (const bad of [
      '',
      '.',
      '..',
      'a/../b',
      'a//b',
      'a/',
      '/abs',
      'a\\b',
      'a\0b',
    ]) {
      expect(() => splitRelPath(bad)).toThrow(GroupFsError);
    }
    expect(splitRelPath('a/b')).toEqual(['a', 'b']);
  });

  test('fails closed when the platform check fails', async () => {
    groupFsTestHooks.forceUnsupported = true;
    await rejectsWith(openGroupDir(A), 'unsupported');
    expect(() => openGroupDirSync(A)).toThrow(GroupFsError);
  });
});

describe('group-fs pinned writes', () => {
  // The child processes spawned in beforeAll release their pipes lazily, so
  // measure the writes against the count at their own start.
  beforeAll(() => {
    baselineFds = fdCount();
  });

  const text = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
  const bSnapshot = () => fs.readdirSync(dirB).sort();

  test('a directory swapped during the parent walk is refused and nothing lands in B', async () => {
    write(path.join(dirA, 'wswap', 'next', 'keep.txt'), 'A');
    const before = bSnapshot();
    let swapped = false;
    groupFsTestHooks.beforeOpen = (label, segment) => {
      if (label !== path.join(dirA, 'wswap') || segment !== 'next') return;
      fs.rmSync(path.join(dirA, 'wswap', 'next'), { recursive: true });
      fs.symlinkSync(dirB, path.join(dirA, 'wswap', 'next'));
      swapped = true;
    };
    const root = (await openGroupDir(A))!;
    try {
      await rejectsWith(
        writeFileAt(root, 'wswap/next/new.txt', 'x', { mkdirs: true }),
        'symlink',
      );
      await rejectsWith(
        writeFileAt(root, 'wswap/next/new.txt', 'x', { atomic: false }),
        'symlink',
      );
    } finally {
      await root.close();
    }
    expect(swapped).toBe(true);
    expect(bSnapshot()).toEqual(before);
  });

  test('a positive-offset chunk needs an existing prefix: nothing is created or zero-filled', async () => {
    write(path.join(dirA, 'chunk', 'short.txt'), 'abc');
    const root = openGroupDirSync(A)!;
    try {
      const chunk = Buffer.from('xyz');
      for (const rel of ['chunk/missing.txt', 'chunkgone/deep/out.txt']) {
        expect(() => writeChunkAtSync(root, rel, chunk, 10)).toThrow(
          GroupFsError,
        );
        expect(fs.existsSync(path.join(dirA, rel))).toBe(false);
      }
      expect(fs.existsSync(path.join(dirA, 'chunkgone'))).toBe(false);
      expect(() =>
        writeChunkAtSync(root, 'chunk/short.txt', chunk, 10),
      ).toThrow(GroupFsError);
      expect(text(dirA, 'chunk', 'short.txt')).toBe('abc');
      expect(fs.readdirSync(path.join(dirA, 'chunk')).sort()).toEqual([
        'short.txt',
      ]);
    } finally {
      root.closeSync();
    }
  });

  test('atomic writes replace a leaf link; in-place writes refuse links, hardlinks and directories', async () => {
    fs.symlinkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'wlink'));
    fs.symlinkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'wlink2'));
    fs.linkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'whard'));
    fs.mkdirSync(path.join(dirA, 'wdir'));
    const root = (await openGroupDir(A))!;
    try {
      await rejectsWith(
        writeFileAt(root, 'wlink', 'x', { atomic: false }),
        'symlink',
      );
      await rejectsWith(
        writeFileAt(root, 'whard', 'x', { atomic: false }),
        'not_regular_file',
      );
      await rejectsWith(writeFileAt(root, 'wdir', 'x'), 'not_regular_file');
      await rejectsWith(
        writeFileAt(root, 'wdir', 'x', { atomic: false }),
        'not_regular_file',
      );
      expect(text(dirB, 'secret.txt')).toBe('B-secret');

      await writeFileAt(root, 'wlink', 'fresh');
      writeFileAtSync(root, 'wlink2', 'fresh2');
      await writeFileAt(root, 'whard', 'fresh-hard');
      expect(fs.lstatSync(path.join(dirA, 'wlink')).isFile()).toBe(true);
      expect(text(dirA, 'wlink')).toBe('fresh');
      expect(text(dirA, 'wlink2')).toBe('fresh2');
      expect(text(dirA, 'whard')).toBe('fresh-hard');
      expect(text(dirB, 'secret.txt')).toBe('B-secret');

      // In-place write: same inode, content replaced, no temp files left.
      write(path.join(dirA, 'inplace.txt'), 'long old content');
      const inode = fs.statSync(path.join(dirA, 'inplace.txt')).ino;
      await writeFileAt(root, 'inplace.txt', 'new', { atomic: false });
      expect(text(dirA, 'inplace.txt')).toBe('new');
      expect(fs.statSync(path.join(dirA, 'inplace.txt')).ino).toBe(inode);

      // mkdirs creates pinned parents; modes apply to new files.
      await writeFileAt(root, 'wnew/a/b.txt', 'deep', {
        mkdirs: true,
        mode: 0o600,
      });
      expect(text(dirA, 'wnew', 'a', 'b.txt')).toBe('deep');
      expect(fs.statSync(path.join(dirA, 'wnew/a/b.txt')).mode & 0o777).toBe(
        0o600,
      );
      await rejectsWith(writeFileAt(root, 'nope/x.txt', 'x'), 'not_found');
      expect(fs.readdirSync(dirA).filter((n) => n.endsWith('.tmp'))).toEqual(
        [],
      );
    } finally {
      await root.close();
    }
  });

  test('followInternalLinks writes through board links but never out of the base', async () => {
    const proj = path.join(dirA, 'wproj');
    write(path.join(proj, '.agent', 'AGENTS.md'), 'agents');
    fs.symlinkSync('.agent', path.join(proj, '.claude'));
    fs.symlinkSync('.agent/AGENTS.md', path.join(proj, 'CLAUDE.md'));
    fs.symlinkSync(dirB, path.join(proj, 'abs'));
    const root = (await openGroupDir(A))!;
    try {
      await writeFileAt(root, 'wproj/.claude/r.md', 'rule', {
        followInternalLinks: true,
      });
      expect(text(proj, '.agent', 'r.md')).toBe('rule');
      await writeFileAt(root, 'wproj/CLAUDE.md', 'edited', {
        followInternalLinks: true,
      });
      expect(fs.lstatSync(path.join(proj, 'CLAUDE.md')).isSymbolicLink()).toBe(
        true,
      );
      expect(text(proj, '.agent', 'AGENTS.md')).toBe('edited');
      await rejectsWith(
        writeFileAt(root, 'wproj/.claude/r.md', 'x'),
        'symlink',
      );
      await rejectsWith(
        writeFileAt(root, 'wproj/abs/x.txt', 'x', {
          followInternalLinks: true,
        }),
        'symlink',
      );
      expect(bSnapshot()).not.toContain('x.txt');
    } finally {
      await root.close();
    }
  });

  test('appendFileAtSync appends, creates, and refuses links and hardlinks', async () => {
    fs.linkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'ahard'));
    fs.symlinkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'alink'));
    const root = (await openGroupDir(A))!;
    try {
      expect(() => appendFileAtSync(root, 'ahard', 'x')).toThrow(GroupFsError);
      expect(() => appendFileAtSync(root, 'alink', 'x')).toThrow(GroupFsError);
      expect(text(dirB, 'secret.txt')).toBe('B-secret');

      appendFileAtSync(root, 'app.log', 'one\n');
      appendFileAtSync(root, 'app.log', 'two\n');
      expect(text(dirA, 'app.log')).toBe('one\ntwo\n');
      expect(() =>
        appendFileAtSync(root, 'app-missing.log', 'x', { create: false }),
      ).toThrow(GroupFsError);
      expect(fs.existsSync(path.join(dirA, 'app-missing.log'))).toBe(false);
    } finally {
      await root.close();
    }
  });

  test('removeAt: files, links, directories and recursive trees', async () => {
    write(path.join(dirA, 'rm', 'f.txt'), 'f');
    write(path.join(dirA, 'rm', 'tree', 'a', 'b.txt'), 'b');
    fs.symlinkSync(dirB, path.join(dirA, 'rm', 'link'));
    fs.symlinkSync(dirB, path.join(dirA, 'rm', 'tree', 'a', 'link2'));
    write(path.join(dirA, 'rm', 'sync', 'x.txt'), 'x');
    const root = (await openGroupDir(A))!;
    try {
      expect(await removeAt(root, 'rm/f.txt')).toBe(true);
      expect(await removeAt(root, 'rm/f.txt')).toBe(false);
      expect(await removeAt(root, 'rm/link')).toBe(true);
      await rejectsWith(removeAt(root, 'rm/tree'), 'io');
      expect(await removeAt(root, 'rm/tree', { recursive: true })).toBe(true);
      expect(removeAtSync(root, 'rm/sync', { recursive: true })).toBe(true);
      expect(removeAtSync(root, 'rm/sync')).toBe(false);
      expect(await removeAt(root, 'nodir/x')).toBe(false);
      expect(fs.readdirSync(path.join(dirA, 'rm'))).toEqual([]);
      expect(bSnapshot()).toContain('secret.txt');
    } finally {
      await root.close();
    }
  });

  test('removeAt recursive unlinks a subdirectory swapped for a link and leaves B intact', async () => {
    write(path.join(dirA, 'rmswap', 'top', 'sub', 'f.txt'), 'f');
    const before = bSnapshot();
    let swapped = false;
    groupFsTestHooks.beforeOpen = (label, segment) => {
      if (label !== path.join(dirA, 'rmswap', 'top') || segment !== 'sub') {
        return;
      }
      fs.rmSync(path.join(dirA, 'rmswap', 'top', 'sub'), { recursive: true });
      fs.symlinkSync(dirB, path.join(dirA, 'rmswap', 'top', 'sub'));
      swapped = true;
    };
    const root = (await openGroupDir(A))!;
    try {
      expect(await removeAt(root, 'rmswap/top', { recursive: true })).toBe(
        true,
      );
    } finally {
      await root.close();
    }
    expect(swapped).toBe(true);
    expect(fs.existsSync(path.join(dirA, 'rmswap', 'top'))).toBe(false);
    expect(bSnapshot()).toEqual(before);
    expect(text(dirB, 'secret.txt')).toBe('B-secret');
    expect(text(dirB, 'sub', 'secret.txt')).toBe('B-secret');
  });

  test('renameAt works across two pinned directories and refuses swapped parents', async () => {
    write(path.join(dirA, 'mv-src', 'f.txt'), 'moved');
    fs.mkdirSync(path.join(dirA, 'mv-dst'));
    fs.symlinkSync(path.join(dirB, 'secret.txt'), path.join(dirA, 'mv-link'));
    const root = (await openGroupDir(A))!;
    const src = (await openDirAt(root, 'mv-src'))!;
    const dst = (await openDirAt(root, 'mv-dst'))!;
    try {
      await renameAt(src, 'f.txt', dst, 'g.txt');
      expect(text(dirA, 'mv-dst', 'g.txt')).toBe('moved');
      expect(fs.existsSync(path.join(dirA, 'mv-src', 'f.txt'))).toBe(false);
      await rejectsWith(renameAt(src, 'f.txt', dst, 'h.txt'), 'not_found');
      // A link is renamed as a link, never followed.
      await renameAt(root, 'mv-link', dst, 'moved-link');
      expect(
        fs.lstatSync(path.join(dirA, 'mv-dst', 'moved-link')).isSymbolicLink(),
      ).toBe(true);
      // The pinned destination keeps its inode after the path is swapped.
      fs.renameSync(path.join(dirA, 'mv-dst'), path.join(dirA, 'mv-dst-old'));
      fs.symlinkSync(dirB, path.join(dirA, 'mv-dst'));
      await renameAt(dst, 'g.txt', dst, 'again.txt');
      expect(text(dirA, 'mv-dst-old', 'again.txt')).toBe('moved');
      await rejectsWith(
        renameAt(root, 'mv-dst-old/again.txt', root, 'mv-dst/x.txt'),
        'symlink',
      );
      expect(bSnapshot()).not.toContain('x.txt');
    } finally {
      await dst.close();
      await src.close();
      await root.close();
    }
  });

  test('copyTree keeps links as links and skips a FIFO', async () => {
    write(path.join(dirA, 'ctsrc', 'a.txt'), 'A');
    write(path.join(dirA, 'ctsrc', 'sub', 'b.txt'), 'B');
    fs.symlinkSync(dirB, path.join(dirA, 'ctsrc', 'abs-link'));
    fs.symlinkSync('a.txt', path.join(dirA, 'ctsrc', 'sub', 'rel-link'));
    const root = (await openGroupDir(A))!;
    const src = (await openDirAt(root, 'ctsrc'))!;
    const dst = await mkdirAt(root, 'ctdst');
    const boardDest = path.join(dirA, 'ctboard');
    try {
      await copyTree(src, dst);
      await copyTree(src, boardDest);
      for (const base of [path.join(dirA, 'ctdst'), boardDest]) {
        expect(text(base, 'a.txt')).toBe('A');
        expect(text(base, 'sub', 'b.txt')).toBe('B');
        expect(fs.readlinkSync(path.join(base, 'abs-link'))).toBe(dirB);
        expect(fs.readlinkSync(path.join(base, 'sub', 'rel-link'))).toBe(
          'a.txt',
        );
        expect(fs.existsSync(path.join(base, 'fifo'))).toBe(false);
      }
      // Copying again over existing links and files works.
      await copyTree(src, dst);
      // A link planted in the board-owned dest is replaced, not written through.
      fs.rmSync(path.join(dirA, 'ctsrc', 'abs-link'));
      write(path.join(dirA, 'ctsrc', 'abs-link', 'inner.txt'), 'real');
      fs.rmSync(path.join(boardDest, 'abs-link'));
      fs.symlinkSync(dirB, path.join(boardDest, 'abs-link'));
      fs.rmSync(path.join(boardDest, 'a.txt'));
      fs.symlinkSync(
        path.join(dirB, 'secret.txt'),
        path.join(boardDest, 'a.txt'),
      );
      await copyTree(src, boardDest);
      expect(fs.lstatSync(path.join(boardDest, 'abs-link')).isDirectory()).toBe(
        true,
      );
      expect(text(boardDest, 'abs-link', 'inner.txt')).toBe('real');
      expect(text(boardDest, 'a.txt')).toBe('A');
      expect(bSnapshot()).toEqual(['secret.txt', 'sub']);
    } finally {
      await dst.close();
      await src.close();
      await root.close();
    }
  });

  test('writeGroupFileSync pins the parent of an absolute path', () => {
    fs.symlinkSync(dirB, path.join(dirA, 'wg-link'));
    writeGroupFileSync(path.join(dirA, 'wg', 'x.txt'), 'x', { mkdirs: true });
    expect(text(dirA, 'wg', 'x.txt')).toBe('x');
    expect(() =>
      writeGroupFileSync(path.join(dirA, 'wg-link', 'y.txt'), 'y'),
    ).toThrow(GroupFsError);
    expect(bSnapshot()).not.toContain('y.txt');
  });
});

describe('group-fs descriptors', () => {
  test('leaks no file descriptors', () => {
    expect(fdCount()).toBe(baselineFds);
  });
});

describe('sendPinnedFile', () => {
  let server: Server;
  let baseUrl: string;
  const queue: Awaited<ReturnType<typeof openFileAt>>[] = [];
  const closedFds: number[] = [];
  let closedSignal: (() => void) | null = null;

  beforeAll(async () => {
    const app = express();
    app.get('/f', (req, res) => {
      const opened = queue.shift()!;
      const fd = opened.handle.fd;
      res.once('close', () => {
        closedFds.push(fd);
        closedSignal?.();
      });
      sendPinnedFile(res, opened, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const isClosed = (fd: number) => {
    try {
      fs.fstatSync(fd);
      return false;
    } catch {
      return true;
    }
  };

  test('serves the pinned inode (full and Range) after the path is swapped, then closes the handle', async () => {
    write(path.join(dirA, 'srv', 'file.txt'), '0123456789');
    const root = (await openGroupDir(A))!;
    const fds: number[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const opened = (await openFileAt(root, 'srv/file.txt'))!;
        fds.push(opened.handle.fd);
        queue.push(opened);
      }
    } finally {
      await root.close();
    }
    // Replace the path with a link to B after the handles are open.
    fs.rmSync(path.join(dirA, 'srv', 'file.txt'));
    fs.symlinkSync(
      path.join(dirB, 'secret.txt'),
      path.join(dirA, 'srv', 'file.txt'),
    );

    const full = await fetch(`${baseUrl}/f`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toContain('text/plain');
    expect(full.headers.get('etag')).toBeTruthy();
    expect(await full.text()).toBe('0123456789');

    const range = await fetch(`${baseUrl}/f`, {
      headers: { Range: 'bytes=2-5' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await range.text()).toBe('2345');

    while (closedFds.length < 2) {
      await new Promise<void>((resolve) => {
        closedSignal = resolve;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fds.every(isClosed)).toBe(true);
    expect(text(dirB, 'secret.txt')).toBe('B-secret');
  });

  const text = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
});
