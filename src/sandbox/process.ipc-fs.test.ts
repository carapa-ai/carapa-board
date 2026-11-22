/**
 * Run-dir marker writes and small control-file reads in src/sandbox/process.ts
 * go through the pinned-descriptor IPC adapter: an agent-planted link or FIFO
 * must neither redirect a board write nor block the event loop.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { initDatabase } from '../db.js';

const sandboxExec = mock(async (..._args: unknown[]) => ({
  stdout: '{"status":"killed"}',
  isError: false,
}));
mock.module('../lib/mcp-client.js', () => ({
  getSandboxClient: () => ({ sandboxExec }),
  SandboxClient: class {},
}));

const {
  cleanupRunDir,
  killRun,
  readPersistentSessionDiagnostic,
  removeRunDirPreservingControlResponses,
  waitForRun,
} = await import('./process.js');
const { carapaRunV1Paths, ensureCarapaRunV1Terminal } =
  await import('../modules/transcripts/carapa-run-v1.js');

const suffix = `${process.pid}-${Date.now()}`;
const stack = 'carapa-bot';
const instance = `ipcfs-${suffix}`;
const stackDir = path.join(DATA_DIR, 'ipc', `${stack}-${instance}`);
const outside = path.join(DATA_DIR, `process-ipcfs-outside-${suffix}`);
const outsideFile = path.join(outside, 'file');
let runId = '';
let runDir = '';
let n = 0;
let hasFifo = false;

const run = () =>
  ({
    id: runId,
    group_folder: 'ipcfs',
    sandbox_stack: stack,
    sandbox_service: 'agent',
    sandbox_instance: instance,
  }) as never;
const execCommands = () => sandboxExec.mock.calls.map((c) => String(c[2]));
const isRegular = (p: string) => fs.lstatSync(p).isFile();

beforeAll(async () => {
  await initDatabase(':memory:');
  fs.mkdirSync(outside, { recursive: true });
  try {
    execFileSync('mkfifo', [path.join(outside, 'probe')]);
    hasFifo = true;
  } catch {
    /* mkfifo unavailable */
  }
});

