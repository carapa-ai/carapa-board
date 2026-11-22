import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { PRIVACY_LOCAL_ENDPOINT_PREFIXES } from '../../config.js';
import { initDatabase } from '../../db.js';
import { logger } from '../../logger.js';
import { PrivacyRefusal, type PrivacyMode } from '../../lib/privacy-policy.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import { runDirectLlm, type DirectLlmOptions } from './direct-llm.js';

// `127.0.0.1` servers are listed as local; `localhost` servers are the same
// machine but a different origin, so they are judged remote from the URL alone.
type Stub = { server: ReturnType<typeof Bun.serve>; hits: number };

function startStub(capacity = false): Stub {
  const stub: Stub = { hits: 0 } as Stub;
  stub.server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      stub.hits++;
      if (capacity) {
        return Response.json(
          { error: { message: 'The selected model is at capacity' } },
          { status: 400 },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return stub;
}
const urlOf = (host: string, stub: Stub) =>
  `http://${host}:${stub.server.port}/v1`;

// Other suites in the same process stub globalThis.fetch from root-level hooks.
const realFetch = globalThis.fetch;

describe('runDirectLlm privacy gate', () => {
  const pid = process.pid;
  const jids: string[] = [];
  const localPrefixes = PRIVACY_LOCAL_ENDPOINT_PREFIXES as string[];
  const stubs: Stub[] = [];
  let local: Stub;
  let localCapacity: Stub;
  let remote: Stub;
  let warn: ReturnType<typeof spyOn>;

  const project = async (name: string, mode?: PrivacyMode) => {
    const folder = `direct-llm-privacy-${name}-${pid}`;
    const jid = `${folder}@web`;
    jids.push(jid);
    await registerGroup(jid, {
      jid,
      name,
      folder,
      trigger: `@${name}`,
      added_at: new Date().toISOString(),
      settings: mode ? { privacyMode: mode } : {},
    });
    return folder;
  };
  const run = (
    options: DirectLlmOptions,
    groupFolder?: string,
  ): Promise<{ result?: string | null }> => {
    globalThis.fetch = realFetch;
    return runDirectLlm(
      'system',
      'hello',
      'test-model',
      () => {},
      [],
      [],
      { allowedToolNames: [], disableSteering: true, ...options },
      undefined,
      undefined,
      undefined,
      groupFolder,
    );
  };
  const fallbackTo = (baseUrl: string): DirectLlmOptions['fallback'] => ({
    modelId: 'fallback-model',
    options: { baseUrl, allowedToolNames: [] },
  });
  const refusals = () =>
    warn.mock.calls.filter((call: unknown[]) => call[1] === 'privacy_refusal')
      .length;

  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    local = startStub();
    localCapacity = startStub(true);
    remote = startStub();
    stubs.push(local, localCapacity, remote);
    localPrefixes.push(
      `http://127.0.0.1:${local.server.port}`,
      `http://127.0.0.1:${localCapacity.server.port}`,
    );
    warn = spyOn(logger, 'warn');
  });
  afterAll(async () => {
    warn.mockRestore();
    localPrefixes.splice(localPrefixes.length - 2, 2);
    for (const stub of stubs) stub.server.stop(true);
    for (const jid of jids) await unregisterGroup(jid);
  });
  beforeEach(async () => {
    for (const jid of jids.splice(0)) await unregisterGroup(jid);
    for (const stub of stubs) stub.hits = 0;
    warn.mockClear();
  });

  test('a strict project refuses a remote baseUrl before any request', async () => {
    const strict = await project('strict', 'strict');
    await expect(
      run(
        {
          baseUrl: urlOf('localhost', remote),
          privacy: { projectId: strict, purpose: 'chat' },
        },
        strict,
      ),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(remote.hits).toBe(0);
    expect(refusals()).toBe(1);
  });

  test('a local primary with a remote fallback is refused; with a local fallback it runs', async () => {
    const strict = await project('strict', 'strict');
    const privacy = { projectId: strict, purpose: 'chat' as const };
    await expect(
      run({
        baseUrl: urlOf('127.0.0.1', local),
        fallback: fallbackTo(urlOf('localhost', remote)),
        privacy,
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(local.hits + remote.hits).toBe(0);
    expect(refusals()).toBe(1);

    const result = await run({
      baseUrl: urlOf('127.0.0.1', local),
      fallback: fallbackTo(urlOf('127.0.0.1', local)),
      privacy,
    });
    expect(result.result).toBe('ok');
    expect(local.hits).toBe(1);
  });

  test('a capacity fallback keeps the attribution, so an off project is not judged strictest', async () => {
    await project('strict', 'strict');
    const off = await project('off');
    const result = await run({
      baseUrl: urlOf('127.0.0.1', localCapacity),
      fallback: fallbackTo(urlOf('localhost', remote)),
      privacy: { projectId: off, purpose: 'chat' },
    });
    expect(result.result).toBe('ok');
    expect(localCapacity.hits).toBe(1);
    expect(remote.hits).toBe(1);
    expect(refusals()).toBe(0);
  });

  test('a capacity fallback hop to a local URL runs under a strict project', async () => {
    const strict = await project('strict', 'strict');
    const result = await run({
      baseUrl: urlOf('127.0.0.1', localCapacity),
      fallback: fallbackTo(urlOf('127.0.0.1', local)),
      privacy: { projectId: strict, purpose: 'chat' },
    });
    expect(result.result).toBe('ok');
    expect(localCapacity.hits).toBe(1);
    expect(local.hits).toBe(1);
  });

  test('requests are unchanged when no project opts in', async () => {
    const off = await project('off');
    const result = await run({ baseUrl: urlOf('localhost', remote) }, off);
    expect(result.result).toBe('ok');
    expect(remote.hits).toBe(1);
    expect(refusals()).toBe(0);
  });

  test('local_memory allows a remote chat call but refuses a memory call', async () => {
    const project1 = await project('memory', 'local_memory');
    await run({
      baseUrl: urlOf('localhost', remote),
      privacy: { projectId: project1, purpose: 'chat' },
    });
    expect(remote.hits).toBe(1);
    await expect(
      run({
        baseUrl: urlOf('localhost', remote),
        privacy: { projectId: project1, purpose: 'memory' },
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(remote.hits).toBe(1);
  });

  test('group_folder is the project when privacy.projectId is absent, and unattributed calls use the strictest mode', async () => {
    const strict = await project('strict', 'strict');
    const off = await project('off');
    await expect(
      run({ baseUrl: urlOf('localhost', remote) }, strict),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    await expect(
      run({ baseUrl: urlOf('localhost', remote) }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(remote.hits).toBe(0);
    await run({ baseUrl: urlOf('localhost', remote) }, off);
    expect(remote.hits).toBe(1);
  });
});
