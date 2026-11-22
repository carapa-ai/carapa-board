import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { chmod, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { waitForFileState } from '../src/test-file-events.js';
import path from 'node:path';
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';

let fakeBinDir: string;

beforeAll(async () => {
  fakeBinDir = await mkdtemp(path.join(os.tmpdir(), 'carapa-verify-test-'));
  await writeFile(
    path.join(fakeBinDir, 'wait-file.ts'),
    `
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
const file = Bun.argv[2];
await new Promise<void>((resolve, reject) => {
  const watcher = watch(path.dirname(file), check);
  watcher.on('error', reject);
  function check() {
    if (!existsSync(file)) return;
    watcher.close();
    resolve();
  }
  check();
});
`,
  );
  const fakeCommand = `#!/bin/sh
command_name="\${0##*/}"
if [ "$command_name" = "flock" ]; then
  if [ -n "\${VERIFY_FAKE_LOCK_CONTENTION_FILE:-}" ]; then
    if "${Bun.which('flock')}" -n "$@"; then exit 0; fi
    : > "\${VERIFY_FAKE_LOCK_CONTENTION_FILE}"
  fi
  exec "${Bun.which('flock')}" "$@"
fi
if { [ "$command_name" = "bun" ] || [ "$command_name" = "npm" ]; } && [ -n "\${OPENAI_API_KEY:-}" ]; then
  : > "\${VERIFY_CREDENTIAL_LEAK_FILE}"
fi
if [ "$command_name" = "git" ]; then
  if [ -n "\${VERIFY_FAKE_GIT_LOG:-}" ]; then
    printf '%s\\n' "$*" >> "\${VERIFY_FAKE_GIT_LOG}"
  fi
  if [ -n "\${VERIFY_FAKE_GIT_FAILURE:-}" ]; then
    exit 29
  fi
  if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then
    if [ -n "\${VERIFY_FAKE_INVALID_BASE:-}" ]; then
      exit 1
    fi
    if [ "$3" = "HEAD" ]; then
      printf '%s\\n' "\${VERIFY_FAKE_HEAD:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
    else
      printf '%s\\n' "\${VERIFY_FAKE_RESOLVED_BASE:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
    fi
  elif [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then
    if [ -n "\${VERIFY_FAKE_NON_ANCESTOR:-}" ]; then
      exit 1
    fi
  elif [ "$1" = "merge-base" ]; then
    if [ -n "\${VERIFY_FAKE_MERGE_BASE_FAILURE:-}" ]; then
      exit 1
    fi
    printf '%s\n' "\${VERIFY_FAKE_MERGE_BASE:-cccccccccccccccccccccccccccccccccccccccc}"
  elif [ "$1" = "diff" ] && [ -n "\${VERIFY_FAKE_GIT_DIFF:-}" ]; then
    printf '%s\\n' "\${VERIFY_FAKE_GIT_DIFF:-}"
  elif [ "$1" = "ls-files" ] && [ -n "\${VERIFY_FAKE_GIT_UNTRACKED:-}" ]; then
    printf '%s\\n' "\${VERIFY_FAKE_GIT_UNTRACKED:-}"
  fi
  exit 0
fi
if [ "$command_name" = "npm" ] && [ -n "\${VERIFY_FAKE_NPM_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "\${VERIFY_FAKE_NPM_LOG}"
fi
if [ "$command_name" = "bun" ] && [ -n "\${VERIFY_FAKE_NPM_LOG:-}" ]; then
  printf 'bun %s\\n' "$*" >> "\${VERIFY_FAKE_NPM_LOG}"
fi
if [ "$command_name" = "bun" ] && [ "$1" = "scripts/verify-semantic-noop.ts" ]; then
  [ "\${VERIFY_FAKE_SEMANTIC_NOOP:-0}" = "1" ] && exit 0
  exit 1
fi
if [ "$command_name" = "bun" ] && { [ "$1" = "-e" ] || [ "$1" = "scripts/verify-importers.ts" ]; }; then
  exec "\${VERIFY_REAL_BUN}" "$@"
fi
if [ "$command_name" = "npm" ] && [ -n "\${VERIFY_FAKE_NPM_OUTPUT:-}" ]; then
  printf '%s\\n' "\${VERIFY_FAKE_NPM_OUTPUT}"
fi
if [ "$command_name" = "npm" ] && [ "$1" = "exec" ]; then
  if [ "\${VERIFY_FAKE_FAILURE:-}" = "$command_name $*" ]; then
    exit 23
  fi
  exit 0
fi
if [ "$command_name" = "bash" ]; then
  if [ "$1" = "scripts/test-bun-selected.sh" ] || { [ "$1" = "scripts/test-ci.sh" ] && [ "$2" = "ui" ]; }; then
    if [ -n "\${VERIFY_FAKE_NPM_LOG:-}" ]; then
      printf 'bash %s\\n' "$*" >> "\${VERIFY_FAKE_NPM_LOG}"
    fi
    exec /bin/bash "$@"
  fi
  if [ "$1" = "ui/android/check-native-version.sh" ]; then
    if [ -n "\${VERIFY_FAKE_NPM_LOG:-}" ]; then
      printf 'bash %s\\n' "$*" >> "\${VERIFY_FAKE_NPM_LOG}"
    fi
    exit 0
  fi
  if [ "$1" = "scripts/test-browser.sh" ]; then
    if [ -n "\${VERIFY_FAKE_NPM_LOG:-}" ]; then
      printf 'bash %s\\n' "$*" >> "\${VERIFY_FAKE_NPM_LOG}"
    fi
    printf 'Ran 1 test across 1 file.\\n'
    exit 0
  fi
  exec /bin/bash "$@"
fi
printf 'command stdout: %s %s\\n' "$command_name" "$*"
printf 'command stderr: %s %s\\n' "$command_name" "$*" >&2
if [ "\${VERIFY_FAKE_FAILURE:-}" = "$command_name $*" ] || case "|\${VERIFY_FAKE_FAILURES:-}|" in *"|$command_name $*|"*) true ;; *) false ;; esac; then
  exit 23
fi
if [ -n "\${VERIFY_FAKE_HOLD_FILE:-}" ] && [ "$command_name $*" = "bun run format:check" ]; then
  if mkdir "\${VERIFY_FAKE_HOLD_FILE}.claim" 2>/dev/null; then
    mkfifo "\${VERIFY_FAKE_HOLD_FILE}.release"
    : > "\${VERIFY_FAKE_HOLD_FILE}.started"
    # Opening a FIFO blocks until the test opens its write end, so the release
    # cannot be missed the way a dropped file-watch event can.
    : < "\${VERIFY_FAKE_HOLD_FILE}.release"
  fi
fi
if [ -n "\${VERIFY_FAKE_OVERLAP_FILE:-}" ] && [ "$command_name $*" = "bun run typecheck" ]; then
  "${process.execPath}" "${fakeBinDir}/wait-file.ts" "\${VERIFY_FAKE_HOLD_FILE}.started"
  if [ -e "\${VERIFY_FAKE_HOLD_FILE}.started" ]; then
    : > "\${VERIFY_FAKE_OVERLAP_FILE}"
  fi
fi
if [ -n "\${VERIFY_FAKE_GATE_MARKER_DIR:-}" ]; then
  case "$command_name $*" in
    "bun run format:check"|"bun run typecheck"|"npm run typecheck")
      marker="\${VERIFY_FAKE_GATE_MARKER_DIR}/$command_name-$$"
      trap 'rm -f "$marker" "$marker.tmp"' EXIT
      # Publish the marker only once this gate holds the FIFO open read-write,
      # so the test's release byte always has a reader and is buffered until
      # read. The ".tmp" name is hidden from the test's marker count.
      mkfifo "$marker.tmp"
      exec 7<>"$marker.tmp"
      mv "$marker.tmp" "$marker"
      # Gates started after the release see the sticky file and pass through.
      if [ ! -e "\${VERIFY_FAKE_GATE_RELEASE}" ]; then
        read -r _ <&7
      fi
      ;;
  esac
fi
if [ -n "\${VERIFY_FAKE_DESCENDANT_FILE:-}" ] && [ "$command_name $*" = "bun run format:check" ]; then
  sleep 30 &
  printf '%s' "$!" > "\${VERIFY_FAKE_DESCENDANT_FILE}"
  wait "$!"
fi
`;

  await Promise.all(
    ['bun', 'bash', 'git', 'npm', 'flock'].map(async (name) => {
      const commandPath = path.join(fakeBinDir, name);
      await writeFile(commandPath, fakeCommand);
      await chmod(commandPath, 0o755);
    }),
  );
});

afterAll(async () => {
  await rm(fakeBinDir, { recursive: true, force: true });
});

function runVerify(
  failure = '',
  options: {
    changedDiff?: string;
    untracked?: string;
    npmOutput?: string;
    gitFailure?: boolean;
    timing?: boolean;
    verifyBaseSha?: string;
    invalidBase?: boolean;
    nonAncestorBase?: boolean;
    semanticNoop?: boolean;
    advancedWorktreeBase?: boolean;
  } = {},
) {
  const npmLog = path.join(fakeBinDir, 'npm.log');
  const gitLog = path.join(fakeBinDir, 'git.log');
  const credentialLeakFile = path.join(fakeBinDir, 'credential-leak');
  writeFileSync(npmLog, '');
  writeFileSync(gitLog, '');
  rmSync(credentialLeakFile, { force: true });
  const script =
    options.changedDiff !== undefined || options.untracked !== undefined
      ? 'scripts/verify-changed.sh'
      : 'scripts/verify.sh';
  const result = Bun.spawnSync(['/bin/bash', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      VERIFY_FAKE_FAILURE: failure,
      VERIFY_FAKE_FAILURES: failure,
      CARAPA_VERIFY_LOCK_HELD: '1',
      VERIFY_FAKE_GIT_DIFF: options.changedDiff ?? '',
      VERIFY_FAKE_GIT_UNTRACKED: options.untracked ?? '',
      VERIFY_FAKE_NPM_LOG: npmLog,
      VERIFY_FAKE_NPM_OUTPUT: options.npmOutput ?? '',
      VERIFY_FAKE_GIT_FAILURE: options.gitFailure ? '1' : '',
      VERIFY_REAL_BUN: process.execPath,
      CARAPA_VERIFY_TIMING: options.timing ? '1' : '0',
      DEFAULT_BRANCH: 'develop',
      ...(options.verifyBaseSha === undefined
        ? { CARAPA_VERIFY_BASE_SHA: undefined }
        : { CARAPA_VERIFY_BASE_SHA: options.verifyBaseSha }),
      VERIFY_FAKE_INVALID_BASE: options.invalidBase ? '1' : '',
      VERIFY_FAKE_NON_ANCESTOR: options.nonAncestorBase ? '1' : '',
      VERIFY_FAKE_SEMANTIC_NOOP: options.semanticNoop ? '1' : '0',
      VERIFY_FAKE_MERGE_BASE: options.advancedWorktreeBase
        ? 'cccccccccccccccccccccccccccccccccccccccc'
        : (options.verifyBaseSha ?? 'cccccccccccccccccccccccccccccccccccccccc'),
      VERIFY_FAKE_GIT_LOG: gitLog,
      VERIFY_CREDENTIAL_LEAK_FILE: credentialLeakFile,
      OPENAI_API_KEY: 'must-not-reach-tests',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    npm: (() => {
      try {
        return readFileSync(npmLog, 'utf8');
      } catch {
        return '';
      }
    })(),
    git: readFileSync(gitLog, 'utf8'),
    credentialLeaked: existsSync(credentialLeakFile),
  };
}

function waitForFile(file: string) {
  return waitForFileState(path.dirname(file), () =>
    existsSync(file) ? true : undefined,
  );
}

function waitForMarkerCount(directory: string, expected: number) {
  return waitForFileState(directory, () => {
    const markers = readdirSync(directory).filter(
      (entry) => !entry.startsWith('.'),
    );
    return markers.length === expected ? markers.length : undefined;
  });
}

const heldGates: { unblock: () => void; processes: Bun.Subprocess[] }[] = [];

// Registers a gated verification so afterEach can release it even when the test
// body fails or hits the runner timeout.
function trackGate(unblock: () => void, ...processes: Bun.Subprocess[]) {
  heldGates.push({ unblock, processes });
}

function trackHold(holdFile: string, ...processes: Bun.Subprocess[]) {
  trackGate(() => unblockHold(holdFile), ...processes);
}

// Release by rendezvous on the FIFO: the write-end open completes only once the
// held fake command has the read end open, so the release cannot be missed.
async function releaseHold(holdFile: string) {
  await (await open(`${holdFile}.release`, 'w')).close();
}

// Completes any blocked open on either end so no fake command or pending
// test-side open outlives the test.
function unblockHold(holdFile: string) {
  for (const flag of [constants.O_WRONLY, constants.O_RDONLY]) {
    try {
      closeSync(openSync(`${holdFile}.release`, flag | constants.O_NONBLOCK));
    } catch {
      // No FIFO yet, or no peer waiting: nothing is blocked on this end.
    }
  }
}

// Marks the gates released for later arrivals, then wakes every published
// marker. A published marker always has its gate holding the FIFO open
// read-write, so the byte is buffered even if the gate has not read yet; a
// gate that already finished has removed its marker.
function releaseGates(markerDir: string, releaseFile: string) {
  // Teardown after a test that already removed its directory has nothing to wake.
  if (!existsSync(markerDir)) return;
  writeFileSync(releaseFile, '');
  let markers: string[];
  try {
    markers = readdirSync(markerDir).filter((entry) => !entry.startsWith('.'));
  } catch {
    return;
  }
  for (const marker of markers) {
    try {
      const fd = openSync(
        path.join(markerDir, marker),
        constants.O_WRONLY | constants.O_NONBLOCK,
      );
      try {
        writeSync(fd, '\n');
      } finally {
        closeSync(fd);
      }
    } catch {
      // The gate finished and removed its marker between listing and opening.
    }
  }
}

afterEach(() => {
  for (const { unblock, processes } of heldGates.splice(0)) {
    for (const process of processes) {
      if (process.exitCode === null) process.kill();
    }
    unblock();
  }
});

describe('agent verification output', () => {
  test('is silent when every phase passes', () => {
    const result = runVerify();
    expect(result.exitCode, result.stderr).toBe(0);
    // The gate is no longer silent on success: it prints an explicit, greppable
    // marker so an agent can confirm green from output alone (a captured exit
    // code can be lost to compaction). stderr stays empty; the marker is stdout.
    expect(result.stdout).toContain('Verification passed: all gates green');
    expect(result.stdout).toContain('full suite');
    expect(result.stderr).toBe('');
    expect(result.npm.split('\n').filter(Boolean).sort()).toEqual(
      [
        'bun run format:check',
        'bun run knip:gate',
        'bun run test:ci',
        'bun run typecheck',
        'bun scripts/check-group-fs.ts',
        'bash ui/android/check-native-version.sh',
        'run build',
        'run typecheck',
      ].sort(),
    );
  });

  test('prints only the failed phase output and preserves its exit code', () => {
    const result = runVerify('bun run typecheck');

    expect(result.exitCode).toBe(23);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Verification failed: Backend typecheck');
    expect(result.stderr).toContain('command stdout: bun run typecheck');
    expect(result.stderr).toContain('command stderr: bun run typecheck');
    expect(result.stderr).not.toContain('format:check');
    expect(result.stderr).not.toContain('test:ci');
  });

  test('runs the independent static gates concurrently', async () => {
    const holdFile = path.join(fakeBinDir, 'static-gates-overlap');
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      CARAPA_VERIFY_LOCK_HELD: '1',
      VERIFY_FAKE_HOLD_FILE: holdFile,
      VERIFY_FAKE_OVERLAP_FILE: `${holdFile}.overlap`,
    };
    const verification = Bun.spawn(['/bin/bash', 'scripts/verify.sh'], {
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    trackHold(holdFile, verification);

    await waitForFile(`${holdFile}.started`);
    await waitForFile(`${holdFile}.overlap`);
    await releaseHold(holdFile);
    expect(await verification.exited).toBe(0);
  });

  test('keeps static gate fan-out bounded at three processes', async () => {
    const markerDir = await mkdtemp(
      path.join(os.tmpdir(), 'carapa-verify-gates-'),
    );
    const releaseFile = path.join(markerDir, 'release');
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      CARAPA_VERIFY_LOCK_HELD: '1',
      VERIFY_FAKE_GATE_MARKER_DIR: markerDir,
      VERIFY_FAKE_GATE_RELEASE: releaseFile,
    };
    const verification = Bun.spawn(['/bin/bash', 'scripts/verify.sh'], {
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    trackGate(() => {
      releaseGates(markerDir, releaseFile);
      rmSync(markerDir, { recursive: true, force: true });
    }, verification);

    expect(await waitForMarkerCount(markerDir, 3)).toBe(3);
    expect(
      (await readdir(markerDir)).filter((entry) => !entry.startsWith('.')),
    ).toHaveLength(3);
    releaseGates(markerDir, releaseFile);
    expect(await verification.exited).toBe(0);
    await rm(markerDir, { recursive: true, force: true });
  });

  test('terminates and reaps a gate descendant when the verifier is interrupted', async () => {
    const descendantFile = path.join(fakeBinDir, 'gate-descendant.pid');
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      CARAPA_VERIFY_LOCK_HELD: '1',
      VERIFY_FAKE_DESCENDANT_FILE: descendantFile,
    };
    const verification = Bun.spawn(['/bin/bash', 'scripts/verify.sh'], {
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const descendantPid = await waitForFileState(fakeBinDir, () => {
      if (!existsSync(descendantFile)) return undefined;
      const pid = Number(readFileSync(descendantFile, 'utf8'));
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    });
    verification.kill('SIGTERM');
    await verification.exited;
    // The verifier promises to reap its descendants before it exits.
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  test('reports all confirmed concurrent failures and waits for their siblings', () => {
    const result = runVerify('bun run format:check|bun run typecheck');
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toBe(
      [
        'Verification failed: Format check',
        'command stdout: bun run format:check',
        'command stderr: bun run format:check',
        'Verification failed: Backend typecheck',
        'command stdout: bun run typecheck',
        'command stderr: bun run typecheck',
        '',
      ].join('\n'),
    );
  });

  test('serializes concurrent verification in the same worktree', async () => {
    if (process.env.CARAPA_VERIFY_LOCK_HELD === '1') return;

    const holdFile = path.join(fakeBinDir, 'verification-lock');
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      VERIFY_FAKE_HOLD_FILE: holdFile,
      VERIFY_FAKE_LOCK_CONTENTION_FILE: `${holdFile}.contended`,
    };
    env.CARAPA_VERIFY_LOCK_HELD = '0';
    const first = Bun.spawn(['/bin/bash', 'scripts/verify.sh'], {
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    trackHold(holdFile, first);
    await waitForFile(`${holdFile}.started`);

    const second = Bun.spawn(['/bin/bash', 'scripts/verify.sh'], {
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    trackHold(holdFile, second);
    await waitForFile(`${holdFile}.contended`);
    expect(second.exitCode).toBeNull();

    await releaseHold(holdFile);
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
  });

  test('runs only the colocated UI test for a localized UI diff', () => {
    const result = runVerify('', {
      changedDiff: 'M\tui/src/components/settings/stage-editor.tsx',
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });

    expect(result.exitCode).toBe(0);
    expect(result.credentialLeaked).toBe(false);
    const npmInvocations = result.npm.split('\n');
    expect(npmInvocations).toContain(
      'exec vitest -- run --reporter=json --passWithNoTests src/components/settings/stage-editor.vitest.tsx',
    );
    expect(npmInvocations).not.toContain('test');
    expect(npmInvocations).toContain('run typecheck');
    expect(npmInvocations).toContain('run build');
    expect(npmInvocations).not.toContain('bun run format:check');
    expect(npmInvocations).not.toContain('bun run typecheck');
    expect(npmInvocations).toContain(
      'bun x prettier --write -- ui/src/components/settings/stage-editor.tsx',
    );
    expect(npmInvocations).not.toContain(
      'bash ui/android/check-native-version.sh',
    );
  });

  test('selects prefix-named sibling vitest files for a localized UI diff', () => {
    const result = runVerify('', {
      changedDiff: 'M\tui/src/components/board/task-detail-dialog.tsx',
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm.split('\n')).toContain(
      'exec vitest -- run --reporter=json --passWithNoTests ' +
        [
          'archive',
          'dependencies',
          'header-sync',
          'large-message',
          'priority',
          'scroll',
          'send-target',
          'tabs',
        ]
          .map(
            (name) =>
              `src/components/board/task-detail-dialog-${name}.vitest.tsx`,
          )
          .join(' '),
    );
  });

  test('runs the exact-stem sibling browser test of a changed UI source file', () => {
    const result = runVerify('', {
      changedDiff: 'M\tui/src/components/chat/chat-message-bubble.tsx',
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const browserInvocations = result.npm
      .split('\n')
      .filter((line) => line.includes('test-browser.sh'));
    expect(browserInvocations).toEqual([
      'bash scripts/test-browser.sh ui/src/components/chat/chat-message-bubble.browser.test.ts',
    ]);
    expect(result.stdout).toContain('Browser tests executed: 1');
  });

  test('runs the prefix-named sibling browser test of a changed UI source file', () => {
    const result = runVerify('', {
      changedDiff: 'M\tui/src/components/chat/chat-page.tsx',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm.split('\n')).toContain(
      'bash scripts/test-browser.sh ui/src/components/chat/chat-page-handoff.browser.test.ts',
    );
    expect(result.stdout).toContain('Browser tests executed: 1');
  });

  test('runs no browser phase for a UI source without a sibling browser test', () => {
    const result = runVerify('', {
      changedDiff: 'M\tui/src/lib/ab.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm).not.toContain('test-browser.sh');
    expect(result.stdout).not.toContain('Browser tests executed');
    expect(result.stdout).toContain('browser tests off');
  });

  test('maps no browser tests for deleted sources or missing siblings', () => {
    const deleted = runVerify('', {
      changedDiff: 'D\tui/src/components/chat/chat-message-bubble.tsx',
    });
    expect(deleted.exitCode, deleted.stderr).toBe(0);
    expect(deleted.npm).not.toContain('test-browser.sh');
    expect(deleted.stdout).not.toContain('Browser tests executed');

    const missingSibling = runVerify('', {
      changedDiff: 'M\tui/src/components/chat/renamed-away-source.tsx',
    });
    expect(missingSibling.exitCode, missingSibling.stderr).toBe(0);
    expect(missingSibling.npm).not.toContain('test-browser.sh');
    expect(missingSibling.stdout).toContain('browser tests off');
  });

  test('deduplicates a changed browser test against its source sibling mapping', () => {
    const result = runVerify('', {
      changedDiff:
        'M\tui/src/components/chat/chat-message-bubble.tsx\n' +
        'M\tui/src/components/chat/chat-message-bubble.browser.test.ts',
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const browserInvocations = result.npm
      .split('\n')
      .filter((line) => line.includes('test-browser.sh'));
    expect(browserInvocations).toEqual([
      'bash scripts/test-browser.sh ui/src/components/chat/chat-message-bubble.browser.test.ts',
    ]);
  });

  test('uses an injected task base for clean committed UI changes', () => {
    const base = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = runVerify('', {
      changedDiff:
        'M\tui/src/components/board/card.tsx\nM\tui/src/components/board/column.tsx',
      npmOutput: '{"numTotalTestSuites":2,"numTotalTests":2}',
      verifyBaseSha: base,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.git).toContain(`rev-parse --verify ${base}^{commit}`);
    expect(result.git).toContain(`merge-base --is-ancestor ${base} HEAD`);
    expect(result.git).toContain(`diff --name-status ${base} --`);
    expect(result.npm).not.toContain('exec vitest');
    expect(result.npm).not.toContain('bun run format:check');
    expect(result.npm).toContain(
      'bun x prettier --write -- ui/src/components/board/card.tsx ui/src/components/board/column.tsx',
    );
    expect(result.npm).not.toContain('bun test --changed=');
    expect(result.stdout).toContain(`changed vs ${base}`);
  });

  test('advances a stale injected base after the worktree merges the default branch', () => {
    const injectedBase = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const synchronizedBase = 'cccccccccccccccccccccccccccccccccccccccc';
    const result = runVerify('', {
      changedDiff: 'M\tsrc/lib/task.test.ts',
      verifyBaseSha: injectedBase,
      advancedWorktreeBase: true,
      timing: true,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.git).toContain(
      `merge-base --is-ancestor ${injectedBase} ${synchronizedBase}`,
    );
    expect(result.git).toContain(`diff --name-status ${synchronizedBase} --`);
    expect(result.stdout).toContain(`changed vs ${synchronizedBase}`);
    expect(result.stdout).toContain(`source=injected+worktree:develop`);
  });

  test('uses the worktree default-branch merge-base for committed and dirty changes', () => {
    const mergeBase = 'cccccccccccccccccccccccccccccccccccccccc';
    const result = runVerify('', {
      changedDiff: 'M\tsrc/lib/committed.test.ts\nM\tsrc/lib/dirty.test.ts',
      untracked: 'src/lib/untracked.test.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.git).toContain(
      'rev-parse --verify refs/heads/develop^{commit}',
    );
    expect(result.git).toContain(
      `merge-base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HEAD`,
    );
    expect(result.git).toContain(`diff --name-status ${mergeBase} --`);
    expect(result.stdout).toContain(`changed vs ${mergeBase}`);
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/committed.test.ts src/lib/dirty.test.ts src/lib/untracked.test.ts',
    );
  });

  test('skips application commands when inspection proves the task range is empty', () => {
    const result = runVerify('', { changedDiff: '', timing: true });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm).toBe('');
    expect(result.stdout).toContain('Verification passed: no changed files');
    expect(result.stdout).toContain('Tests executed: 0');
    expect(result.stdout).toContain('Verification timings (seconds):');
  });

  test('only formats documentation and a newly packaged instruction-only skill', () => {
    const skill = '.agent/skills/setup';
    const result = runVerify('', {
      changedDiff: [
        'M\tREADME.md',
        'M\tAGENTS.md',
        'M\t.agent/rules/02-implementation-workflow.md',
        'R100\tdocs/old.md\tdocs/new.md',
        'D\tdocs/obsolete.md',
      ].join('\n'),
      untracked: [
        `${skill}/SKILL.md`,
        `${skill}/references/evidence.md`,
        `${skill}/assets/story.md`,
        `${skill}/agents/openai.yaml`,
      ].join('\n'),
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('documentation/instructions only');
    expect(result.stdout).toContain('Tests executed: 0');
    const formattedFiles = [
      'README.md',
      'AGENTS.md',
      '.agent/rules/02-implementation-workflow.md',
      'docs/new.md',
      `${skill}/SKILL.md`,
      `${skill}/references/evidence.md`,
      `${skill}/assets/story.md`,
      `${skill}/agents/openai.yaml`,
    ].sort();
    expect(result.npm.trim()).toBe(
      `bun x prettier --write -- ${formattedFiles.join(' ')}`,
    );
  });

  test('preserves formatter failures in documentation-only verification', () => {
    const result = runVerify('bun x prettier --write -- README.md', {
      changedDiff: 'M\tREADME.md',
    });

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain(
      'Verification failed: Format changed files',
    );
    expect(result.stdout).not.toContain('Verification passed');
    expect(result.npm.trim()).toBe('bun x prettier --write -- README.md');
  });

  test('documentation does not broaden or suppress selected backend checks', () => {
    const result = runVerify('', {
      changedDiff: 'M\tREADME.md\nM\tsrc/lib/task.test.ts',
      untracked: '.agent/skills/example/SKILL.md',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm.split('\n')).toContain('bun run typecheck');
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/task.test.ts',
    );
    expect(result.npm).not.toContain('bun run test:ci:backend');
    expect(result.npm.split('\n')).not.toContain('run typecheck');
    expect(result.npm.split('\n')).not.toContain('run build');
    expect(result.npm).not.toContain('check-native-version.sh');
  });

  test('treats the root .env.example as documentation but not other unknown paths', () => {
    const only = runVerify('', { changedDiff: 'M\t.env.example' });
    expect(only.exitCode, only.stderr).toBe(0);
    expect(only.stdout).toContain('documentation/instructions only');
    expect(only.stdout).toContain('Tests executed: 0');
    expect(only.npm).toBe('');

    const withSource = runVerify('', {
      changedDiff: 'M\t.env.example\nM\tsrc/lib/task.ts',
      untracked: 'src/lib/task.test.ts',
    });
    expect(withSource.exitCode, withSource.stderr).toBe(0);
    expect(withSource.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/task.test.ts',
    );
    expect(withSource.npm).not.toContain('bun run test:ci:backend');
    expect(withSource.npm).not.toContain('bun run test:ci:contracts');
    expect(withSource.npm.split('\n')).not.toContain('run typecheck');
    expect(withSource.npm.split('\n')).not.toContain('run build');

    const unknown = runVerify('', { changedDiff: 'M\tfoo.cfg' });
    expect(unknown.exitCode, unknown.stderr).toBe(0);
    expect(unknown.npm.split('\n')).toContain('bun run test:ci:backend');
    expect(unknown.npm.split('\n')).toContain('bun run test:ci:contracts');

    const nested = runVerify('', { changedDiff: 'M\tui/.env.example' });
    expect(nested.exitCode, nested.stderr).toBe(0);
    expect(nested.stdout).not.toContain('documentation/instructions only');

    const allowlistWithSource = runVerify('', {
      changedDiff: 'M\tscripts/group-fs-allowlist.json\nM\tsrc/lib/task.ts',
      untracked: 'src/lib/task.test.ts',
    });
    expect(allowlistWithSource.exitCode, allowlistWithSource.stderr).toBe(0);
    expect(allowlistWithSource.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/task.test.ts',
    );
    expect(allowlistWithSource.npm).not.toContain('bun run test:ci:backend');

    const allowlistOnly = runVerify('', {
      changedDiff: 'M\tscripts/group-fs-allowlist.json',
    });
    expect(allowlistOnly.exitCode, allowlistOnly.stderr).toBe(0);
    expect(allowlistOnly.npm).not.toContain('bun run test:ci:backend');
    expect(allowlistOnly.npm.split('\n')).not.toContain('run typecheck');
    expect(allowlistOnly.npm.split('\n')).not.toContain('run build');
  });

  test('short-circuits when TypeScript edits are semantic no-ops alongside documentation', () => {
    const mergeBase = 'cccccccccccccccccccccccccccccccccccccccc';
    const result = runVerify('', {
      changedDiff: 'M\tsrc/lib/example.ts\nM\tREADME.md',
      untracked: 'docs/explanation.md',
      semanticNoop: true,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Verification passed: semantic no-op (formatting/comments only)',
    );
    expect(result.npm.split('\n')).toContain(
      `bun scripts/verify-semantic-noop.ts ${mergeBase} src/lib/example.ts`,
    );
    expect(result.npm).toContain(
      'bun x prettier --write -- README.md docs/explanation.md src/lib/example.ts',
    );
    expect(result.npm).not.toContain('bun run typecheck');
    expect(result.npm).not.toContain('bun test');
  });

  test('rejects invalid injected bases and runs complete domain tests', () => {
    for (const options of [
      { invalidBase: true, changedDiff: '' },
      { nonAncestorBase: true, changedDiff: 'M\tREADME.md' },
    ]) {
      const result = runVerify('', {
        verifyBaseSha: 'untrusted; touch should-not-run',
        ...options,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        'CARAPA_VERIFY_BASE_SHA is not a valid ancestor of HEAD',
      );
      expect(result.npm.split('\n')).toContain('bun run test:ci:backend');
      expect(result.npm.split('\n')).toContain('bun run test --maxWorkers=4');
      expect(result.npm).not.toContain('related');
      expect(result.git).toContain(
        'rev-parse --verify untrusted; touch should-not-run^{commit}',
      );
    }
  });

  test('runs static checks without tests for an unmapped backend production diff', () => {
    const result = runVerify('', { changedDiff: 'M\tsrc/lib/example.ts' });

    expect(result.exitCode).toBe(0);
    const npmInvocations = result.npm.split('\n');
    expect(result.stdout).toContain('Backend tests: 0 files selected');
    expect(result.npm).not.toContain('bun test');
    expect(npmInvocations).toContain(
      'bun x prettier --write -- src/lib/example.ts',
    );
    expect(npmInvocations).toContain('bun run typecheck');
    expect(npmInvocations).not.toContain('test');
    expect(npmInvocations).not.toContain('related');
    expect(npmInvocations).not.toContain('run typecheck');
    expect(npmInvocations).not.toContain('run build');
    expect(npmInvocations).not.toContain(
      'bash ui/android/check-native-version.sh',
    );
  });

  test('selects direct test importers of unmapped files and leaves hubs to CI', () => {
    const context = runVerify('', {
      changedDiff: 'M\tsrc/modules/memory/execution-context.ts',
    });
    expect(context.exitCode, context.stderr).toBe(0);
    expect(context.stdout).toMatch(
      /Backend tests: \d+ files selected \(direct importers; \d+ importer-selected\)/,
    );
    expect(context.npm).toContain('src/modules/tools/index.test.ts');

    const tasks = runVerify('', { changedDiff: 'M\tsrc/routes/tasks.ts' });
    expect(tasks.exitCode, tasks.stderr).toBe(0);
    expect(tasks.npm).toContain('src/routes-tasks.test.ts');

    const hub = runVerify('', { changedDiff: 'M\tsrc/db.ts' });
    expect(hub.exitCode, hub.stderr).toBe(0);
    expect(hub.stdout).toContain(
      'Backend tests: 0 files selected (no owned tests; exhaustive coverage remains in CI; 1 hub file(s) left to CI)',
    );
    expect(hub.npm).not.toContain('bun test');
  });

  test('selects only the explicit owned workload for the central task pipeline', () => {
    const result = runVerify('', {
      changedDiff:
        'M\tsrc/modules/kanban/task/pipeline.ts\nM\tsrc/modules/kanban/task-pipeline.test.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Backend tests: 2 files selected (explicit ownership)',
    );
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/modules/kanban/task-pipeline.test.ts src/modules/kanban/testing.test.ts',
    );
    expect(result.npm).not.toContain('--changed=');
    expect(result.npm).not.toContain('bun run test:ci:backend');
  });

  test('selects a changed backend test directly without transitive expansion', () => {
    const result = runVerify('', {
      changedDiff: 'M\tsrc/lib/rate-limit.test.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Backend tests: 1 files selected (changed test files)',
    );
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/rate-limit.test.ts',
    );
  });

  test('selects a colocated test for its production file', () => {
    const result = runVerify('', {
      changedDiff: 'M\tsrc/lib/rate-limit.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Backend tests: 1 files selected (colocated ownership)',
    );
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/rate-limit.test.ts',
    );
  });

  test('isolates a selected configured backend file without expanding the workload', () => {
    const result = runVerify('', {
      changedDiff:
        'M\tsrc/modules/kanban/archive-task.test.ts\nM\tsrc/lib/rate-limit.test.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Backend tests: 2 files selected');
    expect(result.npm.split('\n')).toEqual(
      expect.arrayContaining([
        'bash scripts/test-bun-selected.sh src/lib/rate-limit.test.ts src/modules/kanban/archive-task.test.ts',
        'bun test --no-env-file --timeout 30000 --only-failures src/modules/kanban/archive-task.test.ts',
        'bun test --no-env-file --timeout 30000 --only-failures src/lib/rate-limit.test.ts',
      ]),
    );
    expect(result.npm).not.toContain('bun run test:ci:backend');
  });

  test('keeps mixed backend, UI, and browser changes independently scoped', () => {
    const result = runVerify('', {
      changedDiff: [
        'M\tscripts/ui-sandbox/direct-llm-simulator.test.ts',
        'M\tscripts/ui-sandbox/direct-llm-simulator.ts',
        'M\tscripts/ui-sandbox/shared.test.ts',
        'M\tsrc/lib/rate-limit.ts',
        'M\tui/src/components/settings/stage-editor.tsx',
        'M\tui/src/components/chat/direct-llm-sandbox.browser.test.ts',
      ].join('\n'),
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Backend tests: 1 files selected (colocated ownership)',
    );
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/rate-limit.test.ts',
    );
    expect(result.npm.split('\n')).toContain(
      'exec vitest -- run --reporter=json --passWithNoTests src/components/settings/stage-editor.vitest.tsx',
    );
    expect(result.npm).not.toContain('bun run test:ci:backend');
    expect(result.npm.split('\n')).not.toContain('test');
  });

  test('does not run component tests for a browser-only UI diff', () => {
    const result = runVerify('', {
      changedDiff:
        'M\tui/src/components/chat/direct-llm-sandbox.browser.test.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm).not.toContain('bun test');
    expect(result.npm.split('\n')).not.toContain('test');
    expect(result.npm).not.toContain('related');
    expect(result.npm.split('\n')).toContain(
      'bash scripts/test-browser.sh ui/src/components/chat/direct-llm-sandbox.browser.test.ts',
    );
    expect(result.stdout).toContain('Tests executed: 1');
    expect(result.npm.split('\n')).not.toContain('run typecheck');
    expect(result.npm.split('\n')).not.toContain('run build');
  });

  test('keeps mapped deletions targeted and unknown renames conservative', () => {
    const mappedDeletion = runVerify('', {
      changedDiff: 'D\tsrc/modules/kanban/task/pipeline.ts',
    });
    expect(mappedDeletion.exitCode, mappedDeletion.stderr).toBe(0);
    expect(mappedDeletion.stdout).toContain(
      'Backend tests: 2 files selected (explicit ownership)',
    );
    expect(mappedDeletion.npm).not.toContain('bun run test:ci:backend');

    const unknownRename = runVerify('', {
      changedDiff: 'R100\tsrc/lib/old.ts\tsrc/lib/new.ts',
    });
    expect(unknownRename.exitCode, unknownRename.stderr).toBe(0);
    expect(unknownRename.stdout).toContain(
      'Backend tests: full domain selected (unmapped destructive production change)',
    );
    expect(unknownRename.npm.split('\n')).toContain('bun run test:ci:backend');
    expect(unknownRename.npm.split('\n')).not.toContain('test');
  });

  test('passes selected test paths as shell-safe arguments', () => {
    const result = runVerify('', {
      changedDiff: 'M\tsrc/lib/name;touch-owned.test.ts',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm.split('\n')).toContain(
      'bun test --no-env-file --timeout 30000 --only-failures src/lib/name;touch-owned.test.ts',
    );
  });

  test('runs the Android guard only for localized UI inputs in its dependency boundary', () => {
    const webUi = runVerify('', {
      changedDiff: 'M\tui/src/components/board/card.tsx',
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });
    const nativeUi = runVerify('', {
      changedDiff: 'M\tui/android/app/src/main/AndroidManifest.xml',
      npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
    });

    expect(webUi.npm).not.toContain('bash ui/android/check-native-version.sh');
    expect(nativeUi.exitCode, nativeUi.stderr).toBe(0);
    expect(nativeUi.npm).toContain('bash ui/android/check-native-version.sh');
    expect(nativeUi.npm).not.toContain('bun run format:check');
  });

  test(
    'runs both domains conservatively for shared and ambiguous inputs',
    {
      timeout: 30000,
    },
    () => {
      for (const changedDiff of [
        'M\tsrc/types.ts',
        'M\tui/src/lib/api.ts',
        'M\tbun.lock',
        'M\tscripts/test-ci.sh',
        'M\tunknown.config',
        'M\tprompts/default.md',
        'M\t.agent/skills/example/scripts/check.sh',
        'R100\tdocs/guide.md\tscripts/check.sh',
        'U\tREADME.md',
      ]) {
        const result = runVerify('', {
          changedDiff,
          npmOutput: '{"numTotalTestSuites":1,"numTotalTests":1}',
        });

        expect(result.exitCode).toBe(0);
        expect(result.npm.split('\n')).toContain('bun run test:ci:backend');
        expect(result.npm.split('\n')).toContain('bun run test --maxWorkers=4');
        expect(result.npm).not.toContain('related');
      }
    },
  );

  test('falls back to broad verification for deleted UI and backend files', () => {
    const deletedUi = runVerify('', {
      changedDiff: 'D\tui/src/components/board/card.tsx',
    });
    expect(deletedUi.exitCode, deletedUi.stderr).toBe(0);
    expect(deletedUi.npm.split('\n')).toContain('bun run test --maxWorkers=4');
    expect(deletedUi.npm).not.toContain('bun run test:ci:backend');
    expect(deletedUi.npm).not.toContain('bun run format:check');
    expect(deletedUi.npm).toContain('run build');

    const deletedBackend = runVerify('', {
      changedDiff: 'D\tsrc/lib/example.ts',
    });
    expect(deletedBackend.exitCode).toBe(0);
    const deletedBackendInvocations = deletedBackend.npm.split('\n');
    expect(deletedBackendInvocations).toContain('bun run test:ci:backend');
    expect(deletedBackendInvocations).not.toContain('test');
    expect(deletedBackendInvocations).not.toContain('run build');
  });

  test('falls back to broad verification when changed-file inspection fails', () => {
    const result = runVerify('', { changedDiff: '', gitFailure: true });

    expect(result.exitCode).toBe(0);
    expect(result.npm.split('\n')).toEqual(
      expect.arrayContaining([
        'bun run format:check',
        'bun run typecheck',
        'run typecheck',
        'bash ui/android/check-native-version.sh',
        'bun run test:ci:backend',
        'bun run test:ci:contracts',
        'bun run test --maxWorkers=4',
        'run build',
      ]),
    );
  });

  test('propagates a failing selected backend test run', () => {
    const result = runVerify(
      'bun test --no-env-file --timeout 30000 --only-failures src/modules/kanban/task-pipeline.test.ts src/modules/kanban/testing.test.ts',
      { changedDiff: 'M\tsrc/modules/kanban/task/pipeline.ts' },
    );

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain('Verification failed: Backend tests');
    expect(result.npm.split('\n')).not.toContain('test');
  });

  test('new executable skill helpers retain broad verification alongside instructions', () => {
    const result = runVerify('', {
      untracked:
        '.agent/skills/example/SKILL.md\n.agent/skills/example/scripts/check.py',
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npm.split('\n')).toContain('bun run test:ci:backend');
    expect(result.npm.split('\n')).toContain('bun run test --maxWorkers=4');
    expect(result.npm.split('\n')).toContain('run build');
  });

  test('falls back when selected Vitest output is empty or unrecognized', () => {
    for (const npmOutput of ['', '{"unexpected":true}']) {
      const result = runVerify('', {
        changedDiff: 'M\tui/src/components/settings/stage-editor.tsx',
        npmOutput,
      });

      const npmInvocations = result.npm.split('\n');
      expect(result.exitCode).toBe(0);
      expect(npmInvocations).toContain('bun run test --maxWorkers=4');
      expect(
        npmInvocations.some((invocation) =>
          invocation.startsWith('exec vitest'),
        ),
      ).toBe(true);
    }
  });

  test('falls back to the full UI suite for mixed repository and UI diffs', () => {
    const result = runVerify('', {
      changedDiff: 'M\tscripts/verify.sh\nM\tui/src/components/board/card.tsx',
    });

    const npmInvocations = result.npm.split('\n');
    expect(result.exitCode).toBe(0);
    expect(npmInvocations).toContain('bun run test --maxWorkers=4');
    expect(
      npmInvocations.some((invocation) => invocation.startsWith('exec vitest')),
    ).toBe(false);
  });

  test('propagates a failing selected UI test run', () => {
    const result = runVerify(
      'npm exec vitest -- run --reporter=json --passWithNoTests src/components/settings/stage-editor.vitest.tsx',
      {
        changedDiff: 'M\tui/src/components/settings/stage-editor.tsx',
      },
    );

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain('Verification failed: UI component tests');
    expect(result.npm.split('\n')).not.toContain('test');
  });
});

describe('reuse of an earlier verify:changed pass', () => {
  const repos: string[] = [];
  let commandDir: string;

  beforeAll(() => {
    // Same fake bun/npm/bash/flock as above, but with the real git so the tree
    // key, index handling and stamp location are exercised for real.
    commandDir = mkdtempSync(
      path.join(os.tmpdir(), 'carapa-verify-reuse-bin-'),
    );
    for (const name of ['bun', 'bash', 'npm', 'flock']) {
      copyFileSync(path.join(fakeBinDir, name), path.join(commandDir, name));
    }
  });

  afterAll(() => {
    rmSync(commandDir, { recursive: true, force: true });
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  const realEnv = () => ({
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });

  function git(repo: string, ...args: string[]) {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: repo,
      env: realEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  }

  function createRepo() {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'carapa-verify-reuse-'));
    repos.push(repo);
    cpSync(path.join(process.cwd(), 'scripts'), path.join(repo, 'scripts'), {
      recursive: true,
    });
    mkdirSync(path.join(repo, 'src/lib'), { recursive: true });
    writeFileSync(
      path.join(repo, 'src/lib/example.ts'),
      'export const a = 1;\n',
    );
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    appendFileSync(
      path.join(repo, 'src/lib/example.ts'),
      'export const b = 2;\n',
    );
    return { repo, base };
  }

  function verifyChanged(
    repo: string,
    base: string,
    env: Record<string, string> = {},
  ) {
    const npmLog = path.join(repo, '.git', 'fake-commands.log');
    writeFileSync(npmLog, '');
    const result = Bun.spawnSync(['/bin/bash', 'scripts/verify-changed.sh'], {
      cwd: repo,
      env: {
        ...realEnv(),
        PATH: `${commandDir}:${process.env.PATH ?? ''}`,
        CARAPA_VERIFY_LOCK_HELD: '1',
        CARAPA_VERIFY_BASE_SHA: base,
        CARAPA_VERIFY_REUSE: undefined,
        DEFAULT_BRANCH: 'develop',
        VERIFY_FAKE_NPM_LOG: npmLog,
        VERIFY_FAKE_SEMANTIC_NOOP: '0',
        VERIFY_REAL_BUN: process.execPath,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      commands: readFileSync(npmLog, 'utf8'),
    };
  }

  const stampFile = (repo: string) =>
    path.join(repo, '.git', 'carapa-verify-pass');
  const expectNormalRun = (result: ReturnType<typeof verifyChanged>) => {
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.commands).toContain('bun run typecheck');
    expect(result.stdout).toContain('Verification passed: all gates green');
    expect(result.stdout).not.toContain('reused');
  };

  test('second run on an unchanged worktree executes no phase and leaves git state alone', () => {
    const { repo, base } = createRepo();
    expectNormalRun(verifyChanged(repo, base));
    expect(readFileSync(stampFile(repo), 'utf8')).toContain('tests_executed=');

    const indexBefore = readFileSync(path.join(repo, '.git', 'index'));
    const statusBefore = git(repo, 'status', '--porcelain');
    const second = verifyChanged(repo, base);

    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.commands).toBe('');
    expect(second.stdout).toMatch(
      /Verification passed: reused earlier pass \(tree [0-9a-f]{12}, \S+\)\nTests executed: 0\n {2}reused: changed vs \S+ -- backend tests on, ui tests off, browser tests off, \d+ tests at \S+\n/,
    );
    expect(
      readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore),
    ).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(statusBefore).not.toContain('carapa-verify-pass');
  });

  test('reuses only for the identical tree, regardless of commits or ignored files', () => {
    const { repo, base } = createRepo();
    expectNormalRun(verifyChanged(repo, base));

    writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');
    expect(verifyChanged(repo, base).commands).toBe('');

    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'task');
    expect(verifyChanged(repo, base).commands).toBe('');

    appendFileSync(
      path.join(repo, 'src/lib/example.ts'),
      'export const c = 3;\n',
    );
    expectNormalRun(verifyChanged(repo, base));
    expect(verifyChanged(repo, base).commands).toBe('');

    writeFileSync(path.join(repo, 'src/lib/new.ts'), 'export const d = 4;\n');
    expectNormalRun(verifyChanged(repo, base));
  });

  test('runs normally for another base, changed verifier script hash, or CARAPA_VERIFY_REUSE=0', () => {
    const { repo, base } = createRepo();
    writeFileSync(path.join(repo, 'src/lib/other.ts'), 'x\n');
    git(repo, 'add', 'src/lib/other.ts');
    git(repo, 'commit', '-q', '-m', 'notes');
    const otherBase = git(repo, 'rev-parse', 'HEAD');

    expectNormalRun(verifyChanged(repo, base));
    expect(verifyChanged(repo, base).commands).toBe('');
    expectNormalRun(verifyChanged(repo, otherBase));
    expectNormalRun(
      verifyChanged(repo, otherBase, { CARAPA_VERIFY_REUSE: '0' }),
    );

    const stamp = readFileSync(stampFile(repo), 'utf8');
    writeFileSync(
      stampFile(repo),
      stamp.replace(/^verify_sh=.*$/m, 'verify_sh=stale'),
    );
    expectNormalRun(verifyChanged(repo, otherBase));
  });

  test('a failed run leaves no stamp and the next run after the fix is normal', () => {
    const { repo, base } = createRepo();
    expectNormalRun(verifyChanged(repo, base));
    expect(existsSync(stampFile(repo))).toBe(true);

    const failed = verifyChanged(repo, base, {
      CARAPA_VERIFY_REUSE: '0',
      VERIFY_FAKE_FAILURE: 'bun run typecheck',
    });
    expect(failed.exitCode).not.toBe(0);
    expect(existsSync(stampFile(repo))).toBe(false);

    expectNormalRun(verifyChanged(repo, base));
  });
});
