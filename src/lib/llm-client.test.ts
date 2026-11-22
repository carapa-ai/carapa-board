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
import { PRIVACY_LOCAL_ENDPOINT_PREFIXES } from '../config.js';
import { initDatabase } from '../db.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
// Load the OpenAI SDK before these tests stub fetch; it binds fetch at import,
// which would otherwise leak this file's stub into later suites in the process.
import '../modules/chat/direct-llm.js';
import { PrivacyRefusal } from './privacy-policy.js';
import {
  buildLLMRequest,
  llmComplete,
  parseLLMResponse,
  parseResponsesStream,
  type LLMClientDependencies,
} from './llm-client.js';

const agent = { id: 'llm:test', label: 'Test' };

let stubbedAgents: Array<{
  id: string;
  label?: string;
  baseUrl?: string;
  model?: string;
  harnessId?: string;
  modelId?: string;
  temperature?: number;
  reasoning_effort?: string;
}> = [{ id: 'llm:memory', label: 'Memory', baseUrl: 'http://memory.test' }];
let resolvedRuntimeSelections: Array<{
  harnessId: string;
  modelId: string;
  reasoning?: string;
  temperature?: number;
}> = [];
const llmTestAgentIds = new Set([
  'llm:memory',
  'llm:fallback',
  'llm:direct:memory-pipeline',
]);
function setStubbedAgents(agents: typeof stubbedAgents): void {
  for (let index = stubbedAgents.length - 1; index >= 0; index--) {
    if (llmTestAgentIds.has(stubbedAgents[index]!.id))
      stubbedAgents.splice(index, 1);
  }
  stubbedAgents.push(...agents);
}
const stubRuntimeCatalog = {
  presets: [] as Array<{
    id: string;
    label: string;
    selection: { harnessId: string; modelId: string };
  }>,
  defaults: { chat: { harnessId: 'direct', modelId: 'memory' } },
};

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; body: any }> = [];

const llmDependencies: LLMClientDependencies = {
  getChatAgents: () => stubbedAgents as any,
  getRuntimeCatalog: () => stubRuntimeCatalog as any,
  resolveAgentReferenceFromCatalog: (agents, _catalog, id) =>
    agents.find((candidate) => candidate.id === id),
  resolveRuntimeFromAgents: (agents, selection) => {
    resolvedRuntimeSelections.push({ ...selection });
    const selected = agents.find(
      (candidate) =>
        candidate.harnessId === selection.harnessId &&
        candidate.modelId === selection.modelId,
    )!;
    return {
      ...selected,
      ...(selection.reasoning ? { reasoning_effort: selection.reasoning } : {}),
      ...(selection.temperature !== undefined
        ? { temperature: selection.temperature }
        : {}),
    } as any;
  },
};

const llmCompleteForTests: typeof llmComplete = (
  config,
  systemPrompt,
  userMessage,
  options,
) => llmComplete(config, systemPrompt, userMessage, options, llmDependencies);

beforeEach(() => {
  setStubbedAgents([
    { id: 'llm:memory', label: 'Memory', baseUrl: 'http://memory.test' },
  ]);
  fetchCalls = [];
  resolvedRuntimeSelections = [];
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url =
      typeof input === 'string' ? input : (input?.url ?? String(input));
    let body: any = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ url, body });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('llmComplete wire APIs', () => {
  test('defaults to Chat Completions URL, body, parsing, and usage', () => {
    const request = buildLLMRequest(
      agent,
      'http://relay.test/codex',
      'test-model',
      'system',
      'user',
      123,
      0.3,
      1,
      0,
      {},
    );
    expect(request.url).toBe('http://relay.test/codex/chat/completions');
    expect(request.body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ]);
    expect(request.body.max_tokens).toBe(123);
    expect(request.body.max_output_tokens).toBeUndefined();
    expect(
      parseLLMResponse(
        {
          choices: [{ message: { content: ' chat result ' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        },
        request.wireApi,
      ),
    ).toEqual({
      content: 'chat result',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  test('selects Responses URL/body, output_text, and normalized usage', () => {
    const request = buildLLMRequest(
      { ...agent, wireApi: 'responses' },
      'http://relay.test/codex/',
      'test-model',
      'system',
      'user',
      123,
      0.3,
      1,
      0,
      {},
    );
    expect(request.url).toBe('http://relay.test/codex/responses');
    expect(request.body).toMatchObject({
      model: 'test-model',
      instructions: 'system',
      input: [{ role: 'user', content: 'user' }],
      stream: true,
      store: false,
    });
    expect(request.body.messages).toBeUndefined();
    expect(request.body.max_tokens).toBeUndefined();
    expect(request.body.max_output_tokens).toBeUndefined();
    expect(request.body.temperature).toBeUndefined();
    expect(request.body.top_p).toBeUndefined();
    expect(request.body.presence_penalty).toBeUndefined();
    expect(
      parseLLMResponse(
        {
          output_text: ' response result ',
          usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
        },
        request.wireApi,
      ),
    ).toEqual({
      content: 'response result',
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    });
  });

  test('extracts canonical Responses message content', () => {
    expect(
      parseLLMResponse(
        {
          output: [
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'hidden' }],
            },
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello ' },
                { type: 'output_text', text: 'world' },
              ],
            },
          ],
        },
        'responses',
      ).content,
    ).toBe('Hello world');
  });

  test('parses streamed Responses text and completed usage', () => {
    const stream = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}',
      'data: [DONE]',
    ].join('\n\n');
    expect(parseResponsesStream(stream)).toEqual({
      content: 'Hello world',
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });
  });

  test('surfaces streamed Responses failures', () => {
    expect(() =>
      parseResponsesStream(
        'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}\n\n',
      ),
    ).toThrow('Responses API stream ended unsuccessfully: overloaded');
  });
});

