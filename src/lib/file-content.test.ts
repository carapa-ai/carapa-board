/**
 * Tests for the path-safety helpers in src/lib/file-content.ts. The
 * `safeResolve` function underpins the security boundary for both new
 * file-content endpoints — these tests pin the behaviour so a future
 * refactor can't quietly introduce a traversal bug.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  isSafeRelativePath,
  safeResolve,
  resolveContainedRealPath,
  isContainedWritePath,
  readContainedText,
  mimetypeForPath,
  detectMimetype,
  detectMimetypeForFile,
  isActiveContentMimetype,
  isSafeTextBuffer,
  isTextMimetype,
  parseChunkParams,
  applyUtf8SafeWindow,
} from './file-content.js';

describe('isSafeRelativePath', () => {
  test('accepts plain relative paths', () => {
    expect(isSafeRelativePath('foo.txt')).toBe(true);
    expect(isSafeRelativePath('src/lib/x.ts')).toBe(true);
    expect(isSafeRelativePath('a/b/c.md')).toBe(true);
  });

  test('rejects empty / non-string', () => {
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath(undefined)).toBe(false);
    expect(isSafeRelativePath(null)).toBe(false);
    expect(isSafeRelativePath(42)).toBe(false);
  });

  test('rejects null bytes', () => {
    expect(isSafeRelativePath('foo\0bar')).toBe(false);
  });

  test('rejects absolute paths', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('C:/Windows')).toBe(false);
    expect(isSafeRelativePath('D:\\Users')).toBe(false);
  });

  test('rejects traversal segments', () => {
    expect(isSafeRelativePath('../foo')).toBe(false);
    expect(isSafeRelativePath('a/../b')).toBe(false);
    expect(isSafeRelativePath('a/../../b')).toBe(false);
  });

  test('accepts single-dot segments (path.resolve normalises them)', () => {
    // `.` is harmless — path.resolve drops it; `..` is the actual hazard.
    expect(isSafeRelativePath('./foo')).toBe(true);
    expect(isSafeRelativePath('a/./b')).toBe(true);
  });
});

describe('safeResolve', () => {
  test('returns the base itself when relPath is empty', () => {
    const base = '/srv/group';
    expect(safeResolve(base, '')).toBe(path.resolve(base));
  });

  test('throws on traversal that escapes the base', () => {
    expect(() => safeResolve('/srv/group', '../etc/passwd')).toThrow(
      /escapes/i,
    );
  });

  test('rejects sibling whose name shares a prefix with the base', () => {
    // The previous implementation concatenated `path.sep` unconditionally,
    // but the bigger risk is the inverse: without a separator suffix the
    // base would claim any path that starts with the base's text. The fixed
    // implementation must require a separator for non-root bases.
    expect(() => safeResolve('/srv/group', '../groupX/secret')).toThrow(
      /escapes/i,
    );
  });

  test('handles a root base (POSIX) without falsely rejecting all paths', () => {
    // Regression: the old implementation computed `path.resolve('/') + path.sep`
    // = `'//'`, which never matches a real path prefix, so EVERY call threw.
    // The fix special-cases separator-terminated bases.
    const resolved = safeResolve('/', 'foo/bar.txt');
    expect(resolved).toBe(path.resolve('/foo/bar.txt'));
  });
});

describe('resolveContainedRealPath', () => {
  let tmp: string;
  let base: string;
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rcrp-')));
    base = path.join(tmp, 'base');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(base, 'real.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(
      path.join(outside, 'secret.txt'),
      path.join(base, 'link-out'),
    );
    fs.symlinkSync(outside, path.join(base, 'dirlink'));
    fs.symlinkSync('real.txt', path.join(base, 'inner-link'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('returns the real path for regular files and in-base symlinks', async () => {
    const real = path.join(base, 'real.txt');
    expect(await resolveContainedRealPath(base, 'real.txt')).toBe(real);
    expect(await resolveContainedRealPath(base, 'inner-link')).toBe(real);
  });

  test('rejects symlinks that resolve outside the base', async () => {
    await expect(resolveContainedRealPath(base, 'link-out')).rejects.toThrow(
      /escapes/i,
    );
    await expect(resolveContainedRealPath(base, 'dirlink')).rejects.toThrow(
      /escapes/i,
    );
    await expect(
      resolveContainedRealPath(base, 'dirlink/secret.txt'),
    ).rejects.toThrow(/escapes/i);
  });

  test('rejects with ENOENT for a missing target', async () => {
    await expect(
      resolveContainedRealPath(base, 'nope.txt'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('mimetypeForPath', () => {
  test('falls back to octet-stream for unknown extensions', () => {
    expect(mimetypeForPath('foo.zzzz')).toBe('application/octet-stream');
  });

  test('unrecognised dotfiles fall back to text/plain', () => {
    expect(mimetypeForPath('.prettierrc')).toBe('text/plain');
    expect(mimetypeForPath('.gitkeep')).toBe('text/plain');
    expect(mimetypeForPath('.env.example')).toBe('text/plain');
    expect(mimetypeForPath('.env.local')).toBe('text/plain');
  });
});

describe('isTextMimetype', () => {
  test('structured JSON/XML suffix MIME types are text', () => {
    expect(isTextMimetype('application/manifest+json')).toBe(true);
    expect(isTextMimetype('application/geo+json')).toBe(true);
    expect(isTextMimetype('application/atom+xml')).toBe(true);
  });

  test('octet-stream is binary', () => {
    expect(isTextMimetype('application/octet-stream')).toBe(false);
  });
});

describe('content-aware MIME detection', () => {
  test('recognises extensionless UTF-8 text and JSON', () => {
    expect(detectMimetype('notes', Buffer.from('hello\nworld\n'))).toBe(
      'text/plain',
    );
    expect(detectMimetype('data', Buffer.from('{"ok":true}\n'))).toBe(
      'application/json',
    );
  });

  test('keeps signatures and unsafe mixed content binary', () => {
    expect(
      detectMimetype('payload.unknown', Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    ).toBe('application/zip');
    expect(isSafeTextBuffer(Buffer.from('safe text\n'))).toBe(true);
    expect(
      isSafeTextBuffer(Buffer.from([0x73, 0x61, 0x66, 0x65, 0x00, 0xff])),
    ).toBe(false);
    expect(mimetypeForPath('.config', Buffer.from([0x00, 0x01, 0x02]))).toBe(
      'application/octet-stream',
    );
  });

  test('scans beyond the detection prefix before allowing text transport', async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.mime-test-'));
    const file = path.join(dir, 'mixed.txt');
    try {
      fs.writeFileSync(
        file,
        Buffer.concat([Buffer.from('a'.repeat(70 * 1024)), Buffer.from([0])]),
      );
      expect(await detectMimetypeForFile(file)).toBe(
        'application/octet-stream',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sniffed HTML uses inert plain text MIME', () => {
    expect(
      detectMimetype('unknown.data', Buffer.from('<!doctype html><p>x</p>')),
    ).toBe('text/plain');
  });
});

describe('isActiveContentMimetype', () => {
  test('treats every XML-parsed type as active content', () => {
    for (const type of [
      'text/html',
      'application/xhtml+xml',
      'image/svg+xml',
      'text/xml',
      'application/xml',
      'application/rss+xml',
      'application/atom+xml',
      'application/rdf+xml',
      'application/xslt+xml',
      'application/vnd.google-earth.kml+xml',
      'application/gpx+xml',
      'text/mathml',
      'text/xsl',
      'APPLICATION/RSS+XML; charset=utf-8',
    ]) {
      expect(isActiveContentMimetype(type)).toBe(true);
    }
  });

  test('leaves non-markup types inline-safe', () => {
    for (const type of [
      'text/plain',
      'application/json',
      'application/pdf',
      'image/png',
      'text/markdown',
      'application/octet-stream',
    ]) {
      expect(isActiveContentMimetype(type)).toBe(false);
    }
  });

  test('detects XML-based files by extension', async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.mime-test-'));
    try {
      for (const name of ['a.rss', 'a.kml', 'a.mml']) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, '<?xml version="1.0"?><root/>');
        expect(isActiveContentMimetype(await detectMimetypeForFile(file))).toBe(
          true,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseChunkParams', () => {
  test('returns null when offset/length absent', () => {
    expect(parseChunkParams({}, 1000)).toBe(null);
    expect(parseChunkParams({ path: 'a' }, 1000)).toBe(null);
  });

  test('clamps length to the file tail', () => {
    expect(parseChunkParams({ offset: '990', length: '100' }, 1000)).toEqual({
      offset: 990,
      length: 10,
    });
  });

  test('returns null for out-of-range offset', () => {
    expect(parseChunkParams({ offset: '1000', length: '20' }, 1000)).toBe(null);
    expect(parseChunkParams({ offset: '2000', length: '20' }, 1000)).toBe(null);
  });

  test('returns null for non-numeric inputs', () => {
    expect(parseChunkParams({ offset: 'abc', length: '20' }, 1000)).toBe(null);
    expect(parseChunkParams({ offset: '0', length: '-1' }, 1000)).toBe(null);
    expect(parseChunkParams({ offset: '0', length: '1.5' }, 1000)).toBe(null);
  });

  test('returns null for non-string values (e.g. arrays from query parsing)', () => {
    expect(parseChunkParams({ offset: ['0'], length: '20' }, 1000)).toBe(null);
    expect(parseChunkParams({ offset: '0', length: [20] }, 1000)).toBe(null);
  });
});

describe('applyUtf8SafeWindow', () => {
  test('snaps start past a half-cut multi-byte character at the head', () => {
    // "héllo" = 68 c3 a9 6c 6c 6f. If the request starts at offset 2 we're
    // sitting on the continuation byte (a9) of the 2-byte 'é' character
    // (c3 a9). The snap should step forward past the entire 'é' so we
    // never ship a half-character; the resulting start is the 'l' at
    // offset 3.
    const buf = Buffer.from('héllo', 'utf-8');
    const { start, end } = applyUtf8SafeWindow(buf, 2, buf.length, 0);
    expect(start).toBe(3);
    expect(end).toBe(buf.length);
  });

  test('trims trailing continuation bytes', () => {
    // Build a buffer that ends with the *continuation* byte of a 2-byte
    // UTF-8 character ('é' = c3 a9). The buffer is "h" + "é" but with
    // only the leader byte (c3) — so position 1 is a half-cut character.
    // The end should snap back to 1, before the half-cut char.
    const buf = Buffer.from([0x68, 0xc3]);
    const { end } = applyUtf8SafeWindow(buf, 0, buf.length, 0);
    expect(end).toBe(1);
  });

  test('keeps a complete trailing multi-byte character', () => {
    for (const [text, expectedEnd] of [
      ['abé', 4],
      ['a€', 4],
      ['a😀', 5],
    ] as const) {
      const buf = Buffer.from(text, 'utf-8');
      const { start, end } = applyUtf8SafeWindow(buf, 0, buf.length, 0);
      expect(start).toBe(0);
      expect(end).toBe(expectedEnd);
      expect(buf.subarray(start, end).toString('utf-8')).toBe(text);
    }
  });

  test('drops a cut trailing multi-byte character', () => {
    for (const bytes of [
      [0x61, 0xc3],
      [0x61, 0xe2, 0x82],
      [0x61, 0xf0, 0x9f, 0x98],
    ]) {
      const buf = Buffer.from(bytes);
      expect(applyUtf8SafeWindow(buf, 0, buf.length, 0).end).toBe(1);
    }
    const ascii = Buffer.from('plain ascii');
    expect(applyUtf8SafeWindow(ascii, 0, ascii.length, 0).end).toBe(
      ascii.length,
    );
  });

  test('snaps the head and keeps a complete tail together', () => {
    const buf = Buffer.from('xé€y😀', 'utf-8');
    const { start, end } = applyUtf8SafeWindow(buf, 2, buf.length, 0);
    expect(start).toBe(3);
    expect(end).toBe(buf.length);
    expect(buf.subarray(start, end).toString('utf-8')).toBe('€y😀');
  });
});

describe('contained read/write helpers', () => {
  let tmp: string;
  let base: string;
  let outside: string;
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crw-')));
    base = path.join(tmp, 'base');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(base, 'real.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(
      path.join(outside, 'secret.txt'),
      path.join(base, 'link-out'),
    );
    fs.symlinkSync('real.txt', path.join(base, 'inner-link'));
    fs.symlinkSync(outside, path.join(base, 'dirlink'));
    fs.symlinkSync(path.join(tmp, 'missing'), path.join(base, 'dangling'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('readContainedText returns inside content and null for escapes or missing files', async () => {
    expect(await readContainedText(base, path.join(base, 'real.txt'))).toBe(
      'ok',
    );
    expect(await readContainedText(base, path.join(base, 'inner-link'))).toBe(
      'ok',
    );
    expect(
      await readContainedText(base, path.join(base, 'link-out')),
    ).toBeNull();
    expect(
      await readContainedText(base, path.join(base, 'nope.txt')),
    ).toBeNull();
  });

  test('isContainedWritePath covers missing leaves, symlinks and dangling links', async () => {
    expect(
      await isContainedWritePath(base, path.join(base, 'a', 'b', 'new.md')),
    ).toBe(true);
    expect(await isContainedWritePath(base, path.join(base, 'link-out'))).toBe(
      false,
    );
    expect(
      await isContainedWritePath(base, path.join(base, 'dirlink', 'new.md')),
    ).toBe(false);
    expect(await isContainedWritePath(base, path.join(base, 'dangling'))).toBe(
      false,
    );
    expect(await isContainedWritePath(base, path.join(outside, 'x'))).toBe(
      false,
    );
  });
});
