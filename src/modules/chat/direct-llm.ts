import OpenAI from 'openai';
import fsp from 'fs/promises';
import { readAttachmentFile } from '../../lib/attachment-file.js';
import { sha256Hex } from '../../lib/hash.js';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { createHash } from 'crypto';
import { logger } from '../../logger.js';
import {
  formatThinkingMarkdown,
  formatToolResult,
  type ChunkData,
} from '../../stream/parsers.js';
import type { ChatMessage, ChatMessageAttachment } from './types.js';
import { VIDEO_FPS, VIDEO_MAX_DURATION, ENABLE_VIDEO } from '../../config.js';
import { getOpenAITools, dispatchToolCall } from '../tools/index.js';
import { ensureMailToolsLoaded } from '../mail/tools.js';
import { formatToolUse } from '../../stream/parsers.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import type { TriggerSource } from '../kanban/types.js';
import type { ReflectorMemoryExecutionContext } from '../memory/execution-context.js';
import {
  absorbDirectSteeringCandidate,
  getPendingChatMessages,
  releaseAbsorbedDirectSteering,
} from '../../db.js';
import { isLocalEndpoint } from '../../lib/chat-agents.js';
import {
  assertEgressAllowed,
  egressTarget,
  type PrivacyPurpose,
} from '../../lib/privacy-policy.js';
import { completeChatSteeringDelivery } from './db-chats.js';
import { buildAnthropicSystemBlocks } from '../../prompt-cache.js';
import {
  prepareAudioBufferForLlm,
  buildAudioContentPart,
  ollamaAudioExtraBody,
  readOllamaAudioImages,
  buildOllamaAudioUserMessage,
  ollamaNativeChat,
} from '../../lib/audio-for-llm.js';
import {
  extractGeneratedImageArtifacts,
  type GeneratedImageArtifact,
} from '../image-generation/artifacts.js';

export interface DirectLlmResult {
  result: string | null;
  tok_output?: number;
  tok_input?: number;
  tok_context_last?: number;
  tok_cache_read?: number;
  tok_cache_write?: number;
  tok_reasoning?: number;
  total_tokens?: number;
  duration_ms?: number;
  model_name?: string;
  agentSuccess?: boolean;
  context_size?: number;
  session_id?: string;
  generatedArtifacts?: GeneratedImageArtifact[];
}

export interface DirectLlmOptions {
  /** OpenAI HTTP wire protocol. Defaults to Chat Completions. */
  wireApi?: 'chat_completions' | 'responses';
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  baseUrl?: string;
  apiKey?: string;
  extra_body?: Record<string, any>;
  reasoning_effort?: string;
  maxContextTokens?: number;
  signal?: AbortSignal;
  skipInitialLog?: boolean;
  /** Persona orchestration consumes queued human turns at speaker boundaries. */
  disableSteering?: boolean;
  /** Close route admission and flush writes before the loop's final poll. */
  beforeSteeringComplete?: () => void | Promise<void>;
  /** Publish the authoritative delivery update after messages are injected. */
  onSteeringAbsorbed?: (messages: ChatMessage[]) => void | Promise<void>;
  image?: boolean;
  audio?: boolean;
  video?: boolean;
  apiFormat?: 'openai' | 'ollama';
  /**
   * Full materialized runtime ID (for example "llm:direct:qwen").
   * Distinct from the `modelId` arg, which is the bare model name sent on the
   * OpenAI API request. Forwarded as `current_agent_id` to mcpExempt tool
   * handlers so they can fall back to the chat's own LLM (e.g. peek_files).
   */
  agent_id?: string;
  /** Restrict this invocation to an exact read-only/task-specific tool set. */
  allowedToolNames?: string[];
  run_id?: string;
  /** Who started this turn; forwarded to tool handlers as trusted attribution. */
  trigger_source?: TriggerSource;
  /** Server-owned memory mutation/staging authority for auxiliary reflectors. */
  memoryExecution?: ReflectorMemoryExecutionContext;
  /**
   * Stable persona guidance for the Responses API. Keeping this separate from
   * top-level instructions lets each persona reuse its own growing history.
   */
  developerInstructions?: string;
  /** Stable provider cache-routing key shared by related Responses calls. */
  promptCacheKey?: string;
  /**
   * Privacy attribution for the egress gate. Locality is always derived from
   * the URLs, never supplied by the caller. Unattributed calls fall back to
   * `group_folder`, then to the strictest registered mode.
   */
  privacy?: { projectId?: string; purpose: PrivacyPurpose };
  /** Called immediately before the provider request starts. */
  onStarted?: () => void | Promise<void>;
  /** Resolved one-hop capacity fallback. Nested fallbacks are deliberately ignored. */
  fallback?: { modelId: string; options: Omit<DirectLlmOptions, 'fallback'> };
}

type ResponsesUsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
};

export function directLlmPromptCacheKey(...parts: string[]): string {
  return `carapa:${createHash('sha256')
    .update(parts.join('\0'))
    .digest('base64url')}`;
}

/** Normalize cache counters from Platform Responses and the Codex relay. */
export function normalizeResponsesUsage(
  usage: ResponsesUsageLike | null | undefined,
) {
  const cachedInputTokens = Math.max(
    0,
    usage?.input_tokens_details?.cached_tokens ?? 0,
    usage?.cached_input_tokens ?? 0,
  );
  const cacheWriteTokens = Math.max(
    0,
    usage?.input_tokens_details?.cache_write_tokens ?? 0,
    usage?.cache_write_input_tokens ?? 0,
  );
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

export function directLlmFallbackOption(
  agent: any,
): DirectLlmOptions['fallback'] {
  const fallback = agent?.fallback;
  if (!fallback?.model) return undefined;
  return {
    modelId: fallback.model,
    options: {
      wireApi: fallback.wireApi,
      baseUrl:
        fallback.baseUrl ||
        fallback.env?.OPENAI_BASE_URL ||
        fallback.env?.ANTHROPIC_BASE_URL,
      apiKey:
        fallback.apiKey ||
        fallback.env?.OPENAI_API_KEY ||
        fallback.env?.ANTHROPIC_API_KEY,
      temperature: fallback.temperature,
      max_tokens: fallback.max_tokens,
      top_p: fallback.top_p,
      top_k: fallback.top_k,
      frequency_penalty: fallback.frequency_penalty,
      presence_penalty: fallback.presence_penalty,
      extra_body: fallback.extra_body,
      reasoning_effort: fallback.reasoning_effort,
      maxContextTokens: fallback.context_size,
      image: fallback.image,
      audio: fallback.audio,
      video: fallback.video,
      apiFormat: fallback.apiFormat,
      agent_id: fallback.id,
    },
  };
}

export function directLlmWirePath(
  options: DirectLlmOptions,
): 'chat/completions' | 'responses' {
  return options.wireApi === 'responses' ? 'responses' : 'chat/completions';
}

function isLlamaCppBaseUrl(baseUrl?: string): boolean {
  return /llama(?:\.cpp|-proxy)?/i.test(baseUrl ?? '');
}

/**
 * True when the request targets a llama.cpp chat template. The URL marker
 * catches well-named servers; `extra_body.cache_prompt` is a llama.cpp-only
 * request parameter, so agents that declare it opt in even when their proxy
 * URL carries no "llama" marker (e.g. a local llama-proxy on a bare port).
 */
export function isLlamaCppBackend(
  options: Pick<DirectLlmOptions, 'baseUrl' | 'extra_body'>,
): boolean {
  return (
    isLlamaCppBaseUrl(options.baseUrl) ||
    options.extra_body?.cache_prompt === true
  );
}

/**
 * Prepare the canonical history for the provider wire. Non-llama Chat
 * Completions backends fold persona system/developer entries into the
 * leading system message. llama.cpp backends must keep them in place
 * instead: accumulating persona guidance in the leading message rewrites it
 * on every persona turn, so the provider can only reuse the fixed prefix
 * before it and re-processes the entire history. In place, each turn's wire
 * sequence is a strict extension of the previous turn's (see
 * `normalizeLlamaResponsesInput` and `finalizeChatCompletionWireMessages`).
 */
export function prepareDirectLlmHistory(
  systemPrompt: string,
  history: ConversationMessage[],
  options: DirectLlmOptions,
): { systemPrompt: string; history: ConversationMessage[] } {
  if (
    directLlmWirePath(options) === 'chat/completions' &&
    !isLlamaCppBackend(options)
  ) {
    return normalizeChatCompletionGuidance(systemPrompt, history);
  }
  return { systemPrompt, history };
}

/**
 * Final Chat Completions wire normalization. Strict local chat templates
 * (llama.cpp) need persona guidance folded into the message that follows it,
 * keeping the rendered sequence byte-stable across turns; other backends
 * fold late guidance into the leading system message.
 */
export function finalizeChatCompletionWireMessages(
  messages: any[],
  options: Pick<DirectLlmOptions, 'baseUrl' | 'extra_body'>,
): any[] {
  return isLlamaCppBackend(options)
    ? normalizeLlamaResponsesInput(messages)
    : normalizeChatCompletionMessages(messages);
}

function normalizeLlamaResponsesInput(messages: any[]): any[] {
  const normalized: any[] = [];
  let pendingDeveloperGuidance: string[] = [];
  let leadingSystemIndex = -1;

  for (const message of messages) {
    if (message?.role === 'developer') {
      const content = messageText(message.content).trim();
      if (content) pendingDeveloperGuidance.push(content);
      continue;
    }

    if (message?.role === 'system') {
      const content = messageText(message.content).trim();
      if (leadingSystemIndex >= 0) {
        // Strict llama.cpp chat templates accept exactly one system message
        // at index 0. Transcript replay can inject later system entries (e.g.
        // the public-content warning), so fold them into the leading message
        // instead of leaving a system item mid-history.
        if (content) {
          const leading = normalized[leadingSystemIndex];
          normalized[leadingSystemIndex] = {
            ...leading,
            content: [messageText(leading.content).trim(), content]
              .filter(Boolean)
              .join('\n\n'),
          };
        }
        continue;
      }
      if (pendingDeveloperGuidance.length > 0) {
        // Guidance that precedes the leading system message cannot appear
        // before index 0, so merge it into the system message itself.
        normalized.push({
          ...message,
          content: [
            messageText(message.content).trim(),
            ...pendingDeveloperGuidance,
          ]
            .filter(Boolean)
            .join('\n\n'),
        });
        pendingDeveloperGuidance = [];
      } else {
        normalized.push(message);
      }
      leadingSystemIndex = normalized.length - 1;
      continue;
    }

    if (message?.role === 'user' && pendingDeveloperGuidance.length > 0) {
      const guidance = pendingDeveloperGuidance.join('\n\n');
      normalized.push({
        ...message,
        // Array content with image/audio parts: prepend the guidance as a
        // text part instead of flattening the message to text.
        content: hasNonTextPart(message.content)
          ? [{ type: 'text', text: guidance }, ...message.content]
          : [guidance, messageText(message.content)].join('\n\n'),
      });
      pendingDeveloperGuidance = [];
      continue;
    }

    if (pendingDeveloperGuidance.length > 0) {
      normalized.push({
        role: 'user',
        content: pendingDeveloperGuidance.join('\n\n'),
      });
      pendingDeveloperGuidance = [];
    }
    normalized.push(message);
  }

  if (pendingDeveloperGuidance.length > 0) {
    normalized.push({
      role: 'user',
      content: pendingDeveloperGuidance.join('\n\n'),
    });
  }
  return normalized;
}

/**
 * Chat templates are less uniform than the OpenAI API. In particular,
 * llama.cpp templates commonly accept exactly one system message at index 0
 * and do not recognize the developer role. Persona replay can add both
 * roles to the history, so fold that guidance into the leading system
 * message before sending a Chat Completions request.
 */
export function normalizeChatCompletionGuidance(
  systemPrompt: string,
  history: ConversationMessage[],
): { systemPrompt: string; history: ConversationMessage[] } {
  const guidance: string[] = [];
  const normalizedHistory: ConversationMessage[] = [];

  for (const message of history) {
    if (
      (message.role === 'system' || message.role === 'developer') &&
      message.content.trim()
    ) {
      guidance.push(message.content.trim());
      continue;
    }
    normalizedHistory.push(message);
  }

  return {
    systemPrompt: [systemPrompt.trim(), ...guidance]
      .filter(Boolean)
      .join('\n\n'),
    history: normalizedHistory,
  };
}

/** Ensure the final wire payload still satisfies strict local chat templates. */
export function normalizeChatCompletionMessages(messages: any[]): any[] {
  const firstSystemIndex = messages.findIndex(
    (message) => message?.role === 'system',
  );
  const systemParts: string[] = [];
  const normalized: any[] = [];

  for (const message of messages) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const content = messageText(message.content).trim();
      if (content && message !== messages[firstSystemIndex])
        systemParts.push(content);
      continue;
    }
    normalized.push(message);
  }

  const leadingSystem = messages[firstSystemIndex];
  if (leadingSystem) {
    normalized.unshift({
      ...leadingSystem,
      content: [messageText(leadingSystem.content).trim(), ...systemParts]
        .filter(Boolean)
        .join('\n\n'),
    });
  }
  return normalized;
}