// ─── Agent-id override wiring (regression guard for env-fallback removal) ──
//
// The contract tested here is that `agentIdOverride` on
// `LLMCompleteOptions` changes which registered runtime receives the call.

describe('llmComplete agentIdOverride', () => {
  test('uses the override id to resolve the agent profile (not the config id)', async () => {
    // Only the override id is registered. The config id is missing on
    // purpose: if the override is honoured, the call succeeds; if it is
    // ignored, the call throws "Agent ID ... not found".
    setStubbedAgents([
      {
        id: 'llm:fallback',
        label: 'Fallback',
        baseUrl: 'http://fallback.test',
      },
    ]);
    const response = await llmCompleteForTests(
      { agentId: 'llm:memory', maxTokens: 100 },
      'system',
      'user',
      { agentIdOverride: 'llm:fallback' },
    );
    expect(response.content).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toStartWith('http://fallback.test/');
  });

  test('throws when the override id is not registered', async () => {
    setStubbedAgents([
      {
        id: 'llm:fallback',
        label: 'Fallback',
        baseUrl: 'http://fallback.test',
      },
    ]);
    await expect(
      llmCompleteForTests(
        { agentId: 'llm:memory', maxTokens: 100 },
        'system',
        'user',
        { agentIdOverride: 'llm:does-not-exist' },
      ),
    ).rejects.toThrow(/runtime "llm:does-not-exist" was not found/);
  });

  test('uses a structured runtime selection when the memory role provides one', async () => {
    setStubbedAgents([
      {
        id: 'llm:direct:memory-pipeline',
        label: 'Memory',
        baseUrl: 'http://structured-memory.test',
        harnessId: 'direct',
        modelId: 'memory-pipeline',
      },
    ]);
    const response = await llmCompleteForTests(
      {
        agentId: 'llm:direct:memory-pipeline',
        runtimeSelection: { harnessId: 'direct', modelId: 'memory-pipeline' },
        maxTokens: 100,
      },
      'system',
      'user',
    );
    expect(response.content).toBe('ok');
    expect(fetchCalls[0].url).toStartWith('http://structured-memory.test/');
  });

  test('uses a complete caller runtime selection including reasoning and temperature', async () => {
    setStubbedAgents([
      {
        id: 'llm:direct:memory-pipeline',
        label: 'Memory',
        baseUrl: 'http://structured-memory.test',
        harnessId: 'direct',
        modelId: 'memory-pipeline',
      },
    ]);
    const runtimeSelection = {
      harnessId: 'direct',
      modelId: 'memory-pipeline',
      reasoning: 'high',
      temperature: 0.65,
    };

    await llmCompleteForTests(
      { agentId: 'llm:memory', maxTokens: 100 },
      'system',
      'user',
      {
        agentIdOverride: 'llm:memory',
        runtimeSelectionOverride: runtimeSelection,
      },
    );

    expect(resolvedRuntimeSelections).toEqual([runtimeSelection]);
    expect(fetchCalls[0]).toMatchObject({
      url: expect.stringContaining('structured-memory.test'),
      body: { temperature: 0.65 },
    });
  });
});

