/* eslint-disable no-console */
/**
 * Group-folder fs guard: fails when raw `fs` is used in a source file that
 * derives agent-writable group paths.
 *
 * Board access to `groups/<folder>/` (and objective / artifact folders) must go
 * through `src/lib/group-fs.ts`, which is immune to folder-swap races. This
 * scanner stops new check-then-use code from creeping back in.
 *
 * Run from the repo root:  bun scripts/check-group-fs.ts
 *
 * Pure static text scan: no imports of app code. Scan set is `src/**\/*.ts`
 * minus `*.test.ts` and `src/lib/group-fs.ts`. Comments and string / template
 * literal contents are blanked before matching.
 *
 * A file is "group-deriving" when it mentions getGroupDir, getObjectiveDir,
 * groupArtifactsDir, chatTranscriptPath, outputTranscriptPath,
 * resolveTranscriptFile, openParentDir or GROUPS_DIR, or when it is listed in
 * scripts/group-fs-allowlist.json: under `pathHelpers` (helpers that receive
 * group paths as parameters) or under `files` (so an entry for a file that only
 * receives paths, e.g. a CLI bundle, is tracked and ratcheted too).
 *
 * Raw fs use is: `fs|fsp|fsPromises|promises.<method>(`, a call of a name
 * imported from fs / node:fs / fs/promises / node:fs/promises, `res.sendFile(`,
 * `Bun.file(` and `Bun.write(`.
 *
 * Failures:
 *   - a group-deriving file with raw uses that is not allowlisted;
 *   - an allowlisted file whose raw uses exceed `max`;
 *   - an allowlisted file below `max` ("lower max to N", a ratchet);
 *   - an allowlist / pathHelpers entry for a file that is not scanned
 *     ("remove stale entry").
 *
 * New exceptions go into scripts/group-fs-allowlist.json with a reason.
 *
 * Limits:
 *   - File-level heuristic, not data flow. A helper in an unlisted file that
 *     takes a path string is only caught once it is added to `pathHelpers`.
 *   - `fs[name]` dynamic access, require() / dynamic import(), child processes
 *     (tar, cp) and native addons are not detected.
 *   - A file that derives group paths but only touches board-owned paths still
 *     needs an allowlist entry with a reason. That friction is deliberate and
 *     visible in review.
 *   - Deterministic (pure text scan), so it is not flaky.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RawUse {
  line: number;
  text: string;
}

export interface FileScan {
  groupDeriving: boolean;
  uses: RawUse[];
}

export interface AllowlistEntry {
  max: number;
  reason: string;
}

export interface Allowlist {
  files: Record<string, AllowlistEntry>;
  pathHelpers: string[];
}

const ALLOWLIST_PATH = 'scripts/group-fs-allowlist.json';

const GROUP_DERIVING_RE =
  /\b(getGroupDir|getObjectiveDir|groupArtifactsDir|chatTranscriptPath|outputTranscriptPath|resolveTranscriptFile|openParentDir|GROUPS_DIR)\b/;

const FS_METHODS =
  'readFile|writeFile|appendFile|readdir|opendir|stat|lstat|exists|access|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|open|createReadStream|createWriteStream|realpath|symlink|link|truncate|chmod|utimes|watch';

const FS_IMPORT_RE =
  /\bimport\s+(type\s+)?([^'"`;]*?)\s*from\s*(['"])(?:node:)?(?:fs|fs\/promises)\3/g;

// A `/` after one of these characters or keywords starts a regex literal.
const REGEX_PRECEDING_CHAR_RE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_PRECEDING_WORD_RE =
  /^(?:return|typeof|case|of|in|delete|void|throw|new|else|do|yield|await)$/;
const IDENT_CHAR_RE = /[\w$]/;

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
const escapeRe = (text: string): string =>
  text.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');

/**
 * Blank comments, string / template literal contents and regex literal bodies
 * while preserving length and newlines, so offsets map to the original lines.
 * With `keepStrings`, string and template contents are kept (used to read
 * import specifiers).
 */
