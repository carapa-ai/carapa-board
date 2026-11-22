import { afterEach, describe, expect, test } from 'bun:test';
import {
  getLiveModeKind,
  getPersonaLiveSession,
  resetPersonaPlaybackGateForTest,
  setPersonaLiveSession,
} from './playback-gate.js';

afterEach(() => resetPersonaPlaybackGateForTest());

describe('persona live session owner', () => {
  test('tracks one active pacing session until it is disabled', () => {
    setPersonaLiveSession('c1', 'owner', { mode: 'work' });
    expect(getPersonaLiveSession('c1')).toBe('owner');
    expect(getLiveModeKind('c1')).toBe('work');
    setPersonaLiveSession('c1', null);
    expect(getPersonaLiveSession('c1')).toBeUndefined();
  });
});
