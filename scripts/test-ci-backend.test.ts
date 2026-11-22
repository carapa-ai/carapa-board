import { afterEach, describe, expect, test } from 'bun:test';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runner = path.resolve('scripts/test-ci-backend.sh');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(files: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'carapa-ci-shards-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(
    path.join(root, 'scripts/test-file-groups.sh'),
    await readFile(path.resolve('scripts/test-file-groups.sh')),
  );
  await writeFile(
    path.join(root, 'scripts/load-test-env.sh'),
    await readFile(path.resolve('scripts/load-test-env.sh')),
  );
  for (const file of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '');
  }
  const fakeBun = `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$CALLS_FILE.$$"
if [[ -n "\${OPENAI_API_KEY:-}" ]]; then
  : > "$CREDENTIAL_LEAK_FILE"
fi
for argument in "$@"; do
  if [[ "$argument" == *"fail.test.ts" ]]; then
    printf '%s:\\n(fail) disposable failure\\n' "$argument" >&2
    exit 23
  fi
done
`;
  await writeFile(path.join(root, 'bin/bun'), fakeBun);
  await chmod(path.join(root, 'bin/bun'), 0o755);
  return root;
}

async function run(root: string, shards: string, exclusions: string[] = []) {
  const calls = path.join(root, 'calls');
  const result = Bun.spawnSync(
    [
      '/bin/bash',
      runner,
      ...exclusions.flatMap((file) => ['--exclude', file]),
      '--',
      'src',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        CALLS_FILE: calls,
        CREDENTIAL_LEAK_FILE: path.join(root, 'credential-leak'),
        CI_TEST_SHARDS: shards,
        OPENAI_API_KEY: 'must-not-reach-tests',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const callFiles = (await readdir(root)).filter((file) =>
    file.startsWith('calls.'),
  );
  const assignments = await Promise.all(
    callFiles.map(async (file) => {
      const raw = await readFile(path.join(root, file), 'utf8');
      const args = raw.split('\0').filter(Boolean);
      expect(args.slice(0, 5)).toEqual([
        'test',
        '--no-env-file',
        '--timeout',
        '30000',
        '--only-failures',
      ]);
      return args.slice(5);
    }),
  );
  assignments.sort((left, right) => left[0]!.localeCompare(right[0]!));
  let credentialLeaked = true;
  try {
    await access(path.join(root, 'credential-leak'));
  } catch {
    credentialLeaked = false;
  }
  return {
    result,
    assignments,
    stderr: result.stderr.toString(),
    credentialLeaked,
  };
}

describe('ordinary backend CI sharding', () => {
  test('assigns every sorted eligible file exactly once across balanced shards', async () => {
    const root = await fixture([
      'src/d.test.ts',
      'src/a.test.ts',
      'src/c.spec.ts',
      'src/b.test.tsx',
      'src/new.browser.test.ts',
      'src/new.browser.test.tsx',
    ]);
    const { result, assignments } = await run(root, '2');
    expect(result.exitCode).toBe(0);
    expect(assignments).toEqual([
      ['src/a.test.ts', 'src/c.spec.ts'],
      ['src/b.test.tsx', 'src/d.test.ts'],
    ]);
    expect(new Set(assignments.flat()).size).toBe(4);
  });

  test('normalizes dot-prefixed exclusions before assignment', async () => {
    const root = await fixture([
      'src/keep.test.ts',
      'src/isolated.test.ts',
      'src/not-a-test.ts',
    ]);
    const { assignments } = await run(root, '2', ['./src/isolated.test.ts']);
    expect(assignments).toEqual([['src/keep.test.ts']]);
  });

  test('sanitizes inherited provider credentials before starting shards', async () => {
    const root = await fixture(['src/ordinary.test.ts']);
    const { result, credentialLeaked } = await run(root, '1');

    expect(result.exitCode).toBe(0);
    expect(credentialLeaked).toBe(false);
  });

  test.each(['0'])('rejects invalid shard count %s', async (shards) => {
    const root = await fixture(['src/a.test.ts']);
    const { result, stderr } = await run(root, shards);
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(
      'CI_TEST_SHARDS must be an integer between 1 and 8',
    );
  });

  test('combines shard failures and preserves actionable names', async () => {
    const root = await fixture(['src/a-fail.test.ts', 'src/b-fail.test.ts']);
    const { result, stderr } = await run(root, '2');
    expect(result.exitCode).toBe(23);
    expect(stderr).toContain('src/a-fail.test.ts:\n(fail) disposable failure');
    expect(stderr).toContain('src/b-fail.test.ts:\n(fail) disposable failure');
  });
});
