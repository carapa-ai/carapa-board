/* eslint-disable no-console */
/**
 * Native-title guard: a `title` attribute renders an OS-drawn tooltip after
 * about a second, unstyled and unavailable on touch. Use `Tooltip`
 * (`src/components/ui/tooltip.tsx`; its only-when-clipped option covers
 * truncated text) instead. Icon-only buttons get `aria-label` plus
 * `ToolbarIconButton` (`components/chat/workspace-toolbar.tsx`) or `Tooltip`.
 *
 * This is a ratchet, not a ban. Existing `title`s are counted per file in
 * `native-title-allowlist.json` (`{ "files": { "<path under src>": { "max": N } } }`;
 * files not listed have max 0). The guard fails (exit 1) only when a file has
 * more native titles than its max. Fewer is fine: it prints a "can lower"
 * note. `--write` rewrites the JSON with the current counts, lowering only
 * (never raising) and dropping entries that reach 0.
 *
 * Run from `ui/`:  node scripts/check-native-title.mjs [--write]
 * (the check is part of `npm run typecheck`).
 *
 * What is counted, per non-test `.tsx` under `src` (parsed with `typescript`):
 *   - `title` on intrinsic tags (`span`, `button`, `td`, `motion.div`, ...)
 *     except `iframe`, whose `title` is an accessible name, not a tooltip;
 *   - `title` on the components in FORWARDING_COMPONENTS and on any component
 *     not classified in either set below (fail closed: classify it).
 *
 * Edge cases:
 *   - `title=""`, `title={''}`, `title={undefined}`, `title={null}` and
 *     `title={false}` render no tooltip and are not counted.
 *   - `{...props}` spreads cannot be resolved statically: out of scope. The
 *     forwarding component that receives the prop is where a title is caught.
 *   - Only `.tsx` is scanned (the source has no `.jsx`); `.ts` holds no JSX.
 *   - An allowlist entry whose file was deleted or renamed is reported as
 *     stale (not a crash); `--write` drops it.
 *   - A missing or malformed allowlist fails closed with a message and no
 *     changes; restore it from git.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(import.meta.dirname, '../src');
const ALLOWLIST = path.resolve(
  import.meta.dirname,
  'native-title-allowlist.json',
);
const ALLOWLIST_REL = 'ui/scripts/native-title-allowlist.json';

/**
 * Shared components that spread their props onto a DOM element, so `title`
 * becomes a native tooltip. Each is `React.ComponentProps<...>` of a DOM tag
 * or a Radix primitive with `...props` forwarded:
 *   Button -> button/Slot, Badge -> span/Slot (components/ui/button.tsx, badge.tsx),
 *   DropdownMenuItem, DialogClose -> Radix Item/Close (dropdown-menu.tsx, dialog.tsx),
 *   FieldTrigger -> button, Select -> its trigger button (select.tsx),
 *   ListeningLanguagePicker -> its <label title={title}>, the prop's only use
 *   (components/chat/listening-language-picker.tsx),
 *   MediaPreview -> LoadedMediaPreview -> <video title={title}>
 *   (components/chat/preview-pane.tsx).
 */
const FORWARDING_COMPONENTS = new Set([
  'Button',
  'Badge',
  'DropdownMenuItem',
  'DialogClose',
  'FieldTrigger',
  'Select',
  'ListeningLanguagePicker',
  'MediaPreview',
  'LoadedMediaPreview',
]);

/**
 * Components whose own `title` prop is content (a heading, dialog title or
 * file name), not a DOM attribute. Each was checked in its props type: the
 * prop is destructured and rendered as text (or used as `download` or an
 * iframe's accessible name), never set as the `title` of another element.
 */
const CONTENT_PROP_COMPONENTS = new Set([
  'PageHeader',
  'QueryErrorState',
  'SettingsSection',
  'KanbanColumn',
  'BuildLogDialog',
  'DeleteConversationDialog',
  // components/chat/preview-pane.tsx: `title` is the file name shown in the pane.
  'AuthenticatedDownloadLink',
  'BinaryDownloadPreview',
  'BoundedTextPreview',
  'HtmlPreview',
  'HtmlPreviewWithSource',
  'JsonDocumentPreview',
  'JsonLinesChunkedPreview',
  'JsonLinesPreview',
  'MarkdownTextPreview',
  'PdfPreview',
  'TextPreview',
  'TextPreviewChunked',
]);

