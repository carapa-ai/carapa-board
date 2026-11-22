import path from 'node:path';
import fs from 'node:fs';
import { calculateModelCostUsd } from '../../lib/model-pricing.js';
import type { ImportedTurn } from './native-run-v1.js';

type JsonObject = Record<string, any>;

export interface ImportProject {
  id: string;
  folder?: string;
  repositoryLocation: string;
}

export interface ParsedCodexSession {
  sessionId: string;
  /** Native name from the session index, when loaded alongside the rollout. */
  title?: string;
  source: 'codex-native' | 'codex-vscode';
  cwd: string;
  createdAt: string;
  isSubagent: boolean;
  boardOwnedHint: boolean;
  messages: JsonObject[];
  turns: ImportedTurn[];
  firstUserText: string | null;
  lastUserAt: string | null;
  lastAssistantAt: string | null;
}

/** Newer Codex versions write turn `started_at`/`completed_at` as Unix
 * seconds. Stored run times must be ISO strings: reports compare them as text. */
function isoTime(value: unknown, fallback: string): string {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : null;
  if (seconds !== null && Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return typeof value === 'string' && value ? value : fallback;
}

/** The append-only index records renames; the last valid name wins. */
export async function loadCodexTitles(
  file: string,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (
          typeof row?.id === 'string' &&
          typeof row.thread_name === 'string' &&
          row.thread_name.trim()
        ) {
          titles.set(row.id.toLowerCase(), row.thread_name.trim());
        }
      } catch {}
    }
  } catch {
    // Names are optional: unavailable metadata must not prevent an import.
  }
  return titles;
}

export { nativeSessionToCarapaRunV1 as codexSessionToCarapaRunV1 } from './native-run-v1.js';

const SYNTHETIC_USER_PREFIXES = [
  '<recommended_plugins>',
  '<environment_context>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<apps_instructions>',
  '<plugins_instructions>',
  '<skills_instructions>',
  '# AGENTS.md instructions for ',
  '[AGENT_CONTEXT:',
];

