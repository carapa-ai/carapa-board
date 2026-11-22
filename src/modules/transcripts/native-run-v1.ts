import type { CarapaRunV1Document, CarapaRunV1Event } from './carapa-run-v1.js';

type JsonObject = Record<string, any>;

export interface ImportedTurn {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  modelName: string | null;
  telemetry: Record<string, unknown> | null;
}

export interface NativeRunSession {
  sessionId: string;
  source: string;
  createdAt: string;
  messages: JsonObject[];
  turns: ImportedTurn[];
}

export interface NativeImportV1Run {
  runId: string;
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  document: CarapaRunV1Document;
  /**
   * Source timestamp of each user message, keyed by its index in
   * `document.events`. Set only for sources whose imported user lines carry
   * their own time; other users are stamped with `startedAt`.
   */
  userMessageAt?: Record<number, string>;
}

/** Sources whose user messages keep their own source timestamp. */
const USER_TIMESTAMP_SOURCES = new Set(['claude-native', 'gemini-native']);

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function tokenCount(value: unknown): number {
  return Math.trunc(finiteNonNegative(value) ?? 0);
}

function safeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
}

function visibleMessages(session: NativeRunSession): JsonObject[] {
  return session.messages.filter(
    (entry) =>
      entry?.type === 'message' &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string',
  );
}

/**
 * Group provider-neutral parsed dialogue into native turns. Some providers put
 * a turn ID only on the assistant response, so unscoped user messages are held
 * until the following explicitly-scoped message identifies their turn.
 */
function messagesByTurn(session: NativeRunSession): {
  order: string[];
  messages: Map<string, JsonObject[]>;
} {
  const order: string[] = [];
  const messages = new Map<string, JsonObject[]>();
  let pending: JsonObject[] = [];

  const append = (turnId: string, entries: JsonObject[]): void => {
    if (!messages.has(turnId)) {
      messages.set(turnId, []);
      order.push(turnId);
    }
    messages.get(turnId)!.push(...entries);
  };

  for (const [index, entry] of visibleMessages(session).entries()) {
    const explicitTurnId =
      typeof entry.external_turn_id === 'string' && entry.external_turn_id
        ? entry.external_turn_id
        : null;
    if (explicitTurnId) {
      append(explicitTurnId, [...pending, entry]);
      pending = [];
      continue;
    }
    if (entry.role === 'user') {
      pending.push(entry);
      continue;
    }
    const fallbackTurnId = `message-${typeof entry.id === 'string' && entry.id ? entry.id : index + 1}`;
    append(fallbackTurnId, [...pending, entry]);
    pending = [];
  }

  if (pending.length > 0) {
    let suffix = order.length + 1;
    let turnId = `incomplete-${suffix}`;
    while (messages.has(turnId)) turnId = `incomplete-${++suffix}`;
    append(turnId, pending);
  }

  for (const turn of session.turns) {
    if (!messages.has(turn.turnId) && turn.telemetry) {
      messages.set(turn.turnId, []);
      order.push(turn.turnId);
    }
  }
  return { order, messages };
}

/** Convert any parsed native session into independently valid compact V1 runs. */
export function nativeSessionToCarapaRunV1(
  session: NativeRunSession,
): NativeImportV1Run[] {
  const turnById = new Map(session.turns.map((turn) => [turn.turnId, turn]));
  const grouped = messagesByTurn(session);

  return grouped.order.map((turnId, index) => {
    const turn = turnById.get(turnId);
    const messages = grouped.messages.get(turnId) ?? [];
    const firstTimestamp = messages.find(
      (message) => typeof message.created_at === 'string',
    )?.created_at;
    const lastTimestamp = [...messages]
      .reverse()
      .find((message) => typeof message.created_at === 'string')?.created_at;
    const startedAt =
      turn?.startedAt ||
      (typeof firstTimestamp === 'string' ? firstTimestamp : session.createdAt);
    const completedAt =
      turn?.completedAt ||
      (typeof lastTimestamp === 'string' ? lastTimestamp : null);
    const model = turn?.modelName ?? null;
    const events: CarapaRunV1Event[] = [
      {
        type: 'session',
        id: session.sessionId,
        status: index === 0 ? 'started' : 'resumed',
      },
      {
        type: 'run',
        status: 'started',
        ...(model ? { model } : {}),
      },
    ];

    const userMessageAt: Record<number, string> = {};
    for (const [messageIndex, message] of messages.entries()) {
      if (
        USER_TIMESTAMP_SOURCES.has(session.source) &&
        message.role === 'user' &&
        typeof message.created_at === 'string'
      ) {
        userMessageAt[events.length] = message.created_at;
      }
      events.push({
        type: 'message',
        id:
          typeof message.id === 'string' && message.id
            ? message.id
            : `${session.sessionId}-${turnId}-message-${messageIndex + 1}`,
        role: message.role,
        content: message.content,
        format: 'markdown',
        status: 'completed',
      });
    }

    const telemetry = turn?.telemetry;
    if (telemetry) {
      const inputTokens = tokenCount(telemetry.tok_input);
      const outputTokens = tokenCount(telemetry.tok_output);
      const cachedInputTokens = tokenCount(telemetry.tok_cache_read);
      const cacheWriteInputTokens = tokenCount(telemetry.tok_cache_write);
      const reasoningOutputTokens = tokenCount(telemetry.tok_reasoning);
      if (
        inputTokens > 0 ||
        outputTokens > 0 ||
        cachedInputTokens > 0 ||
        cacheWriteInputTokens > 0 ||
        reasoningOutputTokens > 0
      ) {
        events.push({
          type: 'usage',
          scope: 'incremental',
          inputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
          ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
          ...(reasoningOutputTokens > 0 ? { reasoningOutputTokens } : {}),
        });
      }
    }

    const durationMs = finiteNonNegative(telemetry?.duration_ms);
    const costUsd = finiteNonNegative(telemetry?.cost_usd);
    const contextSize = finiteNonNegative(telemetry?.context_size);
    const metrics = {
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(contextSize !== undefined ? { contextSize } : {}),
    };
    const lastMessage = messages.at(-1);
    const terminalStatus =
      turn?.completedAt || lastMessage?.role === 'assistant'
        ? 'completed'
        : 'interrupted';
    events.push({
      type: 'run',
      status: terminalStatus,
      stopReason: 'imported',
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });

    return {
      runId: safeRunId(
        `external-${session.source}-${session.sessionId}-${turnId}`,
      ),
      turnId,
      startedAt,
      completedAt,
      ...(Object.keys(userMessageAt).length > 0 ? { userMessageAt } : {}),
      document: {
        manifest: {
          format: 'carapa-run',
          version: 1,
          harness: session.source,
          requestedModel: model,
        },
        events,
      },
    };
  });
}
