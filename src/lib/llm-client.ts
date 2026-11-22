import { logger } from '../logger.js';
import type { LLMEndpointConfig } from '../modules/memory/config.js';
import type { ReflectorMemoryExecutionContext } from '../modules/memory/execution-context.js';
import {
  getChatAgents,
  getRuntimeCatalog,
  resolveAgentReferenceFromCatalog,
  resolveRuntimeFromAgents,
  type ChatAgentOption,
  type RuntimeSelection,
  getRuntimeLocality,
  isLocalEndpoint,
} from './chat-agents.js';
import {
  assertEgressAllowed,
  egressTarget,
  type PrivacyPurpose,
} from './privacy-policy.js';
import { sleep } from './async.js';

export interface LLMClientDependencies {
  getChatAgents: typeof getChatAgents;
  getRuntimeCatalog: typeof getRuntimeCatalog;
  resolveAgentReferenceFromCatalog: typeof resolveAgentReferenceFromCatalog;
  resolveRuntimeFromAgents: typeof resolveRuntimeFromAgents;
}

const defaultDependencies: LLMClientDependencies = {
  getChatAgents,
  getRuntimeCatalog,
  resolveAgentReferenceFromCatalog,
  resolveRuntimeFromAgents,
};

export interface LLMResponse {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LLMCompleteOptions {
  /** Override agent baseUrl (eval tooling: host uses localhost, Docker uses host.docker.internal). */
  baseUrlOverride?: string;
  /** When false, skip fs.watch on board_agents.jsonc (one-shot CLI scripts). Default true. */
  watchAgentsFile?: boolean;
  maxTokensOverride?: number;
  temperatureOverride?: number;
  /** Shallow-merged over agent.extra_body (eval: force enable_thinking=false). */
  extraBodyOverride?: Record<string, unknown>;
  /** Abort request after this many ms (default EVAL_LLM_TIMEOUT_MS or 120s). */
  timeoutMs?: number;
  /**
   * Override the agent id used to look up the registered agent profile
   * (e.g. `llm:memory`). When set, this takes precedence over
   * `config.agentId`. If neither the override nor the config id resolves
   * to a registered agent, the call fails. Use this for fallback chains:
   * resolve the agent id in the caller and pass it through here so the
   * LLM call uses the actual resolved profile instead of the configured role.
   */
  agentIdOverride?: string;
  /** Exact structured runtime selected by a caller, including generation settings. */
  runtimeSelectionOverride?: RuntimeSelection;
  /**
   * Run this completion through the DirectLLM tool loop with an exact tool
   * allowlist. Omit for the legacy single-request completion path.
   */
  allowedToolNames?: string[];
  /** Project scope used by read-only DirectLLM tools. Required with tools. */
  groupFolder?: string;
  /** Exact tool permissions for this auxiliary invocation. */
  permissions?: Record<string, string[]>;
  /** Server-owned memory mutation/staging authority for the reflector. */
  memoryExecution?: ReflectorMemoryExecutionContext;
  /** Project whose privacy mode governs this call. Defaults to `groupFolder`. */
  projectId?: string;
  /** What the content is for, used by the privacy gate. Defaults to `unknown`. */
  privacyPurpose?: PrivacyPurpose;
}

type LLMWireResponse = {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
  }>;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
};

type ResponsesStreamEvent = {
  type?: string;
  delta?: string;
  message?: string;
  code?: string;
  response?: LLMWireResponse & {
    error?: { message?: string; code?: string };
    incomplete_details?: { reason?: string };
  };
};