function hasNonTextPart(content: unknown): content is any[] {
  return (
    Array.isArray(content) &&
    content.some((part) => typeof part !== 'string' && part?.type !== 'text')
  );
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
    .join('');
}

function toResponsesMessageContent(role: string, content: unknown): unknown {
  if (typeof content === 'string') {
    return [
      {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: content,
      },
    ];
  }
  if (!Array.isArray(content)) return content;

  // DirectLLM builds Chat Completions parts (`text`, `image_url`). Responses
  // uses a different content-part vocabulary. Keep the common text-only case
  // compact and translate multimodal parts when present.
  return content.map((part) => {
    if (part?.type === 'text') {
      return {
        ...part,
        type: role === 'assistant' ? 'output_text' : 'input_text',
      };
    }
    if (part?.type === 'image_url') {
      const imageUrl =
        typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url?.url;
      return {
        type: 'input_image',
        image_url: imageUrl,
        detail: part.image_url?.detail ?? part.detail ?? 'auto',
      };
    }
    if (part?.type === 'input_audio' && part.input_audio) {
      throw new Error(
        'Responses API audio input is not supported by this DirectLLM transport',
      );
    }
    return part;
  });
}

export function buildDirectLlmResponsesRequest(
  model: string,
  messages: any[],
  tools: any[],
  options: DirectLlmOptions,
  previousOutputItems: any[] = [],
  toolChoice: 'auto' | 'none' = 'auto',
): Record<string, unknown> {
  const isCodexRelay = /\/codex\/?$/i.test(options.baseUrl ?? '');
  const isLlamaCpp = isLlamaCppBackend(options);
  const supportsEncryptedReasoning =
    isCodexRelay ||
    options.reasoning_effort !== undefined ||
    /^(?:o[134]|gpt-5|codex)/i.test(model);
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => messageText(message.content))
    .filter(Boolean)
    .join('\n\n');
  const inputMessages = isLlamaCpp
    ? normalizeLlamaResponsesInput(messages)
    : messages;
  const hasTools = tools.length > 0;
  const request: Record<string, unknown> = {
    model,
    // llama.cpp caches the rendered input sequence. Keep its system message
    // in input[0]; placing it in Responses `instructions` makes the adapter
    // rebuild that prefix outside the cacheable message sequence.
    instructions: isLlamaCpp ? undefined : instructions || undefined,
    input: toResponsesInput(inputMessages, previousOutputItems, isLlamaCpp),
    stream: true,
    store: false,
    tools: hasTools ? toResponsesTools(tools) : undefined,
    tool_choice: hasTools ? toolChoice : undefined,
    parallel_tool_calls: hasTools ? true : undefined,
    include: supportsEncryptedReasoning
      ? ['reasoning.encrypted_content']
      : undefined,
    // Keep the Responses payload provider-neutral: ninfer-compatible
    // Responses adapters reject the llama.cpp-only `cache_prompt` field.
    // Prefix reuse is still preserved by keeping llama.cpp's stable history
    // in the Responses `input` sequence above.
    // chatgpt.com/backend-api/codex/responses uses the narrower Codex client
    // contract and rejects some otherwise-valid OpenAI Platform parameters.
    max_output_tokens: isCodexRelay ? undefined : options.max_tokens,
  };
  if (options.reasoning_effort)
    request.reasoning = { effort: options.reasoning_effort };
  if (options.promptCacheKey) request.prompt_cache_key = options.promptCacheKey;
  if (!isCodexRelay && options.temperature !== undefined)
    request.temperature = options.temperature;
  if (!isCodexRelay && options.top_p !== undefined)
    request.top_p = options.top_p;
  if (!isCodexRelay && options.top_k !== undefined)
    request.top_k = options.top_k;
  if (!isCodexRelay && options.presence_penalty !== undefined)
    request.presence_penalty = options.presence_penalty;
  return request;
}

function toResponsesInput(
  messages: any[],
  previousOutputItems: any[] = [],
  includeSystem = false,
): any[] {
  const previousCallIds = new Set<string>(
    previousOutputItems
      .filter((item) => item?.type === 'function_call')
      .map((item) => String(item.call_id)),
  );
  let assistantIndex = -1;
  if (previousCallIds.size > 0) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (
        messages[index]?.role === 'assistant' &&
        messages[index]?.tool_calls?.length
      ) {
        assistantIndex = index;
        break;
      }
    }
    // The canonical items only replace the assistant message they were
    // produced as. If budgeting pruned that message (e.g. an interrupted
    // parallel tool round), substituting them into an older assistant would
    // orphan that older message's function_call_output items.
    if (
      assistantIndex >= 0 &&
      !messages[assistantIndex].tool_calls.every((call: any) =>
        previousCallIds.has(String(call.id)),
      )
    )
      assistantIndex = -1;
  }
  // Providers reject a function_call_output whose function_call is not in the
  // same request, so outputs are only emitted for calls declared above them.
  const declaredCallIds = new Set<string>();
  const convert = (slice: any[]): any[] => {
    const input: any[] = [];
    for (const message of slice) {
      // The Responses/Codex wire contract carries system guidance in the
      // top-level `instructions` field, not as an input conversation item.
      if (message.role === 'system' && !includeSystem) continue;
      if (message.role === 'tool') {
        if (!declaredCallIds.has(String(message.tool_call_id))) continue;
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content ?? '',
        });
        continue;
      }
      if (message.role === 'assistant' && message.tool_calls?.length) {
        if (message.content)
          input.push({
            type: 'message',
            role: 'assistant',
            content: toResponsesMessageContent('assistant', message.content),
          });
        for (const call of message.tool_calls) {
          declaredCallIds.add(String(call.id));
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        continue;
      }
      input.push({
        type: 'message',
        role: message.role,
        content: toResponsesMessageContent(message.role, message.content),
      });
    }
    return input;
  };
  if (assistantIndex < 0) return convert(messages);
  const head = convert(messages.slice(0, assistantIndex));
  for (const id of previousCallIds) declaredCallIds.add(id);
  return [
    ...head,
    ...previousOutputItems,
    ...convert(messages.slice(assistantIndex + 1)),
  ];
}

function toResponsesTools(tools: any[]): any[] {
  return tools.map((tool) =>
    tool.type === 'function' && tool.function
      ? { type: 'function', strict: false, ...tool.function }
      : tool,
  );
}

/** Minimal message shape for conversation history */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  content: string;
  attachments?: ChatMessageAttachment[] | null;
  tool_call_id?: string;
  tool_calls?: any[];
}

const execFileAsync = promisify(execFile);

/** Hard limit for one ffmpeg frame extraction; a hung ffmpeg is killed. */
const VIDEO_FRAME_EXTRACT_TIMEOUT_MS = 60_000;
/** Bounds for the per-attachment frame cache (entries and base64 bytes). */
const VIDEO_FRAME_CACHE_MAX_ENTRIES = 16;
const VIDEO_FRAME_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const videoFrameCache = new Map<string, { frames: string[]; bytes: number }>();
const videoFrameInflight = new Map<string, Promise<string[]>>();
let videoFrameCacheBytes = 0;

