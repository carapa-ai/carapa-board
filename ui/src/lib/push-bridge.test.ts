// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const bridge = {
  enqueueSpeech: mock(async () => undefined),
  stopSpeech: mock(async () => undefined),
  activateSpeechSession: mock(async () => undefined),
};
// Stay a non-native platform while modules load so unrelated native helpers
// (speech cache pruning) do not start; flip to Android before the tests run.
let android = false;
const realCore = await import('@capacitor/core');
mock.module('@capacitor/core', () => ({
  ...realCore,
  Capacitor: {
    isNativePlatform: () => android,
    getPlatform: () => (android ? 'android' : 'web'),
  },
  registerPlugin: () => bridge,
}));

const { enqueueNativeSpeech, isNativeSpeechPlaying, stopActiveNativeSpeech } =
  await import('./push-bridge');
const { cutOffLiveSpeech, cutOffLiveSpeechForServerStop } =
  await import('./use-tts');

android = true;

beforeEach(async () => {
  bridge.enqueueSpeech.mockClear();
  bridge.stopSpeech.mockClear();
  await stopActiveNativeSpeech();
  bridge.stopSpeech.mockClear();
});

describe('barge-in native speech cut', () => {
  it('cutOffLiveSpeech stops the active native session; server stop does not', async () => {
    await enqueueNativeSpeech('c1', 'm-server', 's1');
    await cutOffLiveSpeechForServerStop();
    expect(bridge.stopSpeech).not.toHaveBeenCalled();
    expect(isNativeSpeechPlaying()).toBe(true);

    await cutOffLiveSpeech();
    expect(bridge.stopSpeech).toHaveBeenCalledTimes(1);
    expect(bridge.stopSpeech).toHaveBeenCalledWith({ sessionId: 's1' });
    // Re-arms the session so the next reply is not rejected as stale.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.activateSpeechSession).toHaveBeenCalledWith({
      sessionId: 's1',
    });
    expect(isNativeSpeechPlaying()).toBe(false);
  });

  it('never re-enqueues a cut message but accepts a new one', async () => {
    await enqueueNativeSpeech('c1', 'm-cut', 's1');
    await stopActiveNativeSpeech();
    bridge.enqueueSpeech.mockClear();

    expect(await enqueueNativeSpeech('c1', 'm-cut', 's1')).toBe(false);
    expect(bridge.enqueueSpeech).not.toHaveBeenCalled();
    expect(await enqueueNativeSpeech('c1', 'm-new', 's1')).toBe(true);
    expect(bridge.enqueueSpeech).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is playing', async () => {
    await stopActiveNativeSpeech();
    expect(bridge.stopSpeech).not.toHaveBeenCalled();
  });
});
