import { describe, expect, test } from 'bun:test';
import {
  codexSessionToCarapaRunV1,
  isSyntheticCodexUserMessage,
  mapCwdToProject,
  parseCodexSession,
} from './codex-session-import.js';

function line(
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
) {
  return { timestamp, type, payload };
}

describe('Codex session import', () => {
  test('imports dialogue and attaches cumulative usage as per-turn telemetry', () => {
    const records = [
      line('2026-07-01T10:00:00Z', 'session_meta', {
        id: 'abc-123',
        cwd: '/repos/app',
        source: 'vscode',
        thread_source: 'user',
        timestamp: '2026-07-01T10:00:00Z',
      }),
      line('2026-07-01T10:00:01Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'turn-1',
        started_at: '2026-07-01T10:00:01Z',
      }),
      line('2026-07-01T10:00:01Z', 'turn_context', {
        turn_id: 'turn-1',
        model: 'gpt-test',
      }),
      line('2026-07-01T10:00:02Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'First prompt' }],
      }),
      line('2026-07-01T10:00:03Z', 'response_item', {
        id: 'assistant-1',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'First answer' }],
      }),
      line('2026-07-01T10:00:04Z', 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
          last_token_usage: { total_tokens: 80 },
          model_context_window: 200_000,
        },
      }),
      line('2026-07-01T10:00:05Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'turn-1',
        duration_ms: 4000,
        completed_at: '2026-07-01T10:00:05Z',
      }),
      line('2026-07-01T10:01:00Z', 'event_msg', {
        type: 'task_started',
        turn_id: 'turn-2',
        started_at: '2026-07-01T10:01:00Z',
      }),
      line('2026-07-01T10:01:00Z', 'turn_context', {
        turn_id: 'turn-2',
        model: 'gpt-test',
      }),
      line('2026-07-01T10:01:01Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<environment_context>hidden</environment_context>',
          },
        ],
      }),
      line('2026-07-01T10:01:02Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Second prompt' }],
      }),
      line('2026-07-01T10:01:03Z', 'response_item', {
        id: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Second answer' }],
      }),
      line('2026-07-01T10:01:04Z', 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 250,
            cached_input_tokens: 160,
            output_tokens: 50,
            reasoning_output_tokens: 8,
            total_tokens: 300,
          },
          last_token_usage: { total_tokens: 120 },
          model_context_window: 200_000,
        },
      }),
      line('2026-07-01T10:01:05Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'turn-2',
        duration_ms: 3000,
      }),
    ];

    const parsed = parseCodexSession(records)!;
    expect(parsed.source).toBe('codex-vscode');
    expect(
      parsed.messages
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.content),
    ).toEqual([
      'First prompt',
      'First answer',
      'Second prompt',
      'Second answer',
    ]);
    expect(
      parsed.messages.findIndex((entry) => entry.id === 'assistant-1') + 1,
    ).toBe(
      parsed.messages.findIndex(
        (entry) =>
          entry.external_turn_id === 'turn-1' && entry.type === 'telemetry',
      ),
    );
    expect(parsed.turns[0].telemetry).toMatchObject({
      tok_input: 100,
      tok_cache_read: 60,
      tok_output: 20,
      tok_reasoning: 5,
      total_tokens: 120,
      tok_context_last: 80,
      duration_ms: 4000,
    });
    expect(parsed.turns[1].telemetry).toMatchObject({
      tok_input: 150,
      tok_cache_read: 100,
      tok_output: 30,
      tok_reasoning: 3,
      total_tokens: 180,
      tok_context_last: 120,
      duration_ms: 3000,
    });

    const v1Runs = codexSessionToCarapaRunV1(parsed);
    expect(v1Runs).toHaveLength(2);
    expect(v1Runs.map((run) => run.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(v1Runs[0].document.events.slice(0, 2)).toEqual([
      { type: 'session', id: 'abc-123', status: 'started' },
      { type: 'run', status: 'started', model: 'gpt-test' },
    ]);
    expect(v1Runs[1].document.events).toContainEqual({
      type: 'session',
      id: 'abc-123',
      status: 'resumed',
    });
    expect(v1Runs[1].document.events).toContainEqual({
      type: 'usage',
      scope: 'incremental',
      inputTokens: 150,
      outputTokens: 30,
      cachedInputTokens: 100,
      reasoningOutputTokens: 3,
    });
    expect(v1Runs[1].document.events.at(-1)).toEqual({
      type: 'run',
      status: 'completed',
      stopReason: 'imported',
      metrics: expect.objectContaining({ durationMs: 3000 }),
    });
  });

  test('recognizes subagents and synthetic envelopes', () => {
    const parsed = parseCodexSession([
      line('2026-07-01T10:00:00Z', 'session_meta', {
        id: 'sub',
        cwd: '/repos/app',
        source: { subagent: { other: 'guardian' } },
      }),
    ])!;
    expect(parsed.isSubagent).toBe(true);
    expect(parsed.boardOwnedHint).toBe(false);
    expect(isSyntheticCodexUserMessage('<recommended_plugins>x')).toBe(true);
    expect(
      isSyntheticCodexUserMessage('# AGENTS.md instructions for /workspace'),
    ).toBe(true);
  });

  test('recognizes durable CarapaBoard launch markers', () => {
    const parsed = parseCodexSession([
      line('2026-07-01T10:00:00Z', 'session_meta', {
        id: 'board',
        cwd: '/workspace/project',
        source: 'exec',
        originator: 'codex_exec',
      }),
      line('2026-07-01T10:00:01Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[AGENT_CONTEXT: group_folder=demo task_id=task-123]',
          },
        ],
      }),
    ])!;
    expect(parsed.boardOwnedHint).toBe(true);
    expect(parsed.messages).toEqual([]);

    const carapaOrigin = parseCodexSession([
      line('2026-07-01T10:00:00Z', 'session_meta', {
        id: 'board-2',
        cwd: '/workspace/project',
        source: 'vscode',
        originator: 'carapa-run-agent',
      }),
    ])!;
    expect(carapaOrigin.boardOwnedHint).toBe(true);
  });

  test('uses the longest unambiguous repository path', () => {
    const result = mapCwdToProject('/repos/carapa/board/src', [
      { id: 'parent', repositoryLocation: '/repos/carapa' },
      { id: 'board', repositoryLocation: '/repos/carapa/board' },
    ]);
    expect(result).toEqual({
      project: { id: 'board', repositoryLocation: '/repos/carapa/board' },
      ambiguous: false,
    });
    expect(mapCwdToProject('/elsewhere', [])).toEqual({
      project: null,
      ambiguous: false,
    });
  });
});
