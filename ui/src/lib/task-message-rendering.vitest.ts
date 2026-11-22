import { describe, expect, it } from 'vitest';

import {
  DEFERRED_TASK_MESSAGE_CHARS,
  TASK_OUTPUT_TAIL_PAGE_BYTES,
  clipTaskOutputPageEntryToGap,
  createTaskOutputWindow,
  seedTaskOutputTailWindow,
  taskOutputWindowGaps,
} from './task-message-rendering';

const encoder = new TextEncoder();

describe('seedTaskOutputTailWindow', () => {
  it('seeds a 1.6 MB single-line backtick message with one tail entry and a gap from 0', () => {
    const content = '`x`'.repeat(550_000);
    expect(content.length).toBeGreaterThan(1_600_000);

    const seed = seedTaskOutputTailWindow('message:big', content);
    expect(seed).not.toBeNull();
    expect(seed!.entries).toHaveLength(1);

    const [entry] = seed!.entries;
    expect(encoder.encode(entry.content).byteLength).toBeLessThanOrEqual(
      TASK_OUTPUT_TAIL_PAGE_BYTES,
    );
    expect(entry.endOffset - entry.startOffset).toBe(
      encoder.encode(entry.content).byteLength,
    );
    expect(entry.endOffset).toBe(seed!.totalEndOffset);
    expect(seed!.totalEndOffset).toBe(encoder.encode(content).byteLength);

    // The uncovered prefix must surface as a pageable gap starting at 0.
    const window = createTaskOutputWindow(seed!.entries, seed!.totalEndOffset);
    expect(window.entries).toHaveLength(1);
    const gaps = taskOutputWindowGaps(window);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.startOffset).toBe(0);
    expect(gaps[0]!.endOffset).toBe(entry.startOffset);
    expect(entry.startOffset).toBeGreaterThan(0);
  });

  it('returns null for a 100 KB message so it renders whole with no gap', () => {
    const content = 'y'.repeat(100 * 1024);
    expect(content.length).toBeLessThan(DEFERRED_TASK_MESSAGE_CHARS);
    expect(seedTaskOutputTailWindow('message:small', content)).toBeNull();
  });

  it('never splits multi-byte characters at the tail boundary', () => {
    // B = 5 trailing bytes forces the 32768-byte cut into the middle of an
    // emoji run (offset into the run is 1 mod 4).
    const content =
      'a'.repeat(DEFERRED_TASK_MESSAGE_CHARS + 1) + '😀'.repeat(9000) + 'bbbbb';
    const seed = seedTaskOutputTailWindow('message:emoji', content);
    expect(seed).not.toBeNull();

    const [entry] = seed!.entries;
    const tailBytes = encoder.encode(entry.content);
    expect(tailBytes.byteLength).toBeLessThanOrEqual(
      TASK_OUTPUT_TAIL_PAGE_BYTES,
    );
    expect(entry.endOffset - entry.startOffset).toBe(tailBytes.byteLength);
    expect(entry.content).not.toContain('�');
    expect(entry.content.startsWith('😀')).toBe(true);

    const mixed =
      'z'.repeat(DEFERRED_TASK_MESSAGE_CHARS + 1) + 'äöü'.repeat(12_000);
    const mixedSeed = seedTaskOutputTailWindow('message:umlaut', mixed);
    expect(mixedSeed).not.toBeNull();
    expect(mixedSeed!.entries[0]!.content).not.toContain('�');
    expect(
      encoder.encode(mixedSeed!.entries[0]!.content).byteLength,
    ).toBeLessThanOrEqual(TASK_OUTPUT_TAIL_PAGE_BYTES);
    expect(
      mixedSeed!.entries[0]!.endOffset - mixedSeed!.entries[0]!.startOffset,
    ).toBe(encoder.encode(mixedSeed!.entries[0]!.content).byteLength);
  });

  it('keeps a byte-order mark at the tail cut so the entry survives validation', () => {
    // The U+FEFF (3 bytes) starts exactly at the tail cut, so the default
    // decoder would strip it and the entry would no longer match its offsets.
    const content =
      'a'.repeat(DEFERRED_TASK_MESSAGE_CHARS + 1) +
      '\uFEFF' +
      'b'.repeat(TASK_OUTPUT_TAIL_PAGE_BYTES - 3);
    const seed = seedTaskOutputTailWindow('message:bom', content);
    expect(seed).not.toBeNull();

    const [entry] = seed!.entries;
    expect(entry.content.startsWith('\uFEFF')).toBe(true);
    expect(createTaskOutputWindow(seed!.entries).entries).toHaveLength(1);
  });
});