function cacheVideoFrames(key: string, frames: string[]): void {
  const bytes = frames.reduce((sum, f) => sum + f.length, 0);
  if (bytes > VIDEO_FRAME_CACHE_MAX_BYTES) return;
  const previous = videoFrameCache.get(key);
  if (previous) videoFrameCacheBytes -= previous.bytes;
  videoFrameCache.delete(key);
  videoFrameCache.set(key, { frames, bytes });
  videoFrameCacheBytes += bytes;
  // Map iterates in insertion order, so the first key is least recently used.
  while (
    videoFrameCache.size > VIDEO_FRAME_CACHE_MAX_ENTRIES ||
    videoFrameCacheBytes > VIDEO_FRAME_CACHE_MAX_BYTES
  ) {
    const oldest = videoFrameCache.keys().next().value;
    if (oldest === undefined) break;
    videoFrameCacheBytes -= videoFrameCache.get(oldest)!.bytes;
    videoFrameCache.delete(oldest);
  }
}

/**
 * Extracts frames from a video using ffmpeg (async, time-limited) and caches
 * them per file path + size + mtime, so later turns reuse earlier results.
 * Returns an array of base64 strings (JPEG); empty on failure or timeout.
 */
async function extractVideoFramesBase64(videoPath: string): Promise<string[]> {
  let key: string;
  try {
    const st = await fsp.stat(videoPath);
    key = `${videoPath}\0${st.size}\0${st.mtimeMs}\0${VIDEO_FPS}\0${VIDEO_MAX_DURATION}`;
  } catch (err) {
    logger.error({ err, videoPath }, 'Error during video frame extraction');
    return [];
  }

  const cached = videoFrameCache.get(key);
  if (cached) {
    videoFrameCache.delete(key);
    videoFrameCache.set(key, cached); // refresh LRU position
    return cached.frames;
  }
  const inflight = videoFrameInflight.get(key);
  if (inflight) return inflight;

  const pending = runVideoFrameExtraction(videoPath)
    .then((frames) => {
      if (frames.length > 0) cacheVideoFrames(key, frames);
      return frames;
    })
    .finally(() => videoFrameInflight.delete(key));
  videoFrameInflight.set(key, pending);
  return pending;
}

async function runVideoFrameExtraction(videoPath: string): Promise<string[]> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'carapa-frames-'));
  try {
    // Extract using configurable fps and max duration
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-i',
          videoPath,
          '-t',
          String(VIDEO_MAX_DURATION),
          '-vf',
          `fps=${VIDEO_FPS},scale='min(800,iw)':-1`, // Scale to max 800px width, keeping aspect
          '-q:v',
          '5', // Quality (1-31, 1 is best, 5 is decent)
          path.join(tmpDir, 'frame_%03d.jpg'),
        ],
        {
          timeout: VIDEO_FRAME_EXTRACT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (err: any) {
      logger.warn(
        {
          stderr: err?.stderr?.toString().slice(-1000),
          videoPath,
          code: err?.code,
          signal: err?.signal,
          killed: err?.killed,
        },
        'ffmpeg frame extraction failed',
      );
      return [];
    }

    const files = (await fsp.readdir(tmpDir)).sort();
    return await Promise.all(
      files.map(async (file) =>
        (await fsp.readFile(path.join(tmpDir, file))).toString('base64'),
      ),
    );
  } catch (err) {
    logger.error({ err, videoPath }, 'Error during video frame extraction');
    return [];
  } finally {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (rmErr) {
      logger.warn({ rmErr, tmpDir }, 'Failed to cleanup frames tmp dir');
    }
  }
}

/** Build OpenAI/Compatible multimodal content parts from attachments */
async function buildMultimodalParts(
  attachments: ChatMessageAttachment[],
  options: {
    image?: boolean;
    audio?: boolean;
    video?: boolean;
    baseUrl?: string;
    apiFormat?: 'openai' | 'ollama';
  } = {},
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const canImage = options.image !== false; // default to true
  const canAudio = options.audio === true; // default to false

  for (const att of attachments) {
    if (att.path) {
      if (att.type === 'image' && canImage) {
        try {
          const buffer = await readAttachmentFile(att.path);
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${att.mimetype};base64,${buffer.toString('base64')}`,
            },
          });
        } catch (err) {
          logger.warn(
            { err, path: att.path },
            'Failed to read image attachment',
          );
        }
      } else if (att.type === 'video' && ENABLE_VIDEO) {
        try {
          const frames = await extractVideoFramesBase64(att.path);
          logger.debug(
            { frameCount: frames.length, filename: att.filename },
            'Extracted video frames',
          );
          for (const b64 of frames) {
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${b64}`,
              },
            });
          }
          if (frames.length === 0) {
            parts.push({
              type: 'text',
              text: `[Video: ${att.filename} - frame extraction failed or returned no frames]`,
            });
          }
        } catch (err) {
          logger.warn(
            { err, path: att.path },
            'Failed to process video attachment',
          );
        }
      } else if (
        att.type === 'audio' &&
        canAudio &&
        options.apiFormat !== 'ollama'
      ) {
        try {
          const raw = await readAttachmentFile(att.path);
          const prepared = await prepareAudioBufferForLlm(
            raw,
            att.mimetype,
            att.filename,
          );
          if (!prepared) {
            logger.warn(
              { path: att.path },
              'Failed to prepare audio attachment',
            );
            continue;
          }
          parts.push(buildAudioContentPart(prepared));
        } catch (err) {
          logger.warn(
            { err, path: att.path },
            'Failed to process audio attachment',
          );
        }
      }
    }
  }
  return parts;
}

function estimateValueTokens(value: unknown): number {
  if (value == null) return 0;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(serialized.length / 2.5);
}

function estimateTokenCount(msg: any): number {
  if (!msg) return 0;
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        text += part.text;
      }
    }
  }
  let count = Math.ceil(text.length / 2.5);
  count += estimateValueTokens(msg.reasoning_content);
  count += estimateValueTokens(msg.reasoning);
  count += 10;
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image')
        count += 1100;
      if (part?.type === 'input_audio')
        count += Math.max(2000, estimateValueTokens(part) / 4);
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.function?.arguments) {
        count += estimateValueTokens(tc.function.arguments);
      }
    }
  }
  return count;
}

export class DirectLlmContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectLlmContextError';
  }
}

/** Provider statuses that indicate the model rejected the attachment payload. */
const ATTACHMENT_RETRY_STATUSES = new Set([400, 415, 422, 500]);

export function isContextOverflowError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  const code = String(
    err?.code ?? err?.error?.code ?? err?.response?.data?.error?.code ?? '',
  ).toLowerCase();
  const message = String(
    err?.message ??
      err?.error?.message ??
      err?.response?.data?.error?.message ??
      '',
  ).toLowerCase();
  const marker = `${code} ${message}`;
  return (
    (status === 400 || status === 413 || status === undefined) &&
    /(context[_ -]?(length|window)|maximum context|too many (input )?tokens|prompt is too long|request too large)/.test(
      marker,
    )
  );
}

export function isModelCapacityError(err: any): boolean {
  const values = [
    err?.message,
    err?.code,
    err?.type,
    err?.error?.message,
    err?.error?.code,
    err?.error?.type,
    err?.response?.data?.error?.message,
    err?.response?.data?.error?.code,
    err?.codexErrorInfo,
    err?.codex_error_info,
  ];
  let marker = '';
  try {
    marker = values
      .map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value ?? ''),
      )
      .join(' ')
      .toLowerCase();
  } catch {
    marker = String(err?.message || err || '').toLowerCase();
  }
  return /selected model is at capacity|model.{0,40}at capacity|serveroverloaded|server[_ -]?overloaded|overload(?:ed)?/.test(
    marker,
  );
}

interface BudgetResult {
  messages: any[];
  estimatedInputTokens: number;
  prunedUnits: number;
  toolResultTruncations: number;
}

export async function openStreamWithOverflowRetry(
  create: (retry: number) => Promise<AsyncIterable<any>>,
  onRetry: (retry: number) => void,
  maxRetries = 2,
  isResponseOutput: (event: any) => boolean = () => true,
  getEventError: (event: any) => Error | undefined = () => undefined,
): Promise<AsyncIterable<any>> {
  for (let retry = 0; ; retry++) {
    try {
      const stream = await create(retry);
      const iterator = stream[Symbol.asyncIterator]();
      const buffered: any[] = [];
      let done = false;
      // Keep request creation and metadata-only stream events inside the retry
      // boundary. Once text/tool-call output begins, retrying could duplicate
      // response content or eventually repeat tool side effects.
      while (!done) {
        const next = await iterator.next();
        done = Boolean(next.done);
        if (done) break;
        const eventError = getEventError(next.value);
        if (eventError) throw eventError;
        buffered.push(next.value);
        if (isResponseOutput(next.value)) break;
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield* buffered;
          if (done) return;
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            yield next.value;
          }
        },
      };
    } catch (err) {
      if (retry >= maxRetries || !isContextOverflowError(err)) throw err;
      onRetry(retry + 1);
    }
  }
}

