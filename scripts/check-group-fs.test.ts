import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  checkRepo,
  evaluate,
  parseAllowlist,
  scanSource,
  type Allowlist,
  type FileScan,
} from './check-group-fs.js';

const lines = (scan: FileScan): number[] => scan.uses.map((use) => use.line);
const noAllowlist: Allowlist = { files: {}, pathHelpers: [] };

describe('scanSource', () => {
  test('flags raw fs on a group-derived path in an unlisted file', () => {
    const source = `import fs from 'node:fs';\nfs.readFileSync(path.join(getGroupDir(x), 'a'));\n`;
    const scans = new Map([['src/new-file.ts', scanSource(source)]]);
    const violations = evaluate(scans, noAllowlist);
    expect(violations.join('\n')).toContain('src/new-file.ts:2');
    expect(violations.length).toBeGreaterThan(0);
  });

  test('ignores files that do not derive group paths', () => {
    expect(scanSource(`fs.readFileSync('/etc/hosts');`)).toEqual({
      groupDeriving: false,
      uses: [],
    });
  });

  test('ignores comments and string or template literal contents, keeps interpolations', () => {
    const source = [
      'const dir = getGroupDir(x);',
      '// fs.readFileSync(dir)',
      '/* fs.rmSync(dir)',
      '   Bun.file(dir) */',
      `const a = 'fs.statSync(dir)';`,
      'const b = "fs.statSync(dir) \\" fs.statSync(dir)";',
      'const c = `fs.statSync(dir) ${fs.lstatSync(dir)} fs.statSync(dir)`;',
      'const d = /fs.statSync(\\/)/.test(a);',
      'fs.openSync(dir);',
    ].join('\n');
    const scan = scanSource(source);
    expect(scan.groupDeriving).toBe(true);
    expect(lines(scan)).toEqual([7, 9]);
  });

  test('does not treat a division as a regex and tracks nested templates', () => {
    const source = [
      'const dir = getGroupDir(x);',
      'const ratio = a / b; const other = c / d; // fs.statSync(dir)',
      'const nested = `${`${fs.statSync(dir)}`} ${{ a: 1 }.a}`;',
      'fs.rmSync(dir);',
    ].join('\n');
    expect(lines(scanSource(source))).toEqual([3, 4]);
  });

  test('counts calls of names imported from fs modules, including aliases', () => {
    const source = [
      `import { readFileSync as rf, type Stats, existsSync } from 'node:fs';`,
      `import { promises as fsx } from 'fs';`,
      `import * as nodeFs from 'node:fs/promises';`,
      `import type { statSync } from 'fs';`,
      'const dir = getGroupDir(x);',
      'rf(dir);',
      'existsSync(dir);',
      'obj.existsSync(dir);',
      'fsx.readFile(dir);',
      'nodeFs.stat(dir);',
      'statSync(dir);',
    ].join('\n');
    expect(lines(scanSource(source))).toEqual([6, 7, 9, 10]);
  });

  test('counts res.sendFile and Bun.file / Bun.write', () => {
    const source =
      'const dir = groupArtifactsDir(x);\nres.sendFile(dir);\nBun.file(dir);\nawait Bun.write(dir, 1);\n';
    expect(lines(scanSource(source))).toEqual([2, 3, 4]);
  });

  test('a tracked file counts as group-deriving without a group helper mention', () => {
    expect(lines(scanSource(`fs.readdirSync(dir);`, true))).toEqual([1]);
  });

  test('handles CRLF line endings and Unicode', () => {
    const source = `// ünïcode ✓\r\nconst dir = getObjectiveDir('é');\r\nfs.statSync(dir); // ✓\r\n`;
    expect(lines(scanSource(source))).toEqual([3]);
  });
});

describe('evaluate', () => {
  const scan = (count: number): FileScan => ({
    groupDeriving: true,
    uses: Array.from({ length: count }, (_, index) => ({
      line: index + 1,
      text: 'fs.statSync(x)',
    })),
  });
  const allowlistWith = (max: number): Allowlist => ({
    files: { 'src/a.ts': { max, reason: 'board-owned only' } },
    pathHelpers: [],
  });

  test('accepts an allowlisted file at its max and unlisted files without raw uses', () => {
    const scans = new Map([
      ['src/a.ts', scan(2)],
      ['src/b.ts', scan(0)],
    ]);
    expect(evaluate(scans, allowlistWith(2))).toEqual([]);
  });

  test('fails when an allowlisted file exceeds max and prints file:line', () => {
    const violations = evaluate(
      new Map([['src/a.ts', scan(3)]]),
      allowlistWith(2),
    );
    expect(violations[0]).toContain('exceed allowlisted max 2');
    expect(violations.join('\n')).toContain('src/a.ts:3');
  });

  test('ratchet: fails when an allowlisted file is below max', () => {
    const violations = evaluate(
      new Map([['src/a.ts', scan(1)]]),
      allowlistWith(2),
    );
    expect(violations[0]).toContain('lower max to 1');
  });

  test('fails for allowlist and pathHelpers entries of files outside the scan set', () => {
    const allowlist: Allowlist = {
      ...allowlistWith(1),
      pathHelpers: ['src/helper.ts'],
    };
    const violations = evaluate(new Map(), allowlist);
    expect(violations.join('\n')).toContain('src/a.ts: remove stale entry');
    expect(violations.join('\n')).toContain(
      'src/helper.ts: remove stale pathHelpers entry',
    );
  });

  test('rejects a malformed allowlist', () => {
    expect(() =>
      parseAllowlist({ files: { 'src/a.ts': { max: 1 } }, pathHelpers: [] }),
    ).toThrow('reason');
    expect(() =>
      parseAllowlist({
        files: { 'src/a.ts': { max: -1, reason: 'x' } },
        pathHelpers: [],
      }),
    ).toThrow('max');
    expect(() => parseAllowlist({ files: {} })).toThrow('expected');
  });
});

describe('repository scan', () => {
  test('has zero violations and finishes quickly', () => {
    const started = performance.now();
    expect(checkRepo(path.resolve(import.meta.dir, '..'))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
