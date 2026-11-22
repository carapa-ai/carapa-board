import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { GROUPS_DIR } from '../../config.js';
import { groupFsTestHooks } from '../../lib/group-fs.js';
import { datedTranscriptName } from '../../group-dir.js';
import {
  restoreFromArchiveIfMissing,
  restoreFromArchiveIfMissingAsync,
} from './archive-restore.js';
import { withTranscriptLock } from './transcript-append-service.js';
import { readTaskMessages } from './transcript-store.js';

describe('restoreFromArchiveIfMissing with an in-process async writer', () => {
  const projectId = `archive-restore-writer-lock-${process.pid}`;
  const taskId = `task-${Date.now()}-wlock1`;
  const transcriptDir = path.join(GROUPS_DIR, projectId, 'transcripts');
  const livePaths = [
    path.join(transcriptDir, datedTranscriptName(`${taskId}.jsonl`, taskId)),
    path.join(transcriptDir, `${taskId}.stream.jsonl`),
  ];

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, projectId), {
      recursive: true,
      force: true,
    });
  });

  test('returns false instead of throwing and reads stay empty', async () => {
    fs.mkdirSync(transcriptDir, { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered: Promise<void>[] = [];
    const writers = livePaths.map((livePath) => {
      let markEntered!: () => void;
      entered.push(new Promise<void>((resolve) => (markEntered = resolve)));
      return withTranscriptLock(livePath, async () => {
        markEntered();
        await gate;
      });
    });
    try {
      await Promise.all(entered);
      for (const livePath of livePaths) {
        expect(
          restoreFromArchiveIfMissing(
            path.join(transcriptDir, 'archive'),
            livePath,
            [path.basename(livePath)],
          ),
        ).toBe(false);
      }
      expect(readTaskMessages(projectId, taskId)).toEqual([]);
    } finally {
      release();
      await Promise.all(writers);
    }
  });
});