beforeEach(() => {
  runId = `run-${suffix}-${n++}`;
  runDir = path.join(stackDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(outsideFile, 'outside-secret');
  sandboxExec.mockClear();
});

afterEach(() => {
  fs.rmSync(stackDir, { recursive: true, force: true });
  fs.rmSync(outsideFile, { force: true });
});

afterAll(() => {
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('process.ts IPC run-dir markers', () => {
  test('killRun replaces planted leaf links instead of writing through them', async () => {
    fs.symlinkSync(outsideFile, path.join(runDir, 'clean_stop'));
    await killRun(run(), { cleanStop: true });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
    expect(isRegular(path.join(runDir, 'clean_stop'))).toBe(true);

    fs.symlinkSync(outsideFile, path.join(runDir, 'exit_code'));
    await killRun(run());
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
    expect(fs.readFileSync(path.join(runDir, 'exit_code'), 'utf8')).toBe('137');
    expect(isRegular(path.join(runDir, 'exit_code'))).toBe(true);
  });

  test('killRun does not create the target of a dangling exit_code link', async () => {
    const target = path.join(outside, 'created');
    fs.symlinkSync(target, path.join(runDir, 'exit_code'));
    await killRun(run());
    expect(fs.existsSync(target)).toBe(false);
  });

  test('retained control responses: .cleanup-complete link is replaced', async () => {
    fs.mkdirSync(path.join(runDir, 'control-responses'));
    fs.writeFileSync(path.join(runDir, 'control-responses', 'a.json'), '{}');
    fs.symlinkSync(outsideFile, path.join(runDir, '.cleanup-complete'));
    await cleanupRunDir(
      runDir,
      undefined, // transcriptTarget
      undefined, // group_folder
      undefined, // transcriptOffset
      undefined, // workspaceRoot
      true, // skipTranscriptMemory
      undefined, // sandbox_stack
      undefined, // sandbox_service
      undefined, // agent_name
      undefined, // sandbox_instance
      undefined, // sandbox_workspace_path
      true, // deleteRunDir
    );
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
    expect(isRegular(path.join(runDir, '.cleanup-complete'))).toBe(true);

    fs.rmSync(path.join(runDir, '.cleanup-complete'));
    fs.symlinkSync(outsideFile, path.join(runDir, '.cleanup-complete'));
    expect(await removeRunDirPreservingControlResponses(runDir)).toBe(false);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
    expect(isRegular(path.join(runDir, '.cleanup-complete'))).toBe(true);
  });

  test('a run dir swapped for a link gets no writes but is still stopped', async () => {
    const target = path.join(outside, 'target-dir');
    fs.mkdirSync(target);
    fs.rmSync(runDir, { recursive: true });
    fs.symlinkSync(target, runDir);
    await killRun(run(), { cleanStop: true });
    await killRun(run());
    expect(fs.readdirSync(target)).toEqual([]);
    expect(execCommands()).toHaveLength(2);
    await expect(
      removeRunDirPreservingControlResponses(runDir),
    ).resolves.toBeDefined();
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test('a non-numeric pid is never interpolated into the stop command', async () => {
    fs.writeFileSync(path.join(runDir, 'pid'), '1; touch x');
    await killRun(run());
    expect(execCommands()).toEqual([
      `stop-agent.sh /workspace/ipc/runs/${runId}`,
    ]);
  });

  test('a FIFO pid file neither blocks nor is passed on', async () => {
    if (!hasFifo) return;
    execFileSync('mkfifo', [path.join(runDir, 'pid')]);
    await killRun(run());
    expect(execCommands()).toEqual([
      `stop-agent.sh /workspace/ipc/runs/${runId}`,
    ]);
  }, 5_000);

  test('an unreadable pid file does not stop killRun from stopping the run', async () => {
    // Root ignores file modes, so the read cannot fail there.
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(path.join(runDir, 'pid'), '4242');
    fs.chmodSync(path.join(runDir, 'pid'), 0);
    await killRun(run());
    expect(execCommands()).toEqual([
      `stop-agent.sh /workspace/ipc/runs/${runId}`,
    ]);
  });

  test('a numeric pid is still passed', async () => {
    fs.writeFileSync(path.join(runDir, 'pid'), '4242\n');
    await killRun(run());
    expect(execCommands()).toEqual([
      `stop-agent.sh /workspace/ipc/runs/${runId} 4242`,
    ]);
  });

  test('waitForRun does not settle or block on a FIFO exit_code', async () => {
    if (!hasFifo) return;
    execFileSync('mkfifo', [path.join(runDir, 'exit_code')]);
    let settled = false;
    const pending = waitForRun(runDir, 60_000).finally(() => {
      settled = true;
    });
    pending.catch(() => {});
    await Bun.sleep(300);
    expect(settled).toBe(false);
    // Swapping the run dir out from under the poller fails the run.
    fs.rmSync(runDir, { recursive: true });
    fs.symlinkSync(outside, runDir);
    await expect(pending).rejects.toThrow('Run directory disappeared');
  }, 10_000);

  // A blocking open() of a FIFO never returns, so a regression hangs the whole
  // process: run these under an outer `timeout`, not just the test timeout.
  test('waitForRun fails on a FIFO V1 manifest without blocking the event loop', async () => {
    if (!hasFifo) return;
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'pi' }),
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      `${JSON.stringify({ type: 'run', status: 'started' })}\n`,
    );
    execFileSync('mkfifo', [path.join(runDir, 'output.v1.meta.json')]);
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 100);
    await expect(waitForRun(runDir, 60_000)).rejects.toThrow('V1 manifest');
    await Bun.sleep(200);
    expect(timerFired).toBe(true);
  }, 10_000);

  test('readPersistentSessionDiagnostic reads a FIFO session_dir as empty', () => {
    if (!hasFifo) return;
    execFileSync('mkfifo', [path.join(runDir, 'session_dir')]);
    expect(readPersistentSessionDiagnostic(runDir)).toBe('');
  }, 5_000);

  test.each(['output.v1.meta.json', 'output.v1.jsonl'])(
    'ensureCarapaRunV1Terminal refuses a FIFO %s and keeps the other file',
    (fifo) => {
      if (!hasFifo) return;
      const manifest = {
        format: 'carapa-run',
        version: 1,
        harness: 'pi',
        requestedModel: null,
      };
      const other =
        fifo === 'output.v1.jsonl'
          ? { name: 'output.v1.meta.json', text: JSON.stringify(manifest) }
          : {
              name: 'output.v1.jsonl',
              text: `${JSON.stringify({ type: 'run', status: 'started' })}\n`,
            };
      fs.writeFileSync(path.join(runDir, other.name), other.text);
      execFileSync('mkfifo', [path.join(runDir, fifo)]);
      expect(ensureCarapaRunV1Terminal(carapaRunV1Paths(runDir))).toBe(false);
      expect(fs.readFileSync(path.join(runDir, other.name), 'utf8')).toBe(
        other.text,
      );
    },
    5_000,
  );
});
