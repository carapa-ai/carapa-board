import { JEV_URL } from '../../config.js';
import { isProbability, jevSystemOne } from '../../lib/jev-client.js';
import { logger } from '../../logger.js';
import { SUPERTONIC_LANGUAGES, TTS_DETECT_LANGUAGES } from './config.js';

/** Below this, the most likely other language must be confirmed. */
const MIN_PROBABILITY = 0.8;
/** Confirming English phrases scored 0.97+, Romanian ones under 0.1. */
const MIN_CONFIRMATION = 0.9;
const MAX_STATE_CHARS = 2_000;
const TIMEOUT_MS = 3_000;
/** Jev rejects a choice with ~25+ labels (HTTP 413). */
const MAX_LABELS = 20;

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
/** The server voice must be able to speak the result, whatever the engine. */
const speakable = new Set<string>(SUPERTONIC_LANGUAGES);

function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Jev's probability for each of `labels`, most likely first. */
async function rankLanguages(
  text: string,
  labels: string[],
  projectId?: string,
): Promise<{ label: string; probability: number }[]> {
  const { answers } = await jevSystemOne({
    state: text.slice(0, MAX_STATE_CHARS),
    questions: {
      language: {
        type: 'choice',
        instructions: 'Which language is this text written in?',
        criteria: Object.fromEntries(
          labels.map((label) => [label, languageNames.of(label) ?? label]),
        ),
      },
    },
    timeoutMs: TIMEOUT_MS,
    projectId,
  });
  const answer = answers.language;
  const probabilities = answer?.probabilities ?? {
    [answer?.choice ?? '']: answer?.answer_confidence,
  };
  return labels
    .map((label) => ({ label, probability: probabilities[label] }))
    .filter((entry): entry is { label: string; probability: number } =>
      isProbability(entry.probability),
    )
    .sort((a, b) => b.probability - a.probability);
}

/** How sure Jev is that `text` is written in `label`, asked on its own. */
async function confirmLanguage(
  text: string,
  label: string,
  projectId?: string,
): Promise<number> {
  const name = languageNames.of(label) ?? label;
  const { answers } = await jevSystemOne({
    state: text.slice(0, MAX_STATE_CHARS),
    questions: {
      language: {
        type: 'noul',
        instructions: `Is this text written in ${name}?`,
        criteria: {
          true: `Written in ${name}`,
          false: 'Written in another language',
        },
      },
    },
    timeoutMs: TIMEOUT_MS,
    projectId,
  });
  const probability = answers.language?.noul;
  return isProbability(probability) ? probability : 0;
}

/**
 * The language `text` is written in, chosen by Jev among the `preferred`
 * languages (configured one first) and TTS_DETECT_LANGUAGES. Returns null when
 * Jev is not configured, unavailable, refused by privacy mode, or not
 * confident, so callers keep the configured language. Only languages the
 * server voice supports are candidates, so a fallback can always speak it.
 *
 * Jev favours the labels listed first, so short English ("Identity answer")
 * scored about 0.5 behind a Romanian persona's language, and reordering the
 * labels gave answers that changed between runs. When unsure, the most likely
 * language other than the configured one is used only if Jev confirms it on
 * its own ("Is this text written in English?"), which is stable and decisive.
 */
export async function detectSpeechLanguage(
  text: string,
  preferred: string[],
  projectId?: string,
): Promise<string | null> {
  const labels = [
    ...new Set([...preferred, ...TTS_DETECT_LANGUAGES].map(baseLanguage)),
  ]
    .filter((code) => speakable.has(code) && code !== 'na')
    .slice(0, MAX_LABELS);
  if (labels.length < 2 || !JEV_URL || !text.trim()) return null;
  try {
    const ranked = await rankLanguages(text, labels, projectId);
    if (!ranked[0]) return null;
    if (ranked[0].probability >= MIN_PROBABILITY) return ranked[0].label;
    const candidate = ranked.find((entry) => entry.label !== labels[0]);
    if (!candidate) return null;
    const confirmed = await confirmLanguage(text, candidate.label, projectId);
    return confirmed >= MIN_CONFIRMATION ? candidate.label : null;
  } catch (err) {
    logger.debug({ err }, 'speech language detection unavailable');
    return null;
  }
}