describe('restoreFromArchiveIfMissing with hostile archive member names', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'archive-restore-hostile-'),
  );
  const transcriptsDir = path.join(root, 'transcripts');
  const archiveDir = path.join(transcriptsDir, 'archive');
  const line = JSON.stringify({ type: 'user', text: 'hi' }) + '\n';
  // Relative on purpose: if tar parses this member name as `--index-file`, it
  // creates the file in tar's cwd.
  const sentinel = `option-injection-sentinel-${process.pid}-${Date.now()}`;
  const hostileOption = `--index-file=${sentinel}-hostile.jsonl`;

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${sentinel}-hostile.jsonl`, { force: true });
  });

  function buildArchive(name: string, members: string[]) {
    const src = path.join(root, `src-${name}`);
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    const tarPath = path.join(archiveDir, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', tarPath, '-C', src, '--', ...members], {
      stdio: 'ignore',
    });
    return { src, tarPath };
  }

  // Minimal ustar writer: GNU and busybox tar disagree on (or refuse) hostile
  // member names such as `../x`, so the fixture must not depend on the CLI.
  function writeRawArchive(name: string, memberName: string, body: string) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(memberName, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    const sum = header.reduce((acc, byte) => acc + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, `${name}.tar.gz`),
      zlib.gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)])),
    );
  }

  function prepare(name: string, members: string[]): string {
    const src = path.join(root, `src-${name}`);
    fs.mkdirSync(src, { recursive: true });
    for (const member of members)
      fs.writeFileSync(path.join(src, member), line);
    return src;
  }

  test('restores the normal member, never passes hostile names to tar as options', async () => {
    const normal = `task-${Date.now()}-hostl1.jsonl`;
    const members = ['--checkpoint=1', hostileOption, normal];
    prepare('opts', members);
    buildArchive('opts', members);

    const livePath = path.join(transcriptsDir, 'live-opts.jsonl');
    expect(restoreFromArchiveIfMissing(archiveDir, livePath, [normal])).toBe(
      true,
    );
    expect(fs.readFileSync(livePath, 'utf8')).toBe(line);

    // Fuzzy matching would select the hostile member (its basename ends in
    // the requested suffix); it must be skipped instead of reaching tar.
    const fuzzyLive = path.join(transcriptsDir, 'live-fuzzy.jsonl');
    expect(
      await restoreFromArchiveIfMissingAsync(archiveDir, fuzzyLive, [
        `hostile.jsonl`,
      ]),
    ).toBe(false);
    expect(fs.existsSync(`${sentinel}-hostile.jsonl`)).toBe(false);
  });

  test('skips a ../ member even when requested by name', () => {
    writeRawArchive('dotdot', '../x', line);
    const livePath = path.join(transcriptsDir, 'live-dotdot.jsonl');
    expect(
      restoreFromArchiveIfMissing(
        archiveDir,
        livePath,
        ['../x'],
        'dotdot.tar.gz',
      ),
    ).toBe(false);
    expect(fs.existsSync(livePath)).toBe(false);
  });
});

describe('restoreFromArchiveIfMissing bundle selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-restore-pick-'));
  const archiveDir = path.join(root, 'transcripts', 'archive');
  const shadowDir = path.join(root, 'shadow-bin');
  const listingLog = path.join(root, 'listings.log');
  const slowListing = path.join(root, 'slow-listing');
  const originalPath = process.env.PATH;
  const member = 'task-1-pick.jsonl';

  beforeAll(() => {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(shadowDir, { recursive: true });
    // Count `tar -tzf` listings while delegating to the real tar.
    const realTar = execFileSync('sh', ['-c', 'command -v tar'], {
      encoding: 'utf8',
    }).trim();
    const shim = path.join(shadowDir, 'tar');
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nif [ "$1" = "-tzf" ]; then echo "$2" >> '${listingLog}'; [ -e '${slowListing}' ] && sleep 0.5; fi\nexec '${realTar}' "$@"\n`,
    );
    fs.chmodSync(shim, 0o755);
    process.env.PATH = `${shadowDir}${path.delimiter}${originalPath}`;
  });
  afterAll(() => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function bundle(name: string, lineCount: number, extraMember?: string) {
    const src = path.join(root, `src-${name}`);
    fs.mkdirSync(src, { recursive: true });
    const body = Array.from({ length: lineCount }, (_, i) =>
      JSON.stringify({ type: 'user', text: `line ${i}` }),
    ).join('\n');
    fs.writeFileSync(path.join(src, member), `${body}\n`);
    const members = [member];
    if (extraMember) {
      fs.writeFileSync(path.join(src, extraMember), `${body}\n`);
      members.push(extraMember);
    }
    const tarPath = path.join(archiveDir, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', tarPath, '-C', src, '--', ...members], {
      stdio: 'ignore',
    });
    return tarPath;
  }

  function listings(): number {
    return fs.existsSync(listingLog)
      ? fs.readFileSync(listingLog, 'utf8').split('\n').filter(Boolean).length
      : 0;
  }

  function restoredLines(livePath: string): number {
    return fs.readFileSync(livePath, 'utf8').split('\n').filter(Boolean).length;
  }

  test('a date bundle outranks a legacy-bot bundle', async () => {
    bundle('2026-02-01', 4);
    bundle('legacy-bot-pick', 1);
    const live = path.join(root, 'live-legacy.jsonl');
    expect(restoreFromArchiveIfMissing(archiveDir, live, [member])).toBe(true);
    expect(restoredLines(live)).toBe(4);

    const liveAsync = path.join(root, 'live-legacy-async.jsonl');
    expect(
      await restoreFromArchiveIfMissingAsync(archiveDir, liveAsync, [member]),
    ).toBe(true);
    expect(restoredLines(liveAsync)).toBe(4);
  });

  test('member lists are cached per unchanged bundle and re-listed on change', async () => {
    fs.rmSync(archiveDir, { recursive: true, force: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.rmSync(listingLog, { force: true });
    const tarPath = bundle('2026-03-01', 3);
    const live = path.join(root, 'live-cache.jsonl');

    expect(restoreFromArchiveIfMissing(archiveDir, live, [member])).toBe(true);
    expect(listings()).toBe(1);

    fs.rmSync(live);
    expect(restoreFromArchiveIfMissing(archiveDir, live, [member])).toBe(true);
    expect(listings()).toBe(1);

    // Size change (rewritten bundle) invalidates the cached list.
    bundle('2026-03-01', 3, 'other-member.jsonl');
    fs.rmSync(live);
    expect(restoreFromArchiveIfMissing(archiveDir, live, [member])).toBe(true);
    expect(listings()).toBe(2);

    // An mtime-only change does too.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(tarPath, future, future);
    fs.rmSync(live);
    expect(restoreFromArchiveIfMissing(archiveDir, live, [member])).toBe(true);
    expect(listings()).toBe(3);

    // Concurrent restores of different live files share one listing of a
    // bundle that has not been listed yet.
    const concurrentTar = bundle('2026-03-02', 3);
    const futureTar = new Date(Date.now() + 120_000);
    fs.utimesSync(concurrentTar, futureTar, futureTar);
    const lives = ['a', 'b', 'c'].map((n) =>
      path.join(root, `live-concurrent-${n}.jsonl`),
    );
    const results = await Promise.all(
      lives.map((p) =>
        restoreFromArchiveIfMissingAsync(archiveDir, p, [member]),
      ),
    );
    expect(results).toEqual([true, true, true]);
    expect(listings()).toBe(4);
  });

  test('a sync lookup waits for an in-flight async listing instead of listing again', async () => {
    fs.rmSync(archiveDir, { recursive: true, force: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.rmSync(listingLog, { force: true });
    bundle('2026-04-01', 3);
    const liveAsync = path.join(root, 'live-mixed-async.jsonl');
    const liveSync = path.join(root, 'live-mixed-sync.jsonl');

    fs.writeFileSync(slowListing, '');
    try {
      const asyncRestore = restoreFromArchiveIfMissingAsync(
        archiveDir,
        liveAsync,
        [member],
      );
      // Let the async restore reach its (deliberately slow) listing.
      while (listings() === 0) await new Promise((r) => setImmediate(r));

      expect(restoreFromArchiveIfMissing(archiveDir, liveSync, [member])).toBe(
        true,
      );
      expect(await asyncRestore).toBe(true);
    } finally {
      fs.rmSync(slowListing, { force: true });
    }
    expect(listings()).toBe(1);
    expect(restoredLines(liveSync)).toBe(3);
    expect(restoredLines(liveAsync)).toBe(3);
  });
});

// Security (D-438): the live transcript's parent is agent-writable and can be
// swapped for a link to another project while a restore runs.
describe('restoreFromArchiveIfMissing with a swapped live parent', () => {
  const groupA = `archive-restore-swap-a-${process.pid}`;
  const groupB = `archive-restore-swap-b-${process.pid}`;
  const member = 'task-1-swap.jsonl';
  const archived = JSON.stringify({ type: 'user', text: 'from archive' });
  const foreign = JSON.stringify({ type: 'user', text: 'project B' }) + '\n';

  afterAll(() => {
    groupFsTestHooks.beforeOpen = undefined;
    for (const g of [groupA, groupB]) {
      fs.rmSync(path.join(GROUPS_DIR, g), { recursive: true, force: true });
    }
  });

  test('never writes into the other project or restores its content', () => {
    const dirA = path.join(GROUPS_DIR, groupA);
    const dirB = path.join(GROUPS_DIR, groupB);
    const archiveDir = path.join(dirA, 'transcripts', 'archive');
    const src = path.join(dirA, 'src');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(dirA, 'live'), { recursive: true });
    fs.mkdirSync(path.join(dirB, 'live'), { recursive: true });
    fs.writeFileSync(path.join(src, member), `${archived}\n`);
    execFileSync(
      'tar',
      ['-czf', path.join(archiveDir, '2026-01-01.tar.gz'), '-C', src, member],
      { stdio: 'ignore' },
    );
    fs.writeFileSync(path.join(dirB, 'live', member), foreign);
    const livePath = path.join(dirA, 'live', member);

    let swapped = false;
    groupFsTestHooks.beforeOpen = (_label, segment) => {
      // The bundle is opened after the live file was found missing.
      if (swapped || segment !== '2026-01-01.tar.gz') return;
      swapped = true;
      fs.renameSync(path.join(dirA, 'live'), path.join(dirA, 'live-moved'));
      fs.symlinkSync(path.join(dirB, 'live'), path.join(dirA, 'live'));
    };
    try {
      // The swap is detected on the pinned path: the restore must not succeed
      // (lock release may also refuse the swapped parent, which is fine).
      let restored = false;
      try {
        restored = restoreFromArchiveIfMissing(archiveDir, livePath, [member]);
      } catch {
        /* fail closed */
      }
      expect(restored).toBe(false);
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
    }

    expect(swapped).toBe(true);
    expect(fs.readdirSync(path.join(dirB, 'live'))).toEqual([member]);
    expect(fs.readFileSync(path.join(dirB, 'live', member), 'utf8')).toBe(
      foreign,
    );
  });
});
