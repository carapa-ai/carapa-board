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

const ciRunner = path.resolve('scripts/test-ci.sh');
const selectedRunner = path.resolve('scripts/test-bun-selected.sh');
const browserRunner = path.resolve('scripts/test-browser.sh');
const temporaryDirectories: string[] = [];

const browserTestFiles = [
  'ui/src/components/chat/chat-message-bubble.browser.test.ts',
  'ui/src/components/chat/chat-page-handoff.browser.test.ts',
  'ui/src/components/chat/direct-llm-sandbox.browser.test.ts',
  'ui/src/components/chat/file-explorer.browser.test.ts',
  'ui/src/components/chat/queued-prompt-list.browser.test.ts',
];
const nativeTestFile = 'ui/src/lib/native-boot-lock.test.ts';

interface FixtureOptions {
  playwright?: boolean;
  processTree?: boolean;
}

async function fixture({
  playwright = false,
  processTree = false,
}: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'carapa-test-routing-'));
  temporaryDirectories.push(root);
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  await mkdir(bin, { recursive: true });
  await mkdir(calls, { recursive: true });
  await mkdir(path.join(root, 'process-ready'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'ui/node_modules/.bin'), { recursive: true });
  await writeFile(path.join(root, 'src/ordinary.test.ts'), '');
  await writeFile(path.join(root, 'ui/node_modules/.bin/vitest'), '');
  await chmod(path.join(root, 'ui/node_modules/.bin/vitest'), 0o755);
  for (const script of [
    'test-bun-selected.sh',
    'test-ci-backend.sh',
    'test-browser.sh',
    'test-file-groups.sh',
    'load-test-env.sh',
  ]) {
    const target = path.join(root, 'scripts', script);
    await writeFile(target, await readFile(path.resolve('scripts', script)));
    await chmod(target, 0o755);
  }
  await writeFile(
    path.join(bin, 'bun'),
    `#!/usr/bin/env bash
printf '%s\\0' "$PWD" "$@" > "$CALLS_DIR/call.$$"
if [[ -n "\${OPENAI_API_KEY:-}" ]]; then
  : > "$CREDENTIAL_LEAK_FILE"
fi
for argument in "$@"; do
  if [[ "$argument" == "\${SELECTED_FAIL_FILE:-}" ]]; then
    printf 'fixture failure: %s\\n' "$argument" >&2
    exit 23
  fi
done
${
  processTree
    ? `if [[ "$*" == *".browser.test.ts"* ]]; then
  test_file="\${@: -1}"
  ready="$PROCESS_READY_DIR/$$"
  (
    trap 'printf "%s\\n" "$test_file" >> "$PROCESS_REAPED_FILE"; exit 0' TERM
    touch "$ready"
    while :; do sleep 0.01; done
  ) &
  while [[ ! -e "$ready" ]]; do sleep 0.01; done
fi
`
    : ''
}`,
  );
  await chmod(path.join(bin, 'bun'), 0o755);
  if (playwright) {
    await writeFile(path.join(bin, 'playwright-cli'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(bin, 'playwright-cli'), 0o755);
    for (const testFile of browserTestFiles) {
      const target = path.join(root, testFile);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '');
    }
  }
  return { root, bin, calls };
}