function textContent(payload: JsonObject): string {
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .filter(
      (part: JsonObject) =>
        part?.type === 'input_text' || part?.type === 'output_text',
    )
    .map((part: JsonObject) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

export function isSyntheticCodexUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function nonNegativeDelta(
  current: number | undefined,
  previous: number,
): number {
  if (!Number.isFinite(current)) return 0;
  return Math.max(0, Number(current) - previous);
}

export function parseCodexSession(
  records: JsonObject[],
): ParsedCodexSession | null {
  const meta = records.find(
    (record) => record?.type === 'session_meta',
  )?.payload;
  const sessionId = meta?.session_id || meta?.id;
  if (typeof sessionId !== 'string' || typeof meta?.cwd !== 'string')
    return null;
  const sourceValue = meta.source;
  const isSubagent =
    (sourceValue !== null && typeof sourceValue === 'object') ||
    (meta.thread_source != null && meta.thread_source !== 'user');
  const source =
    sourceValue === 'vscode' || meta.originator === 'codex_vscode'
      ? 'codex-vscode'
      : 'codex-native';
  let boardOwnedHint =
    typeof meta.originator === 'string' &&
    meta.originator.startsWith('carapa-');
  const createdAt =
    typeof meta.timestamp === 'string'
      ? meta.timestamp
      : records[0]?.timestamp || new Date(0).toISOString();

  const turnStates = new Map<
    string,
    {
      turnId: string;
      startedAt: string;
      completedAt: string | null;
      modelName: string | null;
      finalUsage: JsonObject | null;
      contextWindow: number | null;
      durationMs: number | null;
      lastAssistantMessageId: string | null;
    }
  >();
  const turnOrder: string[] = [];
  const messages: JsonObject[] = [];
  let activeTurnId: string | null = null;
  let firstUserText: string | null = null;
  let lastUserAt: string | null = null;
  let lastAssistantAt: string | null = null;

  for (const record of records) {
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const timestamp =
      typeof record.timestamp === 'string' ? record.timestamp : createdAt;

    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = String(payload.turn_id || `turn-${turnOrder.length + 1}`);
      activeTurnId = turnId;
      if (!turnStates.has(turnId)) {
        turnOrder.push(turnId);
        turnStates.set(turnId, {
          turnId,
          startedAt: isoTime(payload.started_at, timestamp),
          completedAt: null,
          modelName: null,
          finalUsage: null,
          contextWindow: Number.isFinite(payload.model_context_window)
            ? payload.model_context_window
            : null,
          durationMs: null,
          lastAssistantMessageId: null,
        });
      }
      continue;
    }

    if (record.type === 'turn_context') {
      const turnId = payload.turn_id || activeTurnId;
      const turn = turnId ? turnStates.get(String(turnId)) : null;
      if (turn && typeof payload.model === 'string')
        turn.modelName = payload.model;
      continue;
    }

    if (record.type === 'event_msg' && payload.type === 'token_count') {
      const turn = activeTurnId ? turnStates.get(activeTurnId) : null;
      if (turn && payload.info) {
        turn.finalUsage = payload.info;
        if (Number.isFinite(payload.info.model_context_window)) {
          turn.contextWindow = payload.info.model_context_window;
        }
      }
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = textContent(payload).trim();
      if (
        role === 'user' &&
        (content.startsWith('[AGENT_CONTEXT:') ||
          /\bgroup_folder=[^\s]+\s+task_id=task-/.test(content))
      ) {
        boardOwnedHint = true;
      }
      if (!content || (role === 'user' && isSyntheticCodexUserMessage(content)))
        continue;
      const id =
        typeof payload.id === 'string'
          ? payload.id
          : `codex-${sessionId}-${messages.length + 1}`;
      messages.push({
        id,
        type: 'message',
        role,
        content,
        source,
        created_at: timestamp,
        external_session_id: sessionId,
        ...(activeTurnId ? { external_turn_id: activeTurnId } : {}),
      });
      if (role === 'user') {
        firstUserText ??= content;
        lastUserAt = timestamp;
      } else {
        lastAssistantAt = timestamp;
        const turn = activeTurnId ? turnStates.get(activeTurnId) : null;
        if (turn) turn.lastAssistantMessageId = id;
      }
      continue;
    }

    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = String(payload.turn_id || activeTurnId || '');
      const turn = turnStates.get(turnId);
      if (turn) {
        turn.completedAt = isoTime(payload.completed_at, timestamp);
        turn.durationMs = Number.isFinite(payload.duration_ms)
          ? payload.duration_ms
          : null;
      }
      activeTurnId = null;
    }
  }

  const turns: ImportedTurn[] = [];
  const telemetryAfterMessage = new Map<string, JsonObject>();
  let previous = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  for (const turnId of turnOrder) {
    const state = turnStates.get(turnId)!;
    const totals = state.finalUsage?.total_token_usage || {};
    const last = state.finalUsage?.last_token_usage || {};
    const tokInput = nonNegativeDelta(totals.input_tokens, previous.input);
    const tokCacheRead = nonNegativeDelta(
      totals.cached_input_tokens,
      previous.cached,
    );
    const tokOutput = nonNegativeDelta(totals.output_tokens, previous.output);
    const tokReasoning = nonNegativeDelta(
      totals.reasoning_output_tokens,
      previous.reasoning,
    );
    const totalTokens = nonNegativeDelta(totals.total_tokens, previous.total);
    previous = {
      input: Number(totals.input_tokens) || previous.input,
      cached: Number(totals.cached_input_tokens) || previous.cached,
      output: Number(totals.output_tokens) || previous.output,
      reasoning: Number(totals.reasoning_output_tokens) || previous.reasoning,
      total: Number(totals.total_tokens) || previous.total,
    };
    const hasUsage = Boolean(state.finalUsage);
    const costUsd = hasUsage
      ? calculateModelCostUsd(state.modelName, {
          inputTokens: Math.max(0, tokInput - tokCacheRead),
          cachedInputTokens: tokCacheRead,
          outputTokens: tokOutput,
        })
      : null;
    const telemetry =
      hasUsage || state.durationMs != null || state.modelName
        ? {
            tok_input: tokInput,
            tok_output: tokOutput,
            tok_cache_read: tokCacheRead,
            tok_reasoning: tokReasoning,
            total_tokens: totalTokens,
            tok_context_last: Number(last.total_tokens) || null,
            context_size: state.contextWindow,
            duration_ms: state.durationMs,
            model_name: state.modelName,
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
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      modelName: state.modelName,
      telemetry,
    });
    if (telemetry && state.lastAssistantMessageId) {
      telemetryAfterMessage.set(state.lastAssistantMessageId, {
        id: state.lastAssistantMessageId,
        type: 'telemetry',
        role: 'assistant',
        telemetry,
        created_at: state.completedAt || state.startedAt,
        external_session_id: sessionId,
        external_turn_id: turnId,
      });
    }
  }

  const transcript: JsonObject[] = [];
  for (const message of messages) {
    transcript.push(message);
    const telemetry = telemetryAfterMessage.get(message.id);
    if (telemetry) transcript.push(telemetry);
  }

  return {
    sessionId,
    source,
    cwd: meta.cwd,
    createdAt,
    isSubagent,
    boardOwnedHint,
    messages: transcript,
    turns,
    firstUserText,
    lastUserAt,
    lastAssistantAt,
  };
}

export function mapCwdToProject(
  cwd: string,
  projects: ImportProject[],
): { project: ImportProject | null; ambiguous: boolean } {
  const canonicalPath = (value: string): string => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const normalizedCwd = canonicalPath(cwd);
  const matches = projects.flatMap((project) => {
    if (!project.repositoryLocation) return [];
    const canonicalRoot = canonicalPath(project.repositoryLocation);
    const relative = path.relative(canonicalRoot, normalizedCwd);
    return relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
      ? [{ project, canonicalRoot }]
      : [];
  });
  if (matches.length === 0) return { project: null, ambiguous: false };
  const longest = Math.max(
    ...matches.map(({ canonicalRoot }) => canonicalRoot.length),
  );
  const best = matches.filter(
    ({ canonicalRoot }) => canonicalRoot.length === longest,
  );
  return best.length === 1
    ? { project: best[0].project, ambiguous: false }
    : { project: null, ambiguous: true };
}

export function deterministicCodexConversationId(sessionId: string): string {
  return `conv-codex-${sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}
