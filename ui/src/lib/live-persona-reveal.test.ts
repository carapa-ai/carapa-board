// @ts-nocheck
import { afterEach, describe, expect, it } from 'bun:test';
import {
  beginLivePersonaReveal,
  bufferLivePersonaChunk,
  clearLivePersonaReveal,
  getLivePersonaRevealState,
  markLivePersonaPlaybackStarted,
  markLivePersonaSynthesizing,
  markLivePersonaThinking,
  markLivePersonaWaiting,
  replaceLivePersonaBuffer,
  releaseLivePersonaReveal,
  resetLivePersonaRevealsForTest,
  updateLivePersonaPlayback,
} from './live-persona-reveal';

afterEach(() => resetLivePersonaRevealsForTest());

describe('Live persona voice reveal', () => {
  it('buffers output without exposing words before playback begins', () => {
    beginLivePersonaReveal('m1', 'c1');
    expect(bufferLivePersonaChunk('m1', 'One two ')).toBe(true);
    expect(bufferLivePersonaChunk('m1', 'three four')).toBe(true);
    markLivePersonaThinking('m1');
    expect(getLivePersonaRevealState('m1')?.phase).toBe('thinking');
    markLivePersonaWaiting('m1');
    expect(getLivePersonaRevealState('m1')).toMatchObject({
      bufferedText: 'One two three four',
      phase: 'waiting',
      revealedWords: 0,
    });
    markLivePersonaSynthesizing('m1');
    expect(getLivePersonaRevealState('m1')?.phase).toBe('preparing');
  });

  it('reveals whole words from audio progress and releases all text on end', () => {
    beginLivePersonaReveal('m1', 'c1');
    bufferLivePersonaChunk('m1', 'One two three four');
    markLivePersonaPlaybackStarted('m1');
    updateLivePersonaPlayback('m1', 0.49);
    expect(getLivePersonaRevealState('m1')).toMatchObject({ phase: 'speaking', revealedWords: 1 });
    updateLivePersonaPlayback('m1', 0.75);
    expect(getLivePersonaRevealState('m1')?.revealedWords).toBe(3);
    releaseLivePersonaReveal('m1');
    expect(getLivePersonaRevealState('m1')).toMatchObject({ phase: 'released', progress: 1, revealedWords: 4 });
  });

  it('replaces streamed deltas with canonical multiline content', () => {
    beginLivePersonaReveal('m-canonical', 'c1');
    bufferLivePersonaChunk('m-canonical', 'First line Second line');
    markLivePersonaPlaybackStarted('m-canonical');

    expect(replaceLivePersonaBuffer('m-canonical', 'First line\n\nSecond line')).toBe(true);
    expect(getLivePersonaRevealState('m-canonical')?.bufferedText)
      .toBe('First line\n\nSecond line');
  });

  it('keeps accumulating visible text after an interruption releases the bubble', () => {
    beginLivePersonaReveal('m1', 'c1');
    bufferLivePersonaChunk('m1', 'Partial');
    releaseLivePersonaReveal('m1');
    bufferLivePersonaChunk('m1', ' response');
    expect(getLivePersonaRevealState('m1')).toMatchObject({
      phase: 'released',
      bufferedText: 'Partial response',
    });
    clearLivePersonaReveal('m1');
    expect(getLivePersonaRevealState('m1')).toBeNull();
  });

  it('does not consume ordinary persona chunks without delayed presentation state', () => {
    expect(bufferLivePersonaChunk('ordinary', 'stream normally')).toBe(false);
  });
});
