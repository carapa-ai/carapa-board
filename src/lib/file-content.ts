/**
 * Helpers for serving file contents from project file trees.
 *
 * Two endpoints share this logic:
 *
 *   GET /api/projects/:pid/files/group/content
 *     Reads files inside the group's working directory (`groups/<folder>/`).
 *     The board container owns this directory, so we read directly with fs.
 *
 *   GET /api/projects/:pid/conversations/:cid/files/repo/content
 *     Reads files from the project repo, which lives inside the sandbox
 *     container. We shell out via CarapaBox sandbox_git (`git show HEAD:<p>`
 *     for tracked files, `cat <p>` for untracked).
 *
 * Path safety, mimetype detection, and the "binary vs text" decision live
 * here so both endpoints can share the same behavior.
 */
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import type { Response } from 'express';
import { lookup as lookupMime } from 'mime-types';
import { logger } from '../logger.js';
import { GroupFsError, openGroupDirAbs, readFileAt } from './group-fs.js';
import { isPathInside, resolveInside } from './path-containment.js';

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * True when the relative path is safe to resolve against a base directory:
 *   - non-empty
 *   - no `..` segments (no traversal above the base)
 *   - not absolute (no leading `/` or Windows drive letter)
 *   - no null bytes (would truncate the resolved path on POSIX)
 */
export function isSafeRelativePath(rawPath: unknown): rawPath is string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return false;
  if (rawPath.length > 4096) return false;
  // Reject null bytes outright — they can truncate paths on POSIX fs.
  if (rawPath.includes('\0')) return false;
  // Reject absolute paths and Windows drive letters up front. We never want
  // `path.resolve` to interpret the input as root-relative.
  if (path.isAbsolute(rawPath)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(rawPath)) return false;
  // Walk the segments; reject any traversal or empty pieces that could mask it.
  const segments = rawPath.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return false;
  }
  return true;
}

/**
 * Resolve `relPath` against `baseDir` only after `isSafeRelativePath` confirms
 * it cannot escape. The returned absolute path is guaranteed to live under
 * `baseDir` (post-normalisation) — that's the invariant callers rely on.
 */
export function safeResolve(baseDir: string, relPath: string): string {
  return resolveInside(baseDir, relPath);
}

/**
 * `safeResolve` plus symlink containment: resolves the real (symlink-free)
 * path of both `baseDir` and the target and requires the target to stay under
 * the base. Returns the REAL path — callers must stat/read that path, not the
 * lexical one, so a later swap cannot redirect the open. A missing target
 * rejects with the underlying ENOENT error.
 */
export async function resolveContainedRealPath(
  baseDir: string,
  relPath: string,
): Promise<string> {
  const lexical = safeResolve(baseDir, relPath);
  const [realBase, realTarget] = await Promise.all([
    fsp.realpath(baseDir),
    fsp.realpath(lexical),
  ]);
  return assertWithinRealBase(realBase, realTarget);
}

function assertWithinRealBase(realBase: string, realTarget: string): string {
  if (!isPathInside(realBase, realTarget)) {
    throw new Error('Path escapes base directory');
  }
  return realTarget;
}

/** Largest transcript or prompt `readContainedText` will read. */
const MAX_CONTAINED_TEXT_BYTES = 128 * 1024 * 1024;

/**
 * Read a UTF-8 file inside `groupDir` through group-fs (descriptor-pinned
 * group directory, per-segment O_NOFOLLOW, non-blocking leaf open). Escaping, missing, oversized or
 * non-regular (FIFO, device) paths yield null. Only relative links that stay
 * inside the group directory are followed.
 */
export async function readContainedText(
  groupDir: string,
  target: string,
): Promise<string | null> {
  const resolved = path.resolve(target);
  const root = path.resolve(groupDir);
  if (!isPathInside(root, resolved, { allowRoot: false })) return null;
  const rel = path.relative(root, resolved);
  try {
    // Pin the group directory (no link followed from GROUPS_DIR) so relative
    // links may cross directories inside it.
    const base = await openGroupDirAbs(groupDir);
    if (!base) return null;
    try {
      const file = await readFileAt(base, rel.split(path.sep).join('/'), {
        maxBytes: MAX_CONTAINED_TEXT_BYTES,
        followInternalLinks: true,
      });
      return file ? file.data.toString('utf-8') : null;
    } finally {
      await base.close();
    }
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'unsupported') {
      logger.warn({ err, target }, 'Contained text read unsupported');
    }
    return null;
  }
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * True when `candidate` (which may not exist yet) can be created or written
 * without following a symlink out of `baseDir`: the nearest existing ancestor
 * — or the candidate itself, including a dangling symlink — must resolve to a
 * real path inside the real `baseDir`. Fails closed on any unexpected error.
 */
