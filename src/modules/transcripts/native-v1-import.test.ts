import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  archivedCarapaRunV1Paths,
  readCarapaRunV1Pair,
} from './carapa-run-v1.js';
import { nativeSessionToCarapaRunV1 } from './native-run-v1.js';
import {
  installNativeV1Pair,
  NativeV1ImportConflictError,
  projectNativeV1TranscriptEntries,
} from './native-v1-import.js';

describe('native V1 import storage', () => {
  test('installs validated pairs and projects compact deterministic IDs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-v1-import-'));
    try {
      const [run] = nativeSessionToCarapaRunV1({
        sessionId: 'session-1',
        source: 'gemini-native',
        createdAt: '2026-09-01T10:00:00Z',
        messages: [
          {
            id: 'u1',
            type: 'message',
            role: 'user',
            content: 'Question',
            created_at: '2026-09-01T10:00:00Z',
          },
          {
            id: 'a1',
            type: 'message',
            role: 'assistant',
            content: 'Answer',
            created_at: '2026-09-01T10:00:01Z',
            external_turn_id: 'turn-1',
          },
        ],
        turns: [],
      });
      const installed = await installNativeV1Pair(run, root, 'test');
      expect(installed.createdPaths).toHaveLength(2);
      expect(
        readCarapaRunV1Pair(archivedCarapaRunV1Paths(root, run.runId), {
          expectedHarness: 'gemini-native',
          requireTerminal: true,
        }),
      ).not.toBeNull();

      const entries = projectNativeV1TranscriptEntries(
        [run],
        'conv-gemini-session-1',
      );
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
      expect(entries.map((entry) => entry.created_at)).toEqual([
        '2026-09-01T10:00:00Z',
        '2026-09-01T10:00:01Z',
      ]);
      expect(
        projectNativeV1TranscriptEntries([run], 'conv-gemini-session-1').map(
          (entry) => entry.id,
        ),
      ).toEqual(entries.map((entry) => entry.id));

      const retry = await installNativeV1Pair(run, root, 'retry');
      expect(retry.createdPaths).toEqual([]);

      const conflicting = structuredClone(run);
      const message = conflicting.document.events.find(
        (event) => event.type === 'message' && event.role === 'assistant',
      );
      if (message?.type === 'message') message.content = 'Different answer';
      await expect(
        installNativeV1Pair(conflicting, root, 'conflict'),
      ).rejects.toBeInstanceOf(NativeV1ImportConflictError);
      expect(
        readCarapaRunV1Pair(archivedCarapaRunV1Paths(root, run.runId))?.events,
      ).toContainEqual(
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          content: 'Answer',
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