/** Pure request construction, exported to keep wire-contract tests hermetic. */
export function buildLLMRequest(
  agent: ChatAgentOption,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number | undefined,
  temperature: number,
  topP: number,
  presencePenalty: number,
  extraBody: Record<string, unknown>,
): {
  url: string;
  body: Record<string, unknown>;
  wireApi: 'chat_completions' | 'responses';
} {
  const wireApi = agent.wireApi ?? 'chat_completions';
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBaseUrl}/${wireApi === 'responses' ? 'responses' : 'chat/completions'}`;
  const isCodexRelay =
    wireApi === 'responses' && /\/codex$/i.test(normalizedBaseUrl);
  const body =
    wireApi === 'responses'
      ? {
          model,
          instructions: systemPrompt,
          input: [{ role: 'user', content: userMessage }],
          stream: true,
          store: false,
          ...(!isCodexRelay
            ? { max_output_tokens: maxTokens, temperature, top_p: topP }
            : {}),
          ...extraBody,
        }
      : {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: maxTokens,
          temperature,
          presence_penalty: presencePenalty,
          top_p: topP,
          ...extraBody,
        };
  return { url, body, wireApi };
}

/** Pure response normalization shared by Chat Completions and Responses. */
export function parseLLMResponse(
  data: LLMWireResponse,
  wireApi: 'chat_completions' | 'responses',
): LLMResponse {
  const message = data.choices?.[0]?.message;
  const responseOutput = data.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' || item.type === 'text')
    .map((item) => item.text ?? '')
    .join('');
  const content =
    wireApi === 'responses'
      ? data.output_text?.trim() || responseOutput?.trim() || ''
      : message?.content?.trim() || message?.reasoning_content?.trim() || '';
  const usage =
    data.usage && wireApi === 'responses'
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.total_tokens,
        }
      : data.usage;
  return { content, usage };
}

/** Parse the Responses API's SSE wire format used by the Codex relay. */
export function parseResponsesStream(raw: string): LLMResponse {
  let content = '';
  let completedResponse: LLMWireResponse | undefined;

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;

    let event: ResponsesStreamEvent;
    try {
      event = JSON.parse(data) as ResponsesStreamEvent;
    } catch {
      continue;
    }

    if (
      (event.type === 'response.output_text.delta' ||
        event.type === 'response.refusal.delta') &&
      event.delta
    ) {
      content += event.delta;
    } else if (event.type === 'response.completed' && event.response) {
      completedResponse = event.response;
    } else if (
      event.type === 'response.failed' ||
      event.type === 'response.incomplete' ||
      event.type === 'error'
    ) {
      const detail =
        event.response?.error?.message ||
        event.response?.incomplete_details?.reason ||
        event.message ||
        event.code ||
        event.type;
      throw new Error(`Responses API stream ended unsuccessfully: ${detail}`);
    }
  }

  const completed = completedResponse
    ? parseLLMResponse(completedResponse, 'responses')
    : undefined;
  return {
    content: content.trim() || completed?.content || '',
    usage: completed?.usage,
  };
}

export function formatLLMError(status: number, responseText: string): string {
  const bounded = responseText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `LLM request failed (${status})${bounded ? `: ${bounded}` : ''}`;
}

/** Min ms between LLM calls when set (e.g. EVAL_LLM_DELAY_MS=2000 for ~30 req/min). */
function evalLlmDelayMs(): number {
  const raw = process.env.EVAL_LLM_DELAY_MS?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

let evalLlmNextSlotAt = 0;

async function evalLlmThrottle(): Promise<void> {
  const delayMs = evalLlmDelayMs();
  if (delayMs <= 0) return;
  const now = Date.now();
  if (now < evalLlmNextSlotAt) {
    await sleep(evalLlmNextSlotAt - now);
  }
  evalLlmNextSlotAt = Date.now() + delayMs;
}

function retryAfterMs(res: Response, attempt: number): number {
  const headerDelay = retryAfterHeaderMs(res);
  if (headerDelay !== undefined) return headerDelay;
  // Graduated: 15s → 30s → 60s. Flat 60s on first 429 was too slow — retries
  // often succeed after a short pause when only a few requests tripped the window.
  const steps = [15_000, 30_000, 60_000];
  return steps[Math.min(attempt, steps.length - 1)]!;
}

function loading503DelayMs(res: Response): number {
  return retryAfterHeaderMs(res) ?? 5000;
}

function retryAfterHeaderMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after')?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return undefined;
}

const LLM_LOADING_MAX_RETRIES = 10;

function resolveTimeoutMs(options?: LLMCompleteOptions): number {
  if (options?.timeoutMs != null && options.timeoutMs > 0)
    return options.timeoutMs;
  const raw = process.env.EVAL_LLM_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 120_000;
}

/**
 * Send a chat completion request to any OpenAI-compatible endpoint.
 * Returns the assistant's response text.
 */
export async function llmComplete(
  config: LLMEndpointConfig,
  systemPrompt: string,
  userMessage: string,
  options?: LLMCompleteOptions,
  dependencies: LLMClientDependencies = defaultDependencies,
): Promise<LLMResponse> {
  const agents = dependencies.getChatAgents({
    watch: options?.watchAgentsFile !== false,
  });
  const catalog = dependencies.getRuntimeCatalog({
    watch: options?.watchAgentsFile !== false,
  });
  // The override lets callers swap the agent id at call time (e.g. the
  // reflect workflow's fallback chain). When unset, fall back to the
  // config-supplied id (the typical case).
  const resolvedAgentId = options?.agentIdOverride || config.agentId;
  const agent = options?.runtimeSelectionOverride
    ? dependencies.resolveRuntimeFromAgents(
        agents,
        options.runtimeSelectionOverride,
      )
    : options?.agentIdOverride
      ? dependencies.resolveAgentReferenceFromCatalog(
          agents,
          catalog,
          options.agentIdOverride,
        )
      : config.runtimeSelection
        ? dependencies.resolveRuntimeFromAgents(agents, config.runtimeSelection)
        : dependencies.resolveAgentReferenceFromCatalog(
            agents,
            catalog,
            resolvedAgentId,
          );

  if (!agent) {
    const requestedRuntime = options?.runtimeSelectionOverride
      ? `${options.runtimeSelectionOverride.harnessId}/${options.runtimeSelectionOverride.modelId}`
      : (resolvedAgentId ?? '(unset)');
    throw new Error(
      `Memory system configuration error: runtime "${requestedRuntime}" was not found in board_agents.jsonc. Configure the selected memory runtime in defaults.observer or defaults.reflector.`,
    );
  }

  const baseUrl = options?.baseUrlOverride?.trim() || agent.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `Memory system configuration error: Agent "${agent.id}" is missing "baseUrl" in board_agents.jsonc.`,
    );
  }

  // A base URL override replaces the primary endpoint only; the capacity
  // fallback can still switch to its own endpoint, so it must be local too.
  const overridden = !!options?.baseUrlOverride?.trim();
  const locality = overridden
    ? isLocalEndpoint(baseUrl) &&
      (!agent.fallback || getRuntimeLocality(agent.fallback) === 'local')
      ? 'local'
      : 'remote'
    : getRuntimeLocality(agent);
  assertEgressAllowed({
    projectId: options?.projectId ?? options?.groupFolder,
    purpose: options?.privacyPurpose ?? 'unknown',
    locality,
    target: overridden ? egressTarget(baseUrl) : agent.id,
  });

  const model = agent.model || agent.id;
  const apiKey = agent.apiKey || '';
  const maxTokens =
    options?.maxTokensOverride ?? agent.max_tokens ?? config.maxTokens;
  const extraBody = {
    ...(agent.extra_body || {}),
    ...(options?.extraBodyOverride || {}),
  };
  const temperature = options?.temperatureOverride ?? agent.temperature ?? 0.3;
  const presence_penalty = agent.presence_penalty ?? 0;
  const top_p = agent.top_p ?? 1;

  if (options?.allowedToolNames !== undefined) {
    if (!options.groupFolder) {
      throw new Error('Tool-enabled LLM completion requires groupFolder');
    }
    const [{ directLlmFallbackOption, runDirectLlm }, { sharedDeps }] =
      await Promise.all([
        import('../modules/chat/direct-llm.js'),
        import('../mcp/mcp-deps.js'),
      ]);
    const result = await runDirectLlm(
      systemPrompt,
      userMessage,
      model,
      () => {},
      [],
      [],
      {
        wireApi: agent.wireApi,
        baseUrl,
        apiKey,
        temperature,
        max_tokens: maxTokens,
        top_p,
        top_k: agent.top_k,
        frequency_penalty: agent.frequency_penalty,
        presence_penalty,
        extra_body: extraBody,
        reasoning_effort: agent.reasoning_effort,
        maxContextTokens: agent.context_size,
        apiFormat: agent.apiFormat,
        agent_id: agent.id,
        allowedToolNames: options.allowedToolNames,
        memoryExecution: options.memoryExecution,
        privacy: {
          projectId: options.projectId ?? options.groupFolder,
          purpose: options.privacyPurpose ?? 'unknown',
        },
        signal: AbortSignal.timeout(resolveTimeoutMs(options)),
        fallback: directLlmFallbackOption(agent),
      },
      sharedDeps,
      undefined,
      undefined,
      options.groupFolder,
      undefined,
      options.permissions ?? {
        [options.groupFolder]: ['fs:read', 'memories:read'],
      },
    );
    return {
      content: result.result?.trim() || '',
      usage: {
        prompt_tokens: result.tok_input,
        completion_tokens: result.tok_output,
        total_tokens: result.total_tokens,
      },
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const { url, body, wireApi } = buildLLMRequest(
    agent,
    baseUrl,
    model,
    systemPrompt,
    userMessage,
    maxTokens,
    temperature,
    top_p,
    presence_penalty,
    extraBody,
  );

  const startMs = Date.now();
  const max429Retries = evalLlmDelayMs() > 0 ? 3 : 0;
  let attempt429 = 0;
  let attempt503 = 0;

  for (;;) {
    await evalLlmThrottle();

    const timeoutMs = resolveTimeoutMs(options);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 503 && attempt503 < LLM_LOADING_MAX_RETRIES) {
      const waitMs = loading503DelayMs(res);
      attempt503++;
      logger.warn(
        {
          model,
          attempt: attempt503,
          maxAttempts: LLM_LOADING_MAX_RETRIES,
          waitMs,
        },
        'LLM unavailable (503) — retrying',
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status === 429 && attempt429 < max429Retries) {
      const waitMs = retryAfterMs(res, attempt429);
      attempt429++;
      logger.warn(
        { model, attempt: attempt429, waitMs },
        'LLM rate limited (429) — retrying after backoff',
      );
      evalLlmNextSlotAt = Date.now() + waitMs;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(formatLLMError(res.status, errText));
    }

    const parsed =
      wireApi === 'responses'
        ? parseResponsesStream(await res.text())
        : parseLLMResponse((await res.json()) as LLMWireResponse, wireApi);
    const duration_ms = Date.now() - startMs;

    logger.debug(
      {
        model,
        duration_ms,
        promptTokens: parsed.usage?.prompt_tokens,
        completionTokens: parsed.usage?.completion_tokens,
      },
      'LLM completion',
    );

    return parsed;
  }
}
