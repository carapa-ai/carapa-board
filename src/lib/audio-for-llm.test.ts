import { describe, expect, test } from 'bun:test';
import { isOllamaBackend, isValidWavBuffer } from './audio-for-llm.js';

describe('isOllamaBackend', () => {
  test('detects Ollama proxy URLs', () => {
    expect(isOllamaBackend('http://llama-proxy:11434/v1')).toBe(true);
    expect(isOllamaBackend('http://llama-proxy:8881/v1')).toBe(false);
  });
});

describe('isValidWavBuffer', () => {
  test('validates wav magic bytes', () => {
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    expect(isValidWavBuffer(wav)).toBe(true);
    expect(isValidWavBuffer(Buffer.from('not wav'))).toBe(false);
  });
});