export async function isContainedWritePath(
  baseDir: string,
  candidate: string,
): Promise<boolean> {
  let existing: string;
  try {
    existing = safeResolve(baseDir, candidate);
  } catch {
    return false;
  }
  const root = path.resolve(baseDir);
  while (true) {
    try {
      await fsp.lstat(existing);
      break;
    } catch (err) {
      if (!isMissingPathError(err)) return false;
      // Nothing exists under a missing base, so there is nothing to follow.
      if (existing === root) return true;
      existing = path.dirname(existing);
    }
  }
  try {
    await resolveContainedRealPath(baseDir, existing);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create `dir` (recursively) under `baseDir`, refusing to traverse a symlink
 * out of it. Checked before and after mkdir. Returns false when refused.
 */
export async function mkdirContained(
  baseDir: string,
  dir: string,
): Promise<boolean> {
  if (!(await isContainedWritePath(baseDir, dir))) return false;
  await fsp.mkdir(dir, { recursive: true });
  return isContainedWritePath(baseDir, dir);
}

// ---------------------------------------------------------------------------
// Mimetype detection
// ---------------------------------------------------------------------------

/** MIME types which are safe to decode as UTF-8 in the preview JSON envelope. */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/ld+json',
  'application/sql',
  'application/typescript',
  'application/xml',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'text/css',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/yaml',
]);

/** A small set of formats whose signatures are unambiguous and binary. */
const BINARY_SIGNATURES: Array<{ bytes: number[]; mimetype: string }> = [
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mimetype: 'image/png',
  },
  { bytes: [0xff, 0xd8, 0xff], mimetype: 'image/jpeg' },
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mimetype: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mimetype: 'application/zip' },
  { bytes: [0x1f, 0x8b], mimetype: 'application/gzip' },
];

const CONFIDENTLY_BINARY_EXTENSIONS = new Set([
  'bin',
  'dat',
  'dll',
  'dylib',
  'exe',
  'iso',
  'so',
  'wasm',
]);

/**
 * Legacy overrides for formats where the MIME database is either absent or
 * too generic. New extensions should generally be handled by mime-db or the
 * content fallback below, rather than added here.
 */
const MIME_OVERRIDES: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // Text-ish (rendered inline by the UI)
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  jsonl: 'text/plain',
  ndjson: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonc: 'application/json',
  xml: 'application/xml',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  // Code files (treat as plain text so the viewer shows them as text)
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/plain',
  jsx: 'text/plain',
  mjs: 'text/plain',
  cjs: 'text/plain',
  py: 'text/plain',
  rb: 'text/plain',
  rs: 'text/plain',
  go: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  swift: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  cxx: 'text/plain',
  hpp: 'text/plain',
  cs: 'text/plain',
  php: 'text/plain',
  sh: 'text/plain',
  bash: 'text/plain',
  zsh: 'text/plain',
  sql: 'text/plain',
};

// A bounded supplement for source/config extensions not yet present in
// mime-db (notably jsonc). These are deliberately named formats, not a
// catch-all "unknown extensions are text" rule.
const TEXT_EXTENSION_HINTS: Record<string, string> = {
  bashrc: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  hcl: 'text/plain',
  json5: 'application/json',
  jsonc: 'application/json',
  properties: 'text/plain',
  proto: 'text/plain',
  tf: 'text/plain',
  tfvars: 'text/plain',
  vue: 'text/plain',
  svelte: 'text/plain',
  astro: 'text/plain',
  graphql: 'text/plain',
  gql: 'text/plain',
};

function extensionMimetype(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (!ext) return undefined;
  const databaseMime = lookupMime(ext);
  // mime-db has a useful JSON5 entry, but application/json is the compatible
  // text MIME understood by the existing preview response path.
  const normalizedDatabaseMime =
    databaseMime === 'application/json5'
      ? 'application/json'
      : databaseMime || undefined;
  return (
    MIME_OVERRIDES[ext] ||
    normalizedDatabaseMime ||
    TEXT_EXTENSION_HINTS[ext] ||
    undefined
  );
}

