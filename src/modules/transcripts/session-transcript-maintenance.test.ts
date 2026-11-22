import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { maintainSessionTranscripts } from './session-transcript-maintenance.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryGroups(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-transcript-maintenance-'),
  );
  roots.push(root);
  return root;
}

function writeAt(file: string, content: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const time = new Date(mtimeMs);
  fs.utimesSync(file, time, time);
}

describe('session transcript maintenance', () => {
  test('archives complete old bundles atomically and prunes only verified expired archives', () => {
    const groupsDir = temporaryGroups();
    const directory = path.join(
      groupsDir,
      'parent',
      'project',
      'session-transcripts',
    );
    const now = Date.UTC(2026, 8, 2, 12);
    const old = now - 10 * 86_400_000;
    const young = now - 2 * 86_400_000;
    for (const [name, content] of [
      ['run-old.v1.jsonl', '{"type":"run","status":"started"}\n'],
      [
        'run-old.v1.meta.json',
        '{"format":"carapa-run","version":1,"harness":"opencode","requestedModel":null}\n',
      ],
      ['run-old.prompt.txt', 'prompt'],
      ['run-old.system.txt', 'system prompt'],
      ['run-old.opencode.raw.jsonl', '{"native":true}\n'],
      ['run-old.jsonl.transcript-index.json', '{"version":1}\n'],
    ] as const) {
      writeAt(path.join(directory, name), content, old);
    }
    writeAt(path.join(directory, 'run-young.jsonl'), '{}\n', young);
    writeAt(path.join(directory, 'run-incomplete.v1.jsonl'), '{}\n', old);

    const preview = maintainSessionTranscripts({ groupsDir, now });
    expect(preview.mode).toBe('dry-run');
    expect(preview.directories[0]).toMatchObject({
      eligibleBundles: 1,
      eligibleFiles: 6,
      archivedBundles: 0,
      skippedIncompleteV1Bundles: ['run-incomplete'],
    });
    expect(fs.existsSync(path.join(directory, 'archive'))).toBe(false);

    const applied = maintainSessionTranscripts({
      groupsDir,
      now,
      apply: true,
    });
    expect(applied.directories[0]).toMatchObject({
      archivedBundles: 1,
      archivedFiles: 6,
    });
    expect(fs.existsSync(path.join(directory, 'run-old.v1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'run-young.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'run-incomplete.v1.jsonl'))).toBe(
      true,
    );
    const archiveDirectory = path.join(directory, 'archive');
    const archive = path.join(archiveDirectory, 'week-of-2026-08-17.tar.gz');
    const members = execFileSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
    });
    expect(members).toContain('./run-old.v1.jsonl');
    expect(members).toContain('./run-old.v1.meta.json');
    expect(members).toContain('./run-old.opencode.raw.jsonl');
    expect(members).toContain('./run-old.system.txt');

    const expired = new Date(now - 31 * 86_400_000);
    fs.utimesSync(archive, expired, expired);
    const corrupt = path.join(archiveDirectory, 'corrupt.tar.gz');
    writeAt(corrupt, 'broken', expired.getTime());
    const pruned = maintainSessionTranscripts({
      groupsDir,
      now,
      apply: true,
    });
    expect(pruned.directories[0]).toMatchObject({
      prunableArchives: 2,
      prunedArchives: 1,
    });
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.existsSync(corrupt)).toBe(true);
  });
});
