import {
  deterministicCodexConversationId,
  mapCwdToProject,
  parseCodexSession,
  type ImportProject,
} from './codex-session-import.js';
import { calculateModelCostUsd } from '../../lib/model-pricing.js';
import { logger } from '../../logger.js';
import { escapeRegex } from '../../utils.js';
import type { ImportedTurn } from './native-run-v1.js';

type JsonObject = Record<string, any>;

type NativeSource =
  | 'claude-native'
  | 'codex-native'
  | 'codex-vscode'
  | 'gemini-native'
  | 'cursor-native'
  | 'vscode-native'
  | 'antigravity-native';

export interface ParsedNativeSession {
  sessionId: string;
  source: NativeSource;
  cwd: string | null;
  mappingKey: string | null;
  objectiveId: string | null;
  createdAt: string;
  isSubagent: boolean;
  boardOwnedHint: boolean;
  messages: JsonObject[];
  turns: ImportedTurn[];
  firstUserText: string | null;
  lastUserAt: string | null;
  lastAssistantAt: string | null;
}

const SYNTHETIC_PREFIXES = [
  '<recommended_plugins>',
  '<environment_context>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<apps_instructions>',
  '<plugins_instructions>',
  '<skills_instructions>',
  '<local-command-caveat>',
  '# AGENTS.md instructions for ',
  '[AGENT_CONTEXT:',
];

function isSynthetic(text: string): boolean {
  const value = text.trimStart();
  return (
    SYNTHETIC_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    value.includes('<system-reminder>') ||
    value.includes('<task-notification>')
  );
}

function isBoardOwnedEnvelope(text: string): boolean {
  return (
    text.includes('[AGENT_CONTEXT:') ||
    /\bgroup_folder=[^\s]+\s+task_id=task-/.test(text)
  );
}

function cleanText(text: string): string {
  return text
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>\s*/g, '')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>\s*/g, '')
    .replace(/<environment_details>[\s\S]*?<\/environment_details>\s*/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/g, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\s*/g, '')
    .trim();
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part) =>
        typeof part === 'string' ||
        part?.type === 'text' ||
        part?.type === 'input_text' ||
        part?.type === 'output_text',
    )
    .map((part) =>
      typeof part === 'string'
        ? part
        : typeof part?.text === 'string'
          ? part.text
          : '',
    )
    .join('');
}

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  source: NativeSource,
  createdAt: string,
  sessionId: string,
  turnId?: string,
): JsonObject {
  return {
    id,
    type: 'message',
    role,
    content,
    source,
    created_at: createdAt,
    external_session_id: sessionId,
    ...(turnId ? { external_turn_id: turnId } : {}),
  };
}

function telemetryEntry(
  messageId: string,
  telemetry: JsonObject,
  createdAt: string,
  sessionId: string,
  turnId: string,
): JsonObject {
  return {
    id: messageId,
    type: 'telemetry',
    role: 'assistant',
    telemetry,
    created_at: createdAt,
    external_session_id: sessionId,
    external_turn_id: turnId,
  };
}