const EXEMPT_TAGS = new Set(['iframe']);

const FIX =
  'use <Tooltip> (components/ui/tooltip.tsx; only-when-clipped for truncated text), or aria-label plus ToolbarIconButton/Tooltip for icon buttons';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(entry.name) && !/\.(vitest|test)\./.test(entry.name))
      out.push(full);
  }
  return out.sort();
}

/** True when the attribute value renders no tooltip (empty or nullish). */
function isEmptyTitle(initializer) {
  if (!initializer) return false;
  if (ts.isStringLiteral(initializer)) return initializer.text === '';
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return false;
  const e = initializer.expression;
  return (
    (ts.isStringLiteralLike(e) && e.text === '') ||
    (ts.isIdentifier(e) && e.text === 'undefined') ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword
  );
}

/** `[{ line, tag }]` for every counted native title in the source. */
function nativeTitles(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const hits = [];
  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'title' &&
      ts.isJsxAttributes(node.parent) &&
      !isEmptyTitle(node.initializer)
    ) {
      const tag = node.parent.parent.tagName.getText(source);
      if (!EXEMPT_TAGS.has(tag) && !CONTENT_PROP_COMPONENTS.has(tag)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        hits.push({ line: line + 1, tag });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** Validated `{ rel: max }` from the allowlist, or exits 1 with a clear message. */
function loadAllowlist() {
  const fail = (why) => {
    console.error(
      `Native-title guard cannot read ${ALLOWLIST_REL}: ${why}. Restore it from git (git checkout -- ${ALLOWLIST_REL}).`,
    );
    process.exit(1);
  };
  let data;
  try {
    data = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const files = data?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return fail('expected { "files": { "<path>": { "max": N } } }');
  }
  const maxes = new Map();
  for (const [rel, entry] of Object.entries(files)) {
    if (!Number.isInteger(entry?.max) || entry.max < 0) {
      return fail(`"${rel}" needs an integer "max" >= 0`);
    }
    maxes.set(rel, entry.max);
  }
  return maxes;
}

const write = process.argv.includes('--write');
const maxes = loadAllowlist();

const counts = new Map();
const hitsByFile = new Map();
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const hits = nativeTitles(file, readFileSync(file, 'utf8'));
  if (hits.length) {
    counts.set(rel, hits.length);
    hitsByFile.set(rel, hits);
  }
}

const failures = [];
for (const [rel, count] of counts) {
  const max = maxes.get(rel) ?? 0;
  if (count <= max) continue;
  failures.push(
    `${rel}: ${count} native title${count === 1 ? '' : 's'}, allowed ${max}`,
    ...hitsByFile.get(rel).map((h) => `  ${rel}:${h.line} <${h.tag}>`),
  );
}

const lowered = {};
for (const [rel, max] of [...maxes].sort(([a], [b]) => a.localeCompare(b))) {
  const count = counts.get(rel) ?? 0;
  if (count < max) {
    const why = counts.has(rel)
      ? `${count} left`
      : 'no native titles left or file gone (stale entry)';
    console.log(`can lower: ${rel} max ${max} -> ${count} (${why})`);
  }
  if (count > 0) lowered[rel] = { max: Math.min(max, count) };
}

if (write) {
  writeFileSync(ALLOWLIST, `${JSON.stringify({ files: lowered }, null, 2)}\n`);
}

if (failures.length) {
  console.error('Native-title guard failed: native `title` tooltips went up.');
  for (const failure of failures) console.error(failure);
  console.error(`Fix: ${FIX}.`);
  console.error(
    'If a component `title` is content, not a DOM attribute, add it to CONTENT_PROP_COMPONENTS in ui/scripts/check-native-title.mjs.',
  );
  process.exit(1);
}
console.log('Native-title guard passed.');
