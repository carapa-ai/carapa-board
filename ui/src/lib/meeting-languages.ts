export interface MeetingLanguageOption {
  code: string;
  label: string;
  script: 'latin' | 'cyrillic' | 'any';
  prompt?: string;
}

const STORAGE_KEY = 'carapa-meeting-language';

export function meetingLanguageLabel(
  languages: MeetingLanguageOption[],
  code: string | null | undefined,
): string {
  const normalized = code?.trim().toLowerCase().split('-')[0];
  const match = languages.find((l) => l.code.toLowerCase() === normalized);
  return match?.label ?? code ?? 'Auto-detect';
}

export function saveMeetingLanguage(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
}
