import { describe, expect, test } from 'bun:test';
import { equivalentTypeScriptPrograms } from './verify-semantic-noop';

describe('semantic TypeScript comparison', () => {
  test('terminates at the unstable scanner EOF token', () => {
    expect(equivalentTypeScriptPrograms('', '', 'empty.ts')).toBe(true);
  });

  test('accepts ordinary comment and whitespace-only edits', () => {
    expect(
      equivalentTypeScriptPrograms(
        'export const value = 1;\n',
        '// explanation\nexport   const value = 1;\n',
        'example.ts',
      ),
    ).toBe(true);
  });

  test('rejects executable edits', () => {
    expect(
      equivalentTypeScriptPrograms(
        'export const value = 1;\n',
        'export const value = 2;\n',
        'example.ts',
      ),
    ).toBe(false);
  });

  test('rejects line-break changes that can affect automatic semicolon insertion', () => {
    expect(
      equivalentTypeScriptPrograms(
        'function value() { return 1; }',
        'function value() { return\n1; }',
        'example.ts',
      ),
    ).toBe(false);
  });

  test.each([
    '// @ts-expect-error\nexport const value = missing;',
    '/// <reference types="bun" />\nexport const value = 1;',
    '/* #__PURE__ */ factory();',
    '// eslint-disable-next-line\nexport const value = 1;',
  ])('rejects compiler and tool directive comments', (after) => {
    expect(
      equivalentTypeScriptPrograms(
        after.replace(/^.*\n/, ''),
        after,
        'example.ts',
      ),
    ).toBe(false);
  });

  test('does not confuse directive-like string contents with comments', () => {
    expect(
      equivalentTypeScriptPrograms(
        'export const value = "@ts-expect-error";',
        '// explanation\nexport const value = "@ts-expect-error";',
        'example.ts',
      ),
    ).toBe(true);
  });

  test.each([
    ['const r = /a b/;', 'const r = /a  b/;', 'example.ts'],
    [
      'const u = `${proto}://old.example.com`;',
      'const u = `${proto}://new.example.com/v2`;',
      'example.ts',
    ],
    ['const s = `${x}, ${y}`;', 'const s = `${x},${y}`;', 'example.ts'],
    ['const v = <p>a b</p>;', 'const v = <p>a  b</p>;', 'example.tsx'],
    ['const v = <p>// a</p>;', 'const v = <p>// b</p>;', 'example.tsx'],
  ])(
    'never treats regex, template or JSX text edits as no-ops',
    (before, after, file) => {
      expect(equivalentTypeScriptPrograms(before, after, file)).toBe(false);
    },
  );
});
