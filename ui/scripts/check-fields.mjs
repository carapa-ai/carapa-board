/* eslint-disable no-console */
/**
 * Field guard: every form field is built from the shared components in
 * `src/components/ui/` (`Input`, `Textarea`, `SearchInput`, `Select`,
 * `FieldTrigger`) and `Checkbox`, which carry the one quiet field look.
 *
 * Fails on, outside `src/components/ui/` and test files:
 *   - a native `<select>`;
 *   - a raw `<input>` / `<textarea>` that is not an exempt control type
 *     (range, file, color, hidden) or in ALLOWED_RAW below; a raw checkbox or
 *     radio input is never exempt: use Checkbox, or allowlist it in
 *     ALLOWED_RAW with a reason;
 *   - the removed `--input` colour token (`border-input` and friends);
 *   - a shared field component restyled at the call site (border, background,
 *     ring, shadow, rounding, text size or a fixed height in `className`).
 *
 * Run from `ui/`:  node scripts/check-fields.mjs   (part of `npm run typecheck`)
 * Pure text scan; comments are blanked before matching.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../src');

/**
 * Raw fields that deliberately keep their own style. Each entry is a ratchet:
 * `max` is the number of raw `<input>`/`<textarea>` tags allowed in the file.
 */
const ALLOWED_RAW = {
  'components/chat/preview-pane.tsx': {
    max: 1,
    reason: 'full-pane code editor (borderless, mono)',
  },
  'components/chat/bash-tab.tsx': {
    max: 1,
    reason: 'inline cell editor inside a terminal row',
  },
  'components/layout/header.tsx': {
    max: 2,
    reason: 'number stepper between -/+ buttons (parallel runs)',
  },
  'routes/share.$token.tsx': {
    max: 1,
    reason: 'public visitor composer (same exception as the chat composer)',
  },
};

/** Raw input types that keep their own control style. */
const EXEMPT_INPUT_TYPES = new Set(['range', 'file', 'color', 'hidden']);

/** Files that legitimately contain a restyled field tag (composer, heading fields). */
const ALLOWED_RESTYLE = {
  'components/board/task-detail-dialog.tsx': {
    max: 1,
    reason: 'inline task-title heading field (larger semibold text)',
  },
  'components/chat/chat-page.tsx': {
    max: 1,
    reason: 'chat composer card textarea (rule 12 exception)',
  },
};

const FIELD_COMPONENTS = [
  'Input',
  'Textarea',
  'SearchInput',
  'Select',
  'FieldTrigger',
];

// Tokens that restyle a field. Variant-prefixed tokens (`max-md:h-11`,
// `sm:w-56`) are layout and stay allowed unless they restyle colour/border.
const RESTYLE =
  /^(?:[\w[\]&>*:-]+:)?(?:border(?:-\S+)?|bg-\S+|ring(?:-\S+)?|shadow(?:-\S+)?|rounded(?:-\S+)?|outline(?:-\S+)?)$/;
const RESTYLE_UNPREFIXED =
  /^(?:text-(?:xs|sm|base|lg|xl|\[\S+\])|h-(?:\d\S*|\[\S+\]))$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(entry.name) && !/\.(vitest|test)\./.test(entry.name))
      out.push(full);
  }
  return out;
}

/** Blank comments and keep offsets so line numbers stay correct. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:\\])\/\/[^\n]*/g,
      (m, p) => p + ' '.repeat(m.length - p.length),
    );
}

/** Index of the `>` closing the JSX opening tag that starts at `from`. */
function tagEnd(source, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (depth > 0 && (c === '"' || c === "'" || c === '`')) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return source.length - 1;
}

function attrValue(tag, name) {
  const at = tag.search(new RegExp(`\\s${name}=`));
  if (at < 0) return null;
  const start = at + name.length + 2;
  if (tag[start] === '"' || tag[start] === "'") {
    return tag.slice(start + 1, tag.indexOf(tag[start], start + 1));
  }
  if (tag[start] === '{') {
    let depth = 0;
    for (let i = start; i < tag.length; i++) {
      if (tag[i] === '{') depth++;
      else if (tag[i] === '}' && --depth === 0) return tag.slice(start + 1, i);
    }
  }
  return null;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const failures = [];
const rawCounts = new Map();
const restyleCounts = new Map();

for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  if (rel.startsWith('components/ui/')) continue;
  const source = stripComments(readFileSync(file, 'utf8'));

  for (const m of source.matchAll(
    /\b(?:border|bg|ring|outline|text|divide|fill|stroke|shadow)(?:-[a-z]+)?-input\b/g,
  )) {
    failures.push(
      `${rel}:${lineOf(source, m.index)} \`${m[0]}\`: the --input colour token is gone; controls use border-border on bg-field`,
    );
  }

  for (const m of source.matchAll(/<select[\s>]/g)) {
    failures.push(
      `${rel}:${lineOf(source, m.index)} native <select>: use Select/SelectItem from components/ui/select`,
    );
  }

  for (const m of source.matchAll(/<(input|textarea)\b/g)) {
    const tag = source.slice(m.index, tagEnd(source, m.index) + 1);
    const type = attrValue(tag, 'type');
    if (
      m[1] === 'input' &&
      type &&
      EXEMPT_INPUT_TYPES.has(type.replace(/["'`{}\s]/g, ''))
    )
      continue;
    rawCounts.set(rel, [
      ...(rawCounts.get(rel) ?? []),
      lineOf(source, m.index),
    ]);
  }

  for (const component of FIELD_COMPONENTS) {
    for (const m of source.matchAll(new RegExp(`<${component}\\b`, 'g'))) {
      const tag = source.slice(m.index, tagEnd(source, m.index) + 1);
      const cls = attrValue(tag, 'className');
      if (!cls) continue;
      const strings = [...cls.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(
        (s) => s[2],
      );
      const raw = strings.length ? strings : [cls];
      const bad = raw
        .flatMap((s) => s.split(/\s+/))
        .filter(
          (token) =>
            token && (RESTYLE.test(token) || RESTYLE_UNPREFIXED.test(token)),
        );
      if (bad.length) {
        restyleCounts.set(rel, [
          ...(restyleCounts.get(rel) ?? []),
          `${lineOf(source, m.index)} <${component}> ${bad.join(' ')}`,
        ]);
      }
    }
  }
}

for (const [rel, lines] of rawCounts) {
  const allowed = ALLOWED_RAW[rel];
  if (!allowed || lines.length > allowed.max) {
    failures.push(
      `${rel}: raw <input>/<textarea> at line ${lines.join(', ')}${allowed ? ` (allowed ${allowed.max}: ${allowed.reason})` : ''}: use Input/Textarea/SearchInput/Checkbox from components/ui, or allowlist it in ui/scripts/check-fields.mjs with a reason`,
    );
  }
}
for (const [rel, hits] of restyleCounts) {
  const allowed = ALLOWED_RESTYLE[rel];
  if (!allowed || hits.length > allowed.max) {
    for (const hit of hits) {
      failures.push(
        `${rel}:${hit}: restyled field; pass only layout classes (use compact for the small size)`,
      );
    }
  }
}
for (const [rel, allowed] of Object.entries(ALLOWED_RAW)) {
  if ((rawCounts.get(rel)?.length ?? 0) < allowed.max) {
    failures.push(
      `${rel}: allowlisted raw field count dropped below ${allowed.max}; lower or remove its entry in ui/scripts/check-fields.mjs`,
    );
  }
}

if (failures.length) {
  console.error(`Field guard failed (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('Field guard passed.');
