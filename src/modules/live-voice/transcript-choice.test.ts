import { afterEach, describe, expect, test } from 'bun:test';
import {
  jevMockRequests,
  resetJevMock,
  setJevMockHandler,
} from '../../test-utils/jev-mock-server.js';
import { chooseTranscript } from './transcript-choice.js';

afterEach(() => resetJevMock());

const romanian = { language: 'ro-RO', text: 'Bună ziua ce mai faci azi' };
const nonsense = { language: 'en-US', text: 'buona ziwa to mifacts' };

describe('chooseTranscript', () => {
  test('uses the only transcript with text without asking Jev', async () => {
    const before = jevMockRequests().length;
    expect(
      await chooseTranscript([{ language: 'en-US', text: '' }, romanian]),
    ).toEqual({ ...romanian, decidedBy: 'single' });
    expect(jevMockRequests().length).toBe(before);
  });

  test('keeps the transcript Jev rates meaningful, whatever its position', async () => {
    setJevMockHandler(({ body }) => ({
      results: (body.states as string[]).map((state) => ({
        answers: {
          meaningful: {
            type: 'noul',
            noul: state === romanian.text ? 0.98 : 0.25,
          },
        },
      })),
    }));
    expect(await chooseTranscript([nonsense, romanian])).toEqual({
      ...romanian,
      decidedBy: 'jev',
    });
  });

  test('falls back to the first transcript when Jev fails', async () => {
    setJevMockHandler(() => ({ status: 500 }));
    expect(await chooseTranscript([nonsense, romanian])).toEqual({
      ...nonsense,
      decidedBy: 'fallback',
    });
  });
});
