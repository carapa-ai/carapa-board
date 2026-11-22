/**
 * TTS text normalizer — turns a raw assistant reply into clean, speech-ready
 * sentences before synthesis.
 *
 * One shared prompt template + a per-language data block (abbreviation map +
 * language name). The LLM does number-to-words, currency estimation, URL/long-
 * number masking, abbreviation expansion, and sentence segmentation in the
 * target language. Everything degrades gracefully: if normalization is disabled,
 * not worth it, or the LLM call fails, we fall back to a plain sentence split so
 * TTS never breaks.
 *
 * The LLM is the project's configured default chat agent — but ONLY when that is
 * a direct LLM (`llm:*`), never a sandboxed runAgent (Claude/Codex CLI). Falls
 * back to deterministic sentence splitting.
 */

import { logger } from '../../logger.js';
import { llmComplete } from '../../lib/llm-client.js';
import {
  getProjectPrivacyMode,
  requiresLocal,
} from '../../lib/privacy-policy.js';
import {
  getDefaultRuntimeSelection,
  isDirectRuntime,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import { getGroupByFolder } from '../../state-manager.js';
import { stripToolActivityMarkers } from '../../stream/agent-display.js';
import type { LLMEndpointConfig } from '../memory/config.js';
import { ENABLE_TTS_NORMALIZE, SUPERTONIC_EXPRESSIONS } from './config.js';
import { chunkForTts } from './chunker.js';

// ── per-language data ────────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ro: 'Romanian',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  el: 'Greek',
  cs: 'Czech',
  sk: 'Slovak',
  hu: 'Hungarian',
  bg: 'Bulgarian',
  hr: 'Croatian',
  sl: 'Slovenian',
  et: 'Estonian',
  lv: 'Latvian',
  lt: 'Lithuanian',
  id: 'Indonesian',
  vi: 'Vietnamese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
  hi: 'Hindi',
};

// Authoritative expansions for the abbreviations that matter most per language.
// The LLM handles the long tail; these keep the important ones exact + consistent.
const LANG_ABBR: Record<string, Record<string, string>> = {
  ro: {
    'ș.a.': 'și altele',
    'ș.a.m.d.': 'și așa mai departe',
    'etc.': 'etcetera',
    'de ex.': 'de exemplu',
    'd.p.d.v.': 'din punct de vedere',
    'nr.': 'numărul',
    'î.Hr.': 'înainte de Hristos',
    'd.Hr.': 'după Hristos',
  },
  de: {
    MwSt: 'Mehrwertsteuer',
    'MwSt.': 'Mehrwertsteuer',
    'usw.': 'und so weiter',
    'u.s.w.': 'und so weiter',
    'u.a.': 'unter anderem',
    'z.B.': 'zum Beispiel',
    'd.h.': 'das heißt',
    'bzw.': 'beziehungsweise',
    'ca.': 'circa',
    'Nr.': 'Nummer',
    'inkl.': 'inklusive',
    'ggf.': 'gegebenenfalls',
    'evtl.': 'eventuell',
  },
  en: {
    'e.g.': 'for example',
    'i.e.': 'that is',
    'etc.': 'etcetera',
    'approx.': 'approximately',
    'no.': 'number',
    'vs.': 'versus',
  },
};

function abbrBlock(lang: string): string {
  const map = LANG_ABBR[lang] || LANG_ABBR.en;
  const lines = Object.entries(map).map(([k, v]) => `  ${k} → ${v}`);
  return lines.join('\n');
}

function buildPrompt(lang: string): string {
  const langName = LANG_NAMES[lang] || lang;
  return `You rewrite assistant chat replies into clean text for a text-to-speech engine that speaks ${langName}.

Output ONLY the spoken text, ONE natural sentence per line. No preamble, no markdown, no quotes, no bullet points.

Rules (apply in ${langName}):
- Preserve the meaning and wording; only change what affects how it is SPOKEN.
- Numbers with fewer than 5 digits: write them out as words in ${langName} (e.g. 273 → the ${langName} words for "two hundred seventy-three").
- Long numbers (5+ digits), IDs, hashes, phone numbers: replace with the ${langName} word for "number".
- Currencies and large amounts: estimate naturally (e.g. $3,024,000 → the ${langName} for "about three million dollars").
- URLs, emails, and file paths: replace with the ${langName} word for "link".
- Expand abbreviations to full words. Use these exact expansions when present:
${abbrBlock(lang)}
- Split into natural sentences for streaming playback, one per line. Aim for roughly 10-25 words per line, and merge very short fragments into a neighbouring sentence so clips are not tiny (fewer, fuller clips play more smoothly). Keep the FIRST line short so playback can start quickly.
- Remove emojis and decorative symbols.
- If there is no speakable content, output nothing.`;
}

// ── speakable extraction (strip markdown + blockquotes) ──────────────────────
// Tool calls, bash output, thinking, and errors render as markdown blockquotes;
// the reply prose never is. Mirror of the client-side strip in lib/use-tts.ts.