function startsWithBytes(buffer: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

/** Reject NULs, invalid UTF-8, and a meaningful amount of binary control data. */
export function isSafeTextBuffer(content: Uint8Array): boolean {
  if (content.includes(0)) return false;
  const decoded = Buffer.from(content).toString('utf8');
  if (Buffer.from(decoded, 'utf8').compare(Buffer.from(content)) !== 0)
    return false;
  let controls = 0;
  for (const code of decoded) {
    const value = code.codePointAt(0)!;
    if (
      value < 0x20 &&
      value !== 0x09 &&
      value !== 0x0a &&
      value !== 0x0c &&
      value !== 0x0d
    )
      controls++;
  }
  return controls === 0;
}

/**
 * Drop a character cut by the end of a fixed-size prefix sample, so a large
 * valid UTF-8 file is not classified as binary just because the sample ends
 * inside a multi-byte character. Callers validate the full stream separately.
 */
export function trimUtf8Sample(sample: Buffer): Buffer {
  return sample.subarray(
    0,
    applyUtf8SafeWindow(sample, 0, sample.length, 0).end,
  );
}

/**
 * Detect a file MIME type using mime-db for known extensions and a bounded,
 * conservative content fallback for unknown/extensionless files. Supplying
 * bytes enables the binary safeguard; path-only calls retain the historical
 * extension classification for repo transport decisions.
 */
export function detectMimetype(filePath: string, content?: Uint8Array): string {
  const known = extensionMimetype(filePath);
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (
    known &&
    (known !== 'application/octet-stream' ||
      CONFIDENTLY_BINARY_EXTENSIONS.has(ext))
  ) {
    if (!content || !isTextMimetype(known)) return known;
    return isSafeTextBuffer(content) ? known : 'application/octet-stream';
  }
  if (known === 'application/octet-stream' && !content) return known;
  if (content) {
    for (const signature of BINARY_SIGNATURES) {
      if (startsWithBytes(content, signature.bytes)) return signature.mimetype;
    }
    if (!isSafeTextBuffer(content)) return 'application/octet-stream';
    const text = Buffer.from(content).toString('utf8').trimStart();
    if (text.startsWith('{') || text.startsWith('[')) return 'application/json';
    // Unknown content must never become same-origin executable HTML. Files
    // with an explicit .html MIME still use text/html; sniffed HTML is plain
    // text so artifact serving cannot execute uploaded/web content.
    if (/^<(!doctype\s+html|html\b)/i.test(text)) return 'text/plain';
    if (text.startsWith('<?xml') || /^<[\w:-]+[\s>]/.test(text))
      return 'application/xml';
    return 'text/plain';
  }
  return 'application/octet-stream';
}

/**
 * Validate every byte that would enter the text transport and sniff the type
 * from the first 64 KiB. `chunks` yields the file contents in order; a read
 * error falls back to the extension classification.
 */
async function detectMimetypeFromChunks(
  logicalName: string,
  chunks: () => AsyncIterable<Buffer>,
): Promise<string> {
  const pathMimetype = mimetypeForPath(logicalName);
  if (
    pathMimetype !== 'application/octet-stream' &&
    !isTextMimetype(pathMimetype)
  ) {
    return pathMimetype;
  }

  const prefixParts: Buffer[] = [];
  let prefixLength = 0;
  let safe = true;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const bytes of chunks()) {
      if (prefixLength < 64 * 1024) {
        const part = bytes.subarray(
          0,
          Math.min(bytes.length, 64 * 1024 - prefixLength),
        );
        prefixParts.push(part);
        prefixLength += part.length;
      }
      if (safe) {
        try {
          const text = decoder.decode(bytes, { stream: true });
          if (
            text.includes('\0') ||
            /[\u0001-\u0008\u000b\u000e-\u001f]/.test(text)
          )
            safe = false;
        } catch {
          safe = false;
        }
      }
    }
    if (safe) {
      try {
        const text = decoder.decode();
        if (
          text.includes('\0') ||
          /[\u0001-\u0008\u000b\u000e-\u001f]/.test(text)
        )
          safe = false;
      } catch {
        safe = false;
      }
    }
  } catch {
    return pathMimetype;
  }
  if (!safe) return 'application/octet-stream';
  return detectMimetype(
    logicalName,
    trimUtf8Sample(Buffer.concat(prefixParts)),
  );
}

