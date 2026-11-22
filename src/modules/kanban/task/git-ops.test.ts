import { expect, test } from 'bun:test';

// Keep dependency mocks in a child process so they cannot replace the DB or
// sandbox modules used by other suites in Bun's shared test process.
test('checkpoints finish before queue release without scheduling task reflection', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
const root = process.cwd();
const replace = (file, exports) => mock.module(root + '/src/' + file, () => exports);
const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
let task, checkpoint;
let checkpointStarted, reflectionCalls, locked, started;
replace('db.ts', { getTask: async () => task });
const realLogger = await import(root + '/src/logger.ts');
replace('logger.ts', { ...realLogger, logger: { debug() {} } });
replace('modules/memory/tool-reflector.ts', {
  admitTranscriptMemory: async () => { reflectionCalls++; return null; },
  processTranscriptMemory: async () => { reflectionCalls++; return null; },
});
const commit = async () => {
  checkpointStarted = true;
  started.resolve();
  await checkpoint.promise;
  return true;
};
replace('lib/git-ops.ts', {
  validatedInstance: () => 'instance',
  isLocalRepoMode: () => true,
  taskUsesWorktree: group => group.settings.taskCheckoutMode === 'worktree',
  sharedCheckoutIsSafe: async () => true,
  commitTaskBranch: commit,
  checkpointTaskDefaultBranch: async () => ({ mergeOk: await commit() }),
  runGitInRepo: async () => ({ ok: true }),
  withProjectGitLock: async (_project, fn) => {
    assert.equal(locked, false);
    locked = true;
    try { return await fn(); } finally { locked = false; }
  },
});
const { runPostExecutionGitOps } = await import(root + '/src/modules/kanban/task/git-ops.ts');
for (const mode of ['worktree', 'branch', 'shared']) {
  checkpoint = gate();
  started = gate();
  checkpointStarted = locked = false;
  reflectionCalls = 0;
  task = { id: 'task', project_id: 'project', status: 'testing',
    branch_name: mode === 'shared' ? null : 'task-branch' };
  let settled = false;
  const cleanup = runPostExecutionGitOps(task,
    { folder: 'project', settings: { taskCheckoutMode: mode } },
    [{ id: 'testing', type: 'testing' }]).then(() => { settled = true; });
  await started.promise;
  assert.equal(checkpointStarted, true);
  assert.equal(settled, false, 'queue must wait for the checkpoint');
  assert.equal(reflectionCalls, 0);
  checkpoint.resolve();
  await cleanup;
  assert.equal(settled, true);
  assert.equal(locked, false);
  assert.equal(reflectionCalls, 0, 'task cleanup must not admit or process memory reflection');
}
console.log('task checkpoint checks passed');
`,
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('task checkpoint checks passed');
});
