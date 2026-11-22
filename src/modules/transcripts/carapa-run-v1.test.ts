import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCarapaRunV1StreamState,
  emitCarapaRunV1Lines,
  ensureCarapaRunV1Terminal,
  readCarapaRunV1Pair,
  summarizeCarapaRunV1,
  type CarapaRunV1Document,
} from './carapa-run-v1.js';

describe('Carapa Run V1 live assistant text', () => {
  test('keeps a provider error as the canonical result when no message exists', () => {
    const summary = summarizeCarapaRunV1({
      manifest: {
        format: 'carapa-run',
        version: 1,
        harness: 'agy-sdk',
        requestedModel: null,
      },
      events: [
        { type: 'session', id: 'agy-sdk-session', status: 'started' },
        { type: 'error', message: 'provider unavailable', fatal: false },
        { type: 'run', status: 'failed', stopReason: 'process_exit' },
      ],
    });
    expect(summary.result).toBe('provider unavailable');
    expect(summary.agentTerminalFailure).toBe(true);
  });

  test('completes a partial stopped spool so streamed text remains replayable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-run-v1-'));
    const paths = {
      events: path.join(dir, 'output.v1.jsonl'),
      manifest: path.join(dir, 'output.v1.meta.json'),
    };
    try {
      fs.writeFileSync(
        paths.manifest,
        JSON.stringify({
          format: 'carapa-run',
          version: 1,
          harness: 'codex',
          requestedModel: null,
        }),
      );
      fs.writeFileSync(
        paths.events,
        `${JSON.stringify({ type: 'run', status: 'started' })}\n${JSON.stringify({ type: 'message_delta', id: 'm1', role: 'assistant', delta: 'Partial answer' })}\n`,
      );

      expect(ensureCarapaRunV1Terminal(paths)).toBe(true);
      expect(
        readCarapaRunV1Pair(paths, { requireTerminal: true })?.events,
      ).toEqual([
        { type: 'run', status: 'started' },
        {
          type: 'message_delta',
          id: 'm1',
          role: 'assistant',
          delta: 'Partial answer',
        },
        {
          type: 'message',
          id: 'm1',
          role: 'assistant',
          content: 'Partial answer',
          status: 'interrupted',
        },
        { type: 'run', status: 'interrupted' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('closes streamed deltas under the terminal provider identity', () => {
    const chunks: Array<{
      type: 'text';
      content: string;
      entryId?: string;
      entryComplete?: boolean;
      canonicalEntry?: boolean;
    }> = [];
    const state = createCarapaRunV1StreamState();
    const emit = (event: Record<string, unknown>) =>
      emitCarapaRunV1Lines(
        `${JSON.stringify(event)}\n`,
        (chunk) => {
          if (chunk.type === 'text') chunks.push(chunk);
        },
        state,
      );

    // Separate calls reproduce the file-watcher boundary from m7c7o5: deltas
    // are delivered live before the complete message arrives in a later read.
    const deltas = [
      'Hello',
      ',',
      ' Al',
      'ex',
      '!',
      ' How',
      ' can',
      ' I',
      ' help',
      ' you',
      ' today',
      '?',
    ];
    for (const delta of deltas) {
      emit({
        type: 'message_delta',
        id: 'message-1',
        role: 'assistant',
        delta,
      });
    }
    emit({
      type: 'message',
      id: 'message-1',
      role: 'assistant',
      content: 'Hello, Alex! How can I help you today?',
      status: 'completed',
    });

    expect(chunks.slice(0, -1).map((chunk) => chunk.content)).toEqual(deltas);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(
      'Hello, Alex! How can I help you today?',
    );
    expect(chunks.at(-1)).toEqual({
      type: 'text',
      content: '',
      entryId: 'message:message-1',
      entryComplete: true,
      canonicalEntry: true,
    });
    expect(state.accumulatedMessages.has('message-1')).toBe(false);
  });

  test('closes deltas streamed under a provisional id when the terminal id differs', () => {
    const chunks: Array<{
      content: string;
      entryId?: string;
      canonicalEntry?: boolean;
    }> = [];
    const state = createCarapaRunV1StreamState();
    for (const event of [
      {
        type: 'message_delta',
        id: 'pi-message-7',
        role: 'assistant',
        delta: 'ok ',
      },
      {
        type: 'message_delta',
        id: 'pi-message-7',
        role: 'assistant',
        delta: 'done',
      },
      {
        type: 'message',
        id: 'resp_abc',
        role: 'assistant',
        content: 'ok done',
        status: 'completed',
      },
    ]) {
      emitCarapaRunV1Lines(
        `${JSON.stringify(event)}\n`,
        (chunk) => {
          if (chunk.type === 'text') chunks.push(chunk);
        },
        state,
      );
    }

    expect(new Set(chunks.map((chunk) => chunk.entryId))).toEqual(
      new Set(['message:pi-message-7']),
    );
    expect(chunks.map((chunk) => chunk.content).join('')).toBe('ok done');
    expect(chunks.at(-1)?.canonicalEntry).toBe(true);
    expect(state.accumulatedMessages.size).toBe(0);
  });

  test('appends terminal content missing from partial message deltas', () => {
    const chunks: Array<{ content: string; entryId?: string }> = [];
    const state = createCarapaRunV1StreamState();
    for (const event of [
      {
        type: 'message_delta',
        id: 'message-partial',
        role: 'assistant',
        delta: 'final ',
      },
      {
        type: 'message',
        id: 'message-partial',
        role: 'assistant',
        content: 'final answer',
        status: 'completed',
      },
    ]) {
      emitCarapaRunV1Lines(
        `${JSON.stringify(event)}\n`,
        (chunk) => {
          if (chunk.type === 'text') chunks.push(chunk);
        },
        state,
      );
    }
    expect(chunks.map((chunk) => chunk.content).join('')).toBe('final answer');
    expect(
      chunks.every((chunk) => chunk.entryId === 'message:message-partial'),
    ).toBe(true);
  });

  test('uses one stable entry identity for interleaved tool starts and results', () => {
    const chunks: Array<{ content: string; entryId?: string }> = [];
    const events = [
      {
        type: 'tool_call',
        id: 'A',
        status: 'started',
        name: 'bash',
        input: { command: 'echo A' },
      },
      {
        type: 'tool_call',
        id: 'B',
        status: 'started',
        name: 'bash',
        input: { command: 'echo B' },
      },
      { type: 'tool_call', id: 'A', status: 'completed', output: 'A result' },
      { type: 'tool_call', id: 'B', status: 'completed', output: 'B result' },
    ];

    emitCarapaRunV1Lines(
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      (chunk) => {
        if (chunk.type === 'text') chunks.push(chunk);
      },
      createCarapaRunV1StreamState('run-1'),
    );

    expect(chunks.map((chunk) => chunk.entryId)).toEqual([
      'tool_call:run-1-v1-tool-A',
      'tool_call:run-1-v1-tool-B',
      'tool_call:run-1-v1-tool-A',
      'tool_call:run-1-v1-tool-B',
    ]);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      expect.stringContaining(
        '<!-- carapa-tool:request tool-id="run-1-v1-tool-A" -->',
      ),
      expect.stringContaining(
        '<!-- carapa-tool:request tool-id="run-1-v1-tool-B" -->',
      ),
      expect.stringContaining(
        '<!-- carapa-tool:result tool-id="run-1-v1-tool-A" -->',
      ),
      expect.stringContaining(
        '<!-- carapa-tool:result tool-id="run-1-v1-tool-B" -->',
      ),
    ]);
  });

  test('does not turn a terminal-only assistant message into live text', () => {
    const chunks: string[] = [];
    emitCarapaRunV1Lines(
      `${JSON.stringify({
        type: 'message',
        id: 'message-1',
        role: 'assistant',
        content: 'Canonical answer without deltas.',
        status: 'completed',
      })}\n`,
      (chunk) => {
        if (chunk.type === 'text') chunks.push(chunk.content);
      },
      createCarapaRunV1StreamState(),
    );

    expect(chunks).toEqual(['']);
  });

  test('keeps the terminal assistant message as the canonical run result', () => {
    const document: CarapaRunV1Document = {
      manifest: {
        format: 'carapa-run',
        version: 1,
        harness: 'codex',
        requestedModel: 'gpt-5.6-luna',
      },
      events: [
        { type: 'run', status: 'started' },
        {
          type: 'message_delta',
          id: 'message-1',
          role: 'assistant',
          delta: 'Hello, Alex!',
        },
        {
          type: 'message',
          id: 'message-1',
          role: 'assistant',
          content: 'Hello, Alex!',
          status: 'completed',
        },
        { type: 'run', status: 'completed' },
      ],
    };

    expect(summarizeCarapaRunV1(document)).toMatchObject({
      result: 'Hello, Alex!',
      hasAssistantText: true,
      uuid: 'message-1',
      agentSuccess: true,
    });
  });
});

describe('readCarapaRunV1Pair containedIn', () => {
  const manifest = JSON.stringify({
    format: 'carapa-run',
    version: 1,
    harness: 'opencode',
    requestedModel: null,
  });
  const events =
    [
      { type: 'run', status: 'started' },
      { type: 'run', status: 'completed' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';

  function withFixture(fn: (group: string, outside: string) => void) {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'v1-contained-')),
    );
    try {
      const group = path.join(tmp, 'group');
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(path.join(group, 'dir'), { recursive: true });
      fs.mkdirSync(outside);
      fn(group, outside);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('reads regular files, refuses leaf symlinks, and is a no-op when omitted', () => {
    withFixture((group, outside) => {
      const paths = {
        events: path.join(group, 'dir', 'run.v1.events.jsonl'),
        manifest: path.join(group, 'dir', 'run.v1.manifest.json'),
      };
      fs.writeFileSync(paths.manifest, manifest);
      fs.writeFileSync(paths.events, events);
      expect(
        readCarapaRunV1Pair(paths, { containedIn: group })?.events,
      ).toHaveLength(2);

      // A planted link is refused whether it leaves the group or not.
      fs.rmSync(paths.manifest);
      fs.rmSync(paths.events);
      fs.writeFileSync(path.join(outside, 'manifest.json'), manifest);
      fs.writeFileSync(path.join(outside, 'events.jsonl'), events);
      fs.symlinkSync(path.join(outside, 'manifest.json'), paths.manifest);
      fs.symlinkSync(path.join(outside, 'events.jsonl'), paths.events);

      expect(readCarapaRunV1Pair(paths)).not.toBeNull();
      expect(() =>
        readCarapaRunV1Pair(paths, { containedIn: group }),
      ).toThrow();
    });
  });

  test('a FIFO manifest is refused without blocking', () => {
    withFixture((group) => {
      const paths = {
        events: path.join(group, 'dir', 'run.v1.events.jsonl'),
        manifest: path.join(group, 'dir', 'run.v1.manifest.json'),
      };
      fs.writeFileSync(paths.events, events);
      const made = spawnSync('mkfifo', [paths.manifest]);
      if (made.status !== 0) return; // no mkfifo on this platform

      expect(() => readCarapaRunV1Pair(paths, { containedIn: group })).toThrow(
        /regular file/,
      );
    });
  });
});
