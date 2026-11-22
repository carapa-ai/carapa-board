// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  nextPublicReplayMessageId,
  nextPublicReplaySpeakerId,
  publicReplayMessageVisibility,
} from './public-conversation-replay';

describe('public conversation replay helpers', () => {
  const ids = ['before', 'start', 'played', 'current', 'future'];

  test('keeps prior and completed messages visible while hiding the replay tail', () => {
    expect(
      publicReplayMessageVisibility(ids, 'start', 'current', 'before'),
    ).toBe('before');
    expect(
      publicReplayMessageVisibility(ids, 'start', 'current', 'start'),
    ).toBe('complete');
    expect(
      publicReplayMessageVisibility(ids, 'start', 'current', 'played'),
    ).toBe('complete');
    expect(
      publicReplayMessageVisibility(ids, 'start', 'current', 'current'),
    ).toBe('current');
    expect(
      publicReplayMessageVisibility(ids, 'start', 'current', 'future'),
    ).toBe('hidden');
  });

  test('resolves the next message after newly appended arrivals', () => {
    expect(nextPublicReplayMessageId(['a', 'b'], 'a')).toBe('b');
    expect(nextPublicReplayMessageId(['a', 'b', 'new'], 'b')).toBe('new');
    expect(nextPublicReplayMessageId(['a'], 'a')).toBeNull();
  });

  test('prefetches the next speaker while skipping participant messages', () => {
    expect(
      nextPublicReplaySpeakerId(
        [
          { id: 'current', speechAvailable: true },
          { id: 'participant', speechAvailable: false },
          { id: 'next-persona', speechAvailable: true },
          { id: 'later-persona', speechAvailable: true },
        ],
        'current',
      ),
    ).toBe('next-persona');
  });
});
