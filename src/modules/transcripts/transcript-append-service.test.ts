import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { groupFsTestHooks } from '../../lib/group-fs.js';
import {
  appendTranscriptLines,
  appendTranscriptLinesSync,
  deleteTranscriptUnderLock,
  ingestTranscriptSpoolSync,
  initializeTranscriptSpoolSync,
  transcriptCheckpointPath,
  TranscriptLockBusyError,
  withTranscriptLockHeld,
  withTranscriptLockSync,
} from './transcript-append-service.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'carapa-transcript-append-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('transcript append service', () => {
  test('deduplicates durable top-level IDs and preserves id-less rows', () => {
    const target = path.join(temporaryDirectory(), 'conversation.jsonl');
    appendTranscriptLinesSync(target, [
      { id: 'one', value: 1 },
      { value: 'legacy-one' },
    ]);
    const result = appendTranscriptLinesSync(target, [
      { id: 'one', value: 1 },
      { id: 'two', value: 2 },
      { value: 'legacy-two' },
      { id: 'two', value: 2 },
    ]);

    expect(result).toMatchObject({ appendedLines: 2, duplicateLines: 2 });
    expect(readJsonl(target)).toEqual([
      { id: 'one', value: 1 },
      { value: 'legacy-one' },
      { id: 'two', value: 2 },
      { value: 'legacy-two' },
    ]);
  });

  test('preserves distinct legacy updates that reuse a provider ID', () => {
    const target = path.join(temporaryDirectory(), 'conversation.jsonl');
    appendTranscriptLinesSync(target, [{ id: 'native-item', delta: 'a' }]);
    appendTranscriptLinesSync(target, [{ id: 'native-item', delta: 'b' }]);

    expect(readJsonl(target)).toEqual([
      { id: 'native-item', delta: 'a' },
      { id: 'native-item', delta: 'b' },
    ]);
  });

  test('rejects conflicting content for a canonical event ID', () => {
    const target = path.join(temporaryDirectory(), 'conversation.jsonl');
    appendTranscriptLinesSync(target, [
      { schemaVersion: '1', id: 'tev1_same', value: 'first' },
    ]);

    expect(() =>
      appendTranscriptLinesSync(target, [
        { schemaVersion: '1', id: 'tev1_same', value: 'changed' },
      ]),
    ).toThrow('Conflicting canonical transcript ID');
    expect(readJsonl(target)).toEqual([
      { schemaVersion: '1', id: 'tev1_same', value: 'first' },
    ]);
  });

  test('serializes synchronous and asynchronous appenders', async () => {
    const target = path.join(temporaryDirectory(), 'conversation.jsonl');
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        appendTranscriptLines(target, [{ id: `async-${index}`, index }]),
      ),
    );
    appendTranscriptLinesSync(target, [{ id: 'sync', index: 50 }]);

    const rows = readJsonl(target);
    expect(rows).toHaveLength(51);
    expect(new Set(rows.map((row) => row.id)).size).toBe(51);
  });

  test('serializes writers in separate processes without corrupting JSONL', async () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    const worker = fileURLToPath(
      new URL('./__fixtures__/transcript-append-worker.ts', import.meta.url),
    );
    const children = Array.from({ length: 4 }, (_, index) =>
      Bun.spawn([process.execPath, worker, target, `worker-${index}`, '30'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          CARAPA_DATA_DIR: path.dirname(DATA_DIR),
        },
      }),
    );
    const exitCodes = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(
      children.map((child) => new Response(child.stderr).text()),
    );

    expect(exitCodes, errors.join('\n')).toEqual([0, 0, 0, 0]);
    const rows = readJsonl(target);
    expect(rows).toHaveLength(120);
    expect(new Set(rows.map((row) => row.id)).size).toBe(120);
    expect(
      fs
        .readdirSync(directory)
        .filter((name) => name.includes('.transcript.lock')),
    ).toEqual([]);
  });

  test('releases a killed writer’s lock immediately', async () => {
    const target = path.join(temporaryDirectory(), 'conversation.jsonl');
    const worker = fileURLToPath(
      new URL('./__fixtures__/transcript-append-worker.ts', import.meta.url),
    );
    const child = Bun.spawn([process.execPath, worker, target, 'hold'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        CARAPA_DATA_DIR: path.dirname(DATA_DIR),
      },
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('locked');
      expect(() => withTranscriptLockSync(target, () => {})).toThrow(
        TranscriptLockBusyError,
      );
      child.kill('SIGKILL');
      await child.exited;
      const start = performance.now();
      appendTranscriptLinesSync(target, [{ id: 'recovered' }]);
      expect(performance.now() - start).toBeLessThan(100);
      expect(readJsonl(target)).toEqual([{ id: 'recovered' }]);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  });

  test('waits for another process holding the lock, and delete removes the flock file', async () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    const spool = path.join(directory, 'run.output.jsonl');
    fs.writeFileSync(spool, '{"id":"reply"}\n');
    const worker = fileURLToPath(
      new URL('./__fixtures__/transcript-append-worker.ts', import.meta.url),
    );
    const child = Bun.spawn([process.execPath, worker, target, 'hold'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        CARAPA_DATA_DIR: path.dirname(DATA_DIR),
      },
    });
    try {
      const ready = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain('locked');
      const waiting = withTranscriptLockHeld(target, () =>
        ingestTranscriptSpoolSync(target, spool, (source) => [source.trim()]),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(target)).toBe(false);
      child.kill('SIGKILL');
      await child.exited;
      await waiting;
      expect(readJsonl(target)).toEqual([{ id: 'reply' }]);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }

    const lockFiles = () =>
      fs
        .readdirSync(path.join(DATA_DIR, 'transcript-locks'))
        .filter((name) => name.endsWith('.transcript.flock'));
    const before = lockFiles().length;
    withTranscriptLockSync(target, () => {
      deleteTranscriptUnderLock(target);
      // Unlinked only on release, so the hold stays exclusive until then.
      expect(lockFiles().length).toBe(before);
    });
    expect(lockFiles().length).toBe(before - 1);
    appendTranscriptLinesSync(target, [{ id: 'again' }]);
    expect(readJsonl(target)).toEqual([{ id: 'again' }]);
  });

  test('repairs only an incomplete final row and quarantines its bytes', () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    fs.writeFileSync(target, '{"id":"complete"}\n{"id":"partial"');

    appendTranscriptLinesSync(target, [{ id: 'after-repair' }]);

    expect(readJsonl(target)).toEqual([
      { id: 'complete' },
      { id: 'after-repair' },
    ]);
    expect(
      fs
        .readdirSync(directory)
        .some((name) => name.startsWith('conversation.jsonl.partial-')),
    ).toBe(true);
  });

  test('replays after a crash before append and commits the checkpoint once', () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    const spool = path.join(directory, 'run.output.jsonl');
    fs.writeFileSync(spool, '{"id":"source-one"}\n');

    expect(() =>
      ingestTranscriptSpoolSync(
        target,
        spool,
        (source) => source.trim().split('\n'),
        {
          faultInjector(point) {
            if (point === 'after_pending_checkpoint') throw new Error('crash');
          },
        },
      ),
    ).toThrow('crash');
    expect(fs.existsSync(target)).toBe(false);

    const recovered = ingestTranscriptSpoolSync(target, spool, (source) =>
      source.trim().split('\n'),
    );
    expect(recovered.alreadyCommitted).toBe(true);
    expect(readJsonl(target)).toEqual([{ id: 'source-one' }]);
  });

  test('does not duplicate rows after transcript fsync but before checkpoint commit', () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    const spool = path.join(directory, 'run.output.jsonl');
    fs.writeFileSync(spool, '{"id":"source-one"}\n');

    expect(() =>
      ingestTranscriptSpoolSync(
        target,
        spool,
        (source) => source.trim().split('\n'),
        {
          faultInjector(point) {
            if (point === 'after_transcript_fsync') throw new Error('crash');
          },
        },
      ),
    ).toThrow('crash');
    expect(readJsonl(target)).toEqual([{ id: 'source-one' }]);

    ingestTranscriptSpoolSync(target, spool, (source) =>
      source.trim().split('\n'),
    );
    expect(readJsonl(target)).toEqual([{ id: 'source-one' }]);
  });

  test('truncates a known partial transaction before replaying it', () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    const spool = path.join(directory, 'run.output.jsonl');
    const row = '{"id":"source-one","value":"complete"}';
    fs.writeFileSync(spool, `${row}\n`);

    expect(() =>
      ingestTranscriptSpoolSync(target, spool, () => [row], {
        faultInjector(point) {
          if (point === 'after_pending_checkpoint') throw new Error('crash');
        },
      }),
    ).toThrow('crash');
    fs.writeFileSync(target, row.slice(0, 12));

    ingestTranscriptSpoolSync(target, spool, () => [row]);
    expect(readJsonl(target)).toEqual([
      { id: 'source-one', value: 'complete' },
    ]);
  });

  test('rejects a rewritten spool after its checkpoint was committed', () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, 'conversation.jsonl');
    const spool = path.join(directory, 'run.output.jsonl');
    fs.writeFileSync(spool, '{"id":"source-one"}\n');
    ingestTranscriptSpoolSync(target, spool, (source) =>
      source.trim().split('\n'),
    );
    fs.writeFileSync(spool, '{"id":"source-two"}\n');

    expect(() =>
      ingestTranscriptSpoolSync(target, spool, (source) =>
        source.trim().split('\n'),
      ),
    ).toThrow('Committed spool was changed');
    expect(readJsonl(target)).toEqual([{ id: 'source-one' }]);
    expect(fs.existsSync(transcriptCheckpointPath(spool))).toBe(true);
  });

  test('keeps dual-writer checkpoints independent', () => {
    const directory = temporaryDirectory();
    const legacyTarget = path.join(directory, 'legacy.jsonl');
    const canonicalTarget = path.join(directory, 'canonical.v1.jsonl');
    const spool = path.join(directory, 'run.output.jsonl');
    fs.writeFileSync(spool, '{"id":"source-one"}\n');

    ingestTranscriptSpoolSync(
      canonicalTarget,
      spool,
      (source) => source.trim().split('\n'),
      { checkpointNamespace: 'pi-v1' },
    );
    ingestTranscriptSpoolSync(legacyTarget, spool, (source) =>
      source.trim().split('\n'),
    );

    expect(fs.existsSync(transcriptCheckpointPath(spool))).toBe(true);
    expect(fs.existsSync(transcriptCheckpointPath(spool, 'pi-v1'))).toBe(true);
  });

  test('creates a stable spool identity before the native output exists', () => {
    const directory = temporaryDirectory();
    const spool = path.join(directory, 'run.output.jsonl');

    const first = initializeTranscriptSpoolSync(spool);
    fs.writeFileSync(spool, '{"id":"first"}\n');
    const second = initializeTranscriptSpoolSync(spool);
    fs.writeFileSync(spool, '{"id":"rewritten"}\n');

    expect(first).toBe(second);
  });

  test('refuses to append through a symlinked or hardlinked transcript', () => {
    const directory = temporaryDirectory();
    const outside = path.join(directory, 'outside.txt');
    fs.writeFileSync(outside, 'original\n');
    const symlinked = path.join(directory, 'symlinked.jsonl');
    fs.symlinkSync(outside, symlinked);
    expect(() => appendTranscriptLinesSync(symlinked, [{ id: 'a' }])).toThrow();

    const hardlinked = path.join(directory, 'hardlinked.jsonl');
    fs.writeFileSync(hardlinked, '{"id":"seed"}\n');
    fs.linkSync(hardlinked, path.join(directory, 'hardlink-peer.jsonl'));
    expect(() =>
      appendTranscriptLinesSync(hardlinked, [{ id: 'b' }]),
    ).toThrow();

    expect(fs.readFileSync(outside, 'utf8')).toBe('original\n');
    expect(fs.readFileSync(hardlinked, 'utf8')).toBe('{"id":"seed"}\n');
  });

  describe('agent-writable transcripts directory', () => {
    const group = `test-append-pinned-${process.pid}`;
    const foreign = `${group}-foreign`;
    const groupDir = path.join(GROUPS_DIR, group);
    const foreignDir = path.join(GROUPS_DIR, foreign);

    afterEach(() => {
      groupFsTestHooks.beforeOpen = undefined;
      fs.rmSync(groupDir, { recursive: true, force: true });
      fs.rmSync(foreignDir, { recursive: true, force: true });
    });

    test('a FIFO at the index path is rebuilt, not read', () => {
      const dir = path.join(groupDir, 'transcripts');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, 'chat.jsonl');
      fs.writeFileSync(target, '{"id":"one"}\n');
      try {
        execFileSync('mkfifo', [`${target}.transcript-index.json`]);
      } catch {
        return; // mkfifo unavailable
      }

      const result = appendTranscriptLinesSync(target, [
        { id: 'one' },
        { id: 'two' },
      ]);

      expect(result).toMatchObject({ appendedLines: 1, duplicateLines: 1 });
      expect(readJsonl(target)).toEqual([{ id: 'one' }, { id: 'two' }]);
      expect(fs.lstatSync(`${target}.transcript-index.json`).isFile()).toBe(
        true,
      );
    }, 2000);

    test('swapping the transcripts directory for a link during an append writes nothing there', () => {
      const dir = path.join(groupDir, 'transcripts');
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(foreignDir, { recursive: true });
      groupFsTestHooks.beforeOpen = (_label, segment) => {
        if (segment !== 'transcripts' || fs.lstatSync(dir).isSymbolicLink()) {
          return;
        }
        fs.renameSync(dir, `${dir}-moved`);
        fs.symlinkSync(foreignDir, dir);
      };

      expect(() =>
        appendTranscriptLinesSync(path.join(dir, 'chat.jsonl'), [
          { id: 'secret' },
        ]),
      ).toThrow();

      expect(fs.readdirSync(foreignDir)).toEqual([]);
    });
  });
});
