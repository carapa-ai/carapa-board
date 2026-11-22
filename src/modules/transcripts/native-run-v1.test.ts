import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseCarapaRunV1Event,
  parseCarapaRunV1Manifest,
} from './carapa-run-v1.js';
import { nativeSessionToCarapaRunV1 } from './native-run-v1.js';
import {
  parseAntigravitySession,
  parseClaudeSession,
  parseCodexSession,
  parseCursorJsonlSession,
  parseCursorSession,
  parseGeminiSession,
  parseVscodeSession,
  type ParsedNativeSession,
} from './native-session-import.js';

describe('native session V1 normalization', () => {
  test('normalizes every retained bulk-import source fixture', () => {
    const fixtureRoot = path.join(
      import.meta.dir,
      'fixtures',
      'native-import',
      'source',
    );
    const text = (name: string) =>
      fs.readFileSync(path.join(fixtureRoot, name), 'utf8');
    const json = (name: string) => JSON.parse(text(name));
    const jsonl = (name: string) =>
      text(name)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const sessions: ParsedNativeSession[] = [
      parseClaudeSession(jsonl('claude-native.jsonl'))!,
      parseCodexSession(jsonl('codex-native.jsonl'))! as ParsedNativeSession,
      parseCodexSession(jsonl('codex-vscode.jsonl'))! as ParsedNativeSession,
      parseGeminiSession(json('gemini-native.jsonl'), 'fixture')!,
      parseCursorSession(
        text('cursor-native-text.txt'),
        'cursor-text-fixture',
        'repos-example',
        '2026-08-26T10:00:02Z',
      )!,
      parseCursorJsonlSession(
        jsonl('cursor-native.jsonl'),
        'cursor-jsonl-fixture',
        'repos-example',
        '2026-08-26T10:00:02Z',
      )!,
      parseVscodeSession(json('vscode-native.jsonl'), 'fixture', null)!,
      parseAntigravitySession(json('antigravity-native.jsonl'))!,
    ];

    expect(sessions).toHaveLength(8);
    for (const session of sessions) {
      const runs = nativeSessionToCarapaRunV1(session);
      expect(runs.length).toBeGreaterThan(0);
      expect(
        runs.flatMap((run) =>
          run.document.events.filter((event) => event.type === 'message'),
        ),
      ).toHaveLength(2);
      for (const run of runs) {
        expect(run.document.manifest.harness).toBe(session.source);
        expect(run.document.events[0]).toMatchObject({
          type: 'session',
          id: session.sessionId,
        });
        expect(run.document.events.at(-1)).toMatchObject({ type: 'run' });
      }
    }
  });

  test.each(['claude-native'])('creates a valid %s run pair', (source) => {
    const runs = nativeSessionToCarapaRunV1({
      sessionId: `${source}-session`,
      source,
      createdAt: '2026-09-01T10:00:00Z',
      messages: [
        {
          id: 'user-1',
          type: 'message',
          role: 'user',
          content: 'Question',
          created_at: '2026-09-01T10:00:00Z',
        },
        {
          id: 'assistant-1',
          type: 'message',
          role: 'assistant',
          content: 'Answer',
          created_at: '2026-09-01T10:00:01Z',
          external_turn_id: 'turn-1',
        },
      ],
      turns: [
        {
          turnId: 'turn-1',
          startedAt: '2026-09-01T10:00:00Z',
          completedAt: '2026-09-01T10:00:01Z',
          modelName: 'test-model',
          telemetry: {
            tok_input: 10,
            tok_output: 2,
            tok_cache_read: 3,
            tok_cache_write: 1,
            tok_reasoning: 1,
          },
        },
      ],
    });

    expect(runs).toHaveLength(1);
    expect(
      parseCarapaRunV1Manifest(JSON.stringify(runs[0].document.manifest)),
    ).toEqual(runs[0].document.manifest);
    expect(
      runs[0].document.events.map((event) =>
        parseCarapaRunV1Event(JSON.stringify(event)),
      ),
    ).toEqual(runs[0].document.events);
    expect(
      runs[0].document.events
        .filter((event) => event.type === 'message')
        .map((event) => [event.role, event.content]),
    ).toEqual([
      ['user', 'Question'],
      ['assistant', 'Answer'],
    ]);
    expect(runs[0].document.events).toContainEqual({
      type: 'usage',
      scope: 'incremental',
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 1,
      reasoningOutputTokens: 1,
    });
  });

  test('pairs each unscoped user prompt with its following assistant turn', () => {
    const runs = nativeSessionToCarapaRunV1({
      sessionId: 'multi-turn',
      source: 'claude-native',
      createdAt: '2026-09-01T10:00:00Z',
      messages: [
        { id: 'u1', type: 'message', role: 'user', content: 'Q1' },
        {
          id: 'a1',
          type: 'message',
          role: 'assistant',
          content: 'A1',
          external_turn_id: 'turn-1',
        },
        { id: 'u2', type: 'message', role: 'user', content: 'Q2' },
        {
          id: 'a2',
          type: 'message',
          role: 'assistant',
          content: 'A2',
          external_turn_id: 'turn-2',
        },
      ],
      turns: [],
    });

    expect(runs.map((run) => run.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(
      runs.map((run) =>
        run.document.events
          .filter((event) => event.type === 'message')
          .map((event) => event.content),
      ),
    ).toEqual([
      ['Q1', 'A1'],
      ['Q2', 'A2'],
    ]);
  });
});