describe('llmComplete privacy gate', () => {
  const strictJid = `llm-privacy-${process.pid}@web`;
  const strictFolder = `llm-privacy-${process.pid}`;
  const localPrefix = 'http://local-llm.test:9000';
  const localPrefixes = PRIVACY_LOCAL_ENDPOINT_PREFIXES as string[];

  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    localPrefixes.push(localPrefix);
  });
  afterAll(async () => {
    localPrefixes.splice(localPrefixes.indexOf(localPrefix), 1);
    await unregisterGroup(strictJid);
  });
  const setStrict = async (strict: boolean) => {
    await unregisterGroup(strictJid);
    await registerGroup(strictJid, {
      jid: strictJid,
      name: 'Privacy',
      folder: strictFolder,
      trigger: '@privacy',
      added_at: new Date().toISOString(),
      settings: strict ? { privacyMode: 'strict' } : {},
    });
  };
  const config = { agentId: 'llm:memory', maxTokens: 100 };
  const remoteFallback = {
    id: 'llm:fallback',
    label: 'Fallback',
    baseUrl: 'http://remote-fallback.test',
  };

  test('strict project refuses a remote runtime without calling fetch', async () => {
    await setStrict(true);
    await expect(
      llmCompleteForTests(config, 'system', 'user', {
        projectId: strictFolder,
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(fetchCalls).toHaveLength(0);
  });

  test('a local runtime with a remote fallback is refused on the plain and tool paths', async () => {
    await setStrict(true);
    setStubbedAgents([
      {
        id: 'llm:memory',
        label: 'Memory',
        baseUrl: `${localPrefix}/v1`,
        fallback: remoteFallback,
      } as any,
    ]);
    await expect(
      llmCompleteForTests(config, 'system', 'user', {
        projectId: strictFolder,
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    await expect(
      llmCompleteForTests(config, 'system', 'user', {
        projectId: strictFolder,
        groupFolder: strictFolder,
        allowedToolNames: ['recall'],
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(fetchCalls).toHaveLength(0);
  });

  test('a local baseUrlOverride does not hide a remote fallback', async () => {
    await setStrict(true);
    setStubbedAgents([
      {
        id: 'llm:memory',
        label: 'Memory',
        baseUrl: 'http://remote.test',
        fallback: remoteFallback,
      } as any,
    ]);
    await expect(
      llmCompleteForTests(config, 'system', 'user', {
        projectId: strictFolder,
        baseUrlOverride: `${localPrefix}/v1`,
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(fetchCalls).toHaveLength(0);
  });

  test('a local baseUrlOverride passes when the agent has no remote fallback', async () => {
    await setStrict(true);
    const response = await llmCompleteForTests(config, 'system', 'user', {
      projectId: strictFolder,
      baseUrlOverride: `${localPrefix}/v1`,
    });
    expect(response.content).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
  });

  test('groupFolder is the project when projectId is absent', async () => {
    await setStrict(true);
    await expect(
      llmCompleteForTests(config, 'system', 'user', {
        groupFolder: strictFolder,
      }),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(fetchCalls).toHaveLength(0);
  });

  test('the tool path attributes runDirectLlm to projectId and privacyPurpose', async () => {
    await setStrict(true);
    // Declared local, so llmComplete's own gate passes; runDirectLlm re-judges
    // the remote URL and must refuse under the attribution it was given.
    setStubbedAgents([
      {
        id: 'llm:memory',
        label: 'Memory',
        baseUrl: 'http://remote.test',
        locality: 'local',
      } as any,
    ]);
    const refusal = await llmCompleteForTests(config, 'system', 'user', {
      projectId: strictFolder,
      groupFolder: `${strictFolder}-other`,
      privacyPurpose: 'chat',
      allowedToolNames: [],
    }).catch((err) => err);
    expect(refusal).toBeInstanceOf(PrivacyRefusal);
    expect(refusal).toMatchObject({
      projectId: strictFolder,
      purpose: 'chat',
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test('is unchanged when no project sets a privacy mode', async () => {
    await setStrict(false);
    const response = await llmCompleteForTests(config, 'system', 'user', {
      projectId: strictFolder,
    });
    expect(response.content).toBe('ok');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://memory.test/chat/completions');
    expect(fetchCalls[0].body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ]);
  });
});
