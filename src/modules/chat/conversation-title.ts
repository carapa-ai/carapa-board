import { randomUUID } from 'node:crypto';
import {
  readChatTranscript,
  appendChatTranscriptEntry,
} from '../../group-dir.js';
import {
  getConversation,
  updateConversationTitleIfUntitled,
} from './db-chats.js';
import { formatTranscriptEntries } from '../transcripts/transcript-store.js';
import {
  getChatAgents,
  getDefaultRuntimeSelection,
  directRuntimeBaseUrl,
  isDirectRuntime,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import { calculateModelCostUsd } from '../../lib/model-pricing.js';
import {
  canStartBackgroundWork,
  trackBackgroundWork,
} from '../../lib/background-work-gate.js';
import { logger } from '../../logger.js';
import { runDirectLlm } from './direct-llm.js';
import { broadcastConversationEvent } from './conversation-scope.js';

const MAX_TITLE_CONTEXT_MESSAGES = 12;
const MAX_TITLE_CONTEXT_CHARS = 12_000;
const MAX_TITLE_CHARS = 120;
// Headroom for models that still reason at their lowest effort; the title
// itself is clamped to MAX_TITLE_CHARS.
const MAX_TITLE_OUTPUT_TOKENS = 1024;
// Lowest-effort reasoning labels, most preferred first.
const LOW_REASONING_OPTIONS = ['none', 'off', 'minimal', 'low'];

function selectTitleAgent():
  | ReturnType<typeof getChatAgents>[number]
  | undefined {
  const agent = findTitleAgent();
  if (!agent?.harnessId || !agent.modelId) return agent;
  // Titles need no deliberation: request the binding's lowest reasoning level
  // so its reasoning map (and llama.cpp enable_thinking) is applied.
  const reasoning = LOW_REASONING_OPTIONS.find((option) =>
    agent.reasoningOptions?.includes(option),
  );
  return resolveRuntimeSelection({
    harnessId: agent.harnessId,
    modelId: agent.modelId,
    ...(reasoning ? { reasoning } : {}),
  });
}

function findTitleAgent():
  | ReturnType<typeof getChatAgents>[number]
  | undefined {
  const selection = getDefaultRuntimeSelection('chat');
  const agents = getChatAgents();
  const exact = agents.find(
    (agent) =>
      agent.harnessId === selection.harnessId &&
      agent.modelId === selection.modelId &&
      agent.model &&
      isDirectRuntime(agent) &&
      directRuntimeBaseUrl(agent),
  );
  if (exact) return exact;
  return agents.find(
    (agent) =>
      agent.modelId === selection.modelId &&
      agent.model &&
      isDirectRuntime(agent) &&
      directRuntimeBaseUrl(agent),
  );
}

function conversationTitleContext(
  groupFolder: string,
  conversationId: string,
): string {
  const rawEntries = readChatTranscript(groupFolder, conversationId);
  const formatted = formatTranscriptEntries(rawEntries) as Array<{
    type?: string;
    role?: string;
    content?: string;
  }>;
  const messages = formatted
    .filter(
      (entry) =>
        entry.type === 'message' &&
        (entry.role === 'user' || entry.role === 'assistant') &&
        typeof entry.content === 'string' &&
        entry.content.trim(),
    )
    .slice(-MAX_TITLE_CONTEXT_MESSAGES);

  const lines: string[] = [];
  let used = 0;
  for (const entry of [...messages].reverse()) {
    const label = entry.role === 'user' ? 'User' : 'Assistant';
    const normalized = entry.content!.replace(/\s+/g, ' ').trim();
    const remaining = MAX_TITLE_CONTEXT_CHARS - used - label.length - 3;
    if (remaining <= 0) break;
    const content =
      normalized.length > remaining
        ? `${normalized.slice(0, Math.max(0, remaining - 1))}…`
        : normalized;
    lines.unshift(`${label}: ${content}`);
    used += label.length + content.length + 3;
  }
  return lines.join('\n');
}

function normalizeConversationTitle(value: string): string {
  return value
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/, 1)[0]
    .replace(/^title:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

/** Generate a title using the same internal chat runtime as explicit naming. */
export async function generateConversationTitle(
  groupFolder: string,
  conversationId: string,
): Promise<string> {
  const context = conversationTitleContext(groupFolder, conversationId);
  if (!context) throw new Error('Conversation has no messages to name');

  const agentConfig = selectTitleAgent();
  if (!agentConfig?.model) {
    throw new Error('The global chat default has no HTTP-capable binding');
  }

  const response = await runDirectLlm(
    'You create concise, specific conversation titles from chat transcripts.',
    `Name the conversation based on its main topic and current intent.\n\nConversation:\n${context}\n\nRules:\n- Use 3 to 7 words\n- Be specific and descriptive\n- Describe the subject, not the participants or the act of chatting\n- Do not use generic titles such as "Conversation", "Discussion", or "Help request"\n- Reply with ONLY the title, without quotes or punctuation around it`,
    agentConfig.model,
    () => {},
    [],
    [],
    {
      wireApi: agentConfig.wireApi,
      reasoning_effort: agentConfig.reasoning_effort,
      extra_body: agentConfig.extra_body,
      temperature: 0.2,
      max_tokens: MAX_TITLE_OUTPUT_TOKENS,
      skipInitialLog: true,
      baseUrl: directRuntimeBaseUrl(agentConfig),
      apiKey:
        agentConfig.apiKey ||
        agentConfig.env?.OPENAI_API_KEY ||
        agentConfig.env?.ANTHROPIC_API_KEY,
      agent_id: agentConfig.id,
      privacy: { projectId: groupFolder, purpose: 'helper' },
    },
  );
  const modelName = response.model_name || agentConfig.model;
  const cachedInputTokens = response.tok_cache_read ?? 0;
  const costUsd = calculateModelCostUsd(modelName, {
    inputTokens: Math.max(0, (response.tok_input ?? 0) - cachedInputTokens),
    cachedInputTokens,
    cacheWriteTokens: response.tok_cache_write,
    outputTokens: response.tok_output,
  });
  appendChatTranscriptEntry(groupFolder, conversationId, {
    id: `conversation-rename-${randomUUID()}`,
    type: 'conversation_cost',
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    conversation_id: conversationId,
    telemetry: {
      operation: 'conversation_rename',
      tok_input: response.tok_input,
      tok_output: response.tok_output,
      total_tokens: response.total_tokens,
      tok_context_last: response.tok_context_last,
      tok_cache_read: response.tok_cache_read,
      tok_cache_write: response.tok_cache_write,
      tok_reasoning: response.tok_reasoning,
      duration_ms: response.duration_ms,
      model_name: modelName,
      cost_usd: costUsd,
      context_size: agentConfig.context_size,
    },
  });
  const title = normalizeConversationTitle(response.result || '');
  if (!title) throw new Error('Agent returned an empty conversation title');
  return title;
}

const inFlightConversationTitles = new Map<string, Promise<boolean>>();

/** Name a source conversation once, without racing a manual rename. */
export async function nameConversationIfUntitled(
  groupFolder: string,
  conversationId: string,
): Promise<boolean> {
  const key = `${groupFolder}\0${conversationId}`;
  const existing = inFlightConversationTitles.get(key);
  if (existing) return existing;

  const operation = trackBackgroundWork('title job', async () => {
    const conversation = await getConversation(conversationId);
    if (
      !conversation ||
      conversation.group_folder !== groupFolder ||
      (typeof conversation.title === 'string' && conversation.title.trim())
    ) {
      return false;
    }
    const title = await generateConversationTitle(groupFolder, conversationId);
    const saved = await updateConversationTitleIfUntitled(
      conversationId,
      groupFolder,
      title,
    );
    if (saved) {
      broadcastConversationEvent(
        { type: 'conversations_changed', payload: { folder: groupFolder } },
        groupFolder,
        conversation.objective_id ?? undefined,
      );
    }
    return saved;
  });
  inFlightConversationTitles.set(key, operation);
  try {
    return await operation;
  } finally {
    if (inFlightConversationTitles.get(key) === operation) {
      inFlightConversationTitles.delete(key);
    }
  }
}

/**
 * Fire-and-forget naming after a completed chat turn. Skips while background
 * work is paused and never throws, so it cannot change the turn outcome.
 */
export function nameConversationInBackground(
  groupFolder: string,
  conversationId: string,
): void {
  if (!canStartBackgroundWork()) return;
  void nameConversationIfUntitled(groupFolder, conversationId).catch(
    (error) => {
      logger.warn(
        { error, group_folder: groupFolder, conversation_id: conversationId },
        'Automatic conversation title generation failed',
      );
    },
  );
}