/** Conservative, tokenizer-independent request budget. Tool calls and their results are atomic. */
export function budgetDirectLlmRequest(
  messages: any[],
  tools: any[],
  contextLimit: number,
  outputReservation: number,
  aggressiveness = 0,
  additionalRequestContent?: unknown,
): BudgetResult {
  const inputLimit = contextLimit - outputReservation;
  const system = messages.filter((m) => m.role === 'system');
  const currentIndex = messages.map((m) => m.role).lastIndexOf('user');
  // The active turn is the current user input plus everything produced after
  // it. During a tool loop that suffix is user -> assistant call -> results;
  // moving only the user message to the end corrupts provider chronology.
  const currentTurn =
    currentIndex >= 0 ? messages.slice(currentIndex) : messages.slice(-1);
  const fixedTokens =
    system.reduce((n, m) => n + estimateTokenCount(m), 0) +
    currentTurn.reduce((sum, message) => sum + estimateTokenCount(message), 0) +
    estimateValueTokens(tools) +
    estimateValueTokens(additionalRequestContent) +
    32;
  if (inputLimit <= 0 || fixedTokens > inputLimit) {
    throw new DirectLlmContextError(
      `The system instructions, current user message, tool definitions, and reserved output (${outputReservation} tokens) cannot fit within the configured ${contextLimit}-token context window. Shorten the current message or system instructions, disable some tools/attachments, increase context_size, or reduce max_tokens.`,
    );
  }

  const historyEnd =
    currentIndex >= 0 ? currentIndex : Math.max(0, messages.length - 1);
  const history = messages
    .slice(0, historyEnd)
    .filter((message) => message.role !== 'system');
  const units: any[][] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const callIds = message.tool_calls.map((call: any) => call.id);
      const requiredIds = new Set(callIds);
      const results: any[] = [];
      while (i + 1 < history.length && history[i + 1].role === 'tool') {
        const result = history[i + 1];
        if (!requiredIds.has(result.tool_call_id)) break;
        results.push(result);
        i++;
      }
      const resultIds = new Set(results.map((result) => result.tool_call_id));
      const isComplete =
        callIds.length > 0 &&
        resultIds.size === callIds.length &&
        results.length === callIds.length &&
        callIds.every((id: string) => resultIds.has(id));
      // An interrupted parallel tool turn is not valid replay context. Drop
      // both the assistant declaration and its partial result subset.
      if (isComplete) units.push([message, ...results]);
    } else if (message.role !== 'tool') units.push([message]);
  }

  const allowance = Math.max(
    0,
    Math.floor(
      (inputLimit - fixedTokens) * Math.max(0.15, 1 - aggressiveness * 0.3),
    ),
  );
  const kept: any[][] = [];
  let used = 0;
  let truncations = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    let unit = units[i];
    let tokens = unit.reduce((n, m) => n + estimateTokenCount(m), 0);
    if (used + tokens > allowance) {
      unit = unit.map((m) => {
        if (m.role !== 'tool' || typeof m.content !== 'string') return m;
        const available = Math.max(
          80,
          allowance -
            used -
            unit.reduce((n, x) => (x === m ? n : n + estimateTokenCount(x)), 0),
        );
        const content = truncateToolResult(m.content, available);
        if (content !== m.content) truncations++;
        return { ...m, content };
      });
      tokens = unit.reduce((n, m) => n + estimateTokenCount(m), 0);
    }
    if (used + tokens <= allowance) {
      kept.unshift(unit);
      used += tokens;
    }
  }
  const result = [...system, ...kept.flat(), ...currentTurn].filter(Boolean);
  return {
    messages: result,
    estimatedInputTokens: fixedTokens + used,
    prunedUnits: units.length - kept.length,
    toolResultTruncations: truncations,
  };
}

function truncateToolResult(content: string, availTokens: number): string {
  const minTokens = 2000;
  const targetTokens = Math.max(minTokens, availTokens);
  const targetChars = targetTokens * 3;
  if (content.length > targetChars) {
    const truncationMsg = `\n\n[Tool Result truncated due to context size limits. ${content.length - targetChars} characters omitted.]`;
    return (
      content.substring(0, targetChars - truncationMsg.length) + truncationMsg
    );
  }
  return content;
}

/** Per-provider-call usage counters accumulated from stream events. */
export interface DirectLlmTurnUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

const EMPTY_TURN_USAGE: DirectLlmTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Consume one Responses-API provider turn. Text/refusal deltas stream
 * through as `text` chunks; reasoning is emitted once, as a
 * `> _..._` blockquote, when the provider completes the reasoning item —
 * the same markdown the sandbox stream parser produces for Codex, so the
 * chat UI renders it with the shared `bq-thinking` styling. Thinking never
 * enters `text` (the model-context history) — like Codex, it is display
 * only.
 */
export async function consumeResponsesStreamTurn(
  stream: AsyncIterable<any>,
  onChunk: (chunk: ChunkData) => void,
  modelId: string,
  onThinking?: (text: string) => void,
): Promise<{
  text: string;
  toolCalls: any[];
  outputItems: any[];
  model?: string;
  usage: DirectLlmTurnUsage;
  hasUsage: boolean;
}> {
  let text = '';
  let toolCalls: any[] = [];
  const outputItems: any[] = [];
  let model: string | undefined;
  const usage: DirectLlmTurnUsage = { ...EMPTY_TURN_USAGE };
  let hasUsage = false;
  const reasoningParts = new Map<number, string>();
  const reasoningContentParts = new Map<number, string>();

  const emitReasoning = (item?: Record<string, any>) => {
    const parts = reasoningParts.size ? reasoningParts : reasoningContentParts;
    const fromParts = [...parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, part]) => part)
      .filter(Boolean)
      .join('\n\n');
    const summary = Array.isArray(item?.summary) ? item.summary : [];
    const content = Array.isArray(item?.content)
      ? item.content.filter((part: any) => part?.type === 'reasoning_text')
      : [];
    const itemText = (parts: any[]) =>
      parts
        .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n\n');
    const note = fromParts || itemText(summary) || itemText(content);
    reasoningParts.clear();
    reasoningContentParts.clear();
    if (note.trim()) {
      onThinking?.(note);
      onChunk({ type: 'text', content: formatThinkingMarkdown(note) });
    }
  };

  for await (const event of stream) {
    if (
      typeof event.response?.model === 'string' &&
      event.response.model.trim()
    ) {
      model = event.response.model.trim();
    }
    if (event.type === 'response.output_text.delta' && event.delta) {
      text += event.delta;
      onChunk({ type: 'text', content: event.delta });
    } else if (event.type === 'response.refusal.delta' && event.delta) {
      text += event.delta;
      onChunk({ type: 'text', content: event.delta });
    } else if (
      (event.type === 'response.reasoning_summary_text.delta' ||
        event.type === 'response.reasoning_text.delta') &&
      event.delta
    ) {
      const isSummary = event.type === 'response.reasoning_summary_text.delta';
      const parts = isSummary ? reasoningParts : reasoningContentParts;
      const partIndex = isSummary ? event.summary_index : event.content_index;
      const index =
        typeof partIndex === 'number' && Number.isInteger(partIndex)
          ? partIndex
          : parts.size;
      parts.set(index, (parts.get(index) ?? '') + String(event.delta));
    } else if (event.type === 'response.output_item.done' && event.item) {
      outputItems.push(event.item);
      if (event.item.type === 'function_call') {
        toolCalls.push({
          id: event.item.call_id,
          type: 'function',
          function: {
            name: event.item.name,
            arguments: event.item.arguments || '{}',
          },
        });
      } else if (event.item.type === 'reasoning') {
        emitReasoning(event.item);
      }
    } else if (event.type === 'response.completed' && event.response?.usage) {
      const normalizedUsage = normalizeResponsesUsage(event.response.usage);
      logger.debug(
        {
          modelId,
          inputTokens: normalizedUsage.inputTokens,
          cachedInputTokens: normalizedUsage.cachedInputTokens,
          cacheWriteTokens: normalizedUsage.cacheWriteTokens,
          cachePercent:
            normalizedUsage.inputTokens > 0
              ? Number(
                  (
                    (normalizedUsage.cachedInputTokens /
                      normalizedUsage.inputTokens) *
                    100
                  ).toFixed(1),
                )
              : 0,
          usageFields: Object.keys(event.response.usage),
          inputDetailFields: Object.keys(
            event.response.usage.input_tokens_details ?? {},
          ),
        },
        'DirectLLM Responses usage',
      );
      usage.inputTokens = normalizedUsage.inputTokens;
      usage.outputTokens = normalizedUsage.outputTokens;
      usage.reasoningTokens = normalizedUsage.reasoningTokens;
      usage.cachedInputTokens = normalizedUsage.cachedInputTokens;
      usage.cacheWriteTokens = Number(normalizedUsage.cacheWriteTokens);
      hasUsage = true;
      emitReasoning();
    } else if (
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    ) {
      const detail =
        event.response?.error?.message ||
        event.response?.incomplete_details?.reason ||
        event.type;
      throw new Error(`Responses API stream ended unsuccessfully: ${detail}`);
    } else if (event.type === 'error') {
      throw new Error(
        `Responses API stream error: ${event.message || event.code || 'unknown error'}`,
      );
    }
  }
  emitReasoning();
  return { text, toolCalls, outputItems, model, usage, hasUsage };
}

/**
 * Split a Chat-Completions `delta.content` into answer text and thinking.
 * Most providers send a string; Mistral sends an array of typed chunks
 * (`{type:'text',text}` and `{type:'thinking',thinking:[{type:'text',text}]}`).
 */
function chatDeltaContent(content: unknown): {
  text: string;
  thinking: string;
} {
  if (typeof content === 'string') return { text: content, thinking: '' };
  let text = '';
  let thinking = '';
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        text += part.text;
      } else if (part?.type === 'thinking' && Array.isArray(part.thinking)) {
        for (const inner of part.thinking) {
          if (typeof inner?.text === 'string') thinking += inner.text;
        }
      }
    }
  }
  return { text, thinking };
}

/**
 * Consume one Chat-Completions provider turn. Reasoning arrives through
 * provider delta extensions (`reasoning_content` on OpenRouter hosts,
 * `reasoning` on some others); like the Responses path, it is emitted once,
 * as a `> _..._` blockquote, when the first content or tool call arrives
 * (or when the stream ends with only reasoning) — and it never mixes into
 * the assistant text.
 */
export async function consumeChatStreamTurn(
  stream: AsyncIterable<any>,
  onChunk: (chunk: ChunkData) => void,
  onThinking?: (text: string) => void,
): Promise<{
  text: string;
  reasoningFields: { reasoning_content?: string; reasoning?: string };
  toolCalls: any[];
  model?: string;
  usage: DirectLlmTurnUsage;
  hasUsage: boolean;
}> {
  let text = '';
  const reasoningFields: { reasoning_content?: string; reasoning?: string } =
    {};
  let toolCalls: any[] = [];
  const usage: DirectLlmTurnUsage = { ...EMPTY_TURN_USAGE };
  let hasUsage = false;
  let thinkingBuffer = '';
  let model: string | undefined;

  const emitThinking = () => {
    if (thinkingBuffer.trim()) {
      onThinking?.(thinkingBuffer);
      onChunk({
        type: 'text',
        content: formatThinkingMarkdown(thinkingBuffer),
      });
    }
    thinkingBuffer = '';
  };

  for await (const chunk of stream) {
    if (typeof chunk.model === 'string' && chunk.model.trim()) {
      model = chunk.model.trim();
    }
    const delta = chunk.choices?.[0]?.delta;
    // Keep the provider's original fields and whitespace for tool-loop replay.
    // The display buffer is flushed below and cannot preserve the cache prefix.
    for (const field of ['reasoning_content', 'reasoning'] as const) {
      if (typeof delta?.[field] === 'string') {
        reasoningFields[field] = (reasoningFields[field] ?? '') + delta[field];
      }
    }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === 'string' && reasoning) thinkingBuffer += reasoning;
    const content = chatDeltaContent(delta?.content);
    if (content.thinking) thinkingBuffer += content.thinking;
    if (content.text) {
      emitThinking();
      text += content.text;
      onChunk({ type: 'text', content: content.text });
    }
    if (delta?.tool_calls) {
      emitThinking();
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCalls[idx])
          toolCalls[idx] = {
            id: tc.id,
            type: 'function',
            function: { name: '', arguments: '' },
          };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments)
          toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (chunk.usage) {
      usage.inputTokens = chunk.usage.prompt_tokens || 0;
      usage.outputTokens += chunk.usage.completion_tokens || 0;
      usage.cachedInputTokens =
        chunk.usage.prompt_tokens_details?.cached_tokens || 0;
      usage.cacheWriteTokens = Number(
        chunk.usage.prompt_tokens_details?.cache_write_tokens || 0,
      );
      hasUsage = true;
    }
  }
  emitThinking();
  return { text, reasoningFields, toolCalls, model, usage, hasUsage };
}

