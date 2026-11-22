import { describe, expect, test } from 'bun:test';
import {
  isImplausibleShortAudioTranscript,
  isTranscriptionPromptEcho,
  wavDurationMs,
} from './audio-transcript-guard.js';

function wav(durationMs: number): Buffer {
  const byteRate = 32_000;
  const dataBytes = Math.round((byteRate * durationMs) / 1000);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

describe('short audio transcript guard', () => {
  test('rejects a long sentence attributed to sub-second audio', () => {
    expect(wavDurationMs(wav(500))).toBeCloseTo(500, 0);
    expect(
      isImplausibleShortAudioTranscript(
        wav(500),
        'This is a suspiciously long invented sentence about an unrelated subject.',
      ),
    ).toBe(true);
  });

  test('keeps short confirmations and does not constrain longer audio', () => {
    expect(isImplausibleShortAudioTranscript(wav(500), 'Da.')).toBe(false);
    expect(
      isImplausibleShortAudioTranscript(
        wav(1500),
        'This longer sentence is plausible for the captured duration.',
      ),
    ).toBe(false);
  });

  test('rejects exact and near-exact transcription prompt echoes', () => {
    const prompt =
      'Transcribe this voice message verbatim. Output only the spoken words, in the original language, with no commentary.';
    expect(isTranscriptionPromptEcho(prompt, prompt)).toBe(true);
    expect(
      isTranscriptionPromptEcho(
        'Transcribe this voice message verbatim; output only the spoken words.',
        prompt,
      ),
    ).toBe(false);
    expect(isTranscriptionPromptEcho('Să încercăm alt mesaj.', prompt)).toBe(
      false,
    );
  });
});
