import { JEV_URL, MEMORY_CAPSULE_PLAN_TIMEOUT_MS } from '../../config.js';
import { jevSystemOneBatch } from '../../lib/jev-client.js';
import { llmComplete } from '../../lib/llm-client.js';
import { getMemoryConfig } from './config.js';

/**
 * Query planning for the memory capsule: a Jev gate decides whether recalling
 * stored memories could help at all, and a DirectLLM call proposes short
 * search queries so long or conversational prompts do not dilute recall.
 */

const PLAN_PROMPT_MAX_CHARS = 1_200;
const PLAN_TITLE_MAX_CHARS = 200;
const PLAN_QUERY_MAX_CHARS = 200;
const PLAN_MAX_QUERIES = 5;

/** Returns the expected gate score (0-2), or null when no answer is available. */
export type MemoryCapsuleGate = (
  prompt: string,
  context?: { groupFolder?: string },
) => Promise<number | null>;

/** Returns short search queries for the prompt; may throw on failure. */
export type MemoryCapsuleQueryPlanner = (
  prompt: string,
  context: { groupFolder: string; conversationTitle?: string },
) => Promise<string[]>;

const GATE_QUESTION = {
  type: 'score',
  instructions:
    'Would recalling stored project memories (decisions, preferences, facts, past incidents) materially help answer this request?',
  criteria: [
    'No: the request is self-contained or generic',
    'Maybe: stored context might help',
    'Yes: the answer likely depends on stored project context',
  ],
} as const;

/**
 * Ask Jev whether recalling memories would help. Returns null when Jev is not
 * configured; throws on Jev failure or a non-numeric answer.
 */
export const jevMemoryRecallGate: MemoryCapsuleGate = async (
  prompt,
  context,
) => {
  if (!JEV_URL) return null;
  const [result] = await jevSystemOneBatch({
    states: [`Request: ${prompt.slice(0, PLAN_PROMPT_MAX_CHARS)}`],
    questions: { recall: GATE_QUESTION },
    timeoutMs: MEMORY_CAPSULE_PLAN_TIMEOUT_MS,
    projectId: context?.groupFolder,
  });
  const score = result?.answers.recall?.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error('Jev returned a non-numeric recall gate score');
  }
  return score;
};

const QUERY_PLAN_SYSTEM_PROMPT = `You write search queries for a project memory store.
Given a user request (and optionally the conversation title), return 2 to 5 short, distinct search queries (2-6 words each) naming the topics, entities, and technical terms whose stored decisions, preferences, facts, or past incidents would help answer the request.
Resolve vague follow-ups using the conversation title when possible. Never answer the request itself.

Return only JSON in this exact shape: {"queries":["query one","query two"]}`;

/** Parse the planner's `{"queries":[...]}` response; null when it is unusable. */
function parseQueryPlan(raw: string): string[] | null {
  const normalized = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const attempts = [
    normalized,
    normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1],
  ];
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start >= 0 && end > start)
    attempts.push(normalized.slice(start, end + 1));
  for (const attempt of attempts) {
    if (!attempt) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }
    const queries = (parsed as { queries?: unknown } | null)?.queries;
    if (!Array.isArray(queries)) return null;
    const cleaned: string[] = [];
    for (const query of queries) {
      if (typeof query !== 'string') continue;
      const text = query
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PLAN_QUERY_MAX_CHARS);
      if (
        text &&
        !cleaned.some((c) => c.toLowerCase() === text.toLowerCase())
      ) {
        cleaned.push(text);
      }
    }
    return cleaned.length > 0 ? cleaned.slice(0, PLAN_MAX_QUERIES) : null;
  }
  return null;
}

/** Plan queries on the defaults.reflector DirectLLM runtime (same as the judge). */
export const llmMemoryQueryPlanner: MemoryCapsuleQueryPlanner = async (
  prompt,
  { groupFolder, conversationTitle },
) => {
  const response = await llmComplete(
    getMemoryConfig().reflector.llm,
    QUERY_PLAN_SYSTEM_PROMPT,
    JSON.stringify({
      request: prompt.slice(0, PLAN_PROMPT_MAX_CHARS),
      ...(conversationTitle
        ? {
            conversationTitle: conversationTitle.slice(0, PLAN_TITLE_MAX_CHARS),
          }
        : {}),
    }),
    {
      watchAgentsFile: false,
      allowedToolNames: [],
      groupFolder,
      temperatureOverride: 0,
      timeoutMs: MEMORY_CAPSULE_PLAN_TIMEOUT_MS,
      extraBodyOverride: {
        chat_template_kwargs: {
          enable_thinking: false,
          preserve_thinking: true,
        },
      },
    },
  );
  const queries = parseQueryPlan(response.content);
  if (!queries) throw new Error('Query planner returned no usable queries');
  return queries;
};
