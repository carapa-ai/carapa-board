import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'fs';
import { logger } from '../../logger.js';
import { appendFile, mkdtemp, writeFile, rm, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildObserverChunks,
  buildReflectorChunks,
  readFromByteOffset,
} from './transcript-observe.js';

describe('transcript-observe', () => {
  test('buildObserverChunks groups chat turns by UTC day before token chunking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'chat-test.output.jsonl');
    try {
      const lines = [
        {
          type: 'message',
          role: 'user',
          content: 'I started yoga last spring.',
          created_at: '2024-03-10T09:00:00.000Z',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'Great habit to build.',
          created_at: '2024-03-10T09:01:00.000Z',
        },
        {
          type: 'message',
          role: 'user',
          content: 'I switched to meditation in April.',
          created_at: '2024-04-02T14:00:00.000Z',
        },
      ];
      await writeFile(
        file,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );

      const result = buildObserverChunks(
        file,
        fs.readFileSync(file),
        undefined,
        5000,
      );
      expect(result.turnCount).toBe(3);
      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0]!.inputKind).toBe('conversation');
      expect(result.chunks[0]!.messageDateUtc).toBe('2024-03-10T09:00:00.000Z');
      expect(result.chunks[0]!.text).toContain('yoga');
      expect(result.chunks[1]!.messageDateUtc).toBe('2024-04-02T14:00:00.000Z');
      expect(result.chunks[1]!.text).toContain('meditation');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('buildObserverChunks uses today for agent transcripts without timestamps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'task-abc.output.jsonl');
    const dayBefore = new Date().toISOString().slice(0, 10);
    try {
      const lines = [
        {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'Use SQLite for the prototype.' }],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'SQLite is a good fit for local dev.' },
            ],
          },
        },
      ];
      await writeFile(
        file,
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );

      const result = buildObserverChunks(
        file,
        fs.readFileSync(file),
        undefined,
        5000,
      );
      expect(result.turnCount).toBe(2);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]!.inputKind).toBe('transcript');
      const dayAfter = new Date().toISOString().slice(0, 10);
      const day = result.chunks[0]!.messageDateUtc.slice(0, 10);
      expect(day >= dayBefore && day <= dayAfter).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('buildObserverChunks uses fallback day for chat turns missing created_at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'chat-missing-date.output.jsonl');
    const dayBefore = new Date().toISOString().slice(0, 10);
    try {
      await writeFile(
        file,
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: 'Fresh chat without timestamp metadata.',
        }) + '\n',
      );

      const result = buildObserverChunks(
        file,
        fs.readFileSync(file),
        undefined,
        5000,
      );
      expect(result.turnCount).toBe(1);
      const dayAfter = new Date().toISOString().slice(0, 10);
      const { messageDateUtc } = result.chunks[0]!;
      expect(messageDateUtc.endsWith('T12:00:00.000Z')).toBe(true);
      const day = messageDateUtc.slice(0, 10);
      expect(day >= dayBefore && day <= dayAfter).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('buildReflectorChunks preserves stable message evidence and timestamps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-reflector-'));
    const file = join(dir, 'chat-evidence.output.jsonl');
    try {
      await writeFile(
        file,
        [
          {
            id: 'message-user-1',
            type: 'message',
            role: 'user',
            content: 'Use Berlin for production.',
            created_at: '2025-02-01T10:00:00.000Z',
            objective_id: 'objective-release',
          },
          {
            id: 'message-assistant-1',
            type: 'message',
            role: 'assistant',
            content: 'Understood.',
            created_at: '2025-02-01T10:00:01.000Z',
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );

      const chunks = buildReflectorChunks(file, undefined, 5000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.text).toContain(
        '<message id="message-user-1" timestamp="2025-02-01T10:00:00.000Z" role="user" objective_id="objective-release">',
      );
      expect(chunks[0]!.messages[0]).toEqual({
        id: 'message-user-1',
        role: 'user',
        content: 'Use Berlin for production.',
        createdAt: '2025-02-01T10:00:00.000Z',
        objectiveId: 'objective-release',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('normalizes offset timestamps before UTC day ordering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-reflector-order-'));
    const file = join(dir, 'chat-offset-order.output.jsonl');
    try {
      await writeFile(
        file,
        [
          {
            id: 'later-instant',
            type: 'message',
            role: 'user',
            content: 'This happens second.',
            created_at: '2025-02-01T23:00:00Z',
          },
          {
            id: 'earlier-instant',
            type: 'message',
            role: 'user',
            content: 'This happens first.',
            created_at: '2025-02-02T00:30:00+02:00',
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );

      const chunks = buildReflectorChunks(file, undefined, 1);

      expect(chunks.map((chunk) => chunk.messages[0]!.id)).toEqual([
        'earlier-instant',
        'later-instant',
      ]);
      expect(chunks.map((chunk) => chunk.messageDateUtc)).toEqual([
        '2025-02-01T22:30:00.000Z',
        '2025-02-01T23:00:00.000Z',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('timestamp-less replies take the next stamped line of the slice and keep turn order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-reflector-derived-'));
    const file = join(dir, 'chat-derived.output.jsonl');
    const line = (entry: Record<string, unknown>) =>
      `${JSON.stringify(entry)}\n`;
    const user = (content: string, created_at: string) =>
      line({ type: 'message', role: 'user', content, created_at });
    const reply = (content: string) =>
      line({ type: 'message', role: 'assistant', content });
    const stamp = (created_at: string) =>
      line({ type: 'telemetry', role: 'assistant', created_at });
    try {
      const head =
        user('u1', '2026-11-10T23:50:00Z') +
        reply('a1') +
        stamp('2026-11-10T23:50:05Z') +
        user('u2', '2026-11-11T00:10:00Z') +
        reply('a2') +
        stamp('2026-11-11T00:10:05Z');
      const tail = reply('a3');
      await writeFile(file, head + tail + 'not json {\n');
      const mtime = new Date('2026-11-12T09:00:00.000Z');
      await utimes(file, mtime, mtime);

      const messages = (start?: number, end?: number) =>
        buildReflectorChunks(file, start, 5000, end).flatMap((chunk) =>
          chunk.messages.map((m) => [m.content, m.createdAt]),
        );
      // File order across UTC midnight; each reply keeps its own turn's day.
      expect(messages()).toEqual([
        ['u1', '2026-11-10T23:50:00.000Z'],
        ['a1', '2026-11-10T23:50:05.000Z'],
        ['u2', '2026-11-11T00:10:00.000Z'],
        ['a2', '2026-11-11T00:10:05.000Z'],
        // Last line of the slice: nearest previous stamped line.
        ['a3', '2026-11-11T00:10:05.000Z'],
      ]);
      expect(buildReflectorChunks(file, undefined, 5000)).toHaveLength(2);
      // A slice without any stamped line keeps the file-mtime fallback.
      expect(messages(Buffer.byteLength(head))).toEqual([
        ['a3', mtime.toISOString()],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fallback evidence identity is stable across slices and uses append time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-reflector-offset-'));
    const file = join(dir, 'task-offset.output.jsonl');
    try {
      const first = `${JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'First timestamp-less turn.',
      })}\n`;
      const second = `${JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'Later timestamp-less turn.',
      })}\n`;
      await writeFile(file, first);
      await appendFile(file, second);
      const appendTime = new Date('2026-09-11T09:30:00.000Z');
      await utimes(file, appendTime, appendTime);

      const full = buildReflectorChunks(file, undefined, 5000).flatMap(
        (chunk) => chunk.messages,
      );
      const sliced = buildReflectorChunks(
        file,
        Buffer.byteLength(first),
        5000,
      ).flatMap((chunk) => chunk.messages);
      const bounded = buildReflectorChunks(
        file,
        0,
        5000,
        Buffer.byteLength(first),
      ).flatMap((chunk) => chunk.messages);

      expect(sliced).toHaveLength(1);
      expect(sliced[0]!.id).toBe(full[1]!.id);
      expect(sliced[0]!.id).toBe(`byte-${Buffer.byteLength(first)}`);
      expect(sliced[0]!.createdAt).toBe(appendTime.toISOString());
      expect(bounded.map((message) => message.content)).toEqual([
        'First timestamp-less turn.',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('buildReflectorChunks from supplied bytes equals the path variant, offsets included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'chat-parity.output.jsonl');
    try {
      const first = `${JSON.stringify({ type: 'message', role: 'user', content: 'Stamped.', created_at: '2026-09-10T08:00:00.000Z' })}\n`;
      const second = `${JSON.stringify({ type: 'message', role: 'assistant', content: 'Timestamp-less.' })}\n`;
      await writeFile(file, first + second);
      const mtime = new Date('2026-09-11T09:30:00.000Z');
      await utimes(file, mtime, mtime);
      const source = {
        bytes: fs.readFileSync(file),
        mtimeIso: mtime.toISOString(),
      };
      const firstEnd = Buffer.byteLength(first);
      for (const [start, end] of [
        [undefined, undefined],
        [firstEnd, undefined],
        [0, firstEnd],
        [firstEnd, firstEnd],
      ] as const) {
        expect(buildReflectorChunks(file, start, 5000, end, source)).toEqual(
          buildReflectorChunks(file, start, 5000, end),
        );
      }
      // Supplied bytes are authoritative: no filesystem access for the content.
      await rm(file);
      expect(
        buildReflectorChunks(file, firstEnd, 5000, undefined, source).flatMap(
          (chunk) => chunk.messages.map((message) => message.content),
        ),
      ).toEqual(['Timestamp-less.']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFromByteOffset returns empty and warns when offset exceeds file size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'out.jsonl');
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      await writeFile(file, 'abc\n');
      expect(readFromByteOffset(file, 100)).toBe('');
      expect(warn).toHaveBeenCalledWith(
        { filePath: file, byteOffset: 100, size: 4 },
        'transcript shorter than reflection offset',
      );
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFromByteOffset closes the fd when the read throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'out.jsonl');
    const read = spyOn(fs, 'readSync').mockImplementation((() => {
      throw new Error('boom');
    }) as never);
    const close = spyOn(fs, 'closeSync');
    try {
      await writeFile(file, 'abcdef\n');
      expect(() => readFromByteOffset(file, 2)).toThrow('boom');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
      close.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFromByteOffset returns only bytes after a valid offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-observe-'));
    const file = join(dir, 'out.jsonl');
    try {
      await writeFile(file, 'abcdef\n');
      expect(readFromByteOffset(file, 3)).toBe('def\n');
      expect(readFromByteOffset(file, 6)).toBe('\n');
      expect(readFromByteOffset(file, 7)).toBe('');
      expect(readFromByteOffset(file, 0)).toBe('abcdef\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
