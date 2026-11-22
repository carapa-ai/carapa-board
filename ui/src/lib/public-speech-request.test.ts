// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { PublicSpeechRequestGate } from './public-speech-request';

describe('PublicSpeechRequestGate', () => {
  test('starting a new request aborts and invalidates the previous request', () => {
    const gate = new PublicSpeechRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(first.signal.aborted).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  test('cancel invalidates an in-flight request', () => {
    const gate = new PublicSpeechRequestGate();
    const request = gate.begin();

    gate.cancel();

    expect(request.signal.aborted).toBe(true);
    expect(gate.isCurrent(request)).toBe(false);
  });

  test('releasing a completed request does not invalidate a newer request', () => {
    const gate = new PublicSpeechRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    gate.release(first);

    expect(gate.isCurrent(second)).toBe(true);
  });
});
