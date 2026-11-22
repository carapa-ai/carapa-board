export type CsvParseResult =
  | { headers: string[]; rows: Record<string, string>[] }
  // `missingData` marks a file without a header plus at least one data row so
  // callers can show their own wording for it.
  | { error: string; missingData?: true };

/** Splits CSV text into records of fields (RFC 4180 quoting, CRLF or LF). */
function readRecords(text: string): string[][] | { error: string } {
  const records: string[][] = [];
  // Parallel to `records`: true for a blank line (as opposed to a quoted `""`).
  const blank: boolean[] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  // True while only whitespace has been seen for the current unquoted field.
  let atFieldStart = true;

  // A quoted empty field (`""`) is a real value, unlike a blank line.
  let recordHasQuoted = false;

  const endField = () => {
    recordHasQuoted ||= quoted;
    record.push(quoted ? field : field.trim());
    field = '';
    quoted = false;
    atFieldStart = true;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    blank.push(record.length === 1 && record[0] === '' && !recordHasQuoted);
    record = [];
    recordHasQuoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (ch === '"' && atFieldStart) {
      inQuotes = true;
      quoted = true;
      atFieldStart = false;
      field = '';
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else if (quoted && (ch === ' ' || ch === '\t')) {
      // Whitespace after a closing quote is outside the value.
    } else {
      if (ch !== ' ' && ch !== '\t') atFieldStart = false;
      field += ch;
    }
  }
  if (inQuotes) return { error: 'CSV has an unterminated quoted field' };
  if (field !== '' || quoted || record.length > 0) endRecord();

  // Only blank lines around the data are dropped; an interior blank line is an
  // empty record (e.g. an empty value in a single-column file).
  let start = 0;
  let end = records.length;
  while (start < end && blank[start]) start++;
  while (end > start && blank[end - 1]) end--;
  return records.slice(start, end);
}

export function parseCsv(text: string): CsvParseResult {
  const records = readRecords(text.replace(/^﻿/, ''));
  if ('error' in records) return records;
  if (records.length < 2) {
    return {
      error: 'CSV must have a header row and at least one data row',
      missingData: true,
    };
  }

  const headers = records[0];
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) return { error: 'CSV header has an empty column name' };
    if (seen.has(header)) {
      return { error: `CSV header has a duplicate column name "${header}"` };
    }
    seen.add(header);
  }

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const values = records[r];
    if (values.length !== headers.length) {
      return {
        error: `Row ${r + 1} has ${values.length} fields, expected ${headers.length}`,
      };
    }
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i]])));
  }
  return { headers, rows };
}