function number(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

export function objectiveIdFromSandboxPath(cwd: string | null): string | null {
  if (!cwd) return null;
  const match = cwd
    .replace(/\\/g, '/')
    .match(/^\/workspace\/group\/objectives\/([^/]+)(?:\/|$)/);
  return match?.[1] || null;
}

export function parseClaudeSession(
  records: JsonObject[],
): ParsedNativeSession | null {
  const first = records.find((row) => typeof row?.sessionId === 'string');
  const sessionId = first?.sessionId;
  const cwd = records.find((row) => typeof row?.cwd === 'string')?.cwd;
  if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null;

  const source: NativeSource = 'claude-native';
  const createdAt =
    records.find((row) => typeof row?.timestamp === 'string')?.timestamp ||
    new Date(0).toISOString();
  const messages: JsonObject[] = [];
  const turns: ImportedTurn[] = [];
  const assistantStates = new Map<
    string,
    {
      id: string;
      text: string[];
      seenText: Set<string>;
      timestamp: string;
      model: string | null;
      usage: JsonObject;
    }
  >();
  const assistantOrder: string[] = [];
  let firstUserText: string | null = null;
  let lastUserAt: string | null = null;
  let lastAssistantAt: string | null = null;
  let boardOwnedHint = objectiveIdFromSandboxPath(cwd) !== null;

  for (const row of records) {
    if (row?.isSidechain === true) continue;
    const timestamp =
      typeof row?.timestamp === 'string' ? row.timestamp : createdAt;
    if (row?.type === 'user') {
      const text = cleanText(contentText(row.message?.content)).trim();
      if (
        text.startsWith('[AGENT_CONTEXT:') ||
        /\bgroup_folder=[^\s]+\s+task_id=task-/.test(text)
      ) {
        boardOwnedHint = true;
      }
      if (!text || isSynthetic(text)) continue;
      const id =
        typeof row.uuid === 'string'
          ? row.uuid
          : `claude-${sessionId}-user-${messages.length + 1}`;
      messages.push(message(id, 'user', text, source, timestamp, sessionId));
      firstUserText ??= text;
      lastUserAt = timestamp;
      continue;
    }
    if (row?.type !== 'assistant') continue;
    const id =
      typeof row.message?.id === 'string'
        ? row.message.id
        : typeof row.uuid === 'string'
          ? row.uuid
          : `claude-${sessionId}-assistant-${assistantOrder.length + 1}`;
    let state = assistantStates.get(id);
    if (!state) {
      state = {
        id,
        text: [],
        seenText: new Set(),
        timestamp,
        model:
          typeof row.message?.model === 'string' ? row.message.model : null,
        usage: {},
      };
      assistantStates.set(id, state);
      assistantOrder.push(id);
    }
    const text = cleanText(contentText(row.message?.content)).trim();
    if (text && !isSynthetic(text) && !state.seenText.has(text)) {
      state.text.push(text);
      state.seenText.add(text);
      state.timestamp = timestamp;
    }
    if (typeof row.message?.model === 'string') state.model = row.message.model;
    if (row.message?.usage && typeof row.message.usage === 'object') {
      for (const [key, value] of Object.entries(row.message.usage)) {
        if (Number.isFinite(value))
          state.usage[key] = Math.max(number(state.usage[key]), number(value));
      }
    }
  }

  for (const id of assistantOrder) {
    const state = assistantStates.get(id)!;
    const text = state.text.join('\n').trim();
    const turnId = id;
    // Tool-use-only and thinking-only API calls have no text but still bill
    // tokens: they become telemetry-only turns.
    if (text) {
      messages.push(
        message(
          id,
          'assistant',
          text,
          source,
          state.timestamp,
          sessionId,
          turnId,
        ),
      );
      lastAssistantAt = state.timestamp;
    }
    const tokInput = number(state.usage.input_tokens);
    const tokOutput = number(state.usage.output_tokens);
    const tokCacheRead = number(state.usage.cache_read_input_tokens);
    const tokCacheWrite = number(state.usage.cache_creation_input_tokens);
    const hasUsage = Object.values(state.usage).some((value) =>
      Number.isFinite(value),
    );
    // Anthropic reports fresh input, cache reads and cache writes separately.
    const costUsd = hasUsage
      ? calculateModelCostUsd(state.model, {
          inputTokens: tokInput,
          cachedInputTokens: tokCacheRead,
          cacheWriteTokens: tokCacheWrite,
          outputTokens: tokOutput,
        })
      : null;
    const telemetry =
      hasUsage || state.model
        ? {
            tok_input: tokInput,
            tok_output: tokOutput,
            tok_cache_read: tokCacheRead,
            tok_cache_write: tokCacheWrite,
            total_tokens: tokInput + tokOutput,
            model_name: state.model,
            external_session_id: sessionId,
            external_turn_id: turnId,
            usageSource: 'reported',
            cost_estimated: costUsd != null,
            cost_source: 'model-pricing',
            ...(costUsd != null ? { cost_usd: costUsd } : {}),
          }
        : null;
    turns.push({
      turnId,
      startedAt: state.timestamp,
      completedAt: state.timestamp,
      modelName: state.model,
      telemetry,
    });
    if (telemetry)
      messages.push(
        telemetryEntry(id, telemetry, state.timestamp, sessionId, turnId),
      );
  }

  messages.sort((a, b) => {
    const timestampOrder = String(a.created_at).localeCompare(
      String(b.created_at),
    );
    if (timestampOrder) return timestampOrder;
    if (a.type === b.type) return 0;
    return a.type === 'message' ? -1 : 1;
  });
  return {
    sessionId,
    source,
    cwd,
    mappingKey: null,
    objectiveId: objectiveIdFromSandboxPath(cwd),
    createdAt,
    isSubagent: false,
    boardOwnedHint,
    messages,
    turns,
    firstUserText,
    lastUserAt,
    lastAssistantAt,
  };
}

export function parseGeminiSession(
  data: JsonObject,
  projectHash: string,
): ParsedNativeSession | null {
  const sessionId = data?.sessionId;
  if (typeof sessionId !== 'string' || !Array.isArray(data.messages))
    return null;
  const source: NativeSource = 'gemini-native';
  const createdAt =
    typeof data.startTime === 'string'
      ? data.startTime
      : data.messages.find(
          (item: JsonObject) => typeof item?.timestamp === 'string',
        )?.timestamp || new Date(0).toISOString();
  const messages: JsonObject[] = [];
  const turns: ImportedTurn[] = [];
  let firstUserText: string | null = null;
  let lastUserAt: string | null = null;
  let lastAssistantAt: string | null = null;
  let boardOwnedHint = false;

  for (const item of data.messages) {
    const role =
      item?.type === 'user'
        ? 'user'
        : item?.type === 'gemini'
          ? 'assistant'
          : null;
    if (!role) continue;
    const text = cleanText(contentText(item.content)).trim();
    if (
      role === 'user' &&
      (text.startsWith('[AGENT_CONTEXT:') ||
        /\bgroup_folder=[^\s]+\s+task_id=task-/.test(text))
    ) {
      boardOwnedHint = true;
    }
    if (!text || isSynthetic(text)) continue;
    const timestamp =
      typeof item.timestamp === 'string' ? item.timestamp : createdAt;
    const id =
      typeof item.id === 'string'
        ? item.id
        : `gemini-${sessionId}-${messages.length + 1}`;
    if (role === 'user') {
      messages.push(message(id, role, text, source, timestamp, sessionId));
      firstUserText ??= text;
      lastUserAt = timestamp;
      continue;
    }
    const turnId = id;
    messages.push(
      message(id, role, text, source, timestamp, sessionId, turnId),
    );
    lastAssistantAt = timestamp;
    const tokens =
      item.tokens && typeof item.tokens === 'object' ? item.tokens : null;
    const modelName = typeof item.model === 'string' ? item.model : null;
    const tokInput = number(tokens?.input);
    const tokOutput = number(tokens?.output);
    const tokCacheRead = number(tokens?.cached);
    const tokReasoning = number(tokens?.thoughts);
    const hasUsage = Boolean(tokens);
    // Gemini counts thinking tokens apart from output but bills them as output.
    const costUsd = hasUsage
      ? calculateModelCostUsd(modelName, {
          inputTokens: Math.max(0, tokInput - tokCacheRead),
          cachedInputTokens: tokCacheRead,
          outputTokens: tokOutput + tokReasoning,
        })
      : null;
    const telemetry =
      hasUsage || modelName
        ? {
            tok_input: tokInput,
            tok_output: tokOutput,
            tok_cache_read: tokCacheRead,
            tok_reasoning: tokReasoning,
            total_tokens: number(tokens?.total) || tokInput + tokOutput,
            model_name: modelName,
            external_session_id: sessionId,
            external_turn_id: turnId,
            usageSource: 'reported',
            cost_estimated: costUsd != null,
            cost_source: 'model-pricing',
            ...(costUsd != null ? { cost_usd: costUsd } : {}),
          }
        : null;
    turns.push({
      turnId,
      startedAt: timestamp,
      completedAt: timestamp,
      modelName,
      telemetry,
    });
    if (telemetry)
      messages.push(
        telemetryEntry(id, telemetry, timestamp, sessionId, turnId),
      );
  }

  return {
    sessionId,
    source,
    cwd: null,
    mappingKey: `gemini-hash:${projectHash}`,
    objectiveId: null,
    createdAt,
    isSubagent: false,
    boardOwnedHint,
    messages,
    turns,
    firstUserText,
    lastUserAt,
    lastAssistantAt,
  };
}

function cursorSessionFromBlocks(
  blocks: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp?: string;
  }>,
  sessionId: string,
  projectFolder: string,
  modifiedAt: string,
  boardOwnedHint = false,
): ParsedNativeSession {
  const source: NativeSource = 'cursor-native';
  const messages = blocks.map((block, index) =>
    message(
      `cursor-${sessionId}-${index + 1}`,
      block.role,
      block.text,
      source,
      block.timestamp || modifiedAt,
      sessionId,
      block.role === 'assistant' ? `turn-${index + 1}` : undefined,
    ),
  );
  const firstUser = blocks.find((block) => block.role === 'user');
  const lastUser = blocks.filter((block) => block.role === 'user').at(-1);
  const lastAssistant = blocks
    .filter((block) => block.role === 'assistant')
    .at(-1);
  return {
    sessionId,
    source,
    cwd: null,
    mappingKey: `cursor-project:${projectFolder}`,
    objectiveId: null,
    createdAt: blocks[0]?.timestamp || modifiedAt,
    isSubagent: false,
    boardOwnedHint:
      boardOwnedHint ||
      blocks.some((block) => isBoardOwnedEnvelope(block.text)),
    messages,
    turns: [],
    firstUserText: firstUser?.text || null,
    lastUserAt: lastUser?.timestamp || (lastUser ? modifiedAt : null),
    lastAssistantAt:
      lastAssistant?.timestamp || (lastAssistant ? modifiedAt : null),
  };
}

