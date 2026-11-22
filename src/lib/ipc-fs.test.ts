import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { GroupFsError, type PinnedDir, groupFsTestHooks } from './group-fs.js';
import {
  existsIpcEntrySync,
  ipcRoot,
  isNumericPid,
  openIpcDirSync,
  readIpcTextSync,
  removeIpcDirSync,
  removeIpcTreeSync,
  writeIpcFileSync,
} from './ipc-fs.js';

const suffix = `${process.pid}-${Date.now()}`;
const stackDir = path.join(ipcRoot(), `ipcfs-${suffix}`);
const outside = path.join(DATA_DIR, `ipcfs-outside-${suffix}`);
const runsDir = path.join(stackDir, 'runs');
const r1 = path.join(runsDir, 'r1');
let hasFifo = false;
const opened: PinnedDir[] = [];

const open = (abs: string) => {
  const dir = openIpcDirSync(abs);
  if (dir) opened.push(dir);
  return dir;
};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GroupFsError);
    return (err as GroupFsError).code;
  }
  return null;
};

beforeAll(() => {
  fs.mkdirSync(outside, { recursive: true });
  try {
    execFileSync('mkfifo', [path.join(outside, 'probe')]);
    hasFifo = true;
  } catch {
    /* mkfifo unavailable */
  }
});

const reset = () => {
  fs.rmSync(stackDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(r1, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'file'), 'outside-secret');
};

afterEach(() => {
  groupFsTestHooks.beforeOpen = undefined;
  while (opened.length) opened.pop()?.closeSync();
});

