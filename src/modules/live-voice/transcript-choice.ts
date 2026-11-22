import { JEV_URL } from '../../config.js';
import { isProbability, jevSystemOneBatch } from '../../lib/jev-client.js';
import { logger } from '../../logger.js';

/** One transcript of a spoken phrase, recognized as `language` (BCP 47). */
export interface TranscriptCandidate {
  language: string;
  text: string;
}

export interface TranscriptChoice extends TranscriptCandidate {
  /** `single`: only one had text; `jev`: Jev chose; `fallback`: the first. */
  decidedBy: 'single' | 'jev' | 'fallback';
}

const TIMEOUT_MS = 3_000;
/**
 * Picks what the user actually said from per-language transcripts of one
 * phrase (Android recognizers understand only the language they are asked
 * for: the wrong language yields nothing or phonetic nonsense such as
 * "buona ziwa to mifacts" for "Bună ziua ce mai faci"). Candidates come in
 * preference order; without Jev the first one with text wins.
 */
export async function chooseTranscript(
  candidates: TranscriptCandidate[],
  projectId?: string,
): Promise<TranscriptChoice> {
  const withText = candidates.filter((candidate) => candidate.text.trim());
  if (withText.length === 0) {
    return {
      language: candidates[0]?.language ?? '',
      text: '',
      decidedBy: 'single',
    };
  }
  if (withText.length === 1) return { ...withText[0]!, decidedBy: 'single' };
  if (!JEV_URL) return { ...withText[0]!, decidedBy: 'fallback' };
  try {
    // Each transcript is rated on its own: asking Jev to pick between them
    // favoured whichever was listed first.
    const results = await jevSystemOneBatch({
      states: withText.map((candidate) => candidate.text),
      questions: {
        meaningful: {
          type: 'noul',
          instructions:
            'Is this a meaningful, coherent phrase that a person would plausibly say to a software assistant (not phonetic nonsense)?',
          criteria: {
            true: 'Meaningful, coherent phrase',
            false: 'Nonsense or garbled words',
          },
        },
      },
      timeoutMs: TIMEOUT_MS,
      projectId,
    });
    const scores = results.map((result) => result.answers.meaningful?.noul);
    if (scores.every(isProbability)) {
      const best = scores.indexOf(Math.max(...(scores as number[])));
      return { ...withText[best]!, decidedBy: 'jev' };
    }
  } catch (err) {
    logger.debug({ err }, 'transcript choice unavailable');
  }
  return { ...withText[0]!, decidedBy: 'fallback' };
}