export function parseCursorSession(
  raw: string,
  sessionId: string,
  projectFolder: string,
  modifiedAt: string,
): ParsedNativeSession | null {
  if (!sessionId || !projectFolder) return null;
  const blocks: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let boardOwnedHint = false;
  let role: 'user' | 'assistant' | null = null;
  let text = '';
  const flush = () => {
    const value = cleanText(text).trim();
    if (role === 'user' && isBoardOwnedEnvelope(value)) boardOwnedHint = true;
    if (role && value && !isSynthetic(value))
      blocks.push({ role, text: value });
    text = '';
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith('user:') || /^<user_query>/.test(line)) {
      flush();
      role = 'user';
      text = line.replace(/^user:\s*/, '').replace(/<\/?user_query>/g, '');
    } else if (line.startsWith('A:') || line.startsWith('assistant:')) {
      flush();
      role = 'assistant';
      text = line.replace(/^A:\s*/, '').replace(/^assistant:\s*/, '');
    } else {
      text += `${text ? '\n' : ''}${line}`;
    }
  }
  flush();

  return cursorSessionFromBlocks(
    blocks,
    sessionId,
    projectFolder,
    modifiedAt,
    boardOwnedHint,
  );
}

/** Cursor 0.50+ stores agent transcripts as one message object per JSONL row. */
export function parseCursorJsonlSession(
  records: JsonObject[],
  sessionId: string,
  projectFolder: string,
  modifiedAt: string,
): ParsedNativeSession | null {
  if (!sessionId || !projectFolder) return null;
  const blocks: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp?: string;
  }> = [];
  let boardOwnedHint = false;
  for (const row of records) {
    const candidate =
      row?.message && typeof row.message === 'object' ? row.message : row;
    const recordRole = row?.role ?? candidate?.role;
    const role =
      recordRole === 'user'
        ? 'user'
        : recordRole === 'assistant'
          ? 'assistant'
          : null;
    if (!role) continue;
    const text = cleanText(contentText(candidate.content ?? candidate)).trim();
    if (role === 'user' && isBoardOwnedEnvelope(text)) boardOwnedHint = true;
    if (!text || isSynthetic(text)) continue;
    blocks.push({
      role,
      text,
      timestamp:
        typeof candidate.timestamp === 'string'
          ? candidate.timestamp
          : typeof row.timestamp === 'string'
            ? row.timestamp
            : undefined,
    });
  }
  return cursorSessionFromBlocks(
    blocks,
    sessionId,
    projectFolder,
    modifiedAt,
    boardOwnedHint,
  );
}