afterAll(() => {
  fs.rmSync(stackDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('ipc-fs', () => {
  test('write and read round-trip; missing entries are null/false', () => {
    reset();
    const dir = open(r1)!;
    expect(readIpcTextSync(dir, 'nope', 10)).toBeNull();
    expect(existsIpcEntrySync(dir, 'nope')).toBe(false);
    writeIpcFileSync(dir, 'pid', '42\n');
    expect(readIpcTextSync(dir, 'pid', 10)).toBe('42\n');
    expect(existsIpcEntrySync(dir, 'pid')).toBe(true);
    expect(open(path.join(runsDir, 'missing'))).toBeNull();
    expect(removeIpcTreeSync(runsDir, 'missing')).toBe(false);
  });

  test('leaf symlink is replaced; the target stays untouched', () => {
    reset();
    fs.symlinkSync(path.join(outside, 'file'), path.join(r1, 'clean_stop'));
    writeIpcFileSync(open(r1)!, 'clean_stop', '');
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
    const stat = fs.lstatSync(path.join(r1, 'clean_stop'));
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(0);
  });

  test('hardlink leaf is replaced; the other link keeps its content', () => {
    reset();
    fs.linkSync(path.join(outside, 'file'), path.join(r1, 'hl'));
    writeIpcFileSync(open(r1)!, 'hl', 'new');
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
    expect(fs.readFileSync(path.join(r1, 'hl'), 'utf8')).toBe('new');
  });

  test('dangling leaf link does not create its target', () => {
    reset();
    fs.symlinkSync(path.join(outside, 'new'), path.join(r1, 'dangling'));
    writeIpcFileSync(open(r1)!, 'dangling', 'x');
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
    expect(fs.lstatSync(path.join(r1, 'dangling')).isFile()).toBe(true);
  });

  test('trailing slash and multi-segment names are invalid_path', () => {
    reset();
    fs.symlinkSync(path.join(outside, 'file'), path.join(r1, 'link'));
    const dir = open(r1)!;
    expect(codeOf(() => writeIpcFileSync(dir, 'link/', 'x'))).toBe(
      'invalid_path',
    );
    expect(codeOf(() => readIpcTextSync(dir, 'link/', 10))).toBe(
      'invalid_path',
    );
    for (const bad of ['', '.', '..', 'a/b']) {
      expect(codeOf(() => existsIpcEntrySync(dir, bad))).toBe('invalid_path');
      expect(codeOf(() => removeIpcTreeSync(r1, bad))).toBe('invalid_path');
    }
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
  });

  test('read refuses a leaf symlink (null) and existsIpcEntrySync does not follow it', () => {
    reset();
    fs.symlinkSync(path.join(outside, 'file'), path.join(r1, 'link'));
    const dir = open(r1)!;
    expect(readIpcTextSync(dir, 'link', 100)).toBeNull();
    expect(existsIpcEntrySync(dir, 'link')).toBe(true);
    fs.symlinkSync(path.join(outside, 'gone'), path.join(r1, 'dangling'));
    expect(existsIpcEntrySync(dir, 'dangling')).toBe(true);
  });

  test('oversized file reads as null and is warned once', () => {
    reset();
    fs.writeFileSync(path.join(r1, 'big'), 'x'.repeat(50));
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const dir = open(r1)!;
      expect(readIpcTextSync(dir, 'big', 10)).toBeNull();
      expect(readIpcTextSync(dir, 'big', 10)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readIpcTextSync(dir, 'big', 50)).toBe('x'.repeat(50));
    } finally {
      warn.mockRestore();
    }
  });

  test('FIFO leaf reads as null without blocking', () => {
    if (!hasFifo) return;
    reset();
    execFileSync('mkfifo', [path.join(r1, 'fifo')]);
    expect(readIpcTextSync(open(r1)!, 'fifo', 10)).toBeNull();
  });

  test('a run dir swapped for a symlink is refused', () => {
    reset();
    fs.rmSync(r1, { recursive: true });
    fs.symlinkSync(outside, r1);
    expect(codeOf(() => openIpcDirSync(r1))).toBe('symlink');
    expect(codeOf(() => removeIpcTreeSync(r1, 'file'))).toBe('symlink');
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
  });

  test('a stack dir swapped for a symlink is refused', () => {
    reset();
    fs.rmSync(stackDir, { recursive: true });
    fs.mkdirSync(path.join(outside, 'runs', 'r1'), { recursive: true });
    fs.symlinkSync(outside, stackDir);
    expect(codeOf(() => openIpcDirSync(r1))).toBe('symlink');
  });

  test('a directory swapped after the anchor is opened is refused', () => {
    reset();
    groupFsTestHooks.beforeOpen = (label, segment) => {
      if (label === ipcRoot() && segment === path.basename(stackDir)) {
        fs.renameSync(stackDir, `${stackDir}.moved`);
        fs.symlinkSync(outside, stackDir);
      }
    };
    try {
      expect(codeOf(() => openIpcDirSync(r1))).toBe('symlink');
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
      fs.rmSync(stackDir, { force: true });
      fs.rmSync(`${stackDir}.moved`, { recursive: true, force: true });
    }
    expect(fs.readdirSync(outside)).toEqual(['file']);
  });

  test('paths outside the IPC root, and the root itself, are invalid_path', () => {
    expect(codeOf(() => openIpcDirSync(ipcRoot()))).toBe('invalid_path');
    expect(codeOf(() => openIpcDirSync(DATA_DIR))).toBe('invalid_path');
    expect(codeOf(() => openIpcDirSync(path.join(ipcRoot(), '..', 'x')))).toBe(
      'invalid_path',
    );
    expect(codeOf(() => openIpcDirSync('/etc'))).toBe('invalid_path');
    expect(codeOf(() => openIpcDirSync('relative/path'))).toBe('invalid_path');
  });

  test('removeIpcTreeSync removes a tree and only unlinks an inner link', () => {
    reset();
    fs.mkdirSync(path.join(r1, 'sub'));
    fs.writeFileSync(path.join(r1, 'sub', 'a'), 'a');
    fs.symlinkSync(outside, path.join(r1, 'sub', 'out'));
    expect(removeIpcTreeSync(runsDir, 'r1')).toBe(true);
    expect(fs.existsSync(r1)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
  });

  test('removal does not follow a swapped subdirectory link', () => {
    reset();
    fs.symlinkSync(outside, path.join(r1, 'sub'));
    expect(removeIpcDirSync(r1)).toBe(true);
    expect(fs.existsSync(r1)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
  });

  test('a run dir that is itself a link is unlinked, not followed', () => {
    reset();
    fs.rmSync(r1, { recursive: true });
    fs.symlinkSync(outside, r1);
    expect(removeIpcDirSync(r1)).toBe(true);
    expect(fs.lstatSync(r1, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe(
      'outside-secret',
    );
  });

  test('removing a missing run dir warns once; a link above it is refused with one warn', () => {
    reset();
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const gone = path.join(runsDir, 'gone');
      expect(removeIpcDirSync(gone)).toBe(false);
      expect(removeIpcDirSync(gone)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      fs.rmSync(runsDir, { recursive: true });
      fs.symlinkSync(outside, runsDir);
      fs.mkdirSync(path.join(outside, 'r2'));
      expect(removeIpcDirSync(path.join(runsDir, 'r2'))).toBe(false);
      expect(removeIpcDirSync(path.join(runsDir, 'r2'))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(fs.existsSync(path.join(outside, 'r2'))).toBe(true);
  });

  test('a FIFO inside the tree is unlinked without blocking', () => {
    if (!hasFifo) return;
    reset();
    execFileSync('mkfifo', [path.join(r1, 'fifo')]);
    expect(removeIpcDirSync(r1)).toBe(true);
    expect(fs.existsSync(r1)).toBe(false);
  });

  test('isNumericPid accepts digits only', () => {
    expect(isNumericPid('123')).toBe(true);
    expect(isNumericPid(' 123\n')).toBe(true);
    for (const bad of ['', '12 3', '1;id', '-1', '0x10', '1.5', '١٢']) {
      expect(isNumericPid(bad)).toBe(false);
    }
  });
});
