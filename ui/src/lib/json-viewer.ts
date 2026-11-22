/**
 * Pure helpers behind the structured JSON / JSONC / JSONL file preview.
 * No React and no network: parsing, line splitting, and one-line summaries.
 */

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type JsonFileKind = 'document' | 'lines';

/**
 * Strip `//` and `/* *\/` comments and trailing commas with a string-aware
 * scan. Comments become a single space (block comments keep their newlines)
 * so `JSON.parse` error positions stay close to the source.
 */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      out += ' ';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (ch === ',') {
      // Drop the comma when the next significant char closes a container.
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') {
          while (j < n && text[j] !== '\n') j++;
        } else if (text[j] === '/' && text[j + 1] === '*') {
          const end = text.indexOf('*/', j + 2);
          j = end === -1 ? n : end + 2;
        } else break;
      }
      if (text[j] === '}' || text[j] === ']') {
        out += ' ';
      } else {
        out += ',';
      }
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Parse JSON, tolerating comments and trailing commas (JSONC). */
export function parseJsonc(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Fall through to the comment-tolerant pass; its error is the one shown.
  }
  try {
    return { ok: true, value: JSON.parse(stripJsonc(text)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Dispatch is by extension: `.jsonl` is served as `text/plain`. */
export function jsonKindForPath(path: string | undefined): JsonFileKind | null {
  if (!path) return null;
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') return 'document';
  if (ext === 'jsonl' || ext === 'ndjson') return 'lines';
  return null;
}

export interface JsonlRecord {
  /** 1-based line number in the file. */
  line: number;
  raw: string;
  value?: unknown;
  error?: string;
}

/**
 * Split a buffer into JSONL records. The trailing partial line (no newline
 * yet) is returned as `remainder` so the caller can prepend it to the next
 * chunk. Blank lines are skipped but still counted for line numbers.
 */
export function splitJsonlRecords(
  buffer: string,
  firstLineNo: number,
): { records: JsonlRecord[]; remainder: string; nextLineNo: number } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const records: JsonlRecord[] = [];
  let lineNo = firstLineNo;
  for (const rawLine of lines) {
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (raw.trim()) records.push(parseJsonlLine(raw, lineNo));
    lineNo++;
  }
  return { records, remainder, nextLineNo: lineNo };
}

/** Parse a single (possibly unterminated final) JSONL line. */
export function parseJsonlLine(raw: string, line: number): JsonlRecord {
  try {
    return { line, raw, value: JSON.parse(raw) };
  } catch (e) {
    return { line, raw, error: e instanceof Error ? e.message : String(e) };
  }
}

const SUMMARY_KEYS = ['type', 'role', 'subtype', 'name', 'id'] as const;
const SUMMARY_MAX = 120;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function scalarLabel(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || typeof v !== 'object') return String(v);
  return Array.isArray(v) ? `[${v.length}]` : '{…}';
}

/** Short one-line label for a collapsed record. */
export function recordSummary(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return truncate(scalarLabel(value), SUMMARY_MAX);
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  const obj = value as Record<string, unknown>;
  const preferred = SUMMARY_KEYS.filter((k) => k in obj).slice(0, 3);
  const keys = preferred.length > 0 ? preferred : Object.keys(obj).slice(0, 3);
  if (keys.length === 0) return '{}';
  return truncate(
    keys.map((k) => `${k}: ${scalarLabel(obj[k])}`).join(' · '),
    SUMMARY_MAX,
  );
}
