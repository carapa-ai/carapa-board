import { describe, expect, test } from 'bun:test';
import {
  mergeMeetingTranscripts,
  sanitizeMeetingTranscriptChunk,
} from './meeting-transcript.js';

test('strips mixed Cyrillic noise once a Latin meeting context is established', () => {
  expect(
    sanitizeMeetingTranscriptChunk(
      'Continuăm обсуждение proiectului.',
      'Discutăm planul proiectului în limba română.',
    ),
  ).toBe('Continuăm proiectului.');
});

describe('mergeMeetingTranscripts', () => {
  test('deduplicates resumed transcript content before artifact persistence', () => {
    expect(
      mergeMeetingTranscripts(
        'Introducere. Prima parte.',
        'Prima parte. Partea a doua.',
      ),
    ).toBe('Introducere. Prima parte.\n\nPartea a doua.');

    expect(
      mergeMeetingTranscripts(
        'Introducere. Prima parte.',
        'Introducere. Prima parte.',
      ),
    ).toBe('Introducere. Prima parte.');
  });
});
