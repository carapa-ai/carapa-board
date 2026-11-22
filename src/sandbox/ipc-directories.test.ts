import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSandboxIpcRunsDir } from './ipc-directories.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ipc-recovery-'));
const lockedDirs: string[] = [];
afterAll(() => {
  for (const dir of lockedDirs) {
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
  }
  for (const dir of fs.readdirSync(root)) {
    fs.chmodSync(path.join(root, dir), 0o755);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function legacyIpc(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'recovery.json'), 'preserved run state');
  fs.chmodSync(dir, 0o555);
  lockedDirs.push(dir);
  return dir;
}

test('prepares new IPC storage without a status request', async () => {
  const dir = path.join(root, 'new-instance');
  await prepareSandboxIpcRunsDir(
    dir,
    {
      sandboxStatus: async () => {
        throw new Error('unnecessary status request');
      },
    },
    'carapa-bot',
    'new-instance',
  );
  fs.writeFileSync(path.join(dir, 'runs', 'probe'), 'writable');
});

// Real filesystem permission enforcement requires an unprivileged test process.
describe.skipIf(process.getuid?.() === 0)('legacy IPC recovery', () => {
  test('preserves old state and creates writable runs only for a stopped stack', async () => {
    const dir = legacyIpc('stopped');
    const calls: unknown[][] = [];
    await prepareSandboxIpcRunsDir(
      dir,
      {
        sandboxStatus: async (...args) => {
          calls.push(args);
          return { stdout: '[{"State":"exited"}]', isError: false };
        },
      },
      'carapa-bot',
      'stopped',
    );
    expect(calls).toEqual([['carapa-bot', 'stopped']]);
    fs.writeFileSync(path.join(dir, 'runs', 'probe'), 'writable');
    const archives = fs
      .readdirSync(root)
      .filter((name) => name.startsWith('stopped.stale-'));
    expect(archives).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(root, archives[0], 'recovery.json'), 'utf8'),
    ).toBe('preserved run state');
  });

  test('never replaces storage for a live sidecar or unconfirmed status', async () => {
    const statuses = [
      { stdout: '[{"State":"exited"},{"State":"running"}]', isError: false },
      { stdout: '[{"State":"paused"}]', isError: false },
      { stdout: '[]', isError: true },
      { stdout: 'unavailable', isError: false },
      { stdout: '[{}]', isError: false },
    ];
    for (const [index, status] of statuses.entries()) {
      const dir = legacyIpc(`unconfirmed-${index}`);
      const inode = fs.statSync(dir).ino;
      await expect(
        prepareSandboxIpcRunsDir(
          dir,
          {
            sandboxStatus: async () => status,
          },
          'carapa-bot',
          'unconfirmed',
        ),
      ).rejects.toThrow('Could not confirm');
      expect(fs.statSync(dir).ino).toBe(inode);
      expect(fs.readFileSync(path.join(dir, 'recovery.json'), 'utf8')).toBe(
        'preserved run state',
      );
      expect(fs.existsSync(path.join(dir, 'runs'))).toBe(false);
    }
  });
});