function toSpeakable(s: string): string {
  const withoutCode = stripToolActivityMarkers(s).replace(
    /```[\s\S]*?```/g,
    '\n',
  );
  const withoutQuotes = withoutCode
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return withoutQuotes
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain sentence split (the no-LLM fallback), packed to <= maxChars. */
function splitSentences(text: string, maxChars = 240): string[] {
  return chunkForTts(text, maxChars);
}

// Worth an LLM pass only when there are digits, URLs/emails, currency, or
// abbreviation-like dotted tokens to fix.
function needsNormalization(text: string): boolean {
  return /\d|https?:\/\/|www\.|@|[€$£¥]|[\p{L}]\.[\p{L}]/u.test(text);
}

// ── project LLM resolution ───────────────────────────────────────────────────

export function directLlmAgent(
  agent: ReturnType<typeof resolveRuntimeSelection>,
): { agentId: string; baseUrl: string } | undefined {
  const baseUrl =
    agent?.baseUrl ||
    agent?.env?.OPENAI_BASE_URL ||
    agent?.env?.ANTHROPIC_BASE_URL;
  return isDirectRuntime(agent) && baseUrl
    ? { agentId: agent.id, baseUrl }
    : undefined;
}

function resolveLlmAgent(
  projectId?: string,
): { agentId: string; baseUrl: string } | undefined {
  const group = projectId ? getGroupByFolder(projectId) : undefined;
  const agent = resolveRuntimeSelection(
    group?.settings?.chatRuntimeSelection || getDefaultRuntimeSelection('chat'),
  );
  return directLlmAgent(agent);
}

// ── cache (bounded LRU) ──────────────────────────────────────────────────────

const cache = new Map<string, string[]>();
const CACHE_MAX = 500;
function cacheGet(key: string): string[] | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v?.slice();
}
function cacheSet(key: string, val: string[]): void {
  cache.set(key, val.slice());
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export interface PrepareResult {
  sentences: string[];
  normalized: boolean;
}

/** Prepare a raw assistant reply into speech-ready sentences. Never throws. */
export async function prepareForTts(
  rawText: string,
  lang: string,
  projectId?: string,
): Promise<PrepareResult> {
  const clean = toSpeakable(rawText);
  if (!clean) return { sentences: [], normalized: false };

  // Expression tags are provider control tokens. Normalize only the prose
  // around them, then restore each validated tag at the same boundary so an
  // LLM cleanup pass can never translate, reorder, or drop it.
  const expressionAlternation = SUPERTONIC_EXPRESSIONS.join('|');
  const expressionTag = new RegExp(`<(?:${expressionAlternation})>`, 'i');
  if (expressionTag.test(clean)) {
    const pieces = clean.split(
      new RegExp(`(<(?:${expressionAlternation})>)`, 'gi'),
    );
    const sentences: string[] = [];
    let pending = '';
    let normalized = false;
    for (const piece of pieces) {
      if (!piece.trim()) continue;
      if (
        new RegExp(`^<(?:${expressionAlternation})>$`, 'i').test(piece.trim())
      ) {
        pending += piece.trim();
        continue;
      }
      const prepared = await prepareForTts(piece, lang, projectId);
      normalized ||= prepared.normalized;
      if (prepared.sentences.length > 0 && pending) {
        prepared.sentences[0] = `${pending} ${prepared.sentences[0]}`;
        pending = '';
      }
      sentences.push(...prepared.sentences);
    }
    if (pending && sentences.length > 0)
      sentences[sentences.length - 1] += ` ${pending}`;
    return { sentences, normalized };
  }

  const key = `${lang} ${clean}`;
  // Restricted projects must consult the current runtime's egress guard, even
  // when another project (or an earlier configuration) populated the cache.
  const privacyPurpose = projectId ? 'helper' : 'unknown';
  const cacheAllowed = !requiresLocal(
    getProjectPrivacyMode(projectId),
    privacyPurpose,
  );
  const cached = cacheAllowed ? cacheGet(key) : undefined;
  if (cached) return { sentences: cached, normalized: true };

  // Skip the LLM when disabled, when there's nothing to normalize, or when the
  // text is very long (cost/latency guard) — plain sentence split instead.
  if (
    !ENABLE_TTS_NORMALIZE ||
    clean.length > 4000 ||
    !needsNormalization(clean)
  ) {
    return { sentences: splitSentences(clean), normalized: false };
  }

  const agent = resolveLlmAgent(projectId);
  if (!agent) return { sentences: splitSentences(clean), normalized: false };

  try {
    const config: LLMEndpointConfig = {
      agentId: agent.agentId,
      // Generous last-resort fallback for runtimes whose profile defines no
      // max_tokens: thinking models consume hidden reasoning tokens from the
      // same output budget, so a small cap truncates before any output.
      // A profile-defined max_tokens always wins over this fallback.
      maxTokens: 32768,
    };
    const { content } = await llmComplete(config, buildPrompt(lang), clean, {
      baseUrlOverride: agent.baseUrl,
      projectId,
      privacyPurpose,
    });
    const sentences = content
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length === 0)
      return { sentences: splitSentences(clean), normalized: false };
    if (cacheAllowed) cacheSet(key, sentences);
    return { sentences, normalized: true };
  } catch (err) {
    logger.warn(
      { err, agentId: agent.agentId, lang },
      'tts normalize failed; falling back to plain split',
    );
    return { sentences: splitSentences(clean), normalized: false };
  }
}
