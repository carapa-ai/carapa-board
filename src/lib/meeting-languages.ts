/**
 * Meeting recording language options — parsed from MEETING_LANGUAGES env.
 *
 * Format (comma-separated entries, pipe-separated fields):
 *   code|label[|script[|whisper_prompt]]
 *
 * script: latin | cyrillic | any  (default: latin, except code "auto" → any)
 *
 * Example:
 *   auto|Auto-detect|any,ro|Romanian|latin|Transcriere în limba română.,en|English|latin|English meeting transcript.,de|German|latin|Deutsche Besprechung.
 */

export type MeetingLanguageScript = 'latin' | 'cyrillic' | 'any';

export interface MeetingLanguageOption {
  code: string;
  label: string;
  script: MeetingLanguageScript;
  prompt?: string;
}

const DEFAULT_MEETING_LANGUAGES_RAW =
  'auto|Auto-detect|any,ro|Romanian|latin|Transcriere în limba română.,en|English|latin|English meeting transcript.,de|German|latin|Deutsche Besprechung.';

function parseScript(code: string, script?: string): MeetingLanguageScript {
  const s = script?.trim().toLowerCase();
  if (s === 'latin' || s === 'cyrillic' || s === 'any') return s;
  return code === 'auto' ? 'any' : 'latin';
}

export function parseMeetingLanguages(raw?: string): MeetingLanguageOption[] {
  const src = (raw?.trim() || DEFAULT_MEETING_LANGUAGES_RAW).trim();
  if (!src) {
    return [{ code: 'auto', label: 'Auto-detect', script: 'any' }];
  }

  const options: MeetingLanguageOption[] = [];
  for (const entry of src.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|').map((p) => p.trim());
    const code = parts[0];
    const label = parts[1];
    if (!code || !label) continue;
    const script = parseScript(code, parts[2]);
    const prompt = parts.slice(3).join('|').trim() || undefined;
    options.push({ code, label, script, prompt });
  }

  return options.length > 0
    ? options
    : [{ code: 'auto', label: 'Auto-detect', script: 'any' }];
}

export function getMeetingLanguage(
  languages: MeetingLanguageOption[],
  code: string | null | undefined,
): MeetingLanguageOption | undefined {
  const normalized = code?.trim().toLowerCase().split('-')[0];
  if (!normalized) return undefined;
  return languages.find((l) => l.code.toLowerCase() === normalized);
}