/** Detect attempted calls in answer text without interpreting or executing them. */
function hasUnexecutedToolCallText(text: string): boolean {
  // Quoted examples are legitimate answers. Only inspect unfenced lines that
  // start with the provider's raw tool-call envelope.
  let fence: { marker: string; length: number } | undefined;
  const unquoted = text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
        else if (
          marker[1][0] === fence.marker &&
          marker[1].length >= fence.length
        )
          fence = undefined;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
  return /(?:^|\n)[ \t]*<tool_call>\s*<function\s*=\s*[^>\s]+>[\s\S]*?<\/function>\s*<\/tool_call>/i.test(
    unquoted,
  );
}

/**
 * Consecutive executions of the same call with the same result after which a
 * repeated request is no longer executed.
 */
const REPEATED_CALL_STREAK_LIMIT = 3;

/**
 * Identity of a tool call for the repeated-call guard: the tool name plus its
 * arguments as JSON with recursively sorted object keys, so argument key order
 * does not matter. Unparseable arguments fall back to the raw argument string.
 */
function toolCallRepeatKey(name: string, rawArguments: string): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sortKeys(record[key])]),
      );
    }
    return value;
  };
  try {
    return `${name}:${JSON.stringify(sortKeys(JSON.parse(rawArguments || '{}')))}`;
  } catch {
    return `${name}:${rawArguments}`;
  }
}

