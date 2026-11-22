import { describe, expect, test } from 'bun:test';
import {
  cleanupLiveVoiceResources,
  LiveVoiceDetector,
  StreamingPcmResampler,
} from '../ui/src/lib/live-voice-protocol.js';

describe('Live Mode voice capture', () => {
  test('adaptive capture finalizes ordinary speech after trailing silence', () => {
    const detector = new LiveVoiceDetector({
      sampleRate: 1000,
      trailingSilenceMs: 300,
      minSpeechMs: 100,
    });
    expect(detector.push(0.002, 100)).toBe('silence');
    expect(detector.push(0.04, 100)).toBe('speech-start');
    expect(detector.push(0.04, 100)).toBe('speech');
    expect(detector.push(0.001, 100)).toBe('speech');
    expect(detector.push(0.001, 200)).toBe('finalize');
  });
  test('persistent high audio is forcibly finalized at the utterance bound', () => {
    const detector = new LiveVoiceDetector({
      sampleRate: 1000,
      maxUtteranceMs: 500,
    });
    expect(detector.push(0.04, 100)).toBe('speech-start');
    expect(detector.push(0.04, 300)).toBe('speech');
    expect(detector.push(0.04, 100)).toBe('finalize');
  });
  test('a brief noise spike is discarded after bounded silence without transcription', () => {
    const detector = new LiveVoiceDetector({
      sampleRate: 1000,
      trailingSilenceMs: 300,
      minSpeechMs: 150,
    });
    expect(detector.push(0.04, 50)).toBe('speech-start');
    expect(detector.push(0.001, 100)).toBe('speech');
    expect(detector.push(0.001, 200)).toBe('discard');
    expect(detector.push(0.001, 100)).toBe('silence');
  });
  test('a sustained high-frequency chirp is discarded instead of becoming an utterance', () => {
    const detector = new LiveVoiceDetector({
      sampleRate: 16_000,
      trailingSilenceMs: 300,
    });
    expect(detector.push(0.04, 3200, 0.5)).toBe('speech-start');
    expect(detector.push(0.04, 3200, 0.5)).toBe('speech');
    expect(detector.push(0.001, 4800, 0)).toBe('discard');
  });
  test('speech-like frames still finalize after a normal short phrase', () => {
    const detector = new LiveVoiceDetector({
      sampleRate: 16_000,
      trailingSilenceMs: 300,
    });
    expect(detector.push(0.04, 3200, 0.08)).toBe('speech-start');
    expect(detector.push(0.04, 3200, 0.1)).toBe('speech');
    expect(detector.push(0.001, 4800, 0)).toBe('finalize');
  });
  test('resamples WebView 48 kHz microphone PCM to the 16 kHz wire rate', () => {
    const resampler = new StreamingPcmResampler(48_000, 16_000);
    const first = resampler.push(
      Float32Array.from({ length: 480 }, (_, i) => i),
    );
    const second = resampler.push(
      Float32Array.from({ length: 480 }, (_, i) => i + 480),
    );
    expect(first.length + second.length).toBeGreaterThanOrEqual(319);
    expect(first.length + second.length).toBeLessThanOrEqual(320);
    expect(first[1]).toBeCloseTo(3, 4);
    expect(second.at(-1)).toBeCloseTo(957, 4);
  });
  test('cleanup stops tracks, disconnects nodes, closes context, and is repeatable', async () => {
    let stopped = 0;
    let disconnected = 0;
    let closed = 0;
    const resources = {
      stream: { getTracks: () => [{ stop: () => stopped++ }] },
      node: { disconnect: () => disconnected++ },
      source: { disconnect: () => disconnected++ },
      context: {
        close: async () => {
          closed++;
        },
      },
    };
    cleanupLiveVoiceResources(resources);
    cleanupLiveVoiceResources(resources);
    await Promise.resolve();
    expect(stopped).toBe(2);
    expect(disconnected).toBe(4);
    expect(closed).toBe(2);
  });
});