export function stripSource(source: string, keepStrings = false): string {
  const n = source.length;
  let out = '';
  let i = 0;
  let braceDepth = 0;
  // Brace depth recorded at each open `${` so its matching `}` resumes the template.
  const templateStack: number[] = [];
  let lastSig = '';
  let lastWord = '';

  const emitCode = (ch: string): void => {
    out += ch;
    if (/\s/.test(ch)) return;
    lastWord = IDENT_CHAR_RE.test(ch)
      ? (IDENT_CHAR_RE.test(lastSig) ? lastWord : '') + ch
      : '';
    lastSig = ch;
  };
  const emitLiteral = (text: string): void => {
    out += text;
    lastSig = 'a';
    lastWord = '';
  };
  // Emits template text from `start`; returns the index after the closing
  // backtick or after the `${` that opens an interpolation.
  const scanTemplateBody = (start: number): number => {
    let j = start;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`' || (c === '$' && source[j + 1] === '{')) break;
      j++;
    }
    const body = source.slice(start, Math.min(j, n));
    out += keepStrings ? body : blank(body);
    if (j >= n) return n;
    if (source[j] === '`') {
      emitLiteral('`');
      return j + 1;
    }
    out += '${';
    lastSig = '{';
    lastWord = '';
    templateStack.push(braceDepth);
    braceDepth++;
    return j + 2;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== '\n')
        j += source[j] === '\\' ? 2 : 1;
      const closed = source[j] === ch;
      const body = source.slice(i + 1, Math.min(j, n));
      emitLiteral(ch + (keepStrings ? body : blank(body)) + (closed ? ch : ''));
      i = closed ? j + 1 : Math.min(j, n);
    } else if (ch === '`') {
      out += '`';
      i = scanTemplateBody(i + 1);
    } else if (
      ch === '/' &&
      (lastSig === '' ||
        REGEX_PRECEDING_CHAR_RE.test(lastSig) ||
        REGEX_PRECEDING_WORD_RE.test(lastWord))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        const c = source[j];
        if (c === '\\') j++;
        else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      if (source[j] === '/') {
        emitLiteral('/' + blank(source.slice(i + 1, j)) + '/');
        i = j + 1;
      } else {
        emitCode(ch);
        i++;
      }
    } else if (ch === '{') {
      braceDepth++;
      emitCode(ch);
      i++;
    } else if (ch === '}') {
      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1] === braceDepth - 1
      ) {
        templateStack.pop();
        braceDepth--;
        out += '}';
        i = scanTemplateBody(i + 1);
      } else {
        braceDepth = Math.max(0, braceDepth - 1);
        emitCode(ch);
        i++;
      }
    } else {
      emitCode(ch);
      i++;
    }
  }
  return out;
}

interface FsImports {
  namespaceAliases: string[];
  callNames: string[];
}

/** Local names bound by value imports from fs / node:fs / fs/promises / node:fs/promises. */
function parseFsImports(sourceWithStrings: string): FsImports {
  const namespaceAliases: string[] = [];
  const callNames: string[] = [];
  for (const match of sourceWithStrings.matchAll(FS_IMPORT_RE)) {
    if (match[1]) continue; // `import type`
    const clause = match[2];
    const braces = /\{([^}]*)\}/.exec(clause);
    const rest = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/\*\s*as\s+([\w$]+)/, (_all, alias: string) => {
        namespaceAliases.push(alias);
        return '';
      })
      .replace(/,/g, '')
      .trim();
    if (/^[\w$]+$/.test(rest)) namespaceAliases.push(rest);
    for (const specifier of braces?.[1].split(',') ?? []) {
      const trimmed = specifier.trim();
      if (!trimmed || trimmed.startsWith('type ')) continue;
      const [imported, local = imported] = trimmed.split(/\s+as\s+/);
      if (imported === 'promises') namespaceAliases.push(local);
      else callNames.push(local);
    }
  }
  return { namespaceAliases, callNames };
}

