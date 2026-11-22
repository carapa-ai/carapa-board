import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-recordings-'));
const groups = path.join(root, 'groups');
// Isolate .env discovery from the developer's repository configuration.
const script = path.join(root, 'scripts', 'cleanup-recordings.sh');
fs.mkdirSync(path.dirname(script));
fs.copyFileSync(path.resolve(import.meta.dir, 'cleanup-recordings.sh'), script);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function recording(relative: string, ageDays: number) {
  const file = path.join(groups, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'video');
  const time = new Date(Date.now() - ageDays * 86400 * 1000);
  fs.utimesSync(file, time, time);
  return file;
}

function run(...args: string[]) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LC_ALL: 'C', CARAPA_DATA_DIR: root },
  });
}

test('cleanup respects preview, age, project scope and recording storage boundaries', () => {
  const old = recording('one/recordings/task-a/old\nvideo.WEBM', 3.1);
  const recent = recording('one/recordings/task-a/recent.webm', 2.9);
  const other = recording('two/recordings/task-b/other.webm', 5);
  const retained = [
    recording('one/recordings/task-a/notes.txt', 5),
    recording('one/recordings/task-a/nested/video.webm', 5),
    recording('one/artifacts/video.webm', 5),
    recording('one/ipc/recordings/run-a/video.webm', 5),
    recording('one/recordings/meeting/video.webm', 5),
  ];
  fs.symlinkSync(other, path.join(groups, 'one/recordings/task-a/link.webm'));
  fs.symlinkSync(
    path.dirname(other),
    path.join(groups, 'one/recordings/task-link'),
  );
  fs.symlinkSync(path.join(groups, 'two'), path.join(groups, 'linked-project'));
  fs.mkdirSync(path.join(groups, 'linked-recordings'));
  fs.symlinkSync(
    path.join(groups, 'two/recordings'),
    path.join(groups, 'linked-recordings/recordings'),
  );

  const preview = run('--project', 'one');
  expect(preview.status).toBe(0);
  expect(preview.stdout).toBe(
    'Would delete: 1 recording(s), 5 bytes total.\nPreview only. Add --apply to delete.\n',
  );
  expect(fs.existsSync(old)).toBe(true);

  const applied = run('--project', 'one', '--apply');
  expect(applied.status).toBe(0);
  expect(applied.stdout).toBe('Deleted: 1 recording(s), 5 bytes total.\n');
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(recent)).toBe(true);
  expect(fs.existsSync(other)).toBe(true);

  const all = run('--all', '--days', '0', '--apply');
  expect(all.status).toBe(0);
  expect(all.stdout).toBe('Deleted: 2 recording(s), 10 bytes total.\n');
  expect(fs.existsSync(recent)).toBe(false);
  expect(fs.existsSync(other)).toBe(false);
  for (const file of retained) expect(fs.existsSync(file)).toBe(true);
  expect(run('--apply').stdout).toBe(
    'Deleted: 0 recording(s), 0 bytes total.\n',
  );
});

test('invalid scope or age fails before deleting anything', () => {
  const file = recording('protected/recordings/task-a/keep.webm', 5);
  const missingEnv = spawnSync('bash', [script, '--days', '0', '--apply'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
  expect(missingEnv.status).not.toBe(0);
  expect(missingEnv.stderr).toContain('CARAPA_DATA_DIR must be set');
  expect(fs.existsSync(file)).toBe(true);
  for (const args of [
    ['--days', '-1'],
    ['--days', 'oops'],
    ['--days', ''],
    ['--project', '..'],
    ['--project', 'one/../../two'],
    ['--project', 'protected', '--all'],
    ['--project', 'missing'],
    ['--unexpected'],
    ['--days'],
  ]) {
    expect(run('--apply', ...args).status).not.toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  }
});