/**
 * Detect a local file while validating every byte that would enter the text
 * transport. Only the first 64 KiB is retained for content sniffing; the
 * stream itself is consumed to reject NULs, invalid UTF-8, and control bytes
 * anywhere later in the file. Reads by path: use it for board-owned files and
 * {@link detectMimetypeForHandle} for agent-writable folders.
 */
export async function detectMimetypeForFile(filePath: string): Promise<string> {
  return detectMimetypeFromChunks(
    filePath,
    () =>
      fs.createReadStream(filePath, {
        highWaterMark: 64 * 1024,
      }) as AsyncIterable<Buffer>,
  );
}

/**
 * {@link detectMimetypeForFile} for an already opened (pinned) file: the same
 * sniffing, but positional reads through `handle`, so a path swap after the
 * open cannot change what is inspected. `logicalName` only supplies the
 * extension. The handle is left open.
 */
export async function detectMimetypeForHandle(
  handle: FileHandle,
  logicalName: string,
): Promise<string> {
  return detectMimetypeFromChunks(logicalName, async function* () {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) return;
      position += bytesRead;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  });
}

/**
 * Dotfile basenames that are binary even though they live at the repo root
 * and start with a dot. Used to keep the dotfile fallback below from sending
 * known-binary dotfiles through the text pipeline. `.DS_Store` is the common
 * case; it's sometimes committed by accident and would otherwise render as
 * garbage bytes in the preview.
 */
const BINARY_DOTFILES = new Set(['.ds_store']);

/** Lookup mimetype by file extension (lowercased, no leading dot). */
export function mimetypeForPath(
  filePath: string,
  content?: Uint8Array,
): string {
  const detected = detectMimetype(filePath, content);
  if (detected !== 'application/octet-stream') return detected;
  // Content-aware callers must not be rescued by the historical dotfile
  // fallback: a binary payload named `.config` is still binary.
  if (content) return detected;
  // Files without an extension — fall back to the basename. These are the
  // "dotfiles" and well-known config / project files the Files tab is most
  // likely to surface (Dockerfile, .gitignore, LICENSE, .env, …). The goal is
  // to render them as text/plain inline rather than push the user to the
  // "download" fallback for files they almost certainly want to read.
  const base = path.basename(filePath).toLowerCase();
  if (BASENAME_MIMETYPES[base]) return BASENAME_MIMETYPES[base];
  // Unrecognised dotfiles (.prettierrc, .env.example, .env.local, .gitkeep,
  // …) are almost always small text config the user wants to read inline.
  // Known binary extensions (png/pdf/audio/video) were already returned by
  // the extension lookup above, so a dotfile reaching here is text-ish.
  // Exclude the handful of known-binary dotfile basenames.
  if (base.startsWith('.') && base.length > 1 && !BINARY_DOTFILES.has(base)) {
    return 'text/plain';
  }
  return content ? detected : 'application/octet-stream';
}

/**
 * Basename → mimetype for the common extensionless text files people want
 * to read in the preview pane. Anything not listed falls back to
 * `application/octet-stream` (treat as binary). Keep this list focused on
 * files that are *almost always* small text bodies — leaving truly
 * ambiguous names (e.g. `notes`) off avoids mis-rendering random binaries.
 *
 * `path.extname('.gitignore')` returns '' (Node treats it as "no extension,
 * just a basename"), so we look up by the full basename including the
 * leading dot. We list both the dotted and non-dotted forms so `LICENSE`
 * and `.gitignore` both resolve consistently.
 */
