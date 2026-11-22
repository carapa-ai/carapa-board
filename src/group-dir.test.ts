import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GROUPS_DIR } from './config.js';
import { groupFsTestHooks } from './lib/group-fs.js';
import {
  chatTranscriptPath,
  readChatTranscript,
  readChatTranscriptAsync,
  readLiveChatTranscriptAsync,
} from './group-dir.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-group-migrate-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('transcript reads refuse planted symlinks and FIFOs', () => {
  const group = 'test-group-dir-planted-links';
  const convId = 'conv-1767225600000-planted';
  const entry = (content: string) =>
    JSON.stringify({ type: 'message', content }) + '\n';
  const dir = path.join(GROUPS_DIR, group, 'transcripts');

  afterEach(() => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
  });

  test('chat readers return [] for a symlinked or FIFO conversation file', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = chatTranscriptPath(group, undefined, convId);
    const readAll = async () => [
      readChatTranscript(group, convId),
      await readChatTranscriptAsync(group, convId),
      await readLiveChatTranscriptAsync(group, convId),
    ];

    const foreign = path.join(tempRoot(), 'foreign.jsonl');
    fs.writeFileSync(foreign, entry('foreign secret'));
    fs.symlinkSync(foreign, filePath);
    expect(await readAll()).toEqual([[], [], []]);
    fs.unlinkSync(filePath);

    try {
      execFileSync('mkfifo', [filePath]);
    } catch {
      return; // mkfifo unavailable
    }
    expect(await readAll()).toEqual([[], [], []]);
  }, 2000);

  test('a regular conversation transcript is read unchanged', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      chatTranscriptPath(group, undefined, convId),
      entry('one') + entry('two'),
    );
    const expected = [
      { type: 'message', content: 'one' },
      { type: 'message', content: 'two' },
    ];
    expect(readChatTranscript(group, convId)).toEqual(expected);
    expect(await readChatTranscriptAsync(group, convId)).toEqual(expected);
    expect(await readLiveChatTranscriptAsync(group, convId)).toEqual(expected);
  });
});

describe('chat transcript reads pin the transcripts directory', () => {
  const group = 'test-group-dir-swapped-dir';
  const convId = 'conv-1767225600000-swapped';
  const dir = path.join(GROUPS_DIR, group, 'transcripts');
  const foreignDir = path.join(GROUPS_DIR, `${group}-foreign`);

  afterEach(() => {
    groupFsTestHooks.beforeOpen = undefined;
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.rmSync(foreignDir, { recursive: true, force: true });
  });

  test('a transcripts directory swapped for a link returns none of the foreign entries', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    const line = JSON.stringify({ type: 'message', content: 'FOREIGN' }) + '\n';
    fs.writeFileSync(
      path.join(
        foreignDir,
        path.basename(chatTranscriptPath(group, undefined, convId)),
      ),
      line,
    );
    fs.writeFileSync(chatTranscriptPath(group, undefined, convId), line);
    groupFsTestHooks.beforeOpen = (_label, segment) => {
      if (segment !== 'transcripts' || fs.lstatSync(dir).isSymbolicLink()) {
        return;
      }
      fs.renameSync(dir, `${dir}-moved`);
      fs.symlinkSync(foreignDir, dir);
    };

    expect(readChatTranscript(group, convId)).toEqual([]);
    // Control: with the directory restored the same read returns the entry.
    groupFsTestHooks.beforeOpen = undefined;
    fs.rmSync(dir, { force: true });
    fs.renameSync(`${dir}-moved`, dir);
    expect(await readChatTranscriptAsync(group, convId)).toEqual([
      { type: 'message', content: 'FOREIGN' },
    ]);
  });
});
