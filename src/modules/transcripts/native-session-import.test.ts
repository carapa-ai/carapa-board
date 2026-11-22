import { describe, expect, test } from 'bun:test';
import {
  deterministicNativeConversationId,
  parseAntigravitySession,
  parseClaudeSession,
  parseCursorSession,
  parseCursorJsonlSession,
  parseGeminiSession,
  parseVscodeSession,
} from './native-session-import.js';

describe('native session import', () => {
  test('aggregates Claude fragments and attaches reported telemetry', () => {
    const records = [
      {
        type: 'user',
        sessionId: 'claude-1',
        uuid: 'user-1',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:00Z',
        message: { content: 'Build the feature' },
      },
      {
        type: 'assistant',
        sessionId: 'claude-1',
        uuid: 'row-a',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:01Z',
        message: {
          id: 'assistant-1',
          model: 'claude-test',
          content: [{ type: 'thinking', thinking: 'hidden' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 40,
          },
        },
      },
      {
        type: 'assistant',
        sessionId: 'claude-1',
        uuid: 'row-b',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:02Z',
        message: {
          id: 'assistant-1',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Done.' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 40,
          },
        },
      },
      {
        type: 'assistant',
        sessionId: 'claude-1',
        uuid: 'row-c',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:03Z',
        message: {
          id: 'assistant-1',
          model: 'claude-test',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 40,
          },
        },
      },
    ];

    const parsed = parseClaudeSession(records)!;
    expect(parsed.cwd).toBe('/repos/app');
    expect(
      parsed.messages
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.content),
    ).toEqual(['Build the feature', 'Done.']);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].telemetry).toMatchObject({
      tok_input: 100,
      tok_output: 20,
      tok_cache_read: 40,
      model_name: 'claude-test',
    });
  });

  test('drops Claude sidechains, tool results, and Board envelopes', () => {
    const parsed = parseClaudeSession([
      {
        type: 'user',
        sessionId: 'claude-board',
        uuid: 'context',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:00Z',
        message: {
          content: '[AGENT_CONTEXT: group_folder=demo task_id=task-1]',
        },
      },
      {
        type: 'user',
        sessionId: 'claude-board',
        uuid: 'tool-result',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:01Z',
        message: { content: [{ type: 'tool_result', content: 'hidden' }] },
      },
      {
        type: 'user',
        sessionId: 'claude-board',
        uuid: 'local-command-caveat',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:01Z',
        message: {
          content:
            '<local-command-caveat>generated wrapper</local-command-caveat>',
        },
      },
      {
        type: 'assistant',
        sessionId: 'claude-board',
        uuid: 'sidechain',
        cwd: '/repos/app',
        timestamp: '2026-07-01T10:00:02Z',
        isSidechain: true,
        message: {
          id: 'side',
          content: [{ type: 'text', text: 'subagent answer' }],
        },
      },
    ])!;
    expect(parsed.boardOwnedHint).toBe(true);
    expect(parsed.messages).toEqual([]);
  });

  test('recognizes Claude sessions in Board objective sandboxes as Board-owned', () => {
    const parsed = parseClaudeSession([
      {
        type: 'user',
        sessionId: 'claude-objective',
        uuid: 'user',
        cwd: '/workspace/group/objectives/obj-123',
        timestamp: '2026-07-01T10:00:00Z',
        message: { content: 'Triggered by: self_reminder' },
      },
      {
        type: 'assistant',
        sessionId: 'claude-objective',
        uuid: 'assistant',
        cwd: '/workspace/group/objectives/obj-123',
        timestamp: '2026-07-01T10:00:01Z',
        message: {
          id: 'assistant-1',
          content: [{ type: 'text', text: 'Handled.' }],
        },
      },
    ])!;

    expect(parsed.boardOwnedHint).toBe(true);
  });

  test('imports Gemini dialogue and token metadata', () => {
    const parsed = parseGeminiSession(
      {
        sessionId: 'gemini-1',
        startTime: '2026-07-02T08:00:00Z',
        messages: [
          {
            id: 'g-user',
            type: 'user',
            timestamp: '2026-07-02T08:00:00Z',
            content: 'Question',
          },
          {
            id: 'g-answer',
            type: 'gemini',
            timestamp: '2026-07-02T08:00:01Z',
            content: 'Answer',
            model: 'gemini-test',
            thoughts: [{ subject: 'hidden' }],
            tokens: {
              input: 90,
              output: 10,
              cached: 30,
              thoughts: 4,
              total: 100,
            },
          },
        ],
      },
      'project-hash',
    )!;

    expect(parsed.mappingKey).toBe('gemini-hash:project-hash');
    expect(
      parsed.messages
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.content),
    ).toEqual(['Question', 'Answer']);
    expect(parsed.turns[0].telemetry).toMatchObject({
      tok_input: 90,
      tok_output: 10,
      tok_cache_read: 30,
      tok_reasoning: 4,
      total_tokens: 100,
    });
  });

  test('parses Cursor role blocks without tool-specific expansion', () => {
    const parsed = parseCursorSession(
      '<user_query>Fix this</user_query>\nmore detail\nA: Fixed it',
      'cursor-1',
      'repos-app',
      '2026-07-03T09:00:00Z',
    )!;
    expect(parsed.mappingKey).toBe('cursor-project:repos-app');
    expect(parsed.messages.map((entry) => [entry.role, entry.content])).toEqual(
      [
        ['user', 'Fix this\nmore detail'],
        ['assistant', 'Fixed it'],
      ],
    );
    expect(parsed.turns).toEqual([]);
  });

  test('parses Cursor JSONL transcript messages', () => {
    const parsed = parseCursorJsonlSession(
      [
        {
          timestamp: '2026-07-03T09:00:00Z',
          role: 'user',
          message: { content: [{ type: 'text', text: 'Fix this' }] },
        },
        {
          timestamp: '2026-07-03T09:00:01Z',
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Fixed it' }] },
        },
      ],
      'cursor-jsonl',
      'repos-app',
      '2026-07-03T09:01:00Z',
    )!;
    expect(parsed.messages.map((entry) => [entry.role, entry.content])).toEqual(
      [
        ['user', 'Fix this'],
        ['assistant', 'Fixed it'],
      ],
    );
    expect(parsed.lastAssistantAt).toBe('2026-07-03T09:00:01Z');
  });

  test('recognizes Board-owned Cursor JSONL sessions inside native user wrappers', () => {
    const parsed = parseCursorJsonlSession(
      [
        {
          role: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '<user_query> [AGENT_CONTEXT: group_folder=demo-app] run echo hello </user_query>',
              },
            ],
          },
        },
        {
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] },
        },
      ],
      'cursor-board-jsonl',
      'var-www-demo-app',
      '2026-07-03T09:01:00Z',
    )!;

    expect(parsed.boardOwnedHint).toBe(true);
  });

  test('parses VS Code chat sessions while excluding tool and edit response parts', () => {
    const parsed = parseVscodeSession(
      {
        sessionId: 'vscode-1',
        creationDate: 1750000000000,
        lastMessageDate: 1750000005000,
        requests: [
          {
            requestId: 'request-1',
            responseId: 'response-1',
            timestamp: 1750000001000,
            message: { text: 'Fix the problem', parts: [] },
            response: [
              { value: 'Fixed ', supportHtml: false },
              { kind: 'toolInvocationSerialized', toolId: 'read_file' },
              { kind: 'textEditGroup', edits: [] },
              { value: 'it.', supportHtml: false },
            ],
          },
        ],
      },
      'workspace-hash',
      '/repos/app',
    )!;

    expect(parsed.cwd).toBe('/repos/app');
    expect(parsed.mappingKey).toBeNull();
    expect(parsed.messages.map((entry) => [entry.role, entry.content])).toEqual(
      [
        ['user', 'Fix the problem'],
        ['assistant', 'Fixed it.'],
      ],
    );
    expect(parsed.lastAssistantAt).toBe(new Date(1750000005000).toISOString());
  });

  test('uses a VS Code workspace mapping key when no reliable cwd exists', () => {
    const parsed = parseVscodeSession(
      {
        sessionId: 'vscode-unmapped',
        creationDate: 1750000000000,
        requests: [
          {
            timestamp: 1750000001000,
            message: { text: 'Question' },
            response: [{ value: 'Answer' }],
          },
        ],
      },
      'abc123',
      null,
    )!;
    expect(parsed.mappingKey).toBe('vscode-workspace:abc123');
  });

  test('parses decoded Antigravity dialogue and excludes thinking and tool steps', () => {
    const parsed = parseAntigravitySession({
      trajectory: {
        cascadeId: 'cascade-1',
        trajectoryId: 'trajectory-1',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        metadata: {
          createdAt: '2026-07-04T10:00:00Z',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///repos/app' }],
        },
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            metadata: {
              createdAt: '2026-07-04T10:00:01Z',
              executionId: 'turn-1',
            },
            userInput: { userResponse: 'Build it' },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            metadata: {
              createdAt: '2026-07-04T10:00:02Z',
              executionId: 'turn-1',
            },
            plannerResponse: {
              thinking: 'hidden',
              toolCalls: [{ name: 'Read' }],
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_VIEW_FILE',
            metadata: { createdAt: '2026-07-04T10:00:03Z' },
            viewFile: { path: '/repos/app/file.ts' },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            metadata: {
              createdAt: '2026-07-04T10:00:04Z',
              completedAt: '2026-07-04T10:00:05Z',
              executionId: 'turn-1',
            },
            plannerResponse: {
              response: 'Done',
              modifiedResponse: 'Done safely',
            },
          },
        ],
      },
    })!;

    expect(parsed.cwd).toBe('/repos/app');
    expect(parsed.messages.map((entry) => [entry.role, entry.content])).toEqual(
      [
        ['user', 'Build it'],
        ['assistant', 'Done safely'],
      ],
    );
    expect(parsed.lastAssistantAt).toBe('2026-07-04T10:00:05Z');
  });

  test('recognizes Board-owned decoded Antigravity sessions', () => {
    const parsed = parseAntigravitySession({
      trajectory: {
        cascadeId: 'cascade-board',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        metadata: { createdAt: '2026-07-04T10:00:00Z', workspaces: [] },
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            metadata: { createdAt: '2026-07-04T10:00:01Z' },
            userInput: {
              userResponse: '[AGENT_CONTEXT: group_folder=demo task_id=task-1]',
            },
          },
        ],
      },
    })!;

    expect(parsed.boardOwnedHint).toBe(true);
    expect(parsed.messages).toEqual([]);
  });

  test('rejects malformed provider records and creates scoped ids', () => {
    expect(parseClaudeSession([])).toBeNull();
    expect(parseGeminiSession({}, 'hash')).toBeNull();
    expect(
      parseCursorSession('', '', 'project', '2026-07-01T00:00:00Z'),
    ).toBeNull();
    expect(deterministicNativeConversationId('claude', 'ABC_123')).toBe(
      'conv-claude-abc-123',
    );
    expect(deterministicNativeConversationId('codex', 'ABC_123')).toBe(
      'conv-codex-abc-123',
    );
  });
});