/** Parse VS Code/Copilot's workspaceStorage chatSessions JSON format. */
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Rebuild a VS Code chat session from its append-only `.jsonl` log. Line 0 is a
 * full snapshot; later lines edit it: kind 1 sets the value at path `k`, kind 2
 * appends items `v` to the array at `k` (first truncating it to `i` when given),
 * kind 3 deletes the key at `k`. Unparseable or unrecognized lines are ignored.
 */
export function replayVscodeSessionLog(records: JsonObject[]): JsonObject {
  let state: JsonObject = {};
  for (const record of records) {
    if (record?.kind === 0) {
      state = record.v && typeof record.v === 'object' ? record.v : {};
      continue;
    }
    const path: Array<string | number> = Array.isArray(record?.k)
      ? record.k
      : [];
    if (path.length === 0 || ![1, 2, 3].includes(record?.kind)) continue;
    // Key paths come from a local file: never walk or write prototype keys.
    if (path.some((key) => UNSAFE_PATH_KEYS.has(String(key)))) {
      logger.warn(
        { kind: record.kind },
        'Skipping VS Code session log record with an unsafe key path',
      );
      continue;
    }
    let parent: any = state;
    for (const key of path.slice(0, -1)) {
      if (parent == null || typeof parent !== 'object') break;
      parent = parent[key];
    }
    if (parent == null || typeof parent !== 'object') continue;
    const last = path[path.length - 1];
    if (record.kind === 1) parent[last] = record.v;
    else if (record.kind === 3) delete parent[last];
    else if (Array.isArray(record.v)) {
      if (!Array.isArray(parent[last])) parent[last] = [];
      if (Number.isInteger(record.i)) parent[last].length = record.i;
      parent[last].push(...record.v);
    }
  }
  return state;
}

