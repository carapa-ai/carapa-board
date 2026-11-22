import { describe, expect, test } from 'bun:test';
import { validateLinkedTtsAsset } from './message-speech.js';

const asset = {
  id: 'missing-asset',
  format: 'ogg',
  mimeType: 'audio/ogg',
  durationMs: 1_000,
  sampleRate: 24_000,
  byteLength: 100,
  model: 'test',
  voiceId: 'test',
  language: 'en',
  parameters: {},
  storagePath: 'tts/assets/mi/missing-asset.ogg',
  createdAt: '2026-08-02T00:00:00.000Z',
  lastAccessedAt: '2026-08-02T00:00:00.000Z',
};

describe('linked message speech validation', () => {
  test('keeps a linked asset whose immutable file is present', async () => {
    let invalidated = false;
    const result = await validateLinkedTtsAsset(
      asset,
      async () => undefined,
      async () => {
        invalidated = true;
      },
    );

    expect(result).toBe(asset);
    expect(invalidated).toBe(false);
  });

  test('invalidates a stale database asset when its file is missing', async () => {
    const invalidated: string[] = [];
    const result = await validateLinkedTtsAsset(
      asset,
      async () => {
        throw new Error('ENOENT');
      },
      async (assetId) => {
        invalidated.push(assetId);
      },
    );

    expect(result).toBeUndefined();
    expect(invalidated).toEqual(['missing-asset']);
  });
});