const BASENAME_MIMETYPES: Record<string, string> = {
  // Build / tooling files
  dockerfile: 'text/plain',
  makefile: 'text/plain',
  rakefile: 'text/plain',
  gemfile: 'text/plain',
  procfile: 'text/plain',
  vagrantfile: 'text/plain',
  brewfile: 'text/plain',
  cmakelists: 'text/plain',
  cmakelists_txt: 'text/plain',
  // Project meta
  license: 'text/plain',
  licence: 'text/plain',
  copying: 'text/plain',
  readme: 'text/markdown',
  contributing: 'text/markdown',
  code_of_conduct: 'text/markdown',
  security: 'text/markdown',
  changelog: 'text/markdown',
  authors: 'text/plain',
  contributors: 'text/plain',
  notice: 'text/plain',
  // Shell / dotfile config (treat as plain text — syntax highlighting would
  // be misleading because these aren't actually shell scripts)
  bashrc: 'text/plain',
  bash_profile: 'text/plain',
  profile: 'text/plain',
  zshrc: 'text/plain',
  zshenv: 'text/plain',
  zprofile: 'text/plain',
  oh_my_zsh: 'text/plain',
  // Common "dotfiles" that Node's path.extname treats as basenames (no
  // extension, leading dot included)
  '.gitconfig': 'text/plain',
  '.gitignore': 'text/plain',
  '.gitattributes': 'text/plain',
  '.gitmodules': 'text/plain',
  '.hgignore': 'text/plain',
  '.npmignore': 'text/plain',
  '.dockerignore': 'text/plain',
  '.eslintignore': 'text/plain',
  '.prettierignore': 'text/plain',
  '.editorconfig': 'text/plain',
  '.babelrc': 'text/plain',
  '.babelrc.js': 'text/plain',
  '.babelrc.json': 'text/plain',
  '.yarnrc': 'text/plain',
  '.npmrc': 'text/plain',
  '.nvmrc': 'text/plain',
  '.node-version': 'text/plain',
  '.python-version': 'text/plain',
  '.ruby-version': 'text/plain',
  '.rustfmt': 'text/plain',
  '.rustfmt.toml': 'text/plain',
  '.watchmanconfig': 'text/plain',
  '.bower_components': 'text/plain',
  '.htaccess': 'text/plain',
  // Common extensionless env files
  env: 'text/plain',
  '.env': 'text/plain',
};

/**
 * True when `mimetype` is safe to send as a JSON string (utf-8 text-ish).
 * Binary mimetypes (images, pdfs, audio, generic octet-stream) must go as a
 * raw stream with the matching Content-Type header so the browser can render
 * them directly without a base64 round-trip.
 */
export function isTextMimetype(mimetype: string): boolean {
  if (!mimetype) return false;
  if (mimetype === 'application/octet-stream') return false;
  if (TEXT_MIME_TYPES.has(mimetype)) return true;
  if (/^application\/.+\+(json|xml)$/.test(mimetype)) return true;
  if (mimetype.startsWith('text/')) return true;
  // Only explicitly-known application formats are text. In particular,
  // application/zip and other binary MIME database results must not enter the
  // JSON/text transport merely because they are application/*.
  return false;
}

// ---------------------------------------------------------------------------
// Chunked reads (large text / log files)
// ---------------------------------------------------------------------------

/**
 * Parse a `?offset=&length=` pair from an Express query object into a
 * validated `{ offset, length }` window, or return `null` when chunked
 * reads were not requested.
 *
 * Both params must be present, both must parse as non-negative integers,
 * and `length` must be > 0. A length over `total` is silently clamped
 * (callers always want the rest of the file). An offset >= `total` is
 * treated as "not requested" so the client falls back to the full-file
 * path and surfaces a clearer error than an empty body.
 *
 * This is intentionally permissive on negative / zero inputs — those
 * resolve to `null` and the caller reads the full file. The goal is
 * "robust on bad input, exact on good input".
 */
export function parseChunkParams(
  query: Record<string, unknown> | { [key: string]: unknown },
  total: number,
): { offset: number; length: number } | null {
  const rawOffset = query.offset;
  const rawLength = query.length;
  if (rawOffset === undefined || rawLength === undefined) return null;
  // Reject arrays / non-string types that survive query parsing so we
  // don't accidentally accept `?offset=10&offset=20` as a chunked read.
  if (typeof rawOffset !== 'string' || typeof rawLength !== 'string')
    return null;
  if (!/^\d+$/.test(rawOffset) || !/^\d+$/.test(rawLength)) return null;
  const offset = Number(rawOffset);
  const length = Number(rawLength);
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return null;
  if (offset >= total) return null;
  if (length <= 0) return null;
  return { offset, length: Math.min(length, total - offset) };
}

/**
 * Post-read helper: trim a buffer's start and end so they align to UTF-8
 * character boundaries. Used by the chunked-read path after `fs.read`
 * returns a window with a small safety margin (the caller always reads
 * a few bytes beyond the requested range).
 *
 * The function trims back to the smallest valid UTF-8 that still contains
 * the requested range — the caller reports the trimmed `offset` and
 * `length` back to the client so the next chunk request lines up.
 *
 * `requestedStart` is the byte offset the caller actually wanted to start
 * at; `actualStart` is where the read began (≤ requestedStart thanks to
 * the safety margin). We snap `start` forward to the first UTF-8 boundary
 * that lies at or after `requestedStart` so we never ship a half-character
 * at the head of the chunk.
 */