/** Scan one source file. `tracked` (pathHelpers / allowlisted files) forces it to count as group-deriving. */
export function scanSource(rawSource: string, tracked = false): FileScan {
  const source = rawSource.replace(/\r\n?/g, '\n');
  const code = stripSource(source);
  const groupDeriving = tracked || GROUP_DERIVING_RE.test(code);
  if (!groupDeriving) return { groupDeriving, uses: [] };

  const imports = parseFsImports(stripSource(source, true));
  const namespaces = [
    'fs',
    'fsp',
    'fsPromises',
    'promises',
    ...imports.namespaceAliases,
  ].map(escapeRe);
  const patterns = [
    new RegExp(
      `\\b(?:${namespaces.join('|')})\\.(?:${FS_METHODS})(?:Sync)?\\s*\\(`,
      'g',
    ),
    /\bres\.sendFile\s*\(/g,
    /\bBun\.(?:file|write)\s*\(/g,
  ];
  if (imports.callNames.length > 0) {
    patterns.push(
      new RegExp(
        `(?<![.\\w$])(?:${imports.callNames.map(escapeRe).join('|')})\\s*\\(`,
        'g',
      ),
    );
  }

  const lines = source.split('\n');
  const offsets: number[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) offsets.push(match.index);
  }
  const uses = offsets
    .sort((a, b) => a - b)
    .map((offset) => {
      const line = code.slice(0, offset).split('\n').length;
      return { line, text: lines[line - 1].trim().slice(0, 120) };
    });
  return { groupDeriving, uses };
}

/** Compare scan results with the allowlist; returns human-readable violations. */
export function evaluate(
  scans: ReadonlyMap<string, FileScan>,
  allowlist: Allowlist,
): string[] {
  const violations: string[] = [];
  const listUses = (file: string, uses: RawUse[]): string[] =>
    uses.map((use) => `    ${file}:${use.line}  ${use.text}`);

  for (const [file, scan] of scans) {
    const entry = allowlist.files[file];
    const count = scan.uses.length;
    if (!scan.groupDeriving) continue;
    if (!entry) {
      if (count > 0) {
        violations.push(
          `${file}: ${count} raw fs use(s) in a group-deriving file. Use src/lib/group-fs.ts, or add an entry with a reason to ${ALLOWLIST_PATH}`,
          ...listUses(file, scan.uses),
        );
      }
    } else if (count > entry.max) {
      violations.push(
        `${file}: ${count} raw fs use(s) exceed allowlisted max ${entry.max}`,
        ...listUses(file, scan.uses),
      );
    } else if (count < entry.max) {
      violations.push(
        `${file}: ${count} raw fs use(s) below allowlisted max ${entry.max}: lower max to ${count}${count === 0 ? ' (or remove the entry)' : ''}`,
        ...listUses(file, scan.uses),
      );
    }
  }
  for (const file of Object.keys(allowlist.files)) {
    if (!scans.has(file))
      violations.push(
        `${file}: remove stale entry (file is not in the scan set)`,
      );
  }
  for (const file of allowlist.pathHelpers) {
    if (!scans.has(file))
      violations.push(
        `${file}: remove stale pathHelpers entry (file is not in the scan set)`,
      );
  }
  return violations;
}

/** Validate and normalize the parsed allowlist JSON. Throws on malformed input. */
export function parseAllowlist(value: unknown): Allowlist {
  const root = value as { files?: unknown; pathHelpers?: unknown } | null;
  if (
    !root ||
    typeof root.files !== 'object' ||
    root.files === null ||
    !Array.isArray(root.pathHelpers)
  ) {
    throw new Error(
      `${ALLOWLIST_PATH}: expected { "files": {...}, "pathHelpers": [...] }`,
    );
  }
  for (const [file, entry] of Object.entries(
    root.files as Record<string, Partial<AllowlistEntry>>,
  )) {
    if (!Number.isInteger(entry?.max) || (entry.max as number) < 0) {
      throw new Error(
        `${ALLOWLIST_PATH}: "${file}" needs an integer "max" >= 0`,
      );
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(
        `${ALLOWLIST_PATH}: "${file}" needs a non-empty "reason"`,
      );
    }
  }
  if (!root.pathHelpers.every((file) => typeof file === 'string')) {
    throw new Error(`${ALLOWLIST_PATH}: "pathHelpers" must list file paths`);
  }
  return root as Allowlist;
}

function listSourceFiles(root: string): string[] {
  const srcDir = path.join(root, 'src');
  return (fs.readdirSync(srcDir, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join('/'))
    .filter(
      (entry) =>
        entry.endsWith('.ts') &&
        !entry.endsWith('.test.ts') &&
        !entry.split('/').includes('node_modules') &&
        entry !== 'lib/group-fs.ts',
    )
    .map((entry) => `src/${entry}`)
    .sort();
}

/** Scan every file of the scan set under `root`. */
export function scanRepo(
  root: string,
  allowlist: Allowlist,
): Map<string, FileScan> {
  const tracked = new Set([
    ...allowlist.pathHelpers,
    ...Object.keys(allowlist.files),
  ]);
  const scans = new Map<string, FileScan>();
  for (const file of listSourceFiles(root)) {
    scans.set(
      file,
      scanSource(
        fs.readFileSync(path.join(root, file), 'utf8'),
        tracked.has(file),
      ),
    );
  }
  return scans;
}

/** Full check of the repo at `root`; returns the violations (empty when clean). */
export function checkRepo(root: string): string[] {
  const allowlist = parseAllowlist(
    JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST_PATH), 'utf8')),
  );
  return evaluate(scanRepo(root, allowlist), allowlist);
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..');
  let violations: string[];
  try {
    violations = checkRepo(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(
      'Group fs guard failed. Board code touching groups/<folder>/ must use src/lib/group-fs.ts:',
    );
    for (const violation of violations)
      console.error(
        violation.startsWith('    ') ? violation : `  ${violation}`,
      );
    process.exit(1);
  }
  console.log('Group fs guard passed.');
}
