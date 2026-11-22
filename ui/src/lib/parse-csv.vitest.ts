import { describe, expect, it } from 'vitest';
import { parseCsv } from './parse-csv';

describe('parseCsv', () => {
  it('keeps commas inside quoted fields', () => {
    expect(
      parseCsv('name,city\n"Smith, John",Berlin\n"Doe, Jane","Munich"'),
    ).toEqual({
      headers: ['name', 'city'],
      rows: [
        { name: 'Smith, John', city: 'Berlin' },
        { name: 'Doe, Jane', city: 'Munich' },
      ],
    });
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a,b\n"say ""hi""",x')).toMatchObject({
      rows: [{ a: 'say "hi"', b: 'x' }],
    });
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toMatchObject({
      rows: [{ a: 'line1\nline2', b: 'x' }],
    });
  });

  it('handles CRLF line endings and a trailing blank line', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4\r\n\r\n')).toMatchObject({
      rows: [
        { a: '1', b: '2' },
        { a: '3', b: '4' },
      ],
    });
  });

  it('strips a leading BOM and trims whitespace outside quotes', () => {
    expect(parseCsv('﻿a , b\n 1 , " 2 " ')).toEqual({
      headers: ['a', 'b'],
      rows: [{ a: '1', b: ' 2 ' }],
    });
  });

  it('reports the row number of a ragged row', () => {
    expect(parseCsv('a,b\n1,2\n3,4,5')).toEqual({
      error: 'Row 3 has 3 fields, expected 2',
    });
  });

  it('rejects duplicate and empty header names', () => {
    expect(parseCsv('a,a\n1,2')).toHaveProperty('error');
    expect(parseCsv('a,\n1,2')).toHaveProperty('error');
  });

  it('flags a header-only file as missing data', () => {
    expect(parseCsv('a,b\n')).toMatchObject({ missingData: true });
    expect(parseCsv('')).toMatchObject({ missingData: true });
  });

  it('keeps interior empty records but drops surrounding blank lines', () => {
    const rows = [{ name: 'Alice' }, { name: '' }, { name: 'Bob' }];
    expect(parseCsv('name\nAlice\n""\nBob\n\n')).toMatchObject({ rows });
    expect(parseCsv('\nname\nAlice\n\nBob\n\n')).toMatchObject({ rows });
    expect(parseCsv('""\nAlice\nBob')).toHaveProperty('error');
  });

  it('rejects an unterminated quote', () => {
    expect(parseCsv('a,b\n"1,2')).toHaveProperty('error');
  });
});