export function applyUtf8SafeWindow(
  buf: Buffer,
  requestedStart: number,
  requestedEnd: number,
  actualStart: number,
): { start: number; end: number } {
  // Step 1: find a UTF-8 boundary anywhere from `actualStart` onwards.
  // We do this by walking forward while the current byte is a continuation
  // byte (10xxxxxx) — the moment we see an ASCII byte (0xxxxxxx) or a
  // multi-byte leader (11xxxxxx) we're at a character boundary.
  let boundary = actualStart;
  while (boundary < buf.length) {
    const b = buf[boundary];
    const isAscii = b < 0x80;
    const isLeader = (b & 0xc0) === 0xc0;
    if (isAscii || isLeader) break;
    boundary++;
  }
  // Step 2: walk forward from the first boundary until we're at or past
  // `requestedStart`. Worst case is a 4-byte UTF-8 sequence straddling
  // the read's safety margin, so we walk at most 4 bytes — but in practice
  // this is a no-op for the common case of a 1-byte ASCII read margin.
  let start = boundary;
  while (start < buf.length && start < requestedStart + 4) {
    const b = buf[start];
    if (b < 0x80) {
      // ASCII: the byte itself is a boundary.
      if (start >= requestedStart) break;
      start++;
      continue;
    }
    // Multi-byte leader: the byte itself is a boundary. If it's already
    // at or past requestedStart, we're done; otherwise it's a 2-4 byte
    // character and we need to step past it.
    if (start >= requestedStart) break;
    const seqLen = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    start += seqLen;
  }
  // Step 3: trim a trailing half-character. Walk back over the trailing
  // continuation bytes (10xxxxxx) to the last non-continuation byte `i`:
  //  - none in range: only continuation bytes remain, so drop them all;
  //  - ASCII: keep through it and drop stray continuation bytes after it;
  //  - multi-byte leader: keep the whole character when all of its bytes
  //    are present (cutting just after the character), otherwise cut
  //    before the leader.
  let end = buf.length;
  let i = buf.length - 1;
  while (i >= start && (buf[i] & 0xc0) === 0x80) i--;
  if (i < start) {
    end = start;
  } else if (buf[i] < 0x80) {
    end = i + 1;
  } else {
    const seqLen = buf[i] < 0xe0 ? 2 : buf[i] < 0xf0 ? 3 : 4;
    end = buf.length - i >= seqLen ? Math.min(buf.length, i + seqLen) : i;
  }
  return { start, end };
}

/**
 * Most bytes of a text file one group-file response reads into memory.
 * Longer files are served as a window; the envelope's `total` and `length`
 * tell the client to request the rest in chunks.
 */
export const MAX_TEXT_READ_BYTES = 4 * 1024 * 1024;

/** Byte cap when serving a user-visible file through a buffered read. */
export const MAX_UPLOAD_SERVE_BYTES = 100 * 1024 * 1024;

const ACTIVE_CONTENT_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

/**
 * Active-content types that must never render inline on the board origin.
 * Browsers parse every `*+xml` response as an XML document, so any
 * structured-syntax XML type (RSS, Atom, KML, GPX, ...) is active content,
 * as are the XML-based MathML and XSL types that are not covered by the set.
 */
export function isActiveContentMimetype(mimetype: string): boolean {
  const essence = mimetype.split(';')[0]!.trim().toLowerCase();
  return (
    ACTIVE_CONTENT_MIME_TYPES.has(essence) ||
    essence.endsWith('+xml') ||
    essence === 'text/mathml' ||
    essence === 'text/xsl'
  );
}

/**
 * Headers for streaming raw file bytes to a browser: `nosniff` always, and for
 * active content a sandboxing CSP plus `attachment`, so scripts in a served
 * SVG/HTML file never run on the board origin. Sets Content-Type last because
 * `attachment()` derives one from the extension.
 */
export function setRawFileHeaders(
  res: Response,
  mimetype: string,
  filename: string,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isActiveContentMimetype(mimetype)) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.attachment(filename);
  }
  res.setHeader('Content-Type', mimetype);
}
