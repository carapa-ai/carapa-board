import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../logger.js';
import { parseTranscript } from './transcript-parser.js';

describe('transcript-parser', () => {
  test('parseTranscript returns an empty transcript when byteOffset exceeds file size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-parser-'));
    const file = join(dir, 'output.jsonl');
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    try {
      await writeFile(
        file,
        JSON.stringify({ type: 'message', role: 'user', content: 'hello' }) +
          '\n',
      );
      expect(parseTranscript(file, 10_000)).toEqual({
        condensed: '',
        length: 0,
        turnCount: 0,
      });
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