async function runOpenAiCompatible(
  openai: OpenAI,
  modelId: string,
  messages: any[],
  onChunk: (chunk: ChunkData) => void,
  deps?: McpServerDeps,
  onTranscriptEntry?: (entry: any) => void,
  session_id?: string,
  group_folder?: string,
  task_id?: string,
  permissions?: Record<string, string[]>,
  options: DirectLlmOptions = {},
  conversation_id?: string,
  /**
   * Anthropic-specific system-prompt blocks with `cache_control` markers,
   * produced by `buildAnthropicSystemBlocks`. When non-null the request
   * sends them as the top-level `system` field (Anthropic's canonical
   * location) and blanks `messages[0].content` so the message-array
   * pruning code below still has a stable `messages[0]` to reference.
   * Null on all non-Anthropic backends.
   */
  anthropicSystemBlocks?: any[] | null,
  /** Collects ids injected as steering so the caller can release them. */
  absorbedSteeringIds: Set<string> = new Set(),
): Promise<DirectLlmResult> {
  // Persist display-only reasoning before publishing it, including turns
  // interrupted after thinking. These entries never become answer/history text.
  const persistThinking = (text: string) =>
    onTranscriptEntry?.({ type: 'thinking', text });
  // Visible output length of this run, excluding the display-only steering
  // notice. Replay merges the run's assistant rows into one message, so a
  // steering receipt's contentOffset must use these same coordinates to split
  // that message around the steered user prompt.
  const publishChunk = onChunk;
  let visibleOutputLength = 0;
  onChunk = (chunk) => {
    if (chunk.type === 'text') visibleOutputLength += chunk.content.length;
    publishChunk(chunk);
  };
  let lastInputTokens = 0;
  let totalInputTokensCumulative = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCachedInputTokens = 0;
  let lastCachedInputTokens = 0;
  let totalCacheWriteTokens = Number();
  let lastCacheWriteTokens = Number();
  let finalResultText = '';
  // Keep routing requests through the configured model; report each response's model.
  let responseModel = modelId;
  let previousResponseOutputItems: any[] = [];
  const generatedArtifacts: GeneratedImageArtifact[] = [];

  let turnCount = 0;
  let toolProtocolRetries = 0;
  // Set once the tool budget is spent: one last request runs with
  // `tool_choice: 'none'` so the user gets a written account instead of silence.
  let finalAnswerTurn = false;
  let lastToolResultText = '';
  // Reflection may need recall + write for five facts, evidence corrections,
  // and a final completion response. Normal chat gets a high budget that only
  // stops runaway loops: long jobs such as organizing a mailbox need many turns.
  const MAX_TOOL_TURNS = options.memoryExecution ? 20 : 100;

  // Repeated-call guard (memory reflection is exempt): tracks the last
  // executed call and its result hash so a model stuck repeating the exact
  // same call with the same result is stopped instead of burning the budget.
  const repeatGuardEnabled = !options.memoryExecution;
  let lastRepeatKey: string | undefined;
  let lastRepeatResultHash: string | undefined;
  let repeatStreak = 0;
  let repeatedCallBlockedCount = 0;
  let lastRepeatBlockedTool: string | undefined;

  const seenMessageIds = new Set<number | string>();
  const pendingSteeringMessages = new Map<
    string,
    { message: ChatMessage; contentOffset: number }
  >();
  let steeringAdmissionClosed = false;

  const closeSteeringAdmission = async () => {
    if (steeringAdmissionClosed) return;
    steeringAdmissionClosed = true;
    await options.beforeSteeringComplete?.();
  };

  const completeAbsorbedSteering = async () => {
    const absorbed = [...pendingSteeringMessages.values()];
    if (absorbed.length === 0) return;
    for (const { message, contentOffset } of absorbed) {
      await completeChatSteeringDelivery(
        group_folder!,
        conversation_id!,
        String(message.id),
        true,
        { contentOffset },
      );
    }
    pendingSteeringMessages.clear();
    releaseAbsorbedDirectSteering(
      group_folder!,
      conversation_id!,
      absorbed.map(({ message }) => String(message.id)),
    );
    await options.onSteeringAbsorbed?.(absorbed.map(({ message }) => message));
  };

  if (conversation_id && group_folder) {
    try {
      const current = await getPendingChatMessages(
        group_folder,
        conversation_id,
        '1970-01-01',
      );
      for (const m of current) {
        if (m.id) seenMessageIds.add(m.id);
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to initialize seenMessageIds from DB');
    }
  }

  const checkSteering = async () => {
    if (options.disableSteering) return false;
    if (conversation_id && group_folder) {
      const candidates = await getPendingChatMessages(
        group_folder,
        conversation_id,
        '1970-01-01',
      );
      const pending: ChatMessage[] = [];
      for (const candidate of candidates) {
        if (seenMessageIds.has(candidate.id)) continue;
        // Absorption and withdrawal share one per-message claim, so a message
        // the user deleted is never injected and an injected one is never
        // reported as withdrawn.
        if (
          await absorbDirectSteeringCandidate(
            group_folder,
            conversation_id,
            String(candidate.id),
          )
        ) {
          absorbedSteeringIds.add(String(candidate.id));
          pending.push(candidate);
        } else {
          seenMessageIds.add(candidate.id);
        }
      }

      logger.debug(
        {
          conversation_id,
          candidatesCount: candidates.length,
          pendingCount: pending.length,
        },
        'Checking for steering messages',
      );

      if (pending.length > 0) {
        logger.info(
          {
            count: pending.length,
            attachmentCount: pending.reduce(
              (sum, message) => sum + (message.attachments?.length || 0),
              0,
            ),
          },
          'Injected steering messages detected',
        );

        const contentOffset = visibleOutputLength;
        publishChunk({
          type: 'text',
          content: `\n\n*🔍 [Steering: Received ${pending.length} new message(s) from user. Adjusting course...]*\n\n`,
        });
        for (const msg of pending) {
          seenMessageIds.add(msg.id);
          const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
          if (msg.attachments?.length) {
            const multimodalParts = await buildMultimodalParts(
              msg.attachments,
              options,
            );
            parts.push(...multimodalParts);
          }
          parts.push({
            type: 'text',
            text: msg.executionContent ?? msg.content,
          });
          messages.push({ role: 'user', content: parts });
          pendingSteeringMessages.set(String(msg.id), {
            message: msg,
            contentOffset,
          });

          // Steering already comes from the durable transcript. Re-appending
          // it without its original ID creates a new polling candidate and
          // feeds the same message back into this loop. Record absorption via
          // completeAbsorbedSteering's receipt instead of another user entry.
        }
        // A newly accepted human turn gets its own bounded tool budget. This
        // prevents a message injected at the old turn's limit from being
        // marked absorbed without ever receiving a provider response.
        turnCount = 0;
        finalAnswerTurn = false;
        // A newly absorbed human turn also clears the repeated-call guard.
        lastRepeatKey = undefined;
        lastRepeatResultHash = undefined;
        repeatStreak = 0;
        repeatedCallBlockedCount = 0;
        lastRepeatBlockedTool = undefined;
        return true;
      }
    }
    return false;
  };

  while (true) {
    options.signal?.throwIfAborted();
    // Step 1: Check for pending user messages sent since the last turn started (Steering)
    await checkSteering();
    if (turnCount >= MAX_TOOL_TURNS && !finalAnswerTurn) {
      await closeSteeringAdmission();
      if (await checkSteering()) continue;
      if (options.memoryExecution) {
        throw new Error(
          `Reflector exhausted its ${MAX_TOOL_TURNS} model-turn limit before confirming completion`,
        );
      }
      logger.warn(
        { group_folder, modelId, turnCount },
        'direct-llm tool-turn limit reached',
      );
      finalAnswerTurn = true;
      messages.push({
        role: 'user',
        content:
          'Tool budget exhausted. Do not call tools. Reply now in plain text: what you found, what is still missing, and why you stopped.',
      });
    }

    // Lazily discover carapa-mail tools (gitnexus-style) before the sync registry read.
    if (group_folder) await ensureMailToolsLoaded(group_folder);

    const tools = getOpenAITools(
      group_folder ? { group_folder, permissions } : undefined,
      options.allowedToolNames,
    );
    const executableToolNames = options.memoryExecution
      ? tools.map((tool) => tool.function.name)
      : options.allowedToolNames;

    // Build request body
    const extraBody = { ...options.extra_body };
    /*if (isLlamaCppBackend(options) && extraBody.cache_prompt === undefined) {
      extraBody.cache_prompt = true;
    }
    if (options.top_k !== undefined && extraBody.top_k === undefined) {
      extraBody.top_k = options.top_k;
    }*/

    // Anthropic prompt cache: when the backend is Anthropic and the
    // system prompt contains the cache-breakpoint marker, the real
    // content lives in `extra_body.system` (the canonical Anthropic
    // location) with a `cache_control: { type: "ephemeral" }` marker
    // on the prefix block. The message-array form (`messages[0]`) is
    // blanked here so (a) Anthropic doesn't see two competing system
    // fields, and (b) the pruning code below still has a stable
    // `messages[0]` to tokenise. NOTE: blanking `messages[0]` means its
    // own token estimate drops to near zero. The request overhead below
    // carries the relocated blocks into the prune budget instead.
    if (anthropicSystemBlocks && anthropicSystemBlocks.length > 0) {
      extraBody.system = anthropicSystemBlocks;
      if (messages.length > 0 && messages[0]?.role === 'system') {
        messages[0] = { ...messages[0], content: '' };
      }
    }

    const maxContextTokens = options.maxContextTokens || 128000;
    const outputReservation = options.max_tokens || 4000;
    // Include relocated Anthropic instructions in the fixed request overhead.
    const requestOverhead =
      directLlmWirePath(options) === 'responses'
        ? {
            anthropicSystemBlocks,
            previousResponseOutputItems,
            developerInstructions: options.developerInstructions,
          }
        : (anthropicSystemBlocks ?? undefined);
    const budget = budgetDirectLlmRequest(
      messages,
      tools,
      maxContextTokens,
      outputReservation,
      0,
      requestOverhead,
    );
    let prunedMessages = budget.messages;
    logger.debug(
      {
        estimatedInputTokens: budget.estimatedInputTokens,
        contextSize: maxContextTokens,
        outputReservation,
        prunedUnits: budget.prunedUnits,
        toolResultTruncations: budget.toolResultTruncations,
      },
      'DirectLLM request budgeted',
    );

    const isReasoningModel =
      options.reasoning_effort !== undefined ||
      modelId.startsWith('o1') ||
      modelId.startsWith('o3');

    const params: any = {
      model: modelId,
      messages:
        directLlmWirePath(options) === 'chat/completions'
          ? finalizeChatCompletionWireMessages(prunedMessages, options)
          : prunedMessages,
      stream: true,
      tools: tools.length > 0 ? (tools as any) : undefined,
      stream_options: { include_usage: true } as any,
      ...extraBody,
      extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    };

    if (finalAnswerTurn && tools.length > 0) params.tool_choice = 'none';

    if (isReasoningModel) {
      if (options.reasoning_effort !== undefined) {
        params.reasoning_effort = options.reasoning_effort;
      }
      if (options.max_tokens !== undefined) {
        params.max_completion_tokens = options.max_tokens;
      }
    } else {
      params.temperature = options.temperature;
      params.max_tokens = options.max_tokens;
      params.top_p = options.top_p;
      params.frequency_penalty = options.frequency_penalty;
      if (options.presence_penalty !== undefined) {
        params.presence_penalty = options.presence_penalty;
      }
      if (options.top_k !== undefined) {
        params.top_k = options.top_k;
      }
    }

    let currentTurnText = '';
    let currentTurnReasoning: {
      reasoning_content?: string;
      reasoning?: string;
    } = {};
    let toolCalls: any[] = [];

    // A failed final request must still end in a visible notice, not a thrown
    // error that discards the run's work; aborts always propagate.
    let finalTurnFailed = false;
    try {
      if (directLlmWirePath(options) === 'responses') {
        const stream = await openStreamWithOverflowRetry(
          async (retry) => {
            const retryBudget = budgetDirectLlmRequest(
              messages,
              tools,
              maxContextTokens,
              outputReservation,
              retry,
              {
                anthropicSystemBlocks,
                previousResponseOutputItems,
                developerInstructions: options.developerInstructions,
                promptCacheKey: options.promptCacheKey,
              },
            );
            prunedMessages = retryBudget.messages;
            const requestLog = {
              retry,
              contextSize: maxContextTokens,
              estimatedInputTokens: retryBudget.estimatedInputTokens,
              prunedUnits: retryBudget.prunedUnits,
            };
            if (retry === 0) {
              logger.debug(requestLog, 'Sending DirectLLM Responses request');
            } else {
              logger.warn(
                requestLog,
                'Retrying DirectLLM Responses request after context overflow',
              );
            }
            const responseParams = buildDirectLlmResponsesRequest(
              modelId,
              prunedMessages,
              tools as any[],
              options,
              previousResponseOutputItems,
              finalAnswerTurn ? 'none' : 'auto',
            );
            return (await openai.responses.create(
              responseParams as any,
              {
                signal: options.signal,
                // The Codex relay derives the upstream prompt_cache_key from this
                // header and otherwise generates a new UUID for every request. A
                // body-level prompt_cache_key alone is rewritten and cannot produce
                // deterministic cache affinity.
                headers:
                  options.promptCacheKey &&
                  /\/codex\/?$/i.test(options.baseUrl ?? '')
                    ? { session_id: options.promptCacheKey }
                    : undefined,
              } as any,
            )) as any;
          },
          (retry) =>
            logger.warn(
              { retry, contextSize: maxContextTokens },
              'Provider rejected DirectLLM Responses context',
            ),
          2,
          (event) =>
            (event.type === 'response.output_text.delta' &&
              Boolean(event.delta)) ||
            (event.type === 'response.refusal.delta' && Boolean(event.delta)) ||
            (event.type === 'response.reasoning_summary_text.delta' &&
              Boolean(event.delta)) ||
            (event.type === 'response.reasoning_text.delta' &&
              Boolean(event.delta)) ||
            event.type === 'response.output_item.done',
          (event) => {
            if (
              event.type !== 'response.failed' &&
              event.type !== 'response.incomplete' &&
              event.type !== 'error'
            )
              return undefined;
            const providerError = event.response?.error ?? event;
            const detail =
              providerError?.message ||
              event.response?.incomplete_details?.reason ||
              event.message ||
              event.code ||
              event.type;
            return Object.assign(
              new Error(`Responses API stream ended unsuccessfully: ${detail}`),
              {
                status: providerError?.status ?? event.status,
                code: providerError?.code ?? event.code,
              },
            );
          },
        );
        const turn = await consumeResponsesStreamTurn(
          stream,
          onChunk,
          modelId,
          persistThinking,
        );
        currentTurnText = turn.text;
        responseModel = turn.model || modelId;
        finalResultText += turn.text;
        toolCalls = turn.toolCalls;
        if (turn.hasUsage) {
          lastInputTokens = turn.usage.inputTokens;
          totalInputTokensCumulative += lastInputTokens;
          totalOutputTokens += turn.usage.outputTokens;
          totalReasoningTokens += turn.usage.reasoningTokens;
          lastCachedInputTokens = turn.usage.cachedInputTokens;
          totalCachedInputTokens += turn.usage.cachedInputTokens;
          lastCacheWriteTokens = Number(turn.usage.cacheWriteTokens);
          totalCacheWriteTokens += Number(turn.usage.cacheWriteTokens);
        }
        previousResponseOutputItems = turn.outputItems;
      } else {
        const stream = await openStreamWithOverflowRetry(
          async (retry) => {
            const retryBudget = budgetDirectLlmRequest(
              messages,
              tools,
              maxContextTokens,
              outputReservation,
              retry,
              anthropicSystemBlocks ?? undefined,
            );
            prunedMessages = retryBudget.messages;
            params.messages =
              directLlmWirePath(options) === 'chat/completions'
                ? finalizeChatCompletionWireMessages(prunedMessages, options)
                : prunedMessages;
            const requestLog = {
              retry,
              contextSize: maxContextTokens,
              estimatedInputTokens: retryBudget.estimatedInputTokens,
              prunedUnits: retryBudget.prunedUnits,
            };
            if (retry === 0) {
              logger.debug(
                requestLog,
                'Sending DirectLLM Chat Completions request',
              );
            } else {
              logger.warn(
                requestLog,
                'Retrying DirectLLM Chat Completions request after context overflow',
              );
            }
            return (await openai.chat.completions.create(params, {
              signal: options.signal,
            } as any)) as any;
          },
          (retry) =>
            logger.warn(
              { retry, contextSize: maxContextTokens },
              'Provider rejected DirectLLM Chat Completions context',
            ),
          2,
          (chunk) =>
            Boolean(
              chunk.choices?.some(
                (choice: any) =>
                  choice.delta?.content || choice.delta?.tool_calls?.length,
              ),
            ),
        );

        const turn = await consumeChatStreamTurn(
          stream,
          onChunk,
          persistThinking,
        );
        currentTurnText = turn.text;
        responseModel = turn.model || modelId;
        currentTurnReasoning = turn.reasoningFields;
        finalResultText += turn.text;
        toolCalls = turn.toolCalls;
        if (turn.hasUsage) {
          lastInputTokens = turn.usage.inputTokens;
          totalInputTokensCumulative += lastInputTokens;
          totalOutputTokens += turn.usage.outputTokens;
          lastCachedInputTokens = turn.usage.cachedInputTokens;
          totalCachedInputTokens += turn.usage.cachedInputTokens;
          lastCacheWriteTokens = Number(turn.usage.cacheWriteTokens);
          totalCacheWriteTokens += Number(turn.usage.cacheWriteTokens);
        }
      }
    } catch (err) {
      if (!finalAnswerTurn || options.signal?.aborted) throw err;
      finalTurnFailed = true;
      logger.warn(
        { err, group_folder, modelId },
        'direct-llm final no-tools request failed',
      );
    }

    // OpenAI-compatible SDKs may end an aborted stream without throwing. Do
    // not persist an empty assistant turn or enter the post-stream steering
    // checkpoints after cancellation.
    options.signal?.throwIfAborted();
    // The final request is never allowed to run tools; drop any calls it made.
    if (finalAnswerTurn) toolCalls = [];
    // Add assistant response (including tool calls) to history
    messages.push({
      role: 'assistant',
      content: currentTurnText || null,
      ...currentTurnReasoning,
      // Strict OpenAI-compatible providers reject an empty tool_calls array.
      ...(toolCalls.length > 0 && {
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      }),
    } as any);

    // Save this turn's assistant message to the transcript immediately
    if (onTranscriptEntry) {
      onTranscriptEntry({
        type: 'message',
        role: 'assistant',
        content: currentTurnText,
        telemetry: {
          tok_input: lastInputTokens,
          tok_output: totalOutputTokens,
          tok_cache_read: lastCachedInputTokens,
          tok_cache_write: lastCacheWriteTokens,
          model_name: responseModel,
        },
      });
    }

    if (finalAnswerTurn) {
      // Steering at the limit behaves as before: a new user message resets the
      // budget and the loop continues.
      await completeAbsorbedSteering();
      if (await checkSteering()) continue;
      await closeSteeringAdmission();
      if (await checkSteering()) continue;
      options.signal?.throwIfAborted();
      if (finalTurnFailed || !currentTurnText.trim()) {
        const lastResult = lastToolResultText.trim().slice(0, 300);
        const notice = `\n\nStopped after ${turnCount} tool rounds without a final answer.${
          lastResult ? ` The last tool result was: ${lastResult}.` : ''
        }\n\n`;
        onChunk({ type: 'text', content: notice });
        finalResultText += notice;
        onTranscriptEntry?.({
          type: 'message',
          role: 'assistant',
          content: notice,
        });
      }
      break;
    }

    if (
      toolCalls.length === 0 &&
      tools.length > 0 &&
      hasUnexecutedToolCallText(currentTurnText)
    ) {
      if (toolProtocolRetries >= 1 || turnCount + 1 >= MAX_TOOL_TURNS) {
        throw new Error(
          'The model could not return executable tool calls within the retry limit. Its text-only calls were not executed. Try another model or check the provider’s tool-call configuration.',
        );
      }
      toolProtocolRetries++;
      const notice =
        '\n\nThe model returned tool-call text instead of executable calls. Asking it to retry using the available tools.\n\n';
      onChunk({ type: 'text', content: notice });
      finalResultText += notice;
      onTranscriptEntry?.({
        type: 'message',
        role: 'assistant',
        content: notice,
      });
      messages.push({
        role: 'user',
        content:
          'Tool protocol correction: your previous response printed <tool_call>/<function> markup as answer text. None of those text calls were executed. Continue the original request using structured API tool calls from the supplied tools list, with JSON arguments. Do not print tool-call markup. If the required tool is unavailable, explain the limitation and the next step instead of inventing a call.',
      });
      turnCount++;
      continue;
    }

    if (toolCalls.length === 0) {
      // A user message can arrive while the provider stream is open. The
      // pre-turn steering check has already run by then, and without tools
      // there used to be no other checkpoint before exiting the loop. That
      // left the newly persisted message unanswered because the route also
      // suppresses a second run while this one is active.
      await completeAbsorbedSteering();
      if (await checkSteering()) {
        turnCount++;
        continue;
      }
      await closeSteeringAdmission();
      if (!(await checkSteering())) break;
      turnCount++;
      continue;
    }

    // Execute tools
    let abortDetected = false;
    for (const tc of toolCalls) {
      // If the user pressed Stop between turns or while a previous tool was
      // running, don't execute any more tools — break out and let the outer
      // loop terminate. Without this check the model would keep issuing tool
      // calls after a cancellation since the OpenAI stream finished cleanly.
      if (options.signal?.aborted) {
        abortDetected = true;
        break;
      }

      const name = tc.function.name;
      let callArgs = {};
      try {
        callArgs = JSON.parse(tc.function.arguments || '{}');
      } catch (e) {
        logger.error(
          { tool: name, argumentLength: (tc.function.arguments || '').length },
          'Failed to parse tool arguments',
        );
      }

      const toolCallId = String(tc.id || '');
      const repeatKey = repeatGuardEnabled
        ? toolCallRepeatKey(name, tc.function.arguments || '')
        : undefined;
      // A request for the exact call that already ran REPEATED_CALL_STREAK_LIMIT
      // times in a row with an identical result is not executed again.
      const blockedRepeat =
        repeatKey !== undefined &&
        repeatKey === lastRepeatKey &&
        repeatStreak >= REPEATED_CALL_STREAK_LIMIT;

      if (!blockedRepeat) {
        const callSummary = formatToolUse(
          name,
          callArgs,
          undefined,
          undefined,
          toolCallId || undefined,
        );
        onChunk({ type: 'text', content: callSummary });
        finalResultText += callSummary; // Include tool call in transcript

        // Save tool call to transcript immediately using structured format
        if (onTranscriptEntry) {
          onTranscriptEntry({
            type: 'tool_use',
            part: {
              id: toolCallId || undefined,
              type: 'tool',
              tool: name,
              state: {
                status: 'running',
                input: callArgs,
              },
            },
          });
        }
      }

      let toolResultText: string;
      if (blockedRepeat) {
        repeatedCallBlockedCount += 1;
        lastRepeatBlockedTool = name;
        toolResultText = `Not executed: you already called ${name} with these exact arguments ${repeatStreak} times in a row and got the same result each time. Do not repeat it. Answer the user now in plain text from what you have.`;
      } else if (deps) {
        try {
          const context = {
            group_folder: group_folder || 'unknown',
            task_id,
            conversation_id,
            run_id: options.run_id,
            trigger_source: options.trigger_source,
            permissions,
            current_agent_id: options.agent_id || modelId,
            signal: options.signal,
            memoryExecution: options.memoryExecution,
            allowedToolNames: executableToolNames,
          };
          toolResultText = await dispatchToolCall(
            name,
            callArgs,
            deps,
            context,
          );
        } catch (err: any) {
          toolResultText = `Error: ${err.message}`;
        }
      } else {
        toolResultText = 'Error: Tool execution unavailable (missing deps)';
      }
      lastToolResultText = toolResultText;
      if (repeatGuardEnabled && repeatKey !== undefined && !blockedRepeat) {
        const resultHash = sha256Hex(toolResultText);
        repeatStreak =
          repeatKey === lastRepeatKey && resultHash === lastRepeatResultHash
            ? repeatStreak + 1
            : 1;
        lastRepeatKey = repeatKey;
        lastRepeatResultHash = resultHash;
      }
      const toolResultIsError =
        blockedRepeat || /^Error:(?:\s|$)/i.test(toolResultText.trimStart());
      generatedArtifacts.push(
        ...extractGeneratedImageArtifacts(toolResultText),
      );

      // The tool may have run for seconds (e.g. agent_query). Re-check abort
      // before recording the result so a cancelled run doesn't keep looping.
      if (options.signal?.aborted) {
        abortDetected = true;
      }

      const toolResultFormatted = formatToolResult(
        toolResultText,
        toolResultIsError,
        toolCallId || undefined,
      );
      if (toolResultFormatted) {
        onChunk({ type: 'text', content: toolResultFormatted });
      }
      if (toolResultFormatted) {
        finalResultText += toolResultFormatted; // Include tool result in transcript
      }

      // Save tool result to transcript immediately using structured format
      if (onTranscriptEntry) {
        onTranscriptEntry({
          type: 'tool_use',
          part: {
            id: toolCallId || undefined,
            type: 'tool',
            tool: name,
            state: {
              status: toolResultIsError ? 'error' : 'completed',
              input: callArgs,
              output: toolResultText,
            },
          },
        });
      }

      const currentTotal = messages.reduce(
        (sum, m) => sum + estimateTokenCount(m),
        0,
      );
      const inputCapacity =
        maxContextTokens - outputReservation - estimateValueTokens(tools);
      const availTokensForTool = inputCapacity - currentTotal;
      const truncatedToolResultText = truncateToolResult(
        toolResultText,
        availTokensForTool,
      );

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: truncatedToolResultText,
      } as any);

      // Check for steering AFTER every tool execution
      const steeringStart = messages.length;
      if (await checkSteering()) {
        // Stop executing remaining tools in this turn and return to LLM. Every
        // declared call still needs an output, and the steering user message
        // must follow all of them: a user turn between a call and its outputs
        // makes the provider reject (or the budgeter drop) the whole unit.
        const steeringMessages = messages.splice(steeringStart);
        for (const skipped of toolCalls.slice(toolCalls.indexOf(tc) + 1)) {
          messages.push({
            role: 'tool',
            tool_call_id: skipped.id,
            content:
              'Error: Tool call skipped because the user sent a new message before it ran.',
          } as any);
        }
        messages.push(...steeringMessages);
        break;
      }
    }

    if (abortDetected) break;
    // A second blocked repeat in this run ends it like the turn limit: one
    // last request with `tool_choice: 'none'`, then the existing final-answer
    // path (dropped calls, "Stopped after N tool rounds..." fallback).
    if (repeatGuardEnabled && repeatedCallBlockedCount >= 2) {
      logger.warn(
        {
          group_folder,
          modelId,
          tool: lastRepeatBlockedTool,
          streak: repeatStreak,
        },
        'direct-llm repeated tool call stopped',
      );
      finalAnswerTurn = true;
      messages.push({
        role: 'user',
        content:
          'You kept repeating the same tool call with no new result. Do not call tools. Reply now in plain text: what you found, what is still missing, and why you stopped.',
      });
    }
    turnCount++;
  }

  // Individual turns are already logged to transcript via onTranscriptEntry inside the loop.

  return {
    result: finalResultText,
    tok_input: totalInputTokensCumulative,
    tok_output: totalOutputTokens,
    total_tokens: totalInputTokensCumulative + totalOutputTokens,
    tok_context_last: lastInputTokens,
    tok_cache_read: totalCachedInputTokens,
    tok_cache_write: totalCacheWriteTokens,
    tok_reasoning: totalReasoningTokens,
    model_name: responseModel,
    agentSuccess: true,
    session_id,
    generatedArtifacts: Array.from(
      new Map(
        generatedArtifacts.map((artifact) => [artifact.browserUrl, artifact]),
      ).values(),
    ),
  };
}