describe('clipTaskOutputPageEntryToGap', () => {
  it('clips a whole-message page entry to one page ending at the gap', () => {
    const content = '`x`'.repeat(550_000);
    const totalBytes = encoder.encode(content).byteLength;
    const entry = {
      id: 'message:big',
      content,
      startOffset: 0,
      endOffset: totalBytes,
    };
    const tailStart = totalBytes - TASK_OUTPUT_TAIL_PAGE_BYTES;
    const clipped = clipTaskOutputPageEntryToGap(entry, {
      startOffset: 0,
      endOffset: tailStart,
    });
    expect(clipped).not.toBeNull();
    // Distinct id so the merge cannot overwrite the seeded tail.
    expect(clipped!.id).not.toBe(entry.id);
    expect(clipped!.endOffset).toBe(tailStart);
    expect(tailStart - clipped!.startOffset).toBeLessThanOrEqual(
      TASK_OUTPUT_TAIL_PAGE_BYTES,
    );
    expect(clipped!.endOffset - clipped!.startOffset).toBe(
      encoder.encode(clipped!.content).byteLength,
    );
    // A clipped slice plus the untouched tail stays a valid window.
    const window = createTaskOutputWindow(
      [
        clipped!,
        {
          id: 'message:big',
          content: content.slice(-TASK_OUTPUT_TAIL_PAGE_BYTES),
          startOffset: tailStart,
          endOffset: totalBytes,
        },
      ],
      totalBytes,
    );
    expect(window.entries).toHaveLength(2);
    expect(taskOutputWindowGaps(window)[0]!.startOffset).toBe(0);
  });

  it('returns fitting entries unchanged and null outside the gap', () => {
    const fitting = {
      id: 'page:0:1000',
      content: 'abc',
      startOffset: 100,
      endOffset: 103,
    };
    expect(
      clipTaskOutputPageEntryToGap(fitting, {
        startOffset: 0,
        endOffset: 1000,
      }),
    ).toBe(fitting);
    expect(
      clipTaskOutputPageEntryToGap(
        { id: 'newer', content: 'zz', startOffset: 30, endOffset: 32 },
        { startOffset: 10, endOffset: 20 },
      ),
    ).toBeNull();
  });

  it('cuts both slice ends at UTF-8 boundaries', () => {
    const content = '😀'.repeat(50_000);
    const totalBytes = encoder.encode(content).byteLength;
    const entry = {
      id: 'message:emoji',
      content,
      startOffset: 0,
      endOffset: totalBytes,
    };
    // Odd gap end forces both the start and the end of the slice into the
    // middle of an emoji (offsets are 1 mod 4).
    const gapEnd = 150_001;
    const clipped = clipTaskOutputPageEntryToGap(entry, {
      startOffset: 0,
      endOffset: gapEnd,
    });
    expect(clipped).not.toBeNull();
    expect(clipped!.content).not.toContain('�');
    expect(clipped!.endOffset % 4).toBe(0);
    expect(clipped!.startOffset % 4).toBe(0);
    expect(clipped!.endOffset - clipped!.startOffset).toBe(
      encoder.encode(clipped!.content).byteLength,
    );
    expect(clipped!.endOffset - clipped!.startOffset).toBeLessThanOrEqual(
      TASK_OUTPUT_TAIL_PAGE_BYTES,
    );
  });
});