async function run(
  runner: string,
  root: string,
  bin: string,
  calls: string,
  args: string[] = [],
  selectedFailFile = '',
) {
  const result = Bun.spawnSync(['/bin/bash', runner, ...args], {
    cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CALLS_DIR: calls,
      CI_TEST_JOBS: '2',
      PROCESS_READY_DIR: path.join(root, 'process-ready'),
      PROCESS_REAPED_FILE: path.join(root, 'process-reaped'),
      SELECTED_FAIL_FILE: selectedFailFile,
      OPENAI_API_KEY: 'must-not-reach-tests',
      CREDENTIAL_LEAK_FILE: path.join(root, 'credential-leak'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let credentialLeaked = true;
  try {
    await access(path.join(root, 'credential-leak'));
  } catch {
    credentialLeaked = false;
  }
  return {
    result,
    stderr: result.stderr.toString(),
    calls: await readCalls(calls),
    credentialLeaked,
  };
}

async function readCalls(directory: string): Promise<string[][]> {
  const files = await readdir(directory);
  const calls = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(path.join(directory, file), 'utf8');
      return raw.split('\0').slice(0, -1);
    }),
  );
  return calls.sort((left, right) =>
    left.join('\0').localeCompare(right.join('\0')),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('test domain routing', () => {
  test('the server/web UI runner excludes only browser and native Bun suites', async () => {
    const { root, bin, calls } = await fixture();
    const execution = await run(ciRunner, root, bin, calls, ['ui']);

    expect(execution.result.exitCode).toBe(0);
    expect(execution.credentialLeaked).toBe(false);
    expect(execution.calls).toContainEqual([
      path.join(root, 'ui'),
      'run',
      'test',
      '--maxWorkers=4',
    ]);
    const ordinaryUiRun = execution.calls.find(
      (call) => call.at(-1) === 'ui/src',
    );
    expect(ordinaryUiRun).toBeDefined();
    expect(ordinaryUiRun).toContain(
      '--path-ignore-patterns=**/*.browser.test.ts',
    );
    expect(ordinaryUiRun).toContain(
      '--path-ignore-patterns=**/*.browser.test.tsx',
    );
    expect(ordinaryUiRun).toContain(`--path-ignore-patterns=${nativeTestFile}`);
    expect(ordinaryUiRun).not.toContain('--path-ignore-patterns=ui/src');
  });

  test('the Android runner executes the native boot lock suite explicitly', async () => {
    const { root, bin, calls } = await fixture();
    const execution = await run(ciRunner, root, bin, calls, ['android']);

    expect(execution.result.exitCode).toBe(0);
    const executedFiles = execution.calls
      .filter((call) => call[1] === 'test')
      .map((call) => call.find((argument) => argument.endsWith('.test.ts')));
    expect(executedFiles).toContain(nativeTestFile);
    for (const testFile of browserTestFiles) {
      expect(executedFiles).not.toContain(testFile);
    }
  });

  test('the selected runner isolates configured files and batches only the exact ordinary files', async () => {
    const { root, bin, calls } = await fixture();
    await mkdir(path.join(root, 'src/modules/kanban'), { recursive: true });
    await writeFile(
      path.join(root, 'src/modules/kanban/archive-task.test.ts'),
      '',
    );
    const execution = await run(selectedRunner, root, bin, calls, [
      'src/modules/kanban/archive-task.test.ts',
      'src/ordinary.test.ts',
    ]);

    expect(execution.result.exitCode).toBe(0);
    expect(execution.credentialLeaked).toBe(false);
    expect(execution.calls).toEqual([
      [
        root,
        'test',
        '--no-env-file',
        '--timeout',
        '30000',
        '--only-failures',
        'src/modules/kanban/archive-task.test.ts',
      ],
      [
        root,
        'test',
        '--no-env-file',
        '--timeout',
        '30000',
        '--only-failures',
        'src/ordinary.test.ts',
      ],
    ]);
  });

  test('the selected runner preserves a child failure and names its suite', async () => {
    const { root, bin, calls } = await fixture();
    const failingFile = 'src/modules/kanban/archive-task.test.ts';
    await mkdir(path.dirname(path.join(root, failingFile)), {
      recursive: true,
    });
    await writeFile(path.join(root, failingFile), '');
    const execution = await run(
      selectedRunner,
      root,
      bin,
      calls,
      [failingFile],
      failingFile,
    );

    expect(execution.result.exitCode).toBe(23);
    expect(execution.stderr).toContain(
      `Selected isolated test failed: ${failingFile}`,
    );
  });

  test('selected isolation prevents a module replacement from leaking into the ordinary batch', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'carapa-selected-isolation-'),
    );
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'src/modules/kanban'), { recursive: true });
    for (const script of [
      'test-bun-selected.sh',
      'test-file-groups.sh',
      'load-test-env.sh',
    ]) {
      const target = path.join(root, 'scripts', script);
      await writeFile(target, await readFile(path.resolve('scripts', script)));
      await chmod(target, 0o755);
    }
    await writeFile(
      path.join(root, 'src/shared.ts'),
      "export const value = 'real';\n",
    );
    await writeFile(
      path.join(root, 'src/modules/kanban/archive-task.test.ts'),
      `import { expect, mock, test } from 'bun:test';
mock.module('../../shared.ts', () => ({ value: 'mocked' }));
const { value } = await import('../../shared.ts');
test('uses the replacement', () => expect(value).toBe('mocked'));
`,
    );
    await writeFile(
      path.join(root, 'src/ordinary.test.ts'),
      `import { expect, test } from 'bun:test';
import { value } from './shared.ts';
test('uses the real module', () => expect(value).toBe('real'));
`,
    );

    const result = Bun.spawnSync(
      [
        '/bin/bash',
        selectedRunner,
        'src/modules/kanban/archive-task.test.ts',
        'src/ordinary.test.ts',
      ],
      {
        cwd: root,
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test('the dedicated browser runner discovers and serializes every suite', async () => {
    const { root, bin, calls } = await fixture({ playwright: true });
    const execution = await run(browserRunner, root, bin, calls);

    expect(execution.result.exitCode).toBe(0);
    expect(execution.calls).toContainEqual([
      path.join(root, 'ui'),
      'run',
      'test:browser-runtime',
    ]);
    const browserCalls = execution.calls.filter(
      (call) => call[0] === root && call[1] === 'test',
    );
    expect(browserCalls).toEqual(
      browserTestFiles.map((testFile) => [
        root,
        'test',
        '--no-env-file',
        '--only-failures',
        testFile,
      ]),
    );
  });

  test('the dedicated browser runner reaps descendants after every suite', async () => {
    const { root, bin, calls } = await fixture({
      playwright: true,
      processTree: true,
    });
    const execution = await run(browserRunner, root, bin, calls);

    expect(execution.result.exitCode).toBe(0);
    expect(
      (await readFile(path.join(root, 'process-reaped'), 'utf8'))
        .trim()
        .split('\n'),
    ).toEqual(browserTestFiles);
  });

  test('the ordinary complete gate leaves browser suites to the explicit browser gate', async () => {
    const { root, bin, calls } = await fixture({ playwright: true });
    const execution = await run(ciRunner, root, bin, calls);

    expect(execution.result.exitCode).toBe(0);
    const browserCalls = execution.calls.filter(
      (call) =>
        call[0] === root &&
        call[1] === 'test' &&
        call.some((argument) => argument.endsWith('.browser.test.ts')),
    );
    expect(browserCalls).toEqual([]);
  });

  test('the dedicated browser runner fails instead of silently skipping without Playwright', async () => {
    const { root, bin, calls } = await fixture();
    const execution = await run(browserRunner, root, bin, calls);

    expect(execution.result.exitCode).toBe(127);
    expect(execution.stderr).toContain('playwright-cli is required');
    expect(execution.calls).toEqual([]);
  });
});
