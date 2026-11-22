import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(root: string, ...args: string[]): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', args, { cwd: root, stdio: 'ignore', env });
}

function runGuard(root: string): number | null {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return spawnSync('bash', ['ui/android/check-native-version.sh', 'HEAD'], {
    cwd: root,
    env,
  }).status;
}

describe('Android native compatibility version guard', () => {
  test('fails native changes without a bump and accepts web-only or bumped changes', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'android-native-guard-'),
    );
    try {
      fs.mkdirSync(path.join(root, 'ui/android/app/src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ui/dist'), { recursive: true });
      fs.mkdirSync(path.join(root, 'ui/patches'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'ui/package.json'),
        '{"dependencies":{"react":"1"}}\n',
      );
      fs.writeFileSync(
        path.join(root, 'ui/package-lock.json'),
        '{"lockfileVersion":3}\n',
      );
      fs.copyFileSync(
        'ui/android/check-native-version.sh',
        path.join(root, 'ui/android/check-native-version.sh'),
      );
      fs.writeFileSync(
        path.join(root, 'ui/android/native-shell-version.json'),
        '{"versionCode":2,"bundleGeneration":1}\n',
      );
      fs.writeFileSync(path.join(root, 'ui/android/app/src/Main.kt'), 'v1\n');
      fs.writeFileSync(path.join(root, 'ui/patches/native.patch'), 'base\n');
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'test@example.invalid');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'base');

      fs.writeFileSync(path.join(root, 'ui/android/app/src/Main.kt'), 'v2\n');
      expect(runGuard(root)).toBe(1);

      git(root, 'checkout', '-q', '--', 'ui/android/app/src/Main.kt');
      fs.writeFileSync(path.join(root, 'ui/dist/index.html'), 'web-only\n');
      fs.writeFileSync(
        path.join(root, 'ui/package-lock.json'),
        '{"lockfileVersion":3,"packages":{"lodash":"1"}}\n',
      );
      fs.writeFileSync(
        path.join(root, 'ui/package.json'),
        '{"dependencies":{"react":"1","lodash":"1"}}\n',
      );
      expect(runGuard(root)).toBe(0);

      fs.writeFileSync(
        path.join(root, 'ui/package-lock.json'),
        '{"lockfileVersion":3,"packages":{"@capacitor/core":"2"}}\n',
      );
      expect(runGuard(root)).toBe(1);

      git(root, 'checkout', '-q', '--', 'ui/package-lock.json');
      fs.writeFileSync(path.join(root, 'ui/patches/native.patch'), 'native\n');
      expect(runGuard(root)).toBe(1);

      fs.rmSync(path.join(root, 'ui/patches'), {
        recursive: true,
        force: true,
      });
      fs.writeFileSync(
        path.join(root, 'ui/package.json'),
        '{"dependencies":{"react":"1","@capacitor/core":"1"}}\n',
      );
      expect(runGuard(root)).toBe(1);

      git(root, 'checkout', '-q', '--', 'ui/package.json');

      fs.writeFileSync(path.join(root, 'ui/android/app/src/Main.kt'), 'v3\n');
      fs.writeFileSync(
        path.join(root, 'ui/android/native-shell-version.json'),
        '{"versionCode":3,"bundleGeneration":1}\n',
      );
      expect(runGuard(root)).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