export function parseVscodeSession(
  data: JsonObject,
  workspaceKey: string,
  cwd: string | null,
): ParsedNativeSession | null {
  const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  if (!sessionId || requests.length === 0) return null;

  const source: NativeSource = 'vscode-native';
  const fallbackCreatedAt = Number.isFinite(data?.creationDate)
    ? new Date(data.creationDate).toISOString()
    : new Date(0).toISOString();
  const lastMessageAt = Number.isFinite(data?.lastMessageDate)
    ? new Date(data.lastMessageDate).toISOString()
    : fallbackCreatedAt;
  const messages: JsonObject[] = [];
  let firstUserText: string | null = null;
  let lastUserAt: string | null = null;
  let lastAssistantAt: string | null = null;
  let boardOwnedHint = false;

  for (const [index, request] of requests.entries()) {
    const requestAt = Number.isFinite(request?.timestamp)
      ? new Date(request.timestamp).toISOString()
      : fallbackCreatedAt;
    const userText = cleanText(
      typeof request?.message?.text === 'string'
        ? request.message.text
        : contentText(request?.message?.parts),
    ).trim();
    if (isBoardOwnedEnvelope(userText)) boardOwnedHint = true;
    if (userText && !isSynthetic(userText)) {
      messages.push(
        message(
          `vscode-${sessionId}-user-${index + 1}`,
          'user',
          userText,
          source,
          requestAt,
          sessionId,
        ),
      );
      firstUserText ??= userText;
      lastUserAt = requestAt;
    }

    const assistantText = (
      Array.isArray(request?.response) ? request.response : []
    )
      .filter(
        (part: JsonObject) =>
          part && typeof part.value === 'string' && !part.kind,
      )
      .map((part: JsonObject) => part.value)
      .join('')
      .trim();
    if (!assistantText || isSynthetic(assistantText)) continue;
    const nextTimestamp = requests[index + 1]?.timestamp;
    // Newer `.jsonl` sessions carry no lastMessageDate; the reply's own
    // completion time keeps the final answer after its question.
    const completedAt = [
      request?.modelState?.completedAt,
      request?.responseTimestamp,
    ].find((value) => Number.isFinite(value));
    const assistantAt = Number.isFinite(nextTimestamp)
      ? new Date(
          Math.max(request.timestamp || 0, nextTimestamp - 1),
        ).toISOString()
      : index === requests.length - 1
        ? new Date(
            Math.max(
              Date.parse(lastMessageAt),
              Date.parse(requestAt),
              completedAt ?? 0,
            ),
          ).toISOString()
        : requestAt;
    const turnId =
      typeof request?.responseId === 'string'
        ? request.responseId
        : typeof request?.requestId === 'string'
          ? request.requestId
          : `turn-${index + 1}`;
    messages.push(
      message(
        `vscode-${sessionId}-assistant-${index + 1}`,
        'assistant',
        assistantText,
        source,
        assistantAt,
        sessionId,
        turnId,
      ),
    );
    lastAssistantAt = assistantAt;
  }

  return {
    sessionId,
    source,
    cwd,
    mappingKey: cwd ? null : `vscode-workspace:${workspaceKey}`,
    objectiveId: cwd ? objectiveIdFromSandboxPath(cwd) : null,
    createdAt: fallbackCreatedAt,
    isSubagent: false,
    boardOwnedHint,
    messages,
    turns: [],
    firstUserText,
    lastUserAt,
    lastAssistantAt,
  };
}