export async function runDirectLlm(
  systemPrompt: string,
  userMessage: string,
  modelId: string,
  onChunk: (chunk: ChunkData) => void,
  attachments: ChatMessageAttachment[] = [],
  history: ConversationMessage[] = [],
  options: DirectLlmOptions = {},
  deps?: McpServerDeps,
  onTranscriptEntry?: (entry: any) => void,
  session_id?: string,
  group_folder?: string,
  task_id?: string,
  permissions?: Record<string, string[]>,
  conversation_id?: string,
): Promise<DirectLlmResult> {
  const startMs = Date.now();

  if (!options.baseUrl) {
    throw new Error(
      `Direct LLM error: No baseUrl provided for model "${modelId}". Please ensure the agent is correctly configured in board_agents.jsonc.`,
    );
  }

  // Locality is judged from URLs only: a capacity fallback may send the same
  // content elsewhere, so it must be local too. The fallback hop is re-checked
  // with its own URL when it runs.
  const fallbackBaseUrl = options.fallback?.options.baseUrl;
  assertEgressAllowed({
    projectId: options.privacy?.projectId ?? group_folder,
    purpose: options.privacy?.purpose ?? 'unknown',
    locality:
      isLocalEndpoint(options.baseUrl) &&
      (!options.fallback ||
        (!!fallbackBaseUrl && isLocalEndpoint(fallbackBaseUrl)))
        ? 'local'
        : 'remote',
    target: egressTarget(options.baseUrl),
  });

  const openai = new OpenAI({
    apiKey: options.apiKey || 'sk-no-key-required',
    baseURL: options.baseUrl,
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  const historyToUse = [...history];
  if (
    historyToUse.length > 0 &&
    historyToUse[historyToUse.length - 1].role === 'user' &&
    historyToUse[historyToUse.length - 1].content === userMessage
  ) {
    historyToUse.pop();
  }

  // Keep Chat Completions compatible with llama.cpp/Qwen chat templates.
  // Responses keeps developer messages in their canonical position below.
  const normalizedHistory = prepareDirectLlmHistory(
    systemPrompt,
    historyToUse,
    options,
  );
  messages[0] = { role: 'system', content: normalizedHistory.systemPrompt };

  // Anthropic prompt cache: detect the cache-breakpoint marker in the
  // system prompt and, for Anthropic-compatible backends, split it
  // into a `cache_control`-tagged prefix block + a plain suffix block.
  // The result becomes the top-level `system` field on the request
  // body (Anthropic's canonical location for the system prompt), with
  // `messages[0]` blanked in `runOpenAiCompatible` so the two don't
  // collide. Built from the normalized prompt so system/developer
  // guidance folded from history (e.g. the public-visitor warning) lands
  // in the uncached suffix instead of being dropped; the prefix is
  // unchanged. Non-Anthropic backends leave the system in `messages[0]`.
  const anthropicSystemBlocks = buildAnthropicSystemBlocks(
    normalizedHistory.systemPrompt,
    options.baseUrl,
  );

  for (const msg of normalizedHistory.history) {
    if (msg.role === 'user') {
      const audioAttachments =
        msg.attachments?.filter((a) => a.type === 'audio' && a.path) ?? [];
      if (
        options.apiFormat === 'ollama' &&
        options.audio &&
        audioAttachments.length > 0
      ) {
        const images = await readOllamaAudioImages(audioAttachments);
        if (images.length > 0) {
          messages.push(
            buildOllamaAudioUserMessage(msg.content, images) as any,
          );
          continue;
        }
      }
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (msg.attachments?.length) {
        const multimodalParts = await buildMultimodalParts(
          msg.attachments,
          options,
        );
        parts.push(...multimodalParts);
      }
      parts.push({ type: 'text', text: msg.content });
      messages.push({ role: 'user', content: parts });
    } else if (msg.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      } as any);
    } else if (msg.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id!,
        content: msg.content || '',
      });
    } else if (msg.role === 'system') {
      messages.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'developer') {
      messages.push({ role: 'developer', content: msg.content } as any);
    }
  }

  // The canonical conversation must remain the shared cache prefix. Persona
  // guidance follows it and precedes only the transient current-turn prompt.
  if (
    options.developerInstructions?.trim() &&
    (directLlmWirePath(options) === 'responses' || isLlamaCppBackend(options))
  ) {
    messages.push({
      role: 'developer',
      content: options.developerInstructions.trim(),
    } as any);
  }

  const hasAudioAttachments =
    options.audio === true &&
    attachments.some((att) => att.type === 'audio' && att.path);
  const llmOptions = hasAudioAttachments
    ? {
        ...options,
        extra_body: ollamaAudioExtraBody(options.baseUrl, options.extra_body),
      }
    : options;

  const currentAudioImages =
    options.apiFormat === 'ollama' && hasAudioAttachments
      ? await readOllamaAudioImages(attachments)
      : [];

  if (currentAudioImages.length > 0) {
    messages.push(
      buildOllamaAudioUserMessage(userMessage, currentAudioImages) as any,
    );
  } else {
    const currentContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      [];
    const multimodalParts = await buildMultimodalParts(attachments, llmOptions);
    currentContent.push(...multimodalParts);
    currentContent.push({ type: 'text', text: userMessage });
    messages.push({ role: 'user', content: currentContent });
  }

  // Log the initial user message to the transcript to ensure correct sequence
  if (onTranscriptEntry && !options.skipInitialLog) {
    onTranscriptEntry({
      type: 'message',
      role: 'user',
      content: userMessage,
      sender_name: 'Web',
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  if (options.apiFormat === 'ollama' && currentAudioImages.length > 0) {
    const nativeMessages = messages.map((message: any) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((part: any) => part?.type === 'text')
                .map((part: any) => part.text)
                .join('\n')
            : '',
      ...(Array.isArray(message.images) && message.images.length > 0
        ? { images: message.images }
        : {}),
    }));
    const systemMessage = nativeMessages.find(
      (message) => message.role === 'system',
    );
    if (systemMessage) {
      systemMessage.content +=
        '\n\nThe current model supports native audio input. When a user message includes audio, listen to it and answer its meaning directly. Never claim that audio is unavailable and never ask the user to transcribe it.';
    }
    const text = await ollamaNativeChat({
      baseUrl: options.baseUrl,
      model: modelId,
      messages: nativeMessages,
      think: false,
      options: { num_ctx: 8192 },
      signal: options.signal,
    });
    if (text) {
      onChunk({ type: 'text', content: text });
      onTranscriptEntry?.({
        type: 'message',
        role: 'assistant',
        content: text,
      });
    }
    return {
      result: text,
      model_name: modelId,
      agentSuccess: Boolean(text),
      session_id,
      duration_ms: Date.now() - startMs,
    };
  }

  let emittedMeaningfulOutput = false;
  const guardedOnChunk = (chunk: ChunkData) => {
    if (chunk.type !== 'text' || Boolean(chunk.content))
      emittedMeaningfulOutput = true;
    onChunk(chunk);
  };
  await options.onStarted?.();
  const absorbedSteeringIds = new Set<string>();
  try {
    const res = await runOpenAiCompatible(
      openai,
      modelId,
      messages,
      guardedOnChunk,
      deps,
      onTranscriptEntry,
      session_id,
      group_folder,
      task_id,
      permissions,
      llmOptions,
      conversation_id,
      anthropicSystemBlocks,
      absorbedSteeringIds,
    );
    return { ...res, duration_ms: Date.now() - startMs };
  } catch (err: any) {
    if (
      options.fallback &&
      !emittedMeaningfulOutput &&
      isModelCapacityError(err)
    ) {
      const fallback = options.fallback;
      const fallbackUsesResponses = fallback.options.wireApi === 'responses';
      logger.warn(
        { modelId, fallbackModelId: fallback.modelId, err: err?.message },
        'DirectLLM model at capacity; retrying once with fallback model',
      );
      return runDirectLlm(
        !fallbackUsesResponses && options.developerInstructions
          ? `${systemPrompt}\n\n${options.developerInstructions}`
          : systemPrompt,
        userMessage,
        fallback.modelId,
        onChunk,
        attachments,
        history,
        {
          ...fallback.options,
          signal: options.signal,
          skipInitialLog: true,
          disableSteering: options.disableSteering,
          beforeSteeringComplete: options.beforeSteeringComplete,
          onSteeringAbsorbed: options.onSteeringAbsorbed,
          privacy: options.privacy,
          allowedToolNames: options.allowedToolNames,
          memoryExecution: options.memoryExecution,
          run_id: options.run_id,
          trigger_source: options.trigger_source,
          developerInstructions: fallbackUsesResponses
            ? options.developerInstructions
            : undefined,
          promptCacheKey: fallbackUsesResponses
            ? options.promptCacheKey
            : undefined,
        },
        deps,
        onTranscriptEntry,
        session_id,
        group_folder,
        task_id,
        permissions,
        conversation_id,
      );
    }
    // Only retry a turn that produced nothing: once output was emitted (tool
    // calls and results are streamed as output) a re-run would replay tool side
    // effects and duplicate the streamed text.
    if (
      ATTACHMENT_RETRY_STATUSES.has(err?.status) &&
      !emittedMeaningfulOutput &&
      attachments.length > 0 &&
      !hasAudioAttachments
    ) {
      logger.warn(
        { modelId, err: err.message },
        'Vision failed, retrying without attachments',
      );
      const textOnlyHistory = history.map((m) => ({ ...m, attachments: null }));
      return await runDirectLlm(
        systemPrompt,
        userMessage,
        modelId,
        onChunk,
        [],
        textOnlyHistory,
        { ...options, skipInitialLog: true },
        deps,
        onTranscriptEntry,
        session_id,
        group_folder,
        task_id,
        permissions,
        conversation_id,
      );
    }
    throw err;
  } finally {
    // Steered receipts release their ids as they are written; this covers a
    // turn that ended before writing one.
    if (group_folder && conversation_id) {
      releaseAbsorbedDirectSteering(
        group_folder,
        conversation_id,
        absorbedSteeringIds,
      );
    }
  }
}
