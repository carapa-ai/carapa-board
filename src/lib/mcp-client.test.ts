import { describe, expect, test } from 'bun:test';
describe('SandboxClient sandbox_branch wire format', () => {
  test('awaits a Git mutation beyond read deadlines and never replays a failed response', async () => {
    // Use the real low-level helper and HTTP transport in a fresh process;
    // route suites replace the shared sandbox client with a Git adapter.
    const script = `
      let release;
      const released = new Promise(resolve => { release = resolve; });
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      let requests = 0;
      let fail = false;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
        requests++;
        entered();
        await released;
        return fail ? Response.json({ error: 'response lost' }, { status: 502 })
          : Response.json({ result: 'merged', isError: false });
      }});
      process.env.CARAPA_BOX_URL = server.url.href;
      const { runGitInRepo } = await import('./src/lib/git-ops.ts');
      const group = { folder: 'mutation-test', settings: {} };
      let settled = false;
      let readDeadlineScheduled = false;
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback, delay, ...args) => {
        if (delay === 20) readDeadlineScheduled = true;
        return realSetTimeout(callback, delay, ...args);
      });
      const pending = runGitInRepo(group, 'merge source', undefined, { waitForCompletion: true })
        .then(result => { settled = true; return result; });
      await started;
      const settledBeforeRelease = settled;
      release();
      const result = await pending;
      fail = true;
      const failed = await runGitInRepo(group, 'merge source', undefined, { waitForCompletion: true });
      globalThis.setTimeout = realSetTimeout;
      console.log(JSON.stringify({ settledBeforeRelease, readDeadlineScheduled, result, failed: failed.ok, requests }));
      await server.stop(true);
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, RUN_GIT_TIMEOUT_MS: '20', LOG_LEVEL: 'silent' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      settledBeforeRelease: false,
      readDeadlineScheduled: false,
      result: { ok: true, output: 'merged' },
      failed: false,
      requests: 2,
    });
  });

  test('propagates cancellation through sandbox execution transport', async () => {
    const script = `
      import { SandboxClient } from './src/lib/mcp-client.ts';
      const client = new SandboxClient('http://example.invalid/mcp');
      const controller = new AbortController();
      client.callToolWithReconnect = async (_name, _args, options) => {
        console.log(JSON.stringify({ receivedSignal: options.signal === controller.signal }));
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      };
      const pending = client.sandboxExec('carapa-bot', 'agent', 'playwright-cli close', {
        signal: controller.signal,
      });
      controller.abort(new Error('cancelled by caller'));
      try {
        await pending;
      } catch (error) {
        console.log(JSON.stringify({ message: String(error) }));
      }
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(
      stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { receivedSignal: true },
      { message: 'Error: cancelled by caller' },
    ]);
  });

  test('normalizes the CarapaBox empty-output sentinel for Git commands', async () => {
    // Exercise the real client in isolation because other backend suites mock
    // this shared module at file scope.
    const script = `
      import { SandboxClient } from './src/lib/mcp-client.ts';
      const client = new SandboxClient('http://example.invalid/mcp');
      client.callToolWithReconnect = async () => ({
        content: [{ type: 'text', text: '(no output)' }],
      });
      const result = await client.sandboxGit('carapa-bot', 'status --porcelain');
      console.log(JSON.stringify(result));
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ stdout: '', isError: false });
  });

  test('build_service options bound REST by timeoutMs and never retry over MCP', async () => {
    const script = `
      import { SandboxClient, BUILD_SERVICE_CALL_OPTIONS } from './src/lib/mcp-client.ts';
      let requests = 0;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
        requests++;
        if (new URL(req.url).searchParams.has('slow')) await Bun.sleep(500);
        return Response.json({ error: 'gateway lost' }, { status: 502 });
      }});
      const client = new SandboxClient(server.url.href + 'mcp');
      let mcpCalls = 0;
      client.reconnect = async () => { mcpCalls++; };
      client.client = { callTool: async () => { mcpCalls++; return { content: [] }; } };
      const out = {};
      try { await client.callTool('build_service', { name: 'x' }, BUILD_SERVICE_CALL_OPTIONS); }
      catch (error) { out.failed = String(error); }
      client.baseUrl = server.url.href.replace(/\\/$/, '') + '?slow=1#';
      const started = Date.now();
      try { await client.callTool('build_service', { name: 'x' }, { ...BUILD_SERVICE_CALL_OPTIONS, timeoutMs: 50 }); }
      catch (error) { out.timedOut = String(error); out.fast = Date.now() - started < 400; }
      console.log(JSON.stringify({ ...out, requests, mcpCalls }));
      await server.stop(true);
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, LOG_LEVEL: 'silent' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.failed).toContain('REST tool call failed: 502');
    expect(result.timedOut).toMatch(/TimeoutError|timed out/i);
    expect(result.fast).toBe(true);
    expect(result.requests).toBe(2);
    expect(result.mcpCalls).toBe(0);
  });

  test('bounds a sandbox Git call that never settles', async () => {
    const script = `
      import { SandboxClient } from './src/lib/mcp-client.ts';
      const client = new SandboxClient('http://example.invalid/mcp');
      client.callToolWithReconnect = async (_name, _args, options) =>
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      try {
        await client.sandboxGit('carapa-bot', 'status --porcelain', undefined, undefined, { timeoutMs: 20 });
      } catch (error) {
        console.log(JSON.stringify({ message: String(error) }));
      }
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as { message: string };
    expect(result.message).toContain('sandbox_git timed out');
  });

  test('sends CarapaBox worktreePath in camelCase', async () => {
    // Several integration suites mock this shared module at file scope. Run
    // the wire contract in a clean Bun process so it always exercises the
    // real client rather than a preload-order-dependent mock.
    const script = `
      import { SandboxClient } from './src/lib/mcp-client.ts';
      const client = new SandboxClient('http://example.invalid/mcp');
      let captured = {};
      client.callToolWithReconnect = async (name, args) => {
        captured = { name, args };
        return { content: [{ type: 'text', text: '{}' }] };
      };
      await client.sandboxBranch('carapa-bot', 'inspect', {
        branch: 'task-branch',
        repoPath: '/var/www/shop/backend',
        worktree_path: '.worktrees/task-branch',
      });
      console.log(JSON.stringify(captured));
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const captured = JSON.parse(stdout) as {
      name: string;
      args: Record<string, unknown>;
    };
    expect(captured.name).toBe('sandbox_branch');
    expect(captured.args).toMatchObject({
      branch: 'task-branch',
      repoPath: '/var/www/shop/backend',
      worktreePath: '.worktrees/task-branch',
    });
    expect(captured.args).not.toHaveProperty('worktree_path');
  });

  test('sends a trimmed remoteUrl on sandbox_git, sandbox_worktree and sandbox_branch only when non-empty', async () => {
    const script = `
      import { SandboxClient } from './src/lib/mcp-client.ts';
      const client = new SandboxClient('http://example.invalid/mcp');
      const captured = [];
      client.callToolWithReconnect = async (name, args) => {
        captured.push({ name, args });
        return { content: [{ type: 'text', text: '{}' }] };
      };
      client.callToolRest = client.callToolWithReconnect;
      for (const remoteUrl of [' git@host:ns/repo.git ', '  ', undefined]) {
        await client.sandboxGit('s', 'fetch', undefined, undefined, { remoteUrl });
        await client.sandboxWorktree('s', 'add', { branch: 'b', remoteUrl });
        await client.sandboxBranch('s', 'merge', { branch: 'b', remoteUrl });
      }
      console.log(JSON.stringify(captured.map((c) => [c.name, c.args.remoteUrl])));
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    const url = 'git@host:ns/repo.git';
    const names = ['sandbox_git', 'sandbox_worktree', 'sandbox_branch'];
    expect(JSON.parse(stdout)).toEqual([
      ...names.map((n) => [n, url]),
      ...names.map((n) => [n, null]),
      ...names.map((n) => [n, null]),
    ]);
  });
});