/** Parse the structured response returned by Antigravity's GetCascadeTrajectory RPC. */
export function parseAntigravitySession(
  data: JsonObject,
): ParsedNativeSession | null {
  const trajectory = data?.trajectory;
  const sessionId =
    typeof trajectory?.cascadeId === 'string' ? trajectory.cascadeId : '';
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
  if (!sessionId || steps.length === 0) return null;

  const source: NativeSource = 'antigravity-native';
  const blocks: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
    turnId?: string;
  }> = [];
  let boardOwnedHint = false;

  for (const [index, step] of steps.entries()) {
    const createdAt =
      typeof step?.metadata?.createdAt === 'string'
        ? step.metadata.createdAt
        : typeof trajectory?.metadata?.createdAt === 'string'
          ? trajectory.metadata.createdAt
          : new Date(0).toISOString();
    if (step?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const text = cleanText(step?.userInput?.userResponse || '').trim();
      if (isBoardOwnedEnvelope(text)) boardOwnedHint = true;
      if (text && !isSynthetic(text))
        blocks.push({ role: 'user', text, timestamp: createdAt });
      continue;
    }
    if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const text = cleanText(
        step?.plannerResponse?.modifiedResponse ||
          step?.plannerResponse?.response ||
          '',
      ).trim();
      if (!text || isSynthetic(text)) continue;
      blocks.push({
        role: 'assistant',
        text,
        timestamp:
          typeof step?.metadata?.completedAt === 'string'
            ? step.metadata.completedAt
            : createdAt,
        turnId:
          typeof step?.metadata?.executionId === 'string'
            ? step.metadata.executionId
            : `step-${index + 1}`,
      });
    }
  }

  let cwd: string | null = null;
  const workspaceUri = trajectory?.metadata?.workspaces?.find?.(
    (workspace: JsonObject) =>
      typeof workspace?.workspaceFolderAbsoluteUri === 'string',
  )?.workspaceFolderAbsoluteUri;
  if (typeof workspaceUri === 'string' && workspaceUri.startsWith('file://')) {
    try {
      cwd = decodeURIComponent(new URL(workspaceUri).pathname);
    } catch {}
  }

  const messages = blocks.map((block, index) =>
    message(
      `antigravity-${sessionId}-${index + 1}`,
      block.role,
      block.text,
      source,
      block.timestamp,
      sessionId,
      block.role === 'assistant' ? block.turnId : undefined,
    ),
  );
  const firstUser = blocks.find((block) => block.role === 'user');
  const lastUser = blocks.filter((block) => block.role === 'user').at(-1);
  const lastAssistant = blocks
    .filter((block) => block.role === 'assistant')
    .at(-1);
  return {
    sessionId,
    source,
    cwd,
    mappingKey: null,
    objectiveId: cwd ? objectiveIdFromSandboxPath(cwd) : null,
    createdAt:
      typeof trajectory?.metadata?.createdAt === 'string'
        ? trajectory.metadata.createdAt
        : blocks[0]?.timestamp || new Date(0).toISOString(),
    isSubagent: trajectory?.trajectoryType !== 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    boardOwnedHint,
    messages,
    turns: [],
    firstUserText: firstUser?.text || null,
    lastUserAt: lastUser?.timestamp || null,
    lastAssistantAt: lastAssistant?.timestamp || null,
  };
}

export function deterministicNativeConversationId(
  provider: 'claude' | 'codex' | 'gemini' | 'cursor' | 'vscode' | 'antigravity',
  sessionId: string,
): string {
  if (provider === 'codex') return deterministicCodexConversationId(sessionId);
  return `conv-${provider}-${sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}

/**
 * Resolve a project-map key: an exact entry wins, otherwise the most specific
 * matching `*` pattern (`*` matches any characters, including `/`). Equally
 * specific patterns that name different projects are ambiguous.
 */
export function resolveProjectMapping(
  map: Map<string, string>,
  key: string,
): { projectId: string | null; ambiguous: boolean } {
  const exact = map.get(key);
  if (exact) return { projectId: exact, ambiguous: false };
  let bestLength = -1;
  let matches = new Set<string>();
  for (const [pattern, projectId] of map) {
    if (!pattern.includes('*')) continue;
    const regex = new RegExp(
      `^${pattern.split('*').map(escapeRegex).join('.*')}$`,
    );
    if (!regex.test(key)) continue;
    const specificity = pattern.replace(/\*/g, '').length;
    if (specificity > bestLength) {
      bestLength = specificity;
      matches = new Set([projectId]);
    } else if (specificity === bestLength) matches.add(projectId);
  }
  if (matches.size > 1) return { projectId: null, ambiguous: true };
  return { projectId: [...matches][0] ?? null, ambiguous: false };
}

export { mapCwdToProject, parseCodexSession };
export type { ImportProject };
